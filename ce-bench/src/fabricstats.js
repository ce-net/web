/**
 * @ce-net/bench — aggregate signed profiles + the netgraph into the FabricStats scoreboard.
 *
 * OWNER: implementer D. Depends on types.js (FabricStats/NodeProfile/validateProfile/emptyFabricStats),
 * ce.js (CeClient). Implements docs/nodeprofile-spec.md §6 + compute-fabric.md §2.4.
 *
 * This module is the read/aggregate side: collect the network's signed NodeProfiles, dedupe by
 * node_id (latest measured_at wins), robustly sum the capability fields, and roll the netgraph into
 * mesh-health numbers — producing the single FabricStats object the landing page / network.html read.
 *
 * GRAPH RE-DERIVATION (no ce-ts import allowed). `meshHealth` re-implements the exact concepts from
 * `@ce-net/graph` (`MeasuredGraph`): undirected edges with a SAMPLE-WEIGHTED-MEAN fusion
 * (`Σ rtt·samples / Σ samples`), `regions()` = connected components over edges with `rttMs <=
 * regionThresholdMs` (default 30 ms) via union-find, and `reachable_frac` = fraction of unordered
 * node pairs that fall in the same connected component over ALL measured edges. The numbers match
 * what `MeasuredGraph.build(...).regions()` and a component cover would produce; we cannot import
 * the lib (other agents hold uncommitted work in ce-ts), so the algorithm is duplicated here.
 *
 * MONEY: no field here is money. The *_verified weighting derives a bounded 0..1 trust factor from
 * `/history` (`jobs_hosted`, an integer count) and the PRESENCE of non-zero earned — it never parses
 * a base-unit credit amount into a JS float. Decimal-string amounts stay strings.
 *
 * @packageDocumentation
 */

import { emptyFabricStats, validateProfile } from "./types.js";
// CeClient is dependency-injected (duck-typed) — we only call .fabricStats()/.profiles()/.signals()/
// .netgraph()/.history(). fromHex is used to decode CEP-1 signal payloads back into profile JSON.
import { fromHex } from "./ce.js";

/** Default display weights for perf_score (nodeprofile-spec.md §6). DISPLAY ONLY. */
export const PERF_WEIGHTS = Object.freeze({ cpuGflops: 1, gpuTflops: 1, tokensPerSec: 0.5 });

/** Default robustness clamp: drop per-node values above K * population median before summing. */
export const DEFAULT_CLAMP_K = 8;

/** Default region threshold (ms): mirrors @ce-net/graph GraphOptions.regionThresholdMs default. */
export const DEFAULT_REGION_THRESHOLD_MS = 30;

/** Default staleness window for dedupeLatest: profiles older than this are dropped. ~24h. */
export const DEFAULT_MAX_AGE_SECS = 24 * 3600;

// ---------------------------------------------------------------------------
// small numeric helpers (pure)
// ---------------------------------------------------------------------------

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const nowSecs = () => Math.floor(Date.now() / 1000);

/**
 * Population median of a numeric array. Returns 0 for an empty array.
 * @param {number[]} xs
 * @returns {number}
 */
