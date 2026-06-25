/**
 * @ce-net/bench — clients for (a) the local CE node HTTP API and (b) the `ce-hub` that dispatches
 * WASM tasks to browser nodes.
 *
 * Runtime-agnostic: web-standard `fetch`/`AbortController` only (Node 20+, Deno, Bun, browser,
 * Workers). Mirrors the style of `@ce-net/graph`'s fetch layer — per-request timeout, injectable
 * `fetch`, optional headers/auth.
 *
 * MONEY: read-only GETs here never touch money. The one mutating call (`sendSignal`) forwards a burn
 * tx id and amount; amounts are DECIMAL STRINGS of base units and are passed through verbatim — this
 * module never parses an amount to a JS number.
 *
 * @packageDocumentation
 */

/** @typedef {import("./types.js").NodeProfile} NodeProfile */

/** @typedef {object} CeClientOptions
 * @property {string} [baseUrl]        CE node API base. Default "http://localhost:8844".
 * @property {string} [token]          api.token for mutating requests -> `Authorization: Bearer`.
 * @property {number} [timeoutMs]      Per-request timeout. Default 8000.
 * @property {typeof fetch} [fetch]    Injected fetch (tests / auth wrappers). Default global fetch.
 * @property {Record<string,string>} [headers] Extra headers on every request.
 */

const DEFAULT_BASE = "http://localhost:8844";

function joinUrl(base, path) {
  return base.endsWith("/") ? base.slice(0, -1) + path : base + path;
}

function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Thin client over the CE node HTTP API (see `ce/docs/api.md`). Only the endpoints `ce-bench`
 * needs are wrapped; all are real, existing routes except `publishProfile`, which targets the
 * proposed `POST /profile/publish` (docs/nodeprofile-spec.md §2) and falls back to a CEP-1 signal.
 */
