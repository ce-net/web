# rust-backend

The **authoritative game-state crate**, compiled to wasm. This is the single
source of truth for a multiplayer game: the same logic runs identically on every
node, CE's netgame framework elects one host that calls `tick` each frame, and
state survives host failover through `snapshot` / `restore` to the hub's `/db`.

It depends on **nothing** — it builds with plain `cargo` and with `wasm-pack`,
and the `rlib` crate-type lets a native host (a server, or a `drift-sim`-style
harness) link the exact same logic.

## The contract

Pure-Rust API (use it from native code or tests):

```rust
let mut w = World::default();
w.tick(1.0 / 60.0, input::UP | input::FIRE); // advance one frame
let snap = w.snapshot();                       // -> Vec<u8>  (for /db)
let mut w2 = World::default();
w2.restore(&snap);                             // new host adopts the snapshot
```

wasm ABI (raw exports over linear memory — no wasm-bindgen):

| Export | Meaning |
|---|---|
| `ce_init()` | reset to a fresh world |
| `ce_tick(dt: f32, input: u32)` | advance by `dt` seconds with the input bitset |
| `ce_x()` / `ce_y()` / `ce_score()` / `ce_current_tick()` | read state for rendering |
| `ce_snapshot_len() -> u32` | build a snapshot, return its byte length |
| `ce_snapshot_ptr() -> *const u8` | pointer to the snapshot bytes in wasm memory |
| `ce_scratch_ptr(len) -> *mut u8` | reserve a buffer to copy snapshot bytes into |
| `ce_restore(len) -> u32` | restore from the scratch buffer (1 = ok) |

Input bits: `UP=1, DOWN=2, LEFT=4, RIGHT=8, FIRE=16` (see `input` module).

## Build

```bash
# wasm-pack (ESM glue in ./pkg):
wasm-pack build --release --target web

# or raw cargo:
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
wasm-opt -Oz -o app.wasm target/wasm32-unknown-unknown/release/rust_backend.wasm

# or via ce-app (auto-detects the variant, builds, uploads, signs writes):
ce-app deploy
```

Run the native tests (no wasm toolchain needed):

```bash
cargo test
```

## Where it fits

`rust-backend` has no frontend — it is the brain only. Pair it with any renderer.
The sibling **`rust-game`** template ships a minimal wgpu/canvas frontend already
wired to this exact ABI and to CE netgame for host election + failover. Scaffold
either with:

```bash
ce-app new rust-backend
ce-app new rust-game
```
