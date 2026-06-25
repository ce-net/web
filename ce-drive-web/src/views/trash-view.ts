/** Trash view — trashed nodes (the TRASH subtree, §4.4), with restore / permanent delete. */

import { el, mount } from "../lib/dom.js";
import { iconFor, icons } from "../lib/icons.js";
import { formatBytes, formatRelative } from "../lib/format.js";
import { purgeNode, restoreNode } from "../store/actions.js";
import type { DriveStore } from "../store/drive-store.js";
import type { DriveNode } from "../core/model.js";

export async function renderTrash(store: DriveStore, container: HTMLElement): Promise<void> {
  const items = await store.core.trash();

  if (items.length === 0) {
    mount(
      container,
      el(
        "div",
        { class: "empty-state" },
        el("span", { class: "empty-icon", html: icons.trash }),
        el("h3", {}, "Trash is empty"),
        el("p", { class: "muted" }, "Items you trash appear here. Content is retained until you delete it permanently."),
      ),
    );
    return;
  }

  const header = el(
    "div",
    { class: "list-header", role: "row" },
    el("span", { class: "col-name", role: "columnheader" }, "Name"),
    el("span", { class: "col-size", role: "columnheader" }, "Size"),
    el("span", { class: "col-mtime", role: "columnheader" }, "Trashed"),
    el("span", { class: "col-actions-wide", role: "columnheader", "aria-label": "Actions" }),
  );

  const rows = items.map((node) => trashRow(store, node));
  mount(
    container,
    el(
      "div",
      { class: "trash-banner small muted" },
      "Trashed items are retained (undelete) until permanently deleted.",
    ),
    el("div", { class: "file-list", role: "table", "aria-label": "Trash" }, header, ...rows),
  );
}

function trashRow(store: DriveStore, node: DriveNode): HTMLElement {
  return el(
    "div",
    { class: "file-row", role: "row" },
    el(
      "div",
      { class: "col-name", role: "cell" },
      el("span", { class: `file-icon kind-${node.kind}`, html: iconFor(node.kind, node.name) }),
      el("span", { class: "file-name" }, node.name),
    ),
    el("span", { class: "col-size small muted", role: "cell" }, node.kind === "dir" ? "—" : formatBytes(node.size)),
    el("span", { class: "col-mtime small muted", role: "cell" }, formatRelative(node.mtimeMs)),
    el(
      "div",
      { class: "col-actions-wide", role: "cell" },
      el(
        "button",
        { class: "btn btn-sm", type: "button", onclick: () => void restoreNode(store, node.id) },
        el("span", { class: "icon-inline", html: icons.restore }),
        "Restore",
      ),
      el(
        "button",
        { class: "btn btn-sm danger", type: "button", onclick: () => void purgeNode(store, node.id) },
        "Delete forever",
      ),
    ),
  );
}
