# Svelte on CE

A Vite + Svelte + TypeScript starter: a counter that persists to the CE database (`ce.db.set`) and broadcasts changes over a live room (`ce.room('counter')`), so every open tab stays in sync. Run `npm i && npm run build` to produce a static `dist/` with relative asset paths (it serves correctly under `/apps/<id>/` or on a custom subdomain), then `ce-app deploy` to push it live. The local `src/ce.ts` implements the `@ce/client` contract against the same-origin hub — swap it for the published `@ce/client` package if you prefer.
