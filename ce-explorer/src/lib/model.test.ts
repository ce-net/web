import { describe, it, expect } from "vitest";
import { Amount } from "@ce-net/sdk";
import {
  computeShareRatio,
  buildPeerRows,
  buildLeaderboard,
  formatRatio,
  tagFacets,
  peerMatches,
  classifyJob,
  txMovesValue,
  txKindLabel,
  totalChannelCapacity,
} from "./model.js";
import { makeAtlas, makeHistory } from "./__tests__/fixtures.js";
import type { Job, Channel } from "@ce-net/sdk";

describe("computeShareRatio", () => {
  it("is delivered / consumed", () => {
    expect(computeShareRatio(10, 5)).toBe(2);
    expect(computeShareRatio(5, 10)).toBe(0.5);
  });
  it("is Infinity for a pure seeder", () => {
    expect(computeShareRatio(7, 0)).toBe(Number.POSITIVE_INFINITY);
  });
  it("is 0 for an idle node", () => {
    expect(computeShareRatio(0, 0)).toBe(0);
  });
});

describe("buildPeerRows", () => {
  it("joins atlas capacity with history and marks online", () => {
    const atlas = [makeAtlas({ nodeId: "n1", tags: ["gpu"] })];
    const history = new Map([
      ["n1", makeHistory({ nodeId: "n1", jobsHosted: 4, jobsPaid: 2, earned: Amount.fromWholeCredits(9n) })],
    ]);
    const rows = buildPeerRows(atlas, history);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.online).toBe(true);
    expect(r.delivered).toBe(4);
    expect(r.consumed).toBe(2);
    expect(r.shareRatio).toBe(2);
    expect(r.tags).toEqual(["gpu"]);
    expect(r.earned?.eq(Amount.fromWholeCredits(9n))).toBe(true);
  });

  it("includes history-only peers as offline with null money", () => {
    const history = new Map([["ghost", makeHistory({ nodeId: "ghost", jobsHosted: 1 })]]);
    const rows = buildPeerRows([], history);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.online).toBe(false);
    expect(rows[0]!.delivered).toBe(1);
  });

  it("an online peer with no history has a null share ratio", () => {
    const rows = buildPeerRows([makeAtlas({ nodeId: "fresh" })], new Map());
    expect(rows[0]!.shareRatio).toBeNull();
    expect(rows[0]!.earned).toBeNull();
  });
});

describe("buildLeaderboard", () => {
  it("ranks seeders first, then by ratio, dropping no-history peers", () => {
    const atlas = [
      makeAtlas({ nodeId: "seeder" }),
      makeAtlas({ nodeId: "good" }),
      makeAtlas({ nodeId: "leech" }),
      makeAtlas({ nodeId: "nohist" }),
    ];
    const history = new Map([
      ["seeder", makeHistory({ nodeId: "seeder", jobsHosted: 5, jobsPaid: 0 })],
      ["good", makeHistory({ nodeId: "good", jobsHosted: 8, jobsPaid: 4 })],
      ["leech", makeHistory({ nodeId: "leech", jobsHosted: 1, jobsPaid: 10 })],
    ]);
    const board = buildLeaderboard(buildPeerRows(atlas, history));
    expect(board.map((r) => r.nodeId)).toEqual(["seeder", "good", "leech"]);
    expect(board[0]!.rank).toBe(1);
    expect(board[0]!.shareRatio).toBe(Number.POSITIVE_INFINITY);
  });

  it("breaks ratio ties by delivered work then nodeId", () => {
    const atlas = [makeAtlas({ nodeId: "zzz" }), makeAtlas({ nodeId: "aaa" })];
    const history = new Map([
      ["zzz", makeHistory({ nodeId: "zzz", jobsHosted: 2, jobsPaid: 2 })],
      ["aaa", makeHistory({ nodeId: "aaa", jobsHosted: 2, jobsPaid: 2 })],
    ]);
    const board = buildLeaderboard(buildPeerRows(atlas, history));
    // equal ratio (1.0) and equal delivered (2) -> nodeId asc
    expect(board.map((r) => r.nodeId)).toEqual(["aaa", "zzz"]);
  });
});

describe("formatRatio", () => {
  it("renders finite, infinite, and null", () => {
    expect(formatRatio(2)).toBe("2.00");
    expect(formatRatio(Number.POSITIVE_INFINITY)).toBe("∞");
    expect(formatRatio(null)).toBe("—");
  });
});

describe("tagFacets + peerMatches", () => {
  const rows = buildPeerRows(
    [
      makeAtlas({ nodeId: "n1", tags: ["gpu", "tier:hi"] }),
      makeAtlas({ nodeId: "n2", tags: ["gpu"] }),
      makeAtlas({ nodeId: "n3", tags: [] }),
    ],
    new Map(),
  );

  it("counts tags sorted by frequency", () => {
    expect(tagFacets(rows)).toEqual([
      { tag: "gpu", count: 2 },
      { tag: "tier:hi", count: 1 },
    ]);
  });

  it("matches on id substring and tag substring", () => {
    expect(peerMatches(rows[0]!, "n1")).toBe(true);
    expect(peerMatches(rows[0]!, "tier")).toBe(true);
    expect(peerMatches(rows[2]!, "gpu")).toBe(false);
    expect(peerMatches(rows[2]!, "")).toBe(true);
  });
});

describe("classifyJob", () => {
  const j = (status: string): Job => ({
    jobId: "j",
    status,
    payer: null,
    containerId: null,
    cost: null,
    bid: null,
  });
  it("maps node statuses to semantic states", () => {
    expect(classifyJob(j("running"))).toBe("running");
    expect(classifyJob(j("pending"))).toBe("pending");
    expect(classifyJob(j("awaiting_settlement"))).toBe("settling");
    expect(classifyJob(j("settled"))).toBe("settled");
    expect(classifyJob(j("failed: oom"))).toBe("failed");
  });
  it("falls back to pending for unknown states", () => {
    expect(classifyJob(j("teleporting"))).toBe("pending");
  });
});

describe("txMovesValue + txKindLabel", () => {
  it("classifies value-moving vs control kinds", () => {
    expect(txMovesValue("Transfer")).toBe(true);
    expect(txMovesValue("JobSettle")).toBe(true);
    expect(txMovesValue("NameClaim")).toBe(false);
    expect(txMovesValue("SlashEquivocation")).toBe(false);
  });
  it("splits PascalCase into words", () => {
    expect(txKindLabel("JobSettle")).toBe("Job Settle");
    expect(txKindLabel("UptimeReward")).toBe("Uptime Reward");
  });
});

describe("totalChannelCapacity", () => {
  it("sums channel capacities exactly", () => {
    const chans: Channel[] = [
      { channelId: "c1", payer: "p", host: "h", capacity: Amount.fromWholeCredits(3n), expiryHeight: 1 },
      { channelId: "c2", payer: "p", host: "h", capacity: Amount.fromWholeCredits(4n), expiryHeight: 1 },
    ];
    expect(totalChannelCapacity(chans).eq(Amount.fromWholeCredits(7n))).toBe(true);
    expect(totalChannelCapacity([]).isZero()).toBe(true);
  });
});
