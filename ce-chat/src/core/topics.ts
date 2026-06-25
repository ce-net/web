/**
 * Channel <-> mesh-topic mapping.
 *
 * A ce-chat channel is exactly one CE mesh pubsub topic. We namespace every topic
 * under `ce-chat/` so chat traffic never collides with other mesh apps, and so a
 * node can subscribe to chat topics without slurping unrelated pubsub.
 *
 * Public channel `general`           -> `ce-chat/channel/general`
 * Private channel `eng` (gated)      -> `ce-chat/private/eng`
 * DM between nodes A and B           -> `ce-chat/dm/<min(A,B)>+<max(A,B)>`
 *
 * The DM topic is order-independent: both participants derive the same topic by
 * sorting the two node ids, so either side can open the conversation first.
 */

export const TOPIC_PREFIX = "ce-chat";

/** A channel as the app models it. `id` is stable; `topic` is what we subscribe to. */
export interface ChannelRef {
  id: string;
  topic: string;
  kind: "public" | "private" | "dm";
  /** Display label. For DMs this is the peer's short id; set by the caller. */
  label: string;
  /** For DMs only: the peer node id. */
  peer?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Validate a channel name (lowercase slug, 1-64 chars). */
export function isValidChannelName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Normalize user input to a channel slug (lowercase, spaces->dashes, strip junk). */
export function normalizeChannelName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-") // collapse runs (e.g. "a -- b" -> "a-b")
    .replace(/^[-_]+|[-_]+$/g, "") // a valid slug can't start/end with - or _
    .slice(0, 64)
    .replace(/[-_]+$/g, ""); // re-trim in case the slice landed on a separator
}

/** Topic for a public channel. */
export function publicTopic(name: string): string {
  return `${TOPIC_PREFIX}/channel/${name}`;
}

/** Topic for a private (capability-gated) channel. */
export function privateTopic(name: string): string {
  return `${TOPIC_PREFIX}/private/${name}`;
}

/** A 64-hex CE node id. */
const NODE_ID_RE = /^[0-9a-f]{64}$/i;

export function isNodeId(s: string): boolean {
  return NODE_ID_RE.test(s.trim());
}

/**
 * Order-independent DM topic for two node ids. Throws on a malformed id so a bad
 * paste never silently routes a DM to the wrong (or a colliding) topic.
 */
export function dmTopic(a: string, b: string): string {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!NODE_ID_RE.test(x) || !NODE_ID_RE.test(y)) {
    throw new Error("dmTopic: both arguments must be 64-hex node ids");
  }
  if (x === y) throw new Error("dmTopic: cannot DM yourself");
  const [lo, hi] = x < y ? [x, y] : [y, x];
  return `${TOPIC_PREFIX}/dm/${lo}+${hi}`;
}

/** Build a public channel ref. */
export function publicChannel(name: string): ChannelRef {
  return { id: `pub:${name}`, topic: publicTopic(name), kind: "public", label: name };
}

/** Build a private channel ref. */
export function privateChannel(name: string): ChannelRef {
  return { id: `prv:${name}`, topic: privateTopic(name), kind: "private", label: name };
}

/** Build a DM channel ref against `peer`, derived relative to `self`. */
export function dmChannel(self: string, peer: string, label: string): ChannelRef {
  return { id: `dm:${peer.toLowerCase()}`, topic: dmTopic(self, peer), kind: "dm", label, peer: peer.toLowerCase() };
}
