# Mesh Police & Global Compute Metrics — Implementation Plan

Status: AWAITING OWNER APPROVAL. No execution until approved.
Scope: app tier only (the `ce-hub` binary + `web/site/` pages). NO changes to `ce-node`, `ce-chain`, `ce-mesh`, or any CE primitive.

All line references below are confirmed against `web/ce-hub/src/main.rs` (2712 lines) and `web/site/*.html` as of this writing.

---

## 1. What we're building

Two related features, both living entirely in the hub and the public site:

1. **Global compute metrics, shown publicly on ce-net.com.**
   - `tasks_run` — already aggregated and exposed; just render it on the homepage.
   - `compute_distributed` (total compute-ms) — NEW global accumulator; the per-job `ms` already arrives at the hub but is discarded.
   - Both made **durable** (survive hub restart) by persisting two counters alongside the existing `nodes.json` record store.
   - Honest labeling: hub metrics are *browser-node task* metrics (count + self-reported ms). They are kept strictly separate from CE-chain credit/economy metrics (`/status`, `/history`), which are a different population and a different unit (credits, not ms). The two are never summed.

2. **A misuse-detection layer ("police view")** that flags abusive submitters/nodes — volume spikes and crypto-mining shape (long pure-compute, repeated identical submissions, raw-module abuse, fan-out) — with **human-readable reasons**, and notifies the operator via an authenticated admin page with an unseen-flag indicator.

---

## 2. Architecture

Everything below is app tier. The browser node keeps running WASM/JS/Python and replying over WS exactly as today. The node binary and all CE primitives are untouched.

```
                 PUBLIC                         OPERATOR-ONLY
            ┌──────────────┐                  ┌──────────────────┐
            │ index.html   │                  │  admin.html      │  (NEW static page,
            │ g-tasks      │                  │  red dot when    │   served via nginx
            │ g-compute    │                  │  unseen_count>0  │   location / )
            │ network.html │                  └────────┬─────────┘
            │ s-tasks +    │                           │ x-ce-admin: <token>
            │ s-compute    │                           │
            └──────┬───────┘                           ▼
                   │ GET /hub/stats          GET /hub/admin/flags  (NEW, is_admin() gated)
                   ▼                                    ▲
        ┌─────────────────────────────────────────────────────────────┐
        │                          ce-hub (app tier)                   │
        │                                                              │
        │  submit_task (main.rs:739)            result arm (main.rs:644)│
        │   ─ client_ip() + rate_allow()  ──┐    ─ total_tasks++ (:655) │
        │   ─ record (ip,func,argshash)     │    ─ total_compute_ms +=ms│
        │   ─ pick node, dispatch           │    ─ feed detector(res.ms)│
        │                                   ▼                           │
        │     ┌──────────── DETECTOR (new module) ───────────┐         │
        │     │ bounded LRU: (ip,func,argshash) -> {count,ms} │         │
        │     │ per-ip distinct-node set; per-node in-flight  │         │
        │     │ H1..H6 -> flag()                              │         │
        │     └──────────────────┬────────────────────────────┘         │
        │                        ▼                                       │
        │   AppState.flags: Mutex<VecDeque<FlaggedEvent>> (cap ~200)     │
        │   AppState.total_tasks (EXISTS) + total_compute_ms (NEW)       │
        │                        │                                       │
        │   counters.json  ◄─────┴── persisted next to save_records()    │
        └──────────────────────────────────────────────────────────────┘
```

**Authoritative homes**
- Global browser-task counters (count + compute-ms): **the hub**, in `AppState`, surfaced via `snapshot()` (main.rs:2543) at `GET /hub/stats`. Durability via a new `counters.json` loaded at boot and written in `save_records()` (main.rs:2496).
- Misuse flags: **the hub**, in a new bounded `AppState.flags` ring (mirrors `blob_order` ring at main.rs:209 and `AppDebug` ring at main.rs:190).
- CE-chain economy metrics stay where they are (`ce-node` `/status`, `/history`) and are **not** touched or merged.

**Honest caveat (carry into the plan):** hub node ids are self-asserted/unsigned at the `hello` arm (main.rs:589). Behavioral flagging works, but durable per-identity reputation/banning would require signing the node hello later — a hub-only change, out of scope for v1.

---

## 3. Misuse heuristics

The hub today keeps **no per-submitter state at all** and stores **no func/args/ms history** — `submit_task` (main.rs:739) takes no `HeaderMap`, never calls `client_ip()` (main.rs:1753) or `rate_allow()` (main.rs:1737), and the `{func,args,ms}` tuple is dropped after the oneshot fires. So every heuristic except a raw node-throughput readout first needs a **submitter axis** (cheapest: `client_ip()` from `X-Real-IP`, already set by nginx) and a **bounded per-(ip,signature) stats map**.

Per-task severity is already bounded by the hub's 30s oneshot timeout (main.rs:805); the real mining vector is **repetition**, which H2/H3/H4 target.

