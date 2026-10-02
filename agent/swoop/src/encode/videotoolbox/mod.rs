//! VideoToolbox, the macOS encoder backend (swoop-macos Task 4.2).
//!
//! Exposes `probe() -> BackendCaps` and `create(&EncoderConfig) ->
//! Result<Box<dyn Encoder>>` and nothing else, as every backend does. It is the
//! only rung of the macOS chain: the hardware encoder for each codec, and
//! Apple's software H.264 on a Mac whose encoder list has no H.264 hardware,
//! the no-GPU floor (decision 6). The software encoder is never a fallback for
//! a size the hardware refuses: that is a downscale or the other codec.
//!
//! # The configuration
//!
//! The capture hands NV12 (`420v`) IOSurface buffers, which the session takes
//! as they are, so no convert pass sits in front of it. A session tries
//! no `EnableLowLatencyRateControl` in its encoder specification first, and
//! with it only when the plain session cannot encode. On the session: `RealTime`, no
//! frame reordering, `MaxKeyFrameInterval` at the largest value the session
//! advertises (keyframes come only when the session forces one),
//! `AverageBitRate` with `DataRateLimits` over one frame interval,
//! `ExpectedFrameRate`, `MaxFrameDelayCount` 0,
//! `PrioritizeEncodingSpeedOverQuality`, and H.264 Main or HEVC Main at
//! automatic level. `AverageBitRate` is the one required property; any other
//! the session refuses is logged by name when it opens.
//!
//! Measured on the rig (MacBook Air, Apple silicon, macOS 26.6), 2026-09-30,
//! at 1920x1080 and 20 Mbps, 120 frames each:
//!
//! * both hardware encoders take low-latency rate control and refuse
//!   `MaxFrameDelayCount` and `PrioritizeEncodingSpeedOverQuality` under it
//!   (-12900, not supported); the software H.264 encoder refuses low-latency
//!   rate control (-12902) and `DataRateLimits` as well.
//! * `encode()` p50 / p95 over two runs, with other work sharing the Mac:
//!   H.264 8.5-9.2 / 9.3-10.6 ms, HEVC 9.3-10.5 / 9.9-11.2 ms, software H.264
//!   10.7-10.9 / 15.6-16.4 ms.
//! * the hardware H.264 SPS already declares `max_num_reorder_frames = 0`,
//!   with `max_dec_frame_buffering` 4, its reference count; the software
//!   encoder's does not, and what it sends is the rewrite.
//! * no session advertises a maximum for `MaxKeyFrameInterval`, so it is set
//!   to `i32::MAX`, which every session takes: the only keyframes are the first
//!   and the ones forced.
//! * a keyframe of the test's noisy pattern is about 820 KB against 17 KB
//!   deltas: the one-frame `DataRateLimits` does not starve it the way NVENC's
//!   one-frame VBV did before `KEYFRAME_VBV_SCALE`. Whether a keyframe that
//!   size costs visible latency on a real desktop is gate M1's to measure.
//!
//! # A session counts as open once it has encoded a frame
//!
//! Creating a session proves nothing about its size. On the rig an H.264
//! session opens at 8192x8192, and a low-latency one at 4096x2304, and both
//! fail their first frame (-12912, -12902); low-latency H.264 encodes up to
//! 4096x2160 and low-latency HEVC up to 8192x4320. So every session encodes
//! one warm-up frame from its own pixel buffer pool before it is handed out,
//! and one that cannot is closed and the next specification tried. `probe`
//! asks the same question, through the same path, at each candidate size from
//! the largest down, which is why its ceilings are sizes `create` can serve:
//! on the rig it takes 445-490 ms and answers HEVC 8192x8192 and H.264
//! 4096x4096, both served without low-latency rate control at that size. The
//! warm-up output is discarded and the first real frame is forced to a
//! keyframe.
//!
//! # Latency
//!
//! VideoToolbox is asynchronous, with its own queue. With a sink set
//! ([`Encoder::set_sink`], which the session does) `encode` only submits, and
//! the output callback assembles each frame and hands it to the sink on
//! VideoToolbox's thread: the next capture overlaps this encode, and reordering
//! off keeps callback order equal to input order. Without a sink `encode`
//! forces the frame out with `VTCompressionSessionCompleteFrames` and answers
//! it from the same call, which is what most tests use. The capture ticks
//! travel as the frame's reference value and the `encoded` ticks are read in
//! the output callback.
//!
//! Measured on the rig on 2026-10-01 at 3420x2214, HEVC hardware, 240 frames
//! submitted without completing each: with low-latency rate control the
//! encoder tops out at 48.6 fps, each submit blocks 20 ms and a frame takes
//! 100 ms from submit to callback; without it, 104 fps unpaced, and paced at
//! 60 Hz exactly 60.0 fps with none dropped and 11 ms p50 / 17 ms p95 from
//! submit to callback, at 20 and at 50 Mbps. That is why the plain session is
//! tried first.
//!
//! # The bitstream
//!
//! VideoToolbox writes length-prefixed NAL units and keeps the parameter sets
//! in the format description. Each frame is rewritten as Annex-B, with the
//! VPS, SPS and PPS in front of every IRAP; a frame is an IRAP when its sample
//! attachments do not say `NotSync`. The first H.264 SPS is checked for
//! `max_num_reorder_frames = 0`, and when it is missing every SPS is rewritten
//! to carry it (`encode::h264_sps`): without it Chrome's decoder holds a full
//! picture buffer, 208 ms against 8 ms (the swoop plan's D5).
//!
//! # Hardware test
//!
//! ```text
//! cargo test --no-default-features --features encode-videotoolbox --lib -- --ignored videotoolbox --test-threads=1 --nocapture
//! ```
//!
//! (working directory `agent/swoop`, on a Mac; synthetic buffers, so no privacy
//! grant.) It prints the probe and how long it took, then for H.264 and HEVC
//! in hardware and H.264 in software, at 1920x1080: the encoder the session
//! took, the properties it refused, the p50 and p95 of `encode()`, the keyframe
//! and delta sizes, and whether VideoToolbox's own SPS already declared the
//! restriction. It asserts the first frame is an IRAP carrying its parameter
//! sets, that the only other IRAP is the one forced at frame 90, and that the
//! H.264 SPS on the wire carries the restriction. One thread, so the codecs'
//! timings do not share the encoder. `videotoolbox_holds_60_at_the_panels_size_through_its_sink`
//! opens HEVC at the main display's pixel size, paces 240 frames at 60 Hz
//! through a sink, and asserts the rate and the latency above.

use std::ffi::c_void;
use std::fmt;
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType,
};
use objc2_core_media::{
    kCMSampleAttachmentKey_NotSync, kCMTimeInvalid, kCMVideoCodecType_H264, kCMVideoCodecType_HEVC,
    CMFormatDescription, CMSampleBuffer, CMTime,
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex,
    CMVideoFormatDescriptionGetHEVCParameterSetAtIndex,
};
use objc2_core_video::{CVPixelBuffer, CVPixelBufferPool};
use objc2_video_toolbox::{
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_AverageBitRate,
    kVTCompressionPropertyKey_DataRateLimits, kVTCompressionPropertyKey_ExpectedFrameRate,
    kVTCompressionPropertyKey_MaxFrameDelayCount, kVTCompressionPropertyKey_MaxKeyFrameInterval,
    kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
    kVTCompressionPropertyKey_ProfileLevel, kVTCompressionPropertyKey_RealTime,
    kVTEncodeFrameOptionKey_ForceKeyFrame, kVTProfileLevel_H264_Main_AutoLevel,
    kVTProfileLevel_HEVC_Main_AutoLevel, kVTPropertySupportedValueMaximumKey,
    kVTVideoEncoderList_CodecType, kVTVideoEncoderList_InstanceLimit,
    kVTVideoEncoderList_IsHardwareAccelerated,
    kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder,
    kVTVideoEncoderSpecification_EnableLowLatencyRateControl,
    kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder, VTCompressionSession,
    VTCopyVideoEncoderList, VTEncodeInfoFlags, VTSessionCopySupportedPropertyDictionary,
    VTSessionSetProperty,
};
use thiserror::Error;

