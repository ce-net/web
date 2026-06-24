//! Pull-request model for the hub git layer.
//!
//! A PR is a signed record stored in the existing per-app KV under namespace `repo-<owner>-<repo>`
//! (the namespace doubles as a persistence FILENAME, so it must be slash-free):
//! - `pr:<n>`            -> the PR record { number, title, body, head_ref, base_ref, author, state, ... }
//! - `pr:<n>:c:<seq>`    -> a comment { author, body, created_unix }
//! Comments broadcast on the `/rt` room `repo-<owner>-<repo>` / `pr:<n>` for live threads.
//!
//! The PR NUMBER allocator does NOT live in the evictable KV (that map is an LRU and would silently
//! reuse numbers / corrupt the allocator once the per-app key cap is hit). The counter is a field on
//! the repo registry (`RepoEntry::pr_count` in repos.rs), bumped under the repos.json write lock.
//!
//! Merge performs a real git merge of head into base inside the bare repo (shell git, argv arrays)
//! and updates the base ref. Open/comment/merge are all signed; merge additionally requires
//! owner/maintainer authorization.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::{Path as AxPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::repo_read::safe_single_rev;
use crate::repos::{allocate_pr_number, bare_repo_path, normalize_repo, repo_key, save_repos, valid_name};
use crate::{broadcast_room, client_ip, kv_get, kv_list, kv_put, rate_allow, unix_now, verify_signed, Shared};

/// Hard caps so a single repo / PR cannot spam the (LRU-evictable) KV out from under real records.
/// These are enforced explicitly per-repo / per-PR rather than relying on the generic key-cap LRU,
/// which would otherwise delete legitimate PRs or comments once the per-app key budget is hit.
const MAX_PRS_PER_REPO: u64 = 500;
const MAX_COMMENTS_PER_PR: usize = 1000;

/// A merge mutates `refs/heads/<base>`; concurrent merges against the same base race. We serialize
/// merges per repo with an async mutex kept in this process-wide registry (keyed by "<owner>/<repo>").
fn merge_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// KV namespace + rt room app id for a repo's PR data. MUST be slash-free: the KV persistence layer
/// uses the namespace as a filename, so a '/' would escape/break the on-disk path. owner/repo are
/// validated to [a-z0-9-] before they reach here, so '-' is an unambiguous separator.
fn repo_ns(owner: &str, repo: &str) -> String {
    format!("repo-{owner}-{repo}")
}

/// Validate and normalize (owner, repo); ensure the repo is registered. Returns (owner, repo, ns).
fn resolve(st: &Shared, owner: &str, repo: &str) -> Result<(String, String, String), Response> {
    let owner = owner.to_ascii_lowercase();
    let repo = normalize_repo(repo);
    if !valid_name(&owner) || !valid_name(&repo) {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error":"bad owner/repo"}))).into_response());
    }
    if !st.repos.lock().unwrap().contains_key(&repo_key(&owner, &repo)) {
        return Err((StatusCode::NOT_FOUND, Json(json!({"error":"repo not found"}))).into_response());
    }
    let ns = repo_ns(&owner, &repo);
    Ok((owner, repo, ns))
}

#[derive(Deserialize)]
pub(crate) struct OpenPullReq {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    head_ref: String,
    #[serde(default)]
    base_ref: String,
}

