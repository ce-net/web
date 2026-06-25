//! `ce-cache` — a distributed content-addressed CI/build cache over CE.
//!
//! A thin CLI over the [`ce_cache`] library and the CE SDK (`ce-rs`). Core operations:
//!   - `ce-cache put <key> <path>`  — archive an artifact/dir, store it as a CE object, map key->CID.
//!   - `ce-cache get <key> <dest>`  — resolve key->CID (local index, then mesh), fetch + CID-verify,
//!     and restore to `<dest>`.
//!   - `ce-cache has <key>`         — is there a cache hit (locally or on the mesh)?
//!   - `ce-cache sidecar`           — run the localhost HTTP shim (Bazel CAS/AC + sccache WebDAV).
//!   - `ce-cache serve`             — run as a cache host: serve hits to authorized peers.
//!
//! Content-addressing is the integrity proof: a returned object whose CID != the requested key is
//! rejected, so cache poisoning is structurally impossible.

use std::path::PathBuf;

use anyhow::{Context, Result};
use ce_cache::index::{self, Index};
use ce_cache::store::{self, HitSource};
use ce_cache::{caps, load_roots};
use ce_rs::CeClient;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "ce-cache",
    version,
    about = "Distributed content-addressed CI/build cache over CE — content-addressing is the proof.",
    long_about = None
)]
struct Cli {
    /// CE node HTTP API base URL.
    #[arg(long, default_value = ce_rs::DEFAULT_BASE_URL, global = true)]
    api: String,

    /// Path to the key->CID index file (default: <config dir>/ce-cache/index.json).
    #[arg(long, global = true)]
    index: Option<PathBuf>,

    /// Capability chain (hex) to present to cache hosts; overrides $CE_CACHE_CAPS / config file.
    #[arg(long, global = true)]
    caps: Option<String>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Store an artifact (file or directory) under a key. Prints the object CID.
    Put {
        /// The cache key (the build tool's own action/content hash).
        key: String,
        /// Path to the file or directory to cache.
        path: PathBuf,
        /// Also push the entry to a specific cache host over the mesh (NodeId hex).
        #[arg(long)]
        host: Option<String>,
    },
    /// Fetch an artifact by key and restore it to a destination path (file or directory).
    Get {
        /// The cache key.
        key: String,
        /// Destination path to restore into.
        dest: PathBuf,
    },
    /// Check whether a cache hit exists for a key (locally or on the mesh). Exit 0 = hit, 1 = miss.
    Has {
        /// The cache key.
        key: String,
    },
    /// List local cache entries.
    Ls,
    /// Remove a key from the local index (does not force hosts to drop it).
    Rm {
        /// The cache key to forget.
        key: String,
    },
    /// Show local cache stats (entry count, footprint).
    Stats,
    /// Run the localhost HTTP shim (Bazel CAS/AC + sccache WebDAV) mapped to CE blobs.
    Sidecar {
        /// Address to bind (host:port).
        #[arg(long, default_value = "127.0.0.1:9092")]
        addr: String,
    },
    /// Run as a cache host: accept cap-gated entries, serve hits to peers.
    Serve,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    let client = CeClient::new(cli.api.clone());
    let index_path = cli.index.clone().unwrap_or_else(index::default_index_path);
    let caps_hex = caps::resolve(cli.caps.as_deref());

    match cli.cmd {
        Cmd::Put { key, path, host } => {
            cmd_put(&client, &index_path, &key, &path, host.as_deref(), &caps_hex).await
        }
        Cmd::Get { key, dest } => cmd_get(&client, &index_path, &key, &dest, &caps_hex).await,
        Cmd::Has { key } => cmd_has(&client, &index_path, &key, &caps_hex).await,
        Cmd::Ls => cmd_ls(&index_path),
        Cmd::Rm { key } => cmd_rm(&index_path, &key),
        Cmd::Stats => cmd_stats(&index_path),
        Cmd::Sidecar { addr } => cmd_sidecar(client, index_path, caps_hex, &addr).await,
        Cmd::Serve => ce_cache::host::serve(&client, load_roots(), index_path).await,
    }
}

