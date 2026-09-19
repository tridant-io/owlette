//! Downscale a captured frame on the GPU, and the policy that decides whether
//! a downscale is needed at all.
//!
//! # No colour conversion ships here
//!
//! The obvious sibling of this module is a BGRA→NV12 convert. It does not
//! exist, deliberately. Spike 0.9 fed Desktop Duplication's `B8G8R8A8_UNORM`
//! texture straight into NVENC and it converted on chip, so the only encoder
//! this crate has takes the captured surface as it is (`BackendCaps
//! ::accepts_bgra_texture` is `true` for nvenc) and a convert pass would be a
//! shader nothing calls, with no consumer to validate its matrix against. The
//! Intel/AMD/software backends that actually need NV12 land in Wave 7 (Tasks
//! 7.1/7.2); the conversion belongs in that task, as three more calls on the
//! video processor below — an NV12 output texture and a `BT.709` output colour
//! space — not as a second mechanism.
//!
//! What this module does commit to is the colour space it hands the encoder:
//! **BT.709 primaries, full range, gamma 2.2 RGB**
//! (`DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709`), in and out, which is what the
//! Windows desktop composites in and what a browser assumes for an untagged
//! stream. A Wave 7 NV12 conversion must emit BT.709 **limited** range (16-235
//! luma) and say so in the bitstream's VUI, because that is what every decoder
//! defaults to for H.264/HEVC.
//!
//! # Rotation is not this module's business
//!
//! Everything here is in *texture* space. A rotated output hands back a texture
//! transposed against its `ModeDesc` — the spike 0.8 box's rotate270 panel
//! reports a 2160x3840 mode and produces a 3840x2160 texture — so sizes come
//! from `Frame::width`/`Frame::height`, which capture takes from the texture
//! description, never from a mode. The video processor's own rotation is left
//! off: applying rotation is Task 6.4's job, and turning it on here would
//! silently transpose the very case that is already easy to get wrong.
//!
//! # Hardware test
//!
//! ```text
//! cargo test -- --ignored scale        # working directory agent/swoop
//! ```
//!
//! Expected: one test runs and passes, printing the source and target sizes it
//! blitted (`gpu scale: 256x128 -> 128x64`). It downscales a two-tone BGRA
//! pattern by half and asserts the two halves survive at the right side of the
//! output, so a transposed or mirrored blit fails it.

/// The largest frame a backend will encode, on each axis.
///
/// Both axes matter independently: NVENC allows 4096x4096 for H.264 and
/// 8192x8192 for HEVC, and AMF is capped at 4096 on *both* axes, so a canvas
/// that is legal in width can still be refused on height.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_width: u32,
    pub max_height: u32,
}

impl Limits {
    /// The common case: the same cap on both axes.
    pub const fn square(max: u32) -> Self {
        Self {
            max_width: max,
            max_height: max,
        }
    }
}

/// What has to happen to a captured surface before it reaches the encoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Already legal — encode the captured texture, no blit, no copy.
    AsIs,
    /// Downscale to this size first.
    Downscale { width: u32, height: u32 },
    /// No legal size preserves the aspect ratio. Only a degenerate canvas
    /// reaches this — one axis thousands of times the other — because a plain
    /// downscale fits everything else.
    Refuse,
}

impl Plan {
    /// The linear factor the encoded size represents, which Task 4.3 reports in
    /// stats. Both axes carry the same factor to within the even-pixel
    /// rounding, so the width is the one reported.
    pub fn factor(self, source_width: u32) -> Option<f32> {
        match self {
            Plan::AsIs => Some(1.0),
            Plan::Downscale { width, .. } if source_width > 0 => {
                Some(width as f32 / source_width as f32)
            }
            _ => None,
        }
    }
}

