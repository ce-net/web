//! The localhost HTTP shim: a drop-in remote cache that existing build tools speak to unmodified.
//!
//! The sidecar implements the subset of two established wire protocols that a remote cache needs,
//! and maps every entry onto CE blobs (content-addressed, CID-verified):
//!
//!  - **Bazel Remote Cache HTTP** — the CAS (content-addressed store) and AC (action cache) REST
//!    surface Bazel uses with `build --remote_cache=http://localhost:9092`:
//!      - `GET  /cas/<hash>`  -> fetch a CAS blob (the build output bytes)
//!      - `PUT  /cas/<hash>`  -> store a CAS blob
//!      - `GET  /ac/<hash>`   -> fetch an Action Cache entry (the action result proto/metadata)
//!      - `PUT  /ac/<hash>`   -> store an Action Cache entry
//!  - **sccache WebDAV** — `SCCACHE_WEBDAV_ENDPOINT=http://localhost:9092` makes sccache do
//!    `GET`/`PUT`/`HEAD` on arbitrary paths; we treat the path as the cache key.
//!
//! ### Protocol -> CE mapping
//! For each protocol the request's `<hash>`/path is the **cache key** (the build tool already
//! content-hashed its inputs; we do not recompute). On `PUT` we `put_object(body)` to get a CE
//! object CID and record `key -> CID` in the index (and announce it on the DHT). On `GET` we resolve
//! `key -> CID` (local index, then mesh) and `get_object(cid)` — which re-verifies every chunk
//! against the CID, so a peer cannot return poisoned bytes. `HEAD` is a `has` check.
//!
//! Bazel and sccache key spaces are namespaced (`cas/`, `ac/`, `dav/`) so they never collide in the
//! shared index.

use std::sync::Arc;

use anyhow::Result;
use axum::{
    Router,
    body::Bytes,
    extract::{Path as AxPath, State},
    http::StatusCode,
    routing::get,
};
use ce_rs::CeClient;
use tokio::sync::Mutex;

use crate::index::Index;
use crate::store;

/// Shared sidecar state: the CE client, the persisted index (behind a mutex for the concurrent HTTP
/// handlers), the index path, and the capability chain to present to mesh peers on miss-fetches.
#[derive(Clone)]
pub struct Sidecar {
    client: Arc<CeClient>,
    index: Arc<Mutex<Index>>,
    index_path: Arc<std::path::PathBuf>,
    caps: Arc<String>,
}

impl Sidecar {
    /// Build sidecar state from an existing CE client and on-disk index.
    pub fn new(client: CeClient, index_path: std::path::PathBuf, caps: String) -> Result<Self> {
        let index = Index::load(&index_path)?;
        Ok(Self {
            client: Arc::new(client),
            index: Arc::new(Mutex::new(index)),
            index_path: Arc::new(index_path),
            caps: Arc::new(caps),
        })
    }

    /// The axum router exposing the Bazel CAS/AC + sccache WebDAV surface.
    pub fn router(self) -> Router {
        Router::new()
            // Bazel Remote Cache HTTP: CAS (content store) and AC (action cache).
            .route("/cas/:hash", get(get_cas).put(put_cas))
            .route("/ac/:hash", get(get_ac).put(put_ac))
            // sccache (and any WebDAV-style) clients: arbitrary path is the key.
            .route("/dav/*path", get(get_dav).put(put_dav))
            // A liveness root so a tool can probe the sidecar is up.
            .route("/", get(|| async { "ce-cache sidecar" }))
            .with_state(self)
    }

    /// Serve the sidecar on `addr` (e.g. `127.0.0.1:9092`) until the process is killed.
    pub async fn serve(self, addr: std::net::SocketAddr) -> Result<()> {
        let listener = tokio::net::TcpListener::bind(addr).await?;
        tracing::info!(%addr, "ce-cache sidecar listening (Bazel CAS/AC + sccache WebDAV)");
        axum::serve(listener, self.router()).await?;
        Ok(())
    }

