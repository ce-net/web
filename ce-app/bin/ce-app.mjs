#!/usr/bin/env node
// ce-app — one command to a live, globally reachable, hot-reloading app.
//
//   ce-app new [template] [dir]   scaffold a template (lists available if omitted)
//   ce-app whoami                 print your ONE identity + nodeprefix + where it came from
//   ce-app link [token]           print the device-pairing flow (capability/QR) — design stub
//   ce-app dev                    build + watch + live-upload, prints the public URL(s)
//   ce-app deploy                 framework auto-detect + build + upload + spa config
//   ce-app domain add|rm|ls <d>   manage custom production domains for this app
//   ce-app detect                 print the detected framework + output dir (no network)
//   ce-app smoke                  build a tiny fixture locally (no network) — self-check
//
// Flags: --help  --hub <base>  --app <id>  --project <name>
//
// ONE identity per person (invisible Tier-2): ce-app never mints a second id. It
// reuses the CE node identity (`ce id`; secret key at
// ~/.local/share/ce/identity/node.key) when present, else one local Ed25519 keypair
// at ~/.ce/identity created once. The old ~/.ce/id and per-project ./.ce/app-id
// migrate to this single identity. Every mutating request is signed (x-ce-id /
// x-ce-sig / x-ce-ts / x-ce-nonce), forward-compatible with the live hub.
//
// Per-project, node-id-tied domains:
//   nodeprefix = the identity id's first 10 hex chars. Each project deploys as
//   "<project>-<nodeprefix>" and is reachable at BOTH
//   https://<project>-<nodeprefix>.ce-net.com and
//   https://ce-net.com/apps/<project>-<nodeprefix>/ — same origin either way. The single
//   DNS label keeps wildcard TLS automatic. Bring your own domain on top with
//   `ce-app domain add <your-domain>`.
//
// Node 18+, ESM. Light deps: esbuild, chokidar (the framework build tools — vite,
// next, svelte, astro, expo — are invoked through the project's own npm scripts /
// npx and are NOT dependencies of ce-app).

import { promises as fs } from "node:fs";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Standalone sibling modules wired in as first-class subcommands. Each is also a
// runnable script on its own (node bin/<mod>.mjs ...); here we import the exported
// argv-accepting dispatchers so `slug`, `publish`/`unpublish`/`project`, and
// `doctor`/`logs`/`trace` route through ce-app's command dispatch. Their behavior
// is unchanged; they resolve the SAME single CE identity ce-app does (identical
// logic), so they sign with ce-app's working identity. We forward --hub (and any
// explicit --app/--project the user passed) into their argv.
import { runSlug } from "./slug.mjs";
import { runRegistry } from "./registry.mjs";
import { runDebugCli } from "./debug.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HUB = "https://ce-net.com";

// The local CE node HTTP API. ce-app serve reverse-proxies a same-origin "/ce"
// path to this so a page under the STRICT CSP (connect-src 'self') can still
// reach a native local/relay node — the documented non-bridge transport.
const DEFAULT_NODE_API = process.env.CE_NODE_API || "http://127.0.0.1:8844";

// The STRICT confinement CSP. This is the EXACT string shared across the SDK
// (@ce-net/sdk CE_STRICT_CSP) and the in-browser node: connect-src 'self' means
// the page can reach ONLY its own origin (the in-process bridge or the /ce
// reverse proxy) and nothing else — no arbitrary fetch, no third-party origin.
// ce-app serve injects it on every response so "stranger code talks ONLY to the
// local node" holds for any app it hosts, identical to the in-browser confinement.
const CE_STRICT_CSP =
  "default-src 'self'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
  "base-uri 'self'; object-src 'none'; frame-ancestors 'none'";

// The same-origin path that reverse-proxies to the local node API (see above).
const CE_PROXY_PREFIX = "/ce";

// The same-origin bridge bootstrap script ce-app serve injects into every HTML
// document. It is a NO-OP shim that documents the contract and degrades cleanly:
//   - If a WASM in-browser node has already injected window.__ceNode, it is left
//     untouched (the in-process bridge wins).
//   - Otherwise the page uses connectNode()'s documented fallback: a CeClient
//     pointed at the same-origin "/ce" reverse proxy (a native local/relay node).
// Both transports are SAME-ORIGIN, which is exactly what lets one strict CSP hold.
// The script is served from /__ce/bridge.js (same-origin => allowed by script-src
// 'self'); a real WASM-node host page overrides window.__ceNode before this runs.
const CE_BRIDGE_BOOTSTRAP = `// ce-app bridge bootstrap (same-origin, CSP script-src 'self').
// Contract: window.__ceNode is a CeNodeBridge with
//   request(method, path, init?) => Promise<{ status, headers, body }>
// dispatching IN-PROCESS to an in-browser WASM CE node (sentinel base URL
// "http://ce-browser-node.local"). When no WASM node is present, apps reach a
// native local/relay node through the same-origin "${CE_PROXY_PREFIX}" reverse proxy
// this server provides — connectNode() picks that path automatically.
(function () {
  if (typeof window === "undefined") return;
  window.__ceProxyBase = "${CE_PROXY_PREFIX}";
  if (window.__ceNode) return; // an in-browser WASM node already bound the bridge.
  // No in-process bridge: leave window.__ceNode undefined so connectNode() falls
  // back to the same-origin "${CE_PROXY_PREFIX}" proxy (a native node). Nothing here
  // ever touches a cross-origin URL, so the strict CSP stays intact.
})();
`;

const CE_BRIDGE_PATH = "/__ce/bridge.js";

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    _: [],
    hub: process.env.CE_HUB || DEFAULT_HUB,
    app: undefined,
    project: undefined,
    help: false,
    // mesh-serve flags
    sub: undefined,
    port: undefined,
    domain: undefined,
    expose: false,
    noBuild: false,
    hubDeploy: false,
    nodeApi: process.env.CE_NODE_API || undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--hub") opts.hub = argv[++i];
    else if (a.startsWith("--hub=")) opts.hub = a.slice("--hub=".length);
    else if (a === "--hub-deploy") opts.hubDeploy = true;
    else if (a === "--app") opts.app = argv[++i];
    else if (a.startsWith("--app=")) opts.app = a.slice("--app=".length);
    else if (a === "--project") opts.project = argv[++i];
    else if (a.startsWith("--project=")) opts.project = a.slice("--project=".length);
    else if (a === "--sub") opts.sub = argv[++i];
    else if (a.startsWith("--sub=")) opts.sub = a.slice("--sub=".length);
    else if (a === "--port") opts.port = argv[++i];
    else if (a.startsWith("--port=")) opts.port = a.slice("--port=".length);
    else if (a === "--domain") opts.domain = argv[++i];
    else if (a.startsWith("--domain=")) opts.domain = a.slice("--domain=".length);
    else if (a === "--expose") opts.expose = true;
    else if (a === "--no-build") opts.noBuild = true;
    else if (a === "--node-api") opts.nodeApi = argv[++i];
    else if (a.startsWith("--node-api=")) opts.nodeApi = a.slice("--node-api=".length);
    else opts._.push(a);
  }
  if (opts.hub) opts.hub = String(opts.hub).replace(/\/+$/, "");
  if (opts.nodeApi) opts.nodeApi = String(opts.nodeApi).replace(/\/+$/, "");
  return opts;
}

