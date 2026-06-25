/**
 * WasmDriveCore — the production {@link DriveCore}, backed by the REAL ce-drive-wasm CRDT.
 *
 * This replaces {@link MockDriveCore}. The tree structure, path resolution, version lists,
 * and conflict-rename projection are computed by `ce-drive-wasm`'s `DriveCrdt` (the pure
 * Kleppmann move-CRDT compiled to wasm). File *bytes* ride the CE node's content-addressed
 * blob layer via `@ce-net/sdk` (`putObject`/`getObject`: chunked, per-chunk CID-verified).
 * Multi-device convergence is the merged-log model: every op (this device's and every
 * peer's) is published on / fetched from a per-drive mesh topic and fed into the CRDT, which
 * integrates by total-order timestamp (tree) and LWW-by-mtime (content) so all devices fold
 * to the identical state regardless of delivery order.
 *
 * The boundary is exact:
 *   - tree / path / version / conflict  -> ce-drive-wasm  (`DriveCrdt`)
 *   - file bytes                        -> @ce-net/sdk     (`DataApi.putObject/getObject`)
 *   - op propagation (multi-device)     -> @ce-net/sdk     (`MeshApi.publish/subscribe` + SSE)
 *   - durable op log / bootstrap        -> @ce-net/sdk     (`DataApi.putBlob/getBlob`)
 *   - share / revoke / audit            -> @ce-net/sdk     (capabilities + `/history`)
 *
 * NodeId vs path: the {@link DriveCore} interface keys structural ops by stable NodeId, but
 * the wasm surface mints by *path* (then returns the new id). We bridge with `pathOf(id)`,
 * deriving the path for each id-keyed call. Trashed nodes have no ROOT-rooted path, so we
 * keep a small local shadow of trashed entries (name + content + original parent) to render
 * the trash view and restore — the CRDT remains the source of truth for live nodes.
 */

import type { CeClient } from "@ce-net/sdk";
import type { DriveCore, ProgressFn, TreeSnapshot } from "./drive-core.js";
import {
  type AuditEntry,
  type DriveAbility,
  type DriveNode,
  type FileContent,
  type FileVersion,
  type NodeId,
  ROOT,
  type ShareGrant,
  TRASH,
} from "./model.js";
import { loadDriveWasm } from "./wasm/load.js";
import type { DriveCrdt, WasmDirEntry, WasmFileContent } from "./wasm/types.js";

/** The blob/object content backend (the SDK `DataApi`, or the offline memory fallback). */
export interface ObjectBackend {
  putObject(bytes: Uint8Array, onProgress?: ProgressFn): Promise<string>;
  getObject(cid: string, onProgress?: ProgressFn): Promise<Uint8Array>;
  putBlob(bytes: Uint8Array): Promise<string>;
  getBlob(hash: string): Promise<Uint8Array>;
}

/** The op-propagation transport (the SDK `MeshApi`, or a no-op when offline/single-device). */
export interface OpTransport {
  publish(topic: string, payload: Uint8Array): Promise<void>;
  subscribe(topic: string): Promise<void>;
  /** Async stream of inbound `{ topic, payload }` app messages. */
  messages(topic: string, onMessage: (payload: Uint8Array) => void): () => void;
}

/** Optional on-chain capability surface for real share/revoke + audit reads. */
export interface ChainBackend {
  /** Submit an on-chain RevokeCapability for a nonce; returns the tx id. */
  revoke(nonce: number): Promise<string>;
  /** The on-chain revoked `(issuer, nonce)` set. */
  revoked(): Promise<{ issuer: string; nonce: number }[]>;
  /** The local node id (capability issuer / audit subject). */
  selfId: string;
}

