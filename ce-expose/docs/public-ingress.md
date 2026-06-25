# Public HTTP/TCP ingress on the CE relay — design + threat model

> Status: **IMPLEMENTED for HTTP, behind the `ingress` feature, in this crate** (`src/ingress.rs` +
> `src/ingress_config.rs`, CLI `ce-expose ingress`). It is the one relay-tier piece that turns a
> private, capability-gated mesh tunnel into a public `https://<name>.user.ce-net.com` URL. It is
> **NOT a node primitive**: it ships only with `--features ingress` (the default build never pulls
> axum) and is meant to run ONLY on the hardened public relay, bound to `127.0.0.1` behind
> nginx/Cloudflare. TCP ingress (Spectrum) and `pay_relay` egress metering remain design-only.
> The §4 launch-blocking controls are implemented and unit-tested; this document remains the input to
> the dedicated security-review sign-off.

## Security model: the edge is an opt-in, bonded, rate-limited *capability* — nodes are mesh-only by default

The whole point of this feature is what it does **not** do by default. CE nodes are **mesh-only and
never internet-exposed**: running `ce start` accepts zero inbound public HTTP, ever. The relay is the
single hardened public node. Public reachability is an **opt-in, default-DENY capability**, gated on
*three independent* conditions, all of which must hold:

1. **The origin opts in** by running `ce-expose http --name <n>` (claims the name, runs the agent).
2. **A valid capability chain** authorizes the dial — the origin's own `expose:dial` gate
   (`session::gate`) on *every* mesh frame, plus, for private endpoints, the relay's own early
   `ce-cap` check.
3. **The relay operator's policy permits it** — the name must have an `approved = true` route in the
   operator-curated `ingress.toml`. No route -> `404`. This is the operator allowlist.

The edge is therefore **uniform-as-capability** (any node with a public IP *can* run the ingress
binary), never **uniform-as-exposure** (no node is *automatically* exposed). An empty/missing config
exposes zero routes. Disabling ingress (kill switch) never touches bootstrap/circuit-relay.

This is defense in depth: even a compromised or buggy relay cannot reach an origin's localhost,
because the origin independently authorizes every frame against its own key. The relay's cap check is
an early-reject optimization and an audit point, not the sole gate.

---

## 1. Scope and the hard boundary

ce-expose has two halves:

| Half | Where it runs | Trust surface | Status |
|---|---|---|---|
| **Private mesh exposure** | origin agent + consumer (this crate) | capability-gated peer-to-peer over the existing CE tunnel/stream primitive | **shipped** (no node change) |
| **Public ingress** | the Hetzner `ce-relay` binary only | the *open internet* hitting `ce-net.com` | **design only (this doc)** |

The boundary is non-negotiable and is the whole point of separating the two:

- **CE nodes stay primitives-only.** No generic CE node gains a "public ingress" RPC. Public ingress
  is a feature of *one operational role* — the relay we run on Hetzner — gated behind that role,
  exactly like the relay's existing circuit-relay / bootstrap responsibilities. A laptop running
  `ce start` never accepts inbound public HTTP.
- **Authorization is still `ce-cap`.** The relay does not invent a new trust model. For private
  endpoints it verifies the same signed, attenuating `expose:dial` chain the origin agent verifies.
  For public endpoints the "capability" is, by definition, *open to the world* — which is precisely
  why public endpoints are the dangerous case and get most of the controls below.
- **Money stays integer base units.** Any egress metering uses CE payment channels with base-unit
  decimal-string amounts (`pay_relay`), never floats.

Everything the `ce-expose` crate ships today (origin agent, consumer, session pump, the gate) works
**node-to-node with zero relay involvement**. The relay ingress is an *optional public front door*,
not a dependency of the private feature.

---

## 2. What the feature does

An axum handler added to the `ce-relay` binary that, on an inbound request to
`https://<name>.ce-net.com` (Cloudflare terminates TLS, origin speaks HTTP on :80 as today):

1. Parse `<name>` from the `Host` header.
2. Resolve `<name> → NodeId` via the chain (`resolve_name`), with a short in-memory cache.
3. Look up the endpoint's published policy (public, or private with a `dial_cap_root`).
4. For a **private** endpoint, verify the caller's presented capability chain against the policy
   (the caller supplies it via a header or a signed cookie); deny with `403` otherwise.