/// POST /repos/:owner/:repo/pulls — open a PR (signed). Allocates the next PR number.
pub(crate) async fn open_pull(
    State(st): State<Shared>,
    AxPath((owner, repo)): AxPath<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let (owner, repo, ns) = match resolve(&st, &owner, &repo) {
        Ok(x) => x,
        Err(e) => return e,
    };
    // Abuse control: throttle PR creation per-owner namespace and per-IP before doing any work.
    let ip = client_ip(&headers);
    if !rate_allow(&st.rate, ("pulls-open".to_string(), owner.clone()), 20.0, 1.0 / 30.0)
        || !rate_allow(&st.rate, ("pulls-open-ip".to_string(), ip), 20.0, 1.0 / 30.0)
    {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error":"rate limited"}))).into_response();
    }
    let path = format!("/repos/{owner}/{repo}/pulls");
    let signer = match verify_signed(&st, "POST", &path, &headers, &body) {
        Ok(Some(s)) => s.owner,
        Ok(None) => return (StatusCode::UNAUTHORIZED, Json(json!({"error":"signature required"}))).into_response(),
        Err(e) => return (StatusCode::UNAUTHORIZED, Json(json!({ "error": e }))).into_response(),
    };
    let req: OpenPullReq = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad body"}))).into_response(),
    };
    if req.title.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"title required"}))).into_response();
    }
    let head_ref = req.head_ref.trim();
    let base_ref = req.base_ref.trim();
    if head_ref.is_empty() || base_ref.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"head_ref and base_ref required"}))).into_response();
    }
    // Refs flow into git argv (compare_diff / rev-parse / merge). Reject anything that is not a
    // conservative revspec so an attacker can never smuggle a `--option` or a path-walk into git.
    if !safe_single_rev(head_ref) || !safe_single_rev(base_ref) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"head_ref/base_ref is not a valid git ref"}))).into_response();
    }
    // Enforce a per-repo PR cap up front so the KV (an LRU) can never evict live PRs/comments.
    let existing = kv_list(&st, &ns, "pr:")
        .into_iter()
        .filter(|(k, _)| !k.contains(":c:"))
        .count() as u64;
    if existing >= MAX_PRS_PER_REPO {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"pr limit reached for this repo"}))).into_response();
    }
    // Allocate the next PR number from the durable repos.json counter (NOT the evictable KV), under
    // the repos.json write lock. Returns None if the repo vanished between resolve() and here.
    let n = match allocate_pr_number(&st, &owner, &repo) {
        Some(n) => n,
        None => return (StatusCode::NOT_FOUND, Json(json!({"error":"repo not found"}))).into_response(),
    };
    save_repos(&st);
    let now = unix_now();
    let record = json!({
        "number": n,
        "title": req.title.trim(),
        "body": req.body,
        "head_ref": head_ref,
        "base_ref": base_ref,
        "author": signer,
        "state": "open",
        "created_unix": now,
        "updated_unix": now,
        "merged_sha": Value::Null,
    });
    kv_put(&st, &ns, &format!("pr:{n}"), record.clone());
    broadcast_room(&st, &ns, "pulls", json!({ "event": "opened", "pr": record }));
    Json(json!({ "ok": true, "number": n, "pr": record })).into_response()
}

/// GET /repos/:owner/:repo/pulls — list PRs (newest first).
pub(crate) async fn list_pulls(
    State(st): State<Shared>,
    AxPath((owner, repo)): AxPath<(String, String)>,
) -> Response {
    let (_owner, _repo, ns) = match resolve(&st, &owner, &repo) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let items: Vec<Value> = kv_list(&st, &ns, "pr:")
        .into_iter()
        // Exclude comment records (`pr:<n>:c:<seq>`) and any legacy `pr:meta` allocator record (the
        // allocator now lives in repos.json, but old namespaces may still hold a stale meta key).
        .filter(|(k, _)| k != "pr:meta" && !k.contains(":c:"))
        .map(|(_, v)| v)
        .collect();
    Json(json!({ "pulls": items, "n": items.len() })).into_response()
}

