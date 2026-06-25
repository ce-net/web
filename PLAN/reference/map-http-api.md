Perfect. Now I have enough information to create a comprehensive API map. Let me compile all the endpoints and their details into markdown tables.

## CE Node HTTP API Contract

**Base URL:** `http://localhost:8844` (configurable via `--api-port`)

**All amounts:** Carried as decimal strings of base units (1 credit = 10^18 base units) to preserve precision.

**Authentication:** API token derived from node identity, persisted to `<data_dir>/api.token` (chmod 600). Gated on non-GET requests via `Authorization: Bearer <token>` header. Read-only GETs are unauthenticated. Mesh-originated RPC ops arrive over Noise-authenticated libp2p, not HTTP.

---

### Status / Health

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `/health` | GET | None | — | `ok` (plain text) | Liveness probe; 200 if node running. |
| `/status` | GET | None | — | `{ node_id, height, difficulty, balance, circulating_supply, burned_total, bond, weight }` | Node state snapshot. Amounts are base-unit strings. |
| `/bootstrap` | GET | None | — | `{ peers: ["/ip4/.../p2p/...", ...] }` | Multiaddrs from `CE_EXTERNAL_IP`/`CE_EXTERNAL_HOST` env vars. |

---

### Jobs (bidding & settlement)

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `POST /jobs/bid` | POST | Required | `{ image, cmd[], env[][], cpu_cores, mem_mb, duration_secs, bid }` | `{ job_id }` | Creates `JobBid` tx; 201 Created. Bid amount locked immediately. Returns 402 if balance ≤ 0. |
| `GET /jobs/:id` | GET | None | `id` = 64-hex job ID | `{ job_id, status, container_id?, cost? }` | Status: pending \| running \| awaiting_settlement \| settled \| failed:<reason>. 404 if not found. |
| `POST /jobs/:id/settle` | POST | Required | `{ cost, payer_sig }` | `{ status: "submitted" }` | Payer co-signs; host submits `JobSettle` tx. 202 Accepted. `cost` ≤ bid. `payer_sig` is 128-hex Ed25519 sig of `payer_settle_bytes(job_id, host, cost)`. 400 if sig verification fails. |
| `GET /jobs` | GET | None | — | `[{ job_id, status, payer, container_id?, cost?, bid }]` | List all jobs tracked by this node (payer and host). |
| `DELETE /jobs/:id` | DELETE | Required | `id` = job ID or Docker container ID | — | Force-stop & remove container. 204 No Content. 404 if not found. |

---

### Transfer & Economy

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `POST /transfer` | POST | Required | `{ to, amount }` | `{ tx_id }` | `to` = 64-hex recipient NodeId; `amount` = base units (string). 201 Created. 402 if balance insufficient. 400 if amount == 0. |
| `GET /history/:node_id` | GET | None | `node_id` = 64-hex | `{ node_id, jobs_hosted, jobs_paid, heartbeats_hosted, heartbeats_paid, expiries, earned, spent, first_height, last_height }` | Reputation substrate: immutable interaction history. Amounts are base-unit strings. 400 if bad node_id. Archive nodes hold full history; light nodes hold post-checkpoint only. |
| `GET /beacon` | GET | None | — | `{ height, hash }` | PoW chain tip hash (verifiable randomness for scheduling). |

---

### Payment Channels (off-chain micropayments)

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `POST /channels/open` | POST | Required | `{ host, capacity, expiry_height? }` | `{ channel_id }` | `host` = 64-hex. `capacity` = base units (string). `expiry_height` = 0 defaults to current + 8640 blocks (~24h). Locks capacity in free balance. 201 Created. 402 if free balance < capacity. |
| `POST /channels/receipt` | POST | Required | `{ channel_id, host, cumulative }` | `{ channel_id, cumulative, payer_sig }` | Payer signs an off-chain receipt. `cumulative` = base units (string). No tx, purely signature. 200 OK. |
| `POST /channels/:id/close` | POST | Required | `{ cumulative, payer_sig }` | `{ status: "submitted" }` | Called on HOST node. Redeems payer's highest receipt. `payer_sig` = 128-hex Ed25519 sig over `channel_receipt_bytes(channel_id, host, cumulative)`. 202 Accepted. 400 if malformed. |
| `POST /channels/:id/expire` | POST | Required | — | `{ status: "submitted" }` | Called on PAYER node after `expiry_height`. Reclaims the channel. 202 Accepted. |
| `GET /channels` | GET | None | — | `[{ channel_id, payer, host, capacity, expiry_height }]` | List open channels. Amounts are base-unit strings. |
| `POST /relay/pay` | POST | Required | `{ relay, channel_id, cumulative }` | `{ status: "paid" }` | Payer pays relay for relay service. Sends payment-channel receipt over mesh to relay. 200 OK. 400 if bad node_id/channel_id. 502 if relay rejects. |

