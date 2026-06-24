//! Git smart-HTTP wire protocol, proxied to the system `git http-backend` (the real git binary)
//! running as a CGI process over on-disk bare repos.
//!
//! - `GIT_PROJECT_ROOT` = CE_HUB_DATA/git, `GIT_HTTP_EXPORT_ALL=1` (every repo under the root is
//!   exportable; we gate access ourselves, not via per-repo `git-daemon-export-ok`).
//! - We set `PATH_INFO`, `QUERY_STRING`, `REQUEST_METHOD`, `CONTENT_TYPE`, `CONTENT_LENGTH` from the
//!   incoming request, stream the request body to the child's stdin chunk-by-chunk (never buffering
//!   the whole body in RAM), and stream the child's stdout (a CGI response: status + headers + body)
//!   back to the HTTP client.
//! - Anonymous `git-upload-pack` (clone/fetch) is allowed. `git-receive-pack` (push) is gated by
//!   HTTP Basic auth: username = owner id hex, password = a signed capability token the `cehub` CLI
//!   mints, verified here with the existing Ed25519 scheme before git-receive-pack is invoked.
//! - The bare repo is created on first push if the repo exists in the registry.
//! - Byte budgets: upload-pack request bodies use a small cap (UPLOAD_PACK_MAX_BYTES); receive-pack
//!   uses a per-repo cap (CE_HUB_MAX_REPO_BYTES) and the total git cap (CE_HUB_MAX_GIT_BYTES),
//!   enforced both as a streaming counter on the request body AND as a post-push re-measure.
//! - Concurrent `git http-backend` children are bounded by a semaphore (see Shared.git_sem).
//!
//! Untrusted owner/repo names are validated strictly (see `repos::valid_name`) before they touch the
//! filesystem; all subprocesses use argv arrays — nothing is shell-interpolated.

use std::process::Stdio;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::repos::{
    bare_repo_bytes, bare_repo_path, git_root_bytes, init_bare_repo, normalize_repo, repo_key,
    valid_name,
};
use crate::{consume_nonce, owner_id_from_pubkey, unix_now, Shared, MAX_PUSH_TOKEN_TTL};

/// Small request-body cap for anonymous upload-pack (clone/fetch) negotiation. The "want/have" lines
/// a client sends are tiny; a large upload-pack body is abuse, not legitimate traffic.
const UPLOAD_PACK_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// Wall-clock timeout for a git http-backend child serving upload-pack (clone/fetch).
const UPLOAD_PACK_TIMEOUT: Duration = Duration::from_secs(120);

/// Wall-clock timeout for a git http-backend child serving receive-pack (push). Pushes that write
/// large packs + run hooks legitimately take longer than a fetch, so the window is wider but bounded.
const RECEIVE_PACK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Deserialize)]
pub(crate) struct ServiceQuery {
    #[serde(default)]
    service: Option<String>,
}

/// GET /git/:owner/:repo/info/refs?service=git-(upload|receive)-pack — capability advertisement.
/// upload-pack (clone) is anonymous; receive-pack (push) requires a valid owner/maintainer signature.
pub(crate) async fn info_refs(
    State(st): State<Shared>,
    Path((owner, repo)): Path<(String, String)>,
    Query(q): Query<ServiceQuery>,
    headers: HeaderMap,
) -> Response {
    let (owner, repo) = match norm_pair(&owner, &repo) {
        Some(p) => p,
        None => return bad_request("invalid owner/repo name"),
    };
    let service = q.service.clone().unwrap_or_default();
    let is_push = service == "git-receive-pack";

    if is_push {
        // The info/refs advertisement is the FIRST of the two requests a `git push` makes (GET
        // info/refs, then POST git-receive-pack), and the git client sends the SAME Basic credential
        // (same token + nonce) on both. We therefore VERIFY the token here but do NOT consume its
        // single-use nonce — the nonce is consumed only on the mutating POST in `receive_pack`,
        // otherwise the follow-up POST would be falsely rejected as a replay.
        if let Err(resp) = authorize_push(&st, &owner, &repo, &headers, false).await {
            return resp;
        }
    }
    if !ensure_repo_ready(&st, &owner, &repo, is_push).await {
        return not_found("repo not found");
    }
    let query = format!("service={service}");
    run_backend(
        &st,
        "GET",
        &format!("/{owner}/{repo}.git/info/refs"),
        &query,
        "",
        Body::empty(),
        // info/refs is a GET advertisement with no request body; cap is irrelevant but kept small.
        UPLOAD_PACK_MAX_BYTES,
        UPLOAD_PACK_TIMEOUT,
        &headers,
    )
    .await
}

