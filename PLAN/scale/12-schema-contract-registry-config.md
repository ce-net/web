# 12 — Schema / contract (IDL) registry & config / feature-flag distribution

**Status:** implementation-ready design. Conforms to `00-architecture.md` (the contract wins on any
disagreement). Ground truth cited inline: `ce-coord/src/replicated.rs` (`Replicated`/`StateMachine`/
`Version`/`checkpoint`), `ce-coord/src/merged.rs` (`Merged`/`MergeMachine`/`MergeKey`),
`ce-coord/src/collections.rs` (`RMap`), `ce-coord/src/snapshot.rs` (`Checkpoint`/`Snapshot`),
`ce-coord/src/lib.rs` (the `Coord` pump), `ce-rs/src/lib.rs` (`publish`/`subscribe`/`request`/
`reply`, `put_object`/`get_object`, `AppMessage`, `advertise_service`/`find_service`),
`ce-iam/src/lib.rs` (`CE_CLOUD_ACTIONS`, `with_action_universe`), `ce/crates/ce-cap/src/lib.rs`
(`Capability`/`Resource`/`Caveats`/`SignedCapability`/`is_subset_of`/`is_narrower_or_equal`),
`ce-pubsub/src/caps.rs` (`verify_link`), `ce/docs/primitives.md`.

## Conformance block (architecture §7)

1. **Plane** — **coord** (`ce-coord` SDK over `ce-rs`), entirely (architecture §0.1 row 12). A
   schema/config registry is *replicated coordination state*: a single-writer, versioned, snapshot-
   compactable log per `(ns, subject)` — exactly what `ce-coord/src/replicated.rs` already is. It
   proposes **no new `RpcRequest`**: publish a schema/config = `propose` (a `publish`), resolve =
   the engine's `reader` + directed `request`/`reply` catch-up (`replicated.rs:243,353`,
   `ce-rs/src/lib.rs:443,450,471`), large schema bodies = content-addressed blobs
   (`put_object`/`get_object`, `ce-rs/src/lib.rs:340,358`). No peer that does not run the registry
   app must enforce anything on the wire, so it earns no node-plane change (architecture §1).
2. **Abilities** — reserves `schema:publish`, `schema:read`, `config:write`, `config:read`
   (architecture §3). Resource-scoped via `ce-cap::Resource::Tag` (`ce/crates/ce-cap/src/lib.rs:65`):
   `Tag("schema:<ns>/<subject>")` and `Tag("config:<ns>/<key>")`, so a grant can say "may
   `config:write` `game/prod/matchmaking.*` only" by attenuating resource, not ability
   (`is_subset_of`, `lib.rs:94`). Added to the documented action universe for `ce-iam` wildcard
   expansion (`ce-iam/src/lib.rs:50,93`), **not** to `ce-cap` — abilities stay opaque to the verifier.
3. **Envelope use** — reads/writes `Ctx.ns` (the registry namespace, §6), `Ctx.cap` (publish/write
   authorization), `Ctx.idem` (a retried `publish_schema`/`set_config` is exactly-once — no duplicate
   version churn), `Ctx.trace`/`parent_span` (a resolve/validate is one span of the calling action),
   `Ctx.hlc` (config writes carry an HLC so the "newest write wins" tiebreak is causal, not wall-clock
   only). Adds **no parallel header**.
4. **Status & partial failure** — returns `Ok`, `InvalidArgument` (the headline: a payload that does
   not validate against its subject's registered schema, architecture §4 maps this exactly to "schema
   mismatch"), `Unauthorized`, `NotFound` (no such subject/version/config key), `FailedPrecondition`
   (a `publish_schema` that breaks the subject's declared compatibility mode — the at-scale invariant;
   or a config CAS on a stale version), `Unavailable` (writer down), `ResourceExhausted` (publish
   rate/quota — primitive 11), `AlreadyApplied` (idempotent publish/write hit). A multi-subject batch
   validation returns `Partial<SubjectResult>` (architecture §4) — never collapses "8 of 10 schemas
   compatible" to a bool.
5. **Dependencies** — in-edges (architecture §5): `Ctx` envelope (keystone); **04 event log**
   (`04-event-log-stream.md`) and **03 durable queue** (`03-durable-queue.md`) are its primary
   *consumers* — they call `validate()` on every record/message payload before append/produce; **01
   service registry** (`01-service-registry-binding.md`) resolves the registry writer NodeId by
   `service_key = "<ns>/schema-registry@1"` instead of hard-coding it; **08 locks/election**
   (`08-locks-leases-election.md`) for registry-writer failover. It is the **last** primitive in the
   build order (architecture §5) because it composes everything below: it gates payloads for 03/04
   and distributes config to all of 01–11.
6. **Namespacing** — schema subjects and config keys live under `(ns, name)` (architecture §6): the
   schema log is `Replicated` named `ce-coord/registry/<writer>/<ns>/schemas`, config is a `Merged`
   replica keyed `(ns, "config")`, change fan-out is gossip `ce-app/<ns>/registry` per §6. Two
   tenants' `matchmaking` config never cross-deliver.
7. **Boundary check** — no app policy enters the node: the node stores opaque schema blobs, routes
   opaque `AppMessage`s, and verifies an opaque `Ctx.cap`; "schema", "subject", "compatibility mode",
   "feature flag", "rollout" are all `ce-coord`/app concepts. Stranger code never bypasses the local
   node — every publish/resolve/validate goes through `ce-rs`, the local node authenticates the sender
   (`AppMessage.from`, `ce-rs/src/lib.rs:732`) and verifies `Ctx.cap`; the *compatibility check and
   validation run in the app library on every node*, never as a node RPC.

---

## 1. Purpose & the at-scale problem

In a one-app system, the message format lives in one repo and changes atomically with both ends. In a
**many-app** CE ecosystem — `ce-db`, `ce-pubsub`, `ce-query`, `ce-gke`, game backends, indexers,
sagas, all talking over the same mesh (`ce/docs/primitives.md` "many apps share one mesh") — the
producer of a message and its consumers are **different apps, different teams, deployed at different
times, run by different keys**. Two failures then dominate operations and they are the survival
question for the ecosystem:

1. **Silent contract drift.** App B (a `ce-db` change-feed producer) adds a required field or renames
   one; App A (a search indexer consuming over event log 04) deserializes garbage or crashes. There is
   no compiler spanning the two apps; the only thing that catches it is a *shared, versioned,
   compatibility-checked contract*. This primitive is that: a **schema/IDL registry** that (a) stores
   every message contract under a stable **subject** name, (b) versions it, and (c) **refuses a new
   version that would break readers** under the subject's declared compatibility mode (backward /
   forward / full). App B can then evolve its API and *know* App A still parses it — or get a
   `FailedPrecondition` at publish time instead of a 3am page.

