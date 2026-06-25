// DRIFT RUNTIME — the control-plane + transport glue that turns the deterministic
// drift-sim (a wasm host) and the drift-client (a wasm renderer) into a live,
// region-sharded, failover-safe multiplayer world on CE hub primitives ONLY.
//
// ESM. Runs in the browser AND in Node 22+ (global fetch + WebSocket). Zero deps,
// no build step. The sim/ and client/ wasm modules are produced by other owners;
// this file is the JS that wires them to the hub.
//
// ARCHITECTURE  (MESH-NATIVE: drift's own data + state plane talk ONLY to the local
// node — the window.__ceNode bridge or a same-origin "/ce" reverse proxy — via the
// inlined mesh client createMeshClient above. No ce-net.com/db, no wss /rt for any
// data drift owns.)
// ------------
// netgame.js is the CONTROL PLANE: deterministic, coordinator-free host election
// over a per-region control room (text frames only — candidacy, host-change,
// liveness). We DO NOT push the high-rate authoritative state through netgame's
// JSON {t:"st"} channel; instead the elected host streams authoritative binary
// StateFrames over a SEPARATE mesh room (base64-wrapped over mesh pub/sub via the
// mesh client's roomRaw). This keeps the election/snapshot logic intact while the
// state path stays compact and full-rate.
//
//   control room :  ce-app/drift/.../r:<gx>:<gy>          (netgame; election)
//   state room   :  ce-app/drift/raw/r:<gx>:<gy>::st      (binary StateFrames, mesh)
//
// NOTE on the control plane: netgame.js (a SEPARATE, out-of-scope file) still drives
// its election/liveness frames over its own transport; drift passes it a SAME-ORIGIN
// base so it never reaches a remote origin. Migrating netgame's transport onto the
// mesh client is a follow-up tracked outside this file.
//
// Per-client AREA OF INTEREST: each client advertises its view center+radius on
// the control room ({t:"aoi"}); the host streams each client a StateFrame built
// from snapshot_aoi() around that client's center, so bandwidth scales with what
// a player can see, not the whole world.
//
// SNAPSHOT / FAILOVER: the host writes a full binary snapshot to the mesh db key
// snap:r:<gx>:<gy> every snapshotEvery ticks (term-ordered).
// On host death, netgame re-elects; the new host restore()s the world from that
// /db snapshot, so play continues with at most snapshotEvery/hz seconds of loss.
//
// REGION SHARDING: the world is a grid of regions r:<gx>:<gy>. /db/world/dir is a
// directory mapping region -> owning host. A client crossing a region boundary
// switches its control+state rooms (region-switch). Entities crossing a shard
// boundary are handed off host->host with an idempotent {t:"xfer"}/{t:"xack"}
// exchange so an entity is never duplicated or dropped.
//
// HYBRID HOSTING: a benchmark-selected stable node (host.mjs, server-class score)
// is PREFERRED as the authoritative host; if it is absent the browsers elect one
// of themselves (netgame's normal election). Pinned-preferred, browser-fallback.
//
// The wasm "host" (sim) interface this file expects (see makeWasmHost / host.mjs):
//   newWorld(seed, arenaHalf, asteroids) -> handle
//   applyInput(handle, bytes)            -> bool      (bincode InputFrame)
//   step(handle)                         -> tick:number
//   snapshotFull(handle)                 -> Uint8Array (bincode Snapshot)
//   snapshotAoi(handle, x, y, radius)    -> Uint8Array (bincode Snapshot)
//   restore(handle, bytes)               -> bool
//   spawnShip(handle, controller, x, y, angle) -> entityId
//   free(handle)
//
// HARD RULE: no emojis anywhere.

import { createGame } from "../../ce-app/client/netgame.js";

// ---- environment helpers (mirror netgame's, so the runtime stands alone) -------------

function resolveBase(opts) {
  if (opts && opts.base) return String(opts.base).replace(/\/+$/, "");
  try {
    if (typeof location !== "undefined" && location.origin) return location.origin;
  } catch (_) {
    /* non-browser */
  }
  return "";
}

function pickWebSocket(opts) {
  if (opts && opts.WebSocket) return opts.WebSocket;
  if (typeof WebSocket !== "undefined") return WebSocket;
  if (typeof globalThis !== "undefined" && globalThis.WebSocket) return globalThis.WebSocket;
  throw new Error("drift: no WebSocket available — pass opts.WebSocket (Node <22 needs 'ws')");
}

function pickFetch(opts) {
  if (opts && opts.fetch) return opts.fetch;
  if (typeof fetch !== "undefined") return fetch.bind(globalThis);
  if (typeof globalThis !== "undefined" && globalThis.fetch) return globalThis.fetch.bind(globalThis);
  throw new Error("drift: no fetch available — pass opts.fetch");
}

const now = () => Date.now();

// ---- base64 (binary fallback over text rooms) ----------------------------------------

function bytesToB64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  // eslint-disable-next-line no-undef
  return btoa(bin);
}

function b64ToBytes(b64) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  // eslint-disable-next-line no-undef
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

