//! Deterministic 2D math primitives and a seeded PRNG.
//!
//! Everything here is `f32` and order-stable. No wall-clock, no thread-local
//! randomness: the only source of "randomness" in the simulation is the
//! [`Rng`] which lives entirely inside the world state and is advanced
//! deterministically by [`crate::world::World::step`].

use serde::{Deserialize, Serialize};

/// A 2D vector. All simulation math operates on `f32` so that the host and the
/// client perform byte-identical arithmetic.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    #[inline]
    pub const fn new(x: f32, y: f32) -> Self {
        Vec2 { x, y }
    }

    #[inline]
    pub fn add(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x + o.x, self.y + o.y)
    }

    #[inline]
    pub fn sub(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x - o.x, self.y - o.y)
    }

    #[inline]
    pub fn scale(self, s: f32) -> Vec2 {
        Vec2::new(self.x * s, self.y * s)
    }

    #[inline]
    pub fn dot(self, o: Vec2) -> f32 {
        self.x * o.x + self.y * o.y
    }

    #[inline]
    pub fn len_sq(self) -> f32 {
        self.x * self.x + self.y * self.y
    }

    #[inline]
    pub fn len(self) -> f32 {
        self.len_sq().sqrt()
    }

    /// Returns a unit vector, or [`Vec2::ZERO`] for a (near) zero vector.
    #[inline]
    pub fn normalized(self) -> Vec2 {
        let l = self.len();
        if l > 1e-6 {
            Vec2::new(self.x / l, self.y / l)
        } else {
            Vec2::ZERO
        }
    }

    /// Rotate this vector by `angle` radians. Uses `f32` sin/cos for
    /// determinism across host and client (both targets use the same
    /// platform libm path under wasm; native tests pin the algorithm).
    #[inline]
    pub fn rotated(self, angle: f32) -> Vec2 {
        let (s, c) = sin_cos(angle);
        Vec2::new(self.x * c - self.y * s, self.x * s + self.y * c)
    }
}

/// Deterministic sin/cos pair. Kept as a single function so callers always
/// compute both from the same angle in the same order.
#[inline]
pub fn sin_cos(a: f32) -> (f32, f32) {
    (a.sin(), a.cos())
}

/// Wrap an angle to the range `[-PI, PI)` deterministically.
#[inline]
pub fn wrap_angle(mut a: f32) -> f32 {
    const TWO_PI: f32 = std::f32::consts::PI * 2.0;
    while a >= std::f32::consts::PI {
        a -= TWO_PI;
    }
    while a < -std::f32::consts::PI {
        a += TWO_PI;
    }
    a
}

/// Clamp a value to `[lo, hi]`.
#[inline]
pub fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// An axis-aligned bounding box used by the broadphase.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aabb {
    pub min: Vec2,
    pub max: Vec2,
}

impl Aabb {
    #[inline]
    pub fn from_center_half(center: Vec2, half: Vec2) -> Self {
        Aabb {
            min: center.sub(half),
            max: center.add(half),
        }
    }

    #[inline]
    pub fn intersects(&self, o: &Aabb) -> bool {
        self.min.x <= o.max.x
            && self.max.x >= o.min.x
            && self.min.y <= o.max.y
            && self.max.y >= o.min.y
    }

    #[inline]
    pub fn contains_point(&self, p: Vec2) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }
}

/// SplitMix64 seeded PRNG. Pure integer math, fully deterministic, and stored
/// inside the world state so a snapshot captures the exact future stream.
///
/// This is the ONLY source of randomness in the simulation.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rng {
    pub state: u64,
}

impl Rng {
    #[inline]
    pub fn new(seed: u64) -> Self {
        // Avoid an all-zero state degenerate stream.
        Rng {
            state: seed ^ 0x9E37_79B9_7F4A_7C15,
        }
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }

    /// Uniform `f32` in `[0, 1)` derived from the top 24 bits (mantissa width).
    #[inline]
    pub fn next_f32(&mut self) -> f32 {
        let bits = self.next_u32() >> 8; // 24 bits
        (bits as f32) / (1u32 << 24) as f32
    }

    /// Uniform `f32` in `[lo, hi)`.
    #[inline]
    pub fn range_f32(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next_f32()
    }

    /// Uniform `u32` in `[0, n)` (n > 0).
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        if n == 0 {
            0
        } else {
            self.next_u32() % n
        }
    }
}
