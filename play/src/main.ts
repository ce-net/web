/**
 * CE Playground — entry point.
 *
 * Wires the static shell (index.html) to:
 *   - the recipe registry (left picker),
 *   - the read-only SDK code pane (center, syntax-highlighted),
 *   - the live output console (right) driven by each recipe's `run()`,
 *   - the connection manager (in-browser bridge node ↔ local :8844),
 *   - a polling status bar.
 *
 * Each recipe's `run()` is handed a {@link RunContext} backed by the *connected* node, so
 * "Run" executes real `@ce-net/sdk` calls and renders the node's real responses. Nothing
 * is mocked. Runs are abortable; switching recipe/target or clicking Run again cancels the
 * in-flight one. No user-entered code is eval'd — recipes are first-party TypeScript.
 */

import { Connection, type Snapshot, type Target } from "./connection.js";
import { Console } from "./console.js";
import { highlight } from "./highlight.js";
import type { Recipe, RunContext } from "./recipe.js";
import { findRecipe, RECIPES } from "./recipes/index.js";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

const conn = new Connection();
const out = new Console($("#console"));

let current: Recipe = findRecipe(new URLSearchParams(location.search).get("recipe"));
let runCtrl: AbortController | null = null;
let running = false;

// ---- recipe picker ----

function renderPicker(): void {
  const aside = $("#picker");
  // Keep the heading, replace the rest.
  aside.replaceChildren(aside.firstElementChild!);
  for (const r of RECIPES) {
    const btn = document.createElement("button");
    btn.className = `recipe${r.id === current.id ? " active" : ""}`;
    btn.dataset["id"] = r.id;
    const writes = r.needs.includes("write");
    const two = r.needs.includes("two-nodes");
    const badge = writes ? "write" : two ? "two nodes" : "read-only";
    btn.innerHTML =
      `<span class="t"><span class="num">${r.num}</span>${escapeHtml(r.title)}</span>` +
      `<span class="d">${escapeHtml(r.teaches)}</span>` +
      `<span class="badge${writes ? " write" : ""}">${badge}</span>`;
    btn.addEventListener("click", () => selectRecipe(r));
    aside.appendChild(btn);
  }
}

function selectRecipe(r: Recipe): void {
  if (r.id === current.id && document.querySelector(".recipe.active")) {
    // already selected; still allow re-render on first load
  }
  abortRun();
  current = r;
  const url = new URL(location.href);
  url.searchParams.set("recipe", r.id);
  history.replaceState(null, "", url);
  renderRecipe();
  renderPicker();
}

function renderRecipe(): void {
  $("#r-kick").textContent = `Recipe ${current.num}`;
  $("#r-title").textContent = current.title;
  $("#r-desc").textContent = current.desc;
  const teaches = $("#r-teaches");
  teaches.replaceChildren();
  for (const c of current.chips) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = c;
    teaches.appendChild(chip);
  }
  $("#code").innerHTML = highlight(current.source);
  const note = $("#r-note");
  if (current.note) {
    note.textContent = current.note;
    note.classList.add("show");
  } else {
    note.textContent = "";
    note.classList.remove("show");
  }
  out.clear();
}

// ---- run ----

function buildContext(signal: AbortSignal): RunContext {
  return {
    ce: conn.client(),
    log: (m) => out.append("in", m),
    ok: (m) => out.append("ok", m),
    event: (m) => out.append("ev", m),
    dim: (m) => out.append("dim", m),
    signal,
    sleep: (ms) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(abortError());
        const t = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(t);
          reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
  };
}

