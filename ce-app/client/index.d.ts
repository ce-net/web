// Type definitions for @ce/client — the mesh-native CE App Platform browser client.
// Backed by the local CE node (in-browser window.__ceNode bridge, or a same-origin
// "/ce" proxy). No remote origins; works under the strict same-origin CSP.

export interface CreateClientOptions {
  /** Override the resolved app id (default: parsed from /apps/<id>/, else 'demo'). */
  app?: string;
  /** Same-origin path the local node is reverse-proxied at, when no in-browser bridge
   *  is present (default: "/ce"). */
  ce?: string;
}

export interface DbListItem<V = unknown> {
  key: string;
  value: V;
}

export interface Db {
  /** Converged value for key (mesh-replicated, last-writer-wins), or undefined. */
  get<V = unknown>(key: string): Promise<V | undefined>;
  /** Publish a set op on "ce-coord/app/<appId>/db"; converges across all clients. */
  set<V = unknown>(key: string, val: V): Promise<{ ok: boolean; key: string }>;
  /** Publish a tombstone (delete) op; converges across all clients. */
  del(key: string): Promise<{ ok: boolean }>;
  /** Newest-first items from the converged map, optionally prefix/limit filtered. */
  list<V = unknown>(prefix?: string, limit?: number): Promise<DbListItem<V>[]>;
}

export interface Room {
  /** Publish to the room topic. Objects are sent as JSON; strings as text. */
  send(obj: unknown | string): void;
  /** Subscribe to messages. JSON is parsed when possible; returns an unsubscribe fn. */
  on(fn: (msg: unknown) => void): () => void;
  /** Run a callback once the topic subscription is live (and immediately if already). */
  onOpen(fn: () => void): () => void;
  /** Unsubscribe and stop receiving. */
  close(): void;
}

export interface CeClient {
  /** Resolved app id. */
  appId: string;
  /** Resolved same-origin base (location.origin). */
  base: string;
  /** Mesh-replicated KV namespaced per app. */
  db: Db;
  /** Join a realtime mesh pub/sub room (topic "ce-app/<appId>/room/<name>"). */
  room(name: string): Room;
}

export function createClient(opts?: CreateClientOptions): CeClient;

declare const _default: { createClient: typeof createClient };
export default _default;
