#!/bin/sh
# ce-link one-shot installer, served at https://cast.ce-net.com/link
# Usage:  curl -fsSL cast.ce-net.com/link | sh            (invite)
#         curl -fsSL cast.ce-net.com/link | sh -s join CODE
set -e
B="$HOME/.local/bin"; mkdir -p "$B"
case ":$PATH:" in *":$B:"*) ;; *) PATH="$B:$PATH"; export PATH ;; esac
command -v python3 >/dev/null 2>&1 || { echo "ce-link needs python3:  sudo apt-get install -y python3"; exit 1; }
command -v ce >/dev/null 2>&1 || { echo "ce-link needs the 'ce' CLI on PATH (install/start ce first)"; exit 1; }
curl -fsSL https://cast.ce-net.com/ce-link.txt -o "$B/ce-link"
chmod +x "$B/ce-link"
[ "$#" -eq 0 ] && set -- invite
exec "$B/ce-link" "$@"
