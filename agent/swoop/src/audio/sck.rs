//! The macOS side of host audio: a ScreenCaptureKit stream of its own for what
//! the Mac is playing, and CoreAudio's default output device.
//!
//! swoop **never creates a device and never moves the default output**, as on
//! Windows (`wasapi`'s head says why). CoreAudio is asked one thing, whether a
//! default output device exists, which is the fact `status` carries.
//!
//! # [`Loopback`]
//!
//! A second `SCStream`, separate from the picture's, so audio neither waits on
//! nor rebuilds with a display: `capturesAudio` on, 48 kHz, two channels,
//! `excludesCurrentProcessAudio` on (the streamer plays nothing, and a future
//! one must not hear itself), and the smallest picture the API accepts, which
//! no output is added for. Its filter is a display excluding no windows, and
//! the audio it carries is the whole system's whichever display that is.
//!
//! ScreenCaptureKit hands the audio over as 32-bit float, one plane per
//! channel. The handler checks that layout on every buffer, converts it to the
//! interleaved 16-bit samples Opus takes, and queues them for [`Loopback::drain`],
//! bounded at 200 ms like the Windows endpoint buffer. A buffer in any other
//! layout is refused and the first refusal logged, so a Mac that answers
//! differently is silent and says why rather than playing noise.
//!
//! Like WASAPI loopback, nothing arrives while nothing plays: an app holding
//! an output open delivers buffers even of zeros, but a quiet Mac delivers
//! none, and the frame clock fills the time.
//!
//! ScreenCaptureKit asks for Screen Recording when a process has none, so
//! [`Loopback::open`] reads the grant first and fails without it: nothing here
//! raises a prompt.
//!
//! # Hardware checks (`#[ignore]`d)
//!
//! With the working directory `agent/swoop`, on a Mac whose shell holds the
//! Screen Recording grant and whose display is awake (an asleep display is not
//! listed; `caffeinate -u -t 2` wakes it):
//!
//! ```text
//! CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --no-default-features \
//!     --features encode-videotoolbox,audio-opus --lib -- --ignored audio::sck --nocapture
//! ```
//!
//! `reports_whether_this_mac_has_a_default_output_device` prints the probe's
//! answer. `captures_whatever_this_mac_is_playing` **records whatever the Mac
//! is playing for a second** and prints the layout ScreenCaptureKit delivered,
//! how many samples arrived and how loud they were; nothing is saved. The menu
//! bar shows the system's capture indicator while it runs.

use std::ffi::c_void;
use std::fmt;
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass, Message};
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::CGPreflightScreenCaptureAccess;
use objc2_core_media::{
    kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
    CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMSampleBuffer, CMTime,
};
use objc2_foundation::{NSArray, NSError};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamErrorCode, SCStreamOutput, SCStreamOutputType,
};

use super::opus::{CHANNELS, SAMPLE_RATE_HZ};

/// How long a ScreenCaptureKit completion handler is waited for. They answer
/// in well under a second when they answer at all; this bounds a hang.
const SCK_TIMEOUT: Duration = Duration::from_secs(5);

/// Interleaved samples the queue holds: 200 ms, the Windows endpoint buffer.
/// The capture thread drains it every 10 ms, so only a stalled thread fills it.
const QUEUED_SAMPLES: usize = SAMPLE_RATE_HZ as usize / 1_000 * 200 * CHANNELS;

/// The picture the audio stream is made to carry: two pixels square, once a
/// second, with no output added for it. Two is the floor: at one pixel the
/// start fails (1003, measured on macOS 26.6).
const PICTURE_EDGE: usize = 2;
const PICTURE_INTERVAL_S: i64 = 1;

// CoreAudioTypes' names for the layout checked below. The crate that exports
// them arrives only through objc2-core-media, so the values are spelled here
// (decision 15); they are ABI and have not moved since Mac OS X 10.0.
const LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");
const FLAG_IS_FLOAT: u32 = 1 << 0;
const FLAG_NON_INTERLEAVED: u32 = 1 << 5;

