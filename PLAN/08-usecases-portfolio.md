# New Mesh Use-Cases Portfolio: Five Buildable Apps Over CE Primitives

> Workstream: `usecases` · Suggested target path: `ce/docs/apps/usecases-portfolio.md`
> Depends on: apps, economy

**Summary:** This workstream specs the top five mesh apps to build after the core wave, ranked by (impact x demo-ability) / effort. The recommended build order is: (1) ce-pin — a paid private CDN / blob-pinning app, (2) ce-cache — a content-addressed Bazel/sccache remote build cache, (3) ce-expose — ngrok-style public tunnels over the existing CE tunnel primitive plus relay HTTP ingress, (4) ce-render — an embarrassingly-parallel headless-browser/Blender render farm, and (5) ce-ci — a distributed sharded test runner with a redundant-execution verification dial. All five are pure SDK-tier apps (like swarm/rdev/ce-coord) talking to a local node via ce-rs over AppRequest + blobs + channels + ce-cap; the only node-side change required across the whole portfolio is one new feature on the relay binary (a public HTTP ingress that maps a hostname to a mesh stream) for ce-expose. The blob-native apps (pin, cache) ship fastest and lowest-risk because content-addressing IS their integrity proof; the exec apps (render, ci) share a single reusable redundant-execution verification module.

---

# New Mesh Use-Cases Portfolio

Five buildable apps for the post-core wave, each a thin SDK-tier app over `ce-rs`, in priority order. This doc gives each one a pitch, the exact CE primitives + real SDK methods it uses, MVP scope, the killer demo, repo shape, typed protocol, and effort. It ends with the build order, the shared verification module, and what (if anything) changes in the node.

## Guiding principles (non-negotiable, from CE architecture)

- **Apps, not node RPCs.** Every app here is a new repo at the SDK tier, exactly like `swarm`, `rdev`, `ce-coord`. They talk to a *local* node via `ce_rs::CeClient` and to *remote* peers over `CeClient::request`/`reply`/`publish`/`subscribe` on app-chosen topics (`pin/*`, `cache/*`, `render/*`, `ci/*`). No new node HTTP endpoints, with **one** exception called out explicitly (ce-expose relay ingress).
- **Authorization is one primitive.** Every server loop verifies a signed, attenuating `ce-cap` chain before honoring any action — copy the `rdev` `handle_inner` pattern verbatim (decode chain → `authorize(host_id, roots, &[], now, &sender, ability, &chain, &is_revoked)`). Abilities are opaque strings the app picks (`pin:store`, `cache:write`, `render:frame`, `ci:shard`).
- **Money is u128 base units, never floats.** Use `ce_rs::Amount` everywhere; HTTP carries amounts as decimal strings (the SDK already handles this). Per-unit billing uses **payment channels** (`channel_open` / `sign_receipt` / `channel_close`) so high-frequency micropayments never touch chain per unit.
- **Mesh-first.** Never store ip:port. Discover peers via `CeClient::atlas()` (capacity + tags), rank by `CeClient::history()` (reputation substrate), route via NodeId. Use `advertise_service`/`find_service` (DHT) and `claim_name`/`resolve_name` for human-readable handles.
- **Content-addressing is free integrity.** `put_blob`/`get_blob` (small) and `put_object`/`get_object` (chunked, CID-verified) mean blob-native apps need zero exec-trust.

---

# 1. ce-pin — Private CDN / paid blob pinning (SHIP FIRST)

### Pitch
IPFS-style pinning *with payments and privacy*. Publish content once, set a replication factor, and pay mesh nodes rent to keep it hot and serve it from the geographically nearest replica. No S3 egress fees, automatic dedup + integrity via content-addressing, and private content gated by `ce-cap` (unlike public IPFS).

