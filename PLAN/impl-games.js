export const meta = {
  name: 'mesh-games',
  description: 'Every game is a flagship showcase of the WHOLE CE stack: distribution across nodes, concurrency, latency-aware placement, replication, distributed state (CRDT), and consensus. Real Rust mesh backends, built on Hetzner; frontends over the mesh only.',
  phases: [{ title: 'Games', detail: 'one agent per game: deep multi-node showcase backend + frontend' }],
}

const ROOT = '/Users/07lead01/ce-net'

// Each game deeply implements the capabilities that FIT it best (its "showcase" set);
// collectively the suite exercises every part of CE. Not one shallow server each.
const GAMES = [
  { name: 'arena', dir: 'web/demos/arena', desc: 'real-time multiplayer arena/shooter',
    showcase: 'DISTRIBUTION (authoritative sim runs as a deployed CELL placed on another node via mesh_deploy), LATENCY (atlas-guided placement: pick the lowest-latency capable host; clients pick nearest room host), CONCURRENCY (many independent rooms/cells at once), CONSENSUS (kill/score leaderboard committed on-chain so scores are tamper-proof), REPLICATION (periodic authoritative snapshot to blobs + ce-pin for crash-recovery/failover).' },
  { name: 'coop', dir: 'web/demos/coop', desc: 'cooperative multiplayer with a shared objective',
    showcase: 'DISTRIBUTED STATE (shared world state as a ce-coord Merged multi-writer CRDT — converges offline, no central server), REPLICATION (snapshot/compact to blobs + ce-pin), LATENCY (SSE realtime, nearest-host), CONCURRENCY (multiple co-op instances).' },
  { name: 'cursors', dir: 'web/demos/cursors', desc: 'live shared cursors at scale',
    showcase: 'CONCURRENCY + SCALE (thousands of cursors via sharded gossipsub topics / rendezvous-hashed shards across nodes), LATENCY optimization (interest management: only nearby cursors; nearest relay), DISTRIBUTION (shard ownership spread across nodes), STATE (ce-coord presence map).' },
  { name: 'draw', dir: 'web/demos/draw', desc: 'collaborative infinite drawing canvas',
    showcase: 'DISTRIBUTED STATE (strokes as a ce-coord CRDT log, conflict-free), REPLICATION (canvas snapshots content-addressed to blobs + ce-pin across N nodes), LATENCY (SSE realtime), DISTRIBUTION (tile/region sharding across nodes for an infinite canvas).' },
  { name: 'place', dir: 'web/demos/place', desc: 'r/place-style shared pixel canvas',
    showcase: 'DISTRIBUTION (canvas SHARDED across nodes by rendezvous-hash on tile id), CONSENSUS (per-pixel write ordering + per-identity cooldown enforced via a ce-coord Raft group or on-chain claim so double-paint/cooldown-cheat is impossible), REPLICATION (tiles pinned to multiple nodes), CONCURRENCY (many writers), LATENCY (write to nearest tile-owner).' },
  { name: 'poll', dir: 'web/demos/poll', desc: 'live poll / voting',
    showcase: 'CONSENSUS (one-vote-per-CE-identity uniqueness enforced on-chain — the case CRDTs provably cannot do), DISTRIBUTION + CONCURRENCY (parallel map/reduce tally across worker cells on many nodes), REPLICATION (verifiable result pinned to blobs), LATENCY (live SSE results).' },
  { name: 'spacegame', dir: 'web/demos/spacegame', desc: 'multiplayer space game, authoritative sim',
    showcase: 'DISTRIBUTION (authoritative physics sim deployed as a CELL on a latency-optimal node via atlas + mesh_deploy), LATENCY (atlas/latency-graph host selection; regional sharding of space sectors across nodes for scale), REPLICATION (sim snapshot to blobs + ce-pin, failover to a replica), CONSENSUS (leaderboard/economy on-chain), CONCURRENCY (per-sector cells).' },
  { name: 'wall', dir: 'web/demos/wall', desc: 'shared message/graffiti wall',
    showcase: 'DISTRIBUTED STATE (append-only message log as a ce-coord RMap/Merged CRDT), REPLICATION (log content-addressed to blobs + ce-pin, served from any node = the CDN-is-every-node property), CONSENSUS (total order via the writer-log version / optional chain anchor), LATENCY (SSE realtime).' },
]

const MENU = `
CE CAPABILITY MENU -> exact SDK surface (use REAL calls; ce-rs is the Rust SDK to the LOCAL node which does libp2p; ce-coord is the CRDT/coordination crate over ce-rs):
  - DISTRIBUTION / run logic on OTHER nodes: ce.atlas() to see capacity; ce.mesh_deploy(node_id, spec, grant) / mesh_deploy_wasm to place an authoritative cell on a chosen node; ce.advertise_service / find_service to register & discover room hosts across the mesh; rendezvous-hash to shard state/rooms across nodes.
  - CONCURRENCY: many rooms/sectors/shards as independent cells/tasks running at once; parallel fan-out (tokio tasks, parallel requests).
  - LATENCY OPTIMIZATION: atlas + the latency graph to select the lowest-latency capable host for a room; clients choose nearest host; interest management (only send what a client needs); SSE (/mesh/messages/stream) not polling for realtime.
  - REPLICATION: ce.put_object()/get_object() (content-addressed chunked blobs) for state snapshots; pin to multiple nodes (ce-pin) for redundancy/failover; content-addressed = "every node is a CDN edge".
  - STATE (distributed, offline-capable): ce-coord RMap<K,V> (single-writer log + catch-up), Merged<M> (multi-writer CRDT), Stream<T> (realtime) over gossipsub; snapshot/compact to blobs.
  - CONSENSUS: the PoW chain for global uniqueness / money / tamper-proof leaderboards (the things CRDTs provably cannot do — e.g. one-vote-per-identity, exactly-once claims, integer scores); OR an app-scoped ce-coord Raft group for authoritative ordering among cooperating writers.
  - ECONOMY / payment channels: ce.channel_open / sign_receipt / channel_close to pay a hosting node per tick/action (the marketplace angle) — include where it fits.
  - AUTH: CE identity (NodeId = the player, free unforgeable auth) + ce-cap capabilities to gate room access / host authority. No central auth server.
  - REALTIME: ce.subscribe/publish on gossipsub topics + ce.messages_stream() (SSE).
`

