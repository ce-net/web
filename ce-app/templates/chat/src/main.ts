import { createClient } from "./ce";

// ---- identity: a stable per-browser pubkey-ish id + a chosen name ----------
function rid(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
const myId =
  localStorage.getItem("ce-chat-id") ||
  (() => {
    const id = rid(16);
    localStorage.setItem("ce-chat-id", id);
    return id;
  })();
const short = myId.slice(0, 8);
let myName = localStorage.getItem("ce-chat-name") || `anon-${short.slice(0, 4)}`;

// ---- ce client -------------------------------------------------------------
const ce = createClient();
const room = ce.room("lobby");

type Msg = { id: string; from: string; name: string; text: string; t: number };
type Presence = { id: string; name: string; t: number };

const HISTORY_KEY = "msg:"; // db keys are msg:<timestamp>-<rand>
const seen = new Set<string>();

// ---- DOM -------------------------------------------------------------------
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const log = $("#log");
const input = $("#text") as HTMLInputElement;
const form = $("#composer") as HTMLFormElement;
const nameBtn = $("#nameBtn");
const onlineEl = $("#online");
const meId = $("#meId");
meId.textContent = short;
nameBtn.textContent = myName;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
function timeStr(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function render(m: Msg) {
  if (seen.has(m.id)) return;
  seen.add(m.id);
  const mine = m.from === myId;
  const row = document.createElement("div");
  row.className = "msg" + (mine ? " me" : "");
  const initials = (m.name || "?").slice(0, 2).toUpperCase();
  row.innerHTML = `
    <div class="av" style="background:${hue(m.from)}">${esc(initials)}</div>
    <div class="bubble">
      <div class="meta"><b>${esc(m.name)}</b><span class="id">${esc(m.from.slice(0, 6))}</span><span class="t">${timeStr(m.t)}</span></div>
      <div class="body">${esc(m.text)}</div>
    </div>`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function hue(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg,hsl(${h},70%,55%),hsl(${(h + 40) % 360},70%,45%))`;
}

// ---- durable history: load from ce.db, newest-first -> oldest-first ---------
async function loadHistory() {
  try {
    const items = await ce.db.list(HISTORY_KEY, 100);
    items.reverse(); // db returns newest-first; we want oldest at top
    for (const { value } of items) render(value as Msg);
  } catch (e) {
    console.warn("history load failed", e);
  }
}

// ---- presence --------------------------------------------------------------
const peers = new Map<string, Presence>();
function refreshOnline() {
  const now = Date.now();
  for (const [id, p] of peers) if (now - p.t > 30000) peers.delete(id);
  peers.set(myId, { id: myId, name: myName, t: now });
  onlineEl.textContent = String(peers.size);
}
function announce() {
  room.send({ kind: "hello", id: myId, name: myName, t: Date.now() });
  refreshOnline();
}

// ---- realtime --------------------------------------------------------------
room.on((m: any) => {
  if (!m || typeof m !== "object") return;
  if (m.kind === "msg") {
    render(m as Msg);
  } else if (m.kind === "hello") {
    peers.set(m.id, { id: m.id, name: m.name, t: Date.now() });
    refreshOnline();
    // reply so the newcomer sees us too
    room.send({ kind: "hi", id: myId, name: myName, t: Date.now() });
  } else if (m.kind === "hi") {
    peers.set(m.id, { id: m.id, name: m.name, t: Date.now() });
    refreshOnline();
  }
});
room.onOpen(() => announce());

// ---- send ------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const m: Msg = { id: rid(8), from: myId, name: myName, text, t: Date.now() };
  render(m);
  room.send({ kind: "msg", ...m });
  // durable: store keyed by timestamp so list is chronological
  try {
    await ce.db.set(`${HISTORY_KEY}${m.t}-${m.id}`, m);
  } catch (e) {
    console.warn("persist failed", e);
  }
});

nameBtn.addEventListener("click", () => {
  const n = prompt("Your name", myName);
  if (n && n.trim()) {
    myName = n.trim().slice(0, 24);
    localStorage.setItem("ce-chat-name", myName);
    nameBtn.textContent = myName;
    announce();
  }
});

// ---- boot ------------------------------------------------------------------
loadHistory();
setInterval(announce, 12000);
setInterval(refreshOnline, 5000);
refreshOnline();
