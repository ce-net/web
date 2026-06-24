# CE netgame — authoritative distributed multiplayer

`netgame` makes it trivial to build a global multiplayer game whose **authoritative
logic runs on the best mesh node** — lowest latency, highest uptime, strongest
benchmark, most trusted — while clients only send inputs and render the
authoritative state they receive. When that node disconnects or fails, play
**migrates** to the next-best node and restores from a CE `/db` snapshot.

It is one small ESM file with no build step and no dependencies, built only on
existing CE hub primitives:

- **Realtime room** — `/rt/<app>/<room>` (WebSocket; each text frame is broadcast to
  every *other* client; the last 50 are replayed on connect).
- **Database** — `PUT`/`GET /db/<app>/<key>` (JSON), for durable snapshots.
- **Node metrics** — `GET /nodes` and `GET /stats`, for host scoring.

Canonical source: `web/ce-app/client/netgame.js` (types: `netgame.d.ts`).
Worked example: `web/demos/coop/` (served at `ce-net.com/apps/coop/`).

---

## The model

Every participant joins the room and broadcasts a **candidacy** — `{t:"cand", id,
score, server}` — about once a second. Each participant runs the *same deterministic
election* over the candidate set, so they all agree on **one host** with no
coordinator:

> **HOST = the live candidate with the highest score; ties broken by the
> lexicographically smallest id.** Server-class candidates beat browsers.

A candidacy is "live" if it was seen within ~2.5s. The host runs the authoritative
tick loop at `hz`, ingests `{t:"in"}` inputs from clients, and broadcasts `{t:"st"}`
state every tick. Clients render each `{t:"st"}` from the host they elected.

Because election is deterministic and local, there is no lobby server and no leader
lease to manage — the metrics decide, and everyone computes the same answer.

### Wire protocol (JSON frames on `/rt/<app>/<room>`)

You never receive your own frames.

| Frame | Direction | Meaning |
| --- | --- | --- |
| `{t:"cand", id, score, server, ts}` | everyone, ~1/s | host candidacy |
| `{t:"in", id, seq, input}` | client -> host, ~hz | this client's input |
| `{t:"st", host, seq, tick, full, state, ts}` | host -> all, ~hz | authoritative state |
| `{t:"ev", id, ev}` | client -> host | one-off event for the host's next tick |
| `{t:"bye", id}` | leaving | drop this participant |

### Failover and redundancy

The host PUTs a snapshot — `{tick, state, host, ts}` — to `/db/<app>/snap:<room>`
every `snapshotEvery` ticks. If the elected host's `{t:"st"}` goes silent for more
than ~1s, every client forgets that candidacy and re-elects. Whoever becomes the new
host adopts the latest snapshot (or a warm copy from the last `{t:"st"}` it saw) and
continues, so the worst-case state loss is `snapshotEvery / hz` seconds.

Redundancy is automatic: the top candidates all keep a warm copy of recent state via
`{t:"st"}`, and the durable `/db` snapshot is the fallback path, so migration is
fast and the game survives a host vanishing mid-tick. The framework **never crashes**
on a `404` (no snapshot yet), `507` (storage full — snapshot skipped), or parse
error, and the WebSocket auto-reconnects with backoff, re-announcing candidacy on
reconnect.

---

## The `createGame` API

```js
import { createGame } from "./netgame.js";

const game = createGame({
  app,                 // required: namespace (also the /db and /rt app id)
  room = "g1",         // instance / shard
  id,                  // this participant's stable id (default: random)
  hz = 20,             // authoritative tick rate
  init,                // () => state  — initial state (host only; used when no snapshot)
  tick,                // (state, inputs, dt, ctx) => state  — advance one tick (host only)
  input,               // OPTIONAL () => obj  — this client's input each tick
  onState,             // (state, meta) => {}  — client render hook
  onHostChange,        // OPTIONAL (meta) => {}  — fired when the elected host changes
  snapshotEvery = 40,  // host: ticks between /db snapshots (redundancy)
  canHost = true,      // am I eligible to host?
  hostScore = null,    // OPTIONAL () => number  — override the default scorer
  base, WebSocket, fetch, // OPTIONAL injections for Node < 22 / custom origin
});
```

Returns:

```
{ setInput(obj), sendEvent(obj), state(), isHost(), hostId(), hostShort(),
  online(), players(), metrics(), leave() }
```

- `tick(state, inputs, dt, ctx)` runs **only on the elected host**. `inputs` is
  `{pid: lastInput}` (the latest input per live client); `ctx = {now, tick, events,
  host}`. Return the new state.
- `onState(state, meta)` runs on every client. `meta = {host, hostShort, isHost,
  online, tick, rttToHostMs}`.
- `setInput(obj)` is the alternative to the `input()` callback.
- `sendEvent(obj)` queues a one-off event for the host's next `ctx.events`.
- `leave()` stops hosting, broadcasts `{t:"bye"}`, drops local candidacy, and closes
  the socket. The coop demo's **Force host failover** button calls this to demo a
  live migration.

---

## Host scoring

The default scorer rewards lower latency, higher uptime, a stronger benchmark, and
a server/trust bonus:

```
score = (1000 / (40 + latencyMs))
      * (0.5 + uptimePct / 100)
      * (1 + cpuMark / 300)
      * (server ? 1.6 : 1)
```

How the inputs are obtained:

- **Registered mesh node** — if your `id` is in `GET /nodes`, use its real `rtt_ms`
  (relay<->node latency), `uptime_pct` (stability), `caps.cpu_mark` (benchmark, `0`
  if absent), and `device_class === "server"` (the trust/server bonus). `/nodes` is
  fetched on start and refreshed every ~5s.
- **Plain browser** — not a registered node, so it *measures*: latency is the median
  of a few timed `GET /stats` round-trips; `cpuMark` is a ~20ms throughput
  micro-bench; uptime/trust default low (`20`%). This keeps browsers below
  server-class nodes, which is the point — authoritative logic gravitates to stable
  infrastructure, not a laptop on hotel wifi.

Pass `hostScore: () => number` to override the formula entirely (e.g. to weight a
GPU benchmark or a custom trust signal). Set `canHost: false` for a participant that
should only ever be a client (a spectator, a phone, a CI smoke test).

---

## Running a dedicated headless host

A browser can host, but for production you usually want hosting **pinned to a stable
machine**. Join a non-rendering, hostable, server-class participant from Node — it
speaks the identical wire protocol, advertises a high server-class score, and so
normally wins the election and keeps authoritative play on that box:

```bash
# Node 22+ has a global WebSocket + fetch — no dependencies.
node web/demos/coop/host.mjs --hub wss://ce-net.com --room g1

# http(s) is accepted too (the runner derives the ws url):
node web/demos/coop/host.mjs --hub https://ce-net.com --room g1

# defaults: --hub wss://ce-net.com --app coop --room g1 --hz 20
node web/demos/coop/host.mjs
```

On Node < 22 (no global WebSocket), install the `ws` package and it is picked up
automatically: `npm i ws`.

The runner logs a status line every 10s (`online`, `hosting`, current host, score,
tick, player count) and on every host change, so you can *see* whether hosting is
pinned here. Ctrl-C leaves the room cleanly (`{t:"bye"}`).

`host.mjs` ships a neutral, side-effect-free tick so the room stays authoritative
and snapshots keep flowing even with zero browsers connected. To make the headless
box simulate the **full** game, paste the `init()` and `tick()` from
`web/demos/coop/index.html` into the `createGame` options in `host.mjs` — the wire
protocol is shared, so a headless host running the identical tick is
indistinguishable from a browser host, only more stable.

**Failover stays automatic.** The headless host is *redundancy, not a single point
of failure*: if it dies, browsers re-elect among themselves and restore from the
`/db` snapshot. Run two headless hosts on two machines for belt-and-braces — the
deterministic election (highest score, smallest id on ties) still resolves to
exactly one authoritative host at a time, and the standby takes over within ~1s of
silence.

---

## Minimal worked example (~30 lines)

The whole framework contract is `init` + `tick` + `input` + `onState`:

```js
import { createGame } from "./netgame.js";   // canonical: web/ce-app/client/netgame.js

const id = crypto.randomUUID();
const keys = {};
addEventListener("keydown", e => keys[e.key] = true);
addEventListener("keyup",   e => keys[e.key] = false);
const W = 800, H = 600;

createGame({
  app: "coop", room: "g1", id, hz: 20,
  init: () => ({ p: {} }),                               // authoritative state (host only)
  input: () => ({ x: (keys.d?1:0)-(keys.a?1:0), y: (keys.s?1:0)-(keys.w?1:0) }),
  tick: (s, inputs) => {                                 // runs ONLY on the elected host
    for (const pid in inputs) {
      const me = s.p[pid] || (s.p[pid] = { x: W/2, y: H/2 });
      me.x = Math.max(0, Math.min(W, me.x + inputs[pid].x * 6));
      me.y = Math.max(0, Math.min(H, me.y + inputs[pid].y * 6));
    }
    return s;
  },
  onState: (s, meta) => {                                // every client renders this
    const c = canvas.getContext("2d"); c.clearRect(0,0,W,H);
    for (const pid in s.p) { c.fillStyle = pid===id ? "#37c6ff" : "#fff";
      c.fillRect(s.p[pid].x-6, s.p[pid].y-6, 12, 12); }
    label.textContent = "host: " + meta.hostShort + " (" + meta.rttToHostMs + "ms)";
  },
});
```

Send input, the best node simulates, everyone renders, and it fails over by itself.

---

## Shipped vs future

**Shipped today.** The host is **client-elected over the live CE metrics**: every
participant scores itself from `GET /nodes` (registered nodes) or measured
latency/CPU (browsers), broadcasts candidacy, and runs the same deterministic
election. Authoritative simulation runs on the winner; `/db` snapshots provide
failover with at most `snapshotEvery / hz` seconds of state loss. A dedicated
headless host (`host.mjs`) can pin hosting to a stable machine purely by advertising
a higher server-class score — no special placement plumbing required.

**Future — hub-scheduler-placed hosting.** The election is intentionally *metric*
driven, not *scheduler* driven. A future CE hub scheduler could place the
authoritative host directly on a chosen mesh node (by trust, region, capacity, or
operator policy) instead of relying on the emergent score race, and hand clients the
designated host id rather than each computing it. That is **not shipped** — today the
metrics-based election is the source of truth, and `hostScore` / a headless host are
the levers for steering placement. The wire protocol and `createGame` API are
designed so a scheduler can be added later without changing how games are written.
