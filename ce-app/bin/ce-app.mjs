#!/usr/bin/env node
// ce-app — one command to a live, globally reachable, hot-reloading app.
//
//   ce-app new [template] [dir]   scaffold a template (lists available if omitted)
//   ce-app dev                    build + watch + live-upload, prints the public URL
//   ce-app deploy                 framework auto-detect + build + upload + spa config
//   ce-app domain add|rm|ls <d>   manage custom production domains for this app
//   ce-app detect                 print the detected framework + output dir (no network)
//   ce-app smoke                  build a tiny fixture locally (no network) — self-check
//
// Flags: --help  --hub <base>  --app <id>
//
// Node 18+, ESM. Light deps: esbuild, chokidar (the framework build tools — vite,
// next, svelte, astro, expo — are invoked through the project's own npm scripts /
// npx and are NOT dependencies of ce-app).

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

// Set spa=true (or any config) on the app via the hub config endpoint.
async function setAppConfig(hub, appId, config) {
  const url = `${hub}/apps/${encodeURIComponent(appId)}/config`;
  try {
    const res = await fetch(url, {
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

// Returns a recipe object describing how to build + where output lands.
function detectFramework(cwd) {
  const pkg = readJsonSafe(path.join(cwd, "package.json"));
  const deps = depSet(pkg);
  const has = (...names) => names.some((n) => deps.has(n));

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

async function cmdDeploy(opts) {
  const cwd = process.cwd();
  const appId = await resolveAppId(cwd, opts.app);
  const recipe = detectFramework(cwd);

  console.log(`ce-app deploy  app=${appId}  hub=${opts.hub}`);
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

  const { uploaded, total } = await uploadDir(opts.hub, appId, outDir);

  // SPAs (React Router / SvelteKit / Vue Router / etc.) need server-side fallback to
  // index.html for client routes; tell the hub to enable it for this app.
  const cfg = await setAppConfig(opts.hub, appId, { spa: true });
  if (cfg.ok) console.log("SPA fallback: enabled");
  else console.log(`SPA fallback: could not set (${cfg.status || cfg.error || "unknown"}) — non-fatal`);

  const url = `${opts.hub}/apps/${appId}/`;
  console.log(`\nUploaded ${uploaded}/${total} file(s).`);
  console.log(`Live: ${url}`);
  if (_esbuildCtx) {
    try { await _esbuildCtx.dispose(); } catch (_) {}
    _esbuildCtx = null;
  }
  return url;
}

async function cmdDev(opts) {
  const cwd = process.cwd();
  const appId = await resolveAppId(cwd, opts.app);
  const recipe = detectFramework(cwd);
  // dev uses esbuild's fast in-process watch when the project is esbuild-shaped;
  // vite projects get vite --watch; other frameworks fall back to rebuild-on-change.
  const isEsbuild = recipe.id === "esbuild";
  const isVite = recipe.id === "vite";
  const outDir = isEsbuild ? path.join(cwd, "out") : resolveOutDir(cwd, recipe);
  const url = `${opts.hub}/apps/${appId}/`;

  console.log(`ce-app dev  app=${appId}  hub=${opts.hub}  builder=${recipe.id}`);
  console.log(`Live: ${url}\n`);

  const { default: chokidar } = await import("chokidar");
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
      const { next, uploaded } = await uploadDir(opts.hub, appId, outDir, prev, { quiet: false });
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
    const watchPaths = ["src", "app", "pages", "public", "index.html"]
      .map((p) => path.join(cwd, p))
      .filter((p) => fssync.existsSync(p));
    const watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      ignored: /(^|[\\/])(node_modules|\.ce|out|dist|build|\.next|\.output|\.svelte-kit)([\\/]|$)/,
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
// custom domains
// ---------------------------------------------------------------------------

async function cmdDomain(opts) {
  const sub = opts._[1];
  const cwd = process.cwd();

  if (sub === "ls" || sub === "list") {
    const appId = await resolveAppId(cwd, opts.app);
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
    const appId = await resolveAppId(cwd, opts.app);
    const res = await fetch(`${opts.hub}/apps/${encodeURIComponent(appId)}/domain`, {
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
    const appId = await resolveAppId(cwd, opts.app);
    const res = await fetch(
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
// detect — print the detected framework + output dir (no network)
// ---------------------------------------------------------------------------

async function cmdDetect(opts) {
  const cwd = process.cwd();
  const recipe = detectFramework(cwd);
  console.log(`framework: ${recipe.id}`);
  console.log(`label:     ${recipe.label}`);
  console.log(`outDirs:   ${recipe.outDirs.join(", ")}`);
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
// help + dispatch
// ---------------------------------------------------------------------------

const HELP = `ce-app — one command to a live, globally reachable, hot-reloading app

Usage:
  ce-app new [template] [dir]   Scaffold a template (no name -> list available)
  ce-app dev                    Build + watch + live-upload; prints the public URL
  ce-app deploy                 Auto-detect framework, build, upload, enable SPA routing
  ce-app domain add <domain>    Register a custom production domain for this app
  ce-app domain rm <domain>     Unregister a custom domain
  ce-app domain ls              List this app's custom domains
  ce-app detect                 Print the detected framework + output dir (no network)
  ce-app smoke                  Build a fixture + run detection self-checks (no network)

Options:
  --hub <base>   Hub base URL (default: ${DEFAULT_HUB}, or $CE_HUB)
  --app <id>     Override app id (default: ./.ce/app-id, auto-created as 16-hex)
  -h, --help     Show this help

Frameworks auto-detected on deploy: Vite (vanilla/React/Vue/Svelte), SvelteKit
(static adapter), Next.js (static export), Astro (static), Nuxt (static generate),
Create React App, Expo / react-native-web (web export), plain static sites, and the
built-in esbuild path (src/main + src/index.html).

Your public dev id is stored at ./.ce/app-id and your app goes live at
  ${DEFAULT_HUB}/apps/<id>/
Hot reload is automatic (the hub injects a reload snippet into served HTML).
Custom domains: CNAME your domain to ce-net.com, then \`ce-app domain add <domain>\`.
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
    case "domain":
      await cmdDomain(opts);
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
