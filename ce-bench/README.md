# @ce-net/bench

Portable benchmarking for the CE **compute fabric** — Layer 1 of the roadmap in
[`ce/docs/compute-fabric.md`](../ce/docs/compute-fabric.md) (Phase **P2**: the `ce-bench` capsule +
signed `NodeProfile` in the atlas).

`ce-bench` is an **app**, not a node feature. CE's node measures only its own network links
(transport-intrinsic RTT, exposed at `GET /netgraph`). Everything about *compute* capability —
CPU GFLOPS, memory bandwidth, disk throughput, GPU FP16 TFLOPS, and reference-model tokens/sec — is
measured here, by running real work, and published back as a **signed, timestamped `NodeProfile`**
that the scheduler ([`@ce-net/sched`](../ce-sched)) and the public scoreboard read.

> Zero dependencies. Vanilla ES modules. Every benchmark runs **both** as a Node function and inside
> a `ce-net.com/node` browser tab (dispatched as a WASM task through `ce-hub`).

## Quick start

```js
import { runFabricBench, fabricStats } from "@ce-net/bench";

// Benchmark the local node + every live browser node, in one beacon-seeded sweep.
// Returns Map<node_id, BenchResult[]>. ce/hub accept a CeClient/HubClient, a base-URL string, or
// nothing (defaults). Pass hub:null to skip the browser sweep.
const results = await runFabricBench({ ce: "http://localhost:8844", hub: null });
for (const [nodeId, probes] of results) {
  console.log(nodeId.slice(0, 8), probes.map((p) => `${p.kind}=${p.metric.toFixed(1)}${p.unit}`).join(" "));
}

// The network-wide scoreboard (prefers the node's GET /fabric/stats, else aggregates client-side).
const stats = await fabricStats({ ce: "http://localhost:8844" });
console.log(stats.nodes, "nodes,", stats.cpu_gflops.toFixed(0), "GFLOPS,", stats.gpu_vram_mb, "MB VRAM");

// Sybil-weighted variant: capability totals weighted by /history-proven delivered work.
const verified = await fabricStats({ ce: "http://localhost:8844", verified: true });
console.log(verified.verified.cpu_gflops_verified, "verified GFLOPS");
```

Runnable example (offline, no node required):

```
node examples/bench-self.js --mock
```

benchmarks localhost and prints the unsigned `NodeProfile` ce-bench would publish, plus this node's
contribution to the public `perf_score`. Drop `--mock` (and optionally pass a base URL) to seed from a
live node's `/beacon` and key the profile to its real node id.

`runFabricBench` / `fabricStats` are the convenience facades; the lower-level building blocks
(`benchLocal`, `benchFabric`, `assembleProfile`, `publish`, `computeFabricStats`,
`computeVerifiedStats`, …) are exported too.

## The benchmark suite

Each probe runs a seeded, anti-DCE kernel for an auto-tuned ~constant wall time and returns a
`BenchResult { kind, metric, unit, seed, raw, ms, env }`. The `raw` field carries the evidence a
verifier uses to recompute `metric` (anti-cheat).

| Probe (`kind`) | Measures | Unit | Kernel |
|---|---|---|---|
| `cpu_flops` | CPU floating-point throughput | gflops | L1-resident FMA loop (`acc = acc·a + b`) |
| `cpu_int` | CPU integer throughput | mops | xorshift64 + 64-bit multiply (BigInt) |
| `mem_bw` | Memory bandwidth | gbps | STREAM triad beyond LLC, median of passes |
| `disk_rw` | Sequential disk read/write | mbps | write+fsync+read-back via `node:fs` (browser: flagged-zero) |
| `llm_tokens` | Reference-model decode throughput | tokens_per_sec | fixed `ce-ref-tiny` micro-transformer, autoregressive |
| `net_throughput` | Host↔target ingest rate | mbps | hub echo (mesh transport returns `null` until the node ships it) |

**Determinism & anti-cheat.** All inputs derive from the `/beacon` hash (splitmix64), so timing
randomization means a host can't detect "benchmark mode", and a verifier reproduces the exact
arithmetic. `recheck()` recomputes each metric from its own `raw`; `runner.verifyProbe()` adds a fresh
seeded re-run and compares; `runner.plausibilityCheck()` cross-checks a *claimed* profile against
`/history` (a card claiming throughput far above delivered work is flagged). The reference LLM weights
are generated from a fixed recipe hash (not the run seed), so cross-node token/sec numbers are
apples-to-apples. Full definitions in [`docs/benchmark-suite.md`](docs/benchmark-suite.md).

## The NodeProfile

`profile.js` folds a `BenchResult[]` + detected environment into a structurally-valid, signed-shaped
`NodeProfile` — the per-node *vertex* of the Fabric Map:

```
NodeProfile {
  node_id, schema, measured_at, beacon_height, beacon_hash, bench_app,
  cpu:     { cores, threads, gflops_fp32, mem_bw_gbps },
  gpus:    [ { model, backend, vram_mb, fp16_tflops } ],
  memory:  { total_mb, available_mb },
  storage: { total_gb, free_gb, read_mbps, write_mbps },
  llm:     { ref_model, tokens_per_sec, ctx_tokens },
  runtime: { os, arch, docker, gvisor, wasm, webgpu, kind },   // kind: Native | Container | Browser
  samples: [ BenchResult ],   // bounded (<=16) raw evidence so scalars can be audited
  sig?:    <128-hex>,         // added by the NODE on publish — the app never holds a key
}
```

