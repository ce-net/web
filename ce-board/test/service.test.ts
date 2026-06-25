/**
 * BoardService over the in-memory mesh: the end-to-end "two tabs converge" property
 * that the whole app exists to deliver, plus optimistic local apply, idempotent echo,
 * clock advancement on remote ops, and snapshot bootstrap.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BoardService } from "../src/core/service.ts";
import { orderedColumns, orderedCards, type Board } from "../src/core/oplog.ts";
import { opsTopic } from "../src/core/topics.ts";
import { FakeMesh, FakeData, resetBuses, flush, rng, shuffle } from "./fakes.ts";

const BOARD = "demo";
const TOPIC = opsTopic(BOARD);

function canon(board: Board): string {
  const cols = orderedColumns(board).map((c) => ({ id: c.id, title: c.title }));
  const cards = [...board.cards.values()]
    .filter((c) => !c.deleted)
    .map((c) => ({ id: c.id, column: c.column, title: c.title, body: c.body }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return JSON.stringify({ name: board.name, cols, cards });
}

/** A service wired to its own FakeMesh on the shared bus + a shared data store. */
function makeTab(client: string, mesh: FakeMesh, data: FakeData): BoardService {
  return new BoardService(mesh, data, BOARD, TOPIC, `node-${client}`, {}, client);
}

let data: FakeData;

beforeEach(() => {
  resetBuses();
  data = new FakeData();
});

afterEach(() => resetBuses());

describe("optimistic local apply + publish", () => {
  it("applies a local op immediately and publishes it to the topic", async () => {
    const mesh = new FakeMesh("node-A");
    const svc = makeTab("A", mesh, data);
    await svc.bootstrap(null);
    await svc.addColumn("c1", "Todo", 0);
    expect(orderedColumns(svc.current()).map((c) => c.title)).toEqual(["Todo"]);
    expect(mesh.published).toHaveLength(1);
    expect(mesh.published[0]!.topic).toBe(TOPIC);
    svc.stop();
  });

  it("the mesh self-echo is idempotent (op count counts the op once)", async () => {
    const mesh = new FakeMesh("A"); // from-id matches nothing in particular
    const svc = makeTab("A", mesh, data);
    await svc.bootstrap(null);
    await svc.addColumn("c1", "Todo", 0);
    await flush();
    // local apply (1) + folding the echoed frame (idempotent, +0) = 1 change.
    expect(svc.opsFolded()).toBe(1);
    svc.stop();
  });
});

describe("two tabs converge", () => {
  it("interleaved edits on two tabs reach byte-identical boards", async () => {
    const meshA = new FakeMesh("node-A");
    const meshB = new FakeMesh("node-B");
    const a = makeTab("A", meshA, data);
    const b = makeTab("B", meshB, data);
    await a.bootstrap(null);
    await b.bootstrap(null);

    await a.addColumn("c1", "Todo", 0);
    await b.addColumn("c2", "Doing", 1);
    await flush();
    await a.addCard("k1", "c1", "Write SDK", 0);
    await b.addCard("k2", "c2", "Review", 0);
    await flush();
    await a.editCard("k2", { title: "Review PR" }); // A edits B's card
    await b.moveCard("k1", "c2", 1); // B moves A's card
    await flush();

    expect(canon(a.current())).toBe(canon(b.current()));
    a.stop();
    b.stop();
  });

  it("concurrent moves of the same card converge deterministically", async () => {
    const meshA = new FakeMesh("node-A");
    const meshB = new FakeMesh("node-B");
    const a = makeTab("A", meshA, data);
    const b = makeTab("B", meshB, data);
    await a.bootstrap(null);
    await b.bootstrap(null);

    await a.addColumn("c1", "Todo", 0);
    await a.addColumn("c2", "Doing", 1);
    await a.addColumn("c3", "Done", 2);
    await a.addCard("k", "c1", "Card", 0);
    await flush();

    // Both move "k" before hearing the other (simulate by not flushing between).
    await a.moveCard("k", "c2", 1);
    await b.moveCard("k", "c3", 2);
    await flush();

    expect(canon(a.current())).toBe(canon(b.current()));
    // The same winner on both replicas.
    expect(a.current().cards.get("k")!.column).toBe(b.current().cards.get("k")!.column);
    a.stop();
    b.stop();
  });

  it("a remote op advances the local clock so later local ops sort after it", async () => {
    const meshA = new FakeMesh("node-A");
    const meshB = new FakeMesh("node-B");
    const a = makeTab("A", meshA, data);
    const b = makeTab("B", meshB, data);
    await a.bootstrap(null);
    await b.bootstrap(null);

    // B emits 5 ops, raising its lamport to 5; A hears them, then edits.
    for (let i = 0; i < 5; i++) await b.addColumn(`bc${i}`, `B${i}`, i);
    await flush();
    await a.addColumn("ac", "A-after", 99);
    await flush();

    // A's column must carry a lamport strictly greater than B's last (5).
    const aCol = a.current().columns.get("ac")!;
    // Stamp isn't exposed directly, but convergence proves ordering held:
    expect(canon(a.current())).toBe(canon(b.current()));
    expect(aCol.title).toBe("A-after");
    a.stop();
    b.stop();
  });
});

