# HTTP API reference

Base origin `https://ce-net.com` (service `ce-hub`, exposed publicly via nginx). Every endpoint is
also reachable under the `/hub/<path>` prefix. Bodies are JSON unless noted; blob and file uploads
take a raw body with a `content-type`.

## Signing

Mutating requests may be **signed** with your one CE identity (see [identity](identity.md)):
headers `x-ce-id` / `x-ce-sig` / `x-ce-ts` / `x-ce-nonce`, signing
`METHOD\nPATH\nts\nnonce\nsha256(body)-hex`. A valid signature attributes the write to its owner
(`sha256(pubkey)[..16]`) and grants identity-scoped quotas ([limits](limits.md)); no signature is
anonymous on the conservative caps; a bad signature is `401`. App/db/blob writes accept anonymous;
**slug and project writes require a signature**.

## Compute

### POST /tasks

Run a compute task on the mesh.

- WASM shape: `{"func":"count_primes","args":[200000],"ret":"i32","module":"demo"}`
- Code shape: `{"lang":"js"|"python","code":"i=>i.a+i.b","input":{...},"func":"task"}`
- Optional `"target":"<full node id>"` pins a node.

Returns `{node, lang, func, ok, value, ms, error}`. `503` if no nodes are connected; `504` if the
chosen node did not return in time.

### GET /stats

Aggregate mesh metrics:
`nodes, cores, ram_gb, storage_gb, gpus[], gpu_count, gpu_vram_gb, webgpu_nodes, perf_score,
tasks_run, blobs, blob_bytes, avg_uptime_pct, by_class{phone,laptop,server,device},
most_reliable{short,uptime_pct}, latency_p50_ms, latency_p95_ms, latency_measured, data_used_bytes,
hosted_apps, replicas, limits{max_data_bytes,max_apps,max_domains,max_db_namespaces}`.

### GET /stats/stream

Server-Sent Events of the `/stats` object, roughly every 1.5 seconds.

### GET /nodes

Connected nodes:
`{nodes:[{id, short, cores, ram_gb, storage_gb, gpu, webgpu, platform, tasks_run, age_s, rtt_ms,
uptime_pct, device_class, online_secs, sessions, first_seen_unix}]}`.

### GET /node

WebSocket endpoint for browser and headless nodes. Upstream frames: `hello`, `hb`, `pong`,
`result`. Downstream frames: `job`, `ping`, `store`, `fetch`.

## Content-addressed blobs

### PUT /blobs/:hash

Store a blob. Raw body plus a `content-type` header. Returns `{hash, size}`.

```bash
curl -X PUT https://ce-net.com/blobs/<hash> \
  -H "content-type: application/octet-stream" \
  --data-binary @file.bin
# -> {"hash":"...","size":1234}
```

### GET /blobs/:hash

Fetch a blob by its content hash.

## App hosting (static sites + SPAs)

### PUT /apps/:id/*path

Upload a file. Raw body plus `content-type`. Empty path stores `index.html`. Returns
`{id, path, version, url}`.

### GET /apps/:id, GET /apps/:id/, GET /apps/:id/*path

Serve app files. SPA fallback: a route-like miss with no file extension returns `index.html` with a
`200`. HTML responses get the hot-reload snippet injected.

### GET /apps/:id/__reload

Server-Sent Events; emits the app's `version` number on every change.

### PUT /apps/:id/config, GET /apps/:id/config

`PUT` with `{"spa":true}` toggles SPA fallback. `GET` returns `{spa, version, domains}`.

## Custom production domains

### PUT /apps/:id/domain

Attach a domain: `{"domain":"app.acme.com"}`. Returns `{domain, id, cname:"ce-net.com"}`. Create the
CNAME at your DNS provider.

### DELETE /apps/:id/domain/:domain

Detach a domain from an app.

### GET /domains

List all domain mappings: `[{domain, id}]`.

### GET /_host/*path

Resolves the app from the `X-CE-Host` header, which nginx sets for CNAME'd custom domains. Powers
custom-domain serving; you do not call it directly.

## CE database (persistent KV, namespaced per app)

### PUT /db/:app/:key

Store a JSON value at a key. Returns `{ok, key}`.

Optional **compare-and-set**: an `If-Match: <term>` header requires the stored value's `term` field
to equal `<term>` before the write applies. A mismatch returns `412` with `{error, current}`. This
is how `netgame` / `drift` guard a snapshot so two hosts racing after a partition cannot clobber
each other.

### GET /db/:app/:key

Read a value, or `404` if the key is absent.

### DELETE /db/:app/:key

Delete a key.

### GET /db/:app?prefix=&limit=

List keys newest-first: `{items:[{key, value}], n}`. `prefix` filters keys; `limit` caps the count.

## Realtime rooms

### GET /rt/:app/:room

WebSocket. Any text frame is broadcast to others in the room. The last 50 messages are replayed on
connect. Reachable as `wss://ce-net.com/rt/:app/:room` (and on the subdomain / custom-domain
origins).

Add `?ephemeral=1` to mark a high-rate room that **skips** the 50-deep history replay — used for
authoritative state frames (`drift` streams binary StateFrames over an ephemeral room). Binary
frames are broadcast but never buffered in history.

## App debug

### GET /apps/:id/debug

Read-only counters for a hosted app: `{version, bytes, requests, errors, last_error, rooms,
owner}`. Powers the [debug](debug.md) dashboard and `ce-app doctor`.

## Slug registry

### POST /slugs/claim, /slugs/renew, /slugs/release

**Signed** (owner-scoped). `claim {slug, app_id}` maps a human name to your app; `renew {slug}`
extends the expiry; `release {slug}` gives it back. A claimed slug serves at `/apps/<slug>/` via the
not-found fallback. See [registry](registry.md).

### GET /slugs/:slug

Public. Resolve a slug: `{app_id, owner, expires_unix, alive}`, or `404` if unclaimed.

## Projects registry

### POST /projects

**Signed**. Publish or update a project record `{title, slug, app_id, desc, tags, screenshots,
site, public}`. `screenshots` are blob hashes (`PUT /blobs/<sha256>`), pinned by the record.
Returns `{id, owner}`.

### DELETE /projects/:id

**Signed**. Unpublish — succeeds for the project's owner, or for an admin (`CE_HUB_ADMIN_OWNER`;
see [admin](admin.md)).

### POST /projects/:id/report

Flag a project (per-IP rate-limited; `429` over budget).

### GET /registry

Public list of published projects: `{projects:[{id, title, app_id, owner, tags, screenshots,
hosted, rooms, reports, …}]}`. Rendered by `ce-net.com/projects` and `ce-net.com/play`.

## Public URLs

| Pattern | Purpose |
| --- | --- |
| `https://ce-net.com/apps/<id>/` | Path hosting. |
| `https://<id>.ce-net.com/` | Per-developer subdomain (wildcard DNS live). |
| `https://ce-net.com/apps/<slug>/` | Human slug claimed via `ce-app slug claim` (not-found fallback). |
| `https://<custom-domain>/` | CNAME to `ce-net.com`, then `ce-app domain add`. |

`/db/<app>/<key>` and `wss://ce-net.com/rt/<app>/<room>` work on all of these origins.
