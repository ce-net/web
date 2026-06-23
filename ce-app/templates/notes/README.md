# CE Notes

A collaborative notes board / guestbook that proves CE persistence + multiplayer in one screen: every note is durably stored in the CE database (`ce.db.set` / `ce.db.list` / `ce.db.del`, namespaced per app) so it survives refreshes and restarts, while a realtime room (`ce.room('notes')`) instantly fans new and deleted notes out to every other open tab. Sign your notes with a name, post with ⌘/Ctrl+Enter, delete your own. `npm i && npm run build` emits a static `dist/` for `ce-app deploy` to push to `https://ce-net.com/apps/<id>/`.
