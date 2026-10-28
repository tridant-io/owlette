//! Downscale a captured frame on macOS: a `VTPixelTransferSession` into a pool
//! of `420v` IOSurface buffers at the target size.
//!
//! The macOS half of the seam `gpu::scale::Downscaler` fills on Windows (the
//! plan's context.md, "the seam"): the same `open`, `target` and `scale`, and a
//! [`ScaleError`] with `exit()` and `Display`, for `platform::macos` to export
//! under the seam's names. The sizing policy is `gpu::scale::plan`, which is
//! portable; only the execution differs.
//!
//! Everything stays NV12 (`420v`, what ScreenCaptureKit hands out and what the
//! encoder's source attributes name), so the transfer is a scale and never a
//! format conversion. The pool's buffers are IOSurface-backed because that is
//! what lets VideoToolbox's encoder read them without a copy.
//!
//! # Hardware test
//!
//! ```text
//! cargo test --no-default-features --features encode-videotoolbox --lib -- --ignored videotoolbox --test-threads=1 --nocapture
//! ```
//!
//! (working directory `agent/swoop`, on a Mac; it needs no privacy grant.) Beside
//! the encoder's tests it runs `videotoolbox_transfer_halves_a_two_tone_pattern`,
//! which scales a two-tone 256x128 buffer to 128x64 and asserts each half kept
//! its side and its colour, so a mirrored or transposed transfer fails it. It
//! prints `videotoolbox transfer: 256x128 -> 128x64`.

use std::ptr::{self, NonNull};

use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_video::{
    kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey,
    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, CVPixelBuffer, CVPixelBufferPool,
};
use objc2_video_toolbox::{
    kVTPixelTransferPropertyKey_RealTime, VTPixelTransferSession, VTSessionSetProperty,
};
use thiserror::Error;

use crate::gpu::Frame;
use crate::ipc::Exit;