/// Is there a default output device at all?
///
/// A Mac always has one unless its audio stack is broken or every output is
/// gone; either way the answer is the `no_endpoint` a viewer is told about.
pub fn render_endpoint_present() -> bool {
    let address = PropertyAddress {
        selector: DEFAULT_OUTPUT_DEVICE,
        scope: SCOPE_GLOBAL,
        element: ELEMENT_MAIN,
    };
    let mut device = UNKNOWN_OBJECT;
    let mut size = size_of::<u32>() as u32;
    // SAFETY: the address is a live struct of the C layout, and `device` is
    // the u32 AudioObjectID the property holds, with its size in `size`.
    let status = unsafe {
        AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            &address,
            0,
            ptr::null(),
            &mut size,
            (&raw mut device).cast(),
        )
    };
    status == 0 && device != UNKNOWN_OBJECT
}

// CoreAudio's HAL, by one `extern "C"` call (decision 15).
const SYSTEM_OBJECT: u32 = 1;
const UNKNOWN_OBJECT: u32 = 0;
const DEFAULT_OUTPUT_DEVICE: u32 = u32::from_be_bytes(*b"dOut");
const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
const ELEMENT_MAIN: u32 = 0;

/// `AudioObjectPropertyAddress`.
#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioObjectGetPropertyData(
        object: u32,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: *mut u32,
        data: *mut c_void,
    ) -> i32;
}

/// A running capture of what the Mac is playing, as interleaved 48 kHz stereo
/// i16.
pub struct Loopback {
    stream: Retained<SCStream>,
    /// The stream's output and delegate, held for as long as the stream runs:
    /// Cocoa does not promise that a stream keeps its delegate alive.
    _sink: Retained<AudioSink>,
    shared: Arc<Shared>,
    _queue: DispatchRetained<DispatchQueue>,
}

impl Loopback {
    /// Open and start the capture. Fails without the Screen Recording grant,
    /// and when ScreenCaptureKit lists no display.
    pub fn open() -> Result<Self> {
        if !CGPreflightScreenCaptureAccess() {
            bail!("screen recording is not granted to this process, and screencapturekit's audio needs it");
        }
        let display = any_display()?;
        let shared = Arc::new(Shared::default());
        let sink = AudioSink::new(Arc::clone(&shared));
        let queue = DispatchQueue::new("app.owlette.swoop.audio", None);
        // SAFETY: every argument is a live object of the type the method
        // declares; the empty array excludes no window.
        let stream = unsafe {
            let filter = SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::new(),
            );
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &configuration(),
                Some(ProtocolObject::from_ref(&*sink)),
            )
        };
        // SAFETY: the queue is serial, and the sink outlives the stream: both
        // live in `Self`, whose `Drop` stops the stream before either goes.
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*sink),
                SCStreamOutputType::Audio,
                Some(&*queue),
            )
        }
        .map_err(|e| sck_error(e.code(), "add the audio output"))?;
        // SAFETY: the handler has the signature the method declares.
        completion("start the audio capture", |handler| unsafe {
            stream.startCaptureWithCompletionHandler(Some(handler))
        })?;
        Ok(Self {
            stream,
            _sink: sink,
            shared,
            _queue: queue,
        })
    }

    /// Append everything queued since the last call to `out`, and return how
    /// many interleaved samples that was.
    ///
    /// An error is the stream stopping under us (the grant revoked, the
    /// display gone); the caller drops the capture and re-probes rather than
    /// retrying it.
    pub fn drain(&self, out: &mut Vec<i16>) -> Result<usize> {
        if self.shared.stopped.load(Ordering::Acquire) {
            bail!(
                "the screencapturekit audio stream stopped ({})",
                self.shared.stop_code.load(Ordering::Relaxed)
            );
        }
        let mut queue = self
            .shared
            .pcm
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let samples = queue.len();
        out.append(&mut queue);
        Ok(samples)
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        // A stream that already stopped answers with an error; either way it
        // delivers nothing after the answer.
        // SAFETY: the handler has the signature the method declares.
        if let Err(e) = completion("stop the audio capture", |handler| unsafe {
            self.stream.stopCaptureWithCompletionHandler(Some(handler))
        }) {
            ::log::debug!("swoop: host audio stop: {e:#}");
        }
        ::log::debug!(
            "swoop: host audio stream ended: {} buffers not converted, {} samples dropped for a full queue",
            self.shared.unconverted.load(Ordering::Relaxed),
            self.shared.dropped.load(Ordering::Relaxed)
        );
    }
}