5. Open a mesh stream to that NodeId's ce-expose origin agent (over the existing
   circuit-relay/DCUtR path — no stored ip:port) and **pipe** the HTTP request/response bytes over
   it, applying the per-endpoint limits in §4.
6. Optionally meter egress bytes and require a `pay_relay` channel receipt to keep streaming.

```
public internet ──TLS──> Cloudflare ──:80──> ce-relay ingress ──mesh stream──> origin agent ──> localhost:port
                                                  │
                                          name→NodeId resolve, cap check,
                                          rate limit, byte cap, kill switch
```

The origin side is unchanged: it is the same `ce-expose` agent that today accepts a mesh session and
forwards to `localhost`. The relay is just *another consumer* of that agent — one that fronts the
public internet. (For raw TCP endpoints the same applies over Cloudflare Spectrum / a dedicated TCP
listener; HTTP is the priority.)

### Endpoint policy record

```text
Endpoint {
  name:          String,        // claimed on-chain; resolves to NodeId
  owner:         NodeId,
  kind:          Http | Tcp,
  visibility:    Public | Private { dial_cap_root: NodeId },
  // operator-set ceilings (see §4); defaults applied if the owner omits them
  rps_limit:     u32,
  conn_limit:    u32,
  byte_cap:      u64,           // base-unit-style integer, bytes
}
```

The relay rebuilds this table from `resolve_name` plus a small signed "endpoint manifest" the owner
publishes (so the owner — not a random caller — sets visibility and asks for limits, which the
operator may only *tighten*).

---

## 3. Threat model

Adversaries, capabilities, and the controls that contain them.

### 3.1 Phishing / malware hosting on `ce-net.com`
**The single biggest risk.** A `*.ce-net.com` subdomain inherits the domain's reputation; an
attacker who can stand up `paypal-login.ce-net.com` pointing at their own laptop gets free TLS and a
trusted-looking host for credential phishing or malware delivery. This jeopardizes the entire domain
(blocklisting, registrar action, Cloudflare takedown).

Controls:
- **Name allowlist / reservation** for sensitive substrings (`paypal`, `login`, `bank`, `apple`,
  `wallet`, brand terms) — refuse to resolve them.
- **No wildcard trust transfer to content.** Serve public endpoints from an *isolated* subdomain
  with its own reputation, e.g. `*.tunnel.ce-net.com` or a per-endpoint random label
  (`a7f3...tunnel.ce-net.com`), never bare `<name>.ce-net.com`, so a bad endpoint cannot borrow the
  apex's reputation.
- **Interstitial / `X-Robots-Tag: noindex`** on public tunnels; abuse-report link in a response
  header; keep tunnels out of search indexes.
- **Owner accountability:** publishing a public endpoint requires a funded, bonded NodeId so abuse
  is attributable and slashable, not free and anonymous.

### 3.2 DDoS / resource exhaustion of the relay
The relay is a single Hetzner cpx22 (4 vCPU / 4 GB). A flood of requests to a tunnel — or to
thousands of tunnels — can exhaust CPU, sockets, memory, or the mesh-stream pool, taking down the
relay's *primary* job (bootstrap + circuit relay for the whole network).

Controls (see §4 for the concrete dials): global and per-IP request rate limits, per-endpoint RPS and
concurrent-connection caps, a hard cap on total simultaneous tunnels, bounded per-stream buffers,
aggressive idle timeouts, and a **kill switch** that disables all public ingress while leaving
bootstrap/relay untouched.

