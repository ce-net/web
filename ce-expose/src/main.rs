//! `ce-expose` — ngrok-style tunnels over CE.
//!
//! A thin CLI over the [`ce_expose`] library and the CE SDK (`ce-rs`). On the origin, run
//! `ce-expose http 3000 --name leif` (or `tcp 22`) to expose a local service to mesh peers,
//! capability-gated. On a consumer, `ce-expose connect leif 8080` resolves the endpoint and surfaces
//! it as a local port that bridges to the origin over the mesh.
//!
//! Public HTTP ingress on the relay (`https://<name>.ce-net.com`) is a separate relay-tier feature,
//! designed in `docs/public-ingress.md`; this CLI is the no-node-change, private-mesh half.

use anyhow::{Result, anyhow};
use ce_expose::proto::Kind;
use ce_expose::{agent, caps, consumer, load_roots};
use ce_rs::CeClient;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "ce-expose",
    version,
    about = "Expose a local service to mesh peers over the CE tunnel primitive — capability-gated.",
    long_about = None
)]
struct Cli {
    /// CE node HTTP API base URL.
    #[arg(long, default_value = ce_rs::DEFAULT_BASE_URL, global = true)]
    api: String,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Expose a local HTTP service on `port` to mesh peers holding an `expose:dial` capability.
    Http {
        /// The local TCP port your HTTP service listens on.
        port: u16,
        /// Endpoint name advertised on the DHT (and claimed on-chain) so peers can dial by name.
        #[arg(long)]
        name: Option<String>,
    },
    /// Expose a raw local TCP port (ssh, postgres, ...) to mesh peers holding an `expose:dial` cap.
    Tcp {
        /// The local TCP port to expose.
        port: u16,
        /// Endpoint name advertised on the DHT (and claimed on-chain) so peers can dial by name.
        #[arg(long)]
        name: Option<String>,
    },
    /// Dial a peer's exposed endpoint and surface it as a local TCP port on this machine.
    Connect {
        /// The endpoint to reach: a claimed name or a 64-hex NodeId.
        target: String,
        /// The local port to bind on this machine (`127.0.0.1:<port>`).
        local_port: u16,
        /// Capability chain (hex) granting `expose:dial`; overrides $CE_EXPOSE_CAPS / config file.
        #[arg(long)]
        caps: Option<String>,
    },
    /// Probe an exposed endpoint for liveness + that your capability is accepted.
    Ping {
        /// The endpoint to probe: a claimed name or a 64-hex NodeId.
        target: String,
        /// Capability chain (hex) granting `expose:dial`; overrides $CE_EXPOSE_CAPS / config file.
        #[arg(long)]
        caps: Option<String>,
    },
    /// List endpoints this node advertises on the DHT (best-effort discovery view).
    Ls,

