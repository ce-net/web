//! Repo registry for the hub git layer.
//!
//! `repos.json` maps `"<owner>/<repo>"` -> [`RepoEntry`] (metadata only; the authoritative object
//! store is the bare repo under `CE_HUB_DATA/git/<owner>/<repo>.git`). All mutating endpoints reuse
//! the existing Ed25519 signed-header verifier (`crate::verify_signed_json` / `verify_signed`).
//!
//! Ownership: the identity that created the repo OR the holder of the `<owner>` slug. Names are
//! validated strictly (lowercase a-z0-9 and hyphen, 1-64) to keep filesystem paths inside `git/`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{client_ip, ensure_dir, rate_allow, unix_now, verify_signed, verify_signed_json, Shared};

/// Max repos a single owner namespace may register, to stop registry / inode spam.
const MAX_REPOS_PER_OWNER: usize = 200;

/// One registered repository. Stored in repos.json keyed by "<owner>/<repo>".
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct RepoEntry {
    #[serde(default)]
    pub(crate) owner: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) desc: String,
    #[serde(default = "default_branch")]
    pub(crate) default_branch: String,
    /// Upstream mirror URL (github/gitlab), empty when no mirror is configured.
    #[serde(default)]
    pub(crate) mirror_upstream: String,
    /// Mirror direction: "in" | "out" | "both" | "" (none).
    #[serde(default)]
    pub(crate) mirror_direction: String,
    #[serde(default)]
    pub(crate) created_unix: u64,
    #[serde(default)]
    pub(crate) updated_unix: u64,
    /// Monotonic per-repo PR number allocator. Lives here (durable, write-locked) rather than in the
    /// evictable KV, so PR numbers are never reused or corrupted by LRU eviction. Bumped only by
    /// `allocate_pr_number` under the repos.json write lock.
    #[serde(default)]
    pub(crate) pr_count: u64,
}

pub(crate) fn default_branch() -> String {
    "main".to_string()
}

/// Registry key for an (owner, repo) pair.
pub(crate) fn repo_key(owner: &str, repo: &str) -> String {
    format!("{owner}/{repo}")
}

/// Allocate the next PR number for (owner, repo) by bumping the durable per-repo counter under the
/// repos.json write lock. Returns the new number, or None if the repo is not registered. The caller
/// is responsible for persisting via `save_repos` afterwards.
pub(crate) fn allocate_pr_number(st: &Shared, owner: &str, repo: &str) -> Option<u64> {
    let key = repo_key(owner, repo);
    let mut repos = st.repos.lock().unwrap();
    let entry = repos.get_mut(&key)?;
    entry.pr_count += 1;
    entry.updated_unix = unix_now();
    Some(entry.pr_count)
}

/// Validate an owner or repo name: lowercase a-z0-9 and hyphen, 1-64 chars, no leading/trailing
/// hyphen. This is the ONLY gate between a request path and the filesystem, so it must be strict.
pub(crate) fn valid_name(s: &str) -> bool {
    let len = s.len();
    len >= 1
        && len <= 64
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

/// Strip a trailing ".git" from a repo path segment, then lowercase. Returns the normalized name.
pub(crate) fn normalize_repo(repo: &str) -> String {
    repo.strip_suffix(".git").unwrap_or(repo).to_ascii_lowercase()
}

/// Absolute path to the bare repo directory for (owner, repo). Caller MUST have validated names.
pub(crate) fn bare_repo_path(git_root: &Path, owner: &str, repo: &str) -> PathBuf {
    git_root.join(owner).join(format!("{repo}.git"))
}

// ---- persistence (atomic write + lock, mirroring projects.json / slugs.json) ----

/// Load repos.json from <data>/repos.json: { "owner/repo": RepoEntry }.
pub(crate) fn load_repos(data_dir: &Path) -> HashMap<String, RepoEntry> {
    let path = data_dir.join("repos.json");
    let raw = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_slice::<HashMap<String, RepoEntry>>(&raw) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("ce-hub: parse {} failed: {e}", path.display());
            HashMap::new()
        }
    }
}

/// Save the repo registry to <data>/repos.json via a temp-file + atomic rename (write + lock).
pub(crate) fn save_repos(st: &Shared) {
    ensure_dir(&st.data_dir);
    let path = st.data_dir.join("repos.json");
    let tmp = st.data_dir.join("repos.json.tmp");
    let snapshot: HashMap<String, RepoEntry> = st.repos.lock().unwrap().clone();
    match serde_json::to_vec(&snapshot) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&tmp, bytes) {
                eprintln!("ce-hub: write {} failed: {e}", tmp.display());
                return;
            }
            if let Err(e) = std::fs::rename(&tmp, &path) {
                eprintln!("ce-hub: rename {} failed: {e}", path.display());
            }
        }
        Err(e) => eprintln!("ce-hub: serialize repos.json failed: {e}"),
    }
}

