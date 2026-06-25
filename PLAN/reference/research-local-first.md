I have sufficient material. Let me synthesize the final report.

---

# Local-First / CRDT Architecture for "CE Notes"

A multi-device, end-to-end-encrypted Notes app on the CE peer-to-peer mesh.

## 1. The target: Ink & Switch's seven ideals

The [Ink & Switch "Local-First Software" essay](https://www.inkandswitch.com/essay/local-first/) defines seven properties. They are the acceptance criteria for CE Notes, and CE's substrate maps onto them unusually well:

| Ideal | Meaning | CE fit |
|---|---|---|
| **Fast** | No network round-trip on read/write; the local replica is the source of truth | Local CRDT doc on each device; mesh sync is async/background |
| **Multi-device** | Your devices converge when connected | `ce-coord` log replication + mesh transport across your NodeIds |
| **Offline** | Full functionality with no connection | CRDT edits buffer locally; sync on reconnect — no server dependency |
| **Collaboration** | Concurrent edits merge without conflicts | Text CRDT (Yjs/Loro/Automerge) guarantees convergence |
| **Longevity** | Works in 10 years, vendor-independent | CE is open substrate; data is plain CRDT bytes + content-addressed blobs you hold |
| **Privacy** | Data can stay on-device / E2E encrypted | Encrypt CRDT updates *before* they touch the mesh; nodes relay ciphertext |
| **User ownership** | Export, move, control your data | NodeId = your key; blobs are content-addressed and portable |

The core insight from the essay and from [PowerSync's local-first overview](https://powersync.com/blog/local-first-software-origins-and-evolution): **the device is the primary home for data; sync is secondary, not foundational.** CE is already built this way — every node is autonomous and the mesh is a transport, not an authority.

## 2. Text CRDT choice: Yjs vs Automerge vs Loro

The library choice drives performance, memory, and persistence behavior.

### Yjs — the production default
- Largest ecosystem (~920K weekly downloads, editor bindings for CodeMirror, ProseMirror, Monaco, Quill, TipTap), per the [PkgPulse 2026 comparison](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026) and [Velt's CRDT guide](https://velt.dev/blog/best-crdt-libraries-real-time-data-sync).
- Fast for sequential text editing; compact in-memory model (YATA algorithm).
- **Weakness: no meaningful history.** Yjs discards rich history; point-in-time recovery requires storing a Version Vector + Delete Set per snapshot, which adds overhead beyond the document size. Sync is *update-based* (binary `Y.encodeStateAsUpdate` / `Y.applyUpdate`), which is exactly what we want to encrypt and ship over the mesh.

### Automerge — Git-like history
- Rust core + WASM bindings; the [Ink & Switch "Towards Production"](https://inkandswitch.github.io/automerge-rs/post/towards-production/) rewrite closed much of the historical performance gap.
- **Strength: preserves the full change DAG** — every keystroke, with branching and point-in-time recovery, like Git. Native maps (better for structured/typed object data; Yjs builds maps on lists).
- `automerge-repo` separates network/storage into a pluggable layer — a clean seam to drop in a CE transport.
- **Cost:** keeping full history is heavier on storage/memory for long-lived docs.

### Loro — fastest, youngest
- Tops the [Loro JS/WASM benchmarks](https://loro.dev/docs/performance); implements modern Eg-walker-style techniques. Stores a full editing DAG yet stays compact.
- Based on the [Eg-walker paper "Better, Faster, Smaller"](https://arxiv.org/pdf/2409.14252) — a list/text CRDT that is materially faster and smaller than prior designs.
- **Cost:** smallest ecosystem (~12K downloads), youngest, fewer editor bindings.

### Recommendation
**Use Yjs for v1.** It is the lowest-risk path: mature, binary update-based sync that maps cleanly onto CE's "ship opaque encrypted bytes" model, and rich editor bindings so the editing UX is solved. Persist with `y-indexeddb` (web) / a local file (desktop). Keep the CRDT behind a thin `NoteDoc` interface so **Loro is a drop-in upgrade** later if you want full history + better large-doc performance. Automerge only if document-level Git-style history/branching becomes a headline feature.

## 3. Sync protocol: sync-server vs peer sync

Two ends of a spectrum, both visible in the field:

- **Sync-server model** (Yjs `y-websocket`, automerge-repo over a relay): a server (or relay) fans out updates. Simple, low-latency, but a central dependency.
- **Peer-sync model** (Yjs `y-webrtc`, [`lan-vault-sync` for Obsidian](https://github.com/senjanson/lan-vault-sync), Anytype P2P): devices exchange updates directly, no server in the path.

**CE gives you a third, better option: the mesh is the relay, but it's trustless and yours.** CE's relay-traversed mesh (libp2p + NAT traversal via the Hetzner relay) already does authenticated device-to-device delivery. You get peer-sync semantics (no proprietary server, no vendor) with sync-server convenience (works through NAT, devices need not be online simultaneously if a relay buffers). Critically, **CE authenticates the sender NodeId on every message** (`AppMessage.from` is verified against the Noise PeerId) — so a replica can trust *who* authored an update for free, which is the hard part of peer sync.

## 4. End-to-end encryption of CRDT updates

This is the privacy ideal, and the pattern is established: [Serenity Notes](https://www.npmjs.com/package/yjs) is an E2E-encrypted collaborative notes app built on Yjs, and there are documented [architectures to relay E2E-encrypted CRDTs over an untrusted central service](https://github.com/yjs/yjs). [Anytype's any-sync](https://github.com/anyproto/any-sync) does exactly this at scale: **each device applies and cryptographically verifies CRDT updates, and backup nodes store encrypted data they cannot read**, with per-object keys controlled by the user (per [Anytype's architecture writeup](https://hilton.org.uk/blog/anytype-local-first) and [tech docs](https://tech.anytype.io/any-sync/overview)).

The design rule that makes this work:

> **CRDT bytes are encrypted before they leave the device. The mesh only ever sees ciphertext. Merge happens on plaintext, inside the device, after decryption.**

Concretely for CE Notes:

- Each **note (or notebook/"space")** has a symmetric **content key** (e.g. XChaCha20-Poly1305 / AES-256-GCM). This matches Anytype's "encrypts objects with per-document keys."
- A Yjs update is `encrypt(content_key, Y.encodeStateAsUpdate(...))`. The ciphertext (plus a nonce + key-id) is the payload CE ships.
- The content key is **wrapped** per authorized device: encrypt it to each device's public key. A device's CE NodeId is an Ed25519 key; derive an X25519 key for the wrap (or carry a separate per-space curve25519 keypair, Anytype-style). New device → owner re-wraps the content key to it. Revoke → rotate the content key, re-wrap to the survivors (forward-secrecy boundary; old ciphertext stays readable, which is the correct local-first tradeoff).
- CE's verified `from` NodeId gives you **authenticity** (who signed this update); your envelope encryption gives you **confidentiality**. The two are orthogonal and both needed.

CE's economy/relay layer never decrypts. This is the same trust posture as Anytype backup nodes and is fully compatible with CE's "nodes relay opaque payloads" model — CEP-1 and AppMessage payloads are explicitly opaque bytes the node never parses.

## 5. Attachments / blobs

Images, PDFs, audio don't belong in the CRDT — they bloat the op log. Every serious system splits them out: [Eidetica provides object storage for large binary data separate from CRDT state](https://www.npmjs.com/package/yjs); Anytype's any-sync separates **file nodes** from document trees.

**CE already has the right primitive: the data layer** (`ce/docs/data-layer.md`). It is content-addressed (CID = sha256), chunked (1 MiB), DHT-discoverable (Kademlia provider records), self-replicating, verifiable per chunk, and optionally paid via payment channels.

Pattern for CE Notes:
1. Encrypt the attachment with its own random key.
2. `put_object` the ciphertext → get a CID.
3. Store **`{cid, file_key, nonce}` inside the CRDT** (the small reference travels in the encrypted op stream; the heavy bytes go through the data layer).
4. Any device with the note decrypts the reference, fetches the blob by CID from the mesh (swarmed, verified against the hash), and decrypts it locally.

This gives content-addressed dedup (same image attached twice = one blob), trustless transfer (bad bytes are detected and refetched), and offline-friendly caching — all already implemented in CE's data layer (Stages 1–4 done).

## 6. Conflict-free editing & offline

These come **for free from the CRDT** — that is the entire point of choosing one over OT (see [CRDT vs OT](https://beefed.ai/en/crdt-vs-ot-choose-algorithm)). Concurrent edits on two offline devices both apply locally; on reconnect each device applies the other's encrypted updates and both converge to the identical state, with no server arbiter and no merge conflict UI. The [offline-first IndexedDB + Yjs pattern](https://dev.to/hexshift/building-offline-first-collaborative-editors-with-crdts-and-indexeddb-no-backend-needed-4p7l) is the proven web recipe. CE's `ce-coord` reader already buffers out-of-order entries and repairs gaps via catch-up — the same convergence discipline at the transport layer.

## 7. How comparable apps do multi-device (and what to copy)

- **Obsidian:** file-based, no native CRDT. Sync is whole-file (proprietary Obsidian Sync, or Git/Syncthing). CRDT merging only via community hacks like [`lan-vault-sync`](https://github.com/senjanson/lan-vault-sync) (Yjs over P2P WebSocket). **Lesson: file-sync is a hack; per-keystroke CRDT is first-class. Don't be Obsidian here.**
- **Logseq:** local-first Markdown files; Logseq Sync uses **`age` for E2E encryption**; free options are Syncthing/Git. On-disk encryption was deprecated in favor of OS-level tools (VeraCrypt/EncFS) — per the [privacy-tools discussion](https://discuss.privacyguides.net/t/local-knowledgebase-tools-obsidian-logseq-trilium/11543). **Lesson: file sync + separate E2E layer works but isn't conflict-free at sub-file granularity.**
- **Anytype:** the gold standard for this brief — **CRDT objects as a first-class citizen, per-document keys, E2E sync where relay/backup nodes store unreadable ciphertext, P2P over LAN or encrypted relays**, via the open [any-sync protocol](https://github.com/anyproto/any-sync). **CE Notes should architecturally resemble Anytype, but with CE's mesh + ledger as the substrate any-sync's coordinator/sync/file nodes provide.**

The throughline ([eesel's roundup](https://www.eesel.ai/blog/obsidian-alternatives), [CoCube](https://www.cocube.com/blog/best-obsidian-alternatives)): **CRDT/encrypted-object sync as a first-class feature beats file-sync hacks.**

## 8. Mapping onto CE primitives

| CE Notes need | CE primitive | Notes |
|---|---|---|
| Device identity / "who are my devices" | **Ed25519 NodeId** (`ce-identity`) | Each device is a key. Authorized-device set = keys you wrapped the content key to. No accounts. |
| Authenticated update delivery | **App messaging** (`/mesh/publish`, `/mesh/request`, `ce-rs` `publish`/`subscribe`/`request`) | `from` NodeId is Noise-verified — free authorship guarantee. |
| Ordered convergent state | **`ce-coord` `Replicated<S>` / `RMap`** | Single-writer log w/ versioning, gap repair, catch-up. Notes-list/index fits the writer model; per-doc text uses CRDT bytes shipped as ops. |
| Blob/attachment transfer | **Data layer** (`put_object`/`get_object`, `FetchChunk`, Kademlia providers) | Content-addressed, chunked, verified, self-replicating, optionally paid. |
| NAT traversal / relay | **libp2p relay + DCUtR** (Hetzner relay, auto-bootstrap) | Devices behind NAT reach each other; relay only sees ciphertext. |
| Confidentiality | *App-layer envelope encryption* (NOT a node primitive) | CE deliberately ships opaque payloads; E2E is the app's job — correct per the CE/app boundary. |
| Paid relay/storage (optional) | **Payment channels** (`ce-chain` `ChunkReceipt`) | If you want guaranteed availability beyond your own always-on device, pay a relay to hold ciphertext. |

The CE/app boundary (`ce/docs/primitives.md`) puts CE Notes firmly in **app** territory: CE owns mechanism (identity, authenticated transport, blobs, economy); the Notes app owns policy (encryption scheme, key management, document model, UX). This is the same tier as `swarm` and `rdev`, layered as **`CE Notes → ce-coord → ce-rs → local ce node → mesh`.**

## 9. Recommended architecture for "CE Notes"

```
┌────────────────────────── Device (e.g. laptop NodeId) ──────────────────────────┐
│  Editor (CodeMirror/ProseMirror) ── binds ──► Yjs Y.Doc  (one per note)          │
│        │ local read/write: instant, offline                                      │
│        ▼                                                                          │
│  NoteDoc abstraction  ──persist──► y-indexeddb / local file  (durable, offline)  │
│        │ Y.encodeStateAsUpdate(update)                                            │
│        ▼                                                                          │
│  Crypto envelope:  ciphertext = AEAD_encrypt(space_content_key, update, nonce)   │
│        │  (content_key wrapped per-device via X25519-from-NodeId)                 │
│        ▼                                                                          │
│  ce-rs:  publish("ce-notes/<space>/ops", {nonce, key_id, ciphertext})            │
│          request(writer, "ce-notes/<space>/catchup", {from_version})  ← gap fill │
│  Attachments: encrypt → put_object(ciphertext) → CID → store {cid,key} in Y.Doc  │
└──────────────────────────────────────────────────────────────────────────────────┘
        ▲  authenticated `from` NodeId, opaque ciphertext only
        │
   ┌────┴───────────────── CE mesh (libp2p, relay-traversed) ──────────────────┐
   │  gossip ops topic  ·  request/reply catch-up  ·  Kademlia blob providers  │
   │  Relay (Hetzner): stores/forwards CIPHERTEXT — never decrypts             │
   └───────────────────────────────────────────────────────────────────────────┘
        │
        ▼  (mirror image of the device stack: decrypt → applyUpdate → converge)
   Other device (phone NodeId) → identical convergent Y.Doc
```

**Concrete decisions:**

1. **CRDT:** Yjs v1, behind a `NoteDoc` interface (Loro as the planned upgrade for history/large docs).
2. **Unit of sharing = "space"** (a notebook / vault), Anytype-style: one symmetric content key per space, wrapped per authorized device.
3. **Sync = `ce-coord`-style log per space**, but shipping **encrypted Yjs update bytes** as the ops. The writer for the space index is your "primary" device; per-note text edits are CRDT-merged so any device can edit offline and converge (don't over-rely on single-writer for the text itself — use it for the notes-list/metadata, full CRDT for prose).
4. **Encryption is app-layer**, before publish. The mesh and relay see only ciphertext + verified sender NodeId.
5. **Attachments via the data layer**, encrypted, referenced by `{cid, key}` inside the CRDT.
6. **Always-available copy:** rely on your own always-on device (e.g. the desktop node) as the durable replica; optionally pay a relay via payment channels to retain ciphertext for true device-independent availability.
7. **Key management:** owner device wraps the space key to each new device's NodeId-derived X25519 key; revocation = rotate the space key + re-wrap to survivors (recorded in the space's metadata CRDT).

**v0 limits to plan around** (from `ce-coord/README.md`): single-writer log stalls on writer outage (use full CRDT merge for text to avoid this on the edit path; Raft for the index is the next layer), unbounded log (snapshot to `put_object` by CID, then tail), and 250 ms polling pump latency (switch to the node's SSE `/mesh/messages/stream` for push). All have documented upgrade paths that don't change app call sites.

---

### Relevant CE files
- `/Users/07lead01/ce-net/ce/docs/primitives.md` — CE/app boundary; app messaging + data layer as primitives
- `/Users/07lead01/ce-net/ce/docs/data-layer.md` — content-addressed chunked blob layer (attachments)
- `/Users/07lead01/ce-net/ce/docs/app-messaging.md` — directed/pubsub/request-reply, verified `from` NodeId
- `/Users/07lead01/ce-net/ce-coord/src/replicated.rs` — the log-replicated state-machine engine to model sync on
- `/Users/07lead01/ce-net/ce-coord/README.md` — coordination tier, scaling limits + upgrade paths

### Sources
- [Ink & Switch — Local-First Software](https://www.inkandswitch.com/essay/local-first/)
- [PowerSync — Local-First Origins and Evolution](https://powersync.com/blog/local-first-software-origins-and-evolution)
- [PkgPulse — Yjs vs Automerge vs Loro 2026](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026)
- [Velt — Best CRDT Libraries 2025](https://velt.dev/blog/best-crdt-libraries-real-time-data-sync)
- [Ink & Switch — Automerge Towards Production](https://inkandswitch.github.io/automerge-rs/post/towards-production/)
- [Loro — JS/WASM Benchmarks](https://loro.dev/docs/performance)
- [Eg-walker — Better, Faster, Smaller (arXiv)](https://arxiv.org/pdf/2409.14252)
- [CRDT vs OT](https://beefed.ai/en/crdt-vs-ot-choose-algorithm)
- [Yjs (npm) — incl. Serenity Notes E2E example](https://www.npmjs.com/package/yjs)
- [Offline-first CRDT + IndexedDB editors](https://dev.to/hexshift/building-offline-first-collaborative-editors-with-crdts-and-indexeddb-no-backend-needed-4p7l)
- [Anytype any-sync (GitHub)](https://github.com/anyproto/any-sync)
- [Anytype's local-first architecture — Peter Hilton](https://hilton.org.uk/blog/anytype-local-first)
- [Anytype any-sync protocol overview](https://tech.anytype.io/any-sync/overview)
- [lan-vault-sync — Yjs CRDT Obsidian sync](https://github.com/senjanson/lan-vault-sync)
- [Privacy Guides — Obsidian/Logseq/Trilium discussion](https://discuss.privacyguides.net/t/local-knowledgebase-tools-obsidian-logseq-trilium/11543)
- [eesel — Obsidian alternatives 2025](https://www.eesel.ai/blog/obsidian-alternatives)
- [CoCube — Best Obsidian alternatives 2026](https://www.cocube.com/blog/best-obsidian-alternatives)