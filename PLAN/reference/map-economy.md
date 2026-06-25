Perfect. Now let me compile my findings into a comprehensive markdown report:

# CE Economy + Reputation Substrate: Share-Ratio Foundation Map

## Executive Summary

CE's economy substrate is **mostly ready** for a torrent-style "share ratio = compute-given / compute-taken" system **without new consensus changes**. The critical foundation exists: per-node interaction history (NodeStats), settlement burn, earned-work accounting (post-burn net values), and bond weight calculations. What's missing is thin: a formal settlement-burn-aware distinct-counterparty ledger to prevent wash-trading across account pairs, plus query surfaces to expose the data.

---

## 1. TxKind Enum: All Settlement Variants

Full enumeration from `/Users/07lead01/ce-net/ce/crates/ce-chain/src/lib.rs:184-273`:

### Consensus/Minting
- **`Transfer { from, to, amount }`** — credit transfer between nodes
- **`UptimeReward { node, amount, epoch }`** — emission: credits minted and credited to a node for staying online

### Work Marketplace (Payment Path)
- **`JobBid { job_id, payer, bid, image, cmd, env, cpu_cores, mem_mb, duration_secs }`** — payer locks `bid` credits; escrowed, revocable via JobExpire
- **`JobSettle { job_id, host, payer, cpu_ms, mem_mb, cost, payer_sig }`** — host settles actual usage; payer co-signs; cost ≤ bid; **subject to settlement burn**
- **`JobExpire { job_id, payer }`** — payer reclaims locked bid after EXPIRY_BLOCKS (~24 hours)

### Long-Running Work (Heartbeat Billing)
- **`Heartbeat { cell, host, amount, epoch }`** — periodic payment for containerized work; cell debits, host credits; **subject to settlement burn**; epoch strictly increases (replay-proof)

