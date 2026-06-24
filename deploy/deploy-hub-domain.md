# Deploy hub.ce-net.com — operator runbook

Step-by-step to put the hub git layer on its own subdomain. Do these on the operator laptop
(Cloudflare + git push) and on the relay (`root@178.105.145.170`, key in your ssh-agent:
`ssh-add ~/.ssh/id_ed25519`). The git layer is part of the existing `web/ce-hub` process on
`:8970` — no new service. Reference: `PLAN/hub-git-contract.md`, `web/ce-hub/GIT.md`.

Prereqs: `CLOUDFLARE_API_TOKEN` in `ce/.env`, the relay SSH key loaded, and the relay must
have the system `git` binary installed (`git http-backend` is the wire-protocol backend).

---

## 1. Cloudflare A record: hub.ce-net.com -> 178.105.145.170 (proxied)

Either run the snippet below (mirrors `deploy/dns.sh`, idempotent), or add it by hand in the
Cloudflare dashboard.

```bash
cd ~/ce-net
set -a; source ce/.env; set +a
ZONE=1e8cbab8bc00451a218db1683bca8f1b           # ce-net.com zone
API=https://api.cloudflare.com/client/v4
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")
NAME=hub.ce-net.com; IP=178.105.145.170

existing="$(curl -s "${AUTH[@]}" "$API/zones/$ZONE/dns_records?type=A&name=$NAME" \
  | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r["result"][0]["id"] if r.get("result") else "")')"
body="$(printf '{"type":"A","name":"%s","content":"%s","ttl":1,"proxied":true}' "$NAME" "$IP")"
if [ -n "$existing" ]; then
  curl -s -X PUT "${AUTH[@]}" "$API/zones/$ZONE/dns_records/$existing" --data "$body" | python3 -c 'import sys,json;print("ok" if json.load(sys.stdin).get("success") else "FAILED")'
else
  curl -s -X POST "${AUTH[@]}" "$API/zones/$ZONE/dns_records" --data "$body" | python3 -c 'import sys,json;print("ok" if json.load(sys.stdin).get("success") else "FAILED")'
fi
```

By hand: Cloudflare -> ce-net.com -> DNS -> Add record: A, name `hub`, content
`178.105.145.170`, proxy status Proxied (orange cloud). Universal SSL already covers
one-level `*.ce-net.com`, so TLS works immediately.

---

## 2. Install hub-nginx.conf on the relay

```bash
scp -i ~/.ssh/id_ed25519 web/deploy/hub-nginx.conf \
  root@178.105.145.170:/etc/nginx/sites-available/ce-hub

ssh -i ~/.ssh/id_ed25519 root@178.105.145.170 \
  'ln -sf /etc/nginx/sites-available/ce-hub /etc/nginx/sites-enabled/ce-hub'
```

The `map $http_upgrade $connection_upgrade` block lives in the main `nginx.conf` at http{}
scope and is shared — `hub-nginx.conf` deliberately does not redeclare it.

---

## 3. Reload nginx (test first)

```bash
ssh -i ~/.ssh/id_ed25519 root@178.105.145.170 'nginx -t && systemctl reload nginx'
```

`nginx -t` must print `syntax is ok` / `test is successful` before the reload. If the test
fails, fix `hub-nginx.conf` and re-copy; do NOT reload a failing config.

---

## 4. Build + restart the hub on the relay

The git layer ships inside the `ce-hub` binary. Build it natively on the relay (never on the
laptop — disk is tight) and restart the service:

```bash
cd ~/ce-net/web
bash deploy/ce-build.sh hub
```

This syncs `web/ce-hub`, runs `cargo build --release` on the relay, installs the binary to
`/opt/ce-hub/ce-hub`, syncs the systemd unit (which carries `CE_HUB_MAX_GIT_BYTES` and the
admin-owner), restarts `ce-hub`, and prints the live `/stats`. Confirm:

```bash
ssh -i ~/.ssh/id_ed25519 root@178.105.145.170 'systemctl is-active ce-hub'
```

Make sure the relay has git installed (one-time):

```bash
ssh -i ~/.ssh/id_ed25519 root@178.105.145.170 'git --version || apt-get install -y git'
```

---

## 5. Smoke test over the new domain

Give Cloudflare a moment to pick up the record, then:

```bash
# UI / API liveness through Cloudflare
curl -sS https://hub.ce-net.com/repos | head -c 200; echo

# end-to-end git: create a repo (signed) with the cehub CLI or the e2e signer, then clone it.
# A throwaway local round trip with the e2e script first proves the binary is good:
CE_HUB_BIN=/path/to/ce-hub bash ~/ce-net/e2e/e2e-hub-git.sh

# real clone over the public domain (replace owner/repo with a real one you created):
git clone https://hub.ce-net.com/<owner>/<repo>.git /tmp/hub-smoke
ls /tmp/hub-smoke && rm -rf /tmp/hub-smoke
```

A successful clone over `https://hub.ce-net.com/...` confirms: DNS + Cloudflare proxy, the
nginx `/git/` block (no buffering, large body), and `git http-backend` behind ce-hub are all
wired correctly.

---

## Rollback

```bash
ssh -i ~/.ssh/id_ed25519 root@178.105.145.170 \
  'rm -f /etc/nginx/sites-enabled/ce-hub && nginx -t && systemctl reload nginx'
```

Removing the symlink drops the `hub.ce-net.com` server block; the apex and app subdomains are
untouched because they are defined in the separate main `nginx.conf`. The DNS record can stay
(it harmlessly points at the relay) or be deleted in Cloudflare.
