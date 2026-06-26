# spacegame-wasm — browser frontend (Rust → WASM + wgpu)

The CE Spacegame browser client, written in **Rust**, compiled to **WebAssembly**, rendering with
**wgpu**, and embedding the pure **`spacegame` SDK** so the client and the authoritative host share the
exact same world types and maths.

It talks to the game ONLY over the CE mesh through the page's own origin — the `/ce` reverse proxy in
front of a CE node (the proxy authorizes writes with the node's `api.token`), or a browser-injected
node. The page CSP (`connect-src 'self'`) enforces that no remote origin is ever contacted.

## How it uses the SDK

`Cargo.toml` depends on the backend crate with the mesh I/O compiled out — only the pure, wasm-clean
modules:

```toml
spacegame = { path = "../../spacegame", default-features = false }
```

- **`spacegame::wire`** — `ClientMsg` (input/build/weapon/command/join) and `Snapshot` (ships, bullets,
  beams, explosions, debris, factions), encoded/decoded as the node's `payload_hex` JSON.
- **`spacegame::shard`** — sector tokens + `SectorId` maths for interest management.
- **`spacegame::client`** — `Platform` profiles (the mobile/desktop budgets), viewport + interest set,
  reconnect backoff.
- **`spacegame::sim`** — the deterministic asteroid field (`rock_in_cell`) the renderer draws, and (next)
  the local-prediction `Sim` for zero-delay input.
- **`spacegame::shapedef`** — GPU shape meshes (next: draw built/generated ships from one flattened mesh).

## Modules

| File | Role |
|---|---|
| `src/lib.rs` | wasm entry: boots wgpu, connects to the mesh, runs the `requestAnimationFrame` loop (ingest snapshots → camera → interest subscribe → publish input → render). |
| `src/net.rs` | mesh transport over `fetch`: `/status`, `/mesh/subscribe`, `/mesh/publish`, and the `/mesh/messages/stream` SSE reader that decodes `Snapshot`s. |
| `src/game.rs` | world state from snapshots, local-player tracking, camera, interest set, input-message builder, render-data extraction (friend/foe tagging). |
| `src/input.rs` | keyboard + mouse → a shared `InputState` (touch sticks are the next step). |
| `src/render.rs` | wgpu immediate-mode 2D renderer: one colored pipeline + camera uniform; builds a triangle list each frame for ships, bullets, beams, explosions, debris and the asteroid field. |

## Build

Needs the `wasm32-unknown-unknown` target and [`trunk`](https://trunkrs.dev) (or `wasm-pack`):

```bash
rustup target add wasm32-unknown-unknown
# with trunk (serves index.html + builds the wasm):
trunk serve --release
# or with wasm-pack (emits ./pkg/ that index.html imports):
wasm-pack build --target web --release
```

Then serve `index.html` from the same origin as a node's `/ce` proxy (e.g. behind `ce-serve`). The
heavy dependency here is `wgpu` (uses the WebGL backend for broad browser support); first build is large.

## Status

This is the **foundation**: mesh transport, the rAF loop, input, the SDK-driven world model, and a
working wgpu 2D renderer for the live snapshot. Next steps:

- **Local prediction** — run a `spacegame::sim::Sim` for the local sector and reconcile against snapshots
  for zero-delay input (the SDK is already deterministic and embedded).
- **Shape-mesh rendering** — draw built and procedurally-generated ships from their flattened
  `spacegame::shapedef` GPU mesh (vertices + materials) instead of the placeholder triangle.
- **HUD + build/loadout/faction UI**, touch controls, and the join overlay.
- **Hot reload** — on a `ruleset` version rise, refetch the ruleset (shaders/assets) and hot-apply.
