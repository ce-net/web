Perfect! The comprehensive map is complete. Let me output the final result:

# CE Web Tier Architecture & Components

## Overview
The web tier is a read-only static site + WebSocket relay sidecar that enables browser nodes (phones, laptops) to join the CE mesh and execute WASM compute tasks. No frameworks, no build tooling—vanilla HTML, CSS, and JavaScript paired with a Rust sidecar.

---

## Architecture

### Two-Service Model
1. **Static Pages** (`/Users/07lead01/ce-net/web/site/`) — served by nginx on `:80`
2. **ce-hub Sidecar** (`/Users/07lead01/ce-net/web/ce-hub/`) — Rust service on `:8970`, proxied at `/hub/` by nginx

**Important:** The CE node (`ce`) runs on `:8844` with value-moving APIs (closed to localhost-only). The web tier **never touches the node's surface**—it's a separate, stateless relay for browser peers only.

---

## Components

### 1. ce-hub (Rust Sidecar)
**Purpose:** Browser-node rendezvous, task dispatch, live mesh stats.

**Tech Stack:**
- **Framework:** Axum (async web framework)
- **Async Runtime:** Tokio (multi-threaded)
- **Serialization:** serde + serde_json
- **WebSocket:** axum's built-in WS upgrade
- **Server-Sent Events (SSE):** axum::response::sse
- **CORS:** tower-http cors layer (permissive)
- **Compiled Target:** x86_64-unknown-linux-musl (zigbuild)

**Port:** `:8970` (internal on relay); proxied as `/hub/` by nginx.

**Services:**
| Route | Method | Purpose |
|-------|--------|---------|
| `/node` | WS | Browser node connection; receives `hello` (registration), sends `job` (task), receives `result` |
| `/tasks` | POST | Dispatch a WASM job to a live node; returns result or timeout |
| `/stats` | GET | Snapshot: node count, aggregated CPU/RAM/storage/GPU, total tasks run |
| `/stats/stream` | GET (SSE) | Live stats feed (1.5s updates); powers the network dashboard |
| `/nodes` | GET | List all live nodes with per-node capabilities and task counters |

**Protocol (JSON over WebSocket):**
- **Node → Hub:**
  - `{"t":"hello","id":"<uid>","caps":{...cores, ram_gb, storage_gb, gpu, webgpu, platform...}}`
  - `{"t":"hb"}` — heartbeat (10s interval)
  - `{"t":"result","jid":"<job_id>","ok":true/false,"value":"<result>","ms":<millis>,"error":"<msg>"}`
- **Hub → Node:**
  - `{"t":"welcome","id":"<uid>"}`
  - `{"t":"job","jid":"<id>","module_b64":"<wasm>","func":"<name>","args":[...i64],"ret":"i32"}`

---

### 2. Static Pages

#### `/site/index.html` — Landing Page (25.9 KB)
**Displays:** Hero + 5 primitives (identity, mesh, ledger, capabilities, compute) + SDK examples + install commands.

**Interactivity:**
- Live "sonar" ping: fetches `/hub/stats` every 4s to show node count + core count.
- Copy-to-clipboard buttons.
- Fallback to `/health` if hub unreachable.

**Tech:** Vanilla JS + inline CSS, responsive grid layouts, animated gradients.

---

#### `/site/node.html` — Browser Node / In-Browser Compute Node (13.6 KB)
**Displays:** Device capabilities (CPU cores, RAM, storage, GPU), activity log, task counter, uptime.

**What it does:**
1. Opens WebSocket to `/hub/node` and announces device capabilities.
2. Detects: CPU (`navigator.hardwareConcurrency`), RAM (`navigator.deviceMemory`), storage (`navigator.storage.estimate()`), GPU (WebGL renderer), WebGPU.
3. Receives WASM jobs; decodes base64 and instantiates WebAssembly.
4. Executes function and returns result.
5. Optional: Screen wake-lock to prevent sleep.

**Key code flow:**
```javascript
const caps = await detect(); // cores, ram_gb, storage_gb, gpu, webgpu, platform
ws.send(JSON.stringify({t:'hello', id:ID, caps}));
// receive job → instantiate wasm → call function → send result
```

**Tech:** WebAssembly.instantiate(), device APIs, local storage (persists node ID), activity log (prepend, cap at 60).

