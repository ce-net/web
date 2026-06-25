import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { createClient } from "./ce";

const ce = createClient();

function Brand() {
  return (
    <div className="brand">
      <svg viewBox="0 0 32 32" width="24" height="24">
        <g fill="none" stroke="#37c6ff" strokeWidth="2.4" strokeLinecap="round">
          <path d="M4 12c3 0 3 3 6 3s3-3 6-3 3 3 6 3 3-3 6-3" />
          <path d="M4 19c3 0 3 3 6 3s3-3 6-3 3 3 6 3 3-3 6-3" />
        </g>
      </svg>
      <span>
        <span className="ce">React Router</span> on CE
      </span>
    </div>
  );
}

function Nav() {
  return (
    <nav>
      <NavLink to="/" end>
        Home
      </NavLink>
      <NavLink to="/counter">Counter</NavLink>
      <NavLink to="/about">About</NavLink>
    </nav>
  );
}

function Home() {
  const loc = useLocation();
  return (
    <section>
      <h1>
        Client-side <em>routing</em>, served from the edge
      </h1>
      <p className="lede">
        This is a real single-page app with three routes. Navigate around, then copy the URL and
        refresh — the static server serves <code>index.html</code> for any route that has no
        extension, so deep links survive a hard reload. That is the SPA fallback.
      </p>
      <p className="note">
        current route <code>{loc.pathname}</code>
      </p>
    </section>
  );
}

const COUNT_KEY = "count";

function Counter() {
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
    <section>
      <h1>
        A route backed by <em>ce.db</em>
      </h1>
      <p className="lede">
        The count persists to the CE database — a mesh-replicated key/value map served by your
        local node. Refresh this route, or open it on another device — it resumes where you left off.
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
    </section>
  );
}

function About() {
  return (
    <section>
      <h1>
        Why this <em>template</em>
      </h1>
      <p className="lede">
        It exists to prove the static server's SPA fallback end to end: multiple routes, hard-refresh
        on a deep link, relative asset base so it works under <code>/apps/&lt;id&gt;/</code> and on a
        custom domain alike.
      </p>
    </section>
  );
}

export default function App() {
  return (
    <main>
      <Brand />
      <Nav />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/counter" element={<Counter />} />
        <Route path="/about" element={<About />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </main>
  );
}
