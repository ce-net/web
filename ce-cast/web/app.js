// ce-cast v2 — one role-flexible app for every device.
//
// Any authorized device opens THIS page and takes whatever roles its capability scopes allow
// (cast:publish / cast:control / cast:compose). There is no hardcoded "Mac" or "phone" — a device
// with a camera publishes, a device with cast:control edits the shared scene, and the encoder is a
// SELECTABLE node carried in the scene graph.
//
// Two planes, deliberately split:
//   * CONTROL plane = the CE mesh. The scene graph + device presence ride @ce/client (gossipsub via
//     the local node bridge), never an HTTP /db poll. Edits from any device converge live.
//   * MEDIA plane = WebRTC (WHIP/WHEP) — the one transport a browser can actually use. With
//     encoder = "this device" the browser composites locally and publishes one clean "program"
//     stream (the relay only -c copy fans it out: no re-decode, the streaming fix). With encoder =
//     a remote node, sources publish their feeds and the chosen node composites (via ce-adapter).
//
// Instant controls: every control updates the LOCAL canvas compositor immediately (zero network),
// AND publishes the scene delta to the mesh so the encoder + other devices follow within a frame.

import { loadScopes } from './scopes.js?v=4';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ── Identity of this cast room (the app instance) ──────────────────────────
const castId = (location.host.match(/-([0-9a-f]{6,})\./) ||
  location.pathname.match(/\/apps\/[^/]*-([0-9a-f]{6,})\//) || [])[1] || 'c0be11e0ce';

// ── Scene graph (schema identical to what relay/cast-agent.py consumes) ─────
const DEFAULT_SCENE = {
  rev: 0,
  encoder: 'this-device',                 // 'this-device' = browser composites; else a 64-hex node id
  output: { w: 1280, h: 720, fps: 30, vBitrateK: 3500 },
  platforms: { youtube: false, kick: false, x: false, twitch: false },
  screen: { on: false, source: 'local' }, // 'local' = THIS device (default); 'cenet' = pull a published feed
  camera: { on: false, source: 'local', mirror: true },
  mic: { on: false },                     // THIS device's microphone -> program audio
  layout: 'pip',                          // pip | fullface | screen | side | camonly
  pip: { corner: 'bottomRight', sizePct: 28 },
};
let scene = structuredClone(DEFAULT_SCENE);
let scopes = { roles: new Set(), has: () => false, authorized: false, deviceId: '' };
let applyingRemote = false;

// ── Mesh control plane (directed messages to the relay node, NOT an HTTP /db poll) ──
// The browser reaches a real CE node through a same-origin `/ce` reverse-proxy (the relay's node;
// later an in-browser WASM node via window.__ceNode). Scene + presence are DIRECTED messages to the
// relay node on these topics — the node self-delivers them to every local subscriber's live stream
// (gossipsub can't self-loop on a single node, directed self-send can), so the relay's cast-agent
// and every other connected device receive each edit. The control plane never touches an HTTP DB.
const MESH = '/ce';
const SCENE_TOPIC = `ce-app/cast-${castId}/room/scene`;
const PRESENCE_TOPIC = `ce-app/cast-${castId}/room/presence`;
let relayNode = '';
let meshOk = false;
const _enc = new TextEncoder(), _dec = new TextDecoder();
const toHex = (s) => [..._enc.encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
function fromHex(h) { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return _dec.decode(o); }

// ── Output canvas (the local instant compositor + the program when we encode) ─
const canvas = $('#stage');
const ctx = canvas.getContext('2d', { alpha: false });
function outDims() { return { w: scene.output.w, h: scene.output.h }; }

const camVideo = document.createElement('video');
const screenVideo = document.createElement('video');
for (const v of [camVideo, screenVideo]) { v.autoplay = true; v.muted = true; v.playsInline = true; }

let camSub = null, screenSub = null, localCam = null, localScreen = null, localMic = null;

function relayBase() { return window.CE_CAST.relayBase(); }
function authHeader() { return window.CE_CAST.authHeader(); }

// ── Compositor (reused from studio.js — the controls the user loves) ────────
function ready(v) { return v.readyState >= 2 && v.videoWidth > 0; }
function drawCover(v, dx, dy, dw, dh, mirror = false) {
  const vw = v.videoWidth, vh = v.videoHeight;
  const scale = Math.max(dw / vw, dh / vh);
  const sw = dw / scale, sh = dh / scale, sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  if (mirror) { ctx.save(); ctx.translate(dx + dw, dy); ctx.scale(-1, 1); ctx.drawImage(v, sx, sy, sw, sh, 0, 0, dw, dh); ctx.restore(); }
  else { ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh); }
}
function roundRectPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function pipRect() {
  const { w: OW, h: OH } = outDims();
  const w = OW * (scene.pip.sizePct / 100), h = w * 9 / 16, m = OW * 0.025;
  const right = OW - w - m, left = m, bottom = OH - h - m, top = m;
  switch (scene.pip.corner) {
    case 'topLeft': return { x: left, y: top, w, h };
    case 'topRight': return { x: right, y: top, w, h };
    case 'bottomLeft': return { x: left, y: bottom, w, h };
    default: return { x: right, y: bottom, w, h };
  }
}
function render() {
  const { w: OW, h: OH } = outDims();
  if (canvas.width !== OW || canvas.height !== OH) { canvas.width = OW; canvas.height = OH; }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, OW, OH);
  const cam = scene.camera.on && ready(camVideo);
  const scr = scene.screen.on && ready(screenVideo);
  const mir = scene.camera.mirror && scene.camera.source === 'local';
  if (scene.layout === 'camonly' || (scene.layout === 'fullface' && cam)) { if (cam) drawCover(camVideo, 0, 0, OW, OH, mir); }
  else if (scene.layout === 'screen' && scr) { drawCover(screenVideo, 0, 0, OW, OH); }
  else if (scene.layout === 'side' && cam && scr) {
    const half = OW / 2; drawCover(screenVideo, 0, 0, half, OH); drawCover(camVideo, half, 0, half, OH, mir);
  } else if (cam && scr) {
    drawCover(screenVideo, 0, 0, OW, OH);
    const r = pipRect();
    ctx.save(); roundRectPath(r.x, r.y, r.w, r.h, 14); ctx.clip(); drawCover(camVideo, r.x, r.y, r.w, r.h, mir); ctx.restore();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.18)'; roundRectPath(r.x, r.y, r.w, r.h, 14); ctx.stroke();
  } else if (scr) { drawCover(screenVideo, 0, 0, OW, OH); }
  else if (cam) { drawCover(camVideo, 0, 0, OW, OH, mir); }
  else {
    ctx.fillStyle = '#6f6c66'; ctx.font = '500 26px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No source — turn on Camera or Screen', OW / 2, OH / 2);
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// ── WHEP: pull a published feed off the relay for the local preview ─────────
function waitIce(pc) {
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    const c = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', c); res(); } };
    pc.addEventListener('icegatheringstatechange', c); setTimeout(res, 2500);
  });
}
async function whepSubscribe(path) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const remote = new MediaStream();
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.addEventListener('track', (e) => remote.addTrack(e.track));
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await waitIce(pc);
  const res = await fetch(`${relayBase()}/${path}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp', ...authHeader() }, body: pc.localDescription.sdp });
  if (!res.ok) throw new Error(`WHEP ${path} ${res.status}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  return { pc, stream: remote };
}

