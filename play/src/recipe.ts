/**
 * A playground recipe: a self-contained, live-runnable demo that mirrors a CE
 * cookbook recipe (PLAN/07-demos-dx.md, M5). Each recipe carries:
 *
 *  - `source`: the exact `@ce-net/sdk` snippet shown in the code pane. This is what a
 *    developer would paste into their own project. It is presentational — the literal
 *    string is what they read.
 *  - `run`: the executable form of that same snippet, wired to a {@link RunContext} so
 *    it talks to the *connected* node (in-browser bridge or the user's local `:8844`)
 *    and emits real responses into the output console.
 *
 * Keeping `source` and `run` adjacent (same object, same file) is the anti-drift
 * guard at this tier: a reviewer sees both at once. The cookbook CI in the demos
 * workstream enforces the stronger machine guarantee against the canonical .ts files.
 */

import type { CeClient } from "@ce-net/sdk";

/** What a recipe is allowed to do at runtime. */
export interface RunContext {
  /** The SDK client bound to the connected node. */
  ce: CeClient;
  /** Append an informational line to the output console. */
  log(msg: string): void;
  /** Append a success line (green). */
  ok(msg: string): void;
  /** Append a streamed-event line (cyan). */
  event(msg: string): void;
  /** Append a dimmed/secondary line. */
  dim(msg: string): void;
  /** Aborts when the user clicks Run again, switches recipe, or changes target. */
  signal: AbortSignal;
  /** Cooperative sleep that rejects if the run is aborted. */
  sleep(ms: number): Promise<void>;
}

/** Which connected node a recipe can run against. */
export type Need = "any-node" | "two-nodes" | "write";

export interface Recipe {
  /** Stable id, also the deep-link `?recipe=<id>`. */
  id: string;
  /** Display number, e.g. "01". */
  num: string;
  title: string;
  /** One-line "what it teaches". */
  teaches: string;
  /** Longer description shown in the header. */
  desc: string;
  /** Comma-split chips of the concepts/endpoints this exercises. */
  chips: string[];
  /** The literal SDK snippet rendered in the code pane. */
  source: string;
  /** Requirements that gate whether the current target can run it. */
  needs: Need[];
  /** Optional caveat banner (e.g. why a write recipe is gated on the playground). */
  note?: string;
  /** Execute the recipe live. Must respect `ctx.signal`. */
  run(ctx: RunContext): Promise<void>;
}

/** Utility: hex-encode a short prefix of a 64-hex id for compact logging. */
export function short(id: string, n = 10): string {
  return id.length > n ? `${id.slice(0, n)}…` : id;
}
