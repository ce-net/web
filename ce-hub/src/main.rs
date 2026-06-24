//! ce-hub — rendezvous for in-browser CE compute nodes.
//!
//! Browser nodes open a WebSocket to `/node`, announce their device capacity, and run WASM jobs
//! pushed to them. Anyone can `POST /tasks` to dispatch a job to a live node and get the result.
//! `/stats/stream` (SSE) feeds the live dashboard: mesh size + aggregate CPU/RAM/storage/GPU.
//!
//! This is the relay's browser-facing surface. It speaks a small JSON protocol over WS today; the
//! same wire model is what a libp2p-WSS transport would carry once browser nodes become first-class
//! mesh peers. Runs beside the `ce` node (separate port), never touching it.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rand::RngCore;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, mpsc, oneshot};

#[derive(Clone, Default, Serialize, Deserialize)]
struct Caps {
    #[serde(default)]
    cores: u32,
    #[serde(default)]
    ram_gb: f64,
    #[serde(default)]
    storage_gb: f64,
    #[serde(default)]
    gpu: String,
    #[serde(default)]
    webgpu: bool,
    #[serde(default)]
    platform: String,
    /// Approximate GPU memory in MB (from the WebGPU adapter, or a native node's measured VRAM).
    #[serde(default)]
    vram_mb: u64,
    /// Measured CPU throughput score (~Mops/s) from a quick on-node benchmark.
    #[serde(default)]
    cpu_mark: f64,
}

struct NodeEntry {
    caps: Caps,
    last_seen: Instant,
    tasks_run: u64,
    tx: mpsc::UnboundedSender<String>,
    /// Wall-clock start of the current online session (for accumulating uptime).
    session_start: SystemTime,
    /// True while a session is open (so disconnect/prune accounts elapsed exactly once).
    session_open: bool,
    /// EWMA round-trip latency to this node in ms (relay<->node), 0.0 until first pong.
    rtt_ms: f64,
}

/// Persistent per-node reliability record (survives hub restart), keyed by node id.
#[derive(Clone, Default, Serialize, Deserialize)]
struct NodeRecord {
    #[serde(default)]
    first_seen_unix: u64,
    #[serde(default)]
    last_seen_unix: u64,
    #[serde(default)]
    total_online_secs: u64,
    #[serde(default)]
    sessions: u64,
    #[serde(default)]
    disconnects: u64,
}

#[derive(Serialize)]
struct JobResult {
    ok: bool,
    #[serde(default)]
    value: String,
    ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// A content-addressed object held by the hub's small storage demo store.
struct Blob {
    ct: String,
    bytes: Vec<u8>,
}

/// One stored file of a hosted app: its raw bytes + the content-type sent at PUT time.
#[derive(Clone)]
struct AppFile {
    bytes: Vec<u8>,
    ct: String,
}

/// A hosted multi-file app: path -> file, a version counter, and a reload broadcaster.
struct HostedApp {
    files: HashMap<String, AppFile>,
    version: u64,
    bytes: u64,
    reload: broadcast::Sender<u64>,
    /// When true (default) unmatched route-like GETs fall back to index.html (SPA client routing).
    spa: bool,
    /// Node ids currently holding a replica of this app (best-effort redundancy; in-memory only).
    replicas: std::collections::HashSet<String>,
    /// Owner id (sha256(pubkey)[..16] hex) recorded on the first SIGNED write. Empty = anonymous
    /// (stays open to anyone, today's behavior). Once set, signed writes from a different owner 403.
    owner: String,
}

/// One namespaced KV entry in the CE database (value + insertion order for newest-first lists).
#[derive(Clone)]
struct DbEntry {
    value: Value,
    seq: u64,
}

/// A realtime room: a broadcast channel plus a ring buffer of recent messages for late joiners.
/// `ephemeral` rooms skip history replay entirely (for high-rate authoritative state frames).
struct Room {
    tx: broadcast::Sender<RoomMsg>,
    history: VecDeque<RoomMsg>,
    ephemeral: bool,
}

/// A claimed slug: a short human name mapping to an owner + app id, persisted to slugs.json.
/// `expires_unix` is a soft TTL; renewing extends it. `created_unix` anchors the grace window.
#[derive(Clone, Serialize, Deserialize)]
struct SlugEntry {
    #[serde(default)]
    owner: String,
    #[serde(default)]
    app_id: String,
    #[serde(default)]
    created_unix: u64,
    #[serde(default)]
    expires_unix: u64,
}

/// A published project in the registry (projects.json). `screenshots` are blob hashes pinned
/// against FIFO eviction. `public` gates visibility in GET /registry.
#[derive(Clone, Serialize, Deserialize)]
struct ProjectEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    app_id: String,
    #[serde(default)]
    desc: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    screenshots: Vec<String>,
    #[serde(default)]
    site: String,
    #[serde(default = "default_true")]
    public: bool,
    #[serde(default)]
    created_unix: u64,
    #[serde(default)]
    updated_unix: u64,
    #[serde(default)]
    reports: Vec<String>,
}

fn default_true() -> bool {
    true
}

/// A bounded per-app debug ring: request/error counters + the last error string, surfaced at
/// GET /apps/:id/debug. Cheap to update (counters + a small Option) in the hot handlers.
#[derive(Default)]
struct AppDebug {
    requests: u64,
    errors: u64,
    last_error: Option<String>,
}

/// Identity of a verified signed write: the caller's public key + the derived owner id.
struct Signer {
    owner: String,
}

struct AppState {
    nodes: Mutex<HashMap<String, NodeEntry>>,
    pending: Mutex<HashMap<String, oneshot::Sender<JobResult>>>,
    modules: HashMap<String, String>, // builtin name -> base64 wasm
    total_tasks: AtomicU64,
    job_seq: AtomicU64,
    // content-addressed blob store (storage demo): key (sha256 hex) -> bytes, FIFO-evicted.
    blobs: Mutex<HashMap<String, Blob>>,
    blob_order: Mutex<VecDeque<String>>,
    blob_bytes: AtomicU64,
    // on-disk persistence root (CE_HUB_DATA, default ./data).
    data_dir: PathBuf,
    // hosted apps: app id -> files+version, served at /apps/<id>/...
    apps: Mutex<HashMap<String, HostedApp>>,
    // CE database: app namespace -> (key -> entry), persisted per app.
    db: Mutex<HashMap<String, HashMap<String, DbEntry>>>,
    db_seq: AtomicU64,
    // realtime rooms: (app,room) -> broadcast channel + history ring.
    rooms: Mutex<HashMap<(String, String), Room>>,
    // persistent per-node reliability records (uptime/reliability), persisted to nodes.json.
    records: Mutex<HashMap<String, NodeRecord>>,
    // custom-domain registry: lowercased hostname -> app id, persisted to domains.json.
    domains: Mutex<HashMap<String, String>>,
    // operator-set storage limits (global byte budget + count caps) read from env at startup.
    limits: Limits,
    // --- WAVE 2 / WAVE 4 additions ---
    // short-TTL single-use nonce store for signed-write replay protection: nonce -> expiry unix.
    nonces: Mutex<HashMap<String, u64>>,
    // slug registry: slug -> owner+app, persisted to slugs.json.
    slugs: Mutex<HashMap<String, SlugEntry>>,
    // projects registry: project id -> entry, persisted to projects.json.
    projects: Mutex<HashMap<String, ProjectEntry>>,
    // blob hashes pinned (excluded from FIFO eviction) because a project references them.
    pinned_blobs: Mutex<std::collections::HashSet<String>>,
    // per-app debug ring (request/error counters + last error), in-memory only.
    debug: Mutex<HashMap<String, AppDebug>>,
    // per-(namespace,ip) rate limiter token buckets for abuse control on hot write paths.
    rate: Mutex<HashMap<(String, String), RateBucket>>,
    // per-owner slug-claim rate buckets (slug churn control), keyed by owner id.
    slug_rate: Mutex<HashMap<String, RateBucket>>,
    // identity-scoped per-owner storage budgets (generous), derived from /nodes trust.
    owner_limits: OwnerLimits,
    // admin override token (CE_HUB_ADMIN_TOKEN) for project takedown; empty = disabled.
    admin_token: String,
    // realtime room sizing (env CE_HUB_ROOM_CAP / CE_HUB_ROOM_HISTORY).
    room_cap: usize,
    room_history: usize,
    // rate-limited db namespaces (env CE_HUB_RATELIMIT_NS, comma-separated, e.g. "feedback").
    ratelimit_ns: std::collections::HashSet<String>,
    // --- WAVE: durable counters + abuse detector ---
    // durable lifetime counters (tasks_run + compute_distributed_ms), persisted to counters.json.
    counters: Mutex<Counters>,
    // abuse detector state (token buckets, repeat-signature LRU, in-flight gauges, submitter axis).
    detect: Mutex<DetectState>,
    // ring of recent FlagEvents (cap FLAG_RING_CAP), surfaced in /hub/stats as flagged_count etc.
    flags: Mutex<VecDeque<FlagEvent>>,
    // last-emit instant per (ip, heuristic) for dedup throttling of repeated flags.
    flag_throttle: Mutex<HashMap<(String, String), Instant>>,
    // total flags ever raised (durable-ish lifetime counter; resets on restart, that is fine).
    flagged_total: AtomicU64,
    // ce-watch push target + ingest token (env CE_WATCH_URL / CE_WATCH_INGEST_TOKEN).
    watch_url: String,
    watch_token: String,
}
type Shared = Arc<AppState>;

/// Durable lifetime counters persisted to <data>/counters.json. `tasks_run` counts every completed
/// job result; `compute_distributed_ms` accumulates each job's self-reported wall-clock ms (the
/// value that used to be discarded on the "result" path). Both survive a hub restart.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Counters {
    #[serde(default)]
    tasks_run: u64,
    #[serde(default)]
    compute_distributed_ms: u64,
}

/// A simple token bucket for per-namespace/IP and per-owner rate limiting.
struct RateBucket {
    tokens: f64,
    last: Instant,
}

// ---- abuse-detector contract thresholds (STRICTER, tunable consts) ----

/// H1 — per-IP submit token bucket: capacity (burst) and refill rate (tokens/sec).
const H1_BUCKET_CAP: f64 = 10.0;
const H1_REFILL_PER_S: f64 = 0.2;
/// H2 — >N identical (func, sha256(args|code)) submissions from one IP within the window.
const H2_IDENTICAL_MAX: u64 = 15;
/// H3 — rolling median run-ms over an IP's recent jobs above this AND >N runs in the window.
const H3_MEDIAN_MS: f64 = 8000.0;
const H3_MIN_RUNS: usize = 5;
/// H4 — same raw module sha256 submitted >N times within the window (mining-module fan-out).
const H4_MODULE_MAX: u64 = 8;
/// H5 — one IP touching >N distinct nodes AND submitting >M tasks within the window.
const H5_DISTINCT_NODES: usize = 3;
const H5_TASK_COUNT: usize = 25;
/// H6 — a node whose pending (in-flight) jobs exceed its core count for longer than this.
const H6_PENDING_SECS: u64 = 60;
/// Detector sliding window for the per-IP signature/run/module/node tallies.
const DETECT_WINDOW: Duration = Duration::from_secs(300);
/// Per-IP run-ms samples kept for the H3 rolling median (bounded).
const DETECT_MS_SAMPLES: usize = 64;
/// Cap on the recent-FlagEvent ring exposed at /hub/stats.
const FLAG_RING_CAP: usize = 200;
/// Per-(ip,heuristic) flag dedup throttle: do not re-emit the same flag more often than this.
const FLAG_THROTTLE: Duration = Duration::from_secs(60);
/// Cap on distinct submitter IPs tracked by the detector (bounded LRU on insert).
const DETECT_IP_CAP: usize = 4096;

/// A machine-readable abuse signal raised by a detector heuristic. Pushed to the in-memory ring,
/// logged, and best-effort forwarded to ce-watch /ingest. Shape is fixed by the shared contract.
#[derive(Clone, Serialize)]
struct FlagEvent {
    ts: u64,
    node_id: String,
    ip: String,
    heuristic: String,
    reason: String,
    severity: String,
    sample: Value,
}

/// One submitter IP's recent activity used by the detector heuristics. All tallies are pruned to
/// DETECT_WINDOW on touch, so memory stays bounded by recent (not lifetime) traffic.
#[derive(Default)]
struct IpStat {
    /// H1 submit token bucket.
    bucket: Option<RateBucket>,
    /// (func, sha256(args|code)) -> timestamps within the window (H2).
    sigs: HashMap<String, VecDeque<Instant>>,
    /// raw module sha256 -> timestamps within the window (H4).
    modules: HashMap<String, VecDeque<Instant>>,
    /// distinct target node ids touched -> last-seen instant (H5).
    nodes: HashMap<String, Instant>,
    /// timestamps of all submissions in the window (H5 task count).
    submits: VecDeque<Instant>,
    /// recent run-ms samples for the H3 rolling median.
    ms_samples: VecDeque<f64>,
}

/// Per-node in-flight gauge for H6: when pending first exceeded cores, and the node's core count.
#[derive(Default, Clone)]
struct NodeGauge {
    pending: u64,
    cores: u32,
    /// instant at which pending first exceeded cores (None while within capacity).
    over_since: Option<Instant>,
}

/// Detector state: per-IP activity + per-node in-flight gauges.
#[derive(Default)]
struct DetectState {
    ips: HashMap<String, IpStat>,
    gauges: HashMap<String, NodeGauge>,
}

/// Drop timestamps older than DETECT_WINDOW from the front of a deque.
fn prune_window(q: &mut VecDeque<Instant>, now: Instant) {
    while let Some(front) = q.front() {
        if now.duration_since(*front) > DETECT_WINDOW {
            q.pop_front();
        } else {
            break;
        }
    }
}

const STALE: Duration = Duration::from_secs(35);
const MAX_BLOB: usize = 16 * 1024 * 1024; // 16 MB per object
const MAX_BLOB_TOTAL: u64 = 256 * 1024 * 1024; // 256 MB store cap (FIFO eviction)
const MAX_APP_FILE: usize = 16 * 1024 * 1024; // 16 MB per app file
const MAX_APP_FILES: usize = 200; // ~200 files per app
const MAX_APP_BYTES: u64 = 64 * 1024 * 1024; // 64 MB total per app
const MAX_DB_KEYS: usize = 5000; // per-app key cap (evict oldest on overflow)
const DEBUG_ERR_MAX: usize = 512; // cap on a stored last-error string length
const ROOM_HISTORY_DEFAULT: usize = 50; // default buffered messages replayed (CE_HUB_ROOM_HISTORY)
const ROOM_CAP_DEFAULT: usize = 256; // default broadcast channel capacity (CE_HUB_ROOM_CAP)

/// Signed-write timestamp tolerance: a request whose x-ce-ts is more than this many seconds from
/// the hub's clock is rejected (with single-use nonces this bounds the replay window).
const SIG_TTL_SECS: u64 = 300;

/// Reserved app/slug names that may never be claimed as slugs (they are hub-owned namespaces).
const RESERVED_NAMES: &[&str] = &[
    "registry", "apps", "db", "rt", "blobs", "domains", "slugs", "projects", "stats", "nodes",
    "tasks", "node", "health", "_host", "admin", "api", "www",
];

/// Operator-set storage limits. These stop an anonymous caller from filling the host's disk:
/// the per-item caps above bound a single object, while these bound the TOTAL and the COUNTS.
/// Defaults are deliberately conservative (a low bound) — raise them per host via env vars.
#[derive(Clone, Serialize)]
struct Limits {
    /// global on-disk budget shared by hosted apps + the KV database + blobs (CE_HUB_MAX_DATA_BYTES).
    max_data_bytes: u64,
    /// max number of distinct hosted apps (CE_HUB_MAX_APPS).
    max_apps: usize,
    /// max number of registered custom domains (CE_HUB_MAX_DOMAINS).
    max_domains: usize,
    /// max number of distinct database namespaces (CE_HUB_MAX_DB_NAMESPACES).
    max_db_namespaces: usize,
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}
fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

