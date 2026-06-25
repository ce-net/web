import { describe, it, expect } from "vitest";
import type { CeClient } from "@ce-net/sdk";
import { ExplorerStore } from "./store.js";
import { ExplorerRuntime, recentMiners } from "./runtime.js";
import { FakeClient, makeAtlas, makeHistory, makeStatus, makeBlock } from "./__tests__/fixtures.js";

/** The runtime only touches a small slice of CeClient; cast the fake to it. */
function rt(fake: FakeClient, store: ExplorerStore): ExplorerRuntime {
  return new ExplorerRuntime(fake as unknown as CeClient, store);
}

describe("ExplorerRuntime.pollOnce", () => {
  it("folds status, atlas, jobs, channels and per-peer history into the store", async () => {
    const fake = new FakeClient();
    fake.status = makeStatus({ nodeId: "self" });
    fake.atlasData = [makeAtlas({ nodeId: "n1" }), makeAtlas({ nodeId: "n2" })];
    fake.historyData.set("n1", makeHistory({ nodeId: "n1", jobsHosted: 3, jobsPaid: 1 }));
    // n2 deliberately has no history — must not crash.

    const store = new ExplorerStore();
    await rt(fake, store).pollOnce();

    const snap = store.snapshot();
    expect(snap.status?.nodeId).toBe("self");
    expect(snap.peers.map((p) => p.nodeId).sort()).toEqual(["n1", "n2"]);
    expect(snap.peers.find((p) => p.nodeId === "n1")!.shareRatio).toBe(3);
    expect(snap.peers.find((p) => p.nodeId === "n2")!.shareRatio).toBeNull();
    expect(snap.sources["poll"]).toBe("live");
  });

  it("isolates a failing source: atlas error doesn't sink the rest", async () => {
    const fake = new FakeClient();
    fake.failAtlas = true;
    fake.status = makeStatus({ nodeId: "self" });

    const store = new ExplorerStore();
    await rt(fake, store).pollOnce();

    const snap = store.snapshot();
    expect(snap.sources["atlas"]).toBe("error");
    expect(snap.errors["atlas"]).toBeTruthy();
    expect(snap.sources["status"]).toBe("live");
    expect(snap.status?.nodeId).toBe("self");
  });

  it("queries self even when the atlas is empty", async () => {
    const fake = new FakeClient();
    fake.status = makeStatus({ nodeId: "self" });
    fake.historyData.set("self", makeHistory({ nodeId: "self", jobsHosted: 1 }));

    const store = new ExplorerStore();
    await rt(fake, store).pollOnce();
    // self is offline (not in atlas) but appears via history.
    const snap = store.snapshot();
    expect(snap.peers.map((p) => p.nodeId)).toContain("self");
    expect(snap.peers.find((p) => p.nodeId === "self")!.online).toBe(false);
  });
});

describe("recentMiners", () => {
  it("returns distinct miners newest-first up to the limit", () => {
    const blocks = [
      makeBlock({ index: 3, miner: "a" }),
      makeBlock({ index: 2, miner: "b" }),
      makeBlock({ index: 1, miner: "a" }),
    ];
    expect(recentMiners(blocks)).toEqual(["a", "b"]);
    expect(recentMiners(blocks, 1)).toEqual(["a"]);
  });
});
