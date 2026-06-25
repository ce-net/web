/**
 * Board <-> mesh-topic mapping.
 *
 * A ce-board board is one CE mesh pubsub topic for its live op stream. We namespace
 * every topic under `ce-board/` so board traffic never collides with other mesh apps,
 * and so a node can subscribe to board topics without slurping unrelated pubsub.
 *
 * Board `roadmap`  ->  ops topic `ce-board/ops/roadmap`
 *
 * The board *id* is a lowercase slug derived from the board name; everyone who types
 * the same board name lands on the same topic and converges on the same board.
 */

export const TOPIC_PREFIX = "ce-board";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Validate a board id (lowercase slug, 1-64 chars). */
export function isValidBoardId(id: string): boolean {
  return NAME_RE.test(id);
}

/** Normalize user input to a board slug (lowercase, spaces->dashes, strip junk). */
export function normalizeBoardId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64)
    .replace(/[-_]+$/g, "");
}

/** Mesh pubsub topic carrying a board's live op stream. */
export function opsTopic(boardId: string): string {
  return `${TOPIC_PREFIX}/ops/${boardId}`;
}

/** localStorage key under which we cache a board's latest snapshot CID for fast reboot. */
export function snapshotKey(boardId: string): string {
  return `${TOPIC_PREFIX}:snapshot:${boardId}`;
}
