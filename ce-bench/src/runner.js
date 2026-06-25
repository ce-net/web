/**
 * @ce-net/bench — orchestration: run benchmarks across mesh peers and browser nodes.
 *
 * OWNER: implementer B. Depends on benchmarks.js (probes), ce.js (CeClient + HubClient), types.js.
 *
 * The runner ties the suite to the network: it picks the /beacon seed, benchmarks the LOCAL node,
 * dispatches the WASM suite to BROWSER nodes via the hub, and (where a directed-bench primitive
 * exists) asks specific mesh peers to self-benchmark. It also runs the verifier path: re-probe a
 * target with the same beacon seed and compare (anti-cheat, nodeprofile-spec.md §4).
 *
 * Boundaries (do not cross — other modules own these):
 *  - NO measurement math here. All kernels/recompute live in benchmarks.js. This module only
 *    *calls* them and *moves data* between the node API, the hub, and the caller.
 *  - NO profile assembly here. Folding BenchResult[] -> NodeProfile and signing/publishing is
 *    profile.js. The runner hands back raw BenchResult[] / maps.
 *  - NO aggregation/scoreboard here. That is fabricstats.js.
 *
 * Dependency injection: every export takes its client(s) as the first argument(s) and the benchmark
 * suite via `opts.bench` (defaulting to the real `./benchmarks.js` surface). This keeps the runner
 * testable offline — `__selftest()` injects fakes and never touches the network or real WASM.
 *
 * @packageDocumentation
 */

import { makeBenchResult, BENCH_KINDS } from "./types.js";
import * as defaultBench from "./benchmarks.js";

/** @typedef {import("./types.js").BenchResult} BenchResult */
/** @typedef {import("./types.js").NodeProfile} NodeProfile */
/** @typedef {import("./types.js").BenchEnv} BenchEnv */
/** @typedef {import("./ce.js").CeClient} CeClient */
/** @typedef {import("./ce.js").HubClient} HubClient */

/**
 * The slice of `benchmarks.js` the runner needs. Injectable so tests / alternate suites can stand in.
 * @typedef {object} BenchSuite
 * @property {(seed:string, env:BenchEnv, opts?:object)=>Promise<BenchResult[]>} runLocalSuite
 * @property {Record<string, BrowserKernel>} BROWSER_KERNELS
 * @property {(result:BenchResult)=>{ok:boolean, expected:number, got:number}} recheck
 */

/**
 * A browser/WASM kernel descriptor (mirrors benchmarks.js BROWSER_KERNELS values).
 * @typedef {object} BrowserKernel
 * @property {string} moduleB64                       Raw base64 WASM module (>64 chars).
 * @property {string} func                            Export to call.
 * @property {string} [ret]                           Return hint ("i64" default).
 * @property {typeof BENCH_KINDS[number]} kind        Which BenchResult kind this produces.
 * @property {(seed:string, preset:object)=>(number|bigint)[]} makeArgs
 * @property {(hubRes:import("./ce.js").HubTaskResult, seed:string)=>BenchResult} toResult
 */

/** Default value when an env is not supplied. The local process is treated as a "node" runtime. */
const DEFAULT_ENV = "node";

/** Defensive: ms-stamp helper kept here so a result built locally (verifier) is consistent. */
function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Resolve the injectable suite, falling back to the real benchmarks.js module.
 * @param {object} [opts]
 * @returns {BenchSuite}
 */
function suiteOf(opts) {
  return /** @type {BenchSuite} */ ((opts && opts.bench) || defaultBench);
}

/**
 * Fetch the current beacon and normalise it to `{height, hash}` (hash is the hex seed every probe
 * in one sweep shares). Tolerates a `null`/offline node by returning a zero seed so callers can
 * still run an UNSEEDED local pass (BenchResult.seed = "" then) without crashing.
 *
 * @param {CeClient|null|undefined} ce
 * @returns {Promise<{height:number, hash:string}>}
 */
