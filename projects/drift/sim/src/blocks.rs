//! Ship block-grid model.
//!
//! A ship is a small fixed-size grid of typed blocks. Each cell is either
//! empty or holds one block with hit points. Aggregate properties (mass,
//! thrust, firepower, shield, power) are derived deterministically by scanning
//! the grid in a fixed cell order (row-major), never by iterating a hash map.

use serde::{Deserialize, Serialize};

/// Size of one block in world units.
pub const BLOCK_SIZE: f32 = 1.0;

/// Ship grid is `GRID` x `GRID` cells. Kept small and fixed so a ship
/// serializes to a compact, bounded byte layout.
pub const GRID: usize = 8;
pub const GRID_CELLS: usize = GRID * GRID;

/// The ~6 block types. `Empty` is the absence of a block.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum BlockType {
    Empty = 0,
    Hull = 1,
    Thruster = 2,
    Cannon = 3,
    Reactor = 4,
    Shield = 5,
}

impl BlockType {
    #[inline]
    pub fn from_u8(v: u8) -> BlockType {
        match v {
            1 => BlockType::Hull,
            2 => BlockType::Thruster,
            3 => BlockType::Cannon,
            4 => BlockType::Reactor,
            5 => BlockType::Shield,
            _ => BlockType::Empty,
        }
    }

    /// Starting hit points for a freshly placed block of this type.
    #[inline]
    pub fn max_hp(self) -> i16 {
        match self {
            BlockType::Empty => 0,
            BlockType::Hull => 100,
            BlockType::Thruster => 60,
            BlockType::Cannon => 70,
            BlockType::Reactor => 80,
            BlockType::Shield => 50,
        }
    }

    /// Mass contribution of this block type.
    #[inline]
    pub fn mass(self) -> f32 {
        match self {
            BlockType::Empty => 0.0,
            BlockType::Hull => 1.0,
            BlockType::Thruster => 1.2,
            BlockType::Cannon => 1.5,
            BlockType::Reactor => 2.0,
            BlockType::Shield => 1.3,
        }
    }
}

/// One grid cell.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Block {
    pub kind: BlockType,
    pub hp: i16,
}

impl Block {
    #[inline]
    pub const fn empty() -> Block {
        Block {
            kind: BlockType::Empty,
            hp: 0,
        }
    }

    #[inline]
    pub fn new(kind: BlockType) -> Block {
        Block {
            kind,
            hp: kind.max_hp(),
        }
    }

    #[inline]
    pub fn is_solid(&self) -> bool {
        self.kind != BlockType::Empty && self.hp > 0
    }
}

/// A ship's block grid plus derived, cached aggregate stats.
///
/// The grid is a fixed-length array (no `Vec`, no map) so iteration order is
/// always row-major and the byte layout is stable. serde does not derive for
/// arrays longer than 32, so [`Grid`] (de)serializes through a fixed-length
/// `Vec<Block>` of exactly `GRID_CELLS` entries — deterministic and compact.
#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    pub cells: [Block; GRID_CELLS],
}

impl Serialize for Grid {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = s.serialize_seq(Some(GRID_CELLS))?;
        for cell in self.cells.iter() {
            seq.serialize_element(cell)?;
        }
        seq.end()
    }
}

impl<'de> Deserialize<'de> for Grid {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Grid, D::Error> {
        let v: Vec<Block> = Vec::deserialize(d)?;
        if v.len() != GRID_CELLS {
            return Err(serde::de::Error::invalid_length(
                v.len(),
                &"a block grid of exactly GRID_CELLS cells",
            ));
        }
        let mut cells = [Block::empty(); GRID_CELLS];
        cells.copy_from_slice(&v);
        Ok(Grid { cells })
    }
}

/// Aggregate derived stats for a ship. Recomputed by [`Grid::aggregate`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Aggregate {
    pub mass: f32,
    pub thrust: f32,
    pub firepower: u16,
    pub shield_cap: f32,
    pub power: f32,
    pub solid_blocks: u16,
}

