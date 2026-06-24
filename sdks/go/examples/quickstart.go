// Minimal runnable example for the ce Go SDK.
//
//	cd web/sdks/go && go run ./examples
//
// Talks to the live hub at https://ce-net.com. The realtime section runs only
// with -room (it blocks); the database section always runs.
package main

import (
	"encoding/json"
	"flag"
	"fmt"

	ce "github.com/ce-net/ce-go"
)

func main() {
	room := flag.Bool("room", false, "join the realtime room demo (blocks)")
	flag.Parse()

	client := ce.New("demo") // base defaults to https://ce-net.com
	fmt.Println("app:", client.App, "base:", client.Base)

	// Database: persistent KV namespaced per app.
	if _, err := client.DB.Set("hello", map[string]any{"from": "go-sdk", "n": 1}); err != nil {
		fmt.Println("set error:", err)
	}
	if v, err := client.DB.Get("hello"); err != nil {
		fmt.Println("get error:", err)
	} else {
		fmt.Println("get  ->", string(v))
	}
	if items, err := client.DB.List("hello", 10); err != nil {
		fmt.Println("list error:", err)
	} else {
		b, _ := json.Marshal(items)
		fmt.Println("list ->", string(b))
	}
	if err := client.DB.Del("hello"); err != nil {
		fmt.Println("del error:", err)
	}

	// Task: dispatch a Python compute job to a live browser node.
	// Requires at least one browser node connected (open https://ce-net.com/node).
	res, err := client.RunTask(ce.Task{
		Lang:  "python",
		Code:  "def task(x):\n    return sum(i * i for i in range(x))",
		Input: 5,
	})
	if err != nil {
		fmt.Println("task -> skipped:", err)
	} else {
		fmt.Printf("task -> value=%s ok=%v ms=%d\n", string(res.Value), res.OK, res.Ms)
	}

	// Realtime room (blocks): only with -room.
	if *room {
		r := client.Room("lobby")
		r.On(func(msg any) { fmt.Println("room ->", msg) })
		_ = r.Send(map[string]any{"text": "hello from go"})
		fmt.Println("listening on room 'lobby' (ctrl-c to stop)...")
		if err := r.Run(true); err != nil {
			fmt.Println("room error:", err)
		}
	}
}
