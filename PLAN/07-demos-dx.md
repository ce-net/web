# CE Launch DX: Quickstart, Cookbook, Playground, and Examples Gallery

> Workstream: `demos` · Suggested target path: `ce/docs/demos.md`
> Depends on: ts-sdk

**Summary:** This workstream ships the launch developer experience for CE: a "build an app on CE in 5 minutes" quickstart for both Rust (ce-rs) and TypeScript (@ce-net/sdk), a cookbook of 11 copy-paste recipes each mapped to exact endpoints/SDK calls, a hosted interactive browser playground at ce-net.com/play (running a real in-browser node plus @ce-net/sdk against it), an examples gallery, and per-repo examples/ directories. It is almost entirely SDK/docs/app work: the only node-side change required is a permissive, read-only CORS allowance on GET endpoints (and the SSE streams) so the browser-served playground can call a node, plus one small browser-node bridge in ce-hub to expose a node's HTTP surface to same-origin JS. Everything else composes existing primitives — jobs, blobs, payment channels, mesh request/reply, pubsub, WASM deploy, atlas-guided GPU placement — through the documented HTTP API and the two SDKs. The deliverable doubles as living test coverage: every recipe is an executable example gated in CI against a local node, so the docs cannot drift from the API.

---

# CE Launch DX — Demos, Examples & Developer Onboarding

**Status:** proposed · **Owner:** demos workstream · **Repos touched:** `ce-rs`, `@ce-net/sdk` (new npm pkg, lives in `web/sdk-ts/` or its own `ce-net/sdk-ts` repo), `web/` (playground + docs-site + ce-hub), `ce/docs`, plus example dirs in `swarm`/`rdev`/`ce-coord`. Minimal node change.

---

## 1. Goals / Non-goals

### Goals
1. **5-minute quickstart** that takes a developer from `brew install ce` to a running app that does something real (place a job + stream the block it settles in), in **both** Rust (`ce-rs`) and TypeScript (`@ce-net/sdk`).
2. **A cookbook of 11 copy-paste recipes**, each mapped to the *exact* HTTP endpoint and SDK method, in Rust and TS side-by-side, each one an **executable, CI-tested** file (not prose).
3. **A hosted interactive playground** at `ce-net.com/play` — the existing in-browser node (`web/site/node.html`) + `@ce-net/sdk` loaded in the page, with a recipe picker and a live editor, so a developer runs CE code against a real node *without installing anything*.
4. **An examples gallery** at `docs.ce-net.com/examples` linking every runnable example (swarm, rdev, chat-over-pubsub, blob-pin, channel-faucet, GPU one-shot) with a one-line "what it teaches".
5. **Per-repo `examples/` dirs** that compile/run in CI, so the SDKs ship with proof they work.
6. A **launch checklist** that gates the public announcement: npm publish, README badges, an end-to-end screencast, and "does the playground actually run a job".

### Non-goals
- Not building a new app. Recipes reuse existing primitives and the existing apps (`swarm`, `rdev`).
- Not a docs framework migration. We extend the existing static `web/docs-site/` (no Docusaurus/Nextra rewrite).
- Not shipping `@ce-net/sdk` itself as a *feature* — its API/build is its own workstream (`ts-sdk`). This workstream **consumes** it, contributes the `examples/` dir and the playground, and lists the exact surface the recipes need (which doubles as an acceptance contract for that workstream).
- No new node RPCs for app features. Recipes that mutate host resources (`rdev exec/sync`) are shown via the existing `rdev` app, not new endpoints.

---

## 2. Architecture

Three artifacts, one source of truth:

```
                       ┌─────────────────────────────────────────────┐
                       │  ce/docs/cookbook/   (the recipe registry)   │
                       │  recipes.toml  — id, title, teaches, files,  │
                       │                  endpoints[], sdk_calls[]     │
                       └───────────────┬─────────────────────────────┘
            ┌──────────────────────────┼──────────────────────────────┐
            ▼                          ▼                               ▼
  ce-rs/examples/<id>.rs     sdk-ts examples/<id>.ts        web/docs-site/cookbook/<id>.html
  (compiled + run in CI       (tsx-run + run in CI            (rendered from the same .rs/.ts
   against a local node)       against a local node)           source via include; no copy-paste drift)
                                                                       │
                                                                       ▼
                                                      web/site/play.html  (playground)
                                                      loads @ce-net/sdk + talks to the
                                                      in-browser node (node.html engine)
```

**Single source of truth = the executable example files.** The HTML cookbook pages *include* the actual `.rs`/`.ts` source (build-time `<!--#include-->` or a tiny generator), so a doc can never show code that doesn't compile. `recipes.toml` is the index that CI, the gallery, and the playground all read.

### Why a registry file
`ce/docs/cookbook/recipes.toml` is the manifest every other tool reads:
```toml
[[recipe]]
id          = "place-job"
title       = "Place a job and wait for it to settle"
teaches     = "jobs/bid, polling job status, transactions/stream"
endpoints   = ["POST /jobs/bid", "GET /jobs/:id", "GET /transactions/stream"]
rs_calls    = ["CeClient::bid", "CeClient::job"]
ts_calls    = ["client.jobs.bid", "client.jobs.get", "client.transactions.stream"]
rs_file     = "ce-rs/examples/place_job.rs"
ts_file     = "sdk-ts/examples/place-job.ts"
needs       = ["node"]            # node | docker | two-nodes | gpu-host | channel-host
playground  = true               # can it run in the browser playground?
```

A tiny `xtask` (`ce-rs/xtask` or a `scripts/cookbook.mjs`) validates: every `rs_file`/`ts_file` exists, every endpoint string appears in `ce/docs/api.md`, and every `rs_calls`/`ts_calls` symbol exists in the SDK. This is the anti-drift guard.

### What changes in the node (and only this)
CE-the-node is primitives-only and **stays that way**. The playground is browser-served JS calling a node's HTTP API, which means two real constraints:

1. **CORS on read-only GETs + SSE streams.** Today the API has no CORS headers, so a page at `https://ce-net.com` cannot `fetch('http://127.0.0.1:8844/status')` or open `/blocks/stream`. **Change:** add a `tower-http::cors::CorsLayer` to the axum router that allows `GET` (and `OPTIONS` preflight) from any origin on the **unauthenticated read-only** routes only (`/health`, `/status`, `/atlas`, `/beacon`, `/jobs`, `/jobs/:id`, `/channels`, `/history/:id`, `/names/:name`, `/discovery/find/:s`, `/blobs/:hash`, `/signals`, all `*/stream`). Mutating routes stay same-origin/token-gated (no CORS = browser blocks cross-origin POST, which is the desired safety default — the token never leaves the machine). This is ~15 lines in `ce-node`, behind a `--cors` flag (default on for `localhost`/`127.0.0.1` binds, opt-in otherwise). **Justification:** it's a transport policy on existing primitive endpoints, not a new feature or RPC. Documented in `ce/docs/api.md`.

2. **Browser-node HTTP bridge (in `ce-hub`/`node.html`, NOT the node).** The in-browser node already runs in WASM and joins the mesh. To let playground recipes call it "as if" it were a local node, `node.html` exposes a `window.__ceNode` object implementing the same method surface `@ce-net/sdk` expects (status, atlas, blobs, mesh request/publish, deploy-wasm). `@ce-net/sdk` accepts an injected transport (`new CeClient({ transport: window.__ceNode })`) instead of a `baseUrl`. **No node change** — this is app/SDK glue. The browser node is the "node" for the playground; recipes needing a *second* node (mesh request/reply) pair the browser node with a hosted demo node behind `ce-net.com/hub`.

Everything else is pure SDK + docs + static HTML.

---

## 3. The 5-minute quickstart

