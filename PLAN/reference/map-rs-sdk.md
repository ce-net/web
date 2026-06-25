Perfect! Now I have all the information. Let me compile the comprehensive mapping document:

---

# CE Rust SDK (ce-rs) Complete API Mapping

## Overview

**ce-rs** is a typed, async Rust client for the CE node HTTP API. Version 0 targets unauthenticated local-node operations; auth signing for remote `/exec`/`sync` and SSE subscriptions are planned follow-ups.

**Repository:** https://github.com/ce-net/ce-rs  
**Base URL:** `http://127.0.0.1:8844` (configurable)

---

## CeClient: Constructors

| Method | Signature | Description |
|--------|-----------|-------------|
| `new()` | `fn new(base_url: impl Into<String>) -> Self` | Client for a node at `base_url`. Discovers API token from `$CE_API_TOKEN` env var or `<default data dir>/api.token`. |
| `with_token()` | `fn with_token(base_url: impl Into<String>, token: Option<String>) -> Self` | Explicit API token (or `None` for read-only). |
| `local()` | `fn local() -> Self` | Client for `http://127.0.0.1:8844` (default). |

---

## CeClient: Read Methods (Status, Discovery)

| Method | Endpoint | Signature | Return Type | Description |
|--------|----------|-----------|-------------|-------------|
| `health()` | `GET /health` | `pub async fn health() -> Result<bool>` | `bool` | Liveness check; returns `true` if successful. |
| `status()` | `GET /status` | `pub async fn status() -> Result<NodeStatus>` | `NodeStatus` | Node id, chain height, difficulty, balance. |
| `atlas()` | `GET /atlas` | `pub async fn atlas() -> Result<Vec<AtlasEntry>>` | `Vec<AtlasEntry>` | Capacity atlas — every peer's latest capacity + capability self-tags. |
| `beacon()` | `GET /beacon` | `pub async fn beacon() -> Result<Beacon>` | `Beacon` | Verifiable public randomness from the PoW tip. |
| `revoked()` | `GET /capabilities/revoked` | `pub async fn revoked() -> Result<Vec<(String, u64)>>` | `Vec<(String, u64)>` | On-chain revoked `(issuer_hex, nonce)` capability set. |

---

## CeClient: Job Management (Bid, Query, Settle, Kill)

| Method | Endpoint | Signature | Return Type | Description |
|--------|----------|-----------|-------------|-------------|
| `jobs()` | `GET /jobs` | `pub async fn jobs() -> Result<Vec<Job>>` | `Vec<Job>` | All jobs known to this node (payer & host). |
| `job()` | `GET /jobs/:id` | `pub async fn job(job_id: &str) -> Result<Job>` | `Job` | One job's status by id. |
| `bid()` | `POST /jobs/bid` | `pub async fn bid(spec: &BidSpec) -> Result<String>` | `String` (job_id) | Broadcast a bid; any host with capacity may accept. |
| `mesh_deploy()` | `POST /mesh-deploy` | `pub async fn mesh_deploy(node_id: &str, spec: &BidSpec, grant: Option<&str>) -> Result<String>` | `String` (job_id) | Directed placement: deploy on a specific host over the mesh. |
| `mesh_deploy_wasm()` | `POST /mesh-deploy` | `pub async fn mesh_deploy_wasm(node_id: &str, module_hash: &str, entry: &str, cpu_cores: u32, mem_mb: u64, duration_secs: u64, bid: Amount, grant: Option<&str>, inputs: &[&str]) -> Result<Deployment>` | `Deployment { job_id, output }` | Deploy WASM workload by content hash (1 MiB chunks); inputs are CID-addressed dependencies. |
| `kill()` | `DELETE /jobs/:id` | `pub async fn kill(job_id: &str) -> Result<()>` | `()` | Force-stop a local job by id. |
| `mesh_kill()` | `POST /mesh-kill` | `pub async fn mesh_kill(node_id: &str, job_id: &str, grant: Option<&str>) -> Result<()>` | `()` | Stop a job on a remote host over the mesh. |

**Note:** Job settlement (`POST /jobs/:id/settle`) is **NOT wrapped** by ce-rs — apps must build payer signatures themselves.

