//! Uniform spatial hash grid (broadphase) and SAT/AABB narrowphase.
//!
//! Determinism notes:
//! - The hash maps cell coordinates to a `Vec` bucket through a plain `Vec`
//!   of `(key, bucket)` pairs we keep SORTED, never a `HashMap`. Iteration is
//!   therefore order-stable across runs and platforms.
//! - Candidate pairs are emitted in ascending `(a, b)` index order and
//!   de-duplicated, so the narrowphase always processes pairs identically.

use crate::math::{Aabb, Vec2};

/// Cell coordinate key, packed so it sorts deterministically.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct CellKey(i64);

#[inline]
fn cell_key(cx: i32, cy: i32) -> CellKey {
    // Pack two i32 into one i64 for a total order; bias to keep negatives ordered.
    let ux = (cx as i64).wrapping_add(0x8000_0000) & 0xFFFF_FFFF;
    let uy = (cy as i64).wrapping_add(0x8000_0000) & 0xFFFF_FFFF;
    CellKey((ux << 32) | uy)
}

/// A uniform spatial hash. Rebuilt each step from scratch (cheap, deterministic).
pub struct SpatialHash {
    cell_size: f32,
    inv_cell: f32,
    /// Sorted by key. Each entry is a bucket of entity indices.
    buckets: Vec<(CellKey, Vec<u32>)>,
}

impl SpatialHash {
    pub fn new(cell_size: f32) -> Self {
        SpatialHash {
            cell_size,
            inv_cell: 1.0 / cell_size,
            buckets: Vec::new(),
        }
    }

    pub fn clear(&mut self) {
        self.buckets.clear();
    }

    #[inline]
    fn coord(&self, v: f32) -> i32 {
        // floor toward negative infinity, stable for f32.
        let f = v * self.inv_cell;
        f.floor() as i32
    }

    /// Insert an entity index occupying `aabb` into every overlapped cell.
    pub fn insert(&mut self, index: u32, aabb: &Aabb) {
        let x0 = self.coord(aabb.min.x);
        let y0 = self.coord(aabb.min.y);
        let x1 = self.coord(aabb.max.x);
        let y1 = self.coord(aabb.max.y);
        let mut cy = y0;
        while cy <= y1 {
            let mut cx = x0;
            while cx <= x1 {
                let key = cell_key(cx, cy);
                match self.buckets.binary_search_by(|e| e.0.cmp(&key)) {
                    Ok(i) => self.buckets[i].1.push(index),
                    Err(i) => self.buckets.insert(i, (key, vec![index])),
                }
                cx += 1;
            }
            cy += 1;
        }
    }

    /// Emit candidate pairs `(a, b)` with `a < b`, de-duplicated, in ascending
    /// order. The `aabbs` slice provides each entity's box for an early reject.
    pub fn candidate_pairs(&self, aabbs: &[Aabb]) -> Vec<(u32, u32)> {
        let mut pairs: Vec<(u32, u32)> = Vec::new();
        // buckets are already key-sorted; within a bucket, indices were pushed
        // in insertion order (entity index ascending), so they are sorted too.
        for (_key, bucket) in &self.buckets {
            let n = bucket.len();
            for i in 0..n {
                for j in (i + 1)..n {
                    let mut a = bucket[i];
                    let mut b = bucket[j];
                    if a == b {
                        continue;
                    }
                    if a > b {
                        core::mem::swap(&mut a, &mut b);
                    }
                    if aabbs[a as usize].intersects(&aabbs[b as usize]) {
                        pairs.push((a, b));
                    }
                }
            }
        }
        pairs.sort_unstable();
        pairs.dedup();
        pairs
    }

    /// Query indices whose AABB overlaps a circular region (center, radius).
    /// Result is sorted ascending and de-duplicated.
    pub fn query_region(&self, aabbs: &[Aabb], center: Vec2, radius: f32) -> Vec<u32> {
        let region = Aabb::from_center_half(center, Vec2::new(radius, radius));
        let x0 = self.coord(region.min.x);
        let y0 = self.coord(region.min.y);
        let x1 = self.coord(region.max.x);
        let y1 = self.coord(region.max.y);
        let r2 = radius * radius;
        let mut out: Vec<u32> = Vec::new();
        let mut cy = y0;
        while cy <= y1 {
            let mut cx = x0;
            while cx <= x1 {
                let key = cell_key(cx, cy);
                if let Ok(i) = self.buckets.binary_search_by(|e| e.0.cmp(&key)) {
                    for &idx in &self.buckets[i].1 {
                        let bb = &aabbs[idx as usize];
                        // Distance from center to nearest point of bb.
                        let nx = crate::math::clamp(center.x, bb.min.x, bb.max.x);
                        let ny = crate::math::clamp(center.y, bb.min.y, bb.max.y);
                        let dx = center.x - nx;
                        let dy = center.y - ny;
                        if dx * dx + dy * dy <= r2 {
                            out.push(idx);
                        }
                    }
                }
                cx += 1;
            }
            cy += 1;
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    pub fn cell_size(&self) -> f32 {
        self.cell_size
    }
}

/// Result of a narrowphase overlap test.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Manifold {
    /// Minimum translation axis (unit) pointing from A to B.
    pub normal: Vec2,
    /// Penetration depth along `normal`.
    pub depth: f32,
}

/// AABB-vs-AABB narrowphase. Returns the minimum-penetration axis. This is the
/// SAT specialization for axis-aligned boxes (the two candidate axes are the
/// world X and Y axes), which keeps the math branch-stable and deterministic.
pub fn sat_aabb(a: &Aabb, b: &Aabb) -> Option<Manifold> {
    if !a.intersects(b) {
        return None;
    }
    let ac = Vec2::new((a.min.x + a.max.x) * 0.5, (a.min.y + a.max.y) * 0.5);
    let bc = Vec2::new((b.min.x + b.max.x) * 0.5, (b.min.y + b.max.y) * 0.5);
    let ax_half = (a.max.x - a.min.x) * 0.5;
    let ay_half = (a.max.y - a.min.y) * 0.5;
    let bx_half = (b.max.x - b.min.x) * 0.5;
    let by_half = (b.max.y - b.min.y) * 0.5;

    let dx = bc.x - ac.x;
    let px = (ax_half + bx_half) - dx.abs();
    if px <= 0.0 {
        return None;
    }
    let dy = bc.y - ac.y;
    let py = (ay_half + by_half) - dy.abs();
    if py <= 0.0 {
        return None;
    }

    // Choose the axis of least penetration. Ties resolve to X for determinism.
    if px <= py {
        let sign = if dx >= 0.0 { 1.0 } else { -1.0 };
        Some(Manifold {
            normal: Vec2::new(sign, 0.0),
            depth: px,
        })
    } else {
        let sign = if dy >= 0.0 { 1.0 } else { -1.0 };
        Some(Manifold {
            normal: Vec2::new(0.0, sign),
            depth: py,
        })
    }
}
