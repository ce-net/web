This is a synthesis task — I have all 8 workstream digests and the architecture constraints in the prompt. No file reading needed. Let me produce the master plan.

# CE Master Roadmap — Next Build Wave

## 1. Thesis

This wave makes CE **usable and accessible to the JS/TS world, and legible to humans**. Today CE is a working Rust substrate with no second-language client, no coherent wallet, no contribution economy, no flagship consumer apps, and no zero-install demo. We fix that in dependency order: ship `@ce-net/sdk` (TS) + a hand-maintained OpenAPI spec as the foundation everything else consumes; give users a real **wallet** (balance breakdown, history, and — critically — key backup/recovery); turn on-chain settlement data into a **share-ratio reputation** signal that gates scheduling; and stand up flagship apps (**CE Host** hosting dashboard, **CE Notes** E2E-encrypted notes, **Auto-Sync** rdev v2) plus a **launch DX** package (quickstart, cookbook, in-browser playground). The entire wave honors CE's core boundary: the node stays primitives-only. Across all 8 workstreams the node needs only **four small, justified additions** — two thin read endpoints, permissive read-only CORS, and (for one later app) a relay public-ingress feature. Everything else is pure SDK/app tier.

## 2. Dependency-Ordered Build Sequence (Waves)

### Wave 0 — Unblocking Foundation
The things everything else imports. Nothing consumer-facing ships until these exist.

- **`@ce-net/sdk` (ts-sdk)** — the runtime-agnostic TS client + co-located `openapi.yaml`. Five other workstreams (hosting-ui, notes web, wallet TS, demos, autosync tooling) consume it. Build it first.
- **Wallet read-surfaces + key custody (token-mgmt, the node + custody half)** — the two thin node read endpoints (`GET /transactions/:node_id`, balance breakdown in `/status`) and `ce key export/import`. These are the only node-touching pieces here and they unblock both the wallet UX and the hosting dashboard's earnings header. Key backup is the single most dangerous gap in CE today — ship it early.
- **Node CORS + browser-node bridge contract (from demos M2)** — pull this *forward* out of the demos workstream into Wave 0. It's a tiny read-only node change that unblocks every browser-served frontend (dashboard, playground, notes web). Landing it once, early, de-risks three later workstreams.

**Rationale:** Wave 0 is the contract layer. The OpenAPI spec + SDK + CORS define the surface every app speaks to; the wallet read endpoints are the only other node changes in the whole non-relay wave, so batch all node work here and freeze the node afterward.

### Wave 1 — Economy + First Flagship App + DX Spine
Pure SDK/app tier on top of Wave 0. No further node changes.

- **Share-Ratio & Reputation (ratio)** — `ce-ratio` crate over ce-rs, computed purely from existing `/history`, `/atlas`, `/beacon`. v1 ships with the recency proxy; gates swarm scheduling and atlas ranking. Depends only on economy (already live).
- **CE Wallet — CLI/SDK/dashboard (token-mgmt, app half)** — `ce wallet` reorg, `ce-rs` + `@ce-net/sdk` wallet modules, dashboard wallet panel. Consumes Wave 0 read endpoints.
- **CE Host hosting dashboard (hosting-ui)** — the flagship "qBittorrent for compute" Tauri app. Consumes `@ce-net/sdk`, the wallet panel, and the ratio badge. This is the launch's hero artifact.
- **Launch DX: quickstart + cookbook + Rust/TS examples (demos M1, M3, M4)** — everything except the hosted playground. Doubles as CI contract tests.

**Rationale:** Ratio and wallet are cheap, high-trust-value, and have no app dependencies — they ride directly on the economy primitives. CE Host is the most demo-able single deliverable and stitches together SDK + wallet + ratio into one window, so it validates the whole foundation.

### Wave 2 — Coordination-Tier Apps + Live Playground
Apps that need ce-coord and/or the shared chunk/CRDT substrate.

