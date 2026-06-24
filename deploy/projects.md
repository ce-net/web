# Per-project, node-id-tied domains

This is how `ce-app` turns a folder of files into a live, globally reachable app with
a stable, collision-free URL — without you ever registering a domain or wiring TLS.

The whole scheme is three ideas stacked together:

1. **A stable public id** identifies *you* (this machine / developer).
2. **A project name** identifies *which app* you are deploying.
3. The two combine into a **single DNS label** so wildcard TLS just works.

No emojis, no servers to configure. One command deploys; the URL is deterministic.

---

## 1. Your stable public id -> nodeprefix

Every developer has one stable public id, stored at:

```
~/.ce/id
```

- On first use it is created once and never changes underneath you.
- If the `ce` CLI is installed, `ce-app` prefers your **CE node id** (the first hex
  token of `ce id`) so the same identity backs every project you ship.
- If the `ce` CLI is absent, a random **16 hex** id is generated and persisted.

The **nodeprefix** is the first **10 hex chars** of that id. It is what namespaces
your apps so that your `chat` and someone else's `chat` never collide.

See it any time:

```
ce-app whoami
```

Example output:

```
id:         d2a87a243964e47a
nodeprefix: d2a87a2439
source:     generated  (~/.ce/id)
project:    my-cool-chat
app id:     my-cool-chat-d2a87a2439
urls:
  https://my-cool-chat-d2a87a2439.ce-net.com/
  https://ce-net.com/apps/my-cool-chat-d2a87a2439/
```

---

## 2. Project -> app id -> subdomain

A project's **app id** is:

```
<project>-<nodeprefix>
```

lowercased and sanitized to a valid DNS label (`a-z0-9-`, runs of dashes collapsed,
no leading/trailing dash, capped at ~50 chars; the nodeprefix is always preserved).

The **project name** is resolved in this order:

1. `--project <name>` flag, else
2. `package.json` `"name"` (npm scope stripped: `@you/chat` -> `chat`), else
3. the current directory name.

This means **one node hosts many projects**. Each project is reachable at BOTH:

```
https://<project>-<nodeprefix>.ce-net.com/          (subdomain)
https://ce-net.com/apps/<project>-<nodeprefix>/     (path)
```

Both are the **same origin** from the app's point of view — so write your app with
relative / `location`-based URLs and pick a fixed namespace string in code (e.g.
`const APP = "arena"`) so realtime rooms and the database stay consistent no matter
which URL a visitor used.

---

## 3. Why one DNS label keeps TLS automatic

`*.ce-net.com` is covered by a single wildcard TLS certificate. A wildcard matches
**exactly one** label, so `my-cool-chat-d2a87a2439.ce-net.com` is covered, but a
deeper name like `chat.d2a87a2439.ce-net.com` would NOT be.

That is the whole reason the app id is a single hyphenated label
(`<project>-<nodeprefix>`) rather than nested subdomains: every project you deploy is
served over HTTPS instantly, with zero certificate work.

---

## 4. Copy-paste: ship a project

```sh
# scaffold (optional) — pick any template
ce-app new chat my-cool-chat
cd my-cool-chat
npm install

# see your identity + the URLs this folder will deploy to
ce-app whoami

# live, hot-reloading dev (prints BOTH URLs; edits push automatically)
ce-app dev

# one-shot production deploy (auto-detects the framework, builds, uploads)
ce-app deploy
```

`deploy` prints, for example:

```
Uploaded 7/7 file(s).
Live at both URLs (same origin):
  https://my-cool-chat-d2a87a2439.ce-net.com/
  https://ce-net.com/apps/my-cool-chat-d2a87a2439/
```

### Multiple projects from the same machine

Each folder is its own project; the nodeprefix stays the same, the project changes:

```sh
cd ~/code/arena   && ce-app deploy   # -> arena-d2a87a2439.ce-net.com
cd ~/code/notes   && ce-app deploy   # -> notes-d2a87a2439.ce-net.com
cd ~/code/canvas  && ce-app deploy   # -> canvas-d2a87a2439.ce-net.com
```

### Overriding the name

```sh
# name this deploy explicitly (still gets -<nodeprefix> appended)
ce-app deploy --project arena

# pin the FULL app id for a checkout (skips derivation entirely)
ce-app deploy --app arena-prod
echo "arena-prod" > .ce/app-id     # same effect, persisted per-checkout
```

Precedence for the app id: `--app`  >  `./.ce/app-id`  >  `<project>-<nodeprefix>`.

---

## 5. Bring your own domain on top

The auto-generated subdomain is permanent and free. When you want a vanity domain
in front of it, register it against this app's id:

```sh
ce-app domain add app.yourdomain.com
```

That command prints exactly what to do:

```
DNS — add a CNAME at your domain provider:
  CNAME  app.yourdomain.com  ->  ce-net.com

TLS — Cloudflare for SaaS (custom hostnames) terminates TLS for your domain
      automatically once the hostname is added; or install an origin cert.

Once DNS propagates, your app is live at https://app.yourdomain.com/
```

The hub keeps a domain registry mapping your custom hostname to the app id, so the
custom domain serves the very same files as the two built-in URLs.

Manage them:

```sh
ce-app domain ls                       # list this app's custom domains
ce-app domain rm app.yourdomain.com    # unregister
```

---

## Summary

| Thing            | Where / how                                   | Example                         |
|------------------|-----------------------------------------------|---------------------------------|
| Public id        | `~/.ce/id` (prefers `ce id`, else 16 hex)     | `d2a87a243964e47a`              |
| nodeprefix       | first 10 hex of the id                        | `d2a87a2439`                    |
| project          | `--project` / `package.json` name / dir name  | `my-cool-chat`                  |
| app id           | `<project>-<nodeprefix>` (single DNS label)   | `my-cool-chat-d2a87a2439`       |
| subdomain URL    | `https://<app-id>.ce-net.com/`                | wildcard TLS, automatic         |
| path URL         | `https://ce-net.com/apps/<app-id>/`           | same origin as the subdomain    |
| custom domain    | `ce-app domain add` -> CNAME to `ce-net.com`  | `https://app.yourdomain.com/`   |