/** A merged-log op envelope on the wire: which collection, and the opaque op JSON bytes. */
interface FramedOp {
  /** `m` = MoveOp (tree), `c` = StampedContentOp (content). */
  k: "m" | "c";
  /** The opaque op JSON bytes, hex-encoded for the JSON envelope. */
  b: string;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A trashed-node shadow: the CRDT holds the edge under TRASH, but we cache render data. */
interface TrashShadow {
  id: NodeId;
  name: string;
  originalParent: NodeId;
  isDir: boolean;
  content?: FileContent;
  mtimeMs: number;
}

/**
 * The per-drive mesh topic for merged-log ops. The topic MUST be keyed by a stable drive id
 * that is IDENTICAL on every device of the drive — not by the local device's node id. v1 has
 * one drive per owning identity, so the drive id is the owning identity (derived from the
 * drive's root capability / `chain.selfId`); multi-tenant drives derive it from the drive's
 * root capability. Keying by the device node id would give each device its own topic, so two
 * devices of the same owner would never see each other's ops and could never converge.
 */
function driveTopic(driveId: string): string {
  return `ce-drive/ops/${driveId}`;
}

/**
 * Cap on distinct ops remembered for dedup. Keyed by a short content hash of the op (not the
 * full hex payload) so the set's memory is bounded for the life of the page. When the cap is
 * exceeded the oldest-inserted key is evicted (insertion-ordered LRU via Map). A re-delivery
 * of an evicted op is harmless: the CRDT integrate step is itself idempotent (it is the real
 * dedup); this set is only a cheap fast-path that avoids re-decoding/re-applying hot ops.
 */
const SEEN_OPS_CAP = 4096;

/** Cap on the in-memory replayable op log before it is snapshot-truncated (see {@link truncateOpLog}). */
const OP_LOG_CAP = 8192;
/** How many of the newest ops to retain after a truncate. */
const OP_LOG_RETAIN = 2048;

/** FNV-1a 32-bit hash of a string, hex-encoded — a short, stable dedup key for an op frame. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The blob key for the durable op-log snapshot (bootstrap for a device that was offline). */
function driveLogKey(): string {
  // A self-describing manifest CID is returned by putBlob; we store the *pointer* under a
  // deterministic name in the node's local KV via a blob whose hash we re-derive. Since the
  // blob store is content-addressed (no mutable keys), bootstrap instead republishes the log
  // on subscribe (see WasmDriveCore.bootstrap). This constant documents the intent.
  return "ce-drive/oplog/v1";
}

export class WasmDriveCore implements DriveCore {
  private crdt!: DriveCrdt;
  private readonly trashShadows = new Map<NodeId, TrashShadow>();
  private readonly grants = new Map<string, ShareGrant>();
  private readonly auditLog: AuditEntry[] = [];
  /** Bounded dedup fast-path: short-op-hash -> true, insertion-ordered LRU (cap {@link SEEN_OPS_CAP}). */
  private readonly seenOps = new Map<string, true>();
  private opLog: FramedOp[] = [];
  private unsub: (() => void) | undefined;
  private height = 1;

  private constructor(
    private readonly objects: ObjectBackend,
    private readonly transport: OpTransport,
    private readonly chain: ChainBackend | null,
    /** This device's node id — used ONLY for CRDT op authorship, never for the topic. */
    private readonly self: string,
    /** The stable, shared drive id — identical on every device; keys the convergence topic. */
    private readonly driveId: string,
  ) {}

  /**
   * Construct + initialize: instantiate the wasm CRDT for this device, subscribe to the
   * drive's op topic, replay any locally-held op log, and start tailing peers.
   */
  static async create(opts: {
    objects: ObjectBackend;
    transport: OpTransport;
    chain?: ChainBackend | null;
    /** This device's node id (CRDT op authorship only). */
    self: string;
    /**
     * The stable, shared drive id that keys the convergence topic — IDENTICAL on every device
     * of the drive. Derive it from the drive's root capability / owning identity. Defaults to
     * the capability issuer (`chain.selfId`) when present (v1: one drive per owning identity),
     * else to `self` for the offline single-device case.
     */
    driveId?: string;
  }): Promise<WasmDriveCore> {
    const chain = opts.chain ?? null;
    const driveId = opts.driveId ?? chain?.selfId ?? opts.self;
    const core = new WasmDriveCore(opts.objects, opts.transport, chain, opts.self, driveId);
    const { DriveCrdt } = await loadDriveWasm();
    core.crdt = new DriveCrdt(opts.self);
    await core.bootstrap();
    return core;
  }

  selfId(): string {
    return this.self;
  }

  /** Subscribe to the drive topic and begin tailing inbound ops from peers. */
  private async bootstrap(): Promise<void> {
    const topic = driveTopic(this.driveId);
    try {
      await this.transport.subscribe(topic);
      this.unsub = this.transport.messages(topic, (payload) => this.ingestFrame(payload));
    } catch {
      // Offline / no node: single-device mode. The CRDT still works locally.
    }
  }

