//! ce-expose wire protocol: the typed messages exchanged over the CE mesh on the `expose/*` topics.
//!
//! ce-expose is an **application built on CE primitives** (the SDK tier, like `swarm` / `rdev` /
//! `ce-pin`), not a node feature. It exposes a local TCP/HTTP service to *other mesh peers* over the
//! existing CE tunnel/stream transport, gated by a capability: a peer that holds a signed,
//! attenuating `ce-cap` chain granting `expose:dial` (rooted at the origin's own key or a configured
//! org root) can reach the origin's local port; everyone else is denied.
//!
//! ## Why request/reply frames and not a single stream
//! The node's stream/tunnel primitive carries raw bytes node-to-node, but the SDK (`ce-rs`) exposes
//! the mesh as authenticated **request/reply** and **pub/sub** over app-chosen topics (the rdev /
//! ce-pin pattern). To stay strictly **no-node-change**, ce-expose layers a small framed session
//! over request/reply: the consumer dials with `OpenReq`, then drives the connection with a sequence
//! of `DataReq` frames (each carrying a chunk of TCP bytes), and the origin replies with the bytes it
//! read back from the local socket. Each frame re-presents the capability so the origin re-authorizes
//! every step and an expired/revoked cap kills the session immediately. This is the buildable,
//! testable control+data plane; swapping the data path onto a single raw libp2p stream later is a
//! transparent transport change (see `docs/public-ingress.md`).
//!
//! Payloads are JSON, hex-encoded by the SDK's `request`/`reply` transport. Byte chunks inside the
//! frames are hex-encoded too (never base64-with-padding ambiguity, and never a float anywhere).

use serde::{Deserialize, Serialize};

/// Topic prefix for all ce-expose mesh messages.
pub const TOPIC_PREFIX: &str = "expose/";

/// Topic: a consumer opens a new tunnel session to a named/identified endpoint.
pub const TOPIC_OPEN: &str = "expose/open";
/// Topic: a consumer pushes the next chunk of bytes on an open session and pulls the response bytes.
pub const TOPIC_DATA: &str = "expose/data";
/// Topic: a consumer (or the origin) closes a session.
pub const TOPIC_CLOSE: &str = "expose/close";
/// Topic: cheap liveness — is this endpoint serving?
pub const TOPIC_PING: &str = "expose/ping";

/// Ability: a peer may open (dial) the origin's exposed local port. This is the opaque app-chosen
/// action string the origin's `ce-cap` chain must grant. Revoke the cap and dials are denied.
pub const ABILITY_DIAL: &str = "expose:dial";

/// The DHT service string the origin advertises for a named endpoint, so consumers can discover the
/// owning NodeId without a central directory (`advertise_service` / `find_service`).
pub fn service_for(name: &str) -> String {
    format!("expose:{name}")
}

/// The transport kind an endpoint exposes. `Http` and `Tcp` are byte-identical on the wire (both are
/// raw TCP streams); the distinction is advisory metadata for tooling and the future relay ingress
/// (only `Http` endpoints get a public hostname there — see `docs/public-ingress.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Http,
    Tcp,
}

impl Kind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Http => "http",
            Kind::Tcp => "tcp",
        }
    }
}

/// `expose/open` request: ask the origin to dial its own local port and start a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenReq {
    /// Hex-encoded `ce-cap` chain granting `expose:dial` on the origin.
    pub caps: String,
    /// The endpoint name the consumer believes it is reaching (advisory; the origin may host several).
    #[serde(default)]
    pub endpoint: String,
    /// Consumer-chosen session id (hex/uuid-like). The origin keys its connection table by
    /// (sender NodeId, session) so two consumers never collide.
    pub session: String,
}

/// `expose/open` reply.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OpenResp {
    /// Whether the origin authorized the dial and opened a local connection.
    pub accepted: bool,
    /// The transport kind of the endpoint, for the consumer's information.
    #[serde(default)]
    pub kind: Option<String>,
    /// Human-readable reason when `accepted == false` (e.g. "denied: capability does not grant ...").
    #[serde(default)]
    pub reason: Option<String>,
}

