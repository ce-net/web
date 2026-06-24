# hub.ce-net.com — git layer (operator + user guide)

The hub git layer adds GitHub-style semantics (repos, refs, history, diffs, pull requests,
live instances) to the existing `web/ce-hub` axum binary on `:8970`. It is open source only:
every repo is public, clonable, forkable. The authoritative interface is
`PLAN/hub-git-contract.md`; this file is the operator + user facing reference.

The git layer does NOT introduce a new process, identity system, or blob store. It extends the
hub that already serves hosted apps, the KV database, realtime rooms, and mesh stats.

---

## Repo addressing

| Form | Example |
|---|---|
| UI / web | `https://hub.ce-net.com/<owner>/<repo>` |
| git remote | `https://hub.ce-net.com/<owner>/<repo>.git` |

- `<owner>` is a slug claimed from the existing `/slugs` registry and bound to a CE node
  identity. You must hold the `<owner>` slug (or be the repo's creator) to push or merge.
- `<owner>` and `<repo>` are validated strictly: lowercase `a-z0-9` and hyphen, 1-64 chars.
  This prevents path traversal into the on-disk `git/` store. A trailing `.git` on `<repo>`
  is normalized away.
- Git object hash is **SHA-1** for maximum interop with today's git, GitHub, and GitLab.

---

## Storage layout (under `CE_HUB_DATA`)

```
git/<owner>/<repo>.git     bare repo — the authoritative object store for v1
repos.json                 repo registry (metadata), atomic write + lock
                           (same pattern as the existing projects.json / slugs.json)
```

- PR records and comments reuse the existing per-app KV (`/db/:app`) keyed by
  `repo:<owner>/<repo>`. Live PR/comment updates ride the existing `/rt` rooms.
- Phase 2 (documented, not in v1): replicate loose/packed objects into the existing content
  addressed `/blobs` store and pin them for cross-node redundancy. v1 keeps repos on the
  relay's disk only.

### Storage budgets

An anonymous or low-trust pusher must never be able to fill the relay's disk.

| Env | Default | Meaning |
|---|---|---|
| `CE_HUB_MAX_GIT_BYTES` | 2 GiB (`2147483648`) | total bytes the `git/` tree may occupy |

- Each push is checked against the per-repo and total git-data cap. A push that would exceed
  the budget is rejected (the `git-receive-pack` invocation is refused before it runs).
- This is independent of the existing `CE_HUB_MAX_DATA_BYTES` budget that bounds hosted-app
  files, KV, and uptime records. Set both in `web/deploy/ce-hub.service`.

---

## Auth and push model

There are no separate accounts. One CE node identity (Ed25519) is used for everything.

### Signed JSON writes (repo create/delete, PR open/comment/merge, mirror config)

Every mutating JSON request carries the existing signed-header scheme (the same verifier used
by `/slugs/claim` and `/projects` — see `verify_signed` in `src/main.rs`):

| Header | Value |
|---|---|
| `x-ce-id` | the node public key, hex (32 bytes) |
| `x-ce-sig` | Ed25519 signature over the canonical string, hex (64 bytes) |
| `x-ce-ts` | unix seconds (must be within the server's tolerance window) |
| `x-ce-nonce` | random nonce, hex |

Canonical string that is signed:

```
METHOD"\n"+PATH"\n"+ts"\n"+nonce"\n"+sha256(body)-hex
```

The owner id recorded on-chain-of-records is `sha256(pubkey)[..16]` (32 hex chars). Repo
ownership = the identity that created the repo OR the holder of the `<owner>` slug.

### git push (receive-pack) — HTTP Basic with a signed capability

Anonymous clone/fetch (`git-upload-pack`) of any public repo is allowed. Push
(`git-receive-pack`) requires HTTP Basic where:

- **username** = the owner id (hex), and
- **password** = a short-lived signed capability token the `cehub` CLI mints.

The hub verifies the token's signature (and that it is unexpired and scoped to this repo)
before invoking `git-receive-pack`. A receive-pack request without a valid owner/maintainer
signature is rejected. The token format the e2e and the `cehub` credential helper use:

```
<payload-b64url>.<sig-b64url>
payload = base64url(json{ v:1, scope:"git-receive-pack", repo:"<owner>/<repo>", exp:<unix>, pub:<pubkey-hex> })
sig     = base64url( Ed25519(node-key, payload) )
```

### The `cehub` credential helper

So you do not paste tokens, configure git to call `cehub` as a credential helper. It mints a
fresh short-lived token per push:

```
git config --global credential.https://hub.ce-net.com.helper '!cehub git-credential'
```

`cehub git-credential` reads git's `get` request on stdin, mints a token for the requested
repo, and writes back `username=<owner-id>` / `password=<token>`. Until the CLI ships, push
manually with an inline-credentials remote (this is exactly what the e2e does):

```
git remote set-url origin "https://<owner-id>:<token>@hub.ce-net.com/<owner>/<repo>.git"
git push origin main
```

---

## HTTP routes

### Git smart-HTTP wire (proxied to the system `git http-backend`)

`GIT_PROJECT_ROOT=$CE_HUB_DATA/git`, `GIT_HTTP_EXPORT_ALL` set.

| Method | Path |
|---|---|
| GET | `/git/:owner/:repo/info/refs?service=git-(upload\|receive)-pack` |
| POST | `/git/:owner/:repo/git-upload-pack` |
| POST | `/git/:owner/:repo/git-receive-pack` (auth-gated) |

### Repo registry (JSON)

| Method | Path | Notes |
|---|---|---|
| POST | `/repos` | create `{owner, name, desc?, mirror_upstream?}` (signed by owner) |
| GET | `/repos` | list public repos (paged) |
| GET | `/repos/:owner/:repo` | metadata: default branch, refs, head commit, releases, #instances |
| DELETE | `/repos/:owner/:repo` | owner only (signed) |

### Read API (gix-powered, for the UI)

| Method | Path |
|---|---|
| GET | `/repos/:owner/:repo/tree/:ref/*path` |
| GET | `/repos/:owner/:repo/blob/:ref/*path` |
| GET | `/repos/:owner/:repo/commits/:ref` (paged: `?after=&limit=`) |
| GET | `/repos/:owner/:repo/commit/:sha` (detail + unified diff) |
| GET | `/repos/:owner/:repo/compare/:base/:head` (powers PR diff) |
| GET | `/repos/:owner/:repo/releases` (tags as releases) |

### Pull requests

| Method | Path |
|---|---|
| POST | `/repos/:owner/:repo/pulls` (open `{title, body, head_ref, base_ref}`, signed) |
| GET | `/repos/:owner/:repo/pulls` |
| GET | `/repos/:owner/:repo/pulls/:n` |
| POST | `/repos/:owner/:repo/pulls/:n/comments` (signed; stored in KV, broadcast on `/rt`) |
| POST | `/repos/:owner/:repo/pulls/:n/merge` (owner/maintainer, signed -> git merge -> updates ref) |

### Instances (a VIEW over existing data)

| Method | Path |
|---|---|
| GET | `/repos/:owner/:repo/instances` |

Joins repo releases to the hosted apps (`/apps`) and live node stats (`/nodes`) and returns
`[{node_id, release/tag, url, uptime, latency, healthy}]`. No new tracking system.

### Mirror (GitHub / GitLab interop)

| Method | Path |
|---|---|
| POST | `/repos/:owner/:repo/mirror` (configure upstream URL + direction `in`/`out`/`both`, trigger a sync) |

Underneath it is plain `git` against the bare repo (fetch from / push to the upstream remote).

---

## Running the e2e

`e2e/e2e-hub-git.sh` exercises the whole lifecycle against a locally running hub with a
throwaway `CE_HUB_DATA`: create repo (signed) -> clone -> commit -> push (signed capability
over HTTP Basic, plus an anonymous-push-rejected negative check) -> read tree/commit/blob ->
open + merge a PR -> confirm `/instances` responds.

```
# build the hub first (do NOT build on the laptop — disk is tight):
bash web/deploy/ce-build.sh hub          # native build on the relay
# then copy the binary back, or build locally if you have the disk:
#   (cd web/ce-hub && cargo build --release)

# run it (skips gracefully if the binary, git, or node are missing):
bash e2e/e2e-hub-git.sh

# overrides:
CE_HUB_BIN=/path/to/ce-hub CE_HUB_PORT=18971 bash e2e/e2e-hub-git.sh
```

Prerequisites: a built `ce-hub` binary, the system `git` client (the wire protocol proxies to
`git http-backend`), and `node` (used only to generate a keypair and sign requests). It needs
no network, no Docker, and no relay — everything runs against `127.0.0.1`.

Expect a final `PASS=N  FAIL=0` line; a non-zero exit means a check failed.
