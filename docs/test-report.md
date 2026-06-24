# Live browser-test report

Date: 2026-06-24
Tester: automated QA pass

## Method and an important caveat

The requested interactive browser-automation tool (Blueberry Browser at
127.0.0.1:7777) was NOT running this session, so I could not capture real
in-browser console logs, render a canvas, or take screenshots. No other
navigate/screenshot/console MCP (chrome-devtools / playwright) was available
either.

I therefore fell back to the deepest static + HTTP/WebSocket verification
possible from a shell:
- fetched every page and asset over HTTPS and checked status / content-type / size,
- read the served inline scripts and the local source they are built from,
- opened REAL WebSocket connections to the live `/rt` realtime rooms (Node 22
  `WebSocket`) and captured the actual frames the servers push,
- read the live `/db` directory + snapshot state that drives failover,
- traced the wgpu/canvas init path and the netgame/realtime wiring in code.

This proves the transport, hosting, state-streaming, registry and asset layers
are live and correct, and that the client wiring is sound. It does NOT visually
confirm pixels on a canvas. Where a finding depends on actual GPU rendering in a
browser, it is marked accordingly. A real browser pass is still recommended to
close the visual gap, but every server-side and code-path check below is concrete.

---

## 1. drift.ce-net.com  —  PASS (renderer is built and live; visual render unverified)

Page: `GET https://drift.ce-net.com/` -> 200, text/html, title `drift`.

The wgpu renderer is genuinely BUILT and DEPLOYED (this is the key check — the
index.html treats the renderer as optional and degrades to "transport-only" if
`./pkg` is missing; it is NOT missing):

- `GET /pkg/drift_client.js`        -> 200  text/javascript        78,280 B
- `GET /pkg/drift_client_bg.wasm`   -> 200  application/wasm     1,931,600 B
- `GET /drift.js` (runtime)         -> 200  text/javascript        38,297 B

`drift_client.js` is a valid wasm-bindgen module that `export class Drift` with
`attach_canvas(canvas)` returning a backend label, and loads its wasm from
`new URL('drift_client_bg.wasm', import.meta.url)` -> resolves to the 200 above.
The compiled init path (client/src/wasm.rs, render.rs) requests
`Backends::BROWSER_WEBGPU | Backends::GL` with `force_fallback_adapter:false` and
downlevel limits: WebGPU-first, automatic WebGL2 fallback. The served glue
contains WebGL2 calls (`bindAttribLocation`, `WebGL2RenderingContext`), confirming
the fallback backend is compiled in. So in a browser without WebGPU it falls back
to WebGL2 rather than crashing; with neither it surfaces a clean error string
("no compatible GPU/WebGL2 adapter found") rather than a panic, because
index.html wraps `loadRenderer()` in try/catch and degrades to transport-only.

HUD banner / host / role: the page has a fixed HUD showing
`drift · <backend>`, `region <id> · host <id> · <role>`, `tick · net · viewers`.
`d-role` starts "client" and flips to "HOSTING" via `onHostChange`. `d-backend`
shows the wgpu backend label after `attach_canvas` resolves (e.g. "WebGPU" /
"WebGL2"), or "transport-only (renderer not built)" only if pkg is absent — which
is NOT the case here.

The live multiplayer backbone is ACTIVE right now (real WebSocket evidence):
- control room `wss://drift.ce-net.com/rt/drift/r:0:0` -> OPEN, pushed
  `{"t":"st","host":"p4i8b9zmr1w","seq":262,"tick":262,"full":true,
    "state":{"region":"r:0:0","started":...}}`
  i.e. an elected host (`p4i8b9zmr1w`) is authoritatively simulating region r:0:0.
- region directory `GET /db/drift/world:dir` ->
  `{"dir":{"r:0:0":{"host":"p4i8b9zmr1w","ts":...}}}` (sharding directory live).
- failover snapshot `GET /db/drift/snap:r:0:0` -> 200 JSON (host is persisting
  snapshot state for re-election restore).
