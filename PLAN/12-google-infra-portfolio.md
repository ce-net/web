# 12 — Google Infrastructure on CE: The Portfolio

**Thesis:** Google's stack is a pile of centrally-run plumbing — identity, authenticated messaging, content-addressed storage, payments, capabilities, scheduling — reinvented per-product. CE provides exactly that plumbing as *decentralized primitives*. So "clone Google on CE" is mostly **assembly of existing CE apps**, not greenfield engineering, for the entire storage/compute/auth/data/realtime core. The hard greenfield bets (Mail, Meet, BigQuery) reduce to one of three things CE deliberately does *not* give you: a global low-latency edge fleet, a trusted serialization point for invariants, or cheap verification of opaque compute. Each already has a named (if unfinished) answer in the frontier roadmap.

**Governing rule (honor the architecture):** every product here is an **app over the SDK** (`ce-rs` + `ce-coord` + `ce-cap`), reached over libp2p `AppRequest`/reply + pubsub + stream + tunnel, authorized by signed attenuating capability chains. **No new node endpoints. No allowlists. No stored ip:port.** Authorization between nodes is always a `ce-cap` chain (this is exactly how one node authorizes another to use a service). Money is integer base units, decimal strings on the wire, settled over payment channels.

---

## 1. The Ranked Portfolio

Effort: **S** (thin layer over an existing CE app, days–weeks) · **M** (real app, but every primitive exists, weeks) · **L** (substantial app + one partial primitive, months) · **XL** (a multi-quarter engine + a frontier-grade hard part).

Score = (Impact × Fit) / Effort. Ranked by score.

