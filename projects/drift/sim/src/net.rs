//! Network wire types and (de)serialization.
//!
//! - [`Snapshot`] is a full, restorable copy of the world state.
//! - [`Delta`] carries changed entities + removals against a base tick.
//! - Positions/velocities are quantized to 16-bit for compact deltas.
//! - bincode is the canonical wire format (deterministic, length-prefixed by
//!   our own helpers where needed).
//!
//! The full-state path serializes [`World`] directly so a `serialize -> restore`
//! round-trip reproduces byte-identical state (see the round-trip test).

use crate::entity::{Entity, EntityId, Kind};
use crate::math::Vec2;
use crate::world::{Event, Input, World};
use serde::{Deserialize, Serialize};

/// Re-export so hosts/clients can name the wire input/event without reaching
/// into the world module.
pub use crate::world::{Event as WireEvent, Input as WireInput};

/// 16-bit fixed-point quantization of a world coordinate.
///
/// World coordinates are mapped from `[-RANGE, RANGE]` onto `u16`. Velocities
/// use a separate, larger range. This is lossy by design and is only used for
/// the bandwidth-sensitive [`Delta`] path; the full [`Snapshot`] path is exact.
pub const POS_RANGE: f32 = 4096.0;
pub const VEL_RANGE: f32 = 256.0;

#[inline]
pub fn quantize(value: f32, range: f32) -> u16 {
    let clamped = crate::math::clamp(value, -range, range);
    let norm = (clamped + range) / (2.0 * range); // [0,1]
    let q = (norm * (u16::MAX as f32)).round();
    crate::math::clamp(q, 0.0, u16::MAX as f32) as u16
}

#[inline]
pub fn dequantize(q: u16, range: f32) -> f32 {
    let norm = (q as f32) / (u16::MAX as f32);
    norm * (2.0 * range) - range
}

#[inline]
pub fn quantize_vec(v: Vec2, range: f32) -> [u16; 2] {
    [quantize(v.x, range), quantize(v.y, range)]
}

#[inline]
pub fn dequantize_vec(q: [u16; 2], range: f32) -> Vec2 {
    Vec2::new(dequantize(q[0], range), dequantize(q[1], range))
}

/// Angle quantized to 16 bits over `[-PI, PI)`.
#[inline]
pub fn quantize_angle(a: f32) -> u16 {
    let two_pi = std::f32::consts::PI * 2.0;
    let norm = (crate::math::wrap_angle(a) + std::f32::consts::PI) / two_pi;
    (crate::math::clamp(norm, 0.0, 1.0) * (u16::MAX as f32)).round() as u16
}

#[inline]
pub fn dequantize_angle(q: u16) -> f32 {
    let two_pi = std::f32::consts::PI * 2.0;
    let norm = (q as f32) / (u16::MAX as f32);
    norm * two_pi - std::f32::consts::PI
}

/// A full, restorable snapshot of the world. This is the authoritative format
/// used for /db failover and the determinism test.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub tick: u64,
    pub next_id: EntityId,
    pub rng_state: u64,
    pub arena_half: f32,
    pub entities: Vec<Entity>,
}

impl Snapshot {
    /// Capture the entire world.
    pub fn full(world: &World) -> Snapshot {
        Snapshot {
            tick: world.tick,
            next_id: world.next_id,
            rng_state: world.rng.state,
            arena_half: world.arena_half,
            entities: world.entities.clone(),
        }
    }

    /// Capture only entities within `radius` of `viewer` (area of interest).
    /// Tick/rng/next_id are still included so a viewer can sanity-check the
    /// stream, but the entity set is filtered. Order is preserved (stable).
    pub fn aoi(world: &World, viewer: Vec2, radius: f32) -> Snapshot {
        let r2 = radius * radius;
        let entities: Vec<Entity> = world
            .entities
            .iter()
            .filter(|e| e.pos.sub(viewer).len_sq() <= r2)
            .cloned()
            .collect();
        Snapshot {
            tick: world.tick,
            next_id: world.next_id,
            rng_state: world.rng.state,
            arena_half: world.arena_half,
            entities,
        }
    }

