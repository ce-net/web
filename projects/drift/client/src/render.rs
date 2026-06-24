//! The wgpu renderer: WebGPU-first with an automatic WebGL2 fallback.
//!
//! `wgpu` is built with the `webgl` feature, so under wasm it requests a WebGPU
//! adapter when `navigator.gpu` exists and transparently falls back to a WebGL2
//! adapter otherwise. The same code path drives both: we never branch on the
//! backend except to pick conservative limits via
//! `Limits::downlevel_webgl2_defaults`.
//!
//! Two pipelines share one camera bind group:
//! - an instanced-quad pipeline (ships' blocks, asteroids, projectiles, pickups);
//! - a line pipeline (arena grid, aim reticle).
//!
//! Text/HUD is rendered by the JS/DOM layer (drift.js) overlaid on the canvas —
//! cheaper and crisper than baking a glyph atlas into wgpu for the MVP — so this
//! module exposes the numbers the HUD needs via [`Renderer::backend_label`] and
//! the caller's own state.

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::scene::{LineVertex, QuadInstance};

/// Camera uniform: a single column-major mat4 mapping world -> clip.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct CameraUniform {
    view_proj: [[f32; 4]; 4],
}

/// The unit quad ([-0.5, 0.5]^2) as a triangle strip of 4 corners.
const QUAD_CORNERS: [[f32; 2]; 4] =
    [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];

/// Instance vertex attributes with explicit offsets matching `QuadInstance`'s
/// `repr(C)` layout (which carries an explicit `_pad` float). Shader locations:
/// 1=center, 2=half_size, 3=rot, 4=color.
const QUAD_INSTANCE_ATTRS: [wgpu::VertexAttribute; 4] = [
    wgpu::VertexAttribute { offset: 0, shader_location: 1, format: wgpu::VertexFormat::Float32x2 },
    wgpu::VertexAttribute { offset: 8, shader_location: 2, format: wgpu::VertexFormat::Float32x2 },
    wgpu::VertexAttribute { offset: 16, shader_location: 3, format: wgpu::VertexFormat::Float32 },
    wgpu::VertexAttribute { offset: 24, shader_location: 4, format: wgpu::VertexFormat::Float32x4 },
];

/// Everything needed to draw a frame. Generic over the surface lifetime so it
/// works with a borrowed canvas surface on wasm.
pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,

    camera_buf: wgpu::Buffer,
    camera_bind: wgpu::BindGroup,

    quad_pipeline: wgpu::RenderPipeline,
    line_pipeline: wgpu::RenderPipeline,

    quad_corner_buf: wgpu::Buffer,
    instance_buf: wgpu::Buffer,
    instance_cap: u64,
    line_buf: wgpu::Buffer,
    line_cap: u64,

    backend: wgpu::Backend,
}

