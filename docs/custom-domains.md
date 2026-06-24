# Custom domains and the subdomain

## Custom production domains

Point a production domain at your app in three steps:

1. Attach the domain to your app (CLI or API). The response tells you the CNAME target — always
   `ce-net.com`.
2. At your DNS provider, create a `CNAME` for the domain pointing to `ce-net.com`.
3. Load `https://<your-domain>/`. nginx sets an `X-CE-Host` header so the hub resolves which app to
   serve via `GET /_host/*path`.

```bash
# CLI
npx ce-app domain add app.acme.com
# prints the CNAME (app.acme.com -> ce-net.com) and the TLS note
```

```bash
# attach
curl -X PUT https://ce-net.com/apps/my-app/domain \
  -H "content-type: application/json" \
  -d '{"domain":"app.acme.com"}'
# -> {"domain":"app.acme.com","id":"my-app","cname":"ce-net.com"}

# list all mapped domains
curl https://ce-net.com/domains
# -> [{"domain":"app.acme.com","id":"my-app"}]

# detach
curl -X DELETE https://ce-net.com/apps/my-app/domain/app.acme.com
```

Your database and rooms work on the custom origin too:
`https://app.acme.com/db/my-app/<key>` and `wss://app.acme.com/rt/my-app/<room>`.

### Domain endpoints

| Method | Path | Notes |
| --- | --- | --- |
| PUT | `/apps/:id/domain` | `{"domain":"app.acme.com"}` -> `{domain, id, cname:"ce-net.com"}`. |
| DELETE | `/apps/:id/domain/:domain` | Detach a domain. |
| GET | `/domains` | `[{domain, id}]`. |
| GET | `/_host/*path` | Resolves the app from the `X-CE-Host` header (nginx sets it). |

## Your subdomain

Every app id also resolves on a wildcard subdomain, live today: `https://<id>.ce-net.com/`. No
setup — deploy to an id and the subdomain serves it. The `@ce/client` SDK auto-resolves your app id
from either the `/apps/<id>/` path or the `<id>.ce-net.com` host, so the same client code works on
all three origins.

| Origin | URL |
| --- | --- |
| Path | `https://ce-net.com/apps/<id>/` |
| Subdomain | `https://<id>.ce-net.com/` |
| Custom | `https://<custom-domain>/` (CNAME to `ce-net.com`) |

`/db/<app>/<key>` and `wss://ce-net.com/rt/<app>/<room>` work on all of these origins.
