# CE App Platform

Build, ship, and host a live web app on `ce-net.com` with one command. The CE hub
(`web/ce-hub`, a small axum sidecar on `127.0.0.1:8970`, proxied by nginx) gives every
app three things out of the box:

- **App hosting** — multi-file static sites and SPAs served at `https://ce-net.com/apps/<id>/`, with automatic hot reload during development.
- **CE database** — a persistent, per-app namespaced key/value store at `/db/<app>/<key>`.
- **Realtime rooms** — pub/sub over WebSocket at `wss://ce-net.com/rt/<app>/<room>`.

Plus a per-node **uptime / reliability** metric that powers the network dashboards.

---

## Quickstart (one command to a live, hot-reloading URL)

```bash
# Scaffold the chat template (also: npm create ce-app)
npm create ce-app

# Build + watch + upload on every save. Prints the live URL.
cd my-app
ce-app dev
# → live at https://ce-net.com/apps/<id>/
```

`ce-app dev` builds your source (Vite if a vite config is present, otherwise an esbuild
bundle of `src/index.html` + `src/main.ts`), watches for changes, and on each rebuild
`PUT`s every output file to the hub at `/apps/<id>/<relpath>`. The browser reloads
itself — a tiny hot-reload snippet is injected into every served HTML page and listens on
an SSE stream, so you never refresh by hand.

Your app id lives at `./.ce/app-id` (a random 16-hex string, created on first run). It is
your public dev id and the `<id>` in every URL. Keep the file to keep the URL stable.

```bash
ce-app new chat my-app   # scaffold a named template into a dir
ce-app deploy            # one-shot full upload, no watch (for CI / publishing)
```

The hub base defaults to `https://ce-net.com`; point `ce-app` at a local hub for offline
development.

---

## App hosting API

Files are stored under `(id, path)`. An empty path or `/` maps to `index.html`.

| Method | Path | Behavior |
|---|---|---|
| `PUT` | `/apps/:id/*path` | Store raw bytes (body) with the request `Content-Type`. Bumps the app's version and fires a reload. Returns `{id, path, version, url:"/apps/<id>/"}`. |
| `GET` | `/apps/:id` · `/apps/:id/` · `/apps/:id/*path` | Serve a stored file. No path → that app's `index.html`. Content-Type inferred from extension. |
| `GET` | `/apps/:id/__reload` | SSE stream. Emits `data: <version>` immediately and on every version bump. |

Limits: 16 MB per file, ~200 files and 64 MB per app. Served HTML gets the hot-reload
snippet injected before `</body>`. Files persist under `CE_HUB_DATA/apps/<id>/` and are
reloaded on hub startup.

Supported content types (by extension): `html, js, mjs, css, json, wasm, svg, png, jpg,
webp, ico, map, txt`.

---

## CE database (persistent KV, per app)

A simple namespaced JSON KV store. Use it for chat history, lists, user state — anything
small and durable.

| Method | Path | Behavior |
|---|---|---|
| `PUT` | `/db/:app/:key` | Body is a JSON value (any shape). Returns `{ok:true, key}`. |
| `GET` | `/db/:app/:key` | Returns the stored JSON value, or `404 {error:"not found"}`. |
| `DELETE` | `/db/:app/:key` | Returns `{ok:true}`. |
| `GET` | `/db/:app?prefix=&limit=` | Returns `{items:[{key,value}], n}`, newest-first by insertion. Default `limit` 200, max 1000. |

Each app persists to `CE_HUB_DATA/db/<app>.json` (loaded on startup, debounced save on
write). Size cap ~5000 keys per app; oldest keys are evicted on overflow. The database is
ephemeral-transport-free — it survives hub restarts.

---

## Realtime rooms

A room is a `(app, room)` channel. Open a WebSocket to `/rt/:app/:room`; any **text**
frame you send is broadcast verbatim to all **other** clients in the same room. On
connect, the server replays up to the last 50 buffered messages (in-memory ring), one
text frame each, before live traffic begins.

```
wss://ce-net.com/rt/<app>/<room>
```

Rooms are an **ephemeral transport** — durable history is the app's job via `/db`. Clients
are dropped cleanly on disconnect.

---

## Client library — `@ce/client`

