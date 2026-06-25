import { defineConfig } from "vite";

// CE Drive web app — the open-source Google Drive face of CE Drive (PLAN/10-drive-fs.md §8).
//
// A pure-web SPA on @ce-net/sdk. It talks to a *local* CE node's HTTP API (:8844) for the
// blob/object layer (chunked, CID-verified storage), and renders a DriveTree model — the
// Kleppmann move-CRDT directory tree. The DriveTree CRDT is ce-drive-wasm (crates/
// ce-drive-wasm) compiled to WASM via `npm run build:wasm` and loaded in the browser
// (src/core/wasm-adapter.ts). `import.meta.glob` bundles the generated src/wasm/ artifact
// into the build when present and tolerates its absence (the app then falls back to the
// in-memory mock adapter, src/core/mock-adapter.ts, also reachable with `?mock=1`).
//
// In dev we proxy `/ce/*` to a local CE node so the browser is same-origin (no CORS). The
// build is a static bundle (deploy like ce-host / ce-infer-ui).
export default defineConfig({
  server: {
    port: 5184,
    proxy: {
      "/ce": {
        target: "http://127.0.0.1:8844",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ce/, ""),
      },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
});
