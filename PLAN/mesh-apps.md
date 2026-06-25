# Real mesh apps on CE

Status: design + conversion plan. Author: Leif Rydenfalk.
Scope of this doc's edits: `ce-gov` and this file only. The ce-hub / ce-app sections
are cooperative notes to other teams, NOT work to be done in their repos here.

The owner's rule, restated:

> An app registers a frontend with `ce-app` and exposes ONLY the frontend's domain
> over HTTP. Everything else — app state and device-to-device communication — rides
> the MESH. The only HTTP an app's own code touches is its LOCAL node at
> `http://127.0.0.1:8844` (the designed SDK boundary), which routes over libp2p.

---

## 1. The verified mesh API surface (node is ground truth)

Source of truth: `ce/crates/ce-node/src/api.rs` (router at the `pub async fn start`
near line 2042) and `ce/crates/ce-node/src/lib.rs` (`AppMessage` struct, line 156).
Cross-checked live against the relay node (`root@178.105.145.170`, `127.0.0.1:8844`,
on current `main`) on 2026-06-24. Every route below was confirmed to exist.

Base URL: `http://127.0.0.1:8844`.

### Auth model (confirmed by live test)
- Middleware `require_api_token` (api.rs ~line 145) gates **every non-GET (mutating)
  request** with `Authorization: Bearer <token>`. GET/HEAD are open.
- Token is derived from the node identity and written to `<data_dir>/api.token`
  (chmod 600). Same-host clients (`ce` CLI, ce-rs/ce-ts apps, ce-gov in Node) read it
  there; in browser code it comes from the page's own node bridge, never hardcoded.
- Live proof: `POST /mesh/publish` without a token returned **401**; with
  `Bearer $(cat ~/.local/share/ce/api.token)` returned **200**.
- CORS: a localhost-scoped layer allows **GET only** cross-origin (so a localhost
  dashboard can read streams). Mutating routes are not cross-origin reachable — a
  browser app must POST to its own-origin node bridge, not a foreign node's API.

