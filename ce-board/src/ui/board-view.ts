/**
 * The chart view: renders the board's depth zones (columns) and soundings (cards),
 * wires drag-and-drop + inline editing, and drives the sonar pulse on remote ops.
 *
 * Rendering is a full re-paint of the chart from the materialized board on every change.
 * That is deliberate and cheap at board scale: it keeps the view a pure function of
 * state (the same property the CRDT guarantees), so there is no view/state drift. Card
 * ids carry through to DOM `data-card` so we can target a specific card for the sonar
 * ring without re-finding it.
 */

import { el, clear } from "./dom.ts";
import { orderedCards, orderedColumns, rankBetween, type Board } from "../core/oplog.ts";

/** Callbacks the view raises; the controller turns them into ops. */
export interface ViewHandlers {
  addColumn(): void;
  renameColumn(id: string, title: string): void;
  deleteColumn(id: string): void;
  addCard(columnId: string): void;
  editCard(id: string, fields: { title?: string; body?: string }): void;
  deleteCard(id: string): void;
  /** Move `cardId` into `columnId` at fractional `pos`. */
  moveCard(cardId: string, columnId: string, pos: number): void;
}

interface DragState {
  cardId: string;
}

export class BoardView {
  private drag: DragState | null = null;
  /** Card id currently being edited inline, so a re-render preserves the editor. */
  private editing: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: ViewHandlers,
  ) {}

  /** Full repaint from the current board. */
  render(board: Board): void {
    clear(this.root);
    const cols = orderedColumns(board);

    if (cols.length === 0) {
      this.root.append(this.emptyChart());
      return;
    }

    cols.forEach((col, i) => {
      this.root.append(this.renderZone(board, col.id, col.title, i));
    });
    this.root.append(
      el("button", { class: "add-zone", "aria-label": "Add a depth zone (column)" }, "+ Add column"),
    );
    const addBtn = this.root.lastElementChild as HTMLButtonElement;
    addBtn.addEventListener("click", () => this.handlers.addColumn());
  }

  /** Open the inline editor for `cardId` and repaint (used right after adding a card). */
  startEditing(cardId: string): void {
    this.editing = cardId;
    this.requestRepaint?.();
  }

  /** Flash the sonar ring on a card touched by a remote peer's op. */
  pulseCard(cardId: string): void {
    const node = this.root.querySelector<HTMLElement>(`[data-card="${cssEscape(cardId)}"]`);
    if (!node) return;
    node.classList.remove("sonar");
    // reflow so re-adding the class restarts the animation
    void node.offsetWidth;
    node.classList.add("sonar");
  }

  private emptyChart(): HTMLElement {
    const wrap = el("div", { class: "curtain" });
    const inner = el("div", { class: "curtain-inner" });
    inner.append(
      el("h1", { text: "An empty chart" }),
      el("p", { text: "No depth zones yet. Add your first column to start sounding." }),
      el("p", {
        class: "",
        text: "Anyone else on this board id, on any node in the mesh, sees what you add in real time.",
      }),
    );
    const btn = el("button", { class: "btn primary", style: "margin-top:18px" }, "+ Add the first column");
    btn.addEventListener("click", () => this.handlers.addColumn());
    inner.append(btn);
    wrap.append(inner);
    return wrap;
  }

  private renderZone(board: Board, colId: string, title: string, index: number): HTMLElement {
    const cards = orderedCards(board, colId);
    const zone = el("section", { class: "zone", "data-col": colId, "aria-label": `Column ${title || "untitled"}` });

    // header
    const head = el("div", { class: "zone-head" });
    head.append(el("span", { class: "zone-depth", text: depthLabel(index) }));
    const titleIn = el("input", {
      class: "zone-title",
      value: title,
      "aria-label": "Column title",
      maxlength: 64,
    }) as HTMLInputElement;
    titleIn.addEventListener("change", () => {
      const v = titleIn.value.trim();
      if (v && v !== title) this.handlers.renameColumn(colId, v);
    });
    titleIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") titleIn.blur();
    });
    head.append(titleIn);
    head.append(el("span", { class: "zone-count", text: String(cards.length) }));
    const kill = el("button", { class: "zone-kill", title: "Delete column", "aria-label": "Delete column" }, "×");
    kill.addEventListener("click", () => {
      if (confirm(`Delete column "${title}" and its ${cards.length} card(s)?`)) this.handlers.deleteColumn(colId);
    });
    head.append(kill);
    zone.append(head);

    // card list — also the drop surface
    const list = el("div", { class: "zone-list" });
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drop-target");
    });
    list.addEventListener("dragleave", (e) => {
      if (!list.contains(e.relatedTarget as Node)) zone.classList.remove("drop-target");
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drop-target");
      this.onDrop(board, colId, e);
    });

    if (cards.length === 0 && this.editing === null) {
      list.append(el("div", { class: "zone-empty", text: "No soundings here yet." }));
    }
    for (const card of cards) list.append(this.renderCard(card.id, card.title, card.body, card.pos));
    zone.append(list);

    const add = el("button", { class: "zone-add", "aria-label": `Add a card to ${title}` }, "+ Add card");
    add.addEventListener("click", () => this.handlers.addCard(colId));
    zone.append(add);
    return zone;
  }

  private renderCard(id: string, title: string, body: string, pos: number): HTMLElement {
    if (this.editing === id) return this.renderCardEditor(id, title, body);

    const card = el("article", {
      class: "sounding",
      "data-card": id,
      draggable: true,
      tabindex: 0,
      role: "button",
      "aria-label": `Card: ${title}`,
    });
    card.append(el("div", { class: "s-title", text: title || "Untitled" }));
    if (body) card.append(el("div", { class: "s-body", text: body }));

    const foot = el("div", { class: "s-foot" });
    foot.append(el("span", { class: "s-depth", text: `▾ ${formatDepth(pos)}` }));
    const actions = el("div", { class: "s-actions" });
    const edit = el("button", { class: "edit", title: "Edit", "aria-label": "Edit card" }, "Edit");
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      this.beginEdit(id);
    });
    const del = el("button", { class: "del", title: "Delete", "aria-label": "Delete card" }, "Delete");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.handlers.deleteCard(id);
    });
    actions.append(edit, del);
    foot.append(actions);
    card.append(foot);

    // drag
    card.addEventListener("dragstart", (e) => {
      this.drag = { cardId: id };
      card.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      this.drag = null;
    });

    // keyboard: Enter/F2 edits, Delete removes
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        this.beginEdit(id);
      } else if (e.key === "Delete") {
        e.preventDefault();
        this.handlers.deleteCard(id);
      }
    });
    card.addEventListener("dblclick", () => this.beginEdit(id));

    return card;
  }

  private renderCardEditor(id: string, title: string, body: string): HTMLElement {
    const card = el("article", { class: "sounding", "data-card": id });
    const form = el("div", { class: "s-edit" });
    const titleIn = el("textarea", {
      class: "title-in",
      rows: 1,
      "aria-label": "Card title",
      placeholder: "Title",
    }) as HTMLTextAreaElement;
    titleIn.value = title;
    const bodyIn = el("textarea", {
      class: "body-in",
      "aria-label": "Card details",
      placeholder: "Details (optional)",
    }) as HTMLTextAreaElement;
    bodyIn.value = body;

    const row = el("div", { class: "s-edit-row" });
    const save = el("button", { class: "btn primary", style: "flex:1" }, "Save");
    const cancel = el("button", { class: "btn ghost" }, "Cancel");
    row.append(save, cancel);

    const commit = () => {
      const t = titleIn.value.trim();
      const b = bodyIn.value;
      this.editing = null;
      this.handlers.editCard(id, { title: t || "Untitled", body: b });
    };
    const dismiss = () => {
      this.editing = null;
      this.requestRepaint?.();
    };
    save.addEventListener("click", commit);
    cancel.addEventListener("click", dismiss);
    titleIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    });

    form.append(titleIn, bodyIn, row);
    card.append(form);
    queueMicrotask(() => {
      titleIn.focus();
      titleIn.select();
    });
    return card;
  }

  private beginEdit(id: string): void {
    this.editing = id;
    // trigger a repaint via a no-op edit path is wrong here; the controller re-renders
    // on the next state event. Instead, repaint immediately from the controller hook:
    this.requestRepaint?.();
  }

  /** Set by the controller so the view can ask for an immediate repaint (edit mode). */
  requestRepaint?: () => void;

  private onDrop(board: Board, columnId: string, e: DragEvent): void {
    const cardId = this.drag?.cardId ?? e.dataTransfer?.getData("text/plain");
    if (!cardId) return;
    const pos = this.dropPosition(board, columnId, e);
    this.handlers.moveCard(cardId, columnId, pos);
    this.drag = null;
  }

  /** Compute the fractional rank for a drop, based on pointer Y vs. existing cards. */
  private dropPosition(board: Board, columnId: string, e: DragEvent): number {
    const cards = orderedCards(board, columnId).filter((c) => c.id !== this.drag?.cardId);
    const list = (e.currentTarget as HTMLElement) ?? null;
    if (!list || cards.length === 0) return rankBetween(undefined, undefined);

    const nodes = [...list.querySelectorAll<HTMLElement>("[data-card]")].filter(
      (n) => n.dataset.card !== this.drag?.cardId,
    );
    const y = e.clientY;
    for (let i = 0; i < nodes.length; i++) {
      const rect = nodes[i]!.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        const before = i === 0 ? undefined : cards[i - 1]!.pos;
        return rankBetween(before, cards[i]!.pos);
      }
    }
    return rankBetween(cards[cards.length - 1]!.pos, undefined);
  }
}

/** Depth-zone marker for a column index: "0 m", "200 m", ... — chart vernacular. */
function depthLabel(index: number): string {
  return `${index * 200} m`;
}

/** Compact display of a card's fractional rank, in the instrument voice. */
function formatDepth(pos: number): string {
  if (!Number.isFinite(pos)) return "—";
  const r = Math.round(pos * 100) / 100;
  return `${r}`;
}

/** Minimal CSS.escape fallback for attribute selectors (card ids are safe slugs anyway). */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}