2. **Inconsistent config / feature flags across N apps.** A rollout, a kill-switch, a rate-limit
   ceiling, a matchmaking parameter must reach *every* instance of *many* apps **consistently** —
   monotonically (no instance ever goes backward to an old flag), convergently (all instances agree),
   and *fast* (a kill-switch is useless if it takes minutes). Without a primitive, each app reinvents a
   leaky config-fetch loop. This primitive distributes config/flags as **replicated coordination
   state** with a watch, so a flag flip propagates over the live gossip pump (`ce-coord/src/lib.rs:127`
   — "real-time first") and every reader converges to the same value.

The concurrency hazard both share at scale: **many writers/readers, no central broker, best-effort
gossip with gaps and duplicates** (`ce-coord/src/stream.rs:11`, `ce-coord/src/lib.rs:140`). The
insight is that CE already has the exact engine. The schema registry is a single-writer, append-only,
versioned, snapshot-compactable log — precisely `ce-coord`'s `Replicated` (`replicated.rs`), the same
engine `ce-iam`'s `CatalogLog` is (`ce-iam/src/catalog.rs:467` — a versioned, replayable registry of
roles/policies). Config distribution is a converging multi-writer map — precisely `ce-coord`'s
`Merged` (`merged.rs`) with last-writer-wins-by-HLC, the pattern `merged.rs` was built for. This
primitive *productizes* those two engines into the Confluent-Schema-Registry + LaunchDarkly surface,
with the compatibility checker as pure deterministic app logic on top.

## 2. Plane: node vs ce-coord, and the justification

**Plane: `ce-coord` (coordination), entirely.** Justification against architecture §0/§1:

- **Publish a schema** = `Replicated::propose(RegistryOp::PublishSchema{...})` (`replicated.rs:353`);
  the engine assigns the monotonic `Version` that becomes the schema version. **Resolve** = the
  engine's `reader`/`snapshot_reader` + directed `request`/`reply` catch-up (`replicated.rs:243,411,
  322`), all three verbs already in `ce-rs` (`lib.rs:443,450,471`). Large schema bodies (a full Avro/
  protobuf/JSON-Schema document) are content-addressed blobs (`put_object`, `lib.rs:340`); the log
  carries only `(subject, version, schema_cid, compat_mode)`. Nothing on the wire needs a peer that
  does not run the registry to enforce registry semantics.
- **Set config / flip a flag** = `Merged::propose(ConfigOp::Set{...})` (`merged.rs:199`); convergence
  is the `Merged` fold, leaderless, so concurrent writers from different admin keys converge by HLC
  key (`merged.rs:46`). **Watch** is the `Merged::watch()` receiver (`merged.rs:273`) fed by the live
  pump — no polling.
- **Compatibility checking and validation are pure deterministic functions** that run *in the app
  library on the node that is about to publish or that is about to produce a payload*. They are
  exactly "product semantics → app" (`primitives.md` litmus test). The node never parses a schema.
- The only node-plane facts it *consumes* are the shared §1/§2 envelope ones: `Ctx.idem` for
  exactly-once publish (primitive 09's dedup table), `Ctx.cap` verification, `Ctx.hlc` for the config
  LWW tiebreak. It adds **nothing** to that table.

Per architecture §1, proposing a new `RpcRequest` here would be rejected; we do not. This is a pure
`ce-coord` library, unprivileged, run as an ordinary app — the same shape `ce-iam` already ships as a
versioned-catalog library over the mesh.

## 3. Public API

### 3.1 Rust SDK (`ce-coord`, new module `ce-coord/src/registry.rs`)

Reuses the engine verbatim: the schema log is a `Replicated<SchemaRegistry>` (`replicated.rs:231`)
whose `Version` is the global registry version; per-subject versions are derived inside the state.
Config is a `Merged<ConfigState>` (`merged.rs:123`). Schema bodies are `put_object`/`get_object` blobs
(`ce-rs/src/lib.rs:340,358`); compaction is `Replicated::checkpoint()` (`replicated.rs:435`).

```rust
// ce-coord/src/registry.rs
use crate::{Coord, Version, Checkpoint};
use ce_rs::Ctx;                         // the envelope (architecture §2)
use anyhow::Result;

