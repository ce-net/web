// CE NETGAME — authoritative distributed multiplayer, built only on CE hub primitives.
// ESM. Works in the browser AND in Node 22+ (which has global fetch + WebSocket).
// Zero dependencies, no build step.
//
// The model: every client joins a realtime room and broadcasts a "candidacy" (cand)
// with a score (latency + uptime + benchmark + trust + server bonus). Every client runs
// the SAME deterministic election over the candidate set, so they all agree on ONE host
// without a coordinator. The host runs the authoritative tick loop, ingests {t:"in"}
// inputs, and broadcasts {t:"st"} state each tick. The host snapshots state to /db every
// `snapshotEvery` ticks. If the host goes silent (>~1s), every client re-elects; whoever
// becomes the new host restores from the latest /db snapshot, so play continues with at
// most snapshotEvery/hz seconds of state loss. Auto-reconnect; never crashes on
// 404 / 507 / parse errors.
//
// Usage:
//   import { createGame } from "./netgame.js";
//   const g = createGame({
//     app: "pong", room: "g1", id: myId,
//     init: () => ({ ball: { x: 0, y: 0 }, scores: {} }),
//     tick: (s, inputs, dt, ctx) => { /* advance s using inputs; return s */ return s; },
//     input: () => ({ up: keys.up, down: keys.down }),
//     onState: (s, meta) => render(s, meta),   // meta.host, meta.isHost, meta.hostShort, ...
//   });
//   // later: g.setInput({ up:true }); g.sendEvent({ chat:"hi" }); g.players(); g.leave();

// ---- environment helpers -------------------------------------------------------------

function resolveBase(opts) {
  if (opts && opts.base) return String(opts.base).replace(/\/+$/, "");
  try {
    if (typeof location !== "undefined" && location.origin) return location.origin;
  } catch (_) {
    /* non-browser */
  }
  return "";
}

function httpToWs(base) {
  if (base.startsWith("https:")) return "wss:" + base.slice("https:".length);
  if (base.startsWith("http:")) return "ws:" + base.slice("http:".length);
  if (typeof location !== "undefined") {
    return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;
  }
  return base;
}

function pickWebSocket(opts) {
  if (opts && opts.WebSocket) return opts.WebSocket;
  if (typeof WebSocket !== "undefined") return WebSocket;
  if (typeof globalThis !== "undefined" && globalThis.WebSocket) return globalThis.WebSocket;
  throw new Error("netgame: no WebSocket available — pass opts.WebSocket (Node <22 needs the 'ws' package)");
}

function pickFetch(opts) {
  if (opts && opts.fetch) return opts.fetch;
  if (typeof fetch !== "undefined") return fetch.bind(globalThis);
  if (typeof globalThis !== "undefined" && globalThis.fetch) return globalThis.fetch.bind(globalThis);
  throw new Error("netgame: no fetch available — pass opts.fetch");
}

const now = () => Date.now();

// ---- election / liveness constants ---------------------------------------------------

const CAND_TTL_MS = 2500;     // a candidacy stays valid this long after last seen
const CAND_INTERVAL_MS = 1000; // broadcast my own candidacy ~1/s
const HOST_SILENCE_MS = 1000;  // no {t:"st"} for this long => host is considered failed
const INPUT_TTL_MS = 2000;     // drop client inputs older than this
const NODES_REFRESH_MS = 5000; // re-fetch /nodes scoring inputs this often
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8000;

// ---- default host scoring -------------------------------------------------------------
// score = (1000/(40+latencyMs)) * (0.5 + uptimePct/100) * (1 + cpu/300) * (server?1.6:1)
// Lower latency, higher uptime, stronger benchmark, server/trust bonus all raise it.
function combineScore({ latencyMs, uptimePct, cpu, server }) {
  const lat = 1000 / (40 + Math.max(0, latencyMs || 0));
  const up = 0.5 + Math.max(0, Math.min(100, uptimePct || 0)) / 100;
  const bench = 1 + Math.max(0, cpu || 0) / 300;
  const bonus = server ? 1.6 : 1;
  return lat * up * bench * bonus;
}

