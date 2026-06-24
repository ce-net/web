//! Authoritative game state, compiled to wasm.
//!
//! This crate is the *single source of truth* for a multiplayer game. The same
//! logic runs identically on every node; CE's netgame framework elects ONE host
//! that calls `tick` each frame and periodically `snapshot`s state to the hub's
//! /db, so play survives host failover (a new host `restore`s the snapshot).
//!
//! The public surface is deliberately tiny and engine-agnostic:
//!
//!   init()                 -> reset to a fresh game
//!   tick(dt, input_bits)   -> advance the world by `dt` seconds
//!   snapshot() -> &[u8]     serialize the whole world (for /db failover)
//!   restore(&[u8])          load a snapshot (the new host adopts it)
//!
//! It uses NO external crates so it builds with plain `cargo build --target
//! wasm32-unknown-unknown` AND with wasm-pack. The wasm ABI below (raw exports
//! over linear memory) needs no wasm-bindgen; a frontend reads state through the
//! exported accessors. See `rust-game` for a frontend wired to this contract.

#![allow(clippy::missing_safety_doc)]

use std::cell::RefCell;

/// Input bit flags a client sends each tick (kept tiny: fits in one byte).
pub mod input {
    pub const UP: u32 = 1 << 0;
    pub const DOWN: u32 = 1 << 1;
    pub const LEFT: u32 = 1 << 2;
    pub const RIGHT: u32 = 1 << 3;
    pub const FIRE: u32 = 1 << 4;
}

/// The authoritative world. Replace these fields with your game's state. Keep it
/// `Copy`-cheap and trivially serializable so snapshots stay small.
#[derive(Clone, Debug)]
pub struct World {
    pub tick: u64,
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
    pub score: u32,
}

impl Default for World {
    fn default() -> Self {
        World { tick: 0, x: 0.5, y: 0.5, vx: 0.0, vy: 0.0, score: 0 }
    }
}

impl World {
    /// Advance the world by `dt` seconds given the current input bitset.
    pub fn tick(&mut self, dt: f32, input: u32) {
        const ACCEL: f32 = 1.2;
        const DRAG: f32 = 0.92;

        if input & input::UP != 0 {
            self.vy -= ACCEL * dt;
        }
        if input & input::DOWN != 0 {
            self.vy += ACCEL * dt;
        }
        if input & input::LEFT != 0 {
            self.vx -= ACCEL * dt;
        }
        if input & input::RIGHT != 0 {
            self.vx += ACCEL * dt;
        }

        self.vx *= DRAG;
        self.vy *= DRAG;
        self.x += self.vx * dt;
        self.y += self.vy * dt;

        // Bounce off the unit square so the demo stays on screen.
        if self.x < 0.0 {
            self.x = 0.0;
            self.vx = -self.vx;
        }
        if self.x > 1.0 {
            self.x = 1.0;
            self.vx = -self.vx;
        }
        if self.y < 0.0 {
            self.y = 0.0;
            self.vy = -self.vy;
        }
        if self.y > 1.0 {
            self.y = 1.0;
            self.vy = -self.vy;
        }

        if input & input::FIRE != 0 && self.tick % 10 == 0 {
            self.score += 1;
        }
        self.tick += 1;
    }

    /// Serialize the world into a compact little-endian byte buffer.
    pub fn snapshot(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(28);
        b.extend_from_slice(&self.tick.to_le_bytes());
        b.extend_from_slice(&self.x.to_le_bytes());
        b.extend_from_slice(&self.y.to_le_bytes());
        b.extend_from_slice(&self.vx.to_le_bytes());
        b.extend_from_slice(&self.vy.to_le_bytes());
        b.extend_from_slice(&self.score.to_le_bytes());
        b
    }

    /// Load a snapshot produced by `snapshot`. Returns false on a malformed buffer.
    pub fn restore(&mut self, data: &[u8]) -> bool {
        if data.len() < 28 {
            return false;
        }
        let rd_u64 = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
        let rd_f32 = |o: usize| f32::from_le_bytes(data[o..o + 4].try_into().unwrap());
        let rd_u32 = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
        self.tick = rd_u64(0);
        self.x = rd_f32(8);
        self.y = rd_f32(12);
        self.vx = rd_f32(16);
        self.vy = rd_f32(20);
        self.score = rd_u32(24);
        true
    }
}

