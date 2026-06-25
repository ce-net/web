import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatService, newMessageId } from "../src/core/service.ts";
import { publicChannel, privateChannel } from "../src/core/topics.ts";
import { FakeMesh, resetBuses } from "./fake-mesh.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

beforeEach(() => resetBuses());

/** Wait for an async iterator pump cycle to flush queued frames. */
async function tick(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("newMessageId", () => {
  it("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newMessageId(ALICE)));
    expect(ids.size).toBe(1000);
  });
});

describe("ChatService join/send routing", () => {
  it("joins a channel and subscribes its mesh topic", async () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Alice");
    const ref = publicChannel("general");
    await svc.join(ref);
    expect(svc.joined().map((c) => c.id)).toEqual(["pub:general"]);
    // self should be counted present immediately
    expect(svc.state(ref.id)!.presence.onlineCount(Date.now())).toBe(1);
  });

  it("send adds an optimistic pending message then confirms on echo", async () => {
    const mesh = new FakeMesh(ALICE);
    const events = { onMessages: vi.fn(), onPresence: vi.fn() };
    const svc = new ChatService(mesh, ALICE, "Alice", events);
    const ref = publicChannel("general");
    await svc.join(ref);
    svc.startStream();

    const optimistic = await svc.send(ref.id, "hello mesh");
    expect(optimistic.status).toBe("pending");
    // optimistic is in the log right away
    expect(svc.state(ref.id)!.store.list()).toHaveLength(1);

    await tick();
    const list = svc.state(ref.id)!.store.list();
    // still one message (echo dedupes by (from,id)), now confirmed
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("sent");
    expect(list[0]!.isSelf).toBe(true);
    expect(list[0]!.text).toBe("hello mesh");
    svc.stop();
  });

  it("publishes a ce-chat JSON envelope to the channel topic", async () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Alice");
    const ref = publicChannel("general");
    await svc.join(ref);
    await svc.send(ref.id, "wire check");
    // join() also fires a best-effort history-request, so filter to the chat line.
    const msgs = mesh.published.filter((p) => JSON.parse(p.text).t === "msg");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.topic).toBe("ce-chat/channel/general");
    const env = JSON.parse(msgs[0]!.text);
    expect(env).toMatchObject({ t: "msg", text: "wire check", name: "Alice" });
  });

  it("trims and rejects empty sends", async () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Alice");
    const ref = publicChannel("general");
    await svc.join(ref);
    await expect(svc.send(ref.id, "   ")).rejects.toThrow();
  });

  it("routes a remote peer's message into the right channel and tracks presence", async () => {
    const mesh = new FakeMesh(ALICE);
    const events = { onMessages: vi.fn(), onPresence: vi.fn() };
    const svc = new ChatService(mesh, ALICE, "Alice", events);
    const ref = publicChannel("general");
    await svc.join(ref);

    // Bob publishes to the same topic.
    svc.route({
      from: BOB,
      topic: ref.topic,
      text: JSON.stringify({ t: "msg", v: 1, id: "bob-1", text: "hi Alice", name: "Bob", ts: 123 }),
      receivedAt: 200,
    });

    const list = svc.state(ref.id)!.store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!).toMatchObject({ from: BOB, text: "hi Alice", name: "Bob", isSelf: false });
    // Bob now counts as a present member.
    expect(svc.state(ref.id)!.presence.list(200).some((m) => m.nodeId === BOB)).toBe(true);
    expect(events.onMessages).toHaveBeenCalledWith(ref.id);
  });

  it("ignores frames for topics we don't track", () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Alice");
    svc.route({ from: BOB, topic: "ce-chat/channel/other", text: '{"t":"msg","id":"x","text":"y"}', receivedAt: 1 });
    expect(svc.joined()).toHaveLength(0);
  });

  it("drops non-ce-chat payloads on a subscribed topic", async () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Alice");
    const ref = publicChannel("general");
    await svc.join(ref);
    svc.route({ from: BOB, topic: ref.topic, text: "garbage{", receivedAt: 1 });
    svc.route({ from: BOB, topic: ref.topic, text: JSON.stringify({ t: "ce-pin" }), receivedAt: 1 });
    expect(svc.state(ref.id)!.store.list()).toHaveLength(0);
  });

  it("presence-only frames update the roster without adding a message", async () => {
    const mesh = new FakeMesh(ALICE);
    const svc = new ChatService(mesh, ALICE, "Alice");
    const ref = publicChannel("general");
    await svc.join(ref);
    svc.route({ from: BOB, topic: ref.topic, text: JSON.stringify({ t: "presence", v: 1, name: "Bob", ts: 9 }), receivedAt: 300 });
    expect(svc.state(ref.id)!.store.list()).toHaveLength(0);
    expect(svc.state(ref.id)!.presence.list(300).some((m) => m.nodeId === BOB)).toBe(true);
  });
});

