# ORDER — distributed encoding & selectable encoder (Leif Rydenfalk, 2026-06-25)

> **Directive, verbatim:**
> "We need to distribute the computation and be able to select which device the encoding runs on.
> My Mac is very slow but I still want to be able to send from it. And the feed is not showing up on
> my Debian even though the buttons are live responding."

This is a binding architectural directive for ce-cast. Record it; build to it.

## What it means

Today's v2 app is **self-contained**: each device captures **and** composites **and** H.264-encodes
**and** publishes its own `program`. On a slow Mac (i3 Air) the local composite+encode is the
bottleneck — turning on screen capture makes it lag. And because every device only renders its *own*
local sources, a feed captured on one device never reaches another: the **control plane** (scene
graph over the mesh) syncs — "buttons respond" — but the **media plane** does not distribute feeds,
so Debian shows nothing from the Mac.

The order splits the pipeline into three roles that can live on **different devices**:

```
SOURCES (light — any device, incl. the slow Mac)        ENCODER (heavy — a SELECTED node)
  capture camera / screen / mic, HW-encode once,   ──►   pull the active source feeds, COMPOSITE,
  publish each feed to the mesh. No compositing.         encode the program, fan out to platforms.
                                                         Selectable: relay (now) · Debian GPU/NVENC
                                                         · a beefy browser · later a WASM node.
PREVIEW (every device): see the encoder's program (or a cheap proxy) so control feels live.
```

The Mac becomes a **source-only** device: it ships its camera/screen/mic feeds (cheap HW encode, no
composite) and the **selected encoder** (Debian GPU or the relay) does the heavy lifting. Encoding
location is **configuration**, not code — `scene.encoder` already carries it.

## Why the current build can't do this yet

1. **No per-device source publishing.** The v2 UI only publishes a *composited* `program`; it has no
   "send my raw camera/screen/mic as feeds others can pull." (The old `send.html` did this for one
   Mac to fixed paths `cam`/`screen`; it was retired. We need it back, generalized to **per-device
   paths** so many sources coexist: `cam-<deviceId>`, `screen-<deviceId>`, `mic-<deviceId>`.)
2. **No cross-device feed transport for the encoder.** A selected encoder must pull every active
   source feed. For a browser encoder that's WHEP off the relay; for a **node** encoder (relay/Debian)
   that's the **ce-adapter** `webrtc-ingest` → `/ce/tunnel/1` path (control plane built + tested; the
   WHIP-receiver data plane is the missing piece — see `ce-adapter` task #2).
3. **No real "preview from the encoder."** Devices need to see the encoder's output, not just their
   own canvas.

## Build plan (the order, decomposed)

**P1 — Per-device sources (unblocks "send from the Mac").**
- In `app.html`, a device with `cast:publish` can publish its camera+mic and/or screen as
  `cam-<deviceId>` / `screen-<deviceId>` (WHIP to the relay), **without** compositing. This is the
  light path the slow Mac needs.
- Presence already lists devices + roles; extend it to advertise each device's **live feeds** so the
  encoder and the UI know what's available.

**P2 — Selectable encoder picks up the feeds.**
- `scene.encoder` selects the encoder: `this-device` (browser composites — today's path, for a fast
  device) **or** a node id (`relay` / the Debian GPU node).
- **Node encoder:** the relay `cast-agent.py` (headless, already mesh-scene-driven and idle-by-default)
  composites the published source feeds and fans out. Today it re-decodes feeds over RTSP (CPU-bound);
  the clean path is **ce-adapter `webrtc-ingest`** delivering each source over a mesh tunnel so the
  encoder gets contiguous H.264 with no re-decode. Build the WHIP-receiver data plane (`ce-adapter`
  task #2), then point `cast-agent` inputs at the tunnel feeds instead of RTSP.
- **Debian GPU/NVENC:** the same `cast-agent`, run on the Debian node, with NVENC — the real answer
  for 1080p60. `scene.encoder = <debian-node-id>` routes the work there.

**P3 — Preview from the encoder.**
- Every device pulls the encoder's program for preview (WHEP for a browser; the relay already writes
  an HLS proxy). Controls stay instant locally; the authoritative composite comes from the encoder.

**P4 — Source-only mode for weak devices.**
- A device flagged "source only" (or auto-detected slow) never composites/encodes — it only ships
  feeds. The Mac runs here by default.

## Mapping to what already exists

- **Control plane** (scene + presence + encoder selection): done, on the mesh (directed `/mesh/send`
  to the relay node; `/ce` proxy per app subdomain).
- **Headless encoder**: `cast-agent.py` — mesh-driven, idle-by-default, runs only when
  `scene.encoder` names its node. Ready for P2; needs clean tunnel feeds.
- **ce-adapter** (`~/ce-net/ce-adapter`): the dynamically-spawned WebRTC↔mesh bridge — control plane
  + tests done; **`webrtc-ingest` WHIP-receiver data plane is the keystone remaining work** for the
  node-encoder path (no-re-decode source delivery).

## Immediate (this pass)
- Per-device source publishing (P1) and the encoder selector wired in the UI is the next build.
- The lag is inherent to local composite+encode on the Mac; until P1/P2 land, the mitigation is lower
  resolution (720p30) on the Mac, or use a faster device as `this-device` encoder.
