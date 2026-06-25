//! `ce-bucket` — CLI for geo/owner-diverse replicated bucket storage on CE.
//!
//! A thin shell over [`ce_bucket::ReplicatedStore`]. It composes ce-storage (the bucket/object
//! namespace) with ce-pin (fault-domain-diverse replication + proof-of-retrievability + paid
//! auto-repair); this binary just parses arguments and prints results.
//!
//! Subcommands:
//!   * `mb <bucket> [--factor N]`        — make a bucket, optionally setting its replication policy.
//!   * `put <bucket> <key> <file> [-r N]`— store + replicate an object (factor: -r > policy > default).
//!   * `get <bucket> <key> [-o out]`     — fetch an object (CID-verified, mesh-aware), to stdout/file.
//!   * `ls <bucket> [--prefix P]`        — list objects and their replica counts.
//!   * `maintain`                        — one audit + auto-repair pass over every tracked object.

use std::path::PathBuf;

use anyhow::{Context, Result};
use ce_bucket::{ReplicatedStore, DEFAULT_REPLICATION_FACTOR};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "ce-bucket", about = "Geo/owner-diverse replicated bucket storage on CE", version)]
struct Cli {
    /// Default replication factor for buckets without a policy.
    #[arg(long, default_value_t = DEFAULT_REPLICATION_FACTOR, global = true)]
    factor: u8,

    /// Capability chain hex presented to pinning hosts (defaults to --caps/env/file via ce-pin).
    #[arg(long, global = true)]
    caps: Option<String>,

    /// Override the ce-storage bucket index path.
    #[arg(long, global = true)]
    storage_index: Option<PathBuf>,

    /// Override the ce-bucket replica index path.
    #[arg(long, global = true)]
    replica_index: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Make a bucket, optionally setting its replication policy.
    Mb {
        bucket: String,
        /// Replication factor policy for this bucket (defaults to the store default).
        #[arg(long)]
        factor: Option<u8>,
    },
    /// Store and replicate an object.
    Put {
        bucket: String,
        key: String,
        /// Local file to upload.
        file: PathBuf,
        /// Replication factor for this object (overrides the bucket policy / default).
        #[arg(short = 'r', long)]
        replication: Option<u8>,
        /// Content type (defaults to application/octet-stream).
        #[arg(long, default_value = "application/octet-stream")]
        content_type: String,
    },
    /// Fetch an object (CID-verified, mesh-aware).
    Get {
        bucket: String,
        key: String,
        /// Write to this file instead of stdout.
        #[arg(short = 'o', long)]
        out: Option<PathBuf>,
    },
    /// List objects in a bucket with their replica counts.
    Ls {
        bucket: String,
        /// Key prefix filter.
        #[arg(long, default_value = "")]
        prefix: String,
        /// Maximum keys to return.
        #[arg(long, default_value_t = 1000)]
        max_keys: usize,
    },
    /// Run one audit + auto-repair pass over every tracked object.
    Maintain,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    let storage_index = cli
        .storage_index
        .clone()
        .unwrap_or_else(ce_storage::index::default_index_path);
    let replica_index = cli
        .replica_index
        .clone()
        .unwrap_or_else(ce_bucket::index::ReplicaIndex::default_path);
    // Resolve the capability chain via ce-pin (--caps flag, then $CE_PIN_CAPS, then caps file).
    let caps = ce_pin::caps::resolve(cli.caps.as_deref());

    let mut store = ReplicatedStore::open(storage_index, replica_index, caps)?
        .with_default_factor(cli.factor);

    match cli.cmd {
        Cmd::Mb { bucket, factor } => {
            store.make_bucket(&bucket, factor)?;
            let f = factor.unwrap_or(cli.factor);
            println!("created bucket {bucket} (replication factor {f})");
        }
        Cmd::Put { bucket, key, file, replication, content_type } => {
            let bytes = std::fs::read(&file)
                .with_context(|| format!("reading {}", file.display()))?;
            let report = store
                .put_object(&bucket, &key, &bytes, &content_type, replication)
                .await?;
            println!(
                "put {bucket}/{key}\n  cid:     {}\n  size:    {} bytes\n  factor:  {}\n  placed:  {} replica(s){}",
                report.cid,
                report.bytes_len,
                report.replication_factor,
                report.replica_hosts.len(),
                if report.replica_hosts.len() < report.replication_factor as usize {
                    "  (under-replicated; run `ce-bucket maintain` to top up)"
                } else {
                    ""
                },
            );
            for h in &report.replica_hosts {
                println!("    - {}", &h[..16.min(h.len())]);
            }
        }
        Cmd::Get { bucket, key, out } => {
            let bytes = store.get_object(&bucket, &key).await?;
            match out {
                Some(path) => {
                    std::fs::write(&path, &bytes)
                        .with_context(|| format!("writing {}", path.display()))?;
                    println!("wrote {} bytes to {}", bytes.len(), path.display());
                }
                None => {
                    use std::io::Write;
                    std::io::stdout().write_all(&bytes)?;
                }
            }
        }
        Cmd::Ls { bucket, prefix, max_keys } => {
            let page = store.list_objects(&bucket, &prefix, max_keys)?;
            for (key, meta) in &page.keys {
                let replicas = store
                    .index()
                    .get_record(&bucket, key)
                    .map(|r| format!("{}/{}", r.replica_hosts.len(), r.replication_factor))
                    .unwrap_or_else(|| "-/-".to_string());
                println!("{key}\t{} bytes\treplicas {replicas}", meta.size);
            }
            for cp in &page.common_prefixes {
                println!("{cp}/");
            }
        }
        Cmd::Maintain => {
            let report = store.maintain().await?;
            println!(
                "maintain: {} checked, {} repaired, {} replicas added, {} unhealthy",
                report.objects_checked,
                report.objects_repaired,
                report.replicas_added,
                report.replicas_unhealthy,
            );
        }
    }

    Ok(())
}
