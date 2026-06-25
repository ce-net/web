// mesh-bridge.js — install a real mesh node into the page over one WebSocket.
//
// This is the BridgeTransport half of the browser<->mesh transport seam. It backs the shared
// `window.__ceNode` contract (request(method, path, init) -> {status, headers, body}) by tunnelling
// each call over a single same-origin WebSocket to the relay's `/mesh-bridge`, which forwards it to a
// real `ce` node. The page therefore talks to the actual mesh — gossipsub, the DHT, content-addressed
// blobs — with no app-tier HTTP backend (no /db, no /rt) and without ever holding the node's token.
//
// It is the universal fallback: it works in every browser today. The other half of the seam is a real
// js-libp2p peer that installs the SAME `window.__ceNode` in-process; when that is present this script
// stands down (see the guard below), so app code never knows which transport is live. `@ce/client`
// (index.js) and the demos pick up whichever `__ceNode` is installed automatically.
//
// Usage: include once, before app code.  <script src="/__ce/mesh-bridge.js"></script>
// (The ingress auto-injects it into served HTML so apps get a mesh node for free.) Or import the
// named export and call installMeshBridge() yourself.

const HEX = "0123456789abcdef";
function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xf];
  return s;
}
function fromHex(hex) {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bridgeUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/mesh-bridge`;
}

// One shared WebSocket connection, demultiplexed by request id.
function makeConnection() {
  let sock = null;
  let opening = null;
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject }
  const streams = new Map(); // id -> { push(chunk), end() }

  function connect() {
    if (sock && sock.readyState === WebSocket.OPEN) return Promise.resolve(sock);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let s;
      try {
        s = new WebSocket(bridgeUrl());
      } catch (e) {
        opening = null;
        reject(e);
        return;
      }
      s.onopen = () => {
        sock = s;
        opening = null;
        resolve(s);
      };
      s.onerror = () => {
        if (sock !== s) {
          opening = null;
          reject(new Error("mesh-bridge connect failed"));
        }
      };
      s.onclose = () => {
        if (sock === s) sock = null;
        // Fail in-flight one-shot requests; end live streams (the stream generator reconnects).
        for (const p of pending.values()) p.reject(new Error("mesh-bridge closed"));
        pending.clear();
        for (const q of streams.values()) q.end();
      };
      s.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        const id = m.id;
        if (m.chunk !== undefined) {
          const q = streams.get(id);
          if (q) q.push(m.chunk);
          return;
        }
        if (m.end) {
          const q = streams.get(id);
          if (q) q.end();
          return;
        }
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          p.resolve(m);
        }
      };
    });
    return opening;
  }

  // request(method, path, init) -> { status, headers, body }  (the shared __ceNode contract).
  async function request(method, path, init) {
    const s = await connect();
    const id = nextId++;
    const frame = { id, method, path };
    const body = init && init.body;
    if (body instanceof Uint8Array) frame.body_hex = toHex(body);
    else if (typeof body === "string" && body.length) {
      try {
        frame.body = JSON.parse(body);
      } catch (_) {
        frame.body = body;
      }
    } else if (body && typeof body === "object") {
      frame.body = body;
    }
    const reply = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        s.send(JSON.stringify(frame));
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
    const out = { status: reply.status || 200, headers: {} };
    if (reply.body_hex !== undefined) out.body = fromHex(reply.body_hex);
    else out.body = reply.body;
    return out;
  }

  // stream(path, signal) -> async iterable of decoded payload strings (one AppMessage JSON each).
  // Reconnects across socket blips and keeps yielding until the signal aborts.
  async function* stream(path, signal) {
    while (!(signal && signal.aborted)) {
      let s;
      try {
        s = await connect();
      } catch (_) {
        await sleep(800);
        continue;
      }
      const id = nextId++;
      const buf = [];
      let wake = null;
      let ended = false;
      const q = {
        push(chunk) {
          buf.push(chunk);
          if (wake) {
            const w = wake;
            wake = null;
            w();
          }
        },
        end() {
          ended = true;
          if (wake) {
            const w = wake;
            wake = null;
            w();
          }
        },
      };
      streams.set(id, q);
      const onAbort = () => {
        try {
          s.send(JSON.stringify({ id, cancel: true }));
        } catch (_) {}
        q.end();
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        s.send(JSON.stringify({ id, method: "GET", path }));
      } catch (_) {
        q.end();
      }
      try {
        for (;;) {
          if (buf.length) {
            yield buf.shift();
            continue;
          }
          if (ended || (signal && signal.aborted)) break;
          await new Promise((r) => {
            wake = r;
          });
        }
      } finally {
        streams.delete(id);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      if (signal && signal.aborted) return;
      // Socket dropped or the node stream ended: brief pause, then reconnect & re-subscribe upstream.
      await sleep(500);
    }
  }

  return { request, stream };
}

/**
 * Install `window.__ceNode` backed by the WSS bridge — unless a node bridge is already present
 * (e.g. a real in-browser libp2p peer), in which case do nothing so that transport wins.
 * Returns the active bridge object either way.
 */
export function installMeshBridge() {
  try {
    if (globalThis.__ceNode && typeof globalThis.__ceNode.request === "function") {
      return globalThis.__ceNode; // a real node (libp2p peer) already claimed the seam
    }
  } catch (_) {}
  const conn = makeConnection();
  const bridge = {
    transport: "bridge",
    request: conn.request,
    stream: conn.stream,
  };
  try {
    globalThis.__ceNode = bridge;
  } catch (_) {}
  return bridge;
}

// Auto-install when loaded as a plain <script> (no module consumer calling installMeshBridge()).
try {
  if (typeof window !== "undefined") installMeshBridge();
} catch (_) {}

export default { installMeshBridge };
