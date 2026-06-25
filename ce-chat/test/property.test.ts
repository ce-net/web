import { describe, it, expect } from "vitest";
import { MessageStore, type StoredMessage } from "../src/core/store.ts";
import { normalizeChannelName } from "../src/core/topics.ts";

/** Tiny seeded PRNG (mulberry32) so property runs are deterministic and reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function authors(): string[] {
  return ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
}

function makeMsg(from: string, id: string, ts: number, receivedAt: number): StoredMessage {
  return { id, from, text: `t-${id}`, ts, receivedAt, isSelf: false, status: "sent" };
}

describe("MessageStore ordering invariants (property)", () => {
  it("list() is always sorted by (ts, receivedAt, key) for any insertion order", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = rng(seed);
      const s = new MessageStore(1000);
      const auth = authors();
      const n = 5 + Math.floor(rnd() * 60);
      for (let i = 0; i < n; i++) {
        const from = auth[Math.floor(rnd() * auth.length)]!;
        const id = `m${Math.floor(rnd() * 200)}`;
        const ts = Math.floor(rnd() * 1000);
        const recv = Math.floor(rnd() * 1000);
        s.add(makeMsg(from, id, ts, recv));
      }
      const list = s.list();
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1]!;
        const b = list[i]!;
        const aKey = `${a.from.toLowerCase()} ${a.id}`;
        const bKey = `${b.from.toLowerCase()} ${b.id}`;
        const ordered =
          a.ts < b.ts ||
          (a.ts === b.ts && a.receivedAt < b.receivedAt) ||
          (a.ts === b.ts && a.receivedAt === b.receivedAt && aKey <= bKey);
        expect(ordered).toBe(true);
      }
    }
  });

  it("eviction keeps size <= cap and never drops a strictly-more-recent insert before an older one", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rnd = rng(seed);
      const cap = 3 + Math.floor(rnd() * 8);
      const s = new MessageStore(cap);
      const total = cap + 5 + Math.floor(rnd() * 40);
      for (let i = 0; i < total; i++) s.add(makeMsg("a".repeat(64), `m${i}`, i, i));
      expect(s.size).toBeLessThanOrEqual(cap);
      // The retained set must be the most-recent `cap` insertions (ring buffer).
      const ids = s.list().map((m) => m.id);
      const expected = Array.from({ length: cap }, (_, k) => `m${total - cap + k}`);
      expect(ids).toEqual(expected);
    }
  });

  it("dedupe by (from,id) means inserting the same key twice never grows size", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rnd = rng(seed);
      const s = new MessageStore(1000);
      const from = "a".repeat(64);
      const reps = 2 + Math.floor(rnd() * 5);
      for (let r = 0; r < reps; r++) s.add(makeMsg(from, "fixed", r, r));
      expect(s.size).toBe(1);
    }
  });
});

describe("normalizeChannelName idempotence (property)", () => {
  const alphabet = "AB cd-_!😀012  --__";
  it("normalize(normalize(x)) === normalize(x) for random inputs", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rnd = rng(seed);
      const len = Math.floor(rnd() * 30);
      let str = "";
      for (let i = 0; i < len; i++) str += alphabet[Math.floor(rnd() * alphabet.length)];
      const once = normalizeChannelName(str);
      const twice = normalizeChannelName(once);
      expect(twice).toBe(once);
    }
  });

  it("output is always a valid slug or empty", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rnd = rng(seed);
      const len = Math.floor(rnd() * 80);
      let str = "";
      for (let i = 0; i < len; i++) str += alphabet[Math.floor(rnd() * alphabet.length)];
      const out = normalizeChannelName(str);
      expect(out.length).toBeLessThanOrEqual(64);
      if (out.length > 0) {
        expect(/^[a-z0-9][a-z0-9_-]*$/.test(out)).toBe(true);
        expect(/[-_]$/.test(out)).toBe(false);
      }
    }
  });
});
