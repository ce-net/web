//! webrtc-ingest data plane: terminate a browser WHIP publish and pump the media onto a
//! `/ce/tunnel/1` mesh stream to the encoder node — with **no re-decode** (the browser already
//! produced clean H.264 + Opus; the adapter only repackages container framing).
//!
//! Two pieces:
//!
//! 1. **The mesh tunnel.** ce-rs exposes no tunnel helper, so the adapter calls its *local node's*
//!    `POST /tunnel` HTTP endpoint ([`open_tunnel`]), which opens a `/ce/tunnel/1` libp2p stream to
//!    `target_node` and forwards a local TCP port to `tunnel_port` on it. When the adapter is
//!    co-located on the encoder node (the MVP), the tunnel is a loopback — no cross-mesh hop.
//! 2. **The WHIP receiver.** A managed subprocess terminates the browser's WebRTC publish, depays to
//!    H.264 + Opus, muxes to MPEG-TS, and writes it to the tunnel's local TCP port. The receiver
//!    command is a pluggable seam ([`ReceiverCommand`]) so the WebRTC implementation (webrtc-rs, or a
//!    pinned `whip`/ffmpeg receiver) can evolve without touching the control plane.
//!
//! The control plane (spawn/serve/auth) is complete and tested; the WebRTC receiver binary is the
//! one remaining moving part (tracked as the data-plane task) and is wired here behind the seam.

use anyhow::{Result, anyhow, bail};
use std::time::Instant;
use tokio::process::Child;

use crate::profile::AdapterSpec;

/// Where the local node's HTTP API lives + its bearer token, for the `POST /tunnel` call.
#[derive(Debug, Clone)]
pub struct NodeAccess {
    /// Base URL of the local node API (e.g. `http://127.0.0.1:8844`).
    pub node_url: String,
    /// Bearer token for the node API (from `$CE_API_TOKEN` or `<data_dir>/api.token`).
    pub token: Option<String>,
}

impl NodeAccess {
    /// Discover node access from the environment the same way ce-rs does: `$CE_NODE_URL` (default
    /// `http://127.0.0.1:8844`) and `$CE_API_TOKEN` (or a token file if `$CE_API_TOKEN_FILE` set).
    pub fn from_env() -> Self {
        let node_url = std::env::var("CE_NODE_URL").unwrap_or_else(|_| "http://127.0.0.1:8844".into());
        let token = std::env::var("CE_API_TOKEN").ok().or_else(|| {
            std::env::var("CE_API_TOKEN_FILE").ok().and_then(|p| std::fs::read_to_string(p).ok()).map(|s| s.trim().to_string())
        });
        NodeAccess { node_url, token }
    }
}

/// Open a mesh tunnel via the local node: forward `local_port` (127.0.0.1) to `remote_port` on
/// `target_node` over `/ce/tunnel/1`. `caps` authorizes the tunnel (a chain granting `tunnel` with
/// an `allowed_ports` caveat covering `remote_port`). Returns once the node has bound the listener.
pub async fn open_tunnel(
    access: &NodeAccess,
    target_node: &str,
    local_port: u16,
    remote_port: u16,
    caps: Option<&str>,
) -> Result<()> {
    let url = format!("{}/tunnel", access.node_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "node_id": target_node,
        "local_port": local_port,
        "remote_port": remote_port,
        "caps": caps,
    });
    let client = reqwest::Client::new();
    let mut rb = client.post(&url).json(&body);
    if let Some(t) = &access.token {
        rb = rb.bearer_auth(t);
    }
    let resp = rb.send().await.map_err(|e| anyhow!("POST /tunnel: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().await.unwrap_or_default();
        bail!("node refused tunnel ({code}): {text}");
    }
    Ok(())
}

/// The command that runs a WHIP receiver, parameterized by the WHIP bind port (where the browser
/// publishes) and the output TCP port (where it writes MPEG-TS, == the tunnel's local port).
///
/// The default reads a template from `$CE_ADAPTER_WHIP_CMD` with `{whip_port}` and `{ts_port}`
/// placeholders, so the receiver binary is swappable without recompiling. Absent that env, the
/// instance reports the receiver is unconfigured rather than silently doing nothing.
#[derive(Debug, Clone)]
pub struct ReceiverCommand {
    template: Option<String>,
}

