//! GitHub/GitLab two-way mirror for the hub git layer.
//!
//! Stores an upstream URL + direction (in|out|both) in repos.json and runs a sync by shelling the
//! system `git` against the bare repo:
//! - direction includes "in":  `git fetch <upstream> "+refs/heads/*:refs/heads/*" "+refs/tags/*:refs/tags/*"`
//! - direction includes "out": `git push <upstream> "refs/heads/*:refs/heads/*" "refs/tags/*:refs/tags/*"`
//!
//! Underneath it is plain git remotes, so the hub stays a normal git peer. Configuration is signed
//! by the repo owner (reusing the Ed25519 verifier); the upstream URL is validated (http/https/ssh,
//! no shell metacharacters) and passed as an argv value — never shell-interpolated.

use std::net::{IpAddr, Ipv6Addr, ToSocketAddrs};
use std::path::Path;
use std::process::Command;

use axum::extract::{Path as AxPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::repos::{bare_repo_path, init_bare_repo, normalize_repo, repo_key, save_repos, valid_name};
use crate::{unix_now, verify_signed, Shared};

#[derive(Deserialize)]
pub(crate) struct MirrorReq {
    #[serde(default)]
    upstream: String,
    /// "in" | "out" | "both". Defaults to "in" (read-through mirror) when omitted.
    #[serde(default)]
    direction: Option<String>,
    /// When true, run a sync immediately after saving the config. Default true.
    #[serde(default = "default_sync_now")]
    sync_now: bool,
}

fn default_sync_now() -> bool {
    true
}

/// Known public git hosts we prefer. Every host (allowlisted or not) must still resolve exclusively
/// to public, routable addresses — see `ssrf_guard`.
const ALLOWED_GIT_HOSTS: &[&str] = &["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"];

/// Validate an upstream remote URL: http(s) or ssh (scp-like) form, bounded length, and free of
/// characters that could be misused. We still pass it as an argv value; this is defense in depth.
///
/// NOTE: this is a syntactic check only. It deliberately does NOT do DNS resolution / SSRF checks
/// (those run on the blocking sync thread via `ssrf_guard`) and it does NOT reject userinfo here —
/// userinfo is stripped before persistence by `sanitize_upstream`.
fn valid_upstream(url: &str) -> bool {
    if url.is_empty() || url.len() > 512 {
        return false;
    }
    // Reject control chars, whitespace, and shell metacharacters outright.
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    if url.contains(['`', '$', ';', '|', '&', '<', '>', '(', ')', '\\', '"', '\'']) {
        return false;
    }
    let is_http = url.starts_with("https://") || url.starts_with("http://");
    let is_ssh = url.starts_with("git@") || url.starts_with("ssh://");
    is_http || is_ssh
}

/// Strip any embedded credentials (the `userinfo@` portion of an authority) from an upstream URL so
/// we never persist or echo a plaintext token/password. Returns the cleaned URL.
///
/// Handles both URL forms (`scheme://userinfo@host/...`) and the scp-like ssh form
/// (`user@host:path`). For the scp-like form a bare `user@` is a normal git username (not a secret)
/// and is preserved; only a `user:secret@` (containing a `:`) is collapsed to `host:path`.
fn sanitize_upstream(url: &str) -> String {
    // scheme://[userinfo@]host[/...] form.
    if let Some(scheme_end) = url.find("://") {
        let (scheme, rest) = url.split_at(scheme_end + 3);
        // The authority ends at the first '/', '?' or '#'.
        let auth_end = rest
            .find(|c| c == '/' || c == '?' || c == '#')
            .unwrap_or(rest.len());
        let (authority, tail) = rest.split_at(auth_end);
        // Only the LAST '@' separates userinfo from host (userinfo may itself contain '@').
        if let Some(at) = authority.rfind('@') {
            let host = &authority[at + 1..];
            return format!("{scheme}{host}{tail}");
        }
        return url.to_string();
    }
    // scp-like ssh form: [user[:secret]@]host:path. Drop a credential-bearing userinfo only.
    if let Some(at) = url.rfind('@') {
        let userinfo = &url[..at];
        if userinfo.contains(':') {
            return url[at + 1..].to_string();
        }
    }
    url.to_string()
}

/// Extract the host (no port, no userinfo) from an upstream URL for SSRF inspection.
fn upstream_host(url: &str) -> Option<String> {
    let after_scheme = if let Some(idx) = url.find("://") {
        &url[idx + 3..]
    } else {
        // scp-like ssh form: [user@]host:path
        let after_user = match url.rfind('@') {
            Some(at) => &url[at + 1..],
            None => url,
        };
        let host = after_user.split(':').next().unwrap_or(after_user);
        return if host.is_empty() { None } else { Some(host.to_string()) };
    };
    // URL authority: strip userinfo, then take up to the first '/', '?', '#'.
    let auth_end = after_scheme
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..auth_end];
    let host_port = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };
    // Strip a [v6]:port or host:port suffix. IPv6 literals are bracketed.
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        match stripped.find(']') {
            Some(end) => &stripped[..end],
            None => host_port,
        }
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// True if an IP address is private, loopback, link-local, ULA, or otherwise non-public and must
/// never be a mirror upstream (defeats SSRF to internal services / cloud metadata).
fn ip_is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()            // 127.0.0.0/8
                || v4.is_private()      // 10/8, 172.16/12, 192.168/16
                || v4.is_link_local()   // 169.254.0.0/16 (incl. 169.254.169.254 metadata)
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()  // 0.0.0.0
                || v4.octets()[0] == 0
                // Carrier-grade NAT 100.64.0.0/10.
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()            // ::1
                || v6.is_unspecified()  // ::
                || is_ula(v6)           // fc00::/7
                || is_link_local_v6(v6) // fe80::/10
                // IPv4-mapped / -compatible: inspect the embedded v4.
                || v6
                    .to_ipv4()
                    .map(|m| ip_is_private(&IpAddr::V4(m)))
                    .unwrap_or(false)
        }
    }
}

