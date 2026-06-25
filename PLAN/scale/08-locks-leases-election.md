# 08 — Distributed locks, leases & leader election (fencing tokens, singletons, shard ownership)

**Status:** implementation-ready. Conforms to `00-architecture.md` (the contract). Ground truth:
`ce-coord/src/{lib,replicated,merged,stream,testkit}.rs` (the coordination engines + mock mesh),
`ce-rs/src/lib.rs` (`request`/`reply`/`publish`/`subscribe`/`messages`/`find_service`/
`advertise_service`), `ce-mesh/src/lib.rs` (`AppRequest`/`AppMessage`/`AppPubSubMsg`,
`APP_TOPIC_PREFIX = "ce-app/"`), `ce/crates/ce-cap/src/lib.rs` (`Resource`, `Caveats::not_after`,
`is_narrower_or_equal`), `ce-iam/src/lib.rs` (`with_action_universe`), `ce/docs/primitives.md`
(the boundary). The `ce-coord` README already names this primitive: *"Multi-writer groups with Raft
leader election are the next layer up and slot in here without changing collection call sites"*
(`replicated.rs` module doc) — this doc designs that layer.

## Conformance block (contract §7)

1. **Plane** — **coord**, over a `ce-coord` Raft group (contract §0.1 row 08). No new `RpcRequest`
   variant: the Raft replication, vote, and heartbeat messages are all `ce-rs` `publish`/`subscribe`
   (AppEnded fan-out of `AppendEntries`/`Vote`) plus directed `request`/`reply` (catch-up), the exact
   three generic verbs `Replicated` already uses. Justification: *linearizable mutual exclusion is a
   coordination protocol* (contract §0.1) — a key/coin/byte mechanism every app would otherwise
   reinvent, but one the node need not enforce on the wire. The node never learns what a "lock" is;
   it only delivers signed `AppMessage`s and verifies `Ctx.cap`. The fencing token (the one externally
   visible artifact) is enforced by **the resource server**, not the node (§5).
2. **Abilities** — `lock:acquire`, `lock:release`, `lock:elect` (contract §3). `acquire` covers
   acquire/renew/try-acquire of a named lock or lease; `release` covers explicit unlock and lease
   surrender; `elect` covers joining an election as a candidate and reading leadership. Resource
   scoping via `ce-cap::Resource` carrying the lock/group name as a `Tag("lock:<ns>/<name>")` or
   `Tag("elect:<ns>/<group>")`, so a grant can say "may only acquire `lock:ce-game/sector-7`" by
   attenuating resource, not ability (contract §3). Membership in the Raft group (who may be a
   *replica*, distinct from who may be a *client*) is gated by `lock:elect` on `Tag("raft:<ns>/<group>")`.
3. **Envelope use** — reads/writes `Ctx{ ns, cap, deadline_ms, idem, trace, hlc }`. `idem` makes
   acquire idempotent (a retried acquire returns the *same* fencing token, never a second grant —
   §5). `deadline_ms` bounds a blocking acquire. `hlc` is recorded with each lease grant for cross-app
   causal ordering but is **never** the lease clock (leases expire on the Raft leader's monotonic term
   clock, not wall time — §5). Adds no parallel header.
4. **Status & partial failure** — returns `Ok`, `Unauthorized`, `NotFound` (no such lock/group),
   `FailedPrecondition` (lock already held by another holder; not the leader), `Aborted` (fencing
   conflict / lost leadership mid-operation — retry the txn), `Unavailable` (no Raft quorum reachable),
   `DeadlineExceeded` (blocking acquire timed out), `AlreadyApplied` (idempotent re-acquire returns the
   prior token). A multi-lock atomic acquire (shard-set ownership) returns `Partial<LockGrant>`
   (contract §4) — the caller sees which shards it won and which were already held, and releases the
   won subset on partial failure (never reports success while hiding a held shard).
5. **Dependencies** — in-edges in contract §5: `Ctx` envelope, **09** (idempotency dedup + HLC — an
   idempotent acquire is a §2 dedup-table hit), **01** (service registry — clients `find_service` the
   current Raft group members / the leader endpoint), **02** (placement reads leadership to pin a
   singleton). Enables **03** (single-active queue-partition owner), **04** (single-writer log lease →
   promotes a `Replicated` writer safely), **10** (saga uses a lease to own a workflow instance).
   Build order: ships in the `{03,04,08}` durable-coordination wave after 01/02 (contract §5).
