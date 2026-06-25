# CE Notes — Local-First, End-to-End-Encrypted Notes on the CE Mesh

> Workstream: `notes` · Suggested target path: `ce-notes/docs/design.md (new repo: github.com/ce-net/ce-notes)`
> Depends on: coord

**Summary:** CE Notes is a new flagship app repo (sibling to swarm/rdev), layered CE Notes → ce-coord → ce-rs → local CE node → mesh. It models a notebook ("space") as a content-addressed, E2E-encrypted set of CRDT documents: prose notes use an embedded Yjs document whose binary updates ride ce-coord's single-writer Replicated<S> log as opaque, app-encrypted Op bytes; attachments are encrypted and stored via the CE data layer (put_object/get_object), referenced by {cid, key} inside the CRDT. CE never decrypts anything — confidentiality is pure app-layer envelope encryption (XChaCha20-Poly1305 content key per space, wrapped per device via X25519 derived from each device's Ed25519 NodeId), while CE provides authenticated transport (verified AppMessage.from), the blob layer, and capability gating for sharing. The node requires ZERO changes for the MVP; two small, optional node additions (an SSE wrapper and a capability-gated subscribe) are proposed as post-MVP performance/sharing upgrades, and ce-coord gains a minimal multi-writer "merge log" variant so any device can edit offline without a single-writer outage stalling edits. Milestones go from a Rust CLI/TUI MVP (single space, two devices, encrypted Yjs sync) to a web app on @ce-net/sdk with attachments, sharing-by-capability, and snapshotting.

---

## CE Notes — Design Doc

### 1. Goals / Non-Goals

**Goals**
- A real, daily-usable, local-first Markdown notes app proving the CE substrate (mesh + blobs + ce-coord + capabilities) is enough to build Anytype/Obsidian-class software with NO proprietary server.
- Multi-device sync: all of a user's devices (each a CE NodeId) converge offline-first. Edits made offline merge on reconnect with zero conflict UI.
- End-to-end encryption: the mesh, relays, and any other node see only ciphertext + an authenticated sender NodeId. Plaintext exists only inside an authorized device.
- Concurrent editing across devices (and, later, collaborators) via a text CRDT — no lost edits.
- Sharing a notebook with another person by issuing a `ce-cap` capability + wrapping the notebook key to their device key.
- Two front-ends: a Rust TUI (`ce-notes` binary) and a web app on `@ce-net/sdk`, sharing one wire format and crypto envelope.
- Respect the CE/app boundary: this is an **app**, layered `CE Notes → ce-coord → ce-rs → local ce node → mesh`. The node stays primitives-only.

**Non-Goals (v1)**
- Real-time multi-cursor presence with sub-100ms latency (the 250ms ce-coord pump is fine for notes; presence is a later `Stream<T>` add-on).
- Server-side full-text search or any cloud index. Search is a local per-device index.
- Rich WYSIWYG block editor. v1 is Markdown text + attachments; block model is future.
- Key recovery / social recovery. v1: losing all device keys = lost notebook (back up the seed). 

---

### 2. Architecture

```
┌──────────────────────── Device = one CE NodeId ─────────────────────────┐
│ UI:  ce-notes TUI (ratatui)   |   web app (@ce-net/sdk + CodeMirror+Yjs) │
│        │ instant local read/write, fully offline                        │
│        ▼                                                                 │
│  NoteDoc (Yjs Y.Doc per note)  ──persist──►  local store                 │
│        │ Y.encodeStateAsUpdate → update bytes                            │
│        ▼                                                                 │
│  Envelope:  ct = XChaCha20Poly1305(space_key, nonce, update_bytes)       │
│        ▼                                                                 │
│  ce-coord Replicated<MergeLog>:  propose(Op{ doc_id, ct, nonce })        │
│        publish ─► topic ce-coord/log/<writer>/notes-<space>              │
│        request ─► catch-up tail on gap                                   │
│  Attachments: encrypt → ce-rs put_object(ct) → CID → {cid,key} in Y.Doc  │
└─────────────────────────────────────────────────────────────────────────┘
        ▲ authenticated `from` NodeId; opaque ciphertext only
        │  ce-rs (HTTP) → local node :8844
   ┌────┴──────────────── CE mesh (libp2p, relay-traversed) ──────────────┐
   │ pubsub ops · request/reply catch-up · Kademlia blob providers        │
   │ Relay stores/forwards CIPHERTEXT, never decrypts                     │
   └──────────────────────────────────────────────────────────────────────┘
```

