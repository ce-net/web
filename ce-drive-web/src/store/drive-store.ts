/**
 * DriveStore — the app's single state container.
 *
 * Holds the active {@link DriveCore} (the mock adapter today, the WASM bridge tomorrow),
 * the current folder, the selection, and the live tree snapshot. Views subscribe; mutations
 * go through the store so re-renders happen from one source of truth (the converged CRDT).
 */

import { CeClient, chunkObject, reassemble } from "@ce-net/sdk";
import type { DriveCore, TreeSnapshot } from "../core/drive-core.js";
import {
  MemoryBlobBackend,
  MockDriveCore,
  NodeBlobBackend,
  type BlobBackend,
} from "../core/mock-adapter.js";
import {
  backendsFromClient,
  WasmDriveCore,
  type ObjectBackend,
  type OpTransport,
} from "../core/wasm-adapter.js";
import { WasmNotBuiltError } from "../core/wasm/load.js";
import { ROOT, type NodeId } from "../core/model.js";

/** Whether the content backend is a live node or the offline in-memory fallback. */
export type Backend = "node" | "memory";

/** Which DriveCore implementation is active: the real wasm CRDT or the in-memory mock. */
export type CoreKind = "wasm" | "mock";

export interface ConnectionState {
  backend: Backend;
  /** Short node id of the local node, when connected. */
  nodeId?: string;
  /** Block height, when connected. */
  height?: number;
  /** The active DriveCore implementation. */
  core?: CoreKind;
}

/** Options accepted by {@link WasmDriveCore.create} (re-stated for the local `chain` typing). */
type WasmCoreOpts = Parameters<typeof WasmDriveCore.create>[0];

/** The mock store is opt-in: `?mock=1` or `localStorage.ceDriveMock=1`. Default is wasm. */
function useMock(): boolean {
  try {
    const url = new URL(location.href);
    if (url.searchParams.get("mock") === "1") return true;
    if (url.searchParams.get("wasm") === "0") return true;
    return localStorage.getItem("ceDriveMock") === "1";
  } catch {
    return false;
  }
}

/** A no-op op transport for offline single-device wasm (the CRDT still works locally). */
const NULL_TRANSPORT: OpTransport = {
  publish: async () => {},
  subscribe: async () => {},
  messages: () => () => {},
};

/** Wrap a {@link MemoryBlobBackend} as an {@link ObjectBackend} (chunk/reassemble in-memory). */
function memoryObjectBackend(mem: MemoryBlobBackend): ObjectBackend {
  return {
    putBlob: (b) => mem.putBlob(b),
    getBlob: (h) => mem.getBlob(h),
    async putObject(bytes) {
      const { manifest, chunks } = await chunkObject(bytes);
      for (const [, c] of chunks) await mem.putBlob(c);
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          kind: manifest.kind,
          chunk_size: manifest.chunkSize,
          total_size: manifest.totalSize,
          chunks: manifest.chunks,
        }),
      );
      return mem.putBlob(manifestBytes);
    },
    async getObject(cid) {
      const manifestBytes = await mem.getBlob(cid);
      try {
        const j = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
          kind?: string;
          chunk_size?: number;
          total_size?: number;
          chunks?: string[];
        };
        if (j.kind === "ce-object-v1" && Array.isArray(j.chunks)) {
          return reassemble(
            {
              kind: "ce-object-v1",
              chunkSize: j.chunk_size ?? 0,
              totalSize: j.total_size ?? 0,
              chunks: j.chunks,
            },
            (c) => mem.getBlob(c),
          );
        }
      } catch {
        // Not a manifest — fall through and return the raw blob.
      }
      return manifestBytes;
    },
  };
}

type Listener = () => void;

export class DriveStore {
  core!: DriveCore;
  snapshot: TreeSnapshot = { nodes: new Map(), children: new Map() };
  cwd: NodeId = ROOT;
  selection = new Set<NodeId>();
  connection: ConnectionState = { backend: "memory" };

  private readonly listeners = new Set<Listener>();

