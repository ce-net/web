# ce (Go)

Go client for the CE App Platform hub. Same surface as the browser client
[`@ce/client`](../../ce-app/client): **tasks**, **database** (KV), and **realtime rooms**.

The default base is `https://ce-net.com`. Realtime uses
[`gorilla/websocket`](https://github.com/gorilla/websocket).

## Install

```bash
go get github.com/ce-net/ce-go
```

```go
import ce "github.com/ce-net/ce-go"
```

## Quickstart

```go
package main

import (
	"fmt"

	ce "github.com/ce-net/ce-go"
)

func main() {
	client := ce.New("demo") // base defaults to https://ce-net.com

	// database: persistent KV, namespaced per app
	client.DB.Set("greeting", map[string]any{"hi": true})
	v, _ := client.DB.Get("greeting") // json.RawMessage, nil if missing
	fmt.Println(string(v))
	items, _ := client.DB.List("greet", 0) // newest-first; 0 = hub default limit
	fmt.Println(items)
	client.DB.Del("greeting")

	// tasks: dispatch compute to a live node
	res, err := client.RunTask(ce.Task{
		Lang:  "python",
		Code:  "def task(x):\n    return sum(i*i for i in range(x))",
		Input: 5,
	})
	if err == nil {
		fmt.Println(string(res.Value), res.Ms, "ms")
	}

	// realtime rooms
	room := client.Room("lobby")
	room.On(func(msg any) { fmt.Println("got", msg) })
	room.Send(map[string]any{"text": "hello"})
	room.Run(true) // blocks, dispatching messages; reconnects on drop
}
```

## API

| @ce/client            | ce (Go)                                            |
| --------------------- | -------------------------------------------------- |
| `createClient(opts)`  | `ce.New(app)` / `ce.NewWithBase(app, base)`        |
| `db.get(key)`         | `client.DB.Get(key)` (`nil` if missing)            |
| `db.set(key, val)`    | `client.DB.Set(key, val)`                          |
| `db.del(key)`         | `client.DB.Del(key)`                               |
| `db.list(prefix, n)`  | `client.DB.List(prefix, limit)`                    |
| `room(name).send`     | `client.Room(name).Send(obj)`                      |
| `room(name).on`       | `client.Room(name).On(fn)` (returns unsubscribe)   |
| `POST /tasks`         | `client.RunTask(ce.Task{...})`                     |

`RunTask` accepts a `Lang` of `"wasm"` (default), `"js"`, `"python"`, ... For
source-code languages set `Code` + optional `Func` (default `"task"`) + `Input`.
For `wasm` set `Module`, `Func`, `Args`, optional `Ret`. Pin a node with `Target`.
Python tasks run on browser nodes (Pyodide); a node must be connected.

## Example

See [`examples/quickstart.go`](examples/quickstart.go): `go run ./examples`.
