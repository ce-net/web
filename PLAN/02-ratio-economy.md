# Compute Share-Ratio & Reputation: a ledger-derived, SDK-computed contribution signal

> Workstream: `ratio` · Suggested target path: `ce/docs/ratio.md`
> Depends on: economy

**Summary:** CE already records every settlement leg on-chain via NodeStats (earned net-of-burn as host, spent gross as cell) and exposes it at GET /history/:node_id, with capacity at GET /atlas and a height clock at GET /beacon. A torrent-style share ratio is therefore a pure SDK/app feature: ce-ratio (a new crate over ce-rs) computes ratio = earned / spent from existing surfaces, applies newcomer grace and decay, and gates host selection in the swarm scheduler and atlas ranking — with zero node or consensus changes for v1. Wash-trading is already capital-costly because the mandatory 1% settlement burn destroys real credits per cycle, so anti-cheat leans on the burn plus a stranger/counterparty heuristic rather than new on-chain state. The single justified node change is a deferred, optional v2: a 30-day time-windowed history snapshot, because /history is cumulative-only and true time decay cannot be reconstructed by the SDK. v1 approximates decay with a height-rate proxy and ships first.

---

# Compute Share-Ratio & Reputation (`ratio`)

> Torrent-style "share ratio" for CE compute: `ratio = compute-contributed-as-host / compute-consumed-as-cell`. A **derived, displayed signal** computed by the SDK from existing on-chain history — *not* a new trust root. Capabilities remain CE's only authorization primitive; ratio only **biases priority, price, and verification intensity**.

## 1. Goals / Non-goals

### Goals
1. Define one number, `share_ratio`, computed deterministically from **existing** ledger facts (`/history`), in base-unit integer math, never floats on the wire.
2. Ship **v1 with zero node and zero consensus changes** — pure `ce-rs` SDK + a new `ce-ratio` crate + `swarm` scheduler integration + a `ce ratio` CLI surfaced through the app tier.
3. Gate three things, softly: (a) **atlas/host ranking** (prefer high-ratio hosts when *I* pick a host; prefer high-ratio requesters when *I* am a host deciding whose bids to accept), (b) **price/priority tiers**, (c) **bounded freeleech for genuine newcomers**.
4. Make cheating **provably capital-costly**, leaning on the already-shipped 1% settlement burn; add a stranger/counterparty heuristic on top.
5. Treat newcomers with **bounded, supervised grace**, never unconditional altruism (the BitTyrant lesson).
6. Isolate the *one* thing that genuinely needs an on-chain change (time-windowed history) into a deferred, optional v2 with a clearly justified consensus-free implementation.

### Non-goals
- **Not** a new authorization mechanism. Ratio never grants a capability; it only orders/prices choices the caller was already allowed to make. A host with ratio 100 still cannot exec on you without a `ce-cap` chain.
- **Not** a new consensus weight. Consensus weight is already `W = min(active_bond, earned_work_score)` in `ce-chain`; ratio does not touch fork choice.
- **Not** a global authoritative score. Like `/history`, ratio is computed by each app from public facts; different apps may weight it differently.
- **No new node HTTP endpoints in v1.** Everything composes `/history`, `/atlas`, `/beacon`, `/status` that already exist.

## 2. Architecture & CE-boundary statement

**What changes in the node (CE primitives): NOTHING in v1.** Ratio is computed entirely in the SDK/app tier from data the node already serves:
- `GET /history/:node_id` → `NodeHistory { jobs_hosted, jobs_paid, heartbeats_hosted, heartbeats_paid, expiries, earned, spent, first_height, last_height }` (verified in `ce-rs/src/lib.rs:656` and `ce/crates/ce-node/src/api.rs:1180`).
- `GET /atlas` → `Vec<AtlasEntry { node_id, cpu_cores, mem_mb, running_jobs, last_seen_secs, tags }>` (`ce-rs/src/lib.rs:525`).
- `GET /beacon` → `{ height, hash }` — the height clock for any height-based window (`ce/crates/ce-node/src/api.rs` `get_beacon`).
- `GET /status` → `{ node_id, height, difficulty, balance }`.

This honors the boundary exactly: ratio is policy/UX over immutable facts, so it lives at the SDK/app tier alongside `swarm`/`rdev`/`ce-coord`, not in `ce-node`. No `AppRequest`/stream device-to-device protocol is needed either — ratio reads public chain state from the *local* node's HTTP API; the local node already learns peers' `NodeStats` via chain sync.

