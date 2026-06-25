# @ce-net/sdk — Runtime-Agnostic TypeScript Client for the CE Node API

> Workstream: `ts-sdk` · Suggested target path: `ce-ts (new repo: github.com/ce-net/ce-ts, published as @ce-net/sdk)`
> Depends on: none

**Summary:** @ce-net/sdk is a hand-written, typed TS/JS client that mirrors ce-rs 1:1 over the CE node's HTTP+SSE API, runtime-agnostic across Node 20+, Deno, Bun, browsers, and Cloudflare Workers. It uses global fetch only (injectable), exposes an Amount value type backed by bigint to honor CE's decimal-string base-unit money model, and surfaces all four SSE streams as typed AsyncIterables. It is pure app/SDK tier — zero node changes required, since every endpoint in the http-api map already exists. It becomes the foundation the web dashboard, notes app, and hosting UI all consume, and ships alongside a hand-maintained OpenAPI 3.1 spec so Python/Go clients can be generated without forking the flagship hand-written TS+Rust SDKs.

---

# @ce-net/sdk — Design Doc

> Workstream key: `ts-sdk`. New repo `ce-ts` (github.com/ce-net/ce-ts), published to npm as `@ce-net/sdk`. Mirrors `ce-rs` 1:1 over the CE node HTTP+SSE API.

## 1. Goals / Non-Goals

### Goals
- A single, typed TS/JS package that wraps **every** endpoint in the CE node HTTP API (the http-api map), mirroring `ce-rs` method-for-method where `ce-rs` has coverage, and **also** wrapping the SSE streams + signals that `ce-rs` deliberately skips.
- **Runtime-agnostic**: identical bundle runs on Node 20+, Deno, Bun, browsers, and Cloudflare/Vercel edge Workers. Web-standard APIs only (`fetch`, `ReadableStream`, `AbortController`, `TextDecoder`, `crypto`).
- **Money correctness by construction**: amounts are decimal strings on the wire and a `bigint`-backed `Amount` value type in user code. `number` must be structurally impossible for money.
- **SSE as `AsyncIterable`**: `for await (const block of ce.blocks.stream())` for blocks, transactions, signals, and mesh messages, with auto-reconnect + `Last-Event-ID` resume.
- **One client the three frontends share**: web dashboard (`web/`), notes app, and hosting UI all import `@ce-net/sdk` — no per-app re-implementation of money/SSE/auth.
- Dual ESM+CJS publish, tree-shakeable, types verified with `publint` + `attw`.
- Ship an **OpenAPI 3.1 spec** as a secondary artifact for Python/Go codegen.

### Non-Goals
- **No key material / signing.** Like `ce-rs`, the SDK does not hold Ed25519 keys. `POST /jobs/:id/settle` and channel receipt *signing-by-the-caller* are the node's job via its API token; the SDK passes through pre-built `payer_sig` hex. (The node signs receipts on `POST /channels/receipt`; the SDK just calls it.)
- **No libp2p / Noise / DHT in the SDK.** Mesh is reached only through the node's HTTP mesh endpoints. Mesh-first is preserved because the node does the routing.
- **No app policy** (capability minting, org logic, exec/sync). Those are apps (rdev, swarm) that may *use* this SDK. The SDK only forwards opaque `grant` tokens.
- No bundled UI components. This is a client library, not a component kit.
- No node-side changes (see §7).

## 2. Architecture

```
┌────────────────────────────────────────────────────────────┐
│ consumers:  web dashboard · notes app · hosting UI · ce-coord-ts │
└───────────────────────────────┬────────────────────────────┘
                                │ import { CeClient, Amount }
                       ┌────────▼─────────┐
                       │   @ce-net/sdk    │  (this workstream)
                       │  CeClient facade │
                       │  Amount (bigint) │
                       │  SSE AsyncIters  │
                       │  typed errors    │
                       └────────┬─────────┘
                                │ global fetch (injectable) — HTTP+SSE only
                       ┌────────▼─────────┐
                       │  CE node :8844   │  PRIMITIVES (unchanged)
                       │  HTTP API + SSE  │
                       └────────┬─────────┘
                                │ libp2p /ce/rpc/1 (node-internal)
                          mesh / peers
```

