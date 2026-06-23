// @ce/client — browser ESM client for the CE App Platform hub.
// Zero dependencies. Uses browser-native fetch + WebSocket.
//
//   import { createClient } from "@ce/client";
//   const ce = createClient();                 // appId auto-resolved from /apps/<id>/
//   await ce.db.set("greeting", { hi: true }); // persistent KV, namespaced per app
//   const room = ce.room("lobby");
//   room.on(msg => console.log(msg));
//   room.send({ text: "hello" });

/**
 * Resolve the app id from the current location. Order: explicit opts.app, then the path
 * form `/apps/<id>/`, then the subdomain form `<id>.ce-net.com` (a developer's public dev
 * domain), then 'demo'.
 */
function resolveAppId(opts) {
  if (opts && opts.app) return String(opts.app);
  try {
    const m = location.pathname.match(/\/apps\/([^/]+)\//);
    if (m && m[1]) return decodeURIComponent(m[1]);
    // subdomain form: <id>.ce-net.com (ignore the apex + reserved hosts).
    const h = location.hostname.match(/^([a-z0-9][a-z0-9-]*)\.ce-net\.com$/i);
    if (h && !["www", "relay", "docs", "p2p"].includes(h[1].toLowerCase())) return h[1];
  } catch (_) {
    /* non-browser env */
  }
  return "demo";
}

/** Resolve the http(s) origin / base. */
function resolveBase(opts) {
  if (opts && opts.base) return String(opts.base).replace(/\/+$/, "");
  try {
    return location.origin;
  } catch (_) {
    return "";
  }
}

/** http(s) origin -> ws(s) origin. */
function wsBase(base) {
  if (base.startsWith("https:")) return "wss:" + base.slice("https:".length);
  if (base.startsWith("http:")) return "ws:" + base.slice("http:".length);
  // protocol-relative or empty: best-effort
  if (typeof location !== "undefined") {
    return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;
  }
  return base;
}

export function createClient(opts = {}) {
  const appId = resolveAppId(opts);
  const base = resolveBase(opts);
  const dbRoot = `${base}/db/${encodeURIComponent(appId)}`;
  const rtRoot = `${wsBase(base)}/rt/${encodeURIComponent(appId)}`;

  const db = {
    async get(key) {
      const res = await fetch(`${dbRoot}/${encodeURIComponent(key)}`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`db.get(${key}) failed: ${res.status}`);
      return res.json();
    },
    async set(key, val) {
      const res = await fetch(`${dbRoot}/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(val ?? null),
      });
      if (!res.ok) throw new Error(`db.set(${key}) failed: ${res.status}`);
      return res.json();
    },
    async del(key) {
      const res = await fetch(`${dbRoot}/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`db.del(${key}) failed: ${res.status}`);
      return res.json();
    },
    async list(prefix, limit) {
      const q = new URLSearchParams();
      if (prefix != null && prefix !== "") q.set("prefix", String(prefix));
      if (limit != null) q.set("limit", String(limit));
      const qs = q.toString();
      const res = await fetch(`${dbRoot}${qs ? "?" + qs : ""}`);
      if (!res.ok) throw new Error(`db.list failed: ${res.status}`);
      const data = await res.json();
      return Array.isArray(data.items) ? data.items : [];
    },
  };

  function room(name) {
    const url = `${rtRoot}/${encodeURIComponent(name)}`;
    let ws = null;
    let closed = false;
    const msgHandlers = new Set();
    const openHandlers = new Set();
    const outbox = [];

    function connect() {
      if (closed) return;
      ws = new WebSocket(url);
      ws.onopen = () => {
        for (const m of outbox.splice(0)) {
          try { ws.send(m); } catch (_) {}
        }
        for (const fn of openHandlers) {
          try { fn(); } catch (_) {}
        }
      };
      ws.onmessage = (ev) => {
        let payload = ev.data;
        try {
          payload = JSON.parse(ev.data);
        } catch (_) {
          /* keep raw string */
        }
        for (const fn of msgHandlers) {
          try { fn(payload); } catch (_) {}
        }
      };
      ws.onclose = () => {
        if (closed) return;
        // simple reconnect with backoff
        setTimeout(connect, 1500);
      };
      ws.onerror = () => {
        try { ws.close(); } catch (_) {}
      };
    }
    connect();

    return {
      send(obj) {
        const data = typeof obj === "string" ? obj : JSON.stringify(obj);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        } else {
          outbox.push(data);
        }
      },
      on(fn) {
        msgHandlers.add(fn);
        return () => msgHandlers.delete(fn);
      },
      onOpen(fn) {
        openHandlers.add(fn);
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { fn(); } catch (_) {}
        }
        return () => openHandlers.delete(fn);
      },
      close() {
        closed = true;
        if (ws) {
          try { ws.close(); } catch (_) {}
        }
      },
    };
  }

  return { appId, base, db, room };
}

export default { createClient };
