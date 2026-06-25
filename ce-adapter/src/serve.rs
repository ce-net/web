//! The ce-adapter **serve-side runtime** — the host daemon that answers control requests and owns
//! the running adapter instances.
//!
//! `ce-adapter serve` runs this on a host (the encoder/relay in the MVP). It subscribes to
//! [`CONTROL_TOPIC`] via the shared [`ce_rs::serve`] loop and, for each request, authorizes the
//! sender ([`crate::caps::authorize`] on `adapter:spawn`) and then starts / stops / lists profile
//! instances. Starting a `webrtc-ingest` instance opens the mesh tunnel and launches the WHIP
//! receiver ([`crate::ingest`]). Authorization is the enforcement point; the authenticated sender
//! NodeId comes from the node for free.

use anyhow::Result;
use ce_identity::NodeId;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::caps::{ABILITY_SPAWN, authorize};
use crate::ingest::{self, IngestProc, NodeAccess, ReceiverCommand};
use crate::profile::Profile;
use crate::protocol::{
    AdapterEndpoint, CONTROL_TOPIC, ControlRequest, ControlResponse, InstanceStatus, edge_url,
};

/// First WHIP bind port the runtime hands out (incremented per instance).
const FIRST_WHIP_PORT: u16 = 18100;

/// Configuration for a serving runtime: accepted authority roots, this host's atlas tags, and the
/// public TLS base its edge endpoints are fronted by.
#[derive(Debug, Clone, Default)]
pub struct ServeConfig {
    /// Accepted capability root keys (besides this host's own id, always accepted).
    pub roots: Vec<NodeId>,
    /// This host's atlas self-tags (consulted when a capability scopes to `Resource::Tag`).
    pub self_tags: Vec<String>,
    /// Public base the adapter edge (WHIP/WHEP) is reachable at, e.g. `https://cast.ce-net.com`.
    pub public_base: String,
}

/// The serve-side runtime: capability context, node access for tunnels, the WHIP receiver seam, and
/// the table of running instances. [`handle_control`](Self::handle_control) is the dispatch core.
pub struct Runtime {
    self_id: NodeId,
    config: ServeConfig,
    access: NodeAccess,
    receiver: ReceiverCommand,
    instances: Mutex<HashMap<String, IngestProc>>,
    next_port: AtomicU16,
}

impl Runtime {
    /// Build a runtime for host `self_id` with `config`, discovering node access + WHIP receiver
    /// from the environment.
    pub fn new(self_id: NodeId, config: ServeConfig) -> Self {
        Runtime {
            self_id,
            config,
            access: NodeAccess::from_env(),
            receiver: ReceiverCommand::from_env(),
            instances: Mutex::new(HashMap::new()),
            next_port: AtomicU16::new(FIRST_WHIP_PORT),
        }
    }

    /// Override node access / receiver (tests).
    pub fn with_backends(mut self, access: NodeAccess, receiver: ReceiverCommand) -> Self {
        self.access = access;
        self.receiver = receiver;
        self
    }

    /// Handle one decoded control request from `requester` (the authenticated sender), returning the
    /// response to reply with. Authorizes `adapter:spawn`, then dispatches.
    pub async fn handle_control(
        &self,
        requester: &NodeId,
        req: ControlRequest,
        now: u64,
        is_revoked: &dyn Fn(&NodeId, u64) -> bool,
    ) -> ControlResponse {
        // Every control op requires adapter:spawn on this host.
        if let Err(e) = authorize(
            &self.self_id,
            &self.config.roots,
            &self.config.self_tags,
            now,
            requester,
            ABILITY_SPAWN,
            req.caps(),
            is_revoked,
        ) {
            return ControlResponse::error(e.to_string());
        }

        match req {
            ControlRequest::Start { spec, .. } => match self.do_start(spec).await {
                Ok(ep) => ControlResponse::Started(ep),
                Err(e) => ControlResponse::error(e.to_string()),
            },
            ControlRequest::Stop { instance, .. } => {
                self.do_stop(&instance).await;
                ControlResponse::Stopped
            }
            ControlRequest::Status { .. } => ControlResponse::Status(self.do_status().await),
        }
    }

