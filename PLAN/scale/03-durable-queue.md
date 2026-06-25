# 03 — Durable work queue (ack / lease / retry / DLQ / ordering / flow-control)

**Status:** implementation-ready. Conforms to `00-architecture.md` (the contract). Ground truth:
`ce-pubsub/src/{lib,message,subscription,protocol,caps}.rs` (the app that already embodies this),
`ce-coord/src/{replicated,stream,lib}.rs` (the coordination engines), `ce-rs/src/lib.rs`
(`request`/`reply`/`messages`/`subscribe`/`publish`), `ce-mesh/src/lib.rs` (`AppRequest`/`AppMessage`/
`AppPubSubMsg`, `APP_TOPIC_PREFIX`), `ce/docs/primitives.md` (the boundary).

## Conformance block (contract §7)

1. **Plane** — **coord** (productize `ce-pubsub`) + the **node delivery** the contract already
   reserves. No new `RpcRequest` variant: the whole queue is built from `ce-rs`'s three generic verbs
   (`request`/`reply`, `subscribe`/`publish`, `messages`) over `ce-coord` `Replicated`/`Stream`,
   exactly as `ce-pubsub` is today. The only node-plane reliance is the `Ctx` envelope (contract §2)
   and the §1 admission/dedup the node already enforces. Justification: lease/ack/retry/DLQ/ordering
   state is *app-owned coordination*, not a byte/key/coin mechanism a non-app peer must enforce on the
   wire (`primitives.md`: "Work scheduler … the node need not enforce it").
2. **Abilities** — `queue:produce`, `queue:consume`, `queue:admin` (contract §3). `consume` covers
   lease/ack/nack/modify-deadline; `admin` covers create/delete/purge/policy. Resource scoping via
   `ce-cap::Resource` carrying the queue name as a `Tag("queue:<name>")` (contract §3), reusing the
   existing topic-prefix caveat path (`ce-pubsub/src/caps.rs::topic_allows`).
3. **Envelope use** — reads/writes `Ctx{ ns, cap, deadline_ms, idem, trace, hlc }`. `cap` replaces the
   ad-hoc `grant: Option<String>` field threaded through `ControlRequest`/`IngestRequest` today
   (`ce-pubsub/src/protocol.rs`). `idem` replaces the bespoke `idempotency_key` string on
   `IngestRequest`. No parallel header is added.
4. **Status & partial failure** — returns `Ok`, `Unauthorized`, `NotFound`, `FailedPrecondition`
   (lease expired/fenced), `ResourceExhausted` (max-outstanding / quota), `Unavailable` (owner down),
   `DeadlineExceeded`, `AlreadyApplied` (idempotent produce retry). Batch lease/ack return
   `Partial<LeasedMessage>` / `Partial<Cursor>` (contract §4) — never a bare bool.
5. **Dependencies** — in-edges in contract §5: `Ctx` envelope, 09 (idempotency dedup + HLC), 11
   (flow-control/admission). Soft consumers of 01 (`find_service` to locate the owner) and 07 (depth
   as an SLI). Enables 10 (saga uses the queue as its durable step ledger). See **§7 Composition**.
6. **Namespacing** — wire topics are `ce-app/<ns>/queue.{ingest,ctl,live,dlq}.<name>` and the
   `ce-coord` replica keys are `(ns, queue.log.<name>)` / `(ns, queue.subs.<name>)`, replacing
   `ce-pubsub`'s flat `ce-pubsub.*` namespace (`ce-pubsub/src/message.rs`) with the contract §6 form.
7. **Boundary check** — no app policy enters the node (the node only delivers `AppMessage`s and
   enforces `Ctx`); every produce/consume call is a `ce-rs` request through the *local* node, which
   authenticates `AppMessage.from` and verifies the `Ctx.cap` chain before the owner app acts.

---

## 1. Purpose & the at-scale problem