/// A schema body's wire dialect. The validator/compat-checker is dialect-specific; the registry
/// is dialect-agnostic (it stores opaque blobs + a tag). Start with JsonSchema; Avro/Protobuf are
/// pluggable validators behind the same surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Dialect { JsonSchema, Avro, Protobuf, Bincode /* a registered Rust type fingerprint */ }

/// The compatibility contract a subject promises to all readers. Checked at publish time.
/// (Mirrors Confluent's modes; the precise rules are in §4.2.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Compat {
    /// New schema can read data written by the *previous* schema (safe to upgrade consumers first).
    Backward,
    /// Old schema can read data written by the *new* schema (safe to upgrade producers first).
    Forward,
    /// Both Backward and Forward (the strongest; safe to upgrade either side independently).
    Full,
    /// No check — any new version accepted (escape hatch; logged).
    None,
}

/// One registered schema version of a subject.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchemaVersion {
    pub subject: String,        // "<app>.<MessageType>", e.g. "ce-db.ChangeEvent"
    pub version: u32,           // per-subject, 1-based, strictly increasing
    pub dialect: Dialect,
    pub schema_cid: String,     // content hash of the schema body (put_object); the body is fetched lazily
    pub fingerprint: [u8; 32],  // canonical hash of the schema body — the wire id producers stamp
    pub registry_ver: Version,  // the engine Version at which this was published (audit/ordering)
}

/// A handle to one namespace's registry. Cheap to clone.
pub struct Registry { /* Arc inner: Coord, ns, schema Replicated, config Merged, validator cache */ }

impl Coord {
    /// Open the registry for `ns` you **own** (you are the schema-log writer + a config writer).
    /// Requires `schema:publish`/`config:write` for mutations (checked per call via Ctx.cap).
    pub async fn registry_owner(&self, ns: &str) -> Result<Registry>;
    /// Open the registry for `ns` as a reader/producer. Resolves the schema writer via 01 under
    /// `service_key = "<ns>/schema-registry@1"`; config has many writers (Merged), so any reader
    /// follows all of them.
    pub async fn registry(&self, ns: &str) -> Result<Registry>;
}

impl Registry {
    // ---- schema / contract ----

    /// Register a new version of `subject` under compatibility `compat`. Runs the compatibility
    /// check against the subject's current latest version BEFORE proposing; on a break returns
    /// `FailedPrecondition` (the new schema would break readers under `compat`) — App B learns at
    /// publish time, not in production. `Ctx.idem` makes a retried publish exactly-once (returns
    /// `AlreadyApplied` with the existing version on a dedup hit). Requires `schema:publish` on
    /// `Tag("schema:<ns>/<subject>")`.
    pub async fn publish_schema(
        &self, ctx: &Ctx, subject: &str, dialect: Dialect, compat: Compat, body: &[u8],
    ) -> Result<SchemaVersion>;

    /// The latest registered version of `subject` (`NotFound` if unknown). Reads the local replica.
    pub fn latest(&self, subject: &str) -> Option<SchemaVersion>;
    /// A specific version (for decoding data stamped with an older fingerprint).
    pub fn version(&self, subject: &str, version: u32) -> Option<SchemaVersion>;
    /// Resolve a producer-stamped wire fingerprint back to its `SchemaVersion` (the decode path).
    pub fn by_fingerprint(&self, fp: &[u8; 32]) -> Option<SchemaVersion>;
    /// Fetch the schema body for a version (lazy: `get_object` on `schema_cid`, cached).
    pub async fn body(&self, sv: &SchemaVersion) -> Result<Vec<u8>>;

    /// Validate `payload` against a subject version. The headline at-scale guard: a producer (03/04)
    /// calls this before append/produce; `Err(InvalidArgument)` carries the validation detail.
    /// Validation is a pure deterministic function of (body, payload) — no network, no node.
    pub async fn validate(&self, subject: &str, version: u32, payload: &[u8]) -> Result<()>;

    /// Set/raise the compatibility mode of a subject (owner only; `schema:publish`). Tightening is
    /// always allowed; loosening (e.g. Full -> None) is logged.
    pub async fn set_compat(&self, ctx: &Ctx, subject: &str, compat: Compat) -> Result<()>;

    /// Owner-only compaction: snapshot the registry and drop superseded log entries
    /// (`Replicated::checkpoint`, `replicated.rs:435`). A fresh reader bootstraps from the blob.
    pub async fn compact_schemas(&self) -> Result<Checkpoint>;

    // ---- config / feature flags ----

    /// Set a config value (a flag, a parameter, a kill-switch). Convergent multi-writer LWW by
    /// (Ctx.hlc, writer) — concurrent writes from two admin keys converge deterministically (§4.3).
    /// `expect` (optional) is a compare-and-set on the current version: `FailedPrecondition` if the
    /// live version differs (atomic flag flips). Requires `config:write` on `Tag("config:<ns>/<key>")`.
    pub async fn set_config(
        &self, ctx: &Ctx, key: &str, value: &[u8], expect: Option<ConfigStamp>,
    ) -> Result<ConfigStamp>;

