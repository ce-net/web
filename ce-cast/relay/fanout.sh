#!/usr/bin/env bash
# ce-net relay FAN-OUT — launched by MediaMTX runOnReady the instant the phone's
# composited `program` stream goes live. Pulls it locally over RTSP and COPIES it
# (no video re-encode) out to every platform that has a key set in keys.env.
#
# The phone already did the expensive composite + H.264 encode. Here we only:
#   - copy the H.264 video bit-for-bit (-c:v copy, negligible CPU)
#   - transcode Opus -> AAC for audio (RTMP/platforms require AAC; tiny CPU)
#   - tee one input to N platforms, so all the fan-out bandwidth lives in the datacenter.
#
# Platform stream keys live ONLY in relay/keys.env (chmod 600) — never on the Mac or phone.

set -euo pipefail
cd "$(dirname "$0")"

[ -f keys.env ] || { echo "fanout: missing relay/keys.env"; exit 1; }
# shellcheck disable=SC1091
source keys.env

SRC="rtsp://127.0.0.1:8554/program"

TARGETS=()
add() { local base="${2%/}" key="$3"; [ -n "$key" ] && { TARGETS+=("[f=flv:onfail=ignore]${base}/${key}"); echo "  -> $1"; }; return 0; }
echo "fanout: program -> platforms"
add YouTube "${YT_URL:-}"     "${YT_KEY:-}"
add Kick    "${KICK_URL:-}"   "${KICK_KEY:-}"
add X       "${X_URL:-}"      "${X_KEY:-}"
add Twitch  "${TWITCH_URL:-}" "${TWITCH_KEY:-}"

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "fanout: no platform keys set in keys.env — nothing to do."
  exit 0
fi

TEE=$(IFS='|'; echo "${TARGETS[*]}")

# -rtsp_transport tcp: reliable local pull. Video copied; audio -> AAC 160k stereo.
exec ffmpeg -hide_banner -nostdin -rtsp_transport tcp -i "$SRC" \
  -map 0:v -map 0:a? \
  -c:v copy \
  -c:a aac -b:a 160k -ar 44100 -ac 2 \
  -f tee "$TEE"
