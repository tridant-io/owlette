//! Synthetic capture source (Task 8.7).
//!
//! Selected only through the bundle's test-only `overrides` object
//! (`{"source":"testpattern"}`) and only in a build carrying the `testhooks`
//! cargo feature, so CI can run the pipeline on a runner with no desktop: the
//! session captures [`output`] instead of an attached display, and a capture
//! pass opened on it reads from [`TestPattern`] instead of Desktop Duplication.
//!
//! The picture is a pure function of the frame number ([`Painter`]): a gradient
//! that scrolls, a bar that sweeps, and the frame counter itself as 32 blocks
//! across the top, most significant bit first, white for one — so a decoded
//! frame says which frame it was. Frames are paced at 60 Hz, like
//! a panel, and uploaded into a D3D11 BGRA texture shaped like the one capture
//! hands out, on a hardware device when there is one and on WARP when not.

use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Foundation::{E_FAIL, HMODULE};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_11_0,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

use crate::capture::{OutputInfo, RebuildSignal, Rect, Rotation, Source};
use crate::cursor::PointerSample;
use crate::gpu::Frame;
use crate::platform::{clock, CaptureSource};

/// The source name the bundle's `overrides` selects this with.
pub const SOURCE: &str = "testpattern";

/// The output's device name, which is how a capture pass knows to open the
/// pattern rather than a duplication. No display adapter names an output this.
pub const DEVICE_NAME: &str = "swoop-testpattern";

/// 720p: inside every encoder's ceiling, the software floor's included, so the
/// pattern is encoded as rendered and never downscaled.
pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 720;

const FRAME_INTERVAL: Duration = Duration::from_micros(16_667);

/// The counter: 32 blocks, this many pixels square, along the top edge.
const BIT_SIZE: usize = 32;

/// The one output a pattern session has, at the virtual desktop's origin so
/// it is the primary.
pub fn output() -> OutputInfo {
    OutputInfo {
        device_name: DEVICE_NAME.to_owned(),
        desktop_rect: Rect {
            left: 0,
            top: 0,
            right: WIDTH as i32,
            bottom: HEIGHT as i32,
        },
        rotation: Rotation::Identity,
    }
}

const W: usize = WIDTH as usize;
const H: usize = HEIGHT as usize;

/// One period of the scrolling gradient, in pixels.
const PERIOD: usize = 256;

/// Paints the pattern. The gradient is drawn once, a period wider than the
/// picture, so each frame's rows are copied out of it at an offset rather
/// than computed pixel by pixel — a debug build still keeps 60 Hz.
pub struct Painter {
    background: Vec<u8>,
}

impl Default for Painter {
    fn default() -> Self {
        let mut background = Vec::with_capacity((W + PERIOD) * H * 4);
        for y in 0..H {
            let g = (y * 255 / H) as u8;
            for x in 0..W + PERIOD {
                let t = (x % PERIOD) as u8;
                background.extend_from_slice(&[t, g, 255 - t, 0xff]);
            }
        }
        Self { background }
    }
}

impl Painter {
    /// Frame `frame` into `out`: [`WIDTH`]x[`HEIGHT`] BGRA, rows packed.
    pub fn paint(&self, frame: u64, out: &mut [u8]) {
        let shift = (frame as usize).wrapping_mul(4) % PERIOD;
        let stride = (W + PERIOD) * 4;
        for y in 0..H {
            let from = y * stride + shift * 4;
            out[y * W * 4..(y + 1) * W * 4].copy_from_slice(&self.background[from..from + W * 4]);
        }
        let (pixels, _) = out.as_chunks_mut::<4>();
        let bar = (frame as usize).wrapping_mul(8) % W;
        for y in 0..H {
            pixels[y * W + bar.saturating_sub(15)..y * W + (bar + 16).min(W)]
                .fill([0x10, 0x60, 0xc0, 0xff]);
        }
        for bit in 0..32 {
            let level = if (frame >> (31 - bit)) & 1 == 1 {
                0xff
            } else {
                0x00
            };
            for y in 0..BIT_SIZE {
                pixels[y * W + bit * BIT_SIZE..y * W + (bit + 1) * BIT_SIZE]
                    .fill([level, level, level, 0xff]);
            }
        }
    }
}

