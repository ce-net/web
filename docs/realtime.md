# Realtime rooms

Rooms are WebSocket channels under an app. Connect to `/rt/:app/:room`; any text frame you send is
broadcast to every other connection in that room. On connect, the last 50 messages are replayed to
you, so a client that joins late still sees recent history.

## Connect

```js
import { createClient } from "@ce/client";
const ce = createClient();

const room = ce.room("lobby");
room.onOpen(() => room.send(JSON.stringify({ join: "Ada" })));
room.on((msg) => console.log("got", msg));   // fires for the 50-message replay too
// room.send(text) -> broadcast to others; room.close() to leave
```

```js
// raw WebSocket — works on ce-net.com, <id>.ce-net.com, and your custom domain
const ws = new WebSocket("wss://ce-net.com/rt/my-app/lobby");

ws.onopen    = () => ws.send("hello room");
ws.onmessage = (e) => console.log(e.data);   // last 50 replayed first, then live
```

## Semantics

- Any text frame is broadcast to others in the room (not echoed back to the sender).
- The last 50 messages are replayed to a client on connect.
- Messages are opaque text — send plain strings or JSON you stringify yourself.

Pair rooms with the database when you want presence-style ephemerality (rooms) plus durable history
(database).

## Endpoint

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/rt/:app/:room` | WebSocket; broadcast text frames; replays last 50. |

Reachable as `wss://ce-net.com/rt/:app/:room` and on the subdomain and custom-domain origins.
