#!/usr/bin/env node
// ce-app slug — claim / renew / release / list / status a human-readable slug for
// an app on the live hub, signed with your ONE CE identity.
//
//   ce-app slug claim   [name]   claim <name> (or ce.json "slug") -> this app id
//   ce-app slug renew   [name]   push the expiry out (owner only)
//   ce-app slug release [name]   give the slug back (owner only)
//   ce-app slug ls               list the slugs this identity owns (scans known names)
//   ce-app slug status [name]    resolve a slug -> {app_id, owner, expires, alive}
//
// Flags: --help  --hub <base>  --app <id>  --project <name>  --slug <name>  --json
//
// A claimed slug resolves at the hub's not-found fallback, so GET
// https://<hub>/apps/<slug>/... serves the claimed app with NO nginx change. A
// future subdomain mapping (slug.ce-net.com) layers on top of the same record.
//
// Signing (the canonical scheme the wave-2 hub verifies; see ce-app.mjs):
//   headers x-ce-id (pubkey hex), x-ce-sig (ed25519 hex), x-ce-ts (UNIX SECONDS,
//   300s window), x-ce-nonce (random hex). canonical string =
//     METHOD "\n" PATH "\n" ts "\n" nonce "\n" sha256(body)-hex
// /slugs/* writes REQUIRE a valid signature (they are not anonymous-open), so a
// machine with no usable secret key cannot claim — we fail loudly in that case.
//
// Standalone: `node bin/slug.mjs <cmd> ...` works on its own (Node 18+, ESM, no
// deps). It is ALSO exported for one-line wire-up into ce-app.mjs (see EOF note).

import { promises as fs } from "node:fs";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_HUB = "https://ce-net.com";
const NODEPREFIX_LEN = 10;

// ---------------------------------------------------------------------------
// identity — the SAME single-identity resolution ce-app.mjs uses. Reused (not
// re-minted): CE node id (`ce id` + ~/.local/share/ce/identity/node.key) first,
// else ONE local Ed25519 keypair at ~/.ce/identity. The secret key SIGNS writes.
// ---------------------------------------------------------------------------

function ceHomeDir() {
  return path.join(os.homedir(), ".ce");
}
function ceNodeKeyPath() {
  // The CE data dir is platform-specific (macOS: ~/Library/Application Support/ce; Linux:
  // ~/.local/share/ce; Windows: %APPDATA%\ce) and CE_DATA_DIR can override it. Return the first
  // existing candidate, else the per-platform default. (Mirrors ce-app.mjs.)
  const home = os.homedir();
  const cands = [];
  if (process.env.CE_DATA_DIR) cands.push(path.join(process.env.CE_DATA_DIR, "identity", "node.key"));
  cands.push(path.join(home, "Library", "Application Support", "ce", "identity", "node.key"));
  cands.push(path.join(home, ".local", "share", "ce", "identity", "node.key"));
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, "ce", "identity", "node.key"));
  for (const c of cands) { try { if (fssync.existsSync(c)) return c; } catch (_) {} }
  return process.platform === "darwin" ? cands[process.env.CE_DATA_DIR ? 1 : 0] : cands[cands.length - 1];
}
function ceIdentityDir() {
  return path.join(ceHomeDir(), "identity");
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

let _identityCache = null;

async function resolveIdentity() {
  if (_identityCache) return _identityCache;
  const identDir = ceIdentityDir();
  const localKeyFile = path.join(identDir, "node.key");
  const localPubFile = path.join(identDir, "node.pub");

  const ceId = tryCeNodeId();
  if (ceId) {
    const loaded = await tryLoadEd25519Secret(ceNodeKeyPath());
    const ident = {
      id: ceId,
      source: loaded ? "ce-node" : "ce-node (no local key)",
      secretKey: loaded ? loaded.secretKey : null,
      publicKey: loaded ? loaded.publicKeyHex : ceId,
      signer: loaded ? makeSigner(loaded.secretKey) : null,
    };
    _identityCache = ident;
    return ident;
  }

  let kp = await tryLoadEd25519Secret(localKeyFile);
  if (!kp) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const der = privateKey.export({ type: "pkcs8", format: "der" });
    const pubHex = rawEd25519PubHex(publicKey);
    await fs.mkdir(identDir, { recursive: true });
    await fs.writeFile(localKeyFile, der);
    try { await fs.chmod(localKeyFile, 0o600); } catch (_) { /* best effort */ }
    await fs.writeFile(localPubFile, pubHex + "\n");
    kp = { secretKey: privateKey, publicKey, publicKeyHex: pubHex };
  }
  const id = crypto.createHash("sha256").update(Buffer.from(kp.publicKeyHex, "hex")).digest("hex");
  const ident = {
    id,
    source: "local-keypair",
    secretKey: kp.secretKey,
    publicKey: kp.publicKeyHex,
    signer: makeSigner(kp.secretKey),
  };
  _identityCache = ident;
  return ident;
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
    } catch (_) { /* try next */ }
  }
  return null;
}

