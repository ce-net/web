import type {
  BlockEvent,
  TxEvent,
  NodeStatus,
  AtlasEntry,
  Job,
  Channel,
  NodeHistory,
} from "@ce-net/sdk";
import { buildPeerRows, buildLeaderboard } from "./model.js";
import type { PeerRow, LeaderRow } from "./model.js";

/** A bounded ring buffer: push newest to the front, drop the oldest past `cap`. */
export class RingBuffer<T> {
  private items: T[] = [];
  constructor(private readonly cap: number) {}

  /** Insert at the front; returns the buffer's current contents (newest first). */
  push(item: T): void {
    this.items.unshift(item);
    if (this.items.length > this.cap) this.items.length = this.cap;
  }

  /** Replace the whole buffer (e.g. seeding from a history fetch). */
  reset(items: T[]): void {
    this.items = items.slice(0, this.cap);
  }

  list(): readonly T[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }
}

/** Health of a single live data source. */
export type SourceState = "idle" | "connecting" | "live" | "error";

/** The full snapshot the UI renders from. Always replaced wholesale, never mutated. */
export interface ExplorerSnapshot {
  status: NodeStatus | null;
  blocks: readonly BlockEvent[];
  txs: readonly TxEvent[];
  peers: PeerRow[];
  leaderboard: LeaderRow[];
  jobs: Job[];
  channels: Channel[];
  /** Per-source connection health, keyed by name. */
  sources: Record<string, SourceState>;
  /** Last error message per source, for the UI to surface. */
  errors: Record<string, string | undefined>;
  /** When the polled data was last refreshed (ms epoch), or 0 if never. */
  lastPollAt: number;
}

type Listener = (snap: ExplorerSnapshot) => void;

/**
 * The explorer store. It owns the live SSE tails (blocks, transactions) and the
 * polled snapshots (status, atlas, history, jobs, channels), folds them into one
 * immutable {@link ExplorerSnapshot}, and notifies subscribers on every change.
 *
 * The store is transport-agnostic: it takes a small {@link DataSource} port, so
 * tests drive it with an in-memory adapter and the app drives it with the SDK.
 */
export class ExplorerStore {
  private blocks = new RingBuffer<BlockEvent>(60);
  private txs = new RingBuffer<TxEvent>(120);
  private status: NodeStatus | null = null;
  private atlas: AtlasEntry[] = [];
  private history = new Map<string, NodeHistory>();
  private jobs: Job[] = [];
  private channels: Channel[] = [];
  private sources: Record<string, SourceState> = {};
  private errors: Record<string, string | undefined> = {};
  private lastPollAt = 0;
  private listeners = new Set<Listener>();

  /** Subscribe to snapshots. Fires immediately with the current snapshot. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  /** Current immutable view. */
  snapshot(): ExplorerSnapshot {
    const peers = buildPeerRows(this.atlas, this.history);
    return {
      status: this.status,
      blocks: this.blocks.list(),
      txs: this.txs.list(),
      peers,
      leaderboard: buildLeaderboard(peers),
      jobs: this.jobs,
      channels: this.channels,
      sources: { ...this.sources },
      errors: { ...this.errors },
      lastPollAt: this.lastPollAt,
    };
  }

  // --- mutations (called by the runtime; pure-ish, always emit) ---

  onBlock(b: BlockEvent): void {
    this.blocks.push(b);
    this.emit();
  }

  onTx(t: TxEvent): void {
    this.txs.push(t);
    this.emit();
  }

  setSource(name: string, state: SourceState, error?: string): void {
    this.sources[name] = state;
    this.errors[name] = error;
    this.emit();
  }

  /** Replace the polled snapshot atomically and stamp the poll time. */
  setPolled(p: {
    status?: NodeStatus | null;
    atlas?: AtlasEntry[];
    history?: Map<string, NodeHistory>;
    jobs?: Job[];
    channels?: Channel[];
  }): void {
    if (p.status !== undefined) this.status = p.status;
    if (p.atlas !== undefined) this.atlas = p.atlas;
    if (p.history !== undefined) this.history = p.history;
    if (p.jobs !== undefined) this.jobs = p.jobs;
    if (p.channels !== undefined) this.channels = p.channels;
    this.lastPollAt = Date.now();
    this.emit();
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}
