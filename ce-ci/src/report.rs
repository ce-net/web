//! Result aggregation — combine per-shard outcomes into a single CI verdict.
//!
//! Pure, deterministic, unit-tested without a cluster. Two responsibilities:
//!
//! 1. **Combined exit code** — a CI run is green only if *every* shard passed and *every* shard
//!    was dispatched. The combined exit code mirrors a normal test runner: `0` on full green,
//!    non-zero otherwise (the first failing shard's exit code, or `1` for a dispatch failure).
//! 2. **Divergence** — when the verification dial re-runs a shard on a second host, the two
//!    outcomes are compared. Agreement (same exit code) = verified; disagreement flags the
//!    minority host as suspect (it may be reporting false-green). This reuses the swarm `tally`
//!    idea: group by outcome, majority first.

use std::collections::BTreeMap;

/// The outcome of running one shard on one host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardOutcome {
    /// The shard's stable id (`leg#k/N` or `leg:unit`).
    pub shard_id: String,
    /// The host (NodeId hex) that ran it.
    pub host: String,
    /// Container exit code (`0` = pass). `None` when the shard never ran (dispatch error).
    pub exit_code: Option<i64>,
    /// Captured stdout (used for divergence hashing and the report).
    pub stdout: String,
    /// Captured stderr.
    pub stderr: String,
    /// Set when the shard could not be dispatched/run at all (mesh error, denied cap, no host).
    pub dispatch_error: Option<String>,
    /// True if a verification re-run on a second host agreed with this outcome. `None` = not
    /// re-run (outside the verify sample).
    pub verified: Option<bool>,
}

impl ShardOutcome {
    /// A shard *ran and passed* (exit 0, no dispatch error).
    pub fn passed(&self) -> bool {
        self.dispatch_error.is_none() && self.exit_code == Some(0)
    }

    /// A shard ran but the suite failed (non-zero exit).
    pub fn failed_tests(&self) -> bool {
        self.dispatch_error.is_none() && self.exit_code.is_some_and(|c| c != 0)
    }
}

/// The aggregated result of a whole CI run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
    pub outcomes: Vec<ShardOutcome>,
}

impl RunReport {
    pub fn new(outcomes: Vec<ShardOutcome>) -> Self {
        RunReport { outcomes }
    }

    pub fn total(&self) -> usize {
        self.outcomes.len()
    }

    pub fn passed(&self) -> usize {
        self.outcomes.iter().filter(|o| o.passed()).count()
    }

    pub fn failed(&self) -> usize {
        self.outcomes.iter().filter(|o| o.failed_tests()).count()
    }

    pub fn dispatch_errors(&self) -> usize {
        self.outcomes.iter().filter(|o| o.dispatch_error.is_some()).count()
    }

    /// Shards flagged by the verification dial as divergent (a re-run disagreed).
    pub fn suspect(&self) -> Vec<&ShardOutcome> {
        self.outcomes.iter().filter(|o| o.verified == Some(false)).collect()
    }

    /// The whole run is green iff every shard ran and passed (and none diverged under verification).
    pub fn is_green(&self) -> bool {
        !self.outcomes.is_empty()
            && self.outcomes.iter().all(|o| o.passed() && o.verified != Some(false))
    }

    /// The combined CI exit code: `0` on full green, else a non-zero code. A failing test shard's
    /// own exit code is preferred (so `cargo test`-style tooling sees a real code); a dispatch
    /// failure or a verification divergence yields `1`. Deterministic: the first offending shard in
    /// dispatch order decides.
    pub fn combined_exit_code(&self) -> i32 {
        if self.outcomes.is_empty() {
            return 1; // nothing ran → not green
        }
        for o in &self.outcomes {
            if o.dispatch_error.is_some() {
                return 1;
            }
            if o.verified == Some(false) {
                return 1;
            }
            if let Some(code) = o.exit_code {
                if code != 0 {
                    // Clamp into a portable process exit code (0..=255).
                    return (code.rem_euclid(256)) as i32;
                }
            } else {
                return 1;
            }
        }
        0
    }
}

/// The key an outcome is grouped by for divergence detection: its exit code plus a digest of the
/// normalized stdout. Two runs with the same key are considered to agree.
pub type OutcomeKey = (Option<i64>, String);

/// One group of agreeing runs: the shared [`OutcomeKey`] and the hosts that produced it.
pub type OutcomeGroup = (OutcomeKey, Vec<String>);

/// Group a shard's redundant runs by their outcome key (exit code + stdout hash), majority first.
/// Mirrors swarm's `tally`: a unanimous group = verified; a minority group = the suspect host(s).
/// Sorted by group size descending (the majority answer first).
pub fn tally(runs: &[ShardOutcome]) -> Vec<OutcomeGroup> {
    let mut groups: BTreeMap<OutcomeKey, Vec<String>> = BTreeMap::new();
    for r in runs {
        let key = (r.exit_code, digest(&r.stdout));
        groups.entry(key).or_default().push(r.host.clone());
    }
    let mut v: Vec<OutcomeGroup> = groups.into_iter().collect();
    v.sort_by_key(|(_, hosts)| std::cmp::Reverse(hosts.len())); // majority first
    v
}

