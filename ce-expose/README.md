# ce-expose

ngrok-style tunnels over CE. Expose a local TCP/HTTP service to **other mesh peers**, capability-gated
over the existing CE tunnel/stream primitive. An application built **on** CE primitives (the SDK tier,
like `swarm` / `rdev` / `ce-pin`) — **not** a node feature, and it ships **no node change**.

A peer that holds a signed, attenuating `ce-cap` chain granting `expose:dial` (rooted at your node's
own key or a configured org root) can reach your local port. Everyone else is denied. Revoke the cap
and access dies on the next frame. There is no public surface and no guessable URL — the capability
*is* the credential.

## Install / build

```bash
cargo build --release   # at ce-expose/
```

## Use

On the **origin** (the machine whose service you expose):

```bash
ce-expose http 3000 --name leif     # expose local HTTP on :3000 as endpoint "leif"
ce-expose tcp 22 --name sshbox      # expose raw TCP (ssh, db, ...) as "sshbox"
```

Grant a peer access by issuing it an `expose:dial` capability out-of-band (on the origin or an org
root):

```bash
ce grant <peer-node-id> --can expose:dial --expires 7d   # prints a hex token
```

On the **consumer** (the peer reaching your service), hand it that token and dial:

```bash
export CE_EXPOSE_CAPS=<token>
ce-expose connect leif 8080         # 127.0.0.1:8080 now bridges to the origin's :3000 over the mesh
ce-expose ping leif                 # liveness + "is my cap accepted?" probe
```

## Capability resolution (consumer)

The `expose:dial` chain is read from, in order: `--caps <hex>`, then `$CE_EXPOSE_CAPS`, then
`<config dir>/ce-expose/caps`.

## Accepted roots (origin)

By default the origin honors only chains it self-issued. To accept an org/fleet root, list its 64-hex
NodeId (one per line) in `$CE_EXPOSE_ROOTS`, else `$CE_DATA_DIR/roots`, else `~/.local/share/ce/roots`.

## Public ingress

Turning a private mesh tunnel into a public `https://<name>.ce-net.com` URL needs a **relay-tier**
public-HTTP ingress feature, which is a separate primitive with a real abuse surface (phishing,
DDoS, rate limits, kill switch, per-endpoint caps). It is **designed, not implemented**, in
[`docs/public-ingress.md`](docs/public-ingress.md), and must pass a security review before it ships.
This crate deliberately makes **no** node or relay change.

## Layout

- `src/proto.rs`    — the `expose/*` mesh wire protocol (open / data / close / ping).
- `src/caps.rs`     — resolving the `ce-cap` chain the consumer presents.
- `src/session.rs`  — the pure, unit-tested core: the capability `gate` + the `Session` half-stream
  byte-pump state machine.
- `src/agent.rs`    — the origin `serve()` loop: authorize dials, forward bytes to the local port.
- `src/consumer.rs` — the dialing side: bind a local listener and bridge it to a peer's endpoint.
- `docs/public-ingress.md` — design + threat model for the relay public-ingress feature (not built).