    /// Read a config value from the local replica (bounded-stale, monotone — never goes backward).
    pub fn get_config(&self, key: &str) -> Option<ConfigEntry>;
    /// Snapshot of every config key under this ns (for a fresh app booting up).
    pub fn config_snapshot(&self) -> Vec<(String, ConfigEntry)>;
    /// Watch for any config change; fires on the live pump the instant a write converges
    /// (wraps `Merged::watch`, `merged.rs:273`) — a kill-switch reaches every app in ~one hop.
    pub fn watch_config(&self) -> tokio::sync::watch::Receiver<u64>;

    /// Evaluate a boolean feature flag for a principal — deterministic percentage rollout keyed on
    /// `hash(key, node_id)` so a given identity is stably in/out of the rollout cohort. Pure local.
    pub fn flag_enabled(&self, key: &str, for_node: &str) -> bool;
}

/// A config value plus its causal stamp (so a reader can detect monotonicity / drive CAS).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfigEntry { pub value: Vec<u8>, pub stamp: ConfigStamp }
/// The LWW key for a config write: (HLC, writer NodeId) — a strict total order (the `Merged` MergeKey).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ConfigStamp { pub hlc: (u64, u32), pub writer: String }
```

### 3.2 TS SDK (`ce-ts`)

Mirror surface over the same `@ce/client` mesh transport the browser-node bridge exposes (platform
task #4). Types match the Rust wire structs (amounts/u64 cross JSON as strings → `bigint`).

```ts
type Dialect = "json-schema" | "avro" | "protobuf" | "bincode";
type Compat  = "backward" | "forward" | "full" | "none";

interface SchemaVersion {
  subject: string; version: number; dialect: Dialect;
  schemaCid: string; fingerprint: Uint8Array; registryVer: bigint;
}
interface ConfigStamp { hlc: [number, number]; writer: string }
interface ConfigEntry { value: Uint8Array; stamp: ConfigStamp }

interface Registry {
  // schema
  publishSchema(subject: string, dialect: Dialect, compat: Compat,
                body: Uint8Array, ctx?: Ctx): Promise<SchemaVersion>;
  latest(subject: string): SchemaVersion | null;
  version(subject: string, version: number): SchemaVersion | null;
  byFingerprint(fp: Uint8Array): SchemaVersion | null;
  body(sv: SchemaVersion): Promise<Uint8Array>;
  validate(subject: string, version: number, payload: Uint8Array): Promise<void>;  // throws InvalidArgument
  setCompat(subject: string, compat: Compat, ctx?: Ctx): Promise<void>;
  // config / flags
  setConfig(key: string, value: Uint8Array,
            expect?: ConfigStamp, ctx?: Ctx): Promise<ConfigStamp>;
  getConfig(key: string): ConfigEntry | null;
  configSnapshot(): Array<[string, ConfigEntry]>;
  watchConfig(): AsyncIterable<void>;          // yields on every converged change
  flagEnabled(key: string, forNode: string): boolean;
}

