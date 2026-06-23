// Minimal @ce/client-compatible browser client for CE apps.
// Talks to the same-origin CE hub: /db/<app>/<key> (persistent KV) and
// ws /rt/<app>/<room> (ephemeral pub/sub). This is the exact contract that
// the published "@ce/client" package implements; templates ship this local
// copy so they build and run with zero install. Swap `./ce` for `@ce/client`
// if you prefer the package.

export interface Room {
  send(data: unknown): void;
  on(fn: (msg: any) => void): () => void;
  onOpen(fn: () => void): () => void;
  close(): void;
}

export interface DB {
  get(key: string): Promise<any>;
  set(key: string, val: unknown): Promise<void>;
  del(key: string): Promise<void>;
  list(prefix?: string, limit?: number): Promise<Array<{ key: string; value: any }>>;
}

export interface CeClient {
  appId: string;
  base: string;
  db: DB;
  room(name: string): Room;
}

function resolveAppId(opts?: { app?: string }): string {
  const m = location.pathname.match(/\/apps\/([^/]+)\//);
  if (m) return m[1];
  if (opts?.app) return opts.app;
  return "demo";
}

export function createClient(opts?: { app?: string; base?: string }): CeClient {
  const appId = resolveAppId(opts);
  const base = opts?.base ?? location.origin;
  const wsBase = base.replace(/^http/, "ws");

  const db: DB = {
    async get(key) {
      const r = await fetch(`${base}/db/${appId}/${encodeURIComponent(key)}`);
      if (r.status === 404) return undefined;
      if (!r.ok) throw new Error(`db.get ${r.status}`);
      return r.json();
    },
    async set(key, val) {
      const r = await fetch(`${base}/db/${appId}/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(val),
      });
      if (!r.ok) throw new Error(`db.set ${r.status}`);
    },
    async del(key) {
      await fetch(`${base}/db/${appId}/${encodeURIComponent(key)}`, { method: "DELETE" });
    },
    async list(prefix = "", limit = 200) {
      const q = new URLSearchParams();
      if (prefix) q.set("prefix", prefix);
      if (limit) q.set("limit", String(limit));
      const r = await fetch(`${base}/db/${appId}?${q}`);
      if (!r.ok) throw new Error(`db.list ${r.status}`);
      const j = await r.json();
      return (j.items ?? []) as Array<{ key: string; value: any }>;
    },
  };

  function room(name: string): Room {
    const url = `${wsBase}/rt/${appId}/${encodeURIComponent(name)}`;
    let ws: WebSocket;
    const msgCbs = new Set<(m: any) => void>();
    const openCbs = new Set<() => void>();
    let closed = false;
    let backoff = 500;

    const connect = () => {
      ws = new WebSocket(url);
      ws.onopen = () => {
        backoff = 500;
        openCbs.forEach((f) => f());
      };
      ws.onmessage = (ev) => {
        let parsed: any = ev.data;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          /* leave as raw string */
        }
        msgCbs.forEach((f) => f(parsed));
      };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 8000);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return {
      send(data) {
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
        else openCbs.add(function once() {
          ws.send(payload);
          openCbs.delete(once);
        });
      },
      on(fn) {
        msgCbs.add(fn);
        return () => msgCbs.delete(fn);
      },
      onOpen(fn) {
        openCbs.add(fn);
        return () => openCbs.delete(fn);
      },
      close() {
        closed = true;
        ws.close();
      },
    };
  }

  return { appId, base, db, room };
}
