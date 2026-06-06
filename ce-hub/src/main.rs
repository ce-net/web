//! ce-hub — rendezvous for in-browser CE compute nodes.
//!
//! Browser nodes open a WebSocket to `/node`, announce their device capacity, and run WASM jobs
//! pushed to them. Anyone can `POST /tasks` to dispatch a job to a live node and get the result.
//! `/stats/stream` (SSE) feeds the live dashboard: mesh size + aggregate CPU/RAM/storage/GPU.
//!
//! This is the relay's browser-facing surface. It speaks a small JSON protocol over WS today; the
//! same wire model is what a libp2p-WSS transport would carry once browser nodes become first-class
//! mesh peers. Runs beside the `ce` node (separate port), never touching it.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

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
}

struct NodeEntry {
    caps: Caps,
    last_seen: Instant,
    tasks_run: u64,
    tx: mpsc::UnboundedSender<String>,
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

struct AppState {
    nodes: Mutex<HashMap<String, NodeEntry>>,
    pending: Mutex<HashMap<String, oneshot::Sender<JobResult>>>,
    modules: HashMap<String, String>, // builtin name -> base64 wasm
    total_tasks: AtomicU64,
    job_seq: AtomicU64,
}
type Shared = Arc<AppState>;

const STALE: Duration = Duration::from_secs(35);

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("CE_HUB_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8970);
    let modules = load_modules();
    eprintln!("ce-hub: loaded {} builtin module(s): {:?}", modules.len(), modules.keys().collect::<Vec<_>>());

    let state: Shared = Arc::new(AppState {
        nodes: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        modules,
        total_tasks: AtomicU64::new(0),
        job_seq: AtomicU64::new(0),
    });

    // prune stale nodes periodically
    {
        let st = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                st.nodes.lock().unwrap().retain(|_, n| n.last_seen.elapsed() < STALE);
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
                st.nodes.lock().unwrap().insert(
                    id.clone(),
                    NodeEntry { caps, last_seen: Instant::now(), tasks_run: 0, tx: tx.clone() },
                );
                node_id = Some(id.clone());
                let _ = tx.send(json!({"t":"welcome","id":id}).to_string());
            }
            "hb" => {
                if let Some(id) = &node_id {
                    if let Some(n) = st.nodes.lock().unwrap().get_mut(id) {
                        n.last_seen = Instant::now();
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
        st.nodes.lock().unwrap().remove(&id);
    }
    pump.abort();
}

// ---- push a task ----

#[derive(Deserialize)]
struct TaskReq {
    /// builtin module name (e.g. "demo") or a raw base64 wasm module.
    #[serde(default)]
    module: Option<String>,
    func: String,
    #[serde(default)]
    args: Vec<i64>,
    #[serde(default)]
    ret: Option<String>,
    /// optionally target a specific node id.
    #[serde(default)]
    target: Option<String>,
}

async fn submit_task(State(st): State<Shared>, Json(req): Json<TaskReq>) -> impl IntoResponse {
    // resolve module → base64
    let key = req.module.clone().unwrap_or_else(|| "demo".into());
    let module_b64 = if let Some(b64) = st.modules.get(&key) {
        b64.clone()
    } else if key.len() > 64 {
        key.clone() // treat as raw base64 wasm
    } else {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"error": format!("unknown module '{key}'")}))).into_response();
    };

    // pick a node (target, else the least-loaded one) and grab its sender
    let (jid, node_id, tx) = {
        let nodes = st.nodes.lock().unwrap();
        if nodes.is_empty() {
            return (axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"no browser nodes connected"}))).into_response();
        }
        let chosen = match &req.target {
            Some(t) if nodes.contains_key(t) => t.clone(),
            Some(t) => return (axum::http::StatusCode::NOT_FOUND, Json(json!({"error": format!("node {t} not connected")}))).into_response(),
            None => nodes.iter().min_by_key(|(_, n)| n.tasks_run).map(|(k, _)| k.clone()).unwrap(),
        };
        let jid = format!("j{}", st.job_seq.fetch_add(1, Ordering::Relaxed));
        let tx = nodes.get(&chosen).unwrap().tx.clone();
        (jid, chosen, tx)
    };

    let (otx, orx) = oneshot::channel::<JobResult>();
    st.pending.lock().unwrap().insert(jid.clone(), otx);

    let job = json!({
        "t": "job", "jid": jid, "module_b64": module_b64,
        "func": req.func, "args": req.args, "ret": req.ret.clone().unwrap_or_else(|| "i32".into()),
    });
    if tx.send(job.to_string()).is_err() {
        st.pending.lock().unwrap().remove(&jid);
        return (axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"node went away"}))).into_response();
    }

    match tokio::time::timeout(Duration::from_secs(30), orx).await {
        Ok(Ok(res)) => Json(json!({
            "node": node_id, "func": req.func, "args": req.args,
            "ok": res.ok, "value": res.value, "ms": res.ms, "error": res.error,
        })).into_response(),
        _ => {
            st.pending.lock().unwrap().remove(&jid);
            (axum::http::StatusCode::GATEWAY_TIMEOUT, Json(json!({"error":"node did not return in time"}))).into_response()
        }
    }
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
    json!({
        "nodes": live.len(),
        "cores": cores,
        "ram_gb": (ram * 10.0).round() / 10.0,
        "storage_gb": (storage * 10.0).round() / 10.0,
        "gpus": gpu_list,
        "webgpu_nodes": live.iter().filter(|n| n.caps.webgpu).count(),
        "tasks_run": st.total_tasks.load(Ordering::Relaxed),
    })
}

async fn stats_json(State(st): State<Shared>) -> impl IntoResponse {
    Json(snapshot(&st))
}

async fn nodes_json(State(st): State<Shared>) -> impl IntoResponse {
    let nodes = st.nodes.lock().unwrap();
    let list: Vec<Value> = nodes
        .iter()
        .filter(|(_, n)| n.last_seen.elapsed() < STALE)
        .map(|(id, n)| {
            json!({
                "id": id, "short": &id[..id.len().min(10)],
                "cores": n.caps.cores, "ram_gb": n.caps.ram_gb, "storage_gb": n.caps.storage_gb,
                "gpu": n.caps.gpu, "webgpu": n.caps.webgpu, "platform": n.caps.platform,
                "tasks_run": n.tasks_run, "age_s": n.last_seen.elapsed().as_secs(),
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
