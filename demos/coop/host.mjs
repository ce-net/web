#!/usr/bin/env node
// CE NETGAME — headless hostable participant for the "coop" arena.
//
// Joins the realtime room as a NON-rendering, hostable participant (canHost=true,
// high priority) so a dedicated node/operator can PIN authoritative hosting to a
// stable machine. It speaks the exact same wire protocol as every browser client,
// so it competes in the same deterministic election; because it advertises a high,
// server-class score it normally wins and keeps hosting fixed to this box. If it
// dies, the browsers simply re-elect and restore from the /db snapshot — the
// headless host is redundancy, not a single point of failure.
//
// Run:
//   node host.mjs --hub wss://ce-net.com --room g1
//   node host.mjs --hub https://ce-net.com           # http(s) is accepted too
//   node host.mjs                                     # defaults to ce-net.com / g1
//
// Node 22+ has a global WebSocket and fetch — no dependencies. On older Node,
// install the `ws` package (npm i ws) and it is picked up automatically.
//
// Canonical framework source: web/ce-app/client/netgame.js
// This runner imports it as a sibling module: ../../ce-app/client/netgame.js

import { createGame } from "../../ce-app/client/netgame.js";

// ---- args ----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { hub: "wss://ce-net.com", room: "g1", app: "coop", id: null, hz: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--hub") out.hub = next();
    else if (a === "--room") out.room = next();
    else if (a === "--app") out.app = next();
    else if (a === "--id") out.id = next();
    else if (a === "--hz") out.hz = Number(next()) || out.hz;
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function usage() {
  console.log(
    [
      "CE netgame headless host (coop)",
      "",
      "  node host.mjs [--hub <url>] [--room <room>] [--app <app>] [--id <id>] [--hz <n>]",
      "",
      "  --hub   hub origin, ws(s):// or http(s)://   (default wss://ce-net.com)",
      "  --room  room / shard                          (default g1)",
      "  --app   app namespace                         (default coop)",
      "  --id    stable participant id                 (default ce-host-<host>-<pid>)",
      "  --hz    authoritative tick rate               (default 20)",
      "",
      "Joins as a non-rendering, hostable, high-priority participant so authoritative",
      "hosting pins to this machine. Ctrl-C to leave cleanly.",
    ].join("\n")
  );
}

// ---- environment: base origin (http/https) for fetch + WebSocket ctor --------------

function toHttpBase(hub) {
  // The framework derives the ws URL from the http base, so hand it an http(s) origin.
  let u = String(hub || "").trim().replace(/\/+$/, "");
  if (u.startsWith("wss://")) u = "https://" + u.slice("wss://".length);
  else if (u.startsWith("ws://")) u = "http://" + u.slice("ws://".length);
  else if (!/^https?:\/\//.test(u)) u = "https://" + u;
  return u;
}

async function pickWebSocket() {
  if (typeof globalThis.WebSocket !== "undefined") return globalThis.WebSocket;
  try {
    const mod = await import("ws");
    return mod.default || mod.WebSocket || mod;
  } catch (_) {
    console.error(
      "No global WebSocket (need Node 22+) and the 'ws' package is not installed.\n" +
        "Either run on Node 22+, or: npm i ws"
    );
    process.exit(1);
  }
}

function pickFetch() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  console.error("No global fetch (need Node 18+/22+). Upgrade Node.");
  process.exit(1);
  return null;
}

function defaultId() {
  let host = "node";
  try {
    // optional: a nicer label if os is available; never required.
    // eslint-disable-next-line no-undef
    host = (process.env.HOSTNAME || "node").split(".")[0];
  } catch (_) {}
  return "ce-host-" + host + "-" + process.pid;
}

// ---- main ----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const base = toHttpBase(args.hub);
  const id = args.id || defaultId();
  const WS = await pickWebSocket();
  const doFetch = pickFetch();

  console.log(`[coop host] app=${args.app} room=${args.room} hub=${base}`);
  console.log(`[coop host] id=${id} (hostable, non-rendering)`);

  // A headless host has no input and never renders. It only hosts: when elected, it
  // runs the authoritative tick loop, broadcasts state, and snapshots to /db. The
  // game's own tick() lives in the browser app (index.html); a pure relay-pinned
  // host that should mirror that logic can paste the same tick() here. For now this
  // runner provides a neutral, side-effect-free tick so the room stays authoritative
  // and snapshots keep flowing even with zero browsers connected.
  //
  // NOTE: to make this box simulate the FULL coop game, copy the tick() (and init())
  // from web/demos/coop/index.html into the opts below — the wire protocol is shared,
  // so a headless host running the identical tick is indistinguishable from a browser
  // host, only more stable. Keeping them in one file is the canonical approach; this
  // runner stays game-agnostic on purpose.
  const game = createGame({
    app: args.app,
    room: args.room,
    id,
    hz: args.hz,
    base,
    WebSocket: WS,
    fetch: doFetch,
    canHost: true,
    server: true, // advertise server-class so we beat browsers in the election
    // High, stable score so a dedicated host pins authoritative play here. We still
    // let the framework refine this from /nodes if this id is a registered mesh node.
    hostScore: null,
    init: () => ({ players: {}, shots: [], scores: {}, tick: 0 }),
    // Game-agnostic keep-alive tick: advance a counter and pass state through. Replace
    // with the coop tick() to fully simulate the arena headlessly (see note above).
    tick: (state, _inputs, _dt, ctx) => {
      const s = state || { players: {}, shots: [], scores: {}, tick: 0 };
      s.tick = ctx.tick;
      return s;
    },
    // No rendering on a headless node.
    onState: () => {},
    onHostChange: (meta) => {
      const role = meta.isHost ? "HOSTING (authoritative on this node)" : "standby";
      console.log(
        `[coop host] host -> ${meta.hostShort || meta.host || "?"}  | ${role}`
      );
    },
  });

  // Periodic status line so an operator can see it is alive and whether it is hosting.
  const statusTimer = setInterval(() => {
    const m = game.metrics();
    console.log(
      `[coop host] online=${m.online} hosting=${m.isHost} ` +
        `host=${m.host ? String(m.host).slice(0, 8) : "?"} ` +
        `score=${(m.score || 0).toFixed(3)} tick=${m.tick} ` +
        `players=${game.players().length}`
    );
  }, 10000);

  const shutdown = (sig) => {
    console.log(`\n[coop host] ${sig} — leaving room cleanly`);
    clearInterval(statusTimer);
    try {
      game.leave();
    } catch (_) {}
    // give the bye frame a moment to flush
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[coop host] fatal:", err && err.stack ? err.stack : err);
  process.exit(1);
});