// =====================================================================================
// MESH CLIENT — same-origin only (window.__ceNode bridge, else "/ce" reverse proxy).
// This is the mesh-native @ce/client (web/ce-app/client/index.js) inlined for drift:
//   db        — per-app LWW gossipsub map + blob snapshots (snapshot/handoff/directory)
//   room      — JSON mesh pub/sub
//   roomRaw   — mesh pub/sub carrying base64-wrapped BINARY StateFrames (drift's st2 path)
// Drift never opens wss://.../rt or fetches /db directly anymore; everything rides the
// node's /mesh/* + /blobs over a same-origin transport. NO ce-net.com/db, /rt, wss.
// =====================================================================================
function createMeshClient(opts) {
  opts = opts || {};
  const BRIDGE_BASE = "http://ce-browser-node.local";
  function bridge() { try { const b = globalThis.__ceNode; return (b && typeof b.request === "function") ? b : null; } catch (_) { return null; } }
  // Browser: the in-process bridge, else the same-origin "/ce" proxy. Node hosts
  // (host.mjs) have no bridge and no same-origin "/ce" — they pass an explicit node
  // base via opts.ce (or opts.base) so the headless host reaches its co-located node.
  function node() { const b = bridge(); if (b) return bridgeT(b); return proxyT(opts.ce || opts.base || "/ce"); }
  function bridgeT(b) {
    async function request(m, p, init) { const h = (init && init.headers) || {}, body = init && init.body; return normB(await b.request(m, p, { headers: h, body })); }
    function stream(p, onData, onErr) {
      if (typeof b.stream === "function") { const c = new AbortController(); (async () => { try { for await (const d of b.stream(p, c.signal)) { if (c.signal.aborted) return; if (d) onData(strip(d)); } } catch (e) { if (!c.signal.aborted && onErr) onErr(e); } })(); return () => c.abort(); }
      return sse((pp, init) => request("GET", pp, init).then(brToResp), p, onData, onErr);
    }
    return { request, stream, base: BRIDGE_BASE };
  }
  function proxyT(prefix) {
    const root = String(prefix).replace(/\/+$/, "");
    async function request(m, p, init) {
      const h = Object.assign({}, (init && init.headers) || {}), body = init && init.body;
      if (body != null && !h["content-type"] && !h["Content-Type"]) h["content-type"] = "application/json";
      const doFetch = opts.fetch || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
      if (!doFetch) throw new Error("drift mesh: no fetch available");
      const res = await doFetch(root + p, { method: m, headers: h, body });
      const ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "", out = { status: res.status };
      if (ct.indexOf("application/json") >= 0) out.json = res.status === 204 ? null : await res.json().catch(() => null);
      else if (ct.indexOf("octet-stream") >= 0) out.bytes = new Uint8Array(await res.arrayBuffer());
      else out.text = await res.text();
      return out;
    }
    function stream(p, onData, onErr) {
      const doFetch = opts.fetch || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
      return sse((pp, init) => doFetch(root + pp, { method: "GET", headers: Object.assign({ Accept: "text/event-stream" }, init && init.headers), signal: init && init.signal }), p, onData, onErr);
    }
    return { request, stream, base: root };
  }
  function normB(res) { if (!res || typeof res !== "object") return { status: 502, json: null }; if ("body" in res && !("json" in res) && !("text" in res) && !("bytes" in res)) { const st = res.status == null ? 200 : res.status, b = res.body; if (b instanceof Uint8Array) return { status: st, bytes: b }; if (typeof b === "string") { try { return { status: st, json: JSON.parse(b) }; } catch (_) { return { status: st, text: b }; } } return { status: st, json: b == null ? null : b }; } return res; }
  function brToResp(o) { if (o.bytes !== undefined) return new Response(o.bytes, { status: o.status, headers: { "content-type": "application/octet-stream" } }); if (o.text !== undefined) return new Response(o.text, { status: o.status, headers: { "content-type": "text/event-stream" } }); return new Response(JSON.stringify(o.json == null ? null : o.json), { status: o.status, headers: { "content-type": "application/json" } }); }
  function strip(s) { return s.indexOf("data:") === 0 ? s.replace(/^data:\s?/, "").replace(/\n\n$/, "") : s; }
  function sse(doFetch, path, onData, onErr) { let closed = false, ctrl = null, backoff = 500; (async function loop() { while (!closed) { ctrl = new AbortController(); try { const res = await doFetch(path, { signal: ctrl.signal }); if (!res || !res.ok || !res.body) throw new Error("stream " + path + " -> " + (res && res.status)); backoff = 500; const reader = res.body.getReader(), dec = new TextDecoder(); let buf = ""; for (;;) { const r = await reader.read(); if (r.done) break; buf += dec.decode(r.value, { stream: true }); let nl; while ((nl = buf.indexOf("\n\n")) !== -1) { const frame = buf.slice(0, nl); buf = buf.slice(nl + 2); const data = frame.split("\n").filter((l) => l.indexOf("data:") === 0).map((l) => l.slice(5).replace(/^ /, "")).join("\n"); if (data) { try { onData(data); } catch (_) {} } } } } catch (e) { if (closed) return; if (onErr) try { onErr(e); } catch (_) {} } if (closed) return; await new Promise((rs) => setTimeout(rs, backoff)); backoff = Math.min(backoff * 2, 8000); } })(); return () => { closed = true; if (ctrl) try { ctrl.abort(); } catch (_) {} }; }
  const HEXC = "0123456789abcdef";
  function toHex(b) { let s = ""; for (let i = 0; i < b.length; i++) s += HEXC[b[i] >> 4] + HEXC[b[i] & 15]; return s; }
  function fromHex(h) { const c = h.length % 2 ? "0" + h : h, o = new Uint8Array(c.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(c.substr(i * 2, 2), 16); return o; }
  const EN = new TextEncoder(), DE = new TextDecoder();
  function encJson(o) { return toHex(EN.encode(JSON.stringify(o))); }
  function decJson(h) { try { return JSON.parse(DE.decode(fromHex(h))); } catch (_) { return undefined; } }
  const appId = String(opts.app || "drift");
  const nd = node();
  const byTopic = new Map(); let closeStream = null, refc = 0;
  function ensureStream() { if (closeStream) return; closeStream = nd.stream("/mesh/messages/stream", (data) => { let msg; try { msg = JSON.parse(data); } catch (_) { return; } const set = byTopic.get(msg.topic); if (!set) return; set.forEach((fn) => { try { fn(msg); } catch (_) {} }); }, () => {}); }
  function on(topic, fn) { let set = byTopic.get(topic); if (!set) byTopic.set(topic, set = new Set()); set.add(fn); refc++; ensureStream(); return () => { set.delete(fn); if (set.size === 0) byTopic.delete(topic); if (--refc <= 0 && closeStream) { closeStream(); closeStream = null; refc = 0; } }; }
  function subscribe(topic) { return nd.request("POST", "/mesh/subscribe", { headers: { "content-type": "application/json" }, body: JSON.stringify({ topic }) }); }
  function publish(topic, obj) { return nd.request("POST", "/mesh/publish", { headers: { "content-type": "application/json" }, body: JSON.stringify({ topic, payload_hex: encJson(obj) }) }); }
  const writerId = (function () { try { if (globalThis.crypto && globalThis.crypto.getRandomValues) { const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b); return toHex(b); } } catch (_) {} return (Date.now().toString(16) + Math.random().toString(16).slice(2)).slice(0, 16); })();
  const dbTopic = "ce-coord/app/" + appId + "/db", dbSnapT = dbTopic + "/snapshot";
  const state = new Map(); let lamport = 0, dbReady = null;
  function newer(a, b) { if (a.l !== b.l) return a.l > b.l; return a.w > b.w; }
  function applyOp(op) { if (!op || typeof op.key !== "string" || !op.clock) return false; lamport = Math.max(lamport, op.clock.l); const cur = state.get(op.key); if (cur && !newer(op.clock, cur.clock)) return false; state.set(op.key, { value: op.deleted ? undefined : op.value, deleted: !!op.deleted, clock: op.clock, at: op.at || 0 }); return true; }
  subscribe(dbTopic).catch(() => {}); subscribe(dbSnapT).catch(() => {});
  on(dbTopic, (msg) => { const op = decJson(msg.payload_hex || ""); if (op) applyOp(op); });
  on(dbSnapT, async (msg) => { const m = decJson(msg.payload_hex || ""); if (!m) return; if (m.kind === "request") { const cid = await putSnap().catch(() => null); if (cid) await publish(dbSnapT, { kind: "offer", cid, at: Date.now() }); } else if (m.kind === "offer" && m.cid) { await loadSnap(m.cid).catch(() => {}); } });
  async function putSnap() { const entries = []; state.forEach((e, k) => entries.push([k, e])); const bytes = EN.encode(JSON.stringify({ v: 1, lamport, entries })); const res = await nd.request("POST", "/blobs", { headers: { "content-type": "application/octet-stream" }, body: bytes }); if (res.json && res.json.hash) return res.json.hash; if (res.text) { try { return JSON.parse(res.text).hash; } catch (_) {} } return null; }
  async function loadSnap(cid) { const res = await nd.request("GET", "/blobs/" + encodeURIComponent(cid), {}); let snap; if (res.bytes) snap = JSON.parse(DE.decode(res.bytes)); else if (res.text) snap = JSON.parse(res.text); else if (res.json) snap = res.json; if (!snap || !Array.isArray(snap.entries)) return; snap.entries.forEach((p) => applyOp({ key: p[0], value: p[1].value, deleted: p[1].deleted, clock: p[1].clock, at: p[1].at })); }
  function ensureReady() { if (dbReady) return dbReady; dbReady = (async () => { await publish(dbSnapT, { kind: "request", at: Date.now() }).catch(() => {}); await new Promise((r) => setTimeout(r, 300)); })(); return dbReady; }
  function nextClock() { lamport += 1; return { l: lamport, w: writerId }; }
  const db = {
    async get(key) { await ensureReady(); const e = state.get(String(key)); if (!e || e.deleted) return undefined; return e.value; },
    async set(key, val) { const k = String(key), op = { key: k, value: val == null ? null : val, deleted: false, clock: nextClock(), at: Date.now() }; applyOp(op); await publish(dbTopic, op); return { ok: true, key: k }; },
    async del(key) { const k = String(key), op = { key: k, deleted: true, clock: nextClock(), at: Date.now() }; applyOp(op); await publish(dbTopic, op); return { ok: true }; },
    async list(prefix, limit) { await ensureReady(); const pre = prefix == null ? "" : String(prefix), items = []; state.forEach((e, key) => { if (e.deleted) return; if (pre && key.indexOf(pre) !== 0) return; items.push({ key, value: e.value, at: e.at || 0 }); }); items.sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : -1)); const out = items.map((it) => ({ key: it.key, value: it.value })); return limit != null ? out.slice(0, Number(limit)) : out; },
  };
  // JSON room (drift uses these only for the optional onState summary path).
  function room(name) {
    const topic = "ce-app/" + appId + "/room/" + name; let opened = false, closed = false; const msgH = new Set(), openH = new Set(); let offInbox = null;
    function markOpen() { if (opened || closed) return; opened = true; openH.forEach((fn) => { try { fn(); } catch (_) {} }); }
    subscribe(topic).then(markOpen, markOpen);
    offInbox = on(topic, (msg) => { const pl = decJson(msg.payload_hex || ""); msgH.forEach((fn) => { try { fn(pl, msg); } catch (_) {} }); });
    return { send: (o) => publish(topic, o).catch(() => {}), on: (fn) => { msgH.add(fn); return () => msgH.delete(fn); }, onOpen: (fn) => { openH.add(fn); if (opened) try { fn(); } catch (_) {} ; return () => openH.delete(fn); }, close: () => { closed = true; if (offInbox) offInbox(); } };
  }
  // Binary room: drift's authoritative StateFrames. Bytes ride a JSON frame {b:<base64>}
  // on a dedicated mesh topic. on(cb) yields Uint8Array; send(bytes) publishes one frame.
  function roomRaw(name) {
    const topic = "ce-app/" + appId + "/raw/" + name; let opened = false, closed = false; const msgH = new Set(), openH = new Set(); let offInbox = null;
    function markOpen() { if (opened || closed) return; opened = true; openH.forEach((fn) => { try { fn(); } catch (_) {} }); }
    subscribe(topic).then(markOpen, markOpen);
    offInbox = on(topic, (msg) => { const m = decJson(msg.payload_hex || ""); if (!m || typeof m.b !== "string") return; let bytes; try { bytes = b64ToBytes(m.b); } catch (_) { return; } msgH.forEach((fn) => { try { fn(bytes, msg); } catch (_) {} }); });
    return { send: (bytes) => publish(topic, { b: bytesToB64(bytes) }).catch(() => {}), on: (fn) => { msgH.add(fn); return () => msgH.delete(fn); }, onOpen: (fn) => { openH.add(fn); if (opened) try { fn(); } catch (_) {} ; return () => openH.delete(fn); }, close: () => { closed = true; if (offInbox) offInbox(); } };
  }
  return { appId, db, room, roomRaw };
}

