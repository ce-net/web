# CE-NET — AI Agent Context

This file is the root context for all AI agents working in this workspace. It is NOT committed to any repo (it lives at `~/ce-net/CLAUDE.md`, outside all git trees). Read this first. Read the per-repo CLAUDE.md and docs/ after for deeper detail.

Dont use emojis unless told so - they degrade quality and make it look like ai generated slop.
Work together with other ai agents working in this folder from other terminal instances with different tasks. Dont fight them. Communicate in AGENTS.md when absolutely necessary. Give yourself a name which is not claude - all of you are claude.

Why are we building and running and testing locally instead of using ce-net dev tools and running and building and testing  distributed - ON THE HETZNER INSTANCE SPECIFICALLY.
IF something you need is missing from the dev tooling - build it for yourself and the next person.

---

## Who you are working with

**Leif Rydenfalk** — sole developer. Git author for all commits.
- Email: ledamecrydenfalk@gmail.com
- No co-author lines in commits. No "Claude" in commit messages.
- All work is serious production code. No emojis unless explicitly instructed.

---

## The three machines

### Laptop (primary dev machine — this machine)
- **OS:** macOS (Apple Silicon / arm64)
- **Role:** Development, code editing, `ce` CLI, orchestrating the desktop
- **CE node ID:** `c0be11e0ce0aaa769da6f9970244947d3d32a0c0d8302fb5f41f73d7950be456`
- **libp2p peer ID:** `12D3KooWNnkYbLhtpP5mUY2UeVEMRe6hy7EwN5RiHcYEXNXTM9VX`
- **`ce` binary:** `~/.local/bin/ce`
- **Data dir:** `~/.local/share/ce/` (key + chain)

### Desktop (Leif's Debian Linux machine — behind NAT)
- **OS:** Debian Linux (x86_64)
- **Role:** GPU compute node, builds, remote exec target
- **CE node ID:** `25df8f15853855c4cd2c5769cbc9789bf156534356ffead3b67c2c395f6d8ac1`
- **libp2p peer ID:** `12D3KooWCNCyEFHAGE2z4ZhpP6ApeqFXY7cRLxJqVTWvYCBfrWmn`
- **Circuit addr:** `/ip4/178.105.145.170/tcp/4001/p2p/12D3KooWC6vyMMrtmdWEdpcMx7JZ4Ze5scUhA6BbMdYqnUDC7nr7/p2p-circuit/p2p/12D3KooWCNCyEFHAGE2z4ZhpP6ApeqFXY7cRLxJqVTWvYCBfrWmn`
- **Registered as:** `desktop` in `~/.local/share/ce/machines.toml` on laptop
- **Status:** Both laptop and desktop need `ce start` running and registered with each other to be fully operational.

### Relay (public Hetzner server)
- **OS:** Linux (Hetzner fsn1, cpx22, 4 vCPU / 4 GB RAM)
- **IP:** `178.105.145.170`
- **CE node ID:** `21f5c206ffbf88d7bebdf9078d687e30be5b9a3c6e7ac752e018a559faf171d4`
- **libp2p peer ID:** `12D3KooWC6vyMMrtmdWEdpcMx7JZ4Ze5scUhA6BbMdYqnUDC7nr7`
- **Bootstrap multiaddr:** `/ip4/178.105.145.170/tcp/4001/p2p/12D3KooWC6vyMMrtmdWEdpcMx7JZ4Ze5scUhA6BbMdYqnUDC7nr7`
- **SSH:** `ssh -i ~/.ssh/id_ed25519 root@178.105.145.170` (passphrase-protected — run `ssh-add ~/.ssh/id_ed25519` first)
- **API port:** 8080 (internal), proxied through nginx on port 80
- **P2P port:** 4001 (TCP + UDP, open in UFW)
- **Systemd service:** `systemctl status ce-relay` — runs `ce start --no-mine`
- **Bootstrap endpoint:** `https://ce-net.com/bootstrap` → live, returns JSON multiaddr list
- **Health check:** `https://ce-net.com/health`