function ed25519SeedToPkcs8(seed32) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return Buffer.concat([prefix, Buffer.from(seed32)]);
}

function rawEd25519PubHex(publicKeyObj) {
  const jwk = publicKeyObj.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

function makeSigner(secretKey) {
  return (canonicalString) => {
    const sig = crypto.sign(null, Buffer.from(canonicalString, "utf8"), secretKey);
    return Buffer.from(sig).toString("hex");
  };
}

function nodePrefix(id) {
  return String(id).toLowerCase().slice(0, NODEPREFIX_LEN);
}

// ---------------------------------------------------------------------------
// signed requests — canonical scheme (x-ce-ts is UNIX SECONDS to match the hub's
// 300s parse-as-seconds window). sha256(body)-hex over the RAW request bytes.
// ---------------------------------------------------------------------------

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf == null ? Buffer.alloc(0) : buf).digest("hex");
}

async function signedHeaders(method, urlOrPath, body, base = {}) {
  const ident = await resolveIdentity();
  if (!ident || !ident.signer) {
    throw new Error(
      "no signing key available — slug writes require a signature.\n" +
        "  install/start a CE node (`ce id`) or let ~/.ce/identity be created (run once unsandboxed)."
    );
  }
  let pathOnly = String(urlOrPath);
  try {
    const u = new URL(urlOrPath);
    pathOnly = u.pathname + (u.search || "");
  } catch (_) { /* already a path */ }
  const ts = String(Math.floor(Date.now() / 1000)); // SECONDS, per hub
  const nonce = crypto.randomBytes(12).toString("hex");
  const bodyBuf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const canonical = [method.toUpperCase(), pathOnly, ts, nonce, sha256Hex(bodyBuf)].join("\n");
  const sig = ident.signer(canonical);
  return {
    ...base,
    "x-ce-id": ident.publicKey,
    "x-ce-sig": sig,
    "x-ce-ts": ts,
    "x-ce-nonce": nonce,
  };
}

