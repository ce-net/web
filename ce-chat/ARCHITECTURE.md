# ce-chat architecture

This document describes the internal model: the `MeshLike` port that decouples the app
from the SDK, the reducer/dedupe model in the store, presence, the auto-reconnect loop,
and the protocol versioning / compatibility policy. Read the [README](./README.md) first
for the user-facing feature list and limitations.

## Layers

```
                 ┌───────────────────────────────────────────┐
   main.ts  ───► │  ChatService (core/service.ts)            │
   (DOM/UI)      │   • owns the data path                    │
                 │   • routes the single mesh stream         │
                 │   • per-channel reducers + reconnect      │
                 └───────────────┬───────────────────────────┘
                                 │ depends only on
                                 ▼
                       ┌───────────────────┐
                       │  MeshLike (port)  │  subscribe / publish / streamMessages
                       └─────────┬─────────┘
                  real │                   │ test
                       ▼                   ▼
              sdk-adapter.ts          test/fake-mesh.ts
              (CeClient.mesh)         (in-memory pubsub bus)
```

Everything below `ChatService` is pure and SDK-agnostic. The **only** module that imports
`@ce-net/sdk` for the data path is `core/sdk-adapter.ts`. This is what lets the entire core
(protocol, topics, store, presence, service, persistence) be unit-tested against an
in-memory fake mesh with no node and no network.

### The `MeshLike` port

```ts
interface MeshLike {
  subscribe(topic: string): Promise<void>;
  publish(topic: string, payload: Uint8Array): Promise<void>;
  streamMessages(opts?: { signal?: AbortSignal }): AsyncIterable<MeshFrame>;
}
```

`MeshFrame` is the normalized inbound frame: `{ from, topic, text, receivedAt }`. The real
adapter decodes the SDK's `AppMessage.payload()` bytes to UTF-8 via `safeUtf8` (which returns
a non-throwing string on invalid bytes; `parseEnvelope` then drops anything that is not a
valid envelope). The fake adapter is a topic-keyed bus that, like the real node, echoes a
publisher's own message back to it — which is exactly the optimistic-send confirm path.

## Reducer / dedupe model (`core/store.ts`)

Mesh pubsub is **at-least-once and unordered**. The `MessageStore` is the per-channel reducer
that makes this tolerable:

- **Dedupe key is `(from, id)`, not bare `id`.** `msgKey(from, id)` lowercases `from`. This is
  a security property: a hostile peer cannot pre-publish a message with the `id` a victim will
  optimistically generate to suppress the victim's real send, and two authors reusing the same
  `id` stay distinct. The optimistic-confirm transition (`pending → sent`) only fires when the
  echoing frame's key matches our own `(selfId, id)`, which the mesh authenticates.
- **Insertion order is retained**; `list()` returns a stable sort by `(ts, receivedAt, key)`
  for display, never re-sorting accepted history out from under the reader.
- **Reactions** are aggregated per target message, keyed on `(reactor, emoji)`; add/remove are
  idempotent. A reaction that arrives before its target message (out-of-order) is buffered
  (bounded) and applied when the message lands.
- **Edits and deletes are author-scoped.** `applyEdit` / `applyDelete` look up `(from, targetId)`
  — since `from` is authenticated, only the original author's edit/delete can match. Edits
  carry a monotonic `editedAt` so a stale edit cannot clobber a newer one. A delete tombstones
  the message: text is cleared, reactions are dropped, and it renders as "message deleted".
- **Threads** are derived: a `StoredMessage.replyTo` makes it a reply; `roots()` and
  `replies(rootId)` partition the log without a separate index.
- **Memory is bounded** by a ring cap (default 500/channel). Eviction drops the oldest
  inserted key. Durable archive is explicitly out of scope (see history backfill).

## History backfill

