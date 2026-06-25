//! Scatter/gather over the CE mesh — the IO layer that turns a shard plan into outcomes.
//!
//! Borrows swarm's pattern verbatim: discover docker-capable hosts from the atlas, rank them by
//! on-chain delivered work (`history`), then fan the shards out concurrently over the **rdev exec
//! protocol** (`AppRequest` topic `rdev/exec` — exec is an *app* on CE, not a node RPC; hosts run
//! `rdev serve`). Each host runs one shard's command in a sandboxed container and returns
//! `{ok, stdout, stderr, exit_code}`. Capability-gated: the `caps` token (a `ce-cap` chain
//! authorizing the `exec`/`ci:shard` ability) is forwarded with every request and verified by the
//! host before it runs anything.
//!
//! Long-running placement via directed `mesh_deploy`/`mesh_kill` (returning a job_id to poll) is the
//! documented alternative for big suites; see the TODO on [`dispatch_shard`].

use crate::report::ShardOutcome;
use crate::shard::{Shard, to_argv};
use anyhow::{Result, bail};
use ce_rs::{AtlasEntry, CeClient};
use std::collections::HashMap;
use tokio::task::JoinSet;

/// Per-shard dispatch timeout (10 minutes) — a CI shard may compile then test.
const SHARD_TIMEOUT_MS: u64 = 600_000;

/// Docker-capable hosts, optionally filtered by an extra atlas self-tag (`gpu`, `linux`, ...).
pub fn candidates(atlas: Vec<AtlasEntry>, select: &Option<String>) -> Vec<AtlasEntry> {
    atlas
        .into_iter()
        .filter(|h| h.has_tag("docker"))
        .filter(|h| select.as_ref().is_none_or(|t| h.has_tag(t)))
        .collect()
}

/// Discover candidate hosts and rank them by on-chain delivered work (most-proven first),
/// truncated to `max_hosts`. Returns the host NodeIds in placement order.
pub async fn select_hosts(
    ce: &CeClient,
    select: &Option<String>,
    max_hosts: usize,
) -> Result<Vec<String>> {
    let pool = candidates(ce.atlas().await?, select);
    if pool.is_empty() {
        bail!(
            "no matching hosts in the atlas (need a node advertising 'docker'{})",
            select.as_ref().map(|t| format!(" + '{t}'")).unwrap_or_default()
        );
    }
    let mut scored: Vec<(u64, String)> = Vec::new();
    for h in pool {
        let rep = ce.history(&h.node_id).await.map(|r| r.delivered_work()).unwrap_or(0);
        scored.push((rep, h.node_id));
    }
    scored.sort_by_key(|(rep, _)| std::cmp::Reverse(*rep)); // most-proven first
    scored.truncate(max_hosts.max(1));
    Ok(scored.into_iter().map(|(_, id)| id).collect())
}

/// Round-robin assign shards to the ranked host pool. With more shards than hosts, hosts take
/// multiple shards (sequentially per host is the node's concern; we just spread evenly here).
/// Returns `(shard, host)` pairs. Excludes a host from a shard's assignment is not done here —
/// see [`scatter`] for the re-run-on-a-different-host verification path.
pub fn assign<'a>(shards: &'a [Shard], hosts: &[String]) -> Vec<(&'a Shard, String)> {
    if hosts.is_empty() {
        return Vec::new();
    }
    shards
        .iter()
        .enumerate()
        .map(|(i, s)| (s, hosts[i % hosts.len()].clone()))
        .collect()
}

/// The rdev exec reply shape (mirrors rdev's `Resp` and swarm's `RdevResp`).
#[derive(serde::Deserialize)]
struct RdevResp {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    stdout: Option<String>,
    #[serde(default)]
    stderr: Option<String>,
    #[serde(default)]
    exit_code: Option<i64>,
}

/// Run one shard on one host over `rdev/exec`, returning its [`ShardOutcome`]. An `ok:false` reply
/// (denied cap / bad image / mesh error) becomes a `dispatch_error`; a container that ran and exited
/// non-zero is a real test failure carried in `exit_code`.
///
/// TODO(long-running): for very large suites, switch to directed `ce.mesh_deploy(host, &BidSpec,
/// grant)` which returns a job_id, then poll `ce.job(job_id)` / stream logs and `ce.mesh_kill` on
/// cancel. The exec path here is the one-shot equivalent that swarm already proves end-to-end.
pub async fn dispatch_shard(
    ce: &CeClient,
    host: &str,
    shard: &Shard,
    image: &str,
    caps: Option<&str>,
) -> ShardOutcome {
    let argv = to_argv(shard);
    let body = serde_json::to_vec(&serde_json::json!({
        "caps": caps.unwrap_or(""),
        "image": image,
        "cmd": argv,
    }))
    .unwrap_or_default();

    match ce.request(host, "rdev/exec", &body, SHARD_TIMEOUT_MS).await {
        Ok(reply) => match serde_json::from_slice::<RdevResp>(&reply) {
            Ok(r) if r.ok => ShardOutcome {
                shard_id: shard.id(),
                host: host.to_string(),
                exit_code: Some(r.exit_code.unwrap_or(0)),
                stdout: r.stdout.unwrap_or_default(),
                stderr: r.stderr.unwrap_or_default(),
                dispatch_error: None,
                verified: None,
            },
            Ok(r) => outcome_err(shard, host, r.error.unwrap_or_else(|| "remote error".into())),
            Err(e) => outcome_err(shard, host, format!("bad reply: {e}")),
        },
        Err(e) => outcome_err(shard, host, e.to_string()),
    }
}

