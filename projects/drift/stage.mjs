#!/usr/bin/env node
// DRIFT DEPLOY STAGING — assemble a clean ./out containing ONLY the browser bundle that
// should ship to the live drift ce-app (drift.ce-net.com): index.html, drift.js, the
// netgame control plane it imports, and the built wgpu client in ./pkg (if present).
//
// This keeps the Rust source trees (sim/, client/), the Node-only headless host
// (host.mjs, host-wasm.js), and the config files OUT of the deployed app, without
// editing ce-app or the sim/client crates.
//
// Usage:
//   node stage.mjs              # build ./out
//   node stage.mjs && (cd out && ce-app deploy --app drift)
//
// No emojis.

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyFile(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

async function copyDir(src, dst) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await copyFile(s, d);
  }
}

async function main() {
  await rmrf(out);
  await fs.mkdir(out, { recursive: true });

  // 1) the page + the runtime glue
  await copyFile(path.join(here, "index.html"), path.join(out, "index.html"));
  await copyFile(path.join(here, "drift.js"), path.join(out, "drift.js"));

  // 2) drift.js imports the netgame control plane at ../../ce-app/client/netgame.js.
  //    Vendor it next to drift.js and rewrite the import so the bundle is self-contained
  //    when served from /apps/drift/ (the relative ../../ path does not exist on the hub).
  const netgameSrc = path.resolve(here, "../../ce-app/client/netgame.js");
  if (fssync.existsSync(netgameSrc)) {
    await copyFile(netgameSrc, path.join(out, "netgame.js"));
    let glue = await fs.readFile(path.join(out, "drift.js"), "utf8");
    glue = glue.replace(
      /from\s+["']\.\.\/\.\.\/ce-app\/client\/netgame\.js["']/,
      'from "./netgame.js"'
    );
    await fs.writeFile(path.join(out, "drift.js"), glue);
  } else {
    console.warn("[stage] warning: netgame.js not found at " + netgameSrc + " — drift.js import will 404 when served");
  }

  // 3) the built wgpu client, if the operator has run `trunk build` / `wasm-pack` in client/.
  //    The client owner builds it; we just ship whatever ./pkg exists. index.html probes
  //    ./pkg/drift_client.js and degrades to transport-only if absent.
  const pkg = path.join(here, "pkg");
  if (fssync.existsSync(pkg)) {
    await copyDir(pkg, path.join(out, "pkg"));
    console.log("[stage] included ./pkg (wgpu client)");
  } else {
    console.log("[stage] note: ./pkg not present — deploying transport-only (renderer loads later once built)");
  }

  // 4) the optional sim wasm a browser-host fallback could load via host-wasm.js. Only
  //    ship it if the operator dropped a prebuilt drift_sim.wasm here.
  const simWasm = path.join(here, "drift_sim.wasm");
  if (fssync.existsSync(simWasm)) {
    await copyFile(simWasm, path.join(out, "drift_sim.wasm"));
    await copyFile(path.join(here, "host-wasm.js"), path.join(out, "host-wasm.js"));
    console.log("[stage] included drift_sim.wasm + host-wasm.js (browser-host fallback enabled)");
  }

  console.log("[stage] staged ->", out);
  console.log("[stage] deploy:  (cd " + out + " && ce-app deploy --app drift)");
}

main().catch((err) => {
  console.error("[stage] fatal:", err && err.stack ? err.stack : err);
  process.exit(1);
});