// Bring local source <video>s up to match the scene (instant preview on every device).
async function reconcilePreview() {
  // Camera
  if (scene.camera.on && scene.camera.source === 'cenet') {
    if (!camSub) { try { camSub = await whepSubscribe('cam'); } catch (e) { console.warn(e); } }
    if (camSub) { camVideo.srcObject = new MediaStream(camSub.stream.getVideoTracks()); camVideo.play().catch(() => {}); }
  } else if (scene.camera.on && scene.camera.source === 'local') {
    if (!localCam) localCam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: scene.output.w }, height: { ideal: scene.output.h }, frameRate: { ideal: scene.output.fps } }, audio: false }).catch(() => null);
    if (localCam) { camVideo.srcObject = localCam; camVideo.play().catch(() => {}); }
  } else { camVideo.srcObject = null; dropCamSub(); stopLocalCam(); }

  // Screen (this device — getDisplayMedia; unavailable on iOS Safari, fails gracefully)
  if (scene.screen.on && scene.screen.source === 'cenet') {
    if (!screenSub) { try { screenSub = await whepSubscribe('screen'); } catch (e) { console.warn(e); } }
    if (screenSub) { screenVideo.srcObject = new MediaStream(screenSub.stream.getVideoTracks()); screenVideo.play().catch(() => {}); }
  } else if (scene.screen.on && scene.screen.source === 'local') {
    if (!localScreen) localScreen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: scene.output.fps, width: { ideal: scene.output.w }, height: { ideal: scene.output.h } }, audio: false }).catch(() => null);
    if (localScreen) { screenVideo.srcObject = localScreen; screenVideo.play().catch(() => {}); }
  } else { screenVideo.srcObject = null; dropScreenSub(); stopLocalScreen(); }

  // Mic (this device) — independent of camera; it is the program audio when live.
  if (scene.mic && scene.mic.on) {
    if (!localMic) localMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).catch(() => null);
  } else if (localMic) { localMic.getTracks().forEach((t) => t.stop()); localMic = null; }
  if (publishing) updateProgramAudio();
}
function dropCamSub() { if (camSub) { try { camSub.pc.close(); } catch {} camSub = null; } }
function dropScreenSub() { if (screenSub) { try { screenSub.pc.close(); } catch {} screenSub = null; } }
function stopLocalCam() { if (localCam) { localCam.getTracks().forEach((t) => t.stop()); localCam = null; } }
function stopLocalScreen() { if (localScreen) { localScreen.getTracks().forEach((t) => t.stop()); localScreen = null; } }

