# CE Scaling Layer — Shared Architecture Contract

**Status:** normative. Every per-primitive design (`01-…` through `12-…`) MUST conform to this
document. Where a primitive design disagrees with the contract, the contract wins until amended
here. Ground truth this is built on: `ce/docs/primitives.md`, `ce/docs/frontier.md`,
`ce/crates/ce-mesh/src/lib.rs` (RpcRequest/RpcResponse + `ce-app/<topic>` gossip),
`ce/crates/ce-cap/src/lib.rs` (`Capability { abilities, resource, caveats }`), `ce-rs/src/lib.rs`
(the SDK: `request`/`reply`/`publish`/`subscribe`/`messages`, `atlas`, `advertise_service`/
`find_service`, `resolve_name`, `put_object`/`get_object`, channels, `mesh_deploy`/`mesh_kill`),
and `ce-coord/src` (`Stream`, `RMap`, `Merged`, `Replicated`, the inbox pump).

---

## 0. The one rule

> **The node owns generic transport/enforcement. `ce-coord` owns coordination.**

This is the `primitives.md` rule (`CE owns generic, node-enforced mechanism; apps own policy`)
specialised for the scaling layer. Two planes, one hard boundary:

- **Node plane** (`ce-node` / `ce-mesh`, Rust, privileged): the *mechanism a peer must enforce
  before acting on a request, or that must ride on every hop regardless of app* — context
  propagation, deadlines, idempotency dedup, flow control, rate limiting, admission. These touch
  the wire envelope and the local enforcement point, so they cannot be a library.
- **Coordination plane** (`ce-coord` SDK over `ce-rs`, Rust library, unprivileged): the *typed
  coordination APIs* — registry, binding, queue, log, locks, election, saga, schema registry.
  These are pure clients of the node's three generic verbs (`request`/`reply`, `publish`/
  `subscribe`, `messages`) plus `advertise_service`/`find_service`, `atlas`, blobs, and the
  `ce-coord` Raft/RMap/Merged engines. They are not privileged and run as ordinary apps.

**Non-negotiable consequences** (from `primitives.md` "design invariants"):

1. **No new ad-hoc node RPCs** where a generic `AppRequest` + pubsub + stream suffices. A scale
   primitive earns a node-plane change ONLY if it must be enforced on the wire by a peer that does
   not run the app (flow control, rate limit, dedup, deadline, trace inject). Everything else is a
   `ce-coord` typed API over the existing three verbs. The litmus test from `primitives.md`
   applies verbatim: *product semantics → app; a byte/key/coin mechanism every app reinvents →
   primitive.*
2. **Stranger code talks ONLY through the local node.** An app never opens a raw socket to a
   remote peer. It calls `ce-rs`, the local node authenticates the *sender* (`AppMessage.from`
   is a verified NodeId — `ce-mesh` checks it against the Noise PeerId), and authorizes via a
   signed attenuating `ce-cap` chain. This is the security invariant for the whole layer.
3. **`ce-cap` stays app-vocabulary-free.** Abilities are opaque strings (§3). The verifier never
   learns what `queue:consume` means; it only checks the chain authorizes that exact string on
   the resource. No scale primitive may add reputation/ratio/policy to the hard authz path
   (the CI boundary gate that fails if `ce-cap` depends on `ce-ratio` still holds).

### 0.1 The 12 primitives — one-line placement

