/**
 * In-memory test doubles for the CE mesh and data layer. No node, no network.
 *
 * FakeMesh models CE pubsub: anyone publishing to a topic is delivered (with `from` =
 * the publisher's *client id*) to every consumer subscribed to that topic — including,
 * by default, the publisher itself (the node echoes the signed message back), which is
 * exactly the idempotent-fold path we must exercise.
 *
 * FakeData models the CE object store: `putObject` returns a content-addressed id and
 * `getObject` returns the stored bytes (404-style throw for an unknown CID).
 */

import type { MeshLike, MeshFrame, DataLike } from "../src/core/service.ts";

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
  readonly published: { topic: string; text: string }[] = [];
  /** If true, the node does NOT echo the publisher's own messages back. */
  noSelfEcho = false;

  constructor(readonly fromId: string) {}

  async subscribe(topic: string): Promise<void> {
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
      sub.deliver({ from: this.fromId, topic, text, receivedAt: Date.now() });
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

/** Content-addressed in-memory object store. CID = a stable hash of the bytes. */
export class FakeData implements DataLike {
  private readonly store = new Map<string, Uint8Array>();
  putCount = 0;

  async putObject(bytes: Uint8Array): Promise<string> {
    this.putCount++;
    const cid = hash(bytes);
    this.store.set(cid, bytes);
    return cid;
  }

  async getObject(cid: string): Promise<Uint8Array> {
    const v = this.store.get(cid);
    if (!v) {
      const err = new Error("not found") as Error & { name: string; status: number };
      err.name = "CeNotFoundError";
      err.status = 404;
      throw err;
    }
    return v;
  }
}

/** Deterministic non-crypto hash, sufficient for a content-addressed test CID. */
function hash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i]!, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + bytes[i]! + 1, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(4).slice(0, 64);
}

/** A seeded PRNG (mulberry32) so "random" op-order tests are reproducible on failure. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle with a seeded PRNG. */
export function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Run an async fn to completion, draining microtasks (for stream-driven tests). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
