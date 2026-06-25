//! Shard splitting — turn a [`Config`] into a flat list of [`Shard`]s to scatter across the mesh.
//!
//! This is the pure, deterministic core of ce-ci: given the config (and its matrix legs), produce
//! the exact set of `(matrix-leg, shard-index, rendered-command)` units that will be dispatched.
//! It has no IO and no mesh dependency, so it is fully unit-tested without a live cluster.
//!
//! Two strategies:
//! - **count** — `total` index slices `1..=total`. The in-container runner partitions by index
//!   (`cargo nextest --partition count:k/N`, `pytest --shard k/N`, `jest --shard k/N`). One shard
//!   per index.
//! - **list** — one shard per explicit unit (test file / package). `{unit}` is substituted; the
//!   index is the unit's 1-based position.

use crate::config::{Config, MatrixLeg, ShardSpec};
use std::collections::BTreeMap;

/// One dispatchable unit of work: a single shard within one matrix leg, with its command already
/// rendered and its env resolved. The scatter layer maps each of these to one mesh host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shard {
    /// 1-based shard index within its leg.
    pub index: u32,
    /// Total shards in this leg (the `{total}` substituted into the command).
    pub total: u32,
    /// The matrix leg label this shard belongs to (`"default"` when there is no matrix).
    pub leg: String,
    /// For the `list` strategy, the unit (file/package) this shard runs; `None` for `count`.
    pub unit: Option<String>,
    /// The fully-rendered command to run inside the container.
    pub command: String,
    /// Environment overlay from the matrix leg.
    pub env: BTreeMap<String, String>,
}

impl Shard {
    /// A stable, human display id like `linux-stable#3/8` or `default:pkg-a`.
    pub fn id(&self) -> String {
        match &self.unit {
            Some(u) => format!("{}:{u}", self.leg),
            None => format!("{}#{}/{}", self.leg, self.index, self.total),
        }
    }
}

/// Substitute the `{shard}`, `{total}` and `{unit}` placeholders in a command template.
///
/// `{unit}` renders empty when the strategy has no unit (count strategy). Unknown placeholders are
/// left untouched so a literal brace in a command is not silently corrupted.
pub fn render_command(template: &str, index: u32, total: u32, unit: Option<&str>) -> String {
    template
        .replace("{shard}", &index.to_string())
        .replace("{total}", &total.to_string())
        .replace("{unit}", unit.unwrap_or(""))
}

/// Expand a [`Config`] into the full flat list of shards across every matrix leg.
///
/// Order is deterministic: legs in config order, shards in index order within each leg.
pub fn plan(cfg: &Config) -> Vec<Shard> {
    let mut out = Vec::new();
    for leg in cfg.legs() {
        expand_leg(cfg, &leg, &mut out);
    }
    out
}

/// Expand one matrix leg's shards into `out`.
fn expand_leg(cfg: &Config, leg: &MatrixLeg, out: &mut Vec<Shard>) {
    let label = leg.label();
    match &cfg.shard {
        ShardSpec::Count { total } => {
            for index in 1..=*total {
                out.push(Shard {
                    index,
                    total: *total,
                    leg: label.clone(),
                    unit: None,
                    command: render_command(&cfg.command, index, *total, None),
                    env: leg.env.clone(),
                });
            }
        }
        ShardSpec::List { units } => {
            let total = units.len() as u32;
            for (i, unit) in units.iter().enumerate() {
                let index = i as u32 + 1;
                out.push(Shard {
                    index,
                    total,
                    leg: label.clone(),
                    unit: Some(unit.clone()),
                    command: render_command(&cfg.command, index, total, Some(unit)),
                    env: leg.env.clone(),
                });
            }
        }
    }
}

/// Wrap a rendered shard command in a `sh -c` argv that first exports the leg's env, so a single
/// `{cmd}` string runs with the matrix env regardless of the host's exec protocol. Env keys are
/// validated to a safe `[A-Za-z_][A-Za-z0-9_]*` shape; values are single-quote escaped.
pub fn to_argv(shard: &Shard) -> Vec<String> {
    let mut script = String::new();
    for (k, v) in &shard.env {
        if is_valid_env_key(k) {
            script.push_str(&format!("export {k}={}; ", shell_quote(v)));
        }
    }
    script.push_str(&shard.command);
    vec!["sh".into(), "-c".into(), script]
}