/// What the output handler and the capture thread share for one stream.
#[derive(Default)]
struct Shared {
    pcm: Mutex<Vec<i16>>,
    stopped: AtomicBool,
    stop_code: AtomicIsize,
    /// The layout of the first buffer, logged once and read by the hardware
    /// test.
    layout: OnceLock<Layout>,
    unconverted: AtomicU64,
    dropped: AtomicU64,
}

impl Shared {
    /// The output handler. Runs on the stream's queue and must not panic.
    fn deliver(&self, sample: &CMSampleBuffer) {
        if let Err(refusal) = self.convert(sample) {
            if self.unconverted.fetch_add(1, Ordering::Relaxed) == 0 {
                ::log::error!("swoop: host audio is not converted: {refusal}");
            }
        }
    }

    fn convert(&self, sample: &CMSampleBuffer) -> Result<(), Refusal> {
        let layout = layout(sample).ok_or(Refusal::NoFormat)?;
        if self.layout.set(layout).is_ok() {
            ::log::debug!("swoop: host audio arrives as {layout}");
        }
        if !layout.is_planar_float_stereo_48k() {
            return Err(Refusal::Layout(layout));
        }
        with_planes(sample, |left, right| {
            let mut queue = self.pcm.lock().unwrap_or_else(PoisonError::into_inner);
            if !append_interleaved(&mut queue, left, right, QUEUED_SAMPLES) {
                self.dropped
                    .fetch_add(2 * left.len() as u64, Ordering::Relaxed);
            }
        })
    }

    fn stopped(&self, code: isize) {
        self.stop_code.store(code, Ordering::Relaxed);
        self.stopped.store(true, Ordering::Release);
    }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and `AudioSink` has no
    // `Drop` of its own: its ivars drop with it.
    #[unsafe(super(NSObject))]
    #[ivars = Arc<Shared>]
    struct AudioSink;

    unsafe impl NSObjectProtocol for AudioSink {}

    unsafe impl SCStreamOutput for AudioSink {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(
            &self,
            _stream: &SCStream,
            sample: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            if kind == SCStreamOutputType::Audio {
                self.ivars().deliver(sample);
            }
        }
    }

    unsafe impl SCStreamDelegate for AudioSink {
        #[unsafe(method(stream:didStopWithError:))]
        fn stream_did_stop(&self, _stream: &SCStream, error: &NSError) {
            self.ivars().stopped(error.code());
        }
    }
);

impl AudioSink {
    fn new(shared: Arc<Shared>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(shared);
        // SAFETY: `init` is NSObject's designated initialiser.
        unsafe { msg_send![super(this), init] }
    }
}

/// Why a buffer was not converted.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Refusal {
    NoFormat,
    Layout(Layout),
    /// CoreMedia's status from reading the buffer list.
    BufferList(i32),
    /// The list's buffer count, when it is not two single-channel planes of
    /// one length.
    Planes(u32),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoFormat => write!(f, "a buffer with no audio format"),
            Self::Layout(layout) => write!(
                f,
                "screencapturekit delivered {layout}, not 48000 hz 2 channels 32-bit float planar"
            ),
            Self::BufferList(status) => {
                write!(f, "coremedia could not list the buffer's planes ({status})")
            }
            Self::Planes(count) => {
                write!(f, "{count} buffers that are not two planes of one channel")
            }
        }
    }
}

