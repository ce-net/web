# 99 — Scaling Layer: Coherence Review & Dependency-Ordered Build Roadmap

**Status:** review + plan. Reads `00-architecture.md` (the contract) and `01`–`12`. The contract wins
on any disagreement; where a per-primitive design diverges from it, this doc names the doc, the
divergence, and the fix. Ground truth verified against the live tree: `ce-coord/src/{lib,replicated,
merged,collections,snapshot,stream,testkit}.rs`, `ce-pubsub/src/*`, `ce-rs/src/{lib,locate}.rs`,
`ce/crates/ce-mesh/src/lib.rs` (`service_key`/`advertise_service`/`find_service` at :64/:542/:548;
`netgraph`/`NetEdge` at `ce-rs/src/lib.rs:213/:617`; the PeerId↔NodeId gap flagged at
`ce-rs/src/locate.rs:23`), `ce-gke/src/placement.rs`, `ce-iam/src/*`. All twelve designs build on
engines that exist today — this is productization, not green-field.

---

## Part A — Coherence Review

The set is unusually coherent: every doc carries the §7 conformance block, every doc routes through
the three generic verbs + `Ctx`, and the dependency in-edges agree across docs. The issues below are
real but small — mostly **type-ownership ambiguity**, **filename drift**, and **one genuine contract
gap** (envelope evolution). None require re-architecting; each has a one-line fix that should land in
`00-architecture.md` or the named doc before Wave 0 ships, because they all touch the keystone.

### A1 — CONFLICT: where do `Ctx`, `Status`, `Partial<T>` actually live? (blocks Wave 0)

The contract (`00` §2) defines `Ctx` "in `ce-mesh`". But `Status`/`Partial<T>` have **three different
claimed homes** across docs:

- `03` §3.1: *"live in `ce-coord` or a shared `ce-scale-types` crate"*.
- `08` §3.1 / `10` §3.1: *"shared crate `ce-coord::status`"*.
- `05`/`06`/`07`/`09`: *"re-exports `Ctx`/`Status` from `ce-mesh`"*.
- `01`/`02`/`04`/`12`: *`use ce_rs::Ctx`* (i.e. re-exported by `ce-rs`).

These cannot all be right. `ce-mesh` is in the **node** workspace (`ce/crates/`); `ce-coord` and
`ce-rs` are SDK crates that must **not** force a node dependency on app code (per `MEMORY.md`:
"ce node must never depend on ce-rs"). `Status`/`Partial` are used by pure SDK code (`05` breaker,
`02` ranking) that should not pull in `ce-mesh`.

**FIX (amend `00-architecture.md` §2/§4):** create one tiny no-dep crate **`ce-scale-types`** holding
`Ctx`, `Status`, `Partial<T>`, `retry_after_ms`. `ce-mesh` depends on it for the wire envelope; `ce-rs`
and `ce-coord` re-export it. This is the single most important fix — Wave 0 cannot start until the
home of these three types is pinned, because **all 12** primitives import them. Cost: S, but it is on
the critical path of everything.

### A2 — GAP: the contract never says how `Ctx` *itself* evolves past v1

`00` §2 gives `Ctx.v` ("start at 1") and says old peers read new `Ctx` as `Default`. But the
**reverse** — a *new* node receiving a v1 `Ctx` and needing to know which fields are absent vs.
zero-meaningful — is unspecified, and several docs lean on it: `06` I1 ("0 = mint on receive") and
`09` ("`idem` 0 = at-most-once") both overload **zero as "absent"**, which collides with a future
field whose legitimate value is 0.

**FIX (add to `00` §2):** state the rule explicitly — *fields are append-only; a field is "present"
iff `Ctx.v >= the version that introduced it`; zero is a valid in-band value only for fields where the
doc says so (trace/idem/deadline), never a presence sentinel for future fields.* One paragraph;
prevents a wire-compat trap when `Ctx` grows (it will: `07` wants no new field but `06`/`09`/`11` each
read different subsets and a v2 field is inevitable).

