# 06 — Distributed tracing & context propagation

**Status:** implementation-ready design. Conforms to `00-architecture.md` (the contract wins on any
disagreement). Ground truth cited inline: `ce/crates/ce-mesh/src/lib.rs` (`RpcRequest::AppMessage`/
`AppRequest`, `RpcResponse::AppReply`, `AppPubSubMsg`, `app_pubsub_bytes`, `APP_TOPIC_PREFIX`,
`MeshEvent::IncomingRpc`/`AppGossip`), `ce/crates/ce-node/src/api.rs` (`send_message`, `mesh_request`,
`mesh_reply`, `subscribe_topic`, `publish_topic`, the `AppMessage` inbox + SSE),
`ce-rs/src/lib.rs` (`send_message`/`request`/`reply`/`publish`/`subscribe`/`messages`/
`messages_stream`, `AppMessage`, `put_object`/`get_object`, `channel_open`/`sign_receipt`),
`ce-coord/src/lib.rs` (the inbox pump `spawn_pump`/`dispatch`, `Handler`, `Dedup`/`fingerprint`),
`ce/docs/primitives.md` (the CE-vs-app boundary).

## Conformance block (architecture §7)

1. **Plane** — **split: NODE transport (inject/forward) + a collector app.** Per architecture §0.1
   row 06 and §1 row "Trace inject/forward". The node-plane part is the §1-sanctioned, generic
   behavior that *must* ride every hop: on receive the node mints/continues a trace, opens a child
   span of `Ctx.parent_span`, and on every onward `ce-rs` call stamps `Ctx.trace` + the current
   span as `parent_span`. This is enforcement-point work an app library cannot do (the app never
   sees the wire), so it is the node — but it is fully app-vocabulary-free (it copies 24 opaque
   bytes; it never inspects `payload`). **No new `RpcRequest` variant** is added: the trace context
   rides the existing `Ctx` header (architecture §2) already carried on `AppMessage`/`AppRequest`/
   `AppPubSubMsg`. The collector/visualizer is an ordinary **coord/app**: spans are emitted as
   normal `AppMessage`/`publish` payloads to a collector NodeId and stored as content-addressed
   blobs — zero node knowledge of "span".
2. **Abilities** — reserves `trace:write` (emit a span to a collector) and `trace:read` (query the
   collector / read the visualizer), architecture §3. Resource-scoped by
   `ce-cap::Resource::Tag("trace:<ns>")` so a grant can say "may `trace:write` only into namespace
   `ce-db/acme`". The on-the-wire trace *context* itself needs **no** ability — it is transport
   metadata the node copies generically (like a TCP option), exactly as deadline/idem are not
   cap-gated; only *talking to the collector app* is.
3. **Envelope use** — reads/writes `Ctx.trace` (16-byte trace id), `Ctx.parent_span` (8-byte caller
   span), and `Ctx.hlc` (the HLC reading orders spans causally without a wall clock — primitive 09),
   plus `Ctx.ns` (the collector instance + topic namespace) and `Ctx.cap` (authorizes `trace:write`
   to the collector). It writes back `Ctx.trace` onto the **reply path** so a failure `Status`
   (architecture §4) is traceable end to end. Adds **no parallel header** — the whole context is the
   three `Ctx` fields already defined in §2.
4. **Status & partial failure** — the *tracing mechanism never changes a call's status*: a dropped
   span MUST NOT fail the business call (spans are best-effort, fire-and-forget — §5 below). Calls to
   the collector app return `Ok`, `Unauthorized` (`trace:write` missing), `ResourceExhausted`
   (collector rate-limited the writer — primitive 11), `Unavailable` (collector down → the SDK
   buffers/drops, never blocks). A multi-segment trace assembled from N partial reporters is a
   `Partial<SpanBatch>` (architecture §4): the visualizer shows which hops reported and flags hops
   that did **not** (a gap is data, never hidden).
