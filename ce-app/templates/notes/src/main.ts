import { createClient } from "./ce";

function rid(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
const myId =
  localStorage.getItem("ce-notes-id") ||
  (() => {
    const id = rid(8);
    localStorage.setItem("ce-notes-id", id);
    return id;
  })();
let myName = localStorage.getItem("ce-notes-name") || `guest-${myId.slice(0, 4)}`;

const ce = createClient();
const room = ce.room("notes");

type Note = { id: string; author: string; text: string; t: number; edited?: number };

const KEY = "note:";
const notes = new Map<string, Note>();

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const list = $("#list");
const form = $("#composer") as HTMLFormElement;
const input = $("#text") as HTMLTextAreaElement;
const nameBtn = $("#nameBtn");
const countEl = $("#count");
nameBtn.textContent = myName;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
function when(t: number): string {
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function draw() {
  const arr = [...notes.values()].sort((a, b) => b.t - a.t);
  countEl.textContent = String(arr.length);
  list.innerHTML = arr
    .map(
      (n) => `<div class="card" data-id="${n.id}">
      <div class="ctop"><b>${esc(n.author)}</b><span class="t">${when(n.t)}${n.edited ? " · edited" : ""}</span>
        ${n.author.startsWith(myName) ? `<button class="del" data-del="${n.id}" title="delete">×</button>` : ""}</div>
      <div class="ctext">${esc(n.text)}</div></div>`
    )
    .join("");
}

function upsert(n: Note) {
  notes.set(n.id, n);
  draw();
}

async function loadAll() {
  try {
    const items = await ce.db.list(KEY, 500);
    for (const { value } of items) notes.set((value as Note).id, value as Note);
    draw();
  } catch (e) {
    console.warn("load failed", e);
  }
}

room.on((m: any) => {
  if (!m || typeof m !== "object") return;
  if (m.kind === "note") upsert(m.note as Note);
  else if (m.kind === "del") {
    notes.delete(m.id);
    draw();
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const n: Note = { id: rid(8), author: myName, text, t: Date.now() };
  upsert(n);
  await ce.db.set(`${KEY}${n.t}-${n.id}`, n).catch(() => {});
  room.send({ kind: "note", note: n });
});

list.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const id = t.getAttribute("data-del");
  if (!id) return;
  const n = notes.get(id);
  notes.delete(id);
  draw();
  if (n) await ce.db.del(`${KEY}${n.t}-${n.id}`).catch(() => {});
  room.send({ kind: "del", id });
});

nameBtn.addEventListener("click", () => {
  const v = prompt("Sign your notes as", myName);
  if (v && v.trim()) {
    myName = v.trim().slice(0, 24);
    localStorage.setItem("ce-notes-name", myName);
    nameBtn.textContent = myName;
  }
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit();
});

loadAll();