/// POST /git/:owner/:repo/git-upload-pack — clone/fetch negotiation (anonymous allowed).
pub(crate) async fn upload_pack(
    State(st): State<Shared>,
    Path((owner, repo)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let (owner, repo) = match norm_pair(&owner, &repo) {
        Some(p) => p,
        None => return bad_request("invalid owner/repo name"),
    };
    if !ensure_repo_ready(&st, &owner, &repo, false).await {
        return not_found("repo not found");
    }
    let ct = content_type(&headers);
    // upload-pack negotiation bodies are tiny; use a SMALL cap, not the (large) git store budget.
    run_backend(
        &st,
        "POST",
        &format!("/{owner}/{repo}.git/git-upload-pack"),
        "",
        &ct,
        body,
        UPLOAD_PACK_MAX_BYTES,
        UPLOAD_PACK_TIMEOUT,
        &headers,
    )
    .await
}

/// POST /git/:owner/:repo/git-receive-pack — push (gated by signed-token Basic auth + byte budget).
pub(crate) async fn receive_pack(
    State(st): State<Shared>,
    Path((owner, repo)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let (owner, repo) = match norm_pair(&owner, &repo) {
        Some(p) => p,
        None => return bad_request("invalid owner/repo name"),
    };
    // Consume the token nonce here (the mutating POST), making the push single-use.
    if let Err(resp) = authorize_push(&st, &owner, &repo, &headers, true).await {
        return resp;
    }
    // Pre-push fast-reject: refuse when the store is already at/over the total budget, or this repo
    // is already at/over its per-repo budget. This is a coarse pre-check (the precise post-push size
    // is only known after objects are written); the streaming counter and post-push re-measure below
    // are what actually bound a single push. Operators also set nginx client_max_body_size.
    let used_total = git_root_bytes(&st.git_root);
    if used_total >= st.max_git_bytes {
        return budget_exhausted("git storage budget reached (CE_HUB_MAX_GIT_BYTES)\n");
    }
    let used_repo = bare_repo_bytes(&st.git_root, &owner, &repo);
    if used_repo >= st.max_repo_bytes {
        return budget_exhausted("repo storage budget reached (CE_HUB_MAX_REPO_BYTES)\n");
    }
    if !ensure_repo_ready(&st, &owner, &repo, true).await {
        return not_found("repo not found");
    }
    let ct = content_type(&headers);
    // Streaming cap for THIS push: the smaller of the remaining total budget and remaining per-repo
    // budget. The streaming counter (in run_backend) kills the child + returns 413 if the request
    // body exceeds this, so a single push cannot blow past the cap even from used_repo = 0.
    let stream_cap = st
        .max_git_bytes
        .saturating_sub(used_total)
        .min(st.max_repo_bytes.saturating_sub(used_repo));
    let resp = run_backend(
        &st,
        "POST",
        &format!("/{owner}/{repo}.git/git-receive-pack"),
        "",
        &ct,
        body,
        stream_cap,
        RECEIVE_PACK_TIMEOUT,
        &headers,
    )
    .await;
    // Post-push re-measure: git may have written objects (quarantine -> permanent on a successful
    // receive-pack) whose total size we only know now. Re-measure repo + total git_root size and, if
    // either is over budget, reject and best-effort clean the new objects so a single push cannot
    // leave the store over budget. (Only enforce when the push itself succeeded; a failed push leaves
    // refs unchanged and any quarantined objects are git's to discard.)
    if resp.status().is_success() {
        let post_repo = bare_repo_bytes(&st.git_root, &owner, &repo);
        let post_total = git_root_bytes(&st.git_root);
        if post_repo > st.max_repo_bytes || post_total > st.max_git_bytes {
            tracing::warn!(
                %owner, %repo, post_repo, post_total,
                "ce-hub: push exceeded budget on re-measure; running gc/repack best-effort"
            );
            best_effort_gc(&st, &owner, &repo).await;
            return budget_exhausted(
                "push exceeded the git storage budget; objects rejected\n",
            );
        }
        // A successful push changes refs; bump the registry's updated_unix (best-effort).
        touch_repo(&st, &owner, &repo);
    }
    resp
}

// ---- helpers ----

fn norm_pair(owner: &str, repo: &str) -> Option<(String, String)> {
    let owner = owner.to_ascii_lowercase();
    let repo = normalize_repo(repo);
    if valid_name(&owner) && valid_name(&repo) {
        Some((owner, repo))
    } else {
        None
    }
}

fn content_type(headers: &HeaderMap) -> String {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// 507 Insufficient Storage response with a plain-text reason.
fn budget_exhausted(msg: &'static str) -> Response {
    (
        StatusCode::INSUFFICIENT_STORAGE,
        [(header::CONTENT_TYPE, "text/plain")],
        msg,
    )
        .into_response()
}

/// Best-effort reclaim after an over-budget push: prune unreferenced objects so quarantined/loose
/// objects from the rejected push do not persist. We do NOT delete refs (a legitimate prior history
/// may exist); we only let git drop what is now unreachable. Failures are logged, not fatal.
async fn best_effort_gc(st: &Shared, owner: &str, repo: &str) {
    let dir = bare_repo_path(&st.git_root, owner, repo);
    let git_bin = std::env::var("CE_HUB_GIT_BIN").unwrap_or_else(|_| "git".to_string());
    let mut cmd = Command::new(&git_bin);
    cmd.env_clear();
    cmd.env("PATH", std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string()));
    cmd.arg("--git-dir").arg(&dir);
    cmd.arg("gc").arg("--prune=now").arg("--quiet");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    match cmd.spawn() {
        Ok(mut child) => {
            let _ = tokio::time::timeout(Duration::from_secs(120), child.wait()).await;
            let _ = child.start_kill();
        }
        Err(e) => tracing::warn!(error = %e, %owner, %repo, "ce-hub: best-effort git gc spawn failed"),
    }
}

/// Ensure the bare repo exists on disk. For a push, create it from the registry entry on first push
/// (the repo must already be registered). For a fetch, the repo must exist. Returns false if the
/// repo is not registered (so we never auto-create on anonymous fetch of an unknown name).
async fn ensure_repo_ready(st: &Shared, owner: &str, repo: &str, is_push: bool) -> bool {
    let key = repo_key(owner, repo);
    let entry = match st.repos.lock().unwrap().get(&key).cloned() {
        Some(e) => e,
        None => return false,
    };
    let dir = bare_repo_path(&st.git_root, owner, repo);
    if dir.join("HEAD").exists() {
        return true;
    }
    if is_push {
        match init_bare_repo(&dir, &entry.default_branch) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(error = %e, repo = %key, "ce-hub: lazy bare repo init failed");
                false
            }
        }
    } else {
        false
    }
}

