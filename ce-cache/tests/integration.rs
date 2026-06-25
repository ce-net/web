//! Integration tests for ce-cache.
//!
//! Two layers:
//!  1. **Capability authorization** — the exact `ce-cap` checks the cache host performs: a
//!     `cache:write` chain authorizes a `put`, a `cache:read` chain does not (attenuation is
//!     enforced), and a chain rooted at a stranger is denied. (No node needed.)
//!  2. **put/get/has against a mock node** — a tiny in-process HTTP server implements the blob
//!     subset of the CE node API (`GET /status`, `POST /blobs`, `GET /blobs/:hash`) so the real
//!     `ce-rs` client drives the real `ce_cache::store` put/get/has + key->CID mapping end-to-end,
//!     including the content-addressed round trip for both a file and a directory artifact.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::{
    Router,
    body::Bytes,
    extract::{Path as AxPath, State},
    http::StatusCode,
    routing::{get, post},
};
use ce_cache::index::Index;
use ce_cache::store::{self, HitSource};
use ce_cap::{Caveats, Resource, SignedCapability, authorize, decode_chain, encode_chain};
use ce_identity::Identity;
use ce_rs::CeClient;

// ---------- capability tests (no node) ----------

fn identity(tag: &str) -> Identity {
    let dir = std::env::temp_dir().join(format!("ce-cache-it-{tag}-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    Identity::load_or_generate(&dir).expect("identity")
}

fn never_revoked(_issuer: &[u8; 32], _nonce: u64) -> bool {
    false
}

#[test]
fn host_authorizes_self_issued_cache_write() {
    let host = identity("host-w");
    let writer = identity("writer-w");
    let cap = SignedCapability::issue(
        &host,
        writer.node_id(),
        vec![ce_cache::proto::ABILITY_WRITE.to_string()],
        Resource::Any,
        Caveats::default(),
        1,
        None,
    );
    let token = encode_chain(&[cap]);
    let decoded = decode_chain(&token).expect("decode");
    let res = authorize(
        &host.node_id(),
        &[],
        &[],
        0,
        &writer.node_id(),
        ce_cache::proto::ABILITY_WRITE,
        &decoded,
        &never_revoked,
    );
    assert!(res.is_ok(), "self-issued cache:write must authorize a put: {res:?}");
}

#[test]
fn read_cap_does_not_authorize_write() {
    let host = identity("host-r");
    let reader = identity("reader-r");
    let cap = SignedCapability::issue(
        &host,
        reader.node_id(),
        vec![ce_cache::proto::ABILITY_READ.to_string()],
        Resource::Any,
        Caveats::default(),
        2,
        None,
    );
    // A cache:read cap must not grant cache:write — abilities are not interchangeable.
    let res = authorize(
        &host.node_id(),
        &[],
        &[],
        0,
        &reader.node_id(),
        ce_cache::proto::ABILITY_WRITE,
        &[cap],
        &never_revoked,
    );
    assert!(res.is_err(), "a cache:read cap must not grant cache:write");
}

#[test]
fn unrooted_chain_is_denied() {
    let host = identity("host-s");
    let stranger = identity("stranger-s");
    let writer = identity("writer-s");
    let cap = SignedCapability::issue(
        &stranger,
        writer.node_id(),
        vec![ce_cache::proto::ABILITY_WRITE.to_string()],
        Resource::Any,
        Caveats::default(),
        3,
        None,
    );
    let res = authorize(
        &host.node_id(),
        &[], // no accepted roots
        &[],
        0,
        &writer.node_id(),
        ce_cache::proto::ABILITY_WRITE,
        &[cap],
        &never_revoked,
    );
    assert!(res.is_err(), "a chain rooted at a stranger must be denied");
}

// ---------- put/get/has against a mock node ----------

/// A minimal stand-in for the CE node: an in-memory content-addressed blob store plus `/status`,
/// matching what `ce-rs`'s `put_blob`/`get_blob`/`put_object`/`get_object`/`status` expect.
type Blobs = Arc<Mutex<HashMap<String, Vec<u8>>>>;

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

async fn put_blob(State(blobs): State<Blobs>, body: Bytes) -> axum::Json<serde_json::Value> {
    let hash = sha256_hex(&body);
    blobs.lock().unwrap().insert(hash.clone(), body.to_vec());
    axum::Json(serde_json::json!({ "hash": hash }))
}

async fn get_blob(State(blobs): State<Blobs>, AxPath(hash): AxPath<String>) -> (StatusCode, Bytes) {
    match blobs.lock().unwrap().get(&hash) {
        Some(b) => (StatusCode::OK, Bytes::from(b.clone())),
        None => (StatusCode::NOT_FOUND, Bytes::new()),
    }
}

async fn status() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "node_id": "00".repeat(32),
        "height": 1u64,
        "difficulty": 0u8,
        "balance": "0",
    }))
}