// Bare apex host of the hub (e.g. "https://ce-net.com" -> "ce-net.com"), used to
// build the per-project subdomain URL.
function hubHost(hub) {
  try {
    return new URL(hub).host;
  } catch (_) {
    return String(hub).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function hubScheme(hub) {
  try {
    return new URL(hub).protocol.replace(/:$/, "");
  } catch (_) {
    return hub.startsWith("http://") ? "http" : "https";
  }
}

// ---------------------------------------------------------------------------
// content types
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function contentType(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// identity — ONE identity per person, reused across everything (invisible Tier-2).
//
// CE's locked design is "1 person = 1 node id". ce-app NEVER mints a second id.
// Resolution order (the FIRST that exists wins, and is treated as the source of
// truth for the public id):
//
//   1) CE node identity. If the `ce` CLI is installed, `ce id` prints the node
//      id (64 hex). The matching Ed25519 SECRET key lives on disk at
//      ~/.local/share/ce/identity/node.key when this is a real CE node, and is
//      used to SIGN mutating requests. The node id is the public id.
//   2) Otherwise, ONE local app keypair at ~/.ce/identity (Ed25519, created once
//      and reused forever). Its node id is sha256(pubkey) hex. This key signs.
//
// Migration (must keep existing deploys working):
//   - The OLD random/derived id at ~/.ce/id and any per-project ./.ce/app-id are
//     still honored, but they MIGRATE to the single identity above. ~/.ce/id is
//     rewritten to the resolved id so the source of truth converges, while the
//     previously-derived app ids keep resolving (the ./.ce/app-id pin still wins
//     for that checkout, so a project already live at <name>-<oldprefix> stays
//     reachable at exactly that id).
//
// nodeprefix = first 10 hex of the id; it namespaces every project subdomain so
// two developers' "chat" apps never collide.
// ---------------------------------------------------------------------------

const NODEPREFIX_LEN = 10;

function ceHomeDir() {
  return path.join(os.homedir(), ".ce");
}

// Where a real CE node keeps its Ed25519 secret key. The data dir is platform-specific (the `dirs`
// crate: ~/Library/Application Support/ce on macOS, ~/.local/share/ce on Linux, %APPDATA%\ce on
// Windows), and CE_DATA_DIR / `ce --data-dir` can override it. Return the first that exists, else a
// sensible per-platform default.
function ceNodeKeyPath() {
  const home = os.homedir();
  const cands = [];
  if (process.env.CE_DATA_DIR) cands.push(path.join(process.env.CE_DATA_DIR, "identity", "node.key"));
  cands.push(path.join(home, "Library", "Application Support", "ce", "identity", "node.key")); // macOS
  cands.push(path.join(home, ".local", "share", "ce", "identity", "node.key")); // Linux / XDG
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, "ce", "identity", "node.key")); // Windows
  for (const c of cands) {
    try { if (fssync.existsSync(c)) return c; } catch (_) { /* keep looking */ }
  }
  return process.platform === "darwin" ? cands[process.env.CE_DATA_DIR ? 1 : 0] : cands[cands.length - 1];
}

function ceIdentityDir() {
  return path.join(ceHomeDir(), "identity");
}

// Try `ce id` and return the first 16-hex-or-longer token, lowercased. Returns
// null if the CLI is missing, errors, or prints nothing hex-looking. Best-effort
// and fast: a short timeout, no throw. We anchor on the "node id" line when the
// CLI prints both a node id and a libp2p id.
function tryCeNodeId() {
  try {
    const r = spawnSync(process.platform === "win32" ? "ce.cmd" : "ce", ["id"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status !== 0 || !r.stdout) return null;
    // Prefer the explicit "node id" line if present (`ce id` prints node + libp2p).
    const line = r.stdout.split(/\r?\n/).find((l) => /node\s*id/i.test(l));
    const m = (line || r.stdout).match(/[0-9a-fA-F]{16,}/);
    return m ? m[0].toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

// Cached identity so repeated calls (whoami, deploy, every signed PUT) are cheap.
let _identityCache = null;

// Resolve the ONE identity for this machine. Returns:
//   { id, source, secretKey, publicKey, signer }
//     id        : 64-hex (or >=16-hex) public node id used for app ids + x-ce-id
//     source    : "ce-node" | "ce-node (no local key)" | "local-keypair" | "migrated"
//     secretKey : node:crypto KeyObject (Ed25519 private) or null if unsignable
//     publicKey : raw 32-byte Ed25519 public key (hex) when known, else derived
//     signer    : (canonicalString) => sigHex  or  null when no secret key
//
// NEVER regenerates a second id. The first existing source wins.
async function resolveIdentity() {
  if (_identityCache) return _identityCache;

  const ceDir = ceHomeDir();
  const idFile = path.join(ceDir, "id");
  const identDir = ceIdentityDir();
  const localKeyFile = path.join(identDir, "node.key");
  const localPubFile = path.join(identDir, "node.pub");

  // (1) CE node identity via `ce id`. This is the canonical "1 person = 1 id".
  const ceId = tryCeNodeId();
  if (ceId) {
    // Try to load the node's secret key so we can actually sign. It may be absent
    // (e.g. on a machine where only `ce` is on PATH but the node data dir lives
    // elsewhere) — signing is then disabled, but identity still resolves.
    const loaded = await tryLoadEd25519Secret(ceNodeKeyPath());
    const ident = {
      id: ceId,
      source: loaded ? "ce-node" : "ce-node (no local key)",
      secretKey: loaded ? loaded.secretKey : null,
      publicKey: loaded ? loaded.publicKeyHex : ceId,
      signer: loaded ? makeSigner(loaded.secretKey) : null,
      keyPath: loaded ? ceNodeKeyPath() : null,
    };
    await migrateIdFile(idFile, ceId);
    _identityCache = ident;
    return ident;
  }

  // (2) The single local keypair at ~/.ce/identity. Create ONCE, reuse forever.
  let kp = await tryLoadEd25519Secret(localKeyFile);
  if (!kp) {
    // First run with no CE node: mint exactly one keypair and persist it.
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const der = privateKey.export({ type: "pkcs8", format: "der" });
    const pubHex = rawEd25519PubHex(publicKey); // 32-byte raw key, hex
    await fs.mkdir(identDir, { recursive: true });
    await fs.writeFile(localKeyFile, der);
    try { await fs.chmod(localKeyFile, 0o600); } catch (_) { /* best effort (Windows) */ }
    await fs.writeFile(localPubFile, pubHex + "\n");
    kp = {
      secretKey: privateKey,
      publicKey,
      publicKeyHex: pubHex,
    };
  }
  // The node id for a local keypair = sha256(pubkey) hex (64 hex chars), so it is
  // shaped like a CE node id and is stable across runs.
  const id = crypto.createHash("sha256").update(Buffer.from(kp.publicKeyHex, "hex")).digest("hex");
  const ident = {
    id,
    source: "local-keypair",
    secretKey: kp.secretKey,
    publicKey: kp.publicKeyHex,
    signer: makeSigner(kp.secretKey),
    keyPath: localKeyFile,
  };
  await migrateIdFile(idFile, id);
  _identityCache = ident;
  return ident;
}

// Load an Ed25519 secret key from a file. Accepts PKCS8 DER (what we write) and,
// best-effort, PKCS8 PEM. Returns { secretKey, publicKey, publicKeyHex } or null.
async function tryLoadEd25519Secret(file) {
  let buf;
  try {
    buf = await fs.readFile(file);
  } catch (_) {
    return null;
  }
  // Try DER pkcs8, then PEM pkcs8. A raw 32-byte seed is also wrapped into pkcs8.
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

// Wrap a raw 32-byte Ed25519 seed into a minimal PKCS8 DER so node:crypto loads it.
function ed25519SeedToPkcs8(seed32) {
  // PKCS8 prefix for Ed25519 private keys (RFC 8410): fixed 16-byte header.
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return Buffer.concat([prefix, Buffer.from(seed32)]);
}

// Extract the raw 32-byte Ed25519 public key (hex) from a KeyObject. The JWK
// "x" coordinate is the portable way to get it across Node versions (export
// with { type: "raw" } is not universally supported for Ed25519).
function rawEd25519PubHex(publicKeyObj) {
  const jwk = publicKeyObj.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

// Build a signer: canonicalString -> Ed25519 signature, hex-encoded.
function makeSigner(secretKey) {
  return (canonicalString) => {
    const sig = crypto.sign(null, Buffer.from(canonicalString, "utf8"), secretKey);
    return Buffer.from(sig).toString("hex");
  };
}

// Migrate ~/.ce/id to the resolved single id. Old random/derived ids are replaced
// so the source of truth converges on the one identity. Idempotent and quiet.
async function migrateIdFile(idFile, id) {
  try {
    const existing = (await fs.readFile(idFile, "utf8")).trim().toLowerCase();
    if (existing === id) return; // already converged
  } catch (_) {
    /* not yet created */
  }
  try {
    await fs.mkdir(path.dirname(idFile), { recursive: true });
    await fs.writeFile(idFile, id + "\n");
  } catch (_) {
    /* non-fatal: read-only home, etc. */
  }
}

// Back-compat shim: the rest of the CLI calls resolvePublicId() to get the id
// string. It now delegates to the single-identity resolver.
async function resolvePublicId() {
  const ident = await resolveIdentity();
  return ident.id;
}

function nodePrefix(id) {
  return String(id).toLowerCase().slice(0, NODEPREFIX_LEN);
}

// Sanitize an arbitrary string into a single DNS label fragment: lowercase,
// [a-z0-9-] only, collapse runs of dashes, no leading/trailing dash.
function dnsLabelPart(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The project name: --project, else ce-app.json "project"/"name", else
// package.json "name", else Cargo.toml [package].name, else the directory name.
function resolveProjectName(cwd, override) {
  if (override && String(override).trim()) return dnsLabelPart(override);
  // Optional ce-app.json (used by the rust templates so a Rust project with no
  // package.json still gets a stable, intentional app slug).
  const ceCfg = readJsonSafe(path.join(cwd, "ce-app.json"));
  if (ceCfg && typeof (ceCfg.project || ceCfg.name) === "string") {
    const lbl = dnsLabelPart(String(ceCfg.project || ceCfg.name));
    if (lbl) return lbl;
  }
  const pkg = readJsonSafe(path.join(cwd, "package.json"));
  if (pkg && typeof pkg.name === "string" && pkg.name.trim()) {
    // npm scoped names ("@scope/name") -> use the last path segment.
    const bare = pkg.name.replace(/^@[^/]+\//, "");
    const lbl = dnsLabelPart(bare);
    if (lbl) return lbl;
  }
  // Rust projects: fall back to the crate name in Cargo.toml.
  const cargo = parseCargoToml(readTextSafe(path.join(cwd, "Cargo.toml")));
  if (cargo && cargo.name) {
    const lbl = dnsLabelPart(cargo.name);
    if (lbl) return lbl;
  }
  const dir = dnsLabelPart(path.basename(cwd) || "app");
  return dir || "app";
}

// The deployed app id: "<project>-<nodeprefix>", DNS-label-safe, <= ~50 chars.
// Overridable by --app or ./.ce/app-id (project-local pin), which win as-is
// (still sanitized to a valid single label).
async function resolveAppId(cwd, opts) {
  // 1) explicit --app flag wins.
  if (opts && opts.app) {
    const lbl = dnsLabelPart(opts.app);
    if (lbl) return lbl;
  }
  // 2) a project-local pin at ./.ce/app-id wins (lets you fix an id per checkout).
  try {
    const pinned = (await fs.readFile(path.join(cwd, ".ce", "app-id"), "utf8")).trim();
    const lbl = dnsLabelPart(pinned);
    if (lbl) return lbl;
  } catch (_) {
    /* no pin */
  }
  // 3) derive "<project>-<nodeprefix>".
  const id = await resolvePublicId();
  const prefix = nodePrefix(id);
  const project = resolveProjectName(cwd, opts && opts.project);
  let appId = `${project}-${prefix}`;
  // DNS label cap (~50 chars here, well under the 63 hard limit) without ever
  // cutting off the node prefix — trim the project portion if the whole is long.
  const MAX = 50;
  if (appId.length > MAX) {
    const room = MAX - (prefix.length + 1);
    const trimmedProject = dnsLabelPart(project.slice(0, Math.max(1, room)));
    appId = `${trimmedProject}-${prefix}`;
  }
  return dnsLabelPart(appId);
}

// Build both public URLs for an app id given the hub.
function appUrls(hub, appId) {
  const scheme = hubScheme(hub);
  const host = hubHost(hub);
  return {
    subdomain: `${scheme}://${appId}.${host}/`,
    path: `${hub}/apps/${appId}/`,
  };
}

// ---------------------------------------------------------------------------
// signed writes (invisible, forward-compatible)
//
// Every MUTATING request (app file PUT, config PUT, domain PUT/DELETE, and any
// future slug/registry/feedback write) is signed with the single identity. The
// canonical scheme — fixed NOW so the wave-2 hub can verify it — is:
//
//   headers:
//     x-ce-id:    <pubkey-hex>     (the signer's Ed25519 public key, hex)
//     x-ce-sig:   <ed25519-sig>    (hex signature over the canonical string)
//     x-ce-ts:    <unix-ms>        (millisecond timestamp, replay window)
//     x-ce-nonce: <random-hex>     (per-request nonce, replay defense)
//
//   canonical string (newline-joined, exact order):
//     METHOD "\n" PATH "\n" ts "\n" nonce "\n" sha256(body)-hex
//
//   - PATH is the request path + query exactly as sent (no host), e.g.
//     "/apps/chat-abcd/index.html".
//   - body is the raw request bytes; for an empty body, sha256("") is used.
//
// The LIVE hub ignores these headers today (wave 1), so signing must never break
// anonymous PUTs. We sign when a secret key is available and silently skip the
// signature (still send no broken headers) when it is not.
// ---------------------------------------------------------------------------

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf == null ? Buffer.alloc(0) : buf).digest("hex");
}

// Build the canonical signing headers for a request. Returns {} when we cannot
// sign (no secret key) so the request stays a valid anonymous request.
async function signedHeaders(method, urlOrPath, body) {
  let ident;
  try {
    ident = await resolveIdentity();
  } catch (_) {
    return {};
  }
  if (!ident || !ident.signer) return {}; // unsignable -> anonymous, still valid

  // PATH = path + search of the URL, with no host. Accept a full URL or a path.
  let pathOnly = String(urlOrPath);
  try {
    const u = new URL(urlOrPath);
    pathOnly = u.pathname + (u.search || "");
  } catch (_) {
    /* already a path */
  }

  const ts = String(Math.floor(Date.now() / 1000)); // UNIX SECONDS — the hub (SIG_TTL_SECS) compares in seconds
  const nonce = crypto.randomBytes(12).toString("hex");
  const bodyBuf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const canonical = [method.toUpperCase(), pathOnly, ts, nonce, sha256Hex(bodyBuf)].join("\n");
  let sig;
  try {
    sig = ident.signer(canonical);
  } catch (_) {
    return {};
  }
  return {
    "x-ce-id": ident.publicKey,
    "x-ce-sig": sig,
    "x-ce-ts": ts,
    "x-ce-nonce": nonce,
  };
}

// fetch() wrapper that attaches the canonical signature headers for mutating
// requests. Non-mutating GETs go through unsigned. Never throws on signing.
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
  const headers = { ...(init.headers || {}), ...extra };
  return fetch(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// file walking + upload
// ---------------------------------------------------------------------------

async function walk(dir, baseDir = dir) {
  let out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out = out.concat(await walk(full, baseDir));
    } else if (e.isFile()) {
      out.push({ abs: full, rel: path.relative(baseDir, full).split(path.sep).join("/") });
    }
  }
  return out;
}

async function putFile(hub, appId, rel, body, ct) {
  const url = `${hub}/apps/${encodeURIComponent(appId)}/${rel}`;
  const res = await signedFetch(url, {
    method: "PUT",
    headers: { "content-type": ct },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PUT ${rel} -> ${res.status} ${txt}`);
  }
  return res;
}

// Upload an output dir. `prev` maps rel->hash to skip unchanged files; returns the new map.
// `maxAppFile` (bytes) triggers a non-fatal warning per file that exceeds the hub cap.
async function uploadDir(hub, appId, outDir, prev = null, { quiet = false, maxAppFile = 0 } = {}) {
  const files = await walk(outDir);
  const next = new Map();
  let uploaded = 0;
  let oversize = 0;
  for (const f of files) {
    const buf = await fs.readFile(f.abs);
    const hash = crypto.createHash("sha1").update(buf).digest("hex");
    next.set(f.rel, hash);
    if (prev && prev.get(f.rel) === hash) continue; // unchanged
    if (maxAppFile && buf.length > maxAppFile) {
      oversize++;
      console.log(
        `  WARN  ${f.rel} is ${(buf.length / (1024 * 1024)).toFixed(1)} MiB, over the hub per-file cap ` +
          `(${(maxAppFile / (1024 * 1024)).toFixed(0)} MiB) — the hub may reject it. ` +
          `For wasm: build with --release and run wasm-opt -Oz to shrink it.`
      );
    }
    await putFile(hub, appId, f.rel, buf, contentType(f.rel));
    uploaded++;
    if (!quiet) console.log(`  ok  ${f.rel}  (${buf.length}b)`);
  }
  return { next, uploaded, total: files.length, oversize };
}

// Set spa=true (or any config) on the app via the hub config endpoint.
async function setAppConfig(hub, appId, config) {
  const url = `${hub}/apps/${encodeURIComponent(appId)}/config`;
  try {
    const res = await signedFetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: txt };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// framework auto-detection
//
// Inspect package.json deps + config files and pick the build "recipe":
//   id        a stable string for messaging/tests
//   label     human label
//   build     async (cwd) => void   — runs the right build (npm script / npx)
//   outDirs   candidate static output dirs, in priority order
//   baseHint  whether asset base needs to be made relative (informational)
// Plain "static"/"esbuild" recipes build in-process and don't shell out.
// ---------------------------------------------------------------------------

function readJsonSafe(p) {
  try {
    return JSON.parse(fssync.readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

function fileExists(cwd, ...names) {
  return names.some((n) => fssync.existsSync(path.join(cwd, n)));
}

const VITE_CONFIGS = ["vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.cjs"];
const SVELTE_CONFIGS = ["svelte.config.js", "svelte.config.mjs", "svelte.config.ts"];
const NEXT_CONFIGS = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"];
const ASTRO_CONFIGS = ["astro.config.js", "astro.config.mjs", "astro.config.ts"];
const NUXT_CONFIGS = ["nuxt.config.js", "nuxt.config.mjs", "nuxt.config.ts"];

function hasViteConfig(cwd) {
  return fileExists(cwd, ...VITE_CONFIGS);
}

function depSet(pkg) {
  const out = new Set();
  if (!pkg) return out;
  for (const k of [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ]) {
    out.add(k);
  }
  return out;
}

// Run an npm script if present, else fall back to `npx <tool> <args...>`.
function runScriptOrNpx(cwd, scriptName, fallback) {
  const pkg = readJsonSafe(path.join(cwd, "package.json"));
  const hasScript = pkg && pkg.scripts && typeof pkg.scripts[scriptName] === "string";
  return new Promise((resolve, reject) => {
    let cmd, args;
    if (hasScript) {
      cmd = process.platform === "win32" ? "npm.cmd" : "npm";
      args = ["run", scriptName];
    } else {
      cmd = process.platform === "win32" ? "npx.cmd" : "npx";
      args = fallback;
    }
    const p = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))
    );
  });
}

function runCmd(cwd, cmd, args) {
  return new Promise((resolve, reject) => {
    const bin = process.platform === "win32" ? cmd + ".cmd" : cmd;
    const p = spawn(bin, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))
    );
  });
}

// ---------------------------------------------------------------------------
// Rust -> wasm (+wgpu) recipe
//
// Three build variants, picked by config files present:
//   - trunk    (Trunk.toml or index.html with a wasm <link data-trunk>) ->
//              `trunk build --release --public-url ./`  -> ./dist
//   - wasm-pack(has a [lib] crate-type cdylib and no Trunk.toml; index.html that
//              imports ./pkg) -> `wasm-pack build --target web` -> ./pkg (+ web/)
//   - cargo    (raw) -> cargo build --release --target wasm32-unknown-unknown,
//              optional `wasm-opt -Oz`, assemble ./dist with index.html + .wasm + glue
//
// detectRustWasm(cwd) returns null when there is no Cargo.toml at the root, so
// the JS framework detection is unaffected for non-Rust projects.
// ---------------------------------------------------------------------------

// Run a command and capture stdout/exit; never throws. Used for preflight probes.
function probeCmd(cmd, args, cwd) {
  try {
    const bin = process.platform === "win32" ? cmd + ".cmd" : cmd;
    const r = spawnSync(bin, args, {
      cwd,
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    return { ok: r.status === 0, status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  } catch (_) {
    return { ok: false, status: -1, stdout: "", stderr: "" };
  }
}

function hasBin(cmd) {
  // `<cmd> --version` is the cheapest portable presence check.
  return probeCmd(cmd, ["--version"], process.cwd()).ok;
}

function readTextSafe(p) {
  try {
    return fssync.readFileSync(p, "utf8");
  } catch (_) {
    return null;
  }
}

// Parse just enough of Cargo.toml (no TOML dep): crate name + crate-type list.
function parseCargoToml(text) {
  const out = { name: null, crateTypes: [] };
  if (!text) return out;
  const nameM = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  if (nameM) out.name = nameM[1];
  const ctM = text.match(/crate-type\s*=\s*\[([^\]]*)\]/);
  if (ctM) {
    out.crateTypes = ctM[1]
      .split(",")
      .map((s) => s.replace(/["'\s]/g, ""))
      .filter(Boolean);
  }
  return out;
}

// Detect a Rust->wasm project rooted at cwd. Returns a recipe or null.
function detectRustWasm(cwd) {
  const cargoPath = path.join(cwd, "Cargo.toml");
  const cargoText = readTextSafe(cargoPath);
  if (!cargoText) return null; // not a Rust crate at the root

  const cargo = parseCargoToml(cargoText);
  const hasTrunk = fileExists(cwd, "Trunk.toml") || /data-trunk/.test(readTextSafe(path.join(cwd, "index.html")) || "");
  const usesTrunkDep = /\btrunk\b/.test(cargoText);
  const isCdylib = cargo.crateTypes.includes("cdylib");
  const usesWasmBindgen = /wasm-bindgen\s*=/.test(cargoText);
  // A "./pkg/" import is the wasm-pack signal. The reference may live in index.html
  // OR in a frontend module (game.js / main.js / src/*), so scan those too.
  const frontendText = [
    readTextSafe(path.join(cwd, "index.html")),
    readTextSafe(path.join(cwd, "game.js")),
    readTextSafe(path.join(cwd, "main.js")),
    readTextSafe(path.join(cwd, "src", "main.js")),
    readTextSafe(path.join(cwd, "src", "index.js")),
  ]
    .filter(Boolean)
    .join("\n");
  const importsPkg = /(\.\/)?pkg\//.test(frontendText) || fileExists(cwd, "pkg");
  // Allow ce-app.json to force a variant explicitly.
  const cfgVariant = (readJsonSafe(path.join(cwd, "ce-app.json")) || {}).wasm;

  // --- variant: trunk ---
  if (cfgVariant === "trunk" || hasTrunk || usesTrunkDep) {
    return rustRecipe(cwd, {
      id: "rust-trunk",
      label: "Rust -> wasm (Trunk)",
      variant: "trunk",
      tools: ["rustc", "cargo", "trunk"],
      build: async (c) => {
        await rustPreflight(c, ["wasm-target", "trunk"]);
        await runCmd(c, "trunk", ["build", "--release", "--public-url", "./"]);
      },
      outDirs: ["dist"],
      baseHint: "trunk --public-url ./ keeps asset paths relative for /apps/<id>/",
    });
  }

  // --- variant: wasm-pack ---
  if (cfgVariant === "wasm-pack" || (isCdylib && (importsPkg || usesWasmBindgen))) {
    return rustRecipe(cwd, {
      id: "rust-wasm-pack",
      label: "Rust -> wasm (wasm-pack --target web)",
      variant: "wasm-pack",
      tools: ["rustc", "cargo", "wasm-pack"],
      build: async (c) => {
        await rustPreflight(c, ["wasm-target", "wasm-pack"]);
        await runCmd(c, "wasm-pack", ["build", "--release", "--target", "web", "--out-dir", "pkg"]);
        // Assemble a servable ./dist: index.html (project or generated) + ./pkg/*.
        await assembleWasmPackDist(c, cargo.name);
      },
      outDirs: ["dist"],
      baseHint: "wasm-pack --target web emits ESM glue in ./pkg; we copy it under ./dist/pkg",
    });
  }

  // --- variant: raw cargo (wasm32) ---
  if (isCdylib || /\[lib\]/.test(cargoText)) {
    return rustRecipe(cwd, {
      id: "rust-cargo",
      label: "Rust -> wasm (cargo wasm32 + optional wasm-opt)",
      variant: "cargo",
      tools: ["rustc", "cargo"],
      build: async (c) => {
        await rustPreflight(c, ["wasm-target"]);
        await runCmd(c, "cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"]);
        await assembleRawCargoDist(c, cargo.name);
      },
      outDirs: ["dist"],
      baseHint: "raw cargo wasm; wasm-opt -Oz applied when available; index.html loads the module",
    });
  }

  return null;
}

// Wrap a rust recipe with a marker so messaging/tests can identify it.
function rustRecipe(cwd, base) {
  return { rust: true, ...base };
}

// Toolchain preflight: verify rust + the chosen extra tools are installed, and
// that the wasm32 target is added. Prints EXACT install hints and throws with a
// concise summary if anything is missing. `needs` is a list of capability keys.
async function rustPreflight(cwd, needs) {
  const missing = [];
  const hint = [];

  if (!hasBin("rustc") || !hasBin("cargo")) {
    missing.push("rust toolchain");
    hint.push("  install Rust:        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh");
  }

  if (needs.includes("wasm-target")) {
    // `rustup target list --installed` is authoritative; fall back to assuming
    // missing if rustup is absent (cargo can still build if target preinstalled).
    const r = probeCmd("rustup", ["target", "list", "--installed"], cwd);
    const installed = r.ok && /wasm32-unknown-unknown/.test(r.stdout);
    if (!installed) {
      missing.push("wasm32-unknown-unknown target");
      hint.push("  add the wasm target:  rustup target add wasm32-unknown-unknown");
    }
  }

  if (needs.includes("trunk") && !hasBin("trunk")) {
    missing.push("trunk");
    hint.push("  install trunk:        cargo install --locked trunk");
  }
  if (needs.includes("wasm-pack") && !hasBin("wasm-pack")) {
    missing.push("wasm-pack");
    hint.push("  install wasm-pack:    cargo install wasm-pack   (or: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh)");
  }

  if (missing.length) {
    const lines = [
      `Rust->wasm toolchain preflight failed — missing: ${missing.join(", ")}`,
      "",
      ...hint,
    ];
    throw new Error(lines.join("\n"));
  }
}

// Is wasm-opt available? (optional optimizer, part of binaryen)
function hasWasmOpt() {
  return hasBin("wasm-opt");
}

// Find the built .wasm artifact under target/wasm32-unknown-unknown/release.
function findCargoWasm(cwd, crateName) {
  const relDir = path.join(cwd, "target", "wasm32-unknown-unknown", "release");
  if (!fssync.existsSync(relDir)) return null;
  // Prefer the crate-named artifact; else first .wasm.
  const candidates = [];
  if (crateName) candidates.push(path.join(relDir, crateName.replace(/-/g, "_") + ".wasm"));
  try {
    for (const f of fssync.readdirSync(relDir)) {
      if (f.endsWith(".wasm")) candidates.push(path.join(relDir, f));
    }
  } catch (_) {}
  for (const c of candidates) if (fssync.existsSync(c)) return c;
  return null;
}

// Assemble ./dist for a wasm-pack build: project index.html (or a generated one)
// + the ./pkg/ ESM glue directory.
async function assembleWasmPackDist(cwd, crateName) {
  const dist = path.join(cwd, "dist");
  await fs.mkdir(path.join(dist, "pkg"), { recursive: true });
  // Copy pkg/* into dist/pkg.
  const pkgDir = path.join(cwd, "pkg");
  if (fssync.existsSync(pkgDir)) {
    for (const f of await walk(pkgDir)) {
      const dest = path.join(dist, "pkg", f.rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(f.abs, dest);
    }
  }
  // index.html: prefer the project's; else generate one that boots the module.
  const srcHtml = fssync.existsSync(path.join(cwd, "index.html"))
    ? await fs.readFile(path.join(cwd, "index.html"), "utf8")
    : defaultWasmIndexHtml(crateName, "pkg");
  await fs.writeFile(path.join(dist, "index.html"), srcHtml);
  // Copy a ./static or ./public dir of assets if present.
  await copyStaticInto(cwd, dist);
}

// Assemble ./dist for a raw cargo build: the .wasm (optionally wasm-opt -Oz'd),
// a generated boot index.html if the project has none, + static assets.
async function assembleRawCargoDist(cwd, crateName) {
  const dist = path.join(cwd, "dist");
  await fs.mkdir(dist, { recursive: true });
  const wasm = findCargoWasm(cwd, crateName);
  if (!wasm) throw new Error("cargo build produced no .wasm under target/wasm32-unknown-unknown/release");
  const outWasm = path.join(dist, "app.wasm");
  if (hasWasmOpt()) {
    const r = probeCmd("wasm-opt", ["-Oz", "-o", outWasm, wasm], cwd);
    if (!r.ok) await fs.copyFile(wasm, outWasm); // optimizer failed -> ship unoptimized
  } else {
    await fs.copyFile(wasm, outWasm);
  }
  const srcHtml = fssync.existsSync(path.join(cwd, "index.html"))
    ? await fs.readFile(path.join(cwd, "index.html"), "utf8")
    : defaultRawWasmIndexHtml();
  await fs.writeFile(path.join(dist, "index.html"), srcHtml);
  await copyStaticInto(cwd, dist);
}

// Copy ./static and ./public (if any) into the dist dir.
async function copyStaticInto(cwd, dist) {
  for (const d of ["static", "public", "assets"]) {
    const src = path.join(cwd, d);
    if (!fssync.existsSync(src)) continue;
    for (const f of await walk(src)) {
      const dest = path.join(dist, f.rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(f.abs, dest);
    }
  }
}

function defaultWasmIndexHtml(crateName, pkgDir) {
  const mod = (crateName || "app").replace(/-/g, "_");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${crateName || "ce-app"} · wasm</title>
    <style>html,body{margin:0;height:100%;background:#070d18;color:#e9f1fb;font:16px system-ui}
      canvas{display:block;width:100%;height:100%}</style>
  </head>
  <body>
    <canvas id="canvas"></canvas>
    <script type="module">
      import init from "./${pkgDir}/${mod}.js";
      init().catch((e) => { document.body.innerHTML = "<pre>"+e+"</pre>"; });
    </script>
  </body>
</html>
`;
}

function defaultRawWasmIndexHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ce-app · wasm</title>
    <style>html,body{margin:0;height:100%;background:#070d18;color:#e9f1fb;font:16px system-ui}
      canvas{display:block;width:100%;height:100%}</style>
  </head>
  <body>
    <canvas id="canvas"></canvas>
    <script type="module">
      // Raw wasm has no generated JS glue; instantiate the module directly.
      const res = await fetch("./app.wasm");
      const { instance } = await WebAssembly.instantiateStreaming(res, {});
      if (instance.exports && typeof instance.exports.main === "function") instance.exports.main();
    </script>
  </body>
</html>
`;
}

// Probe the hub for the per-file size cap. The wave-1 hub does NOT expose a
// /hub/stats limits object yet, so we try /hub/stats then /stats and read
// limits.max_app_file / max_app_bytes if present; otherwise fall back to the
// documented 16 MiB per-file cap. Never throws.
const DEFAULT_MAX_APP_FILE = 16 * 1024 * 1024; // mirrors ce-hub MAX_APP_FILE

async function probeHubLimits(hub) {
  const fallback = { maxAppFile: DEFAULT_MAX_APP_FILE, source: "default" };
  for (const p of ["/hub/stats", "/stats"]) {
    try {
      const res = await fetch(`${hub}${p}`);
      if (!res || !res.ok) continue;
      const data = await res.json().catch(() => null);
      const lim = data && (data.limits || data.hub_limits);
      if (lim) {
        const maxAppFile = Number(lim.max_app_file || lim.maxAppFile);
        if (maxAppFile && isFinite(maxAppFile) && maxAppFile > 0) {
          return { maxAppFile, source: p };
        }
      }
    } catch (_) {
      /* try next */
    }
  }
  return fallback;
}

// Returns a recipe object describing how to build + where output lands.
function detectFramework(cwd) {
  const pkg = readJsonSafe(path.join(cwd, "package.json"));
  const deps = depSet(pkg);
  const has = (...names) => names.some((n) => deps.has(n));

  // --- Rust -> wasm (+wgpu): a Cargo.toml at the root wins over the JS recipes.
  // Placed before static/esbuild (and ahead of the JS frameworks) so a Rust
  // project that happens to ship an index.html still builds with cargo/trunk. ---
  const rust = detectRustWasm(cwd);
  if (rust) return rust;

  // --- Next.js (static export only) ---
  if (has("next") || fileExists(cwd, ...NEXT_CONFIGS)) {
    return {
      id: "next",
      label: "Next.js (static export)",
      build: async (c) => {
        // Next 13.3+ uses `output: "export"` in next.config and emits to ./out on `next build`.
        // Older Next needs an explicit `next export` step. Run build, then export if needed.
        await runScriptOrNpx(c, "build", ["next", "build"]);
        // If neither out/ nor configured export exists, attempt a legacy `next export`.
        if (!fssync.existsSync(path.join(c, "out"))) {
          try {
            await runCmd(c, "npx", ["next", "export"]);
          } catch (_) {
            /* modern Next with output:export already wrote ./out, or no export support */
          }
        }
      },
      outDirs: ["out"],
      baseHint: "set basePath/assetPrefix or use relative links for /apps/<id>/ subpath",
    };
  }

  // --- Nuxt (static generate) ---
  if (has("nuxt") || fileExists(cwd, ...NUXT_CONFIGS)) {
    return {
      id: "nuxt",
      label: "Nuxt (static generate)",
      build: async (c) => {
        await runScriptOrNpx(c, "generate", ["nuxi", "generate"]);
      },
      outDirs: [path.join(".output", "public"), "dist"],
      baseHint: "use app.baseURL for subpath hosting",
    };
  }

  // --- Astro (static) ---
  if (has("astro") || fileExists(cwd, ...ASTRO_CONFIGS)) {
    return {
      id: "astro",
      label: "Astro (static)",
      build: async (c) => {
        await runScriptOrNpx(c, "build", ["astro", "build"]);
      },
      outDirs: ["dist"],
      baseHint: "set `base` in astro.config for /apps/<id>/ subpath",
    };
  }

  // --- SvelteKit (static adapter) — has both svelte.config and @sveltejs/kit ---
  if (has("@sveltejs/kit")) {
    return {
      id: "sveltekit",
      label: "SvelteKit (static adapter)",
      build: async (c) => {
        await runScriptOrNpx(c, "build", ["vite", "build"]);
      },
      // adapter-static default is ./build; some configs emit to ./dist.
      outDirs: ["build", "dist"],
      baseHint: "use adapter-static + a relative `paths.base`/`paths.relative` for subpaths",
    };
  }

  // --- Expo / react-native-web (static web export) ---
  if (has("expo") || has("react-native-web")) {
    return {
      id: "expo",
      label: "Expo (react-native-web export)",
      build: async (c) => {
        // SDK 49+: `expo export --platform web` -> ./dist ; older: `expo export:web` -> ./web-build
        try {
          await runCmd(c, "npx", ["expo", "export", "--platform", "web"]);
        } catch (_) {
          await runCmd(c, "npx", ["expo", "export:web"]);
        }
      },
      outDirs: ["dist", "web-build"],
      baseHint: "expo web output is generally root-relative; serve under /apps/<id>/ via SPA fallback",
    };
  }

  // --- Vite (covers vanilla vite, react-on-vite, vue-on-vite, svelte-on-vite) ---
  if (hasViteConfig(cwd) || has("vite")) {
    const flavor = has("vue") ? "vue" : has("react", "react-dom") ? "react" : has("svelte") ? "svelte" : "vanilla";
    return {
      id: "vite",
      label: `Vite (${flavor})`,
      build: async (c) => {
        await runScriptOrNpx(c, "build", ["vite", "build"]);
      },
      outDirs: ["dist"],
      watch: async (c) => runCmd(c, "npx", ["vite", "build", "--watch"]),
      baseHint: 'set `base: "./"` in vite.config for /apps/<id>/ + subdomain portability',
    };
  }

  // --- Create React App (react-scripts) ---
  if (has("react-scripts")) {
    return {
      id: "cra",
      label: "Create React App",
      build: async (c) => {
        await runScriptOrNpx(c, "build", ["react-scripts", "build"]);
      },
      outDirs: ["build"],
      baseHint: 'set "homepage": "." in package.json for relative asset paths',
    };
  }

  // --- Plain static site: an index.html with no build step ---
  if (fileExists(cwd, "index.html") && !pickEntry(cwd)) {
    return {
      id: "static",
      label: "Static site (no build)",
      build: async (c) => {
        const out = path.join(c, "out");
        await fs.mkdir(out, { recursive: true });
        const files = await walk(c);
        for (const f of files) {
          if (/(^|\/)(node_modules|\.ce|out|dist|build)\//.test(f.rel)) continue;
          if (f.rel === "package.json" || f.rel === "package-lock.json") continue;
          const dest = path.join(out, f.rel);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(f.abs, dest);
        }
      },
      outDirs: ["out"],
      baseHint: "already static; reference assets with relative paths",
    };
  }

  // --- esbuild fallback: src/main.{ts,js} + src/index.html (the original behavior) ---
  return {
    id: "esbuild",
    label: "esbuild (src/main + index.html)",
    build: async (c) => {
      await esbuildBuild(c, path.join(c, "out"));
    },
    outDirs: ["out"],
    baseHint: "emitted with relative ./main.js",
  };
}

// Pick the first output dir that exists after a build; fall back to the first candidate.
function resolveOutDir(cwd, recipe) {
  for (const d of recipe.outDirs) {
    const abs = path.isAbsolute(d) ? d : path.join(cwd, d);
    if (fssync.existsSync(abs)) return abs;
  }
  return path.join(cwd, recipe.outDirs[0]);
}

// ---------------------------------------------------------------------------
// esbuild build (the framework-free path)
// ---------------------------------------------------------------------------

function pickEntry(cwd) {
  for (const c of ["src/main.ts", "src/main.js", "src/main.mjs", "src/index.ts", "src/index.js"]) {
    if (fssync.existsSync(path.join(cwd, c))) return c;
  }
  return null;
}

function pickHtml(cwd) {
  for (const c of ["src/index.html", "index.html"]) {
    if (fssync.existsSync(path.join(cwd, c))) return c;
  }
  return null;
}

// Inject <script type="module" src="./main.js"> into an html string if missing.
function ensureScriptTag(html, scriptRel) {
  if (new RegExp(`src=["']\\.?/?${scriptRel.replace(".", "\\.")}["']`).test(html)) return html;
  const tag = `<script type="module" src="./${scriptRel}"></script>`;
  if (html.includes("</body>")) return html.replace("</body>", `  ${tag}\n</body>`);
  return html + "\n" + tag + "\n";
}

// A persistent esbuild context, reused across rebuilds (recommended over repeat build()).
let _esbuildCtx = null;
let _esbuildCtxKey = null;

async function bundleWithEsbuild(cwd, outDir, entry) {
  const esbuild = (await import("esbuild")).default || (await import("esbuild"));
  const opts = {
    entryPoints: [path.join(cwd, entry)],
    bundle: true,
    format: "esm",
    sourcemap: true,
    target: ["es2020"],
    outfile: path.join(outDir, "main.js"),
    logLevel: "silent",
    loader: { ".css": "text", ".svg": "text" },
  };
  const key = `${cwd}|${entry}|${outDir}`;
  if (!_esbuildCtx || _esbuildCtxKey !== key) {
    if (_esbuildCtx) {
      try { await _esbuildCtx.dispose(); } catch (_) {}
    }
    _esbuildCtx = await esbuild.context(opts);
    _esbuildCtxKey = key;
  }
  await _esbuildCtx.rebuild();
}

// esbuild build: bundle the entry to out/main.js and copy/emit index.html and public assets.
async function esbuildBuild(cwd, outDir) {
  const entry = pickEntry(cwd);
  await fs.mkdir(outDir, { recursive: true });

  if (entry) {
    await bundleWithEsbuild(cwd, outDir, entry);
  }

  const htmlRel = pickHtml(cwd);
  if (htmlRel) {
    let html = await fs.readFile(path.join(cwd, htmlRel), "utf8");
    if (entry) html = ensureScriptTag(html, "main.js");
    await fs.writeFile(path.join(outDir, "index.html"), html);
  } else {
    // minimal shell
    const html =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>ce-app</title></head><body>` +
      (entry ? `<script type="module" src="./main.js"></script>` : `<p>empty app</p>`) +
      `</body></html>`;
    await fs.writeFile(path.join(outDir, "index.html"), html);
  }

  // copy ./public/* and top-level static assets (css/json/wasm/images) into out
  for (const dir of [path.join(cwd, "public"), path.join(cwd, "src")]) {
    if (!fssync.existsSync(dir)) continue;
    const isPublic = dir.endsWith("public");
    const assets = await walk(dir);
    for (const a of assets) {
      const ext = path.extname(a.rel).toLowerCase();
      if (!isPublic && !CONTENT_TYPES[ext]) continue;
      if (!isPublic && (ext === ".ts" || ext === ".js" || ext === ".mjs" || ext === ".html")) continue;
      const dest = path.join(outDir, a.rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(a.abs, dest);
    }
  }
  return outDir;
}

// ---------------------------------------------------------------------------
// mesh registration + per-app frontend host (serve) + mesh ingress (expose)
//
// This is the post-hub model. Instead of PUTting static files to a central hub,
// an app:
//   1. registers on the mesh   — claims its name on-chain (the SAME claim_name
//      path ce-expose uses: POST /names/claim) + advertises discovery, so the
//      app is reachable BY NAME with no central index. (`ce-app register`)
//   2. is served locally        — a tiny static host serves the built output,
//      injects the STRICT CSP on every response, injects the window.__ceNode
//      bridge bootstrap into HTML, and reverse-proxies a same-origin "/ce" to
//      the local node so same-origin mesh calls work under CSP. (`ce-app serve`)
//   3. is exposed over ingress  — the ce-expose ORIGIN agent (its own binary,
//      `ce-expose http <servePort> --name <name>`) carries that local host onto
//      https://<name>.user.ce-net.com over mesh HTTP ingress. (`ce-app expose`)
// ---------------------------------------------------------------------------

// POST a JSON body to the local node API. Returns { ok, status, json|text } and
// never throws (the node may be down — registration is best-effort, like the
// ce-expose agent's claim_name which is explicitly best-effort).
async function nodePost(api, pathOnly, body) {
  try {
    const res = await fetch(`${api}${pathOnly}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let json = null;
    let text = "";
    try { json = await res.clone().json(); } catch (_) { try { text = await res.text(); } catch (_) {} }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e && e.message ? e.message : e) };
  }
}

async function nodeGet(api, pathOnly) {
  try {
    const res = await fetch(`${api}${pathOnly}`);
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: String(e && e.message ? e.message : e) };
  }
}

// Derive the mesh endpoint name for an app. Names are 3-32 chars, lowercase
// a-z/0-9/hyphen (the on-chain NameClaim rule the node enforces). We reuse the
// app id (already a DNS-safe label) and clamp it to 32.
function meshNameFor(appId) {
  let n = dnsLabelPart(appId);
  if (n.length > 32) n = dnsLabelPart(n.slice(0, 32));
  if (n.length < 3) n = (n + "-app").slice(0, 32);
  return n;
}

// Inject the strict CSP, the bridge bootstrap script tag, and a same-origin
// <base> awareness into an HTML document. The bridge tag points at the
// same-origin bootstrap (CE_BRIDGE_PATH), so script-src 'self' allows it.
function injectIntoHtml(html) {
  const bridgeTag = `<script src="${CE_BRIDGE_PATH}"></script>`;
  // The CSP also rides as a <meta http-equiv> so it survives even when a request
  // is served without our header (e.g. fetched then re-hosted). The HTTP header
  // is still set on every response; the meta is belt-and-suspenders.
  const metaCsp = `<meta http-equiv="Content-Security-Policy" content="${CE_STRICT_CSP}">`;
  let out = html;
  // Insert the bridge bootstrap as early as possible so window.__ceNode /
  // window.__ceProxyBase are set before app modules run.
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}\n    ${metaCsp}\n    ${bridgeTag}`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html[^>]*>/i, (m) => `${m}\n${metaCsp}\n${bridgeTag}`);
  } else {
    out = `${metaCsp}\n${bridgeTag}\n${out}`;
  }
  return out;
}

// Resolve a request path to a file inside the served root, with the usual
// directory-index + traversal-safety rules. Returns an absolute path or null.
function resolveServedFile(root, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  // Normalize and confine to root (no "..").
  const abs = path.normalize(path.join(root, rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// Forward a request to the local node API for the same-origin "/ce" reverse
// proxy. Strips the CE_PROXY_PREFIX, preserves method/headers/body, and pipes
// the node's response back. This is what makes same-origin mesh calls work under
// connect-src 'self'.
function proxyToNode(req, res, nodeApi) {
  const sub = req.url.slice(CE_PROXY_PREFIX.length) || "/";
  const target = nodeApi.replace(/\/+$/, "") + (sub.startsWith("/") ? sub : "/" + sub);
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (_) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("bad /ce proxy target");
    return;
  }
  const headers = { ...req.headers };
  delete headers.host; // let the upstream client set it
  const upstream = http.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      method: req.method,
      path: targetUrl.pathname + targetUrl.search,
      headers,
    },
    (up) => {
      // Re-assert the strict CSP on proxied responses too (defense in depth).
      const outHeaders = { ...up.headers, "content-security-policy": CE_STRICT_CSP };
      res.writeHead(up.statusCode || 502, outHeaders);
      up.pipe(res);
    }
  );
  upstream.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`/ce proxy: local node unreachable (${nodeApi}): ${e.message}`);
  });
  req.pipe(upstream);
}

// Start the per-app frontend host. Serves `root` statically, injects CSP +
// bridge into HTML, reverse-proxies CE_PROXY_PREFIX to the local node, and
// serves the same-origin bridge bootstrap. Resolves to { server, port, url }.
function startServeServer(root, { port = 0, nodeApi = DEFAULT_NODE_API, spa = true } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const urlPath = (req.url || "/").split("?")[0];

        // (a) the same-origin bridge bootstrap script.
        if (urlPath === CE_BRIDGE_PATH) {
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "content-security-policy": CE_STRICT_CSP,
            "cache-control": "no-store",
          });
          res.end(CE_BRIDGE_BOOTSTRAP);
          return;
        }

        // (b) same-origin reverse proxy to the local node.
        if (urlPath === CE_PROXY_PREFIX || urlPath.startsWith(CE_PROXY_PREFIX + "/")) {
          proxyToNode(req, res, nodeApi);
          return;
        }

        // (c) static file serving from the built output.
        const file = resolveServedFile(root, req.url || "/");
        if (!file) {
          res.writeHead(403, { "content-type": "text/plain", "content-security-policy": CE_STRICT_CSP });
          res.end("forbidden");
          return;
        }
        let target = file;
        let stat = await fs.stat(target).catch(() => null);
        if (stat && stat.isDirectory()) {
          target = path.join(target, "index.html");
          stat = await fs.stat(target).catch(() => null);
        }
        // SPA fallback: serve index.html for unknown non-asset routes.
        if (!stat || !stat.isFile()) {
          if (spa && !path.extname(urlPath)) {
            target = path.join(root, "index.html");
            stat = await fs.stat(target).catch(() => null);
          }
        }
        if (!stat || !stat.isFile()) {
          res.writeHead(404, { "content-type": "text/plain", "content-security-policy": CE_STRICT_CSP });
          res.end("not found");
          return;
        }

        const ct = contentType(target);
        const isHtml = ct.startsWith("text/html");
        const baseHeaders = {
          "content-type": ct,
          "content-security-policy": CE_STRICT_CSP,
          "x-content-type-options": "nosniff",
        };
        if (isHtml) {
          const html = await fs.readFile(target, "utf8");
          const injected = injectIntoHtml(html);
          const buf = Buffer.from(injected, "utf8");
          res.writeHead(200, { ...baseHeaders, "content-length": buf.length, "cache-control": "no-store" });
          res.end(buf);
        } else {
          const buf = await fs.readFile(target);
          res.writeHead(200, { ...baseHeaders, "content-length": buf.length });
          res.end(buf);
        }
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain", "content-security-policy": CE_STRICT_CSP });
        res.end(`serve error: ${e && e.message ? e.message : e}`);
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}/` });
    });
  });
}

