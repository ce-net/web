#!/usr/bin/env bash
# List avfoundation capture devices so you can confirm indices for stream.sh.
set -euo pipefail
ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 \
  | sed -n '/AVFoundation video devices/,/Error opening input/p' \
  | grep -E '\[[0-9]+\]' || true