### 3.3 SSRF / origin abuse via the tunnel
The relay opens connections *to mesh nodes*, not to arbitrary URLs, so classic SSRF-to-internal-metadata
is limited. But a malicious endpoint owner could point an endpoint at a sensitive service on *their
own* box and trick a victim into hitting it through the trusted domain (a confused-deputy where the
victim's browser, not the relay, is the deputy).

Controls: the relay never adds ambient authority (no cookies/headers of its own forwarded upstream);
responses carry no `Set-Cookie` for the apex; the relay is a dumb byte pipe and strips hop-by-hop
headers; public endpoints are clearly labeled as user content (§3.1 isolated subdomain).

### 3.4 Capability bypass on private endpoints
For a *private* endpoint the relay is the enforcement point for `expose:dial`. A bug there exposes
the origin's localhost to the world. The relay must run the **exact same `ce-cap::authorize`** path
as the origin agent — and the origin agent **must also independently authorize** every mesh session
(defense in depth: even if the relay is compromised or buggy, the origin still checks the cap). The
relay's cap check is an early-reject optimization and an audit point, not the sole gate.

### 3.5 Eavesdropping / MITM
Cloudflare terminates TLS; the hop Cloudflare→relay is HTTP on :80 inside the same threat domain as
today's API (already the case for `ce-net.com`). The relay→origin hop is a Noise-encrypted libp2p
stream. The residual exposure is the plaintext window inside the relay process. Document it; for
end-to-end secrecy a TCP/TLS endpoint (relay as opaque byte pipe, origin terminates TLS) is the
stronger mode and should be the recommended one for anything sensitive.

### 3.6 Name squatting / hijack
On-chain `NameClaim` is first-come. An attacker squats desirable names, or races a victim's claim.
This is an existing chain property, not new to ingress, but ingress raises the stakes (a name now
maps to a public URL).

Controls: ingress respects on-chain ownership only; rotation/revocation via the existing
`RevokeCapability` + re-claim flow; operator reservation list (§3.1) for high-value names.

### 3.7 Abuse of egress metering / payment channels
If egress is metered via `pay_relay`, an adversary may try to stream large volumes while
under-paying (stale receipt, channel that expires mid-stream, never opening a channel).

Controls: the relay enforces a rising `cumulative` receipt *before* serving the next byte budget;
streaming halts the instant the receipt falls behind the metered total; a public-but-unpaid endpoint
runs only within the free byte_cap then 402s.

---

## 4. Required controls before launch (the review checklist)

These are launch-blocking. Implemented in `src/ingress.rs` (+ `src/ingress_config.rs`) and
unit-tested; checked off below. Two remain design-only (TCP/Spectrum + `pay_relay` egress metering)
and are explicitly out of HTTP-ingress scope.

- [x] **Global kill switch** — `--kill-switch` flag AND a watched control file
      (`<config dir>/ingress.kill`, override with `--kill-file`); `KillSwitch::is_killed()` is checked
      first, per request, so `touch ingress.kill` disables *all* ingress with no restart while leaving
      bootstrap/circuit-relay fully operational. Test: `kill_switch_flag_and_file`.
- [x] **Per-endpoint caps** — `rps` (token bucket), `max_conns` (concurrent), `byte_cap` (cumulative
      up+down, enforced both pre-bridge and live mid-stream), `idle_timeout_ms`, plus the global
      `max_body_bytes` request-body ceiling (axum `DefaultBodyLimit`). Operator-set; the owner may
      only tighten. Tests: `byte_cap_enforced`, `byte_cap_zero_is_unlimited`, conn-ceiling logic.
- [x] **Global + per-IP rate limits** — independent `global_rps` and `per_ip_rps` token buckets,
      applied before any mesh work so the ingress sheds load before it can touch the relay's primary
      duty. Client IP via `ConnectInfo<SocketAddr>`; honored ONLY from a `trusted_proxy_cidr` peer, via
      the **right-most untrusted `X-Forwarded-For` entry** or single-value `CF-Connecting-IP`
      (append-spoof resistant); IPv6 sources aggregated to `ipv6_rate_prefix` (/64). The per-IP bucket
      map is bounded (`max_ip_buckets`) and evicts idle buckets / fails closed when full, so IP/XFF
      churn cannot exhaust relay memory. Tests: `token_bucket_*`, `client_ip_trusts_xff_only_from_proxy`,
      `bounded_ip_buckets_evicts_and_fails_closed_when_full`, `cidr_membership`.
- [x] **Slowloris / header-flood** — manual `hyper_util` accept loop enforces a per-connection
      `header_read_timeout_ms`, a global accept-time `max_connections` cap, and a whole-`handle`
      `request_timeout_ms` (covers header+body read + bridge); `max_header_bytes` is enforced (431).
- [x] **Total-tunnel ceiling** — `total_tunnel_ceiling` hard cap across all endpoints, enforced via an
      atomic counter + a RAII `TunnelGuard` that can never leak a slot on early return/panic.
- [x] **Name reservation / abuse allowlist** — `blocked_substrings` refuses phishing-y names
      (`login`, `pay`, `bank`, `admin`, `wallet`, `ce-net`, brand terms, ...); served from an isolated
      `*.user.ce-net.com` subdomain (its own reputation, never the apex); `X-Robots-Tag: noindex,
      nofollow` on every response. Tests: `blocked_substrings_match_case_insensitively`,
      `host_parsing_*`.
- [x] **Bonded, attributable owners** — every route carries an `owner` NodeId and an `approved` flag;
      default-deny means an unbonded/unapproved owner has no live route. Private endpoints are gated by
      `ce-cap::authorize` (via `session::gate`) on **both** relay and origin. The on-chain
      `ExposeBond`/slash transaction is specified for the node team in §6 below (NOT implemented in
      `ce/`).
- [ ] **Egress metering** wired to `pay_relay` channel receipts (if charging), with halt-on-stale.
      *Design-only; out of HTTP-ingress scope (free `byte_cap` then refuse is the current behavior).*
- [x] **Structured abuse logging** — exactly one JSON `tracing` line per request (target
      `ce_expose_ingress_abuse`): `ts, endpoint, owner, client_ip, method, host, path_len, bytes_up,
      bytes_down, status, verdict, reason, latency_ms`. Never logs cap secrets or request bodies. The
      fast per-endpoint disable path is `approved = false` + reload, or the global kill file.
- [ ] **Documented in `ce/docs/primitives.md`** as "relay-only ingress, NOT a node primitive." *To be
      added by the node team when the on-chain `ExposeBond` lands; the boundary is restated in §1/§5
      and the security-model section above. (Not editable from this crate.)*
- [ ] **Dedicated security review sign-off** covering every threat in §3, before the first public
      endpoint resolves.

---

## 5. Why it lives on the relay, not the node (restated for the reviewer)

CE's architecture is **primitives-only nodes + apps over the SDK**. A public front door is the
opposite of a primitive: it is opinionated operational policy (which names, which limits, which
abuse rules, who pays). Putting it on the relay binary — a role *we* operate and can patch, rate-
limit, and kill — keeps that policy out of the substrate every user runs. The generic node keeps its
small, auditable surface; the blast radius of an ingress bug is one machine we control, not the
whole network. ce-expose's private half proves the transport and the cap model; the relay ingress is
a thin, heavily-guarded adapter from the public internet onto that proven path — and it ships only
after the §4 checklist is green and the review is signed off.

---

## 6. On-chain `ExposeBond` — specification for the node team (NOT implemented in `ce/`)

The ingress today enforces owner accountability via the **operator-curated allowlist** (`approved =
true` + `owner` NodeId) plus the capability gate. That is sufficient for a single operator-run relay,
but it does not make abuse economically *attributable and slashable*. The following is a spec for the
**node team** to implement in `ce-chain` (it is a node primitive, so it is deliberately NOT built in
this app crate):

**New transaction `ExposeBond`:**

```text
ExposeBond {
  owner:   NodeId,     // bonds itself for the right to publish a public endpoint
  name:    String,     // the claimed on-chain name being bonded (must be owned by `owner`)
  amount:  u128,       // bonded credits, base units (integer; never a float)
  expiry:  u64,        // block height after which the bond may be reclaimed if un-slashed
}
```

- **Lock:** `amount` base units are escrowed from `owner`'s balance (like `JobBid`), keyed by
  `(owner, name)`. The relay treats a route as eligible for `approved = true` only when a live,
  un-slashed `ExposeBond` of at least the operator's minimum covers `(owner, name)`.
- **`SlashExposeBond { name, owner, evidence, fraction }`** — issuable by a configured arbiter root
  (the relay operator's key, or a governance root) on documented abuse (phishing/malware/DDoS sourced
  from the structured abuse log). Burns `fraction` of the bond; the remainder stays locked until
  `expiry`. Slashing is the economic deterrent that makes a `*.user.ce-net.com` endpoint *cost*
  something to abuse.
- **`ReclaimExposeBond { name, owner }`** — after `expiry` and with no pending slash, returns the
  remaining escrow to `owner`.
- **Integration point:** the relay's `ingress_config` `approved` flag becomes *derived* — the route
  is live iff `approved && bond_ok(owner, name)`, where `bond_ok` queries the chain (`/expose/bond/:name`
  HTTP endpoint, mirroring `/names/:name`). Until that endpoint exists, the operator sets `approved`
  by hand after confirming the bond out-of-band.
- **Money rule:** all amounts are integer base units (`1 credit = 10^18`), carried as decimal strings
  over the HTTP API. No floats anywhere.

This keeps the substrate honest: the *mechanism* (bond/slash/reclaim) lives in the node; the *policy*
(minimum bond, which arbiter, which names) stays operator-configurable on the relay.

---

## 7. Operator runbook

**Run the ingress** (on the hardened relay only; bind localhost, front with nginx/Cloudflare):

```bash
ce-expose ingress --listen 127.0.0.1:8855 --config /etc/ce/ingress.toml
# Cloudflare terminates TLS for *.user.ce-net.com -> nginx :80 -> proxy_pass http://127.0.0.1:8855
```

Use a dedicated, isolated subdomain (`*.user.ce-net.com`), **never** the bare apex, so a bad endpoint
cannot borrow `ce-net.com`'s reputation. Every response carries `X-Robots-Tag: noindex, nofollow`.

**Add a route** (default-deny: nothing is reachable until you do this). Edit `ingress.toml`:

```toml
[[endpoint]]
name            = "leif"            # first Host label: leif.user.ce-net.com
owner           = "<64-hex NodeId>" # the bonded, attributable owner
kind            = "http"
visibility      = "public"          # or  visibility = "private" + dial_cap_root = "<64-hex>"
approved        = true              # MUST be true to go live; false stages the route
rps             = 10
max_conns       = 16
byte_cap        = 1073741824        # 0 = unlimited
idle_timeout_ms = 15000
```

Then restart the ingress process (config is read at startup). See `examples/ingress.toml` for a full
annotated template and the `[global]` ceilings (`total_tunnel_ceiling`, `global_rps`, `per_ip_rps`,
`max_body_bytes`, `request_timeout_ms`, `trusted_proxy_cidr`, `blocked_substrings`).

**Private endpoints:** the caller sends `X-CE-Cap: <hex chain>` and `X-CE-Node: <64-hex caller
NodeId>`; the relay runs an EARLY-REJECT check of the chain (ability `expose:dial`, rooted at the
route's `dial_cap_root`) before bridging. Missing/invalid -> `401`/`403`; private endpoints are denied
with `503` until the revoked set has loaded (no fail-open window). **Important:** because `ce-cap` has
no proof-of-possession and `X-CE-Node` is client-supplied, this relay check is a bearer-token / audit
gate, **not** a confidentiality boundary — a leaked cap is replayable until per-request
proof-of-possession lands (see `docs/security-review.md` H2). The origin authorizes the relay's own
`relay_cap` (set per route, never the client header); use a TLS-terminating origin for secrets.

**Relay→origin cap:** set `relay_cap` (or `relay_cap_file`) per endpoint — the relay presents ITS OWN
operator-held `expose:dial` cap to the origin and never forwards the client's `X-CE-Cap` upstream. The
upstream NodeId is PINNED to the route's `owner` (a name-claim hijack resolving elsewhere -> `502
owner_mismatch`).

**Kill switch** (instantly disable ALL ingress; bootstrap/relay untouched):

```bash
touch /etc/ce/ingress.kill      # disables every route within one request, no restart
rm    /etc/ce/ingress.kill      # re-enables
# or start with --kill-switch to boot in the disabled state
```

The kill file defaults to `<config dir>/ingress.kill` (override with `--kill-file`).

**Reading the abuse log:** every request emits one JSON line on tracing target
`ce_expose_ingress_abuse`. To find abusers and act:

```bash
# top source IPs by request volume
journalctl -u ce-ingress | grep ce_expose_ingress_abuse | jq -r .client_ip | sort | uniq -c | sort -rn
# all denials for one endpoint, with the machine verdict + reason
journalctl -u ce-ingress | grep ce_expose_ingress_abuse | jq 'select(.endpoint=="leif" and .status>=400) | {ts,client_ip,verdict,reason,status}'
# bytes served per owner (egress accounting)
journalctl -u ce-ingress | grep ce_expose_ingress_abuse | jq -r '[.owner,.bytes_down]|@tsv' | awk '{a[$1]+=$2} END{for(o in a)print a[o],o}' | sort -rn
```

`verdict` is a stable machine token (`kill_switch`, `no_route`, `blocked_name`, `global_rate`,
`ip_rate`, `ep_rate`, `byte_cap`, `tunnel_ceiling`, `conn_ceiling`, `no_cap`, `cap_denied`,
`unresolvable`, `origin_refused`, `idle_timeout`, `timeout`, `served`, ...). To pull a single abusive
endpoint immediately, set its `approved = false` and restart, or `touch ingress.kill` to stop
everything. The log never contains capability secrets or request/response bodies.