    async fn do_start(&self, spec: crate::profile::AdapterSpec) -> Result<AdapterEndpoint> {
        spec.validate()?;
        // Idempotent: an existing instance with this id just re-reports its endpoint.
        {
            let mut insts = self.instances.lock().await;
            if let Some(p) = insts.get_mut(&spec.instance) {
                return Ok(self.endpoint(&spec.instance, spec.profile, p.whip_port, &spec.target_node, spec.tunnel_port));
            }
        }

        match spec.profile {
            Profile::WebrtcIngest => {
                let whip_port = self.next_port.fetch_add(1, Ordering::Relaxed);
                let caps = None; // tunnel cap is minted by the spawner in production; loopback MVP needs none
                let proc = ingest::start(&self.access, &self.receiver, &spec, whip_port, caps).await?;
                let ep = self.endpoint(&spec.instance, spec.profile, whip_port, &spec.target_node, spec.tunnel_port);
                self.instances.lock().await.insert(spec.instance.clone(), proc);
                Ok(ep)
            }
            Profile::WebrtcEgress | Profile::NodeBridge => {
                anyhow::bail!("profile '{}' is not yet implemented in this build (control plane + webrtc-ingest only)", spec.profile)
            }
        }
    }

    async fn do_stop(&self, instance: &str) {
        if let Some(mut p) = self.instances.lock().await.remove(instance) {
            p.stop().await;
        }
    }

    async fn do_status(&self) -> Vec<InstanceStatus> {
        let mut insts = self.instances.lock().await;
        let mut out = Vec::with_capacity(insts.len());
        for (id, p) in insts.iter_mut() {
            out.push(InstanceStatus {
                instance: id.clone(),
                profile: Profile::WebrtcIngest.to_string(),
                active: p.alive(),
                uptime_secs: p.started_at.elapsed().as_secs(),
            });
        }
        out
    }

    fn endpoint(&self, instance: &str, profile: Profile, _whip_port: u16, target_node: &str, tunnel_port: u16) -> AdapterEndpoint {
        let url = edge_url(&self.config.public_base, instance, profile);
        let (whip_url, whep_url) = match profile {
            Profile::WebrtcIngest => (url, String::new()),
            Profile::WebrtcEgress => (String::new(), url),
            Profile::NodeBridge => (String::new(), String::new()),
        };
        AdapterEndpoint {
            instance: instance.to_string(),
            profile: profile.to_string(),
            whip_url,
            whep_url,
            host_node: hex::encode(self.self_id),
            target_node: target_node.to_string(),
            tunnel_port,
        }
    }

    /// The declared host id (hex).
    pub fn self_id_hex(&self) -> String {
        hex::encode(self.self_id)
    }
}

/// Run the serve loop forever (until `shutdown`): answer each control request from the node's
/// message stream. The subscribe + stream + de-dup + reply + reconnect mechanics are delegated to
/// the shared [`ce_rs::serve`] loop; this supplies the control-specific handler (authorization +
/// instance lifecycle). Requires a live local node.
pub async fn serve_loop(
    ce: &ce_rs::CeClient,
    runtime: &Runtime,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<()> {
    let revoked: Arc<std::sync::Mutex<HashSet<(NodeId, u64)>>> = Arc::new(std::sync::Mutex::new(HashSet::new()));
    refresh_revoked(ce, &revoked).await;
    let handler = ControlHandler {
        ce,
        runtime,
        revoked,
        last_refresh: std::sync::Mutex::new(Instant::now()),
    };
    ce_rs::serve::serve(ce, &[CONTROL_TOPIC], &handler, shutdown).await
}

struct ControlHandler<'a> {
    ce: &'a ce_rs::CeClient,
    runtime: &'a Runtime,
    revoked: Arc<std::sync::Mutex<HashSet<(NodeId, u64)>>>,
    last_refresh: std::sync::Mutex<Instant>,
}

impl ce_rs::serve::Handler for ControlHandler<'_> {
    async fn handle(&self, req: ce_rs::serve::Request) -> Vec<u8> {
        // Refresh the revoked set at most every ~10s, lazily on the request path.
        let stale = self
            .last_refresh
            .lock()
            .map(|g| g.elapsed() > Duration::from_secs(10))
            .unwrap_or(true);
        if stale {
            refresh_revoked(self.ce, &self.revoked).await;
            if let Ok(mut g) = self.last_refresh.lock() {
                *g = Instant::now();
            }
        }

        let resp = build_response(self.runtime, &self.revoked, &req.from, &req.payload).await;
        resp.encode().unwrap_or_else(|_| {
            ControlResponse::error("internal: response encode failed").encode().unwrap_or_default()
        })
    }
}

