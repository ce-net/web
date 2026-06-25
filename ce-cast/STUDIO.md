# ce-cast — distributed studio

An OBS-like live studio built on ce-net. Sources publish from any device, a **selectable node**
composites + encodes, and **any authorized device** controls the composition in real time. Output
fans out to YouTube / Kick / X.

```
SOURCES (publish feeds, WHIP -> MediaMTX on the relay)
  Mac (web/send.html):  camera+mic -> path "cam",  screen -> path "screen"
  (later) Debian:       screen+cam+mic     (later) phone: front/back cam + mic

CONTROL PLANE  (the shared SCENE GRAPH — OBS-like, edited from any authorized device)
  web/control.html  ->  PUT /db/castctl-<prefix>/scene  on the CE hub
  layout (fullface / pip / side / screen / camonly) · PiP corner+size · show-hide ·
  output res · destinations · (encoder node)

ENCODER / COMPUTE  (configurable node; relay now, Debian NVENC later)
  relay/cast-agent.py owns ONE ffmpeg COMPOSITOR + a stable SENDER (see "Zero-cut")
  composite cam+screen at 1080p -> MPEG-TS over local UDP -> sender -> platforms + HLS preview

OUTPUT -> YouTube (RTMP) · Kick (SRT) · X ...   platform keys from the vault / relay keys.env
```

## The pieces

| Piece | File | Runs on |
|---|---|---|
| Mac sender | `web/send.html` | the Mac (browser) |
| Control panel | `web/control.html` | phone / Mac / any authorized device |
| Relay agent | `relay/cast-agent.py` | the relay (systemd `ce-cast-agent`) |
| Media server | `relay/mediamtx.prod.yml` | the relay (systemd `ce-cast-mediamtx`) |
| Signaling + HLS | `relay/nginx-cast.conf` | the relay (nginx vhost `cast`) |
| Vault client | `web/secrets.js` + `crypto.mjs` + `vault.mjs` | browsers (publish key, no paste) |
| Remote logger | `web/log.js` | every page (ships to `/db/celog-<prefix>`) |

The UI is a **CE app** (`web/`, static): `npm run deploy` -> `https://cast-<prefix>.ce-net.com`.
The relay is a separate plane: `relay/deploy.sh`.

## One fixed graph; every layout is a live zmq update

The compositor is **one never-restarting ffmpeg graph** — two overlays on a black 1080p canvas:

```
[black base]              <- canvas
[screen] scale@sScr -> overlay@oScr
[camera] scale@sCam -> overlay@oCam , zmq
```

Because `scale` w/h **and** `overlay` x/y are all live-commandable, **every** control —
fullscreen-face, PiP, side-by-side, screen-only, cam-only, PiP corner, PiP size, show/hide — is a
`scale`/`overlay` value change sent over zmq (`tcp://127.0.0.1:5555`). **No restart, no glitch.**
The agent only restarts the compositor on a *structural* change: output res/fps/bitrate, mirror,
or a source feed appearing/disappearing.

## Zero-cut operations

The stream must not drop when the operator reloads or redeploys infrastructure. Two mechanisms:

1. **Decoupled sender.** The compositor writes MPEG-TS to a local UDP socket; a separate **sender**
   process reads that UDP and holds the YouTube/Kick connections (`-c copy`). UDP has no
   "disconnect," so restarting the compositor is a brief freeze on the sender's input — the platform
   RTMP/SRT connections stay **open**.
2. **Adopt.** The agent tracks the compositor and sender via pid+sig files (`relay/run/`). On its own
   restart it **adopts** a running process whose config still matches instead of killing it — so
   redeploying agent code/config is invisible to the stream.

Result: redeploy the agent -> nothing happens. Redeploy the compositor -> platforms stay connected
(brief freeze). nginx reload is graceful. The only thing that drops a platform is toggling it off.

## Auth

- **Publish key** gates WHIP publish + WHEP read on the relay (MediaMTX `authInternalUsers`). The
  Mac/phone get it from the **ce-secrets vault** automatically (`secrets.js`) — no paste. Rotate with
  `ce-secrets rotate ce-cast-publish` + re-deploy the relay key.
- **Platform keys** (`YT_KEY`, `KICK_URL` as SRT, `X_*`) live only in `relay/keys.env` (chmod 600,
  gitignored) and in the vault (`youtube-key`, `kick-key`). Never on the phone.

## Deploy

```bash
# UI (CE app)
cd web && npm run deploy                      # -> https://cast-<prefix>.ce-net.com

# Relay media plane (MediaMTX + signaling nginx + key)
cd relay && PUBLISH_KEY=... ./deploy.sh

# Relay agent (compositor + sender). Ship cast-agent.py + the unit, then:
#   systemctl enable --now ce-cast-agent
```

`cast-agent.py` needs `python3-zmq` on the relay (`apt-get install -y python3-zmq`).

## Operate (go live)

1. **Mac:** open `…/send.html` -> grant camera/mic + **Screen Recording** to the browser (System
   Settings -> Privacy & Security -> Screen Recording, then fully quit & reopen the browser) ->
   **Start sending**.
2. **Phone:** open `…/control.html` -> compose (layout / PiP / sources) with the live HLS preview ->
   toggle **YouTube** / **Kick** on to broadcast.

## Known limits / next

- **Relay is 2 vCPU** — 1080p30 x264 ultrafast is the ceiling. Higher quality = the **encoder =
  Debian GPU (NVENC)** path (same scene graph, selectable node).
- **iPhone browsers can't screen-share** (no `getDisplayMedia` on iOS) — screen comes from the
  Mac/Debian. iPhone screen would need a native ReplayKit broadcast helper.
- **Sources, next:** a Debian Linux sender; the phone as a front/back camera source.
- The old `web/studio.html` (phone composites locally) + the `program` path/`fanout.sh` are
  **superseded** by this model and should not run simultaneously.
