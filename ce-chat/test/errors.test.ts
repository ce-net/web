import { describe, it, expect } from "vitest";
import { toFriendly, isOffline } from "../src/core/errors.ts";

function ceErr(name: string, status?: number, extra: Record<string, unknown> = {}): Error {
  const e = new Error(name) as Error & Record<string, unknown>;
  e.name = name;
  if (status !== undefined) e["status"] = status;
  Object.assign(e, extra);
  return e;
}

describe("toFriendly", () => {
  it("maps private-channel auth errors with a grant hint", () => {
    const f = toFriendly(ceErr("CeAuthError", 403));
    expect(f.kind).toBe("auth");
    expect(f.message).toMatch(/private/i);
    expect(f.hint).toMatch(/capability grant/i);
  });

  it("maps insufficient funds (402)", () => {
    expect(toFriendly(ceErr("CeInsufficientFundsError", 402)).kind).toBe("funds");
  });

  it("maps not found (404)", () => {
    expect(toFriendly(ceErr("CeNotFoundError", 404)).kind).toBe("notfound");
  });

  it("maps rate limit and surfaces retryAfter", () => {
    const f = toFriendly(ceErr("CeRateLimitError", 429, { retryAfter: 7 }));
    expect(f.kind).toBe("ratelimit");
    expect(f.hint).toMatch(/7s/);
  });

  it("maps connection/stream errors to offline with a `ce start` hint", () => {
    const f = toFriendly(ceErr("CeConnectionError"));
    expect(f.kind).toBe("offline");
    expect(f.hint).toMatch(/ce start/);
    expect(isOffline(ceErr("CeStreamError"))).toBe(true);
  });

  it("maps peer (502) and timeout (504)", () => {
    expect(toFriendly(ceErr("CePeerError", 502)).kind).toBe("peer");
    expect(toFriendly(ceErr("CeTimeoutError", 504)).kind).toBe("offline");
  });

  it("falls back to the message for unknown errors", () => {
    const f = toFriendly(new Error("boom"));
    expect(f.kind).toBe("unknown");
    expect(f.message).toBe("boom");
  });

  it("duck-types on status when name is absent", () => {
    expect(toFriendly({ status: 403 }).kind).toBe("auth");
    expect(toFriendly({ status: 500 }).kind).toBe("server");
  });

  it("handles string and null inputs", () => {
    expect(toFriendly("oops").message).toBe("oops");
    expect(toFriendly(null).kind).toBe("unknown");
  });
});
