// ce-secrets crypto — isomorphic WebCrypto (Node 20+ and browsers share this exact file).
//
// Model:
//   - Each DEVICE holds an ECDH P-256 keypair (the "device key"). Its private half never
//     leaves the device (OS keychain on a laptop, IndexedDB on a phone).
//   - One VAULT MASTER KEY (random 32 bytes) encrypts every secret with AES-256-GCM.
//   - The master key is WRAPPED (ECIES: ephemeral ECDH -> HKDF -> AES-GCM) to each authorized
//     device's public key. Adding a device = wrap the master to its pubkey. That is how a
//     phone tab becomes "your device": an already-authorized device wraps the master to it.
//   - Records are SIGNED (ECDSA P-256) by the writing device so tampering is detectable even
//     though the hub store is not itself write-authenticated yet.
//
// Nothing here ever returns a secret as a print-friendly value by accident: callers decide.

const subtle = globalThis.crypto.subtle;
const getRandom = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---- encoding helpers -------------------------------------------------------
export const b64 = {
  enc(bytes) { let s = ''; const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = str.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '==='.slice((s.length + 3) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
};
export const hex = {
  enc(bytes) { return [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))].map((x) => x.toString(16).padStart(2, '0')).join(''); },
  dec(str) { const out = new Uint8Array(str.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16); return out; },
};
const utf8 = { enc: (s) => new TextEncoder().encode(s), dec: (b) => new TextDecoder().decode(b) };

export function randomBytes(n) { return getRandom(n); }

// ---- device keys ------------------------------------------------------------
// A device key is an ECDH keypair (wrap/unwrap) + an ECDSA keypair (sign/verify),
// both P-256. Serialized as JWKs so they persist as JSON and travel as one blob.
export async function generateDeviceKey() {
  const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ecdsa = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const out = {
    ecdhPriv: await subtle.exportKey('jwk', ecdh.privateKey),
    ecdhPub: await subtle.exportKey('jwk', ecdh.publicKey),
    ecdsaPriv: await subtle.exportKey('jwk', ecdsa.privateKey),
    ecdsaPub: await subtle.exportKey('jwk', ecdsa.publicKey),
  };
  out.id = await deviceId(out.ecdhPub, out.ecdsaPub);
  return out;
}
// The public half only — safe to publish/share. Derives a stable device id.
export function devicePublic(dk) { return { id: dk.id, ecdhPub: dk.ecdhPub, ecdsaPub: dk.ecdsaPub }; }

export async function deviceId(ecdhPub, ecdsaPub) {
  const data = utf8.enc(JSON.stringify([ecdhPub.x, ecdhPub.y, ecdsaPub.x, ecdsaPub.y]));
  return hex.enc(new Uint8Array(await subtle.digest('SHA-256', data))).slice(0, 16);
}

async function importEcdhPriv(jwk) { return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); }
async function importEcdhPub(jwk) { return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
async function importEcdsaPriv(jwk) { return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); }
async function importEcdsaPub(jwk) { return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); }

// ---- master key + ECIES wrap ------------------------------------------------
export function generateMaster() { return getRandom(32); }

async function hkdfAesKey(sharedBits, info) {
  const base = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.enc(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Wrap the master key to a recipient device's ECDH public key (ECIES).
export async function wrapMaster(masterRaw, recipientEcdhPubJwk) {
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const recip = await importEcdhPub(recipientEcdhPubJwk);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recip }, eph.privateKey, 256);
  const aes = await hkdfAesKey(shared, 'ce-secrets/master-wrap/v1');
  const iv = getRandom(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, aes, masterRaw));
  return { eph: await subtle.exportKey('jwk', eph.publicKey), iv: b64.enc(iv), ct: b64.enc(ct) };
}

// Unwrap with this device's ECDH private key.
export async function unwrapMaster(wrapped, deviceEcdhPrivJwk) {
  const priv = await importEcdhPriv(deviceEcdhPrivJwk);
  const eph = await importEcdhPub(wrapped.eph);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: eph }, priv, 256);
  const aes = await hkdfAesKey(shared, 'ce-secrets/master-wrap/v1');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(wrapped.iv) }, aes, b64.dec(wrapped.ct));
  return new Uint8Array(pt);
}

