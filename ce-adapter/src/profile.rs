//! Adapter **profiles** — the bridging modes a `ce-adapter` instance can run.
//!
//! An adapter is a small native sidecar placed next to a browser/edge endpoint that cannot speak
//! the CE mesh transport directly. Each profile is one concrete bridge:
//!
//! * [`Profile::WebrtcIngest`] — terminate a browser WHIP publish (DTLS-SRTP), repackage the media
//!   (no re-decode), and pump it onto a `/ce/tunnel/1` mesh stream to a named encoder node.
//! * [`Profile::WebrtcEgress`] — pull a media stream off a mesh tunnel and serve it to a browser
//!   over WHEP (preview / watch).
//! * [`Profile::NodeBridge`] — expose node services (mesh publish/subscribe/request, blobs) to a
//!   browser that is not yet a full CE node; generalizes the hub's `node.html` bridge.
//!
//! The profile set is intentionally small; adding a fourth (e.g. an SRT ingest) is a new enum arm
//! plus a data-plane module — the spawn / discovery / auth / teardown machinery is shared.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

/// Which bridge an adapter instance runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Profile {
    /// Browser WHIP publish -> mesh tunnel to an encoder node.
    WebrtcIngest,
    /// Mesh tunnel -> browser WHEP (preview / watch).
    WebrtcEgress,
    /// Node services for a non-node browser.
    NodeBridge,
}

impl Profile {
    /// The canonical kebab-case name (matches the CLI and the wire form).
    pub fn as_str(&self) -> &'static str {
        match self {
            Profile::WebrtcIngest => "webrtc-ingest",
            Profile::WebrtcEgress => "webrtc-egress",
            Profile::NodeBridge => "node-bridge",
        }
    }

    /// Parse a profile from its canonical name.
    pub fn parse(s: &str) -> Result<Profile> {
        Ok(match s {
            "webrtc-ingest" => Profile::WebrtcIngest,
            "webrtc-egress" => Profile::WebrtcEgress,
            "node-bridge" => Profile::NodeBridge,
            other => bail!("unknown adapter profile '{other}' (want webrtc-ingest|webrtc-egress|node-bridge)"),
        })
    }

    /// Whether this profile opens a media tunnel to a target node (ingest/egress do; node-bridge
    /// does not).
    pub fn uses_tunnel(&self) -> bool {
        matches!(self, Profile::WebrtcIngest | Profile::WebrtcEgress)
    }
}

impl std::fmt::Display for Profile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Maximum length of an adapter instance id (a registry / topic-safe handle).
pub const MAX_INSTANCE_LEN: usize = 64;

/// The full description of an adapter instance to bring up. Carried in an
/// [`crate::protocol::AdapterStart`] control message and held by the serving runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterSpec {
    /// The bridge this instance runs.
    pub profile: Profile,
    /// Unique, topic-safe id for this instance (chosen by the spawner; e.g. `cast-cam-<rand>`).
    pub instance: String,
    /// For tunnel profiles: the peer node id (64-hex) the media tunnel connects to (the encoder for
    /// ingest, the source for egress). Empty for `node-bridge`.
    #[serde(default)]
    pub target_node: String,
    /// For tunnel profiles: the remote port on `target_node` the tunnel forwards to.
    #[serde(default)]
    pub tunnel_port: u16,
    /// Local port this adapter serves its edge protocol (WHIP/WHEP/HTTP) on, behind the public TLS
    /// front. 0 = let the runtime pick a free port and report it back.
    #[serde(default)]
    pub bind_http: u16,
    /// Self-teardown after this many seconds with no media/flow (0 = a sane default).
    #[serde(default)]
    pub idle_timeout_secs: u64,
}

impl AdapterSpec {
    /// Validate the spec before bringing the instance up. Bounds the instance id and requires a
    /// target for tunnel profiles so a malformed spawn is rejected with a clear message.
    pub fn validate(&self) -> Result<()> {
        if self.instance.is_empty() || self.instance.len() > MAX_INSTANCE_LEN {
            bail!("adapter instance id must be 1..={MAX_INSTANCE_LEN} characters");
        }
        let ok = self
            .instance
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        if !ok {
            bail!("adapter instance id may contain only a-z, 0-9, '-', '_'");
        }
        if self.profile.uses_tunnel() {
            if self.target_node.len() != 64 || !self.target_node.chars().all(|c| c.is_ascii_hexdigit()) {
                bail!("{} requires a 64-hex target_node", self.profile);
            }
            if self.tunnel_port == 0 {
                bail!("{} requires a non-zero tunnel_port", self.profile);
            }
        }
        Ok(())
    }

    /// The effective idle timeout (applies a default when unset).
    pub fn idle_timeout(&self) -> std::time::Duration {
        let secs = if self.idle_timeout_secs == 0 { 300 } else { self.idle_timeout_secs };
        std::time::Duration::from_secs(secs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_parse_roundtrip() {
        for p in [Profile::WebrtcIngest, Profile::WebrtcEgress, Profile::NodeBridge] {
            assert_eq!(Profile::parse(p.as_str()).unwrap(), p);
        }
        assert!(Profile::parse("nope").is_err());
    }

    #[test]
    fn tunnel_profiles_flagged() {
        assert!(Profile::WebrtcIngest.uses_tunnel());
        assert!(Profile::WebrtcEgress.uses_tunnel());
        assert!(!Profile::NodeBridge.uses_tunnel());
    }

    fn spec(profile: Profile) -> AdapterSpec {
        AdapterSpec {
            profile,
            instance: "cast-cam-01".into(),
            target_node: "ab".repeat(32),
            tunnel_port: 10000,
            bind_http: 0,
            idle_timeout_secs: 0,
        }
    }

    #[test]
    fn validate_accepts_good_specs() {
        assert!(spec(Profile::WebrtcIngest).validate().is_ok());
        let mut nb = spec(Profile::NodeBridge);
        nb.target_node = String::new();
        nb.tunnel_port = 0;
        assert!(nb.validate().is_ok(), "node-bridge needs no tunnel target");
    }

    #[test]
    fn validate_rejects_bad_specs() {
        let mut s = spec(Profile::WebrtcIngest);
        s.instance = "Bad Id".into();
        assert!(s.validate().is_err());
        let mut s = spec(Profile::WebrtcIngest);
        s.target_node = "xyz".into();
        assert!(s.validate().is_err());
        let mut s = spec(Profile::WebrtcIngest);
        s.tunnel_port = 0;
        assert!(s.validate().is_err());
    }

    #[test]
    fn idle_timeout_defaults() {
        assert_eq!(spec(Profile::WebrtcIngest).idle_timeout().as_secs(), 300);
        let mut s = spec(Profile::WebrtcIngest);
        s.idle_timeout_secs = 30;
        assert_eq!(s.idle_timeout().as_secs(), 30);
    }
}