export function median(xs) {
  const v = xs.filter(isFiniteNum).slice().sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Robust sum: drop values greater than `clampK × population_median` before summing, so a single
 * machine reporting an absurd number cannot inflate the headline (nodeprofile-spec §4 "implausible
 * card" filter). With <2 finite values there is no meaningful median, so we sum as-is.
 *
 * @param {number[]} values
 * @param {number} [clampK]
 * @returns {{sum:number, kept:number, dropped:number, median:number}}
 */
export function robustSum(values, clampK = DEFAULT_CLAMP_K) {
  const finite = values.filter((v) => isFiniteNum(v) && v >= 0);
  if (finite.length < 2) {
    const sum = finite.reduce((a, b) => a + b, 0);
    return { sum, kept: finite.length, dropped: 0, median: finite[0] ?? 0 };
  }
  const med = median(finite);
  // median can be 0 (e.g. lots of zero reporters) — then any positive value is "> K*0"; treat a
  // zero median as "no upper bound" so honest non-zero contributors are not discarded.
  const cap = med > 0 ? clampK * med : Infinity;
  let sum = 0;
  let kept = 0;
  let dropped = 0;
  for (const v of finite) {
    if (v <= cap) {
      sum += v;
      kept += 1;
    } else {
      dropped += 1;
    }
  }
  return { sum, kept, dropped, median: med };
}

// ---------------------------------------------------------------------------
// 1. collect
// ---------------------------------------------------------------------------

/**
 * Decode a CEP-1 signal that advertises a `nodeprofile` capability back into a NodeProfile.
 * Tries `payload_hex` (the canonical/stopgap path) first, then a few tolerant fallbacks. Returns
 * `null` if the signal does not carry a parseable profile.
 *
 * @param {any} sig a raw entry from `GET /signals`
 * @returns {import("./types.js").NodeProfile | null}
 */
export function profileFromSignal(sig) {
  if (!sig || typeof sig !== "object") return null;
  const caps = sig.capabilities ?? sig.caps ?? [];
  const advertisesProfile =
    Array.isArray(caps) &&
    caps.some((c) => (typeof c === "string" ? c === "nodeprofile" : c && c.name === "nodeprofile"));
  // If capabilities are absent we still try to parse — some node builds may omit them on the wire.
  const hex = sig.payload_hex ?? sig.payloadHex;
  /** @type {string|undefined} */
  let json;
  if (typeof hex === "string" && hex.length >= 2 && /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
    try {
      json = new TextDecoder().decode(fromHex(hex));
    } catch {
      json = undefined;
    }
  } else if (sig.payload && typeof sig.payload === "object") {
    // some builds may inline the decoded payload
    return validateProfile(sig.payload).length === 0 ? sig.payload : null;
  }
  if (!json) return null;
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  // Only accept it if it actually validates as a profile (guards against unrelated signals that
  // happen to carry JSON, and against non-profile capability signals when caps were missing).
  if (validateProfile(obj).length !== 0) return null;
  void advertisesProfile; // informative only; structural validation is the real gate.
  return obj;
}

/**
 * Pull every NodeProfile a node knows about. Preference order:
 *   1. `ce.profiles()` (the proposed first-class endpoint; resolves to [] on 404).
 *   2. reconstruct from `ce.signals()` (the CEP-1 stopgap — decode `nodeprofile` payloads).
 * Returns the union, structurally validated, NOT yet deduped (see {@link dedupeLatest}).
 *
 * @param {{profiles?:Function, signals?:Function}} ce  dependency-injected CeClient-shaped object
 * @returns {Promise<import("./types.js").NodeProfile[]>}
 */
export async function collectProfiles(ce) {
  if (!ce) throw new Error("collectProfiles: a CeClient-shaped client is required");
  /** @type {import("./types.js").NodeProfile[]} */
  const out = [];

  // 1. first-class endpoint
  if (typeof ce.profiles === "function") {
    try {
      const list = await ce.profiles();
      if (Array.isArray(list)) {
        for (const p of list) if (validateProfile(p).length === 0) out.push(p);
      }
    } catch {
      // ignore — fall through to the signal stopgap
    }
  }

  // 2. CEP-1 stopgap. Always also scan signals so a brand-new node (before /profiles ships) and a
  // hybrid network (some via endpoint, some via signals) both surface. dedupeLatest reconciles.
  if (typeof ce.signals === "function") {
    try {
      const signals = await ce.signals();
      if (Array.isArray(signals)) {
        for (const s of signals) {
          const p = profileFromSignal(s);
          if (p) out.push(p);
        }
      }
    } catch {
      // ignore — endpoint results (if any) still returned
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 2. dedupe
// ---------------------------------------------------------------------------

/**
 * Dedupe by `node_id` keeping the freshest VALID profile; drop structurally-invalid ones and any
 * whose `measured_at` is older than `maxAgeSecs` (stale). Order-independent and deterministic.
 *
 * @param {import("./types.js").NodeProfile[]} profiles
 * @param {{maxAgeSecs?:number, now?:number}} [opts]
 * @returns {import("./types.js").NodeProfile[]}
 */
export function dedupeLatest(profiles, opts = {}) {
  const maxAge = isFiniteNum(opts.maxAgeSecs) ? opts.maxAgeSecs : DEFAULT_MAX_AGE_SECS;
  const now = isFiniteNum(opts.now) ? opts.now : nowSecs();
  /** @type {Map<string, import("./types.js").NodeProfile>} */
  const best = new Map();
  for (const p of profiles ?? []) {
    if (validateProfile(p).length !== 0) continue;
    // stale check: allow a small clock-skew grace on the future side.
    if (now - p.measured_at > maxAge) continue;
    const existing = best.get(p.node_id);
    if (!existing || p.measured_at > existing.measured_at) best.set(p.node_id, p);
  }
  // deterministic ordering by node_id
  return [...best.values()].sort((a, b) => (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 3. aggregate compute
// ---------------------------------------------------------------------------

/**
 * Robust aggregate of the per-node capability fields into the compute portion of FabricStats.
 * Assumes `profiles` is already deduped (pass the output of {@link dedupeLatest}). `cpu_gflops`,
 * `gpu_tflops`, and `tokens_per_sec` use {@link robustSum} (drop > clampK×median); counts and pools
 * (cores, gpus, vram, storage) are plain sums.
 *
 * @param {import("./types.js").NodeProfile[]} profiles
 * @param {{clampK?:number}} [opts]
 * @returns {Partial<import("./types.js").FabricStats>}
 */
export function aggregateCompute(profiles, opts = {}) {
  const clampK = isFiniteNum(opts.clampK) ? opts.clampK : DEFAULT_CLAMP_K;
  const list = profiles ?? [];

  let cpu_cores = 0;
  let gpus = 0;
  let gpu_vram_mb = 0;
  let storage_free_gb = 0;
  const byKind = { native: 0, container: 0, browser: 0 };

  const cpuGflopsVals = [];
  const gpuTflopsVals = [];
  const tokensVals = [];

  for (const p of list) {
    cpu_cores += isFiniteNum(p.cpu?.cores) ? p.cpu.cores : 0;
    cpuGflopsVals.push(isFiniteNum(p.cpu?.gflops_fp32) ? p.cpu.gflops_fp32 : 0);

    let nodeTflops = 0;
    for (const g of p.gpus ?? []) {
      gpus += 1;
      gpu_vram_mb += isFiniteNum(g.vram_mb) ? g.vram_mb : 0;
      nodeTflops += isFiniteNum(g.fp16_tflops) ? g.fp16_tflops : 0;
    }
    gpuTflopsVals.push(nodeTflops);

    tokensVals.push(isFiniteNum(p.llm?.tokens_per_sec) ? p.llm.tokens_per_sec : 0);
    storage_free_gb += isFiniteNum(p.storage?.free_gb) ? p.storage.free_gb : 0;

    const kind = p.runtime?.kind;
    if (kind === "Native") byKind.native += 1;
    else if (kind === "Container") byKind.container += 1;
    else if (kind === "Browser") byKind.browser += 1;
  }

  return {
    nodes: list.length,
    cpu_cores,
    cpu_gflops: robustSum(cpuGflopsVals, clampK).sum,
    gpus,
    gpu_vram_mb,
    gpu_tflops: robustSum(gpuTflopsVals, clampK).sum,
    tokens_per_sec: robustSum(tokensVals, clampK).sum,
    storage_free_gb,
    by_kind: byKind,
  };
}

// ---------------------------------------------------------------------------
// 4. mesh health (re-derived @ce-net/graph)
// ---------------------------------------------------------------------------

/**
 * Normalize whatever edge shape we were given into fused, undirected edges plus a node set.
 *
 * Accepts:
 *  - raw single-vantage `/netgraph` rows `[{peer, rtt_ms, samples, last_seen_secs}]` (the local
 *    node's view). The origin is implicitly "self" (a synthetic id), giving a star topology.
 *  - directed observations `[{origin, peer, rttMs|rtt_ms, samples}]` from multiple vantage points.
 *  - already-fused undirected edges `[{a, b, rttMs|rtt_ms, samples}]`.
 *
 * Fusion uses the SAME sample-weighted mean as MeasuredGraph.build:
 * `rtt = Σ(rtt_i · samples_i) / Σ samples_i` per unordered pair.
 *
 * @param {any[]} rows
 * @param {{selfId?:string}} [opts]
 * @returns {{nodes:Set<string>, edges:{a:string,b:string,rttMs:number,samples:number}[]}}
 */
export function fuseEdges(rows, opts = {}) {
  const selfId = opts.selfId ?? "self";
  /** @type {Map<string,{a:string,b:string,wsum:number,samples:number}>} */
  const merged = new Map();
  const nodes = new Set();

  const pairKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`);

  for (const r of rows ?? []) {
    if (!r || typeof r !== "object") continue;
    let a;
    let b;
    if (typeof r.a === "string" && typeof r.b === "string") {
      a = r.a;
      b = r.b;
    } else {
      a = typeof r.origin === "string" ? r.origin : selfId;
      b = typeof r.peer === "string" ? r.peer : undefined;
    }
    if (typeof b !== "string" || a === b) continue;
    const rtt = isFiniteNum(r.rttMs) ? r.rttMs : isFiniteNum(r.rtt_ms) ? r.rtt_ms : undefined;
    if (rtt === undefined || rtt < 0) continue;
    const samples = Math.max(isFiniteNum(r.samples) ? r.samples : 1, 1);

    nodes.add(a);
    nodes.add(b);
    const key = pairKey(a, b);
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const e = merged.get(key);
    if (!e) merged.set(key, { a: lo, b: hi, wsum: rtt * samples, samples });
    else {
      e.wsum += rtt * samples;
      e.samples += samples;
    }
  }

  const edges = [...merged.values()].map((e) => ({
    a: e.a,
    b: e.b,
    rttMs: e.samples > 0 ? e.wsum / e.samples : 0,
    samples: e.samples,
  }));
  return { nodes, edges };
}

/**
 * Mesh health from netgraph edges, re-deriving `@ce-net/graph` concepts locally:
 *  - `median_rtt_ms`: median of fused undirected edge RTTs.
 *  - `regions`: connected components over edges with `rttMs <= regionThresholdMs` (union-find),
 *    counting singletons — identical to `MeasuredGraph.regions().length`.
 *  - `reachable_frac`: fraction of unordered node pairs in the same connected component over ALL
 *    measured edges (a "predicted path exists" cover). With <2 nodes this is 1 (vacuously full).
 *
 * @param {any[]} netgraphEdges raw /netgraph rows, directed observations, or fused edges
 * @param {{regionThresholdMs?:number, selfId?:string, extraNodes?:Iterable<string>}} [opts]
 *        `extraNodes` lets the caller include profile-only nodes (no measured edge) so they count as
 *        their own singleton regions and as unreachable pairs (matches build()'s nodeSet union).
 * @returns {{median_rtt_ms:number, reachable_frac:number, regions:number}}
 */
export function meshHealth(netgraphEdges, opts = {}) {
  const threshold = isFiniteNum(opts.regionThresholdMs)
    ? opts.regionThresholdMs
    : DEFAULT_REGION_THRESHOLD_MS;
  const { nodes, edges } = fuseEdges(netgraphEdges, opts);
  for (const n of opts.extraNodes ?? []) nodes.add(n);

  const median_rtt_ms = median(edges.map((e) => e.rttMs));

  // union-find helpers
  /** @type {Map<string,string>} */
  const parent = new Map();
  for (const n of nodes) parent.set(n, n);
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  // regions: components under the threshold (singletons included).
  for (const e of edges) if (e.rttMs <= threshold) union(e.a, e.b);
  const regionRoots = new Set();
  for (const n of nodes) regionRoots.add(find(n));
  const regions = regionRoots.size;

  // reachable_frac: components over ALL edges (rebuild a fresh union-find).
  for (const n of nodes) parent.set(n, n);
  for (const e of edges) union(e.a, e.b);
  /** @type {Map<string,number>} */
  const compSize = new Map();
  for (const n of nodes) {
    const r = find(n);
    compSize.set(r, (compSize.get(r) ?? 0) + 1);
  }
  const N = nodes.size;
  let reachablePairs = 0;
  for (const sz of compSize.values()) reachablePairs += (sz * (sz - 1)) / 2;
  const totalPairs = (N * (N - 1)) / 2;
  const reachable_frac = totalPairs === 0 ? 1 : reachablePairs / totalPairs;

  return { median_rtt_ms, reachable_frac, regions };
}

// ---------------------------------------------------------------------------
// 5. perf score (display only)
// ---------------------------------------------------------------------------

/**
 * Display-only roll-up (nodeprofile-spec §6):
 *   perf_score = w_c·cpu_gflops + w_g·gpu_tflops·1000 + w_l·tokens_per_sec
 * The ·1000 normalizes TFLOPS→GFLOPS so the GPU term is comparable to the CPU GFLOPS term.
 * NEVER use this for placement — placement reads the per-node vector (@ce-net/sched's job).
 *
 * @param {Partial<import("./types.js").FabricStats>} stats
 * @param {{cpuGflops?:number, gpuTflops?:number, tokensPerSec?:number}} [weights]
 * @returns {number}
 */
export function perfScore(stats, weights = PERF_WEIGHTS) {
  const w = { ...PERF_WEIGHTS, ...weights };
  const cpu = isFiniteNum(stats?.cpu_gflops) ? stats.cpu_gflops : 0;
  const gpu = isFiniteNum(stats?.gpu_tflops) ? stats.gpu_tflops : 0;
  const tok = isFiniteNum(stats?.tokens_per_sec) ? stats.tokens_per_sec : 0;
  return w.cpuGflops * cpu + w.gpuTflops * gpu * 1000 + w.tokensPerSec * tok;
}

// ---------------------------------------------------------------------------
// 6. full scoreboard
// ---------------------------------------------------------------------------

/**
 * Full scoreboard: prefer the node's own `GET /fabric/stats` if served (one fetch, authoritative);
 * otherwise collect → dedupe → aggregateCompute → meshHealth → perfScore client-side.
 *
 * @param {{fabricStats?:Function, profiles?:Function, signals?:Function, netgraph?:Function}} ce
 * @param {{clampK?:number, maxAgeSecs?:number, regionThresholdMs?:number, now?:number,
 *          preferNode?:boolean, weights?:object}} [opts]
 * @returns {Promise<import("./types.js").FabricStats>}
 */
export async function computeFabricStats(ce, opts = {}) {
  if (!ce) throw new Error("computeFabricStats: a CeClient-shaped client is required");

  // 0. node-served scoreboard wins if present.
  if (opts.preferNode !== false && typeof ce.fabricStats === "function") {
    try {
      const served = await ce.fabricStats();
      if (served && typeof served === "object" && isFiniteNum(served.nodes)) {
        return normalizeStats(served);
      }
    } catch {
      // fall through to client compute
    }
  }

  // 1. collect + dedupe
  const raw = await collectProfiles(ce);
  const profiles = dedupeLatest(raw, { maxAgeSecs: opts.maxAgeSecs, now: opts.now });

  // 2. compute portion
  const compute = aggregateCompute(profiles, { clampK: opts.clampK });

  // 3. mesh portion (the local node's /netgraph vantage; include profile-only nodes as singletons)
  let mesh = { median_rtt_ms: 0, reachable_frac: profiles.length <= 1 ? 1 : 0, regions: 0 };
  if (typeof ce.netgraph === "function") {
    try {
      const edges = await ce.netgraph();
      mesh = meshHealth(Array.isArray(edges) ? edges : [], {
        regionThresholdMs: opts.regionThresholdMs,
        extraNodes: profiles.map((p) => p.node_id),
      });
    } catch {
      // keep the default mesh (no netgraph available)
    }
  }

  const stats = { ...emptyFabricStats(), ...compute, mesh, computed_at: nowSecs() };
  stats.perf_score = perfScore(stats, opts.weights);
  return normalizeStats(stats);
}

/**
 * Coerce an arbitrary stats object (node-served or computed) into a complete, finite FabricStats so
 * downstream consumers (gauges) never see undefined/NaN. Money is never involved here.
 * @param {any} s
 * @returns {import("./types.js").FabricStats}
 */
export function normalizeStats(s) {
  const base = emptyFabricStats();
  const num = (v, d) => (isFiniteNum(v) ? v : d);
  const mesh = s?.mesh ?? {};
  const byKind = s?.by_kind ?? {};
  return {
    nodes: num(s?.nodes, base.nodes),
    cpu_cores: num(s?.cpu_cores, base.cpu_cores),
    cpu_gflops: num(s?.cpu_gflops, base.cpu_gflops),
    gpus: num(s?.gpus, base.gpus),
    gpu_vram_mb: num(s?.gpu_vram_mb, base.gpu_vram_mb),
    gpu_tflops: num(s?.gpu_tflops, base.gpu_tflops),
    tokens_per_sec: num(s?.tokens_per_sec, base.tokens_per_sec),
    storage_free_gb: num(s?.storage_free_gb, base.storage_free_gb),
    perf_score: num(s?.perf_score, base.perf_score),
    mesh: {
      median_rtt_ms: num(mesh.median_rtt_ms, base.mesh.median_rtt_ms),
      reachable_frac: num(mesh.reachable_frac, base.mesh.reachable_frac),
      regions: num(mesh.regions, base.mesh.regions),
    },
    by_kind: {
      native: num(byKind.native, base.by_kind.native),
      container: num(byKind.container, base.by_kind.container),
      browser: num(byKind.browser, base.by_kind.browser),
    },
    computed_at: num(s?.computed_at, nowSecs()),
  };
}

// ---------------------------------------------------------------------------
// 7. verified variant (Sybil-weighted)
// ---------------------------------------------------------------------------

/**
 * Per-node trust factor in [0,1] derived from `/history` WITHOUT float-money math. A node that has
 * actually delivered work (`jobs_hosted` > 0, an integer count) and has non-zero cumulative `earned`
 * (presence-tested as a non-"0"/non-empty decimal string — never parsed to a float) is trusted; an
 * unbonded, no-history profile gets ~0 placement weight per nodeprofile-spec §4.
 *
 * @param {any} hist a `/history/:node_id` NodeStats object (or null)
 * @returns {number} 0..1
 */
export function historyTrust(hist) {
  if (!hist || typeof hist !== "object") return 0;
  const jobs = isFiniteNum(hist.jobs_hosted) ? hist.jobs_hosted : 0;
  const earnedStr = typeof hist.earned === "string" ? hist.earned : "0";
  const hasEarned = /[1-9]/.test(earnedStr); // any non-zero digit ⇒ earned > 0 (no float parse)
  if (jobs <= 0 && !hasEarned) return 0;
  // Saturating curve on the integer job count: 1 job ≈ 0.5, 8 jobs ≈ ~0.9, asymptote 1.
  // jobs/(jobs+1) is a safe, monotonic, dependency-free saturation. Earned presence floors it at 0.2.
  const fromJobs = jobs > 0 ? jobs / (jobs + 1) : 0;
  return Math.max(fromJobs, hasEarned ? 0.2 : 0);
}

/**
 * `verified` variant: weight each node's capability contribution by {@link historyTrust} (a Sybil
 * gate). Returns the raw FabricStats PLUS a `verified` block with bond/history-weighted *_verified
 * totals so the UI can show "X GFLOPS (Y verified)". Unbonded/no-history nodes count toward display
 * totals but ~0 toward verified.
 *
 * Weighting model: each node's contribution to the robust-summed fields is scaled by its trust; the
 * scaled values then go through the same robustSum clamp. Counts (cores, gpus, vram, storage, nodes)
 * are reported as the trust-weighted ROUNDED sum so they stay integers and comparable.
 *
 * @param {{fabricStats?:Function, profiles?:Function, signals?:Function, netgraph?:Function,
 *          history?:Function}} ce
 * @param {{clampK?:number, maxAgeSecs?:number, regionThresholdMs?:number, now?:number,
 *          weights?:object, trustOf?:(nodeId:string)=>Promise<number>|number}} [opts]
 *        `trustOf` lets a caller inject trust (tests / a precomputed map) instead of hitting
 *        `/history` per node.
 * @returns {Promise<import("./types.js").FabricStats & {verified:object}>}
 */
export async function computeVerifiedStats(ce, opts = {}) {
  if (!ce) throw new Error("computeVerifiedStats: a CeClient-shaped client is required");

  const raw = await collectProfiles(ce);
  const profiles = dedupeLatest(raw, { maxAgeSecs: opts.maxAgeSecs, now: opts.now });

  // raw display totals (re-use the standard path so display and verified come from one collection)
  const display = aggregateCompute(profiles, { clampK: opts.clampK });

  // resolve per-node trust
  /** @type {Map<string,number>} */
  const trust = new Map();
  for (const p of profiles) {
    let t = 0;
    if (typeof opts.trustOf === "function") {
      t = await opts.trustOf(p.node_id);
    } else if (typeof ce.history === "function") {
      try {
        t = historyTrust(await ce.history(p.node_id));
      } catch {
        t = 0;
      }
    }
    trust.set(p.node_id, isFiniteNum(t) ? Math.max(0, Math.min(1, t)) : 0);
  }

  const clampK = isFiniteNum(opts.clampK) ? opts.clampK : DEFAULT_CLAMP_K;
  let v_nodes = 0;
  let v_cpu_cores = 0;
  let v_gpus = 0;
  let v_gpu_vram_mb = 0;
  let v_storage_free_gb = 0;
  const cpuGflopsW = [];
  const gpuTflopsW = [];
  const tokensW = [];

  for (const p of profiles) {
    const w = trust.get(p.node_id) ?? 0;
    if (w > 0) v_nodes += 1;
    v_cpu_cores += (isFiniteNum(p.cpu?.cores) ? p.cpu.cores : 0) * w;
    let nodeTflops = 0;
    let nodeVram = 0;
    let nodeGpus = 0;
    for (const g of p.gpus ?? []) {
      nodeGpus += 1;
      nodeVram += isFiniteNum(g.vram_mb) ? g.vram_mb : 0;
      nodeTflops += isFiniteNum(g.fp16_tflops) ? g.fp16_tflops : 0;
    }
    v_gpus += nodeGpus * w;
    v_gpu_vram_mb += nodeVram * w;
    v_storage_free_gb += (isFiniteNum(p.storage?.free_gb) ? p.storage.free_gb : 0) * w;

    cpuGflopsW.push((isFiniteNum(p.cpu?.gflops_fp32) ? p.cpu.gflops_fp32 : 0) * w);
    gpuTflopsW.push(nodeTflops * w);
    tokensW.push((isFiniteNum(p.llm?.tokens_per_sec) ? p.llm.tokens_per_sec : 0) * w);
  }

  const verified = {
    nodes_verified: v_nodes,
    cpu_cores_verified: Math.round(v_cpu_cores),
    cpu_gflops_verified: robustSum(cpuGflopsW, clampK).sum,
    gpus_verified: Math.round(v_gpus),
    gpu_vram_mb_verified: Math.round(v_gpu_vram_mb),
    gpu_tflops_verified: robustSum(gpuTflopsW, clampK).sum,
    tokens_per_sec_verified: robustSum(tokensW, clampK).sum,
    storage_free_gb_verified: Math.round(v_storage_free_gb),
  };
  verified.perf_score_verified = perfScore(
    {
      cpu_gflops: verified.cpu_gflops_verified,
      gpu_tflops: verified.gpu_tflops_verified,
      tokens_per_sec: verified.tokens_per_sec_verified,
    },
    opts.weights,
  );

  // mesh (same as the display path)
  let mesh = { median_rtt_ms: 0, reachable_frac: profiles.length <= 1 ? 1 : 0, regions: 0 };
  if (typeof ce.netgraph === "function") {
    try {
      const edges = await ce.netgraph();
      mesh = meshHealth(Array.isArray(edges) ? edges : [], {
        regionThresholdMs: opts.regionThresholdMs,
        extraNodes: profiles.map((p) => p.node_id),
      });
    } catch {
      /* keep default */
    }
  }

  const stats = normalizeStats({ ...emptyFabricStats(), ...display, mesh, computed_at: nowSecs() });
  stats.perf_score = perfScore(stats, opts.weights);
  return { ...stats, verified };
}

// ---------------------------------------------------------------------------
// self-test (offline; no network, no deps)
// ---------------------------------------------------------------------------

/** @returns {import("./types.js").NodeProfile} a valid synthetic profile */
function synthProfile(id, over = {}) {
  /** @type {import("./types.js").NodeProfile} */
  const p = {
    node_id: id,
    schema: 1,
    measured_at: nowSecs() - 60,
    beacon_height: 1000,
    beacon_hash: "ab",
    bench_app: "ce-bench@0.0.1",
    cpu: { cores: 8, threads: 16, gflops_fp32: 100, mem_bw_gbps: 30 },
    gpus: [],
    memory: { total_mb: 16000, available_mb: 8000 },
    storage: { total_gb: 500, free_gb: 200, read_mbps: 500, write_mbps: 400 },
    llm: { ref_model: "ref-micro", tokens_per_sec: 20, ctx_tokens: 2048 },
    runtime: { os: "linux", arch: "x86_64", docker: true, gvisor: false, wasm: true, webgpu: false, kind: "Native" },
    samples: [],
  };
  return Object.assign(p, over);
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`__selftest FAILED: ${msg}`);
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/**
 * Offline self-test: exercises every export against synthetic data and a fake injected client.
 * Throws on the first failure; returns a small summary object on success.
 * @returns {object}
 */
export function __selftest() {
  const id = (c) => c.repeat(64);

  // --- median / robustSum ---
  assert(median([]) === 0, "median([]) === 0");
  assert(median([5]) === 5, "median single");
  assert(median([1, 3, 2]) === 2, "median odd");
  assert(median([1, 2, 3, 4]) === 2.5, "median even");
  {
    // one absurd outlier dropped: median of [10,10,10,1000] = 10, cap = 8*10 = 80 ⇒ drop 1000.
    const r = robustSum([10, 10, 10, 1000], 8);
    assert(r.sum === 30 && r.dropped === 1, `robustSum clamp (got sum=${r.sum} dropped=${r.dropped})`);
  }
  {
    const r = robustSum([0, 0, 5], 8); // median 0 ⇒ no upper bound ⇒ keep all
    assert(r.sum === 5 && r.dropped === 0, "robustSum zero-median keeps non-zero");
  }

  // --- aggregateCompute ---
  const A = synthProfile(id("a"));
  const B = synthProfile(id("b"), {
    cpu: { cores: 4, threads: 8, gflops_fp32: 50, mem_bw_gbps: 20 },
    gpus: [{ model: "X", backend: "Cuda", vram_mb: 24000, fp16_tflops: 80 }],
    storage: { total_gb: 1000, free_gb: 300, read_mbps: 1, write_mbps: 1 },
    llm: { ref_model: "ref-micro", tokens_per_sec: 40, ctx_tokens: 4096 },
    runtime: { os: "linux", arch: "arm64", docker: false, gvisor: false, wasm: true, webgpu: true, kind: "Browser" },
  });
  const agg = aggregateCompute([A, B]);
  assert(agg.nodes === 2, "agg.nodes");
  assert(agg.cpu_cores === 12, `agg.cpu_cores (got ${agg.cpu_cores})`);
  assert(approx(agg.cpu_gflops, 150), `agg.cpu_gflops (got ${agg.cpu_gflops})`);
  assert(agg.gpus === 1 && agg.gpu_vram_mb === 24000, "agg gpu pool");
  assert(approx(agg.gpu_tflops, 80), `agg.gpu_tflops (got ${agg.gpu_tflops})`);
  assert(approx(agg.tokens_per_sec, 60), `agg.tokens (got ${agg.tokens_per_sec})`);
  assert(agg.storage_free_gb === 500, "agg.storage");
  assert(agg.by_kind.native === 1 && agg.by_kind.browser === 1, "agg.by_kind");

  // --- perfScore ---
  const ps = perfScore(agg);
  // 1*150 + 1*80*1000 + 0.5*60 = 150 + 80000 + 30 = 80180
  assert(approx(ps, 80180), `perfScore (got ${ps})`);

  // --- dedupeLatest: keep freshest, drop stale + invalid ---
  const old = synthProfile(id("a"), { measured_at: nowSecs() - 60 });
  const fresh = synthProfile(id("a"), { measured_at: nowSecs() - 5, cpu: { cores: 99, threads: 1, gflops_fp32: 1, mem_bw_gbps: 1 } });
  const stale = synthProfile(id("c"), { measured_at: nowSecs() - 10 * 24 * 3600 });
  const bad = { node_id: "nope", schema: 1 };
  const dd = dedupeLatest([old, fresh, stale, bad]);
  assert(dd.length === 1, `dedupe length (got ${dd.length})`);
  assert(dd[0].cpu.cores === 99, "dedupe keeps freshest");

  // --- meshHealth: raw single-vantage netgraph (star) ---
  const ng = [
    { peer: id("b"), rtt_ms: 10, samples: 5, last_seen_secs: nowSecs() },
    { peer: id("c"), rtt_ms: 20, samples: 5, last_seen_secs: nowSecs() },
    { peer: id("d"), rtt_ms: 200, samples: 5, last_seen_secs: nowSecs() }, // above region threshold
  ];
  const mh = meshHealth(ng, { selfId: id("s") });
  // nodes: self,b,c,d = 4. Star ⇒ fully connected component ⇒ reachable_frac = 1.
  assert(approx(mh.reachable_frac, 1), `mesh reachable_frac star (got ${mh.reachable_frac})`);
  // median of fused edge RTTs [10,20,200] = 20.
  assert(mh.median_rtt_ms === 20, `mesh median (got ${mh.median_rtt_ms})`);
  // regions under 30ms: self joins b(10) and c(20) but NOT d(200). So {self,b,c} + {d} = 2 regions.
  assert(mh.regions === 2, `mesh regions (got ${mh.regions})`);

  // --- meshHealth: disconnected pairs lower reachable_frac ---
  const ng2 = [
    { a: id("a"), b: id("b"), rttMs: 5, samples: 3 },
    { a: id("c"), b: id("d"), rttMs: 5, samples: 3 },
  ];
  const mh2 = meshHealth(ng2);
  // 4 nodes, 6 pairs, two components of size 2 ⇒ 1+1 = 2 reachable pairs ⇒ 2/6.
  assert(approx(mh2.reachable_frac, 2 / 6), `mesh disjoint frac (got ${mh2.reachable_frac})`);

  // --- fusion: two directions of the same pair, sample-weighted ---
  const fused = fuseEdges([
    { origin: id("a"), peer: id("b"), rtt_ms: 10, samples: 1 },
    { origin: id("b"), peer: id("a"), rtt_ms: 20, samples: 3 },
  ]);
  assert(fused.edges.length === 1, "fuse single pair");
  // (10*1 + 20*3)/(1+3) = 70/4 = 17.5
  assert(approx(fused.edges[0].rttMs, 17.5), `fuse weighted mean (got ${fused.edges[0].rttMs})`);

  // --- profileFromSignal round-trip via hex ---
  const toHexLocal = (str) => {
    const bytes = new TextEncoder().encode(str);
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
  };
  const sig = {
    capabilities: [{ name: "nodeprofile", version: 1 }],
    payload_hex: toHexLocal(JSON.stringify(A)),
  };
  const decoded = profileFromSignal(sig);
  assert(decoded && decoded.node_id === A.node_id, "profileFromSignal round-trips");
  assert(profileFromSignal({ payload_hex: toHexLocal('{"not":"a profile"}') }) === null, "rejects non-profile json");

  // --- historyTrust (no float-money) ---
  assert(historyTrust(null) === 0, "trust null");
  assert(historyTrust({ jobs_hosted: 0, earned: "0" }) === 0, "trust empty");
  assert(approx(historyTrust({ jobs_hosted: 1, earned: "0" }), 0.5), "trust 1 job");
  assert(historyTrust({ jobs_hosted: 0, earned: "5000" }) === 0.2, "trust earned-only floor");
  assert(historyTrust({ jobs_hosted: 100, earned: "1" }) > 0.98, "trust saturates");

  // --- end-to-end with a fake injected client (no network) ---
  const fakeCe = {
    async fabricStats() {
      return null; // force client-side compute
    },
    async profiles() {
      return [A, B];
    },
    async signals() {
      return [];
    },
    async netgraph() {
      return ng;
    },
    async history(nodeId) {
      // node A has delivered work; node B is an unbonded browser with no history
      return nodeId === A.node_id ? { jobs_hosted: 10, earned: "1000000" } : { jobs_hosted: 0, earned: "0" };
    },
  };

  // computeFabricStats must be async and return a complete, finite stats object.
  let cfsResult;
  let cvsResult;
  let asyncOk = false;
  Promise.all([computeFabricStats(fakeCe), computeVerifiedStats(fakeCe)])
    .then(([cfs, cvs]) => {
      cfsResult = cfs;
      cvsResult = cvs;
      asyncOk = true;
    })
    .catch((e) => {
      throw e;
    });

  // synchronous structural checks already cover the pure functions; the async path is verified by
  // the dedicated __selftestAsync() below (callers can await it). Here we just confirm the promise
  // was created without throwing synchronously.
  assert(typeof computeFabricStats(fakeCe).then === "function", "computeFabricStats returns a promise");
  void cfsResult;
  void cvsResult;
  void asyncOk;

  return {
    ok: true,
    checks: "median, robustSum, aggregateCompute, perfScore, dedupeLatest, meshHealth(star+disjoint), fuseEdges, profileFromSignal, historyTrust, async-shape",
  };
}

/**
 * Async companion to {@link __selftest}: awaits the full collect→dedupe→aggregate→mesh→perf path and
 * the verified variant against an in-memory fake client. Returns the two computed stats objects.
 * @returns {Promise<{display:import("./types.js").FabricStats, verified:object}>}
 */
export async function __selftestAsync() {
  const id = (c) => c.repeat(64);
  const A = synthProfile(id("a"));
  const B = synthProfile(id("b"), {
    cpu: { cores: 4, threads: 8, gflops_fp32: 50, mem_bw_gbps: 20 },
    gpus: [{ model: "X", backend: "Cuda", vram_mb: 24000, fp16_tflops: 80 }],
    llm: { ref_model: "ref-micro", tokens_per_sec: 40, ctx_tokens: 4096 },
    runtime: { os: "linux", arch: "arm64", docker: false, gvisor: false, wasm: true, webgpu: true, kind: "Browser" },
  });
  const ng = [
    { peer: id("b"), rtt_ms: 10, samples: 5, last_seen_secs: nowSecs() },
    { peer: id("c"), rtt_ms: 20, samples: 5, last_seen_secs: nowSecs() },
  ];
  const fakeCe = {
    async fabricStats() {
      return null;
    },
    async profiles() {
      return [A, B];
    },
    async signals() {
      return [];
    },
    async netgraph() {
      return ng;
    },
    async history(nodeId) {
      return nodeId === A.node_id ? { jobs_hosted: 10, earned: "1000000" } : { jobs_hosted: 0, earned: "0" };
    },
  };

  const display = await computeFabricStats(fakeCe);
  assert(display.nodes === 2, "async display.nodes");
  assert(display.cpu_cores === 12, `async cpu_cores (got ${display.cpu_cores})`);
  assert(display.gpu_vram_mb === 24000, "async vram pool");
  assert(display.by_kind.native === 1 && display.by_kind.browser === 1, "async by_kind");
  assert(Number.isFinite(display.perf_score) && display.perf_score > 0, "async perf_score finite>0");
  assert(Number.isFinite(display.mesh.median_rtt_ms), "async mesh median finite");
  // node set = {self,b,c} (from netgraph) ∪ {a} (profile-only, no measured edge). The component
  // {self,b,c} has 3 reachable pairs of 6 total ⇒ 0.5; profile-only `a` is correctly unreachable.
  assert(approx(display.mesh.reachable_frac, 0.5), `async reachable_frac (got ${display.mesh.reachable_frac})`);

  const verified = await computeVerifiedStats(fakeCe);
  // A is trusted (jobs=10 ⇒ ~0.909), B has 0 trust ⇒ verified totals come only from A.
  assert(verified.verified.nodes_verified === 1, `verified nodes (got ${verified.verified.nodes_verified})`);
  assert(verified.verified.gpus_verified === 0, "verified gpus excludes untrusted B");
  assert(
    verified.verified.cpu_gflops_verified > 0 && verified.verified.cpu_gflops_verified < display.cpu_gflops,
    `verified cpu_gflops between 0 and display (got ${verified.verified.cpu_gflops_verified} vs ${display.cpu_gflops})`,
  );
  // node-served path: when fabricStats() returns a real object, it must be preferred.
  const servedCe = {
    async fabricStats() {
      return { nodes: 7, cpu_cores: 100, cpu_gflops: 9, gpus: 2, gpu_vram_mb: 1, gpu_tflops: 3, tokens_per_sec: 5, storage_free_gb: 4, perf_score: 42, mesh: { median_rtt_ms: 12, reachable_frac: 0.9, regions: 3 }, by_kind: { native: 5, container: 1, browser: 1 }, computed_at: nowSecs() };
    },
  };
  const served = await computeFabricStats(servedCe);
  assert(served.nodes === 7 && served.mesh.regions === 3, "prefers node-served /fabric/stats");

  return { display, verified };
}
