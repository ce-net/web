/**
 * Version history panel — every save is a new CID; old CIDs stay valid (§3.3).
 *
 * Lists the file's versions newest-first, lets you download a specific version (CID-verified
 * `get_object`) or restore one as current (a new content op pointing at the old CID).
 */

import { openModal } from "../lib/modal.js";
import { el } from "../lib/dom.js";
import { icons } from "../lib/icons.js";
import { toast } from "../lib/toast.js";
import { formatBytes, formatExact, formatRelative, shortId } from "../lib/format.js";
import { restoreVersion } from "../store/actions.js";
import type { DriveStore } from "../store/drive-store.js";
import type { DriveNode } from "../core/model.js";

export function openVersionHistory(store: DriveStore, node: DriveNode): void {
  const m = openModal(`Version history — ${node.name}`);
  const versions = node.content?.versions ?? [];

  if (versions.length === 0) {
    m.body.append(el("p", { class: "muted" }, "This item has no version history."));
    return;
  }

  const list = el("ol", { class: "version-list" });
  versions.forEach((v, i) => {
    const current = i === 0;
    const downloadBtn = el(
      "button",
      {
        class: "btn btn-sm",
        type: "button",
        title: "Download this version",
        onclick: async () => {
          const dismiss = toast("Downloading version…", "info", 0);
          try {
            const bytes = await store.core.download(node.id, v.cid);
            dismiss();
            const blob = new Blob([bytes.slice().buffer], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${node.name}.v${versions.length - i}`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (err) {
            dismiss();
            toast(`Download failed: ${err instanceof Error ? err.message : String(err)}`, "error", 6000);
          }
        },
      },
      el("span", { class: "icon-inline", html: icons.download }),
      "Download",
    );

    const restoreBtn = current
      ? null
      : el(
          "button",
          {
            class: "btn btn-sm primary",
            type: "button",
            onclick: async () => {
              await restoreVersion(store, node.id, v.cid);
              m.close();
            },
          },
          el("span", { class: "icon-inline", html: icons.restore }),
          "Restore",
        );

    list.append(
      el(
        "li",
        { class: current ? "version-item current" : "version-item" },
        el(
          "div",
          { class: "version-dot-col" },
          el("span", { class: "version-dot", html: icons.dot }),
        ),
        el(
          "div",
          { class: "version-meta" },
          el(
            "div",
            { class: "version-head" },
            el("span", { class: "version-label" }, current ? "Current version" : `Version ${versions.length - i}`),
            current ? el("span", { class: "badge ok" }, "current") : null,
          ),
          el(
            "div",
            { class: "version-sub small muted" },
            `${formatBytes(v.size)} · ${formatRelative(v.mtimeMs)}`,
          ),
          el(
            "div",
            { class: "version-cid small mono muted", title: v.cid },
            `cid ${shortId(v.cid, 12, 8)}`,
          ),
          el("div", { class: "version-exact small muted" }, formatExact(v.mtimeMs)),
        ),
        el("div", { class: "version-actions" }, downloadBtn, restoreBtn),
      ),
    );
  });

  m.body.append(list);
  m.footer.append(el("button", { class: "btn", type: "button", onclick: () => m.close() }, "Close"));
}
