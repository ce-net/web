/** Board-id slug normalization and topic mapping. */

import { describe, it, expect } from "vitest";
import { normalizeBoardId, isValidBoardId, opsTopic, snapshotKey, TOPIC_PREFIX } from "../src/core/topics.ts";

describe("normalizeBoardId", () => {
  it("lowercases, dashes spaces, strips junk", () => {
    expect(normalizeBoardId("  Q3 Roadmap! ")).toBe("q3-roadmap");
    expect(normalizeBoardId("My Board #1")).toBe("my-board-1");
    expect(normalizeBoardId("a  --  b")).toBe("a-b");
  });

  it("trims leading/trailing separators and caps length", () => {
    expect(normalizeBoardId("--hi--")).toBe("hi");
    expect(normalizeBoardId("_x_")).toBe("x");
    expect(normalizeBoardId("a".repeat(100)).length).toBe(64);
  });

  it("yields an empty string for all-junk input", () => {
    expect(normalizeBoardId("!!!")).toBe("");
    expect(normalizeBoardId("   ")).toBe("");
  });
});

describe("isValidBoardId", () => {
  it("accepts slugs, rejects empties and bad chars", () => {
    expect(isValidBoardId("harbor")).toBe(true);
    expect(isValidBoardId("q3-roadmap")).toBe(true);
    expect(isValidBoardId("")).toBe(false);
    expect(isValidBoardId("Has Space")).toBe(false);
    expect(isValidBoardId("-leading")).toBe(false);
  });
});

describe("topics + keys", () => {
  it("namespaces ops topics under the app prefix", () => {
    expect(opsTopic("harbor")).toBe(`${TOPIC_PREFIX}/ops/harbor`);
  });
  it("derives a stable snapshot storage key", () => {
    expect(snapshotKey("harbor")).toBe(`${TOPIC_PREFIX}:snapshot:harbor`);
  });
});
