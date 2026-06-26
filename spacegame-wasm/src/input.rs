//! Keyboard + mouse input, captured into a shared [`InputState`] the game loop reads each frame. Touch
//! is a TODO (the mobile profile is wired; on-screen sticks are the next step).

use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

/// A snapshot of input this frame. `Copy` so the game loop can grab it without holding the borrow.
#[derive(Clone, Copy, Default)]
pub struct InputState {
    pub thrust: bool,
    pub left: bool,
    pub right: bool,
    pub fire: bool,
    pub mouse_x: f32,
    pub mouse_y: f32,
    /// One-shot key edges the loop consumes (weapon cycle, build menu, respawn).
    pub cycle_weapon: bool,
    pub respawn: bool,
}

/// Owns the DOM listeners and the shared state.
pub struct Input {
    state: Rc<RefCell<InputState>>,
}

impl Input {
    /// Read the current input, clearing one-shot edges.
    pub fn read(&self) -> InputState {
        let mut s = self.state.borrow_mut();
        let out = *s;
        s.cycle_weapon = false;
        s.respawn = false;
        out
    }

    /// Attach keyboard/mouse listeners to the window + canvas.
    pub fn attach(canvas: &web_sys::HtmlCanvasElement) -> Self {
        let state = Rc::new(RefCell::new(InputState::default()));
        let win = web_sys::window().expect("window");

        // Keydown / keyup.
        for (down, name) in [(true, "keydown"), (false, "keyup")] {
            let st = state.clone();
            let cb = Closure::<dyn FnMut(web_sys::KeyboardEvent)>::new(move |e: web_sys::KeyboardEvent| {
                let mut s = st.borrow_mut();
                match e.code().as_str() {
                    "KeyW" | "ArrowUp" => s.thrust = down,
                    "KeyA" | "ArrowLeft" => s.left = down,
                    "KeyD" | "ArrowRight" => s.right = down,
                    "Space" => {
                        s.fire = down;
                        e.prevent_default();
                    }
                    "KeyQ" | "Tab" => {
                        if down {
                            s.cycle_weapon = true;
                        }
                        e.prevent_default();
                    }
                    "KeyR" => {
                        if down {
                            s.respawn = true;
                        }
                    }
                    _ => {}
                }
            });
            win.add_event_listener_with_callback(name, cb.as_ref().unchecked_ref()).ok();
            cb.forget();
        }

        // Mouse move (aim) on the canvas.
        {
            let st = state.clone();
            let cb = Closure::<dyn FnMut(web_sys::MouseEvent)>::new(move |e: web_sys::MouseEvent| {
                let mut s = st.borrow_mut();
                s.mouse_x = e.client_x() as f32;
                s.mouse_y = e.client_y() as f32;
            });
            canvas.add_event_listener_with_callback("mousemove", cb.as_ref().unchecked_ref()).ok();
            cb.forget();
        }

        // Mouse down/up: hold to thrust, button fires.
        for (down, name) in [(true, "mousedown"), (false, "mouseup")] {
            let st = state.clone();
            let cb = Closure::<dyn FnMut(web_sys::MouseEvent)>::new(move |e: web_sys::MouseEvent| {
                let mut s = st.borrow_mut();
                if e.button() == 0 {
                    s.thrust = down;
                    s.fire = down;
                }
            });
            canvas.add_event_listener_with_callback(name, cb.as_ref().unchecked_ref()).ok();
            cb.forget();
        }

        Input { state }
    }
}
