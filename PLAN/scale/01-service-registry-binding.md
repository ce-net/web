# 01 — Service registry, binding/resolver & health contract

**Status:** implementation-ready design. Conforms to `00-architecture.md` (the contract wins on any
disagreement). Ground truth cited inline: `ce-rs/src/lib.rs`, `ce-rs/src/locate.rs`,
`ce-rs/src/serve.rs`, `ce-coord/src/{lib.rs,merged.rs,collections.rs}`,
`ce/crates/ce-mesh/src/lib.rs`, `ce/crates/ce-node/src/api.rs`, `ce/docs/primitives.md`.

## Conformance block (architecture §7)

1. **Plane** — **coord** (`ce-coord` SDK over `ce-rs`). Zero node-plane changes; it composes the
   existing DHT (`advertise_service`/`find_service` — `ce-rs/src/lib.rs:498-513`,
   `ce/crates/ce-mesh/src/lib.rs:542-553`), the atlas (`ce-rs/src/lib.rs:200`), per-instance health
   carried in a `ce-coord` `Merged` CRDT (`ce-coord/src/merged.rs`), and `Ctx` from the envelope.
   It proposes **no new `RpcRequest`** — resolution is a pure client decision over data the node
   already publishes, which is exactly architecture §0.1 row 01.
2. **Abilities** — reserves `svc:register`, `svc:resolve`, `svc:deregister` (architecture §3).
   Resource-scoped by `ce-cap::Resource::Tag("svc:<ns>/<name>")`, so a grant can say "may register
   instances of `ce-db/acme` only".
3. **Envelope use** — reads/writes `Ctx.ns` (the service namespace key, §6), `Ctx.cap` (the
   register/resolve authorization), `Ctx.deadline_ms` (bounds a resolve), `Ctx.trace`/`parent_span`
   (a resolve is one span in the calling action). Adds **no parallel header**.
4. **Status & partial failure** — returns `NotFound` (no healthy instance), `Unavailable` (advertised
   but all stale/draining), `Unauthorized`, `InvalidArgument` (bad version range / service key),
   `FailedPrecondition` (dependency version unsatisfiable). Multi-instance resolution returns
   `Partial<Instance>` (architecture §4) — never collapses "3 of 5 healthy" to a bool.
5. **Dependencies** — in-edges (architecture §5): `Ctx` envelope (keystone), **07 telemetry** (the
   health/SLI signal it filters on — see `07-telemetry.md`), `atlas`, the DHT. Enables **02
   placement** (`02-load-balancing-placement.md`), **05 resilient RPC** (`05-resilient-rpc.md` binds
   through it), and every durable substrate (03/04/08) that resolves its peers by service name.
6. **Namespacing** — `service_key = "<ns>/<name>@<major>"` over the existing DHT
   (architecture §6, last bullet); the health CRDT replica key is `(ns, "svc/<name>@<major>")`.
7. **Boundary check** — no app policy enters the node: the node still only stores opaque DHT provider
   records and routes opaque `AppMessage`s; "healthy", "version", "dependency" are all
   `ce-coord`/app concepts. Stranger code never bypasses the local node — every resolve/register goes
   through `ce-rs` and the local node authenticates the sender and verifies `Ctx.cap`.

---

## 1. Purpose & the at-scale problem

Today an app finds a peer with `find_service("ce-db")` → `Vec<NodeId>`
(`ce/crates/ce-mesh/src/lib.rs:548`). That answers only *"some node once advertised this string"*.
It does **not** tell you:

- **Is that instance healthy and ready right now?** DHT provider records merely expire; a crashed-but-
  not-yet-expired, overloaded, or still-warming-up instance is indistinguishable from a good one.
  `locate.rs` already filters staleness via the atlas, but the atlas is generic node capacity, not
  *application readiness* (DB warmed its cache, queue is draining, schema migrated).
- **Which version?** A sharded game backend running `match-host@2` must not be handed a `@1` peer with
  an incompatible wire protocol. `find_service` has no version axis.
- **What are my dependencies, and are they all up before I start?** A real app declares
  `needs storage@^1, db@^2` and must resolve every one to a live endpoint at startup, failing fast
  and legibly if any is unsatisfiable — the "dependencies" mechanism, the whole point of this doc.

