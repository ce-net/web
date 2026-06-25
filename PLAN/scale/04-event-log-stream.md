# 04 — Event log / replayable stream (partitions, offsets, consumer groups, compaction)

**Status:** implementation-ready design. Conforms to `00-architecture.md` (the contract wins on any
disagreement). Ground truth cited inline: `ce-coord/src/replicated.rs`, `ce-coord/src/merged.rs`,
`ce-coord/src/snapshot.rs`, `ce-coord/src/collections.rs`, `ce-coord/src/stream.rs`,
`ce-coord/src/lib.rs`, `ce-rs/src/lib.rs` (blobs `put_object`/`get_object`, `publish`/`subscribe`/
`request`/`reply`, `AppMessage`), `ce-pubsub/src/{log.rs,subscription.rs,message.rs,caps.rs}`,
`ce/crates/ce-mesh/src/lib.rs`, `ce/docs/primitives.md`.

## Conformance block (architecture §7)

1. **Plane** — **coord** (`ce-coord` SDK over `ce-rs`). Zero node-plane changes; it composes the
   single-writer log engine (`ce-coord/src/replicated.rs` — `Replicated`/`StateMachine`/`Version`),
   content-addressed snapshots (`ce-coord/src/snapshot.rs` — `Checkpoint`/`Snapshot` over
   `put_object`/`get_object`, `ce-rs/src/lib.rs:340,358`), the multi-writer merge layer
   (`ce-coord/src/merged.rs`) for consumer-group offset commits, and `Ctx` from the envelope. It
   proposes **no new `RpcRequest`** — append is `publish`, replay/catch-up is the existing directed
   `request`/`reply` the `Replicated` reader already uses (`replicated.rs:299-345`), exactly
   architecture §0.1 row 04.
2. **Abilities** — reserves `log:append`, `log:read`, `log:admin` (architecture §3; `admin` =
   compaction/retention, matching the `queue:admin` split in `ce-pubsub/src/caps.rs`). Resource-
   scoped by `ce-cap::Resource::Tag("log:<ns>/<topic>")`, so a grant can say "may `log:append` to
   `ce-db/acme/changes` only" by attenuating resource, not ability.
3. **Envelope use** — reads/writes `Ctx.ns` (the log namespace/partition key prefix, §6), `Ctx.cap`
   (append/read/admin authorization), `Ctx.hlc` (a producer's record carries the sender HLC so
   cross-app causal order is preserved across partitions — primitive 09), `Ctx.idem` (exactly-once
   *append* dedup so a retried producer does not duplicate a record), `Ctx.trace`/`parent_span` (a
   replay/consume is one span in the calling action). Adds **no parallel header**.
4. **Status & partial failure** — returns `Ok`, `Unauthorized`, `NotFound` (no such topic/partition/
   offset retained — below the compaction floor), `FailedPrecondition` (offset-conflict on a CAS
   offset commit; reader version behind), `Unavailable` (writer/leader for a partition down),
   `ResourceExhausted` (append rate/quota — primitive 11), `AlreadyApplied` (idempotent append hit).
   A multi-partition read returns `Partial<PartitionRead>` (architecture §4) — never collapses
   "5 of 8 partitions read" to a bool.
