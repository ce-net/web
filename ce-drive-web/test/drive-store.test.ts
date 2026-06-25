import { describe, it, expect, beforeEach } from "vitest";
import { DriveStore } from "../src/store/drive-store.js";
import type { DriveCore, TreeSnapshot } from "../src/core/drive-core.js";
import { ROOT, type DriveNode, type NodeId } from "../src/core/model.js";

function node(id: NodeId, name: string, parent: NodeId, kind: DriveNode["kind"] = "dir"): DriveNode {
  return { id, name, parent, kind, path: `/${name}`, mtimeMs: 0 };
}

/** Build a fixed snapshot: ROOT -> {Documents -> {report.md}, Pictures}. */
function makeSnapshot(): TreeSnapshot {
  const docs = node("docs", "Documents", ROOT);
  const pics = node("pics", "Pictures", ROOT);
  const report = node("rep", "report.md", "docs", "file");
  const nodes = new Map<NodeId, DriveNode>([
    ["docs", docs],
    ["pics", pics],
    ["rep", report],
  ]);
  const children = new Map<NodeId, NodeId[]>([
    [ROOT, ["docs", "pics"]],
    ["docs", ["rep"]],
  ]);
  return { nodes, children };
}

/** A DriveCore stub that returns a controllable snapshot. */
function fakeCore(snapshot: TreeSnapshot): DriveCore {
  return {
    selfId: () => "self",
    tree: async () => snapshot,
    trash: async () => [],
  } as unknown as DriveCore;
}

describe("DriveStore reducers", () => {
  let store: DriveStore;

  beforeEach(async () => {
    store = new DriveStore();
    store.core = fakeCore(makeSnapshot());
    await store.refresh();
  });

  it("refresh loads the snapshot from the core", () => {
    expect(store.snapshot.nodes.size).toBe(3);
    expect(store.currentChildren()).toEqual(["docs", "pics"]);
  });

  it("navigate sets cwd and clears selection", () => {
    store.select("docs");
    expect(store.selection.has("docs")).toBe(true);
    store.navigate("docs");
    expect(store.cwd).toBe("docs");
    expect(store.selection.size).toBe(0);
    expect(store.currentChildren()).toEqual(["rep"]);
  });

  it("select replaces selection by default and toggles when additive", () => {
    store.select("docs");
    store.select("pics"); // non-additive: replaces
    expect([...store.selection]).toEqual(["pics"]);
    store.select("docs", true); // additive: add
    expect(store.selection.has("docs")).toBe(true);
    expect(store.selection.has("pics")).toBe(true);
    store.select("docs", true); // additive toggle: remove
    expect(store.selection.has("docs")).toBe(false);
  });

  it("clearSelection empties the selection", () => {
    store.select("docs", true);
    store.select("pics", true);
    store.clearSelection();
    expect(store.selection.size).toBe(0);
  });

  it("breadcrumb walks ROOT -> cwd", () => {
    store.navigate("docs");
    const crumbs = store.breadcrumb().map((c) => c.name);
    expect(crumbs).toEqual(["My Drive", "Documents"]);
  });

  it("refresh resets cwd to ROOT when the current folder vanished", async () => {
    store.navigate("docs");
    expect(store.cwd).toBe("docs");
    // Next snapshot no longer has 'docs'.
    const pruned = makeSnapshot();
    pruned.nodes.delete("docs");
    store.core = fakeCore(pruned);
    await store.refresh();
    expect(store.cwd).toBe(ROOT);
  });

  it("refresh drops selections for nodes that disappeared", async () => {
    store.select("docs", true);
    store.select("pics", true);
    const pruned = makeSnapshot();
    pruned.nodes.delete("pics");
    store.core = fakeCore(pruned);
    await store.refresh();
    expect(store.selection.has("docs")).toBe(true);
    expect(store.selection.has("pics")).toBe(false);
  });

  it("notifies subscribers on mutation", () => {
    let count = 0;
    const unsub = store.subscribe(() => count++);
    store.navigate("pics");
    store.select("rep");
    store.clearSelection();
    expect(count).toBe(3);
    unsub();
    store.navigate(ROOT);
    expect(count).toBe(3); // no more notifications after unsubscribe
  });
});
