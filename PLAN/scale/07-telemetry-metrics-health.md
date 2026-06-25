# 07 — Telemetry: metrics / SLIs & health

**Status:** implementation-ready design. Conforms to `00-architecture.md` (the contract wins on any
disagreement). Ground truth cited inline: `ce-rs/src/lib.rs`, `ce-coord/src/{lib.rs,merged.rs}`,
`ce/crates/ce-node/src/lib.rs`, `ce/crates/ce-node/src/api.rs`, `ce/crates/ce-mesh/src/lib.rs`,
`ce/docs/primitives.md`. Sibling designs: `05-resilient-rpc.md`, `06-distributed-tracing.md`,
`01-service-registry-binding.md`, `02-load-balancing-placement.md`.

## Conformance block (architecture §7)

1. **Plane** — split, exactly as architecture §0.1 row 07: **node export** (the local node already
   tallies inbound `AppRequest`/reply outcomes and broadcasts capacity every 60s —
   `ce/crates/ce-node/src/lib.rs:2211` `capacity_broadcast_loop`; we extend that signal with
   self-observed counters) plus **coord aggregation** (a `ce-coord` client that folds every peer's
   exported SLIs into an `Atlas`-shaped view and serves per-app dashboards). The node export is a
   *widening of an existing broadcast and an existing `/atlas` read*, not a new RPC — it rides the
   CEP-1 capability list exactly as the self-tags already do (`lib.rs:2238-2242`). The app-level SLI
   aggregation (per-`ns`, per-ability histograms) is pure `ce-coord` over pubsub + `Merged`. **No new
   `RpcRequest` variant.**
2. **Abilities** — reserves `metrics:write` (export app-level SLIs into the mesh) and `metrics:read`
   (read a dashboard / the aggregated SLI view), per architecture §3. Resource-scoped by
   `ce-cap::Resource::Tag("metrics:<ns>")`, so a grant can say "may read `ce-db/acme` dashboards
   only" or "this exporter may publish SLIs only under `ce-db/acme`". Node-intrinsic counters
   (CPU, mem, RTT, inbound request rate) ride the existing capacity broadcast and need **no cap** —
   they are already public (`/atlas`, `/netgraph` are unauthenticated — `ce-rs/src/lib.rs:200,213`).
3. **Envelope use** — *reads* `Ctx.ns` (the bucket key for every SLI — §6), `Ctx.deadline_ms` and the
   reply `Status` (to classify a call as success / error / timeout — §4), `Ctx.trace` (to exemplar-
   link a slow/errored sample to its trace in 06). *Writes* nothing new onto `Ctx`: telemetry is a
   pure *observer* of the envelope plus a separate pubsub export channel. Adds **no parallel header**.
4. **Status & partial failure** — a `metrics:read` of an N-node aggregate returns
   `Partial<NodeSli>` (architecture §4): the dashboard states *"SLIs from 17 of 20 reporting peers;
   3 `Unavailable`"* and never collapses a partial scrape to a single number. Export failures
   (`metrics:write` rejected) return `Unauthorized`; an unknown dashboard returns `NotFound`.
5. **Dependencies** — in-edges (architecture §5): the `Ctx` envelope (keystone), **05 resilient RPC**
   and **06 distributed tracing** (the call outcomes + trace ids it samples; `05-resilient-rpc.md`,
   `06-distributed-tracing.md`), and the existing `atlas`. It **enables 01** (the health/readiness
   signal `01-service-registry-binding.md` filters on) and **02** (the least-loaded signal
   `02-load-balancing-placement.md` selects on). It is built *after* 05/06 and *before* 01/02 — the
   architecture §5 build order ("07 unblocks 01").
6. **Namespacing** — the export pubsub topic is `ce-app/<ns>/sli` (extends `APP_TOPIC_PREFIX =
   "ce-app/"` — architecture §6); the aggregate `Merged` replica key is `(ns, "sli")`; every counter
   bucket is keyed `(ns, ability)`. Node-intrinsic capacity stays on the existing CEP-1 broadcast
   keyed by `NodeId` (the current `Atlas` — `ce/crates/ce-node/src/lib.rs:56`).
7. **Boundary check** — no app policy enters the node: the node exports only generic, self-observed
   counters (request count, error count, latency buckets, CPU/mem) keyed by opaque `(ns, ability)`
   strings; "what is a good SLO", "is this app healthy", "which dashboard" are all
   `ce-coord`/app decisions. Stranger code never bypasses the local node — every SLI export and every
   dashboard read goes through `ce-rs`, the local node authenticates the sender
   (`AppMessage.from` is node-verified — `ce-rs/src/lib.rs:732`) and verifies `Ctx.cap`.

