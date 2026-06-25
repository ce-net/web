//! Public HTTP ingress — the **relay-tier** front door (`ce-expose ingress`).
//!
//! This is the one piece that turns a private, capability-gated mesh tunnel into a public
//! `https://<name>.user.ce-net.com` URL. It is feature-gated (`--features ingress`) so a normal node
//! never pulls axum, and it is meant to run ONLY on the hardened public relay, bound to `127.0.0.1`
//! behind nginx/Cloudflare.
//!
//! ## Security model (the whole point)
//! Nodes are **mesh-only by default and never internet-exposed**. The relay is the single hardened
//! public node. Public ingress is an **opt-in, default-DENY capability**: an origin becomes publicly
//! reachable only when (a) it runs `ce-expose http --name <n>` to claim the name, (b) the operator's
//! policy table ([`IngressConfig`]) contains an *approved* route for that name, and (c) for private
//! endpoints the caller presents a valid `expose:dial` chain. The origin agent **independently
//! authorizes every mesh frame** (unchanged [`crate::agent`]) — the relay's check is an early-reject
//! and an audit point, defense in depth, never the sole gate.
//!
//! Per request the handler enforces, in order: kill switch -> Host parse -> route lookup (default
//! deny -> 404) -> name abuse filter -> global/per-IP/per-endpoint rate limit -> total-tunnel ceiling
//! -> per-endpoint conn ceiling -> (private) caller cap check -> name resolve -> mesh bridge with a
//! cumulative byte cap, idle + total timeout, and bounded buffers. One structured JSON log line is
//! emitted per request (never logging cap secrets or bodies).

#![cfg(feature = "ingress")]

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow};
use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::Response;
use axum::routing::any;
use tokio::sync::Mutex;

use ce_rs::CeClient;

use crate::ingress_config::{EndpointPolicy, GlobalLimits, IngressConfig, Visibility};
use crate::proto::*;
use crate::session::{RevokedSet, gate};

// ============================ pure, unit-tested building blocks ============================

/// Extract the public name (first Host label) from a `Host` header value.
///
/// `leif.user.ce-net.com` -> `Some("leif")`. Rejects: missing/empty host, an IP literal, a host with
/// no dot (a bare apex or a single label), a leading dot, or a port-only host. The port suffix
/// (`:443`) is stripped first. The returned name is lowercased; the caller still runs it through the
/// route table + abuse filter (this only does structural parsing).
pub fn parse_host_name(host: Option<&str>) -> Option<String> {
    let host = host?.trim();
    if host.is_empty() {
        return None;
    }
    // Strip a port. IPv6 literals (`[::1]:80`) are rejected outright below, so a naive rsplit on the
    // last colon is safe for the hostnames we accept (which never contain a colon).
    let host = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') {
        return None;
    }
    // Reject IP literals (no public name maps to a raw IP).
    if host.parse::<IpAddr>().is_ok() || host.starts_with('[') {
        return None;
    }
    let (first, rest) = host.split_once('.')?;
    // Require at least one more label after the name (so a bare single-label host is rejected).
    if first.is_empty() || rest.is_empty() {
        return None;
    }
    // Anti-phishing / homoglyph defense: the public name label must be a strict ASCII-LDH label.
    // Reject any non-ASCII byte (Unicode confusables) and any `xn--` punycode prefix outright, BEFORE
    // route lookup — otherwise a homoglyph (`pаypal`) or its punycode form sails past the lexical
    // `blocked_substrings` filter. The on-chain name rules are ASCII a-z/0-9/hyphen only, so a
    // legitimate name never contains either.
    let lower = first.to_ascii_lowercase();
    if !lower.is_ascii() || lower.starts_with("xn--") {
        return None;
    }
    if !lower.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return None;
    }
    Some(lower)
}

/// Does `name` contain any blocked (anti-phishing) substring? Case-insensitive. Returns the matched
/// substring so it can be logged as the deny reason.
pub fn blocked_substring<'a>(name: &str, blocked: &'a [String]) -> Option<&'a str> {
    let lname = name.to_ascii_lowercase();
    blocked.iter().find(|b| lname.contains(b.as_str())).map(|s| s.as_str())
}

/// A simple, monotonic-clock token-bucket rate limiter. `capacity` tokens, refilled at `rate`
/// tokens/sec. `try_take` returns true if a token was available. Pure given an injected `now`, so it
/// is deterministic in tests.
#[derive(Debug)]
pub struct TokenBucket {
    capacity: f64,
    rate: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    /// New bucket at full capacity. `rps` is both the per-second refill and the burst capacity.
    pub fn new(rps: u32) -> Self {
        let cap = rps.max(1) as f64;
        TokenBucket { capacity: cap, rate: cap, tokens: cap, last: Instant::now() }
    }

    /// Refill based on elapsed time, then try to consume one token. `now` is injected for tests.
    pub fn try_take_at(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.rate).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Consume one token using the real clock.
    pub fn try_take(&mut self) -> bool {
        self.try_take_at(Instant::now())
    }

    /// Is the bucket refilled to (at least) full capacity as of `now`? Used to find idle buckets that
    /// are safe to evict — a full bucket has not been consumed recently.
    pub fn is_full(&self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        (self.tokens + elapsed * self.rate) >= self.capacity
    }
}

/// Cumulative byte-cap accounting for one endpoint. `0` cap = unlimited. `over()` is true once the
/// running total has exceeded the cap; further requests are then refused with 429.
#[derive(Debug, Default)]
pub struct ByteCap {
    cap: u64,
    used: u64,
}

impl ByteCap {
    pub fn new(cap: u64) -> Self {
        ByteCap { cap, used: 0 }
    }
    /// Add `n` observed bytes (up+down) to the running total.
    pub fn add(&mut self, n: u64) {
        self.used = self.used.saturating_add(n);
    }
    /// Has the endpoint exceeded its cap? Always false when `cap == 0` (unlimited).
    pub fn over(&self) -> bool {
        self.cap != 0 && self.used >= self.cap
    }
    pub fn used(&self) -> u64 {
        self.used
    }
}

/// The global kill switch: either the `--kill-switch` flag is set, OR a control file exists on disk
/// (so an operator can `touch <data>/ingress.kill` to disable all ingress without a restart). Checked
/// per request. Disabling ingress never touches the relay's bootstrap/circuit-relay duties.
#[derive(Debug)]
pub struct KillSwitch {
    flag: AtomicBool,
    control_file: PathBuf,
}

impl KillSwitch {
    pub fn new(flag: bool, control_file: PathBuf) -> Self {
        KillSwitch { flag: AtomicBool::new(flag), control_file }
    }

    /// Is ingress killed right now? True if the flag is set or the control file is present.
    ///
    /// The control-file check **fails closed**: a clear `NotFound` means "not killed", but any other
    /// FS error (permissions, transient I/O on the kill path) is treated as killed. For a safety kill
    /// switch the ambiguous case must stop ingress, never silently keep serving.
    pub fn is_killed(&self) -> bool {
        if self.flag.load(Ordering::SeqCst) {
            return true;
        }
        match std::fs::metadata(&self.control_file) {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => true, // ambiguous FS error -> fail closed (kill)
        }
    }

    /// For tests / an admin endpoint: flip the in-memory flag.
    pub fn set_flag(&self, on: bool) {
        self.flag.store(on, Ordering::SeqCst);
    }
}

