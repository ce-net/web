# 02 — Load Balancing & Latency-Aware Placement

**Status:** design. Conforms to `00-architecture.md` (the shared contract). Where this disagrees
with the contract, the contract wins.

Ground truth cited throughout: `ce-rs/src/locate.rs` (the existing `locate`/`call`/`Instance`/
`LocateOpts` selector), `ce-gke/src/placement.rs` (the existing pure `rank`/`score_host`/
`free_capacity` host scorer), `ce-rs/src/lib.rs` (`AtlasEntry`, `NetEdge`, `find_service`/
`advertise_service`, `beacon`, `request`, `mesh_deploy`), `ce/docs/primitives.md` §4 (the atlas).

---

## Conformance block (`00-architecture.md` §7)

1. **Plane — coord.** This is the §0.1 row 02 primitive: *"host/instance selection is a client
   decision over data the node already publishes."* It is pure `ce-coord`/`ce-rs` library code over
   three things the node already exposes: the DHT (`find_service` — owned by 01), the capacity atlas
   (`GET /atlas` → `Vec<AtlasEntry>`), and the latency graph (`GET /netgraph` → `Vec<NetEdge>`). It
   **adds no `RpcRequest` variant** — selection reads node state and then uses the generic
   `request`/`mesh_deploy` verbs. It earns no node-plane change against the §1 closed list: nothing
   here must be enforced by a peer that does not run the app. (One small, generic node read is
   *requested* — a PeerId↔NodeId correlation — see §3.4; it is a read of data the node already holds,
   not app policy.)
2. **Abilities.** Reserves `place:read` (§3 of the contract) — the ability to read atlas/SLI/latency
   inputs to a placement decision. In practice selection of *public* atlas data needs no cap (the
   atlas is already an unauthenticated local read); `place:read` exists for the case where SLI feeds
   (07) or registry health (01) are tenant-scoped. **Acting** on a placement (`request`,
   `mesh_deploy`) carries the app's own ability (`rpc:call`, or `run:invoke` for deploy) in
   `Ctx.cap` — placement never mints authority.
3. **Envelope use.** Reads nothing it must mutate; *writes* `Ctx.deadline_ms` (a selection that
   fans out across candidates shares one deadline budget) and `Ctx.idem` (a placed call is retried to
   the next candidate under the same idempotency key so failover is exactly-once). It adds **no
   parallel header** — failover/hedge metadata rides existing `Ctx` fields exactly as 05 specifies.
4. **Status & partial failure.** Returns `Unavailable` (no healthy instance / all candidates failed),
   `ResourceExhausted` (every candidate backpressured), `NotFound` (service not advertised),
   `DeadlineExceeded` (budget spent before a healthy pick answered). Multi-pick (redundancy /
   sharded broadcast) returns the contract's `Partial<T>` so the caller sees which instances took the
   call and which status each refusal carried.
5. **Dependencies.** In-edges per §5: **01 service registry/binding/health** (healthy candidate set),
   **07 telemetry/SLIs** (least-loaded signal beyond atlas `running_jobs`), **atlas** + **netgraph**
   (nearest). Enables **03 queue**, **04 log**, **08 locks** to spread work across shards/replicas.
6. **Namespacing.** A service is resolved by `service_key = "<ns>/<name>@<major>"` exactly as 01
   defines it over `find_service`/`advertise_service` (§6 of the contract). Placement holds no
   durable state of its own beyond an in-process pick cache keyed by `(ns, service_key)`.
7. **Boundary check.** Placement puts **no** app policy in the node: it is a pure function from
   (candidate set, atlas, netgraph, SLIs) to a ranked list, run inside the app; the only node touch
   is reading already-published generic data and then using the generic `request`/`deploy` verbs
   through the **local** node, which authenticates the sender and enforces the `Ctx.cap` chain — no
   stranger code bypasses the local node.

---

## 1. Purpose & the at-scale problem

When one logical service has many instances (a sharded game backend, N replicas of `ce-db`, a pool
of `ce-query` workers), a caller must answer two questions on every interaction:

- **Placement** — *where do I put a new cell?* (deploy replica K of a Deployment, spin up a new
  shard owner). This is the `ce-gke` controller's job today via `placement::rank` over the atlas.
- **Routing / load balancing** — *which existing instance do I send this call to?* This is
  `ce-rs::locate::call` today, ranking by trust + free capacity + recency with a beacon tiebreak.