Once a dozen interdependent apps share one mesh — `ce-db` emitting change events, `ce-gke`
dispatching pod work, a sharded game backend handing off match results, `ce-query` fanning out
sub-queries — they need to **hand work to each other without being online at the same time** and
**without losing or double-processing it**. Direct `request`/`reply` (`ce-rs::request`) couples
producer and consumer in time: if the consumer is slow, crashed, or scaled-to-zero, the producer
blocks or drops. A bounded inbox ring (the live `Stream` path in `ce-pubsub/src/lib.rs::subscribe`)
is at-most-once: an offline subscriber silently misses messages.

The durable queue is the **decoupling buffer**: a producer appends and moves on; a pool of competing
consumers leases batches, processes at its own rate, acks on success, and a crashed consumer's
un-acked work is automatically redelivered to a sibling. It gives every app the same five guarantees
Google Pub/Sub / SQS give, assembled from CE primitives with **no broker to run**
(`ce-pubsub/src/lib.rs` module doc):

- **At-least-once delivery** with server-tracked ack cursors (not client bookkeeping).
- **Lease / ack / nack / modify-deadline**: a leased message redelivers if not acked before its
  deadline; modify-deadline extends a slow job's lease without re-leasing.
- **Retry policy + dead-letter**: per-message delivery-attempt counting; a poison message exceeding
  `max_delivery_attempts` is routed to a DLQ so it never blocks the subscription
  (`ce-pubsub/src/subscription.rs::plan_lease`).
- **Ordering keys** for per-key FIFO (`Message.ordering_key`).
- **Flow control** (max outstanding): a consumer caps in-flight un-acked work so one greedy puller
  cannot monopolize the backlog and a fast producer cannot OOM a slow consumer.

The concurrency problem this solves is **competing consumers over shared mutable delivery state**:
N pullers, redelivery timers, out-of-order acks, and dead-lettering must all linearize without a
lock the apps have to run. CE already has the linearizer — a single-writer `ce-coord`
`Replicated<S>` log owned by the queue owner (`ce-coord/src/replicated.rs::writer`), which applies
every `SubOp` in version order on one node. The queue is that engine, productized.

---

## 2. Plane: node vs ce-coord, and why

| Concern | Plane | Mechanism |
|---|---|---|
| Durable message log, ack cursors, leases, retry/DLQ state | **coord** | `ce-coord` single-writer `Replicated<TopicLog>` + `Replicated<SubRegistry>` (`ce-pubsub/src/{log,subscription}.rs`) |
| Live fan-out to live tailers | **coord** | `ce-coord` `Stream<Message>` over node gossip (`ce-coord/src/stream.rs`) |
| Produce / lease / ack / nack / modify-deadline transport | **coord** | `ce-rs::request`/`reply` directed to the owner (`ce-pubsub/src/lib.rs::control`) |
| Authn of the caller | **node** (existing) | `AppMessage.from` is Noise-verified by `ce-mesh`; the owner reads it (`ce-rs/src/lib.rs:727`) |
| Authz (`queue:*` chain) | **node verb + coord check** | owner calls `ce-cap::authorize` on `Ctx.cap` (`ce-pubsub/src/caps.rs::verify_link`) |
| Deadline / idempotency-on-produce / rate-limit | **node** (contract §1) | `Ctx.deadline_ms`, `Ctx.idem` dedup table, §11 admission bucket — enforced before the owner sees the call |

**Justification.** Every byte of queue semantics is deterministic state the owner replicates with
`ce-coord`; nothing here must be enforced by a peer that does not run the queue app. By the contract
litmus test (`product semantics → app; a byte/key/coin mechanism every app reinvents → primitive`),
the queue is an app. It earns **zero** new node RPCs. It *consumes* the node-plane `Ctx` envelope and
the §1 admission/dedup that the contract already commits to — those are generic and shared by all 12
primitives. This is a strict productization of the already-shipped `ce-pubsub`, not a new substrate.

---

## 3. Public API

### 3.1 Rust SDK (`ce-coord` plane, crate `ce-queue` extracted from `ce-pubsub`)

