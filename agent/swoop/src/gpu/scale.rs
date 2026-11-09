//! Downscale and convert a captured frame on the GPU, and the policy that
//! decides whether a downscale is needed at all.
//!
//! # Colour
//!
//! The same video processor converts. [`Downscaler::open`] emits BGRA for an
//! encoder that takes the captured surface as it is (NVENC converts on chip),
//! and [`Downscaler::open_nv12`] emits NV12 for the Media Foundation encoders,
//! which want it — one mechanism, not a second shader. A device with no video
//! processor (WARP, on a virtual machine or a box with no GPU) gets a CPU
//! path instead: [`scale_bgra_cpu`] behind [`Downscaler::open`], and
//! [`bgra_to_nv12_cpu`] for the software encoder, which converts for itself.
//!
//! The colour spaces are committed to here. The input is **BT.709 primaries,
//! full range, gamma 2.2 RGB** (`DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709`),
//! which is what the Windows desktop composites in. A BGRA output keeps it; an
//! NV12 output is **BT.709 limited range** (16-235 luma,
//! `DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709`), which is what every decoder
//! defaults to for H.264/HEVC and what the encoder's media type declares.
//!
//! # Rotation
//!
//! A rotated output hands back its texture un-rotated: the spike 0.8 box's
//! rotate270 panel reports a 2160x3840 mode and produces a 3840x2160 texture.
//! Capture turns it upright with [`Downscaler::rotate`], the video
//! processor's stream rotation at the same pixels (`OPTIMAL_SPEED`, since it
//! is not a downscale), or [`rotate_bgra_cpu`] on a device whose video
//! processor cannot rotate or that has none. Both turn it clockwise by the
//! rotation, which is how the output displays it. Every other caller here is
//! handed the upright frame, so the downscale and the NV12 convert never see
//! a rotation, and sizes still come from `Frame::width`/`Frame::height`,
//! never from a mode.
//!
//! # Filter: which usage each caller takes
//!
//! The video processor's usage picks the driver's filter and what it costs,
//! and the two callers do different jobs. [`Downscaler::open`] is the BGRA
//! downscale a session opens when a tier's size differs from the capture (a
//! menu resolution, an encoder's size limit, mf-sw's 720p cap), where the
//! filter decides whether thin text survives: it takes `DOWNSCALE_USAGE`,
//! which stays `D3D11_VIDEO_USAGE_OPTIMAL_SPEED` unless task 4.1 of the swoop
//! text clarity plan (`dev/active/swoop-clarity`, decision C12) measures
//! `OPTIMAL_QUALITY`'s 3840x2160 -> 1920x1080 p50 within 1.0 ms of
//! `OPTIMAL_SPEED`'s. [`Downscaler::open_nv12`] is the same-size BGRA -> NV12
//! convert mf-hw and mf-sw run on every frame, on the Intel and AMD machines
//! mf-hw exists for: not a downscale, so it always takes `OPTIMAL_SPEED`.
//! Task 4.1 records both usages' numbers here, with the GPU, the driver and
//! the date.
//!
//! The CPU path is an area average: each target pixel is the mean of the
//! source pixels it covers, so a shrink skips none of them. Task 4.1 records
//! its 3840x2160 -> 1280x720 time here too, held to a 10 ms p50 (mf-sw's
//! frame is 33 ms).
//!
//! # Hardware tests
//!
//! ```text
//! cargo test -- --ignored scale --nocapture                 # working directory agent/swoop
//! cargo test --release -- --ignored scale --nocapture --test-threads=1   # the timings
//! ```
//!
//! Expected: every test passes. The two correctness tests downscale a two-tone
//! BGRA pattern by half and assert the two halves survive at the right side
//! of the output, so a transposed or mirrored blit fails them
//! (`gpu scale: 256x128 -> 128x64`), and convert it to NV12 at BT.709
//! limited luma. `the_video_processor_turns_a_rotated_frame_upright` turns a
//! four-colour pattern each way to the CPU rotation's quadrants, then
//! downscales and converts the upright frame.
//! `each_usage_prints_its_blit_time_and_its_filter` asserts nothing: for each
//! usage it prints the p50 of 120 BGRA blits at 3840x2160 -> 1920x1080 and
//! -> 2560x1440, the p50 of 120 same-size NV12 converts at 3840x2160 and
//! 2560x1440, and the mean and spread of 1-px black and white stripes scaled
//! 3:1. `cpu_scale_times_a_four_k_shrink_to_720p` prints the
//! CPU path's p50, in a release build only. Timings are worth reading only
//! from the second command, one test at a time and nothing else on the box.

use crate::capture::Rotation;

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

// ------------------------------------------------------------- cpu path ---
//
// For a device with no video processor: WARP, which is what a virtual machine
// or a box with no GPU renders on, and where the software encoder is the only
// rung. Never used where the GPU path exists.

/// Area-average BGRA scale: each target pixel is the mean of the source
/// pixels it covers, a pixel on the edge of its footprint weighted by how much
/// of it falls inside, so no source pixel is skipped however far the picture
/// shrinks (a two-tap bilinear filter reads two of every n below half size,
/// and thin strokes between its taps drop out). Separable, down the columns
/// and then along the row. The same size is a plain copy. `src` rows are
/// `src_pitch` bytes apart; `dst` is packed at `to`.
pub fn scale_bgra_cpu(src: &[u8], src_pitch: usize, from: (u32, u32), to: (u32, u32), dst: &mut [u8]) {
    let (sw, sh) = (from.0 as usize, from.1 as usize);
    let (tw, th) = (to.0 as usize, to.1 as usize);
    if from == to {
        for (y, row) in dst.chunks_exact_mut(tw * 4).take(th).enumerate() {
            row.copy_from_slice(&src[y * src_pitch..][..tw * 4]);
        }
        return;
    }
    let columns = footprints(sw, tw, COLUMN_WEIGHT_BITS);
    // one target row's source rows, summed down each column at the source's
    // width in u16 lanes: the pass that reads every source byte is the one
    // that vectorises, eight lanes to a register
    let mut sums = vec![0u16; sw * 4];
    for (y, (first, weights)) in footprints(sh, th, ROW_WEIGHT_BITS).iter().enumerate() {
        sums.fill(0);
        for (r, &weight) in weights.iter().enumerate() {
            let weight = weight as u16;
            let row = &src[(first + r) * src_pitch..][..sw * 4];
            for (sum, &value) in sums.iter_mut().zip(row) {
                *sum += u16::from(value) * weight;
            }
        }
        let summed = sums.as_chunks::<4>().0;
        let out = dst[y * tw * 4..][..tw * 4].as_chunks_mut::<4>().0;
        for (pixel, (first, weights)) in out.iter_mut().zip(&columns) {
            let mut total = [0u32; 4];
            for (sum, &weight) in summed[*first..].iter().zip(weights) {
                for (channel, &value) in total.iter_mut().zip(sum) {
                    *channel += u32::from(value) * weight;
                }
            }
            for (byte, channel) in pixel.iter_mut().zip(total) {
                *byte = ((channel + (1 << (WEIGHT_BITS - 1))) >> WEIGHT_BITS) as u8;
            }
        }
    }
}

