#!/bin/sh
# Install the shared clipboard. Usage:  curl -fsSL cast.ce-net.com/clip | sh
set -e
B="$HOME/.local/bin"; mkdir -p "$B"
case ":$PATH:" in *":$B:"*) ;; *) PATH="$B:$PATH"; export PATH ;; esac
command -v python3 >/dev/null 2>&1 || { echo "clip needs python3:  sudo apt-get install -y python3"; exit 1; }
curl -fsSL https://cast.ce-net.com/clip.txt -o "$B/clip"
chmod +x "$B/clip"
echo "installed 'clip'. Usage:  clip  (send this machine's clipboard)   |   clip p  (receive)"
echo "Linux clipboard auto-copy needs one of: wl-clipboard / xclip  (e.g. sudo apt-get install -y wl-clipboard)"
