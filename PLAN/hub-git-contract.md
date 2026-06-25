# hub.ce-net.com git layer — build contract (single source of truth)

All agents building the hub git layer MUST conform to this. Read it fully before coding.
Plan rationale: see `PLAN/hub-github-for-cenet.md`. This file is the precise interface.

## Locked decisions
- Repo address: `hub.ce-net.com/<owner>/<repo>` (UI) and git remote
  `https://hub.ce-net.com/<owner>/<repo>.git`. `<owner>` is a claimed slug from the EXISTING
  `/slugs` registry, bound to a CE node identity.
- Git hash: **SHA-1** (max interop with today's git/GitHub).
- Object/diff library: **gix** (gitoxide, pure Rust) for the READ side only.
- Clone/push wire protocol: proxy to the system **`git http-backend`** (the real git binary) over
  on-disk **bare repos**. gix is NOT used for the server wire protocol.
- Extend the EXISTING `web/ce-hub` Rust/axum binary (do not create a second hub). It runs on
  `:8970`, persists under `CE_HUB_DATA`. Auth is Ed25519 signed headers, admin is identity-based.
- Open source only. No private repos.

## Storage layout (under CE_HUB_DATA)
- `git/<owner>/<repo>.git`           bare repo (the authoritative object store for v1)
- `repos.json`                       repo registry (metadata), atomic write + lock (mirror the
                                     existing projects.json/slugs.json pattern in main.rs)
- PR records + comments              reuse the existing per-app KV (`/db/:app`) keyed by
                                     `repo:<owner>/<repo>` ; live updates via existing `/rt` rooms
- Phase-2 (NOT v1, document only): replicate loose/packed objects into the existing `/blobs`
  content-addressed store + pin, for cross-node redundancy. v1 keeps repos on the relay disk.

## Auth model (reuse what exists)
- All JSON mutating writes: existing signed-header scheme (`x-ce-id`, `x-ce-sig`, `x-ce-ts` seconds,
  `x-ce-nonce`, body = sha256-hex). Find the verifier already in `web/ce-hub/src/main.rs` (used by
  slug_claim / project_publish) and REUSE it.
- Repo ownership: the identity that created the repo, OR the holder of the `<owner>` slug.
- `git push` (receive-pack) auth: accept HTTP Basic where username = owner id (hex) and password =
  a short-lived signed capability token the `ce-hub` CLI mints; ce-hub verifies the signature before
  invoking git-receive-pack. Anonymous clone/fetch (upload-pack) of public repos is allowed
  (everything is public). Reject receive-pack without a valid owner/maintainer signature.

## HTTP routes (add to the axum Router in main.rs)
Git wire (proxy to `git http-backend`, env GIT_PROJECT_ROOT=CE_HUB_DATA/git, GIT_HTTP_EXPORT_ALL):
- GET  `/git/:owner/:repo/info/refs?service=git-(upload|receive)-pack`
- POST `/git/:owner/:repo/git-upload-pack`
- POST `/git/:owner/:repo/git-receive-pack`   (auth-gated as above)
  (`:repo` may include the trailing `.git`; normalize.)

Repo registry (JSON):
- POST   `/repos`                 create {owner, name, desc?, mirror_upstream?} (signed by owner)
- GET    `/repos`                 list public repos (paged)
- GET    `/repos/:owner/:repo`    metadata: default_branch, refs, head commit, releases, #instances
- DELETE `/repos/:owner/:repo`    owner only (signed)

Read API (gix-powered) for the UI:
- GET `/repos/:owner/:repo/tree/:ref/*path`        tree listing (dir entries)
- GET `/repos/:owner/:repo/blob/:ref/*path`        file bytes (+ detected content-type)
- GET `/repos/:owner/:repo/commits/:ref`           commit log, paged (?after=&limit=)
- GET `/repos/:owner/:repo/commit/:sha`            commit detail + unified diff
- GET `/repos/:owner/:repo/compare/:base/:head`    diff base..head (powers PR diff)
- GET `/repos/:owner/:repo/releases`               tags as releases

Pull requests:
- POST `/repos/:owner/:repo/pulls`                 open {title, body, head_ref, base_ref} (signed)
- GET  `/repos/:owner/:repo/pulls`                 list
- GET  `/repos/:owner/:repo/pulls/:n`              detail (diff via compare)
- POST `/repos/:owner/:repo/pulls/:n/comments`     signed comment (store in KV, broadcast on /rt)
- POST `/repos/:owner/:repo/pulls/:n/merge`        owner/maintainer (signed) -> git merge -> updates ref

Instances (the "live instances" feature = a VIEW over existing data):
- GET `/repos/:owner/:repo/instances`   join repo releases to existing hosted apps (`/apps`) +
  live node stats (`/nodes`) -> [{node_id, release/tag, url, uptime, latency, healthy}]

Mirror (github/gitlab interop):
- POST `/repos/:owner/:repo/mirror`     configure upstream URL + direction (in|out|both), trigger
  a sync. Implementation: shell `git` against the bare repo (fetch upstream / push to upstream).
  Store mirror config in repos.json. (Two-way mirror; underneath it's plain git remotes.)

## Module layout (BACKEND agent owns all of web/ce-hub/src and Cargo.toml)
- `src/git_http.rs`   git-http-backend CGI proxy + push auth gate
- `src/repos.rs`      repos.json registry: create/list/get/delete, ownership checks
- `src/repo_read.rs`  gix read API: tree/blob/commits/commit/compare/releases
- `src/pulls.rs`      PR model + merge (shell git for merge), comments via KV/rt
- `src/instances.rs`  releases x apps x nodes join
- `src/mirror.rs`     upstream mirror config + sync
- `src/main.rs`       wire all routes into the existing Router; keep existing routes intact
Cargo deps to add: `gix` (pin a recent version, default features minimal; SHA-1), keep axum/tokio.

## Hard constraints
- Do NOT break or remove any existing ce-hub route or behavior (it serves live apps + stats).
- Do NOT run `cargo build`/`cargo check` locally — the laptop disk is at 96%. The build happens on
  the relay via `web/deploy/ce-build.sh hub`. Write code to compile; do not compile it here.
- Respect storage budgets: add a per-repo + total git-data cap (env `CE_HUB_MAX_GIT_BYTES`,
  default 2 GiB) so an anonymous pusher cannot fill the disk. Reject pushes over budget.
- Repo/owner names: validate strictly (lowercase a-z0-9 and hyphen, 1-64 chars) to prevent path
  traversal into `git/`. Never interpolate untrusted input into a shell; use argv arrays.
- No emojis anywhere. anyhow::Result, tracing for logs, no unwrap in request paths.

## Deploy (done by the human operator after the workflow, NOT by agents)
- `bash web/deploy/ce-build.sh hub` (native build on relay + restart)
- New nginx server block for `hub.ce-net.com` -> proxy / to :8970 (UI + /git + /repos)
- Cloudflare A record `hub.ce-net.com` -> 178.105.145.170 (proxied)
</content>
