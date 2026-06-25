import { describe, it, expect } from "vitest";
import { PresenceTracker, PRESENCE_TTL_MS } from "../src/core/presence.ts";

const SELF = "a".repeat(64);
const PEER = "b".repeat(64);
const PEER2 = "c".repeat(64);

describe("PresenceTracker", () => {
  it("tracks self as a member from the start when seen", () => {
    const p = new PresenceTracker(SELF);
    p.seen(SELF, "me", 1000);
    expect(p.onlineCount(1000)).toBe(1);
    expect(p.list(1000)[0]!.isSelf).toBe(true);
  });

  it("marks members online within the TTL and offline past it", () => {
    const p = new PresenceTracker(SELF);
    p.seen(PEER, "peer", 0);
    expect(p.onlineCount(PRESENCE_TTL_MS)).toBe(1);
    expect(p.onlineCount(PRESENCE_TTL_MS + 1)).toBe(0);
  });

  it("keeps the latest lastSeen and updates the name", () => {
    const p = new PresenceTracker(SELF);
    p.seen(PEER, undefined, 100);
    p.seen(PEER, "Renamed", 500);
    const m = p.list(500).find((x) => x.nodeId === PEER)!;
    expect(m.name).toBe("Renamed");
    expect(m.lastSeen).toBe(500);
    // An out-of-order older signal must not move lastSeen backwards.
    p.seen(PEER, undefined, 200);
    expect(p.list(500).find((x) => x.nodeId === PEER)!.lastSeen).toBe(500);
  });

  it("sorts self first, then online, then by name", () => {
    const p = new PresenceTracker(SELF);
    p.seen(SELF, "me", 1000);
    p.seen(PEER, "Zed", 1000);
    p.seen(PEER2, "Amy", 0); // offline at now=1000+TTL+1
    const now = PRESENCE_TTL_MS + 1;
    p.seen(SELF, "me", now);
    p.seen(PEER, "Zed", now);
    const ids = p.list(now).map((m) => m.nodeId);
    expect(ids[0]).toBe(SELF); // self pinned
    expect(ids[1]).toBe(PEER); // online next
    expect(ids[2]).toBe(PEER2); // offline last
  });

  it("prunes stale non-self members but keeps self", () => {
    const p = new PresenceTracker(SELF);
    p.seen(SELF, "me", 0);
    p.seen(PEER, "peer", 0);
    const removed = p.prune(100_000, 60_000);
    expect(removed).toBe(1);
    expect(p.list(100_000).map((m) => m.nodeId)).toEqual([SELF]);
  });

  it("is case-insensitive on node id", () => {
    const p = new PresenceTracker(SELF);
    p.seen(PEER.toUpperCase(), "peer", 0);
    p.seen(PEER, "peer", 10);
    expect(p.list(10).filter((m) => !m.isSelf)).toHaveLength(1);
  });
});