At small scale either a random or round-robin pick is fine. At scale — many interdependent apps,
high concurrency — naive selection causes three concrete failures:

1. **Hot-spotting.** Round-robin ignores that one instance is already at 95% CPU; the contract's own
   `ce-gke::score_host` already penalizes load precisely to *spread, not stack* (`placement.rs:64`).
   Across thousands of calls/sec a load-blind balancer melts one shard while others idle.
2. **Latency cliffs.** A cross-region call to a far instance when a near one exists multiplies tail
   latency. `NetEdge.rtt_ms` (a smoothed EWMA RTT per peer, `ce-rs/src/lib.rs:617`) exists for this,
   but `locate.rs:23` notes it is *not yet wired* because netgraph is keyed by PeerId and selection by
   NodeId. This doc closes that gap.
3. **Backpressure blindness.** A balancer that keeps routing to a saturated instance turns a local
   overload into a cascading failure. The contract gives the signal — a callee returns
   `Status::ResourceExhausted` with `retry_after_ms` (11) — but only a backpressure-aware balancer
   *removes that instance from rotation* instead of hammering it.

The primitive: **pick the least-loaded HEALTHY instance, nearest first, skipping backpressured
ones — and place new cells the same way — as a typed, deterministic, testable library** that every
sharded/replicated app shares instead of reinventing. It unifies the two existing half-solutions
(`ce-gke::placement` for placing, `ce-rs::locate` for routing) behind one scoring core and adds the
two missing inputs: live latency and live backpressure.

---

## 2. Plane: node vs ce-coord — and why

**Plane: `ce-coord` (with the selector core promoted into `ce-rs` so non-coord apps reuse it).**

Justification, against the §0 boundary:

- Selection is a **client decision over data the node already publishes**. The node already
  advertises capacity + tags every 60s over CEP-1 (`primitives.md` §4) and serves it at `/atlas`; it
  already measures per-peer RTT and serves it at `/netgraph`. Placement consumes these; it does not
  need the node to *enforce* anything. By the litmus test (`product semantics → app`): "which of my
  shards gets this call" is product semantics, owned by the app.
- It must **not** be a node RPC. The §1 closed list admits a node-plane change only for a mechanism
  that must ride every hop or be enforced by a non-app peer (deadline, trace, dedup, admission). A
  ranking function is none of these. The node already refuses overloaded work via 11's admission
  (`Status::ResourceExhausted`); the balancer merely *reacts* to that signal client-side.
- It belongs in `ce-coord` because coordination primitives (queue 03, log 04, locks 08) need
  *typed, namespaced* placement ("spread these 64 shards across the healthy pool"), and the
  `ce-coord` pump already threads `Ctx`. But the *scoring core* is a pure function with no coordination
  state, so it lives in `ce-rs` (extending `locate.rs`) and `ce-coord` wraps it with namespace +
  registry-health + SLI feeds. This mirrors how `ce-gke::placement` is already a pure `ce-rs`-typed
  module and `ce-gke::controller` wraps it with deployment policy.

**One node-plane *read* is requested (not an RPC, not enforcement):** a generic
`peer_addrs`/correlation read so a NodeId can be mapped to its libp2p PeerId, because `/netgraph` is
PeerId-keyed (`lib.rs:619`) and the rest of selection is NodeId-keyed (`locate.rs:23` flags this as
the exact blocker). This is the node exposing data it already holds (its swarm's connected-peer
table), generic and app-free — see §3.4. It is the minimal, justified surface this primitive needs.

---

## 3. Public API

### 3.1 Rust — `ce-rs` (selector core, extends `locate.rs`)

The existing `locate.rs` `Instance`/`LocateOpts`/`locate`/`call`/`spread`/`beacon_jitter` stay. We
**extend** them with latency and backpressure inputs and a deterministic balancing strategy. Reuse:
`AtlasEntry`, `NetEdge`, `CeClient::{atlas, netgraph, find_service, history, beacon, request}` all
already exist (`ce-rs/src/lib.rs`).

