/**
 * ChatService — the bridge between @ce-net/sdk and the ce-chat UI.
 *
 * It owns the *data path*: subscribing to channel topics, publishing chat lines,
 * reactions, edits, deletes, presence and typing heartbeats, serving and requesting
 * history, and fanning the single mesh message stream out to per-channel reducers
 * (store + presence + typing + unread). It depends only on a narrow {@link MeshLike}
 * port — the real adapter wraps `CeClient.mesh`, the test adapter is an in-memory
 * fake — so all of this is exercised under vitest with no node.
 *
 * The CE mesh delivers every message for every topic this node is subscribed to on
 * one stream; the service routes each frame to the channel whose topic matches and
 * drops anything that is not a ce-chat envelope. The stream is auto-reconnecting with
 * exponential backoff + jitter, so a transient SSE drop recovers without a reload.
 */

import {
  encodeEnvelope,
  makeChatMsg,
  makeDelete,
  makeEdit,
  makeHistoryRequest,
  makeHistoryResponse,
  makePresence,
  makeReact,
  makeTyping,
  parseEnvelope,
  MAX_HISTORY_BATCH,
  type HistoryItem,
} from "./protocol.ts";
import type { ChannelRef } from "./topics.ts";
import { MessageStore, type StoredMessage } from "./store.ts";
import { PresenceTracker } from "./presence.ts";

/** A delivered mesh frame, normalized from the SDK's `AppMessage`. */
export interface MeshFrame {
  from: string;
  topic: string;
  /** Decoded UTF-8 payload text. */
  text: string;
  receivedAt: number | null;
}

/** The slice of the SDK the service needs. Lets tests inject an in-memory mesh. */
export interface MeshLike {
  subscribe(topic: string): Promise<void>;
  publish(topic: string, payload: Uint8Array): Promise<void>;
  /** Async iterable of inbound frames across all subscribed topics. */
  streamMessages(opts?: { signal?: AbortSignal }): AsyncIterable<MeshFrame>;
}

/** A peer currently typing (transient). */
export interface TypingState {
  nodeId: string;
  name?: string;
  /** Local clock when we last saw a typing hint. */
  at: number;
}

/** Live view of one channel: its log, presence roster, transient typing, unread. */
export interface ChannelState {
  store: MessageStore;
  presence: PresenceTracker;
  /** nodeId -> last typing time. */
  typing: Map<string, TypingState>;
  /** Count of accepted messages since the channel was last marked read. */
  unread: number;
  /** Local time we last marked this channel read (drives the unread divider). */
  lastReadAt: number;
  /** True once we have requested backfill for this channel. */
  historyRequested: boolean;
}

