#!/usr/bin/env node
// ce-app registry — publish a project to the public CE registry (so the site can
// render it), unpublish it, or list what's published. Screenshots are uploaded to
// the content-addressed blob store and pinned by the project record.
//
//   ce-app publish              read ce.json, upload screenshots, POST /projects
//   ce-app unpublish [id]       DELETE /projects/<id> (owner only)
//   ce-app project ls           GET /registry -> the public projects list
//
// Flags: --help  --hub <base>  --app <id>  --project <name>  --slug <name>
//        --title <t>  --desc <d>  --tags a,b,c  --site <url>  --private
//        --shot <file> (repeatable)  --id <project-id>  --json
//
// ce.json (or ce-app.json) fields consumed for a publish:
//   { "project"|"name"|"slug": "...",   // -> slug + derives the app id
//     "title": "...", "desc"|"description": "...",
//     "tags": ["..."], "site": "https://...",
//     "screenshots": ["docs/shot1.png", ...],   // local files, uploaded to /blobs
//     "public": true,  "app_id": "...", "id": "..." }
// CLI flags override config. With no title, the title falls back to the slug.
//
// Signing reuses the ONE CE identity + canonical scheme from slug.mjs (x-ce-id /
// x-ce-sig / x-ce-ts seconds / x-ce-nonce; sha256(body)-hex). Blobs are PUT to
// /blobs/<sha256-hex>; the hub re-verifies the hash. Standalone (Node 18+, ESM,
// no deps) AND exported for a one-line wire-up into ce-app.mjs (see EOF note).

import { promises as fs } from "node:fs";
import fssync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  resolveIdentity,
  signedHeaders,
  signedJson,
  apiBase,
  resolveAppId,
  resolveSlug,
  readCeConfig,
} from "./slug.mjs";

const DEFAULT_HUB = "https://ce-net.com";

// Content types for screenshots (the few that matter); default octet-stream.
const SHOT_CT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

