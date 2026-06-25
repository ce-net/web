/**
 * BoardService — the bridge between @ce-net/sdk and the ce-board UI.
 *
 * It owns the data path: subscribing to the board's ops topic, publishing local ops,
 * folding inbound ops into the materialized {@link Board}, and persisting/loading
 * snapshots as CE objects. It depends only on the narrow {@link MeshLike} and
 * {@link DataLike} ports — the real adapter wraps `CeClient`, the test adapter is an
 * in-memory fake — so every line here runs under vitest with no node.
 *
 * Local-first: a local op is applied to our board *immediately* (optimistic) and then
 * published. The CE mesh echoes our own signed op back on the stream; the fold is
 * idempotent, so the echo is a harmless no-op. A remote op advances our Lamport clock
 * (so our next op sorts after what we've seen) and folds in by LWW — order-independent,
 * so two tabs that exchange the same ops converge to byte-identical boards.
 */

import {
  applyOp,
  Clock,
  emptyBoard,
  type Board,
  type Op,
  type Stamp,
} from "./oplog.ts";
import { decodeEnvelope, encodeOp } from "./protocol.ts";
import { decodeSnapshot, encodeSnapshot, frontierMax } from "./snapshot.ts";

/** A delivered mesh frame, normalized from the SDK's `AppMessage`. */
export interface MeshFrame {
  from: string;
  topic: string;
  /** Decoded UTF-8 payload text. */
  text: string;
  receivedAt: number | null;
}

/** The slice of the SDK's mesh the service needs. Lets tests inject an in-memory mesh. */
export interface MeshLike {
  subscribe(topic: string): Promise<void>;
  publish(topic: string, payload: Uint8Array): Promise<void>;
  /** Async iterable of inbound frames across all subscribed topics. */
  streamMessages(opts?: { signal?: AbortSignal }): AsyncIterable<MeshFrame>;
}

/** The slice of the SDK's data layer the service needs (CE object store). */
export interface DataLike {
  /** Store bytes as a CE object, returning its CID. */
  putObject(bytes: Uint8Array): Promise<string>;
  /** Fetch a CE object by CID. */
  getObject(cid: string): Promise<Uint8Array>;
}

export interface BoardServiceEvents {
  /** The board changed (local or remote op folded in). */
  onChange?: () => void;
  /** A remote op arrived from a peer (drives the "live" presence + sonar pulse). */
  onRemoteOp?: (from: string, op: Op) => void;
  /** The mesh stream errored (e.g. node went away). */
  onStreamError?: (err: unknown) => void;
}

/** Per-instance suffix so two browser tabs on the same node are distinct CRDT clients. */
function tabSuffix(): string {
  return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
}

export class BoardService {
  private board: Board;
  private readonly clock: Clock;
  private readonly client: string;
  private abort?: AbortController;
  private streaming = false;
  private opCount = 0;
  /** Ops published since the last snapshot — drives the snapshot cadence. */
  private opsSinceSnapshot = 0;

  constructor(
    private readonly mesh: MeshLike,
    private readonly data: DataLike,
    private readonly boardId: string,
    private readonly topic: string,
    /** The node id (CE identity) — base of this client's CRDT id. */
    selfNodeId: string,
    private readonly events: BoardServiceEvents = {},
    /** Override the per-tab suffix (tests want determinism). */
    clientSuffix: string = tabSuffix(),
  ) {
    // CRDT client id = node id (short) + per-tab suffix, so two tabs on one node still
    // converge yet never collide on stamps.
    this.client = `${selfNodeId.slice(0, 8)}-${clientSuffix}`;
    this.clock = new Clock(this.client);
    this.board = emptyBoard(boardId);
  }

  /** The CRDT client id used for stamps (node-derived, tab-unique). */
  clientId(): string {
    return this.client;
  }

  /** The materialized board (read-only view; the UI renders this). */
  current(): Board {
    return this.board;
  }

  /** Total ops folded so far (local + remote) — a cheap "activity" counter. */
  opsFolded(): number {
    return this.opCount;
  }

