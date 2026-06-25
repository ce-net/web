/** Entity id generation: unique, slug-safe, prefixed. */

import { describe, it, expect, beforeEach } from "vitest";
import { newId, _resetIdCounter } from "../src/core/ids.ts";

beforeEach(() => _resetIdCounter());

describe("newId", () => {
  it("prefixes and embeds a sanitized client", () => {
    const id = newId("card", "node-abc12345", () => 0.5);
    expect(id.startsWith("card_")).toBe(true);
    expect(id).toMatch(/^[a-z0-9_]+$/);
    expect(id).toContain("nodeabc1"); // dashes stripped, 8 chars
  });

  it("is unique across many calls (counter + salt)", () => {
    const seen = new Set<string>();
    let r = 0;
    const rand = () => ((r = (r + 0.131) % 1) , r);
    for (let i = 0; i < 5000; i++) seen.add(newId("card", "client", rand));
    expect(seen.size).toBe(5000);
  });

  it("handles a client with no alphanumerics", () => {
    expect(newId("col", "----", () => 0).startsWith("col_anon_")).toBe(true);
  });
});
