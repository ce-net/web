#!/usr/bin/env bash
# ce-build — build CE projects ON the relay (Hetzner, x86_64 Linux), not on the dev laptop.
#
# Why: the relay is the same target we deploy to, so a native build there IS the deploy artifact
# (no musl cross-compile), it keeps heavy Rust/wasm build trees off the laptop disk, and it dogfoods
# the mesh as a build host. Needs the relay key in your ssh-agent.
#
#   bash deploy/ce-build.sh hub                         # build ce-hub on the relay, install + restart
#   bash deploy/ce-build.sh wasm projects/drift drift   # build a Rust->wasm app, deploy to /apps/drift/
#   bash deploy/ce-build.sh cargo projects/drift/sim test --release   # run any cargo cmd on the relay
#   bash deploy/ce-build.sh toolchain                   # show wasm-toolchain install progress
set -euo pipefail

RELAY="root@178.105.145.170"
KEY="$HOME/.ssh/id_ed25519"
# Multiplex all SSH/rsync over ONE persistent connection so a multi-step build does not open a dozen
# sessions (which the relay's sshd was dropping). ControlPersist keeps it warm between commands.
RSH="ssh -o BatchMode=yes -o ServerAliveInterval=15 -o ControlMaster=auto -o ControlPath=/tmp/ce-ssh-%C -o ControlPersist=180 -i $KEY"
SSH=($RSH)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # web/
REMOTE=/opt/ce-build
# Never ship build trees or the laptop-absolute .cargo/config (would break cargo on the relay).
EXC=(--exclude 'target' --exclude 'target-*' --exclude 'node_modules' --exclude 'dist' --exclude 'pkg' --exclude '.git' --exclude '.cargo')

