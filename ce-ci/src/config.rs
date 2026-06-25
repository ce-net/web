//! `ce-ci.toml` — the CI run configuration.
//!
//! A small, declarative description of *what* to run and *how to split it*: the toolchain image,
//! the per-shard command template, the shard strategy (how many slices and how each slice is
//! derived), and an optional build matrix (a cartesian product of env dimensions, each producing
//! its own fan-out). Money/billing is intentionally *not* in this file — it is a CLI flag, and the
//! SDK carries amounts as base-unit decimal strings, never floats.
//!
//! Example:
//!
//! ```toml
//! image = "ce-net/rust:1.x"
//! command = "cargo nextest run --partition count:{shard}/{total}"
//! select = "docker"          # atlas tag a host must advertise
//!
//! [shard]
//! strategy = "count"          # split into a fixed number of slices
//! total = 8
//!
//! # OR split by explicit units (test files / packages):
//! # strategy = "list"
//! # units = ["crate-a", "crate-b", "crate-c"]
//!
//! [[matrix]]
//! name = "linux-stable"
//! env = { TOOLCHAIN = "stable", OS = "linux" }
//! ```

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// A parsed `ce-ci.toml`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Config {
    /// Container image the shards run in. Should be a pinned, content-addressed toolchain image —
    /// determinism is load-bearing for cache hit-rate and verification (a non-reproducible build
    /// makes a real flaky test indistinguishable from a lying host).
    pub image: String,

    /// Per-shard command template. The placeholders `{shard}`, `{total}` and `{unit}` are
    /// substituted per shard before dispatch (see [`crate::shard::render_command`]).
    pub command: String,

    /// Atlas capability self-tag a host must advertise to be a candidate (e.g. `docker`, `gpu`).
    /// `docker` is always additionally required (a host must run containers to take a shard).
    #[serde(default)]
    pub select: Option<String>,

    /// How to split the suite into shards.
    pub shard: ShardSpec,

    /// Optional build matrix: each entry fans the whole shard set out again with its own env.
    /// Empty = a single (unnamed, empty-env) matrix leg.
    #[serde(default)]
    pub matrix: Vec<MatrixLeg>,
}

/// The shard-splitting strategy.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "strategy", rename_all = "lowercase")]
pub enum ShardSpec {
    /// Split into a fixed `total` number of index slices `1..=total`. The runner (nextest /
    /// pytest-shard / jest) does the actual partitioning by index inside the container.
    Count { total: u32 },
    /// Split by an explicit list of units (test files, packages, suites) — one shard per unit.
    List { units: Vec<String> },
}

/// One leg of a build matrix — an env overlay applied to every shard in this leg.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct MatrixLeg {
    /// Human label for the leg (used in reports). Defaults to a render of its env.
    #[serde(default)]
    pub name: Option<String>,
    /// Environment variables overlaid on the shards of this leg.
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

impl Config {
    /// Parse a `ce-ci.toml` from its text.
    pub fn parse(text: &str) -> Result<Config> {
        let cfg: Config = toml::from_str(text).context("parsing ce-ci.toml")?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Load and parse a `ce-ci.toml` from a path.
    pub fn load(path: &std::path::Path) -> Result<Config> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        Config::parse(&text)
    }

    /// Reject configs that cannot produce a sane run.
    pub fn validate(&self) -> Result<()> {
        if self.image.trim().is_empty() {
            bail!("config: `image` must not be empty");
        }
        if self.command.trim().is_empty() {
            bail!("config: `command` must not be empty");
        }
        match &self.shard {
            ShardSpec::Count { total } => {
                if *total == 0 {
                    bail!("config: shard count `total` must be >= 1");
                }
            }
            ShardSpec::List { units } => {
                if units.is_empty() {
                    bail!("config: shard list `units` must not be empty");
                }
            }
        }
        Ok(())
    }

    /// The matrix legs to run, guaranteeing at least one (an empty default leg) so a config with no
    /// `[[matrix]]` still produces exactly one fan-out.
    pub fn legs(&self) -> Vec<MatrixLeg> {
        if self.matrix.is_empty() {
            vec![MatrixLeg { name: Some("default".into()), env: Default::default() }]
        } else {
            self.matrix.clone()
        }
    }
}

impl MatrixLeg {
    /// A stable display label for this leg.
    pub fn label(&self) -> String {
        if let Some(n) = &self.name {
            return n.clone();
        }
        if self.env.is_empty() {
            return "default".into();
        }
        self.env.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_count_strategy() {
        let cfg = Config::parse(
            r#"
            image = "ce-net/rust:1.x"
            command = "cargo nextest run --partition count:{shard}/{total}"
            select = "docker"
            [shard]
            strategy = "count"
            total = 8
            "#,
        )
        .unwrap();
        assert_eq!(cfg.image, "ce-net/rust:1.x");
        assert_eq!(cfg.select.as_deref(), Some("docker"));
        assert_eq!(cfg.shard, ShardSpec::Count { total: 8 });
        // no matrix → exactly one default leg
        assert_eq!(cfg.legs().len(), 1);
        assert_eq!(cfg.legs()[0].label(), "default");
    }

    #[test]
    fn parses_list_strategy() {
        let cfg = Config::parse(
            r#"
            image = "alpine:latest"
            command = "sh -c 'run {unit}'"
            [shard]
            strategy = "list"
            units = ["pkg-a", "pkg-b", "pkg-c"]
            "#,
        )
        .unwrap();
        assert_eq!(cfg.shard, ShardSpec::List { units: vec!["pkg-a".into(), "pkg-b".into(), "pkg-c".into()] });
    }

    #[test]
    fn parses_matrix() {
        let cfg = Config::parse(
            r#"
            image = "ce-net/rust:1.x"
            command = "cargo test"
            [shard]
            strategy = "count"
            total = 2

            [[matrix]]
            name = "stable"
            env = { TOOLCHAIN = "stable" }

            [[matrix]]
            env = { TOOLCHAIN = "nightly", OS = "linux" }
            "#,
        )
        .unwrap();
        let legs = cfg.legs();
        assert_eq!(legs.len(), 2);
        assert_eq!(legs[0].label(), "stable");
        // unnamed leg derives a label from its env (BTreeMap → sorted keys)
        assert_eq!(legs[1].label(), "OS=linux,TOOLCHAIN=nightly");
    }

    #[test]
    fn rejects_empty_image() {
        let err = Config::parse(
            r#"
            image = ""
            command = "cargo test"
            [shard]
            strategy = "count"
            total = 1
            "#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("image"), "got: {err}");
    }

    #[test]
    fn rejects_zero_shards() {
        let err = Config::parse(
            r#"
            image = "x"
            command = "y"
            [shard]
            strategy = "count"
            total = 0
            "#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("total"), "got: {err}");
    }

    #[test]
    fn rejects_empty_unit_list() {
        let err = Config::parse(
            r#"
            image = "x"
            command = "y"
            [shard]
            strategy = "list"
            units = []
            "#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("units"), "got: {err}");
    }
}
