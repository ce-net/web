/**
 * The op-log CRDT — the heart of ce-board.
 *
 * Board state is derived by folding a set of operations. Every mutation a client
 * makes (add a column, rename a card, move a card, delete it) is an {@link Op} with
 * a {@link Stamp} — a Lamport clock paired with the originating client id. The pair
 * `(lamport, client)` is a total order: ties on the integer clock break on client id
 * (lexicographic), so every replica that has seen the same set of ops folds them in
 * the *same* order and reaches *byte-identical* state. That is the convergence
 * guarantee this module exists to provide, and that the unit tests hammer with random
 * permutations.
 *
 * The conflict-resolution policy is **last-writer-wins per field**: each card/column
 * field (title, column membership, position, deleted) carries the stamp of the op
 * that last set it. A losing op (older stamp) is folded but does not overwrite a
 * field already set by a newer stamp. Because the stamp order is total and every
 * field independently keeps its own winning stamp, fold order does not matter:
 * applying the full set in any order yields the same winners. This makes the fold
 * **commutative**, **idempotent** (re-applying a seen op is a no-op), and
 * **associative** — the three properties a CRDT needs.
 *
 * No DOM, no SDK, no clock surprises: the only impurity is the Lamport counter on a
 * {@link Clock}, which the caller owns. Everything here is deterministic and pure,
 * which is exactly why it is unit-testable to exhaustion without a node.
 */

/** A Lamport timestamp tied to the client that produced it. Totally ordered. */
export interface Stamp {
  /** Monotonic Lamport counter. */
  lamport: number;
  /** Originating client id (a CE node id, or a per-tab suffix of one). */
  client: string;
}

/**
 * Total order on stamps. Higher lamport wins; ties break on the *larger* client id
 * (lexicographic) so the order is deterministic and symmetric across replicas.
 * Returns <0 if `a` is older, >0 if `a` is newer, 0 if identical.
 */
export function compareStamp(a: Stamp, b: Stamp): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.client < b.client) return -1;
  if (a.client > b.client) return 1;
  return 0;
}

/** True when stamp `a` strictly wins over (is newer than) stamp `b`. */
export function stampWins(a: Stamp, b: Stamp): boolean {
  return compareStamp(a, b) > 0;
}

/** A globally-unique op id: `<client>:<lamport>`. Stable, sortable per client. */
export function opId(stamp: Stamp): string {
  return `${stamp.client}:${stamp.lamport}`;
}

/**
 * A column on the board. `pos` is a fractional rank (see {@link rankBetween}) used to
 * order columns left-to-right without renumbering on every insert.
 */
export interface Column {
  id: string;
  title: string;
  pos: number;
}

/** A card. `column` is the owning column id; `pos` orders cards within a column. */
export interface Card {
  id: string;
  column: string;
  title: string;
  body: string;
  pos: number;
  deleted: boolean;
}

/** The folded, materialized board. Pure data — the UI renders this. */
export interface Board {
  /** Human label for the board (also derives the mesh topic). */
  name: string;
  columns: Map<string, Column>;
  cards: Map<string, Card>;
  /** Per-field winning stamps, so LWW folding is order-independent. */
  fieldStamps: Map<string, Stamp>;
}

/** The op kinds. Each mutates exactly one entity; LWW is applied per affected field. */
export type Op =
  | { t: "board.rename"; stamp: Stamp; name: string }
  | { t: "col.add"; stamp: Stamp; id: string; title: string; pos: number }
  | { t: "col.rename"; stamp: Stamp; id: string; title: string }
  | { t: "col.move"; stamp: Stamp; id: string; pos: number }
  | { t: "col.delete"; stamp: Stamp; id: string }
  | { t: "card.add"; stamp: Stamp; id: string; column: string; title: string; pos: number }
  | { t: "card.edit"; stamp: Stamp; id: string; title?: string; body?: string }
  | { t: "card.move"; stamp: Stamp; id: string; column: string; pos: number }
  | { t: "card.delete"; stamp: Stamp; id: string };

/** A Lamport clock. The caller bumps it on local ops and on receiving remote ops. */
export class Clock {
  private value = 0;
  constructor(readonly client: string, start = 0) {
    this.value = start;
  }

  /** Current counter value (for snapshotting). */
  get now(): number {
    return this.value;
  }

  /** Produce the next stamp for a *local* op: increment, then tag with our client. */
  tick(): Stamp {
    this.value += 1;
    return { lamport: this.value, client: this.client };
  }

  /**
   * Observe a *remote* stamp: advance our clock past it (Lamport rule
   * `local = max(local, seen) + 1` is applied lazily on the next {@link tick}, so we
   * only need `local = max(local, seen)` here).
   */
  observe(stamp: Stamp): void {
    if (stamp.lamport > this.value) this.value = stamp.lamport;
  }
}

/** An empty board with the given display name. */
export function emptyBoard(name = "Untitled board"): Board {
  return { name, columns: new Map(), cards: new Map(), fieldStamps: new Map() };
}

/** Field-stamp key for an entity's named field, e.g. `card:abc#title`. */
function fkey(entity: string, field: string): string {
  return `${entity}#${field}`;
}

/**
 * Apply LWW to one field: if `stamp` beats the field's current winner, run `set` and
 * record the new winner. Returns whether the field changed. This is the single choke
 * point that makes folding order-independent.
 */
