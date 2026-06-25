# Ship status — 2026-06-24

One-page index of what was built this wave: what is shipped + deployed, what is in flight, and
what is deliberately GATED (not auto-deployed). "Deploy everything to prod" was applied to
everything safe; the gated items are flagged with reasons and need an explicit decision.

## Shipped to repos (committed + pushed)

| Repo / branch | What | State |
|---|---|---|
| `ce-gov`, `ce-sched`, `ce-bench`, `ce-tabnet`, `ce-worker` (main) | governance, placement, benchmarking, browser-tab LLM, native worker | pushed; selftests green |
| `web` (main) | `/fabric` dashboard, `worker.js`, read-only `/atlas`+`/status` config | pushed + deployed |
| `e2e` (main) | prod smoke + security-invariant + worker/gateway/apps suites; CI runs them | pushed; CI green for apps-fabric |
| `ce-expose` (main) | feature-gated `ingress` (hardened public HTTP ingress), `docs/security-review.md` | pushed; **off by default**, deploy gated (below) |
| `ce` branch `sybil-p4-p9` | Sybil-security P4-P9 (bond gate, net hardening, capacity audits, beacon+verify, held-escrow+MeritRank, lineage+ECVRF) | pushed; **inert/additive**, NOT merged (gated) |
| `rdev` branch `remote-build` | `rdev run/build` — long remote builds with live logs over the mesh | being committed/pushed by its workflow |

## Deployed + live on the relay (ce-net.com)

- `ce-relay` (ce node, **upgraded 2026-06-24 to latest `main` dd35dc6 = CE-TWLE**, from the old `0.1.0` PoW build), `ce-hub` (browser/native worker dispatch + app platform), `ce-storage-gw` (serves ce-net.com from CE blobs with static fallback), `ce-worker` (shares the relay's cores), `rdev-serve` (mesh remote-build), `nginx` (TLS edge + read-only node surface).
- **Relay upgrade (done, verified):** scratch-tested first, backed up binary + chain, stop->swap->start with rollback. node_id `21f5c206…` preserved (bootstrap multiaddr unchanged). The PoW->VRF consensus change means the old chain does not validate under the new rules, so the chain **reset to genesis (height 0)**; old chain + binary backed up on the relay (`/usr/local/bin/ce.bak.*`, `~/.local/share/ce/chain.bak.*`). Note: a fresh CE-TWLE chain needs genesis-weight config / a producing node before the chain progresses (the consensus-bringup work, related to `sybil-p4-p9`); the relay is `--no-mine` and serves its bootstrap/relay/site/hub role regardless.
- Prod smoke (`e2e/e2e-prod.sh`) **after the upgrade**: **27/27 PASS** — public pages serve, gateway still serves from CE blobs (new node's blob API compatible), value API not internet-exposed, node/hub/gateway ports firewalled, static fallback, live compute.
- Mac node: build of latest `main` in progress; will be swapped to match (clears the version skew + unblocks the dogfooded `rdev build` loop). Desktop node: offline / not updated.

## Designs / references

- `PLAN/compute-donation-sybil-security.md` — the maximum-security Sybil design (research-backed + 22-finding red-team).
- `ce/docs/sybil-resistance.md`, `ce/docs/consensus.md` — the audited 3-pillar defense + CE-TWLE consensus this extends.
- `rdev` README + the dogfood loop: build/test on the relay via the mesh (`rdev build`), not raw ssh.
- `CLAUDE.md` layout updated with all the above repos + the sybil branch caveat.

## GATED — not auto-deployed (need an explicit decision)

1. **P4-P9 consensus onto the live node.** Branch is pushed but the hooks are inert and the crypto is placeholder; it is unreviewed + uncalibrated. The relay is the network's bootstrap node — swapping its consensus binary for an unreviewed branch could fork/destabilize the mesh (irreversible). Path: expert security review -> calibration -> real-crypto swap + wire-format migration -> human merge -> validate on a NON-bootstrap node before the bootstrap.
2. **Public ingress facing the internet.** Code shipped (default-deny, kill-switch). Exposing the listener is the DDoS/abuse surface; `docs/security-review.md` lists launch-blockers + the section-4 checklist required before it faces the internet. Hold the internet deploy until those close.
3. **Relay `ce` node upgrade (0.1.0 -> current main).** A deliberate network-wide release op for the bootstrap node, not a casual deploy. Hold.

## In flight

- `rdev` remote-build workflow (commits/pushes its branch + deploys `rdev serve` on the relay).
- `e2e-ingress.sh` + CI wiring for the ingress feature.
