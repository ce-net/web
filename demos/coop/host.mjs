#!/usr/bin/env node
// coop authoritative host — MOVED.
//
// coop is no longer hosted by a browser-elected netgame participant over a central
// hub (ce-net.com /rt + /db). The authoritative simulation now runs in the
// dedicated Rust backend `game-coop`, which connects to the LOCAL CE node and hosts
// the room over the mesh (gossipsub pubsub on ce-game/coop/<room>/{in,state}).
//
// To host a room, run the backend instead of this script:
//
//   # requires a local CE node: `ce start`
//   cargo run -p game-coop -- --room g1
//
// See:
//   game-coop/                 the authoritative backend crate (sim + mesh loop)
//   web/demos/coop/README.md   how the client talks to it over the mesh

console.error(
  [
    "coop is now hosted by the `game-coop` Rust backend over the CE mesh, not this script.",
    "",
    "Run the authoritative host with:",
    "  cargo run -p game-coop -- --room g1   (needs a local `ce start`)",
    "",
    "Details: game-coop/README.md and web/demos/coop/README.md",
  ].join("\n"),
);
process.exit(1);