// Build the sub-app the user asked for (default: the detected frontend at cwd)
// and return its absolute output dir. `sub` selects a subdirectory (a monorepo
// sub-app) to build/serve instead of cwd.
async function buildSubApp(cwd, sub, { skipBuild = false } = {}) {
  const root = sub ? path.resolve(cwd, sub) : cwd;
  if (!fssync.existsSync(root)) {
    throw new Error(`sub-app directory not found: ${path.relative(cwd, root) || root}`);
  }
  const recipe = detectFramework(root);
  if (!skipBuild) {
    console.log(`Detected: ${recipe.label}`);
    await recipe.build(root);
  }
  const outDir = resolveOutDir(root, recipe);
  if (!fssync.existsSync(outDir)) {
    throw new Error(
      `build output not found (looked for: ${recipe.outDirs.join(", ")} in ${root}). ` +
        `Check your framework's build config.`
    );
  }
  return { root, recipe, outDir };
}

// Locate the ce-expose binary. Honors $CE_EXPOSE_BIN, then PATH ("ce-expose"),
// then a sibling target/release build in the ce-net workspace.
function ceExposeBin() {
  if (process.env.CE_EXPOSE_BIN) return process.env.CE_EXPOSE_BIN;
  if (hasBin("ce-expose")) return "ce-expose";
  // Best-effort: a local cargo build of the sibling ce-expose repo.
  const guesses = [
    path.join(__dirname, "..", "..", "..", "ce-expose", "target", "release", "ce-expose"),
    path.join(os.homedir(), "ce-net", "ce-expose", "target", "release", "ce-expose"),
  ];
  for (const g of guesses) {
    try { if (fssync.existsSync(g)) return g; } catch (_) {}
  }
  return "ce-expose"; // let spawn surface ENOENT with a clear message
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function listTemplates() {
  const tplRoot = path.join(__dirname, "..", "templates");
  try {
    const entries = await fs.readdir(tplRoot, { withFileTypes: true });
    const names = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let desc = "";
      const pkg = readJsonSafe(path.join(tplRoot, e.name, "package.json"));
      if (pkg && pkg.description) desc = pkg.description;
      // Rust templates have no package.json — pull the description from Cargo.toml.
      if (!desc) {
        const cargo = readTextSafe(path.join(tplRoot, e.name, "Cargo.toml"));
        const m = cargo && cargo.match(/^\s*description\s*=\s*["']([^"']+)["']/m);
        if (m) desc = m[1];
      }
      names.push({ name: e.name, desc });
    }
    return names.sort((a, b) => a.name.localeCompare(b.name));
  } catch (_) {
    return [];
  }
}