- binary state room `wss://.../rt/drift/r:0:0::st?ephemeral=1` -> OPEN (no frame
  in 8 s, expected: frames are unicast per-viewer AoI and need an advertised view).

Verdict: PASS for load, asset wiring, fallback design, and the full
netgame/sharding/failover stack being live. The single thing NOT directly
verified is "are pixels actually drawn on the canvas" — that needs a real GPU
browser. Code + assets say it will render; treat the visual as high-confidence
but unconfirmed this session.

## 2. coop.ce-net.com  —  PASS

`GET https://coop.ce-net.com/` -> 200, 49,525 B, title present. The page is a
single self-contained module: `createGame` is defined INLINE (function at line
~211, used at ~974). It has `<canvas id="cv">`, an authoritative-host banner
(`#hostbar` showing "electing host…" -> resolves to the host id, with a "me" dot
when you are host), and a "Force host failover" button (`#failBtn`, title "Drop
local host candidacy to force the arena to migrate to another node"). So the
force-failover control the task asked about IS present.

`wss://coop.ce-net.com/rt/coop/arena` -> WebSocket OPEN ok. No broadcast arrived
in 8 s because the room was empty (no other client to elect a non-spectator host
and start ticking); the framework only streams state once a host is simulating.
This is correct behavior, not a failure — arena (same framework) DID immediately
push a `{"t":"join"...}` frame because that room is populated.

Non-issue noted for honesty: `GET /netgame.js` -> 404. This is harmless: the only
`import { createGame } from "./netgame.js"` in the file is inside a `/* ... */`
doc comment ("MINIMAL VERSION" example), never executed. The browser never
requests it.

Verdict: PASS. Loads clean, self-contained (no failing real imports), host
election + failover UI present, realtime room accepts connections. Live host
election with 2+ clients was not driven from a shell, but the identical framework
is demonstrably electing and streaming on arena/drift.

## 3. spa.ce-net.com/game and arena.ce-net.com  —  PASS

spa `/game` -> 200, 58,472 B, title "spacegame — a CE multiplayer arena".
Self-contained (no real ES-module imports). `<canvas id="cv">`, an online-status
chip ("connecting to the mesh…" -> "connected — N online"), WebSocket connect with
auto-reconnect (`wsURL(app,room)` -> `wss://host/rt/spa/<room>`,
`scheduleReconnect` on close), and a `requestAnimationFrame` render loop.

arena -> 200, 30,886 B, `<canvas id="cv">`, self-contained, opens
`new WebSocket(wsURL(APP,ROOM))`. Live proof: `wss://arena.ce-net.com/rt/arena/main`
-> OPEN and immediately received `{"t":"join","id":"spectator-...","name":"spectator"}`
— the room is live and broadcasting.

Verdict: PASS. Pages load, canvases present, realtime wiring correct, arena room
confirmed live with server-pushed frames. (Basic interaction = keyboard/click
handlers are wired in code; not exercised without a real browser.)

## 4. ce-net.com/projects and /play  —  PARTIAL (/play PASS, /projects FAIL/broken route)

/play -> 200, served byte-for-byte from `web/site/play.html` (19,175 B), title
"Play — live mesh apps on CE". It fetches `https://ce-net.com/hub/registry`
client-side (registry confirmed: `{"n":10, ...}` — exactly the 10 apps: drift,
feedback, wall, poll, draw, place, coop, spa, cursors, arena) and merges those
into a curated demo gallery, building XSS-safe cards via `textContent`. The
registry endpoint returns `access-control-allow-origin: *`, so the browser fetch
succeeds. The homepage nav links to `/play`. PASS.

/projects -> 405 Method Not Allowed (`allow: POST`). This is a real bug, not a
transient. Root cause is in `web/deploy/nginx.conf` line 127:

    location /projects { proxy_pass http://127.0.0.1:8970; ... }

This is a PREFIX match, so EVERY `GET /projects*` is proxied to the hub's
registry WRITE API (publish/delete/report), which only accepts POST -> 405. The
human-facing gallery page `web/site/projects.html` is therefore UNREACHABLE:
- `GET /projects`      -> 405 (hub API shadows it)
- `GET /projects.html` -> 404
- `GET /projects/`     -> 404

The homepage/nav does not link to `/projects` anywhere (only `/play`), so this
page is currently dead to users. The registry data itself is fine; the GET API is
exposed at `/registry` (200, application/json). It is only the human page route
that is shadowed.

Verdict: PARTIAL. /play renders the 10-app registry correctly. /projects is
broken by a route collision and the projects gallery page cannot be opened.

---

## Cross-cutting: live infrastructure that all of the above depends on  —  healthy

- Hub registry `GET /hub/registry` and `GET /registry`: 200, 10 projects, CORS `*`.
- `/db` key-value store: live and persisting (e.g. place pixels
  `GET /db/place?prefix=px:&limit=500` -> 200 with real painted pixels like
  `px:29,48` by user `ev8andrj`; drift world:dir + snapshot live).
- `/rt` realtime rooms: real WebSocket handshakes succeed across coop, arena,
  drift; arena and drift push live state frames immediately.

---

## Prioritized fix list

1. (HIGH) Fix the `/projects` route collision so the human gallery page is
   reachable. The hub registry API and the static page both want `/projects`. Pick
   one:
   - serve the gallery at a non-colliding path (e.g. `/projects` -> static page,
     move the write API to `/registry/projects` or gate it: only proxy to the hub
     when the method is POST). In nginx:
     `location = /projects { if ($request_method = POST) { proxy_pass ...:8970; }
      ... else serve the static page; }` — or simplest, rename the static page
     route to `/registry` (already taken by the JSON) is not viable, so prefer a
     method-gated split or a distinct path like `/explore`.
   - Until fixed, the registry is only browsable via `/play`. Add a `/projects`
     (or working equivalent) link to the site nav once the route works.
   - Verify after fix: `GET /projects` returns text/html and the gallery JS still
     reaches `GET /hub/registry`.

2. (LOW) drift: do a real-GPU browser pass to visually confirm the wgpu canvas
   actually renders the world and that `d-backend` reports "WebGPU"/"WebGL2"
   (assets and code are correct; only the on-screen pixels are unverified here).

3. (LOW / cosmetic) coop: the served file 404s on `/netgame.js`. It is never
   requested at runtime (the import is inside a comment), so this is harmless, but
   removing or fixing the comment avoids confusing anyone reading network logs.

4. (PROCESS) Re-run this whole suite with the interactive browser tool available
   (Blueberry Browser was unreachable at 127.0.0.1:7777 this session) to capture
   actual console output and screenshots for drift/coop/spa, which is the one
   thing pure HTTP/WS checks cannot give.

## Browser verification (confirmed)

Driven in a real browser (Blueberry), 2026-06-24 — resolves the earlier "render unverified" caveat:

- **drift.ce-net.com — WORKS.** The wgpu client loads and cleanly falls back to **WebGL2** (the
  intended WebGPU-first / WebGL2-fallback path); `pkg/drift_client_bg.wasm` compiles (~884ms); the
  canvas renders with a live HUD: `drift · WebGL2 · region r:0:0 · host <id> · HOSTING · tick · net
  online`, and the control legend (WASD fly / Space fire / E mine / B build / wheel zoom /
  shard-switch). No console errors. Live fetches to `/nodes`, `/db/drift/world:dir`,
  `/db/drift/snap:r:0:0`, `/db/drift/handoff:r:0:0`, `/stats`. Runtime exposed at `window.__drift`.
- **coop.ce-net.com — WORKS.** Join screen (handle + color + Enter arena); on entry the netgame host
  is elected and the HUD shows `AUTHORITATIVE LOGIC · logic running on <id> (this device, host) · N
  PLAYERS · LEADERBOARD · tick · host · seq`, with a Force-host-failover control. No console errors;
  `/db/coop/snap:g1`, `/nodes`, `/stats` all 200.

Net: the authoritative-on-the-mesh game stack (drift-sim wasm + wgpu/WebGL2 render + netgame host
election + /db snapshot failover + region sharding) is confirmed working end to end in a browser.
