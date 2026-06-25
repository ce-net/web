# ce-cache — distributed content-addressed CI/build cache over CE

A Bazel / sccache / Turborepo-style **remote build cache** backed by the CE content-addressed blob
layer. Every machine's build warms the whole fleet's cache; no S3 egress; capability-gated; optional
cross-org sharing. Because content-addressing is literally how these caches key their entries, the
impedance match is exact and **cache poisoning is structurally impossible** — an object fetched for a
key is re-verified against its CID, and a host returning bytes whose hash != the requested CID is
rejected, not trusted.

ce-cache is an **application built on CE primitives** (SDK tier, like `swarm` / `rdev` / `ce-pin`),
not a node feature. It talks to a local CE node via `ce-rs` and to peers over the mesh
(`request`/`reply`, `advertise_service`/`find_service`); authorization is the one CE primitive —
every host action verifies a signed, attenuating `ce-cap` chain. **No node changes required.**

## CLI

```
ce-cache put <key> <path>     # archive a file/dir, store as a CE object, map key -> CID
ce-cache get <key> <dest>     # resolve key -> CID (local then mesh), fetch + CID-verify, restore
ce-cache has <key>            # cache hit? exit 0 = hit, 1 = miss (scriptable)
ce-cache ls                   # list local cache entries
ce-cache rm <key>             # forget a key locally
ce-cache stats                # entry count + footprint
ce-cache sidecar [--addr ...] # localhost HTTP shim for Bazel + sccache (see below)
ce-cache serve                # run as a cache host: serve hits to authorized peers
```

A single file is stored verbatim; a **directory** is archived to one deterministic tar (sorted
entries, zeroed mtime/uid/gid) so a whole build-output dir becomes a single CID and the same tree
yields the same CID on every machine (determinism is load-bearing for hit-rate).

## Drop-in shim for existing build tools (`ce-cache sidecar`)

The sidecar is a localhost HTTP server that speaks two existing remote-cache wire protocols and maps
every entry onto CE blobs, so the build tool needs **zero CE awareness**.

### Bazel Remote Cache HTTP

```
build --remote_cache=http://127.0.0.1:9092
```

| Build-tool request   | Meaning                       | ce-cache action                                  |
|----------------------|-------------------------------|--------------------------------------------------|
| `PUT /cas/<hash>`    | store CAS blob (build output) | key `cas/<hash>` -> `put_object(body)` -> CID    |
| `GET /cas/<hash>`    | fetch CAS blob                | resolve `cas/<hash>` -> `get_object(cid)` (verified) |
| `PUT /ac/<hash>`     | store Action Cache entry      | key `ac/<hash>` -> `put_object(body)` -> CID     |
| `GET /ac/<hash>`     | fetch Action Cache entry      | resolve `ac/<hash>` -> `get_object(cid)`         |

### sccache (WebDAV)

```
SCCACHE_WEBDAV_ENDPOINT=http://127.0.0.1:9092/dav sccache <compiler> ...
```

`GET`/`PUT` on an arbitrary path P map to key `dav/<P>` over the same `put_object`/`get_object` path.

### Protocol → CE mapping (the core)

For every protocol the request's `<hash>` / path **is the cache key** — the build tool already
content-hashed its inputs; ce-cache does not recompute. On `PUT`, the body is `put_object`'d to a CE
object CID and `key -> CID` is recorded in the index (and announced on the DHT). On `GET`, the key is
resolved to a CID (local index first, then the mesh via `cache/get`) and `get_object` fetches the
bytes — re-verifying every chunk against its CID, so a peer cannot return poisoned bytes. The Bazel
CAS, Bazel AC, and WebDAV key spaces are namespaced (`cas/`, `ac/`, `dav/`) so they never collide in
the shared index.

## Mesh protocol (`cache/*`, capability-gated)

| Topic        | Ability        | Request → Reply                                                        |
|--------------|----------------|-----------------------------------------------------------------------|
| `cache/has`  | `cache:read`   | `{caps,key}` → `{hit, cid?, size}`                                     |
| `cache/get`  | `cache:read`   | `{caps,key}` → `{cid?, size, reason?}` (reader fetches + CID-verifies) |
| `cache/put`  | `cache:write`  | `{caps,key,cid,size,rent?}` → `{accepted, stored_bytes, reason?}`      |

A host honors a signed, attenuating `ce-cap` chain rooted at its own key or a configured org root
(`$CE_CACHE_ROOTS`, else `$CE_DATA_DIR/roots`, else `~/.local/share/ce/roots`). Org root issues
`cache:read` + `cache:write` to fleet members; outsiders get `cache:read` only. Revocation is the
on-chain revoked set, polled by `serve`.

## Money

Rent (optional; MVP runs free within a cap-gated fleet) is carried as **base-unit decimal strings**
(1 credit = 10^18 base units), never floats, and is designed to be paid via CE payment channels.

## Config / env

| Variable            | Purpose                                                        |
|---------------------|----------------------------------------------------------------|
| `--api`             | CE node HTTP base URL (default `http://127.0.0.1:8844`)        |
| `--index` / `$CE_CACHE_DIR` | key->CID index location (default `<config>/ce-cache/index.json`) |
| `--caps` / `$CE_CACHE_CAPS` | capability chain (hex) to present to hosts            |
| `$CE_CACHE_ROOTS`   | accepted capability root keys for a host (one 64-hex per line) |

## Status

Implemented and tested: `put`/`get`/`has` with the key->CID index (file + directory artifacts,
content-addressed round trip), the `cache/*` mesh protocol + cap-gated host loop, and the localhost
Bazel + sccache HTTP shim. See `// TODO` markers in source for the not-yet-wired items (payment
channels for rent, mesh `has`/`get` fan-out ranking by atlas/history, and on-chain `claim_name`
namespacing of a shared cache).
