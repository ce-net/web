# Deploy the restreamer to the ce-net relay

The relay is the Hetzner box that already runs `ce-relay` (178.105.145.170). We add a
second, independent service — `rheo-restream` — that ingests the Mac's single stream and
fans it out. It does **not** touch `ce-relay`.

> Sensitive: this runs a new service and (optionally) opens a port on shared ce-net infra.
> Leif approves before deploying.

## 1. Copy files up

```
scp -i ~/.ssh/id_ed25519 -r broadcast/relay root@178.105.145.170:/opt/rheo-restream
ssh -i ~/.ssh/id_ed25519 root@178.105.145.170 \
  'apt-get install -y ffmpeg && cp /opt/rheo-restream/keys.env.example /opt/rheo-restream/keys.env'
```

Then fill `/opt/rheo-restream/keys.env` with the platform stream keys (Twitch/YT/X/Kick).

## 2. Secure the ingest — two options

**A. ce-expose (preferred, capability-gated, no public port).**
On the relay, expose the local ingest port over the mesh:
```
ce-expose tcp 1935 --name rheo-ingest
```
On the Mac, bridge it to a local port and push there:
```
ce-expose connect rheo-ingest 1935
RELAY_URL=rtmp://127.0.0.1:1935/live RELAY_KEY=rheo ./stream.sh
```
Nothing is exposed to the public internet; only capability holders can publish.

**B. Direct port (quick, less secure).** Open :1935 in UFW *restricted to the Mac's IP*
and use a hard-to-guess `INGEST_KEY`. Push `RELAY_URL=rtmp://178.105.145.170:1935/live`.

## 3. systemd unit (relisten after every session)

`/etc/systemd/system/rheo-restream.service`:
```
[Unit]
Description=Rheo ce-net restreamer
After=network-online.target

[Service]
WorkingDirectory=/opt/rheo-restream
ExecStart=/opt/rheo-restream/restream.sh
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```
```
systemctl daemon-reload && systemctl enable --now rheo-restream
journalctl -u rheo-restream -f
```

## 4. Serve HLS to viewers

The restreamer writes HLS to `/var/www/hls`. Serve it over ce-net:

- **ce-expose origin (start here):** `ce-expose http <hls-http-port> --name rheo-live`
  -> `https://rheo-live.ce-net.com`. Point `watch.html?src=` at it (or host watch.html there).
- **ce-cdn edge fan-out (scale later):** publish each new `seg_*.ts` via `put_object` (CID),
  rewrite the playlist to CID URLs, serve through the ce-cdn gateway. Edges replicate;
  the relay stops being the bottleneck.

## Verify

```
# on the relay, after the Mac starts pushing:
ls -la /var/www/hls           # seg_*.ts + index.m3u8 should be growing
ffprobe rtmp://127.0.0.1:1935/live/rheo   # (only while a publisher is connected)
```