**Layering and dependencies**
- New repo `ce-notes` (github.com/ce-net/ce-notes). Rust workspace:
  - `ce-notes-core` — crypto envelope, space/key model, NoteDoc CRDT wrapper, the ce-coord MergeLog state machine, attachment helpers. No UI, no I/O beyond ce-rs/ce-coord.
  - `ce-notes-cli` — `ce-notes` binary: CLI subcommands + a ratatui TUI.
  - (web) `@ce-net/notes` — TypeScript, depends on `@ce-net/sdk` (the JS port of ce-rs) + `yjs`. Mirrors the wire format/envelope exactly.
- `ce-notes-core` depends on `ce-coord` (path/git) and `ce-rs`. The CRDT lives **inside** ce-coord ops, not in ce-coord itself (see §6).

**Why this shape.** ce-coord already gives ordered, authenticated, gap-repaired, catch-up-capable log replication with `version()`/`await_version()` convergence. We reuse it verbatim and treat the text CRDT as the `Op` payload. The single thing ce-coord lacks for notes — convergent concurrent edits when two devices write the same doc — is solved by the CRDT itself (Yjs merges commutatively), so the log only needs to be a multi-writer **set union** of opaque encrypted updates, not a linearizable single-writer log. That is the one minimal ce-coord addition (§6).

---

### 3. Data Model

A **Space** (= notebook/vault, the unit of sharing and the unit of encryption) contains notes, folders, and attachment refs.

```rust
// ce-notes-core — all of this is serialized INSIDE encrypted CRDT updates or space metadata.

/// 32-byte random id, hex. Stable across renames/moves.
type SpaceId = String;
type NoteId  = String;   // ULID-style, monotonic-ish, hex
type DeviceId = String;  // == CE NodeId hex (64 chars)

struct SpaceMeta {
    space_id: SpaceId,
    name: String,                  // display name, user-editable
    created_at: u64,
    key_epoch: u32,                // bumped on key rotation (revocation)
    members: Vec<MemberEntry>,     // devices/people authorized
}

struct MemberEntry {
    device_id: DeviceId,           // NodeId we wrapped the key to
    label: String,                 // "my phone", "alice@laptop"
    role: Role,                    // Owner | Writer | Reader
    wrapped_key: WrappedKey,       // space_key sealed to this device's X25519 pubkey
    added_at: u64,
    revoked: bool,
}

enum Role { Owner, Writer, Reader }

/// space_key (32 bytes, XChaCha20-Poly1305) sealed to a device via X25519.
struct WrappedKey { epoch: u32, ephemeral_pub: [u8;32], nonce: [u8;24], ct: Vec<u8> }
```

**Folders & note index** live in a small per-space metadata CRDT (Yjs `Y.Map`): `notes: Map<NoteId, NoteHeader>`, `folders: Map<FolderId, Folder>`.

```rust
struct NoteHeader {
    note_id: NoteId,
    title: String,                 // also stored as first heading in body; this is the cached index copy
    folder_id: Option<FolderId>,
    updated_at: u64,
    deleted: bool,                 // tombstone (CRDT-safe delete)
}
struct Folder { folder_id: FolderId, name: String, parent: Option<FolderId>, deleted: bool }
```

**Note body** = one Yjs `Y.Doc` per note (a `Y.Text` rooted at key `"body"`, plus a `Y.Map "attrs"` for note-level metadata and an `attachments: Y.Array<AttachmentRef>`).

