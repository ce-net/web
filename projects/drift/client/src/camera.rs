//! 2D camera: a smoothed follow-camera that maps world space to clip space.
//!
//! The camera tracks the local ship with critically-damped smoothing so the
//! view never snaps, and produces the `world -> clip` transform the renderer
//! uploads as a uniform. Clip space is OpenGL/WebGPU NDC: x,y in [-1, 1] with
//! y up. wgpu's WebGPU and WebGL2 backends share this NDC convention for the
//! XY plane, so one transform works on both.

use drift_sim::math::Vec2;

/// A world-space follow camera with smoothing and an explicit zoom (world units
/// visible across half the viewport height).
pub struct Camera {
    /// Current smoothed center in world space.
    pub center: Vec2,
    /// World units from the center to the top edge of the viewport.
    pub half_height: f32,
    /// Viewport aspect ratio (width / height).
    pub aspect: f32,
    /// Smoothing factor per second (higher = snappier).
    pub follow: f32,
}

impl Camera {
    pub fn new() -> Camera {
        Camera {
            center: Vec2::ZERO,
            half_height: 40.0,
            aspect: 16.0 / 9.0,
            follow: 8.0,
        }
    }

    /// Resize: update the aspect ratio from the drawable size in pixels.
    pub fn set_viewport(&mut self, width: u32, height: u32) {
        if height > 0 {
            self.aspect = width as f32 / height as f32;
        }
    }

    /// Smoothly move the camera toward `target` over `dt` seconds. Uses an
    /// exponential approach that is stable for any dt.
    pub fn follow_target(&mut self, target: Vec2, dt: f32) {
        let t = 1.0 - (-self.follow * dt).exp();
        self.center = self.center.add(target.sub(self.center).scale(t));
    }

    /// Zoom by a multiplicative factor (e.g. mouse wheel), clamped to a sane
    /// range so the arena never collapses or vanishes.
    pub fn zoom_by(&mut self, factor: f32) {
        self.half_height = (self.half_height * factor).clamp(8.0, 400.0);
    }

    /// The `world -> clip` transform as a column-major 4x4 (for a uniform).
    /// Maps world XY into NDC: clip = scale * (world - center).
    pub fn world_to_clip(&self) -> [[f32; 4]; 4] {
        let sy = 1.0 / self.half_height;
        let sx = sy / self.aspect;
        let cx = self.center.x;
        let cy = self.center.y;
        // Column-major: each inner array is a column.
        [
            [sx, 0.0, 0.0, 0.0],
            [0.0, sy, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [-sx * cx, -sy * cy, 0.0, 1.0],
        ]
    }

    /// Convert a clip-space point (NDC, [-1,1]) back to world space — used to
    /// turn pointer coordinates into world coordinates for the build UI.
    pub fn clip_to_world(&self, clip: Vec2) -> Vec2 {
        let sy = 1.0 / self.half_height;
        let sx = sy / self.aspect;
        Vec2::new(clip.x / sx + self.center.x, clip.y / sy + self.center.y)
    }
}

impl Default for Camera {
    fn default() -> Camera {
        Camera::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn center_maps_to_origin_of_clip() {
        let cam = Camera::new();
        let m = cam.world_to_clip();
        // world == center -> clip x,y == 0.
        let wx = cam.center.x;
        let wy = cam.center.y;
        let cx = m[0][0] * wx + m[3][0];
        let cy = m[1][1] * wy + m[3][1];
        assert!(cx.abs() < 1e-5 && cy.abs() < 1e-5);
    }

    #[test]
    fn clip_to_world_inverts_world_to_clip() {
        let mut cam = Camera::new();
        cam.center = Vec2::new(12.0, -7.0);
        cam.aspect = 1.5;
        let w = Vec2::new(20.0, 3.0);
        let m = cam.world_to_clip();
        let clip = Vec2::new(
            m[0][0] * w.x + m[3][0],
            m[1][1] * w.y + m[3][1],
        );
        let back = cam.clip_to_world(clip);
        assert!((back.x - w.x).abs() < 1e-3 && (back.y - w.y).abs() < 1e-3);
    }

    #[test]
    fn follow_converges_toward_target() {
        let mut cam = Camera::new();
        let target = Vec2::new(100.0, 0.0);
        for _ in 0..240 {
            cam.follow_target(target, 1.0 / 60.0);
        }
        assert!((cam.center.x - target.x).abs() < 1.0);
    }
}