5. **Dependencies** — in-edges (architecture §5): the **`Ctx` envelope** (§2, the keystone — trace
   lives entirely in it); **09 causal time / idempotency** (`09-causal-time-idempotency.md`) for the
   HLC that timestamps and causally orders spans across apps and for the dedup key that lets a
   retried hop reuse one span id; **04 event log** (`04-event-log-stream.md`) for the collector's
   durable span store; **05 resilient RPC** (`05-resilient-rpc.md`) — every retry/hedge/circuit-break
   decision becomes a span event, and a `DeadlineExceeded` carries `Ctx.trace`. It **enables**
   **07 telemetry/SLIs** (`07-telemetry-metrics-slis.md` — span durations are the raw latency SLI,
   RED metrics fall out of spans) and gives **10 saga** (`10-saga-workflow.md`) and **02 placement**
   (`02-load-balancing-placement.md`) their cross-app debugging view. Build order: ships **first** of
   the node-plane trio (architecture §5 step 1), immediately after `Ctx`, because it is the highest
   operability leverage and only needs `Ctx`.
6. **Namespacing** — spans for a logical action all carry the same `Ctx.trace`; they are reported to
   a per-`ns` collector. The collector's directed topic is `trace/ingest` keyed by `Ctx.ns`; its
   fan-out / live-tail gossip topic is `ce-app/<ns>/trace` (architecture §6, extends
   `APP_TOPIC_PREFIX = "ce-app/"`, `ce/crates/ce-mesh/src/lib.rs:297`). Two tenants' traces never
   cross-deliver; the collector indexes spans by `(ns, trace_id)`.
7. **Boundary check** — the node copies 24 opaque bytes of trace context per hop and never learns
   what a "span", "service", or "operation" is; all span semantics, sampling policy, storage, and
   the visualizer are the collector app. Stranger code never bypasses the local node: every span is
   emitted through `ce-rs` to the local node, which authenticates the reporter (`AppMessage.from`,
   `ce-rs/src/lib.rs:732`) and verifies `Ctx.cap` authorizes `trace:write` before the collector app
   accepts it.

---

## 1. Purpose & the at-scale problem

Once `ce-db`, `ce-pubsub`, `ce-query`, `ce-iam`, `ce-gke`, and game backends call each other, a
single user action (a game move, a paid query, a saga step) fans out across N apps on M nodes. When
it is slow or wrong, today there is **no way to follow it**: each app logs locally, with no shared
correlation id, and the node's `AppMessage` inbox (`ce/crates/ce-node/src/api.rs:1880`) is a flat,
per-node ring with no notion that two messages belong to one action. The same retry that primitive
05 issues, the same dedup that primitive 09 performs, the same hop that primitive 11 throttles — all
are invisible across the app boundary.

Distributed tracing fixes this with the cheapest possible mechanism: **one trace id that is born at
the edge of a user action and rides every onward hop automatically**, plus a span per hop forming a
causal tree. Because the node already stamps the `Ctx` envelope (architecture §2) onto every
`AppRequest`/`AppMessage`/`AppPubSubMsg`, the trace context is *already on the wire* — this primitive
is the rule for filling and forwarding three of its fields, plus an app that collects and draws the
result. It is "THE highest-leverage operability primitive" (the brief, `frontier`) precisely because
every other scale primitive emits into it for free.

The at-scale concurrency problem it solves: with thousands of concurrent actions interleaved on one
node's inbox and gossip bus, correlation by timestamp is hopeless. A 16-byte trace id partitions the
chaos into followable causal trees; the 8-byte parent-span links build the tree; the HLC
(`Ctx.hlc`) orders siblings without trusting wall clocks across machines.

## 2. Plane: node vs ce-coord, and why