// ── Program publish (browser-composite path: encoder === 'this-device') ─────
const PROGRAM_PATH = 'program';
let pc = null, programStream = null, publishing = false, retryTimer = null, attempt = 0;
function preferH264(sdp) {
  try {
    const L = sdp.split('\r\n'); const i = L.findIndex((l) => l.startsWith('m=video')); if (i < 0) return sdp;
    const pts = L.filter((l) => /^a=rtpmap:\d+ H264\//i.test(l)).map((l) => l.match(/^a=rtpmap:(\d+)/)[1]); if (!pts.length) return sdp;
    const p = L[i].split(' '); L[i] = [...p.slice(0, 3), ...pts, ...p.slice(3).filter((x) => !pts.includes(x))].join(' '); return L.join('\r\n');
  } catch { return sdp; }
}
function programAudioTrack() {
  if (scene.mic && scene.mic.on && localMic) return localMic.getAudioTracks()[0] || null;  // this device's mic
  if (scene.camera.source === 'cenet') return camSub?.stream.getAudioTracks()[0] || null;  // remote (Mac) mic via cam feed
  return null;
}
// Swap the program's audio track live (e.g. when the mic is toggled mid-stream) without reconnecting.
function updateProgramAudio() {
  if (!pc) return;
  const want = programAudioTrack();
  const sender = pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
  if (sender) { try { sender.replaceTrack(want || null); } catch {} }
  else if (want && programStream) { try { programStream.addTrack(want); pc.addTrack(want, programStream); } catch {} }
}
async function connectProgram() {
  if (!publishing) return;
  try {
    const s = canvas.captureStream(scene.output.fps);
    const a = programAudioTrack(); if (a) s.addTrack(a);
    programStream = s;
    if (pc) { try { pc.close(); } catch {} }
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    programStream.getTracks().forEach((t) => pc.addTrack(t, programStream));
    pc.addEventListener('connectionstatechange', () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') { attempt = 0; setLive(true); }
      else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && publishing) retryProgram();
    });
    const offer = await pc.createOffer(); offer.sdp = preferH264(offer.sdp);
    await pc.setLocalDescription(offer); await waitIce(pc);
    const res = await fetch(`${relayBase()}/${PROGRAM_PATH}/whip`, { method: 'POST', headers: { 'Content-Type': 'application/sdp', ...authHeader() }, body: pc.localDescription.sdp });
    if (!res.ok) throw new Error(`WHIP ${res.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  } catch (e) { console.warn('program publish failed', e); retryProgram(); }
}
function retryProgram() {
  if (!publishing || retryTimer) return;
  if (pc) { try { pc.close(); } catch {} pc = null; }
  attempt++; const d = Math.min(1000 * Math.pow(1.6, Math.min(attempt, 8)), 15000);
  retryTimer = setTimeout(() => { retryTimer = null; connectProgram(); }, d);
}
async function startProgram() {
  if (scene.mic && scene.mic.on && !localMic) localMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).catch(() => null);
  publishing = true; attempt = 0; await connectProgram();
}
function stopProgram() {
  publishing = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (programStream) { programStream.getVideoTracks().forEach((t) => t.stop()); programStream = null; }
}

// ── Mesh control plane (directed messages to the relay node) ────────────────
async function meshSend(topic, obj) {
  if (!relayNode) return;
  try {
    await fetch(`${MESH}/mesh/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: relayNode, topic, payload_hex: toHex(JSON.stringify(obj)) }),
    });
  } catch (e) { console.warn('meshSend', e); }
}
function bumpAndPublishScene() {
  if (applyingRemote) return;
  scene.rev = (scene.rev || 0) + 1;
  meshSend(SCENE_TOPIC, scene);
}
function applyScene(incoming) {
  if (!incoming || typeof incoming !== 'object') return;
  if ((incoming.rev || 0) < (scene.rev || 0)) return;  // ignore stale
  applyingRemote = true;
  scene = { ...DEFAULT_SCENE, ...incoming };
  renderControls(); reconcilePreview();
  applyingRemote = false;
}
async function initMesh() {
  try {
    const r = await fetch(`${MESH}/status`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`status ${r.status}`);
    relayNode = (await r.json()).node_id;
    meshOk = !!relayNode;
    setMeshStatus(meshOk);
    openSceneStream();
    announcePresence();
    setInterval(announcePresence, 15000);
  } catch (e) { console.warn('mesh init failed (no node proxy?)', e); setMeshStatus(false); }
}
// One live SSE stream from the node; apply scene edits from any device (and the agent).
function openSceneStream() {
  let es;
  try { es = new EventSource(`${MESH}/mesh/messages/stream`); } catch { return; }
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || !m.payload_hex) return;
    if (m.topic === SCENE_TOPIC) { try { applyScene(JSON.parse(fromHex(m.payload_hex))); } catch {} }
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}
function announcePresence() {
  meshSend(PRESENCE_TOPIC, { deviceId: scopes.deviceId, roles: [...scopes.roles], at: Date.now() });
}