---

## 1. Purpose & the at-scale problem

Today the only observability primitive is the capacity atlas: every node broadcasts
`{cpu, mem, running_jobs, tags}` every 60s over CEP-1 and peers cache it
(`ce/crates/ce-node/src/lib.rs:2211-2261` `capacity_broadcast_loop`,
`parse_capacity_signal:2263`), exposed as `GET /atlas` → `Vec<AtlasEntry>`
(`ce-rs/src/lib.rs:200,632`). Per-peer smoothed RTT exists in `GET /netgraph` → `Vec<NetEdge>`
(`ce-rs/src/lib.rs:213,617`). That is **machine capacity**, not **application health**. It tells you a
host has 8 free cores; it tells you nothing about whether `ce-db/acme`'s p99 read latency is 4ms or
4s, whether `match-host@2` is erroring 30% of requests, or whether a queue consumer is falling behind.

At scale — many interdependent apps, dozens of nodes, concurrent traffic — every app re-invents the
same three things, badly:

- **The golden signals** (rate, errors, duration — the RED method) per app, per operation. `ce-query`
  needs to know `ce-db`'s error rate to decide whether to fail fast or retry; `02` placement needs the
  *least-loaded* instance, not the least-loaded *machine*; `05`'s circuit breaker needs a real error
  rate, not a guess. Without a shared export format each app ships a different ad-hoc counter and none
  compose.
- **A health/readiness signal** the registry (01) and the load balancer (02) can consume. A
  crashed-but-not-yet-DHT-expired instance, a warming-up cache, a draining shard — all look identical
  through `find_service`. 01 explicitly depends on this doc for "is this instance ready right now".
- **Aggregation without a central collector.** A single Prometheus server is a trust bottleneck and a
  SPOF — antithetical to CE (`primitives.md`: no lighthouse authority). The aggregate must be a
  leaderless fold of each node's self-reported counters, converging like the atlas does, degrading
  (never lying) under partition.

The concurrency problem this solves is **observing a moving fleet without a coordinator**: instances
churn, counters increment under concurrent load on each node independently, and many readers scrape
the aggregate at once. That is precisely a per-writer-log multi-writer CRDT of metric snapshots
(`ce-coord/src/merged.rs`) keyed by `(ns, ability)`, gossiped over pubsub and folded the same way the
atlas folds capacity. CE already has every piece: a 60s self-broadcast loop to widen, `Status` as a
machine-readable success/error oracle (architecture §4), `Ctx.trace` to attach exemplars (06), and
`Merged` to converge the fold. 07 assembles them into one telemetry layer.

---

## 2. Plane: node vs ce-coord, and the justification

| Concern | Plane | Where | Why |
|---|---|---|---|
| Node-intrinsic counters (inbound request rate, reply `Status` mix, deadline-exceeded count, per-`(ns,ability)` p50/p95/p99 latency of handled `AppRequest`s) | **node export** | `ce-node` inbound dispatch tallies; widened `capacity_broadcast_loop` emits | only the node sees *every* inbound call's outcome and latency; a library that runs *inside* one app cannot observe calls to apps it does not run. This is the same reason 05's dedup/deadline live in the node (architecture §1). |
| Self CPU / mem / running-jobs | **node export** | already in `capacity_broadcast_loop` (`lib.rs:2221-2236`) | unchanged; this is the existing atlas. |
| App-level SLIs (custom counters/histograms an app defines: cache-hit ratio, queue lag, shard size) | **coord export** | `ce-rs::Metrics` registry → publishes `ce-app/<ns>/sli` | product semantics — *which* SLIs and *what they mean* is app policy (`primitives.md` litmus: product semantics → app). The node must not learn what "cache-hit ratio" is. |
| Aggregation / fold across peers | **coord** | `ce-coord::SliAtlas` (a `Merged`) | a leaderless convergent fold is a coordination primitive, already a `ce-coord` engine; nothing for the node to enforce. |
| Health / readiness contract | **coord** | `ce-rs::Health` → exported as one reserved SLI | "healthy"/"ready"/"draining" is an app-defined state machine 01 consumes; CE only carries the opaque enum byte. |
| Per-app dashboards | **coord/app** | `ce-coord::SliAtlas::dashboard()` + an app frontend | pure read-side rendering over the aggregate; no node involvement. |

