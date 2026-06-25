export const meta = {
  name: 'mesh-platform',
  description: 'Build the mesh-native app platform: unified window.__ceNode bridge + strict CSP, mesh-native @ce/client, ce-app register/serve/expose, ce-coord SSE pump. App-tier only (no HOT repos: never touch ce/ , ce-expose, ce-fabric).',
  phases: [{ title: 'Platform', detail: 'parallel agents, one per platform component' }],
}

const ROOT = '/Users/07lead01/ce-net'

const SHARED = `
SHARED CONTRACT — every agent must follow the SAME interface so the pieces fit together:

window.__ceNode (the in-browser node bridge, a "CeNodeBridge"):
  request(method: string, path: string, init?: {headers?, body?}) => Promise<{status, headers, body}>
  where path is a node HTTP API path ("/status", "/mesh/publish", "/mesh/subscribe", "/mesh/request",
  "/mesh/messages/stream", "/blobs/:hash", ...). The bridge dispatches IN-PROCESS to the in-browser
  WASM CE node — it NEVER touches the network. Sentinel base URL is "http://ce-browser-node.local".

bridgeFetch(bridge) => a fetch()-compatible function that turns fetch("http://ce-browser-node.local/<path>")
  into bridge.request(...). (web/play/src/bridge.ts already has the start of this — finish it.)

connectNode(opts?) => a CeClient (from @ce-net/sdk / ce-ts):
  - if window.__ceNode exists: new CeClient({ baseUrl: "http://ce-browser-node.local", fetch: bridgeFetch(window.__ceNode) })
  - else: new CeClient({ baseUrl: same-origin "/ce" })   // a native local/relay node reached via a same-origin reverse proxy
  BOTH transports are SAME-ORIGIN, which is what makes a single strict CSP work.

STRICT CSP (the confinement that makes "stranger code talks ONLY to the local node" true) — exact string:
  default-src 'self'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'
  connect-src 'self' means the page can reach ONLY its own origin (the node bridge / the /ce proxy) and nothing else — no ce-net.com/db, no cast.ce-net.com, no arbitrary fetch.
`

