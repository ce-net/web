/** A small accessible text-prompt dialog (replaces window.prompt with a styled modal). */

import { openModal } from "../lib/modal.js";
import { el } from "../lib/dom.js";

export function promptText(opts: {
  title: string;
  label: string;
  value?: string;
  confirmLabel?: string;
  /** Select the basename (before the extension) on open — handy for renames. */
  selectBasename?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const m = openModal(opts.title, {
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });

    const input = el("input", {
      class: "field",
      type: "text",
      value: opts.value ?? "",
      "aria-label": opts.label,
      autocomplete: "off",
      spellcheck: false,
    });

    const submit = (): void => {
      if (settled) return;
      const v = input.value.trim();
      if (!v) {
        input.focus();
        return;
      }
      settled = true;
      resolve(v);
      m.close();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    m.body.append(el("label", { class: "field-label" }, opts.label), input);
    m.footer.append(
      el("button", { class: "btn", type: "button", onclick: () => m.close() }, "Cancel"),
      el("button", { class: "btn primary", type: "button", onclick: submit }, opts.confirmLabel ?? "OK"),
    );

    requestAnimationFrame(() => {
      input.focus();
      if (opts.value) {
        const dot = opts.selectBasename ? opts.value.lastIndexOf(".") : -1;
        input.setSelectionRange(0, dot > 0 ? dot : opts.value.length);
      }
    });
  });
}
