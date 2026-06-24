#!/usr/bin/env bash
# Publish the bundled demo apps to the CE hub under fixed, bare app ids so their realtime/db
# namespaces, their public URLs, and the /play gallery all line up. Each demo is a folder under
# web/demos/<dir>; it is uploaded to https://ce-net.com/apps/<app>/ (and https://<app>.ce-net.com/).
# Usage: bash deploy/deploy-demos.sh            (uploads via the public hub; override with CE_HUB)
set -euo pipefail

HUB="${CE_HUB:-https://ce-net.com}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# dir:appid  (spacegame is served as app "spa" so it lives at spa.ce-net.com/game)
PAIRS="arena:arena place:place cursors:cursors draw:draw poll:poll wall:wall spacegame:spa"

ctype() {
  case "$1" in
    *.html) echo "text/html; charset=utf-8" ;;
    *.js|*.mjs) echo "text/javascript; charset=utf-8" ;;
    *.css) echo "text/css; charset=utf-8" ;;
    *.json) echo "application/json" ;;
    *.svg) echo "image/svg+xml" ;;
    *.png) echo "image/png" ;; *.jpg|*.jpeg) echo "image/jpeg" ;;
    *.webp) echo "image/webp" ;; *.ico) echo "image/x-icon" ;;
    *.wasm) echo "application/wasm" ;;
    *) echo "application/octet-stream" ;;
  esac
}

for pair in $PAIRS; do
  dir="${pair%%:*}"; app="${pair##*:}"
  root="$HERE/demos/$dir"
  [ -d "$root" ] || { echo "skip $dir (not built yet)"; continue; }
  echo "==> $dir -> app '$app'"
  ( cd "$root" && find . -type f | sed 's|^\./||' | while read -r rel; do
      code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$HUB/apps/$app/$rel" \
        -H "content-type: $(ctype "$rel")" --data-binary @"$rel")
      echo "    $rel -> $code"
    done )
  echo "    live: $HUB/apps/$app/   and   https://$app.ce-net.com/"
done
echo "==> done"
