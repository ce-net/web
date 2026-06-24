//! The game application: the per-frame glue that ties prediction, interpolation,
//! the camera, input, and the renderer together.
//!
//! Lifecycle (driven by the platform layer):
//! 1. `Game::new` — seed the predictor and remote table to the host's world
//!    parameters (seed + arena size + this client's controller slot).
//! 2. `Game::on_auth_frame(bytes)` — feed an authoritative binary StateFrame
//!    (decoded by [`crate::predict::AuthFrame`]) every time one arrives over the
//!    ephemeral /rt room. Full frames reconcile prediction; deltas/full frames
//!    both feed the interpolated remote table.
//! 3. `Game::fixed_tick()` — advance local prediction one 60Hz step using the
//!    current input; returns the input the platform should send to the host.
//! 4. `Game::render(renderer, frame_dt)` — smooth the camera and draw.
//!
//! The renderer is owned by the platform layer (it needs the surface), so this
//! type stays renderer-agnostic and is unit-testable without a GPU.

use drift_sim::world::Input;

use crate::camera::Camera;
use crate::input::InputState;
use crate::interp::InterpWorld;
use crate::predict::{AuthFrame, Predictor};
use crate::scene::{self, LineVertex, QuadInstance};

/// Aggregate HUD/debug numbers surfaced to the DOM overlay each frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct HudStats {
    pub predicted_tick: u64,
    pub auth_tick: u64,
    pub corrections: u64,
    pub remote_count: usize,
    pub quad_count: usize,
    /// Ticks the prediction is ahead of the latest authoritative tick (latency
    /// proxy). Negative would mean we are behind the host.
    pub lead_ticks: i64,
}

/// The full client game state, renderer excluded.
pub struct Game {
    predictor: Predictor,
    remotes: InterpWorld,
    camera: Camera,
    pub input: InputState,
}

impl Game {
    /// Create the game aligned to the host's world parameters.
    pub fn new(seed: u64, arena_half: f32, controller: u32) -> Game {
        Game {
            predictor: Predictor::new(seed, arena_half, controller),
            remotes: InterpWorld::new(),
            camera: Camera::new(),
            input: InputState::new(),
        }
    }

    /// Update the camera aspect ratio after a canvas resize.
    pub fn set_viewport(&mut self, width: u32, height: u32) {
        self.camera.set_viewport(width, height);
    }

    /// Mouse-wheel zoom passthrough.
    pub fn zoom_by(&mut self, factor: f32) {
        self.camera.zoom_by(factor);
    }

    /// Feed one authoritative binary StateFrame. Returns true if it decoded.
    /// Full frames reconcile prediction AND seed the interp table; deltas only
    /// feed the interp table (they are not restorable into the predictor).
    pub fn on_auth_frame(&mut self, bytes: &[u8]) -> bool {
        let Some(frame) = AuthFrame::decode(bytes) else {
            return false;
        };
        let exclude = Some(self.predictor.controller());
        match &frame {
            AuthFrame::Full(snap) => {
                self.remotes.apply_snapshot(snap, local_ship_id(snap, exclude));
            }
            AuthFrame::Delta(delta) => {
                // Deltas carry no controller mapping, so we cannot exclude the
                // local ship by controller; the renderer prefers the predicted
                // ship and skips the duplicate by id at draw time.
                self.remotes.apply_delta(delta, None);
            }
        }
        self.predictor.ingest_auth(&frame);
        true
    }

    /// Advance local prediction one fixed step. Returns the [`Input`] that was
    /// applied (the platform should also send this to the host for this tick).
    pub fn fixed_tick(&mut self) -> Input {
        let inp = self.input.to_input(self.predictor.controller());
        self.predictor.predict_step(inp);
        inp
    }