/// The fields of an `AudioStreamBasicDescription` the conversion depends on.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Layout {
    format: u32,
    flags: u32,
    bits: u32,
    channels: u32,
    rate: f64,
}

impl Layout {
    fn is_planar_float_stereo_48k(&self) -> bool {
        self.format == LINEAR_PCM
            && self.flags & FLAG_IS_FLOAT != 0
            && self.flags & FLAG_NON_INTERLEAVED != 0
            && self.bits == 32
            && self.channels == CHANNELS as u32
            && self.rate == f64::from(SAMPLE_RATE_HZ)
    }
}

impl fmt::Display for Layout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let format = self.format.to_be_bytes();
        write!(
            f,
            "'{}' {} hz {} channels {}-bit {} {}",
            String::from_utf8_lossy(&format),
            self.rate,
            self.channels,
            self.bits,
            if self.flags & FLAG_IS_FLOAT != 0 {
                "float"
            } else {
                "integer"
            },
            if self.flags & FLAG_NON_INTERLEAVED != 0 {
                "planar"
            } else {
                "interleaved"
            },
        )
    }
}

/// The buffer's layout, from its audio format description.
fn layout(sample: &CMSampleBuffer) -> Option<Layout> {
    // SAFETY: the sample buffer is live for this call; the description comes
    // back retained, and the description it points into outlives the read.
    unsafe {
        let description = sample.format_description()?;
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(&description).as_ref()?;
        Some(Layout {
            format: asbd.mFormatID,
            flags: asbd.mFormatFlags,
            bits: asbd.mBitsPerChannel,
            channels: asbd.mChannelsPerFrame,
            rate: asbd.mSampleRate,
        })
    }
}

/// CoreAudioTypes' `AudioBufferList` with room for two buffers, in its C
/// layout. Its crate is not a direct dependency, so the shape is spelled here
/// and the pointer is cast to the type CoreMedia's signature names.
#[repr(C)]
struct BufferList {
    count: u32,
    buffers: [Buffer; 2],
}

/// `AudioBuffer`.
#[repr(C)]
#[derive(Clone, Copy)]
struct Buffer {
    channels: u32,
    bytes: u32,
    data: *mut c_void,
}

impl Buffer {
    const EMPTY: Self = Self {
        channels: 0,
        bytes: 0,
        data: ptr::null_mut(),
    };
}

/// Hand the two planes of a planar stereo float buffer to `use_planes`, which
/// may read them for as long as the call lasts.
fn with_planes(
    sample: &CMSampleBuffer,
    use_planes: impl FnOnce(&[f32], &[f32]),
) -> Result<(), Refusal> {
    let mut list = BufferList {
        count: 0,
        buffers: [Buffer::EMPTY; 2],
    };
    let mut block: *mut CMBlockBuffer = ptr::null_mut();
    // SAFETY: `list` has room for the two buffers its size says, and the block
    // buffer comes back retained and is owned below.
    let status = unsafe {
        sample.audio_buffer_list_with_retained_block_buffer(
            ptr::null_mut(),
            (&raw mut list).cast(),
            size_of::<BufferList>(),
            None,
            None,
            kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            &mut block,
        )
    };
    // The planes point into this block buffer; the retain is given back on
    // the way out of this function, after `use_planes` has run.
    // SAFETY: non-null only when the call handed over a retain.
    let _block = NonNull::new(block).map(|block| unsafe { CFRetained::from_raw(block) });
    if status != 0 {
        return Err(Refusal::BufferList(status));
    }
    let [left, right] = list.buffers;
    if list.count != 2
        || left.channels != 1
        || right.channels != 1
        || left.bytes != right.bytes
        || left.data.is_null()
        || right.data.is_null()
    {
        return Err(Refusal::Planes(list.count));
    }
    let frames = left.bytes as usize / size_of::<f32>();
    // SAFETY: each plane holds `bytes` of f32 samples (the layout was checked
    // by the caller), 16-byte aligned by the flag above, and stays valid while
    // `_block` holds its retain.
    let (left, right) = unsafe {
        (
            std::slice::from_raw_parts(left.data.cast::<f32>(), frames),
            std::slice::from_raw_parts(right.data.cast::<f32>(), frames),
        )
    };
    use_planes(left, right);
    Ok(())
}

