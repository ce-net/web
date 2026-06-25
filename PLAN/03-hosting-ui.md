# CE Host — the qBittorrent-for-compute hosting dashboard

> Workstream: `hosting-ui` · Suggested target path: `ce-host/docs/design.md`
> Depends on: none

**Summary:** CE Host is a Tauri desktop app (with a pure-web fallback) that turns "run a CE node and host jobs" into a one-window, torrent-client experience: global earnings/ratio/uptime header, a live running-jobs table with per-row kill, resource caps + scheduler, a peers/atlas view, and a capability-grants manager. It is a pure SDK client — zero new node primitives — talking to the local node's existing HTTP API (`/status`, `/jobs`, `/atlas`, `/history`, `/transactions/stream`, `/blocks/stream`, `DELETE /jobs/:id`, `/capabilities/*`). The one real gap (the `/jobs` rows carry no live cpu/mem/elapsed/credits-per-minute) is closed app-side by joining job rows against the `Heartbeat`/`JobSettle` transaction stream and the original bid spec, with two optional thin read-only node endpoints proposed for a cleaner v2. We ship a new TypeScript SDK `@ce-net/sdk` (mirroring the Rust `ce-rs` surface) plus a shared `@ce-net/ui` panel library, reusing the existing `web/` theme and animated-counter/SSE patterns. Non-technical onboarding is a 4-step wizard (install node, start, name yourself, set caps) that hides node lifecycle behind the app.

---

# CE Host — Hosting Dashboard (torrent-client-for-compute)

> Status: design. Workstream key `hosting-ui`. Pure SDK/app tier. Honors the CE primitives boundary: **no new node RPCs required for MVP**; two optional read-only HTTP additions noted explicitly.

## 1. Goals / Non-goals

### Goals
- Give an operator a single window that makes "host my machine on CE" feel like qBittorrent: open it, see what's running, see what you earn, set caps, walk away.
- Surface the **share ratio** (earned/spent) as the headline social metric, the torrent-client cultural anchor.
- Live, push-driven UI (SSE), never polling-heavy. Sub-second updates for new blocks/jobs/txs.
- Per-job control: see each running cell (image, payer, elapsed, est. credits/min) and **kill** it.
- Resource governance: CPU/mem caps, bandwidth-style throttle intent, and a scheduler ("only host 22:00–08:00", "pause on battery", "pause when I'm gaming/on AC").
- Peers/atlas view: who is on the mesh, their capacity and tags.
- Capability grants: view what this node has granted, and **revoke**.
- A 4-step onboarding wizard a non-technical user can finish in under 3 minutes.