const SHARED = `
ARCHITECTURE: the backend is a Rust binary (+ a lib for tests) that connects to the LOCAL node via ce-rs and uses the mesh. The FRONTEND talks to the backend ONLY over the same-origin node bridge (window.__ceNode if present, else same-origin "/ce") via /mesh/* + SSE — never ce-net.com/db, /rt, or any remote origin. Players are CE NodeIds.

Reference FIRST: ${ROOT}/web/docs/netgame.md, ${ROOT}/web/ce-app/templates/rust-game/, ${ROOT}/web/ce-app/client/netgame.js, and the real SDK surface in ${ROOT}/ce-rs/src and ${ROOT}/ce-coord/src (confirm exact method names before using them).
`

const RULES = `
SCOPE / SAFETY:
  - Backend = a NEW top-level crate ${ROOT}/game-<name> (own Cargo.toml; path-deps "../ce-rs", and "../ce-coord"/"../ce" only if used). Independent crate (no shared workspace) so parallel builds don't race. Some game-<name> crates may already exist from a prior baseline run — READ and EXTEND them to the full showcase, don't start over.
  - Edit ONLY your game's frontend dir + your backend crate. NEVER touch HOT repos ${ROOT}/ce, ${ROOT}/ce-expose, ${ROOT}/ce-fabric, the ce-rs/ce-coord SDK source, or other games.
  - No git commit/push. No emojis. Rust: edition 2024, anyhow, tracing (not println!) in lib code, no unsafe, no prod-path unwrap, tests in #[cfg(test)].
  - REAL implementations + REAL tests for the deterministic cores (simulation tick, sharding/rendezvous-hash, CRDT merge, snapshot (de)serialization, consensus/uniqueness logic). Full live multi-node behavior needs a running mesh to demo — implement the real code paths and unit/integration-test the deterministic parts; document in the crate README what each CE capability it showcases is and what needs a live multi-node mesh to see end-to-end. NO faking a capability you didn't wire.
  - BUILD/TEST ON HETZNER (laptop disk is tiny — never cargo locally): cd ${ROOT} && tools/remote-test.sh game-<name> --clippy ; iterate to "REMOTE-TEST game-<name>: PASS".
`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['game', 'backendCrate', 'capabilitiesShowcased', 'features', 'meshTopics', 'frontendWired', 'remoteVerdict', 'testsAdded', 'deferred', 'filesTouched', 'notes'],
  properties: {
    game: { type: 'string' },
    backendCrate: { type: 'string' },
    capabilitiesShowcased: { type: 'array', items: { type: 'string' }, description: 'which of distribution/concurrency/latency/replication/state/consensus/economy are really wired' },
    features: { type: 'array', items: { type: 'string' } },
    meshTopics: { type: 'array', items: { type: 'string' } },
    frontendWired: { type: 'boolean' },
    remoteVerdict: { type: 'string', enum: ['PASS', 'FAIL', 'not-run'] },
    testsAdded: { type: 'integer' },
    deferred: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

phase('Games')
const results = await parallel(GAMES.map((g) => () =>
  agent(
    `You are a senior distributed-systems + netcode engineer. Make the game "${g.name}" (${g.desc}) a FLAGSHIP demonstration that CE is a global supercomputer — it must genuinely exercise multiple parts of the stack, not be one shallow server.

Existing frontend: ${ROOT}/${g.dir} (read it; it currently cheats via central HTTP — replace with mesh).
Backend crate: ${ROOT}/game-${g.name} (may already exist as a baseline — extend it to the full showcase).

THIS GAME MUST DEEPLY SHOWCASE: ${g.showcase}

${MENU}
${SHARED}
${RULES}

Steps:
  1. Read the netgame reference, the existing ${g.dir} frontend, and the exact ce-rs/ce-coord SDK surface.
  2. Build/extend ${ROOT}/game-${g.name} so it really implements this game's showcase set above with REAL SDK calls (distribution via mesh_deploy/atlas/discovery, sharding via rendezvous-hash, state via ce-coord CRDTs, consensus via chain/Raft, replication via blobs+ce-pin, latency via atlas/SSE — whichever the showcase names). Authoritative where it matters; distributed/sharded for scale. Unit/integration-test the deterministic cores.
  3. Rewrite ${g.dir}'s frontend to drive it over the same-origin node bridge only (inputs + render authoritative/replicated state), removing every remote-HTTP cheat.
  4. Write a crate README mapping each showcased CE capability to where it is used and what a live multi-node mesh shows.
  5. Verify on Hetzner: tools/remote-test.sh game-${g.name} --clippy -> PASS.

Return the structured report; capabilitiesShowcased must list only what you REALLY wired.`,
    { label: `game:${g.name}`, phase: 'Games', schema: SCHEMA, effort: 'high' }
  )
))
const out = results.filter(Boolean)
log(`Games: ${out.filter((r) => r.remoteVerdict === 'PASS').length}/${GAMES.length} showcase backends PASS`)
return out
