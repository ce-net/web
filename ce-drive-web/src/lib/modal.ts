/** Accessible modal dialog primitive — focus-trapped, ESC/backdrop close, ARIA. */

import { el } from "./dom.js";
import { icons } from "./icons.js";

export interface ModalHandle {
  /** The dialog body element to append content to. */
  body: HTMLElement;
  /** The footer element for action buttons. */
  footer: HTMLElement;
  /** Close the modal programmatically. */
  close(): void;
}

/** Open a modal with a title. Returns a handle to populate body/footer and close it. */
export function openModal(title: string, opts: { onClose?: () => void } = {}): ModalHandle {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
  const body = el("div", { class: "modal-body" });
  const footer = el("div", { class: "modal-footer" });

  const closeBtn = el("button", {
    class: "icon-btn modal-close",
    "aria-label": "Close dialog",
    type: "button",
    html: icons.x,
  });

  const dialog = el(
    "div",
    { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    el(
      "div",
      { class: "modal-head" },
      el("h2", { id: titleId, class: "modal-title" }, title),
      closeBtn,
    ),
    body,
    footer,
  );

  const backdrop = el("div", { class: "modal-backdrop" }, dialog);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    backdrop.classList.remove("show");
    backdrop.addEventListener("transitionend", () => backdrop.remove(), { once: true });
    setTimeout(() => backdrop.remove(), 300);
    previouslyFocused?.focus?.();
    opts.onClose?.();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      trapFocus(dialog, e);
    }
  };

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);

  document.body.append(backdrop);
  requestAnimationFrame(() => {
    backdrop.classList.add("show");
    (body.querySelector<HTMLElement>("input,button,select,textarea") ?? closeBtn).focus();
  });

  return { body, footer, close };
}

function trapFocus(container: HTMLElement, e: KeyboardEvent): void {
  const focusable = container.querySelectorAll<HTMLElement>(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
