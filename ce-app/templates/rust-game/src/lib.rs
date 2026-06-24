//! rust-game — authoritative backend (the brain of the multiplayer game).
//!
//! This is the same engine-agnostic contract as the `rust-backend` template:
//! one deterministic `World` that every node runs identically. CE netgame elects
//! a single host that calls `ce_tick` each frame and snapshots to /db; on host
//! failover a new host `ce_restore`s and play continues. The frontend in
//! index.html reads `ce_x/ce_y/ce_score` to render with WebGPU (canvas fallback).
//!
//! No external crates: builds with `wasm-pack build --target web` and with plain
//! `cargo build --target wasm32-unknown-unknown`. `ce-app deploy` auto-detects it.

#![allow(clippy::missing_safety_doc)]

use std::cell::RefCell;

/// Input bit flags a client sends each tick.
pub mod input {
    pub const UP: u32 = 1 << 0;
    pub const DOWN: u32 = 1 << 1;
    pub const LEFT: u32 = 1 << 2;
    pub const RIGHT: u32 = 1 << 3;
    pub const FIRE: u32 = 1 << 4;
}

/// One player's ship, advanced deterministically by the authoritative tick.
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
    pub fn tick(&mut self, dt: f32, input: u32) {
        const ACCEL: f32 = 1.4;
        const DRAG: f32 = 0.93;
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
        if input & input::FIRE != 0 && self.tick % 8 == 0 {
            self.score += 1;
        }
        self.tick += 1;
    }

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

#[no_mangle]
pub extern "C" fn ce_scratch_ptr(len: u32) -> *mut u8 {
    SCRATCH.with(|s| {
        let mut buf = s.borrow_mut();
        buf.resize(len as usize, 0);
        buf.as_mut_ptr()
    })
}

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
        for _ in 0..64 {
            a.tick(1.0 / 60.0, input::RIGHT | input::FIRE);
        }
        let mut b = World::default();
        assert!(b.restore(&a.snapshot()));
        assert_eq!(a.tick, b.tick);
        assert_eq!(a.score, b.score);
    }

    #[test]
    fn deterministic() {
        let mut a = World::default();
        let mut b = World::default();
        for _ in 0..256 {
            a.tick(0.016, input::UP | input::LEFT);
            b.tick(0.016, input::UP | input::LEFT);
        }
        assert_eq!(a.snapshot(), b.snapshot());
    }
}
