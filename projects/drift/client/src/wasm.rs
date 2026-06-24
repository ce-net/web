//! wasm-bindgen surface for the browser runtime (drift.js).
//!
//! drift.js owns the netgame control plane and the canvas. It instantiates
//! [`Drift`], hands it the canvas element, then on every authoritative /rt
//! StateFrame calls [`Drift::on_auth_frame`], feeds key events into
//! [`Drift::set_key`], and on each animation frame calls [`Drift::frame`].
//! The fixed-rate prediction is advanced by [`Drift::tick`] at 60Hz (drift.js
//! drives the accumulator so prediction stays lock-stepped with the host DT).
//!
//! Surface/adapter creation uses winit purely to obtain a raw-window-handle for
//! the canvas; wgpu (built with the `webgl` feature) then requests a WebGPU
//! adapter when available and falls back to WebGL2 automatically.

use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

use crate::app::Game;
use crate::render::Renderer;

/// One-time module init: route panics + `log` to the browser console.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Info);
    log::info!("drift-client wasm loaded");
}

/// The exported game handle drift.js holds for the lifetime of a session.
#[wasm_bindgen]
pub struct Drift {
    game: Game,
    renderer: Option<Renderer>,
    /// The input the local controller should send to the host this tick. drift.js
    /// reads it after each `tick()` via [`Drift::take_outgoing_input`].
    last_input: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl Drift {
    /// Create the game aligned to the host's world parameters. The renderer is
    /// attached separately by [`Drift::attach_canvas`] (async).
    #[wasm_bindgen(constructor)]
    pub fn new(seed: f64, arena_half: f32, controller: u32) -> Drift {
        Drift {
            game: Game::new(seed as u64, arena_half, controller),
            renderer: None,
            last_input: None,
        }
    }

    /// Attach a canvas and build the wgpu renderer (WebGPU-first, WebGL2
    /// fallback). Awaitable from JS. Returns the chosen backend label.
    pub async fn attach_canvas(&mut self, canvas: HtmlCanvasElement) -> Result<JsValue, JsValue> {
        let width = canvas.width().max(1);
        let height = canvas.height().max(1);

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            // Let wgpu pick: BROWSER_WEBGPU when present, else GL (WebGL2).
            backends: wgpu::Backends::BROWSER_WEBGPU | wgpu::Backends::GL,
            ..Default::default()
        });

        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| JsValue::from_str(&format!("create_surface: {e}")))?;

        let renderer = Renderer::new(&instance, surface, width, height)
            .await
            .map_err(|e| JsValue::from_str(&e))?;

        let label = renderer.backend_label();
        self.game.set_viewport(width, height);
        self.renderer = Some(renderer);
        Ok(JsValue::from_str(label))
    }

    /// Feed an authoritative binary StateFrame (the host's tagged Snapshot/Delta).
    /// Returns true if it decoded. drift.js passes the raw bytes from the
    /// ephemeral /rt Message::Binary (or the base64 `st2` fallback, pre-decoded).
    pub fn on_auth_frame(&mut self, bytes: &[u8]) -> bool {
        self.game.on_auth_frame(bytes)
    }

    /// Set a key flag from a `KeyboardEvent.code`. Returns true if recognized
    /// (so JS can preventDefault). Call on both keydown (true) and keyup (false).
    pub fn set_key(&mut self, code: &str, pressed: bool) -> bool {
        self.game.input.set_key(code, pressed)
    }

    /// Mouse-wheel zoom (factor < 1 zooms in, > 1 zooms out).
    pub fn zoom_by(&mut self, factor: f32) {
        self.game.zoom_by(factor);
    }

    /// Resize the renderer + camera after a canvas resize.
    pub fn resize(&mut self, width: u32, height: u32) {
        if let Some(r) = self.renderer.as_mut() {
            r.resize(width, height);
        }
        self.game.set_viewport(width, height);
    }

    /// Advance local prediction one fixed 60Hz step. The applied input is
    /// serialized and stashed for [`Drift::take_outgoing_input`] so drift.js can
    /// forward it to the host. Call this once per accumulated DT.
    pub fn tick(&mut self) {
        let inp = self.game.fixed_tick();
        let frame = drift_sim::net::InputFrame {
            tick: self.game.hud().predicted_tick,
            inputs: vec![inp],
        };
        self.last_input = frame.to_bytes().ok();
    }

    /// Take the serialized [`drift_sim::net::InputFrame`] for the last `tick()`,
    /// or `None` if already taken. drift.js sends this to the host as `{t:"in"}`.
    pub fn take_outgoing_input(&mut self) -> Option<Vec<u8>> {
        self.last_input.take()
    }

    /// Smooth the camera and draw one frame. `dt` is the wall-clock seconds
    /// since the last `frame()` call (for camera smoothing only — the sim is
    /// advanced by `tick()`).
    pub fn frame(&mut self, dt: f32) -> Result<(), JsValue> {
        self.game.update_camera(dt);
        let (quads, lines, cam) = self.game.build_frame();
        if let Some(r) = self.renderer.as_mut() {
            r.set_camera(cam);
            r.render(&quads, &lines)
                .map_err(|e| JsValue::from_str(&e))?;
        }
        Ok(())
    }

    /// HUD/debug numbers as a JSON string for the DOM overlay.
    pub fn hud_json(&self) -> String {
        let h = self.game.hud();
        let backend = self
            .renderer
            .as_ref()
            .map(|r| r.backend_label())
            .unwrap_or("init");
        // Hand-rolled JSON (no serde_json dep): all fields are numbers/strings.
        format!(
            "{{\"backend\":\"{}\",\"predictedTick\":{},\"authTick\":{},\"leadTicks\":{},\"corrections\":{},\"remotes\":{},\"quads\":{}}}",
            backend,
            h.predicted_tick,
            h.auth_tick,
            h.lead_ticks,
            h.corrections,
            h.remote_count,
            h.quad_count,
        )
    }
}