/// One float sample as 16-bit. `as` saturates and maps NaN to 0, so a sample
/// past full scale clips rather than wrapping.
fn to_i16(sample: f32) -> i16 {
    (sample * f32::from(i16::MAX)) as i16
}

/// Interleave two planes onto `queue`, or refuse the whole buffer when it
/// would take the queue past `cap`: a half-kept buffer is a gap either way.
fn append_interleaved(queue: &mut Vec<i16>, left: &[f32], right: &[f32], cap: usize) -> bool {
    if queue.len() + left.len() + right.len() > cap {
        return false;
    }
    queue.extend(
        left.iter()
            .zip(right)
            .flat_map(|(&l, &r)| [to_i16(l), to_i16(r)]),
    );
    true
}

/// The configuration: the audio Opus wants, and as little picture as the API
/// accepts.
fn configuration() -> Retained<SCStreamConfiguration> {
    // SAFETY: plain setters on a fresh configuration.
    unsafe {
        let config = SCStreamConfiguration::new();
        config.setCapturesAudio(true);
        config.setSampleRate(SAMPLE_RATE_HZ as isize);
        config.setChannelCount(CHANNELS as isize);
        config.setExcludesCurrentProcessAudio(true);
        config.setWidth(PICTURE_EDGE);
        config.setHeight(PICTURE_EDGE);
        config.setMinimumFrameInterval(CMTime::new(PICTURE_INTERVAL_S, 1));
        config.setShowsCursor(false);
        config
    }
}

/// Any display ScreenCaptureKit lists: the filter needs one, and the audio is
/// the system's whichever it is.
fn any_display() -> Result<Retained<SCDisplay>> {
    /// An immutable snapshot, handed from the framework's queue to this thread.
    struct Content(Retained<SCShareableContent>);
    // SAFETY: the content is never mutated, and only read after the handoff.
    unsafe impl Send for Content {}

    let (tx, rx) = mpsc::sync_channel::<Result<Content, isize>>(1);
    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // SAFETY: each is null or an object the framework keeps alive for
            // the length of this call; the retain keeps the content past it.
            let answer = match unsafe { (content.as_ref(), error.as_ref()) } {
                (Some(content), _) => Ok(Content(content.retain())),
                (None, Some(error)) => Err(error.code()),
                (None, None) => Err(0),
            };
            let _ = tx.try_send(answer);
        },
    );
    // SAFETY: the block has the signature the method declares, and owns
    // everything it touches.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    let content = match rx.recv_timeout(SCK_TIMEOUT) {
        Ok(Ok(content)) => content,
        Ok(Err(code)) => return Err(sck_error(code, "list the shareable displays")),
        Err(_) => bail!("screencapturekit did not list the shareable displays within 5 s"),
    };
    // SAFETY: a plain read of an immutable snapshot.
    unsafe { content.0.displays() }
        .iter()
        .next()
        .context("screencapturekit lists no display (an asleep display is not listed)")
}

/// Make one ScreenCaptureKit call whose completion handler takes an optional
/// error, and wait for it. `what` finishes "screencapturekit could not …".
fn completion(
    what: &str,
    call: impl FnOnce(&block2::DynBlock<dyn Fn(*mut NSError)>),
) -> Result<()> {
    let (tx, rx) = mpsc::sync_channel::<Option<isize>>(1);
    let handler = RcBlock::new(move |error: *mut NSError| {
        // SAFETY: null, or an error the framework keeps alive for this call.
        let _ = tx.try_send(unsafe { error.as_ref() }.map(|error| error.code()));
    });
    call(&handler);
    match rx.recv_timeout(SCK_TIMEOUT) {
        Ok(None) => Ok(()),
        Ok(Some(code)) => Err(sck_error(code, what)),
        Err(_) => bail!("screencapturekit did not {what} within 5 s"),
    }
}

