/**
 * Regression test for code-review finding H5 (HIGH) + the unbounded-memory follow-up.
 *
 * H5: WasmDriveCore keyed its convergence topic by the LOCAL DEVICE node id (`self`), so two
 * devices of the same drive published to / subscribed to DIFFERENT topics and could never see
 * each other's ops — the multi-device story was silently single-device. The fix derives the
 * topic from a STABLE, SHARED drive id (identical on every device), keeping `self` only for
 * CRDT op authorship.
 *
 * These tests:
 *   1. Prove convergence: two cores with DIFFERENT `self` ids but the SAME `driveId` exchange
 *      ops over a shared in-memory bus and fold to identical state. (This FAILS on the old code
 *      because each core would have subscribed to `ce-drive/ops/<its-own-self>` — the assertion
 *      below pins the topic to the drive id, which the old `driveTopic(this.self)` violated.)
 *   2. Prove the topic is keyed by the drive id, not the device id (the exact hole H5 closed).
 *   3. Prove `seenOps` stays bounded under a flood of distinct ops (memory follow-up).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { loadCrdtForTest } from "./wasm-loader.js";
import {
  type ObjectBackend,
  type OpTransport,
  WasmDriveCore,
} from "../src/core/wasm-adapter.js";
import { ROOT } from "../src/core/model.js";
import type { TreeSnapshot } from "../src/core/drive-core.js";

// Pre-instantiate the wasm singleton via the fetch-free test loader; the production
// `WasmDriveCore.create` -> `loadDriveWasm()` then short-circuits (wasm already initialized).
beforeAll(async () => {
  await loadCrdtForTest();
});

/** An in-memory pub/sub bus shared by every core in a test — one map of topic -> subscribers. */
class TestBus {
  private readonly subs = new Map<string, Set<(p: Uint8Array) => void>>();
  /** Topics that have ever been published to (to assert which topic a core actually used). */
  readonly publishedTopics = new Set<string>();

  transport(): OpTransport {
    return {
      publish: async (topic, payload) => {
        this.publishedTopics.add(topic);
        const set = this.subs.get(topic);
        if (set) for (const fn of [...set]) fn(payload);
      },
      subscribe: async () => {},
      messages: (topic, onMessage) => {
        let set = this.subs.get(topic);
        if (!set) {
          set = new Set();
          this.subs.set(topic, set);
        }
        set.add(onMessage);
        return () => set?.delete(onMessage);
      },
    };
  }
}

/** A trivial content-addressed in-memory object/blob backend (CID = hex of bytes length+head). */
function memObjects(): ObjectBackend {
  const store = new Map<string, Uint8Array>();
  let n = 0;
  return {
    putObject: async (bytes) => {
      const cid = `cid-${(n++).toString(16)}-${bytes.length}`;
      store.set(cid, bytes);
      return cid;
    },
    getObject: async (cid) => store.get(cid) ?? new Uint8Array(),
    putBlob: async (bytes) => {
      const h = `blob-${(n++).toString(16)}`;
      store.set(h, bytes);
      return h;
    },
    getBlob: async (h) => store.get(h) ?? new Uint8Array(),
  };
}

/** Canonical, delivery-order-independent fingerprint of a core's full live tree. */
async function fingerprint(core: WasmDriveCore): Promise<string> {
  const snap: TreeSnapshot = await core.tree();
  const lines: string[] = [];
  for (const node of snap.nodes.values()) {
    lines.push(`${node.path}\t${node.kind}\t${node.cid ?? "-"}`);
  }
  return lines.sort().join("\n");
}

