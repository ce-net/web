//! Turn a build artifact — a single file *or* a whole directory — into one deterministic byte
//! stream, and back. A directory of build outputs becomes a single object CID; the bytes are then
//! handed to the CE data layer (`put_object`), which chunks + content-addresses them.
//!
//! Determinism matters: the same tree must produce the same bytes (hence the same CID) on every
//! machine, or the cache hit-rate collapses. We therefore sort entries by path and zero out the
//! volatile tar header fields (mtime, uid/gid, ownership names) that would otherwise differ across
//! machines and clocks.

use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow};

/// Marker written as the first byte of an archived artifact so `get`/restore knows whether the
/// stored object was a single file or a directory tree, without a separate manifest.
const KIND_FILE: u8 = b'F';
const KIND_DIR: u8 = b'D';

/// Read a path (file or directory) and produce the single deterministic byte stream to store.
///
/// - A file becomes `[KIND_FILE] ++ <raw file bytes>`.
/// - A directory becomes `[KIND_DIR] ++ <deterministic tar of the tree>`.
pub fn pack(path: &Path) -> Result<Vec<u8>> {
    let meta = std::fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
    if meta.is_dir() {
        let mut out = vec![KIND_DIR];
        out.extend(pack_dir(path)?);
        Ok(out)
    } else {
        let mut out = vec![KIND_FILE];
        out.extend(std::fs::read(path).with_context(|| format!("read {}", path.display()))?);
        Ok(out)
    }
}

/// Inverse of [`pack`]: write a previously-packed artifact to `dest`.
///
/// - A `KIND_FILE` stream is written verbatim to `dest` (a file path).
/// - A `KIND_DIR` stream is unpacked into `dest` (a directory, created if absent).
pub fn unpack(bytes: &[u8], dest: &Path) -> Result<()> {
    let (&kind, body) = bytes.split_first().ok_or_else(|| anyhow!("empty artifact stream"))?;
    match kind {
        KIND_FILE => {
            if let Some(parent) = dest.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent).ok();
                }
            }
            std::fs::write(dest, body).with_context(|| format!("write {}", dest.display()))
        }
        KIND_DIR => unpack_dir(body, dest),
        other => Err(anyhow!("unknown artifact kind byte 0x{other:02x}")),
    }
}

/// Build a deterministic tar of `root`'s tree. Entries are sorted by relative path and all volatile
/// header fields are normalized so the bytes are reproducible across machines.
fn pack_dir(root: &Path) -> Result<Vec<u8>> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut builder = tar::Builder::new(Vec::new());
    builder.mode(tar::HeaderMode::Deterministic);
    for (rel, abs) in &files {
        let data = std::fs::read(abs).with_context(|| format!("read {}", abs.display()))?;
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();
        builder
            .append_data(&mut header, rel, Cursor::new(data))
            .with_context(|| format!("tar append {rel}"))?;
    }
    let mut out = builder.into_inner().context("finalizing tar")?;
    out.flush().ok();
    Ok(out)
}

/// Unpack a deterministic tar (from [`pack_dir`]) into `dest`, refusing any entry that would escape
/// the destination directory (path-traversal safety).
fn unpack_dir(tar_bytes: &[u8], dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest).with_context(|| format!("mkdir {}", dest.display()))?;
    let mut ar = tar::Archive::new(Cursor::new(tar_bytes));
    for entry in ar.entries().context("reading tar entries")? {
        let mut entry = entry.context("tar entry")?;
        let rel = entry.path().context("tar entry path")?.into_owned();
        let safe = sanitize_rel(&rel)
            .ok_or_else(|| anyhow!("unsafe path in archive: {}", rel.display()))?;
        let out_path = dest.join(&safe);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).context("reading tar entry body")?;
        std::fs::write(&out_path, &buf)
            .with_context(|| format!("write {}", out_path.display()))?;
    }
    Ok(())
}

/// Walk `root`, collecting every regular file as `(relative_path_string, absolute_path)`.
fn collect_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            collect_files(root, &path, out)?;
        } else if ft.is_file() {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                // Normalize to forward slashes so a tree packed on Windows and restored on Linux
                // (or vice versa) yields identical archive bytes.
                .replace('\\', "/");
            out.push((rel, path));
        }
        // Symlinks and other special files are skipped: build caches store regular outputs only.
    }
    Ok(())
}

/// Reject absolute paths, `..` components, and root/prefix components so an archive can never write
/// outside its destination directory.
fn sanitize_rel(p: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_roundtrips_through_pack_unpack() {
        let dir = std::env::temp_dir().join(format!("ce-cache-arc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("artifact.bin");
        std::fs::write(&src, b"hello build output").unwrap();

        let packed = pack(&src).unwrap();
        assert_eq!(packed[0], KIND_FILE);

        let out = dir.join("restored.bin");
        unpack(&packed, &out).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"hello build output");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dir_roundtrips_and_is_deterministic() {
        let dir = std::env::temp_dir().join(format!("ce-cache-arcd-{}", std::process::id()));
        let tree = dir.join("tree");
        std::fs::create_dir_all(tree.join("sub")).unwrap();
        std::fs::write(tree.join("a.txt"), b"alpha").unwrap();
        std::fs::write(tree.join("sub/b.txt"), b"beta").unwrap();

        let packed1 = pack(&tree).unwrap();
        let packed2 = pack(&tree).unwrap();
        // Determinism is load-bearing for cache hit-rate: identical tree -> identical bytes -> CID.
        assert_eq!(packed1, packed2, "dir packing must be reproducible");
        assert_eq!(packed1[0], KIND_DIR);

        let restored = dir.join("restored");
        unpack(&packed1, &restored).unwrap();
        assert_eq!(std::fs::read(restored.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(std::fs::read(restored.join("sub/b.txt")).unwrap(), b"beta");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(sanitize_rel(Path::new("../escape")).is_none());
        assert!(sanitize_rel(Path::new("/abs")).is_none());
        assert_eq!(sanitize_rel(Path::new("a/b")).unwrap(), PathBuf::from("a/b"));
        assert_eq!(sanitize_rel(Path::new("./a/./b")).unwrap(), PathBuf::from("a/b"));
    }
}
