# 09 — Causal time (HLC), idempotency-key dedup & distributed counters/sequences

**Status:** implementation-ready. Conforms to `00-architecture.md` (the contract). Ground truth:
`ce/crates/ce-mesh/src/lib.rs` (`RpcRequest::{AppRequest,AppMessage}`, `AppPubSubMsg`,
`app_pubsub_bytes`/`ce-app-pubsub-v1`, `APP_TOPIC_PREFIX`, `/ce/rpc/1` codec), the contract `Ctx`
keystone (`00-architecture.md` §2, the `hlc: (u64,u32)` and `idem: [u8;16]` fields), `ce-rs/src/lib.rs`
(`request`/`reply`/`publish`/`messages_stream`, `AppMessage`), `ce-coord/src/lib.rs` (the inbox pump
+ `Dedup` window + `fingerprint`), `ce-coord/src/collections.rs` (`RCounter`/`CounterState`/`CounterOp`),
`ce-coord/src/merged.rs` (`Merged`/`MergeMachine`/`MergeKey` — the leaderless CRDT union),
`ce-coord/src/replicated.rs` (`Version`, the single-writer log), `ce-pubsub/src/dedup.rs`
(`IdempotencyCache`/`Seen`/`TokenSet` — the matured app-tier dedup this generalizes), and
`ce/docs/primitives.md` (the boundary). This primitive is split across both planes exactly as the
contract names it (§0.1 row 09): the **node** owns the HLC stamp and the exactly-once dedup table;
**`ce-coord`** owns distributed counters/sequences as CRDT or chain-anchored state.

## Conformance block (contract §7)

