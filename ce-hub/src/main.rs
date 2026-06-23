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

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
}

/// One namespaced KV entry in the CE database (value + insertion order for newest-first lists).
#[derive(Clone)]
struct DbEntry {
    value: Value,
    seq: u64,
}

/// A realtime room: a broadcast channel plus a ring buffer of recent messages for late joiners.
struct Room {
    tx: broadcast::Sender<RoomMsg>,
    history: VecDeque<String>,
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
}
type Shared = Arc<AppState>;

const STALE: Duration = Duration::from_secs(35);
const MAX_BLOB: usize = 16 * 1024 * 1024; // 16 MB per object
const MAX_BLOB_TOTAL: u64 = 256 * 1024 * 1024; // 256 MB store cap (FIFO eviction)
const MAX_APP_FILE: usize = 16 * 1024 * 1024; // 16 MB per app file
const MAX_APP_FILES: usize = 200; // ~200 files per app
const MAX_APP_BYTES: u64 = 64 * 1024 * 1024; // 64 MB total per app
const MAX_DB_KEYS: usize = 5000; // per-app key cap (evict oldest on overflow)
const ROOM_HISTORY: usize = 50; // buffered messages replayed to late joiners
const ROOM_CAP: usize = 256; // broadcast channel capacity per room

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
    let port: u16 = std::env::var("CE_HUB_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8970);
    let modules = load_modules();
    eprintln!("ce-hub: loaded {} builtin module(s): {:?}", modules.len(), modules.keys().collect::<Vec<_>>());

    let data_dir = PathBuf::from(std::env::var("CE_HUB_DATA").unwrap_or_else(|_| "./data".into()));
    let apps = load_apps(&data_dir);
    let db = load_db(&data_dir);
    let records = load_records(&data_dir);
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
    });

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

    let cors = tower_http::cors::CorsLayer::permissive();
    let app = Router::new()
        .route("/", get(|| async { "ce-hub ok" }))
        .route("/node", get(node_ws))
        .route("/tasks", post(submit_task))
        .route("/stats", get(stats_json))
        .route("/stats/stream", get(stats_stream))
        .route("/nodes", get(nodes_json))
        .route("/blobs/:hash", put(put_blob).get(get_blob))
        // --- app hosting (multi-file static sites + SPAs) ---
        .route("/apps/:id/__reload", get(app_reload))
        .route("/apps/:id", get(get_app_root).put(put_app_root))
        .route("/apps/:id/", get(get_app_root))
        .route("/apps/:id/*path", get(get_app_path).put(put_app_path))
        // --- CE database (persistent KV, namespaced per app) ---
        .route("/db/:app", get(db_list))
        .route("/db/:app/:key", get(db_get).put(db_put).delete(db_del))
        // --- realtime rooms (pub/sub over websocket) ---
        .route("/rt/:app/:room", get(rt_ws))
        .layer(DefaultBodyLimit::max(MAX_BLOB))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    eprintln!("ce-hub listening on http://{addr}");
    axum::serve(listener, app).await.unwrap();
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

async fn node_ws(ws: WebSocketUpgrade, State(st): State<Shared>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_node(socket, st))
}

async fn handle_node(socket: WebSocket, st: Shared) {
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
                let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if id.is_empty() {
                    continue;
                }
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
                if let Some(sender) = st.pending.lock().unwrap().remove(&jid) {
                    let _ = sender.send(res);
                }
                st.total_tasks.fetch_add(1, Ordering::Relaxed);
                if let Some(id) = &node_id {
                    if let Some(n) = st.nodes.lock().unwrap().get_mut(id) {
                        n.tasks_run += 1;
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

async fn submit_task(State(st): State<Shared>, Json(req): Json<TaskReq>) -> impl IntoResponse {
    let lang = req.lang.as_deref().unwrap_or("wasm");

    // Build the job payload for the chosen language.
    let mut job = json!({ "t": "job" });
    let func: String;
    if lang == "js" {
        let Some(code) = req.code.clone() else {
            return (StatusCode::BAD_REQUEST, Json(json!({"error":"js task requires `code`"}))).into_response();
        };
        func = req.func.clone().unwrap_or_else(|| "task".into());
        job["lang"] = json!("js");
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

    let (otx, orx) = oneshot::channel::<JobResult>();
    st.pending.lock().unwrap().insert(jid.clone(), otx);

    job["jid"] = json!(jid);
    if tx.send(job.to_string()).is_err() {
        st.pending.lock().unwrap().remove(&jid);
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"node went away"}))).into_response();
    }

    match tokio::time::timeout(Duration::from_secs(30), orx).await {
        Ok(Ok(res)) => Json(json!({
            "node": node_id, "lang": lang, "func": func, "args": req.args,
            "ok": res.ok, "value": res.value, "ms": res.ms, "error": res.error,
        })).into_response(),
        _ => {
            st.pending.lock().unwrap().remove(&jid);
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
    {
        let mut blobs = st.blobs.lock().unwrap();
        let mut order = st.blob_order.lock().unwrap();
        if !blobs.contains_key(&hash) {
            order.push_back(hash.clone());
            st.blob_bytes.fetch_add(size as u64, Ordering::Relaxed);
        }
        blobs.insert(hash.clone(), Blob { ct, bytes: body.to_vec() });
        while st.blob_bytes.load(Ordering::Relaxed) > MAX_BLOB_TOTAL {
            match order.pop_front() {
                Some(old) => {
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
    store_app_file(&st, &id, "", &headers, body).await
}

async fn put_app_path(
    Path((id, path)): Path<(String, String)>,
    headers: HeaderMap,
    State(st): State<Shared>,
    body: Bytes,
) -> impl IntoResponse {
    store_app_file(&st, &id, &path, &headers, body).await
}

async fn store_app_file(st: &Shared, id: &str, raw_path: &str, headers: &HeaderMap, body: Bytes) -> axum::response::Response {
    if body.len() > MAX_APP_FILE {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({"error":"file too large (16 MB max)"}))).into_response();
    }
    if id.is_empty() || id.contains('/') {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad app id"}))).into_response();
    }
    let Some(key) = norm_app_path(raw_path) else {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"bad path"}))).into_response();
    };
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| mime_for(&key).to_string());

    let version = {
        let mut apps = st.apps.lock().unwrap();
        let app = apps.entry(id.to_string()).or_insert_with(new_hosted_app);
        let new_size = body.len() as u64;
        let prev = app.files.get(&key).map(|f| f.bytes.len() as u64).unwrap_or(0);
        // enforce per-app caps (file count + total bytes); reject overflow on genuinely new files.
        if !app.files.contains_key(&key) && app.files.len() >= MAX_APP_FILES {
            return (StatusCode::INSUFFICIENT_STORAGE, Json(json!({"error":"too many files for app (200 max)"}))).into_response();
        }
        if app.bytes.saturating_sub(prev) + new_size > MAX_APP_BYTES {
            return (StatusCode::INSUFFICIENT_STORAGE, Json(json!({"error":"app size cap exceeded (64 MB max)"}))).into_response();
        }
        app.bytes = app.bytes.saturating_sub(prev) + new_size;
        app.files.insert(key.clone(), AppFile { bytes: body.to_vec(), ct });
        app.version += 1;
        let v = app.version;
        let _ = app.reload.send(v);
        v
    };
    persist_app_file(st, id, &key, &body, version);
    Json(json!({ "id": id, "path": key, "version": version, "url": format!("/apps/{id}/") })).into_response()
}