/// GET /repos/:owner/:repo/pulls/:n — PR detail incl. diff (via compare logic) and comments.
pub(crate) async fn get_pull(
    State(st): State<Shared>,
    AxPath((owner, repo, n)): AxPath<(String, String, u64)>,
) -> Response {
    let (owner, repo, ns) = match resolve(&st, &owner, &repo) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let pr = match kv_get(&st, &ns, &format!("pr:{n}")) {
        Some(v) => v,
        None => return (StatusCode::NOT_FOUND, Json(json!({"error":"pr not found"}))).into_response(),
    };
    let base = pr.get("base_ref").and_then(|x| x.as_str()).unwrap_or("");
    let head = pr.get("head_ref").and_then(|x| x.as_str()).unwrap_or("");
    let dir = bare_repo_path(&st.git_root, &owner, &repo);
    // Re-validate refs before the git call: a record written by an older build (pre-safe_rev) must
    // never reach git argv unchecked. Bad refs produce a diff error instead of a git invocation.
    let diff = if safe_single_rev(base) && safe_single_rev(head) {
        crate::repo_read::compare_diff(&dir, base, head).unwrap_or_else(|e| json!({ "error": e.to_string() }))
    } else {
        json!({ "error": "pr has an invalid base/head ref" })
    };
    let comments: Vec<Value> = kv_list(&st, &ns, &format!("pr:{n}:c:"))
        .into_iter()
        .map(|(_, v)| v)
        .rev() // oldest-first for a readable thread
        .collect();
    Json(json!({ "pr": pr, "diff": diff, "comments": comments })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct CommentReq {
    #[serde(default)]
    body: String,
}

/// POST /repos/:owner/:repo/pulls/:n/comments — add a signed comment; broadcast on the rt room.
pub(crate) async fn comment(
    State(st): State<Shared>,
    AxPath((owner, repo, n)): AxPath<(String, String, u64)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let (owner, repo, ns) = match resolve(&st, &owner, &repo) {
        Ok(x) => x,
        Err(e) => return e,
    };
    // Abuse control: throttle commenting per-owner namespace and per-IP.
    let ip = client_ip(&headers);
    if !rate_allow(&st.rate, ("pulls-comment".to_string(), owner.clone()), 60.0, 1.0)
        || !rate_allow(&st.rate, ("pulls-comment-ip".to_string(), ip), 60.0, 1.0)
    {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error":"rate limited"}))).into_response();
    }
    let path = format!("/repos/{owner}/{repo}/pulls/{n}/comments");
    let signer = match verify_signed(&st, "POST", &path, &headers, &body) {
        Ok(Some(s)) => s.owner,
        Ok(None) => return (StatusCode::UNAUTHORIZED, Json(json!({"error":"signature required"}))).into_response(),
        Err(e) => return (StatusCode::UNAUTHORIZED, Json(json!({ "error": e }))).into_response(),
    };
    if kv_get(&st, &ns, &format!("pr:{n}")).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"pr not found"}))).into_response();
    }
    // Per-PR comment cap so a thread cannot evict other PRs/comments out of the LRU KV.
    let comment_count = kv_list(&st, &ns, &format!("pr:{n}:c:")).len();
    if comment_count >= MAX_COMMENTS_PER_PR {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"comment limit reached for this pr"}))).into_response();
    }
    let req: CommentReq = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad body"}))).into_response(),
    };
    if req.body.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"comment body required"}))).into_response();
    }
    let now = unix_now();
    // Use a millisecond stamp in the key so comments sort chronologically by their key suffix.
    let seq = crate::unix_millis();
    let record = json!({
        "pr": n,
        "author": signer,
        "body": req.body.trim(),
        "created_unix": now,
    });
    kv_put(&st, &ns, &format!("pr:{n}:c:{seq:020}"), record.clone());
    broadcast_room(&st, &ns, &format!("pr:{n}"), json!({ "event": "comment", "comment": record }));
    Json(json!({ "ok": true, "comment": record })).into_response()
}