At scale (many interdependent apps, instances churning, concurrent resolves) this must be: cheap
(no central registry, no node RPC per resolve), correct under partition (a stale view degrades, never
lies), and concurrent-safe (instances register/deregister/heartbeat independently without a single
writer). That is precisely a multi-writer CRDT of health records keyed by versioned service name,
resolved through the data the node already gossips.

This primitive **productizes and extends `ce-rs/src/locate.rs`** — which already does discovery +
ranking + failover (`locate`/`call`/`register`, `Instance`/`LocateOpts`) — by adding the three
missing axes: **explicit versioning**, an **application health/readiness contract**, and a
**dependency resolver**.

## 2. Plane: node vs ce-coord

**ce-coord.** Per architecture §0/§0.1: registry, binding, and health are *typed coordination APIs*,
pure clients of the node's generic verbs. The litmus test (`primitives.md`): a registry is product
semantics (a *named, versioned, healthy service*) — an app. The node owns only the byte mechanisms it
already has:

| Mechanism | Owner (existing) |
|---|---|
| DHT provider records (who advertises a key) | node — `advertise_service`/`find_service`, Kademlia (`ce/crates/ce-mesh/src/lib.rs:979-987`) |
| Capacity/tags/recency (the atlas) | node — `GET /atlas` (`ce/crates/ce-node/src/api.rs`) |
| Signed pub/sub + directed request/reply + inbox | node — `publish`/`subscribe`/`request`/`reply`/`messages` |
| Sender authentication + `Ctx.cap` verification | node — the enforcement point |

Health records, version ranges, dependency graphs, readiness gating, and ranking are **all
`ce-coord` library state and logic**. No new `RpcRequest`: a registration is a `Merged::propose`
(a signed pub/sub op) plus a periodic `advertise_service` re-announce; a resolve is `find_service` +
`atlas` + a read of the health CRDT. This satisfies architecture §1 (the closed node-plane list does
not include "registry") and the "no new ad-hoc node RPCs" rule.

## 3. Public API

### 3.1 Rust SDK (`ce-coord`, new module `ce-coord/src/registry.rs`)

Reuses existing types verbatim: `ce_rs::locate::{Instance, LocateOpts}`, `ce_rs::CeClient`,
`ce_coord::{Coord, Merged}`, the contract's `Status`/`Partial<T>`/`Ctx`.