### CE primitives & exact SDK methods
- **Blobs (the product):** publisher `put_object(bytes)` → object CID; pinners `get_object(cid)` to fetch-and-hold, re-verifying every chunk against its CID (the SDK's `get_object` already does this — trustless).
- **Mesh transport:** `request(node_id, "pin/offer", payload, timeout)` to ask a host to pin; `publish("pin/announce", ...)`/`subscribe` for "who holds CID X" gossip; `advertise_service("pin:<cid>")` + `find_service("pin:<cid>")` so a fetcher discovers replica holders via the DHT without a tracker.
- **Pay (rent):** `channel_open(host, capacity, expiry_height)` per pinner; periodic `sign_receipt(channel_id, host, cumulative)` paying rent per GB-hour; host redeems with `channel_close`. Reclaim with `channel_expire`.
- **Cap:** ability `pin:store` (a host accepts pins only from holders of a chain rooted at the host or its org root). Private content: the publisher hands fetchers a `pin:read:<cid>` cap; the host checks it before serving.
- **Reputation for placement:** `history(node_id).delivered_work()` to prefer proven hosts; `atlas()` tags (`docker`, `linux`) and `last_seen_secs` for liveness.

### Data model
```
PinJob { cid: String, bytes_len: u64, replication: u8, rent_per_gb_hour: Amount, expiry_height: u64 }
Replica { cid, holder: NodeId, channel_id, last_audit_height: u64, last_proof_ok: bool }
// Client-side state file ~/.config/ce-pin/pins.toml: map cid -> PinJob + Vec<Replica>
```

### Protocol (topic `pin/*`, JSON payloads, hex-encoded by SDK)
- `pin/offer`  `{caps, cid, bytes_len, rent_per_gb_hour, expiry_height}` → reply `{accepted: bool, channel_id?, reason?}`. Host fetches the object via `get_object(cid)` (pulling chunks from publisher/other replicas), stores it, opens a receipt-tracking channel.
- `pin/audit`  `{caps, cid, nonce}` → reply `{proof}` where `proof = sha256(chunk_at(merkle_index(nonce)) || nonce)`. Proof-of-retrievability challenge-response (auditor picks a random chunk index from the manifest via the `beacon()` hash for unpredictability; host must return the hash of that exact chunk salted with the nonce). Wrong/missing proof → stop paying rent, re-replicate elsewhere.
- `pin/release` `{caps, cid}` → host drops it.

### CLI surface
```
ce-pin add <file> --replication 5 --rent 0.001/gb-hour --days 30   # put_object, find hosts, pin/offer to N
ce-pin add-cid <cid> --replication 5 ...                            # pin existing content
ce-pin ls                                                            # local pins + replica health
ce-pin get <cid> [-o out]                                           # fetch from nearest live replica (find_service + latency probe)
ce-pin audit <cid>                                                  # run pin/audit against all replicas now
ce-pin serve                                                        # run as a pinning host (earn rent)
ce-pin rm <cid>
```

### Killer demo
`ce-pin add dataset.bin --replication 5`; a network map lights up 5 holders. Kill 2 holder processes; the client's audit loop detects the missing proofs and auto-re-pins to 2 fresh hosts, restoring factor 5 live on screen. Then `ce-pin get <cid>` resolves the nearest replica (latency readout) and pulls it faster than an S3 fetch, with a running credit ticker for rent paid.

### Repo shape
```
ce-pin/  (github.com/ce-net/ce-pin)
├── Cargo.toml          # ce-rs, ce-cap (path/git), tokio, serde, clap, sha2, hex, anyhow
├── src/main.rs         # CLI dispatch
├── src/host.rs         # serve(): poll messages(), authorize, fetch+store, answer audits, redeem channels
├── src/client.rs       # placement (atlas+history rank), offer fan-out, audit loop, re-replication
├── src/audit.rs        # PoR challenge/proof (shared with ce-cache later)
├── README.md           # protocol spec
└── tests/integration.rs
```

### Node changes
**None.** Pure SDK app. Proof-of-retrievability is app-level challenge/response over `request`/`reply`.

---

# 2. ce-cache — Content-addressed remote build cache (SHIP SECOND)

### Pitch
A Bazel/sccache/Turborepo remote cache backed by CE blobs. Every machine's build warms the whole fleet's cache. Content-addressing is literally how these caches key entries, so the impedance match is exact — and cache poisoning is structurally impossible (a returned blob whose hash ≠ the requested key is rejected). No S3 egress, optional cross-org sharing.

### CE primitives & exact SDK methods
- **Blobs:** cache entries stored as objects: `put_object(action_result_bytes)` keyed by the action's content hash; `get_object(cid)` on lookup (CID self-verifies → poisoning-proof).
- **Mesh:** `request(host, "cache/get", {key})` / `cache/put`; or run a local sidecar that speaks the existing **Bazel Remote Cache HTTP** and **sccache** protocols and translates to CE blobs. `advertise_service("cache")`/`find_service("cache")` to find cache hosts.
- **Pay:** optional `channel_open` + receipts for cache-hit rent; MVP can run free within a trusted fleet (cap-gated).
- **Cap:** ability `cache:read` / `cache:write`. Org root issues both to fleet members; outsiders get `cache:read` only.

### Architecture decision (opinionated)
Ship as a **localhost HTTP sidecar** that implements two existing wire protocols so Bazel/sccache need *zero* CE awareness:
- Bazel: implement the subset of `bazel-remote`'s HTTP CAS/AC API (`GET/PUT /cas/<hash>`, `GET/PUT /ac/<hash>`). Bazel points at `--remote_cache=http://localhost:9092`.
- sccache: set `SCCACHE_WEBDAV_ENDPOINT=http://localhost:9092`.
The sidecar maps `<hash>` → CE object CID, fetching via the mesh and caching the blob locally.

### Data model
```
CacheKey = action_hash (the tool's own content hash; we don't recompute)
Entry { key, object_cid, size, hosts: Vec<NodeId> }   # key->CID index, replicated via ce-coord RMap
```
Use `ce_coord::RMap<String,String>` (key→CID) as the shared, versioned index so a write on one node is visible fleet-wide.

### CLI / surface
```
ce-cache sidecar --port 9092 --roots <root>     # the localhost HTTP shim
ce-cache stats                                   # hit/miss, bytes served, rent earned
# Bazel:  build --remote_cache=http://localhost:9092
# sccache: SCCACHE_WEBDAV_ENDPOINT=http://localhost:9092 sccache
```

### Killer demo
Cold `bazel build //...` on machine A (5 min). Same target on machine B with the sidecar → 20s, a cache-hit log proving every action fetched from the CE mesh, no recompile. Pull the network on A mid-build on B; B keeps serving from a second replica (the RMap had >1 host per key).

### Repo shape
```
ce-cache/
├── src/main.rs        # CLI
├── src/sidecar.rs     # axum localhost server: Bazel CAS/AC + sccache WebDAV → CE blobs
├── src/index.rs       # ce-coord RMap<key,cid> wrapper
└── README.md
```

### Node changes
**None.** This is the cleanest fit in the portfolio — content-addressing is the cache's native key model, and the sidecar pattern means existing build tools integrate unmodified.

---

# 3. ce-expose — ngrok-style public tunnels (SHIP THIRD)

### Pitch
Expose `localhost` to the public internet through the mesh + relay — no account, no subdomain rental, capability-gated instead of guessable URLs. `ce tunnel` already proves the raw stream transport between two CE nodes; ce-expose adds the missing 20%: a public HTTP(S) ingress on the relay that maps `https://<name>.ce-net.com` to a mesh stream into your node.

### CE primitives & exact SDK methods
- **Tunnel / stream transport:** the existing CE `tunnel` primitive (raw libp2p stream = transport) carries the proxied bytes. ce-expose is the control-plane app that *sets up* and *names* the tunnel.
- **Name:** `claim_name("myapp")` → on-chain unique handle; the relay resolves `<name>.ce-net.com` → your NodeId via `resolve_name`.
- **Cap:** ability `expose:dial` — who may open your public endpoint. Revoke the cap and the URL dies instantly (relay re-checks `revoked()`).
- **Pay (optional):** relay bandwidth metered via `pay_relay(relay, channel_id, cumulative)` (already in the SDK) so the public relay can charge for egress.
- **Mesh:** relay reaches the NAT'd origin via the existing circuit-relay/DCUtR path (CLAUDE.md circuit addr); no stored ip:port.

### THE ONE NODE/INFRA CHANGE IN THIS PORTFOLIO
ce-expose needs a **public HTTP ingress on the relay binary** (the Hetzner `ce-relay` service): an axum handler that, on an inbound request to `<name>.ce-net.com`, resolves `name → NodeId`, verifies the caller against the endpoint's cap policy (for private endpoints), opens a mesh stream to that node's ce-expose agent, and pipes the HTTP request/response over it. This is a *relay feature*, gated behind the relay's existing role — it is NOT a new RPC on every CE node, and it does not expand the node's primitive surface. Everything else (the origin-side agent that accepts the stream and forwards to `localhost:<port>`) is a pure SDK app. Document this explicitly in `ce/docs/primitives.md` as "relay-only ingress, not a node primitive."

### Data model
```
Endpoint { name: String, target_port: u16, owner: NodeId, public: bool, dial_cap_root?: [u8;32] }
# relay keeps an in-memory name->NodeId+policy table, rebuilt from resolve_name + the endpoint's published cap policy
```

### CLI / surface
```
ce-expose http 3000 --name myapp [--public | --cap-root <root>]   # origin agent: claim_name, accept relay streams → localhost:3000
ce-expose tcp 22 --name sshbox --cap-root <root>                   # raw TCP over the same path (ssh -p)
ce-expose ls                                                       # active endpoints
ce-expose revoke <name>                                            # on-chain RevokeCapability for the dial cap
```

### Killer demo
`ce-expose http 3000 --name leif` on a laptop behind NAT prints `https://leif.ce-net.com`. Open it on a phone on cellular → an HTTP request hits the laptop's local dev server live. `ce-expose revoke leif` and the URL 403s within one revocation poll cycle.

### Repo shape
```
ce-expose/
├── src/main.rs        # origin agent: claim_name, accept streams, proxy to localhost
├── src/proxy.rs       # bidirectional stream<->TCP pump
└── README.md
# relay ingress lives in ce/crates/ce-node behind the relay role, OR a new ce-relay-ingress crate
```

### Node changes
**Relay-only:** add the public HTTP/TCP ingress to the relay binary. No change to the generic node primitive set.

---

# 4. ce-render — Headless-browser / Blender render farm (SHIP FOURTH)

### Pitch
Screenshot/PDF/scrape and 3D/video render at scale, billed per frame, across borrowed browsers and GPUs. Embarrassingly parallel → mesh scaling is near-linear; the desktop's GPU plugs straight in; no egress on pulling output (it's blob-addressed, fetched once, cached everywhere).

