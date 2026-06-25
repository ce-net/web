# 13 — Secure Phone-on-Mesh: threat model + onboarding plan

Status: DESIGN. Goal: let Leif "work on the phone" (control/monitor CE, drive the
broadcast camera, send mesh requests) **without** (a) the phone becoming an attack vector
against any other device on the mesh, or (b) the mesh compromising the phone.

This doc is grounded in a code read of the live tree (citations are `repo/path:line`).
Where a control depends on code that is *not yet implemented*, it is marked **GAP** and
listed in §9 as a prerequisite — do not rely on it until closed.

---

## 1. The two trust boundaries we must hold

Leif's exact requirement decomposes into two directions:

1. **Phone -> mesh:** a lost / stolen / malware-bearing phone must not be able to harm any
   other device or the ledger. Defense = the phone only ever holds **minimal, attenuated,
   short-lived, audience-bound capabilities** that it cannot amplify or re-delegate broadly,
   plus instant revocation.
2. **Mesh -> phone:** joining must not expose the phone to remote code execution, inbound
   dialing, or job placement. Defense = the phone is **not a full node** and presents **no
   inbound mesh surface** at all.

Both are satisfied by one architectural decision: **the phone is a thin HTTP/SSE client, not
a libp2p mesh node.**

---

## 2. Why a full node on the phone is unsafe (the core finding)

A node "hosts" foreign compute by accepting `JobBid` transactions that are **broadcast on the
public mesh** (gossipsub). The acceptance path is effectively ungated today:

- `--no-mine` only disables the mining loop and the 60s capacity-advertise loop
  (`ce/crates/ce-node/src/lib.rs:511-521`). It does **not** gate job acceptance.
- Every `JobBid` is forwarded to the job manager regardless of mining mode
  (`ce/crates/ce-node/src/lib.rs:964-965`), and `handle_incoming_bid`
  (`ce/crates/ce-node/src/lib.rs:1885-1980`) launches a container for it with the only
  pre-screens being "not self-authored" and "not a duplicate" — **no capability chain, no
  payer allowlist, no resource ceiling pre-check.**
