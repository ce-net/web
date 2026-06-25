# CE Wallet: Credits + Capabilities Management (CLI, SDK, Dashboard)

> Workstream: `token-mgmt` · Suggested target path: `ce/docs/wallet.md`
> Depends on: none

**Summary:** CE today has the economic and authorization primitives (credits, payment channels, ce-cap capability chains, on-chain RevokeCapability) but no coherent "wallet" story for end users: balance is split across scattered commands, there is no transaction history surface, and — the single most dangerous gap — there is no backup/recovery path for the Ed25519 node.key, so losing that 32-byte file permanently loses all funds and identity. This workstream unifies everything a user needs to manage their money and authority into one mental model with two clearly-separated halves: a credit wallet (balance/locked/free/bond, transfers, channels, history) and a capability wallet (issue/hold/revoke authority). It ships as (1) a redesigned `ce wallet` CLI subtree, (2) wallet modules in `ce-rs` (Rust) and a new `@ce-net/sdk` (TS), and (3) a Wallet panel in the dashboard, composing only existing CE primitives. The only node changes required are two thin read endpoints (`GET /transactions/:node_id` and a balance breakdown in `/status`) plus a guarded `ce key export/import` built on the existing `Identity` API — no consensus or new-RPC changes.

---

# CE Wallet — Token & Capability Management

> Workstream key: `token-mgmt`. Owner-facing money + authority management across CLI, SDK, and dashboard. Built on existing CE primitives; minimal node surface added.

## 0. The core distinction users must internalize

CE has **two tokens of value** and the wallet must never blur them:

| | **Credits** | **Capabilities** |
|---|---|---|
| What it is | The economic token (u128 base units, 10^18 = 1 credit) | The authorization token (signed, attenuating `ce-cap` chain) |
| Backed by | PoW chain ledger | Ed25519 signatures rooted in a key you trust |
| Transferable | Yes (`/transfer`, on-chain) | Delegable, but only *narrower* (attenuation) — not "transferred" |
| Spent on | Running jobs, channels, bonds, relay pay | Nothing — it *grants the right* to do something on a resource |
| Lost if you lose `node.key` | **Yes — irrecoverably** | Yes (you can no longer prove you're the audience) |
| Revoked by | n/a (spent or transferred) | expiry, on-chain `RevokeCapability`, root rotation |

The CLI, SDK, and dashboard are organized around this split: a **credit wallet** (money) and a **capability wallet** (authority). The unifying word "wallet" is fine, but every surface labels which half it is showing.

## 1. Goals / Non-goals

### Goals
1. **One coherent money view**: total / free / locked-in-channels / locked-in-bond, in one command and one dashboard panel, amounts always base-unit-string on the wire and human credits in UI.
2. **Transaction history**: a queryable, streamable record of what happened to *my* credits (transfers, job settles, heartbeats, channel opens/closes, rewards, bond, slashes), via a new thin read endpoint + the existing `/transactions/stream` SSE for live tail.
3. **Key custody & recovery** — the headline gap. `ce key export` to an encrypted, human-transcribable backup (BIP39-style mnemonic over the 32-byte seed, plus an encrypted file), `ce key import` to recover, and clear "BACK THIS UP" onboarding. Losing `node.key` = losing funds today; this makes recovery a first-class flow.
4. **Capability lifecycle UX**: issue (`ce wallet grant`), hold (`ce wallet cap add/ls/rm`), inspect (decode + show abilities/caveats/expiry/revocation status), revoke (`ce wallet cap revoke`), all from the wallet subtree, reusing the existing `ce grant`/`/capabilities/revoke` machinery.
5. **Multi-machine identity**: a documented, safe way to run the *same* identity on laptop+desktop, or (recommended) distinct identities with a capability link — with explicit warnings about the equivocation-slashing hazard of sharing a bonded key.
6. **SDK parity**: a `wallet` module in `ce-rs` and a `WalletClient` in `@ce-net/sdk` exposing the same surface, with `Amount`/`bigint` money types so no float ever touches a balance.

### Non-goals
- No new consensus rules, no new `TxKind`, no new mesh RPC. (Per architecture: device-to-device features go over AppRequest+ce-cap; but wallet management is *local-node* + *read-only chain queries*, so it's HTTP/SDK only.)
- No hosted/custodial wallet, no seed-phrase-as-a-service. Keys stay on the user's machine.
- No hardware-wallet/secure-enclave integration in v1 (listed as a risk/future).
- No multisig credits (would need consensus changes) — out of scope.

## 2. Architecture & primitive composition

```
            ┌──────────────────────────────────────────────┐
  Dashboard │  Wallet panel (web/)                          │
   (TS)     │   ├ Credits tab  (balance, history, channels) │
            │   └ Capabilities tab (held/issued, revoke)    │
            └───────────────┬──────────────────────────────┘
                            │  @ce-net/sdk  (WalletClient, Amount, SSE)
  ┌─────────────────────────┼───────────────────────────────────┐
  │  ce CLI  `ce wallet …`  │       ce-rs  ce_rs::wallet          │
  └─────────────────────────┼───────────────────────────────────┘
                            │ HTTP :8844 (Bearer api.token)
            ┌───────────────▼──────────────────────────────┐
   ce-node  │  /status (+breakdown) /transactions/:id (NEW) │
            │  /transfer /channels/* /capabilities/*        │
            │  /transactions/stream (live tail)             │
            └───────────────┬──────────────────────────────┘
                            │ in-process
            ┌───────────────▼──────────────────────────────┐
            │ ce-chain (balances, NodeStats, channels,      │
            │ bonds, tx_index) · ce-identity (node.key) ·   │
            │ ce-cap (issue/verify/encode_chain) ·          │
            │ ce-node capability.rs (revoke set)            │
            └──────────────────────────────────────────────┘
```

Everything the wallet does is one of: a read of existing chain state, a call to an existing economy endpoint (`/transfer`, `/channels/*`), a call to the existing capability path (`ce grant` → `encode_chain`; `/capabilities/revoke`), or a **local** operation on `node.key` via `ce-identity`. The only genuinely new node code is two read surfaces and the key export/import command.

### What changes in the node (and why it's minimal)

1. **`GET /status` gains a balance breakdown** (additive, non-breaking). Today it returns `balance`. Add `free`, `locked_channels`, `locked_bond`, `bond`, all base-unit strings. The chain already computes `balance(node)`, `locked_balance(node)` (channels), and `bonds` — this is a struct-assembly change in the `/status` handler, no new state.

2. **`GET /transactions/:node_id` (NEW, read-only)** — the missing history endpoint. CE has `tx_index: HashMap<tx_id,(block_index,pos)>` and the full chain; this endpoint walks blocks (or an index) and returns every tx where the node is `origin` or a named participant (`from`/`to`/`payer`/`host`/`cell`/`node`/`miner`). Returns newest-first, paginated by `?before_height=&limit=` (default 100, max 500). This mirrors the existing `/history/:node_id` (aggregate `NodeStats`) but returns the **itemized list** the wallet needs. Archive nodes serve full history; light nodes serve post-checkpoint only (document this).
   - Response item: `{ tx_id, height, kind, amount, counterparty?, direction: "in"|"out"|"self", confirmed: bool }` where `kind ∈ Transfer|UptimeReward|JobBid|JobSettle|JobExpire|Heartbeat|ChannelOpen|ChannelClose|ChannelExpire|HostBond|HostUnbond|SlashEquivocation|NameClaim|RevokeCapability`. `amount` is base-unit string; `direction` and `counterparty` are computed relative to the queried node.

3. **`ce key export` / `ce key import` (NEW CLI; mostly local).** No HTTP endpoint by default — key material must not cross the API boundary. The CLI reads `<data_dir>/identity/node.key` (32-byte seed via `Identity::secret_bytes()`), and:
   - `export --mnemonic` → renders the 32-byte seed as a 24-word BIP39 mnemonic (printed to TTY only, with a scary banner; never logged, never to a file unless `--out`).
   - `export --out <path> [--encrypt]` → writes an encrypted keystore JSON (scrypt/argon2id KDF + XChaCha20-Poly1305 over the 32 bytes), prompting for a passphrase.
   - `import --mnemonic | --in <path>` → reconstructs the 32 bytes, refuses to overwrite an existing `node.key` unless `--force`, writes it chmod 600.
   - Rationale for NOT adding an HTTP `/key/export`: it would let any holder of the api.token exfiltrate the identity, turning a local-file-permission problem into a network-reachable one. Key export stays a deliberate, interactive, same-host CLI action. (We add a `GET /status`-level `key_backed_up: bool` hint only if we choose to persist a "backup acknowledged" flag — optional, see milestones.)

Nothing else in the node changes. No new mesh RPC, no consensus.

## 3. CLI surface — `ce wallet`

The existing top-level `ce balance`, `ce fund`, `ce grant`, `ce revoke`, `ce wallet add/ls/rm`, and `ce channel …` are **kept as aliases** but reorganized under one discoverable `ce wallet` tree (and the old `ce wallet add/ls/rm` for capabilities moves under `ce wallet cap …`). Concrete subtree:

```
ce wallet                      # default: prints the credit summary (alias of `ce wallet balance`)
ce wallet balance              # money view (replaces bare `ce balance`)
  → total : 12,345 credits
    free  : 11,000
    locked: 1,345  (channels 1,000 · bond 345)
    bond  : 345 (active)   weight: …
ce wallet history [--limit 50] [--kind transfer,settle] [--watch]
  # GET /transactions/:self  ; --watch tails /transactions/stream filtered to self
ce wallet send <to> <amount> [--memo …]        # alias of `ce fund`; POST /transfer
ce wallet receive                              # prints your node id + a `ce://pay/<id>` URI + QR
ce wallet channel open|ls|receipt|close|expire # re-exports existing `ce channel …`
ce wallet bond <amount> | unbond               # POST a HostBond/HostUnbond tx (see note)

# --- capability half ---
ce wallet grant <node-id> --can … [--resource …] [--expires …] [--port …] [--path …] [--max-*]
  # exact existing `ce grant`, re-homed; prints token + `ce wallet cap add` hint
ce wallet cap add <alias> <node-id> --cap <token>   # store a held capability (was `ce wallet add`)
ce wallet cap ls [--issued|--held]                  # held caps (wallet.toml) + caps I issued (by nonce)
ce wallet cap show <alias|token>                    # decode_chain → abilities, resource, caveats,
                                                    #   expiry, revoked? (checks /capabilities/revoked)
ce wallet cap rm <alias>
ce wallet cap revoke <nonce>                         # alias of `ce revoke`; POST /capabilities/revoke

# --- key custody ---
ce key export [--mnemonic | --out <file> [--encrypt]]   # see §2.3
ce key import [--mnemonic | --in <file>] [--force]
ce key backup                                            # convenience: guided mnemonic flow + confirm
ce key fingerprint                                       # node id + short fp (for verifying a backup)
```

### Onboarding hook (critical UX)
On first `ce start` (when `node.key` is freshly generated), and on every `ce status`/`ce wallet` while no backup has been acknowledged, print a one-line nag:

```
! Your identity key is not backed up. Lose ~/.local/share/ce/identity/node.key and you
  lose this node's funds and name permanently. Run `ce key backup` now.
```

`ce key backup` runs the mnemonic flow, then asks the user to re-type 3 random words to confirm they wrote it down, then records `backed_up=true` in `<data_dir>/wallet-meta.toml` (local only) to silence the nag. This is the single highest-leverage UX change in the workstream.

### Design rules honored
- All amounts parsed/printed via the existing `parse_credits`/`format_credits` (CLI) — human decimals in, human decimals out, base units on the wire.
- Per `docs/design.md`: no emojis; aligned columns; the nag uses `!` not an emoji.
- Mutating commands hit the local node with the `<data_dir>/api.token` Bearer (existing `read_api_token`).

## 4. SDK surface

### 4.1 `ce-rs` — `ce_rs::wallet`
Thin additions over the existing `CeClient`. New methods on `CeClient` (or a `Wallet` newtype wrapping it):

```rust
// money
pub struct Balance { pub total: Amount, pub free: Amount,
                     pub locked_channels: Amount, pub locked_bond: Amount, pub bond: Amount }
impl CeClient {
    pub async fn balance(&self) -> Result<Balance>;            // GET /status (breakdown)
    pub async fn transactions(&self, node_id: &str,
        before_height: Option<u64>, limit: u32) -> Result<Vec<TxRecord>>; // GET /transactions/:id
    // transfer(), channel_open/sign_receipt/channel_close/channel_expire/channels()  -> already exist
}
pub struct TxRecord { pub tx_id: String, pub height: u64, pub kind: String,
    pub amount: Amount, pub counterparty: Option<String>,
    pub direction: Direction, pub confirmed: bool }
pub enum Direction { In, Out, SelfTx }

// capabilities (local + revocation)
pub mod cap {
    // re-export ce-cap so apps can decode/inspect without depending on the whole node:
    pub use ce_cap::{SignedCapability, Caveats, Resource, Ability, decode_chain, encode_chain};
    pub struct CapSummary { pub issuer: String, pub audience: String,
        pub abilities: Vec<String>, pub resource: String,
        pub not_after: u64, pub revoked: bool }
}
impl CeClient {
    pub async fn revoke_capability(&self, nonce: u64) -> Result<String>; // POST /capabilities/revoke
    pub async fn revoked(&self) -> Result<Vec<(String,u64)>>;            // already exists
    pub fn summarize_cap(&self, token: &str, revoked: &[(String,u64)]) -> Result<Vec<cap::CapSummary>>;
}
```
SSE live tail: add `pub async fn transactions_stream(&self) -> impl Stream<Item=Result<TxRecord>>` over the existing `/transactions/stream` (already emits `{id,origin,kind,amount}`), enriched client-side with direction relative to `self`.

`ce-rs` must add a dependency on `ce-cap` (it is a tiny, no-libp2p crate) so the SDK can *decode and inspect* capabilities without a node. Issuance still requires the secret key, so signing a new capability stays in the CLI/node (the SDK only inspects + revokes, which is an on-chain tx, not a signature over key material it shouldn't hold).

### 4.2 `@ce-net/sdk` (TS) — `WalletClient`
Follows the researched stack: hand-written types, global `fetch`, `Amount` over `bigint`, SSE as `AsyncIterable`, typed error hierarchy (incl. `CeInsufficientFundsError` for 402 on transfer/channel-open), auto `Idempotency-Key` on `/transfer`.

```ts
class Amount { /* bigint base units; fromBaseUnits/fromCredits/toBaseUnits/toCredits/add/sub/cmp */ }

interface Balance { total: Amount; free: Amount; lockedChannels: Amount; lockedBond: Amount; bond: Amount }
interface TxRecord { txId: string; height: number; kind: string;
  amount: Amount; counterparty?: string; direction: "in"|"out"|"self"; confirmed: boolean }
interface CapSummary { issuer: string; audience: string; abilities: string[];
  resource: string; notAfter: number; revoked: boolean }

class WalletClient {
  balance(): Promise<Balance>;                                   // GET /status
  transactions(opts?: {nodeId?: string; beforeHeight?: number; limit?: number}): Promise<TxRecord[]>;
  transfer(to: string, amount: Amount): Promise<{txId: string}>; // POST /transfer (Idempotency-Key)
  channels(): Promise<Channel[]>;
  openChannel(host: string, capacity: Amount, expiryHeight?: number): Promise<{channelId: string}>;
  signReceipt(channelId: string, host: string, cumulative: Amount): Promise<Receipt>;
  closeChannel(channelId: string, cumulative: Amount, payerSig: string): Promise<void>;
  expireChannel(channelId: string): Promise<void>;
  revoked(): Promise<Array<[string, number]>>;                   // GET /capabilities/revoked
  revokeCapability(nonce: number): Promise<{txId: string}>;      // POST /capabilities/revoke
  summarizeCap(token: string): Promise<CapSummary[]>;            // decode chain (pure TS) + check revoked
  streamTransactions(signal?: AbortSignal): AsyncIterable<TxRecord>; // SSE /transactions/stream
}
```
The TS SDK ships a pure-TS `decodeCapChain(token)` (base64 → CBOR/bincode-compatible decoder matching `ce-cap`'s `encode_chain`) so the dashboard can *inspect* held tokens offline. It does **not** sign capabilities (no secret key in the browser). Validate SSE events with Zod-v4-mini at the trust boundary.

## 5. Dashboard wallet panel (`web/`)

A `Wallet` route with two tabs, mapping 1:1 to the credit/capability split:

**Credits tab**
- Header card: **Total** big, with **Free / Locked (channels) / Locked (bond) / Bond** breakdown chips. Live-updates from `/transactions/stream` (recompute on each inbound tx touching self) and a periodic `balance()` poll for authoritative truth.
- **History table**: paginated `transactions()`, columns `time(height) · kind · direction(↑/↓ as text in/out) · amount · counterparty(name via /names resolve, else short id) · status(confirmed)`. Filter chips per kind. "Load older" → `beforeHeight` cursor.
- **Send** modal: recipient (node id or resolved name), amount (with credits↔base toggle, never float), confirm with the locked/free check, optimistic row inserted as `pending` until it appears confirmed in the stream.
- **Channels** sub-section: list open channels (`channels()`), open/close/expire actions, per-channel locked capacity.

**Capabilities tab**
- **Held** list: tokens from the local wallet (the dashboard reads the node's `wallet.toml` via a small read-only `GET /wallet/caps` helper — *optional* node addition; otherwise paste-to-inspect). Each row decoded by `summarizeCap`: audience=you, issuer, abilities, resource, expiry countdown, and a red **REVOKED** badge if `(issuer,nonce)` is in `revoked()`.
- **Issued** list: capabilities you minted (tracked locally by nonce in `wallet-meta.toml`), each with a **Revoke** button → `revokeCapability(nonce)` → row flips to "revoking (tx pending)".
- **Inspect** box: paste any token → decoded summary (great for support/debugging a chain).
- Clear copy at the top of the tab: *"Capabilities grant the right to act on a resource. They are not money. Revoking one is an on-chain action that kills it and everything delegated from it."*

**Key custody banner** (global, top of Wallet route): if the node reports `key_backed_up: false` (or no local ack), a persistent amber banner: *"Back up your identity key — losing it loses your funds."* with a copy-the-command affordance (`ce key backup`) — the browser never touches key material.

Per `frontend-design`: distinct, not templated — monospace numerics for amounts, the credit/capability split reinforced by color/iconography, generous whitespace, no emoji.

## 6. Data model

- **Money (chain, existing):** `balances: HashMap<NodeId,i128>`, channel locks via `locked_balance`, `bonds: HashMap<NodeId,(amount,unbonding_at?)>`, `NodeStats` (aggregate earned/spent), `tx_index`. No additions.
- **Wire (new/extended):**
  - `StatusResponse += { free, locked_channels, locked_bond, bond }` (base-unit strings).
  - `TxRecord` (the `/transactions/:id` item, §2.2).
- **Local client state (new files, never networked):**
  - `<data_dir>/wallet-meta.toml`: `{ backed_up: bool, issued_caps: [{nonce, audience, abilities, resource, issued_at}] }` — a local ledger of what *I* issued (the chain only stores revocations, not issuances, so the issuer must remember its own nonces to revoke them later). This is the one genuinely new persistent structure and it is purely local convenience.
  - `<data_dir>/wallet.toml`: held capabilities (already exists).
- **Key backup format:** 24-word BIP39 mnemonic encodes the 32-byte ed25519 seed (`Identity::secret_bytes()`), 256-bit entropy → 24 words. Optional encrypted keystore JSON: `{ version:1, kdf:"argon2id", kdf_params, cipher:"xchacha20poly1305", nonce, ciphertext, node_id }`. The `node_id` is stored in clear for verification; it's public.

## 7. Milestones

See structured `milestones`. Summary order: node read-surfaces first (unblocks everything), then key custody (highest user value), then CLI reorg, then SDKs, then dashboard.

## 8. Testing strategy

- **Node (`ce-chain`/`ce-node`):** unit test `/transactions/:id` against a synthetic chain with `difficulty=1` covering every `TxKind`, asserting `direction`/`counterparty`/`amount` per the queried node; test pagination cursor and light-node truncation. Test `/status` breakdown invariant: `free + locked_channels + locked_bond == total` always.
- **Key custody:** round-trip property test — generate seed → mnemonic → import → identical `node_id`; same for encrypted keystore across passphrases; assert `import` refuses to clobber without `--force`; assert mnemonic/keystore never appear in logs (grep test on `tracing` capture). Cross-check a known seed against a reference BIP39 vector.
- **`ce-rs`:** mock the HTTP boundary; assert `Amount` survives values > 2^53 (already covered by amount tests, extend to `Balance`); decode a real `encode_chain` token via `ce-cap` and assert `CapSummary`.
- **`@ce-net/sdk`:** Vitest with injected `fetch`; `Amount` precision tests > 2^53; SSE parser tested against chunk-split streams; `decodeCapChain` tested against fixtures emitted by the Rust `encode_chain` (golden files checked into the repo). Cross-runtime CI (Node/Bun/Deno) per the SDK research; `publint`+`attw` gate.
- **CLI:** integration test `ce wallet balance`/`history`/`send`/`cap show`/`cap revoke` against a local in-memory node (the existing test harness with `NEXT_PORT`); snapshot the human output (aligned columns, no emoji).
- **Dashboard:** component tests for the history table + send modal money math; e2e smoke that the backup banner appears when `backed_up=false`.
- **E2E:** extend an `e2e-*.sh` to: start node, fund, transfer, open+close a channel, then `ce wallet history` shows all of it; `ce key export --mnemonic` → wipe data dir → `ce key import` → balance restored (proves recovery end-to-end on the live chain).

## 9. Risks

See structured `risks`. The load-bearing ones: making the recovery flow safe without footguns (clobbering keys, leaking mnemonics, the bonded-key equivocation hazard when the same identity runs on two machines), and not letting an HTTP-reachable key-export endpoint sneak in.

## 10. Open questions

See structured `openQuestions`.


## Milestones

| Milestone | Deliverable | Effort |
|---|---|---|
| Node read-surfaces | GET /transactions/:node_id (paginated, per-kind, direction-aware) + /status balance breakdown (free/locked_channels/locked_bond/bond). Wire types + unit tests over difficulty=1 chain. Documented light-node truncation. | M |
| Key custody & recovery | ce key export/import/backup/fingerprint: BIP39 24-word mnemonic + optional argon2id+XChaCha20 keystore over Identity::secret_bytes(); no-clobber guard; never-logged guarantee; first-run backup nag + wallet-meta.toml ack. Round-trip + reference-vector tests. | L |
| CLI wallet reorg | ce wallet {balance,history,send,receive,channel,bond,grant,cap add/ls/show/rm/revoke} subtree; old top-level commands kept as aliases; human output per docs/design.md; --watch history via SSE. | M |
| ce-rs wallet module | CeClient::balance/transactions/transactions_stream/revoke_capability/summarize_cap; Balance/TxRecord/Direction/CapSummary types; ce-cap dep for offline cap inspection; mock-boundary tests. | M |
| @ce-net/sdk (TS) WalletClient | New package: Amount(bigint), WalletClient (balance/transactions/transfer/channels/revoke/summarizeCap/streamTransactions), pure-TS decodeCapChain with golden fixtures, typed errors, SSE AsyncIterable, dual ESM/CJS, publint+attw, cross-runtime CI. | L |
| Dashboard wallet panel | Wallet route: Credits tab (balance breakdown card, live history table, send modal, channels) + Capabilities tab (held/issued/inspect, revoke) + global key-backup banner. Component + e2e tests. | L |
| Docs + onboarding | ce/docs/wallet.md (this doc as canonical spec), README quickstart with the backup step, capabilities.md cross-link, multi-machine identity guidance (distinct identity + cap link recommended; bonded-key sharing warning). | S |


## Risks

- Key-export footguns: a mnemonic printed to a shared terminal/scrollback, or an unencrypted keystore on disk, defeats the purpose. Mitigate: TTY-only mnemonic with scary banner, encrypted keystore default, never write to file without explicit flag, never log key material (grep test).
- Pressure to add an HTTP /key/export endpoint for the dashboard. This must be refused: it turns a same-host file-permission problem into a network-reachable exfiltration of identity (anyone with api.token). Keep export a deliberate, interactive CLI-only action; the browser only shows the `ce key backup` command.
- Multi-machine identity + bonding hazard: running the SAME bonded identity on two machines risks double-signing a (domain,epoch) slot -> SlashEquivocation burns 100% of bond. Must loudly warn; recommend distinct identities linked by a capability instead of copying node.key onto a second mining node.
- No-clobber correctness: `ce key import` overwriting an existing funded node.key without --force would destroy the running identity. Guard hard; show the existing node_id and require confirmation.
- /transactions/:id on light nodes returns only post-checkpoint history, so a user querying their own node may see an incomplete ledger and think funds vanished. Must label results 'partial (light node — query an archive node for full history)' in CLI/SDK/UI.
- Issued-capability tracking is local-only (chain stores revocations, not issuances). If wallet-meta.toml is lost, the user can't easily enumerate nonces to revoke. Mitigate: nonce = issuance-time unix secs is recoverable if the user remembers when/whom they granted; document, and consider a `ce wallet cap revoke --issuer self --nonce` manual path.
- BIP39 over an ed25519 seed is non-standard vs HD wallets users may expect; cross-tool import won't work. Acceptable (CE seed != BIP32 derivation), but document clearly that the mnemonic is CE-specific and only re-imports into `ce`.
- Balance breakdown invariant (free+locked==total) can drift during sync when balances go negative; the /status handler must clamp/label 'syncing' rather than show a confusing negative free balance.

## Open questions

- Should `ce-rs` (and the TS SDK) gain a true capability-ISSUANCE method, or stay inspect+revoke only? Issuance needs the secret key; doing it in-SDK means the SDK touches node.key. Leaning: keep issuance in the CLI/node only; SDK inspects + revokes.
- Do we add a read-only GET /wallet/caps so the dashboard can list held capabilities, or keep the dashboard paste-to-inspect (no node change)? The former is convenient but exposes the local cap wallet over HTTP (behind api.token) — acceptable since caps aren't secret, but it's a new endpoint.
- Mnemonic standard: stick with BIP39 24-word (familiar wordlist, but implies HD semantics CE doesn't have) or use a CE-specific wordlist to avoid the false expectation of cross-wallet compatibility?
- Should `backed_up` acknowledgment surface in /status (so the dashboard banner is server-driven) or stay purely a CLI-local concept in wallet-meta.toml? Server-driven is nicer UX but adds a field whose source of truth is a local file.
- Bond UX: `ce wallet bond/unbond` implies HostBond/HostUnbond txs, but those aren't in the documented HTTP API table (only the TxKinds exist). Do we add POST /bond + POST /unbond endpoints in this workstream, or defer bonding UX to a consensus/staking workstream and have the wallet only *display* bond from /status?
- Transaction history pagination: is walking blocks acceptable on archive nodes, or do we need a per-node tx index (node_id -> [tx_id]) added to ce-chain to make /transactions/:id O(k)? For large chains the walk could be slow; decide whether to build the index now.
