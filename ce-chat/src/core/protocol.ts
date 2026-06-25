/**
 * ce-chat wire protocol.
 *
 * Every payload that travels over a CE mesh pubsub topic is a UTF-8 JSON envelope.
 * The mesh layer already authenticates the sender (the node signs each published
 * message and reports `from` = the origin node id), so the envelope carries no
 * signature of its own — it is pure application content. We keep it small and
 * forward-compatible: unknown `t` values are ignored by the reducer, and unknown
 * fields are dropped on parse (we never re-encode someone else's envelope).
 *
 * Envelope kinds:
 *   - `msg`              a chat line in a channel or DM (optionally a thread reply)
 *   - `presence`         a periodic heartbeat announcing "I am here"
 *   - `typing`           a short-lived "is typing" hint (never stored in the log)
 *   - `react`            add/remove an emoji reaction to a target message
 *   - `edit`             replace the text of one of the author's own messages
 *   - `delete`           tombstone one of the author's own messages
 *   - `history-request`  ask peers for the last N messages on a channel
 *   - `history-response` answer a history request with a batch of messages
 *
 * IMPORTANT: every externally-supplied string is length-bounded on parse. The mesh
 * is a shared, untrusted medium — a hostile or buggy peer can ship arbitrary bytes,
 * so `parseEnvelope` is the single choke point that enforces all size limits and
 * type checks. It never throws.
 */

/** Protocol version. Bump only on a breaking envelope change. */
export const PROTOCOL_VERSION = 1 as const;

/** Max body length we will send (and the reducer will accept). */
export const MAX_TEXT_LEN = 4000;

/** Max display-name length accepted from the wire (defends against a 4 KB "name"). */
export const MAX_NAME_LEN = 64;

/** Max emoji/shortcode length for a reaction. */
export const MAX_EMOJI_LEN = 32;

/** Max message id length accepted from the wire. */
export const MAX_ID_LEN = 128;

/** Max messages a single history-response may carry (DoS bound on batch fan-in). */
export const MAX_HISTORY_BATCH = 50;

/** A chat line. */
export interface ChatMsg {
  t: "msg";
  v: number;
  /** Client-generated unique id (origin node id + nonce), used for dedupe. */
  id: string;
  /** UTF-8 body text. Trimmed, length-capped before send. */
  text: string;
  /** Author's display name (optional; falls back to short node id in the UI). */
  name?: string;
  /** Author-side wall-clock millis. Advisory only — never trusted for ordering across nodes. */
  ts: number;
  /** Optional: id of the message this is a reply to (thread root). */
  replyTo?: string;
}

/** A presence heartbeat. */
export interface PresenceMsg {
  t: "presence";
  v: number;
  /** Author's chosen display name. */
  name?: string;
  /** Author-side wall-clock millis. */
  ts: number;
}

/** A transient "is typing" hint. Never persisted. */
export interface TypingMsg {
  t: "typing";
  v: number;
  name?: string;
  ts: number;
}

/** Add or remove an emoji reaction on a target message. */
export interface ReactMsg {
  t: "react";
  v: number;
  /** id of the message being reacted to. */
  targetId: string;
  /** Emoji or :shortcode:. */
  emoji: string;
  /** add a reaction or remove a previously-added one. */
  op: "add" | "remove";
  name?: string;
  ts: number;
}

/** Replace the text of one of the author's own messages. */
export interface EditMsg {
  t: "edit";
  v: number;
  /** id of the message being edited (must be authored by `from`). */
  targetId: string;
  text: string;
  name?: string;
  ts: number;
}

/** Tombstone one of the author's own messages. */
export interface DeleteMsg {
  t: "delete";
  v: number;
  /** id of the message being deleted (must be authored by `from`). */
  targetId: string;
  name?: string;
  ts: number;
}

/** Ask peers on a channel for recent history. */
export interface HistoryRequestMsg {
  t: "history-request";
  v: number;
  /** How many recent messages we want (bounded on parse). */
  limit: number;
  /** Only return messages strictly older than this author-ts (0 = no bound). */
  before: number;
  /** Random nonce so a responder can avoid answering its own request loops. */
  nonce: string;
  ts: number;
}