```rust
// ce-rs/src/locate.rs — additive fields on the existing types.

/// How to select instances. (Existing fields kept verbatim; new fields are additive + Default-safe.)
pub struct LocateOpts {
    pub want: usize,                 // existing
    pub require_tags: Vec<String>,   // existing
    pub max_stale_secs: u64,         // existing
    pub spread_domains: bool,        // existing

    // ---- new ----
    /// Balancing strategy applied within the healthy candidate set. Default `LeastLoaded`.
    pub strategy: Balance,
    /// Weight latency in the score. Default true once netgraph correlation exists (§3.4).
    pub latency_aware: bool,
    /// Instances whose last reply was `ResourceExhausted`/`Unavailable` within this window are
    /// skipped (backpressure ejection). Default 5_000 ms. Zero disables ejection.
    pub eject_for_ms: u64,
}

/// Load-balancing strategy over the *already-filtered-healthy* candidate set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Balance {
    /// Lowest composite load (free-capacity + SLI), latency-broken. Deterministic. Default.
    #[default]
    LeastLoaded,
    /// Power-of-two-choices: sample 2 by beacon-seeded hash, take the less loaded. Spreads writes
    /// without global coordination; resists herd-on-one-host.
    PowerOfTwo,
    /// Beacon-seeded consistent hash of `key` → an instance (sticky sharding; same key, same owner
    /// while the set is stable). Used by 03/04/08 for shard ownership.
    Rendezvous,
}

/// A located, live instance with the signals used to rank it. (Existing fields kept; new additive.)
pub struct Instance {
    pub node_id: String,             // existing
    pub score: f64,                  // existing (now folds latency + load + backpressure)
    pub cores: u32,                  // existing
    pub mem_mb: u32,                 // existing
    pub tags: Vec<String>,           // existing
    pub last_seen_secs: u64,         // existing
    pub fault_domain: Option<String>,// existing
    // ---- new ----
    /// Smoothed RTT (ms) from this client to the instance, from `/netgraph`. `None` if uncorrelated.
    pub rtt_ms: Option<f64>,
    /// True if currently ejected for recent backpressure (kept in the list for visibility, ranked last).
    pub ejected: bool,
}

/// Pure selector core: given the candidate set + atlas + latency map + ejection set, rank best-first.
/// No I/O, fully unit/property testable (mirrors `ce-gke::placement::rank`). `now_secs` and the maps
/// are injected so tests are deterministic.
pub fn rank_instances(
    candidates: &[String],                    // healthy NodeIds from 01 (or `find_service`)
    atlas: &[AtlasEntry],
    rtt_by_node: &std::collections::HashMap<String, f64>,  // NodeId hex -> rtt_ms (from §3.4 correlation)
    ejected: &std::collections::HashSet<String>,           // NodeIds under backpressure cooldown
    beacon_hash: &str,
    now_secs: u64,
    opts: &LocateOpts,
) -> Vec<Instance>;

/// Consistent-hash pick: deterministic owner of `key` among `candidates`, beacon-seeded. Pure.
/// Used for sticky sharding (Balance::Rendezvous) — same key → same owner while membership is stable.
pub fn rendezvous_pick<'a>(candidates: &'a [String], key: &[u8], beacon_hash: &str) -> Option<&'a str>;

/// Locate over the mesh, latency- and backpressure-aware. Supersedes the old `locate` defaults but
/// keeps its signature; existing callers get the new behavior for free (latency_aware once correlated).
pub async fn locate(ce: &CeClient, service: &str, opts: &LocateOpts) -> Result<Vec<Instance>>;

/// Locate + send, failing over to the next-best instance and *ejecting* any instance that replies
/// `ResourceExhausted`/`Unavailable` so the next call skips it. Reuses `Ctx.idem` for safe failover.
/// Returns the first successful reply, or `Status::Unavailable` if every candidate is exhausted.
pub async fn call(
    ce: &CeClient, service: &str, topic: &str, payload: &[u8],
    opts: &LocateOpts, timeout_ms: u64,
) -> Result<Vec<u8>>;
```

`call` keeps its existing contract (locate ≥3, fail over) but now (a) skips ejected instances, (b)
on a `ResourceExhausted`/`Unavailable` reply records the instance in a per-`(ns,service)` ejection
set with a `retry_after_ms` cooldown, and (c) propagates `Ctx.idem`/`Ctx.deadline_ms` so a
failed-over retry is exactly-once and within budget (delegating retry mechanics to 05).

### 3.2 Rust — `ce-coord` (typed, namespaced placement + binding)