| ID | Signal | Threshold (tunable) | Data needed | Status today |
|----|--------|--------------------|-------------|--------------|
| **H1 Submit-flood** | tasks/window from one IP | token bucket cap 20, refill 0.2/s (~1 task/5s sustained, burst 20) | `client_ip()` + `rate_allow()` | **infra EXISTS** — wire into `submit_task` |
| **H2 Repeat-signature (mining)** | same `(func, sha256(args\|code))` from same IP | >30 identical in 5 min | LRU `(ip,func,argshash)->{count,last_seen}` | **MUST ADD** (~30 LOC + bounded map) |
| **H3 Long-compute profile** | rolling median `ms` for a cluster high AND sustained | median ms >8000 AND >10 runs in 5 min | ring of recent `ms` per cluster (reuses H2 map) | **MUST ADD** (`ms` is on the wire at :649, discarded) |
| **H4 Raw-module abuse** | same raw base64 wasm (the `key.len()>64` branch, main.rs:762) repeated | same module sha256 >15x in 5 min | sha256 of `module_b64` in the LRU | **MUST ADD** (cheap) |
| **H5 Fan-out** | one IP spraying many distinct nodes at volume | >5 distinct nodes AND >50 tasks in 5 min | per-ip distinct chosen-node set | **MUST ADD** (needs submitter axis) |
| **H6 Node-saturation** (victim-side) | a node's in-flight pending jobs > advertised cores, sustained | pending > cores for >60s | per-node in-flight counter (ADD) + `Caps.cores` (EXISTS) | **PARTIAL** |

Implement order: **H1** (gate) → **H2 + H3** (mining, shared map) → **H4/H5/H6**.

**Flag record + notify.** New `AppState.flags: Mutex<VecDeque<FlaggedEvent>>` (cap ~200). `FlaggedEvent { unix, ip_or_node, heuristic: "H2", reason: String, sample: {func, args_hash, median_ms} }` where `reason` is human-readable, e.g. `"repeat-signature: count_primes x47 in 5m from 1.2.3.4 — mining shape"`. A `flag()` helper (mirror `app_err` at main.rs:1777) pushes one event, **dedup-throttled per `(ip,heuristic)`** so one offender can't flood the ring. Optional `tracing::warn!` on flag for the operator log.

---

## 4. ce-net.com surfaces

### Public counters (extend existing hooks)
- **Single source of truth:** `GET /hub/stats` → `snapshot()` (main.rs:2543 / field at :2641). nginx already proxies `/hub/` (no nginx change).
- **`tasks_run`** — already emitted; homepage just doesn't render it. Add one gauge `<div class="gauge" id="g-tasks">` at `index.html:282` (before the `~10s block time` gauge) and one `set('g-tasks',fmtInt(s.tasks_run))` in the `liveStats()` tick (index.html:535/548, which already fetches `/hub/stats` every 4s).
- **`compute_distributed`** — add `AtomicU64 total_compute_ms` to `AppState` (near main.rs:205), `fetch_add(res.ms)` in the `result` arm (main.rs:655), one JSON field in `snapshot()` (main.rs:2641). Then a sibling homepage gauge `g-compute` and a `compute distributed` hero stat on **network.html** next to the existing `s-tasks` (network.html:127/200, already SSE+poll wired to `/hub/stats`).
- Label compute-ms as **client-self-reported / best-effort** on the public board.

### Operator-only "police" view
- **Location:** a NEW static page `web/site/admin.html`, served like every other page via nginx `location /` → ce-storage. Do **NOT** put it on `/network` (fully public, unauthenticated).
- **Backend:** NEW hub route `GET /hub/admin/flags` returning `{ unseen_count, flags:[...] }`.
- **Gating:** reuse the **existing** admin mechanism — `x-ce-admin` header == `CE_HUB_ADMIN_TOKEN` (main.rs:243/429, currently checked inline at :2063-2065 for `project_delete`). Factor that comparison into an `is_admin(&headers, &st)` helper and reuse it on the new route.
- **UX:** `admin.html` prompts once for the token, stores it in `localStorage`, sends it as `x-ce-admin`, renders the flag ring, and shows a **red notification dot** when `unseen_count > 0` (mirrors the project reports-count pattern at main.rs:2161). A `POST /hub/admin/flags/seen` (or a `?seen=` marker) clears unseen.

---

## 5. Phased parallel execution plan

Five workstreams. WS-A is the only hard prerequisite for WS-B (submitter axis + counters). WS-C, WS-D, WS-E can scaffold in parallel against agreed JSON shapes.

