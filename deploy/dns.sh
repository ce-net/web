#!/usr/bin/env bash
# Create the docs.ce-net.com DNS record in Cloudflare (idempotent, proxied).
# Reads CLOUDFLARE_API_TOKEN from ce/.env. Run: bash deploy/dns.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; source "$HERE/ce/.env"; set +a

ZONE="1e8cbab8bc00451a218db1683bca8f1b"     # ce-net.com zone
NAME="docs.ce-net.com"
IP="178.105.145.170"
API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")

existing="$(curl -s "${AUTH[@]}" "$API/zones/$ZONE/dns_records?type=A&name=$NAME" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin); print(r["result"][0]["id"] if r.get("result") else "")')"

body="$(printf '{"type":"A","name":"%s","content":"%s","ttl":1,"proxied":true}' "$NAME" "$IP")"

if [ -n "$existing" ]; then
  echo "==> $NAME exists ($existing) — updating"
  curl -s -X PUT "${AUTH[@]}" "$API/zones/$ZONE/dns_records/$existing" --data "$body" \
    | python3 -c 'import sys,json; print("ok" if json.load(sys.stdin).get("success") else "FAILED")'
else
  echo "==> creating $NAME -> $IP (proxied)"
  curl -s -X POST "${AUTH[@]}" "$API/zones/$ZONE/dns_records" --data "$body" \
    | python3 -c 'import sys,json; print("ok" if json.load(sys.stdin).get("success") else "FAILED")'
fi
