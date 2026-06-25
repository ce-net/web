/** Snapshot codec: a board survives encode→decode, and the frontier bootstraps a clock. */

import { describe, it, expect } from "vitest";
import { foldOps, applyOp, orderedColumns, orderedCards, Clock, type Op } from "../src/core/oplog.ts";
import { encodeSnapshot, decodeSnapshot, frontierMax, toSnapshot } from "../src/core/snapshot.ts";

function script(): Op[] {
  return [
    { t: "board.rename", stamp: { lamport: 1, client: "a" }, name: "Q3 plan" },
    { t: "col.add", stamp: { lamport: 2, client: "a" }, id: "c1", title: "Todo", pos: 0 },
    { t: "col.add", stamp: { lamport: 3, client: "b" }, id: "c2", title: "Done", pos: 1 },
    { t: "card.add", stamp: { lamport: 5, client: "a" }, id: "k1", column: "c1", title: "Task", pos: 0 },
    { t: "card.edit", stamp: { lamport: 8, client: "b" }, id: "k1", body: "details" },
  ];
}

describe("snapshot round-trip", () => {
  it("rebuilds an identical observable board", () => {
    const board = foldOps(script());
    const restored = decodeSnapshot(encodeSnapshot(board));
    expect(restored).not.toBeNull();
    const r = restored!.board;
    expect(r.name).toBe("Q3 plan");
    expect(orderedColumns(r).map((c) => c.title)).toEqual(["Todo", "Done"]);
    expect(orderedCards(r, "c1").map((c) => c.title)).toEqual(["Task"]);
    expect(r.cards.get("k1")!.body).toBe("details");
  });

  it("captures the per-client frontier and bootstraps a clock past it", () => {
    const board = foldOps(script());
    const snap = toSnapshot(board);
    expect(snap.frontier).toEqual({ a: 5, b: 8 });
    expect(frontierMax(snap.frontier)).toBe(8);

    const restored = decodeSnapshot(encodeSnapshot(board))!;
    const clock = new Clock("c");
    clock.observe({ lamport: frontierMax(restored.frontier), client: "c" });
    // A post-bootstrap op must sort after everything baked into the snapshot.
    expect(clock.tick().lamport).toBe(9);
  });

  it("a late op that beats the snapshot still wins after continued folding", () => {
    const board = foldOps(script());
    const restored = decodeSnapshot(encodeSnapshot(board))!.board;
    // body was set at stamp 8 by b; a newer edit at stamp 9 wins.
    expect(applyOp(restored, { t: "card.edit", stamp: { lamport: 9, client: "a" }, id: "k1", body: "newer" })).toBe(true);
    expect(restored.cards.get("k1")!.body).toBe("newer");
    // a stale edit (stamp 4) loses.
    expect(applyOp(restored, { t: "card.edit", stamp: { lamport: 4, client: "a" }, id: "k1", body: "stale" })).toBe(false);
    expect(restored.cards.get("k1")!.body).toBe("newer");
  });
});

describe("snapshot defensive decode", () => {
  it("rejects non-snapshot bytes", () => {
    expect(decodeSnapshot(new TextEncoder().encode("garbage{"))).toBeNull();
    expect(decodeSnapshot(new TextEncoder().encode(JSON.stringify({ v: 99 })))).toBeNull();
    expect(decodeSnapshot(new TextEncoder().encode(JSON.stringify({ v: 1, name: 5 })))).toBeNull();
  });

  it("frontierMax of an empty frontier is 0", () => {
    expect(frontierMax({})).toBe(0);
  });
});