/// `src`, the `from`-sized BGRA texture of a `rotation` output with rows
/// `src_pitch` bytes apart, turned upright into `dst`, packed at
/// `rotation.swap_axes(from)`. An output displays its texture turned
/// clockwise by its rotation: a rotate90 texel at `(x, y)` is shown at
/// `(height - 1 - y, x)`, where Microsoft's duplication sample draws it.
pub fn rotate_bgra_cpu(src: &[u8], src_pitch: usize, from: (u32, u32), rotation: Rotation, dst: &mut [u8]) {
    let (w, h) = (from.0 as usize, from.1 as usize);
    let width = rotation.swap_axes(from).0 as usize;
    for (y, row) in dst.as_chunks_mut::<4>().0.chunks_exact_mut(width).enumerate() {
        for (x, pixel) in row.iter_mut().enumerate() {
            // the texel shown here
            let (sx, sy) = match rotation {
                Rotation::Identity => (x, y),
                Rotation::Rotate90 => (y, h - 1 - x),
                Rotation::Rotate180 => (w - 1 - x, h - 1 - y),
                Rotation::Rotate270 => (w - 1 - y, x),
            };
            pixel.copy_from_slice(&src[sy * src_pitch + sx * 4..][..4]);
        }
    }
}

/// The source rows' weights, in 1/256: a column's sum is then at most
/// 255 << 8, which a u16 lane holds. Their rounding can move a pixel by about
/// a level against an exact average, which no one sees; finer weights would
/// need u32 lanes, half as many to a register.
const ROW_WEIGHT_BITS: u32 = 8;

/// The source columns' weights, in 1/65536: a pixel's total is then at most
/// 255 << 24, which a u32 holds with the rounding half added.
const COLUMN_WEIGHT_BITS: u32 = 16;

const WEIGHT_BITS: u32 = ROW_WEIGHT_BITS + COLUMN_WEIGHT_BITS;

/// One axis of an area average: for each of `target` pixels, the first of
/// the `source` pixels it covers and the weight of each one it covers, in
/// 1/2^`bits` and summing to one. Target pixel `t` spans
/// `[t * source, (t + 1) * source)` on a grid of 1/`target` source pixels, so
/// every coverage is a whole number before it is rounded.
fn footprints(source: usize, target: usize, bits: u32) -> Vec<(usize, Vec<u32>)> {
    // rounding the running total, not each weight, keeps the sum exact
    let share = |covered: usize| ((covered << bits) + source / 2) / source;
    (0..target)
        .map(|t| {
            let (start, end) = (t * source, (t + 1) * source);
            let first = start / target;
            let weights = (first..=(end - 1) / target)
                .map(|s| {
                    let before = (s * target).max(start) - start;
                    let through = ((s + 1) * target).min(end) - start;
                    (share(through) - share(before)) as u32
                })
                .collect();
            (first, weights)
        })
        .collect()
}

