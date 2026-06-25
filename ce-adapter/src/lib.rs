//! # ce-adapter — dynamically-spawned mesh adapters
//!
//! `ce-adapter` is the **general, reusable bridge** for the case where a browser/edge endpoint can't
//! speak the CE mesh transport directly: browsers cannot open `/ce/tunnel/1` libp2p streams, and a
//! browser is not yet a full CE node. Instead of bundling a one-off bridge into every app, an app
//! **spawns an adapter on demand** (via [`ce_fn`], so billing + placement + teardown come for free),
//! and the adapter terminates the edge protocol next to the browser and carries the payload onto the
//! mesh.
//!
//! It is an **app-tier** crate built on existing CE primitives via [`ce_rs`] / [`ce_cap`] / [`ce_fn`];
//! it adds **no node endpoints**.
//!
//! ## What it composes (no reinvention)
//!
//! | ce-adapter concern | CE primitive |
//! |---|---|
//! | spawn the adapter daemon on demand | [`ce_fn::FnClient`] (`mesh-deploy` job; billing + kill) |
//! | carry media browser↔node can't | the node's `POST /tunnel` → `/ce/tunnel/1` ([`ingest::open_tunnel`]) |
//! | control (start/stop/status) | authenticated `AppRequest`/reply on [`protocol::CONTROL_TOPIC`] |
//! | discovery | the control reply carries the public endpoint; `advertise_service` for a handle |
//! | authorize spawn + edge use | `ce-cap` chains: [`caps::ABILITY_SPAWN`] / [`caps::edge_ability`] |
//!
//! ## Profiles
//!
//! - [`profile::Profile::WebrtcIngest`] — browser WHIP → mesh tunnel to an encoder (the streaming
//!   fix: no relay re-decode). **Shipped.**
//! - [`profile::Profile::WebrtcEgress`] — mesh tunnel → browser WHEP (preview/watch). *Documented
//!   extension point.*
//! - [`profile::Profile::NodeBridge`] — node services for a non-node browser. *Documented extension
//!   point.*
//!
//! ## Consumer quick start
//!
//! ```no_run
//! use ce_adapter::SpawnClient;
//! use ce_rs::CeClient;
//! # async fn demo(encoder_node: &str, cap: &str) -> anyhow::Result<()> {
//! let spawn = SpawnClient::new(CeClient::local(), "https://cast.ce-net.com");
//! // Bring up a webrtc-ingest adapter co-located on the encoder; hand its whip_url to the browser.
//! let ep = spawn.ingest(encoder_node, "cast-cam-01", encoder_node, 10_000, cap).await?;
//! println!("publish WHIP at {}", ep.whip_url);
//! # Ok(()) }
//! ```
//!
//! See `src/main.rs` for the CLI (`ce-adapter serve|ingest|stop|status|grant`).

pub mod caps;
pub mod ingest;
pub mod profile;
pub mod protocol;
pub mod serve;
pub mod spawn;

pub use profile::{AdapterSpec, Profile};
pub use protocol::{
    AdapterEndpoint, AdapterIdle, CONTROL_TOPIC, ControlRequest, ControlResponse, IDLE_TOPIC,
    InstanceStatus, edge_url,
};
pub use serve::{Runtime, ServeConfig, serve_loop};
pub use spawn::{SpawnClient, deploy_serve, fn_client, instance_id};
