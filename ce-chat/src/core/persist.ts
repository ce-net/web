/**
 * Local persistence for ce-chat session UI state.
 *
 * What persists across reloads:
 *   - the joined channel/DM list (so custom channels survive a refresh),
 *   - per-channel composer drafts,
 *   - the display name,
 *   - an optional node-URL override (target a remote/alternate node without editing source).
 *
 * Message history is intentionally NOT persisted here — it is mesh-served via the
 * history-request/response protocol. This module is a thin, defensive wrapper over a
 * `StorageLike` (window.localStorage in the browser, an in-memory map in tests). Every
 * read validates and bounds its input, so corrupt or hostile storage can never crash
 * boot or smuggle an oversize value into the app.
 */

import type { ChannelRef } from "./topics.ts";
import { publicChannel, privateChannel, dmChannel, isValidChannelName, isNodeId } from "./topics.ts";

/** The subset of the Web Storage API we use. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const K_CHANNELS = "ce-chat:channels:v1";
const K_DRAFTS = "ce-chat:drafts:v1";
const K_NAME = "ce-chat:name";
const K_NODE_URL = "ce-chat:nodeUrl";

/** Max persisted channels (bounds storage + boot cost). */
export const MAX_PERSISTED_CHANNELS = 200;
/** Max draft length persisted (matches composer cap headroom). */
export const MAX_DRAFT_LEN = 8000;

/** A serializable channel descriptor (the minimum needed to rebuild a ChannelRef). */
interface StoredChannel {
  kind: "public" | "private" | "dm";
  name?: string;
  peer?: string;
  label?: string;
}

/** Read the persisted channel list and rebuild refs relative to `selfId`. */
export function loadChannels(store: StorageLike, selfId: string): ChannelRef[] {
  const raw = safeGet(store, K_CHANNELS);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ChannelRef[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.slice(0, MAX_PERSISTED_CHANNELS)) {
    const ref = rebuildRef(entry, selfId);
    if (ref && !seen.has(ref.id)) {
      seen.add(ref.id);
      out.push(ref);
    }
  }
  return out;
}

function rebuildRef(entry: unknown, selfId: string): ChannelRef | null {
  if (typeof entry !== "object" || entry === null) return null;
  const o = entry as Record<string, unknown>;
  const kind = o["kind"];
  try {
    if (kind === "public" && typeof o["name"] === "string" && isValidChannelName(o["name"])) {
      return publicChannel(o["name"]);
    }
    if (kind === "private" && typeof o["name"] === "string" && isValidChannelName(o["name"])) {
      return privateChannel(o["name"]);
    }
    if (kind === "dm" && typeof o["peer"] === "string" && isNodeId(o["peer"])) {
      const peer = o["peer"].toLowerCase();
      if (peer === selfId.toLowerCase()) return null;
      const label = typeof o["label"] === "string" ? o["label"].slice(0, 64) : peer.slice(0, 10);
      return dmChannel(selfId, peer, label);
    }
  } catch {
    return null;
  }
  return null;
}

/** Persist the current joined channel list. */
export function saveChannels(store: StorageLike, refs: ChannelRef[]): void {
  const items: StoredChannel[] = [];
  for (const r of refs.slice(0, MAX_PERSISTED_CHANNELS)) {
    if (r.kind === "dm") {
      if (r.peer) items.push({ kind: "dm", peer: r.peer, label: r.label });
    } else {
      items.push({ kind: r.kind, name: r.label });
    }
  }
  safeSet(store, K_CHANNELS, JSON.stringify(items));
}

/** Load all per-channel drafts. */
export function loadDrafts(store: StorageLike): Map<string, string> {
  const raw = safeGet(store, K_DRAFTS);
  const out = new Map<string, string>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null) return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out.set(k, v.slice(0, MAX_DRAFT_LEN));
  }
  return out;
}

/** Persist all per-channel drafts. Empty drafts are dropped. */
export function saveDrafts(store: StorageLike, drafts: Map<string, string>): void {
  const obj: Record<string, string> = {};
  for (const [k, v] of drafts) {
    const t = v.slice(0, MAX_DRAFT_LEN);
    if (t.length > 0) obj[k] = t;
  }
  safeSet(store, K_DRAFTS, JSON.stringify(obj));
}

/** Load the persisted display name (bounded). */
export function loadName(store: StorageLike): string | undefined {
  const v = safeGet(store, K_NAME);
  return v && v.length > 0 ? v.slice(0, 64) : undefined;
}

/** Persist (or clear) the display name. */
export function saveName(store: StorageLike, name: string | undefined): void {
  if (name && name.trim().length > 0) safeSet(store, K_NAME, name.trim().slice(0, 64));
  else safeRemove(store, K_NAME);
}

/** Load a node-URL override, validated as an http(s) URL. */
export function loadNodeUrl(store: StorageLike): string | undefined {
  const v = safeGet(store, K_NODE_URL);
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol === "http:" || u.protocol === "https:") return v;
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Persist (or clear) the node-URL override. */
export function saveNodeUrl(store: StorageLike, url: string | undefined): void {
  if (!url) {
    safeRemove(store, K_NODE_URL);
    return;
  }
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") safeSet(store, K_NODE_URL, url);
  } catch {
    /* ignore invalid */
  }
}

/* ----------------------------------------------------------- safe primitives */

function safeGet(store: StorageLike, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(store: StorageLike, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}
function safeRemove(store: StorageLike, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    /* non-fatal */
  }
}

/** An in-memory StorageLike for tests and SSR-safe boot. */
export function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}