| Part | Plane | Justification |
|---|---|---|
| Inject on receive (mint trace if `Ctx.trace == 0`, open child span of `parent_span`, merge HLC) | **NODE** (`ce-node` inbound dispatch) | architecture §1 row "Trace inject/forward"; must happen before the app sees the message, on a peer that does not run the app. |
| Forward on send (copy `Ctx.trace`, set `Ctx.parent_span` = current span, recompute via §2.6) | **NODE** (`ce-rs` outbound + `ce-node`) | the app never threads the id; the node guarantees it on every onward hop, so a trace cannot break because an app forgot. |
| Span emission (build a span record, sample, ship it) | **coord/app** (`ce-trace` SDK in `ce-rs`/`ce-coord`) | a typed client of `send_message`/`publish`; no node enforcement. |
| Collector + visualizer (ingest, index by `(ns, trace_id)`, store, draw) | **app** (`ce-trace-collector`) | pure product/UX policy over blobs + the event log (04); the litmus test (`primitives.md`): a span store is not a byte/coin/key mechanism every app reinvents — it is policy. |

The split obeys the one rule (architecture §0): the node owns the generic *propagation* mechanism
that must ride every hop; the SDK/app owns the *coordination* (what a span means, how to store and
visualize it). It earns its node-plane change against the §1 closed list and adds **no** new
`RpcRequest` — strictly a fill-and-forward of the existing `Ctx`.

## 3. Public API

### 3.1 Wire types (reuse the envelope — no new structs in `ce-mesh`)

The trace context is **exactly** the three `Ctx` fields from architecture §2
(`ce/crates/ce-mesh/src/lib.rs`, added alongside `RpcRequest::AppRequest`):

```rust
// ce-mesh::Ctx (architecture §2) — the ONLY wire change tracing needs. Repeated here for the
// fields 06 owns; do not redefine.
pub struct Ctx {
    pub v: u8,
    pub trace: [u8; 16],        // 06: constant across one action; 0 = mint on receive
    pub parent_span: [u8; 8],   // 06: caller's current span; callee opens a child
    pub hlc: (u64, u32),        // 06/09: causal timestamp of this span's start
    // ... deadline_ms, idem, cap, ns (other primitives) ...
}
```

The **span record** is an *app* type (collector payload), never a node type. It rides as the opaque
`payload` of a `trace:write` `AppMessage`/`publish`, bincode-encoded (deterministic, per
`standards.md`):

```rust
// ce-trace (SDK crate over ce-rs) — the span the collector ingests. App vocabulary, not in the node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Span {
    pub trace: [u8; 16],            // from Ctx.trace
    pub span: [u8; 8],              // this span's id (random; reused on a retry via Ctx.idem)
    pub parent: [u8; 8],            // Ctx.parent_span (0 = root span of the trace)
    pub ns: String,                 // Ctx.ns — the action's namespace
    pub reporter: [u8; 32],         // the NodeId that emitted this span (== AppMessage.from)
    pub name: String,               // operation name, e.g. "ce-db/query" or "rpc:call orders"
    pub kind: SpanKind,             // Server | Client | Producer | Consumer | Internal
    pub start_hlc: (u64, u32),      // Ctx.hlc at span open (causal order across machines, primitive 09)
    pub start_unix_ms: u64,         // wall clock for human display only (never for ordering)
    pub dur_us: u64,                // measured locally; monotonic clock, not wall
    pub status: i32,                // architecture §4 Status as i32 (0 = Ok)
    pub attrs: Vec<(String, String)>,// e.g. ("topic","orders"), ("retry","2"), ("cap.ok","true")
    pub events: Vec<SpanEvent>,     // point-in-time: a 05 retry, an 09 dedup hit, a 11 throttle
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpanEvent { pub at_hlc: (u64, u32), pub name: String, pub attrs: Vec<(String, String)> }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum SpanKind { Server, Client, Producer, Consumer, Internal }

/// What the collector returns for a trace query (architecture §4 Partial<T> over reporters).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trace { pub trace: [u8; 16], pub spans: Vec<Span>, pub missing_parents: Vec<[u8; 8]> }
```

`missing_parents` makes a partial trace honest (architecture §4): a span whose `parent` was never
reported is surfaced, not silently dropped.

### 3.2 Node HTTP routes (additive; mirror the existing mesh routes)

The existing routes in `ce/crates/ce-node/src/api.rs` (`/mesh/send`, `/mesh/request`, `/mesh/reply`,
`/mesh/publish`) gain an **optional** `ctx` object (the SDK fills it; old callers omit it and the
node defaults `Ctx::default()` and *mints* a fresh trace). Two read-only routes are added for the
node's own span surface — they expose only the node-generated transport spans, not app spans:

