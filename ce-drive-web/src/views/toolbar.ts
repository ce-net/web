/**
 * The toolbar — breadcrumb path, New-folder / Upload buttons, and selection actions. Sits
 * above the file list in the Drive view.
 */

import { el } from "../lib/dom.js";
import { icons } from "../lib/icons.js";
import { promptText } from "../dialogs/prompt.js";
import { openShareDialog } from "../dialogs/share-dialog.js";
import { downloadNode, newFolder, trashNodes, uploadFiles } from "../store/actions.js";
import type { DriveStore } from "../store/drive-store.js";
import type { NodeId } from "../core/model.js";

export function buildToolbar(store: DriveStore): HTMLElement {
  const crumbs = el("nav", { class: "breadcrumb", "aria-label": "Breadcrumb" });
  for (const [i, c] of store.breadcrumb().entries()) {
    if (i > 0) crumbs.append(el("span", { class: "crumb-sep", html: icons.chevron }));
    crumbs.append(
      el(
        "button",
        {
          class: "crumb",
          type: "button",
          "aria-current": i === store.breadcrumb().length - 1 ? "page" : undefined,
          onclick: () => store.navigate(c.id),
        },
        c.name,
      ),
    );
  }

  // Hidden file input drives the Upload button.
  const fileInput = el("input", {
    class: "visually-hidden",
    type: "file",
    multiple: true,
    onchange: (e: Event) => {
      const input = e.currentTarget as HTMLInputElement;
      if (input.files && input.files.length) {
        void uploadFiles(store, store.cwd, input.files);
        input.value = "";
      }
    },
  }) as HTMLInputElement;

  const newBtn = el(
    "button",
    {
      class: "btn primary",
      type: "button",
      onclick: async () => {
        const name = await promptText({
          title: "New folder",
          label: "Folder name",
          value: "Untitled folder",
          confirmLabel: "Create",
        });
        if (name) await newFolder(store, store.cwd, name);
      },
    },
    el("span", { class: "icon-inline", html: icons.folderPlus }),
    "New",
  );

  const uploadBtn = el(
    "button",
    { class: "btn", type: "button", onclick: () => fileInput.click() },
    el("span", { class: "icon-inline", html: icons.upload }),
    "Upload",
  );

  const actions = el("div", { class: "toolbar-actions" }, newBtn, uploadBtn, fileInput);

  // Selection bar (download / share / trash) shows only with a selection.
  const sel = [...store.selection];
  const selectionBar = sel.length
    ? selectionActions(store, sel)
    : null;

  return el(
    "div",
    { class: "toolbar" },
    el("div", { class: "toolbar-row" }, crumbs, actions),
    selectionBar,
  );
}

function selectionActions(store: DriveStore, sel: NodeId[]): HTMLElement {
  const one = sel.length === 1 ? store.snapshot.nodes.get(sel[0]!) : undefined;
  const buttons: (HTMLElement | null)[] = [
    el("span", { class: "sel-count small muted" }, `${sel.length} selected`),
  ];
  if (one && one.kind !== "dir") {
    buttons.push(
      el(
        "button",
        { class: "btn btn-sm", type: "button", onclick: () => void downloadNode(store, one.id) },
        el("span", { class: "icon-inline", html: icons.download }),
        "Download",
      ),
    );
  }
  if (one) {
    buttons.push(
      el(
        "button",
        { class: "btn btn-sm", type: "button", onclick: () => openShareDialog(store, one) },
        el("span", { class: "icon-inline", html: icons.share }),
        "Share",
      ),
    );
  }
  buttons.push(
    el(
      "button",
      { class: "btn btn-sm danger", type: "button", onclick: () => void trashNodes(store, sel) },
      el("span", { class: "icon-inline", html: icons.trash }),
      "Trash",
    ),
    el(
      "button",
      { class: "btn btn-sm ghost", type: "button", onclick: () => store.clearSelection() },
      "Clear",
    ),
  );
  return el("div", { class: "selection-bar" }, ...buttons.filter((b): b is HTMLElement => !!b));
}