### CE primitives & exact SDK methods
- **Exec (the work):** `mesh_deploy(node_id, &BidSpec{image:"ce-net/blender", cmd:[...], cpu_cores, mem_mb, duration_secs, bid}, grant)` per frame/shard — runs headless Chromium or `blender -b` in a gVisor sandbox. Returns `job_id`; for completed WASI/command cells the `Deployment.output` is a CID.
- **Blobs:** input scene via `put_object(scene_bytes)` → CID; pass CID as a `mesh_deploy_wasm` `inputs` arg (host stages it pre-launch) or fetch in-container; outputs returned as CIDs via `get_object`.
- **Mesh scatter/gather:** copy `swarm`'s `JoinSet` fan-out — `atlas()` to find `has_tag("gpu")` hosts, `history()` to rank, spread N frames across them, collect.
- **Pay:** per-frame via channels (`channel_open` per host, `sign_receipt` per delivered frame, `channel_close`).
- **Cap:** ability `render:frame`.
- **Verification (shared module, see below):** spot-check ~5% of frames by re-rendering on a second host and comparing a perceptual hash; mismatch → don't pay, re-assign, lower that host's local trust.

### Data model
```
RenderJob { scene_cid, frames: Range<u32>, image: String, args: Vec<String>, bid_per_frame: Amount }
FrameResult { frame: u32, host: NodeId, output_cid: String, phash: [u8;8], verified: bool }
```