5. **Dependencies** — in-edges (architecture §5): `Ctx` envelope (keystone); **09 causal time/idem**
   (`Ctx.hlc` record stamping + `Ctx.idem` append dedup — `09-causal-time-idempotency.md`); **01
   registry** (`01-service-registry-binding.md`) to resolve the partition-writer/leader NodeId by
   service name instead of hard-coding it; **08 locks/election** (`08-locks-leases-election.md`) for
   partition-writer failover. Enables **03 durable queue** (a queue is a single-partition log with a
   leased consumer group — `03-durable-queue.md`), **10 saga** (`10-saga-workflow.md`, the event
   source it replays for recovery), **12 schema registry** (`12-schema-config-registry.md` validates
   every record's payload). Build order: ships in parallel with 03/08 after 01/02.
6. **Namespacing** — a partition's op topic is the existing `Replicated` topic
   `ce-coord/log/<writer_id>/<ns>/<topic>#<partition>` (`replicated.rs:255`), so two tenants' and two
   apps' logs never collide (architecture §6). Consumer-group offsets are a `Merged` replica keyed
   `(ns, "cg/<topic>/<group>")` (`merged.rs:147`). Live fan-out gossip is
   `ce-app/<ns>/<topic>#<partition>` per architecture §6.
7. **Boundary check** — no app policy enters the node: the node only stores opaque blobs, routes
   opaque `AppMessage`s, and verifies an opaque `Ctx.cap`; "topic", "partition", "offset", "consumer
   group", "compaction key", "retention" are all `ce-coord`/app concepts. Stranger code never
   bypasses the local node — every append/read/commit goes through `ce-rs`, and the local node
   authenticates the sender (`AppMessage.from`, `ce-rs/src/lib.rs:732`) and verifies `Ctx.cap`.

---

## 1. Purpose & the at-scale problem

An **event log** is the durable, ordered, *replayable* backbone the rest of a many-app system hangs
off. Concretely it is the Kafka shape: a named **topic** split into **partitions**, each partition an
append-only sequence of records addressed by a monotonic **offset**; many independent **consumer
groups** read the same partitions at their own pace and commit their own offsets; old data is bounded
by **retention** (drop by age/size) or **compaction** (keep only the latest record per key). It is
distinct from the durable *work queue* (primitive 03, `03-durable-queue.md`): a queue hands each
message to *one* consumer and forgets it after ack; a log keeps the record and lets *N* groups each
replay the whole thing from offset 0.

At scale this is the one primitive that makes interdependent apps tractable:

- **One change-feed, many subscribers.** `ce-db` (`ce-db/`) emits a `changes` feed; a search indexer,
  a cache invalidator, an audit sink, and a saga (10) each consume it independently, at their own
  offset, without the producer knowing they exist. Adding a fifth consumer is free and retroactive —
  it starts at offset 0 and replays history. This is the "service binding for a sharded game backend"
  / "tracing across an inter-app request" composition: the log is the seam apps integrate on.
- **Replay for recovery.** A crashed consumer (an indexer, a saga executor) restarts and *replays*
  from its last committed offset — no message is lost, nothing is double-applied if its effects are
  idempotent (primitive 09). Event-sourced apps rebuild their entire state by replaying the log.
- **Partitioned throughput + per-key order.** A single writer caps throughput and ordering scope.
  Partitioning by key (e.g. `account_id`, `match_id`) gives parallel writers while preserving strict
  per-key order — the property a sharded game backend or an account ledger needs.
- **Bounded storage.** A naive log grows forever (`snapshot.rs:3` calls this out). Retention and
  key-compaction bound it; a fresh consumer bootstraps from a content-addressed snapshot instead of
  replaying from offset 1 (`replicated.rs:403-450`).

The hard part at scale is doing all four *without a central broker* and *without new node RPCs*, over
a best-effort gossip mesh where delivery is at-least-once with gaps (`stream.rs:11`,
`lib.rs:140-150`). The insight: CE already has the exact engine — `ce-coord`'s single-writer
`Replicated` log is a per-partition, offset-ordered, gap-repaired, snapshot-compactable append log
(`replicated.rs`), and `ce-pubsub`'s `TopicLog` (`ce-pubsub/src/log.rs`) already proves the
append+prune+snapshot algebra. This primitive *productizes* that engine into the Kafka surface:
partition map, offsets, consumer groups, compaction-by-key, retention.

## 2. Plane: node vs ce-coord, and the justification

**Plane: `ce-coord` (coordination), entirely.** Justification against architecture §0/§1:

- Append is a `publish` to the partition's op topic; the offset is assigned by the partition's single
  writer exactly as `Replicated::propose` assigns a `Version` (`replicated.rs:351-369`). No peer that
  does *not* run the app needs to enforce anything on the wire — the writer is the app.
- Replay/catch-up is the directed `request`/`reply` the `Replicated` reader already performs
  (`replicated.rs:322-340`): a consumer asks the partition writer for "everything from offset N",
  gets the tail, and on a compaction redirect loads a snapshot blob (`replicated.rs:335`,
  `snapshot.rs:18-24`). All three verbs already exist.
- Consumer-group offset commits are *coordination state*: a `Merged` multi-writer CRDT
  (`merged.rs`) keyed by group, so every member of a group converges on the committed offsets with no
  leader. Offsets/groups/compaction are precisely "offsets, consumer-groups, compaction are
  coordination state over the blob store" (architecture §0.1 row 04).
- The only node-plane facts it *consumes* are the shared ones from the §1/§2 envelope work: `Ctx.idem`
  for exactly-once append dedup (primitive 09's node dedup table), `Ctx.hlc` for cross-partition
  causal order, `Ctx`-carried `cap` verification. It adds **nothing** to that table.

It would earn a node-plane change only if a peer that does not run the log app had to enforce log
semantics on the wire — it never does. Per architecture §1, proposing a new `RpcRequest` here would
be rejected; we do not. This is a pure `ce-coord` library, unprivileged, run as an ordinary app.

## 3. Public API

### 3.1 Rust SDK (`ce-coord`, new module `ce-coord/src/eventlog.rs`)

Reuses the existing engine verbatim: each partition is a `Replicated<PartitionLog>`
(`replicated.rs:231`), the offset is its `Version` (`replicated.rs:35`), snapshots are
`Checkpoint`/`Snapshot` (`snapshot.rs:44,58`), group offsets are a `Merged<GroupOffsets>`
(`merged.rs:123`).

```rust
// ce-coord/src/eventlog.rs

use crate::{Coord, Version, Checkpoint};
use ce_rs::Ctx;                 // the envelope (architecture §2)
use anyhow::Result;

/// A partition index within a topic. 0..partitions.
pub type Partition = u32;
/// A record's position within a partition. Re-uses the engine's monotonic `Version`.
pub type Offset = Version;       // = u64 (replicated.rs:35)

/// Where a fresh consumer begins when it has no committed offset.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum StartAt { Earliest, Latest, Offset(Offset) }

/// Retention policy for a topic. Applied by the topic owner (`log:admin`) only — never an
/// accident of replication (mirrors `ce-pubsub/src/log.rs:11`: prune is an explicit op).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Retention {
    /// Keep everything (default; bounded only by explicit `compact`/`snapshot`).
    Unbounded,
    /// Drop records older than `secs` of wall time (by record `ts`).
    Age { secs: u64 },
    /// Keep at most `n` records per partition (drop oldest).
    Count { n: u64 },
    /// Log-compaction: keep only the latest record per `key` (tombstones delete a key).
    Compact,
}

/// One record as it sits in a partition. `key` drives partitioning + compaction; `headers`
/// carry the producer `Ctx` projection (trace/hlc/idem) so consumers see causal metadata.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub offset: Offset,          // assigned by the partition writer (= engine Version)
    pub key: Option<Vec<u8>>,    // None => round-robin partitioned, never compacted
    pub value: Option<Vec<u8>>,  // None + Compact => tombstone (delete this key)
    pub ts: u64,                 // producer wall-ms (record time, used by Age retention)
    pub hlc: (u64, u32),         // Ctx.hlc snapshot (primitive 09 causal order)
    pub trace: [u8; 16],         // Ctx.trace (primitive 06)
}

/// A handle to one topic. Cheap to clone.
pub struct EventLog { /* Arc inner: Coord, ns, topic, partition writers/readers, Retention */ }

impl Coord {
    /// Open (creating if absent) a topic this node **owns** (it is the writer for every partition it
    /// hosts). `partitions` and `retention` are fixed at create; opening again with a different
    /// count is `FailedPrecondition`. Requires `log:admin` on `log:<ns>/<topic>` (in `ctx.cap`).
    pub async fn event_log_owner(
        &self, ns: &str, topic: &str, partitions: u32, retention: Retention,
    ) -> Result<EventLog>;

    /// Open a topic for producing/consuming as a non-owner. Resolves partition writers via the
    /// service registry (01) under `service_key = "<ns>/log-<topic>@1"`.
    pub async fn event_log(&self, ns: &str, topic: &str) -> Result<EventLog>;
}

impl EventLog {
    pub fn partitions(&self) -> u32;

    /// Append one record. The partition is `key`-hashed (or round-robin if `key` is None, or an
    /// explicit `with_partition`). Returns the assigned `(Partition, Offset)`. Threads `ctx`:
    /// `ctx.idem` makes a retried append exactly-once (returns `AlreadyApplied` with the original
    /// offset on a dedup hit); `ctx.hlc`/`ctx.trace` are projected into the `Record`.
    pub async fn append(&self, ctx: &Ctx, key: Option<&[u8]>, value: &[u8]) -> Result<(Partition, Offset)>;
    /// Append a tombstone (compaction delete) for `key`. Only meaningful under `Retention::Compact`.
    pub async fn append_tombstone(&self, ctx: &Ctx, key: &[u8]) -> Result<(Partition, Offset)>;

    /// Direct partition read: every record with `offset > from` on `partition`, in order. Below the
    /// compaction floor => `redirect` to a `Checkpoint` (snapshot CID) the caller loads (mirrors the
    /// reader catch-up in `replicated.rs:322-340`).
    pub async fn read(&self, partition: Partition, from: Offset, max: usize) -> Result<ReadSlice>;

    /// Open a **consumer** in a named group. Each group commits its own offsets; within a group every
    /// partition is assigned to exactly one live member (cooperative assignment, §4.3). Starts at the
    /// group's committed offset, or `start` if the group is new. Requires `log:read`.
    pub async fn consumer(&self, group: &str, start: StartAt) -> Result<Consumer>;

    /// Owner-only retention/compaction sweep (one pass). Requires `log:admin`. Returns how many
    /// records were dropped per partition. Also triggers a per-partition `snapshot()` so a fresh
    /// consumer bootstraps cheaply.
    pub async fn compact(&self) -> Result<Vec<(Partition, u64)>>;
}

/// A read result for one partition: the contiguous tail, plus a snapshot redirect if `from` is
/// below the compaction floor.
pub struct ReadSlice {
    pub records: Vec<Record>,
    pub high: Offset,                  // current end offset of the partition
    pub redirect: Option<Checkpoint>,  // snapshot.rs:58 — load this then re-read from cp.base+1
}

/// A group consumer. Internally one `Replicated` reader per assigned partition + a `Merged` offset
/// log shared by the group. `poll` returns the next batch across assigned partitions; `commit`
/// advances the group's durable offset (so a replay-on-restart resumes here).
pub struct Consumer { /* ... */ }

impl Consumer {
    /// Next batch of records across this member's assigned partitions, in per-partition offset order
    /// (no cross-partition order guarantee — that is `hlc` if the consumer wants it). Blocks until
    /// at least one record is available or `max_wait` elapses (then returns empty).
    pub async fn poll(&mut self, max: usize, max_wait_ms: u64) -> Result<Vec<Record>>;
    /// Durably commit "this group has processed up to `offset` on `partition`". A `Merged` CRDT op,
    /// so concurrent members converge. Idempotent; commits only move forward (lower => no-op).
    pub async fn commit(&self, partition: Partition, offset: Offset) -> Result<()>;
    /// The group's currently committed offset for `partition` (max across members).
    pub fn committed(&self, partition: Partition) -> Offset;
    /// Watch for assignment changes (a member joined/left and partitions were rebalanced).
    pub fn assignment(&self) -> Vec<Partition>;
}
```

### 3.2 TS SDK (`ce-ts`)

Mirror surface over the same `@ce/client` mesh transport the browser node bridge exposes (the
platform bridge in task #4). Types match the Rust wire structs.

```ts
type Partition = number;
type Offset = bigint;                 // u64 — crosses JSON as string, parsed to bigint
type StartAt = "earliest" | "latest" | { offset: Offset };
type Retention =
  | { kind: "unbounded" }
  | { kind: "age"; secs: number }
  | { kind: "count"; n: number }
  | { kind: "compact" };

interface Record { offset: Offset; key?: Uint8Array; value?: Uint8Array;
                   ts: number; hlc: [number, number]; trace: Uint8Array; }

interface EventLog {
  partitions(): number;
  append(key: Uint8Array | null, value: Uint8Array, ctx?: Ctx): Promise<[Partition, Offset]>;
  appendTombstone(key: Uint8Array, ctx?: Ctx): Promise<[Partition, Offset]>;
  read(partition: Partition, from: Offset, max: number): Promise<ReadSlice>;
  consumer(group: string, start: StartAt): Promise<Consumer>;
  compact(): Promise<Array<[Partition, bigint]>>;        // owner only
}
interface Consumer {
  poll(max: number, maxWaitMs: number): Promise<Record[]>;
  commit(partition: Partition, offset: Offset): Promise<void>;
  committed(partition: Partition): Offset;
  assignment(): Partition[];
}

// ce-coord-style constructors on the client:
declare function eventLogOwner(ns: string, topic: string, partitions: number,
                               retention: Retention): Promise<EventLog>;
declare function eventLog(ns: string, topic: string): Promise<EventLog>;
```

### 3.3 Node HTTP routes & wire types

**None.** Per §2 this is pure `ce-coord` over the three existing verbs plus blobs. The wire format is
the existing `Replicated` `Entry` (`replicated.rs:38`), `CatchUp`/`CatchUpReply` (`replicated.rs:46,
56`), `Checkpoint` (`snapshot.rs:58`), and the `Merged` per-writer logs (`merged.rs`) — all carried
inside `AppMessage`/`AppPubSubMsg.payload` (opaque to the node). The only new bincode/serde types are
the app-level `Record`, `PartitionLog`/`PartitionOp`, `GroupOffsets`/`OffsetOp`, and `Retention`
above, which live in `ce-coord` and never touch the node.

## 4. Protocol & data structures

### 4.1 Per-partition log = `Replicated<PartitionLog>`

Each partition is one single-writer `ce-coord` log. The state machine is `PartitionLog`, a direct
descendant of `ce-pubsub`'s proven `TopicLog` (`ce-pubsub/src/log.rs:23-62`): an append-only vector
with a retention `floor` keeping offsets absolute.

```rust
// ce-coord/src/eventlog.rs — the per-partition replicated state machine.
#[derive(Default, Clone, Serialize, Deserialize)]
struct PartitionLog {
    records: Vec<Record>,   // retained, offset-ordered; first.offset == floor + 1
    floor: Offset,          // count dropped from the front by retention/compaction
    // For Retention::Compact only: latest offset per key, so compaction is O(1) per key.
    latest_by_key: BTreeMap<Vec<u8>, Offset>,
}
#[derive(Clone, Serialize, Deserialize)]
enum PartitionOp {
    Append(Record),          // writer stamps Record.offset = next before propose (log.rs:52 pattern)
    PruneTo(Offset),         // retention: drop offset <= n (log.rs:55)
    Compact { keep: Vec<Offset> }, // compaction: keep only these offsets (latest per key + tombstones policy)
}
impl StateMachine for PartitionLog {           // replicated.rs:64
    type Op = PartitionOp;
    fn apply(&mut self, op: PartitionOp) { /* re-stamp offset = next (log.rs:52), prune, compact */ }
}
impl Snapshot for PartitionLog { json_snapshot!(); }   // snapshot.rs:81 — enables compaction + cheap bootstrap
```

- **Append** → `Replicated::propose(PartitionOp::Append(record))` (`replicated.rs:351`). The engine
  assigns the monotonic `Version`; we re-stamp it onto `Record.offset` inside `apply` exactly as
  `TopicLog` re-stamps the cursor (`log.rs:46-54`) so a malformed op can never desync offsets.
- **Replay** → the engine's existing reader path: a consumer is a `Replicated::reader` (or
  `snapshot_reader`, `replicated.rs:411`) following the partition writer; gaps are buffered and
  repaired by a directed `request` for the missing prefix (`replicated.rs:119-131, 299-345`).
- **Compaction/retention** → owner proposes `PruneTo`/`Compact`, then `Replicated::checkpoint()`
  (`replicated.rs:435`) stores a snapshot blob and drops covered entries. A consumer reading below
  the floor gets `redirect = Some(Checkpoint)` and bootstraps from the blob (`replicated.rs:335`,
  `snapshot.rs:18-24`).

**Invariant (offset monotonicity & absoluteness):** within a partition, offsets are strictly
increasing and absolute — a record keeps its offset forever, even after older records are pruned
(`log.rs:50-58`, proven by `log.rs:prune_advances_floor_and_keeps_cursors_absolute`). `read(from)`
returns exactly `offset > from`; below the floor → `redirect`, never silent omission.

### 4.2 Partition map & writer placement

A topic is `partitions` independent `Replicated` logs. Partition selection on append:
`partition = hash(key) % partitions` (a fixed FNV/`DefaultHasher`, deterministic so all producers
agree), or round-robin when `key` is None, or explicit. Each partition has one **writer** NodeId; the
owner is the default writer for all partitions, but partitions may be spread across owner-controlled
nodes for throughput. Producers/consumers resolve a partition's writer via the **service registry
(01)** under `service_key = "<ns>/log-<topic>@1"` (`01-service-registry-binding.md`,
`ce-rs/src/lib.rs:500-513`), so writer placement is not hard-coded and survives failover.

**Writer failover (08):** the partition writer role is an `08` lock/lease
(`08-locks-leases-election.md`) keyed `(ns, "log-writer/<topic>#<partition>")`. If the writer dies, a
standby acquires the lease, opens the partition as a *new* writer seeded from the latest snapshot +
remaining log, and re-advertises in 01. Because offsets are absolute and the new writer resumes from
`high+1`, no offset is reused. (First slice, §10, ships single-writer-per-topic; failover is the
follow-up.)

### 4.3 Consumer groups & offset commits = `Merged<GroupOffsets>`

A consumer group's committed offsets are a **multi-writer merged log** (`merged.rs:123`) named
`(ns, "cg/<topic>/<group>")`, so every member converges with no leader — the leaderless property
`merged.rs:1-30` is built for (members may be offline/mobile).

```rust
#[derive(Default)]
struct GroupOffsets { committed: BTreeMap<Partition, Offset>, members: BTreeMap<String, u64> /* id->heartbeat */ }
#[derive(Clone, Serialize, Deserialize)]
struct OffsetOp { ts: (u64, String), kind: OffsetKind }   // (lamport, node_id) = MergeKey (merged.rs:46)
enum OffsetKind { Commit { partition: Partition, offset: Offset },
                  Heartbeat { member: String, at: u64 },
                  Leave { member: String } }
impl MergeMachine for GroupOffsets {        // merged.rs:57
    type Op = OffsetOp; type Key = (u64, String);
    fn key(op: &OffsetOp) -> (u64, String) { op.ts.clone() }
    fn apply(&mut self, op: OffsetOp) {
        match op.kind {
            // committed offset is monotone-max: a concurrent older commit never regresses it.
            OffsetKind::Commit{partition, offset} =>
                { let e = self.committed.entry(partition).or_default(); *e = (*e).max(offset); }
            OffsetKind::Heartbeat{member, at} => { self.members.insert(member, at); }
            OffsetKind::Leave{member} => { self.members.remove(&member); }
        }
    }
}
```

- **Commit** = `Merged::propose(OffsetKind::Commit)` (`merged.rs:199`). The `apply` takes a
  **monotone max** per partition, so concurrent commits from two members of the same group converge
  to the furthest offset regardless of delivery order — the merge-fold-is-order-independent property
  proven in `merged.rs:prop_multiwriter_all_orders_converge`.
- **Assignment (cooperative).** Members heartbeat into the same `Merged`. The live-member set is the
  fold; partition→member assignment is a deterministic function of `(sorted live members, partitions)`
  computed identically on every member (rendezvous/round-robin hash). When membership changes, every
  member recomputes and only the affected partitions move. No central coordinator; the `Merged` fold
  is the shared truth. (A group that wants *strict* single-assignment uses an `08` lease per
  `(group, partition)` instead — offered as `consumer_exclusive`.)

**Invariant (at-least-once per group, never lost):** a group resumes from `committed[partition]`. A
member that crashes between processing and `commit` reprocesses from the last committed offset on
restart — at-least-once. Exactly-once *effects* are the consumer's job via `Ctx.idem` (primitive 09);
the log guarantees the *record* is still there to reprocess.

### 4.4 Live fan-out + lagging replay (the two read paths)

Mirrors `ce-pubsub`'s live/replay split (`message.rs:323,317`):

1. **Live tail** — the partition writer's `propose` already `publish`es each entry to the op topic
   `ce-coord/log/<writer>/<ns>/<topic>#<p>` (`replicated.rs:367`); a caught-up consumer's `Replicated`
   reader applies it the instant it arrives over the SSE pump (`lib.rs:127-192`). Latency ≈ one hop.
2. **Replay/catch-up** — a lagging or fresh consumer's reader detects a gap and `request`s the tail
   (`replicated.rs:322`); below the floor it loads the snapshot blob. This is the recovery path.

Both paths feed the *same* ordering core (`replicated.rs:Core::feed`), which is duplicate-tolerant and
gap-repairing (proven by `prop_arbitrary_delivery_order_converges`), so a consumer that sees a
record live and again on replay applies it exactly once by offset.

## 5. Semantics & failure modes

**Guarantees.**
- **Per-partition total order.** Offsets strictly increase; every consumer reads a partition in the
  same order. Inherited from `Replicated` single-writer ordering (`replicated.rs:9-17`,
  `prop_arbitrary_delivery_order_converges`).
- **Durable & replayable.** A committed append survives writer restart (it is in the log + snapshots)
  and is replayable by any group from offset 0 until retention/compaction drops it. `NotFound` for an
  offset below the floor is explicit (the `redirect`), never a silent gap.
- **At-least-once delivery, exactly-once append.** Gossip is at-least-once with possible duplicates
  (`stream.rs:11`); the offset-keyed ordering core dedups on the read side. A retried *append* with
  `Ctx.idem` set is exactly-once via the node dedup table (primitive 09) — returns `AlreadyApplied`
  with the original offset.
- **Per-group monotone offset convergence.** Concurrent commits converge to the max (§4.3),
  leaderless.
- **Compaction equivalence.** snapshot + tail == full replay (`snapshot.rs:158`,
  `replicated.rs:prop_snapshot_install_plus_tail_equals_full`): a consumer bootstrapping from a
  compacted snapshot reaches byte-identical state to one that replayed every record.

**What it does NOT guarantee.**
- **No cross-partition order.** Records in different partitions have no relative order *except* the
  causal `hlc` each carries (primitive 09); a consumer wanting a global causal merge sorts by `hlc`
  itself (the `Merged` pattern, `merged.rs:46`). Same key → same partition → ordered.
- **No exactly-once *processing*.** The log redelivers on replay; idempotent effects are the
  consumer's responsibility (`Ctx.idem`). The log promises the record is *there*, not that your
  side-effect ran once.
- **No global linearizability.** Reads are local replicas that lag the writer by the mesh latency;
  `committed()` is a CRDT view that may trail a just-issued commit from another member until it
  converges. Bounded staleness, never lies.
- **Not a database.** No secondary indexes, no queries beyond offset/partition/key range. That is
  `ce-db`/`ce-query`'s job, fed *by* this log.

**Crash/partition behavior.** Writer crash → that partition stalls for appends until 08 failover
(reads of existing offsets keep working from replicas); consumer crash → resumes from committed
offset (at-least-once); network partition → producers on the writer's side keep appending, isolated
consumers serve stale-but-consistent reads and catch up on heal (no split-brain because each partition
has one writer/lease). Snapshot blob unreachable → consumer cannot bootstrap a compacted floor;
returns `Unavailable` and retries (blobs are content-addressed and refetchable, `lib.rs:340-389`).

## 6. Security & economy

- **Abilities (architecture §3):** `log:append` (produce), `log:read` (consume/replay),
  `log:admin` (create topic, set retention, compact). Carried in `Ctx.cap`; the writer's local node
  verifies the chain authorizes the exact `domain:verb` on `Resource::Tag("log:<ns>/<topic>")`
  before applying an op — identical to `ce-pubsub`'s `verify_link` gate (`caps.rs:98-117`). A grant
  attenuates by resource to a single topic, or by `ns` tag to a tenant (architecture §6). Append
  authorization is checked *by the partition writer's node* on the incoming `propose` message — the
  enforcement point per `primitives.md`; a consumer applying entries already trusts its chosen writer
  (`replicated.rs:299-307` only applies entries `from == writer`).
- **Abuse/DoS bounds.** (a) **Record size** capped (reuse `MAX_PAYLOAD_BYTES = 10 MiB`,
  `message.rs:24`). (b) **Append rate/quota** is primitive 11 (`11-flow-control-rate-limit.md`): the
  writer's node throttles `log:append` per `(from, ns, ability)` token bucket and returns
  `ResourceExhausted` with `retry_after_ms` (architecture §4) before doing work — economy-tied so
  paying credits raises the bucket. (c) **Unbounded growth** bounded by `Retention` + mandatory
  `compact`/snapshot; an owner that never compacts pays its own blob storage. (d) **Group offset
  spam** bounded by `log:read` cap + the `Merged` dedup-by-key (`merged.rs:204`).
- **Optional payment-channel metering.** A pay-per-consume log (a premium change-feed) meters
  `log:read` bytes against a payment channel: the consumer opens a channel (`channel_open`,
  `lib.rs:543`), signs cumulative receipts per replayed MiB (`sign_receipt`, `lib.rs:551`), the writer
  redeems on close. This reuses the existing channel primitive exactly as relay payment does
  (`pay_relay`, `lib.rs:519`); the log adds only the byte accounting, not new economy.

## 7. Composition

- **Depends on** (in-edges, §5 of the contract):
  - `Ctx` envelope (keystone) — `00-architecture.md` §2.
  - **09 causal time / idempotency** — `09-causal-time-idempotency.md`: `Ctx.hlc` stamps each
    record for cross-partition causal order; `Ctx.idem` makes append exactly-once.
  - **01 service registry / binding** — `01-service-registry-binding.md`: resolves the partition
    writer NodeId by `service_key` instead of hard-coding it.
  - **08 locks / leases / election** — `08-locks-leases-election.md`: partition-writer failover lease
    and optional `consumer_exclusive` per-partition assignment.
- **Enables / is depended on by:**
  - **03 durable queue** — `03-durable-queue.md`: a queue is a single-partition event log with one
    leased consumer group; both share the `TopicLog`/`SubscriptionState` algebra
    (`ce-pubsub/src/{log.rs,subscription.rs}`).
  - **10 saga / workflow** — `10-saga-workflow.md`: the event source it appends step-events to and
    replays on recovery.
  - **12 schema / contract registry** — `12-schema-config-registry.md`: validates every record's
    `value` against the topic's registered schema before append (`InvalidArgument` on mismatch).
- **Sibling/peer:** **02 load-balancing/placement** (`02-load-balancing-placement.md`) spreads
  partition writers across hosts; **06 tracing** (`06-distributed-tracing.md`) reads `Record.trace`
  to stitch a produced-then-consumed event into one trace.

## 8. Test plan

**Deterministic cores (pure unit tests, no node/mesh — the bulk of correctness).**
- `PartitionLog` append/prune/compact algebra: offsets monotone & absolute after prune; `read(from)`
  is a strict tail; tombstone removes a key under `Compact`; re-stamp prevents desync. Direct
  descendant of the already-green `ce-pubsub/src/log.rs` tests — port them.
- Compaction-by-key: after `Compact`, exactly one record per key survives (latest), tombstoned keys
  gone; `latest_by_key` matches a brute-force scan (property test).
- `GroupOffsets` merge: `prop`-test that concurrent `Commit`s converge to per-partition max under any
  delivery order / duplicates (reuse the `merged.rs` proptest harness:
  `prop_multiwriter_all_orders_converge`, `prop_multiwriter_idempotent_commutative`).
- Snapshot+tail == full replay for `PartitionLog`, every cut point (mirror `snapshot.rs:158` and
  `replicated.rs:prop_snapshot_install_plus_tail_equals_full`).
- Partition selection: `hash(key) % p` is deterministic and balanced (distribution property test).
- Assignment function: deterministic single-owner-per-partition given a member set; minimal movement
  on membership change (property: only affected partitions reassign).

**Integration tests (`ce-coord` testkit, in-process `Coord` over a loopback node —
`ce-coord/src/testkit.rs`).**
- Producer appends N records to P partitions; a fresh consumer group replays all N from offset 0;
  offsets contiguous per partition.
- Two consumers in one group split partitions; one crashes (drop), the other takes over its
  partitions, no record skipped (committed-offset resume).
- Two *different* groups both replay the full log independently (the many-subscribers property).
- Owner compacts; a fresh consumer bootstraps from the snapshot blob and reaches the same materialized
  state as one that joined before compaction (keystone equivalence end-to-end).
- Exactly-once append: retry the same `append` with a fixed `Ctx.idem` → one record, second returns
  `AlreadyApplied` with the original offset.

**Needs a live multi-node mesh (E2E).**
- Cross-host partition writers (01 resolution) + a consumer on a third node; live-tail latency ≈ one
  hop; replay after induced gossip loss converges.
- Writer-failover (08): kill the partition writer, a standby acquires the lease, resumes from
  snapshot+log at `high+1`, producers reconnect, no offset reused, consumers continue.
- Payment-metered replay over a real channel (redeem on close).

## 9. Worked example — sharded game backend on a change-feed

A multiplayer game (one of the mesh game backends in task #5) shards match state across many
authoritative `match-host` nodes. It uses one event-log topic as the spine:

- **Topic** `game/prod/match-events`, **`partitions = 64`, `Retention::Compact`** on `key = match_id`
  (so the log holds the *latest* snapshotable event per live match; finished matches are tombstoned).
  Created by the game owner with `log:admin`.
- **Producers:** each `match-host` appends authoritative events (`{move, score, join, end}`) with
  `key = match_id`, so all events for one match land on one partition and are strictly ordered — the
  per-key order a game needs. `Ctx.idem = hash(match_id, seq)` makes a retried append (client
  reconnect) exactly-once, so a duplicated "score" never double-counts.
- **Consumer group `live-fanout`:** the WebSocket gateway nodes (one consumer per gateway, split
  across the 64 partitions by cooperative assignment) tail their partitions live (≈ one hop) and push
  deltas to spectators. A gateway crash → its partitions reassign to the survivors; the new owner
  resumes from the group's committed offset, replaying the few seconds it missed — *replay for
  recovery*, visible as a brief catch-up, not lost state.
- **Consumer group `leaderboard`:** an independent group replays the *same* partitions at its own
  pace, folding scores into `ce-db`. Adding it later was free and retroactive — it started at
  `Earliest` and replayed history. This is the "many apps subscribe to one app's change-feed" core
  use case.
- **Recovery / new shard:** a freshly spun-up `match-host` taking over a shard `event_log`s the topic,
  bootstraps each of its partitions from the latest compacted snapshot blob (`Checkpoint`), and is
  immediately authoritative without replaying all of history — `compaction for bootstrap`.
- **Tracing the inter-app request:** a player's "make move" action carries one `Ctx.trace`
  (architecture §2) from the HTTP edge → `match-host` append → `Record.trace` → `live-fanout`
  consume → spectator push. Primitive 06 stitches the produced-then-consumed record into one trace, so
  an operator sees the move flow end-to-end across three apps.

Every hop is `ce-rs`/`ce-coord` through the local node; no app opens a socket to a stranger; the game
owner's grants pin `log:append` to `game/prod/match-events` for its hosts and `log:read` for its
gateways — the boundary holds.

## 10. Effort & minimal first slice

**Effort: L.** The engine (`Replicated`, `Merged`, `Snapshot`, blobs) and the proven algebra
(`ce-pubsub/src/log.rs`) already exist; this is mostly the partition map, the consumer-group offset
CRDT, the assignment function, and the typed `EventLog`/`Consumer` surface — plus the §7 integrations
(09 idem, 01 resolution, 08 failover) which arrive incrementally. XL only if writer-failover and
payment metering are pulled into the first cut.

**Minimal first slice (ships behind tests):**
1. `ce-coord/src/eventlog.rs`: `PartitionLog` state machine + `Snapshot` (port `ce-pubsub/src/log.rs`
   algebra), `Record`/`Retention`/`PartitionOp` types, deterministic partition hashing.
2. `EventLog` with a **single owner-writer per topic** (no failover yet), `append`/`read`/`compact`
   over `Replicated::propose`/`reader`/`checkpoint` — no node changes.
3. `Consumer` + `GroupOffsets` `Merged` with monotone-max commit and **cooperative** (non-exclusive)
   assignment; `poll`/`commit`/`committed`.
4. `Ctx` threading: project `hlc`/`trace` into `Record`, honor `Ctx.idem` for append dedup (degrades
   to at-least-once if 09's dedup table is not yet live).
5. Deterministic-core unit/property tests (§8) + the in-process testkit integration tests. Defer
   01-resolution (hard-code owner), 08-failover, and payment metering to follow-ups.

This delivers the headline capability — partitioned, offset-addressed, replayable, compactable log
with consumer groups — as a pure `ce-coord` library with zero node-plane change, exactly per the
contract.
