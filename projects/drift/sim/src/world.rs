//! The `World`: the deterministic, fixed-timestep simulation.
//!
//! [`World::step`] is the single source of truth shared by the authoritative
//! host and the client-side predictor. Given identical `(world, inputs)` it
//! always produces byte-identical output (see the determinism test).
//!
//! Determinism rules enforced here:
//! - All sim math is `f32` and processed in a fixed entity order (`Vec`).
//! - No `HashMap` iteration drives sim math; lookups use sorted helpers.
//! - No wall-clock or thread-rng; the only randomness is `self.rng`.
//! - Inputs are sorted by controller id before they are applied.

use crate::blocks::{Block, BlockType, Grid, GRID};
use crate::entity::{
    Asteroid, Entity, EntityId, Kind, Pickup, Projectile, ShipBody,
};
use crate::math::{wrap_angle, Rng, Vec2};
use crate::spatial::{sat_aabb, SpatialHash};
use serde::{Deserialize, Serialize};

/// The fixed simulation timestep, in seconds (60 Hz). The host advances the
/// world in whole `DT` increments; clients predict with the same `DT`.
pub const DT: f32 = 1.0 / 60.0;

/// Spatial-hash cell size (world units). Tuned to roughly ship diameter.
const CELL_SIZE: f32 = 12.0;

/// Linear damping applied each second (space drag for arcade feel + stability).
const LINEAR_DAMPING: f32 = 0.6;
const ANGULAR_DAMPING: f32 = 2.0;

/// Per-controller input for one tick. Buttons are explicit so the wire format
/// is compact and the apply order is fixed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Input {
    /// The controller (player slot) this input drives.
    pub controller: u32,
    /// Forward thrust in `[-1, 1]`.
    pub thrust: f32,
    /// Turn command in `[-1, 1]` (positive = counter-clockwise).
    pub turn: f32,
    /// Fire button held this tick.
    pub fire: bool,
    /// Mine button held this tick (mines a nearby asteroid).
    pub mine: bool,
}

/// A side-effect event produced by a step, surfaced to the host for fx/audio
/// and to clients for reconciliation. Events do not affect determinism: they
/// are derived from the same ordered traversal.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum Event {
    Fired { ship: EntityId, projectile: EntityId },
    BlockDestroyed { ship: EntityId, cx: u8, cy: u8 },
    ShipDestroyed { ship: EntityId },
    AsteroidMined { asteroid: EntityId, dropped: EntityId },
    PickupCollected { ship: EntityId, pickup: EntityId },
    ProjectileHit { projectile: EntityId, target: EntityId },
}

/// The complete simulation state. This is the value that is snapshotted,
/// serialized, and restored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct World {
    /// Monotonic tick counter.
    pub tick: u64,
    /// Next entity id to allocate.
    pub next_id: EntityId,
    /// The world PRNG — the only randomness source.
    pub rng: Rng,
    /// Entities in a fixed, order-stable vector.
    pub entities: Vec<Entity>,
    /// Half-size of the square arena; entities wrap at the boundary.
    pub arena_half: f32,
    /// Inputs staged by the FFI `apply_input` for the next `step`. Excluded
    /// from snapshots (transient, host-staged each tick) so determinism and
    /// round-trips compare only committed state.
    #[serde(skip)]
    pub pending_inputs: Vec<Input>,
}

impl World {
    /// Create an empty world seeded for deterministic spawning.
    pub fn new(seed: u64, arena_half: f32) -> World {
        World {
            tick: 0,
            next_id: 1,
            rng: Rng::new(seed),
            entities: Vec::new(),
            arena_half,
            pending_inputs: Vec::new(),
        }
    }

