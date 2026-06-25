import "./ui/styles.css";
import { el, mount } from "./ui/dom.js";
import { panel, emptyState, errorState, loadingRows, sourcePill } from "./ui/panels.js";
import { PulseRail } from "./ui/rail.js";
import { makeClient } from "./lib/config.js";
import { ExplorerStore } from "./lib/store.js";
import type { ExplorerSnapshot } from "./lib/store.js";
import { ExplorerRuntime } from "./lib/runtime.js";
import { metricsFor, metricTile } from "./views/metrics.js";
import { blockRow } from "./views/blocks.js";
import { txRow } from "./views/txs.js";
import { peerRow, leaderRow } from "./views/peers.js";
import { jobRow, channelRow } from "./views/economy.js";
import { tagFacets, peerMatches } from "./lib/model.js";
import { shortHash } from "./lib/format.js";

/** UI state that lives outside the node snapshot (search box, tag filter). */
interface UiState {
  peerQuery: string;
  activeTag: string | null;
}

const ui: UiState = { peerQuery: "", activeTag: null };

const store = new ExplorerStore();
const client = makeClient();
const runtime = new ExplorerRuntime(client, store);

const root = document.getElementById("app")!;
const rail = new PulseRail();

// Stable mount points so we re-render regions in place (no full-page churn).
const metricsMount = el("div", { class: "metrics" });
const blocksMount = el("div");
const txsMount = el("div");
const atlasMount = el("div");
const leaderMount = el("div");
const jobsMount = el("div");
const channelsMount = el("div");
const connMount = el("div", { class: "conn" });
const selfMount = el("span", { class: "self" });

// Track tx arrivals to show a rough rate; track last metric values for breathe.
let txWindow: number[] = [];
let lastMetricVals: Record<string, string> = {};
let firstBlockSeen = false;
let firstTxSeen = false;

function buildShell(): void {
  const masthead = el("header", { class: "masthead" }, [
    el("div", { class: "masthead-row" }, [
      el("div", { class: "wordmark" }, [
        el("span", {}, [document.createTextNode("ce"), el("span", { class: "sea", text: "·explorer" })]),
        el("span", { class: "tag", text: "see the mesh breathe" }),
      ]),
      connMount,
    ]),
    rail.root,
  ]);

  const left = el("div", {}, [
    panel({ title: "Live blocks", body: blocksMount, tall: true }),
    el("div", { style: "height:20px" }),
    panel({ title: "Open jobs", body: jobsMount }),
  ]);

  const right = el("div", {}, [
    panel({ title: "Transactions", body: txsMount, tall: true }),
    el("div", { style: "height:20px" }),
    panel({ title: "Payment channels", body: channelsMount }),
  ]);

  const searchInput = el("input", {
    type: "search",
    placeholder: "filter by node id or tag…",
    "aria-label": "Filter peers by node id or tag",
    oninput: (e: Event) => {
      ui.peerQuery = (e.target as HTMLInputElement).value;
      render(store.snapshot());
    },
  });

  const atlasPanel = panel({
    title: "Capacity atlas",
    right: el("div", { class: "search" }, [searchInput]),
    body: atlasMount,
    tall: true,
  });

  const leaderPanel = panel({ title: "Share-ratio leaderboard", body: leaderMount, tall: true });

  mount(
    root,
    masthead,
    el("main", { class: "app" }, [
      metricsMount,
      el("div", { class: "grid" }, [left, right]),
      el("div", { style: "height:20px" }),
      el("div", { class: "grid" }, [atlasPanel, leaderPanel]),
      el("footer", { class: "footer" }, [
        el("div", {}, [document.createTextNode("ce-explorer · read-only · "), selfMount]),
        el("div", { text: "data: @ce-net/sdk → local node" }),
      ]),
    ]),
  );
}

function render(snap: ExplorerSnapshot): void {
  renderConn(snap);
  renderMetrics(snap);
  renderBlocks(snap);
  renderTxs(snap);
  renderAtlas(snap);
  renderLeaderboard(snap);
  renderJobs(snap);
  renderChannels(snap);
}

function renderConn(snap: ExplorerSnapshot): void {
  const order = ["blocks", "transactions", "poll"];
  mount(
    connMount,
    ...order.map((n) => sourcePill(n, snap.sources[n] ?? "idle")),
  );
  if (snap.status) {
    selfMount.textContent = `node ${shortHash(snap.status.nodeId, 8, 6)}`;
  }
}

function renderMetrics(snap: ExplorerSnapshot): void {
  const metrics = metricsFor(snap.status, snap.peers.length, txRateLabel());
  mount(
    metricsMount,
    ...metrics.map((m) => {
      const changed = lastMetricVals[m.k] !== undefined && lastMetricVals[m.k] !== m.v;
      lastMetricVals[m.k] = m.v;
      return metricTile(m, changed);
    }),
  );
}

