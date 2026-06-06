# ce-net.com — landing page

A single static file (`index.html`), no build step. Fonts load from Google Fonts; everything else is
inline. The "network online" pill pings `/health` on the same origin, so it lights up green when
served from the relay (which proxies the node's `/health`).

## Preview locally

```sh
cd site && python3 -m http.server 8000   # then open http://localhost:8000
```

(The status pill will read "unreachable" locally — there's no `/health` route — which is expected.)

## Deploy — relay nginx (current ce-net.com host)

The relay already runs nginx proxying the node API. Serve this page at `/` and keep the API routes:

```nginx
server {
    listen 80;
    server_name ce-net.com relay.ce-net.com;

    root /var/www/ce-net;          # put index.html here
    index index.html;

    # static site at /
    location = / { try_files /index.html =404; }

    # keep the node API routes working
    location /health    { proxy_pass http://127.0.0.1:8080; }
    location /bootstrap { proxy_pass http://127.0.0.1:8080; }
    location /status    { proxy_pass http://127.0.0.1:8080; }

    # serve the installer that the hero command curls
    location = /install.sh {
        proxy_pass https://raw.githubusercontent.com/ce-net/ce/main/install.sh;
    }
}
```

Push it:

```sh
ssh -i ~/.ssh/id_ed25519 root@178.105.145.170 'mkdir -p /var/www/ce-net'
scp -i ~/.ssh/id_ed25519 site/index.html root@178.105.145.170:/var/www/ce-net/
ssh -i ~/.ssh/id_ed25519 root@178.105.145.170 'nginx -t && systemctl reload nginx'
```

## Deploy — Cloudflare Pages (alternative)

ce-net.com is already behind Cloudflare. A Pages project pointed at this `site/` directory serves it
globally; route `/health`, `/bootstrap`, `/status`, `/install.sh` to the origin with a Cloudflare
Worker or by keeping those paths un-proxied to the relay. Pages wins on TTFB; nginx wins on staying
in one box with the node.

## Editing

- Palette + type are CSS variables at the top of `index.html` (`:root`).
- Accent is a single cyan→blue gradient (`--grad`) — the "Sea" motif. Change it in one place.
- Copy buttons and the live-status ping are ~20 lines of vanilla JS at the bottom.
