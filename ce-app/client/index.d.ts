// Type definitions for @ce/client — the CE App Platform browser client.

export interface CreateClientOptions {
  /** Override the resolved app id (default: parsed from /apps/<id>/, else 'demo'). */
  app?: string;
  /** Override the http(s) origin (default: location.origin). */
  base?: string;
}

export interface DbListItem<V = unknown> {
  key: string;
  value: V;
}

export interface Db {
  /** GET /db/<app>/<key> -> stored JSON value, or undefined if 404. */
  get<V = unknown>(key: string): Promise<V | undefined>;
  /** PUT /db/<app>/<key> with a JSON value. */
  set<V = unknown>(key: string, val: V): Promise<{ ok: boolean; key: string }>;
  /** DELETE /db/<app>/<key>. */
  del(key: string): Promise<{ ok: boolean }>;
  /** GET /db/<app>?prefix=&limit= -> newest-first items. */
  list<V = unknown>(prefix?: string, limit?: number): Promise<DbListItem<V>[]>;
}

export interface Room {
  /** Send a TEXT frame. Objects are JSON-stringified; strings are sent verbatim. */
  send(obj: unknown | string): void;
  /** Subscribe to messages. JSON is parsed when possible; returns an unsubscribe fn. */
  on(fn: (msg: unknown) => void): () => void;
  /** Run a callback when the socket opens (and immediately if already open). */
  onOpen(fn: () => void): () => void;
  /** Close the socket and stop reconnecting. */
  close(): void;
}

export interface CeClient {
  /** Resolved app id. */
  appId: string;
  /** Resolved http(s) origin. */
  base: string;
  /** Persistent KV namespaced per app. */
  db: Db;
  /** Open (or join) a realtime pub/sub room over websocket. */
  room(name: string): Room;
}

export function createClient(opts?: CreateClientOptions): CeClient;

declare const _default: { createClient: typeof createClient };
export default _default;
