# The `ce-bench` portable benchmark suite

The actual measurements behind a `NodeProfile`. Design constraint: **every probe runs both as a Node
JS function and inside a `ce-net.com/node` browser tab.** Browser nodes only execute **WASM** modules
(`web/site/node.html`: `WebAssembly.instantiate(bytes)` then call an export with `i64`/`i32` args,
read a single scalar back; dispatched via `ce-hub` `POST /tasks` → WS `{t:"job", func, args,
module_b64}` → `{ok, value, ms}`). So each probe has two implementations of the **same kernel**:

- **Node form** — a JS function in `src/benchmarks.js` (pure JS or, for parity, the same WASM run
  under Node's `WebAssembly`). Returns a `BenchResult`.
- **Browser form** — a tiny WASM module + an export name + `i64` args. The runner dispatches it via
  `ce.js`'s hub client; the returned `{value, ms}` is converted to the same `BenchResult` shape.

Each probe is **deterministic given a `seed`** (we pass the `/beacon` hash as the seed) so a verifier
can re-run it and compare — the anti-cheat in `nodeprofile-spec.md` §4 depends on this.

## Common result shape

Every probe returns a `BenchResult` (see `src/types.js`):

```
BenchResult {
  kind:    "cpu_flops"|"cpu_int"|"mem_bw"|"net_throughput"|"disk_rw"|"llm_tokens",
  metric:  number,        // the headline number in `unit`
  unit:    string,        // "gflops" | "mops" | "gbps" | "mbps" | "tokens_per_sec" ...
  seed:    string,        // beacon hash (hex) that seeded the run; "" if unseeded
  raw:     object,        // probe-specific evidence so a verifier can recompute `metric`
  ms:      number,        // wall time of the measured region
  env:     "node"|"browser"|"native",
  ts:      number,        // unix seconds the probe finished
}
```

`metric` is what rolls into the `NodeProfile` scalar; `raw` is what gets stored in
`NodeProfile.samples` so the number can be audited.

---

## 1. CPU — floating point (`cpu_flops`) and integer (`cpu_int`)

**Kernel.** A fused multiply-add loop over a fixed working set, plus a separate integer mix
(64-bit multiply + xorshift). Count operations, divide by measured wall time.

- **FLOPS:** `N` iterations of `acc = acc * a + b` (2 FLOP each) over a small array sized to live in
  L1 (isolate ALU from memory). `metric = 2*N / ms / 1e6` → **GFLOPS** (fp32; fp64 variant optional).
- **Integer:** xorshift64 + 64-bit multiply, `N` ops. `metric = N / ms / 1e6` → **Mops/s**.

**Seeding.** Initial `acc`/array contents derive from `seed` (so a node can't hardcode a constant
that the JIT/optimizer folds away, and a verifier reproduces the exact arithmetic).

- **Node form:** `cpuFlops(seed, {targetMs})`, `cpuInt(seed, {targetMs})` — auto-tune `N` to hit
  `targetMs` (~50–100 ms) so it's accurate without stalling. Guard against the optimizer eliding the
  loop (consume `acc` into `raw`).
- **Browser form:** WASM `cpu_flops.wasm` exporting `flops(seed_lo:i64, iters:i64) -> i64` returning
  the op count actually executed (and the loop's final accumulator stashed so it can't be DCE'd);
  the runner times the call and computes GFLOPS from `iters/ms`. Mirrors `node.html`'s existing
  `cpuBench()` but as a precise, seeded WASM kernel instead of the inline JS warm-up.

> Native GPU path (Cuda/Metal/Rocm FP16 TFLOPS) is **out of scope for the portable JS/WASM suite** —
> it's measured by the native `ce-bench` cell (a separate capsule) and merged into the same
> `NodeProfile.gpus`. Browser nodes report a WebGPU FP16 estimate where `navigator.gpu` exists (a
> small compute-shader GEMM), else `gpus: []`.

## 2. Memory bandwidth (`mem_bw`)

**Kernel.** Streaming triad (`a[i] = b[i] + s*c[i]`, the STREAM benchmark) over an array sized
**well beyond LLC** (e.g. 64–256 MB, capped by available memory / WASM `memory.grow`). Bytes touched
per element = 3×8 (read b, read c, write a). `metric = bytes / ms / 1e9` → **GB/s**.

- **Node form:** `memBandwidth(seed, {bytes})` over `Float64Array`s; subtract a no-op pass to remove
  loop overhead; report the median of several passes.
- **Browser form:** WASM `mem_bw.wasm` with a large linear memory; export `triad(n:i64) -> i64`
  returning a checksum (anti-DCE). Runner sizes `n` from the node's reported memory (capacity atlas /
  `navigator.deviceMemory`) but clamps to what WASM can grow to in the tab.

## 3. Network throughput between peers (`net_throughput`)

This is the **edge** complement to the node's RTT (`/netgraph`). RTT is transport-intrinsic and lives
in the node; sustained **bandwidth** is measured here by moving real bytes between two nodes.

**Kernel.** Source node sends a sized payload to a target node and times the transfer; `metric =
bytes*8 / ms / 1e6` → **Mbps**. Two transports, picked by what's reachable:

1. **Mesh transport (preferred, matches CE's "mesh-first" rule):** route a timed transfer over the
   libp2p stream primitive. *Today there is no app-level bulk-transfer endpoint*, so this is the
   **fast-follow** form — it depends on the bandwidth-probe primitive sketched in
   `compute-fabric.md` §3 (`bw_mbps` on `LinkSample`). Until that lands, `net_throughput` is reported
   as `null`/absent and the graph uses RTT only.
2. **Hub/loopback transport (available now):** between a measuring host and a **browser node**,
   throughput is bounded by the hub WS path; the runner can size a payload echoed through a WASM
   `memcpy`-style task to estimate the browser node's effective ingest rate. Reported with
   `raw.transport:"hub"` so it's not confused with a true peer-to-peer mesh edge.

- **Node form:** `netThroughput(fromUrl, toNodeId, {bytes, transport})` — returns Mbps + the
  measured `rtt_ms` it observed (cross-check against `/netgraph`).
- **Browser form:** dispatched as a WASM task whose only job is to receive `bytes` of args/payload
  and return a checksum; the runner times the round trip.

> Output feeds `LinkSample.bw_mbps` (co-signed edge) once the node supports it; until then it's an
> app-side annotation on the `@ce-net/graph` snapshot.

## 4. Disk read/write (`disk_rw`)

**Kernel.** Write `S` bytes sequentially, fsync, drop caches if possible, read them back; time each.
`read_mbps`/`write_mbps = S / ms / 1e6` → **MB/s**.

- **Node form:** `diskRw(seed, {bytes, dir})` using `node:fs` (`writeFileSync` + `fsyncSync` +
  `readFileSync`) into a temp file under `os.tmpdir()`; default `bytes` ~ 64–256 MB, configurable
  down for CI. Deletes the temp file. Returns separate read/write metrics in `raw`.
- **Browser form:** there is **no portable synchronous disk** in a tab. Use the **OPFS**
  (Origin Private File System) async API where present (`navigator.storage.getDirectory()` →
  `createSyncAccessHandle`), else **IndexedDB** as a fallback, to measure persistent-storage R/W.
  Because the browser kernel is async (not a pure WASM scalar export), the browser disk probe is run
  by **page-side JS injected into `node.html`** (a small `bench.js` the page can import), reporting
  through the same hub result channel — *not* as a `WebAssembly.instantiate` module. This is the one
  probe that needs a tiny `node.html` hook (documented as a node-team/web ask, not done here).
  Browser nodes that can't measure storage report `read_mbps:0, write_mbps:0` (still valid, flagged).

## 5. LLM micro-benchmark (`llm_tokens`)

The metric that predicts LLM-serving capacity (`NodeProfile.llm.tokens_per_sec`). It must be **tiny,
portable, and reference-fixed** so every node runs the *same* model and the numbers are comparable.

**Kernel.** A fixed **reference micro-transformer** (a few small layers, a couple-hundred-K params,
weights content-addressed and shipped with the capsule) does autoregressive decode of a fixed prompt
for `T` tokens. `metric = T / total_decode_ms * 1000` → **tokens/sec**. The model is fixed by
`ref_model` (name + hash) so cross-node comparison is apples-to-apples; bigger real models are a
separate, opt-in probe later.

- **Node form:** `llmTokens(seed, {model:"ce-ref-tiny", tokens})` — runs the reference forward pass
  in pure JS/typed-arrays (matmul over the small weight tensors). Deterministic given the model hash;
  `seed` only affects the prompt so it can't be specially cached.
- **Browser form:** WASM `llm_ref.wasm` embedding the same tiny weights; export
  `decode(seed_lo:i64, tokens:i64) -> i64` returning a digest of the produced logits (correctness +
  anti-DCE); runner times it for tokens/sec. WebGPU acceleration is an optional faster path on
  capable browsers, reported with `raw.backend:"webgpu"`.

> Why a reference micro-model and not the host's "real" LLM: the goal is a **portable, comparable**
> throughput number for the scoreboard and placement prior, not a production inference benchmark.
> `ce-infer` (Layer 4) does real-model placement using this as the prior.

---

## Seeding & determinism summary

| Probe | What `seed` controls | Verifier recomputes from `raw` |
|---|---|---|
| cpu_flops / cpu_int | initial accumulator / array contents | op count vs. time; final accumulator must match |
| mem_bw | array fill pattern | checksum of triad output |
| net_throughput | payload contents | byte count vs. time; observed RTT vs. `/netgraph` |
| disk_rw | file contents | read-back checksum; byte count vs. time |
| llm_tokens | prompt tokens | logits digest must match for the fixed model hash |

All `seed`s are the `GET /beacon` `hash` captured at run start, so a node cannot pre-arrange inputs
and a verifier (re-probe at dispatch time) seeds identically. See `nodeprofile-spec.md` §3–4.

## Tuning knobs (per environment)

| Knob | Node default | Browser default | CI |
|---|---|---|---|
| cpu targetMs | 80 ms | 50 ms (matches node.html warm-up budget) | 20 ms |
| mem_bw bytes | 128 MB | clamp to WASM growable / `deviceMemory` | 8 MB |
| disk_rw bytes | 128 MB | OPFS, 16 MB | 4 MB |
| llm tokens | 64 | 32 | 8 |
| net bytes | 16 MB | 1 MB (hub-bounded) | 256 KB |

These live in `src/benchmarks.js` as a `PRESETS` map keyed by `"node"|"browser"|"ci"`; the runner
picks the preset by environment.
