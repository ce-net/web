import { useEffect, useState } from "react";
import { createClient } from "./ce";

// The ONLY CE-specific line in this otherwise stock Vite + React app:
const ce = createClient();
const COUNT_KEY = "count";

export default function App() {
  const [count, setCount] = useState(0);
  const [ready, setReady] = useState(false);

  // Load the persisted count from the CE database on mount.
  useEffect(() => {
    ce.db
      .get(COUNT_KEY)
      .then((v) => {
        if (typeof v === "number") setCount(v);
      })
      .finally(() => setReady(true));
  }, []);

  // Persist on every change (once we've loaded, so we don't clobber).
  useEffect(() => {
    if (!ready) return;
    ce.db.set(COUNT_KEY, count).catch(() => {});
  }, [count, ready]);

  return (
    <main>
      <div className="brand">
        <svg viewBox="0 0 32 32" width="24" height="24">
          <g fill="none" stroke="#37c6ff" strokeWidth="2.4" strokeLinecap="round">
            <path d="M4 12c3 0 3 3 6 3s3-3 6-3 3 3 6 3 3-3 6-3" />
            <path d="M4 19c3 0 3 3 6 3s3-3 6-3 3 3 6 3 3-3 6-3" />
          </g>
        </svg>
        <span>
          <span className="ce">Vite + React</span> on CE
        </span>
      </div>

      <h1>
        Your project, <em>unchanged</em>
      </h1>
      <p className="lede">
        A stock Vite + React + TypeScript counter. The only difference: the count is persisted to the CE database with a
        single <code>ce.db.set()</code>. Refresh, or open this app on another device — it picks up right where you left
        off.
      </p>

      <div className="card">
        <button onClick={() => setCount((c) => c - 1)} aria-label="decrement">
          −
        </button>
        <div className="num">{ready ? count : "…"}</div>
        <button onClick={() => setCount((c) => c + 1)} aria-label="increment">
          +
        </button>
      </div>

      <p className="note">
        App <code>{ce.appId}</code>, db key <code>{COUNT_KEY}</code>
      </p>
    </main>
  );
}