```rust
struct AttachmentRef {
    cid: String,                   // CE object CID (manifest hash from put_object)
    file_key: [u8;32],             // per-file random key, stored ONLY inside the encrypted CRDT
    nonce: [u8;24],
    name: String,
    mime: String,
    size: u64,
}
```

**On the wire (ce-coord Op).** Every Yjs update (body or index doc) becomes:

```rust
/// The Op of the MergeLog state machine. Opaque ciphertext to the mesh.
struct NoteOp {
    doc_id: String,                // "index" or "note:<NoteId>"
    epoch: u32,                    // space key_epoch used
    nonce: [u8;24],
    ct: Vec<u8>,                   // XChaCha20Poly1305(space_key, nonce, yjs_update_bytes)
}
```

**Local persistence (per device, per space)**, in `<data_dir>/ce-notes/<space_id>/`:
- `space.json` — `SpaceMeta` (encrypted at rest under a device-local key derived from the node identity key).
- `index.ydoc` / `<note_id>.ydoc` — Yjs document state (`Y.encodeStateAsUpdate`) snapshots, refreshed on save.
- `attachments/<cid>` — decrypted attachment cache (lazy).
- `applied.json` — `{ writer_id: highest_version }` per ce-coord log we follow, for resume.

---

### 4. End-to-End Encryption

**Identity → key derivation.** Each device's CE NodeId is an Ed25519 public key; the device holds the secret in `~/.local/share/ce/identity/node.key`. We derive an X25519 keypair from it (Ed25519→X25519 birational map; the secret never leaves the device — `ce-notes-core` reads the key file the same way the node does, or, post-MVP, asks the node for a sealed-box op via a tiny capability-gated AppRequest). The X25519 public key is published in `MemberEntry` so others can seal to it.

**Space content key.** Each Space has one symmetric `space_key` (32 bytes, XChaCha20-Poly1305), generated by the Owner at creation. All note/index CRDT updates are sealed with it. The key is **wrapped per member** (`WrappedKey`) using X25519 sealed-box (ephemeral pubkey + AEAD).

**Add a device/person.** Owner generates a `WrappedKey` sealing the current-epoch `space_key` to the new member's X25519 pubkey, appends a `MemberEntry`, and (for sharing) issues a `ce-cap` grant (§7). New member decrypts the wrapped key, then can decrypt the whole CRDT history.

**Revoke a member.** Owner: (1) rotate `space_key` → `key_epoch += 1`; (2) re-wrap the new key to all surviving members; (3) mark the member `revoked`; (4) issue an on-chain `RevokeCapability` for their grant. Forward secrecy boundary only — old ciphertext stays decryptable to anyone who already had the old key (correct, honest local-first tradeoff; we document it).

**What CE sees.** Only `NoteOp.ct` (ciphertext) and an authenticated `from` NodeId. Authenticity (who wrote it) is free from CE's Noise-verified `AppMessage.from`; confidentiality is ours. These are orthogonal and both required.

**At rest.** Local `.ydoc`/`space.json` encrypted under a device-local key derived from the node identity key (so a stolen disk without the key file yields nothing).

---

### 5. Sync, Offline, Conflict Handling

**Sync transport = ce-coord `Replicated<MergeLog>` per space.** The log topic is `ce-coord/log/<writer>/notes-<space_id>`. Each device runs its own writer-log for the space and reads every other member's writer-log. Concretely each device is simultaneously:
- **Writer** of `Replicated<MergeLog>::writer(coord, "notes-<space>")` — its own outbound encrypted Yjs updates.
- **Reader** of `Replicated<MergeLog>::reader(coord, "notes-<space>", <peer_device_id>)` for every other member device.

`MergeLog` is a trivial state machine whose `apply(op: NoteOp)` does: decrypt `ct` with `space_key` for `op.epoch`; `Y.applyUpdate(doc[op.doc_id], plaintext)`. Because Yjs updates are commutative/idempotent, **order across writers does not matter** — each per-writer log still uses ce-coord's in-order/gap-repair machinery (so a single writer's stream is exactly-once and contiguous), and the union across writers converges by CRDT semantics. This sidesteps ce-coord's single-writer limitation for the *edit path* entirely.

