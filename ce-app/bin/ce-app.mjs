#!/usr/bin/env node
// ce-app — one command to a live, globally reachable, hot-reloading app.
//
//   ce-app new <template> [dir]   scaffold a template (chat, ...)
//   ce-app dev                    build + watch + live-upload, prints the public URL
//   ce-app deploy                 one-shot full upload (no watch)
//   ce-app smoke                  build a tiny fixture locally (no network) — self-check
//
// Flags: --help  --hub <base>  --app <id>
//
// Node 18+, ESM. Deps: esbuild, chokidar (vite is an optional passthrough).

import { promises as fs } from "node:fs";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HUB = "https://ce-net.com";

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { _: [], hub: process.env.CE_HUB || DEFAULT_HUB, app: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--hub") opts.hub = argv[++i];
    else if (a.startsWith("--hub=")) opts.hub = a.slice("--hub=".length);
    else if (a === "--app") opts.app = argv[++i];
    else if (a.startsWith("--app=")) opts.app = a.slice("--app=".length);
    else opts._.push(a);
  }
  if (opts.hub) opts.hub = String(opts.hub).replace(/\/+$/, "");
  return opts;
}

// ---------------------------------------------------------------------------
// content types
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// app id — the user's public dev id, persisted at ./.ce/app-id
// ---------------------------------------------------------------------------

