# Rheo live broadcast

Go live to **Twitch + YouTube + X + Kick at once** while developing, on the i3 MacBook
Air, without melting it. One ffmpeg process captures **screen + webcam + mic**, composites
them, **encodes a single time** with hardware VideoToolbox, then the `tee` muxer copies
that one encoded stream to every platform. No per-platform re-encode.

## One-time setup

1. **Grant Screen Recording + Camera + Microphone** to your terminal app
   (System Settings → Privacy & Security). Screen capture silently fails without it.
2. Copy the keys template and fill in stream keys:
   ```
   cd broadcast
   cp keys.env.example keys.env
   ```
3. Get each key (leave any you don't want blank — that platform is skipped):
   - **Twitch** — dashboard.twitch.tv → Settings → Stream → *Primary Stream key*.
   - **YouTube** — studio.youtube.com → Create → Go Live → *Stream key*
     (first-ever live stream needs the channel verified ~24h ahead).
   - **X / Twitter** — media.x.com → Producer → **+ Source** → copy the RTMP **URL** into
     `X_URL` and the **key** into `X_KEY`.
   - **Kick** — kick.com/dashboard → Settings → Stream → copy the `rtmps://…` **Stream URL**
     into `KICK_URL` and the **key** into `KICK_KEY`.

## Go live

```
./stream.sh                # all platforms with a key set
NO_CAM=1 ./stream.sh       # screen + mic only
SYSAUDIO=1 ./stream.sh     # also mix system audio (BlackHole 2ch) with the mic
DRY_RUN=1 ./stream.sh      # print the plan + command, stream nothing
```

Stop with **Ctrl-C** — ends all platforms cleanly.

## The bandwidth catch

Local fan-out sends **one copy per platform**, so upload bandwidth multiplies. At the
default ~2.95 Mbps, four platforms ≈ **12 Mbps upstream**. The script prints the required
figure on launch. If your uplink can't hold it, drop platforms or lower bitrate:

```
VBITRATE=1800k MAXRATE=2200k ./stream.sh
```

(If upload is the bottleneck long-term, a cloud restreamer — push one stream, they fan out —
trades ~$16/mo for needing only ~3 Mbps up. We chose local fan-out to stay free.)

## Tuning

All overridable via env or the commented block in `keys.env`:
`RES` (default 1280x720), `FPS` (30), `VBITRATE`, `MAXRATE`, `ABITRATE`, `CAM_H` (webcam
overlay height). For sharp code text bump to `RES=1920x1080 VBITRATE=4500k` — but mind the
4× upload.

## Device indices

`./devices.sh` lists capture devices. Current machine: screen=`1`, webcam=`0`,
mic=`1`. Override with `SCREEN_DEV` / `CAM_DEV` / `MIC_DEV` if they change.

## Files

- `stream.sh` — the broadcaster.
- `devices.sh` — list avfoundation devices.
- `keys.env.example` — template; copy to `keys.env` (gitignored).