fn sck_error(code: isize, what: &str) -> anyhow::Error {
    if code == SCStreamErrorCode::UserDeclined.0 {
        anyhow!("screen recording is not granted: screencapturekit refused to {what} ({code})")
    } else {
        anyhow!("screencapturekit could not {what} ({code})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLANAR_FLOAT: Layout = Layout {
        format: LINEAR_PCM,
        // Packed and native-endian beside the two flags that matter, as
        // CoreAudio sets them.
        flags: FLAG_IS_FLOAT | FLAG_NON_INTERLEAVED | (1 << 3),
        bits: 32,
        channels: 2,
        rate: 48_000.0,
    };

    #[test]
    fn only_planar_float_stereo_at_48_khz_is_converted() {
        assert!(PLANAR_FLOAT.is_planar_float_stereo_48k());
        for (why, layout) in [
            (
                "interleaved",
                Layout {
                    flags: FLAG_IS_FLOAT,
                    ..PLANAR_FLOAT
                },
            ),
            (
                "integer",
                Layout {
                    flags: FLAG_NON_INTERLEAVED,
                    bits: 16,
                    ..PLANAR_FLOAT
                },
            ),
            (
                "64-bit",
                Layout {
                    bits: 64,
                    ..PLANAR_FLOAT
                },
            ),
            (
                "44.1 khz",
                Layout {
                    rate: 44_100.0,
                    ..PLANAR_FLOAT
                },
            ),
            (
                "mono",
                Layout {
                    channels: 1,
                    ..PLANAR_FLOAT
                },
            ),
            (
                "not linear pcm",
                Layout {
                    format: u32::from_be_bytes(*b"aac "),
                    ..PLANAR_FLOAT
                },
            ),
        ] {
            assert!(!layout.is_planar_float_stereo_48k(), "{why} was accepted");
        }
    }

    #[test]
    fn a_refused_layout_says_what_arrived() {
        let interleaved = Layout {
            flags: FLAG_IS_FLOAT,
            ..PLANAR_FLOAT
        };
        assert_eq!(
            Refusal::Layout(interleaved).to_string(),
            "screencapturekit delivered 'lpcm' 48000 hz 2 channels 32-bit float interleaved, \
             not 48000 hz 2 channels 32-bit float planar"
        );
    }

    #[test]
    fn a_float_sample_becomes_16_bit_and_clips_at_full_scale() {
        assert_eq!(to_i16(0.0), 0);
        assert_eq!(to_i16(1.0), i16::MAX);
        assert_eq!(to_i16(-1.0), -i16::MAX);
        assert_eq!(to_i16(0.5), 16_383);
        assert_eq!(to_i16(2.0), i16::MAX, "past full scale clips");
        assert_eq!(to_i16(-2.0), i16::MIN, "past full scale clips");
        assert_eq!(to_i16(f32::NAN), 0);
    }

    #[test]
    fn two_planes_interleave_left_first() {
        let mut queue = vec![9];
        assert!(append_interleaved(
            &mut queue,
            &[1.0, 0.0, -1.0],
            &[0.5, 0.25, 0.0],
            QUEUED_SAMPLES
        ));
        assert_eq!(queue, vec![9, i16::MAX, 16_383, 0, 8_191, -i16::MAX, 0]);
    }

    /// A stalled reader loses whole buffers, never half of one, and the queue
    /// never grows past its bound.
    #[test]
    fn a_full_queue_refuses_the_whole_buffer() {
        let plane = [0.1f32; 4];
        let mut queue = Vec::new();
        assert!(append_interleaved(&mut queue, &plane, &plane, 16));
        assert!(append_interleaved(&mut queue, &plane, &plane, 16));
        assert_eq!(queue.len(), 16);
        assert!(!append_interleaved(&mut queue, &plane, &plane, 16));
        assert_eq!(queue.len(), 16);
    }

    #[test]
    fn the_bound_is_200_ms_of_stereo() {
        assert_eq!(QUEUED_SAMPLES, 19_200);
    }

    /// The mirrors of CoreAudio's structs: `AudioBufferList` puts its first
    /// `AudioBuffer` at 8 on a 64-bit Mac, and each buffer is 16 bytes.
    #[test]
    fn the_buffer_list_has_coreaudio_s_layout() {
        assert_eq!(size_of::<Buffer>(), 16);
        assert_eq!(std::mem::offset_of!(BufferList, buffers), 8);
        assert_eq!(size_of::<BufferList>(), 40);
        assert_eq!(size_of::<PropertyAddress>(), 12);
    }

    #[test]
    fn the_four_char_codes_are_coreaudio_s() {
        assert_eq!(LINEAR_PCM, 0x6c70_636d);
        assert_eq!(DEFAULT_OUTPUT_DEVICE, 0x644f_7574);
        assert_eq!(SCOPE_GLOBAL, 0x676c_6f62);
    }

    /// Hardware. See the module doc.
    #[test]
    #[ignore = "reads the mac's audio devices; cargo test ... -- --ignored audio::sck"]
    fn reports_whether_this_mac_has_a_default_output_device() {
        println!(
            "default output device present: {}",
            render_endpoint_present()
        );
    }

    /// Hardware, and it **listens to whatever this Mac is playing** for a
    /// second. See the module doc.
    #[test]
    #[ignore = "needs the screen recording grant and records the mac's audio; cargo test ... -- --ignored audio::sck"]
    fn captures_whatever_this_mac_is_playing() {
        use std::time::Instant;

        assert!(
            CGPreflightScreenCaptureAccess(),
            "this shell has no screen recording grant; the test would raise a prompt"
        );
        let opened = Instant::now();
        let loopback = Loopback::open().expect("open the audio capture");
        let open_ms = opened.elapsed().as_millis();

        // The capture loop's own turn beside the capture: how often the
        // frame clock had to fill a hole while something played.
        let mut timeline = super::super::opus::Timeline::new();
        let mut frame = vec![0i16; super::super::opus::FRAME_SAMPLES];
        let started = Instant::now();
        let mut pcm = Vec::new();
        let (mut first, mut largest) = (None, 0);
        while started.elapsed() < Duration::from_secs(1) {
            let before = pcm.len();
            let drained = loopback.drain(&mut pcm).expect("drain");
            if drained > 0 && first.is_none() {
                first = Some(started.elapsed().as_millis());
            }
            largest = largest.max(drained);
            timeline.push(&pcm[before..]);
            timeline.fill_to(started.elapsed());
            while timeline.next_frame(&mut frame).is_some() {}
            std::thread::sleep(Duration::from_millis(10));
        }
        let peak = pcm.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
        let layout = loopback.shared.layout.get().copied();
        println!(
            "opened in {open_ms} ms; layout {}; first samples after {} ms; captured {} samples \
             ({} ms of stereo), peak {peak}, at most {largest} in one drain; {} buffers not \
             converted; the frame clock made {} frames, {} of them comfort silence",
            layout.map_or("none (no buffer arrived)".to_owned(), |l| l.to_string()),
            first.map_or("never".to_owned(), |ms| ms.to_string()),
            pcm.len(),
            pcm.len() / CHANNELS * 1000 / SAMPLE_RATE_HZ as usize,
            loopback.shared.unconverted.load(Ordering::Relaxed),
            timeline.frames_emitted(),
            timeline.silence_frames(),
        );
        if let Some(layout) = layout {
            assert!(layout.is_planar_float_stereo_48k(), "{layout}");
        }
        assert_eq!(loopback.shared.unconverted.load(Ordering::Relaxed), 0);
    }
}
