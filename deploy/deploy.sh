#!/usr/bin/env bash
# Deploy the CE landing page + docs to the relay and reload nginx.
# Run from anywhere:  bash deploy/deploy.sh
#
# Uses your ssh-agent for auth (the relay key must be loaded — `ssh-add -l` to check;
# `ssh-add ~/.ssh/id_ed25519` if it's the passphrase-protected one).
set -euo pipefail

RELAY="root@178.105.145.170"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH=(ssh -o BatchMode=yes)

echo "==> checking connectivity"
"${SSH[@]}" "$RELAY" 'true' || { echo "!! cannot reach relay — load your key: ssh-add ~/.ssh/id_ed25519"; exit 1; }

echo "==> web roots"
"${SSH[@]}" "$RELAY" 'mkdir -p /var/www/ce-net /var/www/ce-docs'

echo "==> uploading landing + browser-node + dashboard + docs"
scp -o BatchMode=yes "$HERE"/site/*.html           "$RELAY:/var/www/ce-net/"
scp -o BatchMode=yes "$HERE"/site/*.js             "$RELAY:/var/www/ce-net/"
scp -o BatchMode=yes "$HERE/docs-site/index.html"  "$RELAY:/var/www/ce-docs/index.html"

echo "==> installing nginx config (backing up the current one first)"
"${SSH[@]}" "$RELAY" 'test -f /etc/nginx/sites-available/ce && cp /etc/nginx/sites-available/ce /etc/nginx/sites-available/ce.bak.$(date +%s) || true'
scp -o BatchMode=yes "$HERE/deploy/nginx.conf" "$RELAY:/etc/nginx/sites-available/ce"
"${SSH[@]}" "$RELAY" '
  ln -sf /etc/nginx/sites-available/ce /etc/nginx/sites-enabled/ce &&
  nginx -t &&
  systemctl reload nginx
'

echo "==> verifying"
"${SSH[@]}" "$RELAY" 'curl -s -o /dev/null -w "  / -> %{http_code}\n" http://127.0.0.1/ -H "Host: ce-net.com"; curl -s -o /dev/null -w "  /bootstrap -> %{http_code}\n" http://127.0.0.1/bootstrap -H "Host: ce-net.com"; curl -s -o /dev/null -w "  docs / -> %{http_code}\n" http://127.0.0.1/ -H "Host: docs.ce-net.com"'

echo "==> done: https://ce-net.com  +  https://docs.ce-net.com"
