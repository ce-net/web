/**
 * @ce-net/bench — type definitions and lightweight validators for the fabric benchmarking app.
 *
 * Zero dependencies. JSDoc typedefs give editors/`tsc --checkJs` real types without a build step.
 * The wire shapes mirror the design specs in `docs/nodeprofile-spec.md` (the signed `NodeProfile`)
 * and `docs/benchmark-suite.md` (`BenchResult`), and `compute-fabric.md` §2.4 (`FabricStats`).
 *
 * MONEY: CE amounts are integer base units carried as DECIMAL STRINGS (1 credit = 10^18 base units).
 * Nothing in a profile/benchresult is money. The only place money appears is a CEP-1 signal's burn
 * proof, which `profile.js` forwards as an opaque string — never parse it to a JS number.
 *
 * @packageDocumentation
 */

/** Current NodeProfile schema version. Bump on any field change (see nodeprofile-spec.md §1). */
export const PROFILE_SCHEMA = 1;

/** GPU/accelerator backends a profile may report. */
export const BACKENDS = /** @type {const} */ (["Cuda", "Metal", "Rocm", "Vulkan", "WebGpu", "None"]);

/** How a node runs — browsers/phones are first-class but flagged. */
export const NODE_KINDS = /** @type {const} */ (["Native", "Container", "Browser"]);

/** Benchmark kinds the suite produces (docs/benchmark-suite.md). */
export const BENCH_KINDS = /** @type {const} */ ([
  "cpu_flops",
  "cpu_int",
  "mem_bw",
  "net_throughput",
  "disk_rw",
  "llm_tokens",
]);

/**
 * @typedef {"node"|"browser"|"native"} BenchEnv
 */

/**
 * One measured probe. `metric` (in `unit`) is the headline number; `raw` is the evidence a verifier
 * uses to recompute `metric` (anti-cheat, nodeprofile-spec.md §4). See docs/benchmark-suite.md.
 *
 * @typedef {object} BenchResult
 * @property {typeof BENCH_KINDS[number]} kind   Which probe.
 * @property {number} metric                     Headline value in `unit`.
 * @property {string} unit                       "gflops"|"mops"|"gbps"|"mbps"|"tokens_per_sec"|...
 * @property {string} seed                       Beacon hash (hex) that seeded the run; "" if unseeded.
 * @property {object} raw                        Probe-specific evidence (op counts, checksums, RTT...).
 * @property {number} ms                         Wall time of the measured region (ms).
 * @property {BenchEnv} env                      Where it ran.
 * @property {number} ts                         Unix seconds the probe finished.
 */

/**
 * @typedef {object} GpuInfo
 * @property {string} model
 * @property {typeof BACKENDS[number]} backend
 * @property {number} vram_mb
 * @property {number} fp16_tflops
 */

/**
 * The signed per-node capability vector. Mirrors compute-fabric.md §2.1 + nodeprofile-spec.md §1.
 * `sig` is appended by the node (Ed25519 over the canonical bytes of every field except `sig`).
 *
 * @typedef {object} NodeProfile
 * @property {string} node_id            64-hex Ed25519 public key of the measured node (= signer).
 * @property {number} schema             = PROFILE_SCHEMA.
 * @property {number} measured_at        Unix seconds; inside signed bytes -> non-backdatable.
 * @property {number} beacon_height      /beacon height that seeded this run.
 * @property {string} beacon_hash        /beacon hash (hex) at that height.
 * @property {string} bench_app          Producer id, e.g. "ce-bench@0.0.1".
 * @property {{cores:number,threads:number,gflops_fp32:number,mem_bw_gbps:number}} cpu
 * @property {GpuInfo[]} gpus
 * @property {{total_mb:number,available_mb:number}} memory
 * @property {{total_gb:number,free_gb:number,read_mbps:number,write_mbps:number}} storage
 * @property {{ref_model:string,tokens_per_sec:number,ctx_tokens:number}} llm
 * @property {{os:string,arch:string,docker:boolean,gvisor:boolean,wasm:boolean,webgpu:boolean,kind:typeof NODE_KINDS[number]}} runtime
 * @property {NetworkInfo} [network]     Optional network-quality axis (rtt/bandwidth/link). Absent on
 *                                       older profiles; placement degrades gracefully without it.
 * @property {BenchResult[]} samples     Bounded raw evidence (cap ~16) so scalars can be audited.
 * @property {string} [sig]              128-hex Ed25519 signature, added by the node on publish.
 */