/// Decide the client IP when the relay is fronted by a proxy.
///
/// Behind nginx/Cloudflare the socket peer is always loopback, so a left-most `X-Forwarded-For` entry
/// is fully attacker-chosen if the proxy *appends* (the nginx `$proxy_add_x_forwarded_for` /
/// Cloudflare default). We therefore:
///   1. Prefer a single-value `cf_connecting_ip` (Cloudflare's authoritative client IP) when the peer
///      is trusted — it cannot be appended to and the client cannot forge a second value.
///   2. Otherwise walk `X-Forwarded-For` from the RIGHT, skipping trusted-proxy hops, and take the
///      first untrusted address — the real client as seen just past our trust boundary. This is
///      robust to an attacker prepending extra entries (they only sit further left and are ignored).
///   3. Fall back to the socket peer when nothing trustworthy is available.
///
/// Only honored when the immediate socket peer is inside `trusted_cidrs`; an untrusted peer's headers
/// are ignored entirely.
pub fn client_ip(
    peer: IpAddr,
    xff: Option<&str>,
    cf_connecting_ip: Option<&str>,
    trusted_cidrs: &[String],
) -> IpAddr {
    let peer_trusted = trusted_cidrs.iter().any(|c| cidr_contains(c, peer));
    if !peer_trusted {
        return peer;
    }
    // 1. Cloudflare's single-value header is the strongest signal when present.
    if let Some(cf) = cf_connecting_ip
        && let Ok(ip) = cf.trim().parse::<IpAddr>()
    {
        return ip;
    }
    // 2. Right-most untrusted XFF entry (peel off trusted hops).
    if let Some(xff) = xff {
        for entry in xff.split(',').rev() {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            if let Ok(ip) = entry.parse::<IpAddr>() {
                if trusted_cidrs.iter().any(|c| cidr_contains(c, ip)) {
                    continue; // a known proxy hop — keep peeling
                }
                return ip;
            }
        }
    }
    // 3. Nothing usable — the socket peer (the proxy itself).
    peer
}

/// Minimal CIDR membership test for IPv4/IPv6 (`a.b.c.d/n` or `::1/128`). A bare IP (no `/`) matches
/// itself. Best-effort: a malformed CIDR never matches (fails closed).
pub fn cidr_contains(cidr: &str, ip: IpAddr) -> bool {
    let (net_str, prefix) = match cidr.split_once('/') {
        Some((n, p)) => match p.parse::<u32>() {
            Ok(p) => (n, p),
            Err(_) => return false,
        },
        None => (cidr, u32::MAX), // bare IP -> exact match
    };
    let Ok(net) = net_str.parse::<IpAddr>() else { return false };
    match (net, ip) {
        (IpAddr::V4(net), IpAddr::V4(ip)) => {
            let p = prefix.min(32);
            if p == 0 {
                return true;
            }
            let mask: u32 = if p >= 32 { u32::MAX } else { !(u32::MAX >> p) };
            (u32::from(net) & mask) == (u32::from(ip) & mask)
        }
        (IpAddr::V6(net), IpAddr::V6(ip)) => {
            let p = prefix.min(128);
            if p == 0 {
                return true;
            }
            let mask: u128 = if p >= 128 { u128::MAX } else { !(u128::MAX >> p) };
            (u128::from(net) & mask) == (u128::from(ip) & mask)
        }
        _ => false, // mixed families never match
    }
}

// ============================ live server state ============================

/// A bounded per-source-IP token-bucket map. When the configured `max` is reached, an idle bucket
/// (one that has refilled back to full capacity) is evicted to make room, so a flood of distinct
/// source IPs (IPv6 /64 churn, forged XFF) cannot grow memory without bound. If no idle bucket exists
/// the insert is refused and the request is treated as rate-limited (fail closed).
struct BoundedIpBuckets {
    map: HashMap<IpAddr, TokenBucket>,
    max: usize,
}

impl BoundedIpBuckets {
    fn new(max: usize) -> Self {
        BoundedIpBuckets { map: HashMap::new(), max }
    }

    /// Try to consume one token for `ip`, refilling at `rps`. Returns `Some(true)` if allowed,
    /// `Some(false)` if rate-limited, `None` if the map is full and no idle bucket could be evicted
    /// (caller fails closed). `max == 0` disables the bound (always inserts).
    fn try_take(&mut self, ip: IpAddr, rps: u32, now: Instant) -> Option<bool> {
        if !self.map.contains_key(&ip) && self.max != 0 && self.map.len() >= self.max {
            // Evict one full (idle) bucket; if none, refuse (fail closed to global-only limiting).
            let victim = self
                .map
                .iter()
                .find(|(_, b)| b.is_full(now))
                .map(|(k, _)| *k);
            match victim {
                Some(k) => {
                    self.map.remove(&k);
                }
                None => return None,
            }
        }
        let b = self.map.entry(ip).or_insert_with(|| TokenBucket::new(rps));
        Some(b.try_take_at(now))
    }
}

/// Shared, runtime ingress state behind the axum handler.
struct Ingress {
    client: CeClient,
    cfg: IngressConfig,
    roots: Vec<[u8; 32]>,
    kill: KillSwitch,
    /// Global token bucket.
    global_bucket: Mutex<TokenBucket>,
    /// Per-source-IP token buckets, bounded + evicting so source-churn cannot exhaust memory.
    ip_buckets: Mutex<BoundedIpBuckets>,
    /// Per-endpoint token buckets, keyed by name.
    ep_buckets: Mutex<HashMap<String, TokenBucket>>,
    /// Per-endpoint cumulative byte caps, keyed by name (initialized for every route at startup).
    ep_bytes: Mutex<HashMap<String, ByteCap>>,
    /// Per-endpoint live connection counts, keyed by name. Atomic so the RAII guard decrements
    /// synchronously (no detached task) and admission is a single compare-and-increment.
    ep_conns: HashMap<String, AtomicU32>,
    /// Total simultaneous tunnels across all endpoints (the hard ceiling).
    total_tunnels: AtomicU32,
    /// Global in-flight response-byte budget (semaphore permits == bytes) so the sum of all tunnel
    /// response buffers can never OOM the relay regardless of concurrency.
    resp_budget: Arc<tokio::sync::Semaphore>,
    /// name -> (NodeId hex, expiry instant) resolution cache.
    resolve_cache: Mutex<HashMap<String, (String, Instant)>>,
    /// Snapshot of the on-chain revoked set, refreshed periodically.
    revoked: Mutex<RevokedSet>,
    /// Set true after the first successful revoked-set fetch. Until then, private endpoints fail
    /// closed (503) rather than running against a possibly-empty/stale revoked set (revocation must
    /// not fail open during the startup window).
    revoked_ready: AtomicBool,
}

impl Ingress {
    /// Aggregate an IP to its rate-limit key. IPv6 sources are masked to `ipv6_rate_prefix` bits so a
    /// single /64 allocation cannot mint unlimited per-IP identities. IPv4 is keyed exactly.
    fn rate_key(&self, ip: IpAddr) -> IpAddr {
        match ip {
            IpAddr::V4(_) => ip,
            IpAddr::V6(v6) => {
                let p = self.cfg.global.ipv6_rate_prefix.min(128) as u32;
                let bits = u128::from(v6);
                let masked = if p == 0 {
                    0
                } else if p >= 128 {
                    bits
                } else {
                    bits & !(u128::MAX >> p)
                };
                IpAddr::V6(std::net::Ipv6Addr::from(masked))
            }
        }
    }
}

/// One per-request decision for logging: the HTTP status to return + a short machine verdict + reason.
struct Verdict {
    status: StatusCode,
    verdict: &'static str,
    reason: String,
}

impl Verdict {
    fn deny(status: StatusCode, verdict: &'static str, reason: impl Into<String>) -> Self {
        Verdict { status, verdict, reason: reason.into() }
    }
}

