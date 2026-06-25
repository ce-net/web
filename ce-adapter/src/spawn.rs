//! [`SpawnClient`] — the on-demand spawn + control API consumers call.
//!
//! This is the reusable surface other apps (ce-cast, ce-meet, ...) use to get an adapter when a
//! browser hits a wall the mesh can't cross. Two layers, both composing existing CE primitives:
//!
//! * **Placement (dynamic spawn).** [`deploy_serve`] uses [`ce_fn::FnClient`] to place a long-lived
//!   `ce-adapter serve` cell on a chosen/ranked host via the normal job system (billing + kill come
//!   for free). The adapter is therefore spawned on demand, never bundled into the consumer app.
//! * **Control.** [`SpawnClient::start`]/[`stop`](SpawnClient::stop)/[`status`](SpawnClient::status)
//!   send a [`ControlRequest`] over the authenticated `AppRequest`/reply primitive to a host running
//!   `ce-adapter serve`, bringing up / tearing down a specific profile instance and returning its
//!   public endpoint.
//!
//! A typical consumer flow: `deploy_serve` once per host (idempotent at the app level), then `start`
//! an instance per source, hand its `whip_url` to the browser, and `stop` when done.

use anyhow::{Result, anyhow, bail};
use ce_fn::{Function, Handler, Registry, FnClient};
use ce_rs::{Amount, CeClient};

use crate::profile::{AdapterSpec, Profile};
use crate::protocol::{
    AdapterEndpoint, CONTROL_TOPIC, ControlRequest, ControlResponse, InstanceStatus,
};

/// Default control request timeout (ms). Starting an instance may pull an image / open a tunnel.
pub const DEFAULT_CONTROL_TIMEOUT_MS: u64 = 60_000;

/// The reusable spawn + control client, bound to one local CE node.
pub struct SpawnClient {
    ce: CeClient,
    /// The public TLS base the adapter's edge endpoints are reachable at (e.g.
    /// `https://cast.ce-net.com`). Returned endpoints' whip/whep URLs are built from this.
    public_base: String,
    /// Per-request control timeout.
    timeout_ms: u64,
}

impl SpawnClient {
    /// Build a control client over `ce`. `public_base` is the TLS front the adapter's edge is served
    /// behind (used only to surface endpoint URLs; the runtime is the source of truth).
    pub fn new(ce: CeClient, public_base: impl Into<String>) -> Self {
        SpawnClient { ce, public_base: public_base.into(), timeout_ms: DEFAULT_CONTROL_TIMEOUT_MS }
    }

    /// Override the per-request control timeout.
    pub fn with_timeout(mut self, ms: u64) -> Self {
        self.timeout_ms = ms.max(1);
        self
    }

    /// The public base the adapter edge is fronted by.
    pub fn public_base(&self) -> &str {
        &self.public_base
    }

    /// Start (or confirm) an adapter `spec` on `host` (a node running `ce-adapter serve`), presenting
    /// `caps` (a chain granting `adapter:spawn` on that host). Returns the instance's public endpoint.
    pub async fn start(&self, host: &str, spec: AdapterSpec, caps: &str) -> Result<AdapterEndpoint> {
        spec.validate()?;
        validate_hex64(host, "host node id")?;
        let req = ControlRequest::Start { spec, caps: caps.to_string() };
        match self.control(host, &req).await? {
            ControlResponse::Started(ep) => Ok(ep),
            ControlResponse::Error(e) => bail!("adapter start denied: {e}"),
            other => bail!("unexpected control response to start: {other:?}"),
        }
    }

    /// Convenience: start a `webrtc-ingest` instance on `host` whose media tunnels to `encoder_node`
    /// on `tunnel_port`. `instance` is a caller-chosen topic-safe id.
    pub async fn ingest(
        &self,
        host: &str,
        instance: &str,
        encoder_node: &str,
        tunnel_port: u16,
        caps: &str,
    ) -> Result<AdapterEndpoint> {
        let spec = AdapterSpec {
            profile: Profile::WebrtcIngest,
            instance: instance.to_string(),
            target_node: encoder_node.to_string(),
            tunnel_port,
            bind_http: 0,
            idle_timeout_secs: 0,
        };
        self.start(host, spec, caps).await
    }