/** A single message inside a history batch. */
export interface HistoryItem {
  id: string;
  from: string;
  text: string;
  name?: string;
  ts: number;
  replyTo?: string;
  /** True if the original was deleted (tombstone carried in history). */
  deleted?: boolean;
  /** Author-ts of the last edit, if edited. */
  editedAt?: number;
}

/** Answer a history request with a batch of recent messages. */
export interface HistoryResponseMsg {
  t: "history-response";
  v: number;
  /** Echoes the request nonce so the requester can match it. */
  nonce: string;
  items: HistoryItem[];
  ts: number;
}

export type Envelope =
  | ChatMsg
  | PresenceMsg
  | TypingMsg
  | ReactMsg
  | EditMsg
  | DeleteMsg
  | HistoryRequestMsg
  | HistoryResponseMsg;

/* ------------------------------------------------------------------ builders */

/** Build a chat envelope. `id` should be unique per (author, message). */
export function makeChatMsg(
  id: string,
  text: string,
  name: string | undefined,
  ts: number,
  replyTo?: string,
): ChatMsg {
  return {
    t: "msg",
    v: PROTOCOL_VERSION,
    id,
    text,
    ...(name ? { name } : {}),
    ts,
    ...(replyTo ? { replyTo } : {}),
  };
}

/** Build a presence envelope. */
export function makePresence(name: string | undefined, ts: number): PresenceMsg {
  return { t: "presence", v: PROTOCOL_VERSION, ...(name ? { name } : {}), ts };
}

/** Build a typing hint envelope. */
export function makeTyping(name: string | undefined, ts: number): TypingMsg {
  return { t: "typing", v: PROTOCOL_VERSION, ...(name ? { name } : {}), ts };
}

/** Build a reaction envelope. */
export function makeReact(
  targetId: string,
  emoji: string,
  op: "add" | "remove",
  name: string | undefined,
  ts: number,
): ReactMsg {
  return { t: "react", v: PROTOCOL_VERSION, targetId, emoji, op, ...(name ? { name } : {}), ts };
}

/** Build an edit envelope. */
export function makeEdit(targetId: string, text: string, name: string | undefined, ts: number): EditMsg {
  return { t: "edit", v: PROTOCOL_VERSION, targetId, text, ...(name ? { name } : {}), ts };
}

/** Build a delete (tombstone) envelope. */
export function makeDelete(targetId: string, name: string | undefined, ts: number): DeleteMsg {
  return { t: "delete", v: PROTOCOL_VERSION, targetId, ...(name ? { name } : {}), ts };
}

/** Build a history-request envelope. */
export function makeHistoryRequest(limit: number, before: number, nonce: string, ts: number): HistoryRequestMsg {
  return {
    t: "history-request",
    v: PROTOCOL_VERSION,
    limit: clampInt(limit, 1, MAX_HISTORY_BATCH),
    before: before > 0 ? before : 0,
    nonce,
    ts,
  };
}

/** Build a history-response envelope. The batch is capped to MAX_HISTORY_BATCH. */
export function makeHistoryResponse(nonce: string, items: HistoryItem[], ts: number): HistoryResponseMsg {
  return { t: "history-response", v: PROTOCOL_VERSION, nonce, items: items.slice(0, MAX_HISTORY_BATCH), ts };
}

/* ------------------------------------------------------------------ parsing */

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/** A finite, sane timestamp or 0. */
function asTs(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** A bounded string, or undefined. */
function asName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.slice(0, MAX_NAME_LEN);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A bounded non-empty id string, or null on failure. */
function asId(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_ID_LEN) return null;
  return v;
}

/**
 * Parse a decoded payload string into an Envelope, or return null if it is not a
 * valid ce-chat envelope. Never throws — malformed bytes on a shared topic are
 * expected (other apps may use the mesh) and must be dropped quietly. Every string
 * field is length-bounded here so no single envelope can exhaust memory or the UI.
 */
