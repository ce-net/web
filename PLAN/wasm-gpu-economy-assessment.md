# WASM, GPU, and the Credit Economy — Honest Engineering Assessment

For Leif. Grounded in a code-level read of `ce-wasm`, `ce-container`, `ce-infer`, and `ce-chain`. Written to be true, not flattering. Where docs and code disagree, code wins and the doc is flagged stale.

---

## 1. What the WASM engine can do today

`ce-wasm` is a small, genuinely solid wasmtime sandbox for running **untrusted, hash-verified, self-contained WASM**. It has two modes:

- **Pure-compute path** (any `entry != "_start"`): the linker is **completely empty** — zero imports (`lib.rs:167`). A module with *any* import fails to instantiate. No stdio, no clock, no randomness, no fs, no net, no CE host calls. It runs arithmetic/memory only and returns an `i32`. This path is also fire-and-forget: the result is logged and discarded (`lib.rs:268-272`).
- **WASI command path** (`entry == "_start"`): the only host surface is the full WASI preview1 import set via `p1::add_to_linker_sync` (`lib.rs:218`). I/O is **stdin** (input blobs concatenated into an in-memory pipe) → compute → **stdout** (a 16 MiB-capped in-memory pipe, published as a CID). No preopened dirs, no env, no args, no sockets, no inherited host fds — **except stderr, which is inherited** (see below).

**Isolation is real and well-tested:**
- **Fuel metering** (`consume_fuel(true)`, `FUEL_PER_CORE = 10e9`): a runaway loop traps to a catchable `Err`. It is a fixed budget, not a refill rate, and is **not** used for billing.
- **Epoch watchdog** (`epoch_interruption`, 1s tick, 300s ceiling, `lib.rs:93-124`): bounds wall-clock time even if a module blocks in a host call. Thread is stopped and joined on return.
- **Memory cap** (`StoreLimitsBuilder`, `mem_mb * 1MiB`): linear-memory growth is capped; over-allocation traps.
- **`signals_based_traps(false)` + no backtrace** (`lib.rs:79-81`): the load-bearing Windows fix. Previously a fuel trap delivered via signal/SEH unwound into a non-unwindable libcall and aborted the whole host process on Windows. Now traps return a catchable `Err` on every platform. Genuinely a correctness/availability fix, tested.
- **Content-addressing**: modules and inputs are SHA-256-verified before execution (`lib.rs:141-150`). Tamper-proof delivery — but a hash-correct module is still untrusted code, which is exactly why the sandbox matters.

**Honest rough edges (none are isolation breaks):**
- **Ambient authority leak — inherited stderr** (`lib.rs:208`): an untrusted module's fd 2 writes arbitrary bytes (ANSI, log-injection, unbounded volume) straight to the operator's log stream. Low severity, but it is ambient authority leaking in. Should be a bounded pipe or discarded.
- **DoS surfaces**: stdout is correctly bounded, but **stdin is unbounded** — every input blob is concatenated into host RAM with no aggregate cap (`lib.rs:277-283`), so a large deploy can OOM the host before the module runs. The output blob is written to disk on every run with no quota/GC (`lib.rs:292-295`). Module bytes are read fully into RAM.
- **Determinism is claimed, not enforced**: docs say "WASM is deterministic, ideal for swarm verify," but `engine_config()` does **not** pin SIMD/threads/NaN-canonicalization, and the WASI path links `clock_time_get` and `random_get`. So bit-reproducible verification is **designed, not delivered**.
- **No capability-gated host ABI**: there is **no** way for a module to call CE primitives (blobs, pubsub, ledger). The only I/O is host-mediated stdin→stdout→CID. This is the single biggest gap for "powerful."
- **`args` is plumbed but dropped** (`api.rs:796` always sets `vec![]`; `launch()` ignores it). Minor unfinished seam.

**Verdict:** safe but deliberately weak. The "extremely powerful + maximally hardened" engine is essentially all still to-build — but the clean hooks exist (a `func_wrap` host-import table, a verified ce-cap chain in `Store` state, a hardened engine config, fuel-as-gas).

---

## 2. Can you run GPU AI on other people's machines?

**Short answer: you can rent inference of *your own* trusted model on a peer's GPU today. You cannot run an arbitrary user's CUDA/training job on a stranger's GPU safely.** There are two disconnected paths and neither delivers "safe GPU-AI-on-strangers'-machines."

