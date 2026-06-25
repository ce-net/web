//! The cache host: `ce-cache serve`. Serves cache hits to authorized peers and accepts entry
//! publications, so one fleet member's build warms every member's cache.
//!
//! It polls the local node's mesh inbox for `cache/*` requests, authorizes each against a signed
//! `ce-cap` chain (rooted at this host's own key or a configured org root — the rdev/ce-pin
//! `serve()` pattern, verbatim), and acts:
//!   - `cache/has` -> report whether we have a CID mapped for a key (`cache:read`);
//!   - `cache/get` -> return the CID for a key (the reader fetches + CID-verifies it itself)
//!     (`cache:read`);
//!   - `cache/put` -> fetch the object via `get_object` (CID-verified, trustless), record the
//!     `key -> CID` mapping, and advertise it (`cache:write`).
//!
//! "Holding" is logical: the node's content-addressed blob store already persists the chunks
//! `get_object` pulled; the host records which keys it serves in its index file and re-fetches on
//! demand. The MVP does not garbage-collect blobs; a real host would.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use ce_cap::{SignedCapability, authorize, decode_chain};
use ce_rs::CeClient;

use crate::index::Index;
use crate::proto::*;

/// Run the cache host loop until the process is killed. `roots` are accepted capability root NodeIds
/// (32-byte); a chain rooted at one of them (or at this host's own key) authorizes actions.
pub async fn serve(client: &CeClient, roots: Vec<[u8; 32]>, index_path: PathBuf) -> Result<()> {
    let host_hex = client.status().await?.node_id;
    let host_id: [u8; 32] = hex::decode(&host_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| anyhow!("node returned a malformed node id"))?;

    // Advertise on the DHT that we are a cache host so clients can discover us.
    if let Err(e) = client.advertise_service(SERVICE_HOST).await {
        tracing::warn!(error = %e, "could not advertise cache:host service (continuing)");
    }

    let mut index = Index::load(&index_path)?;
    tracing::info!(
        host = %&host_hex[..16.min(host_hex.len())],
        roots = roots.len(),
        entries = index.len(),
        "ce-cache host serving (cache/has, cache/get, cache/put)"
    );

    let mut seen: HashSet<u64> = HashSet::new();
    let mut revoked: HashSet<([u8; 32], u64)> = HashSet::new();
    let mut tick: u32 = 0;

    loop {
        // Refresh the on-chain revoked set and re-advertise periodically (provider records expire).
        if tick % 20 == 0 {
            if let Ok(pairs) = client.revoked().await {
                revoked = pairs
                    .into_iter()
                    .filter_map(|(issuer, nonce)| {
                        hex::decode(&issuer)
                            .ok()
                            .and_then(|b| <[u8; 32]>::try_from(b).ok())
                            .map(|i| (i, nonce))
                    })
                    .collect();
            }
            let _ = client.advertise_service(SERVICE_HOST).await;
            for key in index.entries.keys() {
                let _ = client.advertise_service(&service_for_key(key)).await;
            }
        }
        tick = tick.wrapping_add(1);

        for m in client.messages().await.unwrap_or_default() {
            let Some(token) = m.reply_token else { continue };
            if !m.topic.starts_with(TOPIC_PREFIX) || !seen.insert(token) {
                continue;
            }
            let reply = handle(
                client, &m.topic, &m.from, &m.payload_hex, &host_id, &roots, &revoked, &mut index,
                &index_path,
            )
            .await;
            if let Err(e) = client.reply(token, &reply).await {
                tracing::warn!(error = %e, "failed to send mesh reply");
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Authorize, dispatch, and serialize a reply. Any error becomes a typed negative reply so the
/// requester always gets a structured answer instead of a timeout.
#[allow(clippy::too_many_arguments)]
async fn handle(
    client: &CeClient,
    topic: &str,
    from_hex: &str,
    payload_hex: &str,
    host_id: &[u8; 32],
    roots: &[[u8; 32]],
    revoked: &HashSet<([u8; 32], u64)>,
    index: &mut Index,
    index_path: &Path,
) -> Vec<u8> {
    let action = topic.strip_prefix(TOPIC_PREFIX).unwrap_or(topic);
    match handle_inner(client, action, from_hex, payload_hex, host_id, roots, revoked, index, index_path)
        .await
    {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::debug!(action, error = %e, "request denied/failed");
            serde_json::to_vec(&serde_json::json!({
                "hit": false, "accepted": false, "reason": e.to_string()
            }))
            .unwrap_or_default()
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_inner(
    client: &CeClient,
    action: &str,
    from_hex: &str,
    payload_hex: &str,
    host_id: &[u8; 32],
    roots: &[[u8; 32]],
    revoked: &HashSet<([u8; 32], u64)>,
    index: &mut Index,
    index_path: &Path,
) -> Result<Vec<u8>> {
    let payload = hex::decode(payload_hex).context("payload hex")?;
    let from: [u8; 32] = hex::decode(from_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| anyhow!("bad sender id"))?;

    // Every request shares a `caps` field; the ability required is action-specific.
    let ability = match action {
        "has" | "get" => ABILITY_READ,
        "put" => ABILITY_WRITE,
        other => return Err(anyhow!("unknown cache action '{other}'")),
    };
    let caps = caps_of(&payload)?;

    let chain: Vec<SignedCapability> = decode_chain(&caps).map_err(|_| anyhow!("bad capability"))?;
    let is_revoked = |issuer: &[u8; 32], nonce: u64| revoked.contains(&(*issuer, nonce));
    authorize(host_id, roots, &[], now(), &from, ability, &chain, &is_revoked)
        .map_err(|e| anyhow!("denied: {e}"))?;

    match action {
        "has" => {
            let req: HasReq = serde_json::from_slice(&payload)?;
            let resp = match index.get(&req.key) {
                Some(e) => HasResp { hit: true, cid: Some(e.cid.clone()), size: e.size },
                None => HasResp::default(),
            };
            Ok(serde_json::to_vec(&resp)?)
        }
        "get" => {
            let req: GetReq = serde_json::from_slice(&payload)?;
            let resp = match index.get(&req.key) {
                Some(e) => GetResp { cid: Some(e.cid.clone()), size: e.size, reason: None },
                None => GetResp { cid: None, size: 0, reason: Some("miss".into()) },
            };
            Ok(serde_json::to_vec(&resp)?)
        }
        "put" => {
            let req: PutReq = serde_json::from_slice(&payload)?;
            let resp = do_put(client, &req, index, index_path).await;
            Ok(serde_json::to_vec(&resp)?)
        }
        _ => unreachable!("action validated above"),
    }
}

/// Accept a published entry: fetch the object (CID-verified by `get_object`) so we can serve it,
/// then record the `key -> CID` mapping and advertise it on the DHT.
async fn do_put(client: &CeClient, req: &PutReq, index: &mut Index, index_path: &Path) -> PutResp {
    match client.get_object(&req.cid).await {
        Ok(bytes) => {
            index.put(&req.key, &req.cid, bytes.len() as u64);
            if let Err(e) = index.save(index_path) {
                tracing::warn!(error = %e, "could not persist cache index");
            }
            let _ = client.advertise_service(&service_for_key(&req.key)).await;
            tracing::info!(key = %req.key, cid = %req.cid, bytes = bytes.len(), "accepted cache entry");
            PutResp { accepted: true, stored_bytes: bytes.len() as u64, reason: None }
        }
        Err(e) => PutResp {
            accepted: false,
            stored_bytes: 0,
            reason: Some(format!("fetch failed: {e}")),
        },
    }
}

/// Pull just the `caps` field out of a request payload (all `cache/*` requests share it) so the host
/// can authorize before fully deserializing the action-specific body.
fn caps_of(payload: &[u8]) -> Result<String> {
    #[derive(serde::Deserialize)]
    struct HasCaps {
        caps: String,
    }
    let hc: HasCaps = serde_json::from_slice(payload).context("payload missing caps")?;
    Ok(hc.caps)
}

/// Current unix time in seconds.
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
