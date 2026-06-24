//! C-ABI surface so the simulation can compile to wasm and be driven by a host.
//!
//! Memory model:
//! - `sim_new` allocates a [`World`] on the heap and returns an opaque handle
//!   (a raw pointer cast to `usize`). The host treats it as an opaque token.
//! - Snapshot/serialize functions write bincode bytes into a caller-provided
//!   buffer and return the number of bytes written (or the required size, if
//!   the buffer is too small / null). This avoids the host having to free
//!   Rust-allocated memory.
//! - `apply_input` accepts a bincode-encoded [`InputFrame`].
//! - `restore` rebuilds the world in place from a bincode [`Snapshot`].
//! - `sim_free` drops the world.
//!
//! All functions are `#[no_mangle] extern "C"` and use only `usize`/pointer
//! scalars so they map cleanly onto wasm linear memory.

use crate::math::Vec2;
use crate::net::{InputFrame, Snapshot};
use crate::world::World;

/// Opaque handle = boxed `World` pointer.
type Handle = *mut World;

#[inline]
fn from_handle<'a>(h: usize) -> Option<&'a mut World> {
    if h == 0 {
        None
    } else {
        // Safety: handle came from `Box::into_raw` in `sim_new`; the host is
        // contractually required to pass back only valid, un-freed handles.
        unsafe { Some(&mut *(h as Handle)) }
    }
}

/// Create a new world. Returns an opaque handle (0 on failure).
#[no_mangle]
pub extern "C" fn sim_new(seed: u64, arena_half: f32, asteroids: u32) -> usize {
    let mut w = World::new(seed, arena_half);
    if asteroids > 0 {
        w.scatter_asteroids(asteroids);
    }
    let boxed = Box::new(w);
    Box::into_raw(boxed) as usize
}

/// Spawn a ship; returns the new entity id (0 on bad handle).
#[no_mangle]
pub extern "C" fn sim_spawn_ship(handle: usize, controller: u32, x: f32, y: f32, angle: f32) -> u32 {
    match from_handle(handle) {
        Some(w) => w.spawn_ship(controller, Vec2::new(x, y), angle),
        None => 0,
    }
}

/// Free a world handle.
#[no_mangle]
pub extern "C" fn sim_free(handle: usize) {
    if handle != 0 {
        // Safety: reclaim the box created in `sim_new`.
        unsafe {
            drop(Box::from_raw(handle as Handle));
        }
    }
}

/// Apply a bincode-encoded [`InputFrame`] for the next step.
/// Returns 1 on success, 0 on failure.
#[no_mangle]
pub extern "C" fn apply_input(handle: usize, ptr: *const u8, len: usize) -> u32 {
    let w = match from_handle(handle) {
        Some(w) => w,
        None => return 0,
    };
    if ptr.is_null() {
        return 0;
    }
    // Safety: host guarantees `ptr..ptr+len` is a readable buffer.
    let bytes = unsafe { core::slice::from_raw_parts(ptr, len) };
    match InputFrame::from_bytes(bytes) {
        Ok(frame) => {
            // Stage the inputs in the world's pending buffer via a thread-free
            // approach: stash on the world by stepping is wrong; instead store
            // them so `step` can consume. We keep them in a side field.
            w.pending_inputs = frame.inputs;
            1
        }
        Err(_) => 0,
    }
}

/// Advance the world one fixed step using the inputs staged by `apply_input`.
/// Returns the new tick number.
#[no_mangle]
pub extern "C" fn step(handle: usize) -> u64 {
    match from_handle(handle) {
        Some(w) => {
            let inputs = core::mem::take(&mut w.pending_inputs);
            w.step(&inputs, crate::world::DT);
            w.tick
        }
        None => 0,
    }
}

/// Write a full snapshot (bincode) into `out[..cap]`. Returns the number of
/// bytes the snapshot needs. If the return value is <= `cap` the buffer holds
/// the full snapshot; otherwise the host should retry with a larger buffer.
#[no_mangle]
pub extern "C" fn snapshot_full(handle: usize, out: *mut u8, cap: usize) -> usize {
    let w = match from_handle(handle) {
        Some(w) => w,
        None => return 0,
    };
    let snap = Snapshot::full(w);
    write_snapshot(&snap, out, cap)
}

/// Write an area-of-interest snapshot around `(vx, vy)` with `radius`.
/// Same buffer contract as [`snapshot_full`].
#[no_mangle]
pub extern "C" fn snapshot_aoi(
    handle: usize,
    vx: f32,
    vy: f32,
    radius: f32,
    out: *mut u8,
    cap: usize,
) -> usize {
    let w = match from_handle(handle) {
        Some(w) => w,
        None => return 0,
    };
    let snap = Snapshot::aoi(w, Vec2::new(vx, vy), radius);
    write_snapshot(&snap, out, cap)
}

/// Restore the world in place from a bincode [`Snapshot`].
/// Returns 1 on success, 0 on failure.
#[no_mangle]
pub extern "C" fn restore(handle: usize, ptr: *const u8, len: usize) -> u32 {
    let w = match from_handle(handle) {
        Some(w) => w,
        None => return 0,
    };
    if ptr.is_null() {
        return 0;
    }
    // Safety: host guarantees the input range is readable.
    let bytes = unsafe { core::slice::from_raw_parts(ptr, len) };
    match Snapshot::from_bytes(bytes) {
        Ok(snap) => {
            let restored = snap.restore();
            // Preserve any staged inputs cleared (fresh after restore).
            *w = restored;
            1
        }
        Err(_) => 0,
    }
}

/// Number of entities currently in the world.
#[no_mangle]
pub extern "C" fn sim_entity_count(handle: usize) -> u32 {
    match from_handle(handle) {
        Some(w) => w.entities.len() as u32,
        None => 0,
    }
}

/// Current tick.
#[no_mangle]
pub extern "C" fn sim_tick(handle: usize) -> u64 {
    match from_handle(handle) {
        Some(w) => w.tick,
        None => 0,
    }
}

fn write_snapshot(snap: &Snapshot, out: *mut u8, cap: usize) -> usize {
    let bytes = match snap.to_bytes() {
        Ok(b) => b,
        Err(_) => return 0,
    };
    let need = bytes.len();
    if !out.is_null() && cap >= need {
        // Safety: caller provided a writable buffer of at least `cap` bytes.
        unsafe {
            core::ptr::copy_nonoverlapping(bytes.as_ptr(), out, need);
        }
    }
    need
}