**Path A — the generic CE container runtime (`ce-container`, Docker): GPU-less.**
The `HostConfig` sets only `nano_cpus`, `memory`, `network_mode=none`, `auto_remove` (`lib.rs:85-93`). There is **no** `--gpus`, no NVIDIA runtime, no Docker `DeviceRequests` — a repo-wide grep returns zero hits. The `Limits` struct is `{cpu_cores, mem_mb}` only; deploy caveat enforcement checks cpu/mem/bid ceilings only; billing is CPU-seconds + GB-seconds. So a Docker job placed on a peer **physically cannot touch a GPU**, and the whole placement/billing seam is GPU-blind.

**Path B — `ce-infer` (distributed inference): GPU, but unsandboxed and out-of-scope for strangers' code.**
`ce-infer` reaches the GPU by shelling out to llama.cpp's `llama-server` as a **bare host process** (`-ngl 99` to offload layers to CUDA/Metal, `backend.rs:131-149`) — **outside Docker, outside gVisor, with full host GPU access**. The remote user sends a capability-gated, OpenAI-compatible chat request; the host runs **its own pre-published, CID-verified GGUF model**. This is real and working for whole-model single-node inference: capability auth, payment-channel billing, SSE streaming, atlas tier selection, reputation ranking — all implemented and tested. The exo-style cross-machine sharding is an explicit **unimplemented v2 stub** (`ce-infer-shard::forward()` bails; feature off by default).

**The trust caveat (the crux):** the gVisor-doesn't-pass-GPUs tension is **sidestepped, not solved**. GPU code runs unsandboxed; the sandboxed container path is GPU-less. This is only acceptable because the GPU code is **the operator's own trusted engine**, never a stranger's binary. Trust everywhere is a signed, attenuating **capability chain** — it governs *who* may ask and *which* model/op, and gates container egress to `none`. It provides **no** defense against malicious *code* on the GPU, because no such code path is offered. To run a stranger's CUDA safely you'd need confidential-computing GPU TEEs (e.g. H100 CC) or a vetted-kernel allowlist — neither exists here.

---

## 3. How the credit system works, and is it really secure?

**The flow (mint → escrow → settle → burn):** Nodes mint `UptimeReward` per block (emission halves, hard cap `21e9 * CREDIT`). Money is `u128` base units (`1 credit = 10^18`), never floats. `JobBid` locks the bid into the payer's `locked_balance` (escrow). `JobSettle` requires host origin, no self-pay, a payer co-signature over `(job_id, host, cost)`, and `cost <= bid`; on apply it debits the payer gross, credits the host gross-minus-burn, and destroys a **1% settlement burn**. The burn is the keystone anti-wash primitive: every settlement/heartbeat/channel-close destroys 1% credited to no one, so a self-dealing wash cycle is net-negative.

**What is genuinely strong (proven by 98 passing `ce-chain` tests):**
- **Double-spend / free-vs-locked balance enforcement** — the strongest part. Cross-type in-block double-spend (transfer-then-bid/heartbeat/channel with the same credits) is explicitly closed and regression-tested. The validator rejects any block driving free balance negative.
- **Supply cap, halving, one-reward-per-block** — inflation attacks rejected even inside reorg candidates.
- **Real VRF consensus exists in the chain crate** — leader election by `vrf_ticket < threshold(weight, total)`, bond, equivocation slashing (100% bond burned, 25% to reporter), heaviest-weight fork choice. The docs and the old sybil audit claiming "PoW / longest-chain / first-wins / cheap 51%" are **STALE** — that code is gone.

**Honest threat-model verdict — no, it is not "100% secure," and that phrase is not a meaningful target.** "Secure" is always *against a threat model*. There is no such thing as 100% secure; there is only "secure against X, assuming Y." Here:

- **Defends well against:** honest operators, accidental bugs, casual cheats, naive double-spend, inflation, over-bidding, and self-dealing wash (made 1%-costly).
- **Assumes:** an honest weight-majority for finality (Nakamoto-style — a heavier valid fork *can* erase a payment, by design and by test).
- **Two real holes:**
  1. **Unconsented Heartbeat drain (E3) — the weakest part.** A `Heartbeat` is signed only by the host; there is **no cell co-signature and no on-chain bid linkage**. A malicious/modified host can bill any funded cell up to its **entire free balance** with no bid and no proof work ran. The chain accepts it — the project's own test `rogue_host_heartbeat_drains_cell_without_bid` asserts this passes as a "KNOWN LIMITATION." This is a direct credit-theft surface.
  2. **Consensus is dormant.** The VRF/bond/genesis-weight machinery is **not wired into the running node** — `ce-node` never sets genesis weights, never bonds, never calls `try_produce`. So live `total_consensus_weight == 0`, the VRF gate is bypassed, and the node accepts "one well-sealed block per 10s slot, heaviest-of-equal-weights reorg" with **no Sybil/bond/slashing actually in force**. The economic backbone exists only in the library and tests.
