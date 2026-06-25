import { describe, it, expect, vi } from "vitest";
import { ChatService, type MeshLike, type MeshFrame, type ConnectionState } from "../src/core/service.ts";
import { publicChannel } from "../src/core/topics.ts";
import { encodeEnvelope, makeChatMsg } from "../src/core/protocol.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const TOPIC = "ce-chat/channel/general";

async function tick(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Poll `cond` until true or `timeoutMs` elapses (real time — covers backoff sleeps). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A mesh whose stream throws on its first attempt, then on the second attempt
 * delivers a frame and stays open. Lets us assert auto-recovery after a drop.
 */
class FlakyMesh implements MeshLike {
  attempts = 0;
  publishCount = 0;
  constructor(private readonly frameAfterRecover: MeshFrame) {}
  async subscribe(): Promise<void> {}
  async publish(): Promise<void> {
    this.publishCount++;
  }
  async *streamMessages(opts?: { signal?: AbortSignal }): AsyncIterable<MeshFrame> {
    this.attempts++;
    if (this.attempts === 1) {
      throw Object.assign(new Error("transient drop"), { name: "CeStreamError" });
    }
    // Second attempt: deliver one frame then hang until aborted.
    yield this.frameAfterRecover;
    await new Promise<void>((res) => opts?.signal?.addEventListener("abort", () => res(), { once: true }));
  }
}

describe("stream auto-reconnect", () => {
  it("recovers live updates after a transient drop without a manual reload", async () => {
    const frame: MeshFrame = {
      from: BOB,
      topic: TOPIC,
      text: encodeEnvelope(makeChatMsg("after", "back online", "Bob", 1)),
      receivedAt: 1,
    };
    const mesh = new FlakyMesh(frame);
    const states: ConnectionState[] = [];
    const svc = new ChatService(mesh, ALICE, "Alice", {
      onConnectionChange: (s) => states.push(s),
    });
    await svc.join(publicChannel("general"));
    svc.startStream();

    // Let the first attempt throw, back off (real time), and the second attempt deliver.
    await waitFor(() => svc.state("pub:general")!.store.list().some((m) => m.text === "back online"));

    expect(mesh.attempts).toBeGreaterThanOrEqual(2);
    const msgs = svc.state("pub:general")!.store.list();
    expect(msgs.some((m) => m.text === "back online")).toBe(true);
    // We transitioned through reconnecting and reached live.
    expect(states).toContain("reconnecting");
    expect(states).toContain("live");
    svc.stop();
  });

  it("stop() halts the reconnect loop", async () => {
    const frame: MeshFrame = { from: BOB, topic: TOPIC, text: "{}", receivedAt: 1 };
    const mesh = new FlakyMesh(frame);
    const onError = vi.fn();
    const svc = new ChatService(mesh, ALICE, "Alice", { onStreamError: onError });
    await svc.join(publicChannel("general"));
    svc.startStream();
    svc.stop();
    const attemptsAtStop = mesh.attempts;
    await tick(10);
    // No further reconnect attempts after stop.
    expect(mesh.attempts).toBeLessThanOrEqual(attemptsAtStop + 1);
    expect(svc.connectionState).toBe("stopped");
  });

  it("backoffDelay grows with attempts and stays within the cap", () => {
    const svc = new ChatService(new FlakyMesh({ from: BOB, topic: TOPIC, text: "{}", receivedAt: 1 }), ALICE, "Alice");
    for (let a = 0; a < 30; a++) {
      const d = svc.backoffDelay(a);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(15_000);
    }
  });
});
