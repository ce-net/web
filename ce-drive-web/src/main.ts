/**
 * ce-drive-web — app entry.
 *
 * The open-source Google Drive face of CE Drive (PLAN/10-drive-fs.md §8). A framework-free
 * TypeScript + Vite SPA over @ce-net/sdk.
 *
 * It renders a DriveTree model — the Kleppmann move-CRDT directory tree — and stores file
 * *bytes* via the node's content-addressed blob layer (chunked, CID-verified, §3.1) through
 * the SDK. The tree / path / version / conflict logic is the REAL ce-drive-wasm CRDT core
 * (src/core/wasm-adapter.ts → WasmDriveCore), compiled from crates/ce-drive-wasm and loaded
 * in the browser; multi-device convergence rides a per-drive mesh merged-log.
 *
 * The in-memory MockDriveCore (src/core/mock-adapter.ts) is kept as a fallback: it is used
 * only when explicitly requested (`?mock=1`) or when the wasm bundle has not been built
 * (`npm run build:wasm`). The UI depends solely on the DriveCore interface
 * (src/core/drive-core.ts), so both adapters are drop-in.
 */

import "./app.css";
import { DriveStore } from "./store/drive-store.js";
import { mountApp } from "./views/app.js";
import { el, mount } from "./lib/dom.js";

const root = document.getElementById("app");
if (!root) {
  throw new Error("missing #app root");
}

mount(root, el("div", { class: "boot" }, el("div", { class: "boot-spinner" }), el("span", {}, "Loading CE Drive…")));

const store = new DriveStore();
store
  .init()
  .then(() => mountApp(store, root))
  .catch((err: unknown) => {
    mount(
      root,
      el(
        "div",
        { class: "boot error" },
        el("h2", {}, "CE Drive failed to start"),
        el("p", { class: "muted" }, err instanceof Error ? err.message : String(err)),
      ),
    );
  });
