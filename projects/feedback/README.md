# feedback

A realtime feedback board that runs as a single CE mesh app. Post feedback, reply in
threads, and upvote, with one board per target project. Live via a `/rt` room, durable in
the `/db/feedback` KV store, with a drop-in shadow-DOM widget and soft community moderation.

Deployable to **feedback.ce-net.com** (also reachable at `ce-net.com/apps/feedback/`).

## Files

| File | Role |
|---|---|
| `index.html` | The standalone board. `?target=<project>` selects which project's board to show. |
| `embed.js` | Shadow-DOM drop-in widget. A floating button + panel, isolated from the host page. |
| `ce.json` / `ce-app.json` / `.ce/app-id` | ce-app deploy config; app id pinned to `feedback`. |

## How it works (mesh primitives only)

Two primitives, exactly like every other CE app:

- **Durable:** `PUT/GET /db/feedback/<key>`. Keys are namespaced per board (`<target>`):
  - posts `fb:<target>:<invTs>:<id>` — `invTs = (9999999999999 - ms)` zero-padded to 13 so newest sorts first
  - replies `rp:<target>:<tid>:<invTs>:<id>`
  - votes `vt:<target>:<tid>:<voterId>` (one record per identity; toggling overwrites)
  - flags `fl:<target>:<tid>:<flaggerId>`
  - soft-deletes `dl:<target>:<tid>:<authorId>`
- **Realtime:** `WS /rt/feedback/t:<target>`. Each board is its own room so projects never
  cross-talk. Frames are JSON: `{t:"fb"|"reply"|"vote"|"flag"|"del"|"join"|"ping", ...}`.
  The hub echoes frames to other peers; clients filter their own by `id`.

State is reconstructed on load by listing each key prefix; live frames apply the same
mutations so the embedded widget and the full board converge on one thread per target.

## Threads, replies, upvotes

- A **post** opens a thread. **Replies** hang off a thread by its `tid`.
- **Upvotes** are one-per-identity and toggle; score = distinct upvoter count.
- **Top** vs **New** sort on the standalone board.

## Soft moderation

Nothing is ever deleted from the store. A post is visually **collapsed** when
`flags - upvotes >= 4` (community) or when its author chooses **Hide mine** (a `dl:` record).
Viewers can always "Show anyway". This pairs with the hub's per-namespace IP rate limiter
(`CE_HUB_RATELIMIT_NS=feedback`) and an 8s client-side per-board cooldown.

## Embedding it anywhere

Auto (floating button bottom-right):

```html
<script src="https://feedback.ce-net.com/embed.js"
        data-target="my-project"
        data-host="https://feedback.ce-net.com"></script>
```

Manual mount into a container:

```html
<script src="https://feedback.ce-net.com/embed.js" data-auto="0"></script>
<script>
  CEFeedback.mount({ target: "my-project", host: "https://feedback.ce-net.com", el: document.querySelector("#fb") });
</script>
```

The widget renders inside a Shadow DOM (`:host{all:initial}`) so the host page's CSS and the
widget's CSS never collide. It shares the same board (`target`) as the standalone page, so
feedback left through the widget shows up at `feedback.ce-net.com/?target=my-project` and vice
versa. The `/projects` registry cards can link each project to its own board this way.

## Deploy

```bash
# from web/projects/feedback
ce-app publish      # static deploy of index.html + embed.js; app id pinned to "feedback"
```
