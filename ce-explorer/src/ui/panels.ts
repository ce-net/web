import { el } from "./dom.js";
import type { SourceState } from "../lib/store.js";

/** A panel shell with a titled header (optional count + right-side slot). */
export function panel(opts: {
  title: string;
  count?: number;
  right?: Node;
  tall?: boolean;
  body: Node;
}): HTMLElement {
  return el("section", { class: "panel" }, [
    el("div", { class: "panel-head" }, [
      el("div", { class: "panel-title" }, [
        document.createTextNode(opts.title),
        opts.count !== undefined ? el("span", { class: "count", text: String(opts.count) }) : null,
      ]),
      opts.right ?? null,
    ]),
    el("div", { class: `panel-body${opts.tall ? " tall" : ""}` }, [opts.body]),
  ]);
}

/** A friendly empty state — an invitation to act, not a dead end. */
export function emptyState(title: string, hint: string): HTMLElement {
  return el("div", { class: "state" }, [
    el("div", { class: "big", text: title }),
    el("div", { text: hint }),
  ]);
}

/** An error state in the interface's voice. */
export function errorState(message: string): HTMLElement {
  return el("div", { class: "state err" }, [
    el("div", { class: "big", text: "Couldn't load" }),
    el("div", { text: message }),
  ]);
}

/** Skeleton loading rows for a feed that hasn't produced data yet. */
export function loadingRows(n = 4): HTMLElement {
  return el(
    "div",
    {},
    Array.from({ length: n }, () =>
      el("div", { class: "skeleton-row" }, [
        el("div", { class: "skeleton" }),
        el("div", { class: "skeleton" }),
        el("div", { class: "skeleton" }),
      ]),
    ),
  );
}

/** A connection dot + label for one live source. */
export function sourcePill(name: string, state: SourceState): HTMLElement {
  return el("span", { title: `${name}: ${state}` }, [
    el("span", { class: `dot ${state}` }),
    el("span", { text: name }),
  ]);
}
