# ce-cast — secure setup & deploy

Two independent planes. Deploy each once; they talk over HTTPS + WebRTC.

```
UI plane  (a CE app)            Media plane (the relay)
──────────────────             ──────────────────────────
ce-app deploy                  relay/deploy.sh
   │                              │
   ▼                              ▼
https://ce-net.com/apps/        cast.ce-net.com  (MediaMTX + fanout.sh)
  cast-<id>/  (send + studio)   178.105.145.170:8189/udp  (WebRTC media)
```

- **UI plane** — `send.html` (Mac) + `studio.html` (phone), hosted by the CE app platform.
  One `ce-app deploy`; hot-reloads on every edit; no Hetzner, no scp.
- **Media plane** — MediaMTX takes the WHIP/WHEP signaling and WebRTC media; `fanout.sh`
  copies the phone's `program` to every platform. Platform keys live here only.

The two are decoupled: the app reaches the relay through a **configurable** endpoint
(`web/config.js`, default `https://cast.ce-net.com`), never `location.origin`.

---

## 1. Deploy the media relay

```bash
ssh-add ~/.ssh/id_ed25519                      # key is passphrase-protected
PUBLISH_KEY="$(openssl rand -hex 24)"           # your single publish secret — save it
echo "PUBLISH_KEY=$PUBLISH_KEY"
cd ce-cast/relay
PUBLISH_KEY="$PUBLISH_KEY" ./deploy.sh
```

`deploy.sh` ships the config, injects `PUBLISH_KEY` into MediaMTX **on the box only**,
installs MediaMTX + ffmpeg, enables the systemd unit + signaling nginx vhost, and opens
`8189/udp`. Idempotent — re-run any time. Every step is key-pinned, connect-timed, and
keepalive-bounded, with retries; if the box is unhealthy it fails fast with a fix-it message
instead of hanging.

> Relay won't connect? It's almost always the box, not your key. Check it:
> `ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@178.105.145.170 'uptime; df -h /; free -m'`
> A small 4 GB relay does this when out of RAM/disk; if it hangs, reboot from the Hetzner
> console and re-run. (`-o IdentitiesOnly=yes` stops a loaded ssh-agent from spamming auth
> attempts, which can make sshd close the connection.)

## 2. Deploy the UI app

```bash
cd ce-cast/web
npm run deploy               # → prints https://cast-<id>.ce-net.com
```

`ce-app` is the local package at `~/ce-net/web/ce-app` (not on npm — `npx ce-app` would 404).
The npm scripts call it directly. For live UI iteration with hot reload: `npm run dev`.
To get a global `ce-app` command instead: `npm i -g ~/ce-net/web/ce-app`.

## 3. Set up each device (paste the key once)

- **Mac:** open `https://cast-<id>.ce-net.com/send.html` → paste `PUBLISH_KEY` → **Start sending**
  (grant camera, mic, screen). Ships camera+mic → `cam`, screen → `screen`.
- **Phone:** open `https://cast-<id>.ce-net.com/studio.html` → paste the same key → turn on
  Camera / Screen, compose, **Go Live**.

The key is saved per device in `localStorage` and never re-rendered (can't leak on stream).
Pointing at your own relay instead: open either page with `?relay=https://your-relay` once.

## 4. Add platform keys (on the relay only)

```bash
ssh -i ~/.ssh/id_ed25519 root@178.105.145.170 \
  'nano /opt/ce-cast/relay/keys.env && systemctl restart ce-cast-mediamtx'
```

Fill `YT_KEY`, `KICK_*`, `X_*`, `TWITCH_*`. Any platform left blank is skipped. The fan-out
auto-starts the moment the phone goes live and adds platforms as you add keys — just restart.

---

## Security model

1. **Publish key gates everything.** Mac and phone must present `PUBLISH_KEY` (HTTP Basic over
   HTTPS) to **publish *and* read**. Nobody on the internet can pull your camera, screen, or
   program — remote read is key-gated; only relay-localhost reads freely (for fan-out).
2. **Platform stream keys never leave the relay.** They live in `relay/keys.env` (chmod 600,
   gitignored). Your phone — a mobile device — holds **zero** platform credentials. Lose the
   phone, lose nothing but the publish key (rotate it; see below).
3. **Encrypted transport.** Pages + WHIP/WHEP signaling ride Cloudflare TLS. WebRTC media is
   DTLS-SRTP end to end (Mac↔relay↔phone). Relay→platforms uses each platform's RTMPS where offered.
4. **Minimal exposure.** Public surface is only 443 (Cloudflare→nginx signaling) + `8189/udp`
   (WebRTC media). MediaMTX signaling/RTSP/RTMP/API are all localhost-bound; platform pushes are
   outbound. The relay's `ce-relay` service is untouched.
5. **No secrets in git.** `mediamtx.prod.yml` keeps the `REPLACE_WITH_PUBLISH_KEY` placeholder;
   the real key is `sed`-injected on the box at deploy. `keys.env` is gitignored.

**Rotate the publish key:** re-run `relay/deploy.sh` with a new `PUBLISH_KEY`, then re-paste it
on the Mac and phone. Old key stops working immediately.

**Tighten further (optional):** route Mac→relay ingest through a capability-gated `ce-expose`
tunnel instead of public WebRTC, and bind the WebRTC media port to the mesh. The browser sources
make public-but-encrypted-and-key-gated the pragmatic default.
