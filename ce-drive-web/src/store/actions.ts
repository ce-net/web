/**
 * Actions — the imperative bridge from UI intents to the DriveCore, with progress + toasts.
 *
 * Kept separate from the store (state) and views (render) so each intent is a single,
 * testable async function. Download triggers a browser save; upload reads File objects.
 */

import type { DriveStore } from "./drive-store.js";
import { toast } from "../lib/toast.js";
import type { NodeId } from "../core/model.js";

/** Upload one or more browser File objects into a folder, with a progress toast. */
export async function uploadFiles(
  store: DriveStore,
  parent: NodeId,
  files: FileList | File[],
): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;
  for (const file of list) {
    const dismiss = toast(`Uploading ${file.name}…`, "info", 0);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await store.core.upload(parent, file.name, bytes);
      dismiss();
      toast(`Uploaded ${file.name}`, "ok");
    } catch (err) {
      dismiss();
      toast(`Upload failed: ${describe(err)}`, "error", 6000);
    }
  }
  await store.refresh();
}

/** Download a node's current bytes as a browser file save. */
export async function downloadNode(store: DriveStore, id: NodeId): Promise<void> {
  const node = store.snapshot.nodes.get(id);
  if (!node || node.kind === "dir") {
    toast("Select a file to download", "info");
    return;
  }
  const dismiss = toast(`Downloading ${node.name}…`, "info", 0);
  try {
    const bytes = await store.core.download(id);
    dismiss();
    saveBytes(node.name, bytes);
    toast(`Downloaded ${node.name}`, "ok");
  } catch (err) {
    dismiss();
    toast(`Download failed: ${describe(err)}`, "error", 6000);
  }
}

/** Create a new folder, prompting for a name. */
export async function newFolder(store: DriveStore, parent: NodeId, name: string): Promise<void> {
  try {
    await store.core.mkdir(parent, name || "Untitled folder");
    toast("Folder created", "ok");
  } catch (err) {
    toast(`Could not create folder: ${describe(err)}`, "error", 6000);
  }
  await store.refresh();
}

export async function renameNode(store: DriveStore, id: NodeId, name: string): Promise<void> {
  try {
    await store.core.rename(id, name);
    toast("Renamed", "ok");
  } catch (err) {
    toast(`Rename failed: ${describe(err)}`, "error", 6000);
  }
  await store.refresh();
}

export async function moveNode(store: DriveStore, id: NodeId, newParent: NodeId): Promise<void> {
  try {
    await store.core.move(id, newParent);
    toast("Moved", "ok");
  } catch (err) {
    // The cycle check throws here for an illegal move-into-own-subtree (§4.2).
    toast(describe(err), "error", 6000);
  }
  await store.refresh();
}

export async function copyNode(store: DriveStore, id: NodeId, newParent: NodeId): Promise<void> {
  try {
    await store.core.copy(id, newParent);
    toast("Copied", "ok");
  } catch (err) {
    toast(`Copy failed: ${describe(err)}`, "error", 6000);
  }
  await store.refresh();
}

export async function trashNodes(store: DriveStore, ids: NodeId[]): Promise<void> {
  try {
    for (const id of ids) await store.core.trashNode(id);
    toast(ids.length === 1 ? "Moved to trash" : `${ids.length} items moved to trash`, "ok");
  } catch (err) {
    toast(`Could not trash: ${describe(err)}`, "error", 6000);
  }
  await store.refresh();
}

export async function restoreNode(store: DriveStore, id: NodeId): Promise<void> {
  try {
    await store.core.restore(id);
    toast("Restored", "ok");
  } catch (err) {
    toast(`Restore failed: ${describe(err)}`, "error", 6000);
  }
  await store.refresh();
}

export async function purgeNode(store: DriveStore, id: NodeId): Promise<void> {
  try {
    await store.core.purge(id);
    toast("Permanently deleted", "ok");
  } catch (err) {
    toast(`Delete failed: ${describe(err)}`, "error", 6000);
  }
  await store.refresh();
}

export async function restoreVersion(
  store: DriveStore,
  id: NodeId,
  versionCid: string,
): Promise<void> {
  try {
    await store.core.restoreVersion(id, versionCid);
    toast("Version restored", "ok");
  } catch (err) {
    toast(`Could not restore version: ${describe(err)}`, "error", 6000);
  }
  await store.refresh();
}

/** Trigger a browser download of raw bytes. */
function saveBytes(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes.slice().buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