**Platforms:** iOS Safari, Android Chrome (WakeLock + WebGL work on mobile).

---

#### `/site/network.html` — Live Network Dashboard (12.3 KB)
**Displays:** Real-time mesh stats (node count, cores, RAM, storage, GPU tally) + individual node cards + task-push UI.

**What it does:**
1. SSE stream to `/hub/stats/stream` (1.5s updates).
2. Polling fallback to `/hub/stats` every 3s (CDN buffering resilience).
3. Fetches `/hub/nodes` every 2.5s; renders node cards.
4. Task UI: dropdown (count_primes/fib/sum_squares), input arg, push button.
5. Displays result + runtime from first responding node.

**Tech:** EventSource (SSE), animated counters (450ms cubic easing), grid layout (auto-fill 220px), fetch with cache-busting.

---

### 3. Demo WASM Module
**Location:** `/Users/07lead01/ce-net/web/ce-hub/demo-wasm/src/lib.rs`

**Exports:**
- `count_primes(n: i32) → i32` — trial-division prime count (CPU burn).
- `fib(n: i32) → i64` — iterative Fibonacci.
- `sum_squares(n: i32) → i64` — sum of i² for i in [0..n].

**Compiled:** `demo.wasm` (~589 bytes), base64-encoded in ce-hub's modules map at startup.

---

## Browser ↔ Node Communication

### Initialization
```
Browser (node.html)
  → WebSocket to ce-hub:8970/node
  → {"t":"hello", "id":"<ID>", "caps":{cores, ram, storage, gpu, webgpu, platform}}
  ← {"t":"welcome", "id":"<ID>"}
```

### Task Execution
```
User/API → POST /hub/tasks {"func":"count_primes", "args":[200000]}
  ↓
ce-hub selects least-loaded node, creates jid, sends:
  → {"t":"job", "jid":"j0", "module_b64":"<wasm>", "func":"count_primes", "args":[200000]}
  ↓
Browser node decodes, instantiates WASM, calls function, sends:
  → {"t":"result", "jid":"j0", "ok":true, "value":"...", "ms":<elapsed>}
  ↓
ce-hub matches jid to pending request, returns HTTP response
```

### Heartbeat & Presence
- Every 10s: Browser sends `{"t":"hb"}`
- Every 35s of silence: ce-hub removes node from registry
- Stale node pruning: background task every 10s

---

## Tech Stack Summary

### Frontend
| Layer | Tech | Notes |
|-------|------|-------|
| Language | Vanilla JavaScript | No frameworks, no build step |
| HTML | Semantic HTML5 | No templating |
| CSS | Inline `<style>` | Custom properties (CSS vars), no preprocessor |
| WASM | WebAssembly spec | Instantiate + call exported functions |
| Device APIs | Navigator, Storage, WebGL, WebGPU | Feature detection for capabilities |
| WebSocket | Std browser WS API | JSON protocol over frames |
| SSE | EventSource API | Read-only stats stream |

### Backend (ce-hub)
| Layer | Tech | Notes |
|-------|------|-------|
| Language | Rust (2021 edition) | async/await, no_std for WASM demo |
| Framework | Axum 0.7 | Router, middleware, extractors |
| Async | Tokio 1 (multi-threaded) | Spawns pruning task, per-connection node pump |
| WS | axum::extract::ws | Upgrade + message loop |
| SSE | axum::response::sse | Event stream + keep-alive |
| Serialization | serde + serde_json | Derive macros, no custom logic |
| CORS | tower-http CorsLayer | Permissive (allow all) |
| Storage | In-memory HashMap + Arc<Mutex> | Nodes map, pending jobs map, task counter |
| Binary | x86_64-unknown-linux-musl | Static binary via zigbuild |

### Deployment
| Layer | Tech | Notes |
|-------|------|-------|
| Web Server | nginx | Reverse proxy, static serving, SSE buffering off |
| Service Manager | systemd | ce-hub.service unit |
| TLS | Cloudflare (Flexible) | Origin speaks HTTP |
| Server | x86_64 Linux | DigitalOcean Droplet (178.105.145.170) |

---

## Reusable Components for New UIs

### 1. Styling System
- CSS custom properties (--abyss, --panel, --line, --text, --muted, --faint, --grad).
- Theme already deployed on all 3 pages.
- Responsive grid helpers (clamp + auto-fit).