impl Limits {
    fn from_env() -> Self {
        Limits {
            // 512 MiB: enough for many small apps, far below filling a disk. Raise per host.
            max_data_bytes: env_u64("CE_HUB_MAX_DATA_BYTES", 512 * 1024 * 1024),
            max_apps: env_usize("CE_HUB_MAX_APPS", 200),
            max_domains: env_usize("CE_HUB_MAX_DOMAINS", 100),
            max_db_namespaces: env_usize("CE_HUB_MAX_DB_NAMESPACES", 500),
        }
    }
}

/// Identity-scoped budgets: a write SIGNED by an owner gets a much larger per-app byte budget than
/// the anonymous floor, scaled by that node's measured uptime trust. Anonymous callers keep the
/// strict per-item caps (MAX_APP_BYTES etc.). Surfaced in /stats.limits as `owner_*`.
#[derive(Clone, Serialize)]
struct OwnerLimits {
    /// base per-owner-app byte budget (CE_HUB_OWNER_APP_BYTES, default 256 MiB).
    owner_app_bytes: u64,
    /// max trust multiplier applied to the base budget at 100% uptime (CE_HUB_OWNER_TRUST_MAX).
    owner_trust_max: f64,
    /// per-owner slug cap (CE_HUB_OWNER_SLUG_CAP, default 25).
    owner_slug_cap: usize,
}

impl OwnerLimits {
    fn from_env() -> Self {
        OwnerLimits {
            owner_app_bytes: env_u64("CE_HUB_OWNER_APP_BYTES", 256 * 1024 * 1024),
            owner_trust_max: std::env::var("CE_HUB_OWNER_TRUST_MAX")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(4.0),
            owner_slug_cap: env_usize("CE_HUB_OWNER_SLUG_CAP", 25),
        }
    }
    /// Effective per-app byte budget for `owner`, scaled by trust (uptime). `trust` in 0.0..1.0.
    fn app_budget(&self, trust: f64) -> u64 {
        let t = trust.clamp(0.0, 1.0);
        let mult = 1.0 + t * (self.owner_trust_max - 1.0).max(0.0);
        ((self.owner_app_bytes as f64) * mult) as u64
    }
}

fn env_string(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

/// Total bytes currently held by hosted apps (sum of each app's tracked size).
fn app_bytes_total(apps: &HashMap<String, HostedApp>) -> u64 {
    apps.values().map(|a| a.bytes).sum()
}
/// Approximate bytes held by the KV database (serialized value length per entry).
fn db_bytes_total(db: &HashMap<String, HashMap<String, DbEntry>>) -> u64 {
    db.values().map(|t| t.values().map(|e| e.value.to_string().len() as u64).sum::<u64>()).sum()
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Unix time in milliseconds — used to stamp latency pings (RTT is measured on the hub's own
/// clock via the echoed timestamp, so there is no client clock-skew error).
fn unix_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let port: u16 = std::env::var("CE_HUB_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8970);
    let modules = load_modules();
    eprintln!("ce-hub: loaded {} builtin module(s): {:?}", modules.len(), modules.keys().collect::<Vec<_>>());

    let data_dir = PathBuf::from(std::env::var("CE_HUB_DATA").unwrap_or_else(|_| "./data".into()));
    let apps = load_apps(&data_dir);
    let db = load_db(&data_dir);
    let records = load_records(&data_dir);
    let domains = load_domains(&data_dir);
    let slugs = load_slugs(&data_dir);
    let projects = load_projects(&data_dir);
    let counters = load_counters(&data_dir);
    // Re-pin every screenshot blob referenced by a persisted project so eviction skips them.
    let mut pinned: std::collections::HashSet<String> = std::collections::HashSet::new();
    for p in projects.values() {
        for h in &p.screenshots {
            pinned.insert(h.clone());
        }
    }
    // Seed db_seq above any persisted seq so newest-first ordering survives restart.
    let mut max_seq = 0u64;
    for tbl in db.values() {
        for e in tbl.values() {
            max_seq = max_seq.max(e.seq);
        }
    }
    eprintln!(
        "ce-hub: data dir {} — {} app(s), {} db namespace(s), {} node record(s)",
        data_dir.display(),
        apps.len(),
        db.len(),
        records.len()
    );

    let state: Shared = Arc::new(AppState {
        nodes: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        modules,
        total_tasks: AtomicU64::new(0),
        job_seq: AtomicU64::new(0),
        blobs: Mutex::new(HashMap::new()),
        blob_order: Mutex::new(VecDeque::new()),
        blob_bytes: AtomicU64::new(0),
        data_dir,
        apps: Mutex::new(apps),
        db: Mutex::new(db),
        db_seq: AtomicU64::new(max_seq + 1),
        rooms: Mutex::new(HashMap::new()),
        records: Mutex::new(records),
        domains: Mutex::new(domains),
        limits: Limits::from_env(),
        nonces: Mutex::new(HashMap::new()),
        slugs: Mutex::new(slugs),
        projects: Mutex::new(projects),
        pinned_blobs: Mutex::new(pinned),
        debug: Mutex::new(HashMap::new()),
        rate: Mutex::new(HashMap::new()),
        slug_rate: Mutex::new(HashMap::new()),
        owner_limits: OwnerLimits::from_env(),
        admin_token: env_string("CE_HUB_ADMIN_TOKEN").unwrap_or_default(),
        room_cap: env_usize("CE_HUB_ROOM_CAP", ROOM_CAP_DEFAULT).max(8),
        room_history: env_usize("CE_HUB_ROOM_HISTORY", ROOM_HISTORY_DEFAULT),
        ratelimit_ns: env_string("CE_HUB_RATELIMIT_NS")
            .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
            .unwrap_or_default(),
        counters: Mutex::new(counters),
        detect: Mutex::new(DetectState::default()),
        flags: Mutex::new(VecDeque::new()),
        flag_throttle: Mutex::new(HashMap::new()),
        flagged_total: AtomicU64::new(0),
        watch_url: env_string("CE_WATCH_URL").unwrap_or_else(|| "http://127.0.0.1:8971".into()),
        watch_token: env_string("CE_WATCH_INGEST_TOKEN").unwrap_or_default(),
    });
    eprintln!(
        "ce-hub: storage limits — {} MiB global budget, {} apps, {} domains, {} db namespaces",
        state.limits.max_data_bytes / (1024 * 1024),
        state.limits.max_apps,
        state.limits.max_domains,
        state.limits.max_db_namespaces,
    );

    // prune stale nodes periodically — close their session (accrue uptime) before removal.
    {
        let st = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                let mut dirty = false;
                {
                    let mut nodes = st.nodes.lock().unwrap();
                    let mut records = st.records.lock().unwrap();
                    nodes.retain(|id, n| {
                        if n.last_seen.elapsed() < STALE {
                            return true;
                        }
                        close_session(&mut records, id, n);
                        dirty = true;
                        false
                    });
                }
                if dirty {
                    save_records(&st);
                }
            }
        });
    }

    // GC expired single-use nonces so the replay-protection store stays bounded.
    {
        let st = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let now = unix_now();
                st.nonces.lock().unwrap().retain(|_, exp| *exp > now);
            }
        });
    }

    // Periodically persist durable counters so a crash loses at most one interval of accounting.
    {
        let st = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(15)).await;
                save_counters(&st);
            }
        });
    }

    // H6 sweep: flag any node whose pending in-flight jobs have exceeded its cores for too long.
    {
        let st = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                detect_h6(&st);
            }
        });
    }

    let cors = tower_http::cors::CorsLayer::permissive();
    let app = Router::new()
        .route("/", get(|| async { "ce-hub ok" }))
        .route("/node", get(node_ws))
        .route("/tasks", post(submit_task))
        .route("/stats", get(stats_json))
        .route("/hub/stats", get(stats_json))
        .route("/stats/stream", get(stats_stream))
        .route("/flags", get(flags_json))
        .route("/nodes", get(nodes_json))
        .route("/blobs/:hash", put(put_blob).get(get_blob))
        // --- app hosting (multi-file static sites + SPAs) ---
        .route("/apps/:id/__reload", get(app_reload))
        .route("/apps/:id/config", get(get_app_config).put(put_app_config))
        .route("/apps/:id/debug", get(get_app_debug))
        .route("/apps/:id/domain", put(put_app_domain))
        .route("/apps/:id/domain/:domain", axum::routing::delete(del_app_domain))
        .route("/apps/:id", get(get_app_root).put(put_app_root))
        .route("/apps/:id/", get(get_app_root))
        .route("/apps/:id/*path", get(get_app_path).put(put_app_path))
        // --- custom domains (production): host registry + host-routed serving ---
        .route("/domains", get(list_domains))
        .route("/_host", get(get_host_root))
        .route("/_host/", get(get_host_root))
        .route("/_host/*path", get(get_host_path))
        // --- CE database (persistent KV, namespaced per app) ---
        .route("/db/:app", get(db_list))
        .route("/db/:app/:key", get(db_get).put(db_put).delete(db_del))
        // --- realtime rooms (pub/sub over websocket) ---
        .route("/rt/:app/:room", get(rt_ws))
        // --- slug registry (signed; resolves to apps via the not-found fallback) ---
        .route("/slugs/claim", post(slug_claim))
        .route("/slugs/renew", post(slug_renew))
        .route("/slugs/release", post(slug_release))
        .route("/slugs/:slug", get(slug_get))
        // --- projects registry (signed publish + public listing) ---
        .route("/projects", post(project_publish))
        .route("/projects/:id", axum::routing::delete(project_delete))
        .route("/projects/:id/report", post(project_report))
        .route("/registry", get(registry_list))
        .layer(DefaultBodyLimit::max(MAX_BLOB))
        .layer(cors)
        .with_state(state.clone());

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    eprintln!("ce-hub listening on http://{addr}");
    let shutdown_state = state.clone();
    let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        // Flush durable counters before exit so no completed-job accounting is lost.
        save_counters(&shutdown_state);
        tracing::info!("ce-hub: shutting down, counters flushed");
    });
    if let Err(e) = serve.await {
        eprintln!("ce-hub: server error: {e}");
    }
    // Final flush in case graceful shutdown was bypassed.
    save_counters(&state);
}

fn load_modules() -> HashMap<String, String> {
    let mut m = HashMap::new();
    let dir = std::env::var("CE_HUB_MODULES").unwrap_or_else(|_| "modules".into());
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("wasm") {
                if let (Some(name), Ok(bytes)) = (p.file_stem().and_then(|s| s.to_str()), std::fs::read(&p)) {
                    m.insert(name.to_string(), base64::engine::general_purpose::STANDARD.encode(bytes));
                }
            }
        }
    }
    m
}

// ---- browser node websocket ----

async fn node_ws(ws: WebSocketUpgrade, headers: HeaderMap, State(st): State<Shared>) -> impl IntoResponse {
    let ip = client_ip(&headers);
    ws.on_upgrade(move |socket| handle_node(socket, st, ip))
}