// A ~20ms CPU throughput micro-benchmark, normalized to a rough "cpu_mark"-ish number.
function microBench() {
  const end = now() + 20;
  let n = 0;
  let x = 1.000001;
  while (now() < end) {
    // a little floating-point churn so the JIT can't fully elide it
    x = x * 1.0000001 + 0.5;
    if (x > 1e6) x = 1.000001;
    n++;
  }
  // scale iterations into a small bench number; purely relative across clients
  return Math.round(n / 4000);
}

// ---- the framework --------------------------------------------------------------------

export function createGame(opts = {}) {
  if (!opts.app) throw new Error("netgame: opts.app is required");
  const app = String(opts.app);
  const room = String(opts.room || "g1");
  const id = String(opts.id || randomId());
  const hz = Math.max(1, Number(opts.hz) || 20);
  const dt = 1 / hz;
  const snapshotEvery = Math.max(1, Number(opts.snapshotEvery) || 40);
  const canHost = opts.canHost !== false;

  const init = typeof opts.init === "function" ? opts.init : () => ({});
  const tickFn = typeof opts.tick === "function" ? opts.tick : (s) => s;
  const inputFn = typeof opts.input === "function" ? opts.input : null;
  const onState = typeof opts.onState === "function" ? opts.onState : () => {};
  const onHostChange = typeof opts.onHostChange === "function" ? opts.onHostChange : () => {};
  const hostScore = typeof opts.hostScore === "function" ? opts.hostScore : null;

  const base = resolveBase(opts);
  const WS = pickWebSocket(opts);
  const doFetch = pickFetch(opts);
  const wsURL = httpToWs(base) + "/rt/" + encodeURIComponent(app) + "/" + encodeURIComponent(room);
  const snapKey = "snap:" + room;
  const snapURL = base + "/db/" + encodeURIComponent(app) + "/" + encodeURIComponent(snapKey);
  const nodesURL = base + "/nodes";
  const probeURL = base + "/stats";

  // ---- mutable state ----
  let ws = null;
  let closed = false;
  let connected = false;
  let reconnectDelay = RECONNECT_MIN_MS;
  const outbox = [];

  let myInput = inputFn ? safeCall(inputFn, null) : null;
  let myInSeq = 0;

  // candidates: id -> { id, score, server, ts }
  const candidates = new Map();
  let myScore = canHost ? (opts.server ? 0.001 : 0.0005) : 0; // tiny placeholder until scored
  let myServer = !!opts.server; // default false; refined from /nodes
  let scoredOnce = false;

  let currentHost = null;       // elected host id
  let amHost = false;
  let hostShortStr = "";

  // host-side authoritative state
  let state = null;
  let stateLoadedFromSnap = false;
  let tickNum = 0;
  let stSeq = 0;
  let tickTimer = null;
  let lastSnapshotTick = -1;
  const events = [];            // queued events (from sendEvent + remote {t:"ev"})

  // client-side: latest input per peer (for the host) + last state receipt
  const peerInputs = new Map(); // pid -> { input, ts, seq }
  let lastStateTs = 0;
  let lastStateHost = null;
  let rttToHostMs = 0;

  let candTimer = null;
  let nodesTimer = null;
  let electTimer = null;

  // ---------------------------------------------------------------------------------
  // websocket plumbing (auto-reconnect, never throws on bad frames)
  // ---------------------------------------------------------------------------------
  function connect() {
    if (closed) return;
    let sock;
    try {
      sock = new WS(wsURL);
    } catch (_) {
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      connected = true;
      reconnectDelay = RECONNECT_MIN_MS;
      for (const m of outbox.splice(0)) trySend(sock, m);
      // re-announce candidacy immediately on (re)connect
      announceCandidacy();
    };
    sock.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch (_) {
        return; // never crash on a parse error
      }
      try {
        handleFrame(frame);
      } catch (_) {
        /* never let one bad frame take down the loop */
      }
    };
    sock.onerror = () => {
      try { sock.close(); } catch (_) {}
    };
    sock.onclose = () => {
      if (ws === sock) {
        connected = false;
        ws = null;
      }
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    const d = reconnectDelay;
    reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(reconnectDelay * 1.7) + 50);
    setTimeout(connect, d);
  }

  function trySend(sock, data) {
    try {
      if (sock && sock.readyState === 1) {
        sock.send(data);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function send(obj) {
    const data = typeof obj === "string" ? obj : JSON.stringify(obj);
    if (!trySend(ws, data)) outbox.push(data);
  }

  // ---------------------------------------------------------------------------------
  // frame handling — remember: we NEVER receive our own frames
  // ---------------------------------------------------------------------------------
  function handleFrame(f) {
    if (!f || typeof f !== "object") return;
    switch (f.t) {
      case "cand": {
        if (!f.id) return;
        candidates.set(f.id, {
          id: f.id,
          score: Number(f.score) || 0,
          server: !!f.server,
          ts: now(),
        });
        reElect();
        break;
      }
      case "in": {
        if (!f.id) return;
        const prev = peerInputs.get(f.id);
        if (prev && typeof f.seq === "number" && f.seq < prev.seq) return; // out of order
        peerInputs.set(f.id, { input: f.input, ts: now(), seq: Number(f.seq) || 0 });
        break;
      }
      case "st": {
        if (!f.host) return;
        lastStateTs = now();
        lastStateHost = f.host;
        // freshen the host's candidacy so it stays elected even if cand is sparse
        const c = candidates.get(f.host);
        if (c) c.ts = now();
        if (typeof f.ts === "number") rttToHostMs = Math.max(0, now() - f.ts);
        // adopt host's authoritative state for rendering, and keep a warm copy in case
        // we get elected next (snapshot fallback is the durable path; this is the fast one)
        if (f.full && f.state !== undefined) {
          state = f.state;
          stateLoadedFromSnap = true;
          tickNum = Number(f.tick) || tickNum;
        }
        // only render state from the host we have actually elected
        if (f.host === currentHost && !amHost) {
          if (f.state !== undefined) emitState(f.state, f);
        }
        break;
      }
      case "ev": {
        if (amHost && f.ev !== undefined) events.push(f.ev);
        break;
      }
      case "bye": {
        if (f.id) {
          candidates.delete(f.id);
          peerInputs.delete(f.id);
          reElect();
        }
        break;
      }
      default:
        break;
    }
  }

  function emitState(s, stFrame) {
    const meta = {
      host: currentHost,
      hostShort: hostShortStr || shortOf(currentHost),
      isHost: amHost,
      online: connected,
      tick: Number(stFrame && stFrame.tick) || tickNum,
      rttToHostMs,
    };
    safeCall(onState, null, s, meta);
  }

  // ---------------------------------------------------------------------------------
  // election — deterministic: highest score, ties -> lexicographically smallest id.
  // ---------------------------------------------------------------------------------
  function liveCandidates() {
    const cutoff = now() - CAND_TTL_MS;
    const list = [];
    for (const c of candidates.values()) {
      if (c.ts >= cutoff) list.push(c);
    }
    // include self if eligible
    if (canHost) {
      list.push({ id, score: myScore, server: myServer, ts: now() });
    }
    return list;
  }

  function electHost() {
    const list = liveCandidates();
    if (list.length === 0) return null;
    let best = null;
    for (const c of list) {
      if (
        best === null ||
        c.score > best.score ||
        (c.score === best.score && c.id < best.id)
      ) {
        best = c;
      }
    }
    return best ? best.id : null;
  }

  function reElect() {
    const elected = electHost();
    if (elected === currentHost) return;
    setHost(elected);
  }

  function setHost(hostId) {
    const prev = currentHost;
    currentHost = hostId;
    const becameHost = hostId === id && canHost;

    if (becameHost && !amHost) {
      amHost = true;
      startHosting();
    } else if (!becameHost && amHost) {
      amHost = false;
      stopHosting();
    }

    hostShortStr = hostId === id && myShort ? myShort : shortOf(hostId);
    if (hostId !== prev) {
      // reset host silence tracking against the new host
      lastStateTs = now();
      safeCall(onHostChange, null, {
        host: currentHost,
        hostShort: hostShortStr,
        isHost: amHost,
        online: connected,
        tick: tickNum,
        rttToHostMs,
      });
    }
  }

  // periodic re-election watchdog: if the host has gone silent, drop it and re-elect.
  function watchdog() {
    if (currentHost && currentHost !== id) {
      if (now() - lastStateTs > HOST_SILENCE_MS) {
        // host considered failed: forget its candidacy so a different node wins
        candidates.delete(currentHost);
        const failed = currentHost;
        currentHost = null;
        const elected = electHost();
        if (elected && elected !== failed) {
          setHost(elected);
        } else {
          // nobody else: if I'm eligible, take it
          if (canHost) setHost(id);
        }
      }
    } else if (!currentHost) {
      reElect();
    }
  }

  // ---------------------------------------------------------------------------------
  // candidacy + scoring
  // ---------------------------------------------------------------------------------
  function announceCandidacy() {
    if (!canHost) return;
    send({ t: "cand", id, score: myScore, server: myServer, ts: now() });
  }

  async function refreshScore() {
    if (!canHost) return;
    try {
      if (hostScore) {
        const s = await hostScore();
        if (typeof s === "number" && isFinite(s)) {
          myScore = s;
          scoredOnce = true;
          return;
        }
      }
      const me = await fetchMyNode();
      if (me) {
        myServer = me.device_class === "server";
        myScore = combineScore({
          latencyMs: Number(me.rtt_ms) || 0,
          uptimePct: Number(me.uptime_pct) || 0,
          cpu: Number(me.cpu_mark != null ? me.cpu_mark : (me.caps && me.caps.cpu_mark) || 0),
          server: myServer,
        });
        if (me.short) myShort = String(me.short);
      } else {
        // plain browser: measure latency + a tiny cpu bench; low uptime/trust default.
        const latencyMs = await measureLatency();
        const cpu = microBench();
        myServer = false;
        myScore = combineScore({ latencyMs, uptimePct: 20, cpu, server: false });
      }
      scoredOnce = true;
    } catch (_) {
      // never crash; keep last known score
      if (!scoredOnce) myScore = canHost ? 0.0005 : 0;
    }
  }

  let myShort = "";

  async function fetchMyNode() {
    try {
      const res = await doFetch(nodesURL);
      if (!res || !res.ok) return null;
      const data = await res.json();
      const arr = data && Array.isArray(data.nodes) ? data.nodes : [];
      for (const n of arr) {
        if (n && (n.id === id || n.short === id)) return n;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  async function measureLatency() {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const t0 = now();
      try {
        const res = await doFetch(probeURL, { method: "GET" });
        if (res) {
          // drain a little so the request actually completes
          try { await res.text(); } catch (_) {}
        }
        samples.push(now() - t0);
      } catch (_) {
        samples.push(300);
      }
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)] || 100;
  }

  // ---------------------------------------------------------------------------------
  // host loop
  // ---------------------------------------------------------------------------------
  async function startHosting() {
    // adopt state: prefer a warm copy from {t:"st"} (already set), else snapshot, else init.
    if (state == null || !stateLoadedFromSnap) {
      const snap = await loadSnapshot();
      if (snap && snap.state !== undefined && snap.state !== null) {
        state = snap.state;
        tickNum = Number(snap.tick) || 0;
      } else if (state == null) {
        state = safeCall(init, {});
        tickNum = 0;
      }
    }
    stSeq = 0;
    lastSnapshotTick = -1;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(hostTick, Math.round(1000 / hz));
  }

  function stopHosting() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  async function loadSnapshot() {
    try {
      const res = await doFetch(snapURL);
      if (!res || res.status === 404) return null;
      if (!res.ok) return null; // 507 etc -> just init
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  function collectInputs() {
    const cutoff = now() - INPUT_TTL_MS;
    const inputs = {};
    // my own input (host plays too, via input()/setInput)
    const mine = inputFn ? safeCall(inputFn, null) : myInput;
    if (mine != null) inputs[id] = mine;
    for (const [pid, rec] of peerInputs) {
      if (rec.ts < cutoff) {
        peerInputs.delete(pid);
        continue;
      }
      inputs[pid] = rec.input;
    }
    return inputs;
  }

  function hostTick() {
    if (!amHost) return;
    const inputs = collectInputs();
    const drained = events.splice(0);
    const ctx = { now: now(), tick: tickNum, events: drained, host: id };
    try {
      const next = tickFn(state, inputs, dt, ctx);
      if (next !== undefined) state = next;
    } catch (_) {
      // a throwing game tick must not kill the host loop
    }
    tickNum++;

    // broadcast authoritative state (full each tick — fine for small state)
    stSeq++;
    send({
      t: "st",
      host: id,
      seq: stSeq,
      tick: tickNum,
      full: true,
      state,
      ts: now(),
    });

    // local render for the host's own client
    if (amHost) {
      lastStateTs = now();
      lastStateHost = id;
      emitState(state, { tick: tickNum });
    }

    // periodic snapshot for redundancy / migration
    if (tickNum - lastSnapshotTick >= snapshotEvery) {
      lastSnapshotTick = tickNum;
      void writeSnapshot();
    }
  }

  async function writeSnapshot() {
    const body = JSON.stringify({ tick: tickNum, state, host: id, ts: now() });
    try {
      const res = await doFetch(snapURL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      // 507 (insufficient storage) and friends are non-fatal — just skip this snapshot.
      void res;
    } catch (_) {
      /* never crash on snapshot failure */
    }
  }

  // ---------------------------------------------------------------------------------
  // client input pump
  // ---------------------------------------------------------------------------------
  let inputTimer = null;
  function startInputPump() {
    if (inputTimer) clearInterval(inputTimer);
    inputTimer = setInterval(() => {
      const inp = inputFn ? safeCall(inputFn, null) : myInput;
      if (inp == null) return;
      myInSeq++;
      send({ t: "in", id, seq: myInSeq, input: inp });
    }, Math.round(1000 / hz));
  }

  // ---------------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------------
  connect();
  startInputPump();
  // score myself, then keep candidacy + election alive
  void refreshScore().then(announceCandidacy);
  candTimer = setInterval(announceCandidacy, CAND_INTERVAL_MS);
  nodesTimer = setInterval(() => void refreshScore(), NODES_REFRESH_MS);
  electTimer = setInterval(watchdog, 250);

  // ---------------------------------------------------------------------------------
  // public API — tiny and obvious
  // ---------------------------------------------------------------------------------
  return {
    /** Set this client's current input (alternative to opts.input). */
    setInput(obj) {
      myInput = obj;
    },
    /** Queue a one-off event delivered to the host's next tick (ctx.events). */
    sendEvent(obj) {
      if (amHost) {
        events.push(obj);
      } else {
        send({ t: "ev", id, ev: obj });
      }
    },
    /** Latest authoritative state (host's live state, or last received snapshot/st). */
    state() {
      return state;
    },
    /** Am I currently the elected host? */
    isHost() {
      return amHost;
    },
    /** The elected host's id. */
    hostId() {
      return currentHost;
    },
    /** Short label for the elected host. */
    hostShort() {
      return hostShortStr || shortOf(currentHost);
    },
    /** Is the websocket currently connected? */
    online() {
      return connected;
    },
    /** Ids of live participants (candidates + recent input senders + self). */
    players() {
      const set = new Set();
      set.add(id);
      const cutoff = now() - CAND_TTL_MS;
      for (const c of candidates.values()) if (c.ts >= cutoff) set.add(c.id);
      const icut = now() - INPUT_TTL_MS;
      for (const [pid, rec] of peerInputs) if (rec.ts >= icut) set.add(pid);
      return [...set];
    },
    /** Diagnostics: scoring + election snapshot. */
    metrics() {
      return {
        id,
        score: myScore,
        server: myServer,
        host: currentHost,
        isHost: amHost,
        online: connected,
        tick: tickNum,
        rttToHostMs,
        candidates: liveCandidates().map((c) => ({ id: c.id, score: c.score, server: c.server })),
      };
    },
    /** Leave the game: stop hosting, drop candidacy, close the socket. */
    leave() {
      closed = true;
      try { send({ t: "bye", id }); } catch (_) {}
      stopHosting();
      if (inputTimer) clearInterval(inputTimer);
      if (candTimer) clearInterval(candTimer);
      if (nodesTimer) clearInterval(nodesTimer);
      if (electTimer) clearInterval(electTimer);
      amHost = false;
      currentHost = null;
      if (ws) {
        try { ws.close(); } catch (_) {}
      }
    },
  };
}

// ---- small utilities ------------------------------------------------------------------

function shortOf(idVal) {
  if (!idVal) return "?";
  const s = String(idVal);
  return s.length <= 8 ? s : s.slice(0, 8);
}

function randomId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID().slice(0, 12);
  } catch (_) {}
  return "p" + Math.random().toString(36).slice(2, 12);
}

function safeCall(fn, fallback, ...args) {
  try {
    return fn(...args);
  } catch (_) {
    return fallback;
  }
}

export default { createGame };
