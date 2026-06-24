# CE database

A persistent key-value store, namespaced per app. Values are arbitrary JSON. Lists come back
newest-first and can be filtered by prefix. No schema, no setup — the namespace is your app id.

## Set, get, delete a key

```bash
# write JSON to a key
curl -X PUT https://ce-net.com/db/my-app/user:42 \
  -H "content-type: application/json" \
  -d '{"name":"Ada","score":9}'
# -> {"ok":true,"key":"user:42"}

# read it back
curl https://ce-net.com/db/my-app/user:42
# -> {"name":"Ada","score":9}   (or 404 if absent)

# list newest-first, filter by prefix, cap the count
curl "https://ce-net.com/db/my-app?prefix=user:&limit=20"
# -> {"items":[{"key":"user:42","value":{...}}],"n":1}

# delete
curl -X DELETE https://ce-net.com/db/my-app/user:42
```

```js
import { createClient } from "@ce/client";
const ce = createClient();   // appId auto-resolves from the page URL

await ce.db.set("user:42", { name: "Ada", score: 9 });
const u   = await ce.db.get("user:42");
const all = await ce.db.list("user:", 20);
await ce.db.del("user:42");
```

```js
// plain fetch
const base = "https://ce-net.com", app = "my-app";

await fetch(`${base}/db/${app}/user:42`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Ada", score: 9 }),
});

const u = await (await fetch(`${base}/db/${app}/user:42`)).json();
```

## Listing semantics

`GET /db/:app` returns `{items:[{key,value}],n}`, newest-first. `prefix` filters keys; `limit` caps
how many come back. Useful for feeds, message logs, and leaderboards where the most recent writes
matter most.

## Origins

The database is reachable from all three origins for your app — the path origin, your subdomain, and
any custom domain — so a page served at `app.acme.com` can call `/db/my-app/<key>` on the same host.

## Endpoints

| Method | Path | Returns |
| --- | --- | --- |
| PUT | `/db/:app/:key` | `{ok, key}` |
| GET | `/db/:app/:key` | value, or `404` |
| DELETE | `/db/:app/:key` | deletes the key |
| GET | `/db/:app?prefix=&limit=` | `{items:[{key,value}], n}` (newest-first) |

## Limits

5000 keys per namespace; the global namespace cap is `CE_HUB_MAX_DB_NAMESPACES` (default 500).
Over-budget writes return HTTP `507`. See `limits.md`.
