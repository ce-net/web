# Auto-Sync: continuous, content-addressed folder sync as a CE app (rdev v2)

> Workstream: `autosync` · Suggested target path: `rdev/docs/autosync.md`
> Depends on: notes

**Summary:** Auto-Sync upgrades rdev's naive `watch` mirror into a robust, continuous, resumable folder-sync engine that lives entirely at the app/SDK tier — no node changes required. It replaces whole-file resends with content-addressed delta transfer: files are chunked client-side via the existing `ce-rs::data` machinery (sha256 CIDs, 1 MiB chunks), the receiver reports which chunk CIDs it already holds, and only missing chunks move — over the data layer's blob store (`put_blob`/`get_blob`, mesh fetch-by-hash already implemented as Stage 2). It adds `.ceignore` (gitignore semantics), debounce/batch, a persistent local index, capability-gated bidirectional sync with explicit conflict policy (last-writer-wins default, conflict-copy and CRDT-merge options), and crash-resumability. The same chunk/CID/delta engine is the shared substrate the Notes app reuses, so this workstream builds the file-sync half of a primitive both apps depend on.

---

# Auto-Sync — continuous, content-addressed folder sync (rdev v2)

## 1. Goals / non-goals

### Goals
- **Continuous** filesystem watch (fsevents/inotify/ReadDirectoryChangesW via the `notify` crate, already a dep) with debounce/batch coalescing.
- **`.ceignore`** with gitignore semantics, including ignoring `.ceignore` changes that retrigger correctly.
- **Content-addressed delta transfer**: never resend chunks the receiver already has. Reuse `ce-rs::data` (`chunk_object`, `cid`, `Manifest`) and the blob store (`put_blob`/`get_blob`) — the same machinery Notes uses for attachments.
- **Resumable**: a kill -9 mid-sync resumes from a persistent index, never re-hashing or re-sending what is provably already in place.
- **Bidirectional** sync with an explicit, opinionated conflict model: **last-writer-wins (LWW) default**, **conflict-copy** opt-in, **CRDT-merge** for registered file types (shared with Notes).
- **Capability-gated** end to end: every mutation is authorized by a signed attenuating `ce-cap` chain rooted at the receiver or a configured org root, with a `path_prefix` caveat — exactly the model rdev already enforces in `fs_action`.
- **Pure app/SDK**: ships as `rdev` (new `rdev syncd` daemon + protocol verbs over `AppRequest`). **Zero node changes.**

### Non-goals
- No new node RPCs or HTTP endpoints. All transport is `ce-rs` `request`/`reply`/`send_message` + `put_blob`/`get_blob`.
- No real-time multi-writer collaborative *editing* of arbitrary binary files. Concurrent-edit convergence for text is the CRDT path (shared with Notes); everything else is LWW/conflict-copy.
- No general filesystem semantics beyond regular files + directories + deletes (symlinks are not followed; special files are skipped). Permissions/xattrs are out of scope for v1 (mode bit only, see §5).
- Not a backup/versioning product. History beyond conflict copies is out of scope (Notes owns history via its CRDT).

## 2. What exists today vs. new work

### Exists in `rdev` (`rdev/src/main.rs`)
- `rdev watch <dir> <target>:<dir>` — initial full walk + `notify` watcher + 250 ms batch window + per-file push/delete. **But**: resends the *whole file* on any change (`push_file` → `rdev/sync` with `data_hex` = entire file hex), hardcoded `SKIP` list (no `.ceignore`), no persistent index (re-walks from scratch each start), no resume, no conflict handling, one-directional only, inlines file bytes as hex in JSON (breaks on large files).
- `rdev serve` — polls `client.messages()`, authorizes via `ce_cap::authorize` (root/expiry/audience/revocation), dispatches `rdev/sync|delete|exec|spawn`, enforces `path_prefix` caveat + `..` traversal + home-canonicalization in `fs_action`.
- Capability resolution (`resolve`), config aliases, `RDEV_ROOTS`, on-chain revoked-set refresh.

