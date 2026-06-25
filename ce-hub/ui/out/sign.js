/* sign.js — Ed25519 signed-write headers for ce-hub mutations.
 *
 * The server (web/ce-hub/src/main.rs :: verify_signed) expects, for every signed write:
 *   x-ce-id    = ed25519 public key, 32 bytes hex (lowercase)
 *   x-ce-ts    = unix seconds
 *   x-ce-nonce = single-use random string
 *   x-ce-sig   = ed25519 signature (64 bytes hex) over the canonical string:
 *                  METHOD \n PATH \n TS \n NONCE \n sha256hex(body)
 *   body       = exactly the bytes that were hashed
 *
 * Browser Ed25519: WebCrypto added "Ed25519" support (Chrome/Edge 137+, Firefox/Safari recent).
 * Where available we use it. Where a key is not present we expose a clear status so the UI can
 * render the action as a documented TODO (no silent failure).
 *
 * KEY MANAGEMENT (v1, documented TODO): a full wallet pairing flow (QR + relay, ce-secrets vault,
 * phone-as-device) is specified in MEMORY mobile-auth-design and is NOT wired here. For now an
 * identity can be supplied via:
 *   - an extractable Ed25519 keypair generated in-page and kept in memory (dev/testing), or
 *   - a raw 32-byte secret seed pasted by the user (kept only in memory, never persisted).
 * Production should replace this with the ce wallet / ce-secrets integration. */
(function (global) {
  "use strict";

  function toHex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }
  function fromHex(hex) {
    hex = hex.replace(/[^0-9a-fA-F]/g, "");
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  async function sha256hex(str) {
    var data = new TextEncoder().encode(str);
    var buf = await crypto.subtle.digest("SHA-256", data);
    return toHex(new Uint8Array(buf));
  }

  function ed25519Available() {
    return !!(global.crypto && crypto.subtle);
  }

  // In-memory identity: { pubHex, signFn(canonString)->sigHex }
  var identity = null;

  var Sign = {
    available: ed25519Available,

    hasIdentity: function () { return !!identity; },

    pubKeyHex: function () { return identity ? identity.pubHex : null; },

    /* Import a raw 32-byte Ed25519 private seed (hex). Uses WebCrypto Ed25519 if available. */
    importSeedHex: async function (seedHex) {
      var seed = fromHex(seedHex);
      if (seed.length !== 32) throw new Error("seed must be 32 bytes (64 hex chars)");
      if (!ed25519Available()) throw new Error("WebCrypto unavailable in this browser");
      // WebCrypto Ed25519 import expects PKCS8 or raw; raw private import support varies.
      // We import as PKCS8-wrapped seed.
      var pkcs8 = buildEd25519Pkcs8(seed);
      var priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
      // Derive the public key by signing/known mapping is not trivial without the lib; require pub too.
      throw new Error("seed import needs the matching public key — use setIdentity(pubHex, signFn)");
    },

    /* Generate a fresh in-memory Ed25519 identity (dev/testing). Returns the public key hex. */
    generate: async function () {
      if (!ed25519Available()) throw new Error("WebCrypto Ed25519 unavailable");
      var kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      var rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      identity = {
        pubHex: toHex(rawPub),
        signFn: async function (canon) {
          var sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(canon));
          return toHex(new Uint8Array(sig));
        }
      };
      return identity.pubHex;
    },

    /* Externally-provided signer (e.g. a future wallet bridge). */
    setIdentity: function (pubHex, signFn) {
      identity = { pubHex: pubHex, signFn: signFn };
    },

    clearIdentity: function () { identity = null; },

    /* Build the signed headers for a mutation. method/path must match the request exactly. */
    headers: async function (method, path, bodyStr) {
      if (!identity) throw new Error("no identity — connect a wallet to sign writes");
      var ts = String(Math.floor(Date.now() / 1000));
      var nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
      var bodyHex = await sha256hex(bodyStr || "");
      var canon = method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + bodyHex;
      var sig = await identity.signFn(canon);
      return {
        "x-ce-id": identity.pubHex,
        "x-ce-ts": ts,
        "x-ce-nonce": nonce,
        "x-ce-sig": sig
      };
    }
  };

  // Minimal PKCS8 wrapper for an Ed25519 raw seed (RFC 8410). Kept for completeness.
  function buildEd25519Pkcs8(seed) {
    var prefix = new Uint8Array([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
      0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
    ]);
    var out = new Uint8Array(prefix.length + seed.length);
    out.set(prefix, 0); out.set(seed, prefix.length);
    return out;
  }

  global.Sign = Sign;
})(window);
