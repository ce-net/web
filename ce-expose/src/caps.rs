//! Capability resolution for the **consumer** side (the peer dialing an exposed endpoint).
//!
//! ce-expose does not mint trust — the consumer presents a signed, attenuating `ce-cap` chain that
//! the origin authorizes (ability `expose:dial`). The chain is produced out-of-band — e.g. the
//! origin (or an org root) runs `ce grant <consumer-node-id> --can expose:dial --expires 7d` and
//! hands the resulting token to the consumer's wallet. For the MVP the consumer reads the
//! hex-encoded chain from, in order:
//!   1. the explicit `--caps <hex>` flag (highest precedence);
//!   2. the `$CE_EXPOSE_CAPS` environment variable;
//!   3. `<config dir>/ce-expose/caps` (a file containing the hex chain).
//!
//! When the origin roots a chain at *itself* and self-issues, an empty chain still cannot pass
//! (the leaf audience must be the consumer). We therefore return an empty string when nothing is
//! configured and let the origin's `authorize` reject it, surfacing a clear "denied" rather than
//! guessing.

use std::path::PathBuf;

/// Resolve the capability chain hex the consumer should present. `explicit` is the `--caps` flag.
pub fn resolve(explicit: Option<&str>) -> String {
    if let Some(c) = explicit.map(str::trim).filter(|c| !c.is_empty()) {
        return c.to_string();
    }
    if let Ok(c) = std::env::var("CE_EXPOSE_CAPS") {
        let c = c.trim().to_string();
        if !c.is_empty() {
            return c;
        }
    }
    if let Some(p) = caps_file()
        && let Ok(c) = std::fs::read_to_string(&p)
    {
        let c = c.trim().to_string();
        if !c.is_empty() {
            return c;
        }
    }
    String::new()
}

fn caps_file() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("CE_EXPOSE_DIR") {
        return Some(PathBuf::from(d).join("caps"));
    }
    directories::ProjectDirs::from("", "", "ce-expose").map(|p| p.config_dir().join("caps"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_takes_precedence() {
        assert_eq!(resolve(Some("deadbeef")), "deadbeef");
        assert_eq!(resolve(Some("  abc  ")), "abc");
    }

    #[test]
    fn empty_explicit_falls_through_to_empty_when_unset() {
        // Isolate env: ensure neither the env var nor a real config file is picked up.
        unsafe {
            std::env::remove_var("CE_EXPOSE_CAPS");
            std::env::set_var("CE_EXPOSE_DIR", "/nonexistent-ce-expose-dir-xyz");
        }
        assert_eq!(resolve(Some("  ")), "");
        unsafe {
            std::env::remove_var("CE_EXPOSE_DIR");
        }
    }
}