- This is independently recorded as **finding H1** in `PLAN/code-review.md:39-40` (the deploy
  RPC path also ignores the leaf cap's `max_cpu/max_mem/max_credits` caveats).

So a full node on the **public** mesh can be driven to run arbitrary containers by any peer.
Add that iOS cannot run Docker and there is no Rust iOS node build, and "phone as full node"
is both unsafe and impractical.

The *isolation* primitives themselves are sound and worth noting (they protect the **gateway**,
not the phone):
- Docker jobs run `network_mode=none` + cgroup CPU/mem caps, gVisor (`runsc`) if present
  (`ce/crates/ce-container/src/lib.rs:85-93`).
- WASM jobs run in wasmtime with fuel metering, a wall-clock epoch watchdog, and a memory cap
  (`ce/crates/ce-wasm/src/lib.rs:79-185`); no imports on the pure-compute path.
The weakness is the **acceptance layer**, not the sandbox.

---

## 3. Architecture: phone = thin client, laptop/relay = gateway

```
  PHONE (iOS)                         GATEWAY NODE (laptop or a dedicated relay node)
  ┌────────────────────┐  HTTPS/SSE   ┌───────────────────────────────┐      libp2p (Noise)
  │ @ce-net/sdk (ce-ts)│─────────────▶│ ce start  (the ONLY mesh peer) │◀────▶ rest of mesh
  │ no libp2p          │   cap in     │ job acceptance CLOSED (§4)     │
  │ no node key        │   header     │ ce.mesh.request() proxied here │
  │ cap in Keychain/SE │              └───────────────────────────────┘
  └────────────────────┘
```

- `@ce-net/sdk` is runtime-agnostic and uses only web standards (`fetch`, `ReadableStream`,
  `AbortController`, `crypto`) — `ce-ts/README.md:7-8`. It **opens no peer sockets, stores no
  ip:port, holds no key material, performs no signing** — `ce-ts/README.md:151-154`.
- The phone calls the gateway's HTTP API: `ce.status()`, `ce.jobs.*`, `ce.streams.*` (SSE),
  and crucially `ce.mesh.request(to, topic, payload, timeoutMs)`
  (`ce-ts/src/api/mesh.ts:47-66`) — the **gateway** performs the libp2p RPC; the phone never
  touches the mesh transport.
- Read-only GETs need no token; mutating calls take a `token` callback
  (`ce-ts/README.md:85-88`). The phone supplies its capability/token per request.

Net effect: the phone has **zero inbound surface** and **zero ambient mesh authority**. Its
entire power is the set of capabilities it explicitly holds.

---

## 4. Hardening the gateway node (this is where the real risk lives)

The phone is safe by construction; the gateway is the device actually on the mesh, so it must
not accept stranger jobs. Two layers, use both:

**A. Private / air-gapped mesh posture (ship now, no code change).** Mirror the proven
`ce-fleet` enrollment posture (`ce-fleet/docs/enrollment.md:62-72`):
- `ce start --no-bootstrap --no-mdns` and dial only *our own* relay/peers explicitly — no
  auto-join of the public `ce-net.com` bootstrap, so no stranger `JobBid` ever arrives.
- Egress firewall default-deny (`ce-fleet` ships `packaging/linux/ce-fleet-egress.nft`; there
  is a CI guard `enroll-service/tests/airgap.rs`). On the laptop/relay, restrict outbound to
  the known peer set.
- Keep `--api-bind` on loopback (default) — the HTTP API is reachable only locally / via the
  chosen tunnel, never `0.0.0.0` (`ce/src/main.rs:64-69`).

**B. `--no-accept-jobs` guard (GAP — needs a small code change).** Add a config flag that
gates `handle_incoming_bid` (`ce/crates/ce-node/src/lib.rs:1885`) so the gateway refuses all
JobBids outright, independent of mesh posture. This is the durable fix and is already implied
as future work in `PLAN/03-hosting-ui.md:69`. Tracked in §9.

Until (B) lands, **(A) is mandatory** for any gateway that the phone relies on.

---

## 5. Identity, keys, and capability storage on the phone

- The phone does **not** hold the gateway's node key. The node key is an Ed25519 secret at
  `~/.local/share/ce/identity/node.key`, chmod 600, on the gateway only
  (`ce/crates/ce-identity/src/lib.rs:14-34`).
- The phone holds **capability tokens** (and, if it must sign its own requests, a
  phone-specific Ed25519 key). Store both in the **iOS Keychain**; put any signing key in the
  **Secure Enclave** (biometric/passcode-gated, non-exportable). A capability is inert on its
  own — it only names what the issuer chose to authorize — so even a Keychain leak is bounded
  by §6's attenuation + revocation.
- Transport auth is libp2p **Noise** end-to-end on the mesh side; `from_peer` cannot be spoofed
  (`ce/crates/ce-mesh/src/lib.rs:375-381`), and app pubsub envelopes are Ed25519-signed
  (`:294-311`). The phone->gateway hop is HTTPS (see §7).

---

## 6. The capability we issue the phone (least privilege)

CE authorization is signed, **monotonically attenuating** capability chains — the only
authz primitive (`CLAUDE.md:290-293`, full spec `ce/docs/capabilities.md`). Mint the phone a
leaf that is as narrow as the task needs:

```
issuer:    <gateway node id>           # self-delegation; a node always trusts its own key as root
audience:  <phone node/app id>         # bound to THIS phone; a stolen token on another id is rejected
abilities: ["mesh:request"]            # e.g. only the broadcast-control / status topics it needs
resource:  Node(<gateway id>)          # only this gateway, nothing else
caveats:
  not_after:  now + 7d                 # short expiry; renew explicitly (no auto-renew yet)
  allowed_ports / path_prefix: as tight as the ability allows
nonce:     <unique>                    # names the cap for on-chain revocation
parent:    None
```

- Attenuation guarantees the phone can never exceed or broaden this (abilities ⊆, resource ⊆,
  caveats ≥), and it cannot usefully re-delegate beyond what it holds.
- **Revocation** is immediate and layered (`ce/docs/capabilities.md:106-116`): expiry (offline),
  on-chain `RevokeCapability {issuer, nonce}` which kills the link **and its whole subtree**, and
  root rotation as the nuclear option. Losing the phone = one `ce revoke` + let the 7d expiry
  mop up.

---

## 7. Reaching the gateway off-LAN (transport)

- **On-LAN (home/office):** phone -> `https://<laptop-ip>:8844` directly (or mDNS-resolved).
  Simplest; do this first.
- **Off-LAN:** the phone cannot dial libp2p multiaddrs, so it needs an HTTPS path to the
  gateway. `ce-expose` public ingress (`https://<name>.ce-net.com`) is the intended answer but
  is **DESIGN-ONLY / not implemented** and explicitly needs rate limits, per-endpoint caps, a
  kill switch, and a security review before going live (`DEPLOY.md:§8`,
  `ce-expose/docs/public-ingress.md`). **GAP** — until it ships, use an interim private path
  (e.g. a WireGuard/Tailscale link from phone to the gateway, or the existing capability-gated
  `ce-expose tcp` mesh tunnel terminated on a trusted box). Do **not** expose `:8844` publicly.

---

## 8. Mapping to the broadcast use case (ce-cast)

The phone-as-camera for `ce-cast` is the same thin-client pattern, not a special case:
- Phone opens a web page that captures the rear camera via `getUserMedia` and joins a
  **ce-meet** room. ce-meet is **signaling only** — SDP/ICE over CE pubsub; the media plane is
  browser WebRTC P2P and **never transits a CE node** (`ce-meet/README.md:12-13`).
- Room admission is capability-gated by ce-meet's `Admitter` + `ResumeToken` (MAC'd, identity-
  bound, so a stolen resume token used by another id is rejected) — same trust model as §6.