/**
 * Network-quality axis for a node: how well it can move bytes to its neighbours/the relay. Every
 * field is optional — a node that cannot measure a dimension simply omits it (never a fake zero), and
 * the scheduler treats a missing dimension as unknown rather than bad.
 *
 * @typedef {object} NetworkInfo
 * @property {number} [relay_rtt_ms]  Smoothed RTT to the relay/hub (ms).
 * @property {number} [down_mbps]     Measured download throughput (Mbps).
 * @property {number} [up_mbps]       Measured upload throughput (Mbps).
 * @property {{type?:string,downlink_mbps?:number,rtt_ms?:number}} [link]  Best-effort link hints
 *           (e.g. browser navigator.connection: effectiveType/downlink/rtt). Advisory, not measured.
 */

/**
 * Network-wide scoreboard. compute-fabric.md §2.4 + nodeprofile-spec.md §6. No money fields, so
 * numeric fields are plain JS numbers.
 *
 * @typedef {object} FabricStats
 * @property {number} nodes
 * @property {number} cpu_cores
 * @property {number} cpu_gflops
 * @property {number} gpus
 * @property {number} gpu_vram_mb
 * @property {number} gpu_tflops
 * @property {number} tokens_per_sec
 * @property {number} storage_free_gb
 * @property {number} perf_score
 * @property {{median_rtt_ms:number,reachable_frac:number,regions:number}} mesh
 * @property {{native:number,container:number,browser:number}} by_kind
 * @property {number} computed_at        Unix seconds.
 */

const FINITE_NUM = (v) => typeof v === "number" && Number.isFinite(v);
const NONNEG = (v) => FINITE_NUM(v) && v >= 0;
const HEX = /^[0-9a-fA-F]*$/;

/**
 * Build a `BenchResult`, filling `ts`/`raw` defaults and rejecting nonsense. Throws on an invalid
 * kind or a non-finite metric so a bad probe can never poison a profile.
 *
 * @param {Partial<BenchResult> & {kind:BenchResult["kind"], metric:number, unit:string}} r
 * @returns {BenchResult}
 */
export function makeBenchResult(r) {
  if (!BENCH_KINDS.includes(/** @type {any} */ (r.kind))) {
    throw new Error(`BenchResult: unknown kind "${r.kind}"`);
  }
  if (!NONNEG(r.metric)) throw new Error(`BenchResult(${r.kind}): metric must be a finite >= 0 number`);
  if (typeof r.unit !== "string" || !r.unit) throw new Error(`BenchResult(${r.kind}): unit required`);
  return {
    kind: r.kind,
    metric: r.metric,
    unit: r.unit,
    seed: typeof r.seed === "string" ? r.seed : "",
    raw: r.raw && typeof r.raw === "object" ? r.raw : {},
    ms: NONNEG(r.ms) ? r.ms : 0,
    env: r.env === "browser" || r.env === "native" ? r.env : "node",
    ts: NONNEG(r.ts) ? r.ts : Math.floor(Date.now() / 1000),
  };
}

/**
 * Validate a (possibly unsigned) NodeProfile shape. Returns a list of problems; empty = valid.
 * Does NOT verify the signature (that's the node's / a verifier's job) — only structural sanity,
 * which is what `profile.js` checks before publishing and `fabricstats.js` checks before aggregating.
 *
 * @param {any} p
 * @param {{requireSig?:boolean}} [opts]
 * @returns {string[]} problems (empty array means valid)
 */