/// Everything that stops a frame being downscaled.
#[derive(Debug, Error)]
pub enum ScaleError {
    #[error("frame carries no pixel buffer")]
    NoPixelBuffer,
    #[error("frame is {got:?}, the scaler was opened for {want:?}")]
    SourceSizeChanged { got: (u32, u32), want: (u32, u32) },
    #[error("{call} failed: status {status}")]
    Vt { call: &'static str, status: i32 },
}

impl ScaleError {
    /// A scaler that cannot run leaves the session with no encodable frame,
    /// which is the encoder's exit code whichever call reported it.
    pub const fn exit(&self) -> Exit {
        Exit::NoEncoder
    }
}

fn check(status: i32, call: &'static str) -> Result<(), ScaleError> {
    if status == 0 {
        Ok(())
    } else {
        Err(ScaleError::Vt { call, status })
    }
}

/// Borrow a frame's pixel buffer. `None` for a frame with no handle.
pub(crate) fn pixel_buffer(frame: &Frame) -> Option<&CVPixelBuffer> {
    // SAFETY: on macOS a frame's handle is a CVPixelBuffer its producer holds
    // retained for at least as long as the frame is used (gpu::Frame), and
    // Frame does not transfer that reference.
    unsafe { (frame.handle as *const CVPixelBuffer).as_ref() }
}

/// The attributes of a `420v` IOSurface-backed buffer of one size: this pool's
/// and the encoder's source attributes both.
pub(crate) fn nv12_attributes(
    width: u32,
    height: u32,
) -> CFRetained<CFDictionary<CFString, CFType>> {
    let format = CFNumber::new_i64(i64::from(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange));
    let width = CFNumber::new_i64(i64::from(width));
    let height = CFNumber::new_i64(i64::from(height));
    // empty: IOSurface backing with the system's defaults
    let iosurface = CFDictionary::<CFString, CFType>::empty();
    // SAFETY: CoreVideo's keys are immutable statics.
    let keys: [&CFString; 4] = unsafe {
        [
            kCVPixelBufferPixelFormatTypeKey,
            kCVPixelBufferWidthKey,
            kCVPixelBufferHeightKey,
            kCVPixelBufferIOSurfacePropertiesKey,
        ]
    };
    let values: [&CFType; 4] = [&format, &width, &height, &iosurface];
    CFDictionary::from_slices(&keys, &values)
}

/// A VideoToolbox scaler for one source size and one target size.
pub struct PixelTransfer {
    session: CFRetained<VTPixelTransferSession>,
    pool: CFRetained<CVPixelBufferPool>,
    /// The last scaled picture, held so its handle stays valid until the next
    /// `scale` replaces it, which hands it back to the pool unless the encoder
    /// still holds it.
    output: Option<CFRetained<CVPixelBuffer>>,
    source: (u32, u32),
    target: (u32, u32),
}

// SAFETY: the transfer session and the pool are thread-safe CoreFoundation
// objects, and the streamer owns the scaler on the capture thread and keeps it
// there. Nothing inside is shared, which is why this is Send and not Sync.
unsafe impl Send for PixelTransfer {}

impl PixelTransfer {
    /// Open a scaler for `frame`'s size, producing `width`x`height` NV12
    /// frames.
    pub fn open(frame: &Frame, width: u32, height: u32) -> Result<Self, ScaleError> {
        pixel_buffer(frame).ok_or(ScaleError::NoPixelBuffer)?;

        let mut session: *mut VTPixelTransferSession = ptr::null_mut();
        // SAFETY: the out pointer is a local the call writes once.
        check(
            unsafe { VTPixelTransferSession::create(None, NonNull::from(&mut session)) },
            "VTPixelTransferSessionCreate",
        )?;
        let session = NonNull::new(session).ok_or(ScaleError::Vt {
            call: "VTPixelTransferSessionCreate",
            status: 0,
        })?;
        // SAFETY: a create call hands back a +1 reference, owned from here.
        let session = unsafe { CFRetained::from_raw(session) };
        // Latency over picture quality: this is a live stream.
        // SAFETY: the key is an immutable static and the value a boolean.
        check(
            unsafe {
                VTSessionSetProperty(
                    &session,
                    kVTPixelTransferPropertyKey_RealTime,
                    Some(CFBoolean::new(true)),
                )
            },
            "VTSessionSetProperty(RealTime)",
        )?;

        let attributes = nv12_attributes(width, height);
        let mut pool: *mut CVPixelBufferPool = ptr::null_mut();
        // SAFETY: the attributes outlive the call and the out pointer is a
        // local the call writes once.
        check(
            unsafe {
                CVPixelBufferPool::create(
                    None,
                    None,
                    Some(attributes.as_opaque()),
                    NonNull::from(&mut pool),
                )
            },
            "CVPixelBufferPoolCreate",
        )?;
        let pool = NonNull::new(pool).ok_or(ScaleError::Vt {
            call: "CVPixelBufferPoolCreate",
            status: 0,
        })?;
        // SAFETY: as above, a +1 reference.
        let pool = unsafe { CFRetained::from_raw(pool) };

        Ok(Self {
            session,
            pool,
            output: None,
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
    /// The returned `Frame`'s handle is a buffer this scaler holds: valid until
    /// the next `scale` call, exactly like the frame a capture source hands
    /// out.
    pub fn scale(&mut self, frame: &Frame) -> Result<Frame, ScaleError> {
        if (frame.width, frame.height) != self.source {
            return Err(ScaleError::SourceSizeChanged {
                got: (frame.width, frame.height),
                want: self.source,
            });
        }
        let source = pixel_buffer(frame).ok_or(ScaleError::NoPixelBuffer)?;

        let mut output: *mut CVPixelBuffer = ptr::null_mut();
        // SAFETY: the pool is alive and the out pointer is a local the call
        // writes once.
        check(
            unsafe {
                CVPixelBufferPool::create_pixel_buffer(None, &self.pool, NonNull::from(&mut output))
            },
            "CVPixelBufferPoolCreatePixelBuffer",
        )?;
        let output = NonNull::new(output).ok_or(ScaleError::Vt {
            call: "CVPixelBufferPoolCreatePixelBuffer",
            status: 0,
        })?;
        // SAFETY: a create call hands back a +1 reference, owned from here.
        let output = unsafe { CFRetained::from_raw(output) };
        // SAFETY: both buffers are alive for the call.
        check(
            unsafe { self.session.transfer_image(source, &output) },
            "VTPixelTransferSessionTransferImage",
        )?;

        let handle = CFRetained::as_ptr(&output).as_ptr() as usize;
        self.output = Some(output);
        Ok(Frame {
            handle,
            width: self.target.0,
            height: self.target.1,
            captured_qpc: frame.captured_qpc,
        })
    }
}

impl Drop for PixelTransfer {
    fn drop(&mut self) {
        // SAFETY: the session is alive; invalidating it is the documented
        // teardown before the last release.
        unsafe { self.session.invalidate() };
    }
}

/// `420v` buffers for tests: made from a pattern, and read back.
#[cfg(test)]
pub(crate) mod testing {
    use std::ptr::{self, NonNull};

    use objc2_core_foundation::CFRetained;
    use objc2_core_video::{
        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, CVPixelBuffer, CVPixelBufferCreate,
        CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane,
        CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
        CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
    };

    use super::nv12_attributes;
    use crate::gpu::Frame;

    /// A `420v` IOSurface buffer: luma from `luma(x, y)`, and chroma at half
    /// resolution from `chroma(x, y)` as (cb, cr).
    pub fn nv12(
        width: u32,
        height: u32,
        luma: impl Fn(u32, u32) -> u8,
        chroma: impl Fn(u32, u32) -> (u8, u8),
    ) -> CFRetained<CVPixelBuffer> {
        let attributes = nv12_attributes(width, height);
        let mut buffer: *mut CVPixelBuffer = ptr::null_mut();
        // SAFETY: the attributes outlive the call; the out pointer is a local.
        let status = unsafe {
            CVPixelBufferCreate(
                None,
                width as usize,
                height as usize,
                kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                Some(attributes.as_opaque()),
                NonNull::from(&mut buffer),
            )
        };
        assert_eq!(status, 0, "CVPixelBufferCreate");
        // SAFETY: a +1 reference from a create call.
        let buffer = unsafe { CFRetained::from_raw(NonNull::new(buffer).expect("a buffer")) };
        // SAFETY: locked for writing, written inside each plane's rows, unlocked.
        unsafe {
            assert_eq!(
                CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags(0)),
                0
            );
            let y = CVPixelBufferGetBaseAddressOfPlane(&buffer, 0).cast::<u8>();
            let y_stride = CVPixelBufferGetBytesPerRowOfPlane(&buffer, 0);
            for row in 0..height {
                for x in 0..width {
                    *y.add(row as usize * y_stride + x as usize) = luma(x, row);
                }
            }
            let uv = CVPixelBufferGetBaseAddressOfPlane(&buffer, 1).cast::<u8>();
            let uv_stride = CVPixelBufferGetBytesPerRowOfPlane(&buffer, 1);
            for row in 0..height / 2 {
                for x in 0..width / 2 {
                    let (cb, cr) = chroma(x, row);
                    let at = uv.add(row as usize * uv_stride + x as usize * 2);
                    *at = cb;
                    *at.add(1) = cr;
                }
            }
            assert_eq!(
                CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0)),
                0
            );
        }
        buffer
    }