The SDK is a thin transport+ergonomics layer. All authorization, signing, mesh routing, and economy live in the node. The SDK's only "smarts" are: the `Amount` type, the SSE parser, the retry/idempotency policy, the error taxonomy, and token discovery.

### 2.1 Internal module layout

A single `Transport` does fetch+retry+auth+error-mapping. The `CeClient` is a facade composed of **namespace objects** (`ce.jobs`, `ce.channels`, `ce.mesh`, `ce.data`, `ce.names`, `ce.economy`, `ce.streams`) so the surface is discoverable and tree-shakeable, while flat aliases (`ce.status()`, `ce.transfer()`) mirror `ce-rs`'s flat shape for 1:1 familiarity.

## 3. Package layout

New repo `ce-ts/`, published as `@ce-net/sdk`:

```
ce-ts/
├── package.json
├── tsconfig.json
├── tsdown.config.ts            # build → ESM + CJS + d.ts/d.cts
├── README.md                   # quickstart, money model, runtime matrix
├── openapi.yaml                # OpenAPI 3.1 spec (secondary artifact, §9)
├── src/
│   ├── index.ts                # barrel: re-export public surface only
│   ├── client.ts               # CeClient facade + CeClientOptions
│   ├── transport.ts            # fetch wrapper: auth, retry, idempotency, errors
│   ├── amount.ts               # Amount value type (bigint base units)
│   ├── errors.ts               # CeError hierarchy
│   ├── auth.ts                 # token resolution + discoverApiToken()
│   ├── sse.ts                  # fetch+ReadableStream SSE → AsyncIterable
│   ├── hex.ts                  # bytes<->hex helpers (payload_hex, sigs)
│   ├── schemas.ts              # zod/mini schemas for SSE + error envelope
│   ├── types.ts                # hand-written wire + domain types
│   └── api/
│       ├── status.ts           # health, status, bootstrap, beacon, atlas
│       ├── jobs.ts             # bid, job, jobs, settle, kill, mesh-deploy/kill
│       ├── economy.ts          # transfer, history, channels, relay/pay
│       ├── data.ts             # blobs, objects (chunk/reassemble), data/fetch
│       ├── mesh.ts             # send/messages/subscribe/publish/request/reply
│       ├── signals.ts          # signals list/send/stream (CEP-1)
│       ├── names.ts            # names claim/resolve, discovery advertise/find
│       ├── caps.ts             # capabilities revoke/revoked
│       └── streams.ts          # blocks/transactions/signals/messages SSE
├── examples/
│   ├── bid-and-poll.ts
│   ├── transfer-amount.ts
│   ├── stream-blocks.ts        # for-await SSE
│   ├── mesh-request-reply.ts
│   └── upload-object.ts
└── test/
    ├── amount.test.ts
    ├── sse-parser.test.ts
    ├── transport-retry.test.ts
    ├── client.test.ts          # fetch-mock per endpoint
    └── cross-runtime/          # node/bun/deno/workers smoke
```

### 3.1 package.json (load-bearing fields)

```jsonc
{
  "name": "@ce-net/sdk",
  "version": "0.1.0",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts",  "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    },
    "./package.json": "./package.json"
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "dependencies": { "zod": "^4" },            // zod/mini import path only
  "devDependencies": {
    "tsdown": "*", "typescript": "^5.6", "vitest": "*",
    "publint": "*", "@arethetypeswrong/cli": "*", "expect-type": "*"
  },
  "scripts": {
    "build": "tsdown",
    "test": "vitest run",
    "prepublishOnly": "tsdown && publint && attw --pack"
  }
}
```

Build: `tsdown` (Rolldown), target ES2022, emits `index.js` (ESM), `index.cjs`, `index.d.ts`, `index.d.cts`. Browser/Workers consumers get the ESM path automatically. The browser dashboard, notes app, and hosting UI bundle the ESM build via Vite — no separate "browser build" file is needed because the core is Web-API-only; we only mark `package.json#browser` is unnecessary since there are no Node built-ins to swap.

## 4. The `Amount` type (money)

CE money = `u128` base units, `10^18` per credit, decimal strings on the wire. The SDK encodes this as a `bigint`-backed immutable value type mirroring `ce-rs`'s `Amount`. `number` is never used for money anywhere.

