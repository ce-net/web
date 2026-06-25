#!/usr/bin/env bash
# ce-net RELAY restreamer — runs on the Hetzner relay (178.105.145.170).
#
# Accepts ONE incoming RTMP stream from the Mac (already encoded), then COPIES it
# (no re-encode) out to every platform with a key set, and packages HLS for ce-net
# viewers. ffmpeg itself is the RTMP server (-listen 1) — no nginx/mediamtx needed.
#
# The Mac sends a single ~3 Mbps stream; all the N-way fan-out bandwidth lives here
# in the datacenter, so the laptop stays unstrained.
#
# Run under systemd (see relay/install.md) so it relistens after each session.
#
#   PORT=1935 ./restream.sh
#
# Secure the ingest by NOT opening :1935 publicly — front it with ce-expose
# (capability-gated mesh tunnel). See relay/install.md.

set -euo pipefail
cd "$(dirname "$0")"

[ -f keys.env ] || { echo "Missing relay/keys.env (cp keys.env.example keys.env, fill platform keys)."; exit 1; }
# shellcheck disable=SC1091
source keys.env

PORT="${PORT:-1935}"
APP="${APP:-live}"
KEY="${INGEST_KEY:-rheo}"            # the Mac pushes to rtmp://<relay>:<port>/<app>/<key>
HLS_DIR="${HLS_DIR:-/var/www/hls}"
HLS_NAME="${HLS_NAME:-index}"

mkdir -p "$HLS_DIR"

# ---- build fan-out targets (copy, no re-encode) ----------------------------
TARGETS=()
add() { local base="${2%/}" key="$3"; [ -n "$key" ] && { TARGETS+=("[f=flv:onfail=ignore]${base}/${key}"); echo "  -> $1"; }; return 0; }
echo "Relay will restream to:"
add Twitch  "${TWITCH_URL:-}" "${TWITCH_KEY:-}"
add YouTube "${YT_URL:-}"     "${YT_KEY:-}"
add X       "${X_URL:-}"      "${X_KEY:-}"
add Kick    "${KICK_URL:-}"   "${KICK_KEY:-}"

# HLS leg for ce-net viewers (immutable segments -> ce-cdn / ce-expose origin)
TARGETS+=("[f=hls:hls_time=2:hls_list_size=6:hls_flags=delete_segments+independent_segments:hls_segment_filename=${HLS_DIR}/seg_%05d.ts]${HLS_DIR}/${HLS_NAME}.m3u8")
echo "  -> ce-net HLS: ${HLS_DIR}/${HLS_NAME}.m3u8"

TEE=$(IFS='|'; echo "${TARGETS[*]}")
INGEST="rtmp://0.0.0.0:${PORT}/${APP}/${KEY}"
echo "Listening for the Mac's stream on ${INGEST} (Ctrl-C to stop)"

# -c copy = pure remux, negligible CPU. Reconnect each session (systemd restarts us).
# tee REQUIRES explicit -map; it does not auto-select streams.
exec ffmpeg -hide_banner -listen 1 -i "$INGEST" \
  -map 0:v -map 0:a -c copy -f tee "$TEE"
