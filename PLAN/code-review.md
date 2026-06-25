# CE-NET Code Review — Synthesis

_Synthesized from six area reviews: foundation, security, portfolio, data-drive, sdk-frontend, architecture._

---

## 1. Executive Summary

**Overall health: strong.** The consensus/economy core (ce-chain), the ce-cap capability verifier, the E2E crypto (ce-mail/ce-notes), the SDKs (ce-rs, ce-coord, ce-ts), and architecture-fit (node stays primitives-only, no app adds node endpoints, money is integer base units with decimal-string wire form) are all disciplined and heavily property-tested. No consensus break, no theft vector, and no real XSS sink was found.

The defects cluster in **authorization boundaries**: capabilities that are authenticated and correctly attenuated but then **not bound to the resource they are used against** at the enforcement point. Three of these are escalation bugs (Drive cross-tenant, CDN bearer-over-HTTP, resource-caveat bypass on Deploy). A recurring secondary theme is **prefix-match confusion** (`starts_with` without a `/` boundary) appearing independently in five crates, and **unbounded-memory growth** in long-running dedup/seen sets.

### Count by severity (deduped)

| Severity | Count |
|---|---|
| CRITICAL | 1 |
| HIGH | 5 |
| MEDIUM | 7 |
| LOW | 14 |

---

## 2. CRITICAL + HIGH Findings

### CRITICAL

#### C1 — Drive capability never bound to drive id (cross-tenant authorization bypass)
**File:** `ce-drive-serve/src/serve.rs:106-122` (and `op_share` at 590-606)
**Problem:** `authorize_req` selects the tenant by `req.drive` but never checks the capability is scoped to that drive — gate 2 only enforces `path_prefix` and ends with `let _ = drive;`. A host serving multiple drives roots every cap at its own key, so a cap legitimately issued for drive A (e.g. `path_prefix /` or `/docs`) authorizes the identical op+path on drive B, C, etc. on the same host. `op_share` likewise mints sub-caps with only a `path_prefix` caveat and `Resource::Any`, so shared links are also cross-drive. Defeats multi-tenant isolation — the host's core security property.
**Fix:** Encode the drive id into a caveat (mirror ce-db's `ce-db/<collection>` / ce-storage's `<bucket>/<prefix>`, or a dedicated resource/tag), and verify in `authorize_req` that the leaf's drive scope equals `req.drive` before any op. Mint Share sub-caps with the same drive binding.

---

### HIGH

#### H1 — Deploy RPC ignores `max_cpu`/`max_mem_mb`/`max_credits` caveats (caveat bypass)
**File:** `ce/crates/ce-node/src/lib.rs:1634`
**Problem:** `handle_incoming_rpc` calls `ce_cap::authorize` for `deploy`, then takes `cpu_cores`, `mem_mb`, and `bid` straight from the `RpcRequest::Deploy` fields and builds `Limits` without ever reading the leaf capability's caveats. ce-cap documents that resource ceilings are "enforced by whichever action consumes them" — but deploy consumes none. A holder of a cap with `max_cpu=Some(2)/max_mem_mb=Some(512)/max_credits=Some(100)` can deploy a 64-core/256GB/unbounded-spend job. (`allowed_ports` IS enforced for tunnel at 815-820, so this is an oversight, not design.)
**Fix:** After `authorize()` succeeds, read `caps.last().cap.caveats` and reject if `cpu_cores > max_cpu`, `mem_mb > max_mem_mb`, or `bid > max_credits` (each `Some(limit)` is a ceiling). Mirror the `allowed_ports` pattern. Apply to any future action that consumes resources/credits.