/// Do two runs of the same shard agree? Verification compares the exit code and a digest of the
/// normalized stdout — for reproducible jobs (a deterministic test suite producing JUnit output)
/// this is a sound canary. A `true` result means the second host corroborated the first.
pub fn agrees(a: &ShardOutcome, b: &ShardOutcome) -> bool {
    a.exit_code == b.exit_code && digest(&a.stdout) == digest(&b.stdout)
}

/// A cheap, stable digest of normalized output (trailing whitespace trimmed per line). Kept simple
/// and dependency-free; sufficient to detect a host returning a different answer. A cryptographic
/// hash (sha2, already a transitive dep) is the obvious upgrade if collision-resistance is needed.
fn digest(s: &str) -> String {
    let normalized: String =
        s.lines().map(|l| l.trim_end()).collect::<Vec<_>>().join("\n").trim_end().to_string();
    // FNV-1a 64-bit over the normalized bytes.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in normalized.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ran(id: &str, host: &str, exit: i64, stdout: &str) -> ShardOutcome {
        ShardOutcome {
            shard_id: id.into(),
            host: host.into(),
            exit_code: Some(exit),
            stdout: stdout.into(),
            stderr: String::new(),
            dispatch_error: None,
            verified: None,
        }
    }

    fn errored(id: &str, host: &str, err: &str) -> ShardOutcome {
        ShardOutcome {
            shard_id: id.into(),
            host: host.into(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            dispatch_error: Some(err.into()),
            verified: None,
        }
    }

    #[test]
    fn all_pass_is_green_exit_zero() {
        let r = RunReport::new(vec![ran("a", "h1", 0, "ok"), ran("b", "h2", 0, "ok")]);
        assert!(r.is_green());
        assert_eq!(r.combined_exit_code(), 0);
        assert_eq!(r.passed(), 2);
        assert_eq!(r.failed(), 0);
    }

    #[test]
    fn empty_run_is_not_green() {
        let r = RunReport::new(vec![]);
        assert!(!r.is_green());
        assert_eq!(r.combined_exit_code(), 1);
    }

    #[test]
    fn a_failing_shard_propagates_its_exit_code() {
        let r = RunReport::new(vec![ran("a", "h1", 0, "ok"), ran("b", "h2", 2, "boom")]);
        assert!(!r.is_green());
        assert_eq!(r.combined_exit_code(), 2);
        assert_eq!(r.failed(), 1);
    }

    #[test]
    fn dispatch_error_fails_the_run_with_code_one() {
        let r = RunReport::new(vec![ran("a", "h1", 0, "ok"), errored("b", "h2", "no host")]);
        assert!(!r.is_green());
        assert_eq!(r.combined_exit_code(), 1);
        assert_eq!(r.dispatch_errors(), 1);
    }

    #[test]
    fn exit_code_is_clamped_to_process_range() {
        // 256 wraps to 0 in process terms, but the run still failed → never report green's 0 here.
        // 257 -> 1.
        let r = RunReport::new(vec![ran("a", "h1", 257, "x")]);
        assert_eq!(r.combined_exit_code(), 1);
        // a negative code (e.g. signal) maps into 0..=255 without becoming a false 0
        let r2 = RunReport::new(vec![ran("a", "h1", -1, "x")]);
        assert_eq!(r2.combined_exit_code(), 255);
    }

    #[test]
    fn divergence_under_verification_fails_the_run() {
        let mut o = ran("a", "h1", 0, "ok");
        o.verified = Some(false); // a re-run disagreed → suspect
        let r = RunReport::new(vec![o]);
        assert!(!r.is_green());
        assert_eq!(r.combined_exit_code(), 1);
        assert_eq!(r.suspect().len(), 1);
    }

    #[test]
    fn verified_true_stays_green() {
        let mut o = ran("a", "h1", 0, "ok");
        o.verified = Some(true);
        let r = RunReport::new(vec![o]);
        assert!(r.is_green());
        assert_eq!(r.combined_exit_code(), 0);
    }

    #[test]
    fn agrees_compares_exit_and_normalized_stdout() {
        let a = ran("s", "h1", 0, "HASH\n");
        let b = ran("s", "h2", 0, "HASH");
        assert!(agrees(&a, &b), "trailing whitespace normalized");
        let c = ran("s", "h3", 0, "DIFFERENT");
        assert!(!agrees(&a, &c));
        let d = ran("s", "h4", 1, "HASH");
        assert!(!agrees(&a, &d), "differing exit codes disagree");
    }

    #[test]
    fn tally_unanimous_is_one_group() {
        let runs = vec![ran("s", "a", 0, "OK\n"), ran("s", "b", 0, "OK"), ran("s", "c", 0, "OK")];
        let groups = tally(&runs);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 3);
    }

    #[test]
    fn tally_flags_minority_as_suspect() {
        let runs = vec![
            ran("s", "good1", 0, "GREEN"),
            ran("s", "good2", 0, "GREEN"),
            ran("s", "liar", 0, "FAKE"), // claims green but different output
        ];
        let groups = tally(&runs);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].1.len(), 2, "majority first");
        assert_eq!(groups[1].1, vec!["liar".to_string()]);
    }

    #[test]
    fn digest_is_whitespace_stable() {
        assert_eq!(digest("a\nb\n"), digest("a  \nb"));
        assert_ne!(digest("a"), digest("b"));
    }
}