### CLI / surface
```
ce-render blender scene.blend --frames 1-500 --hosts 8 --verify 0.05 -o out/   # split, scatter, gather
ce-render shot https://example.com --pdf -o page.pdf                            # one-shot headless chrome
ce-render shots urls.txt --hosts 6 -o shots/                                    # batch screenshots
```

### Killer demo
Drop a 500-frame Blender scene with `--hosts 6`. A thumbnail grid fills out-of-order as frames stream back from 6 machines; total wall-clock and credits spent shown vs a single-machine baseline. A planted fraud host returns a black frame; the 5% verification spot-check catches the phash mismatch, the frame is re-assigned, and that host gets no payment.

### Repo shape
```
ce-render/
├── src/main.rs        # CLI
├── src/farm.rs        # placement + scatter/gather (borrow swarm patterns)
├── src/verify.rs      # re-exports ce-mesh-verify (shared crate)
├── images/blender.Dockerfile, images/chrome.Dockerfile
└── README.md
```

### Node changes
**None.** Uses existing `mesh_deploy` + blobs + channels.

---

# 5. ce-ci — Distributed sharded test runner (SHIP FIFTH)

### Pitch
Push a commit, shard the test suite across idle machines you (or the mesh) own, pay per test-second. No per-minute SaaS markup; content-addressed artifact cache shared fleet-wide (reuses ce-cache); bring-your-own-GPU for ML test suites hosted CI prices out of reach.

