import { Amount } from "@ce-net/sdk";
import type {
  AtlasEntry,
  NodeHistory,
  TxKind,
  Channel,
  Job,
} from "@ce-net/sdk";

/**
 * Pure mapping + derivation logic for the explorer. Everything here is a
 * deterministic function of node data so it can be unit-tested with no network.
 */

/** A peer as the explorer renders it: atlas capacity joined with any history. */
export interface PeerRow {
  nodeId: string;
  cpuCores: number;
  memMb: number;
  runningJobs: number;
  lastSeenSecs: number;
  tags: string[];
  /** True if the peer is in the atlas (currently advertising capacity). */
  online: boolean;
  /** Earned credits from history, if known. */
  earned: Amount | null;
  /** Spent credits from history, if known. */
  spent: Amount | null;
  /** Hosted jobs + hosted heartbeats (delivered work). */
  delivered: number;
  /** Paid jobs + paid heartbeats (consumed work). */
  consumed: number;
  /**
   * Share ratio = delivered / consumed, the torrent-style give-vs-take score.
   * `Infinity` when a peer has only ever given; `null` when there is no history.
   */
  shareRatio: number | null;
}

/** A row in the share-ratio leaderboard, sorted best-giver first. */
export interface LeaderRow extends PeerRow {
  rank: number;
}

/** Join an atlas snapshot with a map of per-node history into peer rows. */
export function buildPeerRows(
  atlas: AtlasEntry[],
  history: Map<string, NodeHistory>,
): PeerRow[] {
  const seen = new Set<string>();
  const rows: PeerRow[] = [];

  for (const a of atlas) {
    seen.add(a.nodeId);
    rows.push(peerRowFrom(a, history.get(a.nodeId) ?? null, true));
  }
  // Peers we have history for but are not currently in the atlas (offline).
  for (const [nodeId, h] of history) {
    if (seen.has(nodeId)) continue;
    rows.push(
      peerRowFrom(
        {
          nodeId,
          cpuCores: 0,
          memMb: 0,
          runningJobs: 0,
          lastSeenSecs: Number.POSITIVE_INFINITY,
          tags: [],
        },
        h,
        false,
      ),
    );
  }
  return rows;
}

function peerRowFrom(
  a: AtlasEntry,
  h: NodeHistory | null,
  online: boolean,
): PeerRow {
  const delivered = h ? h.jobsHosted + h.heartbeatsHosted : 0;
  const consumed = h ? h.jobsPaid + h.heartbeatsPaid : 0;
  return {
    nodeId: a.nodeId,
    cpuCores: a.cpuCores,
    memMb: a.memMb,
    runningJobs: a.runningJobs,
    lastSeenSecs: a.lastSeenSecs,
    tags: a.tags ?? [],
    online,
    earned: h ? h.earned : null,
    spent: h ? h.spent : null,
    delivered,
    consumed,
    shareRatio: h ? computeShareRatio(delivered, consumed) : null,
  };
}

/**
 * delivered / consumed. A peer that has given but never taken returns
 * `Infinity` (a pure seeder); a peer with no activity returns 0.
 */
export function computeShareRatio(delivered: number, consumed: number): number {
  if (consumed <= 0) return delivered > 0 ? Number.POSITIVE_INFINITY : 0;
  return delivered / consumed;
}

/**
 * Rank peers by share ratio (best giver first). Peers with no history at all
 * are dropped from the leaderboard; ties break by delivered work, then nodeId
 * for stability. `Infinity` ratios rank above any finite ratio.
 */
export function buildLeaderboard(rows: PeerRow[]): LeaderRow[] {
  const ranked = rows
    .filter((r) => r.shareRatio !== null && (r.delivered > 0 || r.consumed > 0))
    .sort((a, b) => {
      const ra = a.shareRatio ?? -1;
      const rb = b.shareRatio ?? -1;
      if (rb !== ra) return rb - ra;
      if (b.delivered !== a.delivered) return b.delivered - a.delivered;
      return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
    });
  return ranked.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Format a share ratio for display: "∞", "2.50", "0.00". */
export function formatRatio(ratio: number | null): string {
  if (ratio === null) return "—";
  if (ratio === Number.POSITIVE_INFINITY) return "∞";
  return ratio.toFixed(2);
}

/**
 * Distinct tags across all peers with how many peers carry each, sorted by
 * count desc then name. Drives the atlas tag-filter chips.
 */
export function tagFacets(rows: PeerRow[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.tag < b.tag ? -1 : 1));
}

/** Whether a free-text query matches a peer (id substring or tag substring). */
export function peerMatches(row: PeerRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  if (row.nodeId.toLowerCase().includes(q)) return true;
  return row.tags.some((t) => t.toLowerCase().includes(q));
}

/** Semantic class for a job status string from the node. */
export type JobState = "running" | "pending" | "settling" | "settled" | "failed";

export function classifyJob(job: Job): JobState {
  const s = job.status.toLowerCase();
  if (s.startsWith("failed")) return "failed";
  if (s === "running") return "running";
  if (s === "pending") return "pending";
  if (s === "awaiting_settlement") return "settling";
  if (s === "settled") return "settled";
  // Unknown future states render as pending rather than crashing.
  return "pending";
}

/**
 * Whether a tx kind moves value (vs. a control/consensus record). Used to tint
 * the transaction feed: value-moving txs get the amber "credit" treatment.
 */
export function txMovesValue(kind: TxKind): boolean {
  switch (kind) {
    case "Transfer":
    case "UptimeReward":
    case "JobBid":
    case "JobSettle":
    case "JobExpire":
    case "Heartbeat":
    case "ChannelOpen":
    case "ChannelClose":
    case "ChannelExpire":
    case "HostBond":
    case "HostUnbond":
      return true;
    case "NameClaim":
    case "RevokeCapability":
    case "SlashEquivocation":
      return false;
    default:
      return false;
  }
}

/** A short human label for a tx kind (the node's PascalCase split on words). */
export function txKindLabel(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Total credits currently locked across a set of open payment channels. */
export function totalChannelCapacity(channels: Channel[]): Amount {
  return channels.reduce((acc, c) => acc.add(c.capacity), Amount.ZERO);
}
