# hub.ce-net.com — GitHub for ce-net (plan)

Status: PLAN ONLY. No code yet. Supersedes the abandoned `ce-orch` idea — most of
what that was reaching for (version tracking + live-instance tracking) folds into
the hub instead, far more simply.

## 1. What it is

`hub.ce-net.com` — distributed, open-source-only GitHub for ce-net. It:

- hosts git repos (clone/push/pull with a **normal git client**)
- tracks **versions** (tags/releases) and **live instances** (which nodes run a release)
- has a **web UI** (browse code, diffs, releases, instances)
- handles **pull requests**
- works **perfectly with normal git, GitHub and GitLab** (two-way mirror)
- has a **CLI** (`ce-hub`)
- keeps a **real-time copy of the local ce-net folder** so work survives a machine going down

One rule: **open source only.** Private repos are out of scope by design — everything
on the hub is public, diff-tracked, forkable. That is the whole point (validate security,
accelerate iteration, build for mankind).

## 2. Do NOT rebuild — extend the existing hub

`web/ce-hub` (Rust/axum, `src/main.rs`) already provides the substrate:

| Already there | Reuse for |
|---|---|
| `/blobs/:hash` content-addressed store + pinning | git object storage (objects ARE content-addressed) |
| `/apps/:id` hosted files + `version: u64` + live reload | deployed instances of a repo's build |
| `/projects` + `/registry` (signed publish, public list) | the repo index / discovery |
| `/slugs/*` signed claim/renew | repo + user handles (`alice/spacegame`) |
| `/domains`, `/_host` custom domains | per-repo / per-release public URLs |
| `/db/:app`, `/rt/:app/:room` | PR metadata, comments, live PR/CI status |
| `/nodes`, `/stats` mesh state | the "live instances" view per release |
| Ed25519 signed writes (`x-ce-id`/`x-ce-sig`/`x-ce-ts`/`x-ce-nonce`) | repo ownership, PR authorship, merge auth — one identity, no separate accounts |

The hub already does hosting + versioning + a registry + signed identity. We add **git
semantics** (repos, refs, history, diffs, PRs) and **git-protocol interop** on top of the
same blob store and the same identity.

## 3. The key insight: git == content-addressed blobs

A git repo is a DAG of objects (blobs, trees, commits, tags) each keyed by its own hash,
plus a small set of refs (branch/tag -> commit hash). CE already stores content-addressed
blobs with pinning and mesh replication. So:

- **git objects -> CE blobs**, 1:1, deduplicated and replicated for free.
- **refs** -> a tiny signed, versioned record per repo (who owns it, branch->hash map).
  This is the only mutable, consensus-ish part, and it is small.
- distribution/redundancy of repos = the same pin/replication story as every other CE blob.

This is why the hub is the natural home for "versions" and "live instances," and why a
separate orchestrator/registry abstraction is not needed: a repo already has releases, and
a release already maps to running apps the hub hosts.

## 4. Scope, in build order (each phase shippable on its own)

### Phase 1 — Git core (clone/push works with a normal client)
- Speak the **git smart-HTTP protocol** (`/:owner/:repo.git/info/refs`,
  `git-upload-pack`, `git-receive-pack`) so `git clone https://hub.ce-net.com/alice/spacegame.git`
  and `git push` Just Work, no custom client required.
- Store objects as CE blobs; store refs in a signed per-repo record (reuse the slug/projects
  signing scheme — push is authorized iff signed by the repo owner's capability).
- Rust: use `gix` (gitoxide) for object/pack handling; back its object store onto the hub blob store.
- Repo create = signed request, same as `/projects` publish. Owner = the pushing identity.

### Phase 2 — Web UI (browse + diff + releases + instances)
- Static SPA served as a hosted app on the hub itself (dogfood). Repo browser, file view,
  commit log, **diff view**, tags/releases, README render.
- **Instances tab**: for each release, show which nodes currently run it (join repo releases
  to the existing `/apps` + `/nodes` data). This is the "live instances" feature, and it
  reuses data the hub already has — no new tracking system.

### Phase 3 — Pull requests
- PR = a source ref + target ref + a signed PR record (store in `/db/:app` keyed by repo).
- UI: open PR, render diff, comment thread (reuse `/db` + `/rt` rooms for live updates),
  merge button. Merge = standard git merge commit written back via receive-pack path,
  authorized by the repo owner / a maintainer capability.
- No bespoke review engine in v1 — comments + threaded discussion + merge. (Expert
  proof/anti-proof voting from the governance notes is a later, separate layer, NOT here.)

### Phase 4 — GitHub / GitLab interop (two-way mirror)
- **Mirror in**: register an upstream GitHub/GitLab URL; the hub periodically fetches and
  mirrors it into a CE-hosted repo (read-through cache of public OSS).
- **Mirror out**: push-on-merge to a configured GitHub/GitLab remote, so the hub can be the
  primary while GitHub stays a synced mirror (and vice versa). Plain git remotes underneath,
  so "works perfectly with normal git" is literally true.

### Phase 5 — CLI (`ce-hub`) + real-time folder mirror
- `ce-hub` thin CLI over the hub API + git: `ce-hub clone`, `ce-hub pr`, `ce-hub release`,
  `ce-hub instances`, `ce-hub mirror`.
- **Live folder mirror**: a `ce-hub watch ~/ce-net` daemon that continuously mirrors the local
  ce-net workspace into hub repos (reuse `rdev watch`'s content-addressed delta engine — do
  NOT write a new sync engine). This is the "real-time copy of my Mac's ce-net folder so you
  can branch out of it / have a live copy if my Mac is off" ask.

## 5. How "versions" and "live instances" work (the part that replaces ce-orch)

- A repo has tags -> these are **releases**. A release points at an immutable commit (= a set
  of CE blobs).
- Deploying a release (via the existing `ce-app deploy` / hub `/apps` path) records the
  running instance against that release.
- The hub's **Instances tab** then answers, per repo/release: which node-ids run it, their
  uptime/latency/health (from `/nodes` + `/stats`), and the public URL.
- That is the entire "live instance registry" the orchestrator wanted — as a view over data
  the hub already holds, with zero new abstraction and no `ce-orch up`.

If, later, an SDK genuinely needs "resolve a healthy instance of repo X to call," it becomes
a single read against the hub's Instances data — a thin helper, not a framework. We decide
that only if a concrete app needs it.

## 6. What this explicitly is NOT (keep it simple)

- Not private repos. Open source only.
- Not a new orchestration framework. No `ce-orch`, no compose DSL, no `up` command.
- Not a new sync engine (reuse `rdev watch`), not a new identity/auth system (reuse signed
  CE identity), not a new blob store (reuse the hub's).
- Not the governance/voting/expert-proof system — that is a separate concern and a separate
  later plan.

## 7. Open questions for Leif (decide before Phase 1)

1. **Repo addressing**: `hub.ce-net.com/<owner>/<repo>` where owner = a claimed slug tied to
   your node identity? (Recommended — reuses the slug registry.)
2. **Git object hash**: SHA-1 (max compatibility with today's git/GitHub) or SHA-256
   (future-proof, but some tooling still lags)? Recommend SHA-1 for interop in v1.
3. **Push auth**: owner-capability only in v1, maintainer delegation via ce-cap later? (Recommended.)
4. **Hosting**: hub.ce-net.com as a new subdomain routed to the same `ce-hub` process on the
   relay, or a separate process? (Recommend same process, new routes — it already has the store.)
5. **gitoxide vs git2(libgit2)**: pure-Rust `gix` (preferred, no C dep) vs `git2`. Recommend `gix`.
</content>
</invoke>