```rust
// ce-coord/src/registry.rs  (coord plane, unprivileged)
use ce_rs::locate::{Instance, LocateOpts};
use ce_coord::{Coord, Version};

/// A semver-style major.minor.patch version a service instance advertises.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemVer { pub major: u32, pub minor: u32, pub patch: u32 }

/// A version constraint declared by a dependent (`^1`, `~1.2`, `>=2.1`, `*`, `=1.4.0`).
/// Matched against an instance's `SemVer` with standard caret/tilde rules.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum VersionReq { Caret(u32,u32,u32), Tilde(u32,u32,u32), Gte(SemVer), Exact(SemVer), Any }

/// The standard health/readiness contract every registered instance publishes (and refreshes).
/// This is the CRDT value the registry filters on — the contract §0.1 row 01 calls "the health
/// signal the registry filters on". `Phase`/`load` are app-reported; the registry treats them
/// uniformly. Mirrors k8s readiness/liveness without putting any of it in the node.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Health {
    pub version: SemVer,
    pub phase: Phase,            // Starting | Ready | Draining | Unhealthy
    pub load: f32,              // 0.0..=1.0 self-reported saturation (07 SLI when available)
    pub epoch: u64,             // strictly-increasing per instance (replay-proof, like Heartbeat)
    pub reported_at_ms: u64,    // instance HLC wall time of this report (from Ctx.hlc)
    pub fault_domain: Option<String>, // region:/zone:/asn: (reuses locate::fault_domain)
    pub meta: BTreeMap<String, String>, // app extras (endpoint topic, shard range, ...)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase { Starting, Ready, Draining, Unhealthy }

/// A registered, resolvable instance: locate's `Instance` (the ranked atlas signals) plus the
/// application `Health` it published. Resolution returns these.
#[derive(Clone, Debug)]
pub struct Resolved { pub instance: Instance, pub health: Health }

pub struct Registry { /* holds Coord + a Merged<HealthBook> per (ns,name@major) */ }

impl Registry {
    /// Attach the registry to the local node's coordination layer.
    pub async fn open(coord: Coord) -> anyhow::Result<Registry>;

    // ---- producer side (this node IS an instance) ----

    /// Register THIS node as an instance of `name` at `version` in namespace `ns`, publishing
    /// `initial` health. Spawns: (a) periodic DHT re-advertise of `service_key(ns,name,major)`
    /// (reusing `ce_rs::locate::register` semantics), and (b) periodic health refresh
    /// (`propose` a fresh `Health{epoch+1, phase, load}` into the Merged book) every `refresh`.
    /// Requires a `Ctx.cap` granting `svc:register` on `Tag("svc:<ns>/<name>")`.
    /// Returns a handle; dropping it deregisters (publishes `Phase::Draining`, stops re-advertise).
    pub async fn register(
        &self, ns: &str, name: &str, version: SemVer,
        initial: Health, refresh: std::time::Duration,
    ) -> anyhow::Result<Registration>;

    // ---- consumer side (resolve dependencies) ----

    /// Resolve ONE healthy instance of `name` satisfying `req`, ranked best-first. Filters by the
    /// health contract (Phase::Ready, fresh epoch) THEN applies locate's atlas/trust/beacon ranking.
    /// `Status::NotFound` if advertised by nobody; `Status::Unavailable` if advertised but none
    /// healthy; `Status::FailedPrecondition` if none satisfies `req`.
    pub async fn resolve(
        &self, ns: &str, name: &str, req: &VersionReq, opts: &LocateOpts,
    ) -> Result<Resolved, Status>;

    /// Resolve up to `opts.want` healthy instances (redundancy / sharded fan-out). Returns a
    /// `Partial<Resolved>` so the caller sees which instances are live and which failed health.
    pub async fn resolve_many(
        &self, ns: &str, name: &str, req: &VersionReq, opts: &LocateOpts,
    ) -> Partial<Resolved>;

    /// Resolve a whole dependency set at startup. Blocks (up to `deadline`) until EVERY dep has at
    /// least one healthy instance, or returns the first unsatisfiable dep. This is the literal
    /// "needs storage@^1, db@^2" mechanism. Returns the bound endpoints keyed by dep name.
    pub async fn bind(
        &self, ns: &str, deps: &[Dep], deadline: std::time::Duration,
    ) -> Result<Bindings, BindError>;

    /// A live, self-healing binding: like `bind` but returns a handle that keeps each dep resolved
    /// to a current healthy instance, re-resolving on health change (drains, crashes, scale-up).
    /// `binding.get("db")` is always a currently-healthy `Resolved` or `Unavailable`.
    pub async fn bind_live(&self, ns: &str, deps: &[Dep]) -> anyhow::Result<LiveBindings>;
}

/// A declared dependency: name + version requirement + how strict resolution is.
pub struct Dep { pub name: String, pub req: VersionReq, pub opts: LocateOpts, pub optional: bool }

pub struct Bindings { /* name -> Resolved */ }       impl Bindings { pub fn get(&self, dep:&str)->Option<&Resolved>; }
pub struct LiveBindings { /* name -> watch::Receiver<Result<Resolved,Status>> */ }
pub struct BindError { pub dep: String, pub status: Status }  // which dep, why
pub struct Registration { /* RAII; Drop => Draining + stop re-advertise */ }
```

`call`-style binding (resolve + send over mesh, with failover) is **already** `ce_rs::locate::call`
(`ce-rs/src/locate.rs:163-190`); the registry's contribution is to feed it health-filtered,
version-matched candidates. A thin `Registry::call(ns,name,req,topic,payload,opts,timeout)` wraps it.

### 3.2 TS SDK (`ce-ts`, `@ce/coord` `registry.ts`)

Mirrors the Rust surface (the browser/Node path described in the platform memo). Same wire types.

```ts
export interface SemVer { major: number; minor: number; patch: number }
export type VersionReq =
  | { kind: "caret" | "tilde" | "gte" | "exact"; v: SemVer } | { kind: "any" };
export type Phase = "Starting" | "Ready" | "Draining" | "Unhealthy";
export interface Health {
  version: SemVer; phase: Phase; load: number; epoch: number;
  reportedAtMs: number; faultDomain?: string; meta: Record<string,string>;
}
export interface Resolved { instance: Instance; health: Health }  // Instance from @ce/client locate
export interface Dep { name: string; req: VersionReq; want?: number; requireTags?: string[]; optional?: boolean }

export class Registry {
  static async open(coord: Coord): Promise<Registry>;
  async register(ns: string, name: string, version: SemVer, initial: Health, refreshMs: number): Promise<Registration>;
  async resolve(ns: string, name: string, req: VersionReq, opts?: LocateOpts): Promise<Resolved>;       // throws CeStatusError
  async resolveMany(ns: string, name: string, req: VersionReq, opts?: LocateOpts): Promise<Partial<Resolved>>;
  async bind(ns: string, deps: Dep[], deadlineMs: number): Promise<Bindings>;                            // rejects with BindError
  async bindLive(ns: string, deps: Dep[]): Promise<LiveBindings>;                                        // .get(dep) -> Resolved | undefined
}
```