### New work (this doc)
| Component | New / Changed |
|---|---|
| `rdev syncd` daemon (replaces `watch`) | NEW — long-running, bidirectional, resumable engine |
| `.ceignore` parsing (`ignore` crate) | NEW |
| Persistent sync index (sled-free, JSON+fsync) | NEW |
| Content-addressed delta protocol (`rdev/sync2/*`) | NEW protocol verbs over `AppRequest` |
| Chunk-have negotiation + blob-store transfer | NEW (composes existing `put_blob`/`get_blob`) |
| Conflict engine (LWW / conflict-copy / CRDT) | NEW |
| `serve` handlers for the new verbs | CHANGED (`serve` gains `sync2/*` dispatch) |
| Old `rdev/sync` (whole-file) | KEPT for `rdev push` one-shots; deprecated for watch |

**Node changes: none.** The blob store, mesh fetch-by-hash (Stage 2), and `AppRequest` already exist.

## 3. Architecture

```
┌─────────────── initiator node (laptop) ────────────────┐        ┌──────────── responder node (desktop) ────────────┐
│ rdev syncd ~/proj  desktop:proj  --bidirectional        │        │ rdev syncd (server side, started by `rdev syncd`  │
│                                                          │        │ on a watched dir, OR `rdev serve` accepting verbs)│
│  notify watcher → debounce(500ms) → scan changed paths   │        │                                                   │
│  for each path: chunk_object() → {file_cid, [chunk_cid]} │  AppRequest (ce-rs request/reply, topic rdev/sync2/*)   │
│  diff vs local index → SyncManifest delta ───────────────┼───────▶│ index lookup: which chunk_cids do I already hold? │
│                                                          │◀───────┼─ HaveReply { missing:[chunk_cid…] }               │
│  for missing chunk: put_blob(chunk)  (→ blob store,      │        │ get_blob(chunk_cid) (local, else mesh fetch-by-   │
│   self-replicates over mesh Stage 2)                     │        │  hash Stage 2) → reassemble → atomic write        │
│  Commit { file_cid, manifest } ─────────────────────────┼───────▶│ verify reassembled == file_cid → fsync → rename   │
│                                                          │◀───────┼─ Ack { applied | conflict(remote_cid) }           │
│  conflict? → policy: LWW | conflict-copy | crdt-merge    │        │                                                   │
└──────────────────────────────────────────────────────────┘        └───────────────────────────────────────────────────┘
            persistent index: ~/.local/share/rdev/sync/<session>.idx (crash-safe)
```

Key idea: **the bytes travel as blobs, not in the RPC.** A `Commit` carries only CIDs (hashes). Chunks are uploaded with `put_blob` (the receiver pulls them with `get_blob`, which already falls back to mesh fetch-by-hash + verify + cache per data-layer Stage 2). The RPC layer only moves manifests and have/missing CID lists — tiny, regardless of file size. This fixes the "hex-inline in JSON" large-file bug for free and gives dedup + resume.

### Why blob store instead of streaming chunks in `reply`
`ce-rs::request` returns `Vec<u8>` (a single reply); it is request/reply, not a stream. Inlining many MiB of chunk bytes per reply is the same anti-pattern as today's `data_hex`. The blob store is content-addressed, mesh-replicating, and verified — it is the correct transport for the bytes. The `AppRequest` channel carries only control (manifests, have-sets, acks). This is the explicit composition the data-layer doc anticipates ("instead of today's one-file `sync`").

## 4. Sync protocol (over `AppRequest`, topic `rdev/sync2/<verb>`)