6. **Namespacing** — Raft wire topics are `ce-app/<ns>/raft.{append,vote,leader}.<group>`; the
   per-group replicated state key is `(ns, raft.<group>)` (contract §6). A lock/lease/election lives
   *inside* one group's state machine keyed by `(ns, lock|lease|elect, <name>)`, so two tenants'
   `sector-7` locks are distinct state in distinct groups. Default empty `ns` ⇒ the caller's NodeId
   hex (a private per-key group) — a single-node app gets a degenerate 1-member group for free.
7. **Boundary check** — no app policy enters the node: the node only delivers signed `AppMessage`s and
   enforces `Ctx` (cap, deadline, dedup); "lock", "lease", "leader", "fencing token" are all
   `ce-coord` library concepts. Stranger code never bypasses the local node — every acquire/renew is a
   `ce-rs` call through the *local* node, which authenticates `AppMessage.from` (a node-verified
   NodeId) and verifies the `Ctx.cap` chain before the Raft leader app acts on it.

---

## 1. Purpose & the at-scale problem

Once many interdependent apps share one mesh, concurrency becomes the dominant failure mode. The
existing `ce-coord` engines already cover two of the three regimes:

- **`Replicated<S>`** (`replicated.rs`) — *one* writer, many readers. Correct, but it assumes the
  writer's identity is *given*: a reader "only ever applies operations authored by the writer it
  chose to follow" (module doc). It has **no answer to "who is the writer now?"** — if the writer
  crashes, the collection stalls; if two nodes both think they are the writer, readers see two
  divergent logs on the same name.
- **`Merged<M>`** (`merged.rs`) — *N* leaderless writers, deterministic merge. Correct for local-first
  edits, but it is explicitly the *wrong* primitive for mutual exclusion: it converges by **union**,
  so two writers "holding" the same lock both succeed and the lock means nothing.

Neither gives **mutual exclusion**. The moment an app shards mutable state — a game backend splitting
the world into sectors, `ce-pubsub` splitting a queue into partitions (03), `ce-db` electing a primary
for a collection (04) — exactly one node must own each shard at a time, and that ownership must be:

1. **Safe under partition/crash.** When the owner is unreachable, ownership must transfer to a live
   node **without** the old owner and the new owner both acting (the classic split-brain that
   corrupts a sharded backend). A timeout alone is insufficient: a paused-then-resumed old owner
   ("zombie") can still issue a stale write after the lease was reassigned.
