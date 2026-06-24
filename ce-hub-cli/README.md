# ce-hub

A thin CLI for **hub.ce-net.com** — GitHub for ce-net. It wraps the system `git` binary and the
hub HTTP API (`web/ce-hub`), authenticating every mutating request with your **one CE identity**
using the same signed-header scheme as `web/ce-app/bin/slug.mjs`.

No separate account, no password. Your CE node key (`~/.local/share/ce/identity/node.key`) is the
only credential. Everything on the hub is public and open source.

## Install

```bash
cargo build --release          # build happens on the relay; the laptop disk is tight
# binary at target/release/ce-hub
```

Requires the system `git` binary on `PATH` and a CE identity key. The key is read from (first hit):

1. `$CE_DATA_DIR/identity/node.key`
2. `~/Library/Application Support/ce/identity/node.key` (macOS)
3. `~/.local/share/ce/identity/node.key` (Linux)

The key may be a raw 32-byte Ed25519 seed, PKCS8 DER, or PKCS8 PEM — all are accepted.

## Hub base URL

Default `https://hub.ce-net.com`. Override per-invocation with `--hub <url>` or globally with the
`CE_HUB` environment variable.

## Commands

| Command | What it does |
|---|---|
| `ce-hub create <owner>/<repo> [--desc D]` | `POST /repos` (signed) — create a repo. `<owner>` must be a slug you hold. |
| `ce-hub clone <owner>/<repo> [dir]` | `git clone` the hub repo URL. |
| `ce-hub push [-- <git push args>]` | `git push` using a credential helper that mints a short-lived signed token. |
| `ce-hub credential <get\|store\|erase>` | git credential-helper protocol (so plain `git push` works after config). |
| `ce-hub pr open <owner>/<repo> --head H --base B --title T [--body D]` | `POST .../pulls` (signed). |
| `ce-hub pr ls <owner>/<repo>` | list pull requests. |
| `ce-hub pr merge <owner>/<repo> <n>` | merge PR #n (signed). |
| `ce-hub release <tag> [--message M]` | annotated `git tag` + push the tag to `origin`. |
| `ce-hub instances <owner>/<repo>` | `GET .../instances` — live instances table. |
| `ce-hub mirror <owner>/<repo> --upstream URL --dir <in\|out\|both>` | `POST .../mirror` (signed). |

## Pushing

Two ways to push:

**A. `ce-hub push`** — easiest. It injects a credential helper for the hub host for that one push, so
the signed token is minted on demand:

```bash
ce-hub push -- -u origin main
```

**B. Configure git once**, then use plain `git push`:

```bash
git config --global \
  'credential.https://hub.ce-net.com.helper' \
  '!ce-hub --hub https://hub.ce-net.com credential'
git push        # ce-hub mints username=<owner-id>, password=<signed token>
```

The token is repo-scoped, expires in 5 minutes, and is signed over
`git-push\n<owner>/<repo>\n<ts>\n<exp>\n<nonce>`. The hub verifies the signature (and that the
signer owns the `<owner>` namespace or is the repo creator/admin) before invoking
`git-receive-pack`. Clone/fetch of public repos is anonymous.

## Signing scheme (must match the hub)

Mutating JSON requests carry:

- `x-ce-id` — your raw Ed25519 public key, hex
- `x-ce-sig` — Ed25519 signature, hex, over the canonical string
- `x-ce-ts` — UNIX **seconds** (300s window)
- `x-ce-nonce` — random hex (single-use)

Canonical string: `METHOD "\n" PATH "\n" ts "\n" nonce "\n" sha256(body)-hex`, where `PATH` is the
bare request path (no scheme/host) and `body` is the raw request bytes. The hub derives your owner
id as `sha256(pubkey)[..16]` hex.

## Notes

- Open source only — there are no private repos.
- Repo and owner names are validated strictly (lowercase `a-z0-9` and hyphen, 1–64 chars).
- `ce-hub release` pushes the tag to the remote named `origin`; clone with `ce-hub clone` to get the
  hub set as `origin` automatically.
