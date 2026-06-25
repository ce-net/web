/**
 * Presence tracking.
 *
 * There is no presence server. Each member periodically publishes a `presence`
 * heartbeat to the channel topic. We keep the most recent heartbeat per node and
 * consider a member "online" if we have heard from them within a TTL window.
 * Membership is derived purely from observed traffic — both heartbeats and chat
 * messages count as liveness, so an actively-typing peer never flickers offline.
 */

/** A member we have observed on a channel. */
export interface Member {
  nodeId: string;
  name?: string;
  /** Local clock (ms) when we last heard from this node. */
  lastSeen: number;
  /** True if this is our own node. */
  isSelf: boolean;
}

/** Members are considered online for this long after their last signal. */
export const PRESENCE_TTL_MS = 45_000;

/** Recommended heartbeat interval (well under the TTL so one drop is tolerated). */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export class PresenceTracker {
  private readonly members = new Map<string, Member>();

  constructor(private readonly selfId: string) {}

  /**
   * Record liveness for `nodeId` at local time `now`. Updates the display name if
   * the signal carried one. Returns the updated member.
   */
  seen(nodeId: string, name: string | undefined, now: number): Member {
    const id = nodeId.toLowerCase();
    const existing = this.members.get(id);
    const member: Member = {
      nodeId: id,
      name: name ?? existing?.name,
      lastSeen: Math.max(now, existing?.lastSeen ?? 0),
      isSelf: id === this.selfId.toLowerCase(),
    };
    this.members.set(id, member);
    return member;
  }

  /** All known members, online first, then by name/id, with self pinned to the very top. */
  list(now: number): Member[] {
    const out = [...this.members.values()];
    out.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      const ao = this.isOnline(a, now) ? 0 : 1;
      const bo = this.isOnline(b, now) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return (a.name ?? a.nodeId).localeCompare(b.name ?? b.nodeId);
    });
    return out;
  }

  /** Count of members currently within the TTL window. */
  onlineCount(now: number): number {
    let n = 0;
    for (const m of this.members.values()) if (this.isOnline(m, now)) n++;
    return n;
  }

  isOnline(m: Member, now: number): boolean {
    return now - m.lastSeen <= PRESENCE_TTL_MS;
  }

  /** Drop members not seen for `maxAgeMs`. Returns the number removed. */
  prune(now: number, maxAgeMs: number): number {
    let removed = 0;
    for (const [id, m] of this.members) {
      if (m.isSelf) continue;
      if (now - m.lastSeen > maxAgeMs) {
        this.members.delete(id);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.members.clear();
  }
}