```rust
// ce-coord — a Balancer is a typed handle that resolves a namespaced service to a live instance and
// load-balances calls to it, refreshing health from 01 and SLIs from 07.
impl Coord {
    /// Bind to a namespaced service `"<name>@<major>"`; resolution + balancing under `self`'s ns.
    pub async fn balancer(&self, service: &str, opts: LocateOpts) -> Result<Balancer>;
}

pub struct Balancer { /* ce: CeClient, ns, service_key, opts, ejection set, pick cache */ }

impl Balancer {
    /// Pick one healthy, least-loaded, nearest instance now (no call). `None` => Status::Unavailable.
    pub async fn pick(&self) -> Result<Option<Instance>>;
    /// Sticky pick for a shard key (Balance::Rendezvous): same key → same owner while set is stable.
    pub async fn pick_for(&self, key: &[u8]) -> Result<Option<Instance>>;
    /// Balanced request: pick + send + fail over + eject-on-backpressure. Threads Ctx (idem/deadline).
    pub async fn call(&self, topic: &str, payload: &[u8], deadline_ms: u64) -> Result<Vec<u8>>;
    /// Fan-out to `want` distinct healthy instances (redundancy/quorum); returns the §4 Partial.
    pub async fn call_many(&self, topic: &str, payload: &[u8], want: usize, deadline_ms: u64)
        -> Result<Partial<Vec<u8>>>;
    /// Choose `n` hosts to PLACE new cells on (deploy targets), least-loaded + spread across domains.
    /// Wraps `ce-gke::placement::rank` semantics for the general (non-Deployment) case.
    pub async fn place(&self, spec: &PlaceReq) -> Result<Vec<String>>; // NodeId hexes, best-first
}

/// What a placement needs to fit-check + score (generalizes `ce-gke::Deployment`'s resource bits).
pub struct PlaceReq {
    pub cpu_cores: u32,
    pub mem_mb: u32,
    pub require_tags: Vec<String>,
    pub want: usize,
    pub spread_domains: bool,
}
```

### 3.3 TypeScript — `ce-ts`

Mirrors the Rust selector for browser/edge nodes (a phone running a sharded game frontend that must
pick the nearest healthy shard). Wraps the same `/atlas`, `/netgraph`, `/discovery/find/*` reads.

```ts
export type Balance = "least-loaded" | "power-of-two" | "rendezvous";

export interface LocateOpts {
  want?: number;            // default 1
  requireTags?: string[];
  maxStaleSecs?: number;    // default 120
  spreadDomains?: boolean;  // default true
  strategy?: Balance;       // default "least-loaded"
  latencyAware?: boolean;   // default true
  ejectForMs?: number;      // default 5000
}

export interface Instance {
  nodeId: string; score: number; cores: number; memMb: number;
  tags: string[]; lastSeenSecs: number; faultDomain?: string;
  rttMs?: number; ejected: boolean;
}

export class Balancer {
  static async bind(ce: CeClient, service: string, opts?: LocateOpts): Promise<Balancer>;
  pick(): Promise<Instance | null>;
  pickFor(key: Uint8Array): Promise<Instance | null>;
  call(topic: string, payload: Uint8Array, deadlineMs: number): Promise<Uint8Array>;
  callMany(topic: string, payload: Uint8Array, want: number, deadlineMs: number)
    : Promise<{ ok: [string, Uint8Array][]; failed: [string, Status][] }>; // Partial<T>
}
// Pure core, also exported for tests:
export function rankInstances(
  candidates: string[], atlas: AtlasEntry[],
  rttByNode: Record<string, number>, ejected: Set<string>,
  beaconHash: string, nowSecs: number, opts: LocateOpts): Instance[];
```

### 3.4 Node HTTP — the one new generic read (PeerId↔NodeId correlation)

`/netgraph` returns `NetEdge { peer: <PeerId hex>, rtt_ms, samples, last_seen_secs }`
(`lib.rs:617`), but the atlas/registry are NodeId-keyed. To make latency-aware selection work
(`locate.rs:23` names this exact gap), the node exposes the mapping it already holds in its swarm:

```
GET /peers   ->  [ { "node_id": "<64-hex NodeId>", "peer_id": "<libp2p PeerId>" }, ... ]
```

Wire type (serde, additive, no consensus impact):