async fn handle_node(socket: WebSocket, st: Shared, ip: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // pump outbound messages (jobs) to this socket
    let pump = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // Signed node-hello challenge: emit a fresh 32-byte nonce; the node signs it with its Ed25519
    // key and replies {t:"hello", id, sig}. Legacy nodes ignore the challenge and send an unsigned
    // hello — still accepted, but keyed/flagged as "ip:"+ip.
    let challenge_nonce: [u8; 32] = {
        let mut n = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut n);
        n
    };
    let challenge_hex = hex::encode(challenge_nonce);
    let _ = tx.send(json!({"t":"challenge","nonce":challenge_hex}).to_string());

    // Latency probe: ping this node every 5s; it echoes the timestamp back as a `pong`, and we
    // compute RTT on receipt. Self-terminates when the outbound channel closes (socket gone).
    let ping_tx = tx.clone();
    let ping = tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs(5));
        iv.tick().await; // skip the immediate first tick
        loop {
            iv.tick().await;
            if ping_tx.send(json!({"t":"ping","ts":unix_millis()}).to_string()).is_err() {
                break;
            }
        }
    });

    let mut node_id: Option<String> = None;
    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        match v.get("t").and_then(|x| x.as_str()).unwrap_or("") {
            "hello" => {
                // Resolve the connection's node id. A signed hello carries {id:<pubkey hex>,
                // sig:<hex over the challenge nonce bytes>}: verify it and key the connection to the
                // pubkey. An unsigned/legacy hello is accepted but keyed (and flagged) as "ip:"+ip.
                let claimed = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let sig_hex = v.get("sig").and_then(|x| x.as_str()).unwrap_or("");
                let id = if !sig_hex.is_empty() && !claimed.is_empty() {
                    match verify_node_hello(&claimed, sig_hex, &challenge_nonce) {
                        Ok(()) => claimed,
                        Err(reason) => {
                            // A node that SENT a signature but it does not verify is suspicious:
                            // do not silently accept it under the claimed key. Fall back to ip key.
                            tracing::warn!(%ip, reason, "ce-hub: node-hello signature rejected");
                            format!("ip:{ip}")
                        }
                    }
                } else if !claimed.is_empty() && claimed.len() == 64 && hex::decode(&claimed).is_ok() {
                    // Legacy random-id hello (32-byte hex, no signature): accept but mark unsigned.
                    format!("ip:{ip}")
                } else if claimed.is_empty() {
                    continue;
                } else {
                    format!("ip:{ip}")
                };
                let caps: Caps = serde_json::from_value(v.get("caps").cloned().unwrap_or(json!({}))).unwrap_or_default();
                let now = unix_now();
                // Open a new reliability session: first_seen on first ever sight, sessions+=1.
                {
                    let mut records = st.records.lock().unwrap();
                    let rec = records.entry(id.clone()).or_default();
                    if rec.first_seen_unix == 0 {
                        rec.first_seen_unix = now;
                    }
                    rec.last_seen_unix = now;
                    rec.sessions += 1;
                }
                st.nodes.lock().unwrap().insert(
                    id.clone(),
                    NodeEntry {
                        caps,
                        last_seen: Instant::now(),
                        tasks_run: 0,
                        tx: tx.clone(),
                        session_start: SystemTime::now(),
                        session_open: true,
                        rtt_ms: 0.0,
                    },
                );
                node_id = Some(id.clone());
                save_records(&st);
                let _ = tx.send(json!({"t":"welcome","id":id}).to_string());
            }
            "hb" => {
                if let Some(id) = &node_id {
                    if let Some(n) = st.nodes.lock().unwrap().get_mut(id) {
                        n.last_seen = Instant::now();
                    }
                    if let Some(rec) = st.records.lock().unwrap().get_mut(id) {
                        rec.last_seen_unix = unix_now();
                    }
                }
            }
            "pong" => {
                if let Some(id) = &node_id {
                    let ts = v.get("ts").and_then(|x| x.as_u64()).unwrap_or(0);
                    if ts > 0 {
                        let rtt = unix_millis().saturating_sub(ts) as f64;
                        if let Some(n) = st.nodes.lock().unwrap().get_mut(id) {
                            // EWMA so a single jittery sample doesn't dominate the displayed value.
                            n.rtt_ms = if n.rtt_ms <= 0.0 { rtt } else { n.rtt_ms * 0.7 + rtt * 0.3 };
                            n.last_seen = Instant::now();
                        }
                    }
                }
            }
            "result" => {
                let jid = v.get("jid").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let res = JobResult {
                    ok: v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
                    value: v.get("value").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    ms: v.get("ms").and_then(|x| x.as_f64()).unwrap_or(0.0),
                    error: v.get("error").and_then(|x| x.as_str()).map(|s| s.to_string()),
                };
                let reported_ms = res.ms;
                if let Some(sender) = st.pending.lock().unwrap().remove(&jid) {
                    let _ = sender.send(res);
                }
                st.total_tasks.fetch_add(1, Ordering::Relaxed);
                // Durable accounting: count the task and fold in its self-reported wall-clock ms
                // (this is the value that used to be silently discarded on this path).
                {
                    let mut c = st.counters.lock().unwrap();
                    c.tasks_run = c.tasks_run.saturating_add(1);
                    let ms = if reported_ms.is_finite() && reported_ms > 0.0 { reported_ms as u64 } else { 0 };
                    c.compute_distributed_ms = c.compute_distributed_ms.saturating_add(ms);
                }
                if let Some(id) = &node_id {
                    if let Some(n) = st.nodes.lock().unwrap().get_mut(id) {
                        n.tasks_run += 1;
                        n.last_seen = Instant::now();
                    }
                    // Release one in-flight slot on this node's H6 gauge.
                    gauge_dec(&st, id);
                }
            }
            "stored" => {
                // Ack for a replication push: best-effort, refresh liveness. Replica tracking is
                // done optimistically at push time; unknown/extra acks are ignored gracefully.
                if let Some(id) = &node_id {
                    if let Some(n) = st.nodes.lock().unwrap().get_mut(id) {
                        n.last_seen = Instant::now();
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(id) = node_id {
        // Disconnect: close the session and accrue its uptime (unless prune already did).
        let removed = {
            let mut nodes = st.nodes.lock().unwrap();
            let mut records = st.records.lock().unwrap();
            match nodes.remove(&id) {
                Some(mut n) => {
                    close_session(&mut records, &id, &mut n);
                    true
                }
                None => false,
            }
        };
        if removed {
            save_records(&st);
        }
    }
    ping.abort();
    pump.abort();
}

/// Close a node's online session (idempotent): add elapsed seconds to total_online_secs and
/// increment disconnects exactly once. Called on disconnect or prune.
fn close_session(records: &mut HashMap<String, NodeRecord>, id: &str, n: &mut NodeEntry) {
    if !n.session_open {
        return;
    }
    n.session_open = false;
    let elapsed = n.session_start.elapsed().map(|d| d.as_secs()).unwrap_or(0);
    let rec = records.entry(id.to_string()).or_default();
    rec.total_online_secs += elapsed;
    rec.disconnects += 1;
    rec.last_seen_unix = unix_now();
}

// ---- push a task ----

#[derive(Deserialize)]
struct TaskReq {
    /// "wasm" (default) or "js". A js task ships source `code` + JSON `input` instead of a module.
    #[serde(default)]
    lang: Option<String>,
    /// builtin module name (e.g. "demo") or a raw base64 wasm module (wasm tasks).
    #[serde(default)]
    module: Option<String>,
    /// exported function name (wasm) or the entry function name (js, default "task").
    #[serde(default)]
    func: Option<String>,
    #[serde(default)]
    args: Vec<i64>,
    #[serde(default)]
    ret: Option<String>,
    /// js task source — a function expression, e.g. `function task(input){...}` or `i=>i*2`.
    #[serde(default)]
    code: Option<String>,
    /// arbitrary JSON input passed to a js task's entry function.
    #[serde(default)]
    input: Option<Value>,
    /// optionally target a specific node id.
    #[serde(default)]
    target: Option<String>,
}

async fn submit_task(State(st): State<Shared>, headers: HeaderMap, Json(req): Json<TaskReq>) -> impl IntoResponse {
    let lang = req.lang.as_deref().unwrap_or("wasm");
    let ip = client_ip(&headers);

    // Build the job payload for the chosen language.
    let mut job = json!({ "t": "job" });
    let func: String;
    if lang != "wasm" {
        // Generalized source-code task: ANY non-wasm lang (js, python, ...) is forwarded to the
        // node unchanged as {t:"job",jid,lang,code,func,input}. The "js" wire shape is byte-
        // identical to before; nodes opt into new languages with no per-lang hub change.
        let Some(code) = req.code.clone() else {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("{lang} task requires `code`")}))).into_response();
        };
        func = req.func.clone().unwrap_or_else(|| "task".into());
        job["lang"] = json!(lang);
        job["code"] = json!(code);
        job["func"] = json!(func);
        job["input"] = req.input.clone().unwrap_or(Value::Null);
    } else {
        // resolve module → base64
        let key = req.module.clone().unwrap_or_else(|| "demo".into());
        let module_b64 = if let Some(b64) = st.modules.get(&key) {
            b64.clone()
        } else if key.len() > 64 {
            key.clone() // treat as raw base64 wasm
        } else {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("unknown module '{key}'")}))).into_response();
        };
        let Some(f) = req.func.clone() else {
            return (StatusCode::BAD_REQUEST, Json(json!({"error":"wasm task requires `func`"}))).into_response();
        };
        func = f;
        job["lang"] = json!("wasm");
        job["module_b64"] = json!(module_b64);
        job["func"] = json!(func);
        job["args"] = json!(req.args);
        job["ret"] = json!(req.ret.clone().unwrap_or_else(|| "i32".into()));
    }

    // Detector submitter axis: a per-submission "signature" = (func, sha256(args|code)) and, for a
    // raw wasm task, the module sha256. These are the keys H2/H4 tally on. Computed before dispatch.
    let sig_material = match job.get("module_b64").and_then(|m| m.as_str()) {
        Some(m) => format!("{}|{}", func, m),
        None => format!(
            "{}|{}",
            func,
            job.get("code").and_then(|c| c.as_str()).unwrap_or("")
        ),
    };
    // For wasm, fold the args into the signature so identical (module,func,args) collapse together.
    let sig_material = format!("{sig_material}|{:?}", req.args);
    let submit_sig = hex::encode(&Sha256::digest(sig_material.as_bytes())[..16]);
    let module_sha = job
        .get("module_b64")
        .and_then(|m| m.as_str())
        .map(|m| hex::encode(&Sha256::digest(m.as_bytes())[..16]));

    // pick a *live* node (target, else the least-loaded one) and grab its sender.
    // Filtering on freshness avoids dispatching to a zombie socket that will never reply (a 504).
    let (jid, node_id, tx) = {
        let nodes = st.nodes.lock().unwrap();
        let live = || nodes.iter().filter(|(_, n)| n.last_seen.elapsed() < STALE);
        if live().next().is_none() {
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"no browser nodes connected"}))).into_response();
        }
        let chosen = match &req.target {
            Some(t) if nodes.get(t).map(|n| n.last_seen.elapsed() < STALE).unwrap_or(false) => t.clone(),
            Some(t) => return (StatusCode::NOT_FOUND, Json(json!({"error": format!("node {t} not connected")}))).into_response(),
            None => live().min_by_key(|(_, n)| n.tasks_run).map(|(k, _)| k.clone()).unwrap(),
        };
        let jid = format!("j{}", st.job_seq.fetch_add(1, Ordering::Relaxed));
        let tx = nodes.get(&chosen).unwrap().tx.clone();
        (jid, chosen, tx)
    };

    // Run the H1-H5 submitter heuristics now that the target node is known. Any trip raises a
    // FlagEvent (ringed + logged + pushed to ce-watch). Detection never blocks dispatch.
    detect_submit(&st, &ip, &func, &submit_sig, module_sha.as_deref(), &node_id);
    // Track this job as in-flight on its node for the H6 pending>cores gauge; released on result.
    gauge_inc(&st, &node_id);

    let (otx, orx) = oneshot::channel::<JobResult>();
    st.pending.lock().unwrap().insert(jid.clone(), otx);

    job["jid"] = json!(jid);
    if tx.send(job.to_string()).is_err() {
        st.pending.lock().unwrap().remove(&jid);
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"node went away"}))).into_response();
    }

    match tokio::time::timeout(Duration::from_secs(30), orx).await {
        Ok(Ok(res)) => {
            // H3 — fold this job's run-ms into the submitter's rolling-median latency tally.
            detect_runtime(&st, &ip, &node_id, res.ms);
            Json(json!({
                "node": node_id, "lang": lang, "func": func, "args": req.args,
                "ok": res.ok, "value": res.value, "ms": res.ms, "error": res.error,
            })).into_response()
        }
        _ => {
            st.pending.lock().unwrap().remove(&jid);
            // The result path never ran, so release the in-flight gauge slot here instead.
            gauge_dec(&st, &node_id);
            (StatusCode::GATEWAY_TIMEOUT, Json(json!({"error":"node did not return in time"}))).into_response()
        }
    }
}

// ---- content-addressed blob store (storage demo) ----
//
// The browser sha256's the bytes client-side and PUTs them at that key, then can GET them back
// from anywhere and re-verify the hash — content addressing, demonstrated end to end. In-memory,
// FIFO-evicted, size-capped: a demo surface, not durable storage.

async fn put_blob(
    Path(hash): Path<String>,
    headers: HeaderMap,
    State(st): State<Shared>,
    body: Bytes,
) -> impl IntoResponse {
    if body.len() > MAX_BLOB {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({"error":"blob too large (16 MB max)"}))).into_response();
    }
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let size = body.len();
    // Read apps + db usage first (locks released before the blob lock) for the global budget check.
    let app_b = app_bytes_total(&st.apps.lock().unwrap());
    let db_b = db_bytes_total(&st.db.lock().unwrap());
    {
        let mut blobs = st.blobs.lock().unwrap();
        let mut order = st.blob_order.lock().unwrap();
        // Global storage budget: reject a genuinely new blob that would push the host over budget.
        if !blobs.contains_key(&hash)
            && app_b + db_b + st.blob_bytes.load(Ordering::Relaxed) + size as u64 > st.limits.max_data_bytes
        {
            return (StatusCode::INSUFFICIENT_STORAGE, Json(json!({"error":"global storage budget reached (CE_HUB_MAX_DATA_BYTES)"}))).into_response();
        }
        if !blobs.contains_key(&hash) {
            order.push_back(hash.clone());
            st.blob_bytes.fetch_add(size as u64, Ordering::Relaxed);
        }
        blobs.insert(hash.clone(), Blob { ct, bytes: body.to_vec() });
        // FIFO eviction over budget, but never evict a PINNED blob (a project screenshot): rotate
        // pinned hashes to the back of the order so the scan makes progress on evictable entries.
        let pins = st.pinned_blobs.lock().unwrap();
        let mut skipped = 0usize;
        while st.blob_bytes.load(Ordering::Relaxed) > MAX_BLOB_TOTAL {
            match order.pop_front() {
                Some(old) => {
                    if pins.contains(&old) {
                        order.push_back(old);
                        skipped += 1;
                        if skipped >= order.len() {
                            break; // all remaining are pinned; stop to avoid an infinite loop
                        }
                        continue;
                    }
                    if let Some(b) = blobs.remove(&old) {
                        st.blob_bytes.fetch_sub(b.bytes.len() as u64, Ordering::Relaxed);
                    }
                }
                None => break,
            }
        }
    }
    Json(json!({ "hash": hash, "size": size })).into_response()
}

async fn get_blob(Path(hash): Path<String>, State(st): State<Shared>) -> impl IntoResponse {
    let blobs = st.blobs.lock().unwrap();
    match blobs.get(&hash) {
        Some(b) => ([(header::CONTENT_TYPE, b.ct.clone())], b.bytes.clone()).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error":"not found"}))).into_response(),
    }
}

// ---- app hosting (multi-file static sites + SPAs) ----
//
// PUT /apps/:id/*path stores a file under (id, normalized-path); empty/"/" -> index.html. Each PUT
// bumps the app's version and fires a reload event. GET serves files with a content-type from the
// extension and injects a hot-reload SSE snippet into HTML. Apps persist under CE_HUB_DATA/apps/<id>.

/// Normalize a request path into a storage key. Empty or "/" -> "index.html"; strip a leading
/// slash; reject "..", absolute, and empty segments to keep storage inside the app's directory.
fn norm_app_path(raw: &str) -> Option<String> {
    let p = raw.trim_start_matches('/');
    if p.is_empty() {
        return Some("index.html".to_string());
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        parts.push(seg);
    }
    Some(parts.join("/"))
}

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "map" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

const RELOAD_SNIPPET: &str = "<script>(()=>{try{const e=new EventSource(location.pathname.replace(/\\/[^\\/]*$/,'')+'/__reload');e.onmessage=ev=>{if(window.__cev&&window.__cev!==ev.data)location.reload();window.__cev=ev.data};}catch(_){}})()</script>";

fn inject_reload(html: &[u8]) -> Vec<u8> {
    let s = String::from_utf8_lossy(html);
    if let Some(idx) = s.rfind("</body>") {
        let mut out = String::with_capacity(s.len() + RELOAD_SNIPPET.len());
        out.push_str(&s[..idx]);
        out.push_str(RELOAD_SNIPPET);
        out.push_str(&s[idx..]);
        out.into_bytes()
    } else {
        let mut out = s.into_owned();
        out.push_str(RELOAD_SNIPPET);
        out.into_bytes()
    }
}

async fn put_app_root(
    Path(id): Path<String>,
    headers: HeaderMap,
    State(st): State<Shared>,
    body: Bytes,
) -> impl IntoResponse {
    let rpath = format!("/apps/{id}");
    store_app_file(&st, &id, "", &rpath, &headers, body).await
}

async fn put_app_path(
    Path((id, path)): Path<(String, String)>,
    headers: HeaderMap,
    State(st): State<Shared>,
    body: Bytes,
) -> impl IntoResponse {
    let rpath = format!("/apps/{id}/{path}");
    store_app_file(&st, &id, &path, &rpath, &headers, body).await
}

async fn store_app_file(st: &Shared, id: &str, raw_path: &str, req_path: &str, headers: &HeaderMap, body: Bytes) -> axum::response::Response {
    note_request(st, id);
    if body.len() > MAX_APP_FILE {
        return app_err(st, id, StatusCode::PAYLOAD_TOO_LARGE, "file too large (16 MB max)");
    }
    if id.is_empty() || id.contains('/') {
        return app_err(st, id, StatusCode::BAD_REQUEST, "bad app id");
    }
    let Some(key) = norm_app_path(raw_path) else {
        return app_err(st, id, StatusCode::BAD_REQUEST, "bad path");
    };
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| mime_for(&key).to_string());

    // Verify an (optional) signature. A valid signature yields the caller's owner id; an INVALID
    // one is a hard 401 (do not silently downgrade a tampered request to anonymous).
    let signer = match verify_signed(st, "PUT", req_path, headers, &body) {
        Ok(s) => s,
        Err(e) => return app_err(st, id, StatusCode::UNAUTHORIZED, &e),
    };

    // Ownership: enforce against any existing owner; record owner on first signed write.
    {
        let apps = st.apps.lock().unwrap();
        if let Some(app) = apps.get(id) {
            if !app.owner.is_empty() {
                match &signer {
                    Some(s) if s.owner == app.owner => {}
                    _ => {
                        drop(apps);
                        return app_err(st, id, StatusCode::FORBIDDEN, "app is owned by another identity");
                    }
                }
            }
        }
    }

    // Identity-scoped per-app byte budget: a signed owner gets the generous (trust-scaled) budget;
    // anonymous keeps the strict per-app floor (MAX_APP_BYTES).
    let app_cap = match &signer {
        Some(s) => st.owner_limits.app_budget(owner_trust(st, &s.owner)),
        None => MAX_APP_BYTES,
    };

    let new_size = body.len() as u64;
    let version = {
        let mut apps = st.apps.lock().unwrap();
        // Global app-count cap: only a genuinely new app id counts against it.
        if !apps.contains_key(id) && apps.len() >= st.limits.max_apps {
            drop(apps);
            return app_err(st, id, StatusCode::INSUFFICIENT_STORAGE, "app limit reached (CE_HUB_MAX_APPS)");
        }
        // Global storage budget across apps + db + blobs (protects the host disk from a stranger).
        let prev = apps.get(id).and_then(|a| a.files.get(&key)).map(|f| f.bytes.len() as u64).unwrap_or(0);
        let db_b = db_bytes_total(&st.db.lock().unwrap());
        let blob_b = st.blob_bytes.load(Ordering::Relaxed);
        let projected = app_bytes_total(&apps).saturating_sub(prev) + new_size + db_b + blob_b;
        if projected > st.limits.max_data_bytes {
            drop(apps);
            return app_err(st, id, StatusCode::INSUFFICIENT_STORAGE, "global storage budget reached (CE_HUB_MAX_DATA_BYTES)");
        }
        let app = apps.entry(id.to_string()).or_insert_with(new_hosted_app);
        // Record owner on the first signed write to a previously anonymous app.
        if let Some(s) = &signer {
            if app.owner.is_empty() {
                app.owner = s.owner.clone();
            }
        }
        // enforce per-app caps (file count + total bytes); reject overflow on genuinely new files.
        if !app.files.contains_key(&key) && app.files.len() >= MAX_APP_FILES {
            drop(apps);
            return app_err(st, id, StatusCode::INSUFFICIENT_STORAGE, "too many files for app (200 max)");
        }
        if app.bytes.saturating_sub(prev) + new_size > app_cap {
            drop(apps);
            return app_err(st, id, StatusCode::INSUFFICIENT_STORAGE, "app size cap exceeded");
        }
        app.bytes = app.bytes.saturating_sub(prev) + new_size;
        app.files.insert(key.clone(), AppFile { bytes: body.to_vec(), ct });
        app.version += 1;
        let v = app.version;
        let _ = app.reload.send(v);
        v
    };
    persist_app_file(st, id, &key, &body, version);
    persist_app_owner(st, id);
    // Best-effort mesh replication: push a copy to up to K live nodes. The relay remains the
    // source of truth for reads; this only adds redundancy and never blocks the PUT response.
    replicate_app_file(st, id, &key, &body, version);
    Json(json!({ "id": id, "path": key, "version": version, "url": format!("/apps/{id}/") })).into_response()
}

