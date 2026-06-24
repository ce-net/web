//! drift-sim — the deterministic shared 2D ship-arena simulation.
//!
//! This crate is the SINGLE SOURCE OF TRUTH for the "drift" program. The exact
//! same code path runs in two places:
//!
//! 1. The authoritative host advances the world and broadcasts snapshots/deltas.
//! 2. Each client predicts locally by stepping its own copy of this world with
//!    the same inputs, then reconciles against the host's authoritative state.
//!
//! Because both sides run identical, deterministic logic, prediction is exact
//! whenever the input streams agree. Determinism is enforced by:
//!
//! - `f32` math in a fixed, carefully ordered traversal (entities live in a
//!   `Vec`, never a map).
//! - No `HashMap` iteration in any simulation path; sparse lookups use sorted
//!   helpers (see `spatial` and `net`).
//! - No wall-clock and no thread-local RNG. The only randomness is the seeded
//!   `Rng` stored inside `World` (`math::Rng`), captured by every snapshot.
//!
//! Modules:
//! - [`math`]   — `Vec2`, `Aabb`, seeded `Rng`.
//! - [`blocks`] — the ship block-grid (~6 block types) and derived stats.
//! - [`entity`] — entities: ships, asteroids, projectiles, pickups.
//! - [`spatial`]— uniform spatial-hash broadphase + SAT/AABB narrowphase.
//! - [`world`]  — the fixed-timestep `step(world, inputs, dt)`.
//! - [`net`]    — wire types, 16-bit quantization, bincode (de)serialization.
//! - [`aoi`]    — area-of-interest queries.
//! - [`ffi`]    — the C-ABI surface for wasm hosting.

pub mod aoi;
pub mod blocks;
pub mod entity;
pub mod ffi;
pub mod math;
pub mod net;
pub mod spatial;
pub mod world;

