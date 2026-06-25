import { describe, it, expect } from "vitest";
import {
  makeChatMsg,
  makePresence,
  makeTyping,
  makeReact,
  makeEdit,
  makeDelete,
  makeHistoryRequest,
  makeHistoryResponse,
  parseEnvelope,
  encodeEnvelope,
  MAX_TEXT_LEN,
  MAX_NAME_LEN,
  MAX_EMOJI_LEN,
  MAX_ID_LEN,
  MAX_HISTORY_BATCH,
  PROTOCOL_VERSION,
  type HistoryItem,
} from "../src/core/protocol.ts";

describe("protocol envelopes", () => {
  it("round-trips a chat message", () => {
    const e = makeChatMsg("id-1", "hello mesh", "Leif", 1700000000000);
    const back = parseEnvelope(encodeEnvelope(e));
    expect(back).toEqual(e);
    expect(back?.t).toBe("msg");
  });

  it("round-trips a presence heartbeat", () => {
    const e = makePresence("Leif", 1700000000000);
    const back = parseEnvelope(encodeEnvelope(e));
    expect(back).toEqual(e);
  });

  it("omits name when not provided", () => {
    const e = makeChatMsg("x", "hi", undefined, 1);
    expect("name" in e).toBe(false);
    const back = parseEnvelope(encodeEnvelope(e)) as { name?: string };
    expect(back.name).toBeUndefined();
  });

  it("stamps the protocol version", () => {
    expect(makeChatMsg("x", "y", undefined, 0).v).toBe(PROTOCOL_VERSION);
  });

  it("rejects non-JSON without throwing", () => {
    expect(parseEnvelope("not json{")).toBeNull();
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("null")).toBeNull();
    expect(parseEnvelope("42")).toBeNull();
  });

  it("rejects foreign envelopes (other mesh apps on a shared topic)", () => {
    expect(parseEnvelope(JSON.stringify({ t: "ce-pin", cid: "abc" }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ hello: "world" }))).toBeNull();
  });

  it("rejects a msg with no id or non-string text", () => {
    expect(parseEnvelope(JSON.stringify({ t: "msg", text: "hi" }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ t: "msg", id: "", text: "hi" }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ t: "msg", id: "a", text: 5 }))).toBeNull();
  });

  it("truncates oversize text to MAX_TEXT_LEN on parse", () => {
    const big = "z".repeat(MAX_TEXT_LEN + 500);
    const parsed = parseEnvelope(JSON.stringify({ t: "msg", id: "a", text: big, ts: 1 }));
    expect(parsed?.t).toBe("msg");
    expect((parsed as { text: string }).text.length).toBe(MAX_TEXT_LEN);
  });

  it("coerces a missing/garbage ts to 0", () => {
    const p = parseEnvelope(JSON.stringify({ t: "msg", id: "a", text: "hi" }));
    expect((p as { ts: number }).ts).toBe(0);
    const p2 = parseEnvelope(JSON.stringify({ t: "msg", id: "a", text: "hi", ts: "nope" }));
    expect((p2 as { ts: number }).ts).toBe(0);
  });

  it("carries a replyTo for thread replies and drops a bad one", () => {
    const e = makeChatMsg("id", "reply", undefined, 1, "root-id");
    expect((parseEnvelope(encodeEnvelope(e)) as { replyTo?: string }).replyTo).toBe("root-id");
    const bad = parseEnvelope(JSON.stringify({ t: "msg", id: "a", text: "x", replyTo: 5, ts: 1 }));
    expect((bad as { replyTo?: string }).replyTo).toBeUndefined();
  });
});

