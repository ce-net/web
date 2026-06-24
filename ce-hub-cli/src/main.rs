//! ce-hub — a thin CLI for hub.ce-net.com (GitHub for ce-net).
//!
//! It wraps two things:
//!   1. the system `git` binary (clone / push / tag), and
//!   2. the hub HTTP API (web/ce-hub), authenticated with the SAME CE identity + signed-header
//!      scheme as web/ce-app/bin/slug.mjs (x-ce-id / x-ce-sig / x-ce-ts seconds / x-ce-nonce,
//!      body = sha256-hex over the raw bytes; key at ~/.local/share/ce/identity/node.key).
//!
//! Push uses git's credential-helper protocol: configure `credential.helper` to call
//! `ce-hub credential`, and a plain `git push` to the hub mints a short-lived signed capability
//! token (username = owner id, password = token) that ce-hub's git-receive-pack gate verifies.

mod identity;

use std::io::{BufRead, Write};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use clap::{Parser, Subcommand};
use identity::Identity;
use serde_json::{json, Value};

const DEFAULT_HUB: &str = "https://hub.ce-net.com";

/// ce-hub — GitHub for ce-net, from the command line.
#[derive(Parser)]
#[command(name = "ce-hub", version, about = "Thin CLI for hub.ce-net.com (git + signed hub API)")]
struct Cli {
    /// Hub base URL (default: $CE_HUB or https://hub.ce-net.com).
    #[arg(long, global = true)]
    hub: Option<String>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a repo on the hub: ce-hub create <owner>/<repo> [--desc ...]
    Create {
        /// owner/repo (owner is a claimed slug bound to your CE identity).
        repo: String,
        /// Repo description.
        #[arg(long, default_value = "")]
        desc: String,
    },
    /// Clone a hub repo: ce-hub clone <owner>/<repo> [dir]
    Clone {
        repo: String,
        /// Target directory (default: the repo name).
        dir: Option<String>,
    },
    /// Push the current repo to the hub using the signed-token credential helper.
    Push {
        /// Extra args passed through to `git push` (e.g. -u origin main).
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// git credential-helper protocol (configure credential.helper to call this).
    Credential {
        /// One of: get | store | erase (git invokes these).
        op: String,
    },
    /// Pull requests.
    #[command(subcommand)]
    Pr(PrCmd),
    /// Tag a release and push the tag: ce-hub release <tag>
    Release {
        tag: String,
        /// Annotated tag message (default: the tag name).
        #[arg(long)]
        message: Option<String>,
    },
    /// Show live instances of a repo: ce-hub instances <owner>/<repo>
    Instances { repo: String },
    /// Configure a github/gitlab two-way mirror for a repo.
    Mirror {
        repo: String,
        /// Upstream git URL to mirror with.
        #[arg(long)]
        upstream: String,
        /// Direction: in | out | both.
        #[arg(long)]
        dir: String,
    },
}

#[derive(Subcommand)]
enum PrCmd {
    /// Open a pull request (signed).
    Open {
        /// owner/repo to open the PR against.
        repo: String,
        #[arg(long)]
        head: String,
        #[arg(long)]
        base: String,
        #[arg(long)]
        title: String,
        #[arg(long, default_value = "")]
        body: String,
    },
    /// List pull requests for a repo.
    Ls { repo: String },
    /// Merge a pull request by number (signed).
    Merge { repo: String, number: u64 },
}

fn main() {
    if let Err(e) = run() {
        eprintln!("ce-hub: error: {e:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let hub = resolve_hub(cli.hub.as_deref());
    match cli.cmd {
        Cmd::Create { repo, desc } => cmd_create(&hub, &repo, &desc),
        Cmd::Clone { repo, dir } => cmd_clone(&hub, &repo, dir.as_deref()),
        Cmd::Push { args } => cmd_push(&hub, &args),
        Cmd::Credential { op } => cmd_credential(&hub, &op),
        Cmd::Pr(pr) => match pr {
            PrCmd::Open { repo, head, base, title, body } => {
                cmd_pr_open(&hub, &repo, &head, &base, &title, &body)
            }
            PrCmd::Ls { repo } => cmd_pr_ls(&hub, &repo),
            PrCmd::Merge { repo, number } => cmd_pr_merge(&hub, &repo, number),
        },
        Cmd::Release { tag, message } => cmd_release(&hub, &tag, message.as_deref()),
        Cmd::Instances { repo } => cmd_instances(&hub, &repo),
        Cmd::Mirror { repo, upstream, dir } => cmd_mirror(&hub, &repo, &upstream, &dir),
    }
}

// ---------------------------------------------------------------------------
// hub base + url helpers
// ---------------------------------------------------------------------------

/// Resolve the hub base URL: --hub flag, then $CE_HUB, then the default. Trailing slashes trimmed.
fn resolve_hub(flag: Option<&str>) -> String {
    let raw = flag
        .map(|s| s.to_string())
        .or_else(|| std::env::var("CE_HUB").ok())
        .unwrap_or_else(|| DEFAULT_HUB.to_string());
    raw.trim_end_matches('/').to_string()
}

/// Split "owner/repo" into its parts, validating the strict name charset the hub enforces.
fn split_owner_repo(s: &str) -> Result<(String, String)> {
    let s = s.trim().trim_end_matches(".git");
    let mut it = s.splitn(2, '/');
    let owner = it.next().unwrap_or("").trim().to_ascii_lowercase();
    let repo = it
        .next()
        .ok_or_else(|| anyhow!("expected <owner>/<repo>, got {s:?}"))?
        .trim()
        .to_ascii_lowercase();
    if !valid_name(&owner) || !valid_name(&repo) {
        bail!("owner and repo must be lowercase a-z0-9 and hyphen, 1-64 chars");
    }
    Ok((owner, repo))
}

/// Strict name validation matching the hub (lowercase a-z0-9 and hyphen, 1..=64 chars).
fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The git clone/remote URL for a repo on the hub.
fn git_url(hub: &str, owner: &str, repo: &str) -> String {
    format!("{hub}/git/{owner}/{repo}.git")
}

// ---------------------------------------------------------------------------
// signed JSON requests against the hub
// ---------------------------------------------------------------------------

/// Issue a signed JSON request. `path` is the bare hub path (the signed canonical path); the full
/// URL is `<hub><path>`. Returns the parsed JSON response, erroring on non-2xx.
fn signed_json(hub: &str, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
    let ident = Identity::load()?;
    let body_bytes = match body {
        Some(v) => serde_json::to_vec(v)?,
        None => Vec::new(),
    };
    let headers = ident.signed_headers(method, path, &body_bytes);

    let url = format!("{hub}{path}");
    let client = http_client()?;
    let mut req = match method {
        "POST" => client.post(&url),
        "GET" => client.get(&url),
        "DELETE" => client.delete(&url),
        other => bail!("unsupported method {other}"),
    };
    if body.is_some() {
        req = req.header("content-type", "application/json");
    }
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if !body_bytes.is_empty() {
        req = req.body(body_bytes);
    }
    let resp = req.send().with_context(|| format!("{method} {url}"))?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
    if !status.is_success() {
        let msg = parsed
            .get("error")
            .and_then(|e| e.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| text.clone());
        bail!("{method} {path} -> {} {}", status.as_u16(), msg);
    }
    Ok(parsed)
}

/// A plain (unsigned) GET — for public read endpoints (instances, repo metadata).
fn public_get(hub: &str, path: &str) -> Result<Value> {
    let url = format!("{hub}{path}");
    let client = http_client()?;
    let resp = client.get(&url).send().with_context(|| format!("GET {url}"))?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        bail!("GET {path} -> {} {}", status.as_u16(), text);
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

fn http_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .user_agent(concat!("ce-hub/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("building HTTP client")
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/// Run `git` with the given args, inheriting stdio, and error on a non-zero exit.
fn git(args: &[&str]) -> Result<()> {
    let status = Command::new("git")
        .args(args)
        .status()
        .context("spawning git (is it installed and on PATH?)")?;
    if !status.success() {
        bail!("git {} exited with {}", args.join(" "), status);
    }
    Ok(())
}

/// Run `git` and capture stdout (trimmed). Errors on a non-zero exit.
fn git_capture(args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .output()
        .context("spawning git")?;
    if !out.status.success() {
        bail!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

fn cmd_create(hub: &str, repo: &str, desc: &str) -> Result<()> {
    let (owner, name) = split_owner_repo(repo)?;
    let body = json!({ "owner": owner, "name": name, "desc": desc });
    let resp = signed_json(hub, "POST", "/repos", Some(&body))?;
    let branch = resp
        .get("default_branch")
        .and_then(|v| v.as_str())
        .unwrap_or("main");
    println!("created  {owner}/{name}");
    println!("  clone  {}", git_url(hub, &owner, &name));
    println!("  branch {branch}");
    Ok(())
}

fn cmd_clone(hub: &str, repo: &str, dir: Option<&str>) -> Result<()> {
    let (owner, name) = split_owner_repo(repo)?;
    let url = git_url(hub, &owner, &name);
    let mut args = vec!["clone", url.as_str()];
    if let Some(d) = dir {
        args.push(d);
    }
    git(&args)
}

fn cmd_push(hub: &str, extra: &[String]) -> Result<()> {
    // Ensure git uses our credential helper for THIS push so the signed token is minted on demand.
    // We pass `-c credential.helper=<self> credential` scoped to the hub host. The helper below
    // (cmd_credential) returns username=owner id, password=signed token.
    let self_exe = std::env::current_exe()
        .context("locating the ce-hub executable")?
        .to_string_lossy()
        .to_string();
    let host = host_of(hub)?;
    // Format: a leading `!` makes git run the value via the shell, appending the operation
    // (get/store/erase) as the final argument. Quote the exe path and hub so spaces survive.
    let helper = format!("!\"{self_exe}\" --hub \"{hub}\" credential");
    let cred_cfg = format!("credential.https://{host}.helper={helper}");

    let mut args: Vec<String> = vec![
        "-c".into(),
        // Wipe inherited helpers so only ours runs for the hub host.
        format!("credential.https://{host}.helper="),
        "-c".into(),
        cred_cfg,
        "push".into(),
    ];
    args.extend(extra.iter().cloned());
    let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git(&argv)
}

/// git credential-helper protocol. git pipes key=value lines on stdin and reads key=value on stdout.
/// For `get` we emit username + password (a freshly minted signed push token). `store`/`erase` are
/// no-ops (tokens are short-lived and never cached).
fn cmd_credential(hub: &str, op: &str) -> Result<()> {
    let input = read_credential_input()?;
    match op {
        "get" => {
            // git provides protocol/host/path; we mint a repo-scoped token from the path when present,
            // else a host-wide token (the hub re-checks scope against the actual repo on push).
            let (owner, repo) = repo_from_credential(&input);
            let ident = Identity::load()?;
            let token = mint_push_token(&ident, &owner, &repo)?;
            let mut out = std::io::stdout().lock();
            writeln!(out, "username={}", ident.owner_id())?;
            writeln!(out, "password={token}")?;
            let _ = hub; // hub host already constrained the git config scope
            Ok(())
        }
        "store" | "erase" => Ok(()),
        other => bail!("unknown credential op {other:?} (expected get|store|erase)"),
    }
}

fn cmd_pr_open(hub: &str, repo: &str, head: &str, base: &str, title: &str, body: &str) -> Result<()> {
    let (owner, name) = split_owner_repo(repo)?;
    let path = format!("/repos/{owner}/{name}/pulls");
    let payload = json!({
        "title": title,
        "body": body,
        "head_ref": head,
        "base_ref": base,
    });
    let resp = signed_json(hub, "POST", &path, Some(&payload))?;
    let n = resp.get("number").and_then(|v| v.as_u64());
    match n {
        Some(n) => println!("opened PR #{n}  {head} -> {base}  ({title})"),
        None => println!("opened PR  {head} -> {base}  ({title})"),
    }
    Ok(())
}

fn cmd_pr_ls(hub: &str, repo: &str) -> Result<()> {
    let (owner, name) = split_owner_repo(repo)?;
    let path = format!("/repos/{owner}/{name}/pulls");
    let resp = public_get(hub, &path)?;
    let list = resp
        .get("pulls")
        .or_else(|| resp.get("items"))
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| resp.as_array().cloned())
        .unwrap_or_default();
    if list.is_empty() {
        println!("no pull requests");
        return Ok(());
    }
    println!("{:<5} {:<8} {:<24} {}", "#", "state", "head -> base", "title");
    for pr in &list {
        let n = pr.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
        let state = pr.get("state").and_then(|v| v.as_str()).unwrap_or("open");
        let head = pr.get("head_ref").and_then(|v| v.as_str()).unwrap_or("?");
        let base = pr.get("base_ref").and_then(|v| v.as_str()).unwrap_or("?");
        let title = pr.get("title").and_then(|v| v.as_str()).unwrap_or("");
        println!("{:<5} {:<8} {:<24} {}", n, state, format!("{head} -> {base}"), title);
    }
    Ok(())
}

fn cmd_pr_merge(hub: &str, repo: &str, number: u64) -> Result<()> {
    let (owner, name) = split_owner_repo(repo)?;
    let path = format!("/repos/{owner}/{name}/pulls/{number}/merge");
    // Sign an empty JSON object body so the signature covers a stable, non-empty payload.
    let body = json!({});
    let resp = signed_json(hub, "POST", &path, Some(&body))?;
    let sha = resp.get("merge_commit").and_then(|v| v.as_str());
    match sha {
        Some(s) => println!("merged PR #{number}  ({s})"),
        None => println!("merged PR #{number}"),
    }
    Ok(())
}

fn cmd_release(hub: &str, tag: &str, message: Option<&str>) -> Result<()> {
    // Create an annotated tag locally, then push just that tag to origin (which should be the hub).
    let msg = message.unwrap_or(tag);
    git(&["tag", "-a", tag, "-m", msg])?;
    // Push the tag to the remote named "origin". A repo cloned with ce-hub already has the hub as
    // origin; if the user uses a differently-named remote they can `git push <remote> <tag>`.
    git(&["push", "origin", tag])?;
    let _ = hub;
    println!("released {tag}");
    Ok(())
}

fn cmd_instances(hub: &str, repo: &str) -> Result<()> {
    let (owner, name) = split_owner_repo(repo)?;
    let path = format!("/repos/{owner}/{name}/instances");
    let resp = public_get(hub, &path)?;
    let list = resp
        .get("instances")
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| resp.as_array().cloned())
        .unwrap_or_default();
    if list.is_empty() {
        println!("no live instances for {owner}/{name}");
        return Ok(());
    }
    println!(
        "{:<18} {:<14} {:<8} {:<8} {}",
        "node", "release", "health", "latency", "url"
    );
    for inst in &list {
        let node = inst
            .get("node_id")
            .and_then(|v| v.as_str())
            .map(|s| s.chars().take(16).collect::<String>())
            .unwrap_or_else(|| "?".to_string());
        let release = inst
            .get("release")
            .or_else(|| inst.get("tag"))
            .and_then(|v| v.as_str())
            .unwrap_or("-");
        let healthy = match inst.get("healthy").and_then(|v| v.as_bool()) {
            Some(true) => "up",
            Some(false) => "down",
            None => "?",
        };
        let latency = inst
            .get("latency")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "-".to_string());
        let url = inst.get("url").and_then(|v| v.as_str()).unwrap_or("");
        println!("{:<18} {:<14} {:<8} {:<8} {}", node, release, healthy, latency, url);
    }
    Ok(())
}

fn cmd_mirror(hub: &str, repo: &str, upstream: &str, dir: &str) -> Result<()> {
    let (owner, name) = split_owner_repo(repo)?;
    let direction = dir.trim().to_ascii_lowercase();
    if !matches!(direction.as_str(), "in" | "out" | "both") {
        bail!("--dir must be one of: in | out | both");
    }
    let path = format!("/repos/{owner}/{name}/mirror");
    let body = json!({ "upstream": upstream, "direction": direction });
    let resp = signed_json(hub, "POST", &path, Some(&body))?;
    println!("mirror configured  {owner}/{name}  <{direction}>  {upstream}");
    if let Some(s) = resp.get("synced").and_then(|v| v.as_bool()) {
        println!("  initial sync: {}", if s { "ok" } else { "queued" });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// push capability token (the contract's wire format)
// ---------------------------------------------------------------------------

/// Mint a short-lived, repo-scoped push capability token. Wire format (verified by ce-hub's
/// git_http::verify_cap_token): base64url(JSON) of
///   { id, ts, exp, nonce, repo: "<owner>/<repo>", sig }
/// where the signed canonical string is "git-push\n<owner>/<repo>\n<ts>\n<exp>\n<nonce>".
fn mint_push_token(ident: &Identity, owner: &str, repo: &str) -> Result<String> {
    let ts = identity::unix_secs();
    let exp = ts + 300; // 5-minute lifetime, within the hub's skew tolerance
    let nonce = identity::random_nonce();
    let scope = format!("{owner}/{repo}");
    let canonical = format!("git-push\n{scope}\n{ts}\n{exp}\n{nonce}");
    let sig = ident.sign_hex(canonical.as_bytes());
    let doc = json!({
        "id": ident.pubkey_hex,
        "ts": ts,
        "exp": exp,
        "nonce": nonce,
        "repo": scope,
        "sig": sig,
    });
    let bytes = serde_json::to_vec(&doc)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

// ---------------------------------------------------------------------------
// credential-helper plumbing
// ---------------------------------------------------------------------------

/// Read git's credential key=value lines from stdin until a blank line / EOF.
fn read_credential_input() -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line.context("reading credential input")?;
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once('=') {
            out.push((k.to_string(), v.to_string()));
        }
    }
    Ok(out)
}

/// Derive owner/repo from git's credential `path` field (e.g. "git/alice/spacegame.git"). When the
/// path is absent or unparseable, returns empty strings — the token is still signed; the hub re-scopes
/// the check against the actual repo, and an empty scope will simply fail closed there.
fn repo_from_credential(input: &[(String, String)]) -> (String, String) {
    let path = input
        .iter()
        .find(|(k, _)| k == "path")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    // Path looks like "git/<owner>/<repo>.git" (the hub's git wire route).
    let trimmed = path.trim_start_matches('/');
    let parts: Vec<&str> = trimmed.split('/').collect();
    // Find "git" then take the next two segments.
    if let Some(pos) = parts.iter().position(|p| *p == "git") {
        if pos + 2 < parts.len() {
            let owner = parts[pos + 1].to_ascii_lowercase();
            let repo = parts[pos + 2].trim_end_matches(".git").to_ascii_lowercase();
            return (owner, repo);
        }
    }
    // Fallback: maybe git only handed us "<owner>/<repo>.git".
    if parts.len() >= 2 {
        let owner = parts[parts.len() - 2].to_ascii_lowercase();
        let repo = parts[parts.len() - 1].trim_end_matches(".git").to_ascii_lowercase();
        return (owner, repo);
    }
    (String::new(), String::new())
}

/// Extract the host portion of the hub URL (for scoping the credential helper config).
fn host_of(hub: &str) -> Result<String> {
    let no_scheme = hub
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(hub);
    let host = no_scheme.split('/').next().unwrap_or("");
    if host.is_empty() {
        bail!("could not determine host from hub URL {hub:?}");
    }
    Ok(host.to_string())
}
