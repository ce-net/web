// Type definitions for CE NETGAME — authoritative distributed multiplayer over CE hub
// primitives (realtime room pub/sub + /db snapshots + /nodes scoring). See netgame.js.

/** Context passed to your tick() on the host each authoritative step. */
export interface TickCtx {
  /** Wall-clock time (Date.now()) at the start of this tick. */
  now: number;
  /** Authoritative tick counter (monotonic). */
  tick: number;
  /** Events queued since the last tick via sendEvent() (local + remote). */
  events: unknown[];
  /** The host's participant id (i.e. this node). */
  host: string;
}

/** Render metadata passed to onState()/onHostChange(). */
export interface StateMeta {
  /** Elected host's id, or null before the first election. */
  host: string | null;
  /** Short label for the host (its /nodes `short`, else first 8 chars of id). */
  hostShort: string;
  /** Is this client the elected host? */
  isHost: boolean;
  /** Is the websocket currently connected? */
  online: boolean;
  /** Current authoritative tick. */
  tick: number;
  /** Estimated round-trip latency to the host in ms (from {t:"st"} timestamps). */
  rttToHostMs: number;
}

export interface CreateGameOptions<S = any, I = any> {
  /** App namespace (required) — selects the /rt and /db namespace. */
  app: string;
  /** Room / shard id (default "g1"). */
  room?: string;
  /** This participant's stable id (default: a random id). */
  id?: string;
  /** Authoritative tick rate in Hz (default 20). */
  hz?: number;
  /** Initial authoritative state (host only; used when there is no snapshot). */
  init: () => S;
  /** Advance one tick. inputs is a map of pid -> that player's last input. Return the next state. */
  tick: (state: S, inputs: Record<string, I>, dt: number, ctx: TickCtx) => S;
  /** OPTIONAL: this client's current input each tick (else use setInput()). */
  input?: () => I;
  /** Client render hook, called with the authoritative state every received tick. */
  onState: (state: S, meta: StateMeta) => void;
  /** OPTIONAL: fired when the elected host changes. */
  onHostChange?: (meta: StateMeta) => void;
  /** Host: ticks between /db snapshots for redundancy / failover (default 40). */
  snapshotEvery?: number;
  /** OPTIONAL: override the http(s) origin (default location.origin). */
  base?: string;
  /** OPTIONAL: WebSocket constructor injection (Node <22 / custom). */
  WebSocket?: typeof WebSocket;
  /** OPTIONAL: fetch injection (Node <22 / custom origin). */
  fetch?: typeof fetch;
  /** Am I eligible to be elected host? (default true). */
  canHost?: boolean;
  /** OPTIONAL: hint that this participant is a dedicated/server node (raises score). */
  server?: boolean;
  /** OPTIONAL: override the host scorer; return a number (higher = more likely host). */
  hostScore?: () => number | Promise<number>;
}

/** Diagnostics snapshot from metrics(). */
export interface GameMetrics {
  id: string;
  score: number;
  server: boolean;
  host: string | null;
  isHost: boolean;
  online: boolean;
  tick: number;
  rttToHostMs: number;
  candidates: Array<{ id: string; score: number; server: boolean }>;
}

export interface Game<S = any, I = any> {
  /** Set this client's current input (alternative to opts.input). */
  setInput(obj: I): void;
  /** Queue a one-off event for the host's next tick (ctx.events). */
  sendEvent(obj: unknown): void;
  /** Latest authoritative state (host's live state, or last received state/snapshot). */
  state(): S | null;
  /** Am I currently the elected host? */
  isHost(): boolean;
  /** The elected host's id (or null). */
  hostId(): string | null;
  /** Short label for the elected host. */
  hostShort(): string;
  /** Is the websocket currently connected? */
  online(): boolean;
  /** Ids of live participants (candidates + recent input senders + self). */
  players(): string[];
  /** Diagnostics: scoring + election snapshot. */
  metrics(): GameMetrics;
  /** Leave the game: stop hosting, drop candidacy, close the socket. */
  leave(): void;
}

/**
 * Create a distributed authoritative game. Every client runs the same deterministic
 * host election over live candidacies; the elected host runs tick() at `hz`, ingests
 * inputs, broadcasts state, and snapshots to /db. On host failure another client wins
 * the election and restores from the latest snapshot.
 */
export function createGame<S = any, I = any>(opts: CreateGameOptions<S, I>): Game<S, I>;

declare const _default: { createGame: typeof createGame };
export default _default;
