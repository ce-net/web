# ce-realtime

Realtime pub/sub rooms over WebSocket on the CE hub. Any text frame sent to a room is
broadcast to every other client in that room. The last 50 messages are replayed to a client
when it connects, so newcomers see recent history immediately.

## When to use

- Chat, presence, live cursors, multiplayer state, notifications, collaborative editing, or
  any "send a message, everyone else gets it" feature.
- You want this with no server and no auth setup.

## Prerequisites

- A WebSocket-capable client (browser, Node, Python `websockets`, Go `gorilla/websocket`).
- An app namespace string `<app>` and a room name `<room>`.
- Network access to `https://ce-net.com`.

## Endpoint

```
GET /rt/<app>/<room>   -> WebSocket
```

- WebSocket URL: `wss://ce-net.com/rt/<app>/<room>`
- Also valid on per-developer subdomains and custom domains, e.g.
  `wss://<id>.ce-net.com/rt/<app>/<room>`.

Semantics: every text frame you send is broadcast to all OTHER clients in the same room
(you do not receive your own echo). On connect, the last 50 messages are replayed to you.

## Steps (raw WebSocket)

```bash
# Quick test with websocat (any WS client works):
websocat "wss://ce-net.com/rt/myapp/lobby"
# Type a line and press enter; other clients in 'lobby' receive it.
# Anything you type is a text frame broadcast to the room.
```

## Browser client (@ce/client)

```js
import { createClient } from "@ce/client";
const ce = createClient();              // appId auto-resolves from the page URL
const room = ce.room("lobby");

room.onOpen(() => room.send({ type: "join", user: "alice" }));
const off = room.on((msg) => {
  // JSON is parsed automatically when possible
  console.log("received", msg);
});

room.send({ text: "hello everyone" });  // objects are JSON-stringified
room.send("raw string frame");          // strings sent verbatim

// later:
off();          // unsubscribe this listener
room.close();   // close the socket and stop reconnecting
```

## Python SDK (web/sdks/python)

```python
from ce import Client
ce = Client("myapp")
room = ce.room("lobby")
room.on(lambda msg: print("received", msg))
room.on_open(lambda: room.send({"type": "join", "user": "alice"}))
room.send({"text": "hello"})
room.run()        # blocks, dispatching incoming messages
```

## Go SDK (web/sdks/go)

```go
client := ce.New("myapp")
room := client.Room("lobby")
room.On(func(msg any) { fmt.Println("received", msg) })
room.OnOpen(func() { room.Send(map[string]any{"type": "join", "user": "alice"}) })
room.Send(map[string]any{"text": "hello"})
room.Run()        // blocks, dispatching messages
```

## Gotchas

- The transport carries TEXT frames. Objects are JSON-stringified by the SDKs; on receive,
  JSON is parsed when possible, otherwise you get the raw string. Define your own message
  schema (e.g. a `type` field) since the room does not interpret payloads.
- You do not receive your own messages, only those from others. To show your own message
  locally, render it optimistically when you send.
- Only the last 50 messages are replayed on connect. For durable / full history, also write
  messages to the CE database (see the ce-database skill) and load them on startup.
- Rooms are ephemeral routing, not storage. There is no per-room persistence beyond the
  50-message replay buffer.
- The room is keyed by `<app>/<room>`; clients must agree on both to be in the same room.
- No emojis in user-facing message content.
