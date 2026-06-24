//! Live instances view: a read-only join over data the hub already holds.
//!
//! For each release (git tag) of a repo, this reports which hosted apps correspond to it and, for
//! each, which live nodes hold a replica, plus that node's uptime/latency/health from `/nodes`.
//! It is a VIEW — it adds no new tracking system (per the plan: "reuses data the hub already has").
//!
//! App<->repo linkage (v1 convention, no schema change): a hosted app's id encodes the repo as
//! `<owner>-<repo>` optionally suffixed with `-<tag>` (app ids cannot contain '/'). We match apps
//! whose id starts with `<owner>-<repo>` and, when a tag suffix is present, attribute the instance
//! to that release; otherwise it is attributed to the repo at large (release = null).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::repos::{list_tags, normalize_repo, repo_key, valid_name, bare_repo_path};
use crate::{app_summaries, node_summaries, Shared};

/// The app-id prefix that links a hosted app to a repo (see module docs).
fn app_prefix(owner: &str, repo: &str) -> String {
    format!("{owner}-{repo}")
}

/// Extract a release tag from an app id of the form `<owner>-<repo>-<tag>`. Returns the tag if the
/// id has a suffix beyond the `<owner>-<repo>` prefix, else None (repo-level instance).
fn release_of(app_id: &str, prefix: &str) -> Option<String> {
    let rest = app_id.strip_prefix(prefix)?;
    let rest = rest.strip_prefix('-').unwrap_or(rest);
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

/// GET /repos/:owner/:repo/instances — [{node_id, release, url, uptime, latency, healthy}].
pub(crate) async fn list_instances(
    State(st): State<Shared>,
    Path((owner, repo)): Path<(String, String)>,
) -> Response {
    let owner = owner.to_ascii_lowercase();
    let repo = normalize_repo(&repo);
    if !valid_name(&owner) || !valid_name(&repo) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad owner/repo"}))).into_response();
    }
    if !st.repos.lock().unwrap().contains_key(&repo_key(&owner, &repo)) {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"repo not found"}))).into_response();
    }

    let prefix = app_prefix(&owner, &repo);
    let apps = app_summaries(&st);
    let nodes = node_summaries(&st);

    let mut instances: Vec<Value> = Vec::new();
    for app in apps.iter() {
        // Match the repo by id prefix; require a boundary ('-' or exact) so `a-b` doesn't match
        // `a-bc`.
        let matches = app.id == prefix || app.id.starts_with(&format!("{prefix}-"));
        if !matches {
            continue;
        }
        let release = release_of(&app.id, &prefix);
        let url = format!("https://hub.ce-net.com/apps/{}", app.id);
        // One entry per live replica node. If an app has no live replicas, still surface a row with
        // a null node so the UI shows the deployment exists (hosted on the relay itself).
        let live_replicas: Vec<&String> = app.replicas.iter().filter(|nid| nodes.contains_key(*nid)).collect();
        if live_replicas.is_empty() {
            instances.push(json!({
                "node_id": Value::Null,
                "app_id": app.id,
                "release": release,
                "url": url,
                "uptime_pct": Value::Null,
                "latency_ms": Value::Null,
                "healthy": true,
            }));
        } else {
            for nid in live_replicas {
                let ns = nodes.get(nid);
                instances.push(json!({
                    "node_id": nid,
                    "app_id": app.id,
                    "release": release,
                    "url": url,
                    "uptime_pct": ns.map(|n| n.uptime_pct),
                    "latency_ms": ns.map(|n| n.rtt_ms),
                    "healthy": ns.map(|n| n.healthy).unwrap_or(false),
                }));
            }
        }
    }

    // Also report the repo's known releases so the UI can show tags with zero live instances.
    let dir = bare_repo_path(&st.git_root, &owner, &repo);
    let releases: Vec<Value> = list_tags(&dir);

    Json(json!({
        "owner": owner,
        "repo": repo,
        "releases": releases,
        "instances": instances,
        "n": instances.len(),
    }))
    .into_response()
}

/// Count hosted-app instances that map to this repo (used by the repo metadata endpoint). `_tags`
/// is accepted for signature symmetry / future per-tag counting; the count is repo-level today.
pub(crate) fn count_instances(st: &Shared, owner: &str, repo: &str, _tags: &[Value]) -> usize {
    let prefix = app_prefix(owner, repo);
    app_summaries(st)
        .iter()
        .filter(|a| a.id == prefix || a.id.starts_with(&format!("{prefix}-")))
        .count()
}
