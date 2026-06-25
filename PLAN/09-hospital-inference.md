# Hospital Inference App Design

Target repos: ce-infer/ ce-infer-ui/ ce-fleet/

# ce-infer — On-Prem Distributed LLM Inference for a Hospital Fleet on CE

## 0. Goals and non-negotiables

Build an on-prem, air-gappable LLM inference product for a hospital with ~1500 mixed Windows + Linux machines of unknown hardware. The killer property: **PHI never leaves the hospital LAN**. All workloads — clinical chat/Q&A, clinical-note/document summarization, internal coding assistant, general — are served from the fleet itself.

This is an **APP on CE**, built over `ce-rs` + `ce-cap` + content-addressed blobs/`ce-pin` + `/atlas` + mesh + `replicator`. It introduces **zero new node endpoints** — the node stays primitives-only, exactly as `swarm`, `rdev`, `ce-pin`, and `replicator` do. Standards honored: Rust 2024, `anyhow::Result`, `tracing` (no `println!` in libs), no `unsafe`, no `unwrap`/`expect` in prod paths, money as `ce_rs::Amount` integer base units (10^18/credit), HTTP amounts as decimal strings. No git commits/pushes here.

## 1. Architecture overview

### v1 — pool of whole-model workers + smart router (ship this)
Per h-research:arch, a 7–8B Q4_K_M GGUF fits on essentially the entire fleet (any 8GB box), a 13B on the better half, and **most clinical-grade tasks are served by whole-model workers behind a router** — robust, fault-isolated, embarrassingly parallel over the hospital's many-clinician/short-query load. Continuous batching on each worker is the throughput story; the network only carries prompt-in / tokens-out (NAT/LAN-trivial).

- Each capable node runs `ce-infer-worker`, which shells out to **llama.cpp `llama-server`** (do NOT write an engine) loading a quantized GGUF, bound to **loopback only**, behind an OpenAI-compatible local endpoint.
- `ce-infer-router` is the **OpenAI-compatible front door**: discovers workers via the CE **`/atlas`**, ranks least-loaded + highest-reputation (`swarm` `select_hosts` pattern), capability-gates each request, dispatches over mesh `AppRequest`, and **streams tokens back as SSE**.
- Every request is **capability-gated** (`ce-cap`) and **audited** via on-chain CE `/history` + a redacted audit topic.