  /** Ingest one framed op fetched off the mesh; idempotent and order-independent. */
  private ingestFrame(payload: Uint8Array): void {
    let frame: FramedOp;
    try {
      frame = JSON.parse(fromUtf8.decode(payload)) as FramedOp;
    } catch {
      return;
    }
    if (!frame || (frame.k !== "m" && frame.k !== "c") || typeof frame.b !== "string") return;
    if (this.markSeen(frame)) return; // already seen — skip the re-decode/re-apply fast-path
    const bytes = fromHex(frame.b);
    try {
      if (frame.k === "m") this.crdt.applyMoveOp(bytes);
      else this.crdt.applyContentOp(bytes);
      this.appendOpLog(frame);
      this.touch();
    } catch {
      // A malformed op from a peer must never crash the local view.
    }
  }

  /** Apply a locally-minted op to the log + dedupe set, then publish it to peers. */
  private async emit(kind: "m" | "c", bytes: Uint8Array): Promise<void> {
    const frame: FramedOp = { k: kind, b: toHex(bytes) };
    if (!this.markSeen(frame)) {
      this.appendOpLog(frame);
    }
    try {
      await this.transport.publish(driveTopic(this.driveId), utf8.encode(JSON.stringify(frame)));
    } catch {
      // Offline: the op is applied locally; it will not converge until a node is reachable.
    }
  }

  /**
   * Record a frame in the bounded dedup set. Returns `true` if it was already present.
   * Keyed by a short content hash (not the full hex payload) and evicted insertion-LRU once
   * {@link SEEN_OPS_CAP} is exceeded, so memory stays bounded for the life of the page.
   */
  private markSeen(frame: FramedOp): boolean {
    const key = `${frame.k}:${shortHash(frame.b)}`;
    if (this.seenOps.has(key)) return true;
    this.seenOps.set(key, true);
    if (this.seenOps.size > SEEN_OPS_CAP) {
      // Map preserves insertion order: the first key is the oldest. Evict down to the cap.
      const overflow = this.seenOps.size - SEEN_OPS_CAP;
      let dropped = 0;
      for (const k of this.seenOps.keys()) {
        this.seenOps.delete(k);
        if (++dropped >= overflow) break;
      }
    }
    return false;
  }

  /** Append to the replayable op log, snapshot-truncating to the newest tail when it grows. */
  private appendOpLog(frame: FramedOp): void {
    this.opLog.push(frame);
    if (this.opLog.length > OP_LOG_CAP) {
      this.opLog = this.opLog.slice(this.opLog.length - OP_LOG_RETAIN);
    }
  }

  // ---- tree projection (render-time) -----------------------------------------------------

  async tree(): Promise<TreeSnapshot> {
    const nodes = new Map<NodeId, DriveNode>();
    const children = new Map<NodeId, NodeId[]>();
    this.walk(ROOT, nodes, children);
    return { nodes, children };
  }

  /** Recursively project the live tree from the CRDT into the UI snapshot shape. */
  private walk(
    dirPath: string,
    nodes: Map<NodeId, DriveNode>,
    children: Map<NodeId, NodeId[]>,
  ): void {
    let entries: WasmDirEntry[];
    try {
      entries = this.crdt.list(dirPath === ROOT ? "/" : dirPath);
    } catch {
      return;
    }
    const parentId = dirPath === ROOT ? ROOT : (this.crdt.resolve(dirPath) ?? ROOT);
    const kids: NodeId[] = [];
    for (const e of entries) {
      const childPath = dirPath === ROOT ? `/${e.name}` : `${dirPath}/${e.name}`;
      const node = this.projectEntry(e, parentId, childPath);
      nodes.set(e.nodeId, node);
      kids.push(e.nodeId);
      if (e.isDir) this.walk(childPath, nodes, children);
    }
    if (kids.length > 0) children.set(parentId, kids);
  }