All payloads are JSON, hex-encoded into the `AppRequest` payload (matching rdev's existing `Req`/`Resp` convention). Every request carries `caps` (the encoded chain) and is authorized server-side with `ce_cap::authorize(host_id, roots, &[], now(), &from, action, &chain, &is_revoked)` exactly as `handle_inner` does today. The `action` string for authorization is `"sync"` (write) or `"delete"` — **reusing the abilities rdev already grants**, so existing `ce grant <id> --can sync,delete` capabilities work unchanged. (Bidirectional pull adds a `"sync-read"` ability — see §8.)

### Verbs

```jsonc
// rdev/sync2/have  — "do you already hold these chunks?"  (idempotent, read-only)
//   request:
{ "caps": "<chain>", "chunks": ["<chunk_cid>", ...] }
//   reply:
{ "ok": true, "missing": ["<chunk_cid>", ...] }   // subset of chunks not in receiver's blob store

// rdev/sync2/commit — "this file is now this manifest; apply it"
//   request:
{ "caps": "<chain>",
  "path": "rel/path.rs",                 // receiver joins under home + enforces path_prefix caveat
  "file_cid": "<sha256 of full file>",   // == reassembled bytes hash; cross-check
  "manifest": { "kind":"ce-object-v1", "chunk_size":1048576, "total_size":1234,
                "chunks":["<cid>", ...] },
  "base_cid": "<cid|null>",              // what the initiator believed the receiver's file was (for conflict detect)
  "mode": 33188,                          // unix mode bits (0 on Windows; receiver applies x-bit only)
  "mtime_ms": 1718900000000 }
//   reply:
{ "ok": true, "applied": true }
//   OR conflict:
{ "ok": true, "applied": false, "conflict": true, "remote_cid": "<cid>", "remote_mtime_ms": 171... }

// rdev/sync2/delete — tombstone a path (idempotent)
{ "caps": "<chain>", "path": "rel/path.rs", "base_cid": "<cid|null>" }
//   reply: { "ok": true, "deleted": true }  | conflict as above (remote changed since base)

// rdev/sync2/list — receiver returns its current index for the subtree (initial reconcile / bidir)
//   request:
{ "caps": "<chain>", "prefix": "rel/dir" }
//   reply:
{ "ok": true, "entries": [ { "path":"a.rs", "file_cid":"<cid>", "mtime_ms":..., "mode":33188 }, ... ] }
```

### Transfer sequence for one changed file (delta)
1. Initiator chunks the file: `let (manifest, chunks) = chunk_object(&bytes, DEFAULT_CHUNK_SIZE)` and `file_cid = cid(&bytes)`.
2. `rdev/sync2/have { chunks: manifest.chunks }` → `missing`.
3. For each `cid` in `missing`: `client.put_blob(chunk_bytes)` (verifies returned hash == cid, as `put_object` already does). The chunk now lives in the initiator's blob store and is discoverable mesh-wide.
4. `rdev/sync2/commit { path, file_cid, manifest, base_cid, mode, mtime_ms }`.
5. Receiver: for each chunk in manifest, `get_blob(cid)` (local hit, else mesh fetch-by-hash Stage 2, verified). `reassemble(&manifest, fetch)` (the pure verifier in `ce-rs::data`). Assert `cid(&out) == file_cid`. Write to `path.tmp`, fsync, `rename` (atomic). Update receiver index.

**Unchanged chunks never move.** A 1-byte edit in a 500 MB file ships one 1 MiB chunk (or zero, if it happened to match an existing chunk). This is the whole point.

### Reconcile-on-start
On `rdev syncd` startup, initiator calls `rdev/sync2/list` for the root, diffs against its own freshly-walked index, and enqueues the minimal set of commits/deletes/pulls. This replaces today's unconditional full re-push.

## 5. Data model

### Persistent local index — `~/.local/share/rdev/sync/<session>.idx`
`<session>` = `blake3(local_root || ":" || remote_node_id || ":" || remote_root)[..16]` hex. Stored as length-prefixed JSON lines, written via temp-file + fsync + rename on each batch (crash-safe; no external DB dependency, matching rdev's zero-infra ethos).

```rust
struct IndexEntry {
    rel_path: String,        // forward-slash, relative to root
    file_cid: String,        // sha256 of file bytes (== ce_rs::data::cid)
    size: u64,
    mtime_ms: u64,           // local fs mtime, ms
    mode: u32,               // unix mode; 0 on Windows
    chunks: Vec<String>,     // chunk CIDs (so resume needs no re-hash if mtime+size unchanged)
}
struct Index {
    version: u32,            // = 1
    local_root: String,
    remote_node_id: String,  // 64-hex
    remote_root: String,
    // last fully-acked remote state, for conflict base detection (bidir):
    remote_seen: BTreeMap<String /*rel_path*/, RemoteSeen>, // {file_cid, mtime_ms}
    entries: BTreeMap<String /*rel_path*/, IndexEntry>,
}
```

**Fast change detection (the rsync trick):** if a file's `(size, mtime_ms)` match the index entry, skip re-hashing entirely — trust the cached `file_cid`/`chunks`. Only re-chunk when size/mtime differ. This is what makes startup reconcile and watch cheap.

**Resume:** on restart, the index already records `chunks` per file. A commit interrupted after `put_blob` but before `commit` simply re-issues `have` (the chunks are still in the blob store) and re-commits — idempotent. A commit interrupted on the receiver leaves `path.tmp` (cleaned on next write); the real file is untouched until the atomic rename.

### `.ceignore`
Parsed with the `ignore` crate (`ignore::gitignore::GitignoreBuilder`) — full gitignore semantics (negation, `**`, anchored patterns, directory-only `dir/`). Built-in defaults still apply (the current `SKIP` set: `.git`, `target`, `node_modules`, `.DS_Store`, editor temp suffixes) and are prepended as low-priority rules so `.ceignore` can re-include them. The `.ceignore` file itself is watched; on change the matcher is rebuilt and a reconcile pass runs (newly-ignored files are *not* deleted remotely — ignore means "stop syncing", not "delete"; newly-unignored files are pushed).

## 6. CLI / UI surface

```
rdev syncd <local-dir> <target>:<remote-dir> [flags]
    --cap <token>                 # capability (else alias's cap), as today
    --bidirectional               # default OFF (push-only mirror, like today's `watch`)
    --conflict <lww|copy|crdt>    # default: lww
    --delete                      # propagate deletes (default ON for push, see note)
    --debounce-ms <ms>            # default 500
    --once                        # reconcile once and exit (no watch) — for scripts/CI
    --dry-run                     # print the planned commits/deletes, transfer nothing

rdev push <file> <target>:<path>      # UNCHANGED (one-shot, whole-file via rdev/sync) — kept
rdev rm   <target>:<path>             # UNCHANGED
rdev watch ...                        # ALIAS to `rdev syncd --conflict lww` (back-compat shim, deprecated)
```

### Terminal output (honor `ce/docs/design.md` — quiet, structured, no emoji)
```
$ rdev syncd ~/proj desktop:proj --bidirectional
reconcile  desktop:proj  (123 files, 1.2 GiB)
  ↑ push   src/main.rs          (2 chunks, 1 new)
  ↑ push   Cargo.lock           (1 chunk, 0 new — dedup)
  ↓ pull   README.md            (1 chunk)
  = same   847 files
watching ~/proj -> desktop:proj   conflict=lww  (Ctrl-C to stop)
  ↑ src/lib.rs        (1/3 chunks new)
  ! conflict docs/x.md → kept remote, wrote local copy docs/x.md.conflict-laptop-1718900000
```

`--dry-run` prints the plan and exits. No interactive prompts (the orchestration constraint). All progress to stderr; machine-readable `--json` event stream is a milestone-5 add.

## 7. Conflict handling (opinionated)

A conflict exists when `commit`/`delete` arrives with `base_cid != receiver's current file_cid` — i.e. the receiver's file changed since the initiator last saw it.

- **`lww` (default):** compare `mtime_ms`; the newer wins. Ties broken by lexicographically-larger `file_cid` (deterministic, content-derived). The loser is **always** written as a conflict copy (`<name>.conflict-<node-short>-<unixsecs><ext>`) — LWW never silently destroys data. This is stricter than today's `watch` (which silently overwrites).
- **`copy`:** never overwrite on conflict; both sides keep their version, the incoming one lands as a `.conflict-…` copy and is surfaced in output. Convergence is manual.
- **`crdt`:** for paths whose extension is in a registered set (`.md`, `.txt`, `.note`, configurable), perform a 3-way merge using the **shared CRDT engine from Notes** (see §9). Both replicas converge with no conflict copy. Non-registered extensions fall back to `lww`.

Conflict detection requires `base_cid`, which requires the initiator to know the receiver's last-acked state — that is exactly `remote_seen` in the index, maintained from `commit` acks and `list` reconciles. In push-only (non-bidir) mode there is no concurrent remote writer by assumption, so LWW-by-mtime with conflict-copy-on-mismatch is the safety net.

## 8. How it composes CE primitives (and what changes in the node)

| Need | CE primitive used | Where |
|---|---|---|
| Move chunk bytes, dedup, self-replicate, verify | content-addressed **blob store** + mesh fetch-by-hash (data-layer Stage 2) | `ce-rs` `put_blob`/`get_blob`; chunking via `ce-rs::data` `chunk_object`/`reassemble`/`cid` |
| Control plane (have/commit/delete/list) | **`AppRequest`** directed request/reply | `ce-rs` `request`/`reply`; server polls `messages()` (or SSE `/mesh/messages/stream`) |
| Authorize every mutation | **`ce-cap`** signed attenuating chain | `ce_cap::authorize(...)`, `decode_chain`, `path_prefix` caveat + revoked-set — reuse rdev's `handle_inner` |
| Authenticate the peer | mesh-verified `AppMessage.from` | already trusted by rdev's `serve` |
| Address a target without ip:port | NodeId hex / config alias / claimed name | `resolve`; optionally `resolve_name` |

**Node changes required: NONE.** Every primitive above already ships. Auto-Sync is pure app/SDK code in the `rdev` repo. The only "new ability" is an optional read direction for bidirectional pull: the receiver must serve `rdev/sync2/list` and let the initiator `get_blob` its chunks. `get_blob` is unauthenticated-read on the local node already; the *list* verb is gated by a new opaque ability string `"sync-read"` (opaque strings are how `ce-cap` works), granted via `ce grant <id> --can sync,delete,sync-read`. No verifier change — abilities are arbitrary strings.

### One optional, non-blocking node-side nicety (explicitly deferred)
Today `serve` *polls* `messages()` every 500 ms. For lower-latency sync the daemon should subscribe to `GET /mesh/messages/stream` (SSE) instead of polling — but the SDK does not yet wrap that stream. This is an `ce-rs` SDK addition (a `messages_stream()` method), **not a node change**, and is milestone 5 (polling works for v1).

## 9. Relationship to Notes (shared CID/delta machinery)

Notes and Auto-Sync share the **same lower half**: `ce-rs::data` chunking/CID/manifest + the blob store as the byte transport, and the **same CRDT engine** for text convergence. Concretely:

- Factor the chunk-delta engine into a small reusable module **`rdev::delta`** (or a tiny shared crate `ce-sync-core`): `plan_transfer(local_manifest, remote_have) -> missing`, `upload_missing`, `commit`, `apply_commit_verified`. Notes uses the identical path to ship encrypted attachment blobs by CID (data-layer Stage 1–2), and reuses `reassemble`'s per-chunk verification.
- The **CRDT merge** used by `--conflict crdt` is the *same* library Notes standardizes on (the Notes workstream selects Yjs-equivalent; in Rust, **Loro** or **yrs** behind a `TextDoc` trait). Auto-Sync calls `TextDoc::merge(base, local, remote) -> merged_bytes`. For Notes the CRDT *is* the file format; for Auto-Sync it is invoked only on conflict for registered text types. Sharing one `TextDoc` impl means a `.note` edited via the Notes app and synced via Auto-Sync converge identically.

This makes Auto-Sync the **"dumb files over CID-delta"** consumer and Notes the **"smart CRDT docs over CID-delta"** consumer of one engine. Build the engine here (file sync has simpler crypto needs — no E2E envelope), let Notes layer encryption on top.

## 10. Milestones

See structured `milestones`. Sequencing: M1 (index+ceignore) and M2 (delta protocol) are the core and unblock everything; M3 (resume) hardens; M4 (bidir+conflict) adds the hard semantics; M5 (CRDT+SSE+polish) shares with Notes.

## 11. Testing strategy

- **Pure unit (no infra):** `.ceignore` matching incl. negation/anchoring; index serialize/round-trip + crash-safe write (temp+rename); `(size,mtime)` skip logic; `plan_transfer` missing-set computation; conflict resolution decision table (LWW tie-break determinism, conflict-copy naming). These mirror rdev's existing pure tests (`fs_*`, `skip_rules`).
- **Capability tests:** reuse rdev's `handle_inner` test pattern — self-issued cap authorizes `sync2/commit`; wrong audience/expired/non-rooted/missing-`sync-read` denied; `path_prefix` caveat blocks out-of-tree commit; `..` traversal rejected (the `fs_action` guards apply to `sync2/commit`'s `path` too).
- **Two-node integration (in-process, `NEXT_PORT` pattern like ce-node):** spin two nodes, run `syncd` one way; assert (a) one-byte edit transfers exactly one chunk (`put_blob` call count), (b) dedup: identical file at two paths uploads chunks once, (c) resume: kill after `put_blob`/before `commit`, restart, file converges with zero extra uploads, (d) bidir conflict → both keep data, conflict copy present, (e) delete propagates + is idempotent.
- **Delta-over-mesh:** assert a chunk absent on the receiver is pulled via the existing mesh fetch-by-hash path (reuse the data-layer `blob_fetched_across_mesh` harness), proving Auto-Sync needs no new transport.
- **CRDT:** concurrent `.md` edits on two replicas converge byte-identical via `TextDoc::merge` (shared with Notes' test corpus).
- **Cross-platform:** CI matrix already builds macOS/Linux/Windows; `notify` backend smoke test per OS (fsevents/inotify/RDCW event delivery + the debounce window).

## 12. Risks

See structured `risks`.


## Milestones

| Milestone | Deliverable | Effort |
|---|---|---|
| M1 — Index + .ceignore + reconcile | Persistent crash-safe sync index (~/.local/share/rdev/sync/<session>.idx) with (size,mtime) fast-skip and cached chunk CIDs; `.ceignore` via the `ignore` crate with built-in defaults; `rdev syncd --once` push-only reconcile that diffs index vs walk and pushes only changed files (still whole-file via existing rdev/sync). Unit tests for ignore + index. | M |
| M2 — Content-addressed delta protocol | New rdev/sync2/have|commit|delete|list verbs over AppRequest; client chunks via ce-rs::data, uploads only missing chunks via put_blob, commits manifests; server authorizes via ce-cap, reassembles+verifies via get_blob, atomic temp+rename write. Factor reusable rdev::delta module. Two-node integration: one-byte edit = one chunk, dedup verified. | L |
| M3 — Continuous watch + debounce + resume | Long-running `rdev syncd` with notify watcher, 500ms debounce/batch, full resumability (interrupt-before-commit re-converges with zero extra uploads), graceful Ctrl-C, structured stderr output per ce/docs/design.md. Deprecate `rdev watch` as an alias. | M |
| M4 — Bidirectional + conflict engine | `--bidirectional` (sync2/list reconcile + get_blob pulls, gated by new `sync-read` ability); conflict detection via base_cid; LWW (mtime + cid tiebreak, always conflict-copy the loser) and `copy` policies. Conflict-copy naming + tests for the decision table and concurrent-write convergence. | L |
| M5 — CRDT merge, SSE transport, polish | `--conflict crdt` for registered text extensions using the shared TextDoc engine (Loro/yrs) co-developed with Notes; switch serve from polling to SSE via a new ce-rs messages_stream(); --json event stream; --dry-run; docs at rdev/docs/autosync.md and CLAUDE.md update. | M |


## Risks

- Receiver blob-store retention: get_blob relies on chunks being present locally or mesh-fetchable. If the initiator's node garbage-collects or never gained the chunk before the receiver pulls, commit stalls. Mitigation: initiator put_blob the chunk before commit (it then self-announces via Stage 2 DHT provider records); add a commit-time `have` re-check and a bounded retry. No GC of recently-uploaded chunks exists yet — confirm blob-store lifetime semantics in ce-node.
- mtime-based LWW is wall-clock dependent; clock skew between machines can pick the wrong winner. Conflict-copy-on-mismatch prevents data loss but may surprise users. The deterministic cid tiebreak only fires on exact mtime ties. Document clearly; consider a logical version counter in v2.
- notify backend quirks: editors that write-rename (vim, VS Code atomic save) emit create/delete rather than modify; large recursive trees can exhaust inotify watches on Linux (fs.inotify.max_user_watches). Mitigation: handle rename pairs as a single change, fall back to periodic rescan on watcher overflow, surface the inotify-limit error with the sysctl fix.
- Bidirectional sync without a single writer is genuinely hard; this design uses last-acked remote_seen as the conflict base rather than vector clocks, which can mis-detect concurrency under rapid two-sided churn. Acceptable for the dev-folder + notes use cases; true multi-writer needs the CRDT path (or per-file version vectors) — scoped to text via the shared engine, not general binaries.
- Shared CRDT engine coupling with Notes: if Notes' library choice (Loro vs yrs) slips, M5's crdt conflict mode slips with it. Mitigation: gate CRDT behind a TextDoc trait so M1–M4 ship independently; lww/copy cover all file types without it.
- Polling messages() at 500ms bounds sync latency and can drop messages under load (the ring is best-effort/capped per the SDK doc). For a busy watched tree this risks missed commits. Mitigation: idempotent verbs + reconcile-on-start recover any miss; M5's SSE messages_stream() removes the polling ceiling.
