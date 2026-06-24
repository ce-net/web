# Quickstart

CE is a mesh of compute nodes with a developer platform on top. The platform (the `ce-hub`
service) is exposed publicly at `https://ce-net.com` and gives you app hosting, a persistent
database, realtime rooms, content-addressed blobs, and a compute task router. Everything in these
docs is deployed and reachable today.

Every endpoint is served from `https://ce-net.com` and is also reachable under the `/hub/<path>`
prefix.

## One-command developer flow

The fastest path is the `ce-app` CLI. It scaffolds a template, detects your framework, builds it,
uploads the result, prints your live URL, and hot-reloads on every save.

```bash
# scaffold the chat template into a new directory
npm create ce-app

# or pick a template explicitly
ce-app new vite-react my-app

# develop: auto-detect framework, build, upload, print URL, hot-reload on save
cd my-app && npx ce-app dev

# one-shot deploy without the watcher
npx ce-app deploy

# attach a custom production domain
npx ce-app domain add app.acme.com
```

`ce-app dev` prints a URL like `https://ce-net.com/apps/<your-id>/`. Your app id (your public
developer id) is generated once and stored at `./.ce/app-id`, so every later command targets the
same app.

Templates: `chat`, `notes`, `board`, `vite-react`, `svelte`, `react`, `next`, `react-native`.

## Deploy without the CLI

The CLI is a wrapper over the HTTP API. Upload a built site with `PUT` requests and it goes live
immediately. The empty path is your `index.html`.

```bash
# upload index.html (empty path means the app root)
curl -X PUT https://ce-net.com/apps/my-app/ \
  -H "content-type: text/html" \
  --data-binary @dist/index.html

# upload an asset
curl -X PUT https://ce-net.com/apps/my-app/assets/app.js \
  -H "content-type: application/javascript" \
  --data-binary @dist/assets/app.js
```

```js
const base = "https://ce-net.com";
const id = "my-app";

await fetch(`${base}/apps/${id}/`, {
  method: "PUT",
  headers: { "content-type": "text/html" },
  body: "<!doctype html><h1>hello from CE</h1>",
});
// -> { id: "my-app", path: "index.html", version: 1, url: "/apps/my-app/" }
```

## One origin, three ways to reach it

Your app, its database, and its rooms are all available on:

| Origin | URL |
| --- | --- |
| Path | `https://ce-net.com/apps/<id>/` |
| Subdomain | `https://<id>.ce-net.com/` (wildcard DNS live) |
| Custom | `https://<custom-domain>/` (CNAME to `ce-net.com`) |

`/db/<app>/<key>` and `wss://ce-net.com/rt/<app>/<room>` work on all of these origins.

## Run a node

- Browser: open `https://ce-net.com/node` — the tab becomes a real WASM/JS compute node and mesh
  peer (iOS and Android too).
- Headless: `curl -fsSL https://ce-net.com/worker.js | node - --hub wss://ce-net.com/hub`

Live metrics are at `https://ce-net.com/network`.
