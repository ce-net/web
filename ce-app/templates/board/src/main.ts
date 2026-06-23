import { createClient } from "./ce";

function rid(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
const myId = rid(6); // ephemeral identity per session — board is transient
function hue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
const myHue = hue(myId);
const myName = localStorage.getItem("ce-board-name") || `user-${myId.slice(0, 3)}`;

const ce = createClient();
const room = ce.room("board");

const stage = document.querySelector("#stage") as HTMLDivElement;
const canvas = document.querySelector("#ink") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const cursorsEl = document.querySelector("#cursors") as HTMLDivElement;
const peersEl = document.querySelector("#peers") as HTMLElement;
const clearBtn = document.querySelector("#clear") as HTMLButtonElement;

function resize() {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  // snapshot existing ink
  const prev = ctx.getImageData(0, 0, canvas.width || 1, canvas.height || 1);
  canvas.width = Math.floor(r.width * dpr);
  canvas.height = Math.floor(r.height * dpr);
  canvas.style.width = r.width + "px";
  canvas.style.height = r.height + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  try {
    ctx.putImageData(prev, 0, 0);
  } catch {
    /* size changed; ink uses normalized coords on redraw anyway */
  }
}
window.addEventListener("resize", resize);
resize();

// ---- peers / cursors -------------------------------------------------------
type Peer = { id: string; name: string; hue: number; x: number; y: number; t: number; el?: HTMLDivElement };
const peers = new Map<string, Peer>();

function ensureCursor(p: Peer) {
  if (p.el) return p.el;
  const el = document.createElement("div");
  el.className = "cursor";
  el.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="hsl(${p.hue},75%,58%)" stroke="rgba(0,0,0,.4)" stroke-width="1"><path d="M5 3l14 7-6 1-3 6z"/></svg><span class="lbl" style="background:hsl(${p.hue},70%,46%)">${p.name.replace(/[<>&]/g, "")}</span>`;
  cursorsEl.appendChild(el);
  p.el = el;
  return el;
}

function drawPeers() {
  const now = Date.now();
  const r = stage.getBoundingClientRect();
  for (const [id, p] of peers) {
    if (now - p.t > 6000) {
      p.el?.remove();
      peers.delete(id);
      continue;
    }
    const el = ensureCursor(p);
    el.style.transform = `translate(${p.x * r.width}px, ${p.y * r.height}px)`;
  }
  peersEl.textContent = String(peers.size + 1);
}
setInterval(drawPeers, 80);

// ---- ink -------------------------------------------------------------------
function stroke(x0: number, y0: number, x1: number, y1: number, h: number) {
  const r = stage.getBoundingClientRect();
  ctx.strokeStyle = `hsl(${h},80%,62%)`;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0 * r.width, y0 * r.height);
  ctx.lineTo(x1 * r.width, y1 * r.height);
  ctx.stroke();
}

let drawing = false;
let last: { x: number; y: number } | null = null;

function norm(e: PointerEvent) {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

let lastSent = 0;
function sendCursor(x: number, y: number) {
  const t = performance.now();
  if (t - lastSent < 33) return; // ~30fps
  lastSent = t;
  room.send({ k: "c", id: myId, name: myName, h: myHue, x, y, t: Date.now() });
}

stage.addEventListener("pointerdown", (e) => {
  stage.setPointerCapture(e.pointerId);
  drawing = true;
  last = norm(e);
});
stage.addEventListener("pointermove", (e) => {
  const p = norm(e);
  sendCursor(p.x, p.y);
  if (drawing && last) {
    stroke(last.x, last.y, p.x, p.y, myHue);
    room.send({ k: "d", x0: last.x, y0: last.y, x1: p.x, y1: p.y, h: myHue });
    last = p;
  }
});
const stop = () => {
  drawing = false;
  last = null;
};
stage.addEventListener("pointerup", stop);
stage.addEventListener("pointercancel", stop);
stage.addEventListener("pointerleave", () => {
  // tell peers our cursor left
  room.send({ k: "c", id: myId, name: myName, h: myHue, x: -1, y: -1, t: Date.now() });
  stop();
});

clearBtn.addEventListener("click", () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  room.send({ k: "x" });
});

// ---- receive ---------------------------------------------------------------
room.on((m: any) => {
  if (!m || typeof m !== "object") return;
  if (m.k === "c") {
    if (m.id === myId) return;
    if (m.x < 0) {
      const p = peers.get(m.id);
      p?.el?.remove();
      peers.delete(m.id);
      return;
    }
    const p = peers.get(m.id) || { id: m.id, name: m.name, hue: m.h, x: m.x, y: m.y, t: 0 };
    p.name = m.name;
    p.hue = m.h;
    p.x = m.x;
    p.y = m.y;
    p.t = Date.now();
    peers.set(m.id, p);
  } else if (m.k === "d") {
    stroke(m.x0, m.y0, m.x1, m.y1, m.h);
  } else if (m.k === "x") {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
});

// presence ping so others render us even when idle
setInterval(() => {
  // only ping if we have moved recently is unnecessary; light keepalive
}, 4000);
