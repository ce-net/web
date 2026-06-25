export const meta = {
  name: 'scale-primitives-design',
  description: 'Design the scaling primitives for a many-app, interdependent, concurrent CE: shared architecture contract first, then parallel per-primitive implementation-ready designs, then a coherence + build-order synthesis. Markdown only (no builds).',
  phases: [
    { title: 'Foundation', detail: 'one agent: the shared scaling architecture contract every design follows' },
    { title: 'Design', detail: 'one agent per primitive: implementation-ready design doc' },
    { title: 'Synthesis', detail: 'one agent: coherence review + dependency-ordered build roadmap' },
  ],
}

const ROOT = '/Users/07lead01/ce-net'
const DOCS = `${ROOT}/PLAN/scale`

const GROUND = `
GROUND TRUTH — read before designing (the real CE surface; do NOT edit any of it, read-only):
  - ${ROOT}/ce/docs/primitives.md (CE-vs-app boundary + what CE gives everyone), ${ROOT}/ce/docs/frontier.md (committed roadmap), ${ROOT}/CLAUDE.md.
  - ${ROOT}/ce-rs/src (the Rust SDK to the local node: mesh send/subscribe/publish/request/reply/messages_stream, atlas, advertise_service/find_service, claim/resolve_name, blobs put/get_object, channels, mesh_deploy/kill).
  - ${ROOT}/ce/crates/ce-mesh/src/lib.rs (RpcRequest/RpcResponse over /ce/rpc/1, gossipsub "ce-app/<topic>"), ${ROOT}/ce/crates/ce-node/src (HTTP API routes /mesh/*, the inbox).
  - ${ROOT}/ce-coord/src (RMap single-writer log, Merged multi-writer CRDT, Stream, Raft group, the pump) — the SDK coordination tier.
  - The matured apps that already embody pieces: ${ROOT}/ce-pubsub (queue/topics), ${ROOT}/ce-db (Firestore), ${ROOT}/ce-iam (ce-cap), ${ROOT}/ce-gke (orchestration), ${ROOT}/ce-query.

BOUNDARY RULE (honor it): CE is primitives-only. The NODE owns generic transport/enforcement mechanisms (context propagation, flow control, rate limiting, idempotency dedup). The ce-coord SDK tier owns coordination primitives (registry, binding, queue, log, locks, saga, election) as typed APIs over the node. Each design MUST state where it lives (node-plane vs ce-coord-plane) and why, and MUST NOT require new ad-hoc node RPCs where a generic AppRequest/pubsub/stream suffices. Authorization between apps is always a signed attenuating ce-cap chain through the local node (the security invariant: stranger code talks ONLY through the local node).
`

const DESIGN_SHAPE = `
Each design doc must be implementation-ready and contain, in order:
  1. Purpose & the at-scale problem it solves (many interdependent apps, concurrency).
  2. Plane: node vs ce-coord, and the justification.
  3. Public API: exact Rust SDK signatures (ce-rs/ce-coord), TS SDK signatures (ce-ts), and any node HTTP routes + wire types (bincode/serde structs). Reuse existing types; cite them.
  4. Protocol & data structures: topics/RPC used, state layout, algorithms (with the key invariants).
  5. Semantics & failure modes: delivery/ordering/consistency guarantees, partition/crash behavior, what it does NOT guarantee.
  6. Security & economy: ce-cap abilities involved, abuse/DoS bounds, optional payment-channel metering.
  7. Composition: which OTHER scale primitives it depends on or enables (reference their doc by filename).
  8. Test plan: deterministic cores to unit-test; integration/property tests; what needs a live multi-node mesh.
  9. Worked example: tie it to a real app or game (e.g. service-binding for a sharded game backend; tracing across an inter-app request).
  10. Effort (S/M/L/XL) and a minimal first slice.
Write concise but complete markdown. No emojis. Ground every claim in the real code (cite file paths). Do NOT implement code; this is design.
`