| Method | Path | Description |
|---|---|---|
| GET | `/trace/current` | The trace/span the node is currently handling on this connection (debug). Returns `{ trace, span }` hex. |
| GET | `/mesh/messages` *(extended)* | Each `AppMessage` JSON gains `ctx: { trace, parent_span, hlc, ns }` so a polling app sees the context. |

No new node RPC. `mesh_request`/`mesh_reply`/`send_message`/`publish_topic` are extended to (a) parse
`ctx` from the body, (b) run the node responsibilities of architecture §2.6 (mint/child/merge),
(c) attach the resulting `Ctx` to the outbound `RpcRequest`, and (d) surface `ctx` on the inbound
`AppMessage` so `ce-rs` can read it.

### 3.3 Rust SDK (`ce-rs` outbound forwarding + `ce-trace` emission)

`ce-rs` gains the `*_ctx` variants the envelope already mandates (architecture §2 "SDK surface"),
plus a current-context accessor so apps can open child spans:

```rust
impl CeClient {
    /// As send_message, but carry an explicit Ctx (trace/parent_span/deadline/idem/cap/ns).
    pub async fn send_message_ctx(&self, to: &str, topic: &str, payload: &[u8], ctx: &Ctx) -> Result<()>;
    pub async fn request_ctx(&self, to: &str, topic: &str, payload: &[u8], timeout_ms: u64, ctx: &Ctx) -> Result<(Vec<u8>, Ctx)>;
    pub async fn reply_ctx(&self, token: u64, payload: &[u8], ctx: &Ctx) -> Result<()>;
    pub async fn publish_ctx(&self, topic: &str, payload: &[u8], ctx: &Ctx) -> Result<()>;
}

// AppMessage gains a `ctx` field (architecture §2 "SDK surface") so handlers read the inbound trace.
pub struct AppMessage { /* from, topic, payload_hex, received_at, reply_token, */ pub ctx: Ctx }
```

The tracing-specific surface is the `ce-trace` crate (thin, over `ce-rs`), used by app code and by
`ce-coord`'s pump:

```rust
// ce-trace — span emission + automatic context threading. Depends only on ce-rs + ce-coord.
pub struct Tracer { /* CeClient, collector NodeId, ns, sampler */ }

impl Tracer {
    /// Connect a tracer for namespace `ns` reporting to `collector` (resolve via primitive 01).
    pub async fn new(ce: CeClient, ns: &str, collector: &str, cap: Vec<u8>) -> Result<Tracer>;

    /// Open a ROOT span for a new user action — mints a fresh trace id. Returns a guard that, on
    /// drop, records dur_us and ships the Span (best-effort) and that yields the Ctx to thread into
    /// every onward ce-rs call.
    pub fn root(&self, name: &str, kind: SpanKind) -> SpanGuard;

    /// Open a CHILD span continuing an inbound Ctx (from AppMessage.ctx) — same trace, new span,
    /// parent = inbound.span. This is the one call a handler makes; the node already opened the
    /// transport-level server span, this is the app-level operation span beneath it.
    pub fn child(&self, parent: &Ctx, name: &str, kind: SpanKind) -> SpanGuard;
}

pub struct SpanGuard { /* ... */ }
impl SpanGuard {
    /// The Ctx to pass to ce-rs `*_ctx` calls so the child hop continues this span.
    pub fn ctx(&self) -> &Ctx;
    pub fn set_attr(&mut self, k: &str, v: impl Into<String>);
    pub fn event(&mut self, name: &str, attrs: &[(&str, &str)]);
    pub fn set_status(&mut self, s: Status);   // architecture §4
}
impl Drop for SpanGuard { /* measure dur, ship Span via send_message_ctx(trace/ingest) best-effort */ }

// Collector-side query API (the visualizer / a debugging CLI uses this).
pub struct TraceReader { /* CeClient, collector NodeId, ns, cap */ }
impl TraceReader {
    pub async fn get(&self, trace: [u8; 16]) -> Result<Trace>;                 // trace:read
    pub async fn recent(&self, limit: usize) -> Result<Vec<[u8; 16]>>;         // newest trace ids
    pub async fn tail(&self) -> Result<impl Stream<Item = Result<Span>>>;      // live tail via subscribe(ce-app/<ns>/trace)
}
```