| # | Product (Google) | CE primitive mapping (compose, don't reinvent) | Have / Greenfield | Effort | Impact | Why CE wins |
|---|---|---|---|---|---|---|
| 1 | **Cloud Storage / GCS / S3** | blobs + ce-pin (content-addressed objects, replication); buckets = ce-cap-scoped namespaces; ranged reads = chunk-index fetch | **Have** (blobs/ce-pin) | S | High | Content-addressed = perfect cache keys + dedup; geo-replicated by pinning; **no egress fees**, server can't read sealed objects |
| 2 | **IAM** | ce-cap *is* IAM — signed attenuating chains, offline-verifiable | **Have** (ce-cap) | S | High | Capabilities strictly beat ACLs: attenuating, offline-verifiable, **no policy server**, no `O(shares)` host state |
| 3 | **Pub/Sub** | mesh Gossipsub (topics) + ce-coord durable log for at-least-once + replay | **Have** (≈pubsub) | S–M | High | Native topics, **no broker to provision**; durable delivery via a collection log; federated by default |
| 4 | **Firestore (doc DB + realtime)** | ce-coord CRDTs (incl. **Merged** multi-writer + **Snapshot**); realtime = pubsub; offline = CRDT merge; large fields = blob CIDs | **Have** (ce-coord) | M | High | Offline-first + multi-device sync are **structural, not bolted-on**; the chain covers uniqueness/money where CRDTs provably can't |
| 5 | **Compute Engine / Cloud Run** | jobs/cells (containers) + atlas (host selection) + tunnel (ingress) + channels (pay) | **Have** (jobs) | S–M | High | Containers-on-mesh already; pay credits, any node, **no region lock-in**, no per-request GCP tax |
| 6 | **Cloud Functions (FaaS)** | jobs as short/WASM cells + ce-pubsub triggers + channels | **Have** (jobs) | S–M | Med–High | Functions = ephemeral cells; WASM frontier → sub-ms cold start; **event triggers are native pubsub** |
| 7 | **Drive** | blobs/ce-pin (files) + ce-drive + rdev chunk/delta engine + ce-cap sharing + change-feed cursor over pubsub | **Have** (ce-drive) | S | High | Capability shares (attenuating, no ACL table) not silos; E2E, content-addressed, **server can't scan your files** |
| 8 | **Cloud CDN** | blobs/ce-pin (every pinning node = edge) + relay edge | **Have** (≈ce-pin) | S–M | Med–High | Every pinning node is a CDN edge; content-addressed = perfect cache keys; **near-free given ce-pin** |
| 9 | **GKE (managed k8s)** | swarm (scheduler) + jobs + ce-cap + atlas | **Have** (swarm) | M–L | High | Swarm schedules cells across the mesh; **no control plane to run or pay for** |
| 10 | **Docs / Sheets / Slides** | ce-coord text/grid CRDTs + ce-notes + blobs (export) | **Partial** (ce-notes) | M–L | High | Local-first CRDT, offline, **no server reads your doc**; collaborative editing is the CRDT home-run case |
| 11 | **Keep / Tasks / Contacts** | ce-coord collections (RMap) + identity | **Have/Partial** | S | Med | Tiny ce-coord apps; consumer breadth at near-zero cost; contacts keyed to verifiable CE identities |
| 12 | **Calendar** | ce-coord shared collection (events) + pubsub (invites) + ce-cap (sharing) | Greenfield | M | Med | Invites = signed mesh messages between identities; **no central server holds your schedule** |
| 13 | **Secret Manager** | ce-cap (who) + blobs sealed (what) + identity (decrypt) | Greenfield | M | Med | Secrets sealed to capability holders; **no central vault to breach** |
| 14 | **Cloud Tasks / Scheduler** | ce-coord durable queue + heartbeat timers (cron) + cells | **Partial** | S–M | Med | Durable queue = collection; cron = scheduled cells; reuse the heartbeat loop |
| 15 | **Chat** | pubsub (rooms = topics) + ce-coord (history) + ce-cap (access) | Close to pubsub | M | Med–High | Rooms are cap-gated gossip topics; history is a collection; **federated Slack by default** |
| 16 | **Cloud DNS** | Kademlia DHT + on-chain NameClaim | **Partial** | M | Med | Names resolve via DHT/chain; **censorship-resistant naming**, first-claim consensus-enforced |
| 17 | **Load Balancing** | atlas (capacity) + mesh routing + relay | **Partial** | M | Med | Atlas-guided host selection (planned); LB is routing policy over it |
| 18 | **Forms** | ce-notes (form def, signed blob) + ce-coord (responses) + ce-cap | Greenfield | M | Med | Form = signed blob; responses append to a collection; **anonymous-but-verifiable** via caps |
| 19 | **Photos** | blobs/ce-pin + jobs (thumbnail/embedding cells) + ce-coord (albums) | **Partial** (blobs) | L | Med–High | Storage is blobs; ML search runs as *your* jobs — **Google never trains on your photos** |
| 20 | **Meet (video conf)** | mesh AppRequest/reply (SDP/ICE signaling) + pubsub (rooms) + relay/DCUtR + relay-incentives (TURN) + SFU cell | **Greenfield** | L | High | P2P media over libp2p; **no central SFU sees your call**; a *market* of paid relays, not Google's fleet |
| 21 | **Gmail / Email** | identity (address = NodeId) + app-messaging (envelope) + blobs (body/attachments) + channels (postage) + ce-cap + SMTP gateway cell | **Greenfield** | XL | High | Auth/anti-spoof **free** (signed envelopes); postage makes spam uneconomical; **un-deplatformable**, E2E |
| 22 | **Dataflow (pipelines)** | jobs DAG + mesh streams + swarm (schedule) | Greenfield | L | Med | Pipeline = DAG of cells scheduled by swarm; backpressure over streams |
| 23 | **Bigtable** | ce-coord sharded collections (rendezvous-hash) + blobs | Greenfield | L | Med | Reuse the chain-archive rendezvous-hash sharding pattern |
| 24 | **BigQuery (analytics)** | data-layer (columnar Parquet/Arrow blobs) + swarm map/reduce cells + channels + reduce over app-messaging | **Greenfield** | XL | High | Run query cells over *your own* blobs; **no per-TB-scanned tax**, data never leaves the mesh — CE's parallel core is the right fit |
| 25 | **Spanner (global SQL)** | ce-coord Raft + a SQL/transaction layer | Greenfield | XL | Med | CE gives the consensus substrate; distributed SQL is the (large) work |
| 26 | **Maps Platform** | blobs (OSM tiles) + jobs (routing engine cell) | Greenfield | XL | Med | Self-host tiles as blobs, routing as a cell; **no per-call billing or tracking** |

---

## 2. Recommended Build Order (Waves)

Decisive principle: **ship the substrate that every other product depends on first, leading with thin layers over existing CE apps.** Storage, auth, and the bus are load-bearing for everything downstream, so they go first even though they're "boring." The XL greenfield engines come *last*, only after the substrate is proven end-to-end, because each is a multi-quarter machine that would otherwise starve the cheap wins.

### Wave 0 — Substrate (lead here; all S, all thin layers over existing apps)
The non-negotiable foundation. Everything else stores in **ce-storage**, is gated by **ce-iam**, and is wired by **ce-pubsub**.
- **ce-storage** (GCS/S3) — bucket API over blobs/ce-pin. *The anchor; every other product writes here.*
- **ce-iam** (IAM) — expose ce-cap as a product. *Differentiator on day one; every product authorizes through it.*
- **ce-pubsub** (Pub/Sub) — Gossipsub + durable ce-coord log. *The glue that wires products together (FaaS triggers, DB change-feeds, Chat rooms).*

