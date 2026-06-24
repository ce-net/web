# ce-database

A persistent key-value store namespaced per app on the CE hub. Values are arbitrary JSON.
Lists are returned newest-first, which makes it a drop-in store for feeds, logs, comments,
and message history.

## When to use

- You need durable storage for an app but do not want to run a database.
- You want CRUD over JSON values keyed by string, and "give me the latest N items" lists.

## Prerequisites

- Network access to `https://ce-net.com`. No account or key required.
- Choose an app namespace string (`<app>`). All keys live under that namespace. Apps hosted
  on the hub use their app id automatically via `@ce/client`.
- The hub base defaults to `https://ce-net.com`. The same `/db/...` paths also work on
  `https://<id>.ce-net.com/` and on custom domains.

## HTTP surface

```
PUT    /db/<app>/<key>            store a JSON value  -> {ok,key}
GET    /db/<app>/<key>            read a JSON value   -> value | 404
DELETE /db/<app>/<key>            delete a key
GET    /db/<app>?prefix=&limit=   newest-first list   -> {items:[{key,value}],n}
```

## Steps (curl)

```bash
# Create / update a value:
curl -X PUT "https://ce-net.com/db/myapp/user:alice" \
  -H "content-type: application/json" \
  -d '{"name":"Alice","score":42}'
# -> {"ok":true,"key":"user:alice"}

# Read a value (404 if missing):
curl "https://ce-net.com/db/myapp/user:alice"
# -> {"name":"Alice","score":42}

# Newest-first list under a prefix, capped to a limit:
curl "https://ce-net.com/db/myapp?prefix=user:&limit=20"
# -> {"items":[{"key":"user:bob","value":{...}},{"key":"user:alice","value":{...}}],"n":2}

# Delete a key:
curl -X DELETE "https://ce-net.com/db/myapp/user:alice"
```

A feed pattern (newest-first comes for free): write keys with a monotonically increasing or
time-ordered suffix, then list the prefix.

```bash
curl -X PUT "https://ce-net.com/db/myapp/msg:$(date +%s%3N)" \
  -H "content-type: application/json" \
  -d '{"text":"hello","by":"alice"}'

# Latest 50 messages, newest first:
curl "https://ce-net.com/db/myapp?prefix=msg:&limit=50"
```

## Browser client (@ce/client)

```js
import { createClient } from "@ce/client";
const ce = createClient();           // appId auto-resolves from the /apps/<id>/ path or host
await ce.db.set("user:alice", { name: "Alice", score: 42 });
const u = await ce.db.get("user:alice");          // value, or undefined if 404
const recent = await ce.db.list("msg:", 50);      // [{key, value}], newest-first
await ce.db.del("user:alice");
```

## Python SDK (web/sdks/python)

```python
from ce import Client
ce = Client("myapp")
ce.db.set("user:alice", {"name": "Alice", "score": 42})
u = ce.db.get("user:alice")          # value, or None if 404
recent = ce.db.list("msg:", 50)      # newest-first list of {key, value}
ce.db.delete("user:alice")
```

## Go SDK (web/sdks/go)

```go
client := ce.New("myapp")
client.DB.Set("user:alice", map[string]any{"name": "Alice", "score": 42})
v, _ := client.DB.Get("user:alice")        // nil if 404
items, _ := client.DB.List("msg:", 50)     // newest-first
client.DB.Del("user:alice")
```

## Gotchas

- `GET /db/<app>/<key>` returns HTTP 404 (not an empty body) when the key is absent; the
  SDKs map this to `undefined` / `None` / `nil`.
- Lists are newest-first. Encode ordering into the key suffix (timestamp or counter) if you
  rely on it.
- `prefix` and `limit` are query params on the namespace list endpoint, not on per-key GET.
- Limits (HTTP 507 on overflow): 5000 keys per namespace, global 500 db namespaces. Values
  ride inside the per-app / per-blob size limits.
- The namespace is just a string. Two unrelated apps sharing the same `<app>` share the same
  keyspace, so pick a unique namespace.
- No emojis in stored content for user-facing surfaces.