---

### Blobs & Data Layer

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `POST /blobs` | POST | Required | Raw binary body | `{ hash }` | SHA256-based content addressing. Stores bytes; announces to DHT for replication. 201 Created. Returns 64-hex hash. |
| `GET /blobs/:hash` | GET | None | `hash` = 64-hex SHA256 | Binary blob data | 200 OK; fallback to mesh DHT if not local. 404 if not found locally or in mesh. |
| `POST /data/fetch` | POST | Required | `{ provider, cid, channel_id, cumulative }` | Binary chunk data | Paid chunk fetch (Stage 3). Signs payment receipt, fetches from provider over mesh RPC. Caches locally & re-announces. 200 OK; verifies bytes hash to `cid`. 502 if provider error. |

---

### Mesh: Targeted Placement (Deploy/Kill)

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `POST /mesh-deploy` | POST | Required | `{ node_id, image?, wasm_module?, wasm_entry?, cmd[], cpu_cores, mem_mb, duration_secs, bid, grant?, inputs[], hint_multiaddr? }` | `{ job_id, output }` | Directed placement: deploy long-running cell on specific host over mesh. `node_id` = target 64-hex. `bid` = base units (string). Mutually exclusive: `image` (Docker) or `wasm_module` (64-hex module hash). Returns host-assigned `job_id`. 200 OK. 400 bad node_id. 502 host rejected. 504 mesh timeout. |
| `POST /mesh-kill` | POST | Required | `{ node_id, job_id, grant?, hint_multiaddr? }` | — | Stop mesh-deployed cell. 204 No Content. Errors: 400 bad node_id, 502 host rejected, 504 timeout. |

---

### Mesh: Messaging (pubsub/request-reply)

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `POST /mesh/send` | POST | Required | `{ to, topic, payload_hex }` | `{ status: "delivered" }` | Directed signed message to node. `to` = 64-hex NodeId; `payload_hex` = hex-encoded app data. 200 OK. 502 if peer rejects. |
| `GET /mesh/messages` | GET | None | — | `[{ from, topic, payload_hex, reply_token? }]` | Recent app messages (inbox snapshot). |
| `GET /mesh/messages/stream` | GET | None | — | SSE: `data: { from, topic, payload_hex, reply_token }` | Push stream of inbound app messages. Content-Type: text/event-stream. Keep-alive every 15s. |
| `POST /mesh/subscribe` | POST | Required | `{ topic }` | `{ status: "subscribed" }` | Subscribe to app pub/sub topic. Messages land in inbox + stream. Idempotent. 200 OK. |
| `POST /mesh/publish` | POST | Required | `{ topic, payload_hex }` | `{ status: "published" }` | Publish signed message to topic (broadcasts on mesh). Signs with node identity. 200 OK. Auto-subscribes. |
| `POST /mesh/request` | POST | Required | `{ to, topic, payload_hex, timeout_ms? }` | `{ payload_hex }` | Sync request/response. Waits for peer app reply (default 30s). 200 OK. 504 if app does not reply in time. 502 if peer error. |
| `POST /mesh/reply` | POST | Required | `{ token, payload_hex }` | `{ status: "replied" }` | Answer a request (send reply payload back). `token` from inbound request message. 200 OK. |

---

### Mesh: Signals (CEP-1 capability announcements)

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `GET /signals` | GET | None | — | `[{ from, to, capabilities, payload_hex, burn_proof, nonce, id }]` | Last 100 validated CEP-1 signals (newest at end). |
| `GET /signals/stream` | GET | None | — | SSE: `data: { from, to, capabilities, payload_hex, burn_proof, nonce, id }` | Push stream of validated CEP-1 signals. Content-Type: text/event-stream. Keep-alive every 15s. |
| `POST /signals/send` | POST | Required | `{ payload_hex?, to, capabilities[], burn_tx_id_hex? }` | `{ id, nonce }` | Send CEP-1 signal. `to` = "broadcast" or 64-hex NodeId. `burn_tx_id_hex` required if `payload_hex` non-empty. 202 Accepted. Returns content-addressed `id` & nonce. |

---

### Mesh: Chains & Transactions (SSE streams)

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `GET /blocks/stream` | GET | None | — | SSE: `data: { index, hash, prev_hash, timestamp, miner, tx_count, nonce }` | Push every accepted block (mined or received). Content-Type: text/event-stream. Keep-alive every 15s. |
| `GET /transactions/stream` | GET | None | — | SSE: `data: { id, origin, kind, amount }` | Push every tx passing signature verification. `kind` = Transfer \| UptimeReward \| JobBid \| JobSettle \| JobExpire \| TrustGrant \| Heartbeat. `amount` = base units (string); 0 for kinds without amount. |