---

## CeClient: Economy (Transfers, Payment Channels)

### Transfers

| Method | Endpoint | Signature | Return Type | Description |
|--------|----------|-----------|-------------|-------------|
| `transfer()` | `POST /transfer` | `pub async fn transfer(to: &str, amount: Amount) -> Result<String>` | `String` (tx_id) | Transfer credits to another node. |

### Payment Channels

| Method | Endpoint | Signature | Return Type | Description |
|--------|----------|-----------|-------------|-------------|
| `channel_open()` | `POST /channels/open` | `pub async fn channel_open(host: &str, capacity: Amount, expiry_height: u64) -> Result<String>` | `String` (channel_id) | Open an off-chain payment channel, locking capacity. |
| `channels()` | `GET /channels` | `pub async fn channels() -> Result<Vec<Channel>>` | `Vec<Channel>` | List open payment channels. |
| `sign_receipt()` | `POST /channels/receipt` | `pub async fn sign_receipt(channel_id: &str, host: &str, cumulative: Amount) -> Result<Receipt>` | `Receipt { channel_id, cumulative, payer_sig }` | Payer signs an off-chain receipt. |
| `channel_close()` | `POST /channels/:id/close` | `pub async fn channel_close(channel_id: &str, cumulative: Amount, payer_sig: &str) -> Result<()>` | `()` | Host redeems receipt to close channel (call on host node). |
| `channel_expire()` | `POST /channels/:id/expire` | `pub async fn channel_expire(channel_id: &str) -> Result<()>` | `()` | Payer reclaims channel after expiry. |
| `pay_relay()` | `POST /relay/pay` | `pub async fn pay_relay(relay: &str, channel_id: &str, cumulative: Amount) -> Result<()>` | `()` | Pay relay for mesh relaying service. |

---

## CeClient: Data Layer (Blobs, Objects, Chunked Upload/Download)

| Method | Endpoint | Signature | Return Type | Description |
|--------|----------|-----------|-------------|-------------|
| `put_blob()` | `POST /blobs` | `pub async fn put_blob(bytes: Vec<u8>) -> Result<String>` | `String` (sha256 hash) | Upload bytes to content-addressed blob store. |
| `get_blob()` | `GET /blobs/:hash` | `pub async fn get_blob(hash: &str) -> Result<Vec<u8>>` | `Vec<u8>` | Fetch a blob by content hash. |
| `put_object()` | `POST /blobs` (multiple) | `pub async fn put_object(bytes: &[u8]) -> Result<String>` | `String` (manifest CID) | Upload object of any size: split into 1 MiB chunks, store each, return object CID (manifest hash). |
| `get_object()` | `GET /blobs/:hash` (multiple) | `pub async fn get_object(object_cid: &str) -> Result<Vec<u8>>` | `Vec<u8>` | Fetch object by CID: resolve manifest, pull/verify chunks, reassemble. |
| `fetch_chunk_paid()` | `POST /data/fetch` | `pub async fn fetch_chunk_paid(provider: &str, cid: &str, channel_id: &str, cumulative: Amount) -> Result<Vec<u8>>` | `Vec<u8>` | Paid chunk fetch (data layer Stage 3): authorize redemption on channel, fetch from provider over mesh, verify. |

---

## CeClient: App Messaging (Mesh RPC, Pub/Sub, Request/Response)

| Method | Endpoint | Signature | Return Type | Description |
|--------|----------|-----------|-------------|-------------|
| `send_message()` | `POST /mesh/send` | `pub async fn send_message(to: &str, topic: &str, payload: &[u8]) -> Result<()>` | `()` | Send directed app message to a node over mesh. |
| `messages()` | `GET /mesh/messages` | `pub async fn messages() -> Result<Vec<AppMessage>>` | `Vec<AppMessage>` | Snapshot of recently-received app messages (best-effort, capped). |
| `subscribe()` | `POST /mesh/subscribe` | `pub async fn subscribe(topic: &str) -> Result<()>` | `()` | Subscribe to pub/sub topic; node receives published messages. |
| `publish()` | `POST /mesh/publish` | `pub async fn publish(topic: &str, payload: &[u8]) -> Result<()>` | `()` | Publish signed message to pub/sub topic (broadcast to subscribers). |
| `request()` | `POST /mesh/request` | `pub async fn request(to: &str, topic: &str, payload: &[u8], timeout_ms: u64) -> Result<Vec<u8>>` | `Vec<u8>` (reply payload) | Send request to node, wait for app's reply (with timeout). |
| `reply()` | `POST /mesh/reply` | `pub async fn reply(token: u64, payload: &[u8]) -> Result<()>` | `()` | Answer incoming request by token (routed back to requester). |

