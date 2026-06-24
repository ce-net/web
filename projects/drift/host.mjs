#!/usr/bin/env node
// DRIFT HEADLESS HOST — a benchmark-selected, server-class node that PINS authoritative
// hosting for one or more drift regions. Generalizes web/demos/coop/host.mjs.
//
// It joins each region's control room as a non-rendering, hostable, high-priority
// participant (server=true). Because it advertises a server-class score it normally
// wins the deterministic netgame election and keeps authoritative hosting fixed to this
// stable box. It loads the SAME drift-sim wasm the browser host uses (host-wasm.js) and
// runs the authoritative tick loop, streaming binary AoI StateFrames over each region's
// ephemeral /rt state room and snapshotting to /db for failover.
//
// HYBRID: this is redundancy, not a single point of failure. If it dies, the browsers
// re-elect among themselves and restore from the latest /db snapshot. Pinned-preferred,
// browser-fallback, exactly per the netgame election.
//
// Run:
//   node host.mjs --hub https://ce-net.com --regions 0:0,1:0,0:1
//   node host.mjs                                  # ce-net.com, region 0:0
//   node host.mjs --wasm ./drift_sim.wasm          # explicit sim wasm path
//
// Node 22+ has global WebSocket + fetch. On older Node: npm i ws (auto-detected).
//
// Canonical runtime: web/projects/drift/drift.js. Canonical sim wrapper: host-wasm.js.
// No emojis.

import { createDriftRuntime } from "./drift.js";
import { loadSimHost } from "./host-wasm.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---- args ----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    hub: "https://ce-net.com",
    app: "drift",
    regions: "0:0",
    id: null,
    hz: 30,
    wasm: null,
    snapshotEvery: 60,
    regionSize: 4096,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--hub") out.hub = next();
    else if (a === "--app") out.app = next();
    else if (a === "--regions" || a === "--region") out.regions = next();
    else if (a === "--id") out.id = next();
    else if (a === "--hz") out.hz = Number(next()) || out.hz;
    else if (a === "--wasm") out.wasm = next();
    else if (a === "--snapshot-every") out.snapshotEvery = Number(next()) || out.snapshotEvery;
    else if (a === "--region-size") out.regionSize = Number(next()) || out.regionSize;
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function usage() {
  console.log(
    [
      "drift headless host — pins authoritative hosting for drift regions",
      "",
      "  node host.mjs [--hub <url>] [--regions <gx:gy,...>] [--wasm <path>] [opts]",
      "",
      "  --hub             hub origin, ws(s):// or http(s)://   (default https://ce-net.com)",
      "  --app             app namespace                         (default drift)",
      "  --regions         comma list of gx:gy regions to pin    (default 0:0)",
      "  --id              stable participant id                 (default drift-host-<host>-<pid>)",
      "  --hz              authoritative tick rate               (default 30)",
      "  --wasm            path/URL to the drift-sim .wasm        (default ./drift_sim.wasm)",
      "  --snapshot-every  ticks between /db snapshots            (default 60)",
      "  --region-size     world units per region edge           (default 4096)",
      "",
      "Joins each region as a server-class, non-rendering, hostable participant so",
      "authoritative hosting pins to this machine. Ctrl-C to leave cleanly.",
    ].join("\n")
  );
}

function toHttpBase(hub) {
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
    host = (process.env.HOSTNAME || "node").split(".")[0];
  } catch (_) {}
  return "drift-host-" + host + "-" + process.pid;
}

function parseRegions(spec) {
  const out = [];
  for (const tok of String(spec).split(",")) {
    const t = tok.trim();
    if (!t) continue;
    const m = t.match(/^(-?\d+):(-?\d+)$/);
    if (m) out.push({ gx: parseInt(m[1], 10), gy: parseInt(m[2], 10) });
  }
  return out.length ? out : [{ gx: 0, gy: 0 }];
}

