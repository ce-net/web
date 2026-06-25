/**
 * Browser-node bridge → `fetch` adapter (playground re-export).
 *
 * The real, shared implementation now lives in `@ce-net/sdk` (`ce-ts/src/browser-node.ts`)
 * so every workstream — the playground, the mesh-native `@ce/client`, and any app served
 * behind the strict CSP — drives the in-browser node through ONE contract. This file is a
 * thin re-export kept for the playground's existing imports.
 *
 * SHARED CONTRACT (see `@ce-net/sdk`):
 *
 *   window.__ceNode: CeNodeBridge
 *     request(method, path, init?) => Promise<{ status, headers, body }>
 *
 * The bridge dispatches IN-PROCESS to the in-browser WASM CE node — it never touches the
 * network. The sentinel base URL `http://ce-browser-node.local` is what marks a request as
 * "route to the bridge". `bridgeFetch(bridge)` wraps a bridge in a `fetch`-shaped function
 * so the SDK's normal request + SSE paths consume it unmodified.
 *
 * If no bridge is present (the WASM browser-node hasn't injected `window.__ceNode` yet), the
 * playground reports it and degrades to local-node-only — the documented fallback. The
 * producer page is `web/site/node.html`.
 */

export {
  BRIDGE_BASE_URL,
  bridgeAvailable,
  getBridge,
  bridgeFetch,
  connectNode,
  CE_STRICT_CSP,
} from "@ce-net/sdk";

export type {
  CeNodeBridge,
  BridgeRequestInit,
  BridgeResponse,
  ConnectNodeOptions,
} from "@ce-net/sdk";