use crate::encode::h264_sps;
use crate::encode::{BackendCaps, Codec, CodecCaps, EncodedFrame, Encoder, EncoderConfig, Sink};
use crate::gpu::vt_transfer::{nv12_attributes, pixel_buffer};
use crate::gpu::Frame;
use crate::ipc::Exit;
use crate::platform::clock;

/// The sizes `probe` tries, largest first; the first at which a session opens
/// and encodes a frame is the codec's ceiling. `VTCopyVideoEncoderList` says
/// which codecs exist and nothing about sizes.
const PROBE_SIZES: [(u32, u32); 4] = [(4096, 2304), (4096, 4096), (7680, 4320), (8192, 8192)];

/// The session budget when the encoder list carries no instance limit.
const DEFAULT_SESSIONS: u32 = 4;

/// Presentation times are the platform clock's nanoseconds.
const NANOS: i32 = 1_000_000_000;

const START_CODE: [u8; 4] = [0, 0, 0, 1];

/// Everything that stops this backend encoding. Every variant means the same
/// thing to the process, this machine cannot encode, so they all exit 13.
#[derive(Debug, Error)]
pub enum VtError {
    #[error("no {codec:?} encoder on this mac")]
    NoEncoder { codec: Codec },
    #[error("{call} failed: status {status}")]
    Api { call: &'static str, status: i32 },
    #[error(
        "frame is {got_width}x{got_height}, the encoder was opened for {want_width}x{want_height}"
    )]
    SizeChanged {
        got_width: u32,
        got_height: u32,
        want_width: u32,
        want_height: u32,
    },
    #[error("frame carries no pixel buffer")]
    NoPixelBuffer,
    #[error("the encoder's output is malformed: {0}")]
    Malformed(&'static str),
}

impl VtError {
    /// The process exit code this failure maps to.
    pub const fn exit(&self) -> Exit {
        Exit::NoEncoder
    }
}

fn check(status: i32, call: &'static str) -> Result<(), VtError> {
    if status == 0 {
        Ok(())
    } else {
        Err(VtError::Api { call, status })
    }
}

const fn codec_type(codec: Codec) -> u32 {
    match codec {
        Codec::H264 => kCMVideoCodecType_H264,
        Codec::H265 => kCMVideoCodecType_HEVC,
    }
}

// ------------------------------------------------------------------ probe ---

/// One row of `VTCopyVideoEncoderList`, as far as this backend reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Listed {
    codec_type: u32,
    hardware: bool,
    instance_limit: Option<u32>,
}

/// Whether `codec` is served here, and by what: `Some((hardware, instance
/// limits))`, where hardware is used when the list has it, and only H.264
/// falls to the software encoder when it does not.
fn usable(listed: &[Listed], codec: Codec) -> Option<(bool, Vec<u32>)> {
    let rows = listed.iter().filter(|l| l.codec_type == codec_type(codec));
    let hardware = rows.clone().any(|l| l.hardware);
    if !hardware && codec != Codec::H264 {
        return None;
    }
    let mut serving = rows.filter(|l| l.hardware == hardware).peekable();
    serving.peek()?;
    Some((hardware, serving.filter_map(|l| l.instance_limit).collect()))
}

/// The encoder list, read once: it does not change under a running streamer.
fn listed() -> &'static [Listed] {
    static LIST: OnceLock<Vec<Listed>> = OnceLock::new();
    LIST.get_or_init(encoder_list)
}

/// What VideoToolbox can do on this Mac, found once and kept for the life of
/// the process: the size probe opens and encodes on real sessions.
pub fn probe() -> BackendCaps {
    static CAPS: OnceLock<BackendCaps> = OnceLock::new();
    CAPS.get_or_init(probe_uncached).clone()
}

fn probe_uncached() -> BackendCaps {
    let mut caps = BackendCaps {
        backend: "videotoolbox",
        codecs: Vec::new(),
        // In the sense the selector reads it: nothing converts in front of this
        // encoder. The capture already hands NV12, which is what it takes.
        accepts_bgra_texture: true,
        // VideoToolbox reports no throughput, and probe does not benchmark: it
        // can run beside a live session. Nothing selects on this (select.rs).
        max_fps: 0,
        concurrent_sessions: 0,
    };
    let mut limits = Vec::new();
    for codec in [Codec::H265, Codec::H264] {
        let Some((hardware, codec_limits)) = usable(listed(), codec) else {
            continue;
        };
        let serves = |&(width, height): &(u32, u32)| {
            let cfg = EncoderConfig {
                codec,
                width,
                height,
                fps: 60,
                bitrate_bps: 20_000_000,
            };
            VtEncoder::open_on(&cfg, hardware).is_ok()
        };
        let Some((max_width, max_height)) = PROBE_SIZES.iter().rev().copied().find(serves) else {
            continue;
        };
        caps.codecs.push(CodecCaps {
            codec,
            max_width,
            max_height,
        });
        limits.extend(codec_limits);
    }
    if !caps.codecs.is_empty() {
        caps.concurrent_sessions = limits.into_iter().min().unwrap_or(DEFAULT_SESSIONS);
    }
    caps
}

fn encoder_list() -> Vec<Listed> {
    let mut list: *const CFArray = ptr::null();
    // SAFETY: no options; the out pointer is a local the call writes once.
    if unsafe { VTCopyVideoEncoderList(None, NonNull::from(&mut list)) } != 0 {
        return Vec::new();
    }
    let Some(list) = NonNull::new(list.cast_mut()) else {
        return Vec::new();
    };
    // SAFETY: a copy call hands back a +1 reference, owned from here.
    let list = unsafe { CFRetained::from_raw(list) };
    // SAFETY: the list is an array of dictionaries keyed by string.
    let rows = unsafe { list.cast_unchecked::<CFDictionary>() };
    // SAFETY: the keys are immutable statics.
    let (codec_key, hardware_key, limit_key) = unsafe {
        (
            kVTVideoEncoderList_CodecType,
            kVTVideoEncoderList_IsHardwareAccelerated,
            kVTVideoEncoderList_InstanceLimit,
        )
    };
    rows.iter()
        .filter_map(|row| {
            // SAFETY: as above.
            let row = unsafe { row.cast_unchecked::<CFString, CFType>() };
            Some(Listed {
                codec_type: u32::try_from(number(row, codec_key)?).ok()?,
                hardware: boolean(row, hardware_key),
                instance_limit: number(row, limit_key)
                    .and_then(|n| u32::try_from(n).ok())
                    .filter(|&n| n > 0),
            })
        })
        .collect()
}