**Offline.** Local Yjs reads/writes never touch the mesh. Outbound updates queue in the writer log's in-memory + on-disk log; on reconnect, peers fill gaps via ce-coord catch-up (`request(...catchup..., {from})`). Inbound updates a device missed while offline arrive on reconnect via the same catch-up.

**Convergence signal.** A device "is synced through version V from peer P" when `reader_for(P).version() >= V`. The UI shows a per-peer sync indicator using `version_watch()`.

**Conflict handling.** None needed for prose — Yjs guarantees convergence. For structured fields we choose CRDT semantics deliberately: title/folder = `Y.Map` last-writer-wins per key; delete = tombstone (`deleted: true`) never hard-remove (so a concurrent edit + delete keeps the note recoverable). Attachment list = `Y.Array` (append-only + tombstone). No user-facing merge dialog ever.

**Snapshotting (scale).** Per-writer logs grow unbounded and fresh readers replay from v1. Mitigation (M5): periodically the writer encrypts `Y.encodeStateAsUpdate(full doc)`, `put_object`s the ciphertext, and proposes a `NoteOp{doc_id, snapshot_cid}` checkpoint; new readers fetch the snapshot blob then tail from the checkpoint version. This reuses the data layer, no node change.

---

### 6. ce-coord gaps and the minimal additions

Assessed against the real `replicated.rs`:

| Need | ce-coord today | Decision |
|---|---|---|
| Ordered, authenticated, gap-repaired per-writer stream | ✅ `Replicated<S>`, `ingest`, catch-up, `await_version` | Reuse verbatim. |
| Concurrent multi-device edits without lost writes | ❌ single-writer LWW only | Put a **text CRDT (Yjs) inside the Op**; run one writer-log **per device** and union them. CRDT commutativity removes the need for a global order. This is an **app-side** pattern, not a ce-coord change. |
| Multi-writer collection abstraction | ❌ (Raft is "next layer") | Add a thin `MergeSet<Op>` helper in ce-coord (or in ce-notes-core to start): wraps N `Replicated` readers + 1 writer and dispatches `apply` for all. **Minimal, ~120 LOC.** Propose upstreaming to ce-coord once proven. |
| Encrypted/authorized topics | ❌ plaintext, anyone-on-mesh can read | App-layer envelope encryption solves confidentiality now; **capability-gated subscribe** (§7, optional node add) solves "don't even relay to non-members" later. |
| Blob attachments | ❌ | Use ce-rs `put_object`/`get_object` directly. No ce-coord change. |
| Push instead of 250ms poll | ❌ pump polls `messages()` | Optional node SSE wrapper (§8). Not required for MVP. |

**Net: ce-coord needs at most one small additive helper (`MergeSet`)**, which we can prototype inside ce-notes-core and upstream. Everything else is reuse.

---

### 7. Sharing via capability

Sharing a Space with another person:
1. Owner issues a `ce-cap` grant rooted at the Owner's key: ability strings `notes:read` and (optionally) `notes:write`, scoped to `space:<space_id>`, with an expiry. (Grant minting is `ce grant` / the `ce-cap` crate; ce-rs does not wrap signing, so `ce-notes-core` builds the grant via the `ce-cap` crate directly — same pattern rdev uses.)
2. Owner wraps `space_key` to the invitee's X25519 pubkey (`WrappedKey`) and adds a `MemberEntry`.
3. Invite blob = `{ space_meta, wrapped_key, grant_token }`, handed over out-of-band or via a directed `send_message(to, "ce-notes/invite", payload)`.
4. Invitee imports: verifies the grant chains to the Owner's key, decrypts the wrapped key, starts reader-logs for all member devices.