### 2. Animated Counter Component
- `setNum(elementId, value, decimalPlaces)` — smooth 450ms easing.
- Uses `requestAnimationFrame` and cubic interpolation.

### 3. Status Indicator / Dot
- `.dot` class: base (gray), `.on` (green pulse), `.warn` (amber), `.off` (red).
- Sonar animation via `box-shadow` (no canvas).

### 4. Grid Card Layouts
- 4-column stat cards (responsive collapse).
- `.card` with `.k` (title) and `.v` (value) hierarchy.
- Auto-fill grid for node cards (220px min).

### 5. Activity Log / Terminal
- Monospace, prepend lines, cap at N entries.
- Timestamped + color-coded (ok=green, er=red, jb=cyan).

### 6. Button Variants
- `.btn` (outline), `.btn.primary` (gradient fill), `.btn.sm` (compact).
- Transitions + hover state.

### 7. API Client Helpers
- `fetch()` with `cache:'no-store'` (live data).
- JSON parse error handling.
- User-friendly error messages.

### 8. WebSocket State Machine
- Connection states: warn (connecting), on (live), off (stopped).
- Reconnect logic (2s retry).
- Message routing by `message.t`.

### 9. Device Capability Detection
- Normalized `Caps` object: cores, ram_gb, storage_gb, gpu, webgpu, platform.
- Fallback handling (deviceMemory Chromium-only).
- GPU detection via WebGL vendor string.

### 10. SSE / Polling Resilience
- SSE for primary channel (1.5s updates).
- Polling fallback every 3s (CDN buffering workaround).
- EventSource with `.onerror` reconnect.

---

## API Endpoints (Browser-Facing, `/hub/`)

### Public (CORS open)
- `GET /stats` → `{nodes, cores, ram_gb, storage_gb, gpus, webgpu_nodes, tasks_run}`
- `GET /stats/stream` → EventSource (SSE)
- `GET /nodes` → `{nodes: [{id, short, cores, ram_gb, storage_gb, gpu, webgpu, platform, tasks_run, age_s}]}`
- `POST /tasks` → `{module?, func, args, ret?, target?}` → `{node, func, args, ok, value, ms, error?}`

### WebSocket (`/node`)
- `{t:"hello", id, caps}` — registration
- `{t:"job", jid, module_b64, func, args, ret}` — task dispatch
- `{t:"result", jid, ok, value, ms, error?}` — result
- `{t:"hb"}` — heartbeat

---

## Future Extensibility

### Hosting UI (Torrent-Client-for-Compute)
- **Reuse:** WebSocket state machine, device display, animated counters, status dots, grid layouts.
- **New:** File tree browser, piece download progress, peer/piece matrix, bandwidth graphs.
- **Backend:** Extend ce-hub with `/upload`, `/files`, `/download`; add piece registry.

### Token Management UI
- **Reuse:** Activity log, CSS theme, buttons, API helpers.
- **New:** Token list, transaction history, balance viz, delegation chain viewer.
- **Backend:** Extend ce-hub with `/tokens`, `/balances`, `/transactions` (proxied from CE node or cached).

### Real-Time Monitoring
- **Reuse:** SSE pattern, animated counters, grid layouts, activity log.
- **New:** Resource graphs (CPU/RAM over time), per-task timeline, error rate sparklines.
- **Backend:** Add time-series buffer to ce-hub; emit quantiles/summary stats.

---

## File Inventory

```
/Users/07lead01/ce-net/web/
├── site/
│   ├── index.html          (25.9 KB) — landing page, sonar ping
│   ├── node.html           (13.6 KB) — browser node, WASM executor
│   └── network.html        (12.3 KB) — live dashboard, task push UI
├── ce-hub/                 (Rust sidecar)
│   ├── Cargo.toml          — axum, tokio, serde, base64
│   ├── src/main.rs         (335 lines) — WS hub, SSE stats, job dispatch
│   ├── demo-wasm/src/lib.rs (64 lines) — count_primes, fib, sum_squares
│   └── modules/
│       └── demo.wasm       (589 bytes) — compiled WASM exports
└── deploy/
    ├── nginx.conf          — routing, WS upgrade, SSE buffering off
    ├── deploy.sh           — scp static files + nginx config
    ├── deploy-hub.sh       — build, deploy ce-hub binary + systemd restart
    └── ce-hub.service      — systemd unit
```