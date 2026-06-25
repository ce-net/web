#!/usr/bin/env bash
# Deploy the ce-cast MEDIA relay to the Hetzner box (MediaMTX + fan-out + signaling nginx).
# The UI is NOT deployed here — that is the CE app: `cd ce-cast/web && npm run deploy`.
#
# Reliability: every SSH/scp is key-pinned (IdentitiesOnly, so a loaded agent can't spam the
# server into closing the connection), connect-timed, and keepalive-bounded (a hung session
# dies in ~30s instead of hanging forever). Each step retries with backoff. A preflight check
# fails fast with an actionable message if the box itself is unhealthy.
#
# Platform stream keys (YouTube/Kick/X) live in /opt/ce-cast/relay/keys.env on the box,
# chmod 600 — never on the Mac, the phone, or in git.
#
# Usage:
#   ssh-add ~/.ssh/id_ed25519                       # once (key is passphrase-protected)
#   PUBLISH_KEY='long-random-secret' ./deploy.sh
#   RELAY_HOST=178.105.145.170 SSH_KEY=~/.ssh/id_ed25519 PUBLISH_KEY=... ./deploy.sh

set -euo pipefail
cd "$(dirname "$0")"

RELAY_HOST="${RELAY_HOST:-178.105.145.170}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE=/opt/ce-cast/relay
: "${PUBLISH_KEY:?Set PUBLISH_KEY to a long random secret (the same key you paste into the app once).}"

# Key-pinned, connect-timed, keepalive-bounded. ServerAlive* caps a hung session at ~30s.
SSH_OPTS=(-i "$SSH_KEY"
  -o IdentitiesOnly=yes
  -o ConnectTimeout=15
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=3
  -o StrictHostKeyChecking=accept-new)

ssh_() { ssh "${SSH_OPTS[@]}" "root@${RELAY_HOST}" "$@"; }
scp_() { scp "${SSH_OPTS[@]}" "$@"; }

# Retry a command up to 3x with backoff.
retry() {
  local n=0 max=3
  until "$@"; do
    n=$((n + 1)); [ "$n" -ge "$max" ] && return 1
    echo "   …retry ${n}/${max} in 4s"; sleep 4
  done
}

echo "==> [1/3] preflight: SSH reachability of ${RELAY_HOST}"
if ! retry ssh_ true; then
  cat >&2 <<EOF

FAILED to get a working SSH session to ${RELAY_HOST}.
The key is fine (run 'ssh-add -l' to confirm it is loaded) — the box itself is not responding.
A small relay (4 GB) most often does this when it is out of RAM or disk, or fail2ban has
temporarily blocked your IP after earlier failed attempts.

Diagnose / recover:
  ssh -i ${SSH_KEY} -o IdentitiesOnly=yes root@${RELAY_HOST} 'uptime; df -h /; free -m'
  # if that hangs too, reboot from the Hetzner console, wait ~60s, then re-run this script.
EOF
  exit 1
fi
echo "    ok"

echo "==> [2/3] ship config to ${RELAY_HOST}:~ (staging)"
retry scp_ mediamtx.prod.yml fanout.sh ce-cast-mediamtx.service nginx-cast.conf keys.env.example \
  "root@${RELAY_HOST}:"

echo "==> [3/3] provision (install + key inject + services) in one session"
retry ssh_ "PUBLISH_KEY='${PUBLISH_KEY}' REMOTE='${REMOTE}' bash -s" <<'REMOTE_SH'
set -euo pipefail
mkdir -p "$REMOTE"
# Stage from home into place with cp (idempotent across retries), then tidy.
for f in mediamtx.prod.yml fanout.sh ce-cast-mediamtx.service nginx-cast.conf keys.env.example; do
  [ -f ~/"$f" ] && cp -f ~/"$f" "$REMOTE/$f"
  [ -f "$REMOTE/$f" ] || { echo "deploy: missing $f after staging"; exit 1; }
done
rm -f ~/mediamtx.prod.yml ~/fanout.sh ~/ce-cast-mediamtx.service ~/nginx-cast.conf ~/keys.env.example
cd "$REMOTE"

# Inject the publish key into the live config only (git keeps the placeholder).
sed -i "s|REPLACE_WITH_PUBLISH_KEY|${PUBLISH_KEY}|" mediamtx.prod.yml
[ -f keys.env ] || cp keys.env.example keys.env      # keep existing platform keys
chmod 600 keys.env mediamtx.prod.yml
chmod +x fanout.sh

# Dependencies.
command -v ffmpeg >/dev/null 2>&1 || { apt-get update -y && apt-get install -y ffmpeg; }
if [ ! -x /usr/local/bin/mediamtx ] && ! command -v mediamtx >/dev/null 2>&1; then
  curl -fsSL https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_linux_amd64.tar.gz \
    | tar xz -C /usr/local/bin mediamtx
fi

# Systemd: MediaMTX launches fanout.sh via runOnReady. Retire the old standalone fanout unit.
cp ce-cast-mediamtx.service /etc/systemd/system/ce-cast-mediamtx.service
systemctl disable --now ce-cast-fanout.service >/dev/null 2>&1 || true
systemctl daemon-reload
systemctl enable --now ce-cast-mediamtx.service
systemctl restart ce-cast-mediamtx.service

# Signaling nginx vhost (separate server block; does not touch the ce default_server).
# Symlink straight at the deployed file — idempotent, and avoids cp's "same file" on re-runs.
ln -sf "$REMOTE/nginx-cast.conf" /etc/nginx/sites-available/cast
ln -sf /etc/nginx/sites-available/cast /etc/nginx/sites-enabled/cast
nginx -t && systemctl reload nginx

# Firewall: only the WebRTC media port is public here (signaling rides 80/443 via Cloudflare).
command -v ufw >/dev/null 2>&1 && ufw allow 8189/udp >/dev/null 2>&1 || true

echo "relay: mediamtx=$(systemctl is-active ce-cast-mediamtx.service)"
REMOTE_SH

echo
echo "==> done."
echo "    Platform keys (when ready):"
echo "      ssh -i ${SSH_KEY} -o IdentitiesOnly=yes root@${RELAY_HOST} 'nano ${REMOTE}/keys.env && systemctl restart ce-cast-mediamtx'"
echo "    UI:  cd ../web && npm run deploy"