/// Decide what to do with a `source`-sized capture for a backend with `limits`.
///
/// Aspect ratio is preserved by applying one factor to both axes, and both
/// results are rounded **down** to even: 4:2:0 chroma is subsampled by two in
/// each direction, so an odd axis has no representation and every backend
/// either refuses it or pads it with a row the viewer never asked for. Rounding
/// here makes that choice ours and costs at most one pixel.
///
/// Tiling — splitting an over-cap canvas across several encode sessions instead
/// of shrinking it — is deliberately not built. It needs the multi-session
/// budget from Task 8.2 and a client that can composite tiles, and downscaling
/// keeps a Mosaic canvas streaming in one session today.
pub fn plan(source: (u32, u32), limits: Limits) -> Plan {
    let (width, height) = source;
    if width == 0 || height == 0 || limits.max_width < 2 || limits.max_height < 2 {
        return Plan::Refuse;
    }

    // u64 throughout: an 8K-wide Mosaic canvas times a 4096 cap overflows u32.
    let (w, h) = (u64::from(width), u64::from(height));
    let (mw, mh) = (u64::from(limits.max_width), u64::from(limits.max_height));

    // Fit the wider-relative axis first, then fall back to the other one.
    let mut fit_w = w.min(mw);
    let mut fit_h = h * fit_w / w;
    if fit_h > mh {
        fit_h = mh;
        fit_w = w * fit_h / h;
    }

    let target = (even_floor(fit_w), even_floor(fit_h));
    if target.0 == 0 || target.1 == 0 {
        return Plan::Refuse;
    }
    if target == (width, height) {
        return Plan::AsIs;
    }
    Plan::Downscale {
        width: target.0,
        height: target.1,
    }
}

/// Largest even number no greater than `value`, clamped into u32.
fn even_floor(value: u64) -> u32 {
    (value & !1).min(u64::from(u32::MAX) - 1) as u32
}