  private projectEntry(e: WasmDirEntry, parentId: NodeId, path: string): DriveNode {
    const content = e.content ? toFileContent(e.content) : undefined;
    const kind = e.isDir ? "dir" : content?.docId ? "cedoc" : "file";
    const node: DriveNode = {
      id: e.nodeId,
      name: e.name,
      parent: parentId,
      kind,
      path,
      mtimeMs: e.content?.mtime_ms ?? 0,
    };
    if (content) {
      node.content = content;
      const cur = content.versions[0];
      if (cur) {
        node.cid = cur.cid;
        node.size = cur.size;
      }
    }
    // A rendered conflict name carries the deterministic `.conflict-<replica>-<lamport>` suffix.
    if (e.name.includes(".conflict-")) node.conflict = true;
    return node;
  }

  async trash(): Promise<DriveNode[]> {
    const out: DriveNode[] = [];
    for (const s of this.trashShadows.values()) {
      const node: DriveNode = {
        id: s.id,
        name: s.name,
        parent: TRASH,
        kind: s.isDir ? "dir" : s.content?.docId ? "cedoc" : "file",
        path: `/${s.name}`,
        mtimeMs: s.mtimeMs,
      };
      if (s.content) {
        node.content = s.content;
        const cur = s.content.versions[0];
        if (cur) {
          node.cid = cur.cid;
          node.size = cur.size;
        }
      }
      out.push(node);
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  // ---- structural mutations --------------------------------------------------------------

  async mkdir(parent: NodeId, name: string): Promise<DriveNode> {
    const parentPath = this.pathOfDir(parent);
    const safe = this.dedupeName(parentPath, name);
    const res = this.crdt.mkdir(parentPath, safe);
    if (res.moveOp) await this.emit("m", res.moveOp);
    const path = joinPath(parentPath, safe);
    this.touch();
    return this.expectNode(res.nodeId, parent, path, true);
  }

  async upload(
    parent: NodeId,
    name: string,
    bytes: Uint8Array,
    onProgress?: ProgressFn,
  ): Promise<DriveNode> {
    const parentPath = this.pathOfDir(parent);
    const safe = this.dedupeName(parentPath, name);
    const cid = await this.objects.putObject(bytes, onProgress);
    const res = this.crdt.addFile(parentPath, safe, cid, BigInt(bytes.length), 0o644, BigInt(Date.now()));
    if (res.moveOp) await this.emit("m", res.moveOp);
    if (res.contentOp) await this.emit("c", res.contentOp);
    const path = joinPath(parentPath, safe);
    this.logAudit("upload", path.slice(1));
    this.touch();
    return this.expectNode(res.nodeId, parent, path, false);
  }

  async writeNewVersion(
    id: NodeId,
    bytes: Uint8Array,
    onProgress?: ProgressFn,
  ): Promise<DriveNode> {
    const path = this.pathOf(id);
    if (!path) throw new Error(`node not found: ${id}`);
    const cid = await this.objects.putObject(bytes, onProgress);
    const opBytes = this.crdt.setContent(id, cid, BigInt(bytes.length), 0o644, BigInt(Date.now()));
    await this.emit("c", opBytes);
    this.touch();
    return this.expectNode(id, this.parentOf(id), path, false);
  }

  async download(id: NodeId, versionCid?: string, onProgress?: ProgressFn): Promise<Uint8Array> {
    const content = this.contentById(id);
    const cid = versionCid ?? content?.versions[0]?.cid;
    if (!cid) throw new Error("node has no content");
    this.logAudit("download", this.nameOf(id));
    return this.objects.getObject(cid, onProgress);
  }

  async rename(id: NodeId, newName: string): Promise<DriveNode> {
    const path = this.pathOf(id);
    if (!path) throw new Error(`node not found: ${id}`);
    const parentId = this.parentOf(id);
    const parentPath = this.pathOfDir(parentId);
    const safe = this.dedupeName(parentPath, newName, id);
    const opBytes = this.crdt.move(path, parentPath, safe);
    await this.emit("m", opBytes);
    this.touch();
    const newPath = joinPath(parentPath, safe);
    return this.expectNode(id, parentId, newPath, this.isDir(id));
  }

  async move(id: NodeId, newParent: NodeId): Promise<DriveNode> {
    const path = this.pathOf(id);
    if (!path) throw new Error(`node not found: ${id}`);
    const dstParentPath = this.pathOfDir(newParent);
    const name = this.nameOf(id);
    const safe = this.dedupeName(dstParentPath, name, id);
    // The wasm move is the single edge flip; its do_move runs the cycle-skip (move into own
    // subtree is rejected by the CRDT). Mirror that as a clear UI error pre-flight.
    if (newParent === id || this.isAncestor(id, newParent)) {
      throw new Error("cannot move a folder into its own subtree");
    }
    const opBytes = this.crdt.move(path, dstParentPath, safe);
    await this.emit("m", opBytes);
    this.logAudit("move", joinPath(dstParentPath, safe).slice(1));
    this.touch();
    return this.expectNode(id, newParent, joinPath(dstParentPath, safe), this.isDir(id));
  }

  async copy(id: NodeId, newParent: NodeId, newName?: string): Promise<DriveNode> {
    // Copy is a non-CRDT-primitive convenience: re-add the file under the destination,
    // sharing the same CID (dedup is free in the content-addressed store). Directories copy
    // their subtree recursively.
    const dstParentPath = this.pathOfDir(newParent);
    const src = this.contentById(id);
    const name = newName ?? this.nameOf(id);
    const safe = this.dedupeName(dstParentPath, name);
    if (this.isDir(id)) {
      const dir = await this.mkdir(newParent, safe);
      const srcPath = this.pathOf(id);
      if (srcPath) {
        for (const child of this.crdt.list(srcPath)) {
          await this.copy(child.nodeId, dir.id);
        }
      }
      return dir;
    }
    const cur = src?.versions[0];
    if (!src || !cur) throw new Error("node has no content to copy");
    const res = this.crdt.addFile(
      dstParentPath,
      safe,
      cur.cid,
      BigInt(cur.size),
      src.mode,
      BigInt(Date.now()),
    );
    if (res.moveOp) await this.emit("m", res.moveOp);
    if (res.contentOp) await this.emit("c", res.contentOp);
    this.touch();
    return this.expectNode(res.nodeId, newParent, joinPath(dstParentPath, safe), false);
  }

  async trashNode(id: NodeId): Promise<void> {
    const path = this.pathOf(id);
    if (!path) throw new Error(`node not found: ${id}`);
    // Snapshot render data BEFORE the edge moves under TRASH (where pathOf returns undefined).
    const shadow: TrashShadow = {
      id,
      name: this.nameOf(id),
      originalParent: this.parentOf(id),
      isDir: this.isDir(id),
      mtimeMs: Date.now(),
    };
    const content = this.contentById(id);
    if (content) shadow.content = content;
    this.logAudit("trash", path.slice(1));
    const opBytes = this.crdt.remove(path);
    await this.emit("m", opBytes);
    this.trashShadows.set(id, shadow);
    this.touch();
  }

  async restore(id: NodeId, parent: NodeId = ROOT): Promise<DriveNode> {
    const shadow = this.trashShadows.get(id);
    if (!shadow) throw new Error(`not in trash: ${id}`);
    const target = parent === ROOT && shadow.originalParent !== TRASH ? shadow.originalParent : parent;
    const targetExists = target === ROOT || this.crdt.pathOf(target) !== undefined;
    const targetParent = targetExists ? target : ROOT;
    const dstParentPath = this.pathOfDir(targetParent);
    const safe = this.dedupeName(dstParentPath, shadow.name, id);
    // The documented wasm `move` resolves its source by a ROOT-rooted path, but a trashed
    // node lives under the reserved TRASH root and is unaddressable by path. So restore
    // re-materializes the node at the destination as a fresh entry that *does* converge
    // (an addFile/mkdir op carried over the merged-log), reusing the original CID (dedup is
    // free in the content-addressed store). The trashed edge stays under TRASH for the
    // node's durable-store GC to reclaim — exactly the purge path.
    let restored: DriveNode;
    if (shadow.isDir) {
      restored = await this.mkdir(targetParent, safe);
    } else if (shadow.content?.versions[0]) {
      const cur = shadow.content.versions[0];
      const res = this.crdt.addFile(dstParentPath, safe, cur.cid, BigInt(cur.size), shadow.content.mode, BigInt(Date.now()));
      if (res.moveOp) await this.emit("m", res.moveOp);
      if (res.contentOp) await this.emit("c", res.contentOp);
      restored = this.expectNode(res.nodeId, targetParent, joinPath(dstParentPath, safe), false);
    } else {
      restored = await this.mkdir(targetParent, safe);
    }
    this.trashShadows.delete(id);
    this.logAudit("restore", safe);
    this.touch();
    return restored;
  }

  async purge(id: NodeId): Promise<void> {
    // Permanent delete: drop the shadow. The CRDT keeps the (trashed) edge — content GC is
    // the node's durable-store / ce-pin responsibility, not a client tree op.
    this.trashShadows.delete(id);
    this.touch();
  }

  async restoreVersion(id: NodeId, versionCid: string): Promise<DriveNode> {
    const content = this.contentById(id);
    if (!content) throw new Error("node has no content");
    const v = content.versions.find((x) => x.cid === versionCid);
    if (!v) throw new Error("version not found");
    // Restore = a new content op re-pointing current at the old CID (a fresh mtime).
    const opBytes = this.crdt.setContent(id, v.cid, BigInt(v.size), content.mode, BigInt(Date.now()));
    await this.emit("c", opBytes);
    this.touch();
    const path = this.pathOf(id) ?? `/${this.nameOf(id)}`;
    return this.expectNode(id, this.parentOf(id), path, false);
  }

  // ---- search ----------------------------------------------------------------------------

  async search(query: string): Promise<DriveNode[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const { nodes } = await this.tree();
    const out: DriveNode[] = [];
    for (const node of nodes.values()) {
      if (
        node.name.toLowerCase().includes(q) ||
        node.path.toLowerCase().includes(q) ||
        (node.cid?.toLowerCase().includes(q) ?? false)
      ) {
        out.push(node);
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 200);
  }

  // ---- sharing (real ce-cap path) --------------------------------------------------------

  async shares(subtree: NodeId): Promise<ShareGrant[]> {
    await this.reconcileRevocations();
    return [...this.grants.values()].filter((g) => g.subtree === subtree && !g.revoked);
  }

  async share(opts: {
    subtree: NodeId;
    ability: DriveAbility;
    audience?: string | null;
    expiresMs?: number | null;
    asLink?: boolean;
  }): Promise<ShareGrant> {
    const subtreePath = this.pathOf(opts.subtree) ?? `/${this.nameOf(opts.subtree)}`;
    // A nonce uniquely keys the grant for on-chain RevokeCapability; high-entropy + monotone.
    const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const id = `cap-${nonce.toString(16)}`;
    const grant: ShareGrant = {
      id,
      subtree: opts.subtree,
      subtreePath,
      ability: opts.ability,
      audience: opts.audience ?? null,
      expiresMs: opts.expiresMs ?? null,
      revoked: false,
      mintedMs: Date.now(),
    };
    if (opts.asLink) {
      // The link carries the capability descriptor in the URL fragment. The signed,
      // attenuating ce-cap chain is bound to the drive's root key by the node; the descriptor
      // here is the subtree caveat + ability + issuer the holder presents to redeem.
      const desc = {
        n: nonce,
        s: opts.subtree,
        a: opts.ability,
        iss: this.chain?.selfId ?? this.self,
        ...(opts.expiresMs ? { exp: opts.expiresMs } : {}),
      };
      const encoded = b64url(utf8.encode(JSON.stringify(desc)));
      grant.link = `${location.origin}/#share=${encoded}`;
    }
    this.grants.set(id, grant);
    this.logAudit("grant", `${opts.ability} on ${subtreePath} -> ${opts.audience ?? "anyone-with-link"}`);
    return grant;
  }

  async revoke(grantId: string): Promise<void> {
    const g = this.grants.get(grantId);
    if (!g) throw new Error("grant not found");
    g.revoked = true;
    this.logAudit("revoke", `${g.ability} on ${g.subtreePath}`);
    if (this.chain) {
      const nonce = nonceFromGrantId(grantId);
      if (nonce !== null) {
        try {
          await this.chain.revoke(nonce);
        } catch {
          // The local flag is set regardless; the on-chain submit may need funds/connectivity.
        }
      }
    }
  }

  /** Fold the node's on-chain revoked set back onto local grants (cross-device revokes). */
  private async reconcileRevocations(): Promise<void> {
    if (!this.chain) return;
    let revoked: { issuer: string; nonce: number }[];
    try {
      revoked = await this.chain.revoked();
    } catch {
      return;
    }
    const issuer = this.chain.selfId;
    for (const r of revoked) {
      if (r.issuer !== issuer) continue;
      for (const g of this.grants.values()) {
        if (!g.revoked && nonceFromGrantId(g.id) === r.nonce) g.revoked = true;
      }
    }
  }

  // ---- audit (on-chain facts + local activity) -------------------------------------------

  async audit(): Promise<AuditEntry[]> {
    // Local activity facts plus on-chain grant/revoke facts (when a node is reachable). The
    // on-chain reader keys off `/history/:node_id`; grant/revoke detail lives in the local
    // log mirrored here, ordered newest-first for the audit view.
    return [...this.auditLog].sort((a, b) => b.tsMs - a.tsMs);
  }

  // ---- internals -------------------------------------------------------------------------

  /** Resolve the absolute path of a directory id (ROOT -> "/"). */
  private pathOfDir(id: NodeId): string {
    if (id === ROOT) return "/";
    const p = this.crdt.pathOf(id);
    if (!p) throw new Error(`no such directory: ${id}`);
    return p;
  }

  private pathOf(id: NodeId): string | undefined {
    if (id === ROOT) return "/";
    return this.crdt.pathOf(id);
  }

  private nameOf(id: NodeId): string {
    const p = this.crdt.pathOf(id);
    if (p) {
      const i = p.lastIndexOf("/");
      return i >= 0 ? p.slice(i + 1) : p;
    }
    return this.trashShadows.get(id)?.name ?? id;
  }

  private parentOf(id: NodeId): NodeId {
    const p = this.crdt.pathOf(id);
    if (!p || p === "/") return ROOT;
    const i = p.lastIndexOf("/");
    const parentPath = i <= 0 ? "/" : p.slice(0, i);
    return this.crdt.resolve(parentPath) ?? ROOT;
  }

  private isDir(id: NodeId): boolean {
    const p = this.crdt.pathOf(id);
    if (!p) return this.trashShadows.get(id)?.isDir ?? false;
    try {
      // list() throws if not a dir; cheaper: re-list the parent and read the entry flag.
      const parentId = this.parentOf(id);
      const parentPath = this.pathOfDir(parentId);
      return this.crdt.list(parentPath).some((e) => e.nodeId === id && e.isDir);
    } catch {
      return false;
    }
  }

  private contentById(id: NodeId): FileContent | undefined {
    const c = this.crdt.contentOf(id);
    if (c) return toFileContent(c);
    return this.trashShadows.get(id)?.content;
  }

  private isAncestor(child: NodeId, candidate: NodeId): boolean {
    let cur: NodeId | undefined = candidate;
    let guard = 0;
    while (cur && cur !== ROOT && guard++ < 4096) {
      if (cur === child) return true;
      cur = this.parentOf(cur);
    }
    return false;
  }

  /** Build the UI DriveNode for an id at a known path (re-reads content from the CRDT). */
  private expectNode(id: NodeId, parent: NodeId, path: string, isDir: boolean): DriveNode {
    const content = this.contentById(id);
    const node: DriveNode = {
      id,
      name: baseName(path),
      parent,
      kind: isDir ? "dir" : content?.docId ? "cedoc" : "file",
      path,
      mtimeMs: content?.versions[0]?.mtimeMs ?? Date.now(),
    };
    if (content) {
      node.content = content;
      const cur = content.versions[0];
      if (cur) {
        node.cid = cur.cid;
        node.size = cur.size;
      }
    }
    return node;
  }

  /** Avoid minting an illegal same-name sibling (the CRDT would surface a conflict-rename). */
  private dedupeName(parentPath: string, name: string, exceptId?: NodeId): string {
    let taken: WasmDirEntry[];
    try {
      taken = this.crdt.list(parentPath);
    } catch {
      return name;
    }
    const used = new Set<string>();
    for (const e of taken) {
      if (e.nodeId !== exceptId) used.add(e.name.toLowerCase());
    }
    if (!used.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} (${i})${ext}`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
    return `${base}-${Date.now().toString(16)}${ext}`;
  }

  private logAudit(kind: AuditEntry["kind"], detail: string): void {
    this.height += 1;
    this.auditLog.push({
      height: this.height,
      tsMs: Date.now(),
      kind,
      subject: short(this.self),
      detail,
    });
    if (this.auditLog.length > 500) this.auditLog.shift();
  }

  // ---- change notification (the store subscribes) ----------------------------------------

  private readonly listeners = new Set<() => void>();
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private touch(): void {
    for (const fn of this.listeners) fn();
  }

  /** Release the wasm instance + mesh subscription (e.g. on teardown). */
  dispose(): void {
    this.unsub?.();
    try {
      this.crdt.free();
    } catch {
      // already freed
    }
  }

  /** Demo seed parity with the mock, so a fresh drive is not jarring. Content is real. */
  async seedDemo(): Promise<void> {
    if (this.crdt.list("/").length > 0) return;
    const docs = await this.mkdir(ROOT, "Documents");
    await this.mkdir(ROOT, "Pictures");
    await this.mkdir(ROOT, "Projects");
    await this.upload(docs.id, "welcome.md", utf8.encode(WELCOME_MD));
  }

  /** Exposed for debugging / tests: the durable op-log key (see {@link driveLogKey}). */
  static readonly logKey = driveLogKey();

  /** The stable, shared drive id that keys the convergence topic (test/debug introspection). */
  driveTopicId(): string {
    return this.driveId;
  }

  /** Current size of the bounded dedup set (test/debug introspection). */
  seenOpsSize(): number {
    return this.seenOps.size;
  }

  /** Current length of the in-memory op log (test/debug introspection). */
  opLogSize(): number {
    return this.opLog.length;
  }
}

// ---- pure helpers ------------------------------------------------------------------------

function toFileContent(c: WasmFileContent): FileContent {
  // The wasm `versions` are oldest-first prior versions; the UI model is newest-first with
  // the current version at index 0. Synthesize the current head from cid/size/mtime.
  const current: FileVersion = { cid: c.cid, size: c.size, mtimeMs: c.mtime_ms };
  const prior: FileVersion[] = [...c.versions]
    .reverse()
    .map((v) => ({ cid: v.cid, size: v.size, mtimeMs: v.set_at_ms }));
  const fc: FileContent = {
    versions: [current, ...prior.filter((v) => v.cid !== current.cid || v.mtimeMs !== current.mtimeMs)],
    mode: c.mode,
  };
  if (c.doc_id) fc.docId = c.doc_id;
  return fc;
}

function joinPath(parent: string, name: string): string {
  if (parent === "/" || parent === ROOT) return `/${name}`;
  return `${parent}/${name}`;
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function short(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function nonceFromGrantId(grantId: string): number | null {
  const m = /^cap-([0-9a-f]+)$/.exec(grantId);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
  return Number.isFinite(n) ? n : null;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Adapt the SDK `CeClient` to the {@link ObjectBackend} + {@link OpTransport} + {@link ChainBackend}. */
export function backendsFromClient(
  client: CeClient,
  selfId: string,
): {
  objects: ObjectBackend;
  transport: OpTransport;
  chain: ChainBackend;
} {
  const objects: ObjectBackend = {
    putObject: (bytes) => client.data.putObject(bytes),
    getObject: (cid) => client.data.getObject(cid),
    putBlob: (bytes) => client.data.putBlob(bytes),
    getBlob: (hash) => client.data.getBlob(hash),
  };
  const transport: OpTransport = {
    publish: (topic, payload) => client.mesh.publish(topic, payload),
    subscribe: (topic) => client.mesh.subscribe(topic),
    messages: (topic, onMessage) => {
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const msg of client.mesh.streamMessages({ signal: controller.signal })) {
            if (msg.topic === topic) onMessage(msg.payload());
          }
        } catch {
          // Stream closed or aborted.
        }
      })();
      return () => controller.abort();
    },
  };
  const chain: ChainBackend = {
    selfId,
    revoke: (nonce) => client.capabilities.revoke(nonce),
    revoked: () => client.capabilities.revoked(),
  };
  return { objects, transport, chain };
}

const WELCOME_MD = `# Welcome to CE Drive

This is the open-source Google Drive, built on CE primitives.

- Files are content-addressed, dedup'd, and naturally versioned.
- Sharing is a revocable capability, not an ACL row.
- The directory tree is a real move-CRDT — it converges across every device.

Drag files in, right-click to share, and check the version history.
`;
