/**
 * Entity id generation for cards and columns.
 *
 * Ids must be globally unique across all clients without coordination (so two tabs
 * never mint the same card id), short, and URL/CSS-safe (they become DOM selectors).
 * We derive them from the client id + a monotonic counter + a random salt — the same
 * recipe ce-chat uses for message ids, which has proven collision-free in practice.
 */

let counter = 0;

/** A unique, slug-safe entity id seeded by the CRDT client id. */
export function newId(prefix: string, client: string, rand: () => number = Math.random): string {
  counter = (counter + 1) % 1_000_000;
  const salt = Math.floor(rand() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  const c = client.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "anon";
  return `${prefix}_${c}_${counter.toString(36)}_${salt}`;
}

/** Reset the internal counter — test-only, so id sequences are reproducible. */
export function _resetIdCounter(): void {
  counter = 0;
}
