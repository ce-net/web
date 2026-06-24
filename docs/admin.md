# Admin and moderation (identity-based)

Hub administration is **identity-based**, not a shared token. There is no admin password, no
bearer secret, and nothing to leak: a request is admin if it is **signed by an operator identity**
the hub is configured to trust. The authority is the signature, not a string anyone could copy.

## How an admin request is recognized

Every mutating request to the hub may be signed with the canonical scheme (see
[identity](identity.md)): `x-ce-id` / `x-ce-sig` / `x-ce-ts` / `x-ce-nonce`, signing
`METHOD\nPATH\nts\nnonce\nsha256(body)-hex`. The hub verifies the Ed25519 signature and derives
the **owner id** as `sha256(pubkey)[..16]` (32 hex chars).

The operator configures one or more admin owner ids via the `CE_HUB_ADMIN_OWNER` environment
variable (comma-separated). A signed request whose derived owner id is in that set is treated as
**admin**:

```ini
# deploy/ce-hub.service
Environment=CE_HUB_ADMIN_OWNER=52aa664acd1bde0a1da5224a037aea1a
```

This value is the laptop's CE node identity (the operator). An owner id is **public** — it is a
hash of a public key — so it is safe to commit in the unit file. It grants nothing on its own; only
a request that produces a valid signature for that identity is admin. There is no shared secret to
rotate or revoke.

## What admin unlocks

Admin is for **moderation**, not for bypassing storage budgets. Today an admin-signed request can:

- **Delete any published project** — `DELETE /projects/:id` succeeds for the project's owner *or*
  for any admin owner. Non-admins can only delete their own projects.

Ordinary owner-scoped operations (claiming a slug, publishing a project, writing your own app) are
authorized by being signed by **that resource's owner**, with no admin needed. Admin is the
narrow override for cleaning up content the operator must moderate.

## Signed owners get generous identity-scoped quotas

The same signature that authorizes a write also **attributes** it, which is what unlocks larger
limits. Anonymous (unsigned) writes keep small, conservative caps so an unattributable script can
never fill the relay's disk. A **signed, owned** write earns a larger, per-identity quota that
grows with the node's uptime/trust:

| Writer | Quota |
| --- | --- |
| **Anonymous** (no valid signature) | the conservative anonymous caps |
| **Signed / owned** (valid `x-ce-id`) | generous, per-identity, revocable, rate-limited per id |
| **Trusted** (uptime / on-chain trust) | grows over time toward `owner_trust_max` |

The hub surfaces this as the `owner_*` block in `GET /stats.limits` (`owner_app_bytes`,
`owner_trust_max`, `owner_slug_cap`). The per-owner app budget scales toward `owner_trust_max` as a
node's uptime rises — a node that maps to your owner id (`owner = sha256(node-pubkey)[..16]`) lifts
your quota by contributing uptime. Raising your headroom is therefore not a purchase; it is earned
the same way trust is earned everywhere in CE. Full detail: [limits](limits.md).

## Operator environment summary

| Env var | Meaning |
| --- | --- |
| `CE_HUB_ADMIN_OWNER` | comma-separated admin **owner ids** (`sha256(pubkey)[..16]`); a signed request from one of these is admin. |
| `CE_HUB_OWNER_APP_BYTES` | base per-owner app byte budget (default 256 MiB). |
| `CE_HUB_OWNER_TRUST_MAX` | max trust multiplier applied to the base budget at 100% uptime. |
| `CE_HUB_OWNER_SLUG_CAP` | per-owner slug cap (default 25). |
| `CE_HUB_RATELIMIT_NS` | comma-separated namespaces under a per-IP rate limit (e.g. `feedback`). |

The anonymous/global caps (`CE_HUB_MAX_DATA_BYTES`, `CE_HUB_MAX_APPS`, `CE_HUB_MAX_DOMAINS`,
`CE_HUB_MAX_DB_NAMESPACES`) are documented in [limits](limits.md).