### Wave 1 — Data & Compute (the developer magnet; S–M)
With substrate live, ship the two things that make CE a *cloud you can build on*.
- **ce-db** (Firestore) — ce-coord **Merged** CRDT collections + realtime pubsub + Snapshot compaction. *The app-builder magnet.*
- **ce-run** (Compute/Cloud Run) — productize jobs into deploy + autoscale-across-mesh.
- **ce-fn** (Cloud Functions) — cells/WASM as FaaS, triggered by ce-pubsub. *Cheap once ce-run exists.*

### Wave 2 — Consumer surface & edge (breadth; S–M)
The "yours, not Google's" consumer wedge — mostly tiny ce-coord CRDT apps + the existing drive.
- **ce-drive** (Drive) — polish ce-drive: capability sharing, change-feed, consumer UX.
- **ce-cdn** (Cloud CDN) — pinning network as edge cache; demonstrates mesh economics.
- **ce-suite-lite** — Keep / Tasks / Contacts / **Calendar** / **Sheets** as ce-coord CRDT apps (one collection schema each).

### Wave 3 — Orchestration & ops (M–L)
- **ce-gke** (swarm orchestrator) — harden swarm into a product.
- **ce-secrets**, **ce-scheduler**, **ce-dns**, **ce-lb** — fill out the ops layer over atlas/NameClaim/ce-coord.

### Wave 4 — The hard greenfield (XL; only after substrate is proven)
- **ce-mail** (Gmail) — mailbox store-and-forward + encryption envelope + SMTP gateway. *Closest to shippable of the three.*
- **ce-meet** (Meet) — signaling is trivial today; the work is TURN-on-relay + SFU cell + topology-aware relay selection.
- **ce-query** (BigQuery) — distributed query engine (DataFusion/Ballista-shaped) over columnar blobs, with redundancy-based result verification.

---

## 3. Top-5 Design Stubs