/// Run the ingress HTTP server until killed. Binds `listen` (operator points nginx/Cloudflare at it).
pub async fn serve(
    client: &CeClient,
    listen: SocketAddr,
    cfg: IngressConfig,
    roots: Vec<[u8; 32]>,
    kill_switch_flag: bool,
    control_file: PathBuf,
) -> Result<()> {
    let max_body = cfg.global.max_body_bytes;

    // Pre-seed per-endpoint connection counters and byte caps for EVERY configured route so the
    // pre-bridge checks are authoritative from the first request (no lazy-init bypass window).
    let mut ep_conns = HashMap::new();
    let mut ep_bytes = HashMap::new();
    for (name, ep) in &cfg.endpoints {
        ep_conns.insert(name.clone(), AtomicU32::new(0));
        ep_bytes.insert(name.clone(), ByteCap::new(ep.byte_cap));
    }

    let budget = cfg.global.global_response_budget;
    // Semaphore permits == bytes; cap to the semaphore's max so even a huge config is representable.
    let budget_permits = (budget.min(tokio::sync::Semaphore::MAX_PERMITS as u64)) as usize;
    let max_conns = cfg.global.max_connections;
    let header_read_timeout = cfg.global.header_read_timeout_ms;
    let request_timeout_ms = cfg.global.request_timeout_ms;

    // Warn loudly if the operator left the default loopback-only trusted CIDR: behind nginx/Cloudflare
    // the socket peer is ALWAYS loopback, so the fronting proxy MUST overwrite X-Forwarded-For with
    // the real client IP (or set CF-Connecting-IP) — otherwise per-IP rate limiting can be evaded.
    if state_trusted_is_loopback_only(&cfg.global.trusted_proxy_cidr) {
        tracing::warn!(
            "trusted_proxy_cidr is loopback-only: the fronting proxy MUST set an authoritative \
             client IP (overwrite X-Forwarded-For, or set CF-Connecting-IP). Right-most untrusted \
             XFF entry is used; a misconfigured appending proxy can let clients spoof the rate-limit key."
        );
    }

    let state = Arc::new(Ingress {
        client: client.clone(),
        global_bucket: Mutex::new(TokenBucket::new(cfg.global.global_rps)),
        ip_buckets: Mutex::new(BoundedIpBuckets::new(cfg.global.max_ip_buckets)),
        ep_buckets: Mutex::new(HashMap::new()),
        ep_bytes: Mutex::new(ep_bytes),
        ep_conns,
        total_tunnels: AtomicU32::new(0),
        resp_budget: Arc::new(tokio::sync::Semaphore::new(budget_permits.max(1))),
        resolve_cache: Mutex::new(HashMap::new()),
        revoked: Mutex::new(RevokedSet::new()),
        revoked_ready: AtomicBool::new(false),
        kill: KillSwitch::new(kill_switch_flag, control_file),
        roots,
        cfg,
    });

    // Background: refresh the revoked set so a revoked private-endpoint cap is rejected promptly.
    // On error we KEEP the last-known set (never clear to empty) and never flip `revoked_ready` back
    // off, so revocation cannot silently fail open mid-run.
    {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                match state.client.revoked().await {
                    Ok(pairs) => {
                        let set: RevokedSet = pairs
                            .into_iter()
                            .filter_map(|(issuer, nonce)| {
                                hex::decode(&issuer)
                                    .ok()
                                    .and_then(|b| <[u8; 32]>::try_from(b).ok())
                                    .map(|i| (i, nonce))
                            })
                            .collect();
                        *state.revoked.lock().await = set;
                        state.revoked_ready.store(true, Ordering::SeqCst);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "revoked-set refresh failed; keeping last-known set");
                    }
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
    }

    let app = Router::new()
        .route("/*path", any(handle))
        .route("/", any(handle))
        // Bound the request body so a huge upload can never exhaust relay memory.
        .layer(axum::extract::DefaultBodyLimit::max(max_body as usize))
        .with_state(state.clone());
    // (The hard total-request timeout — covering header+body read + mesh bridge — is enforced inside
    // `handle` via `tokio::time::timeout`; the per-connection header-read timeout is enforced by the
    // hyper builder below. A tower TimeoutLayer cannot be a Router layer here because its error type
    // is not `Into<Infallible>`.)

    tracing::info!(
        %listen,
        routes = state.cfg.endpoints.len(),
        total_tunnel_ceiling = state.cfg.global.total_tunnel_ceiling,
        max_connections = max_conns,
        header_read_timeout_ms = header_read_timeout,
        "ce-expose ingress listening (relay-tier, default-deny, bind 127.0.0.1 behind a proxy)"
    );

    let listener = tokio::net::TcpListener::bind(listen).await?;
    serve_with_limits(listener, app, max_conns, header_read_timeout, request_timeout_ms).await
}

/// Is the trusted-proxy CIDR list loopback-only (the default)? Used only for a startup warning.
fn state_trusted_is_loopback_only(cidrs: &[String]) -> bool {
    !cidrs.is_empty()
        && cidrs.iter().all(|c| {
            let n = c.split('/').next().unwrap_or(c);
            n.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
        })
}

/// Manual hyper accept loop that enforces (1) a global concurrent-connection cap (slow connections
/// cannot exhaust the task/socket pool) and (2) a per-connection header-read timeout (the primary
/// slowloris defense — `axum::serve` / stock hyper enforce no header-read deadline). The total
/// per-request timeout is layered on the service above.
async fn serve_with_limits(
    listener: tokio::net::TcpListener,
    app: Router,
    max_connections: u32,
    header_read_timeout_ms: u64,
    request_timeout_ms: u64,
) -> Result<()> {
    use hyper_util::rt::{TokioExecutor, TokioIo};
    use hyper_util::server::conn::auto;
    use hyper_util::service::TowerToHyperService;

    use axum::extract::connect_info::IntoMakeServiceWithConnectInfo;

    type Make = IntoMakeServiceWithConnectInfo<Router, SocketAddr>;

    let conn_limit = Arc::new(tokio::sync::Semaphore::new(
        if max_connections == 0 { u32::MAX as usize } else { max_connections as usize },
    ));
    let mut make: Make = app.into_make_service_with_connect_info::<SocketAddr>();

    loop {
        let permit = match conn_limit.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                // At the connection cap: accept then immediately drop to shed load (prevents the
                // backlog from filling while still freeing the socket promptly).
                if let Ok((s, _)) = listener.accept().await {
                    drop(s);
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
                continue;
            }
        };
        let (stream, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                tracing::debug!(error = %e, "accept error");
                continue;
            }
        };
        // Resolve the per-connection tower service (stamps ConnectInfo<SocketAddr> = peer). Disambiguate
        // the `Connected<SocketAddr>` impl explicitly (a SocketAddr also impls `Connected<IncomingStream>`).
        if std::future::poll_fn(|cx| {
            <Make as tower::Service<SocketAddr>>::poll_ready(&mut make, cx)
        })
        .await
        .is_err()
        {
            continue;
        }
        let tower_svc = match <Make as tower::Service<SocketAddr>>::call(&mut make, peer).await {
            Ok(s) => s,
            Err(_) => continue,
        };
        let hyper_svc = TowerToHyperService::new(tower_svc);
        tokio::spawn(async move {
            let _permit = permit; // held for the connection's lifetime
            let mut builder = auto::Builder::new(TokioExecutor::new());
            if header_read_timeout_ms > 0 {
                builder
                    .http1()
                    .header_read_timeout(Duration::from_millis(header_read_timeout_ms));
            }
            let io = TokioIo::new(stream);
            // Bound the whole connection by a multiple of the request timeout so a kept-alive slow
            // client cannot hold the connection (and its permit) indefinitely.
            let conn_deadline = Duration::from_millis(request_timeout_ms.saturating_mul(4).max(1));
            let _ = tokio::time::timeout(
                conn_deadline,
                builder.serve_connection_with_upgrades(io, hyper_svc),
            )
            .await;
        });
    }
}

