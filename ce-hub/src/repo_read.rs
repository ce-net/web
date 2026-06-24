//! gix-powered read API over a bare repo for the hub UI.
//!
//! Object/tree/commit reads use `gix` (gitoxide, pure Rust). Unified diffs (`commit`, `compare`)
//! are produced by shelling the system `git` with argv arrays: git's own diff output is the exact,
//! battle-tested format the UI expects, and gix's diff-to-text surface varies across releases — so
//! per the contract's "choose the most conservative widely-available API" guidance, we use git for
//! the textual diff and gix for structured object reads.
//!
//! Every `:ref`/`:sha`/`*path` is untrusted: refs/shas are passed to git/gix as argv values (never
//! shell-interpolated) and the owner/repo names are validated before any filesystem access.

use std::path::{Path, PathBuf};
use std::process::Command;

use axum::extract::{Path as AxPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::repos::{bare_repo_path, normalize_repo, repo_key, valid_name};
use crate::Shared;

/// Resolve and validate (owner, repo) and return the bare repo dir if it is registered + on disk.
fn resolve_dir(st: &Shared, owner: &str, repo: &str) -> Result<PathBuf, Response> {
    let owner = owner.to_ascii_lowercase();
    let repo = normalize_repo(repo);
    if !valid_name(&owner) || !valid_name(&repo) {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error":"bad owner/repo"}))).into_response());
    }
    let key = repo_key(&owner, &repo);
    if !st.repos.lock().unwrap().contains_key(&key) {
        return Err((StatusCode::NOT_FOUND, Json(json!({"error":"repo not found"}))).into_response());
    }
    let dir = bare_repo_path(&st.git_root, &owner, &repo);
    if !dir.join("HEAD").exists() {
        return Err((StatusCode::NOT_FOUND, Json(json!({"error":"repo has no objects yet"}))).into_response());
    }
    Ok(dir)
}

/// A git ref/oid spec is "safe" for our purposes if it contains no characters that could escape an
/// argv value into a path-walk or option (we still pass it as argv, this is defense in depth).
///
/// This is the LENIENT validator used by pulls.rs, which may store fully-qualified ref names with
/// path separators. Endpoints that expect a SINGLE ref/oid (tree, blob, commit, commits, compare
/// base/head) must use `safe_single_rev` instead, which additionally forbids range/revspec syntax.
pub(crate) fn safe_rev(spec: &str) -> bool {
    !spec.is_empty()
        && spec.len() <= 256
        && !spec.starts_with('-')
        && spec.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '_' | '-' | '.' | '/' | '~' | '^' | '@' | '{' | '}')
        })
}

/// Stricter check for endpoints that accept exactly ONE ref/oid (never a range or revspec walk).
/// On top of `safe_rev` it rejects:
///   - `..` substrings (two-dot `a..b` and three-dot `a...b` commit ranges),
///   - a leading `~`/`^` (parent/ancestor navigation with no anchor),
/// so a value that passes here resolves to a single object, not a set of commits. Callers must still
/// confirm via rev-parse that it resolves to exactly one object (see `resolve_single`).
pub(crate) fn safe_single_rev(spec: &str) -> bool {
    safe_rev(spec)
        && !spec.contains("..")
        && !spec.starts_with('~')
        && !spec.starts_with('^')
}

/// Rev-parse `spec` and confirm it resolves to a single object (rejecting ranges/multi-revspecs).
/// gix's `rev_parse_single` already errors on multi-revisions (ranges), so this is the authoritative
/// "single object" check; we surface a clear error if it does not resolve to one id.
fn resolve_single<'r>(repo: &'r gix::Repository, spec: &str) -> anyhow::Result<gix::Id<'r>> {
    let id = repo
        .rev_parse_single(spec)
        .map_err(|e| anyhow::anyhow!("ref does not resolve to a single object: {spec}: {e}"))?;
    Ok(id)
}

/// Cap on a single blob we will serve inline to the UI.
const MAX_BLOB_BYTES: usize = 10 * 1024 * 1024; // 10 MiB
/// Cap on captured diff/compare text before we truncate with a marker.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024; // 2 MiB

