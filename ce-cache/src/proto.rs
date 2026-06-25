//! ce-cache wire protocol: the typed messages exchanged over the CE mesh on the `cache/*` topics.
//!
//! Every request carries `caps` — a hex-encoded `ce-cap` capability chain — which the host
//! authorizes (rooted at the host's own key or a configured org root) before honoring the action.
//! Abilities are opaque app-chosen strings: `cache:read` (fetch a hit) and `cache:write` (publish an
//! entry).
//!
//! Payloads are JSON, hex-encoded by the SDK's `request`/`reply` transport. Content-addressing is
//! the integrity proof: a cache entry's CID *is* the hash of its (chunked) bytes, and `get_object`
//! re-verifies every chunk against its CID, so a host can never return bytes other than the exact
//! entry that was published — cache poisoning is structurally impossible.

use serde::{Deserialize, Serialize};

/// Topic prefix for all ce-cache mesh messages.
pub const TOPIC_PREFIX: &str = "cache/";

/// Ability: fetch a cache entry (resolve a key and pull the object).
pub const ABILITY_READ: &str = "cache:read";
/// Ability: publish a cache entry (map a key to a CID the host should remember and serve).
pub const ABILITY_WRITE: &str = "cache:write";

/// The DHT service string any node willing to act as a cache host advertises. A client ranks these
/// (atlas capacity + on-chain history) when choosing where to read/write entries.
pub const SERVICE_HOST: &str = "cache:host";

/// The DHT service string a host advertises for a specific cache key, so a reader can discover which
/// peers hold an entry for that key without a central tracker (`advertise_service`/`find_service`).
/// The key is hashed into the service string to keep it DHT-safe and fixed-length.
pub fn service_for_key(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(key.as_bytes());
    format!("cache:key:{}", hex::encode(h))
}

/// `cache/has` request: does the host know a CID for this key (a cache hit)?
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HasReq {
    /// Hex-encoded capability chain granting `cache:read` on the host.
    pub caps: String,
    /// The cache key (the build tool's own content/action hash; we do not recompute it).
    pub key: String,
}

/// `cache/has` reply.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HasResp {
    /// Whether the host has a CID mapped for this key.
    pub hit: bool,
    /// The object CID, if hit (the manifest hash from `put_object`).
    #[serde(default)]
    pub cid: Option<String>,
    /// Entry size in bytes, if known.
    #[serde(default)]
    pub size: u64,
}

/// `cache/get` request: resolve a key to its CID so the reader can fetch the object itself via the
/// (trustless, CID-verifying) data layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetReq {
    pub caps: String,
    pub key: String,
}

/// `cache/get` reply: the CID for the key (the reader fetches the bytes via `get_object`, which
/// re-verifies every chunk against the CID — so the host cannot return poisoned bytes).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GetResp {
    /// The object CID for the key, or `None` for a miss.
    #[serde(default)]
    pub cid: Option<String>,
    /// Entry size in bytes, if known.
    #[serde(default)]
    pub size: u64,
    /// Human-readable reason on a miss.
    #[serde(default)]
    pub reason: Option<String>,
}

/// `cache/put` request: publish a `key -> CID` mapping to the host. The host fetches the object via
/// `get_object` (CID-verified) so it can later serve it, then remembers the mapping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutReq {
    /// Hex-encoded capability chain granting `cache:write` on the host.
    pub caps: String,
    /// The cache key.
    pub key: String,
    /// The object CID the key maps to (manifest hash from `put_object`).
    pub cid: String,
    /// Entry size in bytes (informational; the host enforces its own limits).
    pub size: u64,
    /// Optional rent the writer offers, in **base units** per GB-hour (decimal string; never a
    /// float). Base units: 1 credit = 10^18 base units, wei-style. `None` = best-effort/free fleet.
    #[serde(default)]
    pub rent_per_gb_hour: Option<String>,
}

/// `cache/put` reply.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PutResp {
    /// Whether the host accepted, fetched, and now serves the entry.
    pub accepted: bool,
    /// The host's view of the object size after a successful fetch.
    #[serde(default)]
    pub stored_bytes: u64,
    /// Human-readable reason when `accepted == false`.
    #[serde(default)]
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_service_strings_are_namespaced_and_stable() {
        let s = service_for_key("//foo:bar");
        assert!(s.starts_with("cache:key:"));
        // Deterministic: same key -> same service string.
        assert_eq!(s, service_for_key("//foo:bar"));
        // Distinct keys -> distinct service strings.
        assert_ne!(service_for_key("a"), service_for_key("b"));
        assert_ne!(s, SERVICE_HOST);
    }

    #[test]
    fn put_roundtrips_json() {
        let req = PutReq {
            caps: "deadbeef".into(),
            key: "//pkg:target".into(),
            cid: "f00d".into(),
            size: 4096,
            rent_per_gb_hour: Some("1000000000000000".into()),
        };
        let bytes = serde_json::to_vec(&req).unwrap();
        let back: PutReq = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.cid, "f00d");
        assert_eq!(back.rent_per_gb_hour.as_deref(), Some("1000000000000000"));
        assert_eq!(back.size, 4096);
    }

    #[test]
    fn resp_defaults_when_fields_absent() {
        // A minimal host that only sets `hit` must still deserialize.
        let r: HasResp = serde_json::from_str(r#"{"hit":true}"#).unwrap();
        assert!(r.hit);
        assert!(r.cid.is_none());
        assert_eq!(r.size, 0);

        // A put with no rent field still deserializes (free fleet).
        let p: PutReq =
            serde_json::from_str(r#"{"caps":"","key":"k","cid":"c","size":1}"#).unwrap();
        assert!(p.rent_per_gb_hour.is_none());
    }
}