#### Cloudflare (ce-net.com)
- DNS: `ce-net.com` → 178.105.145.170 (proxied), `relay.ce-net.com` → same (proxied), `p2p.ce-net.com` → same (unproxied, for libp2p direct)
- SSL: Flexible (Cloudflare terminates TLS, origin speaks HTTP on :80)
- Token env: `CLOUDFLARE_API_TOKEN` in `/Users/07lead01/ce-net/ce/.env`
- Account ID: `59abbbc8e5e8d6cfe0f1b1ed777096fb`
- Zone ID: `1e8cbab8bc00451a218db1683bca8f1b`

#### Hetzner
- API token: `HETZNER_API_TOKEN` in `/Users/07lead01/ce-net/ce/.env`
- SSH keys in project: `ce-laptop` (ID 112796132), `ce-deploy` (ID 112621126)
- Server ID: 132886506

---

## Local directory layout

```
~/ce-net/                           ← workspace root (this CLAUDE.md lives here)
├── CLAUDE.md                       ← this file — NOT in any git repo, NOT committed
├── ce/                             ← github.com/ce-net/ce  (main Rust workspace — the node)
├── ce-rs/                          ← github.com/ce-net/ce-rs  (Rust SDK; standalone, no ce dep)
├── swarm/                          ← github.com/ce-net/swarm  (first app: work scheduler, uses ce-rs)
├── homebrew-ce/                    ← github.com/ce-net/homebrew-ce  (Homebrew tap)
├── scoop-ce/                       ← github.com/ce-net/scoop-ce  (Scoop bucket, Windows)
│
│   APPS & TOOLING (each its own github.com/ce-net repo; built on CE primitives via ce-rs/ce-cap):
├── rdev/                           ← remote exec + content-addressed sync; (branch remote-build) adds `rdev run/build` long remote builds over the mesh — use this to build/test on the relay, NOT raw ssh
├── ce-expose/                      ← mesh tunnels; feature `ingress` = hardened public HTTP ingress (default-deny, off by default; deploy gated on launch-blockers in docs/security-review.md)
├── ce-storage/                     ← S3-subset gateway over CE blobs; serves ce-net.com (the gateway dogfood, not bespoke nginx)
├── ce-worker/                      ← native headless compute worker (no browser); shares cores via ce-hub (Mac launchd + relay systemd)
├── ce-gov/                         ← governance: pre-run AI policy scan + karma abuse monitor + expert proof/anti-proof voting
├── ce-sched/  ce-bench/            ← benchmark/latency/vendor-aware job placement + mesh benchmarking suite
├── ce-tabnet/                      ← pipeline-parallel LLM inference sharded across browser tabs
└── e2e/                            ← live multi-process + prod smoke + security-invariant tests (CI runs the suite)

# Sybil-security design: PLAN/compute-donation-sybil-security.md; implemented (inert, additive) on
# the `ce` branch `sybil-p4-p9` (P4-P9) — NOT merged to main / NOT on the live node (needs expert
# review + calibration + real-crypto swap + a human merge decision before it can secure consensus).

**ce-rs** (SDK) and **swarm** (app) are separate repos by design: CE is the substrate, apps
build on it via the SDK. `swarm` depends on `ce-rs` via git. ce-rs is a thin reqwest/serde
client over the node HTTP API (no libp2p/bollard); `Amount` handles base-unit money.
```

### ce/ — the main repo

