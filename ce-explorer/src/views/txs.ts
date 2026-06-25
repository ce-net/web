import type { TxEvent } from "@ce-net/sdk";
import { el } from "../ui/dom.js";
import { shortHash, formatCreditsUnit } from "../lib/format.js";
import { txMovesValue, txKindLabel } from "../lib/model.js";

/** A single transaction row in the live feed. */
export function txRow(t: TxEvent, fresh: boolean): HTMLElement {
  const value = txMovesValue(t.kind);
  const isZero = t.amount.isZero();
  return el("div", { class: `row tx-row${fresh ? " enter" : ""}`, title: t.id }, [
    el("span", { class: `tx-glyph${value ? " value" : ""}` }),
    el("div", {}, [
      el("span", { class: `kind ${value ? "value" : "control"}`, text: txKindLabel(t.kind) }),
      el("span", { class: "hash", text: `  ${shortHash(t.id, 8, 6)}` }),
      el("div", { class: "peer-meta" }, [
        el("span", { text: `origin ${shortHash(t.origin)}` }),
      ]),
    ]),
    el("span", {
      class: `amount${isZero ? " zero" : ""}`,
      text: isZero ? "—" : formatCreditsUnit(t.amount),
    }),
  ]);
}
