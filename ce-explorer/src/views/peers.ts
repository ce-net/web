import { el } from "../ui/dom.js";
import { shortHash, timeAgo, formatMemMb, formatCreditsUnit } from "../lib/format.js";
import { formatRatio } from "../lib/model.js";
import type { PeerRow, LeaderRow } from "../lib/model.js";

/** A peer row in the atlas panel. */
export function peerRow(p: PeerRow, isSelf: boolean): HTMLElement {
  const meta: (HTMLElement | null)[] = [
    el("span", { text: p.online ? `${p.cpuCores} cores` : "offline" }),
    p.online ? el("span", { text: formatMemMb(p.memMb) }) : null,
    p.online ? el("span", { text: `${p.runningJobs} jobs` }) : null,
    p.online
      ? el("span", { class: "faint", text: seenLabel(p.lastSeenSecs) })
      : null,
  ];

  const tags =
    p.tags.length > 0
      ? el(
          "div",
          { class: "tags" },
          p.tags.map((t) => el("span", { class: "tag-chip", text: t })),
        )
      : null;

  return el("div", { class: "row peer-row", title: p.nodeId }, [
    el("div", {}, [
      el("span", { class: "peer-id", text: shortHash(p.nodeId, 10, 8) }),
      isSelf ? el("span", { class: "tag-chip", "data-active": "true", text: "this node" }) : null,
      el("div", { class: "peer-meta" }, meta),
      tags,
    ]),
    el("div", { style: "text-align:right" }, [
      el("span", { class: "ratio", text: formatRatio(p.shareRatio) }),
      el("div", { class: "when", text: "share ratio" }),
    ]),
  ]);
}

function seenLabel(secs: number): string {
  if (!Number.isFinite(secs)) return "";
  return `seen ${timeAgo(Math.floor(Date.now() / 1000) - secs)}`;
}

/** A leaderboard row, with a give/take bar capped at ratio 3.0 for the visual. */
export function leaderRow(p: LeaderRow): HTMLElement {
  const ratio = p.shareRatio ?? 0;
  const pct =
    ratio === Number.POSITIVE_INFINITY ? 100 : Math.min(100, (ratio / 3) * 100);
  const under = ratio < 1;
  return el("div", { class: "row peer-row", title: p.nodeId }, [
    el("div", { style: "display:flex; gap:12px; align-items:flex-start" }, [
      el("span", { class: `rank${p.rank <= 3 ? " top" : ""}`, text: String(p.rank) }),
      el("div", { style: "flex:1; min-width:0" }, [
        el("span", { class: "peer-id", text: shortHash(p.nodeId, 10, 8) }),
        el("div", { class: "peer-meta" }, [
          el("span", { text: `gave ${p.delivered}` }),
          el("span", { text: `took ${p.consumed}` }),
          p.earned ? el("span", { class: "faint", text: `earned ${formatCreditsUnit(p.earned, 0)}` }) : null,
        ]),
        el("div", { class: "bar" }, [el("span", { style: `width:${pct}%` })]),
      ]),
    ]),
    el("div", { style: "text-align:right" }, [
      el("span", { class: `ratio${under ? " under" : ""}`, text: formatRatio(p.shareRatio) }),
    ]),
  ]);
}
