# CE Drive Mesh API — Capability-Gated Peer-to-Peer Drive Access

> Workstream: ce-drive — the **network API** layer. The open-source, peer-to-peer equivalent of the Google Drive API.
> Repo: `github.com/ce-net/ce-drive` (the `ce-drive-serve` + `ce-drive-client` crates; sits beside `ce-drive-core`/`ce-drive-mount`/`ce-drive-web` from `10-drive-fs.md`).
> Layering: `ce-drive-client → {ce-rs (AppRequest/stream/blobs), ce-cap, ce-drive-core (DriveTree CRDT), ce-pin, ce-coord (Merged feed)} → local CE node :8844 → mesh`
> **Node changes: none.** This is an APP over `AppRequest` + raw stream + `ce-cap`, exactly per `docs/primitives.md`. No new node RPC variant, no new HTTP endpoint, no new tx kind.

This document specifies the **mesh-facing API** of CE Drive: the wire protocol by which **one CE node hosts a drive** and **other CE nodes use it** — list, read, write, share, watch — authorized entirely by signed attenuating `ce-cap` chains. Where `10-drive-fs.md` designed the *storage core and the two local faces* (mount + web), this document designs the *remote-access surface*: the Google Drive API analog, but addressed by NodeId over libp2p, not by OAuth over HTTPS.

The whole design reduces to: **metadata over `AppRequest`/`AppReply`, bulk bytes over content-addressed blobs (manifest CID + ranged chunk fetch), a live change feed over pubsub + a `Poll` cursor, and `ce_cap::authorize()` on every single request.** Everything composes primitives CE already ships.

---

## 0. Design rules (non-negotiable, from CE architecture)

1. **App, not node.** Every byte on the wire is `ce-rs` `request`/`reply`/`publish`/`subscribe` + `put_blob`/`get_blob`/`get_object` + `fetch_chunk_paid`. The host runs a `ce-drive serve` loop polling `/mesh/messages`; clients call `request()`. No `RpcRequest` variant, no HTTP endpoint added to the node. (Same discipline as `rdev`.)
2. **Stateless, path/CID-addressed — never fid/handle-stateful.** Each request self-describes: `{drive, path/cid, range, cap}`. No server-side open-file handles, no per-connection session — this survives relay reconnects and NAT churn (S3/Drive model, not 9P/NFS).
3. **Authorization = `ce-cap` only.** No ACL table, no device allowlist. The host verifies a signed attenuating chain rooted at its own key (or a configured org root) on **every** request via `ce_cap::authorize(host_id, roots, &[], now, &from_node, ability, &chain, &is_revoked)` — the exact call `rdev::handle_inner` already makes. Sharing = minting an attenuated sub-chain. Revocation = expiry + on-chain `RevokeCapability`.
4. **Mesh-first.** Drives are discovered by **name/discovery** (`resolve_name`, `find_service`), never by stored ip:port. Transport is libp2p (relay/NAT traversed). The address of a drive is `(NodeId, drive-id)`, where the NodeId may be reached anywhere on the mesh.
5. **Money = integer base units, decimal strings on the wire.** Storage/egress billing rides existing payment channels (`channel_open`, `sign_receipt`, `fetch_chunk_paid`). Amounts are `Amount` (base-unit `i128`), serialized as decimal strings.
6. **Two independent gates (steal from Tahoe).** Gate 1 = `ce-cap` ("may you call this op?"). Gate 2 = content read-key ("may you decrypt the bytes?"). A host can serve a private drive it cannot read. Keep them orthogonal.

---

## 1. The address model

A **drive** is the pair `(host: NodeId, drive_id: String)`. One node may host many drives (multi-tenant, §5). A drive namespaces one `ce-drive-core` `DriveTree` (the Kleppmann move-CRDT from `10-drive-fs.md` §4) + its content map.

**Discovery (mesh-first, no ip:port):**
- **By name:** the host calls `claim_name("acme-eng")` once; clients `resolve_name("acme-eng") -> NodeId`. A drive URL is `ce://acme-eng/projects/x` → `(resolve_name("acme-eng"), drive_id="...", path="/projects/x")`.
- **By service:** a host that offers drives calls `advertise_service("ce-drive")`; a client `find_service("ce-drive") -> [NodeId]` to enumerate hosting peers (e.g. for a marketplace of storage hosts).
- **By raw NodeId:** `(64-hex, drive_id)` works directly with zero naming.

Once the NodeId is known, **all transport is `request(node_id, "ce-drive/v1", payload, timeout)`** — libp2p routes it (relay/DCUtR), the host's serve loop replies. No address is ever stored.

---

## 2. The RPC operation set (`ce-drive/v1`)

### 2.1 Envelope