// ---- region grid ---------------------------------------------------------------------

const REGION_SIZE_DEFAULT = 4096; // world units per region edge (matches POS_RANGE*2)

/** Region cell for a world coordinate. */
function regionOf(x, y, size) {
  return { gx: Math.floor(x / size), gy: Math.floor(y / size) };
}

/** Canonical control-room name for a region. */
function regionRoom(gx, gy) {
  return "r:" + gx + ":" + gy;
}

/** The 8 neighbours of a region (for boundary handoff scanning). */
function neighbourRegions(gx, gy) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      out.push({ gx: gx + dx, gy: gy + dy });
    }
  }
  return out;
}

// =====================================================================================
// createDriftRuntime — the public entry point. Browser app and host.mjs both call this.
// =====================================================================================
//
// opts:
//   app            "drift" (the ce-app namespace; default)
//   id             stable participant id (default: random)
//   base           hub origin override (default location.origin)
//   region         { gx, gy } initial region (default 0,0)
//   regionSize     world units per region edge (default 4096)
//   hz             authoritative tick rate (default 30)
//   snapshotEvery  ticks between /db snapshots (default 60)
//   aoiRadius      area-of-interest radius in world units (default regionSize)
//   server         hint: dedicated/server-class participant (raises election score)
//   canHost        eligible to be elected host (default true)
//   host           a wasm host factory (only the elected host needs it). Either an
//                  object implementing the wasm-host interface above, or a function
//                  () => host(Promise). Browsers usually pass none and just render.
//   makeWorld      () => handle override for the host's initial world (else host.newWorld)
//   onAuthFrame    (bytes, meta) => void  — raw binary StateFrame for the renderer
//   onState        (decoded, meta) => void — OPTIONAL JSON-state hook (control summaries)
//   onHostChange   (meta) => void
//   onRegionChange (region, meta) => void
//   input          () => Uint8Array | null  — this client's serialized InputFrame bytes
//   viewCenter     () => {x,y} | null  — AoI center (default 0,0)
//   WebSocket/fetch injection for Node.
//
// Returns a handle: { setRegion, region, sendInput, sendEvent, isHost, hostId,
//   metrics, leave, directory }.
export function createDriftRuntime(opts = {}) {
  const app = String(opts.app || "drift");
  const id = String(opts.id || randomId());
  const base = resolveBase(opts);
  const WS = pickWebSocket(opts);
  const doFetch = pickFetch(opts);
  // Mesh-native client for drift's OWN data + state plane (db snapshots/directory/handoff
  // and the binary StateFrame transport). Same-origin only; see createMeshClient above.
  const mesh = createMeshClient({ app, ce: opts.ce, fetch: opts.fetch });
  const hz = Math.max(1, Number(opts.hz) || 30);
  const snapshotEvery = Math.max(1, Number(opts.snapshotEvery) || 60);
  const regionSize = Math.max(1, Number(opts.regionSize) || REGION_SIZE_DEFAULT);
  const aoiRadius = Math.max(1, Number(opts.aoiRadius) || regionSize);
  const server = !!opts.server;
  const canHost = opts.canHost !== false;

  const onAuthFrame = typeof opts.onAuthFrame === "function" ? opts.onAuthFrame : () => {};
  const onState = typeof opts.onState === "function" ? opts.onState : () => {};
  const onHostChange = typeof opts.onHostChange === "function" ? opts.onHostChange : () => {};
  const onRegionChange = typeof opts.onRegionChange === "function" ? opts.onRegionChange : () => {};
  const inputFn = typeof opts.input === "function" ? opts.input : null;
  const viewCenter = typeof opts.viewCenter === "function" ? opts.viewCenter : () => ({ x: 0, y: 0 });

  // The wasm host (only meaningful when this participant actually hosts).
  const hostFactory = opts.host || null;

  // ---- current region -----------------------------------------------------------------
  let region = normRegion(opts.region) || { gx: 0, gy: 0 };

  // Per-region active session (control plane + state transport). Exactly one at a time.
  let session = null;

  // Cross-region directory cache (region key -> owner host id), refreshed from the mesh db.
  const directory = new Map();
  let dirTimer = null;
  // Per-region handoff mesh rooms (entity cross-shard transfer), opened lazily.
  const handoffRooms = new Map();

  // =====================================================================================
  // session: everything tied to ONE region (control room + ephemeral state room + host)
  // =====================================================================================
  function startSession(reg) {
    const room = regionRoom(reg.gx, reg.gy);
    const stateRoom = room + "::st";
    const snapKey = "snap:" + room;

    const s = {
      reg,
      room,
      stateRoom,
      snapKey,
      // control plane (election) via netgame
      game: null,
      // mesh binary state room (authoritative StateFrames; base64-wrapped over mesh pub/sub)
      stateRoomHandle: null,
      stateConnected: false,
      closed: false,
      binarySupported: true,
      // hosting
      amHost: false,
      worldHandle: null,
      wasmHost: null,
      tickTimer: null,
      tick: 0,
      lastSnapTick: -1,
      snapTerm: 0,
      // AoI registry: pid -> { x, y, r, ts }
      aoi: new Map(),
      // pending cross-shard handoffs we have applied (idempotency): xferId -> ts
      seenXfer: new Map(),
      // outgoing input cadence
      inputTimer: null,
      inSeq: 0,
      aoiTimer: null,
    };

    // -------- control plane: netgame election on the region control room --------
    s.game = createGame({
      app,
      room,
      id,
      hz,
      base,
      WebSocket: WS,
      fetch: doFetch,
      canHost,
      server,
      // The control plane runs a NEUTRAL keep-alive tick: it only tracks election +
      // liveness. We never push real game state through netgame's JSON channel; the
      // authoritative simulation runs in the wasm host and streams over the binary
      // state room. Keeping netgame's tick trivial avoids double-simulating.
      init: () => ({ region: room, started: now() }),
      // The control-plane host's tick is where netgame delivers every remote
      // sendEvent() payload (ctx.events): client inputs, AoI advertisements, and
      // cross-shard handoff/ack messages. We capture them into the session's control
      // queue; the authoritative wasm host loop (hostTick) drains it. State itself is
      // a trivial pass-through (the real simulation lives in the wasm host).
      tick: (st, _inputs, _dt, ctx) => {
        if (s._controlQueue && ctx && Array.isArray(ctx.events) && ctx.events.length) {
          for (const ev of ctx.events) s._controlQueue.push(ev);
          // bound the queue so a non-hosting lull cannot grow it without limit
          if (s._controlQueue.length > 4096) {
            s._controlQueue.splice(0, s._controlQueue.length - 4096);
          }
        }
        return st;
      },
      onState: (st, meta) => {
        onState(st, decorate(meta, s));
      },
      onHostChange: (meta) => {
        const becameHost = meta.isHost;
        if (becameHost && !s.amHost) {
          s.amHost = true;
          void beginHosting(s);
        } else if (!becameHost && s.amHost) {
          s.amHost = false;
          stopHosting(s);
        }
        publishDirectory(s, meta.host);
        onHostChange(decorate(meta, s));
      },
    });

    // -------- binary state transport (mesh room, base64-wrapped StateFrames) --------
    connectState(s);

    // -------- client cadence: advertise AoI + forward input over the CONTROL room --------
    s.aoiTimer = setInterval(() => advertiseAoi(s), Math.round(1000 / Math.min(hz, 10)));
    s.inputTimer = setInterval(() => pumpInput(s), Math.round(1000 / hz));

    session = s;
    return s;
  }

  function stopSession(s) {
    if (!s) return;
    s.closed = true;
    stopHosting(s);
    if (s.aoiTimer) clearInterval(s.aoiTimer);
    if (s.inputTimer) clearInterval(s.inputTimer);
    try { s.game && s.game.leave(); } catch (_) {}
    if (s.stateRoomHandle) {
      try { s.stateRoomHandle.close(); } catch (_) {}
    }
    s.stateRoomHandle = null;
  }

  // ---- binary state transport over a mesh room (base64-wrapped StateFrames) -------------
  // The authoritative host publishes binary StateFrames; clients receive them over the
  // node's mesh pub/sub (same-origin). Reconnection/backoff is handled inside the mesh
  // client's SSE loop, so this is just a subscribe + sink.
  function connectState(s) {
    if (s.closed) return;
    let handle;
    try {
      handle = mesh.roomRaw(s.stateRoom);
    } catch (_) {
      return;
    }
    s.stateRoomHandle = handle;
    handle.onOpen(() => { if (s.stateRoomHandle === handle) s.stateConnected = true; });
    handle.on((bytes) => {
      try { handleStateFrame(s, bytes); } catch (_) { /* never crash on a bad frame */ }
    });
  }

  function sendState(s, data) {
    // `data` is a Uint8Array StateFrame (binary). The mesh room base64-wraps it.
    const bytes = toBytes(data);
    if (s.stateRoomHandle && bytes) {
      try { s.stateRoomHandle.send(bytes); } catch (_) {}
    }
  }

  // A binary StateFrame is: [1-byte tag][bincode Snapshot/Delta...] where the high
  // 16 bytes prefix the target pid as a header so AoI streams can be unicast over a
  // broadcast room. Frame layout (host -> clients):
  //   byte 0      : kind (0 = full snapshot, 1 = delta, 2 = broadcast/no-target)
  //   bytes 1..9  : tick (LE u64, low 6 bytes meaningful — enough for any session)
  //   byte 9      : targetLen (0 = broadcast to all)
  //   bytes 10..  : target pid utf8 (targetLen bytes)
  //   then        : the bincode payload (Snapshot or Delta from drift-sim::net)
  function packStateFrame(kind, tick, targetPid, payload) {
    const target = targetPid ? new TextEncoder().encode(targetPid) : new Uint8Array(0);
    const header = new Uint8Array(10 + target.length);
    header[0] = kind & 0xff;
    // little-endian tick across bytes 1..8 (we only need ~6 bytes of range)
    let t = tick >>> 0;
    let hi = Math.floor(tick / 0x100000000);
    header[1] = t & 0xff; header[2] = (t >>> 8) & 0xff;
    header[3] = (t >>> 16) & 0xff; header[4] = (t >>> 24) & 0xff;
    header[5] = hi & 0xff; header[6] = (hi >>> 8) & 0xff;
    header[7] = 0; header[8] = 0;
    header[9] = target.length & 0xff;
    header.set(target, 10);
    const out = new Uint8Array(header.length + payload.length);
    out.set(header, 0);
    out.set(payload, header.length);
    return out;
  }

  function unpackStateFrame(bytes) {
    if (!bytes || bytes.length < 10) return null;
    const kind = bytes[0];
    const tick =
      bytes[1] + (bytes[2] << 8) + (bytes[3] << 16) + bytes[4] * 0x1000000 +
      (bytes[5] + bytes[6] * 256) * 0x100000000;
    const targetLen = bytes[9];
    const target = targetLen ? new TextDecoder().decode(bytes.subarray(10, 10 + targetLen)) : "";
    const payload = bytes.subarray(10 + targetLen);
    return { kind, tick, target, payload };
  }

  function handleStateFrame(s, data) {
    let bytes = toBytes(data);
    if (!bytes && typeof data === "string") {
      // base64 {t:"st2"} text fallback
      let obj;
      try { obj = JSON.parse(data); } catch (_) { return; }
      if (obj && obj.t === "st2" && typeof obj.b === "string") {
        bytes = b64ToBytes(obj.b);
        s.binarySupported = false; // a text frame arrived -> assume binary path is degraded
      } else {
        return;
      }
    }
    if (!bytes) return;
    const frame = unpackStateFrame(bytes);
    if (!frame) return;
    // Unicast targeting: a frame addressed to another pid is ignored.
    if (frame.target && frame.target !== id) return;
    // Hand the raw bincode payload to the renderer (the wasm client decodes it).
    onAuthFrame(frame.payload, {
      kind: frame.kind,
      tick: frame.tick,
      host: s.game ? s.game.hostId() : null,
      region: s.room,
      isHost: s.amHost,
    });
  }

  // ---- AoI advertisement (over the CONTROL room as a netgame event) --------------------
  function advertiseAoi(s) {
    if (!s.game) return;
    const c = safe(viewCenter, { x: 0, y: 0 }) || { x: 0, y: 0 };
    s.game.sendEvent({ k: "aoi", id, x: c.x | 0, y: c.y | 0, r: aoiRadius });
  }

  // ---- client input pump (over the CONTROL room as a netgame event) --------------------
  function pumpInput(s) {
    if (!inputFn || !s.game) return;
    const inp = safe(inputFn, null);
    if (inp == null) return;
    s.inSeq++;
    // Inputs are small bincode InputFrames; base64 them onto the text control room so
    // they reach the host deterministically alongside election traffic.
    const b = toBytes(inp);
    const payload = b ? bytesToB64(b) : null;
    if (payload == null) return;
    s.game.sendEvent({ k: "in", id, seq: s.inSeq, b: payload });
  }

  // =====================================================================================
  // HOSTING — only the elected host runs the wasm sim and streams StateFrames.
  // =====================================================================================
  async function beginHosting(s) {
    // Subscribe to this region's mesh handoff room so inbound cross-shard entities arrive.
    ensureHandoffInbox(s);
    // Acquire a wasm host: either the supplied object, or a factory/promise.
    let h = hostFactory;
    if (typeof h === "function") {
      try { h = await h(); } catch (_) { h = null; }
    } else if (h && typeof h.then === "function") {
      try { h = await h; } catch (_) { h = null; }
    }
    s.wasmHost = h || null;

    // Try restoring from the latest /db snapshot; else create a fresh world.
    const snap = await loadSnapshot(s);
    if (s.wasmHost) {
      if (snap && snap.bytes && s.wasmHost.restore) {
        s.worldHandle = s.wasmHost.newWorld
          ? s.wasmHost.newWorld(0, regionSize / 2, 0)
          : (s.worldHandle || 0);
        const ok = s.wasmHost.restore(s.worldHandle, snap.bytes);
        s.tick = snap.tick || 0;
        s.snapTerm = snap.term || 0;
        if (!ok) {
          s.worldHandle = makeFreshWorld(s);
          s.tick = 0;
        }
      } else {
        s.worldHandle = makeFreshWorld(s);
        s.tick = snap && snap.tick ? snap.tick : 0;
        s.snapTerm = snap && snap.term ? snap.term : 0;
      }
    }
    s.lastSnapTick = -1;
    if (s.tickTimer) clearInterval(s.tickTimer);
    s.tickTimer = setInterval(() => hostTick(s), Math.round(1000 / hz));
  }

  function makeFreshWorld(s) {
    if (typeof opts.makeWorld === "function") return safe(opts.makeWorld, 0, s.wasmHost, s.reg);
    if (s.wasmHost && s.wasmHost.newWorld) {
      const asteroids = Number(opts.asteroids) || 24;
      return s.wasmHost.newWorld(seedForRegion(s.reg), regionSize / 2, asteroids);
    }
    return 0;
  }

  function stopHosting(s) {
    if (s.tickTimer) {
      clearInterval(s.tickTimer);
      s.tickTimer = null;
    }
    if (s._handoffOff) { try { s._handoffOff(); } catch (_) {} s._handoffOff = null; }
    if (s.wasmHost && s.wasmHost.free && s.worldHandle) {
      try { s.wasmHost.free(s.worldHandle); } catch (_) {}
    }
    s.worldHandle = 0;
  }

  function hostTick(s) {
    if (!s.amHost || !s.wasmHost || !s.worldHandle) return;

    // 1) Drain control events the netgame host collected (inputs, aoi, xfer/xack).
    drainControl(s);

    // 2) Advance the authoritative world one fixed step.
    try {
      s.tick = Number(s.wasmHost.step(s.worldHandle)) || s.tick + 1;
    } catch (_) {
      s.tick++;
    }

    // 3) Stream a per-client AoI StateFrame to each known viewer (unicast over the
    //    shared ephemeral room via the frame's target header). Clients with no
    //    advertised AoI yet get a broadcast full snapshot so they can bootstrap.
    streamStateFrames(s);

    // 4) Cross-shard handoff: scan for entities that left this region and hand them
    //    to the neighbour's host (idempotent xfer).
    maybeHandoff(s);

    // 5) Periodic durable snapshot to /db (CAS-guarded) for failover.
    if (s.tick - s.lastSnapTick >= snapshotEvery) {
      s.lastSnapTick = s.tick;
      void writeSnapshot(s);
    }
  }

  // Pull events out of the netgame host's queue. netgame delivers remote events to
  // ctx.events on the host's tick. The control game's tick (in startSession) pushes those
  // events into s._controlQueue; here, on each authoritative wasm tick, we drain and apply
  // them: client inputs -> applyInput, AoI advertisements -> the viewer registry, and
  // cross-shard xfer/xack -> handoff adoption / ack bookkeeping.
  function drainControl(s) {
    const q = s._controlQueue;
    if (!q || q.length === 0) return;
    const drained = q.splice(0);
    for (const ev of drained) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.k === "in") {
        const b = ev.b ? b64ToBytes(ev.b) : null;
        if (b && s.wasmHost && s.wasmHost.applyInput) {
          try { s.wasmHost.applyInput(s.worldHandle, b); } catch (_) {}
        }
      } else if (ev.k === "aoi") {
        if (ev.id) s.aoi.set(ev.id, { x: Number(ev.x) || 0, y: Number(ev.y) || 0, r: Number(ev.r) || aoiRadius, ts: now() });
      } else if (ev.k === "xfer") {
        applyHandoff(s, ev);
      } else if (ev.k === "xack") {
        // Neighbour acked our handoff; nothing to retransmit for that xferId.
        if (ev.xferId) s.seenXfer.delete("out:" + ev.xferId);
      }
    }
    // Bound the idempotency set: drop xfer bookkeeping older than 60s. The /db mailbox
    // is the durable, at-least-once channel and adoptEntity is itself idempotent, so
    // forgetting old xferIds only risks re-adopting a long-departed entity once, which
    // adoptEntity ignores. This keeps memory flat over long-lived hosting.
    const xcut = now() - 60000;
    for (const [k, ts] of s.seenXfer) {
      if (ts < xcut) s.seenXfer.delete(k);
    }
  }

  function streamStateFrames(s) {
    const cutoff = now() - 5000;
    let any = false;
    for (const [pid, view] of s.aoi) {
      if (view.ts < cutoff) { s.aoi.delete(pid); continue; }
      any = true;
      const payload = aoiSnapshot(s, view.x, view.y, view.r);
      if (!payload) continue;
      emitStateFrame(s, 0, s.tick, pid, payload);
    }
    if (!any) {
      // No AoI advertised yet: broadcast a full snapshot so newcomers bootstrap.
      const full = fullSnapshot(s);
      if (full) emitStateFrame(s, 0, s.tick, "", full);
    }
  }

  function emitStateFrame(s, kind, tick, target, payload) {
    const frame = packStateFrame(kind, tick, target, payload);
    // The mesh state room always carries binary StateFrames (base64-wrapped inside the
    // mesh client). One path, no text fallback needed.
    sendState(s, frame);
  }

  function aoiSnapshot(s, x, y, r) {
    try {
      const out = s.wasmHost.snapshotAoi(s.worldHandle, x, y, r);
      return toBytes(out);
    } catch (_) {
      return null;
    }
  }

  function fullSnapshot(s) {
    try {
      const out = s.wasmHost.snapshotFull(s.worldHandle);
      return toBytes(out);
    } catch (_) {
      return null;
    }
  }

  // ---- mesh-db snapshot (term-ordered) -------------------------------------------------
  // The world snapshot is one LWW key (snap:<room>) in the app's mesh map. It carries a
  // monotonic `term`; a host only overwrites when its next term beats the stored one, so
  // two hosts racing after a partition converge on the highest term (the mesh map's own
  // last-writer-wins clock breaks any exact tie).
  async function loadSnapshot(s) {
    try {
      const j = await mesh.db.get(s.snapKey);
      if (!j || typeof j !== "object") return null;
      return {
        tick: Number(j.tick) || 0,
        term: Number(j.term) || 0,
        bytes: j.b ? b64ToBytes(j.b) : null,
      };
    } catch (_) {
      return null;
    }
  }

  async function writeSnapshot(s) {
    const payload = fullSnapshot(s);
    if (!payload) return;
    try {
      // Term-CAS: re-read the stored term; only advance if ours would still be ahead.
      const cur = await loadSnapshot(s);
      const storedTerm = cur ? (cur.term || 0) : 0;
      if (storedTerm > (s.snapTerm || 0)) { s.snapTerm = storedTerm; return; }
      const nextTerm = storedTerm + 1;
      await mesh.db.set(s.snapKey, { tick: s.tick, term: nextTerm, host: id, ts: now(), b: bytesToB64(payload) });
      s.snapTerm = nextTerm;
    } catch (_) {
      /* snapshot failure is non-fatal; next tick retries */
    }
  }

  // =====================================================================================
  // CROSS-SHARD HANDOFF — entities crossing a region boundary move host->host.
  // =====================================================================================
  function maybeHandoff(s) {
    // The wasm host optionally exposes departures(handle, gx, gy, size) -> JSON of
    // entities that left this region this tick. If it does not, handoff is a no-op
    // (single-region play still works). We keep the protocol here so a sim build that
    // reports departures gets correct cross-shard continuity for free.
    if (!s.wasmHost || !s.wasmHost.takeDepartures) return;
    let departures;
    try {
      departures = s.wasmHost.takeDepartures(s.worldHandle, s.reg.gx, s.reg.gy, regionSize);
    } catch (_) {
      return;
    }
    if (!departures) return;
    let list;
    try { list = typeof departures === "string" ? JSON.parse(departures) : departures; } catch (_) { return; }
    if (!Array.isArray(list) || list.length === 0) return;
    for (const ent of list) {
      const dst = regionOf(ent.x, ent.y, regionSize);
      const xferId = id + ":" + s.tick + ":" + ent.id;
      // Mark as outstanding so we can retransmit until xack.
      s.seenXfer.set("out:" + xferId, now());
      forwardHandoff(dst, { k: "xfer", xferId, from: regionRoom(s.reg.gx, s.reg.gy), ent });
    }
  }

  // Forward a handoff to the destination region over a mesh handoff ROOM. The destination
  // host subscribes to "handoff:<region>" (see ensureHandoffInbox) and applies frames
  // idempotently by xferId, so mesh pub/sub (at-least-once, may dedupe) is exactly right
  // here — a double-delivery is harmless. No /db RMW mailbox, no cross-origin fetch.
  function handoffRoom(reg) {
    const key = "handoff:" + regionRoom(reg.gx, reg.gy);
    let r = handoffRooms.get(key);
    if (!r) { r = mesh.room(key); handoffRooms.set(key, r); }
    return r;
  }
  function forwardHandoff(dst, msg) {
    try { handoffRoom(dst).send(Object.assign({ k: "xfer" }, msg, { ts: now() })); } catch (_) {}
  }

  // While hosting a region, subscribe to its handoff room and apply inbound xfers once.
  function ensureHandoffInbox(s) {
    if (s._handoffOff) return;
    const r = handoffRoom(s.reg);
    s._handoffOff = r.on((msg) => {
      if (!s.amHost) return;
      if (msg && msg.xferId && !s.seenXfer.has("in:" + msg.xferId)) {
        applyHandoff(s, msg);
        s.seenXfer.set("in:" + msg.xferId, now());
        ackHandoff(msg);
      }
    });
  }

  function applyHandoff(s, msg) {
    if (!msg || !msg.ent || !s.wasmHost || !s.wasmHost.adoptEntity) return;
    // Idempotent: adoptEntity must be a no-op if the entity id already exists.
    try {
      s.wasmHost.adoptEntity(s.worldHandle, JSON.stringify(msg.ent));
    } catch (_) {}
  }

  function ackHandoff(msg) {
    // Acks are advisory (the source clears its outstanding set on its own timer). Publish
    // a tiny ack frame on the source region's handoff room; harmless if no one listens.
    if (!msg || !msg.from) return;
    const m = msg.from.match(/^r:(-?\d+):(-?\d+)$/);
    if (!m) return;
    try { handoffRoom({ gx: Number(m[1]), gy: Number(m[2]) }).send({ k: "xack", xferId: msg.xferId, ts: now() }); } catch (_) {}
  }

  // =====================================================================================
  // REGION DIRECTORY — the mesh db maps region -> owning host. Each region's owner writes
  // ITS OWN entry under "world:dir:<room>" (no shared-map RMW), so two hosts updating
  // different regions never clobber each other. Clients list the "world:dir:" prefix.
  // =====================================================================================
  const DIR_PREFIX = "world:dir:";

  async function publishDirectory(s, hostId) {
    if (!s.amHost) return; // only the owning host writes its own region entry
    try {
      await mesh.db.set(DIR_PREFIX + s.room, { region: s.room, host: hostId || id, ts: now() });
    } catch (_) {
      /* directory is advisory */
    }
  }

  async function refreshDirectory() {
    try {
      const items = await mesh.db.list(DIR_PREFIX, 4096);
      if (!Array.isArray(items)) return;
      directory.clear();
      for (const it of items) {
        const v = it && it.value;
        if (v && v.region && v.host) directory.set(v.region, v.host);
      }
    } catch (_) {}
  }

  // =====================================================================================
  // The host SEES control events (in/aoi/xfer/xack) because netgame delivers remote
  // sendEvent() payloads to its host tick's ctx.events, and the control game's tick (set
  // in startSession) pushes them into s._controlQueue. We just initialize that queue here,
  // synchronously, right after startSession returns and before any tick can fire.
  // =====================================================================================
  function attachControlQueue(s) {
    s._controlQueue = [];
  }

  // =====================================================================================
  // lifecycle
  // =====================================================================================
  function switchRegion(reg) {
    const next = normRegion(reg);
    if (!next) return;
    if (next.gx === region.gx && next.gy === region.gy) return;
    const prev = session;
    region = next;
    const s = startSession(next);
    attachControlQueue(s);
    if (prev) stopSession(prev);
    onRegionChange({ gx: next.gx, gy: next.gy, room: regionRoom(next.gx, next.gy) }, decorate({}, s));
  }

  // boundary watch: if the view center leaves the current region, switch.
  let boundaryTimer = setInterval(() => {
    const c = safe(viewCenter, null);
    if (!c) return;
    const r = regionOf(c.x, c.y, regionSize);
    if (r.gx !== region.gx || r.gy !== region.gy) switchRegion(r);
  }, 250);

  // periodic: refresh the region directory from the mesh db. Inbound handoffs are now
  // event-driven over the mesh handoff room (ensureHandoffInbox), not polled.
  dirTimer = setInterval(() => {
    void refreshDirectory();
  }, 1000);

  // boot the first session
  const first = startSession(region);
  attachControlQueue(first);
  void refreshDirectory();

  // ---- helpers ----
  function decorate(meta, s) {
    return Object.assign({}, meta, {
      region: s.room,
      gx: s.reg.gx,
      gy: s.reg.gy,
      isHost: s.amHost,
      tick: s.tick,
      stateOnline: s.stateConnected,
    });
  }

  return {
    /** Move the runtime to a new region { gx, gy } (also automatic on boundary cross). */
    setRegion(reg) { switchRegion(reg); },
    /** Current region { gx, gy, room }. */
    region() {
      return { gx: region.gx, gy: region.gy, room: regionRoom(region.gx, region.gy) };
    },
    /** Send a serialized InputFrame (Uint8Array) to the current host immediately. */
    sendInput(bytes) {
      const b = toBytes(bytes);
      if (!b || !session || !session.game) return;
      session.inSeq++;
      session.game.sendEvent({ k: "in", id, seq: session.inSeq, b: bytesToB64(b) });
    },
    /** Queue an application event for the host (delivered to its next tick). */
    sendEvent(obj) {
      if (session && session.game) session.game.sendEvent(Object.assign({ k: "app" }, obj));
    },
    /** Am I the elected host of the current region? */
    isHost() { return !!(session && session.amHost); },
    /** Elected host id for the current region. */
    hostId() { return session && session.game ? session.game.hostId() : null; },
    /** region -> hostId directory snapshot (from /db/world/dir). */
    directory() { return new Map(directory); },
    /** Diagnostics. */
    metrics() {
      const m = session && session.game ? session.game.metrics() : {};
      return Object.assign({}, m, {
        region: regionRoom(region.gx, region.gy),
        isHost: !!(session && session.amHost),
        stateOnline: !!(session && session.stateConnected),
        tick: session ? session.tick : 0,
        viewers: session ? session.aoi.size : 0,
        regionSize,
        aoiRadius,
      });
    },
    /** Leave: stop hosting, close all sockets, stop timers. */
    leave() {
      if (boundaryTimer) clearInterval(boundaryTimer);
      if (dirTimer) clearInterval(dirTimer);
      stopSession(session);
      session = null;
    },
  };
}

// ---- small utilities ------------------------------------------------------------------

function normRegion(r) {
  if (!r) return null;
  const gx = Number(r.gx);
  const gy = Number(r.gy);
  if (!isFinite(gx) || !isFinite(gy)) return null;
  return { gx: gx | 0, gy: gy | 0 };
}

function seedForRegion(reg) {
  // Deterministic per-region seed so independent hosts of the same region agree.
  const gx = reg.gx >>> 0;
  const gy = reg.gy >>> 0;
  // simple 32-bit mix
  let h = (gx * 0x9e3779b1) ^ (gy + 0x85ebca6b);
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

function randomId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID().slice(0, 12);
  } catch (_) {}
  return "p" + Math.random().toString(36).slice(2, 12);
}

function safe(fn, fallback, ...args) {
  try {
    return fn(...args);
  } catch (_) {
    return fallback;
  }
}

export { regionOf, regionRoom, neighbourRegions };
export default { createDriftRuntime, regionOf, regionRoom };
