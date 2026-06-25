import { describe, it, expect } from "vitest";
import { Amount } from "@ce-net/sdk";
import {
  formatCredits,
  formatCreditsUnit,
  groupThousands,
  formatBytes,
  formatMemMb,
  shortHash,
  timeAgo,
  relativePast,
  formatDuration,
  hueFromId,
} from "./format.js";

describe("formatCredits", () => {
  it("groups thousands and trims fraction", () => {
    expect(formatCredits(Amount.fromWholeCredits(1234567n))).toBe("1,234,567");
  });

  it("keeps up to maxFrac significant fractional digits", () => {
    expect(formatCredits(Amount.fromCredits("1.5"))).toBe("1.5");
    expect(formatCredits(Amount.fromCredits("0.123456"), 4)).toBe("0.1234");
  });

  it("renders a bare integer without a trailing dot", () => {
    expect(formatCredits(Amount.fromWholeCredits(1000n))).toBe("1,000");
  });

  it("handles zero", () => {
    expect(formatCredits(Amount.ZERO)).toBe("0");
  });

  it("preserves the sign on negative balances (pre-sync)", () => {
    expect(formatCredits(Amount.fromBaseUnits("-1500000000000000000"))).toBe("-1.5");
  });

  it("never uses floating point — huge supply stays exact", () => {
    const supply = Amount.fromWholeCredits(21_000_000_000n);
    expect(formatCredits(supply, 0)).toBe("21,000,000,000");
  });

  it("appends the unit label", () => {
    expect(formatCreditsUnit(Amount.fromWholeCredits(5n))).toBe("5 cr");
  });
});

describe("groupThousands", () => {
  it("leaves short numbers alone", () => {
    expect(groupThousands("42")).toBe("42");
    expect(groupThousands("999")).toBe("999");
  });
  it("groups longer numbers", () => {
    expect(groupThousands("1000")).toBe("1,000");
    expect(groupThousands("1000000")).toBe("1,000,000");
  });
});

describe("formatBytes", () => {
  it("formats bytes, KiB, MiB, GiB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KiB");
    expect(formatBytes(1572864)).toBe("1.5 MiB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GiB");
  });
  it("guards bad input", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
  it("formats memory reported in MiB", () => {
    expect(formatMemMb(4096)).toBe("4 GiB");
    expect(formatMemMb(512)).toBe("512 MiB");
  });
});

describe("shortHash", () => {
  it("elides the middle", () => {
    const h = "abcdef0123456789abcdef0123456789";
    expect(shortHash(h, 6, 6)).toBe("abcdef…456789");
  });
  it("returns short strings unchanged", () => {
    expect(shortHash("abcd")).toBe("abcd");
  });
  it("is robust to non-strings", () => {
    expect(shortHash(undefined as unknown as string)).toBe("");
  });
});

describe("timeAgo / relativePast", () => {
  it("formats recent times", () => {
    const now = 1_000_000_000_000;
    expect(timeAgo(now / 1000 - 12, now)).toBe("12s ago");
    expect(timeAgo(now / 1000 - 120, now)).toBe("2m ago");
    expect(timeAgo(now / 1000 - 7200, now)).toBe("2h ago");
  });
  it("clamps future and sub-second to 'just now'", () => {
    expect(relativePast(-5)).toBe("just now");
    expect(relativePast(200)).toBe("just now");
  });
  it("formats days", () => {
    expect(relativePast(3 * 86400 * 1000)).toBe("3d ago");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes, hours", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(3660)).toBe("1h 1m");
  });
  it("guards bad input", () => {
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("hueFromId", () => {
  it("is deterministic and in range", () => {
    const a = hueFromId("node-a");
    expect(a).toBe(hueFromId("node-a"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
  });
  it("differs across ids (usually)", () => {
    expect(hueFromId("alpha")).not.toBe(hueFromId("beta"));
  });
});
