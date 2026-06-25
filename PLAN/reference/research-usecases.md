This is a pure analysis/brainstorming task — no codebase exploration needed since I have full CE context from CLAUDE.md. Let me produce the portfolio directly.

# CE Application Portfolio — High-Value Use Cases, Pressure-Tested

CE primitives in scope: **exec** (sandboxed container/WASM), **mesh** (libp2p req/reply + pubsub), **blob** (content-addressed), **pay** (micropayment channels), **cap** (capabilities). Below, each candidate is rated and the portfolio is ranked at the end by `(impact × demo-ability) / effort`.

---

## 1. Distributed CI / test-runner mesh

- **Pitch:** Push a commit, shard the test suite across idle machines you (or the mesh) own, pay per test-second.
- **Primitives:** exec (sandboxed runner), blob (repo snapshot + artifact cache by content hash), mesh (fan-out shards / collect results), pay (per-second billing), cap (grant runner rights to a fleet).
- **Beats incumbent (GitHub Actions / CircleCI / BuildKite):** No per-minute SaaS markup; use your own idle desktop + borrowed mesh capacity; content-addressed cache is shared across the whole fleet, not siloed per-runner; bring-your-own-GPU for ML test suites that hosted CI prices out of reach.
- **Difficulty:** Medium. Sharding + result aggregation is app logic; flaky-test re-run and deterministic env are the hard parts. The substrate already does exec+blob+pay.
- **Killer demo:** Same monorepo test suite — GitHub Actions wall-clock vs CE fanning 200 shards across 8 machines, live cost ticker showing fractional credits, side-by-side finish line.
- **Pressure test:** Trust is the real problem — a malicious runner can fake green. Needs the verification dial (re-run N% of shards on a second host, compare). Determinism (pinned toolchain images) is mandatory or cache hit-rate collapses.

## 2. Headless-browser / render farm

