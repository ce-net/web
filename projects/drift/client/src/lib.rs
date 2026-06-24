//! drift-client — the wgpu (WebGPU-first, WebGL2-fallback) wasm frontend.
//!
//! This crate renders the authoritative "drift" arena and runs client-side
//! prediction. It links the deterministic [`drift_sim`] crate as an rlib so the
//! predictor steps the *exact* same `World` the host runs, and decodes the
//! host's `Snapshot`/`Delta` net frames directly.
//!
//! Architecture (one module per concern, all but `render` GPU-free and tested):
//! - [`predict`] — local prediction + reconciliation over `drift_sim::World`.
//! - [`interp`]  — ~100ms interpolation of remote (non-predicted) entities.
//! - [`camera`]  — smoothed follow camera; world -> clip transform.
//! - [`input`]   — keyboard/pointer -> `drift_sim::Input` mapping.
//! - [`scene`]   — sim state -> instanced-quad + line vertex data (CE aesthetic).
//! - [`render`]  — wgpu device/surface/pipelines; the only GPU-bound module.
//! - [`app`]     — the per-frame glue tying the above together.
//!
//! The control plane (netgame election, the ephemeral /rt StateFrame transport,
//! AoI, snapshot->/db failover, region sharding) lives in the JS runtime
//! (`web/projects/drift/drift.js`, a different owner). This crate exposes a
//! small wasm-bindgen surface that the runtime drives:
//! `Drift::new`, `on_auth_frame(bytes)`, `set_input(...)`, `fixed_tick()`,
//! `frame(dt)`, and `hud_json()`.

pub mod app;
pub mod camera;
pub mod input;
pub mod interp;
pub mod predict;
pub mod render;
pub mod scene;

// ---------------------------------------------------------------------------
// wasm entry point (the real frontend). Compiled only for wasm32 so the native
// `cargo check` / rlib build does not pull in wasm-bindgen.
// ---------------------------------------------------------------------------
#[cfg(target_arch = "wasm32")]
pub mod wasm;

/// Native test/CI entry. On the host toolchain there is no browser surface, so
/// this just proves the GPU-free logic links and initializes a logger. The
/// real rendering loop is in [`wasm`].
#[cfg(not(target_arch = "wasm32"))]
pub fn native_smoke() {
    let _ = env_logger::try_init();
    // Construct the full game state to prove every GPU-free module links.
    let mut g = app::Game::new(42, 200.0, 0);
    g.input.set_key("KeyW", true);
    let _ = g.fixed_tick();
    let (_quads, _lines, _cam) = g.build_frame();
    log::info!("drift-client native smoke: tick={}", g.hud().predicted_tick);
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_smoke_links_all_modules() {
        super::native_smoke();
    }
}