**Justification.** Two facts decide the split. (1) The node is the *only* vantage point that observes
every inbound call's latency and `Status` regardless of which app it belongs to — so the **generic
RED counters** must be exported by the node, exactly as it already exports capacity. But (2) *which*
custom SLIs exist, *what* "healthy" means, and *how* a dashboard looks are product policy the node
must stay ignorant of (`primitives.md`). So the node widens an existing broadcast with a small, fixed,
generic counter set; everything app-specific is a `ce-coord` client publishing opaque payloads over
the existing `ce-app/<ns>/sli` pubsub topic and folding them with `Merged`. **No new node RPC**: the
node-intrinsic counters ride the CEP-1 capability list (the same mechanism self-tags use today —
`lib.rs:2238`) and surface through a widened `/atlas`; app SLIs ride `publish`/`subscribe`
(`ce-rs/src/lib.rs:436,443`). The litmus (architecture §0 note 1) is satisfied: the node earns its
delta only because it must observe what no app can.

---

## 3. Public API

### 3.1 Node export — widened capacity signal + `/atlas`

The node's inbound dispatch already routes every `AppRequest` and records its reply. We add a
per-`(ns, ability)` tally and a latency histogram in `ce-node`, and emit them on the existing 60s
broadcast as extra CEP-1 capabilities (no wire-format change — the capability list is already
extensible, `lib.rs:2233-2242`). `parse_capacity_signal` (`lib.rs:2263`) gains the inverse parse.

New fields on the existing `PeerCapacity` (`ce/crates/ce-node/src/lib.rs:42`) and its SDK mirror
`AtlasEntry` (`ce-rs/src/lib.rs:632`) — additive, `#[serde(default)]`, old nodes omit them:

```rust
// ce/crates/ce-node/src/lib.rs — PeerCapacity gains node-intrinsic RED summaries.
pub struct PeerCapacity {
    pub cpu_cores: u32,
    pub mem_mb: u32,
    pub running_jobs: u32,
    pub last_seen_secs: u64,
    pub tags: Vec<String>,
    /// Node-intrinsic golden signals over the last broadcast window (generic, not app-specific):
    /// total inbound AppRequests handled, of which errored (reply Status != Ok), and the latency
    /// distribution as fixed log-scale bucket counts. Keyed nowhere here — this is the WHOLE-NODE
    /// roll-up; per-(ns,ability) detail rides the ce-coord SLI pubsub (§3.2), not the atlas.
    #[serde(default)]
    pub rps: u32,                 // requests handled / window
    #[serde(default)]
    pub err_rps: u32,             // of those, reply Status in {Internal, Unavailable, DeadlineExceeded, ResourceExhausted}
    #[serde(default)]
    pub lat_buckets: Vec<u32>,    // 12 fixed le-buckets: [1,2,4,8,16,32,64,128,256,512,1024,+inf] ms
}
```

`GET /atlas` (`ce/crates/ce-node/src/api.rs:1183` `get_atlas`, `ce-rs/src/lib.rs:200`) returns these
unchanged in shape; `AtlasEntry` mirrors them. No new route.

`Ctx.deadline_ms`/`Status` source: the node already classifies replies for 05's deadline abort
(architecture §1); 07 just increments counters on the same path. The histogram is a 12-element fixed
`le`-bucket counter (Prometheus-compatible), never floats on the wire (architecture invariant:
integers; `primitives.md` "integers, never floats" — though these are off-chain, we keep the
discipline so buckets are deterministic).

### 3.2 Rust SDK — `ce-rs::Metrics` (exporter) + `ce-coord::SliAtlas` (aggregator)

