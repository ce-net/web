#!/usr/bin/env bash
# ce-cast supervisor — the broadcast that never gives up.
#
# Watches which publishers are live (via the MediaMTX API) and runs compose-fanout in the
# right MODE, restarting it whenever a publisher joins or drops:
#   screen + cam -> composite      cam only -> cam      screen only -> screen
#   nothing      -> slate ("live shortly") so the output, the platform connections, and the
#                   HLS stay alive between sessions and across phone/laptop power-cycles.
#
# So: power your phone off and on, close the laptop, reconnect later — the channel keeps
# running and folds each device back in automatically.

set -uo pipefail
cd "$(dirname "$0")"
MTX_API="${MTX_API:-127.0.0.1:9997}"

ready(){ curl -sf "http://${MTX_API}/v3/paths/get/$1" 2>/dev/null | grep -q '"ready": *true'; }

cleanup(){ [ -n "${FF:-}" ] && kill "$FF" 2>/dev/null; exit 0; }
trap cleanup INT TERM

while true; do
  s=0; c=0
  ready screen && s=1
  ready cam && c=1
  if   [ "$s" = 1 ] && [ "$c" = 1 ]; then mode=composite
  elif [ "$c" = 1 ];                then mode=cam
  elif [ "$s" = 1 ];                then mode=screen
  else                                   mode=slate
  fi
  echo "[supervise] screen=$s cam=$c -> mode=$mode"

  MODE="$mode" ./compose-fanout.sh &
  FF=$!

  # Restart when inputs change (join/drop) or the encoder dies.
  while kill -0 "$FF" 2>/dev/null; do
    sleep 2
    ns=0; nc=0
    ready screen && ns=1
    ready cam && nc=1
    if [ "$ns" != "$s" ] || [ "$nc" != "$c" ]; then
      echo "[supervise] input change (screen $s->$ns, cam $c->$nc) — switching"
      break
    fi
  done

  kill "$FF" 2>/dev/null
  wait "$FF" 2>/dev/null
  FF=
  sleep 0.5
done
