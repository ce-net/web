// Instanced-quad shader for drift.
//
// One unit quad ([-0.5, 0.5]^2) is drawn once per instance. Each instance
// carries a world transform (center, rotation, half-size) and an RGBA color.
// The shared camera uniform maps world space to clip space (NDC). This single
// pipeline renders ships' blocks, asteroids, projectiles, and pickups by
// varying instance data only — cheap and WebGL2/WebGPU portable.

struct Camera {
    // column-major world -> clip
    view_proj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;

struct VsIn {
    // Unit-quad corner in [-0.5, 0.5].
    @location(0) corner: vec2<f32>,
    // Per-instance:
    @location(1) center: vec2<f32>,
    @location(2) half_size: vec2<f32>,
    @location(3) rot: f32,
    @location(4) color: vec4<f32>,
};

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) local: vec2<f32>,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
    let c = cos(in.rot);
    let s = sin(in.rot);
    // Scale then rotate the unit corner into world space.
    let scaled = in.corner * in.half_size * 2.0;
    let rotated = vec2<f32>(
        scaled.x * c - scaled.y * s,
        scaled.x * s + scaled.y * c,
    );
    let world = in.center + rotated;
    var out: VsOut;
    out.clip = camera.view_proj * vec4<f32>(world, 0.0, 1.0);
    out.color = in.color;
    out.local = in.corner;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // Soft edge falloff for a subtle glow in the CE aesthetic.
    let d = length(in.local) * 2.0;
    let edge = smoothstep(1.05, 0.75, d);
    return vec4<f32>(in.color.rgb, in.color.a * edge);
}