impl ReceiverCommand {
    /// Build from the environment (`$CE_ADAPTER_WHIP_CMD`).
    pub fn from_env() -> Self {
        ReceiverCommand { template: std::env::var("CE_ADAPTER_WHIP_CMD").ok().filter(|s| !s.trim().is_empty()) }
    }

    /// Build an explicit argv for the given ports, or an error if no receiver is configured.
    pub fn argv(&self, whip_port: u16, ts_port: u16) -> Result<Vec<String>> {
        let tmpl = self.template.as_deref().ok_or_else(|| {
            anyhow!(
                "no WHIP receiver configured: set $CE_ADAPTER_WHIP_CMD (a command with \
                 {{whip_port}} and {{ts_port}} placeholders that terminates WHIP and writes \
                 MPEG-TS to tcp://127.0.0.1:{{ts_port}})"
            )
        })?;
        let rendered = tmpl
            .replace("{whip_port}", &whip_port.to_string())
            .replace("{ts_port}", &ts_port.to_string());
        let argv: Vec<String> = rendered.split_whitespace().map(|s| s.to_string()).collect();
        if argv.is_empty() {
            bail!("$CE_ADAPTER_WHIP_CMD rendered to an empty command");
        }
        Ok(argv)
    }
}

/// A running webrtc-ingest instance: the managed receiver subprocess plus its tunnel binding.
pub struct IngestProc {
    /// The instance id.
    pub instance: String,
    /// The local WHIP bind port (behind the public TLS front).
    pub whip_port: u16,
    /// When it started (for status uptime).
    pub started_at: Instant,
    child: Option<Child>,
}

impl IngestProc {
    /// Whether the receiver process is still alive (best-effort).
    pub fn alive(&mut self) -> bool {
        match &mut self.child {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Stop the receiver process.
    pub async fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.start_kill();
            let _ = c.wait().await;
        }
    }
}

/// Start a webrtc-ingest instance: open the mesh tunnel to the encoder, then launch the WHIP
/// receiver writing MPEG-TS into the tunnel's local port. `whip_port` is the port the browser will
/// publish to (chosen by the runtime). On success the browser can WHIP-publish to `whip_port` and
/// the media lands on `spec.target_node:spec.tunnel_port`.
pub async fn start(
    access: &NodeAccess,
    receiver: &ReceiverCommand,
    spec: &AdapterSpec,
    whip_port: u16,
    caps: Option<&str>,
) -> Result<IngestProc> {
    use tokio::process::Command;

    // The TS sink port is the tunnel's local port — the node forwards it to the encoder.
    let ts_port = pick_ts_port(whip_port);
    open_tunnel(access, &spec.target_node, ts_port, spec.tunnel_port, caps).await?;

    let argv = receiver.argv(whip_port, ts_port)?;
    let (program, args) = argv.split_first().expect("argv non-empty (checked)");
    let child = Command::new(program)
        .args(args)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow!("spawning WHIP receiver '{program}': {e}"))?;

    Ok(IngestProc { instance: spec.instance.clone(), whip_port, started_at: Instant::now(), child: Some(child) })
}

/// Derive the local TS sink port from the WHIP port deterministically (kept in a high range to
/// avoid clashing with the node API / MediaMTX). Pure so it is testable.
pub fn pick_ts_port(whip_port: u16) -> u16 {
    // Map into 20000..=29999 based on the WHIP port.
    20000 + (whip_port % 10000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receiver_unconfigured_errors_clearly() {
        let r = ReceiverCommand { template: None };
        let err = r.argv(8100, 20100).unwrap_err().to_string();
        assert!(err.contains("CE_ADAPTER_WHIP_CMD"));
    }

    #[test]
    fn receiver_renders_placeholders() {
        let r = ReceiverCommand { template: Some("whip-recv --in {whip_port} --out {ts_port}".into()) };
        let argv = r.argv(8100, 20100).unwrap();
        assert_eq!(argv, vec!["whip-recv", "--in", "8100", "--out", "20100"]);
    }

    #[test]
    fn ts_port_is_in_range_and_pure() {
        assert_eq!(pick_ts_port(8100), pick_ts_port(8100));
        let p = pick_ts_port(8100);
        assert!((20000..30000).contains(&p));
    }
}