async function cmdNew(opts) {
  const template = opts._[1];

  if (!template) {
    const tpls = await listTemplates();
    console.log("Available templates:\n");
    if (tpls.length === 0) {
      console.log("  (none found in templates/)");
    } else {
      const w = Math.max(...tpls.map((t) => t.name.length));
      for (const t of tpls) {
        console.log(`  ${t.name.padEnd(w)}  ${t.desc}`);
      }
    }
    console.log("\nUsage: ce-app new <template> [dir]");
    return;
  }

  const dir = opts._[2] || template;
  const target = path.resolve(process.cwd(), dir);

  // Templates live in web/ce-app/templates/<template> (owned by another agent).
  const tplDir = path.join(__dirname, "..", "templates", template);
  await fs.mkdir(target, { recursive: true });

  if (fssync.existsSync(tplDir)) {
    await copyTree(tplDir, target);
    console.log(`Scaffolded "${template}" -> ${path.relative(process.cwd(), target) || "."}`);
  } else {
    const tpls = await listTemplates();
    console.log(`Template "${template}" not found in templates/.`);
    if (tpls.length) console.log(`Available: ${tpls.map((t) => t.name).join(", ")}`);
    // Fallback minimal scaffold so `new` still works for arbitrary names.
    await writeFallbackTemplate(target, template);
    console.log(`Wrote a minimal starter -> ${path.relative(process.cwd(), target) || "."}`);
  }
  console.log("");
  console.log("Next:");
  if (dir !== ".") console.log(`  cd ${dir}`);
  console.log("  npm install");
  console.log("  ce-app dev");
}