    /// Smooth the camera toward the predicted local ship over `frame_dt`.
    pub fn update_camera(&mut self, frame_dt: f32) {
        use drift_sim::entity::Kind;
        let ctrl = self.predictor.controller();
        if let Some(e) = self
            .predictor
            .world()
            .entities
            .iter()
            .find(|e| matches!(&e.kind, Kind::Ship(s) if s.controller == ctrl))
        {
            self.camera.follow_target(e.pos, frame_dt);
        }
    }

    /// Build this frame's GPU data (instances, lines) and the camera matrix.
    pub fn build_frame(&self) -> (Vec<QuadInstance>, Vec<LineVertex>, [[f32; 4]; 4]) {
        let ctrl = self.predictor.controller();
        let quads = scene::build_quads(self.predictor.world(), &self.remotes, ctrl);
        let lines = scene::build_lines(self.predictor.world(), &self.camera, ctrl);
        let cam = self.camera.world_to_clip();
        (quads, lines, cam)
    }

    /// Snapshot the HUD/debug numbers for the DOM overlay.
    pub fn hud(&self) -> HudStats {
        let predicted = self.predictor.tick();
        let auth = self.remotes.latest_tick;
        HudStats {
            predicted_tick: predicted,
            auth_tick: auth,
            corrections: self.predictor.corrections,
            remote_count: self.remotes.len(),
            quad_count: scene::build_quads(self.predictor.world(), &self.remotes, self.predictor.controller()).len(),
            lead_ticks: predicted as i64 - auth as i64,
        }
    }

    /// Read-only camera access (e.g. to map pointer -> world for build UI).
    pub fn camera(&self) -> &Camera {
        &self.camera
    }
}

/// Find the entity id of the local controller's ship in a full snapshot so the
/// interp table can exclude it (the predictor renders it instead).
fn local_ship_id(
    snap: &drift_sim::net::Snapshot,
    exclude_controller: Option<u32>,
) -> Option<drift_sim::entity::EntityId> {
    use drift_sim::entity::Kind;
    let ctrl = exclude_controller?;
    snap.entities
        .iter()
        .find(|e| matches!(&e.kind, Kind::Ship(s) if s.controller == ctrl))
        .map(|e| e.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use drift_sim::math::Vec2;
    use drift_sim::net::Snapshot;
    use drift_sim::world::{World, DT};

    fn host() -> World {
        let mut w = World::new(11, 200.0);
        w.spawn_ship(0, Vec2::new(0.0, 0.0), 0.0);
        w.spawn_ship(1, Vec2::new(20.0, 0.0), 3.14);
        w.scatter_asteroids(5);
        w
    }

    #[test]
    fn auth_frame_excludes_local_ship_from_remotes() {
        let mut g = Game::new(11, 200.0, 0);
        // Align the predicted world to the host so reconciliation has the ship.
        let h = host();
        let snap = Snapshot::full(&h);
        let mut bytes = vec![0x00u8];
        bytes.extend_from_slice(&snap.to_bytes().unwrap());
        assert!(g.on_auth_frame(&bytes));
        // Remotes hold ship#1 + 5 asteroids = 6, NOT the local ship#0.
        assert_eq!(g.remotes.len(), 6);
    }

    #[test]
    fn fixed_tick_returns_local_controllers_input() {
        let mut g = Game::new(1, 100.0, 2);
        g.input.set_key("KeyW", true);
        let inp = g.fixed_tick();
        assert_eq!(inp.controller, 2);
        assert_eq!(inp.thrust, 1.0);
    }

    #[test]
    fn hud_lead_tracks_prediction_vs_auth() {
        let mut g = Game::new(11, 200.0, 0);
        // Establish auth at the host tick.
        let h = host();
        let mut bytes = vec![0x00u8];
        bytes.extend_from_slice(&Snapshot::full(&h).to_bytes().unwrap());
        g.on_auth_frame(&bytes);
        // Predict a few ticks ahead.
        for _ in 0..5 {
            g.fixed_tick();
        }
        let hud = g.hud();
        // Auth set the predicted tick to h.tick; 5 predicted steps -> lead 5.
        assert_eq!(hud.lead_ticks, 5);
        let _ = DT;
    }
}