impl Renderer {
    /// Build the renderer over a surface created by the platform layer.
    ///
    /// `surface` must outlive the renderer (`'static`) — on wasm this is the
    /// canvas surface created from the window; on native it comes from winit.
    pub async fn new(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Renderer, String> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
            })
            .await
            .ok_or_else(|| "no compatible GPU/WebGL2 adapter found".to_string())?;

        let backend = adapter.get_info().backend;

        // WebGL2 needs downlevel limits; WebGPU happily accepts them too, so we
        // request the conservative set for maximum portability.
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("drift-device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                        .using_resolution(adapter.limits()),
                },
                None,
            )
            .await
            .map_err(|e| format!("request_device failed: {e}"))?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(caps.formats[0]);

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::AutoVsync,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        // Camera uniform + bind group (shared by both pipelines).
        let camera_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("camera"),
            contents: bytemuck::bytes_of(&CameraUniform {
                view_proj: identity4(),
            }),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let camera_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("camera-layout"),
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
        let camera_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("camera-bind"),
            layout: &camera_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: camera_buf.as_entire_binding(),
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("drift-pl"),
            bind_group_layouts: &[&camera_layout],
            push_constant_ranges: &[],
        });

        // Shaders.
        let quad_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("quad.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/quad.wgsl").into()),
        });
        let line_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("line.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/line.wgsl").into()),
        });

        let blend = Some(wgpu::BlendState::ALPHA_BLENDING);
        let color_target = wgpu::ColorTargetState {
            format,
            blend,
            write_mask: wgpu::ColorWrites::ALL,
        };

        // Quad pipeline: vertex buffer 0 = unit corner; buffer 1 = instances.
        let quad_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("quad-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &quad_shader,
                entry_point: "vs_main",
                compilation_options: Default::default(),
                buffers: &[
                    wgpu::VertexBufferLayout {
                        array_stride: 8,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![0 => Float32x2],
                    },
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<QuadInstance>() as u64,
                        step_mode: wgpu::VertexStepMode::Instance,
                        // Explicit offsets (NOT vertex_attr_array!) because the
                        // QuadInstance repr(C) layout has an explicit `_pad`
                        // float between `rot` and `color`. Auto-offsets would
                        // skip the pad and misalign `color`.
                        // center@0, half_size@8, rot@16, (_pad@20), color@24.
                        attributes: &QUAD_INSTANCE_ATTRS,
                    },
                ],
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &quad_shader,
                entry_point: "fs_main",
                compilation_options: Default::default(),
                targets: &[Some(color_target.clone())],
            }),
            multiview: None,
        });

        // Line pipeline: a single vertex buffer of (pos, color).
        let line_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("line-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &line_shader,
                entry_point: "vs_main",
                compilation_options: Default::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<LineVertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4],
                }],
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::LineList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &line_shader,
                entry_point: "fs_main",
                compilation_options: Default::default(),
                targets: &[Some(color_target)],
            }),
            multiview: None,
        });

        let quad_corner_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("quad-corners"),
            contents: bytemuck::cast_slice(&QUAD_CORNERS),
            usage: wgpu::BufferUsages::VERTEX,
        });

        // Start with modest dynamic buffers; grow on demand.
        let instance_cap = 4096u64;
        let instance_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("instances"),
            size: instance_cap * std::mem::size_of::<QuadInstance>() as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let line_cap = 8192u64;
        let line_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("lines"),
            size: line_cap * std::mem::size_of::<LineVertex>() as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Ok(Renderer {
            surface,
            device,
            queue,
            config,
            camera_buf,
            camera_bind,
            quad_pipeline,
            line_pipeline,
            quad_corner_buf,
            instance_buf,
            instance_cap,
            line_buf,
            line_cap,
            backend,
        })
    }

    /// Human-readable backend for the HUD ("WebGPU" / "WebGL2" / native).
    pub fn backend_label(&self) -> &'static str {
        match self.backend {
            wgpu::Backend::BrowserWebGpu => "WebGPU",
            wgpu::Backend::Gl => "WebGL2",
            wgpu::Backend::Vulkan => "Vulkan",
            wgpu::Backend::Metal => "Metal",
            wgpu::Backend::Dx12 => "DX12",
            _ => "GPU",
        }
    }

    /// Reconfigure the surface on canvas resize.
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }

    pub fn width(&self) -> u32 {
        self.config.width
    }
    pub fn height(&self) -> u32 {
        self.config.height
    }

    /// Upload the camera matrix for this frame.
    pub fn set_camera(&self, view_proj: [[f32; 4]; 4]) {
        self.queue.write_buffer(
            &self.camera_buf,
            0,
            bytemuck::bytes_of(&CameraUniform { view_proj }),
        );
    }

    fn ensure_instance_cap(&mut self, count: usize) {
        if count as u64 <= self.instance_cap {
            return;
        }
        let new_cap = (count as u64).next_power_of_two();
        self.instance_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("instances"),
            size: new_cap * std::mem::size_of::<QuadInstance>() as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.instance_cap = new_cap;
    }

    fn ensure_line_cap(&mut self, count: usize) {
        if count as u64 <= self.line_cap {
            return;
        }
        let new_cap = (count as u64).next_power_of_two();
        self.line_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("lines"),
            size: new_cap * std::mem::size_of::<LineVertex>() as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.line_cap = new_cap;
    }

    /// Draw one frame: clear, lines under, quads over.
    pub fn render(&mut self, instances: &[QuadInstance], lines: &[LineVertex]) -> Result<(), String> {
        self.ensure_instance_cap(instances.len());
        self.ensure_line_cap(lines.len());

        if !instances.is_empty() {
            self.queue
                .write_buffer(&self.instance_buf, 0, bytemuck::cast_slice(instances));
        }
        if !lines.is_empty() {
            self.queue
                .write_buffer(&self.line_buf, 0, bytemuck::cast_slice(lines));
        }

        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                self.surface.configure(&self.device, &self.config);
                self.surface
                    .get_current_texture()
                    .map_err(|e| format!("surface re-acquire failed: {e}"))?
            }
            Err(e) => return Err(format!("get_current_texture: {e}")),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("main-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // CE deep-navy field (--bg #070d18).
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.027,
                            g: 0.051,
                            b: 0.094,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            pass.set_bind_group(0, &self.camera_bind, &[]);

            // Lines first (grid/aim under the entities).
            if !lines.is_empty() {
                pass.set_pipeline(&self.line_pipeline);
                pass.set_vertex_buffer(0, self.line_buf.slice(..));
                pass.draw(0..lines.len() as u32, 0..1);
            }

            // Instanced quads.
            if !instances.is_empty() {
                pass.set_pipeline(&self.quad_pipeline);
                pass.set_vertex_buffer(0, self.quad_corner_buf.slice(..));
                pass.set_vertex_buffer(1, self.instance_buf.slice(..));
                pass.draw(0..4, 0..instances.len() as u32);
            }
        }

        self.queue.submit(Some(encoder.finish()));
        frame.present();
        Ok(())
    }
}

fn identity4() -> [[f32; 4]; 4] {
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}