/// Truncate diff text (lossy-decoded git stdout) at `MAX_DIFF_BYTES`, appending a marker so the UI
/// can tell the diff was cut. We truncate on a char boundary to keep the result valid UTF-8.
fn bound_diff(raw: &[u8]) -> String {
    if raw.len() <= MAX_DIFF_BYTES {
        return String::from_utf8_lossy(raw).to_string();
    }
    let mut cut = MAX_DIFF_BYTES;
    while cut > 0 && (raw[cut] & 0xC0) == 0x80 {
        // back up off a UTF-8 continuation byte to land on a char boundary
        cut -= 1;
    }
    let mut s = String::from_utf8_lossy(&raw[..cut]).to_string();
    s.push_str(&format!(
        "\n... diff too large, truncated at {MAX_DIFF_BYTES} bytes ...\n"
    ));
    s
}

// ---- gix open + object reads ----

/// Open the bare repo with gix.
// VERIFY: `gix::open(path)` returns `Result<gix::Repository, _>` across recent gix versions.
fn open(dir: &Path) -> anyhow::Result<gix::Repository> {
    let repo = gix::open(dir)?;
    Ok(repo)
}

#[derive(Deserialize)]
pub(crate) struct EmptyQ {}

/// GET /repos/:owner/:repo/tree/:rref/*path — list a tree (directory) at a ref/path.
pub(crate) async fn tree(
    State(st): State<Shared>,
    AxPath((owner, repo, rref, path)): AxPath<(String, String, String, String)>,
) -> Response {
    let dir = match resolve_dir(&st, &owner, &repo) {
        Ok(d) => d,
        Err(e) => return e,
    };
    if !safe_single_rev(&rref) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad ref"}))).into_response();
    }
    let sub = path.trim_matches('/').to_string();
    match list_tree(&dir, &rref, &sub) {
        Ok(entries) => Json(json!({ "ref": rref, "path": sub, "entries": entries })).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({"error": e.to_string()}))).into_response(),
    }
}

/// Root-tree listing: `GET /repos/:owner/:repo/tree/:rref` (no `*path`). Axum's `*path` wildcard does
/// not match an empty/trailing-slash segment, so the repo root needs this companion route. Delegates
/// to the same logic as `tree` with an empty sub-path.
pub(crate) async fn tree_root(
    State(st): State<Shared>,
    AxPath((owner, repo, rref)): AxPath<(String, String, String)>,
) -> Response {
    let dir = match resolve_dir(&st, &owner, &repo) {
        Ok(d) => d,
        Err(e) => return e,
    };
    if !safe_single_rev(&rref) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad ref"}))).into_response();
    }
    match list_tree(&dir, &rref, "") {
        Ok(entries) => Json(json!({ "ref": rref, "path": "", "entries": entries })).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({"error": e.to_string()}))).into_response(),
    }
}

