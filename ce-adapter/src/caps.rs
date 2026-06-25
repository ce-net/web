//! Capability helpers for ce-adapter — thin wrappers over `ce-cap`.
//!
//! ce-adapter defines opaque abilities on the shared `ce-cap` chain primitive. They are plain
//! strings (ce-cap assigns abilities no meaning); the adapter runtime is the enforcement point and
//! calls [`authorize`] before bringing up an instance or accepting an edge connection:
//!
//! * `adapter:spawn`        — may ask a host to start an adapter instance (the control message).
//! * `adapter:webrtc-ingest` — may publish into a webrtc-ingest adapter (replaces a shared key).
//! * `adapter:webrtc-egress` — may pull from a webrtc-egress adapter.
//! * `adapter:node-bridge`   — may use a node-bridge adapter's node services.
//!
//! Issuance is the zero-config personal case from `ce-cap`: a host self-delegates to a caller, who
//! presents the resulting chain. Org/fleet roots work identically — point the runtime at a
//! configured root key instead of self.

use anyhow::{Result, anyhow};
use ce_cap::{Caveats, Resource, SignedCapability, authorize as cap_authorize, decode_chain, encode_chain};
use ce_identity::{Identity, NodeId};

use crate::profile::Profile;

/// Ability: may request that a host start an adapter instance.
pub const ABILITY_SPAWN: &str = "adapter:spawn";
/// Ability: may publish media into a webrtc-ingest adapter.
pub const ABILITY_WEBRTC_INGEST: &str = "adapter:webrtc-ingest";
/// Ability: may pull media from a webrtc-egress adapter.
pub const ABILITY_WEBRTC_EGRESS: &str = "adapter:webrtc-egress";
/// Ability: may use a node-bridge adapter.
pub const ABILITY_NODE_BRIDGE: &str = "adapter:node-bridge";

/// The ability that gates publishing/using a given profile's edge connection.
pub fn edge_ability(profile: Profile) -> &'static str {
    match profile {
        Profile::WebrtcIngest => ABILITY_WEBRTC_INGEST,
        Profile::WebrtcEgress => ABILITY_WEBRTC_EGRESS,
        Profile::NodeBridge => ABILITY_NODE_BRIDGE,
    }
}

/// Mint a capability token (hex chain) authorizing `audience` to perform `abilities` on the nodes
/// selected by `resource`, signed by `issuer` (root delegation: `parent = None`). `not_after` is a
/// unix-seconds expiry (0 = never). Returns the portable hex token to hand to the audience.
pub fn grant(
    issuer: &Identity,
    audience: NodeId,
    abilities: &[&str],
    resource: Resource,
    not_after: u64,
    nonce: u64,
) -> String {
    let caveats = Caveats { not_after, ..Default::default() };
    let cap = SignedCapability::issue(
        issuer,
        audience,
        abilities.iter().map(|s| s.to_string()).collect(),
        resource,
        caveats,
        nonce,
        None,
    );
    encode_chain(&[cap])
}

/// Verify that `requester` may perform `action` on this node, given a presented capability `token`
/// (hex chain) and the set of `accepted_roots` (the node's own id is always implicitly accepted).
/// `now` is unix seconds; `self_tags` are this node's atlas self-tags; `is_revoked` consults the
/// on-chain revocation set. Returns `Ok(())` if allowed, else an error safe to surface.
#[allow(clippy::too_many_arguments)]
pub fn authorize(
    self_id: &NodeId,
    accepted_roots: &[NodeId],
    self_tags: &[String],
    now: u64,
    requester: &NodeId,
    action: &str,
    token: &str,
    is_revoked: &dyn Fn(&NodeId, u64) -> bool,
) -> Result<()> {
    let chain = decode_chain(token).map_err(|e| anyhow!("bad capability token: {e}"))?;
    cap_authorize(self_id, accepted_roots, self_tags, now, requester, action, &chain, is_revoked)
        .map_err(|reason| anyhow!("capability denied: {reason}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ce_identity::Identity;

    fn gen_identity(tag: &str) -> Identity {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("ce-adapter-id-{}-{tag}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Identity::load_or_generate(&dir).expect("generate identity")
    }

    #[test]
    fn edge_ability_maps_each_profile() {
        assert_eq!(edge_ability(Profile::WebrtcIngest), ABILITY_WEBRTC_INGEST);
        assert_eq!(edge_ability(Profile::WebrtcEgress), ABILITY_WEBRTC_EGRESS);
        assert_eq!(edge_ability(Profile::NodeBridge), ABILITY_NODE_BRIDGE);
    }

    #[test]
    fn grant_and_authorize_ingest_roundtrip() {
        let host = gen_identity("host");
        let dev = gen_identity("dev");
        let token = grant(
            &host,
            dev.node_id(),
            &[ABILITY_WEBRTC_INGEST],
            Resource::Node(host.node_id()),
            0,
            1,
        );
        let res = authorize(
            &host.node_id(),
            &[],
            &[],
            0,
            &dev.node_id(),
            ABILITY_WEBRTC_INGEST,
            &token,
            &|_, _| false,
        );
        assert!(res.is_ok(), "self-delegated ingest must authorize: {res:?}");
    }

    #[test]
    fn wrong_ability_denied() {
        let host = gen_identity("host");
        let dev = gen_identity("dev");
        // granted control/spawn, but tries to publish
        let token = grant(&host, dev.node_id(), &[ABILITY_SPAWN], Resource::Any, 0, 7);
        let res = authorize(
            &host.node_id(),
            &[],
            &[],
            0,
            &dev.node_id(),
            ABILITY_WEBRTC_INGEST,
            &token,
            &|_, _| false,
        );
        assert!(res.is_err(), "ingest must be denied when only spawn was granted");
    }

    #[test]
    fn revoked_chain_denied() {
        let host = gen_identity("host");
        let dev = gen_identity("dev");
        let token = grant(&host, dev.node_id(), &[ABILITY_WEBRTC_INGEST], Resource::Any, 0, 42);
        let revoked = |issuer: &NodeId, nonce: u64| *issuer == host.node_id() && nonce == 42;
        let res = authorize(
            &host.node_id(),
            &[],
            &[],
            0,
            &dev.node_id(),
            ABILITY_WEBRTC_INGEST,
            &token,
            &revoked,
        );
        assert!(res.is_err(), "revoked capability must be denied");
    }

    #[test]
    fn empty_token_denied() {
        let host = gen_identity("host");
        let dev = gen_identity("dev");
        let res = authorize(
            &host.node_id(),
            &[],
            &[],
            0,
            &dev.node_id(),
            ABILITY_WEBRTC_INGEST,
            "",
            &|_, _| false,
        );
        assert!(res.is_err());
    }
}
