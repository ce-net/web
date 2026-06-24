# Slugs, the projects registry, and feedback

Three surfaces turn a deployed app into a named, discoverable, reportable project. All writes are
signed with your one CE identity (see [identity](identity.md)); the public reads are unsigned.

---

## Slugs — human-readable names

A slug is a short human name that maps to an owner + app id. A claimed slug resolves at the hub's
not-found fallback, so `https://ce-net.com/apps/<slug>/...` serves the claimed app **with no nginx
change**. Slug writes **require a valid signature** (they are owner-scoped, not anonymous-open), so
a machine with no usable secret key cannot claim.

```bash
ce-app slug claim   [name]   # claim <name> (or ce.json "slug") for this app id
ce-app slug renew   [name]   # extend the expiry (owner only)
ce-app slug release [name]   # release the slug (owner only)
ce-app slug status  [name]   # resolve a slug -> app id / owner / expiry / alive
ce-app slug ls      [names]  # show known slugs owned by this identity
```

The slug defaults to the project name (`ce.json` `slug` / `--slug` / project) and the app id to the
deployed app (`--app` / `./.ce/app-id` / `<project>-<nodeprefix>`). A claim prints the owner, the
expiry, and the serving URL.

| Method | Path | Signed | Use |
| --- | --- | --- | --- |
| POST | `/slugs/claim` | yes | claim `{slug, app_id}` -> owner + expiry |
| POST | `/slugs/renew` | yes | push the expiry out (owner only) |
| POST | `/slugs/release` | yes | release `{slug}` (owner only) |
| GET | `/slugs/:slug` | no | resolve `{app_id, owner, expires_unix, alive}` |

A set of names is **reserved** and can never be claimed (they are hub-owned namespaces):
`registry`, `apps`, `db`, `rt`, `blobs`, `domains`, `slugs`, `projects`, `stats`, `nodes`,
`tasks`, `node`, `health`, `_host`, `admin`, `api`, `www`. Each identity may hold up to
`owner_slug_cap` slugs (default 25; see [limits](limits.md)).

---

## The public projects registry

`ce-app publish` records your project in the registry so the site can render it. Screenshots are
uploaded to the **content-addressed** blob store (`PUT /blobs/<sha256>`, the hub re-derives and
verifies the hash) and **pinned** by the project record against FIFO eviction. `public` gates
visibility in `GET /registry`.

```bash
ce-app publish              # read ce.json, upload screenshots, POST /projects
ce-app unpublish [id]       # DELETE /projects/<id> (owner only)
ce-app project ls           # GET /registry -> the public projects list
```

`publish` reads `ce.json` (or `ce-app.json`):

```json
{
  "project": "drift", "title": "drift", "description": "…",
  "tags": ["game", "wasm"], "site": "https://drift.ce-net.com/",
  "screenshots": ["docs/shot1.png", "<existing-blob-hash>"],
  "public": true, "app_id": "drift", "id": "<stable-project-id>"
}
```

CLI flags override config: `--title`, `--desc`, `--tags a,b,c`, `--site`, `--slug`, `--app`,
`--shot <file>` (repeatable), `--id`, `--private` (publish unlisted), `--json`. Screenshot entries
that are already a 64-hex hash are passed through as pre-existing blobs; everything else is uploaded.

| Method | Path | Signed | Use |
| --- | --- | --- | --- |
| POST | `/projects` | yes | publish/update a project; returns `{id, owner}` |
| DELETE | `/projects/:id` | yes | unpublish (owner **or** admin) |
| POST | `/projects/:id/report` | no | flag a project (per-IP rate-limited) |
| GET | `/registry` | no | the public list: `{projects:[…]}` |

Registry entries carry the live `hosted` status, `rooms`, `tags`, pinned `screenshots`, and a
`reports` count. `ce-net.com/projects` and `ce-net.com/play` render `GET /registry` dynamically.
Deleting a project is owner-scoped, with an **admin** override (`CE_HUB_ADMIN_OWNER`) for
moderation — see [admin](admin.md).

---

## Feedback

`feedback.ce-net.com` (also `ce-net.com/apps/feedback/`) is a realtime feedback board that runs as
one CE app on mesh primitives only — one board per target project, durable in `/db/feedback`, live
over `/rt/feedback/t:<target>`, with a drop-in shadow-DOM `embed.js` widget.

```html
<script src="https://feedback.ce-net.com/embed.js"
        data-target="my-project"
        data-host="https://feedback.ce-net.com"></script>
```

Posts open threads; replies hang off a thread; upvotes are one-per-identity and toggle. Moderation
is **soft**: nothing is erased from the store — a post is visually collapsed once
`flags - upvotes >= 4` (community) or when its author hides it, and viewers can always reveal it.
This pairs with an 8s client-side per-board cooldown and the hub's **per-namespace IP rate limit**:
the operator sets `CE_HUB_RATELIMIT_NS=feedback`, so writes under that namespace are token-bucketed
per IP and over-budget requests get `429`. See `web/projects/feedback/README.md`.

---

## Identity and signing

All slug and project **writes** are signed with the canonical scheme (`x-ce-id` / `x-ce-sig` /
`x-ce-ts` / `x-ce-nonce`, over `METHOD\nPATH\nts\nnonce\nsha256(body)-hex`); the owner is
`sha256(pubkey)[..16]`. The hub verifies the signature and rejects a bad one with `401`. Blob PUTs
are content-addressed and open (signing them is harmless but not required). The shared identity and
signing helpers live in `ce-app/bin/slug.mjs` and are reused by `registry.mjs`. Full detail:
[identity](identity.md).
