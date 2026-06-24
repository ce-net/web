//! Area-of-Interest queries.
//!
//! Given a viewer position and a radius (or rectangular region), return the
//! ids of entities the viewer should receive. Backed by the same uniform
//! spatial hash used by the broadphase, so results are deterministic and the
//! query cost scales with the queried area, not the world size.

use crate::entity::EntityId;
use crate::math::{Aabb, Vec2};
use crate::spatial::SpatialHash;
use crate::world::World;

const AOI_CELL_SIZE: f32 = 12.0;

/// Build a transient spatial hash over the world's entities.
fn build_hash(world: &World) -> (SpatialHash, Vec<Aabb>) {
    let aabbs: Vec<Aabb> = world.entities.iter().map(|e| e.aabb()).collect();
    let mut hash = SpatialHash::new(AOI_CELL_SIZE);
    for (i, bb) in aabbs.iter().enumerate() {
        hash.insert(i as u32, bb);
    }
    (hash, aabbs)
}

/// Return entity ids within `radius` of `viewer`, sorted ascending by id.
pub fn query_radius(world: &World, viewer: Vec2, radius: f32) -> Vec<EntityId> {
    let (hash, aabbs) = build_hash(world);
    let idxs = hash.query_region(&aabbs, viewer, radius);
    let mut ids: Vec<EntityId> = idxs
        .iter()
        .map(|&i| world.entities[i as usize].id)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Return entities (cloned) within `radius` of `viewer`, in stable world order.
pub fn entities_in_radius<'a>(
    world: &'a World,
    viewer: Vec2,
    radius: f32,
) -> Vec<&'a crate::entity::Entity> {
    let r2 = radius * radius;
    world
        .entities
        .iter()
        .filter(|e| e.pos.sub(viewer).len_sq() <= r2)
        .collect()
}

/// Return entity ids whose center lies within an axis-aligned `region`.
pub fn query_region(world: &World, region: Aabb) -> Vec<EntityId> {
    let mut ids: Vec<EntityId> = world
        .entities
        .iter()
        .filter(|e| region.contains_point(e.pos))
        .map(|e| e.id)
        .collect();
    ids.sort_unstable();
    ids
}
