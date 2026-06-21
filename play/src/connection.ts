/**
 * Connection manager: builds a `CeClient` for the chosen target and keeps a live status
 * snapshot for the status bar.
 *
 *  - "browser": the in-browser WASM node via the `window.__ceNode` bridge (no install).
 *  - "local":   the developer's own `ce start` on `http://127.0.0.1:8844`, reachable
 *               thanks to the node's read-only CORS layer (PLAN §2.1). A token can be
 *               supplied for write recipes; reads work without one.
 *
 * The token (when present) is only ever read from the user's own input field and handed
 * straight to the SDK — it never appears in editable recipe code, matching the launch
 * checklist's exfiltration constraint.
 */

import { CeClient } from "@ce-net/sdk";
import { BRIDGE_BASE_URL, bridgeAvailable, bridgeFetch, getBridge } from "./bridge.js";

export type Target = "browser" | "local";

export interface Snapshot {
  ok: boolean;
  nodeId?: string;
  height?: number;
  balance?: string;
  peers?: number;
  error?: string;
}

const LOCAL_BASE_URL = "http://127.0.0.1:8844";

export class Connection {
  target: Target = "browser";
  private token: string | undefined;

  /** Build a fresh client for the current target + token. */
  client(): CeClient {
    if (this.target === "browser") {
      const bridge = getBridge();
      if (bridge) {
        return new CeClient({ baseUrl: BRIDGE_BASE_URL, fetch: bridgeFetch(bridge) });
      }
      // No bridge injected: construct a client that will fail loudly when used, so the
      // recipe surfaces a clear "in-browser node unavailable" error rather than hanging.
      return new CeClient({ baseUrl: BRIDGE_BASE_URL });
    }
    return this.token !== undefined && this.token.length > 0
      ? CeClient.withToken(LOCAL_BASE_URL, this.token)
      : CeClient.withToken(LOCAL_BASE_URL);
  }

  setTarget(t: Target): void {
    this.target = t;
  }

  setToken(t: string): void {
    this.token = t.trim().length > 0 ? t.trim() : undefined;
  }

  /** Can the current target run at all right now? */
  ready(): { ok: boolean; reason?: string } {
    if (this.target === "browser" && !bridgeAvailable()) {
      return {
        ok: false,
        reason:
          "No in-browser node detected (window.__ceNode). Open the browser node, or switch to “my local node”.",
      };
    }
    return { ok: true };
  }

  /** Poll a lightweight status snapshot for the status bar. Never throws. */
  async snapshot(): Promise<Snapshot> {
    const r = this.ready();
    if (!r.ok) return { ok: false, error: r.reason ?? "not ready" };
    try {
      const ce = this.client();
      const s = await ce.getStatus();
      let peers: number | undefined;
      try {
        peers = (await ce.bootstrap()).peers.length;
      } catch {
        peers = undefined;
      }
      return {
        ok: true,
        nodeId: s.nodeId,
        height: s.height,
        balance: `${s.balance.toCredits()} cr`,
        ...(peers !== undefined ? { peers } : {}),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