```
ce/
├── Cargo.toml                      ← workspace root + `ce` binary crate
├── src/main.rs                     ← CLI entry point (clap commands)
├── crates/
│   ├── ce-identity/                ← Ed25519 keypair, node ID, sign/verify
│   ├── ce-chain/                   ← PoW blockchain, transactions, balances, persistence
│   ├── ce-mesh/                    ← libp2p (Kademlia DHT + Gossipsub), chain sync
│   ├── ce-container/               ← Docker management, gVisor, resource limits
│   ├── ce-node/                    ← Orchestrator: HTTP API, mining loop, mesh event loop
│   ├── ce-protocol/                ← CEP-1 cell signaling wire format, BurnProof
│   └── ce-deploy/                  ← Hetzner provisioning, SSH deploy, E2E tests
├── docs/
│   ├── standards.md                ← Coding standards and canonical terminology — READ BEFORE CODING
│   ├── design.md                   ← Terminal/UI design rules — READ BEFORE TOUCHING CLI OUTPUT
│   ├── api.md                      ← Full HTTP API reference
│   ├── primitives.md               ← What CE provides to everyone + the CE-vs-app boundary + trust gradient
│   ├── apps/scheduler.md           ← Spec for the first app: distributed work scheduler on CE
│   ├── frontier.md                 ← Committed pre-launch capability roadmap (payment channels, WASM, storage, TEE, ...)
│   ├── deployment.md               ← How to deploy: single node, multi-node, Hetzner, device onboarding
│   ├── roadmap.md                  ← What's done, what's planned, phase by phase
│   ├── protocol.md                 ← CEP-1 wire protocol spec
│   └── testing.md                  ← How to run all test suites
├── Formula/ce.rb                   ← Homebrew formula (mirror of homebrew-ce/) — updated by update-sha256.sh
├── install.sh                      ← One-liner Linux/macOS installer
├── install.ps1                     ← One-liner Windows installer (PowerShell)
├── packaging/
│   ├── scripts/update-sha256.sh   ← Run after each release to patch SHA256s in all packaging files
│   ├── scoop/ce.json               ← Scoop manifest (mirror of scoop-ce/bucket/) — updated by update-sha256.sh
│   ├── choco/ce.nuspec             ← Chocolatey package spec
│   ├── choco/tools/chocolateyInstall.ps1
│   └── aur/PKGBUILD               ← Arch Linux AUR package (ce-bin)
└── .github/
    └── workflows/ci.yml           ← CI: test on every push, build+release on v* tags
```

### homebrew-ce/ — Homebrew tap

```
homebrew-ce/
├── Formula/ce.rb                   ← The formula. Brew finds it here.
└── README.md
```

Users install via: `brew tap ce-net/ce && brew install ce`  
or: `brew install ce-net/ce/ce`

### scoop-ce/ — Scoop bucket (Windows)

```
scoop-ce/
├── bucket/ce.json                  ← The manifest. Scoop finds it here.
└── README.md
```

Users install via: `scoop bucket add ce-net https://github.com/ce-net/scoop-ce && scoop install ce`

---

## Install commands (once a release is tagged)

