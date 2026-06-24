# ce-run-task

Push a compute task to a live CE node in the mesh and read the result back. The hub picks a
connected node, runs your function, and returns the value. Supports precompiled WASM modules
and sandboxed `js` / `python` code.

## When to use

- Run a unit of compute on someone else's machine: a WASM function, a sandboxed JS snippet,
  or a Python function (Pyodide, on browser nodes).
- Offload work, fan out compute to volunteer nodes, or demo distributed execution.

## Prerequisites

- At least one node connected to the hub. Start one:
  - Browser node: open `https://ce-net.com/node` (a real WASM/JS compute node and mesh peer;
    works on iOS and Android too).
  - Headless: `curl -fsSL https://ce-net.com/worker.js | node - --hub wss://ce-net.com/hub`
- Network access to `https://ce-net.com`.
- Check capacity first: `GET https://ce-net.com/stats` (`nodes`, `cores`, ...). If no nodes
  are connected, `POST /tasks` returns HTTP 503.

## Endpoint

```
POST /tasks  -> {node, lang, func, ok, value, ms, error}
```

Task languages: `wasm`, `js` (sandboxed Worker), `python` (Pyodide, browser nodes only).
Headless workers run `wasm` and `js`. Optional `"target":"<full node id>"` pins the task to
a specific node (otherwise the hub chooses).

## Steps (curl)

### WASM module

```bash
curl -X POST "https://ce-net.com/tasks" \
  -H "content-type: application/json" \
  -d '{"func":"count_primes","args":[200000],"ret":"i32","module":"demo"}'
# -> {"node":"...","lang":"wasm","func":"count_primes","ok":true,"value":17984,"ms":12}
```

### JS code

```bash
curl -X POST "https://ce-net.com/tasks" \
  -H "content-type: application/json" \
  -d '{"lang":"js","code":"i=>i.a+i.b","input":{"a":2,"b":3},"func":"task"}'
# -> {"node":"...","lang":"js","func":"task","ok":true,"value":5,"ms":3}
```

### Python code (browser nodes only)

```bash
curl -X POST "https://ce-net.com/tasks" \
  -H "content-type: application/json" \
  -d '{"lang":"python","code":"def task(x):\n    return x*x","input":7,"func":"task"}'
# -> {"node":"...","lang":"python","func":"task","ok":true,"value":49,"ms":40}
```

### Pin to a specific node

```bash
curl -X POST "https://ce-net.com/tasks" \
  -H "content-type: application/json" \
  -d '{"lang":"js","code":"i=>i*2","input":21,"target":"<full-node-id>"}'
```

Find node ids with `GET https://ce-net.com/nodes` (`{nodes:[{id,short,...}]}`).

## SDKs

Python (web/sdks/python):

```python
from ce import Client
ce = Client()
res = ce.run_task(lang="python", code="def task(x):\n    return x*x", input=7)
print(res["value"])     # 49
```

Go (web/sdks/go):

```go
client := ce.New("demo")
res, _ := client.RunTask(ce.Task{
    Lang:  "python",
    Code:  "def task(x):\n    return x*x",
    Input: 7,
})
fmt.Println(res.Value)  // 49
```

## Gotchas

- HTTP 503 means no nodes are connected. Start a node first (see Prerequisites) and re-check
  `GET /stats`.
- HTTP 504 means the chosen node did not return in time. Retry, or pin a known-good node
  with `target`.
- `python` only runs on browser nodes (Pyodide). Headless `node` workers run `wasm` and `js`
  only. If you need python, ensure a browser node at `https://ce-net.com/node` is connected.
- For `js`/`python`, `func` names the entry point and `input` is its single argument. The
  examples use an arrow function / `def task(...)`. Keep functions pure and self-contained;
  the sandbox has no host filesystem or network.
- For `wasm`, supply `module` (the registered module name), `func`, `args`, and `ret` (the
  return type, e.g. `i32`).
- Always read `ok` and `error` on the response; `ok:false` carries the failure in `error`.
- No emojis in code or output.
