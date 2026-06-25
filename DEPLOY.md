# CE — Manual Deploy / Release Actions

Status as of 2026-06-21. Everything below is **work that an agent cannot do for you** (account
creation, release decisions, platform-specific builds, production deploys). The code is all built,
green, and **pushed to GitHub** — these are the human gates to ship it.

---

## ✅ Already done (no action needed)
- All 28 repos pushed to `github.com/ce-net/*`. 17 newly created (public): `ce-ts`, `ce-ui`,
  `ce-notes`, `ce-drive`, `ce-drive-web`, `ce-infer`, `ce-infer-ui`, `ce-fleet`, `ce-cache`,
  `ce-ci`, `ce-render`, `ce-expose`, `ce-pin`, `ce-ratio`, `ce-host`, `cookbook`, `integration`.
- Existing repos updated + pushed: `ce` (branch `phase0-settlement-burn`), `ce-rs`, `ce-coord`,
  `rdev`, `web` (all on their current branches).
- No secrets committed (`ce/.env` is gitignored + untracked — verified). No build artifacts
  committed (`target/`, `node_modules/`, `dist/` all ignored).
- `@ce-net/sdk` is publish-quality: `attw` all-green, `publint` clean, dual ESM/CJS, OpenAPI bundled.

---

## 1. npm — publish `@ce-net/sdk` (BLOCKED on you: org doesn't exist)
The package builds + authenticates fine. The publish fails with `404 Scope not found` because the
**`@ce-net` npm organization does not exist**. Your npm login (`leifrydenfalk`) is correct.

**You do (~30s):** create the org → https://www.npmjs.com/org/create → name it `ce-net`
(free tier = unlimited public packages) → ensure `leifrydenfalk` is a member.

**Then an agent (or you) runs:**
```bash
cd ~/ce-net/ce-ts
npm run build
npm publish --access public --ignore-scripts   # --ignore-scripts avoids an attw CLI env flake; attw passes when run directly
```
Alternative if you don't want the org: publish unscoped — `ce-net`, `cenet`, `ce-sdk`, `ce-client`
are all free. Costs a rename of the `@ce-net/sdk` import across ~6 consumer packages.

---

## 2. ce — merge to main + tag the first release (your call)
`ce` is on branch `phase0-settlement-burn` with this session's Wave-0 work committed + pushed.
The release CI (`.github/workflows/ci.yml`) builds + publishes binaries on `v*` tags.

**You decide + do:**
```bash
cd ~/ce-net/ce
# review, then merge the branch to main (PR or fast-forward), then:
git checkout main && git merge phase0-settlement-burn
git tag v0.1.0 && git push origin main --tags
# CI builds linux/macos/windows binaries. Then patch packaging SHA256s:
./packaging/scripts/update-sha256.sh 0.1.0
# commit + push ce, homebrew-ce, scoop-ce (see CLAUDE.md "Release process")
```

---

## 3. Cross-repo dependencies (REQUIRED before external CI/builds work)
The new repos currently use **local path deps** (`ce-rs = { path = "../ce-rs" }`) and `[patch]`
overrides. They build on this machine (siblings on disk) but **a fresh `git clone` of any one repo
won't build standalone.** Pick one:
- **A — git deps (simplest):** replace path deps with `git = "https://github.com/ce-net/<repo>"`
  pinned to a tag/rev, in: `ce-ratio`, `ce-pin`, `ce-notes`, `ce-drive`, `ce-infer`, `ce-cache`,
  `ce-ci`, `ce-render`, `ce-expose`, `cookbook`, `integration` (Rust) and the `file:../ce-ts` /
  `file:../ce-ui` deps in `ce-host`, `ce-drive-web`, `ce-infer-ui` (TS → npm versions once published).
- **B — a Cargo workspace + npm workspace** spanning the repos (keeps path deps, needs a meta-repo
  or submodules).
Recommendation: A for Rust (after a `ce-rs`/`ce-coord` tag), npm versions for TS after step 1.

---

## 4. CI wiring (copy the prepared workflows)
- `cookbook/ci.yml` → copy to `ce/.github/workflows/cookbook.yml` (boots a node, runs all 20
  recipes as contract tests — catches API/SDK/OpenAPI drift on every push).
- `integration/run.sh` → add a CI job (2-node mesh E2E; self-contained, exits non-zero on failure).
- The Wave-0 boundary gates are already in `ce/.github/` (no `/key/*` route; ratio≠cap).

---

## 5. Restart your laptop node (1 min — fixes wallet history)
The live node on `:8844` (height ~116k) is an **old binary** that 404s on `GET /transactions/:id`,
so `ce wallet history` and the dashboard tx-history table show "unavailable". The route exists in
current source. Rebuild + restart:
```bash
cd ~/ce-net/ce && cargo build --release && pkill -f 'ce start'   # then relaunch your node/service
```

---

## 6. Desktop installers (need platform toolchains)
- **CE Host** (`ce-host`) + **ce-fleet**: `cargo install tauri-cli --version '^2'` then
  `cargo tauri build` per-OS for real `.dmg`/`.msi`/`.AppImage`. Replace placeholder icons.
- **ce-fleet** Windows MSI / Linux deb-rpm: `wix build` + `nfpm package` in CI with staged
  binaries (toolchains not present on the dev mac).

---

## 7. Hospital (ce-infer) production prep
- Vendor a real quantized GGUF model and distribute via `ce-pin` (`ce-infer pull-model <cid>`); the
  engine ships with a deterministic mock backend for tests.
- Wire `ce-fleet` enrollment to your org root key; build the signed installers (step 6).
- Air-gap posture: LAN mDNS, no relay — confirm before any PHI touches it.

---

## 8. ce-expose public ingress (DESIGN ONLY — needs security review)
`ce-expose` ships the capability-gated **mesh** tunnel (private peer-to-peer) — fully working.
**Public HTTP ingress on the Hetzner relay is intentionally NOT implemented** — it's a new
relay-tier primitive. See `ce-expose/docs/public-ingress.md` for the threat model; it needs rate
limits, a kill switch, per-endpoint caps, and a security review before going live.

---

## Quick reference — what's where
Design docs for everything: `~/ce-net/PLAN/` (00 roadmap, 01–10 per workstream, 99 critic,
verify-live-sdk.md, reference/ maps). Each repo has its own README.