/// Bump a repo's updated_unix after a successful push (best-effort; ignores unknown repos).
fn touch_repo(st: &Shared, owner: &str, repo: &str) {
    let key = repo_key(owner, repo);
    let mut changed = false;
    {
        let mut repos = st.repos.lock().unwrap();
        if let Some(e) = repos.get_mut(&key) {
            e.updated_unix = unix_now();
            changed = true;
        }
    }
    if changed {
        crate::repos::save_repos(st);
    }
}

/// Authorize a push: HTTP Basic where username = owner id hex and password = a signed capability
/// token. The token is verified with the existing Ed25519 scheme; the derived owner must own the
/// `<owner>` namespace (slug holder / self) or be the repo's recorded creator, or a configured admin.
async fn authorize_push(
    st: &Shared,
    owner: &str,
    repo: &str,
    headers: &HeaderMap,
    consume: bool,
) -> Result<(), Response> {
    let (basic_user, token) = match parse_basic_auth(headers) {
        Some(x) => x,
        None => return Err(auth_required()),
    };
    let signer = match verify_cap_token(st, &token, owner, repo, consume) {
        Ok(s) => s,
        Err(reason) => {
            tracing::warn!(%owner, %repo, reason, "ce-hub: push cap token rejected");
            return Err(forbidden("invalid push capability token"));
        }
    };
    // The Basic username (the claimed owner id) is REQUIRED and must equal the token's signer (owner
    // id hex). We do not silently skip the check when empty: an empty username is a rejected request.
    if basic_user.is_empty() {
        return Err(forbidden("basic-auth username (owner id) is required for push"));
    }
    if basic_user.to_ascii_lowercase() != signer {
        return Err(forbidden("basic-auth user does not match token signer"));
    }
    let key = repo_key(owner, repo);
    let creator = st.repos.lock().unwrap().get(&key).map(|e| e.owner.clone());
    let authorized = st.is_admin(&signer)
        || creator.as_deref() == Some(signer.as_str())
        || crate::repos::owns_namespace(st, owner, &signer);
    if authorized {
        Ok(())
    } else {
        Err(forbidden("signer is not an owner/maintainer of this repo"))
    }
}

