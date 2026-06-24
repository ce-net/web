# ce-app

One command to a live, globally reachable, hot-reloading app on **ce-net.com**.

```
npm create ce-app          # scaffold a chat app
cd chat && npm install
ce-app dev                 # build + watch + live-upload → prints your URL
```

Your app goes live at `https://ce-net.com/apps/<id>/`, where `<id>` is your public
dev id stored at `./.ce/app-id`. Edits hot-reload in the browser automatically.

## Three-command quickstart

```bash
npm create ce-app chat     # 1. scaffold (or: ce-app new chat)
ce-app dev                 # 2. develop — live URL printed, hot reload on save
ce-app deploy              # 3. ship — auto-detect framework, build, upload, enable SPA routing
```

`ce-app deploy` works on **any** common frontend project — there is nothing to
configure. It reads your `package.json` + config files, runs the right build, finds
the static output, uploads it, and turns on client-side-routing fallback for the app.

## CLI

| Command | What it does |
|---|---|
| `ce-app new [template] [dir]` | Scaffold a template. With no name, lists the available templates. |
| `ce-app dev` | Build, watch, and live-upload every output file to `/apps/<id>/<relpath>`. Prints the public URL. Hot reload is automatic. |
| `ce-app deploy` | Auto-detect the framework, build, upload, and enable SPA routing. |
| `ce-app domain add <domain>` | Register a custom production domain and print the CNAME + TLS steps. |
| `ce-app domain rm <domain>` | Unregister a custom domain. |
| `ce-app domain ls` | List this app's custom domains. |
| `ce-app detect` | Print the detected framework + output dir (no network). |
| `ce-app smoke` | Build a fixture and run framework-detection self-checks (no network). |

Flags: `--hub <base>` (default `https://ce-net.com`, or `$CE_HUB`), `--app <id>`
(default `./.ce/app-id`), `--help`.

### Framework auto-detection

On `deploy`, `ce-app` inspects `package.json` dependencies and config files and picks
the matching build recipe. It then runs that framework's own build (via the project's
`build` script, or `npx <tool>` as a fallback), locates the static output directory,
uploads it, and calls `PUT /apps/<id>/config {spa:true}` so client-side routers work.

| Detected | Trigger | Build | Output dir |
|---|---|---|---|
| Vite (vanilla/React/Vue/Svelte) | `vite` dep or `vite.config.*` | `vite build` | `dist/` |
| SvelteKit | `@sveltejs/kit` | `vite build` (static adapter) | `build/` or `dist/` |
| Next.js | `next` dep or `next.config.*` | `next build` (+ `next export` if needed) | `out/` |
| Astro | `astro` dep or `astro.config.*` | `astro build` | `dist/` |
| Nuxt | `nuxt` dep or `nuxt.config.*` | `nuxi generate` | `.output/public/` or `dist/` |
| Create React App | `react-scripts` | `react-scripts build` | `build/` |
| Expo / react-native-web | `expo` or `react-native-web` | `expo export --platform web` (or `export:web`) | `dist/` or `web-build/` |
| Static site | top-level `index.html`, no entry | copy as-is | `out/` |
| esbuild fallback | `src/main.{ts,js}` + `src/index.html` | bundle with esbuild | `out/` |

Run `ce-app detect` in your project to see exactly what will happen.

> **Asset base.** Apps are served under `/apps/<id>/` (and, with a custom domain, at the
> root). Make your asset base **relative** so a single build works in both places: set
> `base: "./"` in `vite.config`, `"homepage": "."` in CRA's `package.json`, `base` in
> `astro.config`, etc. `ce-app detect` prints the relevant hint for your framework.

### dev builds

- Vite projects use `vite build --watch`; `ce-app` watches `dist/` and pushes changes.
- esbuild-shaped projects (`src/main` + `src/index.html`) use the fast in-process
  esbuild watch into `out/`.
- Any other framework rebuilds on source change and re-uploads the output (slower, but
  correct for `dev`).

## Custom domains (production)

Point a domain at CE, then register it to your app:

```bash
ce-app domain add app.example.com     # registers the domain -> your app id
# CNAME  app.example.com  ->  ce-net.com
ce-app domain ls                      # list domains for this app
ce-app domain rm app.example.com      # unregister
```

`ce-app domain add` prints the exact DNS record and the two TLS options:
**Cloudflare for SaaS** custom hostnames (CE terminates TLS for your domain), or an
**origin certificate** installed on the relay. Once DNS propagates the app is live at
`https://app.example.com/` with the same SPA-fallback behavior as `/apps/<id>/`.

## Client library — `@ce/client`

Browser ESM, zero dependencies. Used by templates.

```js
import { createClient } from "@ce/client";

const ce = createClient();           // appId auto-resolved from /apps/<id>/
console.log(ce.appId, ce.base);

// Persistent KV, namespaced per app
await ce.db.set("greeting", { hi: true });
const v = await ce.db.get("greeting");
const recent = await ce.db.list("msg:", 50);   // newest-first
await ce.db.del("greeting");

// Realtime pub/sub room over websocket
const room = ce.room("lobby");
room.onOpen(() => room.send({ join: ce.appId }));
const off = room.on((msg) => console.log("got", msg));
room.send({ text: "hello everyone" });
// room.close();
```

### API surface

```ts
createClient(opts?) -> {
  appId: string,
  base: string,
  db: {
    get(key): Promise<value | undefined>,
    set(key, val): Promise<{ ok, key }>,
    del(key): Promise<{ ok }>,
    list(prefix?, limit?): Promise<{ key, value }[]>,
  },
  room(name) -> {
    send(obj | string): void,    // objects are JSON-stringified
    on(fn): () => void,          // unsubscribe; JSON auto-parsed
    onOpen(fn): () => void,
    close(): void,
  },
}
```

`appId` resolves from `location.pathname` matching `/apps/<id>/`, falling back to
`opts.app`, then `'demo'`.

## Public surface (served by the hub)

- App: `https://ce-net.com/apps/<id>/`
- KV: `https://ce-net.com/db/<app>/<key>`
- Realtime: `wss://ce-net.com/rt/<app>/<room>`

## Requirements

Node 18+. Dependencies: `esbuild`, `chokidar` (and `vite` only if your project uses it).
