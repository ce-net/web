/**
 * Wire protocol for ce-board ops over the CE mesh.
 *
 * Each op is published to the board's pubsub topic as a single JSON envelope. We
 * version the envelope (`v`) and tag it with the board id so a node subscribed to
 * several boards can demux a single mesh stream, and so a future format bump can be
 * detected and skipped rather than mis-parsed.
 *
 * Parsing is total and defensive: anything that is not a well-formed ce-board op
 * envelope (foreign pubsub traffic, truncated frames, a newer protocol version)
 * decodes to `null` and is dropped by the service. A malformed op must never crash a
 * peer's fold loop.
 */

import type { Op, Stamp } from "./oplog.ts";

export const PROTOCOL_VERSION = 1 as const;

/** What actually travels over the mesh: a versioned, board-scoped op. */
export interface Envelope {
  v: typeof PROTOCOL_VERSION;
  /** Board id this op belongs to (matches the topic). */
  board: string;
  op: Op;
}

/** Serialize an op for a board into UTF-8 bytes ready for `mesh.publish`. */
export function encodeOp(boardId: string, op: Op): Uint8Array {
  const env: Envelope = { v: PROTOCOL_VERSION, board: boardId, op };
  return new TextEncoder().encode(JSON.stringify(env));
}

/** Serialize the envelope to a JSON string (used by the snapshot codec + tests). */
export function encodeEnvelopeText(boardId: string, op: Op): string {
  const env: Envelope = { v: PROTOCOL_VERSION, board: boardId, op };
  return JSON.stringify(env);
}

/**
 * Parse a mesh frame's text back into an {@link Envelope}, or `null` if it is not a
 * valid ce-board op for the current protocol version. Never throws.
 */
export function decodeEnvelope(text: string): Envelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  if (raw.v !== PROTOCOL_VERSION) return null;
  if (typeof raw.board !== "string" || raw.board.length === 0) return null;
  const op = validateOp(raw.op);
  if (!op) return null;
  return { v: PROTOCOL_VERSION, board: raw.board, op };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function validateStamp(x: unknown): Stamp | null {
  if (!isObj(x)) return null;
  if (typeof x.lamport !== "number" || !Number.isFinite(x.lamport)) return null;
  if (typeof x.client !== "string" || x.client.length === 0) return null;
  return { lamport: x.lamport, client: x.client };
}

const STR = (x: unknown): x is string => typeof x === "string";
const NUM = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Validate and narrow an unknown into a typed {@link Op}. Returns a fresh, trusted op
 * object (never the raw parsed value) so downstream code can rely on the shape.
 */
export function validateOp(x: unknown): Op | null {
  if (!isObj(x)) return null;
  const stamp = validateStamp(x.stamp);
  if (!stamp) return null;
  switch (x.t) {
    case "board.rename":
      return STR(x.name) ? { t: "board.rename", stamp, name: x.name } : null;
    case "col.add":
      return STR(x.id) && STR(x.title) && NUM(x.pos)
        ? { t: "col.add", stamp, id: x.id, title: x.title, pos: x.pos }
        : null;
    case "col.rename":
      return STR(x.id) && STR(x.title) ? { t: "col.rename", stamp, id: x.id, title: x.title } : null;
    case "col.move":
      return STR(x.id) && NUM(x.pos) ? { t: "col.move", stamp, id: x.id, pos: x.pos } : null;
    case "col.delete":
      return STR(x.id) ? { t: "col.delete", stamp, id: x.id } : null;
    case "card.add":
      return STR(x.id) && STR(x.column) && STR(x.title) && NUM(x.pos)
        ? { t: "card.add", stamp, id: x.id, column: x.column, title: x.title, pos: x.pos }
        : null;
    case "card.edit": {
      if (!STR(x.id)) return null;
      const op: Op = { t: "card.edit", stamp, id: x.id };
      if (x.title !== undefined) {
        if (!STR(x.title)) return null;
        op.title = x.title;
      }
      if (x.body !== undefined) {
        if (!STR(x.body)) return null;
        op.body = x.body;
      }
      return op;
    }
    case "card.move":
      return STR(x.id) && STR(x.column) && NUM(x.pos)
        ? { t: "card.move", stamp, id: x.id, column: x.column, pos: x.pos }
        : null;
    case "card.delete":
      return STR(x.id) ? { t: "card.delete", stamp, id: x.id } : null;
    default:
      return null;
  }
}
