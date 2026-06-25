//! # ce-bucket — geo/owner-diverse replicated bucket storage on CE
//!
//! ce-bucket is an **application built on CE primitives** (the SDK/app tier, like `ce-storage` /
//! `ce-pin` / `swarm` / `rdev`), not a node feature. It is the **durable bucket primitive** other
//! apps depend on, and it does its job by **composing two existing apps** rather than re-implementing
//! anything:
//!
//! | Concern                                  | Provided by (composed, not reinvented)                         |
//! |------------------------------------------|----------------------------------------------------------------|
//! | Bucket / object **namespace**, `key -> CID` binding, S3 verbs, ranged reads, versioning | [`ce_storage::Store`] |
//! | **Replication** to N hosts across distinct fault domains (region/zone/ASN/owner) | [`ce_pin::placement::select`] (called inside [`ce_pin::client::replicate`]) |
//! | **Proof-of-retrievability** audits + cheap status probes | [`ce_pin::client::audit_replica`] / [`ce_pin::client::probe_status`] |
//! | **Payment** for pins (rent channels) | wired by [`ce_pin::client::replicate`] over CE payment channels |
//! | **Auto-repair** shortfall decision | [`ce_pin::repair::repair_plan`] |
//! | Mesh-native discovery / instance selection | `ce-rs` (`find_service` + atlas + history; `ce_rs::locate` for service selection) |
//!
//! The **only** new state ce-bucket owns is the [`index::ReplicaIndex`]: the durable binding from a
//! namespace coordinate `(bucket, key)` to its replication facts `{cid, replica_hosts, expiry}`, plus
//! a per-bucket [`index::BucketPolicy`] (the replication factor). ce-storage knows `key -> CID`;
//! ce-pin knows `cid -> replicas`; ce-bucket is the thin layer that ties *bucket/key intent* to
//! *replication actuation* and triggers maintenance.
//!
//! ## Mesh-first
//! Every cross-host action — discovering hosts, offering pins, opening rent channels, auditing,
//! fetching a missing object by CID — flows through `ce-rs` (libp2p request/reply, DHT, payment
//! channels) inside the ce-pin/ce-storage calls. ce-bucket opens no side HTTP channel and stores no
//! ip:port.
//!
//! ```no_run
//! use ce_bucket::ReplicatedStore;
//! # async fn demo() -> anyhow::Result<()> {
//! let mut store = ReplicatedStore::open(
//!     ce_storage::index::default_index_path(),
//!     ce_bucket::index::ReplicaIndex::default_path(),
//!     String::new(), // capability chain hex (empty = self-rooted hosts only)
//! )?;
//! store.make_bucket("backups", Some(3))?;        // 3-way, fault-domain-diverse
//! store.put_object("backups", "db.sql", b"...", "application/sql", None).await?;
//! let bytes = store.get_object("backups", "db.sql").await?; // CID-verified, mesh-aware
//! let report = store.maintain().await?;          // audit + auto-repair to the factor
//! # let _ = (bytes, report); Ok(())
//! # }
//! ```

pub mod index;
pub mod store;

pub use index::{BucketPolicy, RecordEntry, ReplicaIndex};
pub use store::{
    expiry_height_from, MaintainReport, PutReport, ReplicatedStore, DEFAULT_LEASE_BLOCKS,
    DEFAULT_RENT_PER_GB_HOUR, DEFAULT_REPLICATION_FACTOR,
};