- **Pitch:** Screenshot/PDF/scrape/video-render at scale, billed per frame, across borrowed browsers.
- **Primitives:** exec (headless Chromium / Blender in sandbox), blob (input scene + output frames), mesh (job fan-out), pay (per-frame), cap.
- **Beats incumbent (Browserless / Puppeteer-cloud / AWS render):** Embarrassingly parallel, so mesh scaling is near-linear; GPU render nodes (the desktop) plug straight in; no egress fees on pulling rendered output (it's blob-addressed, fetched once, cached everywhere).
- **Difficulty:** Low–Medium. Headless Chrome in a container is a solved image; Blender CLI likewise. Mostly a thin job-splitter app.
- **Killer demo:** Drop a 500-frame Blender scene; watch frames stream back out-of-order from 6 nodes as thumbnails fill a grid; total render time + credits spent vs one-machine baseline.
- **Pressure test:** Output verification (did the node actually render, or return garbage?) — perceptual hash spot-checks. Big scene assets need efficient blob dedup or upload dominates.

## 3. LLM inference mesh

- **Pitch:** Route prompts to whoever has a spare GPU and the right model loaded; pay per token, no vendor lock.
- **Primitives:** exec (model server in sandbox), pay (per-token channel — high-frequency micropayments), mesh (capacity atlas → route to node with model warm), blob (model weights as content-addressed blobs, pulled once), cap.
- **Beats incumbent (OpenAI/Together/Replicate):** Censorship-resistant, no API key gatekeeping, run open models OpenAI won't host; payment channels make per-token billing actually viable without a billing backend; warm-model routing via the atlas avoids cold-start.
- **Difficulty:** High. The exec primitive is request/reply-shaped; **streaming token output** needs a persistent stream, and **trust** (did the node run the real model at the real precision, or a cheaper quant?) is genuinely unsolved without TEE or redundant verification. This is the frontier item.
- **Killer demo:** Type a prompt in a web UI; tokens stream back from a stranger's GPU on the mesh; a live counter debits a payment channel ~1 credit per token; pull the network cable on that node mid-stream and watch it re-route to another holder of the same weights-blob.
- **Pressure test:** Verification is the whole ballgame. Quant-swap fraud, prompt-logging privacy, and streaming-over-mesh are all real. Highest impact, highest risk — stage it behind TEE attestation on the frontier.

## 4. Private CDN / blob pinning

- **Pitch:** IPFS-style pinning with payments — pay nodes to keep your content hot and serve it near users.
- **Primitives:** blob (the entire product), pay (pin-rent channels), mesh (find nearest replica), cap (private/authed content).
- **Beats incumbent (Cloudflare / S3+CloudFront / Pinata):** No egress fees (the cost that kills S3 users); pay only for replication you want; content-addressed = automatic dedup and integrity; private content via cap, unlike public IPFS.
- **Difficulty:** Low. This is the most native fit — blob + pay is 80% of it. Geo-aware replica selection is the only real app work.
- **Killer demo:** Pin a 1GB dataset, set replication=5; map lights up 5 nodes; kill 2; watch auto re-replication restore the factor; fetch from the geographically nearest replica with a latency readout beating an S3-bucket fetch.
- **Pressure test:** Proof-of-storage/retrievability (is the node actually holding the bytes, or claiming rent for nothing?) — needs challenge-response audits. Otherwise low-risk and high-fit.

## 5. ngrok-style public tunnels

- **Pitch:** Expose localhost to the internet through the mesh + relay, no account, no subdomain rental.
- **Primitives:** mesh (stream = raw transport, already shipped as `ce tunnel`), cap (who may dial your port), pay (optional, for relay bandwidth).
- **Beats incumbent (ngrok / Cloudflare Tunnel):** Already a CE primitive — `ce tunnel` exists; no central tunnel-broker SaaS; capability-gated access instead of guessable URLs; the relay infra already runs.
- **Difficulty:** Low. Mostly UX + a public HTTP ingress on the relay mapping a hostname to a mesh stream.
- **Killer demo:** `ce tunnel --public` on a laptop behind NAT prints `https://<name>.ce-net.com`; open it on a phone on cellular; live HTTP request hitting the laptop's local dev server. Then revoke the cap and the URL dies instantly.
- **Pressure test:** Abuse (phishing/malware hosting on your relay domain) is the operational risk — needs rate limits and a kill switch. Bandwidth accounting if you want to charge.

## 6. Cron / scheduled-jobs mesh

- **Pitch:** Durable cron that survives any single machine dying — schedule once, the mesh guarantees execution.
- **Primitives:** exec, mesh (pubsub for schedule announce + leader election), pay, cap, blob (job payload).
- **Beats incumbent (cron / GH Actions schedule / Temporal Cloud):** No single point of failure; geo-distributed triggers; pay-per-run with no idle SaaS cost.
- **Difficulty:** Medium. Exactly-once / leader election over pubsub is the classic hard distributed-systems problem (needs the ce-coord Raft tier).
- **Killer demo:** Schedule "every 10s, ping a webhook"; show 3 nodes coordinating so exactly one fires each tick; kill the leader; watch a new node seamlessly take over with no missed or duplicated tick.
- **Pressure test:** Exactly-once is genuinely hard; at-least-once + idempotency keys is the honest framing. Lower demo wow than it sounds unless the failover is crisp.

## 7. CI build cache (shared, content-addressed)

- **Pitch:** A Bazel/sccache/Turborepo remote cache that's a shared mesh blob store — every node's build warms everyone's.
- **Primitives:** blob (cache entries by content hash — perfect fit), pay (cache-hit rent), mesh (lookup), cap.
- **Beats incumbent (Bazel Remote / Nx Cloud / sccache+S3):** Content-addressing is literally how these caches key entries, so the impedance match is exact; no S3 egress; cross-org cache sharing if you want it.
- **Difficulty:** Low. Implement the existing remote-cache HTTP protocol (Bazel REAPI / sccache) backed by CE blobs. Mostly an adapter.
- **Killer demo:** Cold `bazel build` on machine A (5 min); same build on machine B hits the CE cache → 20s, proven by a cache-hit log, no rebuild.
- **Pressure test:** Cache poisoning (malicious entry under a real key) — content-addressing actually defends this (hash must match), which makes it unusually safe. Best risk/reward in the portfolio.

## 8. Data-pipeline / map-reduce

- **Pitch:** Spark-lite: map functions over blob-sharded data across the mesh, shuffle + reduce, pay per task.
- **Primitives:** exec (map/reduce fns), blob (input shards + intermediate shuffle), mesh (task scheduling + shuffle transport), pay, cap.
- **Difficulty:** High. The **shuffle** stage (all-to-all data movement) is the hard part of every map-reduce system; stragglers and fault recovery are nontrivial.
- **Beats incumbent (Spark/EMR/Dask):** No cluster to provision; elastic borrowed capacity; pay-per-task.
- **Killer demo:** Word-count / log-aggregation over a 10GB blob-sharded dataset across 8 nodes, with a live DAG view of map→shuffle→reduce and total credits.
- **Pressure test:** Shuffle over a P2P mesh is a research-grade problem; straggler mitigation and intermediate-data durability will eat most of the effort. Lower demo-ability per unit effort.

## 9. Password-less remote dev

- **Pitch:** SSH/VS Code into any machine you hold a capability for — no passwords, no port-forwarding, no bastion.
- **Primitives:** mesh (stream transport / `ce tunnel`), cap (the auth model — signed, attenuating, revocable), exec.
- **Beats incumbent (Tailscale SSH / ngrok / Teleport):** Capability chains > static SSH keys/allowlists — attenuable ("exec only, 24h, this repo"), revocable on-chain; works through NAT via the relay; no central control plane.
- **Difficulty:** Low–Medium. `ce tunnel` + cap exist; this is the `rdev` app polished — mostly UX and the VS Code Remote integration.
- **Killer demo:** `code --remote ce:desktop` from a café laptop opens a full VS Code session on the home GPU box behind NAT; grant a colleague a 1-hour exec-only cap; they connect; it auto-expires mid-session and disconnects.
- **Pressure test:** This is arguably CE's most defensible, already-mostly-built story. Risk is low; the differentiation (revocable attenuating caps) is real and demos cleanly.

## 10. IoT / edge fleet management

- **Pitch:** Push signed workloads to thousands of NAT'd edge devices and collect telemetry over the mesh.
- **Primitives:** exec (WASM — small footprint for edge), cap (per-device, per-fleet grants), mesh (NAT traversal + telemetry pubsub), blob (firmware/model artifacts), pay (optional, device earns for compute donated).
- **Beats incumbent (AWS IoT Greengrass / Azure IoT / Balena):** No cloud account per device; NAT traversal built-in; capability-scoped fleet control with on-chain revocation; devices can *earn* by donating idle cycles.
- **Difficulty:** Medium–High. WASM exec on constrained hardware + fleet-scale pubsub fan-out (thousands of subscribers) stresses the mesh.
- **Killer demo:** OTA-push a new WASM inference model to 50 simulated Raspberry Pis behind NAT; live grid shows rollout %; revoke one device's cap and watch it drop out of the fleet.
- **Pressure test:** Scale (gossipsub with thousands of nodes) and constrained-device libp2p footprint are the unknowns. High impact if the substrate scales; verify mesh fan-out first.

## 11. Scientific batch compute (HTC)

- **Pitch:** BOINC-with-payments — submit embarrassingly-parallel science jobs, contributors earn credits.
- **Primitives:** exec, blob (datasets + results), pay (contributors earn), mesh (dispatch), cap.
- **Beats incumbent (BOINC / SLURM cluster / AWS Batch):** Contributors are *paid*, not just altruistic → more capacity; no cluster admin; result verification via redundancy is already a known HTC pattern that fits CE's verification dial.
- **Difficulty:** Medium. Classic HTC; the hard part (result validation via redundant execution) maps onto CE's verification dial naturally.
- **Killer demo:** Monte-Carlo / protein-folding / parameter-sweep across 20 nodes; live histogram of results converging; a fraud node returning bad numbers gets caught by the 2-of-3 redundancy check and slashed.
- **Pressure test:** Long-running jobs need robust heartbeat/checkpoint (CE has Heartbeat txs). Result verification is solvable here precisely because science jobs are reproducible.

## 12. Encrypted backup / cold storage

- **Pitch:** Tarsnap-style end-to-end-encrypted, erasure-coded backups spread across paid mesh nodes.
- **Primitives:** blob (encrypted shards), pay (storage rent channels), mesh (shard placement + retrieval), cap.
- **Beats incumbent (Backblaze / Tarsnap / S3 Glacier):** Client-side encryption (host sees only ciphertext); erasure coding for durability without trusting any single host; no egress fees on restore.
- **Difficulty:** Medium. Erasure coding (Reed-Solomon) + proof-of-retrievability audits are the real work; blob+pay are free.
- **Killer demo:** Back up a folder encrypted client-side; shards land on 10 nodes; destroy 4 nodes; restore completes intact from the surviving 6 via erasure coding; show a host's view = pure ciphertext.
- **Pressure test:** Proof-of-retrievability (the storage node is actually keeping your bytes long-term) needs periodic challenge audits or rent gets paid for nothing. Restore latency on cold data. Durability math must be honest.

---

## Cross-cutting findings (the pressure test that matters most)

1. **Verification is the universal gate.** Every *exec*-based app (CI, inference, render, map-reduce, science) shares one unsolved problem: *did the host actually run the real workload correctly?* CE's redundant-execution verification dial covers reproducible jobs (CI, science, render). Non-reproducible / opaque jobs (LLM inference at a claimed precision) need **TEE attestation** — gate those behind the frontier.
2. **Blob-only apps are the safe, near-term wins.** CDN/pinning, CI cache, and backup don't need exec-trust at all — content-addressing *is* their integrity proof. Lowest risk, highest fit, shortest path to a credible demo.
3. **Proof-of-storage** is the storage-app analog of exec-verification (pinning, backup) — needed before charging rent. Challenge-response audits, not yet built.
4. **Streaming** is a primitive gap. Req/reply covers batch jobs; LLM tokens, live logs, and tunnels need persistent streams (tunnel has it; exec results don't yet stream).
5. **Already-built leverage:** tunnels (`ce tunnel`) and password-less remote dev (`rdev`) are mostly done — fastest to a polished public demo, lowest effort.

---

## Ranking by (impact × demo-ability / effort)

| # | Use case | Impact | Demo | Effort | Score | Verdict |
|---|----------|:------:|:----:|:------:|:-----:|---------|
| 1 | **Private CDN / blob pinning** | 8 | 8 | 3 | **21.3** | Ship first — native fit, blob+pay, killer auto-replication demo |
| 2 | **CI build cache (content-addressed)** | 7 | 8 | 3 | **18.7** | Ship first — exact impedance match, content-addressing defends poisoning |
| 3 | **Password-less remote dev** | 8 | 8 | 4 | **16.0** | Mostly built (`rdev`+cap); most defensible differentiation |
| 4 | **ngrok-style public tunnels** | 7 | 8 | 4 | **14.0** | `ce tunnel` exists; polish + public ingress |
| 5 | **Headless-browser / render farm** | 8 | 9 | 6 | **12.0** | Best raw demo (frame grid); embarrassingly parallel |
| 6 | **Distributed CI / test runner** | 9 | 8 | 7 | **10.3** | High impact; needs verification dial + determinism |
| 7 | **Encrypted backup** | 8 | 8 | 7 | **9.1** | Needs erasure coding + proof-of-retrievability |
| 8 | **Scientific batch (HTC)** | 8 | 7 | 6 | **9.3** | Verification fits naturally (reproducible) |
| 9 | **LLM inference mesh** | 10 | 10 | 9 | **11.1** | Highest ceiling, highest risk — frontier/TEE-gated |
| 10 | **Cron / scheduled-jobs mesh** | 6 | 7 | 6 | **7.0** | Needs ce-coord Raft; exactly-once is hard |
| 11 | **IoT / edge fleet** | 8 | 7 | 7 | **8.0** | Gated on mesh fan-out scale |
| 12 | **Data-pipeline / map-reduce** | 7 | 7 | 9 | **5.4** | Shuffle is research-grade; lowest ROI |

(Impact/Demo/Effort on 1–10; Score = Impact × Demo ÷ Effort.)

### Recommended sequencing

- **Wave 1 (blob-native, low-risk, fast demos):** CDN/pinning → CI cache → tunnels → password-less remote dev. These need no exec-verification and lean on already-shipped primitives.
- **Wave 2 (exec + reproducible verification):** render farm → distributed CI → scientific batch. Build the redundant-execution verification dial once; all three reuse it.
- **Wave 3 (storage-proof + coordination):** encrypted backup, cron mesh, IoT fleet. Require proof-of-storage and the ce-coord Raft tier.
- **Frontier (TEE-gated):** LLM inference mesh — the highest-impact, most-viral demo, but stage it last behind attestation and streaming support.

**Flagship demo to build first:** the **render farm** scores best on demo-ability per effort, and a grid of Blender frames streaming back from strangers' machines with a live credit ticker is the single most viscerally convincing proof that the whole substrate works.