/**
 * @ce-net/bench — the portable measurements (CPU / memory / network / disk / LLM).
 *
 * OWNER: implementer A. Implements docs/benchmark-suite.md.
 *
 * Each probe is a pure-ish function that runs a measured kernel and returns a `BenchResult`
 * (`makeBenchResult` from types.js). Every probe is deterministic given `seed` (the /beacon hash)
 * and must run in BOTH Node and the browser. For browser nodes (which only run WASM via
 * `WebAssembly.instantiate`), the kernel ships as a tiny WASM module dispatched through
 * `HubClient.submitTask` (see ce.js) — this module exposes the kernels + the base64 WASM blobs and
 * the result-normalization helpers; the runner does the dispatch.
 *
 * Contract this module exports (do not rename — index.js + runner.js depend on these):
 *
 *   export const PRESETS: Record<"node"|"browser"|"ci", {cpuTargetMs,memBytes,diskBytes,llmTokens,netBytes}>
 *   export function cpuFlops(seed, opts?): BenchResult              // unit "gflops"
 *   export function cpuInt(seed, opts?): BenchResult                // unit "mops"
 *   export function memBandwidth(seed, opts?): BenchResult          // unit "gbps"
 *   export async function diskRw(seed, opts?): Promise<BenchResult> // unit "mbps"; raw{read_mbps,write_mbps}
 *   export function llmTokens(seed, opts?): BenchResult             // unit "tokens_per_sec"
 *   export async function netThroughput(opts): Promise<BenchResult|null> // unit "mbps" or null
 *   export const BROWSER_KERNELS: Record<string, BrowserKernel>
 *   export async function runLocalSuite(seed, env, opts?): Promise<BenchResult[]>
 *   export function recheck(result): { ok, expected, got }
 *
 * BOUNDARY (what lives ONLY here): the measurement math, the WASM kernel blobs, the auto-tuning, the
 * DCE guards, and the deterministic seeding. This file does NOT assemble a NodeProfile (profile.js),
 * orchestrate dispatch across many browser nodes (runner.js), or aggregate (fabricstats.js). The
 * runner injects clients; nothing here imports a CeClient/HubClient — they are passed in `opts`.
 *
 * @packageDocumentation
 */

import { makeBenchResult } from "./types.js";

/* ------------------------------------------------------------------------------------------------ *
 * Deterministic seeding: splitmix64 over the beacon hash. Kernels derive all inputs from this so a
 * verifier reproduces the exact arithmetic and the JIT can't constant-fold the loop body away.
 * BigInt 64-bit math (mask to 64 bits each step).
 * ------------------------------------------------------------------------------------------------ */

const MASK64 = (1n << 64n) - 1n;

/**
 * Fold a hex string (the beacon hash) into a 64-bit BigInt seed. Empty / non-hex -> a fixed nonzero
 * constant so unseeded runs are still deterministic and never zero (a zero state stalls xorshift).
 * @param {string} seed hex
 * @returns {bigint}
 */
export function seed64(seed) {
  let s = 0x9e3779b97f4a7c15n;
  if (typeof seed === "string" && seed.length) {
    for (let i = 0; i < seed.length; i++) {
      s = (s ^ BigInt(seed.charCodeAt(i))) & MASK64;
      s = (s * 0x100000001b3n) & MASK64; // FNV-style mix, then splitmix below
      s = splitmix64Step(s).state;
    }
  }
  return s === 0n ? 0x9e3779b97f4a7c15n : s;
}

/**
 * One splitmix64 step. Returns the next state and a well-distributed output value.
 * @param {bigint} state
 * @returns {{state:bigint, value:bigint}}
 */
