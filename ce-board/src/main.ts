/**
 * ce-board entry point.
 *
 * Wires the real SDK adapter into the BoardService and the chart view: it owns the
 * shell (bridge bar, connection banner, fleet of peer vessels, status ledger, toasts)
 * and the lifecycle (health probe -> identity -> snapshot bootstrap -> live op tail).
 * All board *logic* lives in src/core and is unit-tested with no node; this file is the
 * thin, browser-only glue.
 */

import "./styles/app.css";
import { el, clear } from "./ui/dom.ts";
import { BoardView, type ViewHandlers } from "./ui/board-view.ts";
import { BoardService } from "./core/service.ts";
import { orderedColumns, orderedCards, rankBetween, type Op } from "./core/oplog.ts";
import { opsTopic, normalizeBoardId, snapshotKey, isValidBoardId } from "./core/topics.ts";
import { newId } from "./core/ids.ts";
import { shortId, hueFor, formatCredits } from "./core/format.ts";
import { toFriendly, type FriendlyError } from "./core/errors.ts";
import {
  makeClient,
  meshAdapter,
  dataAdapter,
  nodeHealthy,
  fetchIdentity,
  fetchMoney,
  DEFAULT_NODE_URL,
} from "./core/sdk-adapter.ts";
import { Amount } from "@ce-net/sdk";