The existing `ce-pubsub` types (`PubSub`, `Topic`, `SubscriptionPolicy`, `LeasedMessage`,
`Cursor`, `Message`, `PublishOptions`) are **reused verbatim**; `ce-queue` is `ce-pubsub` with the
queue-oriented names below and the contract conformance (`Ctx`, `Status`, namespacing). New surface
in **bold**.

```rust
// ce-queue (productized ce-pubsub). Reuses ce_pubsub::{Message, Cursor, PublishOptions,
// SubscriptionPolicy, LeasedMessage} and ce_coord::{Coord, Replicated, Stream}.
pub struct Queue { /* wraps the ce-pubsub Topic owner: Replicated<TopicLog> + Replicated<SubRegistry> */ }
pub struct Producer { /* a publish_to handle to a Queue owned by another node */ }
pub struct Consumer { /* a server-tracked subscription cursor on a Queue */ }

impl Queue {
    /// Own a queue under `ns` (contract §6). Becomes the single-writer ce-coord log.
    /// = ce_pubsub::PubSub::create_topic + an `ns`. (ce-pubsub/src/lib.rs:173)
    pub async fn create(coord: Coord, ns: &str, name: &str, policy: QueuePolicy) -> Result<Queue>;

    /// Append as the owner (no round trip). Returns the assigned Cursor.
    /// = ce_pubsub::Topic::publish_with. (ce-pubsub/src/lib.rs:697)
    pub async fn produce(&self, payload: &[u8], opts: &PublishOptions) -> Result<Cursor>;

    pub fn high_cursor(&self) -> Cursor;             // = Topic::high_cursor (lib.rs:654)
    pub fn depth(&self) -> u64;                      // **NEW: high - min(acked) across subs (an SLI for 07)**
    pub async fn purge_to(&self, up_to: Cursor) -> Result<()>; // = Topic::prune_to (lib.rs:728), queue:admin
    pub async fn checkpoint(&self) -> Result<()>;    // = Topic::checkpoint (lib.rs:739)
    pub fn require_cap(&self, yes: bool);            // = Topic::require_publish_cap (lib.rs:665)
}

impl Producer {
    pub async fn connect(coord: Coord, ce: CeClient, ns: &str, owner: &str, queue: &str)
        -> Result<Producer>;
    /// Produce to a remote owner. `Ctx.idem` makes the retry-safe append (AlreadyApplied on dup).
    /// = ce_pubsub::PubSub::publish_to_with, with idem moved into Ctx. (ce-pubsub/src/lib.rs:422)
    pub async fn produce(&self, payload: &[u8], opts: &PublishOptions, ctx: &Ctx)
        -> Result<Cursor, Status>;
}

impl Consumer {
    /// Create/attach a durable, server-tracked subscription. = create_subscription (lib.rs:463).
    pub async fn attach(coord: Coord, ce: CeClient, ns: &str, owner: &str, queue: &str,
        sub: &str, policy: SubscriptionPolicy, ctx: &Ctx) -> Result<Consumer, Status>;

    /// Lease up to `max` redeliverable messages, **bounded by `max_outstanding`** (flow control).
    /// = ce_pubsub::PubSub::lease, with the outstanding cap enforced owner-side. (lib.rs:521)
    pub async fn lease(&self, max: usize, ctx: &Ctx) -> Result<Partial<LeasedMessage>, Status>;

    pub async fn ack(&self, cursor: Cursor, ctx: &Ctx) -> Result<(), Status>;   // lib.rs:544
    pub async fn nack(&self, cursor: Cursor, ctx: &Ctx) -> Result<(), Status>;  // lib.rs:563
    /// **NEW: extend a leased message's deadline by `extend_secs` without re-leasing**
    /// (Google modifyAckDeadline). A new SubOp::ModifyDeadline.
    pub async fn modify_deadline(&self, cursor: Cursor, extend_secs: u64, ctx: &Ctx)
        -> Result<(), Status>;
    /// Batch ack/nack — Partial split so the caller sees which cursors failed (contract §4).
    pub async fn ack_batch(&self, cursors: &[Cursor], ctx: &Ctx) -> Result<Partial<Cursor>, Status>;
}

/// Owner-side queue policy: subscription defaults + the new flow-control ceiling.
pub struct QueuePolicy {
    pub default_sub: SubscriptionPolicy,    // ce_pubsub::SubscriptionPolicy (subscription.rs:48)
    pub max_outstanding_per_sub: u32,       // **NEW flow control; 0 = unbounded (today's behavior)**
}
```