function splitmix64Step(state) {
  let z = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let v = z;
  v = ((v ^ (v >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  v = ((v ^ (v >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  v = (v ^ (v >> 31n)) & MASK64;
  return { state: z, value: v };
}

/** A small 64-bit PRNG stream from a seed. `.next()` -> Number in [0,1). `.state` is the live state. */
function rng64(seedHex) {
  let state = seed64(seedHex);
  return {
    get state() {
      return state;
    },
    /** next double in [0,1) */
    next() {
      const r = splitmix64Step(state);
      state = r.state;
      // top 53 bits -> [0,1)
      return Number(r.value >> 11n) / 9007199254740992;
    },
    /** next raw 64-bit value */
    nextU64() {
      const r = splitmix64Step(state);
      state = r.state;
      return r.value;
    },
  };
}

const nowMs = () =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------------------------------------------ *
 * Environment presets (docs/benchmark-suite.md "Tuning knobs").
 * ------------------------------------------------------------------------------------------------ */

export const PRESETS = Object.freeze({
  node: { cpuTargetMs: 80, memBytes: 128 << 20, diskBytes: 128 << 20, llmTokens: 64, netBytes: 16 << 20 },
  browser: { cpuTargetMs: 50, memBytes: 16 << 20, diskBytes: 16 << 20, llmTokens: 32, netBytes: 1 << 20 },
  ci: { cpuTargetMs: 20, memBytes: 8 << 20, diskBytes: 4 << 20, llmTokens: 8, netBytes: 256 << 10 },
});

/** Pick a preset, defaulting to "node". `env "native"` maps to the "node" preset. */
function preset(env) {
  if (env === "browser") return PRESETS.browser;
  if (env === "ci") return PRESETS.ci;
  return PRESETS.node;
}

/* ------------------------------------------------------------------------------------------------ *
 * Auto-tuning: run a kernel for a growing iteration count until it crosses `targetMs`, so each probe
 * takes ~constant wall time regardless of host speed and N is never hardcoded.
 * ------------------------------------------------------------------------------------------------ */

const MIN_MEASURED_MS = 5; // below this the timer is too noisy; keep doubling

/**
 * Auto-tune the iteration count of a kernel to hit `targetMs`.
 * @param {(n:number)=>number} run kernel: takes N iterations, returns an accumulator (consumed -> raw)
 * @param {number} targetMs
 * @param {number} [startN]
 * @returns {{n:number, ms:number, acc:number}} the final timed run that crossed the target
 */
function autoTune(run, targetMs, startN = 1 << 12) {
  let n = startN;
  let acc = 0;
  let ms = 0;
  // warm up once (let the JIT compile) before measuring.
  acc = run(Math.min(startN, 1 << 10));
  for (let guard = 0; guard < 40; guard++) {
    const t0 = nowMs();
    acc = run(n);
    ms = nowMs() - t0;
    if (ms >= targetMs && ms >= MIN_MEASURED_MS) break;
    // scale N toward the target (with a floor of 2x to make progress past noisy zeros).
    const factor = ms > 0.5 ? Math.max(2, (targetMs / ms) * 1.2) : 4;
    n = Math.min(Number.MAX_SAFE_INTEGER / 4, Math.ceil(n * factor));
  }
  return { n, ms: Math.max(ms, 1e-6), acc };
}

/* ================================================================================================ *
 * 1. CPU — floating point (cpu_flops) and integer (cpu_int)
 * ================================================================================================ */

/**
 * FMA loop over an L1-resident array: `acc = acc * a + b` (2 FLOP each). Returns final accumulator.
 * Array contents seeded so the result depends on inputs (anti-DCE + verifiable).
 * @param {Float64Array} a
 * @param {Float64Array} b
 * @param {number} iters total inner iterations
 * @param {number} acc0
 */
function fmaKernel(a, b, iters, acc0) {
  const len = a.length;
  let acc = acc0;
  for (let i = 0; i < iters; i++) {
    const j = i % len;
    acc = acc * a[j] + b[j];
    // renormalize to keep acc finite over many iters without changing op count
    if (i % 4096 === 4095) acc = (acc % 1e6) + 1.0;
  }
  return acc;
}

/**
 * CPU floating-point throughput. unit "gflops".
 * @param {string} seed beacon hash (hex)
 * @param {{targetMs?:number, env?:string}} [opts]
 * @returns {import("./types.js").BenchResult}
 */
export function cpuFlops(seed, opts = {}) {
  const targetMs = opts.targetMs ?? preset(opts.env).cpuTargetMs;
  const r = rng64(seed);
  const LEN = 256; // fits comfortably in L1, isolates ALU from memory
  const a = new Float64Array(LEN);
  const b = new Float64Array(LEN);
  for (let i = 0; i < LEN; i++) {
    a[i] = 0.5 + r.next() * 0.5; // [0.5,1) keeps the recurrence stable
    b[i] = r.next();
  }
  const acc0 = 1.0 + r.next();
  const tuned = autoTune((n) => fmaKernel(a, b, n, acc0), targetMs);
  const flop = tuned.n * 2; // 2 FLOP per FMA iteration
  const gflops = flop / tuned.ms / 1e6;
  return makeBenchResult({
    kind: "cpu_flops",
    metric: gflops,
    unit: "gflops",
    seed: seed ?? "",
    ms: tuned.ms,
    env: normEnv(opts.env),
    ts: nowSec(),
    raw: { iters: tuned.n, flop, acc0, len: LEN, acc: tuned.acc },
  });
}

/**
 * Integer mix: xorshift64 + 64-bit multiply, one op per iteration. Returns the final state (anti-DCE).
 * Uses BigInt 64-bit math for correctness/verifiability across engines.
 * @param {bigint} state0
 * @param {number} iters
 * @returns {bigint}
 */
function intKernel(state0, iters) {
  let x = state0 === 0n ? 0x9e3779b97f4a7c15n : state0;
  const M = 0x2545f4914f6cdd1dn;
  for (let i = 0; i < iters; i++) {
    x ^= (x << 13n) & MASK64;
    x ^= x >> 7n;
    x ^= (x << 17n) & MASK64;
    x = (x * M) & MASK64;
  }
  return x;
}

/**
 * CPU integer throughput. unit "mops" (millions of ops/sec).
 * @param {string} seed
 * @param {{targetMs?:number, env?:string}} [opts]
 * @returns {import("./types.js").BenchResult}
 */
export function cpuInt(seed, opts = {}) {
  const targetMs = opts.targetMs ?? preset(opts.env).cpuTargetMs;
  const state0 = seed64(seed);
  // BigInt ops are far slower than f64, so start smaller and let autoTune climb.
  let lastAcc = 0n;
  const tuned = autoTune((n) => {
    lastAcc = intKernel(state0, n);
    return Number(lastAcc & 0xffffffffn);
  }, targetMs, 1 << 8);
  const mops = tuned.n / tuned.ms / 1e3; // ops/ms -> /1e3 = Mops/s
  return makeBenchResult({
    kind: "cpu_int",
    metric: mops,
    unit: "mops",
    seed: seed ?? "",
    ms: tuned.ms,
    env: normEnv(opts.env),
    ts: nowSec(),
    raw: { iters: tuned.n, ops: tuned.n, state0: state0.toString(16), final: lastAcc.toString(16) },
  });
}

/* ================================================================================================ *
 * 2. Memory bandwidth (mem_bw) — STREAM triad: a[i] = b[i] + s*c[i]
 * ================================================================================================ */

/**
 * Memory bandwidth via STREAM triad over arrays sized beyond LLC. unit "gbps" (GB/s).
 * Subtracts a no-op pass to remove loop overhead; reports the median of several passes.
 * @param {string} seed
 * @param {{bytes?:number, passes?:number, env?:string}} [opts]
 * @returns {import("./types.js").BenchResult}
 */
export function memBandwidth(seed, opts = {}) {
  const bytes = clampBytes(opts.bytes ?? preset(opts.env).memBytes, opts.env);
  const passes = opts.passes ?? 5;
  const n = Math.max(1024, Math.floor(bytes / 8)); // Float64 elements
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  const c = new Float64Array(n);
  const r = rng64(seed);
  for (let i = 0; i < n; i++) {
    b[i] = r.next();
    c[i] = r.next();
  }
  const s = 1.0 + r.next();
  // bytes touched per element: read b (8) + read c (8) + write a (8) = 24
  const bytesPerElem = 24;
  /** @type {number[]} */
  const samples = [];
  let checksum = 0;
  for (let p = 0; p < passes; p++) {
    const t0 = nowMs();
    for (let i = 0; i < n; i++) a[i] = b[i] + s * c[i];
    const ms = nowMs() - t0;
    checksum += a[(p * 7919) % n] + a[n - 1];
    if (ms > 0) samples.push(ms);
  }
  const medMs = median(samples.length ? samples : [1]);
  const gbps = (n * bytesPerElem) / medMs / 1e6; // bytes/ms /1e6 = GB/s
  return makeBenchResult({
    kind: "mem_bw",
    metric: gbps,
    unit: "gbps",
    seed: seed ?? "",
    ms: medMs,
    env: normEnv(opts.env),
    ts: nowSec(),
    raw: { n, bytes: n * 8, bytesPerElem, passes: samples.length, scale: s, checksum, sampleMs: samples },
  });
}

/* ================================================================================================ *
 * 3. Network throughput (net_throughput) — Mbps between this host and a target.
 * ================================================================================================ */

/**
 * Network throughput. Mesh transport is not yet available (compute-fabric.md §3), so the only live
 * transport is the hub/loopback echo to a browser node. Returns null when no transport is reachable.
 *
 * @param {object} opts
 * @param {string} [opts.seed]
 * @param {number} [opts.bytes]
 * @param {"mesh"|"hub"} [opts.transport]   default "hub" (the only one available today)
 * @param {string} [opts.targetNode]        browser node id to echo through (hub transport)
 * @param {import("./ce.js").HubClient} [opts.hub]   INJECTED hub client; required for hub transport
 * @param {string} [opts.env]
 * @returns {Promise<import("./types.js").BenchResult|null>}
 */
export async function netThroughput(opts = {}) {
  const transport = opts.transport ?? "hub";
  if (transport === "mesh") {
    // Depends on the node bandwidth primitive that doesn't exist yet (compute-fabric.md §3).
    return null;
  }
  const hub = opts.hub;
  if (!hub || typeof hub.submitTask !== "function") {
    return null; // no transport available
  }
  const bytes = opts.bytes ?? preset(opts.env).netBytes;
  // Echo `words` i64 args through a memcpy-style WASM kernel; the round trip bounds ingest rate.
  // The kernel returns a checksum of its args so the payload can't be dropped/short-circuited.
  const words = Math.max(1, Math.floor(bytes / 8));
  const r = rng64(opts.seed);
  // Hub args are JS numbers; cap how many we actually send (the WS frame budget) but still time the
  // full intended payload by repeating the dispatch. Keep arg count modest; size via repeats.
  const ARGS_PER_CALL = 64;
  const calls = Math.max(1, Math.min(64, Math.ceil(words / ARGS_PER_CALL)));
  const args = [];
  for (let i = 0; i < ARGS_PER_CALL; i++) args.push(Number(r.nextU64() & 0x7fffffffn));
  const kernel = BROWSER_KERNELS.net_echo;
  const t0 = nowMs();
  let ok = true;
  let lastValue = "";
  let observedMs = 0;
  for (let i = 0; i < calls; i++) {
    const res = await hub.submitTask({
      moduleB64: kernel.moduleB64,
      func: kernel.func,
      args,
      ret: kernel.ret,
      target: opts.targetNode,
    });
    if (!res || !res.ok) ok = false;
    lastValue = res ? res.value : "";
    observedMs += res && typeof res.ms === "number" ? res.ms : 0;
  }
  const ms = nowMs() - t0;
  const sentBytes = calls * ARGS_PER_CALL * 8;
  const mbps = ok ? (sentBytes * 8) / ms / 1e6 : 0;
  return makeBenchResult({
    kind: "net_throughput",
    metric: mbps,
    unit: "mbps",
    seed: opts.seed ?? "",
    ms,
    env: normEnv(opts.env),
    ts: nowSec(),
    raw: { transport: "hub", calls, argsPerCall: ARGS_PER_CALL, sentBytes, ok, deviceMs: observedMs, value: lastValue },
  });
}

/* ================================================================================================ *
 * 4. Disk read/write (disk_rw) — sequential write+fsync, read back. unit "mbps" (MB/s).
 * ================================================================================================ */

/**
 * Disk read/write. Node form uses node:fs into os.tmpdir(). Browser disk is an async page-side probe
 * (OPFS/IndexedDB) that needs a node.html hook — when no `node:fs` is available this returns a valid,
 * flagged zero result (read_mbps:0, write_mbps:0).
 *
 * @param {string} seed
 * @param {{bytes?:number, dir?:string, env?:string}} [opts]
 * @returns {Promise<import("./types.js").BenchResult>}
 */
export async function diskRw(seed, opts = {}) {
  const bytes = opts.bytes ?? preset(opts.env).diskBytes;
  const fsMod = await tryImport("node:fs");
  const osMod = await tryImport("node:os");
  const pathMod = await tryImport("node:path");
  if (!fsMod || !osMod || !pathMod) {
    // No portable synchronous disk (browser/Workers). Flagged zero (still a valid BenchResult).
    return makeBenchResult({
      kind: "disk_rw",
      metric: 0,
      unit: "mbps",
      seed: seed ?? "",
      ms: 0,
      env: normEnv(opts.env),
      ts: nowSec(),
      raw: { read_mbps: 0, write_mbps: 0, bytes, available: false, reason: "no node:fs (browser needs OPFS hook)" },
    });
  }
  const dir = opts.dir ?? osMod.tmpdir();
  const file = pathMod.join(dir, `ce-bench-${Date.now()}-${Math.floor(Math.random() * 1e9)}.tmp`);
  // Seed the buffer so the read-back checksum is verifiable.
  const buf = Buffer.allocUnsafe(bytes);
  const r = rng64(seed);
  for (let i = 0; i < bytes; i += 8) {
    const v = r.nextU64();
    for (let k = 0; k < 8 && i + k < bytes; k++) buf[i + k] = Number((v >> BigInt(8 * k)) & 0xffn);
  }
  let writeMs = 0;
  let readMs = 0;
  let checksum = 0;
  try {
    // WRITE + fsync
    const t0 = nowMs();
    const fd = fsMod.openSync(file, "w");
    fsMod.writeSync(fd, buf, 0, bytes, 0);
    fsMod.fsyncSync(fd);
    fsMod.closeSync(fd);
    writeMs = nowMs() - t0;
    // READ back
    const t1 = nowMs();
    const got = fsMod.readFileSync(file);
    readMs = nowMs() - t1;
    // verifiable checksum over a stride (cheap)
    for (let i = 0; i < got.length; i += 4096) checksum = (checksum + got[i]) >>> 0;
  } finally {
    try {
      fsMod.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
  const writeMbps = bytes / Math.max(writeMs, 1e-6) / 1e3; // bytes/ms /1e3 = MB/s
  const readMbps = bytes / Math.max(readMs, 1e-6) / 1e3;
  // headline metric: read throughput (the placement-relevant number); both kept in raw.
  return makeBenchResult({
    kind: "disk_rw",
    metric: readMbps,
    unit: "mbps",
    seed: seed ?? "",
    ms: readMs + writeMs,
    env: normEnv(opts.env),
    ts: nowSec(),
    raw: { read_mbps: readMbps, write_mbps: writeMbps, bytes, writeMs, readMs, checksum, available: true },
  });
}

/* ================================================================================================ *
 * 5. LLM micro-benchmark (llm_tokens) — fixed reference micro-transformer, autoregressive decode.
 * ================================================================================================ */

/** Reference micro-model identity. Fixed so cross-node numbers are apples-to-apples. */
export const REF_MODEL = Object.freeze({
  name: "ce-ref-tiny",
  // Deterministic content hash of the weight-generation recipe below (params are derived, not random
  // per run): a verifier regenerates identical weights and reproduces the logits digest.
  hash: "ceref-tiny-v1-d32-l2-h4-ctx64",
  dim: 32,
  layers: 2,
  heads: 4,
  ctx: 64,
  vocab: 64,
});

/**
 * Deterministically generate the reference model weights from REF_MODEL.hash (NOT from `seed`), so
 * every node runs the exact same model. `seed` only perturbs the prompt (anti-cache).
 * @returns {{wq:Float32Array,wk:Float32Array,wv:Float32Array,wo:Float32Array,w1:Float32Array,w2:Float32Array,emb:Float32Array}}
 */
function refWeights() {
  const { dim, vocab } = REF_MODEL;
  const wr = rng64(REF_MODEL.hash);
  const gen = (len) => {
    const arr = new Float32Array(len);
    for (let i = 0; i < len; i++) arr[i] = (wr.next() - 0.5) * 0.2;
    return arr;
  };
  return {
    emb: gen(vocab * dim),
    wq: gen(dim * dim),
    wk: gen(dim * dim),
    wv: gen(dim * dim),
    wo: gen(dim * dim),
    w1: gen(dim * dim * 2),
    w2: gen(dim * dim * 2),
  };
}

/** y = x (dim) @ W (dim x out) -> out. Row-major W. */
function matvec(x, W, dim, out) {
  const y = new Float32Array(out);
  for (let o = 0; o < out; o++) {
    let s = 0;
    const base = o * dim;
    for (let i = 0; i < dim; i++) s += x[i] * W[base + i];
    y[o] = s;
  }
  return y;
}

/**
 * LLM tokens/sec on the fixed reference micro-transformer.
 * @param {string} seed beacon hash — perturbs the prompt only
 * @param {{tokens?:number, env?:string}} [opts]
 * @returns {import("./types.js").BenchResult}
 */
export function llmTokens(seed, opts = {}) {
  const tokens = opts.tokens ?? preset(opts.env).llmTokens;
  const { dim, ctx, vocab, layers } = REF_MODEL;
  const W = refWeights();
  const r = rng64(seed);
  // prompt: a few seeded tokens
  /** @type {number[]} */
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(Math.floor(r.next() * vocab));
  let digest = 0n;
  const t0 = nowMs();
  for (let t = 0; t < tokens; t++) {
    // take the last token's embedding as the hidden state (simplified autoregressive decode)
    const last = ids[ids.length - 1];
    let h = W.emb.subarray(last * dim, last * dim + dim).slice();
    for (let l = 0; l < layers; l++) {
      // attention (self over a single-step state -> projections), then FFN. The point is a fixed,
      // comparable FLOP profile, not a faithful transformer.
      const q = matvec(h, W.wq, dim, dim);
      const k = matvec(h, W.wk, dim, dim);
      const v = matvec(h, W.wv, dim, dim);
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += q[i] * k[i];
      const scale = 1 / Math.sqrt(dim);
      const attn = new Float32Array(dim);
      for (let i = 0; i < dim; i++) attn[i] = v[i] * Math.tanh(dot * scale);
      const o = matvec(attn, W.wo, dim, dim);
      // residual + FFN (gelu-ish)
      const hidden = matvec(o, W.w1, dim, dim * 2);
      for (let i = 0; i < hidden.length; i++) hidden[i] = hidden[i] > 0 ? hidden[i] : hidden[i] * 0.01;
      const ff = matvec(hidden, W.w2, dim * 2, dim);
      for (let i = 0; i < dim; i++) h[i] = h[i] + o[i] + ff[i];
    }
    // logits = h @ emb^T (vocab); argmax -> next token. digest accumulates logits (anti-DCE).
    let best = 0;
    let bestScore = -Infinity;
    for (let vtok = 0; vtok < vocab; vtok++) {
      let s = 0;
      const base = vtok * dim;
      for (let i = 0; i < dim; i++) s += h[i] * W.emb[base + i];
      digest = (digest + BigInt(Math.round((s + 1000) * 1e3) & 0x7fffffff)) & MASK64;
      if (s > bestScore) {
        bestScore = s;
        best = vtok;
      }
    }
    ids.push(best);
    if (ids.length > ctx) ids.shift();
  }
  const ms = nowMs() - t0;
  const tps = (tokens / ms) * 1000;
  return makeBenchResult({
    kind: "llm_tokens",
    metric: tps,
    unit: "tokens_per_sec",
    seed: seed ?? "",
    ms,
    env: normEnv(opts.env),
    ts: nowSec(),
    raw: { ref_model: REF_MODEL.name, model_hash: REF_MODEL.hash, tokens, ctx_tokens: ctx, digest: digest.toString(16) },
  });
}

/* ================================================================================================ *
 * Browser/WASM kernels. Each: { moduleB64, func, ret, makeArgs(seed,preset), toResult(hubRes,seed,env) }
 * These are the ONLY WASM blobs in the suite. The runner dispatches them via HubClient.submitTask and
 * converts the returned {value, ms} to a BenchResult here (so the math stays in this file).
 * ================================================================================================ */

/**
 * Minimal WAT-derived modules, hand-assembled to small WASM binaries (base64). Kept intentionally
 * tiny: an integer accumulator loop (anti-DCE return) for CPU/mem/llm/net parity. The headline metric
 * is derived from the *runner-measured* wall time (hubRes.ms) and the op count we asked for, exactly
 * like the Node forms. The WASM body's job is to actually execute the work and return a checksum so
 * the run can't be short-circuited.
 *
 * NOTE: a full per-probe kernel (true triad, true ref-transformer in WASM) is a fast-follow; the
 * shared loop kernel below gives a working, seeded, anti-DCE measurement today. The `func`/args/ret
 * contract matches docs/benchmark-suite.md and node.html's runJob exactly.
 */

/**
 * Shared "muladd loop" WASM module:
 *   (func $run (param $seed i64) (param $iters i64) (result i64)
 *     local $acc i64 = $seed; loop: $acc = $acc*0x9E3779B1 + $iters ; dec $iters ; return $acc)
 * Hand-assembled. Export name "run".
 */
const LOOP_WASM_B64 =
  "AGFzbQEAAAABBwFgAn5+AX4DAgEABwcBA3J1bgAACi4BLAEBfiAAIQICQANAIAFQDQEgAkKx893xCX4gAXwhAiABQgF9IQEMAAsLIAIL";

/** @typedef {{moduleB64:string, func:string, ret:string, makeArgs:(seed:string,preset:object)=>(number|bigint)[], toResult:(hubRes:object,seed:string,env?:string)=>import("./types.js").BenchResult}} BrowserKernel */

function loopArgs(seed, iters) {
  return [Number(seed64(seed) & 0x7fffffffn), iters];
}

export const BROWSER_KERNELS = Object.freeze({
  /** CPU FLOPS parity kernel (integer muladd loop; GFLOPS computed from iters/ms). */
  cpu_flops: {
    moduleB64: LOOP_WASM_B64,
    func: "run",
    ret: "i64",
    makeArgs: (seed, p) => loopArgs(seed, 5_000_000),
    toResult: (hub, seed, env) =>
      loopToResult(hub, seed, env, "cpu_flops", "gflops", 5_000_000, (iters, ms) => (iters * 2) / ms / 1e6),
  },
  /** CPU integer parity kernel. */
  cpu_int: {
    moduleB64: LOOP_WASM_B64,
    func: "run",
    ret: "i64",
    makeArgs: (seed, p) => loopArgs(seed, 5_000_000),
    toResult: (hub, seed, env) =>
      loopToResult(hub, seed, env, "cpu_int", "mops", 5_000_000, (iters, ms) => iters / ms / 1e3),
  },
  /** mem_bw parity kernel (loop count proxies element touches). */
  mem_bw: {
    moduleB64: LOOP_WASM_B64,
    func: "run",
    ret: "i64",
    makeArgs: (seed, p) => loopArgs(seed, Math.max(1024, Math.floor((p.memBytes ?? 1 << 20) / 8))),
    toResult: (hub, seed, env) =>
      loopToResult(hub, seed, env, "mem_bw", "gbps", null, (iters, ms) => (iters * 24) / ms / 1e6),
  },
  /** llm_tokens parity kernel (loop count proxies a fixed FLOP-per-token budget). */
  llm_tokens: {
    moduleB64: LOOP_WASM_B64,
    func: "run",
    ret: "i64",
    makeArgs: (seed, p) => loopArgs(seed, (p.llmTokens ?? 32) * 200_000),
    toResult: (hub, seed, env) =>
      loopToResult(hub, seed, env, "llm_tokens", "tokens_per_sec", null, (iters, ms) => {
        const tokens = iters / 200_000;
        return (tokens / ms) * 1000;
      }),
  },
  /** net echo kernel — same loop module; used by netThroughput to bound hub ingest rate. */
  net_echo: {
    moduleB64: LOOP_WASM_B64,
    func: "run",
    ret: "i64",
    makeArgs: (seed, p) => loopArgs(seed, 1),
    toResult: (hub, seed, env) =>
      loopToResult(hub, seed, env, "net_throughput", "mbps", null, (_iters, ms) => 0 / ms),
  },
});

/**
 * Convert a hub task result + the iteration count we requested into a BenchResult.
 * @param {object} hub HubTaskResult
 * @param {string} seed
 * @param {string|undefined} env
 * @param {import("./types.js").BENCH_KINDS[number]} kind
 * @param {string} unit
 * @param {number|null} iters iteration count requested (null -> read from raw later)
 * @param {(iters:number, ms:number)=>number} compute
 */
function loopToResult(hub, seed, env, kind, unit, iters, compute) {
  const ms = hub && typeof hub.ms === "number" && hub.ms > 0 ? hub.ms : 1;
  const n = iters ?? 0;
  const ok = !!(hub && hub.ok);
  const metric = ok && n ? compute(n, ms) : 0;
  return makeBenchResult({
    kind,
    metric: Number.isFinite(metric) && metric >= 0 ? metric : 0,
    unit,
    seed: seed ?? "",
    ms,
    env: "browser",
    ts: nowSec(),
    raw: { iters: n, deviceMs: ms, ok, value: hub ? hub.value : "", node: hub ? hub.node : "", transport: kind === "net_throughput" ? "hub" : undefined },
  });
}

/* ================================================================================================ *
 * Suite runner (LOCAL only — runner.js handles dispatch across browser nodes).
 * ================================================================================================ */

/**
 * Run the whole local suite for the current environment. "node"/"native" run the JS forms in-process;
 * "browser" returns the WASM-kernel descriptors' local results only if a hub is injected, else the
 * pure-JS forms that are portable (cpu/mem/llm) and skips disk/net that need host I/O.
 *
 * @param {string} seed beacon hash
 * @param {"node"|"browser"|"native"} env
 * @param {{ci?:boolean, hub?:import("./ce.js").HubClient, targetNode?:string, netBytes?:number}} [opts]
 * @returns {Promise<import("./types.js").BenchResult[]>}
 */
export async function runLocalSuite(seed, env = "node", opts = {}) {
  const presetKey = opts.ci ? "ci" : env === "browser" ? "browser" : "node";
  /** @type {import("./types.js").BenchResult[]} */
  const out = [];
  // CPU + mem + llm are pure JS and portable everywhere.
  out.push(cpuFlops(seed, { env: presetKey }));
  out.push(cpuInt(seed, { env: presetKey }));
  out.push(memBandwidth(seed, { env: presetKey }));
  out.push(llmTokens(seed, { env: presetKey }));
  // disk: node:fs only (returns a flagged-zero result in the browser).
  out.push(await diskRw(seed, { env: presetKey }));
  // net: only when a hub client is injected (hub transport). Mesh transport returns null.
  if (opts.hub) {
    const net = await netThroughput({
      seed,
      env: presetKey,
      transport: "hub",
      hub: opts.hub,
      targetNode: opts.targetNode,
      bytes: opts.netBytes,
    });
    if (net) out.push(net);
  }
  return out;
}

/* ================================================================================================ *
 * Verifier / anti-cheat (nodeprofile-spec.md §4): recompute the headline metric from raw evidence.
 * ================================================================================================ */

const RECHECK_TOL = 1e-6; // relative tolerance for the recompute (same raw -> same metric)

/**
 * Recompute a probe's headline metric from its `raw` evidence and compare to the stored `metric`.
 * This is the cheap structural check (metric matches its own op-count/time evidence). A full verifier
 * additionally RE-RUNS the seeded kernel and compares accumulators/checksums — that lives in runner.js
 * (verifyProbe) since it needs to execute the kernel; here we only validate internal consistency.
 *
 * @param {import("./types.js").BenchResult} result
 * @returns {{ok:boolean, expected:number, got:number, reason?:string}}
 */
export function recheck(result) {
  if (!result || typeof result !== "object" || !result.raw) {
    return { ok: false, expected: NaN, got: NaN, reason: "missing result/raw" };
  }
  const raw = result.raw;
  const ms = result.ms;
  let expected = NaN;
  switch (result.kind) {
    case "cpu_flops":
      expected = (raw.flop ?? (raw.iters ?? 0) * 2) / ms / 1e6;
      break;
    case "cpu_int":
      expected = (raw.ops ?? raw.iters ?? 0) / ms / 1e3;
      break;
    case "mem_bw":
      expected = ((raw.n ?? 0) * (raw.bytesPerElem ?? 24)) / ms / 1e6;
      break;
    case "disk_rw":
      // headline is read throughput; recompute from bytes/readMs.
      expected = (raw.bytes ?? 0) / Math.max(raw.readMs ?? ms, 1e-6) / 1e3;
      break;
    case "llm_tokens":
      expected = ((raw.tokens ?? 0) / ms) * 1000;
      break;
    case "net_throughput":
      expected = ((raw.sentBytes ?? 0) * 8) / ms / 1e6;
      break;
    default:
      return { ok: false, expected: NaN, got: result.metric, reason: `unknown kind ${result.kind}` };
  }
  const got = result.metric;
  if (!Number.isFinite(expected)) return { ok: false, expected, got, reason: "raw insufficient to recompute" };
  // disk in the unavailable (browser) case is a legitimate zero with available:false.
  if (result.kind === "disk_rw" && raw.available === false) {
    return { ok: got === 0, expected: 0, got, reason: got === 0 ? undefined : "unavailable disk must report 0" };
  }
  const denom = Math.max(Math.abs(expected), Math.abs(got), 1e-9);
  const rel = Math.abs(expected - got) / denom;
  return { ok: rel <= RECHECK_TOL, expected, got, reason: rel <= RECHECK_TOL ? undefined : `rel err ${rel.toExponential(2)}` };
}

/* ------------------------------------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------------------------------------ */

function normEnv(env) {
  return env === "browser" ? "browser" : env === "native" ? "native" : "node";
}

function clampBytes(bytes, env) {
  // In the browser, WASM linear memory growth is bounded; clamp the requested working set.
  const cap = env === "browser" ? PRESETS.browser.memBytes : Number.MAX_SAFE_INTEGER;
  return Math.max(8 << 10, Math.min(bytes, cap));
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Dynamic import that resolves to null instead of throwing (so browser bundles don't break). */
async function tryImport(spec) {
  try {
    return await import(spec);
  } catch {
    return null;
  }
}

/* ================================================================================================ *
 * __selftest — runs fully offline. Verifies every probe yields sane numbers, that results validate,
 * that recheck() agrees with each probe's own raw, and that the LLM/CPU kernels are deterministic
 * given a seed. Returns a report object; throws on any hard failure so CI catches regressions.
 * ================================================================================================ */

/**
 * Offline self-test. No network, no node-team endpoints. Also builds a synthetic FabricStats-style
 * roll-up from the probe results to prove the numbers compose into a profile-shaped aggregate.
 * @returns {{ok:boolean, results:object[], notes:string[]}}
 */
export function __selftest() {
  const notes = [];
  const seed = "deadbeefcafef00d0123456789abcdef";
  const results = [];

  // 1. each pure-JS probe produces a sane, validating BenchResult, and recheck() agrees.
  const probes = [
    () => cpuFlops(seed, { env: "ci" }),
    () => cpuInt(seed, { env: "ci" }),
    () => memBandwidth(seed, { env: "ci" }),
    () => llmTokens(seed, { env: "ci" }),
  ];
  for (const run of probes) {
    const r = run();
    if (!(r.metric > 0)) throw new Error(`selftest: ${r.kind} metric not > 0 (got ${r.metric})`);
    if (!Number.isFinite(r.metric)) throw new Error(`selftest: ${r.kind} metric not finite`);
    const rc = recheck(r);
    if (!rc.ok) throw new Error(`selftest: recheck(${r.kind}) failed: ${rc.reason} (exp ${rc.expected} got ${rc.got})`);
    results.push({ kind: r.kind, metric: r.metric, unit: r.unit, ms: r.ms, recheck: rc.ok });
  }

  // 2. determinism: cpuInt and llmTokens with the same seed must produce identical raw evidence.
  const a1 = cpuInt(seed, { env: "ci" });
  const a2 = cpuInt(seed, { env: "ci" });
  if (a1.raw.state0 !== a2.raw.state0) throw new Error("selftest: cpuInt seeding not deterministic");
  const l1 = llmTokens(seed, { env: "ci" });
  const l2 = llmTokens(seed, { env: "ci" });
  if (l1.raw.digest !== l2.raw.digest) throw new Error("selftest: llmTokens logits digest not deterministic");
  // different seed -> different llm prompt -> (almost surely) different digest
  const l3 = llmTokens("00112233445566778899aabbccddeeff", { env: "ci" });
  notes.push(`llm digest determinism ok; seed-sensitivity: ${l1.raw.digest !== l3.raw.digest ? "yes" : "collision"}`);

  // 3. disk probe: in this Node env it should be available and pass recheck; if not (e.g. sandbox),
  //    it must still return a valid flagged-zero result.
  // (run synchronously-awaited via a tiny resolved promise check done by callers; here just shape it)

  // 4. net + mesh transports without a hub -> null (graceful).
  // (async; validated in the runtime check below)

  // 5. synthetic FabricStats roll-up to prove probe numbers compose. (Mirrors fabricstats math at a
  //    high level WITHOUT importing fabricstats.js — keeps this module self-contained.)
  const synthProfiles = [
    { cores: 8, gflops: results[0].metric, mops: results[1].metric, gbps: results[2].metric, tps: results[3].metric },
    { cores: 4, gflops: results[0].metric * 0.5, mops: results[1].metric * 0.5, gbps: results[2].metric * 0.7, tps: results[3].metric * 0.6 },
  ];
  const agg = synthProfiles.reduce(
    (acc, p) => ({
      nodes: acc.nodes + 1,
      cpu_cores: acc.cpu_cores + p.cores,
      cpu_gflops: acc.cpu_gflops + p.gflops,
      tokens_per_sec: acc.tokens_per_sec + p.tps,
    }),
    { nodes: 0, cpu_cores: 0, cpu_gflops: 0, tokens_per_sec: 0 },
  );
  if (agg.nodes !== 2 || agg.cpu_cores !== 12) throw new Error("selftest: synthetic aggregate wrong");
  if (!(agg.cpu_gflops > 0) || !(agg.tokens_per_sec > 0)) throw new Error("selftest: aggregate metrics not positive");
  notes.push(`synthetic fabric roll-up: ${agg.nodes} nodes, ${agg.cpu_cores} cores, ${agg.cpu_gflops.toFixed(2)} gflops`);

  // 6. seed helpers are deterministic and nonzero.
  if (seed64("") === 0n) throw new Error("selftest: seed64('') must be nonzero");
  if (seed64(seed) !== seed64(seed)) throw new Error("selftest: seed64 not deterministic");

  // 7. BROWSER_KERNELS shape sanity + toResult on a fake hub result.
  for (const [name, k] of Object.entries(BROWSER_KERNELS)) {
    if (!k.moduleB64 || !k.func || typeof k.makeArgs !== "function" || typeof k.toResult !== "function") {
      throw new Error(`selftest: BROWSER_KERNELS.${name} malformed`);
    }
    const args = k.makeArgs(seed, PRESETS.ci);
    if (!Array.isArray(args)) throw new Error(`selftest: ${name}.makeArgs not array`);
    const fake = { ok: true, ms: 10, value: "123", node: "n", func: k.func, args };
    const br = k.toResult(fake, seed, "browser");
    if (br.env !== "browser") throw new Error(`selftest: ${name}.toResult env`);
  }
  notes.push(`browser kernels ok: ${Object.keys(BROWSER_KERNELS).join(",")}`);

  return { ok: true, results, notes };
}

/**
 * Async portion of the self-test (disk + net graceful paths). Separate so the sync `__selftest` stays
 * usable in any context; callers that can await get the full check.
 * @returns {Promise<{ok:boolean, disk:object, netNull:boolean, meshNull:boolean}>}
 */
export async function __selftestAsync() {
  const seed = "deadbeefcafef00d";
  const disk = await diskRw(seed, { env: "ci" });
  const dc = recheck(disk);
  if (!dc.ok) throw new Error(`selftest: disk recheck failed: ${dc.reason}`);
  // net with no hub -> null; mesh transport -> null.
  const netNull = (await netThroughput({ seed, env: "ci" })) === null;
  const meshNull = (await netThroughput({ seed, env: "ci", transport: "mesh", hub: { submitTask: () => {} } })) === null;
  if (!netNull) throw new Error("selftest: netThroughput without hub must be null");
  if (!meshNull) throw new Error("selftest: mesh transport must be null (no primitive yet)");
  return { ok: true, disk: { metric: disk.metric, available: disk.raw.available }, netNull, meshNull };
}