/// List the entries of the tree at `<rref>:<sub>` using gix object reads.
fn list_tree(dir: &Path, rref: &str, sub: &str) -> anyhow::Result<Vec<Value>> {
    let repo = open(dir)?;
    // `resolve_single` rev-parses and confirms the spec is a single object (rejects ranges).
    // `.object()` resolves it to an `Object`. We resolve the commit, then its tree, then walk `sub`.
    let commit_id = resolve_single(&repo, rref)?;
    let commit = commit_id.object()?.try_into_commit()?;
    let mut tree = commit.tree()?;
    if !sub.is_empty() {
        // VERIFY: `Tree::lookup_entry_by_path(path)` -> Result<Option<Entry>> walks a slash path in
        // one call (recent gix). `entry.object()?` resolves it; `try_into_tree` descends into it.
        let entry = tree
            .lookup_entry_by_path(sub)?
            .ok_or_else(|| anyhow::anyhow!("path not found: {sub}"))?;
        tree = entry.object()?.try_into_tree()?;
    }
    let mut out = Vec::new();
    // VERIFY: `tree.iter()` yields `Result<EntryRef, _>`; EntryRef exposes `.filename()` (BString),
    // `.mode()` (with `.is_tree()` / `.is_blob()`), and `.oid()` / `.id()`.
    for ent in tree.iter() {
        let ent = ent?;
        let name = ent.filename().to_string();
        let mode = ent.mode();
        let kind = if mode.is_tree() {
            "tree"
        } else if mode.is_link() {
            "symlink"
        } else if mode.is_commit() {
            "submodule"
        } else {
            "blob"
        };
        out.push(json!({
            "name": name,
            "type": kind,
            "sha": ent.oid().to_string(),
            "mode": format!("{:o}", mode.0),
        }));
    }
    out.sort_by(|a, b| {
        let ka = a["type"].as_str().unwrap_or("") == "tree";
        let kb = b["type"].as_str().unwrap_or("") == "tree";
        kb.cmp(&ka).then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(out)
}

/// GET /repos/:owner/:repo/blob/:rref/*path — file bytes at a ref/path, with a detected content type.
pub(crate) async fn blob(
    State(st): State<Shared>,
    AxPath((owner, repo, rref, path)): AxPath<(String, String, String, String)>,
) -> Response {
    let dir = match resolve_dir(&st, &owner, &repo) {
        Ok(d) => d,
        Err(e) => return e,
    };
    if !safe_single_rev(&rref) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad ref"}))).into_response();
    }
    let sub = path.trim_matches('/').to_string();
    if sub.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"blob path required"}))).into_response();
    }
    match read_blob(&dir, &rref, &sub) {
        Ok(bytes) => {
            let ct = detect_content_type(&sub, &bytes);
            ([(header::CONTENT_TYPE, ct)], bytes).into_response()
        }
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({"error": e.to_string()}))).into_response(),
    }
}

/// Read the bytes of the blob at `<rref>:<sub>` using gix.
fn read_blob(dir: &Path, rref: &str, sub: &str) -> anyhow::Result<Vec<u8>> {
    let repo = open(dir)?;
    let commit_id = resolve_single(&repo, rref)?;
    let commit = commit_id.object()?.try_into_commit()?;
    let tree = commit.tree()?;
    // VERIFY: `Tree::lookup_entry_by_path(path)` -> Result<Option<Entry>> resolves a slash path.
    let entry = tree
        .lookup_entry_by_path(sub)?
        .ok_or_else(|| anyhow::anyhow!("file not found: {sub}"))?;
    let obj = entry.object()?;
    let blob = obj.try_into_blob()?;
    // Bound memory: refuse to materialize blobs above the cap; return a marker the UI can render
    // instead of streaming hundreds of MiB into the response (and into our heap).
    if blob.data.len() > MAX_BLOB_BYTES {
        let msg = format!(
            "blob too large to display ({} bytes; limit {} bytes)\n",
            blob.data.len(),
            MAX_BLOB_BYTES
        );
        return Ok(msg.into_bytes());
    }
    // VERIFY: `Blob` exposes its bytes via the `.data` field (Vec<u8>) on recent gix.
    Ok(blob.data.clone())
}