// ------------------------------------------------------------- execution ---

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::mem::ManuallyDrop;

    use thiserror::Error;
    use windows::core::Interface;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Direct3D11::{
        ID3D11Device, ID3D11Texture2D, ID3D11VideoContext1, ID3D11VideoDevice,
        ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorInputView,
        ID3D11VideoProcessorOutputView, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
        D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
        D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
        D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_RATIONAL,
        DXGI_SAMPLE_DESC,
    };

    use crate::gpu::Frame;
    use crate::ipc::Exit;

    /// Advisory only — nothing here converts frame rate, and the stream's
    /// output rate is left at `NORMAL` (one output per input).
    const RATE: DXGI_RATIONAL = DXGI_RATIONAL {
        Numerator: 60,
        Denominator: 1,
    };

    /// Everything that stops a frame being downscaled.
    #[derive(Debug, Error)]
    pub enum ScaleError {
        #[error("frame carries no texture handle")]
        NoTexture,
        #[error("the frame's texture belongs to another d3d11 device — the capture source was rebuilt")]
        DeviceChanged,
        #[error("frame is {got:?}, the scaler was opened for {want:?}")]
        SourceSizeChanged { got: (u32, u32), want: (u32, u32) },
        #[error("{call} failed: {0}", .source)]
        D3d {
            call: &'static str,
            #[source]
            source: windows::core::Error,
        },
    }

    impl ScaleError {
        /// A scaler that cannot run leaves the session with no encodable frame,
        /// which is the encoder's exit code whichever call reported it.
        pub const fn exit(&self) -> Exit {
            Exit::NoEncoder
        }
    }

    fn d3d(call: &'static str) -> impl FnOnce(windows::core::Error) -> ScaleError {
        move |source| ScaleError::D3d { call, source }
    }

    /// Borrow a frame's texture. `raw` is a binding in the caller so the
    /// returned reference outlives it.
    fn texture_of(raw: &*mut c_void) -> Result<&ID3D11Texture2D, ScaleError> {
        // SAFETY: borrowed, not owned — the capture source holds the reference
        // and `Frame` does not transfer it.
        unsafe { ID3D11Texture2D::from_raw_borrowed(raw) }.ok_or(ScaleError::NoTexture)
    }

    /// A GPU downscaler for one source size, one target size and one D3D11
    /// device, built on `VideoProcessorBlt`.
    ///
    /// Pinned to the device that owns the first frame's texture, exactly like
    /// the NVENC session: a capture rebuild after `DXGI_ERROR_ACCESS_LOST`
    /// yields a new device, and a new device is a new `Downscaler`, not a
    /// reconfigure. Cross-device use would fail `E_INVALIDARG`, which is not
    /// retryable, so it is refused here with a name instead.
    ///
    /// The video processor is used rather than a compute shader because it is
    /// the driver's own scaler — better than a bilinear tap at the 2x-and-worse
    /// factors a Mosaic canvas needs — and because it carries the NV12 path
    /// Wave 7 will need without a second mechanism.
    pub struct Downscaler {
        device: ID3D11Device,
        video_device: ID3D11VideoDevice,
        video: ID3D11VideoContext1,
        enumerator: ID3D11VideoProcessorEnumerator,
        processor: ID3D11VideoProcessor,
        output: ID3D11Texture2D,
        output_view: ID3D11VideoProcessorOutputView,
        /// One slot, keyed by texture pointer: Desktop Duplication copies every
        /// frame into a single surface it reuses, so a one-entry cache hits
        /// every time in the real pipeline and a miss costs a view creation
        /// rather than a failure.
        input_view: Option<(usize, ID3D11VideoProcessorInputView)>,
        source: (u32, u32),
        target: (u32, u32),
    }

    // SAFETY: the device, the processor and the views are used from exactly one
    // thread at a time — the streamer owns the scaler on the capture thread and
    // keeps it there. Nothing inside is shared, which is why this is Send and
    // not Sync.
    unsafe impl Send for Downscaler {}

    impl Downscaler {
        /// Open a downscaler for `frame`'s size and device, producing
        /// `width`x`height` BGRA frames.
        pub fn open(frame: &Frame, width: u32, height: u32) -> Result<Self, ScaleError> {
            let raw = frame.handle as *mut c_void;
            let texture = texture_of(&raw)?;
            let device = unsafe { texture.GetDevice() }.map_err(d3d("GetDevice"))?;
            let video_device: ID3D11VideoDevice =
                device.cast().map_err(d3d("QueryInterface(ID3D11VideoDevice)"))?;
            let context = unsafe { device.GetImmediateContext() }
                .map_err(d3d("GetImmediateContext"))?;
            let video: ID3D11VideoContext1 = context
                .cast()
                .map_err(d3d("QueryInterface(ID3D11VideoContext1)"))?;

            let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: RATE,
                InputWidth: frame.width,
                InputHeight: frame.height,
                OutputFrameRate: RATE,
                OutputWidth: width,
                OutputHeight: height,
                // Latency over picture quality: this is a live stream, and the
                // quality path enables per-frame work we cannot afford.
                Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
            };
            let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&content) }
                .map_err(d3d("CreateVideoProcessorEnumerator"))?;
            // Rate-conversion index 0 is the driver's plain scaler; every other
            // index is a frame-rate converter, which this pipeline never wants.
            let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }
                .map_err(d3d("CreateVideoProcessor"))?;

            let output = create_output(&device, width, height)?;
            let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut output_view = None;
            unsafe {
                video_device.CreateVideoProcessorOutputView(
                    &output,
                    &enumerator,
                    &view_desc,
                    Some(&mut output_view),
                )
            }
            .map_err(d3d("CreateVideoProcessorOutputView"))?;
            let output_view = output_view.ok_or(ScaleError::D3d {
                call: "CreateVideoProcessorOutputView",
                source: windows::core::Error::from(windows::Win32::Foundation::E_FAIL),
            })?;

            let src = rect(frame.width, frame.height);
            let dst = rect(width, height);
            // Processor state, not per-blt state: set once here so the hot path
            // is a single Blt call.
            unsafe {
                video.VideoProcessorSetStreamFrameFormat(
                    &processor,
                    0,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                );
                // Drivers enable denoise and edge enhancement by default. Both
                // cost latency and both fight the encoder, which is looking at
                // the same edges.
                video.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
                video.VideoProcessorSetStreamColorSpace1(
                    &processor,
                    0,
                    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                );
                video.VideoProcessorSetOutputColorSpace1(
                    &processor,
                    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                );
                video.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&src));
                video.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&dst));
                video.VideoProcessorSetOutputTargetRect(&processor, true, Some(&dst));
            }

            Ok(Self {
                device,
                video_device,
                video,
                enumerator,
                processor,
                output,
                output_view,
                input_view: None,
                source: (frame.width, frame.height),
                target: (width, height),
            })
        }

        /// The size this scaler emits.
        pub fn target(&self) -> (u32, u32) {
            self.target
        }

        /// Downscale one frame.
        ///
        /// The returned `Frame` borrows this scaler's output texture: its
        /// handle is valid until the next `scale` call, exactly like the frame
        /// a capture source hands out.
        pub fn scale(&mut self, frame: &Frame) -> Result<Frame, ScaleError> {
            if (frame.width, frame.height) != self.source {
                return Err(ScaleError::SourceSizeChanged {
                    got: (frame.width, frame.height),
                    want: self.source,
                });
            }
            let raw = frame.handle as *mut c_void;
            let texture = texture_of(&raw)?;
            let device = unsafe { texture.GetDevice() }.map_err(d3d("GetDevice"))?;
            if device.as_raw() != self.device.as_raw() {
                return Err(ScaleError::DeviceChanged);
            }

            let view = self.input_view(texture, frame.handle)?;
            let mut streams = [D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(Some(view)),
                ..Default::default()
            }];
            let blt = unsafe {
                self.video
                    .VideoProcessorBlt(&self.processor, &self.output_view, 0, &streams)
            };
            // The stream struct took a strong reference and will not release it
            // — hand it back whatever the blt returned.
            // SAFETY: the field was just filled with an owned interface and is
            // not touched again.
            unsafe { ManuallyDrop::drop(&mut streams[0].pInputSurface) };
            blt.map_err(d3d("VideoProcessorBlt"))?;

            Ok(Frame {
                handle: self.output.as_raw() as usize,
                width: self.target.0,
                height: self.target.1,
                captured_qpc: frame.captured_qpc,
            })
        }

        fn input_view(
            &mut self,
            texture: &ID3D11Texture2D,
            key: usize,
        ) -> Result<ID3D11VideoProcessorInputView, ScaleError> {
            if let Some((cached, view)) = &self.input_view {
                if *cached == key {
                    return Ok(view.clone());
                }
            }
            let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                // Zero: the format comes from the texture, not from a FourCC.
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPIV {
                        MipSlice: 0,
                        ArraySlice: 0,
                    },
                },
            };
            let mut view = None;
            unsafe {
                self.video_device.CreateVideoProcessorInputView(
                    texture,
                    &self.enumerator,
                    &desc,
                    Some(&mut view),
                )
            }
            .map_err(d3d("CreateVideoProcessorInputView"))?;
            let view = view.ok_or(ScaleError::D3d {
                call: "CreateVideoProcessorInputView",
                source: windows::core::Error::from(windows::Win32::Foundation::E_FAIL),
            })?;
            self.input_view = Some((key, view.clone()));
            Ok(view)
        }
    }

    fn rect(width: u32, height: u32) -> RECT {
        RECT {
            left: 0,
            top: 0,
            right: width as i32,
            bottom: height as i32,
        }
    }

    /// The output surface, with the bind flags Desktop Duplication's own
    /// surface carries, so the encoder takes this texture on exactly the terms
    /// it takes an un-scaled one.
    fn create_output(
        device: &ID3D11Device,
        width: u32,
        height: u32,
    ) -> Result<ID3D11Texture2D, ScaleError> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }
            .map_err(d3d("CreateTexture2D"))?;
        texture.ok_or(ScaleError::D3d {
            call: "CreateTexture2D",
            source: windows::core::Error::from(windows::Win32::Foundation::E_FAIL),
        })
    }
}

