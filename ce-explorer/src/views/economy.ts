import type { Job, Channel } from "@ce-net/sdk";
import { el } from "../ui/dom.js";
import { shortHash, formatCreditsUnit, groupThousands } from "../lib/format.js";
import { classifyJob } from "../lib/model.js";

/** A job row in the open-jobs panel. */
export function jobRow(j: Job): HTMLElement {
  const state = classifyJob(j);
  const amount = j.cost ?? j.bid;
  return el("div", { class: "row job-row", title: j.jobId }, [
    el("div", {}, [
      el("span", { class: "peer-id", text: shortHash(j.jobId, 8, 6) }),
      el("div", { class: "peer-meta" }, [
        j.payer ? el("span", { text: `payer ${shortHash(j.payer)}` }) : el("span", { class: "faint", text: "no payer" }),
        j.containerId ? el("span", { class: "faint", text: `box ${shortHash(j.containerId, 6, 4)}` }) : null,
      ]),
    ]),
    el("span", {
      class: amount && !amount.isZero() ? "amount" : "amount zero",
      text: amount ? formatCreditsUnit(amount) : "—",
    }),
    el("span", { class: `pill ${state}`, text: state }),
  ]);
}

/** A payment-channel row. */
export function channelRow(c: Channel): HTMLElement {
  return el("div", { class: "row chan-row", title: c.channelId }, [
    el("div", {}, [
      el("span", { class: "peer-id", text: shortHash(c.channelId, 8, 6) }),
      el("div", { class: "peer-meta" }, [
        el("span", { text: `${shortHash(c.payer)} → ${shortHash(c.host)}` }),
        el("span", { class: "faint", text: `expires @ ${groupThousands(String(c.expiryHeight))}` }),
      ]),
    ]),
    el("span", { class: "amount", text: formatCreditsUnit(c.capacity) }),
  ]);
}
