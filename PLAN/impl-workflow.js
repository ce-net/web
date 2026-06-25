export const meta = {
  name: 'gapp-implement',
  description: 'Implement features+robustness+tests+docs for a wave of Google-inspired CE apps, then adversarially verify each is real and green',
  phases: [
    { title: 'Implement', detail: 'one agent per app: features, robustness, tests, docs; cargo test+clippy green' },
    { title: 'Verify', detail: 'adversarial reviewer: fresh build/test, hunt stubs/fakes/regressions' },
    { title: 'Fix', detail: 'address verifier findings if any' },
  ],
}

// args: array of app names, e.g. ["ce-iam","ce-storage","ce-pubsub"].
// Each agent reads its full audit (state/plan/gaps) from PLAN/audit-by-app.json itself.
const ROOT = '/Users/07lead01/ce-net'
const ANALOGS = {
  'ce-storage': 'Google Cloud Storage / S3', 'ce-iam': 'Google IAM (capability-based)',
  'ce-pubsub': 'Google Pub/Sub', 'ce-db': 'Firestore', 'ce-fn': 'Cloud Functions (FaaS)',
  'ce-drive': 'Google Drive', 'ce-cdn': 'Cloud CDN', 'ce-gke': 'GKE', 'ce-query': 'BigQuery',
  'ce-mail': 'Gmail', 'ce-meet': 'Google Meet', 'ce-notes': 'Google Keep',
  'ce-pin': 'content pinning/replication (storage edge)', 'ce-chat': 'Google Chat / Slack',
}
let parsedArgs = args
if (typeof parsedArgs === 'string') { try { parsedArgs = JSON.parse(parsedArgs) } catch (e) { parsedArgs = parsedArgs.split(/[,\s]+/).filter(Boolean) } }
const names = Array.isArray(parsedArgs) ? parsedArgs : (parsedArgs && parsedArgs.apps) || []
log(`apps to process: ${JSON.stringify(names)}`)
const APPS = names.map((n) => ({ name: n, kind: n === 'ce-chat' ? 'ts' : 'rust', analog: ANALOGS[n] || n }))
if (!APPS.length) { log('No apps in args; nothing to do.'); return [] }

function buildCmds(app) {
  if (app.kind === 'ts') {
    return `Build/test commands (run from ${ROOT}/${app.name}):
  - npm install (if needed)
  - npm run test    (vitest run — ALL tests must pass)
  - npx tsc --noEmit  (typecheck must be clean)
Do NOT run cargo. This is a TypeScript app.`
  }
  return `Build/test commands (run from ${ROOT}/${app.name}):
  - cargo test            (ALL unit + integration + doc tests MUST pass)
  - cargo clippy --all-targets --all-features   (resolve warnings; aim for zero)
  - cargo fmt
The workspace shares ONE cargo target dir (~/.cargo/config.toml -> ${ROOT}/.cargo-shared). Just run normal cargo from the app dir.`
}

const DISK_RULES = `DISK SAFETY (critical — the target dir is shared with other live work):
  - NEVER run \`cargo clean\` (it wipes a shared target dir used by other apps/agents).
  - NEVER delete anything under ${ROOT}/.cargo-shared or ~/.cargo.
  - Before a big build, check \`df -h /Users | tail -1\`. If free space is under ~600MB, STOP, do not attempt the build, and report a "low-disk" blocker instead of trying to free space.`

const SCOPE_RULES = `SCOPE & ARCHITECTURE RULES:
  - Work ONLY inside ${ROOT}/<this-app>. Do NOT edit other apps, and do NOT edit shared path-deps (ce-rs, ce-coord, ce-cap, the ce/ node crates). If you need a new SDK method, implement the feature app-side instead.
  - CE is primitives-only; apps compose the ce-rs SDK + ce-cap capabilities over libp2p AppRequest/pubsub/stream/tunnel. No new node endpoints, no allowlists, no stored ip:port. Authorization between nodes is always a signed attenuating ce-cap chain.
  - Conventions (see ${ROOT}/ce/docs/standards.md): edition 2024, anyhow::Result for fallible public fns, tracing (info/warn/debug) not println! in library code, NO unsafe, NO unwrap()/expect()/panic! in production paths (tests are fine), bincode for wire/disk, integer base-unit money (u128/i128, decimal strings on the wire), difficulty=1 in chain-ish unit tests.
  - Do NOT git commit and do NOT git push. Leave changes in the working tree.`

