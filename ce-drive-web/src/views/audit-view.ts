/**
 * Audit view (§10 v1) — the immutable, tamper-evident record of access facts.
 *
 * In v1 the substrate is on-chain capability grant/revoke facts (TrustGrant /
 * RevokeCapability), read via `GET /history/:node_id` + the chain. This view renders those
 * facts plus local activity from the core. The on-chain read is a // TODO in the mock
 * adapter (audit.ts in ce-drive-core does the real `/history` read).
 */

import { el, mount } from "../lib/dom.js";
import { icons } from "../lib/icons.js";
import { formatExact, formatRelative } from "../lib/format.js";
import type { DriveStore } from "../store/drive-store.js";
import type { AuditEntry } from "../core/model.js";

const KIND_LABEL: Record<AuditEntry["kind"], string> = {
  grant: "Capability granted",
  revoke: "Capability revoked",
  upload: "Uploaded",
  download: "Downloaded",
  move: "Moved",
  trash: "Trashed",
  restore: "Restored",
};

export async function renderAudit(store: DriveStore, container: HTMLElement): Promise<void> {
  const entries = await store.core.audit();

  const note = el(
    "div",
    { class: "audit-note small muted" },
    el("span", { class: "icon-inline", html: icons.shield }),
    el(
      "span",
      {},
      "Capability grants and revokes are on-chain facts — an immutable, exportable trail of " +
        "who was granted or revoked access to what, when. A property a centralized Drive cannot offer.",
    ),
  );

  if (entries.length === 0) {
    mount(
      container,
      note,
      el(
        "div",
        { class: "empty-state" },
        el("span", { class: "empty-icon", html: icons.shield }),
        el("h3", {}, "No audit events yet"),
        el("p", { class: "muted" }, "Share, upload, move, or trash a file to record an audit fact."),
      ),
    );
    return;
  }

  const rows = entries.map((e) =>
    el(
      "div",
      { class: "audit-row" },
      el("span", { class: "audit-height mono small muted", title: "Block height" }, `#${e.height}`),
      el(
        "div",
        { class: "audit-meta" },
        el("div", { class: "audit-kind" }, KIND_LABEL[e.kind]),
        el("div", { class: "audit-detail small muted" }, e.detail),
      ),
      el(
        "span",
        { class: "audit-time small muted", title: formatExact(e.tsMs) },
        formatRelative(e.tsMs),
      ),
    ),
  );

  mount(container, note, el("div", { class: "audit-list" }, ...rows));
}
