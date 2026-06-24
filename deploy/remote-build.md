# Build on the relay, not the laptop

CE builds (ce-hub, Rust->wasm apps like drift, the sim crate tests) run on the **relay**
(Hetzner, x86_64 Linux) via `deploy/ce-build.sh`, not on the dev laptop. This keeps multi-gigabyte
Rust/wasm build trees off the laptop disk, dogfoods the mesh as a build host, and — because the relay
is the same target we deploy to — makes a native build there the deploy artifact directly (no musl
cross-compile).

## The build host

`deploy/ce-build.sh` provisioned the relay once: an 8G swapfile (so a 2-core/4GB box can link big
Rust without OOM), `pkg-config`/`libssl-dev`/`binaryen` (`wasm-opt`), `rustup` with the
`wasm32-unknown-unknown` target, and `trunk`/`wasm-bindgen-cli`/`wasm-pack`. Builds happen under
`/opt/ce-build/<project>/`.

## Commands

```
bash deploy/ce-build.sh hub                          # build ce-hub natively on the relay, install + restart
bash deploy/ce-build.sh wasm projects/drift drift    # build a Rust->wasm app and deploy it to /apps/drift/
bash deploy/ce-build.sh cargo projects/drift/sim test --release   # run any cargo command on the relay
bash deploy/ce-build.sh toolchain                    # wasm toolchain install progress
```

`hub` replaces the old laptop musl cross-compile in `deploy-hub.sh`: it rsyncs `web/ce-hub` to the
relay, runs `cargo build --release` there, installs the binary to `/opt/ce-hub/ce-hub`, and restarts
the service. `wasm` rsyncs the project, runs `trunk`/`wasm-pack` on the relay, and PUTs the built
assets straight to the hub's `/apps/<id>/` from the relay (no laptop round-trip).

Source is synced with `target/`, `node_modules/`, `dist/`, `pkg/`, `.git/`, and the laptop-absolute
`.cargo/` excluded (so cargo on the relay uses its own `./target`).

## Next step (deeper dogfood)

Today this is rsync + ssh to the relay. The mesh-native version is to dispatch the build as a CE
compute task placed by the benchmark/latency system onto the best build-capable node (the relay is
just the first such node), with the artifact published to `/apps/<id>/` and `/blobs`. `ce-app` should
grow a `--remote` build flag that calls this path.