| # | Primitive | Plane | Why it lives there |
|---|---|---|---|
| 01 | Service registry / binding / health | **coord** (over `advertise_service`/`find_service` DHT + `atlas`) | resolution + dependency wiring is a typed client API; the node already owns the DHT records |
| 02 | Load balancing / placement | **coord** (over `atlas` + 01) | host/instance selection is a client decision over data the node already publishes |
| 03 | Durable work queue | **coord** (productize `ce-pubsub`) + **node delivery** | ack/lease/retry/DLQ state is app-owned; the node only delivers `AppMessage`/pubsub |
| 04 | Event log / replayable stream | **coord** (over `ce-coord` `Merged`/`RMap` logs + content-addressed blobs) | offsets/consumer-groups/compaction are coordination state over the blob store |
| 05 | Resilient RPC | **NODE transport** + **SDK client** | deadline propagation, hedging, circuit-break, idempotency-on-call ride the envelope/wire |
| 06 | Distributed tracing | **NODE transport** (inject/forward) + **collector app** | the node MUST stamp/forward the trace context on every hop; the collector is an app |
| 07 | Telemetry / metrics / SLIs | **node export** + **coord aggregation** (extend `atlas`) | the node exports its own counters; aggregation/dashboards are a coord client |
| 08 | Locks / leases / election | **coord** (over a `ce-coord` Raft group) | linearizable mutual exclusion is a coordination protocol, already an SDK engine |
| 09 | Causal time / idempotency / counters | **NODE** (HLC stamp + dedup) + **coord** (CRDT counters) | the clock + dedup table are node-plane enforcement; sequences are CRDT/chain |
| 10 | Saga / workflow | **coord** (over 03 + 08 + Raft) | durable cross-app orchestration composes coord primitives; nothing for the node to enforce |
| 11 | Flow control / rate limit / quota / admission | **NODE enforcement**, economy-tied | admission decisions must be enforced by the receiving node before it does any work |
| 12 | Schema / contract / config registry | **coord** | versioned IDL + config distribution is replicated coordination state |

Three primitives touch the node plane (05, 06, 09, 11 — see §1). The rest are pure `ce-coord`.

---

## 1. What may change in the node plane (the closed list)

The node plane changes are deliberately small and **cross-cutting**: each is something that must
ride every hop or be enforced by a peer that does not run the app. They are additive to the
existing wire types in `ce-mesh` and never app-specific.

| Node-plane change | Owned by | What it adds |
|---|---|---|
| **The envelope** (§2) | `ce-mesh` | a `Ctx` header on every `AppRequest`/`AppMessage`/`AppPubSubMsg`, carrying trace, deadline, idempotency key, cap token, tenant. The single wire-format change the whole layer depends on. |
| **Deadline enforcement** (05) | `ce-node` inbound dispatch | the node drops/aborts work whose `Ctx.deadline` has passed; on an outbound forwarded hop it shrinks the remaining budget (§5). |
| **Trace inject/forward** (06) | `ce-node` inbound + `ce-rs` outbound | the node generates a span on receive, forwards `Ctx.trace`/`Ctx.span` on every onward call. App code never has to thread it. |
| **Idempotency dedup** (09) | `ce-node` inbound | a bounded dedup table keyed by `(from, Ctx.idem)` so a retried `AppRequest` is served from cache, not re-executed. Enforced before the app sees it. |
| **Admission / rate limit / quota** (11) | `ce-node` inbound | per-`(identity, ability, tenant)` token buckets + credit-backed quota; the node returns `429`/`Status::Throttled` before dispatch. Economy-tied: paying credits raises the bucket. |

Everything else — registry, binding, queue semantics, log offsets, locks, saga, schema — is
`ce-coord` library code with **zero** node changes. If a primitive design proposes a new
`RpcRequest` variant, it must justify it against this table or it is rejected.

---

## 2. The common envelope (`Ctx`)

Every cross-cutting concern travels in one struct stamped onto the existing wire types. It is
**not** a new transport — it extends `AppRequest`/`AppMessage`/`AppPubSubMsg` (today
`{ from_node, topic, payload }`). The node treats `Ctx` as transport metadata; `payload` stays
opaque app bytes.