**Authorization model.** A member only *applies* updates from writers in `SpaceMeta.members` (app policy filter on top of ce-coord's `from`-verification). A reader-role member's writer-log is ignored by others. Revocation = rotate key + on-chain `RevokeCapability` + mark revoked. No device allowlists anywhere — trust is the signed capability chain plus the wrapped key.

---

### 8. What changes in the node (explicitly)

**MVP: nothing.** Everything composes from existing primitives: `ce-rs` `publish/subscribe/request/reply/messages` (used via ce-coord), `put_object/get_object/get_blob`, `status`, plus the local node identity key file. No new node endpoints, no new RPCs. This is the correct boundary: CE owns mechanism, CE Notes owns policy/crypto/UX.

**Optional, post-MVP, justified as primitives (each its own small proposal):**
1. **SSE wrapper in ce-rs** over the existing `GET /mesh/messages/stream` (the endpoint already exists; ce-rs just doesn't wrap it). Pure SDK change — removes the 250ms pump latency. No node change. (Preferred.)
2. **Capability-gated `subscribe`** — node-side: only relay/deliver pubsub on a topic to peers presenting a valid `ce-cap` grant for it. This is genuinely a primitive (the node enforcing capability on transport) and benefits every app, not just Notes. Propose to the ce-cap/mesh owners separately; NOT required (envelope encryption already gives confidentiality). Until then, non-members can see ciphertext volume/metadata only.

We will not add note-specific endpoints to the node under any circumstance.

---

### 9. API / CLI / UI surface (concrete)

**`ce-notes-core` (Rust):**
```rust
pub struct Notes { coord: Coord, client: CeClient, device_x25519: StaticSecret }
impl Notes {
    pub async fn open(coord: Coord) -> Result<Notes>;                 // reads node identity, derives X25519
    pub async fn create_space(&self, name: &str) -> Result<Space>;     // gens space_key, self-member
    pub async fn import_invite(&self, invite: &[u8]) -> Result<Space>; // verifies grant, unwraps key
    pub async fn spaces(&self) -> Result<Vec<SpaceMeta>>;
}
pub struct Space { /* holds MergeSet<NoteOp>, Yjs docs, space_key */ }
impl Space {
    pub fn notes(&self) -> Vec<NoteHeader>;
    pub fn note(&self, id: &NoteId) -> Option<NoteView>;               // local, sync
    pub async fn create_note(&self, folder: Option<FolderId>) -> Result<NoteId>;
    pub async fn edit(&self, id: &NoteId, edit: TextEdit) -> Result<Version>; // applies to Y.Text, publishes encrypted update
    pub async fn delete_note(&self, id: &NoteId) -> Result<()>;        // tombstone
    pub async fn attach(&self, id: &NoteId, path: &Path) -> Result<AttachmentRef>; // encrypt+put_object
    pub async fn fetch_attachment(&self, a: &AttachmentRef) -> Result<Vec<u8>>;    // get_object+decrypt
    pub async fn invite(&self, x25519_pub: [u8;32], role: Role) -> Result<Vec<u8>>; // wrapped key + ce-cap grant
    pub async fn revoke(&self, device: &DeviceId) -> Result<()>;       // rotate + re-wrap + on-chain revoke
    pub fn sync_status(&self) -> Vec<PeerSync>;                        // per-peer version() vs target
}
```

**`ce-notes` CLI:**
```
ce-notes space new "Work"
ce-notes space ls
ce-notes new --space <id> [--folder <fid>] "Note title"
ce-notes ls --space <id>
ce-notes cat <note_id>
ce-notes edit <note_id>                 # opens $EDITOR; diff applied to Y.Text on save
ce-notes attach <note_id> ./diagram.png
ce-notes invite --space <id> --to <x25519_or_nodeid> --role writer   # prints invite blob
ce-notes import <invite_blob_file>
ce-notes revoke --space <id> --device <node_id>
ce-notes sync --space <id>              # prints per-peer sync status
ce-notes tui                            # ratatui: folder tree | note list | markdown editor + sync gutter
```

**Web (`@ce-net/notes` on `@ce-net/sdk`):** same envelope + `NoteOp` wire format. CodeMirror 6 + Yjs binding for the editor; `y-indexeddb` for local persistence; calls `@ce-net/sdk` `publish/subscribe/messages/request/reply/putObject/getObject`. UI: 3-pane (spaces/folders, note list, editor) + per-peer sync dots + share dialog that produces the invite blob and a `ce-cap` grant.

---

### 10. Testing strategy

- **Unit (ce-notes-core):** envelope encrypt/decrypt round-trips; X25519 derivation from a known Ed25519 key; key wrap/unwrap; `MergeLog::apply` idempotence; Yjs update commutativity (apply A then B == B then A) via the wrapped CRDT.
- **CRDT convergence property test:** generate N random edit sequences on M docs, apply in random orders/with duplicates, assert identical final `Y.Text` on every replica.
- **ce-coord integration (local, multi-node):** reuse the workspace `e2e-replicate.sh`/`repl-boot.sh` pattern — spin 2–3 local nodes (`NEXT_PORT` discipline), create a space on node A, edit concurrently on A and B offline, reconnect, assert convergence via `await_version`/`version()`. Verify catch-up after a node restarts.
- **Encryption/authorization:** a 3rd node subscribed to the topic sees only ciphertext (assert it cannot decrypt without the wrapped key); a revoked member's post-rotation updates are not applied; non-member writer-log entries are filtered.
- **Attachments:** attach a >1MiB file → `put_object` → fetch on a second device → byte-identical after decrypt; tampered chunk is rejected (data-layer CID verify).
- **Snapshot/catch-up at scale:** 5k edits, fresh reader bootstraps from snapshot + tail, asserts equality and bounded replay time.
- **Web parity:** golden vectors — a `NoteOp` produced by Rust decrypts+applies in the TS client and vice versa (lockstep crypto + Yjs version compatibility).

---

### 11. Risks

- **Yjs is JS-first; Rust needs a compatible CRDT.** Rust core must speak the *same* update binary format as the web. Mitigation: use `yrs` (the official Rust Yjs port) in `ce-notes-core`; pin matching protocol versions and gate on cross-language golden vectors in CI. If `yrs`↔`yjs` drift bites, fall back to `loro` (Rust-native, has WASM) behind the `NoteDoc` trait — keep the CRDT behind an interface from day one.
- **Per-device writer-log fan-out.** N members ⇒ each device runs N reader-logs; the 250ms pump and per-log subscriptions could get chatty for large spaces. Mitigation: SSE push (M4), snapshotting (M5), and cap v1 at small spaces (≤ ~8 devices), documented like ce-coord's own limits.
- **Metadata leakage to relays.** Even with ciphertext, a relay sees topic names (`notes-<space>`), update sizes, and timing. Mitigation: hash/salt space ids into topic names; pad updates to size buckets (post-MVP); the capability-gated subscribe (§8.2) closes most of it.
- **Key/identity coupling.** Deriving X25519 from the node key ties notebook crypto to the device identity; rotating the node key orphans wrapped keys. Mitigation: store a *separate* per-space Curve25519 device keypair (Anytype-style) in `space.json` rather than deriving from the node key, if rotation becomes a need; ship MVP with derivation but design `MemberEntry.wrapped_key` to carry an explicit pubkey so this is swappable.
- **Single-writer relapse for the index doc.** If we accidentally make the space index a single-writer ce-coord collection, an offline owner stalls renames. Mitigation: the index is itself a Yjs `Y.Map` synced via the same MergeSet, never a plain `RMap`.
- **No JS SDK exists yet at a known path.** `@ce-net/sdk` is referenced but not found in the workspace. Risk to the web milestone. Mitigation: M6 includes producing/confirming the JS SDK surface (thin fetch wrapper mirroring ce-rs); the CLI/TUI milestones do not depend on it.

---

### 12. Milestones (effort)
See structured milestones field. Summary path: M1 core crypto+CRDT → M2 single-space 2-device CLI sync → M3 attachments+folders+TUI → M4 SSE push → M5 sharing+revocation+snapshot → M6 web app on @ce-net/sdk.

## Milestones

| Milestone | Deliverable | Effort |
|---|---|---|
| M1 — Core crypto + CRDT primitives | ce-notes-core crate: XChaCha20-Poly1305 envelope, X25519-from-Ed25519 derivation, WrappedKey seal/unseal, SpaceMeta model, NoteDoc trait backed by yrs (Yjs-compatible), MergeLog StateMachine. Unit + property tests (commutativity, idempotence, golden vectors stubbed). | L |
| M2 — CLI MVP: one space, two devices, encrypted sync | ce-notes binary with space new/new/ls/cat/edit; MergeSet wrapper over per-device ce-coord Replicated logs; create on node A, edit on B, converge via await_version. Local e2e script proving offline-edit-then-reconnect convergence. Node unchanged. | L |
| M3 — Attachments, folders, TUI | Encrypted attachments via put_object/get_object referenced by {cid,key} in the CRDT; folder tree + tombstone deletes; ratatui TUI (tree | list | editor + per-peer sync gutter). | L |
| M4 — SSE push (latency) | ce-rs wrapper over existing GET /mesh/messages/stream; ce-coord/ce-notes switched from 250ms poll to push. No node change. Benchmark latency before/after. | S |
| M5 — Sharing by capability, revocation, snapshotting | invite/import flow (wrapped key + ce-cap grant via ce-cap crate); revoke = key rotation + re-wrap + on-chain RevokeCapability; per-doc snapshot-to-blob checkpoint with fresh-reader bootstrap. Tests: revoked member cannot apply post-rotation; fresh reader converges from snapshot. | XL |
| M6 — Web app on @ce-net/sdk | @ce-net/notes TS package: CodeMirror+Yjs editor, y-indexeddb persistence, same envelope/NoteOp wire format, 3-pane UI + share dialog. Cross-language golden-vector parity with Rust core in CI. Confirms/produces the @ce-net/sdk JS surface. | XL |


## Risks

- Rust/JS CRDT format parity: yrs must stay byte-compatible with yjs across versions; mitigate with pinned versions + cross-language golden vectors in CI, NoteDoc trait to allow Loro fallback.
- Per-device writer-log fan-out: each member runs N reader-logs; chatty at scale. Mitigate with SSE push, snapshotting, and a documented small-space cap (~8 devices) like ce-coord's own limits.
- Metadata leakage to relays even with ciphertext (topic names, sizes, timing); mitigate with salted topic names, size-bucket padding, and the optional capability-gated subscribe.
- Key derivation couples notebook crypto to the node identity key — rotating the node key orphans wrapped keys; mitigate by carrying an explicit pubkey in MemberEntry so a per-space device keypair can replace derivation.
- @ce-net/sdk (JS) is referenced but not present in the workspace; the web milestone depends on producing/confirming it. CLI/TUI milestones are insulated from this.
- ce-coord single-writer model must not leak into the design: index/folders must be a Yjs Y.Map over MergeSet, never a plain RMap, or an offline owner stalls renames.

## Open questions

- Use yrs (official Rust Yjs port) vs loro for the Rust core? yrs maximizes web parity; loro is Rust-native with better large-doc history. Recommend yrs for v1 behind a NoteDoc trait.
- Derive X25519 from the node Ed25519 key, or carry an independent per-space device keypair (Anytype-style)? MVP derives; design keeps it swappable.
- Should the capability-gated subscribe become a real node/ce-cap primitive now, or defer entirely to envelope encryption? Recommend defer; propose separately as a general primitive.
- Does @ce-net/sdk exist? If not, scope its creation (thin fetch mirror of ce-rs) into M6 or a precursor.
- Snapshot cadence/policy: every K updates vs size threshold vs time — needs a heuristic and a way to prune superseded per-writer log tails.