`ce-coord`'s pump (`ce-coord/src/lib.rs:151` `spawn_pump` / `:198` `dispatch`) is extended to read
`msg.ctx` and open a `Tracer::child` span around each handler invocation, so **every coordination
message is traced automatically** with zero app code (architecture §2 "SDK surface").

### 3.4 TS SDK (`ce-ts`)

Mirrors the Rust surface over the same HTTP routes (the browser node bridge uses the same
`/mesh/*` endpoints):

```ts
interface Ctx { v: number; trace: string; parentSpan: string; hlc: [number, number];
                deadlineMs: number; idem: string; cap: string; ns: string }  // hex strings

class Tracer {
  static async create(ce: CeClient, ns: string, collector: string, cap: string): Promise<Tracer>;
  root(name: string, kind: SpanKind): SpanGuard;     // mints trace
  child(parent: Ctx, name: string, kind: SpanKind): SpanGuard;
}
interface SpanGuard {
  ctx(): Ctx;                          // pass to ce.sendMessageCtx / ce.requestCtx
  setAttr(k: string, v: string): void;
  event(name: string, attrs?: Record<string,string>): void;
  end(status?: Status): void;          // ships the span (no Drop in TS — explicit end / using)
}
// ce.requestCtx(to, topic, payload, timeoutMs, ctx) -> { payload, ctx }
// ce.sendMessageCtx / ce.publishCtx / ce.replyCtx accept a Ctx.
class TraceReader { get(trace: string): Promise<Trace>; tail(): AsyncIterable<Span>; }
```

## 4. Protocol & data structures

### 4.1 Topics / RPC used (no new ones)

- **Span ingest:** directed `AppMessage` on topic `trace/ingest`, namespaced by `Ctx.ns`, to the
  collector NodeId (resolved via primitive 01 `find_service("<ns>/trace-collector@1")`,
  `ce-rs/src/lib.rs:506`). Fire-and-forget (`send_message`, not `request`): a span never blocks the
  business path.
- **Live tail / fan-out:** `publish` on `ce-app/<ns>/trace` (`AppPubSubMsg`,
  `ce/crates/ce-mesh/src/lib.rs:304`), signed by the node so the visualizer verifies authorship.
  The publisher's signature already covers `(topic, payload, nonce)` (`app_pubsub_bytes`,
  `:314`) and, per architecture §2, the domain string moves to `ce-app-pubsub-v2` to also cover
  `ctx`.
- **Trace query:** directed `request`/`reply` (`ce-rs/src/lib.rs:450,471`) to the collector on topic
  `trace/query` carrying `{ trace }` → `Trace`.
- **Durable store:** the collector writes span batches to the event log (primitive 04) keyed
  `(ns, "trace/<trace_id_prefix>")` and to content-addressed blobs (`put_object`,
  `ce-rs/src/lib.rs:340`) for cold storage; the trace id's first byte shards the index.

### 4.2 The node inject/forward algorithm (the only enforced logic)

On **inbound** dispatch of any `AppMessage`/`AppRequest`/`AppPubSubMsg` (in `ce-node`, before the
app sees it — extends the path at `ce/crates/ce-node/src/api.rs:1846+` and `MeshEvent::IncomingRpc`
handling, `ce/crates/ce-mesh/src/lib.rs:380`):

```
fn on_receive(ctx: &mut Ctx, now_hlc):
    if ctx.trace == [0;16]: ctx.trace = random_128()          # mint at the edge
    server_span = random_64()                                 # this node's span for this hop
    record (ctx.trace, server_span, parent = ctx.parent_span) # the transport "server" span
    ctx.hlc = hlc.merge(ctx.hlc)                              # primitive 09: causal merge
    surface AppMessage{ ..., ctx: ctx.with(parent_span = server_span) } to the app
    remember current_span = server_span for this task/connection
```