---

## CeClient: Naming & Discovery (DHT)

| Method | Endpoint | Signature | Return Type | Description |
|--------|----------|-----------|-------------|-------------|
| `claim_name()` | `POST /names/claim` | `pub async fn claim_name(name: &str) -> Result<()>` | `()` | Claim unique human-readable name (3–32 chars, `a-z`/`0-9`/hyphen, first claim wins). |
| `resolve_name()` | `GET /names/:name` | `pub async fn resolve_name(name: &str) -> Result<Option<String>>` | `Option<String>` (NodeId hex) | Resolve claimed name to owner's NodeId (None if unclaimed). |
| `advertise_service()` | `POST /discovery/advertise` | `pub async fn advertise_service(service: &str) -> Result<()>` | `()` | Advertise service via DHT (provider records expire; re-advertise periodically). |
| `find_service()` | `GET /discovery/find/:service` | `pub async fn find_service(service: &str) -> Result<Vec<String>>` | `Vec<String>` (NodeId hexes) | Find NodeIds advertising a named service via DHT. |

---

## CeClient: History (Reputation Substrate)

| Method | Endpoint | Signature | Return Type | Description |
|--------|----------|-----------|-------------|-------------|
| `history()` | `GET /history/:node_id` | `pub async fn history(node_id: &str) -> Result<NodeHistory>` | `NodeHistory` | Immutable on-chain interaction facts: jobs hosted/paid, heartbeats, expiries, earned/spent. |

---

## Public Structs & Enums

### Amount

**Module:** `amount`  
**Base Units:** `1 credit = 10^18 base units` (CREDIT constant).  
**Serialization:** Decimal string of base units (precision-safe across JSON; exceeds i64).

| Method/Field | Type | Description |
|---|---|---|
| `Amount(pub i128)` | `i128` | Signed base-unit amount. |
| `ZERO` | `const Amount` | Zero amount. |
| `from_credits(n: u64) -> Amount` | Constructor | `n` whole credits. |
| `from_base(base: i128) -> Amount` | Constructor | Raw base units. |
| `base(self) -> i128` | `i128` | Underlying base-unit value. |
| `is_zero(self) -> bool` | `bool` | True if zero. |
| `parse_credits(s: &str) -> Result<Amount>` | Constructor | Parse human credit decimal (`"1000"`, `"1.5"`, `"0.000000000000000001"`); up to 18 decimal places. |
| `credits(self) -> String` | `String` | Format as human credit decimal, trimming trailing zeros. |
| `Display::fmt()` | String | Formats as `"X.Y credits"`. |

**Wire (JSON):** Serialized/deserialized as a decimal *string* of base units (not a number).

### NodeStatus

| Field | Type | Description |
|---|---|---|
| `node_id` | `String` | 64-hex-char Ed25519 public key. |
| `height` | `u64` | Chain tip block height. |
| `difficulty` | `u8` | Vestigial PoW field (always 0 in uptime-emission model). |
| `balance` | `Amount` | This node's credit balance (base units). |

### AtlasEntry

| Field | Type | Description |
|---|---|---|
| `node_id` | `String` | 64-hex peer NodeId. |
| `cpu_cores` | `u32` | Available CPU cores. |
| `mem_mb` | `u32` | Available memory in MiB. |
| `running_jobs` | `u32` | Current running job count. |
| `last_seen_secs` | `u64` | Unix seconds of last capacity signal. |
| `tags` | `Vec<String>` | Capability self-tags (e.g., `["gpu", "docker", "linux", "x86_64"]`). |

