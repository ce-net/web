//! Client-side prediction and reconciliation against the authoritative host.
//!
//! This is the load-bearing networking core. It owns a local copy of the
//! deterministic [`World`] and advances it every tick by calling the *exact*
//! same `World::step` the authoritative host runs. Because the simulation is
//! deterministic (see drift-sim docs), prediction is exact whenever the input
//! streams agree, so the local ship responds with zero perceived latency.
//!
//! Reconciliation, on receipt of an authoritative frame for tick `T`:
//! 1. Restore the local world to the authoritative state at `T`.
//! 2. Re-apply every locally-buffered input with tick `> T` (the inputs the
//!    host has not yet acknowledged), stepping the world forward to "now".
//! This snaps the prediction back onto the authoritative track without ever
//! showing the player a rubber-band, except when the host genuinely disagrees.
//!
//! Authoritative state arrives in one of two `drift-sim` wire forms:
//! - a full [`Snapshot`] (restore-able world state), or
//! - a [`Delta`] of quantized entity updates against a base tick (for AoI /
//!   bandwidth-light streaming) which we fold into a render-side entity table.
//!
//! Remote entities are not predicted; they are interpolated ~100ms in the past
//! by [`crate::interp`] from the decoded authoritative samples.

use drift_sim::net::{Delta, Snapshot};
use drift_sim::world::{Input, World, DT};

/// One locally-issued input plus the tick it was applied on. Buffered so that
/// reconciliation can replay unacknowledged inputs after a host correction.
#[derive(Clone, Copy, Debug)]
pub struct PendingInput {
    pub tick: u64,
    pub input: Input,
}

/// What the client decoded from one authoritative network message.
pub enum AuthFrame {
    /// A full, restorable world snapshot at `snapshot.tick`.
    Full(Snapshot),
    /// A quantized delta against `delta.base_tick`.
    Delta(Delta),
}

impl AuthFrame {
    /// Decode an authoritative binary frame. The host tags the first byte:
    /// `0x00` = full snapshot, `0x01` = delta. Anything else (or a bincode
    /// failure) yields `None` so the caller can ignore a malformed frame
    /// without crashing — networking must never panic the render loop.
    pub fn decode(bytes: &[u8]) -> Option<AuthFrame> {
        let (&tag, body) = bytes.split_first()?;
        match tag {
            0x00 => Snapshot::from_bytes(body).ok().map(AuthFrame::Full),
            0x01 => Delta::from_bytes(body).ok().map(AuthFrame::Delta),
            _ => None,
        }
    }

    /// The tick this frame describes.
    pub fn tick(&self) -> u64 {
        match self {
            AuthFrame::Full(s) => s.tick,
            AuthFrame::Delta(d) => d.tick,
        }
    }
}

/// The predicted local simulation plus its input history.
pub struct Predictor {
    /// The locally-advanced world (predicted "now").
    world: World,
    /// The controller id this client drives (its own ship).
    controller: u32,
    /// Inputs issued locally but not yet confirmed by an authoritative frame.
    pending: Vec<PendingInput>,
    /// The highest authoritative tick we have reconciled against.
    last_auth_tick: u64,
    /// Count of reconciliations that actually moved the local ship (a health
    /// metric surfaced on the HUD: high values mean prediction is fighting the
    /// host, usually a sign of packet loss or a desync).
    pub corrections: u64,
}

impl Predictor {
    /// Create a predictor seeded to match the host's initial world parameters.
    /// `seed`/`arena_half` must match the host so that any locally-spawned
    /// determinism (e.g. asteroid scatter) lines up before the first
    /// authoritative frame arrives.
    pub fn new(seed: u64, arena_half: f32, controller: u32) -> Predictor {
        Predictor {
            world: World::new(seed, arena_half),
            controller,
            pending: Vec::new(),
            last_auth_tick: 0,
            corrections: 0,
        }
    }

    /// The controller id (player slot) this client owns.
    pub fn controller(&self) -> u32 {
        self.controller
    }

    /// Read-only view of the predicted world for the renderer.
    pub fn world(&self) -> &World {
        &self.world
    }

    /// The predicted local tick.
    pub fn tick(&self) -> u64 {
        self.world.tick
    }

    /// Advance the prediction one fixed step with the local player's input for
    /// this tick. The input is buffered for later reconciliation. Returns the
    /// new predicted tick. The same `Input` is what the client should also send
    /// to the host (tagged with this tick) so the streams stay aligned.
    pub fn predict_step(&mut self, mut local: Input) -> u64 {
        local.controller = self.controller;
        // Record against the tick this input is applied on (pre-increment).
        self.pending.push(PendingInput {
            tick: self.world.tick,
            input: local,
        });
        self.world.step(&[local], DT);
        self.world.tick
    }