### A3 — OVERLAP: two "registry" modules both named `ce-coord/src/registry.rs`

`01` §3.1 puts the **service** registry in `ce-coord/src/registry.rs`. `12` §3.1 puts the
**schema/config** registry in `ce-coord/src/registry.rs`. Same path, two different modules.

**FIX (rename in the docs):** `01` → `ce-coord/src/discovery.rs` (or `services.rs`); `12` →
`ce-coord/src/schema.rs` (or `contracts.rs`). They share the `SemVer`/`VersionReq` types (both docs
say so — `01` §7, `12` §7), so factor those into `ce-coord/src/version.rs` imported by both. Trivial
but will cause a literal compile collision if built as written.

### A4 — INCONSISTENCY: filenames in cross-references don't match the actual files

Cross-doc links cite names the files don't carry. `09` is titled
`09-ordering-exactly-once.md` but is referenced everywhere as
`09-causal-time-idempotency.md` / `09-causal-time-idempotency-counters.md` (in `00`, `03`, `04`, `05`,
`06`, `08`, `10`). `12` is `12-schema-contract-registry-config.md` but cited as
`12-schema-config-registry.md` / `12-schema-contract-config-registry.md`. `07` cites itself as
`07-telemetry-sli.md` and `07-telemetry.md` and `07-telemetry-metrics-slis.md`; the file is
`07-telemetry-metrics-health.md`. `08` cites `10-saga.md` (file is `10-saga-workflow.md`),
`11-flow-control.md` (file is `11-flow-control-rate-limiting.md`), `02` cites
`02-load-balancing-placement.md` (correct) but `06` cites `06-distributed-tracing.md` (correct) —
inconsistent only where it drifted.

**FIX (mechanical):** one pass normalizing all cross-references to the real filenames. No design
impact; purely link hygiene, but worth doing so the docs are navigable.

### A5 — OVERLAP: handler-side dedup appears in three places without one owner