### CE primitives & exact SDK methods
- **Blobs:** repo snapshot via `put_object(tarball)` → CID; result artifacts back as CIDs. Toolchain images pinned (determinism is mandatory or cache hit-rate collapses) and shared via **ce-cache** + **ce-pin** (this app sits on top of #1 and #2).
- **Exec:** `mesh_deploy` per shard — sandboxed runner pulls the snapshot CID, runs its slice (`pytest --shard k/N`, `cargo test -- --partition`), returns a JUnit-XML CID + exit code.
- **Scatter/gather:** swarm-style fan-out over `atlas()`/`history()`.
- **Pay:** per-second billing via channels.
- **Cap:** ability `ci:shard`.
- **Verification dial (shared module):** re-run a configurable % of shards on a second host; compare result hashes; a host that reports green where the canary reports failures is flagged and unpaid. This is the trust crux — a malicious runner faking green is the real problem.

### Data model
```
CiRun { snapshot_cid, shards: u32, image: String, cmd_template: String, verify_pct: f32, bid_per_sec: Amount }
ShardResult { shard: u32, host: NodeId, junit_cid: String, exit_code: i32, secs: u64, verified: bool }
```

### CLI / surface
```
ce-ci run --shards 200 --hosts 8 --image ce-net/rust:1.x --verify 0.1 -- cargo test
ce-ci run --shards 50 -- pytest      # auto-detects pytest-shard / nextest partitioning
ce-ci report <run_id>                # aggregate JUnit, show flaky/divergent shards
```
Reuse swarm's `tally()` to group shard outcomes and surface the *minority divergence* (the flaky/lying-host signal).

### Killer demo
Same monorepo suite: GitHub Actions wall-clock vs ce-ci fanning 200 shards across 8 machines with a live cost ticker in fractional credits, side-by-side finish line. A flaky/malicious host reporting false-green is caught by the 10% re-run dial and its shards re-assigned.

### Repo shape
```
ce-ci/
├── src/main.rs        # CLI
├── src/shard.rs       # framework adapters (cargo-nextest, pytest-shard, jest --shard)
├── src/farm.rs        # scatter/gather (swarm patterns)
├── src/verify.rs      # ce-mesh-verify
├── src/report.rs      # JUnit merge + divergence (swarm tally)
└── README.md
```

### Node changes
**None.** Depends on ce-cache (#2) and ce-pin (#1) for fast, deterministic artifact reuse.

---

# Shared infrastructure: `ce-mesh-verify` (one crate, two consumers)

ce-render (#4) and ce-ci (#5) share the *exact* same trust problem — *did the host actually run the real workload?* Build a single small crate **`ce-mesh-verify`** (SDK-tier helper, not a node change) used by both:

```rust
// pick a random subset of results to re-run on a DIFFERENT host (beacon-seeded for unpredictability)
pub fn canary_set(results: &[Item], pct: f32, beacon: &Beacon) -> Vec<usize>;
// compare original vs re-run; reproducible jobs (render frames via phash, test results via JUnit hash) → bool
pub fn agrees(original: &Item, rerun: &Item, mode: CompareMode) -> bool;
// feed a verdict into the local trust ledger; on disagreement, withhold payment + lower atlas-pick weight
pub fn record(host: &str, ok: bool);
```

Reproducible jobs (render, CI, science) are verifiable this way. **Non-reproducible/opaque jobs (LLM inference at a claimed precision) are explicitly OUT of this portfolio** — they need TEE attestation + streaming and belong on the frontier, not this wave.

---

# Prioritized portfolio & build order

| Rank | App | Impact x Demo / Effort | Ships as | Node change |
|---|---|---|---|---|
| 1 | **ce-pin** (CDN/pinning) | 8x8/3 = 21.3 | Thin over blobs+channels+cap | none |
| 2 | **ce-cache** (build cache) | 7x8/3 = 18.7 | Thin over blobs+ce-coord RMap | none |
| 3 | **ce-expose** (public tunnels) | 7x8/4 = 14.0 | Thin over tunnel+name+cap | **relay ingress only** |
| 4 | **ce-render** (render farm) | 8x9/6 = 12.0 | Over mesh_deploy + ce-mesh-verify | none |
| 5 | **ce-ci** (test runner) | 9x8/7 = 10.3 | Over render's stack + ce-cache/ce-pin | none |

**Wave A (blob-native, lowest risk, fastest demos):** ce-pin → ce-cache. No exec-trust; content-addressing is the integrity proof. These also become *dependencies* of the exec apps (artifact/cache reuse), so they must land first.

**Wave B (mesh-transport polish):** ce-expose. Mostly UX + the single relay ingress feature; `ce tunnel` already proves transport.

**Wave C (exec + reproducible verification):** build `ce-mesh-verify` once, then ce-render, then ce-ci (ci sits on top of pin+cache+render's farm patterns).

**Explicitly deferred to frontier:** LLM-inference mesh (highest ceiling, highest risk — needs streaming + TEE attestation, which this wave does not deliver) and cron-mesh / map-reduce (need the ce-coord Raft leader-election tier and research-grade shuffle, respectively).

## What is genuinely reused vs new
- **Reuse from swarm:** host selection (`atlas`+`history` rank), scatter/gather `JoinSet`, `tally`/divergence — directly in ce-render and ce-ci.
- **Reuse from rdev:** the `serve()` poll-`messages()` + `authorize()` server loop and path-safety patterns — in ce-pin host, ce-cache sidecar, ce-expose agent.
- **Reuse from ce-coord:** `RMap`/`RSet` for the shared cache/replica index (ce-cache, ce-pin).
- **New shared crate:** `ce-mesh-verify` (render + ci).
- **New infra (the only node-side work):** relay public HTTP/TCP ingress (ce-expose).

## Testing strategy (all apps)
- **Unit:** pure logic — placement ranking, PoR challenge/proof, phash compare, JUnit merge, canary-set selection — as `#[cfg(test)]` modules; no infra.
- **Local integration:** spin 2–3 local nodes (the `e2e-local.sh` pattern in the workspace) on distinct ports via `NEXT_PORT`; run each app's host + client end-to-end. ce-cache: assert a real `bazel build` hits the sidecar. ce-pin: kill a holder, assert re-replication. ce-render/ce-ci: plant a fraud host, assert the verify dial catches it and withholds payment.
- **E2E:** reuse the Hetzner `ce-deploy` path for ce-expose (real public URL hit from outside) and a 6-host render-farm demo.
- **Capability tests:** copy rdev's `handle_authorizes_self_issued_cap` / `handle_denies_action_not_granted` tests per app, asserting attenuation (a `pin:read` cap cannot perform `pin:store`).

## Risks
- See the `risks` array.

## Milestones

| Milestone | Deliverable | Effort |
|---|---|---|
| ce-pin MVP | Pinning host + client with replication, PoR audit challenge/response, channel-based rent, atlas/history placement, find_service replica discovery; kill-a-holder auto-re-replication demo green. | M |
| ce-cache sidecar | localhost HTTP shim implementing Bazel CAS/AC + sccache WebDAV mapped to CE blobs, with a ce-coord RMap key->CID index; real `bazel build` cache-hit on a second machine. | M |
| ce-mesh-verify crate | Beacon-seeded canary-set selection, reproducible-job comparators (phash for frames, JUnit hash for tests), local trust ledger feed; unit-tested. Prereq for render+ci. | S |
| ce-expose origin agent | claim_name + accept relay streams + proxy to localhost HTTP/TCP; cap-gated dial with instant revoke; works node-to-node before the relay ingress lands. | M |
| Relay public ingress (node/infra) | axum handler on the ce-relay binary: <name>.ce-net.com -> resolve_name -> mesh stream -> origin; private endpoints cap-checked; optional pay_relay metering. Documented as relay-only, not a node primitive. | L |
| ce-render farm | Blender + headless-chrome images, scatter/gather over mesh_deploy, blob-addressed scene in / frames out, channel per-frame billing, 5% verify dial via ce-mesh-verify; 500-frame thumbnail-grid demo. | L |
| ce-ci runner | Framework shard adapters (nextest/pytest/jest), snapshot-via-put_object, scatter/gather, JUnit merge + divergence report, 10% verify dial, artifact reuse via ce-cache/ce-pin; GitHub-Actions vs ce-ci side-by-side demo. | L |


## Risks

- Proof-of-retrievability (ce-pin) and exec-verification (ce-render/ce-ci) are the trust crux: a host can claim rent or report false-green. Mitigated by beacon-seeded challenge/response and a re-run verification dial, but a determined adversary who controls both the worker and its canary peer can still collude — the dial only raises cost, it is not a hard guarantee. Document the residual trust assumption.
- Determinism is load-bearing for ce-cache and ce-ci: non-pinned toolchains / non-reproducible builds collapse cache hit-rate and make verification ambiguous (a real flaky test looks like a lying host). Must mandate pinned, content-addressed runner images.
- ce-expose introduces the only node/infra change (relay public ingress) and the only real abuse surface (phishing/malware hosting on the ce-net.com domain). Needs rate limits, a kill switch, and per-endpoint cap gating before any public launch; ties the apps to relay operational policy.
- Payment channels are assumed working for high-frequency per-unit billing (per-frame, per-test-second, per-GB-hour). If channel open/close/expiry has rough edges under load, all four billing-bearing apps inherit them; validate the channel path under fan-out before render/ci.
- Large-object transfer over the mesh is sequential in the current get_object (parallel multi-provider fetch is a noted Stage-2 refinement). Big Blender scenes / repo snapshots may make upload/fetch dominate wall-clock and undercut the 'beats incumbent' demo until parallel chunk fetch lands.
- Portfolio coupling: ce-ci depends on ce-pin + ce-cache + ce-render's farm patterns, and ce-render + ce-ci share ce-mesh-verify. Slippage in Wave A cascades. Keep the verify crate and the swarm-pattern extraction small and shipped early to de-risk.
