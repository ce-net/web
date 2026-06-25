/**
 * @ce-net/bench — assemble + sign + publish a NodeProfile.
 *
 * OWNER: implementer C. Depends on types.js (NodeProfile/validateProfile/PROFILE_SCHEMA),
 * ce.js (CeClient + toHex), and (only inside buildAndPublish) runner.js (benchLocal) — the latter is
 * loaded lazily so this module's pure parts (detectEnv/assembleProfile/canonicalBytes) have no probe
 * dependency and `__selftest()` runs fully offline. Implements docs/nodeprofile-spec.md §1-3.
 *
 * This module turns a BenchResult[] + environment detection into a structurally-valid NodeProfile,
 * gets it SIGNED by the node (the node holds the key; the app never does), and publishes it.
 *
 * BOUNDARIES (do not cross — other modules own these):
 *  - NO measurement math here. Headline scalars arrive as BenchResult[]; this module only folds them
 *    into profile fields. Kernels/measurement live in benchmarks.js, orchestration in runner.js.
 *  - NO aggregation/scoreboard here. That is fabricstats.js.
 *  - NO key handling here. Signing is the node's job (POST /profile/publish); the app never sees a key.
 *
 * MONEY: nothing in a profile is money. The only money-adjacent value is the optional `burnTxIdHex`
 * that the CEP-1 signal fallback forwards verbatim as an opaque string (see ce.sendSignal). This
 * module never parses an amount to a JS number.
 *
 * @packageDocumentation
 */

import { validateProfile, PROFILE_SCHEMA, BACKENDS, NODE_KINDS } from "./types.js";
import { toHex } from "./ce.js";

/** @typedef {import("./types.js").NodeProfile} NodeProfile */
/** @typedef {import("./types.js").BenchResult} BenchResult */
/** @typedef {import("./types.js").GpuInfo} GpuInfo */
/** @typedef {import("./ce.js").CeClient} CeClient */

/**
 * Detected environment + static machine facts (the capability flags + base sizing that aren't
 * "performance"). These seed the profile's `runtime`, `cpu.cores/threads`, `memory`, and `storage`
 * shells before the measured scalars are folded in.
 *
 * @typedef {object} ProfileEnv
 * @property {string} os                 e.g. "darwin" | "linux" | "win32" | a browser platform string.
 * @property {string} arch              e.g. "arm64" | "x64" | "wasm".
 * @property {number} cores             Logical CPU count (best-effort).
 * @property {number} threads           Hardware threads (== cores when unknown).
 * @property {number} total_mb          Total RAM in MB (0 when not detectable, e.g. a browser tab).
 * @property {number} available_mb      Free RAM in MB (0 when unknown).
 * @property {number} total_gb          Total disk GB (0 when unknown — browsers can't see disks).
 * @property {number} free_gb           Free disk GB (0 when unknown).
 * @property {boolean} docker           Container runtime reachable (always false in a browser).
 * @property {boolean} gvisor           gVisor sandbox detected.
 * @property {boolean} wasm             WebAssembly available.
 * @property {boolean} webgpu           WebGPU available (navigator.gpu / native probe).
 * @property {typeof NODE_KINDS[number]} kind  "Native" | "Container" | "Browser".
 * @property {GpuInfo[]} [gpus]         Detected accelerators (model/backend/vram); perf filled later.
 */

/** Producer id stamped into every profile. Bump with the package version. */
export const BENCH_APP = "ce-bench@0.0.1";

/** Max raw-evidence samples a profile may carry (gossip frame budget — mirrors validateProfile). */
const MAX_SAMPLES = 16;

const FINITE = (v) => typeof v === "number" && Number.isFinite(v);
const NN = (v) => (FINITE(v) && v >= 0 ? v : 0);
const INT = (v) => Math.max(0, Math.round(NN(v)));

/* ----------------------------------------------------------------------------------------------- *
 * 1. environment detection
 * ----------------------------------------------------------------------------------------------- */

/**
 * Detect the current environment. Works in Node (node:os / process) and in a browser tab
 * (navigator.*), mirroring how web/site/node.html's detect() reports a browser node. Never throws —
 * undetectable fields default to 0 / false so a partial environment still yields a valid shell.
 *
 * @param {object} [opts]
 * @param {ProfileEnv} [opts.override]   Inject a fully-formed env (tests / a capsule that already knows).
 * @returns {Promise<ProfileEnv>}
 */