/// The single axum handler: applies every §4 control then bridges to the origin over the mesh.
async fn handle(
    State(state): State<Arc<Ingress>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request<Body>,
) -> Response {
    let started = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let headers = req.headers().clone();
    let host_raw = headers.get(axum::http::header::HOST).and_then(|v| v.to_str().ok());
    let host_for_log = host_raw.unwrap_or("").to_string();

    let cip = client_ip(
        peer.ip(),
        headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()),
        headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok()),
        &state.cfg.global.trusted_proxy_cidr,
    );

    let owner = route_owner(&state, host_raw).await.unwrap_or_default();

    // Run the gate chain under a HARD total-request deadline covering the entire handler (header+body
    // read + mesh bridge), so a slowloris body read or a stalled origin can never pin a request beyond
    // request_timeout_ms.
    let total = Duration::from_millis(state.cfg.global.request_timeout_ms.max(1));
    let gate_fut = async {
        match authorize_request(&state, host_raw, &headers, cip).await {
            Err(v) => (None, v.status, v.verdict, v.reason, 0u64, 0u64),
            Ok((route, guard)) => match bridge(&state, &route, guard, req).await {
                Ok((resp_bytes, up, down)) => {
                    let resp = upstream_to_response(&resp_bytes);
                    let st = resp.status();
                    (Some(resp), st, "served", String::new(), up, down)
                }
                Err((v, up, down)) => (None, v.status, v.verdict, v.reason, up, down),
            },
        }
    };
    let (response, status, verdict, reason, bytes_up, bytes_down) =
        match tokio::time::timeout(total, gate_fut).await {
            Ok(t) => t,
            Err(_) => (
                None,
                StatusCode::GATEWAY_TIMEOUT,
                "timeout",
                "request exceeded request_timeout_ms".to_string(),
                0u64,
                0u64,
            ),
        };

    // ---- structured abuse log: one JSON line per request, no secrets, no bodies ----
    tracing::info!(
        target: "ce_expose_ingress_abuse",
        ts = now_secs(),
        endpoint = %parse_host_name(host_raw).unwrap_or_default(),
        owner = %owner,
        client_ip = %cip,
        method = %method,
        host = %host_for_log,
        path_len = path.len(),
        bytes_up,
        bytes_down,
        status = status.as_u16(),
        verdict,
        reason = %reason,
        latency_ms = started.elapsed().as_millis() as u64,
        "ingress request"
    );

    if let Some(mut resp) = response {
        resp.headers_mut().insert("x-robots-tag", "noindex, nofollow".parse().unwrap());
        return resp;
    }
    let body = format!(
        "ce-expose ingress: {} ({verdict})\n",
        status.canonical_reason().unwrap_or("error")
    );
    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = status;
    resp.headers_mut().insert("x-robots-tag", "noindex, nofollow".parse().unwrap());
    resp
}

/// Parse the raw upstream HTTP/1.1 response bytes into an axum [`Response`]. Best-effort: if the
/// status line is unparseable, return the whole blob as a 200 body (the relay is a byte pipe, not an
/// HTTP validator). Hop-by-hop headers are stripped on the way back too.
fn upstream_to_response(raw: &[u8]) -> Response {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n");
    let (head, body) = match split {
        Some(i) => (&raw[..i], raw[i + 4..].to_vec()),
        None => {
            let mut r = Response::new(Body::from(raw.to_vec()));
            *r.status_mut() = StatusCode::OK;
            return r;
        }
    };
    let head_str = String::from_utf8_lossy(head);
    let mut lines = head_str.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .and_then(|c| StatusCode::from_u16(c).ok())
        .unwrap_or(StatusCode::OK);
    // Strip hop-by-hop + framing (axum re-frames the body, so a stale upstream content-length must not
    // pass), Set-Cookie (no cookie attribution under the shared domain), and stack-fingerprinting
    // headers a private origin should not advertise publicly.
    const STRIP: &[&str] = &[
        "connection", "keep-alive", "transfer-encoding", "upgrade", "trailer", "te",
        "proxy-authenticate", "set-cookie", "content-length", "server", "x-powered-by",
    ];
    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = status;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            if STRIP.contains(&k.to_ascii_lowercase().as_str()) {
                continue;
            }
            if let (Ok(name), Ok(val)) = (
                axum::http::HeaderName::try_from(k),
                axum::http::HeaderValue::try_from(v.trim()),
            ) {
                resp.headers_mut().append(name, val);
            }
        }
    }
    resp
}

/// Look up the route's owner for logging (best-effort, cheap).
async fn route_owner(state: &Ingress, host: Option<&str>) -> Option<String> {
    let name = parse_host_name(host)?;
    state.cfg.endpoints.get(&name).map(|e| e.owner.clone())
}

/// Run all the pre-bridge controls. Returns the matched [`EndpointPolicy`] **and a reserved
/// [`TunnelGuard`]** (the ceiling slot is taken atomically here, as the gate, so concurrent requests
/// cannot race past the ceiling) on allow, or a [`Verdict`] to return on deny.
async fn authorize_request(
    state: &Arc<Ingress>,
    host: Option<&str>,
    headers: &HeaderMap,
    cip: IpAddr,
) -> Result<(EndpointPolicy, TunnelGuard), Verdict> {
    let g: &GlobalLimits = &state.cfg.global;

    // 0. KILL SWITCH — first, cheapest, and total.
    if state.kill.is_killed() {
        return Err(Verdict::deny(StatusCode::SERVICE_UNAVAILABLE, "kill_switch", "ingress disabled"));
    }

    // 0.5. HEADER-BYTE CEILING — bound total header memory/CPU before any further work (slowloris /
    //      header-flood). hyper also caps headers, but this enforces the operator's configured value.
    if g.max_header_bytes > 0 {
        let total: usize =
            headers.iter().map(|(k, v)| k.as_str().len() + v.as_bytes().len() + 4).sum();
        if total > g.max_header_bytes {
            return Err(Verdict::deny(
                StatusCode::from_u16(431).unwrap_or(StatusCode::BAD_REQUEST),
                "headers_too_large",
                "request header bytes exceed max_header_bytes",
            ));
        }
    }

    // 1. Host -> name.
    let name = parse_host_name(host)
        .ok_or_else(|| Verdict::deny(StatusCode::BAD_REQUEST, "bad_host", "missing/malformed Host"))?;

    // 2. DEFAULT-DENY: unknown name -> 404 (no node is reachable unless explicitly registered).
    let route = state
        .cfg
        .endpoints
        .get(&name)
        .cloned()
        .ok_or_else(|| Verdict::deny(StatusCode::NOT_FOUND, "no_route", "no such endpoint"))?;

    // 3. Anti-phishing substring filter.
    if let Some(bad) = blocked_substring(&name, &g.blocked_substrings) {
        return Err(Verdict::deny(
            StatusCode::FORBIDDEN,
            "blocked_name",
            format!("name contains blocked substring '{bad}'"),
        ));
    }

    // 4. Rate limits: global -> per-IP (bounded map, IPv6-aggregated) -> per-endpoint.
    if !state.global_bucket.lock().await.try_take() {
        return Err(Verdict::deny(StatusCode::TOO_MANY_REQUESTS, "global_rate", "global rps exceeded"));
    }
    {
        let key = state.rate_key(cip);
        let mut m = state.ip_buckets.lock().await;
        match m.try_take(key, g.per_ip_rps, Instant::now()) {
            Some(true) => {}
            Some(false) => {
                return Err(Verdict::deny(StatusCode::TOO_MANY_REQUESTS, "ip_rate", "per-ip rps exceeded"));
            }
            // Map full and no idle bucket to evict -> fail closed (treat as limited).
            None => {
                return Err(Verdict::deny(StatusCode::TOO_MANY_REQUESTS, "ip_rate", "per-ip limiter saturated"));
            }
        }
    }
    {
        let mut m = state.ep_buckets.lock().await;
        let b = m.entry(name.clone()).or_insert_with(|| TokenBucket::new(route.rps));
        if !b.try_take() {
            return Err(Verdict::deny(StatusCode::TOO_MANY_REQUESTS, "ep_rate", "endpoint rps exceeded"));
        }
    }

    // 5. Per-endpoint cumulative byte cap (refuse before opening a new tunnel). The entry exists for
    //    every configured route (seeded at startup), so this pre-check is authoritative.
    {
        let m = state.ep_bytes.lock().await;
        if let Some(bc) = m.get(&name)
            && bc.over()
        {
            return Err(Verdict::deny(
                StatusCode::TOO_MANY_REQUESTS,
                "byte_cap",
                "endpoint cumulative byte cap reached",
            ));
        }
    }

    // 6 + 7. Reserve a tunnel slot ATOMICALLY (total ceiling + per-endpoint conn ceiling). This is
    //        the admission gate: a single compare-and-increment, never a check-then-act race. The
    //        returned guard releases both counters synchronously on drop.
    let guard = match TunnelGuard::try_acquire(state, &name, g.total_tunnel_ceiling, route.max_conns) {
        Ok(g) => g,
        Err(AcquireErr::TotalCeiling) => {
            return Err(Verdict::deny(StatusCode::SERVICE_UNAVAILABLE, "tunnel_ceiling", "total tunnel ceiling"));
        }
        Err(AcquireErr::ConnCeiling) => {
            return Err(Verdict::deny(StatusCode::SERVICE_UNAVAILABLE, "conn_ceiling", "endpoint conn ceiling"));
        }
    };

    // 8. PRIVATE endpoints: verify the caller's cap chain at the relay (defense in depth; the origin
    //    re-checks too). PUBLIC endpoints skip caller auth here. The slot is already reserved; dropping
    //    `guard` on a deny releases it.
    if let Visibility::Private { dial_cap_root } = &route.visibility {
        verify_private_caller(state, &route, dial_cap_root, headers).await?;
    }

    Ok((route, guard))
}

