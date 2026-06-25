import type { CeClient, NodeHistory, BlockEvent } from "@ce-net/sdk";
import { ExplorerStore } from "./store.js";
import { describeError } from "./errors.js";

/**
 * Drives an {@link ExplorerStore} from a live {@link CeClient}: two SSE tails
 * (blocks, transactions) and a polling loop (status, atlas, history, jobs,
 * channels). Call {@link start} once; {@link stop} aborts everything.
 *
 * History is fetched per-peer from `/history/:node_id`; we only query the peers
 * the atlas currently lists plus the recent block miners, to keep it bounded.
 */
export class ExplorerRuntime {
  private abort = new AbortController();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly client: CeClient,
    private readonly store: ExplorerStore,
    private readonly pollIntervalMs = 8000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tailBlocks();
    void this.tailTxs();
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.abort.abort();
  }

  private async tailBlocks(): Promise<void> {
    this.store.setSource("blocks", "connecting");
    try {
      for await (const b of this.client.streams.blocks({ signal: this.abort.signal })) {
        this.store.setSource("blocks", "live");
        this.store.onBlock(b);
      }
    } catch (err) {
      if (this.running) this.store.setSource("blocks", "error", describeError(err));
    }
  }

  private async tailTxs(): Promise<void> {
    this.store.setSource("transactions", "connecting");
    try {
      for await (const t of this.client.streams.transactions({ signal: this.abort.signal })) {
        this.store.setSource("transactions", "live");
        this.store.onTx(t);
      }
    } catch (err) {
      if (this.running) this.store.setSource("transactions", "error", describeError(err));
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      await this.pollOnce();
      if (!this.running) break;
      await this.delay(this.pollIntervalMs);
    }
  }

  /** One poll pass. Each read is independent so a single failure is contained. */
  async pollOnce(): Promise<void> {
    this.store.setSource("poll", "connecting");

    const status = await this.safe("status", () => this.client.getStatus());
    const atlas = (await this.safe("atlas", () => this.client.atlas())) ?? [];
    const jobs = (await this.safe("jobs", () => this.client.listJobs())) ?? [];
    const channels = (await this.safe("channels", () => this.client.listChannels())) ?? [];

    const history = await this.fetchHistory(atlas.map((a) => a.nodeId), status?.nodeId);

    this.store.setPolled({
      status: status ?? null,
      atlas,
      jobs,
      channels,
      ...(history ? { history } : {}),
    });
    this.store.setSource("poll", "live");
  }

  /** Fetch history for each peer id (bounded), tolerating per-peer failures. */
  private async fetchHistory(
    peerIds: string[],
    selfId: string | undefined,
  ): Promise<Map<string, NodeHistory> | undefined> {
    const ids = [...new Set([...(selfId ? [selfId] : []), ...peerIds])].slice(0, 64);
    if (ids.length === 0) return undefined;
    const out = new Map<string, NodeHistory>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          out.set(id, await this.client.history(id));
        } catch {
          // A peer with no history (or a read error) simply has no row data.
        }
      }),
    );
    return out;
  }

  private async safe<T>(source: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const v = await fn();
      this.store.setSource(source, "live");
      return v;
    } catch (err) {
      this.store.setSource(source, "error", describeError(err));
      return undefined;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.pollTimer = setTimeout(resolve, ms);
    });
  }
}

/** Recent miners from the block tail — useful extra ids to enrich history. */
export function recentMiners(blocks: readonly BlockEvent[], limit = 16): string[] {
  const seen = new Set<string>();
  for (const b of blocks) {
    if (seen.size >= limit) break;
    if (b.miner) seen.add(b.miner);
  }
  return [...seen];
}
