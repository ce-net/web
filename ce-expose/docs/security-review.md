# ce-expose public ingress — adversarial security review (triage + fixes)

Scope: `src/ingress.rs`, `src/ingress_config.rs` (the `--features ingress` relay-tier front door).
Reviewed against the opt-in, default-deny security model in `docs/public-ingress.md`. All fixes are
confined to the `ce-expose` crate (no `ce/` / relay-service changes). Build + 45 unit tests pass
locally and on the relay (`/opt/build`, release, `--features ingress`).

Verdict legend: **CONFIRMED+FIXED**, **CONFIRMED (known limitation)**, **DISMISSED**.

---

## HIGH

### H1. Relay bridged to `resolve_name()`, never the operator-approved `owner` (name hijack/squat redirect)
**CONFIRMED + FIXED.** `bridge()` resolved the upstream NodeId solely via `client.resolve_name(name)`
and discarded `route.owner` (`let _ = owner;`). A first-come / re-claimable on-chain `NameClaim` (or
DHT poisoning) could redirect public traffic — under the trusted `*.user.ce-net.com` TLS — to a node
the operator never approved.
**Fix:** `resolve_origin(state, name, owner)` now PINS to the approved owner: it requires
`resolve_name(name)` to equal `route.owner` (case-insensitive hex) and otherwise denies with a new
`owner_mismatch` / 502 verdict. The resolution cache stores and re-validates the owner NodeId, so a
mid-TTL owner flip can never be served from cache. `bridge()` bridges to the pinned owner.
`src/ingress.rs` `resolve_origin` (~`:945`), `bridge` (~`:1000`). Subsumes the duplicate findings and
the "resolve cache no owner pinning" low finding.

### H2. Private-endpoint relay gate trusts attacker-supplied `X-CE-Node`; cap is a replayable bearer token
**CONFIRMED (known limitation) + HARDENED.** `ce-cap` has no proof-of-possession (`authorize` only
checks `leaf.audience == requester`), and `X-CE-Node`/`X-CE-Cap` are client-supplied HTTP headers, so
a captured `expose:dial` chain can be replayed. This is an inherent property of bearer capabilities
over an unauthenticated HTTP hop; fixing it *properly* needs per-request proof-of-possession (signed
nonce / mTLS) which is out of this crate's scope (no signing infra at the edge, and `ce-cap` is in
`ce/`).
**What was fixed now:** (a) the relay no longer *pretends* the origin re-checks the caller — see H3;
(b) the relay gate is documented honestly in code (`verify_private_caller` doc) and in
`examples/ingress.toml` as an **early-reject + audit gate, not a confidentiality boundary**;
(c) revocation no longer fails open (H8); (d) a replayed-but-doomed request no longer fans out
unbounded mesh work because the tunnel slot is reserved atomically and every mesh call is
deadline-bounded (H7/M5). **Residual risk:** a leaked private cap is replayable at the relay tier
until PoP lands. The true enforcement is the origin authorizing the relay's own `relay_cap`; private
endpoints should use a TLS-terminating origin for anything truly secret. **Launch-blocking:** add
proof-of-possession (or terminate caller identity over a mutually-authenticated hop) before private
ingress is treated as a real authentication boundary.

### H3. Confused deputy — relay forwarded client-controlled `X-CE-Cap` to the origin as its own cap
**CONFIRMED + FIXED.** `relay_caps` was sourced from the visitor's `x-ce-cap` header and presented to
the origin on every `OpenReq`/`DataReq`. Since the origin gates on `from == relay NodeId`, this lent
the relay's mesh identity to any chain a visitor supplied.
**Fix:** added `EndpointPolicy.relay_cap` / `relay_cap_file` (operator-configured). `bridge()` now sets
`relay_caps = route.relay_cap` and NEVER echoes the client header upstream; the client's `x-ce-cap` is
also stripped from the serialized upstream request. The client header is used ONLY for the relay-side
early-reject gate. `src/ingress_config.rs` (`relay_cap`/`relay_cap_file`, loaded in `parse`),
`src/ingress.rs` `bridge` relay_caps (~`:1015`).

