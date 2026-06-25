// ce-secrets vault — storage-agnostic operations shared by the Node CLI and the browser
// (phone) client. Pass a `ctx` of { store, device } where:
//   store  = { get(key)->val|null, put(key,val), del(key), list(prefix)->[{key,value}] }  (async)
//   device = a device key from crypto.generateDeviceKey() (this device's identity)
//
// Keys in the store:
//   meta            vault metadata
//   d.<deviceId>    an enrolled device: pubkeys + the master key WRAPPED to it
//   p.<code>        a pending pairing request from a new device (incl. a phone tab)
//   s.<name>        a secret: type + metadata + ciphertext (sealed under the master)
//
// The master key is never stored in the clear anywhere. A device gets it only by unwrapping
// its own d.<id> record. That is what makes "all my devices share the keys" both true and safe.

import * as C from './crypto.mjs';

const SECRET = (n) => `s.${n}`;
const DEVICE = (id) => `d.${id}`;
const PAIR = (code) => `p.${code}`;

// ---- master key -------------------------------------------------------------
export async function loadMaster(ctx) {
  const rec = await ctx.store.get(DEVICE(ctx.device.id));
  if (!rec) {
    const err = new Error('this device is not enrolled in the vault — run `ce-secrets pair` and approve it from a trusted device');
    err.code = 'NOT_ENROLLED';
    throw err;
  }
  return C.unwrapMaster(rec.wrappedMaster, ctx.device.ecdhPriv);
}

export async function vaultExists(ctx) { return !!(await ctx.store.get('meta')); }
export async function isEnrolled(ctx) { return !!(await ctx.store.get(DEVICE(ctx.device.id))); }

// First device: mint the master and enroll self. Returns false if a vault already exists.
export async function initVault(ctx, label) {
  if (await vaultExists(ctx)) return false;
  const master = C.generateMaster();
  await enroll(ctx, ctx.device, master, label || 'this device', ctx.device.id);
  await ctx.store.put('meta', { createdAt: now(), version: 1 });
  return true;
}

// A new (unenrolled) device publishes a pairing request with its public keys.
export async function requestPairing(ctx, label) {
  const code = pairingCode();
  await ctx.store.put(PAIR(code), {
    code, label: label || 'new device', ts: now(),
    pub: C.devicePublic(ctx.device),
  });
  return code;
}

export async function listPairing(ctx) { return (await ctx.store.list('p.')).map((e) => e.value); }

// A trusted device approves a pairing request: wrap the master to the new device's pubkey.
export async function approvePairing(ctx, code) {
  const req = await ctx.store.get(PAIR(code));
  if (!req) throw new Error(`no pairing request with code ${code}`);
  const master = await loadMaster(ctx);
  await enroll(ctx, req.pub, master, req.label, req.pub.id);
  await ctx.store.del(PAIR(code));
  return req.pub.id;
}

export async function listDevices(ctx) {
  return (await ctx.store.list('d.')).map((e) => ({ id: e.value.id, label: e.value.label, addedAt: e.value.addedAt, self: e.value.id === ctx.device.id }));
}
export async function revokeDevice(ctx, id) {
  if (id === ctx.device.id) throw new Error('refusing to revoke the device you are using');
  await ctx.store.del(DEVICE(id));
  // NOTE: full security also rotates every secret + the master (the revoked device cached them).
  // Surfaced to the user by the CLI; see `rotate --all` follow-up.
}

async function enroll(ctx, pub, master, label, id) {
  const wrappedMaster = await C.wrapMaster(master, pub.ecdhPub);
  const rec = { id, label, ecdhPub: pub.ecdhPub, ecdsaPub: pub.ecdsaPub, wrappedMaster, addedAt: now(), writer: ctx.device.id };
  rec.sig = await C.signRecord(ctx.device, { ...rec, sig: undefined });
  await ctx.store.put(DEVICE(id), rec);
}

// ---- secrets ----------------------------------------------------------------
// Store secret material under a name. `material` = { bytes, public?, display }.
export async function storeSecret(ctx, name, material, type, { rotateOf = null } = {}) {
  const master = await loadMaster(ctx);
  const sealed = await C.sealSecret(master, material.bytes);
  const prev = await ctx.store.get(SECRET(name));
  const rec = {
    name, type,
    version: prev ? (prev.version || 1) + 1 : 1,
    createdAt: prev?.createdAt || now(),
    rotatedAt: rotateOf || prev ? now() : null,
    sealed,
    public: material.public || prev?.public || null,
    display: material.display || type,
    fp: await C.fingerprint(material.bytes),
    writer: ctx.device.id,
  };
  rec.sig = await C.signRecord(ctx.device, { ...rec, sig: undefined });
  await ctx.store.put(SECRET(name), rec);
  return { name, type, version: rec.version, fp: rec.fp, public: rec.public };
}

export async function generateSecret(ctx, name, type, opts) {
  const material = await C.generate(type, opts);
  const exists = await ctx.store.get(SECRET(name));
  return storeSecret(ctx, name, material, type, { rotateOf: exists ? now() : null });
}
export async function putSecret(ctx, name, bytes, type = 'opaque') {
  return storeSecret(ctx, name, { bytes, display: type }, type);
}
export async function rotateSecret(ctx, name) {
  const rec = await ctx.store.get(SECRET(name));
  if (!rec) throw new Error(`no secret named ${name}`);
  const material = await C.generate(rec.type, {});
  return storeSecret(ctx, name, material, rec.type, { rotateOf: now() });
}

// Returns the raw secret bytes — for INJECTION/USE only. The CLI must never print these.
export async function revealSecret(ctx, name) {
  const rec = await ctx.store.get(SECRET(name));
  if (!rec) throw new Error(`no secret named ${name}`);
  const master = await loadMaster(ctx);
  const bytes = await C.openSecret(master, rec.sealed);
  return { bytes, type: rec.type, public: rec.public };
}

export async function listSecrets(ctx) {
  return (await ctx.store.list('s.')).map((e) => {
    const v = e.value;
    return { name: v.name, type: v.type, version: v.version, fp: v.fp, public: v.public, createdAt: v.createdAt, rotatedAt: v.rotatedAt, display: v.display };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
export async function secretMeta(ctx, name) {
  const v = await ctx.store.get(SECRET(name));
  if (!v) return null;
  return { name: v.name, type: v.type, version: v.version, fp: v.fp, public: v.public, createdAt: v.createdAt, rotatedAt: v.rotatedAt };
}
export async function deleteSecret(ctx, name) { await ctx.store.del(SECRET(name)); }

// ---- helpers ----------------------------------------------------------------
function now() { return new Date().toISOString(); }
function pairingCode() {
  // human-typable, no ambiguous chars, e.g. "7K3Q-9F2M"
  const A = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const r = C.randomBytes(8);
  let s = ''; for (let i = 0; i < 8; i++) s += A[r[i] % A.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
}
