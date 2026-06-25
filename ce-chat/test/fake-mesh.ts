/**
 * In-memory mesh for unit tests. Models CE pubsub: anyone publishing to a topic is
 * delivered (with `from` = the publisher's node id) to every consumer subscribed to
 * that topic — including, by default, the publisher itself (the node echoes the
 * signed message back), which is exactly the dedupe/confirm path we must test.
 */

import type { MeshLike, MeshFrame } from "../src/core/service.ts";

interface Bus {
  subscribers: Set<FakeMesh>;
}

const buses = new Map<string, Bus>();

export function resetBuses(): void {
  buses.clear();
}

export class FakeMesh implements MeshLike {
  private readonly subs = new Set<string>();
  private readonly queue: MeshFrame[] = [];
  private resolve: ((v: void) => void) | null = null;
  private closed = false;
  /** Capture every published payload for assertions. */
  readonly published: { topic: string; text: string }[] = [];
  /** Topics this node will reject on subscribe (simulates a gated private topic). */
  readonly denied = new Set<string>();
  /** If true, the node does NOT echo the publisher's own messages back. */
  noSelfEcho = false;

  constructor(readonly nodeId: string) {}

  async subscribe(topic: string): Promise<void> {
    if (this.denied.has(topic)) {
      const err = new Error("forbidden") as Error & { name: string; status: number };
      err.name = "CeAuthError";
      err.status = 403;
      throw err;
    }
    this.subs.add(topic);
    const bus = buses.get(topic) ?? { subscribers: new Set<FakeMesh>() };
    bus.subscribers.add(this);
    buses.set(topic, bus);
  }

  async publish(topic: string, payload: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(payload);
    this.published.push({ topic, text });
    const bus = buses.get(topic);
    if (!bus) return;
    for (const sub of bus.subscribers) {
      if (sub === this && this.noSelfEcho) continue;
      sub.deliver({ from: this.nodeId, topic, text, receivedAt: Date.now() });
    }
  }

  /** Inject a frame as if it arrived from a remote peer (test helper). */
  inject(frame: MeshFrame): void {
    this.deliver(frame);
  }

  private deliver(frame: MeshFrame): void {
    this.queue.push(frame);
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r();
    }
  }

  async *streamMessages(opts?: { signal?: AbortSignal }): AsyncIterable<MeshFrame> {
    while (!this.closed && !opts?.signal?.aborted) {
      if (this.queue.length === 0) {
        await new Promise<void>((res) => {
          this.resolve = res;
          opts?.signal?.addEventListener("abort", () => res(), { once: true });
        });
      }
      while (this.queue.length > 0) {
        if (opts?.signal?.aborted) return;
        yield this.queue.shift()!;
      }
    }
  }

  close(): void {
    this.closed = true;
    this.resolve?.();
  }
}
