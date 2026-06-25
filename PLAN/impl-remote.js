export const meta = {
  name: 'gapp-remote',
  description: 'Mature the Google-inspired CE apps: agents edit locally (disk-cheap) and compile+test on the Hetzner box via tools/remote-test.sh until green. No local cargo builds.',
  phases: [{ title: 'Implement+RemoteTest', detail: 'one agent per app: edit locally, verify on Hetzner, iterate to PASS' }],
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

phase('Implement+RemoteTest')

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['app', 'featuresAdded', 'robustnessFixes', 'testsAdded', 'testsTotalAfter', 'remoteVerdict', 'docsUpdated', 'deferred', 'filesTouched', 'blockers', 'summary'],
  properties: {
    app: { type: 'string' },
    featuresAdded: { type: 'array', items: { type: 'string' } },
    robustnessFixes: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'integer' },
    testsTotalAfter: { type: 'integer' },
    remoteVerdict: { type: 'string', enum: ['PASS', 'FAIL', 'not-run'], description: 'result of tools/remote-test.sh on Hetzner' },
    docsUpdated: { type: 'array', items: { type: 'string' } },
    deferred: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const BUILD = (app) => app.kind === 'ts'
  ? `BUILD/TEST (ce-chat is TypeScript, disk-cheap — test LOCALLY): npm install if needed; iterate \`npx tsc --noEmit\` and \`npm run test\` (vitest) until both clean. Set remoteVerdict to PASS if vitest is green. Do not use the remote tool.`
  : `BUILD/TEST — DO NOT RUN CARGO LOCALLY (the laptop disk is full and shared; local cargo causes ENOSPC that corrupts other agents' caches). Instead compile and test on the Hetzner box with the dev tool:
    cd ${ROOT} && tools/remote-test.sh ${app.name} --clippy
  This rsyncs the app + path-deps to Hetzner and runs cargo test + clippy there (51 GB disk, real toolchain), printing a tail and a final line "REMOTE-TEST ${app.name}: PASS" or "FAIL". Read the output, fix issues, and re-run until it prints PASS. Builds are serialized on the box via a flock; an invocation may wait a few minutes for the lock — that is expected. If a remote build is killed by OOM ("signal: 9" / SIGKILL — the box has 4 GB RAM and no swap), re-run with \`tools/remote-test.sh ${app.name} --jobs 1\`. Use the local Edit/Write/Read tools to change code; only the compile+test happens remotely. You may read ${ROOT}/tools/README.md for details.`

function prompt(app) {
  return `You are a senior staff engineer hardening the CE app "${app.name}" — a decentralized, mesh-native ${app.analog}. Make it a LOT more feature-rich, robust, documented, and tested — for real, verified green on the Hetzner build box.

App directory: ${ROOT}/${app.name}

FIRST read your audit: open ${ROOT}/PLAN/audit-by-app.json, key "${app.name}" — currentState, prioritizedPlan (your ordered backlog), featureGaps, robustnessIssues (locations), testGaps, docGaps. Read the whole crate first. Some files may already have partial in-progress edits from earlier interrupted runs — review, keep what's good, finish/fix the rest. Then implement the prioritized plan (depth over breadth): close high-importance feature gaps with real code, fix robustness issues, add comprehensive tests + docs.

${BUILD(app)}

SCOPE & CONVENTIONS: Work ONLY inside ${ROOT}/${app.name}. Do NOT edit other apps or shared path-deps (ce-rs, ce-coord, ce/ crates) — if you need an SDK method, implement it app-side. CE is primitives-only; apps compose the ce-rs SDK + ce-cap over libp2p AppRequest/pubsub/stream/tunnel; authorization is always a signed attenuating ce-cap chain (no new node endpoints, no allowlists, no stored ip:port). Conventions (${ROOT}/ce/docs/standards.md): edition 2024, anyhow::Result, tracing not println! in libs, NO unsafe, NO unwrap()/expect()/panic! in prod paths (tests fine), bincode wire/disk, integer base-unit money (u128/i128, decimal strings on the wire). NO emojis anywhere. Do NOT git commit or push.

QUALITY BAR: REAL implementations only — no stubs, no todo!()/unimplemented!(), no functions that pretend to work, no trivially-true or #[ignore]'d tests. If a gap is too large to finish (full WebRTC SFU, complete SQL engine), implement a REAL coherent SLICE and document what's deferred — never fake it. Robustness: validate external inputs, enforce size/rate bounds (no DoS), handle every error path, atomic persistence (temp-file+fsync+rename), concurrency-safe. Tests: expand unit + integration (tests/) + failure-path + property (proptest dev-dep where useful); every new feature ships with tests that fail if it regresses. Docs: expand README (features, usage, examples, architecture, deferred), rustdoc with a doctest on key types, extend examples/.

Iterate until the remote test run prints PASS (or vitest is green for ce-chat). Do not stop with failing tests. Return the structured report; set remoteVerdict to the real final result and be honest in 'deferred' and 'blockers'.`
}

const results = await parallel(APPS.map((app) => () =>
  agent(prompt(app), { label: `remote:${app.name}`, phase: 'Implement+RemoteTest', schema: SCHEMA, effort: 'high' })
))

const out = results.filter(Boolean)
const pass = out.filter((r) => r.remoteVerdict === 'PASS')
log(`Done: ${pass.length}/${APPS.length} verified PASS on Hetzner`)
return out.map((r) => ({
  app: r.app, remoteVerdict: r.remoteVerdict,
  featuresAdded: (r.featuresAdded || []).length, robustnessFixes: (r.robustnessFixes || []).length,
  testsAdded: r.testsAdded, testsTotalAfter: r.testsTotalAfter, deferred: r.deferred, blockers: r.blockers,
}))