export async function detectEnv(opts = {}) {
  if (opts.override) return normalizeEnv(opts.override);

  // --- Node-like runtime (has process + can import node:os) ---
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    return normalizeEnv(await detectNodeEnv());
  }

  // --- Browser / WASM tab ---
  if (typeof navigator !== "undefined") {
    return normalizeEnv(await detectBrowserEnv());
  }

  // --- Unknown runtime: minimal valid shell ---
  return normalizeEnv({ os: "unknown", arch: "unknown", kind: "Native" });
}

/** Node environment from node:os + process. Returns a partial ProfileEnv (normalizeEnv fills gaps). */
async function detectNodeEnv() {
  /** @type {Partial<ProfileEnv>} */
  const env = {
    os: process.platform || "unknown",
    arch: process.arch || "unknown",
    wasm: typeof WebAssembly !== "undefined",
    webgpu: typeof navigator !== "undefined" && !!(/** @type {any} */ (navigator).gpu),
    kind: "Native",
  };
  try {
    const os = await import("node:os");
    const cpus = typeof os.cpus === "function" ? os.cpus() : [];
    env.cores = Array.isArray(cpus) ? cpus.length : 0;
    env.threads = env.cores;
    const total = typeof os.totalmem === "function" ? os.totalmem() : 0;
    const free = typeof os.freemem === "function" ? os.freemem() : 0;
    env.total_mb = Math.round(total / (1024 * 1024));
    env.available_mb = Math.round(free / (1024 * 1024));
  } catch {
    /* os not importable (e.g. a restricted runtime) — leave sizing at defaults */
  }
  // Container/gVisor heuristics: presence of /.dockerenv etc. is detected by the capsule that runs us;
  // we only set what we can observe here without filesystem probing (kept conservative).
  return env;
}

/** Browser environment from navigator.*, matching node.html's detect(). */
async function detectBrowserEnv() {
  const nav = /** @type {any} */ (navigator);
  /** @type {Partial<ProfileEnv>} */
  const env = {
    os: (nav.platform && String(nav.platform)) || (nav.userAgent && String(nav.userAgent)) || "browser",
    arch: "wasm",
    cores: Number(nav.hardwareConcurrency) || 0,
    threads: Number(nav.hardwareConcurrency) || 0,
    // deviceMemory is in GiB, coarse (browser privacy); 0 when unavailable.
    total_mb: FINITE(nav.deviceMemory) ? Math.round(nav.deviceMemory * 1024) : 0,
    available_mb: 0,
    total_gb: 0,
    free_gb: 0,
    docker: false,
    gvisor: false,
    wasm: typeof WebAssembly !== "undefined",
    webgpu: !!nav.gpu,
    kind: "Browser",
  };
  // navigator.connection (Chromium) is an advisory link hint, not a measurement. Optional everywhere.
  const c = nav.connection;
  if (c && typeof c === "object") {
    /** @type {any} */
    const link = {};
    if (typeof c.effectiveType === "string") link.type = c.effectiveType;
    if (Number.isFinite(c.downlink)) link.downlink_mbps = c.downlink;
    if (Number.isFinite(c.rtt)) link.rtt_ms = c.rtt;
    if (Object.keys(link).length) env.link = link;
  }
  return env;
}

/**
 * Coerce a partial/foreign env into a complete, sane ProfileEnv. Clamps numerics, validates enums.
 * @param {Partial<ProfileEnv>} e
 * @returns {ProfileEnv}
 */
function normalizeEnv(e) {
  const kind = NODE_KINDS.includes(/** @type {any} */ (e && e.kind)) ? /** @type {any} */ (e.kind) : "Native";
  /** @type {GpuInfo[]} */
  const gpus = Array.isArray(e && e.gpus) ? e.gpus.map(normalizeGpu) : [];
  return {
    os: typeof (e && e.os) === "string" && e.os ? e.os : "unknown",
    arch: typeof (e && e.arch) === "string" && e.arch ? e.arch : "unknown",
    cores: INT(e && e.cores),
    threads: INT(e && e.threads) || INT(e && e.cores),
    total_mb: INT(e && e.total_mb),
    available_mb: INT(e && e.available_mb),
    total_gb: INT(e && e.total_gb),
    free_gb: INT(e && e.free_gb),
    docker: !!(e && e.docker),
    gvisor: !!(e && e.gvisor),
    wasm: !!(e && e.wasm),
    webgpu: !!(e && e.webgpu),
    kind,
    gpus,
    link: e && typeof e.link === "object" ? e.link : undefined,
  };
}