/// Initialize a bare git repo at `dir` (idempotent: a no-op if it already looks like a git dir).
/// Uses argv arrays only; never shell-interpolates the path. Sets the default branch on init.
pub(crate) fn init_bare_repo(dir: &Path, default_branch: &str) -> anyhow::Result<()> {
    if dir.join("HEAD").exists() {
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // `git init --bare --initial-branch=<b>`; older git lacks --initial-branch, so fall back.
    let out = Command::new("git")
        .arg("init")
        .arg("--bare")
        .arg(format!("--initial-branch={default_branch}"))
        .arg(dir)
        .output();
    let ok = matches!(&out, Ok(o) if o.status.success());
    if !ok {
        // Fallback for git < 2.28: plain bare init, then set HEAD to the desired default branch.
        let out2 = Command::new("git").arg("init").arg("--bare").arg(dir).output()?;
        if !out2.status.success() {
            anyhow::bail!(
                "git init --bare failed: {}",
                String::from_utf8_lossy(&out2.stderr)
            );
        }
        let _ = Command::new("git")
            .arg("--git-dir")
            .arg(dir)
            .arg("symbolic-ref")
            .arg("HEAD")
            .arg(format!("refs/heads/{default_branch}"))
            .output();
    }
    // git-http-backend refuses smart-HTTP push unless the bare repo opts in via http.receivepack;
    // it does NOT honor GIT_HTTP_EXPORT_ALL for receive-pack. Auth is enforced upstream in
    // authorize_push, so enabling the service here is safe.
    let _ = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("config")
        .arg("http.receivepack")
        .arg("true")
        .output();
    Ok(())
}

// ---- HTTP handlers ----

#[derive(Deserialize)]
pub(crate) struct CreateRepoReq {
    #[serde(default)]
    owner: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    desc: String,
    #[serde(default)]
    default_branch: Option<String>,
    #[serde(default)]
    mirror_upstream: Option<String>,
}

/// POST /repos — create a repo (signed). The signer must own the `<owner>` slug OR be the first
/// creator under that owner namespace. Initializes a bare repo on disk.
pub(crate) async fn create_repo(
    State(st): State<Shared>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let (signer_owner, _v) = match verify_signed_json(&st, "POST", "/repos", &headers, &body) {
        Ok(x) => x,
        Err((c, m)) => return (c, Json(json!({ "error": m }))).into_response(),
    };
    let req: CreateRepoReq = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad body"}))).into_response(),
    };
    let owner = req.owner.trim().to_ascii_lowercase();
    let name = normalize_repo(req.name.trim());
    if !valid_name(&owner) || !valid_name(&name) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"owner/name must be lowercase a-z0-9 and hyphen, 1-64 chars"})),
        )
            .into_response();
    }
    // Abuse control: throttle repo creation per-owner namespace and per-IP to stop registry/inode
    // spam (each repo is an on-disk bare git dir + a registry entry).
    let ip = client_ip(&headers);
    if !rate_allow(&st.rate, ("repos-create".to_string(), owner.clone()), 10.0, 1.0 / 60.0)
        || !rate_allow(&st.rate, ("repos-create-ip".to_string(), ip), 10.0, 1.0 / 60.0)
    {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error":"rate limited"}))).into_response();
    }
    // Ownership: the signer must hold the `<owner>` slug, or be the literal owner id, so an
    // identity cannot create repos under a slug it does not control.
    if !owns_namespace(&st, &owner, &signer_owner) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"signer does not own this slug/namespace"})),
        )
            .into_response();
    }
    // Cap repos per owner so a controlled namespace cannot spam the registry / filesystem.
    {
        let repos = st.repos.lock().unwrap();
        let owned = repos.values().filter(|r| r.owner == owner).count();
        if owned >= MAX_REPOS_PER_OWNER {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"repo limit reached for this owner"})),
            )
                .into_response();
        }
    }
    let key = repo_key(&owner, &name);
    let now = unix_now();
    let dbranch = req
        .default_branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(default_branch);
    {
        let repos = st.repos.lock().unwrap();
        if repos.contains_key(&key) {
            return (StatusCode::CONFLICT, Json(json!({"error":"repo already exists"}))).into_response();
        }
    }
    // Init the bare repo on disk before recording it, so the registry never points at a missing dir.
    let dir = bare_repo_path(&st.git_root, &owner, &name);
    if let Err(e) = init_bare_repo(&dir, &dbranch) {
        tracing::warn!(error = %e, repo = %key, "ce-hub: bare repo init failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("could not init repo: {e}")})),
        )
            .into_response();
    }
    {
        let mut repos = st.repos.lock().unwrap();
        repos.insert(
            key.clone(),
            RepoEntry {
                owner: owner.clone(),
                name: name.clone(),
                desc: req.desc.clone(),
                default_branch: dbranch.clone(),
                mirror_upstream: req.mirror_upstream.clone().unwrap_or_default(),
                mirror_direction: String::new(),
                created_unix: now,
                updated_unix: now,
                pr_count: 0,
            },
        );
    }
    save_repos(&st);
    Json(json!({
        "ok": true,
        "owner": owner,
        "name": name,
        "default_branch": dbranch,
        "clone_url": format!("https://hub.ce-net.com/{owner}/{name}.git"),
    }))
    .into_response()
}

