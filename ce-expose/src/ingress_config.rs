//! Configuration for the relay-tier public HTTP ingress (`ce-expose ingress`).
//!
//! The ingress is **default-deny**: a node is publicly reachable ONLY when the relay operator has
//! explicitly added a route for its claimed name to this table, the request passes the abuse filters
//! (§3.1), and — for private endpoints — the caller presents a valid `expose:dial` capability chain.
//! An empty or missing config file therefore exposes **zero** routes.
//!
//! The whole table is operator-curated TOML loaded from `--config`. The owner may (in a future
//! on-chain `ExposeBond` flow, see `docs/public-ingress.md`) publish a signed manifest *requesting*
//! a route; the operator can only ever *tighten* the requested limits, never loosen them past the
//! global ceilings. For now the operator hand-writes the table.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;

/// Top-level ingress configuration: global ceilings + the per-endpoint route table.
///
/// `endpoints` is keyed by the public name (the first Host label, e.g. `leif`). Default-deny: a
/// request whose name is not a key here is `404`ed before any mesh work happens.
#[derive(Debug, Clone, Deserialize)]
pub struct IngressConfig {
    /// Network + abuse ceilings that apply across all endpoints.
    #[serde(default)]
    pub global: GlobalLimits,
    /// The route table. Deserialized as a list, indexed into a map by name on load.
    #[serde(default, rename = "endpoint")]
    pub endpoint_list: Vec<EndpointPolicy>,
    /// Built from `endpoint_list` at load time; not present in the TOML.
    #[serde(skip)]
    pub endpoints: HashMap<String, EndpointPolicy>,
}

/// Global, relay-wide limits. These bound the ingress as a whole so a flood can never starve the
/// relay's *primary* duty (bootstrap + circuit relay). Each defaults conservatively.
#[derive(Debug, Clone, Deserialize)]
pub struct GlobalLimits {
    /// Hard cap on simultaneous public tunnels across ALL endpoints (the mesh-stream pool ceiling).
    #[serde(default = "d_total_tunnel_ceiling")]
    pub total_tunnel_ceiling: u32,
    /// Global requests/sec across the whole ingress (token-bucket refill rate).
    #[serde(default = "d_global_rps")]
    pub global_rps: u32,
    /// Per-source-IP requests/sec.
    #[serde(default = "d_per_ip_rps")]
    pub per_ip_rps: u32,
    /// Max request body bytes accepted from the public internet (slowloris / memory bound).
    #[serde(default = "d_max_body_bytes")]
    pub max_body_bytes: u64,
    /// Max total request header bytes accepted.
    #[serde(default = "d_max_header_bytes")]
    pub max_header_bytes: usize,
    /// Total per-request timeout (ms) — a hard ceiling regardless of activity (slowloris-safe).
    #[serde(default = "d_request_timeout_ms")]
    pub request_timeout_ms: u64,
    /// Trusted reverse-proxy source. `X-Forwarded-For` is honored ONLY when the immediate peer
    /// (`ConnectInfo`) is inside this CIDR (the local nginx/Cloudflare tunnel). Empty = never trust
    /// `X-Forwarded-For` (use the socket peer as the client IP).
    #[serde(default = "d_trusted_proxy_cidr")]
    pub trusted_proxy_cidr: Vec<String>,
    /// Substrings that may not appear in a public name (anti-phishing). Case-insensitive.
    #[serde(default = "d_blocked_substrings")]
    pub blocked_substrings: Vec<String>,
    /// Name-resolution cache TTL (seconds) for name -> NodeId lookups.
    #[serde(default = "d_resolve_ttl_secs")]
    pub resolve_ttl_secs: u64,
    /// Header-read timeout (ms): how long a client may take to send the complete request head before
    /// the connection is dropped. The primary slowloris defense (stock hyper has none). 0 disables.
    #[serde(default = "d_header_read_timeout_ms")]
    pub header_read_timeout_ms: u64,
    /// Hard cap on concurrently-accepted TCP connections (slow-connection / socket-pool bound). A
    /// connection beyond this is dropped immediately at accept time. 0 disables (not recommended).
    #[serde(default = "d_max_connections")]
    pub max_connections: u32,
    /// Maximum number of per-source-IP rate-limit buckets retained. When the map is full the oldest
    /// idle bucket is evicted; this bounds memory against IPv6/XFF source-churn floods. 0 disables
    /// the cap (unbounded — not recommended on a shared relay).
    #[serde(default = "d_max_ip_buckets")]
    pub max_ip_buckets: usize,
    /// Global in-flight ingress response-byte budget (bytes) shared across ALL tunnels. Bounds total
    /// memory held in response buffers so a flood of large responses cannot OOM the relay. 0 = derive
    /// a conservative default from `total_tunnel_ceiling`.
    #[serde(default = "d_global_response_budget")]
    pub global_response_budget: u64,
    /// IPv6 prefix length to aggregate source addresses to for per-IP rate limiting (a single /64 is
    /// routinely one allocation, so one host cannot mint unlimited identities). 0–128.
    #[serde(default = "d_ipv6_rate_prefix")]
    pub ipv6_rate_prefix: u8,
}