/** Coerce one detected GPU descriptor; perf (fp16_tflops) defaults to 0 until a GPU probe runs. */
function normalizeGpu(g) {
  const backend = BACKENDS.includes(/** @type {any} */ (g && g.backend)) ? /** @type {any} */ (g.backend) : "None";
  return {
    model: typeof (g && g.model) === "string" ? g.model : "",
    backend,
    vram_mb: INT(g && g.vram_mb),
    fp16_tflops: NN(g && g.fp16_tflops),
  };
}

/* ----------------------------------------------------------------------------------------------- *
 * 2. assemble: BenchResult[] + ProfileEnv -> unsigned NodeProfile
 * ----------------------------------------------------------------------------------------------- */

/**
 * Pick the most representative BenchResult of a kind (highest metric — best observed run), or null.
 * @param {BenchResult[]} results
 * @param {BenchResult["kind"]} kind
 * @returns {BenchResult|null}
 */
function pick(results, kind) {
  let best = null;
  for (const r of results) {
    if (!r || r.kind !== kind || !FINITE(r.metric)) continue;
    if (!best || r.metric > best.metric) best = r;
  }
  return best;
}

/**
 * Fold a BenchResult[] + ProfileEnv into a structurally-valid UNSIGNED NodeProfile.
 *
 * Mapping (nodeprofile-spec §1 / runner contract):
 *   cpu_flops      -> cpu.gflops_fp32
 *   mem_bw         -> cpu.mem_bw_gbps
 *   disk_rw        -> storage.read_mbps / write_mbps (from raw.read_mbps/write_mbps; metric is a fallback)
 *   llm_tokens     -> llm.tokens_per_sec (+ raw.ref_model / raw.ctx_tokens when present)
 *   cpu_int        -> informational only (kept in samples, not a headline field)
 *   net_throughput -> NOT a profile field (it's an edge — handed to fabricstats/graph), dropped here
 *
 * GPU perf: if a sample carries `raw.gpu` ({model,backend,vram_mb,fp16_tflops}) it augments the
 * env-detected GPU list; otherwise env GPUs are used as-is (fp16_tflops:0 with backend recorded).
 *
 * @param {object} args
 * @param {string} args.nodeId                 64-hex node id (from ce.status().node_id).
 * @param {{height:number, hash:string}} args.beacon  Beacon captured at run START.
 * @param {BenchResult[]} args.results         Headline probes for THIS node.
 * @param {ProfileEnv} args.env                Detected environment.
 * @param {number} [args.measuredAt]           Override unix seconds (default now).
 * @param {string} [args.benchApp]             Override producer id (default BENCH_APP).
 * @returns {NodeProfile}   unsigned (no `sig`); throws with the problem list if validation fails.
 */
export function assembleProfile(args) {
  const { nodeId, beacon, env } = args || {};
  const results = Array.isArray(args && args.results) ? args.results : [];
  if (typeof nodeId !== "string") throw new Error("assembleProfile: nodeId (string) required");
  if (!beacon || typeof beacon !== "object") throw new Error("assembleProfile: beacon {height,hash} required");
  const e = normalizeEnv(env || {});

  const flops = pick(results, "cpu_flops");
  const membw = pick(results, "mem_bw");
  const disk = pick(results, "disk_rw");
  const llm = pick(results, "llm_tokens");

  // storage read/write: prefer explicit raw fields, fall back to the headline metric for both.
  const diskRaw = (disk && disk.raw) || {};
  const readMbps = INT(FINITE(diskRaw.read_mbps) ? diskRaw.read_mbps : disk ? disk.metric : 0);
  const writeMbps = INT(FINITE(diskRaw.write_mbps) ? diskRaw.write_mbps : disk ? disk.metric : 0);

  const llmRaw = (llm && llm.raw) || {};

  /** @type {NodeProfile} */
  const profile = {
    node_id: nodeId,
    schema: PROFILE_SCHEMA,
    measured_at: INT(FINITE(args.measuredAt) ? args.measuredAt : Math.floor(Date.now() / 1000)),
    beacon_height: INT(beacon.height),
    beacon_hash: typeof beacon.hash === "string" ? beacon.hash : "",
    bench_app: typeof args.benchApp === "string" && args.benchApp ? args.benchApp : BENCH_APP,

    cpu: {
      cores: INT(e.cores),
      threads: INT(e.threads) || INT(e.cores),
      gflops_fp32: flops ? NN(flops.metric) : 0,
      mem_bw_gbps: membw ? NN(membw.metric) : 0,
    },
    gpus: mergeGpus(e.gpus || [], results),
    memory: {
      total_mb: INT(e.total_mb),
      available_mb: INT(e.available_mb),
    },
    storage: {
      total_gb: INT(e.total_gb),
      free_gb: INT(e.free_gb),
      read_mbps: readMbps,
      write_mbps: writeMbps,
    },
    llm: {
      ref_model: typeof llmRaw.ref_model === "string" ? llmRaw.ref_model : llm ? "ce-ref-micro" : "none",
      tokens_per_sec: llm ? NN(llm.metric) : 0,
      ctx_tokens: INT(llmRaw.ctx_tokens),
    },
    runtime: {
      os: e.os,
      arch: e.arch,
      docker: !!e.docker,
      gvisor: !!e.gvisor,
      wasm: !!e.wasm,
      webgpu: !!e.webgpu,
      kind: e.kind,
    },
    samples: selectSamples(results),
  };

  // Optional network-quality axis: from a measured probe (args.network) and/or browser link hints
  // (env.link). Only attached when something is known, so older/limited nodes stay valid.
  const network = buildNetwork(args.network, e.link);
  if (network) profile.network = network;

  const problems = validateProfile(profile);
  if (problems.length) {
    throw new Error("assembleProfile: invalid profile — " + problems.join("; "));
  }
  return profile;
}