    /// Restore a full world from this snapshot. For an AoI snapshot the result
    /// only contains the visible subset (intended for client-side rendering,
    /// not authoritative stepping).
    pub fn restore(&self) -> World {
        let mut w = World::new(0, self.arena_half);
        w.tick = self.tick;
        w.next_id = self.next_id;
        w.rng.state = self.rng_state;
        w.entities = self.entities.clone();
        w
    }

    /// Serialize to bincode bytes.
    pub fn to_bytes(&self) -> Result<Vec<u8>, bincode::Error> {
        bincode::serialize(self)
    }

    /// Deserialize from bincode bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Snapshot, bincode::Error> {
        bincode::deserialize(bytes)
    }
}

/// A quantized per-entity update used inside a [`Delta`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityQuant {
    pub id: EntityId,
    pub pos: [u16; 2],
    pub vel: [u16; 2],
    pub angle: u16,
    /// Discriminant of the entity kind (for the renderer to pick a sprite).
    pub kind_tag: u8,
}

impl EntityQuant {
    pub fn from_entity(e: &Entity) -> EntityQuant {
        EntityQuant {
            id: e.id,
            pos: quantize_vec(e.pos, POS_RANGE),
            vel: quantize_vec(e.vel, VEL_RANGE),
            angle: quantize_angle(e.angle),
            kind_tag: match &e.kind {
                Kind::Ship(_) => 0,
                Kind::Asteroid(_) => 1,
                Kind::Projectile(_) => 2,
                Kind::Pickup(_) => 3,
            },
        }
    }

    pub fn pos_f32(&self) -> Vec2 {
        dequantize_vec(self.pos, POS_RANGE)
    }
    pub fn vel_f32(&self) -> Vec2 {
        dequantize_vec(self.vel, VEL_RANGE)
    }
    pub fn angle_f32(&self) -> f32 {
        dequantize_angle(self.angle)
    }
}

/// A bandwidth-light delta against a base tick. Carries quantized state for the
/// entities that changed plus the ids that were removed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Delta {
    pub base_tick: u64,
    pub tick: u64,
    pub updated: Vec<EntityQuant>,
    pub removed: Vec<EntityId>,
    pub events: Vec<Event>,
}

impl Delta {
    /// Build a delta from `prev` -> `next`. An entity appears in `updated` if it
    /// is new or its quantized state changed; ids in `prev` absent from `next`
    /// go to `removed`. Both worlds keep entities in stable id-ascending order
    /// after sorting here, so the delta is deterministic.
    pub fn build(prev: &World, next: &World, events: &[Event]) -> Delta {
        // Index prev by id via a sorted vector (no HashMap).
        let mut prev_q: Vec<(EntityId, EntityQuant)> = prev
            .entities
            .iter()
            .map(|e| (e.id, EntityQuant::from_entity(e)))
            .collect();
        prev_q.sort_by(|a, b| a.0.cmp(&b.0));

        let mut updated = Vec::new();
        for e in &next.entities {
            let q = EntityQuant::from_entity(e);
            match prev_q.binary_search_by(|x| x.0.cmp(&e.id)) {
                Ok(i) if prev_q[i].1 == q => {}
                _ => updated.push(q),
            }
        }

        // Removed = prev ids not in next.
        let mut next_ids: Vec<EntityId> = next.entities.iter().map(|e| e.id).collect();
        next_ids.sort_unstable();
        let mut removed = Vec::new();
        for (id, _) in &prev_q {
            if next_ids.binary_search(id).is_err() {
                removed.push(*id);
            }
        }
        removed.sort_unstable();

        Delta {
            base_tick: prev.tick,
            tick: next.tick,
            updated,
            removed,
            events: events.to_vec(),
        }
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, bincode::Error> {
        bincode::serialize(self)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Delta, bincode::Error> {
        bincode::deserialize(bytes)
    }
}

/// A batch of inputs for a single tick (host->sim or client->host).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InputFrame {
    pub tick: u64,
    pub inputs: Vec<Input>,
}

impl InputFrame {
    pub fn to_bytes(&self) -> Result<Vec<u8>, bincode::Error> {
        bincode::serialize(self)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<InputFrame, bincode::Error> {
        bincode::deserialize(bytes)
    }
}