declare function registryOwner(ns: string): Promise<Registry>;
declare function registry(ns: string): Promise<Registry>;
```

### 3.3 Node HTTP routes & wire types

**None.** Per §2 this is pure `ce-coord` over the three existing verbs plus blobs. The wire format is
the existing `Replicated` op/catch-up types (`replicated.rs:38,46,56`), `Checkpoint`
(`snapshot.rs`), and the `Merged` per-writer logs (`merged.rs`) — all carried inside
`AppMessage`/`AppPubSubMsg.payload`, opaque to the node (`ce-rs/src/lib.rs:731`). The only new
bincode/serde types are the app-level `SchemaVersion`, `RegistryOp`/`SchemaRegistry`,
`ConfigOp`/`ConfigState`, `ConfigEntry`/`ConfigStamp`, `Dialect`, `Compat` above — they live in
`ce-coord` and never touch the node.

## 4. Protocol & data structures

### 4.1 Schema log = `Replicated<SchemaRegistry>`

The registry is one single-writer `ce-coord` log per namespace — the same engine and shape as
`ce-iam`'s `CatalogLog` (`ce-iam/src/catalog.rs:467,489` — a versioned, replayable, snapshotable
registry). The state machine:

```rust
// ce-coord/src/registry.rs — the schema-registry replicated state machine.
#[derive(Default, Clone, Serialize, Deserialize)]
struct SchemaRegistry {
    // subject -> ordered versions (last = latest). Versions are append-only and immutable.
    subjects: BTreeMap<String, Vec<SchemaVersion>>,
    compat:   BTreeMap<String, Compat>,      // subject -> current compatibility mode
    by_fp:    BTreeMap<[u8; 32], (String, u32)>, // fingerprint -> (subject, version) for decode
}
#[derive(Clone, Serialize, Deserialize)]
enum RegistryOp {
    // The compatibility check ran on the *writer's* node before propose; the op records the result.
    PublishSchema { subject: String, dialect: Dialect, compat: Compat,
                    schema_cid: String, fingerprint: [u8; 32] },
    SetCompat     { subject: String, compat: Compat },
}
impl StateMachine for SchemaRegistry {          // replicated.rs:64
    type Op = RegistryOp;
    fn apply(&mut self, op: RegistryOp) {
        match op {
            RegistryOp::PublishSchema { subject, dialect, compat, schema_cid, fingerprint } => {
                let versions = self.subjects.entry(subject.clone()).or_default();
                let version = versions.len() as u32 + 1;   // per-subject monotone, assigned in apply
                let sv = SchemaVersion { subject: subject.clone(), version, dialect,
                                         schema_cid, fingerprint, registry_ver: /* engine Version */ 0 };
                self.by_fp.insert(fingerprint, (subject.clone(), version));
                self.compat.entry(subject).or_insert(compat);
                versions.push(sv);
            }
            RegistryOp::SetCompat { subject, compat } => { self.compat.insert(subject, compat); }
        }
    }
}
impl Snapshot for SchemaRegistry { json_snapshot!(); }   // snapshot.rs — compaction + cheap bootstrap
```

- **Per-subject version assignment happens inside `apply`** (`version = len()+1`), exactly as
  `ce-pubsub`'s `TopicLog` re-stamps its cursor inside `apply` and as the event-log design re-stamps
  offsets — so a malformed or reordered op can never desync per-subject version numbers. The engine's
  global `Version` (`replicated.rs:35`) orders *all* publishes; the per-subject number is derived.
- **Resolve** is a pure local read of the replica (`Replicated::read`, `replicated.rs:383`); a fresh
  reader bootstraps via `snapshot_reader` (`replicated.rs:411`) then tails — no special path.

**Invariant (immutability + monotone versions):** a published `(subject, version)` is never mutated or
reused. Versions per subject are `1..n` contiguous and strictly increasing. The fingerprint of a body
is stable (canonicalize-then-hash) so the same schema re-published is detected and returns the
existing version (idempotent, no churn).

### 4.2 The compatibility check (the at-scale invariant)

This is the whole point of the primitive and it runs **before** `propose`, in the app library on the
publishing node:

```
fn check_compat(prev: &SchemaBody, next: &SchemaBody, mode: Compat) -> Result<(), Incompatibility>
```

For JSON-Schema (first dialect), the deterministic rules (Confluent-equivalent):

- **Backward** (new reads old data): the new schema may *add optional* fields and *remove required*
  fields, may *widen* types; it may **not** add a new *required* field without a default, nor narrow a
  type, nor remove an enum value a producer might still send. Lets you upgrade consumers first.
- **Forward** (old reads new data): new schema may *add required-with-default* and *remove optional*;
  may **not** remove a field old readers require. Lets you upgrade producers first.
- **Full** = Backward ∧ Forward. **None** = always pass (logged escape hatch).

If the check fails, `publish_schema` returns `Status::FailedPrecondition` with the specific
incompatibility (e.g. `"field 'score' added as required without default — breaks Backward readers"`).
**The check is a pure function of two schema bodies and a mode**, so it is exhaustively unit/property-
testable with zero infrastructure (§8) — the deterministic core that makes this primitive trustworthy.
Avro/Protobuf checkers are pluggable behind the same `check_compat` signature.

### 4.3 Config / flags = `Merged<ConfigState>`

Config is a **multi-writer merged map** (`merged.rs:123`) named `(ns, "config")`, so many admin keys
write concurrently and every reader converges with no leader — the leaderless property `merged.rs`
proves (`prop_multiwriter_all_orders_converge`). Last-writer-wins is decided by the strict-total-order
`MergeKey` (`merged.rs:46`) `(hlc, writer)`:

```rust
#[derive(Default)]
struct ConfigState { entries: BTreeMap<String, ConfigEntry> }   // key -> {value, stamp}
#[derive(Clone, Serialize, Deserialize)]
struct ConfigOp { key: String, value: Vec<u8>, stamp: ConfigStamp }  // stamp = (hlc, writer)
impl MergeMachine for ConfigState {                 // merged.rs:57
    type Op  = ConfigOp;
    type Key = ConfigStamp;                          // (hlc, writer) — globally unique, totally ordered
    fn key(op: &ConfigOp) -> ConfigStamp { op.stamp.clone() }
    fn apply(&mut self, op: ConfigOp) {
        let e = self.entries.entry(op.key.clone());
        match e {
            // LWW: a write wins iff its stamp is greater (later HLC, writer-id tiebreak).
            Entry::Occupied(mut o) if op.stamp <= o.get().stamp => { /* stale write, ignore */ }
            slot => { slot.insert(ConfigEntry { value: op.value, stamp: op.stamp }); }
        }
    }
}
```

- **Convergence** is the `Merged` fold over all writers' logs, order-independent and idempotent
  (`merged.rs:prop_multiwriter_idempotent_commutative`): every node, having seen the same set of ops
  in *any* order, holds the same value for every key. The `(hlc, writer)` total order makes LWW
  deterministic — no value oscillation.
- **CAS** (`expect: Some(stamp)`): the writer's node reads the live entry; if its stamp differs,
  returns `FailedPrecondition` without proposing — an atomic flag flip ("flip only if currently X").
- **Watch** = `Merged::watch()` (`merged.rs:273`), fed by the live SSE pump (`lib.rs:127`): a flip
  converges and fires the watch in ≈ one hop. **Feature flags** are config keys; `flag_enabled`
  evaluates a `{ enabled, rollout_pct, salt }` value by `hash(salt, for_node) % 100 < rollout_pct`,
  pure-local and stable per identity (a gradual rollout is monotone per node).

**Invariant (monotone reads, convergent values):** a reader's view of a key never goes backward
(`apply` only accepts a strictly-greater stamp), and all readers that have seen the same writes agree.
A kill-switch, once converged, cannot be "un-seen" by a stale redelivery (the offset/stamp dedup in
the engine, `merged.rs`).

### 4.4 Producer/consumer integration (how 03/04 use it)

The registry is a *library dependency* of the queue (03) and event log (04):

- A **producer** stamps the payload's wire format with the subject fingerprint (4-byte magic +
  32-byte `fingerprint`, or carries `(subject, version)` in `Ctx`-adjacent record headers), and calls
  `registry.validate(subject, version, payload)` before `append`/`produce`. On `InvalidArgument` the
  append is rejected locally — bad data never enters the log. (For Bincode/Rust-type subjects, the
  fingerprint is a type hash and "validation" is a length/decode probe.)
- A **consumer** reads the stamped fingerprint, `by_fingerprint` → `SchemaVersion`, fetches the body
  (cached), and decodes with the *writer's* schema — so a reader on schema v3 correctly decodes data
  written at v1 (the compatibility guarantee). This is the "App A keeps parsing App B's evolved
  payloads" survival property, realized.

## 5. Semantics & failure modes

**Guarantees.**
- **Schema immutability + monotone versions.** A `(subject, version)` is permanent; versions are
  contiguous and strictly increasing per subject (§4.1). Inherited from `Replicated` single-writer
  ordering (`replicated.rs:9-17`).
- **Compatibility enforced at publish.** Under `Backward`/`Forward`/`Full`, a version that would break
  the declared readers is rejected with `FailedPrecondition` *before* it is visible — the at-scale
  contract that lets independent apps evolve. `None` is an explicit, logged escape hatch.
- **Config convergence + monotonicity.** All readers converge to the same value per key; a reader's
  value never regresses (§4.3). LWW is deterministic by `(hlc, writer)`.
- **Durable & replayable.** Every schema/config write survives writer restart (it is in the log +
  snapshots) and is replayable; a fresh app bootstraps the entire registry from a content-addressed
  snapshot blob (`snapshot.rs`, `replicated.rs:411`) without replaying history.
- **Exactly-once publish/write** with `Ctx.idem` (primitive 09 dedup table) — a retried publish
  returns `AlreadyApplied` with the existing version, never a duplicate version.

**What it does NOT guarantee.**
- **Not synchronous global agreement.** A just-published schema / just-flipped flag is visible on the
  writer immediately and on every reader after the mesh propagates (≈ one hop live, bounded-stale on
  catch-up). It is **eventually** consistent, not linearizable. A producer that *must* not run ahead of
  a consumer's schema knowledge uses `Full` compat (both sides safe regardless of order) — that is the
  design answer, not a stronger consistency model.
- **No semantic validation beyond the schema.** It checks *structure* (the schema), not business
  invariants ("score ≥ 0"). Those are the app's `validate` extension or its own logic.
- **No automatic data migration.** It tells you a change is incompatible; it does not rewrite old data.
  Event-sourced apps replay old records *through the registered old schema* (§4.4).
- **Config is not a transaction store.** CAS is per-key, not multi-key atomic. Multi-key atomic config
  is a saga (10) or a single composite value.

**Crash/partition behavior.** Schema-writer crash → publishes stall until 08 failover; *resolves keep
working* from every reader's replica (the registry is fully replicated, reads are local). Config has
many writers (Merged) so a single writer crash never blocks config writes from other admins. Network
partition → each side serves stale-but-consistent reads of the last converged state; on heal the
`Merged`/`Replicated` folds reconcile (no split-brain for config because LWW is deterministic; no
split-brain for schemas because there is one writer/lease per registry). Snapshot blob unreachable →
a fresh reader cannot bootstrap a compacted floor; returns `Unavailable` and retries (blobs are
content-addressed and refetchable, `ce-rs/src/lib.rs:340-389`).

## 6. Security & economy

- **Abilities (architecture §3):** `schema:publish` (register a version, set compat),
  `schema:read` (resolve/validate — often grant-free for an app's own data), `config:write`
  (set a flag/value), `config:read`. Carried in `Ctx.cap`; the writer's local node verifies the chain
  authorizes the exact `domain:verb` on `Resource::Tag("schema:<ns>/<subject>")` /
  `Tag("config:<ns>/<key>")` before applying the op — the same `verify_link` gate `ce-pubsub` uses
  (`ce-pubsub/src/caps.rs:98`), checked at the enforcement point per `primitives.md`. A grant
  attenuates by resource to a single subject/key prefix, or by `ns` tag to a tenant (architecture §6),
  via `Resource::is_subset_of` (`ce/crates/ce-cap/src/lib.rs:94`). These four abilities are added to
  the `ce-iam` action universe (`ce-iam/src/lib.rs:50,93`) so wildcards expand, but **not** to
  `ce-cap` (opaque-string invariant).
- **Abuse/DoS bounds.** (a) **Schema body size** capped (reuse the `MAX_PAYLOAD_BYTES = 10 MiB` bound
  from `ce-pubsub`); the body is a blob so the log stays small. (b) **Publish/write rate** is primitive
  11 (`11-flow-control-rate-limit.md`): the writer's node throttles `schema:publish`/`config:write`
  per `(from, ns, ability)` token bucket and returns `ResourceExhausted` with `retry_after_ms`
  (architecture §4) before doing work — economy-tied. (c) **Version churn** bounded by idempotent
  fingerprinting (re-publishing an identical body is a no-op) + the publish-rate quota. (d)
  **Unbounded log growth** bounded by `compact_schemas` (snapshot + drop superseded entries,
  `replicated.rs:435`); old *versions* are retained (you must decode old data) but the op log is
  compacted into a snapshot. (e) **Config-write spam** bounded by `config:write` cap + the `Merged`
  dedup-by-key (`merged.rs`).
- **Optional payment-channel metering.** A premium/cross-org registry (a paid shared contract hub)
  meters `schema:read` body fetches against a payment channel: the reader opens a channel
  (`channel_open`, `ce-rs/src/lib.rs:543`), signs cumulative receipts per fetched MiB
  (`sign_receipt`, `lib.rs:551`), the owner redeems on close (`channel_close`, `lib.rs:557`) — reusing
  the existing channel primitive exactly as paid blob fetch does (`fetch_chunk_paid`, `lib.rs:391`).
  The registry adds only byte accounting, not new economy.

## 7. Composition

- **Depends on** (in-edges, architecture §5):
  - `Ctx` envelope (keystone) — `00-architecture.md` §2.
  - **09 causal time / idempotency** — `09-ordering-exactly-once.md`: `Ctx.hlc` is the config LWW key;
    `Ctx.idem` makes publish/write exactly-once.
  - **01 service registry / binding** — `01-service-registry-binding.md`: resolves the schema-registry
    writer NodeId by `service_key = "<ns>/schema-registry@1"` instead of hard-coding it.
  - **08 locks / leases / election** — `08-locks-leases-election.md`: schema-writer failover lease.
- **Enables / is depended on by:**
  - **04 event log** — `04-event-log-stream.md`: validates every record's `value` against the topic's
    registered subject before append (`InvalidArgument` on mismatch); §10 of that doc names this
    primitive explicitly as its validator.
  - **03 durable queue** — `03-durable-queue.md`: same — every produced message is schema-checked.
  - **05 resilient RPC** — `05-resilient-rpc.md`: an RPC request/response pair is two subjects; the
    registry version-checks an inter-app call's argument and return contract (App B evolving its RPC
    without breaking App A is the §1 headline, applied to RPC).
  - **11 flow control / quota** — `11-flow-control-rate-limit.md`: per-tenant quota *ceilings* are
    distributed as config keys read by the node's admission point's controlling app.
  - **Every app** consumes config/flags: 01 (binding policy), 02 (placement weights), 10 (saga
    parameters), and game backends (matchmaking knobs, kill-switches).
- **Sibling/peer:** **06 tracing** (`06-distributed-tracing.md`) — a schema publish or config flip is
  one span; **07 telemetry** (`07-telemetry-metrics-health.md`) exports registry version + per-flag
  exposure counts.

## 8. Test plan

**Deterministic cores (pure unit/property tests, no node/mesh — the bulk of correctness).**
- **`check_compat` truth table** (the crown jewel): for JSON-Schema, exhaustively test every rule —
  add optional (Backward ok / Forward ok), add required-no-default (Backward FAIL), remove required
  (Backward ok / Forward FAIL), type widen/narrow, enum add/remove. Property test: `Full` ⇔
  `Backward ∧ Forward`; `None` always passes. This is a closed deterministic function — test it to
  death.
- **`SchemaRegistry` apply algebra**: per-subject versions are contiguous & monotone after arbitrary
  op orders; a re-published identical body resolves to the existing version (idempotent fingerprint);
  `by_fingerprint` round-trips every published version. Property test over random op streams (reuse the
  `replicated.rs` proptest style).
- **`ConfigState` merge**: `prop`-test that concurrent `Set`s on the same key converge to the
  `(hlc, writer)`-max under any delivery order / duplicates (reuse `merged.rs`'s
  `prop_multiwriter_all_orders_converge`, `prop_multiwriter_idempotent_commutative`); monotone reads
  (no value regresses); CAS rejects a stale `expect`.
- **`flag_enabled`** stability: `hash(salt, node) % 100 < pct` is stable for a node across calls, and
  the in-cohort fraction approaches `pct` over many nodes (distribution property).
- **Snapshot+tail == full replay** for `SchemaRegistry` at every cut point (mirror
  `snapshot.rs` and `replicated.rs:prop_snapshot_install_plus_tail_equals_full`): a reader bootstrapped
  from a compacted snapshot reaches byte-identical state.

**Integration tests (`ce-coord` testkit, in-process `Coord` over the loopback `MockNode` —
`ce-coord/src/testkit.rs:103,110`).**
- Owner publishes v1; a reader on another (mock) node resolves it; owner publishes a Backward-
  compatible v2 → ok; owner publishes a Backward-breaking v3 → `FailedPrecondition`, registry still at
  v2 for everyone.
- A producer validates a good payload (ok) and a bad payload (`InvalidArgument`) against a resolved
  subject; a consumer decodes a v1-stamped payload with a v3 reader schema (compat decode).
- Two admin keys `set_config` the same key concurrently → both readers converge to the
  `(hlc, writer)`-winner; a `watch_config` fires on the converged change.
- CAS flag flip: `set_config(expect=current)` succeeds; a second writer's stale `expect` →
  `FailedPrecondition`.
- Exactly-once publish: retry the same `publish_schema` with a fixed `Ctx.idem` → one version, second
  returns `AlreadyApplied`.

**Needs a live multi-node mesh (E2E).**
- Cross-host: registry writer on node A, producer on B, consumer on C; B validates against A's schema
  resolved over 01; a flag flipped on A reaches C in ≈ one hop (latency assertion).
- Writer failover (08): kill the schema writer, a standby acquires the lease, resumes from
  snapshot+log, publishes continue, no version reused; resolves never interrupted (replica reads).
- Payment-metered schema body fetch over a real channel (redeem on close).

## 9. Worked example — a sharded game backend evolving its API + a kill-switch

The multiplayer game backend (a mesh game from platform task #5) runs three independent apps on one
namespace `game/prod`: `match-host` (authoritative producer), `live-gateway` (WebSocket fan-out
consumer), and `leaderboard` (an indexer into `ce-db`). They integrate over the event log (04), whose
records this registry gates.

- **Contract evolution without breakage.** `match-host` v1 produces `MatchEvent` under subject
  `game.MatchEvent`, registered `Compat::Full`. The team ships `match-host` v2 that adds an optional
  `region: string` field. `publish_schema("game.MatchEvent", JsonSchema, Full, body_v2)` runs the
  compat check: adding an *optional* field is Full-compatible → accepted as version 2.
  `live-gateway` and `leaderboard`, still on v1 schemas, keep decoding v2 records correctly (Forward),
  and once upgraded decode v1 records correctly (Backward). App B evolved its API; App A never broke —
  the §1 survival property, realized. Had the team instead added `region` as **required without
  default**, `publish_schema` returns `FailedPrecondition` at deploy time — the break is caught before
  a single bad record is produced, not at 3am when the gateway crashes.
- **Validation at the producer.** Each `match-host` calls `registry.validate("game.MatchEvent", v,
  payload)` before `event_log.append` (04 §4.4). A bug that emits a malformed event is rejected
  locally with `InvalidArgument` — bad data never enters the partition, so no downstream consumer ever
  sees it.
- **Consistent kill-switch across all three apps.** A live exploit appears. An on-call admin runs
  `set_config(ctx, "match.accept_new", b"false", expect=Some(current))` — an atomic CAS flip.
  Within ≈ one hop the `Merged` value converges and the `watch_config` receiver fires on every
  `match-host`, `live-gateway`, and `leaderboard` instance; producers stop accepting new matches.
  Because the value is monotone (`(hlc, writer)` LWW), a stale gossip redelivery of the old `true`
  can never resurrect it.
- **Gradual rollout.** A new matchmaking algorithm ships behind
  `set_config("matchmaking.v2", {enabled:true, rollout_pct:10, salt:"mm"})`. Each `match-host` calls
  `flag_enabled("matchmaking.v2", self_node_id)` → deterministically in/out by
  `hash("mm", node) % 100 < 10`, so a stable 10% of hosts use v2; raising `rollout_pct` to 100 over
  hours is monotone per host (a host that flipped on never flips back).
- **Tracing the change.** The `publish_schema` and the kill-switch flip each carry one `Ctx.trace`
  (architecture §2), so primitive 06 shows the operator exactly which deploy/flip propagated to which
  nodes and when.

Every hop is `ce-rs`/`ce-coord` through the local node; no app opens a socket to a stranger; the game
owner's grants pin `schema:publish`+`config:write` to `game/prod` for its operators and `schema:read`
for its hosts/gateways — the boundary holds.

## 10. Effort & minimal first slice

**Effort: M.** The two engines (`Replicated`, `Merged`, `Snapshot`, blobs) and their proven algebra
already exist (`ce-coord/src/{replicated,merged,snapshot}.rs`), and `ce-iam`'s `CatalogLog` already
demonstrates a versioned registry over them. The genuinely new work is concentrated and deterministic:
the `check_compat` truth table (the one piece worth most of the test budget), the `SchemaRegistry`/
`ConfigState` state machines, fingerprinting, and the typed `Registry` surface. L only if Avro +
Protobuf compat checkers and writer-failover are pulled into the first cut.

**Minimal first slice (ships behind tests):**
1. `ce-coord/src/registry.rs`: `SchemaRegistry`/`RegistryOp` state machine + `Snapshot`;
   `SchemaVersion`/`Dialect`/`Compat` types; canonicalize-then-hash fingerprinting.
2. `check_compat` for the **JsonSchema** dialect only — full Backward/Forward/Full/None rules, with the
   exhaustive truth-table tests (§8). The deterministic core.
3. `Registry::{publish_schema, latest, version, by_fingerprint, validate, set_compat}` over
   `Replicated::propose`/`reader`/`checkpoint` — single owner-writer per namespace, no failover yet.
4. `ConfigState`/`ConfigOp` `Merged` + `Registry::{set_config (with CAS), get_config, watch_config,
   flag_enabled}` with `(hlc, writer)` LWW.
5. `Ctx` threading: honor `Ctx.idem` for publish/write dedup, `Ctx.hlc` for the config stamp,
   `Ctx.cap` resource-scoped to `schema:`/`config:` tags (degrade gracefully if the §1 envelope work
   is not yet live — fall back to at-least-once + self-NodeId namespace).
6. Deterministic-core unit/property tests (§8) + the in-process testkit integration tests. Defer
   Avro/Protobuf checkers, 01-resolution (hard-code the owner), 08-failover, and payment metering to
   follow-ups.

This delivers the headline capability — versioned, compatibility-checked message contracts so apps
evolve without breaking each other, plus consistent monotone config/feature-flag distribution to many
apps — as a pure `ce-coord` library with zero node-plane change, exactly per the contract.
