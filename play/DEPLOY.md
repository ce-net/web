# Deploying the CE Playground to ce-net.com/play

The playground is a static Vite bundle. It is served at `https://ce-net.com/play`,
a sibling of the existing static pages (`/`, `/node.html`, `/network.html`). It reuses
the existing relay + nginx + Cloudflare stack documented in `web/deploy/` — no new
service, no new origin.

## 1. Build

```bash
cd ~/ce-net/web/play
npm install          # links @ce-net/sdk from ../../ce-ts (file: dependency)
npm run build        # tsc (typecheck) + vite build → dist/
```

`vite.config.ts` sets `base: "./"`, so every emitted asset URL is relative. The bundle
therefore works unchanged whether it is served from `/play/` (production) or `/`
(`npm run preview`, local). `dist/` contains `index.html` + hashed `assets/*.js,*.css`.

## 2. Upload to the relay

The relay web root is `/var/www/ce-net` (see `web/deploy/deploy.sh`). Put the playground
under a `play/` subdirectory so it answers at `/play`:

```bash
RELAY="root@178.105.145.170"        # load your key first: ssh-add ~/.ssh/id_ed25519
ssh "$RELAY" 'mkdir -p /var/www/ce-net/play'
scp -r dist/* "$RELAY:/var/www/ce-net/play/"
```

(Mirror the style of `web/deploy/deploy.sh`; that script owns the canonical upload flow
for the static pages and can be extended to also push `play/dist/*` when convenient.)

## 3. nginx

The default `ce-net.com` server block already serves `/var/www/ce-net` with
`index.html`, and `try_files`-style static serving covers nested directories. Because the
bundle uses **relative** asset paths, no rewrite rule is needed: requesting
`https://ce-net.com/play` returns `play/index.html`, whose assets resolve under
`/play/assets/...`. If a one-liner SPA fallback is ever wanted, add to `web/deploy/nginx.conf`:

```nginx
location /play/ {
    try_files $uri $uri/ /play/index.html;
}
```

The read-only **node** routes the playground's "my local node" target depends on are the
ones already proxied (`/health`, `/bootstrap`, `*/stream`) plus the node's own CORS layer
(`--cors`, default-on for localhost). The browser hits the developer's *own* `:8844`
directly; the relay is not involved for that path. The "in-browser node" target talks to
`window.__ceNode` injected by the existing browser-node engine (`node.html` + ce-hub) —
also no relay surface change.

## 4. Verify

```bash
ssh "$RELAY" 'curl -s -o /dev/null -w "/play -> %{http_code}\n" http://127.0.0.1/play/ -H "Host: ce-net.com"'
```

Then load `https://ce-net.com/play` and click **Run** on the **Node status** recipe.

## Notes

- `@ce-net/sdk` is consumed as a `file:` dependency (`../../ce-ts`). For a clean CI build
  that does not depend on a sibling checkout, switch to the published npm package once it
  ships (`"@ce-net/sdk": "^0.1.0"`); the import paths are unchanged.
- No secrets are bundled. A local-node API token, if entered, is read only from the user's
  own input and handed straight to the SDK — it is never written into editable code or sent
  anywhere but the user's own `:8844`.