/// K — number of live nodes a hosted-app file is replicated to (best-effort).
const REPLICA_K: usize = 3;

/// Push a copy of an app file to up to REPLICA_K live nodes over their WS as
/// {t:"store",kind:"app",id,path,b64,ct,version}. Records the targeted node ids as replicas for
/// the app. Fire-and-forget: a failed send just means that node holds no replica, which is fine.
fn replicate_app_file(st: &Shared, id: &str, key: &str, bytes: &[u8], version: u64) {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let ct = mime_for(key).to_string();
    let msg = json!({
        "t": "store", "kind": "app", "id": id, "path": key,
        "b64": b64, "ct": ct, "version": version,
    })
    .to_string();

    // Choose up to K fresh nodes (least-loaded first), grab their senders under one lock.
    let targets: Vec<(String, mpsc::UnboundedSender<String>)> = {
        let nodes = st.nodes.lock().unwrap();
        let mut live: Vec<(&String, &NodeEntry)> =
            nodes.iter().filter(|(_, n)| n.last_seen.elapsed() < STALE).collect();
        live.sort_by_key(|(_, n)| n.tasks_run);
        live.into_iter().take(REPLICA_K).map(|(k, n)| (k.clone(), n.tx.clone())).collect()
    };

    let mut placed: Vec<String> = Vec::new();
    for (nid, tx) in targets {
        if tx.send(msg.clone()).is_ok() {
            placed.push(nid);
        }
    }
    if !placed.is_empty() {
        let mut apps = st.apps.lock().unwrap();
        if let Some(app) = apps.get_mut(id) {
            for nid in placed {
                app.replicas.insert(nid);
            }
            // Drop replica ids that are no longer live so the counter reflects reality.
        }
    }
}

fn new_hosted_app() -> HostedApp {
    let (tx, _rx) = broadcast::channel::<u64>(16);
    HostedApp {
        files: HashMap::new(),
        version: 0,
        bytes: 0,
        reload: tx,
        spa: true,
        replicas: std::collections::HashSet::new(),
        owner: String::new(),
    }
}

async fn get_app_root(Path(id): Path<String>, headers: HeaderMap, State(st): State<Shared>) -> impl IntoResponse {
    serve_app_file(&st, &id, "index.html", &headers)
}

async fn get_app_path(Path((id, path)): Path<(String, String)>, headers: HeaderMap, State(st): State<Shared>) -> impl IntoResponse {
    let key = norm_app_path(&path).unwrap_or_else(|| "index.html".to_string());
    serve_app_file(&st, &id, &key, &headers)
}

/// Does this request look like a client-side route (vs an asset)? True when the final path
/// segment has no "." OR the Accept header asks for HTML. Such requests get SPA-fallback to
/// index.html; a missing path WITH a file extension stays a 404.
fn looks_like_route(key: &str, headers: &HeaderMap) -> bool {
    let last = key.rsplit('/').next().unwrap_or(key);
    if !last.contains('.') {
        return true;
    }
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|a| a.contains("text/html"))
        .unwrap_or(false)
}

fn serve_app_file(st: &Shared, id: &str, key: &str, headers: &HeaderMap) -> axum::response::Response {
    let apps = st.apps.lock().unwrap();
    let Some(app) = apps.get(id) else {
        // Slug fallback (no nginx change): GET /apps/<slug>/... resolves <slug> -> its app id.
        // Only follow non-expired claims, and only one hop to avoid loops.
        if let Some(target) = resolve_slug(st, id) {
            if target != id && apps.contains_key(&target) {
                drop(apps);
                return serve_app_file(st, &target, key, headers);
            }
        }
        return (StatusCode::NOT_FOUND, Json(json!({"error":"app not found"}))).into_response();
    };
    // Exact match first; else SPA fallback to index.html for route-like requests.
    let file = match app.files.get(key) {
        Some(f) => f,
        None => {
            if app.spa && key != "index.html" && looks_like_route(key, headers) {
                match app.files.get("index.html") {
                    Some(f) => f,
                    None => return (StatusCode::NOT_FOUND, Json(json!({"error":"file not found"}))).into_response(),
                }
            } else {
                return (StatusCode::NOT_FOUND, Json(json!({"error":"file not found"}))).into_response();
            }
        }
    };
    let ct = if file.ct.is_empty() { mime_for(key).to_string() } else { file.ct.clone() };
    if ct.starts_with("text/html") {
        let body = inject_reload(&file.bytes);
        ([(header::CONTENT_TYPE, ct)], body).into_response()
    } else {
        ([(header::CONTENT_TYPE, ct)], file.bytes.clone()).into_response()
    }
}

async fn app_reload(Path(id): Path<String>, State(st): State<Shared>) -> impl IntoResponse {
    // Subscribe to this app's reload broadcaster; emit the current version immediately, then each bump.
    let (rx, current) = {
        let mut apps = st.apps.lock().unwrap();
        let app = apps.entry(id.clone()).or_insert_with(new_hosted_app);
        (app.reload.subscribe(), app.version)
    };
    let initial = futures_util::stream::once(async move {
        Ok::<Event, std::convert::Infallible>(Event::default().data(current.to_string()))
    });
    let updates = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(v) => return Some((Ok::<Event, std::convert::Infallible>(Event::default().data(v.to_string())), rx)),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(initial.chain(updates)).keep_alive(axum::response::sse::KeepAlive::default())
}

// ---- app config (spa flag, version, domains) ----

#[derive(Deserialize)]
struct AppConfigReq {
    #[serde(default)]
    spa: Option<bool>,
}

async fn put_app_config(
    Path(id): Path<String>,
    State(st): State<Shared>,
    Json(req): Json<AppConfigReq>,
) -> impl IntoResponse {
    if id.is_empty() || id.contains('/') {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad app id"}))).into_response();
    }
    let (spa, version) = {
        let mut apps = st.apps.lock().unwrap();
        let app = apps.entry(id.clone()).or_insert_with(new_hosted_app);
        if let Some(s) = req.spa {
            app.spa = s;
        }
        (app.spa, app.version)
    };
    persist_app_config(&st, &id, spa);
    Json(json!({ "ok": true, "id": id, "spa": spa, "version": version })).into_response()
}

async fn get_app_config(Path(id): Path<String>, State(st): State<Shared>) -> impl IntoResponse {
    let apps = st.apps.lock().unwrap();
    let Some(app) = apps.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"app not found"}))).into_response();
    };
    let spa = app.spa;
    let version = app.version;
    drop(apps);
    let domains: Vec<String> = {
        let d = st.domains.lock().unwrap();
        d.iter().filter(|(_, v)| **v == id).map(|(k, _)| k.clone()).collect()
    };
    Json(json!({ "spa": spa, "version": version, "domains": domains })).into_response()
}

// ---- custom domains (production): host registry + host-routed serving ----

#[derive(Deserialize)]
struct DomainReq {
    domain: String,
}

/// Normalize a hostname for the registry: lowercase, strip any port and surrounding whitespace.
fn norm_host(raw: &str) -> String {
    let h = raw.trim().to_ascii_lowercase();
    match h.split_once(':') {
        Some((host, _port)) => host.to_string(),
        None => h,
    }
}

async fn put_app_domain(
    Path(id): Path<String>,
    State(st): State<Shared>,
    Json(req): Json<DomainReq>,
) -> impl IntoResponse {
    if id.is_empty() || id.contains('/') {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad app id"}))).into_response();
    }
    let domain = norm_host(&req.domain);
    if domain.is_empty() || !domain.contains('.') {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid domain"}))).into_response();
    }
    {
        let mut d = st.domains.lock().unwrap();
        // Global domain-count cap: only a genuinely new domain counts against it.
        if !d.contains_key(&domain) && d.len() >= st.limits.max_domains {
            return (StatusCode::INSUFFICIENT_STORAGE, Json(json!({"error":"domain limit reached (CE_HUB_MAX_DOMAINS)"}))).into_response();
        }
        d.insert(domain.clone(), id.clone());
    }
    save_domains(&st);
    Json(json!({ "domain": domain, "id": id, "cname": "ce-net.com" })).into_response()
}

async fn del_app_domain(Path((id, domain)): Path<(String, String)>, State(st): State<Shared>) -> impl IntoResponse {
    let domain = norm_host(&domain);
    let removed = {
        let mut d = st.domains.lock().unwrap();
        // Only remove if this domain maps to the given app (avoid cross-app deletes).
        if d.get(&domain).map(|v| *v == id).unwrap_or(false) {
            d.remove(&domain);
            true
        } else {
            false
        }
    };
    if removed {
        save_domains(&st);
        Json(json!({ "ok": true, "domain": domain })).into_response()
    } else {
        (StatusCode::NOT_FOUND, Json(json!({"error":"domain not registered for this app"}))).into_response()
    }
}

async fn list_domains(State(st): State<Shared>) -> impl IntoResponse {
    let d = st.domains.lock().unwrap();
    let mut list: Vec<Value> = d.iter().map(|(k, v)| json!({ "domain": k, "id": v })).collect();
    list.sort_by(|a, b| a["domain"].as_str().unwrap_or("").cmp(b["domain"].as_str().unwrap_or("")));
    Json(list).into_response()
}

/// Resolve the app id for a custom-domain request from the X-CE-Host header (set by nginx to the
/// original Host). Returns a JSON 404 when the host is unregistered.
fn resolve_host(st: &Shared, headers: &HeaderMap) -> Result<String, axum::response::Response> {
    let host = headers
        .get("x-ce-host")
        .and_then(|v| v.to_str().ok())
        .map(norm_host)
        .unwrap_or_default();
    if host.is_empty() {
        return Err((StatusCode::NOT_FOUND, Json(json!({"error":"no host"}))).into_response());
    }
    let d = st.domains.lock().unwrap();
    match d.get(&host) {
        Some(id) => Ok(id.clone()),
        None => Err((StatusCode::NOT_FOUND, Json(json!({"error":"host not registered","host":host}))).into_response()),
    }
}

async fn get_host_root(headers: HeaderMap, State(st): State<Shared>) -> impl IntoResponse {
    match resolve_host(&st, &headers) {
        Ok(id) => serve_app_file(&st, &id, "index.html", &headers),
        Err(r) => r,
    }
}

async fn get_host_path(Path(path): Path<String>, headers: HeaderMap, State(st): State<Shared>) -> impl IntoResponse {
    match resolve_host(&st, &headers) {
        Ok(id) => {
            let key = norm_app_path(&path).unwrap_or_else(|| "index.html".to_string());
            serve_app_file(&st, &id, &key, &headers)
        }
        Err(r) => r,
    }
}

// ---- CE database (persistent KV, namespaced per app) ----

async fn db_put(
    Path((app, key)): Path<(String, String)>,
    headers: HeaderMap,
    State(st): State<Shared>,
    body: Bytes,
) -> impl IntoResponse {
    note_request(&st, &app);
    // Per-namespace IP rate limit (CE_HUB_RATELIMIT_NS): 429 over budget for the configured names.
    if st.ratelimit_ns.contains(&app) {
        let ip = client_ip(&headers);
        if !rate_allow(&st.rate, (app.clone(), ip), 30.0, 0.5) {
            return app_err(&st, &app, StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded");
        }
    }
    // The signed canonical body is the RAW request bytes; parse the JSON value from those bytes.
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return app_err(&st, &app, StatusCode::BAD_REQUEST, "body is not valid JSON"),
    };
    // Optional signature: invalid -> 401. A valid one yields the owner for namespace ownership.
    let rpath = format!("/db/{app}/{key}");
    let signer = match verify_signed(&st, "PUT", &rpath, &headers, &body) {
        Ok(s) => s,
        Err(e) => return app_err(&st, &app, StatusCode::UNAUTHORIZED, &e),
    };
    // A db namespace inherits its hosting app's owner (if any): a signed write to an owned app's
    // namespace must come from that owner; anonymous namespaces stay open.
    if let Some(owner) = st.apps.lock().unwrap().get(&app).map(|a| a.owner.clone()).filter(|o| !o.is_empty()) {
        match &signer {
            Some(s) if s.owner == owner => {}
            Some(_) => return app_err(&st, &app, StatusCode::FORBIDDEN, "namespace owned by another identity"),
            None => {}
        }
    }

    // Conditional PUT (compare-and-set): If-Match: <term> requires the stored entry's `term` field
    // to equal the header before the write; mismatch -> 409. Enables race-free snapshot/ownership.
    let if_match = headers.get("if-match").and_then(|v| v.to_str().ok()).map(|s| s.trim().trim_matches('"').to_string());

    // Size of the incoming value; computed before `value` is moved into the entry.
    let new_size = value.to_string().len() as u64;
    // Read non-db usage first (apps + blobs), releasing those locks before taking the db lock so
    // the lock order stays apps -> db and never deadlocks against store_app_file.
    let app_b = app_bytes_total(&st.apps.lock().unwrap());
    let blob_b = st.blob_bytes.load(Ordering::Relaxed);
    {
        let mut db = st.db.lock().unwrap();
        // Conditional CAS check before any mutation.
        if let Some(want) = &if_match {
            let cur = db
                .get(&app)
                .and_then(|t| t.get(&key))
                .map(|e| db_term(&e.value))
                .unwrap_or_default();
            if &cur != want {
                drop(db);
                return (
                    StatusCode::CONFLICT,
                    Json(json!({"error":"If-Match term mismatch","current": cur})),
                )
                    .into_response();
            }
        }
        // Global namespace-count cap: only a genuinely new namespace counts against it.
        if !db.contains_key(&app) && db.len() >= st.limits.max_db_namespaces {
            drop(db);
            return app_err(&st, &app, StatusCode::INSUFFICIENT_STORAGE, "db namespace limit reached (CE_HUB_MAX_DB_NAMESPACES)");
        }
        // Global storage budget across apps + db + blobs.
        let prev = db.get(&app).and_then(|t| t.get(&key)).map(|e| e.value.to_string().len() as u64).unwrap_or(0);
        let projected = app_b + blob_b + db_bytes_total(&db).saturating_sub(prev) + new_size;
        if projected > st.limits.max_data_bytes {
            drop(db);
            return app_err(&st, &app, StatusCode::INSUFFICIENT_STORAGE, "global storage budget reached (CE_HUB_MAX_DATA_BYTES)");
        }
        let tbl = db.entry(app.clone()).or_default();
        let seq = st.db_seq.fetch_add(1, Ordering::Relaxed);
        tbl.insert(key.clone(), DbEntry { value, seq });
        // Evict oldest keys (lowest seq) on overflow to keep the namespace bounded.
        while tbl.len() > MAX_DB_KEYS {
            if let Some(oldest) = tbl.iter().min_by_key(|(_, e)| e.seq).map(|(k, _)| k.clone()) {
                tbl.remove(&oldest);
            } else {
                break;
            }
        }
    }
    save_db(&st, &app);
    Json(json!({ "ok": true, "key": key })).into_response()
}