Every metadata op is one `AppRequest` on topic `ce-drive/v1`. The host authenticates `from_node` for free (Noise/PeerId, verified by the node). The app authorizes by verifying the attached cap chain against `(op, path)`.

```rust
// ce-drive-serve::wire  (bincode on the wire, shown as Rust)
struct DriveReq {
    drive: String,            // drive-id on the host
    cap:   String,            // base64 ce-cap chain; leaf.audience == from_node
    op:    DriveOp,
}

enum DriveOp {
    Open   { },                                   // handshake: capabilities + drive root info
    Stat   { path: String },
    List   { path: String, cursor: Option<String>, limit: u32 },
    Read   { path: String, offset: u64, len: Option<u64> },  // returns a ReadPlan (CIDs), not bytes
    Write  { path: String, object_cid: String, base_etag: Option<String> },
    Mkdir  { path: String },
    Move   { from: String, to: String },
    Copy   { from: String, to: String },          // server-side, free (shares chunk CIDs)
    Delete { path: String, recursive: bool },
    Share  { path: String, audience: String, abilities: Vec<String>, caveats: ShareCaveats },
    Poll   { cursor: Option<String>, limit: u32 },
    Watch  { },                                   // returns the pubsub topic + current cursor
}

struct DriveReply { result: Result<DriveOk, DriveErr> }   // encoded as Result; DriveErr carries a code

enum DriveOk {
    Opened   { drive_root_cid: String, server_seq: u64, granted_abilities: Vec<String>, quota: Quota },
    Entry    (Entry),
    Listing  { entries: Vec<Entry>, next_cursor: Option<String> },
    ReadPlan { object_cid: String, total_size: u64, chunk_size: u64,
               chunks: Vec<ChunkRef>, encrypted: bool, key_hint: Option<String> },
    Written  { etag: String, node_id: String, version_seq: u64 },
    Made     { node_id: String },                 // mkdir/move/copy → stable NodeId of affected node
    Deleted  { },
    Shared   { chain: String },                   // base64 EXTENDED ce-cap chain for `audience`
    Changes  { changes: Vec<Change>, new_cursor: String },
    Watching { topic: String, cursor: String },
}

struct Entry {
    path: String, kind: EntryKind /* File|Dir */, size: u64, mtime_ms: u64,
    etag: String,                    // = content map version key; cheap optimistic-concurrency token
    node_id: String,                 // stable DriveTree NodeId (identity across renames)
    object_cid: Option<String>,      // None for dirs / .cedoc nodes
    doc_id: Option<String>,          // set for embedded ce-notes .cedoc nodes
}
struct ChunkRef { cid: String, offset: u64, len: u64 }
struct Change { seq: u64, path: String, node_id: String, kind: ChangeKind, etag: String }
enum  ChangeKind { Created, Modified, Deleted, Moved { from: String } }

enum DriveErr {  // -> mapped to a stable numeric code on the wire
    Unauthorized, Revoked, Expired, OutOfScope,     // cap failures
    NotFound, Conflict { current_etag: String },    // optimistic-concurrency clash on Write
    QuotaExceeded, PaymentRequired, BadPath, Internal(String),
}
```

This is the **minimal closed set** — `open/stat/list/read/write/mkdir/move/copy/delete/share/poll/watch` — onto which every Google Drive / WebDAV / S3 / 9P verb maps, and nothing the node must enforce as a primitive.

### 2.2 The operations

**`Open`** — handshake. Client sends its cap; host runs `authorize` for `drive:read` (the floor), returns the drive root snapshot CID (so the client can bootstrap the DriveTree from `ce-pin`/blobs without replaying the whole log — uses the ce-coord snapshot/bootstrap addition), the host's current `server_seq` (change-feed cursor origin), the **granted abilities** the cap actually carries (so the client UI greys out write/share it can't do), and the quota/billing terms. Cheap, idempotent, no state created.

**`Stat`** — `authorize drive:read` on `path`; returns one `Entry` from the DriveTree `children` index + content map. The `etag` is the content map version key — used by `Write { base_etag }` for optimistic concurrency.

**`List`** — `authorize drive:read`; returns a page of `Entry` from the `children` index. **Pagination is an opaque `cursor`** (a serialized `(name,node_id)` position), `limit`-bounded, exactly S3 `ListObjectsV2` continuation-token / Drive `pageToken`. Listing never moves bytes.

**`Read`** — `authorize drive:read`; returns a **`ReadPlan`**, not bytes. The plan is the object manifest (`object_cid`, `total_size`, `chunk_size`, and the `chunks` that cover `[offset, offset+len)`). The client then fetches those chunk CIDs **directly from the data layer** (§3) — parallel, multi-provider, hash-verified. **Ranged read = the host computes which chunk indices intersect the range and returns only those `ChunkRef`s.** This is S3 `Range`/`partNumber` done content-addressed and trustless. For `.cedoc` nodes `ReadPlan` carries `doc_id` instead (the client mounts the ce-notes document).

