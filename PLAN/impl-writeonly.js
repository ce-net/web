export const meta = {
  name: 'gapp-write',
  description: 'Author features+robustness+tests+docs for the Google-inspired CE apps as pure file editing (NO heavy cargo builds — disk is critically full and shared). ce-chat (TS) is fully tested.',
  phases: [{ title: 'Write', detail: 'one authoring agent per app; Rust = edit-only (verify deferred), ce-chat = full test' }],
}

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
log(`apps to write: ${JSON.stringify(names)}`)
const APPS = names.map((n) => ({ name: n, kind: n === 'ce-chat' ? 'ts' : 'rust', analog: ANALOGS[n] || n }))
if (!APPS.length) { log('No apps in args.'); return [] }

phase('Write')

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['app', 'featuresAdded', 'robustnessFixes', 'testsAdded', 'docsUpdated', 'compileStatus', 'filesTouched', 'deferred', 'selfReviewNotes', 'summary'],
  properties: {
    app: { type: 'string' },
    featuresAdded: { type: 'array', items: { type: 'string' } },
    robustnessFixes: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'integer', description: 'number of NEW test functions authored' },
    docsUpdated: { type: 'array', items: { type: 'string' } },
    compileStatus: { type: 'string', enum: ['ts-tests-pass', 'ts-tests-fail', 'rust-not-built-deferred', 'rust-checked-ok', 'rust-check-failed'], description: 'ce-chat must run vitest; rust apps must NOT run heavy builds (deferred)' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    deferred: { type: 'array', items: { type: 'string' } },
    selfReviewNotes: { type: 'string', description: 'honest notes on confidence the code compiles, risky areas a later build pass should check first' },
    summary: { type: 'string' },
  },
}

const RUST_DISK_RULE = `CRITICAL DISK + BUILD RULE (the machine is ~99% full and shared with other agents running cargo):
  - This is the "write now, verify later" mode. You MUST NOT run any heavy Rust build: NO \`cargo test\`, NO \`cargo build\`, NO \`cargo clippy --all-targets\`, NO \`cargo check --tests\`, NO running examples. These create large test binaries and can trigger ENOSPC that corrupts a shared build cache for OTHER agents.
  - Do NOT use the LSP tool / rust-analyzer either — it runs \`cargo check\` into the shared target and consumes disk. Instead, READ source directly: read ce-rs SDK source (${ROOT}/ce-rs/src) and your dependencies to confirm exact method names/signatures/types so your code compiles. Author carefully — a later verification pass will compile and run the tests and fix anything that doesn't build.
  - NEVER run \`cargo clean\` (without -p), NEVER delete anything under ${ROOT}/.cargo-shared or ~/.cargo, NEVER edit other apps or shared path-deps (ce-rs, ce-coord, ce-cap, ce/ node crates).
  - To maximize the chance your code compiles on the first later build: match existing code patterns exactly, verify every external symbol against the actual SDK/dependency source before using it, keep imports correct, and avoid speculative APIs.`

const TS_RULE = `BUILD RULE (TypeScript app — disk-cheap, so fully verify): run \`npm install\` if needed, then iterate \`npx tsc --noEmit\` and \`npm run test\` (vitest) until BOTH are clean. Do NOT run cargo. Set compileStatus to ts-tests-pass only if vitest is green.`

const SCOPE_RULES = `SCOPE & CONVENTIONS:
  - Work ONLY inside ${ROOT}/<this-app>. Do not touch other apps or shared path-deps.
  - CE is primitives-only; apps compose the ce-rs SDK + ce-cap capabilities over libp2p AppRequest/pubsub/stream/tunnel. No new node endpoints, no allowlists, no stored ip:port; authorization is always a signed attenuating ce-cap chain.
  - Conventions (${ROOT}/ce/docs/standards.md): edition 2024, anyhow::Result, tracing not println! in libs, NO unsafe, NO unwrap()/expect()/panic! in prod paths (tests fine), bincode wire/disk, integer base-unit money (u128/i128, decimal strings on the wire), difficulty=1 in chain-ish tests. NO emojis anywhere (code/docs/comments) — they read as AI slop.
  - Do NOT git commit or push. Leave changes in the working tree.`

const QUALITY_RULES = `QUALITY BAR:
  - REAL implementations only. No stubs, no todo!()/unimplemented!(), no functions that pretend to work, no trivially-true or #[ignore]'d tests. If a gap is genuinely too large to finish (e.g. a full WebRTC SFU, a complete SQL engine), implement a REAL, working, coherent SLICE and document in README/code exactly what is implemented vs deferred — never fake the whole thing.
  - Robustness: validate all external inputs, enforce size/rate bounds (no unbounded-memory/DoS vectors), handle every error path, make persistence atomic (temp-file + fsync + rename), be concurrency-safe. Replace prod-path unwrap/expect with real error handling.
  - Tests (authored now, run later): write comprehensive unit tests, integration tests under tests/, failure-path tests (bad input, missing data, forged/expired caps, oversize payloads), and property tests (proptest as a dev-dependency where useful) for serialization round-trips and invariants. Every new feature ships with tests that would fail if it regressed. Write them to COMPILE and PASS on a real build even though you won't run them now.
  - Docs: expand README (features, usage, examples, architecture, what's deferred), add rustdoc with at least one doctest on key types, extend examples/ where useful.`

function prompt(app) {
  return `You are a senior staff engineer maturing the CE app "${app.name}" — a decentralized, mesh-native ${app.analog}. Make it a LOT more feature-rich, robust, documented, and tested. Author real, production-grade code.

App directory: ${ROOT}/${app.name}

FIRST read your audit: open ${ROOT}/PLAN/audit-by-app.json and read the entry under key "${app.name}" — it has currentState, prioritizedPlan (your primary backlog, in order), featureGaps, robustnessIssues (with locations), testGaps, docGaps. Read the whole crate before editing. Then implement the prioritized plan with depth over breadth: close the high-importance feature gaps with real working code, fix the robustness issues, and author comprehensive tests + docs.

${app.kind === 'ts' ? TS_RULE : RUST_DISK_RULE}

${SCOPE_RULES}

${QUALITY_RULES}

Return the structured report. Be honest in 'deferred', 'compileStatus', and 'selfReviewNotes' — for Rust, flag the riskiest spots a later build pass should check first.`
}

const results = await parallel(APPS.map((app) => () =>
  agent(prompt(app), { label: `write:${app.name}`, phase: 'Write', schema: SCHEMA, effort: 'high' })
))

const out = results.filter(Boolean)
log(`Wrote ${out.length}/${APPS.length} apps`)
return out.map((r) => ({
  app: r.app,
  featuresAdded: (r.featuresAdded || []).length,
  robustnessFixes: (r.robustnessFixes || []).length,
  testsAdded: r.testsAdded,
  compileStatus: r.compileStatus,
  deferred: r.deferred,
  selfReviewNotes: r.selfReviewNotes,
  filesTouched: (r.filesTouched || []).length,
}))