/**
 * Build the optional `network` axis from a measured probe and/or browser link hints. Returns
 * `undefined` when nothing is known (so the field is omitted rather than a misleading all-zero).
 * @param {any} measured  {relay_rtt_ms?, down_mbps?, up_mbps?}
 * @param {any} link      browser navigator.connection hint {type?, downlink_mbps?, rtt_ms?}
 * @returns {import("./types.js").NetworkInfo | undefined}
 */
function buildNetwork(measured, link) {
  /** @type {any} */
  const n = {};
  const numOpt = (v) => (FINITE(v) && v >= 0 ? v : undefined);
  if (measured && typeof measured === "object") {
    if (numOpt(measured.relay_rtt_ms) !== undefined) n.relay_rtt_ms = measured.relay_rtt_ms;
    if (numOpt(measured.down_mbps) !== undefined) n.down_mbps = measured.down_mbps;
    if (numOpt(measured.up_mbps) !== undefined) n.up_mbps = measured.up_mbps;
  }
  if (link && typeof link === "object") {
    const l = {};
    if (typeof link.type === "string" && link.type) l.type = link.type;
    if (numOpt(link.downlink_mbps) !== undefined) l.downlink_mbps = link.downlink_mbps;
    if (numOpt(link.rtt_ms) !== undefined) l.rtt_ms = link.rtt_ms;
    if (Object.keys(l).length) n.link = l;
  }
  return Object.keys(n).length ? n : undefined;
}

/**
 * Merge env-detected GPUs with any GPU evidence carried in samples (`raw.gpu`). Env entries win on
 * model identity; sample evidence supplies fp16_tflops when the env couldn't measure it.
 * @param {GpuInfo[]} envGpus
 * @param {BenchResult[]} results
 * @returns {GpuInfo[]}
 */
function mergeGpus(envGpus, results) {
  /** @type {GpuInfo[]} */
  const out = envGpus.map(normalizeGpu);
  for (const r of results) {
    const g = r && r.raw && r.raw.gpu;
    if (!g || typeof g !== "object") continue;
    const cand = normalizeGpu(g);
    const match = out.find((x) => x.model && cand.model && x.model === cand.model);
    if (match) {
      if (!match.fp16_tflops && cand.fp16_tflops) match.fp16_tflops = cand.fp16_tflops;
      if (!match.vram_mb && cand.vram_mb) match.vram_mb = cand.vram_mb;
    } else {
      out.push(cand);
    }
  }
  return out;
}

/**
 * Choose <=16 small raw-evidence samples (one per probe, trimmed). net_throughput is an edge, not a
 * vertex — it's still useful evidence, so we keep it in samples but it maps to no headline field.
 * @param {BenchResult[]} results
 * @returns {BenchResult[]}
 */
function selectSamples(results) {
  /** @type {Map<string, BenchResult>} */
  const byKind = new Map();
  for (const r of results) {
    if (!r || typeof r.kind !== "string") continue;
    const cur = byKind.get(r.kind);
    // keep the best (highest metric) sample per kind as the representative evidence
    if (!cur || (FINITE(r.metric) && r.metric > cur.metric)) byKind.set(r.kind, r);
  }
  const samples = Array.from(byKind.values()).slice(0, MAX_SAMPLES);
  // shallow-trim each sample's raw to keep frames small (drop obviously oversized arrays/strings).
  return samples.map(trimSample);
}