/// BT.709 limited-range NV12 from full-range BGRA — the colour the GPU convert
/// writes: the luma plane, then the interleaved chroma plane at half height,
/// both `size.0` bytes a row. Both axes even, as [`plan`] makes them.
pub fn bgra_to_nv12_cpu(src: &[u8], src_pitch: usize, size: (u32, u32), dst: &mut [u8]) {
    let (w, h) = (size.0 as usize, size.1 as usize);
    let rgb = |x: usize, y: usize| {
        let i = y * src_pitch + x * 4;
        (i32::from(src[i + 2]), i32::from(src[i + 1]), i32::from(src[i]))
    };
    // the BT.709 matrix scaled into 219 levels of luma and 224 of chroma, in
    // 1/256: white is 235, blue 32, red 63, and grey carries no chroma
    for y in 0..h {
        for x in 0..w {
            let (r, g, b) = rgb(x, y);
            dst[y * w + x] = (16 + ((47 * r + 157 * g + 16 * b + 128) >> 8)) as u8;
        }
    }
    let chroma = &mut dst[w * h..];
    for y in 0..h / 2 {
        for x in 0..w / 2 {
            let (mut r, mut g, mut b) = (0, 0, 0);
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let (pr, pg, pb) = rgb(2 * x + dx, 2 * y + dy);
                (r, g, b) = (r + pr, g + pg, b + pb);
            }
            let (r, g, b) = (r / 4, g / 4, b / 4);
            chroma[y * w + 2 * x] = (128 + ((-26 * r - 86 * g + 112 * b + 128) >> 8)) as u8;
            chroma[y * w + 2 * x + 1] = (128 + ((112 * r - 102 * g - 10 * b + 128) >> 8)) as u8;
        }
    }
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
        ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext1,
        ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
        ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView, D3D11_BIND_RENDER_TARGET,
        D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE,
        D3D11_MAP_READ, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
        D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CAPS,
        D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_FEATURE_CAPS_ROTATION,
        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
        D3D11_VIDEO_PROCESSOR_ROTATION_180, D3D11_VIDEO_PROCESSOR_ROTATION_270,
        D3D11_VIDEO_PROCESSOR_ROTATION_90,
        D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE, D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_TYPE,
        DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM,
        DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
    };

    use super::Rotation;
    use crate::gpu::Frame;
    use crate::ipc::Exit;

    /// Advisory only — nothing here converts frame rate, and the stream's
    /// output rate is left at `NORMAL` (one output per input).
    const RATE: DXGI_RATIONAL = DXGI_RATIONAL {
        Numerator: 60,
        Denominator: 1,
    };

    /// The usage [`Downscaler::open`]'s video processor opens at, which picks
    /// the driver's filter. The module doc says when it moves to
    /// `OPTIMAL_QUALITY`.
    const DOWNSCALE_USAGE: D3D11_VIDEO_USAGE = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;

    /// Everything that stops a frame being downscaled.
    #[derive(Debug, Error)]
    pub enum ScaleError {
        #[error("frame carries no texture handle")]
        NoTexture,
        #[error("the frame's texture belongs to another d3d11 device — the capture source was rebuilt")]
        DeviceChanged,
        #[error("frame is {got:?}, the scaler was opened for {want:?}")]
        SourceSizeChanged { got: (u32, u32), want: (u32, u32) },
        /// WARP and other devices with no video processor: there is no GPU
        /// path to convert to NV12 with.
        #[error("this device has no video processor")]
        NoVideoProcessor,
        /// Rotation is an optional video processor feature; a BGRA rotate
        /// without it runs on the CPU instead.
        #[error("this device's video processor cannot rotate")]
        CannotRotate,
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
    /// factors a Mosaic canvas needs — and because it converts to NV12 in the
    /// same blit ([`Downscaler::open_nv12`]) and turns a rotated output's
    /// texture upright ([`Downscaler::rotate`]). A device with no video
    /// processor — WARP, on a virtual machine or a box with no GPU — still
    /// downscales and turns BGRA, through [`Readback`],
    /// [`super::scale_bgra_cpu`] and [`super::rotate_bgra_cpu`]; it has no
    /// NV12 output, which the software encoder converts for itself.
    pub struct Downscaler {
        device: ID3D11Device,
        engine: Engine,
        output: ID3D11Texture2D,
        source: (u32, u32),
        target: (u32, u32),
    }

    enum Engine {
        Video(VideoPath),
        Cpu {
            readback: Readback,
            scaled: Vec<u8>,
            rotation: Rotation,
        },
    }

    struct VideoPath {
        video_device: ID3D11VideoDevice,
        video: ID3D11VideoContext1,
        enumerator: ID3D11VideoProcessorEnumerator,
        processor: ID3D11VideoProcessor,
        output_view: ID3D11VideoProcessorOutputView,
        /// One slot, keyed by texture pointer: Desktop Duplication copies every
        /// frame into a single surface it reuses, so a one-entry cache hits
        /// every time in the real pipeline and a miss costs a view creation
        /// rather than a failure.
        input_view: Option<(usize, ID3D11VideoProcessorInputView)>,
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
            Self::open_as(
                frame,
                width,
                height,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                DOWNSCALE_USAGE,
                Rotation::Identity,
            )
        }

        /// Open a scaler that turns a `rotation` output's `frame` upright, as
        /// BGRA at the size the output is displayed. The same pixels moved,
        /// not a downscale, so it takes `OPTIMAL_SPEED` as the convert does.
        pub fn rotate(frame: &Frame, rotation: Rotation) -> Result<Self, ScaleError> {
            let (width, height) = rotation.swap_axes((frame.width, frame.height));
            Self::open_as(
                frame,
                width,
                height,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
                rotation,
            )
        }

        /// The same, producing `width`x`height` BT.709 limited-range NV12 —
        /// which may be the frame's own size, a convert with no scale. Only on
        /// a device with a video processor. Always `OPTIMAL_SPEED`: its
        /// callers convert at the captured size, which is not a downscale,
        /// and mf-hw and mf-sw pay for it on every frame, on the Intel and
        /// AMD machines mf-hw exists for.
        pub fn open_nv12(frame: &Frame, width: u32, height: u32) -> Result<Self, ScaleError> {
            Self::open_as(
                frame,
                width,
                height,
                DXGI_FORMAT_NV12,
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
                D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
                Rotation::Identity,
            )
        }

        /// Module-private so the hardware test can open either usage. Only
        /// [`Downscaler::rotate`] passes a `rotation`, with the size turned
        /// and nothing scaled, which is all the CPU path turns.
        pub(super) fn open_as(
            frame: &Frame,
            width: u32,
            height: u32,
            format: DXGI_FORMAT,
            color_space: DXGI_COLOR_SPACE_TYPE,
            usage: D3D11_VIDEO_USAGE,
            rotation: Rotation,
        ) -> Result<Self, ScaleError> {
            let raw = frame.handle as *mut c_void;
            let texture = texture_of(&raw)?;
            let device = unsafe { texture.GetDevice() }.map_err(d3d("GetDevice"))?;
            let output = create_output(&device, width, height, format)?;
            let video = match device.cast::<ID3D11VideoDevice>() {
                Ok(video_device) => VideoPath::open(
                    &device,
                    video_device,
                    &output,
                    frame,
                    (width, height),
                    color_space,
                    usage,
                )
                .and_then(|video| video.rotate(rotation).map(|()| video)),
                Err(_) => Err(ScaleError::NoVideoProcessor),
            };
            let engine = match video {
                Ok(video) => Engine::Video(video),
                Err(why @ (ScaleError::NoVideoProcessor | ScaleError::CannotRotate))
                    if format == DXGI_FORMAT_B8G8R8A8_UNORM =>
                {
                    ::log::info!("swoop: {why}; this runs on the cpu");
                    Engine::Cpu {
                        readback: Readback::bgra(&device, frame.width, frame.height)?,
                        scaled: vec![0; width as usize * height as usize * 4],
                        rotation,
                    }
                }
                Err(e) => return Err(e),
            };
            Ok(Self {
                device,
                engine,
                output,
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

            match &mut self.engine {
                Engine::Video(video) => video.blt(texture, frame.handle)?,
                Engine::Cpu {
                    readback,
                    scaled,
                    rotation,
                } => {
                    let (source, target, rotation) = (self.source, self.target, *rotation);
                    readback.read(texture, |pixels, pitch| match rotation {
                        Rotation::Identity => super::scale_bgra_cpu(pixels, pitch, source, target, scaled),
                        rotation => super::rotate_bgra_cpu(pixels, pitch, source, rotation, scaled),
                    })?;
                    // SAFETY: `scaled` is the output's whole subresource,
                    // rows packed at its width.
                    unsafe {
                        readback.context.UpdateSubresource(
                            &self.output,
                            0,
                            None,
                            scaled.as_ptr().cast(),
                            target.0 * 4,
                            0,
                        );
                    }
                }
            }

            Ok(Frame {
                handle: self.output.as_raw() as usize,
                width: self.target.0,
                height: self.target.1,
                captured_qpc: frame.captured_qpc,
            })
        }
    }

    impl VideoPath {
        fn open(
            device: &ID3D11Device,
            video_device: ID3D11VideoDevice,
            output: &ID3D11Texture2D,
            frame: &Frame,
            (width, height): (u32, u32),
            color_space: DXGI_COLOR_SPACE_TYPE,
            usage: D3D11_VIDEO_USAGE,
        ) -> Result<Self, ScaleError> {
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
                // the caller's: DOWNSCALE_USAGE for a downscale, where the
                // filter decides whether thin text survives; OPTIMAL_SPEED for
                // the same-size nv12 convert, which is not a downscale and
                // runs on every frame of mf-hw and mf-sw
                Usage: usage,
            };
            let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&content) }
                .map_err(d3d("CreateVideoProcessorEnumerator"))?;
            // Rate-conversion index 0 is the driver's plain scaler; every other
            // index is a frame-rate converter, which this pipeline never wants.
            let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }
                .map_err(d3d("CreateVideoProcessor"))?;

            let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut output_view = None;
            unsafe {
                video_device.CreateVideoProcessorOutputView(
                    output,
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
                video.VideoProcessorSetOutputColorSpace1(&processor, color_space);
                video.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&src));
                video.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&dst));
                video.VideoProcessorSetOutputTargetRect(&processor, true, Some(&dst));
            }

            Ok(Self {
                video_device,
                video,
                enumerator,
                processor,
                output_view,
                input_view: None,
            })
        }

        /// Turn the stream by `rotation` on every blit, clockwise, as the
        /// output displays its texture. The destination rect is already the
        /// turned size. Rotation is an optional video processor feature, so
        /// it is asked for first.
        fn rotate(&self, rotation: Rotation) -> Result<(), ScaleError> {
            let turn = match rotation {
                Rotation::Identity => return Ok(()),
                Rotation::Rotate90 => D3D11_VIDEO_PROCESSOR_ROTATION_90,
                Rotation::Rotate180 => D3D11_VIDEO_PROCESSOR_ROTATION_180,
                Rotation::Rotate270 => D3D11_VIDEO_PROCESSOR_ROTATION_270,
            };
            let mut caps = D3D11_VIDEO_PROCESSOR_CAPS::default();
            unsafe { self.enumerator.GetVideoProcessorCaps(&mut caps) }
                .map_err(d3d("GetVideoProcessorCaps"))?;
            if caps.FeatureCaps & D3D11_VIDEO_PROCESSOR_FEATURE_CAPS_ROTATION.0 as u32 == 0 {
                return Err(ScaleError::CannotRotate);
            }
            unsafe {
                self.video
                    .VideoProcessorSetStreamRotation(&self.processor, 0, true, turn)
            };
            Ok(())
        }

        /// One `VideoProcessorBlt` of `texture` into the output.
        fn blt(&mut self, texture: &ID3D11Texture2D, key: usize) -> Result<(), ScaleError> {
            let view = match &self.input_view {
                Some((cached, view)) if *cached == key => view.clone(),
                _ => {
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
                    view
                }
            };
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
            blt.map_err(d3d("VideoProcessorBlt"))
        }
    }

    /// A texture read on the CPU through a staging copy of it: BGRA for the
    /// CPU paths a device with no video processor takes, NV12 for the software
    /// encoder's input where the GPU converted it.
    pub struct Readback {
        context: ID3D11DeviceContext,
        staging: ID3D11Texture2D,
        /// Rows in the mapped surface: NV12's chroma plane follows its luma
        /// plane at half height.
        rows: usize,
    }

    impl Readback {
        /// A staging surface for `width`x`height` BGRA textures of `device`.
        pub fn bgra(device: &ID3D11Device, width: u32, height: u32) -> Result<Self, ScaleError> {
            Self::open(device, width, height, DXGI_FORMAT_B8G8R8A8_UNORM)
        }

        /// The same for NV12, whose chroma plane comes with it.
        pub fn nv12(device: &ID3D11Device, width: u32, height: u32) -> Result<Self, ScaleError> {
            Self::open(device, width, height, DXGI_FORMAT_NV12)
        }

        fn open(
            device: &ID3D11Device,
            width: u32,
            height: u32,
            format: DXGI_FORMAT,
        ) -> Result<Self, ScaleError> {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: format,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut staging = None;
            unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }
                .map_err(d3d("CreateTexture2D(staging)"))?;
            let staging = staging.ok_or(ScaleError::D3d {
                call: "CreateTexture2D(staging)",
                source: windows::core::Error::from(windows::Win32::Foundation::E_FAIL),
            })?;
            let context = unsafe { device.GetImmediateContext() }
                .map_err(d3d("GetImmediateContext"))?;
            let rows = if format == DXGI_FORMAT_NV12 {
                height as usize * 3 / 2
            } else {
                height as usize
            };
            Ok(Self {
                context,
                staging,
                rows,
            })
        }

        /// Copy `texture` and hand `read` its pixels and row pitch, mapped for
        /// exactly that call.
        pub fn read<R>(
            &self,
            texture: &ID3D11Texture2D,
            read: impl FnOnce(&[u8], usize) -> R,
        ) -> Result<R, ScaleError> {
            // SAFETY: the copy and the map bracket the read; the mapped surface
            // is RowPitch bytes for each of its rows.
            unsafe {
                self.context.CopyResource(&self.staging, texture);
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                self.context
                    .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                    .map_err(d3d("Map(staging)"))?;
                let pitch = mapped.RowPitch as usize;
                let pixels = std::slice::from_raw_parts(mapped.pData.cast::<u8>(), pitch * self.rows);
                let answer = read(pixels, pitch);
                self.context.Unmap(&self.staging, 0);
                Ok(answer)
            }
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

    /// The output surface. A BGRA one carries the bind flags Desktop
    /// Duplication's own surface carries, so the encoder takes it on exactly
    /// the terms it takes an un-scaled one; an NV12 one is a render target
    /// alone, because NV12 views for shaders are optional hardware.
    fn create_output(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
    ) -> Result<ID3D11Texture2D, ScaleError> {
        let bind = if format == DXGI_FORMAT_NV12 {
            D3D11_BIND_RENDER_TARGET.0
        } else {
            D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0
        };
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: bind as u32,
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
pub use imp::{Downscaler, Readback, ScaleError};

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

    /// `w`x`h` BGRA, the left half one colour and the right half another, with
    /// `pad` bytes after each row as a mapped surface has.
    fn halves(w: usize, h: usize, pad: usize, left: [u8; 4], right: [u8; 4]) -> Vec<u8> {
        let mut px = Vec::with_capacity((w * 4 + pad) * h);
        for _ in 0..h {
            for x in 0..w {
                px.extend_from_slice(if x < w / 2 { &left } else { &right });
            }
            px.extend(std::iter::repeat_n(0xee, pad));
        }
        px
    }

    const BLUE: [u8; 4] = [255, 0, 0, 255];
    const RED: [u8; 4] = [0, 0, 255, 255];

    #[test]
    fn the_cpu_convert_writes_the_gpu_converts_bt709_limited_levels() {
        let (w, h, pad) = (16, 4, 12);
        let src = halves(w, h, pad, BLUE, RED);
        let mut nv12 = vec![0u8; w * h * 3 / 2];
        bgra_to_nv12_cpu(&src, w * 4 + pad, (w as u32, h as u32), &mut nv12);
        // the luma the hardware convert measured: blue 32, red 63
        assert_eq!((nv12[0], nv12[w - 1]), (32, 63));
        let chroma = &nv12[w * h..];
        // blue is all cb, red all cr, at the top of 224 levels
        assert_eq!((chroma[0], chroma[1]), (240, 118));
        assert_eq!((chroma[w - 2], chroma[w - 1]), (102, 240));

        let grey = halves(2, 2, 0, [128, 128, 128, 255], [255, 255, 255, 255]);
        let mut out = vec![0u8; 6];
        bgra_to_nv12_cpu(&grey, 8, (2, 2), &mut out);
        assert_eq!(out[1], 235, "white is luma 235");
        assert_eq!((out[4], out[5]), (128, 128), "grey carries no chroma");
    }

    #[test]
    fn the_cpu_scale_keeps_each_half_where_it_was() {
        let (w, h, pad) = (64, 32, 8);
        let src = halves(w, h, pad, BLUE, RED);
        let mut out = vec![0u8; 32 * 16 * 4];
        scale_bgra_cpu(&src, w * 4 + pad, (64, 32), (32, 16), &mut out);
        let at = |x: usize, y: usize| &out[(y * 32 + x) * 4..(y * 32 + x) * 4 + 4];
        assert_eq!(at(4, 8), BLUE);
        assert_eq!(at(27, 8), RED);

        // the same size is the same picture
        let mut same = vec![0u8; w * h * 4];
        scale_bgra_cpu(&src, w * 4 + pad, (64, 32), (64, 32), &mut same);
        assert_eq!(same, halves(w, h, 0, BLUE, RED));
    }

    /// `len` bytes of a fixed xorshift sequence: a picture with no structure
    /// for a filter to line up with.
    fn noise(len: usize) -> Vec<u8> {
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 56) as u8
            })
            .collect()
    }

    /// Each channel's mean over a `w`x`h` BGRA picture whose rows are `pitch`
    /// bytes apart.
    fn means(px: &[u8], pitch: usize, w: usize, h: usize) -> [f64; 4] {
        let mut sums = [0u64; 4];
        for row in px.chunks(pitch).take(h) {
            for pixel in row[..w * 4].as_chunks::<4>().0 {
                for (sum, &value) in sums.iter_mut().zip(pixel) {
                    *sum += u64::from(value);
                }
            }
        }
        sums.map(|sum| sum as f64 / (w * h) as f64)
    }

    #[test]
    fn one_pixel_lines_come_out_even_at_three_to_one() {
        // a 1-px white line every third column and row: each 3x3 footprint
        // holds one of each, so an area average is the same grey everywhere,
        // where a two-tap filter reads only the black between the lines
        let (w, h, pad) = (96, 48, 8);
        let mut src: Vec<u8> = Vec::with_capacity((w * 4 + pad) * h);
        for y in 0..h {
            for x in 0..w {
                let v = if x % 3 == 0 || y % 3 == 0 { 255 } else { 0 };
                src.extend_from_slice(&[v, v, v, 255]);
            }
            src.extend(std::iter::repeat_n(0xee, pad));
        }
        let mean = means(&src, w * 4 + pad, w, h);
        let mut out = vec![0u8; 32 * 16 * 4];
        scale_bgra_cpu(&src, w * 4 + pad, (96, 48), (32, 16), &mut out);
        for (i, pixel) in out.as_chunks::<4>().0.iter().enumerate() {
            for (&value, mean) in pixel.iter().zip(mean) {
                assert!(
                    (f64::from(value) - mean).abs() <= 1.0,
                    "pixel {i} is {pixel:?}, the lines' mean {mean:.2}"
                );
            }
        }
    }

    #[test]
    fn a_four_to_three_shrink_keeps_a_pictures_mean() {
        let (w, h, pad) = (128, 96, 12);
        let src = noise((w * 4 + pad) * h);
        let mut out = vec![0u8; 96 * 72 * 4];
        scale_bgra_cpu(&src, w * 4 + pad, (128, 96), (96, 72), &mut out);
        let (before, after) = (means(&src, w * 4 + pad, w, h), means(&out, 96 * 4, 96, 72));
        for (before, after) in before.into_iter().zip(after) {
            assert!(
                (before - after).abs() <= 1.0,
                "the mean moved from {before:.2} to {after:.2}"
            );
        }
    }

    /// A 3x2 picture whose every pixel is its own, turned each way, with its
    /// rows padded as a mapped surface pads them. A rotated output displays
    /// its texture turned clockwise by the rotation.
    #[test]
    fn the_cpu_rotation_turns_a_texture_into_the_displayed_picture() {
        let pixel = |n: u8| [n, n, n, 255];
        let (a, b, c, d, e, f) = (pixel(1), pixel(2), pixel(3), pixel(4), pixel(5), pixel(6));
        let pad = 8;
        let mut src = Vec::new();
        for row in [[a, b, c], [d, e, f]] {
            src.extend(row.concat());
            src.extend(std::iter::repeat_n(0xee, pad));
        }
        let turned = |rotation| {
            let mut out = vec![0u8; 3 * 2 * 4];
            rotate_bgra_cpu(&src, 3 * 4 + pad, (3, 2), rotation, &mut out);
            out
        };
        assert_eq!(turned(Rotation::Identity), [a, b, c, d, e, f].concat());
        // 2x3: the left column, bottom up, is the top row
        assert_eq!(turned(Rotation::Rotate90), [d, a, e, b, f, c].concat());
        assert_eq!(turned(Rotation::Rotate180), [f, e, d, c, b, a].concat());
        // 2x3: the right column, top down, is the top row
        assert_eq!(turned(Rotation::Rotate270), [c, f, b, e, a, d].concat());
    }

    /// The CPU path's cost on a 4K desktop at mf-sw's 720p cap; task 4.1
    /// holds its p50 to 10 ms. A debug build's time means nothing, so it
    /// times only with `--release`.
    #[test]
    #[ignore = "a timing: run it with --release"]
    fn cpu_scale_times_a_four_k_shrink_to_720p() {
        if cfg!(debug_assertions) {
            println!("cpu scale: 3840x2160 -> 1280x720 times only with --release");
            return;
        }
        let (from, to) = ((3840u32, 2160u32), (1280u32, 720u32));
        let src = noise(3840 * 2160 * 4);
        let mut out = vec![0u8; 1280 * 720 * 4];
        let mut times: Vec<_> = (0..60)
            .map(|_| {
                let start = std::time::Instant::now();
                scale_bgra_cpu(&src, 3840 * 4, from, to, std::hint::black_box(&mut out));
                start.elapsed()
            })
            .collect();
        times.sort();
        println!(
            "cpu scale: 3840x2160 -> 1280x720 p50 {:.2} ms over {} runs",
            times[times.len() / 2].as_secs_f64() * 1e3,
            times.len()
        );
    }
}

