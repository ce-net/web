// Package ce is a Go client for the CE App Platform hub.
//
// It mirrors the semantics of @ce/client (the browser JS client): tasks,
// database (KV), and realtime rooms. The default base is https://ce-net.com.
//
//	client := ce.New("demo")                        // base defaults to https://ce-net.com
//	client.DB.Set("greeting", map[string]any{"hi": true})
//	v, _ := client.DB.Get("greeting")
//	items, _ := client.DB.List("greet", 0)
//
//	res, _ := client.RunTask(ce.Task{
//		Lang:  "python",
//		Code:  "def task(x):\n    return x*x",
//		Input: 7,
//	})
//	fmt.Println(res.Value)
//
//	room := client.Room("lobby")
//	room.On(func(msg any) { fmt.Println("got", msg) })
//	room.Send(map[string]any{"text": "hello"})
//	room.Run() // blocks, dispatching messages
//
// The HTTP surface (hub):
//
//	POST   /tasks                     dispatch a job to a live node, await the result
//	GET    /db/<app>/<key>            read a stored JSON value (404 -> nil)
//	PUT    /db/<app>/<key>            store a JSON value
//	DELETE /db/<app>/<key>           delete a key
//	GET    /db/<app>?prefix=&limit=   newest-first list of {key, value}
//	WS     /rt/<app>/<room>           realtime pub/sub room
package ce

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// DefaultBase is the hub origin used when none is supplied.
const DefaultBase = "https://ce-net.com"

// Error is returned when a hub request fails. Status is the HTTP status when known.
type Error struct {
	Message string
	Status  int
}

func (e *Error) Error() string { return e.Message }

// Client talks to one app's namespace on the hub.
type Client struct {
	App  string
	Base string
	DB   *DB

	http *http.Client
}

// New returns a client for the given app id using the default base.
func New(app string) *Client {
	return NewWithBase(app, DefaultBase)
}

// NewWithBase returns a client for the given app id and hub base origin.
func NewWithBase(app, base string) *Client {
	base = strings.TrimRight(base, "/")
	c := &Client{
		App:  app,
		Base: base,
		http: &http.Client{Timeout: 60 * time.Second},
	}
	c.DB = &DB{root: fmt.Sprintf("%s/db/%s", base, url.PathEscape(app)), http: c.http}
	return c
}

// ---- database ----

// DB is a persistent KV store namespaced per app (mirrors @ce/client db).
type DB struct {
	root string
	http *http.Client
}

// ListItem is one entry returned by List.
type ListItem struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

// Get reads a stored JSON value. It returns (nil, nil) when the key is absent (404).
// The returned RawMessage can be unmarshaled into a concrete type.
func (d *DB) Get(key string) (json.RawMessage, error) {
	status, body, err := do(d.http, http.MethodGet, d.root+"/"+url.PathEscape(key), nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, nil
	}
	if status >= 400 {
		return nil, &Error{Message: fmt.Sprintf("db.Get(%q) failed: %d", key, status), Status: status}
	}
	return json.RawMessage(body), nil
}

// SetResult is the hub's PUT response.
type SetResult struct {
	OK  bool   `json:"ok"`
	Key string `json:"key"`
}

// Set stores a JSON-serializable value at key.
func (d *DB) Set(key string, val any) (*SetResult, error) {
	status, body, err := do(d.http, http.MethodPut, d.root+"/"+url.PathEscape(key), val)
	if err != nil {
		return nil, err
	}
	if status >= 400 {
		return nil, &Error{Message: fmt.Sprintf("db.Set(%q) failed: %d", key, status), Status: status}
	}
	var r SetResult
	_ = json.Unmarshal(body, &r)
	return &r, nil
}

// Del deletes a key.
func (d *DB) Del(key string) error {
	status, _, err := do(d.http, http.MethodDelete, d.root+"/"+url.PathEscape(key), nil)
	if err != nil {
		return err
	}
	if status >= 400 {
		return &Error{Message: fmt.Sprintf("db.Del(%q) failed: %d", key, status), Status: status}
	}
	return nil
}

