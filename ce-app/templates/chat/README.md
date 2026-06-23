# CE Chat

A realtime group chat showcasing the CE app platform: the `lobby` realtime room (`ce.room('lobby')`) carries live messages and presence (who's online), while the CE database (`ce.db.set` / `ce.db.list`) keeps a durable message history that reloads on refresh. Each browser gets a stable public id and a chooseable name; messages show timestamps and sender. Polished, mobile-first dark UI in the CE aesthetic. `npm i && npm run build` produces a static `dist/` that `ce-app dev`/`deploy` uploads to `https://ce-net.com/apps/<id>/`.