describe("protocol input bounds (DoS defense)", () => {
  it("caps an oversize display name on parse", () => {
    const longName = "n".repeat(MAX_NAME_LEN + 500);
    const p = parseEnvelope(JSON.stringify({ t: "msg", id: "a", text: "hi", name: longName, ts: 1 }));
    expect((p as { name?: string }).name!.length).toBe(MAX_NAME_LEN);
  });

  it("rejects an oversize message id", () => {
    const longId = "x".repeat(MAX_ID_LEN + 1);
    expect(parseEnvelope(JSON.stringify({ t: "msg", id: longId, text: "hi", ts: 1 }))).toBeNull();
  });

  it("rejects a multi-megabyte payload before parsing", () => {
    const huge = JSON.stringify({ t: "msg", id: "a", text: "z".repeat(MAX_TEXT_LEN * (MAX_HISTORY_BATCH + 10)) });
    expect(parseEnvelope(huge)).toBeNull();
  });

  it("caps a history batch to MAX_HISTORY_BATCH", () => {
    const items: HistoryItem[] = Array.from({ length: MAX_HISTORY_BATCH + 30 }, (_, i) => ({
      id: `m${i}`,
      from: "a".repeat(64),
      text: "hi",
      ts: i,
    }));
    const env = makeHistoryResponse("n", items, 1);
    const back = parseEnvelope(encodeEnvelope(env));
    expect(back?.t).toBe("history-response");
    expect((back as { items: HistoryItem[] }).items.length).toBe(MAX_HISTORY_BATCH);
  });

  it("drops history items with a malformed author id", () => {
    const env = JSON.stringify({
      t: "history-response",
      v: 1,
      nonce: "n",
      items: [
        { id: "ok", from: "a".repeat(64), text: "good", ts: 1 },
        { id: "bad", from: "not-a-node-id", text: "drop me", ts: 2 },
      ],
      ts: 1,
    });
    const back = parseEnvelope(env) as { items: HistoryItem[] };
    expect(back.items).toHaveLength(1);
    expect(back.items[0]!.id).toBe("ok");
  });
});

describe("protocol new envelope kinds", () => {
  it("round-trips typing", () => {
    expect(parseEnvelope(encodeEnvelope(makeTyping("Leif", 5)))).toEqual(makeTyping("Leif", 5));
  });

  it("round-trips a reaction and normalizes a bad op to add", () => {
    const e = makeReact("target", "👍", "remove", "Leif", 9);
    expect(parseEnvelope(encodeEnvelope(e))).toEqual(e);
    const coerced = parseEnvelope(JSON.stringify({ t: "react", targetId: "x", emoji: "🎉", op: "weird", ts: 1 }));
    expect((coerced as { op: string }).op).toBe("add");
  });

  it("caps an oversize emoji and rejects an empty one", () => {
    const big = parseEnvelope(JSON.stringify({ t: "react", targetId: "x", emoji: "e".repeat(MAX_EMOJI_LEN + 5), op: "add", ts: 1 }));
    expect((big as { emoji: string }).emoji.length).toBe(MAX_EMOJI_LEN);
    expect(parseEnvelope(JSON.stringify({ t: "react", targetId: "x", emoji: "", op: "add", ts: 1 }))).toBeNull();
  });

  it("round-trips edit and delete", () => {
    expect(parseEnvelope(encodeEnvelope(makeEdit("t", "new", "Leif", 3)))).toEqual(makeEdit("t", "new", "Leif", 3));
    expect(parseEnvelope(encodeEnvelope(makeDelete("t", "Leif", 4)))).toEqual(makeDelete("t", "Leif", 4));
  });

  it("rejects react/edit/delete without a targetId", () => {
    expect(parseEnvelope(JSON.stringify({ t: "react", emoji: "x", op: "add", ts: 1 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ t: "edit", text: "x", ts: 1 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ t: "delete", ts: 1 }))).toBeNull();
  });

  it("clamps a history-request limit into range", () => {
    const lo = makeHistoryRequest(0, 0, "n", 1);
    expect(lo.limit).toBe(1);
    const hi = makeHistoryRequest(9999, 0, "n", 1);
    expect(hi.limit).toBe(MAX_HISTORY_BATCH);
    expect(parseEnvelope(encodeEnvelope(hi))).toEqual(hi);
  });

  it("rejects a history-request/response without a nonce", () => {
    expect(parseEnvelope(JSON.stringify({ t: "history-request", limit: 5, ts: 1 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ t: "history-response", items: [], ts: 1 }))).toBeNull();
  });

  it("preserves the protocol version on every kind", () => {
    expect(makeTyping(undefined, 0).v).toBe(PROTOCOL_VERSION);
    expect(makeReact("x", "👍", "add", undefined, 0).v).toBe(PROTOCOL_VERSION);
  });
});