// node = transport/enforcement plane ; coord = ce-coord SDK coordination plane
const PRIMS = [
  { id: '01-service-registry-binding', title: 'Service registry, binding/resolver & health contract', plane: 'coord (over discovery DHT) + node health', focus: 'Discover a HEALTHY instance of a named, versioned service (not just "a provider exists"); declare app dependencies (needs storage@^1, db@^2) and resolve them to live endpoints at startup; a standard health/readiness contract the registry filters on. Builds on advertise_service/find_service + atlas. This is literally the "dependencies" mechanism.' },
  { id: '02-load-balancing-placement', title: 'Load balancing & latency-aware placement', plane: 'coord over atlas + registry', focus: 'Pick the least-loaded HEALTHY instance; latency-graph/atlas-aware host selection for placing cells and routing calls; client picks nearest. Backpressure-aware. Enables sharded/replicated services to spread load.' },
  { id: '03-durable-queue', title: 'Durable work queue (ack/lease/retry/DLQ/ordering/flow-control)', plane: 'coord (productize ce-pubsub) + node delivery', focus: 'At-least-once delivery, explicit ack/nack/modify-deadline (lease-based), retry policy, dead-letter, ordering keys, flow control (max outstanding). Decouples producers/consumers between apps. Relate to ce-pubsub which is already heading here.' },
  { id: '04-event-log-stream', title: 'Event log / replayable stream (partitions, offsets, consumer groups, compaction)', plane: 'coord over ce-coord logs + blobs', focus: 'Kafka-shaped durable, partitioned, replayable event log: offsets, consumer groups, compaction, retention. Many apps subscribe to one app change-feed; replay for recovery. Builds on ce-coord RMap/Merged logs + content-addressed blobs.' },
  { id: '05-resilient-rpc', title: 'Resilient RPC (deadlines, retries, hedging, circuit breakers, idempotency-on-call)', plane: 'NODE transport plane + SDK client', focus: 'Make AppRequest survive scale: per-call timeout + DEADLINE PROPAGATION across hops, retry with budget, request hedging, circuit breaking on a failing peer, idempotency key so a retried call has exactly-once effect. The service-mesh data plane.' },
  { id: '06-distributed-tracing', title: 'Distributed tracing & context propagation', plane: 'NODE transport plane + collector app', focus: 'Propagate a trace/span context on every AppRequest/pubsub/queue hop so one user action is followable across N apps; a lightweight collector/visualizer. THE highest-leverage operability primitive once apps depend on each other. Define the context header/envelope and how the node injects/forwards it.' },
  { id: '07-telemetry-metrics-health', title: 'Telemetry: metrics/SLIs & health', plane: 'node export + coord aggregation (extend atlas)', focus: 'Standard counters/histograms (latency, error rate, throughput) exported across the mesh and aggregated (extend the atlas from capacity to app-level SLIs); the health/readiness signal the registry/LB consume. Per-app dashboards.' },
  { id: '08-locks-leases-election', title: 'Distributed locks, leases & leader election', plane: 'coord over a Raft group', focus: 'Mutual exclusion, time-bounded leases with fencing tokens, and leader election so apps run singletons / own shards safely. Over the existing ce-coord Raft. Needed the moment state shards (game sectors, queue partitions).' },
  { id: '09-ordering-exactly-once', title: 'Causal time (HLC), idempotency keys & distributed counters/sequences', plane: 'NODE (HLC + dedup) + coord (counters)', focus: 'Hybrid logical clocks for causal ordering of events across apps; idempotency-key dedup for exactly-once effects; monotonic counters/sequences without a central allocator (CRDT or chain-anchored). Underpins resilient-RPC and queues.' },
  { id: '10-saga-workflow', title: 'Saga / durable cross-app workflow orchestration', plane: 'coord over queue + locks + Raft', focus: 'Durable multi-step cross-app transactions with compensation (no global ACID on a mesh). Step persistence, retries, compensation on failure. Composes queue, locks, idempotency.' },
  { id: '11-flow-control-rate-limiting', title: 'Flow control, rate limiting, quotas & admission control', plane: 'NODE enforcement, economy-tied', focus: 'Per-identity / per-capability rate limits and quotas, credit-based backpressure across the mesh, admission control — so one app cannot sink the mesh. Tie higher quota to paying credits (economy = built-in DoS resistance + fair sharing).' },
  { id: '12-schema-contract-registry-config', title: 'Schema/contract (IDL) registry & config/feature-flag distribution', plane: 'coord', focus: 'Versioned, validated message contracts (IDL + registry) so app B evolves its API without breaking app A (compat checking); plus consistent config/feature-flag distribution to many apps. What makes a many-app ecosystem survivable.' },
]