```rust
// ce-mesh: new wire type, bincode, versioned. Added alongside RpcRequest::AppRequest.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Ctx {
    /// Wire-format version of this header (start at 1). Lets the node skip fields it predates.
    pub v: u8,

    // ---- tracing / causality (primitive 06, 09) ----
    /// 16-byte trace id; constant for one logical user action across N app hops. Zero = none yet
    /// (the receiving node mints one and stamps it on every onward hop).
    pub trace: [u8; 16],
    /// 8-byte span id of the *caller's* current span; the callee opens a child of this.
    pub parent_span: [u8; 8],
    /// Hybrid logical clock reading of the sender at send time (primitive 09): (wall_ms, counter).
    /// Gives causal order across apps without a central clock. Receiver merges it into its HLC.
    pub hlc: (u64, u32),

    // ---- reliability (primitive 05, 09) ----
    /// Absolute deadline as unix-ms. The node aborts work past it and shrinks the budget on
    /// forward. Zero = no deadline. NEVER a relative timeout (clocks differ; absolute survives hops).
    pub deadline_ms: u64,
    /// Idempotency key for exactly-once effect of a retried call (primitive 09 dedup table). 16
    /// bytes, caller-chosen, stable across retries of the *same* logical call. Zero = at-most-once.
    pub idem: [u8; 16],

    // ---- authorization (the security invariant) ----
    /// Signed attenuating ce-cap chain (bincode of `Vec<SignedCapability>`), opaque to transport —
    /// exactly as `RpcRequest::Deploy.grant` already carries it. The receiving node's enforcement
    /// point verifies it authorizes the ability this call needs (§3) before dispatch. Empty =
    /// rely on the sender's own NodeId (self-authorized, e.g. talking to one's own fleet).
    pub cap: Vec<u8>,

    // ---- multi-tenancy (§6) ----
    /// Namespace this call belongs to: "<app>/<tenant>" (e.g. "ce-db/acme"). Scopes topics,
    /// idempotency, rate-limit buckets, and metrics so apps/tenants never collide. Empty = the
    /// caller's own NodeId hex (a private, per-key namespace).
    pub ns: String,
}
```

Carriage on each existing wire type (additive, version-gated by `Ctx.v`):

```rust
// ce-mesh::RpcRequest — AppRequest/AppMessage gain `ctx: Ctx`. Old peers that predate v deserialize
// it as Default (all-zero) and behave exactly as today (no trace, no deadline, at-most-once).
AppRequest { from_node: NodeId, ctx: Ctx, topic: String, payload: Vec<u8> },
AppMessage { from_node: NodeId, ctx: Ctx, topic: String, payload: Vec<u8> },

// ce-mesh::AppPubSubMsg — gains `ctx: Ctx`; the publisher's signature already covers
// (topic, payload, nonce) and MUST extend to cover ctx (domain-separated `ce-app-pubsub-v2`).
pub struct AppPubSubMsg { pub from: NodeId, pub ctx: Ctx, pub topic: String, pub payload: Vec<u8>,
                          pub nonce: u64, pub sig: Vec<u8> }
```

**SDK surface.** `ce-rs` gains `*_ctx` variants (`request_ctx`, `send_message_ctx`,
`publish_ctx`) taking an explicit `Ctx`; the existing `request`/`send_message`/`publish` keep
working and fill `Ctx::default()` + a fresh `idem`/`trace` when absent. `AppMessage` (the inbox
type) gains a `ctx: Ctx` field next to `reply_token`. `ce-coord`'s pump threads `Ctx` through so
every coordination message is automatically traced/namespaced.

**Node responsibilities for `Ctx`** (the only behavior the node enforces, all generic):
1. On receive: if `trace == 0`, mint one. Open a child span of `parent_span`. Merge `hlc`.
2. If `deadline_ms != 0` and now ≥ it → reject `Status::DeadlineExceeded`, do no work.
3. If `idem != 0` → look up `(from, ns, idem)` in the dedup table; on hit, return the cached
   result; on miss, run and cache.
4. Verify `cap` authorizes the required ability (§3) on this resource; else `Status::Unauthorized`.
5. Apply the §6 namespace + §11 rate-limit bucket keyed by `(from, ns, ability)`.
6. On any onward `ce-rs` call the node/app makes, copy `trace`, set `parent_span` to the current
   span, and recompute `deadline_ms` (never extend it). This is deadline propagation.

The app payload is never inspected. `Ctx` is the entire cross-cutting contract.

---

## 3. Capability ability naming convention

