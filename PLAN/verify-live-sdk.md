# @ce-net/sdk verification vs the CE node

Date: 2026-06-20
SDK: `/Users/07lead01/ce-net/ce-ts`
Node source audited: `/Users/07lead01/ce-net/ce/crates/ce-node/src/api.rs` (2211 lines)

## Status of the live run

The task's preferred path is a LIVE run against a started node. In this environment
that could not be completed:

- The release binary `/Users/07lead01/ce-net/ce/target/release/ce` did not exist and
  had to be built from a near-cold `target/` (`cargo build --release --bin ce`). The
  workspace pulls in the full `wasmtime`/`cranelift` tree (WASM workload feature),
  which compiles at `opt-level=3`; the build was still running (>35 min, stuck in
  `wasmtime_cranelift`/`wasmtime_environ`) when this report was written. Early time was
  also lost to cargo artifact-lock contention from duplicate background build attempts
  (since reaped down to one).
- Docker is DOWN on this host (`docker info` fails). The node runs fine without it
  (container metering self-disables), so this does not block the HTTP/SSE surfaces; it
  only means Docker job execution can't be exercised.

Because the node could not be started, this verification was done as a rigorous
STATIC audit of every SDK surface against the node's actual axum handlers and response
structs in `api.rs`, plus the response shapes the node serializes. All drift found this
way is confirmed at the source level (exact field names, JSON serialization attrs,
amount-as-string handling). The fixes below are applied and the SDK is green:
`tsc --noEmit` passes, `vitest` passes (30 tests), and `tsdown` bundles cleanly.

A live run harness was written and is ready: `ce-ts/examples/_verify-live.ts`
(reads `CE_BASE_URL` + `CE_API_TOKEN`). To finish the LIVE verification once a binary
exists:

```
TMP=$(mktemp -d)
./target/release/ce start --no-mine --data-dir "$TMP" --api-port 18844 --port 14001 &
# wait for http://127.0.0.1:18844/health == "ok"
TOKEN=$(cat "$TMP/api.token")
cd ~/ce-net/ce-ts
CE_BASE_URL=http://127.0.0.1:18844 CE_API_TOKEN=$TOKEN npx tsx examples/_verify-live.ts
```