describe("ChatService two-party mesh round-trip", () => {
  it("delivers Alice's message to Bob over the shared topic via the stream", async () => {
    const aMesh = new FakeMesh(ALICE);
    const bMesh = new FakeMesh(BOB);
    const alice = new ChatService(aMesh, ALICE, "Alice");
    const bob = new ChatService(bMesh, BOB, "Bob");
    const ref = publicChannel("general");
    await alice.join(ref);
    await bob.join(ref);
    alice.startStream();
    bob.startStream();

    await alice.send(ref.id, "ahoy");
    await tick(5);

    const bobsView = bob.state(ref.id)!.store.list();
    expect(bobsView.some((m) => m.text === "ahoy" && m.from === ALICE && !m.isSelf)).toBe(true);
    // And Alice sees Bob as a member only after Bob speaks; here Alice still has herself.
    alice.stop();
    bob.stop();
  });
});

describe("ChatService private channel gating", () => {
  it("propagates the node's 403 when subscribing to a gated topic", async () => {
    const mesh = new FakeMesh(ALICE);
    const ref = privateChannel("secret");
    mesh.denied.add(ref.topic);
    const svc = new ChatService(mesh, ALICE, "Alice");
    await expect(svc.join(ref)).rejects.toMatchObject({ name: "CeAuthError", status: 403 });
    // The channel must NOT be registered locally on failure.
    expect(svc.joined()).toHaveLength(0);
  });

  it("joins a private channel once the node permits the subscription", async () => {
    const mesh = new FakeMesh(ALICE);
    const ref = privateChannel("eng"); // not denied -> permitted (capability present)
    const svc = new ChatService(mesh, ALICE, "Alice");
    await svc.join(ref);
    expect(svc.joined().map((c) => c.id)).toEqual(["prv:eng"]);
  });
});

describe("ChatService stream lifecycle", () => {
  it("surfaces a stream error via onStreamError", async () => {
    const mesh = new FakeMesh(ALICE);
    const onStreamError = vi.fn();
    // Replace streamMessages with one that throws.
    mesh.streamMessages = async function* () {
      throw Object.assign(new Error("down"), { name: "CeConnectionError" });
    };
    const svc = new ChatService(mesh, ALICE, "Alice", { onStreamError });
    await svc.join(publicChannel("general"));
    svc.startStream();
    await tick(5);
    svc.stop(); // stop the reconnect loop before asserting
    expect(onStreamError).toHaveBeenCalled();
    expect((onStreamError.mock.calls[0]![0] as Error).name).toBe("CeConnectionError");
  });

  it("stop() aborts the stream without firing onStreamError", async () => {
    const mesh = new FakeMesh(ALICE);
    const onStreamError = vi.fn();
    const svc = new ChatService(mesh, ALICE, "Alice", { onStreamError });
    await svc.join(publicChannel("general"));
    svc.startStream();
    svc.stop();
    await tick(3);
    expect(onStreamError).not.toHaveBeenCalled();
  });
});