### 3.1 `ce-storage` — S3/GCS-compatible object store (Wave 0, Effort: **S**)
**Goals:** an S3-API-compatible object store so existing tooling (`aws s3`, SDKs, Terraform) works unmodified against CE; buckets, objects, ranged GET, multipart PUT, presigned-equivalent access — all over content-addressed blobs.
**CE primitives:** blobs/ce-pin (objects = manifest CID over 1 MiB chunks), ce-cap (bucket/prefix scoping, presigned-URL → short-lived cap), ce-coord RMap (bucket → key → CID index), channels (paid pinning/serving), encrypt-before-store (sealed objects host can't read).
**API surface:** S3-dialect gateway cell — `PutObject` (chunk → data-layer, then bind `key → manifest CID`), `GetObject` (+`Range` → compute covering chunk indices, multi-provider swarm-fetch, hash-verified), `ListObjectsV2` (prefix/delimiter/continuation over the RMap), `HeadObject`, `DeleteObject`, `CopyObject` (free — shares CIDs), multipart upload. Presigned URL = a `storage:read @ bucket/prefix` cap with `not_after`.
**Killer demo:** `aws s3 cp ./bigfile s3://my-bucket/ --endpoint-url https://ce-storage.local` then pull it from a *second machine on a different network* — bytes fetched peer-to-peer from whichever node pinned them, no egress fee, dedup proven by uploading the same file twice for zero extra storage.
**Repo:** `ce-storage`.

### 3.2 `ce-iam` — capabilities as an access-control product (Wave 0, Effort: **S**)
**Goals:** expose ce-cap as a first-class IAM product — mint, attenuate, delegate, inspect, and revoke access tokens; offline-verifiable; strictly better than ACLs.
**CE primitives:** ce-cap (signed attenuating chains, `abilities × Resource × Caveats × expiry`), identity (root keys), chain (`RevokeCapability` + root rotation), ce-coord (optional org-policy catalog).
**API surface:** `Mint{audience, abilities, resource, caveats}` → `SignedCapability` chain; `Attenuate{parent, narrower}` (rejects any non-subset via `is_narrower_or_equal`); `Verify{chain, action, resource}` → bool, *local + offline, no policy server*; `Inspect{chain}` → human-readable scope; `Revoke{issuer, nonce}` → on-chain tx; `Wallet` add/list/present. Abilities are opaque strings owned by each consuming app (`storage:read`, `db:write`, `run:deploy`, …).
**Killer demo:** issue `storage:read @ bucket/photos` to a friend; they re-delegate `storage:read @ bucket/photos/2026` to a third party; the storage host verifies the 3-link chain **offline in microseconds** and rejects an attempt to widen back to `bucket/private`. Then `Revoke` the root and watch all descendants die.
**Repo:** `ce-iam` (consumes the `ce-cap` crate; ships CLI + SDK helpers).

### 3.3 `ce-db` — Firestore-class document DB over ce-coord (Wave 1, Effort: **M**)
**Goals:** realtime, offline-capable, collaborative document store with live listeners; CRDT-merged multi-writer; strong-consistency escape hatch for uniqueness/numeric invariants.
**CE primitives:** ce-coord **Merged** (multi-writer CRDT) + **Snapshot** (compaction to a blob) + Stream (realtime), pubsub (per-collection change topic), blobs (large fields via CID), ce-cap (per-collection/doc rules → caps), **chain** (uniqueness/money invariants CRDTs provably can't do) or an opt-in **ce-coord Raft group** (honest-majority, app-scoped strong consistency).
**API surface:** `Collection(name)` → `RMap<DocId, Doc>`; `Set/Merge/Get/Delete`; `Query{where, orderBy, limit}`; `onSnapshot(query)` → live `Stream<Change>` (native pubsub + cursor `Poll`); `runTransaction` → routes to chain (global uniqueness/credits) or Raft group (cooperating writers); `Snapshot/Compact`.
**Killer demo:** two laptops edit the same collection **fully offline**, reconnect, and converge with zero conflicts (CRDT) — then a "claim @username, exactly once" write that *correctly rejects* the second claimant via the chain, proving the honest CRDT-vs-consensus boundary that pretends nothing.
**Repo:** `ce-db`.

### 3.4 `ce-run` / `ce-fn` — serverless compute over jobs (Wave 1, Effort: **S–M**)
**Goals:** deploy a stateless container service that autoscales across the mesh (Cloud Run), and ephemeral event-triggered functions (Cloud Functions), paid per-invocation in credits.
**CE primitives:** jobs/cells (container/WASM execution), `mesh-deploy`/`mesh-kill` (directed placement), atlas (host selection by capacity/price/reputation), tunnel (HTTP ingress to a cell), **ce-pubsub** (event triggers), channels (per-invocation/per-minute billing), ce-cap (who may deploy/invoke).
**API surface:** `Deploy{image|wasm, min, max, scale_signal}` → service handle; `Invoke{service, payload}` over AppRequest → reply; `Trigger{service, topic}` binds a ce-pubsub topic → cold-spawns a cell per event; `Scale`, `Logs` (SSE), `Kill`. Host selection is atlas-guided; payment is a channel receipt per shard/minute.
**Killer demo:** `ce-fn deploy resize.wasm --on ce-storage:bucket/uploads` — drop an image into ce-storage, a function cell spawns *on some paid mesh node*, writes a thumbnail back to the bucket, bills 0.0003 credits, and scales to zero — all with no server you provisioned and no region you chose.
**Repo:** `ce-fn` (and `ce-run` as the long-lived-service sibling; shared scheduler core).

### 3.5 `ce-mail` — identity-native email with SMTP bridge (Wave 4, Effort: **XL**)
**Goals:** durable async messaging to an identity (address = NodeId or NameClaim), E2E-encrypted, with attachments, store-and-forward for offline recipients, postage-gated spam resistance, and legacy SMTP interop.
**CE primitives:** identity (address + free auth — every envelope Ed25519-signed, no spoofing), app-messaging (envelope over `/ce/rpc/1`), blobs/data-layer (sealed body + attachments as CIDs, fetched lazily), **a mailbox node** (always-on store-and-forward, granted `accept-mail-for-me` via ce-cap, paid over a channel — the relay-incentives pattern applied to mail), channels + `BurnProof` (postage), `GET /history/:node_id` (reputation-gated inbox priority), discovery/NameClaim (MX-style mailbox lookup), an **SMTP gateway cell** (MTA holding a DNS MX, SPF/DKIM/DMARC for its domain, wrap/unwrap RFC 5322 ↔ CE envelope).
**API surface:** `Send{to, subject, in_reply_to, body_cid, attachment_cids, postage?}`; `DrainInbox{cursor}` → envelopes (verify sig, fetch+decrypt bodies); `GrantMailbox{provider}` (ce-cap); `Screen/Allow` (per-sender caps); thread by `in_reply_to`; inbox index in a per-user ce-coord RMap (single-writer, no consensus).
**Killer demo:** two CE identities exchange a 40 MB-attachment email — the attachment is *never downloaded until opened* (CID-lazy), the sender is cryptographically unforgeable, and a spam blast from 10,000 fresh identities **fails economically** because each stranger-message demands a refundable postage receipt the recipient's contacts are waived from.
**Honest hard part:** spam/metadata-trust at the SMTP bridge (inherits the legacy spam problem), the mailbox is a who-mails-whom metadata point, and key-loss = identity-loss (needs the frontier's social/hardware key recovery). CE-to-CE mail is *better* than real email; the bridge is exactly as hard as today.
**Repo:** `ce-mail`.

---

## 4. How They Cohere: "CE Cloud" / "CE Workspace"

These are not 26 disconnected clones — they are **one suite sharing four substrates**, which is precisely why CE can ship them as thin layers where Google needs whole org charts:

- **One identity (`ce identity`).** Every product addresses users and nodes by the *same* Ed25519 NodeId. Your ce-mail address, your ce-db writer key, your ce-storage owner, your ce-meet room host — all the same key. No per-product account, no SSO server: the key *is* the account, and every message/object/write is authenticated by it for free.
- **One auth (`ce-cap` / ce-iam).** A single capability vocabulary spans the suite — `storage:read`, `db:write`, `run:deploy`, `mail:accept`, `meet:join` are all opaque strings on the *same* attenuating chain. Share a folder, delegate DB access, hand someone a function-invoke token, and invite them to a call with the *one* primitive — offline-verifiable, no policy server, attenuating end to end. Revocation (expiry + on-chain `RevokeCapability` + root rotation) is uniform across all products.
- **One billing (credits / channels).** Every product meters in integer-base-unit credits over the same payment-channel mechanism: pin storage, run a cell, relay a call, pay postage, hold a mailbox. One wallet, one settlement substrate, **no per-product invoice, no egress tax, no metered rent** — providers earn, consumers spend, all in the same money.
- **One storage (blobs / ce-storage).** Content-addressed blobs are the universal data plane: ce-storage objects, ce-mail bodies/attachments, ce-db large fields, ce-db Snapshots, ce-query columnar files, ce-meet recordings, ce-fn artifacts all live as CIDs. Dedup, geo-replication via pinning, and "the CDN is every node" come for free *across the whole suite* because everything is the same Merkle-addressed bytes.

**The unifying pitch:** CE Cloud is "Google, but yours" — privacy by default (E2E, content-addressed, the server can't read), no vendor lock-in (capabilities + open mesh, exit any time), self-host trivially (every node is the cloud), and no metered rent. The substrate that makes each Google product expensive to run centrally is exactly the substrate CE gives away as a primitive — so the *suite* is the product, and the four shared substrates are the moat.

---

## Summary

Cloning Google on CE is overwhelmingly an **assembly** problem, not an engineering one: storage, auth, pub/sub, document DB, serverless compute, drive, and CDN are all thin layers over CE apps that already exist (blobs/ce-pin, ce-cap, mesh pubsub, ce-coord Merged/Snapshot, jobs, ce-drive), and they cohere into one "CE Cloud" suite sharing identity, ce-cap auth, credit billing, and content-addressed blobs — which is precisely why CE ships them cheaply where Google needs central fleets. Lead with the substrate (ce-storage, ce-iam, ce-pubsub), then the developer magnet (ce-db, ce-run, ce-fn), then consumer breadth (ce-drive, ce-cdn, ce-suite-lite), and only attempt the three XL greenfield engines — ce-mail, ce-meet, ce-query — last, since each reduces to one of CE's three deliberate non-features (global edge fleet, a serialization point for invariants, cheap verification of opaque work), each with a named frontier answer.

**Ranked top-8 (build these first):**
1. **ce-storage** (GCS/S3) — bucket API over blobs/ce-pin · Have · S
2. **ce-iam** (IAM) — ce-cap as a product, strictly beats ACLs · Have · S
3. **ce-pubsub** (Pub/Sub) — Gossipsub + durable ce-coord log · Have · S–M
4. **ce-db** (Firestore) — ce-coord Merged CRDT + realtime + Snapshot · Have · M
5. **ce-run / ce-fn** (Cloud Run + Functions) — serverless over jobs + atlas + ce-pubsub triggers · Have · S–M
6. **ce-drive** (Drive) — capability-shared files + change feed over ce-drive · Have · S
7. **ce-cdn** (Cloud CDN) — pinning network as edge cache · Have · S–M
8. **ce-gke** (GKE) — harden swarm into an orchestrator product · Have · M–L
