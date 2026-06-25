//! `ce-adapter` CLI — run the serve-side runtime, or drive adapters from the control plane.
//!
//!   ce-adapter serve   [--public-base URL] [--node URL] [--roots FILE]
//!   ce-adapter ingest  --host NODE --encoder NODE --port N [--instance ID] [--cap TOKEN]
//!   ce-adapter stop    --host NODE --instance ID [--cap TOKEN]
//!   ce-adapter status  --host NODE [--cap TOKEN]
//!   ce-adapter grant   --to NODE --abilities a,b [--expires-secs N]   (mint a capability token)

use anyhow::{Context, Result, anyhow};
use ce_rs::CeClient;
use clap::{Parser, Subcommand};

use ce_adapter::caps;
use ce_adapter::serve::{Runtime, ServeConfig, serve_loop};
use ce_adapter::spawn::{SpawnClient, instance_id};

#[derive(Parser)]
#[command(name = "ce-adapter", about = "Dynamically-spawned mesh adapters (WebRTC↔mesh bridges)")]
struct Cli {
    /// Local CE node API base URL.
    #[arg(long, global = true, default_value = "http://127.0.0.1:8844")]
    node: String,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the adapter runtime: answer control requests and own running instances.
    Serve {
        /// Public TLS base the adapter edge (WHIP/WHEP) is fronted by.
        #[arg(long, default_value = "https://cast.ce-net.com")]
        public_base: String,
        /// File of accepted capability root node ids (64-hex, one per line). Own id always accepted.
        #[arg(long)]
        roots: Option<String>,
    },
    /// Start a webrtc-ingest adapter on a host whose media tunnels to an encoder node.
    Ingest {
        /// Host node id running `ce-adapter serve` (64-hex).
        #[arg(long)]
        host: String,
        /// Encoder node id the media tunnel targets (64-hex).
        #[arg(long)]
        encoder: String,
        /// Remote tunnel port on the encoder.
        #[arg(long)]
        port: u16,
        /// Instance id (default: derived from encoder+port).
        #[arg(long)]
        instance: Option<String>,
        /// Capability token (hex chain) granting adapter:spawn on the host.
        #[arg(long, default_value = "")]
        cap: String,
        /// Public base used to surface the endpoint URL.
        #[arg(long, default_value = "https://cast.ce-net.com")]
        public_base: String,
    },
    /// Stop a running adapter instance.
    Stop {
        #[arg(long)]
        host: String,
        #[arg(long)]
        instance: String,
        #[arg(long, default_value = "")]
        cap: String,
    },
    /// List a host's running adapter instances.
    Status {
        #[arg(long)]
        host: String,
        #[arg(long, default_value = "")]
        cap: String,
    },
    /// Mint a capability token authorizing a node to use/spawn adapters. Signs with the local
    /// node identity at `<data-dir>/identity` (default ~/.local/share/ce/identity).
    Grant {
        /// Audience node id (64-hex) the token is for.
        #[arg(long)]
        to: String,
        /// Comma-separated abilities (e.g. adapter:spawn,adapter:webrtc-ingest).
        #[arg(long)]
        abilities: String,
        /// Expiry in seconds from now (0 = never).
        #[arg(long, default_value_t = 0)]
        expires_secs: u64,
        /// Nonce naming this grant (for later revocation).
        #[arg(long, default_value_t = 1)]
        nonce: u64,
        /// Data dir holding the signing identity.
        #[arg(long)]
        data_dir: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("CE_ADAPTER_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).with_target(false).init();

    let cli = Cli::parse();
    let ce = CeClient::new(cli.node.clone());

    match cli.cmd {
        Cmd::Serve { public_base, roots } => cmd_serve(ce, public_base, roots).await,
        Cmd::Ingest { host, encoder, port, instance, cap, public_base } => {
            let inst = instance.unwrap_or_else(|| instance_id("adapter", &encoder, port));
            let spawn = SpawnClient::new(ce, public_base);
            let ep = spawn.ingest(&host, &inst, &encoder, port, &cap).await?;
            println!("{}", serde_json::to_string_pretty(&ep)?);
            Ok(())
        }
        Cmd::Stop { host, instance, cap } => {
            SpawnClient::new(ce, "").stop(&host, &instance, &cap).await?;
            println!("stopped {instance}");
            Ok(())
        }
        Cmd::Status { host, cap } => {
            let s = SpawnClient::new(ce, "").status(&host, &cap).await?;
            println!("{}", serde_json::to_string_pretty(&s)?);
            Ok(())
        }
        Cmd::Grant { to, abilities, expires_secs, nonce, data_dir } => {
            cmd_grant(to, abilities, expires_secs, nonce, data_dir)
        }
    }
}

async fn cmd_serve(ce: CeClient, public_base: String, roots: Option<String>) -> Result<()> {
    // The runtime's self id must equal the running node's id, so caps self-issued by the node
    // verify. Read it from the live node rather than coupling to a key file path.
    let status = ce.status().await.context("querying local node /status (is `ce start` running?)")?;
    let self_id: ce_identity::NodeId = hex::decode(&status.node_id)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| anyhow!("node /status returned a malformed node id"))?;

    let mut accepted_roots = Vec::new();
    if let Some(path) = roots {
        let text = std::fs::read_to_string(&path).with_context(|| format!("reading roots file {path}"))?;
        for line in text.lines() {
            let l = line.trim();
            if l.is_empty() || l.starts_with('#') {
                continue;
            }
            let id: ce_identity::NodeId = hex::decode(l)
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| anyhow!("roots file has a non-64-hex line: {l}"))?;
            accepted_roots.push(id);
        }
    }

    let runtime = Runtime::new(self_id, ServeConfig { roots: accepted_roots, self_tags: vec![], public_base });
    tracing::info!(node = %runtime.self_id_hex(), "ce-adapter serve: answering {}", ce_adapter::CONTROL_TOPIC);
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("shutdown signal; stopping");
    };
    serve_loop(&ce, &runtime, shutdown).await
}

fn cmd_grant(to: String, abilities: String, expires_secs: u64, nonce: u64, data_dir: Option<String>) -> Result<()> {
    let dir = data_dir
        .map(std::path::PathBuf::from)
        .or_else(|| dirs_data_dir().map(|d| d.join("ce").join("identity")))
        .ok_or_else(|| anyhow!("could not resolve a data dir; pass --data-dir"))?;
    let identity = ce_identity::Identity::load_or_generate(&dir)
        .with_context(|| format!("loading signing identity from {}", dir.display()))?;
    let audience: ce_identity::NodeId = hex::decode(&to)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| anyhow!("--to must be a 64-hex node id"))?;
    let abil: Vec<&str> = abilities.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if abil.is_empty() {
        return Err(anyhow!("--abilities must list at least one ability"));
    }
    let not_after = if expires_secs == 0 {
        0
    } else {
        now_secs().saturating_add(expires_secs)
    };
    let token = caps::grant(&identity, audience, &abil, ce_cap::Resource::Node(identity.node_id()), not_after, nonce);
    println!("{token}");
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn dirs_data_dir() -> Option<std::path::PathBuf> {
    if let Ok(x) = std::env::var("XDG_DATA_HOME") {
        if !x.trim().is_empty() {
            return Some(std::path::PathBuf::from(x));
        }
    }
    std::env::var("HOME").ok().map(|h| std::path::PathBuf::from(h).join(".local").join("share"))
}