async function copyTree(src, dst) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".ce" || e.name === "dist" || e.name === "out") continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await copyTree(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function writeFallbackTemplate(target, template) {
  await fs.mkdir(path.join(target, "src"), { recursive: true });
  await fs.writeFile(
    path.join(target, "src", "index.html"),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${template} · ce-app</title>
  </head>
  <body>
    <main id="app"></main>
  </body>
</html>
`
  );
  await fs.writeFile(
    path.join(target, "src", "main.ts"),
    `// Minimal starter. Real templates import { createClient } from "@ce/client".
// This fallback is dependency-free so it builds before \`npm install\`.
const appId = (location.pathname.match(/\\/apps\\/([^/]+)\\//) || [, "demo"])[1];
const app = document.getElementById("app");
if (app) app.textContent = "Hello from ce-app (" + appId + ")";
export {};
`
  );
  await fs.writeFile(
    path.join(target, "package.json"),
    JSON.stringify(
      {
        name: template + "-ce-app",
        private: true,
        type: "module",
        scripts: { dev: "ce-app dev", deploy: "ce-app deploy" },
        dependencies: { "@ce/client": "latest" },
        devDependencies: { "ce-app": "latest" },
      },
      null,
      2
    ) + "\n"
  );
  await fs.writeFile(path.join(target, ".gitignore"), "node_modules\ndist\nout\n.ce\n");
}

// Legacy hub deploy: PUT the built files to the central hub. Kept as an escape
// hatch behind --hub-deploy / --hub <base> for the wave-1 hub; the default
// `ce-app deploy` now serves over the mesh (cmdDeploy below).
async function cmdHubDeploy(opts) {
  const cwd = process.cwd();
  const appId = await resolveAppId(cwd, opts);
  const recipe = detectFramework(cwd);

  console.log(`ce-app deploy (hub)  app=${appId}  hub=${opts.hub}`);
  console.log(`Detected: ${recipe.label}`);
  await recipe.build(cwd);
  const outDir = resolveOutDir(cwd, recipe);
  if (!fssync.existsSync(outDir)) {
    throw new Error(
      `build output not found (looked for: ${recipe.outDirs.join(", ")} in ${cwd}). ` +
        `Check your framework's build config.`
    );
  }
  console.log(`Output: ${path.relative(cwd, outDir) || "."}`);

  // Probe the hub's per-file cap so we can warn on oversized wasm before upload.
  const limits = await probeHubLimits(opts.hub);
  const { uploaded, total } = await uploadDir(opts.hub, appId, outDir, null, {
    maxAppFile: limits.maxAppFile,
  });

  // SPAs (React Router / SvelteKit / Vue Router / etc.) need server-side fallback to
  // index.html for client routes; tell the hub to enable it for this app.
  const cfg = await setAppConfig(opts.hub, appId, { spa: true });
  if (cfg.ok) console.log("SPA fallback: enabled");
  else console.log(`SPA fallback: could not set (${cfg.status || cfg.error || "unknown"}) — non-fatal`);

  const urls = appUrls(opts.hub, appId);
  console.log(`\nUploaded ${uploaded}/${total} file(s).`);
  console.log("Live at both URLs (same origin):");
  console.log(`  ${urls.subdomain}`);
  console.log(`  ${urls.path}`);
  if (_esbuildCtx) {
    try { await _esbuildCtx.dispose(); } catch (_) {}
    _esbuildCtx = null;
  }
  return urls.subdomain;
}

// ---------------------------------------------------------------------------
// register — claim this app's name on the mesh + advertise discovery (no hub)
// ---------------------------------------------------------------------------

async function cmdRegister(opts) {
  const cwd = process.cwd();
  const appId = await resolveAppId(cwd, opts);
  const name = meshNameFor(appId);
  const nodeApi = opts.nodeApi || DEFAULT_NODE_API;

  console.log(`ce-app register  app=${appId}  name=${name}  node=${nodeApi}`);

  // Who are we on the mesh? (best-effort — the node may be down.)
  const status = await nodeGet(nodeApi, "/status");
  const nodeId = status.json && (status.json.node_id || status.json.nodeId);
  if (nodeId) console.log(`mesh node id: ${nodeId}`);
  else console.log("mesh node id: (local node not reachable — is `ce start` running?)");

  // 1) Claim the name on-chain — the SAME path ce-expose uses (POST /names/claim).
  //    First claim wins; takes effect once mined. Best-effort: a re-claim of a
  //    name we already own (or one taken) is non-fatal, exactly like ce-expose.
  const claim = await nodePost(nodeApi, "/names/claim", { name });
  if (claim.ok) {
    console.log(`name claimed: ${name} (pending mine; first claim wins)`);
  } else {
    const why = (claim.json && (claim.json.error || claim.json.message)) || claim.text || `HTTP ${claim.status}`;
    console.log(`name claim skipped: ${why} (may already be yours or taken — non-fatal)`);
  }

  // 2) Advertise discovery so peers can find the app by name with no central index.
  //    Mirror ce-expose's "expose:<name>" + add an "app:<name>" service tag.
  for (const svc of [`expose:${name}`, `app:${name}`]) {
    const adv = await nodePost(nodeApi, "/discovery/advertise", { service: svc });
    if (adv.ok) console.log(`advertised: ${svc}`);
    else console.log(`advertise skipped (${svc}): ${(adv.json && adv.json.error) || adv.text || adv.status}`);
  }

  console.log("");
  console.log("Mesh identity:");
  console.log(`  name:    ${name}`);
  if (nodeId) console.log(`  node:    ${nodeId}`);
  console.log(`  serve:   ce-app serve            # host this app locally under the strict CSP`);
  console.log(`  expose:  ce-app expose --domain ${name}   # serve over mesh HTTP ingress`);
  console.log("");
  console.log("No central hub: the app is reachable by its mesh name once mined + advertised.");
  return name;
}

// ---------------------------------------------------------------------------
// serve — build a sub-app and run the per-app frontend host (CSP + bridge + /ce)
// ---------------------------------------------------------------------------

async function cmdServe(opts) {
  const cwd = process.cwd();
  const sub = opts.sub;
  const wantPort = opts.port ? Number(opts.port) : 0;
  const nodeApi = opts.nodeApi || DEFAULT_NODE_API;

  console.log(`ce-app serve${sub ? `  sub=${sub}` : ""}  node=${nodeApi}`);
  const { outDir, recipe } = await buildSubApp(cwd, sub, { skipBuild: opts.noBuild });
  console.log(`Serving: ${path.relative(cwd, outDir) || "."}  (${recipe.label})`);

  const { server, port, url } = await startServeServer(outDir, { port: wantPort, nodeApi });

  console.log("");
  console.log(`Frontend host:   ${url}`);
  console.log(`Strict CSP:      injected on every response (connect-src 'self')`);
  console.log(`Bridge:          ${CE_BRIDGE_PATH} (window.__ceNode bootstrap)`);
  console.log(`Node proxy:      ${CE_PROXY_PREFIX}  ->  ${nodeApi}  (same-origin mesh calls)`);
  console.log("");
  console.log(`Next: ce-app expose --domain <name>  (serves this over https://<name>.user.ce-net.com)`);
  console.log("Ctrl-C to stop.");

  // Keep the process alive; clean shutdown on SIGINT. Return the live port so
  // callers (dev/deploy) can chain `expose` against it.
  await new Promise((resolve) => {
    process.on("SIGINT", () => {
      try { server.close(); } catch (_) {}
      resolve();
    });
  });
  return { port, url };
}

// ---------------------------------------------------------------------------
// expose — run the ce-expose ORIGIN agent against the serve port (mesh ingress)
//
// We do NOT touch the ce-expose repo. We build + serve the app locally, then
// shell out to the ce-expose binary: `ce-expose http <servePort> --name <name>`.
// That carries this local host onto https://<name>.user.ce-net.com over mesh
// HTTP ingress (the relay-tier ingress feature ce-expose already implements).
// ---------------------------------------------------------------------------

async function cmdExpose(opts) {
  const cwd = process.cwd();
  const domain = (opts.domain || "").trim();
  if (!domain) throw new Error("usage: ce-app expose --domain <name> [--sub <which>]");
  const name = meshNameFor(domain);
  const sub = opts.sub;
  const wantPort = opts.port ? Number(opts.port) : 0;
  const nodeApi = opts.nodeApi || DEFAULT_NODE_API;

  console.log(`ce-app expose  domain=${name}${sub ? `  sub=${sub}` : ""}`);

  // 1) Build + serve the app locally (the ce-expose ORIGIN points at this port).
  const { outDir, recipe } = await buildSubApp(cwd, sub, { skipBuild: opts.noBuild });
  console.log(`Serving: ${path.relative(cwd, outDir) || "."}  (${recipe.label})`);
  const { server, port, url } = await startServeServer(outDir, { port: wantPort, nodeApi });
  console.log(`Frontend host:   ${url}  (CSP + bridge + ${CE_PROXY_PREFIX} proxy)`);

  // 2) Shell out to the ce-expose ORIGIN agent against the serve port. We do not
  //    edit ce-expose — just invoke its binary with the chosen name.
  const bin = ceExposeBin();
  const args = ["http", String(port), "--name", name];
  console.log(`Origin agent:    ${bin} ${args.join(" ")}`);
  console.log("");
  console.log(`URL:  https://${name}.user.ce-net.com/`);
  console.log("");

  const child = spawn(bin, args, { cwd, stdio: "inherit" });
  const cleanup = () => {
    try { child.kill(); } catch (_) {}
    try { server.close(); } catch (_) {}
  };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  await new Promise((resolve) => {
    child.on("error", (e) => {
      console.error(
        `ce-app: could not launch ce-expose (${e.code === "ENOENT" ? "binary not found" : e.message}).\n` +
          `Install/build ce-expose, or set CE_EXPOSE_BIN to its path. ` +
          `The local frontend host is still running at ${url}.`
      );
      // Keep serving locally even if expose could not start; the user can Ctrl-C.
    });
    child.on("exit", (code) => {
      console.log(`ce-expose exited (${code}); stopping local frontend host.`);
      try { server.close(); } catch (_) {}
      resolve();
    });
  });
  return { name, port, url: `https://${name}.user.ce-net.com/` };
}

// Legacy hub dev: build + watch + live-upload to the central hub. Kept behind
// --hub <base>; the default `ce-app dev` now serves over the mesh (cmdDev below).
async function cmdHubDev(opts) {
  const cwd = process.cwd();
  const appId = await resolveAppId(cwd, opts);
  const recipe = detectFramework(cwd);
  // dev uses esbuild's fast in-process watch when the project is esbuild-shaped;
  // vite projects get vite --watch; other frameworks fall back to rebuild-on-change.
  const isEsbuild = recipe.id === "esbuild";
  const isVite = recipe.id === "vite";
  const outDir = isEsbuild ? path.join(cwd, "out") : resolveOutDir(cwd, recipe);
  const urls = appUrls(opts.hub, appId);
  const url = urls.path; // [push] log target

  console.log(`ce-app dev  app=${appId}  hub=${opts.hub}  builder=${recipe.id}`);
  console.log("Live at both URLs (same origin):");
  console.log(`  ${urls.subdomain}`);
  console.log(`  ${urls.path}\n`);

  const { default: chokidar } = await import("chokidar");
  // Probe the per-file cap once so dev pushes warn on oversized wasm too.
  const limits = await probeHubLimits(opts.hub);
  let prev = new Map();
  let rebuilding = false;
  let pending = false;

  async function buildAndUpload(reason, doBuild) {
    if (rebuilding) {
      pending = true;
      return;
    }
    rebuilding = true;
    try {
      if (reason) console.log(`[build] ${reason}`);
      if (doBuild) await doBuild();
      const { next, uploaded } = await uploadDir(opts.hub, appId, outDir, prev, {
        quiet: false,
        maxAppFile: limits.maxAppFile,
      });
      prev = next;
      if (uploaded > 0) console.log(`[push] ${uploaded} file(s) -> ${url}`);
    } catch (e) {
      console.error(`[error] ${e.message}`);
    } finally {
      rebuilding = false;
      if (pending) {
        pending = false;
        buildAndUpload("rebuild (queued)", doBuild);
      }
    }
  }

  if (isVite && recipe.watch) {
    // vite --watch rebuilds dist; we just watch dist and push changes.
    const vp = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["vite", "build", "--watch"],
      { cwd, stdio: "inherit", shell: process.platform === "win32" }
    );
    vp.on("error", (e) => console.error(`[vite] ${e.message}`));
    const distWatcher = chokidar.watch(outDir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 150 },
    });
    const debounced = debounce(() => buildAndUpload(null, null), 200);
    distWatcher.on("add", debounced).on("change", debounced).on("unlink", debounced);
    process.on("SIGINT", () => {
      try { vp.kill(); } catch (_) {}
      process.exit(0);
    });
  } else if (isEsbuild) {
    const doBuild = () => esbuildBuild(cwd, outDir);
    await buildAndUpload("initial", doBuild);
    const watchPaths = ["src", "public", "index.html"]
      .map((p) => path.join(cwd, p))
      .filter((p) => fssync.existsSync(p));
    const watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      ignored: /(^|[\\/])(node_modules|\.ce|out|dist|build)([\\/]|$)/,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    const debounced = debounce((p) => buildAndUpload(`changed ${path.relative(cwd, p)}`, doBuild), 120);
    watcher.on("add", debounced).on("change", debounced).on("unlink", debounced);
    process.on("SIGINT", async () => {
      try { await watcher.close(); } catch (_) {}
      await disposeEsbuild();
      process.exit(0);
    });
    console.log("\nWatching for changes (Ctrl-C to stop)…");
  } else {
    // Generic framework: full build on each change to src/. Slower but correct.
    const doBuild = () => recipe.build(cwd);
    await buildAndUpload(`initial (${recipe.label})`, doBuild);
    const watchPaths = ["src", "app", "pages", "public", "static", "index.html", "Cargo.toml"]
      .map((p) => path.join(cwd, p))
      .filter((p) => fssync.existsSync(p));
    const watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      ignored: /(^|[\\/])(node_modules|\.ce|out|dist|build|target|pkg|\.next|\.output|\.svelte-kit)([\\/]|$)/,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    const debounced = debounce((p) => buildAndUpload(`changed ${path.relative(cwd, p)}`, doBuild), 250);
    watcher.on("add", debounced).on("change", debounced).on("unlink", debounced);
    process.on("SIGINT", async () => {
      try { await watcher.close(); } catch (_) {}
      process.exit(0);
    });
    console.log("\nWatching for changes (Ctrl-C to stop)…");
  }
}

