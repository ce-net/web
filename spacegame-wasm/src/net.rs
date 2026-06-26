//! Mesh transport — the client talks to a CE node ONLY through this page's own origin: the same-origin
//! `/ce` reverse proxy in front of a node (the proxy authorizes writes with the node's api.token), or a
//! browser-injected node. It uses the exact wire `spacegame::wire` defines: subscribe/publish on
//! sector topics, an SSE push stream for snapshots, payloads carried as `payload_hex` JSON.
//!
//! No remote origin is ever contacted — the page CSP `connect-src 'self'` enforces it.

use js_sys::{Object, Reflect, Uint8Array};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request, RequestInit, Response};

use spacegame::wire::Snapshot;

/// A decoded inbound mesh message routed by topic.
pub struct Inbound {
    pub topic: String,
    pub snapshot: Snapshot,
}

/// The node transport. Cheap to clone (shared inbound queue).
#[derive(Clone)]
pub struct Net {
    base: String,
    /// Snapshots decoded off the SSE stream, drained by the game loop each frame.
    pub inbox: Rc<RefCell<VecDeque<Inbound>>>,
    pub connected: Rc<RefCell<bool>>,
}

fn window() -> web_sys::Window {
    web_sys::window().expect("no window")
}

async fn fetch(method: &str, url: &str, body: Option<&str>) -> Result<Response, JsValue> {
    let opts = RequestInit::new();
    opts.set_method(method);
    if let Some(b) = body {
        opts.set_body(&JsValue::from_str(b));
    }
    let req = Request::new_with_str_and_init(url, &opts)?;
    if body.is_some() {
        req.headers().set("content-type", "application/json")?;
    }
    let resp = JsFuture::from(window().fetch_with_request(&req)).await?;
    resp.dyn_into::<Response>()
}

/// Hex-encode the UTF-8 JSON of a serializable client message (matches the node's `payload_hex`).
pub fn encode_hex<T: serde::Serialize>(v: &T) -> String {
    let bytes = serde_json::to_vec(v).unwrap_or_default();
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn decode_hex(h: &str) -> Vec<u8> {
    let h = h.trim();
    let mut out = Vec::with_capacity(h.len() / 2);
    let bytes = h.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16);
        let lo = (bytes[i + 1] as char).to_digit(16);
        match (hi, lo) {
            (Some(a), Some(b)) => out.push((a * 16 + b) as u8),
            _ => break,
        }
        i += 2;
    }
    out
}

impl Net {
    pub fn new(base: &str) -> Self {
        Net {
            base: base.trim_end_matches('/').to_string(),
            inbox: Rc::new(RefCell::new(VecDeque::new())),
            connected: Rc::new(RefCell::new(false)),
        }
    }

    /// Resolve this node's authenticated NodeId — our unspoofable player id.
    pub async fn node_id(&self) -> Result<String, JsValue> {
        let resp = fetch("GET", &format!("{}/status", self.base), None).await?;
        let json = JsFuture::from(resp.json()?).await?;
        let id = Reflect::get(&json, &JsValue::from_str("node_id"))?
            .as_string()
            .ok_or_else(|| JsValue::from_str("status has no node_id"))?;
        *self.connected.borrow_mut() = true;
        Ok(id)
    }

    pub async fn subscribe(&self, topic: &str) -> Result<(), JsValue> {
        let body = format!("{{\"topic\":{}}}", serde_json::to_string(topic).unwrap());
        fetch("POST", &format!("{}/mesh/subscribe", self.base), Some(&body)).await?;
        Ok(())
    }

    /// Publish a hex-encoded payload on a topic (an input/build/weapon/command message).
    pub async fn publish_hex(&self, topic: &str, payload_hex: &str) -> Result<(), JsValue> {
        let body = format!(
            "{{\"topic\":{},\"payload_hex\":{}}}",
            serde_json::to_string(topic).unwrap(),
            serde_json::to_string(payload_hex).unwrap()
        );
        fetch("POST", &format!("{}/mesh/publish", self.base), Some(&body)).await?;
        Ok(())
    }

    /// Open the node's SSE push stream and decode `Snapshot`s into the inbox until it ends. Reconnects
    /// are driven by the caller (it re-invokes this with backoff on return/error).
    pub async fn run_inbox(&self) -> Result<(), JsValue> {
        let resp = fetch("GET", &format!("{}/mesh/messages/stream", self.base), None).await?;
        let body = resp.body().ok_or_else(|| JsValue::from_str("no stream body"))?;
        let reader = body
            .get_reader()
            .dyn_into::<web_sys::ReadableStreamDefaultReader>()?;

        let mut buf: Vec<u8> = Vec::new();
        loop {
            let result = JsFuture::from(reader.read()).await?;
            let done = Reflect::get(&result, &JsValue::from_str("done"))?
                .as_bool()
                .unwrap_or(false);
            if done {
                break;
            }
            let value = Reflect::get(&result, &JsValue::from_str("value"))?;
            let chunk = Uint8Array::new(&value).to_vec();
            buf.extend_from_slice(&chunk);

            // Split complete SSE frames on the blank-line delimiter.
            while let Some(pos) = find_frame_end(&buf) {
                let frame = buf.drain(..pos + 2).collect::<Vec<u8>>();
                let text = String::from_utf8_lossy(&frame[..frame.len() - 2]);
                if let Some(msg) = parse_frame(&text) {
                    self.inbox.borrow_mut().push_back(msg);
                }
            }
        }
        *self.connected.borrow_mut() = false;
        Ok(())
    }
}

/// Position of the end of the first complete SSE frame (`\n\n`).
fn find_frame_end(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

/// Parse one SSE frame (its `data:` lines) into a routed snapshot, if it is one.
fn parse_frame(text: &str) -> Option<Inbound> {
    let data: String = text
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(|l| l.trim_start())
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() {
        return None;
    }
    // The node delivers {topic, payload_hex, from, ...}; we only consume sector /state snapshots.
    let v: serde_json::Value = serde_json::from_str(&data).ok()?;
    let topic = v.get("topic")?.as_str()?.to_string();
    let ph = v.get("payload_hex")?.as_str()?;
    let bytes = decode_hex(ph);
    let snapshot: Snapshot = serde_json::from_slice(&bytes).ok()?;
    Some(Inbound { topic, snapshot })
}

/// The same-origin transport base. A browser-injected node may expose itself; otherwise the `/ce`
/// reverse proxy in front of a CE node (the proxy authorizes writes with the node's api.token).
pub fn detect_base() -> String {
    // If a host page set `window.__ceBase`, honour it; else default to the same-origin proxy.
    if let Some(w) = web_sys::window() {
        if let Ok(v) = Reflect::get(&w, &JsValue::from_str("__ceBase")) {
            if let Some(s) = v.as_string() {
                if !s.is_empty() {
                    return s;
                }
            }
        }
    }
    "/ce".to_string()
}

/// Bare helper so `Object` import is used even when reflection paths change (keeps the module honest).
#[allow(dead_code)]
fn _obj() -> Object {
    Object::new()
}