fn number(dict: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<i64> {
    dict.get(key)?.downcast::<CFNumber>().ok()?.as_i64()
}

fn boolean(dict: &CFDictionary<CFString, CFType>, key: &CFString) -> bool {
    dict.get(key)
        .and_then(|value| value.downcast::<CFBoolean>().ok())
        .is_some_and(|value| value.as_bool())
}

// ---------------------------------------------------------------- session ---

/// A compression session, invalidated when dropped so no output callback can
/// outlive what its refcon points at.
struct Session(CFRetained<VTCompressionSession>);

impl Drop for Session {
    fn drop(&mut self) {
        // SAFETY: the session is alive; invalidating it is the documented
        // teardown, and it returns only once no callback is running.
        unsafe { self.0.invalidate() };
    }
}

fn encoder_specification(
    hardware: bool,
    low_latency: bool,
) -> CFRetained<CFDictionary<CFString, CFType>> {
    // SAFETY: the keys are immutable statics.
    let (require, enable, low) = unsafe {
        (
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder,
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder,
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl,
        )
    };
    let mut keys: Vec<&CFString> = Vec::new();
    let mut values: Vec<&CFType> = Vec::new();
    if hardware {
        keys.push(require);
        values.push(CFBoolean::new(true));
    } else {
        keys.push(enable);
        values.push(CFBoolean::new(false));
    }
    if low_latency {
        keys.push(low);
        values.push(CFBoolean::new(true));
    }
    CFDictionary::from_slices(&keys, &values)
}

/// Create a session for `cfg` on one encoder specification. `refcon` is what
/// the output callback receives.
fn create_session(
    cfg: &EncoderConfig,
    hardware: bool,
    low_latency: bool,
    refcon: *mut c_void,
) -> Result<Session, VtError> {
    let source = nv12_attributes(cfg.width, cfg.height);
    let specification = encoder_specification(hardware, low_latency);
    let mut session: *mut VTCompressionSession = ptr::null_mut();
    // SAFETY: the dictionaries outlive the call, the callback matches the
    // declared signature, and the out pointer is a local the call writes once.
    let status = unsafe {
        VTCompressionSession::create(
            None,
            cfg.width as i32,
            cfg.height as i32,
            codec_type(cfg.codec),
            Some(specification.as_opaque()),
            Some(source.as_opaque()),
            None,
            Some(on_output),
            refcon,
            NonNull::from(&mut session),
        )
    };
    check(status, "VTCompressionSessionCreate")?;
    let session = NonNull::new(session).ok_or(VtError::Api {
        call: "VTCompressionSessionCreate",
        status,
    })?;
    // SAFETY: a create call hands back a +1 reference, owned from here.
    Ok(Session(unsafe { CFRetained::from_raw(session) }))
}

fn set(session: &VTCompressionSession, key: &CFString, value: &CFType) -> i32 {
    // SAFETY: the session is alive, the key an immutable static and the value
    // a CoreFoundation object of the type the key takes.
    unsafe { VTSessionSetProperty(session, key, Some(value)) }
}

/// One frame interval of the target rate, as `DataRateLimits` wants it: bytes,
/// then seconds.
fn rate_window(bitrate_bps: u32, fps: u32) -> (i64, f64) {
    let fps = fps.max(1);
    (
        i64::from(bitrate_bps) / 8 / i64::from(fps),
        1.0 / f64::from(fps),
    )
}

/// Move the target rate: `AverageBitRate`, which is required, and when
/// `window` says the session takes it, `DataRateLimits` with it, because a
/// window sized for the old rate would clamp the new one. Answers the window's
/// status.
fn set_rate(
    session: &VTCompressionSession,
    bitrate_bps: u32,
    fps: u32,
    window: bool,
) -> Result<i32, VtError> {
    // SAFETY: the keys are immutable statics.
    let (average, limits) = unsafe {
        (
            kVTCompressionPropertyKey_AverageBitRate,
            kVTCompressionPropertyKey_DataRateLimits,
        )
    };
    check(
        set(session, average, &CFNumber::new_i64(i64::from(bitrate_bps))),
        "VTSessionSetProperty(AverageBitRate)",
    )?;
    if !window {
        return Ok(0);
    }
    let (bytes, seconds) = rate_window(bitrate_bps, fps);
    let pair =
        CFArray::from_retained_objects(&[CFNumber::new_i64(bytes), CFNumber::new_f64(seconds)]);
    Ok(set(session, limits, &pair))
}

/// The largest value the session advertises for `key`, if it advertises one.
fn supported_maximum(session: &VTCompressionSession, key: &CFString) -> Option<i64> {
    let mut supported: *const CFDictionary = ptr::null();
    // SAFETY: the session is alive and the out pointer is a local.
    if unsafe { VTSessionCopySupportedPropertyDictionary(session, NonNull::from(&mut supported)) }
        != 0
    {
        return None;
    }
    // SAFETY: a copy call hands back a +1 reference, owned from here.
    let supported = unsafe { CFRetained::from_raw(NonNull::new(supported.cast_mut())?) };
    // SAFETY: property key -> the property's description, keyed by string.
    let entry = unsafe { supported.cast_unchecked::<CFString, CFDictionary>() }.get(key)?;
    // SAFETY: as above; the key is an immutable static.
    let (entry, maximum) = unsafe {
        (
            entry.cast_unchecked::<CFString, CFType>(),
            kVTPropertySupportedValueMaximumKey,
        )
    };
    number(entry, maximum)
}

/// Every property this backend sets on a new session. Returns the ones the
/// session refused, by name and status; only `AverageBitRate` is required.
fn configure(
    session: &VTCompressionSession,
    cfg: &EncoderConfig,
) -> Result<Vec<(&'static str, i32)>, VtError> {
    // SAFETY: the keys and profile names are immutable statics.
    let (real_time, reordering, key_interval, frame_rate, delay, speed, profile_key, profile) = unsafe {
        (
            kVTCompressionPropertyKey_RealTime,
            kVTCompressionPropertyKey_AllowFrameReordering,
            kVTCompressionPropertyKey_MaxKeyFrameInterval,
            kVTCompressionPropertyKey_ExpectedFrameRate,
            kVTCompressionPropertyKey_MaxFrameDelayCount,
            kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
            kVTCompressionPropertyKey_ProfileLevel,
            match cfg.codec {
                Codec::H264 => kVTProfileLevel_H264_Main_AutoLevel,
                Codec::H265 => kVTProfileLevel_HEVC_Main_AutoLevel,
            },
        )
    };
    // The session forces every keyframe it wants, so the encoder's own
    // interval goes as far as it will: a timer keyframe on a still desktop is a
    // spike of bits nobody asked for.
    let interval = CFNumber::new_i32(
        supported_maximum(session, key_interval)
            .and_then(|max| i32::try_from(max).ok())
            .unwrap_or(i32::MAX),
    );
    let fps = CFNumber::new_i64(i64::from(cfg.fps));
    let zero = CFNumber::new_i32(0);
    let properties: [(&'static str, &CFString, &CFType); 7] = [
        ("RealTime", real_time, CFBoolean::new(true)),
        ("AllowFrameReordering", reordering, CFBoolean::new(false)),
        ("MaxKeyFrameInterval", key_interval, &interval),
        ("ExpectedFrameRate", frame_rate, &fps),
        ("MaxFrameDelayCount", delay, &zero),
        (
            "PrioritizeEncodingSpeedOverQuality",
            speed,
            CFBoolean::new(true),
        ),
        ("ProfileLevel", profile_key, profile),
    ];
    let mut refused: Vec<(&'static str, i32)> = properties
        .into_iter()
        .filter_map(|(name, key, value)| {
            let status = set(session, key, value);
            (status != 0).then_some((name, status))
        })
        .collect();
    let window = set_rate(session, cfg.bitrate_bps, cfg.fps, true)?;
    if window != 0 {
        refused.push(("DataRateLimits", window));
    }
    Ok(refused)
}

/// Encode one frame from the session's own pool and throw the result away:
/// the only proof that this session can encode at its size. Answers the
/// presentation time it used, a second in the past, so the first real frame
/// comes a whole rate window after it.
fn warm_up(session: &VTCompressionSession, shared: &Shared) -> Result<i64, VtError> {
    // SAFETY: the session is alive.
    let pool = unsafe { session.pixel_buffer_pool() }
        .ok_or(VtError::Malformed("the session has no pixel buffer pool"))?;
    let mut buffer: *mut CVPixelBuffer = ptr::null_mut();
    // SAFETY: the pool is alive and the out pointer is a local.
    let status =
        unsafe { CVPixelBufferPool::create_pixel_buffer(None, &pool, NonNull::from(&mut buffer)) };
    check(status, "CVPixelBufferPoolCreatePixelBuffer")?;
    let buffer = NonNull::new(buffer).ok_or(VtError::Api {
        call: "CVPixelBufferPoolCreatePixelBuffer",
        status,
    })?;
    // SAFETY: a create call hands back a +1 reference, owned from here.
    let buffer = unsafe { CFRetained::from_raw(buffer) };
    let pts = clock::now_ticks() - i64::from(NANOS);
    // SAFETY: plain value constructors; kCMTimeInvalid is an immutable static.
    let (time, duration) = unsafe { (CMTime::new(pts, NANOS), kCMTimeInvalid) };
    let mut flags = VTEncodeInfoFlags(0);
    // SAFETY: the buffer and the session are alive for the calls.
    unsafe {
        check(
            session.encode_frame(&buffer, time, duration, None, ptr::null_mut(), &mut flags),
            "VTCompressionSessionEncodeFrame",
        )?;
        check(
            session.complete_frames(time),
            "VTCompressionSessionCompleteFrames",
        )?;
    }
    match shared.take()?.pop() {
        Some(Output::Frame(_)) => Ok(pts),
        Some(Output::Failed(e)) => Err(e),
        Some(Output::Dropped) | None => {
            Err(VtError::Malformed("the warm-up frame came back empty"))
        }
    }
}

// ----------------------------------------------------------------- output ---

/// What the output callback hands to the sink, on its own thread, or back to
/// `encode` on the thread that submitted the frame.
struct Shared {
    codec: Codec,
    width: u32,
    height: u32,
    outputs: Mutex<Vec<Output>>,
    /// The Annex-B state, reached from the callback and from `encode`.
    assembly: Mutex<Assembly>,
    sink: Mutex<Option<Sink>>,
    /// The next submit is forced to a keyframe: after the warm-up, and after
    /// the callback dropped a frame or the sink refused one, so the hole
    /// cannot dangle.
    key_due: AtomicBool,
    /// A failure the callback saw with a sink set; the next `encode` answers
    /// it, since nothing else on that thread can.
    failed: Mutex<Option<VtError>>,
}

struct Assembly {
    frame_id: u64,
    sps_fix: SpsFix,
}

impl Shared {
    /// Everything the callback has delivered since the last call.
    fn take(&self) -> Result<Vec<Output>, VtError> {
        self.outputs
            .lock()
            .map(|mut outputs| std::mem::take(&mut *outputs))
            .map_err(|_| VtError::Malformed("the output queue is poisoned"))
    }

    fn has_sink(&self) -> bool {
        self.sink.lock().is_ok_and(|sink| sink.is_some())
    }

    /// Annex-B for one frame, parameter sets first, every H.264 SPS through
    /// the restriction check, numbered in the order frames come back.
    fn assemble(&self, raw: &Raw) -> Result<EncodedFrame, VtError> {
        let mut assembly = self
            .assembly
            .lock()
            .map_err(|_| VtError::Malformed("the assembly is poisoned"))?;
        let units = length_prefixed(&raw.payload, raw.length_size)?;
        let mut out = Vec::with_capacity(raw.payload.len() + 256);
        for nal in raw.parameter_sets.iter().map(Vec::as_slice).chain(units) {
            out.extend_from_slice(&START_CODE);
            let is_sps = self.codec == Codec::H264
                && nal
                    .first()
                    .is_some_and(|header| header & 0x1f == h264_sps::NAL_SPS);
            match is_sps.then(|| assembly.sps_fix.apply(nal)).flatten() {
                Some(fixed) => out.extend_from_slice(&fixed),
                None => out.extend_from_slice(nal),
            }
        }
        let frame_id = assembly.frame_id;
        assembly.frame_id += 1;
        Ok(EncodedFrame {
            data: out,
            is_irap: raw.irap,
            codec: self.codec,
            width: self.width,
            height: self.height,
            frame_id,
            captured_qpc: raw.captured,
            encoded_qpc: raw.encoded,
        })
    }

    /// One output through the sink, from the callback's thread. A dropped
    /// frame and a refused one both leave a hole, so the next submit is forced
    /// to a keyframe; a failure waits for the next `encode` to answer it.
    fn deliver(&self, sink: &Sink, output: Output) {
        match output {
            Output::Frame(raw) => match self.assemble(&raw) {
                Ok(frame) => {
                    if !sink(frame) {
                        self.key_due.store(true, Ordering::SeqCst);
                    }
                }
                Err(e) => self.fail(e),
            },
            Output::Dropped => {
                ::log::debug!("swoop: videotoolbox dropped a frame");
                self.key_due.store(true, Ordering::SeqCst);
            }
            Output::Failed(e) => self.fail(e),
        }
    }

    fn fail(&self, e: VtError) {
        if let Ok(mut failed) = self.failed.lock() {
            failed.get_or_insert(e);
        }
    }
}

enum Output {
    Frame(Raw),
    Dropped,
    Failed(VtError),
}

/// One frame as VideoToolbox emitted it, before it is Annex-B.
struct Raw {
    /// Length-prefixed NAL units.
    payload: Vec<u8>,
    length_size: usize,
    /// VPS, SPS and PPS from the format description; empty unless `irap`.
    parameter_sets: Vec<Vec<u8>>,
    irap: bool,
    captured: i64,
    encoded: i64,
}

unsafe extern "C-unwind" fn on_output(
    refcon: *mut c_void,
    frame_refcon: *mut c_void,
    status: i32,
    flags: VTEncodeInfoFlags,
    sample: *mut CMSampleBuffer,
) {
    let encoded = clock::now_ticks();
    // SAFETY: the refcon is the encoder's boxed `Shared`, which outlives the
    // session: the session is invalidated before it is freed.
    let Some(shared) = (unsafe { refcon.cast::<Shared>().as_ref() }) else {
        return;
    };
    let output = if status != 0 {
        Output::Failed(VtError::Api {
            call: "the output callback",
            status,
        })
    } else if flags.contains(VTEncodeInfoFlags::FrameDropped) {
        Output::Dropped
    } else {
        // SAFETY: null or a sample buffer VideoToolbox keeps alive for the call.
        match unsafe { sample.as_ref() } {
            Some(sample) => read_sample(sample, shared.codec, frame_refcon.addr() as i64, encoded),
            None => Output::Dropped,
        }
    };
    let queued = match shared.sink.lock() {
        Ok(sink) => match sink.as_ref() {
            Some(sink) => {
                shared.deliver(sink, output);
                None
            }
            None => Some(output),
        },
        Err(_) => Some(output),
    };
    if let Some(output) = queued {
        if let Ok(mut outputs) = shared.outputs.lock() {
            outputs.push(output);
        }
    }
}

fn read_sample(sample: &CMSampleBuffer, codec: Codec, captured: i64, encoded: i64) -> Output {
    let irap = is_sync(sample);
    // SAFETY: the sample buffer is alive for the call.
    let Some(description) = (unsafe { sample.format_description() }) else {
        return Output::Failed(VtError::Malformed("no format description"));
    };
    let (length_size, parameter_sets) = match parameter_sets(&description, codec, irap) {
        Ok(read) => read,
        Err(e) => return Output::Failed(e),
    };
    // SAFETY: as above.
    let Some(block) = (unsafe { sample.data_buffer() }) else {
        return Output::Failed(VtError::Malformed("no data buffer"));
    };
    // SAFETY: the block buffer is alive for the calls.
    let length = unsafe { block.data_length() };
    let mut payload = vec![0u8; length];
    if let Some(destination) = NonNull::new(payload.as_mut_ptr().cast::<c_void>()) {
        // SAFETY: `payload` is `length` bytes, which is what is copied.
        let status = unsafe { block.copy_data_bytes(0, length, destination) };
        if status != 0 {
            return Output::Failed(VtError::Api {
                call: "CMBlockBufferCopyDataBytes",
                status,
            });
        }
    }
    Output::Frame(Raw {
        payload,
        length_size,
        parameter_sets,
        irap,
        captured,
        encoded,
    })
}

/// A sample is an IRAP unless its attachments say `NotSync`.
fn is_sync(sample: &CMSampleBuffer) -> bool {
    // SAFETY: the sample buffer is alive; nothing is created.
    let Some(attachments) = (unsafe { sample.sample_attachments_array(false) }) else {
        return true;
    };
    // SAFETY: one dictionary of string-keyed attachments per sample.
    let Some(first) = (unsafe { attachments.cast_unchecked::<CFDictionary>() }).get(0) else {
        return true;
    };
    // SAFETY: as above; the key is an immutable static.
    let (first, not_sync) = unsafe {
        (
            first.cast_unchecked::<CFString, CFType>(),
            kCMSampleAttachmentKey_NotSync,
        )
    };
    !boolean(first, not_sync)
}

/// The NAL length size, and every parameter set when `all` is asked for.
fn parameter_sets(
    description: &CMFormatDescription,
    codec: Codec,
    all: bool,
) -> Result<(usize, Vec<Vec<u8>>), VtError> {
    let at = |index: usize,
              data: *mut *const u8,
              size: *mut usize,
              count: *mut usize,
              length: *mut i32| {
        // SAFETY: every out pointer is a local or null, and the description is
        // alive for the call.
        unsafe {
            match codec {
                Codec::H264 => CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    description,
                    index,
                    data,
                    size,
                    count,
                    length,
                ),
                Codec::H265 => CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                    description,
                    index,
                    data,
                    size,
                    count,
                    length,
                ),
            }
        }
    };
    let (mut count, mut length) = (0usize, 0i32);
    check(
        at(0, ptr::null_mut(), ptr::null_mut(), &mut count, &mut length),
        "CMVideoFormatDescriptionGetParameterSetAtIndex",
    )?;
    let length =
        usize::try_from(length).map_err(|_| VtError::Malformed("negative nal length size"))?;
    let mut sets = Vec::new();
    if all {
        for index in 0..count {
            let (mut data, mut size) = (ptr::null::<u8>(), 0usize);
            check(
                at(
                    index,
                    &mut data,
                    &mut size,
                    ptr::null_mut(),
                    ptr::null_mut(),
                ),
                "CMVideoFormatDescriptionGetParameterSetAtIndex",
            )?;
            if data.is_null() {
                return Err(VtError::Malformed("a parameter set with no bytes"));
            }
            // SAFETY: the description owns `size` bytes at `data` for as long
            // as it is retained, which covers this copy.
            sets.push(unsafe { std::slice::from_raw_parts(data, size) }.to_vec());
        }
    }
    Ok((length, sets))
}

/// Split a length-prefixed access unit into its NAL units.
fn length_prefixed(payload: &[u8], length_size: usize) -> Result<Vec<&[u8]>, VtError> {
    if !matches!(length_size, 1 | 2 | 4) {
        return Err(VtError::Malformed("nal length size is not 1, 2 or 4"));
    }
    let mut units = Vec::new();
    let mut rest = payload;
    while !rest.is_empty() {
        if rest.len() < length_size {
            return Err(VtError::Malformed("a truncated nal length"));
        }
        let (prefix, body) = rest.split_at(length_size);
        let length = prefix
            .iter()
            .fold(0usize, |n, &b| (n << 8) | usize::from(b));
        if body.len() < length {
            return Err(VtError::Malformed("a nal longer than its access unit"));
        }
        let (unit, tail) = body.split_at(length);
        units.push(unit);
        rest = tail;
    }
    Ok(units)
}

/// What the encoder does with each H.264 SPS it sends, decided on the first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpsFix {
    Undecided,
    /// VideoToolbox's own SPS declares zero reordering: sent as it is.
    Keep,
    /// It does not: every SPS is rewritten to declare it.
    Rewrite,
}

