// DRIFT WASM HOST WRAPPER — adapts the drift-sim cdylib (the C-ABI in sim/src/ffi.rs)
// into the plain-object "wasm host" interface that drift.js (createDriftRuntime, host:)
// drives. This is the SAME wasm module the headless host.mjs loads; the browser host
// path and the pinned-node path share it byte-for-byte.
//
// The sim cdylib exports, over wasm linear memory (all scalars are usize/pointer):
//   sim_new(seed:u64, arena_half:f32, asteroids:u32) -> handle:usize
//   sim_spawn_ship(handle, controller:u32, x:f32, y:f32, angle:f32) -> id:u32
//   sim_free(handle)
//   apply_input(handle, ptr, len) -> u32
//   step(handle) -> tick:u64  (returned as BigInt by wasm; we Number() it)
//   snapshot_full(handle, out, cap) -> need:usize
//   snapshot_aoi(handle, vx:f32, vy:f32, radius:f32, out, cap) -> need:usize
//   restore(handle, ptr, len) -> u32
//   sim_entity_count(handle) -> u32
//   sim_tick(handle) -> u64
//
// Snapshot/restore use the "write into a caller buffer, returns required size" contract:
// we allocate scratch in wasm memory via the module's allocator. drift-sim is built with
// panic=abort and no wasm-bindgen, so it does NOT export malloc by default. We therefore
// reserve a fixed scratch region by growing memory and bump-allocating from the top of
// linear memory that the module is not using for its own heap. To stay correct without a
// real allocator, we grow the memory by a scratch budget at load time and bump within it.
//
// loadSimHost(opts):
//   opts.url    URL/path to the sim .wasm (default "./drift_sim.wasm")
//   opts.fetch  fetch override (Node)
//   opts.bytes  raw wasm bytes (skips fetch)
// Returns a Promise of the host object with the methods drift.js expects:
//   newWorld(seed, arenaHalf, asteroids) -> handle
//   spawnShip(handle, controller, x, y, angle) -> id
//   applyInput(handle, Uint8Array) -> bool
//   step(handle) -> tick:number
//   snapshotFull(handle) -> Uint8Array
//   snapshotAoi(handle, x, y, r) -> Uint8Array
//   restore(handle, Uint8Array) -> bool
//   entityCount(handle) -> number
//   tick(handle) -> number
//   free(handle)
//
// No emojis.

const SCRATCH_PAGES = 64; // 64 * 64KiB = 4 MiB scratch for snapshot/input marshaling

async function fetchWasmBytes(opts) {
  if (opts && opts.bytes) return opts.bytes;
  const url = (opts && opts.url) || "./drift_sim.wasm";
  const doFetch =
    (opts && opts.fetch) ||
    (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (doFetch) {
    const res = await doFetch(url);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
  // Node fallback: read from disk.
  const fs = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  let p = url;
  try {
    if (url.startsWith("file:")) p = fileURLToPath(url);
  } catch (_) {}
  return new Uint8Array(await fs.readFile(p));
}

export async function loadSimHost(opts = {}) {
  const bytes = await fetchWasmBytes(opts);
  const { instance } = await WebAssembly.instantiate(bytes, {
    // drift-sim is no_std-free std but compiled cdylib with panic=abort; it imports
    // nothing from the host beyond memory it defines itself. If a future build adds
    // wasi imports, surface them as no-ops here.
    env: {},
    wasi_snapshot_preview1: {
      proc_exit: () => {},
      fd_write: () => 0,
      fd_close: () => 0,
      fd_seek: () => 0,
      random_get: (ptr, len) => {
        // best-effort fill; the sim's randomness is seeded, this is just a safety net
        return 0;
      },
    },
  });

  const ex = instance.exports;
  const mem = ex.memory;
  if (!mem) throw new Error("drift sim wasm exports no memory");

  // Reserve a scratch arena at the END of current linear memory by growing it.
  const pageBytes = 65536;
  const scratchBase = mem.buffer.byteLength;
  const grew = mem.grow(SCRATCH_PAGES);
  if (grew === -1) throw new Error("drift sim wasm: failed to grow memory for scratch");
  const scratchLen = SCRATCH_PAGES * pageBytes;

  // Bump allocator within the reserved scratch arena (reset every call that needs it).
  let bump = scratchBase;
  function scratchReset() { bump = scratchBase; }
  function scratchAlloc(n) {
    const aligned = (bump + 7) & ~7;
    if (aligned + n > scratchBase + scratchLen) {
      throw new Error("drift sim scratch overflow (" + n + " bytes)");
    }
    bump = aligned + n;
    return aligned;
  }

  function u8() { return new Uint8Array(mem.buffer); }

  function writeBytes(src) {
    const ptr = scratchAlloc(src.length);
    u8().set(src, ptr);
    return { ptr, len: src.length };
  }

  function num(v) {
    return typeof v === "bigint" ? Number(v) : Number(v);
  }

  // Snapshot read: call with (out=0, cap=0) to learn the size, allocate, call again.
  function readSnapshot(callWith) {
    scratchReset();
    const need = num(callWith(0, 0));
    if (!need) return new Uint8Array(0);
    const ptr = scratchAlloc(need);
    const wrote = num(callWith(ptr, need));
    if (wrote > need) return new Uint8Array(0); // grew between calls (shouldn't happen)
    return u8().slice(ptr, ptr + need);
  }

  return {
    raw: ex,
    memory: mem,

    newWorld(seed, arenaHalf, asteroids) {
      return num(ex.sim_new(BigInt(Math.floor(seed) >>> 0), arenaHalf, asteroids >>> 0));
    },

    spawnShip(handle, controller, x, y, angle) {
      return num(ex.sim_spawn_ship(handle, controller >>> 0, x, y, angle));
    },

    applyInput(handle, srcBytes) {
      scratchReset();
      const { ptr, len } = writeBytes(srcBytes);
      return num(ex.apply_input(handle, ptr, len)) === 1;
    },

    step(handle) {
      return num(ex.step(handle));
    },

    snapshotFull(handle) {
      return readSnapshot((out, cap) => ex.snapshot_full(handle, out, cap));
    },

    snapshotAoi(handle, x, y, r) {
      return readSnapshot((out, cap) => ex.snapshot_aoi(handle, x, y, r, out, cap));
    },

    restore(handle, srcBytes) {
      scratchReset();
      const { ptr, len } = writeBytes(srcBytes);
      return num(ex.restore(handle, ptr, len)) === 1;
    },

    entityCount(handle) {
      return num(ex.sim_entity_count(handle));
    },

    tick(handle) {
      return num(ex.sim_tick(handle));
    },

    free(handle) {
      if (handle) ex.sim_free(handle);
    },
  };
}

export default { loadSimHost };