**`Write`** — the **commit** step. The client has *already* uploaded the object's chunks to the data layer (`put_object` → `object_cid`); `Write` binds `path -> object_cid` in the DriveTree content map. `base_etag` gives optimistic concurrency: if the current etag ≠ `base_etag`, the host returns `Conflict { current_etag }` and the client re-reads + retries (or writes a `.conflict-` copy per `10-drive-fs.md` §9.2). `authorize drive:write`. Returns the new `etag` + `version_seq`. Atomic and dedup-friendly: the host need never have held the bytes.

**`Mkdir`** — `authorize drive:write`; emits one `MoveOp{ new_id, parent, name, Dir }` into the DriveTree.

**`Move`** — rename/move; `authorize drive:delete` (move = delete+create) on both `from` and `to` subtrees. One O(1) `MoveOp` edge-flip; all descendants follow (path is derived). Cycle-check is in `DriveTree::apply`.

**`Copy`** — server-side copy; `authorize drive:read` on `from` + `drive:write` on `to`. **Free** — the new node shares the same chunk CIDs (global dedup). No bytes move.

**`Delete`** — `authorize drive:delete`; `MoveOp{ id, TRASH }` (content retained until GC → undelete window). `recursive` for directories.

**`Share`** — `authorize drive:share`; the host (or any holder of `drive:share`) **mints an attenuated sub-capability** for `audience`, scoped to `path` with the requested (⊆ caller's) abilities + caveats, `parent = <this cap's CapId>`, signed by the caller's key, and returns the **extended chain**. This replaces Google's mutable per-file ACL row with a stateless, offline-verifiable, attenuating chain. (See §4.)

**`Poll`** — `authorize drive:watch`; the authoritative change feed. Returns `{ changes[], new_cursor }` — deltas since `cursor` (a monotonic `seq`), `limit`-bounded, resumable, gap-free. Changes carry **paths + etags, not bytes** (Drive's `changes.list` contract); the client re-reads changed paths. This is the source of truth for sync.

**`Watch`** — `authorize drive:watch`; returns the **pubsub beacon topic** `ce-drive/<drive_id>/changes` + the client's current cursor. The client `subscribe()`s; the host `publish()`es a tiny `{drive, max_seq}` beacon whenever it advances (best-effort wake-up = Drive's `changes.watch` webhook). On wake, the client calls `Poll`. Gossip is lossy by design → beacon is **only a hint**; `Poll` is truth.

### 2.3 Two transports for bytes (large vs. interactive)

| Need | Transport | Why |
|---|---|---|
| Large file read/write, dedup, ranged read | **content-addressed blobs**: `put_object`/`get_object`/`get_blob` per chunk, `fetch_chunk_paid` for paid serving | hash-verified, parallel, multi-provider, trustless; the host can be stateless and need not hold bytes |
| Sub-chunk / low-latency interactive editing | raw bidirectional stream over `/ce/tunnel/1` (offset/len read-write, 9P `Tread`/`Twrite` shape), gated by the **same** cap | avoids round-tripping a manifest for tiny edits; one stream, same authz |
| Metadata (everything in §2.2) | `AppRequest`/`AppReply` on `ce-drive/v1` | small, structured, request/reply |
| Change beacon | `publish`/`subscribe` on `ce-drive/<id>/changes` | best-effort wake-up |

The host advertises which transports it supports in `Open`. v1 ships blobs + AppRequest + beacon; the tunnel stream is the v2 interactive-edit optimization.

---

## 3. Bytes: composing the data layer

CE Drive reuses the content-addressed object model verbatim (`docs/data-layer.md`, `ce-rs::data`); the mesh API only *references* it.

**Upload (write path):**
1. Client chunks the file (`data::chunk_object`, 1 MiB chunks; delta via `rdev::delta` so only missing chunks ship), `put_blob` each chunk, `put_blob` the manifest → `object_cid`. Chunks self-replicate via DHT provider records.
2. Client sends `Write { path, object_cid, base_etag }`. The host binds `path -> object_cid` in the content map (one small `MoveOp`/`Insert`).
3. The host's **`ce-pin` policy** pins `object_cid` at the drive's replication factor and announces it (`ce-pin add --replication N`, `ce-pin announce`) so the bytes are durable independent of the uploader.

**Download (read path):**
1. Client sends `Read { path, offset, len }` → gets a `ReadPlan` (the manifest + the `ChunkRef`s covering the range).
2. Client fetches those chunks **directly from the data layer**: `get_blob(cid)` (free/cached) or `fetch_chunk_paid(provider, cid, channel_id, cumulative)` (paid egress, §6). Every chunk is verified against its CID before use — content-addressing **is** the integrity proof; a host can never serve bytes the publisher didn't store.
3. Reassemble (`data::reassemble`, pure, verifies). Ranged read fetches only the intersecting chunks — open a 2 GB file, read the header, pull one chunk.

**Why this is better than the Google Drive API:** transfer is trustless (hash-verified), dedup is global and free (`Copy` shares CIDs; identical files across tenants store once), the serving host can be a different, untrusted node from the metadata host, and partial/ranged reads are native.

---

## 4. The capability model (`ce-cap`)

CE Drive contributes **vocabulary**, not mechanism. The verifier is `ce-cap` unchanged.

### 4.1 Abilities (opaque action strings, monotonic lattice)

```
drive:read     // Open, Stat, List, Read   (+ fetch chunks of objects under path)
drive:comment  // read + append comments/suggestions on .cedoc nodes (ce-notes) — between read and write
drive:write    // Write, Mkdir, Copy       (create/overwrite under path)
drive:delete   // Delete, Move             (move = delete+create)
drive:share    // mint attenuated sub-caps for other audiences
drive:watch    // Poll + subscribe to the change beacon
drive:admin    // quota/billing config, pin-policy, drive-level Share-without-prefix
```

Role tiers map to Google's reader/commenter/writer/owner as a **lattice** so attenuation is well-defined:
`read ⊂ comment ⊂ write ⊂ {write+delete} ⊂ {…+share} ⊂ admin`. `drive:watch` is orthogonal (a reader who can't watch is valid). A child cap's abilities must be `⊆ parent.abilities` (`ce-cap`'s existing check). This is exactly the user's requested `read/comment/write/admin` scoping.

### 4.2 Resource + caveats (scope to a subtree — the `path_prefix` story)

```
Resource: Node(host_id)            // the drive's host (existing ce-cap matcher)
Caveats {
  drive_id:    "acme-eng",         // confine to ONE drive on a multi-tenant host
  path_prefix: "/projects/x",      // confine to a SUBTREE (already a ce-cap caveat for sync/delete)
  not_before, not_after,           // expiry (the first-line revocation)
  max_bytes_read?:  u64,           // optional egress quota ceiling (attenuates monotonically)
  max_bytes_write?: u64,           // optional storage quota ceiling
}
```

`path_prefix` is the linchpin and **already exists in `ce-cap`** (rdev enforces it for `sync`/`delete`); CE Drive makes **every** op honor it, fail-closed (an op that can't confine to the prefix is rejected; `..` traversal rejected; paths canonicalized — the same defense rdev's `fs_action` runs). A child cap may only **narrow** the prefix (`is_narrower_or_equal`), so a holder of `drive:read @ /projects` can hand out `drive:read @ /projects/x/sub` and nothing wider — recursively, unbounded. That is Tahoe-style diminishing expressed in `ce-cap`.

### 4.3 How the host verifies each request (`ce_cap::authorize`)

The `ce-drive serve` loop, per request, runs the identical pattern to `rdev::handle_inner`:

```rust
let chain = ce_cap::decode_chain(&req.cap)?;                  // base64 -> Vec<SignedCapability>
let ability = required_ability(&req.op);                      // e.g. DriveOp::Write -> "drive:write"
ce_cap::authorize(
    host_id,                 // this drive host's NodeId == the cap root (or a configured org root)
    &roots,                  // <data_dir>/roots/* for enterprise multi-node workspaces
    &[],                     // no extra trust anchors
    now_secs(),
    &msg.from,               // Noise-authenticated sender; MUST == chain leaf.audience (confused-deputy safe)
    ability,
    &chain,
    &is_revoked,             // closure over GET /capabilities/revoked, refreshed ~10s (like rdev/ce-pin)
)?;
enforce_caveats(&chain, &req)?;  // drive_id match, path_prefix confinement, quota ceilings, expiry
```

`authorize` checks: every link signed and chains to a trusted root; each link's abilities ⊆ parent; `ability` ∈ leaf abilities; not expired; `leaf.audience == from_node`; not in the on-chain revoked set. **No ACL lookup, no per-file permission row, no `O(shares)` host state** — authorization is a pure, local, offline function of the presented chain.

### 4.4 Sharing = self-issued attenuated chain (no ACL table)

`Share{path, audience, abilities, caveats}` makes the caller (drive owner, or any `drive:share` holder) mint:

```rust
SignedCapability {
    issuer:    self_node_id,
    audience:  audience,                       // the peer being granted access
    abilities: requested ∩ caller.abilities,   // cannot exceed the caller's own
    resource:  Node(host_id),
    caveats:   { drive_id, path_prefix: path (⊇-narrowed only), not_after, max_bytes_* },
    parent:    Some(this_cap.cap_id),          // chains to the caller's cap → attenuation enforced
    sig:       sign(self_key, ...),
}
```

The returned **extended chain** is stored by the recipient in their capability wallet (the rdev-app wallet for app-issued caps; `ce wallet` for node-level). They present it on future `DriveReq`s. Transitive read-only re-share is cryptographically enforced (a `drive:read` holder can never widen to write). **Share links** = a minted `drive:read`/`drive:comment` chain embedded in a URL fragment, `not_after`-bounded ("anyone with link, expires in 7d").

### 4.5 Expiry + on-chain revocation

- **Expiry first.** Caps carry `not_after`; `rdev watch`-style clients re-mint short caps as they rotate. Cheap, no chain write.
- **On-chain `RevokeCapability`.** The drive owner calls `POST /capabilities/revoke { nonce }` → a `RevokeCapability` tx; when mined it invalidates that link **and its entire attenuated subtree**. Every host's `is_revoked` closure (over `GET /capabilities/revoked`) denies it within ~10s. This is the subtree kill switch.
- **Root rotation** = nuclear option (re-issue the whole workspace from a new root key).
- **E2E drives** additionally do **lazy rekey** on revoke (bump the per-folder content key, re-wrap to survivors; `10-drive-fs.md` §9.3) so a revoked member also loses *decryptability*, not just call rights.

### 4.6 The two-gate privacy split (Tahoe)

- **Gate 1 — `ce-cap`:** may this `from_node` call this op on this path? (§4.3).
- **Gate 2 — content read-key:** can they *decrypt*? For private drives the client **encrypts chunks before `put_object`** (KBFS deterministic-nonce so dedup survives, `10-drive-fs.md` §9.3). The host serves ciphertext under `drive:read` and **never holds the key**; the symmetric read-key is handed out **out of band** as its own capability (`key_hint` in `ReadPlan` names which key generation, not the key). So a drive can be hosted by a node the owner doesn't trust to read it. `drive:read` ⇒ "fetch chunks"; read-key ⇒ "understand them."

---

## 5. Multi-tenant: a team drive hosted by one node, used by many

The user's "team drive hosted by one node, accessed by many" model:

- **One host, many drives, many members.** A host node runs `ce-drive serve` advertising N drives, each `(host, drive_id)` a separate `DriveTree`. The **org root key *is* the workspace** (`10-drive-fs.md` §5): every member's cap chains to it. Membership = the **set of issued capabilities**, not a list — there is no member table to maintain or breach.
- **Fan-in over AppRequest.** Every member is a CE node calling `request(host, "ce-drive/v1", …)`. The host's serve loop handles them concurrently (a `tokio` task per request; `authorize` is pure/local so it doesn't bottleneck). Reads are stateless and parallel; writes serialize through the single-writer DriveTree log (v1) or merge via `ce-coord` Merged (v3, below).
- **Discovery stays mesh-first.** Members reach the drive by `resolve_name("acme-eng")` or `find_service("ce-drive")` → NodeId, then libp2p (relay/DCUtR) routes. **No member ever stores the host's ip:port.** A host behind NAT is reachable via the relay exactly like any CE node; if the host moves networks, the NodeId is unchanged and discovery re-resolves.
- **Per-member scoping is pure cap attenuation.** Owner mints `drive:write @ /projects/alice` for Alice, `drive:read @ /shared` for a contractor, `drive:admin` for a co-owner — all chaining to the org root, all offline-verifiable, all revocable. Different members, different subtrees, different rights, **zero server-side policy state**.
- **Availability.** A single host is a single point of failure for *metadata*; the **bytes** are already durable across the mesh via `ce-pin` replication. For metadata HA, the drive's DriveTree log + snapshot CID are themselves pinned, and a standby host (another org node holding a cap-chain-to-root) can resume serving the same `drive_id` from the snapshot — the NodeId changes but `resolve_name` re-points. True multi-host concurrent serving is the `ce-coord` Merged path (§7, v3).

### 5.1 Composition with `ce-drive-core` + `ce-pin` + `ce-coord` Merged

```
remote client (ce-drive-client)                          host (ce-drive-serve)
  request("ce-drive/v1", DriveReq) ───────────────────►  poll /mesh/messages
                                                          ce_cap::authorize(...)            [§4.3]
                                                          DriveTree::{readdir,stat,apply}   [ce-drive-core §4]
                                                          content map lookup/commit
  ◄────────────────── DriveReply (Entry/ReadPlan/...)     reply(token, DriveReply)
  get_blob / fetch_chunk_paid(chunk CIDs) ─────────────►  data layer (chunks pinned by ce-pin)
  subscribe("ce-drive/<id>/changes")  ◄── publish beacon  host advances server_seq, publishes {drive,max_seq}
  request(Poll{cursor}) ───────────────────────────────►  host reads change log since seq → Changes
```

- **`ce-drive-core` `DriveTree`** is the host's source of truth for the namespace; the mesh API is a thin authorize-then-delegate shell over `DriveTree::{readdir, stat, apply}` + the content map. A remote client that wants to *mirror* (not just browse) maintains its **own local `DriveTree` replica**, bootstrapped from the `Open` snapshot CID and kept live by the `Poll`/beacon feed — this is `rdev watch` reimplemented over the Drive API: subscribe beacon → on wake `Poll` deltas → ranged-fetch changed chunks (chunk-level diff via the CID delta engine) → apply. Conflict policy + `.ceignore` are app policy.
- **`ce-pin`** provides byte availability so the serving host need not be the only holder; the data plane is decoupled from the metadata host.
- **`ce-coord` Merged (multi-writer + Snapshot)** is what makes *multi-device write* and *multi-host serve* converge: each writer owns a log `ce-coord/log/<writer>/drive-<id>`; readers (and standby hosts) merge by `MoveOp.ts` (Lamport), running the dormant undo/redo in `DriveTree::apply`. The **Snapshot** addition is what `Open` returns so a fresh client/host bootstraps in O(snapshot) not O(log). This is the only `ce-coord` dependency, and it is already on its roadmap (`10-drive-fs.md` §13).

### 5.2 A remote client that mounts/browses a remote drive

The `ce-drive-client` crate exposes the remote drive as the **same `ce-drive-core` interface** the local mount/web already use, so:
- **`ce-drive-mount` over the network:** the VFS lazy-hydration engine (`10-drive-fs.md` §7) is pointed at a *remote* DriveTree replica fed by the Drive API. `readdir`/`stat`/`getattr` are served from the locally-cached replica (no per-syscall RPC); first `read` issues `Read` → ranged chunk fetch; `write`/`fsync` re-chunks → `put_object` → `Write`. Close-to-open consistency; the beacon feed surfaces remote changes to IDE watchers. A teammate can literally `cd` into a colleague's shared subtree and `cargo build`.
- **Web browse:** `ce-drive-web` calls the same ops via the JS `@ce-net/sdk` against the in-browser CE node — file browser, upload, share dialog (mints a `Share` chain), all over the mesh.
- **CLI:** `ce-drive ls ce://acme-eng/projects/x`, `ce-drive cat`, `ce-drive cp`, `ce-drive share <peer> --can write --path /docs --expires 30d`, `ce-drive watch ce://acme-eng/x ./local` — each a thin wrapper over a `DriveReq`.

---

## 6. Quotas, billing, and the economy

Storage and egress are real costs; CE prices them with existing primitives — no new mechanism.

- **Storage billing (host holds your bytes):** the member opens a payment channel to the host (`channel_open(host, capacity, expiry_height)`), and the host's pin policy meters bytes-pinned × time; the member periodically `sign_receipt(channel_id, host, cumulative)`. The host redeems via `channel_close`. `max_bytes_write` cap caveat enforces the storage ceiling before the channel even runs (fail-closed at authorize time).
- **Egress billing (paid downloads):** ranged chunk fetches from a paid provider use `fetch_chunk_paid(provider, cid, channel_id, cumulative)` — the same data-layer Stage-3 path. `max_bytes_read` cap caveat enforces the egress ceiling. Free/cached reads (`get_blob`) cost nothing; a drive can be configured free-tier (no channel required) or metered.
- **`Quota` in `Open`** advertises the terms: `{ price_per_gib_month, price_per_gib_egress, free_tier_bytes, channel_required }`. The client decides whether to open a channel. `QuotaExceeded`/`PaymentRequired` `DriveErr`s gate over-limit ops.
- **Marketplace angle:** because serving is decoupled (§3) and discovery is open (`find_service("ce-drive")`), a member can pin their drive's bytes across *multiple* paid hosts ranked by `atlas`/`history` reputation — competitive storage, no single vendor.

All amounts are `Amount` base units, decimal strings on the wire.

---

## 7. Security & threat model

| Threat | Defense (real primitive) |
|---|---|
| Forged sender | Node verifies `msg.from` (Noise/PeerId) for free; `leaf.audience == from_node` enforced → no relayed impersonation / confused deputy. |
| Unauthorized op | `ce_cap::authorize` on **every** request; fail-closed. No cap, wrong ability, wrong audience, expired, or out-of-prefix → denied. |
| Privilege escalation via re-share | `ce-cap` attenuation: child abilities ⊆ parent, child prefix ⊆ parent prefix (`is_narrower_or_equal`); a `read` holder can never mint `write`. |
| Path traversal / escape | Canonicalize, reject `..`, enforce `path_prefix` on every op (rdev `fs_action` defense reused). |
| Stale access after firing someone | Expiry (short caps) + on-chain `RevokeCapability` (subtree kill within ~10s) + E2E lazy rekey (loses decryptability too). |
| Host reads private data | Two-gate split: client encrypts chunks before `put_object`; host serves ciphertext under `drive:read`, never holds the read-key (Tahoe). |
| Corrupt/lying serving host | Content-addressing: every chunk verified against its CID before use; a host cannot serve bytes the publisher didn't commit. |
| Replay of a `Write` commit | `base_etag` optimistic concurrency + monotonic `version_seq`; a stale commit returns `Conflict`. |
| Metadata leakage to host | The host inherently sees the namespace (paths/sizes) unless tree-ops are encrypted (`10-drive-fs.md` §4.7 encrypts `MoveOp`/`FileContent`). Honest limit: who-accesses-what timing is visible to the host; don't claim metadata privacy you can't deliver. |
| DoS by request flooding | Host rate-limits per `from_node`; `authorize` is cheap (local, no I/O); expensive ops (List/Read) are paginated/ranged; unpaid egress is free-tier-capped. |
| Audit / non-repudiation | Cap grants/revokes are on-chain facts (`/history`, chain); optional per-object signed append-only access log checkpointed to chain (`10-drive-fs.md` §10) for HIPAA/enterprise. |

**Honest non-goals (v1):** no metadata-privacy against the host beyond optional tree-op encryption; no strong cross-client coherence (close-to-open only); single metadata host per drive (HA is standby-resume, not active-active, until `ce-coord` Merged multi-host lands).

---

## 8. Repo / crate layout

```
ce-drive/                              # github.com/ce-net/ce-drive
└── crates/
    ├── ce-drive-core/                 # (from 10-drive-fs.md) DriveTree CRDT, content map, store, share, crypto
    ├── ce-drive-serve/                # THE HOST: serve loop over /mesh/messages, authorize+delegate
    │   ├── serve.rs                   # poll, dispatch DriveOp, ce_cap::authorize, enforce_caveats
    │   ├── wire.rs                    # DriveReq/DriveReply/DriveOp/Entry/Change (bincode)
    │   ├── feed.rs                    # per-drive monotonic seq log + change beacon publish
    │   ├── tenant.rs                  # multi-drive registry, quota/billing, ce-pin policy
    │   └── stream.rs                  # v2: /ce/tunnel/1 interactive read/write handler
    ├── ce-drive-client/              # THE CONSUMER: typed remote-drive client
    │   ├── client.rs                  # open/stat/list/read/write/mkdir/move/delete/share/poll/watch
    │   ├── mirror.rs                  # beacon+Poll → local DriveTree replica (rdev-watch over the API)
    │   └── readplan.rs                # ranged chunk fetch + reassemble + verify
    └── ce-drive-cli/                 # `ce-drive ls|cat|cp|share|watch ce://name/path`
```
Deps (all path/git): `ce-rs` (AppRequest/stream/blobs/channels/discovery), `ce-cap` (`ce/crates/ce-cap`), `ce-drive-core`, `ce-pin`, `ce-coord`. **No node dependency, no node changes.**

---

## 9. Milestones

See the `milestones` field below. Sequencing: M1 ships the read-only browse API + cap-gated authorize (the Google-Drive-API-read analog) with zero node/ce-coord changes; M2 adds the write plane + sharing (mint attenuated chains) + revocation; M3 adds the live change feed (Poll cursor + beacon) and the mirroring client (`rdev watch` over the API); M4 adds multi-tenant billing (channels for storage/egress) + standby HA; M5 adds the interactive tunnel-stream byte plane + multi-host active-active over `ce-coord` Merged.

## Milestones
- M1 — Read API + capability gate [L] — ce-drive-serve serve loop polling /mesh/messages; wire.rs (DriveReq/DriveReply/DriveOp); Open/Stat/List/Read over ce-drive-core DriveTree readdir/stat + content map; ReadPlan returns manifest CID + ranged ChunkRefs; ce-drive-client fetches chunks via get_blob and reassembles (verified). ce_cap::authorize on every request (drive:read), path_prefix + drive_id caveat enforcement, .. rejection (reuse rdev handle_inner/fs_action pattern). Discovery via resolve_name/find_service. Zero node/ce-coord changes. Tests: cap authorizes read on subtree; wrong-audience/expired/out-of-prefix denied; ranged read pulls only intersecting chunks; CID mismatch rejected.
- M2 — Write plane + sharing + revocation [L] — Write (commit object_cid with base_etag optimistic concurrency → Conflict on clash), Mkdir/Move/Copy/Delete as DriveTree MoveOps; ce-pin pin-on-write policy. Share op mints attenuated ce-cap sub-chain (issuer=caller, abilities⊆caller, prefix-narrowed, parent-linked) and returns extended chain; drive:comment/write/delete/share/admin lattice. Expiry + on-chain RevokeCapability (is_revoked closure over /capabilities/revoked, ~10s refresh) + E2E lazy-rekey hook. Tests: attenuation can't widen read→write; child prefix can't escape parent; revoked subtree denied; conflict on stale base_etag.
- M3 — Change feed + mirroring client [M] — feed.rs: per-drive monotonic seq log + Poll{cursor}→Changes (gap-free, resumable, paths+etags not bytes); Watch returns ce-drive/<id>/changes beacon topic; host publishes {drive,max_seq} on advance. ce-drive-client mirror.rs: subscribe beacon → on wake Poll deltas → ranged-fetch changed chunks (CID delta) → apply to a local DriveTree replica bootstrapped from Open snapshot CID. ce-drive watch ce://name/path ./local. Requires ce-coord Snapshot addition. Tests: cursor resumes across disconnect; beacon-loss still converges via Poll; multi-device mirror converges.
- M4 — Quotas, billing, multi-tenant HA [M] — tenant.rs multi-drive registry; Quota in Open (price_per_gib_month/egress, free_tier, channel_required); storage billing via payment channel + sign_receipt metered by ce-pin bytes×time; paid egress via fetch_chunk_paid; max_bytes_read/write cap caveats enforced at authorize (QuotaExceeded/PaymentRequired). Standby host resumes a drive_id from pinned snapshot CID; resolve_name re-point. Per-object signed access log checkpointed to chain (audit). Tests: over-quota write denied pre-channel; egress metered; standby resumes from snapshot.
- M5 — Interactive stream plane + active-active [L] — stream.rs: /ce/tunnel/1 raw bidirectional read/write (offset/len, 9P shape) for sub-chunk interactive editing, same cap gate; advertised in Open. Multi-host active-active serving over ce-coord Merged multi-writer (per-host log merged by MoveOp.ts, dormant undo/redo activated) so a team drive has no single metadata SPOF. ce-drive-mount pointed at a remote replica (network mount). Tests: interactive edit round-trips one chunk; two hosts serving same drive converge; offline concurrent moves converge with no leader.

## Risks
- Single metadata host is a SPOF for the namespace until M5 active-active; bytes are already mesh-durable via ce-pin but the DriveTree writer/serve point is one node. Mitigation: M4 standby-resume from pinned snapshot CID (NodeId changes, resolve_name re-points); M5 ce-coord Merged multi-host active-active. Note Raft is the WRONG fit (stalls offline moves) — the merged-log CRDT path is required.
- The serving host inherently sees the namespace (paths/sizes/access-timing) even when bytes are encrypted; full metadata privacy against the host is not delivered in v1. Mitigation: optional tree-op encryption (10-drive-fs §4.7 encrypts MoveOp/FileContent so a 3rd party sees only ciphertext); document the honest limit — don't claim host-metadata privacy.
- Best-effort pubsub beacon can drop wake-ups, so naive watch could miss changes. Mitigation: the Poll cursor is the source of truth (gap-free, resumable); the beacon is only a latency hint; clients periodically Poll regardless. This is Drive's exact changes.watch-is-a-hint contract.
- Optimistic-concurrency (base_etag) under many concurrent writers to the same path can thrash with repeated Conflict retries. Mitigation: writes serialize through the single-writer DriveTree log in v1–v4 (no contention); the .conflict-copy fallback (10-drive-fs §9.2) never loses data; true multi-writer (M5) uses CRDT merge not etag-CAS.
- Quota/billing metering (bytes×time storage, paid egress) adds accounting the host must get right or it under/over-charges. Mitigation: reuse the proven payment-channel + fetch_chunk_paid path verbatim; caps (max_bytes_read/write) enforce ceilings at authorize time (fail-closed) independent of metering accuracy; free-tier drives skip metering entirely.
- Per-request ce_cap::authorize on a hot read path could bottleneck a busy team drive. Mitigation: authorize is pure/local/offline (no I/O, no ACL DB), the is_revoked set is cached and refreshed ~10s, and reads are stateless so they parallelize across tokio tasks; List/Read are paginated/ranged to bound per-request work.
- Network-mount of a remote drive (M5) inherits all the dev-tool latency risks of the local mount (10-drive-fs §16) plus network RTT. Mitigation: cache the DriveTree replica locally (readdir/stat served with zero RPC), long attr/entry TTLs, close-to-open consistency, ranged lazy hydration, and always offer the materialize fallback for CI/containers.
