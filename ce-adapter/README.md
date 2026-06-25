# ce-adapter — dynamically-spawned mesh adapters

`ce-adapter` is the **general, reusable fix** for the case where a browser / edge endpoint can't
speak the CE mesh transport directly:

- browsers **cannot open `/ce/tunnel/1`** libp2p streams (no raw sockets; the SDK has no tunnel API),
- a browser **is not yet a full CE node**.

Rather than bundle a one-off bridge into every app, an app **spawns an adapter on demand** next to
the browser. The adapter terminates the edge protocol (WebRTC WHIP/WHEP, node services) and carries
the payload onto the mesh. It is spawned through `ce-fn` — the normal job system — so placement,
billing, and teardown come for free, and **nothing is bundled**.

It is an **app-tier** crate: it composes existing CE primitives and adds **no node endpoints**.

## What it composes (no reinvention)

| ce-adapter concern | CE primitive |
|---|---|
| spawn the adapter daemon on demand | `ce-fn` (`FnClient` → `mesh-deploy` job; billing + kill) |
| carry media the browser↔node can't | the node's `POST /tunnel` → `/ce/tunnel/1` |
| control (start/stop/status) | authenticated `AppRequest`/reply on `ce-adapter/control` |
| discovery | the control reply carries the public endpoint; `advertise_service` for a handle |
| authorize spawn + edge use | `ce-cap` chains: `adapter:spawn` / `adapter:webrtc-ingest` / … |

## Profiles

| Profile | What it bridges | Status |
|---|---|---|
| `webrtc-ingest` | browser WHIP → mesh tunnel to an encoder node (no re-decode) | **shipped (control plane); WHIP receiver behind the `$CE_ADAPTER_WHIP_CMD` seam)** |
| `webrtc-egress` | mesh tunnel → browser WHEP (preview / watch) | documented extension point |
| `node-bridge` | node services (mesh pub/sub/request, blobs) for a non-node browser | documented extension point |

## Model

```
consumer app (e.g. ce-cast)
  │  deploy_serve(host)        ← ce-fn places a long-lived `ce-adapter serve` cell (dynamic spawn)
  │  start(host, spec, cap)    ← AppRequest on ce-adapter/control  (authorize adapter:spawn)
  ▼
ce-adapter serve  (on the encoder/relay host)
  ├─ open_tunnel → node POST /tunnel → /ce/tunnel/1 → encoder:tunnel_port
  └─ WHIP receiver: browser WHIP (DTLS-SRTP, cap-gated) → depay H264+Opus → MPEG-TS → tunnel
```

Co-locating the adapter on the encoder makes the tunnel a **loopback** (no cross-mesh hop) — the MVP
placement. General callers let `ce-fn` rank a host near the source.

## The streaming fix

The relay used to pull a browser's WebRTC feeds back out of MediaMTX over RTSP and **re-decode +
re-encode** them on a 2-vCPU box → `corrupt macroblock` garbage. `webrtc-ingest` terminates WebRTC
once and ships clean H.264/Opus as MPEG-TS over the mesh tunnel — **no re-decode** — so the encoder
receives a contiguous, uncorrupted stream.

## CLI

```bash
ce-adapter serve  --public-base https://cast.ce-net.com [--roots roots.txt]
ce-adapter ingest --host <encoder-node> --encoder <encoder-node> --port 10000 --cap <token>
ce-adapter stop   --host <node> --instance <id> --cap <token>
ce-adapter status --host <node> --cap <token>
ce-adapter grant  --to <node> --abilities adapter:spawn,adapter:webrtc-ingest [--expires-secs N]
```

`ce-adapter serve` reads the WHIP receiver command from `$CE_ADAPTER_WHIP_CMD` (a command with
`{whip_port}` / `{ts_port}` placeholders that terminates WHIP and writes MPEG-TS to
`tcp://127.0.0.1:{ts_port}`), so the WebRTC implementation is swappable without recompiling.

## Auth

Every control op requires an `adapter:spawn` `ce-cap` chain rooted at the host (or a configured
root). Publishing into a `webrtc-ingest` instance requires `adapter:webrtc-ingest`. The single shared
publish password is gone — each device presents its own attenuated, time-boxed capability.

## Status (honest)

- Control plane (spawn/serve/auth/protocol/profile/CLI) — complete and unit-tested.
- `webrtc-ingest` data plane — tunnel + process management shipped; the WebRTC WHIP **receiver**
  binary plugs in via `$CE_ADAPTER_WHIP_CMD` (tracked as the data-plane task).
- `webrtc-egress` / `node-bridge` — documented extension points, return an explicit
  "not yet implemented" until built.