pub use math::{Rng, Vec2};
pub use net::{Delta, InputFrame, Snapshot};
pub use world::{Event, Input, World, DT};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::BlockType;
    use crate::math::Rng;

    /// Build a non-trivial world deterministically and return it.
    fn make_world(seed: u64) -> World {
        let mut w = World::new(seed, 200.0);
        w.scatter_asteroids(12);
        w.spawn_ship(0, Vec2::new(-10.0, 0.0), 0.0);
        w.spawn_ship(1, Vec2::new(10.0, 0.0), std::f32::consts::PI);
        w
    }

    /// A scripted, varied input stream for `n` ticks driving two controllers.
    fn scripted_inputs(n: usize) -> Vec<Vec<Input>> {
        // Use an independent PRNG to author inputs — NOT the world's rng, so we
        // prove the world is deterministic given an arbitrary external stream.
        let mut script_rng = Rng::new(0xDEAD_BEEF);
        let mut frames = Vec::with_capacity(n);
        for _ in 0..n {
            let mk = |rng: &mut Rng, controller: u32| Input {
                controller,
                thrust: rng.range_f32(-1.0, 1.0),
                turn: rng.range_f32(-1.0, 1.0),
                fire: rng.next_u32() & 1 == 0,
                mine: rng.next_u32() & 3 == 0,
            };
            let a = mk(&mut script_rng, 0);
            let b = mk(&mut script_rng, 1);
            frames.push(vec![a, b]);
        }
        frames
    }

    #[test]
    fn determinism_replay_equality() {
        let frames = scripted_inputs(600);

        // Two independent worlds with the same seed and the same input stream.
        let mut w1 = make_world(42);
        let mut w2 = make_world(42);

        for frame in &frames {
            w1.step(frame, DT);
            w2.step(frame, DT);
            // Compare the canonical serialized snapshot every tick.
            let s1 = Snapshot::full(&w1).to_bytes().unwrap();
            let s2 = Snapshot::full(&w2).to_bytes().unwrap();
            assert_eq!(
                s1, s2,
                "snapshots diverged at tick {} (entities {} vs {})",
                w1.tick,
                w1.entities.len(),
                w2.entities.len()
            );
        }

        // Final byte-identical assertion for good measure.
        let f1 = Snapshot::full(&w1).to_bytes().unwrap();
        let f2 = Snapshot::full(&w2).to_bytes().unwrap();
        assert_eq!(f1, f2, "final snapshots differ");
        // The world must have actually evolved (sanity, not a no-op test).
        assert!(w1.tick == 600);
    }

    #[test]
    fn determinism_independent_of_input_order() {
        // The same inputs presented in a different order must produce the same
        // state, because `step` sorts inputs by controller.
        let mut w1 = make_world(7);
        let mut w2 = make_world(7);
        let frames = scripted_inputs(120);
        for frame in &frames {
            let mut reversed = frame.clone();
            reversed.reverse();
            w1.step(frame, DT);
            w2.step(&reversed, DT);
        }
        let a = Snapshot::full(&w1).to_bytes().unwrap();
        let b = Snapshot::full(&w2).to_bytes().unwrap();
        assert_eq!(a, b, "input ordering affected determinism");
    }

    #[test]
    fn serialize_restore_serialize_equality() {
        let mut w = make_world(99);
        let frames = scripted_inputs(200);
        for frame in &frames {
            w.step(frame, DT);
        }

        // serialize -> restore -> serialize must be byte-identical.
        let snap = Snapshot::full(&w);
        let bytes1 = snap.to_bytes().unwrap();
        let restored = Snapshot::from_bytes(&bytes1).unwrap().restore();
        let bytes2 = Snapshot::full(&restored).to_bytes().unwrap();
        assert_eq!(bytes1, bytes2, "serialize->restore->serialize not stable");

        // The restored world must keep stepping in lock-step with the original.
        let mut w_cont = w.clone();
        let mut r_cont = restored.clone();
        let more = scripted_inputs(60);
        for frame in &more {
            w_cont.step(frame, DT);
            r_cont.step(frame, DT);
        }
        assert_eq!(
            Snapshot::full(&w_cont).to_bytes().unwrap(),
            Snapshot::full(&r_cont).to_bytes().unwrap(),
            "restored world diverged when stepped further"
        );
    }

    #[test]
    fn aoi_query_is_subset_and_radius_correct() {
        let mut w = World::new(1, 500.0);
        // Place asteroids at known distances from the origin viewer.
        let near = w.spawn_asteroid(Vec2::new(5.0, 0.0), 2.0, 3, BlockType::Hull);
        let far = w.spawn_asteroid(Vec2::new(300.0, 0.0), 2.0, 3, BlockType::Hull);

        let ids = aoi::query_radius(&w, Vec2::ZERO, 50.0);
        assert!(ids.contains(&near), "near asteroid should be in AoI");
        assert!(!ids.contains(&far), "far asteroid must be excluded from AoI");

        // The snapshot AoI path must agree with the id query.
        let snap = Snapshot::aoi(&w, Vec2::ZERO, 50.0);
        let snap_ids: Vec<_> = snap.entities.iter().map(|e| e.id).collect();
        assert!(snap_ids.contains(&near));
        assert!(!snap_ids.contains(&far));
    }

    #[test]
    fn quantization_round_trip_within_tolerance() {
        use crate::net::{dequantize, quantize, POS_RANGE};
        for &v in &[-4000.0_f32, -1.5, 0.0, 1.5, 123.456, 4000.0] {
            let q = quantize(v, POS_RANGE);
            let back = dequantize(q, POS_RANGE);
            // 16-bit over an 8192-wide range => step ~0.125; allow a small eps.
            assert!((back - v).abs() < 0.2, "quant error too large for {v}: {back}");
        }
    }

    #[test]
    fn delta_build_and_round_trip() {
        let mut prev = make_world(5);
        let frames = scripted_inputs(30);
        let mut next = prev.clone();
        let mut last_events = Vec::new();
        for frame in &frames {
            prev = next.clone();
            last_events = next.step(frame, DT);
        }
        let delta = Delta::build(&prev, &next, &last_events);
        let bytes = delta.to_bytes().unwrap();
        let decoded = Delta::from_bytes(&bytes).unwrap();
        assert_eq!(delta, decoded, "delta did not round-trip through bincode");
    }

    #[test]
    fn ship_takes_damage_and_can_be_destroyed() {
        // Fire a stream of projectiles into a stationary ship and confirm it
        // eventually loses blocks. Deterministic by construction.
        let mut w = World::new(3, 100.0);
        let target = w.spawn_ship(0, Vec2::new(0.0, 0.0), 0.0);

        let start_blocks = match &w.entities[w.entities.iter().position(|e| e.id == target).unwrap()].kind {
            crate::entity::Kind::Ship(s) => s.grid.aggregate().solid_blocks,
            _ => unreachable!(),
        };
        assert!(start_blocks > 0);

        // Manually inject powerful projectiles right on the target each tick.
        for _ in 0..200 {
            // Spawn a projectile at the target with a velocity (will overlap).
            let pid = {
                let id = w.next_id;
                w.next_id += 1;
                id
            };
            w.entities.push(crate::entity::Entity {
                id: pid,
                pos: Vec2::new(-1.0, 0.0),
                vel: Vec2::new(60.0, 0.0),
                angle: 0.0,
                ang_vel: 0.0,
                kind: crate::entity::Kind::Projectile(crate::entity::Projectile {
                    damage: 300,
                    ttl: 1.0,
                    owner: 99999,
                }),
                dead: false,
            });
            w.step(&[], DT);
            if w.entities.iter().all(|e| e.id != target) {
                // Ship destroyed.
                return;
            }
        }
        // If not destroyed, at least confirm block loss occurred.
        let end_blocks = match &w.entities.iter().find(|e| e.id == target) {
            Some(e) => match &e.kind {
                crate::entity::Kind::Ship(s) => s.grid.aggregate().solid_blocks,
                _ => 0,
            },
            None => 0,
        };
        assert!(end_blocks < start_blocks, "ship took no damage");
    }
}
