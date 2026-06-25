# 10 — Saga / durable cross-app workflow orchestration (steps, retries, compensation)

**Status:** implementation-ready. Conforms to `00-architecture.md` (the contract). Ground truth:
`ce-coord/src/{lib,replicated,merged,stream,snapshot,testkit}.rs` (the coordination engines + the
in-process mock mesh), `ce-rs/src/lib.rs` (`request`/`reply`/`publish`/`subscribe`/`messages`,
`find_service`/`advertise_service`, `put_object`/`get_object`, `channels`), `ce-mesh/src/lib.rs`
(`AppRequest`/`AppMessage`/`AppPubSubMsg`, `APP_TOPIC_PREFIX = "ce-app/"`), `ce/crates/ce-cap/src/lib.rs`
(`Resource`, `Caveats::not_after`, `is_narrower_or_equal`), `ce-iam/src/lib.rs`
(`with_action_universe`), `ce/docs/primitives.md` (the boundary). Composes the sibling designs
`03-durable-queue.md` (lease/ack/retry/DLQ), `08-locks-leases-election.md` (Raft lease + fence),
`09-causal-time-idempotency-counters.md` (idem dedup + HLC). `primitives.md` names this an app
explicitly: *"Work scheduler / orchestrator (fan out N tasks, track, retry, aggregate) … the node
need not enforce it"* and *"Workflow DAGs, task sync models → the workload's concern."* This doc
designs the reusable orchestration substrate every such app would otherwise reinvent.

## Conformance block (contract §7)

1. **Plane** — **coord**, over `03` (queue) + `08` (Raft lease/fence) + `09` (idem) + the `ce-coord`
   `Replicated<S>` log (contract §0.1 row 10). **Zero node-plane changes** beyond the contract-§2
   `Ctx` envelope that all primitives ride. No new `RpcRequest` variant: every saga message is one of
   the three generic verbs (`request`/`reply`, `publish`/`subscribe`, `messages`). Justification
   (contract §0 rule 1 litmus): a durable workflow is *product semantics composed from coordination
   primitives* — nothing a non-participating peer must enforce on the wire. The node never learns what
   a "saga" or "compensation" is; it only delivers signed `AppMessage`s and verifies `Ctx.cap`.
2. **Abilities** — `saga:start`, `saga:step`, `saga:admin` (contract §3). `start` = begin/cancel a
   workflow instance of a registered definition; `step` = a participant app reports a step's
   forward/compensate outcome (the orchestrator → participant call carries the *participant's own*
   ability, e.g. `db:write`, attenuated into the chain — see §6); `admin` = register/retire a saga
   definition, purge history, force-compensate. Resource scoping via `ce-cap::Resource::Tag` carrying
   the definition name as `Tag("saga:<ns>/<def>")`, so a grant can say "may only start the
   `order-checkout` saga" by attenuating resource, not ability.
3. **Envelope use** — reads/writes `Ctx{ ns, cap, deadline_ms, idem, trace, hlc }`. `idem` is the
   load-bearing field: **every forward step and every compensation is invoked with a stable
   per-(instance,step) idempotency key**, so a redelivered step call is served from the node §2 dedup
   table (`AlreadyApplied`) and never double-applies an effect. `deadline_ms` bounds each step and the
   whole run. `trace` ties the entire multi-app workflow into one trace (06) for free. `hlc` orders
   step transitions causally across participant apps. Adds **no parallel header** — the saga's own
   step bookkeeping is app payload, but cross-cutting control rides `Ctx`.
4. **Status & partial failure** — returns `Ok`, `InvalidArgument` (unknown def / bad step graph),
   `Unauthorized`, `NotFound` (no such instance/def), `FailedPrecondition` (instance not in a state
   that accepts this transition — e.g. step already compensated), `Aborted` (lost the instance lease —
   another orchestrator took over; retry), `Unavailable` (a participant down — step is retried per
   policy), `DeadlineExceeded`, `ResourceExhausted` (per-tenant in-flight saga cap), `Internal` (step
   handler crashed — retried only because `Ctx.idem` is set), `AlreadyApplied` (idempotent step retry
   returns the recorded outcome). A **parallel/fan-out branch** returns the contract §4
   `Partial<StepOutcome>` — the caller (the orchestrator) sees exactly which branches succeeded and
   which failed, turning each `failed` entry into a compensation. **Never collapses a partial branch
   failure to a single bool** (contract §4).
5. **Dependencies** — in-edges in contract §5: `Ctx` envelope; **09** (idem dedup + HLC — the
   exactly-once-effect spine, §4.3); **03** (the durable queue is the saga's step-dispatch + retry +
   DLQ substrate); **08** (a Raft lease+fence makes exactly one orchestrator own a running instance,
   so a crashed orchestrator's instance is resumed by a sibling without two drivers racing). Soft: **01**
   (`find_service` to locate a participant app), **12** (schema registry validates step payloads),
   **07** (in-flight/failed/compensating counts as SLIs). Build order: ships **last**, in the
   `{10,12}` wave after `{03,04,08}` (contract §5) — it composes everything below it.
6. **Namespacing** — the saga instance log is a `ce-coord` `Replicated<SagaState>` keyed
   `(ns, saga.<def>.<instance>)`; the per-definition control plane is keyed `(ns, saga.def.<def>)`.
   Wire topics: `ce-app/<ns>/saga.step.<def>` (orchestrator→participant, `request`/`reply`),
   `ce-app/<ns>/saga.log.<def>.<instance>` (the `Replicated` op log fan-out),
   `ce-app/<ns>/saga.events.<def>` (instance lifecycle pub/sub for observers). Step dispatch reuses a
   `03` queue named `(ns, queue.saga.<def>)`. Default empty `ns` ⇒ the caller's NodeId hex (a private
   per-key saga namespace) — a single-app workflow gets isolation for free.