async fn cmd_put(
    client: &CeClient,
    index_path: &std::path::Path,
    key: &str,
    path: &std::path::Path,
    host: Option<&str>,
    caps_hex: &str,
) -> Result<()> {
    let mut idx = Index::load(index_path)?;
    let entry = store::put_path(client, &mut idx, key, path).await?;
    idx.save(index_path)?;
    println!("cached {key} -> {} ({} bytes)", entry.cid, entry.size);

    if let Some(host) = host {
        match store::push_to_host(client, host, caps_hex, key, &entry.cid, entry.size, None).await {
            Ok(r) if r.accepted => {
                println!("pushed to host {} ({} bytes)", &host[..16.min(host.len())], r.stored_bytes)
            }
            Ok(r) => eprintln!("host declined: {}", r.reason.as_deref().unwrap_or("unknown")),
            Err(e) => eprintln!("push to host failed: {e}"),
        }
    } else {
        // Announce availability so mesh peers can discover this entry.
        let _ = client.advertise_service(&ce_cache::proto::service_for_key(key)).await;
    }
    Ok(())
}

async fn cmd_get(
    client: &CeClient,
    index_path: &std::path::Path,
    key: &str,
    dest: &std::path::Path,
    caps_hex: &str,
) -> Result<()> {
    let idx = Index::load(index_path)?;
    let source = store::get_to_path(client, &idx, key, caps_hex, dest)
        .await
        .with_context(|| format!("getting key '{key}'"))?;
    let from = match source {
        HitSource::Local => "local index".to_string(),
        HitSource::Mesh(h) => format!("mesh host {}", &h[..16.min(h.len())]),
        HitSource::Miss => "miss".to_string(),
    };
    println!("restored {key} -> {} (from {from})", dest.display());
    Ok(())
}

async fn cmd_has(
    client: &CeClient,
    index_path: &std::path::Path,
    key: &str,
    caps_hex: &str,
) -> Result<()> {
    let idx = Index::load(index_path)?;
    if store::has(client, &idx, key, caps_hex).await? {
        println!("HIT {key}");
        Ok(())
    } else {
        println!("MISS {key}");
        // Non-zero exit lets a build script branch on a cache miss.
        std::process::exit(1);
    }
}

fn cmd_ls(index_path: &std::path::Path) -> Result<()> {
    let idx = Index::load(index_path)?;
    if idx.is_empty() {
        println!("no cache entries ({})", index_path.display());
        return Ok(());
    }
    println!("{:<48}  {:>66}  {:>10}", "KEY", "CID", "BYTES");
    for (key, e) in &idx.entries {
        println!("{:<48}  {:>66}  {:>10}", truncate(key, 48), e.cid, e.size);
    }
    Ok(())
}

fn cmd_rm(index_path: &std::path::Path, key: &str) -> Result<()> {
    let mut idx = Index::load(index_path)?;
    match idx.remove(key) {
        Some(_) => {
            idx.save(index_path)?;
            println!("removed {key} from the cache index");
            Ok(())
        }
        None => {
            eprintln!("{key} is not in the cache index");
            std::process::exit(1);
        }
    }
}

fn cmd_stats(index_path: &std::path::Path) -> Result<()> {
    let idx = Index::load(index_path)?;
    println!("entries: {}", idx.len());
    println!("footprint: {} bytes", idx.total_bytes());
    println!("index: {}", index_path.display());
    Ok(())
}

async fn cmd_sidecar(
    client: CeClient,
    index_path: PathBuf,
    caps_hex: String,
    addr: &str,
) -> Result<()> {
    let socket: std::net::SocketAddr = addr.parse().with_context(|| format!("parsing addr '{addr}'"))?;
    let sidecar = ce_cache::sidecar::Sidecar::new(client, index_path, caps_hex)?;
    println!("ce-cache sidecar on http://{socket}");
    println!("  Bazel:   build --remote_cache=http://{socket}");
    println!("  sccache: SCCACHE_WEBDAV_ENDPOINT=http://{socket}/dav");
    sidecar.serve(socket).await
}

/// Truncate a string to `n` chars with an ellipsis, for table display.
fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n.saturating_sub(1)])
    }
}

/// Initialize tracing once; level from `$RUST_LOG`, defaulting to `info`.
fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_target(false).try_init();
}
