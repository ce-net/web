/**
 * The app shell — top bar (brand, search, connection pill), sidebar, and the main pane that
 * swaps between the Drive browser, Trash, Audit, and Search-results views. Subscribes to the
 * store and re-renders on any change (the converged CRDT is the single source of truth).
 */

import { el, mount, clear } from "../lib/dom.js";
import { icons } from "../lib/icons.js";
import { iconFor } from "../lib/icons.js";
import { formatBytes, formatRelative } from "../lib/format.js";
import { renderSidebar, type SidebarState, type View } from "./sidebar.js";
import { buildToolbar } from "./toolbar.js";
import { renderFileList } from "./file-list.js";
import { renderTrash } from "./trash-view.js";
import { renderAudit } from "./audit-view.js";
import { showContextMenu } from "./context-menu.js";
import { itemMenu } from "./item-actions.js";
import { uploadFiles } from "../store/actions.js";
import type { DriveStore } from "../store/drive-store.js";
import { ROOT, type DriveNode } from "../core/model.js";

export function mountApp(store: DriveStore, root: HTMLElement): void {
  const sidebarState: SidebarState = { view: "drive", expanded: new Set([ROOT]) };
  let searchQuery = "";
  let searchResults: DriveNode[] = [];

  // --- static shell ---
  const searchInput = el("input", {
    class: "search-input",
    type: "search",
    placeholder: "Search in Drive",
    "aria-label": "Search files",
    autocomplete: "off",
  }) as HTMLInputElement;

  const connPill = el("span", { class: "conn-pill", "aria-live": "polite" });

  const topbar = el(
    "header",
    { class: "topbar" },
    el(
      "div",
      { class: "brand" },
      el("span", { class: "brand-mark", html: icons.drive }),
      el("span", { class: "brand-name" }, "CE Drive"),
    ),
    el(
      "div",
      { class: "search-box" },
      el("span", { class: "search-icon", html: icons.search }),
      searchInput,
    ),
    connPill,
  );

  const sidebar = el("aside", { class: "sidebar", "aria-label": "Navigation" });
  const main = el("main", { class: "main", "aria-label": "Files" });
  const shell = el("div", { class: "shell" }, topbar, el("div", { class: "body" }, sidebar, main));
  mount(root, shell);

  // --- search wiring (debounced) ---
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      searchQuery = searchInput.value.trim();
      if (searchQuery) {
        searchResults = await store.core.search(searchQuery);
        sidebarState.view = "drive";
      }
      render();
    }, 160);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      searchQuery = "";
      render();
    }
  });

  const selectView = (v: View): void => {
    sidebarState.view = v;
    searchQuery = "";
    searchInput.value = "";
    render();
  };

  // --- whole-pane drag-to-upload into the current folder ---
  main.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      main.classList.add("drop-zone");
    }
  });
  main.addEventListener("dragleave", (e) => {
    if (e.target === main) main.classList.remove("drop-zone");
  });
  main.addEventListener("drop", (e) => {
    main.classList.remove("drop-zone");
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      void uploadFiles(store, store.cwd, e.dataTransfer.files);
    }
  });
  // Clicking empty space clears selection.
  main.addEventListener("mousedown", (e) => {
    if (e.target === main || (e.target as HTMLElement).classList.contains("pane-scroll")) {
      store.clearSelection();
    }
  });

  function renderConnection(): void {
    const c = store.connection;
    clear(connPill);
    const ok = c.backend === "node";
    connPill.className = ok ? "conn-pill ok" : "conn-pill warn";
    connPill.append(
      el("span", { class: "conn-dot", html: icons.dot }),
      el(
        "span",
        { class: "small" },
        ok ? `Node ${c.nodeId} · h${c.height ?? 0}` : "Offline demo (in-memory blobs)",
      ),
    );
    if (c.core === "mock") {
      connPill.append(el("span", { class: "conn-tag small", title: "Mock CRDT core (wasm not built)" }, "mock"));
    }
    connPill.title = ok
      ? "Connected to a local CE node; blobs are stored in its durable /blobs store." +
        (c.core === "mock" ? " Tree backed by the in-memory mock (wasm core not built)." : " Tree backed by the ce-drive-wasm move-CRDT.")
      : "No local node reachable on /ce — content is held in-memory for this session only." +
        (c.core === "mock" ? " Tree backed by the in-memory mock." : " Tree backed by the ce-drive-wasm move-CRDT.");
  }

  function render(): void {
    renderConnection();
    renderSidebar(store, sidebarState, sidebar, selectView);

    if (searchQuery) {
      mount(main, searchHeader(searchQuery, searchResults.length), searchResultsPane(store, searchResults));
      return;
    }

    if (sidebarState.view === "trash") {
      const pane = el("div", { class: "pane-scroll" });
      mount(main, viewHeader("Trash", icons.trash), pane);
      void renderTrash(store, pane);
      return;
    }
    if (sidebarState.view === "audit") {
      const pane = el("div", { class: "pane-scroll" });
      mount(main, viewHeader("Audit log", icons.shield), pane);
      void renderAudit(store, pane);
      return;
    }

    // Drive browser.
    const listPane = el("div", { class: "pane-scroll" });
    mount(main, buildToolbar(store), listPane);
    renderFileList(store, listPane);
  }

  store.subscribe(render);
  render();
}

function viewHeader(title: string, icon: string): HTMLElement {
  return el(
    "div",
    { class: "view-header" },
    el("span", { class: "icon-inline", html: icon }),
    el("h1", { class: "view-title" }, title),
  );
}

function searchHeader(query: string, count: number): HTMLElement {
  return el(
    "div",
    { class: "view-header" },
    el("span", { class: "icon-inline", html: icons.search }),
    el("h1", { class: "view-title" }, `Results for "${query}"`),
    el("span", { class: "small muted" }, `${count} match${count === 1 ? "" : "es"}`),
  );
}

function searchResultsPane(store: DriveStore, results: DriveNode[]): HTMLElement {
  const pane = el("div", { class: "pane-scroll" });
  if (results.length === 0) {
    pane.append(
      el(
        "div",
        { class: "empty-state" },
        el("span", { class: "empty-icon", html: icons.search }),
        el("h3", {}, "No matches"),
        el("p", { class: "muted" }, "Try a different filename or path fragment."),
      ),
    );
    return pane;
  }
  const list = el("div", { class: "file-list", role: "table", "aria-label": "Search results" });
  for (const node of results) {
    const row = el(
      "div",
      { class: "file-row", role: "row", tabindex: 0 },
      el(
        "div",
        { class: "col-name", role: "cell" },
        el("span", { class: `file-icon kind-${node.kind}`, html: iconFor(node.kind, node.name) }),
        el(
          "div",
          { class: "result-name-col" },
          el("span", { class: "file-name" }, node.name),
          el("span", { class: "result-path small muted" }, node.path),
        ),
      ),
      el("span", { class: "col-size small muted", role: "cell" }, node.kind === "dir" ? "—" : formatBytes(node.size)),
      el("span", { class: "col-mtime small muted", role: "cell" }, formatRelative(node.mtimeMs)),
    );
    const open = (): void => {
      if (node.kind === "dir") store.navigate(node.id);
      else store.navigate(node.parent);
    };
    row.addEventListener("dblclick", open);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, itemMenu(store, node));
    });
    list.append(row);
  }
  pane.append(list);
  return pane;
}