#[cfg(windows)]
pub use imp::{Downscaler, ScaleError};

#[cfg(test)]
mod tests {
    use super::*;

    /// NVENC H.264 and AMF both cap here; HEVC on NVENC caps at 8192.
    const H264: Limits = Limits::square(4096);
    const HEVC: Limits = Limits::square(8192);

    #[test]
    fn a_frame_inside_the_cap_is_encoded_as_captured() {
        assert_eq!(plan((1920, 1080), H264), Plan::AsIs);
        assert_eq!(plan((3840, 2160), H264), Plan::AsIs);
        assert_eq!(plan((4096, 4096), H264), Plan::AsIs);
        assert_eq!(plan((7680, 2160), HEVC), Plan::AsIs);
    }

    #[test]
    fn an_eight_k_wide_mosaic_canvas_is_downscaled_under_a_four_k_cap() {
        // Two 4K panels side by side: over the H.264 axis cap, legal on HEVC.
        assert_eq!(
            plan((7680, 2160), H264),
            Plan::Downscale {
                width: 4096,
                height: 1152
            }
        );
        // 15360x2160 is the Mosaic case: the height ends up tiny, and that is
        // the honest result of preserving aspect under a hard width cap.
        assert_eq!(
            plan((15360, 2160), H264),
            Plan::Downscale {
                width: 4096,
                height: 576
            }
        );
    }

