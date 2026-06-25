# ce-secrets-auth — Implementation Plan (for approval)

Status: PROPOSED — owner approval required before any code is written.
Date: 2026-06-24. Author context: Leif Rydenfalk (sole dev).
Grounded strictly in the ce-secrets crypto/storage audit + the SDK-design / auth-angle research.

---

## 1. Goal

Upgrade `ce-net/ce-secrets` from a **secrets vault** (key delivery) into a reusable
**AUTH system**: any app authenticates its operator by proving possession of an
enrolled ce-secrets **device key**, with **no pasted bearer tokens**. Today the
vault's ECDSA P-256 device keypair already exists in every device — but there is
**no `signChallenge` / `verifyAuth` / `login` verb**. We add that thin
challenge-response layer and ship first-class **Rust** (`ce-secrets-rs`) and
**TypeScript** (`@ce-net/secrets`) SDKs that interop **byte-for-byte** with the
existing `.mjs` core and with each other.

What this replaces, concretely:
- ce-watch's `CE_WATCH_ADMIN_TOKEN` shared bearer (`x-ce-admin` header,
  `src/main.rs:104-113,162`) — no identity, no revocation, no attribution.
- ce-cast's static HTTP-Basic publish key (same class of problem).

What we explicitly do NOT do:
- We do NOT reuse the ECDSA P-256 device key as the hub's Ed25519 `signed_owner`
  signer — different curves, not interchangeable. They are bridged deliberately,
  not merged (see §2).
- We do NOT rewrite the `.mjs` crypto in noble-curves. WebCrypto `subtle` is
  already byte-correct and isomorphic; rewriting re-introduces interop risk.

---

## 2. Auth primitive — challenge-response over the enrolled device key

**Design: challenge-response, NOT shared-secret-from-vault.** Delivering a secret
from the vault and presenting it as a bearer reproduces the exact failure we are
removing (leaks if any one device leaks, no per-device revocation/attribution).
Instead the device signs a fresh server nonce with its **ECDSA P-256 device key**,
and the relying party checks that the signer is an **enrolled device** (`d.<id>`
record) in the vault. "Enrolled in vault X" == "is the operator of X."

### Wire format (flat body — critical)

The signed body MUST be **flat** so the partial canonicalization
(`stableStringify` = `JSON.stringify(obj, Object.keys(obj).sort())`, top-level keys
only, nested untouched, no whitespace) is unambiguous:

```
body = { aud: "<app/audience id>",
         deviceId: "<16-hex device id>",
         nonce: "<base64url, >=16 random bytes>",
         ts: "<ISO 8601 string>" }            // 4 flat keys, all strings
```

- Signature: ECDSA P-256 / SHA-256 (ES256) over `UTF8(stableStringify(body))`,
  raw IEEE-P1363 `r||s` (64 bytes), `base64url` no-pad. NOT DER.
- Proof submitted to the RP:
  `AuthProof = { deviceId, ecdsaPub: <JWK>, body: <canonical string>, sig: <b64url> }`.
  Sending `body` as the exact pre-serialized canonical string removes any
  re-canonicalization ambiguity at verify time.

### Verify (`verifyAuth`)

1. `verifyRecord(proof.ecdsaPub, proof.body, proof.sig)` — ECDSA/SHA-256 over the
   canonical bytes.
2. Parse body; check `body.aud === aud`, `body.nonce === issuedNonce`,
   `ts` within skew (±300s, matching the hub's `SIG_TTL_SECS`).
3. Fetch `d.<body.deviceId>` from `/db/vault-<prefix>/d.<deviceId>`; assert the
   record's `ecdsaPub` **equals** `proof.ecdsaPub` (canonical-JSON equality, as the
   `.mjs` grant verifier already does: `JSON.stringify(a)===JSON.stringify(b)`).
4. Assert `deviceId == sha256(JSON([ecdhPub.x,ecdhPub.y,ecdsaPub.x,ecdsaPub.y]))[..16hex]`
   (binds the presented pubkey to the id; crypto.mjs:49).
5. Optional: assert `d.<id>` still present (revocation = delete the record).
   ⇒ `{ ownerOk: true, deviceId, label }`.

### Nonce / replay model — mirror the hub

