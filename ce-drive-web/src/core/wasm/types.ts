/**
 * The TypeScript surface of `ce-drive-wasm` (the `DriveCrdt` class wasm-bindgen exports),
 * declared here so {@link WasmDriveCore} can be typed and compiled even when the generated
 * `pkg/` is not present on disk (e.g. in CI before `wasm-pack build` has run).
 *
 * This MUST stay byte-faithful to `crates/ce-drive-wasm/ce_drive_wasm.d.ts`. The loader
 * (`load.ts`) imports the real generated module at runtime; this file is only the contract.
 */

/** A node's content metadata (NO file bytes). Mirrors `ce-drive-core`'s `FileContent`. */
export interface WasmFileContent {
  cid: string;
  size: number;
  mode: number;
  mtime_ms: number;
  versions: Array<{ set_at_ms: number; cid: string; size: number }>;
  doc_id: string | null;
}

/** One directory listing entry. */
export interface WasmDirEntry {
  name: string;
  nodeId: string;
  isDir: boolean;
  content: WasmFileContent | null;
}

/** A surfaced name collision within a directory. */
export interface WasmConflict {
  name: string;
  winner: string;
  loser: string;
  rendered: string;
}

/** The result of minting a structural op: the new node id plus the op bytes to publish. */
export interface WasmMintResult {
  nodeId: string;
  moveOp: Uint8Array | null;
  contentOp: Uint8Array | null;
}

/** The browser-side CRDT handle (see `ce_drive_wasm.d.ts`). */
export interface DriveCrdt {
  readonly replicaId: string;

  applyMoveOp(bytes: Uint8Array): boolean;
  applyMoveOps(ops: Uint8Array[]): number;
  applyContentOp(bytes: Uint8Array): boolean;
  applyContentOps(ops: Uint8Array[]): number;

  list(path: string): WasmDirEntry[];
  resolve(path: string): string | undefined;
  contentOf(nodeId: string): WasmFileContent | undefined;
  pathOf(nodeId: string): string | undefined;
  conflicts(path: string): WasmConflict[];
  allCids(): string[];
  moveOpCount(): number;
  contentCount(): number;

  mkdir(parentPath: string, name: string): WasmMintResult;
  /** NOTE: `size`/`mtimeMs` are `u64` on the Rust side -> wasm-bindgen requires `bigint`. */
  addFile(
    parentPath: string,
    name: string,
    cid: string,
    size: bigint,
    mode: number,
    mtimeMs: bigint,
  ): WasmMintResult;
  /** NOTE: `size`/`mtimeMs` are `u64` on the Rust side -> wasm-bindgen requires `bigint`. */
  setContent(
    nodeId: string,
    cid: string,
    size: bigint,
    mode: number,
    mtimeMs: bigint,
  ): Uint8Array;
  move(srcPath: string, dstParentPath: string, dstName: string): Uint8Array;
  remove(path: string): Uint8Array;

  free(): void;
}

/** Constructor shape the loader resolves from the generated module. */
export interface DriveCrdtCtor {
  new (replicaId: string): DriveCrdt;
}

/** What {@link loadDriveWasm} resolves to: the init'd module's `DriveCrdt` constructor. */
export interface DriveWasmModule {
  DriveCrdt: DriveCrdtCtor;
}