// ---------------------------------------------------------------------------
// deploy / dev — mesh-first (default), with --hub as the legacy escape hatch
//
// deploy:  register on the mesh, then serve (+ expose if --domain/--expose).
// dev:     register on the mesh, then serve with the frontend host.
// Both default to the mesh; pass --hub <base> (or --hub-deploy) to use the old
// central-hub static upload path instead.
// ---------------------------------------------------------------------------

// True when the user explicitly opted into the legacy central-hub path: either
// --hub-deploy, or an explicit --hub <base> on the command line (NOT the default
// that parseArgs fills in). We detect the explicit form from raw argv.
function wantsHub(opts) {
  if (opts.hubDeploy) return true;
  const argv = process.argv.slice(2);
  return argv.some((a) => a === "--hub" || a.startsWith("--hub="));
}

async function cmdDeploy(opts) {
  if (wantsHub(opts)) return cmdHubDeploy(opts);

  // Mesh path: register the app, then serve it (optionally expose over ingress).
  await cmdRegister(opts);
  console.log("");

  // If the user asked to expose (a domain), run the origin agent (which also
  // builds + serves). Otherwise just run the local frontend host.
  if (opts.domain || opts.expose) {
    const domain = opts.domain || (await resolveAppId(process.cwd(), opts));
    return cmdExpose({ ...opts, domain });
  }
  return cmdServe(opts);
}

async function cmdDev(opts) {
  if (wantsHub(opts)) return cmdHubDev(opts);

  // Mesh path: register, then run the per-app frontend host. Hot-reload of the
  // built output happens through the framework's own --watch (run it alongside);
  // the serve host always reads fresh from disk (no-store), so rebuilds appear on
  // reload. (The legacy live-upload loop is the --hub path.)
  await cmdRegister(opts);
  console.log("");
  if (opts.domain || opts.expose) {
    const domain = opts.domain || (await resolveAppId(process.cwd(), opts));
    return cmdExpose({ ...opts, domain });
  }
  return cmdServe(opts);
}

// ---------------------------------------------------------------------------
// custom domains
// ---------------------------------------------------------------------------