### v2 — exo-style pipeline sharding (scaffold only, feature-gated `shard`)
For models too big for any single node (34–70B). **Pipeline-parallel over CE mesh streams; NEVER tensor-parallel over Ethernet** (TP's per-layer all-reduce barriers make a LAN slower than CPU single-box — h-research:arch). Memory-weighted contiguous layer placement (EXO), boundary activation tensor per hop (~KB/token), Petals-style rerouting on stage failure. Clearly separated module, OFF by default, with interfaces + stubs + tests.

### How it composes CE primitives (the leverage)
| Inference concept | CE primitive | Mapping |
|---|---|---|
| Worker discovery | `/atlas` + self-tags | Workers advertise `["infer","gpu"/"cpu",tier,"model:<id>"]`; router reads `ce.atlas()` |
| Capability-ranked placement | `/atlas` running_jobs + `/history` | Least-loaded + reputation ranking; tier-aware GPU-for-chat |
| Weight distribution | blobs + `ce-pin` | One GGUF -> one object CID; every node `get_object`s its slice over the LAN (torrent once, not 1500 copies); CID-verify IS integrity |
| Auth / who may infer | `ce-cap` chains | Signed attenuating chain rooted at org key; abilities `infer:chat/summarize/code/admin/shard` + `model_prefix` caveat |
| Activation transfer (v2) | mesh stream by node id | Hidden-state tensor to next stage, never ip:port |
| Audit / billing | `/history` + payment channels | Tamper-evident on-chain record + per-request receipt; record_ref hash only, never PHI |
| OpenAI front door | app HTTP (router), not node | SSE streaming reuses CE's stream pattern |
| Fleet install/enroll | `replicator` + org root | O(log N) P2P fan-out, capability-attenuated |

## 2. Install-time hardware probe + self-tiering

`ce-infer-core::probe()` runs on the worker at startup and detects RAM, cores, and GPU/VRAM (NVIDIA `nvidia-smi`, Apple Metal sysctl, AMD ROCm; no `unwrap`). Deterministic, documented tiering: `GpuHeavy` (VRAM≥22GB) → `GpuMid` (10–22) → `GpuSmall` (6–10) → `CpuHigh` (RAM≥24GB) → `CpuMid` (≥12) → `CpuLow` (≥8) → `Ineligible`. The probe selects the **largest registry model that fits** the tier (clinical-chat-8b Q4_K_M everywhere, clinical-chat-13b on the better half, clinical-34b reserved for GpuHeavy/v2). The profile is surfaced to the mesh as **atlas self-tags**, so the router self-organizes with no central registry. GPU nodes self-classify shard-capable for v2; CPU/RAM nodes are pooled whole-model workers.

## 3. Weight distribution via content-addressed blobs + ce-pin

A GGUF is published once with `ce-infer models publish` → `ce.put_object()` chunks it (1 MiB) into a manifest **CID**, and `ce-pin` replicates it across the LAN. The registry (`models.toml`, itself a signed blob) maps logical model id → `gguf_object_cid` + quant + ctx + ram/vram mins. Each worker `ce.get_object(cid)` pulls its model **over the LAN mesh from peers that already hold it** — BitTorrent-style — with every chunk CID-verified on the way in. This is strictly better than every competitor (EXO re-downloads from HuggingFace per node) and is **air-gap native**: no internet, no 1500 copies pushed from one place.

## 4. v1 worker + router protocol

**Worker** (`rdev`/`ce-pin` server pattern): poll `ce.messages()` / `ce.reply()` on topic `infer/v1`. Per request: decode → `ce_cap::authorize(...)` (op→ability, `model_prefix` caveat; denied attempts still audited) → forward to local `llama-server` loopback `/v1/chat/completions` → bill (channel receipt) + write audit → reply. Streaming: worker pushes token-delta messages back to the router on `infer/stream/<req_id>`, terminated by a final `finish_reason`.

**Router**: axum HTTP exposing OpenAI-compatible `/v1/chat/completions` (+`/completions`, `/models`). Per request: `ce.atlas()` filter `infer` + `model:<id>`, rank least-loaded × `history.delivered_work()`, forward the principal's `ce-cap` chain, `ce.request(worker, "infer/v1", ...)` (or stream relay), retry-on-next-candidate (Petals rerouting), bill + audit. Stateless beyond atlas cache + channels + stream relays → run multiple routers for HA.

## 5. v2 sharding scaffold (separated, gated off)

`ce-infer-shard` (`#[cfg(feature = "shard")]`, OFF): `PlacementPlanner` (memory-weighted contiguous layer ranges from atlas, signed pipeline plan broadcast as an app message), `ShardWorker` (holds a layer range, pulls only its shard CIDs, shells to llama.cpp RPC `rpc-server`/`--rpc`, receives/sends activation tensors over mesh **streams** by node id), rerouting on stage death by re-requesting the layer range from another peer holding the same shard CID, all gated by `infer:shard`. **Pipeline only — never TP over Ethernet.** Ships as interfaces + stubs + tests; not in the v1 routing path.

## 6. Cross-platform installer + fleet enrollment + admin swarm console

Trust spine: one offline **org root** key; every node pins its PUBLIC key in `roots`; membership = "I honor chains rooted at ce-root." **IT tooling owns file placement; the org root owns authorization** — a poisoned MSI mirror grants no fleet authority.

- **Packaging** (the real delivery gap): signed `ce-fleet.msi` (WiX) for Windows via GPO/SCCM/Intune machine-targeted; signed `ce-fleet.deb`/`.rpm` + hardened systemd units via Ansible + internal mirror for Linux; brew/launchd via Jamf for Macs. Each bundles `ce`+`rdev`+`replicator`+`ce-infer-worker`+the per-platform llama.cpp engine, pins the root pubkey, installs services running `ce start --no-mine` with **cloud bootstrap/relay disabled** (LAN mDNS only) and an egress-deny firewall.
- **Enrollment** (Tailscale-authkey on `ce-cap`): a short-TTL tag-scoped cap from a delegate; first-boot `ce-enroll` oneshot self-registers `{node_id, hostname, os, tier}` to the delegate `/enroll`, receives its working cap (audience-bound), writes `enrolled`, and **appears LIVE in the swarm console within seconds**. Zero clinician steps; QR/short-code for kiosks via the ce-host Tauri shell.
- **P2P propagation**: ~30–50 subnet **seeds** enrolled via SCCM/Ansible run `replicator seed --depth 2/3`, fanning binaries + the GGUF (via ce-pin) out as an attenuating tree (O(log N), leaves get `sync` only). SCCM/Ansible is the audited install-of-record; replicator is the fast LAN content path.
- **Admin "swarm" console** (generalizes `ce-host`): live grid of all 1500 nodes (grey→green as they enroll), models/replica-health panel, trust/enrollment panel (TTL tokens, on-chain revoke), audit panel, version/funnel ops. Browser talks to a few regional **delegate rollup** endpoints (`/fleet/rollup` aggregating atlas+status+history over each subtree), never 1500 SSE streams.

## 7. Staff chat UI + admin UI

`ce-infer-ui` (framework-free TS + Vite, like `ce-host`). **Staff chat**: Chat / Summarize / Code workload selector → OpenAI-compatible router with SSE streaming; per-answer provenance (serving worker node id) + "PHI stays on this network" banner; idle timer clears transcript + forces re-auth (auto-logoff). **Admin**: the swarm console (§6). SSO (OIDC/SAML) reverse proxy in front of the router maps each clinician to a per-principal CE capability; no raw API tokens in the browser.

## 8. HIPAA / air-gap / audit posture

Per h-research:hipaa, CE's primitives satisfy the Security Rule's technical safeguards by construction:
- **Air-gap / no egress** (§164.312(e)): LAN-only mDNS mesh, no `ce-net.com/bootstrap`, no public relay, no telemetry/license/model-download to the internet; egress firewall + a CI test asserting zero non-LAN sockets. PHI in the data plane **physically cannot egress**.
- **Authentication** (§164.312(d)): Ed25519 identity per machine *and* per principal; no shared keys.
- **Access control** (§164.312(a)): every inference gated by a signed attenuating `ce-cap` chain rooted at the org key; least-privilege via `model_prefix`; expiry + on-chain revocation; UI auto-logoff.
- **Audit + integrity** (§164.312(b)/(c)): every event (including denied attempts) recorded on the tamper-evident, hash-chained `/history` + a redacted audit topic carrying **only a record_ref hash, never PHI**; `ce-infer audit export` for OCR review; 6-year retention is operator storage policy.
- **Encryption**: transit over Noise-encrypted mesh (defense-in-depth on-LAN); the two real engineering gaps to close before deployment are **at-rest encryption** of any PHI-referencing store (and the CE chain DB) with FIPS-validated AES, and confirming mesh PHI traffic is encrypted on-LAN.
- **BAA posture**: vendor ships installed software on hospital-owned machines and never receives PHI → data-plane BA exposure avoided; only a software/support BAA may be needed.
*This is architecture guidance, not legal advice — final determination needs the hospital's compliance officer.*

## 9. Repo / directory layout (for the build agents)

```
ce-infer/            # Rust engine over ce-rs + ce-cap
  Cargo.toml         # workspace
  crates/
    ce-infer-core/   # lib: probe, registry, audit, capability abilities, shared types
    ce-infer-worker/ # bin ce-infer-worker: per-node inference server (llama-server child)
    ce-infer-router/ # bin ce-infer-router: OpenAI-compatible front door + load balancer
    ce-infer-cli/    # bin ce-infer: probe/models/status/audit/grant ops
    ce-infer-shard/  # lib (feature `shard`, OFF): v2 pipeline-parallel scaffold
ce-infer-ui/         # framework-free TS + Vite (like ce-host): staff chat + admin swarm console
  src/  index.html  vite.config.ts  package.json
ce-fleet/            # installer + enrollment + rollup + admin console build
  packaging/         # WiX MSI, cargo-deb, cargo-generate-rpm, systemd units, launchd plist
  enroll-service/    # app over ce-rs: /enroll + /fleet/rollup on each delegate
  console/           # admin build of ce-infer-ui served on-LAN
```

## 10. Milestones

1. **M1 — single worker + router happy path**: probe+tiering, registry+`get_object` GGUF, worker `llama-server` child, router `/v1/chat/completions` non-stream over atlas, capability gate. Demoable chat on one node.
2. **M2 — streaming + multi-worker**: SSE token relay, least-loaded ranking, retry-on-next, staff chat UI (chat/summarize/code).
3. **M3 — fleet**: MSI + deb/rpm + systemd, org-root enrollment, replicator GGUF/binary fan-out, admin swarm console + rollup.
4. **M4 — HIPAA hardening**: audit export, at-rest encryption, egress CI test, air-gap validation, payment-channel billing loop.
5. **M5 — v2 scaffold**: ce-infer-shard interfaces + stubs + tests behind `shard`, placement planner dry-run.

## 11. Risks
- Pipeline-latency ceiling (all sharded systems hit it) — keep v1 whole-model; restrict v2 to low-latency LAN peer sets.
- llama.cpp engine packaging across the Windows/Linux/GPU/CPU matrix is the heaviest installer burden.
- At-rest encryption + on-LAN transit encryption are genuine engineering gaps, not config — must land before any real PHI.
- Mesh AppRequest is unary; the token-streaming relay (`infer/stream/<req_id>`) is custom glue — validate latency/ordering early.
- Atlas self-tag freshness (60s) can mis-route during fast enroll waves; router must tolerate stale/failed workers via rerouting.
- Reusable one-time enroll-cap nonce tracking is new app-level state — must be HA across delegates.

## Engine spec
REPO: ce-infer/ — Rust 2024, anyhow::Result everywhere, tracing (no println in libs), no unsafe, no unwrap/expect in prod paths. Depends on ce-rs (path ../ce-rs) and ce-cap (path ../ce/crates/ce-cap). Money: ce_rs::Amount base units (u128/i128, 10^18/credit), HTTP amounts as decimal strings. Talks ONLY to a local CE node HTTP API (default http://127.0.0.1:8844). NO new node endpoints — everything is built from existing ce-rs methods.

CRATE/BINARY LAYOUT (single workspace, multiple binaries + a lib):
  ce-infer/Cargo.toml (workspace)
  ce-infer/crates/ce-infer-core/      lib: shared types, capability abilities, audit, model registry, probe
  ce-infer/crates/ce-infer-worker/    bin `ce-infer-worker`: the per-node inference server
  ce-infer/crates/ce-infer-router/    bin `ce-infer-router`: the OpenAI-compatible front door + load balancer
  ce-infer/crates/ce-infer-cli/       bin `ce-infer`: ops CLI (probe, models pull, status, grant helpers)
  ce-infer/crates/ce-infer-shard/     lib (v2, feature-gated `shard`): pipeline-parallel module, OFF by default

CAPABILITY ABILITIES (opaque ce-cap strings, verified with ce_cap::authorize against host key or org roots from $CE_INFER_ROOTS else $CE_DATA_DIR/roots):
  infer:chat        — submit a chat/completion inference request to a worker
  infer:summarize   — submit a summarization job
  infer:code        — submit a coding-assistant request
  infer:admin       — manage worker config / model assignment
  infer:shard       — participate as a pipeline stage (v2)
Caveats reused from ce-cap: not_after (expiry), audience (node id), and an app caveat `model_prefix` (restrict which model ids a cap may invoke, e.g. clinical-* vs code-*). Attenuation enforced per link exactly like rdev/replicator.

=== ce-infer-core (lib) ===
1. HARDWARE PROBE (probe.rs): `fn probe() -> CapabilityProfile`. Detects: total/available RAM (sysinfo crate), logical cores, GPU presence+VRAM by class — NVIDIA via `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` (shell, parse, no unwrap), Apple Metal via sysctl on macOS, AMD ROCm via rocminfo, fallback none. OS+arch from std::env::consts. Emits CapabilityProfile { os, arch, cores, ram_mb, gpu: Option<{vendor, vram_mb}>, tier }. SELF-TIER RULE (deterministic, documented): tier = GpuHeavy if vram_mb>=22000; GpuMid if vram_mb 10000..22000; GpuSmall if vram_mb 6000..10000; CpuHigh if no gpu and ram_mb>=24000; CpuMid if ram_mb>=12000; CpuLow if ram_mb>=8000; Ineligible below. The probe also picks the default model per tier from the model registry (see below). Profile is surfaced to the mesh as CE atlas self-tags (the worker advertises tags: ["infer","gpu"|"cpu", tier-string, os, arch, "model:<id>"]) so the router can read them straight from ce.atlas().
2. MODEL REGISTRY (registry.rs): a signed TOML manifest `models.toml` (content-addressed, distributed as a blob) mapping logical model ids -> { gguf_object_cid, quant, ctx, ram_min_mb, vram_min_mb, role: chat|summarize|code|draft, draft_model: Option<id> }. Default clinical models (admin-configurable, NOT hardcoded weights): clinical-chat-8b (Q4_K_M ~4.5GB, role chat/summarize, fits CpuLow+), clinical-chat-13b (Q4_K_M ~7.8GB, GpuMid/CpuHigh), code-7b (Q4_K_M, role code), and an optional clinical-34b (Q4_K_M ~20GB, GpuHeavy only) for v2 sharding. Registry chooses the largest model whose ram_min_mb/vram_min_mb fit the node tier. Each model id maps to a llama.cpp GGUF object CID.
3. AUDIT (audit.rs): every inference event, after authorization, is recorded as a CE on-chain interaction so it lands in /history (tamper-evident, append-only, hash-chained — satisfies HIPAA §164.312(b)/(c)). Implementation: open/maintain a payment channel per (payer,worker) session and bill per request (channel receipt = the economic + audit record), AND emit a signed CEP-1-style app message on a dedicated audit topic carrying { ts, principal_node_id, worker_node_id, model_id+version, capability_id (hash of presented chain), record_ref (caller-supplied SHA256 of the PHI record, NEVER raw PHI), op (chat|summarize|code), token_count, outcome }. The audit record stores ONLY a record hash, never PHI. A `ce-infer audit export` command pulls /history + the audit topic log for OCR review; 6-year retention is the operator's storage policy. Audit log writer must redact: assert payload contains no prompt/response text, only the record_ref hash.

=== ce-infer-worker (bin `ce-infer-worker`) ===
Role: the per-node inference server. One per capable fleet node. Pattern = rdev/ce-pin server: a `ce.messages()` / `ce.reply()` poll loop over mesh AppRequest (switch to /mesh/messages/stream SSE as a follow-up), authorizing every request with ce_cap::authorize.
Startup:
  1. Run probe() -> CapabilityProfile; if Ineligible, exit cleanly (node still meshes, just not a worker).
  2. Resolve assigned model from registry by tier (or admin override via infer:admin message).
  3. Ensure weights present: `ce.get_object(gguf_object_cid)` to pull the GGUF from the LAN blob store (CID-verified on the way in — content-addressing IS integrity). If absent locally, ce-rs fetches it chunk-by-chunk over the mesh from peers that have it (ce-pin guarantees availability). Write it to <data_dir>/ce-infer/models/<cid>.gguf.
  4. Launch the local inference engine as a child process and own its lifecycle: shell out to `llama-server` (llama.cpp) bound to 127.0.0.1:<rand-port> ONLY (loopback, never LAN/0.0.0.0), with flags: --model <gguf path>, --ctx-size <registry ctx>, --parallel <N for continuous batching>, -ngl <99 if gpu else 0> (GPU offload layers), --port. On macOS llama.cpp uses Metal, Linux+NVIDIA CUDA, else AVX2 CPU — same GGUF file. Do NOT write an inference engine. The engine binary is bundled by the installer (ce-fleet) per-platform.
  5. Advertise capacity+tags to atlas (this happens via the node's normal 60s capacity broadcast; the worker just sets the tags through the capability self-tag mechanism the atlas already exposes) and advertise_service("infer:<model-id>") on the DHT.
Request handling (topic `infer/v1`): on each inbound AppRequest:
  a. Decode { op, model_id, messages|prompt, max_tokens, stream:false (mesh req/reply is unary; streaming handled by the router chunking — see router), caps (hex chain), record_ref }.
  b. authorize(host_id, roots, &[], now(), &sender_id, ability_for_op, &chain, &is_revoked) where ability_for_op maps op->infer:chat|summarize|code; also enforce model_prefix caveat. Deny -> reply error, no execution, but STILL audit the denied attempt (outcome=denied).
  c. Forward the request to the local llama-server loopback OpenAI endpoint (POST /v1/chat/completions) via reqwest; collect the completion (or stream chunks — see streaming).
  d. Bill: sign/accumulate a payment-channel receipt for this session (per-token or per-request priced in base-unit Amount; Heartbeat for long jobs). Write the audit record (audit.rs).
  e. reply() with { text, token_count, model_id, finish_reason }.
STREAMING: mesh AppRequest is unary, so to stream tokens the worker, when given a request with stream=true, opens a return AppRequest stream of incremental token messages back to the router's node on topic `infer/stream/<req_id>` (each message = a token delta), terminated by a final message with finish_reason. The router relays these as SSE to the browser. (This reuses ce.send_message for the deltas + ce.request for the initial handshake; no node changes.)

=== ce-infer-router (bin `ce-infer-router`) ===
Role: the OpenAI-compatible front door + smart load balancer. Runs an HTTP server (axum) on the LAN (behind hospital SSO reverse proxy) exposing OpenAI-compatible endpoints so any client/UI works:
  POST /v1/chat/completions (stream + non-stream, SSE) — the chat/summarize/code workloads all route here, distinguished by model id and an X-CE-Op header (chat|summarize|code).
  POST /v1/completions
  GET  /v1/models — derived from the registry + which models are actually live in the atlas.
Routing logic (the smart router):
  1. On each request, ce.atlas() -> filter entries with tag "infer" and tag "model:<requested-model>" (or pick a model that satisfies the op if client sent a logical alias like "clinical-chat"). Tier-aware: prefer GPU workers for interactive chat, allow CPU workers for async summarization.
  2. Rank candidates: lowest running_jobs first (least-loaded), tie-break by ce.history(node_id).delivered_work() (reputation), exclude stale (last_seen_secs too old). This is the swarm select_hosts() pattern.
  3. Capability: the router holds (or the calling principal presents) a ce-cap chain rooted at the org key granting infer:<op>; the router forwards it as `caps` in the worker AppRequest. Per-principal caps come from the UI/SSO identity (mapped to a per-clinician CE identity or a router-held cap attenuated per request).
  4. Dispatch: ce.request(worker_node_id, "infer/v1", payload, timeout) for non-stream; for stream, send the handshake then subscribe to `infer/stream/<req_id>` and relay deltas to the client as `data: {choices:[{delta:...}]}` SSE chunks (OpenAI wire format).
  5. Fault tolerance: on worker timeout/502, re-rank and retry on the next candidate (Petals-style rerouting). Circuit-break a worker after K consecutive failures.
  6. Bill + audit: open/track a payment channel per (router-principal, worker) and write the audit record per request (delegated to ce-infer-core::audit).
The router is stateless beyond the atlas cache + open channels + active stream relays; multiple routers can run for HA (clients hit any).

=== ce-infer-cli (bin `ce-infer`) ===
Ops CLI: `ce-infer probe` (print tier+chosen model), `ce-infer models pull <model-id>` (get_object the GGUF), `ce-infer models publish <gguf-file> --id <id>` (put_object -> CID, update models.toml, ce-pin replicate so it spreads across the LAN), `ce-infer status` (atlas view of live workers), `ce-infer audit export --since <h> -o audit.jsonl`, `ce-infer grant <node-id> --can infer:chat,infer:summarize --model-prefix clinical- --expires 30d` (thin wrapper over `ce grant`).

=== ce-infer-shard (lib, v2, feature `shard`, OFF) ===
Clearly-separated pipeline-parallel scaffold for models too big for any single node. NOT wired into v1 routing. Honors h-research:arch: PIPELINE-parallel only, NEVER tensor-parallel over Ethernet. Components (interfaces + stubs + tests, no production path yet):
  - PlacementPlanner: reads ce.atlas(), assigns contiguous layer ranges proportional to advertised vram/ram (EXO memory-weighted ring), prefers high-history hosts, emits a signed "pipeline plan" {model_id, stages:[{node_id, layer_lo, layer_hi, weight_shard_cid}]} broadcast as an app message.
  - ShardWorker: holds a layer range, pulls only its shard CIDs via get_object, runs that slice (shells to llama.cpp RPC backend `rpc-server` / `--rpc`), receives a hidden-state activation tensor from the previous stage over a CE mesh STREAM addressed by node id, computes, sends activations to the next stage. Only the boundary activation tensor crosses the wire (~KB/token).
  - Rerouting: if a stage dies, re-request its layer range from another atlas peer holding the same shard CID.
  - Capability: every stage gated by infer:shard.
  Gate it behind `#[cfg(feature = "shard")]` and document it as experimental. v1 ships without it.

TESTS: unit tests for probe tiering (table-driven), registry model selection, capability authorize/attenuation (model_prefix caveat rejects out-of-prefix model; denied attempt still audited), audit redaction (assert no PHI text in record), router ranking (least-loaded + reputation). Integration sketch: spin a fake llama-server (a tiny stub HTTP returning canned tokens), one worker + one router, assert end-to-end chat completion + audit record written. difficulty=1 in any chain-touching test; NEXT_PORT atomic for ports.

## UI spec
REPO: ce-infer-ui/ — framework-free TypeScript + Vite, same stack/shape as ce-host/ (a single reactive Store owning polling+SSE, pure client over HTTP/SSE; no React). Two surfaces in one app, gated by SSO role. Talks to the ce-infer-router OpenAI-compatible HTTP API (NOT the node directly for inference) and, for the admin swarm view, to the ce-fleet delegate rollup API + node /atlas, /history via @ce-net/sdk (ce-ts).

DESIGN: clinical, calm, high-contrast, no emojis. Monospace for ids/hashes. Must behave well under workstation auto-logoff/screen-lock (HIPAA §164.312(a)(2)(iii)): idle timer clears the chat transcript from memory and requires re-auth.

=== STAFF CHAT UI (role: clinician) ===
Screens:
1. Chat (default). A workload selector at top: Chat / Summarize / Code (sets X-CE-Op header + chooses model alias clinical-chat | clinical-chat (summarize prompt template) | code-7b). Streaming token display via SSE from POST /v1/chat/completions (stream=true). Standard message thread UI. A "PHI stays on this network" banner + the worker node id that served the response (provenance), shown small under each answer.
   - Summarize sub-mode: a large paste box for a clinical note/document + a "Summarize" action; calls the same endpoint with a summarization system prompt; output marked "AI-generated summary — verify against source."
   - Code sub-mode: code-oriented input (monospace), routes to code-7b workers.
2. History (this clinician's own session list) — local only, cleared on logoff.
3. Status pill: shows "On-prem · LAN-only · N workers online" pulled from GET /v1/models + a lightweight router /healthz that returns live worker count.
Auth: hospital SSO (OIDC/SAML) via reverse proxy in front of the router; the UI sends the principal identity; the router maps it to the per-principal CE capability. No raw API tokens in the browser.
Endpoints called: POST /v1/chat/completions (router), GET /v1/models (router), GET /healthz (router).

=== ADMIN UI (role: fleet admin) — the "swarm" console, generalizes ce-host ===
Reuses ce-host's Store + SSE + atlas + capabilities panel, pointed at the ce-fleet delegate rollup rather than one node. Screens:
1. Swarm view (headline): live grid of all ~1500 nodes (Tailscale-machine-list × torrent-peer-pane). Columns: node id/hostname/OS · status (joining→live→idle→offline, grey→green animation as nodes enroll) · tier (GpuHeavy/…/CpuLow) · assigned model · running inference jobs · last seen/uptime · tags · cap expiry. Sources: ce-fleet /fleet/rollup (aggregated atlas+status across subtree), per-node /status, /history; SSE for transitions. Filter by tier/model/tag/site.
2. Models panel: which model ids are published (CIDs), per-tier assignment, replica health across the LAN (from ce-pin status), a "Publish model" action (calls ce-infer models publish server-side) and a "Reassign model to tier" action (infer:admin message to workers).
3. Trust/enrollment panel (verbatim from ce-host capabilities panel + fleet additions): the org root + regional delegates, active enrollment tokens with TTL countdown/scope, "Generate enrollment token" (server-side `ce grant`, returns token+QR), on-chain revoked set (GET /capabilities/revoked) and "Revoke node" (POST /capabilities/revoke). Mutations require an admin holding an org-root-derived cap.
4. Audit panel: searchable view over the audit topic + /history — per inference event {ts, principal, worker, model+version, capability id, record_ref hash, op, tokens, outcome}; export to JSONL for OCR review. Explicitly shows NO PHI is present (record_ref only). 6-year retention note.
5. Health/ops: version sprawl (drives the replicator update wave), enrollment funnel (installed vs enrolled vs live), per-node drill-down (/history reputation).
Endpoints called: ce-fleet delegate /fleet/rollup, /enroll (token gen), @ce-net/sdk over node /atlas, /status, /history/:id, /capabilities/revoked, POST /capabilities/revoke; router /v1/models for live-model truth.
Architecture: do NOT open 1500 SSE streams from the browser — the browser talks to a few regional delegate rollup endpoints that aggregate their subtree. Read panels token-free; mutating actions capability-gated. Build/deploy like ce-host (Vite static bundle served on-LAN behind SSO).

## Fleet spec
REPO: ce-fleet/ — the cross-platform installer + enrollment + admin rollup service. Reuses replicator/ + ce-cap + the org capability root verbatim; no node changes. Three parts: packaging, an enrollment+rollup service (app over ce-rs), and the admin console (served from ce-infer-ui admin build).

TRUST SPINE (from h-research:fleet §0): one Ed25519 org root key (`ce-root`) lives offline/HSM, never on a fleet node. Every node lists ce-root's PUBLIC key in its accepted roots (<data_dir>/roots, also honored by ce-infer via $CE_INFER_ROOTS). Fleet membership = "I honor chains rooted at ce-root." Adding a node = ship binaries + root pubkey + an attenuated cap. Removing = expiry or on-chain RevokeCapability (subtree-killing) or root rotation. IT/Intune/SCCM owns file placement + service lifecycle; the org root owns authorization — compromising the deploy channel does NOT grant fleet authority (root pubkey is a pin).

PACKAGING (the main delivery gap to fill — CE today has brew/scoop/choco/aur/install.sh but no MSI and no service-installing deb/rpm):
  Windows: one signed (Authenticode) `ce-fleet.msi` (WiX/cargo-wix) bundling ce.exe + rdev.exe + replicator.exe + ce-infer-worker.exe + the per-platform llama.cpp engine binary (CUDA build + CPU/Vulkan fallback) + the GGUF-less registry. Installs to C:\Program Files\CE\, drops org PUBLIC root key to C:\ProgramData\ce\roots, registers a machine-context Windows Service (LocalSystem or NT SERVICE\ce) running `ce start --no-mine` with failure-restart, plus a `ce-infer-worker` service. Silent: `msiexec /i ce-fleet.msi /qn /norestart CE_ROOT_KEY=<hex> CE_ENROLL_TOKEN=<short-ttl-cap> CE_DATA_DIR="C:\ProgramData\ce"`. Distribute via GPO / SCCM(MECM) / Intune (Win32 app), machine-targeted — same msiexec line for all three. MSI carries only the PUBLIC root key; the per-node working cap is obtained at first-boot enroll.
  Linux: signed (GPG) `ce-fleet.deb` (cargo-deb) + `ce-fleet.rpm` (cargo-generate-rpm or nfpm) installing ce/rdev/replicator/ce-infer-worker + engine to /usr/local/bin, creating a `ce` system user + /var/lib/ce (chmod 700), dropping root pubkey to /var/lib/ce/roots, installing a HARDENED systemd unit (Type=simple, User=ce, ExecStart=/usr/local/bin/ce start --no-mine --data-dir /var/lib/ce, Restart=always, NoNewPrivileges, ProtectSystem=strict, ProtectHome, ReadWritePaths=/var/lib/ce, PrivateTmp) plus a `ce-infer-worker.service`, and a oneshot `ce-enroll.service` (Before=ce-infer-worker, ConditionPathExists=!/var/lib/ce/enrolled). postinst: systemctl enable --now. Firewall: open 4001/tcp+udp (libp2p LAN), keep 8844 + the engine loopback-only. Distribute via Ansible role `ce_fleet` (idempotent, no_log enroll tokens from Vault) + an internal apt/yum mirror for air-gapped updates.
  macOS (clinical Macs): existing brew tap + a launchd plist via Jamf/MDM.
  AIR-GAP: all packages disable cloud bootstrap — `ce start --no-mine` with NO ce-net.com/bootstrap, NO public relay, NO DCUtR to internet; mesh runs LAN-only on mDNS + static LAN multiaddrs. Egress firewall denies non-LAN outbound; a CI test asserts zero non-LAN sockets. No telemetry/license-check/model-download reaches the internet. GGUF models + registry + engine binaries arrive via the package or the internal blob LAN (ce-pin), never the internet. Signed artifacts verified before load.

ENROLLMENT (the "one click to join", Tailscale authkey model on ce-cap):
  An enrollment token = a ce-cap issued by ce-root (or a regional delegate): minimal abilities (status + infer:chat-class as needed), resource scoped to a tag (tag=radiology), caveats.not_after minutes-to-hours, audience = node id where known. Generated with existing `ce grant <node-id> --can ... --resource tag=... --expires 2h`. For mass rollout, a reusable bootstrap cap (tag + very short TTL + one-time nonce tracked by the enrollment service — the one ergonomics piece to add at app level, NOT a node change).
  First-boot flow (ce-enroll oneshot): node runs `ce start` (gets node id, joins LAN mesh) -> ce-enroll reads CE_ENROLL_TOKEN (or claims one from delegate /enroll using a collection bootstrap secret) -> POST {node_id, hostname, os, tier (from ce-infer probe)} to delegate /enroll -> delegate (holding an org-root cap) issues the node its real tag-scoped longer-lived working cap (audience=node id) granting infer:* as policy dictates -> node stores it, writes /var/lib/ce/enrolled, exits 0 -> node + worker appear LIVE in the swarm console within seconds. Zero clinician steps; for kiosks, a QR/6-word short-code enroll via a Tauri tray (reuse ce-host Tauri shell).

P2P PROPAGATION (replicator, the scaling multiplier): after a seed set (~1 per subnet/VLAN, ~30-50 nodes) is enrolled via SCCM/Ansible, do NOT push from one console to 1500 nodes. Each seed holds a root cap (--can sync,spawn) and runs `replicator seed <targets> --depth 2/3`, fanning ce/rdev/replicator/ce-infer-worker binaries AND the model GGUF (via ce-pin/get_object over the LAN) out as a tree (O(log N) depth). Every hop attenuates (abilities intersected, expiry clamped, audience fixed) — leaf gets sync only, can't replicate. Binary/model updates reach every node in 2-3 LAN hops. SCCM/Ansible remains the audited install-of-record + fallback; replicator is the fast content path. Topology: 1 org root (offline) -> 3-5 regional delegates (per site, run /enroll + rollup + console) -> ~30-50 subnet seeds -> leaves.

ENROLLMENT + ROLLUP SERVICE (app over ce-rs, on each delegate — NOT a node primitive): exposes
  POST /enroll {node_id, hostname, os, tier} -> issues working cap via `ce grant`, tracks one-time enroll-token nonces.
  GET /fleet/rollup -> aggregates ce.atlas() + per-node /status + /history across the delegate's subtree so the console scales past one node (browser hits a few delegates, not 1500 nodes).
  Generate-enroll-token + revoke endpoints back the admin Trust panel.

WHAT TO BUILD (all app-level, no node changes): WiX MSI + cargo-deb + cargo-generate-rpm + hardened systemd unit + ce-infer-worker service units; ce-enroll oneshot glue; reusable bootstrap-cap mode (nonce-tracked) in the enrollment service; the /enroll + /fleet/rollup delegate service; the admin console (ce-infer-ui admin build generalizing ce-host). Reuse verbatim: replicator/src/main.rs (onward_abilities/attenuate/delegate), ce/docs/capabilities.md model, ce-host Store+panels.

## Risks
- Pipeline-parallel sharding (v2) hits the same per-token latency ceiling every distributed-inference system hits; keep v1 as whole-model workers and confine v2 to low-latency LAN peer sets. Never tensor-parallel over Ethernet (all-reduce barriers make a LAN slower than CPU single-box).
- Packaging the llama.cpp engine across the full Windows/Linux x CUDA/ROCm/Metal/CPU matrix is the heaviest installer burden and the main delivery gap (CE has no MSI / service-installing deb-rpm today).
- At-rest encryption (FIPS AES on chain DB + any PHI-referencing store) and confirmed on-LAN in-transit encryption of mesh PHI traffic are real engineering gaps, not configuration — both MUST land before any real PHI touches the system.
- Mesh AppRequest is unary; token streaming is custom glue (infer/stream/<req_id> delta messages relayed as SSE) — validate latency, ordering, and backpressure early.
- Atlas self-tag freshness is ~60s, so the router can briefly mis-route during fast enrollment waves or worker churn; router must tolerate stale/dead workers via Petals-style retry-on-next-candidate.
- Reusable one-time enrollment-cap nonce tracking is new app-level state that must be highly available across regional delegates, or enrollment stalls/double-uses.
- spawn (used by replicator) runs un-sandboxed native code; gate it strictly behind the org-root-anchored attenuating chain and keep SCCM/Ansible as the audited install-of-record so a self-propagating binary is never ungoverned.
- HIPAA compliance is ultimately the hospital compliance officer's determination; this design is architecture guidance, not legal advice, and the air-gap must be real (no telemetry/license/model-download phone-home).
