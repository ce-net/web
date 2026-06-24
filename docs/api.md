# HTTP API reference

Base origin `https://ce-net.com` (service `ce-hub`, exposed publicly via nginx). Every endpoint is
also reachable under the `/hub/<path>` prefix. Bodies are JSON unless noted; blob and file uploads
take a raw body with a `content-type`.

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

## Public URLs

| Pattern | Purpose |
| --- | --- |
| `https://ce-net.com/apps/<id>/` | Path hosting. |
| `https://<id>.ce-net.com/` | Per-developer subdomain (wildcard DNS live). |
| `https://<custom-domain>/` | CNAME to `ce-net.com`, then `ce-app domain add`. |

`/db/<app>/<key>` and `wss://ce-net.com/rt/<app>/<room>` work on all of these origins.
