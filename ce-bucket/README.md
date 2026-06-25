# ce-bucket

Geo/owner-diverse **replicated bucket storage** on CE — the durable bucket primitive other apps
build on.

ce-bucket adds **nothing** that the layers below it already do. It is pure wiring:

| Layer | Repo / crate | What it owns |
|-------|--------------|--------------|
| **Namespace** (buckets, objects, `key -> CID`, S3 verbs, ranged reads, versioning) | [`ce-storage`](../ce-storage) | turns CE content-addressed blobs into named buckets/objects |
| **Replication** (place N copies across distinct fault domains, proof-of-retrievability, paid pins, auto-repair) | [`ce-pin`](../ce-pin) | keeps a CID alive on N hosts and proves it |
| **Binding + trigger** (this crate) | `ce-bucket` | ties `bucket/key` intent to replication actuation, and runs maintenance |

The only state ce-bucket owns is a small durable **replica index**: `bucket/key -> {cid,
replica_hosts, expiry}` plus a per-bucket **replication policy** (the factor). ce-storage already
knows `key -> CID`; ce-pin already knows `cid -> replicas`. ce-bucket is the thin layer in between.

## How it composes (not reinvents)

- **`put_object(bucket, key, bytes, factor)`**
  1. `ce_storage::Store::put_object` stores the bytes content-addressed and binds `bucket/key -> CID`.
  2. `ce_pin::client::candidate_hosts` gathers ranked hosts (DHT + capacity atlas + on-chain reputation).
  3. `ce_pin::client::replicate` places `factor` replicas — internally calling
     `ce_pin::placement::select`, which **spreads copies across distinct region/zone/ASN/owner fault
     domains** — and opens rent payment channels.
  4. The `bucket/key -> {cid, replica_hosts, expiry}` record is written to the durable replica index
     (atomic temp-file + rename JSON).

- **`get_object(bucket, key)`** serves from `ce_storage::Store::get_object` (which resolves the CID
  and pulls + CID-verifies every chunk, falling back to the mesh DHT for anything not held locally).
  If this node holds only the replica record and not the namespace binding, it falls back to
  `ce_pin::client::get` to fetch by CID over the mesh — also CID-verified.

- **`maintain()`** probes every tracked object's replicas with `ce_pin::client::audit_replica`
  (beacon-seeded proof-of-retrievability), decides the shortfall with the pure
  `ce_pin::repair::repair_plan`, and re-replicates under-provisioned objects back to their factor
  across **distinct fault domains** — then persists the refreshed holder set atomically.

Geo/owner diversity, proof-of-retrievability, payment, and auto-repair all live in **ce-pin**.
ce-bucket only adds the bucket-namespace binding, the replica index, and the maintain trigger.

## Mesh-first

Every cross-host action — host discovery, pin offers, rent channels, audits, fetching a missing
object by CID — flows through `ce-rs` (libp2p request/reply, DHT, payment channels) inside the
ce-pin / ce-storage calls. ce-bucket opens no side HTTP channel and stores no ip:port. Service
selection uses the `ce_rs::locate` keystone (DHT + atlas + reputation), never a hardcoded NodeId.

## CLI

```
ce-bucket mb <bucket> [--factor N]          # create a bucket, optionally set its replication policy
ce-bucket put <bucket> <key> <file> [-r N]  # store + replicate (factor: -r > policy > default)
ce-bucket get <bucket> <key> [-o out]       # fetch (CID-verified, mesh-aware) to stdout or a file
ce-bucket ls  <bucket> [--prefix P]         # list objects with their live/desired replica counts
ce-bucket maintain                          # one audit + auto-repair pass over every tracked object
```

Global flags: `--factor N` (default replication factor), `--caps <hex>` (capability chain presented
to hosts; falls back to `$CE_PIN_CAPS` / the ce-pin caps file), `--storage-index <path>`,
`--replica-index <path>`.

The replica index lives at `<config dir>/ce-bucket/replicas.json` (override with `$CE_BUCKET_DIR`).

## Library

```rust
use ce_bucket::ReplicatedStore;

let mut store = ReplicatedStore::open(
    ce_storage::index::default_index_path(),
    ce_bucket::index::ReplicaIndex::default_path(),
    String::new(), // capability chain hex
)?;
store.make_bucket("backups", Some(3))?;                                  // 3-way, diverse
store.put_object("backups", "db.sql", &bytes, "application/sql", None).await?;
let bytes = store.get_object("backups", "db.sql").await?;                // CID-verified
let report = store.maintain().await?;                                    // audit + repair
```

## Status

- Implemented & unit-tested: the durable replica index, the per-bucket replication policy, the pure
  lease-expiry arithmetic.
- The replication / audit / repair calls are wired to ce-pin and the namespace calls to ce-storage;
  they exercise the live mesh (run against a CE node with pinning hosts advertised as `pin:host`).
- A bucket primitive other CE apps depend on for durable, geo/owner-diverse object storage.
