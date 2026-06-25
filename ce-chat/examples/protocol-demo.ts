/**
 * Runnable example: the ce-chat wire protocol + store reducer + a two-party mesh
 * round-trip, all with an in-memory mesh and no node.
 *
 *   npx tsx examples/protocol-demo.ts
 *
 * (Requires a TS runner such as tsx/ts-node, or compile with `tsc` first. This file
 * imports only the SDK-agnostic core, so it runs without a live CE node.)
 */

import {
  makeChatMsg,
  makeReact,
  makeHistoryResponse,
  parseEnvelope,
  encodeEnvelope,
  type HistoryItem,
} from "../src/core/protocol.ts";
import { MessageStore } from "../src/core/store.ts";
import { ChatService, type MeshLike, type MeshFrame } from "../src/core/service.ts";
import { publicChannel } from "../src/core/topics.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

/* ----------------------------------------------------------- 1. envelopes */

console.log("== envelopes ==");
const chat = makeChatMsg("m1", "hello mesh", "Alice", Date.now());
const wire = encodeEnvelope(chat);
console.log("encoded:", wire);
console.log("decoded round-trips:", JSON.stringify(parseEnvelope(wire)) === wire);
console.log("garbage is dropped:", parseEnvelope("not json{") === null);

/* ------------------------------------------------------------- 2. store */

console.log("\n== store reducer ==");
const store = new MessageStore();
store.add({ id: "m1", from: BOB, text: "hi", ts: 1, receivedAt: 1, isSelf: false, status: "sent" });
// Two authors reusing the same id stay distinct (anti-spoof):
store.add({ id: "m1", from: ALICE, text: "also m1", ts: 2, receivedAt: 2, isSelf: true, status: "sent" });
console.log("messages kept distinct by (from,id):", store.size === 2);
store.applyReaction(BOB, "m1", ALICE, "👍", "add");
console.log("reaction aggregated:", store.get(BOB, "m1")?.reactions?.[0]?.emoji === "👍");

/* ----------------------------------------- 3. in-memory mesh (like the node) */

interface Bus {
  subs: Set<InMemoryMesh>;
}
const buses = new Map<string, Bus>();

class InMemoryMesh implements MeshLike {
  private readonly queue: MeshFrame[] = [];
  private wake: (() => void) | null = null;
  constructor(readonly nodeId: string) {}
  async subscribe(topic: string): Promise<void> {
    const bus = buses.get(topic) ?? { subs: new Set<InMemoryMesh>() };
    bus.subs.add(this);
    buses.set(topic, bus);
  }
  async publish(topic: string, payload: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(payload);
    for (const s of buses.get(topic)?.subs ?? []) {
      s.queue.push({ from: this.nodeId, topic, text, receivedAt: Date.now() });
      s.wake?.();
    }
  }
  async *streamMessages(): AsyncIterable<MeshFrame> {
    for (;;) {
      if (this.queue.length === 0) await new Promise<void>((r) => (this.wake = r));
      while (this.queue.length) yield this.queue.shift()!;
    }
  }
}

/* ---------------------------------------------- 4. two-party round-trip */

async function roundTrip(): Promise<void> {
  console.log("\n== two-party round-trip ==");
  const aliceMesh = new InMemoryMesh(ALICE);
  const bobMesh = new InMemoryMesh(BOB);
  const alice = new ChatService(aliceMesh, ALICE, "Alice");
  const bob = new ChatService(bobMesh, BOB, "Bob");
  const ref = publicChannel("general");
  await alice.join(ref);
  await bob.join(ref);
  alice.startStream();
  bob.startStream();

  await alice.send(ref.id, "ahoy Bob");
  await new Promise((r) => setTimeout(r, 20));

  const bobsView = bob.state(ref.id)!.store.list();
  console.log("Bob received:", bobsView.map((m) => `${m.name}: ${m.text}`));

  await bob.react(ref.id, ALICE, bobsView[0]!.id, "🎉", "add");
  await new Promise((r) => setTimeout(r, 20));
  const aliceMsg = alice.state(ref.id)!.store.list()[0]!;
  console.log("Alice sees Bob's reaction:", aliceMsg.reactions?.[0]?.emoji);

  alice.stop();
  bob.stop();
}

/* ---------------------------------------------- 5. history backfill demo */

function historyDemo(): void {
  console.log("\n== history backfill envelope ==");
  const items: HistoryItem[] = [
    { id: "h1", from: BOB, text: "old line one", name: "Bob", ts: 1 },
    { id: "h2", from: ALICE, text: "old line two", name: "Alice", ts: 2 },
  ];
  const resp = makeHistoryResponse("nonce-123", items, Date.now());
  const decoded = parseEnvelope(encodeEnvelope(resp));
  console.log("history-response carries", (decoded as { items: HistoryItem[] }).items.length, "items");
  // A reaction envelope for completeness:
  console.log("react envelope:", encodeEnvelope(makeReact("h1", "❤️", "add", "Alice", Date.now())));
}

await roundTrip();
historyDemo();
console.log("\nDone.");
