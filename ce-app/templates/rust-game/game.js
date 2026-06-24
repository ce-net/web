// rust-game frontend — wires the Rust->wasm authoritative backend to CE netgame
// (host election + tick + /db snapshot failover) and renders with WebGPU, with a
// canvas-2D fallback. Zero build deps beyond the wasm module itself.
//
// Data flow:
//   - netgame elects ONE host. On the host, every tick we run the wasm `ce_tick`,
//     read the authoritative position via `ce_x/ce_y/ce_score`, and return a tiny
//     plain-object state (which netgame broadcasts + snapshots to /db as JSON).
//   - The snapshot we persist is the wasm `ce_snapshot` byte buffer (base64), so a
//     NEW host can `ce_restore` the exact world after a failover — no drift.
//   - Every client renders from the latest authoritative state it receives.

import { createGame } from "./netgame.js";

// ---- input bitset (mirror of the Rust `input` module) --------------------------------
const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8, FIRE = 16;

const keys = new Set();
let touchVec = null; // {dx,dy} when dragging

addEventListener("keydown", (e) => {
  const k = mapKey(e.key);
  if (k) {
    keys.add(k);
    e.preventDefault();
  }
});
addEventListener("keyup", (e) => {
  const k = mapKey(e.key);
  if (k) keys.delete(k);
});
function mapKey(key) {
  switch (key) {
    case "w": case "W": case "ArrowUp": return UP;
    case "s": case "S": case "ArrowDown": return DOWN;
    case "a": case "A": case "ArrowLeft": return LEFT;
    case "d": case "D": case "ArrowRight": return RIGHT;
    case " ": return FIRE;
    default: return 0;
  }
}

function currentInput() {
  let bits = 0;
  for (const k of keys) bits |= k;
  if (touchVec) {
    if (touchVec.dy < -0.08) bits |= UP;
    if (touchVec.dy > 0.08) bits |= DOWN;
    if (touchVec.dx < -0.08) bits |= LEFT;
    if (touchVec.dx > 0.08) bits |= RIGHT;
  }
  return bits;
}

// ---- load the Rust->wasm authoritative module ----------------------------------------
// We support both build variants: wasm-pack (ESM glue in ./pkg) and raw cargo
// (a bare ./app.wasm with no glue). The wasm exports a raw C ABI either way.
async function loadWasm() {
  // (a) wasm-pack: ./pkg/<crate>.js exports a default init() returning the instance.
  for (const crate of ["rust_game", "rust_backend"]) {
    try {
      const mod = await import(`./pkg/${crate}.js`);
      if (mod && typeof mod.default === "function") {
        const inst = await mod.default();
        // wasm-pack's init returns the wasm exports object (with our ce_* funcs).
        const exports = inst && inst.ce_tick ? inst : mod.__wasm || mod;
        if (exports && exports.ce_tick) return wrap(exports, exports.memory);
        // newer wasm-pack: functions are re-exported on the module namespace.
        if (mod.ce_tick) return wrap(mod, mod.memory || (inst && inst.memory));
      }
    } catch (_) {
      /* try next */
    }
  }
  // (b) raw cargo: instantiate ./app.wasm directly.
  try {
    const res = await fetch("./app.wasm");
    if (res.ok) {
      const { instance } = await WebAssembly.instantiateStreaming(res, {});
      if (instance.exports && instance.exports.ce_tick) {
        return wrap(instance.exports, instance.exports.memory);
      }
    }
  } catch (_) {
    /* fall through to error */
  }
  throw new Error(
    "could not load the wasm module (looked for ./pkg/<crate>.js and ./app.wasm)"
  );
}

// Wrap the raw exports into a friendly object; handle snapshot/restore over memory.
function wrap(ex, memory) {
  return {
    init: () => ex.ce_init(),
    tick: (dt, input) => ex.ce_tick(dt, input),
    x: () => ex.ce_x(),
    y: () => ex.ce_y(),
    score: () => ex.ce_score() >>> 0,
    tickNum: () => Number(ex.ce_current_tick()),
    snapshot() {
      const len = ex.ce_snapshot_len() >>> 0;
      const ptr = ex.ce_snapshot_ptr() >>> 0;
      const bytes = new Uint8Array(memory.buffer, ptr, len).slice();
      return b64encode(bytes);
    },
    restore(b64) {
      if (!b64) return false;
      const bytes = b64decode(b64);
      const ptr = ex.ce_scratch_ptr(bytes.length) >>> 0;
      new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
      return ex.ce_restore(bytes.length) === 1;
    },
  };
}