The RP issues a fresh random nonce (>=32 bytes) with a short TTL and a single-use
nonce cache — exactly the discipline in ce-hub `verify_signed`
(ts within `SIG_TTL_SECS=300`, single-use nonce cache, `main.rs:1926-1937`) and
`verify_node_hello` (raw 32-byte server nonce). For **stateless** RPs, the nonce
MAY be `HMAC(server_secret, ts)` so the server keeps no per-nonce state and just
re-derives + checks TTL.

### Alignment with the hub's `signed_owner` (Ed25519)

The hub's only existing request-auth primitive is Ed25519 `signed_owner`
(`owner = sha256(pubkey)[..16]`, canonical string `METHOD\nPATH\nts\nnonce\nsha256(body)`).
Our device auth is **P-256**, so it is a **parallel** verifier, not a replacement:

- The **app** (ce-watch, ce-cast) verifies device auth directly against the vault's
  `d.*` set — needs zero hub change.
- If we want the **hub itself** to authorize on device identity, ADD an ECDSA-P256
  verification path alongside the Ed25519 one, defining
  `owner = sha256(canonical-device-pubkey)[..16]` so it composes with
  `admin_owners` / `CE_HUB_ADMIN_OWNER` unchanged. (Phase 4, optional — see §6.)

### Revocation

- Per-device: delete `d.<id>` from the vault namespace (verify step 5 fails next time).
- Per-grant (existing): `g.<id>` revocation by deletion + `expires`.
- Time-bound: every proof is nonce-bound + `ts`-bound (single-use, self-expiring).

### Hardening required to make this REAL (gaps found in the audit)

The vault namespace `vault-<prefix>` is **world-writable/world-readable today**
(client never signs vault writes; namespace name ≠ any hosted app id, so the hub's
inherited-owner branch never engages; `db_get`/`db_del` do no auth at all). A
stranger can DELETE/overwrite/inject `d.<id>` / `p.<code>` records (DoS / identity
injection). Before device-auth can be trusted, ONE of:

- (a) **Host a `vault-<prefix>` app** and claim its owner via a signed PUT, so
  `db_put`'s inherited-owner branch (`main.rs:1615-1621`) gates writes; AND close
  the `db_get`/`db_del` no-auth holes (`main.rs:1689,1698`) for owned namespaces.
- (b) **Make `d.*` records self-authenticating server-side**: the hub verifies the
  embedded ECDSA sig on write/delete of `d.<id>` (the records are already
  individually ECDSA-signed for tamper-evidence — nothing verifies them today).

(a) is the smaller hub change and reuses the existing ownership model; (b) is more
general. **This is an owner decision — see Open Questions.** Confidentiality of the
master is NOT at risk either way (ECIES-wrapped), but integrity/availability of the
enrolled-device set is, and that set is the authorization root for this whole scheme.

---

## 3. Rust SDK — `ce-secrets-rs`

Standalone crate (does NOT depend on the `ce` node), mirroring `ce-rs` house style:
`edition = "2024"`, `anyhow::Result` on all fallible fns, a single `Clone` `Vault`
struct, serde wire types with `#[serde(default)]`, `#[cfg(test)] mod tests` with
round-trips. Lives at `~/ce-net/ce-secrets-rs/`.

### Crate mapping (byte-for-byte)

| Primitive | Crate / call |
|---|---|
| ECDH / ECDSA P-256 | `p256` (`p256::ecdh`, `p256::ecdsa::{SigningKey,VerifyingKey,Signature}`) |
| ECDH shared secret | `diffie_hellman().raw_secret_bytes()` = raw 32-byte X-coord (NOT hashed/cofactor) |
| ECDSA sig bytes | `Signature::to_bytes()` → 64-byte P1363 r‖s. **Never `to_der()`** |
| HKDF | `hkdf::Hkdf::<sha2::Sha256>`, **salt = `Some(&[])` (zero-length, not absent)**, `info = b"ce-secrets/master-wrap/v1"`, 32-byte output |
| AES-256-GCM | `aes-gcm::Aes256Gcm`, 12-byte nonce, 16-byte tag appended (crate default), no AAD |
| SHA-256 | `sha2::Sha256` |
| base64url no-pad | `base64::engine::general_purpose::URL_SAFE_NO_PAD` |
| hex | `hex` crate, lowercase |
| RNG | `rand_core::OsRng` |
| JWK | `elliptic-curve` `jwk` feature OR manual `{kty:"EC",crv:"P-256",x,y[,d]}` with base64url-no-pad coords |