1. **Plane** — **split, as the contract reserves** (§0.1 row 09; §1 rows "The envelope" and
   "Idempotency dedup (09)"):
   - **NODE** owns two generic, must-ride-every-hop mechanisms: (a) the **HLC stamp** — the node
     merges the inbound `Ctx.hlc`, advances its local clock, and stamps `Ctx.hlc` on every outbound
     hop, so causal order is carried *for* the app, not threaded by it; and (b) the **idempotency
     dedup table** keyed by `(from, ns, idem)`, enforced *before the app handler runs* so a retried
     `AppRequest` is served from cache, never re-executed. Both must be enforced by a peer that does
     not run the caller's app (a stranger must not re-run a paid effect, and HLC must advance even on
     a forwarding hop), which is the litmus that puts them in the node (`primitives.md`: "anything
     that must be enforced lives in CE — but it stays generic").
   - **coord** owns **distributed counters/sequences** (`seq:next`): a CRDT counter (the existing
     `RCounter`, made allocator-safe) or a chain-anchored gapless sequence. These are typed client
     state over the three generic verbs; the node need not enforce them.
   **No new `RpcRequest` variant.** The HLC and `idem` ride the shared `Ctx` keystone
   (`00-architecture.md` §2); sequences are ordinary `Replicated`/`Merged` traffic over
   `publish`/`subscribe`/`request`. The only wire change is the `Ctx` keystone itself, shared by 05/06/11.
2. **Abilities** — reserves `seq:next` (contract §3): allocate one value from a named distributed
   counter/sequence. Resource-scoped via `ce-cap::Resource` carrying the sequence name as
   `Tag("seq:<ns>/<name>")`, so a grant can say "may only draw from `seq:ce-db/acme/order-id`" by
   attenuating resource, not ability. The HLC stamp and the dedup table are **not** cap-gated — they
   are transport mechanism on every authenticated call (the call already carries its own ability in
   `Ctx.cap`); dedup keys on the *node-verified* `from`, so there is nothing extra to authorize.
3. **Envelope use** — reads/writes `Ctx{ hlc, idem, ns, deadline_ms, trace, cap }`. Writes `hlc`
   (the sender's clock reading at send), reads inbound `hlc` to merge. Reads `idem` to key the dedup
   table; reads `ns` so dedup/HLC/seq buckets are per-tenant (contract §6). Reads `deadline_ms` only
   to bound a blocking `seq:next`. Adds **no parallel header** — HLC and idempotency key are exactly
   the two `Ctx` fields the contract already defined for this primitive (§2).
4. **Status & partial failure** — the dedup table is the *sole producer* of `AlreadyApplied`
   (contract §4): on an `idem` hit the node returns the cached prior result tagged `AlreadyApplied`,
   which 05 treats as success (never a re-run). `seq:next` returns `Ok`, `Unauthorized`,
   `ResourceExhausted` (a bounded/leased block exhausted — §6), `Unavailable` (chain-anchored mode,
   no peer to confirm), `DeadlineExceeded` (blocking allocation timed out). A batch allocation
   (`seq:next_batch`) returns `Partial<Range>` so a caller that asked for N ids across shards sees
   which sub-ranges it got and which shard was `Unavailable` — never collapses to one bad bool.
5. **Dependencies** — in-edges (contract §5): the **`Ctx` envelope** (the keystone, ships first). 09
   is one of the node-plane trio (06/09/11) that only needs `Ctx`; it ships immediately after the
   envelope. It **enables 05** (the `(from,ns,idem)` table is what makes a retried resilient call
   exactly-once — `05-resilient-rpc.md` §1 names this as its in-edge), **08** (an idempotent lock
   acquire is a dedup-table hit returning the same fencing token — `08-locks-leases-election.md` §3),
   **03** (queue exactly-once delivery dedups producer `idem` keys; generalizes `ce-pubsub`'s
   `IdempotencyCache`), **04** (event-log append dedup + HLC as the cross-writer merge key), and
   **10** (saga step idempotency + causal step ordering). The CRDT counter side reuses
   `ce-coord/src/collections.rs::RCounter` and `merged.rs::Merged`.
6. **Namespacing** — all three buckets key under contract §6: the dedup table key is
   `(from, ns, idem)`; the HLC is per-node but its readings are scoped/compared within an `ns`;
   a sequence's replicated state key is `(ns, seq.<name>)` and its chain anchor (when used) is a
   `NameClaim`-style on-chain record namespaced by `ns`. Gossip for a CRDT sequence rides
   `ce-app/<ns>/seq.<name>` (the existing `APP_TOPIC_PREFIX`). Default empty `ns` ⇒ the caller's
   NodeId hex — a private per-key counter/dedup space for free.
7. **Boundary check** — no app policy enters the node: the node stamps a generic monotone clock and
   dedups by an opaque `(from, ns, idem)` triple, learning nothing about what the effect *is*;
   "sequence", "order-id", "exactly-once business effect" are all `ce-coord`/app concepts. Stranger
   code never bypasses the local node — `seq:next` is a `ce-rs` call through the *local* node, which
   authenticates `AppMessage.from` and verifies `Ctx.cap` before the counter's writer app acts.

---

## 1. Purpose & the at-scale problem

At one app on two nodes, ordering and exactly-once are non-problems: a single writer's `Version`
(`ce-coord/src/replicated.rs:35`) totally orders its own log, and a lost reply just re-runs a
naturally-idempotent insert. At a dozen interdependent apps (`ce-db`, `ce-pubsub`, `ce-query`,
`ce-iam`, `ce-gke`, games) sharing one mesh and dozens of nodes, three concurrency hazards appear
that no single app can solve alone:

- **No causal order across apps.** `ce-query` writes to `ce-db`, which emits an event the saga (10)
  consumes, which calls `ce-iam`. Each app has its own per-writer `Version`, but those versions are
  **incomparable across writers and across apps** — there is no global "this happened-before that".
  Wall clocks disagree by seconds across NAT'd machines, so a naive timestamp reorders effects. The
  existing leaderless `Merged` already *requires* a strict total-order `MergeKey` and tells the app
  to "pair a Lamport clock with the writer id" (`ce-coord/src/merged.rs:43-47`) — but every app
  hand-rolls that clock, and the clocks don't compose across apps. A **hybrid logical clock (HLC)**
  on `Ctx.hlc` gives one monotone, wall-clock-anchored, causally-consistent ordering that rides
  every hop automatically.
- **Retries double-apply real effects.** A retried call because the *reply* was lost (not the
  request) silently runs the effect twice: a second `queue:consume`, a second `Transfer`, a second
  `seq:next`. `ce-pubsub` already had to build `IdempotencyCache`/`TokenSet` (`ce-pubsub/src/dedup.rs`)
  to stop duplicate publishes after exactly this bug — but it is app-local, so every app reinvents
  it, and a retried *cross-app* call has no shared dedup point. The contract puts a generic
  `(from, ns, idem)` dedup table **in the node**, enforced before the handler, so exactly-once on
  retry is a property of the transport, not of each app's care.
- **Counters need a central allocator.** "Give me the next order id / sequence number / shard
  cursor" is the one primitive that naively wants a single global allocator — a bottleneck and a
  single point of failure on a leaderless mesh. CE has the substrate to avoid it two ways: a
  **CRDT counter** (`RCounter`, summing per-writer deltas — `ce-coord/src/collections.rs:344-389`)
  for monotone-but-gappy counts, and a **chain-anchored** gapless sequence for the rare case that
  needs density and global agreement (the PoW chain is the only global total order CE has).

This doc specifies all three so the durable primitives above (03/04/05/08/10) compose them once.

---

## 2. Plane: node (HLC + dedup) vs ce-coord (counters)

| Sub-primitive | Plane | Justification (contract §0/§1) |
|---|---|---|
| **HLC stamp** (`Ctx.hlc`) | **NODE** (`ce-node` inbound/outbound) | Must advance on *every* hop, including a forward through a node that does not run the app. A library can't see forwarded hops; the node already touches `Ctx`. Generic monotone clock — no app vocabulary. |
| **Idempotency dedup table** (`(from, ns, idem)`) | **NODE** (`ce-node` inbound dispatch) | Must be enforced *before the app handler runs*, by the receiving peer, so a stranger can't re-run a paid effect. Exactly the §1 "Idempotency dedup (09)" row. Keys on the node-verified `from`. |
| **Distributed counter / sequence** (`seq:next`) | **coord** (`ce-coord`, over `RCounter`/`Merged`/chain) | Allocation is a typed client decision; the node need not enforce it. CRDT union and chain anchoring are pure clients of `publish`/`subscribe`/`request` + the ledger. `primitives.md` litmus: a sequence is a byte/coin mechanism apps reinvent → but one the node need not enforce → SDK. |

The split is the contract's, not invented here: the HLC and `idem` fields **already exist** on the
`Ctx` keystone (`00-architecture.md` §2), and the §1 closed list already reserves "Idempotency
dedup (09)" as a node-plane change. This doc only specifies the *behavior* behind those fields and
adds the `ce-coord` counter API. **No new `RpcRequest` variant and no new HTTP route on the hot
path** — see §3 for the two small read-only node endpoints (`/clock`, `/dedup/stat`) that are
operability surface, not enforcement.

---

## 3. Public API

### 3.1 Node plane — the `Ctx` fields (already defined; this specifies behavior)

The HLC and idempotency key are the contract's `Ctx` fields (`00-architecture.md` §2), carried on
the existing wire types (`RpcRequest::AppRequest`/`AppMessage`, `AppPubSubMsg`):

```rust
// ce-mesh Ctx (contract §2) — the two fields this primitive owns:
pub hlc: (u64, u32),   // (wall_ms, counter) — sender's HLC reading at send time
pub idem: [u8; 16],    // caller-chosen, stable across retries of the SAME logical call; 0 = at-most-once
```

The node's HLC is an internal `ce-node` type (not on the wire beyond the `(u64,u32)` reading):

```rust
// ce-node: the local hybrid logical clock. One per node, behind a Mutex on the inbound path.
// Invariant: each call to now() returns a value strictly greater than every prior now() AND
// strictly greater than every observed remote reading (after merge). 48-bit wall ms is ample to 4892 AD.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Hlc { pub wall_ms: u64, pub counter: u32 }   // Ord = (wall_ms, counter) lexicographic

impl Hlc {
    /// Local event: advance past physical time, else bump the counter (Lamport tiebreak).
    pub fn now(&mut self, phys_ms: u64) -> Hlc;
    /// Receive event: merge a remote reading, then advance — guarantees recv > both local and remote.
    pub fn merge(&mut self, remote: (u64, u32), phys_ms: u64) -> Hlc;
}
```

Node responsibilities (all generic, `ce-node` inbound/outbound dispatch — extends the contract §2
node behavior list, no new code path for the app):

1. **Inbound:** `hlc.merge(ctx.hlc, now_ms())` → the merged reading is the call's logical timestamp;
   surface it to the app as `AppMessage.hlc` (new field, §3.3).
2. **Outbound** (any `ce-rs` send the node forwards): set `ctx.hlc = hlc.now(now_ms())`.
3. **Dedup, inbound, before dispatch:** if `idem != 0`, look up `(from, ns, idem)` in the dedup
   table (§4.2). On hit → return the cached `RpcResponse` tagged `AlreadyApplied` (contract §4),
   **do not dispatch to the app**. On miss → dispatch, then cache the app's reply keyed by the triple.

Two **read-only operability** HTTP routes (not enforcement; safe to expose like `/atlas`):

| Method | Path | Returns | Use |
|---|---|---|---|
| GET | `/clock` | `{ "wall_ms": u64, "counter": u32 }` | the node's current HLC reading (for debugging causal order; analogous to `/beacon`) |
| GET | `/dedup/stat` | `{ "entries": u64, "capacity": u64, "hits": u64, "ns": [{ns, entries}] }` | dedup table occupancy + hit rate per `ns` (operability for 07) |

### 3.2 Rust SDK (`ce-rs`) — idempotency helpers on the client

`ce-rs` gains the `*_ctx` request variants the contract mandates (`00-architecture.md` §2 "SDK
surface"); this primitive adds idempotency-key ergonomics over them:

```rust
impl CeClient {
    /// A fresh random idempotency key. Hold it across retries of ONE logical call.
    pub fn new_idem() -> [u8; 16];

    /// Deterministic idempotency key from a caller-stable seed (e.g. an order id), so a retry from a
    /// fresh process — having lost the random key — still dedups. Domain-separated; sha256(seed)[..16].
    pub fn idem_from(seed: &[u8]) -> [u8; 16];

    /// Request with an explicit Ctx (carries `idem`, `hlc`, `deadline_ms`, `ns`, `cap`). The node
    /// dedups on `(from, ns, idem)`; an `AlreadyApplied` reply returns the cached prior effect.
    pub async fn request_ctx(&self, to: &str, topic: &str, payload: &[u8], ctx: Ctx)
        -> Result<(Vec<u8>, Status)>;

    /// Convenience: request once, exactly-once on retry, with a stable idempotency key.
    pub async fn request_idem(&self, to: &str, topic: &str, payload: &[u8],
                              idem: [u8; 16], timeout_ms: u64) -> Result<Vec<u8>>;

    /// The node's current HLC reading (`GET /clock`) — for apps that order their own state by it.
    pub async fn clock(&self) -> Result<(u64, u32)>;
}
```

`AppMessage` (the inbox type, `ce-rs/src/lib.rs:730`) gains the merged HLC the node stamped:

```rust
pub struct AppMessage {
    pub from: String, pub topic: String, pub payload_hex: String,
    pub received_at: u64, pub reply_token: Option<u64>,
    /// The node-merged HLC reading for this message: (wall_ms, counter). Use as a cross-app
    /// causal/total-order key (it dominates the sender's clock and this node's clock). Zero from
    /// pre-09 peers. (additive; `#[serde(default)]`)
    pub hlc: (u64, u32),
}
```

### 3.3 `ce-coord` — distributed counters & sequences (`seq:next`)

Two engines, one trait-shaped API, picked by guarantee:

```rust
// ----- (a) CRDT counter: monotone, gap-tolerant, leaderless. Generalizes RCounter. -----
// Each node writes only its own per-writer counter; the value is the sum across all writers.
// `allocate(n)` reserves a half-open range [start, start+n) UNIQUE TO THIS WRITER by partitioning
// the id space per writer (writer_index * STRIDE + local), so two nodes NEVER collide and no central
// allocator is needed. Values are unique + monotone-per-writer, but NOT dense globally (gaps between
// writers) — the right tool for shard cursors, idempotency suffixes, "good enough" ordering.
pub struct Sequence {                 // ce-coord
    /* over merged::Merged<SeqMachine> */
}
impl Coord {
    /// Open a leaderless CRDT sequence `name`; `peers` are the other writers' NodeIds (as for `Merged`).
    pub async fn sequence(&self, name: &str, peers: &[&str]) -> Result<Sequence>;
}
impl Sequence {
    /// Reserve the next value owned by THIS writer (collision-free across writers). Local + instant.
    pub async fn next(&self) -> Result<u64>;
    /// Reserve a contiguous range of `n` values owned by this writer. Local + instant.
    pub async fn next_batch(&self, n: u64) -> Result<std::ops::Range<u64>>;
    /// Current global high-water sum across all known writers (monotone, may lag a peer's latest).
    pub fn high_water(&self) -> u64;
}

// ----- (b) Chain-anchored gapless sequence: dense, globally-agreed, slower. -----
// For the rare case needing dense consecutive ids with global agreement (e.g. an invoice number).
// Allocation appends an on-chain SeqAlloc record (a NameClaim-style first-writer-wins tx, §6); the
// PoW chain's single total order makes ids dense and globally unique. One alloc per block-confirmed
// step — throughput is chain-bound, so use only when density is mandatory.
pub struct ChainSequence { /* over ce-rs ledger + a Replicated index */ }
impl Coord {
    pub async fn chain_sequence(&self, name: &str) -> Result<ChainSequence>;
}
impl ChainSequence {
    /// Allocate the next DENSE id (no gaps, globally unique). Blocks until chain-confirmed or
    /// `Ctx.deadline_ms`. Returns `Aborted` on a first-writer race (retry the txn).
    pub async fn next(&self) -> Result<u64>;
}
```

`SeqMachine` is a three-line `MergeMachine`/`StateMachine` exactly like the existing collections
(`ce-coord/src/collections.rs:344` `CounterState`), so it inherits `Merged`'s gap repair, catch-up,
and snapshotting for free.

### 3.4 TS SDK (`ce-ts`) — mirror

```ts
// idempotency + HLC ride the Ctx the @ce/client request already carries (contract §2).
function newIdem(): Uint8Array;                       // 16 random bytes
function idemFrom(seed: Uint8Array): Uint8Array;      // sha256(seed).slice(0,16)
interface RequestOpts { idem?: Uint8Array; deadlineMs?: number; ns?: string; cap?: Uint8Array }
class CeClient {
  requestCtx(to: string, topic: string, payload: Uint8Array, opts: RequestOpts):
    Promise<{ payload: Uint8Array; status: Status }>;   // status === "AlreadyApplied" ⇒ cached effect
  clock(): Promise<{ wallMs: number; counter: number }>;          // GET /clock
}
// ce-coord-ts mirror:
class Sequence { next(): Promise<bigint>; nextBatch(n: number): Promise<{start: bigint; end: bigint}>;
                 highWater(): bigint; }
class ChainSequence { next(): Promise<bigint>; }
```

---

## 4. Protocol & data structures

### 4.1 HLC algorithm (node-plane, deterministic core)

Standard Kulkarni/Demirbas HLC, integers only (consensus-safe per `primitives.md`):

```
now(phys_ms):
    if phys_ms > wall_ms:  wall_ms = phys_ms; counter = 0
    else:                  counter += 1               // physical clock didn't advance: bump logical
    return (wall_ms, counter)

merge((r_wall, r_counter), phys_ms):
    new_wall = max(wall_ms, r_wall, phys_ms)
    if new_wall == wall_ms == r_wall:  counter = max(counter, r_counter) + 1
    elif new_wall == wall_ms:          counter += 1
    elif new_wall == r_wall:           counter = r_counter + 1
    else:                              counter = 0     // physical time jumped ahead of both
    wall_ms = new_wall
    return (wall_ms, counter)
```

**Invariants:** (I1) every `now()`/`merge()` result strictly dominates the prior local reading
(monotone — `Ord` on `(wall_ms, counter)`); (I2) a `merge(r)` result strictly dominates `r` (so a
received message's logical time is *after* the sender's send time → causal consistency); (I3)
`counter` is bounded in practice (it only grows while wall time is frozen) and `u32` cannot realistically
overflow within one wall-ms; on the pathological case the node bumps `wall_ms` by 1 (a documented
clamp). HLC is **never** used as a security clock (deadlines use `Ctx.deadline_ms` wall time;
leases use Raft terms — `08-locks-leases-election.md` §5).

### 4.2 Dedup table (node-plane)

A bounded, TTL-evicting map keyed by `(from: NodeId, ns: String, idem: [u8;16])` → cached
`RpcResponse` + the HLC at first-apply. **This is exactly `ce-pubsub/src/dedup.rs::IdempotencyCache`
lifted into the node and re-keyed** (its `Seen::Cursor`/`Handled` becomes a cached `RpcResponse`):
FIFO insertion-order eviction at a hard capacity, lazy TTL drop, in-place refresh. Defaults: capacity
2^20 entries, TTL 10 min (a retry budget outlives any reasonable network stall; contract 05's retry
loop is far shorter). Per-`ns` sub-counts for `/dedup/stat`.

The dedup decision sits on the inbound dispatch path **before** the `MeshEvent::IncomingRpc` is
surfaced to the app (`ce-mesh/src/lib.rs:863`): on a hit the node answers the `ResponseChannel`
itself with the cached response; on a miss it surfaces the request, then on the app's `respond_rpc`
it caches `(triple → response)`. The app never sees a duplicate. This composes with the `ce-coord`
pump's own `Dedup` window (`ce-coord/src/lib.rs:215`), which remains a *best-effort* second line for
gossip; the node table is the *authoritative* exactly-once gate for directed calls.

### 4.3 Counter / sequence data structures

- **CRDT `Sequence`** — state is `BTreeMap<writer_id, u64>` (per-writer high-water). `next()` bumps
  the local writer's entry via `Merged::propose` (an `Add`-style op like
  `collections.rs:351 CounterOp::Add`) and returns `writer_index * STRIDE + local`, where
  `writer_index` is the writer's stable position in the sorted peer set and `STRIDE` is a large
  reservation per writer. Uniqueness is structural (disjoint sub-ranges per writer) — **no
  coordination round, no central allocator** (the §1 goal). The fold is the existing key-ordered
  union (`merged.rs:107 Shared::fold`), so every replica converges.
- **Chain `ChainSequence`** — allocation is a first-writer-wins on-chain `SeqAlloc { name, ns, n }`
  record (mechanically a `NameClaim` — `ce-rs/src/lib.rs:480 claim_name`), assigning the next dense
  index in mined order. A `Replicated` index caches confirmed allocations for O(1) reads. Density +
  global uniqueness come from the PoW chain's single total order; cost is block latency, so it is the
  explicit fallback, not the default.

---

## 5. Semantics & failure modes

**Guarantees:**
- **HLC:** a happens-before relation across all apps and hops — if effect A causally precedes B
  (A's message was processed before B was sent on any path), then `A.hlc < B.hlc`. It is a *total*
  order (ties broken by counter, then by NodeId at the app layer if needed), and it is within
  bounded skew of wall time (`wall_ms` tracks physical time). It is **not** a real-time clock and
  **not** a consensus timestamp — concurrent (causally-unrelated) events get *some* order, not a
  physically-true one.
- **Idempotency dedup:** **exactly-once effect on retry** for any call carrying a stable `idem`,
  *within the TTL window and while the node stays up*. A retried call is served from cache
  (`AlreadyApplied`), so the effect runs once. It does **not** guarantee exactly-once across (a) a
  node restart that loses the in-memory table — see below; (b) a TTL eviction (a retry after 10 min
  may re-run); (c) two *different* nodes receiving the "same" logical call (the key includes `from`,
  so it is per-sender — cross-receiver dedup is the app's job via a chain-anchored effect). It is
  **at-most-once-on-retry**, layered on the transport's at-least-once delivery, yielding effective
  exactly-once for the common retry case.
- **CRDT `Sequence`:** values are **unique and monotone-per-writer**, eventually-consistent
  high-water, **gappy** (disjoint per-writer ranges). Never blocks, survives partitions (each writer
  allocates from its own range offline). Does **not** give dense consecutive ids and does **not**
  give a single global "current max" instantly (a peer's latest may not have arrived).
- **Chain `Sequence`:** **dense, gapless, globally unique**, but block-latency-bound and `Aborted`
  on a first-writer race (retry).

**Partition / crash behavior:**
- **Node restart loses the dedup table** (it is in-memory, like `ce-pubsub`'s). Optional durability:
  a write-behind to the node's existing blob store keyed by a per-`ns` rolling digest, replayed on
  start (a follow-up slice; v0 documents the at-least-once-after-restart limit). The exactly-once
  *across restart* story for money is the chain itself (`Heartbeat` epochs strictly increase —
  `primitives.md` §7 — are already replay-proof); idempotency dedup is the cheap path for non-chain
  effects.
- **Partition:** HLC keeps advancing locally and re-converges on merge (skew bounded by the partition
  duration). CRDT `Sequence` keeps allocating from each side's disjoint range — **no split-brain
  collision** by construction. Chain `Sequence` stalls (it needs chain confirmation) and resumes on
  heal, which is the correct safety/liveness trade for dense ids.
- **What it does NOT guarantee:** linearizability (use 08 locks for that), cross-node-cross-restart
  exactly-once for arbitrary effects (anchor those on-chain), or that two concurrent events have a
  *meaningful* order (HLC orders them, but the order is arbitrary among concurrent events).

---

## 6. Security & economy

- **ce-cap:** `seq:next` on `Tag("seq:<ns>/<name>")` (contract §3) gates *who may draw* from a named
  sequence; attenuation pins a tenant by resource. The HLC stamp and dedup table are **not**
  cap-gated — they are transport mechanism on already-authenticated calls (`Ctx.cap` carries the
  call's real ability; dedup keys on the node-verified `from`). The verifier never learns "sequence"
  or "idempotency" — opaque strings only (`primitives.md` invariant).
- **Abuse / DoS bounds:** the dedup table is bounded (capacity + TTL + FIFO eviction —
  `ce-pubsub/src/dedup.rs` semantics), so a flood of distinct `idem` keys can at worst evict honest
  entries, never exhaust memory; per-`ns` sub-counts + the §11 rate limiter cap a single tenant's
  share. A forged `Ctx.hlc` far in the future is clamped: the node merges but never lets a *remote*
  reading set its `wall_ms` more than a bounded skew (e.g. 5 min) past local physical time — a
  malicious peer cannot drag the cluster clock forward (it can only fail to advance, which is
  harmless). HLC readings are advisory ordering, never authorization, so a lying clock buys nothing.
- **Payment-channel metering (optional):** a high-throughput `seq:next` or a chain-anchored
  allocation can be metered per-allocation over a payment channel (`ce-rs/src/lib.rs:543`
  `channel_open`/`sign_receipt`), exactly as paid chunk fetch is — the sequence-owner app charges a
  receipt per `next()`. Default v0: open/free, like `advertise_service`.

---

## 7. Composition

- **Depends on** `00-architecture.md` (the `Ctx` keystone — `hlc`/`idem`; the `Status::AlreadyApplied`
  variant; the §6 namespacing). Ships immediately after the envelope (contract §5 build order, the
  06/09/11 node-plane trio).
- **Enables / is depended on by:**
  - `05-resilient-rpc.md` — the `(from, ns, idem)` dedup table is what makes a retried resilient call
    exactly-once; 05 names 09 as a direct in-edge.
  - `08-locks-leases-election.md` — an idempotent `lock:acquire` is a dedup hit returning the same
    fencing token; the lease grant records the HLC.
  - `03-durable-queue.md` — generalizes `ce-pubsub`'s `IdempotencyCache` into the node table for
    producer exactly-once; HLC orders cross-partition delivery.
  - `04-event-log-stream.md` — append dedup + HLC as the cross-writer `MergeKey` (the leaderless log's
    total-order key the `Merged` engine already demands).
  - `10-saga-workflow.md` — step idempotency (replay a crashed saga without double-running a step) and
    causal step ordering.
  - The CRDT counter reuses `ce-coord/src/collections.rs::RCounter` and `merged.rs::Merged`; the chain
    sequence reuses the `NameClaim` first-writer-wins mechanism.

---

## 8. Test plan

**Deterministic unit cores (no mesh):**
- `Hlc::now`/`merge` — property tests: monotonicity (I1), recv-dominates-send (I2), commutativity of
  merge order producing a consistent partial order; a `proptest` over interleaved local/remote events
  asserting the resulting timestamps respect a hand-computed happens-before. (Mirrors the
  deterministic-core style of `ce-coord` tests.)
- Dedup table — port `ce-pubsub/src/dedup.rs`'s existing test suite (FIFO eviction keeps recent,
  TTL expiry, in-place refresh, retry-within-window-deduped) re-keyed to `(from, ns, idem)`; assert a
  hit returns the cached response tagged `AlreadyApplied` and never dispatches.
- `Sequence` (CRDT) — property test: across N writers each calling `next()` M times in any interleave,
  the multiset of returned values has **no duplicates** and each writer's values are monotone; the
  folded high-water equals the sum. Reuse the `Merged` determinism harness (`merged.rs` fold is
  order-independent).
- `SeqAlloc` index — unit-test dense assignment under a simulated mined order; first-writer-wins on a
  contended index yields exactly one winner, others `Aborted`.

**Integration (in-process mock mesh, `ce-coord/src/testkit.rs`):**
- Retried `request_idem` across the mock node: send, drop the first reply, resend with the same
  `idem` → exactly one app dispatch, second returns `AlreadyApplied` with identical bytes.
- HLC propagation across a 3-hop app chain (`request` → app `request` → app `request`): assert the
  terminal `AppMessage.hlc` strictly dominates the originator's clock.

**Live multi-node mesh (needs real nodes):**
- Two NAT'd nodes with skewed wall clocks (one set +30s): HLC stays causally consistent; effects
  ordered by HLC match the true send order despite the skew.
- Partition test: split two `Sequence` writers, allocate on both sides, heal → zero collisions, both
  ranges present after convergence.
- Crash test: kill a node mid-retry-window, restart, resend with the same `idem` → documents the
  at-least-once-after-restart limit (v0) / exactly-once with the blob-backed table (follow-up slice).

---

## 9. Worked example — sharded game backend issuing match ids and ordering moves

A sharded multiplayer game (the games on the platform, work item #5) runs one authoritative backend
cell per sector. Two concerns this primitive solves end to end:

1. **Globally-unique match ids with no central allocator.** Each sector backend opens
   `coord.sequence("match-id", &peer_sectors).await?` and calls `seq.next()` to mint a match id when
   a lobby fills. Because the CRDT sequence partitions the id space per writer (sector A draws
   `0,STRIDE,2*STRIDE,…` from its own range, sector B from its own), **two sectors never collide**
   even fully partitioned, and minting is instant and offline-tolerant — exactly the leaderless,
   no-bottleneck property games need. If the game's billing wants *dense* invoice ids instead,
   `coord.chain_sequence("invoice").next()` gives gapless ids at block latency.

2. **Causal ordering of player moves across sectors + exactly-once ability use.** A player casts a
   cross-sector spell: the client `request_idem(sector_b, "cast", payload, idem, 2000)`. Sector B's
   node dedups on `(player, "ce-game/<tenant>", idem)` — if the client retries because the *ack* was
   lost, the spell fires **once** (`AlreadyApplied`), never twice (the bug `ce-pubsub` had to fix).
   Sector B orders the incoming move against its local events by `AppMessage.hlc`, which the node
   merged from the player's `Ctx.hlc` — so a "move then cast" sequence from one player is applied in
   causal order even though the two messages crossed sector boundaries with no shared wall clock. The
   spell's `seq:next` for its effect id and the move's HLC stamp both ride the *same* `Ctx` the call
   already carries — the game writes none of the clock/dedup plumbing.

Tracing across this inter-app request (the move → cast → sector-B-state-write chain) is the same
`Ctx` envelope's `trace`/`hlc` pair, so `06-distributed-tracing.md`'s collector can show the causal
chain with HLC-ordered spans.

---

## 10. Effort & minimal first slice

**Effort: M** (node side is small and reuses `ce-pubsub`'s matured dedup; the CRDT sequence is a
three-line `MergeMachine` over the existing `Merged`; the chain sequence and table-durability are
the only genuinely new bits, both deferrable).

**Minimal first slice (ships behind the `Ctx` keystone):**
1. `Hlc { now, merge }` in `ce-node` with the §4.1 deterministic core + `proptest` invariants, wired
   into inbound `merge` / outbound `now` on the existing dispatch path; surface `AppMessage.hlc`.
2. The `(from, ns, idem)` dedup table — lift `ce-pubsub/src/dedup.rs::IdempotencyCache`, re-key it,
   and gate it before `MeshEvent::IncomingRpc` is surfaced; return `AlreadyApplied` on hit.
3. `CeClient::{new_idem, idem_from, request_idem}` in `ce-rs` and the `GET /clock` route.

Deferred: the CRDT `Sequence`/`next_batch` (`ce-coord`, after #1–3 prove the envelope), the
chain-anchored `ChainSequence`, blob-backed dedup durability across restart, and payment-channel
metering of `seq:next`.
