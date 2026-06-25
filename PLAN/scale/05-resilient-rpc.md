# 05 — Resilient RPC (deadlines, retries, hedging, circuit breakers, idempotency-on-call)

**Status:** implementation-ready. Conforms to `00-architecture.md` (the contract). Ground truth:
`ce/crates/ce-mesh/src/lib.rs` (`RpcRequest::AppRequest`/`AppMessage`, `RpcResponse::{AppReply,Error}`,
`/ce/rpc/1` codec, `APP_TOPIC_PREFIX`), `ce/crates/ce-node/src/api.rs` (`mesh_request`/`mesh_reply`,
the inbox + `reply_token`, `POST /mesh/request`), `ce-rs/src/lib.rs` (`request`/`reply`/`send_message`,
`messages_stream`, `netgraph`/`NetEdge`, `atlas`, `find_service`), `ce-coord/src/lib.rs` (the inbox
pump + topic dispatch + `Dedup`), `ce/docs/primitives.md` (the boundary).

This is the **service-mesh data plane**: every other coordination primitive (queue 03, log 04,
locks 08, saga 10) ultimately calls a peer via this layer, so deadlines, retries, hedging,
circuit-breaking and exactly-once-on-retry must live here once, not be re-implemented per app.

## Conformance block (contract §7)