Abilities are **opaque `ce-cap` strings** (`Capability.abilities: Vec<String>`), exactly like the
existing `CE_CLOUD_ACTIONS` (`storage:read`, `db:write`, `run:invoke`, `tunnel`). The verifier
treats them as bytes; the convention is for humans and for attenuation (`is_subset_of` is string
membership). Scale primitives reserve these prefixes:

```
svc:register      svc:resolve       svc:deregister        # 01 registry/binding
place:read                                                 # 02 LB reads atlas/SLIs (usually no cap)
queue:produce     queue:consume     queue:admin            # 03 durable queue (consume = ack/nack/lease)
log:append        log:read          log:admin              # 04 event log (admin = compaction/retention)
rpc:call                                                    # 05 invoke a service method (often the app's own ability)
trace:write       trace:read                                # 06 emit spans / read the collector
metrics:write     metrics:read                              # 07 export SLIs / read dashboards
lock:acquire      lock:release      lock:elect              # 08 locks / leases / leader election
seq:next                                                    # 09 allocate from a distributed counter
saga:start        saga:step         saga:admin              # 10 workflow control
quota:admin                                                 # 11 set/raise a tenant quota (rate limits are economy-gated, not cap-gated by default)
schema:publish    schema:read       config:write   config:read   # 12 contract + config registry
```

Convention rules (normative):

- Format `domain:verb` (single colon, lowercase, `a-z0-9-`). `domain` = the primitive/app
  surface, `verb` = the action. This mirrors `storage:read`.
- A scale primitive **adds its abilities to a documented action universe** so `ce-iam` wildcard
  expansion works (`Iam::with_action_universe`), but it **does not** add them to `ce-cap` —
  abilities stay opaque to the verifier (`primitives.md` invariant).
- Resource scoping uses the existing `ce-cap::Resource` (`Any` / `Node(id)` / `Tag(t)` /
  `AllOf(tags)`). A queue/lock/log name is carried as a `Tag` (e.g. `Tag("queue:orders")`), so a
  grant can say "consume from `queue:orders` only" by attenuating resource, not ability.
- Caveats (`ce-cap::Caveats`) carry expiry (`not_after`) and any numeric ceilings; attenuation is
  the existing `is_narrower_or_equal`. No new caveat machinery for scale.

The whole authorization story is therefore: a call carries `Ctx.cap` (an attenuating chain), the
receiving node verifies it grants the `domain:verb` the handler requires on the named resource.
No central policy server, consistent with `ce-iam`'s inverse-of-AWS-IAM model.

---

## 4. Error / status model & partial failure

