# Design spec: signed `NodeProfile` + `FabricStats` + `GET /fabric/stats`

Status: **proposal for the node team** (the `ce` Rust workspace). This document specifies a node-side
change. It is **not** implemented in `ce-bench` (an app) — `ce-bench` consumes whatever the node
ships. Until the node ships native storage, `ce-bench` carries the same data over **CEP-1 signals**
(`POST /signals/send`) as a stopgap; this spec defines the eventual first-class form.

Grounding: `ce/docs/compute-fabric.md` §2.1 (NodeProfile), §2.4 (FabricStats), §4 (benchmarking is an
app), §9 (trust). This spec fleshes those sketches into a wire format, a benchmarking/signing
protocol, a gossip plan, anti-cheat, and an endpoint.

---

## 0. Non-negotiable boundary

The node **never benchmarks compute**. `ce-bench` (this app, dispatched as a job/WASM capsule)
produces the measurements. The node's only new responsibilities are:

1. **Sign** a profile the app hands it (binding the measurement to the node's identity key), because
   only the node holds `identity/node.key` and the key must never cross the API (see `api.md`: no
   `/key/*` route). The app must be able to ask "sign these canonical profile bytes for me."
2. **Store + gossip** the latest signed profile per node (like the atlas does for capacity).
3. **Aggregate** stored profiles + the netgraph into `FabricStats` and serve `GET /fabric/stats`.

Everything else (what to measure, how, when) stays in the app and evolves at app speed.

---

## 1. The `NodeProfile` struct

Extends `compute-fabric.md` §2.1 with the fields needed for signing, anti-backdating, and
anti-cheat. Wire form is **JSON over the API** (snake_case) and **bincode for the signed bytes**
(deterministic — the chain/mesh convention). Numeric perf fields are `f32`; identifiers and sizes
are integers.

```
NodeProfile {
  // --- identity & freshness ---
  node_id:      [u8;32],     // the measured node (= signer)
  schema:       u16,         // = 1; bump on any field change
  measured_at:  u64,         // unix seconds; INSIDE the signed bytes -> non-backdatable (see §3)
  beacon_height:u64,         // /beacon height that seeded this run (anti-pre-arrangement, §4)
  beacon_hash:  [u8;32],     // /beacon hash at that height (verifiable randomness witness)
  bench_app:    String,      // which benchmark app+version produced this (e.g. "ce-bench@0.0.1")

  // --- measured compute (the vertices) ---
  cpu:    { cores: u32, threads: u32, gflops_fp32: f32, mem_bw_gbps: f32 },
  gpus:   [ { model: String, backend: Backend, vram_mb: u32, fp16_tflops: f32 } ],
  memory: { total_mb: u32, available_mb: u32 },
  storage:{ total_gb: u32, free_gb: u32, read_mbps: u32, write_mbps: u32 },
  llm:    { ref_model: String, tokens_per_sec: f32, ctx_tokens: u32 },

  // --- environment (capability flags, not perf) ---
  runtime:{ os: String, arch: String, docker: bool, gvisor: bool, wasm: bool, webgpu: bool, kind: NodeKind },

  // --- raw evidence (lets verifiers recompute the scalars; bounded size) ---
  samples: [ BenchResult ],  // see types.js BenchResult; one per probe that ran

  // --- signature (appended; NOT part of the signed bytes) ---
  sig: [u8;64],              // Ed25519 over canonical bytes of all fields above (uses ce-identity sig_serde)
}

Backend = Cuda | Metal | Rocm | Vulkan | WebGpu | None
NodeKind = Native | Container | Browser   // browser/phone nodes are first-class but flagged
```

Notes for the implementer:
- `[u8;64]` signatures use the existing `sig_serde` module (serde only handles arrays <= 32 — see
  `ce/CLAUDE.md`). Reuse it; do not add a new serde shim.
- `samples` is bounded (cap ~16 entries, each <1 KB) so a profile stays well under the gossip frame
  budget. It is what lets an auditor recompute `gflops_fp32` from the raw probe instead of trusting
  the scalar (§4).
- Live, fast-changing fields (`available_mb`, `free_gb`, `running_jobs`) stay in the 60 s atlas
  broadcast. The heavy `NodeProfile` re-publishes only on change or on the randomized schedule (§3).

---

## 2. Signing: a new minimal node surface

The app measures but cannot sign (no key access). Add **one** request that signs canonical profile
bytes the app supplies. Two options; recommend (A):

**(A) `POST /profile/publish`** — app sends the unsigned profile (all fields except `sig`); the node:
1. validates `node_id == self`, `measured_at` within `±MAX_SKEW` (e.g. 120 s) of node clock,
2. validates `beacon_height/beacon_hash` against its own recent `/beacon` history (rejects stale or
   forged beacons — bounds how far in advance a run could be pre-computed, §4),
3. canonical-encodes (bincode), signs with the identity key, stores, and gossips it,
4. returns the signed `NodeProfile` (with `sig`) as JSON.

This keeps key use entirely inside the node and gives the node a validation chokepoint. Mutating →
requires the `Authorization: Bearer <api.token>` per `api.md`.

**(B) `POST /sign/profile`** — node signs and returns bytes only; the app gossips via
`POST /signals/send`. Simpler node change, but the node can't validate freshness/beacon and the app
owns gossip. Use (B) only as the stopgap that mirrors today's CEP-1 path.

> **Stopgap (no node change):** `ce-bench` builds the unsigned profile, calls a hypothetical signer,
> and until (A)/(B) exist, publishes the profile JSON as a CEP-1 signal payload via
> `POST /signals/send` with `capabilities:[{name:"nodeprofile",version:1}]`. The signal is already
> signed by the node identity (CEP-1 requires it), so the profile inherits authenticity from the
> signal envelope — at the cost of no `measured_at`/beacon validation. `fabricstats.js` reads these
> from `/signals`. This is why `ce-bench` can start collecting data before the node ships anything.

---

## 3. Benchmarking + timing schedule (non-backdatable, non-gameable)

1. **Trigger.** A node re-benchmarks when: (a) first launch, (b) hardware/runtime change detected,
   or (c) a **randomized interval** whose phase is derived from `H(node_id || beacon_hash)` so every
   node's window is independent and unpredictable to itself (§4). Target cadence ~ every 6–24 h.
2. **Measure.** Run the `ce-bench` suite (`docs/benchmark-suite.md`). Native nodes run the native
   capsule (GPU via Cuda/Metal/Rocm); browser nodes run the WASM capsule (WebGPU where present).
3. **Stamp.** Set `measured_at = now`, `beacon_{height,hash} = GET /beacon` taken **at the start** of
   the run. Because `measured_at` and the beacon are inside the signed bytes, a profile cannot be
   backdated (the beacon at an earlier height has a different, unforgeable hash) nor pre-signed for a
   future window (the future beacon hash is unknown — it took PoW to find).
4. **Publish.** `POST /profile/publish` (§2). The node stores latest-per-node and gossips.

**Why the beacon stops "benchmark-mode" cheating:** a node cannot predict *when* its randomized
window opens without the next beacon hash, and a verifier re-running the probe seeds it from the same
`beacon_hash` (e.g. RNG seed, matrix contents) so a node that special-cased a fixed input is caught.

---

## 4. Anti-cheat / adversarial robustness

Implements `compute-fabric.md` §9 for compute (the netgraph already co-signs edges).

| Vector | Defence |
|---|---|
| Self-reporting fake GFLOPS/TFLOPS | `samples` carry raw probe outputs; any node can **recompute** the scalar from the sample and flag mismatch. Probes are seeded from `beacon_hash` so inputs aren't predictable. |
| Backdating a good old result | `measured_at` + `beacon_height/hash` are signed; an old beacon has a different hash → stale profiles are detectable and down-weighted by age. |
| Pre-arranged "benchmark window" | Window phase = `H(node_id‖beacon_hash)`; unknown until the beacon exists. Verifiers can re-probe at *dispatch* time (unpredictable) per `api.md`'s beacon note. |
| Claiming hardware far above delivered work | Cross-check against `GET /history/:node_id`: a card claiming N TFLOPS but with near-zero `jobs_hosted`/`earned` and no heartbeats is **flagged as unverified**, not trusted. Ties into `ce/docs/sybil-resistance.md`. |
| Sybil farms of fake profiles | Profiles inherit the chain's Sybil economics: weight a node's profile by `min(bond, earned-work-score)` (the `/status.weight` already computed) and by `/history`. Unbonded, no-history profiles count toward *display* totals but carry ~0 placement weight. |
| Outlier injection (one machine reporting absurd numbers) | `fabricstats.js` computes a robust aggregate: clamp each node's contribution at a percentile, drop values > K medians from the population median (an "implausible card" filter). |

**Verification dial.** Like `swarm verify`, a placement client may demand a *fresh, beacon-seeded
re-run* before trusting a high-value profile — cost vs. assurance is a per-job dial, not a global
policy.

---

## 5. Gossip / propagation

- **Topic.** Reuse `ce-protocol-1` (CEP-1) initially — a profile is a capacity-class signal, exactly
  how capacity rides the atlas today. Optionally a dedicated `ce-profiles` gossipsub topic later if
  volume warrants (profiles are small and infrequent, so reuse is fine for P2).
- **Storage.** Node keeps **latest signed profile per `node_id`** (LRU/age-bounded map, same lifecycle
  as the atlas capacity map). Replaced when a newer `measured_at` from the same node arrives **and**
  its beacon validates.
- **Folding into `/atlas`.** Add an optional `profile` field to each atlas entry (or a sibling
  endpoint `GET /profiles`) so a single fetch yields both live capacity and the heavy profile. The
  `@ce-net/graph` SDK's `profile(node)` contract method (`compute-fabric.md` §3.4) reads this.

---

## 6. `FabricStats` aggregation (the scoreboard)

Computed from stored signed profiles + the netgraph. Deduped by `node_id` (latest profile wins).
Matches `compute-fabric.md` §2.4, made precise:

```
FabricStats {
  nodes:           u64,   // distinct node_ids with a non-stale profile
  cpu_cores:       u64,   // Σ cpu.cores
  cpu_gflops:      f64,   // Σ cpu.gflops_fp32   (robust: see clamp below)
  gpus:            u64,   // Σ gpus.len()
  gpu_vram_mb:     u64,   // Σ over gpus of vram_mb  (the global GPU memory pool)
  gpu_tflops:      f64,   // Σ over gpus of fp16_tflops (robust)
  tokens_per_sec:  f64,   // Σ llm.tokens_per_sec   (aggregate LLM serving capacity)
  storage_free_gb: u64,   // Σ storage.free_gb
  perf_score:      f64,   // weighted display roll-up (see below)
  mesh: {
    median_rtt_ms: f32,   // median fused edge RTT from the netgraph
    reachable_frac:f32,   // fraction of node pairs with a predicted path (connected component cover)
    regions:       u32,   // cluster count from coordinate embedding (graph.regions())
  },
  by_kind: { native:u64, container:u64, browser:u64 },  // transparency: how much is phones/browsers
  computed_at: u64,
}
```

- **`perf_score`** (display only; never replaces the per-node vector placement uses):
  `perf_score = w_c·cpu_gflops + w_g·gpu_tflops·1000 + w_l·tokens_per_sec`
  with default weights `w_c=1, w_g=1, w_l=0.5` — tune in the app, not the node, since it's display.
  Units are normalized so each term is comparable; the exact blend lives in `fabricstats.js` and is
  documented there so the node and app agree.
- **Robust sums.** Before summing `cpu_gflops`/`gpu_tflops`/`tokens_per_sec`, drop per-node values
  above `K × population_median` (default `K=8`) — one machine cannot inflate the headline. Weight by
  `min(bond, earned-work-score)` for a *trusted* variant of each total (offer both: `*_raw` and
  `*_verified`).
- **Mesh** turns `GET /netgraph` into a health number via the `@ce-net/graph` SDK (`median` edge RTT,
  `regions()`, connected-component coverage). No new node math needed if the node serves the raw
  netgraph; the node *may* precompute these for `GET /fabric/stats` to avoid clients re-deriving.

---

## 7. `GET /fabric/stats` endpoint proposal

```
GET /fabric/stats           -> 200 FabricStats (JSON; integer fields as numbers, no money involved)
GET /fabric/stats?verified=1-> 200 FabricStats with bond/history-weighted *_verified totals
GET /profiles               -> 200 [NodeProfile]  (all stored signed profiles; like /atlas but heavy)
GET /profiles/:node_id      -> 200 NodeProfile | 404
```

- **Read-only GET**, open (loopback CORS like `/atlas`/`/beacon`), no auth.
- **Hub roll-up.** The public `ce-net.com` hub already serves `/stats` (currently `nodes`+`cores`).
  Extend the hub to call each known node's `/fabric/stats` (or compute from `/profiles`) and serve
  the **global** `FabricStats` so the landing-page hero gauges and `network.html` read one URL. This
  hub change is small and lives in `web/ce-hub`, not the node — but the node must expose
  `/fabric/stats` first.
- **No money fields** → integers/floats are safe as JSON numbers here. (If a future field carries
  credits, it must be a decimal string per `api.md`.)

---

## 8. Implementation checklist for the node team

1. Add `NodeProfile` + `Backend`/`NodeKind` to `ce-protocol` (bincode, `sig_serde` for `[u8;64]`).
2. `POST /profile/publish` in `ce-node` (validate self/skew/beacon → sign with `ce-identity` → store
   → gossip on `ce-protocol-1`). Behind the existing api.token gate.
3. Latest-per-node profile map in `ce-node` (mirror the atlas capacity map lifecycle).
4. `GET /profiles`, `GET /profiles/:id`, `GET /fabric/stats` (read-only).
5. CI boundary gate already forbids `/key/*` and minting routes — none of the above adds either.
6. Update `ce/docs/api.md` and `ce/docs/compute-fabric.md` (mark P2 in progress).

No consensus/chain change is required: profiles are **read-substrate** (like `/atlas`, `/beacon`,
`/history`), never part of signed/hashed block bytes.
