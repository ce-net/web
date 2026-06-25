import { describe, it, expect } from "vitest";
import { MessageStore, msgKey, type StoredMessage, type MessageStatus } from "../src/core/store.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

function msg(p: Partial<StoredMessage> & { id: string }): StoredMessage {
  return {
    from: A,
    text: "hi",
    ts: 1000,
    receivedAt: 1000,
    isSelf: false,
    status: "sent" as MessageStatus,
    ...p,
  };
}

describe("MessageStore dedupe", () => {
  it("adds new messages and dedupes by (from,id)", () => {
    const s = new MessageStore();
    expect(s.add(msg({ id: "1" }))).toBe("added");
    expect(s.add(msg({ id: "1" }))).toBe("duplicate");
    expect(s.size).toBe(1);
  });

  it("keeps messages distinct when two authors reuse the same id (anti-spoof)", () => {
    const s = new MessageStore();
    expect(s.add(msg({ id: "same", from: A, text: "from A" }))).toBe("added");
    // A hostile peer B publishes the same id — must NOT be deduped away.
    expect(s.add(msg({ id: "same", from: B, text: "from B" }))).toBe("added");
    expect(s.size).toBe(2);
    const texts = s.list().map((m) => m.text).sort();
    expect(texts).toEqual(["from A", "from B"]);
  });

  it("a remote frame cannot confirm our own pending message via a colliding id", () => {
    const self = A;
    const s = new MessageStore();
    s.add(msg({ id: "m", from: self, isSelf: true, status: "pending", receivedAt: 1 }));
    // Hostile peer B publishes id "m": different key, so it is a separate message,
    // and our pending message is NOT confirmed by it.
    const res = s.add(msg({ id: "m", from: B, isSelf: false, status: "sent", receivedAt: 5 }));
    expect(res).toBe("added");
    expect(s.get(self, "m")!.status).toBe("pending");
    expect(s.size).toBe(2);
  });

  it("confirms an optimistic pending message when its own echo arrives", () => {
    const self = A;
    const s = new MessageStore();
    s.add(msg({ id: "m", from: self, isSelf: true, status: "pending", receivedAt: 1 }));
    const res = s.add(msg({ id: "m", from: self, isSelf: true, status: "sent", receivedAt: 99 }));
    expect(res).toBe("confirmed");
    const out = s.list();
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("sent");
    expect(out[0]!.receivedAt).toBe(99);
  });

  it("orders by author ts then receivedAt then key", () => {
    const s = new MessageStore();
    s.add(msg({ id: "b", ts: 200, receivedAt: 5 }));
    s.add(msg({ id: "a", ts: 100, receivedAt: 6 }));
    s.add(msg({ id: "c", ts: 200, receivedAt: 4 }));
    expect(s.list().map((m) => m.id)).toEqual(["a", "c", "b"]);
  });

  it("evicts oldest beyond the cap (ring buffer)", () => {
    const s = new MessageStore(3);
    for (let i = 0; i < 5; i++) s.add(msg({ id: String(i), ts: i, receivedAt: i }));
    expect(s.size).toBe(3);
    expect(s.list().map((m) => m.id)).toEqual(["2", "3", "4"]);
  });

  it("clears", () => {
    const s = new MessageStore();
    s.add(msg({ id: "1" }));
    s.clear();
    expect(s.size).toBe(0);
    expect(s.list()).toEqual([]);
  });

  it("msgKey is author-namespaced and case-insensitive", () => {
    expect(msgKey("AB", "x")).toBe(msgKey("ab", "x"));
    expect(msgKey(A, "x")).not.toBe(msgKey(B, "x"));
  });
});

describe("MessageStore status transitions", () => {
  it("marks a self message failed then back to pending", () => {
    const s = new MessageStore();
    s.add(msg({ id: "m", from: A, isSelf: true, status: "pending" }));
    expect(s.markFailed(A, "m")).toBe(true);
    expect(s.get(A, "m")!.status).toBe("failed");
    expect(s.markPending(A, "m")).toBe(true);
    expect(s.get(A, "m")!.status).toBe("pending");
  });

  it("refuses to mark a non-self message failed", () => {
    const s = new MessageStore();
    s.add(msg({ id: "m", from: B, isSelf: false }));
    expect(s.markFailed(B, "m")).toBe(false);
  });
});