Browser ESM helper used by the templates:

```js
import { createClient } from '@ce/client';

const ce = createClient();          // appId auto-resolved from the /apps/<id>/ path
// or: createClient({ app: 'demo' })

await ce.db.set('msg:1', { text: 'hi' });
const v   = await ce.db.get('msg:1');
const all = await ce.db.list('msg:', 100);
await ce.db.del('msg:1');

const room = ce.room('lobby');
room.onOpen(() => room.send({ hello: true }));
room.on(msg => console.log('got', msg));   // JSON in / out
room.close();
```

`createClient` resolves `appId` from `location.pathname` (matching `/apps/<id>/`), falling
back to `opts.app` or `'demo'`. `db` methods hit `/db/<app>/...`; `room(name)` opens a
WebSocket to `/rt/<app>/<name>` with JSON encode/decode helpers.

---

## Uptime / reliability metric

The hub keeps a **persistent per-node record** keyed by node id, stored at
`CE_HUB_DATA/nodes.json` and surviving hub restarts:

```
{ first_seen_unix, last_seen_unix, total_online_secs, sessions, disconnects }
```

A node's `hello` starts (or resumes) a session and increments `sessions`; heartbeats
extend the live session; a disconnect or prune closes the session, adds the elapsed
seconds to `total_online_secs`, and increments `disconnects`.

```
uptime_pct = clamp(round( total_online_secs / max(1, now - first_seen_unix) * 100 ), 0, 100)
```

`device_class` is a heuristic from `caps.platform` (+ cores, + webgpu):

| class | rule |
|---|---|
| `phone` | platform/UA matches `/iphone\|ipad\|android\|mobile/i` |
| `server` | matches `/linux\|x86_64-.*node\|server/i` AND `webgpu == false` AND `cores >= 8` |
| `laptop` | matches `/mac\|win\|linux/` and not a server (default for desktops) |
| `device` | anything else |

`GET /nodes` items gain `uptime_pct, device_class, online_secs, sessions, first_seen_unix`.
`GET /stats` gains `avg_uptime_pct` (over live nodes), `by_class:{phone,laptop,server,device}`
counts, and `most_reliable:{short, uptime_pct}` — existing stats fields are unchanged.

---

## Public surface (nginx)

`web/deploy/nginx.conf` proxies these paths to the hub on `127.0.0.1:8970`, placed before
the catch-all `location /`:

| Path | Proxy | Notes |
|---|---|---|
| `/apps/` | `→ :8970/apps/` | WebSocket upgrade + buffering off (so the `__reload` SSE flushes), `proxy_read_timeout 3600s`. |
| `/db/` | `→ :8970/db/` | Plain HTTP proxy with `Host` header. |
| `/rt/` | `→ :8970/rt/` | WebSocket upgrade + buffering off, `proxy_read_timeout 3600s`. |

The hub persists everything under `CE_HUB_DATA` (`/opt/ce-hub/data` on the relay, set in
`ce-hub.service` with a matching `ReadWritePaths` so `ProtectSystem=strict` still applies).
`deploy/deploy-hub.sh` creates that directory before first start.

---

## Subdomain upgrade path (future)

Apps are **path-based** today: `https://ce-net.com/apps/<id>/`. A future wildcard
`*.ce-net.com` would give each app a clean `https://<id>.ce-net.com`. That requires,
**none of which is done here**:

1. **Cloudflare DNS** — a wildcard `*.ce-net.com` record (proxied) pointing at the relay.
2. **Wildcard TLS cert** — `*.ce-net.com` (Cloudflare already terminates TLS in Flexible
   mode, so the edge cert is the main piece; the origin stays HTTP on `:80`).
3. **nginx** — a `server_name *.ce-net.com` block (or a `map` extracting the leftmost
   label as the app id) that rewrites `<id>.ce-net.com/<path>` → `:8970/apps/<id>/<path>`,
   reusing the same WebSocket-upgrade + buffering-off plumbing as `/apps/`.
4. **Client** — `createClient` already falls back to `opts.app`; add subdomain detection
   so the app id resolves from the hostname when present.

Until that lands, the path-based `/apps/<id>/` form is canonical and fully supported.
No DNS changes are attempted by this doc or the deploy scripts.
