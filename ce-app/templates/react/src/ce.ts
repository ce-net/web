// @ce/client — mesh-native browser client for CE apps (TypeScript).
//
// Talks ONLY to the local CE node — never to ce-net.com or any remote origin.
// Under the strict CSP (connect-src 'self') the page can reach exactly one place:
// its own origin, which is either the in-browser WASM node bridge (window.__ceNode)
// or a same-origin "/ce" reverse proxy in front of a local/relay node. Both transports
// are same-origin, which is what makes a single strict CSP hold.
//
// This is a local copy of the published "@ce/client" package
// (web/ce-app/client/index.js) ported to TypeScript so templates build and run with
// zero install. Swap `./ce` for `@ce/client` if you prefer the package — the public
// API (createClient / db / room) is identical.
//
// HOW IT IS BACKED BY THE MESH (no central hub):
//   * db   — a per-app last-writer-wins map replicated over gossipsub. Each set/del
//            publishes a signed op on "ce-coord/app/<appId>/db" (POST /mesh/publish);
//            every client converges by consuming the inbound SSE stream
//            (GET /mesh/messages/stream). State snapshots to/from the content-addressed
//            blob store (POST /blobs, GET /blobs/:hash) so fresh clients catch up
//            without replaying the whole log.
//   * room — mesh pub/sub: subscribe "ce-app/<appId>/room/<name>" (POST /mesh/subscribe),
//            receive inbound via the same SSE stream, send via POST /mesh/publish.

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

// ---------------------------------------------------------------------------
// Node connection — same-origin only (bridge or "/ce" proxy)
// ---------------------------------------------------------------------------

const BRIDGE_BASE_URL = "http://ce-browser-node.local";

interface NodeResponse {
  status: number;
  json?: any;
  text?: string;
  bytes?: Uint8Array;
}
interface NodeTransport {
  request(method: string, path: string, init?: { headers?: Record<string, string>; body?: any; signal?: AbortSignal }): Promise<NodeResponse>;
  stream(path: string, onData: (data: string) => void, onError?: (e: unknown) => void): () => void;
  base: string;
}

function getBridge(): any {
  try {
    const b = (globalThis as any).__ceNode;
    return b && typeof b === "object" ? b : null;
  } catch {
    return null;
  }
}

function connectNode(opts?: { ce?: string }): NodeTransport {
  const bridge = getBridge();
  if (bridge && typeof bridge.request === "function") return bridgeTransport(bridge);
  return proxyTransport((opts && opts.ce) || "/ce");
}

function bridgeTransport(bridge: any): NodeTransport {
  async function request(method: string, path: string, init?: any): Promise<NodeResponse> {
    const headers = (init && init.headers) || {};
    const body = init && init.body;
    if (bridge.request.length >= 2) {
      const res = await bridge.request(method, path, { headers, body });
      return normalizeBridgeResponse(res);
    }
    const req: any = { method, path, headers, signal: new AbortController().signal };
    if (body instanceof Uint8Array) req.rawBody = body;
    else if (typeof body === "string" && body.length) {
      try { req.jsonBody = JSON.parse(body); } catch { req.jsonBody = body; }
    }
    const res = await bridge.request(req);
    return normalizeBridgeResponse(res);
  }

  function stream(path: string, onData: (d: string) => void, onError?: (e: unknown) => void): () => void {
    if (typeof bridge.stream === "function") {
      const ctrl = new AbortController();
      (async () => {
        try {
          for await (const data of bridge.stream(path, ctrl.signal)) {
            if (ctrl.signal.aborted) return;
            if (data) onData(stripDataPrefix(data));
          }
        } catch (err) {
          if (!ctrl.signal.aborted && onError) onError(err);
        }
      })();
      return () => ctrl.abort();
    }
    return fetchStream(
      (p, init) => request("GET", p, init).then(bridgeResToResponse),
      path,
      onData,
      onError,
    );
  }

  return { request, stream, base: BRIDGE_BASE_URL };
}