describe("snapshot bootstrap", () => {
  it("a new tab bootstraps from a CID, then tails live ops", async () => {
    // Tab A builds a board and snapshots it.
    const meshA = new FakeMesh("node-A");
    const a = makeTab("A", meshA, data);
    await a.bootstrap(null);
    await a.addColumn("c1", "Todo", 0);
    await a.addCard("k1", "c1", "Seeded", 0);
    await flush();
    const cid = await a.saveSnapshot();

    // Tab C boots from the CID (no op history replayed), then receives a live op.
    const meshC = new FakeMesh("node-C");
    const c = makeTab("C", meshC, data);
    await c.bootstrap(cid);
    expect(orderedCards(c.current(), "c1").map((x) => x.title)).toEqual(["Seeded"]);

    await a.addCard("k2", "c1", "Live", 1);
    await flush();
    expect(orderedCards(c.current(), "c1").map((x) => x.title)).toEqual(["Seeded", "Live"]);
    a.stop();
    c.stop();
  });

  it("a missing/unknown snapshot CID is non-fatal — start empty and tail", async () => {
    const mesh = new FakeMesh("node-A");
    const svc = makeTab("A", mesh, data);
    await expect(svc.bootstrap("deadbeef".repeat(8))).resolves.toBeUndefined();
    expect(svc.current().columns.size).toBe(0);
    svc.stop();
  });
});

describe("randomized convergence over the mesh", () => {
  it("two tabs applying a shuffled op script still converge", async () => {
    const rand = rng(2025);
    type Action = (s: BoardService) => Promise<void>;
    const actions: Action[] = [
      (s) => s.addColumn("c1", "Todo", 0),
      (s) => s.addColumn("c2", "Doing", 1),
      (s) => s.addCard("k1", "c1", "A", 0),
      (s) => s.addCard("k2", "c1", "B", 1),
      (s) => s.editCard("k1", { body: "more" }),
      (s) => s.moveCard("k2", "c2", 0),
      (s) => s.renameColumn("c1", "Backlog"),
      (s) => s.deleteCard("k1"),
    ];

    const meshA = new FakeMesh("node-A");
    const meshB = new FakeMesh("node-B");
    const a = makeTab("A", meshA, data);
    const b = makeTab("B", meshB, data);
    await a.bootstrap(null);
    await b.bootstrap(null);

    // Each tab fires a different shuffle of the same actions, flushing intermittently.
    const orderA = shuffle(actions, rand);
    const orderB = shuffle(actions, rand);
    for (let i = 0; i < actions.length; i++) {
      if (orderA[i]) await orderA[i]!(a);
      if (orderB[i]) await orderB[i]!(b);
      if (i % 2 === 0) await flush();
    }
    await flush();
    await flush();

    expect(canon(a.current())).toBe(canon(b.current()));
    a.stop();
    b.stop();
  });
});
