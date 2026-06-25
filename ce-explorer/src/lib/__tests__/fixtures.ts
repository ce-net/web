import { Amount } from "@ce-net/sdk";
import type {
  AtlasEntry,
  NodeHistory,
  Job,
  Channel,
  BlockEvent,
  TxEvent,
  NodeStatus,
} from "@ce-net/sdk";

/** Test fixtures + a tiny in-memory CeClient-shaped adapter for the runtime. */

export function makeHistory(p: Partial<NodeHistory> & { nodeId: string }): NodeHistory {
  const base: NodeHistory = {
    nodeId: p.nodeId,
    jobsHosted: p.jobsHosted ?? 0,
    jobsPaid: p.jobsPaid ?? 0,
    heartbeatsHosted: p.heartbeatsHosted ?? 0,
    heartbeatsPaid: p.heartbeatsPaid ?? 0,
    expiries: p.expiries ?? 0,
    earned: p.earned ?? Amount.ZERO,
    spent: p.spent ?? Amount.ZERO,
    firstHeight: p.firstHeight ?? 1,
    lastHeight: p.lastHeight ?? 10,
    isNewcomer() {
      return this.firstHeight === 0;
    },
    deliveredWork() {
      return this.jobsHosted + this.heartbeatsHosted;
    },
  };
  return base;
}

export function makeAtlas(p: Partial<AtlasEntry> & { nodeId: string }): AtlasEntry {
  return {
    nodeId: p.nodeId,
    cpuCores: p.cpuCores ?? 4,
    memMb: p.memMb ?? 4096,
    runningJobs: p.runningJobs ?? 0,
    lastSeenSecs: p.lastSeenSecs ?? 5,
    tags: p.tags ?? [],
  };
}

export function makeStatus(p: Partial<NodeStatus> = {}): NodeStatus {
  return {
    nodeId: p.nodeId ?? "aa".repeat(32),
    height: p.height ?? 1000,
    difficulty: p.difficulty ?? 20,
    balance: p.balance ?? Amount.fromWholeCredits(500n),
    circulatingSupply: p.circulatingSupply ?? Amount.fromWholeCredits(1_000_000n),
    burnedTotal: p.burnedTotal ?? Amount.fromWholeCredits(42n),
    bond: p.bond ?? Amount.ZERO,
    weight: p.weight ?? 0,
    free: p.free ?? Amount.fromWholeCredits(500n),
    lockedChannels: p.lockedChannels ?? Amount.ZERO,
    lockedBond: p.lockedBond ?? Amount.ZERO,
  };
}

export function makeBlock(p: Partial<BlockEvent> & { index: number }): BlockEvent {
  return {
    index: p.index,
    hash: p.hash ?? `${p.index}`.padStart(64, "0"),
    prevHash: p.prevHash ?? "00".repeat(32),
    timestamp: p.timestamp ?? Math.floor(Date.now() / 1000),
    miner: p.miner ?? "bb".repeat(32),
    txCount: p.txCount ?? 1,
    nonce: p.nonce ?? 0,
  };
}

export function makeTx(p: Partial<TxEvent> & { id: string }): TxEvent {
  return {
    id: p.id,
    origin: p.origin ?? "cc".repeat(32),
    kind: p.kind ?? "Transfer",
    amount: p.amount ?? Amount.ZERO,
  };
}

/** A controllable in-memory stand-in for the parts of CeClient the runtime uses. */
export class FakeClient {
  status: NodeStatus | null = makeStatus();
  atlasData: AtlasEntry[] = [];
  jobsData: Job[] = [];
  channelsData: Channel[] = [];
  historyData = new Map<string, NodeHistory>();
  failAtlas = false;
  blockQueue: BlockEvent[] = [];
  txQueue: TxEvent[] = [];

  streams = {
    blocks: (_opts?: unknown): AsyncIterable<BlockEvent> => arrayStream(this.blockQueue),
    transactions: (_opts?: unknown): AsyncIterable<TxEvent> => arrayStream(this.txQueue),
  };

  async getStatus(): Promise<NodeStatus> {
    if (!this.status) throw new Error("no status");
    return this.status;
  }
  async atlas(): Promise<AtlasEntry[]> {
    if (this.failAtlas) throw new Error("atlas down");
    return this.atlasData;
  }
  async listJobs(): Promise<Job[]> {
    return this.jobsData;
  }
  async listChannels(): Promise<Channel[]> {
    return this.channelsData;
  }
  async history(nodeId: string): Promise<NodeHistory> {
    const h = this.historyData.get(nodeId);
    if (!h) throw new Error("no history");
    return h;
  }
}

/** Yield items from an array, then end the stream (no infinite loop in tests). */
async function* arrayStream<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}
