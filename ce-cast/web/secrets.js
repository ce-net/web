// ce-cast vault client — makes THIS browser tab a real "device" in your ce-secrets vault and
// pulls the ce-cast publish key from it, so you never paste a key on the phone.
//
// Same crypto/vault core as the `ce-secrets` CLI (crypto.mjs + vault.mjs are isomorphic). The
// only browser-specific bits live here: the device key in localStorage, and the hub over fetch.
//
// Loaded as a module; exposes window.CE_VAULT for the (classic) config.js / page scripts.

import * as C from './crypto.mjs';
import * as V from './vault.mjs';

const HUB = 'https://ce-net.com';
const DEVKEY = 'ce_vault_device';     // this device's private key (JWK bundle)
const PUBLISH_SECRET = 'ce-cast-publish';

// The vault namespace shares the node prefix with this app id: cast-<prefix> -> vault-<prefix>.
function vaultNamespace() {
  const q = new URLSearchParams(location.search).get('vaultns');
  if (q) { localStorage.setItem('ce_vault_ns', q); return q; }
  const saved = localStorage.getItem('ce_vault_ns'); if (saved) return saved;
  const m = location.host.match(/^cast-([0-9a-f]{6,})\./) || location.pathname.match(/\/apps\/cast-([0-9a-f]{6,})\//);
  return m ? `vault-${m[1]}` : null;
}

function hubStore(ns) {
  const url = (k) => `${HUB}/db/${ns}/${encodeURIComponent(k)}`;
  return {
    async get(k) { const r = await fetch(url(k)); if (r.status === 404) return null; if (!r.ok) throw new Error(`GET ${k} ${r.status}`); return r.json(); },
    async put(k, v) { const r = await fetch(url(k), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }); if (!r.ok) throw new Error(`PUT ${k} ${r.status}`); },
    async del(k) { await fetch(url(k), { method: 'DELETE' }); },
    async list(p) { const r = await fetch(`${HUB}/db/${ns}?prefix=${encodeURIComponent(p)}&limit=1000`); if (!r.ok) throw new Error(`LIST ${r.status}`); return (await r.json()).items || []; },
  };
}

// Durable device-key storage. iOS in-app webviews / private tabs can wipe localStorage on close,
// which made the tab re-pair every time. So we persist to BOTH IndexedDB and localStorage and
// read from whichever survived — and never regenerate if either has the key.
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ce_vault', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) { try { const db = await idb(); return await new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result ?? null); t.onerror = () => rej(t.error); }); } catch { return null; } }
async function idbSet(k, v) { try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); } catch {} }

async function loadDeviceKey() {
  let dk = await idbGet(DEVKEY);
  if (!dk) { try { dk = JSON.parse(localStorage.getItem(DEVKEY) || 'null'); } catch {} }
  return dk;
}
async function saveDeviceKey(dk) {
  try { localStorage.setItem(DEVKEY, JSON.stringify(dk)); } catch {}
  await idbSet(DEVKEY, dk);
}
async function device() {
  let dk = await loadDeviceKey();
  if (!dk) dk = await C.generateDeviceKey();
  await saveDeviceKey(dk);            // (re)mirror to both stores every load
  return dk;
}

function pageLabel() { return /send/i.test(location.pathname) ? 'mac (ce-cast)' : 'phone (ce-cast)'; }

let ctxP = null;
async function ctx() {
  if (ctxP) return ctxP;
  const ns = vaultNamespace();
  if (!ns) throw new Error('no vault namespace (open via the deployed app URL, or add ?vaultns=)');
  ctxP = (async () => ({ store: hubStore(ns), device: await device(), ns }))();
  return ctxP;
}

// If enrolled, fetch the publish key and stash it where the existing page code reads it.
async function syncPublishKey() {
  const c = await ctx();
  if (!(await V.isEnrolled(c))) return false;
  const { bytes } = await V.revealSecret(c, PUBLISH_SECRET);
  localStorage.setItem('ce_cast_key', C.enc.utf8.dec(bytes));   // same key send.html/studio.js use
  return true;
}

window.CE_VAULT = {
  async deviceId() { return (await ctx()).device.id; },
  async isEnrolled() { return V.isEnrolled(await ctx()); },
  // Start enrollment from this tab. Reuses a still-pending code so it stops rotating on re-taps.
  async pair(label) {
    const c = await ctx();
    if (await V.isEnrolled(c)) return null;
    const saved = localStorage.getItem('ce_vault_paircode');
    if (saved && (await c.store.get(`p.${saved}`))) return saved;   // reuse the pending request
    const code = await V.requestPairing(c, label || pageLabel());
    localStorage.setItem('ce_vault_paircode', code);
    return code;
  },
  async refreshKey() { return syncPublishKey(); },
  // Poll until this device is approved, then pull the key. Resolves true on success.
  async waitEnrolled(timeoutMs = 600000) {
    const c = await ctx(); const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await V.isEnrolled(c)) { localStorage.removeItem('ce_vault_paircode'); return syncPublishKey(); }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  },
};

// On load: if this device is already enrolled, silently pull the key (no paste needed).
syncPublishKey().then((ok) => { if (ok) document.dispatchEvent(new CustomEvent('ce-vault-key')); }).catch(() => {});

// Optional pairing UI: any page with #vaultPair / #vaultMsg gets wired automatically.
function wireUI() {
  const btn = document.getElementById('vaultPair');
  const msg = document.getElementById('vaultMsg');
  if (!btn) return;
  window.CE_VAULT.isEnrolled().then((enrolled) => {
    if (enrolled) { btn.hidden = true; if (msg) msg.textContent = '✓ This device is in your vault — key loaded, no paste needed.'; }
  }).catch(() => {});
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const code = await window.CE_VAULT.pair();
      if (!code) { if (msg) msg.textContent = 'Already paired.'; return; }
      if (msg) msg.innerHTML = `On your laptop run <code>ce-secrets device approve ${code}</code> — waiting…`;
      const ok = await window.CE_VAULT.waitEnrolled();
      if (msg) msg.textContent = ok ? '✓ Paired. Publish key loaded from your vault.' : 'Timed out — tap to retry.';
      if (ok) { btn.hidden = true; document.dispatchEvent(new CustomEvent('ce-vault-key')); }
    } catch (e) { if (msg) msg.textContent = 'Pairing failed: ' + (e.message || e); }
    finally { btn.disabled = false; }
  });
}
if (document.readyState !== 'loading') wireUI(); else document.addEventListener('DOMContentLoaded', wireUI);
