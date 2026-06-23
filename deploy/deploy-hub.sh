#!/usr/bin/env bash
# Deploy the ce-hub sidecar (browser-node rendezvous) to the relay as a systemd service.
# Run: bash deploy/deploy-hub.sh   (needs the relay key in your ssh-agent)
set -euo pipefail

RELAY="root@178.105.145.170"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH=(ssh -o BatchMode=yes)
# This workspace uses a shared cargo target dir (ce-net/.cargo/config.toml -> target-dir =
# ce-net/.cargo-shared), so cross-compiled artifacts land there, not under ce-hub/target.
# Prefer the shared path; fall back to the per-crate target for older checkouts.
BIN="$HERE/../.cargo-shared/x86_64-unknown-linux-musl/release/ce-hub"
[ -f "$BIN" ] || BIN="$HERE/ce-hub/target/x86_64-unknown-linux-musl/release/ce-hub"

test -f "$BIN" || { echo "!! build first:  (cd ce-hub && cargo zigbuild --release --target x86_64-unknown-linux-musl)"; exit 1; }

echo "==> staging binary + wasm modules"
# /opt/ce-hub/data holds persistent app files, the KV database, and node uptime records
# (CE_HUB_DATA). Created here so the first start has a writable dir under ProtectSystem=strict.
"${SSH[@]}" "$RELAY" 'mkdir -p /opt/ce-hub/modules /opt/ce-hub/data'
scp -o BatchMode=yes "$BIN" "$RELAY:/opt/ce-hub/ce-hub.new"
scp -o BatchMode=yes "$HERE"/ce-hub/modules/*.wasm "$RELAY:/opt/ce-hub/modules/"
"${SSH[@]}" "$RELAY" 'mv -f /opt/ce-hub/ce-hub.new /opt/ce-hub/ce-hub && chmod +x /opt/ce-hub/ce-hub'

echo "==> installing systemd unit"
scp -o BatchMode=yes "$HERE/deploy/ce-hub.service" "$RELAY:/etc/systemd/system/ce-hub.service"
"${SSH[@]}" "$RELAY" '
  systemctl daemon-reload &&
  systemctl enable ce-hub >/dev/null 2>&1 &&
  systemctl restart ce-hub &&
  sleep 1 &&
  echo -n "service: " && systemctl is-active ce-hub &&
  echo -n "stats:   " && curl -s http://127.0.0.1:8970/stats && echo
'
echo "==> ce-hub deployed on :8970 (proxied at /hub/ by nginx)"