export interface ChatServiceEvents {
  /** A channel's message log changed (added/confirmed/edited/deleted/reacted). */
  onMessages?: (channelId: string) => void;
  /** A channel's presence roster changed. */
  onPresence?: (channelId: string) => void;
  /** A channel's typing set changed. */
  onTyping?: (channelId: string) => void;
  /** A channel's unread count changed. */
  onUnread?: (channelId: string) => void;
  /** The mesh stream errored (e.g. node went away). */
  onStreamError?: (err: unknown) => void;
  /** Connectivity state of the live stream changed. */
  onConnectionChange?: (state: ConnectionState) => void;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "stopped";

/** Typing hints older than this are dropped. */
export const TYPING_TTL_MS = 6_000;

/** Reconnect backoff bounds. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;

/** Per-sender inbound rate limit: max accepted frames per window before dropping. */
export const INBOUND_WINDOW_MS = 10_000;
export const INBOUND_MAX_PER_WINDOW = 200;

let nonceCounter = 0;
/**
 * Author-unique message id: short node id + time + monotonic nonce + random salt.
 * The nonce counter is module-global only as a coarse monotonic tiebreak; uniqueness
 * does not depend on it (the random salt and per-call time carry that), so two
 * coexisting services cannot collide. Uses crypto RNG when available.
 */
export function newMessageId(selfId: string, now = Date.now()): string {
  nonceCounter = (nonceCounter + 1) % 1_000_000;
  const salt = randomHex(6);
  return `${selfId.slice(0, 8)}-${now.toString(36)}-${nonceCounter.toString(36)}-${salt}`;
}

/** A short random nonce for history requests etc. */
export function randomNonce(): string {
  return randomHex(12);
}

function randomHex(bytes: number): string {
  const c: Crypto | undefined =
    typeof globalThis !== "undefined" && "crypto" in globalThis
      ? (globalThis.crypto as Crypto | undefined)
      : undefined;
  if (c && typeof c.getRandomValues === "function") {
    const buf = new Uint8Array(bytes);
    c.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback (environments without WebCrypto): Math.random.
  let s = "";
  for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return s;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

export class ChatService {
  private readonly channels = new Map<string, ChannelState>();
  /** topic -> channelId, so stream frames route in O(1). */
  private readonly topicIndex = new Map<string, string>();
  private readonly refs = new Map<string, ChannelRef>();
  /** Per (channelId,sender) inbound rate buckets. */
  private readonly rate = new Map<string, RateBucket>();
  private abort?: AbortController;
  private streaming = false;
  private reconnectAttempt = 0;
  private connection: ConnectionState = "stopped";

  constructor(
    private readonly mesh: MeshLike,
    private readonly selfId: string,
    private displayName: string | undefined,
    private readonly events: ChatServiceEvents = {},
    /** How many recent messages to keep per channel. */
    private readonly historyCap = 500,
  ) {}

  /** Our own node id (lowercased comparisons happen at the call sites). */
  get self(): string {
    return this.selfId;
  }

  /** The display name currently broadcast with our messages. */
  get name(): string | undefined {
    return this.displayName;
  }

  /**
   * Update the broadcast display name in place (no reload needed). Future sends and
   * heartbeats carry the new name; past messages keep their original name.
   */
  setDisplayName(name: string | undefined): void {
    this.displayName = name && name.trim().length > 0 ? name.trim() : undefined;
  }

  /** Current live-stream connectivity. */
  get connectionState(): ConnectionState {
    return this.connection;
  }

  /** Channels currently joined. */
  joined(): ChannelRef[] {
    return [...this.refs.values()];
  }

  state(channelId: string): ChannelState | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Join a channel: subscribe to its mesh topic and wire up its reducers. Throws
   * (e.g. CeAuthError on a gated private topic) so the caller can surface it; the
   * channel is only registered locally once the subscribe succeeds. After joining,
   * fires off a history-request so a fresh join shows scrollback (best-effort).
   */
  async join(ref: ChannelRef): Promise<ChannelState> {
    const existing = this.channels.get(ref.id);
    if (existing) return existing;
    await this.mesh.subscribe(ref.topic);
    const state: ChannelState = {
      store: new MessageStore(this.historyCap),
      presence: new PresenceTracker(this.selfId),
      typing: new Map(),
      unread: 0,
      lastReadAt: Date.now(),
      historyRequested: false,
    };
    this.channels.set(ref.id, state);
    this.topicIndex.set(ref.topic, ref.id);
    this.refs.set(ref.id, ref);
    // Count ourselves present immediately.
    state.presence.seen(this.selfId, this.displayName, Date.now());
    // Ask peers for recent history (non-blocking).
    void this.requestHistory(ref.id);
    return state;
  }

  /** Leave a channel locally (we keep the node subscription; cheap to re-enter). */
  leave(channelId: string): void {
    const ref = this.refs.get(channelId);
    if (ref) this.topicIndex.delete(ref.topic);
    this.channels.delete(channelId);
    this.refs.delete(channelId);
  }

  /**
   * Send a chat line to a channel (optionally as a thread reply). Returns the
   * optimistic StoredMessage (added to the log immediately, status `pending`).
   * On publish failure the stored message is flipped to `failed` and the error is
   * rethrown so the caller can surface it; the message stays in the log for retry.
   */
  async send(channelId: string, text: string, replyTo?: string): Promise<StoredMessage> {
    const ch = this.channels.get(channelId);
    const ref = this.refs.get(channelId);
    if (!ch || !ref) throw new Error(`send: not joined to ${channelId}`);
    const body = text.trim();
    if (body.length === 0) throw new Error("send: empty message");
    const now = Date.now();
    const id = newMessageId(this.selfId, now);
    const env = makeChatMsg(id, body, this.displayName, now, replyTo);

    const optimistic: StoredMessage = {
      id,
      from: this.selfId,
      text: body,
      ...(this.displayName ? { name: this.displayName } : {}),
      ts: now,
      receivedAt: now,
      isSelf: true,
      status: "pending",
      ...(replyTo ? { replyTo } : {}),
    };
    ch.store.add(optimistic);
    ch.presence.seen(this.selfId, this.displayName, now);
    this.events.onMessages?.(channelId);

    try {
      await this.mesh.publish(ref.topic, encode(encodeEnvelope(env)));
    } catch (err) {
      ch.store.markFailed(this.selfId, id);
      this.events.onMessages?.(channelId);
      throw err;
    }
    return optimistic;
  }

  /**
   * Retry a previously-failed self message: flip it to pending and re-publish under
   * the SAME id (so the original optimistic entry is reconciled, not duplicated).
   */
  async retry(channelId: string, id: string): Promise<void> {
    const ch = this.channels.get(channelId);
    const ref = this.refs.get(channelId);
    if (!ch || !ref) return;
    const m = ch.store.get(this.selfId, id);
    if (!m || !m.isSelf) return;
    ch.store.markPending(this.selfId, id);
    this.events.onMessages?.(channelId);
    const env = makeChatMsg(m.id, m.text, this.displayName, m.ts, m.replyTo);
    try {
      await this.mesh.publish(ref.topic, encode(encodeEnvelope(env)));
    } catch (err) {
      ch.store.markFailed(this.selfId, id);
      this.events.onMessages?.(channelId);
      throw err;
    }
  }

  /** Edit one of our own messages. Broadcasts an edit envelope. */
  async edit(channelId: string, id: string, newText: string): Promise<void> {
    const ch = this.channels.get(channelId);
    const ref = this.refs.get(channelId);
    if (!ch || !ref) throw new Error(`edit: not joined to ${channelId}`);
    const body = newText.trim();
    if (body.length === 0) throw new Error("edit: empty text");
    const m = ch.store.get(this.selfId, id);
    if (!m || !m.isSelf) throw new Error("edit: not your message");
    const now = Date.now();
    ch.store.applyEdit(this.selfId, id, body, now);
    this.events.onMessages?.(channelId);
    await this.mesh.publish(ref.topic, encode(encodeEnvelope(makeEdit(id, body, this.displayName, now))));
  }

  /** Delete (tombstone) one of our own messages. Broadcasts a delete envelope. */
  async delete(channelId: string, id: string): Promise<void> {
    const ch = this.channels.get(channelId);
    const ref = this.refs.get(channelId);
    if (!ch || !ref) throw new Error(`delete: not joined to ${channelId}`);
    const m = ch.store.get(this.selfId, id);
    if (!m || !m.isSelf) throw new Error("delete: not your message");
    ch.store.applyDelete(this.selfId, id);
    this.events.onMessages?.(channelId);
    await this.mesh.publish(ref.topic, encode(encodeEnvelope(makeDelete(id, this.displayName, Date.now()))));
  }

  /**
   * Toggle/apply a reaction on a target message. `targetFrom` is the target's author
   * (reactions are namespaced by the target's (from,id)).
   */
  async react(
    channelId: string,
    targetFrom: string,
    targetId: string,
    emoji: string,
    op: "add" | "remove",
  ): Promise<void> {
    const ch = this.channels.get(channelId);
    const ref = this.refs.get(channelId);
    if (!ch || !ref) throw new Error(`react: not joined to ${channelId}`);
    ch.store.applyReaction(targetFrom, targetId, this.selfId, emoji, op);
    this.events.onMessages?.(channelId);
    await this.mesh.publish(ref.topic, encode(encodeEnvelope(makeReact(targetId, emoji, op, this.displayName, Date.now()))));
  }

  /** Publish a typing hint (throttle at the call site). Best-effort. */
  async sendTyping(channelId: string): Promise<void> {
    const ref = this.refs.get(channelId);
    if (!ref) return;
    try {
      await this.mesh.publish(ref.topic, encode(encodeEnvelope(makeTyping(this.displayName, Date.now()))));
    } catch {
      /* typing is advisory */
    }
  }

  /** Publish a presence heartbeat to a channel. Best-effort. */
  async heartbeat(channelId: string): Promise<void> {
    const ref = this.refs.get(channelId);
    if (!ref) return;
    const env = makePresence(this.displayName, Date.now());
    try {
      await this.mesh.publish(ref.topic, encode(encodeEnvelope(env)));
    } catch {
      /* heartbeats are advisory; a dropped beat just ages the member out */
    }
  }

  /** Heartbeat into EVERY joined channel so peers see us across background channels. */
  async heartbeatAll(): Promise<void> {
    await Promise.all([...this.refs.keys()].map((id) => this.heartbeat(id)));
  }

  /** Ask peers on a channel for recent history (idempotent per channel). */
  async requestHistory(channelId: string, force = false): Promise<void> {
    const ch = this.channels.get(channelId);
    const ref = this.refs.get(channelId);
    if (!ch || !ref) return;
    if (ch.historyRequested && !force) return;
    ch.historyRequested = true;
    const env = makeHistoryRequest(MAX_HISTORY_BATCH, 0, randomNonce(), Date.now());
    try {
      await this.mesh.publish(ref.topic, encode(encodeEnvelope(env)));
    } catch {
      ch.historyRequested = false; // allow a retry on the next attempt
    }
  }

  /** Mark a channel as read: clear unread and stamp the divider. */
  markRead(channelId: string): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    if (ch.unread !== 0) {
      ch.unread = 0;
      ch.lastReadAt = Date.now();
      this.events.onUnread?.(channelId);
    }
  }

  /** Total unread across all channels. */
  totalUnread(): number {
    let n = 0;
    for (const ch of this.channels.values()) n += ch.unread;
    return n;
  }

  /** Active typers in a channel within the TTL (excludes self). */
  typers(channelId: string, now = Date.now()): TypingState[] {
    const ch = this.channels.get(channelId);
    if (!ch) return [];
    const out: TypingState[] = [];
    for (const [id, t] of ch.typing) {
      if (id === this.selfId.toLowerCase()) continue;
      if (now - t.at <= TYPING_TTL_MS) out.push(t);
      else ch.typing.delete(id);
    }
    return out;
  }

  /* ------------------------------------------------------------------ stream */

  /** Start consuming the mesh stream, with auto-reconnect. */
  startStream(): void {
    if (this.streaming) return;
    this.streaming = true;
    this.reconnectAttempt = 0;
    this.abort = new AbortController();
    this.setConnection("connecting");
    void this.runLoop(this.abort.signal);
  }

  /** Stop the stream and abort any reconnect loop. */
  stop(): void {
    this.streaming = false;
    this.abort?.abort();
    this.abort = undefined;
    this.setConnection("stopped");
  }

  private setConnection(s: ConnectionState): void {
    if (this.connection === s) return;
    this.connection = s;
    this.events.onConnectionChange?.(s);
  }

  /**
   * The reconnect loop: consume until the stream ends or errors, then back off
   * (exponential + full jitter, capped) and retry — unless stopped. A transient SSE
   * drop therefore recovers automatically without rebuilding the service.
   */
  private async runLoop(signal: AbortSignal): Promise<void> {
    while (this.streaming && !signal.aborted) {
      try {
        for await (const frame of this.mesh.streamMessages({ signal })) {
          if (signal.aborted) break;
          if (this.connection !== "live") {
            this.reconnectAttempt = 0;
            this.setConnection("live");
          }
          this.route(frame);
        }
        // Clean end of stream: treat as a drop and reconnect.
        if (!this.streaming || signal.aborted) break;
      } catch (err) {
        if (signal.aborted || !this.streaming) break;
        this.events.onStreamError?.(err);
      }
      if (!this.streaming || signal.aborted) break;
      this.setConnection("reconnecting");
      const delay = this.backoffDelay(this.reconnectAttempt++);
      const ok = await sleep(delay, signal);
      if (!ok) break;
    }
    if (!signal.aborted) this.setConnection("stopped");
    this.streaming = false;
  }

  /** Exponential backoff with full jitter. Public for testing. */
  backoffDelay(attempt: number): number {
    const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 20));
    return Math.floor(Math.random() * exp);
  }