### Mesh messaging — directed send / request / reply
| Method | Path | Auth | Body (JSON) | Returns |
|---|---|---|---|---|
| POST | `/mesh/send` | Bearer | `{ to: <64hex nodeId>, topic: string, payload_hex: string }` | `{ status: "delivered" }` (peer `AppAck`) |
| POST | `/mesh/request` | Bearer | `{ to, topic, payload_hex, timeout_ms?: number=30000 }` | `{ payload_hex }` (peer's reply) or 504 if no reply in time |
| POST | `/mesh/reply` | Bearer | `{ token: u64, payload_hex: string }` | `{ status: "replied" }` |
| GET | `/mesh/messages` | open | — | `[AppMessage]` snapshot ring |
| GET | `/mesh/messages/stream` | open | — | SSE of `AppMessage` (inbound send + request + pubsub) |

`AppMessage` (the EXACT shape — `ce-node/src/lib.rs:156`; note there is **no `kind`
field**, contrary to some SDK docs):
```json
{
  "from": "<64hex sender nodeId>",
  "topic": "<app topic>",
  "payload_hex": "<hex>",
  "received_at": 1719250000,
  "reply_token": 12345        // present ONLY for inbound /mesh/request; omit => fire-and-forget or pubsub
}
```
A service answers a request by POSTing `/mesh/reply` with the inbound `reply_token`.

### Mesh pub/sub (the event bus)
| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/mesh/subscribe` | Bearer | `{ topic: string }` | `{ status: "subscribed" }` (idempotent, lasts node lifetime) |
| POST | `/mesh/publish` | Bearer | `{ topic: string, payload_hex: string }` | `{ status: "published" }` |

`publish` auto-subscribes the publisher, signs the message with the node identity
(subscribers can verify authorship), and broadcasts over gossipsub. Inbound pubsub
arrives on the **same** `/mesh/messages/stream` SSE (`reply_token` absent).

### Content-addressed blobs (the state layer)
| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/blobs` | Bearer | raw bytes (`--data-binary`, not JSON) | `{ hash: <64hex sha256> }`, 201 |
| GET | `/blobs/:hash` | open | — | raw bytes (200), or 404 if not local and not found in mesh |

PUT-by-hash semantics via POST: hash is `sha256(body)`, self-verifying and immutable.
On store, the node announces the chunk to the DHT (`provide_chunk`). On GET miss, the
node discovers providers via the DHT, `FetchChunk`s, verifies bytes against the hash,
caches + re-announces — popular blobs self-replicate. Live proof: POST returned
`{"hash":"618ca3...1de1"}`.

(There is also `POST /data/fetch` for paid cross-node chunk pulls with receipts — not
needed by ce-gov; blobs above are the free path.)

### Service discovery (DHT) + names
| Method | Path | Auth | Body / Param | Returns |
|---|---|---|---|---|
| POST | `/discovery/advertise` | Bearer | `{ service: string }` | `{ status: "advertised" }` (re-call periodically; records expire) |
| GET | `/discovery/find/:service` | open | path: service name | `{ service, providers: [<64hex nodeId>] }` |
| POST | `/names/claim` | Bearer | `{ name: string }` (3-32 chars, `[a-z0-9-]`, no leading/trailing `-`) | `{ status: "submitted" }` (on-chain `NameClaim` tx) |
| GET | `/names/:name` | open | path: name | `{ name, node_id }` or 404 |

Live proof: `GET /discovery/find/...` returned `{"service":...,"providers":[]}` (200);
`GET /names/<unclaimed>` returned 404. `advertise` returns the node's own id among
providers when found.

### Supporting reads ce-gov already uses (open GETs)
`/status`, `/beacon` (verifiable randomness `{height,hash}`), `/history/:node_id`
(reputation substrate), `/signals` + `/signals/stream` + `/signals/send` (CEP-1; auth
on send). These remain valid; the plan below moves ce-gov OFF signals-as-an-event-bus
and ONTO mesh pubsub, while keeping CEP-1 signals for what they are (bonded,
chain-anchored abuse evidence).

### Routes deliberately NOT used by mesh apps
`/exec`, `/sync/*`, `/mesh-deploy`, `/mesh-kill`, `/tunnel` are host-mutating /
transport primitives owned by the `rdev` app and the personal-mesh-OS path, not the
app-state surface. Mesh apps use only the messaging / pubsub / blobs / discovery rows
above plus open reads.

---

## 2. The canonical pattern

Three concerns, three mesh primitives. No app-owned HTTP server, no central DB.

| Concern | Mesh primitive | Node route |
|---|---|---|
| **State** (durable data) | content-addressed blobs, DHT-replicated | `POST /blobs`, `GET /blobs/:hash` |
| **Events** (live changes) | pub/sub on an app topic | `POST /mesh/publish` + `/mesh/subscribe` + `GET /mesh/messages/stream` |
| **Queries** (ask a peer) | request/reply to a DHT-advertised service | `/discovery/advertise` + `/discovery/find/:svc` + `/mesh/request` + `/mesh/reply` |
| **Frontend** (the only HTTP) | static bundle on `ce-app` | served at `https://<id>.ce-net.com/` |

Data flow of a write: app serializes an immutable artifact -> `POST /blobs` -> gets a
`cid` (= content hash) -> `POST /mesh/publish` an index event `{type, id, cid, height}`
on the app topic. Subscribers receive the event on their SSE stream and `GET /blobs/:cid`
to materialize it. A late joiner asks any advertised service peer via `/mesh/request`
"give me your current index", then back-fills blobs by cid. The blob store is the
source of truth; pubsub is the cache-invalidation / live-feed; the service is the
catch-up/query endpoint. Nothing is centralized.

### 2a. Node-side mesh service skeleton (runs next to a node; e.g. ce-gov in Node)

```js
// A mesh service: advertises itself in the DHT, serves queries via request/reply,
// and emits events via pubsub. Pure SDK calls to the LOCAL node only.
import { CeClient } from "@ce-net/gov"; // thin /mesh/* + /blobs wrapper (see ce.js)

const SERVICE = "ce-gov.v1";       // DHT service name (what peers find)
const TOPIC   = "ce-gov.events.v1"; // pubsub topic (what peers subscribe to)
const ce = new CeClient({ base: "http://127.0.0.1:8844", token: process.env.CE_API_TOKEN });

// 1) STATE: write an immutable artifact, return its cid.
async function putArtifact(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const { hash } = await ce.meshPutBlob(bytes); // POST /blobs (raw body)
  return hash;
}
async function getArtifact(cid) {
  const bytes = await ce.meshGetBlob(cid);      // GET /blobs/:cid (mesh-resolves on miss)
  return bytes && JSON.parse(new TextDecoder().decode(bytes));
}

// 2) EVENTS: announce a new artifact to the topic.
async function announce(ev) {                   // ev = { type, id, cid, height }
  await ce.meshPublish(TOPIC, hexOf(JSON.stringify(ev)));
}

// 3) QUERY SERVICE: advertise + answer "index" / "get" requests from peers.
const index = new Map(); // id -> { cid, type, height }  (the local view, rebuilt from blobs+pubsub)

async function startService() {
  await ce.meshSubscribe(TOPIC);                // join the topic mesh
  await ce.meshAdvertise(SERVICE);              // become discoverable
  setInterval(() => ce.meshAdvertise(SERVICE), 10 * 60_000); // re-advertise; records expire

  // One SSE stream carries BOTH inbound pubsub events AND inbound /mesh/request.
  ce.meshStream(async (m) => {                  // GET /mesh/messages/stream
    const body = JSON.parse(fromHex(m.payload_hex));
    if (m.reply_token != null) {
      // It's a QUERY (request/reply). Answer over the held channel.
      let reply = {};
      if (m.topic === SERVICE && body.op === "index") reply = { index: [...index.values()] };
      if (m.topic === SERVICE && body.op === "get")   reply = await getArtifact(body.cid);
      await ce.meshReply(m.reply_token, hexOf(JSON.stringify(reply))); // POST /mesh/reply
    } else if (m.topic === TOPIC) {
      // It's an EVENT (pubsub). Update the local index; the blob self-resolves on demand.
      index.set(body.id, { cid: body.cid, type: body.type, height: body.height });
    }
  });
}
```

The request side (a peer querying this service):
```js
const { providers } = await ce.meshFind(SERVICE);      // GET /discovery/find/ce-gov.v1
const peer = providers[0];
const r = await ce.meshRequest(peer, SERVICE,           // POST /mesh/request (waits)
            hexOf(JSON.stringify({ op: "index" })), 15000);
const { index } = JSON.parse(fromHex(r.payload_hex));
```

### 2b. Frontend snippet (the ONLY HTTP; talks to the page's local node bridge)

The static bundle is served by `ce-app` at `https://<id>.ce-net.com/`. Its JS talks to
the **local** node API (loopback, or the browser-node bridge `ce-hub` injects), never
to a central backend:

```js
const NODE = "http://127.0.0.1:8844";          // or window.__CE_NODE__ in a browser node
const TOPIC = "ce-gov.events.v1";

// live feed — open GET SSE, no token needed
const es = new EventSource(`${NODE}/mesh/messages/stream`);
es.onmessage = (e) => {
  const m = JSON.parse(e.data);                 // {from, topic, payload_hex, received_at, reply_token?}
  if (m.topic !== TOPIC || m.reply_token != null) return;
  const ev = JSON.parse(fromHex(m.payload_hex));
  renderNewProposal(ev);                        // then GET /blobs/<ev.cid> to materialize
};

// materialize an artifact — open GET, mesh-resolves on miss
async function load(cid) {
  const res = await fetch(`${NODE}/blobs/${cid}`);
  return res.ok ? await res.json() : null;
}
```
Writes from the browser (publish/blob-put) go through the node bridge with the token
the bridge holds — the app frontend never embeds a token or hits a foreign node.

`ce-app` usage (document-only; do NOT modify ce-app): `ce-app deploy` builds the
frontend and serves the static files at `https://<id>.ce-net.com/` (and
`/apps/<id>/`). There is no backend compute on the hub — exactly why state/events
must ride the mesh, not a hub DB.

---

## 3. Anti-pattern: the hub's centralized `/db` + `/rt` ("cheating with HTTP")

(Cooperative note to the ce-hub team. Do NOT implement here — `web/ce-hub` is theirs.)

Today some apps keep state in the hub's in-memory KV (`/db`) and live events in hub
"rooms" (`/rt`). That is a **centralized HTTP backend wearing a mesh costume**:

- **Single point of failure & trust.** The hub holds the canonical app state. If it
  restarts, in-memory KV/rooms are gone; if it is unreachable, every node's app is
  down. The mesh's whole point — no central authority, survive node churn — is voided.
- **Not content-addressed.** `/db` values are mutable and unverifiable; a compromised
  hub can silently rewrite app state. Blobs are `sha256`-named, immutable, and
  self-verifying — tamper shows up as a hash mismatch.
- **Not device-to-device.** `/rt` rooms funnel every event through the hub instead of
  gossiping peer-to-peer. Latency, censorship surface, and cost all concentrate there.
- **It bypasses the SDK boundary.** App code is supposed to touch only its LOCAL node.
  Calling a remote hub `/db`/`/rt` is a second, privileged HTTP dependency the owner's
  rule forbids.

What to use instead (a one-to-one swap onto primitives that already exist on-node):

| Hub cheat | Mesh-native replacement | Node route |
|---|---|---|
| `PUT /db/:k` (mutable value) | put immutable blob, key by content hash | `POST /blobs` |
| `GET /db/:k` | fetch by cid (DHT-resolves on miss) | `GET /blobs/:hash` |
| mutable "latest" pointer | publish `{key, cid}` on a pubsub topic; subscribers keep last-write-wins | `/mesh/publish` + `/mesh/subscribe` |
| `/rt` room broadcast | pubsub publish on the app topic | `/mesh/publish` |
| `/rt` room subscribe | SSE of inbound mesh messages | `GET /mesh/messages/stream` |
| "who has the state?" | advertise a query service; find providers; request the index | `/discovery/advertise` + `/discovery/find/:svc` + `/mesh/request` |

Suggested hub migration (their call, their repo): make `/db` a thin **blob/DHT-backed**
facade (write -> `/blobs`, read -> `/blobs/:hash`, with a pubsub "latest pointer" topic)
and make `/rt` a **mesh-pubsub-backed** facade (`room` -> topic, send -> `/mesh/publish`,
subscribe -> `/mesh/messages/stream`). The hub then becomes a *bootstrap/relay* for
browser nodes that cannot speak libp2p directly, not the system of record. That keeps
the API browser-friendly while moving the trust + durability onto the mesh.

The legitimate, unavoidable role the hub keeps: serving static frontends (`ce-app`),
and **relay/bootstrap for browser nodes** (a phone tab cannot dial libp2p TCP/QUIC, so
it joins via the hub's relay). That is transport bootstrap, not app state — and is fine.

---

## 4. Per-app conversion checklist

For each app: what is already correct (local-node SDK boundary), what to ADD
(mesh state/events/service + `ce-app` frontend), and what is unavoidable-HTTP.

### ce-gov (this repo — the contract is §5)
- **Correct already:** all IO goes through one injected `CeClient` against the local
  node (`ce.js`); every artifact is content-addressed (`id == sha256(signing payload)`);
  modules never touch host resources; amounts stay decimal strings.
- **Cheat to remove:** state lives in a **stub** blob store (`memoryBlobStore` /
  `signalBlobStore`), and discovery/events ride **CEP-1 signals** as an ad-hoc event
  bus (`proposals.js` broadcasts an index entry as a signal; `policy.js` re-resolves on
  `signalsStream`). Signals are bonded, chain-anchored, and capped at a 100-entry window
  — wrong tool for a live app event bus.
- **Add:** real blob store wired to `POST/GET /blobs`; a mesh **pubsub** event bus on
  `ce-gov.events.v1` for proposal/argument/vote/verdict/policy announcements; a
  DHT-advertised **query service** `ce-gov.v1` answering `index`/`get` for catch-up; a
  `ce-app` static frontend (the existing `web/` policy UI, deployed via `ce-app`).
- **Keep CEP-1 signals** only for their real purpose: bonded `AbuseReport` evidence
  (`monitor.js`) that must be chain-anchored. Discovery/index moves to pubsub.
- **Unavoidable HTTP:** the browser policy UI (loopback / browser-node bridge) and hub
  relay for browser nodes. Both are transport, not app state.

### ce-sched (distributed work scheduler)
- **Correct:** bids/settles already go through the node's chain + job API (`/jobs/*`),
  which is the on-chain economy primitive — not a cheat.
- **Add:** advertise a `ce-sched.v1` service so workers/clients discover the scheduler
  over the DHT instead of a hardcoded endpoint; publish job-lifecycle events
  (queued/started/settled) on `ce-sched.events.v1` pubsub; persist job specs/results as
  blobs (cid in the bid) rather than inline or hub KV.
- **Unavoidable HTTP:** none beyond the local node; a dashboard frontend via `ce-app`.

### ce-bench (benchmarking-as-an-app)
- **Correct:** runs work via the local node; reads `/atlas`, `/netgraph`, `/beacon`.
- **Add:** publish results on `ce-bench.events.v1`; store full result sets as blobs and
  announce the cid; advertise `ce-bench.v1` so a node can request another's latest
  signed benchmark via request/reply (verifiable, beacon-stamped) instead of scraping a
  central leaderboard.
- **Unavoidable HTTP:** leaderboard frontend via `ce-app` (reads the local node's
  subscribed view).

### ce-tabnet (model / tabular-net app)
- **Correct:** inference/training submitted through the local node.
- **Add:** model weights + datasets as **blobs** (content-addressed, mesh-replicated,
  self-verifying — ideal for large immutable artifacts); reference weights by cid in
  job specs; publish model-version events on `ce-tabnet.events.v1`; advertise a
  `ce-tabnet.v1` registry service that answers "latest cid for model X" via
  request/reply.
- **Unavoidable HTTP:** UI via `ce-app`; large-blob pull may use `/data/fetch` (paid
  chunk path) for metered transfer, still node-local.

### ce-worker (worker/agent runtime)
- **Correct:** executes assigned work via the local node; earns via the chain.
- **Add:** advertise `ce-worker.v1` with its capabilities so schedulers discover it via
  the DHT (no registry server); subscribe to the scheduler's events topic for
  assignments; report status via `/mesh/send` (directed) or a status pubsub topic;
  fetch inputs / push outputs as blobs by cid.
- **Unavoidable HTTP:** none beyond the local node (worker is headless); optional status
  page via `ce-app`.

Pattern across all five: **discover via DHT, exchange state as blobs, drive live UX via
pubsub, answer catch-up via request/reply, and never run an app-owned HTTP backend.**
The only HTTP an app touches is its own local node; the only public HTTP is the static
frontend on `ce-app` and the hub's relay/bootstrap for browser nodes.

---

## 5. ce-gov conversion contract (files to add / change)

All edits stay under `/Users/07lead01/ce-net/ce-gov`. The change is additive and
backward-compatible: the existing stub stores stay as the default for offline tests; the
real mesh backends are opt-in via the `CeClient` and a new `mesh.js` module, then wired
into the `Governance` facade.

### CHANGE — `src/ce.js` (add the verified mesh routes; keep blob pluggability)
Add methods to `CeClient`, each a thin wrapper over the routes in §1:
- `meshPutBlob(bytes)` -> `POST /blobs` with raw `bytes` body (NOT JSON), returns `{hash}`.
- `meshGetBlob(cid)` -> `GET /blobs/:cid`, returns `Uint8Array|null`.
- `meshPublish(topic, payload_hex)` -> `POST /mesh/publish`.
- `meshSubscribe(topic)` -> `POST /mesh/subscribe`.
- `meshSend(to, topic, payload_hex)` -> `POST /mesh/send`.
- `meshRequest(to, topic, payload_hex, timeout_ms)` -> `POST /mesh/request`, returns `{payload_hex}`.
- `meshReply(token, payload_hex)` -> `POST /mesh/reply`.
- `meshAdvertise(service)` -> `POST /discovery/advertise`.
- `meshFind(service)` -> `GET /discovery/find/:service`, returns `{service,providers}`.
- `meshStream(onMsg, onErr)` -> SSE wrapper over `GET /mesh/messages/stream` (reuse the
  existing `signalsStream` body-parsing logic; yields `AppMessage` objects with the
  exact fields from §1 — `from,topic,payload_hex,received_at,reply_token?`).
Add `export function httpBlobStore(ce)` implementing `{put,get}` over `meshPutBlob`/
`meshGetBlob` (the §1 docstring already anticipates this: "When the node exposes a real
blob route, add `httpBlobStore(base)` here without touching callers"). Default
`blobStore` stays `memoryBlobStore()` so offline tests are unaffected; pass
`httpBlobStore(ce)` to go live.

### ADD — `src/mesh.js` (the governance mesh backend: events + query service)
New module, dependency-injected `CeClient` only, mirroring the §2a skeleton:
- Constants `GOV_SERVICE = "ce-gov.v1"`, `GOV_TOPIC = "ce-gov.events.v1"`.
- `announce(ce, ev)` — publish a discovery-index event `{type,id,cid,height}` on
  `GOV_TOPIC` (REPLACES `proposals.js` `broadcastIndex` over signals).
- `startGovService(ce, { resolve })` — `subscribe(GOV_TOPIC)` + `advertise(GOV_SERVICE)`
  (with a re-advertise interval), open `meshStream`, and: on a pubsub event update the
  local index; on a request (`reply_token` present) answer `op:"index"` /
  `op:"get"` from blobs. Returns a `{ stop(), index() }` handle.
- `fetchIndex(ce)` — `meshFind(GOV_SERVICE)` then `meshRequest(peer, GOV_SERVICE,
  {op:"index"})`, for a fresh node to catch up (REPLACES scanning `GET /signals`).
- Pure helpers (`encodeEvent`/`decodeEvent`, hex) kept testable offline.

### CHANGE — `src/proposals.js`
- Replace the CEP-1 discovery-index path (`broadcastIndex` via `ce.signalsSend`, and the
  `GET /signals` scan in `resolveCid`/load-by-id/load-arguments around lines 79-95,
  234-255, 431-439) with `mesh.js`: `announce(...)` on create; resolve id->cid via the
  local mesh index (with `fetchIndex` fallback) instead of scanning signals.
- Keep artifact build/validate/content-addressing unchanged. Blob read/write stays
  `ce.putBlob/getBlob` (now backed by `httpBlobStore` in production).

### CHANGE — `src/policy.js`
- `subscribe(ce, cb, opts)` (line ~338): watch `GOV_TOPIC` via `meshStream` (filter
  `policy`/`verdict` event types) instead of `ce.signalsStream` re-resolving on every
  signal. `activePolicySet` resolves from blobs by cid carried in the events.

### CHANGE — `src/voting.js`
- `putBlob` writes (lines 173, 447) are unchanged (already blob-based); add an
  `announce(ce, {type:"vote"|"verdict", id, cid, height})` after each so peers see new
  votes/verdicts live instead of polling. Test stub `putBlob` at line 514 stays.

### KEEP — `src/monitor.js`
- Unchanged. `AbuseReport` stays a **CEP-1 signal** (bonded, chain-anchored evidence) —
  that is its correct home, not the app event bus.

### CHANGE — `src/index.js` (`Governance` facade)
- Construct the production `CeClient` with `blobStore: httpBlobStore(ce)`.
- `start()/stop()` lifecycle that calls `startGovService(...)` so a Node-hosted
  governance node advertises the service and serves catch-up queries.
- `watchPolicy` (line 318) delegates to the mesh-pubsub `Policy.subscribe`.

### ADD — frontend deploy via ce-app (document-only commands; no ce-app edits)
- The existing `web/` (policy UI: `index.html`, `policy.html/.js/.css`) becomes the
  static frontend. Point its node calls at the local node (`http://127.0.0.1:8844` or
  the browser-node bridge) and the live feed at `GET /mesh/messages/stream` filtered to
  `GOV_TOPIC` (per §2b). Deploy with `ce-app deploy` (used as-is) to get
  `https://<id>.ce-net.com/`.

### ADD — docs + example
- `docs/mesh-backend.md` in ce-gov: the three primitives, the `GOV_SERVICE`/`GOV_TOPIC`
  names, and the event schema `{type,id,cid,height}`.
- `examples/mesh-roundtrip.js`: create a proposal on node A, observe the pubsub event +
  blob materialization on node B, and `fetchIndex` catch-up — runnable against two local
  nodes (or one node + the live relay).

### Acceptance
- `memoryBlobStore` default keeps all existing unit tests / offline examples green.
- With a live node + token: create -> blob cid returned by `POST /blobs`; event seen on
  a second node's `/mesh/messages/stream`; `GET /blobs/:cid` materializes the artifact;
  `meshFind("ce-gov.v1")` lists the service node; `meshRequest(...,{op:"index"})` returns
  the index. No ce-gov code path depends on the hub `/db` or `/rt`.