fn d_total_tunnel_ceiling() -> u32 {
    256
}
fn d_global_rps() -> u32 {
    200
}
fn d_per_ip_rps() -> u32 {
    20
}
fn d_max_body_bytes() -> u64 {
    8 * 1024 * 1024
}
fn d_max_header_bytes() -> usize {
    64 * 1024
}
fn d_request_timeout_ms() -> u64 {
    30_000
}
fn d_trusted_proxy_cidr() -> Vec<String> {
    vec!["127.0.0.1/32".to_string(), "::1/128".to_string()]
}
fn d_blocked_substrings() -> Vec<String> {
    [
        "login", "signin", "log-in", "pay", "payment", "bank", "admin", "wallet", "secure",
        "account", "verify", "ce-net", "apple", "paypal", "google", "metamask", "seed",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}
fn d_resolve_ttl_secs() -> u64 {
    30
}
fn d_header_read_timeout_ms() -> u64 {
    10_000
}
fn d_max_connections() -> u32 {
    1024
}
fn d_max_ip_buckets() -> usize {
    100_000
}
fn d_global_response_budget() -> u64 {
    256 * 1024 * 1024 // 256 MiB total across all tunnels (fraction of the 4 GiB relay)
}
fn d_ipv6_rate_prefix() -> u8 {
    64
}

impl Default for GlobalLimits {
    fn default() -> Self {
        GlobalLimits {
            total_tunnel_ceiling: d_total_tunnel_ceiling(),
            global_rps: d_global_rps(),
            per_ip_rps: d_per_ip_rps(),
            max_body_bytes: d_max_body_bytes(),
            max_header_bytes: d_max_header_bytes(),
            request_timeout_ms: d_request_timeout_ms(),
            trusted_proxy_cidr: d_trusted_proxy_cidr(),
            blocked_substrings: d_blocked_substrings(),
            resolve_ttl_secs: d_resolve_ttl_secs(),
            header_read_timeout_ms: d_header_read_timeout_ms(),
            max_connections: d_max_connections(),
            max_ip_buckets: d_max_ip_buckets(),
            global_response_budget: d_global_response_budget(),
            ipv6_rate_prefix: d_ipv6_rate_prefix(),
        }
    }
}

/// Endpoint visibility. `Public` skips caller auth at the relay (the origin still authorizes every
/// frame); `Private` requires the caller to present an `expose:dial` chain rooted at `dial_cap_root`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "visibility", rename_all = "lowercase")]
pub enum Visibility {
    /// Open to the world (still rate-limited, byte-capped, and origin-authorized per frame).
    Public,
    /// Caller must present a valid `expose:dial` chain rooted at `dial_cap_root` (64-hex NodeId).
    Private {
        /// Accepted capability root (64-hex NodeId) for caller auth at the relay.
        dial_cap_root: String,
    },
}

/// One operator-approved route: name -> origin, plus the abuse ceilings for it.
#[derive(Debug, Clone, Deserialize)]
pub struct EndpointPolicy {
    /// Public name = the first Host label (e.g. `leif` in `leif.user.ce-net.com`).
    pub name: String,
    /// The bonded, attributable owner NodeId (64-hex). Logged on every request for accountability.
    pub owner: String,
    /// Endpoint kind. Only `http` is served by this ingress; `tcp` is reserved (Spectrum).
    #[serde(default = "d_kind")]
    pub kind: String,
    /// Visibility + (for private) the accepted caller cap root.
    #[serde(flatten)]
    pub visibility: Visibility,
    /// Whether the owner has satisfied the operator's bond/approval requirement. Default-deny: a
    /// route with `approved = false` is treated as absent (used to stage routes before go-live).
    #[serde(default)]
    pub approved: bool,
    /// Per-endpoint requests/sec (token bucket).
    #[serde(default = "d_ep_rps")]
    pub rps: u32,
    /// Per-endpoint max concurrent connections.
    #[serde(default = "d_ep_max_conns")]
    pub max_conns: u32,
    /// Per-endpoint cumulative byte cap (up+down) before further requests are refused. 0 = unlimited.
    #[serde(default = "d_ep_byte_cap")]
    pub byte_cap: u64,
    /// Per-endpoint idle timeout (ms): no progress on a tunnel for this long -> close.
    #[serde(default = "d_ep_idle_ms")]
    pub idle_timeout_ms: u64,
    /// The relay's OWN capability chain (hex) to present to the origin on the mesh hop, granting the
    /// relay's NodeId `expose:dial` on this origin. This is the ONLY cap the relay forwards upstream —
    /// the client's `X-CE-Cap` is NEVER echoed to the origin (confused-deputy hardening). Empty means
    /// the relay presents no cap (the origin will deny unless it self-issues for the relay NodeId).
    /// May be sourced from a file via `relay_cap_file` instead.
    #[serde(default)]
    pub relay_cap: String,
    /// Path to a file containing the relay's cap chain hex for this endpoint (alternative to inlining
    /// `relay_cap` in the config). Read once at load; the file should be operator-readable only.
    #[serde(default)]
    pub relay_cap_file: String,
}

fn d_kind() -> String {
    "http".to_string()
}
fn d_ep_rps() -> u32 {
    10
}
fn d_ep_max_conns() -> u32 {
    16
}
fn d_ep_byte_cap() -> u64 {
    0
}
fn d_ep_idle_ms() -> u64 {
    15_000
}

impl IngressConfig {
    /// Load and validate the config from a TOML file. A missing file is an error here (the operator
    /// must point at a real file); an empty `[[endpoint]]` set yields zero routes (default-deny).
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading ingress config {}", path.display()))?;
        Self::parse(&text)
    }

    /// Parse + validate config TOML (pure; unit-testable without the filesystem).
    pub fn parse(text: &str) -> Result<Self> {
        let mut cfg: IngressConfig =
            toml::from_str(text).context("parsing ingress config TOML")?;
        let mut endpoints = HashMap::new();
        for ep in &cfg.endpoint_list {
            ep.validate()?;
            if !ep.approved {
                tracing::warn!(name = %ep.name, "ingress route present but approved=false; skipping (default-deny)");
                continue;
            }
            let mut ep = ep.clone();
            // Resolve the relay's own cap from a file if `relay_cap_file` is set (and `relay_cap` is
            // not already inlined). The relay presents THIS cap to the origin — never the client's.
            if ep.relay_cap.is_empty() && !ep.relay_cap_file.is_empty() {
                let text = std::fs::read_to_string(&ep.relay_cap_file).with_context(|| {
                    format!("reading relay_cap_file for endpoint '{}'", ep.name)
                })?;
                ep.relay_cap = text.trim().to_string();
            }
            let ep_name = ep.name.clone();
            if endpoints.insert(ep_name.clone(), ep).is_some() {
                return Err(anyhow!("duplicate ingress endpoint name '{}'", ep_name));
            }
        }
        cfg.endpoints = endpoints;
        Ok(cfg)
    }
}

