#!/usr/bin/env node
// debug.mjs — read-only observability verbs for ce-app: doctor / logs / trace.
//
// WHY this is a separate file: ce-app.mjs is owned by another agent. This module
// is additive — it exports the three command handlers so ce-app.mjs can wire them
// in with three switch cases (see the one-line wire-up in the report), AND it is
// directly runnable on its own:
//
//   node bin/debug.mjs doctor
//   node bin/debug.mjs logs   <app>
//   node bin/debug.mjs trace  <app>
//
// Everything here is READ-ONLY against the LIVE hub: it never mutates app files,
// db, domains, or limits. `trace` writes one throwaway probe file under a reserved
// __trace/ prefix of an app you already own and deletes it again — opt-in via a
// flag — so the default verbs touch nothing.
//
// It reuses the SAME single-identity model and canonical signing scheme as
// ce-app.mjs (header x-ce-id / x-ce-sig / x-ce-ts / x-ce-nonce over
// METHOD\nPATH\nts\nnonce\nsha256(body)). It deliberately re-implements a small,
// dependency-free copy of identity resolution + signing rather than importing the
// (currently un-exported) internals of ce-app.mjs, so it stays decoupled and can
// not break the deploy path. If ce-app.mjs later exports those helpers, this file
// can switch to importing them with no behavior change.
//
// No third-party deps. Node 22+ has global fetch + WebSocket; on Node <22 the ws
// verbs (logs, the room checks in doctor) degrade gracefully with a clear note.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DEFAULT_HUB = "https://ce-net.com";

// The conventional debug room every app may publish structured frames to. A debug
// viewer (this CLI's `logs`, or site/debug.html) joins it read-only and prints
// whatever the app emits. See web/docs/debug.md for the frame schema.
const DEBUG_ROOM = "__debug";

// ---------------------------------------------------------------------------
// tiny arg parsing (mirrors ce-app.mjs flags so the two share a mental model)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    _: [],
    hub: process.env.CE_HUB || DEFAULT_HUB,
    app: undefined,
    project: undefined,
    json: false,
    follow: true,
    timeout: undefined,
    write: false, // trace: allow the throwaway round-trip probe write
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--hub") opts.hub = argv[++i];
    else if (a.startsWith("--hub=")) opts.hub = a.slice("--hub=".length);
    else if (a === "--app") opts.app = argv[++i];
    else if (a.startsWith("--app=")) opts.app = a.slice("--app=".length);
    else if (a === "--project") opts.project = argv[++i];
    else if (a.startsWith("--project=")) opts.project = a.slice("--project=".length);
    else if (a === "--json") opts.json = true;
    else if (a === "--no-follow" || a === "--once") opts.follow = false;
    else if (a === "--write") opts.write = true;
    else if (a === "--timeout") opts.timeout = Number(argv[++i]);
    else if (a.startsWith("--timeout=")) opts.timeout = Number(a.slice("--timeout=".length));
    else opts._.push(a);
  }
  if (opts.hub) opts.hub = String(opts.hub).replace(/\/+$/, "");
  return opts;
}

