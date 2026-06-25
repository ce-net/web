# Mesh-Native Apps Plan

Status: PROPOSED — awaiting owner approval before any code changes.
Grounded in: `ce-rs/src/lib.rs` (SDK), `ce-node/src/{api.rs,lib.rs}`, `ce-mesh/src/lib.rs` (substrate, all IMPLEMENTED + tested), and the three apps `ce-auth`, `ce-watch`, `ce-cast`, plus `ce-hub` and `web/ce-app`.

---

## 1. Principle

CE apps talk to **each other over the mesh**, never over stored `ip:port` or localhost-HTTP shared-secret hops.

- **Service-to-service** = libp2p `AppRequest` / `AppReply` (sync request→reply), pub/sub (fan-out), or directed `send_message` (one-way command). Every directed message arrives tagged with a **Noise-authenticated sender NodeId** (`ce-node/src/lib.rs:1322-1324,1351-1353`), which replaces every localhost-trust and bearer-token cheat.
- **Addressing** is strictly the 64-hex **NodeId**, resolved from a free-form **service name** on the DHT (`find_service`) or a mined **name** (`resolve_name`). Topic is a routing/namespace string inside the message, never part of addressing. No `ip:port` is ever stored.
- **Browser frontends** are the only HTTP surface. `ce-app` registers an app identity and **exposes only its frontend** at `https://<appId>.ce-net.com/` (and `ce-net.com/apps/<appId>/`). The browser hits the app's own HTTP frontend; that frontend (or its co-located backend) is the **mesh edge** that performs the libp2p hop. Browsers never speak libp2p.
- **Apps do not embed a node.** Each backend service runs a co-located `ce` node and drives it via `ce-rs` over `http://127.0.0.1:8844`. The node holds the `Swarm` and performs the actual mesh hop. No node-side work is required — the mesh endpoints already exist end to end.

---

## 2. The canonical pattern

### Request → Reply (synchronous, one mesh round trip)

**Requester app A** (knows only a service name):

```rust
let auth = ce.find_service("ce-auth").await?;          // GET /discovery/find/ce-auth -> Vec<NodeId hex>
let node = auth.first().ok_or(Unreachable)?;            // cache it; re-resolve on miss
let reply = ce.request(node, "ce-auth/verify",          // POST /mesh/request, blocks on /ce/rpc/1
                       &serde_json::to_vec(&req)?, 5000).await?;  // timeout_ms -> Unreachable
```

**Responder app B** (advertise + inbox loop):

```rust
ce.advertise_service("ce-auth").await?;                 // at boot AND periodically (records expire)
let mut stream = ce.messages_stream().await?;           // GET /mesh/messages/stream (reliable SSE)
while let Some(msg) = stream.next().await {
    if msg.topic != "ce-auth/verify" { continue; }
    // AUTHORIZE: CE proved msg.from is the sender NodeId; the app decides if it may call.
    let resp = run_verify(&msg.payload_hex);            // existing logic, unchanged
    if let Some(tok) = msg.reply_token {
        ce.reply(tok, &serde_json::to_vec(&resp)?).await?;  // POST /mesh/reply -> same open channel
    }
}
```

`reply_token` is the node-managed RPC correlation id — the app **never hand-rolls request IDs**. Default timeout 30s; we pass explicit `timeout_ms`.

### Pub/sub (fan-out telemetry / flags, no reply)

Publisher: `ce.publish("ce-watch/flags", &bytes)` (auto-subscribes, node signs it). Subscriber: `ce.subscribe("ce-watch/flags")` once, then filter inbox by topic. Messages are signed → subscribers verify authorship.

### One-way directed command (fire-and-forget, authorized sender)

`ce.send_message(node, "ce-watch/flags", &bytes)` — use when only one trusted publisher may send; receiver checks `msg.from == <expected NodeId>`.

### Reference diagram (text)

```
 Browser ──HTTPS──> App-A frontend (axum console / ce-app static)
                          │  (in-process ce-rs SDK)
                          ▼
                    App-A local ce node  ──libp2p /ce/rpc/1──>  App-B local ce node
                    (http://127.0.0.1:8844)   AppRequest{from,topic,payload}     │
                                                                                 ▼
                                              App-B inbox loop (SSE) → authorize by from → reply(token)
                          ▲                                                      │
                          └──────────────── AppReply over the SAME channel ◀─────┘
```

Topic convention: `"<app>/<verb>"` — `ce-auth/verify`, `ce-auth/secret`, `ce-watch/flags`. Always app-prefixed to avoid collisions in the shared inbox. Treat `GET /mesh/messages` (snapshot ring) as **debug-only**; the SSE stream is the reliable path.

---

## 3. `ce-app`'s role

`ce-app` is the **frontend register/host/expose** tool. Its current shape is correct — keep it.