```rust
// ce-node HTTP — read-only projection of the swarm's authenticated peer table. No new RpcRequest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerLink {
    pub node_id: String,  // CE NodeId hex (the identity used by atlas/registry/cap)
    pub peer_id: String,  // libp2p PeerId hex (the key in /netgraph)
}
```

This is a node read, not an RPC and not enforcement: the node already authenticates the PeerId↔NodeId
binding (Noise + the identity handshake, per `ce-mesh`), so it is merely surfacing a fact it holds.
The SDK joins `/peers` ⋈ `/netgraph` to build `rtt_by_node`. If `/peers` is absent (old node),
`latency_aware` degrades to `false` and selection falls back to the current load+trust score — i.e.
exactly today's `locate.rs` behavior, no regression.

No other node change. Everything else is `request`/`mesh_deploy`/`atlas`/`netgraph`/`find_service`.

---

## 4. Protocol & data structures

### 4.1 Inputs (all already published by the node / 01 / 07)

| Input | Source | Used for |
|---|---|---|
| Candidate NodeIds | 01 registry `find_service` health-filtered set (else raw `find_service`) | **healthy** set |
| `AtlasEntry{cpu_cores, mem_mb, running_jobs, last_seen_secs, tags}` | `GET /atlas` | **least-loaded** (free capacity) + tag fit + liveness |
| `NetEdge{peer, rtt_ms}` + `PeerLink{node_id, peer_id}` | `GET /netgraph` ⋈ `GET /peers` | **nearest** |
| SLI feed (queue depth, p99, inflight) | 07 telemetry, optional | **least-loaded** beyond atlas `running_jobs` |
| `retry_after_ms` on `Status::ResourceExhausted` replies | 11 admission, on the wire reply | **backpressure ejection** |
| Beacon hash | `GET /beacon` | deterministic, unsteerable tiebreak + rendezvous seed |

No new gossip topic, no new RPC, no durable state. Ejection state is in-process, per
`(ns, service_key)`, TTL'd by `retry_after_ms` (or `eject_for_ms` when the reply omits one).

### 4.2 The scoring core (deterministic, pure)

`rank_instances` extends `ce-gke::placement::score_host` + `ce-rs::locate::locate`'s scoring into one
function. Pipeline (each stage is a documented invariant):

1. **Filter — healthy & fresh & fits.** Drop NodeIds absent from the atlas (unknown/dead, per
   `locate.rs:105`), stale beyond `max_stale_secs` (`locate.rs:108`), missing a `require_tag`
   (`placement.rs:30`), or currently `ejected` (new). *Invariant: a backpressured or stale or
   tag-mismatched instance is never returned as a healthy pick.*
