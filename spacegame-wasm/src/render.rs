//! wgpu renderer — an immediate-mode 2D renderer. Each frame we build a triangle list from the
//! authoritative snapshot (ships, bullets, beams, explosions, debris, the asteroid field) in world
//! space, upload it, and draw with one colored pipeline under a camera uniform. A single shader, no
//! textures yet — the foundation the richer shape-mesh path (`spacegame::shapedef` GPU meshes) plugs
//! into next.

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::game::{Fx, Game, RenderShip};
use spacegame::sim::{rock_in_cell, ROCK_CELL, SECTOR_SIZE, SHIP_R};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    pos: [f32; 2],
    color: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Camera {
    /// cam_x, cam_y, scale_x, scale_y
    data: [f32; 4],
}

const SHADER: &str = r#"
struct Camera { data: vec4<f32>, };
@group(0) @binding(0) var<uniform> cam: Camera;

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs(@location(0) pos: vec2<f32>, @location(1) color: vec4<f32>) -> VsOut {
  var o: VsOut;
  let c = (pos - cam.data.xy) * cam.data.zw;
  o.clip = vec4<f32>(c, 0.0, 1.0);
  o.color = color;
  return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> { return in.color; }
"#;

pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    cam_buf: wgpu::Buffer,
    cam_bind: wgpu::BindGroup,
    verts: Vec<Vertex>,
}