On every **outbound** `ce-rs` call the node or app makes within that handler context:

```
fn on_send(out_ctx: &mut Ctx):
    out_ctx.trace       = current.trace        # never changes within a trace
    out_ctx.parent_span = current.span         # link the child hop to us
    out_ctx.hlc         = hlc.now()            # monotone, primitive 09
    # deadline_ms recomputed by primitive 05; cap/ns carried through unchanged
```

**Key invariants:**
- I1 — **one trace id per action:** `Ctx.trace` is set exactly once (at the first node that sees a
  zero trace) and is byte-identical on every onward hop. The node never overwrites a non-zero trace.
- I2 — **every span has a parent except the root:** a child's `parent` = the inbound server span;
  the root's `parent` = 0. This makes the span set a tree (forest if a reporter is missing).
- I3 — **causal order is HLC, not wall clock** (primitive 09): a child's `start_hlc` strictly
  dominates its parent's after the merge, so a trace is correctly ordered across machines whose wall
  clocks differ.
- I4 — **a retry reuses the span id** (primitive 09 dedup): when `Ctx.idem != 0`, a redelivered hop
  is served from the dedup cache and the *same* `span` id is recorded with a `retry` event, so a
  retried call is one span with N attempt-events, not N phantom spans.
- I5 — **best-effort, non-blocking:** span emission failure is swallowed; it never alters the
  business `Status` (§5).

### 4.3 Sampling

Sampling is a **client/collector policy** (app, not node): the root span makes a head-sampling
decision and records it as a `sampled` bit in `Ctx.attrs`-equivalent (carried as the low bit of
`Ctx.parent_span`? no — kept out of the wire; instead the `Tracer` simply does not emit
non-sampled spans, but **always forwards `Ctx.trace`** so a downstream service can tail-sample). The
node always forwards the trace id regardless of sampling; only *span emission* is sampled. Default:
sample-all in dev, probabilistic in prod, configured on the `Tracer`.

## 5. Semantics & failure modes

- **Delivery:** span ingest is **at-most-once, fire-and-forget** (`send_message`). Spans may be lost
  under load or partition; a trace is therefore *best-effort complete*. This is deliberate —
  tracing must add near-zero latency and must never be on the critical path. `missing_parents`
  surfaces the gaps (architecture §4) rather than pretending completeness.
- **Ordering:** within a trace, causal order is reconstructed from `parent` links + `start_hlc`
  (primitive 09 HLC). Sibling spans with equal causality are tie-broken by `(start_hlc, span_id)` for
  a stable render. The collector never assumes ingest order equals causal order.
- **Consistency:** the collector's view is **eventually consistent**; a trace can be queried while
  still accruing spans (the visualizer marks it "in progress" when the deadline has not passed and
  some `Client` spans have no matching downstream `Server` span yet).
- **Crash / partition:** if the collector is down, `Tracer` drops spans (bounded in-memory ring,
  oldest-out) and the business path is unaffected. If a *reporter* crashes mid-span, its `Client`
  span is never shipped → the downstream `Server` span appears with `missing_parents` containing the
  lost parent; the gap is visible. A partitioned subtree shows as a disconnected component under the
  same trace id.
- **What it does NOT guarantee:** complete traces, exactly-once span delivery, global clock
  agreement (only causal order), or that an unsampled hop produced any span. It does **not** trace
  payload contents (the node never reads `payload`), and it is **not** an audit log (use the chain /
  primitive 04 for durable facts). It does not enforce deadlines or retries — those are 05; tracing
  only *records* them.

## 6. Security & economy

- **Abilities (architecture §3):** `trace:write` to emit into a namespace's collector,
  resource-scoped `Tag("trace:<ns>")`; `trace:read` to query/tail. The wire *context* (the 24 bytes)
  needs no cap — it is generic transport metadata the node copies, exactly like `deadline_ms`/`idem`
  (architecture §2; "rate limits are economy-gated, not cap-gated by default", §3). The collector
  verifies `Ctx.cap` authorizes `trace:write` before accepting a span (the security invariant: the
  reporter is `AppMessage.from`, node-authenticated, `ce-rs/src/lib.rs:732`).
