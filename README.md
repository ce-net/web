# ce-net — web & browser-node infrastructure

Everything behind ce-net.com that isn't the node (`ce`) or an SDK (`ce-rs`, `ce-coord`).

- **site/** — static pages: landing (`index`), in-browser node (`node`), live dashboard (`network`)
- **docs-site/** — the docs site served at docs.ce-net.com
- **ce-hub/** — Rust/axum sidecar: browser-node rendezvous (WS), task dispatch, live stats; plus `demo-wasm/`
- **deploy/** — nginx config, systemd unit, and deploy scripts for the relay


The CE Spacegame **frontends** (the shared renderer, native desktop app, and browser WASM/wgpu client)
no longer live here — they were moved out to siblings of the game backend so the whole game lives
together: `~/ce-net/spacegame` (SDK + mesh backend), `~/ce-net/spacegame-render`,
`~/ce-net/spacegame-wasm`, `~/ce-net/spacegame-native`. To play over the real mesh, run
`~/ce-net/spacegame/play.sh` — see [`spacegame/SPACEGAME-PLAY.md`](../spacegame/SPACEGAME-PLAY.md).
(The deployed browser arena page at `spa.ce-net.com` is still `demos/spacegame/`, wired into
`deploy/deploy-demos.sh`.)

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
