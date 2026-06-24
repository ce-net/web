# ce (Python)

Python client for the CE App Platform hub. Same surface as the browser client
[`@ce/client`](../../ce-app/client): **tasks**, **database** (KV), and **realtime rooms**.

The default base is `https://ce-net.com`.

## Install

```bash
pip install ce          # once published
# or, from this directory:
pip install .
```

Realtime rooms use the [`websockets`](https://pypi.org/project/websockets/) library
(installed automatically). Tasks and the database need only the standard library.

## Quickstart

```python
import ce

client = ce.Client(app="demo")               # base defaults to https://ce-net.com

# --- database: persistent KV, namespaced per app ---
client.db.set("greeting", {"hi": True})
print(client.db.get("greeting"))             # {'hi': True}
print(client.db.list(prefix="greet"))        # [{'key': 'greeting', 'value': {...}}]
client.db.delete("greeting")

# --- tasks: dispatch compute to a live node ---
result = client.run_task(
    lang="python",
    code="def task(x):\n    return sum(i*i for i in range(x))",
    input=5,
)
print(result["value"], "in", result["ms"], "ms")

# --- realtime rooms ---
with client.room("lobby") as room:
    room.on(lambda msg: print("got", msg))
    room.send({"text": "hello"})
    room.run()                               # blocks, dispatching messages
```

## API

| @ce/client            | ce (Python)                                   |
| --------------------- | --------------------------------------------- |
| `createClient(opts)`  | `ce.Client(app=..., base=...)` / `ce.create_client(...)` |
| `db.get(key)`         | `client.db.get(key)` (`None` if missing)      |
| `db.set(key, val)`    | `client.db.set(key, val)`                     |
| `db.del(key)`         | `client.db.delete(key)` (alias `del_`)        |
| `db.list(prefix, n)`  | `client.db.list(prefix=..., limit=...)`       |
| `room(name).send`     | `client.room(name).send(obj)`                 |
| `room(name).on`       | `client.room(name).on(fn)` (returns unsubscribe) |
| `POST /tasks`         | `client.run_task(lang=..., code=..., input=...)` |

`run_task` accepts `lang` (`"wasm"`, `"js"`, `"python"`, ...). For source-code
languages pass `code` + optional `func` (default `"task"`) + `input`. For `wasm`
pass `module`, `func`, `args`, and optional `ret`. Pin a node with `target=<node_id>`.
Note: Python tasks run on browser nodes (Pyodide); a node must be connected.

## Example

See [`examples/quickstart.py`](examples/quickstart.py).
