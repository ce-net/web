# ce-cast — streaming platforms (keys, URLs, encoding)

All platform credentials live in the **ce-secrets vault `vault-c0be11e0ce`** (encrypted, multi-device)
and are pulled onto the relay at deploy time — never committed, never pasted on a device.

## Where the secrets live (vault names)

| Vault secret | What it is |
|---|---|
| `ce-cast-publish` | the WHIP publish key — equals the relay MediaMTX password; the app delivers it to enrolled browsers (`secrets.js` → `localStorage.ce_cast_key`) |
| `youtube-key` | YouTube stream key (24 chars) |
| `kick-key` | Kick stream key (`sk_us-west-2_…`) |
| `kick-url` | Kick ingest URL (`rtmps://fa723fc1b171.global-contribute.live-video.net/`) |

Read them (value never printed) with e.g. `ce-secrets use youtube-key -- yt-dlp …`, or list with
`ce-secrets ls`. To change one: `ce-secrets put <name>` (no-echo).

## Platform ingest URLs

| Platform | URL | Key |
|---|---|---|
| YouTube | `rtmp://a.rtmp.youtube.com/live2` | `youtube-key` |
| Kick | `kick-url` (above) | `kick-key` |
| Twitch | `rtmp://live.twitch.tv/app` | (not set) |
| X | (not set) | (not set) |

> **Kick URL caveat:** Kick is Amazon IVS underneath; the contribute endpoint is normally
> `rtmps://<host>:443/app/<key>`. The stored `kick-url` is exactly what the Kick dashboard showed
> (`…live-video.net/`). The relay fan-out builds `<url>/<key>`. **If Kick won't connect, the URL most
> likely needs `/app/` (→ `rtmps://fa723fc1b171.global-contribute.live-video.net/app/`)** — fix with
> `ce-secrets put kick-url` then re-inject (below).

## How the relay gets them

The relay's `keys.env` (chmod 600, gitignored, never on a device) is populated from the vault:

```bash
cd ~/ce-net/ce-secrets
ce-secrets use youtube-key kick-url kick-key -- bash -c '
  { echo "YT_URL=rtmp://a.rtmp.youtube.com/live2"; echo "YT_KEY=$YOUTUBE_KEY";
    echo "KICK_URL=$KICK_URL"; echo "KICK_KEY=$KICK_KEY"; } \
  | ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@178.105.145.170 \
    "cat > /opt/ce-cast/relay/keys.env && chmod 600 /opt/ce-cast/relay/keys.env"'
```

`fanout.sh` (MediaMTX `runOnReady` on the `program` path) reads `keys.env` each time the stream goes
live and tees the one composited `program` to every platform with a URL+key set — `-c:v copy` (no
re-encode). A 90-day grant `ce-cast-relay → read youtube/kick` already exists for the relay to pull
these itself via `ce-secrets login` (the fully-dogfooded path).

## Recommended encoding (Kick)

Kick's recommended broadcast settings:

| Setting | Value |
|---|---|
| Resolution | 1920×1080 |
| Framerate | 60 |
| Rate control | CBR |
| Bitrate | 8000 Kbps |
| Keyframe interval | 2 s |

**App status vs. this:** the v2 app's browser-composite path currently offers **720p30 / 1080p30**
(`scene.output`); 60 fps and explicit CBR/bitrate are not yet selectable in the UI. 1080p30 at the
app's bitrate is the closest today; adding a 1080p60 + bitrate control to the Output panel is the
follow-up to hit Kick's spec exactly. YouTube ingests the same `program` stream.

## Security note

`keys.env` is chmod 600 + gitignored; the vault holds the canonical copies. If a stream key was ever
shown in plaintext (e.g. pasted into a chat), rotate it at the platform and `ce-secrets put` the new
value — the vault is the durable store, so it won't be lost again (the namespace bug that lost it
before is fixed: see `ce-secrets/docs/identity-and-pairing.md`).
