import { describe, it, expect } from "vitest";
import {
  CeConnectionError,
  CeStreamError,
  CeAuthError,
  CeNotFoundError,
  CeApiError,
  CeServerError,
} from "@ce-net/sdk";
import { describeError, isTransient } from "./errors.js";

describe("describeError", () => {
  it("points the reader at `ce start` on a connection failure", () => {
    const msg = describeError(new CeConnectionError("ECONNREFUSED"));
    expect(msg).toMatch(/ce start/);
  });

  it("explains a dropped stream without apologizing", () => {
    const msg = describeError(new CeStreamError("eof"));
    expect(msg).toMatch(/Reconnecting/);
    expect(msg).not.toMatch(/sorry/i);
  });

  it("flags auth and not-found distinctly", () => {
    expect(describeError(new CeAuthError("no", 401, "token"))).toMatch(/token/i);
    expect(describeError(new CeNotFoundError("no", 404, "x"))).toMatch(/Not found/);
  });

  it("surfaces the status and body for a generic API error", () => {
    const msg = describeError(new CeApiError("boom", 500, "internal"));
    expect(msg).toMatch(/500/);
    expect(msg).toMatch(/internal/);
  });

  it("falls back gracefully for plain and unknown errors", () => {
    expect(describeError(new Error("raw"))).toBe("raw");
    expect(describeError("a string")).toMatch(/Something went wrong/);
  });
});

describe("isTransient", () => {
  it("is true for connection and stream errors", () => {
    expect(isTransient(new CeConnectionError("x"))).toBe(true);
    expect(isTransient(new CeStreamError("x"))).toBe(true);
  });
  it("is false for server errors", () => {
    expect(isTransient(new CeServerError("x", 500, "y"))).toBe(false);
  });
});
