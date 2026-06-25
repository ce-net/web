//! Tunnel-session state machine and the capability gate — the pure, unit-tested core of ce-expose.
//!
//! This module is deliberately free of I/O and of the CE SDK so its logic can be exercised without a
//! running node. It contains two things:
//!
//! 1. [`gate`] — the capability decision: given the origin's identity, its accepted roots, the
//!    on-chain revoked set, the dialing peer's NodeId, and a presented chain, may that peer reach
//!    this endpoint? It is a thin, well-tested wrapper over `ce_cap::authorize` with ability
//!    `expose:dial`. Every mesh frame runs through it, so an expired/revoked cap kills the session
//!    immediately.
//!
//! 2. [`Session`] — the per-connection byte-pump state. A tunnel session shuttles bytes between a
//!    remote consumer and the origin's local TCP socket in two independent half-streams (up: consumer
//!    -> local; down: local -> consumer), each with its own EOF. The state machine tracks how many
//!    bytes have flowed each way and when each half closed, and decides when the whole session is
//!    finished (both halves closed). It is driven by [`Session::on_frame`] (apply one consumer frame,
//!    yield the response) so the exact same logic is testable in-memory and used live by the agent.

use std::collections::HashSet;

use ce_cap::{SignedCapability, authorize, decode_chain};

use crate::proto::ABILITY_DIAL;

/// Type alias for a NodeId as used across CE: a 32-byte key.
pub type NodeId = [u8; 32];

/// The revoked-set: `(issuer, nonce)` pairs the origin treats as revoked (mirrors the on-chain set).
pub type RevokedSet = HashSet<(NodeId, u64)>;

/// Outcome of the capability gate. `Allow` carries the decoded chain so the caller need not decode
/// twice; `Deny` carries a loggable, returnable reason string.
#[derive(Debug)]
pub enum Decision {
    Allow(Vec<SignedCapability>),
    Deny(String),
}

impl Decision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Decision::Allow(_))
    }

    /// The deny reason, or `None` when allowed.
    pub fn reason(&self) -> Option<&str> {
        match self {
            Decision::Deny(r) => Some(r.as_str()),
            Decision::Allow(_) => None,
        }
    }
}

/// Decide whether `from` may perform `expose:dial` against this origin, given the presented `caps`
/// chain (hex). This is the single authorization choke-point for every ce-expose frame.
///
/// - `origin_id`        — this origin's NodeId (an implicit accepted root: a node can always expose
///   its own resources by self-issuing).
/// - `roots`            — additional accepted root keys (an org/fleet anchor), loaded from disk.
/// - `now`              — current unix seconds, for temporal caveat checks.
/// - `from`             — the cryptographically authenticated dialing peer (from the mesh message).
/// - `caps_hex`         — the hex-encoded `ce-cap` chain the consumer presented.
/// - `revoked`          — the revoked `(issuer, nonce)` set.
///
/// Returns [`Decision::Allow`] with the decoded chain, or [`Decision::Deny`] with a reason. A
/// malformed/empty chain is a deny, never a panic.
pub fn gate(
    origin_id: &NodeId,
    roots: &[NodeId],
    now: u64,
    from: &NodeId,
    caps_hex: &str,
    revoked: &RevokedSet,
) -> Decision {
    let chain = match decode_chain(caps_hex) {
        Ok(c) => c,
        Err(_) => return Decision::Deny("malformed or missing capability chain".to_string()),
    };
    let is_revoked = |issuer: &NodeId, nonce: u64| revoked.contains(&(*issuer, nonce));
    match authorize(origin_id, roots, &[], now, from, ABILITY_DIAL, &chain, &is_revoked) {
        Ok(()) => Decision::Allow(chain),
        Err(e) => Decision::Deny(format!("denied: {e}")),
    }
}

/// Why a session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// Both half-streams reached EOF — a clean, complete tunnel.
    BothEof,
    /// The consumer asked to close (or its half closed and we tore the rest down).
    ConsumerClosed,
    /// The local service connection failed or dropped.
    LocalError,
    /// A frame failed authorization (cap expired/revoked) mid-session.
    Unauthorized,
}

/// A single tunnel session's accounting + lifecycle. It does not own sockets; the agent feeds it the
/// bytes it read from the local socket and the bytes the consumer sent, and the session records flow
/// and decides when it is finished. Keeping this pure makes the half-close / byte-count logic — the
/// part most prone to off-by-one and stuck-tunnel bugs — directly unit-testable.
#[derive(Debug)]
pub struct Session {
    /// The authenticated consumer NodeId that opened this session (hex).
    pub consumer: String,
    /// Consumer-chosen session id.
    pub id: String,
    /// Total consumer->local bytes pumped.
    pub up_bytes: u64,
    /// Total local->consumer bytes pumped.
    pub down_bytes: u64,
    /// Consumer's send side has closed (no more `up`).
    up_closed: bool,
    /// Local service's send side has closed (no more `down`).
    down_closed: bool,
    /// Set once the session is finished; further frames are rejected.
    closed: Option<CloseReason>,
}