/// True when `signer` is allowed to act for `owner`: the signer holds a live `<owner>` slug, or the
/// signer id IS the owner string (self-namespaced). A slug entry's `owner` is an owner id (hex).
pub(crate) fn owns_namespace(st: &Shared, owner: &str, signer: &str) -> bool {
    if signer == owner {
        return true;
    }
    let now = unix_now();
    let slugs = st.slugs.lock().unwrap();
    match slugs.get(owner) {
        Some(e) => e.owner == signer && e.expires_unix > now,
        None => false,
    }
}

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    #[serde(default)]
    page: Option<usize>,
    #[serde(default)]
    per_page: Option<usize>,
    #[serde(default)]
    owner: Option<String>,
}

/// GET /repos — public, paged list of repositories.
pub(crate) async fn list_repos(
    State(st): State<Shared>,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let per_page = q.per_page.unwrap_or(50).clamp(1, 200);
    let page = q.page.unwrap_or(0);
    let filter_owner = q.owner.map(|o| o.to_ascii_lowercase());
    let mut all: Vec<RepoEntry> = {
        let repos = st.repos.lock().unwrap();
        repos
            .values()
            .filter(|r| filter_owner.as_ref().map(|o| &r.owner == o).unwrap_or(true))
            .cloned()
            .collect()
    };
    all.sort_by(|a, b| b.updated_unix.cmp(&a.updated_unix));
    let total = all.len();
    let items: Vec<Value> = all
        .into_iter()
        .skip(page * per_page)
        .take(per_page)
        .map(|r| {
            json!({
                "owner": r.owner,
                "name": r.name,
                "desc": r.desc,
                "default_branch": r.default_branch,
                "mirror_upstream": r.mirror_upstream,
                "updated_unix": r.updated_unix,
                "clone_url": format!("https://hub.ce-net.com/{}/{}.git", r.owner, r.name),
            })
        })
        .collect();
    Json(json!({ "items": items, "total": total, "page": page, "per_page": per_page }))
}

/// GET /repos/:owner/:repo — repo metadata: default_branch, refs, head commit, releases count,
/// instance count. Refs / head are read from the bare repo via plain git (argv arrays).
pub(crate) async fn get_repo(
    State(st): State<Shared>,
    axum::extract::Path((owner, repo)): axum::extract::Path<(String, String)>,
) -> impl IntoResponse {
    let owner = owner.to_ascii_lowercase();
    let repo = normalize_repo(&repo);
    if !valid_name(&owner) || !valid_name(&repo) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad owner/repo"}))).into_response();
    }
    let key = repo_key(&owner, &repo);
    let entry = match st.repos.lock().unwrap().get(&key).cloned() {
        Some(e) => e,
        None => return (StatusCode::NOT_FOUND, Json(json!({"error":"repo not found"}))).into_response(),
    };
    let dir = bare_repo_path(&st.git_root, &owner, &repo);
    let refs = list_refs(&dir);
    let tags = list_tags(&dir);
    let head = head_commit(&dir, &entry.default_branch);
    // Instance count = how many hosted apps map to this repo's tags (best-effort, cheap view).
    let instance_count = crate::instances::count_instances(&st, &owner, &repo, &tags);
    Json(json!({
        "owner": entry.owner,
        "name": entry.name,
        "desc": entry.desc,
        "default_branch": entry.default_branch,
        "mirror_upstream": entry.mirror_upstream,
        "mirror_direction": entry.mirror_direction,
        "created_unix": entry.created_unix,
        "updated_unix": entry.updated_unix,
        "refs": refs,
        "head": head,
        "releases": tags.len(),
        "instances": instance_count,
        "clone_url": format!("https://hub.ce-net.com/{owner}/{repo}.git"),
    }))
    .into_response()
}