2. **Score — load (primary).** `free = free_capacity(entry, cpu, mem)` exactly as
   `placement.rs:38` (charge each running job one replica's footprint; saturate at zero). Load score
   = normalized free capacity minus a running-jobs penalty, monotone in free capacity (the property
   `placement.rs` already tests, `score_is_monotonic_in_free_capacity`). When an SLI feed is present
   it *replaces* `running_jobs` as the load proxy (queue depth / inflight is a truer signal than
   atlas job count). *Invariant: more free capacity / lower SLI never lowers the score.*
3. **Score — latency (secondary).** If `latency_aware` and `rtt_by_node[id]` exists,
   `lat_norm = 1 - min(rtt_ms / RTT_CEIL, 1)` (e.g. `RTT_CEIL = 250ms`). Folded with a weight below
   load so a near-but-saturated host never beats a far-but-idle one. *Invariant: among equally-loaded
   instances, the nearer one ranks first.*
4. **Tiebreak — beacon jitter.** The existing `beacon_jitter(node_id, beacon_hash)` (`locate.rs:265`)
   breaks ties reproducibly and unsteerably. *Invariant: identical-scored instances order
   deterministically given a fixed beacon — auditable, like `ce-gke` placement.*
5. **Composite.** `score = w_load·load + w_lat·lat_norm + w_trust·trust_norm + ε·jitter` with
   `w_load > w_lat > w_trust ≫ ε`. `trust_norm` reuses `locate.rs`'s on-chain delivered-work term
   (`locate.rs:118`) so a stranger instance is still de-prioritized for opaque/long work.

`PowerOfTwo`: hash `(beacon, attempt)` to sample two candidates, return the higher-scored — spreads
write load without any global coordination (classic d-choices). `Rendezvous`: `rendezvous_pick`
hashes `(node_id, key, beacon)` per candidate and returns the max — sticky owner per shard key,
stable while membership is stable, reshuffling minimally on membership change (standard HRW).

### 4.3 Failover & ejection (in `call`/`Balancer::call`)

```
pick best K (>=3) -> for each, skip if ejected ->
  send request with Ctx{ idem (stable across the failover loop), deadline_ms } ->
    Ok            -> clear any ejection for this id, return
    ResourceExhausted/Unavailable -> eject(id, retry_after_ms || eject_for_ms), try next
    other Status  -> return per §4 retryability table (don't eject on caller-fault statuses)
exhausted -> Status::Unavailable (every candidate down/exhausted) as the §4 partial-aware error
```

Because `Ctx.idem` is constant across the loop, a retried-to-a-new-instance call is deduped by 09 if
the original actually landed — failover never double-applies an effect.

---

## 5. Semantics & failure modes

**Guarantees.**
- *Healthy:* a returned pick is in the atlas, fresh within `max_stale_secs`, tag-matched, and not in
  backpressure cooldown — at *selection time*. (Liveness is eventually-consistent: the atlas is a 60s
  gossip cache, so "healthy" means "advertised healthy recently," not "healthy this instant.")
- *Least-loaded:* deterministic given the same (atlas, SLI, rtt, beacon) snapshot — same inputs →
  same ranking (reproducible/auditable, the `ce-gke` property).
- *Nearest:* among comparably-loaded instances, lower RTT ranks higher (when correlation is available).
- *Backpressure-safe:* an instance that returned `ResourceExhausted` is skipped for its cooldown, so
  the balancer drains away from overload instead of amplifying it.
- *Exactly-once failover:* failover reuses `Ctx.idem`, so retrying to another instance can't
  double-apply (delegated to 09's dedup; this primitive only guarantees it *sets* the key).

**Does NOT guarantee.**
- *Global optimality / no hot spots under racing clients.* Many uncoordinated clients reading the same
  stale atlas can converge on the same "best" host (herd). `PowerOfTwo` and beacon jitter mitigate but
  do not eliminate this; true global fairness would need a coordinator (out of scope — 11 admission is
  the real overload backstop).
- *Real-time load.* The atlas is ≤60s stale; between advertisements a host's true load drifts. SLI
  feeds (07) tighten this but it is never instantaneous.
- *Sticky session affinity* beyond `Rendezvous`'s membership-stable hashing. Membership change reshuffles
  some keys (minimally, by HRW, but non-zero).
- *Strong consistency of the candidate set.* Resolution is over the DHT (eventually consistent); a
  just-started instance may not be visible for a round, a just-died one may linger until its atlas
  entry goes stale.

**Partition / crash.**
- *Client crash:* stateless selection; ejection state is in-process and simply rebuilt on restart
  (worst case: one call to a since-recovered instance, which self-heals on first `Ok`).
- *Instance crash mid-selection:* the `request` fails → `call` ejects + fails over; the now-dead
  instance ages out of the atlas and stops being a candidate.
- *Partition:* each side selects within its visible atlas. A client isolated from all instances gets
  `Status::Unavailable` (empty candidate set) — never a false "healthy" pick.
- *Beacon unavailable:* tiebreak degrades to a stable hash of node_id (the existing
  `unwrap_or_default` path, `locate.rs:94`) — selection still deterministic, just unseeded.

---

## 6. Security & economy

- **ce-cap.** `place:read` (§3) gates reading *non-public* selection inputs (tenant-scoped SLI feeds
  from 07, or a private registry view from 01); the public `/atlas`, `/netgraph`, `/peers` are
  unauthenticated local reads and need no cap (they already are, per `primitives.md` §4). The
  **action** taken on a pick carries the app's own ability in `Ctx.cap` — `rpc:call` for a routed
  request, `run:invoke` (the existing deploy ability) for `place` → `mesh_deploy`. Placement is a
  *read+route*; it never grants authority, so it cannot be an escalation vector.
- **Stranger boundary.** Every routed call goes through the **local** node's `request`/`mesh_deploy`;
  the remote node authenticates `AppMessage.from` and enforces the chain in `Ctx.cap` before running
  the handler. The balancer chooses *whom* to ask; the callee still independently authorizes. No raw
  socket, no bypass.
- **DoS / abuse bounds.**
  - *Selection is read-only and bounded:* one `/atlas` + one `/netgraph` (+ optional `/peers`,
    `/beacon`) read per refresh, cached per `(ns, service)` for a short TTL; ranking is `O(candidates)`.
    A client cannot amplify load on others by selecting.
  - *Backpressure ejection is the abuse backstop the right way around:* an overloaded callee says
    `ResourceExhausted` (11), and the balancer *stops calling it* — co-operative, not adversarial.
  - *Steering resistance:* the beacon-seeded tiebreak (`locate.rs:265`) means no party can pre-compute
    or bias which instance wins a tie before the beacon (PoW tip) is fixed — the same unsteerable
    property `locate` already documents.
- **Payment-channel metering (optional).** When routing *paid* calls, the balancer can prefer
  instances with which the caller holds an open payment channel (`CeClient::channels`,
  `lib.rs:568`) to amortize settlement, and feed the channel's `retry_after`/refusal back into
  ejection. Metering itself is 11's job; placement only *reads* channel availability as a soft
  preference, never as authorization.

---

## 7. Composition

**Depends on (in-edges, §5 graph):**
- `01-service-registry-binding-health.md` — supplies the **healthy** candidate set (health-filtered
  `find_service`). Until 01 ships, this primitive uses raw `find_service` + atlas-staleness as a
  weaker health proxy (exactly today's `locate.rs`). *(Forward reference; 01 not yet written.)*
- `07-telemetry-metrics-slis.md` — supplies the **least-loaded** signal richer than atlas
  `running_jobs` (queue depth, inflight, p99). Optional; absence falls back to atlas capacity.
- The **atlas** (`primitives.md` §4) and **netgraph** (`NetEdge`) node primitives — nearest + fit.
- `05-resilient-rpc.md` — owns the retry/hedge/circuit-break *mechanics*; this primitive supplies the
  *candidate ordering and ejection* that 05 retries across. (05 reads the §4 retryability table; 02
  decides the next target.)
- `Ctx` envelope (`00-architecture.md` §2) — `idem` + `deadline_ms` for safe, bounded failover.

**Enables (out-edges):**
- `03-durable-work-queue.md` — spreads consumers across the healthy pool; `Rendezvous` assigns
  partition ownership.
- `04-event-log.md` — places/locates partition leaders; `Rendezvous` for partition→owner.
- `08-locks-leases-election.md` — places Raft group members on least-loaded, domain-spread hosts.
- `ce-gke` controller — replaces its bespoke `placement::rank` call site with `Balancer::place`,
  gaining latency-awareness and backpressure ejection for free (its scoring core is already this
  primitive's ancestor).

---

## 8. Test plan

**Deterministic unit tests (pure core, no mesh) — the bulk.** Mirror `ce-gke/src/placement.rs`'s
existing suite and `ce-rs/src/locate.rs`'s `spread`/`beacon_jitter` tests:
- `rank_instances`: least-loaded ordering (emptiest first — port `rank_orders_emptiest_first`);
  excludes stale / tag-mismatch / ejected; latency tiebreak among equal load; load dominates latency
  (near-saturated loses to far-idle); monotonicity in free capacity; deterministic beacon tiebreak.
- `rendezvous_pick`: same key → same owner across calls; membership change reshuffles ≤ minimal
  fraction of keys (HRW property test); empty candidate set → `None`.
- `PowerOfTwo`: returns one of the two sampled, the higher-scored; distribution spreads (statistical
  property test over many keys).
- Ejection state machine: a `ResourceExhausted` reply ejects for `retry_after_ms`; an `Ok` clears it;
  cooldown expiry re-admits.
- Backpressure-aware `call` (with a mocked `CeClient`): all candidates exhausted → `Status::Unavailable`;
  first-healthy short-circuits; `Ctx.idem` constant across the failover loop.
- `Partial<T>` from `call_many`: ok/failed split is exhaustive and never collapses to a bool (§4).
- `/peers` ⋈ `/netgraph` join: builds `rtt_by_node` correctly; missing `/peers` ⇒ `latency_aware=false`,
  no panic, identical ranking to today.

**Property tests.** (1) Ranking is a total order stable under input permutation. (2) For any atlas, the
top pick has ≥ the free capacity of any non-ejected candidate it outranks (no inversion vs load).
(3) Determinism: same (atlas, rtt, ejected, beacon) ⇒ identical output across runs/threads.

**Integration (single process, mocked node HTTP).** Stand up a fake `/atlas` + `/netgraph` + `/peers`
+ `/discovery/find/*` and assert `locate`/`Balancer` select as scored; flip a host to exhausted and
assert ejection + failover.

**Live multi-node mesh (the part that needs real infra).** On a ≥3-node mesh (laptop + desktop +
relay, per `CLAUDE.md`): advertise one service on all three, deploy real instances, drive concurrent
`Balancer::call` from a 4th node, and verify (a) load spreads (no single host gets ≫ its share), (b)
the nearest-by-real-RTT instance is preferred when load is equal, (c) killing an instance triggers
ejection + failover within one selection cycle, (d) a host returning `ResourceExhausted` under 11's
admission is drained. This is the only tier that needs the mesh; everything causal is unit-testable.

---

## 9. Worked example — a sharded multiplayer game backend

A game has 64 world shards, each an authoritative cell, replicated 2× for failover, spread across a
mesh of mixed home + datacenter nodes. Players are phones running `ce-ts`.

**Placement (deploy time).** The game's control plane calls
`coord.balancer("world@1", opts).place(&PlaceReq{ cpu_cores: 2, mem_mb: 4096, require_tags:
["docker","linux"], want: 128 /* 64 shards × 2 replicas */, spread_domains: true })`. This wraps
`ce-gke::placement::rank` semantics: it fits each candidate (`host_can_fit`), scores least-loaded
(`score_host`), and spreads the two replicas of each shard across distinct `region:`/`zone:`/`asn:`
fault domains (`locate::spread`) so one datacenter loss never drops both replicas of a shard. Each
placed instance `advertise_service("ce-game/world@1")` + `register` (the existing `locate::register`
loop, `locate.rs:195`) tagged with its shard id.

**Routing (per player action).** A player in EU enters shard 17. The phone binds
`Balancer.bind(ce, "world@1")` and calls `pickFor(shard_id=17)` with `strategy: "rendezvous"` — a
deterministic, membership-stable owner, so every EU player in shard 17 hits the *same* authoritative
instance (consistency), while a different shard's players land elsewhere (spread). Movement RPCs go
through `balancer.call("ce-game/world/17", payload, deadline=80ms)`. The selector prefers the
**nearest** of shard 17's two replicas by real RTT (`/netgraph`⋈`/peers`), so the EU player talks to
the EU replica, the US player to the US replica — until the EU replica saturates and returns
`ResourceExhausted` (11), at which point the balancer **ejects** it for `retry_after_ms` and fails
over to the US replica under the same `Ctx.idem` (no double-applied move), all within one 80ms
budget. When the EU replica recovers, its next `Ok` clears the ejection. The whole flow is the three
asks — *healthy, least-loaded, nearest* — composed from data the node already publishes, with zero
new node RPCs beyond the `/peers` correlation read.

---

## 10. Effort & minimal first slice

**Overall effort: M.** Most of the algorithm already exists in two places (`ce-gke::placement`,
`ce-rs::locate`); the work is unifying them, adding latency + backpressure inputs, and the
namespaced `ce-coord` wrapper. The only node touch is a small read-only `/peers` projection.

**Minimal first slice (ship behind tests, no mesh required):**
1. `GET /peers` → `Vec<PeerLink>` (read-only projection of the swarm's authenticated peer table).
2. `ce-rs::locate`: add `rank_instances` (pure) folding `ce-gke::score_host`'s load term + RTT (via
   `/peers`⋈`/netgraph`) + the existing beacon tiebreak; wire `latency_aware` (default false until
   `/peers` confirmed present). Keep `locate`/`call` signatures; add `Balance::LeastLoaded` only.
3. Backpressure ejection in `call`: on `ResourceExhausted`/`Unavailable`, eject for
   `retry_after_ms`, fail over with stable `Ctx.idem`.
4. Full pure-core unit + property suite (§8), modeled on the existing `placement.rs`/`locate.rs` tests.

Deferred to later slices: `ce-coord::Balancer` typed wrapper, `PowerOfTwo`/`Rendezvous` strategies,
07 SLI feed integration, payment-channel preference, and the live multi-node spread test.
