# ce-chat

**What it is.** ce-chat is a decentralized, mesh-native team chat (a "Slack on the Sea")
built on the CE mesh. Every channel is a CE pubsub topic and every message is a signed
mesh message. You join a channel (`/mesh/subscribe`), type a line (`/mesh/publish`), and a
single live SSE stream (`/mesh/messages/stream`) fans every subscribed-topic frame back
into per-channel message logs, a member roster, reaction/thread/edit state, and unread
counts. Presence is just periodic heartbeats on the same topic, with members aging out on
a TTL. Your CE node id _is_ your identity — there is no account server.

It talks to a real local node through the published `@ce-net/sdk` (`CeClient.mesh`), so
the data path is genuine. The only mock is an in-memory mesh used by the unit tests.

## Features

- **Public channels** — open mesh topics anyone can join.
- **Private channels** — capability-gated; the node enforces access on subscribe. A `403`
  becomes a friendly "you need a grant" prompt rather than a crash.
- **Direct messages** — 1:1 over an order-independent topic derived from both node ids, so
  either side can start the conversation.
- **Message history backfill** — a fresh join asks peers for the last N messages over a
  `history-request` / `history-response` envelope pair and renders scrollback instead of an
  empty pane. (No central archive: peers that hold history serve it.)
- **Threads** — reply to a message; replies group under the root and render in a side-pane,
  while the main channel view stays uncluttered.
- **Reactions** — emoji reactions aggregated per message, with a quick-pick picker; add and
  remove are idempotent and namespaced by reactor.
- **@mentions** — `@name` and `@<node-id>` are parsed and highlighted; mentions of yourself
  are emphasized.
- **Typing indicators** — a throttled, TTL'd `typing` hint shows who is composing; it is
  never written to the message log.
- **Edit & delete** — edit your own messages (peers see an "(edited)" marker) or tombstone
  them; both are author-scoped, so a peer cannot edit or delete someone else's message.
- **Unread tracking** — per-channel unread counts and a "new messages" divider; the sidebar
  shows unread badges, and switching to a channel marks it read.
- **Optimistic send with retry** — your message appears instantly as `pending`, is confirmed
  when its own echo returns, or flips to `failed` with a one-click **retry** on publish error.
- **Live-stream auto-reconnect** — a transient SSE drop recovers automatically with
  exponential backoff + jitter; no manual reload, no lost subscriptions.
- **Persistence** — your joined channels, DMs, per-channel composer drafts, and display name
  survive a reload (localStorage). Message history itself is mesh-served, not stored locally.
- **Configurable node URL** — point ce-chat at a remote or alternate-port node from the UI
  (or via the `VITE_CE_NODE_URL` build env) without editing source.
- **Background-channel presence** — heartbeats fan out to _all_ joined channels, so you stay
  online to peers even in channels you are not currently viewing.
- **Safe rendering** — bare URLs and inline `` `code` `` render without any `innerHTML`; every
  value is a text node, so there is no injection surface.

## Run it against a node

```bash
# 1. Start your CE node (HTTP+SSE API on 127.0.0.1:8844)
ce start

# 2. In this folder
npm install
npm run dev          # opens http://localhost:5174
```

The Vite dev server proxies `/ce-api/*` to `http://127.0.0.1:8844`, so the browser can POST
and stream SSE against your local node without CORS friction. Open the app in two browsers /
two machines (each running their own `ce start`) on the same mesh, join the same channel, and
you will see each other's messages, reactions, threads, and presence in real time.

If the node isn't running you get a clear "Can't reach your CE node — `ce start`" screen with
a retry and a "Change node URL" action, not a blank page.

> **Production build.** `npm run build` emits a static `dist/`. Served from a real origin it
> talks to `http://127.0.0.1:8844` directly; you may need the node's CORS allowance (or keep
> using the dev proxy / a reverse proxy that exposes the node under `/ce-api`). Set
> `VITE_CE_NODE_URL` at build time to bake in a different default.

## How channels map to the mesh

| ce-chat thing            | mesh topic                          |
| ------------------------ | ----------------------------------- |
| public channel `general` | `ce-chat/channel/general`           |
| private channel `eng`    | `ce-chat/private/eng` (gated)       |
| DM between A and B        | `ce-chat/dm/<min(A,B)>+<max(A,B)>`  |

Everything is namespaced under `ce-chat/` so chat never collides with other mesh apps, and
the reducer quietly drops any payload on a topic that isn't a valid ce-chat envelope.

## Wire protocol