- **Register / id:** the app id is DERIVED `<project>-<nodeprefix>` from the one identity (`bin/ce-app.mjs:399-427`), collision-free per identity, no central registry. First signed `PUT /apps/<id>/index.html` claims `app.owner` (`ce-hub/src/main.rs:1350-1354`); signatures ARE verified (`verify_signed`, `main.rs:2070`).
- **Expose frontend:** dual origin (`<id>.ce-net.com` via nginx wildcard rewrite `deploy/nginx.conf:181,209-210`, and `ce-net.com/apps/<id>/`), SPA fallback, slugs (`resolve_slug`), custom domains (`/_host`). Already solved.

**Changes to `ce-app` (small):**
1. Add explicit `ce-app register` / `ce-app id` that performs the first signed config PUT, so ownership is **claimed deliberately**, not as a side effect of the first file upload.
2. Fix `web/ce-app/README.md:259-265` — it falsely claims the live hub ignores the `x-ce-*` signature headers; the hub verifies them (`ce-hub/src/main.rs:2070-2106`, `store_app_file:1303-1306`).
3. (Optional, defer) Document a "mesh service" contract: the same app id advertises a libp2p service so a frontend and the backend it talks to share one identity/address, with the hub strictly a WSS gateway. Not required for the refactor below; flagged for the owner.

`ce-app` itself does **not** perform mesh hops — it deploys frontend bytes. The mesh edge is each app's own backend node.

---

## 4. Per-app refactor

### ce-auth (responder for `verify` + `secret`)
- **Becomes a mesh app:** run a co-located `ce` node; at boot call `advertise_service("ce-auth")` (or `claim_name("ce-auth")` for a stable name) and re-advertise periodically; run an inbox loop on `messages_stream()`.
- **`ce-auth/verify`:** match topic, run the EXISTING `verify()` logic (`ce-auth/src/main.rs:200-243`, unchanged), `reply(token, {ok,role,deviceId})`. Authorize the calling app by `msg.from` NodeId (and/or a ce-cap grant).
- **`ce-auth/secret` (server-to-server only):** the `secret` handler (`ce-auth/src/main.rs:468-489`) gains a mesh path that authorizes by caller NodeId + ce-cap instead of the browser device-challenge. **Only used if a backend needs a secret.**
- **Stays HTTP:** `/challenge`, `/verify`, `/secret`, console (`main.rs:491-502`) keep their axum surface — their direct clients are **browsers** (device-signed `x-ce-*` headers). Frontend deployed via `ce-app`.

### ce-watch (responder for flags; requester for verify; console)
- **Drop the localhost hop entirely.** Run a co-located node, `advertise_service("ce-watch")`, inbox loop.
- **Flag ingest (`main.rs:217-236`):** replace the `/ingest` HTTP handler + `x-ce-watch-token` gate (`store.append`) with an inbox drain on topic `ce-watch/flags` → `store.append`. **The shared secret `CE_WATCH_INGEST_TOKEN` is deleted.** Authorize by `msg.from == <ce-hub NodeId>` (directed send) — see below.
- **Verify call:** add a `MeshVerifier` implementing the existing `Verifier` trait (`ce-watch/src/auth.rs:107-111`) beside `HttpVerifier` (`auth.rs:116-163`), switched by env. It resolves `ce-auth` once, `request(ce_auth, "ce-auth/verify", body, 5000)`. Map timeout/err → `VerifyError::Unreachable` (`auth.rs:100-103`) — fail-closed preserved. Same `VerifyRequest`/`VerifyResponse` JSON (`auth.rs:74-92`), mesh transport.
- **Stays HTTP:** console + `/admin/*` data routes (browser device-signed); `/admin/challenge` proxy may stay HTTP or proxy over mesh — owner's call. Frontend deployable via `ce-app`.

### ce-hub → ce-watch flag PUSH
- Replace `push_flag_to_watch` (`ce-hub/src/main.rs:2431-2467`, raw HTTP/1.1 + `x-ce-watch-token`) with a mesh send. **Recommended: directed `send_message(ce_watch_node, "ce-watch/flags", serde_json::to_vec(&ev)?)`** — flags must come only from the trusted hub, so the verified `from` NodeId cleanly replaces the bearer token. (Pub/sub is the alternative if multiple dashboards should subscribe, but loses the single-publisher guarantee.) Stays fire-and-forget; detection never blocks dispatch (`main.rs:1101`). ce-hub runs/attaches a node and resolves ce-watch via `find_service("ce-watch")`.

### ce-cast (verify / secret)
- The CURRENT secret consumer is a **browser** (`ce-cast/web/auth.js:18,80-93` → `https://auth.ce-net.com/secret/cast-ingest`). This is a legitimate HTTPS frontend call, **NOT** a service-to-service cheat. **No mesh migration for the browser path.**
- Migrate to mesh request/reply **only if/when** a backend (e.g. `ce-cast-relay`) needs `cast-ingest` without a browser: `request(ce_auth, "ce-auth/secret", {name:"cast-ingest"}, ms)`, authorized by the caller's NodeId + ce-cap. ce-cast studio frontend deployable via `ce-app`.