/// `expose/data` request: push a chunk of consumer->origin bytes and pull the origin->consumer bytes
/// that the local service produced since the last frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataReq {
    /// The capability is re-presented on every frame so the origin re-authorizes continuously; an
    /// expired or revoked chain kills the session on the very next frame.
    pub caps: String,
    /// The session id from `OpenReq`.
    pub session: String,
    /// Consumer->origin bytes for the local socket, hex-encoded. Empty = "I have nothing to send,
    /// just drain your read buffer" (a poll).
    #[serde(default)]
    pub up_hex: String,
    /// Consumer-side EOF: the consumer's TCP read side closed; no more `up` bytes will come.
    #[serde(default)]
    pub up_eof: bool,
}

/// `expose/data` reply: the origin->consumer bytes read from the local service.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DataResp {
    /// True while the session is alive and authorized.
    pub ok: bool,
    /// Origin->consumer bytes from the local socket, hex-encoded.
    #[serde(default)]
    pub down_hex: String,
    /// Origin-side EOF: the local service closed its write side; no more `down` bytes will come.
    #[serde(default)]
    pub down_eof: bool,
    /// Reason when `ok == false` (denied, unknown session, local dial failed, ...).
    #[serde(default)]
    pub reason: Option<String>,
}

/// `expose/close` request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseReq {
    pub caps: String,
    pub session: String,
}

/// `expose/close` reply.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CloseResp {
    pub closed: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `expose/ping` request: a liveness probe. Authorized like every other action so an unauthorized
/// peer cannot even confirm an endpoint exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingReq {
    pub caps: String,
    #[serde(default)]
    pub endpoint: String,
}

/// `expose/ping` reply.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PingResp {
    pub alive: bool,
    /// The endpoint kind, for the consumer.
    #[serde(default)]
    pub kind: Option<String>,
}

/// Pull just the `caps` field out of any `expose/*` request payload (all share it) so the agent can
/// authorize before fully deserializing the action-specific body. Mirrors ce-pin's `caps_of`.
pub fn caps_of(payload: &[u8]) -> anyhow::Result<String> {
    #[derive(serde::Deserialize)]
    struct HasCaps {
        caps: String,
    }
    let hc: HasCaps =
        serde_json::from_slice(payload).map_err(|e| anyhow::anyhow!("payload missing caps: {e}"))?;
    Ok(hc.caps)
}

/// Map an `expose/<action>` topic to the ability it requires. Every action requires `expose:dial`
/// (there is one privilege: "may reach this endpoint"); listing them explicitly keeps the agent's
/// dispatch table honest and makes adding a finer-grained action later a one-line change.
pub fn ability_for(action: &str) -> anyhow::Result<&'static str> {
    match action {
        "open" | "data" | "close" | "ping" => Ok(ABILITY_DIAL),
        other => Err(anyhow::anyhow!("unknown expose action '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_strings_are_name_namespaced() {
        assert_eq!(service_for("leif"), "expose:leif");
        assert_ne!(service_for("a"), service_for("b"));
    }

    #[test]
    fn ability_is_dial_for_every_action() {
        for a in ["open", "data", "close", "ping"] {
            assert_eq!(ability_for(a).unwrap(), ABILITY_DIAL);
        }
        assert!(ability_for("bogus").is_err());
    }

    #[test]
    fn caps_of_extracts_field() {
        let req = OpenReq { caps: "deadbeef".into(), endpoint: "x".into(), session: "s1".into() };
        let bytes = serde_json::to_vec(&req).unwrap();
        assert_eq!(caps_of(&bytes).unwrap(), "deadbeef");
    }

    #[test]
    fn caps_of_errors_without_field() {
        assert!(caps_of(br#"{"session":"s"}"#).is_err());
    }

    #[test]
    fn open_roundtrips_json() {
        let req = OpenReq { caps: "ab".into(), endpoint: "web".into(), session: "sess-1".into() };
        let bytes = serde_json::to_vec(&req).unwrap();
        let back: OpenReq = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.session, "sess-1");
        assert_eq!(back.endpoint, "web");
    }

    #[test]
    fn data_resp_defaults_when_fields_absent() {
        let r: DataResp = serde_json::from_str(r#"{"ok":true}"#).unwrap();
        assert!(r.ok);
        assert_eq!(r.down_hex, "");
        assert!(!r.down_eof);
        assert!(r.reason.is_none());
    }

    #[test]
    fn kind_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&Kind::Http).unwrap(), "\"http\"");
        assert_eq!(serde_json::to_string(&Kind::Tcp).unwrap(), "\"tcp\"");
        assert_eq!(Kind::Http.as_str(), "http");
    }
}