All payloads are UTF-8 JSON envelopes with a `t` (type) and `v` (version) field. The mesh
already authenticates the sender (`from` = origin node id), so envelopes carry no signature
of their own. `parseEnvelope` is the single choke point that validates types and enforces
every size bound; it never throws and drops anything malformed.

| `t`                | meaning                                             |
| ------------------ | --------------------------------------------------- |
| `msg`              | a chat line (optional `replyTo` for a thread reply) |
| `presence`         | "I am here" heartbeat                                |
| `typing`           | transient "is typing" hint (never stored)           |
| `react`            | add/remove an emoji reaction to a target message    |
| `edit`             | replace the text of one of the author's own messages|
| `delete`           | tombstone one of the author's own messages          |
| `history-request`  | ask peers for the last N messages                   |
| `history-response` | answer a request with a batch of recent messages    |

**Versioning / compatibility.** `PROTOCOL_VERSION` is `1`. Unknown `t` values and unknown
fields are ignored by `parseEnvelope`, so a newer client can add envelope kinds without
breaking older clients (they drop what they do not understand). A breaking change to an
existing envelope's shape bumps `PROTOCOL_VERSION`; receivers may then branch on `v`. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full model.

**Trust note.** `from` is authenticated by the mesh, but `name`, `text`, ids, and emoji are
attacker-controlled application content. The store dedupes on the tuple `(from, id)` (not bare
`id`) so a hostile peer cannot suppress a victim's message with a colliding id, and `edit` /
`delete` are author-scoped so they only ever affect the sender's own messages.

## Limitations (intentionally not supported)

- **No durable server-side archive.** History is best-effort and peer-served: if no peer that
  holds the scrollback is online when you join, you start from the live stream. Messages are
  ring-capped (500/channel by default) in memory and are not written to disk.
- **`leave()` is local-only.** The SDK has no `unsubscribe`, so leaving a channel stops
  tracking it locally but keeps the node subscription for the session. A very long session
  accumulates node-side subscriptions.
- **No file/image attachments.** Text only. CE blob integration is a future addition.
- **No rich markdown** beyond bare-URL links, `@mentions`, and inline `` `code` `` — no bold/
  italic/headings/fenced blocks, no emoji shortcodes.
- **No cross-channel search.**
- **No read receipts across peers.** Unread state is local; we do not broadcast read markers.
- **Edit/delete are advisory.** They are honored by cooperating clients; the protocol cannot
  force a malicious client to forget a message it already received (this is true of any
  gossip system). They are author-scoped against _spoofing_, not against a peer that simply
  ignores the tombstone.
- **Reactions attribute to the first message with a matching id we hold.** A bare `react`
  envelope names only the target id; if you somehow hold two different-author messages with
  the same id, the reaction lands on the one currently in view order.

## Develop & test

```bash
npm run dev        # dev server with node proxy
npm run build      # tsc -b + vite build (type-checked production build)
npm test           # vitest: protocol, topics, store, presence, format, errors,
                   #         service, persistence, dom (jsdom), sdk-adapter,
                   #         reconnect, property tests
```

The tests exercise the core logic — the wire protocol and its size bounds, channel/DM topic
mapping, the dedupe + optimistic-send + reactions + edits + threads + history + unread op
model (via an in-memory mesh fake), persistence, safe DOM rendering (jsdom), SDK frame
normalization, auto-reconnect recovery, and store ordering/eviction invariants (property
tests) — with the SDK and network fully mocked. No node is required to run the tests.

## Layout

```
src/
  core/
    protocol.ts     wire envelopes + safe, bounded parsing
    topics.ts       channel <-> mesh-topic mapping, name/id validation
    store.ts        per-channel log: (from,id) dedupe, reactions, edits, threads, ring cap
    presence.ts     heartbeat-driven membership with a TTL
    format.ts       node-id / time / byte formatting (pure)
    errors.ts       SDK error -> friendly UI message + category
    service.ts      ChatService: the SDK-agnostic data path (port: MeshLike) + reconnect
    persist.ts      localStorage of channels / drafts / name / node URL (validated)
    sdk-adapter.ts  the ONLY @ce-net/sdk import for the data path
  ui/dom.ts         tiny typed DOM helpers + tokenizer (mentions / urls / code)
  main.ts           the app: sidebar, message pane, composer, roster, threads, modals
  styles/app.css    the "Sea" visual system
test/               vitest specs + in-memory mesh fake
examples/           runnable examples of the protocol + store + service in Node
ARCHITECTURE.md     the MeshLike port, reducer/dedupe model, protocol versioning policy
```

## License

MIT © Leif Rydenfalk
