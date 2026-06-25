# CE compute-donation Sybil security — the maximum-security design

Status: design, 2026-06-24. This is **the** security design for making CE's compute-donation
economy (donate compute -> earn credits + post collateral -> spend credits) Sybil-resistant. It
**extends** [../ce/docs/sybil-resistance.md](../ce/docs/sybil-resistance.md) (the 3-pillar audit)
and [../ce/docs/consensus.md](../ce/docs/consensus.md) (CE-TWLE: VRF leader election + slot-spacing
+ bond). It does **not** contradict the consensus phases — it is the marketplace/verification half
of the same system. Read those two first.

**The honest framing up front.** The owner's goal — "make it impossible to Sybil-attack" — is
*unachievable* and we must say so. Douceur 2002 proves that in an open system with free identities
and no central certifier, Sybils cannot be made impossible, only **costly**. Everything below
converts every Sybil action from a *scripting* problem (free, scales with `for` loops) into a
*liquidity-at-risk + detection-risk* problem (priced, scales with money you can lose). The design
target is:

> **Quantified target (state it exactly, never as "impossible").** The attacker's cost to *profit*
> from controlling a fraction `f` of accepted work is
> `Cost(f) ≈ f · max(TotalBondedStake, T_floor) · 1/(1−P_min(detect))`, where the bond is *locked
> per in-flight job* (not rehypothecated), `P_min(detect)` is the audit-detection probability at the
> host's *best reachable* reputation (not its current one), and the term is **independent of
> hardware throughput and of identity count for expected leadership, but NOT independent of identity
> count for committee capture** (see §2(b2) — splitting stake across keys raises the probability of
> capturing ≥K seats of a fixed K-of-N committee; that is governed by a binomial/hypergeometric tail
> in `f`, not by `f` alone). The cost is **liquidity-at-risk, not net worth** — bond can be rented
> or insured, so the security claim is "an attacker must put `≈f` of the network's bonded liquidity
> at slashing risk," nothing stronger.

This is the maximum a permissionless donate-compute network can achieve, and it is what every system
we cite (Filecoin, Storj, Sia, Tribler/MeritRank, Chia) actually achieves too — none of them are
"Sybil-proof," all of them are "Sybil-priced," and several of the mechanisms they ship (single-winner
challenge rewards, future-block-hash beacons, TEE attestation, fixed K-of-N voting) are now known to
be *broken or assumption-bounded* (see the Red-team findings, §8). We adopt the secure variants, not
the marketed ones.

**The one thing that makes compute special.** Storage is *cheaply re-challengeable forever*: the
artifact (a sealed replica) sits on disk and a satellite can re-demand a random byte-range at
near-zero cost, unboundedly (Storj audit service; Filecoin WindowPoSt every 30 min). **Compute has
no persistent artifact.** Once a job finishes there is nothing to re-challenge — the work was
ephemeral. So Filecoin's and Storj's entire cheap-audit trick ("prove you *still* hold it") has no
compute analogue. To audit compute you must **re-execute it (N× cost), challenge it (latency +
an online honest verifier), or prove it (zk, ~10^5–10^6× cost).** There is no free trustless lunch
below a zkVM. This document is honest about that everywhere.

---

## 1. Threat model — every way to Sybil a compute-donation mesh

The asset at risk is never "fake credits." It is **control of machines** and **theft of real
credits paid for compute that was never done**. For each vector: what it buys, and what it costs an
attacker *today* (against the currently-implemented CE, per the baseline audit).