### 3.3 Node HTTP routes & wire types

**None added.** This is the conformance point. Everything routes through existing endpoints:

| Used endpoint (existing) | Role here |
|---|---|
| `POST /discovery/advertise`, `GET /discovery/find/:service` (`ce-rs/src/lib.rs:500,506`) | versioned service-key advertise / discover on the DHT |
| `GET /atlas` (`:200`) | capacity/tags/recency, liveness floor |
| `POST /mesh/publish`, `POST /mesh/subscribe`, `GET /mesh/messages/stream` | carry the `Merged<HealthBook>` ops |
| `POST /mesh/request`, `POST /mesh/reply` | `Merged` catch-up / `locate::call` binding hops |
| `GET /beacon` (`:206`) | deterministic unsteerable tiebreak (reused from `locate`) |

The only **wire types** are the `ce-coord` CRDT op + value (`Health` above), serialized exactly as
every other `Merged` op is (bincode through `publish`). They never touch the node's wire format; the
node sees opaque `AppPubSubMsg` payload bytes (`ce/crates/ce-mesh/src/lib.rs:304`).

## 4. Protocol & data structures

### 4.1 The versioned service key (DHT)

```
service_key_str = "<ns>/<name>@<major>"      e.g. "ce-db/acme/match-host@2"
DHT key         = service_key(service_key_str)   // ce/crates/ce-mesh/src/lib.rs:64 — sha256 into provider keyspace
```

**Major-only in the DHT key** (semver contract: a major bump is a breaking change → a distinct
service). Minor/patch live in the `Health.version` record, matched client-side. So `find_service`
returns every instance of a compatible major; the registry filters minor/patch against `VersionReq`.
Reuses `service_key` unchanged — no node change (architecture §6 last bullet).

### 4.2 The health book — a `Merged` CRDT, one per `(ns, name@major)`

Each instance is its **own writer** of its **own** health record; readers merge all writers. This is
exactly `ce-coord::Merged` (`ce-coord/src/merged.rs:123`) with a per-instance LWW-by-epoch machine:

```rust
// MergeMachine: HealthBook = map NodeId -> Health, op = (writer NodeId, Health).
// Key = (writer, epoch): strictly increasing per writer (merged.rs requires unique ordered keys).
// apply(): keep the highest-epoch Health per writer; ignore older epochs (idempotent, gap-tolerant).
struct HealthBook(BTreeMap<NodeId, Health>);
impl MergeMachine for HealthBook {
    type Op = (NodeId, Health);
    type Key = (NodeId, u64);                      // (writer, epoch) — total order, never shared
    fn key(op) -> Self::Key { (op.0, op.1.epoch) }
    fn apply(&mut self, (id, h): Op) {
        match self.0.get(&id) { Some(p) if p.epoch >= h.epoch => return, _ => {} }
        self.0.insert(id, h);
    }
}
```

Why `Merged` not `RMap`: `RMap` is single-writer (`ce-coord/src/collections.rs:125` `map_writer`);
the registry is inherently multi-writer (every instance writes its own row, concurrently, with no
coordinator). `Merged` is the multi-writer CRDT engine (`merged.rs`), and the per-writer-LWW-by-epoch
machine makes concurrent updates commutative and idempotent — the architecture §0 concurrency
requirement. The `epoch` field reuses the chain's replay-proof Heartbeat pattern
(`primitives.md` §7: "Epochs strictly increase").

A reader follows writers it learns from `find_service` (the DHT provider set bounds who can be in the
book): on `find_service` returning `{n1,n2,...}`, the reader `Merged::add_writer(ni)`
(`merged.rs:177`) for each, then `pull()` for catch-up.

### 4.3 Register (producer)