**Method:** `has_tag(tag: &str) -> bool` — check if host advertises a tag.

### Beacon

| Field | Type | Description |
|---|---|---|
| `height` | `u64` | Block height. |
| `hash` | `String` | 64-hex tip block hash (unpredictable, globally agreed). |

### Job

| Field | Type | Description |
|---|---|---|
| `job_id` | `String` | 64-hex job identifier. |
| `status` | `String` | `"pending"`, `"running"`, `"awaiting_settlement"`, `"settled"`, or `"failed: <reason>"`. |
| `payer` | `Option<String>` | Payer NodeId (hex). |
| `container_id` | `Option<String>` | Docker container id (if running). |
| `cost` | `Option<Amount>` | Agreed settlement amount (base units). |
| `bid` | `Option<Amount>` | Original bid (base units). |

**Method:** `is_running() -> bool` — check if status is `"running"`.

### BidSpec

| Field | Type | Description |
|---|---|---|
| `image` | `String` | Docker image to pull and run. |
| `cmd` | `Vec<String>` | Command override (default: image entrypoint). |
| `cpu_cores` | `u32` | CPU allocation hint. |
| `mem_mb` | `u64` | Memory limit in MiB. |
| `duration_secs` | `u64` | Maximum expected runtime. |
| `bid` | `Amount` | Maximum credits willing to spend (locked at bid time). |

### Deployment

| Field | Type | Description |
|---|---|---|
| `job_id` | `String` | Host-assigned job id. |
| `output` | `Option<String>` | Output CID if workload completed (e.g., WASI stdout); `None` for detached/streaming. |

### Channel

| Field | Type | Description |
|---|---|---|
| `channel_id` | `String` | 64-hex channel identifier. |
| `payer` | `String` | Payer NodeId (hex). |
| `host` | `String` | Host NodeId (hex). |
| `capacity` | `Amount` | Locked capacity (base units). |
| `expiry_height` | `u64` | Block height when channel expires. |

### Receipt

| Field | Type | Description |
|---|---|---|
| `channel_id` | `String` | Channel id. |
| `cumulative` | `Amount` | Cumulative amount authorized (base units). |
| `payer_sig` | `String` | 128-hex payer's Ed25519 signature. |

### AppMessage

| Field | Type | Description |
|---|---|---|
| `from` | `String` | Cryptographically authenticated sender NodeId (hex). |
| `topic` | `String` | App-chosen topic namespace. |
| `payload_hex` | `String` | Opaque payload, hex-encoded. |
| `received_at` | `u64` | Unix seconds when local node received it. |
| `reply_token` | `Option<u64>` | Token for `reply()` if this is a request expecting a reply. |

**Method:** `payload() -> Result<Vec<u8>>` — decode hex payload.

### NodeHistory

| Field | Type | Description |
|---|---|---|
| `node_id` | `String` | 64-hex node id. |
| `jobs_hosted` | `u64` | Jobs settled as host (work delivered + paid). |
| `jobs_paid` | `u64` | Jobs paid for as payer. |
| `heartbeats_hosted` | `u64` | Heartbeats received hosting long-running cells. |
| `heartbeats_paid` | `u64` | Heartbeats paid for. |
| `expiries` | `u64` | Bids expired as payer without settling. |
| `earned` | `Amount` | Total earned (base units). |
| `spent` | `Amount` | Total spent (base units). |
| `first_height` | `u64` | Block height of first interaction (0 = never). |
| `last_height` | `u64` | Block height of most recent interaction. |

**Method:** `is_newcomer() -> bool` — true if `first_height == 0` (no history).  
**Method:** `delivered_work() -> u64` — heuristic: `jobs_hosted + heartbeats_hosted`.

### ExecResult

**Status:** NOT WRAPPED (remote exec/file sync moved to `rdev` app; removed from ce-rs).

| Field | Type | Description |
|---|---|---|
| `stdout` | `String` | Command stdout. |
| `stderr` | `String` | Command stderr. |
| `exit_code` | `i64` | Exit code. |

**Method:** `ok() -> bool` — true if `exit_code == 0`.