    /// Fold an authoritative frame into the prediction.
    ///
    /// For a full snapshot we restore and then replay unacknowledged inputs,
    /// which is the true reconciliation path. A delta alone is not restorable
    /// (it is quantized/AoI), so the predictor leaves its local world untouched
    /// and the caller routes deltas to the render-side entity table instead;
    /// we still advance `last_auth_tick` so input pruning stays correct.
    pub fn ingest_auth(&mut self, frame: &AuthFrame) {
        match frame {
            AuthFrame::Full(snap) => self.reconcile_full(snap),
            AuthFrame::Delta(d) => {
                if d.tick > self.last_auth_tick {
                    self.last_auth_tick = d.tick;
                }
                self.prune_pending();
            }
        }
    }

    /// Authoritative full-state reconciliation.
    fn reconcile_full(&mut self, snap: &Snapshot) {
        // Ignore stale/out-of-order snapshots.
        if snap.tick < self.last_auth_tick {
            return;
        }

        // Capture where the local ship was before the correction so we can tell
        // whether the host actually disagreed (for the corrections metric).
        let before = self.local_ship_pos();

        // 1) Snap to the authoritative state at snap.tick.
        self.world = snap.restore();
        self.last_auth_tick = snap.tick;

        // 2) Replay every locally-issued input the host had not yet folded in
        //    (tick strictly greater than the authoritative tick), in order.
        self.prune_pending();
        // Clone out to avoid borrowing self across the step calls.
        let replay: Vec<PendingInput> = self.pending.clone();
        for p in &replay {
            self.world.step(&[p.input], DT);
        }

        let after = self.local_ship_pos();
        if let (Some(a), Some(b)) = (before, after) {
            // A meaningful snap (> ~0.25 world units) counts as a correction.
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            if dx * dx + dy * dy > 0.0625 {
                self.corrections += 1;
            }
        }
    }

    /// Drop buffered inputs the host has now confirmed (tick <= last auth tick).
    fn prune_pending(&mut self) {
        let cutoff = self.last_auth_tick;
        self.pending.retain(|p| p.tick > cutoff);
    }

    /// Position of this client's own ship in the predicted world, if alive.
    fn local_ship_pos(&self) -> Option<drift_sim::math::Vec2> {
        use drift_sim::entity::Kind;
        self.world
            .entities
            .iter()
            .find(|e| matches!(&e.kind, Kind::Ship(s) if s.controller == self.controller))
            .map(|e| e.pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use drift_sim::math::Vec2;

    fn host_world() -> World {
        let mut w = World::new(7, 200.0);
        w.spawn_ship(0, Vec2::new(0.0, 0.0), 0.0);
        w
    }

    #[test]
    fn full_frame_round_trips_through_decode() {
        let w = host_world();
        let snap = Snapshot::full(&w);
        let mut bytes = vec![0x00u8];
        bytes.extend_from_slice(&snap.to_bytes().unwrap());
        let frame = AuthFrame::decode(&bytes).expect("decode full");
        assert_eq!(frame.tick(), w.tick);
        assert!(matches!(frame, AuthFrame::Full(_)));
    }

    #[test]
    fn garbage_frame_decodes_to_none_not_panic() {
        assert!(AuthFrame::decode(&[]).is_none());
        assert!(AuthFrame::decode(&[0x09, 1, 2, 3]).is_none());
        assert!(AuthFrame::decode(&[0x00, 0xff]).is_none());
    }

    #[test]
    fn prediction_then_matching_auth_does_not_correct() {
        // Host and client share the same seed and the same input stream, so the
        // authoritative snapshot must agree with prediction -> zero corrections.
        let mut host = host_world();
        let mut pred = Predictor::new(7, 200.0, 0);
        pred.world = host_world(); // align starting entities (host spawned the ship)

        let inp = Input { controller: 0, thrust: 1.0, turn: 0.3, fire: false, mine: false };
        for _ in 0..30 {
            pred.predict_step(inp);
            host.step(&[inp], DT);
        }
        let snap = Snapshot::full(&host);
        let frame = AuthFrame::Full(snap);
        pred.ingest_auth(&frame);
        assert_eq!(pred.corrections, 0, "matched streams must not rubber-band");
        assert_eq!(pred.tick(), host.tick);
    }

    #[test]
    fn divergent_auth_triggers_a_correction_and_resync() {
        let mut pred = Predictor::new(7, 200.0, 0);
        pred.world = host_world();
        let inp = Input { controller: 0, thrust: 1.0, turn: 0.0, fire: false, mine: false };
        for _ in 0..20 {
            pred.predict_step(inp);
        }
        // Build a host that diverged (different thrust history).
        let mut host = host_world();
        let other = Input { controller: 0, thrust: -1.0, turn: 1.0, fire: false, mine: false };
        for _ in 0..20 {
            host.step(&[other], DT);
        }
        pred.ingest_auth(&AuthFrame::Full(Snapshot::full(&host)));
        assert_eq!(pred.corrections, 1, "host disagreement should record one correction");
        // After reconciliation the predicted tick matches the host (no pending
        // inputs beyond the auth tick remained).
        assert_eq!(pred.tick(), host.tick);
    }
}