```rust
// ce-rs/src/metrics.rs  (new module; re-exports Ctx/Status from ce-mesh)

/// An app-side metric registry. Counters/gauges/histograms an app defines, exported as one
/// SLI snapshot per window over ce-app/<ns>/sli. Pure client of `publish` (ce-rs/src/lib.rs:443).
pub struct Metrics { /* ns, CeClient, registry */ }

impl Metrics {
    /// Open a registry for one namespace. `ns` keys every export bucket (architecture §6).
    pub fn new(ce: CeClient, ns: &str) -> Self;

    /// A monotonic counter (rate/throughput/error count). `name` is opaque (e.g. "cache_hits").
    pub fn counter(&self, name: &str) -> Counter;
    /// A point-in-time gauge (queue depth, shard size, open connections).
    pub fn gauge(&self, name: &str) -> Gauge;
    /// A latency/size histogram with fixed le-buckets (defaults to the §3.1 12-bucket ms scale).
    pub fn histogram(&self, name: &str, buckets_le: &[u64]) -> Histogram;

    /// Convenience: time + classify one outbound call by its `Status` (architecture §4). Records
    /// into the reserved `rpc_duration_ms` histogram + `rpc_errors` counter, tagged by ability.
    pub fn observe_call(&self, ability: &str, status: &Status, elapsed: Duration);

    /// Snapshot every metric into one `SliSnapshot` and publish it to `ce-app/<ns>/sli`. Call on a
    /// timer (default 10s). Requires `metrics:write` on Resource::Tag("metrics:<ns>") in Ctx.cap.
    pub async fn flush(&self) -> Result<()>;

    /// Run `flush` on an interval until dropped (spawns a task). The normal way to wire it.
    pub fn spawn_flusher(&self, every: Duration) -> FlushHandle;
}

/// One node's exported SLI snapshot for one window. Wire type, serde+bincode, the pubsub payload.
#[derive(Clone, Serialize, Deserialize)]
pub struct SliSnapshot {
    pub ns: String,                       // == Ctx.ns
    pub node: [u8; 32],                   // exporting NodeId (also AppMessage.from, node-verified)
    pub window_end_ms: u64,               // unix-ms; the snapshot's right edge (also the merge key)
    pub counters: Vec<(String, u64)>,     // (name, cumulative value)
    pub gauges:   Vec<(String, i64)>,
    pub histos:   Vec<(String, Histo)>,   // (name, fixed-bucket histogram)
    /// Optional exemplar: a (slow or errored) sample's trace id, linking this SLI to 06.
    pub exemplar: Option<[u8; 16]>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Histo { pub le_ms: Vec<u64>, pub counts: Vec<u64>, pub sum: u64, pub n: u64 }
```

```rust
// ce-coord/src/sli.rs  (new module; a thin MergeMachine over the existing Merged engine)

/// Leaderless aggregate of every peer's SLI snapshots for one namespace. A `Merged<SliState>`
/// (ce-coord/src/merged.rs): each exporting node is a writer; the merge key is (node, window_end_ms)
/// so snapshots are deduplicated and folded in a canonical order on every replica (merged.rs:57-70).
pub struct SliAtlas { inner: Merged<SliState> }

impl SliAtlas {
    /// Subscribe to ce-app/<ns>/sli and start folding. `peers` seeds the writer set; `add_writer`
    /// (merged.rs:177) follows newly-seen exporters discovered via the snapshot's `node`.
    pub async fn open(coord: &Coord, ns: &str, peers: &[String]) -> Result<SliAtlas>;

    /// Current per-node, per-metric view. Stale nodes (window_end older than `staleness`) are
    /// flagged, not dropped — a partition degrades, never lies (architecture §4).
    pub fn snapshot(&self) -> Partial<NodeSli>;

    /// Roll the whole namespace up: summed rate, weighted error ratio, merged-quantile latency
    /// (q over the summed bucket counts — exact for fixed buckets, no float quantile estimation).
    pub fn rollup(&self) -> NsRollup;

    /// Fires whenever any peer's snapshot lands (merged.rs:273 `watch`). Dashboards subscribe.
    pub fn watch(&self) -> tokio::sync::watch::Receiver<u64>;

    /// Render a dashboard view (per-ability RED + custom metrics + health) for a UI/JSON endpoint.
    pub fn dashboard(&self) -> Dashboard;
}

/// Reserved health/readiness SLI consumed by 01/02. Exported as a gauge `__health` in every snapshot.
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum Health { Starting = 0, Ready = 1, Degraded = 2, Draining = 3, Unhealthy = 4 }

/// App-side health reporter. Sets the reserved `__health` gauge; `ce-rs::Metrics::flush` carries it.
pub struct HealthReporter { /* ... */ }
impl HealthReporter {
    pub fn set(&self, h: Health);
    /// Bind a readiness probe: a closure the flusher calls each window to compute Health.
    pub fn with_probe(self, probe: impl Fn() -> Health + Send + Sync + 'static) -> Self;
}
```

`SliState` is the `MergeMachine` (`ce-coord/src/merged.rs:57`): `Op = SliSnapshot`,
`Key = (NodeId, u64)` (node, window_end_ms — a strict total order, distinct per snapshot, exactly the
`MergeKey` contract at `merged.rs:43-47`), `apply` overwrites that node's latest snapshot. The fold is
a pure function of the snapshot *set*, so every reader converges identically — the same guarantee the
atlas relies on.

