# CE Board

A multiplayer live-cursors whiteboard built purely on CE realtime rooms — no database, intentionally ephemeral. Every pointer move and pen stroke is broadcast over `ce.room('board')` to everyone else viewing the same app, so you see named, colored cursors gliding around and ink appearing in real time; "Clear" wipes the canvas for the whole room. Coordinates are normalized so it lines up across different screen sizes, and it's touch-friendly. `npm i && npm run build` produces a static `dist/` that `ce-app deploy` uploads to `https://ce-net.com/apps/<id>/`.