/// Conservative POSIX env-name check.
fn is_valid_env_key(k: &str) -> bool {
    let mut chars = k.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Single-quote a value for safe inclusion in a `sh -c` script (handles embedded quotes).
fn shell_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn count_cfg(total: u32) -> Config {
        Config::parse(&format!(
            r#"
            image = "img"
            command = "run --partition {{shard}}/{{total}}"
            [shard]
            strategy = "count"
            total = {total}
            "#
        ))
        .unwrap()
    }

    #[test]
    fn render_substitutes_all_placeholders() {
        assert_eq!(render_command("p {shard}/{total}", 3, 8, None), "p 3/8");
        assert_eq!(render_command("test {unit}", 1, 1, Some("pkg-a")), "test pkg-a");
        // count strategy → {unit} renders empty
        assert_eq!(render_command("x {unit} y", 1, 1, None), "x  y");
        // unknown placeholder is left untouched
        assert_eq!(render_command("keep {weird}", 1, 1, None), "keep {weird}");
    }

    #[test]
    fn count_strategy_produces_one_shard_per_index() {
        let shards = plan(&count_cfg(4));
        assert_eq!(shards.len(), 4);
        assert_eq!(shards[0].index, 1);
        assert_eq!(shards[3].index, 4);
        assert!(shards.iter().all(|s| s.total == 4));
        assert_eq!(shards[2].command, "run --partition 3/4");
        assert!(shards.iter().all(|s| s.unit.is_none()));
    }

    #[test]
    fn list_strategy_produces_one_shard_per_unit() {
        let cfg = Config::parse(
            r#"
            image = "img"
            command = "go test ./{unit}/..."
            [shard]
            strategy = "list"
            units = ["a", "b", "c"]
            "#,
        )
        .unwrap();
        let shards = plan(&cfg);
        assert_eq!(shards.len(), 3);
        assert_eq!(shards[0].unit.as_deref(), Some("a"));
        assert_eq!(shards[0].command, "go test ./a/...");
        assert_eq!(shards[1].index, 2);
        assert_eq!(shards[2].command, "go test ./c/...");
        // total is the unit count for all
        assert!(shards.iter().all(|s| s.total == 3));
    }

    #[test]
    fn matrix_multiplies_shards_per_leg() {
        let cfg = Config::parse(
            r#"
            image = "img"
            command = "cargo test --partition {shard}/{total}"
            [shard]
            strategy = "count"
            total = 2
            [[matrix]]
            name = "stable"
            env = { TOOLCHAIN = "stable" }
            [[matrix]]
            name = "nightly"
            env = { TOOLCHAIN = "nightly" }
            "#,
        )
        .unwrap();
        let shards = plan(&cfg);
        // 2 legs x 2 shards = 4 dispatch units
        assert_eq!(shards.len(), 4);
        assert_eq!(shards[0].leg, "stable");
        assert_eq!(shards[2].leg, "nightly");
        // env carried through
        assert_eq!(shards[0].env.get("TOOLCHAIN").map(String::as_str), Some("stable"));
        assert_eq!(shards[3].env.get("TOOLCHAIN").map(String::as_str), Some("nightly"));
    }

    #[test]
    fn shard_id_is_stable() {
        let shards = plan(&count_cfg(8));
        assert_eq!(shards[2].id(), "default#3/8");
        let cfg = Config::parse(
            r#"
            image = "i"
            command = "c"
            [shard]
            strategy = "list"
            units = ["pkg-a"]
            "#,
        )
        .unwrap();
        assert_eq!(plan(&cfg)[0].id(), "default:pkg-a");
    }

    #[test]
    fn to_argv_exports_env_then_runs_command() {
        let cfg = Config::parse(
            r#"
            image = "i"
            command = "echo hi"
            [shard]
            strategy = "count"
            total = 1
            [[matrix]]
            name = "leg"
            env = { FOO = "bar baz", N = "1" }
            "#,
        )
        .unwrap();
        let argv = to_argv(&plan(&cfg)[0]);
        assert_eq!(argv[0], "sh");
        assert_eq!(argv[1], "-c");
        // BTreeMap → deterministic key order (FOO before N)
        assert_eq!(argv[2], "export FOO='bar baz'; export N='1'; echo hi");
    }

    #[test]
    fn to_argv_rejects_bad_env_keys_and_escapes_quotes() {
        let mut env = BTreeMap::new();
        env.insert("9bad".to_string(), "x".to_string()); // invalid key dropped
        env.insert("OK".to_string(), "a'b".to_string()); // quote escaped
        let shard = Shard {
            index: 1,
            total: 1,
            leg: "l".into(),
            unit: None,
            command: "true".into(),
            env,
        };
        let argv = to_argv(&shard);
        assert!(!argv[2].contains("9bad"));
        assert!(argv[2].contains(r"export OK='a'\''b';"));
    }
}