    /// Relay-tier public HTTP ingress (the hardened relay only; default-deny, opt-in capability).
    ///
    /// Binds `127.0.0.1:<listen>` for nginx/Cloudflare to front, and bridges public requests to mesh
    /// origins that the operator has explicitly registered in `--config`. Built only with
    /// `--features ingress`.
    #[cfg(feature = "ingress")]
    Ingress {
        /// Local bind address (front it with nginx/Cloudflare; never bind a public interface).
        #[arg(long, default_value = "127.0.0.1:8855")]
        listen: String,
        /// Path to the operator-curated endpoint policy TOML. Missing/empty => zero routes.
        #[arg(long)]
        config: String,
        /// Hard-disable all ingress at startup (also toggleable at runtime via the kill file).
        #[arg(long)]
        kill_switch: bool,
        /// Kill-file path; `touch`ing it disables all ingress without a restart. Defaults to
        /// `<config dir>/ingress.kill`.
        #[arg(long)]
        kill_file: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();
    let client = CeClient::new(cli.api);

    match cli.cmd {
        Cmd::Http { port, name } => {
            let cfg = agent::ExposeConfig {
                local_port: port,
                name: endpoint_name(name, port),
                kind: Kind::Http,
            };
            println!(
                "ce-expose: exposing http://127.0.0.1:{port} as endpoint '{}' (capability-gated; share an expose:dial cap to grant access)",
                cfg.name
            );
            agent::serve(&client, cfg, load_roots()).await
        }
        Cmd::Tcp { port, name } => {
            let cfg = agent::ExposeConfig {
                local_port: port,
                name: endpoint_name(name, port),
                kind: Kind::Tcp,
            };
            println!(
                "ce-expose: exposing tcp 127.0.0.1:{port} as endpoint '{}' (capability-gated)",
                cfg.name
            );
            agent::serve(&client, cfg, load_roots()).await
        }
        Cmd::Connect { target, local_port, caps } => {
            let caps = caps::resolve(caps.as_deref());
            let origin = consumer::resolve_target(&client, &target).await?;
            println!(
                "ce-expose: 127.0.0.1:{local_port} -> endpoint '{target}' on {} (over the mesh)",
                short(&origin)
            );
            if caps.is_empty() {
                tracing::warn!(
                    "no capability configured (--caps / $CE_EXPOSE_CAPS / config); the origin will deny the dial"
                );
            }
            consumer::connect(&client, &origin, &target, local_port, &caps).await
        }
        Cmd::Ping { target, caps } => {
            let caps = caps::resolve(caps.as_deref());
            let origin = consumer::resolve_target(&client, &target).await?;
            let resp = consumer::ping(&client, &origin, &target, &caps).await?;
            if resp.alive {
                println!(
                    "alive: endpoint '{target}' on {} (kind={})",
                    short(&origin),
                    resp.kind.as_deref().unwrap_or("?")
                );
                Ok(())
            } else {
                Err(anyhow!("endpoint '{target}' did not confirm liveness (cap rejected or down)"))
            }
        }
        Cmd::Ls => {
            // Discovery is best-effort: we cannot enumerate our own advertisements directly, so we
            // surface what the DHT returns for the host-service marker as a hint. A richer local
            // registry of active endpoints is a follow-up.
            let status = client.status().await?;
            println!("this node: {}", short(&status.node_id));
            println!(
                "(ce-expose does not yet keep a local endpoint registry; run `ce-expose ping <name>` to test a specific endpoint)"
            );
            Ok(())
        }
        #[cfg(feature = "ingress")]
        Cmd::Ingress { listen, config, kill_switch, kill_file } => {
            use ce_expose::ingress;
            use ce_expose::ingress_config::IngressConfig;
            use std::path::PathBuf;

            let listen: std::net::SocketAddr =
                listen.parse().map_err(|e| anyhow!("invalid --listen '{listen}': {e}"))?;
            let cfg_path = PathBuf::from(&config);
            let cfg = IngressConfig::load(&cfg_path)?;
            let kill_file = kill_file.map(PathBuf::from).unwrap_or_else(|| {
                cfg_path.parent().unwrap_or_else(|| std::path::Path::new(".")).join("ingress.kill")
            });
            println!(
                "ce-expose ingress: {listen} ({} approved routes, default-deny); kill file: {}",
                cfg.endpoints.len(),
                kill_file.display()
            );
            ingress::serve(&client, listen, cfg, load_roots(), kill_switch, kill_file).await
        }
    }
}

/// Default the endpoint name to `port-<n>` when the user did not pass `--name`. The on-chain name
/// rules (3-32 chars, lowercase a-z/0-9/hyphen) are satisfied by this default.
fn endpoint_name(name: Option<String>, port: u16) -> String {
    name.unwrap_or_else(|| format!("port-{port}"))
}

/// Shorten a 64-hex NodeId for human-facing output.
fn short(node_hex: &str) -> String {
    let n = 16.min(node_hex.len());
    format!("{}…", &node_hex[..n])
}
