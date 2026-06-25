/**
 * The file list — the center pane. Renders the cwd's children as rows (name / size /
 * modified), supports selection, double-click open/download, right-click context menu, and
 * HTML5 drag-and-drop to move a node into a folder (a single `MoveOp`, §4.4).
 */

import { el, mount } from "../lib/dom.js";
import { iconFor, icons } from "../lib/icons.js";
import { formatBytes, formatRelative, formatExact } from "../lib/format.js";
import { showContextMenu } from "./context-menu.js";
import { itemMenu } from "./item-actions.js";
import { downloadNode, moveNode } from "../store/actions.js";
import type { DriveStore } from "../store/drive-store.js";
import type { DriveNode, NodeId } from "../core/model.js";

const DRAG_MIME = "application/x-ce-drive-node";

export function renderFileList(store: DriveStore, container: HTMLElement): void {
  const childIds = store.currentChildren();

  if (childIds.length === 0) {
    mount(container, emptyState());
    return;
  }

  const header = el(
    "div",
    { class: "list-header", role: "row" },
    el("span", { class: "col-name", role: "columnheader" }, "Name"),
    el("span", { class: "col-size", role: "columnheader" }, "Size"),
    el("span", { class: "col-mtime", role: "columnheader" }, "Modified"),
    el("span", { class: "col-menu", role: "columnheader", "aria-label": "Actions" }),
  );

  const rows = childIds
    .map((id) => store.snapshot.nodes.get(id))
    .filter((n): n is DriveNode => !!n)
    .map((node) => row(store, node));

  const list = el("div", { class: "file-list", role: "table", "aria-label": "Files" }, header, ...rows);
  mount(container, list);
}

function row(store: DriveStore, node: DriveNode): HTMLElement {
  const selected = store.selection.has(node.id);
  const isDir = node.kind === "dir";

  const nameCell = el(
    "div",
    { class: "col-name", role: "cell" },
    el("span", { class: `file-icon kind-${node.kind}`, html: iconFor(node.kind, node.name) }),
    el("span", { class: "file-name", title: node.path }, node.name),
    node.conflict ? el("span", { class: "badge warn", title: "Name collision — surfaced, not hidden" }, "conflict") : null,
    node.kind === "cedoc" ? el("span", { class: "badge" }, "doc") : null,
  );

  const r = el(
    "div",
    {
      class: selected ? "file-row selected" : "file-row",
      role: "row",
      tabindex: 0,
      "aria-selected": selected,
      draggable: true,
    },
    nameCell,
    el("span", { class: "col-size small muted", role: "cell" }, isDir ? "—" : formatBytes(node.size)),
    el(
      "span",
      { class: "col-mtime small muted", role: "cell", title: formatExact(node.mtimeMs) },
      formatRelative(node.mtimeMs),
    ),
    el(
      "button",
      {
        class: "icon-btn col-menu",
        type: "button",
        "aria-label": `Actions for ${node.name}`,
        html: icons.more,
        onclick: (e) => {
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          showContextMenu(rect.left, rect.bottom + 4, itemMenu(store, node));
        },
      },
    ),
  );

  // Selection + open.
  r.addEventListener("click", (e) => {
    store.select(node.id, e.metaKey || e.ctrlKey);
  });
  r.addEventListener("dblclick", () => {
    if (isDir) store.navigate(node.id);
    else void downloadNode(store, node.id);
  });
  r.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (isDir) store.navigate(node.id);
      else void downloadNode(store, node.id);
    } else if (e.key === " ") {
      e.preventDefault();
      store.select(node.id, e.metaKey || e.ctrlKey);
    }
  });
  r.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!store.selection.has(node.id)) store.select(node.id);
    showContextMenu(e.clientX, e.clientY, itemMenu(store, node));
  });

  // Drag source.
  r.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData(DRAG_MIME, node.id);
    e.dataTransfer!.effectAllowed = "move";
    r.classList.add("dragging");
  });
  r.addEventListener("dragend", () => r.classList.remove("dragging"));

  // Drag target (folders accept a drop → move).
  if (isDir) {
    r.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes(DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        r.classList.add("drop-target");
      }
    });
    r.addEventListener("dragleave", () => r.classList.remove("drop-target"));
    r.addEventListener("drop", (e) => {
      r.classList.remove("drop-target");
      const dragged = e.dataTransfer?.getData(DRAG_MIME);
      if (dragged && dragged !== node.id) {
        e.preventDefault();
        void moveNode(store, dragged as NodeId, node.id);
      }
    });
  }

  return r;
}

function emptyState(): HTMLElement {
  return el(
    "div",
    { class: "empty-state" },
    el("span", { class: "empty-icon", html: icons.drive }),
    el("h3", {}, "This folder is empty"),
    el(
      "p",
      { class: "muted" },
      "Drag files here, or use New to create a folder. Files are content-addressed and " +
        "versioned automatically.",
    ),
  );
}

export { DRAG_MIME };