| Platform | Command |
|---|---|
| macOS / Linux | `brew tap ce-net/ce && brew install ce` |
| macOS / Linux | `brew install ce-net/ce/ce` |
| macOS / Linux | `curl -sSL https://raw.githubusercontent.com/ce-net/ce/main/install.sh \| bash` |
| Windows (Scoop) | `scoop bucket add ce-net https://github.com/ce-net/scoop-ce` then `scoop install ce` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/ce-net/ce/main/install.ps1 \| iex` |
| Windows (Chocolatey) | `choco install ce` |
| Arch Linux | `yay -S ce-bin` |
| Any (source) | `cargo build --release` |

**IMPORTANT:** SHA256 placeholders (`PLACEHOLDER_*`) are in all packaging files right now because no `v*` tag has been pushed yet. The Homebrew formula and Scoop manifest will not install until a release is tagged and `update-sha256.sh` is run.

---

## Release process (step by step)

When ready to ship a version (e.g. `0.1.0`):

### Step 1 — Tag and push

```bash
cd ~/ce-net/ce
git tag v0.1.0
git push origin v0.1.0
```

This triggers `.github/workflows/ci.yml` which builds:
- `ce-linux-amd64.tar.gz` (ubuntu-22.04)
- `ce-linux-arm64.tar.gz` (ubuntu-22.04-arm)
- `ce-macos-amd64.tar.gz` (macos-13)
- `ce-macos-arm64.tar.gz` (macos-14)
- `ce-windows-amd64.zip` (windows-latest, produces `ce.exe`)
- `sha256sums.txt`

All uploaded to the GitHub release at `github.com/ce-net/ce/releases/tag/v0.1.0`.

### Step 2 — Update SHA256s in all packaging files

```bash
cd ~/ce-net/ce
./packaging/scripts/update-sha256.sh 0.1.0
```

This script:
1. Fetches `sha256sums.txt` from the GitHub release
2. Patches `Formula/ce.rb` (Homebrew, in this repo)
3. Patches `../homebrew-ce/Formula/ce.rb` (the tap repo, if present as a sibling)
4. Patches `packaging/scoop/ce.json` and copies it to `../scoop-ce/bucket/ce.json`
5. Patches `packaging/choco/` (Chocolatey)
6. Patches `packaging/aur/PKGBUILD`

### Step 3 — Commit and push all three repos

```bash
# Main repo
cd ~/ce-net/ce
git add -A && git commit -m "chore: bump packaging to v0.1.0" && git push

# Homebrew tap (users get updates via `brew update && brew upgrade ce`)
cd ~/ce-net/homebrew-ce
git add -A && git commit -m "chore: bump formula to v0.1.0" && git push

# Scoop bucket (users get updates via `scoop update ce`)
cd ~/ce-net/scoop-ce
git add -A && git commit -m "chore: bump manifest to v0.1.0" && git push
```

### Step 4 — Chocolatey (manual, separate account needed)

```powershell
cd packaging/choco
choco pack
choco push ce.0.1.0.nupkg --source https://push.chocolatey.org
```

### Step 5 — AUR (separate AUR account needed)

```bash
cd packaging/aur
# Push PKGBUILD to aur.archlinux.org/ce-bin.git
```

---

## Getting laptop + desktop working together

Both machines are behind NAT. They connect to each other via the Hetzner relay using libp2p circuit relay (DCUtR).

### On the laptop (macOS):

```bash
# Start node — auto-joins relay via ce-net.com/bootstrap
ce start

# Verify it's running
ce status
```

### On the desktop (Debian Linux):

```bash
# Install
curl -sSL https://raw.githubusercontent.com/ce-net/ce/main/install.sh | bash

# Start node. Behind NAT, `ce start` now auto-registers the ce-net.com bootstrap
# peers as relays too, so the node reserves a relay circuit and becomes reachable
# without any flag. (Force a specific relay with: --relay <relay-multiaddr>.)
ce start

# Get node ID — copy this
ce id
```

### Authorize the laptop (capability model — there is NO device list):

Trust is a **signed capability**, not an allowlist. To let the laptop run/sync on the desktop, the
**desktop** (the resource owner) issues a capability to the laptop, who stores it in its wallet.

```bash
# On the DESKTOP — self-issue a capability to the laptop (signed by the desktop's own key):
ce grant <laptop-node-id> --can exec,sync,tunnel --expires 90d
# → prints a capability token. Copy it.

# On the LAPTOP — hold the capability (rdev app's wallet for exec/sync; `ce wallet` for tunnel):
rdev wallet ... (config alias) ;  ce wallet add desktop 25df8f15853855c4cd2c5769cbc9789bf156534356ffead3b67c2c395f6d8ac1 --cap <token>
```

See `ce/docs/capabilities.md` for the full model (roots, attenuation, multi-level delegation,
revocation). For orgs, point nodes at a root key in `<data_dir>/roots` instead of self-issuing.

### Test the connection:

```bash
# Tunnel a port over the mesh (CE primitive) → ssh / claude code on the desktop
ce tunnel desktop 2222:22 ;  ssh -p 2222 you@localhost

