import type { NodeStatus } from "@ce-net/sdk";
import { el } from "../ui/dom.js";
import { formatCredits, groupThousands } from "../lib/format.js";

interface Metric {
  k: string;
  v: string;
  tone?: "amber" | "coral" | "foam";
  sub?: string;
}

/** Derive the headline metrics from node status + live peer/tx counts. */
export function metricsFor(
  status: NodeStatus | null,
  peerCount: number,
  txRate: string,
): Metric[] {
  if (!status) {
    return [
      { k: "height", v: "—" },
      { k: "supply", v: "—" },
      { k: "burned", v: "—" },
      { k: "peers", v: String(peerCount) },
    ];
  }
  return [
    { k: "block height", v: groupThousands(String(status.height)), sub: `difficulty ${status.difficulty}` },
    { k: "circulating", v: formatCredits(status.circulatingSupply, 0), tone: "foam", sub: "credits" },
    { k: "burned", v: formatCredits(status.burnedTotal, 0), tone: "coral", sub: "credits, gone" },
    { k: "peers in atlas", v: String(peerCount), sub: txRate },
  ];
}

/** Render one metric tile. `changed` triggers the breathe glow. */
export function metricTile(m: Metric, changed: boolean): HTMLElement {
  return el("div", { class: `metric${changed ? " breathe" : ""}`, "data-k": m.k }, [
    el("div", { class: "k", text: m.k }),
    el("div", { class: `v${m.tone ? " " + m.tone : ""}`, text: m.v }),
    m.sub ? el("div", { class: "sub", text: m.sub }) : null,
  ]);
}
