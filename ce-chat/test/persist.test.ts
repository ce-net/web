import { describe, it, expect } from "vitest";
import {
  loadChannels,
  saveChannels,
  loadDrafts,
  saveDrafts,
  loadName,
  saveName,
  loadNodeUrl,
  saveNodeUrl,
  memoryStorage,
  MAX_PERSISTED_CHANNELS,
  MAX_DRAFT_LEN,
} from "../src/core/persist.ts";
import { publicChannel, privateChannel, dmChannel } from "../src/core/topics.ts";

const SELF = "a".repeat(64);
const PEER = "b".repeat(64);

describe("persist channels", () => {
  it("round-trips public, private and dm channels", () => {
    const store = memoryStorage();
    const refs = [publicChannel("general"), privateChannel("eng"), dmChannel(SELF, PEER, "peer")];
    saveChannels(store, refs);
    const back = loadChannels(store, SELF);
    expect(back.map((r) => r.id).sort()).toEqual(refs.map((r) => r.id).sort());
    const dm = back.find((r) => r.kind === "dm")!;
    expect(dm.peer).toBe(PEER);
    expect(dm.topic).toBe(dmChannel(SELF, PEER, "x").topic);
  });

  it("returns an empty list on a fresh store", () => {
    expect(loadChannels(memoryStorage(), SELF)).toEqual([]);
  });

  it("survives corrupt JSON and non-array data", () => {
    const store = memoryStorage();
    store.setItem("ce-chat:channels:v1", "{not json");
    expect(loadChannels(store, SELF)).toEqual([]);
    store.setItem("ce-chat:channels:v1", JSON.stringify({ not: "an array" }));
    expect(loadChannels(store, SELF)).toEqual([]);
  });

  it("drops invalid channel entries and a self-DM", () => {
    const store = memoryStorage();
    store.setItem(
      "ce-chat:channels:v1",
      JSON.stringify([
        { kind: "public", name: "ok" },
        { kind: "public", name: "BAD UPPER SPACE" },
        { kind: "dm", peer: SELF }, // self-DM, dropped
        { kind: "dm", peer: "not-hex" },
        { junk: true },
      ]),
    );
    const back = loadChannels(store, SELF);
    expect(back.map((r) => r.id)).toEqual(["pub:ok"]);
  });

  it("dedupes repeated entries", () => {
    const store = memoryStorage();
    store.setItem("ce-chat:channels:v1", JSON.stringify([{ kind: "public", name: "x" }, { kind: "public", name: "x" }]));
    expect(loadChannels(store, SELF)).toHaveLength(1);
  });

  it("caps the persisted channel list", () => {
    const store = memoryStorage();
    const many = Array.from({ length: MAX_PERSISTED_CHANNELS + 50 }, (_, i) => publicChannel(`c${i}`));
    saveChannels(store, many);
    expect(loadChannels(store, SELF).length).toBe(MAX_PERSISTED_CHANNELS);
  });
});

describe("persist drafts", () => {
  it("round-trips drafts and drops empties", () => {
    const store = memoryStorage();
    const drafts = new Map([
      ["pub:a", "hello"],
      ["pub:b", ""],
    ]);
    saveDrafts(store, drafts);
    const back = loadDrafts(store);
    expect(back.get("pub:a")).toBe("hello");
    expect(back.has("pub:b")).toBe(false);
  });

  it("caps draft length on load", () => {
    const store = memoryStorage();
    store.setItem("ce-chat:drafts:v1", JSON.stringify({ "pub:a": "x".repeat(MAX_DRAFT_LEN + 100) }));
    expect(loadDrafts(store).get("pub:a")!.length).toBe(MAX_DRAFT_LEN);
  });

  it("survives corrupt draft JSON", () => {
    const store = memoryStorage();
    store.setItem("ce-chat:drafts:v1", "nope{");
    expect(loadDrafts(store).size).toBe(0);
  });
});

describe("persist name", () => {
  it("round-trips and clears a name", () => {
    const store = memoryStorage();
    saveName(store, "Leif");
    expect(loadName(store)).toBe("Leif");
    saveName(store, undefined);
    expect(loadName(store)).toBeUndefined();
  });

  it("caps an oversize name", () => {
    const store = memoryStorage();
    saveName(store, "n".repeat(200));
    expect(loadName(store)!.length).toBe(64);
  });
});

describe("persist node url", () => {
  it("accepts a valid http(s) url and rejects others", () => {
    const store = memoryStorage();
    saveNodeUrl(store, "http://example.com:9000");
    expect(loadNodeUrl(store)).toBe("http://example.com:9000");
    saveNodeUrl(store, "ftp://nope");
    // Invalid scheme not saved; previous value remains.
    expect(loadNodeUrl(store)).toBe("http://example.com:9000");
  });

  it("ignores a corrupt stored url", () => {
    const store = memoryStorage();
    store.setItem("ce-chat:nodeUrl", "::::not a url");
    expect(loadNodeUrl(store)).toBeUndefined();
  });

  it("clears the override", () => {
    const store = memoryStorage();
    saveNodeUrl(store, "https://x.io");
    saveNodeUrl(store, undefined);
    expect(loadNodeUrl(store)).toBeUndefined();
  });
});

describe("persist resilience", () => {
  it("a throwing storage never crashes load/save", () => {
    const throwing = {
      getItem() {
        throw new Error("disabled");
      },
      setItem() {
        throw new Error("quota");
      },
      removeItem() {
        throw new Error("disabled");
      },
    };
    expect(() => saveChannels(throwing, [publicChannel("a")])).not.toThrow();
    expect(loadChannels(throwing, SELF)).toEqual([]);
    expect(loadName(throwing)).toBeUndefined();
  });
});
