# Vite + React + TypeScript on CE

A completely ordinary `npm create vite@latest`-style React + TypeScript counter — same structure, same tooling — with exactly one change to make it stateful on CE: the count is read and written through `ce.db.get` / `ce.db.set` (the namespaced CE database). This is the "bring your own project" proof: your existing Vite app runs unchanged, you add a single backend call, and `npm i && npm run build` yields a static `dist/` that `ce-app deploy` pushes live to `https://ce-net.com/apps/<id>/`, persisting across refreshes and devices with no server of your own.