// ---- secret encryption (AES-256-GCM under the master key) -------------------
async function masterAesKey(masterRaw) { return subtle.importKey('raw', masterRaw, 'AES-GCM', false, ['encrypt', 'decrypt']); }

export async function sealSecret(masterRaw, plaintextBytes) {
  const aes = await masterAesKey(masterRaw);
  const iv = getRandom(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, aes, plaintextBytes));
  return { iv: b64.enc(iv), ct: b64.enc(ct) };
}
export async function openSecret(masterRaw, sealed) {
  const aes = await masterAesKey(masterRaw);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(sealed.iv) }, aes, b64.dec(sealed.ct));
  return new Uint8Array(pt);
}

// ---- record signing (tamper-evidence) ---------------------------------------
export async function signRecord(dk, obj) {
  const priv = await importEcdsaPriv(dk.ecdsaPriv);
  const data = utf8.enc(stableStringify(obj));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, data));
  return b64.enc(sig);
}
export async function verifyRecord(ecdsaPubJwk, obj, sigB64) {
  const pub = await importEcdsaPub(ecdsaPubJwk);
  const data = utf8.enc(stableStringify(obj));
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64.dec(sigB64), data);
}
function stableStringify(o) { return JSON.stringify(o, Object.keys(o).sort()); }

// ---- fingerprint (safe to display) ------------------------------------------
export async function fingerprint(bytes) {
  const h = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return hex.enc(h).slice(0, 16);
}

// ---- generators by type -----------------------------------------------------
// Returns { bytes: Uint8Array, public?: string, display: string }.
// `bytes` is ALWAYS the UTF-8 of the canonical STRING form of the secret, so revealing it and
// injecting it as an env var yields a clean, usable value (hex / base64 / password / pem-b64).
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
export async function generate(type, opts = {}) {
  type = String(type || 'token').toLowerCase();
  const str = (s) => utf8.enc(s);
  switch (type) {
    case 'token': case 'hex': { const n = opts.length || 32; return { bytes: str(hex.enc(getRandom(n))), display: `${type} (${n} bytes / ${n * 2} hex chars)` }; }
    case 'password': case 'pass': { const n = opts.length || 24; const r = getRandom(n); let s = ''; for (let i = 0; i < n; i++) s += PW_ALPHABET[r[i] % PW_ALPHABET.length]; return { bytes: str(s), display: `password (${n} chars)` }; }
    case 'base64': { const n = opts.length || 32; return { bytes: str(b64.enc(getRandom(n))), display: `base64 (${n} bytes)` }; }
    case 'uuid': { return { bytes: str(globalThis.crypto.randomUUID()), display: 'uuid v4' }; }
    case 'aes-256': case 'aes256': { return { bytes: str(hex.enc(getRandom(32))), display: 'aes-256 key (hex)' }; }
    case 'ed25519': {
      const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      const priv = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
      const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
      return { bytes: str(b64.enc(priv)), public: b64.enc(pub), display: 'ed25519 keypair (private = base64 pkcs8)' };
    }
    case 'x25519': {
      const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      const priv = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
      const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
      return { bytes: str(b64.enc(priv)), public: b64.enc(pub), display: 'x25519 keypair (private = base64 pkcs8)' };
    }
    case 'rsa-2048': case 'rsa-4096': {
      const bits = type === 'rsa-4096' ? 4096 : 2048;
      const kp = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
      const priv = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
      const pub = new Uint8Array(await subtle.exportKey('spki', kp.publicKey));
      return { bytes: str(b64.enc(priv)), public: b64.enc(pub), display: `rsa-${bits} keypair (private = base64 pkcs8)` };
    }
    default: throw new Error(`unknown key type: ${type}`);
  }
}

export const enc = { b64, hex, utf8 };
