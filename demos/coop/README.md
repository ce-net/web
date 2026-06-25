# coop — a CE supercomputer showcase (server-authoritative + leaderless CRDT)

A fully **server-authoritative** top-down arena that doubles as a flagship demo of CE as a global
supercomputer. The per-room game logic does NOT run in your browser — it runs in the **`game-coop`
Rust backend** (`/Users/07lead01/ce-net/game-coop`, crate `game-coop`) that hosts the room on the CE
mesh. Clients send only input; the authoritative backend simulates movement, projectiles, the rift's
hostile **drones**, collisions, score and respawns; every client renders the snapshots it receives.

On top of the per-room arena, every room across the whole mesh contributes to **one shared mission** —
waves cleared and energy shards banked — that is a **leaderless multi-writer CRDT** (`ce-coord`
`Merged`) converging with **no central server**. The HUD's "Global mission · CRDT" panel renders that
converged objective; the backend also snapshots the world to CE's content-addressed blob store and
replicates it to nearby hosts for failover.

Open the page, watch the banner: `logic on node <short> (server, <rtt>ms) · wave N`.

- Single self-contained `index.html` — vanilla JS, no build, no npm.
- Talks to the local CE node **over the same origin only**: `window.__ceNode` if a
  browser node is injected, else the same-origin `/ce` proxy. It never contacts
  `ce-net.com`, `/db`, `/rt`, `/nodes`, `/stats`, or any remote origin.

## The model

- **Transport:** the local CE node's mesh app-messaging surface.
  - Clients publish inputs on `ce-game/coop/<room>/in` via `POST /mesh/publish`.
  - The backend publishes snapshots on `ce-game/coop/<room>/state`; the client
    `POST /mesh/subscribe`s to it and reads `GET /mesh/messages/stream` (SSE).
- **Authority:** the `game-coop` backend is the only thing that produces world
  state. A client cannot move another ship, fake a position, or award itself a
  kill — it only expresses input intent (`{a, th, fire, name, color}`).
- **Identity:** every mesh message is signed by the sender's CE NodeId, so players
  are authenticated for free; there is no auth server.
- **Discovery / scale:** rooms are keyed by `<room>`. The backend
  `advertise_service("game-coop/<room>")`s so clients/backends can find the host.
  Many rooms and many backend instances run independently across the mesh.

## Wire protocol

Client → backend, on `ce-game/coop/<room>/in`:

```json
{ "t": "in", "id": "<player id>", "seq": 42,
  "input": { "a": 1.57, "th": true, "fire": false, "name": "Nova", "color": "#37c6ff" } }
{ "t": "bye", "id": "<player id>" }
```

Backend → clients, on `ce-game/coop/<room>/state` (full snapshot each tick; `mission` is the
converged cross-room CRDT objective the client renders in the global-mission panel):

```json
{ "t": "st", "host": "<nodeId>", "seq": 7, "tick": 140, "full": true, "ts": 1718900000000,
  "state": { "t": 140, "wave": 3, "wavesCleared": 2, "shardsBanked": 41,
             "ships": { "...": { "x":0,"y":0,"vx":0,"vy":0,"a":0,"hp":100,
             "name":"Nova","color":"#37c6ff","score":3,"alive":true,
             "deadUntil":0,"lastShot":0,"seen":0 } },
             "bullets": [ ... ],
             "drones": [ { "x":1100,"y":1100,"vx":-40,"vy":12,"hp":18,"lastHit":0 } ] },
  "mission": { "total_waves": 9, "shard_pool": 188,
               "rooms": { "g1": { "pilots": 4, "at_ms": 1718900000000 } } } }
```

## Running the backend

```bash
# Requires a local CE node (`ce start`). Then host the room:
cd /Users/07lead01/ce-net
cargo run -p game-coop -- --room g1
```

Serve `index.html` from the same origin as your node bridge and open it; the
client subscribes to `g1` and renders whatever the `game-coop` host broadcasts.

## What lives where

| Piece | Location |
|---|---|
| Authoritative simulation (ships, bullets, rift waves + drones, scoring, respawn) | `game-coop/src/sim.rs` |
| Shared cross-room mission CRDT (state machine + live `Merged`) | `game-coop/src/objective.rs`, `game-coop/src/mission.rs` |
| Rendezvous sharding + latency-aware host ranking | `game-coop/src/placement.rs` |
| Content-addressed snapshots + redundancy replication | `game-coop/src/replication.rs` |
| Mesh wire protocol (`{t:"in"}` / `{t:"st"}` incl. `mission`, topics) | `game-coop/src/wire.rs` |
| Room host loop (subscribe, tick, publish, mission, replicate, advertise) | `game-coop/src/room.rs` |
| This client (input + render ships/drones/mission over the same-origin node) | `web/demos/coop/index.html` |

The full showcase (CRDT convergence across hosts, snapshot replication, sharding) is visible on a
**live multi-node mesh**; see `game-coop/README.md` for the capability→code map and what each needs.