Two parallel tracks, same shape, same payoff. Lives at `docs.ce-net.com/quickstart` and as `QUICKSTART.md` in `ce-rs` and the TS SDK repo.

### 3.1 Rust track (`ce-rs`)
```
# 1. Run a node (60s — it mines credits while you read)
brew install ce-net/ce/ce && ce start &

# 2. Scaffold
cargo new hello-ce && cd hello-ce
cargo add ce-rs --git https://github.com/ce-net/ce-rs
cargo add tokio --features full
cargo add anyhow
```
```rust
// src/main.rs — "place a job, watch the chain accept its settlement"
use ce_rs::{CeClient, BidSpec, Amount};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ce = CeClient::local();                       // GET /status token auto-discovered
    let me = ce.status().await?;
    println!("node {} · height {} · balance {}", me.node_id, me.height, me.balance);

    // Broadcast a tiny job; any host with capacity may take it.
    let job_id = ce.bid(&BidSpec {
        image: "alpine:latest".into(),
        cmd: vec!["echo".into(), "hello from CE".into()],
        cpu_cores: 1, mem_mb: 64, duration_secs: 30,
        bid: Amount::from_credits(1),
    }).await?;                                          // POST /jobs/bid
    println!("placed job {job_id}");

    loop {
        let job = ce.job(&job_id).await?;              // GET /jobs/:id
        println!("  status: {}", job.status);
        if matches!(job.status.as_str(), "settled" | "failed") { break; }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Ok(())
}
```
`cargo run` → prints status, the job id, and watches it through to `settled`. (If no Docker host is on the local mesh, the quickstart's appendix shows `ce start` with Docker so the local node self-hosts the job.)

### 3.2 TypeScript track (`@ce-net/sdk`)
```
npm create ce-app@latest hello-ce      # scaffolds package.json + index.ts + README (see §7)
cd hello-ce && npm i
```
```ts
// index.ts — same flow as Rust, using the bigint-safe Amount type
import { CeClient, Amount } from "@ce-net/sdk";

const ce = new CeClient({ baseUrl: "http://127.0.0.1:8844" }); // token from $CE_API_TOKEN

const me = await ce.status();
console.log(`node ${me.nodeId} · height ${me.height} · balance ${me.balance.toCredits()}`);

const { jobId } = await ce.jobs.bid({
  image: "alpine:latest",
  cmd: ["echo", "hello from CE"],
  cpuCores: 1, memMb: 64, durationSecs: 30,
  bid: Amount.fromCredits("1"),                  // → "1000000000000000000" on the wire
});
console.log(`placed job ${jobId}`);

for (;;) {
  const job = await ce.jobs.get(jobId);
  console.log(`  status: ${job.status}`);
  if (job.status === "settled" || job.status === "failed") break;
  await new Promise(r => setTimeout(r, 2000));
}
```

### 3.3 Zero-install track (playground)
The same TS snippet runs at `ce-net.com/play?recipe=place-job` with no install — against the in-browser node. The "5 minutes" promise has a 0-minute on-ramp.

---

## 4. The cookbook — 11 recipes

Each recipe = one `.rs` file + one `.ts` file + one `recipes.toml` entry + a rendered HTML page. Every one is run in CI against a local node (see §9). Endpoints/methods below are the **real** surfaces from `ce/docs/api.md` and the ce-rs map.

| # | id | Teaches | Endpoint(s) | ce-rs call(s) | @ce-net/sdk call(s) | needs | playground |
|---|----|---------|-------------|---------------|---------------------|-------|------------|
| 1 | `place-job` | bid → poll → settle lifecycle | `POST /jobs/bid`, `GET /jobs/:id` | `bid`, `job` | `jobs.bid`, `jobs.get` | docker | yes (no-docker variant: mesh-deploy to demo host) |
| 2 | `stream-blocks` | SSE consumption, typed async iter | `GET /blocks/stream` | *(raw SSE; ce-rs SSE planned — show `reqwest` stream)* | `blocks.stream()` `for await` | node | yes |
| 3 | `stream-txns` | watch the economy live | `GET /transactions/stream` | raw SSE | `transactions.stream()` | node | yes |
| 4 | `blob-roundtrip` | content-addressed store/fetch | `POST /blobs`, `GET /blobs/:hash` | `put_blob`, `get_blob` | `blobs.put`, `blobs.get` | node | yes |
| 5 | `big-object` | chunked object + manifest CID | `POST /blobs`×N, `GET /blobs/:hash`×N | `put_object`, `get_object` | `objects.put`, `objects.get` | node | yes |
| 6 | `transfer-credits` | money model, base-unit strings | `POST /transfer` | `transfer` | `transfer` | node | no (needs token; demo read-only) |
| 7 | `payment-channel` | open → receipt → close micropayments | `POST /channels/open`, `POST /channels/receipt`, `POST /channels/:id/close` | `channel_open`, `sign_receipt`, `channel_close` | `channels.open`, `channels.signReceipt`, `channels.close` | channel-host | no |
| 8 | `mesh-rpc` | request/reply between two nodes | `POST /mesh/request`, `GET /mesh/messages`, `POST /mesh/reply` | `request`, `messages`, `reply` | `mesh.request`, `mesh.messages`, `mesh.reply` | two-nodes | yes (browser ↔ demo node) |
| 9 | `chat-pubsub` | tiny chat over gossip pubsub | `POST /mesh/subscribe`, `POST /mesh/publish`, `GET /mesh/messages/stream` | `subscribe`, `publish`, `messages` | `mesh.subscribe`, `mesh.publish`, `mesh.messages.stream()` | two-nodes | yes |
| 10 | `wasm-task` | deploy a WASM module by CID | `POST /blobs`, `POST /mesh-deploy` | `put_object`, `mesh_deploy_wasm` | `objects.put`, `mesh.deployWasm` | node | yes (uses ce-hub demo-wasm) |
| 11 | `gpu-oneshot` | atlas-guided GPU host selection | `GET /atlas`, `GET /history/:id`, `POST /mesh-deploy` | `atlas`, `history`, `mesh_deploy` | `atlas`, `history`, `mesh.deploy` | gpu-host | no |

Bonus (12th, "graduation"): `discover-and-name` — `claim_name` + `advertise_service` + `find_service` + `resolve_name`, showing DHT discovery (`POST /names/claim`, `POST /discovery/advertise`, `GET /discovery/find/:s`, `GET /names/:name`).

### 4.1 Representative recipe bodies (load-bearing exact calls)

**Recipe 2 — `stream-blocks` (TS, the async-iterable pattern the SDK must support):**
```ts
import { CeClient } from "@ce-net/sdk";
const ce = new CeClient({ baseUrl: "http://127.0.0.1:8844" });
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 30_000);
for await (const block of ce.blocks.stream({ signal: ctrl.signal })) {
  // block: { index, hash, prevHash, timestamp, miner, txCount, nonce }
  console.log(`#${block.index} ${block.hash.slice(0,12)}… ${block.txCount} txs`);
}
```

**Recipe 4 — `blob-roundtrip` (Rust):**
```rust
let ce = CeClient::local();
let hash = ce.put_blob(b"hello world".to_vec()).await?;   // POST /blobs -> 64-hex
let back = ce.get_blob(&hash).await?;                      // GET /blobs/:hash (mesh fallback)
assert_eq!(back, b"hello world");
println!("blob {hash}");
```

**Recipe 7 — `payment-channel` (the only recipe that needs a payer-signed receipt; both SDKs wrap it):**
```rust
// payer node:
let chan = ce.channel_open(host_id, Amount::from_credits(10), 0).await?; // POST /channels/open
let r1 = ce.sign_receipt(&chan, host_id, Amount::from_credits(3)).await?; // POST /channels/receipt
// ...send r1.payer_sig to host out-of-band (here: /mesh/send)...
// host node redeems the highest receipt:
host_ce.channel_close(&chan, r1.cumulative, &r1.payer_sig).await?;        // POST /channels/:id/close
```

**Recipe 8 — `mesh-rpc` (server side, the canonical reply-loop apps reuse):**
```ts
await ce.mesh.subscribe("ping");                 // ensure inbox receives
for await (const m of ce.mesh.messages.stream()) {
  if (m.topic === "ping" && m.replyToken != null) {
    await ce.mesh.reply(m.replyToken, new TextEncoder().encode("pong"));
  }
}
// client side, on the other node:
const reply = await ce.mesh.request(serverNodeId, "ping", new Uint8Array(), { timeoutMs: 5000 });
console.log(new TextDecoder().decode(reply)); // "pong"
```

**Recipe 10 — `wasm-task`:**
```rust
let module = std::fs::read("count_primes.wasm")?;
let cid = ce.put_object(&module).await?;                         // chunked into the blob store
let dep = ce.mesh_deploy_wasm(host_id, &cid, "count_primes",
            1, 128, 60, Amount::from_credits(2), None, &[]).await?; // POST /mesh-deploy (wasm_module)
