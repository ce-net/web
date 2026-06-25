//! Verification dial — pick a random subset of shards to re-run on a *different* host, then check
//! the two runs agree. A host reporting false-green is the real threat in distributed CI; re-running
//! a fraction of shards on an independent host and comparing (exit code + output digest) raises the
//! cost of lying. This is the ce-ci half of the shared `ce-mesh-verify` idea from the portfolio
//! spec; it lives here for now and can be hoisted into a shared crate later.
//!
//! Selection is **beacon-seeded** so the canary set is unpredictable to a host at dispatch time but
//! auditable after the fact: anyone with the same beacon hash + shard count reproduces the choice.
//! The residual trust assumption (a worker colluding with its own canary peer) is documented in the
//! portfolio spec — the dial raises cost, it is not a hard guarantee.

/// Deterministically choose which shard indices to re-run for verification.
///
/// - `count` is the number of shards in the run.
/// - `pct` is the fraction to verify, clamped to `0.0..=1.0`. `ceil(count * pct)` shards are picked
///   (so any positive pct verifies at least one shard).
/// - `seed_hex` is the beacon tip hash (hex). The selection is a deterministic function of it.
///
/// Returns sorted, de-duplicated 0-based indices into the shard list.
pub fn canary_set(count: usize, pct: f32, seed_hex: &str) -> Vec<usize> {
    if count == 0 || pct <= 0.0 {
        return Vec::new();
    }
    let pct = pct.min(1.0);
    let want = ((count as f32) * pct).ceil() as usize;
    let want = want.clamp(1, count);

    let mut seed = seed_to_u64(seed_hex);
    let mut chosen = std::collections::BTreeSet::new();
    // Draw distinct indices with a small xorshift PRNG seeded by the beacon. Bounded retries: the
    // loop terminates because `want <= count` and each miss still advances the PRNG.
    let mut guard = 0usize;
    while chosen.len() < want && guard < want * 64 + 64 {
        seed = xorshift64(seed);
        chosen.insert((seed % count as u64) as usize);
        guard += 1;
    }
    // Fallback: if the PRNG somehow under-fills (pathological), top up deterministically in order.
    let mut i = 0usize;
    while chosen.len() < want {
        chosen.insert(i % count);
        i += 1;
    }
    chosen.into_iter().collect()
}

/// Fold a hex seed into a non-zero u64 (xorshift requires a non-zero state).
fn seed_to_u64(seed_hex: &str) -> u64 {
    let mut acc: u64 = 0xcbf29ce484222325;
    for b in seed_hex.trim().as_bytes() {
        acc ^= *b as u64;
        acc = acc.wrapping_mul(0x100000001b3);
    }
    if acc == 0 { 0x9e3779b97f4a7c15 } else { acc }
}

fn xorshift64(mut x: u64) -> u64 {
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_pct_or_empty_selects_nothing() {
        assert!(canary_set(10, 0.0, "abc").is_empty());
        assert!(canary_set(0, 0.5, "abc").is_empty());
    }

    #[test]
    fn positive_pct_selects_at_least_one() {
        let set = canary_set(100, 0.001, "deadbeef");
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn ten_percent_of_a_hundred_is_ten() {
        let set = canary_set(100, 0.1, "deadbeef");
        assert_eq!(set.len(), 10);
        // all in-range and unique (BTreeSet guarantees uniqueness + sorted)
        assert!(set.iter().all(|&i| i < 100));
        assert!(set.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn full_pct_selects_all() {
        let set = canary_set(8, 1.0, "x");
        assert_eq!(set, (0..8).collect::<Vec<_>>());
    }

    #[test]
    fn pct_above_one_is_clamped() {
        let set = canary_set(5, 5.0, "x");
        assert_eq!(set.len(), 5);
    }

    #[test]
    fn selection_is_deterministic_for_a_seed() {
        let a = canary_set(50, 0.2, "seedhash");
        let b = canary_set(50, 0.2, "seedhash");
        assert_eq!(a, b, "same seed → same canary set (auditable)");
    }

    #[test]
    fn different_seeds_usually_differ() {
        let a = canary_set(50, 0.2, "seed-one");
        let b = canary_set(50, 0.2, "seed-two");
        // Not a hard guarantee, but with 10 of 50 picked the chance of identity is negligible.
        assert_ne!(a, b);
    }
}