export async function resolveSeed(ce) {
  if (!ce || typeof ce.beacon !== "function") return { height: 0, hash: "" };
  try {
    const b = await ce.beacon();
    const height = Number(b && b.height);
    const hash = b && typeof b.hash === "string" ? b.hash : "";
    return { height: Number.isFinite(height) ? height : 0, hash };
  } catch {
    return { height: 0, hash: "" };
  }
}

/**
 * Benchmark THIS process's machine once and return the raw probes. Grabs the beacon seed itself
 * (unless `opts.seed` is supplied) so the seed is verifiable and comparable across a sweep.
 *
 * @param {CeClient|null} ce              Node client (for /beacon). May be null for an unseeded run.
 * @param {object} [opts]
 * @param {BenchEnv} [opts.env]           Where we run. Default "node".
 * @param {string} [opts.preset]          Preset key passed through to runLocalSuite.
 * @param {{height:number,hash:string}|string} [opts.seed]  Pre-resolved seed (skip the beacon call).
 * @param {BenchSuite} [opts.bench]       Injected suite (tests).
 * @returns {Promise<BenchResult[]>}
 */
export async function benchLocal(ce, opts = {}) {
  const bench = suiteOf(opts);
  const env = /** @type {BenchEnv} */ (opts.env || DEFAULT_ENV);
  const seed = await coerceSeed(ce, opts.seed);
  const results = await bench.runLocalSuite(seed.hash, env, opts.preset ? { preset: opts.preset } : {});
  return stampSeed(results, seed.hash);
}

/**
 * Run the WASM suite on ONE browser node through the hub. `opts.target` selects a specific node;
 * otherwise the hub picks the least-loaded one. Per-kernel failures are tolerated (a node without
 * WebGPU simply skips the GPU/LLM kernel) — one bad kernel never aborts the node's run.
 *
 * @param {HubClient} hub
 * @param {object} [opts]
 * @param {string} [opts.target]          Specific browser node id; else least-loaded.
 * @param {{height:number,hash:string}|string} [opts.seed]
 * @param {CeClient|null} [opts.ce]       Used to resolve the seed when `opts.seed` is absent.
 * @param {BenchSuite} [opts.bench]
 * @param {string[]} [opts.kinds]         Restrict to these kernel kinds (default: all).
 * @returns {Promise<BenchResult[]>}
 */
export async function benchBrowserNode(hub, opts = {}) {
  const bench = suiteOf(opts);
  const seed = await coerceSeed(opts.ce ?? null, opts.seed);
  const kernels = selectKernels(bench.BROWSER_KERNELS, opts.kinds);
  const preset = browserPreset(bench);

  /** @type {BenchResult[]} */
  const out = [];
  for (const [name, kernel] of kernels) {
    try {
      const args = typeof kernel.makeArgs === "function" ? kernel.makeArgs(seed.hash, preset) : [];
      const hubRes = await hub.submitTask({
        moduleB64: kernel.moduleB64,
        module: kernel.moduleB64, // submitTask accepts either; long string => inline module
        func: kernel.func,
        ret: kernel.ret,
        args,
        target: opts.target,
      });
      if (!hubRes || hubRes.ok === false) {
        // Tolerate: kernel unsupported on this device or hub-side error. Skip, keep sweeping.
        continue;
      }
      const r = kernel.toResult(hubRes, seed.hash);
      out.push(stampOne(r, seed.hash));
    } catch {
      // One kernel failing (timeout, missing WebGPU, hub error) must not abort the node's suite.
      continue;
    }
    void name;
  }
  return out;
}

/**
 * Fan the WASM suite across ALL live browser nodes the hub knows about. Per-node isolation: one
 * node's failure is captured in that entry's `error` and never aborts the sweep.
 *
 * @param {HubClient} hub
 * @param {object} [opts]   Same as benchBrowserNode (minus `target`, which is iterated).
 * @returns {Promise<{node:string, results:BenchResult[], error?:string}[]>}
 */