One status enum, carried in replies, mapped 1:1 to the existing surfaces (`RpcResponse::Error`,
HTTP status codes). It is intentionally small and gRPC-shaped so retry/circuit-break logic (05) is
uniform.

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Status {
    Ok,
    // --- caller's fault: do NOT retry ---
    InvalidArgument,     // malformed request / schema mismatch (12)
    Unauthorized,        // ce-cap chain missing/insufficient (§3)
    NotFound,            // no such service/queue/lock/object (01/03/08)
    FailedPrecondition,  // e.g. lock held by another, version conflict (08, 04)
    // --- transient: SAFE to retry (subject to budget) ---
    Unavailable,         // peer down / no healthy instance (01, 05 circuit-break)
    DeadlineExceeded,    // Ctx.deadline passed (05)
    ResourceExhausted,   // rate-limited / quota hit (11) — carries Retry-After
    Aborted,             // optimistic-concurrency / lock-fencing conflict; retry the txn (08, 10)
    // --- server's fault: retry only if idempotent (Ctx.idem set) ---
    Internal,
    // --- exactly-once dedup hit: the cached prior result follows ---
    AlreadyApplied,      // (09) idem key seen; result is the original effect, not a re-run
}
```

Mapping: `Status` → HTTP (`Unauthorized`=403, `NotFound`=404, `ResourceExhausted`=429,
`DeadlineExceeded`=504, `Unavailable`=503, `FailedPrecondition`/`Aborted`=409, `Internal`=500),
and → `RpcResponse::Error(String)` carries `"{status}: {detail}"` for old peers. A reply may carry
a `retry_after_ms` and the `Ctx.trace` so a failure is traceable end to end.

**Retryability is a property of the status, not the caller's guess** (05 reads this table). Only
`Unavailable`/`DeadlineExceeded`/`ResourceExhausted`/`Aborted` are auto-retried; `Internal` is
retried only when `Ctx.idem` is set (exactly-once via the §2 dedup table). `AlreadyApplied`
means a retry already took effect — treat as success.

**Partial failure** (fan-out: 02 placement, 03 queue batches, 04 multi-partition reads, 10 saga
steps): never collapse to a single bool. The aggregate result is

```rust
pub struct Partial<T> { pub ok: Vec<(NodeId, T)>, pub failed: Vec<(NodeId, Status)> }
```

so a caller sees *which* instances succeeded and *which* status each failure carried. Saga (10)
turns any `failed` entry into a compensation; placement (02) routes around `Unavailable`
instances and feeds them back to the registry (01) health signal; queue (03) re-leases only the
`failed` messages. **No primitive may report success while hiding a partial failure.** A
quorum/threshold result states the threshold and the actual `ok`/`failed` split.

---

## 5. Dependency graph & build order

Edges = "A is built on / requires B". Read top-down: lower layers ship first.

```
                 ┌───────────────────────────────────────────────┐
   node plane    │  ENVELOPE Ctx  (§2)  — the keystone, ship FIRST │
                 └───────────────────────────────────────────────┘
                        │ everything below stamps/reads Ctx
        ┌───────────────┼───────────────────────────────┐
        ▼               ▼                                ▼
  06 tracing      09 causal time / idem            11 flow ctrl / rate
  (node inject)   (node HLC + dedup)               (node admission, economy)
        │               │                                │
        │   ┌───────────┴───────────┐                    │
        ▼   ▼                       ▼                    │
  05 resilient RPC <──────── (deadline+idem from 09)     │
  (deadlines, retry,                                     │
   hedge, circuit-break) ──────────────────────────────┘ (backpressure ⇄ 11)
        │
        ▼
  07 telemetry / SLIs  ── exports over 05/06, aggregated into atlas
        │  (health signal)
        ▼
  01 service registry / binding / health  ── consumes 07 health, atlas, DHT
        │
        ▼
  02 load balancing / placement  ── picks healthy(01) least-loaded(07) nearest(atlas)
        │
   ┌────┴───────────────┬──────────────────┐
   ▼                    ▼                  ▼
  03 durable queue    04 event log       08 locks/leases/election
  (pubsub+lease+DLQ)  (Merged/RMap+blobs)(ce-coord Raft)
   └────────┬───────────┴────────┬────────┘
            ▼                     ▼
        10 saga / workflow   12 schema / contract / config registry
        (queue+locks+idem)   (coord state; gates every payload via 04/03)