7. **Boundary check** — no app policy enters the node: "saga", "step", "compensation", "forward/back
   recovery" are all `ce-coord`/`ce-saga` library concepts; the node only delivers signed
   `AppMessage`s and enforces `Ctx` (cap, deadline, idem dedup, rate limit). Stranger code never
   bypasses the local node — every step invocation is a `ce-rs` call through the *local* node, which
   authenticates `AppMessage.from` (a node-verified NodeId) and verifies the `Ctx.cap` chain before
   the participant app acts.

---

## 1. Purpose & the at-scale problem

A single user action increasingly spans **many independent apps on the mesh**: a checkout reserves
inventory in one `ce-db` collection, charges credits through the ledger / a payment channel, books a
shipment in a third app, and emails a receipt via `ce-mail`. There is **no global transaction
manager** on CE and there must not be: the substrate is a trustless PoW mesh with no federated
quorum (`primitives.md`: *"CE is always trustless … no federated quorum, no lighthouse authority"*),
and a cross-app two-phase commit would require a coordinator every participant trusts and a blocking
lock held across app boundaries — the exact bottleneck the boundary forbids. CE's own multi-document
atomicity stops at one collection's single-writer log (`ce-db/src/batch.rs::WriteBatch::commit`,
atomic *within* a collection only); it cannot span apps or owners.

The at-scale failure mode is therefore **partial completion under concurrency and crashes**: app B's
charge succeeds, app C's shipment-booking times out, the orchestrator crashes — and inventory stays
reserved, the customer is charged, nothing ships, and on restart nobody knows how far it got. With a
dozen interdependent apps and thousands of concurrent user actions, ad-hoc "retry and hope" leaves
permanent inconsistency that no single app can detect or repair.

The **saga** is the standard answer to "ACID is impossible, but the business invariant must still
hold": model the cross-app transaction as a sequence (or DAG) of **local** transactions, each with a
**compensating** action that semantically undoes it. Execute forward; on an unrecoverable step
failure, run the compensations of the already-completed steps in reverse. The result is *eventual
consistency with a guaranteed terminal state* — every instance ends **Committed** (all forward steps
done) or **Compensated** (all done steps undone) — never stuck half-applied. This is the only
consistency model a no-global-ACID mesh can offer across apps, and it is a mechanism every
multi-app workflow (`ce-gke` rollouts across pods, `ce-ci` pipelines, a sharded game's match
lifecycle, an order checkout) would otherwise hand-roll, buggily.

The concurrency problem under the hood is **durable, linearized progress on shared instance state**:
the step pointer, each step's status, retry counts, and the compensation stack must advance under a
single total order even as the orchestrator crashes, participants time out, and retries redeliver.
CE already has the linearizer (`ce-coord` `Replicated<S>`, applied in version order on one node) and
the at-least-once retry/DLQ substrate (`03`) and the safe single-owner handoff (`08` lease+fence).
The saga is those three composed and given a workflow API.

---

## 2. Plane: node vs ce-coord, and the justification

**Plane: `ce-coord` (SDK), a new crate `ce-saga` over `ce-coord` + `ce-queue` (03) + the `08` Raft
lease. Zero node-plane changes** beyond the contract-§2 `Ctx` envelope.