### Canonicalization (single biggest interop risk)

Do **not** rely on `serde_json` field order. Implement one controlled
`stable_stringify(obj)` that reproduces `JSON.stringify(o, Object.keys(o).sort())`:
top-level keys sorted ASCII-ascending, values in default JSON order, **no whitespace**,
JS-exact number/string escaping. Because all signed bodies (device record, secret
record, auth body, grant body) are kept flat-at-top-level, this is sufficient — but
it must match the JS byte output exactly (verified against a JS-produced fixture in CI).

### Module / API surface

`pub struct Vault { store, device, namespace }`

- Constructors: `Vault::open()` (node-prefix namespace `vault-<10hex of ~/.ce/id>`,
  device key from macOS Keychain service `ce-secrets-device` or
  `~/.ce/secrets/device.json` 0600), `Vault::open_with(VaultOptions{hub,namespace,store,device})`.
- Lifecycle/devices: `exists`, `enrolled`, `init(label)`, `request_pairing(label)->code`,
  `list_pairing`, `approve(code)->device_id`, `devices()->Vec<DeviceInfo>`, `revoke_device(id)`.
- Secrets: `gen(name,GenOpts)`, `put(name,value,type)`, `rotate(name)`, `list`, `info`,
  `remove`, `get(name)->String`, `get_bytes(name)->Vec<u8>`, `fingerprint`,
  `use_env(names, f)`.
- Grants: `grant(audience,GrantOpts)->GrantToken`, `revoke_grant(id)`, `list_grants`,
  `verify_grant(token,audience,action,name)->GrantVerdict`.
- **NEW auth:**
  - `sign_challenge(&self, aud:&str, nonce:&[u8]) -> AuthProof`
  - free fn `verify_auth(devices:&[DeviceVerifier], aud:&str, nonce:&[u8], proof:&AuthProof) -> AuthVerdict { owner_ok, device_id, label }`
  - `login(&self, rp:&impl RelyingParty) -> Session` (fetch nonce → sign → submit).
- Types: `AuthProof { device_id, ecdsa_pub: Jwk, body: String /*canonical*/, sig: String /*b64url*/ }`.

Vault read = the same `hubStore` HTTP API: `GET/PUT/DELETE <hub>/db/<ns>/<urlenc(key)>`,
`LIST <hub>/db/<ns>?prefix=&limit=1000 -> {items:[{key,value}]}`, `Connection: close`,
values are raw JSON (no base64 wrapper).

---

## 4. TypeScript SDK — `@ce-net/secrets`

KEEP the isomorphic `src/crypto.mjs` + `src/vault.mjs` **as-is** (WebCrypto `subtle`
is byte-correct on Node20+/Deno/Bun/browser/Workers; it natively does ECDH-P256
`deriveBits`, HKDF-SHA256 `deriveKey`, AES-256-GCM, ECDSA-P256 sign/verify,
`importKey('jwk')`). Add a typed facade + the auth verbs to **both** `src/index.mjs`
(Node) and `app/client.js` (browser) — the device ECDSA key is present in both.

- New `VaultAuth` surface (mirrors the Rust API names exactly):
  - `signChallenge(aud: string, nonce: Uint8Array): Promise<AuthProof>` — flat body, `this.device` ECDSA.
  - free/static `verifyAuth(vaultDevices, aud, nonce, proof): Promise<{ownerOk, deviceId, label?}>`.
  - `login(rp: { challenge(): Promise<{nonce}>; submit(proof): Promise<Session> }): Promise<Session>`.
- `interface AuthProof { deviceId: string; ecdsaPub: JsonWebKey; body: string; sig: string }`
  — field names + wire bytes identical to Rust + `.mjs`.
- noble-curves: **optional fallback only** for runtimes lacking `subtle`. Default path
  stays `subtle` to guarantee byte-identical behavior.
- Facade style mirrors `ce-ts`: ESM with explicit `.js` specifiers, web-standard APIs
  only, camelCase TS fields over the wire shapes.

---

## 5. ce-secrets upgrades (the existing `.mjs`)

Minimal, additive, CLI-preserving:

1. `src/crypto.mjs`: add `signChallenge(device, {aud, nonce, ts, deviceId})` and
   `verifyChallengeSig(ecdsaPub, body, sig)` built on the existing `signRecord` /
   `verifyRecord` (no new crypto — same ES256 + stableStringify path). Keep the body flat.
2. `src/vault.mjs`: add `signChallenge(aud, nonce)` (wraps device + deviceId) and
   `verifyAuth(aud, nonce, proof)` (does the `listDevices` → `d.<id>` ecdsaPub-match
   check, reusing `isEnrolled`/`listDevices` at vault.mjs:33,66-68).
3. `src/index.mjs` + `app/client.js`: re-export the two verbs + `login()`. No change
   to `openVault()` / `Vault.open()` shapes.
4. `bin/ce-secrets.mjs`: add `ce-secrets login <aud>` (prints/POSTs a proof) and
   `ce-secrets prove <aud> --nonce <b64url>` (prints an `AuthProof` JSON for scripting).
   Existing subcommands untouched.
5. **No new persisted vault record types** are required for auth (auth is ephemeral,
   uses existing `d.*`). The ONLY new on-hub work is the namespace hardening in §2
   (owner-gate `vault-<prefix>` or server-verify `d.*` sigs) — tracked as its own
   workstream because it touches `ce-hub` Rust, not the SDK.

---

## 6. ce-watch integration (the few lines) + other surfaces

ce-watch today: `x-ce-admin` header compared to `CE_WATCH_ADMIN_TOKEN` env via
`header_matches` (`src/main.rs:104-113`), gating `/admin/flags`, `/admin/unseen`,
`/admin/seen` (`main.rs:162` and siblings). Replacement:

1. Add `ce-secrets-rs` dep. Add two routes: `GET /admin/challenge` → issue a fresh
   nonce (`HMAC(server_secret, ts)` stateless variant, TTL 300s); the existing admin
   routes accept an `AuthProof` (header `x-ce-auth: <base64url(JSON proof)>` or JSON body).
2. Replace the `header_matches(&headers, "x-ce-admin", &st.admin_token)` guard with:
   ```rust
   let proof: AuthProof = parse_x_ce_auth(&headers)?;
   let verdict = ce_secrets::verify_auth(&st.vault_devices, "ce-watch", &nonce, &proof)?;
   if !verdict.owner_ok { return UNAUTHORIZED; }
   ```
   `st.vault_devices` = the `d.*` set fetched from the operator's vault namespace
   (configured via `CE_WATCH_VAULT_NS` or derived), refreshed on a short TTL.
   `CE_WATCH_ADMIN_TOKEN` is **deleted**; logged-deprecation for one release if desired.
3. `src/console.html`: replace the pasted-token gate (`LS_KEY="ce-watch-admin-token"`,
   `x-ce-admin` header) with the `@ce-net/secrets` browser SDK: `Vault.open()` →
   `pair()`/`waitEnrolled()` if needed → `login({challenge, submit})` → attach
   `x-ce-auth` on each admin call. No paste, single-use proof.