function hubHost(hub) {
  try {
    return new URL(hub).host;
  } catch (_) {
    return String(hub).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function httpToWs(base) {
  if (base.startsWith("https:")) return "wss:" + base.slice("https:".length);
  if (base.startsWith("http:")) return "ws:" + base.slice("http:".length);
  return base;
}

// ---------------------------------------------------------------------------
// identity — ONE identity per person, reused (same resolution as ce-app.mjs).
//   (1) the CE node identity via `ce id` (secret key at
//       ~/.local/share/ce/identity/node.key), else
//   (2) one local Ed25519 keypair at ~/.ce/identity.
// This module NEVER mints a new id; if a local keypair does not yet exist it
// reports that (doctor) rather than silently creating one — creation is the
// deploy path's job, not the observability path's.
// ---------------------------------------------------------------------------

function ceHomeDir() {
  return path.join(os.homedir(), ".ce");
}
function ceNodeKeyPath() {
  return path.join(os.homedir(), ".local", "share", "ce", "identity", "node.key");
}
function localIdentityKeyPath() {
  return path.join(ceHomeDir(), "identity", "node.key");
}

function tryCeNodeId() {
  try {
    const r = spawnSync(process.platform === "win32" ? "ce.cmd" : "ce", ["id"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status !== 0 || !r.stdout) return null;
    const line = r.stdout.split(/\r?\n/).find((l) => /node\s*id/i.test(l));
    const m = (line || r.stdout).match(/[0-9a-fA-F]{16,}/);
    return m ? m[0].toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

function ed25519SeedToPkcs8(seed32) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return Buffer.concat([prefix, Buffer.from(seed32)]);
}

function rawEd25519PubHex(publicKeyObj) {
  const jwk = publicKeyObj.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

async function tryLoadEd25519Secret(file) {
  let buf;
  try {
    buf = await fs.readFile(file);
  } catch (_) {
    return null;
  }
  const attempts = [];
  attempts.push(() => crypto.createPrivateKey({ key: buf, format: "der", type: "pkcs8" }));
  attempts.push(() => crypto.createPrivateKey({ key: buf.toString("utf8"), format: "pem", type: "pkcs8" }));
  if (buf.length === 32) {
    attempts.push(() => crypto.createPrivateKey({ key: ed25519SeedToPkcs8(buf), format: "der", type: "pkcs8" }));
  }
  for (const make of attempts) {
    try {
      const secretKey = make();
      if (secretKey.asymmetricKeyType !== "ed25519") continue;
      const publicKey = crypto.createPublicKey(secretKey);
      return { secretKey, publicKey, publicKeyHex: rawEd25519PubHex(publicKey) };
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

let _identityCache = null;

// Resolve the single identity WITHOUT minting anything. Returns:
//   { id, source, publicKey, signer, keyPath, signable }
// `signable` is false when we know the id but hold no secret key (signing off,
// identity still reported). `id` is null only if nothing at all could be found.
async function resolveIdentity() {
  if (_identityCache) return _identityCache;

  const ceId = tryCeNodeId();
  if (ceId) {
    const loaded = await tryLoadEd25519Secret(ceNodeKeyPath());
    _identityCache = {
      id: ceId,
      source: loaded ? "ce-node" : "ce-node (no local key)",
      publicKey: loaded ? loaded.publicKeyHex : ceId,
      signer: loaded ? makeSigner(loaded.secretKey) : null,
      keyPath: loaded ? ceNodeKeyPath() : null,
      signable: !!loaded,
    };
    return _identityCache;
  }

  const kp = await tryLoadEd25519Secret(localIdentityKeyPath());
  if (kp) {
    const id = crypto.createHash("sha256").update(Buffer.from(kp.publicKeyHex, "hex")).digest("hex");
    _identityCache = {
      id,
      source: "local-keypair",
      publicKey: kp.publicKeyHex,
      signer: makeSigner(kp.secretKey),
      keyPath: localIdentityKeyPath(),
      signable: true,
    };
    return _identityCache;
  }

  // Nothing yet — observability must not create one. Report absence.
  _identityCache = {
    id: null,
    source: "none",
    publicKey: null,
    signer: null,
    keyPath: localIdentityKeyPath(),
    signable: false,
  };
  return _identityCache;
}

function makeSigner(secretKey) {
  return (canonicalString) => {
    const sig = crypto.sign(null, Buffer.from(canonicalString, "utf8"), secretKey);
    return Buffer.from(sig).toString("hex");
  };
}

function nodePrefix(id) {
  return String(id || "").toLowerCase().slice(0, 10);
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf == null ? Buffer.alloc(0) : buf).digest("hex");
}

// Build the canonical signed headers (same scheme as ce-app.mjs). Returns {} when
// unsignable so a request stays a valid anonymous request.
async function signedHeaders(method, urlOrPath, body) {
  const ident = await resolveIdentity();
  if (!ident || !ident.signer) return {};
  let pathOnly = String(urlOrPath);
  try {
    const u = new URL(urlOrPath);
    pathOnly = u.pathname + (u.search || "");
  } catch (_) {
    /* already a path */
  }
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString("hex");
  const bodyBuf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const canonical = [method.toUpperCase(), pathOnly, ts, nonce, sha256Hex(bodyBuf)].join("\n");
  let sig;
  try {
    sig = ident.signer(canonical);
  } catch (_) {
    return {};
  }
  return { "x-ce-id": ident.publicKey, "x-ce-sig": sig, "x-ce-ts": ts, "x-ce-nonce": nonce };
}

async function signedFetch(url, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  const mutating = method === "PUT" || method === "POST" || method === "DELETE" || method === "PATCH";
  if (!mutating) return fetch(url, init);
  let extra = {};
  try {
    extra = await signedHeaders(method, url, init.body);
  } catch (_) {
    extra = {};
  }
  return fetch(url, { ...init, headers: { ...(init.headers || {}), ...extra } });
}

// ---------------------------------------------------------------------------
// app-id resolution — same precedence as ce-app.mjs:
//   --app  >  ./.ce/app-id  >  "<project>-<nodeprefix>"
// where <project> is --project / package.json name / dir name.
// ---------------------------------------------------------------------------

function dnsLabelPart(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (_) {
    return null;
  }
}

async function resolveProjectName(cwd, override) {
  if (override && String(override).trim()) return dnsLabelPart(override);
  const ceApp = await readJsonSafe(path.join(cwd, "ce-app.json"));
  if (ceApp && (ceApp.project || ceApp.name)) return dnsLabelPart(ceApp.project || ceApp.name);
  const pkg = await readJsonSafe(path.join(cwd, "package.json"));
  if (pkg && pkg.name) return dnsLabelPart(pkg.name);
  return dnsLabelPart(path.basename(cwd) || "app");
}

async function resolveAppId(cwd, opts) {
  if (opts.app) return opts.app;
  if (opts._[1]) return opts._[1]; // positional <app> wins for the debug verbs
  try {
    const pinned = (await fs.readFile(path.join(cwd, ".ce", "app-id"), "utf8")).trim();
    if (pinned) return pinned;
  } catch (_) {
    /* no pin */
  }
  const ident = await resolveIdentity();
  const project = await resolveProjectName(cwd, opts.project);
  if (!ident.id) return project; // last resort: bare project name
  return `${project}-${nodePrefix(ident.id)}`;
}

// ---------------------------------------------------------------------------
// small ws helper — open a room, get a frame callback. Resolves to a handle with
// .close(). Degrades: if no WebSocket is available, throws a clear, catchable err.
// ---------------------------------------------------------------------------

function pickWebSocket() {
  if (typeof WebSocket !== "undefined") return WebSocket;
  if (typeof globalThis !== "undefined" && globalThis.WebSocket) return globalThis.WebSocket;
  throw new Error("no WebSocket available (Node <22). Install/run on Node 22+ for live room verbs.");
}

function openRoom(hub, app, room, { onFrame, onOpen, onClose, query = "" } = {}) {
  const WS = pickWebSocket();
  const url = httpToWs(hub) + "/rt/" + encodeURIComponent(app) + "/" + encodeURIComponent(room) + query;
  const ws = new WS(url);
  ws.addEventListener("open", () => onOpen && onOpen());
  ws.addEventListener("message", (ev) => {
    let frame;
    try {
      frame = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch (_) {
      frame = { t: "raw", text: typeof ev.data === "string" ? ev.data : "[binary]" };
    }
    try {
      onFrame && onFrame(frame);
    } catch (_) {
      /* never let one frame crash the loop */
    }
  });
  ws.addEventListener("close", () => onClose && onClose());
  ws.addEventListener("error", () => {});
  return { ws, close: () => { try { ws.close(); } catch (_) {} } };
}

// Probe whether a room is reachable: open, wait briefly for the socket to open,
// then close. Resolves { reachable, ms } — does not send anything.
function probeRoom(hub, app, room, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const t0 = Date.now();
    let handle;
    const finish = (reachable) => {
      if (done) return;
      done = true;
      if (handle) handle.close();
      resolve({ reachable, ms: Date.now() - t0 });
    };
    try {
      handle = openRoom(hub, app, room, {
        onOpen: () => finish(true),
        onClose: () => finish(false),
      });
    } catch (e) {
      resolve({ reachable: false, ms: 0, error: e.message });
      return;
    }
    setTimeout(() => finish(false), timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// hub probes (all read-only)
// ---------------------------------------------------------------------------

async function getJson(url, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json().catch(() => null);
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

async function headApp(hub, app, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${hub}/apps/${encodeURIComponent(app)}/`, { signal: ctl.signal });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

// /apps/:id/__reload emits the current version immediately, then on each bump.
// We read exactly one event and return the version, so doctor/trace can report
// the live hot-reload version without a websocket.
function readReloadVersion(hub, app, ms = 5000) {
  return new Promise((resolve) => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      ctl.abort();
      resolve({ ok: false, reason: "timeout" });
    }, ms);
    fetch(`${hub}/apps/${encodeURIComponent(app)}/__reload`, {
      signal: ctl.signal,
      headers: { accept: "text/event-stream" },
    })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          clearTimeout(t);
          ctl.abort();
          return resolve({ ok: false, status: res.status });
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        // Read until we see one SSE data: line.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const m = buf.match(/data:\s*(\S+)/);
          if (m) {
            clearTimeout(t);
            ctl.abort();
            return resolve({ ok: true, version: m[1] });
          }
        }
        clearTimeout(t);
        resolve({ ok: false, reason: "closed" });
      })
      .catch((e) => {
        clearTimeout(t);
        resolve({ ok: false, error: e.message });
      });
  });
}

async function getStats(hub) {
  // Apex /hub/stats first (richest), then /stats. Both share the same shape.
  for (const p of ["/hub/stats", "/stats"]) {
    const r = await getJson(`${hub}${p}`);
    if (r.ok && r.data) return { ...r, path: p };
  }
  return { ok: false };
}

async function getAppDebug(hub, app) {
  return getJson(`${hub}/apps/${encodeURIComponent(app)}/debug`);
}

async function getDbList(hub, app) {
  return getJson(`${hub}/db/${encodeURIComponent(app)}?limit=1000`);
}

// ---------------------------------------------------------------------------
// formatting helpers (no color libs; plain ANSI, auto-off when not a TTY)
// ---------------------------------------------------------------------------

const TTY = process.stdout.isTTY;
const C = {
  dim: (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s),
  ok: (s) => (TTY ? `\x1b[32m${s}\x1b[0m` : s),
  bad: (s) => (TTY ? `\x1b[31m${s}\x1b[0m` : s),
  warn: (s) => (TTY ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (TTY ? `\x1b[36m${s}\x1b[0m` : s),
  bold: (s) => (TTY ? `\x1b[1m${s}\x1b[0m` : s),
};

function mark(state) {
  if (state === "ok") return C.ok("ok  ");
  if (state === "warn") return C.warn("warn");
  if (state === "fail") return C.bad("fail");
  return C.dim("--  ");
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${Math.round(n * 10) / 10} ${u[i]}`;
}

function pct(used, max) {
  if (!max) return 0;
  return Math.round((Number(used) / Number(max)) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// doctor — end-to-end health: identity, hub, app, room, limits headroom.
// Returns a structured result; prints a human report unless --json.
// ---------------------------------------------------------------------------

async function cmdDoctor(opts) {
  const hub = opts.hub;
  const cwd = process.cwd();
  const checks = [];
  const add = (name, state, detail) => checks.push({ name, state, detail });

  // 1) identity present
  const ident = await resolveIdentity();
  if (ident.id && ident.signable) {
    add("identity", "ok", `${ident.source} · id ${ident.id.slice(0, 16)}… · signing on`);
  } else if (ident.id) {
    add("identity", "warn", `${ident.source} · id ${ident.id.slice(0, 16)}… · NO secret key (anonymous writes)`);
  } else {
    add("identity", "fail", "no CE node id and no local keypair (run `ce-app whoami` once to create one)");
  }

  // 2) hub reachable
  const stats = await getStats(hub);
  if (stats.ok) {
    const d = stats.data;
    add("hub reachable", "ok", `${hubHost(hub)} · ${d.nodes ?? "?"} nodes · ${fmtBytes(d.data_used_bytes)} used`);
  } else {
    add("hub reachable", "fail", `${hubHost(hub)} did not answer ${stats.path || "/stats"}`);
  }

  // 3) app deployed
  const app = await resolveAppId(cwd, opts);
  const dbg = await getAppDebug(hub, app);
  let deployed = false;
  if (dbg.ok && dbg.data && Number(dbg.data.version) > 0) {
    deployed = true;
    add(
      "app deployed",
      "ok",
      `${app} · v${dbg.data.version} · ${fmtBytes(dbg.data.bytes)} · ${dbg.data.requests ?? 0} reqs · ${dbg.data.errors ?? 0} errs`
    );
  } else {
    const head = await headApp(hub, app);
    if (head.ok) {
      deployed = true;
      add("app deployed", "ok", `${app} · served (no debug counters yet)`);
    } else {
      add("app deployed", "warn", `${app} · not hosted yet (deploy with \`ce-app deploy\`)`);
    }
  }

  // 3b) hot-reload channel
  const reload = await readReloadVersion(hub, app, 5000);
  if (reload.ok) add("hot-reload", "ok", `__reload stream live · version ${reload.version}`);
  else if (deployed) add("hot-reload", "warn", "no __reload event within 5s");
  else add("hot-reload", "--", "skipped (app not deployed)");

  // 4) main room reachable + 4b debug room reachable
  let wsAvailable = true;
  try {
    pickWebSocket();
  } catch (_) {
    wsAvailable = false;
  }
  if (!wsAvailable) {
    add("rooms", "warn", "WebSocket unavailable (Node <22) — room checks skipped");
  } else {
    const main = await probeRoom(hub, app, "main", 4000);
    add("room /rt/main", main.reachable ? "ok" : "warn", main.reachable ? `connected in ${main.ms}ms` : "could not connect");
    const drm = await probeRoom(hub, app, DEBUG_ROOM, 4000);
    add(
      `room /rt/${DEBUG_ROOM}`,
      drm.reachable ? "ok" : "warn",
      drm.reachable ? `connected in ${drm.ms}ms` : "could not connect"
    );
  }

  // 5) limits headroom
  if (stats.ok && stats.data && stats.data.limits) {
    const d = stats.data;
    const usedPct = pct(d.data_used_bytes, d.limits.max_data_bytes);
    const appsPct = pct(d.hosted_apps, d.limits.max_apps);
    const state = usedPct >= 90 || appsPct >= 90 ? "warn" : "ok";
    add(
      "limits headroom",
      state,
      `data ${usedPct}% of ${fmtBytes(d.limits.max_data_bytes)} · apps ${d.hosted_apps}/${d.limits.max_apps}`
    );
  } else {
    add("limits headroom", "--", "no limits in /stats");
  }

  const failed = checks.filter((c) => c.state === "fail").length;
  const warned = checks.filter((c) => c.state === "warn").length;
  const result = { app, hub, ok: failed === 0, failed, warned, checks };

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result;
  }

  console.log(C.bold("ce-app doctor"));
  console.log(C.dim(`hub ${hub}  ·  app ${app}\n`));
  for (const c of checks) {
    console.log(`  ${mark(c.state)}  ${c.name.padEnd(18)} ${C.dim(c.detail)}`);
  }
  console.log("");
  if (failed) console.log(C.bad(`${failed} check(s) failed`) + (warned ? C.warn(`, ${warned} warning(s)`) : ""));
  else if (warned) console.log(C.warn(`all critical checks passed, ${warned} warning(s)`));
  else console.log(C.ok("all checks passed"));
  return result;
}

// ---------------------------------------------------------------------------
// logs — subscribe to /rt/<app>/__debug and print structured frames as they
// arrive. Read-only: it never publishes. By the room's relay semantics it sees
// frames from OTHER clients plus replayed history, never its own (it sends none).
// ---------------------------------------------------------------------------

function fmtLogFrame(f, opts) {
  if (opts.json) return JSON.stringify(f);
  const t = (f.t || f.type || "log").toString();
  const ts = f.ts ? new Date(Number(f.ts)).toISOString().slice(11, 23) : new Date().toISOString().slice(11, 23);
  const lvl = (f.level || f.lvl || (t === "error" ? "error" : "info")).toString();
  const tag = C.dim(ts) + " ";
  if (t === "trace" || t === "span") {
    const name = f.name || f.span || "span";
    const dur = f.ms != null ? `${f.ms}ms` : f.dur != null ? `${f.dur}ms` : "";
    return tag + C.cyan(`[trace] ${name}`) + (dur ? " " + C.dim(dur) : "") + (f.detail ? " " + f.detail : "");
  }
  if (t === "metric") {
    return tag + C.cyan(`[metric] ${f.name || "?"}=`) + String(f.value ?? "");
  }
  const color = lvl === "error" ? C.bad : lvl === "warn" ? C.warn : (s) => s;
  const msg = f.msg != null ? f.msg : f.message != null ? f.message : JSON.stringify(f);
  const who = f.from || f.src ? C.dim(`(${f.from || f.src}) `) : "";
  return tag + color(`[${lvl}]`) + " " + who + msg;
}

async function cmdLogs(opts) {
  const hub = opts.hub;
  const cwd = process.cwd();
  const app = await resolveAppId(cwd, opts);
  let wsOk = true;
  try {
    pickWebSocket();
  } catch (e) {
    wsOk = false;
    console.error(C.bad("logs: ") + e.message);
    return { ok: false, reason: "no-websocket" };
  }
  if (!wsOk) return { ok: false };

  if (!opts.json) {
    console.log(C.dim(`subscribing to /rt/${app}/${DEBUG_ROOM} — apps publish JSON frames here`));
    console.log(C.dim(`(read-only; Ctrl-C to stop)\n`));
  }

  return new Promise((resolve) => {
    let count = 0;
    const handle = openRoom(hub, app, DEBUG_ROOM, {
      onOpen: () => {
        if (!opts.json) console.log(C.ok("connected") + C.dim(` — replaying recent history, then live\n`));
      },
      onFrame: (f) => {
        count++;
        console.log(fmtLogFrame(f, opts));
      },
      onClose: () => {
        if (!opts.json) console.log(C.dim(`\nroom closed (${count} frames)`));
        resolve({ ok: true, frames: count });
      },
    });

    // --once / --no-follow: drain history for a short window then exit.
    if (opts.follow === false) {
      const ms = opts.timeout || 2500;
      setTimeout(() => {
        handle.close();
        resolve({ ok: true, frames: count });
      }, ms);
    } else {
      const onSig = () => {
        handle.close();
        if (!opts.json) console.log(C.dim(`\nstopped (${count} frames)`));
        resolve({ ok: true, frames: count });
      };
      process.once("SIGINT", onSig);
      process.once("SIGTERM", onSig);
    }
  });
}

// ---------------------------------------------------------------------------
// trace — time a deploy-shaped round-trip so you can see where latency lives:
//   hub stat -> app HEAD -> __reload version -> (optional) write+serve+delete
//   a single throwaway probe file under __trace/ (signed; --write to enable).
// Default (no --write) traces only read-side timings and touches nothing.
// ---------------------------------------------------------------------------

async function timed(label, fn) {
  const t0 = Date.now();
  let ok = true;
  let extra = "";
  try {
    const r = await fn();
    if (r && r.ok === false) ok = false;
    if (r && r.note) extra = r.note;
  } catch (e) {
    ok = false;
    extra = e.message;
  }
  return { label, ms: Date.now() - t0, ok, extra };
}

async function cmdTrace(opts) {
  const hub = opts.hub;
  const cwd = process.cwd();
  const app = await resolveAppId(cwd, opts);
  const ident = await resolveIdentity();
  const steps = [];

  steps.push(
    await timed("stats", async () => {
      const r = await getStats(hub);
      return { ok: r.ok };
    })
  );
  steps.push(
    await timed("app HEAD", async () => {
      const r = await headApp(hub, app);
      return { ok: r.ok, note: r.ok ? "" : `status ${r.status || "?"}` };
    })
  );
  steps.push(
    await timed("__reload version", async () => {
      const r = await readReloadVersion(hub, app, 5000);
      return { ok: r.ok, note: r.ok ? `v${r.version}` : r.reason || r.error || "" };
    })
  );

  // Optional full write round-trip: PUT a tiny signed probe, GET it back, DELETE.
  if (opts.write) {
    if (!ident.signable) {
      steps.push({ label: "write probe", ms: 0, ok: false, extra: "no secret key — cannot sign the probe write" });
    } else {
      const probeRel = `__trace/probe-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`;
      const body = `ce-app trace ${new Date().toISOString()}`;
      const url = `${hub}/apps/${encodeURIComponent(app)}/${probeRel}`;
      steps.push(
        await timed("write probe (PUT)", async () => {
          const res = await signedFetch(url, { method: "PUT", headers: { "content-type": "text/plain" }, body });
          return { ok: res.ok, note: res.ok ? probeRel : `status ${res.status}` };
        })
      );
      steps.push(
        await timed("read probe (GET)", async () => {
          const res = await fetch(url);
          const txt = res.ok ? await res.text() : "";
          return { ok: res.ok && txt === body, note: res.ok ? "" : `status ${res.status}` };
        })
      );
      // best-effort cleanup of the throwaway file (db delete style not available
      // for app files; we overwrite with empty + note). Apps may sweep __trace/.
      steps.push(
        await timed("cleanup probe (empty)", async () => {
          const res = await signedFetch(url, { method: "PUT", headers: { "content-type": "text/plain" }, body: "" });
          return { ok: res.ok, note: res.ok ? "" : `status ${res.status}` };
        })
      );
    }
  }

  const total = steps.reduce((a, s) => a + s.ms, 0);
  const result = { app, hub, total_ms: total, wrote: !!opts.write, steps };

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result;
  }

  console.log(C.bold("ce-app trace") + C.dim(`  ${app}  via ${hubHost(hub)}`));
  if (!opts.write) console.log(C.dim("read-side round-trip (pass --write to also time a signed PUT/GET probe)\n"));
  else console.log("");
  for (const s of steps) {
    const bar = "#".repeat(Math.min(40, Math.round(s.ms / 25)));
    console.log(
      `  ${(s.ok ? C.ok("ok") : C.bad("x ")).padEnd(2)} ${String(s.ms).padStart(5)}ms  ${s.label.padEnd(20)} ${C.cyan(bar)} ${C.dim(s.extra || "")}`
    );
  }
  console.log(C.dim(`\n  total ${total}ms`));
  return result;
}

// ---------------------------------------------------------------------------
// help + standalone CLI
// ---------------------------------------------------------------------------

const DEBUG_HELP = `ce-app debug verbs — read-only observability

Usage:
  ce-app doctor                 Health: identity, hub, app deployed, rooms, limits
  ce-app logs   <app>           Stream the app's /rt/<app>/__debug room frames
  ce-app trace  <app>           Time a deploy-shaped round-trip (--write for full)

  (standalone: node bin/debug.mjs <doctor|logs|trace> [app])

Options:
  --hub <base>    Hub base URL (default ${DEFAULT_HUB}, or $CE_HUB)
  --app <id>      Explicit app id (else <app> positional, ./.ce/app-id, derived)
  --project <n>   Project name used to derive the app id
  --json          Machine-readable output
  --once          logs: drain recent history then exit (default follows)
  --timeout <ms>  logs --once window / probe timeouts
  --write         trace: also PUT/GET/clean a tiny signed probe under __trace/
  -h, --help      This help

The __debug room convention: apps publish JSON text frames to /rt/<app>/__debug,
e.g. {"t":"log","level":"info","ts":1719,"msg":"started"} or
{"t":"trace","name":"render","ms":12}. Nothing is required; this tooling and
site/debug.html render whatever is there. See web/docs/debug.md.`;

async function runDebugCli(argv) {
  const opts = parseArgs(argv);
  const cmd = opts._[0];
  if (opts.help || cmd === "help" || !cmd) {
    console.log(DEBUG_HELP);
    return;
  }
  switch (cmd) {
    case "doctor":
      await cmdDoctor(opts);
      break;
    case "logs":
      await cmdLogs(opts);
      break;
    case "trace":
      await cmdTrace(opts);
      break;
    default:
      console.error(`Unknown debug command: ${cmd}\n`);
      console.log(DEBUG_HELP);
      process.exitCode = 1;
  }
}

// Exports for ce-app.mjs to wire in (see report). Also exports the building
// blocks so the main CLI can reuse them if it ever wants to.
export { cmdDoctor, cmdLogs, cmdTrace, runDebugCli, DEBUG_HELP, DEBUG_ROOM, resolveAppId, resolveIdentity };

// Standalone entry: `node bin/debug.mjs ...`
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("debug.mjs");
  } catch (_) {
    return false;
  }
})();

if (isMain) {
  runDebugCli(process.argv.slice(2)).catch((e) => {
    console.error(C.bad("debug error: ") + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
}