// ---------------------------------------------------------------------------
// wasm ABI — raw exports over linear memory (no wasm-bindgen).
//
// The frontend drives the world like this:
//   ce_init();                       // reset
//   ce_tick(dt, input_bits);         // each frame
//   const ptr = ce_snapshot_ptr();   // pointer into wasm memory
//   const len = ce_snapshot_len();   // byte length
//   // read `len` bytes at `ptr` from the wasm Memory and PUT to /db
//   // on the way back in:
//   const p = ce_scratch_ptr();      // copy snapshot bytes here, then:
//   ce_restore(len);
// Plus direct accessors for rendering without a full snapshot read.
// ---------------------------------------------------------------------------

thread_local! {
    static WORLD: RefCell<World> = RefCell::new(World::default());
    static SNAP: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn ce_init() {
    WORLD.with(|w| *w.borrow_mut() = World::default());
}

#[no_mangle]
pub extern "C" fn ce_tick(dt: f32, input: u32) {
    WORLD.with(|w| w.borrow_mut().tick(dt, input));
}

#[no_mangle]
pub extern "C" fn ce_x() -> f32 {
    WORLD.with(|w| w.borrow().x)
}

#[no_mangle]
pub extern "C" fn ce_y() -> f32 {
    WORLD.with(|w| w.borrow().y)
}

#[no_mangle]
pub extern "C" fn ce_score() -> u32 {
    WORLD.with(|w| w.borrow().score)
}

#[no_mangle]
pub extern "C" fn ce_current_tick() -> u64 {
    WORLD.with(|w| w.borrow().tick)
}

/// Build a snapshot and stash it; returns its byte length. Call `ce_snapshot_ptr`
/// next to learn where to read it from wasm linear memory.
#[no_mangle]
pub extern "C" fn ce_snapshot_len() -> u32 {
    let bytes = WORLD.with(|w| w.borrow().snapshot());
    let len = bytes.len() as u32;
    SNAP.with(|s| *s.borrow_mut() = bytes);
    len
}

#[no_mangle]
pub extern "C" fn ce_snapshot_ptr() -> *const u8 {
    SNAP.with(|s| s.borrow().as_ptr())
}

/// Reserve `len` bytes of scratch and return a pointer the host writes the
/// snapshot bytes into before calling `ce_restore(len)`.
#[no_mangle]
pub extern "C" fn ce_scratch_ptr(len: u32) -> *mut u8 {
    SCRATCH.with(|s| {
        let mut buf = s.borrow_mut();
        buf.resize(len as usize, 0);
        buf.as_mut_ptr()
    })
}

/// Restore from the `len` bytes the host placed at `ce_scratch_ptr`. Returns 1 on
/// success, 0 on a malformed buffer.
#[no_mangle]
pub extern "C" fn ce_restore(len: u32) -> u32 {
    SCRATCH.with(|s| {
        let buf = s.borrow();
        let data = &buf[..(len as usize).min(buf.len())];
        WORLD.with(|w| if w.borrow_mut().restore(data) { 1 } else { 0 })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_roundtrips() {
        let mut a = World::default();
        for _ in 0..50 {
            a.tick(1.0 / 60.0, input::RIGHT | input::FIRE);
        }
        let snap = a.snapshot();
        let mut b = World::default();
        assert!(b.restore(&snap));
        assert_eq!(a.tick, b.tick);
        assert_eq!(a.score, b.score);
        assert!((a.x - b.x).abs() < 1e-6);
    }

    #[test]
    fn restore_rejects_short_buffer() {
        let mut w = World::default();
        assert!(!w.restore(&[0u8; 4]));
    }

    #[test]
    fn tick_is_deterministic() {
        let mut a = World::default();
        let mut b = World::default();
        for _ in 0..200 {
            a.tick(0.016, input::UP);
            b.tick(0.016, input::UP);
        }
        assert_eq!(a.snapshot(), b.snapshot());
    }
}