impl SpsFix {
    /// The SPS to send in place of `nal`, or `None` to send `nal` as it is.
    fn apply(&mut self, nal: &[u8]) -> Option<Vec<u8>> {
        if *self == SpsFix::Undecided {
            *self = match h264_sps::parse(nal) {
                Some(sps) if sps.declares_no_reordering() => {
                    ::log::info!("swoop: videotoolbox's sps declares no reordering");
                    SpsFix::Keep
                }
                Some(_) => {
                    ::log::info!("swoop: videotoolbox's sps lacks the bitstream restriction; rewriting every sps");
                    SpsFix::Rewrite
                }
                None => {
                    ::log::warn!("swoop: videotoolbox's sps did not parse; sent as it is");
                    SpsFix::Keep
                }
            };
        }
        if *self != SpsFix::Rewrite {
            return None;
        }
        let fixed = h264_sps::with_restriction(nal);
        if fixed.is_none() {
            ::log::warn!("swoop: an sps could not be rewritten; sent as it is");
        }
        fixed
    }
}

/// A presentation time VideoToolbox takes: the capture ticks, or one past the
/// last when a floor repeat stamped later than a fresh capture would take time
/// backwards.
fn next_pts(last: Option<i64>, captured: i64) -> i64 {
    match last {
        Some(last) if captured <= last => last + 1,
        _ => captured,
    }
}