/// fc00::/7 unique-local addresses.
fn is_ula(v6: &Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xfe00) == 0xfc00
}

/// fe80::/10 link-local addresses (covers IPv6 link-local incl. any cloud metadata aliases).
fn is_link_local_v6(v6: &Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xffc0) == 0xfe80
}

/// SSRF guard: reject upstreams whose host is localhost or resolves to any private/internal address.
///
/// Resolution is done once here, and ALL resolved addresses are checked (not just the literal) to
/// blunt DNS-rebinding-to-private. Hosts on the known-good git allowlist still get an IP check so a
/// poisoned resolver cannot point an allowlisted name at an internal IP. Runs on a blocking thread
/// (caller is already inside spawn_blocking) because `ToSocketAddrs` does blocking DNS.
fn ssrf_guard(url: &str) -> anyhow::Result<()> {
    let host = upstream_host(url)
        .ok_or_else(|| anyhow::anyhow!("upstream has no host"))?;
    let host_lc = host.to_ascii_lowercase();

    // Obvious localhost aliases.
    if host_lc == "localhost"
        || host_lc.ends_with(".localhost")
        || host_lc == "localhost.localdomain"
    {
        anyhow::bail!("upstream host is not allowed");
    }

    // A bare IP literal is checked directly (a public IP literal is permitted; allowlist hostnames
    // are still IP-checked below to defeat a poisoned resolver).
    if let Ok(ip) = host.parse::<IpAddr>() {
        if ip_is_private(&ip) {
            anyhow::bail!("upstream resolves to a private/internal address");
        }
        return Ok(());
    }

    // We prefer the known-good git hosts, but ALL hosts (allowlisted or not) are still required to
    // resolve exclusively to public addresses — a poisoned/split-horizon resolver must not be able
    // to point even an allowlisted name at an internal IP.
    let allowlisted = ALLOWED_GIT_HOSTS
        .iter()
        .any(|h| host_lc == *h || host_lc.ends_with(&format!(".{h}")));
    let _ = allowlisted;

    // Resolve the hostname. Port is irrelevant for the address check; use 0.
    let addrs: Vec<IpAddr> = (host.as_str(), 0u16)
        .to_socket_addrs()
        .map_err(|e| anyhow::anyhow!("could not resolve upstream host: {e}"))?
        .map(|sa| sa.ip())
        .collect();

    if addrs.is_empty() {
        anyhow::bail!("upstream host did not resolve to any address");
    }
    // EVERY resolved address must be public — defeats split-horizon / rebinding to a private IP.
    for ip in &addrs {
        if ip_is_private(ip) {
            anyhow::bail!("upstream resolves to a private/internal address");
        }
    }
    Ok(())
}

