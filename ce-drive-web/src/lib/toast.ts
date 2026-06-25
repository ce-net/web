/** Lightweight, accessible toast notifications. */

import { el } from "./dom.js";

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (host) return host;
  host = el("div", { class: "toast-host", role: "status", "aria-live": "polite" });
  document.body.append(host);
  return host;
}

export type ToastKind = "ok" | "error" | "info";

/** Show a transient toast. Returns a dismiss function. */
export function toast(message: string, kind: ToastKind = "info", ttlMs = 4000): () => void {
  const node = el("div", { class: `toast toast-${kind}` }, message);
  ensureHost().append(node);
  // Trigger enter transition on next frame.
  requestAnimationFrame(() => node.classList.add("show"));
  let done = false;
  const dismiss = (): void => {
    if (done) return;
    done = true;
    node.classList.remove("show");
    node.addEventListener("transitionend", () => node.remove(), { once: true });
    // Fallback removal in case the transition does not fire.
    setTimeout(() => node.remove(), 400);
  };
  if (ttlMs > 0) setTimeout(dismiss, ttlMs);
  return dismiss;
}