`assembleProfile` maps `cpu_flops → cpu.gflops_fp32`, `mem_bw → cpu.mem_bw_gbps`,
`disk_rw → storage.read/write_mbps`, `llm_tokens → llm.tokens_per_sec`; `net_throughput` is an *edge*,
not a vertex, so it survives only as a sample. `canonicalBytes`/`canonicalJson` define the exact bytes
the node signs over (sorted-key JSON until the node adopts bincode — bump both sides together).
`publish()` tries the first-class `POST /profile/publish` and, on 404, falls back to a CEP-1 signal
carrying the canonical bytes (so data flows before the node ships profile storage).

## FabricStats scoreboard

`fabricstats.js` is the read/aggregate side: `collectProfiles` (the `/profiles` endpoint, or
reconstructed from the `/signals` stopgap) → `dedupeLatest` (by `node_id`, freshest `measured_at`
wins, drop stale/invalid) → `aggregateCompute` (robust sums that drop values above `K×median` so one
absurd reporter can't inflate the headline) → `meshHealth` (re-derives `@ce-net/graph`'s
sample-weighted edge fusion, union-find latency `regions`, and `reachable_frac` from `/netgraph`) →
`perfScore` (a display-only weighted roll-up). `computeVerifiedStats` weights each node's contribution
by a `/history`-derived trust factor (a Sybil gate), all without ever parsing a base-unit money string
to a float. Spec: [`docs/nodeprofile-spec.md`](docs/nodeprofile-spec.md) §6.

## How it consumes the read-substrate

| Endpoint | Read by | For |
|---|---|---|
| `GET /beacon` | runner / profile | the shared, verifiable seed for every probe in a sweep (un-fakeable timing) |
| `GET /status` | runner / profile | the local node id the profile is keyed to |
| `GET /netgraph` | fabricstats | mesh-health: median RTT, latency regions, reachable fraction |
| `GET /history/:id` | runner / fabricstats | plausibility cross-check; Sybil-weighting the verified scoreboard |
| `GET /atlas` | (client) | live capacity; profiles fold in here once the node supports it |
| `GET /signals`, `POST /signals/send` | fabricstats / profile | the CEP-1 stopgap to publish + collect profiles before native storage |
| `GET /fabric/stats` (proposed) | fabricstats | the node-served scoreboard, preferred when present |

## Boundary (app vs. the node)

- **The node** (do not change in this app): `GET /netgraph`, `/atlas`, `/history/:id`, `/beacon`,
  `/status`, `POST /signals/send`. The signed-`NodeProfile` struct, native profile storage/gossip
  (`POST /profile/publish`, `GET /profiles`, `GET /fabric/stats`), and an *optional* node-side
  benchmark capsule are a **node-team change** — specified in
  [`docs/nodeprofile-spec.md`](docs/nodeprofile-spec.md), **not implemented here**.
- **This app**: the measurements, orchestration (local + browser-node sweep), profile assembly +
  signing handoff, and scoreboard aggregation. Until the node ships native storage, ce-bench publishes
  profiles as CEP-1 signals and reconstructs `FabricStats` from `/signals` — no node release required
  to start collecting real data.

## Money

CE amounts are integer base units carried as **decimal strings** (`1 credit = 10^18 base units`).
`ce-bench` never reports money; where it touches the API (burn proofs for signals, `/history`
earnings) it treats amounts as opaque strings — never parses them to a JS number.

## Layout

```
ce-bench/
├── src/
│   ├── index.js        barrel + runFabricBench() / fabricStats() facades (public entry)
│   ├── benchmarks.js   the portable measurements (CPU / memory / network / disk / LLM) + WASM kernels
│   ├── runner.js       orchestration: benchLocal / benchFabric / browser sweep / verifyProbe / plausibilityCheck
│   ├── profile.js      detectEnv / assembleProfile / canonicalBytes / publish (publish-or-signal)
│   ├── fabricstats.js  collect / dedupe / aggregate / meshHealth / perfScore / verified variant
│   ├── types.js        NodeProfile / BenchResult / FabricStats shapes + validators (JSDoc typedefs)
│   └── ce.js           CE node HTTP client + ce-hub client (dispatch WASM tasks to browser nodes)
├── examples/
│   └── bench-self.js   benchmark localhost + print the NodeProfile it would publish (run with --mock)
├── web/
│   └── scoreboard.html live FabricStats scoreboard
└── docs/
    ├── nodeprofile-spec.md   design spec for the node team (signed NodeProfile, gossip, anti-cheat, /fabric/stats)
    └── benchmark-suite.md    the portable benchmark definitions (Node + browser/WASM forms)
```

## Status

**App-complete and self-tested.** Every module (`benchmarks` / `runner` / `profile` / `fabricstats`)
and both facades have offline `__selftest()`s (with `__selftestAsync` companions for the I/O paths) —
all green with injected fakes, no network. `examples/bench-self.js --mock` produces a valid profile
offline. What is *not* in this repo (by design): the node-side `NodeProfile` struct, native storage /
gossip, and the `GET /fabric/stats` endpoint — the node team's work per
[`docs/nodeprofile-spec.md`](docs/nodeprofile-spec.md). ce-bench already publishes via the CEP-1
stopgap and aggregates from `/signals` until those ship.

```
node --check src/*.js
node src/index.js                  # facade self-test
node src/benchmarks.js             # (each module is also directly runnable)
node examples/bench-self.js --mock
```

## License

MIT © Leif Rydenfalk