/// DELETE /repos/:owner/:repo — owner only (signed). Removes the registry entry and the bare repo.
pub(crate) async fn delete_repo(
    State(st): State<Shared>,
    axum::extract::Path((owner, repo)): axum::extract::Path<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let owner = owner.to_ascii_lowercase();
    let repo = normalize_repo(&repo);
    if !valid_name(&owner) || !valid_name(&repo) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad owner/repo"}))).into_response();
    }
    let path = format!("/repos/{owner}/{repo}");
    let signer = match verify_signed(&st, "DELETE", &path, &headers, &body) {
        Ok(Some(s)) => s.owner,
        Ok(None) => return (StatusCode::UNAUTHORIZED, Json(json!({"error":"signature required"}))).into_response(),
        Err(e) => return (StatusCode::UNAUTHORIZED, Json(json!({ "error": e }))).into_response(),
    };
    let key = repo_key(&owner, &repo);
    let entry = match st.repos.lock().unwrap().get(&key).cloned() {
        Some(e) => e,
        None => return (StatusCode::NOT_FOUND, Json(json!({"error":"repo not found"}))).into_response(),
    };
    // Authorized if the signer owns the namespace (slug holder / self) or is the recorded creator,
    // or is a configured admin.
    let authorized = st.is_admin(&signer)
        || entry.owner == signer
        || owns_namespace(&st, &owner, &signer);
    if !authorized {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"not authorized to delete this repo"}))).into_response();
    }
    {
        let mut repos = st.repos.lock().unwrap();
        repos.remove(&key);
    }
    save_repos(&st);
    // Remove the bare repo directory (best-effort). The validated names keep this inside git/.
    let dir = bare_repo_path(&st.git_root, &owner, &repo);
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        tracing::warn!(error = %e, dir = %dir.display(), "ce-hub: repo dir removal failed");
    }
    Json(json!({ "ok": true })).into_response()
}

// ---- git ref/tag helpers (plain git, argv arrays) ----

/// List branch refs of a bare repo as [{name, sha}], via `git for-each-ref`. Empty on any error.
pub(crate) fn list_refs(dir: &Path) -> Vec<Value> {
    for_each_ref(dir, "refs/heads")
}

/// List tags of a bare repo as [{name, sha}], via `git for-each-ref refs/tags`.
pub(crate) fn list_tags(dir: &Path) -> Vec<Value> {
    for_each_ref(dir, "refs/tags")
}

fn for_each_ref(dir: &Path, pattern: &str) -> Vec<Value> {
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("for-each-ref")
        .arg("--format=%(refname:short) %(objectname)")
        .arg(pattern)
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut it = line.splitn(2, ' ');
            let name = it.next()?.trim();
            let sha = it.next()?.trim();
            if name.is_empty() || sha.is_empty() {
                return None;
            }
            Some(json!({ "name": name, "sha": sha }))
        })
        .collect()
}

/// Resolve the head commit sha of a branch (default branch) via `git rev-parse`. None on error.
pub(crate) fn head_commit(dir: &Path, branch: &str) -> Value {
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .arg("rev-parse")
        .arg(format!("refs/heads/{branch}"))
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let sha = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if sha.is_empty() {
                Value::Null
            } else {
                json!({ "sha": sha, "branch": branch })
            }
        }
        _ => Value::Null,
    }
}

/// Approximate on-disk size of a directory tree in bytes (sum of file sizes).
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(ft) if ft.is_dir() => total += dir_bytes(&p),
                Ok(ft) if ft.is_file() => {
                    if let Ok(md) = e.metadata() {
                        total += md.len();
                    }
                }
                _ => {}
            }
        }
    }
    total
}

/// Approximate on-disk size of the git root in bytes (sum of file sizes). Used for the byte budget.
pub(crate) fn git_root_bytes(git_root: &Path) -> u64 {
    dir_bytes(git_root)
}

/// Approximate on-disk size of a single bare repo in bytes. Used for the per-repo byte budget.
pub(crate) fn bare_repo_bytes(git_root: &Path, owner: &str, repo: &str) -> u64 {
    dir_bytes(&bare_repo_path(git_root, owner, repo))
}
