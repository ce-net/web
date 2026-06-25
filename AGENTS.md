
## 2026-06-24 — ce versioning + release (claude/mesh-fix)
Root-caused the dead mesh: nodes ran builds weeks apart but all reported "0.1.0", so every mesh
stream silently EOF'd (protocol drift). Fixes:
- `ce/build.rs` stamps git SHA + date into `ce --version` (drift now visible). main.rs version line updated.
- Bumped ce to 0.1.1, tagged v0.1.1 -> CI release workflow builds all targets + publishes (install.sh now works).
- NEXT: update every node (Mac/relay/Debian) to v0.1.1 via install.sh, restart, verify mesh syncs.
Please don't push another ce tag until the v0.1.1 fleet update is verified. The node mesh actor also
crashed on the Mac ("mesh actor gone") — a restart fixed it; watch for recurrence (possible node bug).

## 2026-06-25 — mesh-app foundation shipped (claude/mesh-foundation)
Built + shipped the "real mesh app" foundation (all on each repo's main, Leif-authored, relay-tested):
- ce-rs: `ce_rs::serve` (be a service), `serve_where` (prefix/predicate topics), `ce_rs::locate`
  (discover+select a live instance over the mesh: trust/capacity/recency rank, beacon tiebreak,
  fault-domain spread, `call()` failover, `register()` heartbeat), and `netgraph()` (RTT primitive).
  Feature-gated `serve` / `locate`. ce-rs ALSO already wraps `messages_stream()`.
- ce-fn migrated to the shared serve loop. ce-bucket = NEW repo (geo/owner-diverse replicated bucket
  storage = ce-storage namespace x ce-pin replication). ce-gke gained `depends_on` + compose stacks
  (topo-sort/cycle-detect, dep resolution via locate). ce-bench NodeProfile.network axis; ce-sched
  browser-WASM runtime-kind penalty + prefer-local; node.html browser nodes self-identify kind=Browser.

rdev NOTE: I deliberately did NOT touch rdev — you're actively on it (remote-build). The serve()
M5 TODO is now UNBLOCKED: ce-rs has `messages_stream()` + `serve::serve_where`. When you want it,
the 500ms `messages()` poll in serve() can become:
  `ce_rs::serve::serve_where(&ce, &[], |t| t.starts_with("rdev/"), &handler, shutdown).await`
with the per-topic dispatch (sync2/run/generic) + lazy revoked-refresh moved into a Handler impl
(see ce-fn/src/serve.rs InvokeHandler for the exact pattern). Left to rdev's owner to avoid conflict.
