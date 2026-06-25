# 11 — Flow control, rate limiting, quotas & admission control

**Status:** implementation-ready. Conforms to `00-architecture.md` (the contract). Ground truth:
`ce/crates/ce-mesh/src/lib.rs` (`RpcRequest::{AppRequest,AppMessage}`, `RpcResponse::{AppReply,Error}`,
`AppPubSubMsg`/`app_pubsub_bytes`/`ce-app-pubsub-v1`, `APP_TOPIC_PREFIX = "ce-app/"`,
`MAX_RPC_BYTES = 256 MiB`, `MeshEvent::IncomingRpc` + `ResponseChannel`, the `/ce/rpc/1` codec),
`ce/crates/ce-node/src/api.rs` (`mesh_request`/`mesh_send`, the `AppInbox`, the inbound dispatch path),
`ce/crates/ce-chain/src/lib.rs` (`balance` :1844, `locked_balance` :1851, `bond_of` :1886,
`HostBond`/`HostUnbond`/`Slash`, `SUPPLY_CAP` :490, payment-channel `ChannelOpen`/receipt/close),
`ce-rs/src/lib.rs` (`request`/`send_message`/`publish`, `channel_open`/`sign_receipt`/`pay_relay`,
`NodeStatus.{free,locked_bond,bond}`), `ce-coord/src` (the inbox pump + `Dedup`), the contract `Ctx`
keystone (`00-architecture.md` §2: `cap`, `ns`, `deadline_ms`), `Status::ResourceExhausted` (§4), and
`ce/docs/primitives.md` (the boundary; the economy = built-in DoS resistance argument). This primitive
is the §0.1 row 11 / §1 row "Admission / rate limit / quota (11)" node-plane enforcement point.

## Conformance block (contract §7)

1. **Plane** — **NODE enforcement, economy-tied** (contract §0.1 row 11; §1 row "Admission / rate
   limit / quota (11)"). Admission is the one decision that *must* be made by the receiving node,
   inside `ce-node`, **before it dispatches the request to any app handler** — exactly the
   `primitives.md` governing rule ("the node is the enforcement point… anything that must be enforced
   lives in CE — but it stays generic"). A library cannot rate-limit: by the time a stranger's app
   code runs, the work (and its memory/CPU/Docker pull) is already happening. So per-`(from, ns, ability)`
   token buckets + credit-/bond-backed quota live in the node. **No new `RpcRequest` variant**:
   admission is a generic gate on the *existing* `AppRequest`/`AppMessage`/`AppPubSubMsg` inbound path,
   keyed off the already-present `Ctx{ cap, ns }` + the node-verified `from`. The only wire-format
   change anywhere is the shared `Ctx` keystone (contract §2) plus a new `Status::ResourceExhausted`
   reply carrying `retry_after_ms` (contract §4, already reserved). The **policy** — how high a quota a
   tenant gets, what a credit buys — is set by `quota:admin` grants and the economy, never hard-coded.
2. **Abilities** — reserves `quota:admin` (contract §3): raise/set a named quota class for a tenant,
   scoped via `ce-cap::Resource` as `Tag("ns:<tenant>")` or `Tag("quota:<class>")`. Rate limits
   themselves are **economy-gated, not cap-gated by default** (contract §3 note on row 11): every
   authenticated caller gets a free baseline bucket; *raising* it is done by paying credits / posting a
   bond, not by holding a capability — so a stranger cannot DoS, and a payer gets proportional headroom
   without a central admin issuing grants. `quota:admin` exists for the org case (a fleet owner pins a
   per-tenant ceiling administratively).
3. **Envelope use** — reads `Ctx{ from(implicit), ns, cap, deadline_ms }`. Keys every bucket on
   `(from, ns, ability)` where `from` is the node-verified sender NodeId (`AppMessage.from`), `ns` is
   the contract §6 namespace, and `ability` is the `domain:verb` the call's `cap` authorizes (or the
   topic class for pubsub). Reads `deadline_ms` only to choose between *shed* (reject with
   `ResourceExhausted`) and *queue* (hold until the bucket refills, bounded by the remaining deadline).
   **Writes** nothing to `Ctx`; the only new field on the wire is the reply's `retry_after_ms` (a
   `RpcResponse`/HTTP `Retry-After` header), never a parallel request header.