const RULES = `
SCOPE / SAFETY:
  - Work ONLY in the files/dirs your task names. NEVER edit the HOT repos: ${ROOT}/ce (the node), ${ROOT}/ce-expose, ${ROOT}/ce-fabric — other agents are actively building them; CSP is injected at the ce-app serve layer + the in-browser node instead.
  - Do NOT git commit or push. NO emojis anywhere. Keep conventions of each file (zero-dep ESM for the client; Node 18+ built-ins for ce-app.mjs; edition 2024 + anyhow + tracing for Rust).
  - Rust builds: the laptop disk is tiny — do NOT run cargo locally. Build/test on the Hetzner box with: cd ${ROOT} && tools/remote-test.sh <crate> (see ${ROOT}/tools/README.md). Iterate until it prints PASS.
  - JS/TS: build/typecheck locally (npm/tsc/vitest are cheap). Keep existing build scripts working.
  - REAL implementations only — no stubs, no fake tests, document anything deferred honestly.
`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['component', 'done', 'filesTouched', 'howVerified', 'verified', 'deferred', 'notes'],
  properties: {
    component: { type: 'string' },
    done: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    howVerified: { type: 'string' },
    verified: { type: 'boolean' },
    deferred: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const TASKS = [
  {
    label: 'bridge+csp',
    prompt: `Build the unified browser node bridge and the CSP constant.

Deliverables:
1. Finish ${ROOT}/web/play/src/bridge.ts: complete the CeNodeBridge contract and bridgeFetch (the file has the start + a TODO). Make bridgeFetch fully route "http://ce-browser-node.local/<path>" requests to window.__ceNode.request, including SSE/stream responses (/mesh/messages/stream) and binary bodies (/blobs).
2. Promote the reusable logic into a shared module ${ROOT}/ce-ts/src/browser-node.ts exporting: getBridge(), bridgeFetch(bridge), connectNode(opts?) (returns a CeClient per the SHARED CONTRACT), and CE_STRICT_CSP (the exact CSP string). Re-export from ce-ts index. Keep ce-ts building (cd ${ROOT}/ce-ts && npx tsc --noEmit or npm run build).
3. Implement the window.__ceNode producer page ${ROOT}/web/site/node.html: load/boot the in-browser CE node and install window.__ceNode implementing request(...) by dispatching to the in-browser node. If a full in-browser node isn't bootable here, implement the bridge against the documented in-browser node interface and clearly mark what the node side must provide (do not fake the node). Look for an existing in-browser node (ce-net.com/node, web/site, web/ce-hub, wasm) and wire to it.

${SHARED}
${RULES}
Return the structured report.`,
  },
  {
    label: 'mesh-client',
    prompt: `Rewrite the legacy centralized @ce/client into a mesh-native client with the SAME ergonomic surface.

File: ${ROOT}/web/ce-app/client/index.js (zero-dependency browser ESM). Keep the public API identical:
  createClient(opts?) -> { appId, base, db:{get,set,del,list}, room(name)->{send,on,onOpen,close} }
But back it by the mesh via the bridge (SHARED CONTRACT), NOT the central hub:
  - Replace db (was GET/PUT/DELETE /db/<app>/<key> on ce-net.com) with a mesh-backed per-app store: publish ops on gossipsub topic "ce-coord/app/<appId>/db" via the node's /mesh/publish, converge by consuming /mesh/messages/stream (SSE), and snapshot/load the log via /blobs (content-addressed). Model it on the proven ce-coord RMap pattern (single-writer log + catch-up). list(prefix,limit) returns newest-first from the converged map.
  - Replace room (was wss /rt/<app>/<room>) with mesh pub/sub: subscribe topic "ce-app/<appId>/room/<name>" (/mesh/subscribe) and stream inbound via /mesh/messages/stream (SSE); send via /mesh/publish. Low latency — use the SSE stream, no polling.
  - Reach the node via connectNode() from the bridge module (window.__ceNode or same-origin /ce). NEVER fetch ce-net.com/db, /rt, or any remote origin.
Keep it dependency-free and working when served behind the strict CSP (same-origin only). Add a short usage note in a comment. If there is a test harness for the client, keep it green; otherwise add a tiny self-check.

${SHARED}
${RULES}
Return the structured report.`,
  },
  {
    label: 'ce-app',
    prompt: `Evolve the ce-app CLI from "upload static files to the central hub" to "register on the mesh + serve + expose one sub-app's domain over mesh HTTP ingress".

File: ${ROOT}/web/ce-app/bin/ce-app.mjs (Node 18+, built-in crypto). Read it fully first; reuse its framework detection (detectFramework), build, identity/signing, and ce-expose/claim_name helpers.

Add/!change commands:
  - "ce-app register": register this app on the mesh — claim its name (reuse the same claim_name path ce-expose uses) and advertise discovery; print the app's mesh identity/name. No central hub.
  - "ce-app serve [--sub <which>] [--port N]": build the chosen sub-app (default the detected frontend) and run a tiny local static HTTP server that (a) serves the built output, (b) injects the STRICT CSP header on every HTML/response, (c) injects the window.__ceNode bridge bootstrap (script tag to the bridge), and (d) reverse-proxies a same-origin "/ce" path to the local node at 127.0.0.1:8844 (so same-origin mesh calls work under CSP). This server is the per-app frontend host that replaces hub static hosting.
  - "ce-app expose --domain <name> [--sub <which>]": run the ce-expose ORIGIN agent (shell out to the ce-expose binary: \`ce-expose http <servePort> --name <name>\`) against the serve port, so https://<name>.user.ce-net.com serves this app over mesh ingress. Print the URL. Do NOT edit the ce-expose repo — just invoke its binary.
  - Retarget "ce-app dev"/"deploy" to use serve (+ optionally expose) instead of PUTting files to https://ce-net.com/apps/... Keep --hub as a legacy escape hatch but default to mesh serve.

Verify by running \`node bin/ce-app.mjs --help\` and \`ce-app detect\`/\`serve\` against a template dir (e.g. ${ROOT}/web/ce-app/templates/vite-react) to confirm serve boots, injects CSP, and the /ce proxy path is wired. Do not break existing subcommands.

${SHARED}
${RULES}
Return the structured report.`,
  },
  {
    label: 'ce-coord-sse',
    kind: 'rust',
    prompt: `Make ce-coord realtime (low latency) by replacing its polling pump with the node's SSE stream.

Repo: ${ROOT}/ce-coord (this is a SEPARATE repo from ce/ — safe to edit). In ${ROOT}/ce-coord/src/lib.rs the pump currently polls ce.messages() every 250ms (spawn_pump). Replace it to consume the node's Server-Sent-Events stream GET /mesh/messages/stream (ce-rs already exposes messages_stream()/an SSE method — confirm in ${ROOT}/ce-rs/src). Dispatch each streamed message to the registered handlers with the same de-dup-by-fingerprint logic. Fall back to polling only if the stream errors/reconnects (keep a reconnect/backoff loop). This removes the up-to-250ms delay so collections/streams update in real time.

Keep the public ce-coord API unchanged; keep all existing tests passing and add a test for the streaming pump path if feasible.

BUILD/TEST ON HETZNER (laptop disk is tiny — do NOT run cargo locally):
  cd ${ROOT} && tools/remote-test.sh ce-coord --clippy
Iterate until it prints "REMOTE-TEST ce-coord: PASS".

${SHARED}
${RULES}
Return the structured report.`,
  },
]

phase('Platform')
const results = await parallel(TASKS.map((t) => () =>
  agent(t.prompt, { label: t.label, phase: 'Platform', schema: SCHEMA, effort: 'high' })
))
const out = results.filter(Boolean)
log(`Platform: ${out.filter((r) => r.verified).length}/${TASKS.length} verified`)
return out
