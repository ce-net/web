//! Scene assembly: turn simulation state into GPU instance/line vertex data.
//!
//! This module is pure data (no wgpu types) so it is unit-testable and shared
//! by both backends. The renderer uploads the produced `Vec`s straight into
//! vertex buffers. Colors follow the CE aesthetic (deep navy field, cyan/gold
//! accents). The local ship is drawn from the *predicted* world; every other
//! entity is drawn from the interpolated remote table.

use bytemuck::{Pod, Zeroable};
use drift_sim::blocks::{BlockType, Grid, GRID};
use drift_sim::entity::Kind;
use drift_sim::math::Vec2;
use drift_sim::world::World;

use crate::camera::Camera;
use crate::interp::InterpWorld;

/// Per-instance data for the quad pipeline. `repr(C)` + Pod so it maps 1:1 onto
/// the WGSL `VsIn` instance attributes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct QuadInstance {
    pub center: [f32; 2],
    pub half_size: [f32; 2],
    pub rot: f32,
    pub _pad: f32,
    pub color: [f32; 4],
}

/// Per-vertex data for the line pipeline.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct LineVertex {
    pub pos: [f32; 2],
    pub color: [f32; 4],
}

// ---- CE aesthetic palette (linear-ish sRGB values, alpha last) -------------

pub const COL_HULL: [f32; 4] = [0.18, 0.42, 0.72, 1.0];
pub const COL_THRUSTER: [f32; 4] = [1.0, 0.55, 0.20, 1.0];
pub const COL_CANNON: [f32; 4] = [0.95, 0.30, 0.36, 1.0];
pub const COL_REACTOR: [f32; 4] = [0.26, 0.88, 0.63, 1.0];
pub const COL_SHIELD: [f32; 4] = [0.22, 0.78, 1.0, 1.0];
pub const COL_LOCAL_TINT: [f32; 4] = [0.30, 0.86, 1.0, 1.0]; // cyan accent
pub const COL_ASTEROID: [f32; 4] = [0.42, 0.47, 0.56, 1.0];
pub const COL_PROJECTILE: [f32; 4] = [1.0, 0.82, 0.40, 1.0]; // gold
pub const COL_PICKUP: [f32; 4] = [0.43, 0.88, 0.63, 1.0];
pub const COL_GRID: [f32; 4] = [0.27, 0.40, 0.62, 0.16];
pub const COL_AIM: [f32; 4] = [0.30, 0.86, 1.0, 0.55];

#[inline]
fn block_color(t: BlockType) -> Option<[f32; 4]> {
    match t {
        BlockType::Empty => None,
        BlockType::Hull => Some(COL_HULL),
        BlockType::Thruster => Some(COL_THRUSTER),
        BlockType::Cannon => Some(COL_CANNON),
        BlockType::Reactor => Some(COL_REACTOR),
        BlockType::Shield => Some(COL_SHIELD),
    }
}

#[inline]
fn tint(base: [f32; 4], by: [f32; 4], amt: f32) -> [f32; 4] {
    [
        base[0] + (by[0] - base[0]) * amt,
        base[1] + (by[1] - base[1]) * amt,
        base[2] + (by[2] - base[2]) * amt,
        base[3],
    ]
}

/// Push one block-grid ship (each solid cell becomes a quad) at a transform.
fn push_ship(out: &mut Vec<QuadInstance>, grid: &Grid, pos: Vec2, angle: f32, local: bool) {
    let (s, c) = (angle.sin(), angle.cos());
    for cy in 0..GRID {
        for cx in 0..GRID {
            let b = grid.get(cx, cy);
            if !b.is_solid() {
                continue;
            }
            let Some(mut color) = block_color(b.kind) else { continue };
            if local {
                color = tint(color, COL_LOCAL_TINT, 0.28);
            }
            let off = Grid::cell_local_offset(cx, cy);
            let world = Vec2::new(pos.x + off.x * c - off.y * s, pos.y + off.x * s + off.y * c);
            out.push(QuadInstance {
                center: [world.x, world.y],
                half_size: [0.46, 0.46],
                rot: angle,
                _pad: 0.0,
                color,
            });
        }
    }
}

/// Push a simple circle-ish quad for a non-ship entity by kind tag.
fn push_blob(out: &mut Vec<QuadInstance>, kind_tag: u8, pos: Vec2, angle: f32) {
    let (half, color) = match kind_tag {
        1 => (2.5, COL_ASTEROID),
        2 => (0.28, COL_PROJECTILE),
        3 => (0.5, COL_PICKUP),
        _ => (0.5, COL_ASTEROID),
    };
    out.push(QuadInstance {
        center: [pos.x, pos.y],
        half_size: [half, half],
        rot: angle,
        _pad: 0.0,
        color,
    });
}