#### H2 — CDN HTTP front-end trusts unauthenticated `X-Ce-Node-Id` header as the requester
**File:** `ce-cdn/src/server.rs:104`
**Problem:** `requester_id()` reads the requester `NodeId` from the client-settable `X-Ce-Node-Id` header and the cap chain from a header, then calls `ce_cap::authorize(... requester ...)`. On the mesh path (`host.rs`) `from` is the cryptographically authenticated libp2p sender; on the HTTP path nothing proves the caller holds X's key. Anyone who obtains a copy of the hex cap chain (it travels in a header — logs/proxy/referrer leakage) can set `X-Ce-Node-Id: X` and read private content. Silently downgrades "capability-gated private content" to a pure bearer token over HTTP, losing the audience-binding guarantee the rest of the system relies on.
**Fix:** Require proof-of-possession on the HTTP edge (a short challenge signed by the requester key, or a presigned/expiring token bound to the request like ce-storage's presigned links). Do not accept `X-Ce-Node-Id` as identity without a signature. For true holder-binding, route private reads over the authenticated mesh path only.

#### H3 — Proof-of-retrievability satisfiable by re-fetching from another replica
**File:** `ce-pin/src/host.rs:185-198`
**Problem:** `do_audit` answers the PoR challenge with `client.get_blob(chunk_cid)` then hashes it, but `get_blob` is local-first with a **mesh fetch-by-hash fallback**. A host that discarded the bytes can transparently pull the challenged chunk from any other pinning replica and produce a valid proof — so the audit proves availability-somewhere, not retrievability-here. Breaks the economic guarantee that paid replicas actually hold the data.
**Fix:** Audit must read from the LOCAL store only (`get_blob_local` / no-mesh path), failing if the chunk is not held locally. Add a local-only fetch to the SDK if one does not exist.

#### H4 — ce-storage `scope_allows` unbounded prefix match (sibling-prefix escalation)
**File:** `ce-storage/src/caps.rs:62-64`
**Problem:** `scope_allows` returns `scope.bucket == bucket && key.starts_with(&scope.prefix)`. With a folder-style prefix lacking a trailing slash (e.g. `photos`), a holder scoped to `photos` can read/write `photos-secret/x` because `"photos-secret/x".starts_with("photos")`. Same prefix-confusion class the Drive's `enforce_prefix` correctly defends against.
**Fix:** Match on a path boundary: allow iff prefix is empty, `key == prefix`, or `key.starts_with(&format!("{prefix}/"))` (after normalizing trailing slashes). Apply everywhere a storage prefix gates access.

#### H5 — WasmDriveCore convergence topic keyed by device id — devices never converge
**File:** `ce-drive-web/src/core/wasm-adapter.ts:107,164,206`
**Problem:** `bootstrap()` subscribes to `driveTopic(this.self)` and `emit()` publishes to `driveTopic(this.self)`, where `self` is the local device's node id. Every device publishes to AND subscribes to a topic derived from its OWN id, so two devices of the same user have different node ids → different topics → they never see each other's `MoveOp`/`ContentOp` frames. The merged-log CRDT can never converge across devices — the entire multi-device story is silently single-device, directly contradicting the file's own header.
**Fix:** Pass a stable, shared drive id (derived from the drive's root capability / owning identity — the SAME value on every device) into `WasmDriveCore` and use it for `driveTopic()`. Keep `self` only for CRDT op authorship. Add a two-core / one-shared-topic convergence integration test.

---

## 3. MEDIUM and LOW Findings (grouped)

### Theme A — Prefix-match confusion (`starts_with` without a `/` boundary)
The same bug class appears in five places. Fix all with a boundary-aware check: `p == prefix || p.starts_with(&format!("{prefix}/"))` after trimming a trailing slash.

- **[LOW]** `ce/crates/ce-cap/src/lib.rs:182` — `Caveats::is_narrower_or_equal` uses raw `starts_with` for `path_prefix` attenuation; `/home/userdata` looks "within" `/home/user`. Shared verifier, so every consumer inherits it. (Latent: only rdev consumes `path_prefix` today.)
- **[LOW]** `rdev/src/main.rs:930` — `safe_target` enforces `path_prefix` with raw `starts_with`; `proj` admits `project-secret/x`. Defense-in-depth only (the `..`-reject + canonicalize-parent check is the real containment).
- **[LOW]** `ce-query/src/caps.rs:56` — dataset scope uses exact-match while ce-cap narrows `path_prefix` by prefix; currently safe (exact is stricter) but a latent semantic mismatch. Pick exact or prefix and assert it in a test.

### Theme B — Unbounded memory growth in long-running loops
- **[MEDIUM]** `ce-mail/src/mailbox.rs:121` — `accept()` evicts overflow envelopes from the queue but never prunes their ids from `self.seen`; a cheap memory-exhaustion vector. (The receipt path at 211-220 does this correctly — fix the envelope path to match.)
- **[MEDIUM]** `ce-cdn/src/host.rs:206` — edge host loop's `seen: HashSet<u64>` of reply tokens is never bounded; slow leak per request. Bound to an LRU/ring or clear on the revocation-refresh tick.
- **[MEDIUM]** `ce-drive-web/src/core/wasm-adapter.ts:124-126,183-191,198-204` — `seenOps` (keyed by full op-payload hex) and `opLog` grow without bound for the life of the page. Cap `seenOps` with an LRU keyed by a short op hash; snapshot+truncate `opLog`.
- **[LOW]** `ce-coord/src/lib.rs:161` — inbox dedup window is 8192 entries; a message redelivered after 8192 newer ones is re-dispatched (plus `received_at` in the fingerprint defeats dedup across re-timestamping). Drop `received_at` from the fingerprint; document Stream<T> as at-least-once.

### Theme C — Money parse/overflow robustness (CLI/SDK path, not the node boundary)
- **[MEDIUM]** `ce-rs/src/amount.rs:59` — `parse_credits`: `whole * CREDIT + frac` with no overflow guard (debug panic / release wrap), and `parse_credits("-")` yields `Amount(0)`. Use `checked_mul`/`checked_add` returning an error; reject empty/sign-only/internal-`-` bodies; add tests for over-range and `"-"`/`""`/`"1.-5"`.
- **[LOW]** `ce-rs/src/amount.rs:24` — `from_credits` / `parse_credits` overflow-panic on inputs above ~1.7e20 credits; same checked-arithmetic fix.
- **[LOW]** `ce-ts/src/amount.ts:53-61,159-169` — `fromCredits(number)` faithfully encodes float error (`fromCredits(0.1+0.2)` → base units for `0.30000000000000004`). Restrict the `number` overload to integers; route fractional credits through `parseCredits(string)`.

### Theme D — Economic-leak / pre-screen mismatches (total vs free balance)
- **[MEDIUM]** `ce/crates/ce-node/src/lib.rs:1995` — `emit_heartbeats` gates on **total** balance, but `append()` validation requires **free** balance (minus locked bids/channels/bond). A payer can lock its balance so each Heartbeat is broadcast by the host but silently rejected by validators — job keeps running, host never paid (free-compute leak). Fix: check `balance - locked_balance` before signing; reconsider total-vs-free anywhere the node pre-screens a tx it will broadcast.
- **[LOW]** `ce/crates/ce-node/src/api.rs:681` — `POST /transfer` pre-check uses total balance and returns 201 even when funds are locked, producing a "submitted but never mined" state. Mirror `channel_open()` (line 1426): subtract `locked_balance`, return 402.

### Theme E — Convergence / consistency bugs in the non-Merged Drive paths
- **[MEDIUM]** `ce-drive/crates/ce-drive-core/src/drive.rs:124-134` — `apply_remote_content` applies a `ContentOp` (no Timestamp) in arrival order; `mode` is last-applied and version history is order-dependent, so replicas diverge. (`SyncedDrive`'s `StampedContentOp` path is fine.) Fix: remove `apply_remote_content` (force callers onto `SyncedDrive`), or give `ContentOp` a Timestamp and apply in ascending-ts order.
- **[MEDIUM]** `ce-drive-client/src/mirror.rs:65-86` — `sync()` advances the cursor through polling, then re-bootstraps from an older `Open` snapshot and sets `cursor = cursor.max(opened.server_seq)`; changes in `(snapshot_seq, cursor]` are silently skipped. Fix: set `cursor = opened.server_seq` (not max), or snapshot first and poll strictly after it.
- **[MEDIUM]** `ce-drive-serve/src/serve.rs:437-472` — `op_write` records `FileContent::new(object_cid, size, ...)` from client-supplied values without verifying the manifest exists or that `total_size == size`; lets a writer poison metadata (broken reads, wrong sizes feed Quota/billing). Reads stay safe (CID-verified). Fix: fetch+parse the manifest and verify `total_size == size` before committing.
- **[LOW]** `ce-drive/crates/ce-drive-core/src/content.rs:177-192` (+ `ce-drive-wasm/src/crdt.rs:462-472`) — `apply` sets `mode` from the last-applied op while `cid` is mtime-LWW; a file can get the content of one write and the mode of another. Deterministic under the Merged fold but surprising. Fix: only update `mode` when `record()` returns true.
- **[LOW]** `ce-drive/crates/ce-drive-core/src/store.rs:71-76` — `put_bytes` probes every distinct chunk with `get_blob` before delta upload (N serial round-trips + benign TOCTOU). Rely on `put_blob`'s idempotent dedup or batch the probe.

### Theme F — Capability / revocation identity matching
- **[MEDIUM]** `ce-host/src/panels/grants.ts:92,154` — revoke/match keyed on **nonce alone**; the on-chain revoked set is `(issuer, nonce)`. A different issuer sharing a nonce shows as revoked / mis-flags a local grant. (`wasm-adapter.ts:reconcileRevocations()` does this correctly.) Fix: match `r.nonce === g.nonce && r.issuer === selfNodeId`.
- **[LOW]** `ce-drive-web/src/core/wasm-adapter.ts:517` — share-link nonce = `Date.now()*1000 + Math.random()*1000` (only 1000 slots/ms, collision-prone, and `parseInt` loses precision near 2^53). A collision can alias revocations. Fix: CSPRNG nonce via `crypto.getRandomValues`, keyed exactly (no hex re-parse).

### Theme G — Crypto / framing robustness (no exploit today)
- **[LOW]** `ce-mail/src/crypto.rs:114` — `SealedBody` binds no AAD, unlike ce-notes; tampering still detected via KDF/nonce, but the body isn't pinned to its envelope context (mitigated by signed `body_cid`). Optionally bind `AAD = b"ce-mail-sealed-box-v1" || recipient_node_id`.
- **[LOW]** `ce-meet/src/admit.rs:182` — resume-token MAC omits the NUL separator between `expires_at` and `seq_floor` that its own doc promises; safe today (both fixed-width 8-byte LE) but contradicts the stated invariant. Add the missing `h.update([0u8])` or fix the comment.

### Theme H — Other latent robustness gaps
- **[LOW]** `ce-query/src/join.rs:58` — type-blind equi-join: `uid=1` (number) joins `uid="1"` (string) because both canonicalize to `"1"`. Prefix the key with a type tag (`n:1` vs `s:1`) or document+test the coercion.
- **[LOW]** `ce/crates/ce-mesh/src/lib.rs:837` — swarm event loop blocks on bounded `event_tx.send().await`; a slow node consumer stalls ALL libp2p progress (liveness/DoS surface). Use `try_send` with drop-and-warn (gossip is best-effort, sync repairs gaps) or per-topic channels; at minimum a timeout.
- **[LOW]** `ce/crates/ce-chain/src/lib.rs:2064` — `Chain::load` accepts empty-blocks + `Some(checkpoint)`, then later `tip()`/`height()` panic. Only reachable via a hand-crafted/corrupted local `chain.db`. Strengthen the guard to require ≥1 block, or make `tip()`/`height()` return `Option`/`Result`.
- **[LOW]** `ce/crates/ce-cap/src/lib.rs:235,305` — `cap_bytes`/`encode_chain_bytes` end in `.unwrap_or_default()`, so a serialization failure would sign/verify over empty bytes (collapsing domain separation). Cannot fail today (fixed non-recursive structs) but fragile in the most security-critical crate. Return `Result` or add a `debug_assert` that output is non-empty.
- **[LOW]** `ce/crates/ce-chain/src/lib.rs:836` — `UptimeReward` recipient is not bound to `block.miner` (intentional; `tx.verify` prevents inflation). Add an explicit check or document the divergence at the validation site so future weight/reputation code does not assume equality.
- **[LOW]** `ce-ui/src/components/live-value.ts:46-55` — uses `undefined` as the "nothing scheduled" sentinel, so a stream that legitimately yields `undefined` is dropped. Track a separate `hasPending` boolean.
- **[LOW]** `rdev/Cargo.toml:42` — `ce-node` git dependency (correctly under `[dev-dependencies]`, used only by `tests/two_node_sync.rs`). Clean today; flagged for boundary-drift vigilance. Consider a `ce-testkit`/`local_cluster` helper crate so apps never need even a dev dependency on the full orchestrator.

---

## 4. Fix-First Ordered Action List (build-heavy follow-up wave)

Ordered by security impact, then by how many call-sites a single fix closes.

1. **C1 — Bind Drive capability to drive id** (`ce-drive-serve/src/serve.rs`). Cross-tenant bypass; highest blast radius. Includes fixing `op_share` sub-cap minting.
2. **H1 — Enforce resource caveats on Deploy** (`ce-node/src/lib.rs:1634`). Mirror the existing `allowed_ports` enforcement; node-side, affects every delegated deploy.
3. **H3 — Local-only PoR audit** (`ce-pin/src/host.rs`). Add an SDK `get_blob_local` if missing; restores the economic guarantee.
4. **H2 — Proof-of-possession on the CDN HTTP edge** (`ce-cdn/src/server.rs`). Or route private reads over the authenticated mesh path only.
5. **Theme A — One boundary-aware prefix helper, applied everywhere.** Fix `ce-cap` `is_narrower_or_equal` first (shared verifier), then `ce-storage` H4 (active escalation), then `rdev` and `ce-query`. Closes H4 + four LOWs in one pattern.
6. **Theme D — Free-balance pre-screen** (`ce-node` `emit_heartbeats` + `api.rs /transfer`). Stops the heartbeat free-compute leak; audit all node-side tx pre-screens for total-vs-free.
7. **H5 — Shared drive topic in WasmDriveCore** (`ce-drive-web`). Restores multi-device convergence; add the two-core convergence test.
8. **Theme E — Drive convergence/consistency** (`apply_remote_content` ts-ordering, `mirror.rs` cursor, `op_write` manifest verification). Same subsystem; batch together.
9. **Theme B — Bound the unbounded sets** (`ce-mail` mailbox `seen`, `ce-cdn` host `seen`, `wasm-adapter` `seenOps`/`opLog`, `ce-coord` window). Mechanical; do as one memory-hygiene pass.
10. **Theme C — Checked money parsing** (`ce-rs/amount.rs`, `ce-ts/amount.ts`). `checked_mul`/`checked_add` + reject malformed; restrict the float-number entry point. Add over-range/`"-"` tests.
11. **Theme F — Issuer-aware revocation matching** (`ce-host/panels/grants.ts`, `wasm-adapter` CSPRNG nonce).
12. **Remaining LOWs (Themes G/H)** — crypto/framing hardening, `cap_bytes` Result, `Chain::load` guard, mesh `try_send` backpressure, live-value sentinel, join type-tag. Opportunistic; bundle with whatever crate is already open.