# Remote exec + folder mirror are the `rdev` APP (built on CE primitives), not ce commands:
rdev exec desktop --image alpine:latest -- uname -a
rdev watch ~/ce-net desktop:ce-net      # continuous 1:1 mirror (replaces the old `mirror` app)
```

**ARCHITECTURE (perfected 2026-06-03):** CE is **primitives only** — identity, mesh transport
(AppRequest/pubsub/stream + relay/NAT), blobs, ledger/economy, the `ce-cap` capability verifier,
and `tunnel` (raw stream = transport). Features that mutate host resources (exec, file sync/delete)
are **apps**: the **`rdev`** repo (github.com/ce-net/rdev). The old `mirror` app is **archived/dead**
(superseded by `rdev watch`). New device-to-device features go in apps over AppRequest+stream+ce-cap,
NOT new node RPCs. See `ce/docs/primitives.md`.

**TRUST MODEL:** capability chains are CE's only authorization primitive (the `ce-cap` crate, spec in
`ce/docs/capabilities.md`); abilities are opaque strings. A node honors a signed, attenuating chain
rooted at its own key or a configured root; `machines.toml`/`ce devices` are GONE. Revocation =
on-chain `RevokeCapability` + expiry. Mesh-first: device-to-device over libp2p, never stored ip:port.

---

## CE project overview

**What it is:** Byzantine-fault-tolerant compute marketplace on a PoW blockchain. Run a node → mine credits → spend credits to run containers on other nodes. Like if Bitcoin ran Docker.

**Tagline:** "Pronounced 'Sea'. Donate compute, earn credits, spend credits on compute."

### Crates

| Crate | Role |
|---|---|
| `ce-identity` | Ed25519 keypair, node ID (`[u8; 32]`), sign/verify |
| `ce-chain` | PoW blockchain, all tx types, balance tracking, persistence (bincode+zstd) |
| `ce-mesh` | libp2p 0.53: Kademlia DHT, Gossipsub (7 topics), chain sync, CEP-1 routing |
| `ce-container` | Docker (bollard), gVisor detection, CPU/mem/network limits |
| `ce-node` | Orchestrator: HTTP API (axum), mining loop, mesh event loop, job manager |
| `ce-protocol` | CEP-1 wire format, CellSignal, BurnProof |
| `ce-deploy` | Hetzner provisioning, SSH deploy, Hetzner E2E tests |

### Credit model

- Nodes mine blocks every ~10s and earn `UptimeReward` credits
- Emission: starts at 1,000 credits/block, halves every 210,000 blocks, hard cap 21 billion credits
- **Money is integer base units** (never floats): `1 credit = CREDIT (10^18) base units`, wei-style. On-chain amounts are `u128`, balances `i128`. The CLI shows/parses human credit decimals; the HTTP API carries amounts as decimal strings (they exceed JSON's 2^53). `SUPPLY_CAP = 21e9 * CREDIT`.
- Run a job: `JobBid` debits payer (credits locked), `JobSettle` moves cost to host
- No balance → `POST /jobs/bid` returns 402
- Long-running cells use `Heartbeat` txs every 30s (30s billing intervals)

### Gossipsub topics

| Topic | Purpose |
|---|---|
| `ce-transactions` | Broadcast pending txs |
| `ce-blocks` | Broadcast newly mined blocks |
| `ce-heights` | Height announcements (triggers sync) |
| `ce-syncreq` | Request blocks from a given height |
| `ce-syncresp` | Serve blocks to syncing nodes (up to 500/batch, 4MB max) |
| `ce-protocol-1` | CEP-1 cell signals + capacity advertisements |
| `ce-segments` | Distributed chain archive segment manifests |

### Data directory

```
~/.local/share/ce/
├── identity/node.key     ← Ed25519 secret key (chmod 600) — BACK THIS UP
├── chain/chain.db        ← blockchain (bincode+zstd)
└── machines.toml         ← trusted device registry
```

### Key architectural constraints

1. **`Mesh` is `!Sync`** — the libp2p `Swarm` is inside. Event handlers in `ce-mesh` are free functions, not async methods on `Mesh`. Never take `&self` across an await point when `Self: !Sync`.

2. **`[u8; 64]` signatures** — serde only handles arrays up to `[T; 32]`. All 64-byte Ed25519 signatures use the local `sig_serde` module in `ce-identity`.

3. **Mining is CPU-bound** — always runs in `tokio::task::spawn_blocking`. Never block the async executor.

4. **Docker is optional** — `ce-container` silently disables itself if the Docker socket is missing. Nodes without Docker can still participate in the mesh and economy.

5. **Ports:** P2P on `:4001` (TCP + QUIC/UDP), HTTP API on `:8844`. Relay uses `:8080` internally (nginx proxies it on `:80`).

6. **Mesh-first, always** — device-to-device features route through `/ce/rpc/1` libp2p protocol, never direct HTTP. No stored IP:port for device communication.

---

## Coding standards (summary — read docs/standards.md for full detail)

- `edition = "2024"` across all crates
- `anyhow::Result` for all fallible public functions
- `tracing::{info, warn, debug}` for logging — no `println!` in library code
- No `unsafe`, no `unwrap()` in production paths
- `bincode` for wire format and disk (deterministic); `bincode + zstd level 3` for persistence
- Unit tests in `#[cfg(test)] mod tests` at bottom of each `lib.rs`
- `difficulty = 1` in chain unit tests (avoid slow PoW in CI)
- Use `NEXT_PORT` atomic counter in local integration tests (avoid port conflicts)