phase('Foundation')
const foundation = await agent(
  `You are the chief architect for CE's scaling layer. Write the SHARED ARCHITECTURE CONTRACT that every per-primitive design will follow, to ${DOCS}/00-architecture.md.

It must define, grounded in the real code:
  - The node-plane vs ce-coord-plane boundary (with the rule that the node owns generic transport/enforcement and ce-coord owns coordination), and a one-line placement for each of the 12 primitives below.
  - A common request/message ENVELOPE that carries cross-cutting context (trace/span id, deadline, idempotency key, capability token, tenant/namespace) — reuse/extend the existing RpcRequest/AppRequest + gossipsub envelope; show the struct.
  - A capability ABILITY naming convention for scale primitives (opaque ce-cap strings, e.g. svc:register, queue:consume, lock:acquire, ...).
  - The error/status model and how partial failure is surfaced.
  - The DEPENDENCY GRAPH among the 12 primitives (which build on which) and the resulting build order.
  - Multi-tenancy / namespacing approach so many apps' topics/state/identity scopes don't collide.

The 12 primitives (id -> plane -> focus):
${PRIMS.map((p) => `  - ${p.id}: [${p.plane}] ${p.title} — ${p.focus}`).join('\n')}

${GROUND}
Return a short summary; the real output is the written 00-architecture.md.`,
  { label: 'foundation', phase: 'Foundation', effort: 'high' }
)
log('Foundation contract written; fanning out per-primitive designs')

phase('Design')
const designs = await parallel(PRIMS.map((p) => () =>
  agent(
    `You are a distributed-systems designer. Write an implementation-ready design for the CE scaling primitive "${p.title}" to ${DOCS}/${p.id}.md.

Plane (proposed): ${p.plane}. Focus: ${p.focus}

FIRST read the shared contract ${DOCS}/00-architecture.md and conform to it (the envelope, ability naming, error model, boundary, namespacing). Then read the relevant real code.

${DESIGN_SHAPE}
${GROUND}

Return a short summary (3-5 bullets); the real output is the written ${p.id}.md.`,
    { label: p.id, phase: 'Design', effort: 'high' }
  )
))
log(`Designs written: ${designs.filter(Boolean).length}/${PRIMS.length}`)

phase('Synthesis')
const synthesis = await agent(
  `You are the architecture reviewer. Read ${DOCS}/00-architecture.md and all ${DOCS}/0*.md and ${DOCS}/1*.md design docs. Write ${DOCS}/99-roadmap.md containing:
  - A coherence review: conflicts, overlaps, gaps, and inconsistencies with the shared contract (name them with the doc + fix).
  - The dependency-ordered BUILD ROADMAP in waves (what to build first → last), with each primitive's target repo/crate (ce-coord vs a node change in ce/ vs a new app crate) and effort.
  - A flag on anything that requires editing the HOT node repo ce/ (vs safe ce-coord/app-tier work), since those need careful coordination.
  - The 2-3 primitives that most make CE visibly a "global supercomputer" for the demos/games, and which game/app should showcase each.

Return a short summary; the real output is 99-roadmap.md.`,
  { label: 'synthesis', phase: 'Synthesis', effort: 'high' }
)

return { foundation: !!foundation, designs: designs.filter(Boolean).length, synthesis: !!synthesis, docsDir: DOCS }
