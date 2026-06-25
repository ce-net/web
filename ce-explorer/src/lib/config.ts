import { CeClient } from "@ce-net/sdk";

/**
 * Where the explorer reads the CE node from.
 *
 * - In `vite dev` the browser hits `/ce-node`, which Vite proxies to the local
 *   node at `http://127.0.0.1:8844` (so we don't depend on the node sending
 *   permissive CORS headers).
 * - In a production build the node URL comes from `VITE_CE_NODE_URL` if set,
 *   otherwise we assume the page is served by something that proxies `/ce-node`.
 */
export function nodeBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_CE_NODE_URL as string | undefined;
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, "");
  return `${location.origin}/ce-node`;
}

/** A read-only client. The explorer never signs or spends — no token needed. */
export function makeClient(baseUrl = nodeBaseUrl()): CeClient {
  return CeClient.withToken(baseUrl);
}
