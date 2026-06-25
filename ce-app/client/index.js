// @ce/client — mesh-native browser ESM client for the CE App Platform.
//
// Zero dependencies. Talks ONLY to the local CE node — never to ce-net.com or any
// remote origin. Under the strict CSP (connect-src 'self') the page can reach exactly
// one place: its own origin, which is either the in-browser WASM node bridge
// (window.__ceNode) or a same-origin "/ce" reverse proxy in front of a local/relay node.
// Both transports are same-origin, which is what makes a single strict CSP hold.
//
// Public API (unchanged from the old centralized hub client):
//
//   import { createClient } from "@ce/client";
//   const ce = createClient();                  // appId auto-resolved from /apps/<id>/
//   await ce.db.set("greeting", { hi: true });  // converged KV, namespaced per app
//   const v = await ce.db.get("greeting");
//   const recent = await ce.db.list("", 20);    // newest-first [{key, value}]
//   const room = ce.room("lobby");
//   const off = room.on(msg => console.log(msg));
//   room.onOpen(() => room.send({ text: "hello" }));
//   // room.close(); off();
//
// HOW IT IS BACKED BY THE MESH (no central hub):
//   * db  — a per-app last-writer-wins map replicated over gossipsub. Each set/del
//           publishes a signed op on topic "ce-coord/app/<appId>/db" (POST /mesh/publish);
//           every client converges by consuming the inbound SSE stream
//           (GET /mesh/messages/stream). State is snapshotted to / loaded from the
//           content-addressed blob store (POST /blobs, GET /blobs/:hash) so a fresh
//           client catches up without replaying the whole log. Modeled on the proven
//           ce-coord RMap pattern (op log + catch-up snapshot); converges with no elected
//           writer by ordering ops on a (lamport, writer-id) logical clock — last write wins.
//   * room — mesh pub/sub. subscribe topic "ce-app/<appId>/room/<name>"
//           (POST /mesh/subscribe), receive inbound via the same SSE stream
//           (low latency, no polling), send via POST /mesh/publish.
//
// All node access goes through connectNode() below (window.__ceNode bridge, else
// same-origin "/ce"). The bridge dispatches in-process to the in-browser node and never
// touches the network; the "/ce" proxy is same-origin too. NEVER fetch ce-net.com.

const BRIDGE_BASE_URL = "http://ce-browser-node.local";

// ---------------------------------------------------------------------------
// Node connection (SHARED CONTRACT)
// ---------------------------------------------------------------------------

/**
 * Read the injected in-browser node bridge, if any. A "CeNodeBridge" exposes
 *   request(method, path, init?) => Promise<{status, headers, body}>
 * (older bridges expose request({method,path,headers,jsonBody,rawBody,signal}) =>
 *  {status, json|text|bytes}); both shapes are supported. Dispatch is in-process.
 */
function getBridge() {
  try {
    const b = globalThis.__ceNode;
    return b && typeof b === "object" ? b : null;
  } catch (_) {
    return null;
  }
}

/**
 * connectNode(opts?) — returns a tiny same-origin node transport:
 *   { request(method, path, init?) -> {status, json?, text?, bytes?},
 *     stream(path, onData, onError?) -> close() }
 *
 * Mirrors the SHARED CONTRACT's connectNode(): if window.__ceNode exists, route through
 * the bridge (sentinel base "http://ce-browser-node.local"); otherwise reach a native
 * local/relay node via the same-origin "/ce" reverse proxy. Both are same-origin so the
 * strict CSP (connect-src 'self') is satisfied. This is a dependency-free, browser-only
 * equivalent of constructing a CeClient — the @ce/client surface does not need the full SDK.
 */
function connectNode(opts = {}) {
  const bridge = getBridge();
  if (bridge && typeof bridge.request === "function") return bridgeTransport(bridge);
  return proxyTransport((opts && opts.ce) || "/ce");
}

