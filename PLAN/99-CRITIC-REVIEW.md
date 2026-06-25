This is a synthesis/review task — no skills apply, and I have everything in the prompt. Let me produce the adversarial review directly.

# Coverage check

| Requested item | Covered? | Where / Gap |
|---|---|---|
| **Notes app** | Yes | `ce-notes` workstream, Wave 2. Complete: E2E-encrypted Yjs CRDT over ce-coord, attachments via blobs, sharing-by-capability. Solid. |
| **Auto-sync** | Partial | `autosync` (rdev v2), Wave 2. The engine is well-specced, BUT it is **post-launch** and **not in the MVP**. The user asked for auto-sync as a headline feature; the plan demotes it to Wave 2 behind a circular dependency it admits is wrong (risk #5). The thing the user wants most is sequenced late and tangled. |
| **Hosting UI ("torrenting for compute")** | Yes | `hosting-ui` / CE Host, Wave 1, in MVP. Tagline literally "qBittorrent for compute." Best-covered item. |
| **Proper TOKEN MANAGEMENT** | Yes, strong | `token-mgmt`. Credit wallet + capability wallet + the key-backup gap (the genuinely most important fix) caught and pulled to Wave 0. This is the strongest part of the plan. |
| **Torrent-style RATIO system** | Yes, with caveat | `ratio` / `ce-ratio`, Wave 1, in MVP. BUT v1 is explicitly a *recency proxy, not a real ratio* — `earned/spent` cumulative with a `last_height` decay. A torrent ratio is volume-over-window; shipping a cumulative number and calling it a "share ratio" is a semantic bait-and-switch the user may notice. See risk below. |
| **Real DEMOS of the CE API frameworks** | Yes | `demos`, Wave 1 (playground Wave 2). 11 recipes, CI-gated executable examples, playground. Well covered. Caveat: GPU recipe is compile-only without a GPU runner — honestly flagged. |
| **Typed APIs in TS/JS** | Yes | `@ce-net/sdk` (ts-sdk), Wave 0. Foundation. Good. |
| **"More use-cases and ways to use the mesh"** | **Weak / deferred** | `usecases` portfolio (pin/cache/expose/render/ci) is **entirely Wave 3, entirely post-launch, all XL effort**. The user explicitly asked for more mesh use-cases; the plan parks all five behind everything else and ships *zero* of them in the MVP. The mesh-breadth ask is acknowledged but effectively deferred indefinitely. The MVP has no new mesh use-case at all beyond the existing job system. |

**Net:** 5 of 8 asks land cleanly. **Auto-sync is demoted**, **ratio is approximated**, and **"more mesh use-cases" is fully deferred**. Two of those three (auto-sync, mesh use-cases) were explicit user priorities, not nice-to-haves.

# Architecture violations or smells

1. **CORS as "arguably-primitive" is a fudge — but the conclusion is correct.** Read-only localhost CORS on GET/SSE is fine and *is* legitimately node-level (it's a property of the transport surface, not host-resource mutation). No violation. But the plan repeatedly hand-waves it as "arguably a primitive"; just commit — it's a primitive-adjacent transport config, land it, stop apologizing.

2. **Browser write-path auth is under-designed and risks a boundary violation later.** The plan says browser mutating calls go through a "token-callback / ce-hub sidecar." That's correct in spirit, but there is a latent pressure to add a node-side browser-auth endpoint when the sidecar proves annoying. **Pre-commit to NEVER putting a credential-minting or `/key/*` endpoint on the node.** The plan does refuse `/key/export` (good) but doesn't generalize the rule. Smell, not yet a violation.

3. **ce-expose relay public HTTP ingress is the one real boundary stressor — and it's mislabeled "the only node change."** Mapping a public hostname → mesh stream on the relay is a genuine new primitive-ish capability with an abuse surface (phishing/malware on ce-net.com). It's correctly isolated to Wave 3 and gated, but the plan calls it "infra" to dodge the boundary question. Be honest: this is a **new relay-tier primitive**, it changes CE's trust/operational policy, and it should get a design doc and a security review *as a primitive*, not slipped in as "infra."

4. **Money rule: honored.** `Amount` as bigint backing decimal-string base units in the SDK is exactly right. No float leaks. Good.

5. **Capability-only trust: mostly honored, one smell.** CE Host's "Grants panel can only show grants made through this UI" is a direct, honest consequence of the no-allowlist model (tokens live with grantees). Fine. But the ratio system **gating scheduling** is a soft re-introduction of reputation-as-authorization. That's allowed (it's app-tier scheduling policy, not node authorization), but the plan must state loudly that **ratio never gates capability verification** — it only ranks/orders. If `ce-ratio` ever becomes an input to `ce-cap`, that's a violation. Flag it now.

6. **`/transactions/:node_id` privacy.** Adding a read endpoint that dumps any node's full transaction history by node-id is a new metadata-exposure surface on the node. On-chain data is already public, so not a hard violation, but it makes correlation trivial over HTTP. At minimum note it; consider gating or paginating.

# Sequencing problems

1. **Risk #5 is a known broken dependency edge shipped inside the plan.** The digest says `autosync depends on notes` and `notes depends on coord`, but the shared chunk/CID engine flows the *other* way (rdev → notes). The plan flags this and says "resolve before Wave 2" — but **both apps are scheduled in the same Wave 2** with the substrate owner (autosync) and consumer (notes) concurrent. You cannot build Notes attachments on a substrate that isn't done. **Auto-Sync's chunk engine must be a Wave-1 sub-deliverable (or an early-Wave-2 hard gate), not co-scheduled with its consumer.** As written, Wave 2 has an internal ordering hazard the plan merely promises to "resolve."

2. **Playground (M5) is gated on browser-node bridge being "battle-tested," but the bridge only gets *specced* in Wave 0 and *built* … where?** Action item #5 says "spec + scaffold the bridge contract" in weeks 1–2, but no workstream owns *implementing and hardening* `window.__ceNode` in ce-hub. The playground (Wave 2) and CE Host web-fallback both depend on it. **The bridge has a spec owner but no build owner** — orphaned critical-path dependency.

3. **`@ce-net/ui` shared panel lib is named in branding but absent from every wave and the workstream table.** CE Host, the wallet panel, and Notes web all "reuse `@ce-net/ui`." It's a Wave-0/1 dependency of three apps and it's not scheduled. Unsequenced shared dependency.

4. **SSE in ce-rs (Rust) is a blocker the demos workstream flags but no one schedules.** Recipes 2/3 and the mesh stream need SSE; the plan says "ship raw reqwest-stream now." Fine as a dodge, but `ce-rs` lacking SSE also affects `ce-ratio`, CE Host (Rust side), and autosync transport. **Either add an SSE helper to ce-rs in Wave 0, or accept raw-stream duplication across four consumers.** Not decided.

5. **Wallet is "Wave 0→1" — a split-wave deliverable.** The read endpoints + key custody are Wave 0; the CLI/SDK/dashboard halves are Wave 1. That's fine, but the table lists effort "L" against a workstream straddling two waves with the dashboard panel (itself "L") depending on `@ce-net/ui` (unscheduled, see #3). The wallet panel's real critical path is longer than the table implies.

# Missing use-cases or risks

1. **No mesh use-case ships in the MVP.** The single most direct reading of "more use-cases and ways to use the mesh" is satisfied by *zero* deliverables before launch. At least **ce-pin** (blob-native, lowest-risk, "M" effort, content-addressing IS its proof) should be pulled to Wave 1/2 so the launch demonstrates a *new* mesh use-case, not just the pre-existing job runner. As-is, the launch story is "CE now has TS + a wallet + a dashboard for the thing it already did."

2. **Auto-sync ↔ Notes is the actual flagship pairing and it's all post-launch.** "Local-first notes that auto-sync across your devices" is *the* consumer demo that ties the user's Notes + auto-sync asks together. Neither is in the MVP. The MVP launches the *hosting/earning* side but none of the *consumer/use-the-mesh* side. The plan's own thesis ("usable and accessible") is half-delivered.

3. **Ratio gaming beyond wash-trading is under-examined.** The plan covers per-pair wash-trading (burn makes it costly). It does **not** cover: (a) **whitewashing** — a low-ratio node abandons identity and starts fresh (newcomer grace is exploitable repeatedly); (b) **ratio as a denial vector** — if ratio gates scheduling, a Sybil cluster can collectively starve a target's selection. Both are reputation-system classics; neither appears.

4. **No upgrade/migration story for the hand-maintained OpenAPI spec when the node API changes.** CI contract-tests catch drift *at HEAD*, but there's no plan for **versioning** the SDK against node versions. When a user runs `@ce-net/sdk@1.2` against an older node, what happens? No version-negotiation or capability-discovery mentioned.

5. **Key backup recovery is specced; key *rotation* and *compromise response* are not.** "Lose the key = lose everything" is addressed by backup. But "key was *copied/leaked*" has no answer — you can't rotate a node identity without losing accrued ratio, balance, and bond. For a wallet workstream this is a real gap.

6. **CE Host scheduler "pause" is a node restart** — interrupts uptime rewards, mesh presence, and could trigger heartbeat-miss penalties on running jobs. The plan flags the coarseness but doesn't account for the **economic** side effect: pausing might *cost* the user (missed rewards, possibly job-expiry slashing). That's worse than "coarse," it's potentially money-losing, and it's in the MVP hero app.

# Top 5 concrete fixes to apply before building

1. **Pull `ce-pin` (and the Auto-Sync chunk engine) into the MVP wave.** Ship at least one *new mesh use-case* and resolve the substrate ownership in one move: build the content-addressed chunk/CID engine in rdev in **Wave 1**, ship `ce-pin` on it as the MVP's "new way to use the mesh" demo, then Notes and full Auto-Sync consume a *finished* substrate in Wave 2. This directly fixes coverage gap (mesh use-cases), MVP weakness, and sequencing risk #5 simultaneously.

2. **Stop calling the v1 number a "share ratio." Either ship real windowed volume or rename it.** The user asked for a *torrent ratio*. A cumulative `earned/spent` with recency decay is not that. Pull the v2 windowed-history read endpoint (a thin, justified node change you're already batching in Wave 0) into the **same batched node PR** so v1 *is* the real thing, or rebrand the v1 metric as "contribution score" to avoid a credibility hit at launch.

3. **Assign a build owner and a wave to the browser-node bridge and `@ce-net/ui`.** Both are critical-path dependencies of 3+ apps with a spec but no implementer. Put the `window.__ceNode` ce-hub bridge implementation in Wave 0 (it gates playground + CE Host web fallback) and schedule `@ce-net/ui` as an explicit Wave-1 deliverable before any panel-consuming app.

4. **Make the economic safety of CE Host's "pause" explicit before shipping it.** Either implement a real graceful drain (finish/migrate running jobs, then stop) or hard-block pause while jobs are running and surface "pausing now forfeits N credits / risks job-expiry slashing." Do not ship a money-losing button in the hero app with only a doc caveat.

5. **Write down the two non-negotiable boundary rules as code/CI gates, not prose:** (a) `ce-ratio` output may rank/order but must **never** be an input to `ce-cap` capability verification — add a dependency-direction lint; (b) the node exposes **no** `/key/*` and **no** credential-minting endpoint, ever — add the grep/route test in the Wave-0 node PR. The plan states both as intentions; encode them so a future contributor can't quietly violate them.