```

**Build order** (each ships behind tests + a `NN-…md` design that cites this contract):

0. **`Ctx` envelope** (§2) + `Status` (§4) in `ce-mesh`/`ce-rs`/`ce-coord`. Nothing else can
   start without it. Pure additive wire change, version-gated.
1. **06 tracing**, **09 causal/idem**, **11 flow control** — the node-plane trio. Independent of
   each other; all three only need `Ctx`. Tracing first (highest operability leverage, per
   `frontier`/the brief), then 09 (dedup table 05 depends on), then 11.
2. **05 resilient RPC** — needs `Ctx` deadlines + 09's idempotency dedup; trades backpressure
   signals with 11. The service-mesh data plane; everything coordination sits on it.
3. **07 telemetry** — exports over 05/06, aggregated by extending the existing `atlas`.
4. **01 registry/binding/health** — consumes 07's health signal + `atlas` + the DHT
   (`advertise_service`/`find_service`). The "dependencies" mechanism.
5. **02 load balancing/placement** — selects over 01 (healthy) + 07 (least-loaded) + atlas
   (nearest).
6. **03 queue**, **04 event log**, **08 locks/election** — the three durable coordination
   substrates; parallel after 01/02. 03 productizes `ce-pubsub`; 04 builds on `ce-coord`
   `Merged`/`RMap` + blobs; 08 on the `ce-coord` Raft group.
7. **10 saga** (over 03 + 08 + 09) and **12 schema/config registry** (coord state; validates
   payloads for 03/04). Last — they compose everything below.

Critical path: **`Ctx` → 05 → 01 → 02 → {03,04,08} → {10,12}**. The node-plane trio (06/09/11)
parallels the early path; 07 unblocks 01.

---

## 6. Multi-tenancy & namespacing

Many apps (`ce-db`, `ce-pubsub`, `ce-gke`, `ce-query`, games) share one mesh, one DHT, one set of
gossip topics, one node. Without scoping their topics/state/identity collide. The contract:

**One namespace string, `Ctx.ns = "<app>/<tenant>"`**, scopes everything, derived from the
existing `ce-app/<topic>` convention rather than a new mechanism:

- **Gossip topics** (03 queue, 04 log fan-out, 07 pubsub): the wire topic is
  `ce-app/<ns>/<logical>` — e.g. `ce-app/ce-db/acme/changes`. This extends the existing
  `APP_TOPIC_PREFIX = "ce-app/"` so CE-internal topics (`ce-blocks`, …) can never collide, and
  two tenants of the same app never cross-deliver. The node subscribes/publishes by full topic.
- **Directed messages** (`request`/`send_message`): `Ctx.ns` + `topic` together key the local
  app's handler dispatch (`ce-coord` already does exact-topic dispatch; it gains an `ns` prefix).
- **Coordination state** (`ce-coord` `RMap`/`Merged`/`Stream`, 04/08/10/12): the replica key is
  `(ns, name)`. A reader follows `(ns, name, writer_node_id)`; a Raft group (08) is named
  `(ns, group)`. Two apps' `"orders"` queues are distinct state.
- **Idempotency + rate-limit + metrics buckets** (09/11/07): all keyed by `(from, ns, ability)`,
  so one tenant's retries/quota/SLIs are isolated; one app cannot exhaust another's bucket.
- **Service registry** (01): a service is advertised under `service_key = "<ns>/<name>@<major>"`
  over the existing `advertise_service`/`find_service` DHT, so versioned, namespaced resolution
  reuses the node's DHT records unchanged.
- **Identity scope:** the principal is always the real NodeId (`AppMessage.from`, node-verified).
  `ns` is **not** identity — it is a routing/state scope. Authorization is still the `ce-cap`
  chain in `Ctx.cap`; a grant can pin a tenant by scoping its `Resource` to `Tag("ns:acme")`, so
  "this key may `queue:consume` only in `ce-db/acme`" is expressible without any node concept of a
  tenant. The node enforces it generically; "tenant" remains an app/cap notion, never a CE type.

Default: empty `ns` ⇒ the caller's own NodeId hex — a private, collision-free per-key namespace,
so an app that doesn't care about multi-tenancy gets isolation for free.

---

## 7. What every per-primitive design MUST state

Each `NN-<name>.md` opens with a conformance block:

1. **Plane** — node vs coord, and the §0/§1 justification (if node-plane, which row of the §1
   closed list; if it proposes a new `RpcRequest`, the justification against §1).
2. **Abilities** — the `domain:verb` strings it reserves (§3) and their resource scoping.
3. **Envelope use** — which `Ctx` fields it reads/writes (§2); confirm it adds no parallel header.
4. **Status & partial failure** — which `Status` variants it returns and its `Partial<T>` shape (§4).
5. **Dependencies** — its in-edges in the §5 graph; confirm build order.
6. **Namespacing** — its topic/state key under §6.
7. **Boundary check** — one sentence asserting it does not put app policy in the node and does not
   require stranger code to bypass the local node.

A design that cannot fill this block has the boundary wrong and is sent back.