function renderBlocks(snap: ExplorerSnapshot): void {
  const src = snap.sources["blocks"];
  if (snap.blocks.length === 0) {
    if (src === "error") {
      mount(blocksMount, errorState(snap.errors["blocks"] ?? "Stream unavailable."));
    } else if (src === "live") {
      mount(blocksMount, emptyState("Waiting for the next block", "Nodes mine roughly every 10 seconds. Sit tight."));
    } else {
      mount(blocksMount, loadingRows());
    }
    return;
  }
  const head = snap.blocks[0]!;
  rail.setHeight(head.index);
  rail.ping(head.index, head.miner);
  const fresh = !firstBlockSeen ? false : true;
  firstBlockSeen = true;
  mount(blocksMount, ...snap.blocks.map((b, i) => blockRow(b, i === 0 && fresh)));
}

function renderTxs(snap: ExplorerSnapshot): void {
  const src = snap.sources["transactions"];
  if (snap.txs.length === 0) {
    if (src === "error") {
      mount(txsMount, errorState(snap.errors["transactions"] ?? "Stream unavailable."));
    } else if (src === "live") {
      mount(txsMount, emptyState("No transactions yet", "Rewards, transfers, and job settlements will appear here as they confirm."));
    } else {
      mount(txsMount, loadingRows());
    }
    return;
  }
  // Update the tx-rate window from the newest count delta.
  txWindow.push(Date.now());
  txWindow = txWindow.filter((t) => Date.now() - t < 60000);
  const fresh = firstTxSeen;
  firstTxSeen = true;
  mount(txsMount, ...snap.txs.map((t, i) => txRow(t, i === 0 && fresh)));
}

function renderAtlas(snap: ExplorerSnapshot): void {
  if (snap.peers.length === 0) {
    const pollErr = snap.sources["atlas"] === "error";
    mount(
      atlasMount,
      pollErr
        ? errorState(snap.errors["atlas"] ?? "Atlas read failed.")
        : snap.lastPollAt === 0
          ? loadingRows()
          : emptyState("No peers advertising capacity", "Start a second node, or run `ce start` elsewhere on the mesh."),
    );
    return;
  }

  const facets = tagFacets(snap.peers);
  const chips =
    facets.length > 0
      ? el(
          "div",
          { class: "tags", style: "padding:10px 16px; border-bottom:1px solid var(--line-soft)" },
          [
            el("span", {
              class: "tag-chip click",
              "data-active": ui.activeTag === null ? "true" : "false",
              text: "all",
              onclick: () => {
                ui.activeTag = null;
                render(store.snapshot());
              },
            }),
            ...facets.map((f) =>
              el("span", {
                class: "tag-chip click",
                "data-active": ui.activeTag === f.tag ? "true" : "false",
                text: `${f.tag} ${f.count}`,
                onclick: () => {
                  ui.activeTag = ui.activeTag === f.tag ? null : f.tag;
                  render(store.snapshot());
                },
              }),
            ),
          ],
        )
      : null;

  const selfId = snap.status?.nodeId;
  const filtered = snap.peers.filter(
    (p) =>
      peerMatches(p, ui.peerQuery) &&
      (ui.activeTag === null || p.tags.includes(ui.activeTag)),
  );

  if (filtered.length === 0) {
    mount(atlasMount, chips ?? document.createTextNode(""), emptyState("No matches", "Clear the filter to see every peer."));
    return;
  }

  mount(
    atlasMount,
    chips ?? document.createTextNode(""),
    ...filtered.map((p) => peerRow(p, p.nodeId === selfId)),
  );
}

function renderLeaderboard(snap: ExplorerSnapshot): void {
  if (snap.leaderboard.length === 0) {
    mount(
      leaderMount,
      snap.lastPollAt === 0
        ? loadingRows()
        : emptyState("No share history yet", "Ratios appear once peers have hosted or paid for work."),
    );
    return;
  }
  mount(leaderMount, ...snap.leaderboard.slice(0, 50).map(leaderRow));
}

function renderJobs(snap: ExplorerSnapshot): void {
  if (snap.jobs.length === 0) {
    const err = snap.sources["jobs"] === "error";
    mount(
      jobsMount,
      err
        ? errorState(snap.errors["jobs"] ?? "Jobs read failed.")
        : snap.lastPollAt === 0
          ? loadingRows(3)
          : emptyState("No active jobs", "This node isn't paying for or hosting any containers right now."),
    );
    return;
  }
  mount(jobsMount, ...snap.jobs.map(jobRow));
}

function renderChannels(snap: ExplorerSnapshot): void {
  if (snap.channels.length === 0) {
    mount(
      channelsMount,
      snap.lastPollAt === 0
        ? loadingRows(3)
        : emptyState("No open channels", "Payment channels let nodes stream micro-payments off-chain."),
    );
    return;
  }
  mount(channelsMount, ...snap.channels.map(channelRow));
}

function txRateLabel(): string {
  const n = txWindow.length;
  if (n === 0) return "—";
  return `${n} tx / min`;
}

// Re-render relative timestamps every few seconds without new data.
function tick(): void {
  render(store.snapshot());
}

function bootstrap(): void {
  buildShell();
  store.subscribe(render);
  runtime.start();
  setInterval(tick, 5000);
  window.addEventListener("beforeunload", () => runtime.stop());
}

bootstrap();