---

## Data Layer: Manifests & Chunking

**Module:** `data`  
**Constants:** `DEFAULT_CHUNK_SIZE = 1024 * 1024` (1 MiB).

### Manifest

| Field | Type | Description |
|---|---|---|
| `kind` | `String` | Discriminator; always `"ce-object-v1"` in Stage 1. |
| `chunk_size` | `u64` | Chunk size used when splitting (last chunk may be smaller). |
| `total_size` | `u64` | Total object size in bytes. |
| `chunks` | `Vec<String>` | Ordered chunk CIDs (hex sha256). |

**Method:** `is_v1() -> bool` — check if this is the v1 format.

### Functions

| Function | Signature | Description |
|---|---|---|
| `cid()` | `pub fn cid(bytes: &[u8]) -> String` | SHA256 content id (lowercase hex). Matches node's `/blobs` keying. |
| `chunk_object()` | `pub fn chunk_object(bytes: &[u8], chunk_size: usize) -> (Manifest, Vec<(String, Vec<u8>)>)` | Split bytes into chunks; return manifest + `(cid, chunk_bytes)` pairs. Manifest NOT included in chunks. |
| `reassemble()` | `pub fn reassemble(manifest: &Manifest, mut fetch: impl FnMut(&str) -> Result<Vec<u8>>) -> Result<Vec<u8>>` | Reassemble object from manifest: fetch each chunk, verify against CID, join. Pure (no network). |

---

## HTTP Endpoints: API vs SDK Coverage

### Summary

**All endpoints on the node are now wrapped by ce-rs** except:

1. **`POST /jobs/:id/settle`** — Job settlement signature must be built by app (uses payer's signing key, not node's API token).
2. **`POST /chain/save`** — Internal endpoint (not public API).
3. **`POST /tunnel`** — TCP tunnel forwarding (out of scope for ce-rs v0).
4. **Remote exec/file sync** — **Removed from node** (moved to `rdev` app via `AppRequest` + `ce-cap`; no HTTP endpoint).

### Complete Endpoint Map

| Endpoint | HTTP Method | ce-rs Method | Status |
|---|---|---|---|
| `/health` | GET | `health()` | ✅ Wrapped |
| `/status` | GET | `status()` | ✅ Wrapped |
| `/atlas` | GET | `atlas()` | ✅ Wrapped |
| `/beacon` | GET | `beacon()` | ✅ Wrapped |
| `/history/:node_id` | GET | `history()` | ✅ Wrapped |
| `/jobs` | GET | `jobs()` | ✅ Wrapped |
| `/jobs/:id` | GET | `job()` | ✅ Wrapped |
| `/jobs/bid` | POST | `bid()` | ✅ Wrapped |
| `/jobs/:id/settle` | POST | — | ❌ NOT wrapped (app must build payer signature) |
| `/jobs/:id` | DELETE | `kill()` | ✅ Wrapped |
| `/transfer` | POST | `transfer()` | ✅ Wrapped |
| `/capabilities/revoked` | GET | `revoked()` | ✅ Wrapped |
| `/capabilities/revoke` | POST | — | ❌ NOT wrapped |
| `/channels` | GET | `channels()` | ✅ Wrapped |
| `/channels/open` | POST | `channel_open()` | ✅ Wrapped |
| `/channels/receipt` | POST | `sign_receipt()` | ✅ Wrapped |
| `/channels/:id/close` | POST | `channel_close()` | ✅ Wrapped |
| `/channels/:id/expire` | POST | `channel_expire()` | ✅ Wrapped |
| `/blobs` | POST | `put_blob()` | ✅ Wrapped |
| `/blobs/:hash` | GET | `get_blob()` | ✅ Wrapped |
| `/data/fetch` | POST | `fetch_chunk_paid()` | ✅ Wrapped |
| `/mesh-deploy` | POST | `mesh_deploy()`, `mesh_deploy_wasm()` | ✅ Wrapped |
| `/mesh-kill` | POST | `mesh_kill()` | ✅ Wrapped |
| `/mesh/send` | POST | `send_message()` | ✅ Wrapped |
| `/mesh/messages` | GET | `messages()` | ✅ Wrapped |
| `/mesh/messages/stream` | GET | — | ❌ NOT wrapped (SSE; use polling via `messages()`) |
| `/mesh/subscribe` | POST | `subscribe()` | ✅ Wrapped |
| `/mesh/publish` | POST | `publish()` | ✅ Wrapped |
| `/mesh/request` | POST | `request()` | ✅ Wrapped |
| `/mesh/reply` | POST | `reply()` | ✅ Wrapped |
| `/names/claim` | POST | `claim_name()` | ✅ Wrapped |
| `/names/:name` | GET | `resolve_name()` | ✅ Wrapped |
| `/discovery/advertise` | POST | `advertise_service()` | ✅ Wrapped |
| `/discovery/find/:service` | GET | `find_service()` | ✅ Wrapped |
| `/relay/pay` | POST | `pay_relay()` | ✅ Wrapped |
| `/signals` | GET | — | ❌ NOT wrapped |
| `/signals/send` | POST | — | ❌ NOT wrapped |
| `/signals/stream` | GET | — | ❌ NOT wrapped (SSE) |
| `/blocks/stream` | GET | — | ❌ NOT wrapped (SSE) |
| `/transactions/stream` | GET | — | ❌ NOT wrapped (SSE) |
| `/bootstrap` | GET | — | ❌ NOT wrapped |
| `/chain/save` | POST | — | ❌ Internal only |
| `/tunnel` | POST | — | ❌ Out of scope (TCP tunnel) |