/// Extract the CAS `term` of a stored db value (the `term` field as a string), or "" if absent.
fn db_term(v: &Value) -> String {
    match v.get("term") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

async fn db_get(Path((app, key)): Path<(String, String)>, State(st): State<Shared>) -> impl IntoResponse {
    note_request(&st, &app);
    let db = st.db.lock().unwrap();
    match db.get(&app).and_then(|t| t.get(&key)) {
        Some(e) => Json(e.value.clone()).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error":"not found"}))).into_response(),
    }
}

async fn db_del(Path((app, key)): Path<(String, String)>, State(st): State<Shared>) -> impl IntoResponse {
    {
        let mut db = st.db.lock().unwrap();
        if let Some(tbl) = db.get_mut(&app) {
            tbl.remove(&key);
        }
    }
    save_db(&st, &app);
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct DbListQ {
    #[serde(default)]
    prefix: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn db_list(Path(app): Path<String>, Query(q): Query<DbListQ>, State(st): State<Shared>) -> impl IntoResponse {
    let limit = q.limit.unwrap_or(200).min(1000);
    let prefix = q.prefix.unwrap_or_default();
    let db = st.db.lock().unwrap();
    let mut entries: Vec<(&String, &DbEntry)> = match db.get(&app) {
        Some(tbl) => tbl.iter().filter(|(k, _)| k.starts_with(&prefix)).collect(),
        None => Vec::new(),
    };
    // newest-first by insertion (highest seq first).
    entries.sort_by(|a, b| b.1.seq.cmp(&a.1.seq));
    let items: Vec<Value> = entries
        .into_iter()
        .take(limit)
        .map(|(k, e)| json!({ "key": k, "value": e.value }))
        .collect();
    let n = items.len();
    Json(json!({ "items": items, "n": n })).into_response()
}

// ---- realtime rooms (pub/sub over websocket) ----

#[derive(Deserialize)]
struct RtQuery {
    /// ?ephemeral=1 marks a high-rate room that skips the 50-deep history replay (state frames).
    #[serde(default)]
    ephemeral: Option<u8>,
}

async fn rt_ws(
    Path((app, room)): Path<(String, String)>,
    Query(q): Query<RtQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    State(st): State<Shared>,
) -> impl IntoResponse {
    let ephemeral = q.ephemeral.unwrap_or(0) != 0;
    let ip = client_ip(&headers);
    ws.on_upgrade(move |socket| handle_room(socket, st, app, room, ephemeral, ip))
}

/// A broadcast message tagged with the originating client's id, so each client can filter out
/// its own frames. Carries either a text frame or a raw binary frame (full-rate state).
#[derive(Clone)]
struct RoomMsg {
    from: u64,
    payload: RoomPayload,
}

#[derive(Clone)]
enum RoomPayload {
    Text(String),
    Binary(Vec<u8>),
}

static ROOM_CLIENT_SEQ: AtomicU64 = AtomicU64::new(1);

async fn handle_room(socket: WebSocket, st: Shared, app: String, room: String, ephemeral: bool, ip: String) {
    let key = (app.clone(), room);
    let me = ROOM_CLIENT_SEQ.fetch_add(1, Ordering::Relaxed);
    let room_cap = st.room_cap;
    let room_history = st.room_history;
    let rate_limited = st.ratelimit_ns.contains(&app);
    // Get/create the room: subscribe for live traffic and snapshot recent history.
    let (tx, mut rx, history) = {
        let mut rooms = st.rooms.lock().unwrap();
        let r = rooms.entry(key.clone()).or_insert_with(|| Room {
            tx: broadcast::channel::<RoomMsg>(room_cap).0,
            history: VecDeque::new(),
            ephemeral,
        });
        // An ephemeral join keeps the room ephemeral; otherwise replay history.
        let hist = if r.ephemeral {
            Vec::new()
        } else {
            r.history.iter().cloned().collect::<Vec<_>>()
        };
        (r.tx.clone(), r.tx.subscribe(), hist)
    };

    let (mut sink, mut stream) = socket.split();

    // Replay buffered history (text only) before live traffic. Ephemeral rooms have none.
    for msg in history {
        if let RoomPayload::Text(t) = msg.payload {
            if sink.send(Message::Text(t)).await.is_err() {
                return;
            }
        }
    }

    // Forward live broadcasts from OTHER clients to this client (text + binary).
    let pump = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(m) => {
                    if m.from == me {
                        continue; // do not echo our own frames back
                    }
                    let out = match m.payload {
                        RoomPayload::Text(t) => Message::Text(t),
                        RoomPayload::Binary(b) => Message::Binary(b),
                    };
                    if sink.send(out).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Read client frames: broadcast each TEXT/BINARY frame to all OTHER clients. Text frames are
    // buffered in history (non-ephemeral rooms only); binary frames are never buffered.
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                // Per-namespace IP rate limit on inbound room writes when this ns is configured.
                if rate_limited && !rate_allow(&st.rate, (app.clone(), ip.clone()), 30.0, 0.5) {
                    continue;
                }
                let m = RoomMsg { from: me, payload: RoomPayload::Text(t) };
                if !ephemeral {
                    let mut rooms = st.rooms.lock().unwrap();
                    if let Some(r) = rooms.get_mut(&key) {
                        if !r.ephemeral {
                            r.history.push_back(m.clone());
                            while r.history.len() > room_history {
                                r.history.pop_front();
                            }
                        }
                    }
                }
                let _ = tx.send(m);
            }
            Message::Binary(b) => {
                if rate_limited && !rate_allow(&st.rate, (app.clone(), ip.clone()), 60.0, 1.0) {
                    continue;
                }
                // Binary frames (full-rate authoritative state) are broadcast, never buffered.
                let _ = tx.send(RoomMsg { from: me, payload: RoomPayload::Binary(b) });
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    pump.abort();
    // Clean up empty rooms (no receivers left) to bound memory.
    {
        let mut rooms = st.rooms.lock().unwrap();
        if let Some(r) = rooms.get(&key) {
            if r.tx.receiver_count() == 0 {
                rooms.remove(&key);
            }
        }
    }
}

// ---- signed-write verification (ed25519) + ownership ----
//
// A mutating request MAY carry headers x-ce-id (pubkey hex), x-ce-sig (ed25519 over the canonical
// string), x-ce-ts (unix secs), x-ce-nonce (random). The canonical string signed by the client is:
//   METHOD"\n"+PATH"\n"+ts"\n"+nonce"\n"+sha256(body)-hex
// Requests WITHOUT x-ce-sig are anonymous (today's behavior, fully backward compatible). A request
// WITH x-ce-sig that fails any check is rejected (401). The owner id is sha256(pubkey)[..16] hex.

/// Verify a signed node-hello: `id_hex` is the node's Ed25519 public key (32 bytes hex), `sig_hex`
/// is its signature (64 bytes hex) over the raw challenge `nonce` bytes the hub issued on connect.
/// Returns Ok(()) on a valid signature, Err(reason) otherwise.
fn verify_node_hello(id_hex: &str, sig_hex: &str, nonce: &[u8]) -> Result<(), &'static str> {
    let pubkey = hex::decode(id_hex).map_err(|_| "bad id hex")?;
    let pk_arr: [u8; 32] = pubkey.as_slice().try_into().map_err(|_| "id must be 32 bytes")?;
    let vk = VerifyingKey::from_bytes(&pk_arr).map_err(|_| "bad public key")?;
    let sig_bytes = hex::decode(sig_hex).map_err(|_| "bad sig hex")?;
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().map_err(|_| "sig must be 64 bytes")?;
    let sig = Signature::from_bytes(&sig_arr);
    vk.verify(nonce, &sig).map_err(|_| "signature does not verify")
}

/// Build the canonical string a client signs (and the hub re-derives) for one mutating request.
fn canonical_string(method: &str, path: &str, ts: &str, nonce: &str, body: &[u8]) -> String {
    let body_hex = hex::encode(Sha256::digest(body));
    format!("{method}\n{path}\n{ts}\n{nonce}\n{body_hex}")
}

/// Derive the stable owner id for a public key: sha256(pubkey-bytes)[..16] as hex (32 hex chars).
fn owner_id_from_pubkey(pubkey: &[u8]) -> String {
    hex::encode(&Sha256::digest(pubkey)[..16])
}

/// Verify the optional signature on a mutating request.
/// - No x-ce-sig header  -> Ok(None)  (anonymous; stays open).
/// - Present and valid   -> Ok(Some(Signer { owner })).
/// - Present and invalid -> Err(reason)  (caller returns 401).
fn verify_signed(st: &Shared, method: &str, path: &str, headers: &HeaderMap, body: &[u8]) -> Result<Option<Signer>, String> {
    let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let sig_hex = match h("x-ce-sig") {
        Some(s) => s,
        None => return Ok(None), // anonymous
    };
    let id_hex = h("x-ce-id").ok_or("missing x-ce-id")?;
    let ts = h("x-ce-ts").ok_or("missing x-ce-ts")?;
    let nonce = h("x-ce-nonce").ok_or("missing x-ce-nonce")?;

    // Timestamp window.
    let ts_num: u64 = ts.parse().map_err(|_| "bad x-ce-ts")?;
    let now = unix_now();
    let skew = now.max(ts_num) - now.min(ts_num);
    if skew > SIG_TTL_SECS {
        return Err("timestamp outside tolerance".into());
    }
    // Single-use nonce (replay protection within the TTL window).
    {
        let mut nonces = st.nonces.lock().unwrap();
        nonces.retain(|_, exp| *exp > now);
        if nonces.contains_key(&nonce) {
            return Err("nonce already used".into());
        }
        nonces.insert(nonce.clone(), now + SIG_TTL_SECS);
    }

    let pubkey = hex::decode(&id_hex).map_err(|_| "bad x-ce-id hex")?;
    let pk_arr: [u8; 32] = pubkey.as_slice().try_into().map_err(|_| "x-ce-id must be 32 bytes")?;
    let vk = VerifyingKey::from_bytes(&pk_arr).map_err(|_| "bad public key")?;
    let sig_bytes = hex::decode(&sig_hex).map_err(|_| "bad x-ce-sig hex")?;
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().map_err(|_| "x-ce-sig must be 64 bytes")?;
    let sig = Signature::from_bytes(&sig_arr);
    let canon = canonical_string(method, path, &ts, &nonce, body);
    vk.verify(canon.as_bytes(), &sig).map_err(|_| "signature does not verify")?;
    Ok(Some(Signer { owner: owner_id_from_pubkey(&pubkey) }))
}

/// Verify a signed request body that is itself a JSON object (slug/project ops). Returns the owner
/// plus the parsed JSON. A signature is REQUIRED here (these registries are owner-scoped).
fn verify_signed_json(st: &Shared, method: &str, path: &str, headers: &HeaderMap, body: &[u8]) -> Result<(String, Value), (StatusCode, String)> {
    match verify_signed(st, method, path, headers, body) {
        Ok(Some(s)) => {
            let v: Value = serde_json::from_slice(body).map_err(|_| (StatusCode::BAD_REQUEST, "body is not valid JSON".into()))?;
            Ok((s.owner, v))
        }
        Ok(None) => Err((StatusCode::UNAUTHORIZED, "signature required".into())),
        Err(e) => Err((StatusCode::UNAUTHORIZED, e)),
    }
}

/// Trust factor in 0.0..1.0 for an owner, derived from the best uptime of any node whose id maps to
/// this owner (owner = sha256(node-pubkey)[..16]). Unknown owner -> a sane constant (0.25).
fn owner_trust(st: &Shared, owner: &str) -> f64 {
    let nodes = st.nodes.lock().unwrap();
    let records = st.records.lock().unwrap();
    let mut best: Option<u64> = None;
    for (id, n) in nodes.iter() {
        // A node id here is its pubkey hex; map it to an owner id the same way signed writes do.
        let nid_owner = match hex::decode(id) {
            Ok(bytes) => owner_id_from_pubkey(&bytes),
            Err(_) => owner_id_from_pubkey(id.as_bytes()),
        };
        if nid_owner == owner {
            let rec = records.get(id).cloned().unwrap_or_default();
            let online = n.session_start.elapsed().map(|d| d.as_secs()).unwrap_or(0);
            let pct = uptime_pct(&rec, online);
            best = Some(best.map_or(pct, |b| b.max(pct)));
        }
    }
    match best {
        Some(pct) => (pct as f64 / 100.0).clamp(0.0, 1.0),
        None => 0.25, // sane constant when the owner is not a known live node
    }
}

// ---- per-namespace / per-owner rate limiting (token bucket) ----

/// Try to consume one token from the bucket keyed by `key`. `cap` is the bucket size and `refill`
/// is tokens added per second. Returns true if allowed, false if over budget (caller -> 429).
fn rate_allow<K: std::hash::Hash + Eq + Clone>(buckets: &Mutex<HashMap<K, RateBucket>>, key: K, cap: f64, refill: f64) -> bool {
    let mut map = buckets.lock().unwrap();
    let now = Instant::now();
    let b = map.entry(key).or_insert(RateBucket { tokens: cap, last: now });
    let dt = now.duration_since(b.last).as_secs_f64();
    b.last = now;
    b.tokens = (b.tokens + dt * refill).min(cap);
    if b.tokens >= 1.0 {
        b.tokens -= 1.0;
        true
    } else {
        false
    }
}

/// Client IP for rate limiting: honor X-Real-IP (set by nginx), else X-Forwarded-For's first hop.
fn client_ip(headers: &HeaderMap) -> String {
    if let Some(ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        return ip.trim().to_string();
    }
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            return first.trim().to_string();
        }
    }
    "unknown".to_string()
}

// ---- abuse detector (submitter axis: H1-H6) ----
//
// The detector watches the SUBMITTER side of the mesh (who is pushing work) plus a per-node
// in-flight gauge. It never blocks dispatch; it raises FlagEvents that are ringed, logged, and
// best-effort forwarded to ce-watch. All per-IP tallies live in a window (DETECT_WINDOW) and the
// IP map is bounded (DETECT_IP_CAP), so detector memory is a function of recent traffic only.

/// Run the H1-H5 submitter heuristics for one submission from `ip` targeting `node_id`.
/// `func` is the task function, `submit_sig` is sha256(func|args|code), `module_sha` is the wasm
/// module hash (None for source tasks). Any trip raises a FlagEvent. Detection never blocks.
fn detect_submit(st: &Shared, ip: &str, func: &str, submit_sig: &str, module_sha: Option<&str>, node_id: &str) {
    let now = Instant::now();
    let mut trips: Vec<(String, String, String, Value)> = Vec::new(); // (heuristic, reason, severity, sample)
    {
        let mut det = st.detect.lock().unwrap();
        // Bound the IP map: if at cap and this is a new IP, drop an arbitrary existing entry first.
        if !det.ips.contains_key(ip) && det.ips.len() >= DETECT_IP_CAP {
            if let Some(victim) = det.ips.keys().next().cloned() {
                det.ips.remove(&victim);
            }
        }
        let stat = det.ips.entry(ip.to_string()).or_default();

        // H1 — per-IP submit token bucket (burst/sustained-rate control).
        let b = stat.bucket.get_or_insert(RateBucket { tokens: H1_BUCKET_CAP, last: now });
        let dt = now.duration_since(b.last).as_secs_f64();
        b.last = now;
        b.tokens = (b.tokens + dt * H1_REFILL_PER_S).min(H1_BUCKET_CAP);
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
        } else {
            trips.push((
                "H1".into(),
                format!("submit-rate: ip exceeded {H1_BUCKET_CAP:.0}-burst @ {H1_REFILL_PER_S}/s token bucket"),
                "med".into(),
                json!({ "func": func }),
            ));
        }

        // H2 — >N identical (func, sha256(args|code)) submissions per ip in the window.
        let q = stat.sigs.entry(submit_sig.to_string()).or_default();
        q.push_back(now);
        prune_window(q, now);
        let sig_count = q.len() as u64;
        if sig_count > H2_IDENTICAL_MAX {
            trips.push((
                "H2".into(),
                format!(
                    "repeat-signature: {func} x{sig_count} in 5m — mining shape (sig {})",
                    &submit_sig[..submit_sig.len().min(8)]
                ),
                "high".into(),
                json!({ "func": func, "count": sig_count, "sig": submit_sig }),
            ));
        }

        // H4 — same raw module sha256 submitted >N times per ip in the window.
        if let Some(msha) = module_sha {
            let mq = stat.modules.entry(msha.to_string()).or_default();
            mq.push_back(now);
            prune_window(mq, now);
            let mod_count = mq.len() as u64;
            if mod_count > H4_MODULE_MAX {
                trips.push((
                    "H4".into(),
                    format!("module-fanout: same wasm module x{mod_count} in 5m (mod {})", &msha[..msha.len().min(8)]),
                    "high".into(),
                    json!({ "module_sha": msha, "count": mod_count }),
                ));
            }
        }

        // H5 — one ip touching >N distinct nodes AND >M tasks in the window.
        stat.nodes.insert(node_id.to_string(), now);
        stat.nodes.retain(|_, t| now.duration_since(*t) <= DETECT_WINDOW);
        stat.submits.push_back(now);
        prune_window(&mut stat.submits, now);
        let distinct_nodes = stat.nodes.len();
        let task_count = stat.submits.len();
        if distinct_nodes > H5_DISTINCT_NODES && task_count > H5_TASK_COUNT {
            trips.push((
                "H5".into(),
                format!("fan-out: ip hit {distinct_nodes} distinct nodes with {task_count} tasks in 5m"),
                "med".into(),
                json!({ "distinct_nodes": distinct_nodes, "tasks": task_count }),
            ));
        }
    }
    for (h, reason, sev, sample) in trips {
        raise_flag(st, node_id, ip, &h, &reason, &sev, sample);
    }
}

