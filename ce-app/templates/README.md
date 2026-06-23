# ce-app templates

Self-contained, deployable starter projects for the CE app platform. Scaffold one with
`ce-app new <template>`, then `npm i && npm run build` and `ce-app deploy` to push it live to
`https://ce-net.com/apps/<id>/`.

| Template      | What it shows                          | CE features used                                  |
| ------------- | -------------------------------------- | ------------------------------------------------- |
| `chat`        | Realtime group chat (the showcase)     | `room('lobby')` live + presence, `db` history     |
| `notes`       | Collaborative notes / guestbook        | `db` persistence + `room('notes')` live updates   |
| `board`       | Multiplayer live cursors + whiteboard  | `room('board')` only — ephemeral pub/sub          |
| `vite-react`  | Stock Vite + React + TS counter        | one `db.get`/`db.set` added to an ordinary project |

Each template ships a small `src/ce.ts` that implements the `@ce/client` contract
(`createClient().db` over `/db/<app>/<key>`, `.room(name)` over `ws /rt/<app>/<room>`) against the
same-origin CE hub, so they build and run with zero install. Swap the `./ce` import for the
published `@ce/client` package if you prefer. All four build to a static `dist/` with relative asset
paths so they serve correctly under the `/apps/<id>/` prefix.