export function parseEnvelope(raw: string): Envelope | null {
  // Cheap pre-bound: an envelope larger than this is never legitimate. Guards
  // against a multi-megabyte JSON payload exhausting the parser before any field
  // check runs. MAX_TEXT_LEN plus generous slack for batches/metadata.
  if (typeof raw !== "string" || raw.length > MAX_TEXT_LEN * (MAX_HISTORY_BATCH + 4)) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o["t"] !== "string") return null;
  const ts = asTs(o["ts"]);
  const name = asName(o["name"]);

  switch (o["t"]) {
    case "msg": {
      const id = asId(o["id"]);
      if (id === null) return null;
      if (typeof o["text"] !== "string") return null;
      const text = o["text"].slice(0, MAX_TEXT_LEN);
      const replyTo = asId(o["replyTo"]) ?? undefined;
      return {
        t: "msg",
        v: PROTOCOL_VERSION,
        id,
        text,
        ...(name ? { name } : {}),
        ts,
        ...(replyTo ? { replyTo } : {}),
      };
    }
    case "presence":
      return { t: "presence", v: PROTOCOL_VERSION, ...(name ? { name } : {}), ts };
    case "typing":
      return { t: "typing", v: PROTOCOL_VERSION, ...(name ? { name } : {}), ts };
    case "react": {
      const targetId = asId(o["targetId"]);
      if (targetId === null) return null;
      if (typeof o["emoji"] !== "string" || o["emoji"].length === 0) return null;
      const emoji = o["emoji"].slice(0, MAX_EMOJI_LEN);
      const op = o["op"] === "remove" ? "remove" : "add";
      return { t: "react", v: PROTOCOL_VERSION, targetId, emoji, op, ...(name ? { name } : {}), ts };
    }
    case "edit": {
      const targetId = asId(o["targetId"]);
      if (targetId === null) return null;
      if (typeof o["text"] !== "string") return null;
      const text = o["text"].slice(0, MAX_TEXT_LEN);
      return { t: "edit", v: PROTOCOL_VERSION, targetId, text, ...(name ? { name } : {}), ts };
    }
    case "delete": {
      const targetId = asId(o["targetId"]);
      if (targetId === null) return null;
      return { t: "delete", v: PROTOCOL_VERSION, targetId, ...(name ? { name } : {}), ts };
    }
    case "history-request": {
      const nonce = asId(o["nonce"]);
      if (nonce === null) return null;
      const limit = clampInt(typeof o["limit"] === "number" ? o["limit"] : MAX_HISTORY_BATCH, 1, MAX_HISTORY_BATCH);
      const before = asTs(o["before"]);
      return { t: "history-request", v: PROTOCOL_VERSION, limit, before: before > 0 ? before : 0, nonce, ts };
    }
    case "history-response": {
      const nonce = asId(o["nonce"]);
      if (nonce === null) return null;
      const rawItems = Array.isArray(o["items"]) ? o["items"] : [];
      const items: HistoryItem[] = [];
      for (const raw of rawItems.slice(0, MAX_HISTORY_BATCH)) {
        const item = parseHistoryItem(raw);
        if (item) items.push(item);
      }
      return { t: "history-response", v: PROTOCOL_VERSION, nonce, items, ts };
    }
    default:
      return null;
  }
}

/** 64-hex node id (history items carry the original author). */
const NODE_ID_RE = /^[0-9a-f]{64}$/i;

function parseHistoryItem(raw: unknown): HistoryItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = asId(o["id"]);
  if (id === null) return null;
  if (typeof o["from"] !== "string" || !NODE_ID_RE.test(o["from"])) return null;
  if (typeof o["text"] !== "string") return null;
  const text = o["text"].slice(0, MAX_TEXT_LEN);
  const name = asName(o["name"]);
  const ts = asTs(o["ts"]);
  const replyTo = asId(o["replyTo"]) ?? undefined;
  const deleted = o["deleted"] === true;
  const editedAt = asTs(o["editedAt"]);
  return {
    id,
    from: o["from"].toLowerCase(),
    text,
    ...(name ? { name } : {}),
    ts,
    ...(replyTo ? { replyTo } : {}),
    ...(deleted ? { deleted: true } : {}),
    ...(editedAt > 0 ? { editedAt } : {}),
  };
}

/** Serialize an envelope to a UTF-8 JSON string (ready to be turned into bytes). */
export function encodeEnvelope(e: Envelope): string {
  return JSON.stringify(e);
}