// List returns newest-first items whose key starts with prefix (empty matches all).
// A limit of 0 uses the hub default.
func (d *DB) List(prefix string, limit int) ([]ListItem, error) {
	q := url.Values{}
	if prefix != "" {
		q.Set("prefix", prefix)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	u := d.root
	if enc := q.Encode(); enc != "" {
		u += "?" + enc
	}
	status, body, err := do(d.http, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	if status >= 400 {
		return nil, &Error{Message: fmt.Sprintf("db.List failed: %d", status), Status: status}
	}
	var out struct {
		Items []ListItem `json:"items"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Items, nil
}

// ---- tasks ----

// Task describes a compute job to dispatch via POST /tasks.
//
// For source-code languages (Lang "js", "python", ...) set Code, optional Func
// (default "task"), and Input. For "wasm" set Module, Func, Args, and optional Ret.
// Pin a node with Target.
type Task struct {
	Lang   string `json:"lang,omitempty"`
	Code   string `json:"code,omitempty"`
	Func   string `json:"func,omitempty"`
	Input  any    `json:"input,omitempty"`
	Module string `json:"module,omitempty"`
	Args   []int  `json:"args,omitempty"`
	Ret    string `json:"ret,omitempty"`
	Target string `json:"target,omitempty"`
}

// TaskResult is the hub's response to POST /tasks.
type TaskResult struct {
	Node  string          `json:"node"`
	Lang  string          `json:"lang"`
	Func  string          `json:"func"`
	OK    bool            `json:"ok"`
	Value json.RawMessage `json:"value"`
	Ms    int64           `json:"ms"`
	Error string          `json:"error"`
}

// RunTask dispatches a job to a live node and awaits the result.
func (c *Client) RunTask(t Task) (*TaskResult, error) {
	if t.Lang == "" {
		t.Lang = "wasm"
	}
	if t.Lang != "wasm" && t.Code == "" {
		return nil, &Error{Message: fmt.Sprintf("%s task requires Code", t.Lang)}
	}
	status, body, err := do(c.http, http.MethodPost, c.Base+"/tasks", t)
	if err != nil {
		return nil, err
	}
	if status >= 400 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		msg := e.Error
		if msg == "" {
			msg = fmt.Sprintf("RunTask failed: %d", status)
		}
		return nil, &Error{Message: msg, Status: status}
	}
	var r TaskResult
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// ---- realtime rooms ----

// wsBase converts an http(s) origin to ws(s), mirroring @ce/client.wsBase.
func wsBase(base string) string {
	if strings.HasPrefix(base, "https:") {
		return "wss:" + strings.TrimPrefix(base, "https:")
	}
	if strings.HasPrefix(base, "http:") {
		return "ws:" + strings.TrimPrefix(base, "http:")
	}
	return base
}

// Room is a realtime pub/sub room over websocket (mirrors @ce/client room).
type Room struct {
	url string

	mu       sync.Mutex
	conn     *websocket.Conn
	closed   bool
	outbox   [][]byte
	handlers []func(any)
	onOpen   []func()
}

// Room opens (or joins) a realtime room. Call Run to connect and dispatch messages.
func (c *Client) Room(name string) *Room {
	return &Room{
		url: fmt.Sprintf("%s/rt/%s/%s", wsBase(c.Base), url.PathEscape(c.App), url.PathEscape(name)),
	}
}

// On registers a message handler and returns an unsubscribe function. JSON text
// frames are decoded into any; non-JSON frames are delivered as a string.
func (r *Room) On(fn func(any)) func() {
	r.mu.Lock()
	r.handlers = append(r.handlers, fn)
	idx := len(r.handlers) - 1
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		if idx < len(r.handlers) {
			r.handlers[idx] = nil
		}
		r.mu.Unlock()
	}
}

// OnOpen registers a callback run each time the socket connects.
func (r *Room) OnOpen(fn func()) {
	r.mu.Lock()
	r.onOpen = append(r.onOpen, fn)
	r.mu.Unlock()
}

// Send queues a frame. Objects are JSON-encoded; strings are sent verbatim.
// Frames sent before the socket is open are buffered and flushed on connect.
func (r *Room) Send(obj any) error {
	var data []byte
	switch v := obj.(type) {
	case string:
		data = []byte(v)
	case []byte:
		data = v
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		data = b
	}
	r.mu.Lock()
	conn := r.conn
	if conn == nil {
		r.outbox = append(r.outbox, data)
		r.mu.Unlock()
		return nil
	}
	r.mu.Unlock()
	return conn.WriteMessage(websocket.TextMessage, data)
}

// Run connects and blocks, dispatching incoming messages. With reconnect true it
// retries with a fixed backoff (matching @ce/client). Returns when Close is called.
func (r *Room) Run(reconnect bool) error {
	for {
		r.mu.Lock()
		if r.closed {
			r.mu.Unlock()
			return nil
		}
		r.mu.Unlock()

		conn, _, err := websocket.DefaultDialer.Dial(r.url, nil)
		if err != nil {
			if !reconnect {
				return err
			}
			time.Sleep(1500 * time.Millisecond)
			continue
		}

		r.mu.Lock()
		r.conn = conn
		pending := r.outbox
		r.outbox = nil
		openCbs := append([]func(){}, r.onOpen...)
		r.mu.Unlock()

		for _, m := range pending {
			_ = conn.WriteMessage(websocket.TextMessage, m)
		}
		for _, fn := range openCbs {
			if fn != nil {
				fn()
			}
		}

		readErr := r.readLoop(conn)

		r.mu.Lock()
		r.conn = nil
		closed := r.closed
		r.mu.Unlock()
		_ = conn.Close()

		if closed || !reconnect {
			if closed {
				return nil
			}
			return readErr
		}
		time.Sleep(1500 * time.Millisecond)
	}
}

func (r *Room) readLoop(conn *websocket.Conn) error {
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var payload any
		if json.Unmarshal(raw, &payload) != nil {
			payload = string(raw)
		}
		r.mu.Lock()
		hs := append([]func(any){}, r.handlers...)
		r.mu.Unlock()
		for _, fn := range hs {
			if fn != nil {
				fn(payload)
			}
		}
	}
}

// Close stops reconnecting and closes the socket.
func (r *Room) Close() {
	r.mu.Lock()
	r.closed = true
	conn := r.conn
	r.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

// ---- internal http ----

func do(client *http.Client, method, u string, body any) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, u, rdr)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, &Error{Message: fmt.Sprintf("%s %s failed: %v", method, u, err)}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, data, nil
}
