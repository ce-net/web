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
| `ce-app whoami` | Print your one identity, nodeprefix, and where it came from (no network). |
| `ce-app link [token]` | Print the device-pairing flow (capability/QR) — a documented design stub. |
| `ce-app dev` | Build, watch, and live-upload every output file to `/apps/<id>/<relpath>`. Prints the public URL. Hot reload is automatic. |
| `ce-app deploy` | Auto-detect the framework, build, upload, and enable SPA routing. |
| `ce-app domain add <domain>` | Register a custom production domain and print the CNAME + TLS steps. |
| `ce-app domain rm <domain>` | Unregister a custom domain. |
| `ce-app domain ls` | List this app's custom domains. |
| `ce-app detect` | Print the detected framework + output dir (no network). For Rust projects, also audits the wasm toolchain. |
| `ce-app smoke` | Build a fixture and run framework-detection + signing self-checks (no network). |

Flags: `--hub <base>` (default `https://ce-net.com`, or `$CE_HUB`), `--app <id>`
(default `./.ce/app-id`), `--help`.

### Framework auto-detection

On `deploy`, `ce-app` inspects `package.json` dependencies and config files and picks
the matching build recipe. It then runs that framework's own build (via the project's
`build` script, or `npx <tool>` as a fallback), locates the static output directory,
uploads it, and calls `PUT /apps/<id>/config {spa:true}` so client-side routers work.

| Detected | Trigger | Build | Output dir |
|---|---|---|---|
| Rust → wasm (Trunk) | `Cargo.toml` + `Trunk.toml` / `data-trunk` | `trunk build --release --public-url ./` | `dist/` |
| Rust → wasm (wasm-pack) | `Cargo.toml` cdylib + `./pkg/` import or `wasm-bindgen` | `wasm-pack build --target web` | `dist/` (glue under `dist/pkg/`) |
| Rust → wasm (raw cargo) | `Cargo.toml` with a `[lib]` / cdylib | `cargo build --release --target wasm32-unknown-unknown` (+ `wasm-opt -Oz` if present) | `dist/` |
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

## Identity — one per person, reused everywhere

ce-app **never mints a second id**. It resolves one identity, in order, and the
first that exists is the source of truth:

1. **The CE node identity.** If the `ce` CLI is installed, `ce id` is your node id
   (64 hex). The matching Ed25519 secret key at
   `~/.local/share/ce/identity/node.key` (when present) **signs your writes**.
2. **One local keypair.** Otherwise ce-app creates a single Ed25519 keypair at
   `~/.ce/identity` **once** and reuses it forever. Its node id is `sha256(pubkey)`.

The old `~/.ce/id` and any per-project `./.ce/app-id` **migrate** to this single
identity — existing deploys keep working (a project pinned to `<name>-<oldprefix>`
stays reachable at exactly that id; the source-of-truth id file converges on the
one identity). `nodeprefix` = the id's first 10 hex chars; it namespaces every
project subdomain.

```bash
ce-app whoami     # id, nodeprefix, source, where it came from, signing on/off
```

Multiple devices converge on the **same** id via a signed capability (the same
primitive CE uses everywhere). `ce-app link` documents that pairing flow and emits
a valid pairing token (QR-able); the full QR/relay transport + capability issuance
land in a later wave.

```bash
ce-app link              # print the pairing offer + token (on the device that holds the id)
ce-app link <token>      # on the new device: show what it would sign + request (stub)
```

## Signed writes — invisible, forward-compatible

Every **mutating** request (app file `PUT`, config `PUT`, domain `PUT`/`DELETE`,
and future slug/registry/feedback writes) is signed with your identity using a
canonical scheme fixed now so a future hub can verify it:

```
headers:
  x-ce-id:    <pubkey-hex>
  x-ce-sig:   <ed25519 signature, hex>
  x-ce-ts:    <unix-ms>
  x-ce-nonce: <random hex>

canonical string (newline-joined, exact order):
  METHOD "\n" PATH "\n" ts "\n" nonce "\n" sha256(body)-hex
```

`PATH` is the request path + query with no host (e.g. `/apps/chat-abcd/index.html`);
`body` is the raw request bytes (`sha256("")` for an empty body). The **live hub
ignores these headers today**, so anonymous `PUT`s keep working — signing is
additive and never breaks an existing deploy. Signing uses Node's built-in
`crypto` (Ed25519); when no secret key is available, writes go out anonymously
(still valid). The rationale: caps exist to stop **anonymous** writers filling the
relay disk; signed/owned writes earn generous, identity-scoped quotas that grow
with node uptime/trust, while anonymous writes keep today's small caps.

## Rust → wasm (+wgpu)

A `Cargo.toml` at the project root selects the Rust→wasm recipe (ahead of the
static/esbuild paths). `ce-app` picks the build variant from the files present,
runs a toolchain preflight with exact install hints, builds to `dist/`, and uploads
with the correct `application/wasm` MIME — warning on any file over the hub's
per-file cap (probed from `/hub/stats` → `/stats`, default 16 MiB).

| Variant | Selected when | Command |
|---|---|---|
| `trunk` | `Trunk.toml` or a `data-trunk` link, or a `trunk` dep | `trunk build --release --public-url ./` |
| `wasm-pack` | a cdylib crate + a `./pkg/` import or `wasm-bindgen` (or `ce-app.json {"wasm":"wasm-pack"}`) | `wasm-pack build --release --target web` |
| `cargo` | any `[lib]` / cdylib crate | `cargo build --release --target wasm32-unknown-unknown` (+ `wasm-opt -Oz` when available) |

Preflight checks `rustc`/`cargo`, the `wasm32-unknown-unknown` target, and the
variant's tool, printing install hints like
`rustup target add wasm32-unknown-unknown`, `cargo install --locked trunk`, or
`cargo install wasm-pack`. `ce-app detect` prints a quick toolchain audit. Scaffold
a ready-to-run multiplayer starter with `ce-app new rust-game`, or just the
authoritative crate with `ce-app new rust-backend`.

## Public surface (served by the hub)

- App: `https://ce-net.com/apps/<id>/`
- KV: `https://ce-net.com/db/<app>/<key>`
- Realtime: `wss://ce-net.com/rt/<app>/<room>`

## Requirements

Node 18+ (uses the built-in `crypto` module for Ed25519 signing — no extra crypto
dependency). Dependencies: `esbuild`, `chokidar` (and `vite` only if your project
uses it). Rust→wasm projects additionally need the Rust toolchain + the
`wasm32-unknown-unknown` target, and `trunk` / `wasm-pack` for those variants;
`ce-app` prints the exact install commands when anything is missing.
