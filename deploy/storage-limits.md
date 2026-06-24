# Hub storage limits

The `ce-hub` hosts apps, a KV database, blobs, and per-node records on disk under `CE_HUB_DATA`.
Anyone can call the public write endpoints, so the hub enforces limits that stop a stranger from
filling the host's disk. Per-item caps bound a single object; global caps bound the totals and the
counts. All are configurable by environment variable, with deliberately conservative defaults.

## Global limits (env-configurable)

| Variable | Default | What it caps |
|---|---|---|
| `CE_HUB_MAX_DATA_BYTES` | `536870912` (512 MiB) | Total on-disk bytes shared by hosted apps + database + blobs. A write that would push the total over budget is rejected with HTTP 507. |
| `CE_HUB_MAX_APPS` | `200` | Number of distinct hosted apps. Creating a new app beyond this returns 507. |
| `CE_HUB_MAX_DOMAINS` | `100` | Number of registered custom domains. |
| `CE_HUB_MAX_DB_NAMESPACES` | `500` | Number of distinct database namespaces (apps with data). |

The relay sets explicit values in `deploy/ce-hub.service` (1 GiB budget). Raise per host as trust grows.

## Per-item caps (compile-time constants)

- App file: 16 MiB; app total: 64 MiB; app file count: 200.
- Blob: 16 MiB each; blob store: 256 MiB (FIFO eviction).
- Database: 5000 keys per namespace (oldest evicted on overflow).

## Visibility

`GET /stats` reports the active `limits` object plus `data_used_bytes` and `hosted_apps`, so usage
against budget is observable live (and on the `/network` dashboard).

## Contributor nodes

Browser and headless nodes that accept replicated app files cap how much of other people's data they
will hold, so a hub can never use unbounded memory on a contributor's device:

- Browser node (`/node`): default 32 MiB, override with `?cache=<bytes>` (`0` disables the cache).
- Headless worker (`worker.js`): default 64 MiB, override with `CE_WORKER_MAX_CACHE_BYTES`.

Oldest entries evict first; a single item larger than the whole budget is refused. The relay remains
the source of truth, so dropping a cached replica is always safe.