impl Renderer {
    /// Build a renderer for a canvas (async: requests an adapter + device).
    pub async fn new(canvas: web_sys::HtmlCanvasElement, w: u32, h: u32) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::GL,
            ..Default::default()
        });
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| format!("create_surface: {e}"))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .ok_or("no adapter")?;
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("spacegame"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_webgl2_defaults(),
                    ..Default::default()
                },
                None,
            )
            .await
            .map_err(|e| format!("request_device: {e}"))?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats.iter().copied().find(|f| f.is_srgb()).unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: w.max(1),
            height: h.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        };
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("2d"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let cam_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("camera"),
            size: std::mem::size_of::<Camera>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("cam-bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let cam_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("cam-bg"),
            layout: &bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: cam_buf.as_entire_binding() }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("layout"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("pipe"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs",
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs",
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, ..Default::default() },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Ok(Renderer { surface, device, queue, config, pipeline, cam_buf, cam_bind, verts: Vec::new() })
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        self.config.width = w.max(1);
        self.config.height = h.max(1);
        self.surface.configure(&self.device, &self.config);
    }

    /// Draw one frame: build geometry from the game, upload, and render.
    pub fn frame(&mut self, game: &Game) {
        let (w, h) = (self.config.width as f32, self.config.height as f32);
        // Zoom: fit the profile view radius to the smaller screen dimension.
        let ppw = h / (game.profile.view_radius * 2.0);
        let scale = [2.0 * ppw / w, -2.0 * ppw / h];
        let cam = Camera { data: [game.cam_x, game.cam_y, scale[0], scale[1]] };
        self.queue.write_buffer(&self.cam_buf, 0, bytemuck::bytes_of(&cam));

        self.verts.clear();
        self.build_asteroids(game);
        let fx = game.visible_fx();
        self.build_fx(&fx);
        for s in game.visible_ships() {
            self.build_ship(&s);
        }

        let vbuf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("verts"),
            contents: bytemuck::cast_slice(&self.verts),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(_) => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("main"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.012, g: 0.024, b: 0.055, a: 1.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            if !self.verts.is_empty() {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.cam_bind, &[]);
                pass.set_vertex_buffer(0, vbuf.slice(..));
                pass.draw(0..self.verts.len() as u32, 0..1);
            }
        }
        self.queue.submit([enc.finish()]);
        frame.present();
    }

    // ---- geometry builders (triangle list, world space) ----

    fn tri(&mut self, a: [f32; 2], b: [f32; 2], c: [f32; 2], col: [f32; 4]) {
        self.verts.push(Vertex { pos: a, color: col });
        self.verts.push(Vertex { pos: b, color: col });
        self.verts.push(Vertex { pos: c, color: col });
    }
    fn quad(&mut self, cx: f32, cy: f32, hw: f32, hh: f32, col: [f32; 4]) {
        self.tri([cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], col);
        self.tri([cx - hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh], col);
    }
    fn disc(&mut self, cx: f32, cy: f32, r: f32, col: [f32; 4]) {
        let n = 12;
        let mut prev = [cx + r, cy];
        for i in 1..=n {
            let t = std::f32::consts::TAU * i as f32 / n as f32;
            let p = [cx + t.cos() * r, cy + t.sin() * r];
            self.tri([cx, cy], prev, p, col);
            prev = p;
        }
    }
    fn line(&mut self, a: [f32; 2], b: [f32; 2], width: f32, col: [f32; 4]) {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = (dx * dx + dy * dy).sqrt().max(1e-3);
        let (nx, ny) = (-dy / len * width, dx / len * width);
        self.tri([a[0] + nx, a[1] + ny], [a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], col);
        self.tri([a[0] + nx, a[1] + ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], col);
    }

    fn build_ship(&mut self, s: &RenderShip) {
        let mut col = hue_rgb(s.hue, 1.0);
        if !s.alive {
            col[3] = 0.25;
        }
        // A simple arrow/triangle ship pointing along its heading.
        let (c, sn) = (s.a.cos(), s.a.sin());
        let nose = [s.x + c * (SHIP_R + 6.0), s.y + sn * (SHIP_R + 6.0)];
        let l = [s.x + (c * -SHIP_R - sn * SHIP_R), s.y + (sn * -SHIP_R + c * SHIP_R)];
        let r = [s.x + (c * -SHIP_R + sn * SHIP_R), s.y + (sn * -SHIP_R - c * SHIP_R)];
        self.tri(nose, l, r, col);
        // A ring tint to mark self / friendly fleet / enemy.
        let ring = match s.tag {
            1 => [0.45, 0.95, 1.0, 0.9],  // me — cyan
            2 => [0.4, 0.9, 0.6, 0.7],    // my NPC fleet — green
            3 => [1.0, 0.55, 0.45, 0.6],  // enemy NPC — red
            _ => [1.0, 0.85, 0.4, 0.5],   // enemy player — gold
        };
        self.line([l[0], l[1]], [r[0], r[1]], 2.0, ring);
        // Hull bar under the ship.
        if s.alive {
            let bw = SHIP_R * 1.6;
            self.quad(s.x, s.y - SHIP_R - 8.0, bw * 0.5, 1.6, [0.2, 0.05, 0.08, 0.8]);
            self.quad(
                s.x - bw * 0.5 * (1.0 - s.hp_frac),
                s.y - SHIP_R - 8.0,
                bw * 0.5 * s.hp_frac,
                1.6,
                [0.3, 0.9, 0.6, 0.95],
            );
        }
    }

    fn build_fx(&mut self, fx: &Fx) {
        for b in &fx.bullets {
            let col = hue_rgb(b[2], 1.0);
            let r = if b[3] > 0.5 { 4.0 } else { 2.6 };
            self.disc(b[0], b[1], r, col);
        }
        for bm in &fx.beams {
            let mut col = hue_rgb(bm[4], 1.0);
            col[3] = 0.85;
            let width = if bm[5] < 0.5 { 2.4 } else { 1.4 }; // railgun thicker than laser
            self.line([bm[0], bm[1]], [bm[2], bm[3]], width, col);
        }
        for e in &fx.explosions {
            let mut col = hue_rgb(e[3], 1.0);
            col[3] = 0.5;
            self.disc(e[0], e[1], e[2], col);
        }
        for d in &fx.debris {
            self.quad(d[0], d[1], d[2], d[2], [0.6, 0.62, 0.7, 0.8]);
        }
    }

    /// Draw the deterministic asteroid field for the cells around the camera (same field the backend
    /// uses — `spacegame::sim::rock_in_cell`), per sector in view.
    fn build_asteroids(&mut self, game: &Game) {
        let half = game.profile.view_radius + ROCK_CELL;
        let min_cx = ((game.cam_x - half) / ROCK_CELL).floor() as i32;
        let max_cx = ((game.cam_x + half) / ROCK_CELL).floor() as i32;
        let min_cy = ((game.cam_y - half) / ROCK_CELL).floor() as i32;
        let max_cy = ((game.cam_y + half) / ROCK_CELL).floor() as i32;
        for wcx in min_cx..=max_cx {
            for wcy in min_cy..=max_cy {
                // World cell -> sector + sector-local cell (the field repeats per sector).
                let scx = wcx.rem_euclid((SECTOR_SIZE / ROCK_CELL) as i32);
                let scy = wcy.rem_euclid((SECTOR_SIZE / ROCK_CELL) as i32);
                if let Some(r) = rock_in_cell(scx, scy) {
                    let wx = wcx as f32 * ROCK_CELL + (r.x - scx as f32 * ROCK_CELL);
                    let wy = wcy as f32 * ROCK_CELL + (r.y - scy as f32 * ROCK_CELL);
                    let shade = 0.18 + (r.val as f32 / 30.0) * 0.18;
                    self.disc(wx, wy, 16.0 + r.val as f32 * 0.4, [shade, shade * 1.05, shade * 1.2, 1.0]);
                }
            }
        }
    }
}

/// HSL(hue,70%,58%) -> linear-ish RGBA, matching the frontend's neon palette.
fn hue_rgb(hue: f32, a: f32) -> [f32; 4] {
    let h = (hue / 360.0).fract();
    let (s, l) = (0.72f32, 0.58f32);
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h * 6.0).rem_euclid(2.0) - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match (h * 6.0) as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    [r + m, g + m, b + m, a]
}
