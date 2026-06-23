# Serving ce-net.com like any other CE site (ce-storage gateway)

ce-net.com is **not special-cased**. Its pages are content-addressed CE blobs served by
`ce-storage gateway` — the identical app any user runs to host a site on CE. nginx is only the
TLS-terminated edge Cloudflare requires, and it falls back to the static copy if the gateway is
down, so the site has zero downtime.

```
internet → Cloudflare (TLS) → nginx (:80, edge only)
                                 ├─ /            → ce-storage gateway (:9000) → CE blobs   [X-CE-Served: ce-storage-gateway]
                                 │                 └─ on any gateway error → static /var/www  [X-CE-Served: static-fallback]
                                 └─ /bootstrap /health /atlas /status /hub/ → the CE node / hub
```

## One-time setup on a relay/host

The gateway needs the `ce-storage` binary and a running CE node.

1. Build `ce-storage` with the gateway feature (on a build host with the workspace, or on the box):
   ```
   cargo build --release --features gateway        # in the ce-storage repo
   sudo cp target/release/ce-storage /usr/local/bin/ce-storage
   ```
2. Install + start the service:
   ```
   sudo cp deploy/ce-storage-gw.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now ce-storage-gw
   ```
3. Publish the site (also done automatically by `deploy/deploy.sh` on every deploy):
   ```
   cd /var/www/ce-net
   ce-storage mb ce-net-site
   for f in *.html *.js; do ce-storage put "ce-net-site/$f" "$f" --content-type "text/html; charset=utf-8"; done
   sudo systemctl restart ce-storage-gw   # reload the bucket index
   ```

`deploy/deploy.sh` re-publishes the blobs on every deploy and is a no-op for the gateway on hosts
that don't have `ce-storage` installed (they serve the static fallback). The nginx routing lives in
`deploy/nginx.conf` (the `$ce_skey` map + the `location /` → gateway with `@static` fallback).

## Verify

```
curl -sI https://ce-net.com/ | grep -i x-ce-served      # -> ce-storage-gateway
sudo systemctl stop ce-storage-gw
curl -sI https://ce-net.com/ | grep -i x-ce-served      # -> static-fallback (still 200)
sudo systemctl start ce-storage-gw
```

## Next: public mesh ingress

This is the "gateway now" half of de-specialization. The full version — where the relay is a
**generic public ingress** any node's site routes through over the mesh (so ce-net.com is just one
node publishing its site) — is `ce-expose` public ingress (`ce-expose/docs/public-ingress.md`),
which must pass its security checklist (rate-limits, kill-switch, abuse logging) before going live.