/** Transport over the in-browser node bridge (in-process, never networked). */
function bridgeTransport(bridge) {
  async function request(method, path, init) {
    const headers = (init && init.headers) || {};
    const body = init && init.body;
    // Preferred new contract: request(method, path, init) -> {status, headers, body}.
    // Detected by arity >= 2.
    if (bridge.request.length >= 2) {
      const res = await bridge.request(method, path, { headers, body });
      return normalizeBridgeResponse(res);
    }
    // Legacy single-object contract (web/play/src/bridge.ts BridgeRequest).
    const req = { method, path, headers, signal: new AbortController().signal };
    if (body instanceof Uint8Array) req.rawBody = body;
    else if (typeof body === "string" && body.length) {
      try { req.jsonBody = JSON.parse(body); } catch (_) { req.jsonBody = body; }
    }
    const res = await bridge.request(req);
    return normalizeBridgeResponse(res);
  }

  function stream(path, onData, onError) {
    // Prefer a native async-iterable stream() if the bridge exposes one.
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
    // Otherwise drive the bridge's fetch-shaped streaming response through the SSE parser.
    return fetchStream(
      (p, init) => request("GET", p, init).then(bridgeResToResponse),
      path,
      onData,
      onError,
    );
  }

  return { request, stream, base: BRIDGE_BASE_URL };
}