/** Defensive size trim of a single sample (keep it under ~1 KB of raw evidence). */
function trimSample(r) {
  if (!r || typeof r !== "object") return r;
  const raw = r.raw && typeof r.raw === "object" ? r.raw : {};
  /** @type {Record<string, any>} */
  const small = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.length > 256) small[k] = v.slice(0, 256);
    else if (Array.isArray(v) && v.length > 16) small[k] = v.slice(0, 16);
    else small[k] = v;
  }
  return { ...r, raw: small };
}

/* ----------------------------------------------------------------------------------------------- *
 * 3. canonical bytes (what the node signs over)
 * ----------------------------------------------------------------------------------------------- */

/**
 * Canonical bytes the node signs over. The signature covers EVERY field except `sig`.
 *
 * Until the node defines its bincode field order (nodeprofile-spec §1/§2A), this uses a deterministic
 * JSON canonicalization: keys sorted recursively, no whitespace, numbers via JSON's own formatting.
 * profile.js and the node MUST agree on this encoding for the signature to verify — when the node
 * adopts bincode, replace BOTH sides together and bump PROFILE_SCHEMA.
 *
 * @param {NodeProfile} profile
 * @returns {Uint8Array}
 */
export function canonicalBytes(profile) {
  if (!profile || typeof profile !== "object") throw new Error("canonicalBytes: profile object required");
  // strip the signature: it is appended, never self-referential.
  const { sig: _sig, ...rest } = profile;
  void _sig;
  const json = canonicalJson(rest);
  return new TextEncoder().encode(json);
}

/**
 * Deterministic JSON: object keys sorted lexicographically at every depth, arrays preserved in order,
 * no insignificant whitespace. Rejects non-finite numbers (they'd serialize to null and break the
 * verifier). This is the single source of truth for the signed encoding on the app side.
 * @param {any} v
 * @returns {string}
 */
export function canonicalJson(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") {
    if (!Number.isFinite(v)) throw new Error("canonicalJson: non-finite number is not serializable");
    return JSON.stringify(v);
  }
  if (t === "boolean" || t === "string") return JSON.stringify(v);
  if (t === "bigint") throw new Error("canonicalJson: bigint not allowed (money/ids are strings)");
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (t === "object") {
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) {
      if (typeof v[k] === "undefined") continue; // omit undefined (matches JSON.stringify)
      parts.push(JSON.stringify(k) + ":" + canonicalJson(v[k]));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`canonicalJson: unsupported value type ${t}`);
}

/* ----------------------------------------------------------------------------------------------- *
 * 4. publish (publish-or-signal)
 * ----------------------------------------------------------------------------------------------- */

/**
 * Publish a profile. Tries the first-class path `POST /profile/publish` (the node validates freshness
 * + beacon, signs, stores, gossips, and returns the SIGNED profile). If that route is missing
 * (HTTP 404 / not-found), falls back to the CEP-1 stopgap: hex-encode the canonical bytes and broadcast
 * them as a `nodeprofile` signal via `ce.sendSignal` (nodeprofile-spec §2 stopgap). The signal is
 * itself signed by the node identity, so the profile inherits authenticity from the envelope.
 *
 * @param {CeClient} ce
 * @param {NodeProfile} profile          unsigned profile (no `sig`).
 * @param {object} [opts]
 * @param {string} [opts.burnTxIdHex]    64-hex burn tx id; REQUIRED by the node when a signal payload
 *                                       is non-empty (api.md). Surfaced as an error if the node demands
 *                                       it and it's missing — the profile is never silently dropped.
 * @param {string} [opts.to]             "broadcast" (default) or a target node id for the signal path.
 * @returns {Promise<{via:"publish"|"signal", signed?:NodeProfile, signalId?:string}>}
 */