### 3.3 TS SDK — `ce-ts`

```ts
// @ce-net/metrics — mirrors ce-rs::Metrics; pure client of the node HTTP API.
class Metrics {
  constructor(ce: CeClient, ns: string);
  counter(name: string): Counter;
  gauge(name: string): Gauge;
  histogram(name: string, bucketsLeMs: number[]): Histogram;
  observeCall(ability: string, status: Status, elapsedMs: number): void;
  flush(): Promise<void>;                 // POST /mesh/publish to ce-app/<ns>/sli
  spawnFlusher(everyMs: number): FlushHandle;
}

class HealthReporter { set(h: Health): void; withProbe(p: () => Health): HealthReporter; }
enum Health { Starting, Ready, Degraded, Draining, Unhealthy }

// Read side (dashboards): mirrors ce-coord::SliAtlas over the SSE pump.
class SliAtlas {
  static open(coord: Coord, ns: string, peers: string[]): Promise<SliAtlas>;
  snapshot(): Partial<NodeSli>;
  rollup(): NsRollup;
  dashboard(): Dashboard;
  onChange(cb: () => void): () => void;   // ce-coord SSE watch
}

// Node-intrinsic atlas (already exists) gains the RED fields:
interface AtlasEntry { /* ...existing... */ rps?: number; errRps?: number; latBuckets?: number[]; }
```

### 3.4 Node HTTP routes & wire types

- **No new route.** `GET /atlas` (`api.rs:1183`) returns the widened `AtlasEntry` (§3.1). App SLIs use
  the existing `POST /mesh/publish` + `POST /mesh/subscribe` (`api.rs:2099,2098`;
  `ce-rs/src/lib.rs:443,436`) on topic `ce-app/<ns>/sli`.
