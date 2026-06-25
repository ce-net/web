# Foundation Crate Coverage Report

Author: Leif Rydenfalk <ledamecrydenfalk@gmail.com>
Date: 2026-06-23
Tool: `cargo-llvm-cov` v0.8.7 (installed for this run), `llvm-tools-preview`, rustc 1.95.0-nightly
Method: `cargo llvm-cov --summary-only`, one crate at a time, incremental dirs cleaned between
runs to bound disk on the shared target dir (`/Users/07lead01/ce-net/.cargo-shared`).
Source was NOT modified. These are real, instrumented coverage numbers (not test counts).

## Headline numbers

| Crate     | Line cover | Region cover | Function cover | Tests | Verdict |
|-----------|-----------:|-------------:|---------------:|------:|---------|
| ce-rs     | **94.20%** | 92.81%       | 89.75%         | 132   | Strongly validated |
| ce-cdn    | **65.65%** | 68.48%       | 67.72%         | 110   | Core validated, edges/wiring thin |
| ce-coord  | **30.89%** | 37.69%       | 23.32%         | 44    | Weakly validated; large gaps |

All test suites pass green (ce-rs 132, ce-cdn 110, ce-coord 44; zero failures, zero ignored
in the measured runs). Coverage here measures *what the passing tests actually exercise* —
a passing suite over untested code is the trap this report exists to expose.

Aggregate across the three foundation crates (sum of measured lines):
total lines 4490, missed 1607 → **~64.2% line coverage** for the base as a whole. The healthy
average is carried almost entirely by ce-rs; the real picture is bimodal.

---

## ce-rs (SDK) — 94.20% lines

The most validated crate, as it should be: it is the public client every app builds on.

| File        | Lines | Line cover |
|-------------|------:|-----------:|
| lib.rs      |   486 | 98.35% |
| data.rs     |   102 | 94.12% |
| amount.rs   |    72 | 94.44% |
| sse.rs      |   182 | 95.05% |
| tags.rs     |   103 | 93.20% |
| wallet.rs   |   176 | **82.39%** |

Lowest file: `wallet.rs` at 82.39% lines / 59.46% functions. 15 of 37 functions are never
called by a test. The money/amount and SSE parsing paths — the parts most likely to corrupt
value silently — are well covered (94-96%). This crate is in good shape.

### Recommendation
- Add wallet unit tests for the 15 uncovered functions (likely accessor/convenience wrappers
  and error branches). Target 90%+ on `wallet.rs` to bring the whole crate over 95%.

---

## ce-cdn (CDN) — 65.65% lines

The CDN logic core is well tested; the network client and the binary wiring are not.

| File           | Lines | Line cover | Notes |
|----------------|------:|-----------:|-------|
| cache.rs       |   249 | 99.20% | excellent |
| replication.rs |    67 | 100.00% | |
| proto.rs       |    49 | 100.00% | |
| cidrange.rs    |   161 | 98.14% | |
| edge.rs        |   178 | 95.51% | |
| server.rs      |   564 | 92.20% | |
| catalog.rs     |   107 | 81.31% | |
| lib.rs         |    54 | 87.04% | |
| caps.rs        |    52 | **84.62%** | capability gate — security-relevant |
| host.rs        |   333 | **24.32%** | biggest absolute gap (252 lines missed) |
| client.rs      |   171 | **8.77%** | 33 of 36 fns never called |
| main.rs        |   277 | **0.00%** | binary entrypoint, never exercised |

The content-addressing, caching, range slicing, and edge-serving logic — the parts that must
be correct for the CDN to be sound — are 92-100%. The gaps are operational glue:

- `client.rs` (8.77%): the outbound CDN client is almost entirely untested. Apps calling the
  CDN over the mesh exercise none of this in CI.
- `host.rs` (24.32%): host-side orchestration (252 lines missed). Replication selection logic
  is tested via `replication.rs`, but the host loop that drives it is not.
- `main.rs` (0%): expected for a binary, but the arg/config wiring is unvalidated.

### Recommendation (priority order)
1. `client.rs` — add an integration test that round-trips a real put/get/range/purge through
   the client against the in-process server harness already used in `tests/integration.rs`.
   This is the highest-leverage single addition: +150 lines, and it validates the consumer path.
2. `host.rs` — cover the host orchestration loop (replication trigger, re-replication, eviction
   under pressure). The harness exists; wire the host into it.
3. `caps.rs` — at 84.62% it is the only security-relevant file under 90%. Add explicit negative
   tests for malformed / expired / wrong-ability capabilities (some exist in integration.rs;
   push the uncovered 8 lines, likely expiry/clock-skew branches).