export async function benchAllBrowserNodes(hub, opts = {}) {
  /** @type {{id:string}[]} */
  let nodes = [];
  try {
    const listed = await hub.nodes();
    nodes = normalizeNodes(listed);
  } catch (e) {
    // Can't list nodes -> nothing to sweep. Surface as a single synthetic error row.
    return [{ node: "", results: [], error: errMsg(e) }];
  }
  // Resolve the seed once so every node in the sweep shares it (comparable + verifiable).
  const seed = await coerceSeed(opts.ce ?? null, opts.seed);

  /** @type {{node:string, results:BenchResult[], error?:string}[]} */
  const out = [];
  for (const n of nodes) {
    try {
      const results = await benchBrowserNode(hub, { ...opts, target: n.id, seed });
      out.push({ node: n.id, results });
    } catch (e) {
      out.push({ node: n.id, results: [], error: errMsg(e) });
    }
  }
  return out;
}

/**
 * Verifier (anti-cheat, nodeprofile-spec.md §4): re-run the SAME probe kind against `target` with
 * the SAME beacon seed and compare to a `claimed` BenchResult. Two checks combine into `ok`:
 *   1. recompute the claimed metric from its OWN `raw` evidence (cheap, no re-run) — catches a
 *      scalar that doesn't match the evidence it shipped;
 *   2. a fresh seeded re-run (when a runner is available for the target's env) — catches evidence
 *      that was fabricated to be self-consistent.
 *
 * `delta` is the relative difference between the claimed metric and the freshly measured one
 * (0 when no fresh re-run was possible — then `ok` rests on the recompute alone).
 *
 * @param {{ce?:CeClient|null, hub?:HubClient|null, env?:BenchEnv}} target  Where/how to re-probe.
 * @param {BenchResult} claimed
 * @param {object} [opts]
 * @param {number} [opts.tolerance]       Max allowed relative delta. Default 0.25 (25%).
 * @param {BenchSuite} [opts.bench]
 * @returns {Promise<{ok:boolean, delta:number, recompute:{ok:boolean,expected:number,got:number}|null, fresh:BenchResult|null, reason:string}>}
 */
export async function verifyProbe(target, claimed, opts = {}) {
  const bench = suiteOf(opts);
  const tolerance = Number.isFinite(opts.tolerance) ? Number(opts.tolerance) : 0.25;

  if (!claimed || !BENCH_KINDS.includes(/** @type {any} */ (claimed.kind))) {
    return { ok: false, delta: Infinity, recompute: null, fresh: null, reason: "claimed result missing/invalid kind" };
  }

  // (1) Recompute from the claimed evidence. Pure, offline, always available.
  /** @type {{ok:boolean,expected:number,got:number}|null} */
  let recompute = null;
  if (typeof bench.recheck === "function") {
    try {
      recompute = bench.recheck(claimed);
    } catch {
      recompute = null;
    }
  }

  // (2) Fresh seeded re-run, if we can drive the target's environment.
  /** @type {BenchResult|null} */
  let fresh = null;
  let delta = 0;
  try {
    fresh = await reprobe(target, claimed, opts);
  } catch {
    fresh = null;
  }
  if (fresh && fresh.metric > 0 && claimed.metric >= 0) {
    const denom = Math.max(fresh.metric, claimed.metric, Number.EPSILON);
    delta = Math.abs(claimed.metric - fresh.metric) / denom;
  }

  const recomputeOk = recompute ? recompute.ok : true; // no recompute path => don't fail on it
  const freshOk = fresh ? delta <= tolerance : true; // no fresh run => rest on recompute
  const ok = recomputeOk && freshOk;
  const reason = ok
    ? "verified"
    : !recomputeOk
      ? "recompute mismatch (scalar disagrees with shipped raw)"
      : `fresh re-run delta ${delta.toFixed(3)} > tolerance ${tolerance}`;

  return { ok, delta, recompute, fresh, reason };
}