const QUALITY_RULES = `QUALITY BAR — this is the whole point, so honor it:
  - REAL implementations only. NO stubs, NO todo!()/unimplemented!(), NO functions that pretend to work, NO tests that assert trivially-true things or are #[ignore]'d to hide failure. If a gap is genuinely too large to finish well (e.g. a full WebRTC SFU, a complete SQL engine), implement a REAL, working, tested, coherent SLICE of it and clearly document in the README/code what is implemented vs. deferred — never fake the whole thing and claim it works.
  - Robustness: validate all external inputs, enforce size/rate bounds (no unbounded memory/DoS vectors), handle every error path, make persistence atomic (temp-file + rename), be safe under concurrency. Replace any prod-path unwrap/expect with real error handling.
  - TEST THE SHIT OUT OF IT: expand unit tests, add integration tests under tests/, add failure-path tests (bad input, missing data, expired/forged caps, oversize payloads), add property tests (proptest — add as a dev-dependency if useful) for serialization round-trips and invariants, and concurrency tests where relevant. Every new feature ships with tests that would fail if the feature regressed.
  - Docs: expand README (features, usage, examples, architecture, what's deferred), add rustdoc on public items with at least one runnable doctest on the crate root or key types, and add/extend examples/ where it clarifies usage.`

phase('Implement')

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['app', 'featuresAdded', 'robustnessFixes', 'testsAdded', 'testsTotalAfter', 'testsPass', 'clippyClean', 'docsUpdated', 'deferred', 'filesTouched', 'blockers', 'summary'],
  properties: {
    app: { type: 'string' },
    featuresAdded: { type: 'array', items: { type: 'string' } },
    robustnessFixes: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'integer' },
    testsTotalAfter: { type: 'integer' },
    testsPass: { type: 'boolean' },
    clippyClean: { type: 'boolean' },
    docsUpdated: { type: 'array', items: { type: 'string' } },
    deferred: { type: 'array', items: { type: 'string' }, description: 'gaps intentionally left or partially done, honestly' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['app', 'buildOk', 'testsPass', 'testCount', 'clippyClean', 'stubsOrFakesFound', 'fakeTestsFound', 'regressions', 'featuresAreReal', 'verdict', 'issues'],
  properties: {
    app: { type: 'string' },
    buildOk: { type: 'boolean' },
    testsPass: { type: 'boolean' },
    testCount: { type: 'integer' },
    clippyClean: { type: 'boolean' },
    stubsOrFakesFound: { type: 'boolean' },
    fakeTestsFound: { type: 'boolean' },
    regressions: { type: 'array', items: { type: 'string' } },
    featuresAreReal: { type: 'boolean' },
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

function implPrompt(app) {
  return `You are a senior staff engineer hardening the CE app "${app.name}" — a decentralized, mesh-native ${app.analog}. Your job: make it a LOT more mature, feature-rich, robust, documented, and tested — for real.

App directory: ${ROOT}/${app.name}

FIRST, read your full audit. Open ${ROOT}/PLAN/audit-by-app.json and read the entry under key "${app.name}". It contains: currentState (real architecture / what's stubbed), prioritizedPlan (ordered work items — follow this), featureGaps, robustnessIssues (with locations), testGaps, docGaps. Treat the prioritizedPlan as your primary backlog and do as many items as you can do WELL, in order (depth over breadth). Close the high-importance feature gaps and fix the robustness issues.

${buildCmds(app)}

${SCOPE_RULES}

${QUALITY_RULES}

${DISK_RULES}

WORKFLOW:
  1. Read the crate fully (Cargo.toml, all of src/, tests/, examples/, README, any docs/). Understand the real architecture before changing anything.
  2. Implement the prioritized plan and close the highest-value feature gaps with REAL, working code. Fix the robustness issues. Prefer finishing a coherent set deeply over half-doing everything.
  3. Add comprehensive tests (unit + integration + failure-path + property where useful). Make builds/tests pass.
  4. Update README + rustdoc + doctests + examples.
  5. Iterate cargo test / clippy / fmt until GREEN. Do not stop with failing tests or unaddressed clippy errors.

Return the structured report. Be honest in 'deferred' and 'blockers' — do not claim work you didn't really do.`
}

function verifyPrompt(app, impl) {
  return `You are an adversarial code reviewer. An implementer just claimed to harden the CE app "${app.name}" (${app.analog}). Your job is to VERIFY the claims independently and skeptically. Default to skepticism.

App directory: ${ROOT}/${app.name}

The implementer reported:
${JSON.stringify({ featuresAdded: impl?.featuresAdded, robustnessFixes: impl?.robustnessFixes, testsAdded: impl?.testsAdded, testsTotalAfter: impl?.testsTotalAfter, testsPass: impl?.testsPass, deferred: impl?.deferred, blockers: impl?.blockers }, null, 1)}

Do this:
  1. Run the test suite FRESH yourself (${app.kind === 'ts' ? 'npm run test, and npx tsc --noEmit' : 'cargo test, and cargo clippy --all-targets'}). Record the real pass/fail and test count. ${DISK_RULES.split('\n')[0]} ${app.kind === 'ts' ? '' : 'Do NOT run cargo clean. Do NOT delete anything under .cargo-shared.'}
  2. Grep for stubs/fakes: \`todo!\`, \`unimplemented!\`, \`unreachable!\` in non-test paths, functions returning hardcoded/mock values, features that are wired but no-op, and prod-path unwrap()/expect()/panic!.
  3. Inspect the NEW tests: are they real (would they fail if the feature broke) or trivially-true / #[ignore]'d to hide failures? Look at the diff (git diff) to see what actually changed.
  4. Spot-check that the headline featuresAdded are genuinely implemented end-to-end, not just type definitions or CLI flags with no behavior.
  5. Check for regressions: did pre-existing functionality or tests break?

Be specific in 'issues' (file:line). Set verdict='fail' if: tests don't pass, fakes/stubs were introduced and claimed as real, new tests are fake, or there are regressions. Otherwise 'pass'. Return the structured verdict.`
}

function fixPrompt(app, verify) {
  return `You are fixing the CE app "${app.name}" (${ROOT}/${app.name}). An adversarial reviewer FAILED it. Address every issue for real, then make the suite green.

Reviewer verdict: ${verify?.verdict}
Issues to fix:
${(verify?.issues || []).map((i) => `  - ${i}`).join('\n')}
Regressions: ${(verify?.regressions || []).join('; ') || 'none'}
stubsOrFakesFound=${verify?.stubsOrFakesFound} fakeTestsFound=${verify?.fakeTestsFound} testsPass=${verify?.testsPass}

${SCOPE_RULES}
${QUALITY_RULES}
${DISK_RULES}

Fix the issues with REAL implementations and REAL tests. ${app.kind === 'ts' ? 'Run npm run test and npx tsc --noEmit until clean.' : 'Run cargo test and cargo clippy --all-targets until clean.'} Return the same structured implement-report shape reflecting the fixed state.`
}

const results = await pipeline(
  APPS,
  // Stage 1: implement
  (app) => agent(implPrompt(app), { label: `impl:${app.name}`, phase: 'Implement', schema: IMPL_SCHEMA, effort: 'high' }),
  // Stage 2: adversarial verify
  (impl, app) => agent(verifyPrompt(app, impl), { label: `verify:${app.name}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' })
    .then((v) => ({ app: app.name, impl, verify: v })),
  // Stage 3: conditional fix loop (one pass), then reclaim disk footprint
  async (vr, app) => {
    let result = vr
    if (vr && vr.verify && vr.verify.verdict !== 'pass') {
      log(`${app.name}: verify FAILED — running fix pass`)
      const fixed = await agent(fixPrompt(app, vr.verify), { label: `fix:${app.name}`, phase: 'Fix', schema: IMPL_SCHEMA, effort: 'high' })
      const reverify = await agent(verifyPrompt(app, fixed), { label: `reverify:${app.name}`, phase: 'Fix', schema: VERIFY_SCHEMA, effort: 'high' })
      result = { app: app.name, impl: fixed, verify: reverify, fixedAfterFailure: true }
    }
    // Reclaim disk: the cargo target dir is shared and under multi-agent contention.
    if (app.kind !== 'ts') {
      await agent(
        `Reclaim disk now. Run exactly: \`cd ${ROOT}/${app.name} && cargo clean -p ${app.name}\`. This removes ONLY this package's build outputs from the shared cargo target dir (${ROOT}/.cargo-shared) — it is SAFE for other apps and other agents' builds. It may wait briefly for the shared build lock; that is fine. Report how many MiB were freed. Do NOT change any source file, do NOT run cargo clean without -p, do NOT delete anything else.`,
        { label: `clean:${app.name}`, phase: 'Fix', effort: 'low' }
      )
    }
    return result
  }
)

const out = results.filter(Boolean)
const passed = out.filter((r) => r.verify && r.verify.verdict === 'pass')
log(`Wave done: ${passed.length}/${APPS.length} passed verification`)
return out.map((r) => ({
  app: r.app,
  verdict: r.verify?.verdict,
  testsPass: r.verify?.testsPass,
  testCount: r.verify?.testCount,
  clippyClean: r.verify?.clippyClean,
  featuresAdded: r.impl?.featuresAdded,
  robustnessFixes: r.impl?.robustnessFixes,
  testsAdded: r.impl?.testsAdded,
  deferred: r.impl?.deferred,
  issues: r.verify?.issues,
  blockers: r.impl?.blockers,
  fixedAfterFailure: r.fixedAfterFailure || false,
}))