**New code layout:**
```
ce-rs/                         (existing SDK — minor additive change)
  src/lib.rs                   add NodeHistory::share_ratio(), ::is_stranger(), RatioInputs
ce-ratio/                      (NEW crate, depends on ce-rs)  github.com/ce-net/ce-ratio
  src/lib.rs                   ShareRatio, RatioConfig, classify(), rank_hosts(), freeleech_grant()
  src/decay.rs                 height-rate decay proxy (v1) + windowed decay (v2 path)
  src/cli.rs                   `ce-ratio` binary: ratio / rank / explain subcommands
swarm/                         (existing app — integration)
  src/scheduler.rs             bias host selection by ratio (compose ce-ratio::rank_hosts)
ce/docs/ratio.md               (NEW doc) the spec, mirroring this design
```
`ce-ratio` is a separate crate (not folded into `ce-rs`) because it carries *policy* (thresholds, decay, freeleech) that the thin reqwest/serde SDK must stay free of — same separation rationale as `swarm` vs `ce-rs`.

## 3. Data model & exact formula

### 3.1 The base ratio (v1, cumulative)
All math in **base units (`u128`)**, the wire form being decimal strings (`Amount`). Define for a node `n` with history `h = NodeHistory`:

- **contributed** `C(n) = h.earned` — credits earned *as host* (settlements + heartbeats + channel closes received), already **net of the 1% burn**.
- **consumed** `S(n) = h.spent` — credits spent *as cell* (gross, pre-burn).

```
raw_ratio(n) = C(n) / S(n)            // rational; computed as a (num, den) pair, never f64 on the wire
```

