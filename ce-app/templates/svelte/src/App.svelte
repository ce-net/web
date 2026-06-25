<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { createClient, type Room } from "./ce";

  // The two CE-specific lines: a client, and a live room for this app.
  const ce = createClient();
  const COUNT_KEY = "count";

  let count = 0;
  let ready = false;
  let room: Room | null = null;
  let off: (() => void) | null = null;

  onMount(async () => {
    // Load the persisted count from the CE database.
    const v = await ce.db.get(COUNT_KEY).catch(() => undefined);
    if (typeof v === "number") count = v;
    ready = true;

    // Subscribe to live updates so every open tab stays in sync.
    room = ce.room("counter");
    off = room.on((m) => {
      if (m && typeof m.count === "number") count = m.count;
    });
  });

  onDestroy(() => {
    off?.();
    room?.close();
  });

  async function bump(delta: number) {
    count += delta;
    await ce.db.set(COUNT_KEY, count).catch(() => {});
    room?.send({ count });
  }
</script>

<main>
  <div class="brand">
    <svg viewBox="0 0 32 32" width="24" height="24">
      <g fill="none" stroke="#37c6ff" stroke-width="2.4" stroke-linecap="round">
        <path d="M4 12c3 0 3 3 6 3s3-3 6-3 3 3 6 3 3-3 6-3" />
        <path d="M4 19c3 0 3 3 6 3s3-3 6-3 3 3 6 3 3-3 6-3" />
      </g>
    </svg>
    <span><span class="ce">Svelte</span> on CE</span>
  </div>

  <h1>Shared, <em>in real time</em></h1>
  <p class="lede">
    A Vite + Svelte + TypeScript counter. The value persists to the CE database with one
    <code>ce.db.set()</code> and broadcasts over <code>ce.room('counter')</code> — open this app in
    two tabs and watch them move together.
  </p>

  <div class="card">
    <button on:click={() => bump(-1)} aria-label="decrement">&minus;</button>
    <div class="num">{ready ? count : "…"}</div>
    <button on:click={() => bump(1)} aria-label="increment">+</button>
  </div>

  <p class="note">App <code>{ce.appId}</code>, db key <code>{COUNT_KEY}</code></p>
</main>

<style>
  main {
    position: relative;
    z-index: 1;
    max-width: 560px;
    margin: 0 auto;
    padding: 48px 22px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    font-family: var(--display);
    font-weight: 600;
    font-size: 18px;
  }
  .brand .ce {
    background: var(--grad);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  h1 {
    font-family: var(--display);
    font-weight: 600;
    font-size: clamp(28px, 7vw, 42px);
    letter-spacing: -0.02em;
    margin: 22px 0 0;
  }
  h1 em {
    font-style: italic;
    background: var(--grad);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .lede {
    color: var(--muted);
    font-size: 15.5px;
    line-height: 1.6;
    max-width: 52ch;
  }
  code {
    font-family: var(--mono);
    font-size: 0.86em;
    color: var(--cyan);
    background: rgba(116, 176, 255, 0.07);
    padding: 1px 6px;
    border-radius: 6px;
  }
  .card {
    display: flex;
    align-items: center;
    gap: 18px;
    justify-content: center;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: linear-gradient(180deg, var(--panel), var(--deep));
    padding: 26px;
    margin: 28px 0 10px;
  }
  .card button {
    width: 56px;
    height: 56px;
    border-radius: 14px;
    border: 1px solid var(--line);
    background: rgba(116, 176, 255, 0.06);
    color: var(--text);
    font-size: 28px;
    cursor: pointer;
    transition: 0.15s;
  }
  .card button:hover {
    border-color: rgba(55, 198, 255, 0.45);
    transform: translateY(-1px);
  }
  .card button:active {
    transform: translateY(0);
  }
  .num {
    font-family: var(--display);
    font-weight: 600;
    font-size: 56px;
    min-width: 100px;
    text-align: center;
    letter-spacing: -0.02em;
  }
  .note {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--faint);
    text-align: center;
  }
</style>