/// Record a per-IP run-ms sample and run H3 (rolling-median latency) for that IP. Called from the
/// result path where the node's self-reported ms is known.
fn detect_runtime(st: &Shared, ip: &str, node_id: &str, ms: f64) {
    if !(ms.is_finite() && ms > 0.0) {
        return;
    }
    let now = Instant::now();
    let (median, runs) = {
        let mut det = st.detect.lock().unwrap();
        let stat = det.ips.entry(ip.to_string()).or_default();
        stat.ms_samples.push_back(ms);
        while stat.ms_samples.len() > DETECT_MS_SAMPLES {
            stat.ms_samples.pop_front();
        }
        let runs = stat.submits.len().max(stat.ms_samples.len());
        let mut sorted: Vec<f64> = stat.ms_samples.iter().copied().collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = if sorted.is_empty() { 0.0 } else { sorted[sorted.len() / 2] };
        (median, runs)
    };
    if median > H3_MEDIAN_MS && runs > H3_MIN_RUNS {
        raise_flag(
            st,
            node_id,
            ip,
            "H3",
            &format!("long-jobs: rolling median {median:.0}ms over {runs} runs/5m — sustained heavy compute"),
            "low",
            json!({ "median_ms": median, "runs": runs }),
        );
    }
}

/// H6 sweep: flag any node whose in-flight pending jobs have exceeded its core count for longer
/// than H6_PENDING_SECS. Called on a timer.
fn detect_h6(st: &Shared) {
    let now = Instant::now();
    let mut trips: Vec<(String, u64, u32, u64)> = Vec::new(); // (node_id, pending, cores, over_secs)
    {
        let det = st.detect.lock().unwrap();
        for (id, g) in det.gauges.iter() {
            if let Some(since) = g.over_since {
                let over = now.duration_since(since).as_secs();
                if over >= H6_PENDING_SECS {
                    trips.push((id.clone(), g.pending, g.cores, over));
                }
            }
        }
    }
    for (id, pending, cores, over) in trips {
        raise_flag(
            st,
            &id,
            "",
            "H6",
            &format!("overloaded-node: pending {pending} > {cores} cores for {over}s — saturated/stuck"),
            "med",
            json!({ "pending": pending, "cores": cores, "over_secs": over }),
        );
    }
}

/// Increment a node's H6 in-flight gauge; arm over_since when pending first exceeds cores.
fn gauge_inc(st: &Shared, node_id: &str) {
    let cores = st
        .nodes
        .lock()
        .unwrap()
        .get(node_id)
        .map(|n| n.caps.cores)
        .unwrap_or(0);
    let mut det = st.detect.lock().unwrap();
    let g = det.gauges.entry(node_id.to_string()).or_default();
    g.cores = cores;
    g.pending = g.pending.saturating_add(1);
    if g.pending > g.cores as u64 {
        if g.over_since.is_none() {
            g.over_since = Some(Instant::now());
        }
    } else {
        g.over_since = None;
    }
}

/// Decrement a node's H6 in-flight gauge; disarm over_since once back within capacity.
fn gauge_dec(st: &Shared, node_id: &str) {
    let mut det = st.detect.lock().unwrap();
    if let Some(g) = det.gauges.get_mut(node_id) {
        g.pending = g.pending.saturating_sub(1);
        if g.pending <= g.cores as u64 {
            g.over_since = None;
        }
    }
}

/// Raise a FlagEvent: dedup-throttle per (ip, heuristic), push to the ring (cap FLAG_RING_CAP),
/// log via tracing::warn!, and fire-and-forget POST it to ce-watch /ingest. Returns true if the
/// flag was emitted (not throttled) — used by tests.
fn raise_flag(st: &Shared, node_id: &str, ip: &str, heuristic: &str, reason: &str, severity: &str, sample: Value) -> bool {
    // Dedup throttle: collapse repeats of the same (ip, heuristic) within FLAG_THROTTLE.
    {
        let mut thr = st.flag_throttle.lock().unwrap();
        let now = Instant::now();
        // Opportunistically prune stale throttle entries so the map stays bounded.
        thr.retain(|_, t| now.duration_since(*t) <= FLAG_THROTTLE * 4);
        let key = (ip.to_string(), heuristic.to_string());
        if let Some(last) = thr.get(&key) {
            if now.duration_since(*last) < FLAG_THROTTLE {
                return false;
            }
        }
        thr.insert(key, now);
    }
    let resolved_node = if node_id.is_empty() { format!("ip:{ip}") } else { node_id.to_string() };
    let ev = FlagEvent {
        ts: unix_now(),
        node_id: resolved_node,
        ip: ip.to_string(),
        heuristic: heuristic.to_string(),
        reason: reason.to_string(),
        severity: severity.to_string(),
        sample,
    };
    tracing::warn!(
        heuristic = %ev.heuristic,
        node_id = %ev.node_id,
        ip = %ev.ip,
        severity = %ev.severity,
        reason = %ev.reason,
        "ce-hub detector flag"
    );
    {
        let mut ring = st.flags.lock().unwrap();
        ring.push_back(ev.clone());
        while ring.len() > FLAG_RING_CAP {
            ring.pop_front();
        }
    }
    st.flagged_total.fetch_add(1, Ordering::Relaxed);
    push_flag_to_watch(st, ev);
    true
}

/// Fire-and-forget POST of a FlagEvent to ce-watch /ingest. Non-blocking, best-effort: any error is
/// ignored and never bubbles up to the task dispatch path. A raw HTTP/1.1 write over a tokio socket
/// keeps the hub light (no extra HTTP client dependency).
fn push_flag_to_watch(st: &Shared, ev: FlagEvent) {
    let url = st.watch_url.clone();
    let token = st.watch_token.clone();
    let body = match serde_json::to_vec(&ev) {
        Ok(b) => b,
        Err(_) => return,
    };
    tokio::spawn(async move {
        let _ = post_json_best_effort(&url, "/ingest", &token, &body).await;
    });
}

/// Minimal best-effort HTTP/1.1 JSON POST. Parses `base` as http://host:port, connects, writes one
/// request with the x-ce-watch-token header, and drops the response. Errors are swallowed.
async fn post_json_best_effort(base: &str, path: &str, token: &str, body: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let rest = base.strip_prefix("http://").unwrap_or(base);
    let authority = rest.split('/').next().unwrap_or(rest);
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().unwrap_or(80)),
        None => (authority, 80u16),
    };
    let mut stream = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "connect timeout"))??;
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nx-ce-watch-token: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(req.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await?;
    Ok(())
}

/// GET /flags — recent FlagEvents (newest last) for the ce-watch console / dashboards.
async fn flags_json(State(st): State<Shared>) -> impl IntoResponse {
    let flags: Vec<FlagEvent> = st.flags.lock().unwrap().iter().cloned().collect();
    let n = flags.len();
    Json(json!({ "flags": flags, "n": n })).into_response()
}

// ---- per-app debug ring ----

/// Record a request against an app's debug counter (cheap; bounded map of small structs).
fn note_request(st: &Shared, id: &str) {
    if id.is_empty() {
        return;
    }
    let mut dbg = st.debug.lock().unwrap();
    dbg.entry(id.to_string()).or_default().requests += 1;
}

/// Record an error against an app + return the matching JSON error response in one call.
fn app_err(st: &Shared, id: &str, code: StatusCode, msg: &str) -> axum::response::Response {
    {
        let mut dbg = st.debug.lock().unwrap();
        let e = dbg.entry(id.to_string()).or_default();
        e.errors += 1;
        let mut m = msg.to_string();
        m.truncate(DEBUG_ERR_MAX);
        e.last_error = Some(m);
    }
    (code, Json(json!({ "error": msg }))).into_response()
}

async fn get_app_debug(Path(id): Path<String>, State(st): State<Shared>) -> impl IntoResponse {
    let (requests, errors, last_error) = {
        let dbg = st.debug.lock().unwrap();
        match dbg.get(&id) {
            Some(d) => (d.requests, d.errors, d.last_error.clone()),
            None => (0, 0, None),
        }
    };
    let (version, owner, bytes) = {
        let apps = st.apps.lock().unwrap();
        match apps.get(&id) {
            Some(a) => (a.version, a.owner.clone(), a.bytes),
            None => (0, String::new(), 0),
        }
    };
    // Live room count for this app namespace (rt rooms keyed by (app, room)).
    let rooms = {
        let rooms = st.rooms.lock().unwrap();
        rooms.keys().filter(|(a, _)| a == &id).count()
    };
    Json(json!({
        "requests": requests,
        "errors": errors,
        "last_error": last_error,
        "version": version,
        "owner": owner,
        "bytes": bytes,
        "rooms": rooms,
    }))
    .into_response()
}

// ---- slug registry (signed) ----
//
// A slug is a short human name -> (owner, app_id). Claims are signed; reserved names are refused;
// each owner has a cap and a claim rate bucket; a grace window protects a just-expired slug from
// being snatched by someone else. Slugs resolve to apps in serve_app_file's not-found branch.

/// Slug TTL after claim/renew (env CE_HUB_SLUG_TTL_SECS, default 90 days).
fn slug_ttl_secs() -> u64 {
    env_u64("CE_HUB_SLUG_TTL_SECS", 90 * 24 * 3600)
}
/// Grace window after expiry during which only the prior owner may re-claim (default 7 days).
fn slug_grace_secs() -> u64 {
    env_u64("CE_HUB_SLUG_GRACE_SECS", 7 * 24 * 3600)
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 48
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

/// Resolve a slug to its app id if it exists and is not past its (expired + grace) lifetime.
fn resolve_slug(st: &Shared, slug: &str) -> Option<String> {
    let now = unix_now();
    let slugs = st.slugs.lock().unwrap();
    slugs.get(slug).filter(|e| e.expires_unix + slug_grace_secs() > now).map(|e| e.app_id.clone())
}

#[derive(Deserialize)]
struct SlugReq {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    app_id: String,
}

async fn slug_claim(headers: HeaderMap, State(st): State<Shared>, body: Bytes) -> impl IntoResponse {
    let (owner, _v) = match verify_signed_json(&st, "POST", "/slugs/claim", &headers, &body) {
        Ok(x) => x,
        Err((c, m)) => return (c, Json(json!({ "error": m }))).into_response(),
    };
    let req: SlugReq = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad body"}))).into_response(),
    };
    let slug = req.slug.trim().to_ascii_lowercase();
    if !valid_slug(&slug) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid slug (a-z0-9-, <=48)"}))).into_response();
    }
    if RESERVED_NAMES.contains(&slug.as_str()) {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"reserved name"}))).into_response();
    }
    if req.app_id.is_empty() || req.app_id.contains('/') {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad app_id"}))).into_response();
    }
    // Per-owner claim rate bucket (slug churn control): 10 claims, refill 1 / 60s.
    if !rate_allow(&st.slug_rate, owner.clone(), 10.0, 1.0 / 60.0) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error":"slug claim rate exceeded"}))).into_response();
    }
    let now = unix_now();
    let ttl = slug_ttl_secs();
    let grace = slug_grace_secs();
    {
        let mut slugs = st.slugs.lock().unwrap();
        if let Some(existing) = slugs.get(&slug) {
            let alive = existing.expires_unix > now;
            let in_grace = !alive && existing.expires_unix + grace > now;
            if (alive || in_grace) && existing.owner != owner {
                return (StatusCode::CONFLICT, Json(json!({"error":"slug taken"}))).into_response();
            }
        }
        // Per-owner slug cap (count this owner's live slugs; a re-claim of an existing one is free).
        let count = slugs.values().filter(|e| e.owner == owner && e.expires_unix > now).count();
        let already_mine = slugs.get(&slug).map(|e| e.owner == owner).unwrap_or(false);
        if !already_mine && count >= st.owner_limits.owner_slug_cap {
            return (StatusCode::INSUFFICIENT_STORAGE, Json(json!({"error":"per-owner slug cap reached (CE_HUB_OWNER_SLUG_CAP)"}))).into_response();
        }
        slugs.insert(
            slug.clone(),
            SlugEntry { owner: owner.clone(), app_id: req.app_id.clone(), created_unix: now, expires_unix: now + ttl },
        );
    }
    save_slugs(&st);
    Json(json!({ "ok": true, "slug": slug, "app_id": req.app_id, "owner": owner, "expires_unix": now + ttl })).into_response()
}

async fn slug_renew(headers: HeaderMap, State(st): State<Shared>, body: Bytes) -> impl IntoResponse {
    let (owner, _v) = match verify_signed_json(&st, "POST", "/slugs/renew", &headers, &body) {
        Ok(x) => x,
        Err((c, m)) => return (c, Json(json!({ "error": m }))).into_response(),
    };
    let req: SlugReq = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad body"}))).into_response(),
    };
    let slug = req.slug.trim().to_ascii_lowercase();
    let now = unix_now();
    let ttl = slug_ttl_secs();
    let new_exp = {
        let mut slugs = st.slugs.lock().unwrap();
        match slugs.get_mut(&slug) {
            Some(e) if e.owner == owner => {
                e.expires_unix = now + ttl;
                e.expires_unix
            }
            Some(_) => return (StatusCode::FORBIDDEN, Json(json!({"error":"not slug owner"}))).into_response(),
            None => return (StatusCode::NOT_FOUND, Json(json!({"error":"slug not found"}))).into_response(),
        }
    };
    save_slugs(&st);
    Json(json!({ "ok": true, "slug": slug, "expires_unix": new_exp })).into_response()
}

async fn slug_release(headers: HeaderMap, State(st): State<Shared>, body: Bytes) -> impl IntoResponse {
    let (owner, _v) = match verify_signed_json(&st, "POST", "/slugs/release", &headers, &body) {
        Ok(x) => x,
        Err((c, m)) => return (c, Json(json!({ "error": m }))).into_response(),
    };
    let req: SlugReq = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad body"}))).into_response(),
    };
    let slug = req.slug.trim().to_ascii_lowercase();
    let removed = {
        let mut slugs = st.slugs.lock().unwrap();
        match slugs.get(&slug) {
            Some(e) if e.owner == owner => {
                slugs.remove(&slug);
                true
            }
            Some(_) => return (StatusCode::FORBIDDEN, Json(json!({"error":"not slug owner"}))).into_response(),
            None => false,
        }
    };
    if removed {
        save_slugs(&st);
    }
    Json(json!({ "ok": removed, "slug": slug })).into_response()
}

async fn slug_get(Path(slug): Path<String>, State(st): State<Shared>) -> impl IntoResponse {
    let slug = slug.to_ascii_lowercase();
    let now = unix_now();
    let slugs = st.slugs.lock().unwrap();
    match slugs.get(&slug) {
        Some(e) => Json(json!({
            "slug": slug, "app_id": e.app_id, "owner": e.owner,
            "expires_unix": e.expires_unix, "created_unix": e.created_unix,
            "alive": e.expires_unix > now,
        }))
        .into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error":"slug not found"}))).into_response(),
    }
}

// ---- projects registry (signed publish + public listing) ----

#[derive(Deserialize)]
struct ProjectReq {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    app_id: String,
    #[serde(default)]
    desc: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    screenshots: Vec<String>,
    #[serde(default)]
    site: String,
    #[serde(default = "default_true")]
    public: bool,
}