export function validateProfile(p, opts = {}) {
  /** @type {string[]} */
  const errs = [];
  if (!p || typeof p !== "object") return ["profile is not an object"];
  if (typeof p.node_id !== "string" || p.node_id.length !== 64 || !HEX.test(p.node_id)) {
    errs.push("node_id must be 64 hex chars");
  }
  if (p.schema !== PROFILE_SCHEMA) errs.push(`schema must be ${PROFILE_SCHEMA}`);
  if (!NONNEG(p.measured_at)) errs.push("measured_at must be a unix-seconds number");
  if (!NONNEG(p.beacon_height)) errs.push("beacon_height must be a non-negative number");
  if (typeof p.beacon_hash !== "string" || !HEX.test(p.beacon_hash)) errs.push("beacon_hash must be hex");
  if (typeof p.bench_app !== "string" || !p.bench_app) errs.push("bench_app required");

  const cpu = p.cpu;
  if (!cpu || !NONNEG(cpu.cores) || !NONNEG(cpu.gflops_fp32) || !NONNEG(cpu.mem_bw_gbps)) {
    errs.push("cpu{cores,gflops_fp32,mem_bw_gbps} must be non-negative numbers");
  }
  if (!Array.isArray(p.gpus)) errs.push("gpus must be an array");
  else {
    for (const g of p.gpus) {
      if (!g || !BACKENDS.includes(g.backend) || !NONNEG(g.vram_mb) || !NONNEG(g.fp16_tflops)) {
        errs.push("each gpu needs {backend in BACKENDS, vram_mb>=0, fp16_tflops>=0}");
        break;
      }
    }
  }
  if (!p.memory || !NONNEG(p.memory.total_mb)) errs.push("memory.total_mb must be non-negative");
  if (!p.storage || !NONNEG(p.storage.free_gb)) errs.push("storage.free_gb must be non-negative");
  if (!p.llm || typeof p.llm.ref_model !== "string" || !NONNEG(p.llm.tokens_per_sec)) {
    errs.push("llm{ref_model,tokens_per_sec} required");
  }
  if (!p.runtime || !NODE_KINDS.includes(p.runtime.kind)) errs.push("runtime.kind must be in NODE_KINDS");
  // network is optional; if present, every numeric field must be a non-negative finite number.
  if (p.network !== undefined) {
    const n = p.network;
    const okOpt = (v) => v === undefined || NONNEG(v);
    if (!n || typeof n !== "object" || !okOpt(n.relay_rtt_ms) || !okOpt(n.down_mbps) || !okOpt(n.up_mbps)) {
      errs.push("network, if present, must be an object with non-negative relay_rtt_ms/down_mbps/up_mbps");
    }
  }
  if (!Array.isArray(p.samples)) errs.push("samples must be an array");
  if (Array.isArray(p.samples) && p.samples.length > 16) errs.push("samples capped at 16 (gossip frame budget)");

  if (opts.requireSig) {
    if (typeof p.sig !== "string" || p.sig.length !== 128 || !HEX.test(p.sig)) {
      errs.push("sig must be 128 hex chars when requireSig");
    }
  }
  return errs;
}

/** True if `validateProfile` finds no problems. */
export function isValidProfile(p, opts) {
  return validateProfile(p, opts).length === 0;
}

/** An all-zero FabricStats (used as the reduce seed in fabricstats.js). */
export function emptyFabricStats() {
  return {
    nodes: 0,
    cpu_cores: 0,
    cpu_gflops: 0,
    gpus: 0,
    gpu_vram_mb: 0,
    gpu_tflops: 0,
    tokens_per_sec: 0,
    storage_free_gb: 0,
    perf_score: 0,
    mesh: { median_rtt_ms: 0, reachable_frac: 0, regions: 0 },
    by_kind: { native: 0, container: 0, browser: 0 },
    computed_at: Math.floor(Date.now() / 1000),
  };
}
