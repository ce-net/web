//! CE Spacegame — browser frontend, **Rust → WASM + wgpu**, embedding the pure `spacegame` SDK.
//!
//! It talks to the game's authoritative sector backends ONLY over the CE mesh, through this page's own
//! origin (the `/ce` proxy in front of a node, or a browser-injected node). It uses the SDK for the
//! wire types, sector maths, client profiles and (next) local prediction with the deterministic `Sim`;
//! it renders with wgpu. See `FRONTEND.md` in the spacegame repo for the full architecture.

mod game;
mod input;
mod net;
mod render;

use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::spawn_local;

use game::Game;
use input::Input;
use net::Net;
use render::Renderer;
use spacegame::client::Platform;
use spacegame::wire::{topics, ClientMsg};

fn window() -> web_sys::Window {
    web_sys::window().expect("window")
}
fn document() -> web_sys::Document {
    window().document().expect("document")
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Info);
    spawn_local(async {
        if let Err(e) = run().await {
            log::error!("fatal: {e:?}");
            set_boot(&format!("error: {e:?}"));
        }
    });
}

fn set_boot(msg: &str) {
    if let Some(el) = document().get_element_by_id("bootmsg") {
        el.set_text_content(Some(msg));
    }
}
fn hide_boot() {
    if let Some(el) = document().get_element_by_id("boot") {
        if let Some(h) = el.dyn_ref::<web_sys::HtmlElement>() {
            let _ = h.style().set_property("display", "none");
        }
    }
}

fn detect_platform() -> Platform {
    let w = window().inner_width().ok().and_then(|v| v.as_f64()).unwrap_or(1280.0);
    let touch = window().navigator().max_touch_points() > 0;
    if touch || w < 820.0 {
        Platform::MobileBrowser
    } else {
        Platform::DesktopBrowser
    }
}

fn canvas() -> web_sys::HtmlCanvasElement {
    document().get_element_by_id("cv").expect("#cv").dyn_into().expect("canvas")
}

fn size_canvas(c: &web_sys::HtmlCanvasElement) -> (u32, u32) {
    let dpr = window().device_pixel_ratio().clamp(1.0, 2.0);
    let w = (window().inner_width().unwrap().as_f64().unwrap() * dpr) as u32;
    let h = (window().inner_height().unwrap().as_f64().unwrap() * dpr) as u32;
    c.set_width(w);
    c.set_height(h);
    (w, h)
}

async fn run() -> Result<(), JsValue> {
    let cv = canvas();
    let (w, h) = size_canvas(&cv);

    set_boot("initialising wgpu…");
    let renderer = Renderer::new(cv.clone(), w, h).await.map_err(|e| JsValue::from_str(&e))?;

    set_boot("connecting to the mesh…");
    let netc = Net::new(&net::detect_base());
    let me = netc.node_id().await.unwrap_or_else(|_| "local".to_string());
    log::info!("player id {}", &me[..me.len().min(12)]);

    let profile = detect_platform().profile();
    let game = Rc::new(RefCell::new(Game::new(me.clone(), profile)));
    let input = Input::attach(&cv);

    // Inbound SSE stream → game inbox, reconnecting with backoff.
    {
        let n = netc.clone();
        spawn_local(async move {
            let mut attempt = 0u32;
            loop {
                let _ = n.run_inbox().await;
                let ms = spacegame::client::reconnect_backoff_ms(attempt);
                attempt = attempt.saturating_add(1);
                gloo_sleep(ms).await;
            }
        });
    }

    // Join the origin sector with a handle derived from our id.
    let name = format!("pilot-{}", &me[..me.len().min(4)]);
    {
        let n = netc.clone();
        let in0 = topics::input("0_0");
        let hex = net::encode_hex(&ClientMsg::Join { name });
        spawn_local(async move {
            let _ = n.subscribe(&topics::state("0_0")).await;
            let _ = n.publish_hex(&in0, &hex).await;
        });
    }

    hide_boot();

    // ---- the requestAnimationFrame loop ----
    let f: Rc<RefCell<Option<Closure<dyn FnMut()>>>> = Rc::new(RefCell::new(None));
    let g = f.clone();
    let renderer = Rc::new(RefCell::new(renderer));
    let mut frame: u64 = 0;
    let mut last_w = w;
    let mut last_h = h;

    *g.borrow_mut() = Some(Closure::wrap(Box::new(move || {
        frame += 1;

        // Resize if the window changed.
        let (cw, ch) = (cv.width(), cv.height());
        let (nw, nh) = size_canvas(&cv);
        if nw != last_w || nh != last_h {
            renderer.borrow_mut().resize(nw, nh);
            last_w = nw;
            last_h = nh;
        }
        let _ = (cw, ch);

        // Drain inbound snapshots.
        {
            let mut gm = game.borrow_mut();
            let mut inbox = netc.inbox.borrow_mut();
            while let Some(m) = inbox.pop_front() {
                gm.ingest(m.topic, m.snapshot);
            }
            gm.tick_camera();
        }

        // Subscribe to any newly-relevant sectors (interest management).
        let fresh = game.borrow_mut().new_subscriptions();
        for t in fresh {
            let n = netc.clone();
            spawn_local(async move { let _ = n.subscribe(&t).await; });
        }

        // Publish input at ~20 Hz (every 3rd frame at 60 fps).
        if frame % 3 == 0 {
            let inp = input.read();
            let (topic, msg) = {
                let gm = game.borrow();
                let ppw = nh as f32 / (gm.profile.view_radius * 2.0);
                gm.build_input(&inp, nw as f32, nh as f32, ppw)
            };
            // One-shot edges: weapon cycle / respawn.
            let extra: Option<ClientMsg> = if inp.respawn {
                Some(ClientMsg::Respawn)
            } else {
                None
            };
            let n = netc.clone();
            let hex = net::encode_hex(&msg);
            spawn_local(async move {
                let _ = n.publish_hex(&topic, &hex).await;
                if let Some(m) = extra {
                    let _ = n.publish_hex(&topic, &net::encode_hex(&m)).await;
                }
            });
        }

        // Render.
        renderer.borrow_mut().frame(&game.borrow());

        request_animation_frame(f.borrow().as_ref().unwrap());
    }) as Box<dyn FnMut()>));

    request_animation_frame(g.borrow().as_ref().unwrap());
    Ok(())
}

fn request_animation_frame(cb: &Closure<dyn FnMut()>) {
    window()
        .request_animation_frame(cb.as_ref().unchecked_ref())
        .expect("rAF");
}

/// A tiny promise-based sleep (no extra crate): resolves a setTimeout via a JS Promise.
async fn gloo_sleep(ms: u64) {
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let cb = Closure::once_into_js(move || {
            let _ = resolve.call0(&JsValue::NULL);
        });
        let _ = window().set_timeout_with_callback_and_timeout_and_arguments_0(
            cb.as_ref().unchecked_ref(),
            ms as i32,
        );
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}