**Burn asymmetry, stated explicitly.** Because `earned` is post-burn and `spent` is gross, a perfectly balanced honest node that hosts exactly what it consumes lands at `ratio ≈ 0.99`, not 1.00 (it lost 1% to burn as the *cell* side, and earned 1% less as the *host* side of others' work). The threshold model (§5) accounts for this: the "balanced" floor is **0.95**, not 1.00, so honest balanced participants are never penalized by the burn they paid.

**Display.** The SDK exposes a `Ratio` value with an exact rational plus a rounded `f64` *for display only*:
```rust
pub struct Ratio { pub contributed: u128, pub consumed: u128 }  // exact
impl Ratio { pub fn as_f64(&self) -> f64; pub fn cmp_threshold(&self, num: u128, den: u128) -> Ordering; }
```
`cmp_threshold` compares `contributed/consumed` against `num/den` via `contributed*den vs consumed*num` in `u128` (saturating to `u256` via two-limb mul where needed) — no float comparison decides gating.

### 3.2 Newcomer grace
A node is a **stranger** iff `h.first_height == 0` (already `NodeHistory::is_newcomer()` in `ce-rs/src/lib.rs:673`). Strangers and near-strangers get bounded freeleech instead of a ratio:
```
classify(h, beacon_height, cfg):
  if h.first_height == 0                                  -> Newcomer        // never interacted
  age_blocks = beacon_height.saturating_sub(h.first_height)
  if age_blocks < cfg.vetting_blocks (default 8640 ≈ 24h)
     && h.spent < cfg.freeleech_cap (default 5 credits)   -> Probation       // bounded freeleech
  else                                                     -> Rated(ratio)    // normal ratio applies
```
- **Freeleech is bounded two ways** (BitTyrant lesson — never unbounded): a credit cap (`freeleech_cap`) *and* a time cap (`vetting_blocks`). Once either is exceeded the node is `Rated` and must carry its weight.
- During `Probation` the scheduler gives a **capped priority boost and trickle of low-value work** (Storj vetting), not full access to scarce hosts.

### 3.3 Time decay (v1 proxy; v2 exact)
`/history` is **cumulative-only** (confirmed: `NodeStats` has no rolling window). True decay (recent contribution worth more than year-old contribution) cannot be reconstructed by the SDK. v1 ships a **height-rate proxy**; v2 (deferred, §7) adds an exact window.

**v1 height-rate proxy** — reward *recent activity* without windows:
```
activity = (h.last_height >= beacon_height - cfg.active_blocks)   // active recently?
recency_factor = if active { 1.0 } else { decay over (beacon_height - h.last_height) }
effective_ratio = raw_ratio * recency_factor                       // display + soft-gating only
```
`recency_factor` is a piecewise multiplier applied **only to the displayed/soft-gating score**, never to the exact rational used for hard threshold comparisons (those use raw cumulative `C/S`, which is what the chain actually attests). This keeps decay honest: it can *de-prioritize* a dormant high-ratio node but can never *fabricate* contribution.

## 4. API / CLI / SDK surface (typed, concrete)

### 4.1 `ce-rs` additions (additive, no breaking change)
```rust
impl NodeHistory {
    /// Exact rational share ratio = earned(as host) / spent(as cell).
    /// `None` when consumed == 0 (no denominator) — caller treats as "infinite contributor".
    pub fn share_ratio(&self) -> Option<Ratio>;
    /// A node that has never been a counterparty (first_height == 0). Alias kept for clarity.
    pub fn is_stranger(&self) -> bool { self.is_newcomer() }
}
pub struct Ratio { pub contributed: u128, pub consumed: u128 }
impl Ratio {
    pub fn as_f64(&self) -> f64;                          // display only
    pub fn at_least(&self, num: u128, den: u128) -> bool; // contributed*den >= consumed*num, u128-safe
}
```

### 4.2 `ce-ratio` crate (policy)
```rust
pub struct RatioConfig {
    pub balanced_floor_num: u128, pub balanced_floor_den: u128, // default 95/100 (burn-aware)
    pub vetting_blocks: u64,        // default 8_640
    pub freeleech_cap: Amount,      // default 5 credits
    pub active_blocks: u64,         // default 8_640 (recency window for v1 proxy)
}
pub enum Tier { Newcomer, Probation, Leech, Balanced, Contributor } // Leech: <floor; Contributor: >=2.0
pub fn classify(h: &NodeHistory, beacon_height: u64, cfg: &RatioConfig) -> Tier;
/// Rank candidate hosts (from atlas) for placement: I am the requester, prefer hosts that
/// are also good contributors AND have free capacity. Returns indices best-first.
pub fn rank_hosts(atlas: &[AtlasEntry], hist: &HashMap<String, NodeHistory>,
                  beacon_height: u64, cfg: &RatioConfig) -> Vec<usize>;
/// Host-side: should I (a host) accept this requester's bid, and at what price multiplier?
/// Returns (accept, price_multiplier_bps). Leech requesters: accept=true but higher price.
pub fn admit_requester(h: &NodeHistory, beacon_height: u64, cfg: &RatioConfig) -> (bool, u32);
/// Newcomer freeleech budget remaining, in base units (0 once vetting exhausted).
pub fn freeleech_remaining(h: &NodeHistory, cfg: &RatioConfig) -> Amount;
```

### 4.3 CLI (`ce-ratio` binary — app tier, not a `ce` subcommand in v1)
```
ce-ratio ratio <node_id>            # prints: tier, ratio (x.xx), contributed/consumed, age, recency
ce-ratio ratio --self               # my own ratio (resolve self node_id via /status)
ce-ratio rank --tag gpu             # rank atlas hosts I'd pick, best ratio + capacity first
ce-ratio explain <node_id>          # full breakdown: why this tier, freeleech left, burn-asymmetry note
```
Example `ce-ratio ratio <id>` output (honoring `docs/design.md` terminal rules — plain, aligned, no emoji):
```
node      a1b2…0c0  (Contributor)
ratio     2.14      contributed 642.18  consumed 300.04 cr
age       14213 blk  last seen 41 blk ago  (active)
note      balanced floor is 0.95 (accounts for 1% settlement burn)
```

### 4.4 UI
Surface `share_ratio` and `Tier` in the existing `ce-net.com/network` mesh dashboard next to each node's capacity (it already pulls `/atlas`; add a `/history` fetch per node and render the ratio badge). No new backend.

## 5. How ratio gates things (soft, opinionated)

| Tier | ratio (vs 0.95 floor) | Scheduling (as requester picking hosts) | As host admitting a requester's bid |
|---|---|---|---|
| Newcomer | n/a | trickle of low-value work, capped priority | accept up to `freeleech_cap`, T1 redundancy/verification |
| Probation | n/a (bounded freeleech) | same, until vetting_blocks/cap exhausted | accept, elevated verification (audit dial up) |
| Leech | `< 0.95` | de-prioritized, not blocked | accept at **1.25–2.0× price multiplier** (pay-to-play tax) |
| Balanced | `0.95 – 2.0` | normal priority | accept at 1.0× |
| Contributor | `>= 2.0` | **priority access to scarce hosts**, freeleech-on-launch perks | accept at 1.0×, may waive deposit |

Key principles, drawn from the research:
- **Soft preference before any cliff** (Storj): Leeches are *re-priced and de-prioritized*, never hard-blocked. The only hard gate in the system remains the capability chain.
- **Contributors unlock concurrency/priority** (Render two-sided reputation), not a yes/no.
- **Two-sided**: requesters earn standing too (`jobs_paid`/`heartbeats_paid` make them visible as good-faith consumers; a requester who only ever leeches and lets bids expire — high `expiries` — is throttled).
- **Hit-and-run strike (per-object obligation):** `h.expiries` is the on-chain HnR signal (bids let expire after consuming a host's setup). `admit_requester` multiplies price by `1 + expiries_rate` so grab-and-go requesters pay more. This is computable today from `/history` with zero node change.

## 6. Anti-cheat — lean on the burn, then layer

1. **Wash-trading is already capital-costly (primary defense, shipped).** The mandatory 1% `SETTLEMENT_BURN_BPS` destroys real credits on every `JobSettle`/`Heartbeat`/`ChannelClose`. To pump `earned` by `X` credits an attacker burns ≈ `0.01·X` per cycle of real, mined capital. Ratio inherits this for free — there is no cheaper-than-honest way to inflate `contributed`.
2. **Burn-asymmetry makes pure self-dealing visibly lossy.** Two attacker identities trading only with each other converge to a *combined* ratio below 1.0 (both pay the burn), so a self-dealing ring can buy *one* node a high ratio only by sinking another below the floor — net zero standing across the ring, minus burned capital.
3. **Stranger/counterparty heuristic (v1, computable today, partial).** `/history` is aggregate (no per-pair breakdown), so the SDK cannot fully detect pairwise wash-trading. v1 ships the cheap signal it *can*: a node whose entire `earned` accrued in a short height span with `jobs_hosted` small relative to `earned` (few large settlements) is flagged `low-diversity` and capped at `Balanced` tier regardless of ratio. This is a heuristic, not proof.
4. **Verification dial coupling (deferred to verification workstream).** True audit-or-slash for the "served" leg belongs to the sybil-resistance/verification dial, not ratio. Ratio *consumes* its output: a node with `slashes > 0` (already in `NodeStats`, addable to `/history`) is forced to `Leech` tier. v1 notes the hook; surfacing `slashes` is a one-field additive change to `HistoryResponse` if/when needed.

## 7. The ONE justified node change (deferred v2, consensus-free)

**Problem:** `/history` is cumulative for all time. True torrent-style time decay ("ratio over the last 30 days") is **impossible to compute in the SDK** — the data isn't there. The v1 height-rate proxy (§3.3) only knows *last activity*, not *recent volume*.

**v2 fix — windowed NodeStats snapshot, observational only, NOT consensus:**
- Add a ring of per-window aggregates to `ce-chain`'s in-memory cache (like `burned_total_cache` — rebuilt from blocks, never part of fork choice): `recent_earned`, `recent_spent` over the last `WINDOW_BLOCKS` (e.g. 30 days ≈ 259_200 blocks).
- Expose additively on the **existing** `/history/:node_id`: two new fields `recent_earned`, `recent_spent` (base-unit strings). No new endpoint.
- **Why this is allowed under the boundary:** it is a *read-model* derived from blocks the node already has, identical in kind to `burned_total_cache` and `total_supply_cache` which are already observational caches. It does not change validation, fork choice, tx semantics, or any signed bytes. It is a node *query* enhancement, not a primitive change and not a consensus change. Justified because the data genuinely cannot be reconstructed downstream.
- **Ship v1 first; v2 only if real decay proves necessary.** The proxy may be good enough.

No other consensus change is warranted. Per-cluster caps, verification tiers, and conditional capability auto-grants stay out of this workstream (they belong to sybil-resistance / verification-dial work).

## 8. Milestones

See structured `milestones`. Summary: SDK math (S) → ce-ratio crate + CLI (M) → swarm scheduler integration (M) → dashboard badge (S) → docs (S) → v2 windowed history (L, deferred & gated on need).

## 9. Testing strategy

- **Unit (ce-rs):** `share_ratio` exactness — feed `NodeHistory` with known `earned/spent`, assert `at_least(num,den)` matches integer cross-multiplication; assert `consumed==0 -> None`; assert burn-asymmetry case (host=consume → ratio ≈ 0.99) classifies `Balanced` not `Leech`.
- **Unit (ce-ratio):** `classify` boundary tests at `first_height==0`, at `vetting_blocks ± 1`, at `freeleech_cap ± 1 base unit`; `admit_requester` price multiplier grows with `expiries`; `rank_hosts` orders Contributor > Balanced > Leech and respects free capacity (`running_jobs` vs `cpu_cores`).
- **Property test:** for any honest balanced trace (host == consume per cycle, 1% burn), ratio stays in `[0.95, 1.0]` over N cycles — guards against the burn pushing honest nodes under the floor.
- **Wash-trade simulation:** two-identity self-dealing loop over the burn model → assert combined cross-ring ratio `< 1.0` and per-cycle burned capital grows linearly with faked `earned` (the economic claim is testable in pure arithmetic).
- **Integration (swarm):** spin a local multi-node chain (`NEXT_PORT` atomic, `difficulty=1` per standards), run real `JobBid`→`JobSettle` flows, fetch `/history` via `ce-rs`, assert `rank_hosts` prefers the node that actually hosted more.
- **E2E:** extend `e2e-local.sh` with a ratio assertion after a settlement round; CLI golden-output test for `ce-ratio ratio --self`.
- **v2 only:** windowed-cache rebuild determinism — replay the same blocks twice, assert identical `recent_earned/recent_spent`; assert the field is excluded from any hashed/signed payload (no consensus impact).

## 10. Risks

See structured `risks`.


## Milestones

| Milestone | Deliverable | Effort |
|---|---|---|
| SDK ratio math | ce-rs: NodeHistory::share_ratio() returning exact Ratio{contributed,consumed}, at_least() u128-safe threshold compare, is_stranger(); unit tests incl. burn-asymmetry case | S |
| ce-ratio crate + CLI | New github.com/ce-net/ce-ratio crate: RatioConfig, Tier, classify(), rank_hosts(), admit_requester(), freeleech_remaining(); ce-ratio binary with ratio/rank/explain subcommands honoring docs/design.md terminal rules | M |
| swarm scheduler integration | swarm scheduler biases host selection via ce-ratio::rank_hosts and prices/throttles requesters via admit_requester; Probation trickle + Leech repricing wired through existing /atlas + /history fetches | M |
| Dashboard ratio badge | ce-net.com/network renders Tier + ratio badge per node from /atlas + per-node /history; no backend change | S |
| Docs | ce/docs/ratio.md mirroring this spec; update primitives.md note that ratio is app-tier policy over /history, not a primitive; cross-link sybil-resistance verification dial | S |
| v2 windowed history (deferred, gated on need) | ce-chain observational ring cache (recent_earned/recent_spent over WINDOW_BLOCKS, rebuilt from blocks like burned_total_cache); two additive fields on existing /history; SDK true time-decay; determinism + no-consensus-impact tests | L |


## Risks

- v1 time decay is only a recency proxy (last_height), not real windowed volume — a node that contributed heavily long ago then went idle still shows a high cumulative ratio. Mitigated by recency_factor de-prioritizing dormant nodes for scheduling, and by the deferred v2 windowed history. Accept the proxy for launch.
- Per-pair wash-trading is not fully detectable from cumulative /history (no counterparty breakdown). The burn makes it capital-costly, not impossible; the low-diversity heuristic is partial. If pairwise rings become a real problem, the proper fix is the counterparty ledger (a separate, larger workstream), not ratio.
- Burn-asymmetry threshold (0.95 floor) is a tuned constant; if SETTLEMENT_BURN_BPS ever changes, the floor must move with it. Mitigate by deriving the floor from the burn constant rather than hardcoding 0.95.
- Soft gating can be ignored: ratio only orders/prices choices, so a permissive scheduler or a host that accepts all bids nullifies it. This is by design (capabilities are the only hard gate) but means ratio's effectiveness depends on apps actually consuming it — must be the swarm default, not opt-in.
- Computing ratio requires a /history fetch per candidate host, which can be many round-trips when ranking a large atlas. Mitigate with a short-TTL in-SDK cache keyed by node_id and last_height (history only changes when last_height advances).
- Floats: as_f64 is display-only, but a careless caller could gate on it and hit rounding bugs at the threshold. Enforced by making at_least()/cmp_threshold() the only gating path and as_f64() clearly doc-marked display-only.

## Open questions

- Should freeleech_cap and vetting_blocks be per-app policy (swarm config) or carry a CE-wide recommended default in docs/ratio.md? Leaning: ship defaults in ce-ratio, overridable via RatioConfig.
- Is real windowed decay (v2) actually needed, or is the last_height recency proxy sufficient in practice? Defer the node change until v1 telemetry shows dormant-high-ratio gaming.
- Should slashes be added to /history (HistoryResponse) now as a one-field additive change so ratio can force slashed nodes to Leech, or wait for the verification-dial workstream to own that field?
- Do we want a `ce ratio` first-class subcommand in the `ce` binary eventually, or keep ratio strictly in the app-tier ce-ratio binary to preserve the primitives-only node CLI? Current design keeps it app-tier.
