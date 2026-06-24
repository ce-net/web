# drift — runtime, sharding, and deploy

The **drift runtime** is the JavaScript glue that turns the deterministic `drift-sim`
(a wasm host) and the `drift-client` (a wgpu wasm renderer) into a live, region-sharded,
failover-safe multiplayer world built on **CE hub primitives only** — realtime rooms
(`/rt`), the snapshot store (`/db`), and node scoring (`/nodes`).

This directory owns the JS + config + page (everything **except** `sim/` and `client/`,
which are separate crates with their own owners).

```
drift/
  drift.js        runtime: netgame control plane + binary StateFrames + AoI + sharding + failover
  host-wasm.js    loads the drift-sim cdylib over wasm linear memory (the "wasm host" interface)
  host.mjs        headless pinned host runner (server-class; pins authoritative hosting)
  index.html      browser entry: wires the wgpu client (./pkg) to drift.js (renderer optional)
  stage.mjs       assembles a clean ./out for deploy (browser bundle only)
  ce.json         runtime + sharding + deploy descriptor
  ce-app.json     ce-app project descriptor (project = "drift", static)
  .ce/app-id      pins the deployed app id to "drift"
  sim/            (other owner) deterministic simulation crate
  client/         (other owner) wgpu wasm renderer crate
```

## Architecture

- **Control plane = netgame** (`web/ce-app/client/netgame.js`). Per region, a
  coordinator-free deterministic host election runs over the region control room
  (`rt/drift/r:<gx>:<gy>`, text frames: candidacy, host-change, liveness).
- **Authoritative state = binary StateFrames** over a **separate ephemeral** room
  (`rt/drift/r:<gx>:<gy>::st?ephemeral=1`) sent as `Message::Binary`, with a base64
  `{t:"st2"}` text fallback when binary is unavailable. The elected host advances the
  `drift-sim` world and streams it; netgame's JSON state channel is left trivial so the
  world is never double-simulated.
- **Area of interest.** Each client advertises its view center + radius over the control
  room (`{k:"aoi",...}`); the host builds a per-viewer `snapshot_aoi()` frame and unicasts
  it (the StateFrame header carries the target pid over the shared broadcast room).
- **Snapshot / failover.** The host writes a full binary snapshot to
  `/db/drift/snap:r:<gx>:<gy>` every `snapshotEvery` ticks, CAS-guarded with an
  `If-Match: <term>` header so two hosts racing after a partition cannot clobber each
  other. On host death netgame re-elects; the new host `restore()`s from that snapshot.
- **Region sharding.** The world is a grid of `r:<gx>:<gy>` regions. `/db/drift/world:dir`
  maps each region to its owning host. A client crossing a region boundary switches its
  control + state rooms. Entities crossing a shard boundary are handed off host->host via
  idempotent `{k:"xfer"}` / `{k:"xack"}` through a `/db` mailbox (`handoff:r:<gx>:<gy>`).
- **Hybrid hosting.** A benchmark-selected stable node (`host.mjs`, server-class election
  score) is *preferred*; if absent, browsers elect one of themselves. Pinned-preferred,
  browser-fallback, entirely via the netgame election.

## The wasm-host interface

`drift.js` drives the elected host through a plain object (see `host-wasm.js`):
`newWorld`, `spawnShip`, `applyInput(bytes)`, `step()`, `snapshotFull()`,
`snapshotAoi(x,y,r)`, `restore(bytes)`, `free()`. `host-wasm.js` adapts the
`drift-sim` C-ABI (`sim_new`, `apply_input`, `step`, `snapshot_full`, `snapshot_aoi`,
`restore`, ...) to it over linear memory. The browser renderer is the wasm-bindgen
`Drift` handle from `client/` (`./pkg`).

## Running the headless host (pinned authoritative node)

```bash
# Node 22+ (global WebSocket + fetch). Build the sim wasm once (sim/ owner):
(cd sim && cargo build --release --target wasm32-unknown-unknown)

node host.mjs \
  --hub https://ce-net.com \
  --regions 0:0,1:0,0:1 \
  --wasm sim/target/wasm32-unknown-unknown/release/drift_sim.wasm
```

It joins each region server-class, wins the election, and pins authoritative hosting.
Kill it and the browsers re-elect + restore from `/db` — it is redundancy, not a SPOF.

## Deploying to drift.ce-net.com with ce-app

The app id is pinned to `drift` (`.ce/app-id`), so it serves at both
`https://drift.ce-net.com/` and `https://ce-net.com/apps/drift/`.

```bash
# 1) (optional) build the wgpu renderer — done by the client/ owner, not here:
(cd client && trunk build --release --public-url ./)   # emits client/dist
#    then copy the wasm-bindgen output into ./pkg (drift_client.js + .wasm).
#    index.html probes ./pkg and degrades to transport-only if it is absent.

# 2) stage a clean browser bundle into ./out (index.html + drift.js + netgame.js + ./pkg):
node stage.mjs

# 3) deploy the staged bundle:
cd out && ce-app deploy --app drift
```

`ce-app deploy` resolves your ONE identity (`ce id` / `~/.ce/identity`), signs every
PUT (`x-ce-id` / `x-ce-sig` / `x-ce-ts` / `x-ce-nonce` over
`METHOD\nPATH\nts\nnonce\nsha256(body)`), uploads the static bundle to `/apps/drift`, and
enables SPA routing. The wave-2 hub records `drift` as owned by your identity on first
signed write, so only you can update it thereafter.

`stage.mjs` vendors `netgame.js` next to `drift.js` and rewrites the
`../../ce-app/client/netgame.js` import to `./netgame.js` so the bundle is self-contained
when served from `/apps/drift/`.

To run the headless pinned host on the CE mesh after deploy, run `host.mjs` on a stable
node (e.g. the relay or desktop) pointed at `--hub https://ce-net.com`.