    #[test]
    fn the_binding_axis_is_the_one_that_is_over() {
        // Tall: height binds, width follows.
        assert_eq!(
            plan((2160, 8640), H264),
            Plan::Downscale {
                width: 1024,
                height: 4096
            }
        );
        // An 8K square under the HEVC cap needs nothing; under H.264 it halves.
        assert_eq!(plan((8192, 8192), HEVC), Plan::AsIs);
        assert_eq!(
            plan((8192, 8192), H264),
            Plan::Downscale {
                width: 4096,
                height: 4096
            }
        );
    }

    #[test]
    fn a_backend_capped_at_four_k_on_both_axes_refuses_nothing_a_downscale_can_fix() {
        // AMF: 4096 on both axes. A 5120x2880 canvas fits by shrinking.
        let amf = Limits::square(4096);
        assert_eq!(
            plan((5120, 2880), amf),
            Plan::Downscale {
                width: 4096,
                height: 2304
            }
        );
        // Asymmetric caps bind independently.
        let lopsided = Limits {
            max_width: 4096,
            max_height: 1080,
        };
        assert_eq!(
            plan((3840, 2160), lopsided),
            Plan::Downscale {
                width: 1920,
                height: 1080
            }
        );
    }

    #[test]
    fn the_aspect_ratio_survives_the_downscale() {
        for source in [(7680u32, 2160u32), (5120, 2880), (3440, 1440), (8192, 8192)] {
            let Plan::Downscale { width, height } = plan(source, H264) else {
                continue;
            };
            let before = f64::from(source.0) / f64::from(source.1);
            let after = f64::from(width) / f64::from(height);
            // One pixel of even-rounding on the short axis is the whole budget.
            assert!(
                (before - after).abs() < 0.01,
                "{source:?} -> {width}x{height}: {before} vs {after}"
            );
        }
    }

    #[test]
    fn an_odd_axis_is_rounded_down_even_when_it_is_already_legal() {
        // 4:2:0 has no representation for an odd axis, so this is a downscale
        // of one pixel rather than a frame the encoder pads behind our back.
        assert_eq!(
            plan((1921, 1081), H264),
            Plan::Downscale {
                width: 1920,
                height: 1080
            }
        );
    }

    #[test]
    fn a_degenerate_canvas_is_refused_rather_than_scaled_to_nothing() {
        assert_eq!(plan((0, 1080), H264), Plan::Refuse);
        assert_eq!(plan((1920, 0), H264), Plan::Refuse);
        // One axis 100000x the other: the short side rounds away entirely.
        assert_eq!(plan((400_000, 1), H264), Plan::Refuse);
    }

    #[test]
    fn the_scale_factor_is_reported_for_the_stats_overlay() {
        assert_eq!(plan((1920, 1080), H264).factor(1920), Some(1.0));
        assert_eq!(plan((7680, 2160), H264).factor(7680), Some(4096.0 / 7680.0));
        assert_eq!(Plan::Refuse.factor(1920), None);
    }
}