export async function publish(ce, profile, opts = {}) {
  if (!ce || typeof ce.publishProfile !== "function") {
    throw new Error("publish: a CeClient with publishProfile/sendSignal is required");
  }
  const problems = validateProfile(profile);
  if (problems.length) throw new Error("publish: refusing to publish invalid profile — " + problems.join("; "));

  // (1) First-class path.
  try {
    const signed = await ce.publishProfile(profile);
    return { via: "publish", signed: /** @type {NodeProfile} */ (signed) };
  } catch (e) {
    if (!isNotFound(e)) throw e; // a real error (auth, validation) must surface, not silently fall back
  }

  // (2) Stopgap: CEP-1 signal carrying the canonical bytes.
  if (typeof ce.sendSignal !== "function") {
    throw new Error("publish: /profile/publish unavailable and CeClient has no sendSignal fallback");
  }
  const payloadHex = toHex(canonicalBytes(profile));
  const res = await ce.sendSignal({
    payloadHex,
    to: opts.to ?? "broadcast",
    capabilities: [{ name: "nodeprofile", version: 1 }],
    burnTxIdHex: opts.burnTxIdHex,
  });
  return { via: "signal", signalId: res && res.id };
}

/** True when an error looks like an HTTP 404 / missing-route (so the signal fallback is warranted). */
function isNotFound(err) {
  const m = err instanceof Error ? err.message : String(err);
  return /HTTP 404\b/.test(m) || /\bnot found\b/i.test(m);
}

/* ----------------------------------------------------------------------------------------------- *
 * 5. one-shot
 * ----------------------------------------------------------------------------------------------- */

/**
 * One-shot: detectEnv -> read /beacon (at run start) -> run the local suite -> assemble -> publish.
 * Reads the node id from /status. The benchmark runner is injected (`opts.runner`) for testability
 * and to keep the module graph acyclic; it defaults to the real `./runner.js`.
 *
 * @param {CeClient} ce
 * @param {object} [opts]
 * @param {ProfileEnv} [opts.env]            Override env detection.
 * @param {string} [opts.preset]             Bench preset key.
 * @param {string} [opts.burnTxIdHex]        For the signal fallback.
 * @param {{benchLocal:(ce:CeClient, o?:object)=>Promise<BenchResult[]>}} [opts.runner]  Injected runner.
 * @param {(o?:object)=>Promise<ProfileEnv>} [opts.detect]   Injected env detector (tests).
 * @returns {Promise<{profile:NodeProfile, via:"publish"|"signal", signed?:NodeProfile, signalId?:string}>}
 */
export async function buildAndPublish(ce, opts = {}) {
  if (!ce || typeof ce.status !== "function" || typeof ce.beacon !== "function") {
    throw new Error("buildAndPublish: CeClient with status()/beacon() required");
  }
  // node id
  const st = await ce.status();
  const nodeId = st && typeof st.node_id === "string" ? st.node_id : "";
  if (!nodeId) throw new Error("buildAndPublish: could not read node_id from /status");

  // beacon at run START (so measured_at/beacon are non-backdatable, §3)
  const b = await ce.beacon();
  const beacon = {
    height: Number(b && b.height) || 0,
    hash: b && typeof b.hash === "string" ? b.hash : "",
  };

  // env
  const detect = opts.detect || detectEnv;
  const env = opts.env ? normalizeEnv(opts.env) : await detect({});

  // measure (lazy-load the real runner unless one is injected)
  const runner = opts.runner || (await import("./runner.js"));
  const results = await runner.benchLocal(ce, {
    env: env.kind === "Browser" ? "browser" : "node",
    preset: opts.preset,
    seed: beacon,
  });

  // assemble + publish
  const profile = assembleProfile({ nodeId, beacon, results, env });
  const pub = await publish(ce, profile, { burnTxIdHex: opts.burnTxIdHex });
  return { profile, ...pub };
}

/* ----------------------------------------------------------------------------------------------- *
 * offline self-test — synthetic data, injected fakes; NEVER touches the network. Run: node src/profile.js
 * ----------------------------------------------------------------------------------------------- */

import { makeBenchResult } from "./types.js";

function assert(cond, msg) {
  if (!cond) throw new Error("selftest: " + msg);
}

/** Synthetic BenchResult[] covering every kind the folder maps. */
function syntheticResults(seed) {
  return [
    makeBenchResult({ kind: "cpu_flops", metric: 128.5, unit: "gflops", seed, raw: { opCount: 1e9 }, ms: 50, env: "node" }),
    makeBenchResult({ kind: "cpu_int", metric: 9000, unit: "mops", seed, raw: { opCount: 9e9 }, ms: 40, env: "node" }),
    makeBenchResult({ kind: "mem_bw", metric: 42.7, unit: "gbps", seed, raw: { bytes: 1e9 }, ms: 30, env: "node" }),
    makeBenchResult({ kind: "disk_rw", metric: 800, unit: "mbps", seed, raw: { read_mbps: 1200, write_mbps: 800 }, ms: 200, env: "node" }),
    makeBenchResult({ kind: "llm_tokens", metric: 37.2, unit: "tokens_per_sec", seed, raw: { ref_model: "ce-ref-micro", ctx_tokens: 2048 }, ms: 500, env: "node" }),
    makeBenchResult({ kind: "net_throughput", metric: 940, unit: "mbps", seed, raw: { peer: "x" }, ms: 100, env: "node" }),
  ];
}