4. **Status & partial failure** — sole producer (with 09's dedup) of `Status::ResourceExhausted`
   (contract §4): returned **before dispatch** when a bucket is empty / a quota is exhausted, always
   carrying `retry_after_ms` so 05's breaker and backoff are deterministic (contract §4: "carries
   Retry-After"). A batch/fan-out admission (e.g. a producer pushing N queue messages, 03) returns
   `Partial<Accepted>` so the caller sees *which* sub-requests were admitted and which hit
   `ResourceExhausted` — never collapses a partial-shed to one bool (contract §4). Also returns
   `Unauthorized` if a `quota:admin` call lacks the cap.
5. **Dependencies** — in-edges (contract §5 graph): the **`Ctx` envelope** (the keystone; ships first)
   and the **economy** (`ce-chain` balances/bond/channels — pre-existing, not a scale primitive). 11 is
   one of the node-plane trio (06/09/11) that needs only `Ctx`; it ships immediately after the envelope.
   It has a **bidirectional backpressure trade with 05** (`05-resilient-rpc.md`): 11 emits
   `ResourceExhausted` + `retry_after_ms`, which drive 05's circuit breaker and backoff; 05's
   retries/hedges are themselves admitted (and throttled) by 11, so a retry storm is capped at the
   receiver. It **enables** every durable primitive to be safe under load: **03 queue** (per-producer
   admission so one app can't sink a shared queue), **04 event log** (append rate), **07 telemetry**
   (11 exports its shed/admit counters as SLIs), **02 placement** (a throttling host signals
   `ResourceExhausted` → 02 routes around it). It does **not** depend on 01/02/03/04/08/10/12.
6. **Namespacing** — all buckets and quotas key under contract §6: `(from, ns, ability)` for rate; the
   credit-backed quota balance is per-`(ns, payer)`; a `quota:admin` ceiling is a `(ns, class)` record.
   Pubsub admission keys on the full topic `ce-app/<ns>/<logical>` (contract §6) so one tenant's
   firehose cannot starve another's topic. Default empty `ns` ⇒ the caller's own NodeId hex (a private,
   per-key bucket) — an app that ignores multi-tenancy still gets isolated admission for free.
7. **Boundary check** — no app policy enters the node: the node enforces a generic token bucket keyed
   by an opaque `(from, ns, ability)` triple and a generic credit/bond balance, learning nothing about
   what the ability *means* or what a tenant *is* ("tenant" stays a `ce-cap` resource tag). Stranger
   code never bypasses the local node — admission runs on the local receiving node before any app
   handler sees the request, and the only authorization that can *raise* a limit is a paid credit
   transfer / bond (the ledger) or a signed `quota:admin` chain through the local node.

---

## 1. Purpose & the at-scale problem

At one app on two nodes, flow control is invisible: a single caller, a single handler, `MAX_RPC_BYTES`
(`ce-mesh/src/lib.rs:217`) caps one message and that is enough. At a dozen interdependent apps
(`ce-db`, `ce-pubsub`, `ce-query`, `ce-iam`, `ce-gke`, games) sharing **one mesh, one DHT, one node**,
the absence of admission control is the single failure that takes down everyone at once:

- **One app sinks the mesh.** A buggy or hostile app on one node sprays `request`/`publish` at a host
  running five other apps. Every inbound `AppRequest` allocates an inbox slot, a task, possibly a
  Docker pull. With no per-sender ceiling, the firehose evicts the shared `AppInbox` ring
  (`ce-node/src/api.rs:1855`, best-effort + capped) and starves every honest app — a noisy-neighbor
  outage that no app can fix from inside its own code, because the damage is done before the app runs.
- **Retry storms amplify brownouts.** When a host slows, 05's callers retry. With no receiver-side
  admission, retries pile linearly onto an already-overloaded peer and a brownout becomes an outage.
  The receiver needs to *say* "back off" (`ResourceExhausted` + `retry_after_ms`) so 05's breaker
  (`05-resilient-rpc.md` §3) trips, not just absorb the storm.
- **No fair share, no DoS price.** On a leaderless trustless mesh, anyone can mint a fresh NodeId
  (`primitives.md`: "new identities start as strangers"). If admission were a flat per-key bucket, a
  Sybil sprays a thousand keys and reclaims the whole budget. The defense the platform *already has*
  is the economy: credits are scarce, mined or bought, and the chain is the global record of who paid.
  **Tying quota to credits makes DoS resistance and fair sharing the same mechanism** (`primitives.md`
  trust gradient + "honesty is the profitable strategy"): a free baseline that is cheap to honour for
  honest strangers, and proportional headroom that costs real credits — so flooding the mesh has a
  price, and a paying tenant is guaranteed its share.

The concurrency problem this solves is **fair admission under shared, adversarial load**: many senders,
many tenants, one shared node, untrusted strangers, and effects (Docker, blobs, queue writes) that are
expensive to start. CE already has every piece: a node enforcement point that runs before dispatch
(`MeshEvent::IncomingRpc`, `ce-mesh/src/lib.rs:867`), a verified sender (`AppMessage.from`), the
`Ctx{ ns, cap }` keys (contract §2), a scarce credit ledger (`ce-chain::balance` :1844), a host bond
(`bond_of` :1886) as skin-in-the-game, and payment channels (`channel_open`/`sign_receipt`) for
fine-grained metering. 11 assembles them into one admission gate.

---

## 2. Plane: node vs ce-coord, and the justification

| Concern | Plane | Where | Why |
|---|---|---|---|
| Admission decision (admit / shed / queue) before dispatch | **node** | `ce-node` inbound, before `IncomingRpc`/inbox | a peer that does not run the app must refuse work before the handler allocates anything (contract §1, `primitives.md` governing rule) |
| Per-`(from, ns, ability)` token bucket | **node** | `ce-node`, bounded in-memory map | generic byte/coin mechanism every app would reinvent → primitive; keyed on node-verified `from` |
| Credit-/bond-backed quota lookup | **node** | `ce-node` reads `ce-chain` balance/bond | the ledger is a node primitive; quota height is a pure function of paid credits, no app vocabulary |
| `retry_after_ms` on the throttled reply | **node** | `RpcResponse`/HTTP `Retry-After` | the receiver is the only party that knows when its bucket refills |
| **Quota policy** (curve: credits→tokens, class ceilings) | **node config + economy** | `ce-node` config defaults + `quota:admin` grants | the *shape* of the curve is operator/economy policy, but it is generic numeric policy (no company/team concept) — like difficulty, it is a node parameter, not app logic |
| **Choosing** to back off / retry on `ResourceExhausted` | **coord/SDK** | `ce-rs`/`05` breaker | a pure caller decision read from `Status` + `retry_after_ms` (contract §1; mirrors 05's split) |
| Cross-node *aggregate* quota (a tenant's total budget across N hosts) | **coord** | `ce-coord` (optional, §5) | summing per-node admission is a typed client aggregation; the node enforces only its *local* share |

**Justification.** The contract's §1 closed list already grants 11 exactly one node-plane behavior:
"per-`(identity, ability, tenant)` token buckets + credit-backed quota; the node returns
`429`/`Status::Throttled` before dispatch. Economy-tied: paying credits raises the bucket." That is the
whole of 11's node delta, and it is node-plane for the same reason 05's deadline and 09's dedup are:
**it must be enforced by a peer that does not run the caller's app, before any work starts.** Everything
*reactive* — deciding to back off, retry, hedge, or shed at the caller — is 05's job, a caller-local
decision. Putting the quota *curve* in the node is not "app policy": it is a generic numeric parameter
(credits→tokens) exactly like the existing `difficulty` self-adjust or `EXPIRY_BLOCKS` — no product
concept (company, team, plan name) appears; a "tenant" is only a `ce-cap` resource tag and an `ns`
string. So 11 is a small node gate plus an economy lookup, and a thin SDK surface for reading/raising
your own quota.

---

## 3. Public API

### 3.1 Node plane — the admission gate (behavior, not a new RPC)

Admission runs on the inbound path of `ce-node`, before a request is surfaced as
`MeshEvent::IncomingRpc` (`ce-mesh/src/lib.rs:867`) or enqueued in the `AppInbox`
(`ce-node/src/api.rs:1855`). The gate is a pure function over node-local state:

```rust
// ce-node: the admission controller. One per node, behind a Mutex on the inbound path.
// Generic: it knows (from, ns, ability) opaque keys and credit/bond amounts — no app vocabulary.
pub struct Admission {
    buckets: HashMap<BucketKey, TokenBucket>,   // bounded LRU; idle buckets evicted
    classes: HashMap<(String /*ns*/, String /*class*/), QuotaClass>, // quota:admin overrides
    cfg: AdmissionCfg,                          // node-config curve + defaults
}

#[derive(Hash, PartialEq, Eq, Clone)]
pub struct BucketKey { pub from: NodeId, pub ns: String, pub ability: String }

/// Standard token bucket: integer tokens (consensus-safe per primitives.md — no floats), refilled at
/// `rate` tokens/sec up to `burst`. One inbound admission costs `cost` tokens (size-weighted, §4.2).
pub struct TokenBucket { tokens: u64, burst: u64, rate_milli: u64, last_refill_ms: u64 }

#[derive(Debug, Clone)]
pub enum Admit {
    /// Admit now; dispatch proceeds.
    Ok,
    /// Shed: reply Status::ResourceExhausted with this hint; do NO work.
    Throttled { retry_after_ms: u64 },
}

impl Admission {
    /// THE gate. Called on every inbound AppRequest/AppMessage/AppPubSubMsg before dispatch.
    /// `cost` is the weighted cost (§4.2). `free_credits`/`bond` come from ce-chain for `from` in `ns`.
    /// Pure + deterministic given (state, now_ms) — unit-testable with no mesh.
    pub fn admit(&mut self, key: &BucketKey, cost: u64, now_ms: u64,
                 free_credits: u128, bond: u128) -> Admit;
}
```

`AdmissionCfg` is node config (defaults shipped, overridable like difficulty), all integers:

```rust
pub struct AdmissionCfg {
    /// Free baseline every authenticated sender gets per (ns, ability), no payment: burst + rate.
    pub base_burst: u64, pub base_rate_milli: u64,        // e.g. 64 burst, 8000 = 8 req/s
    /// Credits→tokens curve: each whole credit of `free` balance held by `from` in `ns` adds this many
    /// tokens/s of rate and this much burst, capped at `max_*`. Integer, monotone, no float (§4.3).
    pub rate_per_credit_milli: u64, pub burst_per_credit: u64,
    pub max_burst: u64, pub max_rate_milli: u64,
    /// A posted host bond (bond_of) multiplies the ceiling (skin-in-the-game → trusted-strangers tier).
    pub bond_multiplier_bps: u64,                         // e.g. 20000 = 2x at full bond
    /// When a bucket is empty: shed immediately, or hold up to this long if Ctx.deadline_ms allows.
    pub max_queue_ms: u64,
}
```

Two **read-only operability** HTTP routes (not enforcement; safe to expose like `/atlas`, mirror
09's `/clock`):

| Method | Path | Returns | Use |
|---|---|---|---|
| GET | `/admission` | `{ buckets: u64, shed_total: u64, admit_total: u64, ns: [{ns, ability, admit, shed, tokens, burst}] }` | per-`(ns,ability)` admit/shed counts + live bucket fill (07 telemetry source) |
| GET | `/admission/quota/:ns` | `{ ns, free_credits: "<base-units>", base: {burst,rate_milli}, effective: {burst,rate_milli}, class: <name|null> }` | what budget *this* sender currently has in `ns` (amounts are base-unit **strings**, `primitives.md`) |
| POST | `/admission/quota` | sets a `quota:admin` class ceiling for `(ns, class)` — gated by a `quota:admin` cap in the body (the only mutating route) | org-admin override |

No new `RpcRequest` variant, no new gossip topic. The throttled reply reuses the existing
`RpcResponse::Error(String)` carrying `"ResourceExhausted: retry_after_ms=<n>"` for old peers, plus the
structured `Status::ResourceExhausted { retry_after_ms }` the contract §4 reserved for new peers.

### 3.2 Rust SDK (`ce-rs`) — read & raise your own quota

The hot path needs **no SDK change**: admission is transparent; a throttled call surfaces as
`Status::ResourceExhausted` through the existing `request`/`send_message`/`publish` results (05 reads
it). `ce-rs` adds only introspection + the economy actions that raise a quota:

```rust
impl CeClient {
    /// This sender's effective admission budget in `ns` (GET /admission/quota/:ns): the free baseline
    /// plus credit-/bond-derived headroom. Apps poll this to self-pace before they get throttled.
    pub async fn quota(&self, ns: &str) -> Result<Quota>;

    /// Node-wide admission stats (GET /admission) — feeds 07 dashboards.
    pub async fn admission_stats(&self) -> Result<AdmissionStats>;

    /// Raise an org quota class ceiling for a tenant (POST /admission/quota). Requires a `quota:admin`
    /// capability chain (bincode bytes) authorizing `Tag("ns:<tenant>")`; returns Unauthorized otherwise.
    pub async fn set_quota_class(&self, ns: &str, class: &str, burst: u64, rate_milli: u64,
                                 cap: &[u8]) -> Result<()>;

    // --- raising your OWN quota is just the existing economy surface, no new method needed: ---
    //   self.transfer(host, amount)        -> fund/pre-pay credits the host counts as `free` (§4.3)
    //   self.channel_open(host, capacity)  -> meter admission per-request over a channel (§6)
    //   (host bond is `ce` CLI / HostBond tx; surfaced in NodeStatus.bond)
}

/// One sender's admission budget in a namespace. Amounts are base-unit `Amount` (strings on the wire).
#[derive(Debug, Clone, Deserialize)]
pub struct Quota {
    pub ns: String,
    pub free_credits: Amount,            // reuse ce-rs Amount (amount.rs)
    pub base_burst: u64, pub base_rate_milli: u64,
    pub effective_burst: u64, pub effective_rate_milli: u64,
    pub class: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AdmissionStats { pub buckets: u64, pub admit_total: u64, pub shed_total: u64,
                            pub per_ns: Vec<NsAdmission> }
#[derive(Debug, Clone, Deserialize)]
pub struct NsAdmission { pub ns: String, pub ability: String, pub admit: u64, pub shed: u64,
                         pub tokens: u64, pub burst: u64 }
```

These reuse the existing `Amount` (`ce-rs/src/amount.rs`), `NodeStatus.{free,bond}`
(`ce-rs/src/lib.rs:603-613`), and `transfer`/`channel_open`/`sign_receipt` — nothing new in the money
path.

### 3.3 `ce-coord` — self-pacing & optional cross-node aggregate

`ce-coord` owns no enforcement; it provides ergonomics the node cannot:

```rust
impl Coord {
    /// A client-side rate governor that self-paces to the node's reported quota so an app stays UNDER
    /// its admission limit (avoiding ResourceExhausted churn): a leaky-bucket pacer seeded from
    /// `CeClient::quota`, refreshed periodically. Pure client policy over the node's numbers.
    pub fn pacer(&self, ns: &str, ability: &str) -> Pacer;

    /// Optional aggregate quota across a fleet: sum each host's local admission via /admission, so an
    /// app sees its TOTAL mesh-wide budget. Read-only aggregation over the three verbs; the node still
    /// enforces only its own local share (no global rate-limit coordinator — that would be a bottleneck).
    pub async fn fleet_quota(&self, hosts: &[&str], ns: &str) -> Result<FleetQuota>;
}
pub struct Pacer { /* leaky bucket; acquire().await yields when a token is available locally */ }
impl Pacer { pub async fn acquire(&self, cost: u64); pub fn try_acquire(&self, cost: u64) -> bool; }
```

### 3.4 TS SDK (`ce-ts`) — mirror

```ts
interface Quota { ns: string; freeCredits: string; baseBurst: number; baseRateMilli: number;
                  effectiveBurst: number; effectiveRateMilli: number; class?: string }
class CeClient {
  quota(ns: string): Promise<Quota>;                                   // GET /admission/quota/:ns
  admissionStats(): Promise<AdmissionStats>;                           // GET /admission
  setQuotaClass(ns: string, cls: string, burst: number, rateMilli: number,
                cap: Uint8Array): Promise<void>;                       // POST /admission/quota
  // raising own quota: transfer()/channelOpen() already exist
}
// throttling surfaces as the shared Status.ResourceExhausted (with retryAfterMs) on any request/publish.
class Pacer { acquire(cost: number): Promise<void>; tryAcquire(cost: number): boolean }
```

---

## 4. Protocol & data structures

### 4.1 Where the gate sits (the inbound path)

The admission gate is a single call on the node's inbound dispatch, **before** either of the two
delivery paths the node already has:

```text
inbound AppRequest/AppMessage(from, ctx, topic, payload)  [verified `from` from Noise PeerId]
  ├─ ability = ability_for(ctx.cap, topic)        // the domain:verb the cap authorizes, or topic class
  ├─ key   = BucketKey{ from, ns: ctx.ns, ability }
  ├─ cost  = weight(payload.len(), kind)          // §4.2
  ├─ (free, bond) = chain.free_balance(from, ns), chain.bond_of(from)   // ce-chain :1844/:1886
  ├─ match admission.admit(key, cost, now, free, bond):
  │     Throttled{retry_after_ms} -> reply Status::ResourceExhausted{retry_after_ms}; DO NO WORK
  │     Ok                        -> proceed
  ├─ (then 09 dedup, 05 deadline, ce-cap verify — all already on this path)
  └─ surface MeshEvent::IncomingRpc / enqueue AppInbox   (ce-mesh:867 / api.rs:1855)
```

For **pubsub** (`AppPubSubMsg`, `ce-mesh/src/lib.rs:304`), admission keys on the full topic
`ce-app/<ns>/<logical>` and the publisher's verified `from`; an over-quota publisher's message is
dropped at the subscriber's node before it reaches the `AppInbox` (gossip is best-effort, so a drop is
in-band — no reply needed). This caps a per-topic firehose without a queue.

Ordering of gates on the inbound path (all node-plane, contract §2 step list): **admission (11) →
deadline (05) → dedup (09) → ce-cap verify → dispatch**. Admission is first because it is the cheapest
"do no work" rejection and the one that protects the rest of the pipeline (including the cap verifier
itself) from a flood. (A deduped retry that hits 09's cache still *passes* admission cheaply — a cache
hit costs a fraction of a token — so exactly-once retries are not penalized.)

### 4.2 Cost weighting

`weight(len, kind)` makes a 200 MiB blob push cost more than a 32-byte ping, so admission tracks real
resource pressure, not just request count:

```
cost = base_cost(kind) + ceil(len / COST_UNIT)      // integer; COST_UNIT e.g. 4 KiB
base_cost(AppRequest)=1, base_cost(AppMessage)=1, base_cost(AppPubSubMsg)=1
```

A request larger than `MAX_RPC_BYTES` (`ce-mesh/src/lib.rs:217`) is already rejected by the codec, so
`cost` is bounded; the bucket `burst`/`rate` are sized in these weighted tokens.

### 4.3 Credit-/bond-backed quota curve (the economy tie)

The effective bucket for `(from, ns, ability)` is a deterministic, integer, monotone function of the
sender's economic stake — **the entire DoS-resistance + fair-share argument lives here**:

```
free   = chain.free_balance(from, ns)         // spendable credits (balance - locks), ce-chain :1844/:1851
bond   = chain.bond_of(from)                  // standing host bond, ce-chain :1886
credits = free / CREDIT                        // whole credits (base-units / 10^18), integer floor

burst   = min(cfg.max_burst,
              cfg.base_burst    + credits * cfg.burst_per_credit)
rate_ms = min(cfg.max_rate_milli,
              cfg.base_rate_milli + credits * cfg.rate_per_credit_milli)

// host bond (skin-in-the-game, primitives.md trust gradient) lifts the ceiling multiplicatively:
if bond > 0 {
    let m = min(cfg.bond_multiplier_bps, 10000 + bond_scaled(bond));   // basis points, ≥1x
    burst   = min(cfg.max_burst,    burst   * m / 10000);
    rate_ms = min(cfg.max_rate_milli, rate_ms * m / 10000);
}
// quota:admin class override (org case) clamps or raises within node max_* (cannot exceed node ceiling):
if let Some(c) = classes.get((ns, class_for(from, ns))) { burst = c.burst.min(max); rate_ms = c.rate_milli.min(max); }
```

Key properties: **(P1) every authenticated sender gets a non-zero free baseline** — honest strangers
are never locked out, so admission is not a trust gate (consistent with `primitives.md`: strangers do
visualized/short work). **(P2) raising your quota costs scarce credits or a slashable bond** — a Sybil
minting fresh keys gets only `base_*` per key, and acquiring 1000× the budget costs 1000× the credits
(mined or bought), so flooding has a real price (DoS resistance = economy). **(P3) the curve is integer,
monotone, capped, and a pure function of on-chain state** — deterministic, no float (`primitives.md`),
and an honest payer is *guaranteed* its proportional share (fair sharing). **(P4) no central
allocator** — each node computes the curve locally from the global chain state it already syncs; there
is no global rate-limit coordinator to bottleneck or partition.

Note: `free_balance` is read as the payer's *current* free credits; this is an **eligibility** signal
(holding credits buys headroom), not a debit — admission does not spend credits. Optional per-request
*spending* is the payment-channel path (§6), for apps that want pay-per-call metering rather than
hold-to-qualify.

### 4.4 Token-bucket algorithm (deterministic core)

```
admit(key, cost, now, free, bond):
    b = buckets.entry(key).or_insert(default_for(free, bond))    // §4.3 curve
    b.refresh_ceiling(free, bond)                                 // re-derive burst/rate (cheap; clamps)
    elapsed = now - b.last_refill_ms
    b.tokens = min(b.burst, b.tokens + elapsed * b.rate_milli / 1000)   // integer refill
    b.last_refill_ms = now
    if b.tokens >= cost { b.tokens -= cost; ADMIT_TOTAL += 1; return Ok }
    needed = cost - b.tokens
    retry_after_ms = ceil(needed * 1000 / b.rate_milli)
    if retry_after_ms <= cfg.max_queue_ms && deadline allows:  hold, recheck on refill (bounded)  // queue
    else: SHED_TOTAL += 1; return Throttled{ retry_after_ms }                                    // shed
```

**Invariants:** (I1) over any window `[t0,t1]`, admitted cost ≤ `burst + rate*(t1-t0)` (bucket bound —
the hard rate cap). (I2) `tokens ∈ [0, burst]` always (never negative, never over-fills). (I3) refill
is integer and monotone in elapsed time (no float drift). (I4) a sender's ceiling is monotone
non-decreasing in its credits/bond (P3 fairness). (I5) `retry_after_ms` is exactly the time until
`cost` tokens are available at the current rate, so 05's backoff is precise.

### 4.5 State layout & bounds

- **Per-node, bounded:** `buckets: HashMap<BucketKey, TokenBucket>`, LRU-capped (e.g. 1M entries) with
  idle eviction (a bucket at full `burst` and untouched for a TTL is dropped — its state is recoverable
  as "full"). So a Sybil spraying distinct `(from)` keys can at worst evict idle buckets, never exhaust
  memory; eviction only *resets a bucket to full*, which is safe (it cannot grant more than `burst`).
- **`classes`:** small `HashMap<(ns,class), QuotaClass>` from `quota:admin` overrides, persisted to the
  node data dir (rare writes).
- **Counters:** per-`(ns,ability)` admit/shed totals for `/admission` + 07.

No chain writes on the hot path: the curve only *reads* `ce-chain` balance/bond, which the node already
holds in memory. Admission adds one map lookup + arithmetic per inbound — O(1), no I/O.

---

## 5. Semantics & failure modes

**Guarantees:**

- **Local rate bound (hard).** Each node enforces I1 per `(from, ns, ability)`: a sender cannot exceed
  `burst + rate·t` weighted cost at that node, full stop, regardless of app. This is the only *hard*
  guarantee, and it is exactly the DoS/fair-share bound the platform needs.
- **Fairness within a node.** Two tenants sharing a host have independent buckets, so one cannot starve
  the other (contract §6 isolation). A payer's higher curve is a guaranteed proportional share (P3).
- **Backpressure signal.** A throttled call always returns `ResourceExhausted` + a precise
  `retry_after_ms` (I5), so 05's breaker/backoff is deterministic and a retry storm is self-limiting.
- **Economy-tied DoS price.** Raising quota costs scarce credits or a slashable bond (P2): the cost of
  flooding scales linearly with the credits required, which is the built-in DoS resistance.

**Partition / crash behavior:**

- **Node restart loses buckets** (in-memory, like 09's dedup and the `AppInbox`). On restart every
  bucket resets to *full* — the conservative direction (a brief grace, never an over-throttle). The
  credit/bond curve is recomputed from the synced chain, so quota height survives a restart even though
  instantaneous token counts do not.
- **Chain lag / light node.** If the node's chain view lags (or it is a light node that has pruned old
  blocks), `free_balance`/`bond_of` may be slightly stale; the curve degrades gracefully to a *lower*
  ceiling (a payer whose recent top-up hasn't synced gets baseline until it does) — fail-safe, never
  fail-open. A node with no chain at all falls back to `base_*` for everyone (still DoS-safe).
- **Partition.** Each side keeps enforcing its local buckets from its local chain view; there is no
  cross-node coordination to lose. The optional `fleet_quota` aggregate (§3.3) is best-effort and
  read-only — it never gates admission, so a partition cannot break enforcement.

**What it does NOT guarantee:**

- **Not a global rate limit.** 11 bounds load *per receiving node*, not a tenant's total mesh-wide
  rate. A sender hitting 50 hosts gets `50 × burst` aggregate; `fleet_quota` *observes* this but does
  not cap it (a global coordinator would be a bottleneck/SPOF, against `primitives.md`). Global caps are
  an app concern layered on top (e.g. a metering service over payment channels, §6).
- **Not fairness across nodes.** Two tenants on *different* hosts are isolated trivially; cross-host
  weighted fairness is not a node guarantee.
- **Not a debit.** Holding credits raises quota but does not spend them; the spend-per-call path is the
  optional channel metering (§6), not the default.
- **Not exactly-once or ordered** — those are 09/03/04. Admission is orthogonal: it decides *whether*,
  not *whether-twice* or *in-what-order*.

---

## 6. Security & economy

- **ce-cap.** `quota:admin` (contract §3) on `Tag("ns:<tenant>")` / `Tag("quota:<class>")` gates the
  *administrative* override (the org case). Rate limits themselves are **not cap-gated** (contract §3
  row-11 note): the gate authorizes nothing — it admits or sheds based on the verified `from` + the
  economy. So there is no capability to steal that grants unlimited throughput; the only lever is the
  ledger. The verifier never learns "quota" or "tenant" — opaque strings only (`primitives.md`).
- **DoS bounds (the core argument).** Four layers, each from existing primitives: (1) `MAX_RPC_BYTES`
  caps one message (`ce-mesh:217`); (2) the **free baseline** (P1) is small enough that a Sybil swarm
  of fresh keys at baseline cannot overwhelm a host (each key gets `base_*`, the host's total intake is
  bounded by its inbound capacity, and a flood beyond that is shed cheaply with one map lookup before
  any work); (3) **raising quota costs scarce credits** (P2) — to get N× throughput an attacker must
  hold N× credits, which are mined (slow) or bought (real cost), so a sustained flood is economically
  bounded; (4) a **bond** adds slashable skin-in-the-game (`HostBond`/`Slash`, `ce-chain`), so an
  abuser with a high bond-lifted quota risks losing the bond. The result is `primitives.md`'s thesis
  made mechanical: **the economy is the DoS defense and the fair-sharing mechanism at once.**
- **Sybil specifics.** Minting keys is free, but each key starts as a stranger with only `base_*`
  (P1) — buying real throughput requires accumulating credits on *some* key, which the chain records
  globally. There is no per-key bypass of the curve. This is the same Sybil posture as the trust
  gradient (`primitives.md`): cheap identities, but the *capability that matters* (here, high
  throughput) costs the scarce resource.
- **Optional payment-channel metering (pay-per-call).** Beyond hold-to-qualify, an app can meter
  admission *per request* over a payment channel: the caller carries a rising `cumulative` receipt
  (exactly as paid chunk fetch / `pay_relay` do — `ce-rs/src/lib.rs:391,519`,
  `channel_open`/`sign_receipt` :543/:551), and the host's admission grants `cost` tokens *and* debits
  the channel per admitted request. This converts quota from a coarse credit-balance signal into
  fine-grained pay-as-you-go throughput — the natural extension of the §4.3 curve for high-value
  callers, fully reusing the existing channel surface. Default v0: hold-to-qualify (free baseline +
  credit-curve), metering is opt-in per app.

---

## 7. Composition

**Depends on** (in-edges, contract §5):

- `00`/**`Ctx` envelope** — admission keys on `Ctx{ ns, cap }` + the node-verified `from`, and reads
  `Ctx.deadline_ms` to choose shed-vs-queue. The keystone; ships first.
- **The economy** (`ce-chain` `balance`/`locked_balance`/`bond_of`, payment channels) — pre-existing
  node primitive, the source of the quota curve. Not a scale primitive (no `NN-…md`).
- **`05-resilient-rpc.md`** — bidirectional: 11 produces `ResourceExhausted` + `retry_after_ms` that
  drive 05's circuit breaker and backoff; 05's retries/hedges are admitted/throttled by 11, so a retry
  storm is capped at the receiver (the trade the contract §5 graph draws as `backpressure ⇄ 11`).

**Enables / is depended on by:**

- **`03-durable-queue.md`** — per-producer admission (`queue:produce` ability key) so one app cannot
  sink a shared queue; the queue's flow control *is* 11 at the broker node.
- **`04-event-log-stream.md`** — append-rate admission (`log:append`) bounds a runaway writer.
- **`07-telemetry-metrics-health.md`** — 11 exports admit/shed counts + bucket fill per `(ns,ability)`
  as SLIs (the `/admission` route), which 07 aggregates into `atlas`; a high shed rate is a load signal.
- **`02-load-balancing-placement.md`** — a host returning `ResourceExhausted` is a "too busy" signal;
  02 routes new work to less-throttled hosts (reads 07's shed rate).
- **`01-service-registry-binding.md`** — a persistently-throttling instance degrades its health signal.
- Every durable primitive (03/04/08/10/12) inherits per-tenant admission for free, because all their
  traffic rides the `request`/`publish` paths the gate sits on.

---

## 8. Test plan

**Deterministic unit cores (no mesh):**

- `TokenBucket`/`Admission::admit` — property tests: I1 (admitted cost over a window ≤ `burst+rate·t`
  for any interleaving of `admit` calls with a simulated clock), I2 (`tokens ∈ [0,burst]` invariant),
  I3 (integer refill, no drift over a long simulated run), I5 (`retry_after_ms` exactly predicts when
  the next `cost` admits). Mirrors the deterministic-core style of `ce-coord`/09 tests.
- Quota curve (§4.3) — table tests: baseline for 0 credits = `base_*`; monotone non-decreasing in
  credits (I4); capped at `max_*`; bond multiplier applied in bps; `quota:admin` class clamps within
  node max. All integer, asserted exact (no float).
- Cost weighting (§4.2) — a 200 MiB push costs the expected weighted tokens; a 32-byte ping costs 1+ε.
- Shed-vs-queue decision honors `Ctx.deadline_ms` and `max_queue_ms`.
- Bucket map eviction: a flood of distinct `from` keys evicts idle (full) buckets, bounded memory, and
  an evicted bucket re-creates as full (never grants > `burst`).

**Integration (single process, mock node):**

- A burst of N inbound `AppRequest` from one `(from, ns, ability)` past `burst`: the first `burst`
  admit, the rest return `Status::ResourceExhausted` with a `retry_after_ms` that, when honored, admits
  the next — and crucially the gate runs **before** the mock handler is invoked (assert handler call
  count == admitted count).
- Two tenants (`ns=a` vs `ns=b`) from the same `from`: independent buckets, one's flood does not throttle
  the other (contract §6 isolation).
- Economy tie: with a mocked chain returning `free=0` the sender gets baseline; topping the mock balance
  to K credits raises the effective burst per the curve; a bond lifts the ceiling.
- Backpressure handshake with 05: a throttled reply trips a `CircuitBreaker` and the backoff equals
  `retry_after_ms` (cross-test with 05's deterministic core).

**Needs a live multi-node mesh:**

- One node sprays `request`/`publish` at a shared host running two honest apps; assert the honest apps
  keep serving (their `AppInbox` is not starved) while the firehose is shed — the "one app cannot sink
  the mesh" guarantee, end to end.
- A Sybil swarm (M fresh NodeIds at baseline) vs one funded payer: the payer's proportional share holds
  (P3) and the swarm is bounded to baseline (P2).
- Retry-storm test: a slow host returns `ResourceExhausted`; 05 callers back off per `retry_after_ms`
  and the host's load plateaus instead of amplifying.
- Restart test: kill the host mid-flood, restart; buckets reset to full (brief grace), quota height
  recomputed from the synced chain, enforcement resumes — documents the in-memory-bucket limit.
- Channel-metered admission (§6): pay-per-call over a channel admits and debits per request; an empty
  channel sheds.

---

## 9. Worked example — protecting a sharded game backend host shared with ce-db

A multiplayer game (work item #5: distributed Rust/WASM mesh backends) runs one authoritative shard
cell per sector on a host that *also* runs a `ce-db` replica and a `ce-query` worker — three apps, one
node, one shared `AppInbox`. 11 is what keeps all three alive under load:

1. **A buggy client cannot sink the host.** A modded game client on some node spams the shard with
   `request(shard, "cast", …)` at 10k/s. The shard host's admission gate keys each on
   `(modded_node, "ce-game/sector7", "rpc:call")`; that sender's bucket holds only its baseline + its
   small credit-derived headroom, so after `burst` the flood is shed with `ResourceExhausted` **before
   the shard handler — or the `ce-db`/`ce-query` handlers sharing the inbox — ever runs**. The honest
   players' moves and the co-located `ce-db` traffic keep flowing: one app cannot starve the others
   (contract §6 isolation), which is precisely the at-scale failure 11 exists to stop.

2. **Paying buys guaranteed throughput (fair sharing).** A tournament organizer running a high-traffic
   sector pre-funds the host (`ce.transfer(host, 500 credits)`); the §4.3 curve raises that sender's
   burst/rate proportionally, so its legitimate high tick-rate is *guaranteed* admission while a free
   Sybil swarm is bounded to baseline. The same mechanism is DoS resistance and fair sharing — the
   `primitives.md` economy thesis, mechanical.

3. **Backpressure, not collapse, under a spike.** When a popular event spikes load past the host's
   capacity, admission sheds the marginal traffic with a precise `retry_after_ms`; the game's gateway
   (using 05's `ResilientClient`) backs off exactly that long and its breaker fail-fasts the saturated
   sector, so the spike degrades gracefully (some ticks dropped) instead of taking the host — and
   `ce-db` — down. 02 reads the host's rising shed rate (via 07's `/admission` export) and routes new
   matches to a less-loaded host.

4. **High-value calls meter per-tick (optional).** A paid ranked match opens a payment channel to the
   shard host (`channel_open`) and signs a rising receipt per tick (§6); admission grants tokens *and*
   debits the channel per admitted tick — pay-as-you-go throughput that survives even a credit-balance
   that would otherwise only buy baseline. The game writes none of the bucket math; it just funds, and
   the node enforces.

Every cross-app hop in this story (game → ce-db validate → ce-query) rides the same `Ctx{ ns, cap }`
the call already carries, so admission, tracing (06), and exactly-once (09) all compose on one envelope.

---

## 10. Effort & minimal first slice

**Effort: M.** The node gate is small — one `Admission` struct (token bucket + curve), one call on the
existing inbound path, two read-only routes — and the economy lookup reuses `ce-chain` accessors the
node already has in memory. The genuinely new bits (cost weighting, the credit curve, shed-vs-queue) are
all deterministic integer cores that unit-test without a mesh. Channel-metered admission and the
`fleet_quota` aggregate are deferrable. It is gated only on the `Ctx` keystone; it trades backpressure
signals with 05 but does not block on it.

**Minimal first slice (ships behind the `Ctx` keystone, before 05):**

1. `Admission { admit }` in `ce-node` with the §4.4 token bucket + §4.2 cost weighting + §4.3 credit/bond
   curve (integer, deterministic), keyed `(from, ns, ability)`, plus the §8 deterministic-core tests
   (I1–I5 + curve monotonicity).
2. Wire the gate as the **first** step on the inbound `AppRequest`/`AppMessage`/`AppPubSubMsg` path
   (before `IncomingRpc`/`AppInbox`), returning `Status::ResourceExhausted { retry_after_ms }` on shed.
3. The `GET /admission` + `GET /admission/quota/:ns` read-only routes and `CeClient::{quota,
   admission_stats}` in `ce-rs`; the existing `transfer`/`bond` already raise quota (no new money path).
4. One live multi-node test: one sender floods a shared host, a co-located honest app keeps serving.

Deferred: `quota:admin` class overrides + `POST /admission/quota`, payment-channel-metered admission
(§6), the `ce-coord` `Pacer`/`fleet_quota`, and bucket durability across restart. This slice already
delivers the core guarantee — one app cannot sink the mesh, and paying credits buys a fair, DoS-priced
share — and gives 05 the backpressure signal its breaker needs.