1. Verify caller holds `svc:register` on `Tag("svc:<ns>/<name>")` (local check before publishing).
2. `advertise_service(service_key_str)` now, and re-advertise every `interval` (reuse
   `locate::register`'s loop — `ce-rs/src/locate.rs:195-211`).
3. Every `refresh`: `Merged::propose((self, Health{ epoch: prev+1, phase, load, reported_at_ms:
   Ctx.hlc.0, ... }))`. `propose` signs + publishes the op (`merged.rs:199`).
4. On `Registration` drop / shutdown: `propose(Health{ phase: Draining })`, stop re-advertise. (A
   hard crash skips this; readers fall back to epoch-staleness, §5.)

### 4.4 Resolve (consumer) — the algorithm

```
resolve(ns, name, req, opts):
  ids        = find_service("<ns>/<name>@<req.major_floor>..")   # union over compatible majors
  if ids empty: return NotFound
  book       = Merged<HealthBook> for (ns,name@major); add_writer(each id); pull(); read()
  now_ms     = local HLC wall
  candidates = for id in ids:
                 h = book.get(id)?                      # advertised but no health record -> skip (warming/unknown)
                 if h.phase != Ready: skip              # Starting/Draining/Unhealthy excluded
                 if now_ms - h.reported_at_ms > stale_ms(refresh): skip   # missed heartbeats => dead
                 if !req.matches(h.version): skip        # minor/patch gate
                 keep (id, h)
  if candidates empty:
     return (any advertised? Unavailable : NotFound)     # advertised-but-unhealthy vs gone
  ranked = locate::rank(candidates by atlas+trust+recency+beacon)   # REUSE locate.rs scoring, intersected with health.load
  return ranked[0]  (resolve_many: spread across fault_domains via locate::spread, return Partial)
```

**Key invariants**

- *Health is a filter applied before ranking* — `locate.rs` ranks atlas signals; the registry first
  intersects with the application `Health` contract, so "a provider exists" becomes "a *Ready*,
  *version-matched*, *fresh* provider exists" (the doc's whole purpose).
- *Staleness = missed epochs.* An instance is dead-to-readers if `now - reported_at_ms > k * refresh`
  (default `k=3`), independent of DHT record TTL — readiness is decoupled from mere reachability.
- *No central writer.* Concurrent registrations/heartbeats from N instances are commutative
  (per-writer LWW-by-epoch); the book converges regardless of arrival order (`merged.rs` guarantee).
- *Resolution is read-only and node-RPC-free* after the one-time `find_service` + atlas fetch
  (which are cached/streamed); a hot path resolve hits in-memory CRDT state.

### 4.5 Bind (dependency resolver)

`bind(ns, deps, deadline)`: for each `Dep`, `resolve` it; if `NotFound`/`Unavailable` and not yet at
`deadline`, await a health-book change notification (`Merged::watch()` — `merged.rs:273`) and retry;
when every required dep resolves, return `Bindings`. First dep still unsatisfiable at `deadline` →
`BindError{ dep, status }`. `optional` deps that miss `deadline` are simply absent from `Bindings`.
`bind_live` keeps a `watch::Receiver<Result<Resolved,Status>>` per dep, re-resolving on every
`Merged::watch` tick so a drained/crashed instance is swapped out automatically (feeds 02/05).

## 5. Semantics & failure modes

- **Consistency:** the health book is an **eventually-consistent CRDT** (at-least-once delivery, gap-
  and reorder-tolerant — exactly `ce-coord`'s documented model, `lib.rs:22`, `merged.rs`). A resolve
  reflects the reader's *current converged view*; two readers may briefly disagree. This is correct
  for discovery: a stale view costs at most one failed-then-retried call (handled by `locate::call`
  failover, `ce-rs/src/locate.rs:179-189`).
- **Ordering:** per instance, epochs are a total order (LWW); across instances there is no global
  order and none is needed.
- **Liveness vs readiness:** DHT TTL gives reachability; the `epoch`/`reported_at_ms` freshness gives
  *application* readiness. Both must pass. A node up but app-unready publishes `Phase::Starting` and
  is excluded — the gap `find_service` alone cannot close.
- **Partition:** a reader partitioned from an instance stops receiving its heartbeats → that instance
  goes stale → excluded (fail-safe: a partitioned instance is treated as unavailable, never falsely
  Ready). On heal, epochs resume and it re-enters. No split-brain: nobody is *elected*; resolution is
  a local view, so partitions cause divergent-but-safe views, not conflicting writes.
- **Crash:** a hard crash skips the `Draining` publish; the instance ages out by staleness within
  `k*refresh`. Default `refresh=10s, k=3` → ≤30s detection, tunable.
- **What it does NOT guarantee:** not a consensus registry (use **08 election** for single-leader
  semantics, `08-locks-leases-election.md`); not exactly-once resolution (callers retry via 05); not
  a global snapshot (each reader sees its own convergence frontier); does not prevent a malicious
  instance from publishing `Ready` while broken — that is the trust gradient's job
  (`primitives.md` "trust gradient"): rank by on-chain delivered work (already in `locate.rs:118`),
  and verify via redundancy (`resolve_many` + compare). `Health.load`/`phase` are *self-reported
  hints*, not proofs; treat a stranger's claims with the verification dial.

## 6. Security & economy

- **Abilities** (architecture §3): `svc:register` (publish a health record / advertise),
  `svc:deregister` (force-drain another instance you operate), `svc:resolve` (read the book — usually
  ungated for public services; gated for private/tenant ones via `Resource::Tag("ns:<tenant>")`).
  Enforced at the local node before the `propose`/`find` is honored (the security invariant: the
  node verifies `Ctx.cap`, `ce-rs/src` never trusts a stranger).
- **Authenticity:** every health op is a signed `Merged` op (`propose` signs;
  `lib.rs:14` "a reader only applies log entries signed by the one writer it follows"). An instance
  cannot publish health *as another instance* — `key = (writer, epoch)` and the writer is the
  node-verified `AppMessage.from`. So no instance can poison another's row.
- **Abuse/DoS bounds:** (a) the book only admits writers in the DHT provider set, so a non-advertiser
  cannot inject rows; (b) per-writer LWW-by-epoch caps each writer to one effective row regardless of
  flood; (c) refresh publishes are rate-limited by the node's generic admission (architecture §1 row
  11 / `11-flow-control.md`) keyed `(from, ns, svc:register)`; (d) a flood of bogus advertisements is
  bounded by DHT provider-record cost and aged out by staleness. The registry adds no unbounded
  state: the book is `O(instances of one service)`, pruned on stale.
- **Economy (optional):** resolve is free (read). For a *paid/private* registry (e.g. a premium
  service directory), `svc:resolve` can be metered with a payment channel
  (`ce-rs/src/lib.rs:543-554`) — a receipt per resolve batch, identical to `fetch_chunk_paid`'s
  pattern (`:391`). Not required for the common case.

## 7. Composition

- **Depends on** (in-edges): `Ctx` envelope (architecture §2); **07 telemetry**
  (`07-telemetry-sli.md`) supplies the real `Health.load`/`phase` SLIs the registry filters on (until
  then, self-reported); the node DHT + `atlas`; reuses `ce-rs/src/locate.rs` ranking wholesale.
- **Enables / consumed by:**
  - **02 load balancing & placement** (`02-load-balancing-placement.md`) — picks *healthy(01)*
    least-loaded(07) nearest(atlas); the registry is its candidate source.
  - **05 resilient RPC** (`05-resilient-rpc.md`) — binds a call target by service name + version
    through `resolve`/`bind_live`, failing over on `Unavailable` (extends `locate::call`).
  - **03 queue / 04 log / 08 election** — each resolves its peer set / group members by service name
    instead of hardcoding NodeIds.
  - **12 schema/config registry** (`12-schema-config-registry.md`) — a sibling: it versions IDLs/
    config; this versions *running instances*. They share the `SemVer`/`VersionReq` types.

## 8. Test plan

**Deterministic unit cores (no mesh):**

- `VersionReq::matches` — caret/tilde/gte/exact/any against a `SemVer` table (the binding correctness
  core). Property test: `Caret(1,2,0)` matches `1.x.y ≥ 1.2.0`, rejects `2.0.0` and `1.1.9`.
- `HealthBook::apply` — older epoch ignored, higher epoch wins, two writers independent, idempotent
  under reorder/duplication (mirror `merged.rs` LWW tests, `merged.rs:334`). Property: any permutation
  of a fixed op multiset converges to the same book (CRDT commutativity).
- `resolve` filter pipeline over a synthetic `(ids, atlas, book, now)` fixture: Starting/Draining/
  Unhealthy excluded, stale (epoch-aged) excluded, version-mismatch excluded, `NotFound` vs
  `Unavailable` distinction, ranking order matches `locate.rs` when all Ready. (Inject the atlas/book
  directly — same style as `locate.rs:283` tests with synthetic `Instance`s.)
- `bind` — all-deps-satisfied returns `Bindings`; one unsatisfiable returns its `BindError`; optional
  missing dep is absent not fatal; deadline honored (use a fake clock + a `watch` you tick).
- `resolve_many` fault-domain spread — reuse `locate::spread` tests (`locate.rs:299-329`) to confirm
  redundant resolves cross domains.

**Integration / property (in-process multi-node testkit):** drive `ce-coord/src/testkit.rs` with N
in-memory nodes; register K instances at mixed versions/phases, assert every reader converges to the
same healthy set, that a `Draining`/stale instance disappears within `k*refresh`, and that
concurrent register/deregister storms converge (property: final book == LWW of latest epochs).

**Needs a live multi-node mesh:** end-to-end `bind` across real relayed NAT'd peers (laptop ↔ desktop
↔ relay per `CLAUDE.md`): start a `db@2` and `storage@1` instance, `bind(["storage@^1","db@^2"])`
from a third node, kill the db, assert `bind_live` re-resolves to a replacement; partition the relay,
assert fail-safe exclusion then re-entry on heal. This is the only tier the in-process testkit cannot
cover (real DHT propagation + atlas timing).