println!("job {} output {:?}", dep.job_id, dep.output);
```

**Recipe 11 — `gpu-oneshot` (atlas + reputation ranking, the swarm pattern distilled):**
```rust
let host = ce.atlas().await?.into_iter()
    .filter(|h| h.has_tag("gpu"))
    .max_by_key(|h| { /* rank by delivered_work via ce.history */ 0 })  // see swarm::select_hosts
    .ok_or_else(|| anyhow::anyhow!("no GPU host on the mesh"))?;
let job = ce.mesh_deploy(&host.node_id, &BidSpec {
    image: "pytorch/pytorch:latest".into(),
    cmd: vec!["python".into(), "-c".into(), "import torch; print(torch.cuda.is_available())".into()],
    cpu_cores: 4, mem_mb: 16384, duration_secs: 600, bid: Amount::from_credits(50),
}, None).await?;
```

---

## 5. Hosted interactive playground (`ce-net.com/play`)

A new static page `web/site/play.html` (sibling of `node.html`, `network.html`), same design system (`--grad` cyan→blue, Fraunces/Hanken/JetBrains Mono from the existing pages).

### Layout
- **Left:** recipe picker (list rendered from `recipes.toml` filtered to `playground = true`).
- **Center:** Monaco/CodeMirror editor preloaded with the recipe's `.ts` source.
- **Right:** live output console (mirrors the `node.html` log style) + a node status strip (the same `dot`/`nid`/atlas tiles `node.html` already renders).
- **Top:** a toggle "run against: [in-browser node] | [my local node :8844]". The second option uses the CORS change from §2 to hit the developer's own `ce start`.

### How it executes user code
The page bundles `@ce-net/sdk` (the real npm artifact, ESM, loaded from `esm.sh`/a pinned `/play/sdk.js`). It constructs `new CeClient({ transport: window.__ceNode })` (browser node) or `new CeClient({ baseUrl: "http://127.0.0.1:8844" })` (local). User code runs in a `Worker` with the SDK injected, so a runaway loop can't freeze the page; output is `postMessage`'d to the console pane. No server-side eval — everything is the user's browser hitting either their own node or the in-browser node.

### What it proves
A first-time visitor clicks "place-job", hits Run, and watches a real WASM job execute on the in-browser node, plus the block stream tick. That is the single most persuasive artifact for launch — "I ran code on a decentralized compute mesh from a phone, no install."

### Composition with primitives
- `stream-blocks`/`stream-txns`/`chat-pubsub`: SSE/pubsub over the browser node's mesh connection (already live via ce-hub rendezvous).
- `mesh-rpc`/`chat-pubsub` second peer: a long-lived **demo responder node** behind `ce-net.com/hub` (reuses ce-hub) that echoes on topic `ce/playground/echo`. No new node code — it's a `ce-rs` app running the §4.1 reply-loop.
- `wasm-task`: reuses `web/ce-hub/demo-wasm` (`count_primes`) — already built and deployed.

---

## 6. Examples gallery + per-repo `examples/`

### Gallery (`docs.ce-net.com/examples`)
A static grid page (generated from `recipes.toml` + an `apps.toml`) with cards:
| Card | Source | Teaches |
|---|---|---|
| 11 cookbook recipes | `ce-rs/examples`, `sdk-ts/examples` | the primitives |
| **swarm** | `swarm/` | scatter/gather across N hosts, reputation ranking |
| **rdev** | `rdev/` | exec + continuous folder mirror over AppRequest + ce-cap |
| **ce-coord** | `ce-coord/` | typed streams + replicated maps on the mesh |
| **chat** (new tiny example app) | `sdk-ts/examples/chat-app/` | full pubsub chat, ~80 lines, the "wow" |
| **blob-pin** (new) | `ce-rs/examples/` | pin/replicate a file across the mesh |
| **faucet** (new) | `sdk-ts/examples/` | a credit faucet web page (transfer) |

Each card: title, one-line "teaches", language badge, "▶ Open in playground" (if applicable) or "↗ View source".

### Per-repo `examples/` (the executable proof)
- `ce-rs/examples/` — already has `object_roundtrip.rs`; add: `place_job.rs`, `stream_blocks.rs`, `blob_roundtrip.rs`, `payment_channel.rs`, `mesh_rpc.rs`, `wasm_task.rs`, `gpu_oneshot.rs`, `transfer.rs`, `discover_and_name.rs`. Each is a `cargo run --example <id>` target.
- `sdk-ts/examples/` — the TS mirror, each `tsx examples/<id>.ts`. Plus `chat-app/` and `faucet/` as small folders with their own `package.json` for "real app" feel.
- `swarm/`, `rdev/`, `ce-coord/` — add a top-of-README "▶ Try it" block and ensure each has a `examples/` or a documented `cargo run -- <demo args>` invocation that CI exercises.

---

## 7. `npm create ce-app` scaffolder

A tiny package (`create-ce-app`) so the TS quickstart is one command. It writes:
```
hello-ce/
├── package.json     # deps: @ce-net/sdk; scripts: { dev: "tsx index.ts" }; type: module
├── tsconfig.json    # ES2022, strict, moduleResolution: bundler
├── index.ts         # the §3.2 place-job snippet
├── .env.example     # CE_API_TOKEN= (read from <data_dir>/api.token)
└── README.md        # links to quickstart + cookbook + playground
```
Flags: `--recipe <id>` seeds `index.ts` from any cookbook recipe; `--template chat|faucet` for the bigger examples. Implemented as ~120 lines (no framework — `prompts` + file copy), published to npm. Mirrors `cargo new` ergonomics for the Rust side (no scaffolder needed there; `cargo add ce-rs` is enough).

---

## 8. Data model

This workstream introduces **no on-chain or wire types**. Its only data structures are build/docs metadata:

- **`recipes.toml`** (registry): `id, title, teaches, endpoints[], rs_calls[], ts_calls[], rs_file, ts_file, needs[], playground: bool`.
- **`apps.toml`** (gallery): `name, repo, teaches, language, lang_badge, playground_url?`.
- **Playground transport contract** (`window.__ceNode`): the subset of `CeClient` methods the in-browser node implements — `status, atlas, beacon, putBlob, getBlob, putObject, getObject, meshRequest, meshReply, meshSubscribe, meshPublish, meshMessagesStream, deployWasm, blocksStream, transactionsStream`. This is the acceptance contract between this workstream and the browser-node (`web/ce-hub`) workstream.

All money in examples uses the existing `Amount` type (Rust `i128` base units; TS `bigint` base units), strings on the wire — examples are written to **demonstrate** the no-floats rule (e.g. `transfer-credits` has a comment block explaining why `"1000000000000000000"` not `1`).

---

## 9. Testing strategy

The whole point: **docs that cannot lie.** Three CI gates.

1. **`cookbook-lint` (fast, every PR):** the `xtask`/`scripts/cookbook.mjs` validates `recipes.toml` against reality — every referenced file exists, every `endpoints[]` string is present in `ce/docs/api.md`, every `rs_calls`/`ts_calls` symbol resolves in the SDK source (grep/`syn` for Rust, `ts-morph` for TS). Fails the build on drift.

2. **`examples-run` (integration, on PRs touching SDK/examples + nightly):** a GitHub Actions job that:
   - builds `ce`, runs `ce start` with Docker available on the runner,
   - waits for `GET /health`,
   - for each recipe with `needs ⊆ available`: runs the `.rs` (`cargo run --example`) and `.ts` (`tsx`) version, asserting exit 0 and an expected stdout marker.
   - `two-nodes` recipes start a second `ce start --data-dir /tmp/n2 --api-port 8845` and connect them over local mesh/mDNS.
   - `gpu-host`/`channel-host` recipes are `--ignored`-style (run only when a labeled self-hosted GPU runner is present; otherwise smoke-compiled).
   This reuses the existing E2E harness patterns in `~/ce-net/e2e/` and `e2e-local.sh`.

3. **`playground-smoke` (Playwright, nightly):** headless-load `ce-net.com/play`, wait for the in-browser node to reach `running`, select `place-job`, click Run, assert the console shows a settled job and a streamed block. Catches CORS regressions and SDK/transport breaks.

Unit-level: SSE parser tests (chunk-split boundaries), `Amount` precision tests (`> 2^53`) live in the `ts-sdk` workstream but are *exercised* by recipes 2/3/6 here.

---

## 10. Milestones

| # | Name | Deliverable | Effort |
|---|------|-------------|--------|
| M1 | Registry + Rust examples | `recipes.toml`, `cookbook-lint` xtask, all 11 `ce-rs/examples/*.rs` compiling + `examples-run` CI green for `needs=node/docker` recipes | M |
| M2 | Node CORS + bridge contract | `CorsLayer` on read-only GET/SSE routes behind `--cors` (default-on for localhost), documented in `api.md`; `window.__ceNode` transport contract spec finalized with browser-node workstream | S |
| M3 | TS examples + scaffolder | `sdk-ts/examples/*.ts` mirror, `chat-app/`+`faucet/`, `create-ce-app` published to npm, TS half of `examples-run` green | M |
| M4 | Quickstart + cookbook docs | `docs.ce-net.com/quickstart` (both tracks), 11 rendered cookbook pages (source-included from example files), gallery page from `recipes.toml`/`apps.toml` | M |
| M5 | Playground | `web/site/play.html` with recipe picker, Worker-sandboxed editor, in-browser-node + local-node transports, demo responder node behind ce-hub, `playground-smoke` Playwright test | L |
| M6 | Launch polish | README badges (npm/crates/CI/docs) on `ce-rs`+`sdk-ts`, 3–4 min screencast (install → quickstart → playground), launch checklist signed off | M |

Total ≈ one focused build wave; M1/M2 unblock everything and can run in parallel.

---

## 11. Launch checklist (gates the announcement)

- [ ] `@ce-net/sdk` published to npm (public, `latest` tag), `create-ce-app` published.
- [ ] `ce-rs` tagged + `crates.io` publish (or git-dep documented; pick one and badge it).
- [ ] README badges on both SDKs: npm/crates version, CI status, docs link, license, "▶ Playground".
- [ ] `examples-run` CI green on `main` for all `node/docker/two-nodes` recipes.
- [ ] `cookbook-lint` green (zero doc/API drift).
- [ ] `ce-net.com/play` live, `playground-smoke` green, runs a job from a phone.
- [ ] `docs.ce-net.com/quickstart`, `/cookbook`, `/examples` live and linked from the landing nav.
- [ ] 3–4 min screencast (install → 5-min quickstart → "now do it with zero install in the playground"), embedded on landing + linked in both READMEs.
- [ ] `ce/docs/demos.md` (this doc) committed; `CLAUDE.md`/`roadmap.md` "Done" section updated.
- [ ] Money-model callout present in every transfer/channel recipe (no-floats, base-unit strings).

---

## 12. How it composes CE primitives / boundary statement

- **100% of recipes** use only documented primitive endpoints (jobs, blobs, transfer, channels, mesh request/publish/reply, mesh-deploy incl. WASM, atlas, history, names/discovery) via the two SDKs. No recipe invents an endpoint or type.
- **Host-mutating features** (`exec`, file `sync`) are shown via the **`rdev` app**, not new node calls — preserving the primitives-vs-apps boundary.
- **Authorization** in recipes that cross machines (mesh-deploy/kill with a `grant`, payment-channel close) uses the existing capability-token (`grant`) and payer-signature flows; no allowlists.
- **The only node change** is a transport-policy CORS layer on read-only GET/SSE routes (§2.1). The playground "node" is the in-browser WASM node plus an app-tier `window.__ceNode` bridge (§2.2) — no new node RPCs.

This keeps CE-the-node primitives-only while delivering the launch DX entirely at the SDK/app/docs tier.


## Milestones

| Milestone | Deliverable | Effort |
|---|---|---|
| M1 Registry + Rust examples | recipes.toml + cookbook-lint xtask + all 11 ce-rs/examples/*.rs compiling and running green in examples-run CI for node/docker recipes | M |
| M2 Node CORS + browser-node bridge contract | tower-http CorsLayer on read-only GET/SSE routes behind --cors (default-on for localhost), documented in api.md; window.__ceNode transport contract finalized | S |
| M3 TS examples + scaffolder | sdk-ts/examples/*.ts mirror plus chat-app and faucet, create-ce-app published to npm, TS half of examples-run green | M |
| M4 Quickstart + cookbook + gallery docs | docs.ce-net.com quickstart (Rust+TS), 11 source-included cookbook pages, examples gallery rendered from recipes.toml/apps.toml | M |
| M5 Interactive playground | web/site/play.html with recipe picker, Worker-sandboxed editor, in-browser-node + local-node transports, demo responder node, Playwright playground-smoke test | L |
| M6 Launch polish | npm/crates publish, README badges, 3-4 min screencast, signed-off launch checklist | M |


## Risks

- ce-rs has no SSE wrapper yet, so recipes 2/3 (stream-blocks/txns) and the mesh message stream must either ship raw reqwest-stream code in the Rust examples or block on the ts-sdk/ce-rs adding SSE — pick raw-stream now to avoid coupling.
- Playground depends on the node CORS change AND the browser-node window.__ceNode bridge landing; if either slips, the zero-install demo degrades to local-node-only, weakening the launch's strongest artifact.
- docker/gpu/two-nodes recipes need real infrastructure on CI runners; without a GPU self-hosted runner, gpu-oneshot is compile-only and the launch must not claim it is end-to-end verified.
- Source-include rendering (HTML cookbook pulling from .rs/.ts files) adds a build step to the static docs-site; if skipped, copy-pasted snippets will drift from the executable files — defeating the anti-drift design.
- @ce-net/sdk method names used throughout (jobs.bid, blocks.stream, mesh.request, objects.put, Amount.fromCredits) are assumed; they must be ratified as the acceptance contract with the ts-sdk workstream or the recipes/playground break on rename.
- Browser sandboxing of user-entered playground code in a Worker must block network exfiltration of any local-node token; the local-node transport must only ever read the token from the user's own machine, never echo it into editable code.
