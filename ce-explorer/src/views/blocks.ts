import type { BlockEvent } from "@ce-net/sdk";
import { el } from "../ui/dom.js";
import { shortHash, timeAgo, groupThousands } from "../lib/format.js";

/** A single block row in the live feed. `fresh` marks a just-arrived block. */
export function blockRow(b: BlockEvent, fresh: boolean): HTMLElement {
  return el("div", { class: `row block-row${fresh ? " enter" : ""}`, title: b.hash }, [
    el("span", { class: "idx", text: `#${groupThousands(String(b.index))}` }),
    el("div", {}, [
      el("div", { class: "hash", text: shortHash(b.hash, 10, 8) }),
      el("div", { class: "peer-meta" }, [
        el("span", { text: `miner ${shortHash(b.miner)}` }),
        el("span", { text: `${b.txCount} tx` }),
      ]),
    ]),
    el("span", { class: "when", text: timeAgo(b.timestamp) }),
  ]);
}