## 9. Worked example — a sharded game backend

A multiplayer game has a `match-host@2` service (one instance per shard / region) and depends on
`leaderboard@^1` and `db@^2`.

```rust
// --- a match-host instance, on startup ---
let reg = Registry::open(coord).await?;
let me = reg.register("game/prod", "match-host", SemVer{major:2,minor:3,patch:0},
    Health { version: SemVer{2,3,0}, phase: Phase::Starting, load: 0.0, epoch: 1,
             reported_at_ms: now, fault_domain: Some("region:eu".into()),
             meta: btree!{ "rpc"=>"game/match/rpc", "shard"=>"eu-1" } },
    Duration::from_secs(10)).await?;
// resolve my own dependencies before accepting players:
let deps = [ Dep::required("db", VersionReq::Caret(2,0,0)),
             Dep::required("leaderboard", VersionReq::Caret(1,0,0)) ];
let bound = reg.bind("game/prod", &deps, Duration::from_secs(30)).await?; // BindError if db@^2 absent
let db = bound.get("db").unwrap();          // a Ready, version-matched, ranked instance
warm_caches(db).await?; me.set_phase(Phase::Ready).await?;   // now resolvable by clients

// --- a game client picking a shard host ---
let host = reg.resolve("game/prod", "match-host", &VersionReq::Caret(2,0,0),
    &LocateOpts{ want:1, require_tags: vec!["region:eu".into()], ..default }).await?; // healthy eu @2.x
let reply = ce.request(&host.instance.node_id, "game/match/rpc", &join_packet, 5_000).await?;
```