`Ctx`, `Status`, `Partial<T>` are the contract §2/§4 types (live in `ce-coord` or a shared
`ce-scale-types` crate, imported here). `CeClient`, `Coord` are existing (`ce-rs`, `ce-coord`).

### 3.2 TS SDK (`ce-ts`)

```ts
// @ce-net/queue — mirrors the Rust surface over the same /mesh HTTP routes.
class Queue {
  static create(ns: string, name: string, policy?: QueuePolicy): Promise<Queue>;
  produce(payload: Uint8Array, opts?: PublishOptions): Promise<bigint /* Cursor */>;
  depth(): Promise<bigint>;
  purgeTo(upTo: bigint): Promise<void>;
}
class Producer {
  static connect(ns: string, owner: string, queue: string): Promise<Producer>;
  produce(payload: Uint8Array, opts?: PublishOptions, ctx?: Ctx): Promise<bigint>;
}
class Consumer {
  static attach(ns: string, owner: string, queue: string, sub: string,
                policy?: SubscriptionPolicy, ctx?: Ctx): Promise<Consumer>;
  lease(max: number, ctx?: Ctx): Promise<Partial<LeasedMessage>>;
  ack(cursor: bigint, ctx?: Ctx): Promise<void>;
  nack(cursor: bigint, ctx?: Ctx): Promise<void>;
  modifyDeadline(cursor: bigint, extendSecs: number, ctx?: Ctx): Promise<void>;
}
// Cursors are bigint (u64, exceed 2^53 — same string/bigint rule as money, primitives.md).
```

### 3.3 Node HTTP routes & wire types — **none new**

No new node route. Production and control ride the existing generic verbs:
`POST /mesh/request`, `POST /mesh/reply`, `GET /mesh/messages`, `POST /mesh/subscribe`,
`POST /mesh/publish` (`ce-rs/src/lib.rs:436-474`). The only node-plane change is the **`Ctx` field
added to `AppRequest`/`AppMessage`/`AppPubSubMsg`** in `ce-mesh` per contract §2 — shared by all
primitives, not specific to the queue.

### 3.4 App wire types (queue ↔ owner, over `request`/`reply`)

Reuse `ce-pubsub`'s `ControlRequest`/`ControlReply`/`IngestRequest`/`IngestReply`
(`ce-pubsub/src/protocol.rs`) with two contract-driven edits, plus the new variants:

```rust
// EDIT: drop the per-message `grant: Option<String>` and `idempotency_key` fields — they now travel
// in Ctx (Ctx.cap, Ctx.idem) on the AppRequest envelope (contract §2). The owner reads Ctx, not body.
// ADD to ControlRequest (ce-pubsub/src/protocol.rs:111):
ModifyDeadline { name: String, cursor: Cursor, extend_secs: u64 },   // **NEW**
// ADD to SubOp (ce-pubsub/src/subscription.rs:140), applied by the single-writer SubRegistry:
ModifyDeadline { name: String, cursor: Cursor, new_expires_at: u64 }, // **NEW**
```

`LeasedMessage { message, delivery_attempt }` (`ce-pubsub/src/protocol.rs:177`) and `Message`
(`ce-pubsub/src/message.rs:35`, carrying `cursor`, `publisher`, `ordering_key`, `attributes`,
`publisher_authenticated`) are returned unchanged. `ControlReply::Pulled(Vec<LeasedMessage>)` maps to
`Partial<LeasedMessage>` at the SDK boundary (the owner already reports per-cursor outcome).

---

## 4. Protocol & data structures

### 4.1 Topics / RPC used (all generic; contract §6 namespacing)

