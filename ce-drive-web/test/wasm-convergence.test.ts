import { describe, it, expect, beforeAll } from "vitest";
import { loadCrdtForTest } from "./wasm-loader.js";
import type { DriveCrdt, DriveCrdtCtor, WasmDirEntry } from "../src/core/wasm/types.js";

let DriveCrdt: DriveCrdtCtor;

beforeAll(async () => {
  ({ DriveCrdt } = await loadCrdtForTest());
});

/** A canonical, order-independent fingerprint of a CRDT's full live tree. */
function fingerprint(crdt: DriveCrdt): string {
  const lines: string[] = [];
  const walk = (path: string) => {
    let entries: WasmDirEntry[];
    try {
      entries = crdt.list(path);
    } catch {
      return;
    }
    // Sort so delivery order can never change the fingerprint.
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) {
      const child = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
      const cid = e.content?.cid ?? "-";
      lines.push(`${child}\t${e.isDir ? "d" : "f"}\t${cid}`);
      if (e.isDir) walk(child);
    }
  };
  walk("/");
  return lines.join("\n");
}

describe("WasmDriveCore CRDT convergence", () => {
  it("converges B and C to A despite out-of-order op delivery", () => {
    const a = new DriveCrdt("replica-A");

    // Replica A mints a small tree: /Documents, /Documents/report.md, /Pictures.
    const mkDocs = a.mkdir("/", "Documents");
    const mkPics = a.mkdir("/", "Pictures");
    const addReport = a.addFile(
      "/Documents",
      "report.md",
      "cid-report-aaaa",
      BigInt(1024),
      0o644,
      BigInt(1_700_000_000_000),
    );
    const addPhoto = a.addFile(
      "/Pictures",
      "photo.png",
      "cid-photo-bbbb",
      BigInt(2048),
      0o644,
      BigInt(1_700_000_001_000),
    );

    // The move-ops (structure). addFile of a brand-new file also yields a move op.
    const moveOps: Uint8Array[] = [
      mkDocs.moveOp!,
      mkPics.moveOp!,
      addReport.moveOp!,
      addPhoto.moveOp!,
    ];
    const contentOps: Uint8Array[] = [addReport.contentOp!, addPhoto.contentOp!];
    // wasm-bindgen returns byte arrays; assert they are non-empty byte buffers (the exact
    // constructor identity differs across the jsdom/wasm realm, so check shape not instanceof).
    for (const op of moveOps) expect(op.length).toBeGreaterThan(0);
    for (const op of contentOps) expect(op.length).toBeGreaterThan(0);

    const aPrint = fingerprint(a);
    // Sanity: A really built the tree.
    expect(aPrint).toContain("/Documents/report.md\tf\tcid-report-aaaa");
    expect(aPrint).toContain("/Pictures/photo.png\tf\tcid-photo-bbbb");

    // Replica B: deliver move ops REVERSED, then content ops reversed.
    const b = new DriveCrdt("replica-B");
    for (const op of [...moveOps].reverse()) b.applyMoveOp(op);
    for (const op of [...contentOps].reverse()) b.applyContentOp(op);

    // Replica C: interleave content before some moves (worst-case ordering).
    const c = new DriveCrdt("replica-C");
    c.applyContentOp(contentOps[0]!); // content arrives before its file's move op
    c.applyMoveOp(moveOps[2]!); // report.md move
    c.applyMoveOp(moveOps[0]!); // Documents
    c.applyContentOp(contentOps[1]!);
    c.applyMoveOp(moveOps[3]!); // photo.png
    c.applyMoveOp(moveOps[1]!); // Pictures

    expect(fingerprint(b)).toBe(aPrint);
    expect(fingerprint(c)).toBe(aPrint);

    a.free();
    b.free();
    c.free();
  });

  it("is idempotent: re-applying the same op does not duplicate state", () => {
    const a = new DriveCrdt("replica-A");
    const mk = a.mkdir("/", "Folder");
    const b = new DriveCrdt("replica-B");
    b.applyMoveOp(mk.moveOp!);
    b.applyMoveOp(mk.moveOp!); // duplicate delivery
    b.applyMoveOp(mk.moveOp!);
    expect(b.list("/").filter((e) => e.name === "Folder")).toHaveLength(1);
    a.free();
    b.free();
  });

  it("resolves a name collision deterministically across replicas (conflict rename)", () => {
    // Two replicas independently create a file of the same name under ROOT, then exchange ops.
    const a = new DriveCrdt("replica-A");
    const b = new DriveCrdt("replica-B");
    const aFile = a.addFile("/", "notes.txt", "cid-a", BigInt(10), 0o644, BigInt(1000));
    const bFile = b.addFile("/", "notes.txt", "cid-b", BigInt(20), 0o644, BigInt(2000));

    // Cross-deliver.
    a.applyMoveOp(bFile.moveOp!);
    a.applyContentOp(bFile.contentOp!);
    b.applyMoveOp(aFile.moveOp!);
    b.applyContentOp(aFile.contentOp!);

    // Both replicas must agree on the same converged tree (one winner keeps the name, the
    // loser is surfaced with a deterministic .conflict- suffix — never silently dropped).
    const fa = fingerprint(a);
    const fb = fingerprint(b);
    expect(fb).toBe(fa);
    // Both CIDs survive (no data loss).
    expect(fa).toContain("cid-a");
    expect(fa).toContain("cid-b");

    a.free();
    b.free();
  });
});