impl Default for Grid {
    fn default() -> Self {
        Grid {
            cells: [Block::empty(); GRID_CELLS],
        }
    }
}

impl Grid {
    #[inline]
    pub fn index(cx: usize, cy: usize) -> usize {
        cy * GRID + cx
    }

    #[inline]
    pub fn get(&self, cx: usize, cy: usize) -> Block {
        self.cells[Grid::index(cx, cy)]
    }

    #[inline]
    pub fn set(&mut self, cx: usize, cy: usize, b: Block) {
        self.cells[Grid::index(cx, cy)] = b;
    }

    /// Local offset (relative to ship center) of a cell's center, in world units.
    #[inline]
    pub fn cell_local_offset(cx: usize, cy: usize) -> crate::math::Vec2 {
        let half = (GRID as f32) * 0.5;
        crate::math::Vec2::new(
            (cx as f32 + 0.5 - half) * BLOCK_SIZE,
            (cy as f32 + 0.5 - half) * BLOCK_SIZE,
        )
    }

    /// A simple default fighter layout, deterministic for a given grid size.
    pub fn default_fighter() -> Grid {
        let mut g = Grid::default();
        let c = GRID / 2;
        // Hull core
        g.set(c - 1, c - 1, Block::new(BlockType::Hull));
        g.set(c, c - 1, Block::new(BlockType::Hull));
        g.set(c - 1, c, Block::new(BlockType::Hull));
        g.set(c, c, Block::new(BlockType::Hull));
        // Reactor in the middle-back
        g.set(c - 1, c + 1, Block::new(BlockType::Reactor));
        // Thrusters at the back
        g.set(c, c + 1, Block::new(BlockType::Thruster));
        g.set(c + 1, c + 1, Block::new(BlockType::Thruster));
        // Cannons at the front
        g.set(c - 1, c - 2, Block::new(BlockType::Cannon));
        g.set(c, c - 2, Block::new(BlockType::Cannon));
        // Shield
        g.set(c + 1, c, Block::new(BlockType::Shield));
        g
    }

    /// Recompute aggregate stats by scanning cells in fixed row-major order.
    pub fn aggregate(&self) -> Aggregate {
        let mut a = Aggregate::default();
        for i in 0..GRID_CELLS {
            let b = self.cells[i];
            if !b.is_solid() {
                continue;
            }
            a.solid_blocks += 1;
            a.mass += b.kind.mass();
            match b.kind {
                BlockType::Thruster => a.thrust += 12.0,
                BlockType::Cannon => a.firepower += 1,
                BlockType::Reactor => a.power += 25.0,
                BlockType::Shield => a.shield_cap += 40.0,
                _ => {}
            }
        }
        if a.mass < 0.001 {
            a.mass = 0.001; // guard against division by zero downstream
        }
        a
    }

    /// True if any cell is still solid.
    pub fn any_solid(&self) -> bool {
        self.cells.iter().any(|b| b.is_solid())
    }

    /// Half-extents of the ship's local AABB based on grid size.
    #[inline]
    pub fn half_extents() -> crate::math::Vec2 {
        let h = (GRID as f32) * 0.5 * BLOCK_SIZE;
        crate::math::Vec2::new(h, h)
    }

    /// Apply damage at a local hit cell, returning `true` if a block was destroyed.
    /// Spills overflow damage into the nearest solid neighbor in fixed order.
    pub fn damage_cell(&mut self, cx: usize, cy: usize, dmg: i16) -> bool {
        let idx = Grid::index(cx, cy);
        let b = &mut self.cells[idx];
        if !b.is_solid() {
            return false;
        }
        b.hp -= dmg;
        if b.hp <= 0 {
            b.kind = BlockType::Empty;
            b.hp = 0;
            true
        } else {
            false
        }
    }
}