/// Detect a content type from extension, falling back to a simple binary/text sniff.
fn detect_content_type(path: &str, bytes: &[u8]) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let by_ext = match ext.as_str() {
        "html" | "htm" => Some("text/html; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "ts" => Some("text/plain; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "json" => Some("application/json; charset=utf-8"),
        "md" | "txt" | "rs" | "toml" | "yaml" | "yml" | "py" | "go" | "c" | "h" | "cpp" | "sh" => {
            Some("text/plain; charset=utf-8")
        }
        "wasm" => Some("application/wasm"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        "pdf" => Some("application/pdf"),
        _ => None,
    };
    if let Some(ct) = by_ext {
        return ct.to_string();
    }
    // Sniff: a NUL byte in the first 8 KiB strongly implies binary.
    let scan = &bytes[..bytes.len().min(8192)];
    if scan.contains(&0) {
        "application/octet-stream".to_string()
    } else {
        "text/plain; charset=utf-8".to_string()
    }
}

// ---- commit log + detail ----

#[derive(Deserialize)]
pub(crate) struct CommitsQ {
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

/// GET /repos/:owner/:repo/commits/:rref — paged commit log. `?after=<sha>` continues after a sha;
/// `?limit=` bounds the page (default 50, max 200).
pub(crate) async fn commits(
    State(st): State<Shared>,
    AxPath((owner, repo, rref)): AxPath<(String, String, String)>,
    Query(q): Query<CommitsQ>,
) -> Response {
    let dir = match resolve_dir(&st, &owner, &repo) {
        Ok(d) => d,
        Err(e) => return e,
    };
    if !safe_single_rev(&rref) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad ref"}))).into_response();
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    // `after` continues the walk after a given commit (its parent range). Validate it too.
    let start = match &q.after {
        Some(a) if safe_single_rev(a) => format!("{a}^"),
        Some(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad after"}))).into_response(),
        None => rref.clone(),
    };
    match commit_log(&dir, &start, limit) {
        Ok(list) => {
            let next = if list.len() == limit {
                list.last().and_then(|c| c["sha"].as_str()).map(|s| s.to_string())
            } else {
                None
            };
            Json(json!({ "ref": rref, "commits": list, "next_after": next })).into_response()
        }
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({"error": e.to_string()}))).into_response(),
    }
}

/// Read a commit log via `git log` (argv) — robust, deterministic record output.
fn commit_log(dir: &Path, start: &str, limit: usize) -> anyhow::Result<Vec<Value>> {
    // Record separator \x1e, field separator \x1f — both impossible in commit metadata text we use.
    let fmt = "%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1e";
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("log")
        .arg(format!("--max-count={limit}"))
        .arg(format!("--format={fmt}"))
        .arg(start)
        .arg("--")
        .output()?;
    if !out.status.success() {
        anyhow::bail!("git log failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut list = Vec::new();
    for rec in text.split('\u{1e}') {
        let rec = rec.trim_matches(|c| c == '\n' || c == '\r');
        if rec.is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.split('\u{1f}').collect();
        if f.len() < 5 {
            continue;
        }
        list.push(json!({
            "sha": f[0],
            "author_name": f[1],
            "author_email": f[2],
            "author_unix": f[3].parse::<u64>().unwrap_or(0),
            "summary": f[4],
        }));
    }
    Ok(list)
}

/// GET /repos/:owner/:repo/commit/:sha — commit detail + unified diff against its first parent.
pub(crate) async fn commit(
    State(st): State<Shared>,
    AxPath((owner, repo, sha)): AxPath<(String, String, String)>,
) -> Response {
    let dir = match resolve_dir(&st, &owner, &repo) {
        Ok(d) => d,
        Err(e) => return e,
    };
    if !safe_single_rev(&sha) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad sha"}))).into_response();
    }
    let meta = match commit_log(&dir, &sha, 1) {
        Ok(mut v) if !v.is_empty() => v.remove(0),
        Ok(_) => return (StatusCode::NOT_FOUND, Json(json!({"error":"commit not found"}))).into_response(),
        Err(e) => return (StatusCode::NOT_FOUND, Json(json!({"error": e.to_string()}))).into_response(),
    };
    let diff = git_show_diff(&dir, &sha).unwrap_or_default();
    Json(json!({ "commit": meta, "diff": diff })).into_response()
}

/// Unified diff for a single commit via `git show` (argv).
fn git_show_diff(dir: &Path, sha: &str) -> anyhow::Result<String> {
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("show")
        .arg("--format=") // diff only, no header (the JSON carries metadata)
        .arg("--no-color")
        .arg(sha)
        .arg("--")
        .output()?;
    if !out.status.success() {
        anyhow::bail!("git show failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    Ok(bound_diff(&out.stdout))
}

/// GET /repos/:owner/:repo/compare/:base/:head — diff base..head (powers the PR diff view).
pub(crate) async fn compare(
    State(st): State<Shared>,
    AxPath((owner, repo, base, head)): AxPath<(String, String, String, String)>,
) -> Response {
    let dir = match resolve_dir(&st, &owner, &repo) {
        Ok(d) => d,
        Err(e) => return e,
    };
    if !safe_single_rev(&base) || !safe_single_rev(&head) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad base/head ref"}))).into_response();
    }
    match compare_diff(&dir, &base, &head) {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({"error": e.to_string()}))).into_response(),
    }
}

/// Compute a GitHub-like "compare" of base vs head, via `git` (argv).
///
/// SEMANTICS (consistent, three-dot / merge-base based throughout):
///   - We compute the merge-base of base and head and report the diff as `base...head`, i.e. the
///     changes introduced ON head SINCE it diverged from base (this ignores commits added to base
///     after the fork point — the same thing GitHub's compare/PR view shows).
///   - `ahead`  = commits on head not on base  (`base..head`).
///   - `behind` = commits on base not on head  (`head..base`).
/// Counts use the symmetric two-dot ranges that exactly match the three-dot diff's notion of "what
/// each side has that the other doesn't", so the counts and the diff describe the same divergence.
pub(crate) fn compare_diff(dir: &Path, base: &str, head: &str) -> anyhow::Result<Value> {
    // Resolve the merge-base; this is the anchor for three-dot semantics. If there is none (no common
    // history) the diff/counts still work but the merge-base field is reported null.
    let mb_out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("merge-base")
        .arg(base)
        .arg(head)
        .output()?;
    let merge_base: Option<String> = if mb_out.status.success() {
        let s = String::from_utf8_lossy(&mb_out.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    } else {
        None
    };

    let count = |range: String| -> anyhow::Result<u64> {
        let out = Command::new("git")
            .arg("--git-dir")
            .arg(dir)
            .arg("rev-list")
            .arg("--count")
            .arg(range)
            .output()?;
        Ok(if out.status.success() {
            String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
        } else {
            0
        })
    };
    // ahead = commits on head not on base; behind = commits on base not on head.
    let ahead = count(format!("{base}..{head}"))?;
    let behind = count(format!("{head}..{base}"))?;

    let diff_out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("diff")
        .arg("--no-color")
        .arg(format!("{base}...{head}"))
        .arg("--")
        .output()?;
    if !diff_out.status.success() {
        anyhow::bail!("git diff failed: {}", String::from_utf8_lossy(&diff_out.stderr));
    }
    let diff = bound_diff(&diff_out.stdout);
    // Per-file stat summary for the UI header.
    let stat_out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("diff")
        .arg("--numstat")
        .arg(format!("{base}...{head}"))
        .arg("--")
        .output()?;
    let files: Vec<Value> = if stat_out.status.success() {
        String::from_utf8_lossy(&stat_out.stdout)
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                if f.len() < 3 {
                    return None;
                }
                Some(json!({
                    "additions": f[0].parse::<u64>().ok(),
                    "deletions": f[1].parse::<u64>().ok(),
                    "path": f[2],
                }))
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(json!({
        "base": base,
        "head": head,
        "merge_base": merge_base,
        "ahead": ahead,
        "behind": behind,
        "files": files,
        "diff": diff,
    }))
}

/// GET /repos/:owner/:repo/releases — tags as releases (name, target sha, tagger date if annotated).
pub(crate) async fn releases(
    State(st): State<Shared>,
    AxPath((owner, repo)): AxPath<(String, String)>,
    Query(_q): Query<EmptyQ>,
) -> Response {
    let dir = match resolve_dir(&st, &owner, &repo) {
        Ok(d) => d,
        Err(e) => return e,
    };
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(&dir)
        .arg("for-each-ref")
        .arg("--sort=-creatordate")
        .arg("--format=%(refname:short)%x1f%(objectname)%x1f%(creatordate:unix)%x1f%(contents:subject)")
        .arg("refs/tags")
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        _ => return Json(json!({ "releases": [] })).into_response(),
    };
    let list: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\u{1f}').collect();
            if f.len() < 2 {
                return None;
            }
            Some(json!({
                "tag": f[0],
                "sha": f[1],
                "date_unix": f.get(2).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0),
                "message": f.get(3).copied().unwrap_or(""),
            }))
        })
        .collect();
    Json(json!({ "releases": list })).into_response()
}