async fn project_publish(headers: HeaderMap, State(st): State<Shared>, body: Bytes) -> impl IntoResponse {
    let (owner, _v) = match verify_signed_json(&st, "POST", "/projects", &headers, &body) {
        Ok(x) => x,
        Err((c, m)) => return (c, Json(json!({ "error": m }))).into_response(),
    };
    let req: ProjectReq = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad body"}))).into_response(),
    };
    if req.title.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"title required"}))).into_response();
    }
    // Stable id: caller-provided (update) or slug/app_id-derived (create). 'registry' is reserved.
    let pid = req
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| Some(req.slug.clone()).filter(|s| !s.is_empty()))
        .or_else(|| Some(req.app_id.clone()).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| format!("p{}", unix_millis()));
    let pid = pid.to_ascii_lowercase();
    if pid.contains('/') || RESERVED_NAMES.contains(&pid.as_str()) {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"reserved or invalid project id"}))).into_response();
    }
    let now = unix_now();
    {
        let mut projects = st.projects.lock().unwrap();
        if let Some(existing) = projects.get(&pid) {
            if existing.owner != owner {
                return (StatusCode::FORBIDDEN, Json(json!({"error":"project owned by another identity"}))).into_response();
            }
        }
        let created = projects.get(&pid).map(|e| e.created_unix).unwrap_or(now);
        let reports = projects.get(&pid).map(|e| e.reports.clone()).unwrap_or_default();
        // Re-pin: drop old pins for this project, pin the new screenshot set.
        let old_shots = projects.get(&pid).map(|e| e.screenshots.clone()).unwrap_or_default();
        let entry = ProjectEntry {
            id: pid.clone(),
            owner: owner.clone(),
            title: req.title.clone(),
            slug: req.slug.clone(),
            app_id: req.app_id.clone(),
            desc: req.desc.clone(),
            tags: req.tags.clone(),
            screenshots: req.screenshots.clone(),
            site: req.site.clone(),
            public: req.public,
            created_unix: created,
            updated_unix: now,
            reports,
        };
        projects.insert(pid.clone(), entry);
        drop(projects);
        repin_blobs(&st, &old_shots, &req.screenshots);
    }
    save_projects(&st);
    Json(json!({ "ok": true, "id": pid, "owner": owner })).into_response()
}

async fn project_delete(Path(id): Path<String>, headers: HeaderMap, State(st): State<Shared>, body: Bytes) -> impl IntoResponse {
    let id = id.to_ascii_lowercase();
    // Admin override: X-CE-Admin matching CE_HUB_ADMIN_TOKEN takes down any project.
    let is_admin = !st.admin_token.is_empty()
        && headers.get("x-ce-admin").and_then(|v| v.to_str().ok()).map(|t| t == st.admin_token).unwrap_or(false);
    let owner = if is_admin {
        None
    } else {
        match verify_signed(&st, "DELETE", &format!("/projects/{id}"), &headers, &body) {
            Ok(Some(s)) => Some(s.owner),
            Ok(None) => return (StatusCode::UNAUTHORIZED, Json(json!({"error":"signature required"}))).into_response(),
            Err(e) => return (StatusCode::UNAUTHORIZED, Json(json!({ "error": e }))).into_response(),
        }
    };
    let removed = {
        let mut projects = st.projects.lock().unwrap();
        match projects.get(&id) {
            Some(e) if is_admin || owner.as_deref() == Some(e.owner.as_str()) => {
                let shots = e.screenshots.clone();
                projects.remove(&id);
                drop(projects);
                repin_blobs(&st, &shots, &[]);
                true
            }
            Some(_) => return (StatusCode::FORBIDDEN, Json(json!({"error":"not project owner"}))).into_response(),
            None => false,
        }
    };
    if removed {
        save_projects(&st);
    }
    Json(json!({ "ok": removed, "id": id })).into_response()
}

#[derive(Deserialize)]
struct ReportReq {
    #[serde(default)]
    reason: String,
}

async fn project_report(Path(id): Path<String>, headers: HeaderMap, State(st): State<Shared>, body: Bytes) -> impl IntoResponse {
    let id = id.to_ascii_lowercase();
    // Reports are rate limited per IP (anti-spam); no signature required (anyone can flag).
    let ip = client_ip(&headers);
    if !rate_allow(&st.rate, ("report".to_string(), ip), 5.0, 0.05) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error":"report rate exceeded"}))).into_response();
    }
    let req: ReportReq = serde_json::from_slice(&body).unwrap_or(ReportReq { reason: String::new() });
    let mut reason = req.reason;
    reason.truncate(280);
    let ok = {
        let mut projects = st.projects.lock().unwrap();
        match projects.get_mut(&id) {
            Some(e) => {
                if e.reports.len() < 200 {
                    e.reports.push(reason);
                }
                true
            }
            None => false,
        }
    };
    if ok {
        save_projects(&st);
        Json(json!({ "ok": true })).into_response()
    } else {
        (StatusCode::NOT_FOUND, Json(json!({"error":"project not found"}))).into_response()
    }
}

/// GET /registry: public projects merged with live hub state (is the app hosted? live room count).
async fn registry_list(State(st): State<Shared>) -> impl IntoResponse {
    let projects: Vec<ProjectEntry> = {
        let p = st.projects.lock().unwrap();
        p.values().filter(|e| e.public).cloned().collect()
    };
    let apps = st.apps.lock().unwrap();
    let rooms = st.rooms.lock().unwrap();
    let mut items: Vec<Value> = projects
        .into_iter()
        .map(|e| {
            // Resolve the app this project points at: explicit app_id, else its slug's target.
            let target = if !e.app_id.is_empty() {
                e.app_id.clone()
            } else if !e.slug.is_empty() {
                resolve_slug(&st, &e.slug).unwrap_or_default()
            } else {
                String::new()
            };
            let hosted = !target.is_empty() && apps.contains_key(&target);
            let room_count = if target.is_empty() {
                0
            } else {
                rooms.keys().filter(|(a, _)| a == &target).count()
            };
            json!({
                "id": e.id, "title": e.title, "slug": e.slug, "app_id": e.app_id,
                "desc": e.desc, "tags": e.tags, "screenshots": e.screenshots,
                "site": e.site, "owner": e.owner,
                "created_unix": e.created_unix, "updated_unix": e.updated_unix,
                "hosted": hosted, "rooms": room_count, "reports": e.reports.len(),
            })
        })
        .collect();
    items.sort_by(|a, b| b["updated_unix"].as_u64().unwrap_or(0).cmp(&a["updated_unix"].as_u64().unwrap_or(0)));
    let n = items.len();
    Json(json!({ "projects": items, "n": n })).into_response()
}

/// Update the pinned-blob set when a project's screenshot list changes: unpin those only in `old`,
/// pin everything in `new`. Pinned blobs are excluded from FIFO eviction in put_blob.
fn repin_blobs(st: &Shared, old: &[String], new: &[String]) {
    let mut pins = st.pinned_blobs.lock().unwrap();
    for h in old {
        if !new.contains(h) {
            pins.remove(h);
        }
    }
    for h in new {
        pins.insert(h.clone());
    }
}

// ---- on-disk persistence (CE_HUB_DATA) ----
//
// Best-effort JSON files via serde_json + std::fs. Never panic on bad/missing files: log to stderr
// and continue. Layout:
//   <data>/apps/<id>/<path>        raw app file bytes (mirrors the served tree)
//   <data>/apps/<id>/.version      the app's version counter
//   <data>/apps/<id>/.owner        the app's signed owner id (sha256(pubkey)[..16] hex)
//   <data>/db/<app>.json           { key: { value, seq } } for one db namespace
//   <data>/nodes.json              { node_id: NodeRecord } reliability records
//   <data>/slugs.json              { slug: SlugEntry } slug registry
//   <data>/projects.json           { id: ProjectEntry } projects registry

fn ensure_dir(p: &std::path::Path) {
    if let Err(e) = std::fs::create_dir_all(p) {
        eprintln!("ce-hub: mkdir {} failed: {e}", p.display());
    }
}

/// Persist a single app file to disk plus the app's version marker (best-effort).
fn persist_app_file(st: &Shared, id: &str, key: &str, bytes: &[u8], version: u64) {
    let base = st.data_dir.join("apps").join(id);
    let path = base.join(key);
    if let Some(parent) = path.parent() {
        ensure_dir(parent);
    }
    if let Err(e) = std::fs::write(&path, bytes) {
        eprintln!("ce-hub: write app file {} failed: {e}", path.display());
    }
    let vpath = base.join(".version");
    if let Err(e) = std::fs::write(&vpath, version.to_string()) {
        eprintln!("ce-hub: write {} failed: {e}", vpath.display());
    }
}

/// Persist an app's config marker (<data>/apps/<id>/.config), best-effort.
fn persist_app_config(st: &Shared, id: &str, spa: bool) {
    let base = st.data_dir.join("apps").join(id);
    ensure_dir(&base);
    let path = base.join(".config");
    match serde_json::to_vec(&json!({ "spa": spa })) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                eprintln!("ce-hub: write {} failed: {e}", path.display());
            }
        }
        Err(e) => eprintln!("ce-hub: serialize app config {id} failed: {e}"),
    }
}

/// Persist an app's signed owner id to <data>/apps/<id>/.owner (best-effort). No-op if empty.
fn persist_app_owner(st: &Shared, id: &str) {
    let owner = match st.apps.lock().unwrap().get(id) {
        Some(a) if !a.owner.is_empty() => a.owner.clone(),
        _ => return,
    };
    let base = st.data_dir.join("apps").join(id);
    ensure_dir(&base);
    let path = base.join(".owner");
    if let Err(e) = std::fs::write(&path, owner) {
        eprintln!("ce-hub: write {} failed: {e}", path.display());
    }
}

/// Load the slug registry from <data>/slugs.json: { slug: SlugEntry }.
fn load_slugs(data_dir: &std::path::Path) -> HashMap<String, SlugEntry> {
    let path = data_dir.join("slugs.json");
    let raw = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_slice::<HashMap<String, SlugEntry>>(&raw) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("ce-hub: parse {} failed: {e}", path.display());
            HashMap::new()
        }
    }
}

/// Save the slug registry to <data>/slugs.json (best-effort, full rewrite).
fn save_slugs(st: &Shared) {
    ensure_dir(&st.data_dir);
    let path = st.data_dir.join("slugs.json");
    let snapshot: HashMap<String, SlugEntry> = st.slugs.lock().unwrap().clone();
    match serde_json::to_vec(&snapshot) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                eprintln!("ce-hub: write {} failed: {e}", path.display());
            }
        }
        Err(e) => eprintln!("ce-hub: serialize slugs.json failed: {e}"),
    }
}

/// Load the projects registry from <data>/projects.json: { id: ProjectEntry }.
fn load_projects(data_dir: &std::path::Path) -> HashMap<String, ProjectEntry> {
    let path = data_dir.join("projects.json");
    let raw = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_slice::<HashMap<String, ProjectEntry>>(&raw) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("ce-hub: parse {} failed: {e}", path.display());
            HashMap::new()
        }
    }
}

/// Save the projects registry to <data>/projects.json (best-effort, full rewrite).
fn save_projects(st: &Shared) {
    ensure_dir(&st.data_dir);
    let path = st.data_dir.join("projects.json");
    let snapshot: HashMap<String, ProjectEntry> = st.projects.lock().unwrap().clone();
    match serde_json::to_vec(&snapshot) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                eprintln!("ce-hub: write {} failed: {e}", path.display());
            }
        }
        Err(e) => eprintln!("ce-hub: serialize projects.json failed: {e}"),
    }
}

/// Load the custom-domain registry from <data>/domains.json: { hostname: app_id }.
fn load_domains(data_dir: &std::path::Path) -> HashMap<String, String> {
    let path = data_dir.join("domains.json");
    let raw = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_slice::<HashMap<String, String>>(&raw) {
        Ok(m) => m.into_iter().map(|(k, v)| (norm_host(&k), v)).collect(),
        Err(e) => {
            eprintln!("ce-hub: parse {} failed: {e}", path.display());
            HashMap::new()
        }
    }
}

/// Save the custom-domain registry to <data>/domains.json (best-effort, full rewrite).
fn save_domains(st: &Shared) {
    ensure_dir(&st.data_dir);
    let path = st.data_dir.join("domains.json");
    let snapshot: HashMap<String, String> = st.domains.lock().unwrap().clone();
    match serde_json::to_vec(&snapshot) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                eprintln!("ce-hub: write {} failed: {e}", path.display());
            }
        }
        Err(e) => eprintln!("ce-hub: serialize domains.json failed: {e}"),
    }
}

/// Load all hosted apps from <data>/apps/<id>/** on startup.
fn load_apps(data_dir: &std::path::Path) -> HashMap<String, HostedApp> {
    let mut out = HashMap::new();
    let root = data_dir.join("apps");
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return out, // no apps yet
    };
    for e in entries.flatten() {
        let app_dir = e.path();
        if !app_dir.is_dir() {
            continue;
        }
        let Some(id) = app_dir.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()) else { continue };
        let mut app = new_hosted_app();
        let mut files = Vec::new();
        collect_files(&app_dir, &app_dir, &mut files);
        for (rel, bytes) in files {
            if rel == ".version" {
                if let Ok(s) = String::from_utf8(bytes.clone()) {
                    if let Ok(v) = s.trim().parse::<u64>() {
                        app.version = v;
                    }
                }
                continue;
            }
            if rel == ".config" {
                // { "spa": bool } — app-level config persisted alongside files.
                if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(spa) = v.get("spa").and_then(|s| s.as_bool()) {
                        app.spa = spa;
                    }
                }
                continue;
            }
            if rel == ".owner" {
                // The signed owner id (sha256(pubkey)[..16] hex) recorded on first signed write.
                if let Ok(s) = String::from_utf8(bytes.clone()) {
                    app.owner = s.trim().to_string();
                }
                continue;
            }
            app.bytes += bytes.len() as u64;
            let ct = mime_for(&rel).to_string();
            app.files.insert(rel, AppFile { bytes, ct });
        }
        if app.version == 0 && !app.files.is_empty() {
            app.version = 1;
        }
        out.insert(id, app);
    }
    out
}

/// Recursively collect files under `dir` as (relative-slash-path, bytes), relative to `base`.
fn collect_files(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, Vec<u8>)>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_files(base, &p, out);
        } else if let Ok(bytes) = std::fs::read(&p) {
            if let Ok(rel) = p.strip_prefix(base) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.push((rel, bytes));
            }
        }
    }
}

/// Load one db namespace from disk. Stored as { key: { value, seq } }.
fn load_db(data_dir: &std::path::Path) -> HashMap<String, HashMap<String, DbEntry>> {
    let mut out = HashMap::new();
    let root = data_dir.join("db");
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(app) = p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()) else { continue };
        let raw = match std::fs::read(&p) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("ce-hub: read {} failed: {e}", p.display());
                continue;
            }
        };
        let parsed: Value = match serde_json::from_slice(&raw) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("ce-hub: parse {} failed: {e}", p.display());
                continue;
            }
        };
        let mut tbl = HashMap::new();
        if let Some(obj) = parsed.as_object() {
            for (k, v) in obj {
                let value = v.get("value").cloned().unwrap_or(Value::Null);
                let seq = v.get("seq").and_then(|s| s.as_u64()).unwrap_or(0);
                tbl.insert(k.clone(), DbEntry { value, seq });
            }
        }
        out.insert(app, tbl);
    }
    out
}

/// Save one db namespace to <data>/db/<app>.json (best-effort, full rewrite).
fn save_db(st: &Shared, app: &str) {
    let dir = st.data_dir.join("db");
    ensure_dir(&dir);
    let snapshot: serde_json::Map<String, Value> = {
        let db = st.db.lock().unwrap();
        match db.get(app) {
            Some(tbl) => tbl
                .iter()
                .map(|(k, e)| (k.clone(), json!({ "value": e.value, "seq": e.seq })))
                .collect(),
            None => serde_json::Map::new(),
        }
    };
    let path = dir.join(format!("{app}.json"));
    match serde_json::to_vec(&Value::Object(snapshot)) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                eprintln!("ce-hub: write {} failed: {e}", path.display());
            }
        }
        Err(e) => eprintln!("ce-hub: serialize db {app} failed: {e}"),
    }
}

/// Load persistent node reliability records from <data>/nodes.json.
fn load_records(data_dir: &std::path::Path) -> HashMap<String, NodeRecord> {
    let path = data_dir.join("nodes.json");
    let raw = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_slice::<HashMap<String, NodeRecord>>(&raw) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("ce-hub: parse {} failed: {e}", path.display());
            HashMap::new()
        }
    }
}