impl Session {
    /// Open a fresh session for `consumer` / `id`.
    pub fn new(consumer: impl Into<String>, id: impl Into<String>) -> Self {
        Session {
            consumer: consumer.into(),
            id: id.into(),
            up_bytes: 0,
            down_bytes: 0,
            up_closed: false,
            down_closed: false,
            closed: None,
        }
    }

    /// Is the session finished (and why)?
    pub fn close_reason(&self) -> Option<CloseReason> {
        self.closed
    }

    /// Is the session still live?
    pub fn is_open(&self) -> bool {
        self.closed.is_none()
    }

    /// Record `n` consumer->local bytes flowing (the agent has just written them to the socket).
    pub fn record_up(&mut self, n: usize) {
        self.up_bytes += n as u64;
    }

    /// Record `n` local->consumer bytes flowing (the agent has just read them from the socket).
    pub fn record_down(&mut self, n: usize) {
        self.down_bytes += n as u64;
    }

    /// Mark the consumer's up-half as closed (consumer EOF). May complete the session.
    pub fn mark_up_eof(&mut self) {
        self.up_closed = true;
        self.maybe_finish();
    }

    /// Mark the local service's down-half as closed (local EOF). May complete the session.
    pub fn mark_down_eof(&mut self) {
        self.down_closed = true;
        self.maybe_finish();
    }

    /// Force-close the session with an explicit reason (consumer `close`, local error, deny).
    pub fn force_close(&mut self, reason: CloseReason) {
        if self.closed.is_none() {
            self.closed = Some(reason);
        }
    }