### WS-A — Hub counters + durability + stats API  *(prerequisite for B; small)*
- Files: `web/ce-hub/src/main.rs`.
- Add `total_compute_ms: AtomicU64` to `AppState`; `fetch_add(res.ms)` at the `result` arm (main.rs:655).
- New `counters.json`: load `{total_tasks, total_compute_ms}` at boot (next to `load_records`, main.rs:2480); write in `save_records` (main.rs:2496) and the periodic saver (main.rs:464). Seed `AtomicU64` from disk instead of `::new(0)` at main.rs:408.
- Add `client_ip()` + `rate_allow()` into `submit_task` (main.rs:739) — capture the submitter IP and expose it internally for WS-B.
- Add `compute_distributed` (and `flagged` summary fields once WS-B lands) to `snapshot()` (main.rs:2641).
- **Acceptance:** `tasks_run` and `compute_distributed` are non-zero in `GET /hub/stats`, **survive a hub restart**, and `submit_task` rejects a burst >cap from one IP (H1).

### WS-B — Detector + heuristics  *(depends on A's submitter axis)*
- Files: `web/ce-hub/src/main.rs` (new `detector` module/section), reuses `client_ip`/`rate_allow`/`flag`.
- Bounded LRU `(ip, func, sha256(args|code))->{count, last_seen, ms_ring}`; per-ip distinct-node set; per-node in-flight gauge.
- Implement H1→H6 with the table thresholds (as named consts for tuning). `flag()` helper + dedup throttle. Write to `AppState.flags` ring.
- **Acceptance:** a synthetic loop submitting the same `count_primes` >30x/5min from one IP produces an H2 flag with a human-readable reason; a >8s sustained workload produces H3; raw-module repeat produces H4; all visible via the (WS-D) `/hub/admin/flags` route; ring stays bounded ≤200 and dedup-throttled.

### WS-C — Public metrics UI  *(parallel; depends only on A's JSON field names)*
- Files: `web/site/index.html`, `web/site/network.html`.
- Homepage gauges `g-tasks`, `g-compute` + `set(...)` lines in `liveStats()` (index.html:535-553).
- network.html `compute distributed` hero stat beside `s-tasks` (network.html:127/200), labeled self-reported.
- **Acceptance:** homepage and `/network` render both counters live from `/hub/stats`; values match the API; compute-ms carries the "self-reported" label.

### WS-D — Police UI + notify  *(parallel; depends on agreed flags JSON shape)*
- Files: NEW `web/site/admin.html`; `web/ce-hub/src/main.rs` (`is_admin()` helper refactor + `GET /hub/admin/flags` + seen-clear route).
- Token prompt → localStorage → `x-ce-admin`; render flag list; red dot when `unseen_count>0`.
- **Acceptance:** unauthenticated/`bad-token` request to `/hub/admin/flags` returns 401/403; correct token returns the ring; red dot appears when a new flag arrives and clears after "mark seen". `/network` shows nothing admin.

### WS-E — WASM-task instrumentation contract  *(thin; parallel)*
- Files: `web/ce-hub/src/main.rs` (the `submit_task` + `result` arm seam), optional `web/site/node.html` (no behavior change required).
- Confirm the two chokepoints (dispatch at :739, completion at :644-661) expose `{node_id, func, args, ok, ms, error}` to WS-A/WS-B; define and freeze the internal struct passed to the detector so B and the metrics counters read one shape.
- Optional stretch (flag, default-off): redundant-run — dispatch the same job to 2 nodes and compare `value` to catch fake-fast `ms` / lying nodes. Lives entirely in `submit_task`.
- **Acceptance:** detector and counters consume one shared event struct; no `ce-node`/primitive change; node still just runs WASM and replies over WS.

### Data that does NOT exist today and must be added
- Submitter identity on `/tasks` (currently fully anonymous — biggest gap).
- Any retained `func`/`args`/`ms` history (currently dropped after the oneshot).
- Durable `total_tasks` (currently resets to 0 every restart) and any `total_compute_ms` at all.
- Per-node in-flight/pending gauge (the `pending` map at main.rs:203 is global, not keyed by node).
- A per-node flag/score field and any notification indicator (none exist; only project content-reports do).

---

## 6. Open questions for the owner

1. **Police-view gating.** Confirm reuse of the existing single shared-secret `CE_HUB_ADMIN_TOKEN` (`x-ce-admin`) for v1, accepting that flags are *behavioral* and a flagged node can rejoin under a new unsigned id (durable banning needs signed node hello — defer to v2). OK, or do you want signed node hello in scope now?
2. **Notification channel.** Is an in-UI red dot on `admin.html` (+ optional `tracing::warn!` to the operator log) sufficient for v1, or do you also want push (email/PushNotification) on new flags?
3. **Public granularity.** Show `compute_distributed` publicly with a clear "self-reported, best-effort" label — agree? Or keep compute-ms operator-only and show only `tasks_run` publicly until trust signing exists?
4. **Thresholds.** Approve the starting numbers (H1 bucket 20 @ 0.2/s; H2 >30/5min; H3 median >8000ms & >10/5min; H4 >15/5min; H5 >5 nodes & >50/5min; H6 pending>cores >60s) as named, tunable consts — or set different opening values?