```ts
export const CREDIT = 1_000_000_000_000_000_000n; // 10^18 base units

export class Amount {
  /** signed base units, mirrors ce-rs Amount(i128) */
  readonly base: bigint;
  private constructor(base: bigint) { this.base = base; }

  static readonly ZERO: Amount;

  static fromBaseUnits(s: string | bigint): Amount;  // wire form
  static fromCredits(s: string | number | bigint): Amount; // "1.5" → base
  static fromWholeCredits(n: bigint | number): Amount;     // n * CREDIT

  toBaseUnits(): string;   // wire: "1500000000000000000"
  toCredits(): string;     // human: "1.5"  (trims trailing zeros, no float)
  toString(): string;      // "1.5 credits"
  toJSON(): string;        // === toBaseUnits()  — safe in JSON.stringify

  add(o: Amount): Amount;
  sub(o: Amount): Amount;
  cmp(o: Amount): -1 | 0 | 1;
  isZero(): boolean;
  isNegative(): boolean;
}
```

Rules enforced:
- **Raw wire response types keep amount fields as `string`** (`RawNodeStatus.balance: string`). Decoding into the domain type lifts them via `Amount.fromBaseUnits`. A naive `JSON.parse` never coerces an amount to `number`.
- `toJSON()` returns the decimal string, so `JSON.stringify({ amount })` and our request bodies serialize correctly — never a bare `bigint` (which throws).
- `fromCredits` parses up to 18 decimal places with explicit string math (no `parseFloat`), matching `Amount::parse_credits`.
- `toCredits` formats with no float round-trip, matching `Amount::credits()`.

Test: round-trip values `> 2^53` (e.g. supply cap `21e9 * 10^18`) through parse→toBaseUnits and prove byte-equality.

## 5. Client surface (every endpoint, typed, real)

### 5.1 Construction & options

```ts
export interface CeClientOptions {
  baseUrl?: string;                 // default "http://127.0.0.1:8844"
  token?: string | (() => string | undefined)
        | (() => Promise<string | undefined>); // resolved per-request
  fetch?: typeof fetch;             // injectable for Workers/tests/proxy
  timeoutMs?: number;               // default 30_000, per-request override
  maxRetries?: number;             // default 2
  headers?: Record<string, string>; // extra default headers
}

export class CeClient {
  constructor(opts?: CeClientOptions);
  static local(): CeClient;                     // 127.0.0.1:8844, auto token
  static withToken(baseUrl: string, token?: string): CeClient;
}
```

### 5.2 Status / discovery  → `src/api/status.ts`

| SDK | Endpoint | Signature |
|---|---|---|
| `ce.health()` | `GET /health` | `() => Promise<boolean>` |
| `ce.status()` | `GET /status` | `() => Promise<NodeStatus>` |
| `ce.bootstrap()` | `GET /bootstrap` | `() => Promise<{ peers: string[] }>` |
| `ce.beacon()` | `GET /beacon` | `() => Promise<Beacon>` |
| `ce.atlas()` | `GET /atlas` | `() => Promise<AtlasEntry[]>` |

`NodeStatus` includes the full `/status` body: `{ nodeId, height, difficulty, balance: Amount, circulatingSupply: Amount, burnedTotal: Amount, bond: Amount, weight }` (the http-api map's richer shape, a superset of ce-rs's `NodeStatus`).

### 5.3 Jobs  → `src/api/jobs.ts`

| SDK | Endpoint | Signature |
|---|---|---|
| `ce.jobs.list()` / `ce.jobs()` | `GET /jobs` | `() => Promise<Job[]>` |
| `ce.jobs.get(id)` / `ce.job(id)` | `GET /jobs/:id` | `(id: string) => Promise<Job>` |
| `ce.jobs.bid(spec)` / `ce.bid(spec)` | `POST /jobs/bid` | `(spec: BidSpec) => Promise<string>` |
| `ce.jobs.settle(id, c)` | `POST /jobs/:id/settle` | `(id, { cost: Amount, payerSig: string }) => Promise<void>` |
| `ce.jobs.kill(id)` / `ce.kill(id)` | `DELETE /jobs/:id` | `(id: string) => Promise<void>` |
| `ce.jobs.meshDeploy(...)` | `POST /mesh-deploy` | `(nodeId, spec: BidSpec, grant?) => Promise<string>` |
| `ce.jobs.meshDeployWasm(...)` | `POST /mesh-deploy` | `(opts: WasmDeploy) => Promise<Deployment>` |
| `ce.jobs.meshKill(...)` | `POST /mesh-kill` | `(nodeId, jobId, grant?) => Promise<void>` |