#[cfg(all(test, windows))]
mod gpu_tests {
    use std::time::{Duration, Instant};

    use windows::core::{Interface, BOOL};
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_11_0,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11Query, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
        D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_QUERY_DESC, D3D11_QUERY_EVENT,
        D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
        D3D11_USAGE_STAGING, D3D11_VIDEO_USAGE, D3D11_VIDEO_USAGE_OPTIMAL_QUALITY,
        D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
        DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC,
    };

    use super::{bgra_to_nv12_cpu, rotate_bgra_cpu, Downscaler};
    use crate::capture::Rotation;
    use crate::gpu::Frame;

    const SRC: (u32, u32) = (256, 128);
    const DST: (u32, u32) = (128, 64);

    fn device() -> ID3D11Device {
        device_of(D3D_DRIVER_TYPE_HARDWARE)
    }

    fn device_of(driver: D3D_DRIVER_TYPE) -> ID3D11Device {
        let mut device = None;
        unsafe {
            D3D11CreateDevice(
                None,
                driver,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        }
        .expect("a d3d11 device");
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
        texture(device, SRC, &pixels)
    }

    /// 1-px black and white columns, alternating, in BGRA.
    fn stripes((width, height): (u32, u32)) -> Vec<u8> {
        let row: Vec<u8> = (0..width)
            .flat_map(|x| if x % 2 == 0 { [0, 0, 0, 255] } else { [255, 255, 255, 255] })
            .collect();
        row.repeat(height as usize)
    }

    /// A `width`x`height` BGRA texture holding `pixels`, rows packed.
    fn texture(device: &ID3D11Device, (width, height): (u32, u32), pixels: &[u8]) -> ID3D11Texture2D {
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
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: width * 4,
            SysMemSlicePitch: 0,
        };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }
            .expect("the source texture");
        texture.expect("CreateTexture2D returned a texture")
    }

    /// Copy `texture` to a staging surface and read it back as BGRA rows, or
    /// as luma rows for an NV12 one.
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
        let row_bytes = if desc.Format == DXGI_FORMAT_NV12 { desc.Width } else { desc.Width * 4 };
        let mut rows = Vec::with_capacity((row_bytes * desc.Height) as usize);
        for y in 0..desc.Height {
            // SAFETY: the mapped surface is at least RowPitch * Height bytes.
            let row = unsafe {
                std::slice::from_raw_parts(
                    mapped.pData.cast::<u8>().add((y * mapped.RowPitch) as usize),
                    row_bytes as usize,
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

    /// The convert the Media Foundation rungs feed from. BT.709 limited
    /// range: blue is luma 32, red 63.
    #[test]
    #[ignore = "needs a gpu"]
    fn nv12_convert_writes_bt709_limited_luma() {
        let device = device();
        let source = two_tone(&device);
        let frame = Frame {
            handle: source.as_raw() as usize,
            width: SRC.0,
            height: SRC.1,
            captured_qpc: 0,
        };
        let mut convert = Downscaler::open_nv12(&frame, SRC.0, SRC.1).expect("an nv12 convert");
        let nv12 = convert.scale(&frame).expect("a converted frame");
        let raw = nv12.handle as *mut std::ffi::c_void;
        // SAFETY: borrowed from the converter, which is still alive.
        let texture = unsafe { ID3D11Texture2D::from_raw_borrowed(&raw) }.expect("the output");
        let luma = readback(&device, texture);
        let at = |x: u32, y: u32| luma[(y * SRC.0 + x) as usize];
        println!("gpu nv12: blue luma {}, red luma {}", at(32, 64), at(224, 64));
        assert!(at(32, 64).abs_diff(32) <= 3, "blue is luma 32, got {}", at(32, 64));
        assert!(at(224, 64).abs_diff(63) <= 3, "red is luma 63, got {}", at(224, 64));
    }

    /// WARP — the device a virtual machine or a box with no GPU renders on —
    /// has no video processor: a BGRA downscale still works there, on the
    /// CPU, and an NV12 convert is refused for the encoder to do itself. No
    /// GPU needed, so not ignored.
    #[test]
    fn warp_downscales_on_the_cpu_and_refuses_nv12() {
        let device = device_of(D3D_DRIVER_TYPE_WARP);
        let source = two_tone(&device);
        let frame = Frame {
            handle: source.as_raw() as usize,
            width: SRC.0,
            height: SRC.1,
            captured_qpc: 1234,
        };
        assert!(
            matches!(
                Downscaler::open_nv12(&frame, SRC.0, SRC.1),
                Err(super::ScaleError::NoVideoProcessor)
            ),
            "warp has no video processor to convert with"
        );
        let mut scaler = Downscaler::open(&frame, DST.0, DST.1).expect("a cpu downscaler");
        let scaled = scaler.scale(&frame).expect("a scaled frame");
        assert_eq!((scaled.width, scaled.height), DST);
        assert_eq!(scaled.captured_qpc, frame.captured_qpc);
        let raw = scaled.handle as *mut std::ffi::c_void;
        // SAFETY: borrowed from the scaler, which is still alive.
        let texture = unsafe { ID3D11Texture2D::from_raw_borrowed(&raw) }.expect("the output");
        let pixels = readback(&device, texture);
        let at = |x: u32, y: u32| {
            let i = ((y * DST.0 + x) * 4) as usize;
            (pixels[i], pixels[i + 1], pixels[i + 2])
        };
        assert_eq!(at(16, 32), (255, 0, 0), "left half stays blue");
        assert_eq!(at(112, 32), (0, 0, 255), "right half stays red");
    }

    /// `width`x`height` BGRA in four quadrants: red top-left, green top-right,
    /// blue bottom-left, white bottom-right, so any turn or mirror moves one.
    fn quadrants((width, height): (u32, u32)) -> Vec<u8> {
        let mut pixels: Vec<u8> = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                pixels.extend_from_slice(match (x < width / 2, y < height / 2) {
                    (true, true) => &[0, 0, 255, 255],
                    (false, true) => &[0, 255, 0, 255],
                    (true, false) => &[255, 0, 0, 255],
                    (false, false) => &[255, 255, 255, 255],
                });
            }
        }
        pixels
    }

    /// The middle of each quadrant of a `width`x`height` picture: far from
    /// the edges between them, where a filter blends.
    fn middles((width, height): (u32, u32)) -> [(u32, u32); 4] {
        let (x, y) = (width / 4, height / 4);
        [(x, y), (3 * x, y), (x, 3 * y), (3 * x, 3 * y)]
    }

    /// The `bytes`-wide pixel at `(x, y)` of a packed `width`-wide picture.
    fn at(pixels: &[u8], width: u32, bytes: u32, (x, y): (u32, u32)) -> &[u8] {
        let i = ((y * width + x) * bytes) as usize;
        &pixels[i..i + bytes as usize]
    }

    /// [`readback`] of a frame's texture, which whoever made the frame still
    /// holds.
    fn pixels_of(device: &ID3D11Device, frame: &Frame) -> Vec<u8> {
        let raw = frame.handle as *mut std::ffi::c_void;
        // SAFETY: borrowed from the frame's maker, which is still alive.
        let texture = unsafe { ID3D11Texture2D::from_raw_borrowed(&raw) }.expect("the frame's texture");
        readback(device, texture)
    }

    /// Turn a four-colour `size` picture on `device` each way, and hand
    /// `check` each upright frame with the CPU rotation's pixels for it. Each
    /// is the displayed size, and the downscale a tier runs after it keeps
    /// every quadrant where the upright picture has it.
    fn each_turn(device: &ID3D11Device, size: (u32, u32), mut check: impl FnMut(Rotation, &Frame, &[u8])) {
        let pixels = quadrants(size);
        let source = texture(device, size, &pixels);
        let frame = Frame {
            handle: source.as_raw() as usize,
            width: size.0,
            height: size.1,
            captured_qpc: 1234,
        };
        for rotation in [Rotation::Rotate90, Rotation::Rotate180, Rotation::Rotate270] {
            let shown = rotation.swap_axes(size);
            let mut upright = Downscaler::rotate(&frame, rotation).expect("a rotation");
            assert_eq!(upright.target(), shown, "{rotation:?}");
            let turned = upright.scale(&frame).expect("an upright frame");
            assert_eq!((turned.width, turned.height), shown, "{rotation:?}");
            assert_eq!(turned.captured_qpc, frame.captured_qpc);
            let mut want = vec![0u8; pixels.len()];
            rotate_bgra_cpu(&pixels, size.0 as usize * 4, size, rotation, &mut want);
            check(rotation, &turned, &want);

            let half = (shown.0 / 2, shown.1 / 2);
            let mut scaler = Downscaler::open(&turned, half.0, half.1).expect("a downscaler");
            let small = pixels_of(device, &scaler.scale(&turned).expect("a downscaled frame"));
            for (x, y) in middles(half) {
                assert_eq!(
                    at(&small, half.0, 4, (x, y)),
                    at(&want, shown.0, 4, (2 * x, 2 * y)),
                    "{rotation:?} downscaled at ({x}, {y})"
                );
            }
        }
    }

    /// WARP has no video processor, so a rotated output's frame is turned
    /// upright on the CPU, to exactly the CPU rotation's pixels, and the area
    /// average takes it from there. No GPU needed, so not ignored.
    #[test]
    fn warp_turns_a_rotated_frame_upright_on_the_cpu() {
        let device = device_of(D3D_DRIVER_TYPE_WARP);
        each_turn(&device, (64, 32), |rotation, turned, want| {
            assert_eq!(pixels_of(&device, turned), want, "{rotation:?}");
        });
    }

    /// The video processor turns a rotated output's frame upright as the CPU
    /// rotation does, and the downscale a tier runs and the NV12 convert
    /// mf-hw runs after it both see the upright picture.
    #[test]
    #[ignore = "needs a gpu"]
    fn the_video_processor_turns_a_rotated_frame_upright() {
        let device = device();
        each_turn(&device, SRC, |rotation, turned, want| {
            let shown = (turned.width, turned.height);
            let got = pixels_of(&device, turned);
            for point in middles(shown) {
                assert_eq!(at(&got, shown.0, 4, point), at(want, shown.0, 4, point), "{rotation:?} at {point:?}");
            }

            let mut convert = Downscaler::open_nv12(turned, shown.0, shown.1).expect("an nv12 convert");
            let luma = pixels_of(&device, &convert.scale(turned).expect("a converted frame"));
            let mut levels = vec![0u8; want.len() * 3 / 8];
            bgra_to_nv12_cpu(want, shown.0 as usize * 4, shown, &mut levels);
            for point in middles(shown) {
                let (got, want) = (at(&luma, shown.0, 1, point)[0], at(&levels, shown.0, 1, point)[0]);
                assert!(got.abs_diff(want) <= 3, "{rotation:?} luma at {point:?} is {got}, not {want}");
            }
        });
    }

    /// A scaler as [`Downscaler::open`] makes it, or a convert as
    /// [`Downscaler::open_nv12`] does, but at `usage`.
    fn open_at(frame: &Frame, to: (u32, u32), nv12: bool, usage: D3D11_VIDEO_USAGE) -> Downscaler {
        let (format, color_space) = if nv12 {
            (DXGI_FORMAT_NV12, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709)
        } else {
            (DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709)
        };
        Downscaler::open_as(frame, to.0, to.1, format, color_space, usage, Rotation::Identity)
            .expect("a scaler")
    }

    /// The p50 of 120 blits, each from its submit until the GPU signals it
    /// done, which is what a frame waits for. 30 untimed blits go first, so
    /// whichever case runs first does not pay for idle clocks.
    fn blit_p50(device: &ID3D11Device, scaler: &mut Downscaler, frame: &Frame) -> Duration {
        let context = unsafe { device.GetImmediateContext() }.expect("the immediate context");
        let desc = D3D11_QUERY_DESC {
            Query: D3D11_QUERY_EVENT,
            MiscFlags: 0,
        };
        let mut query = None;
        unsafe { device.CreateQuery(&desc, Some(&mut query)) }.expect("an event query");
        let query: ID3D11Query = query.expect("CreateQuery returned a query");
        let mut blit = || {
            let start = Instant::now();
            scaler.scale(frame).expect("a blit");
            let mut done = BOOL(0);
            unsafe { context.End(&query) };
            // S_FALSE until the gpu reaches the event, and windows-rs reads
            // S_FALSE as success: the flag is the answer
            while !done.as_bool() {
                unsafe {
                    context.GetData(
                        &query,
                        Some((&mut done as *mut BOOL).cast()),
                        size_of::<BOOL>() as u32,
                        0,
                    )
                }
                .expect("the event query");
            }
            start.elapsed()
        };
        for _ in 0..30 {
            blit();
        }
        let mut times: Vec<Duration> = (0..120).map(|_| blit()).collect();
        times.sort();
        times[times.len() / 2]
    }

    /// The numbers task 4.1 chooses `DOWNSCALE_USAGE` by, for each usage: the
    /// BGRA downscale's p50 at 3840x2160 -> 1920x1080 and -> 2560x1440, the
    /// same-size NV12 convert's at 3840x2160 and 2560x1440, and what its
    /// filter makes of 1-px black and white stripes at 3:1. Prints only.
    #[test]
    #[ignore = "needs a gpu"]
    fn each_usage_prints_its_blit_time_and_its_filter() {
        let device = device();
        let (uhd, qhd) = ((3840, 2160), (2560, 1440));
        let (uhd_stripes, qhd_stripes) = (
            texture(&device, uhd, &stripes(uhd)),
            texture(&device, qhd, &stripes(qhd)),
        );
        let frame = |texture: &ID3D11Texture2D, (width, height): (u32, u32)| Frame {
            handle: texture.as_raw() as usize,
            width,
            height,
            captured_qpc: 0,
        };
        let ms = |time: Duration| time.as_secs_f64() * 1e3;
        let source = frame(&uhd_stripes, uhd);
        for (name, usage) in [
            ("OPTIMAL_SPEED", D3D11_VIDEO_USAGE_OPTIMAL_SPEED),
            ("OPTIMAL_QUALITY", D3D11_VIDEO_USAGE_OPTIMAL_QUALITY),
        ] {
            for to in [(1920, 1080), qhd] {
                let mut scaler = open_at(&source, to, false, usage);
                let p50 = blit_p50(&device, &mut scaler, &source);
                println!("gpu scale {name}: bgra 3840x2160 -> {}x{} p50 {:.3} ms", to.0, to.1, ms(p50));
            }
            for (texture, size) in [(&uhd_stripes, uhd), (&qhd_stripes, qhd)] {
                let input = frame(texture, size);
                let mut convert = open_at(&input, size, true, usage);
                let p50 = blit_p50(&device, &mut convert, &input);
                println!("gpu scale {name}: nv12 {}x{} p50 {:.3} ms", size.0, size.1, ms(p50));
            }

            let to = (1280u32, 720u32);
            let mut scaler = open_at(&source, to, false, usage);
            let scaled = scaler.scale(&source).expect("a scaled frame");
            let raw = scaled.handle as *mut std::ffi::c_void;
            // SAFETY: borrowed from the scaler, which is still alive.
            let output = unsafe { ID3D11Texture2D::from_raw_borrowed(&raw) }.expect("the output");
            let pixels = readback(&device, output);
            // green, inside an 8-px border where a filter's taps run off the
            // picture: an ideal filter gives 127.5 and no spread, an area
            // average 85 and 170 in turn, a point sample 0 and 255
            let inside: Vec<u8> = (8..to.1 - 8)
                .flat_map(|y| (8..to.0 - 8).map(move |x| (y * to.0 + x) as usize))
                .map(|i| pixels[i * 4 + 1])
                .collect();
            let mean = inside.iter().map(|&v| f64::from(v)).sum::<f64>() / inside.len() as f64;
            let (min, max) = inside
                .iter()
                .fold((u8::MAX, u8::MIN), |(min, max), &v| (min.min(v), max.max(v)));
            println!(
                "gpu scale {name}: 1-px stripes 3840x2160 -> 1280x720 mean {mean:.1}, spread {} ({min}..{max})",
                max - min
            );
        }
    }
}
