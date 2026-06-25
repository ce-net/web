/**
 * @ce-net/bench — public entry point.
 *
 * Re-exports the four implementation modules (benchmarks / runner / profile / fabricstats), the
 * wire types/validators, the CE + hub clients, and the two one-call facades `runFabricBench` and
 * `fabricStats`. See README.md and `docs/` for the design.
 *
 * @packageDocumentation
 */

import { CeClient, HubClient } from "./ce.js";
import { benchFabric } from "./runner.js";
import { computeFabricStats, computeVerifiedStats } from "./fabricstats.js";

export * from "./types.js";
export { CeClient, HubClient, toHex, fromHex } from "./ce.js";

// The four split modules. Each is owned by one implementer; this barrel just re-exports their
// public surface so consumers `import { ... } from "@ce-net/bench"`.
export * from "./benchmarks.js";
export * from "./runner.js";
export * from "./profile.js";
export * from "./fabricstats.js";

/** @typedef {import("./types.js").BenchResult} BenchResult */
/** @typedef {import("./types.js").FabricStats} FabricStats */

/**
 * Coerce a CeClient / base-URL string / undefined into a CeClient (or pass through a duck-typed
 * fake for tests).
 * @param {CeClient|string|object|undefined} arg
 * @returns {CeClient|object}
 */
function asCeClient(arg) {
  if (arg instanceof CeClient) return arg;
  if (typeof arg === "string") return new CeClient({ baseUrl: arg });
  if (arg && typeof arg === "object") return arg; // duck-typed (tests / preconfigured)
  return new CeClient();
}

/**
 * Coerce a HubClient / base-URL string / undefined / duck-typed object into a HubClient (or pass a
 * fake through). Returns null when explicitly given null/false so callers can skip the browser sweep.
 * @param {HubClient|string|object|null|undefined} arg
 * @returns {HubClient|object|null}
 */
function asHubClient(arg) {
  if (arg === null || arg === false) return null;
  if (arg instanceof HubClient) return arg;
  if (typeof arg === "string") return new HubClient({ baseUrl: arg });
  if (arg && typeof arg === "object") return arg; // duck-typed (tests / preconfigured)
  return new HubClient();
}

/**
 * One-call fabric benchmark facade: benchmark the local node AND every live browser node the hub
 * knows about in one beacon-seeded sweep, returning a `Map<node_id, BenchResult[]>`. Thin wrapper
 * over {@link benchFabric} that accepts ready clients, base-URL strings, or nothing (defaults).
 *
 * @param {{ ce?: CeClient|string|object, hub?: HubClient|string|object|null,
 *           includeLocal?: boolean, includeBrowsers?: boolean, env?: string }} [opts]
 * @returns {Promise<Map<string, BenchResult[]>>}
 */
export async function runFabricBench(opts = {}) {
  const ce = asCeClient(opts.ce);
  const hub = asHubClient(opts.hub);
  const { ce: _c, hub: _h, ...rest } = opts;
  void _c;
  void _h;
  return benchFabric(ce, hub, rest);
}

/**
 * One-call scoreboard facade: return the network-wide {@link FabricStats}. Prefers the node's own
 * `GET /fabric/stats`; otherwise collects signed profiles (+ the `/signals` stopgap), dedupes, and
 * aggregates client-side. With `opts.verified` it returns the Sybil-weighted variant (FabricStats +
 * a `verified` block). Thin wrapper over {@link computeFabricStats} / {@link computeVerifiedStats}.
 *
 * @param {{ ce?: CeClient|string|object, verified?: boolean, clampK?: number, maxAgeSecs?: number,
 *           regionThresholdMs?: number, now?: number, preferNode?: boolean, weights?: object,
 *           trustOf?: Function }} [opts]
 * @returns {Promise<FabricStats | (FabricStats & {verified: object})>}
 */
export async function fabricStats(opts = {}) {
  const ce = asCeClient(opts.ce);
  const { ce: _c, verified, ...rest } = opts;
  void _c;
  return verified ? computeVerifiedStats(ce, rest) : computeFabricStats(ce, rest);
}

// ----------------------------------------------------------------------------
// Offline self-test for the facades (the modules each have their own __selftest).
//   node src/index.js
// ----------------------------------------------------------------------------

/**
 * Offline check of `runFabricBench` + `fabricStats` through duck-typed clients. `runFabricBench`
 * uses the REAL local suite (so the actual probes run) with the browser sweep skipped; `fabricStats`
 * aggregates two synthetic signed profiles and the verified Sybil-weighted variant.
 * @returns {Promise<{ok:true, localProbes:number, nodes:number, verifiedNodes:number}>}
 */
export async function __selftest() {
  const now = Math.floor(Date.now() / 1000);
  const id = (c) => c.repeat(64);

  // runFabricBench: local-only, real probes, no hub.
  const benchCe = { status: async () => ({ node_id: id("c") }), beacon: async () => ({ height: 42, hash: "deadbeef" }) };
  const map = await runFabricBench({ ce: benchCe, hub: null });
  const local = map.get(id("c")) || [];
  if (local.length < 4) throw new Error(`runFabricBench: expected >=4 local probes, got ${local.length}`);

  // fabricStats: aggregate two synthetic profiles (one CPU-only, one with a GPU).
  const synth = (nid, over = {}) =>
    Object.assign(
      {
        node_id: nid, schema: 1, measured_at: now - 60, beacon_height: 1000, beacon_hash: "ab", bench_app: "ce-bench@0.0.1",
        cpu: { cores: 8, threads: 16, gflops_fp32: 100, mem_bw_gbps: 30 }, gpus: [],
        memory: { total_mb: 16000, available_mb: 8000 }, storage: { total_gb: 500, free_gb: 200, read_mbps: 500, write_mbps: 400 },
        llm: { ref_model: "r", tokens_per_sec: 20, ctx_tokens: 2048 },
        runtime: { os: "linux", arch: "x86_64", docker: true, gvisor: false, wasm: true, webgpu: false, kind: "Native" }, samples: [],
      },
      over,
    );
  const statsCe = {
    fabricStats: async () => null,
    profiles: async () => [synth(id("a")), synth(id("b"), { gpus: [{ model: "X", backend: "Cuda", vram_mb: 24000, fp16_tflops: 80 }] })],
    signals: async () => [],
    netgraph: async () => [{ peer: id("b"), rtt_ms: 10, samples: 5, last_seen_secs: now }],
    history: async (nid) => (nid === id("a") ? { jobs_hosted: 10, earned: "1000000" } : { jobs_hosted: 0, earned: "0" }),
  };
  const stats = await fabricStats({ ce: statsCe });
  if (stats.nodes !== 2) throw new Error(`fabricStats: expected 2 nodes, got ${stats.nodes}`);
  if (!(stats.perf_score > 0)) throw new Error("fabricStats: perf_score must be > 0");
  const v = await fabricStats({ ce: statsCe, verified: true });
  if (v.verified.nodes_verified !== 1) throw new Error(`fabricStats(verified): expected 1 verified node, got ${v.verified.nodes_verified}`);

  return { ok: true, localProbes: local.length, nodes: stats.nodes, verifiedNodes: v.verified.nodes_verified };
}

// Run the self-test when invoked directly: `node src/index.js`
if (typeof process !== "undefined" && process.argv && import.meta.url === `file://${process.argv[1]}`) {
  __selftest()
    .then((r) => console.log(`index.js __selftest: ok (${r.localProbes} local probes, ${r.nodes} nodes, ${r.verifiedNodes} verified)`))
    .catch((e) => {
      console.error("index.js __selftest FAILED:", e && e.message);
      process.exit(1);
    });
}