function resolveWasmUrl(wasmArg) {
  if (wasmArg) {
    if (/^https?:\/\//.test(wasmArg) || wasmArg.startsWith("file:")) return wasmArg;
    return "file://" + path.resolve(process.cwd(), wasmArg);
  }
  // default: a drift_sim.wasm sitting next to this file (operator drops it here, or
  // it is deployed alongside the ce-app). Built later by an operator with:
  //   (cd sim && cargo build --release --target wasm32-unknown-unknown)
  const here = path.dirname(fileURLToPath(import.meta.url));
  return "file://" + path.join(here, "drift_sim.wasm");
}

// ---- main ----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const base = toHttpBase(args.hub);
  const baseId = args.id || defaultId();
  const WS = await pickWebSocket();
  const doFetch = pickFetch();
  const regions = parseRegions(args.regions);
  const wasmUrl = resolveWasmUrl(args.wasm);

  console.log(`[drift host] app=${args.app} hub=${base} regions=${regions.map((r) => r.gx + ":" + r.gy).join(",")}`);
  console.log(`[drift host] id=${baseId} (server-class, non-rendering) wasm=${wasmUrl}`);

  // Load the sim wasm ONCE; each region runtime gets its own world handle via the
  // host factory below (drift.js calls host.newWorld(...) when this node is elected).
  let simHost;
  try {
    simHost = await loadSimHost({ url: wasmUrl, fetch: doFetch });
    console.log(`[drift host] drift-sim wasm loaded`);
  } catch (err) {
    console.error(
      "[drift host] could not load the drift-sim wasm at " + wasmUrl + ":\n  " +
        (err && err.message ? err.message : err) +
        "\n  Build it with: (cd sim && cargo build --release --target wasm32-unknown-unknown)\n" +
        "  then point --wasm at target/wasm32-unknown-unknown/release/drift_sim.wasm"
    );
    process.exit(1);
  }

  const runtimes = [];
  for (const reg of regions) {
    // One runtime per pinned region. We give each its OWN sim host object (sharing the
    // same wasm instance is unsafe across regions because the bump scratch is shared),
    // so we load a fresh instance per region for isolation.
    let regionHost = simHost;
    if (runtimes.length > 0) {
      // additional regions: fresh wasm instance to avoid scratch-arena contention
      regionHost = await loadSimHost({ url: wasmUrl, fetch: doFetch });
    }

    const rt = createDriftRuntime({
      app: args.app,
      id: baseId + "@" + reg.gx + ":" + reg.gy,
      base,
      region: reg,
      regionSize: args.regionSize,
      hz: args.hz,
      snapshotEvery: args.snapshotEvery,
      server: true, // server-class: pins authoritative hosting here
      canHost: true,
      WebSocket: WS,
      fetch: doFetch,
      // The host factory: when elected, drift.js drives this object. We hand it the
      // loaded sim wrapper directly.
      host: regionHost,
      // Headless: no local input, no rendering, no view center beyond region center.
      input: () => null,
      viewCenter: () => ({ x: reg.gx * args.regionSize + args.regionSize / 2, y: reg.gy * args.regionSize + args.regionSize / 2 }),
      onAuthFrame: () => {},
      onHostChange: (meta) => {
        const role = meta.isHost ? "HOSTING (authoritative on this node)" : "standby";
        console.log(`[drift host ${reg.gx}:${reg.gy}] host -> ${meta.host ? String(meta.host).slice(0, 12) : "?"} | ${role}`);
      },
      onRegionChange: () => {},
    });
    runtimes.push({ reg, rt });
  }

  const statusTimer = setInterval(() => {
    for (const { reg, rt } of runtimes) {
      const m = rt.metrics();
      console.log(
        `[drift host ${reg.gx}:${reg.gy}] online=${m.stateOnline} hosting=${m.isHost} ` +
          `host=${m.host ? String(m.host).slice(0, 12) : "?"} ` +
          `score=${(m.score || 0).toFixed(3)} tick=${m.tick} viewers=${m.viewers}`
      );
    }
  }, 10000);

  const shutdown = (sig) => {
    console.log(`\n[drift host] ${sig} — leaving all regions cleanly`);
    clearInterval(statusTimer);
    for (const { rt } of runtimes) {
      try { rt.leave(); } catch (_) {}
    }
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[drift host] fatal:", err && err.stack ? err.stack : err);
  process.exit(1);
});
