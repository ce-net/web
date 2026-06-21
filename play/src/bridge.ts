/**
 * Browser-node bridge → `fetch` adapter.
 *
 * The playground design (PLAN/07-demos-dx.md §2.2) specifies a `window.__ceNode`
 * object that the in-browser WASM node (web/site/node.html + ce-hub) exposes, giving
 * same-origin JS a node's HTTP surface without a network hop. The *real* `@ce-net/sdk`
 * (this repo's ce-ts) is constructed with a `baseUrl` + an injectable `fetch` — it does
 * not take a raw transport object. So the clean, real integration is: wrap the bridge in
 * a `fetch`-shaped function and hand it to `new CeClient({ baseUrl, fetch })`. The SDK
 * then drives the in-browser node through its normal request path, unmodified.
 *
 * This file defines that bridge contract (`CeNodeBridge`) and the adapter. If no bridge
 * is present (the WASM browser-node workstream hasn't injected `window.__ceNode` yet),
 * the playground reports it and degrades to local-node-only — exactly the documented
 * fallback. TODO(browser-node): ce-hub/node.html must implement `CeNodeBridge`.
 */

/**
 * The method surface the in-browser node exposes on `window.__ceNode`. This is the
 * acceptance contract between this playground and the browser-node bridge workstream.
 * Every method maps 1:1 to an HTTP route the SDK calls. All are optional so a partial
 * bridge still serves the recipes it can; unimplemented routes surface as 501.
 */
export interface CeNodeBridge {
  /** Node identifier + a marker so the adapter can confirm presence. */
  readonly nodeId?: string;
  /** Dispatch a request by method + path, returning a JSON-serializable value or bytes. */
  request(req: BridgeRequest): Promise<BridgeResponse>;
  /**
   * Open an SSE-style stream for a path ending in `/stream`. Yields decoded `data:` payloads.
   * Optional — recipes that need streams check for it and skip if absent.
   */
  stream?(path: string, signal: AbortSignal): AsyncIterable<string>;
}

export interface BridgeRequest {
  method: string;
  /** Path beginning with `/`, e.g. `/status`, `/blobs/<hash>`. */
  path: string;
  /** Parsed JSON body for writes, or raw bytes for `/blobs`. */
  jsonBody?: unknown;
  rawBody?: Uint8Array;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface BridgeResponse {
  status: number;
  /** Exactly one of these is set. */
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
}

/** Sentinel base URL the adapter recognises as "route to the bridge, not the network". */
export const BRIDGE_BASE_URL = "http://ce-browser-node.local";

/** True when an in-browser node bridge is present on `window`. */
export function bridgeAvailable(): boolean {
  return typeof getBridge() === "object" && getBridge() !== null;
}

/** Read the injected bridge, if any. */
export function getBridge(): CeNodeBridge | null {
  const w = globalThis as { __ceNode?: CeNodeBridge };
  return w.__ceNode ?? null;
}

/**
 * A `fetch`-compatible function that routes calls aimed at {@link BRIDGE_BASE_URL} into
 * the `window.__ceNode` bridge, and otherwise throws (the playground only ever points the
 * bridge client at the sentinel URL). SSE GETs (paths ending `/stream`) are served from the bridge's
 * optional `stream()` as a `ReadableStream` so the SDK's SSE parser consumes them normally.
 */
export function bridgeFetch(bridge: CeNodeBridge): typeof fetch {
  const impl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    const path = u.pathname + u.search;
    const method = (init?.method ?? "GET").toUpperCase();
    const signal = init?.signal ?? new AbortController().signal;

    // SSE streams.
    if (path.endsWith("/stream")) {
      if (!bridge.stream) {
        return jsonResponse(501, { error: "in-browser node does not expose streams" });
      }
      const iter = bridge.stream(path, signal as AbortSignal);
      const body = sseReadable(iter, signal as AbortSignal);
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    const headers = headersToRecord(init?.headers);
    const req: BridgeRequest = {
      method,
      path,
      headers,
      signal: signal as AbortSignal,
    };
    const raw = init?.body;
    if (raw instanceof Uint8Array) req.rawBody = raw;
    else if (typeof raw === "string" && raw.length > 0) {
      try {
        req.jsonBody = JSON.parse(raw);
      } catch {
        req.jsonBody = raw;
      }
    }

    const res = await bridge.request(req);
    if (res.bytes !== undefined) {
      return new Response(toArrayBufferView(res.bytes), {
        status: res.status,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (res.text !== undefined) {
      return new Response(res.text, {
        status: res.status,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return jsonResponse(res.status, res.json ?? null);
  };
  return impl as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
  } else {
    Object.assign(out, h);
  }
  return out;
}

/** Wrap an async iterable of SSE `data` strings into a ReadableStream of `data: ...` frames. */
function sseReadable(iter: AsyncIterable<string>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const data of iter) {
          if (cancelled || signal.aborted) break;
          controller.enqueue(enc.encode(`data: ${data}\n\n`));
        }
      } catch (err) {
        if (!cancelled) controller.error(err);
        return;
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
}

function toArrayBufferView(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