- **Abuse/DoS bounds:** span ingest is rate-limited by primitive 11 keyed `(from, ns, "trace:write")`
  (architecture §6) so one reporter cannot flood the collector; over-limit returns
  `ResourceExhausted` and the `Tracer` backs off + drops (never blocks). Span size is capped
  (`attrs`/`events` bounded; reject oversized → `InvalidArgument`). A forged trace id is harmless: a
  malicious reporter can only inject spans *attributed to its own NodeId* (`reporter` == verified
  `from`), so the visualizer can filter/flag spans by trust; it cannot forge another node's span.
  The 16-byte random trace id makes cross-action collision negligible.
- **Privacy:** because the node never inspects `payload`, no business data leaks into the trace
  unless an app puts it in `Span.attrs`; apps SHOULD keep attrs to low-cardinality metadata. `ns`
  scoping (architecture §6) ensures tenant A cannot read tenant B's traces (`trace:read` is
  resource-scoped to `Tag("trace:<ns>")`).
- **Optional payment-channel metering:** a public/shared collector can charge per span batch via a
  payment channel (`channel_open`/`sign_receipt`, `ce-rs/src/lib.rs:543,551`), identical to the paid
  chunk-fetch pattern (`fetch_chunk_paid`, `:391`): the reporter signs a rising `cumulative` receipt
  the collector redeems. Default collectors are free (you trace your own fleet under your own key).

## 7. Composition

- **Depends on** (in-edges, architecture §5): `Ctx` envelope (the keystone — trace is three of its
  fields); **09 causal time / idempotency** (`09-causal-time-idempotency.md`) for HLC ordering +
  retry-span coalescing; **04 event log** (`04-event-log-stream.md`) as the collector's durable
  store; **05 resilient RPC** (`05-resilient-rpc.md`) whose retries/hedges/circuit-breaks become
  span events; **01 service registry** (`01-service-registry-binding.md`) to resolve the collector.
- **Enables / is consumed by:** **07 telemetry/SLIs** (`07-telemetry-metrics-slis.md`) — RED metrics
  (rate/errors/duration) are aggregations of spans, so 07 reads the same emission; **02 placement**
  (`02-load-balancing-placement.md`) — span latencies feed the "nearest/least-loaded" signal;
  **10 saga** (`10-saga-workflow.md`) — a saga's steps/compensations are one trace, making a failed
  workflow followable; **12 schema registry** (`12-schema-config-registry.md`) — a schema-validation
  failure attaches to the span as a `Status::InvalidArgument` event. It is the universal observability
  sink every other primitive emits into for free, since they all already carry `Ctx`.

## 8. Test plan

**Deterministic unit cores (no mesh):**
- `Span` / `Ctx` bincode round-trip and version-gating (`v` field) — old peer reads new `Ctx` as
  `Default`, gets zero trace, behaves as today (architecture §2 invariant).