### H4. Slowloris — no header-read or body-read timeout
**CONFIRMED + FIXED.** `axum::serve` was used with stock hyper defaults (no header/body/accept
timeout); the only timeout ran inside the data-pump loop, after the body was already read.
**Fix:** replaced `axum::serve` with a manual `hyper_util` accept loop (`serve_with_limits`) that sets
`http1().header_read_timeout(header_read_timeout_ms)` per connection, bounds the whole connection by a
multiple of `request_timeout_ms`, and imposes a global accept-time concurrency cap (`max_connections`
semaphore — slow connections cannot exhaust the task/socket pool). The entire `handle` (header+body
read + bridge) is additionally wrapped in `tokio::time::timeout(request_timeout_ms)`.
`src/ingress.rs` `serve_with_limits` (~`:510`), `handle` total timeout (~`:600`).

### H5. `max_header_bytes` was dead config
**CONFIRMED + FIXED.** Declared/documented as the header bound but referenced nowhere.
**Fix:** enforced in `authorize_request` step 0.5 — sum header name+value lengths and return **431**
when over `max_header_bytes` (before any further work). `src/ingress.rs` (~`:744`).

### H6. Ceiling checks were check-then-act races (TOCTOU)
**CONFIRMED + FIXED.** `total_tunnels` and `ep_conns` were read-only checks in `authorize_request`; the
increment happened later in `TunnelGuard::acquire`, unconditionally — N concurrent requests could all
pass before any incremented.
**Fix:** `TunnelGuard::try_acquire` is now the admission gate: it reserves the global slot via
`fetch_update` (compare-and-increment against `total_tunnel_ceiling`) and the per-endpoint slot via a
second `fetch_update` against `max_conns`, rolling back the global slot on per-endpoint failure. The
read-only checks are gone; the guard is acquired *as* the gate and released synchronously on drop.
`src/ingress.rs` `TunnelGuard` (~`:840`), `authorize_request` step 6+7.

### H7. Unbounded 16 MiB per-tunnel response buffer × ceiling → relay OOM
**CONFIRMED + FIXED.** `MAX_RESP` was a fixed 16 MiB per tunnel; 256 tunnels ≈ 4 GiB (the whole relay).
**Fix:** added a GLOBAL `resp_budget` semaphore (permits == bytes, default 256 MiB, configurable
`global_response_budget`) — every buffered downstream byte acquires a permit, released on bridge
return, so the SUM of all concurrent tunnels' buffers is bounded regardless of concurrency. The
per-request buffer is also tied to the endpoint `byte_cap` (`per_req_max = min(byte_cap, 16 MiB)`)
instead of a fixed constant the operator cannot lower. `src/ingress.rs` `bridge` (~`:1050`).
(Full response streaming instead of buffering remains a follow-up; the global byte budget makes
buffering safe in the meantime.)

### H8. Revocation fails open during startup / on `revoked()` error
**CONFIRMED + FIXED.** `revoked` started empty and only updated on `Ok`; a cap already revoked on-chain
was honored until the first successful refresh (and during sustained `revoked()` failure).
**Fix:** added `revoked_ready: AtomicBool`. `verify_private_caller` denies private endpoints with
**503 `not_ready`** until the first successful fetch. On refresh error the last-known set is kept
(never cleared) and a warning is logged; `revoked_ready` never flips back off.
`src/ingress.rs` refresh loop (~`:430`), `verify_private_caller` (~`:800`).

### H9. Attacker-controlled `X-Forwarded-For` → unbounded `ip_buckets` growth + per-IP limit evasion
**CONFIRMED + FIXED.**
- *Unbounded map:* `ip_buckets` was a never-evicted `HashMap`. Replaced with `BoundedIpBuckets`
  (`max_ip_buckets`, default 100k): when full it evicts an idle (refilled-to-full) bucket, and if none
  is idle it **fails closed** (treats the request as rate-limited). `src/ingress.rs` `BoundedIpBuckets`.
- *XFF spoofing:* `client_ip` now (1) prefers a single-value `CF-Connecting-IP` from a trusted peer,
  (2) otherwise takes the **right-most untrusted** XFF entry (peeling trusted hops), robust to an
  attacker *prepending* forged left entries, and (3) aggregates IPv6 sources to `ipv6_rate_prefix`
  (default /64) so one allocation cannot mint unlimited identities. A startup **warning** fires when
  `trusted_proxy_cidr` is loopback-only, instructing the operator that the proxy must set an
  authoritative client IP. `src/ingress.rs` `client_ip`, `rate_key`, `state_trusted_is_loopback_only`.
  **Residual:** correctness still depends on the fronting proxy setting an authoritative header; this
  is documented in `examples/ingress.toml` and emitted as a startup warning.

