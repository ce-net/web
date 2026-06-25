//! Optional ce-cache integration — share build/dep artifacts across shards fleet-wide.
//!
//! ce-ci sits on top of ce-cache (#2 in the portfolio): a content-addressed remote build cache
//! backed by CE blobs. When enabled, each shard's container points its build tool at a local
//! ce-cache sidecar so dependency/object artifacts are fetched from the mesh once and reused by
//! every other shard and every other machine — instead of every shard recompiling cold.
//!
//! The wiring is purely environmental: the build tool's existing remote-cache knobs are set to the
//! sidecar endpoint, so neither Bazel/sccache nor the shard command need CE awareness. This module
//! produces that env overlay; it does not run the sidecar (that is ce-cache's `sidecar` command).

use std::collections::BTreeMap;

/// Where the per-host ce-cache sidecar listens, and which tools to wire to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheConfig {
    /// The localhost sidecar endpoint inside the shard container, e.g. `http://localhost:9092`.
    pub endpoint: String,
    /// Wire Bazel (`--remote_cache`) via the `BAZEL_REMOTE_CACHE` hint env.
    pub bazel: bool,
    /// Wire sccache (`SCCACHE_WEBDAV_ENDPOINT`).
    pub sccache: bool,
}

impl CacheConfig {
    /// A cache config pointing at the default sidecar port (9092) wiring both supported tools.
    pub fn at(endpoint: impl Into<String>) -> Self {
        CacheConfig { endpoint: endpoint.into(), bazel: true, sccache: true }
    }

    /// The env overlay that points the shard's build tools at the ce-cache sidecar. Merged into the
    /// matrix env before dispatch (see the run pipeline). Tool-specific keys are only emitted when
    /// that tool is enabled, so an unrelated suite is never handed knobs it does not understand.
    ///
    /// TODO(sidecar-lifecycle): ensure a ce-cache sidecar is actually reachable at `endpoint` from
    /// inside the container (host-network or a staged sidecar) before relying on a hit-rate gain.
    /// Today this only sets the env; the operator runs `ce-cache sidecar` alongside the host.
    pub fn env(&self) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        if self.bazel {
            env.insert("BAZEL_REMOTE_CACHE".into(), self.endpoint.clone());
        }
        if self.sccache {
            env.insert("SCCACHE_WEBDAV_ENDPOINT".into(), self.endpoint.clone());
            // sccache must be the active compiler wrapper for the WebDAV endpoint to be used.
            env.insert("RUSTC_WRAPPER".into(), "sccache".into());
        }
        env
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_wires_both_tools_by_default() {
        let env = CacheConfig::at("http://localhost:9092").env();
        assert_eq!(env.get("SCCACHE_WEBDAV_ENDPOINT").map(String::as_str), Some("http://localhost:9092"));
        assert_eq!(env.get("BAZEL_REMOTE_CACHE").map(String::as_str), Some("http://localhost:9092"));
        assert_eq!(env.get("RUSTC_WRAPPER").map(String::as_str), Some("sccache"));
    }

    #[test]
    fn disabled_tools_are_omitted() {
        let cfg = CacheConfig { endpoint: "http://localhost:9092".into(), bazel: false, sccache: false };
        assert!(cfg.env().is_empty());
    }
}