/// Build the full quad-instance list for one frame.
///
/// - The local ship (matching `local_controller`) is drawn from the predicted
///   `world` for zero-latency response.
/// - Every other entity is drawn from the interpolated `remotes` table.
pub fn build_quads(world: &World, remotes: &InterpWorld, local_controller: u32) -> Vec<QuadInstance> {
    let mut out = Vec::new();

    // Local predicted ship (block grid).
    let local_id = world
        .entities
        .iter()
        .find(|e| matches!(&e.kind, Kind::Ship(s) if s.controller == local_controller))
        .map(|e| {
            if let Kind::Ship(s) = &e.kind {
                push_ship(&mut out, &s.grid, e.pos, e.angle, true);
            }
            e.id
        });

    // Remotes (interpolated). Ships approximate as a single hull quad here —
    // their exact block grid is not carried by quantized deltas, only by full
    // snapshots; the renderer keeps deltas cheap and ships render as a body.
    for (e, s) in remotes.visible() {
        if Some(e.id) == local_id {
            continue;
        }
        match e.kind_tag {
            0 => out.push(QuadInstance {
                center: [s.pos.x, s.pos.y],
                half_size: [GRID as f32 * 0.5 * 0.55, GRID as f32 * 0.5 * 0.55],
                rot: s.angle,
                _pad: 0.0,
                color: COL_HULL,
            }),
            tag => push_blob(&mut out, tag, s.pos, s.angle),
        }
    }

    out
}

/// Build the arena grid + aim reticle as line vertices.
pub fn build_lines(world: &World, cam: &Camera, local_controller: u32) -> Vec<LineVertex> {
    let mut out = Vec::new();
    let half = world.arena_half;

    // Arena boundary box.
    let corners = [
        Vec2::new(-half, -half),
        Vec2::new(half, -half),
        Vec2::new(half, half),
        Vec2::new(-half, half),
    ];
    for i in 0..4 {
        let a = corners[i];
        let b = corners[(i + 1) % 4];
        out.push(LineVertex { pos: [a.x, a.y], color: COL_GRID });
        out.push(LineVertex { pos: [b.x, b.y], color: COL_GRID });
    }

    // Background grid lines on a fixed spacing, only those near the camera to
    // keep the vertex count bounded.
    let spacing = 20.0_f32;
    let cx = cam.center.x;
    let cy = cam.center.y;
    let reach = cam.half_height * 1.6;
    let first_x = ((cx - reach) / spacing).floor() * spacing;
    let first_y = ((cy - reach) / spacing).floor() * spacing;
    let mut gx = first_x;
    while gx <= cx + reach {
        out.push(LineVertex { pos: [gx, cy - reach], color: COL_GRID });
        out.push(LineVertex { pos: [gx, cy + reach], color: COL_GRID });
        gx += spacing;
    }
    let mut gy = first_y;
    while gy <= cy + reach {
        out.push(LineVertex { pos: [cx - reach, gy], color: COL_GRID });
        out.push(LineVertex { pos: [cx + reach, gy], color: COL_GRID });
        gy += spacing;
    }

    // Aim reticle: a short ray from the local ship along its heading.
    if let Some(e) = world
        .entities
        .iter()
        .find(|e| matches!(&e.kind, Kind::Ship(s) if s.controller == local_controller))
    {
        let dir = Vec2::new(1.0, 0.0).rotated(e.angle);
        let tip = e.pos.add(dir.scale(6.0));
        out.push(LineVertex { pos: [e.pos.x, e.pos.y], color: COL_AIM });
        out.push(LineVertex { pos: [tip.x, tip.y], color: COL_AIM });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world_with_local() -> World {
        let mut w = World::new(3, 100.0);
        w.spawn_ship(0, Vec2::new(0.0, 0.0), 0.0);
        w
    }

    #[test]
    fn local_ship_emits_one_quad_per_solid_block() {
        let w = world_with_local();
        let remotes = InterpWorld::new();
        let quads = build_quads(&w, &remotes, 0);
        let agg = match &w.entities[0].kind {
            Kind::Ship(s) => s.grid.aggregate(),
            _ => unreachable!(),
        };
        assert_eq!(quads.len(), agg.solid_blocks as usize);
    }

    #[test]
    fn lines_include_arena_box_and_aim() {
        let w = world_with_local();
        let cam = Camera::new();
        let lines = build_lines(&w, &cam, 0);
        // At least the 4 box edges (8 verts) + 2 aim verts.
        assert!(lines.len() >= 10);
    }

    #[test]
    fn instance_struct_is_pod_sized() {
        // 2+2+1+1+4 floats = 40 bytes; must be Pod for direct upload.
        assert_eq!(std::mem::size_of::<QuadInstance>(), 40);
        assert_eq!(std::mem::size_of::<LineVertex>(), 24);
    }
}
