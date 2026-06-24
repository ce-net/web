# ce-hub UI

A lightweight, dependency-free static SPA for `hub.ce-net.com` — the open-source git layer for
ce-net. It browses repositories, file trees, READMEs, commit logs, diffs, releases, live
instances and pull requests, and provides a (signed) merge action for PRs.

No build step, no framework, no `node_modules` to run. Plain HTML + CSS + vanilla JS.
Dark, cyan-accent ce-net aesthetic (matches `web/site`). No emojis.

## How it is served

This UI is deployed as a **hub-hosted app** on the same process that serves the API
(`web/ce-hub`, axum, port `:8970`). Two equivalent ways to serve it:

1. **As a hosted app (dogfood path).** Upload the files via the existing signed
   `PUT /apps/:id/*path` endpoint as an app marked `spa: true`. The hub already does
   SPA fallback to `index.html` for route-like GETs (see `serve_app_file` /
   `looks_like_route` in `web/ce-hub/src/main.rs`). Because this UI uses **hash-based
   routing** (`#/owner/repo/...`), every deep link resolves to `index.html` regardless of
   fallback behavior — no server route changes are needed for the UI itself.

2. **Mounted at the hub root.** When `hub.ce-net.com/` is wired (nginx -> `:8970`), serve
   this directory at `/` (e.g. a `ServeDir` fallback for non-API paths) so the API routes
   (`/repos`, `/git/...`, `/rt/...`) and the UI share one origin. The UI calls the API with
   **origin-relative paths**, so same-origin hosting requires zero configuration.

   For local development against a remote hub, append `?api=https://hub.ce-net.com` to the
   URL; `api.js` reads that and prefixes all calls.

The deploy itself (native build on the relay + nginx server block + Cloudflare A record) is
done by the human operator per `PLAN/hub-git-contract.md` — not by this UI.

## Files

| File | Purpose |
|---|---|
| `index.html`     | App shell: nav, fonts, palette, view mount, script loads |
| `app.css`        | All styling (ce-net dark/cyan theme) |
| `app.js`         | Hash router + every view + a tiny markdown renderer |
| `api.js`         | Thin client over the contract's JSON API (origin-relative) |
| `highlight.js`   | Tiny regex syntax highlighter (no dependency) |
| `diff.js`        | Unified-diff renderer (handles structured `files[]` or raw diff text) |
| `sign.js`        | Ed25519 signed-write headers for mutations (WebCrypto) |

## API it consumes

Only the read/write routes defined in `PLAN/hub-git-contract.md`. Reads are anonymous;
mutations carry the existing signed headers.

Reads (anonymous):
- `GET /repos?q=&page=` — repo list + search
- `GET /repos/:owner/:repo` — metadata (default_branch, refs/branches/tags, head, counts)
- `GET /repos/:owner/:repo/tree/:ref/*path` — directory listing
- `GET /repos/:owner/:repo/blob/:ref/*path` — file bytes (+ content-type)
- `GET /repos/:owner/:repo/commits/:ref?after=&limit=` — paged commit log
- `GET /repos/:owner/:repo/commit/:sha` — commit detail + diff
- `GET /repos/:owner/:repo/compare/:base/:head` — diff (powers PR diff)
- `GET /repos/:owner/:repo/releases` — tags as releases
- `GET /repos/:owner/:repo/instances` — live deployments view
- `GET /repos/:owner/:repo/pulls` — PR list
- `GET /repos/:owner/:repo/pulls/:n` — PR detail

Mutations (signed; see below):
- `POST /repos/:owner/:repo/pulls/:n/comments` — add a comment
- `POST /repos/:owner/:repo/pulls/:n/merge` — merge a PR (owner/maintainer)

Realtime:
- `GET /rt/ce-hub/repo:<owner>/<repo>:pr:<n>` — SSE room for live comment updates.
  If the room is unavailable, the UI falls back to polling `GET .../pulls/:n` every 5s.

The UI is defensive about response shapes (arrays vs `{items}`/`{repos}`/`{commits}`,
`sha|id|hash`, `tree`-entry `type|kind|is_dir`, diff as `files[]` or raw `diff` text), so it
keeps working as the backend firms up field names.

## Signing model (mutations)

`sign.js` builds the headers the server's `verify_signed` expects
(`web/ce-hub/src/main.rs`):

```
x-ce-id    = ed25519 public key (32 bytes hex)
x-ce-ts    = unix seconds
x-ce-nonce = single-use random hex
x-ce-sig   = ed25519( "METHOD\nPATH\nTS\nNONCE\nsha256hex(body)" )
body       = exactly the bytes hashed
```

It uses WebCrypto `Ed25519` (Chrome/Edge 137+, recent Firefox/Safari). For v1 the only wired
identity source is an **ephemeral in-page keypair** ("Connect signer") for testing the
comment/merge flow end to end.

**Documented TODO (browser signing wallet):** real key management — pairing a phone/laptop
identity via QR + relay, storing the master key in the ce-secrets vault, and proof-of-possession
— is specified in the mobile-auth design and is NOT wired here. Until then the merge/comment
buttons render and sign with an ephemeral key; production must replace `Sign.setIdentity(...)`
with the `ce wallet` / ce-secrets bridge so the signature is rooted in the user's real CE
identity (owner/maintainer authorization is enforced server-side regardless).

## Notes / scope

- Hash routing is intentional: it guarantees deep links work under any static/SPA fallback and
  needs no per-route server config.
- The syntax highlighter is a pragmatic regex tokenizer (good enough for browsing), not a full
  lexer. Swap in a heavier highlighter later if desired without touching the views.
- No external CDN code is required at runtime except Google Fonts (matching `web/site`); the app
  works without them (system-font fallback in the CSS stack).