/// POST /repos/:owner/:repo/pulls/:n/merge — owner/maintainer (signed) -> real git merge -> ref update.
pub(crate) async fn merge_pull(
    State(st): State<Shared>,
    AxPath((owner, repo, n)): AxPath<(String, String, u64)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let (owner, repo, ns) = match resolve(&st, &owner, &repo) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let path = format!("/repos/{owner}/{repo}/pulls/{n}/merge");
    let signer = match verify_signed(&st, "POST", &path, &headers, &body) {
        Ok(Some(s)) => s.owner,
        Ok(None) => return (StatusCode::UNAUTHORIZED, Json(json!({"error":"signature required"}))).into_response(),
        Err(e) => return (StatusCode::UNAUTHORIZED, Json(json!({ "error": e }))).into_response(),
    };
    // Authorization: owner of the namespace (slug holder / self), repo creator, or admin.
    let creator = st.repos.lock().unwrap().get(&repo_key(&owner, &repo)).map(|e| e.owner.clone());
    let authorized = st.is_admin(&signer)
        || creator.as_deref() == Some(signer.as_str())
        || crate::repos::owns_namespace(&st, &owner, &signer);
    if !authorized {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"not authorized to merge"}))).into_response();
    }
    let mut pr = match kv_get(&st, &ns, &format!("pr:{n}")) {
        Some(v) => v,
        None => return (StatusCode::NOT_FOUND, Json(json!({"error":"pr not found"}))).into_response(),
    };
    if pr.get("state").and_then(|s| s.as_str()) == Some("merged") {
        return (StatusCode::CONFLICT, Json(json!({"error":"pr already merged"}))).into_response();
    }
    let base = pr.get("base_ref").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let head = pr.get("head_ref").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if base.is_empty() || head.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"pr missing base/head"}))).into_response();
    }
    // Re-validate refs immediately before the git argv calls (defense in depth against records that
    // predate safe_rev enforcement at open time).
    if !safe_single_rev(&base) || !safe_single_rev(&head) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"pr has an invalid base/head ref"}))).into_response();
    }
    let dir = bare_repo_path(&st.git_root, &owner, &repo);
    // Serialize merges per repo so two merges cannot race on the same base ref. Run the git work on
    // a blocking thread under a bounded timeout so a hung git process never wedges the async runtime.
    let lock = merge_lock(&repo_key(&owner, &repo));
    let _guard = lock.lock().await;
    let dir2 = dir.clone();
    let base2 = base.clone();
    let head2 = head.clone();
    let signer2 = signer.clone();
    let join = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::task::spawn_blocking(move || merge_into_base(&dir2, &base2, &head2, n, &signer2)),
    )
    .await;
    let merge = match join {
        Ok(Ok(Ok(sha))) => sha,
        Ok(Ok(Err(e))) => {
            tracing::warn!(error = %e, repo = %repo_key(&owner, &repo), pr = n, "ce-hub: merge failed");
            return (
                StatusCode::CONFLICT,
                Json(json!({"error": format!("merge failed: {e}")})),
            )
                .into_response();
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, repo = %repo_key(&owner, &repo), pr = n, "ce-hub: merge task panicked");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("merge task failed: {e}")})),
            )
                .into_response();
        }
        Err(_) => {
            tracing::warn!(repo = %repo_key(&owner, &repo), pr = n, "ce-hub: merge timed out");
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({"error":"merge timed out"})),
            )
                .into_response();
        }
    };
    pr["state"] = json!("merged");
    pr["merged_sha"] = json!(merge);
    pr["updated_unix"] = json!(unix_now());
    pr["merged_by"] = json!(signer);
    kv_put(&st, &ns, &format!("pr:{n}"), pr.clone());
    broadcast_room(&st, &ns, "pulls", json!({ "event": "merged", "pr": pr }));
    Json(json!({ "ok": true, "merged_sha": merge, "pr": pr })).into_response()
}