- **Minor:** off-chain payment-channel receipt replay after a host restart (E5, in-memory high-water mark, narrow).

So: the **accounting core is unusually honest and strong**; the **deployed-as-a-whole system is not yet secure against a motivated adversary** running modified nodes. Against "honest operators + accidental bugs" it largely holds; against an adversary it does not. Anyone selling it as "100% secure" is wrong on principle and on the code.

---

## 4. Plan: a hardened *and* powerful WASM engine

Sequenced so each phase ships a concrete security property. P1 is cheap and pure hardening; P2 is where "powerful" begins.

### P1 — Lock down the sandbox (no ambient authority, bounded buffers, deterministic limits)
**Build:**
- Replace `.inherit_stderr()` with a bounded `MemoryOutputPipe` (or discard) — `ce-wasm/src/lib.rs:208`.
- Add an **aggregate stdin cap** before concatenation (`lib.rs:277-283`) and a **module-size cap** in `resolve()` (`lib.rs:143`); reject over-limit before allocation.
- Add an **output-blob quota / GC** gate before `std::fs::write` (`lib.rs:292-295`).
- Pin a **deterministic engine config** in `engine_config()` (`lib.rs:73-83`): `nan_canonicalization(true)`, disable threads/relaxed-SIMD (and SIMD where verify-mode is required); for the verify path, **drop `clock_time_get`/`random_get`** from the linker (or inject a fixed seed/clock).
**Hooks:** `ce-wasm/src/lib.rs` only.
**Security earned:** removes the ambient-authority leak; closes host-RAM/disk DoS; makes the determinism claim *true* (real bit-reproducible swarm-verify).

### P2 — Capability-gated host ABI (the "powerful" part)
**Build:** a custom `Linker::func_wrap` host-import table exposing CE primitives — `ce_blob_open(cid)`, `ce_blob_put(bytes)→cid`, `ce_pubsub_publish(topic, msg)`, `ce_ledger_read(node_id)→balance`. Thread a **verified `ce-cap` capability chain into the `Store` state** (extend `CmdState`); **check the required ability on every host call** and reject if the chain doesn't grant it. Charge **fuel-as-gas** per host call.
**Hooks:** new `host_abi.rs` in `ce-wasm`; `Store` data struct (`lib.rs:196-199`); `ce-cap` verifier; `ce-node` passes the chain at launch (`ce-node/src/lib.rs:~1697`).
**Security earned:** modules gain real power (blobs/pubsub/ledger-read) **only under an explicit, attenuating, signed capability** — least-authority by construction, no ambient access. This is the design's center of gravity.

### P3 — WASI preview2 / components + richer compute + accounting
**Build:** migrate the command path to `wasmtime-wasi::p2` / the component model; define the CE host ABI as **typed WIT interfaces** (clean, versioned). Feed post-run fuel back into billing so the economy charges by **actual work**, not heartbeat wall-time.
**Hooks:** `ce-wasm` (swap `p1`→`p2`, add `Component`/component `Linker`); billing seam in `ce-container`/`ce-chain` (`compute_cost`).
**Security earned:** a typed, capability-shaped ABI surface (no untyped pointer ABI), and gas accounting that ties spend to consumed compute — closes the "billing is out-of-band" gap.

### P4 — The GPU story (WASM orchestrates, Docker-GPU executes)
**Build:** keep heavy AI in the **Docker-GPU lane**, not in WASM — wasmtime has no safe GPU passthrough and gVisor doesn't forward GPUs. Add `DeviceRequests`/`--gpus` + a `Limits.gpu` field + per-GPU caveats + GPU-time metering to `ce-container`. Use the **P2 WASM host ABI as the orchestrator**: a small, capability-gated WASM module plans/dispatches GPU jobs (via `ce_infer`/`mesh-deploy` host calls) and aggregates results — control plane in WASM, heavy tensor work in the GPU container.
**Hooks:** `ce-container/src/lib.rs:85-93` (HostConfig device requests); `ce-runtime` `Limits`; `ce-node` deploy caveats; orchestrator module over the P2 ABI.
**Security earned:** GPU work runs in the *sandboxed* lane with metered, capability-gated limits; untrusted *orchestration* logic is confined to the WASM sandbox; the "stranger's CUDA on your box" problem is explicitly deferred to GPU-TEE/vetted-kernel future work, not faked.

**Recommended first move:** ship **P1** now — it is a few hundred lines in one file, breaks nothing, removes the only "insecure"-tagged WASM findings, and makes the determinism promise honest. Then start **P2**, the capability-gated host ABI, which is the real unlock.