/**
 * Cross-check a claimed profile against `/history` plausibility (nodeprofile-spec.md §4: the
 * "claiming hardware far above delivered work" rule). Pure read; returns advisory flags, never
 * throws on a missing history (a brand-new node legitimately has none).
 *
 * @param {CeClient} ce
 * @param {NodeProfile} profile
 * @param {object} [opts]
 * @param {number} [opts.minTflops]       GPU TFLOPS above which we demand evidence of work. Default 1.
 * @param {number} [opts.minTokens]       tokens/s above which we demand evidence of work. Default 5.
 * @returns {Promise<{flags:string[]}>}
 */
export async function plausibilityCheck(ce, profile, opts = {}) {
  /** @type {string[]} */
  const flags = [];
  if (!profile || typeof profile !== "object" || typeof profile.node_id !== "string") {
    return { flags: ["profile missing node_id"] };
  }
  const minTflops = Number.isFinite(opts.minTflops) ? Number(opts.minTflops) : 1;
  const minTokens = Number.isFinite(opts.minTokens) ? Number(opts.minTokens) : 5;

  const gpuTflops = Array.isArray(profile.gpus)
    ? profile.gpus.reduce((s, g) => s + (Number(g && g.fp16_tflops) || 0), 0)
    : 0;
  const tokens = Number(profile.llm && profile.llm.tokens_per_sec) || 0;

  // Only bother fetching history if there's a "big claim" worth scrutinising.
  const bigCompute = gpuTflops >= minTflops;
  const bigLlm = tokens >= minTokens;
  if (!bigCompute && !bigLlm) return { flags };

  /** @type {any} */
  let hist = null;
  try {
    hist = await ce.history(profile.node_id);
  } catch {
    // No history endpoint / new node. Flag as unverified rather than trusted (§4).
    if (bigCompute) flags.push(`unverified: ${gpuTflops.toFixed(2)} TFLOPS claimed, no history available`);
    if (bigLlm) flags.push(`unverified: ${tokens.toFixed(1)} tok/s claimed, no history available`);
    return { flags };
  }

  // amounts in /history are decimal strings (money) -> never coerce to float for comparison;
  // a non-empty, non-"0" string means "has earned something".
  const jobsHosted = Number(hist && (hist.jobs_hosted ?? hist.jobsHosted)) || 0;
  const heartbeats = Number(hist && (hist.heartbeats ?? hist.heartbeat_count)) || 0;
  const earnedStr = String((hist && (hist.earned ?? hist.earned_credits)) ?? "0");
  const hasEarned = earnedStr !== "" && earnedStr !== "0" && /[1-9]/.test(earnedStr);
  const hasWork = jobsHosted > 0 || heartbeats > 0 || hasEarned;

  if (bigCompute && !hasWork) {
    flags.push(`implausible: ${gpuTflops.toFixed(2)} TFLOPS claimed but jobs_hosted=${jobsHosted}, heartbeats=${heartbeats}, earned=${earnedStr}`);
  }
  if (bigLlm && !hasWork) {
    flags.push(`implausible: ${tokens.toFixed(1)} tok/s claimed but no hosted jobs/heartbeats/earnings`);
  }
  return { flags };
}

/**
 * High-level convenience: benchmark the local node AND every live browser node in one seeded sweep,
 * returning a map `node_id -> BenchResult[]`. The local node is keyed by its `/status.node_id`
 * (falling back to the literal "local" when the node id can't be read).
 *
 * NOTE (documented gap, not faked): directed benchmarking of *native mesh peers* needs a
 * "run the ce-bench capsule on host X" primitive (mesh-deploy of the bench cell, compute-fabric.md
 * §3). That is a fast-follow; until it exists, `benchFabric` covers (a) the host the runner runs on
 * and (b) browser nodes via the hub. It does NOT silently invent peer numbers.
 *
 * @param {CeClient} ce
 * @param {HubClient} hub
 * @param {object} [opts]
 * @param {boolean} [opts.includeLocal]   Run the local suite too. Default true.
 * @param {boolean} [opts.includeBrowsers] Sweep browser nodes too. Default true.
 * @param {BenchEnv} [opts.env]           Local env. Default "node".
 * @param {BenchSuite} [opts.bench]
 * @returns {Promise<Map<string, BenchResult[]>>}
 */
