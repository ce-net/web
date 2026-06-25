//! # ce-ci — distributed sharded test/CI runner on the CE mesh
//!
//! A thin SDK-tier app (like `swarm`, `rdev`, `ce-pin`) that splits a test suite / job matrix across
//! mesh hosts and gathers the results. It talks to a *local* CE node via [`ce_rs::CeClient`] and to
//! remote hosts over the mesh (`request`/`reply` on the `rdev/exec` app protocol). Authorization is
//! one primitive: a signed, attenuating [`ce_cap`] chain the host verifies before running anything.
//!
//! The library is split into a **pure core** (no IO, fully unit-tested without a cluster) and a
//! **mesh layer**:
//!
//! - [`config`] — parse `ce-ci.toml` (image, command, shard strategy, matrix).
//! - [`shard`] — expand a config into the flat list of shards to scatter (the splitting logic).
//! - [`report`] — aggregate per-shard outcomes into a verdict + combined exit code (the aggregation
//!   logic), plus divergence tally for the verification dial.
//! - [`verify`] — beacon-seeded canary-set selection for re-running shards on a second host.
//! - [`cache`] — optional ce-cache integration (env wiring for shared dep/build artifacts).
//! - [`cap`] — client-side capability-token decode/validation.
//! - [`farm`] — discover, rank, assign, scatter/gather over the mesh (the IO layer).

pub mod cache;
pub mod cap;
pub mod config;
pub mod farm;
pub mod report;
pub mod shard;
pub mod verify;