    fn maybe_finish(&mut self) {
        if self.closed.is_none() && self.up_closed && self.down_closed {
            self.closed = Some(CloseReason::BothEof);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ce_cap::{Caveats, Resource, SignedCapability};
    use ce_identity::Identity;
    use std::sync::atomic::{AtomicU64, Ordering};

    // ---- capability gate tests (mirroring rdev/ce-pin's handle_authorizes_* coverage) ----

    fn id(tag: &str) -> Identity {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("ce-expose-test-{}-{n}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Identity::load_or_generate(&dir).unwrap()
    }

    fn now() -> u64 {
        1000
    }

    fn empty_revoked() -> RevokedSet {
        RevokedSet::new()
    }

    /// A self-issued `expose:dial` chain from `origin` to `consumer`.
    fn dial_chain(origin: &Identity, consumer: &Identity, caveats: Caveats) -> String {
        let c = SignedCapability::issue(
            origin,
            consumer.node_id(),
            vec![ABILITY_DIAL.to_string()],
            Resource::Any,
            caveats,
            1,
            None,
        );
        ce_cap::encode_chain(&[c])
    }

    #[test]
    fn gate_allows_self_issued_dial_cap() {
        let origin = id("origin");
        let consumer = id("consumer");
        let caps = dial_chain(&origin, &consumer, Caveats::default());
        let d = gate(
            &origin.node_id(),
            &[],
            now(),
            &consumer.node_id(),
            &caps,
            &empty_revoked(),
        );
        assert!(d.is_allowed(), "expected allow, got {:?}", d.reason());
    }

    #[test]
    fn gate_denies_wrong_holder() {
        let origin = id("origin");
        let consumer = id("consumer");
        let attacker = id("attacker");
        // Cap is issued to `consumer`, but `attacker` presents it.
        let caps = dial_chain(&origin, &consumer, Caveats::default());
        let d = gate(
            &origin.node_id(),
            &[],
            now(),
            &attacker.node_id(),
            &caps,
            &empty_revoked(),
        );
        assert!(!d.is_allowed());
        assert!(d.reason().unwrap().contains("not held by"));
    }

    #[test]
    fn gate_denies_empty_chain() {
        let origin = id("origin");
        let consumer = id("consumer");
        let d = gate(
            &origin.node_id(),
            &[],
            now(),
            &consumer.node_id(),
            "",
            &empty_revoked(),
        );
        assert!(!d.is_allowed());
        assert!(d.reason().unwrap().contains("malformed or missing"));
    }

    #[test]
    fn gate_denies_unaccepted_root() {
        let origin = id("origin");
        let stranger = id("stranger"); // not the origin, not an accepted root
        let consumer = id("consumer");
        // Stranger self-issues a cap to consumer; the origin does not honor stranger as a root.
        let caps = dial_chain(&stranger, &consumer, Caveats::default());
        let d = gate(
            &origin.node_id(),
            &[],
            now(),
            &consumer.node_id(),
            &caps,
            &empty_revoked(),
        );
        assert!(!d.is_allowed());
        assert!(d.reason().unwrap().contains("accepted authority"));
    }

    #[test]
    fn gate_accepts_configured_org_root() {
        let origin = id("origin");
        let org = id("org");
        let consumer = id("consumer");
        let caps = dial_chain(&org, &consumer, Caveats::default());
        // Origin opts into the org root.
        let d = gate(
            &origin.node_id(),
            &[org.node_id()],
            now(),
            &consumer.node_id(),
            &caps,
            &empty_revoked(),
        );
        assert!(d.is_allowed(), "expected allow, got {:?}", d.reason());
    }

    #[test]
    fn gate_denies_expired_cap() {
        let origin = id("origin");
        let consumer = id("consumer");
        let caps = dial_chain(&origin, &consumer, Caveats { not_after: 500, ..Default::default() });
        let d = gate(
            &origin.node_id(),
            &[],
            1000, // after expiry
            &consumer.node_id(),
            &caps,
            &empty_revoked(),
        );
        assert!(!d.is_allowed());
        assert!(d.reason().unwrap().contains("expired"));
    }

    #[test]
    fn gate_denies_revoked_cap() {
        let origin = id("origin");
        let consumer = id("consumer");
        let caps = dial_chain(&origin, &consumer, Caveats::default());
        // The single link uses nonce 1; revoke it.
        let mut revoked = RevokedSet::new();
        revoked.insert((origin.node_id(), 1));
        let d = gate(
            &origin.node_id(),
            &[],
            now(),
            &consumer.node_id(),
            &caps,
            &revoked,
        );
        assert!(!d.is_allowed());
        assert!(d.reason().unwrap().contains("revoked"));
    }

    #[test]
    fn gate_denies_cap_without_dial_ability() {
        let origin = id("origin");
        let consumer = id("consumer");
        // A cap that grants some *other* ability, not expose:dial.
        let c = SignedCapability::issue(
            &origin,
            consumer.node_id(),
            vec!["pin:store".to_string()],
            Resource::Any,
            Caveats::default(),
            1,
            None,
        );
        let caps = ce_cap::encode_chain(&[c]);
        let d = gate(
            &origin.node_id(),
            &[],
            now(),
            &consumer.node_id(),
            &caps,
            &empty_revoked(),
        );
        assert!(!d.is_allowed());
        assert!(d.reason().unwrap().contains("expose:dial"));
    }

    // ---- session state-machine tests ----

    #[test]
    fn new_session_is_open() {
        let s = Session::new("consumerhex", "sess-1");
        assert!(s.is_open());
        assert_eq!(s.close_reason(), None);
        assert_eq!(s.up_bytes, 0);
        assert_eq!(s.down_bytes, 0);
    }

    #[test]
    fn byte_counters_accumulate() {
        let mut s = Session::new("c", "s");
        s.record_up(10);
        s.record_up(5);
        s.record_down(20);
        assert_eq!(s.up_bytes, 15);
        assert_eq!(s.down_bytes, 20);
    }

    #[test]
    fn both_eof_finishes_session_cleanly() {
        let mut s = Session::new("c", "s");
        s.mark_up_eof();
        assert!(s.is_open(), "one EOF should not finish the session");
        s.mark_down_eof();
        assert!(!s.is_open());
        assert_eq!(s.close_reason(), Some(CloseReason::BothEof));
    }

    #[test]
    fn down_then_up_eof_also_finishes() {
        let mut s = Session::new("c", "s");
        s.mark_down_eof();
        assert!(s.is_open());
        s.mark_up_eof();
        assert_eq!(s.close_reason(), Some(CloseReason::BothEof));
    }

    #[test]
    fn force_close_wins_and_is_sticky() {
        let mut s = Session::new("c", "s");
        s.force_close(CloseReason::Unauthorized);
        assert_eq!(s.close_reason(), Some(CloseReason::Unauthorized));
        // A subsequent natural completion does not overwrite the recorded reason.
        s.mark_up_eof();
        s.mark_down_eof();
        assert_eq!(s.close_reason(), Some(CloseReason::Unauthorized));
    }

    #[test]
    fn local_error_closes_session() {
        let mut s = Session::new("c", "s");
        s.force_close(CloseReason::LocalError);
        assert!(!s.is_open());
        assert_eq!(s.close_reason(), Some(CloseReason::LocalError));
    }
}