/// Spawn the mock node on an ephemeral port and return its base URL.
async fn spawn_mock_node() -> String {
    let blobs: Blobs = Arc::new(Mutex::new(HashMap::new()));
    let app = Router::new()
        .route("/status", get(status))
        .route("/blobs", post(put_blob))
        .route("/blobs/:hash", get(get_blob))
        .with_state(blobs);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn put_get_has_file_roundtrip_over_mock_node() {
    let base = spawn_mock_node().await;
    let client = CeClient::with_token(base, None);

    let dir = std::env::temp_dir().join(format!("ce-cache-it-file-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("out.o");
    std::fs::write(&src, b"compiled object file bytes").unwrap();

    let mut idx = Index::default();
    let key = "rust/abc123/out.o";

    // has -> miss before put
    assert!(!store::has(&client, &idx, key, "").await.unwrap());

    // put: archive + upload + map key->CID
    let entry = store::put_path(&client, &mut idx, key, &src).await.unwrap();
    assert!(!entry.cid.is_empty());
    assert!(idx.has(key), "index must record key->CID after put");

    // has -> hit after put (local index)
    assert!(store::has(&client, &idx, key, "").await.unwrap());

    // get: resolve + CID-verified fetch + restore
    let dest = dir.join("restored.o");
    let source = store::get_to_path(&client, &idx, key, "", &dest).await.unwrap();
    assert_eq!(source, HitSource::Local);
    assert_eq!(std::fs::read(&dest).unwrap(), b"compiled object file bytes");

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn put_get_directory_artifact_roundtrip() {
    let base = spawn_mock_node().await;
    let client = CeClient::with_token(base, None);

    let dir = std::env::temp_dir().join(format!("ce-cache-it-dir-{}", std::process::id()));
    let tree = dir.join("build-out");
    std::fs::create_dir_all(tree.join("bin")).unwrap();
    std::fs::write(tree.join("bin/app"), b"binary").unwrap();
    std::fs::write(tree.join("manifest.txt"), b"meta").unwrap();

    let mut idx = Index::default();
    let key = "bazel/deadbeef";
    let entry = store::put_path(&client, &mut idx, key, &tree).await.unwrap();
    assert!(entry.size > 0);

    let restored = dir.join("restored");
    let source = store::get_to_path(&client, &idx, key, "", &restored).await.unwrap();
    assert_eq!(source, HitSource::Local);
    assert_eq!(std::fs::read(restored.join("bin/app")).unwrap(), b"binary");
    assert_eq!(std::fs::read(restored.join("manifest.txt")).unwrap(), b"meta");

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn get_rejects_missing_key() {
    let base = spawn_mock_node().await;
    let client = CeClient::with_token(base, None);
    let idx = Index::default();
    let dest = std::env::temp_dir().join("ce-cache-it-nope");
    let res = store::get_to_path(&client, &idx, "no-such-key", "", &dest).await;
    assert!(res.is_err(), "a cache miss must surface as an error, not a silent empty file");
}
