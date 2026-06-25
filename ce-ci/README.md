# ce-ci

A distributed sharded test / CI runner on the [CE](https://github.com/ce-net/ce) compute mesh — a
thin SDK-tier app (like [`swarm`](https://github.com/ce-net/swarm), `rdev`, `ce-pin`) built on the
[`ce-rs`](https://github.com/ce-net/ce-rs) SDK and the `ce-cap` capability primitive.

ce-ci splits a test suite (or a job matrix) across idle machines you or the mesh own, runs each
shard in a sandboxed container on a different host, and aggregates the per-shard pass/fail into one
combined exit code — no per-minute SaaS markup, content-addressed artifact reuse via `ce-cache`,
bring-your-own-GPU for ML suites.

## Install

```bash
cargo install --path .
```

Needs a running local CE node (`ce start`) — ce-ci talks to it on `http://127.0.0.1:8844`.

## Use

```bash
# Dry run: show the shard plan for a config (no dispatch).
ce-ci plan ce-ci.toml

# Split the suite across up to 8 mesh hosts and gather results.
ce-ci run ce-ci.toml --hosts 8 --cap <capability-token>

# Verification dial: re-run 10% of shards on a SECOND host and flag any divergence
# (a host reporting false-green is caught and the run goes red).
ce-ci run ce-ci.toml --hosts 8 --verify 0.1 --cap <token>

# Point shard build tools at a ce-cache sidecar so deps/objects are reused fleet-wide.
ce-ci run ce-ci.toml --cache http://localhost:9092 --cap <token>
```

`--node <url>` points ce-ci at a different CE node.

## Config (`ce-ci.toml`)

```toml
image   = "ce-net/rust:1.x"                                   # pinned toolchain image
command = "cargo nextest run --partition count:{shard}/{total}"
select  = "docker"                                            # required atlas self-tag

[shard]
strategy = "count"   # split into N index slices the runner partitions by
total    = 8
# OR:
# strategy = "list"  # one shard per explicit unit (test file / package)
# units    = ["crate-a", "crate-b", "crate-c"]   # {unit} substituted into command

[[matrix]]           # optional: each leg fans the shard set out again with its own env
name = "linux-stable"
env  = { TOOLCHAIN = "stable", OS = "linux" }
```

Command placeholders: `{shard}` (1-based index), `{total}` (shards in the leg), `{unit}`
(the unit, for `list` strategy).

## How it works

1. **Plan** — expand the config (× matrix legs) into a flat, deterministic list of shards
   (`src/shard.rs` — pure, unit-tested).
2. **Discover + rank** — `GET /atlas` for docker-capable hosts, ranked by on-chain delivered work
   (`ce-rs history`), most-proven first (`src/farm.rs`).
3. **Scatter** — fan the shards out concurrently over the `rdev/exec` app protocol (`/ce/rpc/1`),
   capability-gated by the `ce-cap` chain in `--cap`.
4. **Verify (optional)** — beacon-seed a canary set, re-run those shards on a *different* host,
   compare exit code + output digest; divergence flags the suspect host (`src/verify.rs`).
5. **Aggregate** — combine per-shard outcomes into a verdict and a combined exit code
   (`src/report.rs` — pure, unit-tested). Green iff every shard ran, passed, and (if verified) agreed.

## Trust model

Every host verifies a signed, attenuating `ce-cap` chain (`authorize(...)`) before running any
shard — exactly the rdev `serve` pattern. The ability is an opaque app string (`ci:shard`, or
`exec` for rdev-serving hosts). The verification dial raises the cost of a host faking green but is
not a hard guarantee against a worker colluding with its own canary peer (documented residual
trust assumption from the portfolio spec).

## Architecture

ce-ci is **primitives-only-consuming**: it adds no node RPCs. It uses `ce-rs` (`atlas`, `history`,
`beacon`, `request`/`reply`, blobs, channels) and `ce-cap` (the capability verifier). Pure logic
(splitting, aggregation, canary selection) is unit-tested with no live cluster:

```bash
cargo test          # config + shard + report + verify + cache + cap unit tests
```

## Status

- Shard splitting (count / list strategies, matrix expansion) — done, unit-tested.
- Result aggregation (per-shard pass/fail, combined exit code, divergence tally) — done, unit-tested.
- Beacon-seeded canary selection for the verification dial — done, unit-tested.
- Mesh scatter/gather over `rdev/exec`, atlas/history placement — done.
- Log streaming: stdout/stderr returned per shard and printed in the report. Live streaming of a
  long shard's logs (vs the final capture) is a follow-up — see `// TODO(long-running)` in
  `src/farm.rs` (switch to `mesh_deploy` + job polling + log stream).
- ce-cache integration: env wiring done; sidecar lifecycle is the operator's job — see
  `// TODO(sidecar-lifecycle)` in `src/cache.rs`.

## License

MIT © Leif Rydenfalk
