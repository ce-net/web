import { describe, it, expect } from "vitest";
import {
  publicTopic,
  privateTopic,
  dmTopic,
  normalizeChannelName,
  isValidChannelName,
  isNodeId,
  publicChannel,
  privateChannel,
  dmChannel,
} from "../src/core/topics.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("topic mapping", () => {
  it("namespaces public and private channels", () => {
    expect(publicTopic("general")).toBe("ce-chat/channel/general");
    expect(privateTopic("eng")).toBe("ce-chat/private/eng");
  });

  it("derives an order-independent DM topic", () => {
    expect(dmTopic(A, B)).toBe(dmTopic(B, A));
    expect(dmTopic(A, B)).toBe(`ce-chat/dm/${A}+${B}`);
  });

  it("rejects malformed node ids in dmTopic", () => {
    expect(() => dmTopic("short", B)).toThrow();
    expect(() => dmTopic(A, A)).toThrow(); // cannot DM yourself
  });

  it("lowercases node ids so case can't fork a DM topic", () => {
    expect(dmTopic(A.toUpperCase(), B)).toBe(dmTopic(A, B));
  });
});

describe("channel name validation", () => {
  it("accepts valid slugs", () => {
    expect(isValidChannelName("general")).toBe(true);
    expect(isValidChannelName("eng-team_2")).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(isValidChannelName("")).toBe(false);
    expect(isValidChannelName("-leading")).toBe(false);
    expect(isValidChannelName("UPPER")).toBe(false);
    expect(isValidChannelName("has space")).toBe(false);
    expect(isValidChannelName("a".repeat(65))).toBe(false);
  });

  it("normalizes user input to a slug", () => {
    expect(normalizeChannelName("  Eng Team!  ")).toBe("eng-team");
    expect(normalizeChannelName("Hello World 😀")).toBe("hello-world");
    expect(normalizeChannelName("a".repeat(100)).length).toBe(64);
  });

  it("recognizes 64-hex node ids", () => {
    expect(isNodeId(A)).toBe(true);
    expect(isNodeId(A.toUpperCase())).toBe(true);
    expect(isNodeId("xyz")).toBe(false);
    expect(isNodeId("a".repeat(63))).toBe(false);
  });
});

describe("channel refs", () => {
  it("builds stable public/private ids", () => {
    expect(publicChannel("general").id).toBe("pub:general");
    expect(privateChannel("eng").id).toBe("prv:eng");
    expect(publicChannel("general").kind).toBe("public");
    expect(privateChannel("eng").kind).toBe("private");
  });

  it("builds a DM ref carrying the peer", () => {
    const ref = dmChannel(A, B, "bbbb…bbbb");
    expect(ref.kind).toBe("dm");
    expect(ref.peer).toBe(B);
    expect(ref.topic).toBe(dmTopic(A, B));
    expect(ref.id).toBe(`dm:${B}`);
  });
});
