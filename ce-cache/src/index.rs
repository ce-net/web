//! The `key -> CID` index — the heart of a content-addressed cache.
//!
//! A cache entry is keyed by the build tool's own content/action hash (Bazel action key, sccache
//! hash, Turborepo task hash); ce-cache maps that key to a CE object CID. We keep two layers:
//!
//!  1. a **local JSON index** (`<config dir>/ce-cache/index.json`) — the authoritative record of
//!     this node's own writes, persisted so restarts keep their hits; and
//!  2. the **mesh**: the DHT (`advertise_service`/`find_service`) so a writer announces "I hold an
//!     entry for key K" and a reader discovers the holders without a tracker; plus optional on-chain
//!     names (`claim_name`/`resolve_name`) for a shared, human-readable cache namespace.
//!
//! The local index is the only stateful, testable part, so it lives here as a pure struct with no
//! network dependency; the mesh wiring lives in [`store`](crate::store).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// One cache entry: a key mapped to the CE object CID holding its (archived) bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// The object CID (manifest hash from `put_object`) — content-addressed, self-verifying.
    pub cid: String,
    /// Entry size in bytes (the archived artifact length).
    pub size: u64,
    /// Unix seconds when this mapping was last written/refreshed (for LRU-ish reporting).
    #[serde(default)]
    pub updated_secs: u64,
}

/// The persisted `key -> Entry` map. A `BTreeMap` keeps the on-disk JSON deterministic (sorted keys)
/// so the index file diffs cleanly and is reproducible.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Index {
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
}

impl Index {
    /// Load the index from `path`, treating a missing file as an empty index.
    pub fn load(path: &Path) -> Result<Self> {
        match std::fs::read(path) {
            Ok(b) => Ok(serde_json::from_slice(&b).unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Index::default()),
            Err(e) => Err(e).with_context(|| format!("reading index {}", path.display())),
        }
    }

    /// Persist the index to `path`, creating parent directories as needed.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("writing index {}", path.display()))?;
        Ok(())
    }

    /// Look up the entry for a key (a cache hit), if any.
    pub fn get(&self, key: &str) -> Option<&Entry> {
        self.entries.get(key)
    }

    /// Whether the index has an entry for a key.
    pub fn has(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }

    /// Insert or replace the mapping for a key, stamping `updated_secs` with the current time.
    pub fn put(&mut self, key: impl Into<String>, cid: impl Into<String>, size: u64) {
        self.entries.insert(
            key.into(),
            Entry { cid: cid.into(), size, updated_secs: now() },
        );
    }

    /// Remove the mapping for a key, returning the previous entry if present.
    pub fn remove(&mut self, key: &str) -> Option<Entry> {
        self.entries.remove(key)
    }

    /// Number of entries (cache hits available locally).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the index is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Total bytes mapped (sum of entry sizes) — a coarse "cache footprint" figure.
    pub fn total_bytes(&self) -> u64 {
        self.entries.values().map(|e| e.size).sum()
    }
}

/// Default index location: `<config dir>/ce-cache/index.json`, overridable via `$CE_CACHE_DIR`.
pub fn default_index_path() -> PathBuf {
    if let Some(d) = std::env::var_os("CE_CACHE_DIR") {
        return PathBuf::from(d).join("index.json");
    }
    directories::ProjectDirs::from("", "", "ce-cache")
        .map(|p| p.config_dir().join("index.json"))
        .unwrap_or_else(|| PathBuf::from(".ce-cache/index.json"))
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_get_has_remove() {
        let mut idx = Index::default();
        assert!(idx.is_empty());
        assert!(!idx.has("k1"));
        assert!(idx.get("k1").is_none());

        idx.put("k1", "cid-aaa", 100);
        idx.put("k2", "cid-bbb", 200);
        assert_eq!(idx.len(), 2);
        assert!(idx.has("k1"));
        assert_eq!(idx.get("k1").unwrap().cid, "cid-aaa");
        assert_eq!(idx.total_bytes(), 300);

        // Overwrite updates the mapping.
        idx.put("k1", "cid-ccc", 150);
        assert_eq!(idx.get("k1").unwrap().cid, "cid-ccc");
        assert_eq!(idx.total_bytes(), 350);

        let removed = idx.remove("k1").unwrap();
        assert_eq!(removed.cid, "cid-ccc");
        assert!(!idx.has("k1"));
        assert!(idx.remove("k1").is_none());
    }

    #[test]
    fn load_save_roundtrips() {
        let dir = std::env::temp_dir().join(format!("ce-cache-idx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.json");

        let mut idx = Index::default();
        idx.put("//pkg:target", "cid-deadbeef", 4096);
        idx.save(&path).unwrap();

        let loaded = Index::load(&path).unwrap();
        assert_eq!(loaded.get("//pkg:target").unwrap().cid, "cid-deadbeef");
        assert_eq!(loaded.get("//pkg:target").unwrap().size, 4096);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_loads_empty() {
        let path = PathBuf::from("/nonexistent-ce-cache-dir-xyz/index.json");
        let idx = Index::load(&path).unwrap();
        assert!(idx.is_empty());
    }
}
