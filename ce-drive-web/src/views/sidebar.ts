/**
 * The left sidebar — a collapsible folder tree (rendered from the DriveTree `children`
 * index) plus the Trash and Audit destinations. Folders accept drops to move (a `MoveOp`).
 */

import { el, mount } from "../lib/dom.js";
import { icons } from "../lib/icons.js";
import { moveNode } from "../store/actions.js";
import { DRAG_MIME } from "./file-list.js";
import type { DriveStore } from "../store/drive-store.js";
import { ROOT, type NodeId } from "../core/model.js";

export type View = "drive" | "trash" | "audit";

export interface SidebarState {
  view: View;
  expanded: Set<NodeId>;
}

export function renderSidebar(
  store: DriveStore,
  state: SidebarState,
  container: HTMLElement,
  onSelectView: (v: View) => void,
): void {
  const tree = el("div", { class: "tree", role: "tree", "aria-label": "Folders" });

  const driveRoot = treeRow(store, state, ROOT, "My Drive", 0, onSelectView);
  tree.append(driveRoot);
  appendChildren(store, state, tree, ROOT, 1, onSelectView);

  const nav = el(
    "nav",
    { class: "sidebar-nav" },
    destRow("My Drive", icons.drive, state.view === "drive" && store.cwd === ROOT, () => {
      onSelectView("drive");
      store.navigate(ROOT);
    }),
  );

  const dests = el(
    "div",
    { class: "sidebar-dests" },
    destRow("Trash", icons.trash, state.view === "trash", () => onSelectView("trash")),
    destRow("Audit log", icons.shield, state.view === "audit", () => onSelectView("audit")),
  );

  mount(
    container,
    el("div", { class: "sidebar-section" }, nav),
    el("div", { class: "sidebar-section grow" }, tree),
    el("div", { class: "sidebar-section" }, dests),
  );
}

function appendChildren(
  store: DriveStore,
  state: SidebarState,
  parentEl: HTMLElement,
  parent: NodeId,
  depth: number,
  onSelectView: (v: View) => void,
): void {
  if (!state.expanded.has(parent) && parent !== ROOT) return;
  const childIds = store.snapshot.children.get(parent) ?? [];
  for (const id of childIds) {
    const node = store.snapshot.nodes.get(id);
    if (!node || node.kind !== "dir") continue;
    parentEl.append(treeRow(store, state, id, node.name, depth, onSelectView));
    if (state.expanded.has(id)) {
      appendChildren(store, state, parentEl, id, depth + 1, onSelectView);
    }
  }
}

function treeRow(
  store: DriveStore,
  state: SidebarState,
  id: NodeId,
  name: string,
  depth: number,
  onSelectView: (v: View) => void,
): HTMLElement {
  const hasKids = (store.snapshot.children.get(id) ?? []).some(
    (c) => store.snapshot.nodes.get(c)?.kind === "dir",
  );
  const expanded = state.expanded.has(id);
  const active = store.cwd === id && state.view === "drive";

  const twisty = el("button", {
    class: hasKids ? (expanded ? "twisty open" : "twisty") : "twisty hidden",
    type: "button",
    "aria-label": expanded ? "Collapse" : "Expand",
    html: icons.chevron,
    onclick: (e: Event) => {
      e.stopPropagation();
      if (expanded) state.expanded.delete(id);
      else state.expanded.add(id);
      // Re-render handled by the app subscription via a manual emit through navigate-less path.
      store.subscribeNotify();
    },
  });

  const row = el(
    "div",
    {
      class: active ? "tree-row active" : "tree-row",
      role: "treeitem",
      "aria-expanded": hasKids ? expanded : undefined,
      tabindex: 0,
      style: `padding-left:${8 + depth * 16}px`,
    },
    twisty,
    el("span", { class: "tree-icon", html: icons.folder }),
    el("span", { class: "tree-name" }, name),
  );

  const open = (): void => {
    onSelectView("drive");
    store.navigate(id);
    if (hasKids) state.expanded.add(id);
  };
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") open();
    if (e.key === "ArrowRight" && hasKids) {
      state.expanded.add(id);
      store.subscribeNotify();
    }
    if (e.key === "ArrowLeft") {
      state.expanded.delete(id);
      store.subscribeNotify();
    }
  });

  // Drop target → move into this folder.
  row.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes(DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.classList.add("drop-target");
    }
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", (e) => {
    row.classList.remove("drop-target");
    const dragged = e.dataTransfer?.getData(DRAG_MIME);
    if (dragged && dragged !== id) {
      e.preventDefault();
      void moveNode(store, dragged as NodeId, id);
    }
  });

  return row;
}

function destRow(label: string, icon: string, active: boolean, onClick: () => void): HTMLElement {
  return el(
    "button",
    {
      class: active ? "dest-row active" : "dest-row",
      type: "button",
      onclick: onClick,
    },
    el("span", { class: "tree-icon", html: icon }),
    el("span", {}, label),
  );
}
