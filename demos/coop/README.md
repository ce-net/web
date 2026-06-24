# coop — server-authoritative multiplayer on CE netgame

A fully **server-authoritative** top-down arena. The game logic does not run in
your browser — it runs on the **best mesh node** (lowest latency, highest uptime,
strongest benchmark, most trusted), elected automatically from the live CE node
metrics. Clients send only input; the elected host simulates movement,
projectiles, collisions, score and respawns; every client just renders the
authoritative state it receives. If the host disconnects or fails, the arena
**migrates** to the next-best node and restores from a CE `/db` snapshot.

Open the page, watch the banner: `logic running on node <short> (server, <rtt>ms)`.
Hit **Force host failover** to drop the local candidacy and see migration live.

- Single self-contained `index.html` — vanilla JS, no build, no npm.
- Serve it via the CE hub at `ce-net.com/apps/coop/` (it uses same-origin
  `/rt/<app>/<room>`, `/db/<app>/<key>`, `/nodes`, `/stats`).
- The framework is **inlined** in `index.html` with a header comment pointing at
  the canonical source: `web/ce-app/client/netgame.js`. Keep the two in sync.

## The model

- **Realtime room** (`/rt/coop/g1`): clients broadcast `{t:"in", input}`; the host
  broadcasts `{t:"st", state}` every tick. Candidacy `{t:"cand", score, server}` is
  broadcast ~1/s. You never receive your own frames.
- **Election** is deterministic on every client: the candidate with the highest
  host-score wins (server-class beats browsers), ties broken by smallest id, so
  all clients agree on the same host without a coordinator.
- **Host score** (default): `(1000/(40+latencyMs)) * (0.5 + uptimePct/100) *
  (1 + cpuMark/300) * (server ? 1.6 : 1)`. A registered mesh node uses its real
  `rtt_ms` / `uptime_pct` / `caps.cpu_mark` / `device_class` from `GET /nodes`; a
  plain browser measures latency (median `GET /stats` round-trips) and a ~20ms CPU
  micro-bench, with a low uptime/trust default.
- **Failover**: the host PUTs a snapshot to `/db/coop/snap:g1` every
  `snapshotEvery` ticks. If the host goes silent >1s, clients re-elect; whoever
  becomes the new host loads that snapshot and continues (at most
  `snapshotEvery/hz` seconds of state loss). Never crashes on 404/507/parse error.

A dedicated operator can pin authoritative hosting to a stable machine by joining
a headless, hostable, high-priority participant (`host.mjs` — a Node 22+ runner).

## The minimal version (~30 lines)

This is the whole framework contract — `init` + `tick` + `input` + `onState`:

```js
import { createGame } from "./netgame.js";   // canonical: web/ce-app/client/netgame.js

const id = crypto.randomUUID();
const keys = {};
addEventListener("keydown", e => keys[e.key] = true);
addEventListener("keyup",   e => keys[e.key] = false);
const W = 800, H = 600;

const game = createGame({
  app: "coop", room: "g1", id, hz: 20,
  init: () => ({ p: {} }),                              // authoritative state (host only)
  input: () => ({ x: (keys.d?1:0)-(keys.a?1:0), y: (keys.s?1:0)-(keys.w?1:0) }),
  tick: (s, inputs) => {                                // runs ONLY on the elected host
    for (const pid in inputs) {
      const me = s.p[pid] || (s.p[pid] = { x: W/2, y: H/2 });
      me.x = Math.max(0, Math.min(W, me.x + inputs[pid].x * 6));
      me.y = Math.max(0, Math.min(H, me.y + inputs[pid].y * 6));
    }
    return s;
  },
  onState: (s, meta) => {                               // every client renders this
    const c = canvas.getContext("2d"); c.clearRect(0,0,W,H);
    for (const pid in s.p) { c.fillStyle = pid===id ? "#37c6ff" : "#fff";
      c.fillRect(s.p[pid].x-6, s.p[pid].y-6, 12, 12); }
    label.textContent = "host: " + meta.hostShort + " (" + meta.rttToHostMs + "ms)";
  },
});
```

That is the entire surface: send input, the best node simulates, everyone renders,
and it fails over by itself.

## createGame API

```
createGame({ app, room="g1", id, hz=20, init, tick, input, onState,
             onHostChange, snapshotEvery=40, canHost=true, hostScore=null,
             base, WebSocket, fetch })
  -> { setInput, sendEvent, state, isHost, hostId, hostShort, online,
       players, metrics, leave }
```

- `tick(state, inputs, dt, ctx)` — advance one tick on the host. `inputs={pid:lastInput}`,
  `ctx={now,tick,events,host}`. Return the new state.
- `onState(state, meta)` — client render hook. `meta={host,hostShort,isHost,online,
  tick,rttToHostMs}`.
- `setInput(obj)` — alternative to the `input()` callback.
- `leave()` — drop local host candidacy (used by the demo's force-failover button);
  `leave({hard:true})` also closes the socket.

Inline framework copy lives at the top of `index.html`. The canonical, importable
ESM source is `web/ce-app/client/netgame.js`.
