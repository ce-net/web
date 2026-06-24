//! Entity interpolation for remote (non-predicted) entities.
//!
//! The local ship is predicted (see [`crate::predict`]); everything else —
//! other players' ships, asteroids, projectiles, pickups — is rendered ~100ms
//! in the past by interpolating between the two most recent authoritative
//! samples. Rendering slightly behind the latest sample means there is almost
//! always a newer sample to interpolate *toward*, which hides jitter and keeps
//! motion smooth even when frames arrive irregularly.
//!
//! Samples are fed from decoded `drift-sim` net frames:
//! - a full [`Snapshot`] replaces the whole table for its tick;
//! - a [`Delta`] dequantizes its `updated` entities and applies `removed`.
//!
//! The table keys on `EntityId` and keeps a short ring of (tick, transform)
//! samples per entity so [`InterpWorld::sample`] can pick the bracketing pair
//! for the render time.

use drift_sim::entity::EntityId;
use drift_sim::math::Vec2;
use drift_sim::net::{Delta, Snapshot};

/// How far behind the latest authoritative tick we render remotes, in seconds.
/// ~100ms at the 60Hz sim tick = 6 ticks of buffer.
pub const INTERP_DELAY: f32 = 0.100;

/// Max samples kept per entity (a small ring; older samples are dropped).
const MAX_SAMPLES: usize = 8;

/// A single interpolatable transform sample at a tick.
#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub tick: u64,
    pub pos: Vec2,
    pub vel: Vec2,
    pub angle: f32,
}

/// A renderable remote entity: a ring of recent transform samples plus a kind
/// tag the renderer maps to a sprite/quad style.
#[derive(Clone, Debug)]
pub struct RemoteEntity {
    pub id: EntityId,
    /// 0=ship, 1=asteroid, 2=projectile, 3=pickup (matches `EntityQuant.kind_tag`).
    pub kind_tag: u8,
    samples: Vec<Sample>,
}

impl RemoteEntity {
    fn push(&mut self, s: Sample) {
        // Keep samples tick-ordered; drop duplicates/regressions.
        if let Some(last) = self.samples.last() {
            if s.tick <= last.tick {
                return;
            }
        }
        self.samples.push(s);
        if self.samples.len() > MAX_SAMPLES {
            self.samples.remove(0);
        }
    }

    /// Interpolated transform at render tick `t` (fractional ticks allowed).
    /// Falls back to dead-reckoning by velocity past the newest sample so a
    /// briefly-stalled stream keeps moving rather than freezing.
    pub fn at(&self, t: f32) -> Option<Sample> {
        if self.samples.is_empty() {
            return None;
        }
        if self.samples.len() == 1 {
            return Some(self.samples[0]);
        }
        let first = self.samples.first().unwrap();
        let last = self.samples.last().unwrap();

        if t <= first.tick as f32 {
            return Some(*first);
        }
        if t >= last.tick as f32 {
            // Dead-reckon a little past the newest sample.
            let dt_ticks = t - last.tick as f32;
            let secs = dt_ticks * drift_sim::world::DT;
            return Some(Sample {
                tick: last.tick,
                pos: last.pos.add(last.vel.scale(secs)),
                vel: last.vel,
                angle: last.angle,
            });
        }

        // Find the bracketing pair [a, b] with a.tick <= t < b.tick.
        for w in self.samples.windows(2) {
            let (a, b) = (w[0], w[1]);
            if (a.tick as f32) <= t && t < (b.tick as f32) {
                let span = (b.tick - a.tick) as f32;
                let alpha = if span > 0.0 { (t - a.tick as f32) / span } else { 0.0 };
                return Some(Sample {
                    tick: t as u64,
                    pos: lerp(a.pos, b.pos, alpha),
                    vel: lerp(a.vel, b.vel, alpha),
                    angle: lerp_angle(a.angle, b.angle, alpha),
                });
            }
        }
        Some(*last)
    }
}

/// The render-side table of remote entities, fed by authoritative frames.
#[derive(Default)]
pub struct InterpWorld {
    entities: Vec<RemoteEntity>,
    /// Newest authoritative tick observed (defines the render time origin).
    pub latest_tick: u64,
}

impl InterpWorld {
    pub fn new() -> InterpWorld {
        InterpWorld::default()
    }

    /// The tick the renderer should display: `latest_tick` minus the interp
    /// delay (clamped at zero). Returned as a fractional tick.
    pub fn render_tick(&self) -> f32 {
        let delay_ticks = INTERP_DELAY / drift_sim::world::DT;
        (self.latest_tick as f32 - delay_ticks).max(0.0)
    }

    fn entry_mut(&mut self, id: EntityId, kind_tag: u8) -> &mut RemoteEntity {
        match self.entities.iter().position(|e| e.id == id) {
            Some(i) => {
                self.entities[i].kind_tag = kind_tag;
                &mut self.entities[i]
            }
            None => {
                self.entities.push(RemoteEntity { id, kind_tag, samples: Vec::new() });
                self.entities.last_mut().unwrap()
            }
        }
    }