/// Perform a real merge of `head` into `base` inside a bare repo and update `refs/heads/<base>`.
///
/// A bare repo has no work tree, so we cannot run `git merge` directly. Instead we compute the merge
/// tree with `git merge-tree` (which reports conflicts), then write a merge commit object with two
/// parents (base, head) and move the base ref to it via `git update-ref`. Fast-forward when base is
/// an ancestor of head. All git invocations use argv arrays — no shell interpolation of the refs
/// (which are additionally validated by the caller's resolve()/safe checks).
fn merge_into_base(dir: &Path, base: &str, head: &str, pr: u64, by: &str) -> anyhow::Result<String> {
    let base_full = format!("refs/heads/{base}");
    let head_sha = rev_parse(dir, head)?;
    let base_sha = rev_parse(dir, &base_full).or_else(|_| rev_parse(dir, base))?;

    // Fast-forward: if base is an ancestor of head, just move the ref to head.
    if is_ancestor(dir, &base_sha, &head_sha)? {
        update_ref(dir, &base_full, &head_sha)?;
        return Ok(head_sha);
    }

    // Up-to-date: head already merged into base.
    if is_ancestor(dir, &head_sha, &base_sha)? {
        return Ok(base_sha);
    }

    // Three-way merge of the trees. `git merge-tree --write-tree` (git >= 2.38) writes the merged
    // tree and exits non-zero on conflict.
    let mt = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("merge-tree")
        .arg("--write-tree")
        .arg(&base_sha)
        .arg(&head_sha)
        .output()?;
    if !mt.status.success() {
        // Conflicts (or an older git lacking --write-tree). Surface a clear error; the UI can fall
        // back to instructing a local merge. VERIFY: git on the relay is >= 2.38 for --write-tree.
        anyhow::bail!(
            "merge conflict or unsupported git merge-tree: {}",
            String::from_utf8_lossy(&mt.stderr)
        );
    }
    let merged_tree = String::from_utf8_lossy(&mt.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if merged_tree.is_empty() {
        anyhow::bail!("git merge-tree produced no tree");
    }

    // Create the merge commit with two parents.
    let message = format!("Merge pull request #{pr}\n\nMerged by {by} via hub.ce-net.com\n");
    let commit_out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("commit-tree")
        .arg(&merged_tree)
        .arg("-p")
        .arg(&base_sha)
        .arg("-p")
        .arg(&head_sha)
        .arg("-m")
        .arg(&message)
        // Provide a deterministic identity so commit-tree never blocks on missing user config.
        .env("GIT_AUTHOR_NAME", "ce-hub")
        .env("GIT_AUTHOR_EMAIL", "hub@ce-net.com")
        .env("GIT_COMMITTER_NAME", "ce-hub")
        .env("GIT_COMMITTER_EMAIL", "hub@ce-net.com")
        .output()?;
    if !commit_out.status.success() {
        anyhow::bail!("git commit-tree failed: {}", String::from_utf8_lossy(&commit_out.stderr));
    }
    let merge_sha = String::from_utf8_lossy(&commit_out.stdout).trim().to_string();
    update_ref(dir, &base_full, &merge_sha)?;
    Ok(merge_sha)
}

fn rev_parse(dir: &Path, spec: &str) -> anyhow::Result<String> {
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("rev-parse")
        .arg("--verify")
        .arg(format!("{spec}^{{commit}}"))
        .output()?;
    if !out.status.success() {
        anyhow::bail!("cannot resolve ref '{spec}': {}", String::from_utf8_lossy(&out.stderr));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn is_ancestor(dir: &Path, ancestor: &str, descendant: &str) -> anyhow::Result<bool> {
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("merge-base")
        .arg("--is-ancestor")
        .arg(ancestor)
        .arg(descendant)
        .output()?;
    // Exit 0 = is ancestor, 1 = not, other = error.
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => anyhow::bail!("git merge-base failed: {}", String::from_utf8_lossy(&out.stderr)),
    }
}

fn update_ref(dir: &Path, refname: &str, sha: &str) -> anyhow::Result<()> {
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("update-ref")
        .arg(refname)
        .arg(sha)
        .output()?;
    if !out.status.success() {
        anyhow::bail!("git update-ref failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    Ok(())
}