// ── UI wiring ───────────────────────────────────────────────────────────────
function press(el, on) { el.setAttribute('aria-pressed', String(on)); }
function setLive(on) {
  $('#status').textContent = on ? 'LIVE' : (publishing ? 'connecting…' : 'preview');
  $('#status').dataset.on = String(on);
  $('#badge').textContent = on ? 'ON AIR' : 'preview';
}
function setMeshStatus(ok) { $('#mesh').textContent = ok ? 'mesh: connected' : 'mesh: local-only'; $('#mesh').dataset.on = String(ok); }

function renderControls() {
  $$('.lay').forEach((b) => press(b, b.dataset.v === scene.layout));
  press($('#camOn'), scene.camera.on); press($('#scrOn'), scene.screen.on); press($('#mirror'), scene.camera.mirror);
  press($('#micOn'), !!(scene.mic && scene.mic.on));
  $$('.camMode').forEach((b) => press(b, b.dataset.v === scene.camera.source));
  $$('.scrMode').forEach((b) => press(b, b.dataset.v === scene.screen.source));
  $$('.corner-b').forEach((b) => press(b, b.dataset.v === scene.pip.corner));
  $('#pipSize').value = scene.pip.sizePct; $('#pipPct').textContent = scene.pip.sizePct + '%';
  $$('.plat').forEach((b) => press(b, !!scene.platforms[b.dataset.v]));
  $('#res').value = `${scene.output.h}-${scene.output.fps}`;
  $('#enc').textContent = 'encoder: ' + (scene.encoder === 'this-device' ? 'this device' : scene.encoder.slice(0, 8));
  const live = Object.values(scene.platforms).some(Boolean) || publishing;
  setLive(Object.values(scene.platforms).some(Boolean));
  $('#go').hidden = live; $('#stop').hidden = !live;
}

// Apply role-based visibility: hide tabs/sections the device isn't scoped for.
function applyScopeVisibility() {
  $('#deviceId').textContent = 'device: ' + (scopes.deviceId || 'unknown');
  $('#roleInfo').textContent = scopes.authorized ? ('roles: ' + [...scopes.roles].map((r) => r.split(':')[1]).join(', ')) : 'not authorized';
  $('#sources').hidden = !scopes.has('cast:publish') && !scopes.has('cast:control');
  $('#compose').hidden = !scopes.has('cast:control');
  $('#output').hidden = !scopes.has('cast:compose');
  if (!scopes.authorized) { $('#authWarn').hidden = false; startPairing(); }
}

