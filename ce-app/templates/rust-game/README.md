# rust-game

A **runnable** Rust→wasm multiplayer starter on CE: an authoritative game crate
compiled to wasm + a minimal **WebGPU** (canvas-2D fallback) frontend wired to
CE's **netgame** framework for host election, ticking, and `/db` snapshot
failover. One command takes it live.

```bash
ce-app new rust-game
cd rust-game
ce-app dev          # builds the wasm, live-uploads, prints your URL
```

Open the URL in two tabs (or two devices). One becomes the **authoritative
host**; the Rust world runs there. Kill the host tab and a new host is elected,
`ce_restore`s the latest `/db` snapshot, and play continues.

## What's in here

| File | Role |
|---|---|
| `Cargo.toml`, `src/lib.rs` | The authoritative backend crate (cdylib + rlib). The deterministic `World` and the wasm ABI (`ce_init/ce_tick/ce_x/ce_y/ce_score/ce_snapshot/ce_restore`). Identical logic on every node. |
| `index.html` | The shell: HUD + canvas + a clear "build the wasm" hint if it isn't compiled yet. |
| `game.js` | Frontend glue: loads the wasm, drives **netgame** (the host runs `ce_tick` each frame; the snapshot persisted to `/db` is the wasm byte-snapshot so failover is exact), and renders with **WebGPU**, falling back to canvas-2D. |
| `netgame.js` | Vendored copy of `@ce/client`'s netgame (host election + tick + failover). Zero install. |
| `ce-app.json` | The app slug (`project`) + room. The build variant is auto-detected from `Cargo.toml`. |

## How the pieces connect

```
 keyboard / touch ──► input bits ──► netgame ──┐
                                               ▼
                         elected HOST runs:  ce_tick(dt, inputs)   (Rust, deterministic)
                                               │
                         ce_snapshot() ──► /db (base64 bytes) ──► failover restore
                                               │
        all clients ◄── authoritative state ◄──┘  render: WebGPU / canvas-2D
```

The host is just whichever node netgame elects (lowest latency × uptime ×
benchmark, with a server bonus). No server you run — any participating tab/node
can host, and a stronger CE node will win the election and take over seamlessly.

## Toolchain

`ce-app dev` / `ce-app deploy` run a toolchain preflight and print exact install
hints if anything is missing. Manually:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack        # this template uses the wasm-pack variant
# optional, shrinks the .wasm:
#   macOS:  brew install binaryen
#   linux:  apt-get install binaryen   (provides wasm-opt)
```

Build by hand (what `ce-app` does for you):

```bash
wasm-pack build --release --target web   # -> ./pkg/rust_game.js + .wasm
```

Run the native unit tests (no wasm needed):

```bash
cargo test
```

## Make it your game

Edit `World` and `tick` in `src/lib.rs` — that's the whole game. Add fields to
the snapshot (keep it little-endian and bump the length check), extend the input
bits in both `src/lib.rs` and `game.js`, and draw your own scene in
`game.js`'s `draw()`. The networking, host election, and failover are already
done for you.

If you only need the brain (to embed in your own renderer or a native host), use
the sibling **`rust-backend`** template instead.