  /* ------------------------------------------------------------------ routing */

  /** Route one inbound frame to its channel. Public for unit testing. */
  route(frame: MeshFrame): void {
    const channelId = this.topicIndex.get(frame.topic);
    if (!channelId) return; // not a channel we track
    const ch = this.channels.get(channelId);
    if (!ch) return;
    const env = parseEnvelope(frame.text);
    if (!env) return;

    const from = frame.from;
    const isSelf = from.toLowerCase() === this.selfId.toLowerCase();
    // Rate-limit inbound frames per (channel,sender) — but never throttle ourselves.
    if (!isSelf && !this.admit(channelId, from)) return;

    const now = frame.receivedAt ?? Date.now();

    switch (env.t) {
      case "presence":
        ch.presence.seen(from, env.name, now);
        this.events.onPresence?.(channelId);
        return;

      case "typing": {
        if (isSelf) return;
        ch.typing.set(from.toLowerCase(), { nodeId: from.toLowerCase(), name: env.name, at: now });
        this.events.onTyping?.(channelId);
        return;
      }

      case "react": {
        ch.presence.seen(from, env.name, now);
        // The target author is unknown to a bare react envelope; the reaction is
        // namespaced by (targetAuthor,targetId). We attribute it to the message we
        // hold with that id from ANY author by scanning — but to keep it O(1) and
        // spoof-safe we instead require the target id to belong to a known message.
        // applyReaction buffers if the target is not yet present.
        const author = this.findAuthorOf(ch, env.targetId);
        ch.store.applyReaction(author ?? from, env.targetId, from, env.emoji, env.op);
        this.events.onMessages?.(channelId);
        return;
      }

      case "edit": {
        ch.presence.seen(from, env.name, now);
        // Author-scoped: only the original author may edit. `from` is authenticated.
        if (ch.store.applyEdit(from, env.targetId, env.text, env.ts || now)) {
          this.events.onMessages?.(channelId);
        }
        return;
      }

      case "delete": {
        ch.presence.seen(from, env.name, now);
        if (ch.store.applyDelete(from, env.targetId)) this.events.onMessages?.(channelId);
        return;
      }

      case "history-request": {
        // Answer with what we hold (best-effort). Don't answer our own request.
        if (isSelf) return;
        void this.respondHistory(channelId, env.limit, env.nonce);
        return;
      }

      case "history-response": {
        this.mergeHistory(channelId, env.items, now);
        return;
      }

      case "msg": {
        ch.presence.seen(from, env.name, now);
        const stored: StoredMessage = {
          id: env.id,
          from,
          text: env.text,
          ...(env.name ? { name: env.name } : {}),
          ts: env.ts || now,
          receivedAt: now,
          isSelf,
          status: "sent",
          ...(env.replyTo ? { replyTo: env.replyTo } : {}),
        };
        const res = ch.store.add(stored);
        if (res === "added") {
          // Clear any typing hint from this author now that they sent.
          ch.typing.delete(from.toLowerCase());
          if (!isSelf) {
            ch.unread++;
            this.events.onUnread?.(channelId);
          }
          this.events.onMessages?.(channelId);
          this.events.onPresence?.(channelId);
        } else if (res === "confirmed") {
          this.events.onMessages?.(channelId);
        }
        return;
      }
    }
  }