export class CeClient {
  /** @param {CeClientOptions} [opts] */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.headers = opts.headers ?? {};
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new Error("CeClient: no fetch available; pass options.fetch");
    /** @type {typeof fetch} */
    this._fetch = f.bind(globalThis);
  }

  /** @private */
  async _request(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    /** @type {Record<string,string>} */
    const headers = { accept: "application/json", ...this.headers };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && this.token) headers["authorization"] = `Bearer ${this.token}`;
    try {
      const res = await this._fetch(joinUrl(this.baseUrl, path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text; // some routes (e.g. /health) return plain text
      }
      if (!res.ok) {
        const detail = parsed && parsed.error ? parsed.error : typeof parsed === "string" ? parsed : "";
        throw new Error(`HTTP ${res.status} ${method} ${path}${detail ? `: ${detail}` : ""}`);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /status -> node id, height, balances (balances are decimal strings). */
  status() {
    return this._request("GET", "/status");
  }

  /** GET /beacon -> { height, hash } verifiable randomness. Used to seed benchmarks. */
  beacon() {
    return this._request("GET", "/beacon");
  }

  /** GET /atlas -> [{ node_id, cpu_cores, mem_mb, running_jobs, last_seen_secs, tags }]. */
  atlas() {
    return this._request("GET", "/atlas");
  }

  /** GET /netgraph -> [{ peer, rtt_ms, samples, last_seen_secs }] measured RTT edges. */
  netgraph() {
    return this._request("GET", "/netgraph");
  }

  /** GET /history/:node_id -> reputation facts (jobs_hosted, earned ..., amounts are strings). */
  history(nodeId) {
    return this._request("GET", `/history/${nodeId}`);
  }

  /** GET /signals -> last 100 CEP-1 signals. ce-bench reads these to reconstruct profiles (stopgap). */
  signals() {
    return this._request("GET", "/signals");
  }

  /**
   * POST /signals/send — sign + broadcast a CEP-1 signal. This is how `ce-bench` publishes a profile
   * BEFORE the node ships `POST /profile/publish` (docs/nodeprofile-spec.md §2 stopgap): the profile
   * JSON goes in `payload_hex`, advertised with a `nodeprofile` capability.
   *
   * @param {object} a
   * @param {string} a.payloadHex            Hex-encoded payload (the canonical profile bytes).
   * @param {string} [a.to]                  "broadcast" (default) or a 64-hex node id.
   * @param {{name:string,version:number}[]} [a.capabilities]
   * @param {string} [a.burnTxIdHex]         64-hex on-chain tx id; REQUIRED when payload non-empty.
   * @returns {Promise<{id:string,nonce:number}>}
   */
  sendSignal(a) {
    return this._request("POST", "/signals/send", {
      payload_hex: a.payloadHex ?? "",
      to: a.to ?? "broadcast",
      capabilities: a.capabilities ?? [{ name: "nodeprofile", version: 1 }],
      burn_tx_id_hex: a.burnTxIdHex,
    });
  }

  /**
   * POST /profile/publish (PROPOSED, docs/nodeprofile-spec.md §2A). Sends the unsigned profile; the
   * node validates freshness/beacon, signs with its identity key, stores, gossips, and returns the
   * signed profile. If the route 404s (node hasn't shipped it), the caller (`profile.js`) falls back
   * to `sendSignal`. Mutating -> needs the api.token.
   *
   * @param {NodeProfile} profile (without `sig`)
   * @returns {Promise<NodeProfile>} signed profile
   */
  publishProfile(profile) {
    return this._request("POST", "/profile/publish", profile);
  }

  /**
   * GET /profiles (PROPOSED). All stored signed profiles. Falls back is the caller's job
   * (fabricstats can reconstruct from /signals). Resolves to [] on 404 so callers can probe.
   * @returns {Promise<NodeProfile[]>}
   */
  async profiles() {
    try {
      return await this._request("GET", "/profiles");
    } catch (e) {
      if (/HTTP 404/.test(errMessage(e))) return [];
      throw e;
    }
  }

  /** GET /fabric/stats (PROPOSED). Node-side scoreboard. Returns null on 404. */
  async fabricStats() {
    try {
      return await this._request("GET", "/fabric/stats");
    } catch (e) {
      if (/HTTP 404/.test(errMessage(e))) return null;
      throw e;
    }
  }
}

/** @typedef {object} HubClientOptions
 * @property {string} [baseUrl]        ce-hub HTTP base. Default "https://ce-net.com/hub" or local.
 * @property {number} [timeoutMs]      Per-task timeout (hub itself times out at 30s). Default 35000.
 * @property {typeof fetch} [fetch]
 * @property {Record<string,string>} [headers]
 */

/** @typedef {object} HubTaskResult
 * @property {string} node     Browser node id that ran it.
 * @property {string} func     Exported WASM function called.
 * @property {number[]} args
 * @property {boolean} ok
 * @property {string} value    Stringified return (BigInt-safe; the page returns String(r)).
 * @property {number} ms       On-device wall time the browser reported.
 * @property {string} [error]
 */

/**
 * Client for `ce-hub` (`web/ce-hub`): dispatch a WASM benchmark task to a live browser node via
 * `POST /tasks` and get its result. The hub forwards `{module, func, args, ret, target}` to a node
 * over WebSocket and returns `{node, func, args, ok, value, ms, error}` (see ce-hub `submit_task`).
 *
 * `module` is either a builtin name the hub knows, or a raw base64 WASM module (>64 chars) — the hub
 * treats long strings as inline modules. This is exactly how `ce-bench` ships its probe kernels to
 * browser nodes that can only run `WebAssembly.instantiate` (see web/site/node.html `runJob`).
 */
export class HubClient {
  /** @param {HubClientOptions} [opts] */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ?? defaultHubBase();
    this.timeoutMs = opts.timeoutMs ?? 35000;
    this.headers = opts.headers ?? {};
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new Error("HubClient: no fetch available; pass options.fetch");
    this._fetch = f.bind(globalThis);
  }

  /**
   * Dispatch one WASM task to a browser node.
   *
   * @param {object} task
   * @param {string} task.func                   Export name to call (e.g. "flops").
   * @param {(number|bigint)[]} [task.args]       i64/i32 args (the page spreads them into the export).
   * @param {string} [task.module]               Builtin module name OR raw base64 WASM (>64 chars).
   * @param {string} [task.moduleB64]            Alias for a raw base64 WASM module.
   * @param {string} [task.ret]                  "i32"|"i64"|... return hint. Default "i64".
   * @param {string} [task.target]               Specific browser node id; else least-loaded.
   * @returns {Promise<HubTaskResult>}
   */
  async submitTask(task) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const module = task.moduleB64 ?? task.module;
    // hub args are i64 -> send as numbers; bigints serialize via custom replacer.
    const args = (task.args ?? []).map((a) => (typeof a === "bigint" ? Number(a) : a));
    try {
      const res = await this._fetch(joinUrl(this.baseUrl, "/tasks"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...this.headers },
        body: JSON.stringify({ module, func: task.func, args, ret: task.ret ?? "i64", target: task.target }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!res.ok) {
        throw new Error(`hub HTTP ${res.status}${parsed && parsed.error ? `: ${parsed.error}` : ""}`);
      }
      return /** @type {HubTaskResult} */ (parsed);
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /nodes -> live browser nodes the hub knows about (id, caps, age). */
  async nodes() {
    const res = await this._fetch(joinUrl(this.baseUrl, "/nodes"), {
      headers: { accept: "application/json", ...this.headers },
    });
    if (!res.ok) throw new Error(`hub HTTP ${res.status} for /nodes`);
    return res.json();
  }

  /** GET /stats -> the hub's aggregate (today nodes+cores; extended to FabricStats per the spec). */
  async stats() {
    const res = await this._fetch(joinUrl(this.baseUrl, "/stats"), {
      headers: { accept: "application/json", ...this.headers },
    });
    if (!res.ok) throw new Error(`hub HTTP ${res.status} for /stats`);
    return res.json();
  }
}

function defaultHubBase() {
  // Browser: same-origin /hub on ce-net.com, ws/http parity with node.html's wsBase().
  if (typeof location !== "undefined" && location.host && location.protocol.startsWith("http")) {
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      return "http://127.0.0.1:8970";
    }
    return `${location.protocol}//${location.host}/hub`;
  }
  // Node default: local hub.
  return "http://127.0.0.1:8970";
}

/** Hex-encode a byte array or UTF-8 string (for CEP-1 `payload_hex`). */
export function toHex(input) {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Decode hex back to a Uint8Array (for reading a profile out of a CEP-1 signal payload). */
export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