    #[inline]
    fn alloc_id(&mut self) -> EntityId {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Find an entity index by id (linear, order-stable). Returns `None` if
    /// absent. Used for sparse lookups; never drives ordered iteration.
    fn index_of(&self, id: EntityId) -> Option<usize> {
        self.entities.iter().position(|e| e.id == id)
    }

    /// Spawn a ship controlled by `controller` at `pos`.
    pub fn spawn_ship(&mut self, controller: u32, pos: Vec2, angle: f32) -> EntityId {
        let id = self.alloc_id();
        let grid = Grid::default_fighter();
        let agg = grid.aggregate();
        self.entities.push(Entity {
            id,
            pos,
            vel: Vec2::ZERO,
            angle,
            ang_vel: 0.0,
            kind: Kind::Ship(ShipBody {
                grid,
                shield: agg.shield_cap,
                fire_cooldown: 0.0,
                controller,
            }),
            dead: false,
        });
        id
    }

    /// Spawn an asteroid at `pos`.
    pub fn spawn_asteroid(&mut self, pos: Vec2, radius: f32, ore: u16, yields: BlockType) -> EntityId {
        let id = self.alloc_id();
        self.entities.push(Entity {
            id,
            pos,
            vel: Vec2::ZERO,
            angle: 0.0,
            ang_vel: 0.0,
            kind: Kind::Asteroid(Asteroid { radius, ore, yields }),
            dead: false,
        });
        id
    }

    /// Deterministically scatter `count` asteroids using the world PRNG.
    pub fn scatter_asteroids(&mut self, count: u32) {
        for _ in 0..count {
            let x = self.rng.range_f32(-self.arena_half, self.arena_half);
            let y = self.rng.range_f32(-self.arena_half, self.arena_half);
            let r = self.rng.range_f32(2.0, 5.0);
            let ore = (self.rng.below(8) + 3) as u16;
            let kinds = [
                BlockType::Hull,
                BlockType::Thruster,
                BlockType::Cannon,
                BlockType::Reactor,
                BlockType::Shield,
            ];
            let yields = kinds[self.rng.below(kinds.len() as u32) as usize];
            self.spawn_asteroid(Vec2::new(x, y), r, ore, yields);
        }
    }

    /// Advance the world by one fixed step using `inputs`.
    ///
    /// `dt` is accepted for API symmetry but the simulation is locked to [`DT`];
    /// callers should always pass `DT`. The parameter exists so the host can be
    /// explicit and so future variable-rate experiments don't change the ABI.
    pub fn step(&mut self, inputs: &[Input], dt: f32) -> Vec<Event> {
        let mut events: Vec<Event> = Vec::new();

        // 1) Sort inputs by controller for a fixed application order.
        let mut sorted: Vec<Input> = inputs.to_vec();
        sorted.sort_by(|a, b| a.controller.cmp(&b.controller));

        // 2) Apply control to ships (ordered by entity index).
        self.apply_controls(&sorted, dt, &mut events);

        // 3) Integrate motion + damping for every entity in index order.
        self.integrate(dt);

        // 4) Tick projectile/pickup lifetimes; mark expired dead.
        self.tick_lifetimes(dt);

        // 5) Broadphase + narrowphase collisions and their effects.
        self.resolve_collisions(&mut events);

        // 6) Remove dead entities (stable, preserves relative order).
        self.entities.retain(|e| !e.dead);

        self.tick += 1;
        events
    }

    fn apply_controls(&mut self, inputs: &[Input], dt: f32, events: &mut Vec<Event>) {
        // Collect cannon fire requests as we go; spawn after to avoid mutating
        // the vector while iterating.
        struct FireReq {
            ship: EntityId,
            pos: Vec2,
            dir: Vec2,
            speed: f32,
            damage: i16,
        }
        let mut fires: Vec<FireReq> = Vec::new();
        let mut mine_reqs: Vec<EntityId> = Vec::new();

        let n = self.entities.len();
        for i in 0..n {
            // Resolve the controlling input for this ship.
            let (controller, agg) = match &self.entities[i].kind {
                Kind::Ship(s) => (s.controller, s.grid.aggregate()),
                _ => continue,
            };
            // Binary search the sorted inputs by controller.
            let inp = inputs
                .binary_search_by(|x| x.controller.cmp(&controller))
                .ok()
                .map(|j| inputs[j])
                .unwrap_or(Input {
                    controller,
                    ..Default::default()
                });

            let mass = agg.mass;
            let thrust_force = agg.thrust;
            let turn_rate = 3.0; // rad/s at full turn input
            let fire_rate = 0.25; // seconds between shots

            // Apply turning to angular velocity.
            let e = &mut self.entities[i];
            e.ang_vel += inp.turn.clamp(-1.0, 1.0) * turn_rate * dt;

            // Apply forward thrust along the ship's heading.
            if thrust_force > 0.0 {
                let heading = Vec2::new(1.0, 0.0).rotated(e.angle);
                let accel = thrust_force / mass;
                let f = inp.thrust.clamp(-1.0, 1.0) * accel * dt;
                e.vel = e.vel.add(heading.scale(f));
            }

            // Precompute entity-level values before borrowing `e.kind` mutably.
            let e_id = e.id;
            let e_pos = e.pos;
            let e_angle = e.angle;
            let e_radius = e.radius();

            // Handle cooldown + firing.
            if let Kind::Ship(s) = &mut e.kind {
                if s.fire_cooldown > 0.0 {
                    s.fire_cooldown -= dt;
                    if s.fire_cooldown < 0.0 {
                        s.fire_cooldown = 0.0;
                    }
                }
                if inp.fire && agg.firepower > 0 && s.fire_cooldown <= 0.0 {
                    s.fire_cooldown = fire_rate;
                    let heading = Vec2::new(1.0, 0.0).rotated(e_angle);
                    let muzzle = e_pos.add(heading.scale(e_radius + 0.3));
                    fires.push(FireReq {
                        ship: e_id,
                        pos: muzzle,
                        dir: heading,
                        speed: 40.0,
                        damage: 25 * agg.firepower as i16,
                    });
                }
                // Shield regen from reactor power.
                let cap = agg.shield_cap;
                if s.shield < cap {
                    s.shield += (agg.power * 0.1) * dt;
                    if s.shield > cap {
                        s.shield = cap;
                    }
                }
            }

            if inp.mine {
                mine_reqs.push(self.entities[i].id);
            }
        }

        // Spawn projectiles (deterministic: fires built in entity-index order).
        for f in fires {
            let pid = self.alloc_id();
            let owner_vel = self
                .index_of(f.ship)
                .map(|k| self.entities[k].vel)
                .unwrap_or(Vec2::ZERO);
            self.entities.push(Entity {
                id: pid,
                pos: f.pos,
                vel: owner_vel.add(f.dir.scale(f.speed)),
                angle: f.dir.y.atan2(f.dir.x),
                ang_vel: 0.0,
                kind: Kind::Projectile(Projectile {
                    damage: f.damage,
                    ttl: 2.5,
                    owner: f.ship,
                }),
                dead: false,
            });
            events.push(Event::Fired {
                ship: f.ship,
                projectile: pid,
            });
        }

        // Process mining requests in stable order.
        for ship_id in mine_reqs {
            self.try_mine(ship_id, events);
        }
    }

    fn try_mine(&mut self, ship_id: EntityId, events: &mut Vec<Event>) {
        let ship_idx = match self.index_of(ship_id) {
            Some(i) => i,
            None => return,
        };
        let spos = self.entities[ship_idx].pos;
        let reach = self.entities[ship_idx].radius() + 3.0;

        // Find the nearest asteroid in reach (stable: lowest index wins ties).
        let mut best: Option<(usize, f32)> = None;
        for (i, e) in self.entities.iter().enumerate() {
            if let Kind::Asteroid(a) = &e.kind {
                if a.ore == 0 {
                    continue;
                }
                let d = e.pos.sub(spos).len() - a.radius;
                if d <= reach {
                    match best {
                        Some((_, bd)) if bd <= d => {}
                        _ => best = Some((i, d)),
                    }
                }
            }
        }

        if let Some((ai, _)) = best {
            let (yields, depleted) = if let Kind::Asteroid(a) = &mut self.entities[ai].kind {
                a.ore -= 1;
                (a.yields, a.ore == 0)
            } else {
                return;
            };
            let apos = self.entities[ai].pos;
            // Drop a pickup nudged toward the ship deterministically.
            let dir = spos.sub(apos).normalized();
            let drop_pos = apos.add(dir.scale(self.entities[ai].radius() + 0.6));
            let pid = self.alloc_id();
            self.entities.push(Entity {
                id: pid,
                pos: drop_pos,
                vel: dir.scale(2.0),
                angle: 0.0,
                ang_vel: 0.0,
                kind: Kind::Pickup(Pickup {
                    block: yields,
                    ttl: 20.0,
                }),
                dead: false,
            });
            events.push(Event::AsteroidMined {
                asteroid: self.entities[ai].id,
                dropped: pid,
            });
            if depleted {
                self.entities[ai].dead = true;
            }
        }
    }

    fn integrate(&mut self, dt: f32) {
        let half = self.arena_half;
        for e in self.entities.iter_mut() {
            e.pos = e.pos.add(e.vel.scale(dt));
            e.angle = wrap_angle(e.angle + e.ang_vel * dt);

            // Damping (skip projectiles so they keep their speed).
            if !matches!(e.kind, Kind::Projectile(_)) {
                let lin = (1.0 - LINEAR_DAMPING * dt).max(0.0);
                e.vel = e.vel.scale(lin);
                let ang = (1.0 - ANGULAR_DAMPING * dt).max(0.0);
                e.ang_vel *= ang;
            }

            // Toroidal wrap at arena boundary.
            if e.pos.x > half {
                e.pos.x -= half * 2.0;
            } else if e.pos.x < -half {
                e.pos.x += half * 2.0;
            }
            if e.pos.y > half {
                e.pos.y -= half * 2.0;
            } else if e.pos.y < -half {
                e.pos.y += half * 2.0;
            }
        }
    }

    fn tick_lifetimes(&mut self, dt: f32) {
        for e in self.entities.iter_mut() {
            match &mut e.kind {
                Kind::Projectile(p) => {
                    p.ttl -= dt;
                    if p.ttl <= 0.0 {
                        e.dead = true;
                    }
                }
                Kind::Pickup(p) => {
                    p.ttl -= dt;
                    if p.ttl <= 0.0 {
                        e.dead = true;
                    }
                }
                _ => {}
            }
        }
    }

    fn resolve_collisions(&mut self, events: &mut Vec<Event>) {
        let n = self.entities.len();
        if n < 2 {
            return;
        }
        // Build broadphase from current AABBs.
        let aabbs: Vec<_> = self.entities.iter().map(|e| e.aabb()).collect();
        let mut hash = SpatialHash::new(CELL_SIZE);
        for (i, bb) in aabbs.iter().enumerate() {
            hash.insert(i as u32, bb);
        }
        let pairs = hash.candidate_pairs(&aabbs);

        for (ia, ib) in pairs {
            let (a, b) = (ia as usize, ib as usize);
            if self.entities[a].dead || self.entities[b].dead {
                continue;
            }
            self.handle_pair(a, b, events);
        }
    }

    /// Dispatch a candidate pair to the right interaction. `a < b` always.
    fn handle_pair(&mut self, a: usize, b: usize, events: &mut Vec<Event>) {
        use Kind::*;
        // Order the dispatch by inspecting kinds without holding borrows.
        let ka = kind_tag(&self.entities[a].kind);
        let kb = kind_tag(&self.entities[b].kind);

        match (ka, kb) {
            (KindTag::Projectile, KindTag::Ship) => self.projectile_ship(a, b, events),
            (KindTag::Ship, KindTag::Projectile) => self.projectile_ship(b, a, events),
            (KindTag::Projectile, KindTag::Asteroid) => self.projectile_asteroid(a, b),
            (KindTag::Asteroid, KindTag::Projectile) => self.projectile_asteroid(b, a),
            (KindTag::Ship, KindTag::Pickup) => self.ship_pickup(a, b, events),
            (KindTag::Pickup, KindTag::Ship) => self.ship_pickup(b, a, events),
            (KindTag::Ship, KindTag::Asteroid) => self.ship_solid_bounce(a, b),
            (KindTag::Asteroid, KindTag::Ship) => self.ship_solid_bounce(b, a),
            (KindTag::Ship, KindTag::Ship) => self.ship_solid_bounce(a, b),
            _ => {
                let _ = (Ship, Asteroid, Projectile, Pickup); // silence unused import warning
            }
        }
    }

    fn projectile_ship(&mut self, pi: usize, si: usize, events: &mut Vec<Event>) {
        // Skip self-hit.
        let owner = match &self.entities[pi].kind {
            Kind::Projectile(p) => p.owner,
            _ => return,
        };
        if self.entities[si].id == owner {
            return;
        }
        // Narrowphase: AABB SAT for a hit confirmation.
        let pa = self.entities[pi].aabb();
        let sa = self.entities[si].aabb();
        let manifold = match sat_aabb(&pa, &sa) {
            Some(m) => m,
            None => return,
        };

        let damage = match &self.entities[pi].kind {
            Kind::Projectile(p) => p.damage,
            _ => return,
        };
        let pid = self.entities[pi].id;
        let sid = self.entities[si].id;
        let hit_local =
            self.world_to_local(si, self.entities[pi].pos.add(manifold.normal.scale(0.1)));

        // Shield absorbs first.
        let mut remaining = damage as f32;
        if let Kind::Ship(s) = &mut self.entities[si].kind {
            if s.shield > 0.0 {
                let absorbed = remaining.min(s.shield);
                s.shield -= absorbed;
                remaining -= absorbed;
            }
        }
        if remaining > 0.5 {
            if let Some((cx, cy)) = hit_local {
                let destroyed = if let Kind::Ship(s) = &mut self.entities[si].kind {
                    s.grid.damage_cell(cx, cy, remaining as i16)
                } else {
                    false
                };
                if destroyed {
                    events.push(Event::BlockDestroyed {
                        ship: sid,
                        cx: cx as u8,
                        cy: cy as u8,
                    });
                    // Drop a block pickup.
                    self.drop_block_from_ship(si, cx, cy);
                }
            }
        }
        events.push(Event::ProjectileHit {
            projectile: pid,
            target: sid,
        });
        self.entities[pi].dead = true;

        // Destroyed ship?
        let alive = match &self.entities[si].kind {
            Kind::Ship(s) => s.grid.any_solid(),
            _ => true,
        };
        if !alive {
            self.entities[si].dead = true;
            events.push(Event::ShipDestroyed { ship: sid });
        }
    }

    fn projectile_asteroid(&mut self, pi: usize, _ai: usize) {
        // Projectiles are consumed by asteroids (no mining via shooting).
        self.entities[pi].dead = true;
    }

    fn ship_pickup(&mut self, si: usize, pj: usize, events: &mut Vec<Event>) {
        let block = match &self.entities[pj].kind {
            Kind::Pickup(p) => p.block,
            _ => return,
        };
        // Attach the block to the first empty cell in row-major order.
        let attached = if let Kind::Ship(s) = &mut self.entities[si].kind {
            let mut placed = false;
            for i in 0..(GRID * GRID) {
                if s.grid.cells[i].kind == BlockType::Empty {
                    s.grid.cells[i] = Block::new(block);
                    placed = true;
                    break;
                }
            }
            placed
        } else {
            false
        };
        if attached {
            let sid = self.entities[si].id;
            let pid = self.entities[pj].id;
            self.entities[pj].dead = true;
            events.push(Event::PickupCollected {
                ship: sid,
                pickup: pid,
            });
        }
    }

    /// Elastic-ish positional + velocity response for two solid bodies.
    fn ship_solid_bounce(&mut self, a: usize, b: usize) {
        let aa = self.entities[a].aabb();
        let bb = self.entities[b].aabb();
        let m = match sat_aabb(&aa, &bb) {
            Some(m) => m,
            None => return,
        };
        // Push apart equally along the normal (normal points A->B).
        let push = m.normal.scale(m.depth * 0.5);
        self.entities[a].pos = self.entities[a].pos.sub(push);
        self.entities[b].pos = self.entities[b].pos.add(push);

        // Exchange the normal component of velocity (simple bounce).
        let n = m.normal;
        let va = self.entities[a].vel;
        let vb = self.entities[b].vel;
        let pa = va.dot(n);
        let pb = vb.dot(n);
        let restitution = 0.4;
        self.entities[a].vel = va.add(n.scale((pb - pa) * restitution));
        self.entities[b].vel = vb.add(n.scale((pa - pb) * restitution));
    }

    /// Convert a world point to the nearest ship grid cell `(cx, cy)`.
    fn world_to_local(&self, si: usize, world: Vec2) -> Option<(usize, usize)> {
        let e = &self.entities[si];
        let rel = world.sub(e.pos).rotated(-e.angle);
        let half = (GRID as f32) * 0.5;
        let cx = (rel.x / crate::blocks::BLOCK_SIZE + half).floor();
        let cy = (rel.y / crate::blocks::BLOCK_SIZE + half).floor();
        if cx < 0.0 || cy < 0.0 || cx >= GRID as f32 || cy >= GRID as f32 {
            // Fall back to the nearest solid cell so a glancing hit still lands.
            return self.nearest_solid_cell(si);
        }
        let (cxi, cyi) = (cx as usize, cy as usize);
        if let Kind::Ship(s) = &e.kind {
            if s.grid.get(cxi, cyi).is_solid() {
                return Some((cxi, cyi));
            }
        }
        self.nearest_solid_cell(si)
    }

    fn nearest_solid_cell(&self, si: usize) -> Option<(usize, usize)> {
        if let Kind::Ship(s) = &self.entities[si].kind {
            for cy in 0..GRID {
                for cx in 0..GRID {
                    if s.grid.get(cx, cy).is_solid() {
                        return Some((cx, cy));
                    }
                }
            }
        }
        None
    }

    fn drop_block_from_ship(&mut self, si: usize, cx: usize, cy: usize) {
        let e_pos = self.entities[si].pos;
        let e_angle = self.entities[si].angle;
        let local = Grid::cell_local_offset(cx, cy);
        let world = e_pos.add(local.rotated(e_angle));
        let pid = self.alloc_id();
        // Use the rng for a small deterministic scatter velocity.
        let vx = self.rng.range_f32(-2.0, 2.0);
        let vy = self.rng.range_f32(-2.0, 2.0);
        self.entities.push(Entity {
            id: pid,
            pos: world,
            vel: Vec2::new(vx, vy),
            angle: 0.0,
            ang_vel: 0.0,
            kind: Kind::Pickup(Pickup {
                block: BlockType::Hull,
                ttl: 15.0,
            }),
            dead: false,
        });
    }
}

/// A cheap kind discriminant used to dispatch collision pairs without holding
/// borrows across the match.
#[derive(Clone, Copy, PartialEq)]
enum KindTag {
    Ship,
    Asteroid,
    Projectile,
    Pickup,
}

#[inline]
fn kind_tag(k: &Kind) -> KindTag {
    match k {
        Kind::Ship(_) => KindTag::Ship,
        Kind::Asteroid(_) => KindTag::Asteroid,
        Kind::Projectile(_) => KindTag::Projectile,
        Kind::Pickup(_) => KindTag::Pickup,
    }
}