| Concern | Plane | Mechanism |
|---|---|---|
| Durable instance state (step pointer, per-step status, compensation stack, retries) | **coord** | `ce-coord` single-writer `Replicated<SagaState>` (`replicated.rs`), version-ordered on the orchestrator |
| Step dispatch + per-step retry + poison → DLQ | **coord** | a `03` queue `(ns, queue.saga.<def>)`: a step is a leased message; ack on success, redeliver/retry on crash, dead-letter a poison step (`03 §4.3`) |
| Exactly one live orchestrator per instance (no two drivers) | **coord** | an `08` lease on `Tag("lock:<ns>/saga.<def>.<instance>")` with a fence stamped into the log (`08 §5`) |
| Exactly-once step *effect* under retry | **node (existing) + coord** | `Ctx.idem = H(instance,step,attempt-class)` → node §2 dedup table returns `AlreadyApplied` on a duplicate; the participant never re-runs the effect |
| Authn of the orchestrator / participant | **node (existing)** | `AppMessage.from` is Noise-verified by `ce-mesh`; the participant reads it (`ce-rs/src/lib.rs:727`) |
| Authz (`saga:*` and the participant's own ability) | **node verb + coord check** | participant runs `ce-cap::authorize` on `Ctx.cap` before acting |
| Deadlines, trace, HLC, rate limit | **node (contract §1)** | `Ctx.deadline_ms`/`trace`/`hlc` + §11 admission, enforced before dispatch |

**Justification.** Every byte of saga semantics is deterministic state replicated with `ce-coord`,
dispatched over `03`, owned via `08`, and made exactly-once with `09` — all already coordination-plane
primitives. By the contract litmus (`product semantics → app; a byte/key/coin mechanism every app
reinvents → primitive`), a saga is unambiguously an app: it has rich product semantics (steps,
compensation order, retry policy) and **nothing a peer that does not run the saga must enforce on the
wire**. It earns **zero** new node RPCs; it *consumes* the node-plane `Ctx` envelope (shared by all
12 primitives) and the §1 admission/dedup the contract already commits to. The one externally visible
safety mechanism — a participant refusing a stale orchestrator's step because the carried **fence** is
below the highest it has seen — is enforced by the **participant app** (exactly as `08`'s fencing is
the resource server's job, `08 §5`), not the node. That is app policy on app state, correctly outside
CE.

---

## 3. Public API

### 3.1 Rust SDK (`ce-coord` plane, new crate `ce-saga`)

`ce-saga` is a thin typed layer: a **definition** (the step graph + compensations + retry policy), an
**orchestrator** (owns running instances via an `08` lease, drives them over a `03` queue, persists in
`ce-coord` `Replicated<SagaState>`), and a **participant** registration (an app exposes its forward +
compensate handlers). It reuses `ce_coord::{Coord, Replicated, Version}`, `ce_queue::{Queue, Consumer,
Producer}` (03), `ce_coord::lock::{LeaseGuard, Fence}` (08), and the contract `Ctx`/`Status`/`Partial`.

```rust
// ce-saga — durable cross-app workflows over ce-coord + ce-queue(03) + ce-lock(08) + idem(09).

/// A step's forward outcome. `next` lets a step steer a branch/loop (returns the next step name to
/// run, or None to advance linearly); `output` is opaque bytes passed to later steps & compensations.
#[derive(Clone, Serialize, Deserialize)]
pub struct StepOutcome { pub output: Vec<u8>, pub next: Option<String> }

/// What a participant app implements for one named step: a forward action and its compensation.
/// BOTH must be idempotent — the engine calls each with a stable Ctx.idem; the participant uses it
/// (and the node §2 dedup table) so a retry is a no-op returning the original outcome.
#[async_trait::async_trait]
pub trait Step: Send + Sync {
    /// Run the local transaction. `input` is the prior step's output (or the saga input for step 0).
    /// Returning Err(Status) classifies the failure: transient (Unavailable/DeadlineExceeded) is
    /// retried per policy; terminal (FailedPrecondition/InvalidArgument) triggers compensation.
    async fn forward(&self, ctx: &Ctx, input: &[u8]) -> Result<StepOutcome, Status>;
    /// Semantically undo `forward` (which produced `output`). MUST be idempotent and SHOULD NOT fail
    /// for app reasons — a compensation that errors is retried indefinitely (with backoff) because a
    /// saga MUST reach a terminal state; only Unavailable/DeadlineExceeded pause it.
    async fn compensate(&self, ctx: &Ctx, output: &[u8]) -> Result<(), Status>;
}

/// Retry policy for a forward step (compensations always retry-until-success with backoff).
#[derive(Clone, Serialize, Deserialize)]
pub struct RetryPolicy { pub max_attempts: u32, pub backoff_ms: u64, pub max_backoff_ms: u64 }

/// A registered step in a definition: which participant app owns it + its retry policy.
pub struct StepDef { pub name: String, pub participant_service: String, pub retry: RetryPolicy }

/// A saga definition: an ordered list of steps (a DAG of `parallel` groups is expressed by
/// StepOutcome::next + `parallel` blocks). Definitions are content-addressed (put_object) so every
/// orchestrator runs the identical graph; the CID is the version (mirrors 12 schema registry).
pub struct SagaDef { /* name, ns, steps, parallel groups, overall deadline */ }
impl SagaDef {
    pub fn builder(ns: &str, name: &str) -> SagaDefBuilder;
}
pub struct SagaDefBuilder { /* ... */ }
impl SagaDefBuilder {
    pub fn step(self, name: &str, participant_service: &str, retry: RetryPolicy) -> Self;
    /// A fan-out group: all named steps run concurrently; the group fails if ANY fails (→ compensate
    /// the whole group + all prior steps). Returns Partial<StepOutcome> internally (contract §4).
    pub fn parallel(self, steps: &[(&str, &str, RetryPolicy)]) -> Self;
    pub fn deadline(self, overall_ms: u64) -> Self;
    pub async fn publish(self, coord: &Coord) -> Result<SagaDefHandle>; // saga:admin; content-addresses + advertises
}

/// The orchestrator: owns running instances of one definition on this node. One per (def) per node;
/// HA = several nodes run it and contend for each instance's 08 lease (only the lease holder drives).
pub struct Orchestrator { /* Replicated<SagaState> writer per live instance + a 03 queue consumer */ }
impl Orchestrator {
    /// Stand up an orchestrator for `def`. Joins the 08 Raft group `(ns, saga.<def>)` so instances are
    /// lease-owned; subscribes the 03 step queue; resumes any in-flight instances from their logs.
    pub async fn run(coord: Coord, ce: CeClient, def: SagaDefHandle, group_members: &[&str])
        -> Result<Orchestrator>;
}

/// Client handle to start/observe instances (callable from any app, no orchestrator membership).
pub struct SagaClient { /* find_service(orchestrator) + directed request/reply */ }
impl SagaClient {
    pub async fn connect(coord: Coord, ce: CeClient, ns: &str, def: &str) -> Result<SagaClient>;
    /// Start an instance. `Ctx.idem` makes start idempotent (a retried start returns the SAME
    /// instance id, AlreadyApplied — never a second run). Requires saga:start on Tag("saga:<ns>/<def>").
    pub async fn start(&self, input: &[u8], ctx: &Ctx) -> Result<InstanceId, Status>;
    /// Current state of an instance (running step, statuses, terminal outcome).
    pub async fn status(&self, id: InstanceId) -> Result<SagaState, Status>;
    /// Request cancellation: the orchestrator stops forward progress and compensates completed steps.
    pub async fn cancel(&self, id: InstanceId, ctx: &Ctx) -> Result<(), Status>;
    /// Block until the instance reaches a terminal state (Committed | Compensated | Failed).
    pub async fn await_terminal(&self, id: InstanceId) -> Result<Terminal, Status>;
    /// Subscribe to every lifecycle transition of this def's instances (saga.events.<def>).
    pub async fn events(&self) -> Result<impl futures_core::Stream<Item = SagaEvent>>;
}

/// A participant app registers its Step handlers so the orchestrator can dispatch to it over the mesh.
pub struct Participant { /* serves saga.step.<def> request/reply; runs forward/compensate */ }
impl Participant {
    pub async fn serve(coord: Coord, ce: CeClient, ns: &str, def: &str,
                       steps: Vec<(String, Box<dyn Step>)>) -> Result<Participant>;
}
```

### 3.2 Wire types (orchestrator ↔ participant, over `request`/`reply`; bincode, opaque to the node)

```rust
// ce-saga internal wire (bincode), carried as opaque AppMessage.payload on ce-app/<ns>/saga.step.<def>.
#[derive(Serialize, Deserialize)]
enum StepCall {
    /// Run the forward action of `step` for `instance`. `fence` is the orchestrator's 08 lease fence;
    /// the participant rejects a call whose fence is below the highest it has applied for this
    /// instance (a stale ex-orchestrator) with Status::Aborted (§5 fencing). idem rides in Ctx.idem.
    Forward { instance: InstanceId, step: String, input: Vec<u8>, fence: Fence },
    /// Undo `step` (which produced `output`). Same fencing. Retried-until-success.
    Compensate { instance: InstanceId, step: String, output: Vec<u8>, fence: Fence },
}
// Reply is bincode of Result<StepOutcome, Status> for Forward, Result<(), Status> for Compensate.

/// The replicated instance state (the ce-coord StateMachine folded in version order on the orchestrator).
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct SagaState {
    pub def: String,
    pub instance: InstanceId,
    pub phase: Phase,                 // Running | Compensating | Committed | Compensated | Failed
    pub cursor: usize,               // index of the next forward step (or the step being compensated)
    pub steps: Vec<StepRecord>,      // per step: status + recorded output (for its compensation)
    pub fence: Fence,                // the owning orchestrator's current lease fence (08)
    pub started_hlc: (u64, u32),
}
#[derive(Clone, Serialize, Deserialize)]
pub struct StepRecord { pub name: String, pub status: StepStatus, pub output: Vec<u8>, pub attempts: u32 }
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum StepStatus { Pending, Done, Failed, Compensating, Compensated }
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
pub enum Phase { #[default] Running, Compensating, Committed, Compensated, Failed }

/// The op log entry the orchestrator proposes to the Replicated<SagaState> (version-ordered, §4.3).
#[derive(Serialize, Deserialize)]
enum SagaOp {
    Start { input: Vec<u8>, fence: Fence, hlc: (u64, u32) },
    StepStarted   { step: String, attempt: u32 },
    StepDone      { step: String, output: Vec<u8> },
    StepFailed    { step: String, status: Status },
    BeginCompensate,
    StepCompensated { step: String },
    Terminate { phase: Phase },      // Committed | Compensated | Failed
    FenceBump { fence: Fence },      // a new orchestrator took the lease; later ops carry the higher fence
}
pub type InstanceId = [u8; 16];      // = H(ns, def, Ctx.idem) so a retried start collides (idempotent)
```

### 3.3 TS SDK (`ce-ts` → `@ce-net/saga`)

Mirrors the Rust shape over the same `/mesh` HTTP routes the `ce-coord` pump uses (no privileged
surface); a browser/Node app can start and observe sagas, and serve participant steps.

```ts
export interface StepOutcome { output: Uint8Array; next?: string }
export interface RetryPolicy { maxAttempts: number; backoffMs: number; maxBackoffMs: number }

export interface Step {
  forward(ctx: Ctx, input: Uint8Array): Promise<StepOutcome>;     // throw Status to fail
  compensate(ctx: Ctx, output: Uint8Array): Promise<void>;        // idempotent; retried until ok
}

export class SagaDefBuilder {
  step(name: string, participantService: string, retry: RetryPolicy): this;
  parallel(steps: [string, string, RetryPolicy][]): this;
  deadline(overallMs: number): this;
  publish(): Promise<SagaDefHandle>;
}

export class SagaClient {
  static connect(ns: string, def: string): Promise<SagaClient>;
  start(input: Uint8Array, opts?: { idem?: Uint8Array; deadlineMs?: number; cap?: Uint8Array }): Promise<InstanceId>;
  status(id: InstanceId): Promise<SagaState>;
  cancel(id: InstanceId): Promise<void>;
  awaitTerminal(id: InstanceId): Promise<"Committed" | "Compensated" | "Failed">;
  events(): AsyncIterable<SagaEvent>;
}
export class Participant {
  static serve(ns: string, def: string, steps: Record<string, Step>): Promise<Participant>;
}
// InstanceId is hex (16 bytes); Fence term/index are bigint (exceed 2^53 — same rule as money/cursors).
```

### 3.4 Node HTTP routes & wire types — **none new**

No new node route. All traffic rides the existing generic verbs the `ce-coord` pump already drives:
`POST /mesh/request`, `POST /mesh/reply`, `POST /mesh/subscribe`, `POST /mesh/publish`,
`GET /mesh/messages/stream` (`ce-rs/src/lib.rs:411-474`), `POST /blobs` + `GET /blobs/:hash` for the
content-addressed definition (`put_object`/`get_object`, `ce-rs/src/lib.rs:320-384`), and
`POST /discovery/advertise` + `GET /discovery/find/:service` to locate orchestrators/participants
(`ce-rs/src/lib.rs:498-513`). The only node-plane change is the **`Ctx` field on
`AppRequest`/`AppMessage`/`AppPubSubMsg`** (contract §2) — shared by all primitives, not saga-specific.

---

## 4. Protocol & data structures

### 4.1 Topics / RPC used (all generic; contract §6 namespacing)

| Logical | Wire name (`ce-app/<ns>/…`) | Transport | Purpose |
|---|---|---|---|
| step dispatch | `saga.step.<def>` | `request`/`reply` directed to the participant | Forward / Compensate one step; reply carries `StepOutcome`/`Status` |
| instance log | `saga.log.<def>.<instance>@<orch>` | `Replicated` over gossip + directed catch-up | fan out `SagaOp` entries; a resuming orchestrator catches up (`replicated.rs` CatchUp) |
| step queue | `queue.saga.<def>` | a `03` Queue (request/reply + Stream) | durable step dispatch with lease/ack/retry/DLQ for a poison step |
| instance lease | `lock.req.saga.<def>` | `08` Raft `request`/`reply` | acquire the per-instance lease + fence so exactly one orchestrator drives it |
| lifecycle events | `saga.events.<def>` | `publish`/`subscribe` (Stream) | observers (UIs, 07 SLIs) follow Running→Committed/Compensated |

A **client** that only starts/observes is not an orchestrator member: it `find_service`s (01) an
orchestrator for `<def>`, sends a directed `start` `request`, and the orchestrator (the current lease
holder for the new instance) replies with the `InstanceId`. Participants likewise need no orchestrator
membership — they only serve `saga.step.<def>`.

### 4.2 State layout

- **`Replicated<SagaState>`** per live instance (`replicated.rs`), keyed `(ns, saga.<def>.<instance>)`,
  single-writer = the orchestrator holding the instance's `08` lease. Every transition is a `SagaOp`
  applied in `Version` order on one node, so the step pointer, per-step status, and compensation stack
  advance under one total order. Snapshot/compaction is `ce-coord` `snapshot.rs` (a long workflow's log
  is bounded by checkpointing terminal step records).
- **A `03` queue** `(ns, queue.saga.<def>)` is the dispatch + retry substrate: the orchestrator
  `produce`s a "run step S of instance I" message; a worker (often the orchestrator itself, or a pool)
  leases it, calls the participant's `Forward`, and `ack`s on `StepDone`. A crash between lease and ack
  redelivers the step (at-least-once, `03 §4.4`); a step that fails `max_attempts` times is dead-lettered,
  which the orchestrator observes as the trigger to `BeginCompensate`. This is why saga **reuses** 03
  rather than reimplementing retry/DLQ.
- **An `08` lease** on `Tag("lock:<ns>/saga.<def>.<instance>")` with a monotone `Fence` (`08 §4.2`).
  The fence is written into `SagaState.fence` and stamped on **every** `StepCall` so participants can
  fence out a stale ex-orchestrator (§5).

### 4.3 Algorithm (the saga lifecycle) and invariants

1. **Start.** `SagaClient.start(input, ctx)` → directed `request` to an orchestrator. The orchestrator
   computes `instance = H(ns, def, ctx.idem)` (so a retried start collides — exactly-once start),
   acquires the instance lease (`08`, obtaining `fence`), proposes `SagaOp::Start{input,fence,hlc}`,
   and replies `InstanceId`. If the instance already exists (idem hit), it returns the same id
   (`AlreadyApplied`).
2. **Forward drive.** For the step at `cursor`: propose `StepStarted{step,attempt}`, `produce` a step
   message onto the `03` queue, and on lease call the participant `Forward{instance,step,input,fence}`
   with `Ctx.idem = H(instance, step, "fwd")`. On `Ok(StepOutcome)`: propose `StepDone{step,output}`,
   `ack` the queue message, advance `cursor` (or follow `StepOutcome.next`). On a **transient**
   `Status` (Unavailable/DeadlineExceeded): `nack` → the `03` queue redelivers per `RetryPolicy`
   (backoff via `modify_deadline`). On a **terminal** `Status` or exhausted retries (DLQ): propose
   `StepFailed` then `BeginCompensate`.
3. **Parallel group.** A `parallel` block `produce`s all branch steps at once; the orchestrator
   collects a `Partial<StepOutcome>` (contract §4). If every branch is `Ok` it records all outputs and
   advances; if **any** branch is in `failed`, it propose `BeginCompensate` — and the still-running
   branches are cancelled and compensated too (never reports group success while a branch failed,
   contract §4).
4. **Compensate (backward recovery).** In `Compensating` phase the orchestrator walks `steps` in
   **reverse** over those with `status == Done`, proposing `StepCompensating` and calling
   `Compensate{instance,step,output,fence}` with `Ctx.idem = H(instance, step, "comp")`. A compensation
   that returns a transient status is retried with backoff **until it succeeds** (a saga must reach a
   terminal state; only liveness, never app-failure, pauses it — §5). On all-compensated → propose
   `Terminate{Compensated}`.
5. **Commit.** When `cursor` passes the last step with all `Done` → propose `Terminate{Committed}`.
6. **Resume after crash.** A sibling orchestrator (a member of the `08` group) acquires the instance
   lease when the old holder's lease expires, obtaining a **strictly higher fence**, proposes
   `FenceBump{fence}`, catches up the `Replicated<SagaState>` log (`replicated.rs` CatchUp), and
   continues from `cursor`/`phase`. Any in-flight `StepCall` from the old orchestrator now carries a
   lower fence and is fenced out by the participant (§5) — no double-forward, no double-compensate.

**Key invariants:**

- **(I1) Terminal state guarantee.** Every instance eventually reaches exactly one of `Committed`,
  `Compensated`, or `Failed` — never stuck `Running`/`Compensating` while live orchestration exists.
  Forward steps retry then compensate; compensations retry until done. (`Failed` is reserved for a
  compensation that is *logically* impossible — surfaced for operator action, not silent.)
- **(I2) Exactly-once step effect.** A forward/compensate is invoked with a stable `Ctx.idem`; a
  redelivered call is served from the node §2 dedup table (`AlreadyApplied`) and the participant's
  handler — itself idempotent — does not re-apply. So `03` at-least-once delivery yields at-most-once
  *effect*.
- **(I3) Single-driver via fence.** At most one orchestrator's `StepCall`s are honored per instance at
  any time, because every call carries the lease `Fence` and the participant rejects a call whose fence
  is below the highest it has applied for that instance (`08` fence monotonicity I2, `08 §4.3`). A
  crashed-then-resumed old orchestrator is a fenced-out zombie.
- **(I4) Single-writer instance log.** Exactly one orchestrator (the lease holder) proposes `SagaOp`s
  to a given instance's `Replicated<SagaState>`; all transitions are version-ordered
  (`replicated.rs::propose`). Two orchestrators cannot both advance an instance (I3 fences the loser).
- **(I5) Compensation completeness.** On `BeginCompensate`, every step with `status == Done` is
  compensated exactly once before `Terminate{Compensated}` — the compensation stack is the prefix of
  `steps` up to `cursor` with `status == Done`, walked in reverse, each marked `Compensated` via a
  committed `StepCompensated` op (so a resume does not re-compensate an already-compensated step, I2).

---

## 5. Semantics & failure modes

**Consistency model: saga (eventual, with a guaranteed terminal state), NOT global ACID.** A saga is
**not** atomic across apps — intermediate states are observable (inventory is reserved before payment
clears). It guarantees only that every instance terminates Committed (all forward effects applied) or
Compensated (all applied forward effects semantically undone). This is the strongest cross-app
guarantee a no-global-quorum mesh can give (`primitives.md`). Within a single participant's local
transaction, that participant's own atomicity holds (e.g. `ce-db`'s `WriteBatch::commit` is atomic
per collection, `ce-db/src/batch.rs`); the saga composes those local atomic units.

**Ordering.** Forward steps run in definition order (or `StepOutcome.next`); compensations run in
strict reverse of completed steps (I5). Within one instance the `Replicated<SagaState>` log is a total
order; across instances there is no ordering (each instance is independent). HLC (`Ctx.hlc`) stamps
each transition for cross-app causal tracing (06/09), never for safety.

**Delivery.** Step dispatch is at-least-once (the `03` queue); step *effect* is at-most-once given an
idempotent handler + `Ctx.idem` (I2). The saga guarantees the workflow reaches its terminal state, not
that a non-idempotent handler runs once — non-idempotency is the handler author's bug, surfaced loudly
in the docs (mirrors `03 §5` "handler exactly-once is the consumer's job").

**Fencing — the safety boundary, enforced by the participant.** A TTL lease alone is unsafe: an
orchestrator can pause (GC/VM stall) past its lease, a sibling take over, and the zombie issue a stale
`Forward`. CE makes this safe exactly as `08` does: every `StepCall` carries the monotone lease `Fence`
(`08` I2), and **the participant records the highest fence it has applied per instance and rejects any
call with a lower fence** (`Status::Aborted`). This converts "I think I still drive this instance" into
a provably-stale call the participant refuses — no double-forward, no double-compensate. CE provides the
monotone token and the linearized lease; the *check* is app policy on app state (the boundary: the node
has no concept of the saga).

**Crash / partition behavior:**

- *Orchestrator crash:* the instance lease expires on the `08` leader's clock; a sibling acquires it
  with a higher fence, catches up the log, and resumes from `cursor`/`phase` (I4, §4.3 step 6). In-flight
  old `StepCall`s are fenced out (I3).
- *Participant crash mid-forward:* the `03` step message's lease expires and redelivers; the retried
  `Forward` carries the same `Ctx.idem`, so if the participant *had* applied the effect before crashing
  it returns the recorded outcome (`AlreadyApplied`), else it runs it now (I2).
- *Participant permanently unreachable:* the step exhausts `RetryPolicy.max_attempts` → DLQ → the
  orchestrator triggers `BeginCompensate`, undoing prior steps; the instance terminates `Compensated`
  (the customer is made whole) rather than hanging.
- *Minority partition of the `08` group:* the minority cannot acquire/renew an instance lease →
  `Unavailable`; the majority side continues to drive instances. No split-brain (the fence guarantees
  it even across the partition heal — `08 §5`).

**What it does NOT guarantee:**

- **Not isolation / not ACID.** Intermediate states are visible to concurrent readers; a saga is not a
  serializable transaction. Apps needing isolation must add their own (e.g. a `08` lock on the
  contended resource for the saga's duration) — that is composition, not a saga property.
- **Not automatic compensation correctness.** The *meaning* of "undo step X" is the app's; a
  semantically wrong compensation produces a wrong-but-terminal state. CE guarantees the compensation
  *runs* (I1/I5), not that it is business-correct.
- **Not Byzantine-tolerant.** The `08` orchestrator group is crash-fault-tolerant only; membership is
  capability-gated to a set the app trusts (`08 §5`). For workflows across mutually-distrusting parties
  the trustless lever remains the chain (escrow/burn), with the saga step's effect being an on-chain tx.
- **No global cross-instance transactionality.** Two sagas touching the same resource can interleave;
  coordinate them with `08` locks if needed.
- **`Failed` is possible.** If a compensation is *logically* impossible (an external effect that cannot
  be undone and was not designed with a forward-recovery alternative), the instance terminates `Failed`
  and is surfaced for operator action — never silently dropped.

---

## 6. Security & economy

**Abilities (contract §3).** `saga:start` / `saga:step` / `saga:admin`, scoped by `ce-cap::Resource::Tag`:

- a starter grant: `{ abilities: ["saga:start"], resource: Tag("saga:ce-shop/checkout") }` — may start
  only the `checkout` saga.
- an admin grant: `{ abilities: ["saga:admin"], resource: Tag("saga:ce-shop/checkout") }` — register /
  retire the definition, force-compensate, purge history.
- **the participant-call authorization is the subtle, important part.** When the orchestrator calls a
  participant's step (e.g. `db:write` on a `ce-db` collection), the orchestrator does **not** hold the
  end-user's authority by ambient privilege. The `start` grant the user gave the orchestrator
  **attenuates** into the chain the orchestrator presents on the `StepCall` (`Ctx.cap`): the user signs
  a grant authorizing this saga def to perform exactly the steps' abilities on exactly the named
  resources, the orchestrator presents that attenuated chain to each participant, and the participant
  verifies it with `ce-cap::authorize` (`is_narrower_or_equal`, `ce-cap/src/lib.rs:151`). So a saga can
  only ever do what the *user* could do — least privilege end to end, no orchestrator god-mode. This is
  the `ce-iam` inverse-of-AWS model (the resource owner accepts a root, `ce-iam/src/lib.rs`) applied to
  a multi-hop workflow. Abilities join the documented action universe for `ce-iam` wildcard expansion
  (`Iam::with_action_universe`, `ce-iam/src/lib.rs:50`) but stay **opaque to `ce-cap`** (contract §0
  rule 3 / `primitives.md`).

**Abuse / DoS bounds**, all enforced by the receiving node's contract-§11 admission keyed by
`(from, ns, ability)`, plus saga-app caps:

- **Start storms:** rate-limit `saga:start` per identity; the orchestrator additionally bounds
  concurrent in-flight instances per tenant (`ResourceExhausted` + `retry_after_ms` over the ceiling).
- **Step fan-out bomb:** a definition's `parallel` width and total step count are bounded at
  `saga:admin` publish time; a `StepOutcome.next` loop is bounded by an overall step-count budget per
  instance (a runaway loop terminates `Failed`, never spins forever).
- **Retry/log churn:** `RetryPolicy.max_attempts` caps forward retries; the instance log is compactable
  (`ce-coord` `snapshot.rs`) so a long workflow's log is bounded; the `03` DLQ caps poison-step churn.
- **Topic isolation:** `ns` scoping (contract §6) keeps one tenant's instance logs/events off another's
  subscribers; the `08` group and `03` queue are per-`(ns, def)`.
- **Fence enforcement is mandatory:** a participant that ignores the fence (§5) re-opens the zombie
  window — the SDK makes the fence the only way to obtain a step-call token and ships the check.

**Optional payment-channel metering.** A saga's steps may each have economic weight; the saga composes
the existing `channels` primitive (`ce-rs::sign_receipt`/`channel_close`, `ce-rs/src/lib.rs:539-570`)
two ways: (1) a *paid step* — the participant requires a per-step receipt before applying the forward
action, and the compensation issues a refunding receipt (or an on-chain `Transfer`) on rollback; (2) a
*metered orchestration* — running an instance debits the starter per committed step (pay-as-you-progress,
mirroring the heartbeat burn-pay model, `primitives.md` §7), so a long workflow is priced by work done
and a compensated saga refunds the unstarted remainder. Default is unmetered (cap-gated only); metering
is an app opt-in, never a CE requirement.

---

## 7. Composition

**Depends on (in-edges, contract §5):**

- `00`/§2 **`Ctx` envelope** — `cap` (per-step least-privilege authz), `idem` (exactly-once start +
  exactly-once step effect, the spine), `deadline_ms` (per-step + overall bound), `trace` (whole-workflow
  trace), `hlc` (causal step ordering).
- `09-causal-time-idempotency-counters.md` — the node dedup table backs I2 (exactly-once step effect);
  HLC stamps every transition for cross-app causal order.
- `03-durable-queue.md` — the saga's step dispatch + per-step retry/backoff + poison→DLQ is a `03`
  queue; the DLQ event is the orchestrator's `BeginCompensate` trigger (`03 §7` names this enablement
  reciprocally).
- `08-locks-leases-election.md` — the per-instance lease+fence makes exactly one orchestrator drive an
  instance (I3/I4); a crashed orchestrator's instances are resumed by a sibling. (`08 §7` lists "a saga
  instance owns its run via a lease" as an out-edge.)
- soft: `01-service-registry-binding.md` (`find_service` an orchestrator/participant),
  `12-schema-contract-config-registry.md` (validate step payloads against a published contract; the
  saga definition is itself content-addressed like a 12 schema), `07-telemetry-metrics-health.md`
  (in-flight/compensating/failed counts as SLIs), `06-distributed-tracing.md` (the whole workflow is one
  trace via `Ctx.trace`).

**Enables (out-edges):** the saga is the top of the dependency graph (contract §5 places `{10,12}`
last) — it is the substrate for any multi-app product workflow: `ce-gke` multi-service rollouts (deploy
A, B, C; roll back all on a failed health check), `ce-ci` pipelines (build→test→publish with cleanup
compensation), a sharded game's match lifecycle (reserve sector `08`, allocate slots, start sim; release
all on abort), `ce-shop`/checkout, `ce-mail` send-with-rollback. It does not enable a lower primitive; it
consumes them.