> Note: the SDK **does** wrap `settle` (ce-rs skips it) but only forwards a caller-built `payerSig` hex string + `Amount` cost. It performs no signing. `BidSpec.bid` is `Amount`; serialized to a base-unit string. `cmd`/`env` map directly. `WasmDeploy` carries `wasmModule` (64-hex), `wasmEntry`, `inputs[]`, `hintMultiaddr?`.

### 5.4 Economy  → `src/api/economy.ts`

| SDK | Endpoint | Signature |
|---|---|---|
| `ce.transfer(to, amount)` | `POST /transfer` | `(to: string, amount: Amount) => Promise<string>` |
| `ce.history(nodeId)` | `GET /history/:node_id` | `(nodeId: string) => Promise<NodeHistory>` |
| `ce.channels.list()` / `ce.channels()` | `GET /channels` | `() => Promise<Channel[]>` |
| `ce.channels.open(...)` | `POST /channels/open` | `(host, capacity: Amount, expiryHeight?) => Promise<string>` |
| `ce.channels.signReceipt(...)` | `POST /channels/receipt` | `(channelId, host, cumulative: Amount) => Promise<Receipt>` |
| `ce.channels.close(...)` | `POST /channels/:id/close` | `(channelId, cumulative: Amount, payerSig) => Promise<void>` |
| `ce.channels.expire(id)` | `POST /channels/:id/expire` | `(channelId) => Promise<void>` |
| `ce.payRelay(...)` | `POST /relay/pay` | `(relay, channelId, cumulative: Amount) => Promise<void>` |

`Channel`, `Receipt`, `NodeHistory` mirror `ce-rs` with `Amount` for money fields and camelCase keys (`expiryHeight`, `jobsHosted`, `firstHeight`). `NodeHistory` gets `isNewcomer()` and `deliveredWork()` as helper functions on the returned object (or free functions in `index.ts`).

### 5.5 Data layer  → `src/api/data.ts`

| SDK | Endpoint | Signature |
|---|---|---|
| `ce.data.putBlob(bytes)` | `POST /blobs` | `(bytes: Uint8Array) => Promise<string>` |
| `ce.data.getBlob(hash)` | `GET /blobs/:hash` | `(hash: string) => Promise<Uint8Array>` |
| `ce.data.putObject(bytes)` | `POST /blobs` (chunked) | `(bytes: Uint8Array) => Promise<string>` |
| `ce.data.getObject(cid)` | `GET /blobs/:hash` (chunked) | `(cid: string) => Promise<Uint8Array>` |
| `ce.data.fetchChunkPaid(...)` | `POST /data/fetch` | `(provider, cid, channelId, cumulative: Amount) => Promise<Uint8Array>` |

Plus pure helpers mirroring `ce-rs::data`, runtime-agnostic via `crypto.subtle.digest('SHA-256')`:

```ts
export async function cid(bytes: Uint8Array): Promise<string>;          // sha256 hex
export function chunkObject(bytes: Uint8Array, size?: number):
  Promise<{ manifest: Manifest; chunks: [string, Uint8Array][] }>;
export async function reassemble(
  manifest: Manifest,
  fetch: (cid: string) => Promise<Uint8Array>): Promise<Uint8Array>;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
```

`Manifest = { kind: 'ce-object-v1'; chunkSize: number; totalSize: number; chunks: string[] }`. Note `cid()` is async here (Web SubtleCrypto is async) — a deliberate, documented difference from ce-rs's sync `cid()`.

### 5.6 Mesh messaging  → `src/api/mesh.ts`