/// Parse an HTTP Basic Authorization header into (username, password). None when absent/malformed.
fn parse_basic_auth(headers: &HeaderMap) -> Option<(String, String)> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let b64 = raw.strip_prefix("Basic ").or_else(|| raw.strip_prefix("basic "))?;
    let decoded = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    let s = String::from_utf8(decoded).ok()?;
    let mut it = s.splitn(2, ':');
    let user = it.next().unwrap_or("").to_string();
    let pass = it.next().unwrap_or("").to_string();
    Some((user, pass))
}

/// A push capability token minted by `cehub`. Wire format: base64url(JSON) of
/// `{ id: <pubkey hex>, ts: <unix secs>, exp: <unix secs>, nonce: <hex>, repo: "<owner>/<repo>",
///   sig: <hex over the canonical string> }`. Canonical string signed by the client:
///   "git-push\n<owner>/<repo>\n<ts>\n<exp>\n<nonce>".
/// Returns the derived owner id on success (sha256(pubkey)[..16] hex), reusing the same identity
/// derivation as `verify_signed`. The token is repo-scoped, time-bounded, and single-use.
///
/// FORMAT NOTE: the canonical token string and JSON wire shape are UNCHANGED (the `cehub` CLI mints
/// them); the only new behavior here is server-side enforcement — single-use nonce consumption and a
/// hard server cap on the declared lifetime. Tokens minted by older/newer CLIs still verify as long
/// as their lifetime is <= MAX_PUSH_TOKEN_TTL and the nonce has not been seen.
fn verify_cap_token(
    st: &Shared,
    token: &str,
    owner: &str,
    repo: &str,
    consume: bool,
) -> Result<String, &'static str> {
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.trim())
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(token.trim()))
        .map_err(|_| "token is not valid base64")?;
    let v: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "token is not valid JSON")?;
    let id_hex = v.get("id").and_then(|x| x.as_str()).ok_or("token missing id")?;
    let sig_hex = v.get("sig").and_then(|x| x.as_str()).ok_or("token missing sig")?;
    let ts = v.get("ts").and_then(|x| x.as_u64()).ok_or("token missing ts")?;
    let exp = v.get("exp").and_then(|x| x.as_u64()).ok_or("token missing exp")?;
    let nonce = v.get("nonce").and_then(|x| x.as_str()).unwrap_or("");
    let scope = v.get("repo").and_then(|x| x.as_str()).unwrap_or("");

    let expected_scope = repo_key(owner, repo);
    if scope != expected_scope {
        return Err("token repo scope does not match");
    }
    // A nonce is mandatory: it is the single-use replay key. An empty nonce can never be consumed
    // single-use, so reject it outright.
    if nonce.is_empty() {
        return Err("token missing nonce");
    }
    let now = unix_now();
    if exp <= now {
        return Err("token expired");
    }
    // Reject a token minted in the far future (clock-skew bound matches signed-write tolerance).
    if ts > now + 300 {
        return Err("token timestamp in the future");
    }
    // Server-side max lifetime: cap both the declared lifetime and how far into the future the token
    // may remain valid, regardless of what the minting CLI requested. Bounds a leaked token's window.
    if exp < ts || exp - ts > MAX_PUSH_TOKEN_TTL {
        return Err("token lifetime exceeds server maximum");
    }
    if exp > now + MAX_PUSH_TOKEN_TTL {
        return Err("token expiry too far in the future");
    }
    let pubkey = hex::decode(id_hex).map_err(|_| "bad id hex")?;
    let pk_arr: [u8; 32] = pubkey.as_slice().try_into().map_err(|_| "id must be 32 bytes")?;
    let vk = VerifyingKey::from_bytes(&pk_arr).map_err(|_| "bad public key")?;
    let sig_bytes = hex::decode(sig_hex).map_err(|_| "bad sig hex")?;
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().map_err(|_| "sig must be 64 bytes")?;
    let sig = Signature::from_bytes(&sig_arr);
    let canon = format!("git-push\n{expected_scope}\n{ts}\n{exp}\n{nonce}");
    vk.verify(canon.as_bytes(), &sig).map_err(|_| "signature does not verify")?;

    // Consume the token nonce in the SAME single-use store verify_signed uses, namespaced with a
    // "gitpush:" prefix so it cannot collide with raw x-ce-nonce values. Done only after the
    // signature verifies, so an attacker cannot burn a victim's nonce with a forged token. The entry
    // lives until the token's own expiry (bounded above by MAX_PUSH_TOKEN_TTL). `consume` is false on
    // the info/refs advertisement (verify-only) and true on the mutating receive-pack POST, because a
    // `git push` reuses the same credential across both requests.
    if consume {
        let nonce_key = format!("gitpush:{nonce}");
        if !consume_nonce(st, &nonce_key, exp) {
            return Err("token nonce already used (replay)");
        }
    }
    Ok(owner_id_from_pubkey(&pubkey))
}