#[cfg(all(test, windows))]
mod gpu_tests {
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
        D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA,
        D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

    use super::Downscaler;
    use crate::gpu::Frame;

    const SRC: (u32, u32) = (256, 128);
    const DST: (u32, u32) = (128, 64);

    fn device() -> ID3D11Device {
        let mut device = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        }
        .expect("a d3d11 hardware device");
        device.expect("D3D11CreateDevice returned a device")
    }

    /// Left half opaque blue, right half opaque red, in BGRA byte order.
    fn two_tone(device: &ID3D11Device) -> ID3D11Texture2D {
        // u8, spelled out: an unannotated `[255, 0, 0, 255]` is a `[i32; 4]`,
        // which uploads a buffer four times too wide and reads back as noise.
        let mut pixels: Vec<u8> = Vec::with_capacity((SRC.0 * SRC.1 * 4) as usize);
        for _ in 0..SRC.1 {
            for x in 0..SRC.0 {
                if x < SRC.0 / 2 {
                    pixels.extend_from_slice(&[255, 0, 0, 255]);
                } else {
                    pixels.extend_from_slice(&[0, 0, 255, 255]);
                }
            }
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: SRC.0,
            Height: SRC.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: SRC.0 * 4,
            SysMemSlicePitch: 0,
        };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }
            .expect("the source texture");
        texture.expect("CreateTexture2D returned a texture")
    }

    /// Copy `texture` to a staging surface and read it back as BGRA rows.
    fn readback(device: &ID3D11Device, texture: &ID3D11Texture2D) -> Vec<u8> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        let staging = D3D11_TEXTURE2D_DESC {
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
            ..desc
        };
        let mut copy = None;
        unsafe { device.CreateTexture2D(&staging, None, Some(&mut copy)) }
            .expect("the staging texture");
        let copy = copy.expect("CreateTexture2D returned a staging texture");
        let context = unsafe { device.GetImmediateContext() }.expect("the immediate context");
        unsafe { context.CopyResource(&copy, texture) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { context.Map(&copy, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
            .expect("the staging map");
        let mut rows = Vec::with_capacity((desc.Width * desc.Height * 4) as usize);
        for y in 0..desc.Height {
            // SAFETY: the mapped surface is at least RowPitch * Height bytes.
            let row = unsafe {
                std::slice::from_raw_parts(
                    mapped.pData.cast::<u8>().add((y * mapped.RowPitch) as usize),
                    (desc.Width * 4) as usize,
                )
            };
            rows.extend_from_slice(row);
        }
        unsafe { context.Unmap(&copy, 0) };
        rows
    }

    #[test]
    #[ignore = "needs a gpu"]
    fn downscale_halves_a_two_tone_pattern_without_transposing_it() {
        let device = device();
        let source = two_tone(&device);
        let frame = Frame {
            handle: source.as_raw() as usize,
            width: SRC.0,
            height: SRC.1,
            captured_qpc: 1234,
        };

        let mut scaler = Downscaler::open(&frame, DST.0, DST.1).expect("a downscaler");
        let scaled = scaler.scale(&frame).expect("a scaled frame");
        assert_eq!((scaled.width, scaled.height), DST);
        assert_eq!(scaled.captured_qpc, frame.captured_qpc, "the timestamp rides along");
        println!(
            "gpu scale: {}x{} -> {}x{}",
            SRC.0, SRC.1, scaled.width, scaled.height
        );

        let raw = scaled.handle as *mut std::ffi::c_void;
        // SAFETY: borrowed from the scaler, which is still alive.
        let texture = unsafe { ID3D11Texture2D::from_raw_borrowed(&raw) }.expect("the output");
        let pixels = readback(&device, texture);

        // Well inside each half, so the filter's edge tap is not under test.
        let at = |x: u32, y: u32| {
            let i = ((y * DST.0 + x) * 4) as usize;
            (pixels[i], pixels[i + 1], pixels[i + 2])
        };
        assert_eq!(at(16, 32), (255, 0, 0), "left half stays blue");
        assert_eq!(at(112, 32), (0, 0, 255), "right half stays red");
    }
}