// ----------------------------------------------------------------- encode ---

/// Open a VideoToolbox encoder for `cfg`.
pub fn create(cfg: &EncoderConfig) -> anyhow::Result<Box<dyn Encoder>> {
    let (encoder, info) = VtEncoder::open(cfg)?;
    ::log::info!(
        "swoop: videotoolbox {:?} {}x{} on {info}",
        cfg.codec,
        cfg.width,
        cfg.height
    );
    for (name, status) in &info.refused {
        ::log::warn!("swoop: videotoolbox refused {name}: status {status}");
    }
    Ok(Box::new(encoder))
}

/// What a new session was opened on.
struct SessionInfo {
    hardware: bool,
    low_latency: bool,
    /// Properties the session refused, by name and status.
    refused: Vec<(&'static str, i32)>,
}

impl fmt::Display for SessionInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the {} encoder, low-latency rate control {}",
            if self.hardware {
                "hardware"
            } else {
                "software"
            },
            if self.low_latency { "on" } else { "off" },
        )
    }
}

struct VtEncoder {
    cfg: EncoderConfig,
    /// Declared before `shared`: it is invalidated and released first, so no
    /// callback can reach a freed refcon.
    session: Session,
    shared: Box<Shared>,
    force_key: CFRetained<CFDictionary<CFString, CFType>>,
    /// Whether the session took `DataRateLimits`; `set_bitrate` moves it only
    /// then.
    rate_window: bool,
    last_pts: Option<i64>,
}