/// Verify a private endpoint's caller cap (`X-CE-Cap` header) against `dial_cap_root` via the same
/// [`gate`] the origin agent uses.
///
/// SECURITY NOTE (honest, see `docs/security-review.md`): `ce-cap` has no proof-of-possession, and the
/// caller's NodeId is read from the `X-CE-Node` header, which an internet client controls. This
/// relay-tier check therefore authenticates a *bearer credential*, not a key the requester provably
/// holds — a captured/leaked `expose:dial` chain can be replayed by setting `X-CE-Node` to its leaf
/// audience. It remains a useful early-reject + audit point, but it is NOT, on its own, a
/// confidentiality boundary. The origin still authorizes every mesh frame against the relay's
/// mesh-authenticated NodeId (the relay presents its OWN `relay_cap`, never the client's header), so
/// a private origin's localhost is reachable only if the origin granted the relay a cap. Until
/// per-request proof-of-possession (signed nonce / mTLS) is added, treat private endpoints as
/// "relay early-reject + origin-enforced", documented as a known limitation.
async fn verify_private_caller(
    state: &Ingress,
    route: &EndpointPolicy,
    dial_cap_root: &str,
    headers: &HeaderMap,
) -> Result<(), Verdict> {
    // Revocation must not fail open during the startup window: refuse private traffic until at least
    // one revoked-set fetch has succeeded, so an already-revoked cap is never honored on an empty set.
    if !state.revoked_ready.load(Ordering::SeqCst) {
        return Err(Verdict::deny(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_ready",
            "revocation set not yet loaded; private endpoints unavailable",
        ));
    }
    let caps_hex = headers
        .get("x-ce-cap")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Verdict::deny(StatusCode::UNAUTHORIZED, "no_cap", "private endpoint requires X-CE-Cap")
        })?;
    let caller_hex = headers
        .get("x-ce-node")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            Verdict::deny(StatusCode::UNAUTHORIZED, "no_caller", "private endpoint requires X-CE-Node")
        })?;
    let caller: [u8; 32] = hex::decode(caller_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| Verdict::deny(StatusCode::BAD_REQUEST, "bad_caller", "X-CE-Node not 64-hex"))?;
    let root: [u8; 32] = hex::decode(dial_cap_root)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| Verdict::deny(StatusCode::INTERNAL_SERVER_ERROR, "bad_root", "policy root malformed"))?;
    // Accept the configured dial_cap_root plus the operator's global roots.
    let mut roots = state.roots.clone();
    roots.push(root);
    let revoked = state.revoked.lock().await.clone();
    // The origin still authorizes against ITS own key; the relay authorizes against the policy root.
    let owner: [u8; 32] = hex::decode(&route.owner)
        .ok()
        .and_then(|b| b.try_into().ok())
        .unwrap_or([0u8; 32]);
    let decision = gate(&owner, &roots, now_secs(), &caller, caps_hex, &revoked);
    if !decision.is_allowed() {
        return Err(Verdict::deny(
            StatusCode::FORBIDDEN,
            "cap_denied",
            decision.reason().unwrap_or("denied").to_string(),
        ));
    }
    Ok(())
}

/// Why a tunnel-slot reservation failed.
enum AcquireErr {
    TotalCeiling,
    ConnCeiling,
}

/// A RAII guard that reserves the total + per-endpoint tunnel counters atomically on acquire and
/// releases them **synchronously** on drop (no detached task, so the conn ceiling can never lag or
/// leak a slot). Acquisition is the admission gate itself — a single compare-and-increment — so
/// concurrent requests cannot race past the ceiling between a check and the increment.
struct TunnelGuard {
    state: Arc<Ingress>,
    name: String,
}

impl TunnelGuard {
    /// Atomically reserve one global + one per-endpoint slot, or fail with the binding ceiling. On
    /// any failure nothing is left incremented.
    fn try_acquire(
        state: &Arc<Ingress>,
        name: &str,
        total_ceiling: u32,
        max_conns: u32,
    ) -> Result<Self, AcquireErr> {
        // 1. Reserve the global slot via compare-and-increment.
        if state
            .total_tunnels
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| {
                if v < total_ceiling { Some(v + 1) } else { None }
            })
            .is_err()
        {
            return Err(AcquireErr::TotalCeiling);
        }
        // 2. Reserve the per-endpoint slot the same way. The counter exists for every configured
        //    route (seeded at startup); an unknown name (shouldn't happen post-route-lookup) is
        //    treated as a conn-ceiling deny.
        let Some(counter) = state.ep_conns.get(name) else {
            state.total_tunnels.fetch_sub(1, Ordering::SeqCst);
            return Err(AcquireErr::ConnCeiling);
        };
        if counter
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| {
                if v < max_conns { Some(v + 1) } else { None }
            })
            .is_err()
        {
            state.total_tunnels.fetch_sub(1, Ordering::SeqCst);
            return Err(AcquireErr::ConnCeiling);
        }
        Ok(TunnelGuard { state: state.clone(), name: name.to_string() })
    }
}