1. **Plane** — **NODE transport** (the two node-plane behaviors the contract already reserves:
   deadline enforcement on inbound dispatch + budget shrink on forward, and the `(from, ns, idem)`
   dedup table — §1 rows "Deadline enforcement (05)" and "Idempotency dedup (09)") **+ SDK client**
   (`ce-rs`/`ce-coord` own the retry loop, the hedger, and the circuit breaker, which are pure caller
   policy over `Status`). **No new `RpcRequest` variant**: a resilient call is an ordinary
   `RpcRequest::AppRequest` carrying the `Ctx` envelope (contract §2). The only wire change is the
   `Ctx` keystone, which is shared, not 05-specific. Justification against §1: deadline + dedup must
   be *enforced by a peer that does not run the caller's app* (the peer must drop expired work and
   serve a retried call from cache before the handler runs), so they are node-plane; retry/hedge/
   circuit-break are decisions made entirely by the caller from the reply `Status` and local
   `netgraph` — never enforced by a stranger — so they are an SDK library (`primitives.md`: a work
   scheduler's retry/aggregate "the node need not enforce").
2. **Abilities** — `rpc:call` (contract §3), scoped to the callee via `ce-cap::Resource`
   (`Node(id)`, or `Tag("<ns>/<service>")` for a service binding). In practice a call usually
   carries the *app's own* ability (`db:write`, `queue:consume`, …) and `rpc:call` is the generic
   fallback for app-defined methods that reserve no domain string. The breaker/retry path never
   touches `ce-cap`.
3. **Envelope use** — reads/writes `Ctx{ deadline_ms, idem, trace, parent_span, hlc, cap, ns }`.
   Writes `deadline_ms` (computed from the per-call timeout, absolute unix-ms), `idem` (stable across
   retries of one logical call), `trace`/`parent_span` (forwarded for 06). Reads the node-stamped
   `deadline_ms` on inbound to abort expired work and to shrink the forward budget. Adds **no**
   parallel header — the per-call timeout, retry budget, hedge delay and breaker state are caller-side
   config, never on the wire.
4. **Status & partial failure** — consumes the full `Status` enum (contract §4) as the retry oracle:
   auto-retries only `Unavailable`/`DeadlineExceeded`/`ResourceExhausted`/`Aborted`, retries
   `Internal` **only** when `Ctx.idem` is set, treats `AlreadyApplied` as success, never retries
   `InvalidArgument`/`Unauthorized`/`NotFound`/`FailedPrecondition`. Honors `retry_after_ms`. A
   hedged/fan-out call returns `Partial<T>` (contract §4) so the caller sees which replica answered
   and which failed — never collapses a hedge race to a bare `Result`.
5. **Dependencies** — in-edges in the contract §5 graph: the **`Ctx` envelope** (deadlines),
   **09 causal/idem** (the node dedup table that makes a retried call exactly-once), and a backpressure
   trade with **11 flow control** (`ResourceExhausted` + `retry_after_ms` feed the breaker; the breaker
   stops hammering a throttling peer). Enables **07** (it emits the SLIs: per-peer success/latency/
   breaker state), **01** (health = breaker state + success rate), **02** (placement reads those SLIs),
   and is the call substrate under **03/04/08/10/12**.
6. **Namespacing** — calls are keyed by `(Ctx.ns, topic)`; the breaker/retry-budget/dedup buckets are
   keyed `(to_node, ns, ability)` exactly as contract §6 mandates, so one tenant's failing peer cannot
   trip another tenant's breaker. Directed `request`/`reply` dispatch is the existing exact-topic
   `ce-coord` pump (`ce-coord/src/lib.rs`) gaining the `ns` prefix.
7. **Boundary check** — no app policy enters the node: the node enforces only the generic
   deadline-abort and `(from, ns, idem)` dedup; the retry/hedge/breaker brain is `ce-rs`/`ce-coord`
   library code. Stranger code never bypasses the local node — a resilient call is still a `ce-rs`
   request through the local node, which authenticates `AppMessage.from` and verifies `Ctx.cap`.

---

## 1. Purpose & the at-scale problem

At one app and two nodes, `ce-rs::request(to, topic, payload, timeout_ms)` (`ce-rs/src/lib.rs:450`)
is enough: it sends a `RpcRequest::AppRequest` over `/ce/rpc/1`, the peer's app answers via
`/mesh/reply`, and a flat `tokio::time::timeout` guards it (`ce-node/src/api.rs:1921`). At a dozen
interdependent apps and dozens of nodes, that single call is the weakest link in every chain:

- **Timeouts don't compose.** `ce-query` calls `ce-db`, which calls `ce-iam`, which calls a name
  resolver. Each hop sets its own flat 30s timeout, so a user request that should fail fast at 2s can
  hang for 90s of stacked timeouts, and a slow leaf keeps every ancestor's task and inbox slot pinned.
  There is no shared **deadline** that all hops respect.
- **Naive retries amplify.** When a peer is overloaded, every caller's flat retry doubles its load —
  a retry storm turns a brownout into an outage. There is no **retry budget** and no per-peer
  **circuit breaker** to stop calling a peer that is already failing.
- **Tail latency dominates fan-out.** A placement (02) or saga (10) that fans out to 20 peers is as
  slow as its slowest peer; one GC pause on one host stalls the whole batch. There is no **hedging**
  (send a second copy to a different replica once the first is slow) to cut the p99.
- **Retries double-apply.** Re-sending a `queue:consume` or a `seq:next` because the *reply* was lost
  (not the request) silently runs the effect twice. There is no **idempotency-on-call** so a retried
  call has exactly-once effect.

The concurrency problem this solves is **safe retrying under shared load**: many callers, many
in-flight calls, peers that flap between healthy and overloaded, and effects that must not double.
Without a uniform resilience layer every app re-invents (badly) the same five mechanisms — deadlines,
budgeted retry, hedging, circuit-breaking, and exactly-once-on-retry — and they interact catastrophically
(retry × no-deadline × no-breaker = retry storm). CE already has the missing pieces: an absolute
`Ctx.deadline_ms` that survives hops (contract §2), a node dedup table keyed by `(from, ns, idem)`
(contract §1/09), per-peer RTT in `netgraph`/`NetEdge` (`ce-rs/src/lib.rs:213,617`) to seed hedge
delays, and `Status` as a machine-readable retry oracle (contract §4). 05 assembles them into one
client.

---

## 2. Plane: node vs ce-coord, and the justification

| Concern | Plane | Where | Why |
|---|---|---|---|
| Deadline abort (drop work past `Ctx.deadline_ms`) | **node** | `ce-node` inbound dispatch | a peer that does not run the app must refuse expired work before the handler runs (contract §1) |
| Budget shrink on forward (recompute `deadline_ms`, never extend) | **node** | `ce-node` outbound on any onward `ce-rs` call | deadline must ride every hop; only the node sees all hops |
| Idempotency dedup `(from, ns, idem)` → cached reply | **node** | `ce-node` inbound, bounded table | exactly-once must be enforced *before* the app re-runs; a library can't (the app already ran) |
| Retry loop + budget | **coord/SDK** | `ce-rs::ResilientClient` | pure caller decision read from `Status`; no stranger enforces it |
| Request hedging | **coord/SDK** | `ce-rs::ResilientClient` | caller picks a 2nd replica from `find_service`/`atlas`; transparent to peers |
| Circuit breaker (per-peer state machine) | **coord/SDK** | `ce-rs::CircuitBreaker` | caller-local health view seeded by `netgraph` + reply `Status`; never on the wire |

**Justification.** The contract's §1 closed list already grants 05 exactly two node-plane behaviors
(deadline enforcement + dedup), both because they must be enforced by a peer that does not run the
caller's app. Everything else — *deciding* to retry, *deciding* to hedge, *deciding* to stop calling a
peer — is a decision the caller makes from information it already has (`Status`, `retry_after_ms`,
`netgraph` RTT), so per `primitives.md` it is an app/SDK concern with nothing for the node to enforce.
Putting the breaker in the node would be wrong twice: it would bake a policy (thresholds, half-open
probing) into CE, and it would force a peer to reason about *another* peer's health, which it cannot
observe. So 05 is a thin node delta (already in the contract) plus a fat SDK client.

---

## 3. Public API

### 3.1 Rust SDK (`ce-rs`) — `ResilientClient`

A thin wrapper over `CeClient` that owns the retry/hedge/breaker policy and threads `Ctx`. It reuses
`CeClient::request`/`request_ctx` (the contract's §2 `*_ctx` addition), `find_service`, `netgraph`,
and the `Status`/`Ctx` types from `ce-mesh` (re-exported by `ce-rs`). Nothing here is a new transport.

```rust
// ce-rs/src/resilient.rs  (new module; re-exports Ctx/Status from ce-mesh)

/// Caller-side resilience policy for a class of calls. Pure config; never on the wire.
#[derive(Debug, Clone)]
pub struct CallPolicy {
    /// Per-attempt budget; the absolute Ctx.deadline_ms = now + timeout (clamped to any inherited deadline).
    pub timeout: Duration,
    /// Overall retry budget: max total attempts (1 = no retry). Default 3.
    pub max_attempts: u32,
    /// Token-bucket retry budget shared across calls to one peer (contract: prevents retry storms).
    /// Retries are only spent if the bucket has budget; otherwise the first failure is returned.
    pub retry_ratio: f64,            // e.g. 0.1 = at most 10% of calls may be retries
    /// Backoff base; exponential with full jitter, capped at `backoff_max`.
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// Hedge: if the first attempt has not answered after `hedge_after`, fire a parallel copy to the
    /// next candidate; first non-error reply wins, losers are cancelled. None = no hedging.
    /// Default seeds from netgraph p99 to the target. Only safe for idempotent calls (idem set).
    pub hedge_after: Option<Duration>,
    /// Idempotency: Some(key) => exactly-once-on-retry via the node dedup table; None => mint a fresh
    /// key per *logical* call (so its own retries dedup) but at-most-once across distinct calls.
    pub idempotent: bool,
}

impl Default for CallPolicy { /* timeout 5s, 3 attempts, retry_ratio 0.1, hedge None, idempotent false */ }

pub struct ResilientClient {
    ce: CeClient,
    breakers: Mutex<HashMap<BreakerKey, CircuitBreaker>>, // keyed (to_node, ns, ability)
}

impl ResilientClient {
    pub fn new(ce: CeClient) -> Self;

    /// Resilient directed call to one node. Applies deadline (Ctx.deadline_ms), the retry loop
    /// (budget + backoff + jitter), the per-peer circuit breaker, and idempotency-on-retry. Returns
    /// the reply payload, or the terminal `Status` if every permitted attempt failed.
    pub async fn call(
        &self,
        to: &NodeId,
        ns: &str,
        ability: &str,        // the domain:verb this call needs (rpc:call or the app's own)
        topic: &str,
        payload: &[u8],
        cap: &[u8],           // attenuating ce-cap chain bytes (Ctx.cap); empty = self-authorized
        policy: &CallPolicy,
    ) -> Result<Vec<u8>, CallError>;

    /// Resilient call against a *service binding* (01): resolve candidates via find_service/atlas,
    /// pick by breaker state + netgraph RTT (02), and on Unavailable fail over to the next candidate.
    /// With `policy.hedge_after` set, hedges across two candidates. Returns Partial when fan-out > 1.
    pub async fn call_service(
        &self, service: &str, ns: &str, ability: &str, topic: &str,
        payload: &[u8], cap: &[u8], policy: &CallPolicy,
    ) -> Result<Vec<u8>, CallError>;

    /// Fan-out the same call to N targets, hedged; returns who answered and who failed.
    pub async fn fanout(
        &self, targets: &[NodeId], ns: &str, ability: &str, topic: &str,
        payload: &[u8], cap: &[u8], policy: &CallPolicy,
    ) -> Partial<Vec<u8>>;     // contract §4 Partial<T>

    /// Read-only snapshot of breaker state per peer (feeds 07 telemetry / 01 health).
    pub fn breaker_states(&self) -> Vec<(BreakerKey, BreakerState)>;
}

/// Terminal error of a resilient call: the last Status plus how it got there (for tracing/07).
#[derive(Debug, Clone)]
pub struct CallError { pub status: Status, pub detail: String,
                       pub attempts: u32, pub breaker_open: bool, pub trace: [u8;16] }
```

The **circuit breaker** is a standard three-state machine, library-only:

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BreakerState { Closed, Open, HalfOpen }

pub struct CircuitBreaker {
    state: BreakerState,
    failures: u32, successes: u32,          // rolling window
    opened_at: Option<Instant>,
    // config
    failure_threshold: u32,                  // consecutive/ratio failures to open
    cooldown: Duration,                      // Open -> HalfOpen after this
    half_open_probes: u32,                   // probes to close
}
impl CircuitBreaker {
    /// Returns Err(Unavailable) immediately when Open (fail-fast, no call sent).
    pub fn permit(&mut self) -> Result<(), Status>;
    /// Feed each attempt's outcome; transitions the state. ResourceExhausted with retry_after also
    /// trips toward Open (the peer told us to back off).
    pub fn record(&mut self, status: &Status);
}
```

### 3.2 `ce-coord` integration

`ce-coord`'s inbox pump (`ce-coord/src/lib.rs`) already does exact-topic dispatch and `Dedup` of
inbound messages; it gains:

```rust
impl Coord {
    /// The Coord-owned resilient caller; every stream/replica/queue/lock that calls a peer uses it,
    /// so retries/hedging/breakers/deadlines are uniform across all coordination primitives.
    pub fn rpc(&self) -> &ResilientClient;
}
```

The pump's existing `Dedup` (`ce-coord/src/lib.rs:221`) is the **handler-side idempotency** companion
to the node's call-side dedup table: it already drops a re-delivered inbound message so a handler runs
once. 05 makes the node's `Ctx.idem` table authoritative for *reply caching*; the pump's `Dedup`
remains for at-least-once redelivery of coordination log entries.

### 3.3 TS SDK (`ce-ts`)

Mirrors the Rust client (the same `Ctx`/`Status`, JSON-over-local-node form used by browser nodes):

```ts
export interface CallPolicy {
  timeoutMs: number; maxAttempts: number; retryRatio: number;
  backoffBaseMs: number; backoffMaxMs: number; hedgeAfterMs?: number; idempotent: boolean;
}
export class ResilientClient {
  constructor(ce: CeClient);
  call(to: NodeId, ns: string, ability: string, topic: string,
       payload: Uint8Array, cap: Uint8Array, policy?: Partial<CallPolicy>): Promise<Uint8Array>;
  callService(service: string, ns: string, ability: string, topic: string,
              payload: Uint8Array, cap: Uint8Array, policy?: Partial<CallPolicy>): Promise<Uint8Array>;
  fanout(targets: NodeId[], ns: string, ability: string, topic: string,
         payload: Uint8Array, cap: Uint8Array, policy?: Partial<CallPolicy>): Promise<Partial<Uint8Array>>;
  breakerStates(): Array<[BreakerKey, BreakerState]>;
}
```

### 3.4 Node HTTP routes & wire types

**No new routes and no new `RpcRequest` variant.** 05 rides the existing surface:

- `POST /mesh/request` (`ce-node/src/api.rs:1908`) and `POST /mesh/reply` (`:1944`) gain the `Ctx`
  fields per the contract's §2 `*_ctx` additions. `AppRequestRequest` (`:1894`) drops its flat
  `timeout_ms` in favor of `ctx.deadline_ms` (the absolute, hop-surviving deadline); a relative
  `timeout_ms` stays accepted for back-compat and is converted to `deadline_ms = now + timeout_ms`.
- `RpcRequest::AppRequest { from_node, ctx, topic, payload }` and `RpcResponse::AppReply { ctx, payload }`
  carry `Ctx` (contract §2). `RpcResponse::Error(String)` gains a structured sibling so `Status` +
  `retry_after_ms` reach the caller machine-readably; old peers still get the `"{status}: {detail}"`
  string form (contract §4) which the SDK parses back into a `Status` for the breaker.

The node's *new behavior* (both already in the contract's §1 closed list) on `AppRequest`:

```text
on inbound AppRequest(ctx, ...):
  if ctx.deadline_ms != 0 and now_ms() >= ctx.deadline_ms: reply Status::DeadlineExceeded   // do no work
  if ctx.idem != 0:
     key = (from_node, ctx.ns, ctx.idem)
     if let Some(cached) = dedup.get(key): reply AppReply{ ctx: status=AlreadyApplied, cached }  // exactly-once
     // else: run handler, then dedup.put(key, reply) with a bounded TTL/LRU
  verify ctx.cap authorizes `ability` on the resource; else Status::Unauthorized
  dispatch to app handler (which may make onward calls; the node shrinks deadline_ms on each)
```

---

## 4. Protocol & data structures

### 4.1 The single retry/hedge/breaker algorithm (SDK)

`ResilientClient::call` runs this loop (pseudocode; all state caller-local except the node dedup table):

```text
fn call(to, ns, ability, topic, payload, cap, policy):
  key = (to, ns, ability)
  deadline_ms = inherited_deadline().min(now + policy.timeout)   // never extend an inherited deadline
  idem = if policy.idempotent { stable_key(to, ns, topic, payload) } else { fresh_key() }
  attempt = 0
  loop:
    breaker[key].permit()?                       // Open -> return Unavailable immediately (fail-fast)
    ctx = Ctx{ v:1, deadline_ms, idem, cap, ns, trace: inherited_or_mint(), parent_span: cur_span }
    remaining = deadline_ms - now;  if remaining <= 0 { return DeadlineExceeded }
    // hedge: race the primary against a delayed copy to the next candidate (idempotent calls only)
    resp = if policy.hedge_after.is_some() && policy.idempotent {
              hedged_send(to, alt_candidate(to, ns), ctx, topic, payload, policy.hedge_after)
           } else { send_ctx(to, ctx, topic, payload) }   // CeClient::request_ctx over /ce/rpc/1
    breaker[key].record(resp.status)
    match classify(resp.status):                  // contract §4 retryability table
      Ok | AlreadyApplied        => return resp.payload          // exactly-once success
      NonRetryable               => return Err(resp.status)      // InvalidArgument/Unauthorized/NotFound/FailedPrecondition
      Retryable                  => {                            // Unavailable/DeadlineExceeded/ResourceExhausted/Aborted
        attempt += 1
        if attempt >= policy.max_attempts || !retry_budget[key].try_spend() { return Err(resp.status) }
        sleep(backoff(attempt, policy) + resp.retry_after_ms)    // exp backoff + full jitter + server hint
      }
      Internal                   => if policy.idempotent { treat as Retryable } else { return Err(Internal) }
```

Key invariants:

- **I1 — deadline monotonicity.** `deadline_ms` only ever shrinks across hops (caller min with
  inherited; node recomputes on forward, never extends — contract §2). A late call is dropped at the
  node, not after wasted work.
- **I2 — exactly-once on retry.** For `policy.idempotent`, `idem` is a deterministic function of the
  *logical* call, identical across retries; the node's `(from, ns, idem)` table returns the cached
  reply with `AlreadyApplied` on any retry that actually reached the handler, so the effect runs once
  even if the *reply* (not the request) was lost.
- **I3 — no retry storm.** A retry costs from a per-`(to, ns, ability)` token bucket
  (`retry_ratio`); when the bucket is empty the first failure is returned. The breaker fail-fasts when
  Open, so a brownout cannot be amplified.
- **I4 — hedging is idempotent-only.** A hedge sends the call twice; both copies carry the *same*
  `idem`, so the node dedup table guarantees a single effect, and the slower copy is cancelled. Hedging
  a non-idempotent call is rejected at config time.
- **I5 — breaker keyed per-tenant-per-peer.** `BreakerKey = (to_node, ns, ability)` (contract §6), so
  one tenant's failing dependency never trips another tenant's circuit.

### 4.2 State layout

- **Node (per-node, bounded):** the dedup table `(from, ns, idem) -> (Status, reply_bytes, expires_at)`,
  LRU + TTL capped (e.g. 100k entries / 10 min) — the contract's §1 "bounded dedup table". Defined by
  09; 05 only consumes it. No persistence (a crash forgets in-flight idem keys; see §5).
- **SDK (per-process):** `HashMap<BreakerKey, CircuitBreaker>` + `HashMap<BreakerKey, TokenBucket>`
  (retry budget). Seeded with `netgraph` RTT (`ce-rs::netgraph` → `NetEdge.rtt_ms`,
  `ce-rs/src/lib.rs:213,617`) to set the default `hedge_after` ≈ p99 and the per-attempt `timeout`
  floor.

### 4.3 Topics / RPC used

- Directed calls: `RpcRequest::AppRequest` over `/ce/rpc/1` (`ce-mesh/src/lib.rs:160`), via
  `POST /mesh/request` → `CeClient::request_ctx`. No gossip.
- Service resolution for `call_service`/hedge candidates: `find_service` (DHT,
  `ce-rs/src/lib.rs:506`) + `atlas`/`netgraph` for ranking (02 owns the ranking; 05 just calls into it).

---

## 5. Semantics & failure modes

**Delivery / consistency guarantees**

- **At-most-once by default; exactly-once-on-retry when `idem` set.** A non-idempotent call that times
  out has *unknown* outcome (may have applied) — 05 surfaces `DeadlineExceeded` and does **not** retry
  it. An idempotent call retried reaches the handler at most once thanks to the node dedup table (I2);
  callers get `Ok` or `AlreadyApplied`, both meaning "applied exactly once".
- **No ordering guarantee** between distinct calls. 05 is request/response; ordering is the queue's
  (03) or log's (04) job. Causal ordering across hops is carried by `Ctx.hlc` (09), not enforced here.
- **Deadline is best-effort-absolute.** It relies on roughly-synced wall clocks across nodes
  (contract §2 chose absolute over relative precisely so it survives hops); large clock skew widens or
  narrows the effective budget. The HLC (`Ctx.hlc`, 09) bounds skew detection but 05 does not correct
  for it.

**Partition / crash behavior**

- **Callee crash before reply, idempotent:** retry hits a sibling/replica (via `call_service`) or the
  restarted peer; if the original effect committed durably, the dedup table is gone (in-memory) so the
  effect may re-run — therefore **exactly-once-on-retry holds only within the dedup table's TTL and
  only against the *same* peer process**. Across a callee restart, exactly-once degrades to
  at-least-once; durable exactly-once is the saga's (10) / queue's (03) job, layered on top.
- **Callee crash, non-idempotent:** unknown outcome, no retry (I2/at-most-once). Caller must treat
  `DeadlineExceeded`/`Unavailable` as "maybe applied" and reconcile via app logic (10).
- **Network partition:** the breaker opens after `failure_threshold` and fail-fasts (no wasted calls);
  on `cooldown` it half-opens and probes; if the partition healed it closes. This bounds the blast
  radius of a partitioned dependency to one cooldown window of fail-fast errors.
- **Caller crash mid-retry:** no durable retry state, so in-flight retries are simply lost — 05 is a
  best-effort data plane, not a durable workflow engine (that is 10, which persists steps in 03/08).

**What it does NOT guarantee**

- Not exactly-once across callee restarts (the dedup table is in-memory, bounded TTL).
- Not durable: a process crash loses breaker state and pending retries.
- Not ordered, not transactional across multiple calls (compose 08 locks / 10 saga).
- Not a guarantee that a non-idempotent call applied or not on timeout — only that 05 will not *retry*
  it (preventing accidental double-apply).
- Does not synchronize clocks; deadline accuracy depends on host clocks (09 HLC bounds, not fixes).

---

## 6. Security & economy

- **Abilities.** `rpc:call` (contract §3) or the app's own `domain:verb`, scoped via
  `ce-cap::Resource` to the callee `Node(id)` or a `Tag("<ns>/<service>")` binding. The node verifies
  `Ctx.cap` authorizes the ability **before** dispatch (and before any dedup-cache write), so a retried
  unauthorized call is rejected each time, never cached as success. The breaker/retry brain never reads
  `ce-cap` (boundary invariant: no policy in the authz path).
- **DoS bounds.** Three layers cap abuse: (1) the node's existing `MAX_RPC_BYTES = 256 MB`
  (`ce-mesh/src/lib.rs:217`) bounds a single message; (2) the dedup table is LRU+TTL bounded so an
  attacker spraying random `idem` keys cannot exhaust memory (eviction just degrades to re-execution,
  which 11 rate-limits); (3) **retries and hedges are admission-controlled by 11** — a retry is a fresh
  `AppRequest` subject to the callee's per-`(from, ns, ability)` token bucket, so a retry storm is
  throttled at the receiver with `ResourceExhausted` + `retry_after_ms`, which feeds back into the
  caller's breaker (I3). Hedging at most doubles a call's cost and is gated to idempotent calls only.
- **Self-DoS guard.** `max_attempts` × `retry_ratio` budget bounds amplification *from* the caller;
  the breaker bounds wasted calls *to* a sick peer. Both are caller-local and cheap.
- **Optional payment-channel metering.** When a callee charges per call (a paid service), the existing
  receipt mechanism applies unchanged: the call carries a channel receipt the way `RpcRequest::FetchChunk`
  carries `receipt: Option<Vec<u8>>` (`ce-mesh/src/lib.rs:147`) / `RelayReceipt` does
  (`ce-mesh/src/lib.rs:169`); the caller signs a rising `cumulative` (cf. `CeClient::sign_receipt`,
  `ce-rs/src/lib.rs:551`). Crucially, **a deduped retry (`AlreadyApplied`) must not double-charge** —
  the node returns the cached reply without re-running billing, so exactly-once-on-retry extends to the
  payment. Metering policy itself stays app-side (price, channel lifecycle); 05 only guarantees a
  retried paid call is charged once.

---

## 7. Composition

**Depends on** (in-edges, contract §5):

- `00`/**`Ctx` envelope** — deadlines, idem, trace, ns, cap all ride `Ctx`. The keystone; ships first.
- **`09-causal-time-idempotency.md`** — the node `(from, ns, idem)` dedup table (exactly-once-on-retry)
  and the HLC stamp for cross-hop causality. 05 is the primary consumer of 09's dedup table.
- **`11-flow-control-rate-limit.md`** — bidirectional: 11's `ResourceExhausted` + `retry_after_ms`
  drive 05's breaker and backoff; 05's retries/hedges are admitted (and throttled) by 11.

**Enables / is depended on by:**

- **`06-distributed-tracing.md`** — every attempt, retry, hedge and breaker-trip is a span under
  `Ctx.trace`; 05 is where a single user action's latency tree is shaped.
- **`07-telemetry-metrics-slis.md`** — 05 emits the core SLIs (per-peer success rate, latency
  histogram, breaker state, retry/hedge counts), aggregated into `atlas`.
- **`01-service-registry-binding.md`** — service health is largely "is the breaker closed and the
  success rate high"; `call_service` resolves bindings via `find_service`.
- **`02-load-balancing-placement.md`** — picks the candidate (and hedge target) from breaker state +
  `netgraph` RTT; 05 executes the choice and reports back `Unavailable` peers.
- **`03-durable-queue.md`, `04-event-log.md`, `08-locks-leases-election.md`, `10-saga.md`,
  `12-schema-config-registry.md`** — every cross-node call they make goes through `Coord::rpc()`, so
  they inherit deadlines/retry/hedge/breaker for free. 10 (saga) layers *durable* exactly-once on top of
  05's *best-effort* exactly-once-on-retry.

---

## 8. Test plan

**Deterministic unit cores (no mesh):**

- `CircuitBreaker` state machine: Closed→Open on `failure_threshold`, Open fail-fasts (`permit` →
  `Unavailable`), Open→HalfOpen after `cooldown`, HalfOpen→Closed on `half_open_probes` successes,
  HalfOpen→Open on one failure. `ResourceExhausted` trips toward Open.
- `classify(Status)` retry oracle: assert the exact contract §4 partition (only Unavailable/
  DeadlineExceeded/ResourceExhausted/Aborted auto-retry; Internal retries iff idempotent; AlreadyApplied
  = success; the four caller-fault statuses never retry).
- Backoff: exponential with full jitter is bounded by `backoff_max`, and `retry_after_ms` is additive.
- Retry budget token bucket: once empty, the first failure is returned (no extra attempt).
- `stable_key` idem derivation: identical `(to, ns, topic, payload)` → identical key across calls;
  any field differs → different key.
- Deadline math: inherited deadline always wins the `min`; a hop never extends it (I1).

**Property tests:**

- For any sequence of `Status` outcomes, total attempts ≤ `max_attempts` and ≤ retry-budget capacity
  (no storm; I3).
- For any interleaving of two hedged copies with the same `idem`, the modeled dedup table records ≤ 1
  effect and the caller sees exactly one `Ok`/`AlreadyApplied` (I4).
- Monotonic-deadline property: across a random hop chain, `deadline_ms` is non-increasing (I1).

**Integration (single process, mock node):** node dedup table semantics — second request with the same
`(from, ns, idem)` returns the cached reply with `AlreadyApplied` and does not re-invoke the handler;
an expired `deadline_ms` is rejected before dispatch.

**Needs a live multi-node mesh:**

- Deadline propagation across a real 3-hop `A→B→C` chain over `/ce/rpc/1`: a 2s deadline at A aborts C
  even though each hop's local timeout is 30s.
- Hedging cuts p99: inject a 1s GC-pause on one of two replicas; assert the hedged call returns at ~the
  fast replica's latency, and the slow copy is deduped (one effect).
- Breaker under a killed peer: kill B mid-test; assert A's breaker opens, fail-fasts, then closes after
  B restarts and the cooldown elapses.
- Exactly-once-on-retry against a flapping callee: drop the *reply* (not the request) on B; assert the
  idempotent retry returns `AlreadyApplied` and the effect (e.g. a `seq:next` counter) advanced once.

---

## 9. Worked example — tracing & service-binding for a sharded game backend

A multiplayer game built on CE (per `ce-net.com/node` browser nodes + `swarm`) shards its world: a
gateway node routes a player's `move` to the shard owning that region, the shard validates against
`ce-db` (12/04), and on a region handoff calls the neighbor shard. One player action fans across 3–4
app hops. 05 is what keeps it playable at scale:

1. **Service binding + failover.** The gateway calls `rpc.call_service("game/shard-7", ns="game/match42",
   "rpc:call", "tick", payload, cap, policy)`. `call_service` resolves shard-7's current owner via
   `find_service` (01/DHT) and ranks candidates by breaker state + `netgraph` RTT (02). If the owning
   node just crashed, its breaker is Open → `call_service` fails over to the standby replica with no
   app code, returning `Unavailable` only if *both* are down.

2. **Deadline that composes.** The gateway sets `policy.timeout = 50ms` (one game tick). That becomes
   an absolute `Ctx.deadline_ms`; when the shard calls `ce-db` to validate the move, the node shrinks
   the remaining budget on the forward hop (I1). A slow DB can never blow the 50ms frame budget — the
   DB call is aborted at ~the remaining few ms with `DeadlineExceeded`, the shard falls back to its
   cached state, and the frame still ships. No stacked 30s timeouts.

3. **Idempotent move = exactly-once.** The `move` carries `idem = stable_key(...)` over (player, seq).
   If the reply is lost and the gateway retries, the shard's node returns `AlreadyApplied` from the
   dedup table — the player does not move twice, and if the move was a paid action over a channel
   (§6), it is charged once.

4. **Hedge the handoff tail.** On a region crossing the gateway hedges the handoff to the two adjacent
   shards (`policy.hedge_after = Some(8ms)`, idempotent): whichever neighbor is not mid-GC answers
   first, the loser is deduped, and the p99 handoff stays under a frame even when one shard is briefly
   slow.

5. **Breaker stops the cascade.** If shard-7 enters a bad-GC spiral and starts returning `Internal`,
   the gateway's per-`(shard-7, game/match42, rpc:call)` breaker opens after the threshold and
   fail-fasts every subsequent tick to shard-7's standby instead — so one sick shard browns out one
   region for one cooldown window, not the whole match.

6. **Tracing the whole action (06/07).** Because every hop forwarded `Ctx.trace`/`parent_span`, the
   collector (06) renders the single `move`'s span tree — gateway → shard-7 → ce-db, with the retry,
   the aborted DB call, the hedge race, and the breaker trip all visible — and 07 charts shard-7's
   rising p99 and open-breaker rate so placement (02) drains it before players notice.

---

## 10. Effort & minimal first slice

**Effort: L.** The SDK client (retry loop + breaker + hedger) is M; the node delta (deadline-abort +
dedup-table consume) is small *given* the `Ctx` envelope and 09's dedup table already exist, so 05's
net cost is dominated by getting the cross-cutting behavior right and the multi-node tests green.
It is gated on the `Ctx` keystone, 09 (dedup), and a backpressure handshake with 11.

**Minimal first slice (ship behind tests, no hedging, no service failover):**

1. `ResilientClient::call` with: absolute `Ctx.deadline_ms` from `policy.timeout`, the `classify`
   retry oracle over `Status`, exponential backoff + jitter, and a per-`(to, ns, ability)`
   `CircuitBreaker` (Closed/Open/HalfOpen). Hedging and `call_service` stubbed/`unimplemented`.
2. Node side: honor `Ctx.deadline_ms` (reject `DeadlineExceeded` before dispatch) and consume 09's
   `(from, ns, idem)` dedup table to return `AlreadyApplied`. Both are the contract §1 rows already
   reserved — no new RPC.
3. `Coord::rpc()` wired so 03/04/08 get deadlines+retry+breaker immediately.
4. Tests: the full §8 deterministic core (breaker FSM, `classify`, backoff, budget, idem derivation)
   plus one live 3-hop deadline-propagation test and one exactly-once-on-retry test.

This slice already kills the two worst at-scale failures — stacked timeouts and retry storms — and
makes every coordination primitive that follows resilient by default. Hedging, `call_service`
failover, and `fanout`/`Partial` land in slice 2 once 01/02 expose candidate ranking.