---

## 8. Test plan

**Deterministic cores (unit, no mesh — the strength to lean on, like `replicated.rs`'s in-process tests):**

- *State machine fold:* feed a fixed `Vec<SagaOp>` and assert the resulting `SagaState` is a pure
  function of op order — `cursor`, per-step `status`, `phase`, and the compensation stack. Assert I5:
  on `BeginCompensate`, exactly the `Done` prefix (in reverse) is compensated, each exactly once.
- *Terminal-state property (I1):* `proptest` over random interleavings of step success/transient-fail/
  terminal-fail/compensation-success — every generated instance reaches exactly one terminal `Phase`;
  no instance is left `Running`/`Compensating` once all retries are exhausted.
- *Exactly-once effect (I2):* apply the same `StepCall` (same `Ctx.idem`) twice against a mock
  participant counting effects; assert the effect count is 1 and the second call returns `AlreadyApplied`.
- *Fence rejection (I3):* a participant that applied fence `{term:4,index:140}` rejects a `StepCall`
  carrying `{term:4,index:128}` with `Aborted`; accepts a `>=` fence.
- *Compensation completeness round-trip:* run forward through k steps, inject a failure at step k+1,
  assert all k compensations run in reverse and the instance terminates `Compensated`; resume mid-
  compensation (replay the log up to step `j` compensated) and assert no double-compensation (I2/I5).
- *Parallel group `Partial` (contract §4):* a fan-out where one branch fails returns `Partial` with the
  failed branch listed and triggers `BeginCompensate` for the whole group + prior steps; never reports
  group success.
- *Definition validation:* bounded fan-out width / total step count / loop budget at `publish` time
  (`InvalidArgument` past the bound).

**Integration (over `ce-coord/src/testkit.rs`'s `MockNode` / in-process mesh, `within(...)`):**

- One orchestrator + 3 participant apps on separate `MockNode`s: run a 4-step linear saga end to end via
  the real `Coord` pump + a `03` queue; assert Committed and each forward ran once.
- *Failure-then-compensate:* make step 3's participant return a terminal `Status`; assert steps 2,1
  compensate in reverse and the instance terminates `Compensated`.
- *Orchestrator crash + resume:* with a 3-member `08` group, kill the lease-holding orchestrator mid-run
  (testkit drop path); assert a sibling acquires a higher fence, resumes from `cursor`, and the
  formerly-leading orchestrator's late `StepCall` is fenced out (`Aborted`) at the participant — exactly
  one terminal state, no double-effect.
- *Participant crash mid-forward:* drop the participant's reply after it applied the effect; the `03`
  redelivery retries with the same `idem`; assert `AlreadyApplied` and one effect.
- *Idempotent start:* two `start`s with the same `Ctx.idem` after a dropped reply → one instance,
  same `InstanceId`, `AlreadyApplied`.

**Needs a live multi-node mesh (Hetzner/desktop, `ce-deploy` style):**

- Orchestrator, participants, and starter on *different* nodes over real `ce-rs::request` across libp2p
  (relay-assisted), validating directed routing + per-step `Ctx.cap` attenuation end to end.
- Real network partition of the `08` group: confirm a partitioned orchestrator stalls (`Unavailable`),
  the majority resumes the instance, and the fence prevents any double-step on heal.
- Long-running workflow with `ce-coord` snapshot/compaction of the instance log mid-flight; assert
  resume-from-snapshot preserves `cursor`/`phase`/step outputs.

---

## 9. Worked example: cross-app order checkout (and a sharded game match lifecycle)

**Order checkout across four apps.** A storefront (`ce-shop`) checkout must: (1) reserve inventory in a
`ce-db` collection, (2) charge the customer over a payment channel, (3) book a shipment in a logistics
app, (4) email a receipt via `ce-mail`. No global transaction is possible (four apps, four owners). On
CE:

1. The shop publishes a `checkout` definition (`SagaDefBuilder::ns("ce-shop").name("checkout")`):
   step `reserve` → `ce-db` (compensation: release reservation), `charge` → payment channel
   (compensation: refund receipt / on-chain `Transfer`), `ship` → logistics (compensation: cancel
   booking), `notify` → `ce-mail` (no compensation — last step). The definition is content-addressed
   (`put_object`) and advertised (`advertise_service "ce-shop/orchestrator.checkout"`).
2. Three shop backend nodes run `Orchestrator::run(... group_members=[n1,n2,n3])` — an `08` Raft group
   so each instance is lease-owned and survives a node crash.
3. The customer's browser holds a `start` grant the user signed: `saga:start` on
   `Tag("saga:ce-shop/checkout")`, attenuated to authorize exactly `db:write` on their cart's
   reservation doc, a channel charge up to the order total, etc. It calls
   `SagaClient.start(order_bytes, ctx{ idem: order_id, cap: <grant chain> })` → `InstanceId`. Retried
   network calls reuse `order_id` as `Ctx.idem`, so a double-click never double-orders (I2 at start).
4. The owning orchestrator drives forward: `reserve` (Done), `charge` (Done). `ship` times out
   (`Unavailable`) — the `03` step queue retries with backoff per `RetryPolicy`; after `max_attempts`
   it dead-letters. The orchestrator proposes `BeginCompensate` and walks back: cancel nothing for
   `ship` (never Done), **refund** the `charge`, **release** the `reserve`. Instance terminates
   `Compensated`; the customer is whole, inventory freed, no half-applied order.
5. Mid-`charge`, orchestrator n1 is paused by GC past its lease. n2 acquires the instance lease (higher
   fence), resumes from `cursor`, and re-issues `charge` with `Ctx.idem = H(instance,"charge","fwd")`.
   The payment participant already applied the charge under that idem → returns the recorded receipt
   (`AlreadyApplied`) — no double charge (I2). When n1 wakes and flushes its stale `charge` `StepCall`,
   the payment participant rejects it (fence below n2's, `Aborted`) — the zombie is fenced out (I3).
6. A UI follows `SagaClient.events()` to show "Reserved → Charged → Shipping…"; 07 reads the
   compensating/failed counts as SLIs; 06 sees the whole four-app flow as one trace via `Ctx.trace`.

**Sharded game match lifecycle (task #5).** A match is a saga: `claim-sector` (`08` lock on
`Tag("lock:ce-game/sector-7")`, compensation: release), `allocate-slots` (`ce-db`, compensation: free
slots), `start-sim` (compensation: tear down sim). If `start-sim` fails on the chosen shard, the saga
compensates — slots freed, sector released — and the matchmaker retries placement elsewhere, never
leaving a half-started match holding a sector. The saga composes `08` (sector ownership) + `03`
(redelivery) + `09` (idempotent slot allocation) into the match's guaranteed-terminal lifecycle.

---

## 10. Effort & minimal first slice

**Effort: L.** The orchestration engine itself is moderate (the `SagaState` state machine, the forward/
compensate driver, parallel-group `Partial` handling, fence stamping, resume-from-log), but it **reuses**
the three hard substrates wholesale — `03`'s lease/ack/retry/DLQ, `08`'s Raft lease+fence, `09`'s idem
dedup, and `ce-coord`'s `Replicated`/snapshot/catch-up — so there is no new transport, no new consensus,
and no new persistence to build. The bulk of the risk is correctness (I1–I5), which is precisely what the
deterministic state-machine + property tests pin down without a mesh.

**Minimal first slice (S→M, ships value immediately, no node change beyond the shared `Ctx`):**

1. `SagaState`/`SagaOp` state machine + the forward-then-compensate driver + the §8 deterministic
   unit/property tests (I1, I2, I5) — **no networking, no 08, no 03**. This alone is reviewable and
   proves the terminal-state and compensation-completeness guarantees.
2. A **single-orchestrator, single-node** runtime: `Orchestrator::run` over the existing `ce-coord`
   `Replicated<SagaState>` writer path + in-process participants, driving a linear saga end to end with
   idempotent steps (exercise I2 against a mock participant). Step dispatch is plain directed
   `request`/`reply` (no 03 queue yet); retries are an inline loop.
3. Then layer in **03** (durable retry/DLQ for steps), **08** (the instance lease+fence for HA
   orchestrator failover, I3/I4), and **parallel groups** (`Partial`, contract §4) — each behind the
   same `Orchestrator`/`SagaClient`/`Participant` call sites, so adopters (checkout, game match, `ce-gke`
   rollout) wire up on the single-node path first and gain crash-resumability and durable retry without
   an API change. This sequences risk exactly as `08`'s minimal slice does (the call sites stay fixed
   while the consensus/durability hardens behind them).
