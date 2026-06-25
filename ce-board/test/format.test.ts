/** Display formatting, including money formatting via the SDK's Amount type. */

import { describe, it, expect } from "vitest";
import { Amount } from "@ce-net/sdk";
import { shortId, hueFor, initials, relativeTime, formatBytes, utf8Len, formatCredits } from "../src/core/format.ts";

describe("shortId", () => {
  it("elides a 64-hex id", () => {
    const id = "a".repeat(60) + "bcde";
    expect(shortId(id)).toBe("aaaa…bcde");
  });
  it("leaves short ids intact", () => {
    expect(shortId("abc")).toBe("abc");
  });
});

describe("hueFor / initials", () => {
  it("hue is deterministic and in range", () => {
    const h = hueFor("node-1");
    expect(h).toBe(hueFor("node-1"));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
  it("initials handles names, ids, and empties", () => {
    expect(initials("Leif Rydenfalk")).toBe("LR");
    expect(initials("harbor")).toBe("HA");
    expect(initials("")).toBe("??");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  it("buckets recent times", () => {
    expect(relativeTime(now, now)).toBe("now");
    expect(relativeTime(now - 30_000, now)).toBe("30s");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
  });
  it("guards invalid input", () => {
    expect(relativeTime(0, now)).toBe("");
    expect(relativeTime(NaN, now)).toBe("");
  });
});

describe("formatBytes / utf8Len", () => {
  it("scales by 1024", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
    expect(formatBytes(-1)).toBe("0 B");
  });
  it("counts utf-8 bytes, not code units", () => {
    expect(utf8Len("ab")).toBe(2);
    expect(utf8Len("é")).toBe(2);
    expect(utf8Len("🌊")).toBe(4);
  });
});

describe("formatCredits", () => {
  it("renders whole credits", () => {
    expect(formatCredits(Amount.fromCredits("1000"))).toBe("1000");
  });
  it("trims to maxDp decimals", () => {
    expect(formatCredits(Amount.fromCredits("1.5"))).toBe("1.5");
    expect(formatCredits(Amount.fromCredits("1.23456789"), 4)).toBe("1.2345");
  });
  it("never uses floats — exact base-unit math through Amount", () => {
    const a = Amount.fromCredits("0.000000000000000001"); // 1 base unit
    // With maxDp=4 the sub-femto value trims to "0".
    expect(formatCredits(a)).toBe("0");
    expect(a.toBaseUnits()).toBe("1");
  });
  it("zero renders cleanly", () => {
    expect(formatCredits(Amount.ZERO)).toBe("0");
  });
});
