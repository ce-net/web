# ce-net — web & browser-node infrastructure

Everything behind ce-net.com that isn't the node (`ce`) or an SDK (`ce-rs`, `ce-coord`).

- **site/** — static pages: landing (`index`), in-browser node (`node`), live dashboard (`network`)
- **docs-site/** — the docs site served at docs.ce-net.com
- **ce-hub/** — Rust/axum sidecar: browser-node rendezvous (WS), task dispatch, live stats; plus `demo-wasm/`
- **deploy/** — nginx config, systemd unit, and deploy scripts for the relay

## Live
| URL | What |
|---|---|
| https://ce-net.com | landing |
| https://ce-net.com/node | run a node in your browser (iOS + Android) |
| https://ce-net.com/network | live mesh + aggregate compute dashboard |
| https://docs.ce-net.com | docs |

## Push a compute task to the mesh
```
curl -X POST https://ce-net.com/hub/tasks -H 'content-type: application/json' \
  -d '{"func":"count_primes","args":[200000]}'
```

## Deploy (relay key in ssh-agent)
```
bash deploy/deploy.sh        # pages + nginx
# build the hub, then ship it:
(cd ce-hub && cargo zigbuild --release --target x86_64-unknown-linux-musl)
bash deploy/deploy-hub.sh
```