2. **Fenced.** Every grant carries a **monotonically increasing fencing token**; the resource server
   rejects any write carrying a token lower than the highest it has seen. This is the only way to make
   a lease *safe* rather than merely *probable* — it converts "I think I still hold it" into a
   provably-stale write the resource refuses (Kleppmann's fencing; the reason a TTL lock is not enough).
3. **Time-bounded.** A holder that vanishes must not freeze the shard forever; the lease expires on
   the leader's clock and a sibling acquires it.

CE has no such primitive today. Apps that need it (the games in task #5, sharded `ce-pubsub`/`ce-db`)
would each reinvent a buggy TTL lock over pubsub. This primitive is the **linearizable mutual-exclusion
substrate**: a small Raft group (the only place in the stack that runs consensus *off-chain*, at the
SDK tier — see the README's rationale for why this must not be in the trustless node) that serializes
acquire/renew/release/elect into one replicated log, and hands out fenced, time-bounded leases.

Why Raft and not the chain: PoW finality is ~10s/block and probabilistic (`primitives.md`) — useless
for a sub-second sector handoff. Why Raft and not `Merged`: mutual exclusion is fundamentally a
*single-decision-per-key* problem (a total order of grants), which is what Raft's replicated log gives
and a CRDT union cannot.

---

## 2. Plane: node vs ce-coord, and the justification

**Plane: `ce-coord` (SDK), over a new `ce-coord` Raft group engine. Zero node-plane changes** beyond
the contract-§2 `Ctx` envelope that everything rides.

The README states the principle precisely (`ce-coord/README.md`): *"the node is the trustless /
Byzantine layer. Raft and replicated state … would put a trusted-quorum consensus inside the one
component that must not have one. Keeping it at the SDK tier means a Raft group is a private agreement
among a chosen set of nodes."* CE's consensus is PoW/longest-chain over an open membership; Raft is
crash-fault-tolerant over a *closed, named* membership. Putting Raft in `ce-node` would (a) break the
open-membership trust model, (b) force every node to run a quorum it did not opt into, and (c) violate
the litmus test (`primitives.md`): a lock is product semantics, not a byte/key/coin mechanism a
non-participating peer must enforce.

Every Raft message is one of the three generic verbs the node already exposes (`ce-rs`):

- `AppendEntries` + heartbeat + `RequestVote` → `publish`/`subscribe` on the group's gossip topic (the
  same fan-out `Replicated` uses for its op log).
- log catch-up for a lagging follower → directed `request`/`reply` to the leader (identical to
  `Replicated`'s `CatchUp` path, `replicated.rs:255`).

The one externally-visible mechanism — the **fencing token** — is enforced by the **resource server
app** (e.g. the game's sector server, `ce-db`'s storage node), *not* the node: the resource server
remembers the highest token it has applied and refuses lower ones (§5). That is app policy on app
state; the node has no business in it. So nothing here earns a node-plane change against the contract
§1 closed list, and the design adds no `RpcRequest` variant.

---

## 3. Public API

### 3.1 Rust SDK (`ce-coord`)

A new module `ce-coord/src/election.rs` (the Raft engine) plus `ce-coord/src/lock.rs` (the
lock/lease/election typed API over it). The engine reuses `Replicated`'s ordering/catch-up machinery;
the README promised it "slots in here without changing collection call sites."

```rust
// ce-coord/src/election.rs — the Raft group engine (private membership, crash-fault-tolerant).

/// A Raft replica group named (ns, group). Members are a fixed, capability-gated set of NodeIds.
/// Cheap to clone; one engine drives one group. Built over the same Coord pump as Replicated.
pub struct RaftGroup { /* ... */ }

/// Monotonic Raft term + log index pair. The fencing token (§5) is derived from this so it is
/// globally monotone across leadership changes: a new leader's term strictly exceeds the old.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Fence { pub term: u64, pub index: u64 }   // total order = (term, index)

impl Coord {
    /// Join (or create) the Raft group `(ns, group)` with the given member set. Membership is the
    /// set of NodeIds allowed to vote/lead; clients that only acquire need NOT be members. Returns
    /// once this node has caught up to the leader's committed log. Members must each hold
    /// `lock:elect` on `Tag("raft:<ns>/<group>")` (verified by every peer via Ctx.cap).
    pub async fn raft_group(&self, ns: &str, group: &str, members: &[&str]) -> Result<RaftGroup>;
}

impl RaftGroup {
    /// Current believed leader NodeId, or None during an election. Read-only; cheap (in-memory).
    pub fn leader(&self) -> Option<String>;
    /// True iff this node is the current leader (won the latest term, lease not expired).
    pub fn is_leader(&self) -> bool;
    /// Fires on every leadership change so a singleton can start/stop work in lock-step.
    pub fn watch_leader(&self) -> tokio::sync::watch::Receiver<Option<String>>;
}
```

```rust
// ce-coord/src/lock.rs — the typed lock / lease / election API over a RaftGroup.

/// A granted lease on a named resource. Holding this value does NOT keep the lease alive — the
/// returned LeaseGuard runs a background renewer. The `fence` is the token to attach to every
/// resource write so the resource server can reject stale (zombie) writers (§5).
#[derive(Clone)]
pub struct LockGrant {
    pub name: String,
    pub holder: String,     // NodeId hex of the current holder (== this node on success)
    pub fence: Fence,       // monotone fencing token; pass to the resource server on every write
    pub expires_hlc: (u64, u32),  // informational: the HLC at which the lease lapses if not renewed
}

/// An RAII guard that auto-renews the lease in the background and releases it on drop. Exposes the
/// current fence (it advances on renewal across a leadership change) and a lost-leadership signal.
pub struct LeaseGuard { /* ... */ }
impl LeaseGuard {
    pub fn grant(&self) -> LockGrant;                       // current grant (fence may have advanced)
    pub fn lost(&self) -> tokio::sync::watch::Receiver<bool>; // fires if the lease was reassigned away
    pub async fn release(self) -> Result<()>;               // explicit early release (also on Drop)
}

impl Coord {
    /// Block until the named lock is acquired or the Ctx deadline passes. Requires lock:acquire on
    /// Tag("lock:<ns>/<name>"). Idempotent via Ctx.idem: a retry returns the SAME LockGrant/fence
    /// (Status::AlreadyApplied), never a second grant. lease_ms is the lease length on the leader's
    /// clock; the guard renews at lease_ms/3.
    pub async fn lock(&self, group: &RaftGroup, name: &str, lease_ms: u64) -> Result<LeaseGuard>;

    /// Non-blocking: acquire if free, else Status::FailedPrecondition with the current holder.
    pub async fn try_lock(&self, group: &RaftGroup, name: &str, lease_ms: u64)
        -> Result<Result<LeaseGuard, LockGrant>>;  // Ok(Err(holder_grant)) = already held

    /// Atomically acquire a SET of locks (shard ownership). All-or-nothing at the Raft level; on
    /// partial conflict returns Partial<LockGrant> and releases nothing (the caller decides).
    pub async fn lock_many(&self, group: &RaftGroup, names: &[&str], lease_ms: u64)
        -> Result<Partial<LeaseGuard>>;

    /// Stand for election as a singleton owner of `group`. Returns a guard that is "active" exactly
    /// while this node is the elected leader; watch it to start/stop the singleton. Requires
    /// lock:elect on Tag("elect:<ns>/<group>"). Sugar over raft_group(...).watch_leader().
    pub async fn elect(&self, group: &RaftGroup) -> Result<Election>;
}

pub struct Election { /* watch_leader() + is_leader() + the fence of the current term */ }
```

`Partial<T>` and `Status` are the contract §4 types (shared crate `ce-coord::status`). `Fence` is new;
everything else reuses `Coord`, `Version`, the pump, and `Ctx`.

### 3.2 TS SDK (`ce-ts`)

Mirrors the Rust shape over the same node HTTP routes the Rust pump uses (no privileged surface). A
browser/Node singleton (the games of task #5) uses the same fencing contract.

```ts
export interface Fence { term: bigint; index: bigint }            // ordered by (term, index)
export interface LockGrant { name: string; holder: string; fence: Fence; expiresHlc: [bigint, number] }

export class RaftGroup {
  leader(): string | null
  isLeader(): boolean
  onLeaderChange(cb: (leader: string | null) => void): () => void  // returns unsubscribe
}

export class LeaseGuard {
  grant(): LockGrant
  onLost(cb: () => void): () => void
  release(): Promise<void>                                         // also runs on dispose
}

export class Coord {
  raftGroup(ns: string, group: string, members: string[]): Promise<RaftGroup>
  lock(group: RaftGroup, name: string, leaseMs: number, opts?: { idem?: Uint8Array; deadlineMs?: number }): Promise<LeaseGuard>
  tryLock(group: RaftGroup, name: string, leaseMs: number): Promise<LeaseGuard | LockGrant>  // LockGrant = held by other
  lockMany(group: RaftGroup, names: string[], leaseMs: number): Promise<Partial<LeaseGuard>>
  elect(group: RaftGroup): Promise<Election>
}
```

### 3.3 Node HTTP routes + wire types

**None.** The contract §1 closed list does not include locks, and §0 rule 1 forbids a new node RPC
where the three generic verbs suffice. All traffic uses the *existing* routes the `ce-coord` pump
already drives: `POST /mesh/publish`, `POST /mesh/subscribe`, `POST /mesh/request`, `POST /mesh/reply`,
`GET /mesh/messages/stream` (`ce-rs/src/lib.rs:411-474`). The only wire types are `ce-coord`-internal
bincode structs carried as opaque `AppMessage.payload` bytes:

```rust
// ce-coord internal Raft wire (bincode), opaque to the node, carried on ce-app/<ns>/raft.*.<group>.
#[derive(Serialize, Deserialize)]
enum RaftMsg {
    /// Leader → followers: heartbeat + replicate the lock-log tail. prev_(term,index) for the
    /// consistency check; commit_index advances followers' applied state.
    AppendEntries { term: u64, leader: String, prev: Fence, entries: Vec<LogEntry>, commit_index: u64 },
    AppendAck     { term: u64, from: String, match_index: u64, success: bool },
    /// Candidate → all: standard Raft vote with the last-log fence so only an up-to-date node wins.
    RequestVote   { term: u64, candidate: String, last: Fence },
    VoteGranted   { term: u64, from: String },
    /// Catch-up reply path reuses Replicated's directed request/reply (replicated.rs CatchUp).
}

/// One committed decision in the group's log. The state machine folds these in (term,index) order.
#[derive(Serialize, Deserialize)]
enum LockOp {
    Acquire { name: String, holder: String, lease_ms: u64, idem: [u8; 16] }, // idem = exactly-once acquire
    Renew   { name: String, holder: String, lease_ms: u64 },
    Release { name: String, holder: String },
    Expire  { name: String, holder: String },                                // leader-applied on timeout
}
struct LogEntry { fence: Fence, op: LockOp, hlc: (u64, u32) }
```

`RaftMsg`/`LogOp` never reach the node as types — they are `payload` bytes signed by the node on
`publish` (subscribers verify authorship for free, `ce-rs::publish` doc), exactly as `Replicated`'s
`Entry` is today.

---

## 4. Protocol & data structures

### 4.1 Topics & RPC (contract §6 namespacing)

| Purpose | Verb | Topic / target |
|---|---|---|
| AppendEntries + heartbeat | `publish`/`subscribe` | `ce-app/<ns>/raft.append.<group>` |
| RequestVote / VoteGranted | `publish`/`subscribe` | `ce-app/<ns>/raft.vote.<group>` |
| Leader announce (fast-path read) | `publish` | `ce-app/<ns>/raft.leader.<group>` |
| Follower catch-up (log tail) | `request`/`reply` | directed to leader, topic `ce-app/<ns>/raft.catchup.<group>` |
| Client acquire/renew/release | `request`/`reply` | directed to current leader, `ce-app/<ns>/lock.req.<group>` |

A **client** that only wants a lock is *not* a Raft member: it `find_service`s (01) the group
endpoint, learns the current leader from a `raft.leader` read or a redirect, and sends a directed
`lock.req` to the leader. The leader appends a `LockOp`, waits for commit (quorum ack), then replies
with the `LockGrant{fence}`. This keeps the consensus membership small (3 or 5 nodes) while any number
of clients use it — the standard Raft client/replica split.

### 4.2 State layout

The group's replicated state machine (a `StateMachine` per `replicated.rs`, folded in `(term,index)`
order so every replica converges):

```rust
struct LockState {
    locks: BTreeMap<String, Held>,        // name -> current holder
    leader_term: u64,
}
struct Held { holder: String, fence: Fence, lease_until: Instant /*leader-monotonic*/, lease_ms: u64 }
```

`fence` for a grant = the `Fence{term,index}` of the `Acquire`/`Renew` entry that granted it. Because
Raft guarantees a strictly increasing `(term,index)` across the committed log — and a new leader's
term strictly exceeds every prior term (Raft election safety) — **`Fence` is globally monotone across
crashes and leadership changes**. That is the property fencing requires and a wall-clock TTL cannot
provide.

### 4.3 Algorithm (the lease lifecycle) and invariants

1. **Acquire.** Client → leader directed `lock.req{Acquire,name,idem}`. Leader checks
   `locks[name]`: if free or its lease has expired on the leader's monotonic clock, it appends
   `Acquire{name, holder=client, idem}` at the next `Fence`, replicates, and on commit replies
   `Ok(LockGrant{fence})`. If held by a live holder → `FailedPrecondition(holder)`. The `idem` key
   makes this exactly-once: if a committed entry already carries this `idem`, the leader returns the
   **same** fence (`AlreadyApplied`) — a retried acquire never double-grants (contract §2 dedup
   semantics, realized in the state machine).
2. **Renew.** `LeaseGuard` renews at `lease_ms/3` via directed `Renew`. A successful renew may carry a
   **new (higher) fence** if leadership changed under it; `LeaseGuard.grant()` exposes the latest. If
   the renew is rejected (lease already reassigned), the guard fires `lost()`.
3. **Expire.** The **leader** (not a timer on the holder) applies `Expire` when `now > lease_until` on
   its monotonic clock, freeing the lock for the next acquirer. Only the leader expires leases, so the
   decision is linearized; a partitioned old holder cannot un-expire itself.
4. **Release.** `Release` on drop or explicit `release()`; frees immediately.
5. **Election.** Standard Raft: a follower that misses heartbeats for the election timeout becomes a
   candidate, bumps `term`, `RequestVote` with its `last` fence; a node grants at most one vote per
   term and only to a candidate whose log is ≥ its own. A candidate with majority becomes leader and
   resumes heartbeats. Randomized election timeouts prevent split votes.

**Key invariants:**

- **(I1) Mutual exclusion:** at most one `Held` per name with a non-expired lease, because grants are
  appended to a single Raft log under a single leader per term (Raft log-matching + leader-append-only).
- **(I2) Fence monotonicity:** the fence of any grant for a name strictly exceeds every earlier grant's
  fence for that name (committed log indices strictly increase; new terms strictly increase). This is
  what the resource server relies on.
- **(I3) No double-grant under retry:** a committed `idem` is folded once; a re-acquire returns the
  recorded fence, never a fresh one.
- **(I4) Leader-only expiry:** lease expiry is a committed `Expire` op decided by the leader's clock,
  never a holder-side timer, so a paused holder cannot keep a lease the cluster believes is gone.

---

## 5. Semantics & failure modes

**Consistency: linearizable** for acquire/release/expire — they are committed Raft log entries with a
single total order. `leader()`/`is_leader()` reads are *leader-leased* (fast, may be stale by at most
one election timeout); a caller needing a strongly-consistent leadership check performs a no-op
`Renew` (a committed read). This matches the contract §4 status model: a stale `is_leader()` that then
fails to renew yields `Aborted` (retry), never silent dual-action.

**The fencing token is the safety boundary — and it is enforced by the resource, not the lock.** A
TTL lease is, by itself, *unsafe*: a holder can be paused (GC, swap, VM stall) past its lease, the lock
reassigned, and the zombie resume and write. CE makes this safe the only way it can: every grant
carries `Fence{term,index}` (I2, monotone), the holder attaches it to every write to the resource
server, and **the resource server records the highest fence it has applied per shard and rejects any
write with a lower fence** (`Status::Aborted`). This turns "I think I still hold it" into a provably
stale write the resource refuses. CE provides the monotone token and the linearized grant; the *check*
is app policy on app state (correctly, per the boundary — the node has no concept of the resource).

**Crash / partition behavior:**

- *Leader crash:* a new leader is elected within ~1 election timeout; its term strictly exceeds the
  old, so any new grants carry strictly higher fences and old in-flight writes are fenced out (I2).
- *Holder crash:* lease expires on the leader's clock; a sibling acquires with a higher fence.
- *Minority partition:* the minority side has **no quorum** → cannot commit → cannot grant or expire →
  returns `Unavailable`. The majority side continues. When the partition heals the minority catches up
  (Replicated's catch-up path) and discovers its leases were reassigned (it gets `lost()`).
- *Holder partitioned from the leader but not from the resource:* the holder's renew fails →
  `lost()` fires; if it nonetheless writes, the resource fences it (its token is now below the new
  holder's). This is the zombie case the fencing token exists for.

**What it does NOT guarantee:**

- **Not Byzantine-tolerant.** Raft is crash-fault-tolerant only; a malicious *member* of the group can
  subvert it. Membership is therefore capability-gated (`lock:elect` on `Tag("raft:…")`) to a set the
  app trusts — exactly the README's "private agreement among a chosen set of nodes." For mutual
  exclusion among mutually-distrusting parties, the trustless lever is still the chain (escrow/burn),
  not this primitive.
- **Not safe without fencing enforcement.** If the resource server ignores the fence, a paused-holder
  zombie write can corrupt state. The fence is mandatory, not advisory; the SDK makes it the only way
  to obtain a write token.
- **No liveness during quorum loss.** Lose ⌊N/2⌋+1 members and the group blocks (returns `Unavailable`)
  until quorum returns — the standard Raft availability bound, deliberately chosen over split-brain.
- **Lease length is the leader's monotonic clock, not wall time.** Clients must not assume their local
  wall clock agrees; `expires_hlc` is informational only (contract §2: HLC for causal ordering, never
  for lease safety).

---

## 6. Security & economy

**Abilities (contract §3).** `lock:acquire` / `lock:release` / `lock:elect`, scoped by
`ce-cap::Resource::Tag`:

- a client grant: `{ abilities: ["lock:acquire","lock:release"], resource: Tag("lock:ce-game/sector-7") }`
  — may lock only that sector.
- a member grant: `{ abilities: ["lock:elect"], resource: Tag("raft:ce-game/world") }` — may be a
  voting replica of that group.

These join the documented action universe for `ce-iam` wildcard expansion
(`Iam::with_action_universe`, `ce-iam/src/lib.rs:50`) but stay **opaque to `ce-cap`** (contract §0
rule 3 / `primitives.md` invariant) — the verifier only checks string membership + `Resource::is_subset_of`
+ `Caveats::is_narrower_or_equal` (`ce-cap/src/lib.rs:94,151`). Expiry rides the existing
`Caveats::not_after`. The chain travels in `Ctx.cap`; every peer verifies it before appending an op.

**Abuse / DoS bounds.** All enforced by the receiving node's contract-§11 admission, keyed by
`(from, ns, ability)`:

- **Acquire storms:** rate-limit `lock:acquire` per identity; the leader additionally bounds
  outstanding un-committed acquires per client.
- **Lease churn:** minimum `lease_ms` floor + renew-rate cap so a client cannot flood the log with
  renewals; the lock-log is compactible (Replicated snapshots, `snapshot.rs`) so a high-churn lock
  does not grow unbounded.
- **Membership abuse:** only `lock:elect`-on-`raft:` holders are admitted as voters; a non-member's
  `RequestVote` is dropped at `Ctx.cap` verification, so an outsider cannot trigger elections.
- **Topic isolation:** `ns` scoping (contract §6) means one tenant's group traffic can never reach
  another's subscribers.

**Optional payment-channel metering.** Lock acquisition on a *contended, scarce* shard (a premium game
sector, a paid singleton slot) can be priced: the leader requires a payment-channel receipt
(`ce-rs::sign_receipt`/`channel_close`, `ce-rs/src/lib.rs:539-570`) for `cumulative` covering the lease
period before committing the `Acquire`, redeemable per lease-renewal interval — pay-as-you-hold,
mirroring the heartbeat burn-pay model (`primitives.md` §7). Default is unmetered (cap-gated only);
metering is an app opt-in, never a CE requirement.

---

## 7. Composition

**Depends on (in-edges, contract §5):**

- `00`/§2 **`Ctx` envelope** — `cap` (authz), `idem` (exactly-once acquire), `deadline_ms` (blocking
  acquire bound), `hlc` (causal stamp on grants).
- `09-causal-time-idempotency-counters.md` — the idempotency dedup table backs the
  exactly-once-acquire guarantee (I3); HLC stamps the grant log.
- `01-service-registry-binding.md` — clients `find_service` the Raft group endpoint / current leader;
  group membership is advertised as a service `"<ns>/raft.<group>@1"`.
- `02-load-balancing-placement.md` — placement reads `is_leader()` to pin a singleton to exactly one
  instance and routes shard traffic to the current owner.

**Enables (out-edges):**

- `03-durable-queue.md` — a queue partition's single active owner is a `lock`/`elect`; the leader
  drains, a sibling takes over with a higher fence on its death (the queue's redelivery is the same
  lease handoff).
- `04-event-log-stream.md` — promotes a `Replicated` single-writer safely: the writer holds a
  `lock("log:<name>")`; the fence is written into each log entry so a stale ex-writer's entries are
  rejected, closing `Replicated`'s "who is the writer now?" gap (§1).
- `10-saga-workflow.md` — a saga instance owns its run via a lease; the orchestrator singleton is an
  `elect`.

---

## 8. Test plan

**Deterministic cores (unit, no mesh, in the spirit of `replicated.rs`'s in-process tests):**

- *State machine fold:* feed a fixed `Vec<LogEntry>` of `Acquire/Renew/Release/Expire` and assert the
  resulting `LockState` is a pure function of the entry *order* (mutual exclusion I1, fence
  monotonicity I2). Property test: any interleaving of acquires for distinct names commutes; two
  acquires for the *same* name never both yield a `Held` (the second is `FailedPrecondition`).
- *Fence monotonicity (I2):* generate random committed logs spanning multiple terms; assert every
  successive grant for a name has a strictly greater `Fence` under the `(term,index)` `Ord`.
- *Idempotent acquire (I3):* apply the same `Acquire{idem}` twice; assert one `Held`, same fence,
  second returns `AlreadyApplied`.
- *Raft safety lemmas:* election-safety (one leader per term), log-matching, leader-completeness —
  property tests over a deterministic in-memory Raft driving the same `LockState`.

**Integration (over `ce-coord/src/testkit.rs`'s `MockNode` / in-process mesh):**

- 3-member group, drive acquire/renew/release across nodes via the real `Coord` pump; assert exactly
  one holder at all times (use `within(...)`, `testkit.rs:412`, to await convergence).
- *Partition test:* the testkit's delivery layer can drop/isolate a node (`testkit.rs` drop path);
  isolate the leader, assert (a) a new leader is elected, (b) new grants carry a strictly higher fence,
  (c) the minority side returns `Unavailable`, (d) on heal the old holder gets `lost()`.
- *Zombie test:* pause a holder's renewer past `lease_ms`, let a sibling acquire, then have the zombie
  issue a write carrying its stale fence to a mock resource server; assert the resource rejects it
  (`Aborted`) — the end-to-end fencing guarantee.

**Needs a live multi-node mesh (Hetzner/desktop, `ce-deploy` style):**

- Real network partition + relay/DCUtR reconnection: confirm election timeouts and catch-up behave
  under real latency and that a NAT-traversal hiccup does not cause a false election.
- Throughput/latency of acquire-under-contention with N real clients and a 5-member group; verify the
  log compaction (snapshot) keeps a hot lock's log bounded.

---

## 9. Worked example: a sharded game backend (task #5)

A multiplayer game splits the world into 64 **sectors**; each sector's authoritative simulation must
run on **exactly one** backend node (double-simulation = duplicated loot, desync). On top of CE:

1. The game runs a **5-member Raft group** `("ce-game/prod", "world", [n1..n5])`; each member holds
   `lock:elect` on `Tag("raft:ce-game/prod/world")`. Members are the game's own trusted backend nodes
   (private agreement — exactly the README's model).
2. A backend node claims a sector: `coord.lock(&group, "sector-7", 3_000)` → `LeaseGuard` with
   `fence = {term:4, index:128}`. It begins simulating sector 7 and stamps **every** state write to the
   sector store (a `ce-db` shard, 04) with that fence.
3. Node owning sector 7 is paused by a long GC. Its renewer misses; after 3s the **leader** commits
   `Expire{sector-7}`. Node n3 acquires sector 7 with `fence = {term:4, index:140}` (strictly higher,
   I2) and resumes simulation.
4. The paused node wakes and flushes a buffered write to the sector store carrying its stale
   `{term:4,index:128}`. The store has already applied `{term:4,index:140}`, so it **rejects** the
   write (`Aborted`) — no double-write, no desync. The zombie's `LeaseGuard.lost()` has also fired, so
   its game loop stops.
5. A "boss arena" premium sector is metered: acquiring it requires a payment-channel receipt covering
   the lease (the §6 pay-as-you-hold path), so contention for a scarce shard is priced, not free.

The singleton case (one **matchmaker** for the whole game) is `coord.elect(&group)`: whichever member
is Raft leader runs the matchmaker; on its crash a new leader takes over within an election timeout,
and `watch_leader()` flips the old/new instances off/on in lock-step. Placement (02) reads
`is_leader()` to route lobby traffic to the live matchmaker.

The same shapes serve `ce-pubsub` (one active owner per queue partition, 03) and `ce-db` (one primary
per collection, 04) — the fence is what makes each handoff safe rather than merely probable.

---

## 10. Effort & minimal first slice

**Effort: L.** The Raft engine is the bulk (election + log replication + catch-up + snapshot reuse +
the safety lemmas under test); the lock/lease/election API on top is small. It reuses `Replicated`'s
ordering/catch-up/snapshot machinery (`replicated.rs`, `snapshot.rs`) and the `Coord` pump, which
removes most of the transport and persistence work. Fencing enforcement is app-side (a few lines per
resource server) and needs only the `Fence` type + docs.

**Minimal first slice (S, ships value immediately):**

1. `Fence{term,index}` + the `LockState` state machine + its deterministic unit/property tests (§8
   cores) — no networking. This alone is reviewable and proves I1–I3.
2. A **single-member group** (`members=[self]`, degenerate Raft = local linearizer): implement
   `lock`/`try_lock`/`release` + `LeaseGuard` auto-renew over the existing `Replicated` writer path,
   so a single owner already gets fenced, time-bounded leases and the fencing contract is exercised
   end-to-end against a mock resource server (the §8 zombie test).
3. Then add multi-member election + AppendEntries/RequestVote over `publish`/`subscribe` to reach
   crash-fault tolerance, and `lock_many`/`elect` sugar.

This sequences risk: the fencing *contract* and the lock API land and get adopted (games, 03/04) on the
1-member path while the consensus core is built and hardened behind the same call sites — exactly the
"slots in without changing collection call sites" promise from the `ce-coord` README.