| SDK | Endpoint | Signature |
|---|---|---|
| `ce.mesh.send(to, topic, payload)` | `POST /mesh/send` | `(to, topic, payload: Uint8Array) => Promise<void>` |
| `ce.mesh.messages()` | `GET /mesh/messages` | `() => Promise<AppMessage[]>` |
| `ce.mesh.subscribe(topic)` | `POST /mesh/subscribe` | `(topic) => Promise<void>` |
| `ce.mesh.publish(topic, payload)` | `POST /mesh/publish` | `(topic, payload: Uint8Array) => Promise<void>` |
| `ce.mesh.request(...)` | `POST /mesh/request` | `(to, topic, payload, timeoutMs?) => Promise<Uint8Array>` |
| `ce.mesh.reply(token, payload)` | `POST /mesh/reply` | `(token: number, payload: Uint8Array) => Promise<void>` |
| `ce.mesh.streamMessages()` | `GET /mesh/messages/stream` | `(opts?) => AsyncIterable<AppMessage>` |

The SDK accepts/returns `Uint8Array` for payloads and handles `payload_hex` encoding internally via `src/hex.ts`. `AppMessage` exposes `payload(): Uint8Array` (decoded) plus raw `payloadHex`, `from`, `topic`, `replyToken?`. This is the canonical channel for **new device-to-device app features** (over AppRequest+stream), per CE's architecture rule.

### 5.7 Signals (CEP-1)  → `src/api/signals.ts`

| SDK | Endpoint | Signature |
|---|---|---|
| `ce.signals.list()` | `GET /signals` | `() => Promise<Signal[]>` |
| `ce.signals.send(...)` | `POST /signals/send` | `(opts: SendSignal) => Promise<{ id: string; nonce: number }>` |
| `ce.signals.stream()` | `GET /signals/stream` | `(opts?) => AsyncIterable<Signal>` |