| # | Vector | What the attacker does | Asset at risk | Cost **today** |
|---|--------|------------------------|---------------|----------------|
| **V1** | **Cheap identities** | Mint N free Ed25519 keypairs; each is a "host" | Peer/DHT/relay/marketplace weight, /history edges, gossip influence | **~0** (free keypairs; consensus weight is gated by `min(bond,earned)` but peer/marketplace weight is not) |
| **V2** | **Hardware grinding** | Buy faster CPUs/GPUs to produce blocks or beacon seeds faster, out-pace honest nodes | Consensus leadership, beacon bias, the "cheap-51% pacing" footgun | Low-ish, but **slot-spacing in `append()` already kills the pacing footgun** (consensus Phase 3). Grindable `/beacon` tip remains (see V8) |
| **V3** | **Fake capacity** | Advertise 100× the GPUs/VRAM you own; collect placement + rewards for capacity that does not exist | Job placement, UptimeReward, scheduler trust | **~0** — CE has **zero** implemented verification that advertised capacity is real. (Precedent: io.net's 1.8M fake GPUs, Apr 2024) |
| **V4** | **Fake work** | Accept a job, return a plausible-but-wrong result (or nothing), still collect `JobSettle` | The payer's credits + the payer's actual computation | **~0** — `JobSettle` never verifies the host executed anything (baseline E4). This is the central compute hole |
| **V5** | **Collusion / mutual-vouching** | One operator secretly runs k of the n hosts in a K-of-N redundant check, so the "majority" is the attacker | Redundant verification itself ("K-of-N is theater") | **~0** if placement is steerable — defeated only by beacon placement + per-identity bonds (Douceur) |
| **V6** | **Wash-trading credits/reputation** | Self-deal between two attacker-owned keys: payer pays host, both keys are yours, to pump `earned`/`/history` | Earned-work weight (`W=min(bond,earned)`), reputation score | **Lossy but possible**: settlement burn destroys 80% per cycle (raises cost ~5×) but does NOT eliminate it (baseline open risk #1) |
| **V7** | **Reputation-farm-then-defect** | Behave honestly to build reputation + held earnings, then exit-scam: take a big high-value job, collect, vanish | Real credits on one large job; scheduler trust | **Low** — reputation is washable (V6) and there is no held-escrow that is forfeited on abrupt exit yet |
| **V8** | **Eclipse / routing / beacon-grind** | Surround a victim with Sybil peers (eclipse), monopolize its DHT/relay path (Erebus), or, as the slot leader, grind the `/beacon` tip to bias verifier/replica placement | Victim's view of the chain; anti-collusion placement randomness | **~0** — gossipsub v1.1 scoring is OFF, single Hetzner relay + single bootstrap domain (baseline N1/N8), and `/beacon` returns the **grindable tip**, not a confirmed-depth value (baseline: `/beacon` "broken" for placement) |

**Two-layer reminder (the framing the whole stack hangs on, from sybil-resistance.md §1).**
CE has two trust layers needing *separate* defenses: (a) the **consensus layer** (who writes
blocks) — defended by VRF + `W=min(bond,earned)` + slot-spacing, where N Sybils get *zero* extra
weight; and (b) the **peer/DHT/relay/marketplace layer** (who routes, advertises capacity, earns
reputation, gets paid) — defended today by **nothing**. V1, V3, V4, V5, V7, V8 all live in layer
(b). This document's job is to price layer (b).

---

## 2. The layered defense — one coherent stack

Six layers. Each kills specific vectors. They compose: removing any one re-opens its vectors. The
ordering is by leverage (bond first — it is the only layer whose cost scales with attacker scale).

```
                        kills
 (a) Bonded identity ........ V1, V3 (cost floor)   "influence ∝ slashable stake — LOCKED per job, not rehypothecated"
 (b) Rate limit (VDF+VRF+slot) V2                   "1 op / 10s per chain; hardware buys nothing"
 (b2) Committee selection .... V5                   "bond-splitting committee capture is a binomial tail, not f"
 (c) Compute audit dial ..... V4, V5                "prove work happened — the hard part, no free lunch"
 (d) Slashing + held escrow .. V3, V4, V7           "cheating + defecting both lose money"
 (e) MeritRank reputation .... V6 (bounds), V5      "reputation never lowers assurance below the establishing tier"
 (f) Settlement burn ......... V6 (economic floor)  "wash trades are lossy; earned-accounting is lineage-based"
```

### (a) Bonded identity — influence ∝ slashable stake, not identity count

**Source: Filecoin initial pledge, Sia host collateral.** This is the single highest-leverage
layer and the only one whose cost scales with the *number* of Sybils. It converts V1 from a `for`
loop into a capital problem and puts a price floor under V3.

- **One standing `HostBond` per host**, gating *both* capacity-ad publication *and* `UptimeReward`
  eligibility. (Already an implemented chain primitive — the *gate* is the missing wiring; see §3.)
- **Size the bond in expected-reward-days AND proportional to claimed capacity.** Filecoin's
  consensus pledge = `30% × CircSupply × SectorQAP / max(NetworkBaseline, NetworkQAP)` — i.e.
  proportional to the *fraction of network power claimed*. Copy that: a host advertising `C` units
  of capacity must bond `bond(C)`. Sizing in reward-days (not fixed credits) survives halvings and
  price swings — Filecoin and Sia both do this deliberately (Sia: collateral = 2–3× storage price).
- **The bond-sizing inequality (the heart of "maximum security") — and the AGGREGATE-EXPOSURE fix.**
  The naive per-job form was *wrong* (red-team H1, rehypothecated collateral): a single standing
  bond `B` was written to cover the at-risk value of *one* in-flight job, but one bond gates the
  *role*, and a host runs *many* jobs against the same `B`. An attacker bonds `B` once, accepts `K`
  high-value jobs in parallel each with at-risk value ≈`B`, cheats them all inside one slashing
  window, steals ≈`K·B`, and loses at most `B` (slashing is bond-capped). Profit scales with
  concurrency for fixed capital — classic collateral rehypothecation. **Fix: the bond is LOCKED
  per-job against AGGREGATE in-flight exposure (Akash locks escrow per-lease — do the same on the
  host side):**

  ```
  ADMISSION GATE (enforced at JobBid acceptance, like JobBid already locks the payer's bid):
      active_bond  −  Σ_open_jobs ( at_risk_value_j / P(detect)_j )   ≥   0

  i.e. accepting a new job locks a slice  slice_j = at_risk_value_j / P(detect)_j  of bond
  headroom; K concurrent high-value jobs require K slices of UNLOCKED bond. A bid that would
  drive headroom negative is REFUSED (402-style), not accepted-and-hoped.
  ```

  Because audits are probabilistic (`P(detect) < 1`, see (c)), each slice scales the at-risk value
  by `1/P(detect)`. **Higher assurance tier ⇒ higher `P(detect)` ⇒ smaller slice ⇒ more concurrent
  jobs per unit bond** — the audit dial and the bond are one system. A capacity-proportional *ad*
  term still makes faking 100× capacity cost ~100× bond (the Filecoin property), but capacity-bond
  and per-job-locked-slice are **separate accounts**: advertising capacity locks the ad bond;
  *accepting value* locks a slice on top. Until slice-locking lands, the interim rule is a hard
  **per-host concurrent-high-value-job cap of 1** (sybil-resistance.md §4.2 "cap per-host value
  exposure" carried forward).

- Honest limit: bonding makes Sybil **liquidity-bounded, not impossible**, and **the bond is rentable
  and recyclable** (red-team H5, verified against the restaking impossibility result, arXiv 2509.18338,
  which proves *no* slashing mechanism is Sybil-proof under collusion + heterogeneous topology). A
  lender can post the bond and an operator run the attack, splitting profit; the lender's downside is
  only the slash, which the renter can insure. So the cost is **liquidity-at-risk × P(detect), NOT
  net worth.** Mitigations (none of which make it net-worth, only raise the liquidity bar):
  *(i)* a **required endogenous fraction** of total effective bond must be *earned-and-held* (the
  held-escrow of §2(d)) for high tiers, so an outside lender cannot supply 100% of collateral on day
  one (Storj's held-amount is endogenous by construction); *(ii)* **W = min(bond, earned) requires
  bond and earned to be DISTINCT credits** — the same locked balance may not be double-counted as both
  the collateral and the earned side; *(iii)* **identity-transfer detection** — a sudden behavioral
  discontinuity or key-rotation resets reputation + tier, so buying an *aged* identity does not buy its
  reputation (defeats "rent an aged key to bypass the ReputationAgeBarrier"). That residual is handled
  by (c)+(d)+(e), never by the bond alone. *Do not collapse the economic layer (bond) and the
  capacity-truth layer (audits) — Filecoin keeps PoRep/PoSt separate from pledge for exactly this reason.*

- **Absolute bond FLOOR (red-team H3 — early-network cheap capture).** The capacity-proportional bond
  *scales down* when the network is small (Filecoin's pledge is "half as much" at 50% of baseline QAP;
  block.science confirms). CE's `Sovereign → Vetted → Earned-open` bootstrap (consensus.md §4.1) keeps
  `TotalBondedStake` tiny for a long time, so `Cost(f) ≈ f·TotalBondedStake` is cheap *exactly* when
  the network is most fragile, and the correlation multiplier `min(1,3S/T)` degenerates when `T` is
  small (a lone whale *is* most of `T`). Fixes: **(1)** an absolute minimum bond floor in reward-days,
  independent of the proportional term, so no host bonds near-zero; **(2)** gate high-value job routing
  on `TotalBondedStake > T_threshold` — refuse to route value the network is too thin to secure;
  **(3)** the correlation denominator is `max(T, T_floor)` so a whale that is most of the stake still
  faces correlation slashing; **(4)** state explicitly: the bootstrap window is **high-trust / low-value
  only — stranger high-value jobs are forbidden until `T` crosses the floor.**

### (b) Hardware-independent rate limit — the owner's "1 hash / 10s"

**Source: Chia (PoSpace + PoTime), Algorand/Ouroboros (VRF sortition), Wesolowski/Pietrzak VDF.**
This is the layer the owner asked for most directly, and the one most easily mis-marketed. The
precise, load-bearing facts:

- **A VDF imposes a per-*evaluation* sequential delay `T` that more cores cannot shorten** (repeated
  squaring `g^(2^T)` in a group of unknown order; no parallelism speedup — Boneh–Bonneau–Bünz–Fisch).
  This genuinely delivers "one step per ~10s that buying faster hardware does not beat" — **for one
  chain**.
- **It rate-limits a CHAIN, not a CROWD.** N Sybil identities run N VDF evaluations *in parallel*,
  each finishing in `T`; network-wide rate scales linearly with identity count. **So a VDF is NOT a
  Sybil defense by itself** — Chia pairs its VDF (Proof-of-Time) with Proof-of-Space (the scarce
  Sybil anchor); Ethereum/Algorand pair VDF/VRF with stake. CE pairs it with **HostBond** (layer a).
  This is the single most important sentence in this section: **the VDF stops "rent hardware and
  out-pace" (V2); the bond stops "spin up 10,000 keys" (V1); neither substitutes for the other.**
- **VRF *leadership* is Sybil-NEUTRAL for AGGREGATE EXPECTED reward (provable) — but committee
  *capture* is NOT (red-team H8, critical, verified against the PoS private-attack/splitting literature,
  arXiv 2109.07440).** Be precise about which draw: `ticket = VRF(sk, seed)`, lead iff
  `ticket < threshold × W`. Because the threshold is *proportional* to weight, N keys of total weight
  `W` win *as often in total* as one key of weight `W` — splitting a bond across keys gives **zero**
  advantage **for expected leadership/reward**. This is true and load-bearing for ordering, and it
  pushes 100% of *leadership* Sybil cost onto the bond term where (a) prices it. CE already ships
  `W = min(active_bond, earned_work_score)`.

  **What this does NOT prove, and the doc previously over-claimed:** Sybil-neutrality of *expected*
  leadership says nothing about the probability of **winning ≥K seats of a FIXED K-of-N committee**.
  An attacker holding stake-fraction `f` split across many small-bond identities gets ≈`f` of every
  committee *in expectation*, but a far *higher* probability of capturing ≥2-of-3 (or any K-of-N) than
  a single large-bond identity, because each tiny identity is an independent draw — the splitting
  literature states this "creates multiplicative attack surface" and is "more advantageous than a
  single large stake" precisely for *selection/optionality*, not for expected reward. Worse, the bond
  is capacity-proportional, so advertising many fake-but-bonded small-capacity hosts buys
  committee-saturation *and* satisfies the capacity bond at once. **Therefore K-of-N (T2) and
  "beacon-selected independent auditor" (T1) are NOT made safe by per-identity bonds alone.** See
  §2(b2) for the committee-selection rules that *do* make them safe, and note that the design now
  **demotes T2 to a latency optimization, never a stranger-host security tier** — T3 fraud-proof is
  the default for anything above trivial value.
- **Cautionary non-example: Solana Proof-of-History is NOT a real VDF** — it is a sequential SHA-256
  chain whose speed scales with hardware, so it does *not* give the hardware-independence the owner
  wants. Only a true VDF (or external wall-clock slots) does. Solana's Sybil resistance comes
  entirely from stake, not PoH.

**Concrete params for CE.**
- `SLOT_SECS = 10` (implemented). Slot-spacing is **consensus-enforced in `append()`** (slot must
  strictly increase) — this is the correct place for the limit (validation, not a deletable honest
  ticker), and it already kills the cheap-51% pacing footgun (the 52× attack, baseline C1).
- `LOOKBACK = 64` blocks for the leader seed (implemented) so the leader cannot grind it.
- VRF: today signature-as-VRF `SHA256(Ed25519-sig)`; harden later to RFC 9381 ECVRF (consensus.md
  already flags this).
- **MANDATORY (not optional) anti-grind for the PLACEMENT beacon — red-team H4 + the two beacon
  criticals.** The earlier "optional VDF" framing was wrong. The *same* `/beacon` stream that orders
  blocks also seeds verifier/committee placement, and under VRF leader election the slot leader who
  *produces* the future seed block can **withhold or re-roll** its block (alternate tx sets / sibling
  VRF tickets) to bias *which* confirmed-depth value becomes canonical — the classic last-revealer /
  block-withholding grind (Sia's future-block-hash beacon failure, which this doc cites as the thing
  to avoid). Confirmed-depth stops *observers* grinding an already-final value; it does **not** stop
  the *producer* of that value. So for any job above a value threshold, committee/auditor selection
  MUST use a **separate, producer-unbiasable placement beacon**:
  1. **Mandatory Wesolowski VDF** over the seed with delay `T_vdf ≫ slot time`, so by the time a
     leader could compute the resulting committee, the withholding window has closed and honest blocks
     have extended the chain. The leader cannot choose-to-withhold based on an outcome it cannot yet
     see. (Promoted from "optional timing hardening" to **mandatory for audit-seed derivation**.)
  2. **Aggregate the seed over a moving window of ≥64 distinct block producers' VRF outputs**
     (RANDAO-style XOR over `LOOKBACK..LOOKBACK+W`), so any single withholder controls ≤`1/W` of the
     entropy and cannot move the outcome alone.
  3. **Commit-reveal²** among ≥2 independent beacon contributors for the highest-value committee draws.
  4. **Cap any single weight-holder's leadership share** that feeds the placement beacon.

  Update to the security argument: assumption (2) no longer says "confirmed-depth ⇒ unbiasable" (an
  over-claim). It now says: *placement randomness is unbiasable-by-the-block-producer because it is
  VDF-delayed + windowed + commit-revealed, NOT merely confirmed-depth.* This is the only real fix and
  the primitive already exists; we stop marking it optional.

### (b2) Committee / auditor selection — closing the bond-splitting capture hole (red-team H8)

Per §2(b), per-identity bonds do **not** by themselves make K-of-N or beacon-auditor selection safe:
committee-capture probability for an attacker with stake-fraction `f` split across many identities is a
**binomial/hypergeometric tail**, not `f`. The selection rules that *do* bound it:

1. **State the real bound, stop claiming Sybil-neutrality for committees.** Document that capture
   probability is governed by the tail of the draw, and size `K` and the supermajority threshold
   against the *actual* attacker fraction `f` you are willing to tolerate, not against an identity count.
2. **Minimum per-host bond floor as a non-trivial fraction of expected committee value**, so an
   attacker cannot mint cheap committee lottery tickets — this is the same floor as §2(a)(H3), applied
   to *selection*, not just to capacity.
3. **Stake-weighted, DISTINCT-ORIGIN supermajority, not identity-count majority.** Weight committee
   votes by bond, but **discount votes whose bonds trace to a common on-chain funding source** (the
   transfer graph is already on-chain and auditable via `/history`). Apply the existing Pillar-3 ASN/IP
   diversity caps to *committee seating*, not only to routing: cap how many seats one beacon draw may
   fill from a correlated network/bond origin.
4. **Quorum arithmetic fixed.** "Default N=3/K=2" was wrong — `2-of-3` is *exactly* `2/3`, not the
   strict `>2/3` the slash rule requires, and two colluders beat one honest host (BOINC's documented
   replication-collusion). **New default N≥4 / K≥3 (strict >2/3)** so two colluders cannot form a
   majority. T2 is demoted to a *latency optimization for low-value or earned-host work*, never a
   stranger-host security tier.
5. **Prefer fraud-proof to voting.** For anything above trivial value the default is **T3** (one honest
   verifier breaks the ring), with T2 used only where re-execution latency is the binding constraint —
   because Open Problem 1 already admits separately-bonded *real* colluders defeat voting, and N=3/K=2
   is the weakest possible quorum against exactly that.

### (c) Audits for compute — the hard part, no free lunch below zk

**Sources: BOINC (redundant), Truebit/Arbitrum/Optimism/Cartesi/Gensyn-Verde (fraud proofs),
RISC Zero/SP1 (zkVM), Intel SGX/TDX + NVIDIA CC (TEE), Filecoin WindowPoSt (the benchmark-audit
pattern).** Verification *policy* is an **app** (scheduler) concern, not a node primitive
(primitives.md). The job carries one `verify:` tier; cost/latency scale with the tier; defaults
track the trust gradient (strangers forced high, earned hosts cheap, owned hosts T0).

| Tier | Mechanism | Source | Cost | Security level | Use |
|------|-----------|--------|------|----------------|-----|
| **T0 interactive** | heartbeat pay-as-you-go *is* the check; human perceives output | CE-native | ~0 | heuristic (human-in-loop) | games, render, sims, shells |
| **T1 spot-audit** | re-run on a VDF-placement-selected independent host with prob `p = ν(1−t)`; mismatch ⇒ slash; reward split **MULTI-WINNER** across all valid challengers + **forced-error jackpot** funded from burn/emission | Golem sampling, Truebit (forced-error variant) | 1×+ε | heuristic | single-host deterministic jobs |
| **T2 redundant K-of-N** | run on N VDF-placed hosts; accept strict **>2/3** hash; slash divergent-from-referee. **Default N≥4/K≥3** | BOINC | N× | **heuristic — collusion-fragile (V5); DEMOTED to a latency optimization, NOT a stranger-host security tier** | short deterministic earned-host jobs only |
| **T3 fraud-proof** | optimistic accept in a window; ≥2 beacon-selected bonded verifiers, **any** opens an O(log n) bisection to the first divergent step; a referee re-runs *that one step*; **ALL** correct challengers paid | Truebit, Gensyn Verde | 1× + cheap disputes | **assumption** — best cost/assurance; needs ≥1 online honest uncensored verifier + deterministic re-execution; **NOT a guarantee** — for the highest-value jobs escalate to T2(K≥3)+T5 spot, do not rely on T3 alone | long deterministic / RepOps-ML jobs (**CE default for batch above trivial value**) |
| **T4 TEE-attested** | enclave signs a vendor-rooted quote (SGX/TDX, SEV-SNP, H100 CC) | Intel/AMD/NVIDIA | ~+30% | **BROKEN for proof AND identity** — TEE.Fail (Oct 2025, tee.fail/WireTap) extracts ECDSA attestation keys from Intel's PCE for <$1000 and forges TDX/SEV-SNP quotes that pass DCAP at the *highest* "UpToDate" trust tier. **Treat as CONFIDENTIALITY ONLY** (hides job data); **MUST NOT** raise reputation, lower a verification tier, reduce a bond, or feed `P(detect)` or MeritRank | confidential / un-re-runnable work; **never a substitute for a redundant/fraud-proof tier** |
| **T5 zkVM** | prover emits a succinct proof of the exact execution trace; verifier checks in ms | RISC Zero 2.0, SP1 | ~10^5–10^6× native | **provable** — correct even if all hosts collude; only cryptographic tier | rare high-value / un-re-runnable only |

**Capacity audit (catches V3 — the compute analog of Filecoin WindowPoSt).** Bond `bond(C)`
proportional to advertised capacity `C`. **The earlier periodic-benchmark design was defeatable by
rent-burst and proxy (red-team H7/H16) and is replaced by a CONTINUOUS, UNPREDICTABLE, ALL-CAPACITY,
job-bound audit.** Three failure modes the periodic benchmark did not stop, with the fixes:

- **Rent-burst** — advertise 100×H100, rent one real H100 only for the benchmark's predictable
  byte-identical window, then serve jobs on a 3060. *Fix:* **micro-challenges at beacon-random times
  WHILE real jobs are in flight** (rent-bursting must keep silicon attached *continuously*, which is
  just owning it); and `P(detect)` is **measured from inline probes, not from a one-shot benchmark**
  whose P(detect) for a rent-burster is ≈0.
- **Proxy / relay** — one fast box answers the challenge for N advertised Sybil hosts (on-device GPU
  PoW does not cryptographically bind to specific silicon — admitted). *Fix:* **bind the challenge to
  the SAME execution context as paid jobs** (same container / attestation / session key) so the host
  that answers the challenge must be the host holding the job's session; and demand **N independent
  beacon-seeded benchmarks IN PARALLEL sized to the FULL advertised `C`** (one rented GPU cannot answer
  100 parallel H100 benchmarks in the deadline).
- **Honest-only-during-audits** — pass audits, return junk on real jobs. *Fix:* run the
  delivered-throughput cross-check as a **cheap inline probe on EVERY job's first seconds (slash on
  mismatch)**, byte-identical to audits (Storj selective-service lesson), not as a post-hoc signal that
  only catches the cheat after a payer already lost.

A miss is provable by on-chain *absence* of a `ChallengeResponse` ⇒ self-healing `FaultFee = 1/32 bond`,
not confiscation (flaky-hardware safety valve; and disappearance must be confirmed across ≥3 independent
relays over a multi-epoch window before any forfeiture — see §2(d), eclipse safety valve). Cap advertised
`C` growth rate and **vest bond with sustained delivered throughput**, not just at ad time. Honest level:
**heuristic, deterrent not proof.** Size the bond to `(advertised_C × expected_tenure_revenue) / P(detect)`
with `P(detect)` from inline probes. **Correction to the prior draft:** the io.net "1.8M fake GPU"
incident is **NOT** evidence that bond-sized benchmarks deter faking — io.net's breach was a *SQL
injection on a centralized metadata DB* (verified: write-API auth-token reuse, Apr 2024), i.e. a
defeat of *centralized accounting*, not of a capacity proof. It is a cautionary tale about trusting a
metadata DB, and a reminder that even io.net's later on-device PoW was bypassed — not support for the
benchmark-deters-faking claim.

**The anti-collusion primitive that makes T1/T3 real (kills V5).** Every voting/sampling tier
is theater unless the verifier set is **unforgeable, unsteerable, and unpredictable**:
1. **Commit the JobBid first**, then derive the verifiers/auditors from the **VDF-delayed, windowed,
   producer-unbiasable placement beacon of §2(b) — NOT merely a confirmed-depth tip.** Confirmed-depth
   stops observers grinding; it does *not* stop the slot leader who *produces* the seed block from
   withholding/re-rolling it (Sia's future-block-hash failure; red-team H4 + criticals). The seed MUST
   NOT be a value the about-to-be-audited host can produce or withhold.
2. **Per-identity bonds + the §2(b2) committee rules.** Per-identity bonds alone do *not* make
   committees safe (bond-splitting raises capture probability — H8); they are safe only with the
   distinct-origin supermajority, the bond floor, and N≥4/K≥3 of §2(b2).
3. Make audited jobs **byte-identical to normal jobs** so a host cannot be "honest only when it
   suspects an audit" (the Storj selective-service / containment lesson).
4. **Dispute rewards are MULTI-WINNER, with forced errors (red-team H2/H10/H15 — the 2025 impossibility
   result, arXiv 2512.20864, verified).** The 2025 result proves any *single-winner* challenge design
   cannot simultaneously incentivize honest challengers and deter fraudulent proposers: a
   proposer+challenger coalition recaptures the lone reward slot with internally-recycled (effective-
   cost-0) payments, driving honest challengers to negative EV. CE's "auditor jackpot solves the
   verifier dilemma" claim was **false** — it omits Truebit's *forced errors* and is single-winner.
   Fixes: **(a)** pay **ALL** valid challengers pro-rata, deposit sized to absolute collusion size `A`
   (`D_p ≥ c̃·A/(1−η)`), so a whale cannot capture the slot by self-challenging; **(b)** **mandatory
   forced errors** — the system injects random known-wrong results that pay the jackpot regardless of
   attacker behavior, so verifying always has positive EV; **(c)** fund the challenger reward from
   **burn/protocol emission, NOT solely from the slashed party**, so an attacker self-slashing nets a
   *real* loss, not an internal transfer; **(d)** a self-challenger must post its **own real bond** and
   be **independently beacon-selected**.
5. **No in-cluster slash recycling (red-team H10 — auditor-is-the-jackpot-winner).** The auditor reward
   must be **small relative to the burn** — burn ≥ 90% of every slash, reporter/auditor ≤ 10% (lower
   the implemented `SLASH_REPORTER_BPS=2500`; 25% enables a cluster to slash its own H1, route the bond
   to its own auditor H2, and lose only the burn). **Disqualify an auditor from the reward when auditor
   and slashed host share a common on-chain bond-funding ancestor within K hops.** Credit
   auditor-detection into MeritRank **only** for T3 referee verdicts (re-execute one deterministic
   step), never for committee votes the host could have influenced. Require the auditor to post a
   **counter-bond** slashed if a later T3 challenge shows the "detected mismatch" was fabricated
   (closes fraudulent-dispute griefing).

**Determinism is a prerequisite, not optional, and the non-determinism carve-out is NARROW (red-team
H14/H16).** Naive output-hash comparison **fails for GPU/ML** — IEEE-754 non-associativity makes honest
hosts disagree at the bit level. The earlier wholesale "never auto-slash non-deterministic output" rule
was a **general cheat-cover for ML** (the headline donate-compute workload): a cheater steers value into
the non-deterministic regime where T2 cannot slash and T3 cannot pinpoint a divergent step, and the cheat
is indistinguishable from honest disagreement. Replacement rules:
- For ML/non-deterministic work, a **deterministic runtime (RepOps fixed-FP-order or integer-quantized)
  is a CONDITION of any tier above T0** (~20–30% slower). There is **no non-deterministic path that
  escapes slashing** above a value threshold; a host that won't run deterministically is forced to **T0**
  (human-perceived, pay-as-you-go, no settlement of disputed value) or **T5 (zk)**. ML without a
  deterministic runtime has **no audit tier below T5** — this is what the §1 "compute is special" thesis
  actually implies; the tier table previously softened it.
- The carve-out is **"no auto-slash for WITHIN-band disagreement"** only — *not* "no auto-slash for
  non-deterministic outputs" wholesale. The tolerance band (NAO) is derived from a **deterministic
  reference run on a beacon-selected referee**, its parameters are **signed into the JobBid before
  placement**, and a result **OUTSIDE the band IS slashable**.
- Slash the party that **diverges from a REFEREE RE-EXECUTION**, never the peer-vote minority — this
  kills the false-slash-an-honest-competitor griefing (2 colluders agreeing on a wrong answer in N=3).
  Cap per-job slash so a griefer cannot profit from false-slashing.
- gVisor + pinned image digest + WASM remain required for deterministic tiers. Filecoin's Dec-2020
  non-determinism halt is the cautionary tale: keep the consensus/audit path integer-deterministic.

### (d) Collateral + slashing + held escrow — cheating and defecting both lose money

**Sources: Filecoin (fault fee / termination fee / consensus-fault), Sia (slash-to-burn), Storj
(back-loaded held amount).**

- **Three slash classes, graduated** (matches Filecoin's mild-vs-catastrophic split):
  1. **Equivocation** (two conflicting host-signed messages) ⇒ **burn 100% of bond**. This is the
     *only on-chain-provable* fault — two valid conflicting signatures are self-evident evidence
     anyone can verify, no trust, no latency assumption (Filecoin `ReportConsensusFault`, Tribler
     TrustChain proof-of-fraud). **Already implemented as `SlashEquivocation`.** Keep
     permissionless: anyone submits the proof and earns a cut (`SLASH_REPORTER_BPS = 2500`).
  2. **Fake capacity** (missed beacon challenge, provable by absence) ⇒ `FaultFee = 1/32 bond`,
     self-healing (recover and stop paying — Filecoin's 3.51-day fault fee shape). *New.*
  3. **Failed redundant verification** (minority vs >2/3 supermajority on a `verify=k` job) ⇒ slash
     = disputed bid × multiplier, capped at bond. *New.*
- **Correlation multiplier `min(1, 3·S/max(T,T_floor))` over a 2016-block window — but TEMPORAL
  correlation alone is evadable and weaponizable (red-team H12), so add STRUCTURAL correlation.** A
  patient cluster simply does *not* fail together: it spreads faults thinly across the window and across
  fault classes so `S/T` stays tiny, paying only per-event FaultFees (a rounding error vs. value stolen);
  and a whale can deliberately self-slash throwaway identities to inflate `S` right when an honest host
  hits an unlucky correlated crash (an AWS/Hetzner outage), converting honest FaultFees into near-100%
  confiscation. Fixes: **(1)** cluster faults by **on-chain bond-funding lineage and IP/ASN**, so
  spread-out-in-time-but-same-origin faults are penalized as correlated (the real cluster signature is
  *origin*, not *simultaneity*); **(2)** the denominator counts only **distinct-origin** bonded stake,
  and `T_floor` prevents cheap `S/T` inflation; **(3)** a **circuit-breaker** bounds the multiplier's
  effect on any single honest host during a *declared network-wide incident*, since legitimate correlated
  failure is real and must not be confiscatory; **(4)** carry forward the sybil-resistance.md "bound `M`
  and cap per-window slash" mitigation explicitly (the PLAN previously dropped it).
- **Route slashed stake to a SMALL reporter-reward + DOMINANT burn (≥90% burn), never to the payer or
  other hosts.** The reward must be small enough that any in-cluster slash-and-self-audit is strictly
  loss-making (red-team H10); **lower the implemented `SLASH_REPORTER_BPS = 2500` to ≤1000.** Challenger
  rewards beyond this are funded from **burn/emission**, never solely from the slashed party (so
  self-slashing is a real loss). The previous "this funds the verifier's jackpot that *solves* Truebit's
  dilemma" claim is **dropped** — single-winner jackpots do not solve it (§2(c)(4)).
- **Held escrow — the farm-then-defect (V7) reducer (Storj), with compute-specific corrections
  (red-team H13/H18).** Back-load a fraction of `UptimeReward`/`JobSettle` earnings into a held balance,
  released on **graceful exit** and forfeited on slash or *confirmed* abrupt disappearance. Two honest
  caveats the prior draft imported uncritically from Storj:
  - **No restitution anchor.** For storage, abrupt-exit forfeiture offsets a *measurable* re-replication
    cost. **Compute has no persistent artifact and no repair cost** (the §1 thesis), so held-escrow
    forfeiture is **deterrent-only with no restitution target** — its size is therefore sized against
    **max-gain-from-defection** (the §2(a) inequality), not against a repair cost. State this plainly:
    held escrow is a deterrent, *unlike* Storj's repair-anchored amount.
  - **Fixed-tenure schedule is amortizable.** A farm computes the exact break-even (Storj returns half at
    month 16 — a farm waits exactly that long, then defects on one big job). Fixes: **(1)** a host may
    **never accept a job whose value exceeds its currently-forfeitable held balance + standing-bond
    headroom** (the §2(a) admission gate — "wait until escrow releases then take one big job" is
    impossible because taking the big job *requires* the escrow still held); **(2)** the release schedule
    depends on **cumulative distinct-counterparty VERIFIED value**, not wall-clock tenure, so a farm
    cannot run down the clock with self-dealt or low-value work; **(3)** **release LAGS the longest open
    audit/dispute window** (`release = max(unbond_window, longest_in_flight_job_dispute_window)`) so a
    defector cannot reclaim before fraud on the scam job can be proven.
  - **Disappearance must be distinguished from censorship/eclipse (red-team H18).** Forfeit-on-
    disappearance only after the host is **unreachable across ≥3 independent relays / a quorum of
    attesters over a multi-epoch window** — never on a single missed challenge (mirror the FaultFee
    self-healing). This is load-bearing on assumption (6); therefore **Phase 5 network hardening must
    ship WITH or BEFORE Phase 8 held-escrow**, not after.
- `UNBOND_BLOCKS = 2016` (~2 weeks, implemented) keeps funds slashable through unbonding so a host
  cannot cheat-then-flee.

Honest limits: slashing-by-absence is **eclipse-sensitive** (a censored response looks like a fault
— which is exactly why missed challenges are a self-healing FaultFee, not confiscation). Slash
magnitudes are *tuning, not theory* — Filecoin re-tuned its fault/termination fees repeatedly via
FIPs; expect to calibrate empirically.

### (e) Sybil-resistant reputation — MeritRank over the /history work-ledger

**Source: Tribler TrustChain (Layer 1) + MeritRank (Layer 2), Nasrulin/de Vos/Pouwelse BRAINS
2022.** Adopt the **two-layer split** explicitly and do not conflate them:

- **Layer 1 (ledger): CE's existing `/history` NodeStats + double-signed records** (payer-cosigned
  `JobSettle`, `HostBond`, the `SlashEquivocation` proof) are a TrustChain-style tamper-evident
  pairwise log. Gives non-repudiation + provable equivocation detection — **but ZERO Sybil
  resistance by itself** (it faithfully records fabricated self-dealing).
- **Layer 2 (reputation): a MeritRank-style decayed, seed-personalized random walk** over that log,
  computed as an **app-layer scorer** (scheduler), each node using *its own* node as the seed
  (personalized, not global trust). Three decay knobs are the actual defense:
  - **Transitivity decay `(1−α)^d`** — reputation laundered through long Sybil chains evaporates
    with graph distance `d` from the seed (α≈0.4 in the source experiments).
  - **Connectivity decay `(1−β)`** on narrow graph cuts — a node reachable only through a single
    bridge (the structural signature of *every* sock-puppet farm) is discounted. Pairs naturally
    with CE's ≥3-relay / IP-diversity hardening: a host reachable only via the single Hetzner relay
    is a bridge and is discounted.
  - **Epoch decay `(1−γ)`** — ages out stale/abandoned-attack reputation (recency / anti-stale).
- **Drive it into two CE places:** the **verification dial default** (low MeritRank ⇒ forced to a
  high tier; high MeritRank ⇒ a *capped* downgrade subject to the §2(e)(1) tier-floor and the job-value
  ceiling — **never below the establishing tier, never below T2/T3 for high-value jobs regardless of
  age**) and the **gossipsub P5 application-score** (slashed/revoked peers driven to −300, below
  graylist). Minting N PeerIds is free; earning positive P5 requires N bonds + N real *verified*
  histories.

**Honest guarantee AND its limits (do not over-sell — this is the most over-sold mechanism in the
field):**
- The guarantee: MeritRank is **Sybil-TOLERANT, not Sybil-proof** — it **bounds** the reputation a
  Sybil region can gain rather than amplifying it (unlike maxflow/BarterCast, which is *broken* —
  trivially Sybil-amplifiable, and Tribler removed it).
- The bound is **EMPIRICAL, not a theorem.** The paper *defines* tolerance
  (`lim_{|S|→∞} ω⁺(σ_S)/ω(σ_S) ≤ c`) but derives **no general closed-form `c`**; experiments
  (PPR, α=0.4, ~50 Sybils, MakerDAO dataset) show gain held to ~1.5×–2.5×. Achievable `c` depends on
  topology and tuning. **Do not write a guaranteed bound into CE code.** Notably, epoch decay did
  *not* improve Sybil tolerance in the paper's own experiments — treat it as freshness, not defense.
- **The load-bearing assumption — and the CIRCULARITY it creates (red-team H9, critical; H19/H20).**
  MeritRank's bound only holds because *every honest→Sybil edge must be backed by real delivered work*
  (verified: arXiv 2207.09950 — tolerance requires each edge represent a real transaction; the bound is
  empirical ~1.5–2.5×, not a theorem; epoch decay "did not improve Sybil tolerance" in the paper). For
  Tribler that edge is *bandwidth* (self-evident at delivery). For CE it is a `JobSettle` — and CE's
  **E4/V4 hole means `JobSettle` proves nothing executed**. **The trap:** three of the four
  "establishers" of an edge (spot-checked T1, redundant T2, fraud-proved T3, bond-backed) are *exactly*
  the tiers broken by committee-capture (§2(b)/H8). A cluster that captures its own T1 auditor or T2
  majority **manufactures "established work" edges at will**, MeritRank launders them into reputation,
  that reputation relaxes the dial to a cheaper tier, which lowers `P(detect)`, which makes the next
  round of self-auditing cheaper — a **positive-feedback loop**. The fixes break the loop in three
  places:
  1. **Reputation may NEVER lower the verification tier below the tier that ESTABLISHED the edges that
     produced it.** Reputation earned under T1/T2 can only ever buy you *back to* T1/T2 — never to T0.
     Only **T3/T5-fraud-proved or human-perceived-T0-interactive** history can earn a dial *downgrade*.
     This makes the loop non-amplifying.
  2. **Compute MeritRank for the purpose of DIAL-DOWNGRADES only over T0-human-confirmed and
     T3-fraud-proved edges.** T1/T2 edges may rank/place hosts but **must not relax assurance.**
  3. **Cap reputation derived from any single beacon-committee lineage:** if a host's positive history
     is dominated by jobs whose auditors/co-hosts trace (via the on-chain bond-funding graph) to a narrow
     origin set, apply connectivity-decay `(1−β)` to *that history*, not just to routing topology.

  Therefore MeritRank is strictly DOWNSTREAM of layers (a)+(c) and **never relaxes assurance for any
  high-value job** (strangers *and* aged hosts both stay forced-high above the value threshold — aging
  is *buyable*, red-team H19, so the "earned hosts cheap" relaxation is capped by job value, not by age).
  Reputation layered on unverified work inherits its insecurity. MeritRank does not fix V4 — the audit
  dial does.
- **TEE attestation is EXCLUDED from MeritRank and from `P(detect)` (red-team H17).** Since TEE.Fail
  forges identity at the top trust tier, folding it "into reputation" would let an attacker mint
  unlimited high-trust attested identities that the dial then treats as low-risk. T4 informs neither
  reputation nor the bond nor the detection probability — confidentiality only.
- Personalized ⇒ no canonical score, and a fresh node sees almost nothing (cold-start). Policy for
  strangers is *not* reputation — it is "forced to a high verification tier" (the bootstrap/Sybil
  tension, §5).

### (f) Economic backstop — settlement burn makes wash trades lossy

**Source: CE's own design (the universal wash-trade leak closer).** `SETTLEMENT_BURN_BPS = 8000`
(80%) is destroyed on every `JobSettle`/`Heartbeat`/`ChannelClose`; the host keeps 1/5. Every wash
cycle between two attacker-owned keys (V6) destroys 80% of the gross, raising reputation-pumping cost
~5× per cycle. **Honest limit: the 5× burn is a one-time capital toll a patient whale pays (red-team
H6)** — amortized over a later large theft it is *not* a deterrent at the scale the threat model cares
about, and `earned_work_score` still counts burn-discounted self-dealing, so MeritRank edges (§2(e))
remain mintable by a whale who absorbs the burn.

**The distinct-counterparty earned-accounting is necessary-but-NOT-sufficient, and is itself Sybil-
farmable by identity (red-team H6/H13/H21).** "Distinct counterparty" defined by *PeerId* is free to
fake: a cluster of M bonded identities presents M distinct counterparties and generates O(M²) edges
from M bonds — the metric would *reward* buying more identities. The robust construction:
- **Distinct by BOND-FUNDING LINEAGE / fund-flow graph, not by PeerId** — discount earned-credit from
  counterparties whose bonds/balances trace to a common on-chain source (the transfer graph is already
  on-chain and auditable).
- **Weight `earned_work_score` by the counterparty's own MeritRank (recursively)** — this is the actual
  Tribler/MeritRank construction (feedback weighted by the giver's standing); earnings from un-reputed
  cluster members contribute ≈0. The PLAN previously applied recursive weighting to reputation but not to
  `earned_work_score`; apply it to both.
- **Cap per-counterparty contribution** to `earned_work_score`.

**This refinement is a PREREQUISITE for Phase 8 (MeritRank), not a later Phase 9 hardening item** — and
until it lands, **earned-weight / MeritRank may NOT relax the verification tier for any high-value job.**
Stop calling distinct-counterparty accounting "the robust fix" (Open Problem 5) — it is
necessary-not-sufficient. (Doc hazard to fix when wiring: consensus.md still says 100 bps / 1%; the code
is 8000 bps / 80% — 80% is the intended value.)

---

## 3. Mapping — what CE has vs what is NEW

| Layer | Mechanism | CE already has | NEW to build | On-chain / protocol change |
|-------|-----------|----------------|--------------|----------------------------|
| (a) | HostBond per host | `HostBond`/`HostUnbond` tx, `locked_balance`, `active_bond()`, `UNBOND_BLOCKS=2016` | **Wire the gate + slice-lock**: bond gates `CapacityAd`+`UptimeReward`; capacity-proportional sizing **+ absolute `T_floor`**; **per-job aggregate-exposure admission gate** (lock `slice=at_risk/P(detect)`, no rehypothecation); single-job value ceiling `≤ bond·P_current`; required endogenous held fraction; distinct bond≠earned | gate + per-job slice-lock in apply/bid path; `bond(C)`+`T_floor` sizing fn |
| (b)/(b2) | VDF + VRF + slot-spacing + committee rules | VRF leader election, `W=min(bond,earned)`, slot-spacing in `append()`, `SLOT_SECS=10`, `LOOKBACK=64` | **MANDATORY Wesolowski VDF + windowed (≥64 producers) + commit-reveal placement beacon** (NOT confirmed-depth alone); ECVRF; **§2(b2) distinct-origin committee rules, N≥4/K≥3, T2 demoted** | VDF over placement seed (separate from block-production stream); committee selection fn; on-chain bond-funding-lineage graph |
| (c) | Compute audit dial | `/beacon` (tip), `/history`, bond+slash substrate | **`CapacityAd`/`ChallengeResponse`/`JobResult` tx**; **continuous job-bound inline+parallel-full-capacity audits** (not periodic benchmark); T1 spot / **T3 fraud-proof default** (T2 latency-only); **multi-winner + forced-error dispute rewards**; **per-tier determinism** (ML→deterministic-runtime-or-T5; within-band-only carve-out) | new tx types; placement beacon (see (b)); app-side scheduler verify dial |
| (d) | Slash + held escrow | `SlashEquivocation` (100% burn), reporter-reward 25%, slash-to-burn routing | `SlashCapacityChallenge` (FaultFee 1/32), `SlashVerificationFault`; **STRUCTURAL (lineage/ASN) correlation + circuit-breaker** over `max(T,T_floor)`; **lower `SLASH_REPORTER_BPS`→≤1000 (burn≥90%)**; held escrow (deterrent-only, value-capped, dispute-window-lagged, ≥3-relay disappearance) | 2 new slash tx; structural-correlation accounting; held-balance ledger + eclipse-safe graceful/abrupt detection |
| (e) | MeritRank reputation | `/history` NodeStats (Layer 1) | **MeritRank scorer (app)** over **fraud-proved/human-confirmed edges only for dial-downgrades**; cap by committee-lineage; feed *capped* verify-dial downgrade + P5; **TEE excluded** | none on-chain (app-layer); reputation never lowers tier below establishing tier / below T2-T3 for high value |
| (f) | Settlement burn | `SETTLEMENT_BURN_BPS=8000` (implemented) | **lineage-based + recursively-MeritRank-weighted** distinct-counterparty earned accounting — **prerequisite for Phase 8** | `earned_work_score` refinement on the on-chain transfer/lineage graph |
| net | libp2p hardening | (Pillar 3, design only) | gossipsub P4/P5 scoring, conn limits, /24 caps, ≥3 relays — **ship with/before held-escrow (Phase 8)** | `ce-mesh` config — see sybil-resistance.md §4.3 |

**Cooperation with consensus.md (do not contradict):** the VRF/slot/bond/weight phases (CE-TWLE
Phases 0–3) stand as-is; this doc *extends* them with the marketplace gate + per-job slice-lock (a),
the committee rules (b2), the audit protocol (c), the new slash classes + held escrow (d), and the
app-layer reputation (e). The consensus touch-points are: **a mandatory VDF + windowed + commit-reveal
placement beacon (separate from the block-production VRF stream)** — confirmed-depth alone is
insufficient because the *producer* of the seed block can withhold/re-roll it — and an on-chain
bond-funding-lineage graph for committee/earned-accounting distinct-origin checks. Both are additive;
neither changes leader election.

---

## 4. Quantified security argument

**Claim.** Under the assumptions below, the attacker's cost to control a fraction `f` of the mesh's
**accepted work** scales as

```
Cost(f)  ≈   f · max(TotalBondedStake, T_floor)   (must out-bond the honest f-fraction; layer a + b's
                                                    VRF is Sybil-neutral for EXPECTED leadership only —
                                                    committee capture still scales with identity-split,
                                                    see §2(b2); T_floor closes early-network cheapness)
          ×  AuditDetectionPenalty                (each cheat caught with prob P_min(detect) — the prob
              = 1 / (1 − P_min(detect))             at the host's BEST reachable reputation, not current;
                                                    bond is LOCKED per-job vs aggregate exposure (no
                                                    rehypothecation), so to net a gain the attacker needs
                                                    locked_slice > gain/P(detect) — layer a+c+d)
          ×  ReputationAgeBarrier                 (to be *selected* for high-value work the Sybil must
              = e^{age·decay}                       accrue MeritRank from distinct, lineage-disjoint,
                                                    fraud-proved counterparties — layer e + held escrow d.
                                                    NOTE: age is BUYABLE once and amortized, so this term
                                                    caps the DOWNGRADE, it does not bound high-value risk)
```

and is **independent of hardware throughput, and independent of identity count for EXPECTED leadership**
(layer b); but **committee-capture probability and the bond-splitting attack surface are NOT independent
of identity count** (§2(b2)) — that is bounded by the distinct-origin committee rules, not by VRF
neutrality. The cost is **liquidity-at-risk × P(detect), NOT net worth** — bond is rentable/insurable
(H5).

**Worked intuition.**
- *Identity count drops out:* VRF leader threshold ∝ weight ⇒ N keys with total weight `W` ≡ 1 key
  with weight `W` (provable). So spinning up keys (V1) buys nothing without bond.
- *Hardware drops out:* slot-spacing in `append()` + (optional) VDF seed ⇒ producing blocks/seeds
  faster is rejected by validation (V2 priced out).
- *The bond term — with the adversary-chosen-denominator fixed (red-team H22).* To be placed on `f`
  of accepted work, an attacker must lock `f` of bonded stake **per in-flight job** and survive audits.
  The naive `bond > gain/P(detect)` let the *attacker* shrink the denominator: a high-reputation host
  gets low audit probability `p = ν(1−t)`, so a once-sized bond falls below `gain/P(detect)` on exactly
  the jobs it most wants to cheat. **Fix: the bond requirement uses `P_min(detect)` — the audit
  probability at the host's BEST reachable reputation — OR, equivalently and more simply, CAP the maximum
  single-job value at `bond × P(detect_current)`.** Then lowering `P(detect)` via reputation automatically
  lowers the value ceiling, keeping `locked_slice > gain/P(detect)` invariant by *admission control*
  rather than by hoping the once-sized bond was large enough. This closes the "reputation buys a cheaper
  cheat" loop. At T3 with one honest verifier, a *single* successful fraud proof confiscates the locked
  slice; raising the tier raises `P(detect)` and shrinks the slice (more concurrency) — the dial and bond
  are one system.
- *The reputation-age term:* high-value jobs default to high tiers for strangers and only relax for
  hosts with aged, counterparty-diverse MeritRank + a large held-escrow balance — so the attacker
  must *also* pre-pay tenure (held escrow forfeited on defect), making V7 loss-making.

**Assumptions (each is a layer that must hold).** (1) bond is correctly sized, *gated*, **locked
per-job against aggregate exposure** (no rehypothecation), and above the **absolute floor `T_floor`**
(a); (2) the **placement beacon is VDF-delayed + windowed + commit-revealed** so it is
unbiasable-*by-the-block-producer* — confirmed-depth alone is **insufficient** (a leader who produces
the seed block can withhold/re-roll it) (b/c/V8); (3) at least one honest uncensored verifier exists for
T3, with **multi-winner forced-error rewards** so honest verifying has positive EV — and for the highest
value, ≥2 independent bonded verifiers, never sole reliance on T3 (c/V5); (4) **the determinism level
required is per-tier explicit** — ML without a deterministic runtime has *no* tier below T5; the
no-auto-slash carve-out is *within-band only* (c); (5) MeritRank edges admit only **fraud-proved /
human-confirmed** work for the purpose of *assurance relaxation*, and `earned_work_score` is
lineage-distinct + recursively MeritRank-weighted (e/f); (6) the libp2p layer is hardened so the victim
is not eclipsed **and disappearance is distinguished from censorship before any forfeiture** — Phase 5
ships with/before Phase 8 (V8/net/d). **If any assumption fails, its vector re-opens** — this is why the
layers are stated separately and why none is sufficient alone.

**What this does NOT claim:** not "impossible" (Douceur). A cartel of separately-bonded *real*
operators who each do *real* work and collude is not stopped by any layer (see §5). The claim is
narrowly: *scripted* Sybils, *hardware* grinding, *fake* capacity, and *fake* work are each priced
above their gain.

---

## 5. Open problems — what is NOT solved (honest)

1. **Collusion among separately-bonded real operators (and bond-splitting committee capture).** If k of
   n K-of-N hosts are distinct real operators who each posted a real bond and each can do real work but
   agree off-chain to return the same wrong answer, beacon placement + per-identity bonds do *not* stop
   them. **Stronger than the prior draft admitted:** even a *single* operator splitting one bond across
   many keys raises the probability of capturing ≥K of a fixed committee (binomial tail, §2(b2)) — VRF
   Sybil-neutrality bounds only *expected* leadership, not committee capture. Mitigated (not eliminated)
   by the §2(b2) distinct-origin supermajority + bond floor + N≥4/K≥3, and by **demoting T2 to a latency
   optimization and defaulting to T3 fraud-proofs** (one honest verifier breaks the ring) or T5 zk. The
   irreducible residual: a cartel of separately-bonded real operators doing real work who collude is
   stopped only by T3 (needs one honest verifier) or T5 (collusion-proof), at higher cost.
2. **TEE trust is broken as proof.** TEE.Fail (Oct 2025) forges valid SGX/TDX/SEV-SNP quotes for
   <$1000; T4 proves code *identity*, not *correctness*, and reintroduces vendor trust against CE's
   no-lighthouse invariant. Use it only as a *reputation signal*, never standalone.
3. **zk is the only trustless tier and it is ~10^5–10^6× native** (zkML far worse), with the
   residual risk that a circuit bug forges proofs. Viable only for rare, high-value, un-re-runnable
   work — not the donate-compute common case.
4. **Bootstrap vs Sybil tension.** A fresh honest host has no reputation and almost no MeritRank
   edges (personalized walk sees nothing) — indistinguishable from a fresh Sybil. The only
   resolution is "forced to a high verification tier + slow low-reward vetting tunnel" (Storj's 100
   audits / 504h), which is a *cost and delay*, not a fix; a patient Sybil farm can still cycle
   identities through the tunnel (paying bond + tunnel-time each cycle). Reputation helps repeat
   counterparties, never first contact.
5. **Wash-trading is reduced, not eliminated; distinct-counterparty accounting is necessary-not-
   sufficient.** The 80% burn is a ~5× *one-time toll a patient whale pays*, not a deterrent at scale.
   The distinct-counterparty refinement must be **lineage-based + recursively MeritRank-weighted**
   (PeerId-distinctness is Sybil-farmable, §2(f)), and is a **prerequisite for Phase 8**, not a later
   hardening item. Until it lands, earned-weight/MeritRank may not relax any high-value tier. Residual:
   a whale that funds genuinely lineage-disjoint counterparties doing real fraud-proved work still earns
   real reputation — but then it is doing real, slashable, audited work, which is the point.
6. **Beacon/eclipse residual — and leader-bias of the placement beacon.** Confirmed-depth alone does
   **not** make placement unbiasable: the slot leader who *produces* the seed block can withhold/re-roll
   it (§2(b), red-team). Mitigated by **mandatory VDF + windowed + commit-reveal** placement beacon, but
   an *eclipsed* victim may still never see a fraud proof or the correct beacon — network hardening
   (gossipsub scoring, ≥3 relays, /24 caps) is necessary and currently design-only, and **must ship with
   Phase 8**, not after.
7. **Capacity audit is heuristic, never proof.** Continuous inline + parallel-full-capacity + job-bound
   challenges (§2(c)) defeat rent-burst and proxy *as deterrents*, but on-device benchmarks still do not
   cryptographically bind to silicon. A sufficiently determined attacker who keeps real silicon attached
   continuously is simply *owning* the capacity — which is the goal. Residual: bind-to-silicon is an
   open hardware-attestation problem (and TEE attestation is broken, §2(c)/H17, so it cannot help).
8. **TEE provides confidentiality only, never integrity or identity (TEE.Fail).** Excluded from
   reputation, bond, and `P(detect)`. No path to use it for assurance until a non-PCE-extractable
   hardware root exists.
9. **Calibration is empirical.** Bond size + floor `T_floor`, FaultFee fraction, correlation window +
   circuit-breaker, MeritRank α/β/γ, held-escrow schedule, VDF delay `T_vdf`, committee `N/K`, and the
   burn-vs-reporter split are *tuning, not theory* (Filecoin re-tuned via FIPs). Ship with conservative
   defaults and a path to re-tune on live data.

---

## 6. Phased rollout (extends the CE-TWLE consensus phases)

Phases 0–3 (settlement burn, HostBond/HostUnbond, SlashEquivocation, VRF+slot-spacing+weight) are
the *implemented* consensus foundation (consensus.md). This design adds:

- **Phase 4 — Wire the bond gate (a), with per-job slice-locking and a floor.** Bond gates
  `CapacityAd` + `UptimeReward`; capacity-proportional sizing **plus an absolute `T_floor`**; the
  **aggregate-exposure admission gate** (lock `slice_j = at_risk/P(detect)` per job — no rehypothecation);
  the single-job value ceiling `≤ bond × P(detect_current)`. *Highest leverage — closes V1/V3 cost floor
  AND the rehypothecation hole.* Interim until slice-locking lands: per-host concurrent-high-value cap = 1.
- **Phase 5 — Network hardening (net). MUST ship WITH or BEFORE Phase 8** (held-escrow forfeiture and
  disappearance-vs-eclipse depend on it). Gossipsub P4 then P5, conn limits, /24 caps, ≥3 relays
  (sybil-resistance.md §4.3); closes V8.
- **Phase 6 — Capacity audits (c, partial), CONTINUOUS not periodic.** `CapacityAd`/`ChallengeResponse`
  tx + **inline per-job throughput probes + parallel full-capacity challenges bound to the job session**
  + `SlashCapacityChallenge` (FaultFee, eclipse-safe). *Closes V3 as a deterrent.*
- **Phase 7 — Placement beacon + compute verification dial (b/c, full) + verification slashing (d).**
  **Mandatory VDF + windowed + commit-reveal placement beacon** (NOT optional, NOT mere confirmed-depth);
  the §2(b2) distinct-origin committee rules (N≥4/K≥3); T1 spot / T3 fraud-proof default (T2 demoted);
  **multi-winner + forced-error dispute rewards funded from burn/emission**; `JobResult` tx;
  `SlashVerificationFault` + structural-correlation multiplier + circuit-breaker; per-tier determinism
  (ML→deterministic-runtime-or-T5; within-band-only carve-out). *Closes V4/V5 — the core compute hole.*
- **Phase 8 — Held escrow + MeritRank (d, e). PREREQUISITE: distinct-counterparty earned-accounting (f)
  must land first.** Storj-style held balance (deterrent-only, value-capped, dispute-window-lagged,
  eclipse-safe release); MeritRank app-scorer over **fraud-proved/human-confirmed** edges only, feeding
  the verify-dial *downgrade* (capped, never below establishing tier) and P5. *Closes V7, bounds V6.*
- **Phase 9 — Hardening.** Lineage + recursive-MeritRank-weighted `earned_work_score`; ECVRF (RFC 9381);
  bind-to-silicon research; calibration on live data.

---

## 7. Red-team findings + resolutions (2026-06-24 audit)

A red team attacked the prior draft. Each finding below was triaged (real / dismissed), and confirmed
ones were fixed in the sections above. Sources verified against primary literature (see Sources at end).
**Triage verdict: 0 dismissed, 22 confirmed** — every finding pointed at a real over-claim or hole.

| # | Sev | Hole (short) | Verdict | Resolution (section) |
|---|-----|--------------|---------|----------------------|
| H1 | crit | Bond rehypothecated: one bond backs K concurrent jobs | **Confirmed** | §2(a) aggregate-exposure admission gate; lock `slice_j` per job (Akash per-lease); interim cap=1. Phase 4. |
| H2 | crit | T3 single-honest-verifier starvable/out-biddable by rich attacker | **Confirmed** (arXiv 2512.20864) | §2(c)(4) multi-winner + forced errors + ≥2 verifiers; T3 not sole tier for highest value. |
| H3 | high | Early-network cheap capture (bond scales down, T tiny) | **Confirmed** (block.science) | §2(a) absolute `T_floor`; gate high-value on `T>T_threshold`; correlation denom `max(T,T_floor)`; bootstrap = low-value. |
| H4 | high | VRF Sybil-neutral but not grind-neutral; leader biases placement beacon | **Confirmed** (arXiv 2109.07440) | §2(b) mandatory VDF + windowed placement beacon, separate from block-production stream. |
| H5 | high | Bond is rentable/recyclable → liquidity not net-worth | **Confirmed** (arXiv 2509.18338 impossibility) | §2(a) required endogenous held fraction; distinct bond≠earned credits; identity-transfer reset; claim restated as liquidity-at-risk. |
| H6 | med | 5× wash burn is a one-time toll a whale pays | **Confirmed** | §2(f) lineage + recursive-MeritRank earned-accounting; no high-value tier relaxation until it lands. |
| H7 | med | Capacity audit replayable/outsourceable (rent-burst, proxy) | **Confirmed** (io.net was SQLi, not a proof defeat) | §2(c) continuous inline + parallel-full-capacity + job-session-bound challenges; io.net citation corrected. |
| H8 | crit | Bond-splitting defeats committee selection (Sybil-neutrality conflation) | **Confirmed** (arXiv 2109.07440) | §2(b)/§2(b2): committee capture is a binomial tail, NOT `f`; distinct-origin supermajority + bond floor + N≥4/K≥3; T2 demoted. |
| H9 | crit | MeritRank circular against a self-auditing cluster | **Confirmed** (arXiv 2207.09950) | §2(e): reputation never lowers tier below the establishing tier; dial-downgrades only from T0/T3 edges; lineage connectivity-decay. |
| H10 | high | Auditor-is-the-jackpot-winner → in-cluster slash recycling | **Confirmed** (Truebit open problems) | §2(c)(5)+§2(d): burn ≥90%, reporter ≤10% (lower `SLASH_REPORTER_BPS`); lineage disqualification; auditor counter-bond. |
| H11 | high | Confirmed-depth fixes grinding but not leader-withheld bias | **Confirmed** (dup of H4/criticals) | §2(b)/§2(c)(1): mandatory VDF, not confirmed-depth alone; aggregate seed window; commit-reveal². |
| H12 | high | Correlation multiplier evaded by desync'd faults; weaponized for griefing | **Confirmed** | §2(d): structural (lineage/ASN) correlation, not temporal-only; distinct-origin `T`; circuit-breaker for real outages. |
| H13 | med | Held-escrow fixed-tenure schedule amortizable; no compute repair anchor | **Confirmed** (Storj docs) | §2(d): deterrent-only (no restitution); value-capped by forfeitable balance; distinct-counterparty release schedule; dispute-window lag. |
| H14 | med | Distinct-counterparty (the wash fix) is itself Sybil-farmable + only a TODO | **Confirmed** | §2(f): lineage + recursive-weight; prerequisite for Phase 8; "robust fix" claim withdrawn. |
| H15 | med | Determinism carve-out is a general cheat-cover for ML | **Confirmed** | §2(c) determinism: ML→deterministic-runtime-or-T5; within-band-only carve-out; referee-derived signed bands; slashable outside band. |
| H16 | crit | Fake capacity via rent-burst/proxy (V3 core) | **Confirmed** (dup of H7, escalated) | §2(c) capacity audit rewrite (continuous, job-bound, inline probes). |
| H17 | high | TEE (T4) forgeable for identity too, not just correctness | **Confirmed** (TEE.Fail, Oct 2025) | §2(c) T4 row + §2(e): confidentiality only; excluded from reputation/bond/`P(detect)`. |
| H18 | high | Held-escrow graceful-exit detection is eclipse/timing-gameable | **Confirmed** | §2(d): ≥3-relay multi-epoch unreachability before forfeiture; release lags dispute window; Phase 5 with/before Phase 8. |
| H19 | med | Aging is buyable → MeritRank can lower tier for "aged" hosts | **Confirmed** | §2(e): high-value jobs stay ≥T2/T3 regardless of age; downgrades tied to distinct-counterparty verified volume, not age. |
| H20 | crit | Same as H9 (committee-fed reputation laundering) | **Confirmed** (dup H9) | §2(e) loop-break (3 fixes). |
| H21 | crit | Multi-winner / forced-error needed for T1/T3 economic engine | **Confirmed** (dup H2, full fix) | §2(c)(4) full multi-winner calibration `D_p ≥ c̃·A/(1−η)`; burn/emission-funded. |
| H22 | med | Bond `P(detect)` denominator is attacker-chosen via reputation | **Confirmed** | §4 + §2(a): use `P_min(detect)`; cap single-job value at `bond × P(detect_current)`. |

**Net effect on the security claim.** No finding was dismissed. The corrections do **not** weaken the
design's reach — they make its *claim honest*: the design now prices Sybil at
`f · max(TotalBondedStake, T_floor) · 1/(1−P_min(detect))` of **liquidity-at-risk** (not net worth),
with committee capture explicitly governed by a binomial tail (mitigated by distinct-origin rules, not
eliminated), T2 demoted from a security tier to a latency optimization, T3 the default for value above
trivial (with multi-winner forced-error rewards), TEE confined to confidentiality, and the bond locked
per-job against aggregate exposure. The residual unsolved set is §5 problems 1 (real-operator collusion /
bond-split capture), 3 (zk cost), 4 (bootstrap-vs-Sybil), 5 (wash-trade patience), 6 (beacon/eclipse),
7 (capacity bind-to-silicon), 8 (TEE confidentiality-only), 9 (calibration) — all *assumption-bounded*,
not silently-broken.

---

### Sources verified in the 2026-06-24 red-team audit

- (Im)possibility of Incentive Design for Challenge-based Blockchain Protocols — arXiv 2512.20864
  (single-winner challenge designs cannot jointly incentivize honest challengers + deter fraud;
  multi-winner escapes it). https://arxiv.org/abs/2512.20864
- TEE.Fail / WireTap (Oct 2025) — DDR5 bus interposition extracts ECDSA attestation keys, forges valid
  Intel TDX / SGX / AMD SEV-SNP quotes passing DCAP at top trust tier, <$1000. https://tee.fail/ ,
  https://wiretap.fail/
- Private Attacks in Longest-Chain PoS — arXiv 2109.07440 (stake-splitting / SSLE grinding raises attack
  surface; expected-leadership neutrality ≠ committee-capture neutrality). https://arxiv.org/abs/2109.07440
- On Sybil-proofness in Restaking Networks — arXiv 2509.18338 (impossibility: no slashing mechanism deters
  both attack types; heterogeneous topology makes Sybil profitable). https://arxiv.org/abs/2509.18338
- MeritRank — arXiv 2207.09950 (Sybil-tolerant not Sybil-proof; bound empirical ~1.5–2.5×; requires every
  edge back a real transaction; epoch decay did not improve tolerance). https://arxiv.org/abs/2207.09950
- Truebit (forced errors / verifier's dilemma) — https://people.cs.uchicago.edu/~teutsch/papers/truebit.pdf ,
  Open Problems wiki (solver-runs-many-verifiers jackpot capture). https://github.com/TruebitProtocol/wiki/wiki/Open-Problems
- Akash per-lease escrow (lock per lease/bid, not permanent collateral). https://akash.network/docs/learn/core-concepts/providers-leases/
- io.net Apr-2024 incident was a SQL-injection on a centralized metadata DB (write-API token reuse), NOT a
  defeat of a capacity proof. https://cointelegraph.com/news/io-net-responds-to-gpu-metadata-attack

---

## 8. Appendix — `ce-seed` download app (DEMO, not the security core)

> **This is a demonstration app, explicitly NOT part of the compute-security core.** It exists to
> show the *same primitives* exercised end-to-end against a problem (content distribution) where the
> artifact is *persistent and cheaply re-challengeable* — i.e. the **storage** case, which is
> genuinely easier than compute. Treat it as a confidence-building reference, not a security claim
> about compute.

**`ce-seed`** — a BitTorrent-shaped content-delivery app on CE primitives:
- **Content-addressed blobs** (CE blob primitive): a file is a Merkle-DAG of chunks keyed by hash;
  the root hash is the content ID. Retrieval is self-verifying (you got the right bytes or you
  didn't) — the storage property compute lacks.
- **Payment-channel receipts** (CE `/channels`): a downloader opens a channel to a seeder and signs
  an off-chain receipt per chunk delivered (`POST /channels/receipt`); the seeder redeems the
  highest receipt on close. Micropayment-per-chunk, settled once on-chain — Sia's off-chain
  download-incentive pattern, done with CE's existing channels.
- **Bond-backed availability audits** (layers a+c+d, in *easy mode*): a seeder advertising it holds
  blob `H` posts a small `HostBond`; a `/beacon`-seeded challenge demands a random chunk's Merkle
  branch (this is the *cheap repeatable storage challenge* — Filecoin WindowPoSt / Storj audit /
  Sia PoR). Failure ⇒ FaultFee. Here the audit is near-free and unboundedly repeatable, which is
  *exactly* why it does not generalize to compute — the appendix makes the asymmetry concrete.
- **MeritRank reputation** (layer e): seeders accrue reputation from distinct downloaders'
  signed receipts; the same decayed personalized walk ranks them; freeloaders/fake-seeders are
  discounted.

The point of the demo: every primitive in the security core (bond, beacon-seeded challenge, slash,
channel receipts, MeritRank) is real and composable *today* in the easy (storage) setting — so the
hard (compute) setting differs only in the **audit tier required**, exactly as §2(c) argues.
