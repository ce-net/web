//! Entity model for the 2D open-world ship arena.

use crate::blocks::{BlockType, Grid};
use crate::math::{Aabb, Vec2};
use serde::{Deserialize, Serialize};

/// Stable entity identifier. Allocated monotonically from `World::next_id`.
pub type EntityId = u32;

/// What kind of thing an entity is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Kind {
    /// A player- or AI-controlled ship made of a block grid.
    Ship(ShipBody),
    /// An asteroid that can be mined for blocks.
    Asteroid(Asteroid),
    /// A flying projectile fired by a ship cannon.
    Projectile(Projectile),
    /// A free-floating block pickup yielded by mining/destruction.
    Pickup(Pickup),
}

/// The mutable per-ship state beyond raw physics.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShipBody {
    pub grid: Grid,
    /// Current shield energy; regenerates from reactor power, capped by aggregate.
    pub shield: f32,
    /// Cooldown (seconds) before this ship can fire again.
    pub fire_cooldown: f32,
    /// Owning controller id (which input slot drives this ship).
    pub controller: u32,
}

/// An asteroid: a circular rock with an ore reserve.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Asteroid {
    pub radius: f32,
    /// Remaining minable blocks.
    pub ore: u16,
    /// Block type this asteroid yields when mined.
    pub yields: BlockType,
}

/// A projectile.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Projectile {
    pub damage: i16,
    /// Remaining lifetime in seconds.
    pub ttl: f32,
    /// Entity that fired this (to avoid self-hits).
    pub owner: EntityId,
}

/// A floating block pickup.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pickup {
    pub block: BlockType,
    pub ttl: f32,
}

/// A simulated entity: physics state plus a typed payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    pub id: EntityId,
    pub pos: Vec2,
    pub vel: Vec2,
    pub angle: f32,
    pub ang_vel: f32,
    pub kind: Kind,
    /// Set true when the entity should be removed at the end of the step.
    pub dead: bool,
}

impl Entity {
    /// World-space AABB used by broadphase. Circular kinds use their radius;
    /// ships use the grid half-extents (a conservative, rotation-agnostic box).
    pub fn aabb(&self) -> Aabb {
        match &self.kind {
            Kind::Ship(_) => {
                // Conservative box: grid diagonal half-extent so rotation stays inside.
                let h = Grid::half_extents();
                let r = (h.x * h.x + h.y * h.y).sqrt();
                Aabb::from_center_half(self.pos, Vec2::new(r, r))
            }
            Kind::Asteroid(a) => Aabb::from_center_half(self.pos, Vec2::new(a.radius, a.radius)),
            Kind::Projectile(_) => {
                Aabb::from_center_half(self.pos, Vec2::new(0.2, 0.2))
            }
            Kind::Pickup(_) => Aabb::from_center_half(self.pos, Vec2::new(0.4, 0.4)),
        }
    }

    /// Collision radius used by simple circle checks.
    pub fn radius(&self) -> f32 {
        match &self.kind {
            Kind::Ship(_) => {
                let h = Grid::half_extents();
                (h.x * h.x + h.y * h.y).sqrt()
            }
            Kind::Asteroid(a) => a.radius,
            Kind::Projectile(_) => 0.2,
            Kind::Pickup(_) => 0.4,
        }
    }
}
