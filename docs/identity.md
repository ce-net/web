# Identity

CE's identity model has exactly one rule: **one person, one id, reused everywhere.** ce-app never
mints a second id and never asks you to log in. The first time you deploy, an identity already exists
or is created once, and every machine and every app you touch resolves to that same id. It is
invisible by design — you never see a signup, a token paste, or an account screen.

## The one-identity model

An identity is an Ed25519 keypair. The public key (and a hash of it) is your **id**; the secret key
signs your writes. ce-app resolves the single identity in a fixed order and stops at the first hit:

1. **The CE node identity.** If the `ce` CLI is installed, `ce id` prints your node id. The matching
   secret key lives in the CE data directory, which is **platform-specific**: macOS
   `~/Library/Application Support/ce/identity/node.key`, Linux `~/.local/share/ce/identity/node.key`,
   Windows `%APPDATA%\ce\identity\node.key` (and `CE_DATA_DIR` overrides all of these). `ce-app`,
   `slug.mjs`, and `registry.mjs` probe these candidates in order and use the first that exists. The
   pubkey **is** the node id, so this is the canonical "1 person = 1 id": your app identity *is* your
   node identity.
2. **One local app keypair.** With no CE node present, ce-app uses a single Ed25519 keypair at
   `~/.ce/identity/node.key`, created once on first use and reused forever. Its id is
   `sha256(pubkey)` in hex, so it is shaped exactly like a node id and is stable across runs.

ce-app **never regenerates** and **never mints a second** id. The first existing source wins. If a CE
node id is present but its secret key is not reachable, the id still resolves (so app ids and URLs are
stable) and signing is simply disabled until the key is available — anonymous writes keep working.

Run `ce-app whoami` to print your id, the derived `nodeprefix` (the first 10 hex chars, used in app
ids), and where the id came from.

```
$ ce-app whoami
id:         c0be11e0ce0aaa769da6f9970244947d3d32a0c0d8302fb5f41f73d7950be456
nodeprefix: c0be11e0ce
source:     ce id (CE node) — secret key at ~/.local/share/ce/identity/node.key
```

## Reuse and migration

Older ce-app builds wrote a random id to `~/.ce/id`, and each project pinned a derived app id to
`./.ce/app-id`. Both still work, but they **migrate** to the single identity above — `~/.ce/id`
converges to the one id so the source of truth is unified, while a project-local `./.ce/app-id` pin
still wins for that checkout (so existing deploys keep their URL). Nothing you have already shipped
breaks; the id source of truth simply collapses to one.

Your app id is derived, not random: `"<project>-<nodeprefix>"`, where `<project>` comes from
`--project`, then `ce-app.json`, then `package.json` name, then the directory name. The same project
on the same identity always resolves to the same app id and the same URLs:

```
https://<project>-<nodeprefix>.ce-net.com/
https://ce-net.com/apps/<project>-<nodeprefix>/
```

## The signing scheme

Every mutating request ce-app makes is signed with the identity's secret key. This is invisible — you
do nothing — and the hub now **verifies** it: a valid signature attributes the write to your owner
id (`sha256(pubkey)[..16]`) and grants identity-scoped quotas (see [limits](limits.md)); a request
with no signature stays anonymous on the conservative caps; a request with a bad signature is
rejected `401`. Slug and project writes **require** a valid signature. The scheme:

Headers on every `PUT` / `POST` / `DELETE` / `PATCH`:

| Header | Value |
| --- | --- |
| `x-ce-id` | the signer's Ed25519 public key, hex |
| `x-ce-sig` | the Ed25519 signature over the canonical string, hex |
| `x-ce-ts` | request timestamp, unix milliseconds (replay window) |
| `x-ce-nonce` | per-request random nonce, hex (replay defense) |

The canonical string is the four request facts plus a body digest, newline-joined in this exact
order:

```
METHOD "\n" PATH "\n" ts "\n" nonce "\n" sha256(body)-hex
```

- `METHOD` is uppercase (`PUT`, `POST`, …).
- `PATH` is the request path **and** query exactly as sent, with no host —
  e.g. `/apps/chat-c0be11e0ce/index.html`.
- the body digest is `sha256` of the raw request bytes, hex; an empty body uses `sha256("")`.

A verifier recomputes the canonical string from the request it received, checks `x-ce-sig` against
`x-ce-id` with Ed25519, rejects a stale `x-ce-ts` (outside the replay window) or a reused
`(id, nonce)` pair, and otherwise treats the request as authored by `x-ce-id`. Because the body
digest is in the signed string, a tampered body invalidates the signature.

When no secret key is available, ce-app sends the request **without** these headers (a valid
anonymous request, accepted on the anonymous caps) rather than sending a broken signature. Signing
is all-or-nothing per request. The owner-scoped registries — slugs and projects — reject an
unsigned write (`401 signature required`), so those need a usable secret key.

`x-ce-ts` is a unix timestamp the hub checks against a tolerance window; `ce-app` sends
milliseconds, while `slug.mjs` / `registry.mjs` send **seconds** to match the hub's seconds-based
window. Either way the timestamp and the per-request `x-ce-nonce` are folded into the signed
canonical string, so a stale or replayed request is rejected.

## Device linking

Multiple devices converge on the **same** id — they do not each mint their own. The mechanism is
CE's universal authorization primitive: a signed, attenuating **capability** (see
`ce/docs/capabilities.md`), the same primitive behind `ce grant`. `ce-app link` documents and stubs
the flow:

1. On a device that already holds the identity, `ce-app link` prints a pairing token (id + pubkey +
   hub + a one-time nonce), shown as text or a QR.
2. On the new device, `ce-app link <token>` generates an ephemeral keypair, signs the nonce (proof of
   possession), and asks the first device to issue a capability over a relay rendezvous.
3. The first device verifies the proof and self-issues a signed, attenuating capability (ability
   `app:write`, scoped and expiring) rooted at the identity's key. The new device stores it and now
   writes as the **same** identity: `x-ce-id` stays constant, and the device presents its capability
   chain alongside its own per-request signature.

The QR/relay transport and capability issuance land in a later wave; `ce-app link` prints the flow
and a valid pairing token today so tooling can build on the canonical shape. No step ever creates a
second id.

## Where keys live

| Path | What |
| --- | --- |
| `~/Library/Application Support/ce/identity/node.key` (macOS) | CE node secret key. Back this up. |
| `~/.local/share/ce/identity/node.key` (Linux) | CE node secret key. Back this up. |
| `%APPDATA%\ce\identity\node.key` (Windows) | CE node secret key. Back this up. |
| `$CE_DATA_DIR/identity/node.key` | overrides the per-platform default above. |
| `~/.ce/identity/node.key` | the single local app keypair, created once when no CE node is present. |
| `~/.ce/id` | cached id string; migrates to the one id. Not the source of truth. |
| `./.ce/app-id` | optional per-project app-id pin; wins for that checkout. |

Losing the secret key means losing the ability to **sign** as that id (future writes go anonymous or
need re-pairing); it does not change the id itself, which is derived from the public key. Treat the
key files as you would an SSH key.