/// The frame number a painted — or decoded — picture carries, read from the
/// centre of each counter block, so a lossy round trip still reads true.
#[cfg(test)]
fn counter(pixels: &[u8]) -> u64 {
    (0..32).fold(0u64, |value, bit| {
        let i = ((BIT_SIZE / 2) * W + bit * BIT_SIZE + BIT_SIZE / 2) * 4;
        let level = u32::from(pixels[i]) + u32::from(pixels[i + 1]) + u32::from(pixels[i + 2]);
        (value << 1) | u64::from(level > 384)
    })
}

fn create_device(driver: D3D_DRIVER_TYPE) -> windows::core::Result<ID3D11Device> {
    let mut device = None;
    // SAFETY: every out parameter is owned here.
    unsafe {
        D3D11CreateDevice(
            None,
            driver,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
    }?;
    device.ok_or_else(|| E_FAIL.into())
}

/// The pattern as a capture source.
pub struct TestPattern {
    output: OutputInfo,
    context: ID3D11DeviceContext,
    texture: ID3D11Texture2D,
    painter: Painter,
    pixels: Vec<u8>,
    frame: u64,
    started: Instant,
}

// SAFETY: the context and the texture are used from exactly one thread at a
// time — the capture thread owns the source.
unsafe impl Send for TestPattern {}

impl TestPattern {
    pub fn open() -> anyhow::Result<Self> {
        let device = create_device(D3D_DRIVER_TYPE_HARDWARE)
            .or_else(|_| create_device(D3D_DRIVER_TYPE_WARP))?;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: WIDTH,
            Height: HEIGHT,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        // SAFETY: the description outlives the call.
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }?;
        let texture =
            texture.ok_or_else(|| anyhow::anyhow!("CreateTexture2D returned no texture"))?;
        // SAFETY: the device's own context.
        let context = unsafe { device.GetImmediateContext() }?;
        ::log::info!("swoop: capturing the test pattern at {WIDTH}x{HEIGHT}");
        Ok(Self {
            output: output(),
            context,
            texture,
            painter: Painter::default(),
            pixels: vec![0; W * H * 4],
            frame: 0,
            started: Instant::now(),
        })
    }

    pub fn output(&self) -> &OutputInfo {
        &self.output
    }

    /// The next frame once it is due, waiting at most `timeout_ms` for it.
    /// The pattern carries no pointer, so the observer is never called.
    pub fn next_frame_with(
        &mut self,
        timeout_ms: u32,
        _observer: &mut dyn FnMut(&PointerSample),
    ) -> anyhow::Result<Option<Frame>> {
        let due = self.started + FRAME_INTERVAL * self.frame as u32;
        let timeout = Duration::from_millis(u64::from(timeout_ms));
        let wait = due.saturating_duration_since(Instant::now());
        if wait > timeout {
            std::thread::sleep(timeout);
            return Ok(None);
        }
        std::thread::sleep(wait);
        self.painter.paint(self.frame, &mut self.pixels);
        // SAFETY: the rows are WIDTH * 4 bytes apart and the buffer holds
        // HEIGHT of them: the texture's whole subresource.
        unsafe {
            self.context.UpdateSubresource(
                &self.texture,
                0,
                None,
                self.pixels.as_ptr().cast(),
                WIDTH * 4,
                0,
            );
        }
        self.frame += 1;
        Ok(Some(Frame {
            handle: self.texture.as_raw() as usize,
            width: WIDTH,
            height: HEIGHT,
            captured_qpc: clock::now_ticks(),
        }))
    }
}

impl Source for TestPattern {
    fn next_frame(&mut self, timeout_ms: u32) -> anyhow::Result<Option<Frame>> {
        self.next_frame_with(timeout_ms, &mut |_| {})
    }

    fn size(&self) -> (u32, u32) {
        (WIDTH, HEIGHT)
    }
}

/// What a capture pass reads in a `testhooks` build: the desktop, or the
/// pattern when the pass was opened on [`output`]. The session names this type
/// instead of the platform's under the feature; every method forwards.
pub enum PassSource {
    Desktop(CaptureSource),
    Pattern(TestPattern),
}

