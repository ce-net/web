# drift-client

The **wgpu (WebGPU-first, WebGL2-fallback) wasm frontend** for the `drift`
program. It renders the authoritative 2D ship-arena and runs **client-side
prediction + reconciliation** by stepping the same deterministic
[`drift-sim`](../sim) `World` the authoritative host runs.

This crate owns **only** `web/projects/drift/client`. The drift **runtime**
(`web/projects/drift/`) owns the control plane (netgame election, the ephemeral
`/rt` StateFrame transport, AoI, snapshot→`/db` failover, region sharding) and
drives the exported `Drift` handle.

## What it does

- **Rendering** — two wgpu pipelines sharing one camera uniform:
  - an **instanced-quad** pipeline (ship blocks, asteroids, projectiles,
    pickups), and
  - a **line** pipeline (arena grid + aim reticle), in the CE aesthetic
    (deep-navy field `#070d18`, cyan/gold accents). HUD text is drawn by the
    DOM overlay (cheaper/crisper than a wgpu glyph atlas).
- **WebGPU-first, WebGL2 fallback** — `wgpu` is built with the `webgl` feature
  and requested over `BROWSER_WEBGPU | GL`; it picks WebGPU when `navigator.gpu`
  exists and falls back to a WebGL2 adapter otherwise. The chosen backend is
  surfaced on the HUD (`Renderer::backend_label`).
- **Prediction** (`predict.rs`) — owns a local `drift_sim::World`, advances it
  with `World::step` every tick for zero-latency local control, buffers
  unacknowledged inputs, and **reconciles** on every authoritative full
  `Snapshot` (restore → replay unacked inputs).
- **Interpolation** (`interp.rs`) — renders remote entities ~100ms in the past
  by interpolating decoded authoritative samples (full `Snapshot` or quantized
  `Delta`), with velocity dead-reckoning past the newest sample.
- **Net decode** — consumes `drift_sim::net` `Snapshot` / `Delta` directly
  (linked as an rlib). Frames are tagged: `0x00` = full snapshot, `0x01` =
  delta; malformed frames decode to `None` and never panic the loop.

## Modules

| Module | Concern | GPU? | Tested |
|---|---|---|---|
| `predict` | local prediction + reconciliation over `drift_sim::World` | no | yes |
| `interp`  | ~100ms remote-entity interpolation | no | yes |
| `camera`  | smoothed follow camera; world→clip matrix | no | yes |
| `input`   | key/pointer → `drift_sim::Input` | no | yes |
| `scene`   | sim state → instanced-quad + line vertices (CE palette) | no | yes |
| `render`  | wgpu device/surface/pipelines | yes | — |
| `app`     | per-frame glue | no | yes |
| `wasm`    | `wasm-bindgen` surface (`Drift`) drift.js drives | wasm-only | — |

## wasm-bindgen surface (`Drift`)

```js
import init, { Drift } from "./pkg/drift_client.js";
await init();
const d = new Drift(seed, arenaHalf, controller);
const backend = await d.attach_canvas(canvas);   // "WebGPU" | "WebGL2"
// per authoritative /rt StateFrame (Message::Binary, or base64 st2 decoded):
d.on_auth_frame(bytes);
// input:
d.set_key("KeyW", true);  d.zoom_by(0.9);
// 60Hz fixed step (drift.js drives the accumulator at drift_sim DT):
d.tick();
const inFrame = d.take_outgoing_input(); // -> send to host as {t:"in"}
// each animation frame:
d.frame(dtSeconds);
JSON.parse(d.hud_json()); // {backend, predictedTick, authTick, leadTicks, corrections, remotes, quads}
```

## Build (operator / ce-app step — NOT run in the dev sandbox)

A release/trunk/wasm build is **disk- and time-heavy** and is intentionally not
run here. Use one of:

**Trunk** (emits `dist/` with the loader injected into `index.html`):

```bash
cd web/projects/drift/client
trunk build --release
# -> ./dist/  (drift-client_bg.wasm + JS glue + index.html)
```

**wasm-pack** (emits an ES module `drift.js` imports directly — preferred for
embedding into the drift runtime):

```bash
cd web/projects/drift/client
wasm-pack build --release --target web --out-dir pkg
# -> ./pkg/drift_client.js + drift_client_bg.wasm
```

## Verify (cheap — safe in the sandbox)

```bash
cd web/projects/drift/client
cargo check --target wasm32-unknown-unknown   # full frontend incl. wgpu/wasm
cargo test                                    # GPU-free logic (predict/interp/camera/input/scene/app)
```
