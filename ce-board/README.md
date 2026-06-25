# ce-board

**ce-board is a real-time collaborative kanban board that syncs over the CE mesh** —
columns and draggable cards, shared live between everyone on the same board id, with no
central server. Each mutation (add/edit/move/delete a card or column) is a small CRDT
operation stamped with a Lamport clock and the originating client id; ops are published
to a CE pubsub topic, every peer folds them in by **last-writer-wins per field**, and
because the `(lamport, client)` stamp is a total order the fold is commutative,
idempotent, and convergent — so two browser tabs (or two people on two nodes) always
reach byte-identical state. The board snapshot is persisted as a content-addressed CE
object (CID) for fast bootstrap, then clients tail live ops. It is built entirely on the
published [`@ce-net/sdk`](https://www.npmjs.com/package/@ce-net/sdk): real mesh pubsub,
real SSE streams, real blob/object storage — talking to a local CE node at
`http://127.0.0.1:8844`.

## Run it against a CE node

1. Start a node (HTTP API on `127.0.0.1:8844`):

   ```bash
   ce start
   ```

2. Install and run the dev server:

   ```bash
   cd ce-board
   npm install
   npm run dev          # http://localhost:5176
   ```

   The Vite dev server proxies `/ce-api` → `127.0.0.1:8844`, so the browser streams SSE
   and POSTs without CORS friction.

3. Open the app, type a board id (e.g. `harbor`), and start adding columns and cards.
   **Open the same board id on a second node in the same mesh** — point a second browser
   at a second `ce start` (e.g. your desktop, or another machine joined via the relay) —
   and edits, moves, and deletes converge in real time. A remote op pulses a sonar ring
   on the card it touched and lights up that peer's vessel on the bridge bar.

   > Mesh note: CE pubsub uses libp2p gossipsub, which does **not** echo a node's own
   > publishes back to itself. So two tabs on the *same* node won't see each other (each
   > tab applies its own ops optimistically, but there's no self-echo to merge); cross-node
   > peers on the same board id do converge. ce-board applies every local op immediately,
   > so it never depends on the echo — it only folds genuinely remote ops.

> No CE node running? The app shows a clear offline banner with a Reconnect button and
> the exact `ce start` hint — it never silently fakes data. The data path is always the
> real SDK; the only in-memory adapter lives in `test/` for the unit suite.

## Build & test

```bash
npm run build   # tsc -b + vite build  → dist/
npm test        # vitest (66 unit tests; no node required)
```

The unit tests run with the SDK mesh/data layer mocked by an in-memory fake (`test/fakes.ts`)
and hammer the convergence guarantee directly: random op permutations fold to identical
state, duplicated ops (the mesh self-echo) are idempotent, and concurrent moves of the
same card resolve deterministically on every replica.

## How it works

| Layer | File | Role |
|---|---|---|
| CRDT op-log | `src/core/oplog.ts` | Stamp ordering, per-field LWW fold, fractional drag ranks. The convergence core. |
| Wire protocol | `src/core/protocol.ts` | Versioned, board-scoped op envelope; total/defensive decode. |
| Snapshots | `src/core/snapshot.ts` | Materialize the board to a CE object + per-client clock frontier. |
| Service | `src/core/service.ts` | Subscribe / publish / fold over the mesh; optimistic local apply; snapshot bootstrap. |
| SDK adapter | `src/core/sdk-adapter.ts` | The only module that imports `@ce-net/sdk` for the data path. |
| View | `src/ui/board-view.ts` | Columns, cards, drag-and-drop, inline edit, sonar pulse. |
| Shell | `src/main.ts` | Bridge bar, fleet of peer vessels, status ledger, banners, toasts. |

### Topics

A board is one CE pubsub topic carrying its live op stream:

```
board "harbor"  →  ce-board/ops/harbor
```

Everyone on the same board id subscribes to the same topic and converges. The latest
snapshot CID is cached in `localStorage` for fast reboot; the op stream remains the
source of truth.

## Design

The interface is a **bathymetric (depth) chart**: columns are depth zones, cards are
sounding markers, peers are vessels on the surface bar. Palette is abyssal teal with a
warm buoy-amber reserved for live/remote signals; type pairs Space Grotesk (display) with
IBM Plex Sans (body) and IBM Plex Mono (node ids, CIDs, ranks). The one signature flourish
is the sonar pulse that ripples from a card when a peer's op lands on it, making mesh
convergence visible. Keyboard-accessible (cards are focusable; Enter/F2 edits, Delete
removes), responsive to mobile, and `prefers-reduced-motion` stills the animations.

## License

MIT © Leif Rydenfalk