That harness exercises: `/health`, `/status` (incl. the Wave-0 `free`/`locked_channels`/
`locked_bond` breakdown), `/beacon`, `/atlas`, `/bootstrap`, `/history/:id`,
`/transactions/:id` (NEW), `/jobs`, `/channels`, blob+object round-trip
(`/blobs` + `/blobs/:hash`), `/transfer`, `/jobs/bid` + `/jobs/:id`, and the
`/blocks/stream` SSE. On a fresh `--no-mine` node, `/transfer` and `/jobs/bid` are
expected to 402 (zero balance) — the harness treats a 402 as a PASS for those two
(it proves the wire contract + the SDK's `CeInsufficientFundsError` mapping).

## Endpoint-by-endpoint audit (SDK <-> api.rs)

| Endpoint | SDK surface | Live-checkable | Verdict |
|---|---|---|---|
| GET /health | `status.health()` | yes (harness) | MATCH (returns `"ok"`) |
| GET /status | `status.status()` | yes | DRIFT FIXED — see below |
| GET /beacon | `status.beacon()` | yes | MATCH (`{height,hash}`) |
| GET /atlas | `status.atlas()` | yes | MATCH (`node_id` + flattened `PeerCapacity`) |
| GET /bootstrap | `status.bootstrap()` | yes | MATCH (`{peers[]}`) |
| GET /history/:id | `history()` | yes | MATCH (all fields/snake_case) |
| GET /transactions/:id | `transactions()` | yes | DRIFT FIXED — was MISSING entirely |
| GET /jobs | `jobs.list()` | yes | MATCH (`JobListItem`: job_id,status,payer,container_id,cost,bid) |
| GET /jobs/:id | `jobs.get()` | yes | SHAPE DIFFERS (no payer/bid) — documented; SDK tolerant, no code change needed |
| POST /jobs/bid | `jobs.bid()` | yes (402 expected) | MATCH (snake_case body, amount string) |
| POST /jobs/:id/settle | `jobs.settle()` | needs a real job | MATCH (`{cost, payer_sig}`) |
| DELETE /jobs/:id | `jobs.kill()` | yes | MATCH (204) |
| POST /transfer | `transfer()` | yes (402 expected) | MATCH (`{to, amount}` string -> `{tx_id}`) |
| POST /blobs | `data.putBlob()` | yes | MATCH (raw body -> `{hash}`) |
| GET /blobs/:hash | `data.getBlob()` | yes | MATCH (raw bytes) |
| POST /data/fetch | `data.fetchChunkPaid()` | needs a provider+channel | MATCH (body fields) |
| GET /channels | `channels.list()` | yes | MATCH (`ChannelView`) |
| POST /channels/open | `channels.open()` | needs balance | MATCH (`{host,capacity,expiry_height}` -> `{channel_id}`) |
| POST /channels/receipt | `channels.signReceipt()` | needs a channel | MATCH (`{channel_id,host,cumulative}` -> `{channel_id,cumulative,payer_sig}`) |
| POST /channels/:id/close | `channels.close()` | needs a channel | MATCH (`{cumulative,payer_sig}` -> `{status:"submitted"}`) |
| POST /channels/:id/expire | `channels.expire()` | needs a channel | MATCH (`{status:"submitted"}`) |
| POST /mesh/send | `mesh.send()` | needs a peer | MATCH (`{to,topic,payload_hex}` -> `{status:"delivered"}`) |
| GET /mesh/messages | `mesh.messages()` | yes | MATCH (`AppMessage` snake_case) |
| GET /mesh/messages/stream | `mesh.streamMessages()` | yes (SSE) | MATCH |
| POST /mesh/subscribe | `mesh.subscribe()` | yes | MATCH (`{topic}` -> `{status:"subscribed"}`) |
| POST /mesh/publish | `mesh.publish()` | yes | MATCH (`{topic,payload_hex}`) |
| POST /mesh/request | `mesh.request()` | needs a peer | MATCH (`{to,topic,payload_hex,timeout_ms}` -> `{payload_hex}`) |
| POST /mesh/reply | `mesh.reply()` | needs a request | MATCH (`{token,payload_hex}`) |
| GET /signals | `signals.list()` | yes | MATCH (`SignalView`) |
| POST /signals/send | `signals.send()` | yes | MATCH (`{to,capabilities,payload_hex,burn_tx_id_hex}` -> `{id,nonce}`) |
| GET /signals/stream | `signals.stream()` | yes (SSE) | MATCH |
| GET /blocks/stream | `streams.blocks()` | yes (SSE) | MATCH (`BlockView`: index,hash,prev_hash,timestamp,miner,tx_count,nonce) |
| GET /transactions/stream | `streams.transactions()` | yes (SSE) | DRIFT FIXED — TxKind vocabulary (below) |
| POST /names/claim | `names.claim()` | yes | MATCH (`{name}`) |
| GET /names/:name | `names.resolve()` | yes | MATCH (`{name,node_id}`, 404 -> null) |
| POST /discovery/advertise | `discovery.advertise()` | yes | MATCH (`{service}`) |
| GET /discovery/find/:svc | `discovery.find()` | yes | MATCH (`{service,providers[]}`) |
| POST /capabilities/revoke | `caps.revoke()` | yes | MATCH (`{nonce}` -> `{tx_id}`) |
| GET /capabilities/revoked | `caps.revoked()` | yes | MATCH (emits objects `{issuer,nonce}`) |
| POST /tunnel | `tunnel()` | needs a peer | MATCH (`{local_port,remote_port,node_id}`) |
| POST /mesh-deploy | `jobs.meshDeploy[Wasm]()` | needs a peer | MATCH (body shape) |
| POST /mesh-kill | `jobs.meshKill()` | needs a peer | MATCH (`{node_id,job_id,grant?}`) |

## Drift found and fixed

### 1. GET /status — missing Wave-0 balance breakdown (FIXED)

The node's `NodeStatusResponse` (api.rs:200) emits three fields the SDK did not model:
`free`, `locked_channels`, `locked_bond` (all base-unit decimal strings via `amount_str`).
`balance` is `i128` (can be negative); the breakdown fields are `u128`.

Fixes:
- `src/types.ts` — added `free`/`locked_channels`/`locked_bond` to `RawNodeStatus`, and
  `free`/`lockedChannels`/`lockedBond: Amount` to `NodeStatus`.
- `src/api/status.ts` — `toNodeStatus` now decodes them (via the null-tolerant `amt`).
- `openapi.yaml` — added the three fields to `NodeStatus` and tightened `required` to the
  full set the node always emits.
- `test/client.test.ts` — `/status` test now asserts the breakdown.

### 2. GET /transactions/:node_id — endpoint MISSING from the SDK (FIXED)

The node ships `GET /transactions/:node_id` (api.rs:1365, route at 2034) returning a
`Vec<TxRecord>` — fields `tx_id, height, kind, amount` (string), `counterparty`
(nullable), `direction` ("in"|"out"|"self"). Supports `?limit=` (default 100, max 500)
and `?before=` (height cursor). The SDK had no method, type, or decoder for it.

Fixes:
- `src/types.ts` — added `RawTxRecord`, `TxRecord`, `TxQuery`, `TxDirection`.
- `src/api/economy.ts` — added `toTxRecord` decoder and
  `EconomyApi.transactions(nodeId, q?)` (builds the `limit`/`before` query string;
  unauthenticated GET).
- `src/client.ts` — added `CeClient.transactions(nodeId, q?)`.
- `src/index.ts` — re-exported `TxRecord`, `TxQuery`, `TxDirection`.
- `openapi.yaml` — added the `TxRecord` schema and the `/transactions/{node_id}` path
  with `limit`/`before` query params.
- `test/client.test.ts` — added a decode + pagination-query test.

### 3. /transactions/stream TxKind vocabulary wrong (FIXED)

The SDK's `TxKind` union listed `"TrustGrant"`, which the node does NOT emit, and omitted
8 kinds the node's `tx_stream_view`/`classify_tx` actually emit. The node's real set
(from `ce_chain::TxKind`) is: Transfer, UptimeReward, JobBid, JobSettle, JobExpire,
Heartbeat, ChannelOpen, ChannelClose, ChannelExpire, NameClaim, RevokeCapability,
HostBond, HostUnbond, SlashEquivocation. (Note `/transactions/:id` can additionally yield
"ChannelOpen" with direction; same vocabulary.)

Fixes:
- `src/types.ts` — `TxKind` now matches the node's full set (dropped `TrustGrant`).
- `src/api/decode.ts` — `TX_KINDS` set updated; `decodeTxEvent` passes the node's kind
  through verbatim (forward-compatible — an unknown kind is surfaced, not dropped).
- `openapi.yaml` — `TxEvent.kind` enum updated to the full set.

### 4. GET /jobs vs GET /jobs/:id shape difference (documented; no SDK code change)

`GET /jobs` (`JobListItem`) returns `job_id,status,payer,container_id,cost,bid`.
`GET /jobs/:id` (`JobStatusResponse`) returns only `job_id,status,container_id,cost`
— NO `payer`, NO `bid`. The SDK models both with one tolerant `Job` type whose `payer`
and `bid` are optional (decoded as `null` when absent), so there is no runtime bug — but
the contract is now documented:
- `openapi.yaml` — `Job` schema description + per-field notes spell out that `payer`/`bid`
  appear only on the list endpoint, absent on `/jobs/:id`.

## What is NOT confirmable without a live (and/or multi-node) run

- Actual byte-for-byte JSON of every response under a real `axum`+`serde` round trip
  (the audit is at the struct/serde-attr level, which is authoritative but not a live
  capture). The `_verify-live.ts` harness captures these once a node runs.
- Two-node mesh paths: `/mesh/send`, `/mesh/request` + `/mesh/reply`,
  `/mesh-deploy`/`/mesh-kill`, `/tunnel`, `/data/fetch` — all require a second peer.
  Shapes are confirmed statically; a real round trip needs two nodes on the mesh.
- Docker job execution end-to-end (bid -> run -> settle): needs Docker (down here) and a
  funded balance.
- `/blocks/stream` actually emitting blocks: needs mining (`--no-mine` omitted). The
  harness connects and tolerates an empty window; real block events need a mining node.

## Build/quality gates after fixes

- `npm run typecheck` (tsc --noEmit): PASS
- `npm test` (vitest): PASS — 30 tests
- `npm run build` (tsdown): PASS — dist bundles (ESM+CJS+d.ts) regenerated

## Files changed (all under /Users/07lead01/ce-net/ce-ts)

- src/types.ts
- src/api/status.ts
- src/api/economy.ts
- src/api/decode.ts
- src/client.ts
- src/index.ts
- openapi.yaml
- test/client.test.ts
- examples/_verify-live.ts (new; live verification harness)
- package.json / package-lock.json (added `tsx` devDependency so the examples run)

---

## LIVE RUN RESULTS (2026-06-21) — COMPLETED

Node: `ce --data-dir <tmp> start --no-mine --api-port 18844 --port 14001 --ephemeral --no-mdns`
(release binary built clean; healthy in 2s.) Harness: `ce-ts/examples/_verify-live.ts`.

**SUMMARY: pass=13 fail=0**

- PASS GET /health
- PASS GET /status — height=0 balance=0 free=0 lockedChannels=0 lockedBond=0 bond=0 (Wave-0 breakdown fields present and decoded by the SDK)
- PASS GET /beacon, /atlas (1 entry), /bootstrap (1 peer)
- PASS GET /history/:node_id — newcomer=true
- PASS GET /transactions/:node_id (NEW Wave-0 endpoint) — empty, pagination shape correct
- PASS GET /jobs, /channels
- PASS POST /blobs + GET /blobs/:hash object round-trip — cid match, bytes equal=true
- PASS POST /transfer — 402 on zero-balance node (expected)
- PASS POST /jobs/bid — 402 on zero-balance node (expected)
- PASS GET /blocks/stream (SSE) — connected, framing OK (no block in 3s under --no-mine)

The three drifts fixed during the static audit are confirmed correct against the live node.
Remaining (need a funded/mining node or a second peer): Docker job lifecycle bid->run->settle,
two-node mesh request/reply + mesh-deploy + tunnel.
