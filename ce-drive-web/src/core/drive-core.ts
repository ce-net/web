/**
 * `DriveCore` — the clean TypeScript client interface mirroring ce-drive-core's surface.
 *
 * This is the single seam between the web app and the storage/CRDT core. Two adapters
 * satisfy it:
 *
 *   - `MockDriveCore` (mock-adapter.ts): an in-memory DriveTree backed by the @ce-net/sdk
 *     blob/object layer for *content*, with the tree CRDT + sharing simulated locally.
 *     Used until the ce-drive-core WASM bridge is wired.
 *   - (future) `WasmDriveCore`: ce-drive-core compiled to WASM, running in the browser CE
 *     node, doing the real Kleppmann move-CRDT, ce-cap minting, and E2E envelope.
 *
 * Both keep the *content* path identical: bytes are chunked → `put_blob` per chunk →
 * manifest blob, and downloaded by `get_object` with per-chunk CID verification, exactly
 * as the node's data layer specifies (§3.1). Only the tree/sharing logic differs, and that
 * difference is invisible to the UI because it is hidden behind this interface.
 *
 * Methods are intentionally close to ce-drive-core's Rust surface (tree.rs / content.rs /
 * store.rs / share.rs / audit.rs in PLAN/10-drive-fs.md §11) so the WASM bridge is a
 * drop-in: same verbs, same NodeId-keyed model.
 */

import type {
  AuditEntry,
  DriveAbility,
  DriveNode,
  NodeId,
  ShareGrant,
} from "./model.js";

/** Progress callback for chunked transfers: `(bytesDone, bytesTotal)`. */
export type ProgressFn = (done: number, total: number) => void;

/** A flat snapshot of the converged tree the UI renders from. */
export interface TreeSnapshot {
  /** All live nodes (excludes TRASH subtree), keyed by id. */
  nodes: Map<NodeId, DriveNode>;
  /** Children index: parent id -> ordered child ids (name-sorted, dirs first). */
  children: Map<NodeId, NodeId[]>;
}

/**
 * The core surface. Every structural mutation returns the converged snapshot so the UI can
 * re-render from a single source of truth (the move-CRDT, §4).
 */
export interface DriveCore {
  /** Short node id of the local identity (the writer in single-writer v1). */
  selfId(): string;

  /** Resolve the current converged tree (live nodes; TRASH excluded). */
  tree(): Promise<TreeSnapshot>;

  /** Resolve the contents of TRASH for the trash view (§4.4 delete = move to TRASH). */
  trash(): Promise<DriveNode[]>;

  /** Create an empty directory under `parent`. One `Move` out of limbo (§4.2). */
  mkdir(parent: NodeId, name: string): Promise<DriveNode>;

  /**
   * Upload bytes as a new file under `parent`: chunk → `put_blob` per chunk → manifest
   * (CID-verified), then a `Move` (structure) + content `Insert` (§3.1, §4.4). `onProgress`
   * reports chunk-upload progress.
   */
  upload(
    parent: NodeId,
    name: string,
    bytes: Uint8Array,
    onProgress?: ProgressFn,
  ): Promise<DriveNode>;

  /**
   * Write new bytes to an existing file: a content `Insert` keyed by the *same* NodeId, so
   * the structure (name/location) is untouched and a new version is appended (§3.3).
   */
  writeNewVersion(id: NodeId, bytes: Uint8Array, onProgress?: ProgressFn): Promise<DriveNode>;

  /**
   * Download a file's current (or a specific version's) bytes: `get_object` with per-chunk
   * CID verification (§3.1). `versionCid` selects a historical version.
   */
  download(id: NodeId, versionCid?: string, onProgress?: ProgressFn): Promise<Uint8Array>;

  /** Rename a node: a `Move` to the same parent with a new name (id stable, §4.4). */
  rename(id: NodeId, newName: string): Promise<DriveNode>;

  /**
   * Move a node under a new parent: a single O(1) edge flip; descendants follow because
   * path is derived (§4.4). Runs the cycle check (§4.2) — moving a dir into its own subtree
   * is rejected.
   */
  move(id: NodeId, newParent: NodeId): Promise<DriveNode>;

  /**
   * Copy a file: dedup is free because identical chunks share CIDs (§4.4 copy row). Returns
   * the new node. Copying a directory copies its subtree.
   */
  copy(id: NodeId, newParent: NodeId, newName?: string): Promise<DriveNode>;

  /** Trash a node: a `Move` into TRASH; content is retained until GC → undelete (§4.4). */
  trashNode(id: NodeId): Promise<void>;

  /** Restore a trashed node back to a live parent (or its original parent). */
  restore(id: NodeId, parent?: NodeId): Promise<DriveNode>;

  /** Permanently delete a trashed node (GC its content). */
  purge(id: NodeId): Promise<void>;

  /**
   * Restore a file to a historical version: point the node's content entry back at an old
   * CID — a new content op, not a structural one (§3.3).
   */
  restoreVersion(id: NodeId, versionCid: string): Promise<DriveNode>;

  /** Filename + metadata search over the tree (the §8.1 v1 instant local index). */
  search(query: string): Promise<DriveNode[]>;

  /** List the live sharing grants for a node's subtree (§5). */
  shares(subtree: NodeId): Promise<ShareGrant[]>;

  /**
   * Mint a sharing capability: an attenuating ce-cap grant scoped to `subtree`, optionally
   * to a specific `audience` and with an `expiresMs` (§5). `audience: null` mints an
   * "anyone with link" capability embedded in the returned grant's `link`.
   */
  share(opts: {
    subtree: NodeId;
    ability: DriveAbility;
    audience?: string | null;
    expiresMs?: number | null;
    asLink?: boolean;
  }): Promise<ShareGrant>;

  /** Revoke a grant on-chain (RevokeCapability) + expiry (§5). */
  revoke(grantId: string): Promise<void>;

  /** The audit-v1 view: on-chain grant/revoke facts + local activity (§10). */
  audit(): Promise<AuditEntry[]>;
}