`SendSignal = { to: string \| 'broadcast'; capabilities: string[]; payload?: Uint8Array; burnTxIdHex?: string }`. `Signal` mirrors the SSE body `{ from, to, capabilities, payloadHex, burnProof, nonce, id }`. (ce-rs skips signals; the SDK includes them because the web dashboard's network view renders them.)

### 5.8 Names & discovery  → `src/api/names.ts`

| SDK | Endpoint | Signature |
|---|---|---|
| `ce.names.claim(name)` | `POST /names/claim` | `(name) => Promise<void>` |
| `ce.names.resolve(name)` | `GET /names/:name` | `(name) => Promise<string \| null>` |
| `ce.discovery.advertise(service)` | `POST /discovery/advertise` | `(service) => Promise<void>` |
| `ce.discovery.find(service)` | `GET /discovery/find/:service` | `(service) => Promise<string[]>` |

### 5.9 Capabilities  → `src/api/caps.ts`

| SDK | Endpoint | Signature |
|---|---|---|
| `ce.capabilities.revoke(nonce)` | `POST /capabilities/revoke` | `(nonce: number) => Promise<string>` |
| `ce.capabilities.revoked()` | `GET /capabilities/revoked` | `() => Promise<{ issuer: string; nonce: number }[]>` |

### 5.10 Coordination / control

| SDK | Endpoint | Signature |
|---|---|---|
| `ce.chainSave()` | `POST /chain/save` | `() => Promise<{ saved: string }>` |
| `ce.tunnel(...)` | `POST /tunnel` | `(opts: TunnelOpts) => Promise<TunnelResult>` |

`tunnel` is wrapped for completeness (Node-only usefulness; binds 127.0.0.1 on the node host). Documented as node-host-side, not browser.

### 5.11 SSE streams  → `src/api/streams.ts`

All four streams as typed `AsyncIterable`s with a shared `StreamOptions { signal?: AbortSignal; reconnect?: boolean; lastEventId?: string }`:

```ts
ce.streams.blocks(opts?):       AsyncIterable<BlockEvent>;       // GET /blocks/stream
ce.streams.transactions(opts?): AsyncIterable<TxEvent>;          // GET /transactions/stream
ce.streams.signals(opts?):      AsyncIterable<Signal>;           // GET /signals/stream  (alias of ce.signals.stream)
ce.streams.messages(opts?):     AsyncIterable<AppMessage>;       // GET /mesh/messages/stream
```

`BlockEvent = { index, hash, prevHash, timestamp, miner, txCount, nonce }`. `TxEvent = { id, origin, kind: TxKind, amount: Amount }` where `TxKind` is the union `'Transfer'|'UptimeReward'|'JobBid'|'JobSettle'|'JobExpire'|'TrustGrant'|'Heartbeat'`.

## 6. Cross-cutting subsystems

### 6.1 Transport (`transport.ts`)
- Single `request<T>(method, path, { body, auth, idempotent, timeoutMs, signal })`.
- Uses injected `fetch` or global `fetch`. `AbortController` merges per-call `signal` with `timeoutMs`.
- **Auth**: resolves `token` (string \| sync \| async) per request; attaches `Authorization: Bearer <token>` on **all non-GET** requests (matching the node's gating). GETs go unauthenticated. Token never logged.
- **Idempotency**: mutating POSTs that create state (`/transfer`, `/jobs/bid`, `/channels/open`) get an auto `Idempotency-Key: crypto.randomUUID()` header so retried requests are safe; caller can override. (Node tolerates the header even if it ignores it; harmless.)
- **Retry**: only on `429, 408, 5xx, 502, 503, 504, and network errors`; **never** on `400/401/402/403/404`. Exponential backoff with full jitter, honor `Retry-After`, cap at `maxRetries`.

### 6.2 SSE (`sse.ts`)
- `fetch(url, { headers: { Accept: 'text/event-stream', 'Last-Event-ID'? }, signal })`, then `response.body.pipeThrough(new TextDecoderStream())`, buffer by `\n\n`, parse `data:`/`event:`/`id:`.
- Yields parsed+zod-validated objects. Tracks last `id:` for resume.
- On disconnect (and `reconnect !== false`): backoff reconnect sending `Last-Event-ID`. Cancel via `signal`.
- No `EventSource` (can't set auth headers; absent in Node/Workers). Works identically across all five runtimes.

### 6.3 Auth discovery (`auth.ts`)

```ts
export async function discoverApiToken(): Promise<string | undefined>;
```

Resolution order, runtime-aware:
1. **Explicit** `options.token` (highest priority, all runtimes).
2. **`CE_API_TOKEN` env** — Node/Bun/Deno (`process.env` / `Deno.env` / Workers `env` passed in). Browsers skip.
3. **`<data_dir>/api.token` file** — Node/Bun/Deno only, lazy dynamic `import('node:fs')` **behind a runtime guard** so the browser/Workers bundle never references `node:fs` (dynamic import is not statically linked; tree-shaken out of the edge build).
4. **Browser**: no token discovery. Browser callers either (a) use read-only GET endpoints, or (b) supply a `token` callback (e.g. from the ce-hub sidecar / a local proxy). Documented clearly: the browser cannot read `api.token` off disk, by design.

`CeClient.local()` runs `discoverApiToken()` lazily on first authed call.

### 6.4 Error model (`errors.ts`)

```
CeError (base)
 ├─ CeApiError              // HTTP non-2xx; .status, .body, .requestId?
 │   ├─ CeBadRequestError         // 400
 │   ├─ CeAuthError               // 401/403
 │   ├─ CeInsufficientFundsError  // 402  (CE-specific: /jobs/bid, /transfer, /channels/open)
 │   ├─ CeNotFoundError           // 404
 │   ├─ CeRateLimitError          // 429; .retryAfter
 │   ├─ CePeerError               // 502 (mesh RPC peer rejected)
 │   ├─ CeUnavailableError        // 503 (Docker unavailable)
 │   ├─ CeTimeoutError            // 504 (mesh RPC timeout)
 │   └─ CeServerError             // other 5xx
 ├─ CeConnectionError       // network/DNS/abort/timeout
 └─ CeStreamError           // SSE decode/disconnect
```

Bodies are parsed from `{ "error": "..." }`. `instanceof` narrowing is the documented pattern. The 402/502/504 cases are first-class because they're load-bearing in CE flows (bid funding, mesh placement).

## 7. What changes in the node? **Nothing.**

This is pure app/SDK tier. Every endpoint consumed already exists in the http-api map: status, jobs, economy, channels, blobs/data, all `mesh/*`, signals, names, discovery, capabilities, streams, tunnel, chain/save. The SDK invents **no** new endpoints. Mesh-first is preserved because the node owns libp2p routing; the SDK never opens a socket to a peer or stores ip:port. Authorization stays the single capability primitive — the SDK only forwards opaque `grant` base64 strings into `mesh-deploy`/`mesh-kill`/`tunnel`.

The **one** optional, non-blocking node ask (nice-to-have, not required for v0): have the node echo a `Retry-After` header on 503 and a request-id header for log correlation. The SDK works without these.

## 8. Data model (wire ↔ domain)

Two type layers, both hand-written:
- **`Raw*` wire types** — exactly the JSON the node emits, amount fields as `string`, hex as `string`, snake_case keys (`node_id`, `payer_sig`, `payload_hex`). Used only inside `api/*`.
- **Domain types** — camelCase, `Amount` for money, `Uint8Array` for payloads (decoded from hex), `number|null` for optionals. This is the public surface.

Decoders live in each `api/*` module: `toJob(raw): Job`, `toChannel`, etc. Zod/mini validates only **untrusted boundaries** — SSE event payloads and error envelopes — not the happy-path request builders (keeps bundle small + fast).

## 9. OpenAPI + multi-language codegen — recommendation

**Yes: maintain a hand-written `openapi.yaml` (3.1) in this repo as a secondary artifact; keep TS (`@ce-net/sdk`) and Rust (`ce-rs`) hand-written flagships.** Rationale and concrete plan:
- The spec doubles as living docs (can render to / replace `ce/docs/api.md`) and is the single source for generating **Python/Go/Java** clients via **Speakeasy** (OpenAPI-native, air-gappable CLI, free tier fits CE's ~40-endpoint surface).
- Two spec annotations are mandatory so no generator corrupts CE semantics:
  1. All amount fields typed `{ type: string, format: decimal }` — never `number`/`integer` (they exceed 2^53 and must stay strings).
  2. SSE endpoints documented as `text/event-stream`; note that generated clients will need hand-written streaming shims per language (OpenAPI models SSE poorly) — same pattern as this TS SDK's `sse.ts`.
- Do **not** auto-generate the TS SDK from the spec: codegen produces awkward output for the `Amount`/bigint type and the SSE `AsyncIterable`s — the two most CE-specific ergonomics. Hand-writing wins DX here.

The `openapi.yaml` ships in this repo so the SDK and spec stay co-located and reviewed together.

## 10. Example snippets

```ts
import { CeClient, Amount } from '@ce-net/sdk';

const ce = CeClient.local(); // 127.0.0.1:8844, auto-discovers api.token (Node)

// status + money
const s = await ce.status();
console.log(`node ${s.nodeId} @ height ${s.height}, balance ${s.balance.toCredits()}`);

// transfer 1.5 credits — Amount, never a number
await ce.transfer(recipientHex, Amount.fromCredits('1.5'));

// directed deploy on a GPU host found in the atlas
const host = (await ce.atlas()).find(h => h.tags.includes('gpu'));
if (host) {
  const jobId = await ce.jobs.meshDeploy(host.nodeId, {
    image: 'pytorch:latest',
    cmd: ['python', 'train.py'],
    cpuCores: 4, memMb: 16384, durationSecs: 3600,
    bid: Amount.fromWholeCredits(100),
  });
  // poll
  for (;;) {
    const job = await ce.jobs.get(jobId);
    if (job.status === 'running') continue;
    console.log('done:', job.status); break;
  }
}
```

```ts
// SSE: live block feed (works in browser, Node, Workers)
const ctrl = new AbortController();
for await (const blk of ce.streams.blocks({ signal: ctrl.signal })) {
  dashboard.push(blk.index, blk.hash, blk.txCount);
}
```

```ts
// mesh request/reply — the canonical device-to-device app channel
const reply = await ce.mesh.request(peerHex, 'notes/sync', enc(req), 10_000);
const data = dec(reply);
```

```ts
// browser: read-only dashboard, no token; or token via callback
const ce = new CeClient({
  baseUrl: 'http://127.0.0.1:8844',
  token: async () => await fetchTokenFromHubSidecar(), // browser can't read api.token
});
```

## 11. Milestones (see structured list)

## 12. Testing strategy
- **Vitest**, mock at the injected `fetch` seam — one test per endpoint asserting method, path, headers (auth on non-GET only), body shape, and decoded domain object.
- **`Amount`**: round-trip values `> 2^53` (supply cap), `fromCredits`/`toCredits` parity with ce-rs fixtures (shared JSON vectors), `toJSON` in `JSON.stringify`.
- **SSE parser**: feed chunk-split streams (events split across read boundaries — the #1 SSE bug), multi-field events, keep-alive comments, reconnect with `Last-Event-ID`.
- **Retry/transport**: assert no retry on 400/401/402/404, retry+backoff on 429/5xx/network, `Retry-After` honored, idempotency key attached.
- **Error mapping**: each status → correct `CeError` subclass; `{error}` body parsed.
- **Cross-runtime CI**: run suite on Node 20/22, Bun, Deno; `wrangler` build check for Workers; a headless browser smoke (Vitest browser mode) hitting a mock node.
- **Type tests** via `expect-type`; **`publint` + `attw`** gate publish in CI and `prepublishOnly`.
- **Contract test**: optional integration job that boots a real `ce start` ephemeral node and runs a transfer/blob/stream against it (mirrors ce-rs's local test).

## 13. Risks
- See structured risks list.

## Milestones

| Milestone | Deliverable | Effort |
|---|---|---|
| Core transport + Amount + auth | Transport (fetch/retry/idempotency/errors), Amount bigint type with ce-rs parity fixtures, token discovery (env/file/callback, browser-safe via guarded dynamic import), error hierarchy. Status/health/bootstrap/beacon/atlas wrapped. | M |
| Full endpoint coverage (jobs, economy, data, names, caps) | All non-stream endpoints from the http-api map wrapped with Raw->domain decoders: jobs+mesh-deploy/kill+settle, transfer/history/channels/relay, blobs/objects/chunking (SubtleCrypto cid), names/discovery, capabilities, chain/save, tunnel. | L |
| Mesh messaging + SSE streams | mesh send/messages/subscribe/publish/request/reply with Uint8Array<->hex; signals list/send; four SSE AsyncIterables (blocks/transactions/signals/messages) with reconnect + Last-Event-ID; zod/mini validation at stream/error boundaries. | L |
| Build, packaging, publish pipeline | tsdown ESM+CJS+d.ts/d.cts, exports map, sideEffects:false; publint+attw green; cross-runtime CI (Node/Bun/Deno/Workers build + browser smoke); v0.1.0 published to npm. | M |
| OpenAPI 3.1 spec + docs/examples | Hand-written openapi.yaml (amounts as string/decimal, SSE noted), Speakeasy config for Python/Go; README quickstart + money-model docs + runnable examples/; TSDoc on every public symbol. | M |
| Consumer integration | web dashboard, notes app, and hosting UI migrated to import @ce-net/sdk (replacing any ad-hoc fetch). Proves the foundation across all three frontends; feeds back API gaps. | L |


## Risks

- Node API drift: the SDK mirrors a hand-maintained snapshot of the http-api map; if endpoints/fields change without updating the SDK + openapi.yaml together, consumers silently break. Mitigation: co-locate openapi.yaml in this repo, add an optional contract test against a live ce node in CI.
- Browser auth gap: browsers cannot read <data_dir>/api.token, so any mutating call from the browser requires a token callback (hub sidecar / local proxy) or a same-origin authenticated proxy. If frontends assume local.() works in-browser they will hit 401 on writes. Must be documented loudly and handled in the hosting UI design.
- CORS: the node HTTP API may not send CORS headers; browser dashboards calling :8844 cross-origin will be blocked. Either the node must add permissive localhost CORS (a small, arguably-primitive node change) or frontends proxy through their own origin. Flag early to the node workstream.
- SSE robustness across runtimes: ReadableStream/TextDecoderStream behavior and proxy buffering differ (esp. through nginx on the relay and in some Workers configs); chunk-boundary and keep-alive handling must be tested per runtime or streams will appear to hang.
- Amount semantics mismatch: ce-rs Amount is i128 (signed) and cid() is sync; the TS Amount is bigint and cid() is async (SubtleCrypto). Shared test vectors are needed to guarantee parse/format parity, and the async-cid difference must be documented to avoid surprising ce-rs porters.
- Idempotency assumption: auto Idempotency-Key only makes retries safe if the node actually dedupes on it; today it likely ignores the header, so a retried /transfer could double-submit. Until the node honors idempotency keys, default maxRetries on mutating money endpoints should be conservative (or 0) to avoid double-spend.