// SAFETY: the session is a thread-safe CoreFoundation object and the shared
// output queue is behind a mutex. The streamer moves the encoder onto the
// encode thread and keeps it there, which is why this is Send and not Sync.
unsafe impl Send for VtEncoder {}

impl VtEncoder {
    fn open(cfg: &EncoderConfig) -> Result<(Self, SessionInfo), VtError> {
        let (hardware, _) =
            usable(listed(), cfg.codec).ok_or(VtError::NoEncoder { codec: cfg.codec })?;
        Self::open_on(cfg, hardware)
    }

    /// The first session on this encoder, without low-latency rate control
    /// first (the module doc's measurement), that opens and encodes a frame
    /// at `cfg`'s size.
    fn open_on(cfg: &EncoderConfig, hardware: bool) -> Result<(Self, SessionInfo), VtError> {
        let shared = Box::new(Shared {
            codec: cfg.codec,
            width: cfg.width,
            height: cfg.height,
            outputs: Mutex::new(Vec::new()),
            assembly: Mutex::new(Assembly {
                frame_id: 0,
                sps_fix: SpsFix::Undecided,
            }),
            sink: Mutex::new(None),
            key_due: AtomicBool::new(true),
            failed: Mutex::new(None),
        });
        let refcon = ptr::from_ref::<Shared>(&shared).cast_mut().cast::<c_void>();
        let mut failure = VtError::NoEncoder { codec: cfg.codec };
        for low_latency in [false, true] {
            let opened = create_session(cfg, hardware, low_latency, refcon).and_then(|session| {
                let refused = configure(&session.0, cfg)?;
                // SAFETY: the session is alive.
                check(
                    unsafe { session.0.prepare_to_encode_frames() },
                    "VTCompressionSessionPrepareToEncodeFrames",
                )?;
                let pts = warm_up(&session.0, &shared)?;
                Ok((session, refused, pts))
            });
            let (session, refused, pts) = match opened {
                Ok(opened) => opened,
                Err(e) => {
                    failure = e;
                    continue;
                }
            };
            // SAFETY: the key is an immutable static.
            let force = unsafe { kVTEncodeFrameOptionKey_ForceKeyFrame };
            let encoder = Self {
                cfg: cfg.clone(),
                session,
                shared,
                force_key: CFDictionary::from_slices(&[force], &[CFBoolean::new(true) as &CFType]),
                rate_window: !refused.iter().any(|(name, _)| *name == "DataRateLimits"),
                last_pts: Some(pts),
            };
            let info = SessionInfo {
                hardware,
                low_latency,
                refused,
            };
            return Ok((encoder, info));
        }
        Err(failure)
    }
}

impl Encoder for VtEncoder {
    fn encode(&mut self, frame: &Frame, force_irap: bool) -> anyhow::Result<Option<EncodedFrame>> {
        if (frame.width, frame.height) != (self.cfg.width, self.cfg.height) {
            return Err(VtError::SizeChanged {
                got_width: frame.width,
                got_height: frame.height,
                want_width: self.cfg.width,
                want_height: self.cfg.height,
            }
            .into());
        }
        if let Some(e) = self.shared.failed.lock().ok().and_then(|mut failed| failed.take()) {
            return Err(e.into());
        }
        let buffer = pixel_buffer(frame).ok_or(VtError::NoPixelBuffer)?;
        let pts = next_pts(self.last_pts, frame.captured_qpc);
        self.last_pts = Some(pts);
        // SAFETY: plain value constructors; kCMTimeInvalid is an immutable static.
        let (time, duration) = unsafe { (CMTime::new(pts, NANOS), kCMTimeInvalid) };
        let forced = force_irap || self.shared.key_due.swap(false, Ordering::SeqCst);
        let properties = forced.then(|| self.force_key.as_opaque());
        // the capture ticks ride as the frame's reference value, and come back
        // to the callback beside its bits
        let reference = ptr::without_provenance_mut::<c_void>(frame.captured_qpc as usize);
        let mut flags = VTEncodeInfoFlags(0);
        // SAFETY: the buffer is alive for the call (VideoToolbox retains what it
        // keeps), the properties dictionary is alive, and the flags are a local.
        let submitted = check(
            unsafe {
                self.session
                    .0
                    .encode_frame(buffer, time, duration, properties, reference, &mut flags)
            },
            "VTCompressionSessionEncodeFrame",
        );
        if let Err(e) = submitted {
            if forced {
                // the keyframe owed is still owed
                self.shared.key_due.store(true, Ordering::SeqCst);
            }
            return Err(e.into());
        }
        if self.shared.has_sink() {
            // The callback assembles the frame and hands it to the sink.
            return Ok(None);
        }
        // SAFETY: the session is alive. It returns once every frame up to this
        // one has been through the output callback.
        check(
            unsafe { self.session.0.complete_frames(time) },
            "VTCompressionSessionCompleteFrames",
        )?;

        let mut raw = None;
        for output in self.shared.take()? {
            match output {
                Output::Frame(emitted) => raw = Some(emitted),
                Output::Dropped => ::log::debug!("swoop: videotoolbox dropped a frame"),
                Output::Failed(e) => return Err(e.into()),
            }
        }
        let Some(raw) = raw else {
            return Ok(None);
        };
        Ok(Some(self.shared.assemble(&raw)?))
    }

    fn set_sink(&mut self, sink: Sink) {
        if let Ok(mut slot) = self.shared.sink.lock() {
            *slot = Some(sink);
        }
    }