| Logical | Wire name (`ce-app/<ns>/…`) | Transport | Purpose |
|---|---|---|---|
| ingest | `queue.ingest.<name>` | `request`/`reply` | remote produce → owner appends under single-writer authority |
| control | `queue.ctl.<name>` | `request`/`reply` | attach / lease / ack / nack / modify-deadline / high-cursor |
| live | `queue.live.<name>@<owner>` | `Stream` (gossip) | best-effort live tail (at-most-once) |
| dlq | `queue.dlq.<name>@<owner>` | `Stream` + optional durable log | dead-lettered messages |

These replace `ce-pubsub/src/message.rs::{ingest_topic,control_topic,live_topic,dead_letter_topic}`'s
flat `ce-pubsub.*` form with the `ns`-scoped form. `@<owner>` disambiguates same-named queues across
owners (already done in `ce-pubsub/src/lib.rs:185`).

### 4.2 State layout (owner-held, two single-writer `ce-coord` logs)

- **`Replicated<TopicLog>`** — the append-only message log. Each `produce` proposes
  `LogOp::Append(Message)`; the cursor is the `ce-coord` `Version` (`ce-pubsub/src/message.rs:18`).
  `prune_to`/`checkpoint` give retention + content-addressed snapshot bootstrap.
- **`Replicated<SubRegistry>`** — per-subscription delivery state
  (`ce-pubsub/src/subscription.rs::SubRegistry`). Per sub: `acked` floor, `leases: BTreeMap<Cursor,
  Lease{expires_at, attempts}>`, `attempts`, `dead`, out-of-order `acked_set`, `policy`. Every
  `SubOp` (`Create`/`Delete`/`ApplyLease`/`Ack`/`Nack`/**`ModifyDeadline`**) is applied in version
  order on one node → all delivery arithmetic is linearized without an app-level lock.

### 4.3 Lease algorithm (already implemented; cite + the two additions)

`SubRegistry::plan_lease(name, high, floor, now, max)` (`ce-pubsub/src/subscription.rs:298`) is a
**pure** function the owner runs before proposing `SubOp::ApplyLease`. It scans `(max(acked,floor),
high]` and, per cursor: skips leased-unexpired / dead / out-of-order-acked; dead-letters a cursor
whose next attempt would exceed `max_delivery_attempts`; otherwise leases it stamped with
`now + ack_deadline`. Dead-lettering a contiguous prefix advances the ack floor so poison never
re-scans (`subscription.rs:347`). Two additions, both pure and unit-testable:

1. **Flow control (max outstanding).** Before the scan, cap `max` at
   `max_outstanding_per_sub - s.outstanding()` (`s.outstanding()` = `leases.len()`,
   `subscription.rs:112`). When already at the ceiling, `lease` returns an empty `Partial` with
   `Status::ResourceExhausted` + `retry_after_ms` ≈ the nearest lease expiry, so a greedy consumer
   cannot exceed its in-flight budget and a fast producer's backlog cannot OOM a slow consumer.
2. **modify-deadline.** `SubOp::ModifyDeadline{cursor, new_expires_at}` sets
   `leases[cursor].expires_at = now + extend_secs` (clamped to `MAX_ACK_DEADLINE_SECS`,
   `subscription.rs:33`). A no-op if the cursor is not currently leased (returns `FailedPrecondition`:
   the lease already expired and the message may be redelivered).

### 4.4 Key invariants

- **Single-writer linearizability**: exactly one `ce-coord` writer per `(ns, queue)` mutates
  `SubRegistry`; all lease/ack/redeliver/dead-letter transitions are version-ordered
  (`ce-coord/src/replicated.rs::propose`). Running two owners for one queue races the log — forbidden
  (`ce-pubsub/src/lib.rs` create_topic doc).
- **Ack-floor monotonicity**: `acked` only ever increases; it advances over a contiguous run of
  acked-or-dead cursors (`SubscriptionState::advance_acked`, `subscription.rs:247`). A message with
  `cursor <= acked` is never redelivered.
- **At-least-once, never at-most-once for durable subs**: a leased message is redelivered until acked
  or dead-lettered. Crash between lease and ack ⇒ lease expires ⇒ redeliver
  (`expired_lease_is_redelivered_with_incremented_attempt`, `subscription.rs:463`).
- **Bounded outstanding**: with `max_outstanding_per_sub = K`, at most K cursors are leased-unexpired
  per subscription at any time.
- **Idempotent produce**: same `Ctx.idem` ⇒ one append, original cursor returned
  (`AlreadyApplied`) — moved from `ce-pubsub`'s body `idempotency_key`
  (`ce-pubsub/src/lib.rs::handle_ingest`) onto the node dedup table (contract §2/09).

---

## 5. Semantics & failure modes

**Delivery.** At-least-once for durable subscriptions (`lease`/`ack`); at-most-once for the live tail
(`Stream`). Exactly-once *effect* only when the consumer's handler is idempotent (use the message
`cursor` or a `Ctx.idem` on downstream calls) — the queue guarantees delivery, not handler
exactly-once (`ce-pubsub/src/lib.rs` module doc is explicit).

**Ordering.** Global cursor order is total per queue (single-writer). `ordering_key` preserves
relative publish order for keyed messages (`Message.ordering_key`, `message.rs:49`). With **competing
consumers** the queue does **not** guarantee a single key's messages go to one consumer in order —
that needs key-affinity (deferred; one consumer per key range, layered like Pub/Sub ordered
delivery). For strict per-key FIFO today, use one consumer.

**Consistency / partition.** A puller opens a `ce-coord` snapshot read-replica and converges
**honestly** to the owner's high-water cursor before reporting; if it cannot converge within the
deadline it reports `converged=false` + `missing>0` (`ce-pubsub/src/lib.rs::pull`, `Replay`) — the
at-least-once contract is never silently violated. Control ops (lease/ack) are directed
`request`/`reply` to the owner; if the owner is unreachable they return `Status::Unavailable` and the
consumer retries (or 02 placement / 01 health routes it once HA ownership lands).

**Crash behavior.** Owner crash: produces/leases fail `Unavailable`; on restart the owner reloads
both `Replicated` logs from snapshot+tail (`ce-coord`), so acked/lease/dead state survives. Consumer
crash: its un-acked leases expire and redeliver to a sibling — no operator action. Producer crash
mid-produce: the retry carries the same `Ctx.idem` ⇒ no double-append.

**What it does NOT guarantee.** (1) Handler exactly-once. (2) Cross-consumer per-key ordering. (3)
Availability under owner loss (single-writer owner today; HA multi-writer ownership is deferred,
`ce-pubsub` README). (4) Global ordering *across* queues — none. (5) Delivery of pruned messages: a
consumer lagging past the retention `floor` permanently misses them and is told so via the ack-floor
bridge (`floor_bridges_retention_so_subscription_does_not_stall`, `subscription.rs:564`).

---

## 6. Security & economy

**Abilities (contract §3).** `queue:produce` to append, `queue:consume` to lease/ack/nack/modify,
`queue:admin` to create/delete/purge/policy. Each call carries the chain in `Ctx.cap`; the owner runs
`ce-cap::authorize` rooted at its own key + any `accept_root`ed partner roots, then the topic-prefix
caveat check (`ce-pubsub/src/caps.rs::verify_link`). Revocation is fail-closed: if the on-chain
revoked set is unreachable the owner rejects rather than honoring a possibly-revoked cap
(`ce-pubsub/src/lib.rs::authorize`/`fetch_revoked`). Abilities stay opaque to `ce-cap` (contract §0.3,
`primitives.md`); the queue only adds them to its `ce-iam` action universe.

**Abuse / DoS bounds (all already enforced in `ce-pubsub`, retained):**
- Payload ≤ `MAX_PAYLOAD_BYTES` (10 MiB), rejected *before* the durable append
  (`message.rs:24`/`validate_payload`).
- Control body ≤ `MAX_CONTROL_BODY_BYTES` (64 KiB), ingest hex bounded before allocation
  (`protocol.rs:20`/`MAX_INGEST_HEX_BYTES`).
- Subscriptions per queue ≤ `MAX_SUBSCRIPTIONS` (10 000) (`subscription.rs:30`).
- Lease batch ≤ `MAX_LEASE_BATCH` (1 000) (`subscription.rs:43`).
- **NEW** outstanding per sub ≤ `max_outstanding_per_sub` (§4.3) — the flow-control DoS bound.
- Ingest idempotency dedup is bounded + time-evicting (`ce-pubsub/src/dedup.rs`), now subsumed by the
  node §2/09 dedup table keyed `(from, ns, idem)`.
- Per-`(from, ns, queue:*)` rate-limit token bucket is the node §11 admission point (contract §1) —
  the queue inherits it for free; no app rate-limiter.

**Optional payment-channel metering.** Produce/lease are credit-meterable over the existing
`channels` primitive (`ce-rs` `channels/*`): the owner can require an off-chain receipt per N
produced bytes or per lease batch before serving, tying queue throughput to credits exactly as
`ce-pubsub` could. Default off (open queue), matching `require_publish_cap(false)`.

---

## 7. Composition

**Depends on** (in-edges, contract §5):
- **`Ctx` envelope** (the keystone) — carries `ns`, `cap`, `idem`, `deadline`, `trace`.
- **`09-causal-time-idempotency.md`** — the node dedup table backs idempotent produce; HLC orders
  produces from different nodes.
- **`11-flow-control-rate-limit.md`** — the node admission bucket is the queue's per-tenant throttle;
  `max_outstanding` is the queue's own application-level backpressure that *feeds back* to 11.
- **`01-service-registry.md`** (soft) — `find_service` resolves the queue owner's NodeId so a producer
  need not hardcode it.
- **`07-telemetry-metrics.md`** (soft) — `Queue::depth()` and per-sub outstanding/dead counts export
  as SLIs into the extended `atlas`.

**Enables:**
- **`10-saga-workflow.md`** — a saga's durable step ledger and compensation retries are queue
  subscriptions; the queue's at-least-once + DLQ is exactly the saga's "execute step, retry, or
  compensate on poison" substrate.
- **`04-event-log.md`** is the sibling: same `ce-coord` `Replicated`/blob foundation, but log =
  replayable broadcast with consumer-group offsets; queue = competing-consumer work distribution with
  leases. They share `TopicLog` and the snapshot machinery.

---

## 8. Test plan

**Deterministic unit cores (no node/mesh; already the strength of `ce-pubsub`):**
- `SubRegistry::plan_lease` retry/expiry/dead-letter/out-of-order-ack/retention-bridge — extend the
  existing suite (`ce-pubsub/src/subscription.rs` tests) with **flow-control cap** cases (lease
  returns nothing + `ResourceExhausted` at the ceiling; frees as acks land) and **modify-deadline**
  (extends `expires_at`; no-op on an expired lease).
- `ModifyDeadline` `SubOp` apply + snapshot round-trip (mirror `snapshot_roundtrip`,
  `subscription.rs:618`).
- Wire round-trips for the new `ControlRequest::ModifyDeadline` (mirror
  `control_request_roundtrips_all_variants`, `protocol.rs:284`).
- `Ctx`/`Status`/`Partial` mapping: `ControlReply::Pulled` → `Partial<LeasedMessage>`; rejection
  strings → `Status` variants.

**Property tests (deterministic, `proptest`):**
- *No loss, no premature redelivery*: over a random interleaving of produce/lease/ack/nack/expire/
  modify-deadline, every produced cursor is eventually acked-or-dead exactly once, and no
  acked-or-leased-unexpired cursor is re-leased.
- *Bounded outstanding*: `leases.len() <= max_outstanding_per_sub` holds after every op.
- *Ack-floor monotone & contiguous*: `acked` never decreases; never advances past an unhandled
  cursor.

**Integration (single in-process node, ephemeral `--data-dir`, like `ce-pubsub` tests):**
- Owner + producer + two competing consumers: produce 1 000, lease/ack across both, kill one
  mid-lease, assert its leases redeliver to the other and total acks == 1 000, no duplicates beyond
  redelivery.
- Idempotent produce: retry with the same `Ctx.idem` after a dropped reply → one append,
  `AlreadyApplied`.

**Needs a live multi-node mesh:**
- Producer and consumers on *different* nodes from the owner, over real `ce-rs::request` across libp2p
  (relay-assisted), validating directed routing + `Ctx.cap` authz end-to-end.
- DLQ delivery to a consumer on a third node.
- Owner restart from `ce-coord` snapshot mid-flight; assert lease/ack state survives.

---

## 9. Worked example — sharded game backend handoff

A real-time game (one of the `ce-net.com` game backends, task #5) is sharded: a **match-maker** app
forms matches and must hand each match to a **sim-shard** worker that owns one region of the world.
Workers autoscale and crash. Naively the match-maker would `ce-rs::request` a shard directly — but a
crashed or scaled-down shard would drop the match.

With the durable queue:

1. Each sim-shard owns a queue `Queue::create(coord, "game/lobby-eu", "matches", policy)` with
   `default_sub.ack_deadline_secs = 10`, `max_delivery_attempts = 3`,
   `max_outstanding_per_sub = 64` (a shard processes ≤ 64 matches concurrently — flow control).
2. The match-maker is a `Producer`: `produce(match_bytes, opts.ordering_key("region:eu-3"), ctx)`
   with `ctx.idem = match_id` (retry-safe: a re-formed match never double-spawns) and
   `ctx.cap = <queue:produce on game/lobby-eu/matches>`.
3. Sim-shard workers `Consumer::attach(... "worker")` and loop `lease(64, ctx)` → spawn the match →
   `ack(cursor)`. A worker that crashes mid-match has its un-acked match **redelivered** to a sibling
   after 10 s; a long match calls `modify_deadline(cursor, 30, ctx)` to keep its lease while loading.
4. A match that crashes the sim three times (poison: corrupt state) is **dead-lettered** to
   `game/lobby-eu/queue.dlq.matches`, where an ops consumer inspects it — it never wedges the shard.
5. `Queue::depth()` per region feeds the placement primitive (02) to spin up another shard when the
   backlog grows — the autoscaling signal is the queue depth SLI.

The same shape powers an **inter-app request handoff**: `ce-query` produces sub-queries onto a
worker pool's queue; the `Ctx.trace` rides every hop (contract §2), so 06 traces the fan-out/fan-in
across apps without the queue threading anything.

---

## 10. Effort & minimal first slice

**Effort: M.** The hard part — the lease/ack/nack/DLQ/ordering/idempotency state machine — already
exists and is tested in `ce-pubsub`. The work is conformance + two features, not a rewrite:

- Rename/extract `ce-pubsub` → `ce-queue` keeping the engine (S).
- Thread `Ctx` (move `grant`→`Ctx.cap`, `idempotency_key`→`Ctx.idem`) and adopt `Status`/`Partial`
  at the SDK boundary (M — touches the protocol structs and every SDK method).
- Add `max_outstanding_per_sub` flow control and `ModifyDeadline` (`SubOp` + `ControlRequest` +
  `plan_lease` cap) (S — pure functions, unit-tested).
- `ns`-scope the topic/replica names per contract §6 (S).

**Minimal first slice (ships behind tests, no node change beyond the shared `Ctx`):**
> The existing `ce-pubsub` `create_topic`/`publish_to`/`lease`/`ack`/`nack` path, plus
> `max_outstanding_per_sub` enforced in `plan_lease` and a `ModifyDeadline` `SubOp`, exposed as
> `Queue`/`Producer`/`Consumer`. This delivers at-least-once + lease/ack/nack/retry/DLQ/ordering +
> flow control end-to-end on a single node, then a two-node mesh test. `Ctx`/`Status` adoption follows
> the envelope landing (contract build order step 0); until then the existing `grant`/`idempotency_key`
> fields bridge it.