- The only node-plane code change is in inbound dispatch (count + time handled requests) and
  `capacity_broadcast_loop` / `parse_capacity_signal` (emit/parse the three RED summary fields). Both
  are widenings of existing functions, not new endpoints — honoring architecture §1 ("no new ad-hoc
  node RPCs").

---

## 4. Protocol & data structures

### 4.1 Topics / RPC used

| Channel | Mechanism | Carries |
|---|---|---|
| Node-intrinsic RED + capacity | CEP-1 capacity broadcast (existing, `lib.rs:2245`), 60s | `rps`, `err_rps`, `lat_buckets` as extra `Capability{name,version}` entries (`"rps"`, `"err_rps"`, `"lat0".."lat11"`), parsed back in `parse_capacity_signal` (`lib.rs:2263`) |
| App-level SLIs | gossip `ce-app/<ns>/sli` via `publish`/`subscribe` (`ce-rs/src/lib.rs:443,436`), 10s | bincode `SliSnapshot` |
| Aggregate fold | `ce-coord::Merged<SliState>` (`ce-coord/src/merged.rs`) over the per-writer logs of `/sli` snapshots | converged `SliState` |

No `RpcRequest` variant is added. Reading a remote node's dashboard (`metrics:read`) when not
subscribed is a directed `request` on topic `ce-app/<ns>/sli-pull` answered by `reply`
(`ce-rs/src/lib.rs:450,471`) — a generic verb, not a node RPC.

### 4.2 State layout

- **Node (per node):** a `DashMap<(Ns, Ability), Window>` of rolling counters, reset each broadcast
  window. `Window = { count, errors, lat_buckets: [u32;12] }`. Bounded: at most `MAX_NS_ABILITY`
  (e.g. 4096) keys; eviction is LRU on least-recently-incremented (a generic anti-cardinality-bomb
  guard — see §6). Whole-node roll-up (sum across keys) is what rides the atlas; the full keyed detail
  is the app's job to export via `Metrics`.
- **Exporter (`ce-rs::Metrics`):** an in-process registry of counters/gauges/histograms; `flush`
  snapshots → `SliSnapshot` → `publish`.
- **Aggregator (`ce-coord::SliAtlas`):** a `Merged<SliState>`; one writer log per exporting node
  (`merged.rs:76` `WriterLog`), keyed `(node, window_end_ms)`. `read` folds the union (`merged.rs:253`).

### 4.3 Algorithms & key invariants

1. **Latency histogram (deterministic, integer).** Each handled request's elapsed ms is bucketed into
   one of 12 fixed `le` buckets `[1,2,4,8,…,1024,+inf]` and the bucket counter incremented. Quantiles
   are computed at read time from cumulative bucket counts — exact to bucket resolution, no float
   estimation, identical on every reader. *Invariant: bucket boundaries are a compile-time constant;
   no per-app boundaries on the node path* (app histograms set their own boundaries in `Histo.le_ms`).
2. **Convergent aggregation.** `SliState` folds the snapshot set in `(node, window_end_ms)` order
   (`merged.rs:57-70`). *Invariant: last-snapshot-wins per node* — `apply` keeps only the highest
   `window_end_ms` per `node`, so the fold is a pure function of the set and every replica converges
   (the `MergeMachine` guarantee, `merged.rs:49-53`). No leader, no quorum.
3. **Rate from cumulative counters.** Counters are cumulative (monotonic); rate = Δcounter / Δwindow
   computed at the reader from two consecutive snapshots of the same `node`. *Invariant: a missed
   snapshot widens the window but never double-counts* — Δ over cumulative values is gap-safe.
4. **Health derivation.** `Health` is the reserved `__health` gauge in each snapshot; 01 reads the
   *latest non-stale* snapshot's `__health`. *Invariant: staleness ⇒ `Unhealthy` for consumers* — a
   node whose newest `window_end_ms` is older than `staleness` is treated as `Unhealthy` by 01/02, so
   a silent crash fails closed (never served as healthy).
5. **Exemplar linkage.** When a window contains an errored or > p99 sample, its `Ctx.trace` (06) is
   stamped into `SliSnapshot.exemplar`, so a dashboard spike one-clicks to the trace. *Invariant:
   exemplar is best-effort and optional* — never required for the SLI to be valid.

---

## 5. Semantics & failure modes

- **Delivery:** SLI export is **gossip, at-most-once, lossy by design** (it rides `publish`, which is
  gossipsub — `ce-rs/src/lib.rs:443`). A dropped snapshot is recovered by the next window; cumulative
  counters make loss harmless to rate computation (§4.3-3). Node-intrinsic RED rides the same lossy
  60s capacity broadcast as today's atlas.
- **Ordering:** none required. The aggregate is a fold of a *set* keyed by `(node, window_end_ms)`
  (`merged.rs`); arrival order is irrelevant, which is the whole point of using `Merged`.
- **Consistency:** **eventually consistent, monotone-per-node**. Every reader that has seen the same
  snapshot set computes the same rollup (deterministic fold). Two readers mid-flight may differ by the
  in-flight windows; they converge as gossip propagates. **It is not linearizable and makes no claim
  to be** — telemetry is an observability signal, not a coordination decision.
- **Partition:** the aggregate **degrades, never lies**. A peer behind a partition stops contributing
  fresh snapshots; its last snapshot ages past `staleness` and is flagged stale (and treated
  `Unhealthy` by 01/02). `snapshot()` returns `Partial<NodeSli>` naming the reachable vs unreachable
  exporters (architecture §4) — the reader always knows *whose* data it is missing.
- **Crash:** a crashed exporter simply stops emitting; its `__health` ages out → `Unhealthy`. No
  cleanup needed (the same model as the atlas dropping a silent peer via `last_seen_secs`,
  `ce-rs/src/lib.rs:637`).
- **Clock skew:** windows are right-edged by the *exporter's* wall clock (`window_end_ms`); cross-node
  rate comparison tolerates skew because each node's rate is computed from *its own* consecutive
  snapshots. The aggregate never subtracts one node's counter from another's.
- **What it does NOT guarantee:** exactly-once SLI delivery; a globally consistent instantaneous
  snapshot (there is no stop-the-world barrier); sub-window freshness (10s app / 60s node intrinsic);
  metric retention/history (this is a *live* view — durable history is an app over the **04 event
  log**, `04-event-log-stream.md`); cardinality safety for unbounded app label sets (the node caps its
  own keys, §6, but an app that mints unbounded gauge names degrades its *own* dashboard only).

---

## 6. Security & economy

- **Abilities (architecture §3):** `metrics:write` to publish app SLIs under a namespace,
  `metrics:read` to read a dashboard/aggregate. Scoped by `Resource::Tag("metrics:<ns>")`. A grant can
  pin a tenant: "may `metrics:read` `metrics:ce-db/acme` only". Node-intrinsic atlas RED needs **no
  cap** (already public, like `/atlas`/`/netgraph`).
- **The security invariant holds:** every export/read goes through the local node, which authenticates
  the sender (`AppMessage.from`, node-verified — `ce-rs/src/lib.rs:732`) and verifies `Ctx.cap`
  authorizes `metrics:write`/`metrics:read` on the resource before accepting/serving. A stranger
  cannot inject SLIs into another tenant's namespace (the `Tag("metrics:<ns>")` scope) nor read a
  namespace it lacks `metrics:read` for.
- **Abuse / DoS bounds:**
  - *Cardinality bomb* — an exporter spamming distinct `(ns, ability)` or metric names. The node caps
    its own keyed counter map at `MAX_NS_ABILITY` with LRU eviction (§4.2); app-side, `SliAtlas` caps
    metrics-per-node and total nodes, dropping the lowest-traffic series. Bounded memory either way.
  - *Snapshot flood* — a peer publishing `/sli` faster than the window. The publish path is already
    rate-limited by **11 flow control** (`00-architecture.md` §1; per-`(from, ns, ability)` token
    bucket) — telemetry adds no new admission logic, it inherits 11's. A flooding exporter is throttled
    at the node with `ResourceExhausted` (architecture §4).
  - *Forged SLIs* — impossible to attribute to another node: `SliSnapshot.node` must equal the
    node-verified `AppMessage.from`; a mismatch is dropped by the aggregator. (A node can lie about its
    *own* SLIs — telemetry is self-reported; 01/02 cross-check against the node-intrinsic atlas RED,
    which the node computes itself, and against actual `Status` outcomes 05 sees. Self-reported health
    is advisory, never the sole gate — `primitives.md` trust gradient.)
- **Optional payment-channel metering:** a public dashboard service (an app aggregating many tenants'
  SLIs and serving a hosted UI) can meter `metrics:read` per scrape via a payment channel
  (`ce-rs/src/lib.rs:543` `channel_open`, `:551` `sign_receipt`) — e.g. a relay-style "telemetry
  backend" app charges per dashboard query. CE provides the channel; pricing is the app's policy
  (`primitives.md` boundary). Not required for the base primitive (intra-fleet telemetry is free).

---

## 7. Composition

**Depends on (in-edges, architecture §5):**

- **`Ctx` envelope** — the keystone; reads `Ctx.ns` (bucket key), `Ctx.trace` (exemplar), and the
  reply `Status`.
- **05 resilient RPC** (`05-resilient-rpc.md`) — the call outcomes (`Status`, elapsed) 07 samples; the
  node-intrinsic RED counters are tallied on the same inbound path 05's deadline abort runs on.
- **06 distributed tracing** (`06-distributed-tracing.md`) — supplies the `Ctx.trace` exemplars that
  link an SLI spike to the trace that caused it.
- **11 flow control** (`00-architecture.md` §1, primitive 11) — rate-limits the SLI export path; 07
  reuses it rather than adding admission logic.
- **04 event log** (`04-event-log-stream.md`) — *optional*: durable metric history (vs the live view)
  is an app appending `SliSnapshot`s to an event log.

**Enables (out-edges):**

- **01 service registry / binding / health** (`01-service-registry-binding.md`) — consumes the
  reserved `__health` SLI and the per-instance RED as its readiness signal (01's conformance block
  names this doc as a dependency).
- **02 load balancing / placement** (`02-load-balancing-placement.md`) — selects the *least-loaded*
  instance from per-instance `rps`/latency, not just least-loaded *machine* from the raw atlas.
- **05** closes a loop: its circuit breaker reads the real error rate 07 aggregates instead of
  guessing from local failures alone.

---

## 8. Test plan

**Deterministic unit cores (no mesh):**

- *Histogram bucketing* — `bucket(elapsed_ms)` maps to the correct fixed `le` index across boundaries
  (0, exact-edge, +inf); quantile-from-cumulative-counts is exact at bucket resolution. Pure fn.
- *`SliState` MergeMachine* — fold the same snapshot set in shuffled arrival orders ⇒ identical
  rollup (the `Merged` determinism property, `merged.rs:49-53`). Property test: any permutation of a
  snapshot multiset folds to one `NsRollup`. Last-snapshot-wins per node (`window_end_ms` ordering).
- *Rate from cumulative* — Δ over two snapshots with a dropped middle window yields correct average
  rate (gap-safe), never negative, never double-counted.
- *Health staleness* — a snapshot older than `staleness` reads as `Unhealthy` to a consumer; fresh
  `Ready` reads `Ready`. Fail-closed invariant (§4.3-4).
- *Capacity signal round-trip* — RED fields survive `capacity_broadcast_loop` →
  `parse_capacity_signal` (extend the existing `self_tags_round_trip_through_capacity_signal` test at
  `ce/crates/ce-node/src/lib.rs:2396`).
- *Cardinality cap* — exporting > `MAX_NS_ABILITY` keys evicts LRU and stays bounded.
- *Cap enforcement* — a `metrics:write` without `Resource::Tag("metrics:<ns>")` in the chain is
  rejected `Unauthorized`; a forged `SliSnapshot.node != from` is dropped (ce-cap unit test style).

**Integration / property (in-process, multi-`Coord`, no live network):** the `ce-coord` testkit
(`ce-coord/src/testkit.rs`) wires N in-process `Coord`s; assert a `Metrics::flush` from each converges
in every peer's `SliAtlas::rollup` and `Partial<NodeSli>` reflects exactly the reporting set.

**Needs a live multi-node mesh:** end-to-end over real gossip — N nodes each running a real workload
under load, exporting SLIs; assert a dashboard node's rollup matches each node's locally-observed
counters within one window, partition one node and assert it flags stale → `Unhealthy` within
`staleness`, and assert the widened `/atlas` carries `rps`/`err_rps`/`lat_buckets` for every peer.

---

## 9. Worked example — sharded game backend SLIs + cross-app exemplar

A sharded multiplayer game runs `match-host@2` across 12 nodes under `ns = "arena/prod"`. Each shard
process opens `Metrics::new(ce, "arena/prod")` and:

```rust
let m = Metrics::new(ce.clone(), "arena/prod");
let ticks = m.histogram("tick_ms", &[8,16,32,64,128]);   // game-loop duration
let players = m.gauge("players_online");
let health = HealthReporter::new(&m).with_probe(|| {
    if shard_loaded() && tick_p99() < 50 { Health::Ready } else { Health::Degraded }
});
m.spawn_flusher(Duration::from_secs(5));                  // publishes ce-app/arena/prod/sli
```

Each shard also calls `m.observe_call("rpc:call", &status, elapsed)` around every cross-shard
`request`, so per-ability RED is exported automatically.

A matchmaker node opens `SliAtlas::open(&coord, "arena/prod", &shard_ids)`. When a player asks to join,
**02 placement** reads `atlas.rollup()` to pick the shard with the lowest `players_online` gauge whose
`__health == Ready` (from 07), and **01** refuses any shard flagged stale/`Unhealthy`. A live ops
dashboard (`atlas.dashboard()`, re-rendered on `watch()`) shows per-shard tick-p99, players, and error
rate across all 12 shards — with **no central collector**: every node folds the same gossiped
snapshots.

When one shard's `tick_ms` p99 spikes, its window stamps the offending tick's `Ctx.trace` into
`SliSnapshot.exemplar`. The dashboard's spike one-clicks into **06**'s trace view, showing the slow
cross-shard `ce-db` read (an inter-app request) that caused it — telemetry (07) and tracing (06)
composed through the one `Ctx`.

---

## 10. Effort & minimal first slice

**Effort: M.** The aggregator is a thin `MergeMachine` over the existing `Merged` engine (no new
coordination machinery); the exporter is a small registry + `publish`; the only node-plane work is
widening two existing functions (`capacity_broadcast_loop`, `parse_capacity_signal`) plus an inbound
counter tally. No new RPC, no new route, no consensus change. The cardinality guard and the
quantile-from-buckets math are the only non-trivial cores.

**Minimal first slice (ships behind tests):**

1. **Node:** add the inbound per-window RED tally (whole-node roll-up only, no `(ns,ability)` keying
   yet) and emit `rps`/`err_rps`/`lat_buckets` on the existing capacity broadcast; parse them back;
   widen `PeerCapacity` + `AtlasEntry`. Extend the round-trip test at `lib.rs:2396`. This alone gives
   02 a real least-loaded signal with zero new surface.
2. **SDK:** `ce-rs::Metrics` with counter/gauge/histogram + `flush` over `ce-app/<ns>/sli`, and the
   reserved `__health` gauge + `HealthReporter`.
3. **Coord:** `ce-coord::SliAtlas` as `Merged<SliState>` with `rollup()`/`snapshot()` →
   `Partial<NodeSli>`, validated by the testkit convergence test.

Deferred to a later slice: per-`(ns,ability)` keyed node export, payment-metered hosted dashboards,
exemplar linkage to 06, and the directed `sli-pull` read path. The first slice already unblocks **01**
(health) and **02** (least-loaded) — the two consumers the build order (architecture §5) waits on.