- Inject algorithm (§4.2) as a pure function: zero trace → minted; non-zero → preserved (I1); child
  parent == inbound server span (I2); HLC merge produces strictly-dominating child timestamp (I3,
  property test over random clock skews — reuse primitive 09's HLC).
- Retry coalescing (I4): feed a duplicate `Ctx.idem` and assert one span with two attempt-events,
  not two spans. Reuse the pump's `Dedup`/`fingerprint` (`ce-coord/src/lib.rs:226,253`).
- Trace assembly: given a span set with a missing parent, `Trace.missing_parents` lists it; sibling
  ordering by `(start_hlc, span_id)` is stable (property test, shuffle ingest order → identical tree).
- Best-effort invariant (I5): a `Tracer` whose collector send errors returns `Ok` from the business
  call (mock `CeClient` that fails `send_message`).

**Integration (single node, in-proc):** drive `ce-coord`'s pump with two registered handlers that
call each other via `request_ctx`; assert the second handler's inbound `ctx.trace` equals the first's
and `parent_span` chains correctly; assert the collector handler receives N spans forming one tree.

**Needs a live multi-node mesh:** a 3-node action (A → B → C over real `/ce/rpc/1`) where A mints the
trace, B and C continue it, all three report to a collector on a 4th node; assert the assembled
`Trace` has the full A→B→C chain with one trace id (validates node inject/forward over the wire and
the relay/NAT path). Partition test: kill the collector mid-action → business calls still succeed,
spans are dropped, no error surfaces. Clock-skew test: set B's wall clock +5 min → causal order via
HLC is still correct (spans render in the right order despite wall-clock disagreement).

## 9. Worked example: tracing a paid query across a sharded game backend

A player makes a move in a sharded game. The flow and its trace:

1. The game client calls `ce.request_ctx(game_node, "game/move", move_bytes, 2000ms, root_ctx)`.
   The browser `Tracer::root("game/move", Server)` mints `trace = 0x9f3c…` and the node stamps it.
2. The game backend (`Server` span, parent 0) needs the player's inventory: it opens a `child` span
   `"ce-db/get inventory"` and calls `ce.request_ctx(db_shard, "db/read", key, …, guard.ctx())`. The
   node forwards `trace = 0x9f3c…`, `parent_span` = the game backend's span.
3. `ce-db`'s shard (`Server` span under the game span) authorizes a paid read: it opens a `child`
   for `"ce-query/scan"` and a `Producer` span when it publishes an invalidation on
   `ce-app/<ns>/changes`. Each hop's node forwarded the same `trace`.
4. The read is slow. The player reports lag. The developer runs `TraceReader::get(0x9f3c…)` (or opens
   `ce-net.com/trace`): the visualizer draws **one tree** — `game/move` → `ce-db/get inventory` →
   `ce-query/scan` (1.8 s, flagged red, `status = DeadlineExceeded`) → the `Producer` invalidation —
   immediately showing `ce-query/scan` as the culprit. Primitive 05's retry shows as two
   attempt-events under one span (I4); primitive 11's throttle on the busy shard shows as a
   `ResourceExhausted` event. Without tracing, this is four separate logs on four nodes with no link;
   with it, it is one followable causal tree built automatically because every hop carried `Ctx`.

This is the trust-gradient "visualized work" case (`primitives.md`): the operator *sees* the action,
so a mis-behaving hop is obvious — the same property that makes stranger compute safe makes the mesh
debuggable.

## 10. Effort & minimal first slice

**Effort: M** (the node inject/forward is small and additive; the collector + visualizer are the
bulk, but they are an ordinary app). The hard prerequisite is the `Ctx` envelope (architecture §5
step 0) — without it this is XL; with it, M.

**Minimal first slice (one PR after `Ctx` lands):**
1. Node: in `ce-node` inbound dispatch, mint `Ctx.trace` if zero, open a server span, surface
   `ctx` on the `AppMessage` (extend `ce/crates/ce-node/src/api.rs` send/request/reply/publish);
   forward `trace`/`parent_span` on outbound `*_ctx` calls. (the §4.2 algorithm, ~150 lines.)
2. `ce-rs`: the `*_ctx` method variants + `AppMessage.ctx` field.
3. `ce-trace`: `Tracer::{root,child}` + `SpanGuard` shipping `Span` via `send_message` to a
   hard-coded local collector NodeId; no sampling (sample-all), no payment.
4. Collector: a ~200-line app that subscribes to `trace/ingest`, indexes spans by `(ns, trace_id)`
   in memory + a `put_object` cold store, and answers `trace/query` with `Trace`.
5. Visualizer: a flat list → tree view at `ce-net.com/trace` over `TraceReader`.

This slice already makes a 2-app, 2-node call followable end to end — the entire operability payoff —
and every later primitive (05/07/10/02) emits into it with no further node work. Defer to follow-ups:
sampling policy, payment metering, the event-log (04) durable store, and tail-sampling.
