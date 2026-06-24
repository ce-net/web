# Compute tasks, languages, and SDKs

`POST /tasks` hands a unit of work to the mesh. The hub picks a connected node, runs it, and returns
the result with timing and which node ran it. Two shapes are accepted: a named WebAssembly function,
or inline code in a sandboxed language.

## WASM task

```bash
curl -X POST https://ce-net.com/tasks \
  -H "content-type: application/json" \
  -d '{"func":"count_primes","args":[200000],"ret":"i32","module":"demo"}'
# -> {"node":"...","lang":"wasm","func":"count_primes","ok":true,"value":17984,"ms":42}
```

```js
const r = await fetch("https://ce-net.com/tasks", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    func: "count_primes", args: [200000], ret: "i32", module: "demo",
  }),
});
console.log(await r.json());
```

## Code task (js or python)

```bash
curl -X POST https://ce-net.com/tasks \
  -H "content-type: application/json" \
  -d '{"lang":"js","code":"i=>i.a+i.b","input":{"a":2,"b":3},"func":"task"}'
# -> {"node":"...","lang":"js","func":"task","ok":true,"value":5,"ms":3}
```

```js
const r = await fetch("https://ce-net.com/tasks", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    lang: "js",
    code: "i => i.a + i.b",   // runs in a sandboxed Worker on a node
    input: { a: 2, b: 3 },
    func: "task",
  }),
});
console.log(await r.json());   // { ok:true, value:5, ms:3, node:"..." }
```

```bash
# python runs under Pyodide — browser nodes only
curl -X POST https://ce-net.com/tasks \
  -H "content-type: application/json" \
  -d '{"lang":"python","code":"def task(i):\n    return i[\"a\"] + i[\"b\"]","input":{"a":2,"b":3},"func":"task"}'
```

## Targeting a specific node

Add an optional `"target":"<full node id>"` to route a task to one node (find ids via `GET /nodes`).
Without a target the hub chooses.

## Result and status codes

The success body is always `{node, lang, func, ok, value, ms, error}` — check `ok` and read `error`
when it is false.

- `503` if no nodes are connected.
- `504` if the chosen node did not return a result in time.

## Task languages

| lang | Runtime | Where it runs |
| --- | --- | --- |
| `wasm` | WebAssembly module + named function | Browser and headless nodes. |
| `js` | Sandboxed Worker | Browser and headless nodes. |
| `python` | Pyodide | Browser nodes only. |

The headless worker (`web/site/worker.js`) runs `wasm` and `js` tasks; Python requires a browser
node because it runs under Pyodide.

## SDKs

| SDK | Package | Surface |
| --- | --- | --- |
| Browser | `@ce/client` (ESM, `web/ce-app/client`) | `createClient()`: `appId`, `base`, `db`, `room()`. |
| Python | `ce` (`web/sdks/python`) | tasks + db + room. |
| Go | `ce` (`web/sdks/go`) | tasks + db + room. |
| Rust | `ce-rs` | The Rust node SDK. |

```ts
// TypeScript / browser
import { createClient } from "@ce/client";
const ce = createClient();
await ce.db.set("k", { hi: 1 });
const room = ce.room("lobby");
room.on((m) => console.log(m));
room.send("hello");
```

```python
# Python — web/sdks/python (tasks + db + room)
from ce import Client
ce = Client("my-app")
ce.db.set("k", {"hi": 1})
res = ce.run_task(lang="js", code="i=>i.a+i.b", input={"a": 2, "b": 3})
```

```go
// Go — web/sdks/go (tasks + db + room)
import "ce"
client := ce.New("my-app")
client.DB.Set("k", map[string]any{"hi": 1})
res, _ := client.RunTask(ce.Task{Lang: "js", Code: "i=>i.a+i.b", Input: in})
```

## @ce/client

`createClient()` resolves your `appId` automatically from the `/apps/<id>/` path or the
`<id>.ce-net.com` host.

```js
import { createClient } from "@ce/client";

const ce = createClient();
ce.appId;   // resolved app id
ce.base;    // API base origin

// database
await ce.db.set(key, value);
await ce.db.get(key);
await ce.db.del(key);
await ce.db.list(prefix, limit);

// realtime
const room = ce.room(name);
room.send(text);
room.on((msg) => {});
room.onOpen(() => {});
room.close();
```

## Run a node

- Browser: open `https://ce-net.com/node` — a real WASM/JS compute node and mesh peer (iOS/Android
  too).
- Headless: `curl -fsSL https://ce-net.com/worker.js | node - --hub wss://ce-net.com/hub`

Nodes connect over the `GET /node` WebSocket: they send `hello`, `hb`, `pong`, and `result` frames
upstream; the hub sends `job`, `ping`, `store`, and `fetch` frames downstream.