describe("WasmDriveCore multi-device convergence (H5)", () => {
  it("two devices with different self ids but the SAME drive id converge", async () => {
    const bus = new TestBus();
    const driveId = "drive-shared-owner-identity";

    // Device A and Device B: DIFFERENT node ids (authorship), SAME drive id (topic).
    const a = await WasmDriveCore.create({
      objects: memObjects(),
      transport: bus.transport(),
      self: "device-A-node-id",
      driveId,
    });
    const b = await WasmDriveCore.create({
      objects: memObjects(),
      transport: bus.transport(),
      self: "device-B-node-id",
      driveId,
    });

    // The crux of H5: both devices must tail the SAME topic, derived from the drive id, NOT
    // their own node id. On the OLD code each would key `ce-drive/ops/<self>` and never meet.
    expect(a.driveTopicId()).toBe(driveId);
    expect(b.driveTopicId()).toBe(driveId);
    expect(a.driveTopicId()).toBe(b.driveTopicId());

    // A creates a folder + file; B (a different device) makes its own edits. Each op is
    // published on the shared bus and ingested by the other core in real time.
    const docs = await a.mkdir(ROOT, "Documents");
    await a.upload(docs.id, "report.md", new Uint8Array([1, 2, 3]));
    await b.mkdir(ROOT, "Pictures");

    const fa = await fingerprint(a);
    const fb = await fingerprint(b);

    // Both devices see the union of edits and fold to identical state.
    expect(fa).toBe(fb);
    expect(fa).toContain("/Documents");
    expect(fa).toContain("/Documents/report.md");
    expect(fa).toContain("/Pictures");

    // Exactly one topic was used on the wire — the shared drive topic, not two device topics.
    expect([...bus.publishedTopics]).toEqual([`ce-drive/ops/${driveId}`]);

    a.dispose();
    b.dispose();
  });

  it("REGRESSION: device id keys CRDT authorship only, never the topic", async () => {
    // The exact hole H5 closed: the topic must be a pure function of the drive id and must NOT
    // contain the device node id. Two cores on the same drive but distinct selves agree on it.
    const bus = new TestBus();
    const driveId = "owner-xyz";
    const a = await WasmDriveCore.create({
      objects: memObjects(),
      transport: bus.transport(),
      self: "AAAA",
      driveId,
    });
    const b = await WasmDriveCore.create({
      objects: memObjects(),
      transport: bus.transport(),
      self: "BBBB",
      driveId,
    });
    // On the OLD behavior, a.driveTopicId() would have been `ce-drive/ops/AAAA` and
    // b's `ce-drive/ops/BBBB` — different, so this equality (and convergence) would FAIL.
    expect(a.driveTopicId()).toBe(b.driveTopicId());
    expect(a.driveTopicId()).not.toContain("AAAA");
    expect(a.driveTopicId()).not.toContain("BBBB");
    a.dispose();
    b.dispose();
  });

  it("driveId defaults to the capability issuer (chain.selfId), shared across devices", async () => {
    const bus = new TestBus();
    // Two devices of the same owner: same chain issuer, different self ids, no explicit driveId.
    const chain = {
      revoke: async () => "tx",
      revoked: async () => [],
      selfId: "owner-issuer-key",
    };
    const a = await WasmDriveCore.create({
      objects: memObjects(),
      transport: bus.transport(),
      chain,
      self: "dev-1",
    });
    const b = await WasmDriveCore.create({
      objects: memObjects(),
      transport: bus.transport(),
      chain,
      self: "dev-2",
    });
    expect(a.driveTopicId()).toBe("owner-issuer-key");
    expect(b.driveTopicId()).toBe("owner-issuer-key");

    await a.mkdir(ROOT, "Shared");
    expect(await fingerprint(b)).toContain("/Shared");

    a.dispose();
    b.dispose();
  });

  it("seenOps stays bounded under a flood of distinct ops (memory follow-up)", async () => {
    const bus = new TestBus();
    const driveId = "flood-drive";
    const core = await WasmDriveCore.create({
      objects: memObjects(),
      transport: bus.transport(),
      self: "flooder",
      driveId,
    });

    // Mint comfortably more distinct ops than the dedup cap (each mkdir => >=1 move op).
    for (let i = 0; i < 4600; i++) {
      await core.mkdir(ROOT, `d-${i}`);
    }

    // The dedup set must be bounded (SEEN_OPS_CAP = 4096), not grow with op count.
    expect(core.seenOpsSize()).toBeGreaterThan(0);
    expect(core.seenOpsSize()).toBeLessThanOrEqual(4096);
    // The replayable op log is also snapshot-truncated, not unbounded.
    expect(core.opLogSize()).toBeLessThanOrEqual(8192);

    core.dispose();
  });
});
