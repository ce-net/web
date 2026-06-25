//! # ce-expose — ngrok-style tunnels over CE
//!
//! ce-expose is an **application built on CE primitives** (the SDK tier, like `swarm` / `rdev` /
//! `ce-pin`), not a node feature. It exposes a `localhost` TCP/HTTP service to *other mesh peers*
//! over the existing CE tunnel/stream transport, **capability-gated**: a peer that holds a signed,
//! attenuating `ce-cap` chain granting `expose:dial` (rooted at the origin's own key or a configured
//! org root) can reach your local port; everyone else is denied. There is no public surface and no
//! guessable URL — the cap *is* the credential, and revoking it kills access on the next frame.
//!
//! ## Shape
//! - [`proto`]    — the `expose/*` mesh wire protocol (open / data / close / ping).
//! - [`caps`]     — resolving the `ce-cap` chain the consumer presents to an origin.
//! - [`session`]  — the pure, unit-tested core: the [`session::gate`] capability decision and the
//!   [`session::Session`] half-stream byte-pump state machine.
//! - [`agent`]    — `serve()`: the origin agent loop that authorizes dials and forwards bytes to the
//!   local port (`ce-expose http <port>` / `ce-expose tcp <port>`).
//! - [`consumer`] — the dialing side: bind a local listener and bridge it to a peer's endpoint.
//!
//! ## Trust & money (honoring CE rules)
//! Authorization is the one CE primitive: every origin action verifies a signed, attenuating `ce-cap`
//! chain before acting — node stays primitives-only, this app adds no node RPC. Any future bandwidth
//! billing rides CE payment channels (base-unit decimal strings, never floats); the private-mesh MVP
//! does not meter.
//!
//! ## The one thing this crate does NOT implement
//! **Public HTTP ingress on the Hetzner relay** (mapping `https://<name>.ce-net.com` to a mesh
//! stream) is a separate **relay-tier** primitive with its own abuse surface. It is *designed*, with
//! a threat model, in `docs/public-ingress.md`, and is explicitly out of scope here: no node or relay
//! change ships from this crate.

pub mod agent;
pub mod caps;
pub mod consumer;
#[cfg(feature = "ingress")]
pub mod ingress;
#[cfg(feature = "ingress")]
pub mod ingress_config;
pub mod proto;
pub mod session;

/// Load accepted capability root keys for an origin agent: 64-hex NodeIds, one per line, `#`
/// comments allowed. Looked up at `$CE_EXPOSE_ROOTS`, else `$CE_DATA_DIR/roots`, else
/// `~/.local/share/ce/roots` — mirroring the node's and rdev's `<data_dir>/roots`. An origin opts
/// into an org/fleet by listing that org's root key here; with no file, only self-issued chains are
/// honored (the zero-config personal case).
pub fn load_roots() -> Vec<[u8; 32]> {
    use std::path::PathBuf;
    let path = std::env::var_os("CE_EXPOSE_ROOTS")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CE_DATA_DIR").map(|d| PathBuf::from(d).join("roots")))
        .or_else(|| directories::ProjectDirs::from("", "", "ce").map(|p| p.data_dir().join("roots")))
        .unwrap_or_else(|| PathBuf::from("roots"));
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    text.lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| !l.is_empty())
        .filter_map(|h| hex::decode(h).ok().and_then(|b| b.try_into().ok()))
        .collect()
}
