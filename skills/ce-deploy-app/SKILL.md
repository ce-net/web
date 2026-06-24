# ce-deploy-app

Scaffold a web app, run it live with hot reload, deploy it, and put it on a custom
production domain. The CE hub hosts static sites and SPAs globally at
`https://ce-net.com/apps/<id>/` and on a wildcard subdomain `https://<id>.ce-net.com/`.

## When to use

- You need to ship a website, SPA, or front end (Vite, React, Svelte, Next, Astro, Expo,
  or plain static) without provisioning any server, container, or registrar.
- You want a public URL in one command, live hot reload while editing, and an optional
  custom domain.

## Prerequisites

- Node.js (for `npm` / `npx`). No account, login, or API key is required.
- Network access to `https://ce-net.com`.
- The hub base defaults to `https://ce-net.com`; override with `--hub <base>` or `$CE_HUB`.
- Your public dev id is auto-created (16 hex chars) and stored at `./.ce/app-id`. Keep this
  file to keep the same URL across deploys. Override per command with `--app <id>`.

## Steps

### 1. Scaffold

```bash
npm create ce-app
# or pick a template and target dir:
npx ce-app new <template> <dir>
# no template name lists the available templates:
npx ce-app new
```

Templates: `chat`, `notes`, `board`, `vite-react`, `svelte`, `react`, `next`,
`react-native`. `npm create ce-app` scaffolds the chat template.

### 2. Develop with live hot reload

```bash
cd <dir>
npx ce-app dev
```

This auto-detects the framework, builds, uploads, and prints your public URL
`https://ce-net.com/apps/<id>/`. It watches your files and live-uploads on every save;
the hub injects a hot-reload snippet into served HTML, so the open page refreshes itself.

### 3. Deploy (one-shot)

```bash
npx ce-app deploy
```

Auto-detects the framework, builds, uploads, and enables SPA routing. Your app is live at
both:

- `https://ce-net.com/apps/<id>/`
- `https://<id>.ce-net.com/`

### 4. Custom production domain

```bash
# 1) Point your domain at the hub:
#    create a CNAME record  app.acme.com -> ce-net.com
# 2) Register it with the app:
npx ce-app domain add app.acme.com
```

`domain add` prints the CNAME target (`ce-net.com`) and a TLS note. List and remove:

```bash
npx ce-app domain ls
npx ce-app domain rm app.acme.com
```

Once the CNAME has propagated, `https://app.acme.com/` serves the app. nginx sets the
`X-CE-Host` header and the hub resolves the app via `GET /_host/*path`.

## Raw HTTP (no CLI)

The CLI is a thin wrapper over the hub. To upload files directly:

```bash
# Upload index.html (empty path = index.html):
curl -X PUT "https://ce-net.com/apps/<id>/" \
  -H "content-type: text/html" \
  --data-binary @dist/index.html
# -> {"id":"<id>","path":"index.html","version":<n>,"url":"..."}

# Upload an asset:
curl -X PUT "https://ce-net.com/apps/<id>/assets/app.js" \
  -H "content-type: application/javascript" \
  --data-binary @dist/assets/app.js

# Enable SPA fallback (route-like miss with no extension -> index.html, 200):
curl -X PUT "https://ce-net.com/apps/<id>/config" \
  -H "content-type: application/json" \
  -d '{"spa":true}'

# Read config:
curl "https://ce-net.com/apps/<id>/config"
# -> {"spa":true,"version":<n>,"domains":[...]}

# Add a custom domain:
curl -X PUT "https://ce-net.com/apps/<id>/domain" \
  -H "content-type: application/json" \
  -d '{"domain":"app.acme.com"}'
# -> {"domain":"app.acme.com","id":"<id>","cname":"ce-net.com"}

# Remove it:
curl -X DELETE "https://ce-net.com/apps/<id>/domain/app.acme.com"

# List all custom domains on the hub:
curl "https://ce-net.com/domains"
# -> [{"domain":"...","id":"..."}]

# Hot-reload SSE stream (emits the version number on every change):
curl -N "https://ce-net.com/apps/<id>/__reload"
```

## Gotchas

- The same `./.ce/app-id` is what keeps your public URL stable. Delete it and you get a new
  id and a new URL. Commit it (or back it up) if you care about the URL.
- SPA routing is off until you enable it (`ce-app deploy` enables it; raw uploads need
  `PUT /apps/<id>/config {"spa":true}`). Without it, deep links 404 instead of returning
  `index.html`.
- SPA fallback only triggers for route-like misses with no file extension. A missing
  `*.js`/`*.css` still 404s.
- An empty upload path means `index.html` (`PUT /apps/<id>/` writes the index).
- Storage limits (HTTP 507 on overflow): 16 MB per file, 64 MB per app, 200 files per app,
  global 200 apps and 100 custom domains. See `../../deploy/storage-limits.md`.
- Custom domains require a CNAME to `ce-net.com` first; `domain add` only registers the
  mapping, it does not create DNS. TLS is handled at the edge once the CNAME resolves.
- No emojis in any content you ship through these tools.