/** Transport over a same-origin "/ce" reverse proxy to a native node. */
function proxyTransport(prefix) {
  const root = String(prefix).replace(/\/+$/, "");
  async function request(method, path, init) {
    const headers = Object.assign({}, (init && init.headers) || {});
    const body = init && init.body;
    if (body != null && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(root + path, { method, headers, body });
    const ct = res.headers.get("content-type") || "";
    let out = { status: res.status };
    if (ct.includes("application/json")) {
      out.json = res.status === 204 ? null : await res.json().catch(() => null);
    } else if (ct.includes("octet-stream") || ct.includes("application/")) {
      out.bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      out.text = await res.text();
    }
    return out;
  }
  function stream(path, onData, onError) {
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

function normalizeBridgeResponse(res) {
  if (!res || typeof res !== "object") return { status: 502, json: null };
  // New contract: {status, headers, body}. Coerce body by content-type / shape.
  if ("body" in res && !("json" in res) && !("text" in res) && !("bytes" in res)) {
    const status = res.status ?? 200;
    const body = res.body;
    if (body instanceof Uint8Array) return { status, bytes: body };
    if (typeof body === "string") {
      try { return { status, json: JSON.parse(body) }; } catch (_) { return { status, text: body }; }
    }
    return { status, json: body ?? null };
  }
  return res; // legacy {status, json|text|bytes}
}

/** Adapt a normalized bridge response to a Response so the SSE parser can read it. */
function bridgeResToResponse(out) {
  if (out.bytes !== undefined) {
    return new Response(out.bytes, { status: out.status, headers: { "content-type": "application/octet-stream" } });
  }
  if (out.text !== undefined) {
    return new Response(out.text, { status: out.status, headers: { "content-type": "text/event-stream" } });
  }
  return new Response(JSON.stringify(out.json ?? null), { status: out.status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// SSE stream parsing (zero-dep) — one shared inbound stream per client
// ---------------------------------------------------------------------------

function stripDataPrefix(s) {
  // bridge.stream() yields decoded data payloads already; tolerate a leading "data: ".
  return s.startsWith("data:") ? s.replace(/^data:\s?/, "").replace(/\n\n$/, "") : s;
}

/**
 * Open GET <path> as text/event-stream, parse `data:` frames (handling cross-chunk
 * boundaries and multi-line data), and call onData(payload) per event. Reconnects with
 * backoff on error. Returns a close() function.
 */
function fetchStream(doFetch, path, onData, onError) {
  let closed = false;
  let ctrl = null;
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
          let nl;
          while ((nl = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).replace(/^ /, ""))
              .join("\n");
            if (data) {
              try { onData(data); } catch (_) {}
            }
          }
        }
      } catch (err) {
        if (closed) return;
        if (onError) try { onError(err); } catch (_) {}
      }
      if (closed) return;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 8000);
    }
  }
  loop();
  return () => {
    closed = true;
    if (ctrl) try { ctrl.abort(); } catch (_) {}
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// hex + payload helpers (the node carries payloads as `payload_hex`)
// ---------------------------------------------------------------------------

const HEX = "0123456789abcdef";
function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xf];
  }
  return s;
}
function fromHex(hex) {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
const ENC = new TextEncoder();
const DEC = new TextDecoder();
function encodeJson(obj) {
  return toHex(ENC.encode(JSON.stringify(obj)));
}
function decodeJsonHex(hex) {
  try {
    return JSON.parse(DEC.decode(fromHex(hex)));
  } catch (_) {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared inbound mesh stream: fan one SSE stream out to many topic subscribers
// ---------------------------------------------------------------------------

function makeInbox(node) {
  const byTopic = new Map(); // topic -> Set<fn(msg)>
  let closeStream = null;
  let refcount = 0;

  function ensureStream() {
    if (closeStream) return;
    closeStream = node.stream(
      "/mesh/messages/stream",
      (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch (_) { return; }
        const set = byTopic.get(msg.topic);
        if (!set) return;
        for (const fn of set) {
          try { fn(msg); } catch (_) {}
        }
      },
      () => {},
    );
  }

  return {
    on(topic, fn) {
      let set = byTopic.get(topic);
      if (!set) byTopic.set(topic, (set = new Set()));
      set.add(fn);
      refcount++;
      ensureStream();
      return () => {
        set.delete(fn);
        if (set.size === 0) byTopic.delete(topic);
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

function resolveAppId(opts) {
  if (opts && opts.app) return String(opts.app);
  try {
    const m = location.pathname.match(/\/apps\/([^/]+)\//);
    if (m && m[1]) return decodeURIComponent(m[1]);
    const h = location.hostname.match(/^([a-z0-9][a-z0-9-]*)\./i);
    if (h && !["www", "relay", "docs", "p2p", "localhost"].includes(h[1].toLowerCase())) {
      return h[1];
    }
  } catch (_) {
    /* non-browser env */
  }
  return "demo";
}

function resolveBase() {
  try {
    return location.origin;
  } catch (_) {
    return "";
  }
}

// A stable-ish per-client writer id (for LWW tiebreaks and dedup). Best-effort: the node
// authenticates the real sender as `msg.from`; this is only a local logical-clock identity.
function makeWriterId() {
  try {
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
      const b = new Uint8Array(8);
      globalThis.crypto.getRandomValues(b);
      return toHex(b);
    }
  } catch (_) {}
  return (Date.now().toString(16) + Math.random().toString(16).slice(2)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// createClient
// ---------------------------------------------------------------------------

export function createClient(opts = {}) {
  const appId = resolveAppId(opts);
  const base = resolveBase();
  const node = connectNode(opts);
  const inbox = makeInbox(node);
  const writerId = makeWriterId();

  const dbTopic = `ce-coord/app/${appId}/db`;
  const dbSnapTopic = `ce-coord/app/${appId}/db/snapshot`;

  // -- converged per-app map (last-writer-wins on a (lamport, writer) clock) --
  // entry: { value, deleted, clock: { l, w } }
  const state = new Map();
  let lamport = 0;
  let dbReady = null; // Promise resolved once initial catch-up has been attempted

  function clockNewer(a, b) {
    if (a.l !== b.l) return a.l > b.l;
    return a.w > b.w; // deterministic tiebreak
  }

  function applyOp(op) {
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

  async function subscribe(topic) {
    return node.request("POST", "/mesh/subscribe", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic }),
    });
  }

  // Subscribe to the db op + snapshot topics so the node delivers them on the SSE stream,
  // then consume converging ops from the shared inbound stream.
  subscribe(dbTopic).catch(() => {});
  subscribe(dbSnapTopic).catch(() => {});
  inbox.on(dbTopic, (msg) => {
    const op = decodeJsonHex(msg.payload_hex || "");
    if (op) applyOp(op);
  });

  // Serve + request snapshots so fresh clients catch up without replaying the whole log.
  inbox.on(dbSnapTopic, async (msg) => {
    const m = decodeJsonHex(msg.payload_hex || "");
    if (!m) return;
    if (m.kind === "request") {
      // Publish our snapshot CID so the requester can pull it from /blobs.
      const cid = await putSnapshot().catch(() => null);
      if (cid) await publish(dbSnapTopic, { kind: "offer", cid, at: Date.now() });
    } else if (m.kind === "offer" && m.cid) {
      await loadSnapshot(m.cid).catch(() => {});
    }
  });

  async function publish(topic, obj) {
    return node.request("POST", "/mesh/publish", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, payload_hex: encodeJson(obj) }),
    });
  }

  async function putSnapshot() {
    const entries = [];
    for (const [k, e] of state) entries.push([k, e]);
    const bytes = ENC.encode(JSON.stringify({ v: 1, lamport, entries }));
    const res = await node.request("POST", "/blobs", {
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (res.json && res.json.hash) return res.json.hash;
    if (res.text) {
      try { return JSON.parse(res.text).hash; } catch (_) {}
    }
    return null;
  }

  async function loadSnapshot(cid) {
    const res = await node.request("GET", `/blobs/${encodeURIComponent(cid)}`, {});
    let snap;
    if (res.bytes) snap = JSON.parse(DEC.decode(res.bytes));
    else if (res.text) snap = JSON.parse(res.text);
    else if (res.json) snap = res.json;
    if (!snap || !Array.isArray(snap.entries)) return;
    for (const [k, e] of snap.entries) {
      applyOp({ key: k, value: e.value, deleted: e.deleted, clock: e.clock, at: e.at });
    }
  }

  // Subscribe + fire an initial catch-up request; resolve dbReady after a short grace.
  function ensureDbReady() {
    if (dbReady) return dbReady;
    dbReady = (async () => {
      await publish(dbSnapTopic, { kind: "request", at: Date.now() }).catch(() => {});
      // Brief grace for an offer + snapshot pull to converge before first read.
      await sleep(300);
    })();
    return dbReady;
  }

  function nextClock() {
    lamport += 1;
    return { l: lamport, w: writerId };
  }

  const db = {
    async get(key) {
      await ensureDbReady();
      const e = state.get(String(key));
      if (!e || e.deleted) return undefined;
      return e.value;
    },
    async set(key, val) {
      const k = String(key);
      const op = { key: k, value: val ?? null, deleted: false, clock: nextClock(), at: Date.now() };
      applyOp(op);
      await publish(dbTopic, op);
      return { ok: true, key: k };
    },
    async del(key) {
      const k = String(key);
      const op = { key: k, deleted: true, clock: nextClock(), at: Date.now() };
      applyOp(op);
      await publish(dbTopic, op);
      return { ok: true };
    },
    async list(prefix, limit) {
      await ensureDbReady();
      const pre = prefix == null ? "" : String(prefix);
      const items = [];
      for (const [key, e] of state) {
        if (e.deleted) continue;
        if (pre && !key.startsWith(pre)) continue;
        items.push({ key, value: e.value, at: e.at || 0 });
      }
      // newest-first by write time, then by lamport-ish key order as a stable fallback.
      items.sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : -1));
      const out = items.map(({ key, value }) => ({ key, value }));
      return limit != null ? out.slice(0, Number(limit)) : out;
    },
  };

  // -- realtime room over mesh pub/sub --
  function room(name) {
    const topic = `ce-app/${appId}/room/${name}`;
    let closed = false;
    let opened = false;
    const msgHandlers = new Set();
    const openHandlers = new Set();
    const outbox = [];
    let offInbox = null;

    function flushOutbox() {
      for (const data of outbox.splice(0)) {
        publish(topic, data).catch(() => {});
      }
    }
    function markOpen() {
      if (opened || closed) return;
      opened = true;
      flushOutbox();
      for (const fn of openHandlers) {
        try { fn(); } catch (_) {}
      }
    }

    // Subscribe to the topic, then attach to the shared inbound stream.
    node
      .request("POST", "/mesh/subscribe", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic }),
      })
      .then(() => markOpen(), () => markOpen());

    offInbox = inbox.on(topic, (msg) => {
      let payload = decodeJsonHex(msg.payload_hex || "");
      if (payload === undefined) {
        // Not JSON — surface the raw decoded text.
        try { payload = DEC.decode(fromHex(msg.payload_hex || "")); } catch (_) { return; }
      }
      for (const fn of msgHandlers) {
        try { fn(payload); } catch (_) {}
      }
    });

    return {
      send(obj) {
        const data = typeof obj === "string" ? obj : obj;
        if (opened) publish(topic, data).catch(() => {});
        else outbox.push(data);
      },
      on(fn) {
        msgHandlers.add(fn);
        return () => msgHandlers.delete(fn);
      },
      onOpen(fn) {
        openHandlers.add(fn);
        if (opened) {
          try { fn(); } catch (_) {}
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

// ---------------------------------------------------------------------------
// Tiny self-check (runs only under Node with CE_CLIENT_SELFCHECK=1; no-op in browsers).
// Verifies the LWW convergence + hex codec with a fake in-process node bridge, so the
// db/room logic is exercised without any network or real node.
// ---------------------------------------------------------------------------
async function __selfCheck() {
  // Build a fake bridge that loops published mesh messages back into its own SSE stream,
  // and serves /blobs from an in-memory map. Two clients share it -> converge.
  const blobs = new Map();
  const listeners = new Set();
  const subs = new Set();
  const bridge = {
    async request(method, path, init) {
      const body = init && init.body;
      if (path === "/mesh/publish") {
        const { topic, payload_hex } = JSON.parse(body);
        if (subs.has(topic)) {
          const frame = JSON.stringify({ from: "self", topic, payload_hex, received_at: Date.now() });
          for (const l of listeners) l(frame);
        }
        return { status: 200, json: null };
      }
      if (path === "/mesh/subscribe") {
        subs.add(JSON.parse(body).topic);
        return { status: 200, json: null };
      }
      if (path === "/blobs") {
        const bytes = body; // Uint8Array
        const hash = "h" + blobs.size;
        blobs.set(hash, bytes);
        return { status: 200, json: { hash } };
      }
      if (path.startsWith("/blobs/")) {
        const hash = decodeURIComponent(path.slice("/blobs/".length));
        return { status: 200, bytes: blobs.get(hash) };
      }
      return { status: 404, json: null };
    },
    async *stream(_path, signal) {
      const queue = [];
      let wake;
      const push = (f) => {
        queue.push(f);
        if (wake) wake();
      };
      listeners.add(push);
      try {
        while (!signal.aborted) {
          if (queue.length === 0) await new Promise((r) => (wake = r));
          while (queue.length) yield queue.shift();
        }
      } finally {
        listeners.delete(push);
      }
    },
  };
  globalThis.__ceNode = bridge;

  const assert = (c, m) => { if (!c) throw new Error("selfcheck failed: " + m); };

  const a = createClient({ app: "t" });
  const b = createClient({ app: "t" });

  // room round-trip
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("room timeout")), 2000);
    const rb = b.room("lobby");
    rb.on((msg) => {
      if (msg && msg.hi === 1) { clearTimeout(timer); resolve(); }
    });
    const ra = a.room("lobby");
    ra.onOpen(() => setTimeout(() => ra.send({ hi: 1 }), 50));
  });

  // db converge + LWW
  await a.db.set("k", { n: 1 });
  await new Promise((r) => setTimeout(r, 100));
  const got = await b.db.get("k");
  assert(got && got.n === 1, "db.get converged across clients");

  await b.db.set("k", { n: 2 });
  await new Promise((r) => setTimeout(r, 100));
  const got2 = await a.db.get("k");
  assert(got2 && got2.n === 2, "LWW: later write wins");

  await a.db.set("p:1", "x");
  await a.db.set("p:2", "y");
  await new Promise((r) => setTimeout(r, 100));
  const list = await a.db.list("p:", 10);
  assert(list.length === 2, "list prefix filter");
  assert(list[0].key === "p:2", "list newest-first");

  await a.db.del("k");
  await new Promise((r) => setTimeout(r, 100));
  assert((await b.db.get("k")) === undefined, "del converges");

  console.log("ce/client selfcheck: PASS");
}

if (typeof process !== "undefined" && process.env && process.env.CE_CLIENT_SELFCHECK === "1") {
  __selfCheck().then(
    () => process.exit(0),
    (e) => { console.error(e); process.exit(1); },
  );
}