    /// Replace the table from a full snapshot. Each entity contributes one
    /// sample at `snapshot.tick`. Entities absent from the snapshot are pruned.
    pub fn apply_snapshot(&mut self, snap: &Snapshot, exclude: Option<EntityId>) {
        use drift_sim::entity::Kind;
        self.latest_tick = self.latest_tick.max(snap.tick);
        let mut seen: Vec<EntityId> = Vec::with_capacity(snap.entities.len());
        for e in &snap.entities {
            if Some(e.id) == exclude {
                continue;
            }
            seen.push(e.id);
            let kind_tag = match &e.kind {
                Kind::Ship(_) => 0,
                Kind::Asteroid(_) => 1,
                Kind::Projectile(_) => 2,
                Kind::Pickup(_) => 3,
            };
            let s = Sample { tick: snap.tick, pos: e.pos, vel: e.vel, angle: e.angle };
            self.entry_mut(e.id, kind_tag).push(s);
        }
        // Prune entities not present in this full snapshot.
        self.entities.retain(|e| seen.contains(&e.id) || Some(e.id) == exclude);
    }

    /// Fold a quantized delta into the table. `updated` entities are dequantized
    /// into samples; `removed` ids are dropped.
    pub fn apply_delta(&mut self, delta: &Delta, exclude: Option<EntityId>) {
        self.latest_tick = self.latest_tick.max(delta.tick);
        for q in &delta.updated {
            if Some(q.id) == exclude {
                continue;
            }
            let s = Sample {
                tick: delta.tick,
                pos: q.pos_f32(),
                vel: q.vel_f32(),
                angle: q.angle_f32(),
            };
            self.entry_mut(q.id, q.kind_tag).push(s);
        }
        for id in &delta.removed {
            self.entities.retain(|e| e.id != *id);
        }
    }

    /// Iterate the currently-renderable remotes, sampled at the render tick.
    /// Entities with no usable sample at this time are skipped.
    pub fn visible(&self) -> impl Iterator<Item = (&RemoteEntity, Sample)> + '_ {
        let t = self.render_tick();
        self.entities.iter().filter_map(move |e| e.at(t).map(|s| (e, s)))
    }

    /// Count of tracked remote entities (HUD/debug).
    pub fn len(&self) -> usize {
        self.entities.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entities.is_empty()
    }
}

#[inline]
fn lerp(a: Vec2, b: Vec2, t: f32) -> Vec2 {
    a.add(b.sub(a).scale(t))
}

/// Shortest-arc angle interpolation in `[-PI, PI)`.
#[inline]
fn lerp_angle(a: f32, b: f32, t: f32) -> f32 {
    let mut d = b - a;
    let two_pi = std::f32::consts::PI * 2.0;
    while d > std::f32::consts::PI {
        d -= two_pi;
    }
    while d < -std::f32::consts::PI {
        d += two_pi;
    }
    drift_sim::math::wrap_angle(a + d * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolates_midpoint_between_two_samples() {
        let mut e = RemoteEntity { id: 1, kind_tag: 0, samples: Vec::new() };
        e.push(Sample { tick: 10, pos: Vec2::new(0.0, 0.0), vel: Vec2::ZERO, angle: 0.0 });
        e.push(Sample { tick: 20, pos: Vec2::new(10.0, 0.0), vel: Vec2::ZERO, angle: 0.0 });
        let s = e.at(15.0).unwrap();
        assert!((s.pos.x - 5.0).abs() < 1e-4, "got {}", s.pos.x);
    }

    #[test]
    fn snapshot_then_delta_tracks_and_removes() {
        use drift_sim::world::World;
        let mut w = World::new(1, 100.0);
        let a = w.spawn_asteroid(Vec2::new(5.0, 0.0), 2.0, 3, drift_sim::blocks::BlockType::Hull);
        let mut iw = InterpWorld::new();
        iw.apply_snapshot(&Snapshot::full(&w), None);
        assert_eq!(iw.len(), 1);

        // Build a delta that removes the asteroid.
        let prev = w.clone();
        // mark dead + step to drop it
        w.entities.iter_mut().for_each(|e| if e.id == a { e.dead = true; });
        w.step(&[], drift_sim::world::DT);
        let delta = Delta::build(&prev, &w, &[]);
        iw.apply_delta(&delta, None);
        assert_eq!(iw.len(), 0, "removed asteroid should be pruned");
    }

    #[test]
    fn render_tick_lags_latest_by_interp_delay() {
        let mut iw = InterpWorld::new();
        iw.latest_tick = 600;
        let expected = 600.0 - INTERP_DELAY / drift_sim::world::DT;
        assert!((iw.render_tick() - expected).abs() < 1e-3);
    }
}
