I now have comprehensive, citable material across all five domains plus the two extra (Storj, Render). I have enough to synthesize a specific, well-cited report. Writing the final output now.

---

# Share-Ratio & Credit Economies in P2P Networks — Research for a "Compute Share Ratio" (CE)

This surveys how peer-to-peer systems measure contribution vs. consumption, how that gates priority/access, how they resist cheating, and how they treat newcomers and time-decay. Each section ends with the concrete, transferable mechanism. A consolidated **Recommendations for CE** follows.

---

## 1. BitTorrent private-tracker ratio systems

**How ratio is computed & displayed.** The core metric is dead simple and shown prominently on every user profile: `Ratio = Total Uploaded / Total Downloaded` (cumulative bytes over the account's lifetime). Most private trackers require a **minimum overall ratio between 0.5 and 1.0**, with falling below the threshold triggering escalating consequences: warnings → download throttling/disable → account suspension. Community best practice is to keep a **buffer** by targeting 1.5–2.0:1 so a large new download doesn't push you under. ([pulsedmedia wiki](https://wiki.pulsedmedia.com/wiki/Private_tracker), [rapidseedbox](https://www.rapidseedbox.com/blog/torrent-ratio-tips))

**Freeleech (demand-side discount).** Torrents flagged freeleech don't count downloaded bytes against your ratio, **but uploaded bytes still count 100%**. Trackers run graduated versions — **30% / 50% / 100% ("free")** freeleech — where only that fraction of your download is debited while upload always credits fully. Used during launches/holidays to push fresh content into wide replication. ([pulsedmedia wiki](https://wiki.pulsedmedia.com/wiki/Private_tracker), [rapidseedbox](https://www.rapidseedbox.com/blog/torrent-ratio-tips))

**Bonus / seedbonus points (rewarding idle availability, not just throughput).** This is the key innovation. Trackers award **bonus points for time spent seeding**, accruing per-torrent per-hour, typically scaled by how many torrents you seed and sometimes by torrent age/swarm size (more points for seeding rare old content nobody downloads). Crucially, **points can be exchanged for upload credit** — improving your ratio *without any actual upload traffic occurring*. This decouples "reward" from "did someone happen to download from me," so contributors who keep rare data alive aren't punished for low demand. (RuTracker's time-bonus system is a documented example.) ([pulsedmedia wiki](https://wiki.pulsedmedia.com/wiki/Private_tracker), [FILEnetworks/RuTracker](http://filenetworks.blogspot.com/2010/04/rutrackerorg-time-bonus-system-news.html))

**Hit-and-run (HnR) rules (per-object obligation, not just global ratio).** Beyond the global ratio, trackers enforce a *per-torrent* seeding obligation: for each thing you download you must either **reach 1:1 on that torrent OR seed it for a minimum time** — commonly **24–72 hours**, with strict trackers requiring up to **336 hours (14 days)**. Accumulating too many HnR strikes restricts or bans you even if your global ratio is fine. This prevents "grab-and-go" where a user keeps a healthy aggregate ratio but never actually serves the specific content they consumed. ([pulsedmedia wiki](https://wiki.pulsedmedia.com/wiki/Private_tracker), [rapidseedbox](https://www.rapidseedbox.com/blog/torrent-ratio-tips))

**Why it works (measurement evidence).** Private trackers with ratio enforcement empirically show dramatically better seeder/leecher ratios, longer seeding times, and far less free-riding than public trackers — the enforced accounting changes behavior. ([Chen et al., P2P 2010 measurement study](https://www.comp.hkbu.edu.hk/~chxw/p2p_2010.pdf))

> **Transferable:** (a) a single, visible lifetime ratio with a hard floor that gates access; (b) a buffer culture so the floor isn't a cliff; (c) demand-side discounts (freeleech) where the *cost side* is waived but the *contribution side* still credits; (d) **time-based bonus points convertible to credit** so availability is rewarded independent of realized demand; (e) **per-object hit-and-run obligations** layered on top of the global ratio.

---

## 2. Tit-for-tat: the choking algorithm & its strategic exploitation

**The mechanism.** A BitTorrent leecher has a small number of **upload slots (~4)**. Every **10 seconds** it ranks interested peers by the **download rate it received from them over a rolling ~20-second window**, and unchokes (uploads to) only the top few — this is **reciprocity / tit-for-tat**: you serve those who serve you fastest, and choke (refuse) everyone else. ([Arpit / choke algorithm](https://arpit.substack.com/p/the-choke-algorithm-that-powers-bittorrent), [Mislove CS4700 lecture](https://mislove.org/teaching/cs4700/spring11/lectures/lecture20.pdf))

**Newcomer bootstrap = optimistic unchoke.** Every **30 seconds** a peer unchokes **one extra peer at random**, regardless of reciprocation. This is how a node with *nothing to offer yet* gets its first pieces and enters the trade economy — the explicit "grace for newcomers" mechanism. Anti-snubbing logic also re-optimistic-unchokes if a peer stops sending. ([Arpit](https://arpit.substack.com/p/the-choke-algorithm-that-powers-bittorrent))

**The exploit (BitTyrant).** The reciprocity is *self-reported / rate-inferred*, not cryptographically proven, and the default splits bandwidth roughly equally among unchoked peers. **BitTyrant** exploits this: it strategically allocates just enough upload to each peer to stay in their top slots, no more, and skims the **altruism leaked by optimistic unchokes**. Measured result: **~70% median performance gain for a 1 Mbit client** on live swarms while contributing *less*. Lesson: an incentive system based on **inferred, unverified contribution and unconditional altruism to newcomers is gameable**. Proposed hardenings (block-based tit-for-tat, PropShare proportional response) reduce but don't eliminate it without verification. ([Building Better Incentives for Robustness in BitTorrent, arXiv:1108.2716](https://arxiv.org/pdf/1108.2716); [BitTyrant via researchgate measurement study](https://www.researchgate.net/publication/220292257_Revisiting_free_riding_and_the_Tit-for-Tat_in_BitTorrent_A_measurement_study))

> **Transferable:** reciprocity + a small **unconditional newcomer allowance** bootstraps cold-start, but **never base the allowance or the contribution score on self-reported/unverified metrics** — cap the free altruism, and verify the work.

---

## 3. Decentralized storage: proofs + collateral + slashing

These systems answer "how do you reward contribution you can't see?" with **cryptographic proofs** and **economic bonds**, not trust.

### Filecoin
- **Proofs:** *Proof-of-Replication (PoRep)* proves a unique physical copy was stored at sealing time; *Proof-of-Spacetime (PoSt)* proves continued storage over time. **WindowPoSt** challenges every sector on a recurring proving period; failure to answer = the data isn't really there. ([Filecoin docs – proofs](https://docs.filecoin.io/basics/the-blockchain/proofs), [Coinbase tokenomics review](https://www.coinbase.com/en-de/institutional/research-insights/research/tokenomics-review/filecoin-fil-dissecting-storage-market-incentives))
- **Collateral:** providers **pledge FIL collateral proportional to committed storage power** before they can earn. Skin in the game scales with claimed capacity. ([Coinbase review](https://www.coinbase.com/en-de/institutional/research-insights/research/tokenomics-review/filecoin-fil-dissecting-storage-market-incentives))
- **Slashing (graduated by severity):**
  - **Fault fee** — charged per day a sector is offline, **≈3.51 days of expected block rewards**, until recovered or the wallet empties. ([Filecoin slashing docs](https://docs.filecoin.io/provide-storage/filecoin-economics/slashing))
  - **Sector penalty** — for an undeclared fault caught by a WindowPoSt check.
  - **Termination fee** — when a sector is permanently lost/terminated.
  - **Consensus-fault slashing** — for attacking consensus.
  - Slashed collateral is **burned** (sent to a burn address) and the provider's storage power drops. Honest providers who recover quickly face no penalty — penalties target *sustained* failure. ([Filecoin slashing docs](https://docs.filecoin.io/provide-storage/filecoin-economics/slashing))

### Storj (reputation/audit instead of heavy on-chain collateral)
- **Cheap Sybil cost:** a small proof-of-work identity makes node creation non-free. ([Storj v3 whitepaper](https://github.com/storj/whitepaper/blob/main/storjv3.tex))
- **Vetting period for newcomers:** new nodes get only a trickle of data and **elevated audit frequency** until they prove reliable — explicit newcomer probation rather than newcomer *grace*. ([Storj whitepaper](https://github.com/storj/whitepaper/blob/main/storjv3.tex))
- **Audit score & disqualification:** random cryptographic audits ask the node to return an erasure share; the **audit score must stay above 96% or the node is permanently disqualified**. A separate online/suspension score handles downtime. ([Storj satellite reputation pkg](https://pkg.go.dev/storj.io/storj/satellite/reputation), [audit-suspend blueprint](https://github.com/storj/storj/blob/6c34ff64adde51c5d819b2800ef1e59f67f75f0e/docs/blueprints/audit-suspend.md))
- **Held amount (escrow against exit):** for roughly the **first 9 months**, the satellite **withholds a portion of earnings** as a fund to pay for repairing data if the node disappears — graduated payback rewards longevity and punishes early exit. ([Storj whitepaper](https://github.com/storj/whitepaper/blob/main/storjv3.tex))
- **Preference, not binary access:** audit history feeds a **preference system** — better nodes get *more* data, worse nodes get less, before any hard cutoff. ([Storj whitepaper](https://github.com/storj/whitepaper/blob/main/storjv3.tex))

### Sia
- Storage is governed by **file contracts** with both a host *and renter* posting collateral; the host must submit a **storage proof** before the contract window closes or it forfeits payment+collateral. (Same proof-or-forfeit pattern; [comparison overview](https://medium.com/@naeemulhaq/decentralized-cloud-storage-with-blockchain-a-technical-comparison-of-filecoin-storj-and-ipfs-e455f7a7d42b))

> **Transferable:** verify contribution with **challenge/response proofs**, not self-report; require **collateral scaled to claimed capacity**; make slashing **graduated by severity and duration** (transient fault ≪ permanent loss ≪ malicious); use a **held-amount escrow** that vests over time to deter hit-and-run exit; **vet newcomers with elevated scrutiny + a trickle of work** rather than full unconditional access; prefer a **soft preference ranking** (more work to better nodes) over a binary gate until a hard floor is breached.

---

## 4. Compute marketplaces: pricing + reputation + audited attributes

### Akash (reverse auction + on-chain attestation)
- **Reverse auction:** the *tenant sets price/terms* in an SDL manifest → providers **bid** → tenant picks a winner → an on-chain **lease** forms. Settlement is **passive escrow**: the tenant funds a deposit, the provider draws per-block payment, and either side can close when the deposit drains. ([Akash marketplace glossary](https://github.com/ovrclk/docs/blob/master/glossary/marketplace.md))
- **Bid deposit (anti-spam skin-in-game):** each bid requires a refundable **`bid_min_deposit` (50 AKT)**, returned when the bid closes — cheap to bid honestly, costly to spam. ([Akash glossary](https://github.com/ovrclk/docs/blob/master/glossary/marketplace.md))
- **Audited attributes (decentralized reputation):** providers advertise attributes (region, hardware, compliance); **any party can sign/attest these on-chain**, and tenants filter to "only providers attested by auditor X." Reputation is thus **portable, multi-source, and tenant-selectable**, not a single central score. Provider misbehavior risks staked AKT. ([Akash glossary](https://github.com/ovrclk/docs/blob/master/glossary/marketplace.md), [StorageReview](https://www.storagereview.com/review/akash-network-ushering-in-decentralized-cloud-computing))

### Render (standardized work unit + reputation-gated capacity + tiers)
- **Standardized work unit:** all work is priced in **OctaneBench-hours (OBh)** — a benchmarked, hardware-normalized unit so a "unit of compute" means the same across heterogeneous GPUs. This is the analog of a *credit denominated in normalized work*. ([Render KB – OctaneBench](https://know.rendernetwork.com/getting-started/render-network-tutorials/using-octanebench-2025-to-benchmark-your-gpu-and-estimate-render-costs), [Render whitepaper](https://framerusercontent.com/modules/assets/Wa2lC0JcjksdQEKLA1PAvTHXe3Y~o---EuM8cIAdZuUrwHjJw7JcrKvj9afAV9nk7wmVsbo.pdf))
- **Two-sided reputation gating capacity:** both creators *and* node operators carry reputation from on-platform history. **Higher creator reputation unlocks more concurrent GPUs/providers**; **node-operator reputation rises with successful completions weighted by job complexity** (hard jobs done well boost it more), and feeds job allocation alongside benchmark and availability. ([Render whitepaper](https://framerusercontent.com/modules/assets/Wa2lC0JcjksdQEKLA1PAvTHXe3Y~o---EuM8cIAdZuUrwHjJw7JcrKvj9afAV9nk7wmVsbo.pdf), [Messari](https://messari.io/report/understanding-the-render-network-a-comprehensive-overview))
- **Speed/price tiers:** explicit service tiers — Tier 2 ≈ **2–4×** and Tier 3 ≈ **8–16×** the price of Tier 1 — letting users trade cost vs. priority/security. ([Render pricing](https://rendernetwork.com/pricing), [Render KB – tiers](https://know.rendernetwork.com/getting-started/how-to-get-started/select-rndr-tier))

### Golem
- Provider/requestor matching via a **demand/offer specification language** and bidding; documented weakness is that **getting the bid price right is hard and underbid jobs may never complete** — a cautionary note that pure open bidding without reputation/SLA backing is fragile. ([Golem spec docs](https://golem-network.gitbook.io/golem-internal-documentation-test/demand-and-offer-specification-language/golem-demand-and-offer-specification-language), [Golem vs Render](https://medium.com/trusteddapps/golem-network-vs-render-farms-7a1101bda79c))

> **Transferable:** denominate everything in a **hardware-normalized work unit** (CE's normalized credit); use **two-sided reputation** (consumers earn standing too); let **reputation unlock concurrency/priority** rather than just gating yes/no; support **explicit price/priority tiers**; require a **refundable bid/job deposit** to kill spam cheaply; make reputation **multi-source and attestable** (anyone can sign an attribute) rather than a single central authority.

---

## 5. Bittensor / Yuma Consensus — stake-weighted scoring resistant to collusion

The most directly relevant model for "how do you score contribution when the scoring itself can be gamed." Validators rate miners; **Yuma Consensus** turns many subjective ratings into one robust aggregate. ([Yuma docs](https://docs.learnbittensor.org/learn/yuma-consensus), [subtensor consensus.md](https://github.com/opentensor/subtensor/blob/main/docs/consensus.md))

- **Stake-weighted aggregation:** miner rank `R_j = Σ_i (S_i · W̄_ij)` — each validator's vote is weighted by stake `S_i`. ([Yuma docs](https://docs.learnbittensor.org/learn/yuma-consensus))
- **Stake-weighted median + clipping (the anti-collusion core):** for each miner a **consensus benchmark** is set to *the highest weight supported by at least a fraction κ (default 0.5) of total stake*, and any validator's weight above it is **clipped**: `W̄_ij = min(W_ij, W̄_j)`. So a minority-stake clique **cannot pump (or dump) a miner beyond what a κ-majority of stake agrees with** — outlier scores are mathematically capped. The system is provably adversarially-resilient while majority stake is honest. ([Yuma docs](https://docs.learnbittensor.org/learn/yuma-consensus), [arXiv critical analysis](https://arxiv.org/html/2507.02951v1))
- **Bonds with EMA smoothing (reward early honest discovery, punish flip-flopping/copying):** a validator accrues a **bond** to miners it backs; bonds update as an exponential moving average `B_ij(t) = α·ΔB_ij + (1−α)·B_ij(t−1)`. Validator dividends `V_i = Σ_j B_ij·M_j` pay out *when miners they bonded to early later succeed*. This **rewards validators who consistently align with eventual consensus over time** and penalizes those who deviate or lazily copy others' weights at the last moment. ([Yuma docs](https://docs.learnbittensor.org/learn/yuma-consensus))
- **Permissioned weight-setting by stake:** only neurons above a **minimum stake** and in the **top-K by stake** get a *validator permit* to set non-self weights and earn bonds — raising the cost of acquiring scoring influence. ([Validating in Bittensor](https://docs.learnbittensor.org/validators), [weight-copying problem](https://docs.learnbittensor.org/concepts/weight-copying-in-bittensor))

> **Transferable:** when reputation/quality is subjectively scored, aggregate scores by a **stake-weighted (or trust-weighted) median and clip outliers at a κ-supermajority benchmark** so small colluding groups can't move a node's score; use **EMA-smoothed standing** so reputation reflects *consistent* behavior and is slow to game; require **stake/standing to qualify as a rater** at all.

---

## Cross-cutting patterns (the transferable toolkit)

| Concern | Pattern that recurs across systems |
|---|---|
| **Measure contribution** | Either a hard accounting ledger (BitTorrent ratio bytes) **or** cryptographic challenge-proofs (Filecoin PoSt, Storj audits). Never trust self-reported rates (BitTyrant lesson). |
| **Normalize the unit** | Hardware-normalized work unit (Render OBh) so 1 credit = 1 standardized unit of compute regardless of who served it. |
| **Display** | One prominent number (ratio / audit score / reputation) on the node's profile, with a known floor. |
| **Gate priority/access** | Soft → hard: preference ranking (Storj, Render reputation→concurrency) before a binary cutoff; tiers for explicit price/priority trade-offs (Render). |
| **Anti-cheat** | Skin-in-game collateral scaled to claimed capacity (Filecoin) + refundable bid deposit (Akash) + random verifiable audits (Storj) + stake-weighted-median-with-clipping for subjective scores (Yuma). |
| **Newcomer grace** | Bounded & supervised: optimistic unchoke (BitTorrent), vetting period with elevated audits + trickle of work (Storj). Never unbounded free access. |
| **Decay / longevity** | EMA-smoothed standing (Yuma); held-amount escrow vesting over ~9 months (Storj); per-object seeding-time obligations & HnR strikes (BitTorrent); fault fees that grow with duration offline (Filecoin). |
| **Reward availability ≠ realized demand** | Seedbonus time-points convertible to credit (BitTorrent) — pay for *being available to serve*, not only for serving. |

---

## Recommendations for CE

CE already has the substrate these mechanisms need: a PoW ledger with `u128` base-unit credits, `UptimeReward`, `JobBid`/`JobSettle`/`Heartbeat`, `BurnProof`, the per-node `/history/:node_id` reputation substrate, the `/atlas` capacity view, and a capability-chain trust model. A "compute share ratio" should be a **derived, displayed signal computed from existing on-chain history**, used to gate priority and verification intensity — *not* a new trust root (capabilities remain the only authorization primitive).

1. **Define the ratio in normalized credit-work, ledger-backed (not self-reported).**
   `compute_ratio = credits_earned_by_serving / credits_spent_consuming`, computed from `JobSettle` (served) vs `JobBid` (consumed) and `UptimeReward`, summed in base units. Because both legs are already on-chain (BitTorrent's "trust the accounting" model, not BitTyrant's "trust the rate report"), it's cheat-resistant by construction. Denominate consumed/served in a **hardware-normalized compute unit** (Render OBh analog) so a CPU-second and a GPU-second are comparable — surface this as a benchmark field in the `/atlas` capacity advert.

2. **Display one number; make the floor soft, not a cliff.** Show `compute_ratio` in `ce status` and on `/status` / `/history/:node_id` alongside a rolling 30-day view. Don't hard-block at the floor; instead **bias host selection in `ce deploy` / `/mesh-deploy` toward requesters who maintain ratio ≥ ~1.0** and let low-ratio requesters still run, just at lower scheduling priority and higher price — Storj's *preference* model beats a binary gate.

3. **Reward availability independent of realized demand (seedbonus analog).** CE already pays `UptimeReward`; treat that as the bonus-point mechanism, but **weight it by advertised, audited capacity actually held ready to serve**, not just liveness — so a node idling with a free GPU advertised in `/atlas` earns standing even when no jobs land, exactly as seedbonus rewards seeding rare torrents nobody downloads. This stops penalizing honest hosts in low-demand regions.

4. **Per-job obligation layered over the global ratio (hit-and-run defense).** A requester who repeatedly bids jobs, consumes a host's setup cost, and kills them early (`/mesh-kill` / `DELETE /jobs/:id`) should accrue an **HnR-style strike** in `/history`. Mirror BitTorrent: each accepted lease carries a minimum-billing or completion expectation (you already have 30s `Heartbeat` intervals — bill a minimum N intervals), and excessive early-kills throttle a requester's concurrency.

5. **Verify before you trust the contribution (proof-or-forfeit, graduated).** For the "served credit" leg, don't pay `JobSettle` on the host's word — adopt CE's **verification dial** (per the sybil-resistance doc) as a Filecoin/Storj-style audit: a fraction of jobs get re-executed/attested, and a host that fails an audit has its **earned standing slashed graduated by severity** (one transient miss ≪ repeated misses ≪ provably faked output). Tie this to a **capacity-scaled bond**: a host advertising large capacity in `/atlas` posts proportionally more collateral, redeemable only after honest service — Filecoin's pledge-proportional-to-power.

6. **Held-amount escrow vesting over time (anti hit-and-run exit + decay).** When a node first starts earning, **vest a fraction of its serving rewards over a window** (Storj's ~9-month held amount), released as it accumulates clean audit history. Combined with **EMA-smoothed standing** (Yuma), this makes reputation slow to build, slow to fake, and self-decaying if the node goes quiet — so an attacker can't spin up, burst-earn standing, defect, and exit cheaply.

7. **Bounded, supervised newcomer grace (not unconditional altruism).** Cold-start nodes need their first jobs to bootstrap. Give them a **capped newcomer allowance** (optimistic-unchoke analog) — a small amount of priority/credit to get going — but pair it with Storj-style **elevated audit frequency and a trickle of low-value work during a vetting period**. The BitTyrant lesson: keep the free allowance *bounded* and *verified*, because unbounded grace is exactly what strategic clients farm.

8. **For any subjective/peer-reported quality scores, use stake/trust-weighted median with clipping (Yuma).** If CE ever aggregates peer ratings of host quality (latency, correctness votes) into `/history`, **weight raters by earned standing, take the median, and clip outliers at a κ≈0.5 supermajority benchmark**, with EMA smoothing. This makes a small Sybil/collusion ring unable to pump or tank a node's reputation — directly aligns with CE's existing 3-pillar Sybil defense and the rule that trust must be *earned, non-sellable*.

9. **Anti-spam deposit on bids (Akash).** Make `POST /jobs/bid` (and host-side bidding, if hosts bid into a reverse auction) carry a **small refundable credit deposit**, returned on lease close. Near-free for honest use, linearly expensive for flooding — cheaper and simpler than rate-limiting, and already natural given credits are escrowed at bid time.

10. **Expose ratio/standing as attestable, multi-source attributes (Akash audited attributes), gated by capabilities — not a central score.** Rather than one authoritative reputation number, let parties **sign attestations** about a node (benchmarked capacity, audit pass rate, region) that requesters filter on, anchored to capability roots. This keeps CE's "capabilities are the only authorization primitive" invariant intact while giving the marketplace a portable, decentralized reputation layer.

**Net:** CE's "compute share ratio" should be a **ledger-derived, normalized earn/spend ratio**, *displayed* as one number, *softly* biasing scheduling priority and price tiers, *defended* by capacity-scaled bonds + audited verification + a vesting held-amount + stake-weighted-median scoring, and *opened to newcomers* through a bounded, supervised grace window — borrowing the accounting rigor of private trackers, the proof-or-slash discipline of Filecoin/Storj, the normalized-unit + two-sided-reputation + tiers of Render/Akash, and the collusion-resistant aggregation of Yuma Consensus.

### Key sources
- BitTorrent ratio/freeleech/bonus/HnR: [pulsedmedia wiki](https://wiki.pulsedmedia.com/wiki/Private_tracker), [rapidseedbox](https://www.rapidseedbox.com/blog/torrent-ratio-tips), [RuTracker time-bonus](http://filenetworks.blogspot.com/2010/04/rutrackerorg-time-bonus-system-news.html), [Chen et al. P2P 2010](https://www.comp.hkbu.edu.hk/~chxw/p2p_2010.pdf)
- Choke algorithm / BitTyrant: [choke algorithm](https://arpit.substack.com/p/the-choke-algorithm-that-powers-bittorrent), [Mislove lecture](https://mislove.org/teaching/cs4700/spring11/lectures/lecture20.pdf), [Robustness in BitTorrent (arXiv:1108.2716)](https://arxiv.org/pdf/1108.2716), [free-riding/TFT measurement](https://www.researchgate.net/publication/220292257_Revisiting_free_riding_and_the_Tit-for-Tat_in_BitTorrent_A_measurement_study)
- Filecoin: [proofs](https://docs.filecoin.io/basics/the-blockchain/proofs), [slashing](https://docs.filecoin.io/provide-storage/filecoin-economics/slashing), [Coinbase tokenomics review](https://www.coinbase.com/en-de/institutional/research-insights/research/tokenomics-review/filecoin-fil-dissecting-storage-market-incentives)
- Storj: [v3 whitepaper](https://github.com/storj/whitepaper/blob/main/storjv3.tex), [satellite reputation pkg](https://pkg.go.dev/storj.io/storj/satellite/reputation), [audit-suspend blueprint](https://github.com/storj/storj/blob/6c34ff64adde51c5d819b2800ef1e59f67f75f0e/docs/blueprints/audit-suspend.md)
- Akash: [marketplace glossary](https://github.com/ovrclk/docs/blob/master/glossary/marketplace.md), [StorageReview](https://www.storagereview.com/review/akash-network-ushering-in-decentralized-cloud-computing)
- Render: [whitepaper](https://framerusercontent.com/modules/assets/Wa2lC0JcjksdQEKLA1PAvTHXe3Y~o---EuM8cIAdZuUrwHjJw7JcrKvj9afAV9nk7wmVsbo.pdf), [OctaneBench KB](https://know.rendernetwork.com/getting-started/render-network-tutorials/using-octanebench-2025-to-benchmark-your-gpu-and-estimate-render-costs), [tiers](https://know.rendernetwork.com/getting-started/how-to-get-started/select-rndr-tier), [Messari](https://messari.io/report/understanding-the-render-network-a-comprehensive-overview)
- Golem: [spec language](https://golem-network.gitbook.io/golem-internal-documentation-test/demand-and-offer-specification-language/golem-demand-and-offer-specification-language)
- Bittensor/Yuma: [Yuma consensus](https://docs.learnbittensor.org/learn/yuma-consensus), [subtensor consensus.md](https://github.com/opentensor/subtensor/blob/main/docs/consensus.md), [validating](https://docs.learnbittensor.org/validators), [weight-copying](https://docs.learnbittensor.org/concepts/weight-copying-in-bittensor), [critical analysis (arXiv:2507.02951)](https://arxiv.org/html/2507.02951v1)