When the eu shard host drains for a deploy it publishes `Phase::Draining`; in-flight `bind_live`
holders for `match-host` re-resolve to the standby eu instance (or, if none, an adjacent region with a
ranking penalty) with no client code change. Cross-app: the `db@2` resolution carries the same
`Ctx.trace`, so the join request's span tree spans client → match-host → db (06 tracing), and a slow
join is attributable to the exact bound instance.

## 10. Effort & first slice

**Effort: M.** Most of the hard parts already exist: discovery, atlas ranking, failover (`locate.rs`)
and the multi-writer CRDT engine (`ce-coord::Merged`). The new code is the versioned key, the
`Health`/`VersionReq` types + matcher, the health-filter-then-rank pipeline, and `bind`.

**Minimal first slice (ship behind tests):**

1. `SemVer` + `VersionReq` + `matches()` with property tests (pure, no mesh) — the binding core.
2. `Health` + `HealthBook: MergeMachine`, wired to `Merged` — register publishes, readers converge.
3. `Registry::{open, register, resolve}` with major-only DHT key over existing `advertise_service`/
   `find_service`, health filter in front of `locate::rank`. Single-version, single-instance resolve.
4. `bind` for a static dep set with a deadline (no `bind_live` yet).

Defer to slice 2: `bind_live` watch-driven re-resolution, `resolve_many` fault-domain spread (lift
`locate::spread`), paid/private registries, and the TS SDK mirror. This slice unblocks 02 and 05,
which is the critical path (architecture §5).