/// Save node reliability records to <data>/nodes.json (best-effort, full rewrite).
fn save_records(st: &Shared) {
    ensure_dir(&st.data_dir);
    let path = st.data_dir.join("nodes.json");
    let snapshot: HashMap<String, NodeRecord> = st.records.lock().unwrap().clone();
    match serde_json::to_vec(&snapshot) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                eprintln!("ce-hub: write {} failed: {e}", path.display());
            }
        }
        Err(e) => eprintln!("ce-hub: serialize nodes.json failed: {e}"),
    }
}

/// Load durable lifetime counters from <data>/counters.json (best-effort; zeros if absent).
fn load_counters(data_dir: &std::path::Path) -> Counters {
    let path = data_dir.join("counters.json");
    let raw = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Counters::default(),
    };
    match serde_json::from_slice::<Counters>(&raw) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("ce-hub: parse {} failed: {e}", path.display());
            Counters::default()
        }
    }
}

/// Save durable lifetime counters to <data>/counters.json (best-effort, full rewrite).
fn save_counters(st: &Shared) {
    ensure_dir(&st.data_dir);
    let path = st.data_dir.join("counters.json");
    let snapshot: Counters = st.counters.lock().unwrap().clone();
    match serde_json::to_vec(&snapshot) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                eprintln!("ce-hub: write {} failed: {e}", path.display());
            }
        }
        Err(e) => eprintln!("ce-hub: serialize counters.json failed: {e}"),
    }
}

/// Heuristic device class from caps, per the contract.
fn device_class(caps: &Caps) -> &'static str {
    let platform = caps.platform.to_ascii_lowercase();
    let phone_re = platform.contains("iphone")
        || platform.contains("ipad")
        || platform.contains("android")
        || platform.contains("mobile");
    if phone_re {
        return "phone";
    }
    let server = (platform.contains("linux") || platform.contains("x86_64") || platform.contains("server"))
        && !caps.webgpu
        && caps.cores >= 8;
    if server {
        return "server";
    }
    if platform.contains("mac") || platform.contains("win") || platform.contains("linux") {
        return "laptop";
    }
    "device"
}

/// Uptime percent for a node: total online / wall-clock observed window, clamped 0..100.
fn uptime_pct(rec: &NodeRecord, extra_secs: u64) -> u64 {
    let now = unix_now();
    let window = now.saturating_sub(rec.first_seen_unix).max(1);
    let online = rec.total_online_secs + extra_secs;
    let pct = (online as f64 / window as f64 * 100.0).round() as i64;
    pct.clamp(0, 100) as u64
}

// ---- stats ----

fn snapshot(st: &Shared) -> Value {
    // Current storage usage (apps + db + blobs). Computed before locking nodes so this never holds
    // two of these locks at once — keeps lock order simple and the value visible alongside limits.
    let data_used = app_bytes_total(&st.apps.lock().unwrap())
        + db_bytes_total(&st.db.lock().unwrap())
        + st.blob_bytes.load(Ordering::Relaxed);
    let nodes = st.nodes.lock().unwrap();
    let live: Vec<&NodeEntry> = nodes.values().filter(|n| n.last_seen.elapsed() < STALE).collect();
    let cores: u64 = live.iter().map(|n| n.caps.cores as u64).sum();
    let ram: f64 = live.iter().map(|n| n.caps.ram_gb).sum();
    let storage: f64 = live.iter().map(|n| n.caps.storage_gb).sum();
    let mut gpus: HashMap<String, u32> = HashMap::new();
    for n in &live {
        if !n.caps.gpu.is_empty() {
            *gpus.entry(n.caps.gpu.clone()).or_insert(0) += 1;
        }
    }
    let gpu_list: Vec<Value> = {
        let mut v: Vec<_> = gpus.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        v.into_iter().map(|(name, count)| json!({"name": name, "count": count})).collect()
    };
    let gpu_count = live.iter().filter(|n| !n.caps.gpu.is_empty() || n.caps.webgpu).count();
    let vram_mb: u64 = live.iter().map(|n| n.caps.vram_mb).sum();
    let cpu_mark: f64 = live.iter().map(|n| n.caps.cpu_mark).sum();
    // Blended display perf score: measured CPU throughput (Mops/s) + a GPU-memory weight.
    let perf_score = cpu_mark + (vram_mb as f64) / 64.0;

    // Reliability aggregates over live nodes: avg uptime, per-class counts, most reliable node.
    let records = st.records.lock().unwrap();
    let mut by_class = HashMap::from([("phone", 0u64), ("laptop", 0u64), ("server", 0u64), ("device", 0u64)]);
    let mut uptimes: Vec<(String, u64)> = Vec::new();
    for (id, n) in nodes.iter().filter(|(_, n)| n.last_seen.elapsed() < STALE) {
        *by_class.entry(device_class(&n.caps)).or_insert(0) += 1;
        let rec = records.get(id).cloned().unwrap_or_default();
        let online_secs = n.session_start.elapsed().map(|d| d.as_secs()).unwrap_or(0);
        uptimes.push((id.clone(), uptime_pct(&rec, online_secs)));
    }
    let avg_uptime_pct: u64 = if uptimes.is_empty() {
        0
    } else {
        (uptimes.iter().map(|(_, p)| *p).sum::<u64>() as f64 / uptimes.len() as f64).round() as u64
    };
    let most_reliable = uptimes
        .iter()
        .max_by_key(|(_, p)| *p)
        .map(|(id, p)| json!({ "short": &id[..id.len().min(10)], "uptime_pct": p }))
        .unwrap_or(Value::Null);
    drop(records);

    // Latency aggregates: p50 / p95 RTT over live nodes that have answered at least one ping.
    let mut rtts: Vec<f64> = live.iter().map(|n| n.rtt_ms).filter(|r| *r > 0.0).collect();
    rtts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| -> f64 {
        if rtts.is_empty() {
            return 0.0;
        }
        let i = ((rtts.len() as f64 - 1.0) * p).round() as usize;
        (rtts[i.min(rtts.len() - 1)] * 10.0).round() / 10.0
    };
    let latency_p50_ms = pct(0.50);
    let latency_p95_ms = pct(0.95);
    let measured = rtts.len();

    // Hosting/replication aggregates: number of hosted apps and total live replica placements
    // (replica node ids that are still connected, summed across all apps).
    let live_ids: std::collections::HashSet<&String> = nodes
        .iter()
        .filter(|(_, n)| n.last_seen.elapsed() < STALE)
        .map(|(id, _)| id)
        .collect();
    let (hosted_apps, replicas, owned_apps) = {
        let apps = st.apps.lock().unwrap();
        let hosted = apps.len();
        let reps: usize = apps
            .values()
            .map(|a| a.replicas.iter().filter(|nid| live_ids.contains(nid)).count())
            .sum();
        let owned = apps.values().filter(|a| !a.owner.is_empty()).count();
        (hosted, reps, owned)
    };
    // Durable counters + live abuse-detector counts for the global metrics snapshot.
    let (durable_tasks, compute_ms) = {
        let c = st.counters.lock().unwrap();
        (c.tasks_run, c.compute_distributed_ms)
    };
    let flagged_count = st.flags.lock().unwrap().len() as u64;
    let flagged_total = st.flagged_total.load(Ordering::Relaxed);

    // Registry sizes (slugs + public/total projects) for the dashboard.
    let slug_count = st.slugs.lock().unwrap().len();
    let (project_count, public_projects) = {
        let p = st.projects.lock().unwrap();
        (p.len(), p.values().filter(|e| e.public).count())
    };

    json!({
        "nodes": live.len(),
        "cores": cores,
        "ram_gb": (ram * 10.0).round() / 10.0,
        "storage_gb": (storage * 10.0).round() / 10.0,
        "gpus": gpu_list,
        "gpu_count": gpu_count,
        "gpu_vram_gb": (vram_mb as f64 / 1024.0 * 10.0).round() / 10.0,
        "webgpu_nodes": live.iter().filter(|n| n.caps.webgpu).count(),
        "perf_score": (perf_score * 10.0).round() / 10.0,
        // Durable lifetime counters (survive restart) per the shared contract.
        "tasks_run": durable_tasks,
        "compute_distributed_ms": compute_ms,
        "flagged_count": flagged_count,
        "flagged_total": flagged_total,
        // In-process task count since the hub last started (kept for backward compatibility).
        "session_tasks": st.total_tasks.load(Ordering::Relaxed),
        "blobs": st.blobs.lock().unwrap().len(),
        "blob_bytes": st.blob_bytes.load(Ordering::Relaxed),
        "avg_uptime_pct": avg_uptime_pct,
        "by_class": {
            "phone": by_class.get("phone").copied().unwrap_or(0),
            "laptop": by_class.get("laptop").copied().unwrap_or(0),
            "server": by_class.get("server").copied().unwrap_or(0),
            "device": by_class.get("device").copied().unwrap_or(0),
        },
        "most_reliable": most_reliable,
        "latency_p50_ms": latency_p50_ms,
        "latency_p95_ms": latency_p95_ms,
        "latency_measured": measured,
        "data_used_bytes": data_used,
        "limits": {
            "max_data_bytes": st.limits.max_data_bytes,
            "max_apps": st.limits.max_apps,
            "max_domains": st.limits.max_domains,
            "max_db_namespaces": st.limits.max_db_namespaces,
            "owner_app_bytes": st.owner_limits.owner_app_bytes,
            "owner_trust_max": st.owner_limits.owner_trust_max,
            "owner_slug_cap": st.owner_limits.owner_slug_cap,
            "owned_apps": owned_apps,
        },
        "hosted_apps": hosted_apps,
        "replicas": replicas,
        "owned_apps": owned_apps,
        "slugs": slug_count,
        "projects": project_count,
        "public_projects": public_projects,
    })
}

async fn stats_json(State(st): State<Shared>) -> impl IntoResponse {
    Json(snapshot(&st))
}

async fn nodes_json(State(st): State<Shared>) -> impl IntoResponse {
    let nodes = st.nodes.lock().unwrap();
    let records = st.records.lock().unwrap();
    let list: Vec<Value> = nodes
        .iter()
        .filter(|(_, n)| n.last_seen.elapsed() < STALE)
        .map(|(id, n)| {
            let rec = records.get(id).cloned().unwrap_or_default();
            let online_secs = n.session_start.elapsed().map(|d| d.as_secs()).unwrap_or(0);
            json!({
                "id": id, "short": &id[..id.len().min(10)],
                "cores": n.caps.cores, "ram_gb": n.caps.ram_gb, "storage_gb": n.caps.storage_gb,
                "gpu": n.caps.gpu, "webgpu": n.caps.webgpu, "platform": n.caps.platform,
                "tasks_run": n.tasks_run, "age_s": n.last_seen.elapsed().as_secs(),
                "rtt_ms": (n.rtt_ms * 10.0).round() / 10.0,
                "uptime_pct": uptime_pct(&rec, online_secs),
                "device_class": device_class(&n.caps),
                "online_secs": online_secs,
                "sessions": rec.sessions,
                "first_seen_unix": rec.first_seen_unix,
            })
        })
        .collect();
    Json(json!({ "nodes": list }))
}

async fn stats_stream(State(st): State<Shared>) -> impl IntoResponse {
    let stream = futures_util::stream::unfold(st, |st| async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let ev = Event::default().data(snapshot(&st).to_string());
        Some((Ok::<Event, std::convert::Infallible>(ev), st))
    });
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal in-memory AppState for detector tests. Uses a temp-ish data dir under the
    /// system temp directory; persistence calls in these tests are best-effort and harmless.
    fn test_state() -> Shared {
        let data_dir =
            std::env::temp_dir().join(format!("ce-hub-test-{}-{}", std::process::id(), unix_millis()));
        Arc::new(AppState {
            nodes: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            modules: HashMap::new(),
            total_tasks: AtomicU64::new(0),
            job_seq: AtomicU64::new(0),
            blobs: Mutex::new(HashMap::new()),
            blob_order: Mutex::new(VecDeque::new()),
            blob_bytes: AtomicU64::new(0),
            data_dir,
            apps: Mutex::new(HashMap::new()),
            db: Mutex::new(HashMap::new()),
            db_seq: AtomicU64::new(1),
            rooms: Mutex::new(HashMap::new()),
            records: Mutex::new(HashMap::new()),
            domains: Mutex::new(HashMap::new()),
            limits: Limits::from_env(),
            nonces: Mutex::new(HashMap::new()),
            slugs: Mutex::new(HashMap::new()),
            projects: Mutex::new(HashMap::new()),
            pinned_blobs: Mutex::new(std::collections::HashSet::new()),
            debug: Mutex::new(HashMap::new()),
            rate: Mutex::new(HashMap::new()),
            slug_rate: Mutex::new(HashMap::new()),
            owner_limits: OwnerLimits::from_env(),
            admin_token: String::new(),
            room_cap: 256,
            room_history: 50,
            ratelimit_ns: std::collections::HashSet::new(),
            counters: Mutex::new(Counters::default()),
            detect: Mutex::new(DetectState::default()),
            flags: Mutex::new(VecDeque::new()),
            flag_throttle: Mutex::new(HashMap::new()),
            flagged_total: AtomicU64::new(0),
            // Point ce-watch at a closed port: the fire-and-forget push fails silently (best-effort).
            watch_url: "http://127.0.0.1:1".into(),
            watch_token: String::new(),
        })
    }

    /// 16 identical tasks from one ip trip H2 with a human-readable reason; a sub-threshold (15)
    /// load from a different ip does not.
    #[tokio::test]
    async fn h2_repeat_signature_trips_at_sixteen() {
        let st = test_state();
        let func = "count_primes";
        let sig = "deadbeefdeadbeef"; // fixed (func, args|code) signature for the run
        let trip_ip = "10.0.0.1";

        // 16 identical submissions from the same ip → H2 must fire (> H2_IDENTICAL_MAX = 15).
        for _ in 0..16 {
            detect_submit(&st, trip_ip, func, sig, None, "node-a");
        }
        let flags = st.flags.lock().unwrap();
        let h2 = flags.iter().find(|f| f.heuristic == "H2" && f.ip == trip_ip);
        assert!(h2.is_some(), "16 identical tasks from one ip must raise an H2 flag");
        let h2 = h2.unwrap();
        assert!(!h2.reason.is_empty(), "H2 flag must carry a human-readable reason");
        assert!(
            h2.reason.contains("count_primes"),
            "H2 reason should name the repeated function, got: {}",
            h2.reason
        );
        drop(flags);

        // A different ip with only 15 identical submissions stays under the H2 threshold.
        let quiet_ip = "10.0.0.2";
        for _ in 0..15 {
            detect_submit(&st, quiet_ip, func, sig, None, "node-b");
        }
        let flags = st.flags.lock().unwrap();
        assert!(
            !flags.iter().any(|f| f.heuristic == "H2" && f.ip == quiet_ip),
            "a sub-threshold (15) load must not raise H2"
        );
    }

    /// A valid Ed25519 node-hello verifies; a tampered signature is rejected.
    #[test]
    fn node_hello_signature_roundtrip() {
        use ed25519_dalek::{Signer as _, SigningKey};
        let mut seed = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut seed);
        let sk = SigningKey::from_bytes(&seed);
        let vk = sk.verifying_key();
        let id_hex = hex::encode(vk.to_bytes());
        let nonce = [7u8; 32];
        let sig = sk.sign(&nonce);
        let sig_hex = hex::encode(sig.to_bytes());
        assert!(verify_node_hello(&id_hex, &sig_hex, &nonce).is_ok());
        // Wrong nonce → rejected.
        assert!(verify_node_hello(&id_hex, &sig_hex, &[8u8; 32]).is_err());
    }

    /// Durable compute_distributed_ms folds in reported ms and survives a save/load round trip.
    #[test]
    fn counters_persist_round_trip() {
        let st = test_state();
        {
            let mut c = st.counters.lock().unwrap();
            c.tasks_run = 42;
            c.compute_distributed_ms = 123456;
        }
        save_counters(&st);
        let reloaded = load_counters(&st.data_dir);
        assert_eq!(reloaded.tasks_run, 42);
        assert_eq!(reloaded.compute_distributed_ms, 123456);
        let _ = std::fs::remove_dir_all(&st.data_dir);
    }
}
