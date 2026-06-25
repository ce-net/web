//! High-level cache operations: put / get / has, over the local index and the CE mesh.
//!
//! This is the layer the CLI and the HTTP shim call. Each operation does the obvious thing:
//!  - **put**: archive the artifact, upload it to the CE data layer (`put_object` -> CID), record
//!    `key -> CID` in the local index, and announce availability on the DHT so peers can find it.
//!  - **has**: a hit if the local index knows the key, else ask the mesh (`cache/has`) whether any
//!    peer holds it.
//!  - **get**: resolve `key -> CID` (local index first, then mesh `cache/get`), fetch the object via
//!    `get_object` (which re-verifies every chunk against the CID — trustless / poison-proof), and,
//!    when restoring, unpack it.
//!
//! Money note: rent is carried as **base-unit decimal strings** (never floats); the MVP runs free
//! within a cap-gated fleet, with the rent field plumbed through for when channels are wired.

use anyhow::{Context, Result, anyhow};
use ce_rs::CeClient;

use crate::archive;
use crate::index::{Entry, Index};
use crate::proto::*;

/// Per-request mesh timeouts (ms). A `put`/`get` may trigger a full object fetch on the remote host.
const PUT_TIMEOUT_MS: u64 = 120_000;
const GET_TIMEOUT_MS: u64 = 30_000;
const HAS_TIMEOUT_MS: u64 = 15_000;

/// Outcome of a `get`: where the bytes came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HitSource {
    /// The key was resolved from the local index.
    Local,
    /// The key was resolved from a remote cache host over the mesh.
    Mesh(String),
    /// No mapping was found anywhere.
    Miss,
}

/// Store a packed artifact's bytes in the CE data layer and record `key -> CID` locally.
/// Returns the resulting [`Entry`]. The bytes are content-addressed by `put_object`, so the CID is
/// the integrity proof for every later fetch.
pub async fn put_bytes(client: &CeClient, idx: &mut Index, key: &str, bytes: &[u8]) -> Result<Entry> {
    let cid = client
        .put_object(bytes)
        .await
        .context("uploading cache entry to the CE data layer")?;
    idx.put(key, &cid, bytes.len() as u64);
    let entry = idx
        .get(key)
        .cloned()
        .ok_or_else(|| anyhow!("index put did not persist the entry"))?;
    // Announce on the DHT that we hold an entry for this key so peers can discover us.
    let _ = client.advertise_service(&service_for_key(key)).await;
    Ok(entry)
}

/// Pack an artifact path (file or dir) and store it under `key`. Returns the [`Entry`].
pub async fn put_path(
    client: &CeClient,
    idx: &mut Index,
    key: &str,
    path: &std::path::Path,
) -> Result<Entry> {
    let bytes = archive::pack(path).with_context(|| format!("packing {}", path.display()))?;
    put_bytes(client, idx, key, &bytes).await
}

/// Resolve a key to its CID: local index first, then the mesh. Returns `(cid, size, source)`.
pub async fn resolve(
    client: &CeClient,
    idx: &Index,
    key: &str,
    caps: &str,
) -> Result<(Option<String>, u64, HitSource)> {
    if let Some(e) = idx.get(key) {
        return Ok((Some(e.cid.clone()), e.size, HitSource::Local));
    }
    // Mesh fallback: ask hosts advertising this key.
    // TODO: rank `holders` by atlas capacity + on-chain history (delivered_work) and probe latency,
    //       like ce-pin's placement, instead of first-responder order.
    let holders = client.find_service(&service_for_key(key)).await.unwrap_or_default();
    for host in &holders {
        match mesh_get(client, host, caps, key).await {
            Ok(GetResp { cid: Some(cid), size, .. }) => {
                return Ok((Some(cid), size, HitSource::Mesh(host.clone())));
            }
            Ok(_) => continue,
            Err(e) => {
                tracing::debug!(host = %&host[..16.min(host.len())], error = %e, "mesh get failed");
            }
        }
    }
    Ok((None, 0, HitSource::Miss))
}