async function resolveAppId(cwd, override) {
  if (override) return override;
  const ceDir = path.join(cwd, ".ce");
  const idFile = path.join(ceDir, "app-id");
  try {
    const existing = (await fs.readFile(idFile, "utf8")).trim();
    if (existing) return existing;
  } catch (_) {
    /* not yet created */
  }
  const id = crypto.randomBytes(8).toString("hex"); // 16 hex chars
  await fs.mkdir(ceDir, { recursive: true });
  await fs.writeFile(idFile, id + "\n");
  return id;
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
  const res = await fetch(url, {
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
async function uploadDir(hub, appId, outDir, prev = null, { quiet = false } = {}) {
  const files = await walk(outDir);
  const next = new Map();
  let uploaded = 0;
  for (const f of files) {
    const buf = await fs.readFile(f.abs);
    const hash = crypto.createHash("sha1").update(buf).digest("hex");
    next.set(f.rel, hash);
    if (prev && prev.get(f.rel) === hash) continue; // unchanged
    await putFile(hub, appId, f.rel, buf, contentType(f.rel));
    uploaded++;
    if (!quiet) console.log(`  ok  ${f.rel}  (${buf.length}b)`);
  }
  return { next, uploaded, total: files.length };
}

// ---------------------------------------------------------------------------
// build: vite passthrough if a vite config exists, else esbuild
// ---------------------------------------------------------------------------

function hasViteConfig(cwd) {
  return [
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.ts",
    "vite.config.cjs",
  ].some((f) => fssync.existsSync(path.join(cwd, f)));
}

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

function spawnVite(cwd, args) {
  const bin = process.platform === "win32" ? "npx.cmd" : "npx";
  return spawn(bin, ["vite", ...args], { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdNew(opts) {
  const template = opts._[1] || "chat";
  const dir = opts._[2] || template;
  const target = path.resolve(process.cwd(), dir);

  // Templates live in web/ce-app/templates/<template> (owned by another agent).
  const tplDir = path.join(__dirname, "..", "templates", template);
  await fs.mkdir(target, { recursive: true });

  if (fssync.existsSync(tplDir)) {
    await copyTree(tplDir, target);
    console.log(`Scaffolded "${template}" -> ${path.relative(process.cwd(), target) || "."}`);
  } else {
    // Fallback minimal scaffold so `new` works before templates land.
    await writeFallbackTemplate(target, template);
    console.log(
      `Template "${template}" not found in templates/; wrote a minimal starter -> ${
        path.relative(process.cwd(), target) || "."
      }`
    );
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

async function cmdDeploy(opts) {
  const cwd = process.cwd();
  const appId = await resolveAppId(cwd, opts.app);
  const outDir = path.join(cwd, hasViteConfig(cwd) ? "dist" : "out");

  console.log(`ce-app deploy  app=${appId}  hub=${opts.hub}`);
  await buildOnce(cwd, outDir);
  const { uploaded, total } = await uploadDir(opts.hub, appId, outDir);
  const url = `${opts.hub}/apps/${appId}/`;
  console.log(`\nUploaded ${uploaded}/${total} file(s).`);
  console.log(`Live: ${url}`);
  if (_esbuildCtx) {
    try { await _esbuildCtx.dispose(); } catch (_) {}
    _esbuildCtx = null;
  }
  return url;
}

async function buildOnce(cwd, outDir) {
  if (hasViteConfig(cwd)) {
    await new Promise((resolve, reject) => {
      const p = spawnVite(cwd, ["build"]);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`vite build exited ${code}`))));
      p.on("error", reject);
    });
  } else {
    await esbuildBuild(cwd, outDir);
  }
}

async function cmdDev(opts) {
  const cwd = process.cwd();
  const appId = await resolveAppId(cwd, opts.app);
  const useVite = hasViteConfig(cwd);
  const outDir = path.join(cwd, useVite ? "dist" : "out");
  const url = `${opts.hub}/apps/${appId}/`;

  console.log(`ce-app dev  app=${appId}  hub=${opts.hub}  builder=${useVite ? "vite" : "esbuild"}`);
  console.log(`Live: ${url}\n`);

  const { default: chokidar } = await import("chokidar");
  let prev = new Map();
  let rebuilding = false;
  let pending = false;

  async function buildAndUpload(reason) {
    if (rebuilding) {
      pending = true;
      return;
    }
    rebuilding = true;
    try {
      if (reason) console.log(`[build] ${reason}`);
      if (!useVite) await esbuildBuild(cwd, outDir); // vite --watch writes dist itself
      const { next, uploaded } = await uploadDir(opts.hub, appId, outDir, prev, { quiet: false });
      prev = next;
      if (uploaded > 0) console.log(`[push] ${uploaded} file(s) -> ${url}`);
    } catch (e) {
      console.error(`[error] ${e.message}`);
    } finally {
      rebuilding = false;
      if (pending) {
        pending = false;
        buildAndUpload("rebuild (queued)");
      }
    }
  }

  if (useVite) {
    // vite --watch rebuilds dist; we just watch dist and push changes.
    const vp = spawnVite(cwd, ["build", "--watch"]);
    vp.on("error", (e) => console.error(`[vite] ${e.message}`));
    // give vite a moment, then watch dist
    const distWatcher = chokidar.watch(outDir, { ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 150 } });
    const debounced = debounce(() => buildAndUpload(null), 200);
    distWatcher.on("add", debounced).on("change", debounced).on("unlink", debounced);
    process.on("SIGINT", () => {
      try { vp.kill(); } catch (_) {}
      process.exit(0);
    });
  } else {
    await buildAndUpload("initial");
    const watchPaths = ["src", "public", "index.html"]
      .map((p) => path.join(cwd, p))
      .filter((p) => fssync.existsSync(p));
    const watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      ignored: /(^|[\\/])(node_modules|\.ce|out|dist)([\\/]|$)/,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    const debounced = debounce((p) => buildAndUpload(`changed ${path.relative(cwd, p)}`), 120);
    watcher.on("add", debounced).on("change", debounced).on("unlink", debounced);
    process.on("SIGINT", async () => {
      try { await watcher.close(); } catch (_) {}
      await disposeEsbuild();
      process.exit(0);
    });
    console.log("\nWatching for changes (Ctrl-C to stop)…");
  }
}

function debounce(fn, ms) {
  let t = null;
  let lastArg;
  return (arg) => {
    lastArg = arg;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(lastArg);
    }, ms);
  };
}

// Local smoke test: bundle a tiny fixture into a temp out dir, assert outputs. No network.
async function cmdSmoke() {
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

    const checks = [];
    const need = (cond, msg) => checks.push({ ok: !!cond, msg });
    need(files.includes("index.html"), "index.html emitted");
    need(files.includes("main.js"), "main.js emitted");
    need(files.includes("main.js.map"), "main.js.map emitted (sourcemap)");
    need(/src=["']\.?\/?main\.js["']/.test(html), "index.html references ./main.js");
    need(js.includes("fixture"), "bundle contains source string");
    need(contentType("a/b.wasm") === "application/wasm", "content-type map: wasm");
    need(contentType("x.HTML") === "text/html; charset=utf-8", "content-type map: html (case-insensitive)");

    let allOk = true;
    for (const c of checks) {
      console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.msg}`);
      if (!c.ok) allOk = false;
    }
    console.log(`\nsmoke: ${allOk ? "OK" : "FAILED"}  (fixture at ${out})`);
    if (!allOk) process.exitCode = 1;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// help + dispatch
// ---------------------------------------------------------------------------

const HELP = `ce-app — one command to a live, globally reachable, hot-reloading app

Usage:
  ce-app new <template> [dir]   Scaffold a template (default: chat)
  ce-app dev                    Build + watch + live-upload; prints the public URL
  ce-app deploy                 One-shot full upload (no watch)
  ce-app smoke                  Build a tiny fixture locally (no network) — self-check

Options:
  --hub <base>   Hub base URL (default: ${DEFAULT_HUB}, or $CE_HUB)
  --app <id>     Override app id (default: ./.ce/app-id, auto-created as 16-hex)
  -h, --help     Show this help

Your public dev id is stored at ./.ce/app-id and your app goes live at
  ${DEFAULT_HUB}/apps/<id>/
Hot reload is automatic (the hub injects a reload snippet into served HTML).
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];

  if (opts.help || cmd === "help" || !cmd) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "new":
      await cmdNew(opts);
      break;
    case "dev":
      await cmdDev(opts);
      break;
    case "deploy":
      await cmdDeploy(opts);
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
  // `dev` runs forever (until Ctrl-C); everything else should exit promptly.
  if (cmd !== "dev") {
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