export async function benchFabric(ce, hub, opts = {}) {
  const includeLocal = opts.includeLocal !== false;
  const includeBrowsers = opts.includeBrowsers !== false;

  // Shared seed for the whole fabric sweep (comparable + verifiable).
  const seed = await coerceSeed(ce, opts.seed);

  /** @type {Map<string, BenchResult[]>} */
  const map = new Map();

  if (includeLocal && ce) {
    let localId = "local";
    try {
      const st = await ce.status();
      if (st && typeof st.node_id === "string" && st.node_id) localId = st.node_id;
    } catch {
      /* keep "local" */
    }
    try {
      const local = await benchLocal(ce, { ...opts, seed });
      map.set(localId, local);
    } catch (e) {
      // Local suite failed (e.g. benchmarks.js not yet implemented) — record an empty entry rather
      // than aborting the browser sweep.
      map.set(localId, []);
      void errMsg(e);
    }
  }

  if (includeBrowsers && hub) {
    const sweep = await benchAllBrowserNodes(hub, { ...opts, ce, seed });
    for (const row of sweep) {
      if (!row.node) continue;
      // A node may already have a (local) entry only if its id collided with localId; merge.
      const prev = map.get(row.node) || [];
      map.set(row.node, prev.concat(row.results));
    }
  }

  return map;
}

/* ----------------------------------------------------------------------------------------------- *
 * internal helpers (no measurement math, no profile assembly)
 * ----------------------------------------------------------------------------------------------- */

/**
 * Normalise a seed argument: accept a pre-resolved `{height,hash}`, a bare hex string, or nothing
 * (then fetch from the node). Always returns `{height, hash}`.
 * @param {CeClient|null} ce
 * @param {{height:number,hash:string}|string|undefined} seedArg
 * @returns {Promise<{height:number, hash:string}>}
 */
async function coerceSeed(ce, seedArg) {
  if (typeof seedArg === "string") return { height: 0, hash: seedArg };
  if (seedArg && typeof seedArg === "object" && typeof seedArg.hash === "string") {
    return { height: Number(seedArg.height) || 0, hash: seedArg.hash };
  }
  return resolveSeed(ce);
}

/** Pick the browser preset object from a suite, tolerating a stub with no PRESETS. */
function browserPreset(bench) {
  const presets = /** @type {any} */ (bench).PRESETS;
  return (presets && (presets.browser || presets.node)) || {};
}

/**
 * Select kernel [name, kernel] pairs from BROWSER_KERNELS, optionally filtered to `kinds`.
 * @param {Record<string, BrowserKernel>|undefined} kernels
 * @param {string[]|undefined} kinds
 * @returns {[string, BrowserKernel][]}
 */
function selectKernels(kernels, kinds) {
  const entries = kernels ? Object.entries(kernels) : [];
  if (!kinds || !kinds.length) return entries;
  const want = new Set(kinds);
  return entries.filter(([, k]) => want.has(k.kind));
}

/**
 * Re-probe a target for the verifier path. For a "node"/local target with a CeClient we re-run the
 * single matching probe via the local suite; for a browser target with a hub we dispatch the one
 * matching kernel. Returns the matching fresh BenchResult, or null if no re-run path is available.
 * @param {{ce?:CeClient|null, hub?:HubClient|null, env?:BenchEnv}} target
 * @param {BenchResult} claimed
 * @param {object} opts
 * @returns {Promise<BenchResult|null>}
 */
