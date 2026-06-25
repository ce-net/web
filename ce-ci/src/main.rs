//! ce-ci CLI — split a test suite across mesh hosts, run it, aggregate the verdict.
//!
//! `ce-ci run <config>` reads a `ce-ci.toml`, expands it into shards (optionally multiplied by a
//! build matrix), discovers + ranks docker-capable hosts from the local node's atlas, scatters the
//! shards over the mesh (capability-gated), optionally re-runs a fraction on a second host to catch
//! a host reporting false-green, and prints a per-shard pass/fail report with a combined exit code.

use anyhow::{Result, bail};
use ce_ci::cache::CacheConfig;
use ce_ci::config::Config;
use ce_ci::report::{RunReport, ShardOutcome, agrees};
use ce_ci::shard::{Shard, plan};
use ce_ci::{cap, farm, verify};
use ce_rs::CeClient;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use tracing::{info, warn};

#[derive(Parser)]
#[command(name = "ce-ci", about = "Distributed sharded test/CI runner on the CE mesh", version)]
struct Cli {
    /// CE node HTTP API URL.
    #[arg(long, default_value = "http://127.0.0.1:8844", global = true)]
    node: String,
    /// Capability token (a `ce-cap` chain) authorizing the CI ability on the target hosts.
    /// For a fleet, one token rooted at a key every host honors covers them all.
    #[arg(long, global = true)]
    cap: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run a CI config: split the suite across hosts, gather results, return a combined exit code.
    Run {
        /// Path to the ce-ci.toml config.
        #[arg(default_value = "ce-ci.toml")]
        config: PathBuf,
        /// Maximum number of mesh hosts to fan out to.
        #[arg(long, default_value = "8")]
        hosts: usize,
        /// Fraction of shards to re-run on a second host for verification (0.0..=1.0).
        #[arg(long, default_value = "0.0")]
        verify: f32,
        /// Point shard build tools at a ce-cache sidecar endpoint (e.g. http://localhost:9092).
        #[arg(long)]
        cache: Option<String>,
    },
    /// Print the shard plan for a config without running anything (dry run).
    Plan {
        #[arg(default_value = "ce-ci.toml")]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ce_ci=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let ce = CeClient::new(cli.node.clone());

    match cli.cmd {
        Cmd::Plan { config } => {
            let cfg = Config::load(&config)?;
            let shards = apply_cache(plan(&cfg), cli_cache_none());
            println!("{} shard(s) across {} matrix leg(s):", shards.len(), cfg.legs().len());
            for s in &shards {
                println!("  {:<28} {}", s.id(), s.command);
            }
            Ok(())
        }
        Cmd::Run { config, hosts, verify: verify_pct, cache } => {
            run(&ce, &config, hosts, verify_pct, cache, cli.cap.as_deref()).await
        }
    }
}

/// No cache overlay for the `plan` dry run (it does not dispatch).
fn cli_cache_none() -> Option<CacheConfig> {
    None
}

/// Overlay the ce-cache env onto every shard if a cache endpoint was given.
fn apply_cache(mut shards: Vec<Shard>, cache: Option<CacheConfig>) -> Vec<Shard> {
    if let Some(cc) = cache {
        let overlay = cc.env();
        for s in &mut shards {
            for (k, v) in &overlay {
                s.env.entry(k.clone()).or_insert_with(|| v.clone());
            }
            // Re-render is unnecessary: cache env affects the environment, not the command template.
        }
    }
    shards
}

async fn run(
    ce: &CeClient,
    config: &std::path::Path,
    max_hosts: usize,
    verify_pct: f32,
    cache: Option<String>,
    cap_token: Option<&str>,
) -> Result<()> {
    let cfg = Config::load(config)?;

    // Fail fast on a malformed capability before scattering any work.
    if let Some(tok) = cap_token {
        let chain = cap::decode_token(tok)?;
        if !cap::grants_ci_ability(&chain) {
            warn!(
                "capability leaf grants none of '{}'/'{}'; hosts may deny the shards",
                cap::ABILITY_CI,
                cap::ABILITY_EXEC
            );
        }
    } else {
        warn!("no --cap token given; hosts that require a capability will deny these shards");
    }

    let cache_cfg = cache.map(CacheConfig::at);
    let shards = apply_cache(plan(&cfg), cache_cfg);
    if shards.is_empty() {
        bail!("config produced no shards");
    }
    info!(shards = shards.len(), legs = cfg.legs().len(), "planned shards");

    let hosts = farm::select_hosts(ce, &cfg.select, max_hosts).await?;
    info!(hosts = hosts.len(), "selected hosts (most-proven first)");
    for h in &hosts {
        println!("  host {}", short(h));
    }

    let assignments = farm::assign(&shards, &hosts);
    println!("\nScattering {} shard(s) across {} host(s)...\n", shards.len(), hosts.len());

    let mut primary = farm::scatter(ce, assignments, &cfg.image, cap_token).await?;

    // Verification dial: beacon-seed a canary set, re-run those shards on a different host, compare.
    if verify_pct > 0.0 {
        verify_canaries(ce, &cfg, &shards, &hosts, verify_pct, cap_token, &mut primary).await?;
    }

    // Assemble outcomes in deterministic shard order.
    let outcomes: Vec<ShardOutcome> = shards
        .iter()
        .filter_map(|s| primary.get(&s.id()).cloned())
        .collect();
    let report = RunReport::new(outcomes);

    print_report(&report);
    let code = report.combined_exit_code();
    std::process::exit(code);
}

/// Run the canary set on independent hosts and fold the verdict back into `primary` (`verified`).
async fn verify_canaries(
    ce: &CeClient,
    cfg: &Config,
    shards: &[Shard],
    hosts: &[String],
    verify_pct: f32,
    cap_token: Option<&str>,
    primary: &mut std::collections::HashMap<String, ShardOutcome>,
) -> Result<()> {
    let seed = ce.beacon().await.map(|b| b.hash).unwrap_or_default();
    let picks = verify::canary_set(shards.len(), verify_pct, &seed);
    if picks.is_empty() {
        return Ok(());
    }
    info!(canaries = picks.len(), "verification dial: re-running canary shards on a second host");

    // Pair each canary shard with its primary host so we re-run on a *different* one.
    // Collect the primary host as an owned String so the immutable borrow of `primary` ends
    // before we fold verdicts back in mutably below.
    let mut canaries: Vec<(&Shard, String)> = Vec::new();
    for &i in &picks {
        let s = &shards[i];
        if let Some(p) = primary.get(&s.id()) {
            canaries.push((s, p.host.clone()));
        }
    }
    let canary_refs: Vec<(&Shard, &str)> =
        canaries.iter().map(|(s, h)| (*s, h.as_str())).collect();
    let reruns = farm::rerun_canaries(ce, &canary_refs, hosts, &cfg.image, cap_token).await?;

    for (s, _) in &canaries {
        let id = s.id();
        let Some(re) = reruns.get(&id) else { continue };
        let Some(orig) = primary.get(&id).cloned() else { continue };
        let ok = re.dispatch_error.is_none() && agrees(&orig, re);
        if let Some(p) = primary.get_mut(&id) {
            p.verified = Some(ok);
        }
        if !ok {
            warn!(shard = %id, primary = %short(&orig.host), rerun = %short(&re.host), "DIVERGENCE: canary re-run disagreed (suspect host)");
        }
    }
    Ok(())
}

fn print_report(report: &RunReport) {
    println!();
    for o in &report.outcomes {
        let status = if let Some(e) = &o.dispatch_error {
            format!("DISPATCH-ERR ({e})")
        } else if o.passed() {
            match o.verified {
                Some(true) => "PASS (verified)".into(),
                Some(false) => "PASS but DIVERGENT (suspect)".into(),
                None => "PASS".into(),
            }
        } else {
            format!("FAIL (exit {})", o.exit_code.unwrap_or(-1))
        };
        println!("  [{:<26}] {} on {}", o.shard_id, status, short(&o.host));
    }
    println!(
        "\n{} passed, {} failed, {} dispatch-error of {} shard(s).",
        report.passed(),
        report.failed(),
        report.dispatch_errors(),
        report.total()
    );
    let suspect = report.suspect();
    if !suspect.is_empty() {
        println!("\nVerification flagged {} divergent shard(s):", suspect.len());
        for s in suspect {
            println!("  {} on {} (re-run disagreed)", s.shard_id, short(&s.host));
        }
    }
    if report.is_green() {
        println!("\nGREEN — all shards passed.");
    } else {
        println!("\nRED — see failures above.");
    }
}

fn short(node_id: &str) -> String {
    node_id[..node_id.len().min(12)].to_string()
}
