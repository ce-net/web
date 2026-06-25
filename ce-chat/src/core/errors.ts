/**
 * Map SDK / network errors to a friendly, actionable UI message plus a coarse
 * category the UI uses to pick an icon/affordance. We narrow on the SDK's error
 * classes by their `name` (works even if two SDK copies are bundled) and fall
 * back to duck-typing on `status`.
 */

export type ErrorKind = "auth" | "funds" | "notfound" | "offline" | "ratelimit" | "peer" | "server" | "unknown";

export interface FriendlyError {
  kind: ErrorKind;
  /** Short, human, no stack. */
  message: string;
  /** Optional next step the user can act on. */
  hint?: string;
}

function statusOf(e: unknown): number | undefined {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

function nameOf(e: unknown): string {
  if (e && typeof e === "object" && "name" in e) {
    const n = (e as { name: unknown }).name;
    if (typeof n === "string") return n;
  }
  return "";
}

export function toFriendly(e: unknown): FriendlyError {
  const name = nameOf(e);
  const status = statusOf(e);

  if (name === "CeAuthError" || status === 401 || status === 403) {
    return {
      kind: "auth",
      message: "This channel is private.",
      hint: "You need a capability grant from a member to join. Paste it in channel settings, or set CE_API_TOKEN for the node.",
    };
  }
  if (name === "CeInsufficientFundsError" || status === 402) {
    return { kind: "funds", message: "Not enough credits for this action.", hint: "Mine or receive credits, then retry." };
  }
  if (name === "CeNotFoundError" || status === 404) {
    return { kind: "notfound", message: "Not found on this node." };
  }
  if (name === "CeRateLimitError" || status === 429) {
    const ra = e && typeof e === "object" && "retryAfter" in e ? (e as { retryAfter?: number }).retryAfter : undefined;
    return { kind: "ratelimit", message: "Sending too fast.", hint: ra ? `Wait ${ra}s and retry.` : "Slow down and retry." };
  }
  if (name === "CePeerError" || status === 502) {
    return { kind: "peer", message: "A mesh peer rejected the request." };
  }
  if (name === "CeConnectionError" || name === "CeStreamError") {
    return {
      kind: "offline",
      message: "Can't reach your CE node.",
      hint: "Start it with `ce start` (HTTP API on 127.0.0.1:8844), then reconnect.",
    };
  }
  if (name === "CeTimeoutError" || status === 504) {
    return { kind: "offline", message: "The mesh request timed out.", hint: "Check connectivity and retry." };
  }
  if ((status && status >= 500) || name === "CeServerError" || name === "CeUnavailableError") {
    return { kind: "server", message: "The node hit an error handling that request." };
  }

  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "Something went wrong.";
  return { kind: "unknown", message: msg };
}

/** True if this error means "the local node is unreachable" (drives the offline banner). */
export function isOffline(e: unknown): boolean {
  return toFriendly(e).kind === "offline";
}