---

## Gaps: What's NOT Wrapped

### Policy Calls (Payer Signature Required)

- **`POST /jobs/:id/settle`** — Requires payer's Ed25519 signature over the settlement bytes. Apps must:
  - Build the settlement structure.
  - Sign with their identity key (not the node's API token).
  - Call the endpoint directly (or wrap it themselves).
  - ce-rs provides signature verification utilities via the wire types but does NOT perform signing.

### CEP-1 Signals (Broadcast Protocol)

- **`GET /signals`** — List recent validated CEP-1 signals (not wrapped).
- **`POST /signals/send`** — Build, sign, and broadcast CEP-1 signal (not wrapped).
- **`GET /signals/stream`** — SSE stream of incoming signals (not wrapped).

**Why:** Signals carry burn-proof PoW; they are part of the consensus protocol, not app-layer messaging. Apps should use `/mesh/*` (directed, signed, app-namespaced) or gossip/pubsub for app messages.

### SSE Streams (Real-Time Events)

- **`GET /mesh/messages/stream`** — Real-time app messages (SSE; ce-rs uses polling via `messages()`).
- **`GET /blocks/stream`** — Real-time block events (SSE; not wrapped).
- **`GET /transactions/stream`** — Real-time transaction events (SSE; not wrapped).

**Why:** SSE requires keeping a persistent HTTP connection open. Polling via `messages()` is simpler for synchronous Rust; real-time apps can wrap the SSE endpoint directly.

### Authority/Admin Endpoints

- **`POST /capabilities/revoke`** — Revoke a capability grant (requires node authorization; not wrapped).
- **`POST /chain/save`** — Internal state save (not part of public API).
- **`POST /tunnel`** — TCP tunnel forwarding (infrastructure, not SDK scope).

### Bootstrap/Peer Discovery

- **`GET /bootstrap`** — Internal bootstrap peers (not wrapped; peers are handled at mesh level).

---

## Amount Conversion Examples

```rust
use ce_rs::{Amount, CREDIT};

// Create amounts
let a = Amount::from_credits(10);           // 10 credits
let b = Amount::from_base(CREDIT / 2);      // 0.5 credits
let c = Amount::parse_credits("1.5")?;      // 1.5 credits

// Convert to human-readable
println!("{}", a.credits());                // "10"
println!("{}", b.credits());                // "0.5"
println!("{}", c.credits());                // "1.5"

// Access base units
let base: i128 = a.base();                  // 10_000_000_000_000_000_000

// JSON serialization (wire form)
let json = serde_json::to_string(&a)?;      // "\"10000000000000000000\""
let parsed: Amount = serde_json::from_str(&json)?;
```

---

## Data Layer Examples

```rust
use ce_rs::{CeClient, data};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ce = CeClient::local();

    // Upload a 3 MiB object (auto-chunked to 1 MiB chunks)
    let bytes = vec![42u8; 3_000_000];
    let object_cid = ce.put_object(&bytes).await?;  // Returns manifest CID

    // Fetch it back (resolves manifest, pulls chunks, verifies, reassembles)
    let fetched = ce.get_object(&object_cid).await?;
    assert_eq!(fetched, bytes);

    // Manual chunking (for WASM modules, etc.)
    let (manifest, chunks) = data::chunk_object(&bytes, data::DEFAULT_CHUNK_SIZE);
    println!("Object {} chunks", manifest.chunks.len());
    
    // Store chunks manually
    for (cid, chunk_bytes) in chunks {
        let stored = ce.put_blob(chunk_bytes).await?;
        assert_eq!(stored, cid, "blob hash mismatch");
    }
    
    // Store the manifest separately (its hash is the object CID)
    let manifest_cid = ce.put_blob(serde_json::to_vec(&manifest)?).await?;
    assert_eq!(manifest_cid, object_cid);

    Ok(())
}
```

---

## Design Notes

### Chunking & Content Addressing

- **Default chunk size:** 1 MiB (balance: low overhead, low per-chunk cost on paid providers).
- **Content ID:** SHA256 of chunk bytes, lowercase hex (matches node's `/blobs` keying).
- **Manifest:** JSON struct (kind, chunk_size, total_size, chunks[]), stored as a blob; manifest's hash is the object CID.
- **Dedup:** Identical chunks share a CID; the manifest references it multiple times.
- **Verification:** Every fetched chunk is verified against its CID before reassembly (trustless).

### API Token Discovery

```rust
// Auto-discovery order:
// 1. $CE_API_TOKEN env var (covers custom --data-dir and tests)
// 2. <default data dir>/api.token (written by locally-running node)
// 3. None (read-only access)

let ce = CeClient::new("http://127.0.0.1:8844");
// or explicitly:
let token = ce_rs::discover_api_token();
let ce = CeClient::with_token("http://127.0.0.1:8844", token);
```

### Async/Error Model

- **All methods are async** (`pub async fn`).
- **Error handling:** `Result<T>` returns; errors are `anyhow::Error` with context.
- **Status codes:** Non-2xx responses are decoded as errors with the response body.

---

## Limitations & Future Work

1. **No auth signing for remote nodes** — v0 targets local-node HTTP API only. Remote `/exec`/`/sync` and capability-based trust require CE-auth signature generation (planned).
2. **No SSE subscriptions** — Polling via `messages()` is simpler; real-time apps can wrap SSE endpoints.
3. **No per-chunk receipts** — `fetch_chunk_paid()` accepts a single `cumulative` amount per fetch; per-chunk granularity requires app-level tracking.
4. **Payer signatures (settlement, receipts)** — Apps must build Ed25519 signatures themselves; ce-rs does not provide key material.

---

## Quick Reference: Usage Pattern

```rust
use ce_rs::{CeClient, Amount, BidSpec};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ce = CeClient::local();

    // Query node status
    let status = ce.status().await?;
    println!("Node {} at height {}", status.node_id, status.height);

    // Find a GPU host
    let hosts = ce.atlas().await?;
    if let Some(h) = hosts.iter().find(|h| h.has_tag("gpu")) {
        // Place a job on it
        let spec = BidSpec {
            image: "pytorch:latest".into(),
            cmd: vec!["python".into(), "train.py".into()],
            cpu_cores: 4,
            mem_mb: 16384,
            duration_secs: 3600,
            bid: Amount::from_credits(100),
        };
        let job_id = ce.mesh_deploy(&h.node_id, &spec, None).await?;
        println!("Deployed {} on {}", job_id, h.node_id);

        // Poll for job status
        loop {
            let job = ce.job(&job_id).await?;
            if job.is_running() {
                println!("Running...");
            } else {
                println!("Done: {}", job.status);
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    }

    Ok(())
}
```