function b64encode(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64decode(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ---- renderer: WebGPU with a canvas-2D fallback --------------------------------------
function makeRenderer(canvas) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  function resize() {
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
  }
  resize();
  addEventListener("resize", resize);

  // 2D fallback (always available; WebGPU upgrade is optional below).
  const ctx = canvas.getContext("2d");
  let name = "canvas2d";

  // Try to spin up a tiny WebGPU pass that clears + draws a quad at (x,y). If
  // anything fails we silently keep the 2D path — both render the same scene.
  let gpu = null;
  async function tryWebGPU() {
    if (!navigator.gpu) return;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return;
      const device = await adapter.requestDevice();
      const gctx = canvas.getContext("webgpu");
      if (!gctx) return;
      const format = navigator.gpu.getPreferredCanvasFormat();
      gctx.configure({ device, format, alphaMode: "opaque" });
      const shader = device.createShaderModule({
        code: `
          struct U { pos: vec2<f32>, };
          @group(0) @binding(0) var<uniform> u: U;
          @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
            // a small quad around the authoritative position, in clip space
            let s = 0.045;
            var corners = array<vec2<f32>, 6>(
              vec2(-1.0,-1.0), vec2( 1.0,-1.0), vec2(-1.0, 1.0),
              vec2(-1.0, 1.0), vec2( 1.0,-1.0), vec2( 1.0, 1.0));
            let c = corners[i] * s;
            // map unit [0,1] world to clip [-1,1], flip Y for screen-down
            let p = vec2(u.pos.x * 2.0 - 1.0, 1.0 - u.pos.y * 2.0);
            return vec4(p + c, 0.0, 1.0);
          }
          @fragment fn fs() -> @location(0) vec4<f32> { return vec4(0.216, 0.776, 1.0, 1.0); }
        `,
      });
      const ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs" },
        fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: ubuf } }],
      });
      gpu = { device, gctx, pipeline, bind, ubuf };
      name = "webgpu";
    } catch (_) {
      gpu = null;
    }
  }
  const ready = tryWebGPU();

  return {
    rendererName: () => name,
    ready,
    draw(x, y) {
      if (gpu) {
        const { device, gctx, pipeline, bind, ubuf } = gpu;
        device.queue.writeBuffer(ubuf, 0, new Float32Array([x, y, 0, 0]));
        const enc = device.createCommandEncoder();
        const view = gctx.getCurrentTexture().createView();
        const pass = enc.beginRenderPass({
          colorAttachments: [{ view, clearValue: { r: 0.027, g: 0.05, b: 0.094, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(6);
        pass.end();
        device.queue.submit([enc.finish()]);
        return;
      }
      // 2D fallback
      const W = canvas.width, H = canvas.height;
      ctx.fillStyle = "#070d18";
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(120,170,255,.12)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 10; i++) {
        ctx.beginPath(); ctx.moveTo((W / 10) * i, 0); ctx.lineTo((W / 10) * i, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, (H / 10) * i); ctx.lineTo(W, (H / 10) * i); ctx.stroke();
      }
      const r = Math.min(W, H) * 0.03;
      ctx.fillStyle = "#37c6ff";
      ctx.beginPath();
      ctx.arc(x * W, y * H, r, 0, Math.PI * 2);
      ctx.fill();
    },
  };
}

// ---- boot ----------------------------------------------------------------------------
const canvas = document.getElementById("canvas");
const el = (id) => document.getElementById(id);

// touch input -> a normalized drag vector from screen center
let touchStart = null;
canvas.addEventListener("pointerdown", (e) => { touchStart = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointermove", (e) => {
  if (!touchStart) return;
  touchVec = { dx: (e.clientX - touchStart.x) / 80, dy: (e.clientY - touchStart.y) / 80 };
});
addEventListener("pointerup", () => { touchStart = null; touchVec = null; });

(async function main() {
  let wasm;
  try {
    wasm = await loadWasm();
  } catch (e) {
    el("errmsg").textContent =
      "rustup target add wasm32-unknown-unknown\n" +
      "wasm-pack build --release --target web   # -> ./pkg\n\n" +
      "(" + (e && e.message ? e.message : e) + ")";
    el("err").style.display = "grid";
    return;
  }
  wasm.init();

  const renderer = makeRenderer(canvas);
  await renderer.ready;

  // latest authoritative position for rendering (client-side mirror)
  let view = { x: 0.5, y: 0.5, score: 0, tick: 0 };

  const game = createGame({
    app: "rust-game",
    room: "g1",
    hz: 30,
    snapshotEvery: 30,
    // The host's authoritative state IS the wasm snapshot (base64). We keep it in
    // the netgame state object so /db failover restores the exact world.
    init: () => {
      wasm.init();
      return { snap: wasm.snapshot(), x: wasm.x(), y: wasm.y(), score: wasm.score(), tick: wasm.tickNum() };
    },
    // Runs only on the elected host. Restore (in case we just took over), apply
    // each peer's input through the deterministic wasm tick, re-snapshot.
    tick: (s, inputs, dt) => {
      if (s && s.snap) wasm.restore(s.snap);
      // Combine all live inputs (simple co-op: any player can drive the ship).
      let bits = 0;
      for (const id in inputs) bits |= (inputs[id] | 0);
      wasm.tick(dt, bits);
      return { snap: wasm.snapshot(), x: wasm.x(), y: wasm.y(), score: wasm.score(), tick: wasm.tickNum() };
    },
    input: () => currentInput(),
    onState: (s, meta) => {
      if (s) view = { x: s.x ?? view.x, y: s.y ?? view.y, score: s.score ?? 0, tick: s.tick ?? 0 };
      el("host").textContent = meta.isHost ? "you (host)" : meta.hostShort || "—";
      el("dot").className = "dot " + (meta.isHost ? "me" : meta.online ? "on" : "");
      el("players").textContent = String(game.players().length);
      el("tick").textContent = String(view.tick);
      el("score").textContent = String(view.score);
    },
  });

  el("renderer").textContent = renderer.rendererName();

  // render loop decoupled from the network tick for smoothness
  function frame() {
    renderer.draw(view.x, view.y);
    el("renderer").textContent = renderer.rendererName();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  addEventListener("beforeunload", () => game.leave());
})();
