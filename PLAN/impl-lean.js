export const meta = {
  name: 'gapp-lean',
  description: 'Lean maturation: one self-testing implement agent per app (cargo test+clippy green), then reclaim disk. No separate verify stage; a consolidated verify sweep runs at the end.',
  phases: [
    { title: 'Implement', detail: 'one agent per app: features, robustness, tests, docs; iterate cargo test+clippy to green' },
    { title: 'Reclaim', detail: 'cargo clean -p to keep the shared target dir flat' },
  ],
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
log(`apps: ${JSON.stringify(names)}`)
const APPS = names.map((n) => ({ name: n, kind: n === 'ce-chat' ? 'ts' : 'rust', analog: ANALOGS[n] || n }))
if (!APPS.length) { log('No apps in args.'); return [] }

phase('Implement')

const SCHEMA = {
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
    deferred: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

function buildCmds(app) {
  if (app.kind === 'ts') {
    return `Build/test (from ${ROOT}/${app.name}): npm install if needed; iterate \`npx tsc --noEmit\` and \`npm run test\` (vitest) until both clean. No cargo.`
  }
  return `Build/test (from ${ROOT}/${app.name}): iterate \`cargo test\` (ALL unit+integration+doc tests must pass) and \`cargo clippy --all-targets\` (resolve warnings) and \`cargo fmt\` until green. The cargo target dir is shared (${ROOT}/.cargo-shared); just run normal cargo from the app dir. It may wait for the shared build lock — that is fine.`
}

const RULES = `DISK SAFETY: NEVER run \`cargo clean\` without -p (it wipes a shared target dir used by other agents). NEVER delete anything under ${ROOT}/.cargo-shared or ~/.cargo. Before a large build, check \`df -h /Users | tail -1\`; if free space is under ~600MB, STOP and report a "low-disk" blocker rather than building.

SCOPE & CONVENTIONS: Work ONLY inside ${ROOT}/<this-app>. Do not edit other apps or shared path-deps (ce-rs, ce-coord, ce-cap, ce/ node crates) — if you need an SDK method, implement it app-side. CE is primitives-only; apps compose the ce-rs SDK + ce-cap over libp2p AppRequest/pubsub/stream/tunnel; authorization is always a signed attenuating ce-cap chain (no new node endpoints, no allowlists, no stored ip:port). Conventions (${ROOT}/ce/docs/standards.md): edition 2024, anyhow::Result, tracing not println! in libs, NO unsafe, NO unwrap()/expect()/panic! in prod paths (tests fine), bincode wire/disk, integer base-unit money (u128/i128, decimal strings on the wire). NO emojis anywhere. Do NOT git commit or push.

QUALITY BAR: REAL implementations only — no stubs, no todo!()/unimplemented!(), no functions that pretend to work, no trivially-true or #[ignore]'d tests. If a gap is too large to finish (full WebRTC SFU, complete SQL engine), implement a REAL coherent SLICE and document what's deferred — never fake it. Robustness: validate external inputs, enforce size/rate bounds (no DoS), handle every error path, atomic persistence (temp-file+fsync+rename), concurrency-safe. Tests: expand unit + integration (tests/) + failure-path + property (proptest dev-dep where useful); every new feature ships with tests that fail if it regresses. Docs: expand README (features, usage, examples, architecture, deferred), rustdoc with a doctest on key types, extend examples/.`

function implPrompt(app) {
  return `You are a senior staff engineer hardening the CE app "${app.name}" — a decentralized, mesh-native ${app.analog}. Make it a LOT more feature-rich, robust, documented, and tested — for real, end to end (you DO build and run the tests to green).

App directory: ${ROOT}/${app.name}

FIRST read your audit: open ${ROOT}/PLAN/audit-by-app.json, key "${app.name}" — it has currentState, prioritizedPlan (your primary backlog, in order), featureGaps, robustnessIssues (locations), testGaps, docGaps. Read the whole crate first. Some files may already have partial in-progress edits from an earlier interrupted run — review them, keep what's good, finish/fix the rest. Then implement the prioritized plan (depth over breadth): close high-importance feature gaps with real code, fix robustness issues, add comprehensive tests + docs.

${buildCmds(app)}

${RULES}

Iterate until the test suite is GREEN and clippy is clean. Do not stop with failing tests. Return the structured report; be honest in 'deferred' and 'blockers'.`
}

const results = await pipeline(
  APPS,
  (app) => agent(implPrompt(app), { label: `impl:${app.name}`, phase: 'Implement', schema: SCHEMA, effort: 'high' }),
  async (impl, app) => {
    if (app.kind !== 'ts' && impl) {
      await agent(
        `Reclaim disk: run exactly \`cd ${ROOT}/${app.name} && cargo clean -p ${app.name}\`. Removes ONLY this package's outputs from the shared target dir — safe for other apps/agents. May wait for the build lock; fine. Report MiB freed. Change no source; do not run cargo clean without -p.`,
        { label: `clean:${app.name}`, phase: 'Reclaim', effort: 'low' }
      )
    }
    return { app: app.name, impl }
  }
)

const out = results.filter(Boolean)
const green = out.filter((r) => r.impl && r.impl.testsPass)
log(`Done: ${green.length}/${APPS.length} report green`)
return out.map((r) => ({
  app: r.app,
  testsPass: r.impl?.testsPass,
  clippyClean: r.impl?.clippyClean,
  featuresAdded: (r.impl?.featuresAdded || []).length,
  robustnessFixes: (r.impl?.robustnessFixes || []).length,
  testsAdded: r.impl?.testsAdded,
  testsTotalAfter: r.impl?.testsTotalAfter,
  deferred: r.impl?.deferred,
  blockers: r.impl?.blockers,
}))
