# Limits

Limits exist for one reason: to stop an **anonymous** writer from filling the relay's disk. They are
not a paywall and not a punishment — they are the floor that keeps a shared, open relay usable by
everyone. The model is simple: anonymous writes keep small, conservative caps; **signed, owned**
writes earn larger, identity-scoped quotas that grow with your node's uptime and trust.

## Why caps exist

The hub hosts apps, a small database, blobs, and realtime rooms for anyone, with no signup. Anything
open to anyone is open to abuse: a single script can PUT files until the disk is full. So the hub
enforces conservative global and per-item caps and returns an explicit over-budget status rather than
silently degrading for everyone. Over-budget storage writes return HTTP `507`; an app that has hit
its app cap returns the same.

## Anonymous vs identity-scoped (the model)

Every mutating request ce-app sends is **signed** with your one identity (`x-ce-id` / `x-ce-sig` /
`x-ce-ts` / `x-ce-nonce` — see [identity](identity.md)), and the hub now **verifies** it. A request
with a valid signature is attributed to its **owner** (`owner = sha256(pubkey)[..16]`) and earns a
larger, identity-scoped quota; a request with **no** signature stays anonymous on the conservative
caps below; a request with a signature that fails any check is rejected `401`.

| Writer | Quota | Rationale |
| --- | --- | --- |
| **Anonymous** (no signature) | the small caps below | bounded blast radius for unattributable writes. |
| **Signed / owned** (valid `x-ce-id`) | generous, per-identity | attributable, revocable, and rate-limited per id. |
| **Trusted** (uptime / on-chain trust) | grows over time | a node that contributes uptime earns headroom. |

The principle behind the gradient is CE's trust model: trust is **earned, non-sellable**, and it
gates how much of the shared resource you may consume. An owned app is one with a non-empty owner id;
the hub tracks ownership and surfaces an `owner_*` budget block in `/stats.limits` as the substrate
for this. Raising your quota is therefore not a purchase — you raise it by running a node and
accumulating uptime/trust, the same currency CE uses everywhere. The per-owner app budget scales
from `owner_app_bytes` toward `owner_app_bytes * owner_trust_max` as a node mapped to your owner id
accrues uptime.

> Signed owners get generous, identity-scoped quotas; admin is identity-based too (a request signed
> by an operator identity in `CE_HUB_ADMIN_OWNER`). See [admin](admin.md). Slug and project writes
> **require** a signature; ordinary app/db/blob writes accept anonymous on the smaller caps.

## Anonymous / global caps (today)

These are the conservative defaults; the globals are environment-configurable by the operator.

| Env var | Default | Limits |
| --- | --- | --- |
| `CE_HUB_MAX_DATA_BYTES` | 512 MiB | Total platform data (apps + db + blobs). |
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
| Slugs | `owner_slug_cap` per owner (default 25) |

## Per-namespace IP rate limit

Namespaces named in `CE_HUB_RATELIMIT_NS` (comma-separated, e.g. `feedback`) are token-bucketed
per client IP. Over-budget writes return `429`. This is anti-spam for high-write public apps like
the [feedback](registry.md#feedback) board, separate from the storage caps above. Project reports
(`POST /projects/:id/report`) are rate-limited the same way.

## Contributor caches

Contributor nodes cap the replicated-file cache they hold, oldest-evicted:

- Browser node: 32 MiB (tunable via `?cache=`).
- Headless worker: 64 MiB (via `CE_WORKER_MAX_CACHE_BYTES`).

Full operational detail lives in `web/deploy/storage-limits.md`.

## Reading the live limits

The active globals and current usage are in `GET /stats` (and the apex `GET /hub/stats`) under
`limits` and the top-level usage fields:

```json
{
  "data_used_bytes": 204800,
  "hosted_apps": 11,
  "replicas": 4,
  "limits": {
    "max_data_bytes": 1073741824,
    "max_apps": 500,
    "max_domains": 100,
    "max_db_namespaces": 500,
    "owner_app_bytes": 67108864,
    "owner_trust_max": 5,
    "owner_slug_cap": 8,
    "owned_apps": 6
  }
}
```

The `owner_*` fields are the identity-scoped budget substrate: `owner_app_bytes` is the per-owner app
budget, scaled toward `owner_trust_max` as a node's trust rises. `ce-app doctor` reads these and
reports headroom (`data N% of M · apps X/Y`), and the [debug dashboard](/debug) draws the same bars.
When a write exceeds budget, the hub answers `507` and ce-app surfaces the cap in the error.
