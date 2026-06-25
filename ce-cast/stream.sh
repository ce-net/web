#!/usr/bin/env bash
# Rheo live broadcast — encode ONCE (hardware VideoToolbox), fan out to all platforms.
#
# Captures: screen + webcam (corner overlay) + mic.
# Encodes once with h264_videotoolbox, then ffmpeg's tee muxer copies the same
# encoded stream to every platform whose KEY is set in keys.env. No per-platform
# re-encode, so the i3 stays usable while you keep developing.
#
# Usage:
#   ./stream.sh                 # go live to all platforms with a key set
#   NO_CAM=1 ./stream.sh        # screen + mic only (don't open the webcam)
#   SYSAUDIO=1 ./stream.sh      # mix system audio (BlackHole 2ch) with the mic
#   DRY_RUN=1 ./stream.sh       # print the plan + ffmpeg command, don't stream
#
# Stop with Ctrl-C (ends all platforms cleanly).

set -euo pipefail
cd "$(dirname "$0")"

# ---- config ----------------------------------------------------------------
[ -f keys.env ] || { echo "Missing keys.env. Run: cp keys.env.example keys.env  then fill in your stream keys."; exit 1; }
# shellcheck disable=SC1091
source keys.env

RES="${RES:-1280x720}"
FPS="${FPS:-30}"
VBITRATE="${VBITRATE:-2800k}"
MAXRATE="${MAXRATE:-3200k}"
ABITRATE="${ABITRATE:-160k}"
CAM_H="${CAM_H:-170}"

# avfoundation device indices (confirm with ./devices.sh)
SCREEN_DEV="${SCREEN_DEV:-1}"   # Capture screen 0
CAM_DEV="${CAM_DEV:-0}"         # FaceTime HD Camera
MIC_DEV="${MIC_DEV:-1}"         # MacBook Air Microphone
SYS_DEV="${SYS_DEV:-0}"         # BlackHole 2ch (system audio loopback)

W="${RES%x*}"; H="${RES#*x}"
GOP=$(( FPS * 2 ))             # 2s keyframe interval (Twitch/YouTube requirement)

# ---- build the platform fan-out list ---------------------------------------
TARGETS=()
add() {  # name base key
  local base="${2%/}" key="$3"
  [ -n "$key" ] && { TARGETS+=("[f=flv:onfail=ignore]${base}/${key}"); echo "  + $1"; }
  return 0
}
if [ -n "${RELAY_URL:-}" ]; then
  # RELAY MODE: push ONE stream to the ce-net relay; it fans out to all platforms.
  # Keeps the Mac at ~3 Mbps up and zero fan-out (see relay/restream.sh).
  TARGETS=("[f=flv]${RELAY_URL%/}/${RELAY_KEY:-rheo}")
  echo "  + ce-net relay (relay fans out to all platforms): ${RELAY_URL%/}/${RELAY_KEY:-rheo}"
else
  echo "Active platforms (direct fan-out from this Mac):"
  add Twitch  "${TWITCH_URL:-}" "${TWITCH_KEY:-}"
  add YouTube "${YT_URL:-}"     "${YT_KEY:-}"
  add X       "${X_URL:-}"      "${X_KEY:-}"
  add Kick    "${KICK_URL:-}"   "${KICK_KEY:-}"
fi

[ ${#TARGETS[@]} -eq 0 ] && { echo "No stream keys set in keys.env — nothing to broadcast to."; exit 1; }
TEE=$(IFS='|'; echo "${TARGETS[*]}")

# ---- bandwidth sanity note -------------------------------------------------
n=${#TARGETS[@]}
vb=${VBITRATE%k}; ab=${ABITRATE%k}
up=$(( (vb + ab) * n / 1000 ))
echo "Encoding once @ ${RES}/${FPS}fps, ~$(( vb + ab ))kbps; fanning out to ${n} platform(s)."
echo "Required UPLOAD bandwidth ≈ ${up} Mbps (local fan-out sends one copy per platform)."

# ---- assemble ffmpeg inputs + filter ---------------------------------------
# NOTE: -pixel_format uyvy422 is REQUIRED for screen capture on macOS 15 (Sequoia);
# without it ffmpeg picks an unsupported format and the avfoundation screen input hangs.
INPUTS=( -f avfoundation -pixel_format uyvy422 -capture_cursor 1 -framerate "$FPS" -thread_queue_size 1024 -i "${SCREEN_DEV}:none" )

# audio: mic, optionally mixed with system audio (BlackHole)
if [ "${SYSAUDIO:-0}" = "1" ]; then
  INPUTS+=( -f avfoundation -thread_queue_size 1024 -i "none:${MIC_DEV}"
            -f avfoundation -thread_queue_size 1024 -i "none:${SYS_DEV}" )
  AUDIO_IN="audio_mic_sys"
  AFILTER="[1:a][2:a]amix=inputs=2:duration=longest:normalize=0,aresample=async=1000[a]"
else
  INPUTS+=( -f avfoundation -thread_queue_size 1024 -i "none:${MIC_DEV}" )
  AFILTER="[1:a]aresample=async=1000[a]"
fi

if [ "${NO_CAM:-0}" = "1" ]; then
  VFILTER="[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=nv12[v]"
else
  # webcam is the LAST input so the audio input indices above stay stable
  INPUTS+=( -f avfoundation -framerate "$FPS" -thread_queue_size 1024 -i "${CAM_DEV}:none" )
  # input order: 0=screen, 1=mic, [2=sysaudio if SYSAUDIO], then cam
  CAM_IDX=2; [ "${SYSAUDIO:-0}" = "1" ] && CAM_IDX=3
  VFILTER="[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1[bg];[${CAM_IDX}:v]scale=-2:${CAM_H}[cam];[bg][cam]overlay=W-w-24:H-h-24,fps=${FPS},format=nv12[v]"
fi

FFMPEG_ARGS=(
  -hide_banner -y
  "${INPUTS[@]}"
  -filter_complex "${VFILTER};${AFILTER}"
  -map "[v]" -map "[a]"
  -c:v h264_videotoolbox -profile:v high -realtime 1
  -b:v "$VBITRATE" -maxrate "$MAXRATE" -bufsize "$(( ${MAXRATE%k} * 2 ))k"
  -g "$GOP" -r "$FPS" -pix_fmt nv12
  -c:a aac -b:a "$ABITRATE" -ar 44100 -ac 2
  -f tee "$TEE"
)

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo; echo "DRY RUN — would run:"; printf 'ffmpeg'; printf ' %q' "${FFMPEG_ARGS[@]}"; echo
  exit 0
fi

echo; echo "Going live… (Ctrl-C to stop)"
exec ffmpeg "${FFMPEG_ARGS[@]}"
