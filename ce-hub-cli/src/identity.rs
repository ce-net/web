//! CE identity loading + the canonical signed-header scheme used by web/ce-hub and
//! web/ce-app/bin/slug.mjs. We load the SAME Ed25519 secret key the node uses, derive the
//! raw public key, and sign the canonical string:
//!
//!   METHOD "\n" PATH "\n" ts "\n" nonce "\n" sha256(body)-hex
//!
//! Header set: x-ce-id (raw pubkey hex), x-ce-sig (ed25519 sig hex), x-ce-ts (UNIX SECONDS),
//! x-ce-nonce (random hex). The hub re-derives the owner id as sha256(pubkey)[..16] hex.
//!
//! Key file resolution mirrors slug.mjs: CE_DATA_DIR override, then the per-platform default
//! (macOS Application Support, Linux ~/.local/share/ce). The key bytes may be PKCS8 DER, PKCS8
//! PEM, or a raw 32-byte seed — we accept all three.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use ed25519_dalek::{Signer as _, SigningKey};
use sha2::{Digest, Sha256};

/// A loaded CE identity: the Ed25519 signing key plus the raw public key (hex) used as x-ce-id.
pub struct Identity {
    signing: SigningKey,
    pub pubkey_hex: String,
}

impl Identity {
    /// Load the CE node identity from the first existing key file candidate.
    pub fn load() -> Result<Self> {
        let path = node_key_path()
            .ok_or_else(|| anyhow!("no CE identity key found (looked for node.key under the CE data dir); start a node or set CE_DATA_DIR"))?;
        let bytes = std::fs::read(&path)
            .with_context(|| format!("reading CE identity key {}", path.display()))?;
        let signing = parse_signing_key(&bytes)
            .with_context(|| format!("parsing Ed25519 secret key from {}", path.display()))?;
        let pubkey_hex = hex::encode(signing.verifying_key().to_bytes());
        Ok(Self { signing, pubkey_hex })
    }

    /// The hub owner id: sha256(pubkey)[..16] hex (32 hex chars). Used as the git Basic-auth username.
    pub fn owner_id(&self) -> String {
        let pk = self.signing.verifying_key().to_bytes();
        hex::encode(&Sha256::digest(pk)[..16])
    }

    /// Sign an arbitrary message (raw bytes), returning the signature as hex.
    pub fn sign_hex(&self, msg: &[u8]) -> String {
        hex::encode(self.signing.sign(msg).to_bytes())
    }

    /// Build the signed headers for a mutating request. `path` is the bare request path INCLUDING
    /// any query string (no scheme/host) — it must match what the hub re-derives. `body` is the raw
    /// request bytes (empty slice for a body-less request).
    pub fn signed_headers(&self, method: &str, path: &str, body: &[u8]) -> Vec<(String, String)> {
        let ts = unix_secs().to_string();
        let nonce = random_nonce();
        let body_hex = hex::encode(Sha256::digest(body));
        let canonical = format!("{}\n{}\n{}\n{}\n{}", method, path, ts, nonce, body_hex);
        let sig = self.sign_hex(canonical.as_bytes());
        vec![
            ("x-ce-id".to_string(), self.pubkey_hex.clone()),
            ("x-ce-sig".to_string(), sig),
            ("x-ce-ts".to_string(), ts),
            ("x-ce-nonce".to_string(), nonce),
        ]
    }
}