---

### Names & Discovery

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `POST /names/claim` | POST | Required | `{ name }` | `{ status: "submitted" }` | Claim human-readable name for this node. Submits `NameClaim` tx; takes effect when mined. Name rules: 3-32 chars, lowercase a-z/0-9/hyphen (not leading/trailing). 202 Accepted. 400 if invalid. |
| `GET /names/:name` | GET | None | `name` = claimed name | `{ name, node_id }` | Resolve name to owning NodeId (64-hex). 200 OK. 404 if not claimed. |
| `POST /discovery/advertise` | POST | Required | `{ service }` | `{ status: "advertised" }` | Advertise this node provides a named service (DHT). Re-call periodically (records expire). 200 OK. |
| `GET /discovery/find/:service` | GET | None | `service` = service name | `{ service, providers: [64-hex NodeIds] }` | Find NodeIds advertising a service. 200 OK. |

---

### Capabilities & Authorization

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `POST /capabilities/revoke` | POST | Required | `{ nonce }` | `{ tx_id }` | Revoke a capability this node issued. Submits `RevokeCapability` tx; invalidates that link + subtree when mined. 201 Created. |
| `GET /capabilities/revoked` | GET | None | — | `[{ issuer, nonce }]` | On-chain set of revoked `(issuer, nonce)` pairs. Used by apps (e.g. rdev) to deny revoked chains. |

---

### Coordination & Control

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `POST /chain/save` | POST | Required | — | `{ saved: path }` | Snapshot in-memory chain to disk (ephemeral/in-memory nodes). 200 OK. |
| `POST /tunnel` | POST | Required | `{ node_id, local_port, remote_port, caps?, hint? }` | `{ local_port, remote_port, node_id }` | Open TCP tunnel to remote port on target node over mesh. Binds 127.0.0.1:local_port; forwarding runs in background. 200 OK. 400 bad node_id. |

---

### Capacity Advertising

| Endpoint | Method | Auth | Request | Response | Notes |
|----------|--------|------|---------|----------|-------|
| `GET /atlas` | GET | None | — | `[{ node_id, cpu_cores, mem_mb, running_jobs, last_seen_secs, tags }]` | Capacity snapshot from all peers (CEP-1 signals). `tags` = self-tags (linux/macos/windows, x86_64/aarch64, docker, gpu, manycore, highmem). Updated every 60s; only while mining. |

---

### Request/Response Format Notes

**HTTP Status Codes:**
- `200 OK` — Successful read/state check
- `201 Created` — Tx successfully added to pool (not yet mined)
- `202 Accepted` — Async operation queued (host will submit later)
- `204 No Content` — Successful DELETE
- `400 Bad Request` — Malformed input, invalid format
- `401 Unauthorized` — Missing/invalid API token (non-GET)
- `402 Payment Required` — Insufficient balance
- `404 Not Found` — Resource not found
- `502 Bad Gateway` — Peer error (mesh RPC failure)
- `503 Service Unavailable` — Docker unavailable
- `504 Gateway Timeout` — Mesh RPC timeout

**Error Response Body:**
```json
{ "error": "description" }
```

**Authentication Token:**
- Derived from node Ed25519 identity secret
- Persisted to `<data_dir>/api.token` (chmod 600, read by same-host clients)
- Can be overridden via `CE_API_TOKEN` environment variable
- Applied via `Authorization: Bearer <token>` header on all non-GET requests
- Constant-time comparison prevents timing oracles

**SSE Streams:**
- Content-Type: `text/event-stream`
- Keep-alive comment every 15 seconds on idle
- Format: `data: <JSON>\n\n`
- Lagged slow clients log warning but stay connected

**Amounts:**
- Always carried as decimal strings of base units
- 1 credit = 10^18 base units
- Required because values exceed JavaScript's 2^53 safe-integer limit
- Example: "1000000000000000000" = 1 credit

---

### Local-Only vs. Mesh Authorization

**Local-Only (HTTP API):**
- Status/health, jobs (bid/settle), transfer, channels, all mesh ops, blobs
- Requires API token in Authorization header (mutating requests)
- Read-only GETs unauthenticated

**Mesh-Originated (RPC):**
- Deploy, Kill, FetchChunk, AppMessage, AppRequest, RelayReceipt
- Arrive over Noise-encrypted libp2p `/ce/rpc/1` protocol
- Authorized via forwarded `grant` token (capability chain) or admin trust
- Bypass HTTP API token entirely

**Grant Token:** Optional base64-encoded capability chain, forwarded in deploy/kill/tunnel requests to prove authorization for scoped abilities (Deploy, Kill, tunnel).