4. `main.rs` — extract config parsing into a testable function or add a smoke test that boots
   the binary; low priority but removes a 0% blind spot.

---

## ce-coord (coordination SDK) — 30.89% lines

The weakest foundation crate and the one most in need of attention. This is the substrate that
streams/CRDT collections/replicated state are built on, so under-validation here propagates.

| File           | Lines | Line cover | Notes |
|----------------|------:|-----------:|-------|
| snapshot.rs    |    75 | 100.00% | fully covered |
| merged.rs      |   252 | 55.16% | multi-writer merged log |
| replicated.rs  |   326 | **39.26%** | 198 lines missed — biggest gap |
| lib.rs         |    62 | **0.00%** | public surface untested |
| collections.rs |   254 | **0.00%** | all CRDT collections untested |
| stream.rs      |    32 | **0.00%** | pub/sub stream untested |
| bin/coord.rs   |   106 | **0.00%** | binary entrypoint |

The alarming finding: `collections.rs` (254 lines, the RCell/RCounter/RMap/RSet/RVec CRDT
types) reports **0.00% line coverage**, yet `tests/live.rs` has passing tests named
`live_rmap_full_lifecycle`, `live_rset_lifecycle`, `live_rvec_lifecycle`, etc.

Interpretation: the live tests drive the collections through a different code path (the
replicated/merged log machinery and a network/transport layer) rather than calling the
`collections.rs` constructors directly, so the instrumented lines in `collections.rs` itself
are not hit — OR the collections are thin generic wrappers that monomorphize/inline elsewhere.
Either way, the public CRDT type definitions in `collections.rs` have no direct unit coverage,
and `lib.rs` (the entire public API surface, 0%) and `stream.rs` (0%) are genuinely unexercised
by direct assertions. The 44 passing tests give a false sense of safety for this crate.

### Recommendation (priority order — highest impact on the base)
1. `collections.rs` (0% → target 80%): add direct unit tests for each CRDT collection
   (RCell, RCounter, RMap, RSet, RVec) that construct the type, apply ops, and assert
   converged state — independent of the live transport. 254 lines, the single biggest
   correctness gap in the entire foundation. CRDT merge bugs are silent data-loss bugs;
   they must have direct, deterministic tests, not only end-to-end live tests.
2. `replicated.rs` (39% → target 75%): 198 missed lines. Cover the uncovered replay/conflict
   and error branches. Property tests already exist (`prop_replay_is_idempotent`,
   `prop_snapshot_install_plus_tail_equals_full`) — extend them to the missed branches
   (failure injection: missing blob, out-of-order entries, checkpoint conflicts).
3. `stream.rs` (0% → target 80%): the pub/sub stream is exercised only via `live_stream_pubsub`.
   Add direct unit tests for frame encode/decode and subscriber fan-out.
4. `lib.rs` (0%): ensure the public constructors/re-exports are touched by the new unit tests
   above; most of this will close as a side effect of (1)-(3).
5. `merged.rs` (55% → target 80%): add tests for the uncovered add-writer-midstream and
   compaction edge branches.

---

## Cross-cutting observations

- **Passing != covered.** ce-coord is the textbook case: 44 green tests, but 0% on three of its
  seven files. Test *count* is not validation; only instrumented coverage shows what is checked.
- **Cores are strong, edges are weak, everywhere.** In all three crates the pure-logic core
  (amount/sse, cache/cidrange/replication, snapshot) is 90-100%, while the network clients and
  binary entrypoints (`client.rs`, `host.rs`, `main.rs`, `bin/coord.rs`) are 0-25%. The base
  is validated as a library of pure functions but under-validated as running software.
- **Branch coverage is unavailable** (llvm-cov reports `-` for branches with this toolchain/flags);
  region coverage is the closest available proxy and is reported above.
- **Biggest single wins, ranked:**
  1. ce-coord `collections.rs` — 254 lines, 0%, CRDT correctness (silent-corruption risk).
  2. ce-coord `replicated.rs` — 198 missed lines, replication correctness.
  3. ce-cdn `client.rs` + `host.rs` — ~408 missed lines of consumer/orchestration path.

## Numbers measured (raw `cargo llvm-cov --summary-only` TOTAL rows)

```
ce-rs    TOTAL  regions 2196 missed  158  92.81% | fns 244 missed  25 89.75% | lines 1121 missed  65 94.20%
ce-cdn   TOTAL  regions 4302 missed 1356  68.48% | fns 347 missed 112 67.72% | lines 2262 missed 777 65.65%
ce-coord TOTAL  regions 2011 missed 1253  37.69% | fns 223 missed 171 23.32% | lines 1107 missed 765 30.89%
```
