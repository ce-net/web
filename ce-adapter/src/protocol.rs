//! The ce-adapter control wire protocol.
//!
//! Spawning, stopping, and querying an adapter instance ride CE's authenticated `AppRequest`/reply
//! primitive (the same one ce-fn uses for invoke), on the [`CONTROL_TOPIC`] topic. A spawner sends a
//! [`ControlRequest`] to the host that should run the adapter; the host's serve runtime answers with
//! a [`ControlResponse`]. The sender's NodeId is authenticated by the node for free; the request
//! also carries a `ce-cap` chain so the runtime can authorize the specific action.
//!
//! Idle instances announce [`AdapterIdle`] on [`IDLE_TOPIC`] before exiting, so a spawner can reap
//! its ce-fn cell.

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::profile::{AdapterSpec, Profile};

/// The `AppRequest` topic carrying adapter control (start/stop/status).
pub const CONTROL_TOPIC: &str = "ce-adapter/control";
/// The pubsub topic adapters announce idle/teardown on.
pub const IDLE_TOPIC: &str = "ce-adapter/idle";

/// Maximum size of an encoded control envelope on the wire (these are tiny JSON control messages).
pub const MAX_ENVELOPE_BYTES: usize = 64 * 1024;

/// A control request from a spawner to a host's adapter runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ControlRequest {
    /// Bring up (or confirm) an adapter instance per `spec`; returns its public endpoint.
    Start {
        /// What to start.
        spec: AdapterSpec,
        /// Capability chain (hex) granting `adapter:spawn` on this host. Empty = none (denied).
        #[serde(default)]
        caps: String,
    },
    /// Tear down a running instance by id.
    Stop {
        /// The instance id to stop.
        instance: String,
        /// Capability chain (hex) granting `adapter:spawn` on this host.
        #[serde(default)]
        caps: String,
    },
    /// List the instances this host is currently running.
    Status {
        /// Capability chain (hex) granting `adapter:spawn` on this host.
        #[serde(default)]
        caps: String,
    },
}

impl ControlRequest {
    /// The capability token presented with this request (for authorization).
    pub fn caps(&self) -> &str {
        match self {
            ControlRequest::Start { caps, .. } => caps,
            ControlRequest::Stop { caps, .. } => caps,
            ControlRequest::Status { caps } => caps,
        }
    }

    /// Serialize to the bytes carried in an `AppRequest`.
    pub fn encode(&self) -> Result<Vec<u8>> {
        let bytes = serde_json::to_vec(self).map_err(|e| anyhow!("encoding control request: {e}"))?;
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(anyhow!("control request too large: {} bytes", bytes.len()));
        }
        Ok(bytes)
    }

    /// Parse from `AppRequest` bytes, rejecting an oversized envelope.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(anyhow!("control request too large: {} bytes", bytes.len()));
        }
        serde_json::from_slice(bytes).map_err(|e| anyhow!("malformed control request: {e}"))
    }
}

/// The public endpoint of a running adapter instance — what the spawner hands a browser.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterEndpoint {
    /// The instance id.
    pub instance: String,
    /// The bridge it runs.
    pub profile: String,
    /// Public WHIP URL for a webrtc-ingest instance (empty otherwise).
    #[serde(default)]
    pub whip_url: String,
    /// Public WHEP URL for a webrtc-egress instance (empty otherwise).
    #[serde(default)]
    pub whep_url: String,
    /// The node id hosting this instance (64-hex).
    #[serde(default)]
    pub host_node: String,
    /// The peer node the media tunnel targets (encoder/source), if any.
    #[serde(default)]
    pub target_node: String,
    /// The remote tunnel port, if any.
    #[serde(default)]
    pub tunnel_port: u16,
}

/// Brief status of one running instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceStatus {
    /// Instance id.
    pub instance: String,
    /// Profile name.
    pub profile: String,
    /// Whether media/flow has been observed recently.
    pub active: bool,
    /// Seconds since the instance started.
    pub uptime_secs: u64,
}

/// A control response from a host's adapter runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum ControlResponse {
    /// The instance is up; here is its public endpoint.
    Started(AdapterEndpoint),
    /// The instance was stopped (or was not running).
    Stopped,
    /// The host's current instances.
    Status(Vec<InstanceStatus>),
    /// The request failed (authorization, bad spec, or a data-plane error).
    Error(String),
}