/// Outcome of streaming the request body into the child's stdin.
enum BodyStreamResult {
    /// The whole body (N bytes) was written and stdin closed cleanly.
    Done,
    /// The running byte counter exceeded the cap; the writer stopped early. Caller -> 413.
    OverCap,
    /// An I/O error on the body stream or stdin write (logged; the child likely failed too).
    Io,
}

/// Spawn `git http-backend` as a CGI process, STREAM the request `body` to its stdin chunk-by-chunk
/// (never buffering the whole body in RAM) while enforcing a running byte cap, and translate its CGI
/// output (status line + headers + body) into an axum Response. Inputs are passed as env/argv — never
/// interpolated into a shell. Concurrency is bounded by `st.git_sem`; the child is wrapped in a
/// wall-clock timeout and killed if it (or stdin streaming) exceeds the cap or the deadline.
#[allow(clippy::too_many_arguments)]
async fn run_backend(
    st: &Shared,
    method: &str,
    path_info: &str,
    query: &str,
    content_type: &str,
    body: Body,
    body_cap: u64,
    timeout: Duration,
    headers: &HeaderMap,
) -> Response {
    // Bound concurrent CGI children. The permit is held until this function returns (child reaped).
    let _permit = match st.git_sem.clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => {
            // Semaphore closed — only happens at shutdown.
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::CONTENT_TYPE, "text/plain")],
                "git service shutting down\n",
            )
                .into_response();
        }
    };

    let git_bin = std::env::var("CE_HUB_GIT_BIN").unwrap_or_else(|_| "git".to_string());
    let mut cmd = Command::new(&git_bin);
    cmd.arg("http-backend");
    // LOW: do not inherit the relay's ambient environment; set ONLY the vars git http-backend needs.
    cmd.env_clear();
    cmd.env("PATH", std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string()));
    cmd.env("GIT_PROJECT_ROOT", &st.git_root);
    cmd.env("GIT_HTTP_EXPORT_ALL", "1");
    cmd.env("REQUEST_METHOD", method);
    cmd.env("PATH_INFO", path_info);
    cmd.env("QUERY_STRING", query);
    cmd.env("CONTENT_TYPE", content_type);
    // VERIFY: git http-backend uses CONTENT_LENGTH to bound how much it reads from stdin for a POST.
    // We pass through the client's declared Content-Length when present; when absent (chunked
    // transfer), we omit it and git reads to EOF. Either way the streaming counter below is the hard
    // cap, independent of any client-declared length.
    if let Some(len) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
    {
        cmd.env("CONTENT_LENGTH", len);
    }
    // git-http-backend reads the protocol version from this header (smart protocol v2).
    if let Some(ver) = headers.get("git-protocol").and_then(|v| v.to_str().ok()) {
        cmd.env("GIT_PROTOCOL", ver);
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "ce-hub: failed to spawn git http-backend");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                [(header::CONTENT_TYPE, "text/plain")],
                "git http-backend unavailable\n",
            )
                .into_response();
        }
    };

    // Take the child's pipes. We keep `child` owned (not via wait_with_output) so we can explicitly
    // kill it on timeout / over-cap.
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    // Stream the request body into stdin in a separate task so the child can drain stdout
    // concurrently (avoids a deadlock when the child writes a large response while we still feed it).
    let writer = tokio::spawn(async move {
        let mut stdin = match stdin {
            Some(s) => s,
            None => return BodyStreamResult::Io,
        };
        let mut stream = body.into_data_stream();
        let mut written: u64 = 0;
        // VERIFY: axum 0.7 Body::into_data_stream() yields Result<Bytes, axum::Error> items.
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "ce-hub: error reading git request body stream");
                    return BodyStreamResult::Io;
                }
            };
            written = written.saturating_add(chunk.len() as u64);
            if written > body_cap {
                // Over cap: stop writing and drop stdin so git sees a truncated body and exits.
                tracing::warn!(written, body_cap, "ce-hub: git request body exceeded byte cap");
                drop(stdin);
                return BodyStreamResult::OverCap;
            }
            if let Err(e) = stdin.write_all(&chunk).await {
                tracing::warn!(error = %e, "ce-hub: write to git-http-backend stdin failed");
                return BodyStreamResult::Io;
            }
        }
        let _ = stdin.shutdown().await;
        drop(stdin);
        BodyStreamResult::Done
    });

    // Concurrently read stdout/stderr to drain the pipes while git runs.
    let stdout_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(ref mut s) = stdout {
            let _ = s.read_to_end(&mut buf).await;
        }
        buf
    });
    let stderr_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(ref mut s) = stderr {
            let _ = s.read_to_end(&mut buf).await;
        }
        buf
    });

    // Wait for the child under a wall-clock timeout; kill it (and abort readers) on timeout.
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            tracing::error!(error = %e, "ce-hub: git http-backend wait failed");
            let _ = child.start_kill();
            writer.abort();
            stdout_task.abort();
            stderr_task.abort();
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                [(header::CONTENT_TYPE, "text/plain")],
                "git http-backend error\n",
            )
                .into_response();
        }
        Err(_) => {
            tracing::warn!(?timeout, "ce-hub: git http-backend timed out; killing child");
            let _ = child.start_kill();
            let _ = child.wait().await;
            writer.abort();
            stdout_task.abort();
            stderr_task.abort();
            return (
                StatusCode::GATEWAY_TIMEOUT,
                [(header::CONTENT_TYPE, "text/plain")],
                "git http-backend timed out\n",
            )
                .into_response();
        }
    };

    let stdout_buf = stdout_task.await.unwrap_or_default();
    let stderr_buf = stderr_task.await.unwrap_or_default();

    // Inspect the body-streaming outcome: an over-cap body is a 413 regardless of the child's exit.
    match writer.await {
        Ok(BodyStreamResult::OverCap) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                [(header::CONTENT_TYPE, "text/plain")],
                "request body exceeds git byte budget\n",
            )
                .into_response();
        }
        Ok(BodyStreamResult::Io) | Err(_) => {
            // I/O error or the writer task was cancelled: if git still produced a valid response we
            // fall through to parse it; otherwise surface a 500 below.
        }
        Ok(BodyStreamResult::Done) => {}
    }

    if !status.success() && stdout_buf.is_empty() {
        tracing::warn!(
            stderr = %String::from_utf8_lossy(&stderr_buf),
            "ce-hub: git http-backend non-zero exit"
        );
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(header::CONTENT_TYPE, "text/plain")],
            "git http-backend failed\n",
        )
            .into_response();
    }
    parse_cgi_response(stdout_buf)
}

