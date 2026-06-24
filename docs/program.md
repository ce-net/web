# The CE platform

CE is a global compute mesh with a one-command app platform on top. You ship a folder of
files and it is live at a stable HTTPS URL in seconds, with a persistent database, realtime
rooms, content-addressed blobs, custom domains, and a compute-task router — all served by the
public `ce-hub` service at `https://ce-net.com`. Every endpoint is also reachable under the
`/hub/<path>` prefix.

This page is the authoritative overview of what the platform is **today**. Each topic links to
its own reference doc.

---

## The shape of it

| Layer | What it is | Reference |
| --- | --- | --- |
| **Identity** | One Ed25519 identity, reused everywhere; signs every mutating request. | [identity](identity.md) |
| **Hosting** | `ce-app` turns a folder into a live app with a deterministic URL. | [hosting](hosting.md), [quickstart](quickstart.md) |
| **Database** | Persistent, namespaced KV per app, with compare-and-set. | [database](database.md) |
| **Realtime** | WebSocket rooms; broadcast + history; ephemeral high-rate rooms. | [realtime](realtime.md) |
| **Compute** | `POST /tasks` runs WASM / JS / Python on mesh nodes. | [tasks-and-languages](tasks-and-languages.md) |
| **Game framework** | `netgame`: authoritative host election + `/db` failover. | [netgame](netgame.md) |
| **drift** | The flagship world: wasm + wgpu, region sharding, failover. | [projects](#drift-the-flagship-world) |
| **Slugs + registry** | Human names + the public projects registry + feedback. | [registry](registry.md) |
| **Custom domains** | CNAME a domain to `ce-net.com` and bind it to your app. | [custom-domains](custom-domains.md) |
| **Limits + admin** | Identity-scoped quotas; identity-based admin. | [limits](limits.md), [admin](admin.md) |
| **Debugging** | A debug dashboard + `doctor` / `logs` / `trace`. | [debug](debug.md) |
| **Build on the relay** | Heavy Rust/wasm builds run on the relay, not the laptop. | [build on the relay](#build-on-the-relay) |
| **API** | The full HTTP/WS surface. | [api](api.md) |

---

## One identity, signed writes

CE has exactly one identity rule: **one person, one id, reused everywhere.** `ce-app` resolves a
single Ed25519 keypair — your CE **node key** if a node runs here, else one local app keypair —
and never mints a second id. The public key is your id; the secret key **signs every mutating
request**.

Signing is now **enabled and verified** by the hub. Every `PUT` / `POST` / `DELETE` / `PATCH`
carries:

| Header | Value |
| --- | --- |
| `x-ce-id` | the signer's Ed25519 public key, hex |
| `x-ce-sig` | Ed25519 signature over the canonical string, hex |
| `x-ce-ts` | request timestamp (unix; replay window) |
| `x-ce-nonce` | per-request random nonce, hex (replay defense) |

The canonical string is `METHOD\nPATH\nts\nnonce\nsha256(body)-hex`. A request with **no**
signature stays anonymous (still works, on the conservative anonymous caps); a request **with** a
signature that fails any check is rejected `401`. The owner id is `sha256(pubkey)[..16]`. The same
identity logic lives in `ce-app/bin/ce-app.mjs`, `slug.mjs`, and `registry.mjs`. Full detail:
[identity](identity.md).

---

## The game framework (netgame)

`netgame` is the authoritative distributed multiplayer framework — one small dependency-free ESM
file built entirely on hub primitives (`/rt` rooms, `/db` snapshots, `/nodes` metrics). Every
participant scores itself and broadcasts a candidacy; all participants run the **same deterministic
election** (highest score; ties broken by smallest id; server-class nodes beat browsers), so there
is no coordinator. The elected host runs the authoritative tick loop and streams state; clients
send inputs and render. The host writes a snapshot to `/db` periodically, and if it goes silent
play **migrates** to the next-best node and restores from that snapshot. Full detail:
[netgame](netgame.md).

### drift — the flagship world

`drift` (`web/projects/drift`, live at **drift.ce-net.com**) is the flagship game built on
netgame: a region-sharded, failover-safe multiplayer world with a wgpu wasm renderer
(`client/`) and a deterministic wasm sim host (`sim/`).

- **Control plane = netgame.** A coordinator-free election per region over the control room.
- **Authoritative state = binary StateFrames** over a separate **ephemeral** `/rt` room
  (`?ephemeral=1`, which skips history replay for high-rate state), with a base64 text fallback.
- **Area of interest.** Each client advertises its view center + radius; the host unicasts a
  per-viewer `snapshot_aoi()` frame.
- **Region sharding.** The world is a grid of `r:<gx>:<gy>` regions; `/db/drift/world:dir` maps
  each region to its host. Entities crossing a boundary are handed off host->host via an
  idempotent `/db` mailbox.
- **Snapshot / failover.** The host CAS-writes a full binary snapshot to `/db/drift/snap:...`
  guarded by an `If-Match: <term>` header, so two hosts racing after a partition cannot clobber
  each other; on host death netgame re-elects and the new host restores.
- **Hybrid hosting.** A benchmark-selected stable node (`host.mjs`, server-class score) is
  preferred; if absent, browsers elect one of themselves.

Other live apps: **coop.ce-net.com** (the server-authoritative netgame example),
**spa.ce-net.com/game** (spacegame), and arena / place / cursors / draw / poll / wall, plus
**feedback.ce-net.com**. See `web/projects/drift/README.md`.

---

## Slugs, the projects registry, and feedback

Three signed/public surfaces let a project become a first-class, discoverable thing:

- **Slugs** — a human-readable name (`ce-app slug claim <name>`) that resolves at the hub's
  not-found fallback, so `https://ce-net.com/apps/<slug>/` serves your app with no nginx change.
  Slug writes are **signed and owner-scoped**.
- **The public projects registry** — `ce-app publish` uploads pinned screenshots to the
  content-addressed blob store and `POST /projects` records your project. `GET /registry` is the
  public list; `ce-net.com/projects` and `ce-net.com/play` render it dynamically. A project can be
  reported (`/projects/:id/report`, IP rate-limited) and deleted by its owner (or an admin).
- **Feedback** — `feedback.ce-net.com` is a realtime feedback board (one board per target project)
  with a drop-in shadow-DOM widget, durable in `/db/feedback` and live over a `/rt` room, with a
  per-namespace IP rate limit.

Full detail: [registry](registry.md).

---

## Build on the relay

CE builds (the `ce-hub` binary, Rust->wasm apps like drift, the sim crate) run **on the relay**
(Hetzner, x86_64 Linux) via `deploy/ce-build.sh`, never on the dev laptop. The relay is the same
target we deploy to, so a native build there *is* the deploy artifact (no musl cross-compile), it
keeps multi-gigabyte build trees off the laptop disk, and it dogfoods the mesh as a build host.

```bash
bash deploy/ce-build.sh hub                         # build ce-hub on the relay, install + restart
bash deploy/ce-build.sh wasm projects/drift drift   # build a Rust->wasm app, deploy to /apps/drift/
bash deploy/ce-build.sh cargo projects/drift/sim test --release   # any cargo cmd on the relay
bash deploy/ce-build.sh drift                       # full multi-crate drift build + deploy
bash deploy/ce-build.sh toolchain                   # wasm toolchain install progress
```

Built assets are PUT straight to the hub's `/apps/<id>/` from the relay (no laptop round-trip).
Full detail: `web/deploy/remote-build.md`.

---

## Reach an app three ways

Your app, its database, and its rooms are all available on the same origin via:

| Origin | URL |
| --- | --- |
| Path | `https://ce-net.com/apps/<id>/` |
| Subdomain | `https://<id>.ce-net.com/` (wildcard TLS live) |
| Slug | `https://ce-net.com/apps/<slug>/` (claimed via `ce-app slug claim`) |
| Custom | `https://<custom-domain>/` (CNAME to `ce-net.com`) |

`/db/<app>/<key>` and `wss://ce-net.com/rt/<app>/<room>` work on all of these origins.
