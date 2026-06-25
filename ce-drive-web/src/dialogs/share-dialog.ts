/**
 * Share dialog — mint / revoke a Drive capability for a node's subtree (§5).
 *
 * UI is complete: choose ability (read/comment/write/admin), audience (a node id or
 * "anyone with link"), optional expiry, then mint. Live grants are listed with a revoke
 * button. The actual signed ce-cap chain is minted by ce-drive-core / the node — see the
 * // TODO markers in core/mock-adapter.ts (`share`/`revoke`) for the wire call.
 */

import { openModal } from "../lib/modal.js";
import { el, clear } from "../lib/dom.js";
import { icons } from "../lib/icons.js";
import { toast } from "../lib/toast.js";
import { formatExact, shortId } from "../lib/format.js";
import type { DriveStore } from "../store/drive-store.js";
import type { DriveAbility, DriveNode, ShareGrant } from "../core/model.js";

const ABILITIES: { value: DriveAbility; label: string; hint: string }[] = [
  { value: "drive:read", label: "Viewer", hint: "Can view and download" },
  { value: "drive:comment", label: "Commenter", hint: "Can view and comment" },
  { value: "drive:write", label: "Editor", hint: "Can edit, upload, and move" },
  { value: "drive:admin", label: "Admin", hint: "Can edit and re-share" },
];

export function openShareDialog(store: DriveStore, node: DriveNode): void {
  const m = openModal(`Share "${node.name}"`);

  const abilitySel = el(
    "select",
    { class: "field", "aria-label": "Access level" },
    ...ABILITIES.map((a) => el("option", { value: a.value }, `${a.label} — ${a.hint}`)),
  ) as HTMLSelectElement;
  abilitySel.value = "drive:read";

  const audienceInput = el("input", {
    class: "field",
    type: "text",
    placeholder: "Node id, or leave blank for anyone with the link",
    "aria-label": "Grantee node id",
    autocomplete: "off",
    spellcheck: false,
  }) as HTMLInputElement;

  const expirySel = el(
    "select",
    { class: "field", "aria-label": "Expiry" },
    el("option", { value: "0" }, "No expiry"),
    el("option", { value: "1" }, "1 day"),
    el("option", { value: "7" }, "7 days"),
    el("option", { value: "30" }, "30 days"),
    el("option", { value: "90" }, "90 days"),
  ) as HTMLSelectElement;

  const grantsBox = el("div", { class: "share-grants" });

  const renderGrants = async (): Promise<void> => {
    const grants = await store.core.shares(node.id);
    clear(grantsBox);
    if (grants.length === 0) {
      grantsBox.append(el("p", { class: "muted small" }, "No active shares yet."));
      return;
    }
    grantsBox.append(el("div", { class: "share-grants-title" }, "Active shares"));
    for (const g of grants) grantsBox.append(grantRow(store, g, renderGrants));
  };

  const mint = async (asLink: boolean): Promise<void> => {
    const days = Number(expirySel.value);
    const audience = audienceInput.value.trim() || null;
    try {
      const grant = await store.core.share({
        subtree: node.id,
        ability: abilitySel.value as DriveAbility,
        audience: asLink ? null : audience,
        expiresMs: days > 0 ? Date.now() + days * 86_400_000 : null,
        asLink,
      });
      if (asLink && grant.link) {
        await copyToClipboard(grant.link);
        toast("Share link copied to clipboard", "ok");
      } else {
        toast("Capability minted", "ok");
      }
      audienceInput.value = "";
      await renderGrants();
    } catch (err) {
      toast(`Could not mint capability: ${err instanceof Error ? err.message : String(err)}`, "error", 6000);
    }
  };

  m.body.append(
    el(
      "div",
      { class: "share-note" },
      el("span", { class: "icon-inline", html: icons.shield }),
      el(
        "span",
        { class: "small muted" },
        "Sharing is an attenuating, revocable capability — not an ACL row. A holder can " +
          "re-share a strictly weaker grant, never widen it.",
      ),
    ),
    el("label", { class: "field-label" }, "Access level"),
    abilitySel,
    el("label", { class: "field-label" }, "Grant to"),
    audienceInput,
    el("label", { class: "field-label" }, "Expires"),
    expirySel,
    grantsBox,
  );

  m.footer.append(
    el(
      "button",
      { class: "btn", type: "button", onclick: () => void mint(true) },
      el("span", { class: "icon-inline", html: icons.link }),
      "Copy link",
    ),
    el(
      "button",
      { class: "btn primary", type: "button", onclick: () => void mint(false) },
      el("span", { class: "icon-inline", html: icons.share }),
      "Share",
    ),
  );

  void renderGrants();
}

function grantRow(store: DriveStore, g: ShareGrant, refresh: () => Promise<void>): HTMLElement {
  const who = g.audience ? shortId(g.audience, 10, 6) : "Anyone with the link";
  const ability = ABILITIES.find((a) => a.value === g.ability)?.label ?? g.ability;
  const expiry = g.expiresMs ? `expires ${formatExact(g.expiresMs)}` : "no expiry";
  return el(
    "div",
    { class: "grant-row" },
    el("span", { class: "icon-inline", html: g.audience ? icons.shield : icons.link }),
    el(
      "div",
      { class: "grant-meta" },
      el("div", { class: "grant-who" }, who),
      el("div", { class: "grant-sub small muted" }, `${ability} · ${expiry}`),
    ),
    el(
      "button",
      {
        class: "btn btn-sm danger",
        type: "button",
        onclick: async () => {
          await store.core.revoke(g.id);
          toast("Capability revoked", "ok");
          await refresh();
        },
      },
      "Revoke",
    ),
  );
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for insecure contexts / older browsers.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