/// Is there a cache hit for `key`? Checks the local index, then the mesh.
pub async fn has(client: &CeClient, idx: &Index, key: &str, caps: &str) -> Result<bool> {
    if idx.has(key) {
        return Ok(true);
    }
    let holders = client.find_service(&service_for_key(key)).await.unwrap_or_default();
    for host in &holders {
        if let Ok(HasResp { hit: true, .. }) = mesh_has(client, host, caps, key).await {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Fetch the raw archived bytes for `key` (no unpacking). Resolves the CID then `get_object`
/// (CID-verified). Returns the bytes and the [`HitSource`].
pub async fn get_bytes(
    client: &CeClient,
    idx: &Index,
    key: &str,
    caps: &str,
) -> Result<(Vec<u8>, HitSource)> {
    let (cid, _size, source) = resolve(client, idx, key, caps).await?;
    let cid = cid.ok_or_else(|| anyhow!("cache miss for key '{key}'"))?;
    let bytes = client
        .get_object(&cid)
        .await
        .with_context(|| format!("fetching object {cid} for key '{key}'"))?;
    Ok((bytes, source))
}

/// Fetch and restore the artifact for `key` to `dest` (file or directory, per how it was packed).
pub async fn get_to_path(
    client: &CeClient,
    idx: &Index,
    key: &str,
    caps: &str,
    dest: &std::path::Path,
) -> Result<HitSource> {
    let (bytes, source) = get_bytes(client, idx, key, caps).await?;
    archive::unpack(&bytes, dest).with_context(|| format!("restoring to {}", dest.display()))?;
    Ok(source)
}

/// Send a `cache/get` request to a single host.
async fn mesh_get(client: &CeClient, host: &str, caps: &str, key: &str) -> Result<GetResp> {
    let req = GetReq { caps: caps.to_string(), key: key.to_string() };
    let reply = client
        .request(host, "cache/get", &serde_json::to_vec(&req)?, GET_TIMEOUT_MS)
        .await
        .with_context(|| format!("cache/get to {}", &host[..16.min(host.len())]))?;
    serde_json::from_slice(&reply).context("decoding cache/get reply")
}

/// Send a `cache/has` request to a single host.
async fn mesh_has(client: &CeClient, host: &str, caps: &str, key: &str) -> Result<HasResp> {
    let req = HasReq { caps: caps.to_string(), key: key.to_string() };
    let reply = client
        .request(host, "cache/has", &serde_json::to_vec(&req)?, HAS_TIMEOUT_MS)
        .await
        .with_context(|| format!("cache/has to {}", &host[..16.min(host.len())]))?;
    serde_json::from_slice(&reply).context("decoding cache/has reply")
}

/// Publish a `key -> CID` mapping to a remote cache host (so it fetches and serves the entry too).
/// Used to push a write into a designated fleet cache host rather than relying on DHT discovery.
pub async fn push_to_host(
    client: &CeClient,
    host: &str,
    caps: &str,
    key: &str,
    cid: &str,
    size: u64,
    rent_per_gb_hour: Option<&str>,
) -> Result<PutResp> {
    // TODO: when rent is set, open a payment channel (channel_open) and sign per-GB-hour receipts
    //       (sign_receipt) so cache-hit rent is metered off-chain; the rent field is plumbed but the
    //       MVP runs free within a cap-gated fleet.
    let req = PutReq {
        caps: caps.to_string(),
        key: key.to_string(),
        cid: cid.to_string(),
        size,
        rent_per_gb_hour: rent_per_gb_hour.map(str::to_string),
    };
    let reply = client
        .request(host, "cache/put", &serde_json::to_vec(&req)?, PUT_TIMEOUT_MS)
        .await
        .with_context(|| format!("cache/put to {}", &host[..16.min(host.len())]))?;
    serde_json::from_slice(&reply).context("decoding cache/put reply")
}

/// Discover cache hosts on the mesh: nodes advertising `cache:host`. Returns their NodeId hexes.
pub async fn find_hosts(client: &CeClient) -> Result<Vec<String>> {
    Ok(client.find_service(SERVICE_HOST).await.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The local-index resolution path is the testable core (no node needed). The mesh paths are
    // exercised by the integration test against a mock node.
    #[test]
    fn hitsource_equality() {
        assert_eq!(HitSource::Local, HitSource::Local);
        assert_ne!(HitSource::Local, HitSource::Mesh("x".into()));
        assert_ne!(HitSource::Miss, HitSource::Local);
    }
}