function proxyTransport(prefix: string): NodeTransport {
  const root = String(prefix).replace(/\/+$/, "");
  async function request(method: string, path: string, init?: any): Promise<NodeResponse> {
    const headers: Record<string, string> = Object.assign({}, (init && init.headers) || {});
    const body = init && init.body;
    if (body != null && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(root + path, { method, headers, body });
    const ct = res.headers.get("content-type") || "";
    const out: NodeResponse = { status: res.status };
    if (ct.includes("application/json")) {
      out.json = res.status === 204 ? null : await res.json().catch(() => null);
    } else if (ct.includes("octet-stream") || ct.includes("application/")) {
      out.bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      out.text = await res.text();
    }
    return out;
  }
  function stream(path: string, onData: (d: string) => void, onError?: (e: unknown) => void): () => void {
    return fetchStream(
      (p, init) =>
        fetch(root + p, {
          method: "GET",
          headers: Object.assign({ Accept: "text/event-stream" }, init && init.headers),
          signal: init && init.signal,
        }),
      path,
      onData,
      onError,
    );
  }
  return { request, stream, base: root };
}

function normalizeBridgeResponse(res: any): NodeResponse {
  if (!res || typeof res !== "object") return { status: 502, json: null };
  if ("body" in res && !("json" in res) && !("text" in res) && !("bytes" in res)) {
    const status = res.status ?? 200;
    const body = res.body;
    if (body instanceof Uint8Array) return { status, bytes: body };
    if (typeof body === "string") {
      try { return { status, json: JSON.parse(body) }; } catch { return { status, text: body }; }
    }
    return { status, json: body ?? null };
  }
  return res as NodeResponse;
}

function bridgeResToResponse(out: NodeResponse): Response {
  if (out.bytes !== undefined) {
    return new Response(out.bytes as unknown as BodyInit, { status: out.status, headers: { "content-type": "application/octet-stream" } });
  }
  if (out.text !== undefined) {
    return new Response(out.text, { status: out.status, headers: { "content-type": "text/event-stream" } });
  }
  return new Response(JSON.stringify(out.json ?? null), { status: out.status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// SSE stream parsing (zero-dep)
// ---------------------------------------------------------------------------

function stripDataPrefix(s: string): string {
  return s.startsWith("data:") ? s.replace(/^data:\s?/, "").replace(/\n\n$/, "") : s;
}

function fetchStream(
  doFetch: (path: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>,
  path: string,
  onData: (d: string) => void,
  onError?: (e: unknown) => void,
): () => void {
  let closed = false;
  let ctrl: AbortController | null = null;
  let backoff = 500;

  async function loop() {
    while (!closed) {
      ctrl = new AbortController();
      try {
        const res = await doFetch(path, { signal: ctrl.signal });
        if (!res || !res.ok || !res.body) throw new Error(`stream ${path} -> ${res && res.status}`);
        backoff = 500;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).replace(/^ /, ""))
              .join("\n");
            if (data) {
              try { onData(data); } catch { /* ignore */ }
            }
          }
        }
      } catch (err) {
        if (closed) return;
        if (onError) try { onError(err); } catch { /* ignore */ }
      }
      if (closed) return;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 8000);
    }
  }
  loop();
  return () => {
    closed = true;
    if (ctrl) try { ctrl.abort(); } catch { /* ignore */ }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// hex + payload helpers (the node carries payloads as `payload_hex`)
// ---------------------------------------------------------------------------

const HEX = "0123456789abcdef";
function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xf];
  return s;
}
function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
const ENC = new TextEncoder();
const DEC = new TextDecoder();
function encodeJson(obj: unknown): string {
  return toHex(ENC.encode(JSON.stringify(obj)));
}
function decodeJsonHex(hex: string): any {
  try {
    return JSON.parse(DEC.decode(fromHex(hex)));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared inbound mesh stream: fan one SSE stream out to many topic subscribers
// ---------------------------------------------------------------------------

interface MeshMessage {
  topic: string;
  from?: string;
  payload_hex?: string;
  received_at?: number;
}

function makeInbox(node: NodeTransport) {
  const byTopic = new Map<string, Set<(msg: MeshMessage) => void>>();
  let closeStream: (() => void) | null = null;
  let refcount = 0;

  function ensureStream() {
    if (closeStream) return;
    closeStream = node.stream(
      "/mesh/messages/stream",
      (data) => {
        let msg: MeshMessage;
        try { msg = JSON.parse(data); } catch { return; }
        const set = byTopic.get(msg.topic);
        if (!set) return;
        for (const fn of set) {
          try { fn(msg); } catch { /* ignore */ }
        }
      },
      () => {},
    );
  }

  return {
    on(topic: string, fn: (msg: MeshMessage) => void): () => void {
      let set = byTopic.get(topic);
      if (!set) byTopic.set(topic, (set = new Set()));
      set.add(fn);
      refcount++;
      ensureStream();
      return () => {
        set!.delete(fn);
        if (set!.size === 0) byTopic.delete(topic);
        if (--refcount <= 0 && closeStream) {
          closeStream();
          closeStream = null;
          refcount = 0;
        }
      };
    },
  };
}

// ---------------------------------------------------------------------------
// resolveAppId / resolveBase (same-origin only)
// ---------------------------------------------------------------------------

function resolveAppId(opts?: { app?: string }): string {
  if (opts?.app) return String(opts.app);
  try {
    const m = location.pathname.match(/\/apps\/([^/]+)\//);
    if (m && m[1]) return decodeURIComponent(m[1]);
    const h = location.hostname.match(/^([a-z0-9][a-z0-9-]*)\./i);
    if (h && !["www", "relay", "docs", "p2p", "localhost"].includes(h[1].toLowerCase())) {
      return h[1];
    }
  } catch {
    /* non-browser env */
  }
  return "demo";
}

function resolveBase(): string {
  try {
    return location.origin;
  } catch {
    return "";
  }
}

function makeWriterId(): string {
  try {
    const c = (globalThis as any).crypto;
    if (c && c.getRandomValues) {
      const b = new Uint8Array(8);
      c.getRandomValues(b);
      return toHex(b);
    }
  } catch { /* ignore */ }
  return (Date.now().toString(16) + Math.random().toString(16).slice(2)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// createClient
// ---------------------------------------------------------------------------

interface Clock { l: number; w: string }
interface DbOp { key: string; value?: any; deleted?: boolean; clock: Clock; at?: number }
interface Entry { value: any; deleted: boolean; clock: Clock; at: number }

export function createClient(opts?: { app?: string; ce?: string }): CeClient {
  const appId = resolveAppId(opts);
  const base = resolveBase();
  const node = connectNode(opts);
  const inbox = makeInbox(node);
  const writerId = makeWriterId();

  const dbTopic = `ce-coord/app/${appId}/db`;
  const dbSnapTopic = `ce-coord/app/${appId}/db/snapshot`;

  const state = new Map<string, Entry>();
  let lamport = 0;
  let dbReady: Promise<void> | null = null;

  function clockNewer(a: Clock, b: Clock): boolean {
    if (a.l !== b.l) return a.l > b.l;
    return a.w > b.w;
  }

  function applyOp(op: DbOp): boolean {
    if (!op || typeof op.key !== "string" || !op.clock) return false;
    lamport = Math.max(lamport, op.clock.l);
    const cur = state.get(op.key);
    if (cur && !clockNewer(op.clock, cur.clock)) return false;
    state.set(op.key, {
      value: op.deleted ? undefined : op.value,
      deleted: !!op.deleted,
      clock: op.clock,
      at: op.at || 0,
    });
    return true;
  }

  async function subscribe(topic: string) {
    return node.request("POST", "/mesh/subscribe", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic }),
    });
  }

  subscribe(dbTopic).catch(() => {});
  subscribe(dbSnapTopic).catch(() => {});
  inbox.on(dbTopic, (msg) => {
    const op = decodeJsonHex(msg.payload_hex || "");
    if (op) applyOp(op);
  });

  inbox.on(dbSnapTopic, async (msg) => {
    const m = decodeJsonHex(msg.payload_hex || "");
    if (!m) return;
    if (m.kind === "request") {
      const cid = await putSnapshot().catch(() => null);
      if (cid) await publish(dbSnapTopic, { kind: "offer", cid, at: Date.now() });
    } else if (m.kind === "offer" && m.cid) {
      await loadSnapshot(m.cid).catch(() => {});
    }
  });

  async function publish(topic: string, obj: unknown) {
    return node.request("POST", "/mesh/publish", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, payload_hex: encodeJson(obj) }),
    });
  }

  async function putSnapshot(): Promise<string | null> {
    const entries: Array<[string, Entry]> = [];
    for (const [k, e] of state) entries.push([k, e]);
    const bytes = ENC.encode(JSON.stringify({ v: 1, lamport, entries }));
    const res = await node.request("POST", "/blobs", {
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (res.json && res.json.hash) return res.json.hash;
    if (res.text) {
      try { return JSON.parse(res.text).hash; } catch { /* ignore */ }
    }
    return null;
  }

  async function loadSnapshot(cid: string) {
    const res = await node.request("GET", `/blobs/${encodeURIComponent(cid)}`, {});
    let snap: any;
    if (res.bytes) snap = JSON.parse(DEC.decode(res.bytes));
    else if (res.text) snap = JSON.parse(res.text);
    else if (res.json) snap = res.json;
    if (!snap || !Array.isArray(snap.entries)) return;
    for (const [k, e] of snap.entries) {
      applyOp({ key: k, value: e.value, deleted: e.deleted, clock: e.clock, at: e.at });
    }
  }

  function ensureDbReady(): Promise<void> {
    if (dbReady) return dbReady;
    dbReady = (async () => {
      await publish(dbSnapTopic, { kind: "request", at: Date.now() }).catch(() => {});
      await sleep(300);
    })();
    return dbReady;
  }

  function nextClock(): Clock {
    lamport += 1;
    return { l: lamport, w: writerId };
  }

  const db: DB = {
    async get(key) {
      await ensureDbReady();
      const e = state.get(String(key));
      if (!e || e.deleted) return undefined;
      return e.value;
    },
    async set(key, val) {
      const k = String(key);
      const op: DbOp = { key: k, value: val ?? null, deleted: false, clock: nextClock(), at: Date.now() };
      applyOp(op);
      await publish(dbTopic, op);
    },
    async del(key) {
      const k = String(key);
      const op: DbOp = { key: k, deleted: true, clock: nextClock(), at: Date.now() };
      applyOp(op);
      await publish(dbTopic, op);
    },
    async list(prefix = "", limit = 200) {
      await ensureDbReady();
      const pre = prefix == null ? "" : String(prefix);
      const items: Array<{ key: string; value: any; at: number }> = [];
      for (const [key, e] of state) {
        if (e.deleted) continue;
        if (pre && !key.startsWith(pre)) continue;
        items.push({ key, value: e.value, at: e.at || 0 });
      }
      items.sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : -1));
      const out = items.map(({ key, value }) => ({ key, value }));
      return limit != null ? out.slice(0, Number(limit)) : out;
    },
  };

  function room(name: string): Room {
    const topic = `ce-app/${appId}/room/${name}`;
    let closed = false;
    let opened = false;
    const msgHandlers = new Set<(m: any) => void>();
    const openHandlers = new Set<() => void>();
    const outbox: unknown[] = [];
    let offInbox: (() => void) | null = null;

    function flushOutbox() {
      for (const data of outbox.splice(0)) publish(topic, data).catch(() => {});
    }
    function markOpen() {
      if (opened || closed) return;
      opened = true;
      flushOutbox();
      for (const fn of openHandlers) {
        try { fn(); } catch { /* ignore */ }
      }
    }

    node
      .request("POST", "/mesh/subscribe", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic }),
      })
      .then(() => markOpen(), () => markOpen());

    offInbox = inbox.on(topic, (msg) => {
      let payload = decodeJsonHex(msg.payload_hex || "");
      if (payload === undefined) {
        try { payload = DEC.decode(fromHex(msg.payload_hex || "")); } catch { return; }
      }
      for (const fn of msgHandlers) {
        try { fn(payload); } catch { /* ignore */ }
      }
    });

    return {
      send(obj) {
        if (opened) publish(topic, obj).catch(() => {});
        else outbox.push(obj);
      },
      on(fn) {
        msgHandlers.add(fn);
        return () => msgHandlers.delete(fn);
      },
      onOpen(fn) {
        openHandlers.add(fn);
        if (opened) {
          try { fn(); } catch { /* ignore */ }
        }
        return () => openHandlers.delete(fn);
      },
      close() {
        closed = true;
        if (offInbox) offInbox();
      },
    };
  }

  return { appId, base, db, room };
}

export default { createClient };