### Non-goals
- Not a payer/job-submission console (that's a separate "spend" UI / `swarm`). CE Host is the **provider** side. It only reads job state and kills; it does not bid. (We do show "jobs I paid for" read-only in history, but submitting work is out of scope.)
- Not re-implementing trust/economy logic. The app reads `NodeStats`; it does not compute consensus weight or invent reputation rules beyond simple display.
- No new authorization model. Authorization is the existing `ce-cap` chain; the grants panel reads/revokes only.
- Not a node-internals debugger (no mempool inspection, no peer dial controls beyond what `/atlas` exposes).
- The scheduler does **not** invent a node-side "pause hosting" primitive in MVP — see §7 for how it's enforced honestly within the boundary.

## 2. Where it lives & the stack

### 2.1 Repos / layout
New app repo `ce-host` (github.com/ce-net/ce-host), sibling to `swarm`/`rdev`, plus two shared packages published from a small monorepo or as siblings:

```
~/ce-net/
├── ce-host/                     ← NEW: the desktop/web hosting dashboard
│   ├── src-tauri/               ← Tauri shell (Rust): window, tray, node lifecycle supervisor
│   │   ├── src/main.rs          ← spawns/monitors `ce start`, reads api.token, IPC commands
│   │   └── tauri.conf.json
│   ├── src/                     ← front-end (TS + Vite + Svelte; see 2.3 for framework choice)
│   │   ├── lib/panels/          ← OverviewHeader, JobsTable, CapsScheduler, AtlasView, GrantsView, Onboarding
│   │   ├── lib/stores/          ← reactive stores fed by SDK streams
│   │   └── app.css              ← imports @ce-net/ui theme
│   ├── package.json
│   └── README.md
├── ce-sdk-ts/                   ← NEW: github.com/ce-net/ce-sdk-ts → npm @ce-net/sdk
│   └── src/index.ts             ← typed reqwest-equivalent over the node HTTP API + SSE helpers
└── web/                         ← EXISTING: reuse theme/components; host the pure-web build here
    └── site/host.html           ← NEW: pure-web fallback build target (see 2.3)
```

`@ce-net/ui` (panel/theme library) starts life inside `ce-host/src/lib/ui` and is extracted only if `web/` wants to consume it; do not over-engineer a package on day one.

### 2.2 Why a new TS SDK
There is **no `@ce-net/sdk` today**. The Rust SDK is `ce-rs` (`CeClient` with `status()`, `jobs()`, `atlas()`, `history()`, `kill()`, `revoked()`, `channels()`, …). The `web/` tier hits endpoints with raw `fetch`. CE Host needs a typed client, so we port the `ce-rs` surface to TypeScript 1:1 (same method names, same string-amount discipline). This SDK is reusable by every future browser UI (token UI, network dashboard) and is the canonical answer to "talk to a local node from JS."

`@ce-net/sdk` is a thin client only: `fetch` + typed responses + SSE wrappers + an `Amount` helper (BigInt base units, never floats). No libp2p, no bollard — exactly mirroring the `ce-rs` design rule.

### 2.3 Tauri vs pure web — decision
**Ship Tauri as the primary, with a pure-web build as a strict subset.** CE already plans a Tauri dashboard (roadmap: "Tauri dashboard UI"); this *is* that deliverable, scoped to hosting.

Rationale:
- The killer onboarding feature is **lifecycle supervision**: a non-technical user must not type `ce start`. Tauri's Rust side (`src-tauri`) can detect the `ce` binary, spawn `ce start`, monitor health, read `<data_dir>/api.token` directly off disk (it lives at `~/.local/share/ce/api.token`, chmod 600 — a browser cannot read it), and offer a tray icon "still earning in background." A pure browser page cannot do any of that and cannot authenticate mutating calls without the user pasting a token.
- The same front-end bundle builds for web (`web/site/host.html`) as a **read-only / bring-your-own-token** mode: it works against a node whose `CE_API_TOKEN` the user supplies, good for remote/headless nodes and demos, but with onboarding and tray disabled. Mutating actions (kill, revoke) require the token; read panels work unauthenticated (those GETs are open).

Front-end framework: **Svelte + Vite**. Small bundle, fine-grained reactivity ideal for high-frequency SSE stores, no virtual-DOM overhead on a table that updates many times/sec. (Vanilla like `web/` does not scale to this much live state; React is heavier than needed.) The existing `web/` CSS theme (`--abyss/--panel/--line/--text/--muted/--grad`, `.dot`, animated counter, `.card`, `.btn`) is imported verbatim so CE Host matches ce-net.com visually.

### 2.4 Auth & token flow
- **Tauri:** `src-tauri` reads `~/.local/share/ce/api.token` (or honors `CE_API_TOKEN`) and injects it into a Tauri command that proxies authed calls, OR exposes it once to the front-end store at startup over IPC. Front-end never persists it.
- **Web fallback:** a settings field for `base_url` + `token`; stored in `localStorage` only if the user opts in. Read panels work without it.

## 3. Architecture

```
┌─────────────────────────── CE Host (Tauri window) ───────────────────────────┐
│                                                                               │
│   Svelte UI  ── reactive stores ──┐                                           │
│      panels                       │                                           │
│        OverviewHeader             │      @ce-net/sdk (TS)                      │
│        JobsTable                  ├──►  CeClient.status()/jobs()/atlas()/…     │──HTTP──┐
│        CapsScheduler              │      CeClient.streamTransactions()  (SSE)  │        │
│        AtlasView                  │      CeClient.streamBlocks()        (SSE)  │        ▼
│        GrantsView                 │      CeClient.kill(id) / revoke(nonce)     │   ┌──────────┐
│        Onboarding                 │                                           │   │ ce node  │
│                                   │                                           │   │  :8844   │
│   Tauri IPC ──────────────────────┘                                           │   │ HTTP API │
│      node.start() / node.stop() / node.status()  (supervises `ce start`)      │◄──┤          │
│      token.get()  (reads api.token off disk)                                  │   └──────────┘
│      caps.write() (writes a local caps file the node/app respects — see §7)   │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Data flow & the live-rows problem (honest)
`GET /jobs` returns only `{ job_id, status, payer, container_id?, cost?, bid }`. There is **no live cpu/mem/elapsed/credits-per-minute** in the row. The dashboard derives those app-side:

- **elapsed**: the app records `first_seen_at` locally the first time a job appears in `running` state (persisted in a small local store keyed by `job_id`), and renders `now - first_seen_at`. (We cannot read true container start time without a node change; see §9 optional endpoint.)
- **cpu_cores / mem_mb requested**: not on the row. For *self-submitted* jobs the app knows the bid spec; for jobs hosted *for others*, the request fields aren't surfaced. MVP shows requested cpu/mem only where known, else `—`, and shows **live aggregate** host CPU/mem from `/atlas` (the local node's own atlas entry has `cpu_cores`, `mem_mb`, `running_jobs`).
- **credits/min (est.)**: derived from the `Heartbeat` and `JobSettle` transactions on `GET /transactions/stream`. Each `Heartbeat`/`JobSettle` carries `{ id, origin, kind, amount }` (amount = base-unit string). The app maintains a rolling per-job/per-host credit accrual (sum of heartbeat amounts in the last 60s) → credits/min. For non-heartbeat jobs the row shows the `bid` ceiling and `cost` once settled.
- **earnings & ratio**: from `GET /history/:self` → `earned`/`spent` (base-unit strings) → `ratio = earned / max(spent, 1)`. Updated whenever a new block lands (`/blocks/stream`) — we re-fetch `/status` + `/history/:self` on each block, cheap and authoritative.

This join (jobs ⨝ transactions stream) is the core app logic. It's honest and requires no node change. §9 proposes two optional read-only endpoints that make it cleaner.

### 3.2 Reactive stores (Svelte)
- `status$` — re-fetched on each `/blocks/stream` event: `{ node_id, height, difficulty, balance, circulating_supply, burned_total, bond, weight }`.
- `selfHistory$` — `/history/:node_id` for self; drives earnings & ratio.
- `jobs$` — `/jobs` polled every 3s **plus** invalidated on relevant tx-stream events; merged with local `first_seen_at` + rolling accrual map.
- `atlas$` — `/atlas` every 10s.
- `txFeed$` — `/transactions/stream` SSE, ring buffer of last 200, also feeds the per-job accrual map.
- `blockFeed$` — `/blocks/stream` SSE, drives "height" + a "mining" pulse + triggers `status$`/`selfHistory$` refresh.
- `grants$` — `/capabilities/revoked` (the only on-chain grant-related read) + locally-cached issued-grant log (see §6).
- `caps$` — local caps/scheduler config (Tauri file or localStorage).

## 4. UI surface (wireframes + endpoint mapping)

Single window, left sidebar nav (qBittorrent style), main content area. Tray icon when minimized (Tauri).

### 4.1 Overview header (always visible, top strip)
```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ● HOSTING   node: aurora-rk (7f3a…be45)         height 184,302   diff 22      │
│                                                                                │
│   EARNED            SPENT            RATIO          BOND        WEIGHT          │
│   12,840.21 cr      3,002.55 cr      4.27 ▲         500 cr      500 cr          │
│                                                                                │
│   UPTIME  6d 14h    JOBS RUNNING 3    UP ▲ 2 cores / 4 GB   credits/min ~0.42  │
└──────────────────────────────────────────────────────────────────────────────┘
```
Data:
- name: `GET /names/:name` reverse — actually we resolve forward; app stores claimed name; falls back to short node_id from `/status.node_id`.
- earned/spent/ratio: `/history/:self`.
- height/difficulty/bond/weight/balance: `/status`.
- jobs running: count of `jobs$` with status `running`.
- up cores/GB: local node atlas entry from `/atlas` (`running_jobs`, plus caps).
- credits/min: rolling sum from `txFeed$` heartbeats credited to self.
- `●` dot uses the existing `.dot.on/.warn/.off` classes; green when node healthy (`/health`), amber connecting, red stopped.
Animated counters reuse `web/`'s `setNum()` easing.

### 4.2 Jobs panel (the centerpiece — torrent rows)
```
┌─ RUNNING JOBS ───────────────────────────────────────────────────────────────┐
│ IMAGE            PAYER        CPU/MEM     ELAPSED   STATUS    cr/min   ACTIONS  │
│ ───────────────────────────────────────────────────────────────────────────  │
│ alpine:3.19      a91c…02     1c / 512MB  00:14:22  running   0.10     [ kill ] │
│ pytorch:cu121    3d4e…ff     4c / 8GB    02:41:09  running   0.31     [ kill ] │
│ ffmpeg:6         a91c…02     2c / 2GB    00:03:51  running   0.01     [ kill ] │
│ ───────────────────────────────────────────────────────────────────────────  │
│ ghostd:latest    7711…ab     —           —        settled   —        (done)    │
└──────────────────────────────────────────────────────────────────────────────┘
   Filter: [ all | running | awaiting_settlement | settled | failed ]
```
Data per row from `/jobs` item `{ job_id, status, payer, container_id?, cost?, bid }` joined with:
- elapsed: local `first_seen_at`.
- cpu/mem: known only for self-submitted (else `—`).
- cr/min: per-job accrual from `txFeed$` heartbeats matched by `job_id`→`cell/host` (best-effort; `—` when no heartbeats).
- payer: `/jobs.payer` shortened; click → opens `/history/:payer` mini-card (jobs_paid, expiries, spent) as a trust hint.
- **kill** → `DELETE /jobs/:id` (SDK `client.kill(job_id)`), 204 on success; row flips to a removing state then drops on next `/jobs` poll. Confirm dialog ("Stop job and forfeit remaining bid?").
Empty state: "No jobs running. You're online and earning uptime rewards while you wait." with a link to caps.

### 4.3 Resource caps + scheduler
```
┌─ RESOURCE CAPS ──────────────────────────────────────────────────────────────┐
│  CPU cores offered   [■■■■■■□□]  6 / 8                                         │
│  Memory offered      [■■■■□□□□]  8 / 16 GB                                     │
│  Max concurrent jobs [ 4  ]                                                    │
│  Network throttle    up [ 50 MB/s ]  down [ 50 MB/s ]   (advisory)            │
├─ SCHEDULER ──────────────────────────────────────────────────────────────────┤
│  ( ) Always host                                                              │
│  (•) Host only during window   [ 22:00 ] – [ 08:00 ]                          │
│  [x] Pause when on battery     [x] Pause when CPU > [ 80% ] for 5 min         │
│                                                                               │
│  State now: HOSTING (window open, on AC)            [ Pause hosting now ]      │
└──────────────────────────────────────────────────────────────────────────────┘
```
See §7 for honest enforcement. The caps are written to a local config the node start command and the app respect (cores/mem map to the node's advertised capacity flags). "Pause hosting now" = stop accepting new work: the app sets node into a non-mining/non-advertising state by restarting `ce start --no-mine`-equivalent via the Tauri supervisor, or (boundary-friendly) simply stops advertising capacity and refuses by killing newly-arriving jobs — MVP uses the supervisor restart toggle, documented as such.

### 4.4 Peers / atlas
```
┌─ MESH ATLAS ─────────────────────────────────────────────────────────────────┐
│  NODE          CPU   MEM     JOBS   TAGS                       LAST SEEN       │
│  7f3a…be45 (me) 8    16GB    3      linux x86_64 docker manyc  now             │
│  3d4e…ff12      32   128GB   11     linux x86_64 docker gpu    4s              │
│  a91c…0288      4    8GB     0      macos aarch64 docker       12s             │
│  …                                                                            │
│  Totals: 7 peers · 96 cores · 412 GB · 4 gpu nodes                            │
└──────────────────────────────────────────────────────────────────────────────┘
```
Data: `GET /atlas` → `[{ node_id, cpu_cores, mem_mb, running_jobs, last_seen_secs, tags }]`. Self row highlighted (matches `/status.node_id`). Reuses `web/network.html` card/grid + animated totals.

### 4.5 Capability grants
```
┌─ CAPABILITIES ───────────────────────────────────────────────────────────────┐
│  GRANTED BY ME (local log)                                                    │
│  → laptop 12D3…M9VX   can: exec,sync,tunnel   nonce 0x9a..  exp 2026-09-01     │
│       [ copy token ]  [ revoke ]                                              │
│  → ci-bot a91c…02     can: deploy             nonce 0x2c..  exp 2026-07-01     │
│       [ copy token ]  [ revoke ]                                              │
│                                                                               │
│  REVOKED (on-chain)                                                           │
│  issuer 7f3a…be45  nonce 0x2c..   (mined @ 184,210)                            │
└──────────────────────────────────────────────────────────────────────────────┘
```
- "Granted by me" is a **local log**: CE has no endpoint that lists capabilities a node issued (capabilities are off-chain tokens held by the grantee). The app maintains a local record whenever the operator issues a grant *through this UI* (issuing itself shells out to `ce grant` via Tauri, or — boundary-clean — the grant is an `ce-cap` operation; MVP shells to the `ce grant` CLI through the supervisor and stores the printed token + parsed metadata).
- **revoke** → `POST /capabilities/revoke { nonce }` (SDK `client.revoke(nonce)`), 201 → moves the row to revoked once mined.
- "Revoked (on-chain)" → `GET /capabilities/revoked` → `[{ issuer, nonce }]`.

## 5. SDK surface — `@ce-net/sdk` (TypeScript)

Mirrors `ce-rs::CeClient`. All amounts are `string` (base units) on the wire; the SDK exposes an `Amount` BigInt wrapper for math/formatting. Only the methods CE Host needs in MVP are listed; the rest of the `ce-rs` surface (channels, blobs, mesh, names) is ported for completeness/reuse but unused here.

```ts
export class Amount {                       // base units, 1 credit = 10n**18n
  static fromCredits(s: string): Amount;
  static fromBase(s: string): Amount;       // from wire string
  toCredits(dp?: number): string;           // human display
  base(): bigint;
  div(o: Amount): number;                    // ratio (lossy float, display only)
}

export interface NodeStatus {
  node_id: string; height: number; difficulty: number;
  balance: string; circulating_supply: string; burned_total: string;
  bond: string; weight: string;
}
export interface Job {
  job_id: string; status: string; payer: string;
  container_id?: string; cost?: string | null; bid: string;
}
export interface AtlasEntry {
  node_id: string; cpu_cores: number; mem_mb: number;
  running_jobs: number; last_seen_secs: number; tags: string[];
}
export interface NodeHistory {
  node_id: string; jobs_hosted: number; jobs_paid: number;
  heartbeats_hosted: number; heartbeats_paid: number; expiries: number;
  earned: string; spent: string; first_height: number; last_height: number;
}
export interface TxEvent { id: string; origin: string; kind: string; amount: string; }
export interface BlockEvent {
  index: number; hash: string; prev_hash: string;
  timestamp: number; miner: string; tx_count: number; nonce: number;
}

export class CeClient {
  constructor(baseUrl = "http://localhost:8844", token?: string);

  // reads (unauthenticated GETs)
  health(): Promise<boolean>;                              // GET /health
  status(): Promise<NodeStatus>;                           // GET /status
  jobs(): Promise<Job[]>;                                  // GET /jobs
  job(id: string): Promise<Job>;                           // GET /jobs/:id
  atlas(): Promise<AtlasEntry[]>;                          // GET /atlas
  history(nodeId: string): Promise<NodeHistory>;           // GET /history/:node_id
  revoked(): Promise<{ issuer: string; nonce: string }[]>; // GET /capabilities/revoked

  // mutations (require token → Authorization: Bearer)
  kill(jobId: string): Promise<void>;                      // DELETE /jobs/:id  → 204
  revoke(nonce: string): Promise<{ tx_id: string }>;       // POST /capabilities/revoke
  claimName(name: string): Promise<void>;                  // POST /names/claim
  transfer(to: string, amount: Amount): Promise<string>;   // POST /transfer (used by "withdraw" later)

  // SSE streams (EventSource under the hood; reconnect w/ backoff)
  streamTransactions(onEvent: (e: TxEvent) => void): EventSource;    // GET /transactions/stream
  streamBlocks(onEvent: (e: BlockEvent) => void): EventSource;       // GET /blocks/stream
}
```

SSE helper handles the existing 15s keep-alive comments and reconnects on `.onerror` (the `web/` resilience pattern). Mutating calls set `Authorization: Bearer <token>`; on `401` they surface a "token needed" UI state; on `402` (e.g. revoke needing balance — not applicable, but transfer) a friendly message.

## 6. Data model (app-local)

The app persists a small local store (Tauri: a JSON file in the app config dir; web: `localStorage`). None of this is consensus state.

```ts
interface JobLocal { job_id: string; first_seen_at: number; requested_cpu?: number; requested_mem_mb?: number; }
interface AccrualWindow { job_id: string; samples: { t: number; amount: bigint }[]; } // last 60s of heartbeats
interface IssuedGrant {                       // local log of grants made via this UI
  grantee: string; abilities: string[]; nonce: string; expires?: string; token: string;
}
interface CapsConfig {
  cpu_cores: number; mem_mb: number; max_jobs: number;
  net_up_mbs?: number; net_down_mbs?: number;
  scheduler: { mode: "always" | "window"; window?: [string, string];
               pause_on_battery: boolean; pause_cpu_pct?: number; };
}
interface AppConfig { base_url: string; token?: string; node_name?: string; caps: CapsConfig; grants: IssuedGrant[]; }
```

## 7. How the scheduler/caps compose CE primitives (honest boundary)

The node has no "set my caps" or "pause hosting" HTTP endpoint, and we must not add one as a primitive (mutating host behavior = app/lifecycle concern). Enforcement is therefore at the **node-lifecycle** layer, owned by the Tauri supervisor:

- **CPU/mem caps & tags**: written into the local caps config and applied as flags/env to `ce start` when the node is (re)launched. The node already advertises capacity in `/atlas`; caps shape what it advertises and accepts.
- **Pause / schedule**: the supervisor starts/stops or restarts the node (e.g. `--no-mine` to stop earning uptime + advertising, or full stop). "Host only 22:00–08:00" = a cron-like timer in `src-tauri` that toggles node state at the boundaries. "Pause on battery / high CPU" = OS power/CPU polling in `src-tauri` that toggles the same.
- **Network throttle** is advisory in MVP (displayed, persisted, but enforced only if the node/OS supports it later) — labeled "(advisory)" so we don't lie to the user.

This keeps CE-the-node as primitives only. If a future need arises for runtime "drain" without restart, that is a candidate node feature evaluated separately — out of scope here.

## 8. Onboarding (non-technical, 4 steps)

Tauri-only (web fallback skips to "enter base_url/token"). The wizard launches when no node/token is detected.

```
Step 1  INSTALL        Detects `ce` on PATH / ~/.local/bin. If missing:
                       one-click runs the platform installer (brew / install.sh / scoop)
                       via the supervisor; shows progress; verifies `ce id`.
Step 2  START          "Start hosting" → supervisor runs `ce start`, waits for /health=ok,
                       reads ~/.local/share/ce/api.token. Shows the green ● dot.
Step 3  NAME YOURSELF   Optional: pick a handle → POST /names/claim. "aurora-rk is yours
                       once it's mined (~a minute)." Skippable.
Step 4  SET CAPS        Slider defaults to 50% cores / 50% RAM, "Always host".
                       "You're live. Close this window — CE keeps earning in the tray."
```
First-run also explains the ratio in one sentence ("Host more than you spend and your ratio climbs — like seeding."). All copy follows `ce/docs/design.md`; no emojis.

## 9. What changes in the node? (explicit)

**MVP: nothing.** Every panel is built on existing endpoints: `/health`, `/status`, `/jobs`, `DELETE /jobs/:id`, `/atlas`, `/history/:node_id`, `/transactions/stream`, `/blocks/stream`, `/capabilities/revoked`, `POST /capabilities/revoke`, `POST /names/claim`.

**Optional, read-only, boundary-safe v2 additions** (each a thin wrapper over existing chain/job state, no consensus change — they only make the jobs panel exact instead of derived):
1. `GET /jobs/:id/live` → `{ cpu_cores, mem_mb, started_at, cumulative_paid }` so the row shows true requested cpu/mem, real elapsed, and exact accrual instead of the SSE-join estimate. (Job request fields + container start time already exist in `ce-node`'s job store; this just surfaces them.)
2. `GET /history` (no id) → bulk `NodeStats` for all known nodes, to enrich the atlas/peer view with ratio per peer in one call instead of N `/history/:id` fetches.

These are reads only and stay inside the primitives/economy boundary (the economy map already recommends exactly these surfaces). They are **not** required to ship; the design works without them.

## 10. Milestones

(see structured milestones list) — summary: SDK first, then shell+supervisor, then panels, then onboarding/polish.

## 11. Testing strategy

- **SDK unit tests** (`@ce-net/sdk`): mock-fetch each method against the *real* JSON shapes captured from a running node (`vitest`). Assert string-amount handling never coerces to JS number; `Amount` round-trips 10^18-scale values. SSE parser tested against recorded `data: {…}\n\n` fixtures incl. 15s keep-alive comments.
- **Live integration**: a `cargo`-spawned ephemeral `ce start` (mirroring `ce/docs/testing.md` patterns) + a headless Playwright run that bids a tiny local job (or uses `mesh-deploy` on a second node) and asserts: row appears, elapsed ticks, kill issues `DELETE /jobs/:id` and the row clears.
- **Ratio/earnings**: deterministic chain in test mode (difficulty 1), submit two JobSettles, assert header shows `earned/spent` and ratio matching `/history`.
- **Supervisor (src-tauri)**: Rust unit tests for state machine (detect→install→start→healthy→pause→resume), with the `ce` binary mocked by a stub script.
- **Web-fallback**: a smoke test that read panels render with no token and mutating buttons show the "token required" state.
- **Visual**: snapshot the panels against the `web/` theme to catch drift from ce-net.com.

## 12. Risks

(see structured risks list)

## 13. Open questions

(see structured openQuestions list)


## Milestones

| Milestone | Deliverable | Effort |
|---|---|---|
| M0 — @ce-net/sdk (TS) MVP | New ce-sdk-ts repo / npm @ce-net/sdk: CeClient with status/jobs/job/atlas/history/revoked/kill/revoke/claimName, Amount BigInt helper, streamTransactions/streamBlocks SSE wrappers w/ reconnect, typed interfaces matching real JSON shapes, vitest mock-fetch + SSE fixture tests. | M |
| M1 — Tauri shell + node supervisor | ce-host repo with Svelte+Vite front-end skeleton, web/ theme imported; src-tauri supervisor that detects/installs ce, runs `ce start`, reads api.token off disk, exposes node.start/stop/status + token.get over IPC; tray icon; pure-web build target wired (host.html) in read-only/BYO-token mode. | L |
| M2 — Overview header + Jobs panel | OverviewHeader (earnings/spent/ratio/bond/weight/uptime/credits-min) fed by /status + /history + tx-stream accrual; JobsTable with derived elapsed (local first_seen) + cr/min (heartbeat join) + per-row kill (DELETE /jobs/:id) + payer trust mini-card (/history/:payer). Animated counters + status dots reused. | L |
| M3 — Caps/scheduler + Atlas + Grants | CapsScheduler panel writing CapsConfig and driving supervisor restart/pause (window/battery/cpu toggles, advisory net throttle); AtlasView from /atlas with self-highlight + totals; GrantsView with local issued-grant log, copy/revoke (POST /capabilities/revoke) and on-chain /capabilities/revoked list. | M |
| M4 — Onboarding wizard + polish + packaging | 4-step wizard (install→start→name→caps) with one-click installer, /names/claim, defaults; empty/error/401/402 states; reconnect UX; Tauri bundles for macOS/Linux/Windows + web build deployed to web/site/host.html; docs + README. | L |
| M5 (optional) — node read-only v2 endpoints | In ce-node: GET /jobs/:id/live (true cpu/mem/started_at/cumulative_paid) and GET /history (bulk NodeStats); SDK + Jobs/Atlas panels switch from SSE-derived estimates to exact values. Read-only, no consensus change. | M |


## Risks

- Live job rows are derived, not authoritative: /jobs has no cpu/mem/elapsed/credits-min, so cr/min and elapsed are app-side estimates (heartbeat-stream join + local first_seen). Estimates can drift or show '—' for jobs without heartbeats; only the optional M5 GET /jobs/:id/live makes them exact.
- Scheduler/pause has no node primitive: enforcement is via Tauri restarting/stopping `ce start`, which interrupts uptime rewards and mesh presence. A restart-based pause is coarse; users may expect a graceful 'drain' that doesn't exist. Must be documented honestly and not over-promised.
- Issued-capability list is local-only: CE has no endpoint listing grants a node issued (tokens live with grantees), so the Grants panel can only show grants made through this UI. Grants made via CLI elsewhere won't appear, which can confuse operators.
- Token exposure: Tauri reading ~/.local/share/ce/api.token and passing it to the front-end widens the surface vs. keeping it server-side; must keep it in IPC/Tauri memory, never persist to localStorage, and the web fallback's BYO-token path needs clear warnings.
- Caps→node mapping requires a restart in MVP (flags applied at `ce start`), so changing cores/mem mid-session bounces the node and any running hosted jobs — needs a confirmation and ideally batching of cap edits.
- No @ce-net/sdk exists today; building and versioning a new public npm package (string-amount discipline, SSE reconnection) is real surface area that other UIs will depend on, so getting the Amount/precision contract wrong is costly to change later.
- SSE scale: a busy node's /transactions/stream can be high-volume; the per-job accrual join must bound memory (60s ring) and avoid main-thread jank in the table — Svelte fine-grained reactivity helps but needs profiling.

## Open questions

- Should CE Host bundle/auto-install the node, or hard-require a pre-installed `ce`? Bundling improves non-technical onboarding but couples release cadence of ce-host to ce and complicates code-signing/notarization.
- Is a restart-based 'pause hosting' acceptable for MVP, or do we need a node-side graceful drain (stop accepting new jobs without killing running ones)? The latter is arguably a legitimate node feature and would change the boundary call in §7.
- Do we surface a 'withdraw earnings' action (POST /transfer to an external wallet) in this provider UI, or keep CE Host read+kill only and leave transfers to a separate wallet UI?
- For credits/min, can we reliably correlate Heartbeat txs to a specific job_id from the transactions stream alone (kind=Heartbeat carries cell/host but the stream event is {id,origin,kind,amount})? If not, M5 GET /jobs/:id/live becomes effectively required rather than optional.
- Should the issued-grants log live only locally, or should we propose a node-side capability issuance log endpoint so the Grants panel is complete across machines? (Leans toward keeping it app-local to honor the boundary.)
- Framework: confirm Svelte over the existing vanilla approach used in web/ — vanilla keeps web/ consistent but won't scale to this much live state; do we accept two front-end styles in the org?