fn outcome_err(shard: &Shard, host: &str, err: String) -> ShardOutcome {
    ShardOutcome {
        shard_id: shard.id(),
        host: host.to_string(),
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        dispatch_error: Some(err),
        verified: None,
    }
}

/// Scatter every shard across the assigned hosts concurrently and gather the outcomes. Returns the
/// outcomes keyed by `shard.id()` (one primary run per shard).
pub async fn scatter(
    ce: &CeClient,
    assignments: Vec<(&Shard, String)>,
    image: &str,
    caps: Option<&str>,
) -> Result<HashMap<String, ShardOutcome>> {
    let mut set = JoinSet::new();
    for (shard, host) in assignments {
        let ce = ce.clone();
        let shard = shard.clone();
        let image = image.to_string();
        let caps = caps.map(str::to_string);
        set.spawn(async move {
            let out = dispatch_shard(&ce, &host, &shard, &image, caps.as_deref()).await;
            (shard.id(), out)
        });
    }
    let mut outcomes = HashMap::new();
    while let Some(joined) = set.join_next().await {
        let (id, out) = joined?;
        outcomes.insert(id, out);
    }
    Ok(outcomes)
}

/// Re-run the selected canary shards on a *different* host than their primary run, for the
/// verification dial. Returns the re-run outcomes keyed by `shard.id()`. A canary shard whose
/// primary host is the only candidate is skipped (cannot verify against an independent host).
pub async fn rerun_canaries(
    ce: &CeClient,
    canaries: &[(&Shard, &str)], // (shard, primary_host) pairs
    hosts: &[String],
    image: &str,
    caps: Option<&str>,
) -> Result<HashMap<String, ShardOutcome>> {
    let mut set = JoinSet::new();
    for (shard, primary) in canaries {
        let Some(alt) = pick_alternate(hosts, primary) else { continue };
        let ce = ce.clone();
        let shard = (*shard).clone();
        let image = image.to_string();
        let caps = caps.map(str::to_string);
        set.spawn(async move {
            let out = dispatch_shard(&ce, &alt, &shard, &image, caps.as_deref()).await;
            (shard.id(), out)
        });
    }
    let mut out = HashMap::new();
    while let Some(joined) = set.join_next().await {
        let (id, o) = joined?;
        out.insert(id, o);
    }
    Ok(out)
}

/// Pick a host other than `exclude` for an independent re-run.
pub fn pick_alternate(hosts: &[String], exclude: &str) -> Option<String> {
    hosts.iter().find(|h| h.as_str() != exclude).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::shard::plan;

    fn host(id: &str, tags: &[&str]) -> AtlasEntry {
        AtlasEntry {
            node_id: id.to_string(),
            cpu_cores: 4,
            mem_mb: 8192,
            running_jobs: 0,
            last_seen_secs: 0,
            tags: tags.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn candidates_require_docker_and_match_select() {
        let atlas = vec![
            host("a", &["docker", "gpu"]),
            host("b", &["linux"]),
            host("c", &["docker"]),
        ];
        let all = candidates(atlas.clone(), &None);
        assert_eq!(all.iter().map(|h| h.node_id.as_str()).collect::<Vec<_>>(), vec!["a", "c"]);
        let gpu = candidates(atlas, &Some("gpu".into()));
        assert_eq!(gpu.iter().map(|h| h.node_id.as_str()).collect::<Vec<_>>(), vec!["a"]);
    }

    #[test]
    fn assign_round_robins_shards_over_hosts() {
        let cfg = Config::parse(
            r#"
            image = "i"
            command = "run {shard}/{total}"
            [shard]
            strategy = "count"
            total = 5
            "#,
        )
        .unwrap();
        let shards = plan(&cfg);
        let hosts = vec!["h1".to_string(), "h2".to_string()];
        let a = assign(&shards, &hosts);
        assert_eq!(a.len(), 5);
        // round-robin: h1,h2,h1,h2,h1
        assert_eq!(a[0].1, "h1");
        assert_eq!(a[1].1, "h2");
        assert_eq!(a[4].1, "h1");
    }

    #[test]
    fn assign_with_no_hosts_is_empty() {
        let cfg = Config::parse(
            r#"
            image = "i"
            command = "c"
            [shard]
            strategy = "count"
            total = 3
            "#,
        )
        .unwrap();
        assert!(assign(&plan(&cfg), &[]).is_empty());
    }

    #[test]
    fn pick_alternate_avoids_the_primary() {
        let hosts = vec!["a".to_string(), "b".to_string()];
        assert_eq!(pick_alternate(&hosts, "a"), Some("b".to_string()));
        // only one host → no independent verifier
        assert_eq!(pick_alternate(&["a".to_string()], "a"), None);
    }
}