    /// Core PUT: store body under a namespaced key, return the CID.
    async fn put_keyed(&self, key: &str, body: &[u8]) -> Result<String> {
        let mut idx = self.index.lock().await;
        let entry = store::put_bytes(&self.client, &mut idx, key, body).await?;
        idx.save(&self.index_path)?;
        Ok(entry.cid)
    }

    /// Core GET: resolve and fetch the bytes for a namespaced key (local index, then mesh).
    async fn get_keyed(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let idx = self.index.lock().await.clone();
        match store::get_bytes(&self.client, &idx, key, &self.caps).await {
            Ok((bytes, _src)) => Ok(Some(bytes)),
            Err(_) => Ok(None),
        }
    }
}

/// Namespace keys per protocol so the Bazel CAS, Bazel AC, and WebDAV spaces never collide.
fn cas_key(hash: &str) -> String {
    format!("cas/{hash}")
}
fn ac_key(hash: &str) -> String {
    format!("ac/{hash}")
}
fn dav_key(path: &str) -> String {
    format!("dav/{}", path.trim_start_matches('/'))
}

// ---- Bazel CAS ----

async fn get_cas(State(s): State<Sidecar>, AxPath(hash): AxPath<String>) -> (StatusCode, Bytes) {
    fetch(&s, &cas_key(&hash)).await
}
async fn put_cas(
    State(s): State<Sidecar>,
    AxPath(hash): AxPath<String>,
    body: Bytes,
) -> StatusCode {
    store_entry(&s, &cas_key(&hash), &body).await
}

// ---- Bazel Action Cache ----

async fn get_ac(State(s): State<Sidecar>, AxPath(hash): AxPath<String>) -> (StatusCode, Bytes) {
    fetch(&s, &ac_key(&hash)).await
}
async fn put_ac(State(s): State<Sidecar>, AxPath(hash): AxPath<String>, body: Bytes) -> StatusCode {
    store_entry(&s, &ac_key(&hash), &body).await
}

// ---- sccache / WebDAV ----

async fn get_dav(State(s): State<Sidecar>, AxPath(path): AxPath<String>) -> (StatusCode, Bytes) {
    fetch(&s, &dav_key(&path)).await
}
async fn put_dav(State(s): State<Sidecar>, AxPath(path): AxPath<String>, body: Bytes) -> StatusCode {
    store_entry(&s, &dav_key(&path), &body).await
}

/// Shared GET handler: a hit returns 200 + bytes, a miss returns 404.
async fn fetch(s: &Sidecar, key: &str) -> (StatusCode, Bytes) {
    match s.get_keyed(key).await {
        Ok(Some(bytes)) => (StatusCode::OK, Bytes::from(bytes)),
        Ok(None) => (StatusCode::NOT_FOUND, Bytes::new()),
        Err(e) => {
            tracing::warn!(key, error = %e, "sidecar get failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Bytes::new())
        }
    }
}

/// Shared PUT handler: store and return 201 Created (or 500 on failure).
async fn store_entry(s: &Sidecar, key: &str, body: &[u8]) -> StatusCode {
    match s.put_keyed(key, body).await {
        Ok(cid) => {
            tracing::debug!(key, cid, bytes = body.len(), "sidecar stored entry");
            StatusCode::CREATED
        }
        Err(e) => {
            tracing::warn!(key, error = %e, "sidecar put failed");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_namespaced_per_protocol() {
        // The same hash in different protocol spaces must not collide.
        assert_ne!(cas_key("abc"), ac_key("abc"));
        assert_ne!(cas_key("abc"), dav_key("abc"));
        assert_eq!(cas_key("abc"), "cas/abc");
        assert_eq!(ac_key("abc"), "ac/abc");
    }

    #[test]
    fn dav_key_trims_leading_slash() {
        assert_eq!(dav_key("/foo/bar"), "dav/foo/bar");
        assert_eq!(dav_key("foo/bar"), "dav/foo/bar");
    }
}