impl PassSource {
    pub fn open(output: &OutputInfo, signal: RebuildSignal) -> anyhow::Result<Self> {
        if output.device_name == DEVICE_NAME {
            return TestPattern::open().map(Self::Pattern);
        }
        CaptureSource::open(output, signal).map(Self::Desktop)
    }

    pub fn output(&self) -> &OutputInfo {
        match self {
            Self::Desktop(source) => source.output(),
            Self::Pattern(source) => source.output(),
        }
    }

    pub fn request_rebuild(&self) {
        if let Self::Desktop(source) = self {
            source.request_rebuild();
        }
    }

    /// Only a duplication is ever rebuilt under the session.
    pub fn take_idr_request(&mut self) -> bool {
        match self {
            Self::Desktop(source) => source.take_idr_request(),
            Self::Pattern(_) => false,
        }
    }

    pub fn next_frame_with(
        &mut self,
        timeout_ms: u32,
        observer: &mut dyn FnMut(&PointerSample),
    ) -> anyhow::Result<Option<Frame>> {
        match self {
            Self::Desktop(source) => source.next_frame_with(timeout_ms, observer),
            Self::Pattern(source) => source.next_frame_with(timeout_ms, observer),
        }
    }
}

impl Source for PassSource {
    fn next_frame(&mut self, timeout_ms: u32) -> anyhow::Result<Option<Frame>> {
        self.next_frame_with(timeout_ms, &mut |_| {})
    }

    fn size(&self) -> (u32, u32) {
        match self {
            Self::Desktop(source) => source.size(),
            Self::Pattern(source) => source.size(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> Vec<u8> {
        vec![0u8; W * H * 4]
    }

    #[test]
    fn every_frame_carries_its_own_number() {
        let painter = Painter::default();
        let mut pixels = blank();
        for frame in [0u64, 1, 2, 59, 60, 1234, 0xdead_beef] {
            painter.paint(frame, &mut pixels);
            assert_eq!(counter(&pixels), frame);
        }
    }

    #[test]
    fn the_pattern_is_deterministic_and_moves() {
        let (painter, other) = (Painter::default(), Painter::default());
        let (mut a, mut b, mut c) = (blank(), blank(), blank());
        painter.paint(7, &mut a);
        other.paint(7, &mut b);
        painter.paint(8, &mut c);
        assert_eq!(a, b, "the same frame twice is the same picture");
        // below the counter, so the counter's own change is not what differs
        let body = W * BIT_SIZE * 4..;
        assert_ne!(a[body.clone()], c[body], "the next frame moved");
        assert!(
            a.as_chunks::<4>().0.iter().all(|pixel| pixel[3] == 0xff),
            "opaque"
        );
    }

    #[test]
    fn the_pattern_output_is_the_primary_and_named_so_a_pass_finds_it() {
        let output = output();
        assert_eq!((output.desktop_rect.left, output.desktop_rect.top), (0, 0));
        assert_eq!(output.desktop_rect.width() as u32, WIDTH);
        assert_eq!(output.desktop_rect.height() as u32, HEIGHT);
        assert_eq!(output.device_name, DEVICE_NAME);
    }

    /// A d3d11 device always exists — WARP when there is no GPU — so this is
    /// not ignored.
    #[test]
    fn frames_arrive_at_sixty_hertz_on_a_texture_of_the_pattern_size() {
        let mut source = PassSource::open(&output(), RebuildSignal::new()).expect("a device");
        assert!(matches!(source, PassSource::Pattern(_)));
        assert!(!source.take_idr_request());
        let started = Instant::now();
        let mut frames = 0;
        while frames < 30 {
            if let Some(frame) = source
                .next_frame_with(8, &mut |_| {})
                .expect("a frame or a wait")
            {
                assert_eq!((frame.width, frame.height), (WIDTH, HEIGHT));
                frames += 1;
            }
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(470) && elapsed < Duration::from_millis(900),
            "30 frames at 60 Hz took {elapsed:?}"
        );
        assert_eq!(source.size(), (WIDTH, HEIGHT));
    }
}