Other surfaces to adopt the same primitive (follow-on, not this plan's critical path):
- **ce-cast** operator auth — replace the static HTTP-Basic publish key
  (`web/config.js:25`, `whip.js:63`, `studio.js:191`, `relay/mediamtx.prod.yml:24-25`)
  with device-auth at a thin auth endpoint; the relay still needs a credential, so
  cast either keeps the publish key delivered-by-vault for MediaMTX OR gets a
  device-authed token-mint endpoint. (Decision deferred — separate plan.)
- **ce-hub admin** — optionally add the ECDSA-P256 verify path (§2) so
  `CE_HUB_ADMIN_OWNER` can be a device owner id.

---

## 7. Phased PARALLEL execution plan

Five mostly-independent workstreams. The **shared test-vector fixture (W0)** is the
contract that lets the rest run in parallel without drift.

### W0 — Golden cross-language fixtures (DO FIRST, unblocks all)
Produce a fixed JSON fixture from the existing `.mjs`: a fixed device JWK pair, a
fixed 32-byte master, a fixed secret, a fixed auth body. Record expected:
`deviceId`, `wrapMaster` output (`{eph,iv,ct}`), `sealSecret` output, `signRecord`
sig bytes, and an auth proof. CI in Rust **and** TS must reproduce/verify each.
- **Acceptance:** the `.mjs` `verifyRecord` verifies the Rust-produced sig and the
  TS-produced sig; Rust/TS reproduce `deviceId` and the `sealSecret`→`openSecret`
  and `wrapMaster`→`unwrapMaster` round-trips bit-identically. The five traps locked:
  (a) HKDF salt EMPTY-not-absent, (b) info `'ce-secrets/master-wrap/v1'`,
  (c) GCM 96-bit nonce + appended 16-byte tag, (d) ECDSA raw P1363 64-byte b64url
  (never DER), (e) flat top-level-sorted-key canonicalization.

### W1 — crypto-interop core (Rust + TS), parallel after W0
Rust `ce-secrets-rs::crypto` (p256/hkdf/aes-gcm/sha2/base64url) + the controlled
`stable_stringify`. TS: confirm `crypto.mjs` already passes W0 (it is the reference);
add typed wrappers.
- **Acceptance:** all W0 vectors green in both languages, in CI, both directions.

### W2 — Rust SDK `ce-secrets-rs` (Vault + auth), after W1
Full `Vault` surface (§3) over `hubStore` HTTP + `sign_challenge`/`verify_auth`/`login`.
- **Acceptance:** a Rust client enrolls (via an already-enrolled JS device approving),
  `get()`s a secret, and produces an `AuthProof` that the `.mjs` `verifyAuth` accepts;
  a JS-produced proof verifies in Rust `verify_auth`.

### W3 — TS SDK `@ce-net/secrets` (facade + auth verbs), after W1
Add `VaultAuth` to `index.mjs` + `app/client.js`; typed facade; CLI `login`/`prove`.
- **Acceptance:** browser `login()` round-trip; CLI `ce-secrets prove ce-watch` emits
  a proof Rust `verify_auth` accepts; existing CLI subcommands unchanged (selftest green).

### W4 — ce-secrets `.mjs` auth ops + hub namespace hardening, parallel
(4a) `.mjs` verbs (§5.1-5.4) — small, can land with W3.
(4b) **ce-hub** namespace hardening (§2 (a) or (b)) — independent Rust change in
`web/ce-hub/src/main.rs`; gate writes/deletes/reads on owned `vault-<prefix>`.
- **Acceptance (4a):** auth verbs exported, selftest green.
- **Acceptance (4b):** an unsigned/foreign write or delete to `d.<id>` in an owned
  `vault-<prefix>` namespace is rejected; owner-signed succeeds; `db_get`/`db_del`
  holes closed for owned namespaces.

### W5 — ce-watch integration, after W2 + W4
Swap the `CE_WATCH_ADMIN_TOKEN` guard for `verify_auth` (§6.1-6.3); console uses the TS SDK.
- **Acceptance:** an enrolled operator opens `/admin` with no pasted token and views
  flags; a non-enrolled device is rejected 401; revoking the device (delete `d.<id>`)
  locks it out within the TTL. `CE_WATCH_ADMIN_TOKEN` removed from the codebase.

Critical path: **W0 → W1 → W2 → W5** (with W4b gating trust of W5). W3/W4a run alongside.

---

## 8. Open questions (owner decisions)

1. **Namespace hardening choice (§2):** (a) host a `vault-<prefix>` hub app + claim
   owner via signed PUT and close `db_get`/`db_del` holes, OR (b) make the hub verify
   embedded `d.*` ECDSA sigs server-side on write/delete? (a) is the smaller change and
   reuses existing ownership; (b) is more general but touches the hub's KV core more deeply.

2. **Hub-level device auth (§2/§6):** do we add the ECDSA-P256 verifier alongside
   Ed25519 `signed_owner` now (so `CE_HUB_ADMIN_OWNER` can be a device owner), or keep
   device-auth purely app-side for v1 and leave the hub on Ed25519?

3. **Stateless vs stateful nonce:** accept the stateless `HMAC(server_secret, ts)`
   challenge (zero server storage) as the default, or require a stored single-use nonce
   cache per RP (stricter replay guarantees, more state)?

4. **ce-cast scope:** include ce-cast's operator-auth migration in THIS plan, or split
   it into a follow-on (since MediaMTX still needs a delivered credential and that's a
   distinct shape)?