describe("MessageStore edits and deletes", () => {
  it("applies an author-scoped edit and stamps editedAt", () => {
    const s = new MessageStore();
    s.add(msg({ id: "m", from: A, text: "old", ts: 10 }));
    expect(s.applyEdit(A, "m", "new", 20)).toBe(true);
    expect(s.get(A, "m")!.text).toBe("new");
    expect(s.get(A, "m")!.editedAt).toBe(20);
  });

  it("ignores an edit from a different author (spoof) and stale edits", () => {
    const s = new MessageStore();
    s.add(msg({ id: "m", from: A, text: "orig" }));
    // B cannot edit A's message: the (from,id) key does not exist for B.
    expect(s.applyEdit(B, "m", "hax", 99)).toBe(false);
    expect(s.get(A, "m")!.text).toBe("orig");
    // Stale edit (older editedAt) is ignored.
    s.applyEdit(A, "m", "v2", 50);
    expect(s.applyEdit(A, "m", "v1", 40)).toBe(false);
    expect(s.get(A, "m")!.text).toBe("v2");
  });

  it("tombstones a delete and clears text + reactions", () => {
    const s = new MessageStore();
    s.add(msg({ id: "m", from: A, text: "bye" }));
    s.applyReaction(A, "m", B, "👍", "add");
    expect(s.applyDelete(A, "m")).toBe(true);
    const m = s.get(A, "m")!;
    expect(m.deleted).toBe(true);
    expect(m.text).toBe("");
    expect(m.reactions).toBeUndefined();
    // Second delete is a no-op.
    expect(s.applyDelete(A, "m")).toBe(false);
  });
});

describe("MessageStore reactions", () => {
  it("aggregates reactions and dedupes a reactor's repeat add", () => {
    const s = new MessageStore();
    s.add(msg({ id: "m", from: A }));
    s.applyReaction(A, "m", B, "👍", "add");
    s.applyReaction(A, "m", B, "👍", "add"); // idempotent
    s.applyReaction(A, "m", A, "👍", "add");
    const r = s.get(A, "m")!.reactions!;
    expect(r).toHaveLength(1);
    expect(r[0]!.emoji).toBe("👍");
    expect(r[0]!.reactors.sort()).toEqual([A, B].sort());
  });

  it("removes a reactor and drops the group when empty", () => {
    const s = new MessageStore();
    s.add(msg({ id: "m", from: A }));
    s.applyReaction(A, "m", B, "🎉", "add");
    s.applyReaction(A, "m", B, "🎉", "remove");
    expect(s.get(A, "m")!.reactions ?? []).toEqual([]);
  });

  it("buffers a reaction that arrives before its target message", () => {
    const s = new MessageStore();
    // React first (out-of-order delivery).
    s.applyReaction(A, "late", B, "🚀", "add");
    expect(s.size).toBe(0);
    // Then the message arrives — the buffered reaction is applied.
    s.add(msg({ id: "late", from: A }));
    expect(s.get(A, "late")!.reactions![0]!.emoji).toBe("🚀");
  });
});

describe("MessageStore threading", () => {
  it("separates roots from replies and counts replies", () => {
    const s = new MessageStore();
    s.add(msg({ id: "root", from: A, ts: 1 }));
    s.add(msg({ id: "r1", from: B, ts: 2, replyTo: "root" }));
    s.add(msg({ id: "r2", from: A, ts: 3, replyTo: "root" }));
    expect(s.roots().map((m) => m.id)).toEqual(["root"]);
    expect(s.replies("root").map((m) => m.id)).toEqual(["r1", "r2"]);
    expect(s.replyCount("root")).toBe(2);
  });
});