---

## 5. Migration order + reference app

1. **ce-hub → ce-watch flag PUSH first (reference app).** Smallest blast radius: fire-and-forget, one direction, no reply path, no fail-closed semantics to preserve, and it deletes the `x-ce-watch-token` secret outright. Converting it exercises the WHOLE pattern — run-a-node, `advertise_service`, `find_service`, `send_message`, inbox loop, NodeId-authorize — at the least risk. This is the template both other migrations copy.
2. **ce-watch → ce-auth verify second.** Request/reply with fail-closed semantics; the `Verifier` trait makes `MeshVerifier` a drop-in, env-switched. Adds the reply path + timeout→Unreachable mapping.
3. **ce-cast secret last, and only the backend variant.** Browser path stays HTTPS. No work unless a headless relay appears.

Throughout: every app keeps its axum HTTP server **solely for browser consoles**; every server-to-server hop moves onto the existing SDK calls. No node-side changes.

---

## 6. Phased parallel execution plan

### Phase 0 — Prereqs (serial, blocks all)
- Decide embed-vs-attach a node (Open Q1) and addressing-by-NodeId-vs-name (Open Q2).
- Each backend app gains: a `ce-rs` `CeClient` pointed at `http://127.0.0.1:8844`, a boot-time `advertise_service`/`claim_name` + re-advertise timer, and an inbox loop helper draining `messages_stream()` dispatched by topic.
- **Acceptance:** each app logs "advertised <service>" and "inbox loop up"; `find_service("ce-watch")` from another box returns the watch NodeId.

### Phase 1 — Flag push (reference) [parallelizable after Phase 0]
- ce-hub: replace `push_flag_to_watch` with `send_message(ce_watch, "ce-watch/flags", ...)`.
- ce-watch: inbox drain on `ce-watch/flags` → `store.append`, authorize `from == hub NodeId`; delete `/ingest` + `CE_WATCH_INGEST_TOKEN`.
- **Acceptance:** a flag raised in ce-hub appears in ce-watch's store with NO HTTP between them; `tcpdump`/logs show the libp2p `/ce/rpc/1` (or pub/sub) hop and zero TCP to `:8971`; grep shows `x-ce-watch-token` is gone.

### Phase 2 — Verify call [parallel with Phase 1]
- ce-watch: add `MeshVerifier` (env switch `CE_AUTH_TRANSPORT=mesh`), resolve `ce-auth`, `request("ce-auth/verify")`.
- ce-auth: inbox handler for `ce-auth/verify` calling unchanged `verify()`, `reply(token,...)`.
- **Acceptance:** an admin action in the ce-watch console admits via a mesh `AppRequest` to ce-auth, **no HTTP between the two services**; killing ce-auth → `VerifyError::Unreachable` (fail-closed, request denied); logs/tcpdump show the libp2p hop, not a POST to `:8972`.

### Phase 3 — ce-cast secret (conditional) [after Phase 2]
- Only if a headless relay exists: add `ce-auth/secret` mesh handler (caller-NodeId + ce-cap authorized) and a relay-side `request`.
- **Acceptance:** a backend obtains `cast-ingest` over mesh request/reply; the browser studio path is unchanged and still works over HTTPS.

### Phase 4 — ce-app polish [parallel anytime]
- Add `ce-app register`/`ce-app id`; fix README signature claim.
- **Acceptance:** `ce-app register` performs a signed config PUT that sets `app.owner`; a second identity gets 403 on writes; README no longer claims signatures are ignored.

---

## 7. Open questions (owner decisions)

1. **Embed vs attach a node.** Each backend service must either (a) require a co-located `ce start` and point `ce-rs` at `http://127.0.0.1:8844` (simplest, matches the relay topology today), or (b) embed `ce-node` in-process. **Recommendation: attach (a).** Confirm?
2. **Addressing: `find_service` (DHT, ephemeral, re-advertise) vs `claim_name` (on-chain, stable, mined).** Service discovery needs periodic re-advertise and can briefly return stale/empty; mined names are stable but cost a NameClaim and take a block to take effect. **Recommendation: `find_service` for now, with cached NodeId + re-resolve on miss; reserve `claim_name` for ce-auth (the most-resolved callee).** Agree?
3. **Flag push transport: directed `send_message` (single trusted publisher, NodeId-authorized) vs pub/sub (fan-out to many dashboards).** **Recommendation: directed `send_message`** (flags must come only from the hub). Switch to pub/sub only if you want multiple subscribers. OK?
4. **How much HTTP stays.** Confirm the rule: HTTP survives ONLY as the browser-facing console of each app (device-signed `x-ce-*`), and every server-to-server hop moves to mesh. In particular: does ce-watch's `/admin/challenge` proxy stay HTTP-to-ce-auth, or also move to a mesh request?