  /**
   * Bootstrap from a snapshot CID if one is available, then start tailing live ops.
   * A missing/foreign/corrupt snapshot is non-fatal: we simply start from empty and
   * rely on the op stream (and the next peer snapshot) to fill in.
   */
  async bootstrap(cid: string | null): Promise<void> {
    if (cid) {
      try {
        const bytes = await this.data.getObject(cid);
        const loaded = decodeSnapshot(bytes);
        if (loaded) {
          this.board = loaded.board;
          // Advance our clock past everything baked into the snapshot.
          this.clock.observe({ lamport: frontierMax(loaded.frontier), client: this.client });
          this.events.onChange?.();
        }
      } catch {
        // Snapshot unavailable — proceed with the live stream only.
      }
    }
    await this.mesh.subscribe(this.topic);
    this.startStream();
  }

  /** Persist the current board as a CE object; returns its CID. */
  async saveSnapshot(): Promise<string> {
    const cid = await this.data.putObject(encodeSnapshot(this.board));
    this.opsSinceSnapshot = 0;
    return cid;
  }

  /** Apply a locally-produced op: optimistic local fold, then publish to the mesh. */
  private async emit(make: (stamp: Stamp) => Op): Promise<void> {
    const op = make(this.clock.tick());
    if (applyOp(this.board, op)) {
      this.opCount++;
      this.events.onChange?.();
    }
    this.opsSinceSnapshot++;
    await this.mesh.publish(this.topic, encodeOp(this.boardId, op));
  }

  // ---- Public mutations (each is one op) -----------------------------------------

  renameBoard(name: string): Promise<void> {
    return this.emit((stamp) => ({ t: "board.rename", stamp, name }));
  }

  addColumn(id: string, title: string, pos: number): Promise<void> {
    return this.emit((stamp) => ({ t: "col.add", stamp, id, title, pos }));
  }

  renameColumn(id: string, title: string): Promise<void> {
    return this.emit((stamp) => ({ t: "col.rename", stamp, id, title }));
  }

  moveColumn(id: string, pos: number): Promise<void> {
    return this.emit((stamp) => ({ t: "col.move", stamp, id, pos }));
  }

  deleteColumn(id: string): Promise<void> {
    return this.emit((stamp) => ({ t: "col.delete", stamp, id }));
  }

  addCard(id: string, column: string, title: string, pos: number): Promise<void> {
    return this.emit((stamp) => ({ t: "card.add", stamp, id, column, title, pos }));
  }

  editCard(id: string, fields: { title?: string; body?: string }): Promise<void> {
    return this.emit((stamp) => ({ t: "card.edit", stamp, id, ...fields }));
  }

  moveCard(id: string, column: string, pos: number): Promise<void> {
    return this.emit((stamp) => ({ t: "card.move", stamp, id, column, pos }));
  }

  deleteCard(id: string): Promise<void> {
    return this.emit((stamp) => ({ t: "card.delete", stamp, id }));
  }

  // ---- Inbound stream -------------------------------------------------------------

  /** Fold one inbound frame. Exposed (not just internal) so tests can drive it directly. */
  handleFrame(frame: MeshFrame): void {
    if (frame.topic !== this.topic) return;
    const env = decodeEnvelope(frame.text);
    if (!env || env.board !== this.boardId) return;
    this.clock.observe(env.op.stamp);
    if (applyOp(this.board, env.op)) {
      this.opCount++;
      this.events.onChange?.();
    }
    if (frame.from !== this.client) this.events.onRemoteOp?.(frame.from, env.op);
  }

  private startStream(): void {
    if (this.streaming) return;
    this.streaming = true;
    this.abort = new AbortController();
    void this.loop(this.abort.signal);
  }

  private async loop(signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.mesh.streamMessages({ signal })) {
        if (signal.aborted) break;
        this.handleFrame(frame);
      }
    } catch (err) {
      if (!signal.aborted) this.events.onStreamError?.(err);
    } finally {
      this.streaming = false;
    }
  }

  /** Stop tailing and release the stream. */
  stop(): void {
    this.abort?.abort();
    this.streaming = false;
  }
}
