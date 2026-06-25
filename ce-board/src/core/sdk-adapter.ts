/**
 * Real SDK adapter: wraps a live `CeClient` into the narrow ports the app's core logic
 * depends on. This is the ONLY module that imports @ce-net/sdk for the data path, so the
 * rest of the app (and all unit tests) stays SDK-agnostic and runs with no node.
 */

import { CeClient, bytesToUtf8, Amount } from "@ce-net/sdk";
import type { MeshLike, MeshFrame, DataLike } from "./service.ts";

/** Where the local node's HTTP+SSE API lives. */
export const DEFAULT_NODE_URL =
  typeof window !== "undefined" && window.location.origin.startsWith("http")
    ? `${window.location.origin}/ce-api` // dev: proxied by Vite to 127.0.0.1:8844
    : "http://127.0.0.1:8844";

export interface Identity {
  nodeId: string;
}

/** This node's spendable credit balance, for the status bar. */
export interface NodeMoney {
  free: Amount;
  total: Amount;
}

/** Construct a client against the local node (optionally an explicit base URL). */
export function makeClient(baseUrl: string = DEFAULT_NODE_URL): CeClient {
  return new CeClient({ baseUrl });
}

/** Liveness probe used before connecting. */
export async function nodeHealthy(client: CeClient): Promise<boolean> {
  return client.health();
}

/** Fetch this node's identity (its node id == the user's board identity). */
export async function fetchIdentity(client: CeClient): Promise<Identity> {
  const status = await client.getStatus();
  return { nodeId: status.nodeId };
}

/** Fetch the node's balance for the footer (best-effort; never throws into the UI). */
export async function fetchMoney(client: CeClient): Promise<NodeMoney | null> {
  try {
    const b = await client.wallet.balance();
    return { free: b.free, total: b.total };
  } catch {
    return null;
  }
}

/** Adapt `CeClient.mesh` to the {@link MeshLike} port. */
export function meshAdapter(client: CeClient): MeshLike {
  return {
    subscribe: (topic) => client.mesh.subscribe(topic),
    publish: (topic, payload) => client.mesh.publish(topic, payload),
    async *streamMessages(opts) {
      for await (const m of client.mesh.streamMessages(opts)) {
        const frame: MeshFrame = {
          from: m.from,
          topic: m.topic,
          text: safeUtf8(m.payload()),
          receivedAt: m.receivedAt,
        };
        yield frame;
      }
    },
  };
}

/** Adapt `CeClient.data` to the {@link DataLike} port (CE object store). */
export function dataAdapter(client: CeClient): DataLike {
  return {
    putObject: (bytes) => client.data.putObject(bytes),
    getObject: (cid) => client.data.getObject(cid),
  };
}

function safeUtf8(bytes: Uint8Array): string {
  try {
    return bytesToUtf8(bytes);
  } catch {
    return "";
  }
}