/** Pick the board id from the URL hash (`#roadmap`), defaulting to a shared demo board. */
function initialBoardId(): string {
  const fromHash = normalizeBoardId(decodeURIComponent(location.hash.replace(/^#/, "")));
  return fromHash && isValidBoardId(fromHash) ? fromHash : "harbor";
}

/** Recent peers seen on the op stream (their vessels appear on the bridge). */
class Fleet {
  private readonly seen = new Map<string, number>();
  mark(from: string): void {
    this.seen.set(from, Date.now());
  }
  /** Peers active in the last 90s, newest first. */
  active(now = Date.now()): string[] {
    const live: [string, number][] = [];
    for (const [id, ts] of this.seen) if (now - ts < 90_000) live.push([id, ts]);
    return live.sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
}

class App {
  private readonly root: HTMLElement;
  private readonly client = makeClient();
  private service: BoardService | null = null;
  private view!: BoardView;
  private boardId = initialBoardId();
  private nodeId = "";
  private readonly fleet = new Fleet();
  private money: { free: Amount; total: Amount } | null = null;
  private connected = false;

  // shell nodes
  private chartEl!: HTMLElement;
  private bannerEl!: HTMLElement;
  private fleetEl!: HTMLElement;
  private ledgerEl!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private dotEl!: HTMLElement;
  private toastStack!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
    this.renderShell();
    window.addEventListener("hashchange", () => {
      const next = initialBoardId();
      if (next !== this.boardId) this.switchBoard(next);
    });
    await this.connect();
  }

  // ---- Shell ---------------------------------------------------------------------

  private renderShell(): void {
    clear(this.root);
    this.root.removeAttribute("aria-busy");

    // bridge
    const bridge = el("header", { class: "bridge", role: "banner" });
    const brand = el("div", { class: "brand" });
    brand.append(
      el("span", { class: "mark", html: "ce&#8202;<b>board</b>" }),
      el("span", { class: "tag", text: "kanban on the sea" }),
    );
    bridge.append(brand);

    const switcher = el("div", { class: "board-switch" });
    switcher.append(el("label", { for: "board-name", text: "board" }));
    const field = el("div", { class: "board-name-field" });
    this.nameInput = el("input", {
      id: "board-name",
      value: this.boardId,
      "aria-label": "Board id — anyone on the same id converges",
      spellcheck: false,
      autocomplete: "off",
    }) as HTMLInputElement;
    this.nameInput.addEventListener("change", () => {
      const next = normalizeBoardId(this.nameInput.value);
      if (next && next !== this.boardId) {
        location.hash = next;
      } else {
        this.nameInput.value = this.boardId;
      }
    });
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.nameInput.blur();
    });
    field.append(this.nameInput);
    switcher.append(field);
    bridge.append(switcher);

    bridge.append(el("div", { class: "spacer" }));

    this.fleetEl = el("div", { class: "fleet", "aria-label": "Peers on this board" });
    bridge.append(this.fleetEl);

    const identity = el("div", { class: "identity" });
    identity.append(
      el("span", { class: "who", id: "who", text: "connecting…" }),
      el("span", { class: "readout", id: "readout", html: "&nbsp;" }),
    );
    bridge.append(identity);
    this.root.append(bridge);

    // banner
    this.bannerEl = el("div", { class: "banner", role: "status" });
    this.root.append(this.bannerEl);

    // chart
    this.chartEl = el("main", { class: "chart", id: "chart", "aria-label": "Board" });
    this.root.append(this.chartEl);

    // ledger
    this.ledgerEl = el("footer", { class: "ledger", role: "contentinfo" });
    this.dotEl = el("span", { class: "dot" });
    this.ledgerEl.append(this.dotEl);
    this.root.append(this.ledgerEl);

    // toasts
    this.toastStack = el("div", { class: "toast-stack", "aria-live": "polite" });
    document.body.append(this.toastStack);

    // view
    const handlers = this.makeHandlers();
    this.view = new BoardView(this.chartEl, handlers);
    this.view.requestRepaint = () => this.repaint();

    this.showLoading("Sounding the mesh…");
  }

  private showLoading(msg: string): void {
    clear(this.chartEl);
    const wrap = el("div", { class: "curtain" });
    const inner = el("div", { class: "curtain-inner" });
    inner.append(el("div", { class: "sonar-loader" }), el("h1", { text: msg }));
    wrap.append(inner);
    this.chartEl.append(wrap);
  }

  // ---- Connect / bootstrap -------------------------------------------------------

  private async connect(): Promise<void> {
    try {
      const healthy = await nodeHealthy(this.client);
      if (!healthy) throw new NodeDownError();
      const id = await fetchIdentity(this.client);
      this.nodeId = id.nodeId;
      this.connected = true;
      this.hideBanner();
      this.setWho();
      await this.mountBoard();
      void this.refreshMoney();
    } catch (err) {
      this.connected = false;
      this.showConnectionError(err);
    }
  }

  private async mountBoard(): Promise<void> {
    this.service?.stop();
    const topic = opsTopic(this.boardId);
    this.service = new BoardService(
      meshAdapter(this.client),
      dataAdapter(this.client),
      this.boardId,
      topic,
      this.nodeId,
      {
        onChange: () => this.repaint(),
        onRemoteOp: (from, op) => this.onRemoteOp(from, op),
        onStreamError: (e) => this.showConnectionError(e),
      },
    );
    this.showLoading("Loading the chart…");
    const cid = localStorage.getItem(snapshotKey(this.boardId));
    await this.service.bootstrap(cid);
    this.repaint();
    this.updateLedger();
  }

  private switchBoard(next: string): void {
    this.boardId = next;
    this.nameInput.value = next;
    if (this.connected) void this.mountBoard();
  }

  // ---- View handlers (turn UI intents into ops) ----------------------------------

  private makeHandlers(): ViewHandlers {
    const svc = () => {
      if (!this.service) throw new NodeDownError();
      return this.service;
    };
    const wrap = (p: Promise<void>) => p.catch((e) => this.toastError(e));

    return {
      addColumn: () => {
        const s = svc();
        const board = s.current();
        const cols = orderedColumns(board);
        const last = cols[cols.length - 1]?.pos;
        const pos = rankBetween(last, undefined);
        const id = newId("col", s.clientId());
        wrap(s.addColumn(id, `Column ${cols.length + 1}`, pos)).then(() => this.maybeSnapshot());
      },
      renameColumn: (id, title) => wrap(svc().renameColumn(id, title)),
      deleteColumn: (id) => wrap(svc().deleteColumn(id)).then(() => this.maybeSnapshot()),
      addCard: (columnId) => {
        const s = svc();
        const cards = orderedCards(s.current(), columnId);
        const last = cards[cards.length - 1]?.pos;
        const pos = rankBetween(last, undefined);
        const id = newId("card", s.clientId());
        wrap(s.addCard(id, columnId, "New card", pos)).then(() => {
          this.repaint();
          this.beginEditFromController(id);
        });
      },
      editCard: (id, fields) => {
        if (fields.title === undefined && fields.body === undefined) {
          this.repaint();
          return;
        }
        wrap(svc().editCard(id, fields)).then(() => this.maybeSnapshot());
      },
      deleteCard: (id) => wrap(svc().deleteCard(id)).then(() => this.maybeSnapshot()),
      moveCard: (cardId, columnId, pos) => wrap(svc().moveCard(cardId, columnId, pos)).then(() => this.maybeSnapshot()),
    };
  }

  /** Open the inline editor for a freshly-added card. */
  private beginEditFromController(id: string): void {
    this.view.startEditing(id);
  }

  // ---- Reactions -----------------------------------------------------------------

  private repaint(): void {
    if (!this.service) return;
    this.view.render(this.service.current());
    this.updateLedger();
  }

  private onRemoteOp(from: string, op: Op): void {
    this.fleet.mark(from);
    this.renderFleet(from);
    // The board repaints from onChange; defer the sonar ring to the next frame so it
    // lands on the freshly-rendered card node. Card-scoped ops pulse the card itself.
    const cardId = "id" in op && op.t.startsWith("card.") ? op.id : null;
    if (cardId) requestAnimationFrame(() => this.view.pulseCard(cardId));
    this.updateLedger();
  }

  private renderFleet(justActive?: string): void {
    clear(this.fleetEl);
    const peers = this.fleet.active();
    if (peers.length === 0) {
      this.fleetEl.append(el("span", { class: "fleet-label", text: "solo" }));
      return;
    }
    this.fleetEl.append(el("span", { class: "fleet-label", text: `${peers.length} aboard` }));
    for (const p of peers.slice(0, 6)) {
      const hue = hueFor(p);
      const v = el("div", {
        class: "vessel",
        title: p,
        style: `background:hsl(${hue} 62% 62%)`,
        text: p.slice(0, 2),
      });
      if (p === justActive) v.classList.add("pulse");
      this.fleetEl.append(v);
    }
  }

  private setWho(): void {
    const who = document.getElementById("who");
    if (who) who.textContent = `node ${shortId(this.nodeId)}`;
  }

  private updateLedger(): void {
    clear(this.ledgerEl);
    this.dotEl = el("span", { class: `dot ${this.connected ? "up" : ""}` });
    const ops = this.service?.opsFolded() ?? 0;
    const board = this.service?.current();
    const cards = board ? [...board.cards.values()].filter((c) => !c.deleted).length : 0;
    const cols = board ? board.columns.size : 0;
    this.ledgerEl.append(
      this.dotEl,
      el("span", { html: this.connected ? "<span class='k'>mesh</span> linked" : "<span class='k'>mesh</span> down" }),
      sep(),
      el("span", { html: `<span class='k'>board</span> ${this.boardId}` }),
      sep(),
      el("span", { html: `<span class='k'>ops</span> ${ops}` }),
      sep(),
      el("span", { html: `<span class='k'>cols</span> ${cols} · <span class='k'>cards</span> ${cards}` }),
      el("span", { class: "grow" }),
    );
    if (this.money) {
      this.ledgerEl.append(
        el("span", { html: `<span class='k'>free</span> ${formatCredits(this.money.free)} cr` }),
      );
    }
    this.ledgerEl.append(el("span", { html: `<span class='k'>api</span> ${DEFAULT_NODE_URL}` }));
  }

  private async refreshMoney(): Promise<void> {
    this.money = await fetchMoney(this.client);
    this.updateLedger();
  }

  // ---- Snapshot persistence ------------------------------------------------------

  private snapshotting = false;
  private dirtyOps = 0;

  /** Persist a snapshot every ~12 mutations, best-effort. The op stream is the source of truth. */
  private maybeSnapshot(): void {
    this.dirtyOps++;
    if (this.dirtyOps < 12 || this.snapshotting || !this.service) return;
    this.dirtyOps = 0;
    this.snapshotting = true;
    this.service
      .saveSnapshot()
      .then((cid) => {
        localStorage.setItem(snapshotKey(this.boardId), cid);
      })
      .catch(() => {
        /* snapshot is an optimization; ignore failures */
      })
      .finally(() => {
        this.snapshotting = false;
      });
  }

  // ---- Banners / toasts ----------------------------------------------------------

  private hideBanner(): void {
    this.bannerEl.className = "banner";
    clear(this.bannerEl);
  }

  private showConnectionError(err: unknown): void {
    const f = toFriendly(err);
    if (f.kind !== "offline" && f.kind !== "server") {
      this.toastError(err);
      return;
    }
    this.connected = false;
    this.bannerEl.className = "banner show offline";
    clear(this.bannerEl);
    this.bannerEl.append(
      el("span", { text: f.message }),
      f.hint ? el("span", { class: "hint", text: f.hint }) : el("span"),
    );
    const retry = el("button", {}, "Reconnect");
    retry.addEventListener("click", () => {
      this.hideBanner();
      this.showLoading("Reconnecting…");
      void this.connect();
    });
    this.bannerEl.append(retry);
    this.updateLedger();
  }

  private toastError(err: unknown): void {
    this.toast(toFriendly(err), true);
  }

  private toast(f: FriendlyError, isError: boolean): void {
    const t = el("div", { class: `toast ${isError ? "err" : ""}`, role: "alert" });
    t.append(el("div", { class: "t-msg", text: f.message }));
    if (f.hint) t.append(el("div", { class: "t-hint", text: f.hint }));
    this.toastStack.append(t);
    setTimeout(() => t.remove(), 5200);
  }
}

function sep(): HTMLElement {
  return el("span", { text: "·", style: "color:var(--mute)" });
}

/** Synthetic error so `toFriendly` renders the node-down offline banner consistently. */
class NodeDownError extends Error {
  override name = "CeConnectionError";
  constructor() {
    super("CE node unreachable");
  }
}

const root = document.getElementById("app");
if (root) {
  void new App(root).start();
}
