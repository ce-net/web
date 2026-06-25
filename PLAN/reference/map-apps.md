Perfect! Now let me output the final report:

---

# CE Apps Mapping & Patterns — Complete Analysis

I have completed a comprehensive mapping of the existing CE applications. The full 949-line markdown document is available at `/tmp/ce-apps-mapping.md`.

## Executive Summary

Three production-grade applications demonstrate CE's primitives-vs-apps boundary:

### **1. swarm** — Distributed Work Scheduler
- **Role**: Client-only app that discovers hosts via atlas, ranks them by on-chain reputation, and fans work across N hosts in parallel
- **Primitives**: `CeClient::atlas()`, `CeClient::history()`, `CeClient::request()` (via rdev/exec)
- **Reusable patterns**: Host selection/ranking, scatter/gather concurrency, result tallying (group by answer, detect minority divergence)
- **Status**: Production-ready ✅

### **2. rdev** — Remote-Dev Exec + Sync
- **Role**: Server-client pair for containerized execution, file push/delete, and **continuous folder mirroring**
- **Primitives**: `AppRequest`/`reply`, `ce-cap` authorization, `ce-container` exec
- **Protocol**: Four actions over mesh topics: `rdev/exec`, `rdev/sync`, `rdev/delete`, `rdev/spawn`
- **Watch implementation**: Initial full sync + inotify/fsevents file watching + 250ms event batching + incremental push/delete
- **Reusable patterns**: Polling message loop, capability verification with path-prefix caveat, path traversal defense, skip filtering
- **Status**: Core production-ready; watch needs `.ceignore` support ✅→⚠️

### **3. replicator** — Self-Replicating Fleet Bootstrapper
- **Role**: Orchestrate recursive replication with attenuating capabilities so each replica gets weaker authority than its parent
- **Primitives**: `AppRequest`, `ce-cap` delegation, `ce-identity` signing
- **Reusable patterns**: Pure attenuation logic (abilities, expiry, no escalation), chain extension, distributed tree orchestration
- **Status**: Production-ready ✅

---

## rdev Watch: What Exists vs. What's Missing

### ✅ Exists (Production-Grade)
- **Initial sync**: Walk entire directory tree, skip hardcoded patterns, push all files in one pass
- **File watching**: Cross-platform via `notify` crate (fsevents on macOS, inotify on Linux)
- **Event batching**: Collect changes over 250ms window to coalesce rapid edits
- **Incremental actions**: Push each modified file, send delete for removed files
- **Error handling**: Warn on individual failures, continue watching
- **Shutdown**: Graceful Ctrl-C handling
- **Path safety**: Reject `..`, enforce path_prefix caveat, canonicalize to prevent escapes

### ⚠️ Missing for Enterprise Auto-Sync
| Feature | Workaround |
|---------|-----------|
| **.ceignore file support** | Currently hardcoded only (target/, .git, node_modules, .DS_Store, etc.); full gitignore-style format planned |
| **Conflict resolution** | Last-write-wins (data loss if both local and remote change); no tombstone tracking |
| **Large files** | Inline hex encoding in JSON; blocks files >100MB; chunked transfer via `put_object` is planned |
| **Retry with backoff** | Transient failures fail immediately; exponential backoff not implemented |
| **SSE subscription** | Polling interval is 500ms; switch to `/mesh/messages/stream` is a planned refinement |

### Recommended Production Path
1. **Add `.ceignore`** — Use `ignore` crate, watch for changes to `.ceignore` itself
2. **Switch to SSE** — Subscribe to message stream instead of polling
3. **Chunked transfer** — Use existing `ce-rs::put_object()`/`get_object()` for large files
4. **Add retry logic** — Exponential backoff for transient network failures

---

## Core CE Primitives

### 1. Mesh Transport: `AppRequest`/`reply`
- **Location**: `ce-rs::CeClient` — methods `request()`, `reply()`, `messages()`
- **Pattern**: Apps choose topic names (e.g., `rdev/exec`, `swarm/task`), send JSON payloads hex-encoded, apps poll `/mesh/messages` and respond via `reply_token`
- **Timeout**: Configurable per-request (swarm uses 600s for exec, 30s for file ops)

### 2. Capability Authorization: `ce-cap`
- **Primitive**: Ed25519-signed chains with attenuation (abilities, expiry, path_prefix caveats)
- **Root trust**: Host itself OR configured org roots (`$RDEV_ROOTS`)
- **Enforce**: Every action calls `ce_cap::authorize()`; on-chain revocation set checked every ~10s
- **Attenuation rule**: Child privileges ⊆ Parent privileges; no escalation possible

