import { describe, it, expect } from "vitest";
import { utf8ToBytes } from "@ce-net/sdk";
import type { CeClient } from "@ce-net/sdk";
import { resolveNodeUrl, safeUtf8, meshAdapter, fetchIdentity, DEFAULT_NODE_URL } from "../src/core/sdk-adapter.ts";
import { parseEnvelope } from "../src/core/protocol.ts";

describe("resolveNodeUrl", () => {
  it("prefers a valid override", () => {
    expect(resolveNodeUrl("http://example.com:9000")).toBe("http://example.com:9000");
    expect(resolveNodeUrl("https://relay.ce-net.com")).toBe("https://relay.ce-net.com");
  });

  it("falls back to the default for an invalid or missing override", () => {
    expect(resolveNodeUrl("not a url")).toBe(DEFAULT_NODE_URL);
    expect(resolveNodeUrl(null)).toBe(DEFAULT_NODE_URL);
    expect(resolveNodeUrl(undefined)).toBe(DEFAULT_NODE_URL);
    expect(resolveNodeUrl("ftp://nope")).toBe(DEFAULT_NODE_URL);
  });
});

describe("safeUtf8", () => {
  it("decodes valid UTF-8 bytes", () => {
    expect(safeUtf8(utf8ToBytes("héllo 😀"))).toBe("héllo 😀");
  });

  it("never throws on invalid UTF-8 bytes (returns a string for parseEnvelope to drop)", () => {
    // Whether the decoder is strict (throws -> "") or lenient (replacement chars),
    // safeUtf8 must return a string and never throw; the resulting text is not a
    // valid ce-chat envelope, so parseEnvelope drops it downstream.
    let out = "";
    expect(() => {
      out = safeUtf8(new Uint8Array([0xff, 0xfe, 0xff]));
    }).not.toThrow();
    expect(typeof out).toBe("string");
  });
});

/** Build a CeClient-shaped stub exposing just the surface meshAdapter/fetchIdentity touch. */
function stubClient(opts: {
  status?: { nodeId: string };
  frames?: { from: string; topic: string; payloadHex: string; receivedAt: number | null }[];
}): CeClient {
  const frames = opts.frames ?? [];
  const stub = {
    getStatus: async () => opts.status ?? { nodeId: "z".repeat(64) },
    mesh: {
      subscribe: async (_t: string) => {},
      publish: async (_t: string, _p: Uint8Array) => {},
      async *streamMessages() {
        for (const f of frames) {
          yield {
            from: f.from,
            topic: f.topic,
            payloadHex: f.payloadHex,
            receivedAt: f.receivedAt,
            replyToken: null,
            payload() {
              return hexToBytes(f.payloadHex);
            },
          };
        }
      },
    },
  };
  return stub as unknown as CeClient;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

describe("meshAdapter", () => {
  it("normalizes AppMessage frames into MeshFrame with decoded text", async () => {
    const payload = bytesToHex(utf8ToBytes('{"t":"msg","id":"x","text":"hi"}'));
    const client = stubClient({
      frames: [{ from: "a".repeat(64), topic: "ce-chat/channel/general", payloadHex: payload, receivedAt: 1234 }],
    });
    const mesh = meshAdapter(client);
    const got: { from: string; topic: string; text: string; receivedAt: number | null }[] = [];
    for await (const f of mesh.streamMessages()) got.push(f);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      from: "a".repeat(64),
      topic: "ce-chat/channel/general",
      text: '{"t":"msg","id":"x","text":"hi"}',
      receivedAt: 1234,
    });
  });

  it("yields non-envelope text for an undecodable payload (parseEnvelope drops it later)", async () => {
    const client = stubClient({ frames: [{ from: "a".repeat(64), topic: "t", payloadHex: "fffe", receivedAt: null }] });
    const mesh = meshAdapter(client);
    const got = [];
    for await (const f of mesh.streamMessages()) got.push(f);
    expect(typeof got[0]!.text).toBe("string");
    // The decoded bytes are not a valid ce-chat envelope.
    expect(parseEnvelope(got[0]!.text)).toBeNull();
  });
});

describe("fetchIdentity", () => {
  it("returns the node id from getStatus", async () => {
    const client = stubClient({ status: { nodeId: "c".repeat(64) } });
    expect(await fetchIdentity(client)).toEqual({ nodeId: "c".repeat(64) });
  });
});