/// POST /repos/:owner/:repo/mirror — configure upstream + direction (signed by owner) and sync.
pub(crate) async fn configure_mirror(
    State(st): State<Shared>,
    AxPath((owner, repo)): AxPath<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let owner = owner.to_ascii_lowercase();
    let repo = normalize_repo(&repo);
    if !valid_name(&owner) || !valid_name(&repo) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad owner/repo"}))).into_response();
    }
    let path = format!("/repos/{owner}/{repo}/mirror");
    let signer = match verify_signed(&st, "POST", &path, &headers, &body) {
        Ok(Some(s)) => s.owner,
        Ok(None) => return (StatusCode::UNAUTHORIZED, Json(json!({"error":"signature required"}))).into_response(),
        Err(e) => return (StatusCode::UNAUTHORIZED, Json(json!({ "error": e }))).into_response(),
    };
    let key = repo_key(&owner, &repo);
    let (entry_owner, default_branch) = match st.repos.lock().unwrap().get(&key) {
        Some(e) => (e.owner.clone(), e.default_branch.clone()),
        None => return (StatusCode::NOT_FOUND, Json(json!({"error":"repo not found"}))).into_response(),
    };
    let authorized = st.is_admin(&signer)
        || entry_owner == signer
        || crate::repos::owns_namespace(&st, &owner, &signer);
    if !authorized {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"not authorized to configure mirror"}))).into_response();
    }
    let req: MirrorReq = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad body"}))).into_response(),
    };
    let raw_upstream = req.upstream.trim().to_string();
    if !valid_upstream(&raw_upstream) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"upstream must be an http(s) or ssh git URL with no shell metacharacters"})),
        )
            .into_response();
    }
    // Strip any embedded credentials (user:pass@ / token@) so we never persist or echo a secret.
    // We sync against the sanitized URL too; embedding a token in the upstream is unsupported.
    let upstream = sanitize_upstream(&raw_upstream);
    let direction = req.direction.clone().unwrap_or_else(|| "in".to_string());
    if !matches!(direction.as_str(), "in" | "out" | "both") {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"direction must be in|out|both"}))).into_response();
    }

    // Persist the mirror config in repos.json.
    {
        let mut repos = st.repos.lock().unwrap();
        if let Some(e) = repos.get_mut(&key) {
            e.mirror_upstream = upstream.clone();
            e.mirror_direction = direction.clone();
            e.updated_unix = unix_now();
        }
    }
    save_repos(&st);

    if !req.sync_now {
        return Json(json!({ "ok": true, "upstream": upstream, "direction": direction, "synced": false }))
            .into_response();
    }

    // Ensure the bare repo exists before syncing (lazily create it on first mirror-in).
    let dir = bare_repo_path(&st.git_root, &owner, &repo);
    if !dir.join("HEAD").exists() {
        if let Err(e) = init_bare_repo(&dir, &default_branch) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("could not init repo: {e}")})),
            )
                .into_response();
        }
    }

    // Run the sync on a blocking thread so the network git operations never stall the async runtime.
    let dir2 = dir.clone();
    let upstream2 = upstream.clone();
    let direction2 = direction.clone();
    let result = tokio::task::spawn_blocking(move || {
        // SSRF guard inside the blocking thread: blocking DNS resolution, then sync only if every
        // resolved address is public. Done here (not at validation time) so the resolved addresses
        // are the freshest possible before git connects.
        ssrf_guard(&upstream2)?;
        run_sync(&dir2, &upstream2, &direction2)
    })
    .await;
    match result {
        Ok(Ok(log)) => Json(json!({
            "ok": true,
            "upstream": upstream,
            "direction": direction,
            "synced": true,
            "log": log,
        }))
        .into_response(),
        Ok(Err(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": format!("mirror sync failed: {e}"), "upstream": upstream})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("mirror task panicked: {e}")})),
        )
            .into_response(),
    }
}

/// Run the configured mirror sync. Returns a short human-readable log of the steps performed.
fn run_sync(dir: &Path, upstream: &str, direction: &str) -> anyhow::Result<String> {
    let mut log = String::new();
    if direction == "in" || direction == "both" {
        let out = Command::new("git")
            .arg("--git-dir")
            .arg(dir)
            .arg("fetch")
            .arg("--prune")
            .arg(upstream)
            .arg("+refs/heads/*:refs/heads/*")
            .arg("+refs/tags/*:refs/tags/*")
            .output()?;
        if !out.status.success() {
            // Log the raw git stderr server-side; never return it to the client (it can leak
            // internal paths, remote hostnames, or auth detail).
            tracing::warn!(
                target: "ce_hub::mirror",
                "git fetch failed (status {:?}): {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
            anyhow::bail!("fetch from upstream failed");
        }
        log.push_str("fetched upstream -> bare repo\n");
    }
    if direction == "out" || direction == "both" {
        let out = Command::new("git")
            .arg("--git-dir")
            .arg(dir)
            .arg("push")
            .arg(upstream)
            .arg("refs/heads/*:refs/heads/*")
            .arg("refs/tags/*:refs/tags/*")
            .output()?;
        if !out.status.success() {
            // Log the raw git stderr server-side; never return it to the client.
            tracing::warn!(
                target: "ce_hub::mirror",
                "git push failed (status {:?}): {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
            anyhow::bail!("push to upstream failed");
        }
        log.push_str("pushed bare repo -> upstream\n");
    }
    Ok(log)
}