async function signedJson(hub, method, p, obj) {
  const url = `${hub}${p}`;
  const body = Buffer.from(JSON.stringify(obj));
  const headers = await signedHeaders(method, p, body, { "content-type": "application/json" });
  const res = await fetch(url, { method, headers, body });
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && data.error) || text || `${res.status}`;
    throw new Error(`${method} ${p} -> ${res.status} ${msg}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// project config (ce.json / ce-app.json) — read the slug + project name + app id.
// ---------------------------------------------------------------------------

function readJsonSafe(p) {
  try {
    return JSON.parse(fssync.readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

// Read ce.json (drift et al.) then ce-app.json (rust templates). First hit wins.
function readCeConfig(cwd) {
  return readJsonSafe(path.join(cwd, "ce.json")) || readJsonSafe(path.join(cwd, "ce-app.json")) || {};
}

function dnsLabelPart(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readTextSafe(p) {
  try {
    return fssync.readFileSync(p, "utf8");
  } catch (_) {
    return null;
  }
}

function parseCargoName(text) {
  if (!text) return null;
  const m = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return m ? m[1] : null;
}

// Project (slug-ish) name: --project, else config project/name/slug, else
// package.json name, else Cargo crate name, else dir name. DNS-label-safe.
function resolveProjectName(cwd, override) {
  if (override && String(override).trim()) return dnsLabelPart(override);
  const cfg = readCeConfig(cwd);
  for (const k of ["project", "name", "slug"]) {
    if (typeof cfg[k] === "string") {
      const lbl = dnsLabelPart(cfg[k]);
      if (lbl) return lbl;
    }
  }
  const pkg = readJsonSafe(path.join(cwd, "package.json"));
  if (pkg && typeof pkg.name === "string" && pkg.name.trim()) {
    const lbl = dnsLabelPart(pkg.name.replace(/^@[^/]+\//, ""));
    if (lbl) return lbl;
  }
  const cargoName = parseCargoName(readTextSafe(path.join(cwd, "Cargo.toml")));
  if (cargoName) {
    const lbl = dnsLabelPart(cargoName);
    if (lbl) return lbl;
  }
  return dnsLabelPart(path.basename(cwd) || "app") || "app";
}

// The deployed app id: --app, else ./.ce/app-id pin, else config app_id/app, else
// "<project>-<nodeprefix>" (the exact ce-app.mjs derivation).
async function resolveAppId(cwd, opts) {
  if (opts && opts.app) {
    const lbl = dnsLabelPart(opts.app);
    if (lbl) return lbl;
  }
  const pinned = readTextSafe(path.join(cwd, ".ce", "app-id"));
  if (pinned) {
    const lbl = dnsLabelPart(pinned.trim());
    if (lbl) return lbl;
  }
  const cfg = readCeConfig(cwd);
  for (const k of ["app_id", "app", "appId"]) {
    if (typeof cfg[k] === "string") {
      const lbl = dnsLabelPart(cfg[k]);
      if (lbl) return lbl;
    }
  }
  const ident = await resolveIdentity();
  const prefix = nodePrefix(ident.id);
  const project = resolveProjectName(cwd, opts && opts.project);
  let appId = `${project}-${prefix}`;
  const MAX = 50;
  if (appId.length > MAX) {
    const room = MAX - (prefix.length + 1);
    appId = `${dnsLabelPart(project.slice(0, Math.max(1, room)))}-${prefix}`;
  }
  return dnsLabelPart(appId);
}

// The slug to operate on: positional arg, else --slug, else config "slug", else
// the project name (so a bare `slug claim` claims the project's natural name).
function resolveSlug(cwd, opts, positional) {
  const explicit = positional || (opts && opts.slug);
  if (explicit && String(explicit).trim()) return dnsLabelPart(explicit);
  const cfg = readCeConfig(cwd);
  if (typeof cfg.slug === "string") {
    const lbl = dnsLabelPart(cfg.slug);
    if (lbl) return lbl;
  }
  return resolveProjectName(cwd, opts && opts.project);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdClaim(opts) {
  const cwd = process.cwd();
  const slug = resolveSlug(cwd, opts, opts._[0]);
  const appId = await resolveAppId(cwd, opts);
  if (!slug) throw new Error("no slug to claim — pass a name, set --slug, or add \"slug\" to ce.json");
  const data = await signedJson(opts.hub, "POST", "/slugs/claim", { slug, app_id: appId });
  if (opts.json) return data;
  const when = data.expires_unix ? new Date(data.expires_unix * 1000).toISOString() : "?";
  return [
    `claimed  ${slug} -> ${appId}`,
    `  owner    ${data.owner}`,
    `  expires  ${when}`,
    `  serves   ${opts.hub}/apps/${slug}/`,
  ].join("\n");
}

async function cmdRenew(opts) {
  const cwd = process.cwd();
  const slug = resolveSlug(cwd, opts, opts._[0]);
  if (!slug) throw new Error("no slug to renew");
  const data = await signedJson(opts.hub, "POST", "/slugs/renew", { slug });
  if (opts.json) return data;
  const when = data.expires_unix ? new Date(data.expires_unix * 1000).toISOString() : "?";
  return `renewed  ${slug}  (expires ${when})`;
}

async function cmdRelease(opts) {
  const cwd = process.cwd();
  const slug = resolveSlug(cwd, opts, opts._[0]);
  if (!slug) throw new Error("no slug to release");
  const data = await signedJson(opts.hub, "POST", "/slugs/release", { slug });
  if (opts.json) return data;
  return data.ok ? `released  ${slug}` : `not held  ${slug} (nothing to release)`;
}

// GET /slugs/:slug is public (unsigned).
async function getSlug(hub, slug) {
  const res = await fetch(`${hub}/slugs/${encodeURIComponent(slug)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /slugs/${slug} -> ${res.status}`);
  return res.json();
}

async function cmdStatus(opts) {
  const cwd = process.cwd();
  const slug = resolveSlug(cwd, opts, opts._[0]);
  if (!slug) throw new Error("no slug to look up");
  const data = await getSlug(opts.hub, slug);
  if (opts.json) return data || { slug, found: false };
  if (!data) return `unclaimed  ${slug}`;
  const when = data.expires_unix ? new Date(data.expires_unix * 1000).toISOString() : "?";
  return [
    `${data.alive ? "live    " : "expired "} ${slug} -> ${data.app_id}`,
    `  owner    ${data.owner}`,
    `  expires  ${when}`,
  ].join("\n");
}

// `ls`: the hub has no list-by-owner endpoint, so resolve a set of candidate
// slugs (this project's slug + any extra names passed) and show the ones owned by
// THIS identity. Honest about its scope: it cannot enumerate the whole registry.
async function cmdLs(opts) {
  const cwd = process.cwd();
  const ident = await resolveIdentity();
  const mineOwner = crypto.createHash("sha256").update(Buffer.from(ident.publicKey, "hex")).digest("hex").slice(0, 32);
  const candidates = new Set([resolveSlug(cwd, opts, null), ...opts._]
    .map((s) => (s ? dnsLabelPart(s) : null))
    .filter(Boolean));
  const rows = [];
  for (const slug of candidates) {
    const data = await getSlug(opts.hub, slug).catch(() => null);
    if (data) rows.push(data);
  }
  if (opts.json) return { owner: mineOwner, slugs: rows };
  if (!rows.length) return "no known slugs (pass names to check, or claim one first)";
  return rows
    .map((d) => {
      const mine = d.owner === mineOwner ? "*" : " ";
      const live = d.alive ? "live   " : "expired";
      return `${mine} ${live}  ${d.slug} -> ${d.app_id}  (${d.owner})`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// arg parsing + dispatch
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { _: [], hub: process.env.CE_HUB || DEFAULT_HUB, app: undefined, project: undefined, slug: undefined, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--hub") opts.hub = argv[++i];
    else if (a.startsWith("--hub=")) opts.hub = a.slice(6);
    else if (a === "--app") opts.app = argv[++i];
    else if (a.startsWith("--app=")) opts.app = a.slice(6);
    else if (a === "--project") opts.project = argv[++i];
    else if (a.startsWith("--project=")) opts.project = a.slice(10);
    else if (a === "--slug") opts.slug = argv[++i];
    else if (a.startsWith("--slug=")) opts.slug = a.slice(7);
    else opts._.push(a);
  }
  if (opts.hub) opts.hub = String(opts.hub).replace(/\/+$/, "");
  return opts;
}

const HELP = `ce-app slug — human-readable names for your app, signed with your CE identity.

Usage:
  ce-app slug claim   [name]   claim <name> (or ce.json "slug") for this app id
  ce-app slug renew   [name]   extend the expiry (owner only)
  ce-app slug release [name]   release the slug (owner only)
  ce-app slug status  [name]   resolve a slug -> app id / owner / expiry
  ce-app slug ls      [names]  show known slugs owned by this identity

Flags:
  --hub <base>      hub base URL (default: $CE_HUB or https://ce-net.com)
  --app <id>        override the app id the slug points at (default: derived)
  --project <name>  override the project name used to derive slug/app id
  --slug <name>     the slug (alternative to the positional arg / ce.json)
  --json            machine-readable JSON output
  --help            this help

A claimed slug serves at <hub>/apps/<slug>/ with no nginx change. Writes are
signed (x-ce-id/x-ce-sig/x-ce-ts/x-ce-nonce); a usable secret key is required.`;

// Exported handler so ce-app.mjs can dispatch "slug" without re-parsing.
//   argv = the args AFTER the "slug" subcommand.
// Returns a string (human) or object (when opts.json) to print; throws on error.
export async function runSlug(argv) {
  const opts = parseArgs(argv);
  const sub = (opts._.shift() || "").toLowerCase();
  if (opts.help || !sub || sub === "help") return HELP;
  switch (sub) {
    case "claim": return cmdClaim(opts);
    case "renew": return cmdRenew(opts);
    case "release": return cmdRelease(opts);
    case "status": return cmdStatus(opts);
    case "ls": case "list": return cmdLs(opts);
    default: throw new Error(`unknown slug subcommand "${sub}" (try: claim|renew|release|status|ls)`);
  }
}

// Also export the pieces ce-app.mjs (or registry.mjs) may want to reuse.
export { resolveIdentity, signedHeaders, signedJson, resolveAppId, resolveSlug, readCeConfig };

// Standalone entry: `node bin/slug.mjs <cmd> ...`
const _isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch (_) { return false; }
})();

if (_isMain) {
  runSlug(process.argv.slice(2))
    .then((out) => {
      if (out == null) return;
      console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    })
    .catch((e) => {
      console.error("error:", e.message || e);
      process.exit(1);
    });
}