### 3. Host Discovery: `atlas`
- **Query**: `ce.atlas().await` → `Vec<AtlasEntry>` with node_id, cpu_cores, mem_mb, running_jobs, tags
- **Pattern**: Filter by tag (e.g., `has_tag("gpu")`), rank by reputation (`ce.history().delivered_work()`), select top N

### 4. Container Execution: `ce-container`
- **Sandbox**: gVisor isolation + CPU/memory limits + network off + read-only host binaries
- **Mount**: Writable `/work` directory from user's home
- **Used by**: rdev/exec, swarm jobs

### 5. File Storage: Content-Addressed Blobs (ce-rs)
- **Single files**: `put_blob()` / `get_blob()` (already used by rdev, good for small files)
- **Large objects**: `put_object()` / `get_object()` (chunked, verified against CID) — planned for rdev large files

---

## Reusable Patterns — Ready to Borrow

### Host Selection
```rust
let pool = ce.atlas().await?;
let mut scored = Vec::new();
for h in pool.into_iter().filter(|h| h.has_tag("docker")) {
    let rep = ce.history(&h.node_id).await.map(|r| r.delivered_work()).unwrap_or(0);
    scored.push((rep, h));
}
scored.sort_by(|a, b| b.0.cmp(&a.0));
scored.truncate(count);
```

### Scatter/Gather over AppRequest
```rust
let mut set = JoinSet::new();
for target in targets {
    set.spawn(ce.request(&target, topic, payload, timeout_ms));
}
while let Some(result) = set.join_next().await { /* collect */ }
```

### Capability Verification
```rust
let chain = decode_chain(&req.caps)?;
authorize(host_id, roots, &[], now(), &sender_id, "action", &chain, &is_revoked)?;
// If Ok: proceed; else: deny with error
```

### Message Polling Server
```rust
loop {
    for msg in ce.messages().await? {
        if msg.reply_token.is_none() { continue; }
        let resp = handle(&msg);
        ce.reply(msg.reply_token.unwrap(), &serialize(resp)?).await?;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
}
```

### File Watch + Sync
```rust
// Initial full sync
for entry in WalkDir::new(&root) { /* push files */ }

// Watch for changes
let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
let watcher = notify::recommended_watcher(move |e| { let _ = tx.send(e); })?;
watcher.watch(&root, RecursiveMode::Recursive)?;

// Batch events, sync incremental changes
loop {
    let mut paths = rx.recv().await?.paths;
    // Collect more events for 250ms
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_millis(250), rx.recv()).await {
        paths.extend(e.paths);
    }
    for p in paths { /* push_file or delete */ }
}
```

---

## New App Template

```
myapp/
├── Cargo.toml                          # deps: ce-rs, ce-cap, tokio, serde, clap
├── src/main.rs                         # CLI + server + client logic
├── README.md                           # Use, design, protocol spec
└── tests/integration.rs                # E2E sketch
```

**Checklist**:
- [ ] Define request/reply JSON shapes per action
- [ ] Model capabilities needed (abilities, path_prefix, etc.)
- [ ] Config storage (file, env var, CLI flag)
- [ ] Use `CeClient::request()` for client → server
- [ ] Poll `CeClient::messages()` in server loop
- [ ] Call `ce_cap::authorize()` before every action
- [ ] Path traversal checks (reject `..`, canonicalize)
- [ ] Unit tests for business logic (pure functions)
- [ ] Integration test sketch (may require Docker)

---

## Key Files & Locations

| Component | File | Key Functions |
|-----------|------|---|
| **swarm** | `/Users/07lead01/ce-net/swarm/src/main.rs` | `candidates()`, `select_hosts()`, `scatter()`, `tally()` |
| **rdev** | `/Users/07lead01/ce-net/rdev/src/main.rs` | `watch()` (282–343), `handle_inner()` (auth), `fs_action()`, `spawn_action()` |
| **replicator** | `/Users/07lead01/ce-net/replicator/src/main.rs` | `onward_abilities()`, `attenuate()`, `delegate()`, `replicate_to()` |
| **ce-rs SDK** | `/Users/07lead01/ce-net/ce-rs/src/lib.rs` | `CeClient::request()`, `reply()`, `messages()`, `atlas()`, `history()` |

---

The full document (949 lines) covers: primitive definitions, app architectures, CLI surfaces, protocol definitions, request/reply shapes, capability handling, testing patterns, security considerations, and a complete new-app checklist. Ready for new apps to reuse established patterns and avoid wheel-reinvention.