There is no central archive. On `join`, the service publishes a `history-request` to the
channel. Any peer that holds messages answers with a `history-response` carrying up to
`MAX_HISTORY_BATCH` recent items. The requester merges them via the same `(from, id)` dedupe,
so a backfill that overlaps live messages never double-counts. Backfilled items sort by their
author `ts` (their `receivedAt` is set to the author `ts`) so old messages do not jump to the
bottom of the stream. A node will not answer its own request.

## Presence (`core/presence.ts`)

No presence server. Each member periodically publishes a `presence` heartbeat (every
`HEARTBEAT_INTERVAL_MS`, well under `PRESENCE_TTL_MS`). Both heartbeats and chat/reaction/edit
frames count as liveness, so an active peer never flickers offline. Members age out on the TTL.
`main.ts` fans heartbeats out to **all** joined channels, so you stay online to peers in
background channels, not just the one you are viewing.

## Auto-reconnect loop (`ChatService.runLoop`)

`startStream()` enters a loop that consumes `streamMessages` until it ends or throws, then —
unless `stop()` was called — backs off with **exponential backoff + full jitter** (`base 500ms`,
capped at `15s`) and retries. The connection state machine emits
`connecting → live → reconnecting → live → … → stopped` via `onConnectionChange`. A transient
SSE drop therefore recovers without rebuilding the service or reloading the page; the backoff
counter resets on the first frame after a successful reconnect. The loop is abortable: `stop()`
aborts the `AbortController`, which both ends the async iterator and cancels any pending backoff
sleep.

## Inbound rate limiting (DoS bound)

`route()` admits frames through a per-`(channel, sender)` token window
(`INBOUND_MAX_PER_WINDOW` per `INBOUND_WINDOW_MS`). A flooding or buggy peer is dropped past the
cap; our own frames are never throttled. Combined with `parseEnvelope`'s size bounds (text,
name, id, emoji, batch, and a hard pre-parse payload length cap) and the store's ring cap, a
single peer cannot exhaust memory or wedge the UI.

## Persistence (`core/persist.ts`)

A thin, defensive wrapper over a `StorageLike` (browser `localStorage`, or an in-memory map in
tests / SSR). It persists the joined channel/DM list, per-channel composer drafts, the display
name, and an optional node-URL override. Every read validates and bounds its input — corrupt or
hostile storage can never crash boot or smuggle an oversize value into the app. Message history
is deliberately not persisted here; it is mesh-served.

## Protocol versioning & compatibility

- `PROTOCOL_VERSION = 1`. Every envelope carries `v`.
- **Forward-compatible by construction:** `parseEnvelope` ignores unknown `t` values and
  unknown fields. A newer client can introduce a new envelope kind (or a new optional field on
  an existing kind) and older clients simply drop what they do not understand — no crash, no
  poison.
- **Breaking changes bump `v`.** If the shape of an existing envelope must change incompatibly,
  bump `PROTOCOL_VERSION` and branch on `env.v` in the relevant `route()` case (e.g. accept both
  the v1 and v2 shapes during a migration window).
- **Trust boundary:** the mesh authenticates `from`. Everything else in an envelope is untrusted
  application content and is validated/bounded at parse time. Authorization for private channels
  is enforced by the node on `subscribe` (a signed, attenuating ce-cap chain) — ce-chat never
  invents its own allowlist.

## Testing strategy

- **Pure-core unit tests** run in the Node environment against the in-memory `FakeMesh`.
- **DOM tests** (`test/dom.test.ts`) run under `// @vitest-environment jsdom` and assert the
  injection-safety of `linkify` (no `innerHTML`), URL/mention/code tokenization, and `el`.
- **Failure-path tests** cover dedupe-spoofing, oversize inputs, publish failure + retry,
  spoofed edits/deletes, and rate-limit flooding.
- **Reconnect tests** drive a flaky mesh that throws then recovers and assert live updates
  return without manual action.
- **Property tests** (seeded PRNG, deterministic) assert store ordering/eviction invariants and
  `normalizeChannelName` idempotence over random inputs.