/**
 * Offline self-test. Returns `{ ok, checks }` or throws on first failure. Exercises: detectEnv (real
 * runtime), assembleProfile field-folding + validation, canonical determinism/order, publish via the
 * first-class path AND the 404->signal fallback, and buildAndPublish end-to-end with injected fakes.
 * @returns {Promise<{ok:boolean, checks:string[]}>}
 */
export async function __selftest() {
  /** @type {string[]} */
  const checks = [];
  const seed = "deadbeefcafe";
  const nodeId = "a".repeat(64);
  const beacon = { height: 1234, hash: "00ff" };

  // 1. detectEnv on the actual runtime never throws and yields a valid-kind env.
  const env = await detectEnv();
  assert(NODE_KINDS.includes(env.kind), "detectEnv returns a valid NodeKind");
  assert(env.cores >= 0 && Number.isFinite(env.cores), "detectEnv cores sane");
  checks.push(`detectEnv ok (kind=${env.kind}, cores=${env.cores})`);

  // 1b. detectEnv override is honoured + normalized.
  const overridden = await detectEnv({ override: { os: "linux", arch: "x64", cores: 8, total_mb: 16384, kind: "Native", webgpu: true } });
  assert(overridden.os === "linux" && overridden.cores === 8 && overridden.threads === 8, "override env folds through");
  checks.push("detectEnv(override) ok");

  // 2. assembleProfile folds every kind into the right field and validates.
  const results = syntheticResults(seed);
  const prof = assembleProfile({ nodeId, beacon, results, env: overridden, measuredAt: 1000 });
  assert(prof.node_id === nodeId && prof.schema === PROFILE_SCHEMA, "identity/schema set");
  assert(prof.cpu.gflops_fp32 === 128.5, "cpu_flops -> cpu.gflops_fp32");
  assert(prof.cpu.mem_bw_gbps === 42.7, "mem_bw -> cpu.mem_bw_gbps");
  assert(prof.storage.read_mbps === 1200 && prof.storage.write_mbps === 800, "disk_rw raw -> storage r/w");
  assert(prof.llm.tokens_per_sec === 37.2 && prof.llm.ref_model === "ce-ref-micro" && prof.llm.ctx_tokens === 2048, "llm folded");
  assert(prof.cpu.cores === 8, "env cores -> cpu.cores");
  assert(prof.measured_at === 1000 && prof.beacon_height === 1234 && prof.beacon_hash === "00ff", "freshness fields");
  assert(prof.bench_app === BENCH_APP, "bench_app stamped");
  assert(validateProfile(prof).length === 0, "assembled profile is structurally valid");
  // net_throughput must NOT become a headline field but MAY survive as a sample.
  assert(!("net" in prof) && prof.cpu.gflops_fp32 > 0, "net_throughput not a vertex field");
  checks.push("assembleProfile ok (all kinds folded + valid)");

  // 2b. samples bounded + present.
  assert(Array.isArray(prof.samples) && prof.samples.length > 0 && prof.samples.length <= 16, "samples bounded 1..16");
  checks.push(`assembleProfile samples ok (${prof.samples.length})`);

  // 2c. assembleProfile rejects garbage (bad node id -> validation throws).
  let threw = false;
  try {
    assembleProfile({ nodeId: "short", beacon, results, env });
  } catch {
    threw = true;
  }
  assert(threw, "assembleProfile throws on invalid node id");
  checks.push("assembleProfile rejects invalid input");

  // 3. canonicalBytes/canonicalJson are deterministic, key-sorted, and exclude `sig`.
  const cj = canonicalJson({ b: 2, a: 1, c: { z: 9, y: 8 } });
  assert(cj === '{"a":1,"b":2,"c":{"y":8,"z":9}}', `canonicalJson sorts keys at all depths: ${cj}`);
  const bytes1 = canonicalBytes(prof);
  const bytes2 = canonicalBytes({ ...prof, sig: "ff".repeat(64) });
  assert(bytes1.length === bytes2.length, "canonicalBytes ignores sig (same length with/without)");
  const s1 = new TextDecoder().decode(bytes1);
  const s2 = new TextDecoder().decode(bytes2);
  assert(s1 === s2, "canonicalBytes excludes sig (identical encoding)");
  assert(!s1.includes('"sig"'), "canonical encoding never contains sig");
  // re-encoding the same profile is byte-identical (determinism).
  assert(new TextDecoder().decode(canonicalBytes(prof)) === s1, "canonicalBytes deterministic");
  // non-finite numbers are rejected.
  let nf = false;
  try {
    canonicalJson({ x: Infinity });
  } catch {
    nf = true;
  }
  assert(nf, "canonicalJson rejects non-finite numbers");
  checks.push("canonicalBytes/canonicalJson ok (sorted, deterministic, sig-excluded)");

  // 4. publish — first-class path returns the signed profile.
  const signedProfile = { ...prof, sig: "ab".repeat(64) };
  const ceOk = /** @type {any} */ ({
    publishProfile: async (p) => {
      assert(validateProfile(p).length === 0, "node received a valid profile");
      return signedProfile;
    },
    sendSignal: async () => {
      throw new Error("selftest: should not reach signal path when publish succeeds");
    },
  });
  const pubA = await publish(ceOk, prof);
  assert(pubA.via === "publish" && pubA.signed && pubA.signed.sig, "publish uses first-class path");
  checks.push("publish(first-class) ok");

  // 4b. publish — 404 falls back to a signal carrying the canonical bytes hex.
  /** @type {any} */
  let captured = null;
  const ce404 = /** @type {any} */ ({
    publishProfile: async () => {
      throw new Error("HTTP 404 POST /profile/publish: not found");
    },
    sendSignal: async (a) => {
      captured = a;
      return { id: "sig-1", nonce: 7 };
    },
  });
  const pubB = await publish(ce404, prof, { burnTxIdHex: "cd".repeat(32) });
  assert(pubB.via === "signal" && pubB.signalId === "sig-1", "publish falls back to signal on 404");
  assert(captured && captured.payloadHex === toHex(canonicalBytes(prof)), "signal payload = canonical bytes hex");
  assert(captured.burnTxIdHex === "cd".repeat(32), "burn tx id forwarded to signal");
  assert(captured.capabilities[0].name === "nodeprofile", "signal advertises nodeprofile capability");
  checks.push("publish(404 -> signal) ok");

  // 4c. publish — a NON-404 error (e.g. auth) surfaces, never silently dropped.
  const ceAuth = /** @type {any} */ ({
    publishProfile: async () => {
      throw new Error("HTTP 401 POST /profile/publish: unauthorized");
    },
    sendSignal: async () => ({ id: "should-not-happen" }),
  });
  let authThrew = false;
  try {
    await publish(ceAuth, prof);
  } catch (e) {
    authThrew = /401/.test(e instanceof Error ? e.message : String(e));
  }
  assert(authThrew, "publish surfaces non-404 errors instead of falling back");
  checks.push("publish surfaces real errors");

  // 5. buildAndPublish end-to-end with injected fakes (no network, no real runner).
  const fakeRunner = { benchLocal: async (_ce, _o) => syntheticResults(seed) };
  const ceFull = /** @type {any} */ ({
    status: async () => ({ node_id: nodeId, height: 9, balance: "0" }),
    beacon: async () => beacon,
    publishProfile: async (p) => ({ ...p, sig: "ee".repeat(64) }),
    sendSignal: async () => ({ id: "n/a" }),
  });
  const out = await buildAndPublish(ceFull, {
    env: { os: "linux", arch: "x64", cores: 4, total_mb: 8192, kind: "Native" },
    runner: fakeRunner,
  });
  assert(out.profile.node_id === nodeId, "buildAndPublish profile keyed to node");
  assert(out.via === "publish" && out.signed && out.signed.sig === "ee".repeat(64), "buildAndPublish signed via publish");
  assert(out.profile.cpu.gflops_fp32 === 128.5, "buildAndPublish folded measured flops");
  checks.push("buildAndPublish ok (end-to-end, injected)");

  return { ok: true, checks };
}

// Run the self-test when invoked directly: `node src/profile.js`
if (typeof process !== "undefined" && process.argv && import.meta.url === `file://${process.argv[1]}`) {
  __selftest()
    .then((r) => {
      for (const c of r.checks) console.log("  ✓ " + c);
      console.log(`\nprofile.js __selftest: ${r.checks.length} checks passed`);
    })
    .catch((e) => {
      console.error("profile.js __selftest FAILED:", e && e.message);
      process.exit(1);
    });
}
