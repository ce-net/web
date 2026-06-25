#!/usr/bin/env bash
# ce-cast — RELAY composite + fan-out, ONE mode per run. supervise.sh picks the mode from
# which publishers are live (composite/cam/screen/slate) and restarts this on any change,
# so the broadcast never dies. Run standalone with MODE=… for manual use.

set -euo pipefail
cd "$(dirname "$0")"
[ -f keys.env ] || { echo "Missing relay/keys.env (cp keys.env.example keys.env)."; exit 1; }
# shellcheck disable=SC1091
source keys.env

SCREEN_URL="${SCREEN_URL:-rtsp://127.0.0.1:8554/screen}"
CAM_URL="${CAM_URL:-rtsp://127.0.0.1:8554/cam}"
RES="${RES:-1280x720}"; FPS="${FPS:-30}"
VBITRATE="${VBITRATE:-3500k}"; MAXRATE="${MAXRATE:-4000k}"; ABITRATE="${ABITRATE:-160k}"
CAM_H="${CAM_H:-180}"; MIRROR_CAM="${MIRROR_CAM:-1}"
HLS_DIR="${HLS_DIR:-./hls}"
MODE="${MODE:-composite}"; [ "${CAM_ONLY:-0}" = "1" ] && MODE=cam
W="${RES%x*}"; H="${RES#*x}"; GOP=$(( FPS * 2 ))
MF=""; [ "$MIRROR_CAM" = "1" ] && MF="hflip,"

if [ "$(uname)" = "Darwin" ] && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
  VENC=(-c:v h264_videotoolbox -realtime 1 -profile:v high)
else
  VENC=(-c:v libx264 -preset veryfast -tune zerolatency -profile:v high)
fi

mkdir -p "$HLS_DIR"
TARGETS=()
add(){ local b="${2%/}" k="$3"; [ -n "$k" ] && { TARGETS+=("[f=flv:onfail=ignore]${b}/${k}"); echo "  -> $1"; }; return 0; }
echo "Fan-out (mode=$MODE):"
add Twitch  "${TWITCH_URL:-}" "${TWITCH_KEY:-}"
add YouTube "${YT_URL:-}"     "${YT_KEY:-}"
add X       "${X_URL:-}"      "${X_KEY:-}"
add Kick    "${KICK_URL:-}"   "${KICK_KEY:-}"
TARGETS+=("[f=hls:hls_time=2:hls_list_size=8:hls_flags=delete_segments+independent_segments:hls_segment_filename=${HLS_DIR}/seg_%05d.ts]${HLS_DIR}/index.m3u8")
TEE=$(IFS='|'; echo "${TARGETS[*]}")

# RTSP input that EOFs (so ffmpeg exits and the supervisor relaunches) if the publisher dies.
RC=(-rtsp_transport tcp -timeout 5000000)
SILENT=(-re -f lavfi -i "anullsrc=r=44100:cl=stereo")

case "$MODE" in
  composite)
    IN=("${RC[@]}" -i "$SCREEN_URL" "${RC[@]}" -i "$CAM_URL")
    FILT="[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1[bg];[1:v]${MF}scale=-2:${CAM_H}[cam];[bg][cam]overlay=W-w-24:H-h-24,fps=${FPS},format=yuv420p[v]"
    AMAP=(-map "1:a?") ;;
  cam)
    IN=("${RC[@]}" -i "$CAM_URL")
    FILT="[0:v]${MF}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v]"
    AMAP=(-map "0:a?") ;;
  screen)
    IN=("${RC[@]}" -i "$SCREEN_URL" "${SILENT[@]}")
    FILT="[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v]"
    AMAP=(-map "1:a") ;;
  slate|*)
    FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
    DT=""; [ -f "$FONT" ] && DT="drawtext=fontfile=${FONT}:text='Rheo — live shortly':fontcolor=0xe9e7e2:fontsize=44:x=(w-text_w)/2:y=(h-text_h)/2,"
    IN=(-re -f lavfi -i "color=c=0x0b0b0c:s=${W}x${H}:r=${FPS}" "${SILENT[@]}")
    FILT="[0:v]${DT}format=yuv420p[v]"
    AMAP=(-map "1:a") ;;
esac

echo "Compositing mode=$MODE ${RES}@${FPS} -> ${VBITRATE}"
exec ffmpeg -hide_banner \
  "${IN[@]}" \
  -filter_complex "$FILT" \
  -map "[v]" "${AMAP[@]}" \
  "${VENC[@]}" -b:v "$VBITRATE" -maxrate "$MAXRATE" -bufsize "$(( ${MAXRATE%k} * 2 ))k" \
  -g "$GOP" -r "$FPS" -pix_fmt yuv420p \
  -c:a aac -b:a "$ABITRATE" -ar 44100 -ac 2 \
  -f tee "$TEE"
