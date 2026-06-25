#!/usr/bin/env bash
# ce-cast — LAPTOP screen sender.
#
# The laptop's ONLY job in the phone-does-everything architecture: capture the screen,
# hardware-encode it ONCE (cheap on the media engine), and ship it to the phone, which
# composites + re-encodes + fans out to all platforms.
#
# Transport (DEST):
#   - Same Wi-Fi as the phone:   srt://<phone-ip>:9000           (lowest latency)
#   - Over ce-net (phone on 5G): rtmp://127.0.0.1:1935/cast/screen  through a ce-expose
#                                TCP tunnel (SRT is UDP and won't traverse the TCP tunnel).
#   - Local self-test:           file:./screen-feed.ts            (proves the encode works)
#
# Usage:
#   DEST=srt://192.168.1.50:9000?mode=caller ./screen-send.sh
#   DEST=rtmp://127.0.0.1:1935/cast/screen   ./screen-send.sh     # after `ce-expose connect`
#   SELFTEST=1 ./screen-send.sh                                   # 6s -> ./screen-feed.ts
#
# macOS 15 note: -pixel_format uyvy422 on the screen input is REQUIRED or capture hangs.

set -euo pipefail
cd "$(dirname "$0")"

SCREEN_DEV="${SCREEN_DEV:-1}"          # `./devices.sh` to confirm (1 = Capture screen 0)
RES="${RES:-1280x720}"                 # screen feed resolution (phone outputs its own final res)
FPS="${FPS:-30}"
VBITRATE="${VBITRATE:-6000k}"          # generous: this is a CONTRIBUTION feed the phone re-encodes
MAXRATE="${MAXRATE:-7000k}"
W="${RES%x*}"; H="${RES#*x}"
GOP=$(( FPS * 1 ))                     # 1s GOP — low latency for a live contribution feed

if [ "${SELFTEST:-0}" = "1" ]; then
  DEST="file:./screen-feed.ts"; EXTRA=(-t 6); echo "SELF-TEST -> ./screen-feed.ts (6s)"
else
  : "${DEST:?Set DEST (srt://… for LAN, rtmp://… through a ce-expose tunnel, or SELFTEST=1)}"
  EXTRA=()
fi

# Container by scheme: SRT/UDP/TCP -> mpegts; rtmp -> flv; file -> infer from .ts
case "$DEST" in
  srt://*|udp://*|tcp://*) FMT=(-f mpegts) ;;
  rtmp://*|rtmps://*)      FMT=(-f flv) ;;
  file:*)                  FMT=(-f mpegts); DEST="${DEST#file:}" ;;
  *)                       FMT=() ;;
esac

echo "Screen ${RES}@${FPS} -> ${VBITRATE} (contribution feed) -> ${DEST}"
exec ffmpeg -hide_banner -y \
  -f avfoundation -pixel_format uyvy422 -capture_cursor 1 -framerate "$FPS" -thread_queue_size 1024 -i "${SCREEN_DEV}:none" \
  -vf "scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=nv12" \
  -c:v h264_videotoolbox -profile:v high -realtime 1 \
  -b:v "$VBITRATE" -maxrate "$MAXRATE" -bufsize "$(( ${MAXRATE%k} ))k" \
  -g "$GOP" -r "$FPS" -pix_fmt nv12 \
  "${FMT[@]}" "${EXTRA[@]}" "$DEST"