    /// Luma and interleaved chroma, each with its padding stripped.
    pub fn planes(buffer: &CVPixelBuffer) -> (Vec<u8>, Vec<u8>) {
        let width = CVPixelBufferGetWidth(buffer);
        let height = CVPixelBufferGetHeight(buffer);
        let mut luma = Vec::with_capacity(width * height);
        let mut chroma = Vec::with_capacity(width * height / 2);
        // SAFETY: locked read-only, read inside each plane's rows, unlocked.
        unsafe {
            assert_eq!(
                CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly),
                0
            );
            let y = CVPixelBufferGetBaseAddressOfPlane(buffer, 0).cast::<u8>();
            let y_stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0);
            for row in 0..height {
                luma.extend_from_slice(std::slice::from_raw_parts(y.add(row * y_stride), width));
            }
            let uv = CVPixelBufferGetBaseAddressOfPlane(buffer, 1).cast::<u8>();
            let uv_stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1);
            for row in 0..height / 2 {
                chroma
                    .extend_from_slice(std::slice::from_raw_parts(uv.add(row * uv_stride), width));
            }
            assert_eq!(
                CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly),
                0
            );
        }
        (luma, chroma)
    }

    /// A frame borrowing `buffer`, which the caller keeps alive.
    pub fn frame(buffer: &CFRetained<CVPixelBuffer>, captured_qpc: i64) -> Frame {
        Frame {
            handle: CFRetained::as_ptr(buffer).as_ptr() as usize,
            width: CVPixelBufferGetWidth(buffer) as u32,
            height: CVPixelBufferGetHeight(buffer) as u32,
            captured_qpc,
        }
    }
}

