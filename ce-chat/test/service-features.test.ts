import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatService, INBOUND_MAX_PER_WINDOW, TYPING_TTL_MS } from "../src/core/service.ts";
import { publicChannel } from "../src/core/topics.ts";
import {
  makeChatMsg,
  makeReact,
  makeEdit,
  makeDelete,
  makeTyping,
  makeHistoryRequest,
  makeHistoryResponse,
  encodeEnvelope,
  type HistoryItem,
} from "../src/core/protocol.ts";
import { FakeMesh, resetBuses } from "./fake-mesh.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const EVE = "e".repeat(64);
const TOPIC = "ce-chat/channel/general";

beforeEach(() => resetBuses());

async function tick(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Inject a remote envelope onto a service's routing path. */
function deliver(svc: ChatService, from: string, env: object, receivedAt = Date.now()): void {
  svc.route({ from, topic: TOPIC, text: encodeEnvelope(env as never), receivedAt });
}

describe("reactions over the service", () => {
  it("aggregates a remote reaction onto a known message", async () => {
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeChatMsg("m1", "hi", "Bob", 1));
    deliver(svc, EVE, makeReact("m1", "👍", "add", "Eve", 2));
    const msg = svc.state("pub:general")!.store.get(BOB, "m1")!;
    expect(msg.reactions![0]!.emoji).toBe("👍");
    expect(msg.reactions![0]!.reactors).toContain(EVE.toLowerCase());
  });

  it("publishes a react envelope when we react locally", async () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeChatMsg("m1", "hi", "Bob", 1));
    await svc.react("pub:general", BOB, "m1", "🎉", "add");
    const last = mesh.published.at(-1)!;
    const env = JSON.parse(last.text);
    expect(env).toMatchObject({ t: "react", targetId: "m1", emoji: "🎉", op: "add" });
  });
});

describe("edits and deletes over the service", () => {
  it("applies a remote author-scoped edit", async () => {
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeChatMsg("m1", "typo", "Bob", 1));
    deliver(svc, BOB, makeEdit("m1", "fixed", "Bob", 5));
    const m = svc.state("pub:general")!.store.get(BOB, "m1")!;
    expect(m.text).toBe("fixed");
    expect(m.editedAt).toBe(5);
  });

  it("ignores an edit from a spoofing third party", async () => {
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeChatMsg("m1", "real", "Bob", 1));
    // Eve tries to edit Bob's message — different (from,id) key, so it never lands.
    deliver(svc, EVE, makeEdit("m1", "hax", "Eve", 9));
    expect(svc.state("pub:general")!.store.get(BOB, "m1")!.text).toBe("real");
  });

  it("tombstones on a remote delete", async () => {
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeChatMsg("m1", "delete me", "Bob", 1));
    deliver(svc, BOB, makeDelete("m1", "Bob", 2));
    expect(svc.state("pub:general")!.store.get(BOB, "m1")!.deleted).toBe(true);
  });

  it("rejects editing a message that is not ours (local guard)", async () => {
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeChatMsg("m1", "Bob's", "Bob", 1));
    await expect(svc.edit("pub:general", "m1", "nope")).rejects.toThrow(/not your message/);
  });
});

describe("typing indicators", () => {
  it("tracks a remote typer within TTL and excludes self", async () => {
    const now = 10_000;
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeTyping("Bob", now), now);
    deliver(svc, ALICE, makeTyping("Alice", now), now); // self ignored
    const typers = svc.typers("pub:general", now + 1000);
    expect(typers.map((t) => t.nodeId)).toEqual([BOB.toLowerCase()]);
  });

  it("ages a typer out past the TTL", async () => {
    const now = 10_000;
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeTyping("Bob", now), now);
    expect(svc.typers("pub:general", now + TYPING_TTL_MS + 1)).toHaveLength(0);
  });

  it("clears a typer when they actually send a message", async () => {
    const now = 10_000;
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeTyping("Bob", now), now);
    deliver(svc, BOB, makeChatMsg("m1", "done", "Bob", now), now);
    expect(svc.typers("pub:general", now + 100)).toHaveLength(0);
  });
});

describe("threads", () => {
  it("routes a reply into the same store with replyTo set", async () => {
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeChatMsg("root", "topic", "Bob", 1));
    deliver(svc, EVE, makeChatMsg("r1", "reply", "Eve", 2, "root"));
    const st = svc.state("pub:general")!;
    expect(st.store.roots().map((m) => m.id)).toEqual(["root"]);
    expect(st.store.replies("root").map((m) => m.id)).toEqual(["r1"]);
  });

  it("send(replyTo) publishes a msg envelope carrying replyTo", async () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeChatMsg("root", "topic", "Bob", 1));
    await svc.send("pub:general", "my reply", "root");
    const env = JSON.parse(mesh.published.at(-1)!.text);
    expect(env).toMatchObject({ t: "msg", text: "my reply", replyTo: "root" });
  });
});