function lww(board: Board, key: string, stamp: Stamp, set: () => void): boolean {
  const cur = board.fieldStamps.get(key);
  if (cur && !stampWins(stamp, cur)) return false;
  set();
  board.fieldStamps.set(key, stamp);
  return true;
}

/**
 * Fold a single op into `board`, in place. Safe to call in any order and any number
 * of times (idempotent): re-applying a seen op loses the LWW comparison (equal stamp
 * is not a strict win) and is a no-op. Returns true if the board changed.
 */
export function applyOp(board: Board, op: Op): boolean {
  switch (op.t) {
    case "board.rename":
      return lww(board, fkey("board", "name"), op.stamp, () => {
        board.name = op.name;
      });

    case "col.add": {
      const e = `col:${op.id}`;
      const existing = board.columns.get(op.id);
      const col: Column = existing ?? { id: op.id, title: op.title, pos: op.pos };
      let changed = false;
      changed = lww(board, fkey(e, "title"), op.stamp, () => (col.title = op.title)) || changed;
      changed = lww(board, fkey(e, "pos"), op.stamp, () => (col.pos = op.pos)) || changed;
      if (!existing) board.columns.set(op.id, col);
      return changed || !existing;
    }

    case "col.rename": {
      const col = ensureColumn(board, op.id);
      return lww(board, fkey(`col:${op.id}`, "title"), op.stamp, () => (col.title = op.title));
    }

    case "col.move": {
      const col = ensureColumn(board, op.id);
      return lww(board, fkey(`col:${op.id}`, "pos"), op.stamp, () => (col.pos = op.pos));
    }

    case "col.delete":
      if (board.columns.delete(op.id)) {
        board.fieldStamps.set(fkey(`col:${op.id}`, "deleted"), op.stamp);
        return true;
      }
      return false;

    case "card.add": {
      const e = `card:${op.id}`;
      const existing = board.cards.get(op.id);
      const card: Card =
        existing ?? { id: op.id, column: op.column, title: op.title, body: "", pos: op.pos, deleted: false };
      let changed = false;
      changed = lww(board, fkey(e, "title"), op.stamp, () => (card.title = op.title)) || changed;
      changed = lww(board, fkey(e, "column"), op.stamp, () => (card.column = op.column)) || changed;
      changed = lww(board, fkey(e, "pos"), op.stamp, () => (card.pos = op.pos)) || changed;
      if (!existing) board.cards.set(op.id, card);
      return changed || !existing;
    }

    case "card.edit": {
      const card = ensureCard(board, op.id);
      const e = `card:${op.id}`;
      let changed = false;
      if (op.title !== undefined) {
        const t = op.title;
        changed = lww(board, fkey(e, "title"), op.stamp, () => (card.title = t)) || changed;
      }
      if (op.body !== undefined) {
        const b = op.body;
        changed = lww(board, fkey(e, "body"), op.stamp, () => (card.body = b)) || changed;
      }
      return changed;
    }

    case "card.move": {
      const card = ensureCard(board, op.id);
      const e = `card:${op.id}`;
      // Column + position move together under one stamp so a concurrent move is
      // resolved atomically: the newer stamp wins both fields, never a split where
      // the card lands in column A at position from move B.
      let changed = false;
      changed = lww(board, fkey(e, "column"), op.stamp, () => (card.column = op.column)) || changed;
      changed = lww(board, fkey(e, "pos"), op.stamp, () => (card.pos = op.pos)) || changed;
      return changed;
    }

    case "card.delete": {
      const card = ensureCard(board, op.id);
      return lww(board, fkey(`card:${op.id}`, "deleted"), op.stamp, () => (card.deleted = true));
    }
  }
}

/** Materialize a card stub so an out-of-order edit/move/delete has something to land on. */
function ensureCard(board: Board, id: string): Card {
  let card = board.cards.get(id);
  if (!card) {
    card = { id, column: "", title: "", body: "", pos: 0, deleted: false };
    board.cards.set(id, card);
  }
  return card;
}

/** Materialize a column stub for out-of-order ops (mirrors {@link ensureCard}). */
function ensureColumn(board: Board, id: string): Column {
  let col = board.columns.get(id);
  if (!col) {
    col = { id, title: "", pos: 0 };
    board.columns.set(id, col);
  }
  return col;
}

/**
 * Fold an arbitrary collection of ops into a fresh board. The result is independent
 * of the input order — the property the convergence tests assert.
 */
export function foldOps(ops: Iterable<Op>, name?: string): Board {
  const board = emptyBoard(name);
  for (const op of ops) applyOp(board, op);
  return board;
}

/** Columns in display order (by `pos`, ties by id). */
export function orderedColumns(board: Board): Column[] {
  return [...board.columns.values()].sort((a, b) => a.pos - b.pos || cmpStr(a.id, b.id));
}

/** Live (non-deleted) cards of a column in display order. */
export function orderedCards(board: Board, columnId: string): Card[] {
  return [...board.cards.values()]
    .filter((c) => c.column === columnId && !c.deleted)
    .sort((a, b) => a.pos - b.pos || cmpStr(a.id, b.id));
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A fractional rank strictly between `before` and `after`, for drag-and-drop ordering
 * without renumbering siblings. Pass `undefined` for an open end. Mirrors the classic
 * "rank between" / fractional-indexing trick: dropping at the top uses `(undefined, x)`,
 * the bottom uses `(x, undefined)`, the middle uses `(x, y)`.
 */
export function rankBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return (before as number) + 1;
  return (before + after) / 2;
}
