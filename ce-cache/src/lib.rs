//! # ce-cache — a distributed content-addressed CI/build cache over CE
//!
//! ce-cache is an **application built on CE primitives** (the SDK tier, like `swarm` / `rdev` /
//! `ce-pin`), not a node feature. It turns CE's content-addressed blob layer into a Bazel /
//! sccache / Turborepo-style *remote build cache*: every machine's build warms the whole fleet's
//! cache, and—because content-addressing is literally how these caches key their entries—the
//! impedance match is exact and **cache poisoning is structurally impossible**: an object fetched
//! for key `K` is re-verified against its CID, and a host that returns bytes whose hash != the
//! requested CID is rejected, not trusted.
//!
//! ## Shape
//! - [`archive`] — turn a file or a directory into one deterministic byte stream (and back), so a
//!   whole build-output dir becomes a single object CID.
//! - [`index`]   — the `key -> CID` map: a local JSON index plus, optionally, the CE DHT
//!   (`advertise_service`/`find_service`) and on-chain names (`claim_name`/`resolve_name`) so a
//!   write on one node is discoverable fleet-wide.
//! - [`proto`]   — the `cache/*` mesh wire protocol (get / put / has), capability-gated.
//! - [`store`]   — the high-level put/get/has operations a client or the HTTP shim call.
//! - [`host`]    — `serve()`: the capability-gated cache host loop (serves hits to peers).
//! - [`sidecar`] — the localhost HTTP shim: Bazel Remote Cache (CAS/AC) + sccache WebDAV → CE blobs,
//!   so existing build tools integrate with zero CE awareness.
//! - [`caps`]    — resolving the `ce-cap` chain the client presents to hosts.
//!
//! ## Trust & money (honoring CE rules)
//! Authorization is the one CE primitive: every host action verifies a signed, attenuating `ce-cap`
//! chain rooted at the host's own key or a configured org root before serving or accepting an entry.
//! Abilities are opaque app-chosen strings: `cache:read` (fetch a hit), `cache:write` (publish an
//! entry). Money is integer base units (1 credit = 10^18 base units) carried as decimal strings —
//! never floats; optional cache-hit rent is priced in base units and paid via CE payment channels.

pub mod archive;
pub mod caps;
pub mod host;
pub mod index;
pub mod proto;
pub mod sidecar;
pub mod store;

use std::path::PathBuf;

/// Load accepted capability root keys for a cache host: 64-hex NodeIds, one per line, `#` comments
/// allowed. Looked up at `$CE_CACHE_ROOTS`, else `$CE_DATA_DIR/roots`, else `~/.local/share/ce/roots`
/// — mirroring the node's and rdev's `<data_dir>/roots`. A host opts into an org/fleet by listing
/// that org's root key here; with no file, only self-issued chains are honored.
pub fn load_roots() -> Vec<[u8; 32]> {
    let path = std::env::var_os("CE_CACHE_ROOTS")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CE_DATA_DIR").map(|d| PathBuf::from(d).join("roots")))
        .or_else(|| {
            directories::ProjectDirs::from("", "", "ce").map(|p| p.data_dir().join("roots"))
        })
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