impl EndpointPolicy {
    fn validate(&self) -> Result<()> {
        if !valid_name(&self.name) {
            return Err(anyhow!(
                "ingress endpoint name '{}' is not a valid label (3-32 chars, a-z 0-9 hyphen)",
                self.name
            ));
        }
        if self.kind != "http" {
            return Err(anyhow!(
                "ingress endpoint '{}' kind '{}' unsupported (only 'http')",
                self.name,
                self.kind
            ));
        }
        if hex::decode(&self.owner).ok().filter(|b| b.len() == 32).is_none() {
            return Err(anyhow!("ingress endpoint '{}' owner must be a 64-hex NodeId", self.name));
        }
        if let Visibility::Private { dial_cap_root } = &self.visibility
            && hex::decode(dial_cap_root).ok().filter(|b| b.len() == 32).is_none()
        {
            return Err(anyhow!(
                "ingress endpoint '{}' dial_cap_root must be a 64-hex NodeId",
                self.name
            ));
        }
        Ok(())
    }
}

/// On-chain name rules (mirrors the node): 3-32 chars, lowercase `a-z` / `0-9` / hyphen, no leading
/// or trailing hyphen.
pub fn valid_name(name: &str) -> bool {
    let n = name.len();
    if !(3..=32).contains(&n) {
        return false;
    }
    if name.starts_with('-') || name.ends_with('-') {
        return false;
    }
    name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_config_yields_zero_routes() {
        let cfg = IngressConfig::parse("").unwrap();
        assert!(cfg.endpoints.is_empty(), "empty config must be default-deny");
        // Defaults still applied.
        assert_eq!(cfg.global.total_tunnel_ceiling, d_total_tunnel_ceiling());
    }

    #[test]
    fn parses_public_endpoint() {
        let owner = "11".repeat(32);
        let text = format!(
            r#"
            [[endpoint]]
            name = "leif"
            owner = "{owner}"
            visibility = "public"
            approved = true
            rps = 5
            "#
        );
        let cfg = IngressConfig::parse(&text).unwrap();
        let ep = cfg.endpoints.get("leif").expect("route present");
        assert_eq!(ep.visibility, Visibility::Public);
        assert_eq!(ep.rps, 5);
        assert_eq!(ep.max_conns, d_ep_max_conns());
    }

    #[test]
    fn parses_private_endpoint_with_root() {
        let owner = "22".repeat(32);
        let root = "33".repeat(32);
        let text = format!(
            r#"
            [[endpoint]]
            name = "secret"
            owner = "{owner}"
            visibility = "private"
            dial_cap_root = "{root}"
            approved = true
            "#
        );
        let cfg = IngressConfig::parse(&text).unwrap();
        let ep = cfg.endpoints.get("secret").unwrap();
        match &ep.visibility {
            Visibility::Private { dial_cap_root } => assert_eq!(dial_cap_root, &root),
            _ => panic!("expected private"),
        }
    }

    #[test]
    fn unapproved_route_is_skipped() {
        let owner = "11".repeat(32);
        let text = format!(
            r#"
            [[endpoint]]
            name = "staged"
            owner = "{owner}"
            visibility = "public"
            approved = false
            "#
        );
        let cfg = IngressConfig::parse(&text).unwrap();
        assert!(cfg.endpoints.is_empty(), "approved=false must not become a live route");
    }

    #[test]
    fn invalid_owner_rejected() {
        let text = r#"
            [[endpoint]]
            name = "leif"
            owner = "not-hex"
            visibility = "public"
            approved = true
            "#;
        assert!(IngressConfig::parse(text).is_err());
    }

    #[test]
    fn private_without_root_rejected() {
        let owner = "11".repeat(32);
        // `private` with no dial_cap_root fails serde (untagged field missing) -> parse error.
        let text = format!(
            r#"
            [[endpoint]]
            name = "leif"
            owner = "{owner}"
            visibility = "private"
            approved = true
            "#
        );
        assert!(IngressConfig::parse(&text).is_err());
    }

    #[test]
    fn duplicate_name_rejected() {
        let owner = "11".repeat(32);
        let text = format!(
            r#"
            [[endpoint]]
            name = "dup"
            owner = "{owner}"
            visibility = "public"
            approved = true
            [[endpoint]]
            name = "dup"
            owner = "{owner}"
            visibility = "public"
            approved = true
            "#
        );
        assert!(IngressConfig::parse(&text).is_err());
    }

    #[test]
    fn name_validation() {
        assert!(valid_name("leif"));
        assert!(valid_name("a1-b2"));
        assert!(!valid_name("ab")); // too short
        assert!(!valid_name(&"x".repeat(33))); // too long
        assert!(!valid_name("-lead"));
        assert!(!valid_name("trail-"));
        assert!(!valid_name("UPPER"));
        assert!(!valid_name("under_score"));
    }
}