    /// Stop a running instance by id on `host`.
    pub async fn stop(&self, host: &str, instance: &str, caps: &str) -> Result<()> {
        validate_hex64(host, "host node id")?;
        let req = ControlRequest::Stop { instance: instance.to_string(), caps: caps.to_string() };
        match self.control(host, &req).await? {
            ControlResponse::Stopped => Ok(()),
            ControlResponse::Error(e) => bail!("adapter stop denied: {e}"),
            other => bail!("unexpected control response to stop: {other:?}"),
        }
    }

    /// List the instances `host` is running.
    pub async fn status(&self, host: &str, caps: &str) -> Result<Vec<InstanceStatus>> {
        validate_hex64(host, "host node id")?;
        let req = ControlRequest::Status { caps: caps.to_string() };
        match self.control(host, &req).await? {
            ControlResponse::Status(s) => Ok(s),
            ControlResponse::Error(e) => bail!("adapter status denied: {e}"),
            other => bail!("unexpected control response to status: {other:?}"),
        }
    }

    /// Send one control request to `host` and decode the response.
    async fn control(&self, host: &str, req: &ControlRequest) -> Result<ControlResponse> {
        let body = req.encode()?;
        let reply = self.ce.request(host, CONTROL_TOPIC, &body, self.timeout_ms).await?;
        ControlResponse::decode(&reply)
    }
}

/// Place a long-lived `ce-adapter serve` cell on `host` via the ce-fn job system — the dynamic
/// spawn of the adapter daemon itself. `image` is a container image bundling the `ce-adapter`
/// binary; `grant` authorizes the deploy (`fn:deploy`) on the host. Returns the deployment record.
///
/// The cell runs `ce-adapter serve`, which subscribes to [`CONTROL_TOPIC`] and answers
/// [`SpawnClient`] control requests. Co-locating the adapter on the encoder node makes the media
/// tunnel a loopback (no cross-mesh hop) — pass the encoder's node id as `host`.
pub async fn deploy_serve(
    fns: &mut FnClient,
    host: &str,
    image: &str,
    grant: Option<&str>,
) -> Result<ce_fn::Deployment> {
    validate_hex64(host, "host node id")?;
    let f = Function {
        name: format!("ce-adapter-serve-{}", &host[..8.min(host.len())]),
        handler: Handler::Container { image: image.to_string(), cmd: vec!["serve".into()] },
        cpu_cores: 2,
        mem_mb: 1024,
        // Long-lived: large duration so the host does not reclaim the serve daemon mid-stream.
        duration_secs: 24 * 60 * 60,
        bid: Amount::from_credits(1),
        select: vec![],
        env: vec![],
        secrets: vec![],
        replicas: 1,
    };
    fns.deploy_on(f, host, grant).await
}

/// Build a fresh ce-fn control plane bound to `ce` with an in-memory registry (for `deploy_serve`).
pub fn fn_client(ce: CeClient) -> FnClient {
    FnClient::new(ce, Registry::default())
}

/// A deterministic, topic-safe instance id from a `prefix` plus the tunnel target, so repeated
/// spawns for the same (prefix, encoder, port) coalesce onto one instance.
pub fn instance_id(prefix: &str, encoder_node: &str, tunnel_port: u16) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(encoder_node.as_bytes());
    h.update(tunnel_port.to_le_bytes());
    let d = h.finalize();
    let safe: String = prefix
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-' || *c == '_')
        .take(40)
        .collect();
    format!("{safe}-{}", hex::encode(&d[..6]))
}

fn validate_hex64(s: &str, what: &str) -> Result<()> {
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("{what} must be 64 hex characters (got {})", s.len()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_id_is_deterministic_and_safe() {
        let a = instance_id("cast cam!", &"ab".repeat(32), 10000);
        let b = instance_id("cast cam!", &"ab".repeat(32), 10000);
        assert_eq!(a, b, "same inputs -> same id");
        assert!(a.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'));
        let c = instance_id("cast cam!", &"ab".repeat(32), 10001);
        assert_ne!(a, c, "different port -> different id");
    }

    #[test]
    fn validate_hex64_checks_len_and_charset() {
        assert!(validate_hex64(&"a".repeat(64), "x").is_ok());
        assert!(validate_hex64(&"a".repeat(63), "x").is_err());
        assert!(validate_hex64(&"g".repeat(64), "x").is_err());
    }
}