function shotContentType(file) {
  return SHOT_CT[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function readTextSafe(p) {
  try { return fssync.readFileSync(p, "utf8"); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// blobs — sha256 a local screenshot and PUT it to /blobs/<hash>. Content-
// addressed: the path IS the hash, the hub re-derives and verifies it. Returns
// the hash (which goes into the project's screenshots[] and pins the blob).
// ---------------------------------------------------------------------------

async function uploadScreenshot(hub, file) {
  let buf;
  try {
    buf = await fs.readFile(file);
  } catch (_) {
    throw new Error(`screenshot not found: ${file}`);
  }
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const p = `/blobs/${hash}`;
  // PUT /blobs/:hash is not a signature-gated route, but signing it is harmless
  // and consistent; we send a plain authenticated-where-possible PUT.
  let headers = { "content-type": shotContentType(file) };
  try {
    headers = await signedHeaders("PUT", p, buf, headers);
  } catch (_) {
    // No key -> anonymous blob PUT is fine (blobs are open). Keep going.
    headers = { "content-type": shotContentType(file) };
  }
  const res = await fetch(`${apiBase(hub)}${p}`, { method: "PUT", headers, body: buf });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch (_) {}
    throw new Error(`PUT ${p} -> ${res.status} ${msg}`);
  }
  return { hash, size: buf.length, file };
}

async function uploadScreenshots(hub, files, { quiet = false } = {}) {
  const hashes = [];
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.resolve(process.cwd(), f);
    const r = await uploadScreenshot(hub, abs);
    hashes.push(r.hash);
    if (!quiet) console.log(`  shot  ${path.basename(f)} -> ${r.hash.slice(0, 12)}… (${r.size}b)`);
  }
  return hashes;
}

// ---------------------------------------------------------------------------
// build the project request body from ce.json + flags (flags win).
// ---------------------------------------------------------------------------

function csv(s) {
  return String(s).split(",").map((x) => x.trim()).filter(Boolean);
}

async function buildProjectReq(cwd, opts) {
  const cfg = readCeConfig(cwd);
  const slug = resolveSlug(cwd, opts, null);
  const appId = await resolveAppId(cwd, opts);

  const title = opts.title || cfg.title || slug;
  const desc = opts.desc != null ? opts.desc : (cfg.desc || cfg.description || "");
  const site = opts.site || cfg.site || `${opts.hub}/apps/${slug || appId}/`;
  const id = opts.id || cfg.id || undefined;

  let tags = [];
  if (opts.tags) tags = csv(opts.tags);
  else if (Array.isArray(cfg.tags)) tags = cfg.tags.map(String).filter(Boolean);

  // public defaults true; --private forces false; ce.json "public":false honored.
  let pub = true;
  if (opts.private) pub = false;
  else if (cfg.public === false) pub = false;

  // Screenshots: explicit local files (--shot, repeatable, or ce.json
  // "screenshots") are uploaded to blobs. Already-hashed entries (64-hex, no path
  // separator) are passed straight through as pre-existing blobs.
  const shotInputs = [];
  if (opts.shots && opts.shots.length) shotInputs.push(...opts.shots);
  else if (Array.isArray(cfg.screenshots)) shotInputs.push(...cfg.screenshots.map(String));

  const preHashed = [];
  const toUpload = [];
  for (const s of shotInputs) {
    if (/^[0-9a-f]{64}$/i.test(s)) preHashed.push(s.toLowerCase());
    else toUpload.push(s);
  }
  const uploaded = toUpload.length ? await uploadScreenshots(opts.hub, toUpload, { quiet: opts.json }) : [];
  const screenshots = [...preHashed, ...uploaded];

  const req = { title, slug, app_id: appId, desc, tags, screenshots, site, public: pub };
  if (id) req.id = id;
  return req;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdPublish(opts) {
  const cwd = process.cwd();
  const req = await buildProjectReq(cwd, opts);
  if (!req.title || !req.title.trim()) {
    throw new Error("a title is required — pass --title, or add \"title\"/\"slug\" to ce.json");
  }
  const data = await signedJson(opts.hub, "POST", "/projects", req);
  if (opts.json) return { ...data, request: req };
  return [
    `published  ${data.id}`,
    `  title    ${req.title}`,
    `  app      ${req.app_id}${req.slug ? `  (slug ${req.slug})` : ""}`,
    `  shots    ${req.screenshots.length}`,
    `  public   ${req.public}`,
    `  owner    ${data.owner}`,
    `  registry ${opts.hub}/registry`,
  ].join("\n");
}

async function cmdUnpublish(opts) {
  const cwd = process.cwd();
  // id: positional, --id, ce.json "id", else slug, else app id.
  let id = opts._[0] || opts.id;
  if (!id) {
    const cfg = readCeConfig(cwd);
    id = cfg.id || resolveSlug(cwd, opts, null) || (await resolveAppId(cwd, opts));
  }
  if (!id) throw new Error("no project id to unpublish (pass an id or --id)");
  id = String(id).toLowerCase();
  // DELETE /projects/:id is signed over an EMPTY body (no JSON body sent).
  const p = `/projects/${encodeURIComponent(id)}`;
  const headers = await signedHeaders("DELETE", p, Buffer.alloc(0), {});
  const res = await fetch(`${apiBase(opts.hub)}${p}`, { method: "DELETE", headers });
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`DELETE ${p} -> ${res.status} ${(data && data.error) || text}`);
  }
  if (opts.json) return data;
  return data && data.ok ? `unpublished  ${id}` : `not found  ${id} (nothing to unpublish)`;
}

// GET /registry is public (unsigned).
async function fetchRegistry(hub) {
  const res = await fetch(`${apiBase(hub)}/registry`);
  if (!res.ok) throw new Error(`GET /registry -> ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.projects) ? data.projects : [];
}

async function cmdProjectLs(opts) {
  const projects = await fetchRegistry(opts.hub);
  if (opts.json) return { projects, n: projects.length };
  if (!projects.length) return "registry is empty";
  // Optionally mark the caller's own projects.
  let mineOwner = null;
  try {
    const ident = await resolveIdentity();
    mineOwner = crypto.createHash("sha256").update(Buffer.from(ident.publicKey, "hex")).digest("hex").slice(0, 32);
  } catch (_) { /* no identity -> no mark */ }
  const lines = projects.map((e) => {
    const mine = mineOwner && e.owner === mineOwner ? "*" : " ";
    const live = e.hosted ? "hosted " : "offline";
    const tags = (e.tags || []).length ? `  [${e.tags.join(", ")}]` : "";
    const rooms = e.rooms ? `  rooms:${e.rooms}` : "";
    return `${mine} ${live}  ${e.id}  "${e.title}"${tags}${rooms}`;
  });
  return [`${projects.length} project(s) in the registry:`, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// arg parsing + dispatch
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    _: [], hub: process.env.CE_HUB || DEFAULT_HUB,
    app: undefined, project: undefined, slug: undefined,
    title: undefined, desc: undefined, tags: undefined, site: undefined,
    id: undefined, shots: [], private: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--private") opts.private = true;
    else if (a === "--hub") opts.hub = argv[++i];
    else if (a.startsWith("--hub=")) opts.hub = a.slice(6);
    else if (a === "--app") opts.app = argv[++i];
    else if (a.startsWith("--app=")) opts.app = a.slice(6);
    else if (a === "--project") opts.project = argv[++i];
    else if (a.startsWith("--project=")) opts.project = a.slice(10);
    else if (a === "--slug") opts.slug = argv[++i];
    else if (a.startsWith("--slug=")) opts.slug = a.slice(7);
    else if (a === "--title") opts.title = argv[++i];
    else if (a.startsWith("--title=")) opts.title = a.slice(8);
    else if (a === "--desc") opts.desc = argv[++i];
    else if (a.startsWith("--desc=")) opts.desc = a.slice(7);
    else if (a === "--tags") opts.tags = argv[++i];
    else if (a.startsWith("--tags=")) opts.tags = a.slice(7);
    else if (a === "--site") opts.site = argv[++i];
    else if (a.startsWith("--site=")) opts.site = a.slice(7);
    else if (a === "--id") opts.id = argv[++i];
    else if (a.startsWith("--id=")) opts.id = a.slice(5);
    else if (a === "--shot") opts.shots.push(argv[++i]);
    else if (a.startsWith("--shot=")) opts.shots.push(a.slice(7));
    else opts._.push(a);
  }
  if (opts.hub) opts.hub = String(opts.hub).replace(/\/+$/, "");
  return opts;
}

const HELP = `ce-app registry — publish your project to the public CE registry.

Usage:
  ce-app publish              upload screenshots + POST your project to /projects
  ce-app unpublish [id]       remove a project (owner only)
  ce-app project ls           list the public registry (GET /registry)

Publish reads ce.json (or ce-app.json):
  project|name|slug, title, desc|description, tags[], site,
  screenshots[] (local files -> uploaded to /blobs), public, app_id, id

Flags:
  --hub <base>      hub base URL (default: $CE_HUB or https://ce-net.com)
  --app <id>        app id the project points at (default: derived)
  --slug <name>     slug for the project (default: ce.json / project name)
  --project <name>  override the project name used to derive slug/app id
  --title <t>       project title (default: ce.json title, else slug)
  --desc <d>        short description
  --tags a,b,c      comma-separated tags
  --site <url>      canonical site URL for the project card
  --shot <file>     a screenshot to upload (repeatable; or ce.json screenshots[])
  --id <id>         stable project id (update an existing project)
  --private         publish unlisted (public:false)
  --json            machine-readable JSON output
  --help            this help

Writes are signed with your ONE CE identity; screenshots are content-addressed
blobs PUT to /blobs/<sha256> and pinned by the project record.`;

// Exported handler so ce-app.mjs can dispatch publish/unpublish/project.
//   verb = "publish" | "unpublish" | "project"
//   argv = the args AFTER that verb.
// Returns a string (human) or object (--json); throws on error.
export async function runRegistry(verb, argv) {
  const opts = parseArgs(argv);
  const v = (verb || "").toLowerCase();
  if (opts.help && v !== "project") return HELP;
  switch (v) {
    case "publish":
      return opts.help ? HELP : cmdPublish(opts);
    case "unpublish":
      return opts.help ? HELP : cmdUnpublish(opts);
    case "project": {
      const sub = (opts._.shift() || "").toLowerCase();
      if (opts.help || !sub || sub === "help") return HELP;
      if (sub === "ls" || sub === "list") return cmdProjectLs(opts);
      throw new Error(`unknown project subcommand "${sub}" (try: ls)`);
    }
    default:
      return HELP;
  }
}

export { uploadScreenshot, uploadScreenshots, buildProjectReq, fetchRegistry };

// Standalone entry: `node bin/registry.mjs <publish|unpublish|project> ...`
const _isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch (_) { return false; }
})();

if (_isMain) {
  const [verb, ...rest] = process.argv.slice(2);
  runRegistry(verb || "", rest)
    .then((out) => {
      if (out == null) return;
      console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    })
    .catch((e) => {
      console.error("error:", e.message || e);
      process.exit(1);
    });
}
