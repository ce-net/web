# Debugging and observability

Everything you can observe about a deployed app today goes through endpoints the hub already exposes —
nothing new on the server is required. There are two front ends for the same data: a per-app **debug
dashboard** in the browser, and three read-only **ce-app verbs** (`doctor`, `logs`, `trace`) on the
command line. Both are read-only: they never mutate your app, database, domains, or limits.

## What is observable today

| Signal | Source endpoint | Notes |
| --- | --- | --- |
| Hot-reload version | `GET /apps/:id/__reload` (SSE) | emits the current `version`, then each bump. |
| Hosted status + counters | `GET /apps/:id/debug` | `version`, `bytes`, `requests`, `errors`, `last_error`, `rooms`, `owner`. |
| Served (fallback) | `GET /apps/:id/` | proves the app responds even with no debug counters. |
| Live room participants | `ws /rt/:id/main` | approximated by counting distinct peer ids on the wire. |
| Database keys + sizes | `GET /db/:id` (list) | newest-first keys, up to 1000, with value sizes. |
| Limits + usage | `GET /stats` (apex `GET /hub/stats`) | global caps, `data_used_bytes`, `hosted_apps`. |
| Live logs / traces | `ws /rt/:id/__debug` | the conventional debug room (below). |

Anything missing degrades gracefully: an absent endpoint leaves a dash and a note, never an error.

## The debug dashboard

Open `https://ce-net.com/debug?app=<id>` (or `/debug` and type the id). It shows, for one app:

- the live **hot-reload version** (subscribed to `/__reload`),
- **hosted** status and app size,
- **live participants** in `/rt/<app>/main`,
- **database** key count and approximate total size, plus a key list,
- **requests / errors / active rooms / owner** from `/apps/:id/debug`,
- **limits headroom** bars from `/stats`,
- a **live log pane** fed from the app's `__debug` room, with filter pills (all / log / trace /
  metric / error) and autoscroll.

It re-polls the snapshot every 10s and keeps the room sockets open for live frames. It is pure
read-only and works against any hub via `?hub=https://host`.

## The `ce-app` verbs

All three run standalone (`node bin/debug.mjs <verb>`) and as `ce-app <verb>`. They reuse your one
identity and the canonical signing scheme; `--json` gives machine-readable output on each.

### `ce-app doctor`

End-to-end health for the current project's app:

```
$ ce-app doctor
ce-app doctor
hub https://ce-net.com  ·  app coop-c0be11e0ce

  ok    identity           ce-node · id c0be11e0ce0aaa76… · signing on
  ok    hub reachable      ce-net.com · 3 nodes · 200 KB used
  ok    app deployed       coop-c0be11e0ce · v7 · 48 KB · 1.2k reqs · 0 errs
  ok    hot-reload         __reload stream live · version 7
  ok    room /rt/main      connected in 238ms
  ok    room /rt/__debug   connected in 251ms
  ok    limits headroom    data 0% of 1 GB · apps 11/500

all checks passed
```

It checks: identity present (and whether a secret key is available to sign), hub reachable, app
deployed, the `__reload` channel, both rooms reachable, and limits headroom. A missing app is a
**warning**, not a failure — so `doctor` is safe to run before your first deploy.

### `ce-app logs <app>`

Subscribe to the app's `__debug` room and print frames as they arrive (history replay first, then
live). It publishes nothing, so by the room's relay semantics it sees the app's own clients but never
itself.

```
$ ce-app logs coop-c0be11e0ce
subscribing to /rt/coop-c0be11e0ce/__debug — apps publish JSON frames here
connected — replaying recent history, then live

12:04:31.882 [info]  host elected: c0be11e0ce
12:04:31.910 [trace] tick 41ms
12:04:32.004 [metric] players=3
```

`--once` drains recent history then exits (good for CI); `--json` prints raw frames.

### `ce-app trace <app>`

Time a deploy-shaped round-trip so you can see where latency lives — stats, app `HEAD`, and reading
the `__reload` version:

```
$ ce-app trace coop-c0be11e0ce
  ok     142ms  stats                #####
  ok      88ms  app HEAD             ###
  ok     210ms  __reload version     ########  v7

  total 440ms
```

`--write` adds a full write round-trip: it PUTs a tiny **signed** probe under the reserved `__trace/`
prefix of an app you own, GETs it back, then clears it. Without `--write`, `trace` is purely
read-side and touches nothing.

## The `__debug` room convention

`__debug` is a plain CE realtime room (`/rt/<app>/__debug`) reserved by convention for structured
observability. Apps **publish** frames to it; the dashboard and `ce-app logs` **subscribe**. The hub
relays text frames between clients and replays recent history on join — there is no special server
support, so any app can opt in with one line, and apps that don't publish simply show an empty pane.

Frames are JSON objects with a `t` (type) field. Nothing is mandatory; the tools render whatever they
get and fall back to dumping the raw object.

| `t` | Shape | Rendered as |
| --- | --- | --- |
| `log` | `{ "t":"log", "level":"info\|warn\|error", "msg":"…", "ts":<unix-ms>, "from":"<id>" }` | a log line at that level |
| `trace` / `span` | `{ "t":"trace", "name":"render", "ms":12, "detail":"…" }` | a timing line |
| `metric` | `{ "t":"metric", "name":"fps", "value":60 }` | a name = value line |
| `error` | `{ "t":"error", "msg":"…" }` or `level:"error"` | a log line, error-colored |

Optional fields used when present: `ts` (unix ms; defaults to receive time), `level`/`lvl`,
`from`/`src` (originating client id), `ms`/`dur` (durations).

Publishing from a client is just a room send. With the bundled `@ce/client` realtime room or
`netgame.js` (which already joins `/rt/<app>/<room>`), open a second connection to `__debug` and send
JSON:

```js
const dbg = new WebSocket(
  (location.protocol === "https:" ? "wss" : "ws") +
  "://" + location.host + "/rt/" + appId + "/__debug"
);
const log = (level, msg) =>
  dbg.readyState === 1 &&
  dbg.send(JSON.stringify({ t: "log", level, msg, ts: Date.now(), from: myId }));

log("info", "client started");
// timing:
const t0 = performance.now();
render();
dbg.send(JSON.stringify({ t: "trace", name: "render", ms: Math.round(performance.now() - t0) }));
```

Keep `__debug` frames small and low-rate (it is for human-readable diagnostics, not your app's
hot-path state — that belongs on `/main` or an ephemeral room). Treat anything you publish as
**public**: the room is readable by anyone who knows the app id, so never log secrets.

## Endpoint reference

| Method | Path | Use |
| --- | --- | --- |
| GET (SSE) | `/apps/:id/__reload` | current version, then each bump |
| GET | `/apps/:id/debug` | counters: version, bytes, requests, errors, rooms, owner |
| GET | `/apps/:id/` | served-status fallback |
| GET | `/db/:id` (`?limit=&prefix=`) | list keys, newest-first |
| GET | `/stats`, `/hub/stats` | limits + usage |
| WS | `/rt/:id/main` | participant approximation |
| WS | `/rt/:id/__debug` | live logs / traces / metrics |
