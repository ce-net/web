//! The origin agent: `ce-expose http <port>` / `ce-expose tcp <port>`.
//!
//! Runs on the machine whose local service is being exposed. It polls the local CE node's mesh inbox
//! for `expose/*` requests, authorizes each against a signed `ce-cap` chain (the [`session::gate`]
//! choke-point, ability `expose:dial`, rooted at this origin's own key or a configured org root), and
//! for an authorized session it dials `127.0.0.1:<port>` and pumps bytes between the mesh frames and
//! that local socket. This is the capability-gated **reverse tunnel**: a peer that holds the cap can
//! reach your local port; everyone else is denied — there is no public surface and no node change.
//!
//! Transport note: the data path here is framed request/reply (the only mesh transport the SDK
//! exposes). It is correct and testable today; a future optimization swaps the per-frame exchange for
//! a single raw libp2p stream (`POST /tunnel`) without touching the protocol's authorization model.
//! See `docs/public-ingress.md` for the relay-tier public-HTTP extension (NOT implemented here).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use ce_rs::CeClient;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

use crate::proto::*;
use crate::session::{CloseReason, RevokedSet, Session, gate};

/// Configuration for a single exposed endpoint.
#[derive(Debug, Clone)]
pub struct ExposeConfig {
    /// The local TCP port to forward authorized sessions to.
    pub local_port: u16,
    /// Endpoint name (advertised on the DHT as `expose:<name>`); also used as the consumer's hint.
    pub name: String,
    /// Whether this is an HTTP or raw-TCP endpoint (advisory; identical on the wire).
    pub kind: Kind,
}

/// A live local connection backing one tunnel session: the TCP stream plus the pure session state.
struct Conn {
    stream: TcpStream,
    session: Session,
}

/// The agent's per-process state: every open session keyed by `(consumer_hex, session_id)`.
type Sessions = Arc<Mutex<HashMap<(String, String), Conn>>>;

