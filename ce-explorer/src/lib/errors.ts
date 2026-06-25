import {
  CeApiError,
  CeConnectionError,
  CeStreamError,
  CeAuthError,
  CeNotFoundError,
} from "@ce-net/sdk";

/**
 * Turn any thrown value into a short, user-facing message in the interface's
 * voice — never a stack trace, never an apology. Tells the reader what to do.
 */
export function describeError(err: unknown): string {
  if (err instanceof CeConnectionError) {
    return "Can't reach the node. Is `ce start` running on 127.0.0.1:8844?";
  }
  if (err instanceof CeStreamError) {
    return "Live stream dropped. Reconnecting.";
  }
  if (err instanceof CeAuthError) {
    return "The node rejected this read. It may require an API token.";
  }
  if (err instanceof CeNotFoundError) {
    return "Not found on this node.";
  }
  if (err instanceof CeApiError) {
    return `Node returned ${err.status}: ${err.body || "no detail"}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Something went wrong reading from the node.";
}

/** True for errors where retrying the same read later is sensible. */
export function isTransient(err: unknown): boolean {
  return err instanceof CeConnectionError || err instanceof CeStreamError;
}