impl ControlResponse {
    /// Convenience: an error response.
    pub fn error(msg: impl Into<String>) -> Self {
        ControlResponse::Error(msg.into())
    }

    /// Serialize to reply bytes.
    pub fn encode(&self) -> Result<Vec<u8>> {
        let bytes = serde_json::to_vec(self).map_err(|e| anyhow!("encoding control response: {e}"))?;
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(anyhow!("control response too large: {} bytes", bytes.len()));
        }
        Ok(bytes)
    }

    /// Parse from reply bytes.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(anyhow!("control response too large: {} bytes", bytes.len()));
        }
        serde_json::from_slice(bytes).map_err(|e| anyhow!("malformed control response: {e}"))
    }
}

/// An announcement an adapter publishes on [`IDLE_TOPIC`] right before it tears itself down, so the
/// spawner can reap the underlying ce-fn cell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterIdle {
    /// The instance that went idle.
    pub instance: String,
    /// The host node it ran on.
    pub host_node: String,
    /// The profile it ran.
    pub profile: String,
}

impl AdapterIdle {
    /// Serialize for publishing.
    pub fn encode(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self).map_err(|e| anyhow!("encoding idle announce: {e}"))
    }

    /// Parse a received idle announcement.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        serde_json::from_slice(bytes).map_err(|e| anyhow!("malformed idle announce: {e}"))
    }
}

/// Build the public edge URL (WHIP/WHEP) a browser should hit for an instance, given the adapter's
/// public base (e.g. `https://cast.ce-net.com`). Kept here so the spawner and the runtime agree on
/// the path shape: `<base>/adapter/<instance>/<whip|whep>`.
pub fn edge_url(public_base: &str, instance: &str, profile: Profile) -> String {
    let base = public_base.trim_end_matches('/');
    match profile {
        Profile::WebrtcIngest => format!("{base}/adapter/{instance}/whip"),
        Profile::WebrtcEgress => format!("{base}/adapter/{instance}/whep"),
        Profile::NodeBridge => format!("{base}/adapter/{instance}/ce"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::Profile;

    fn spec() -> AdapterSpec {
        AdapterSpec {
            profile: Profile::WebrtcIngest,
            instance: "cast-cam-01".into(),
            target_node: "ab".repeat(32),
            tunnel_port: 10000,
            bind_http: 0,
            idle_timeout_secs: 0,
        }
    }

    #[test]
    fn control_request_roundtrip() {
        let req = ControlRequest::Start { spec: spec(), caps: "deadbeef".into() };
        let back = ControlRequest::decode(&req.encode().unwrap()).unwrap();
        assert_eq!(req, back);
        assert_eq!(back.caps(), "deadbeef");
    }

    #[test]
    fn control_response_roundtrip() {
        let r = ControlResponse::Started(AdapterEndpoint {
            instance: "cast-cam-01".into(),
            profile: "webrtc-ingest".into(),
            whip_url: "https://cast.ce-net.com/adapter/cast-cam-01/whip".into(),
            ..Default::default()
        });
        let back = ControlResponse::decode(&r.encode().unwrap()).unwrap();
        assert_eq!(r, back);
    }

    #[test]
    fn decode_rejects_oversized() {
        let big = vec![b'x'; MAX_ENVELOPE_BYTES + 1];
        assert!(ControlRequest::decode(&big).is_err());
        assert!(ControlResponse::decode(&big).is_err());
    }

    #[test]
    fn edge_url_shapes() {
        assert_eq!(
            edge_url("https://cast.ce-net.com/", "i1", Profile::WebrtcIngest),
            "https://cast.ce-net.com/adapter/i1/whip"
        );
        assert_eq!(
            edge_url("https://cast.ce-net.com", "i1", Profile::WebrtcEgress),
            "https://cast.ce-net.com/adapter/i1/whep"
        );
    }

    #[test]
    fn idle_roundtrip() {
        let i = AdapterIdle { instance: "i1".into(), host_node: "cd".repeat(32), profile: "webrtc-ingest".into() };
        assert_eq!(AdapterIdle::decode(&i.encode().unwrap()).unwrap(), i);
    }
}