- The gateway/relay receives the camera track (headless WebRTC bridge) and composites/fans out;
  the phone never becomes a mesh node. This keeps the broadcast plan consistent with this
  security model.

---

## 9. Prerequisites / open gaps (close before relying on the happy path)

These are flagged so we don't paper over them:

1. **`--no-accept-jobs` gateway guard** — gate `handle_incoming_bid`
   (`ce/crates/ce-node/src/lib.rs:1885`). Small change; makes gateway hardening robust instead
   of posture-dependent. (Eng task.)
2. **JobBid / deploy capability enforcement (H1)** — wire `ce_cap::authorize` + caveat ceilings
   into both the JobBid acceptance path and the deploy RPC (`PLAN/code-review.md:39-40`).
   Mesh-wide hardening, not phone-specific, but it's the root cause of §2.
3. **`ce-expose` public ingress** — needed for clean off-LAN phone access; design-only today,
   needs the §7 security review. Until then, interim VPN tunnel.
4. **Capability renewal** — no auto-renew exists; the phone app must re-request before expiry.
   Keep expiries short and build the renew prompt into the app.
5. **Revocation latency** — on-chain `RevokeCapability` takes effect at next block (~seconds);
   keep high-value caps short-lived so the in-flight window is small.

---

## 10. Phased rollout

- **P0 (now, no code):** Stand up the gateway with §4-A posture (`--no-bootstrap --no-mdns`,
  egress default-deny, loopback API). Phone runs `@ce-net/sdk` over LAN HTTPS, holds a 7d
  `mesh:request` cap in Keychain. Validate revocation end-to-end.
- **P1 (small eng):** Land `--no-accept-jobs` (#1) so the gateway is safe even on the public
  mesh; add the broadcast camera via ce-meet thin client (§8).
- **P2 (eng + review):** Close H1 (#2) mesh-wide; ship `ce-expose` public ingress (#3) for
  off-LAN, gated by the security review.

---

### One-line summary
The phone never joins the mesh as a node; it is a thin `@ce-net/sdk` client to a hardened
gateway, carrying only a short-lived, attenuated, revocable capability in the Secure Enclave.
That holds both boundaries — a compromised phone can't reach the mesh, and the mesh can't reach
the phone. The one must-fix is closing the gateway's job-acceptance gap (§2/§9).