    fn set_bitrate(&mut self, bitrate_bps: u32) -> anyhow::Result<()> {
        let window = set_rate(&self.session.0, bitrate_bps, self.cfg.fps, self.rate_window)?;
        check(window, "VTSessionSetProperty(DataRateLimits)")?;
        self.cfg.bitrate_bps = bitrate_bps;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::gpu::vt_transfer::testing::{frame, nv12};

    const H264_SPS_VUI_OFF: &str = "6764002aac2b280f0044fcb808800001f40000ea6042";
    const H264_SPS_VUI_ON: &str = "6764002aac2b280f0044fcb808800001f40000ea60478e152c";

    fn base(codec: Codec) -> EncoderConfig {
        EncoderConfig {
            codec,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_bps: 20_000_000,
        }
    }

    #[test]
    fn length_prefixed_units_split_at_every_size() {
        let four = [0, 0, 0, 2, 0x65, 0xaa, 0, 0, 0, 1, 0x06];
        assert_eq!(
            length_prefixed(&four, 4).expect("splits"),
            vec![&[0x65, 0xaa][..], &[0x06][..]]
        );
        let two = [0, 1, 0x41, 0, 2, 0x41, 0xbb];
        assert_eq!(
            length_prefixed(&two, 2).expect("splits"),
            vec![&[0x41][..], &[0x41, 0xbb][..]]
        );
        assert!(length_prefixed(&[], 4).expect("an empty unit").is_empty());
    }

    #[test]
    fn a_malformed_access_unit_is_an_error_not_a_panic() {
        assert!(length_prefixed(&[0, 0, 0, 9, 0x65], 4).is_err());
        assert!(length_prefixed(&[0, 0], 4).is_err());
        assert!(length_prefixed(&[0, 1, 0x65], 3).is_err());
    }

    #[test]
    fn the_list_decides_which_encoder_serves_each_codec() {
        let hw = |codec, limit| Listed {
            codec_type: codec_type(codec),
            hardware: true,
            instance_limit: limit,
        };
        let sw = |codec| Listed {
            codec_type: codec_type(codec),
            hardware: false,
            instance_limit: None,
        };
        // apple silicon: both codecs in hardware; the software h264 is never a
        // fallback beside it
        let apple = [
            hw(Codec::H264, Some(3)),
            sw(Codec::H264),
            hw(Codec::H265, None),
        ];
        assert_eq!(usable(&apple, Codec::H264), Some((true, vec![3])));
        assert_eq!(usable(&apple, Codec::H265), Some((true, vec![])));
        // no hardware: h264 falls to software, hevc is not offered at all
        let bare = [sw(Codec::H264), sw(Codec::H265)];
        assert_eq!(usable(&bare, Codec::H264), Some((false, vec![])));
        assert_eq!(usable(&bare, Codec::H265), None);
        assert_eq!(usable(&[], Codec::H264), None);
    }

    #[test]
    fn the_rate_window_is_one_frame_interval() {
        assert_eq!(rate_window(20_000_000, 60), (41_666, 1.0 / 60.0));
        assert_eq!(rate_window(8_000_000, 30), (33_333, 1.0 / 30.0));
        // a zero rate is a configuration error elsewhere, never a division here
        assert_eq!(rate_window(8_000_000, 0), (1_000_000, 1.0));
    }

    #[test]
    fn presentation_times_only_move_forward() {
        assert_eq!(next_pts(None, 500), 500);
        assert_eq!(next_pts(Some(500), 900), 900);
        // a fresh capture stamped before the floor's last repeat
        assert_eq!(next_pts(Some(900), 800), 901);
        assert_eq!(next_pts(Some(900), 900), 901);
    }

    #[test]
    fn the_first_sps_decides_whether_every_sps_is_rewritten() {
        let off = hex::decode(H264_SPS_VUI_OFF).expect("hex");
        let on = hex::decode(H264_SPS_VUI_ON).expect("hex");

        let mut fix = SpsFix::Undecided;
        let fixed = fix.apply(&off).expect("a missing restriction is rewritten");
        assert_eq!(fix, SpsFix::Rewrite);
        assert!(h264_sps::parse(&fixed)
            .expect("parses")
            .declares_no_reordering());
        // decided once: a later sps is rewritten without being judged again
        assert!(fix.apply(&on).is_some());

        let mut fix = SpsFix::Undecided;
        assert_eq!(fix.apply(&on), None, "a declared restriction is left alone");
        assert_eq!(fix, SpsFix::Keep);
        assert_eq!(fix.apply(&off), None, "and so is every sps after it");

        let mut fix = SpsFix::Undecided;
        assert_eq!(
            fix.apply(&[0x67, 0x42]),
            None,
            "an unreadable sps is sent as it is"
        );
        assert_eq!(fix, SpsFix::Keep);
    }

    #[test]
    fn every_encoder_failure_exits_thirteen() {
        for error in [
            VtError::NoEncoder { codec: Codec::H265 },
            VtError::Api {
                call: "VTCompressionSessionCompleteFrames",
                status: -12902,
            },
            VtError::NoPixelBuffer,
            VtError::Malformed("no data buffer"),
        ] {
            assert_eq!(error.exit().code(), 13, "{error}");
        }
    }

    // ---------------------------------------------------- hardware tests ---

    /// Every NAL unit of an Annex-B buffer, with its type.
    fn nal_units(data: &[u8], codec: Codec) -> Vec<(u8, std::ops::Range<usize>)> {
        let mut starts = Vec::new();
        let mut i = 0;
        while i + 3 <= data.len() {
            if data[i..i + 3] == [0, 0, 1] {
                starts.push(i + 3);
                i += 3;
            } else {
                i += 1;
            }
        }
        starts
            .iter()
            .enumerate()
            .map(|(n, &start)| {
                let mut end = starts.get(n + 1).map_or(data.len(), |&next| next - 3);
                while end > start && data[end - 1] == 0 {
                    end -= 1;
                }
                let ty = match codec {
                    Codec::H264 => data[start] & 0x1f,
                    Codec::H265 => (data[start] >> 1) & 0x3f,
                };
                (ty, start..end)
            })
            .collect()
    }

    /// Parameter sets first, then an IRAP slice.
    fn carries_parameter_sets(data: &[u8], codec: Codec) -> bool {
        let types: Vec<u8> = nal_units(data, codec)
            .into_iter()
            .map(|(ty, _)| ty)
            .collect();
        let (needed, irap): (&[u8], fn(u8) -> bool) = match codec {
            Codec::H264 => (&[7, 8], |ty| ty == 5),
            Codec::H265 => (&[32, 33, 34], |ty| (16..=23).contains(&ty)),
        };
        let Some(first_irap) = types.iter().position(|&ty| irap(ty)) else {
            return false;
        };
        needed.iter().all(|ty| types[..first_irap].contains(ty))
    }

    /// Screen-like NV12: a noisy wallpaper on the left, rows of text-sized
    /// detail on the right, and a block that moves with `phase`, so the encoder
    /// is never handed a still picture or one an intra frame can cheat on.
    fn pattern(width: u32, height: u32, phase: u32) -> CFRetained<CVPixelBuffer> {
        let block = (phase * 137 % (width - width / 6), height / 3);
        let noise = |x: u32, y: u32| {
            let mut n = x.wrapping_mul(0x9e37_79b9) ^ y.wrapping_mul(0x85eb_ca6b);
            n ^= n >> 15;
            n = n.wrapping_mul(0x2c1b_3c6d);
            (n >> 24) as u8
        };
        let in_block = move |x: u32, y: u32| {
            (block.0..block.0 + width / 6).contains(&x)
                && (block.1..block.1 + height / 6).contains(&y)
        };
        nv12(
            width,
            height,
            |x, y| {
                if in_block(x, y) {
                    81
                } else if x < width * 55 / 100 {
                    16 + noise(x, y) / 2 + (y * 60 / height) as u8
                } else if y % 19 < 2 && (x / 7) % 11 != 0 {
                    30
                } else {
                    225
                }
            },
            |x, y| {
                if in_block(x * 2, y * 2) {
                    (90, 240)
                } else if x * 2 < width * 55 / 100 {
                    (96 + noise(y, x) / 4, 96 + noise(x, y) / 4)
                } else {
                    (128, 128)
                }
            },
        )
    }

    fn percentile(sorted: &[f64], p: usize) -> f64 {
        sorted[(sorted.len() * p / 100).min(sorted.len() - 1)]
    }

    /// Needs VideoToolbox, no grant: the invocation is in the module doc.
    #[test]
    #[ignore = "needs videotoolbox"]
    fn videotoolbox_probe_reports_codecs_sizes_and_a_session_budget() {
        let started = Instant::now();
        let caps = probe();
        println!(
            "videotoolbox probe ({} ms): {caps:?}",
            started.elapsed().as_millis()
        );
        assert_eq!(caps.backend, "videotoolbox");
        assert!(caps.concurrent_sessions >= 1);
        for codec in [Codec::H264, Codec::H265] {
            let found = caps.codecs.iter().find(|c| c.codec == codec);
            let found = found.unwrap_or_else(|| panic!("apple silicon encodes {codec:?}"));
            assert!(
                found.max_width >= 4096 && found.max_height >= 2304,
                "{found:?}"
            );
            // the ceiling is a size a session really encodes at
            let cfg = EncoderConfig {
                width: found.max_width,
                height: found.max_height,
                ..base(codec)
            };
            let (_, info) = VtEncoder::open(&cfg).expect("the probed ceiling opens");
            println!(
                "  {codec:?} at {}x{}: {info}",
                found.max_width, found.max_height
            );
        }
        // cached: the second answer is the first, without a session opened
        let started = Instant::now();
        assert_eq!(format!("{:?}", probe()), format!("{caps:?}"));
        assert!(started.elapsed().as_millis() < 50);
    }

    /// Needs VideoToolbox, no grant. The sink is the session's path; the
    /// numbers asserted are the module doc's.
    #[test]
    #[ignore = "needs videotoolbox"]
    fn videotoolbox_holds_60_at_the_panels_size_through_its_sink() {
        use std::sync::Arc;
        use std::time::Duration;

        use objc2_core_graphics::CGMainDisplayID;

        use crate::platform::macos::display_pixel_rect;

        let panel = display_pixel_rect(CGMainDisplayID());
        let cfg = EncoderConfig {
            width: panel.width() as u32 & !1,
            height: panel.height() as u32 & !1,
            bitrate_bps: 50_000_000,
            ..base(Codec::H265)
        };
        let buffers: Vec<_> = (0..8)
            .map(|phase| pattern(cfg.width, cfg.height, phase))
            .collect();
        let (mut encoder, info) = VtEncoder::open_on(&cfg, true).expect("the encoder opens");
        // (captured, encoded, irap, frame id), in callback order
        type Arrived = Arc<Mutex<Vec<(i64, i64, bool, u64)>>>;
        let arrived: Arrived = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&arrived);
        encoder.set_sink(Box::new(move |frame| {
            seen.lock().unwrap().push((
                frame.captured_qpc,
                frame.encoded_qpc,
                frame.is_irap,
                frame.frame_id,
            ));
            true
        }));

        let n = 240u32;
        let started = Instant::now();
        for i in 0..n {
            let slot = started + Duration::from_micros(u64::from(i) * 16_667);
            if let Some(wait) = slot.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            let captured = frame(&buffers[(i % 8) as usize], clock::now_ticks());
            let answered = encoder.encode(&captured, i == 90).expect("the frame submits");
            assert!(answered.is_none(), "with a sink nothing is answered from encode");
        }
        let deadline = Instant::now() + Duration::from_millis(500);
        while arrived.lock().unwrap().len() < n as usize && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let elapsed = started.elapsed().as_secs_f64();
        let frames = arrived.lock().unwrap().clone();
        let fps = frames.len() as f64 / elapsed;
        let mut latency: Vec<f64> = frames.iter().map(|(c, e, ..)| (e - c) as f64 / 1e6).collect();
        latency.sort_by(f64::total_cmp);
        let iraps: Vec<u64> = frames.iter().filter(|f| f.2).map(|f| f.3).collect();
        println!(
            "{}x{} through the sink: {} of {n} frames in {elapsed:.2} s = {fps:.1} fps, submit-to-callback p50 {:.1} ms p95 {:.1} ms, iraps at {iraps:?}; {info}",
            cfg.width,
            cfg.height,
            frames.len(),
            percentile(&latency, 50),
            percentile(&latency, 95),
        );
        assert_eq!(frames.len(), n as usize, "every frame came back");
        assert!(
            frames.windows(2).all(|w| w[0].3 + 1 == w[1].3 && w[0].0 <= w[1].0),
            "callback order is input order"
        );
        assert!(fps >= 59.0, "{fps:.1} fps");
        assert!(percentile(&latency, 95) < 20.0, "p95 {:.1} ms", percentile(&latency, 95));
        assert_eq!(iraps, [0, 90]);
    }

