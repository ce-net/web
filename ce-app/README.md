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
ce-app deploy              # 3. ship — one-shot full upload (no watch)
```

## CLI

| Command | What it does |
|---|---|
| `ce-app new <template> [dir]` | Scaffold a template (default `chat`). |
| `ce-app dev` | Build, watch, and live-upload every output file to `/apps/<id>/<relpath>`. Prints the public URL. Hot reload is automatic. |
| `ce-app deploy` | One-shot full build + upload (no watch). |
| `ce-app smoke` | Bundle a tiny fixture locally and self-check (no network). |

Flags: `--hub <base>` (default `https://ce-net.com`, or `$CE_HUB`), `--app <id>`
(default `./.ce/app-id`), `--help`.

### Build

- If a `vite.config.*` is present, `ce-app` spawns `vite build` (and `vite build --watch`
  for `dev`) and uploads `dist/`.
- Otherwise it bundles `src/main.{ts,js}` + `src/index.html` with **esbuild** into `out/`.

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