async function reprobe(target, claimed, opts) {
  const bench = suiteOf(opts);
  const seed = claimed.seed || ""; // re-run with the SAME seed the claim used
  // Browser target: dispatch the single matching kernel.
  if (target && target.hub) {
    const results = await benchBrowserNode(target.hub, {
      ...opts,
      ce: target.ce ?? null,
      seed: { height: 0, hash: seed },
      kinds: [claimed.kind],
    });
    return results.find((r) => r.kind === claimed.kind) || null;
  }
  // Local/node target: run the local suite and pull the matching kind out.
  if (typeof bench.runLocalSuite === "function") {
    const env = /** @type {BenchEnv} */ (target && target.env) || DEFAULT_ENV;
    const results = await bench.runLocalSuite(seed, env, {});
    const r = Array.isArray(results) ? results.find((x) => x.kind === claimed.kind) : null;
    return r ? stampOne(r, seed) : null;
  }
  return null;
}

/** Stamp the shared seed onto each result (probes may leave it ""); returns the same array. */
function stampSeed(results, seedHash) {
  if (!Array.isArray(results)) return [];
  return results.map((r) => stampOne(r, seedHash));
}

/** Ensure one result carries the sweep seed without mutating the caller's object. */
function stampOne(r, seedHash) {
  if (!r || typeof r !== "object") return r;
  if (r.seed) return r;
  return { ...r, seed: seedHash || "" };
}

/**
 * Coerce the hub's /nodes response (array of strings or objects) into `[{id}]`.
 * @param {any} listed
 * @returns {{id:string}[]}
 */
