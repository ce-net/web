import { describe, it, expect, vi } from "vitest";
import { RingBuffer, ExplorerStore } from "./store.js";
import { makeBlock, makeTx, makeAtlas, makeHistory, makeStatus } from "./__tests__/fixtures.js";

describe("RingBuffer", () => {
  it("keeps newest first and caps length", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    expect(rb.list()).toEqual([4, 3, 2]);
    expect(rb.size).toBe(3);
  });
  it("reset replaces and respects the cap", () => {
    const rb = new RingBuffer<number>(2);
    rb.reset([9, 8, 7]);
    expect(rb.list()).toEqual([9, 8]);
  });
});

describe("ExplorerStore", () => {
  it("emits the current snapshot immediately on subscribe", () => {
    const store = new ExplorerStore();
    const fn = vi.fn();
    store.subscribe(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0].blocks).toEqual([]);
  });

  it("pushes blocks newest-first and notifies", () => {
    const store = new ExplorerStore();
    const fn = vi.fn();
    store.subscribe(fn);
    store.onBlock(makeBlock({ index: 1 }));
    store.onBlock(makeBlock({ index: 2 }));
    const snap = store.snapshot();
    expect(snap.blocks.map((b) => b.index)).toEqual([2, 1]);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 blocks
  });

  it("derives peers and leaderboard from polled atlas + history", () => {
    const store = new ExplorerStore();
    store.setPolled({
      status: makeStatus(),
      atlas: [makeAtlas({ nodeId: "n1", tags: ["gpu"] })],
      history: new Map([["n1", makeHistory({ nodeId: "n1", jobsHosted: 4, jobsPaid: 2 })]]),
    });
    const snap = store.snapshot();
    expect(snap.peers).toHaveLength(1);
    expect(snap.peers[0]!.shareRatio).toBe(2);
    expect(snap.leaderboard[0]!.rank).toBe(1);
    expect(snap.lastPollAt).toBeGreaterThan(0);
  });

  it("tracks per-source state and errors", () => {
    const store = new ExplorerStore();
    store.setSource("blocks", "error", "boom");
    const snap = store.snapshot();
    expect(snap.sources["blocks"]).toBe("error");
    expect(snap.errors["blocks"]).toBe("boom");
  });

  it("records transactions and unsubscribe stops notifications", () => {
    const store = new ExplorerStore();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    off();
    store.onTx(makeTx({ id: "t1" }));
    expect(fn).toHaveBeenCalledTimes(1); // only the initial call
    expect(store.snapshot().txs.map((t) => t.id)).toEqual(["t1"]);
  });
});
