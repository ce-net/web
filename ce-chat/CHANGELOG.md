# Changelog

All notable changes to ce-chat are documented here.

## [Unreleased] — hardening + feature pass

### Added

- **Message history backfill** via a `history-request` / `history-response` envelope pair:
  a fresh join asks peers for the last N messages and renders scrollback. Peers that hold
  history serve it; a node never answers its own request.
- **Threads**: an optional `replyTo` field on chat messages, a `roots()` / `replies()` split
  in the store, and a thread side-pane with its own composer.
- **Reactions**: a `react` envelope (`{ targetId, emoji, op }`), per-message aggregation keyed
  on `(reactor, emoji)`, a reaction bar, and a quick-pick emoji picker. Out-of-order reactions
  are buffered until their target arrives.
- **@mentions**: `@name` / `@<node-id>` parsing and highlighting, with self-mentions emphasized.
- **Typing indicators**: a throttled, TTL'd `typing` envelope and a transient composer overlay;
  never written to the message log.
- **Edit & delete**: author-scoped `edit` (with an "(edited)" marker and monotonic `editedAt`)
  and `delete` (tombstone) envelopes.
- **Unread tracking**: per-channel unread counts, sidebar badges, and a "new messages" divider;
  channels mark read on select.
- **Live-stream auto-reconnect** with exponential backoff + full jitter and a connection state
  machine (`connecting`/`live`/`reconnecting`/`stopped`); recovers a transient SSE drop with no
  reload.
- **First-class message status** (`pending` / `sent` / `failed`) owned by the store, with a
  one-click **retry** that re-publishes under the same id.
- **Persistence**: joined channels/DMs, per-channel composer drafts, display name, and an
  optional node-URL override survive reloads (validated localStorage wrapper).
- **Configurable node URL** from the UI and via `VITE_CE_NODE_URL`.
- **Background-channel presence**: heartbeats fan out to all joined channels.
- **Inline `` `code` ``** rendering in message bodies.
- **Tests**: persistence, jsdom DOM/linkify (injection-safety), sdk-adapter frame normalization,
  reconnect recovery, reactions/edits/deletes/typing/threads/history/unread/rate-limit, and
  seeded property tests for store ordering/eviction and `normalizeChannelName` idempotence.
  Suite grew from 67 to 160 tests.
- **Docs**: `ARCHITECTURE.md`, a runnable `examples/protocol-demo.ts`, an expanded README with a
  feature list, wire-protocol table, versioning policy, and a Limitations section.

### Changed / hardened

- **Dedupe is now keyed on `(from, id)`** instead of bare `id`, closing a spoofing hazard where
  a hostile peer could suppress a victim's message (or confirm-spoof their own pending send) with
  a colliding id.
- **`parseEnvelope` enforces size bounds** on every external string: text, display name, ids,
  emoji, history-batch length, and a hard pre-parse payload-length cap (DoS defense).
- **Per-`(channel, sender)` inbound rate limiting** drops a flooding peer past a window cap; our
  own frames are never throttled.
- **Display-name changes apply in place** (`setDisplayName`) — no more `location.reload()` that
  discarded all in-memory history and presence.
- **Removed `app!` / risky non-null assertions** in `main.ts` in favor of guarded accessors that
  no-op when the app or a node is missing.
- **Send failure now flips the stored message to `failed`** inside the service (a real status),
  instead of a UI-only `Set` that was lost on any rebuild.

## [0.1.0] — initial

- Public/private/DM channels mapped to mesh pubsub topics, optimistic send with echo-confirm,
  heartbeat presence with TTL, friendly error mapping, and a polished single-page UI.
