//! The consumer side: dial a peer's exposed endpoint and surface it as a *local* TCP listener.
//!
//! `ce-expose connect <name|node-id> <local-port>` resolves the endpoint to its owning NodeId,
//! binds `127.0.0.1:<local-port>`, and for each inbound local connection drives a framed tunnel
//! session to the origin over the CE mesh (`expose/open` -> `expose/data`* -> `expose/close`),
//! presenting the consumer's `expose:dial` capability on every frame. The bytes flow:
//!
//! ```text
//!   local client <-> 127.0.0.1:<local-port> (this process) <-mesh frames-> origin agent <-> local service
//! ```
//!
//! This is the symmetric counterpart to [`crate::agent`]; together they form the full reverse tunnel
//! with no node change. The `connect` subcommand is the natural local-testing / private-mesh-exposure
//! consumer; a public visitor would instead hit the relay ingress described in `docs/public-ingress.md`.

use std::time::Duration;

use anyhow::{Result, anyhow};
use ce_rs::CeClient;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::proto::*;

/// Resolve `target` (a claimed name or a 64-hex NodeId) to the owning NodeId hex. A name is resolved
/// via the chain's `resolve_name`; a 64-hex string is taken as a NodeId directly. Falls back to DHT
/// service discovery (`expose:<name>`) when the name is not claimed on-chain.
pub async fn resolve_target(client: &CeClient, target: &str) -> Result<String> {
    let t = target.trim();
    // A bare 64-hex string is a NodeId.
    if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(t.to_lowercase());
    }
    if let Some(node) = client.resolve_name(t).await? {
        return Ok(node);
    }
    // Fall back to DHT discovery of the endpoint service.
    let providers = client.find_service(&service_for(t)).await.unwrap_or_default();
    providers
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("could not resolve endpoint '{target}' (no name claim, no provider)"))
}

/// Bind `127.0.0.1:<local_port>` and bridge every inbound connection to the origin's exposed
/// endpoint over the mesh. Runs until the process is killed.
pub async fn connect(
    client: &CeClient,
    origin: &str,
    endpoint: &str,
    local_port: u16,
    caps: &str,
) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port)).await?;
    tracing::info!(
        origin = %&origin[..16.min(origin.len())],
        endpoint,
        local = %format!("127.0.0.1:{local_port}"),
        "ce-expose consumer listening; forwarding to exposed endpoint over the mesh"
    );

    let mut next_session: u64 = 0;
    loop {
        let (sock, peer) = listener.accept().await?;
        next_session += 1;
        let session = format!("s{next_session}-{:x}", now_millis());
        let origin = origin.to_string();
        let endpoint = endpoint.to_string();
        let caps = caps.to_string();
        let client = client.clone();
        tokio::spawn(async move {
            if let Err(e) = bridge_one(&client, &origin, &endpoint, &caps, sock, &session).await {
                tracing::debug!(error = %e, peer = %peer, session = %session, "bridge ended");
            }
        });
    }
}

/// Drive one local connection's bytes through a mesh tunnel session.
async fn bridge_one(
    client: &CeClient,
    origin: &str,
    endpoint: &str,
    caps: &str,
    mut sock: TcpStream,
    session: &str,
) -> Result<()> {
    // 1. Open the session on the origin.
    let open = OpenReq { caps: caps.into(), endpoint: endpoint.into(), session: session.into() };
    let resp: OpenResp = request_json(client, origin, TOPIC_OPEN, &open).await?;
    if !resp.accepted {
        let reason = resp.reason.unwrap_or_else(|| "origin refused".into());
        // Surface the reason to the local client where reasonable, then close.
        let _ = sock.write_all(format!("ce-expose: {reason}\n").as_bytes()).await;
        return Err(anyhow!("open denied: {reason}"));
    }

    let mut up_eof = false; // the local read side has closed
    let mut up_eof_sent = false; // we have already told the origin about that EOF
    let mut down_eof = false;
    let mut buf = vec![0u8; 64 * 1024];

    loop {
        // Read whatever the local client has ready (briefly), so we can carry it in the next frame.
        let up_hex = if up_eof {
            String::new()
        } else {
            match tokio::time::timeout(Duration::from_millis(20), sock.read(&mut buf)).await {
                Ok(Ok(0)) => {
                    up_eof = true;
                    String::new()
                }
                Ok(Ok(n)) => hex::encode(&buf[..n]),
                Ok(Err(e)) => {
                    up_eof = true;
                    tracing::debug!(error = %e, "local read error; signalling up EOF");
                    String::new()
                }
                Err(_) => String::new(), // nothing ready
            }
        };

        // Signal up-EOF exactly once, on the first frame after the local read side closed.
        let send_up_eof = up_eof && !up_eof_sent;
        if send_up_eof {
            up_eof_sent = true;
        }
        let frame = DataReq {
            caps: caps.into(),
            session: session.into(),
            up_hex,
            up_eof: send_up_eof,
        };
        let resp: DataResp = request_json(client, origin, TOPIC_DATA, &frame).await?;
        if !resp.ok {
            let _ = close_session(client, origin, caps, session).await;
            return Err(anyhow!(resp.reason.unwrap_or_else(|| "session error".into())));
        }
        if !resp.down_hex.is_empty() {
            let bytes = hex::decode(&resp.down_hex).map_err(|e| anyhow!("bad down_hex: {e}"))?;
            sock.write_all(&bytes).await?;
        }
        if resp.down_eof {
            down_eof = true;
            let _ = sock.shutdown().await;
        }

        if up_eof && down_eof {
            let _ = close_session(client, origin, caps, session).await;
            return Ok(());
        }
        // Gentle pacing so an idle tunnel does not busy-spin the mesh.
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn close_session(client: &CeClient, origin: &str, caps: &str, session: &str) -> Result<()> {
    let req = CloseReq { caps: caps.into(), session: session.into() };
    let _: CloseResp = request_json(client, origin, TOPIC_CLOSE, &req).await.unwrap_or_default();
    Ok(())
}

/// Probe an endpoint for liveness/authorization (used by `ce-expose ping`).
pub async fn ping(client: &CeClient, origin: &str, endpoint: &str, caps: &str) -> Result<PingResp> {
    let req = PingReq { caps: caps.into(), endpoint: endpoint.into() };
    request_json(client, origin, TOPIC_PING, &req).await
}

/// Send a JSON request to `origin` on `topic` over the mesh and decode the JSON reply.
async fn request_json<Req: serde::Serialize, Resp: for<'de> serde::Deserialize<'de>>(
    client: &CeClient,
    origin: &str,
    topic: &str,
    req: &Req,
) -> Result<Resp> {
    let body = serde_json::to_vec(req)?;
    let reply = client.request(origin, topic, &body, 30_000).await?;
    serde_json::from_slice(&reply).map_err(|e| anyhow!("bad reply on {topic}: {e}"))
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