Exactly-once dedup is claimed by: `09` (the authoritative node `(from,ns,idem)` table), `05` §3.2
(the `ce-coord` pump's existing `Dedup` window), and `03` (inherits `ce-pubsub`'s `IdempotencyCache`,
which `09` says it "subsumes"). The docs *mostly* reconcile this (`05` §3.2 explicitly calls the pump
`Dedup` a "best-effort second line" and the node table "authoritative"; `09` §4.2 says it "composes
with" the pump `Dedup`), but `03` §6 still lists `ce-pubsub/src/dedup.rs` as live while `09` §10 says
to **lift and re-key it into the node**, leaving the per-app cache's fate ambiguous.

**FIX (one sentence in `03` §10 and `09` §10):** the node `(from,ns,idem)` table is the single
authoritative dedup for **directed** calls; `ce-pubsub`'s app-local cache is **deleted** when `03`
adopts `Ctx.idem` (not kept in parallel); the pump `Dedup` window survives only for **gossip**
redelivery (it cannot key on `from,ns,idem` for pubsub). State the three-layer ownership once so no
one ships a redundant fourth dedup.

### A6 — UNDER-SPECIFIED: who runs the §11 admission *before* a node deadline/dedup exists?

`11` §4.1 fixes the inbound gate order as **admission → deadline(05) → dedup(09) → cap → dispatch**.
But the build order (`00` §5) ships `06`/`09`/`11` "independent of each other" in Wave 1. If `11`
lands before `09`, the gate order has a hole (no dedup stage yet); if `09` lands first, fine. The docs
don't pin intra-wave order beyond "tracing first".

**FIX (clarify `00` §5 step 1 + `11` §4.1):** the *inbound pipeline is additive* — each of
06/09/11 inserts its own stage and tolerates the others being absent (admission works with no dedup
stage; dedup works with no admission stage). Make this explicit so Wave 1's three node-plane changes
can land in **any** order without a half-wired pipeline. (Recommended landing order within Wave 1:
09 → 11 → 06, since 05 in Wave 2 hard-depends on 09's dedup table and 11's backpressure, while 06 only
*records*.)

### A7 — MINOR: `02` requests a node read (`GET /peers`) that the contract's closed list doesn't list

`02` §3.4 asks for a new node route `GET /peers` (PeerId↔NodeId correlation). The contract §1 closed
list is for *enforcement* changes; a read-only projection isn't enforcement, and `02` argues this
honestly (§2: "a node read, not an RPC and not enforcement"). This is **allowed** but the contract
should acknowledge read-only projections as a distinct, lighter category so reviewers don't reject it
against the §1 table.

**FIX (add to `00` §1):** a short note — *read-only projections of data the node already holds
(`/peers`, `/clock`, `/dedup/stat`, `/admission`) are permitted outside the §1 closed list; they
expose existing facts, enforce nothing, and need no `RpcRequest`.* `09` (`/clock`, `/dedup/stat`) and
`11` (`/admission`) also rely on this; bless the category once.

### A8 — CONSISTENT (no fix, noted): the economy/payment-channel and fencing patterns are uniform

Worth recording as a *positive* coherence finding: every doc that meters uses the **same** channel
surface (`channel_open`/`sign_receipt`/`channel_close`, `ce-rs/src/lib.rs:543-557`) the same way, and
every doc that needs single-ownership uses the **same** fencing contract (`08`'s monotone `Fence`
enforced by the *resource server*, reused verbatim by `04` writer-failover and `10` saga). The trust
boundary ("stranger code talks only through the local node") is asserted identically in all 12 §7
blocks. No drift to fix — this is the contract doing its job.

### A9 — MINOR GAP: `Ctx.ns` default ("caller's NodeId hex") collides with explicit single-node apps

Multiple docs (`00` §6, `08` §6, `09` §6, `11` §6) default empty `ns` to "the caller's own NodeId
hex". That is correct for isolation, but `01`/`02` resolve services by `service_key = "<ns>/<name>@<major>"`
— if a producer and consumer both default `ns` to their *own* (different) NodeIds, they will never
resolve each other. The docs assume a shared explicit `ns` for any cross-node service, which is right,
but it's an easy footgun.

**FIX (one line in `00` §6):** note that the empty-`ns` default is for **private, single-writer**
state only; **any service two different nodes must both find requires an explicit shared `ns`** (the
default is never a rendezvous namespace).

### Summary of fixes (all land before/with Wave 0, all S)

| # | Kind | Doc to edit | Fix |
|---|---|---|---|
| A1 | conflict | `00` §2/§4 | one `ce-scale-types` crate owns `Ctx`/`Status`/`Partial`; `ce-mesh`/`ce-rs`/`ce-coord` re-export |
| A2 | gap | `00` §2 | append-only field rule; zero is presence sentinel only where stated |
| A3 | overlap | `01`, `12` | rename the two `registry.rs` modules; share `version.rs` |
| A4 | inconsistency | all | normalize cross-reference filenames |
| A5 | overlap | `03` §10, `09` §10 | delete `ce-pubsub` app dedup on `Ctx.idem` adoption; pin 3-layer ownership |
| A6 | under-spec | `00` §5, `11` §4.1 | inbound pipeline is additive; stages tolerate each other's absence |
| A7 | minor | `00` §1 | bless read-only projections as a permitted category |
| A9 | minor | `00` §6 | empty-`ns` default is private-only, never a rendezvous |

---

## Part B — Dependency-Ordered Build Roadmap (waves)

Edges are "needs". The critical path from `00` §5 is **`Ctx` → 05 → 01 → 02 → {03,04,08} → {10,12}**,
with the node-plane trio (06/09/11) paralleling the early path and 07 unblocking 01. The roadmap below
is that graph, partitioned into waves where everything in a wave can be built in parallel once the
prior wave lands.

**Effort scale:** S ≈ days, M ≈ 1–2 wks, L ≈ 3–5 wks (single dev), per each doc's §10 self-estimate.

**Repo legend:** **NODE** = changes `ce/crates/ce-*` (the HOT node workspace — see Part C);
**coord** = `ce-coord` SDK crate; **app** = a new/extracted app crate; **rs** = `ce-rs` SDK;
**ts** = `ce-ts`/`@ce-net/*` mirror (always trails Rust, never on the critical path).

### Wave 0 — The keystone (nothing else can start)

| Build | Primitive | Repo/crate | Effort | Notes |
|---|---|---|---|---|
| `ce-scale-types` crate: `Ctx`, `Status`, `Partial<T>` | `00` §2/§4 (+fix A1) | **new crate** | S | no deps; the home for the three shared types |
| `Ctx` field on `AppRequest`/`AppMessage`/`AppPubSubMsg`; v-gated; pubsub sig domain `ce-app-pubsub-v2` | `00` §2 | **NODE** (`ce-mesh`) | M | **the single hot wire change everything rides** |
| `*_ctx` SDK variants (`request_ctx`/`send_message_ctx`/`publish_ctx`/`reply_ctx`); `AppMessage.ctx` | `00` §2 | rs | S | additive; old calls fill `Ctx::default()` |
| `ce-coord` pump threads `Ctx` through dispatch | `00` §2 | coord | S | every coordination msg auto-traced/namespaced |

**Gate:** pure additive, version-gated, old peers behave as today. Until this lands, every other doc
is blocked. This is also the **highest-risk NODE change** (touches the wire envelope) — land it, soak
it on the relay, before anything builds on it.

### Wave 1 — The node-plane trio (parallel; need only `Ctx`)

| Build | Primitive | Repo/crate | Effort | Notes |
|---|---|---|---|---|
| HLC stamp (`Hlc::{now,merge}`) on inbound/outbound; surface `AppMessage.hlc`; `GET /clock` | `09` (node half) | **NODE** (`ce-node`) | S | deterministic integer core, proptested |
| `(from,ns,idem)` dedup table → `AlreadyApplied`; `GET /dedup/stat` | `09` (node half) | **NODE** (`ce-node`) | S | lift `ce-pubsub/src/dedup.rs`, re-key (fix A5) |
| Admission gate (token bucket + credit/bond curve) as **first** inbound stage; `GET /admission`, `/admission/quota/:ns` | `11` | **NODE** (`ce-node`) | M | reads `ce-chain` balance/bond; integer core |
| Trace inject/forward (mint trace, child span, forward on send) | `06` (node half) | **NODE** (`ce-node`) | S | ~150 lines per `06` §10; copies 24 opaque bytes |
| CRDT `Sequence`/`next_batch` (`seq:next`) | `09` (coord half) | coord | S | 3-line `MergeMachine` over `Merged` |
| `ce-trace` SDK + ~200-line collector app + `ce-net.com/trace` viz | `06` (app half) | app + rs/ts | M | the operability payoff; the bulk of `06` |

**Recommended intra-wave landing order:** 09 (dedup+HLC) → 11 (admission) → 06 (trace) — see fix A6.
All four NODE deltas are in the §1 closed list (06/09/11) — **expected, pre-blessed hot changes**, but
each is small, generic, and additive. Wave 1 is where the bulk of the *remaining* HOT-repo work lives;
everything after Wave 2 is SDK/app.

### Wave 2 — The resilient data plane (needs Ctx + 09 dedup + 11 backpressure)

| Build | Primitive | Repo/crate | Effort | Notes |
|---|---|---|---|---|
| Node: honor `Ctx.deadline_ms` (abort + shrink-on-forward); consume 09 dedup for `AlreadyApplied`; structured `Status`+`retry_after_ms` reply | `05` (node half) | **NODE** (`ce-node`) | S | the two §1 rows already reserved; no new RPC |
| `ResilientClient` (retry oracle over `Status`, breaker FSM, backoff+jitter, retry budget) | `05` (SDK) | rs | M | pure caller policy; hedge/`call_service` deferred to slice 2 |
| `Coord::rpc()` so 03/04/08 inherit deadlines/retry/breaker | `05` | coord | S | wires the data plane under all coordination |

**Gate:** this is the last hard NODE dependency on the critical path. After Wave 2, **everything is
coord/app/SDK** — Part C's coordination concern drops to near zero.

### Wave 3 — Telemetry, then discovery, then placement (mostly node-export + coord)

| Build | Primitive | Repo/crate | Effort | Notes |
|---|---|---|---|---|
| Widen capacity broadcast + `/atlas` with `rps`/`err_rps`/`lat_buckets`; inbound RED tally | `07` (node export) | **NODE** (`ce-node`) | S | widen 2 existing fns; no new route/RPC |
| `ce-rs::Metrics` exporter + `ce-coord::SliAtlas` (`Merged<SliState>`) + `__health`/`HealthReporter` | `07` (coord/SDK) | rs + coord | M | leaderless fold; unblocks 01/02 |
| `GET /peers` (PeerId↔NodeId projection) | `02` (node read) | **NODE** (`ce-node`) | S | read-only projection (fix A7); closes `locate.rs:23` gap |
| Service registry: `SemVer`/`VersionReq`, `Health` book (`Merged`), `register`/`resolve`/`bind` | `01` | coord | M | over existing `find_service`+`locate.rs`; rename per A3 |
| Latency+backpressure-aware selector (`rank_instances`, ejection, `Balance::*`, `Balancer`) | `02` | rs + coord | M | unify `locate.rs` + `ce-gke::placement` |

**Note:** `07` ships *before* `01` (health signal) and `01` before `02` (candidate source) — strict
intra-wave order, but all three are coord/SDK except the two small node reads/widenings.

### Wave 4 — Durable coordination substrates (parallel after 01/02)

| Build | Primitive | Repo/crate | Effort | Notes |
|---|---|---|---|---|
| `ce-queue` (extract `ce-pubsub`): thread `Ctx`, `max_outstanding`, `ModifyDeadline`, ns-scope | `03` | app (extract `ce-pubsub`→`ce-queue`) | M | engine exists; conformance + 2 features. Delete app dedup (A5) |
| Event log: `PartitionLog`, consumer-group offsets (`Merged<GroupOffsets>`), compaction, assignment | `04` | coord | L | port `ce-pubsub/src/log.rs` algebra; single-writer first |
| Raft group engine + lock/lease/election + `Fence` | `08` | coord | L | the Raft core is the bulk; 1-member degenerate slice first |

**Sequencing inside the wave:** `08`'s Raft and `04`'s consumer groups are the two L items and can be
built in parallel by different efforts; `03` is M and unblocks `10` first, so prioritize `03`. `04`
and `08` cross-reference (writer failover = an `08` lease) but each ships a single-writer/1-member
slice that doesn't need the other.

### Wave 5 — The composers (last; compose everything below)

| Build | Primitive | Repo/crate | Effort | Notes |
|---|---|---|---|---|
| Schema registry (`Replicated<SchemaRegistry>` + `check_compat`) + config/flags (`Merged<ConfigState>`) | `12` | coord | M | rename per A3; JsonSchema compat checker is the crown-jewel test |
| Saga engine (`SagaState` machine, forward/compensate driver) over 03+08+09 | `10` | app (new `ce-saga`) | L | reuses 03/08/09 wholesale; single-node slice first |

**Gate:** both consume the full stack. `12` validates payloads for `03`/`04`; `10` orchestrates over
`03`/`08`/`09`. Pure coord/app — zero NODE change.

### One-page wave summary

```
Wave 0  Ctx keystone ........................ ce-scale-types + NODE(ce-mesh) + rs + coord   [HOT: wire]
Wave 1  06 trace | 09 hlc+dedup | 11 admit ... NODE(ce-node) ×3 + coord + app(collector)    [HOT: §1 rows]
Wave 2  05 resilient RPC ..................... NODE(ce-node, small) + rs + coord             [HOT: last]
Wave 3  07 → 01 → 02 ......................... NODE(2 small reads/widen) + rs + coord
Wave 4  03 | 04 | 08 ......................... app(ce-queue) + coord ×2                      [no NODE]
Wave 5  12 | 10 ............................. coord + app(ce-saga)                           [no NODE]
```

---

## Part C — HOT node-repo (`ce/`) edits flag (needs careful coordination)

`ce/` (the node) is HOT — multiple agents work it in parallel and it must never break the live mesh or
gain an `ce-rs` dependency (`MEMORY.md`). **Every node-plane edit is concentrated in Waves 0–3 and is
small, additive, generic, and version-gated.** After Wave 3 the scaling layer touches the node *zero*
more times. The complete list of HOT edits, in order:

| Wave | HOT edit | File(s) | Risk | Why it's safe |
|---|---|---|---|---|
| 0 | `Ctx` on the 3 wire types; pubsub sig v2 | `ce/crates/ce-mesh/src/lib.rs` | **highest** (wire format) | additive, `Ctx.v`-gated; old peers read `Default`; soak on relay first |
| 1 | HLC stamp + `/clock` | `ce/crates/ce-node` | low | pure integer clock; no consensus impact |
| 1 | dedup table + `/dedup/stat` | `ce/crates/ce-node` | low | bounded LRU+TTL; lifts proven `ce-pubsub` code |
| 1 | admission gate + `/admission*` | `ce/crates/ce-node` (+ reads `ce-chain`) | medium | first inbound stage; integer curve; reads ledger it already holds |
| 1 | trace inject/forward | `ce/crates/ce-node` | low | copies 24 opaque bytes; best-effort, never fails a call |
| 2 | deadline abort + shrink-on-forward; consume dedup; structured `Status` reply | `ce/crates/ce-node` | low–medium | both rows pre-reserved in `00` §1; reuses Wave-1 table |
| 3 | widen capacity broadcast + `/atlas` (`rps`/`err_rps`/`lat_buckets`) | `ce/crates/ce-node` | low | widens 2 existing fns; `#[serde(default)]` |
| 3 | `GET /peers` projection | `ce/crates/ce-node` | low | read-only; data the swarm already holds |

**Coordination rules for the HOT edits:**

1. **Wave 0's `ce-mesh` change is the one to serialize hardest.** It is the only wire-format change;
   it must land alone, behind `Ctx.v`, and soak on the relay (`ce start --no-mine`) before Wave 1
   builds on it. Pair-review it; do not batch it with other node work.
2. **All Wave-1/2 inbound-path edits touch the same dispatch path** (`MeshEvent::IncomingRpc` /
   `AppInbox`). They are additive *stages* (admission → deadline → dedup → cap → dispatch) and must be
   written to tolerate each other's absence (fix A6) so they can land in any order without a half-wired
   pipeline. Whoever lands second rebases onto the first's stage insertion point.
3. **No NODE edit may pull in `ce-rs`/`ce-coord`** (the boundary CI gate). `Ctx`/`Status` live in
   `ce-scale-types` (fix A1) precisely so the node can use them without depending on app code.
4. **Everything Wave 4–5 is safe (`ce-coord`/app/`ce-rs`)** — no coordination with HOT-repo agents
   needed. The two L items there (`04` event log, `08` Raft, `10` saga) are the biggest *builds* but
   the *least risky* to the running mesh.

Net: ~9 small HOT edits, all in the first four waves, all additive/generic/gated. The riskiest is one
wire-format change (Wave 0); the rest are inbound-path stages and read-only projections.

---

## Part D — The 2–3 primitives that make CE *visibly* a global supercomputer (for demos/games)

The brief's goal is a demo where a game/app *looks* like it's running on one giant machine spread
across phones, laptops, and datacenter nodes. Three primitives do the visible heavy lifting; the rest
are plumbing that makes them trustworthy. Each is paired with the showcase that should ship it.

### D1 — **02 Load-balancing & latency-aware placement** → the sharded multiplayer game (task #5)

This is **the** "global supercomputer" primitive: 64 world shards spread across a mesh of mixed home +
datacenter + phone nodes, with every player's action routed to the **nearest healthy least-loaded**
shard, failing over and ejecting backpressured hosts live. The visible magic is geographic: an EU
player talks to the EU replica, a US player to the US replica, the world stays consistent
(`Rendezvous` sticky sharding), and when a shard saturates the balancer *drains around it in real
time*. It is built on data the node already publishes (atlas + netgraph + `/peers`), so it demos with
zero new infra. **Showcase:** the sharded game backend in `02` §9 / `08` §9 — one world, 128 instances
(64 shards × 2 replicas), running on whatever nodes are online. The latency-aware `pickFor(shard)` from
a phone is the screenshot that says "supercomputer".

### D2 — **06 Distributed tracing** → a live "watch the action cross the mesh" visualizer (`ce-net.com/trace`)

The single most *legible* primitive: one player move fans across gateway → shard → `ce-db` → fan-out,
on 3–4 nodes, and the trace view draws it as **one causal tree** with per-hop latency, retries, and
throttles — automatically, because every hop carries `Ctx`. This is what makes the distribution
*visible* rather than abstract: an audience sees a single click light up a tree of work spanning
machines they can point at on a map. It is also the cheapest to ship (Wave 1, ~150 node lines + a
200-line collector) and every later primitive feeds it for free. **Showcase:** a split-screen demo —
the game on one side, `ce-net.com/trace` on the other, a move rippling across the node tree in real
time (`06` §9). This is the "global supercomputer dashboard."

### D3 — **08 Locks/leases/election (+ fencing)** → the sharded game's *correctness* story, and a "one matchmaker, many nodes" demo

The primitive that makes the supercomputer **trustworthy under failure**, which is the part skeptics
push on: exactly-one-owner-per-shard with a monotone fencing token, so a GC-paused "zombie" node's
stale write is *provably refused* and the world never desyncs or dupes loot. The demo is a kill: pause
the node simulating sector-7 mid-match, watch a sibling take over within an election timeout, then
watch the zombie wake and get **fenced out** at the resource server — no double-simulation. Paired with
`elect()` for a single global matchmaker that survives any node's death. **Showcase:** the
sector-handoff + zombie-fence scenario in `08` §9 (and the saga match-lifecycle in `10` §9 that
composes it) — "kill any node, the game keeps running correctly" is the line that sells distribution as
*real*, not best-effort.

**Why these three (and the supporting cast):** `02` makes it *look* distributed (geographic routing
across a live mesh), `06` makes it *visible* (one action drawn across the node tree), `08` makes it
*believable under failure* (kill a node, nothing breaks or dupes). `11` (admission) is the quiet hero
that lets a phone safely host a shard next to other apps without one client sinking it — worth a
sentence in the demo ("this node is also running `ce-db`, and the game can't starve it") but not a
headline. `03`/`04`/`10` are the durability spine the game needs to be *real* rather than a toy, but
they don't *photograph* as "supercomputer" the way routing, tracing, and failover do.

**Single best demo:** the **sharded multiplayer game** (task #5) on one screen + **`ce-net.com/trace`**
on the other, then **kill a node** live. That one scene exercises D1 (routing), D2 (tracing), and D3
(fencing/failover) at once — the whole "global supercomputer you can watch and can't break" thesis in
thirty seconds.