async function cmdDomain(opts) {
  const sub = opts._[1];
  const cwd = process.cwd();

  if (sub === "ls" || sub === "list") {
    const appId = await resolveAppId(cwd, opts);
    const res = await fetch(`${opts.hub}/domains`);
    if (!res.ok) throw new Error(`GET /domains -> ${res.status}`);
    const all = await res.json();
    const mine = (Array.isArray(all) ? all : []).filter((d) => d.id === appId);
    if (mine.length === 0) {
      console.log(`No custom domains registered for app ${appId}.`);
    } else {
      console.log(`Custom domains for app ${appId}:`);
      for (const d of mine) console.log(`  ${d.domain}`);
    }
    return;
  }

  if (sub === "add") {
    const domain = (opts._[2] || "").toLowerCase().trim();
    if (!domain) throw new Error("usage: ce-app domain add <domain>");
    const appId = await resolveAppId(cwd, opts);
    const res = await signedFetch(`${opts.hub}/apps/${encodeURIComponent(appId)}/domain`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`PUT /apps/${appId}/domain -> ${res.status} ${txt}`);
    }
    const body = await res.json().catch(() => ({}));
    const cname = body.cname || "ce-net.com";
    console.log(`Registered ${domain} -> app ${appId}.\n`);
    console.log("DNS — add a CNAME at your domain provider:");
    console.log(`  CNAME  ${domain}  ->  ${cname}`);
    console.log("");
    console.log("TLS — pick one:");
    console.log("  - Cloudflare for SaaS (custom hostnames): add the hostname in your CE");
    console.log("    Cloudflare account so it terminates TLS for your domain automatically.");
    console.log("  - Origin certificate: install a cert for your domain on the relay/origin.");
    console.log("");
    console.log(`Once DNS propagates, your app is live at https://${domain}/`);
    return;
  }

  if (sub === "rm" || sub === "remove") {
    const domain = (opts._[2] || "").toLowerCase().trim();
    if (!domain) throw new Error("usage: ce-app domain rm <domain>");
    const appId = await resolveAppId(cwd, opts);
    const res = await signedFetch(
      `${opts.hub}/apps/${encodeURIComponent(appId)}/domain/${encodeURIComponent(domain)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`DELETE /apps/${appId}/domain/${domain} -> ${res.status} ${txt}`);
    }
    console.log(`Removed ${domain} from app ${appId}.`);
    return;
  }

  console.log("Usage:\n  ce-app domain add <domain>\n  ce-app domain rm <domain>\n  ce-app domain ls");
}

// ---------------------------------------------------------------------------
// whoami — print the stable public id + derived nodeprefix (no network)
// ---------------------------------------------------------------------------

async function cmdWhoami(opts) {
  const cwd = process.cwd();
  const ident = await resolveIdentity();
  const id = ident.id;
  const prefix = nodePrefix(id);
  const project = resolveProjectName(cwd, opts && opts.project);
  const appId = await resolveAppId(cwd, opts);
  const urls = appUrls(opts.hub, appId);

  // Human-readable "where it came from" for the single identity.
  const whereBySource = {
    "ce-node": `ce id (CE node) — secret key at ${ident.keyPath || "~/.local/share/ce/identity/node.key"}`,
    "ce-node (no local key)": "ce id (CE node) — no local secret key found; writes are anonymous (still valid)",
    "local-keypair": `local keypair at ${ident.keyPath || ceIdentityDir()}`,
  };
  const where = whereBySource[ident.source] || ident.source;

  console.log(`id:         ${id}`);
  console.log(`nodeprefix: ${prefix}`);
  console.log(`source:     ${ident.source}`);
  console.log(`from:       ${where}`);
  console.log(`pubkey:     ${ident.publicKey}`);
  console.log(`signing:    ${ident.signer ? "enabled (mutating requests are signed)" : "disabled (no secret key — anonymous writes)"}`);
  console.log(`project:    ${project}`);
  console.log(`app id:     ${appId}`);
  console.log("urls:");
  console.log(`  ${urls.subdomain}`);
  console.log(`  ${urls.path}`);
}

// ---------------------------------------------------------------------------
// link — document the device-pairing flow (capability/QR). STUB for wave 1:
// it prints the designed flow; the full pairing transport ships later.
// ---------------------------------------------------------------------------

async function cmdLink(opts) {
  const ident = await resolveIdentity();
  const id = ident.id;
  // A pairing payload a second device would consume (printed as a documented stub).
  const payload = {
    v: 1,
    kind: "ce-pair",
    id,
    pubkey: ident.publicKey,
    hub: opts.hub,
    // a short-lived pairing challenge the new device signs to prove possession
    nonce: crypto.randomBytes(16).toString("hex"),
    ts: Date.now(),
  };
  const token = Buffer.from(JSON.stringify(payload)).toString("base64url");

  console.log("ce-app link — device pairing (DESIGN STUB, not yet a live transport)\n");
  console.log("CE's locked design is ONE identity per person, reused across every device.");
  console.log("A second device does NOT mint a new id; it converges on this one via a");
  console.log("signed capability, the same primitive CE uses everywhere (see ce/docs/");
  console.log("capabilities.md). The flow:\n");
  console.log("  1. On THIS device (already holding the identity), start a pairing offer.");
  console.log("     It encodes your id + pubkey + hub + a one-time nonce:");
  console.log("");
  console.log(`     id:     ${id}`);
  console.log(`     pubkey: ${ident.publicKey}`);
  console.log("");
  console.log("     Pairing token (scan as a QR, or paste on the new device):");
  console.log(`     ${token}`);
  console.log("");
  console.log("  2. On the NEW device, run `ce-app link <token>`. It generates its own");
  console.log("     ephemeral keypair, signs the nonce (proof of possession), and asks");
  console.log("     this device to issue a capability over the relay rendezvous room.");
  console.log("");
  console.log("  3. THIS device verifies the proof and self-issues a signed, attenuating");
  console.log("     capability (ability: \"app:write\", scoped + expiring) to the new device,");
  console.log("     rooted at this identity's key — exactly like `ce grant`. The new device");
  console.log("     stores it and now writes as the SAME identity (x-ce-id stays constant;");
  console.log("     it presents the capability chain alongside its own signature).");
  console.log("");
  console.log("Status: the QR/relay transport + capability issuance land in a later wave.");
  console.log("Today this prints the flow and a valid pairing token so tooling can build on");
  console.log("the canonical shape. Nothing here changes your single identity.");

  // If a token was passed, show what the NEW-device side would do (still a stub).
  const incoming = opts._[1];
  if (incoming) {
    console.log("\n--- new-device side (stub) ---");
    let decoded = null;
    try {
      decoded = JSON.parse(Buffer.from(incoming, "base64url").toString("utf8"));
    } catch (_) {
      console.log("  the provided token is not a valid ce-pair token.");
      return;
    }
    if (!decoded || decoded.kind !== "ce-pair") {
      console.log("  the provided token is not a ce-pair token.");
      return;
    }
    console.log(`  would converge on identity ${decoded.id}`);
    console.log(`  would sign nonce ${decoded.nonce} to prove possession, then request a`);
    console.log(`  capability (ability: app:write) from that identity over ${decoded.hub}.`);
    console.log("  (transport not yet implemented — wave 2.)");
  }
}

// ---------------------------------------------------------------------------
// detect — print the detected framework + output dir (no network)
// ---------------------------------------------------------------------------

async function cmdDetect(opts) {
  const cwd = process.cwd();
  const recipe = detectFramework(cwd);
  console.log(`framework: ${recipe.id}`);
  console.log(`label:     ${recipe.label}`);
  console.log(`outDirs:   ${recipe.outDirs.join(", ")}`);
  if (recipe.rust) {
    console.log(`variant:   ${recipe.variant}`);
    console.log(`tools:     ${(recipe.tools || []).join(", ")}`);
    // Best-effort, no-throw presence check so `detect` is a quick toolchain audit.
    const status = (recipe.tools || []).map((t) => {
      if (t === "rustc" || t === "cargo") return `${t}:${hasBin(t) ? "ok" : "MISSING"}`;
      if (t === "trunk") return `trunk:${hasBin("trunk") ? "ok" : "MISSING"}`;
      if (t === "wasm-pack") return `wasm-pack:${hasBin("wasm-pack") ? "ok" : "MISSING"}`;
      return t;
    });
    const wasmTarget = probeCmd("rustup", ["target", "list", "--installed"], cwd);
    const haveTarget = wasmTarget.ok && /wasm32-unknown-unknown/.test(wasmTarget.stdout);
    status.push(`wasm32-target:${haveTarget ? "ok" : "MISSING"}`);
    status.push(`wasm-opt:${hasWasmOpt() ? "ok" : "absent (optional)"}`);
    console.log(`toolchain: ${status.join("  ")}`);
  }
  if (recipe.baseHint) console.log(`note:      ${recipe.baseHint}`);
}

// ---------------------------------------------------------------------------
// smoke — local self-check (no network), incl. framework-detection fixtures
// ---------------------------------------------------------------------------

async function cmdSmoke() {
  const checks = [];
  const need = (cond, msg) => checks.push({ ok: !!cond, msg });

  // --- Part 1: esbuild fixture build ---
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ce-app-smoke-"));
  const out = path.join(tmp, "out");
  try {
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "src", "index.html"),
      `<!doctype html><html><head><meta charset="utf-8"><title>fix</title></head><body><div id="app"></div></body></html>`
    );
    await fs.writeFile(
      path.join(tmp, "src", "main.ts"),
      `const el = document.getElementById("app");\nif (el) el.textContent = "fixture " + (1 + 1);\nexport {};\n`
    );

    await esbuildBuild(tmp, out);

    const files = (await walk(out)).map((f) => f.rel).sort();
    const html = await fs.readFile(path.join(out, "index.html"), "utf8");
    const js = await fs.readFile(path.join(out, "main.js"), "utf8");

    need(files.includes("index.html"), "index.html emitted");
    need(files.includes("main.js"), "main.js emitted");
    need(files.includes("main.js.map"), "main.js.map emitted (sourcemap)");
    need(/src=["']\.?\/?main\.js["']/.test(html), "index.html references ./main.js");
    need(js.includes("fixture"), "bundle contains source string");
    need(contentType("a/b.wasm") === "application/wasm", "content-type map: wasm");
    need(contentType("x.HTML") === "text/html; charset=utf-8", "content-type map: html (case-insensitive)");
    need(contentType("f.woff2") === "font/woff2", "content-type map: woff2");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  // --- Part 2: framework detection against fixture package.json files ---
  // Each fixture: a deps spec (+ optional config files) -> expected recipe.id.
  const cases = [
    { name: "vite-vanilla", pkg: { devDependencies: { vite: "^5" } }, files: {}, expect: "vite" },
    {
      name: "vite-react",
      pkg: { dependencies: { react: "^18", "react-dom": "^18" }, devDependencies: { vite: "^5", "@vitejs/plugin-react": "^4" } },
      files: {},
      expect: "vite",
    },
    {
      name: "vite-vue",
      pkg: { dependencies: { vue: "^3" }, devDependencies: { vite: "^5" } },
      files: {},
      expect: "vite",
    },
    {
      name: "vite-by-config-only",
      pkg: { dependencies: {} },
      files: { "vite.config.ts": "export default {}" },
      expect: "vite",
    },
    {
      name: "sveltekit",
      pkg: { devDependencies: { "@sveltejs/kit": "^2", svelte: "^4", vite: "^5" } },
      files: { "svelte.config.js": "export default {}" },
      expect: "sveltekit",
    },
    {
      name: "next",
      pkg: { dependencies: { next: "^14", react: "^18", "react-dom": "^18" } },
      files: {},
      expect: "next",
    },
    {
      name: "next-by-config",
      pkg: { dependencies: {} },
      files: { "next.config.mjs": "export default {}" },
      expect: "next",
    },
    {
      name: "astro",
      pkg: { dependencies: { astro: "^4" } },
      files: {},
      expect: "astro",
    },
    {
      name: "expo",
      pkg: { dependencies: { expo: "^51", "react-native-web": "^0.19" } },
      files: {},
      expect: "expo",
    },
    {
      name: "cra",
      pkg: { dependencies: { react: "^18", "react-scripts": "5.0.1" } },
      files: {},
      expect: "cra",
    },
    {
      name: "nuxt",
      pkg: { dependencies: { nuxt: "^3" } },
      files: {},
      expect: "nuxt",
    },
    {
      name: "static",
      pkg: { name: "plain" },
      files: { "index.html": "<!doctype html><title>x</title>" },
      expect: "static",
    },
    {
      name: "esbuild-fallback",
      pkg: { name: "plain", dependencies: {} },
      files: { "src/main.ts": "export {};", "src/index.html": "<!doctype html>" },
      expect: "esbuild",
    },
    // --- Rust -> wasm variants (Cargo.toml at root selects the rust recipe) ---
    {
      name: "rust-trunk",
      pkg: null,
      files: {
        "Cargo.toml": '[package]\nname = "demo"\n[dependencies]\n',
        "Trunk.toml": "[build]\n",
        "index.html": '<!doctype html><link data-trunk rel="rust" />',
      },
      expect: "rust-trunk",
    },
    {
      name: "rust-wasm-pack",
      pkg: null,
      files: {
        "Cargo.toml": '[package]\nname = "demo"\n[lib]\ncrate-type = ["cdylib"]\n[dependencies]\nwasm-bindgen = "0.2"\n',
        "index.html": '<!doctype html><script type="module">import init from "./pkg/demo.js"</script>',
      },
      expect: "rust-wasm-pack",
    },
    {
      name: "rust-cargo",
      pkg: null,
      files: {
        "Cargo.toml": '[package]\nname = "demo"\n[lib]\ncrate-type = ["cdylib"]\n[dependencies]\n',
      },
      expect: "rust-cargo",
    },
  ];

  for (const c of cases) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ce-app-detect-${c.name}-`));
    try {
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(c.pkg, null, 2));
      for (const [rel, content] of Object.entries(c.files)) {
        const dest = path.join(dir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content);
      }
      const got = detectFramework(dir).id;
      need(got === c.expect, `detect ${c.name}: ${got} === ${c.expect}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  // --- Part 3: signing scheme — canonical string + Ed25519 sign/verify roundtrip ---
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const method = "PUT";
    const pathOnly = "/apps/demo-abc/index.html";
    const ts = "1700000000000";
    const nonce = "deadbeefcafebabe";
    const bodyHash = sha256Hex(Buffer.from("hello"));
    const canonical = [method, pathOnly, ts, nonce, bodyHash].join("\n");
    const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey);
    const verified = crypto.verify(null, Buffer.from(canonical, "utf8"), publicKey, sig);
    need(verified, "signing: Ed25519 sign/verify roundtrip over canonical string");
    need(canonical.split("\n").length === 5, "signing: canonical string is 5 newline-joined fields");
    need(sha256Hex(Buffer.alloc(0)).length === 64, "signing: sha256(empty body) is 64 hex chars");

    // makeSigner produces a hex signature that verifies.
    const signer = makeSigner(privateKey);
    const hexSig = signer(canonical);
    need(/^[0-9a-f]+$/.test(hexSig), "signing: makeSigner returns hex");
    need(
      crypto.verify(null, Buffer.from(canonical, "utf8"), publicKey, Buffer.from(hexSig, "hex")),
      "signing: makeSigner signature verifies"
    );

    // ed25519SeedToPkcs8: a raw 32-byte seed loads as an Ed25519 key.
    const seed = crypto.randomBytes(32);
    const loaded = crypto.createPrivateKey({ key: ed25519SeedToPkcs8(seed), format: "der", type: "pkcs8" });
    need(loaded.asymmetricKeyType === "ed25519", "signing: raw seed wraps into a loadable pkcs8 Ed25519 key");
  } catch (e) {
    need(false, `signing: roundtrip threw (${e.message})`);
  }

  // --- Part 4: rust dist assembly helpers (no toolchain needed) ---
  {
    const html = defaultWasmIndexHtml("my-game", "pkg");
    need(/import init from "\.\/pkg\/my_game\.js"/.test(html), "rust: wasm-pack index.html imports ./pkg/<crate>.js");
    need(contentType("x/app.wasm") === "application/wasm", "rust: .wasm content-type is application/wasm");
    const cargo = parseCargoToml('[package]\nname = "drift"\n[lib]\ncrate-type = ["cdylib", "rlib"]\n');
    need(cargo.name === "drift", "rust: parseCargoToml reads crate name");
    need(cargo.crateTypes.includes("cdylib"), "rust: parseCargoToml reads crate-type cdylib");
  }

  // --- report ---
  let allOk = true;
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.msg}`);
    if (!c.ok) allOk = false;
  }
  console.log(`\nsmoke: ${allOk ? "OK" : "FAILED"}  (${checks.length} checks)`);
  if (!allOk) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// wired-in sibling modules: slug / registry / debug
