//! Capability gating (client side).
//!
//! Authorization is enforced by the *host* (it calls `ce_cap::authorize` before running any shard,
//! exactly like rdev's `serve` loop). The client's job is only to carry a well-formed `ce-cap`
//! chain token to the host. This module decodes the token early so a malformed/empty capability is
//! reported before any work is scattered, and surfaces the ability the chain's leaf grants so the
//! CLI can warn if it does not include the CI ability the hosts will check.
//!
//! The ability string ce-ci hosts check is opaque and app-chosen; the portfolio spec names it
//! `ci:shard`. Because exec on CE is the `rdev` app, hosts running `rdev serve` check the `exec`
//! ability; ce-ci therefore accepts a chain granting either, and the host has the final say.

use anyhow::{Context, Result};
use ce_cap::{SignedCapability, decode_chain};

/// The CI ability ce-ci-native hosts verify.
pub const ABILITY_CI: &str = "ci:shard";
/// The exec ability rdev-serving hosts verify (exec is the rdev app on CE).
pub const ABILITY_EXEC: &str = "exec";

/// Decode and structurally validate a capability token (hex `ce-cap` chain). Returns the parsed
/// chain so the caller can inspect it; verifying the *signatures* and root-of-trust is the host's
/// responsibility (it knows its own accepted roots), but we check each link's signature here too as
/// a fail-fast so an obviously broken token never reaches the mesh.
pub fn decode_token(token: &str) -> Result<Vec<SignedCapability>> {
    let chain = decode_chain(token).context("decoding capability token")?;
    if chain.is_empty() {
        anyhow::bail!("capability token decodes to an empty chain");
    }
    for (i, link) in chain.iter().enumerate() {
        link.verify_sig().with_context(|| format!("capability link {i} signature invalid"))?;
    }
    Ok(chain)
}

/// Does the chain's leaf grant a CI-relevant ability (`ci:shard` or `exec`)? A `false` here is a
/// warning, not a hard error — the host is the authority and may map abilities differently.
pub fn grants_ci_ability(chain: &[SignedCapability]) -> bool {
    chain
        .last()
        .map(|leaf| leaf.cap.abilities.iter().any(|a| a == ABILITY_CI || a == ABILITY_EXEC))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ce_cap::{Caveats, Resource, SignedCapability, encode_chain};
    use ce_identity::Identity;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn id(tag: &str) -> Identity {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("ce-ci-cap-test-{}-{n}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Identity::load_or_generate(&dir).unwrap()
    }

    fn token_for(abilities: Vec<String>) -> (String, Vec<SignedCapability>) {
        let host = id("host");
        let runner = id("runner");
        let cap = SignedCapability::issue(
            &host,
            runner.node_id(),
            abilities,
            Resource::Any,
            Caveats::default(),
            1,
            None,
        );
        let chain = vec![cap];
        (encode_chain(&chain), chain)
    }

    #[test]
    fn decodes_a_valid_token() {
        let (token, _) = token_for(vec![ABILITY_CI.into()]);
        let chain = decode_token(&token).unwrap();
        assert_eq!(chain.len(), 1);
    }

    #[test]
    fn rejects_garbage_token() {
        assert!(decode_token("not-hex-zzz").is_err());
        assert!(decode_token("").is_err());
    }

    #[test]
    fn detects_ci_ability() {
        let (_, ci) = token_for(vec![ABILITY_CI.into()]);
        assert!(grants_ci_ability(&ci));
        let (_, exec) = token_for(vec![ABILITY_EXEC.into()]);
        assert!(grants_ci_ability(&exec));
        let (_, other) = token_for(vec!["pin:store".into()]);
        assert!(!grants_ci_ability(&other));
    }
}
