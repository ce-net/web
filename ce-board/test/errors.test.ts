/** Error mapping: SDK error classes and bare status codes → friendly UI guidance. */

import { describe, it, expect } from "vitest";
import { toFriendly, isOffline } from "../src/core/errors.ts";

function ceErr(name: string, status?: number, extra: Record<string, unknown> = {}): Error {
  const e = new Error(name) as Error & Record<string, unknown>;
  e.name = name;
  if (status !== undefined) e.status = status;
  Object.assign(e, extra);
  return e;
}

describe("toFriendly", () => {
  it("maps auth errors", () => {
    const f = toFriendly(ceErr("CeAuthError", 403));
    expect(f.kind).toBe("auth");
    expect(f.hint).toMatch(/CE_API_TOKEN/);
  });

  it("maps insufficient funds (402)", () => {
    expect(toFriendly(ceErr("CeInsufficientFundsError", 402)).kind).toBe("funds");
    expect(toFriendly(ceErr("Whatever", 402)).kind).toBe("funds");
  });

  it("maps not-found, rate-limit (with retryAfter), and peer", () => {
    expect(toFriendly(ceErr("CeNotFoundError", 404)).kind).toBe("notfound");
    const rl = toFriendly(ceErr("CeRateLimitError", 429, { retryAfter: 7 }));
    expect(rl.kind).toBe("ratelimit");
    expect(rl.hint).toContain("7s");
    expect(toFriendly(ceErr("CePeerError", 502)).kind).toBe("peer");
  });

  it("maps connection + stream + timeout errors to offline-ish", () => {
    expect(toFriendly(ceErr("CeConnectionError")).kind).toBe("offline");
    expect(toFriendly(ceErr("CeStreamError")).kind).toBe("offline");
    expect(toFriendly(ceErr("CeTimeoutError", 504)).kind).toBe("offline");
  });

  it("maps 5xx to server", () => {
    expect(toFriendly(ceErr("CeServerError", 500)).kind).toBe("server");
    expect(toFriendly(ceErr("Boom", 503)).kind).toBe("server");
  });

  it("falls back to the raw message for unknown errors", () => {
    expect(toFriendly(new Error("weird")).message).toBe("weird");
    expect(toFriendly("string error").message).toBe("string error");
    expect(toFriendly({}).kind).toBe("unknown");
  });
});

describe("isOffline", () => {
  it("is true only for node-unreachable errors", () => {
    expect(isOffline(ceErr("CeConnectionError"))).toBe(true);
    expect(isOffline(ceErr("CeAuthError", 403))).toBe(false);
  });
});