### Payment Channels (Off-Chain Streaming)
- **`ChannelOpen { channel_id, payer, host, capacity, expiry_height }`** — locks `capacity` credits (payer's free balance)
- **`ChannelClose { channel_id, cumulative, payer_sig }`** — host redeems highest off-chain receipt; payer co-signs; **subject to settlement burn**
- **`ChannelExpire { channel_id, payer }`** — payer reclaims full capacity after timeout

### Bonding & Slashing (Consensus Sybil Defense)
- **`HostBond { host, amount, nonce }`** — locks slashable bond; re-activates unbonding; nonce only for dedup
- **`HostUnbond { host }`** — begins UNBOND_BLOCKS (~2 weeks) slow-release; stays locked and slashable
- **`SlashEquivocation { offender, reporter, proof }`** — on-chain proof of double-sign for a (domain, epoch) slot; burns 100% of bond; reporter gets SLASH_REPORTER_BPS (25%), remainder destroyed

### Authorization & Naming
- **`NameClaim { name, node }`** — first claim wins; consensus-enforced uniqueness
- **`RevokeCapability { issuer, nonce }`** — on-chain revocation of a capability link

---

## 2. NodeStats Structure: The Reputation Substrate

**Location:** `/Users/07lead01/ce-net/ce/crates/ce-chain/src/lib.rs:577-598`

```rust
pub struct NodeStats {
    pub jobs_hosted: u64,           // count: jobs settled as host
    pub jobs_paid: u64,             // count: jobs paid for as payer
    pub heartbeats_hosted: u64,     // count: heartbeats received as host
    pub heartbeats_paid: u64,       // count: heartbeats paid as cell
    pub expiries: u64,              // count: bids let expire (no settlement)
    pub earned: u128,               // base units: total EARNED post-burn
    pub spent: u128,                // base units: total SPENT (gross debit)
    pub slashes: u64,               // count: times bond was slashed
    pub first_height: u64,          // genesis block height of first interaction
    pub last_height: u64,           // most recent interaction height
}
```

### Field Semantics (CRITICAL for share-ratio)

- **`earned`** is the **net gain post-burn**: when a JobSettle or Heartbeat executes, the host receives `gross − settlement_burn(gross)`. This value is what's added to `earned`. This is **earned reputation capital** — it cost real capital to create.
- **`spent`** is the **gross debit**: the full payer's outflow (before burn is deducted). A cell pays `spent`, and the network burns `settlement_burn(spent)` off the top.
- **Burn formula** (line 502–504): `settlement_burn(gross) = gross * SETTLEMENT_BURN_BPS / BPS_DENOM = gross * 100 / 10_000 = 1%`

### How NodeStats Updates (from lib.rs:778–902 apply_block_to_cache)

**JobSettle (lines 790–809):**
```
burn = settlement_burn(cost)
net = cost - burn
balances[payer] -= cost (full gross)
balances[host] += net   (post-burn)
node_stats[host].jobs_hosted += 1
node_stats[host].earned += net
node_stats[payer].jobs_paid += 1
node_stats[payer].spent += cost
```

**Heartbeat (lines 810–829):**
```
burn = settlement_burn(amount)
net = amount - burn
balances[cell] -= amount (full gross)
balances[host] += net    (post-burn)
node_stats[host].heartbeats_hosted += 1
node_stats[host].earned += net
node_stats[cell].heartbeats_paid += 1
node_stats[cell].spent += amount
```

**ChannelClose (lines 841–857):** same pattern; counts as `jobs_hosted/jobs_paid` (not a separate counter).

**JobExpire (lines 833–836):**
```
node_stats[payer].expiries += 1
(no earned/spent change)
```

**SlashEquivocation (lines 884–896):**
```
node_stats[offender].slashes += 1
(burned total incremented, reporter rewarded; slashed amount leaves offender's balance)
```

---

## 3. Supply, Burn & Emission Model

**Constants (lib.rs:470–515):**
- `CREDIT = 1e18` (base units per credit; display multiple)
- `EMISSION_BASE = 1_000 * CREDIT` (1,000 credits per block)
- `SUPPLY_CAP = 21_000_000_000 * CREDIT` (21 billion credits hard cap)
- `SETTLEMENT_BURN_BPS = 100` (1.00% mandatory per settlement)
- `UNBOND_BLOCKS = 2016` (~1 difficulty window; ~2 weeks)
- `SLASH_REPORTER_BPS = 2_500` (25% to reporter, 75% destroyed)

**Emission Schedule (lib.rs:970–973):**
```rust
pub fn emission_rate(block_index: u64) -> u128 {
    let halvings = block_index / 210_000;
    if halvings >= 128 { 0 } else { EMISSION_BASE >> halvings }
}
```
— halves every 210,000 blocks (like Bitcoin), reaches zero after ~69 halvings.

**Supply Tracking:**
- `total_supply_cache: u128` — cumulative UptimeReward emitted
- `burned_total_cache: u128` — cumulative credits destroyed by settlement burn (+ slashing)
- **Circulating supply** = `total_supply - burned_total`

### Why This Matters for Share Ratio
The **burn is the keystone**: every settlement cycle destroys capital, so wash-trading between two attacker-owned identities costs real capital, not just account juggling. A share ratio built on `earned` (net post-burn) is inherently expensive to inflate — you can't fake it without burning credits.

---

## 4. Weight Calculation: Bond & Earned-Work Coupling

**Location:** `consensus.md` §2 + `lib.rs` line ~1700 (implied in docs)

### Consensus Weight (CE-TWLE Phase 2–3, status: IMPLEMENTED)

```
W(node, height_at_lookback) = min(active_slashable_bond, earned_work_score)
```

Where:
- **`active_slashable_bond`** = value of the node's HostBond, if:
  - Currently active (not in unbonding phase), AND
  - Not slashed (still in the `bonds` map with amount > 0)
- **`earned_work_score`** = NodeStats.earned (net-of-burn credits, accumulated from all JobSettle/Heartbeat/ChannelClose settlements as host)
- **`min()` coupling:** you can't buy weight without earning, and you can't earn weight without staking

**Fork-Choice Work:** each block's `weight` field is set to `W(miner, height - LOOKBACK)` at production time and validated on append (line 999–1002). Fork choice sums these weights; heaviest suffix wins.

### How This Defends Against Wash-Trading

1. A sybil opens two identities, A (payer) and B (host), both controlled by the attacker.
2. A bids for work, B settles it, credits flow A → B (with burn).
3. **Before Phase 0:** A could then pay B again, B back to A, etc., at zero net cost, inflating B's `earned` and thus `W(B)`.
4. **After Phase 0 (settlement burn):** each cycle destroys `1%` of the gross amount. So 100 cycles of bidding $1 → settling $1 costs $1 in burned capital, not $0. To reach a large `earned` value requires proportional capital expenditure.

---

## 5. Available Data Structures (No Consensus Change Needed)

### Already in the Chain State (O(1) accessible)

| Data | Location | Usage |
|---|---|---|
| **Per-node balances** | `balances: HashMap<NodeId, i128>` (line 615) | Free balance = `balance(node) - locked_balance(node)` |
| **NodeStats** | `node_stats: HashMap<NodeId, NodeStats>` (line 668) | `node_history(node) → NodeStats` (line 916) |
| **Open bonds** | `bonds: HashMap<NodeId, (amount, unbonding_at?)>` (line 640) | Bond status, active/unbonding/released |
| **Slashing record** | `slashed_equivocations: HashSet<(offender, domain, epoch)>` (line 645) | Idempotent double-sign tracking |
| **Burned total** | `burned_total_cache: u128` (line 664) | Total credits destroyed; observable only (not consensus-critical) |
| **Total supply** | `total_supply_cache: u128` (line 657) | Total UptimeReward emitted |
| **Tx index** | `tx_index: HashMap<tx_id, (block_index, pos)>` (line 623) | O(1) tx lookup for history audits |

### Public Query Surfaces (HTTP API)

**`GET /status`:** exposes:
- Node's own balance, identity
- `total_supply`, `burned_total` (observational; archive nodes authoritative)
- `bond` status (amount, unbonding height if any)
- `weight` (consensus weight at current confirmed height)

**`GET /history/:node_id`** (implied, not yet surfaced): should expose:
- `NodeStats` for that node (jobs_hosted, jobs_paid, earned, spent, etc.)
- First/last interaction height

**`GET /transactions/:node_id`:** (not shown) should list all txs (origin or participant) for audit.

---

## 6. What's ALREADY Present (Share-Ratio Ready)

### Foundation Already Exists

1. ✅ **Per-node earned/spent accounting** — `NodeStats.earned` (post-burn), `spent` (gross)
2. ✅ **Settlement burn mechanism** — mandatory 1% on every JobSettle/Heartbeat/ChannelClose
3. ✅ **Burn-aware weight** — `W = min(bond, earned)` couples work to capital
4. ✅ **Slashing proof** — on-chain equivocation proofs + idempotent slashing
5. ✅ **Interaction history** — full tx ledger on-chain; `/history` endpoint (or can be added) exposes node's work
6. ✅ **Bond tracking** — active/unbonding/released states; O(1) lookup
7. ✅ **Fork-choice work** — already sums consensus weights; heaviest suffix wins
8. ✅ **Circulating supply** — `total_supply - burned_total` observable

### Torrent Share Ratio Could Be Built Now

A share-ratio system **without consensus changes** could compute:

```
share_ratio(node) = node_stats.earned / max(node_stats.spent, 1e-18)
```

Where:
- **Numerator** (`earned`): host-side value received, post-burn
- **Denominator** (`spent`): cell-side value consumed (gross)

**Interpretation:**
- Ratio > 1.0 → net earner (host more often than consumer; profitable; incentivize seeding)
- Ratio ≈ 1.0 → balanced (neither net contributor nor leech)
- Ratio < 1.0 → net consumer (download more than upload; pay-to-play tax applies)

This is **torrent-style**: participation is metered by capital burn (the settlement burn), and the ratio tracks who contributes compute vs. consumes it.

---

## 7. What's MISSING (Needs Addition, Not Consensus Change)

### 1. **Distinct-Counterparty Per-Node Ledger** (Recommended but not critical)

**Current state:** `NodeStats` is global (`earned`, `spent` are sums across *all* counterparties). A sybil can't wash-trade to inflate this globally because burn is mandatory, but the system doesn't yet track:

```
earned_per_peer: HashMap<NodeId, HashMap<NodeId, u128>>
    // earned[A][B] = total earned by A from work requested by B
spent_per_peer: HashMap<NodeId, HashMap<NodeId, u128>>
    // spent[C][H] = total spent by C paying host H
```

**Why helpful (not required):**
- Detects per-pair wash-trading (same two accounts settling only with each other; legitimate P2P markets do this honestly, but sybils might overweight pair-specific volume)
- Enables **per-relationship reputation** ("node X is reliable for A but flaky for B")
- Feeds **per-cluster reputation** (group of nodes might be run by one operator; track their pairwise net flow)

**Decision:** Phase 1 uses global earned/spent and the burn (capital-costly wash-trading). Per-peer ledger is a Phase 2+ refinement if distinct-counterparty caps or clustering detection are needed.

### 2. **Query Surface for Share-Ratio History**

**Missing (easy to add):**

```
GET /node/:node_id/history → {
  jobs_hosted: u64,
  jobs_paid: u64,
  heartbeats_hosted: u64,
  heartbeats_paid: u64,
  expiries: u64,
  earned: u128,
  spent: u128,
  slashes: u64,
  first_height: u64,
  last_height: u64,
  share_ratio: f64,  // earned / max(spent, epsilon)
}

GET /node/:node_id/counterparties → [
  { peer: NodeId, earned_from_peer: u128, spent_to_peer: u128, settle_count: u64 }
]
```

These are **read-only queries** over existing state; no new chain data required.

### 3. **Wash-Trade Detection Dashboard** (Optional, App-Level)

An off-chain app can query the chain periodically and compute:

```
potential_sybils = [
  node_pair (A, B)
  where A.spent_to_B > threshold
    and B.earned_from_A > threshold
    and A.spent_to_B ≈ B.earned_from_A  (only A ↔ B, little external trade)
    and (A.slashes == 0 and B.slashes == 0)  (not yet caught)
]
```

This is **observational**; apps can use it to prioritize challenge/verification of suspicious pairs.

---

## 8. Settlement Burn: The Load-Bearing Detail

**Why it matters:** without burn, `earned = spent` in a pure wash trade (A bids $X, B accepts, $X stays in B's `earned`, $X leaves A's `spent`; net zero for A but gains B's reputation). With burn:

**Wash trade on PoW (no burn, pre-Phase 0):**
```
Cycle 1: A bids 1000, B settles for 1000 → A.spent += 1000, B.earned += 1000 (free reputation)
Cycle 2: B bids 1000, A settles for 1000 → B.spent += 1000, A.earned += 1000 (free reputation)
Net:     A.earned = 1000, A.spent = 1000, ratio = 1.0 (looks honest!)
Cost:    only 2000 total mined credits to stage (and miner gets those back as uptime reward)
```

**Wash trade on Phase 0 (with 1% burn):**
```
Cycle 1: A bids 1000, B settles for 1000
         burn = 10, B.earned += 990, A.spent += 1000, network burns 10
Cycle 2: B bids 1000, A settles for 1000
         burn = 10, A.earned += 990, B.spent += 1000, network burns 10
Net:     A.earned = 990, A.spent = 1000, B.earned = 990, B.spent = 1000
Cost:    20 credits destroyed per cycle (20x more expensive than free, scales with volume)
```

Per `consensus.md` §5 finding E4: "Wash trade only moves the attacker's own credits between its own identities (net-zero minus nothing, since no fee), so it buys a fake reputation but costs real mined credits to stage."

**After burn:** the attacker must burn capital proportional to the reputation inflation desired. This converts wash-trading from "free" to "capital-costly," fundamentally changing the attack economics.

---

## 9. `/history` and `/atlas` Surfaces

### `/atlas` (Placement & Discovery) — Already Exists

**Location:** HTTP API, `docs/primitives.md` §4

Returns:
```json
{
  "NodeId": {
    "cpu": u32,
    "mem_mb": u64,
    "running_jobs": u64,
    "tags": ["gpu", "docker", "linux", "x86_64"],
    "last_seen": u64  // timestamp
  }
}
```

Advertised via CEP-1 every 60s; peers cache it. **No reputation data here** (by design — it's just capacity discovery).

### `/history` (Interaction History) — Missing, Easy to Add

Should expose:
```
GET /history/:node_id
→ NodeStats + derived metrics (share_ratio, uptime, etc.)

GET /history
→ [all nodes' stats for bulk queries]
```

**Status:** NodeStats struct exists and is populated; `/history` HTTP endpoint does not yet exist. Adding it is a thin wrapper over `node_history(&node_id)` (lib.rs:916).

---

## 10. Distinct-Counterparty Per-Pair Accounting (Phase 2+)

### Current Limitation (Not a Blocker)

**Today:** `earned` and `spent` are sums across all counterparties. Cannot distinguish:
- "node A earned 1000 all from node B" (possible wash trade)
- "node A earned 1000 from 500 different nodes" (likely honest provider)

### How to Add (Without Consensus Change)

Introduce a **side cache** (like `node_stats`):

```rust
// In Chain struct (lib.rs):
pub counterparty_ledger: HashMap<(NodeId, NodeId), CounterpartyStats> {
    earned_from: u128,
    spent_to: u128,
    job_count: u64,
    heartbeat_count: u64,
}
```

Updated in `apply_block_to_cache` alongside `node_stats`:

```rust
JobSettle { host, payer, cost, .. } => {
    let key = (*host, *payer);  // host earned from payer
    let entry = self.counterparty_ledger.entry(key).or_default();
    entry.earned_from += net;
    entry.job_count += 1;
}
```

**Consensus-critical?** No — it's observational, rebuilt from blocks, like `burned_total_cache`.

**Surfaced via API:** `GET /node/:id/counterparties` lists all (peer, earned_from_peer, spent_to_peer).

---

## 11. What Would Require Consensus Change (Not Needed for MVP)

### Not Required Now (Phase 2+ Nice-to-Haves)

1. **Per-cluster weight caps** — gate consensus weight per identified operator cluster (prevents single operator running 100 bonds)
   - Requires: on-chain cluster identifier (governance call), not a mechanical tx change
   - Status: phase 2 (docs/consensus.md §4.1)

2. **Per-cluster burn scaling** — multiply burn by cluster concentration (higher burn for suspected sybil clusters)
   - Requires: consensus to track cluster membership and apply dynamic multipliers
   - Status: phase 3+ (in research, not in code)

3. **Automatic capability grants based on reputation** — when a node's share_ratio crosses a threshold, auto-grant a `spawn` capability
   - Requires: new tx type to encode conditional on-chain state
   - Status: phase 5+ (app layer instead; apps grant caps based on `/history`)

4. **Per-job verification tiers** — JobBid gains a `verify:` enum (T0 / T1 / T2 / T3 / T4) encoding redundancy requirement
   - Requires: new TxKind fields
   - Status: Phase 2+ (sybil-resistance.md §4.2); app layer initially

---

## Summary: Share Ratio MVP (No Consensus Change)

A torrent-style system **can ship now** using only what exists:

### Required
- ✅ `NodeStats.earned` (post-burn) & `NodeStats.spent` (gross) — exists, tracked per node
- ✅ Settlement burn (1%) — implemented Phase 0
- ✅ Bond & earned-work coupling for weight — implemented Phase 2
- ✅ Full interaction ledger on-chain — all tx types recorded immutably

### To Build (App-Level, No Consensus)
- Add `GET /node/:id/history` → `NodeStats` + `share_ratio`
- Add `GET /node/:id/counterparties` → per-peer breakdown
- App computes `share_ratio = earned / max(spent, ε)` and enforces reputation tiers
- App can compute wash-trade risk from `earned_from_peer / spent_to_peer` ratios

### Optional Phase 2 (Still No Consensus)
- Side cache for counterparty ledger (per-pair earned/spent)
- Per-cluster reputation aggregation (detect sybil operator clusters)
- Reputation-weighted peer scoring in network layer (already designed in sybil-resistance.md §4.3 P5)

---

## References

**Key Files:**
- `/Users/07lead01/ce-net/ce/crates/ce-chain/src/lib.rs` — TxKind (184–273), NodeStats (577–598), apply_block_to_cache (778–902), Chain methods (916–918)
- `/Users/07lead01/ce-net/ce/docs/consensus.md` — CE-TWLE weight model (§2), governance (§4.1), Phase 0–3 implementation status
- `/Users/07lead01/ce-net/ce/docs/sybil-resistance.md` — E4 wash-trade fix (§3), burn mechanism (§4.1), per-peer reputation use cases
- `/Users/07lead01/ce-net/ce/docs/payment-channels.md` — channel settlement burn pattern (same as JobSettle/Heartbeat)
- `/Users/07lead01/ce-net/ce/docs/primitives.md` — NodeStats as reputation substrate (§3), trust gradient (§end)