    /// Needs VideoToolbox, no grant: the invocation is in the module doc.
    #[test]
    #[ignore = "needs videotoolbox"]
    fn videotoolbox_encodes_120_frames_in_each_codec() {
        // the hardware for each codec, then the software floor a mac without
        // h264 hardware would take
        for (codec, hardware) in [
            (Codec::H264, true),
            (Codec::H265, true),
            (Codec::H264, false),
        ] {
            let cfg = base(codec);
            let buffers: Vec<_> = (0..4)
                .map(|phase| pattern(cfg.width, cfg.height, phase))
                .collect();
            let (mut encoder, info) =
                VtEncoder::open_on(&cfg, hardware).expect("the encoder opens");
            // SAFETY: the key is an immutable static.
            let interval_key = unsafe { kVTCompressionPropertyKey_MaxKeyFrameInterval };
            println!(
                "videotoolbox {codec:?}: {info}, refused {:?}, advertised MaxKeyFrameInterval maximum {:?}",
                info.refused,
                supported_maximum(&encoder.session.0, interval_key),
            );

            let mut timings = Vec::new();
            let mut iraps = Vec::new();
            let mut keyframe_bytes = 0usize;
            let mut delta_bytes = 0usize;
            let mut sps = None;
            for i in 0..120u32 {
                // the rate moves at 60 without a keyframe; 90 is forced
                if i == 60 {
                    encoder.set_bitrate(10_000_000).expect("the rate moves");
                }
                let captured = frame(&buffers[(i % 4) as usize], clock::now_ticks());
                let started = Instant::now();
                let encoded = encoder
                    .encode(&captured, i == 90)
                    .expect("the frame encodes")
                    .expect("every submitted frame comes back from its own call");
                timings.push(started.elapsed().as_secs_f64() * 1000.0);

                assert_eq!(encoded.frame_id, u64::from(i));
                assert_eq!(encoded.captured_qpc, captured.captured_qpc);
                assert!(encoded.encoded_qpc >= encoded.captured_qpc);
                if encoded.is_irap {
                    iraps.push(i);
                    assert!(
                        carries_parameter_sets(&encoded.data, codec),
                        "{codec:?} frame {i}: an irap carries its parameter sets in front"
                    );
                }
                if i == 0 {
                    keyframe_bytes = encoded.data.len();
                } else if i < 60 {
                    delta_bytes += encoded.data.len();
                }
                if codec == Codec::H264 && sps.is_none() {
                    sps = nal_units(&encoded.data, codec)
                        .into_iter()
                        .find(|(ty, _)| *ty == h264_sps::NAL_SPS)
                        .and_then(|(_, range)| h264_sps::parse(&encoded.data[range]));
                }
            }

            timings.sort_by(f64::total_cmp);
            println!(
                "  120 frames at {}x{}: encode() p50 {:.2} ms p95 {:.2} ms, iraps at {iraps:?}",
                cfg.width,
                cfg.height,
                percentile(&timings, 50),
                percentile(&timings, 95),
            );
            println!(
                "  keyframe {keyframe_bytes} B, mean delta {} B at 20 mbps",
                delta_bytes / 59
            );
            assert_eq!(
                iraps,
                vec![0, 90],
                "keyframes come only when the session asks"
            );
            if codec == Codec::H264 {
                let sps = sps.expect("the first access unit carries an sps");
                println!(
                    "  videotoolbox's own sps declared the restriction: {}; on the wire: flag={} max_num_reorder_frames={:?} max_dec_frame_buffering={:?} max_num_ref_frames={}",
                    encoder.shared.assembly.lock().unwrap().sps_fix == SpsFix::Keep,
                    sps.bitstream_restriction_flag,
                    sps.max_num_reorder_frames,
                    sps.max_dec_frame_buffering,
                    sps.max_num_ref_frames,
                );
                assert!(
                    sps.declares_no_reordering(),
                    "the h264 sps carries the restriction"
                );
                assert!(sps.max_dec_frame_buffering >= Some(sps.max_num_ref_frames));
            }
        }
    }
}
