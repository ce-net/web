# @ce-net/play — hosted interactive CE playground

A single-page, zero-install playground where a visitor drives a real CE node with
[`@ce-net/sdk`](../../ce-ts), live, in the browser. It implements **M5** of the demos/DX
plan (`PLAN/07-demos-dx.md`): a recipe picker, a read-only SDK code pane, and a live output
console that runs each recipe against the connected node and renders the node's real
responses.

## What it does

- **Point at a node.** Toggle between the **in-browser node** (the WASM node injected on
  `window.__ceNode` by `node.html` + ce-hub) and **your local node** (`http://127.0.0.1:8844`,
  reachable thanks to the node's read-only CORS layer). For a local node you may paste an
  API token (used only for write recipes; reads need none).
- **Run cookbook recipes live.** Each card shows the exact `@ce-net/sdk` snippet *and*
  executes it, streaming real responses:
  1. **Node status** — `status()`, `bootstrap()`
  2. **Stream blocks** — `streams.blocks()` (typed SSE, for-await-of)
  3. **Stream transactions** — `streams.transactions()`
  4. **Blob roundtrip** — `data.putBlob()` / `data.getBlob()` (content addressing)
  5. **Transfer credits** — `transfer()` + `Amount` (the no-floats money model)
  6. **Mesh request / reply** — `mesh.subscribe/request/reply` (device-to-device RPC)
  7. **Place a job** — `jobs.bid()` / `jobs.get()` (the compute lifecycle)
  8. **Atlas & reputation** — `atlas()` / `history()` (capacity-aware placement)

Nothing is mocked: the SDK makes real HTTP/SSE calls to the connected node. No user-typed
code is `eval`'d — recipes are first-party TypeScript, so the page has no code-injection or
token-exfiltration surface.

## Develop

```bash
npm install     # links @ce-net/sdk from ../../ce-ts
npm run dev      # vite dev server
npm run build    # tsc typecheck + vite build -> dist/
```

## Architecture

| File | Role |
|---|---|
| `index.html` | Static shell + design system (shared with `web/site`) |
| `src/main.ts` | UI wiring: picker, code pane, console, run loop, status bar |
| `src/recipes/*` | One file per recipe — `source` (shown) + `run()` (executed) adjacent |
| `src/connection.ts` | Builds a `CeClient` for the chosen target; status snapshots |
| `src/bridge.ts` | `window.__ceNode` bridge → `fetch` adapter (the in-browser-node contract) |
| `src/highlight.ts` | Dependency-free highlighter for the read-only code pane |
| `src/console.ts` | Append-only, classified, timestamped output pane |

The `@ce-net/sdk` is constructed with a `baseUrl` and (for the bridge target) an injected
`fetch`, so the **real, unmodified** SDK drives both a local node and the in-browser node.

See [`DEPLOY.md`](./DEPLOY.md) for shipping to `ce-net.com/play`.