/// Run the origin agent loop until the process is killed.
///
/// `roots` are accepted capability root NodeIds (32-byte); a chain rooted at one of them (or at this
/// origin's own key) authorizes a dial. `cfg` describes the single endpoint this invocation exposes.
pub async fn serve(client: &CeClient, cfg: ExposeConfig, roots: Vec<[u8; 32]>) -> Result<()> {
    let origin_hex = client.status().await?.node_id;
    let origin_id: [u8; 32] = hex::decode(&origin_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| anyhow!("node returned a malformed node id"))?;

    // Advertise the endpoint on the DHT so consumers can discover the owning NodeId by name.
    if let Err(e) = client.advertise_service(&service_for(&cfg.name)).await {
        tracing::warn!(error = %e, "could not advertise expose endpoint (continuing)");
    }
    // Best-effort: claim the human-readable name on-chain so `<name>` resolves to this NodeId.
    if let Err(e) = client.claim_name(&cfg.name).await {
        tracing::debug!(error = %e, "claim_name skipped (name may be taken or already ours)");
    }

    tracing::info!(
        origin = %&origin_hex[..16.min(origin_hex.len())],
        endpoint = %cfg.name,
        kind = cfg.kind.as_str(),
        local_port = cfg.local_port,
        roots = roots.len(),
        "ce-expose agent serving (capability-gated, ability=expose:dial)"
    );

    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut revoked: RevokedSet = RevokedSet::new();
    let mut tick: u32 = 0;

    loop {
        // Refresh the revoked set and re-advertise periodically (provider records expire).
        if tick.is_multiple_of(20) {
            if let Ok(pairs) = client.revoked().await {
                revoked = pairs
                    .into_iter()
                    .filter_map(|(issuer, nonce)| {
                        hex::decode(&issuer)
                            .ok()
                            .and_then(|b| <[u8; 32]>::try_from(b).ok())
                            .map(|i| (i, nonce))
                    })
                    .collect();
            }
            let _ = client.advertise_service(&service_for(&cfg.name)).await;
        }
        tick = tick.wrapping_add(1);

        for m in client.messages().await.unwrap_or_default() {
            let Some(token) = m.reply_token else { continue };
            if !m.topic.starts_with(TOPIC_PREFIX) || !seen.insert(token) {
                continue;
            }
            let reply = handle(
                &m.topic,
                &m.from,
                &m.payload_hex,
                &origin_id,
                &roots,
                &revoked,
                &cfg,
                &sessions,
            )
            .await;
            if let Err(e) = client.reply(token, &reply).await {
                tracing::warn!(error = %e, "failed to send mesh reply");
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Authorize, dispatch, and serialize a reply. Any error becomes a typed negative reply so the
/// consumer always gets a structured answer instead of a timeout.
#[allow(clippy::too_many_arguments)]
async fn handle(
    topic: &str,
    from_hex: &str,
    payload_hex: &str,
    origin_id: &[u8; 32],
    roots: &[[u8; 32]],
    revoked: &RevokedSet,
    cfg: &ExposeConfig,
    sessions: &Sessions,
) -> Vec<u8> {
    let action = topic.strip_prefix(TOPIC_PREFIX).unwrap_or(topic);
    match handle_inner(action, from_hex, payload_hex, origin_id, roots, revoked, cfg, sessions).await
    {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::debug!(action, error = %e, "request denied/failed");
            serde_json::to_vec(&serde_json::json!({
                "accepted": false, "ok": false, "alive": false, "closed": false,
                "reason": e.to_string()
            }))
            .unwrap_or_default()
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_inner(
    action: &str,
    from_hex: &str,
    payload_hex: &str,
    origin_id: &[u8; 32],
    roots: &[[u8; 32]],
    revoked: &RevokedSet,
    cfg: &ExposeConfig,
    sessions: &Sessions,
) -> Result<Vec<u8>> {
    let payload = hex::decode(payload_hex).map_err(|e| anyhow!("payload hex: {e}"))?;
    let from: [u8; 32] = hex::decode(from_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| anyhow!("bad sender id"))?;

    // Validate the action and extract the shared caps field, then run the single authorization gate.
    let _ability = ability_for(action)?;
    let caps = caps_of(&payload)?;
    let decision = gate(origin_id, roots, now(), &from, &caps, revoked);
    if !decision.is_allowed() {
        return Err(anyhow!("{}", decision.reason().unwrap_or("denied")));
    }

    match action {
        "ping" => {
            let _req: PingReq = serde_json::from_slice(&payload)?;
            Ok(serde_json::to_vec(&PingResp {
                alive: true,
                kind: Some(cfg.kind.as_str().to_string()),
            })?)
        }
        "open" => {
            let req: OpenReq = serde_json::from_slice(&payload)?;
            let resp = do_open(cfg, from_hex, &req, sessions).await;
            Ok(serde_json::to_vec(&resp)?)
        }
        "data" => {
            let req: DataReq = serde_json::from_slice(&payload)?;
            let resp = do_data(from_hex, &req, sessions).await;
            Ok(serde_json::to_vec(&resp)?)
        }
        "close" => {
            let req: CloseReq = serde_json::from_slice(&payload)?;
            let closed = do_close(from_hex, &req, sessions).await;
            Ok(serde_json::to_vec(&CloseResp { closed, reason: None })?)
        }
        _ => unreachable!("ability_for validated the action above"),
    }
}

/// Open a session: dial the local service and register a fresh [`Session`].
async fn do_open(cfg: &ExposeConfig, from_hex: &str, req: &OpenReq, sessions: &Sessions) -> OpenResp {
    let key = (from_hex.to_string(), req.session.clone());
    {
        let map = sessions.lock().await;
        if map.contains_key(&key) {
            // Idempotent re-open: the session already exists.
            return OpenResp {
                accepted: true,
                kind: Some(cfg.kind.as_str().to_string()),
                reason: None,
            };
        }
    }
    match TcpStream::connect(("127.0.0.1", cfg.local_port)).await {
        Ok(stream) => {
            let conn = Conn { stream, session: Session::new(from_hex, req.session.clone()) };
            sessions.lock().await.insert(key, conn);
            tracing::info!(consumer = %&from_hex[..16.min(from_hex.len())], session = %req.session,
                port = cfg.local_port, "opened tunnel session");
            OpenResp { accepted: true, kind: Some(cfg.kind.as_str().to_string()), reason: None }
        }
        Err(e) => OpenResp {
            accepted: false,
            kind: Some(cfg.kind.as_str().to_string()),
            reason: Some(format!("local dial 127.0.0.1:{} failed: {e}", cfg.local_port)),
        },
    }
}

/// Pump one frame: write the consumer's `up` bytes to the local socket, then read whatever the
/// service produced and return it as `down`. The pure [`Session`] tracks flow + half-close state.
async fn do_data(from_hex: &str, req: &DataReq, sessions: &Sessions) -> DataResp {
    let key = (from_hex.to_string(), req.session.clone());
    let mut map = sessions.lock().await;
    let Some(conn) = map.get_mut(&key) else {
        return DataResp { ok: false, reason: Some("unknown session".into()), ..Default::default() };
    };

    // 1. Consumer -> local.
    if !req.up_hex.is_empty() {
        match hex::decode(&req.up_hex) {
            Ok(bytes) => {
                if let Err(e) = conn.stream.write_all(&bytes).await {
                    conn.session.force_close(CloseReason::LocalError);
                    map.remove(&key);
                    return DataResp {
                        ok: false,
                        reason: Some(format!("local write failed: {e}")),
                        ..Default::default()
                    };
                }
                conn.session.record_up(bytes.len());
            }
            Err(e) => {
                return DataResp {
                    ok: false,
                    reason: Some(format!("bad up_hex: {e}")),
                    ..Default::default()
                };
            }
        }
    }
    if req.up_eof {
        // Half-close the write side toward the local service so it sees consumer EOF.
        let _ = conn.stream.shutdown().await;
        conn.session.mark_up_eof();
    }

    // 2. Local -> consumer. Read one bounded, non-blocking-ish chunk so the frame returns promptly.
    let mut buf = vec![0u8; 64 * 1024];
    let mut down_eof = false;
    let read = tokio::time::timeout(Duration::from_millis(50), conn.stream.read(&mut buf)).await;
    let down_hex = match read {
        Ok(Ok(0)) => {
            conn.session.mark_down_eof();
            down_eof = true;
            String::new()
        }
        Ok(Ok(n)) => {
            conn.session.record_down(n);
            hex::encode(&buf[..n])
        }
        Ok(Err(e)) => {
            conn.session.force_close(CloseReason::LocalError);
            map.remove(&key);
            return DataResp {
                ok: false,
                reason: Some(format!("local read failed: {e}")),
                ..Default::default()
            };
        }
        // Timeout: nothing to read right now — return empty `down`, keep the session open.
        Err(_) => String::new(),
    };

    // Drop the session once both halves have closed.
    if !conn.session.is_open() {
        map.remove(&key);
    }

    DataResp { ok: true, down_hex, down_eof, reason: None }
}

/// Close a session: force-close and drop the local connection.
async fn do_close(from_hex: &str, req: &CloseReq, sessions: &Sessions) -> bool {
    let key = (from_hex.to_string(), req.session.clone());
    let mut map = sessions.lock().await;
    if let Some(mut conn) = map.remove(&key) {
        conn.session.force_close(CloseReason::ConsumerClosed);
        let _ = conn.stream.shutdown().await;
        tracing::info!(session = %req.session, up = conn.session.up_bytes,
            down = conn.session.down_bytes, "closed tunnel session");
        true
    } else {
        false
    }
}

/// Current unix time in seconds.
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
