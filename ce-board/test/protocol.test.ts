/** Wire-protocol round-trip + defensive parsing of foreign / malformed frames. */

import { describe, it, expect } from "vitest";
import { encodeOp, decodeEnvelope, validateOp, PROTOCOL_VERSION } from "../src/core/protocol.ts";
import type { Op } from "../src/core/oplog.ts";

const stamp = { lamport: 3, client: "node-x" };

describe("envelope round-trip", () => {
  it("encodes and decodes every op kind", () => {
    const ops: Op[] = [
      { t: "board.rename", stamp, name: "Board" },
      { t: "col.add", stamp, id: "c1", title: "Todo", pos: 0 },
      { t: "col.rename", stamp, id: "c1", title: "Doing" },
      { t: "col.move", stamp, id: "c1", pos: 2 },
      { t: "col.delete", stamp, id: "c1" },
      { t: "card.add", stamp, id: "k1", column: "c1", title: "Task", pos: 1 },
      { t: "card.edit", stamp, id: "k1", title: "T", body: "B" },
      { t: "card.move", stamp, id: "k1", column: "c2", pos: 3 },
      { t: "card.delete", stamp, id: "k1" },
    ];
    for (const op of ops) {
      const bytes = encodeOp("board-1", op);
      const env = decodeEnvelope(new TextDecoder().decode(bytes));
      expect(env).not.toBeNull();
      expect(env!.board).toBe("board-1");
      expect(env!.v).toBe(PROTOCOL_VERSION);
      expect(env!.op).toEqual(op);
    }
  });

  it("preserves a partial card.edit (only body)", () => {
    const op: Op = { t: "card.edit", stamp, id: "k1", body: "only body" };
    const env = decodeEnvelope(new TextDecoder().decode(encodeOp("b", op)));
    expect(env!.op).toEqual(op);
    expect("title" in env!.op).toBe(false);
  });
});

describe("defensive decode", () => {
  it("drops non-JSON, foreign objects, and wrong protocol versions", () => {
    expect(decodeEnvelope("not json{")).toBeNull();
    expect(decodeEnvelope("42")).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ hello: "world" }))).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ v: 999, board: "b", op: {} }))).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, board: "", op: {} }))).toBeNull();
  });

  it("rejects ops with missing or malformed stamps", () => {
    expect(validateOp({ t: "col.add", id: "c", title: "T", pos: 0 })).toBeNull();
    expect(validateOp({ t: "col.add", stamp: { lamport: "x", client: "c" }, id: "c", title: "T", pos: 0 })).toBeNull();
    expect(validateOp({ t: "col.add", stamp: { lamport: 1, client: "" }, id: "c", title: "T", pos: 0 })).toBeNull();
  });

  it("rejects ops with wrong field types", () => {
    expect(validateOp({ t: "col.add", stamp, id: "c", title: "T", pos: "0" })).toBeNull();
    expect(validateOp({ t: "card.add", stamp, id: "k", column: 5, title: "T", pos: 0 })).toBeNull();
    expect(validateOp({ t: "card.edit", stamp, id: "k", title: 7 })).toBeNull();
    expect(validateOp({ t: "unknown.kind", stamp, id: "k" })).toBeNull();
    expect(validateOp(null)).toBeNull();
    expect(validateOp("nope")).toBeNull();
  });

  it("returns a fresh trusted object, not the raw input", () => {
    const raw = { t: "col.delete", stamp, id: "c1", extra: "ignored" } as Record<string, unknown>;
    const op = validateOp(raw);
    expect(op).toEqual({ t: "col.delete", stamp, id: "c1" });
    expect((op as Record<string, unknown>).extra).toBeUndefined();
  });
});