#[cfg(test)]
mod tests {
    use objc2_core_video::{
        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, CVPixelBufferGetPixelFormatType,
    };

    use super::testing::{frame, nv12, planes};
    use super::*;

    const SRC: (u32, u32) = (256, 128);
    const DST: (u32, u32) = (128, 64);

    #[test]
    fn every_scale_failure_exits_thirteen() {
        for error in [
            ScaleError::NoPixelBuffer,
            ScaleError::SourceSizeChanged {
                got: (1, 1),
                want: (2, 2),
            },
            ScaleError::Vt {
                call: "VTPixelTransferSessionTransferImage",
                status: -12902,
            },
        ] {
            assert_eq!(error.exit().code(), 13, "{error}");
        }
    }

    #[test]
    fn a_frame_with_no_buffer_is_refused_before_videotoolbox_is_asked() {
        let empty = Frame {
            handle: 0,
            width: 256,
            height: 128,
            captured_qpc: 0,
        };
        assert!(matches!(
            PixelTransfer::open(&empty, 128, 64),
            Err(ScaleError::NoPixelBuffer)
        ));
    }

    /// Needs VideoToolbox, no grant: the invocation is in the module doc.
    #[test]
    #[ignore = "needs videotoolbox"]
    fn videotoolbox_transfer_halves_a_two_tone_pattern() {
        // left: dark, blue-ish; right: light, red-ish. video range throughout.
        let source = nv12(
            SRC.0,
            SRC.1,
            |x, _| if x < SRC.0 / 2 { 40 } else { 200 },
            |x, _| if x < SRC.0 / 4 { (200, 60) } else { (60, 200) },
        );
        let captured = frame(&source, 1234);

        let mut transfer =
            PixelTransfer::open(&captured, DST.0, DST.1).expect("a transfer session");
        assert_eq!(transfer.target(), DST);
        let scaled = transfer.scale(&captured).expect("a scaled frame");
        assert_eq!((scaled.width, scaled.height), DST);
        assert_eq!(
            scaled.captured_qpc, captured.captured_qpc,
            "the timestamp rides along"
        );
        println!(
            "videotoolbox transfer: {}x{} -> {}x{}",
            SRC.0, SRC.1, scaled.width, scaled.height
        );

        let output = pixel_buffer(&scaled).expect("the scaled buffer");
        assert_eq!(
            CVPixelBufferGetPixelFormatType(output),
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        );
        let (luma, chroma) = planes(output);
        // well inside each half, so the filter's edge taps are not under test
        let y = |x: u32, row: u32| luma[(row * DST.0 + x) as usize];
        let uv = |x: u32, row: u32| {
            let at = (row * DST.0 + x * 2) as usize;
            (chroma[at], chroma[at + 1])
        };
        let near = |got: u8, want: u8| got.abs_diff(want) <= 2;
        assert!(near(y(16, 32), 40), "left luma stays dark: {}", y(16, 32));
        assert!(
            near(y(112, 32), 200),
            "right luma stays light: {}",
            y(112, 32)
        );
        let (cb, cr) = uv(8, 16);
        assert!(
            near(cb, 200) && near(cr, 60),
            "left chroma stays blue: {cb} {cr}"
        );
        let (cb, cr) = uv(56, 16);
        assert!(
            near(cb, 60) && near(cr, 200),
            "right chroma stays red: {cb} {cr}"
        );

        // the pool hands out the next buffer while this scaler still holds the
        // first
        let again = transfer.scale(&captured).expect("a second scaled frame");
        assert_eq!((again.width, again.height), DST);
    }
}
