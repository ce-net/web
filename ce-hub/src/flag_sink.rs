//! Flag sink — where abuse [`FlagEvent`](crate::FlagEvent)s go after the detector raises them.
//!
//! The hub no longer POSTs flags to ce-watch over localhost HTTP with a shared `x-ce-watch-token`.
//! Instead each flag is a directed **mesh** message: the hub drives its co-located `ce` node via
//! `ce-rs` and calls [`CeClient::send_message`](ce_rs::CeClient::send_message) to ce-watch's NodeId
//! on topic [`FLAG_TOPIC`]. ce-watch authenticates the sender by the Noise-verified libp2p NodeId
//! (`msg.from`), so there is no shared secret — the verified sender identity IS the authorization.
//!
//! The sink is an injectable trait so [`crate::raise_flag`] can be unit-tested without a live node:
//! [`MeshFlagSink`] is the production path; tests use a recording sink to assert what was emitted.

use std::sync::Arc;

/// The topic every flag is published on. ce-watch filters its mesh inbox on this exact string and
/// admits only messages from the hub's NodeId.
pub const FLAG_TOPIC: &str = "ce-watch/flag";

/// Default ce node API base URL when `CE_NODE_URL` is unset — the co-located local node.
pub const DEFAULT_CE_NODE_URL: &str = "http://127.0.0.1:8844";

/// Where a raised flag is delivered. Implementations MUST be non-blocking and best-effort: a flag
/// delivery error must never bubble back into the task-dispatch path that raised it.
pub trait FlagSink: Send + Sync {
    /// Deliver one flag, already serialized to its JSON payload bytes. Fire-and-forget.
    fn send(&self, payload: Vec<u8>);
}

/// Production sink: pushes each flag to ce-watch over the CE mesh via the co-located `ce` node.
///
/// Holds a `ce-rs` client pointed at the local node and ce-watch's NodeId. `send` spawns a directed
/// `send_message(watch_node, FLAG_TOPIC, payload)` and returns immediately; any transport error is
/// logged and dropped (the detector never blocks on it). If `watch_node` is empty the flag is
/// dropped (we have no authorized recipient to address).
pub struct MeshFlagSink {
    ce: Arc<ce_rs::CeClient>,
    watch_node: String,
}

impl MeshFlagSink {
    /// Build a sink that sends to `watch_node` (ce-watch's NodeId hex) via the node at `node_url`.
    pub fn new(node_url: impl Into<String>, watch_node: String) -> Self {
        Self { ce: Arc::new(ce_rs::CeClient::new(node_url.into())), watch_node }
    }
}

impl FlagSink for MeshFlagSink {
    fn send(&self, payload: Vec<u8>) {
        if self.watch_node.is_empty() {
            tracing::debug!("flag dropped: CE_HUB_WATCH_NODE unset (no ce-watch NodeId to address)");
            return;
        }
        let ce = self.ce.clone();
        let watch = self.watch_node.clone();
        tokio::spawn(async move {
            if let Err(e) = ce.send_message(&watch, FLAG_TOPIC, &payload).await {
                tracing::warn!(error = %e, to = %watch, "mesh flag push to ce-watch failed");
            }
        });
    }
}

/// A sink that drops every flag — used when no ce-watch NodeId is configured AND no local node is
/// available, so the detector still runs (ringing/logging flags) without a mesh edge.
pub struct NullSink;
impl FlagSink for NullSink {
    fn send(&self, _payload: Vec<u8>) {}
}

/// Resolve the ce node API base URL from `CE_NODE_URL`, falling back to [`DEFAULT_CE_NODE_URL`].
pub fn ce_node_url() -> String {
    std::env::var("CE_NODE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_CE_NODE_URL.to_string())
}

/// Resolve ce-watch's NodeId for flag delivery.
///
/// Prefers the explicit `CE_HUB_WATCH_NODE` env (a 64-hex NodeId). If unset, tries the DHT via
/// `find_service("ce-watch")` against the local node and takes the first provider. Returns an empty
/// string if neither yields a NodeId (the sink then drops flags until one is configured).
pub async fn resolve_watch_node(ce: &ce_rs::CeClient) -> String {
    if let Ok(n) = std::env::var("CE_HUB_WATCH_NODE") {
        if !n.is_empty() {
            return n;
        }
    }
    match ce.find_service("ce-watch").await {
        Ok(providers) => providers.into_iter().next().unwrap_or_default(),
        Err(e) => {
            tracing::warn!(error = %e, "find_service(ce-watch) failed; no ce-watch NodeId resolved");
            String::new()
        }
    }
}

/// A recording sink (test-only): captures every payload it is asked to send, so a test can assert
/// exactly what `raise_flag` emitted (the FlagEvent JSON) without a live node. Lives at module scope
/// so the binary's own test module (`crate::flag_sink::RecordingSink`) can reuse it.
#[cfg(test)]
pub struct RecordingSink {
    pub sent: std::sync::Mutex<Vec<Vec<u8>>>,
}
#[cfg(test)]
impl RecordingSink {
    pub fn new() -> Self {
        Self { sent: std::sync::Mutex::new(Vec::new()) }
    }
}
#[cfg(test)]
impl FlagSink for RecordingSink {
    fn send(&self, payload: Vec<u8>) {
        self.sent.lock().unwrap().push(payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_sink_captures_payload() {
        let s = RecordingSink::new();
        s.send(b"hello".to_vec());
        let sent = s.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0], b"hello");
    }

    #[test]
    fn mesh_sink_with_empty_node_drops_without_panicking() {
        // No tokio runtime needed: empty watch_node short-circuits before any spawn.
        let s = MeshFlagSink::new(DEFAULT_CE_NODE_URL, String::new());
        s.send(b"payload".to_vec()); // must not panic / must not spawn
    }
}