impl Drop for TunnelGuard {
    fn drop(&mut self) {
        self.state.total_tunnels.fetch_sub(1, Ordering::SeqCst);
        if let Some(c) = self.state.ep_conns.get(&self.name) {
            c.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// Resolve `name` -> origin NodeId, **pinned to the operator-approved `owner`**.
///
/// The operator's config is the single source of truth for the upstream NodeId. We still call
/// `resolve_name` as a sanity check (and to confirm the name actually resolves), but the returned
/// NodeId MUST equal `owner` (case-insensitive hex) or we refuse: a chain `NameClaim` is first-come
/// and re-claimable, so without this pin a name hijack/squat (or DHT poisoning) would silently
/// redirect public traffic — fronted under the trusted `*.user.ce-net.com` TLS — to a node the
/// operator never approved or bonded. Cache entries are keyed by `(name, owner)` and validated against
/// `owner` on read, so a mid-TTL owner flip can never be served from cache.
async fn resolve_origin(state: &Ingress, name: &str, owner: &str) -> Result<String> {
    let ttl = Duration::from_secs(state.cfg.global.resolve_ttl_secs);
    let owner_norm = owner.trim().to_ascii_lowercase();
    {
        let cache = state.resolve_cache.lock().await;
        if let Some((node, exp)) = cache.get(name)
            && *exp > Instant::now()
            && node.eq_ignore_ascii_case(&owner_norm)
        {
            return Ok(node.clone());
        }
    }
    let resolved = state
        .client
        .resolve_name(name)
        .await?
        .ok_or_else(|| anyhow!("name '{name}' does not resolve to a NodeId"))?;
    if !resolved.eq_ignore_ascii_case(&owner_norm) {
        return Err(anyhow!(
            "owner_mismatch: name '{name}' resolves to a NodeId other than the operator-approved owner"
        ));
    }
    // Cache the (validated) owner NodeId.
    state
        .resolve_cache
        .lock()
        .await
        .insert(name.to_string(), (owner_norm.clone(), Instant::now() + ttl));
    Ok(owner_norm)
}

/// Bridge the HTTP request/response to the origin over the mesh, reusing the proto OpenReq/DataReq
/// half-close byte-pump (adapted from [`crate::agent::do_data`] / [`crate::consumer::bridge_one`]).
/// Returns `(response_bytes, bytes_up, bytes_down)` on success, or `(Verdict, up, down)` on failure.
async fn bridge(
    state: &Arc<Ingress>,
    route: &EndpointPolicy,
    guard: TunnelGuard,
    req: Request<Body>,
) -> Result<(Vec<u8>, u64, u64), (Verdict, u64, u64)> {
    let _guard = guard; // released on drop (slot already reserved in authorize_request)
    let name = route.name.clone();

    // Resolve name -> origin NodeId, PINNED to the operator-approved owner. A name-claim hijack or DHT
    // poisoning that returns a different NodeId is refused here (owner_mismatch -> 502), so the relay
    // never opens a public tunnel to a node the operator did not approve.
    let origin = match resolve_origin(state, &name, &route.owner).await {
        Ok(o) => o,
        Err(e) => {
            let msg = e.to_string();
            let verdict = if msg.starts_with("owner_mismatch") { "owner_mismatch" } else { "unresolvable" };
            return Err((Verdict::deny(StatusCode::BAD_GATEWAY, verdict, msg), 0, 0));
        }
    };

    // The relay presents its OWN operator-configured cap to the origin — NEVER the client's `X-CE-Cap`
    // header (which is attacker-controlled and would make the relay a confused deputy lending its mesh
    // identity to any chain a visitor supplies). The origin authorizes this cap against the relay's
    // mesh-authenticated NodeId. Empty relay_cap -> the origin denies unless it self-issued for the
    // relay; surfaced as origin_refused/502. The client's X-CE-Cap is stripped from the upstream
    // service request in serialize_http_request and is used ONLY for the relay-side early-reject gate.
    let relay_caps = route.relay_cap.clone();

    // Serialize the inbound HTTP request to raw bytes for the upstream socket (origin forwards to
    // localhost as an opaque byte stream — the origin's local service speaks HTTP).
    let canonical_host = format!("{name}.user.ce-net.com");
    let req_bytes = match serialize_http_request(req, state.cfg.global.max_body_bytes, &canonical_host).await {
        Ok(b) => b,
        Err(e) => return Err((Verdict::deny(StatusCode::BAD_REQUEST, "bad_request", e.to_string()), 0, 0)),
    };

    let session = format!("ingress-{:x}", now_millis());
    let idle = Duration::from_millis(route.idle_timeout_ms.max(1000));
    let total_deadline = Instant::now() + Duration::from_millis(state.cfg.global.request_timeout_ms);

    // Every mesh call is bounded by the SMALLER of the idle timeout and the remaining total budget, so
    // a stalled/unreachable origin can never pin a request (or its tunnel slot) past request_timeout_ms
    // — closing the fixed-30s-mesh-timeout amplification hole.
    let remaining = |deadline: Instant| deadline.saturating_duration_since(Instant::now());
    let call_budget = |idle: Duration, deadline: Instant| idle.min(remaining(deadline)).max(Duration::from_millis(1));

    // Check the deadline + kill switch BEFORE the OPEN so a doomed request fans out no mesh work.
    if state.kill.is_killed() {
        return Err((Verdict::deny(StatusCode::SERVICE_UNAVAILABLE, "kill_switch", "ingress disabled"), 0, 0));
    }
    if Instant::now() >= total_deadline {
        return Err((Verdict::deny(StatusCode::GATEWAY_TIMEOUT, "timeout", "request timeout"), 0, 0));
    }

    // 1. OPEN (bounded by the deadline).
    let open = OpenReq { caps: relay_caps.clone(), endpoint: name.clone(), session: session.clone() };
    let open_resp: OpenResp = match tokio::time::timeout(
        call_budget(idle, total_deadline),
        mesh_json(&state.client, &origin, TOPIC_OPEN, &open, call_budget(idle, total_deadline)),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err((Verdict::deny(StatusCode::BAD_GATEWAY, "mesh_open", e.to_string()), 0, 0)),
        Err(_) => return Err((Verdict::deny(StatusCode::GATEWAY_TIMEOUT, "timeout", "open timed out"), 0, 0)),
    };
    if !open_resp.accepted {
        let reason = scrub_origin_reason(&open_resp.reason.unwrap_or_else(|| "origin refused".into()));
        return Err((Verdict::deny(StatusCode::BAD_GATEWAY, "origin_refused", reason), 0, 0));
    }

    let mut bytes_up = 0u64;
    let mut bytes_down = 0u64;
    let mut resp_buf: Vec<u8> = Vec::new();
    let mut up_off = 0usize;
    let mut up_eof_sent = false;
    let mut down_eof = false;
    const CHUNK: usize = 64 * 1024;

    // Per-request response ceiling: the smaller of the endpoint's remaining byte_cap (if set) and a
    // hard 16 MiB safety bound. Memory is additionally bounded GLOBALLY by the resp_budget semaphore
    // (permits == bytes) so the SUM of all concurrent tunnels' buffers cannot OOM the relay.
    let per_req_max: usize = {
        let hard = 16 * 1024 * 1024usize;
        if route.byte_cap == 0 { hard } else { (route.byte_cap as usize).min(hard).max(64 * 1024) }
    };
    // RAII: release whatever response-budget permits we acquired (1 permit == 1 byte) on return.
    struct BudgetGuard {
        sem: Arc<tokio::sync::Semaphore>,
        held: u32,
    }
    impl Drop for BudgetGuard {
        fn drop(&mut self) {
            if self.held > 0 {
                self.sem.add_permits(self.held as usize);
            }
        }
    }
    let mut budget_guard = BudgetGuard { sem: state.resp_budget.clone(), held: 0 };

    let result: Result<(Vec<u8>, u64, u64), (Verdict, u64, u64)> = loop {
        if Instant::now() >= total_deadline {
            break Err((Verdict::deny(StatusCode::GATEWAY_TIMEOUT, "timeout", "request timeout"), bytes_up, bytes_down));
        }
        if state.kill.is_killed() {
            break Err((Verdict::deny(StatusCode::SERVICE_UNAVAILABLE, "kill_switch", "ingress disabled"), bytes_up, bytes_down));
        }
        // Next chunk of request bytes to push up.
        let end = (up_off + CHUNK).min(req_bytes.len());
        let up_hex = if up_off < end { hex::encode(&req_bytes[up_off..end]) } else { String::new() };
        let pushed = end - up_off;
        up_off = end;
        bytes_up += pushed as u64;

        let send_up_eof = up_off >= req_bytes.len() && !up_eof_sent;
        if send_up_eof {
            up_eof_sent = true;
        }

        let frame = DataReq { caps: relay_caps.clone(), session: session.clone(), up_hex, up_eof: send_up_eof };
        let budget = call_budget(idle, total_deadline);
        let resp: DataResp = match tokio::time::timeout(budget, mesh_json(&state.client, &origin, TOPIC_DATA, &frame, budget)).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                break Err((Verdict::deny(StatusCode::BAD_GATEWAY, "mesh_data", e.to_string()), bytes_up, bytes_down));
            }
            Err(_) => {
                break Err((Verdict::deny(StatusCode::GATEWAY_TIMEOUT, "idle_timeout", "tunnel idle timeout"), bytes_up, bytes_down));
            }
        };
        if !resp.ok {
            break Err((Verdict::deny(StatusCode::BAD_GATEWAY, "session_err", scrub_origin_reason(&resp.reason.unwrap_or_default())), bytes_up, bytes_down));
        }
        if !resp.down_hex.is_empty() {
            match hex::decode(&resp.down_hex) {
                Ok(b) => {
                    let dn = b.len();
                    bytes_down += dn as u64;
                    // Per-request buffer ceiling.
                    if resp_buf.len() + dn > per_req_max {
                        break Err((Verdict::deny(StatusCode::BAD_GATEWAY, "resp_too_big", "response exceeds per-request cap"), bytes_up, bytes_down));
                    }
                    // GLOBAL memory budget: acquire permits == new bytes before buffering them.
                    match state.resp_budget.clone().try_acquire_many_owned(dn as u32) {
                        Ok(p) => {
                            // We manage release via budget_guard; forget the owned permit and bump the count.
                            p.forget();
                            budget_guard.held = budget_guard.held.saturating_add(dn as u32);
                        }
                        Err(_) => {
                            break Err((Verdict::deny(StatusCode::SERVICE_UNAVAILABLE, "mem_budget", "global response memory budget exhausted"), bytes_up, bytes_down));
                        }
                    }
                    resp_buf.extend_from_slice(&b);
                }
                Err(e) => {
                    break Err((Verdict::deny(StatusCode::BAD_GATEWAY, "bad_down", e.to_string()), bytes_up, bytes_down));
                }
            }
        }
        if resp.down_eof {
            down_eof = true;
        }
        // Enforce the per-endpoint cumulative byte cap live (the entry exists for every route; count
        // up and down exactly once each, using the decoded length).
        {
            let mut m = state.ep_bytes.lock().await;
            let bc = m.entry(name.clone()).or_insert_with(|| ByteCap::new(route.byte_cap));
            let down_now = hex::decode(&resp.down_hex).map(|b| b.len() as u64).unwrap_or(0);
            bc.add(pushed as u64 + down_now);
            if bc.over() {
                break Err((Verdict::deny(StatusCode::TOO_MANY_REQUESTS, "byte_cap", "byte cap reached mid-stream"), bytes_up, bytes_down));
            }
        }
        if up_eof_sent && down_eof {
            break Ok((std::mem::take(&mut resp_buf), bytes_up, bytes_down));
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };

    // Always close the mesh session (bounded), regardless of outcome.
    let _ = tokio::time::timeout(
        Duration::from_millis(idle.as_millis().max(1) as u64),
        mesh_close(&state.client, &origin, &relay_caps, &session),
    )
    .await;

    // `budget_guard` is dropped at function return, releasing the response-memory permits we held.
    // (The returned `resp_buf` ownership transfers to the caller, which renders it into the HTTP body
    // and frees it promptly; the global budget is conservatively released here.)
    drop(budget_guard);
    result
}

/// Scrub origin-supplied reason strings before they enter the relay's local log: drop concrete
/// localhost addresses and raw OS error text (origin topology / internal detail), keep a coarse hint.
fn scrub_origin_reason(reason: &str) -> String {
    let lower = reason.to_ascii_lowercase();
    if lower.contains("127.0.0.1") || lower.contains("dial") {
        "origin local dial failed".to_string()
    } else if lower.contains("local write") || lower.contains("local read") {
        "origin local io failed".to_string()
    } else if reason.len() > 80 {
        format!("{}…", &reason[..80.min(reason.len())])
    } else {
        reason.to_string()
    }
}

/// Build the canonical origin-form request target (`/path?query`) from the inbound URI, rejecting
/// absolute-form targets (an absolute URI in the request line is an SSRF/smuggling vector — the origin
/// agent forwards opaquely to localhost, so only origin-form is valid). Returns `None` on reject.
fn request_target(parts: &axum::http::request::Parts) -> Option<String> {
    let pq = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    // Origin-form must start with '/'. An authority/absolute form (scheme://...) or asterisk-form is
    // refused. Also reject any CR/LF that could split the request line.
    if !pq.starts_with('/') || pq.contains(['\r', '\n']) || parts.uri.scheme().is_some() {
        return None;
    }
    Some(pq.to_string())
}

/// Serialize an inbound axum request to the raw HTTP/1.1 bytes the origin's local service expects.
///
/// Hardening against request smuggling / desync and header injection:
///   * the client's framing headers (`content-length`, `transfer-encoding`, `te`, `trailer`) are
///     stripped and exactly ONE relay-computed `Content-Length` is emitted (no CL.CL or CL.TE desync);
///   * the client's `Host` is replaced with a single canonical Host (no vhost confusion);
///   * the relay's ambient-authority headers (`x-ce-cap`/`x-ce-node`) are never forwarded;
///   * any header name/value containing CR/LF is dropped (no header injection into the wire bytes);
///   * absolute/authority-form request targets are rejected.
async fn serialize_http_request(
    req: Request<Body>,
    max_body: u64,
    canonical_host: &str,
) -> Result<Vec<u8>> {
    let (parts, body) = req.into_parts();
    let target = request_target(&parts).ok_or_else(|| anyhow!("invalid request target"))?;
    let mut out = Vec::with_capacity(512);
    // Method tokens are validated by hyper; guard the target (already CRLF-checked above).
    out.extend_from_slice(format!("{} {} HTTP/1.1\r\n", parts.method, target).as_bytes());
    // Always set exactly one canonical Host.
    out.extend_from_slice(format!("Host: {canonical_host}\r\n").as_bytes());
    // Headers we never copy from the client: hop-by-hop, framing (we recompute), Host (set above), and
    // the relay's ambient-authority headers.
    const STRIP: &[&str] = &[
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
        "transfer-encoding", "upgrade", "x-ce-cap", "x-ce-node", "content-length", "host",
    ];
    for (k, v) in parts.headers.iter() {
        let kl = k.as_str().to_ascii_lowercase();
        if STRIP.contains(&kl.as_str()) {
            continue;
        }
        // Reject any header whose name or value carries CR/LF (header/response splitting). `to_str`
        // already rejects non-visible bytes, but we additionally refuse CR/LF defensively.
        let Ok(vs) = v.to_str() else { continue };
        if k.as_str().contains(['\r', '\n']) || vs.contains(['\r', '\n']) {
            continue;
        }
        out.extend_from_slice(format!("{}: {}\r\n", k, vs).as_bytes());
    }
    let bytes = axum::body::to_bytes(body, max_body as usize)
        .await
        .map_err(|e| anyhow!("reading request body: {e}"))?;
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes());
    out.extend_from_slice(&bytes);
    Ok(out)
}

/// Send a JSON request over the mesh and decode the JSON reply. The mesh-level timeout is DERIVED from
/// the caller's budget (never a fixed 30s), so a stalled origin cannot pin a request past the total
/// request deadline.
async fn mesh_json<Req: serde::Serialize, Resp: for<'de> serde::Deserialize<'de>>(
    client: &CeClient,
    origin: &str,
    topic: &str,
    req: &Req,
    budget: Duration,
) -> Result<Resp> {
    let body = serde_json::to_vec(req)?;
    let reply = client.request(origin, topic, &body, budget.as_millis().max(1) as u64).await?;
    serde_json::from_slice(&reply).map_err(|e| anyhow!("bad reply on {topic}: {e}"))
}

async fn mesh_close(client: &CeClient, origin: &str, caps: &str, session: &str) -> Result<()> {
    let req = CloseReq { caps: caps.into(), session: session.into() };
    let _: CloseResp = mesh_json(client, origin, TOPIC_CLOSE, &req, Duration::from_secs(5))
        .await
        .unwrap_or_default();
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
fn now_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_parsing_extracts_first_label() {
        assert_eq!(parse_host_name(Some("leif.user.ce-net.com")), Some("leif".into()));
        assert_eq!(parse_host_name(Some("LEIF.user.ce-net.com")), Some("leif".into()));
        assert_eq!(parse_host_name(Some("leif.user.ce-net.com:443")), Some("leif".into()));
        assert_eq!(parse_host_name(Some("a.b")), Some("a".into()));
    }

    #[test]
    fn host_parsing_rejects_malformed_and_spoofed() {
        assert_eq!(parse_host_name(None), None);
        assert_eq!(parse_host_name(Some("")), None);
        assert_eq!(parse_host_name(Some("   ")), None);
        assert_eq!(parse_host_name(Some("apex")), None); // single label, no dot
        assert_eq!(parse_host_name(Some(".leading")), None);
        assert_eq!(parse_host_name(Some("trailing.")), None);
        assert_eq!(parse_host_name(Some("127.0.0.1")), None); // IPv4 literal
        assert_eq!(parse_host_name(Some("127.0.0.1:80")), None);
        assert_eq!(parse_host_name(Some("[::1]")), None); // IPv6 literal
        assert_eq!(parse_host_name(Some(":443")), None);
    }

    #[test]
    fn blocked_substrings_match_case_insensitively() {
        let blocked: Vec<String> = ["login", "pay", "ce-net"].into_iter().map(String::from).collect();
        assert_eq!(blocked_substring("paypal", &blocked), Some("pay"));
        assert_eq!(blocked_substring("MyLogIn", &blocked), Some("login"));
        assert_eq!(blocked_substring("ce-net-clone", &blocked), Some("ce-net"));
        assert_eq!(blocked_substring("leif", &blocked), None);
    }

    #[test]
    fn token_bucket_limits_then_refills() {
        let t0 = Instant::now();
        let mut b = TokenBucket::new(2); // capacity 2, 2/sec
        assert!(b.try_take_at(t0));
        assert!(b.try_take_at(t0));
        assert!(!b.try_take_at(t0), "third immediate take must fail (bucket empty)");
        // After 1s, ~2 tokens refilled.
        let t1 = t0 + Duration::from_secs(1);
        assert!(b.try_take_at(t1));
        assert!(b.try_take_at(t1));
        assert!(!b.try_take_at(t1));
    }

    #[test]
    fn token_bucket_partial_refill() {
        let t0 = Instant::now();
        let mut b = TokenBucket::new(10); // 10/sec
        for _ in 0..10 {
            assert!(b.try_take_at(t0));
        }
        assert!(!b.try_take_at(t0));
        // 0.5s -> ~5 tokens.
        let t1 = t0 + Duration::from_millis(500);
        let mut ok = 0;
        for _ in 0..10 {
            if b.try_take_at(t1) {
                ok += 1;
            }
        }
        assert!((4..=6).contains(&ok), "expected ~5 refilled, got {ok}");
    }

    #[test]
    fn byte_cap_enforced() {
        let mut bc = ByteCap::new(100);
        assert!(!bc.over());
        bc.add(60);
        assert!(!bc.over());
        bc.add(60);
        assert!(bc.over(), "120 > 100 must be over cap");
        assert_eq!(bc.used(), 120);
    }

    #[test]
    fn byte_cap_zero_is_unlimited() {
        let mut bc = ByteCap::new(0);
        bc.add(u64::MAX / 2);
        bc.add(u64::MAX / 2);
        assert!(!bc.over(), "cap=0 must be unlimited");
    }

    #[test]
    fn kill_switch_flag_and_file() {
        let dir = std::env::temp_dir().join(format!("ce-expose-kill-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("ingress.kill");
        let _ = std::fs::remove_file(&file);
        let ks = KillSwitch::new(false, file.clone());
        assert!(!ks.is_killed());
        ks.set_flag(true);
        assert!(ks.is_killed(), "flag must kill");
        ks.set_flag(false);
        assert!(!ks.is_killed());
        std::fs::write(&file, b"").unwrap();
        assert!(ks.is_killed(), "control file presence must kill without restart");
        std::fs::remove_file(&file).unwrap();
        assert!(!ks.is_killed());
    }

    #[test]
    fn cidr_membership() {
        let v4: IpAddr = "10.0.0.5".parse().unwrap();
        assert!(cidr_contains("10.0.0.0/8", v4));
        assert!(cidr_contains("10.0.0.5/32", v4));
        assert!(!cidr_contains("192.168.0.0/16", v4));
        assert!(cidr_contains("0.0.0.0/0", v4));
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        assert!(cidr_contains("127.0.0.1/32", lo));
        assert!(cidr_contains("127.0.0.1", lo)); // bare IP exact
        let v6: IpAddr = "::1".parse().unwrap();
        assert!(cidr_contains("::1/128", v6));
        assert!(!cidr_contains("10.0.0.0/8", v6)); // mixed family
        assert!(!cidr_contains("garbage/xx", v4)); // malformed fails closed
    }

    #[test]
    fn client_ip_trusts_xff_only_from_proxy() {
        let trusted = vec!["127.0.0.1/32".to_string()];
        let proxy: IpAddr = "127.0.0.1".parse().unwrap();
        let real: IpAddr = "203.0.113.9".parse().unwrap();
        // From the trusted proxy, the RIGHT-MOST untrusted entry is the real client (robust to an
        // attacker prepending forged entries on the left).
        assert_eq!(client_ip(proxy, Some("9.9.9.9, 203.0.113.9"), None, &trusted), real);
        // Attacker-prepended forged left entries are ignored; right-most untrusted wins.
        assert_eq!(client_ip(proxy, Some("1.2.3.4, 5.6.7.8, 203.0.113.9"), None, &trusted), real);
        // Trusted proxy hops on the right are peeled off.
        assert_eq!(client_ip(proxy, Some("203.0.113.9, 127.0.0.1"), None, &trusted), real);
        // From an untrusted peer: ignore all headers, use the socket peer.
        let attacker: IpAddr = "198.51.100.7".parse().unwrap();
        assert_eq!(client_ip(attacker, Some("203.0.113.9"), Some("8.8.8.8"), &trusted), attacker);
        // CF-Connecting-IP (single value) is preferred when present and the peer is trusted.
        assert_eq!(client_ip(proxy, Some("1.2.3.4"), Some("203.0.113.9"), &trusted), real);
        // No headers: use the peer.
        assert_eq!(client_ip(proxy, None, None, &trusted), proxy);
    }

    #[test]
    fn host_parsing_rejects_idn_and_punycode() {
        // Punycode label must not pass (would bypass the lexical substring filter).
        assert_eq!(parse_host_name(Some("xn--pypal-4ve.user.ce-net.com")), None);
        // Non-ASCII (Unicode confusable) label rejected.
        assert_eq!(parse_host_name(Some("p\u{0430}ypal.user.ce-net.com")), None);
        // Underscore / other non-LDH bytes rejected.
        assert_eq!(parse_host_name(Some("under_score.user.ce-net.com")), None);
        // A clean ASCII-LDH label still works.
        assert_eq!(parse_host_name(Some("leif.user.ce-net.com")), Some("leif".into()));
    }

    #[tokio::test]
    async fn serialize_strips_client_framing_and_host() {
        use axum::http::Request;
        let req = Request::builder()
            .method("POST")
            .uri("/p?q=1")
            .header("host", "evil.example.com")
            .header("content-length", "0") // attacker framing — must be dropped
            .header("x-ce-cap", "deadbeef") // ambient authority — must be dropped
            .body(Body::from("hello"))
            .unwrap();
        let bytes = serialize_http_request(req, 1024, "leif.user.ce-net.com").await.unwrap();
        let s = String::from_utf8_lossy(&bytes);
        // Exactly one Content-Length, equal to the body length.
        assert_eq!(s.matches("content-length").count() + s.matches("Content-Length").count(), 1);
        assert!(s.contains("Content-Length: 5\r\n"), "relay-computed CL only: {s:?}");
        // Canonical host, not the client's.
        assert!(s.contains("Host: leif.user.ce-net.com\r\n"));
        assert!(!s.to_ascii_lowercase().contains("evil.example.com"));
        // Ambient-authority header never forwarded.
        assert!(!s.to_ascii_lowercase().contains("x-ce-cap"));
        assert!(s.ends_with("hello"));
    }

    #[test]
    fn request_target_rejects_absolute_form() {
        use axum::http::Request;
        let abs = Request::builder()
            .method("GET")
            .uri("http://internal.host/secret")
            .body(Body::empty())
            .unwrap();
        let (parts, _) = abs.into_parts();
        assert!(request_target(&parts).is_none(), "absolute-form target must be rejected");
    }

    #[test]
    fn bounded_ip_buckets_evicts_and_fails_closed_when_full() {
        let t0 = Instant::now();
        let mut m = BoundedIpBuckets::new(2);
        let a: IpAddr = "1.1.1.1".parse().unwrap();
        let b: IpAddr = "2.2.2.2".parse().unwrap();
        let c: IpAddr = "3.3.3.3".parse().unwrap();
        // Fill two slots, draining both buckets to empty (rps=1 => 1 token).
        assert_eq!(m.try_take(a, 1, t0), Some(true));
        assert_eq!(m.try_take(a, 1, t0), Some(false)); // a now empty (not idle/full)
        assert_eq!(m.try_take(b, 1, t0), Some(true));
        assert_eq!(m.try_take(b, 1, t0), Some(false)); // b now empty
        // Map full, neither existing bucket is idle/full -> a new IP fails closed.
        assert_eq!(m.try_take(c, 1, t0), None);
        // After refill, a is idle/full and can be evicted to admit c.
        let t1 = t0 + Duration::from_secs(2);
        assert_eq!(m.try_take(c, 1, t1), Some(true));
    }
}
