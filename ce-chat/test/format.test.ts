import { describe, it, expect } from "vitest";
import { shortId, initials, hueFor, relativeTime, clockTime, formatBytes, utf8Len } from "../src/core/format.ts";

describe("shortId", () => {
  it("abbreviates long ids", () => {
    expect(shortId("a".repeat(64))).toBe("aaaa…aaaa");
    expect(shortId("a".repeat(64), 6, 6)).toBe("aaaaaa…aaaaaa");
  });
  it("leaves short ids untouched", () => {
    expect(shortId("abc")).toBe("abc");
  });
});

describe("initials", () => {
  it("uses first letters of two words", () => {
    expect(initials("Leif Rydenfalk")).toBe("LR");
  });
  it("uses first two chars of a single token", () => {
    expect(initials("general")).toBe("GE");
    expect(initials("a1b2c3")).toBe("A1");
  });
  it("handles empty input", () => {
    expect(initials("")).toBe("??");
  });
});

describe("hueFor", () => {
  it("is deterministic and in range", () => {
    const h = hueFor("a".repeat(64));
    expect(h).toBe(hueFor("a".repeat(64)));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
  it("differs across distinct ids (usually)", () => {
    expect(hueFor("a".repeat(64))).not.toBe(hueFor("b".repeat(64)));
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  it("renders seconds/minutes/hours/days buckets", () => {
    expect(relativeTime(now, now)).toBe("now");
    expect(relativeTime(now - 30_000, now)).toBe("30s");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
  });
  it("treats future and zero as edge cases", () => {
    expect(relativeTime(now + 5000, now)).toBe("now");
    expect(relativeTime(0, now)).toBe("");
  });
});

describe("clockTime", () => {
  it("returns empty for invalid", () => {
    expect(clockTime(0)).toBe("");
  });
  it("returns a non-empty time for a real ts", () => {
    expect(clockTime(1_700_000_000_000).length).toBeGreaterThan(0);
  });
});

describe("formatBytes", () => {
  it("formats across units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(4096)).toBe("4.0 KB");
    expect(formatBytes(1_500_000)).toBe("1.4 MB");
    expect(formatBytes(-5)).toBe("0 B");
  });
});

describe("utf8Len", () => {
  it("counts bytes, not code units", () => {
    expect(utf8Len("abc")).toBe(3);
    expect(utf8Len("é")).toBe(2);
    expect(utf8Len("😀")).toBe(4);
  });
});
