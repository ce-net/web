/**
 * Shared per-item action helpers — the menu items and intents used by both the list rows
 * and the toolbar. Centralized so the file list, context menu, and toolbar stay in sync.
 */

import { icons } from "../lib/icons.js";
import { promptText } from "../dialogs/prompt.js";
import { openShareDialog } from "../dialogs/share-dialog.js";
import { openVersionHistory } from "../dialogs/version-history.js";
import type { MenuItem } from "./context-menu.js";
import type { DriveStore } from "../store/drive-store.js";
import {
  copyNode,
  downloadNode,
  renameNode,
  trashNodes,
} from "../store/actions.js";
import type { DriveNode } from "../core/model.js";
import { ROOT } from "../core/model.js";

/** Build the standard action menu for a live (non-trashed) node. */
export function itemMenu(store: DriveStore, node: DriveNode): MenuItem[] {
  const isFile = node.kind !== "dir";
  const items: MenuItem[] = [];

  if (node.kind === "dir") {
    items.push({
      label: "Open",
      icon: icons.folder,
      onSelect: () => store.navigate(node.id),
    });
  } else {
    items.push({
      label: "Download",
      icon: icons.download,
      onSelect: () => void downloadNode(store, node.id),
    });
  }

  items.push({
    label: "Share",
    icon: icons.share,
    onSelect: () => openShareDialog(store, node),
  });

  if (isFile) {
    items.push({
      label: "Version history",
      icon: icons.history,
      onSelect: () => openVersionHistory(store, node),
    });
  }

  items.push({ label: "—", onSelect: () => {} });

  items.push({
    label: "Rename",
    icon: icons.rename,
    onSelect: async () => {
      const name = await promptText({
        title: "Rename",
        label: "New name",
        value: node.name,
        confirmLabel: "Rename",
        selectBasename: isFile,
      });
      if (name) await renameNode(store, node.id, name);
    },
  });

  items.push({
    label: "Make a copy",
    icon: icons.copy,
    onSelect: () => void copyNode(store, node.id, node.parent || ROOT),
  });

  items.push({ label: "—", onSelect: () => {} });

  items.push({
    label: "Move to trash",
    icon: icons.trash,
    danger: true,
    onSelect: () => void trashNodes(store, [node.id]),
  });

  return items;
}