function normalizeNodes(listed) {
  if (!Array.isArray(listed)) {
    // Some hubs return { nodes: [...] }.
    if (listed && Array.isArray(listed.nodes)) listed = listed.nodes;
    else return [];
  }
  /** @type {{id:string}[]} */
  const out = [];
  for (const n of listed) {
    if (typeof n === "string") out.push({ id: n });
    else if (n && typeof n.id === "string") out.push({ id: n.id });
    else if (n && typeof n.node === "string") out.push({ id: n.node });
  }
  return out;
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/* ----------------------------------------------------------------------------------------------- *
 * offline self-test — injects fakes; NEVER touches the network or real WASM. Run: node src/runner.js
 * ----------------------------------------------------------------------------------------------- */

/**
 * Build a deterministic fake suite for tests: probes derive a metric from a numeric seed so the
 * verifier can detect agreement/disagreement. `recheck` recomputes from `raw.opCount`.
 * @returns {BenchSuite}
 */
function fakeSuite() {
  const seedNum = (hex) => {
    let h = 0;
    for (let i = 0; i < hex.length; i++) h = (h * 31 + hex.charCodeAt(i)) >>> 0;
    return h || 1;
  };
  const mk = (kind, seed, mult) => {
    const opCount = (seedNum(seed) % 1000) + 1000;
    const metric = (opCount * (mult || 1)) / 1000;
    return makeBenchResult({ kind, metric, unit: "x", seed, raw: { opCount, mult: mult || 1 }, ms: 10, env: "node" });
  };
  return {
    runLocalSuite: async (seed) => [
      mk("cpu_flops", seed, 2),
      mk("cpu_int", seed, 3),
      mk("mem_bw", seed, 1),
    ],
    BROWSER_KERNELS: {
      cpu_flops: {
        moduleB64: "x".repeat(80),
        func: "flops",
        ret: "i64",
        kind: "cpu_flops",
        makeArgs: (seed) => [seedNum(seed) % 100],
        toResult: (hubRes, seed) =>
          makeBenchResult({ kind: "cpu_flops", metric: Number(hubRes.value) / 1000, unit: "gflops", seed, raw: { value: hubRes.value }, env: "browser" }),
      },
      mem_bw: {
        moduleB64: "y".repeat(80),
        func: "membw",
        ret: "i64",
        kind: "mem_bw",
        makeArgs: () => [1],
        toResult: (hubRes, seed) =>
          makeBenchResult({ kind: "mem_bw", metric: Number(hubRes.value) / 1000, unit: "gbps", seed, raw: { value: hubRes.value }, env: "browser" }),
      },
    },
    recheck: (result) => {
      const op = Number(result.raw && result.raw.opCount) || 0;
      const mult = Number(result.raw && result.raw.mult) || 1;
      const expected = (op * mult) / 1000;
      return { ok: Math.abs(expected - result.metric) < 1e-9, expected, got: result.metric };
    },
  };
}

/** A fake HubClient: two browser nodes, each returns a fixed value per func. */
function fakeHub() {
  return {
    nodes: async () => [{ id: "a".repeat(64) }, { id: "b".repeat(64) }],
    submitTask: async (task) => ({
      node: task.target || "a".repeat(64),
      func: task.func,
      args: task.args || [],
      ok: true,
      value: task.func === "flops" ? "5000" : "3000",
      ms: 7,
    }),
  };
}

/** A fake CeClient: beacon, status, history. */
function fakeCe(overrides = {}) {
  return {
    beacon: async () => ({ height: 42, hash: "deadbeef" }),
    status: async () => ({ node_id: "c".repeat(64) }),
    history: async (id) => ({ jobs_hosted: 0, heartbeats: 0, earned: "0", node_id: id }),
    ...overrides,
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error("selftest: " + msg);
}

/**
 * Offline self-test. Returns `{ ok: true, checks: [...] }` or throws on first failure.
 * Exercises: seed resolution, benchLocal, browser sweep, verifyProbe (pass + tamper), plausibility
 * (clean + implausible), and benchFabric — all with injected fakes, no network.
 * @returns {Promise<{ok:boolean, checks:string[]}>}
 */
export async function __selftest() {
  /** @type {string[]} */
  const checks = [];
  const bench = fakeSuite();
  const hub = /** @type {any} */ (fakeHub());
  const ce = /** @type {any} */ (fakeCe());

  // 1. seed resolution
  const seed = await resolveSeed(ce);
  assert(seed.height === 42 && seed.hash === "deadbeef", "resolveSeed should read the beacon");
  const noSeed = await resolveSeed(null);
  assert(noSeed.hash === "" && noSeed.height === 0, "resolveSeed(null) should be empty, not throw");
  checks.push("resolveSeed ok");

  // 2. benchLocal -> 3 sane results, all stamped with the seed
  const local = await benchLocal(ce, { bench });
  assert(local.length === 3, `benchLocal should return 3 results, got ${local.length}`);
  for (const r of local) {
    assert(r.metric >= 0 && Number.isFinite(r.metric), `metric sane for ${r.kind}`);
    assert(r.seed === "deadbeef", `result ${r.kind} stamped with seed`);
    assert(BENCH_KINDS.includes(r.kind), `${r.kind} is a known kind`);
  }
  checks.push("benchLocal ok (3 seeded sane results)");

  // 3. one browser node
  const one = await benchBrowserNode(hub, { bench, ce, target: "a".repeat(64) });
  assert(one.length === 2, `benchBrowserNode should return 2 kernel results, got ${one.length}`);
  assert(one.every((r) => r.env === "browser" && r.seed === "deadbeef"), "browser results seeded+env");
  checks.push("benchBrowserNode ok");

  // 3b. browser sweep over all nodes
  const all = await benchAllBrowserNodes(hub, { bench, ce });
  assert(all.length === 2, `sweep should cover 2 nodes, got ${all.length}`);
  assert(all.every((row) => row.results.length === 2 && !row.error), "every node ran both kernels");
  checks.push("benchAllBrowserNodes ok");

  // 4. verifyProbe — honest claim passes
  const honest = local[0]; // recheck() agrees with its own raw
  const v1 = await verifyProbe({ ce, env: "node" }, honest, { bench, tolerance: 0.5 });
  assert(v1.ok === true, `honest probe should verify: ${v1.reason}`);
  assert(v1.recompute && v1.recompute.ok, "recompute should agree for honest claim");
  checks.push("verifyProbe(honest) ok");

  // 4b. verifyProbe — tampered scalar (raw says one thing, metric says another) fails recompute
  const tampered = { ...honest, metric: honest.metric * 10 };
  const v2 = await verifyProbe({ ce: null, env: "node" }, tampered, { bench: bench, tolerance: 0.01 });
  assert(v2.ok === false, "tampered scalar should fail verification");
  checks.push("verifyProbe(tampered) flagged");

  // 5. plausibilityCheck — clean (no big claims) yields no flags
  const cleanProfile = {
    node_id: "d".repeat(64),
    gpus: [],
    llm: { ref_model: "ref", tokens_per_sec: 0 },
  };
  const p1 = await plausibilityCheck(ce, /** @type {any} */ (cleanProfile));
  assert(p1.flags.length === 0, `clean profile should have no flags, got ${JSON.stringify(p1.flags)}`);
  checks.push("plausibilityCheck(clean) ok");

  // 5b. plausibilityCheck — big GPU claim with zero history is flagged implausible
  const bigProfile = {
    node_id: "e".repeat(64),
    gpus: [{ model: "X", backend: "Cuda", vram_mb: 24000, fp16_tflops: 300 }],
    llm: { ref_model: "ref", tokens_per_sec: 0 },
  };
  const p2 = await plausibilityCheck(ce, /** @type {any} */ (bigProfile));
  assert(p2.flags.length >= 1 && /implausible/.test(p2.flags[0]), `big GPU + no work should flag: ${JSON.stringify(p2.flags)}`);
  checks.push("plausibilityCheck(implausible) flagged");

  // 5c. plausibilityCheck — big claim BUT with real work => not flagged
  const ceWorked = /** @type {any} */ (fakeCe({ history: async () => ({ jobs_hosted: 12, heartbeats: 99, earned: "5000000000000000000" }) }));
  const p3 = await plausibilityCheck(ceWorked, /** @type {any} */ (bigProfile));
  assert(p3.flags.length === 0, `big GPU WITH work should not flag: ${JSON.stringify(p3.flags)}`);
  checks.push("plausibilityCheck(worked) ok");

  // 6. benchFabric — local + browser nodes keyed by node_id
  const fabric = await benchFabric(ce, hub, { bench });
  assert(fabric instanceof Map, "benchFabric returns a Map");
  assert(fabric.has("c".repeat(64)), "fabric map keyed by local node_id from /status");
  assert(fabric.get("c".repeat(64)).length === 3, "local entry has 3 results");
  assert(fabric.has("a".repeat(64)) && fabric.has("b".repeat(64)), "fabric includes both browser nodes");
  assert(fabric.get("a".repeat(64)).length === 2, "browser entry has 2 results");
  checks.push("benchFabric ok (local + 2 browsers)");

  // 7. graceful degradation: benchFabric with a failing local suite still sweeps browsers
  const brokenBench = { ...bench, runLocalSuite: async () => { throw new Error("not implemented"); } };
  const fabric2 = await benchFabric(ce, hub, { bench: brokenBench });
  assert(fabric2.get("c".repeat(64)).length === 0, "broken local suite -> empty local entry, no throw");
  assert(fabric2.get("a".repeat(64)).length === 2, "broken local suite still sweeps browsers");
  checks.push("benchFabric degrades gracefully");

  return { ok: true, checks };
}

// Run the self-test when invoked directly: `node src/runner.js`
if (typeof process !== "undefined" && process.argv && import.meta.url === `file://${process.argv[1]}`) {
  __selftest()
    .then((r) => {
      for (const c of r.checks) console.log("  ✓ " + c);
      console.log(`\nrunner.js __selftest: ${r.checks.length} checks passed`);
    })
    .catch((e) => {
      console.error("runner.js __selftest FAILED:", e && e.message);
      process.exit(1);
    });
}

void nowSecs; // reserved for future verifier timestamps; keep the helper without tripping linters
