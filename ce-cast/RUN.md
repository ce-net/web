# ce-cast — go live (browser + ce-net relay)

No app. The phone and laptop are plain web pages that hardware-encode via WebRTC and publish
over **WHIP** to the **ce-net relay**, which composites and fans out to Twitch / YouTube / Kick
and ce-net's own HLS.

```
 PHONE  (web)  camera + mic ─┐ WHIP
 LAPTOP (web)  screen ───────┤────► MediaMTX (relay) ──RTSP──► compose-fanout.sh
                             │                                   ├─ RTMP → Twitch/YouTube/Kick
                             │                                   └─ HLS  → ce-net (watch.html)
```

## Why the relay needs HTTPS
Phones only grant camera/mic on a **secure origin**. So the page + WHIP must be served over
HTTPS. The clean path is the Hetzner relay behind Cloudflare TLS (`relay.ce-net.com`). Plain
`http://<lan-ip>` will NOT get camera access on the phone.

## A. Deploy the relay (Hetzner — one time)
```
scp -r relay web watch.html root@178.105.145.170:/opt/ce-cast/
ssh root@178.105.145.170 'apt-get install -y ffmpeg && \
  curl -L https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_linux_amd64.tar.gz | tar xz -C /usr/local/bin mediamtx'
# fill /opt/ce-cast/relay/keys.env with the platform stream keys
# point mediamtx.yml webrtcAdditionalHosts at relay.ce-net.com, front :8889 with Cloudflare TLS
```
Run (systemd units in `relay/install.md`): `mediamtx relay/mediamtx.yml` + `relay/compose-fanout.sh`.

## B. Go live
1. **Laptop:** open `https://relay.ce-net.com/` (served by the relay) → **Share Screen** → Go Live.
   (Or skip the screen for now and run `CAM_ONLY=1` on the relay.)
2. **Phone:** open the same URL → **Camera + Mic** → Go Live. Flip for front/back.
3. **Relay:** `./compose-fanout.sh` (composites screen+camera+mic, fans out). Fill `relay/keys.env`
   with your Twitch/YouTube/Kick keys first.
4. **Watch:** `watch.html?src=https://relay.ce-net.com:8888/index.m3u8` (or the ce-cdn URL).

## Fastest first light (no platform keys needed)
Run the relay with an empty `keys.env` — it still produces the ce-net HLS leg, so you can open
`watch.html` and confirm the screen+camera+voice composite end-to-end before pasting any keys.

## Laptop screen alternative
Instead of the browser **Share Screen**, the native ffmpeg sender gives cursor + crisper text:
`DEST=rtmp://relay.ce-net.com:1935/screen ./screen-send.sh`