  /**
   * Initialize: probe a local CE node for the blob backend, else fall back to memory; then
   * construct the DriveCore (mock adapter) and seed a demo tree.
   *
   * In dev, `/ce` is proxied to `http://127.0.0.1:8844` (vite.config.ts) so the browser is
   * same-origin. In production behind a reverse proxy, the same `/ce` path resolves to the
   * local node. The node's read endpoints (`/blobs/:hash`) are unauthenticated; writes use
   * the discovered API token where available.
   */
  async init(): Promise<void> {
    const probe = await this.probeNode();
    let selfId: string;
    if (probe) {
      selfId = probe.nodeId;
      this.connection = {
        backend: "node",
        nodeId: short(probe.nodeId),
        height: probe.height,
        core: "wasm",
      };
    } else {
      selfId = "local-demo";
      this.connection = { backend: "memory", core: "wasm" };
    }

    // Default to the REAL ce-drive-wasm CRDT core. Fall back to the in-memory mock only when
    // explicitly requested (`?mock=1` / `localStorage.ceDriveMock`) or when the wasm bundle
    // is not built (a fresh checkout before `npm run build:wasm`) — never silently in prod.
    if (!useMock()) {
      try {
        const core = await this.initWasm(probe, selfId);
        this.core = core;
        await this.refresh();
        return;
      } catch (err) {
        if (err instanceof WasmNotBuiltError) {
          this.connection = { ...this.connection, core: "mock" };
          // Fall through to the mock so the app still runs without the wasm artifact.
        } else {
          throw err;
        }
      }
    } else {
      this.connection = { ...this.connection, core: "mock" };
    }

    await this.initMock(probe, selfId);
    await this.refresh();
  }

  /** Construct the production WasmDriveCore over the SDK (or offline single-device wasm). */
  private async initWasm(
    probe: { client: CeClient; nodeId: string } | null,
    selfId: string,
  ): Promise<WasmDriveCore> {
    let objects: ObjectBackend;
    let transport: OpTransport;
    let chain: WasmCoreOpts["chain"] = null;
    if (probe) {
      const b = backendsFromClient(probe.client, probe.nodeId);
      objects = b.objects;
      transport = b.transport;
      chain = b.chain;
    } else {
      // Offline: real content via an in-memory CID store, no op propagation (single device).
      const mem = new MemoryBlobBackend();
      objects = memoryObjectBackend(mem);
      transport = NULL_TRANSPORT;
    }
    const core = await WasmDriveCore.create({ objects, transport, chain, self: selfId });
    core.onChange(() => void this.refresh());
    await core.seedDemo();
    return core;
  }

  /** Construct the in-memory MockDriveCore (kept behind the flag / wasm-absent fallback). */
  private async initMock(
    probe: { client: CeClient } | null,
    selfId: string,
  ): Promise<void> {
    const blobs: BlobBackend = probe
      ? new NodeBlobBackend(probe.client.data)
      : new MemoryBlobBackend();
    const core = new MockDriveCore(blobs, selfId);
    core.onChange(() => void this.refresh());
    await core.seedDemo();
    this.core = core;
  }

  /** Try to reach a local node via the `/ce` proxy path. Returns null if unreachable. */
  private async probeNode(): Promise<{ client: CeClient; nodeId: string; height: number } | null> {
    try {
      // Same-origin proxy path; no token needed for `/status`.
      const client = CeClient.withToken(`${location.origin}/ce`);
      const status = (await Promise.race([
        client.getStatus(),
        timeout(1500),
      ])) as Awaited<ReturnType<CeClient["getStatus"]>>;
      return { client, nodeId: status.nodeId, height: status.height };
    } catch {
      return null;
    }
  }

  /** Re-resolve the converged tree from the core and notify subscribers. */
  async refresh(): Promise<void> {
    this.snapshot = await this.core.tree();
    // Drop selections / cwd that no longer exist (e.g. after trash/purge).
    if (this.cwd !== ROOT && !this.snapshot.nodes.has(this.cwd)) this.cwd = ROOT;
    for (const id of [...this.selection]) {
      if (!this.snapshot.nodes.has(id)) this.selection.delete(id);
    }
    this.emit();
  }

  /** Children of the current working directory, ordered (dirs first, name-sorted). */
  currentChildren(): NodeId[] {
    return this.snapshot.children.get(this.cwd) ?? [];
  }

  /** The breadcrumb chain from ROOT to cwd. */
  breadcrumb(): { id: NodeId; name: string }[] {
    const chain: { id: NodeId; name: string }[] = [{ id: ROOT, name: "My Drive" }];
    const parts: { id: NodeId; name: string }[] = [];
    let cur = this.snapshot.nodes.get(this.cwd);
    let guard = 0;
    while (cur && guard++ < 4096) {
      parts.unshift({ id: cur.id, name: cur.name });
      const parent = this.snapshot.nodes.get(cur.parent);
      if (!parent) break;
      cur = parent;
    }
    return [...chain, ...parts];
  }

  navigate(id: NodeId): void {
    this.cwd = id;
    this.selection.clear();
    this.emit();
  }

  select(id: NodeId, additive = false): void {
    if (!additive) this.selection.clear();
    if (this.selection.has(id) && additive) this.selection.delete(id);
    else this.selection.add(id);
    this.emit();
  }

  clearSelection(): void {
    this.selection.clear();
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Force a re-render without re-resolving the tree (e.g. sidebar expand/collapse). */
  subscribeNotify(): void {
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}
