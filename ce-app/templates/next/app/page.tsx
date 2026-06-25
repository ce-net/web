"use client";

import { useEffect, useState } from "react";
import { createClient } from "./lib/ce";

// The CE client is created on the client (this is a static export — there is no
// server). The page HTML is prerendered at build time; the counter hydrates and
// persists to the CE database.
const ce = createClient();
const COUNT_KEY = "count";

export default function Page() {
  const [count, setCount] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    ce.db
      .get(COUNT_KEY)
      .then((v) => {
        if (typeof v === "number") setCount(v);
      })
      .finally(() => setReady(true));
  }, []);

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
          <span className="ce">Next.js</span> on CE
        </span>
      </div>

      <h1>
        Prerendered, then <em>alive</em>
      </h1>
      <p className="lede">
        A Next.js App Router project built with <code>output: &quot;export&quot;</code> — every page
        is prerendered to static HTML in <code>out/</code>. On the client, the count persists to the
        CE database with a single <code>ce.db.set()</code>. Refresh, or open it elsewhere — it
        resumes.
      </p>

      <div className="card">
        <button onClick={() => setCount((c) => c - 1)} aria-label="decrement">
          &minus;
        </button>
        <div className="num">{ready ? count : "…"}</div>
        <button onClick={() => setCount((c) => c + 1)} aria-label="increment">
          +
        </button>
      </div>

      <p className="note">
        app <code>{ce.appId}</code>, db key <code>{COUNT_KEY}</code>
      </p>
    </main>
  );
}
