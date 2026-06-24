# Hosting and frontend frameworks

CE hosts static sites and single-page apps. You upload built files; the hub serves them with the
right content type, applies SPA fallback, and injects a hot-reload snippet into HTML. There is no
build step on the server — you build locally (or the CLI does) and upload the output.

## Framework detection

`ce-app dev` and `ce-app deploy` auto-detect and build these frameworks, then upload the output
directory:

| Framework | Build output | Notes |
| --- | --- | --- |
| Vite | `dist/` | React or vanilla; `vite-react` and `vite` templates. |
| React | `dist/` or `build/` | `react` template. |
| Svelte | `dist/` / `build/` | `svelte` template. |
| Next | static export | `next` template; SPA fallback on. |
| Astro | `dist/` | Static output. |
| Expo / React Native | web export | `react-native` template; web build. |

## Uploading files

Each `PUT /apps/:id/*path` stores one file at that path with whatever `content-type` you send. An
empty path stores `index.html`. The response includes the incremented `version` and the public
`url`.

```bash
curl -X PUT https://ce-net.com/apps/my-app/assets/app.js \
  -H "content-type: application/javascript" \
  --data-binary @dist/assets/app.js
# -> { id, path, version, url }
```

## SPA fallback

Client-side routers need any unknown route to return `index.html`. Turn it on per app:

```bash
curl -X PUT https://ce-net.com/apps/my-app/config \
  -H "content-type: application/json" \
  -d '{"spa":true}'

curl https://ce-net.com/apps/my-app/config
# -> {"spa":true,"version":4,"domains":["app.acme.com"]}
```

```js
await fetch("https://ce-net.com/apps/my-app/config", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ spa: true }),
});
```

With SPA enabled, a route-like miss that has no file extension returns `index.html` with a `200`
status, so deep links and refreshes work. Requests for real assets (paths with an extension) still
`404` if missing, so a broken script tag is obvious.

## Hot reload

Every HTML page the hub serves gets a hot-reload snippet injected. It subscribes to
`GET /apps/:id/__reload`, an SSE stream that emits the app's `version` number on every change. When
you upload a new file, the version increments and the open page reloads. `ce-app dev` wires this for
you. See `hotreload` in the API and `hosting`/`api.md` for details.

## Public URLs

| Pattern | Purpose |
| --- | --- |
| `https://ce-net.com/apps/<id>/` | Path hosting. |
| `https://<id>.ce-net.com/` | Per-developer subdomain (wildcard DNS live). |
| `https://<custom-domain>/` | CNAME to `ce-net.com`, then `ce-app domain add`. |