---

## MEDIUM

### M1. Duplicate `Content-Length` / verbatim `Host` / absolute-URI passthrough (request smuggling/desync)
**CONFIRMED + FIXED.** `serialize_http_request` copied every non-hop-by-hop header (including the
client's `content-length` and `host`) and then appended its own `Content-Length`, producing CL.CL
desync; `Host` was forwarded verbatim (vhost confusion); absolute-form targets passed through.
**Fix:** `content-length`, `transfer-encoding`, `te`, `trailer`, and `host` are added to the strip
set; exactly one relay-computed `Content-Length` is emitted; a single canonical `Host`
(`<name>.user.ce-net.com`) is set; `request_target` rejects absolute/authority/asterisk-form and any
CR/LF in the target. `src/ingress.rs` `serialize_http_request` / `request_target` (~`:1200`).

### M2. CRLF header-injection into the reconstructed upstream request
**CONFIRMED + FIXED.** Header values were emitted unescaped; any value that survived `to_str()` but
carried CR/LF would split the upstream request.
**Fix:** the copy loop now drops any header whose name or value contains `\r`/`\n`. (A full hyper-client
encoder remains a possible future hardening, but the explicit reject closes the injection primitive.)
`src/ingress.rs` `serialize_http_request`.

### M3. Hardcoded 30s mesh timeout ignored `request_timeout_ms`; OPEN before the deadline check
**CONFIRMED + FIXED.** `mesh_json` hardcoded `30_000` ms and `OPEN` ran before the loop deadline check,
so a stalled origin pinned a request (and its tunnel slot) for 30 s regardless of the configured total.
**Fix:** `mesh_json` takes a `budget: Duration` derived from `min(idle_timeout, remaining total
deadline)`; the kill switch + deadline are checked BEFORE `OPEN`; OPEN/DATA/CLOSE are all
deadline-bounded. `src/ingress.rs` `mesh_json`, `bridge` (`call_budget`).

### M4. `byte_cap` pre-check bypassable (lazy `ByteCap` init) + wrong mid-stream accounting
**CONFIRMED + FIXED.** The `ByteCap` entry was created lazily on first data frame, so the pre-bridge
check found nothing until a request had already flowed; the live add used
`down_hex.len()/2` as a byte proxy.
**Fix:** a `ByteCap` is seeded for EVERY configured route at startup (pre-check is authoritative); the
live add counts `pushed + decoded_down_len` exactly once each. `src/ingress.rs` `serve` (ep_bytes
seed), `bridge` (live add).

### M5. Public endpoints = unauthenticated reflector/amplifier toward origins
**CONFIRMED (mitigated).** Public endpoints skip relay caller auth by design. Amplification is now
bounded: the tunnel slot is reserved atomically *before* mesh work (H6), every mesh call is
deadline-bounded so a stalled origin frees the slot promptly (M3), the kill switch + total deadline are
checked before OPEN, and per-endpoint `rps`/`max_conns`/`byte_cap` plus the global ceilings cap fan-out.
**Residual / launch-blocking:** the strongest control here is the on-chain `ExposeBond` (economic
attribution/slashing) specified in `docs/public-ingress.md §6` — NOT implemented in `ce/`. A funded,
bonded owner per public route must exist before enabling a real public route.

### M6. IDN/punycode/homoglyph bypass of the anti-phishing substring filter
**CONFIRMED + FIXED.** `parse_host_name` lowercased ASCII only; a Unicode confusable (`pаypal`) or its
`xn--` punycode form sailed past the lexical `blocked_substrings` check.
**Fix:** `parse_host_name` now rejects, before route lookup, any first-label byte that is non-ASCII or
not strict LDH (`a-z0-9-`), and any `xn--` prefix. `src/ingress.rs` `parse_host_name`. Test:
`host_parsing_rejects_idn_and_punycode`.

### M7. Origin response headers passed through (info-leak / response-splitting surface)
**CONFIRMED + PARTIALLY FIXED.** `upstream_to_response` forwarded all but a small strip set.
**Fix:** added `content-length` (avoid double-framing), `server`, and `x-powered-by` to the strip set,
keeping `set-cookie` stripped and `X-Robots-Tag: noindex` added. A full response-header allowlist
(Location/CSP/CORS sanitization) is noted as a follow-up; the origin's own service remains the trust
boundary for its response content, isolated under `*.user.ce-net.com`. `src/ingress.rs`
`upstream_to_response`.

---

## LOW

### L1. `TunnelGuard` released the per-endpoint slot on a detached task (lag/leak)
**CONFIRMED + FIXED.** `ep_conns` is now `HashMap<String, AtomicU32>` and `Drop` decrements
synchronously (no `tokio::spawn`), so the conn ceiling cannot lag or leak. `src/ingress.rs`.

### L2. Kill switch used `Ordering::Relaxed` and `exists()` (fails open on FS error)
**CONFIRMED + FIXED.** Flag store/load now `SeqCst`; `is_killed` uses `fs::metadata` and treats any
non-`NotFound` error as **killed** (fail closed). `src/ingress.rs` `KillSwitch`.

### L3. Abuse log recorded origin-internal detail (localhost port / OS error) via `reason`
**CONFIRMED + FIXED.** Origin-supplied reasons are passed through `scrub_origin_reason` before logging
(drops `127.0.0.1:<port>` and raw io text, collapses to a coarse hint, truncates). The owner NodeId is
retained intentionally for accountability. `src/ingress.rs` `scrub_origin_reason`.

### L4. Config read once at startup; no per-endpoint runtime disable
**CONFIRMED (known limitation).** There is still no SIGHUP/watched-file reload; a single abusive route
is pulled via `approved = false` + restart, or the global kill file. Documented as a follow-up; the
global kill file remains the immediate, bootstrap-safe lever. Not fixed (a reload mechanism is a
feature, not a vuln, and the global kill switch satisfies the launch-blocking control).

---

## DISMISSED / NON-ISSUES

- **"Origin re-checks the caller" being false (sub-claim of H2):** correct that it was misleading; fixed
  by H3 (relay presents its own cap) + honest documentation, not by a separate change.
- **Mixed-family CIDR / `client_ip` core logic:** the trusted-peer gating logic was already correct and
  tested; only the XFF-direction and unbounded-map aspects were real (H9).
- Several findings are duplicates emitted across multiple review passes (owner-pinning ×3, X-CE-Node
  spoof ×3, ip_buckets ×3, detached-decrement ×2, CL.CL ×2, max_header_bytes ×2). Each underlying issue
  is addressed once above.

---

## Residual risks — what must still pass before enabling a real public route

1. **Private-endpoint proof-of-possession (H2).** Until the relay verifies a signed challenge bound to
   `X-CE-Node` (or terminates caller identity over a mutually-authenticated hop), a leaked private cap
   is replayable at the relay tier. Treat private ingress as origin-enforced + relay-early-reject only;
   use a TLS-terminating origin for secrets.
2. **On-chain `ExposeBond` (M5, `docs/public-ingress.md §6`).** Economic attribution/slashing for public
   owners is specified for the node team but NOT implemented in `ce/`. A funded, bonded, attributable
   owner per public route is required before public exposure is economically safe.
3. **Fronting-proxy XFF hygiene (H9).** The relay now uses right-most-untrusted XFF / CF-Connecting-IP
   and warns on loopback-only trust, but the operator MUST configure nginx/Cloudflare to set an
   authoritative client IP (overwrite, not append) for per-IP limiting to hold.
4. **Response-header allowlist (M7) and full response streaming (H7)** are follow-ups; current code is
   memory-safe via the global byte budget but still buffers responses.
5. **Dedicated review sign-off** of every `docs/public-ingress.md §3` threat (the §4 checklist item that
   remains open) before the first public endpoint resolves.

Default-deny, the kill switch, the rate limiters, and the cap-gate ordering were re-verified after these
edits (kill switch first per request and re-checked before/within bridge; unknown name → 404 before any
mesh work; ceilings reserved atomically as the admission gate; private endpoints fail closed until the
revoked set is loaded).
