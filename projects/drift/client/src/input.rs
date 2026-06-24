//! Input mapping: raw keyboard/pointer state -> a drift-sim [`Input`] frame.
//!
//! The platform layer (winit on wasm, or the JS glue) sets the boolean key
//! flags and pointer state on [`InputState`]; each tick the predictor calls
//! [`InputState::to_input`] to produce the deterministic per-tick command that
//! is both predicted locally and sent to the host. Keeping this pure (no winit
//! types) lets it be unit-tested and reused by a headless bot.

use drift_sim::world::Input;

/// Latched control state for the local player.
#[derive(Clone, Copy, Debug, Default)]
pub struct InputState {
    pub thrust_fwd: bool,
    pub thrust_rev: bool,
    pub turn_left: bool,
    pub turn_right: bool,
    pub fire: bool,
    pub mine: bool,
    /// Whether build-mode is engaged (consumes pointer clicks for placement
    /// instead of firing). Build actions are an app-layer concern routed
    /// separately; in build mode we suppress the fire command.
    pub build_mode: bool,
}

impl InputState {
    pub fn new() -> InputState {
        InputState::default()
    }

    /// Collapse the latched state into a single deterministic tick command for
    /// `controller`. Thrust/turn are bipolar in `[-1, 1]`; opposing keys cancel.
    pub fn to_input(&self, controller: u32) -> Input {
        let thrust = bipolar(self.thrust_fwd, self.thrust_rev);
        // Positive turn = counter-clockwise (matches world::apply_controls).
        let turn = bipolar(self.turn_left, self.turn_right);
        Input {
            controller,
            thrust,
            turn,
            fire: self.fire && !self.build_mode,
            mine: self.mine,
        }
    }

    /// Map a physical key name (as reported by `KeyboardEvent.code` / winit's
    /// `KeyCode` debug name) to a control flag, setting `pressed`. Returns true
    /// if the key was a recognized binding (so the platform can preventDefault).
    pub fn set_key(&mut self, code: &str, pressed: bool) -> bool {
        match code {
            "KeyW" | "ArrowUp" => self.thrust_fwd = pressed,
            "KeyS" | "ArrowDown" => self.thrust_rev = pressed,
            "KeyA" | "ArrowLeft" => self.turn_left = pressed,
            "KeyD" | "ArrowRight" => self.turn_right = pressed,
            "Space" => self.fire = pressed,
            "KeyE" => self.mine = pressed,
            "KeyB" => {
                if pressed {
                    self.build_mode = !self.build_mode;
                }
            }
            _ => return false,
        }
        true
    }
}

#[inline]
fn bipolar(pos: bool, neg: bool) -> f32 {
    match (pos, neg) {
        (true, false) => 1.0,
        (false, true) => -1.0,
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opposing_keys_cancel() {
        let mut s = InputState::new();
        s.set_key("KeyW", true);
        s.set_key("KeyS", true);
        assert_eq!(s.to_input(0).thrust, 0.0);
    }

    #[test]
    fn build_mode_suppresses_fire_and_toggles() {
        let mut s = InputState::new();
        s.set_key("Space", true);
        assert!(s.to_input(0).fire);
        s.set_key("KeyB", true); // engage build mode
        assert!(s.build_mode);
        assert!(!s.to_input(0).fire, "build mode must suppress fire");
        s.set_key("KeyB", true); // toggle back off
        assert!(!s.build_mode);
    }

    #[test]
    fn turn_left_is_positive() {
        let mut s = InputState::new();
        s.set_key("KeyA", true);
        assert_eq!(s.to_input(0).turn, 1.0);
    }

    #[test]
    fn unknown_key_is_ignored() {
        let mut s = InputState::new();
        assert!(!s.set_key("KeyZ", true));
    }
}
