/**
 * Board snapshots as CE objects.
 *
 * Replaying the full op history from genesis is fine for a demo but does not bootstrap
 * a new client cheaply. So we periodically materialize the folded {@link Board} into a
 * compact JSON snapshot and store it as a CE object via `data.putObject`, which returns
 * a content id (CID). A new client fetches the snapshot by CID, then tails live ops from
 * the mesh — exactly the "snapshot + log" pattern CE's data layer is built for.
 *
 * The snapshot carries the high-water Lamport value per client (the "frontier") so a
 * bootstrapping client can advance its clock past everything baked into the snapshot
 * and avoid re-emitting stamps that would lose to history. The snapshot itself is just
 * the surviving entities (LWW already applied) plus their winning field stamps, so a
 * late op that beats the snapshot still wins after the fold continues.
 */

import type { Board, Card, Column, Stamp } from "./oplog.ts";
import { emptyBoard } from "./oplog.ts";

export const SNAPSHOT_VERSION = 1 as const;

/** Serializable form of a {@link Board} (Maps flattened to arrays). */
export interface Snapshot {
  v: typeof SNAPSHOT_VERSION;
  name: string;
  columns: Column[];
  cards: Card[];
  /** Winning per-field stamps, so post-snapshot ops still resolve by LWW. */
  fieldStamps: [string, Stamp][];
  /** Max lamport seen per client at snapshot time (clock bootstrap frontier). */
  frontier: Record<string, number>;
}

/** Capture the current board as a serializable snapshot. */
export function toSnapshot(board: Board): Snapshot {
  const frontier: Record<string, number> = {};
  for (const [, st] of board.fieldStamps) {
    const cur = frontier[st.client] ?? 0;
    if (st.lamport > cur) frontier[st.client] = st.lamport;
  }
  return {
    v: SNAPSHOT_VERSION,
    name: board.name,
    columns: [...board.columns.values()],
    cards: [...board.cards.values()],
    fieldStamps: [...board.fieldStamps.entries()],
    frontier,
  };
}

/** Encode a snapshot to bytes for `data.putObject`. */
export function encodeSnapshot(board: Board): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(toSnapshot(board)));
}

/** Rebuild a board from a snapshot. Returns `null` if the bytes are not a v1 snapshot. */
export function decodeSnapshot(bytes: Uint8Array): { board: Board; frontier: Record<string, number> } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Partial<Snapshot>;
  if (s.v !== SNAPSHOT_VERSION) return null;
  if (typeof s.name !== "string" || !Array.isArray(s.columns) || !Array.isArray(s.cards)) return null;
  if (!Array.isArray(s.fieldStamps)) return null;

  const board = emptyBoard(s.name);
  for (const c of s.columns as Column[]) board.columns.set(c.id, { ...c });
  for (const c of s.cards as Card[]) board.cards.set(c.id, { ...c });
  for (const [k, st] of s.fieldStamps as [string, Stamp][]) board.fieldStamps.set(k, st);
  const frontier = (s.frontier && typeof s.frontier === "object" ? s.frontier : {}) as Record<string, number>;
  return { board, frontier };
}

/** The highest lamport across a frontier — what a fresh local clock should start at. */
export function frontierMax(frontier: Record<string, number>): number {
  let max = 0;
  for (const v of Object.values(frontier)) if (v > max) max = v;
  return max;
}