async fn build_response(
    runtime: &Runtime,
    revoked: &Arc<std::sync::Mutex<HashSet<(NodeId, u64)>>>,
    from_hex: &str,
    payload: &[u8],
) -> ControlResponse {
    let requester: NodeId = match hex::decode(from_hex).ok().and_then(|b| b.try_into().ok()) {
        Some(id) => id,
        None => return ControlResponse::error("bad sender node id"),
    };
    let req = match ControlRequest::decode(payload) {
        Ok(r) => r,
        Err(e) => return ControlResponse::error(format!("malformed control request: {e}")),
    };
    let revoked_set = revoked.lock().map(|g| g.clone()).unwrap_or_default();
    let is_revoked = move |issuer: &NodeId, nonce: u64| revoked_set.contains(&(*issuer, nonce));
    runtime.handle_control(&requester, req, now_secs(), &is_revoked).await
}

async fn refresh_revoked(ce: &ce_rs::CeClient, revoked: &Arc<std::sync::Mutex<HashSet<(NodeId, u64)>>>) {
    if let Ok(pairs) = ce.revoked().await {
        let set: HashSet<(NodeId, u64)> = pairs
            .into_iter()
            .filter_map(|(issuer, nonce)| {
                hex::decode(&issuer).ok().and_then(|b| b.try_into().ok()).map(|i| (i, nonce))
            })
            .collect();
        if let Ok(mut g) = revoked.lock() {
            *g = set;
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caps::{ABILITY_WEBRTC_INGEST, grant};
    use crate::profile::AdapterSpec;
    use ce_cap::Resource;
    use ce_identity::Identity;

    fn gen_identity(tag: &str) -> Identity {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("ce-adapter-serve-{}-{tag}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Identity::load_or_generate(&dir).expect("identity")
    }

    fn runtime(host: &Identity) -> Runtime {
        Runtime::new(
            host.node_id(),
            ServeConfig { roots: vec![], self_tags: vec![], public_base: "https://cast.ce-net.com".into() },
        )
        .with_backends(
            NodeAccess { node_url: "http://127.0.0.1:1".into(), token: None },
            // A receiver that just sleeps — start() won't reach it (tunnel fails first in unit tests),
            // but its presence proves the seam is configured.
            ReceiverCommand::from_env(),
        )
    }

    fn ingest_spec() -> AdapterSpec {
        AdapterSpec {
            profile: Profile::WebrtcIngest,
            instance: "cast-cam-01".into(),
            target_node: "ab".repeat(32),
            tunnel_port: 10000,
            bind_http: 0,
            idle_timeout_secs: 0,
        }
    }

    #[tokio::test]
    async fn unauthorized_start_denied() {
        let host = gen_identity("host");
        let dev = gen_identity("dev");
        let rt = runtime(&host);
        // No caps at all.
        let req = ControlRequest::Start { spec: ingest_spec(), caps: String::new() };
        let resp = rt.handle_control(&dev.node_id(), req, 0, &|_, _| false).await;
        match resp {
            ControlResponse::Error(e) => assert!(e.contains("capability"), "{e}"),
            other => panic!("expected denial, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn wrong_ability_start_denied() {
        let host = gen_identity("host");
        let dev = gen_identity("dev");
        let rt = runtime(&host);
        // Granted ingest (publish), not spawn (control).
        let token = grant(&host, dev.node_id(), &[ABILITY_WEBRTC_INGEST], Resource::Node(host.node_id()), 0, 1);
        let req = ControlRequest::Start { spec: ingest_spec(), caps: token };
        let resp = rt.handle_control(&dev.node_id(), req, 0, &|_, _| false).await;
        assert!(matches!(resp, ControlResponse::Error(_)), "spawn must be denied with only ingest ability");
    }

    #[tokio::test]
    async fn egress_profile_reports_unimplemented() {
        let host = gen_identity("host");
        let dev = gen_identity("dev");
        let rt = runtime(&host);
        let token = grant(&host, dev.node_id(), &[ABILITY_SPAWN], Resource::Node(host.node_id()), 0, 2);
        let mut spec = ingest_spec();
        spec.profile = Profile::WebrtcEgress;
        let req = ControlRequest::Start { spec, caps: token };
        let resp = rt.handle_control(&dev.node_id(), req, 0, &|_, _| false).await;
        match resp {
            ControlResponse::Error(e) => assert!(e.contains("not yet implemented"), "{e}"),
            other => panic!("expected unimplemented error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn status_starts_empty_for_authorized() {
        let host = gen_identity("host");
        let dev = gen_identity("dev");
        let rt = runtime(&host);
        let token = grant(&host, dev.node_id(), &[ABILITY_SPAWN], Resource::Node(host.node_id()), 0, 3);
        let resp = rt.handle_control(&dev.node_id(), ControlRequest::Status { caps: token }, 0, &|_, _| false).await;
        match resp {
            ControlResponse::Status(v) => assert!(v.is_empty()),
            other => panic!("expected status, got {other:?}"),
        }
    }
}