describe("history backfill", () => {
  it("requests history on join", async () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Alice");
    await svc.join(publicChannel("general"));
    await tick();
    const reqs = mesh.published.filter((p) => JSON.parse(p.text).t === "history-request");
    expect(reqs.length).toBe(1);
  });

  it("a peer holding history answers a request with its recent messages", async () => {
    // Bob has history; Alice joins and asks; Bob serves it.
    const aMesh = new FakeMesh(ALICE);
    const bMesh = new FakeMesh(BOB);
    const alice = new ChatService(aMesh, ALICE, "Alice");
    const bob = new ChatService(bMesh, BOB, "Bob");
    await bob.join(publicChannel("general"));
    bob.startStream();
    // Seed Bob's store with a couple of messages.
    bob.route({ from: BOB, topic: TOPIC, text: encodeEnvelope(makeChatMsg("h1", "old one", "Bob", 1)), receivedAt: 1 });
    bob.route({ from: EVE, topic: TOPIC, text: encodeEnvelope(makeChatMsg("h2", "old two", "Eve", 2)), receivedAt: 2 });

    await alice.join(publicChannel("general"));
    alice.startStream();
    await tick(8);

    const aliceView = alice.state("pub:general")!.store.list();
    expect(aliceView.some((m) => m.text === "old one")).toBe(true);
    expect(aliceView.some((m) => m.text === "old two")).toBe(true);
    alice.stop();
    bob.stop();
  });

  it("merges a history-response and does not double-count existing messages", async () => {
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeChatMsg("dup", "already here", "Bob", 1));
    const items: HistoryItem[] = [
      { id: "dup", from: BOB, text: "already here", name: "Bob", ts: 1 },
      { id: "new", from: EVE, text: "backfilled", name: "Eve", ts: 0 },
    ];
    deliver(svc, BOB, makeHistoryResponse("nonce", items, 9));
    const list = svc.state("pub:general")!.store.list();
    expect(list).toHaveLength(2);
    expect(list.some((m) => m.id === "new")).toBe(true);
  });

  it("does not answer its own history request", async () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Alice");
    await svc.join(publicChannel("general"));
    // Self-delivered history-request must not produce a history-response.
    deliver(svc, ALICE, makeHistoryRequest(10, 0, "n", 1));
    const responses = mesh.published.filter((p) => JSON.parse(p.text).t === "history-response");
    expect(responses).toHaveLength(0);
  });
});

describe("unread tracking", () => {
  it("increments unread on remote messages and clears on markRead", async () => {
    const onUnread = vi.fn();
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice", { onUnread });
    await svc.join(publicChannel("general"));
    deliver(svc, BOB, makeChatMsg("m1", "one", "Bob", 1));
    deliver(svc, BOB, makeChatMsg("m2", "two", "Bob", 2));
    expect(svc.state("pub:general")!.unread).toBe(2);
    expect(svc.totalUnread()).toBe(2);
    svc.markRead("pub:general");
    expect(svc.state("pub:general")!.unread).toBe(0);
    expect(onUnread).toHaveBeenCalled();
  });

  it("does not count our own messages as unread", async () => {
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    deliver(svc, ALICE, makeChatMsg("mine", "self", "Alice", 1));
    expect(svc.state("pub:general")!.unread).toBe(0);
  });
});

describe("inbound rate limiting", () => {
  it("drops frames from a flooding peer past the per-window cap", async () => {
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    for (let i = 0; i < INBOUND_MAX_PER_WINDOW + 50; i++) {
      deliver(svc, EVE, makeChatMsg(`f${i}`, "spam", "Eve", i));
    }
    expect(svc.state("pub:general")!.store.size).toBe(INBOUND_MAX_PER_WINDOW);
  });

  it("never rate-limits our own frames", async () => {
    const svc = new ChatService(new FakeMesh(ALICE), ALICE, "Alice");
    await svc.join(publicChannel("general"));
    for (let i = 0; i < INBOUND_MAX_PER_WINDOW + 50; i++) {
      deliver(svc, ALICE, makeChatMsg(`s${i}`, "ours", "Alice", i));
    }
    expect(svc.state("pub:general")!.store.size).toBe(INBOUND_MAX_PER_WINDOW + 50);
  });
});

describe("display name in place", () => {
  it("setDisplayName changes the broadcast name without a reload", async () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Old");
    await svc.join(publicChannel("general"));
    svc.setDisplayName("New");
    expect(svc.name).toBe("New");
    await svc.send("pub:general", "hi");
    const env = JSON.parse(mesh.published.at(-1)!.text);
    expect(env.name).toBe("New");
  });
});

describe("send failure marks the message failed and retry re-publishes", () => {
  it("flips a message to failed on publish error, then retry sends it", async () => {
    const mesh = new FakeMesh(ALICE);
    let fail = true;
    const realPublish = mesh.publish.bind(mesh);
    mesh.publish = async (topic: string, payload: Uint8Array) => {
      if (fail && new TextDecoder().decode(payload).includes('"t":"msg"')) throw new Error("down");
      return realPublish(topic, payload);
    };
    const svc = new ChatService(mesh, ALICE, "Alice");
    await svc.join(publicChannel("general"));
    await expect(svc.send("pub:general", "will fail")).rejects.toThrow("down");
    const list = svc.state("pub:general")!.store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("failed");

    fail = false;
    await svc.retry("pub:general", list[0]!.id);
    expect(svc.state("pub:general")!.store.get(ALICE, list[0]!.id)!.status).not.toBe("failed");
  });
});