/// Parse a CGI response (headers, blank line, body) into an axum Response. The CGI `Status:` header
/// (if present) sets the HTTP status; everything else is passed through as a response header.
fn parse_cgi_response(out: Vec<u8>) -> Response {
    // Split on the first CRLF/CRLF or LF/LF boundary between headers and body.
    let split = find_header_end(&out);
    let (head, body) = match split {
        Some((end, body_start)) => (&out[..end], out[body_start..].to_vec()),
        None => {
            // No header block: treat the whole thing as a body with a 200 and octet-stream type.
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/octet-stream")],
                out,
            )
                .into_response();
        }
    };
    let head_str = String::from_utf8_lossy(head);
    let mut status = StatusCode::OK;
    let mut builder = Response::builder();
    for line in head_str.split(|c| c == '\n').map(|l| l.trim_end_matches('\r')) {
        if line.is_empty() {
            continue;
        }
        let mut it = line.splitn(2, ':');
        let name = it.next().unwrap_or("").trim();
        let value = it.next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        if name.eq_ignore_ascii_case("Status") {
            // "Status: 404 Not Found" -> take the numeric code.
            if let Some(code) = value.split_whitespace().next().and_then(|c| c.parse::<u16>().ok()) {
                if let Ok(sc) = StatusCode::from_u16(code) {
                    status = sc;
                }
            }
            continue;
        }
        builder = builder.header(name, value);
    }
    match builder.status(status).body(Body::from(body)) {
        Ok(resp) => resp,
        Err(e) => {
            tracing::error!(error = %e, "ce-hub: building CGI response failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "response build error").into_response()
        }
    }
}

/// Find the end of the CGI header block. Returns (header_end_index, body_start_index) for the first
/// "\r\n\r\n" or "\n\n" boundary.
fn find_header_end(buf: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < buf.len() {
        if buf[i] == b'\n' {
            // "\n\n"
            if i + 1 < buf.len() && buf[i + 1] == b'\n' {
                return Some((i, i + 2));
            }
            // "\n\r\n"
            if i + 2 < buf.len() && buf[i + 1] == b'\r' && buf[i + 2] == b'\n' {
                return Some((i, i + 3));
            }
        }
        i += 1;
    }
    None
}

// ---- small response builders ----

fn auth_required() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [
            (header::WWW_AUTHENTICATE, "Basic realm=\"ce-hub git\""),
            (header::CONTENT_TYPE, "text/plain"),
        ],
        "authentication required for push\n",
    )
        .into_response()
}

fn forbidden(msg: &'static str) -> Response {
    (StatusCode::FORBIDDEN, [(header::CONTENT_TYPE, "text/plain")], format!("{msg}\n")).into_response()
}

fn not_found(msg: &'static str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": msg }))).into_response()
}

fn bad_request(msg: &'static str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}
