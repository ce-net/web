# CE Platform — Agent Guide

This is the authoritative map for coding agents using the CE App Platform. Everything below
is deployed and live at `https://ce-net.com`. The platform lets you host apps, store data,
run realtime rooms, and push compute to a mesh of nodes, with no account, server, or key.

HARD RULE: no emojis anywhere. Plain text only.

## What CE gives you (four capabilities)

- App hosting: static sites and SPAs, globally reachable, with hot reload. Skill:
  `ce-deploy-app/`.
- Database: persistent per-app key-value store, JSON values, newest-first lists. Skill:
  `ce-database/`.
- Realtime: pub/sub rooms over WebSocket with 50-message replay. Skill: `ce-realtime/`.
- Compute: push WASM / JS / Python tasks to live nodes and read the result. Skill:
  `ce-run-task/`.

The detailed copy-paste runbook for each lives in its skill folder's `SKILL.md`. This file
plus `llms.txt` give the compact, full-surface reference.

## Origins and public URL shapes

The hub is the service `ce-hub`, public via nginx at `ce-net.com`. All paths below also work
under a `/hub/<path>` prefix.

- Path hosting: `https://ce-net.com/apps/<id>/`
- Per-developer subdomain (wildcard DNS is live): `https://<id>.ce-net.com/`
- Custom domain: `https://<custom-domain>/` (CNAME the domain to `ce-net.com`, then register
  it). nginx sets `X-CE-Host`; the hub resolves via `GET /_host/*path`.
- `/db/<app>/<key>` and `wss://ce-net.com/rt/<app>/<room>` work on all of the above origins.

## HTTP API (hub) — full surface

Compute:
- `POST /tasks` -> `{node,lang,func,ok,value,ms,error}`
  - wasm: `{"func":"count_primes","args":[200000],"ret":"i32","module":"demo"}`
  - code: `{"lang":"js"|"python","code":"i=>i.a+i.b","input":{...},"func":"task"}`
  - optional `"target":"<full node id>"`
  - 503 if no nodes connected; 504 if the chosen node did not return in time.

Metrics:
- `GET /stats` -> `nodes, cores, ram_gb, storage_gb, gpus[], gpu_count, gpu_vram_gb,
  webgpu_nodes, perf_score, tasks_run, blobs, blob_bytes, avg_uptime_pct,
  by_class{phone,laptop,server,device}, most_reliable{short,uptime_pct}, latency_p50_ms,
  latency_p95_ms, latency_measured, data_used_bytes, hosted_apps, replicas,
  limits{max_data_bytes,max_apps,max_domains,max_db_namespaces}`.
- `GET /stats/stream` -> Server-Sent Events of the `/stats` object (~1.5s cadence).
- `GET /nodes` -> `{nodes:[{id,short,cores,ram_gb,storage_gb,gpu,webgpu,platform,tasks_run,
  age_s,rtt_ms,uptime_pct,device_class,online_secs,sessions,first_seen_unix}]}`.
- `GET /node` -> WebSocket for browser/headless nodes (up: hello/hb/pong/result; down:
  job/ping/store/fetch).

Blobs (content-addressed):
- `PUT /blobs/:hash` (raw body + content-type) -> `{hash,size}`.
- `GET /blobs/:hash`.

App hosting (static sites + SPAs):
- `PUT /apps/:id/*path` (raw body + content-type) -> `{id,path,version,url}`. Empty path =
  `index.html`.
- `GET /apps/:id`, `/apps/:id/`, `/apps/:id/*path` -> serves files; SPA fallback (a
  route-like miss with no file extension returns `index.html` with 200); HTML gets a
  hot-reload snippet injected.
- `GET /apps/:id/__reload` -> SSE; emits the version number on every change.
- `PUT /apps/:id/config {"spa":true}` ; `GET /apps/:id/config` -> `{spa,version,domains}`.

Custom production domains:
- `PUT /apps/:id/domain {"domain":"app.acme.com"}` -> `{domain,id,cname:"ce-net.com"}`.
- `DELETE /apps/:id/domain/:domain` ; `GET /domains` -> `[{domain,id}]`.
- `GET /_host/*path` resolves the app from the `X-CE-Host` header (nginx sets it for CNAME'd
  domains).

Database (persistent KV, namespaced per app):
- `PUT /db/:app/:key` (JSON body) -> `{ok,key}`.
- `GET /db/:app/:key` -> value | 404.
- `DELETE /db/:app/:key`.
- `GET /db/:app?prefix=&limit=` -> `{items:[{key,value}],n}` (newest-first).

Realtime rooms:
- `GET /rt/:app/:room` -> WebSocket; any text frame is broadcast to others in the room; last
  50 replayed on connect.

## CLI: ce-app

One command to a live, globally reachable, hot-reloading app. Public dev id is stored at
`./.ce/app-id` (auto-created as 16 hex; override with `--app <id>`). Hub base defaults to
`https://ce-net.com` (override with `--hub <base>` or `$CE_HUB`).

```
npm create ce-app                    scaffold the chat template
ce-app new [template] [dir]          scaffold a template (no name lists available)
ce-app dev                           build + watch + live-upload; prints the public URL
ce-app deploy                        auto-detect framework, build, upload, enable SPA routing
ce-app domain add <domain>           register a custom production domain (prints CNAME + TLS note)
ce-app domain rm <domain>            unregister a custom domain
ce-app domain ls                     list this app's custom domains
ce-app detect                        print detected framework + output dir (no network)
ce-app smoke                         build a fixture + run detection self-checks (no network)
```

