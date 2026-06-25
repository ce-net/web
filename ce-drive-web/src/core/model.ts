/**
 * The DriveTree model — the data shapes ce-drive-core owns, mirrored 1:1 in TypeScript.
 *
 * This module defines NO behavior, only the wire/model types. It is the contract the web
 * app renders against. The real implementations of these shapes live in ce-drive-core
 * (PLAN/10-drive-fs.md §4) and reach the browser two ways:
 *
 *   1. ce-drive-core compiled to WASM (the tree CRDT + envelope), running in the browser
 *      CE node — the production path.
 *   2. a thin in-memory mock adapter (mock-adapter.ts) that satisfies the same
 *      {@link DriveCore} interface, used until the WASM bridge is wired.
 *
 * Per §4: every tree node has a *stable* `NodeId`; edges are `(child -> {parent, name})`;
 * a path is *derived* by walking parent pointers and is never stored as identity. Content
 * is keyed by NodeId (orthogonal to structure) so rename/move never collides with a byte
 * edit. Every structural mutation is a single `Move` (create/delete/rename/move-dir).
 */

/** A stable, globally-unique node identifier (opaque). Never a path. */
export type NodeId = string;

/** Content id — a sha256 hex digest, the key into the node's `/blobs` store. */
export type Cid = string;

/** The reserved roots of the tree. */
export const ROOT: NodeId = "ROOT";
export const TRASH: NodeId = "TRASH";

/** What a node *is*: a directory, a regular file, or an embedded collaborative doc. */
export type NodeKind = "dir" | "file" | "cedoc";

/**
 * One version of a file's bytes. Immutability of the block store means every save
 * produces a new {@link Cid}; old CIDs stay valid, so the version list is free (§3.3).
 */
export interface FileVersion {
  /** The object CID (manifest hash) for this version's bytes. */
  cid: Cid;
  /** Total byte size of this version. */
  size: number;
  /** Wall-clock save time, ms since epoch. */
  mtimeMs: number;
  /** Who wrote it (short node id), for the version-history panel. Optional. */
  author?: string;
}

/**
 * Content map entry (the §4.4 "collection B"), keyed by stable NodeId. `versions[0]` is
 * the current version. For a `.cedoc`, `docId` points at an embedded ce-notes document
 * instead of (or alongside) a blob CID (§6).
 */
export interface FileContent {
  /** Ordered newest-first version list; `versions[0]` is current. */
  versions: FileVersion[];
  /** POSIX-ish mode bits (rendered, not enforced in the browser). */
  mode: number;
  /** Embedded ce-notes document id for a `.cedoc` node (§6). Optional. */
  docId?: string;
}

/**
 * A resolved tree node as the UI consumes it. This is a *render-time projection* of the
 * converged CRDT (edges + content map), not a stored record. `path` is derived.
 */
export interface DriveNode {
  id: NodeId;
  /** The node's name within its parent directory. */
  name: string;
  /** Parent node id (ROOT/TRASH or a dir). */
  parent: NodeId;
  kind: NodeKind;
  /** Derived absolute path (`/docs/report.md`); a pure function of the edge set. */
  path: string;
  /** Current content CID for a file/cedoc, if any. */
  cid?: Cid;
  /** Current size in bytes for a file/cedoc. */
  size?: number;
  /** Last-modified time, ms since epoch. */
  mtimeMs: number;
  /** Full content record (version list, mode, docId) for files/cedocs. */
  content?: FileContent;
  /**
   * True when this node is a deterministic conflict-rename projection of a name collision
   * (§4.5): the CRDT legitimately holds two ids with the same name; the loser is surfaced
   * as `name.conflict-<replica>-<ts>`, never hidden.
   */
  conflict?: boolean;
}

/**
 * A single move operation — the *one* op type of the move-CRDT (§4.2). Create = move a
 * fresh node out of limbo; delete = move into TRASH; rename = move to the same parent with
 * a new name; move-dir = one O(1) edge flip. `oldParent`/`oldName` are the recorded
 * undo-data (dormant in single-writer v1, §4.6) — the op's exact inverse for the
 * undo/do/redo convergence procedure.
 */
export interface MoveOp {
  /** Total-order key: (lamport, replica) rendered as a comparable string. */
  ts: string;
  child: NodeId;
  newParent: NodeId;
  newName: string;
  /** Undo-data: the edge this move displaced (recorded, dormant in v1). */
  oldParent?: NodeId;
  oldName?: string;
}

/** An on-chain capability grant/revoke fact, as the audit-v1 view reads them (§10). */
export interface AuditEntry {
  /** Block height the fact was recorded at (monotone, tamper-evident). */
  height: number;
  /** Wall-clock time of the fact, ms since epoch. */
  tsMs: number;
  kind: "grant" | "revoke" | "upload" | "download" | "move" | "trash" | "restore";
  /** Short subject node id (the grantee, or the actor). */
  subject: string;
  /** The ability/path the fact concerns, human-rendered. */
  detail: string;
}

/** The abilities a Drive capability can carry (opaque strings on the wire, §5). */
export type DriveAbility = "drive:read" | "drive:comment" | "drive:write" | "drive:admin";

/**
 * A minted sharing capability — an attenuating, revocable ce-cap chain scoped to a
 * subtree (§5). The browser holds the *rendered* shape; the actual signed chain is minted
 * by ce-drive-core / the node (see TODO in share.ts).
 */
export interface ShareGrant {
  /** Local handle for the grant (and the on-chain revocation nonce key). */
  id: string;
  /** The subtree root this grant is scoped to (a `subtree:<NodeId>` caveat). */
  subtree: NodeId;
  /** Path of the subtree at mint time (for display). */
  subtreePath: string;
  ability: DriveAbility;
  /** Grantee node id, or `null` for an "anyone with link" capability. */
  audience: string | null;
  /** Expiry, ms since epoch, or `null` for no expiry. */
  expiresMs: number | null;
  /** A share link carrying the capability in its URL fragment, if link-style. */
  link?: string;
  /** True once revoked on-chain (RevokeCapability) — kept for the audit trail. */
  revoked: boolean;
  /** When the grant was minted, ms since epoch. */
  mintedMs: number;
}