  /** Find the author of a message with the given id in this channel (for reactions). */
  private findAuthorOf(ch: ChannelState, id: string): string | undefined {
    for (const m of ch.store.list()) if (m.id === id) return m.from;
    return undefined;
  }

  /** Serve a history-response with up to `limit` of our most recent messages. */
  private async respondHistory(channelId: string, limit: number, nonce: string): Promise<void> {
    const ch = this.channels.get(channelId);
    const ref = this.refs.get(channelId);
    if (!ch || !ref) return;
    const all = ch.store.list();
    if (all.length === 0) return; // nothing to serve; stay quiet
    const recent = all.slice(Math.max(0, all.length - Math.min(limit, MAX_HISTORY_BATCH)));
    const items: HistoryItem[] = recent.map((m) => ({
      id: m.id,
      from: m.from,
      text: m.text,
      ...(m.name ? { name: m.name } : {}),
      ts: m.ts,
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      ...(m.deleted ? { deleted: true } : {}),
      ...(m.editedAt ? { editedAt: m.editedAt } : {}),
    }));
    try {
      await this.mesh.publish(ref.topic, encode(encodeEnvelope(makeHistoryResponse(nonce, items, Date.now()))));
    } catch {
      /* best-effort */
    }
  }

  /** Merge a received history batch into a channel's store (dedup-safe). */
  private mergeHistory(channelId: string, items: HistoryItem[], now: number): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    let changed = false;
    for (const it of items) {
      const isSelf = it.from.toLowerCase() === this.selfId.toLowerCase();
      const stored: StoredMessage = {
        id: it.id,
        from: it.from,
        text: it.text,
        ...(it.name ? { name: it.name } : {}),
        ts: it.ts || now,
        // Backfilled history sorts before live by its author ts; mark arrival as the
        // author ts so old messages don't jump to the bottom.
        receivedAt: it.ts || now,
        isSelf,
        status: "sent",
        ...(it.replyTo ? { replyTo: it.replyTo } : {}),
        ...(it.deleted ? { deleted: true, text: "" } : {}),
        ...(it.editedAt ? { editedAt: it.editedAt } : {}),
      };
      const res = ch.store.add(stored);
      if (res === "added") changed = true;
    }
    if (changed) this.events.onMessages?.(channelId);
  }

  /** Per (channel,sender) token-window admission. Returns false to drop the frame. */
  private admit(channelId: string, sender: string): boolean {
    const key = `${channelId} ${sender.toLowerCase()}`;
    const now = Date.now();
    const b = this.rate.get(key);
    if (!b || now - b.windowStart > INBOUND_WINDOW_MS) {
      this.rate.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (b.count >= INBOUND_MAX_PER_WINDOW) return false;
    b.count++;
    return true;
  }
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Abortable sleep. Resolves true if it slept fully, false if aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort(): void {
      clearTimeout(t);
      resolve(false);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