### Commit rules
- Author: `Leif Rydenfalk <ledamecrydenfalk@gmail.com>`
- No co-author lines
- Imperative mood, short subject, body explains WHY not WHAT
- Always pull before starting work: `git pull` in the affected repo
- Always keep docs/ up to date after changes

---

## Running and testing

```bash
cd ~/ce-net/ce

# Build
cargo build --release

# Start a node (auto-joins ce-net.com mesh)
./target/release/ce start

# Unit + integration tests (no infrastructure needed)
cargo test --workspace

# Job lifecycle test (requires Docker running)
cargo test -p ce-node job_lifecycle -- --ignored --nocapture

# Hetzner E2E tests (needs HETZNER_API_TOKEN, CE_SSH_KEY_NAME, CE_SSH_KEY_PATH in env)
cargo test -p ce-deploy -- --ignored --nocapture
```

See `ce/docs/testing.md` for the full matrix.

---

## HTTP API quick reference

Base: `http://localhost:8844`

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/status` | Node ID, height, balance |
| GET | `/bootstrap` | Multiaddrs this node advertises |
| POST | `/jobs/bid` | Submit container job bid |
| GET | `/jobs` | List all jobs |
| GET | `/jobs/:id` | Job status |
| POST | `/jobs/:id/settle` | Payer co-signs settlement |
| DELETE | `/jobs/:id` | Force-stop container |
| POST | `/transfer` | Transfer credits |
| GET | `/signals` | Last 100 CEP-1 signals (snapshot) |
| GET | `/signals/stream` | SSE push stream — signals |
| GET | `/blocks/stream` | SSE push stream — blocks |
| GET | `/transactions/stream` | SSE push stream — transactions |
| POST | `/signals/send` | Sign and broadcast CEP-1 signal |
| GET | `/atlas` | Peer capacity atlas |
| GET | `/history/:node_id` | Per-node interaction history (reputation substrate) |
| GET | `/beacon` | Verifiable public randomness (PoW tip height + hash) |
| GET | `/channels` | List open payment channels |
| POST | `/channels/open` | Open a payment channel (locks capacity) |
| POST | `/channels/receipt` | Payer signs an off-chain receipt |
| POST | `/channels/:id/close` | Host redeems the highest receipt to settle |
| POST | `/channels/:id/expire` | Payer reclaims after expiry |
| PUT | `/sync/*path` | Receive file (CE auth, trusted device only) |
| GET | `/sync/*path` | Serve file (CE auth, trusted device only) |
| POST | `/exec` | Run sandboxed command (CE auth, trusted device only) |
| POST | `/mesh-exec` | Proxy exec via libp2p mesh to a peer |
| POST | `/mesh-deploy` | Directed: deploy a cell on a specific host via the mesh (returns job_id) |
| POST | `/mesh-kill` | Directed: stop a mesh-deployed job on a specific host |
| PUT | `/mesh-sync/:node_id/*path` | Proxy sync via libp2p mesh to a peer |

---

## What's implemented vs planned

### Done
- Ed25519 identity, signing, verification
- Full PoW chain: all tx types (Transfer, UptimeReward, JobBid, JobSettle, JobExpire, TrustGrant, Heartbeat), supply cap, halving, credit escrow, balance tracking
- libp2p mesh: Kademlia DHT, Gossipsub, mDNS, QUIC, AutoNAT, DCUtR, relay client
- Chain sync (Gossipsub-based, up to 500 blocks/batch)
- Docker container management: gVisor, CPU/mem limits, image pull
- HTTP API: all endpoints above
- Mining loop (spawn_blocking)
- Job manager: bid, settle, expire, heartbeat loop (30s), capacity broadcast (60s)
- CEP-1 cell signaling, BurnProof validation
- SSE push streams: signals, blocks, transactions
- Distributed chain archive: light node mode, rendezvous-hash segments, SegmentFetch RPC
- Device registry (machines.toml), CE identity auth for sync/exec
- `ce sync` (push), `ce exec` (sandboxed remote), `ce deploy`, `ce ps`, `ce kill`, `ce fund`, `ce run`
- Auto-bootstrap from `https://ce-net.com/bootstrap`
- Hetzner E2E test suite (ce-deploy)
- Chain persistence: bincode+zstd, O(1) tip validation, transparent JSON migration
- Cross-platform packaging: Homebrew, Scoop, Chocolatey, AUR, install.sh, install.ps1
- CI: builds linux-amd64, linux-arm64, macos-amd64, macos-arm64, windows-amd64 on tag push

### Planned / in progress
- Longest-chain fork selection (reorg in mesh_event_loop) — currently first-wins
- Chain checkpoints (Phase 1c)
- TrustGrant broadcast on mesh (currently local only in machines.toml)
- Transport encryption (TLS from CE identity key, or route sync/exec through Noise-encrypted mesh)
- `ce sync --watch` (inotify/fsevents)
- `.ceignore` file support
- Human-readable node names (on-chain NameClaim)
- Multi-bootstrap resilience (multiple relay domains)
- Live mesh benchmark suite (ce-bench crate)
- Atlas-guided host selection in `ce deploy`
- Tauri dashboard UI
- Multi-provider deploy (beyond Hetzner)

---

## Windows notes

The CE binary compiles for Windows (`x86_64-pc-windows-msvc`) without code changes:
- `bollard` uses Windows named pipes (`\\.\pipe\docker_engine`) natively
- `chmod` for the identity key is already gated behind `#[cfg(unix)]` — on Windows the key is written without Unix permissions (acceptable)
- `ce-deploy` sends `chmod +x` as a remote SSH command to Linux servers — unaffected
- Docker Desktop on Windows required for container jobs

---

## Env file

`~/ce-net/ce/.env` — never commit this. Contains:
```
HETZNER_API_TOKEN=...
CLOUDFLARE_API_TOKEN=...
CE_SSH_KEY_NAME=ce-laptop
CE_SSH_KEY_PATH=~/.ssh/id_ed25519
```
