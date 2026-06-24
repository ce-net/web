# ce-app templates

Self-contained, deployable starter projects for the CE app platform. Scaffold one with
`ce-app new <template>`, then `npm i && npm run build` and `ce-app deploy` to push it live to
`https://ce-net.com/apps/<id>/`.

| Template      | What it shows                          | CE features used                                  |
| ------------- | -------------------------------------- | ------------------------------------------------- |
| `chat`         | Realtime group chat (the showcase)     | `room('lobby')` live + presence, `db` history      |
| `notes`        | Collaborative notes / guestbook        | `db` persistence + `room('notes')` live updates    |
| `board`        | Multiplayer live cursors + whiteboard  | `room('board')` only — ephemeral pub/sub           |
| `vite-react`   | Stock Vite + React + TS counter        | one `db.get`/`db.set` added to an ordinary project |
| `svelte`       | Vite + Svelte + TS shared counter      | `db.set` + `room('counter')` live sync             |
| `react`        | Vite + React Router SPA (3 routes)     | proves SPA fallback; `/counter` uses `db`          |
| `next`         | Next.js App Router static export       | prerendered to `out/`; client `db.set`             |
| `react-native` | Expo react-native-web UI               | one RN component exported to web; `db.set`         |

Each template ships a small `ce.ts` (the framework's `@ce/client` contract:
`createClient().db` over `/db/<app>/<key>`, `.room(name)` over `ws /rt/<app>/<room>`) against the
same-origin CE hub, so they build and run with zero install. Swap the `./ce` import for the
published `@ce/client` package if you prefer. Every template builds to a static output directory with
relative asset paths so it serves correctly under the `/apps/<id>/` prefix and on a custom subdomain.

Framework-specific notes:

- `react` carries `react-router-dom` to exercise client-side routing: navigate to a route, hard-refresh,
  and the hub's SPA fallback serves `index.html` so the deep link resolves. The router basename is
  derived at runtime from the mount path.
- `next` uses `output: "export"` (`out/`), `trailingSlash`, and a relative `assetPrefix`.
- `react-native` exports the web target with `expo export --platform web --output-dir dist`; the same
  component also runs natively under `expo start`. Its `npm i` is heavier than the Vite templates.

`ce-app deploy` runs the right build for the detected framework, uploads the static output, and sets
`spa=true` on the app so client-side routers work in production.
