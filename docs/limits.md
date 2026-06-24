# Storage limits

Limits protect the host disk and are conservative by default; the globals are environment-
configurable. Over-budget writes return HTTP `507`.

## Global (env-configurable)

| Env var | Default | Limits |
| --- | --- | --- |
| `CE_HUB_MAX_DATA_BYTES` | 512 MiB | Total platform data. |
| `CE_HUB_MAX_APPS` | 200 | Hosted apps. |
| `CE_HUB_MAX_DOMAINS` | 100 | Custom domains. |
| `CE_HUB_MAX_DB_NAMESPACES` | 500 | Database namespaces. |

## Per item

| Scope | Limit |
| --- | --- |
| File | 16 MB |
| App | 64 MB, 200 files |
| Blob | 16 MB per blob, 256 MB store |
| Database | 5000 keys per namespace |

## Contributor caches

Contributor nodes cap the replicated-file cache they hold, oldest-evicted:

- Browser node: 32 MiB (tunable via `?cache=`).
- Headless worker: 64 MiB (via `CE_WORKER_MAX_CACHE_BYTES`).

Full detail lives in `web/deploy/storage-limits.md`.

## Live limits

The active globals are reported in `GET /stats` under
`limits{max_data_bytes, max_apps, max_domains, max_db_namespaces}`, alongside `data_used_bytes`,
`hosted_apps`, and `replicas`.