Templates: `chat`, `notes`, `board`, `vite-react`, `svelte`, `react`, `next`,
`react-native`. Frameworks auto-detected on deploy: Vite (vanilla/React/Vue/Svelte),
SvelteKit (static), Next.js (static export), Astro (static), Nuxt (static generate), Create
React App, Expo / react-native-web (web export), plain static, and the built-in esbuild path
(`src/main` + `src/index.html`).

## SDKs and client

- `@ce/client` (browser ESM, `web/ce-app/client`): `createClient(opts?)` ->
  `{appId, base, db:{get,set,del,list}, room(name):{send,on,onOpen,close}}`. `appId`
  auto-resolves from the `/apps/<id>/` path or the `<id>.ce-net.com` host. Options:
  `{app?, base?}`.
- Python SDK (`web/sdks/python`, package `ce`): tasks + db + room. `Client(app?)` ->
  `run_task(...)`, `db.{get,set,delete,list}`, `room(name).{on,on_open,send,run}`.
- Go SDK (`web/sdks/go`, package `ce`): tasks + db + room. `ce.New(app)` -> `RunTask(...)`,
  `DB.{Get,Set,Del,List}`, `Room(name).{On,OnOpen,Send,Run}`.
- `ce-rs` is the Rust node SDK.
- Compute task languages: `wasm`, `js` (sandboxed Worker), `python` (Pyodide, browser nodes
  only). The headless worker (`web/site/worker.js`) runs `wasm` + `js`.

## Run a node

- Browser: open `https://ce-net.com/node` (a real WASM/JS compute node and mesh peer; iOS
  and Android too).
- Headless: `curl -fsSL https://ce-net.com/worker.js | node - --hub wss://ce-net.com/hub`.
- Live metrics: `https://ce-net.com/network` (nodes, cores, GPU, RAM, uptime/reliability %,
  latency).

## Storage limits (protect the host disk)

Env-configurable, conservative defaults. Over-budget writes return HTTP 507.
- Global: `CE_HUB_MAX_DATA_BYTES` (512 MiB), `CE_HUB_MAX_APPS` (200), `CE_HUB_MAX_DOMAINS`
  (100), `CE_HUB_MAX_DB_NAMESPACES` (500).
- Per item: 16 MB/file, 64 MB/app, 200 files/app, 16 MB/blob, 256 MB blob store, 5000 db
  keys/namespace.
- Contributor nodes cap their replicated-file cache (browser 32 MiB via `?cache=`, worker 64
  MiB via `CE_WORKER_MAX_CACHE_BYTES`), oldest-evicted.
- Detail: `web/deploy/storage-limits.md`.

## Worked end-to-end examples

### 1. Scaffold, deploy, and put a site on a custom domain

```bash
npm create ce-app
cd ce-app && npx ce-app deploy
# live at https://ce-net.com/apps/<id>/ and https://<id>.ce-net.com/
# Point app.acme.com via CNAME -> ce-net.com, then:
npx ce-app domain add app.acme.com
```

### 2. A guestbook with the database (newest-first feed)

```bash
APP=guestbook
# write an entry keyed by timestamp so the list is newest-first:
curl -X PUT "https://ce-net.com/db/$APP/entry:$(date +%s%3N)" \
  -H "content-type: application/json" \
  -d '{"name":"Alice","msg":"first!"}'
# read the latest 20 entries (newest first):
curl "https://ce-net.com/db/$APP?prefix=entry:&limit=20"
```

### 3. A realtime chat room (with durable history via the db)

In the browser app:

```js
import { createClient } from "@ce/client";
const ce = createClient();
const room = ce.room("lobby");
// load recent history from the db on startup:
const history = await ce.db.list("msg:", 50);     // newest-first
room.on((m) => render(m));                          // live messages from others
async function post(text) {
  const m = { text, at: Date.now() };
  await ce.db.set(`msg:${m.at}`, m);                // durable
  room.send(m);                                      // broadcast to others
  render(m);                                         // optimistic local render (no self-echo)
}
```

### 4. Push compute to the mesh and read the result

```bash
# ensure capacity:
curl "https://ce-net.com/stats"        # nodes > 0
# run a JS task on whichever node the hub picks:
curl -X POST "https://ce-net.com/tasks" \
  -H "content-type: application/json" \
  -d '{"lang":"js","code":"i=>i.a+i.b","input":{"a":2,"b":3},"func":"task"}'
# -> {"node":"...","ok":true,"value":5,"ms":3}
# run a WASM module function:
curl -X POST "https://ce-net.com/tasks" \
  -H "content-type: application/json" \
  -d '{"func":"count_primes","args":[200000],"ret":"i32","module":"demo"}'
```

## Common failure codes

- 503 on `POST /tasks`: no nodes connected. Start a node, re-check `GET /stats`.
- 504 on `POST /tasks`: the chosen node timed out. Retry or pin `target`.
- 507 on any write: over a storage limit (see above).
- 404 on `GET /db/:app/:key`: key absent (SDKs map to undefined/None/nil).