fn new_hosted_app() -> HostedApp {
    let (tx, _rx) = broadcast::channel::<u64>(16);
    HostedApp { files: HashMap::new(), version: 0, bytes: 0, reload: tx }
}

async fn get_app_root(Path(id): Path<String>, State(st): State<Shared>) -> impl IntoResponse {
    serve_app_file(&st, &id, "index.html")
}

async fn get_app_path(Path((id, path)): Path<(String, String)>, State(st): State<Shared>) -> impl IntoResponse {
    let key = norm_app_path(&path).unwrap_or_else(|| "index.html".to_string());
    serve_app_file(&st, &id, &key)
}

fn serve_app_file(st: &Shared, id: &str, key: &str) -> axum::response::Response {
    let apps = st.apps.lock().unwrap();
    let Some(app) = apps.get(id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"app not found"}))).into_response();
    };
    let Some(file) = app.files.get(key) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"file not found"}))).into_response();
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

// ---- CE database (persistent KV, namespaced per app) ----

async fn db_put(
    Path((app, key)): Path<(String, String)>,
    State(st): State<Shared>,
    Json(value): Json<Value>,
) -> impl IntoResponse {
    {
        let mut db = st.db.lock().unwrap();
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

async fn db_get(Path((app, key)): Path<(String, String)>, State(st): State<Shared>) -> impl IntoResponse {
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

async fn rt_ws(Path((app, room)): Path<(String, String)>, ws: WebSocketUpgrade, State(st): State<Shared>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_room(socket, st, app, room))
}

/// A broadcast message tagged with the originating client's id, so each client can filter out
/// its own frames and deliver only to ALL OTHER clients in the room.
#[derive(Clone)]
struct RoomMsg {
    from: u64,
    text: String,
}

static ROOM_CLIENT_SEQ: AtomicU64 = AtomicU64::new(1);

async fn handle_room(socket: WebSocket, st: Shared, app: String, room: String) {
    let key = (app, room);
    let me = ROOM_CLIENT_SEQ.fetch_add(1, Ordering::Relaxed);
    // Get/create the room: subscribe for live traffic and snapshot recent history.
    let (tx, mut rx, history) = {
        let mut rooms = st.rooms.lock().unwrap();
        let r = rooms.entry(key.clone()).or_insert_with(|| Room {
            tx: broadcast::channel::<RoomMsg>(ROOM_CAP).0,
            history: VecDeque::new(),
        });
        (r.tx.clone(), r.tx.subscribe(), r.history.iter().cloned().collect::<Vec<_>>())
    };

    let (mut sink, mut stream) = socket.split();

    // Replay buffered history before live traffic.
    for msg in history {
        if sink.send(Message::Text(msg)).await.is_err() {
            return;
        }
    }

    // Forward live broadcasts from OTHER clients to this client.
    let pump = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(m) => {
                    if m.from == me {
                        continue; // do not echo our own frames back
                    }
                    if sink.send(Message::Text(m.text)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Read client frames: broadcast each TEXT frame to all OTHER clients + buffer in history.
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                {
                    let mut rooms = st.rooms.lock().unwrap();
                    if let Some(r) = rooms.get_mut(&key) {
                        r.history.push_back(t.clone());
                        while r.history.len() > ROOM_HISTORY {
                            r.history.pop_front();
                        }
                    }
                }
                let _ = tx.send(RoomMsg { from: me, text: t });
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

// ---- on-disk persistence (CE_HUB_DATA) ----
//
// Best-effort JSON files via serde_json + std::fs. Never panic on bad/missing files: log to stderr
// and continue. Layout:
//   <data>/apps/<id>/<path>        raw app file bytes (mirrors the served tree)
//   <data>/apps/<id>/.version      the app's version counter
//   <data>/db/<app>.json           { key: { value, seq } } for one db namespace
//   <data>/nodes.json              { node_id: NodeRecord } reliability records

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
        "tasks_run": st.total_tasks.load(Ordering::Relaxed),
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