sync() { # <localdir> <name>
  "${SSH[@]}" "$RELAY" "mkdir -p $REMOTE/$2"
  rsync -az --delete "${EXC[@]}" -e "$RSH" "$1/" "$RELAY:$REMOTE/$2/"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  hub)
    echo "==> sync ce-hub + its ce-rs path dep, then build natively on the relay"
    # ce-hub now lives at ~/ce-net/ce-hub (its own repo) and depends on ../ce-rs (path dep), so
    # ship ce-rs to $REMOTE/ce-rs alongside ce-hub for the relative path to resolve on the relay.
    sync "$HERE/../ce-rs" ce-rs
    sync "$HERE/../ce-hub" ce-hub
    # Capture cargo's real exit code (a bare `| tail` would mask a failed build and then redeploy the
    # stale binary). set -euo pipefail aborts the script here on a non-zero build before install.
    "${SSH[@]}" "$RELAY" 'source $HOME/.cargo/env; cd '"$REMOTE"'/ce-hub && (cargo build --release > /tmp/ce-hub-build.log 2>&1; rc=$?; tail -25 /tmp/ce-hub-build.log; exit $rc)'
    echo "==> install binary + ensure modules/data + restart service"
    # refresh builtin wasm modules from the repo too
    "${SSH[@]}" "$RELAY" "mkdir -p /opt/ce-hub/modules /opt/ce-hub/data"
    rsync -az -e "$RSH" "$HERE"/../ce-hub/modules/ "$RELAY:/opt/ce-hub/modules/" 2>/dev/null || true
    # keep the systemd unit (env: limits, rate-limit, admin-owner) in sync with the repo
    rsync -az -e "$RSH" "$HERE"/deploy/ce-hub.service "$RELAY:/etc/systemd/system/ce-hub.service" 2>/dev/null || true
    "${SSH[@]}" "$RELAY" '
      systemctl daemon-reload &&
      install -m755 '"$REMOTE"'/ce-hub/target/release/ce-hub /opt/ce-hub/ce-hub.new &&
      mv -f /opt/ce-hub/ce-hub.new /opt/ce-hub/ce-hub &&
      systemctl restart ce-hub && sleep 1 &&
      printf "service: " && systemctl is-active ce-hub &&
      printf "stats:   " && curl -s http://127.0.0.1:8970/stats | head -c 260 && echo'
    echo "==> ce-hub built on the relay and live on :8970"
    ;;

  serve) # build + install the ce-serve HTTP edge (and ce-serve-publish) on the relay
    echo "==> sync ce-serve + its ce-rs dep, build natively on the relay, install + restart"
    sync "$HERE/../ce-rs" ce-rs
    sync "$HERE/../ce-serve" ce-serve
    "${SSH[@]}" "$RELAY" 'source $HOME/.cargo/env; cd '"$REMOTE"'/ce-serve && (cargo build --release > /tmp/ce-serve-build.log 2>&1; rc=$?; tail -25 /tmp/ce-serve-build.log; exit $rc)'
    rsync -az -e "$RSH" "$HERE"/../ce-serve/deploy/ce-serve.service "$RELAY:/etc/systemd/system/ce-serve.service" 2>/dev/null || true
    "${SSH[@]}" "$RELAY" '
      mkdir -p /opt/ce-serve/site &&
      install -m755 '"$REMOTE"'/ce-serve/target/release/ce-serve /opt/ce-serve/ce-serve.new &&
      mv -f /opt/ce-serve/ce-serve.new /opt/ce-serve/ce-serve &&
      install -m755 '"$REMOTE"'/ce-serve/target/release/ce-serve-publish /opt/ce-serve/ce-serve-publish &&
      systemctl daemon-reload && systemctl enable ce-serve >/dev/null 2>&1 &&
      systemctl restart ce-serve && sleep 1 &&
      printf "service: " && systemctl is-active ce-serve &&
      printf "health:  " && curl -s http://127.0.0.1:8790/healthz && echo'
    echo "==> ce-serve built on the relay and live on :8790"
    ;;

  wasm) # ce-build wasm <project-dir-rel-to-web> <app-id>
    dir="${1:?usage: ce-build wasm <dir> <app-id>}"; app="${2:?missing app id}"
    name="$(basename "$dir")"
    echo "==> sync + build wasm app '$name' on the relay (trunk or wasm-pack)"
    sync "$HERE/$dir" "$name"
    "${SSH[@]}" "$RELAY" 'source $HOME/.cargo/env; cd '"$REMOTE/$name"' &&
      if [ -f Trunk.toml ] || [ -f index.html ]; then trunk build --release --public-url ./ ;
      elif [ -f Cargo.toml ]; then wasm-pack build --release --target web ;
      else echo "no Trunk.toml/index.html/Cargo.toml" >&2; exit 1; fi 2>&1 | tail -20'
    echo "==> deploy built assets to /apps/'"$app"'/ from the relay (server-side, no laptop round-trip)"
    "${SSH[@]}" "$RELAY" '
      cd '"$REMOTE/$name"'; out=dist; [ -d dist ] || out=pkg
      ctype(){ case "$1" in *.html) echo "text/html; charset=utf-8";; *.js|*.mjs) echo "text/javascript";; *.css) echo "text/css";; *.wasm) echo "application/wasm";; *.json) echo "application/json";; *.svg) echo "image/svg+xml";; *.png) echo image/png;; *.wgsl) echo "text/plain";; *) echo "application/octet-stream";; esac; }
      ( cd "$out" && find . -type f | sed "s|^\./||" | while read -r f; do
          code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "http://127.0.0.1:8970/apps/'"$app"'/$f" -H "content-type: $(ctype "$f")" --data-binary @"$f")
          echo "    $f -> $code"
        done )'
    echo "==> wasm app live: https://ce-net.com/apps/'"$app"'/  and  https://'"$app"'.ce-net.com/"
    ;;

  cargo) # ce-build cargo <dir-rel-to-web> [cargo args...]   (e.g. test --release)
    dir="${1:?usage: ce-build cargo <dir> [args]}"; shift || true
    name="$(basename "$dir")"
    echo "==> sync + cargo $* on the relay for '$name'"
    sync "$HERE/$dir" "$name"
    "${SSH[@]}" "$RELAY" 'source $HOME/.cargo/env; cd '"$REMOTE/$name"' && cargo '"$*"' 2>&1 | tail -40'
    ;;

  drift) # full multi-crate drift build + deploy on the relay
    echo "==> sync drift + netgame to relay"
    sync "$HERE/projects/drift" drift
    # stage.mjs resolves netgame at ../../ce-app/client/netgame.js relative to /opt/ce-build/drift,
    # i.e. /opt/ce-app/client/netgame.js — put it exactly there.
    "${SSH[@]}" "$RELAY" "mkdir -p /opt/ce-app/client"
    rsync -az -e "$RSH" "$HERE"/ce-app/client/ "$RELAY:/opt/ce-app/client/"
    echo "==> build wgpu client + sim wasm + stage + deploy (on the relay)"
    "${SSH[@]}" "$RELAY" 'source $HOME/.cargo/env; set -e
      cd '"$REMOTE"'/drift
      echo "-- wgpu client (wasm-pack -> ./pkg)"
      if ( cd client && wasm-pack build --release --target web --out-dir ../pkg ) >/tmp/drift-client.log 2>&1; then
        echo "   client OK (wgpu renderer included)"
      else tail -12 /tmp/drift-client.log
        echo "   CLIENT BUILD FAILED -> transport-only (index.html probes ./pkg/drift_client.js and degrades)"
        rm -f pkg/drift_client*.js pkg/drift_client*.wasm pkg/package.json 2>/dev/null || true
      fi
      echo "-- sim wasm (for the wasm host)"
      (cd sim && cargo build --release --target wasm32-unknown-unknown 2>&1 | tail -4)
      mkdir -p pkg && cp -f sim/target/wasm32-unknown-unknown/release/drift_sim.wasm pkg/ 2>/dev/null || true
      echo "-- stage browser bundle"
      node stage.mjs
      echo "-- deploy out/ -> /apps/drift/"
      ctype(){ case "$1" in *.html) echo "text/html; charset=utf-8";; *.js|*.mjs) echo "text/javascript";; *.css) echo "text/css";; *.wasm) echo application/wasm;; *.json) echo application/json;; *.svg) echo image/svg+xml;; *) echo application/octet-stream;; esac; }
      ( cd out && find . -type f | sed "s|^\./||" | while read -r f; do
          code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "http://127.0.0.1:8970/apps/drift/$f" -H "content-type: $(ctype "$f")" --data-binary @"$f"); echo "    $f -> $code"; done )'
    echo "==> drift live: https://drift.ce-net.com/  and  https://ce-net.com/apps/drift/"
    ;;

  toolchain)
    "${SSH[@]}" "$RELAY" 'tail -5 /opt/ce-build/toolchain.log 2>/dev/null; echo; for t in trunk wasm-bindgen wasm-pack; do printf "%-14s " $t; (source $HOME/.cargo/env; command -v $t || echo installing...); done'
    ;;

  *) echo "usage: ce-build {hub | wasm <dir> <app> | cargo <dir> [args] | toolchain}"; exit 2 ;;
esac