//
// slug.mjs, registry.mjs and debug.mjs are standalone, but each exports an
// argv-accepting dispatcher. We forward the raw args that follow the subcommand,
// and guarantee the resolved hub is present so the sibling hits the SAME hub
// ce-app does. The user's explicit --app / --project pass straight through (they
// are already in `rawArgs`); we never inject those — the modules derive them with
// the same logic ce-app uses, so the resolved identity drives the (working)
// signing. Their behavior is otherwise untouched.
// ---------------------------------------------------------------------------

// All of process.argv after the leading subcommand token (e.g. for
// `ce-app slug claim foo --json`, returns ["claim","foo","--json"]). Index 2 is
// the subcommand; everything after it is the sibling's own argv.
function rawArgsAfterCommand() {
  return process.argv.slice(3);
}

// Ensure --hub is present in an argv list; if not, append the resolved hub so the
// sibling module talks to the same hub ce-app resolved (default, $CE_HUB, or
// --hub). Does not touch an explicit --hub the user already passed.
function withHub(argv, hub) {
  const hasHub = argv.some((a) => a === "--hub" || a.startsWith("--hub="));
  return hasHub ? argv.slice() : [...argv, "--hub", hub];
}

// Print whatever a sibling dispatcher returns (string -> as-is; object -> JSON).
// runSlug / runRegistry return a value to print; runDebugCli prints itself and
// returns nothing.
function printResult(out) {
  if (out == null) return;
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
}

async function cmdSlug(opts) {
  // args after "slug" -> the slug subcommand + its args.
  printResult(await runSlug(withHub(rawArgsAfterCommand(), opts.hub)));
}

// publish / unpublish / project all live in registry.mjs. `verb` is the ce-app
// command; the args after it are the verb's own argv.
async function cmdRegistry(verb, opts) {
  printResult(await runRegistry(verb, withHub(rawArgsAfterCommand(), opts.hub)));
}

// doctor / logs / trace live in debug.mjs. runDebugCli expects the verb as the
// first argv element, so we prepend it to the forwarded args.
async function cmdDebug(verb, opts) {
  await runDebugCli(withHub([verb, ...rawArgsAfterCommand()], opts.hub));
}

// ---------------------------------------------------------------------------
// help + dispatch
// ---------------------------------------------------------------------------

const HELP = `ce-app — one command to a live, globally reachable, hot-reloading app

Usage:
  ce-app new [template] [dir]   Scaffold a template (no name -> list available)
  ce-app whoami                 Print your ONE identity + nodeprefix + where it came from
  ce-app link [token]           Print the device-pairing flow (capability/QR) — design stub
  ce-app register               Register this app on the mesh: claim its name + advertise (no hub)
  ce-app serve [--sub <w>]      Build + run the per-app frontend host (strict CSP, bridge, /ce proxy)
  ce-app expose --domain <name> Run the ce-expose origin agent over serve: https://<name>.user.ce-net.com
  ce-app dev                    Mesh: register + serve the frontend host (--hub for legacy live-upload)
  ce-app deploy                 Mesh: register + serve (+ --domain to expose) (--hub for legacy upload)
  ce-app domain add <domain>    Register a custom production domain for this app
  ce-app domain rm <domain>     Unregister a custom domain
  ce-app domain ls              List this app's custom domains
  ce-app slug <cmd> [name]      Human-readable names: claim/renew/release/ls/status
  ce-app publish                Publish this project to the public CE registry
  ce-app unpublish [id]         Remove a published project (owner only)
  ce-app project ls             List the public registry (GET /registry)
  ce-app doctor                 Health check: identity, hub, app, rooms, limits
  ce-app logs <app>             Stream the app's /rt/<app>/__debug room frames
  ce-app trace <app>            Time a deploy-shaped round-trip (--write for full)
  ce-app detect                 Print the detected framework + output dir (no network)
  ce-app smoke                  Build a fixture + run detection self-checks (no network)

  Run any of slug/publish/unpublish/project/doctor/logs/trace with --help for its
  own usage and flags.

Options:
  --sub <which>     Sub-app subdirectory to build/serve (default: the detected frontend)
  --port <N>        Port for the serve frontend host (default: an ephemeral port)
  --domain <name>   Mesh ingress name for expose (https://<name>.user.ce-net.com)
  --expose          On dev/deploy, also run the ce-expose origin agent
  --node-api <url>  Local CE node HTTP API for the /ce proxy (default: ${DEFAULT_NODE_API}, or $CE_NODE_API)
  --no-build        Serve the existing build output without rebuilding
  --hub <base>      LEGACY: central-hub static upload base (default: ${DEFAULT_HUB}, or $CE_HUB)
  --hub-deploy      LEGACY: force the central-hub static upload path on deploy/dev
  --project <name>  Project name for the app id (default: package.json name / dir)
  --app <id>        Override the full app id (default: ./.ce/app-id, then derived)
  -h, --help        Show this help

Mesh serve (the default for dev/deploy):
  ce-app serve hosts the built output locally and injects the STRICT CSP on every
  response (connect-src 'self'), the window.__ceNode bridge bootstrap (${CE_BRIDGE_PATH}),
  and a same-origin "${CE_PROXY_PREFIX}" reverse proxy to the local node (${DEFAULT_NODE_API}).
  Under that CSP a page reaches ONLY its own origin — the in-process node bridge or
  the "${CE_PROXY_PREFIX}" proxy — so stranger code can talk to the local CE node and nothing
  else. ce-app register claims the app's name on-chain (POST /names/claim, the same
  path ce-expose uses) and advertises it; ce-app expose carries the serve host onto
  https://<name>.user.ce-net.com via the ce-expose origin agent (its own binary).

Frameworks auto-detected on deploy: Rust -> wasm (+wgpu) via Trunk / wasm-pack /
raw cargo, Vite (vanilla/React/Vue/Svelte), SvelteKit (static adapter), Next.js
(static export), Astro (static), Nuxt (static generate), Create React App, Expo /
react-native-web (web export), plain static sites, and the built-in esbuild path
(src/main + src/index.html). A Cargo.toml at the project root selects the Rust
recipe. Templates: \`ce-app new rust-game\`, \`ce-app new rust-backend\`.

Identity (ONE per person, reused everywhere — invisible Tier-2):
  ce-app NEVER mints a second id. It resolves, in order:
    1) the CE node identity (\`ce id\`); its secret key at
       ~/.local/share/ce/identity/node.key signs your writes when present, or
    2) one local Ed25519 keypair at ~/.ce/identity, created once and reused.
  The old ~/.ce/id and per-project ./.ce/app-id MIGRATE to this single identity
  (existing deploys keep working). nodeprefix = the id's first 10 hex chars.
  Multiple devices converge on the one id via \`ce-app link\` (capability/QR).

Signed writes (invisible, forward-compatible):
  Every mutating request is signed: headers x-ce-id / x-ce-sig / x-ce-ts /
  x-ce-nonce over METHOD\\nPATH\\nts\\nnonce\\nsha256(body). The live hub ignores
  these today, so anonymous PUTs keep working; the wave-2 hub will verify them.

Domains:
  Each project deploys as "<project>-<nodeprefix>" and is live at BOTH
    ${DEFAULT_HUB}/apps/<project>-<nodeprefix>/
    https://<project>-<nodeprefix>.${hubHost(DEFAULT_HUB)}/
  Same origin either way; the single DNS label keeps wildcard TLS automatic.
  Hot reload is automatic (the hub injects a reload snippet into served HTML).
  Bring your own domain: CNAME it to ce-net.com, then \`ce-app domain add <domain>\`.
`;

// Commands delegated to the sibling modules. For these, a trailing --help means
// "show THIS subcommand's help", so we must NOT let the top-level --help guard
// swallow it — the sibling prints its own usage from the forwarded argv.
const DELEGATED = new Set(["slug", "publish", "unpublish", "project", "doctor", "logs", "trace"]);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];

  // Only fall through to the top-level help when the command is NOT a delegated
  // subcommand (those route --help to their own module). `ce-app --help` and a
  // bare `ce-app` still print the top-level help.
  if ((opts.help && !DELEGATED.has(cmd)) || cmd === "help" || !cmd) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "new":
      await cmdNew(opts);
      break;
    case "whoami":
      await cmdWhoami(opts);
      break;
    case "link":
      await cmdLink(opts);
      break;
    case "register":
      await cmdRegister(opts);
      break;
    case "serve":
      await cmdServe(opts);
      break;
    case "expose":
      await cmdExpose(opts);
      break;
    case "dev":
      await cmdDev(opts);
      break;
    case "deploy":
      await cmdDeploy(opts);
      break;
    case "domain":
      await cmdDomain(opts);
      break;
    case "slug":
      await cmdSlug(opts);
      break;
    case "publish":
    case "unpublish":
    case "project":
      await cmdRegistry(cmd, opts);
      break;
    case "doctor":
    case "logs":
    case "trace":
      await cmdDebug(cmd, opts);
      break;
    case "detect":
      await cmdDetect(opts);
      break;
    case "smoke":
      await cmdSmoke();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }

  // One-shot commands must not be kept alive by esbuild's persistent service.
  // Long-running hosts (`dev`, `serve`, `expose`) run until Ctrl-C. The mesh
  // `deploy` also blocks (its await above never resolves — it ends in
  // serve/expose), so it never reaches here; the legacy hub `deploy` returns and
  // SHOULD exit, so `deploy` is intentionally NOT in this set.
  const longRunning = new Set(["dev", "serve", "expose"]);
  if (!longRunning.has(cmd)) {
    await disposeEsbuild();
    process.exit(process.exitCode || 0);
  }
}

async function disposeEsbuild() {
  if (_esbuildCtx) {
    try { await _esbuildCtx.dispose(); } catch (_) {}
    _esbuildCtx = null;
  }
}

main().catch(async (e) => {
  console.error(`ce-app: ${e && e.stack ? e.stack : e}`);
  await disposeEsbuild();
  process.exit(1);
});