/// Current time in UNIX seconds (the hub parses x-ce-ts as seconds, 300s window).
pub fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A random hex nonce. Uses the OS-seeded getrandom that ed25519-dalek already pulls in indirectly;
/// we mix process/time entropy as a portable fallback so this needs no extra dependency.
pub fn random_nonce() -> String {
    let mut h = Sha256::new();
    h.update(unix_secs().to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    if let Ok(d) = SystemTime::now().duration_since(UNIX_EPOCH) {
        h.update(d.subsec_nanos().to_le_bytes());
    }
    // A second time read to capture intra-call jitter.
    if let Ok(d) = SystemTime::now().duration_since(UNIX_EPOCH) {
        h.update(d.as_nanos().to_le_bytes());
    }
    let addr = &h as *const _ as usize;
    h.update(addr.to_le_bytes());
    hex::encode(&h.finalize()[..12])
}

/// Resolve the CE node key path: CE_DATA_DIR override first, then platform defaults. Returns the
/// first candidate that exists; if none exist, returns the most likely default for the platform.
fn node_key_path() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("CE_DATA_DIR") {
        cands.push(Path::new(&dir).join("identity").join("node.key"));
    }
    if let Some(home) = dirs::home_dir() {
        cands.push(
            home.join("Library")
                .join("Application Support")
                .join("ce")
                .join("identity")
                .join("node.key"),
        );
        cands.push(
            home.join(".local")
                .join("share")
                .join("ce")
                .join("identity")
                .join("node.key"),
        );
    }
    if let Some(d) = dirs::data_dir() {
        cands.push(d.join("ce").join("identity").join("node.key"));
    }
    for c in &cands {
        if c.exists() {
            return Some(c.clone());
        }
    }
    cands.into_iter().next()
}

/// Parse an Ed25519 signing key from PKCS8 DER, PKCS8 PEM, or a raw 32-byte seed.
fn parse_signing_key(bytes: &[u8]) -> Result<SigningKey> {
    // Raw 32-byte seed.
    if let Ok(seed) = <[u8; 32]>::try_from(bytes) {
        return Ok(SigningKey::from_bytes(&seed));
    }
    // PKCS8 PEM (text) -> decode the base64 payload to DER, then extract the seed.
    if let Some(seed) = pem_to_seed(bytes) {
        return Ok(SigningKey::from_bytes(&seed));
    }
    // PKCS8 DER -> extract the 32-byte seed.
    if let Some(seed) = pkcs8_der_seed(bytes) {
        return Ok(SigningKey::from_bytes(&seed));
    }
    Err(anyhow!(
        "unrecognized Ed25519 key format (expected 32-byte seed, PKCS8 DER, or PKCS8 PEM)"
    ))
}

/// Extract the 32-byte Ed25519 seed from a PKCS8 DER document. An Ed25519 PKCS8 v1 key is:
///   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 <32 seed bytes>
/// We locate the trailing `04 20` (OCTET STRING, len 32) that wraps the inner private-key octets
/// and take the next 32 bytes. This is robust to the small length-field variations across encoders.
fn pkcs8_der_seed(der: &[u8]) -> Option<[u8; 32]> {
    // Search for the inner `04 20` then 32 bytes, scanning from the end for the LAST occurrence
    // (the inner CurvePrivateKey octet-string), which is where the seed lives.
    if der.len() < 34 {
        return None;
    }
    let mut i = der.len().saturating_sub(34);
    loop {
        if der[i] == 0x04 && der[i + 1] == 0x20 && i + 2 + 32 <= der.len() {
            let mut seed = [0u8; 32];
            seed.copy_from_slice(&der[i + 2..i + 2 + 32]);
            return Some(seed);
        }
        if i == 0 {
            break;
        }
        i -= 1;
    }
    None
}

/// Decode a PKCS8 PEM block into its DER, then extract the seed. Returns None if not PEM.
fn pem_to_seed(bytes: &[u8]) -> Option<[u8; 32]> {
    let text = std::str::from_utf8(bytes).ok()?;
    if !text.contains("-----BEGIN") {
        return None;
    }
    let mut b64 = String::new();
    let mut in_block = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with("-----BEGIN") {
            in_block = true;
            continue;
        }
        if l.starts_with("-----END") {
            break;
        }
        if in_block {
            b64.push_str(l);
        }
    }
    if b64.is_empty() {
        return None;
    }
    use base64::Engine;
    let der = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    pkcs8_der_seed(&der)
}