async function runCurrent(): Promise<void> {
  if (running) {
    abortRun();
    return;
  }
  const ready = conn.ready();
  if (!ready.ok) {
    out.clear();
    out.append("er", ready.reason ?? "the connected node is not ready");
    return;
  }
  // Gate write recipes on the local target lacking a token? We still try — the node
  // returns 401/402 and we surface it honestly rather than pre-judging.
  running = true;
  runCtrl = new AbortController();
  const runBtn = $<HTMLButtonElement>("#run-btn");
  runBtn.textContent = "Stop ◼";
  out.clear();
  out.append("dim", `running "${current.id}" against the ${targetLabel(conn.target)}…`);
  try {
    await current.run(buildContext(runCtrl.signal));
    if (!runCtrl.signal.aborted) out.append("ok", "✓ done");
  } catch (err) {
    if (isAbort(err)) out.append("dim", "■ stopped");
    else out.append("er", `✗ ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
    runCtrl = null;
    runBtn.textContent = "Run ▸";
  }
}

function abortRun(): void {
  if (runCtrl) {
    runCtrl.abort();
    runCtrl = null;
  }
  running = false;
  const runBtn = document.querySelector<HTMLButtonElement>("#run-btn");
  if (runBtn) runBtn.textContent = "Run ▸";
}

// ---- target switching + status bar ----

function setTarget(t: Target): void {
  abortRun();
  conn.setTarget(t);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#target-seg button")) {
    b.classList.toggle("active", b.dataset["target"] === t);
  }
  $("#local-field").style.display = t === "local" ? "flex" : "none";
  $("#sb-target").textContent = targetLabel(t);
  void refreshStatus();
}

function targetLabel(t: Target): string {
  return t === "browser" ? "in-browser node" : "local node :8844";
}

function applySnapshot(s: Snapshot): void {
  const dot = $("#conn-dot");
  const sbDot = $("#sb-dot");
  const txt = $("#conn-txt");
  for (const d of [dot, sbDot]) d.className = "dot";
  if (s.ok) {
    dot.classList.add("on");
    sbDot.classList.add("on");
    txt.textContent = "connected";
    $("#sb-nid").textContent = s.nodeId ? `${s.nodeId.slice(0, 10)}…` : "—";
    $("#sb-height").textContent = s.height != null ? String(s.height) : "—";
    $("#sb-bal").textContent = s.balance ?? "—";
    $("#sb-peers").textContent = s.peers != null ? String(s.peers) : "—";
  } else {
    dot.classList.add(conn.target === "browser" ? "warn" : "off");
    sbDot.classList.add(conn.target === "browser" ? "warn" : "off");
    txt.textContent = conn.target === "browser" ? "no in-browser node" : "no node on :8844";
    $("#sb-nid").textContent = "—";
    $("#sb-height").textContent = "—";
    $("#sb-bal").textContent = "—";
    $("#sb-peers").textContent = "—";
  }
}

async function refreshStatus(): Promise<void> {
  applySnapshot(await conn.snapshot());
}

// ---- helpers ----

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
function isAbort(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "AbortError"
  );
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- bootstrap ----

function init(): void {
  renderPicker();
  renderRecipe();

  $("#run-btn").addEventListener("click", () => void runCurrent());
  $("#clear-btn").addEventListener("click", () => out.clear());
  $("#copy-btn").addEventListener("click", () => {
    void navigator.clipboard?.writeText(current.source);
    const b = $("#copy-btn");
    const prev = b.textContent;
    b.textContent = "Copied";
    setTimeout(() => {
      b.textContent = prev;
    }, 1200);
  });

  for (const b of document.querySelectorAll<HTMLButtonElement>("#target-seg button")) {
    b.addEventListener("click", () => setTarget((b.dataset["target"] as Target) ?? "browser"));
  }
  const tokenIn = $<HTMLInputElement>("#token-in");
  tokenIn.addEventListener("input", () => {
    conn.setToken(tokenIn.value);
    void refreshStatus();
  });

  // Default to the local node when no in-browser bridge is present, so first-time
  // visitors without the WASM node still get a working target.
  setTarget(conn.target);
  void refreshStatus();
  // Poll the status bar.
  window.setInterval(() => void refreshStatus(), 6000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