- **Auto-Sync / rdev v2 (autosync)** — content-addressed delta sync engine. Builds the **file-sync half** of the chunk/CID substrate that Notes reuses. (Note: digest lists `autosync depends on notes`, but the substrate flows the other way — see risk #5. Build the shared chunk engine here, in rdev, first.)
- **CE Notes (notes)** — E2E-encrypted CRDT notes over ce-coord. CLI/TUI MVP → web app on `@ce-net/sdk`. Reuses Auto-Sync's chunk/blob substrate for attachments. Needs ce-coord's multi-writer "merge log" variant.
- **Interactive Playground (demos M5)** — hosted in-browser node + `@ce-net/sdk` at ce-net.com/play. Depends on Wave 0 CORS + browser-node bridge already being live.

**Rationale:** These need a maturity layer (ce-coord, the chunk substrate) that Wave 1 produces. The playground is gated on the browser-node bridge being battle-tested by then.

### Wave 3 — Mesh Use-Case Portfolio + Relay Infra
The post-core app portfolio, plus the only infra change in the whole plan.

- **ce-pin, ce-cache** (blob-native, ship first/lowest-risk), then **ce-render, ce-ci** (share `ce-mesh-verify`).
- **ce-expose + Relay public HTTP ingress** — the single node/infra change in the portfolio, and the only real abuse surface. Gated behind rate limits, kill switch, and per-endpoint caps before public exposure.

**Rationale:** These are breadth, not launch-critical. ce-expose's relay change carries operational/abuse risk and should not block the launch.

## 3. MVP Cut (smallest compelling public launch with live demos)

Ship these, in this order, and nothing else is required to launch:

1. **`@ce-net/sdk` + OpenAPI 3.1** (Wave 0) — the headline "CE now speaks JS/TS."
2. **Wallet basics**: balance breakdown, transaction history, and **`ce key backup`/restore** (Wave 0/1) — removes the catastrophic key-loss footgun and gives a "your money is real and recoverable" story.
3. **Share-ratio v1** with a dashboard badge (Wave 1) — the "torrent ratio for compute" hook, zero node changes.
4. **CE Host dashboard** (Wave 1) — the live, screenshot-able hero demo: running jobs, earnings, ratio, kill button.
5. **Quickstart + cookbook + the in-browser playground** (DX M1/M3/M4 + the M5 playground if CORS/bridge land in time) — "build an app on CE in 5 minutes," zero-install.

Everything else (Notes, Auto-Sync, the use-case portfolio, ce-expose) is **post-launch**. The MVP requires only the Wave 0 node changes — the node is frozen for launch after that.

## 4. Workstream Table

| Workstream | Wave | Effort | Repo | Node changes? | Key risk |
|---|---|---|---|---|---|
| `@ce-net/sdk` (ts-sdk) | 0 | L | New (`ce-ts`) | **Y** (CORS only) | API/spec drift if openapi.yaml not co-updated → contract-test in CI |
| Wallet — credits + caps (token-mgmt) | 0→1 | L | Existing (ce) + SDKs | **Y** (2 read endpoints + key export/import) | Key-export footguns; refuse any HTTP `/key/export` |
| Share-ratio & reputation (ratio) | 1 | M | New (`ce-ratio`) | **N** (v2 windowed history deferred) | v1 decay is recency proxy, not true windowed volume |
| CE Host hosting dashboard (hosting-ui) | 1 | L–XL | New (`ce-host`) | **N** (2 optional v2 read endpoints) | Live job rows are app-side estimates, not authoritative |
| Launch DX (demos) | 1 (+2 for playground) | L | Existing (ce/docs) + examples | **Y** (CORS + browser-node bridge — pulled to Wave 0) | Playground degrades to local-only if CORS/bridge slip |
| Auto-Sync / rdev v2 (autosync) | 2 | L–XL | Existing (rdev) | **N** | Receiver blob retention / GC before pull; clock-skew LWW |
| CE Notes (notes) | 2 | XL | New (`ce-notes`) | **N** (2 optional post-MVP) | Rust/JS CRDT (yrs↔yjs) byte-parity across versions |
| Mesh use-case portfolio (usecases) | 3 | XL | New (`ce-pin`, `ce-cache`, `ce-expose`, `ce-render`, `ce-ci`) | **Y** (relay public ingress, ce-expose only) | Proof-of-retrievability / exec-verification collusion; ce-expose abuse surface |

## 5. Naming / Branding

**New repos & products** (keep the flat, lowercase `ce-*` convention):
- `ce-ts` (repo) → npm **`@ce-net/sdk`** — confirmed, good. Shared panel lib → **`@ce-net/ui`**.
- **CE Host** (`ce-host`) — the hosting dashboard. Tagline: *"qBittorrent for compute."* Keep "Host" — it reads as both noun (a host node) and verb.
- **CE Notes** (`ce-notes`) — E2E-encrypted notes. Tagline: *"Local-first, end-to-end-encrypted notes on the mesh."*
- **`ce-ratio`** (crate) — keep internal/library naming; user-facing concept is **"share ratio"** (deliberately borrowing torrent vocabulary, matching CE's "donate/earn/spend" framing).
- Auto-Sync ships **inside rdev** as `rdev watch` v2 — do *not* spin a new product name; it's the file-sync half of a shared substrate.
- Portfolio apps: **`ce-pin`**, **`ce-cache`**, **`ce-expose`**, **`ce-render`**, **`ce-ci`** — all good as-is. Shared verification crate: **`ce-mesh-verify`**.

**npm scope discipline:** publish all TS packages under **`@ce-net/*`** (`@ce-net/sdk`, `@ce-net/ui`, later `@ce-net/notes`, `@ce-net/host`). One scope, one brand.

**Rust crate discipline:** SDK-tier crates are `ce-<thing>` over `ce-rs` (`ce-ratio`, `ce-coord`, `ce-mesh-verify`), matching the existing convention. Don't let any of these creep into the `ce/crates/` node workspace.

## 6. Top 5 Cross-Cutting Risks & De-Risking

1. **Node API ↔ SDK ↔ OpenAPI drift.** Five workstreams depend on the hand-maintained snapshot. *De-risk:* co-locate `openapi.yaml` in `ce-ts`, and add a **CI contract test** that runs every cookbook recipe and SDK call against a live local `ce` node on every push (the demos workstream already makes recipes executable — make that gating, not optional). One source of truth, enforced by CI.

2. **Browser auth + CORS gap.** Browsers can't read `<data_dir>/api.token`, and the node may not send CORS headers — every browser frontend (dashboard, playground, notes web, wallet panel) hits 401 on writes and CORS blocks on reads. *De-risk:* land the **read-only localhost CORS** change in Wave 0; standardize a **token-callback / ce-hub sidecar** pattern in `@ce-net/sdk` for mutating calls; document loudly that browser writes require the local proxy. Solve once in the SDK so no frontend re-invents it.

3. **Key custody is a one-way catastrophe.** Losing `node.key` loses all funds + identity forever; a careless export (scrollback mnemonic, plaintext keystore, or an HTTP export endpoint) is exfiltration. *De-risk:* ship `ce key backup` **early** (Wave 0), TTY-only mnemonic with a scary banner, encrypted keystore default, a grep test in CI that fails if key material is ever logged, and a **hard refusal** of any `/key/export` HTTP endpoint. Also loudly warn against running the same **bonded** identity on two machines (`SlashEquivocation` burns 100% of bond).

4. **"Derived, not authoritative" data quietly misleads users.** Both the ratio (recency proxy, not true windowed decay) and CE Host's live job rows (app-side cpu/mem/cr-min estimates) present *approximations as facts*. *De-risk:* show estimated values with an explicit affordance (`~`, `—`, tooltips), document the residual assumption in `ratio.md` and the host design, and scope the authoritative versions (v2 windowed history; optional `GET /jobs/:id/live`) as fast-follows gated on real demand — not launch blockers.

5. **The shared chunk/CRDT substrate has an ownership ambiguity + a retention hole.** The digests say `autosync depends on notes` and `notes depends on coord`, but the **content-addressed chunk/CID/delta engine** is actually the shared dependency both apps need, and it lives most naturally in `ce-rs::data` / rdev. Separately, `get_blob` assumes chunks are still present or mesh-fetchable — if the initiator's node GCs before the receiver pulls, commits stall. *De-risk:* **build the chunk/delta engine once in Auto-Sync (rdev) first**, expose it as the reusable substrate Notes imports; and **confirm blob-store lifetime semantics in ce-node** (initiator `put_blob` before commit so it self-announces via DHT provider records, plus a commit-time `have` re-check and bounded retry). Resolve the dependency direction explicitly before Wave 2 starts.

## 7. First Two Weeks — Concrete Action List

1. **Create `github.com/ce-net/ce-ts`**; scaffold `@ce-net/sdk` with global-fetch transport, injectable fetch, and the `Amount` bigint value type (decimal-string base units). Land Milestone "Core transport + Amount + auth."
2. **Hand-author `openapi.yaml`** from the existing http-api map, co-located in `ce-ts`. Wire a CI job that diffs it against a live node's responses.
3. **Land the Wave 0 node changes as one batched PR** in `ce`: read-only localhost CORS on GET + SSE endpoints, `GET /transactions/:node_id`, and the balance breakdown (locked/free/bond) in `/status`. Freeze further node changes for the launch after this merges.
4. **Implement `ce key backup` / `ce key restore`** on the existing `Identity` API — TTY-only encrypted mnemonic, scary banner, grep-test in CI for key-material leakage, explicit refusal of any HTTP export. Document the multi-machine bonding hazard.
5. **Spec + scaffold the browser-node bridge contract** (`window.__ceNode` in ce-hub) and the token-callback pattern in `@ce-net/sdk`, so frontends have one sanctioned auth path.
6. **Start `ce-ratio`**: implement `ratio = earned / spent` from `/history` with newcomer grace + recency factor; derive the burn-asymmetry floor from `SETTLEMENT_BURN_BPS` (don't hardcode 0.95). Write `ce/docs/ratio.md`.
7. **Stand up the `ce-host` repo** and Tauri shell + node supervisor skeleton; wire it to the SDK's `/status` and `/transactions/stream` so the earnings/ratio header renders against a real local node by end of week 2.
8. **Resolve the substrate-ownership decision** (chunk/CID engine in rdev, imported by Notes) and write it down before anyone starts Wave 2, to kill the circular `autosync↔notes` dependency.