// Not enrolled in the vault: show a pair code and wait for approval, then re-resolve scopes live.
async function startPairing() {
  try {
    const code = await window.CE_VAULT.pair();
    if (code) { const el = $('#pairCode'); if (el) el.textContent = code; }
    const ok = await window.CE_VAULT.waitEnrolled();
    if (ok) { scopes = await loadScopes(); $('#authWarn').hidden = true; applyScopeVisibility(); renderControls(); }
  } catch (e) { console.warn('pairing', e); }
}

function wire() {
  const edit = (fn) => { if (!scopes.has('cast:control')) return; fn(); renderControls(); reconcilePreview(); bumpAndPublishScene(); };

  $$('.lay').forEach((b) => b.addEventListener('click', () => edit(() => { scene.layout = b.dataset.v; })));
  $('#camOn').addEventListener('click', () => edit(() => { scene.camera.on = !scene.camera.on; }));
  $('#scrOn').addEventListener('click', () => edit(() => { scene.screen.on = !scene.screen.on; }));
  // Mic: acquire getUserMedia DIRECTLY in the click (a fresh user gesture). Doing it deep inside the
  // async reconcile — after camera/screen awaits — loses the gesture and the prompt is silently denied.
  $('#micOn').addEventListener('click', async () => {
    if (!scopes.has('cast:control')) return;
    const on = !(scene.mic && scene.mic.on);
    scene.mic = { on };
    if (on && !localMic) {
      localMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
        .catch((e) => { console.warn('mic blocked/failed:', e); return null; });
      if (!localMic) scene.mic = { on: false };   // acquisition failed (denied/no device) — reflect off
    } else if (!on && localMic) { localMic.getTracks().forEach((t) => t.stop()); localMic = null; }
    if (publishing) updateProgramAudio();
    renderControls(); bumpAndPublishScene();
  });
  $('#mirror').addEventListener('click', () => edit(() => { scene.camera.mirror = !scene.camera.mirror; }));
  $$('.camMode').forEach((b) => b.addEventListener('click', () => edit(() => { scene.camera.source = b.dataset.v; })));
  $$('.scrMode').forEach((b) => b.addEventListener('click', () => edit(() => { scene.screen.source = b.dataset.v; })));
  $$('.corner-b').forEach((b) => b.addEventListener('click', () => edit(() => { scene.pip.corner = b.dataset.v; })));
  $('#pipSize').addEventListener('input', (e) => { if (!scopes.has('cast:control')) return; scene.pip.sizePct = +e.target.value; $('#pipPct').textContent = e.target.value + '%'; bumpAndPublishScene(); });
  $$('.plat').forEach((b) => b.addEventListener('click', () => edit(() => { scene.platforms[b.dataset.v] = !scene.platforms[b.dataset.v]; })));
  $('#res').addEventListener('change', (e) => edit(() => {
    const [h, fps] = String(e.target.value).split('-').map(Number);
    const w = h >= 1080 ? 1920 : 1280;
    const vBitrateK = h >= 1080 ? (fps >= 60 ? 8000 : 6000) : 3500;
    scene.output = { ...scene.output, w, h, fps, vBitrateK };
  }));

  $('#go').addEventListener('click', async () => {
    if (!scopes.has('cast:compose')) return;
    scene.platforms.youtube = scene.platforms.youtube || true;
    if (scene.encoder === 'this-device') await startProgram();   // browser composites + publishes program
    renderControls(); bumpAndPublishScene();
  });
  $('#stop').addEventListener('click', () => {
    if (!scopes.has('cast:compose')) return;
    scene.platforms = { youtube: false, kick: false, x: false, twitch: false };
    stopProgram(); renderControls(); bumpAndPublishScene();
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  scopes = await loadScopes();
  applyScopeVisibility();
  wire();
  renderControls();
  await initMesh();
  await reconcilePreview();
  window.addEventListener('online', () => { if (publishing && (!pc || pc.connectionState !== 'connected')) connectProgram(); });
});
