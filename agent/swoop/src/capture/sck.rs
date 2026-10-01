//! macOS capture: ScreenCaptureKit, one `SCStream` per captured display.
//!
//! The stream is opened at the display's native pixel size (decision 13), in
//! NV12 video range (`420v`) with BT.709 colour, at most 60 frames a second,
//! with a queue depth of 4 and no audio. The cursor is left out of the picture
//! unless the caller asks for it: the viewer draws its own overlay from the
//! [`PointerSampler`] this source calls on every step (decision 7).
//!
//! # What a frame's handle is
//!
//! [`Frame::handle`] is a `CVPixelBufferRef`: IOSurface-backed, `420v`, at
//! [`Source::size`]. The source holds one retain on it, and it stays valid
//! until the source hands out a newer picture, rebuilds, or is dropped. The
//! session's floor re-sends that handle after an empty poll, which is why the
//! last buffer is held here and not given back to ScreenCaptureKit's pool. A
//! consumer that needs it longer retains it itself; VideoToolbox does that for
//! a frame it is encoding.
//!
//! # Delivery
//!
//! ScreenCaptureKit calls the output handler on a serial dispatch queue of our
//! own. The handler reads the frame's status from the sample buffer's
//! attachments and passes on only `complete` frames: the others carry no new
//! picture. It retains the image buffer and queues it, stamped with its
//! presentation time as [`crate::platform::clock`] ticks (the host clock SCK stamps
//! on, decision 14) but never later than its delivery, in a queue of two where
//! the newest wins, so a capture thread that falls behind never holds up
//! ScreenCaptureKit and always reads recent pictures.
//!
//! # Recovery
//!
//! A stream that stops (`stream:didStopWithError:`) or a bumped
//! [`RebuildSignal`] is rebuilt inside the source, on the next call: a new
//! stream, retried every 50 ms for up to 10 s, at the display's size read
//! again. The held buffer is dropped and an IDR is requested, as the Windows
//! source does after an ACCESS_LOST. Only a rebuild that never comes back is
//! an error, because the session reads any error as exit 12.
//!
//! One stop is not rebuilt: the person at the Mac stopping the capture from
//! the menu bar's capture indicator (-3817, `SCStreamErrorUserStopped`).
//! Rebuilding would override them, so the next call answers
//! [`StoppedAtHost`] instead, which the session ends on as it does on a
//! `kill`, with code 0 (swoop-macos owner decision 7).
//!
//! # Hardware test
//!
//! ```text
//! CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --locked --no-default-features \
//!     --features encode-videotoolbox,audio-opus -- --ignored --nocapture capture
//! ```
//!
//! With the working directory `agent/swoop`, on a Mac whose shell holds the
//! Screen Recording grant (without it ScreenCaptureKit would ask, so the test
//! refuses first) and whose display is awake: an asleep display is in neither
//! CoreGraphics' active list nor ScreenCaptureKit's, so over ssh run
//! `caffeinate -u -t 2` first and hold it awake with `caffeinate -d` for the
//! run. It opens a stream on every attached display in turn, for a few seconds
//! each, and prints sizes, timings and frame-status counts only: nothing is
//! saved. The menu bar shows the system's capture indicator while it runs.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass, Message};
use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained};
use objc2_core_graphics::{kCGColorSpaceITUR_709, CGPreflightScreenCaptureAccess};
use objc2_core_media::{CMSampleBuffer, CMTime, CMTimeFlags};
use objc2_core_video::{
    kCVImageBufferYCbCrMatrix_ITU_R_709_2, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    CVPixelBuffer, CVPixelBufferGetHeight, CVPixelBufferGetWidth,
};
use objc2_foundation::{NSArray, NSError, NSString};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCFrameStatus, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamErrorCode, SCStreamFrameInfoStatus, SCStreamOutput,
    SCStreamOutputType,
};

use super::{FrameRects, OutputInfo, RebuildSignal, Rect, Source};
use crate::cursor::{PointerSample, PointerSampler};
use crate::displays::mac as displays;
use crate::gpu::Frame;
use crate::platform::clock;
use crate::session::StoppedAtHost;

/// How long any ScreenCaptureKit completion handler is waited for. They
/// answer in well under a second when they answer at all; this bounds a hang.
const SCK_TIMEOUT: Duration = Duration::from_secs(5);

/// A rebuild's retry cadence and deadline, the Windows source's numbers: a
/// source that never comes back is exit 12 rather than a hung session.
const REBUILD_RETRY: Duration = Duration::from_millis(50);
const REBUILD_DEADLINE: Duration = Duration::from_secs(10);

/// Frames queued between the output handler and the capture thread.
const QUEUED_FRAMES: usize = 2;

/// ScreenCaptureKit's own surface pool. Two queued, one held for the floor and
/// one in the handler is four, so a slow reader never starves the stream.
const QUEUE_DEPTH: isize = 4;

const MAX_FPS: i32 = 60;

/// `SCFrameStatus` by its raw value, plus one slot for anything else.
const STATUS_NAMES: [&str; 7] = [
    "complete",
    "idle",
    "blank",
    "suspended",
    "started",
    "stopped",
    "unknown",
];

/// A capture of one display through ScreenCaptureKit.
pub struct ScreenCapture {
    output: OutputInfo,
    display: u32,
    size: (u32, u32),
    rects: FrameRects,
    live: Option<Live>,
    signal: RebuildSignal,
    generation: u64,
    /// The last picture handed out, retained for the floor.
    held: Option<PixelBuffer>,
    idr_requested: bool,
    sampler: Box<dyn PointerSampler>,
    cursor_in_frame: bool,
    hz: i64,
}

impl ScreenCapture {
    /// Open a stream on the display `output` names. A refused grant (-3801)
    /// or a display that is not attached is an error here, which the session
    /// turns into exit 12. `signal` is shared with the session, which bumps it
    /// to rebuild every source at once.
    pub fn open_with(
        output: &OutputInfo,
        signal: RebuildSignal,
        sampler: Box<dyn PointerSampler>,
        cursor_in_frame: bool,
    ) -> anyhow::Result<Self> {
        let display = displays::display_id(output)
            .with_context(|| format!("{} is not a macos display", output.device_name))?;
        let mut source = Self {
            output: output.clone(),
            display,
            size: (0, 0),
            rects: FrameRects::default(),
            live: None,
            generation: signal.generation(),
            signal,
            held: None,
            idr_requested: false,
            sampler,
            cursor_in_frame,
            hz: clock::hz()?,
        };
        source.start()?;
        Ok(source)
    }

    /// Read again on every rebuild: a mode change moves the display's rect.
    pub fn output(&self) -> &OutputInfo {
        &self.output
    }

    /// The whole frame: ScreenCaptureKit's dirty rects are not read.
    pub fn last_rects(&self) -> &FrameRects {
        &self.rects
    }

    /// True once after every (re)build: the decoder's references belong to a
    /// stream that no longer exists.
    pub fn take_idr_request(&mut self) -> bool {
        std::mem::take(&mut self.idr_requested)
    }

    /// Mark every source sharing the signal stale.
    pub fn request_rebuild(&self) {
        self.signal.bump();
    }

    /// [`Source::next_frame`], after one pointer sample for `observer`.
    ///
    /// The sample comes first and on every call, so the cursor moves on a
    /// static desktop too. A stale stream is rebuilt here and answers
    /// `Ok(None)`; one the person at the Mac stopped answers [`StoppedAtHost`];
    /// otherwise this waits up to `timeout_ms` for a picture.
    pub fn next_frame_with(
        &mut self,
        timeout_ms: u32,
        observer: &mut dyn FnMut(&PointerSample),
    ) -> anyhow::Result<Option<Frame>> {
        observer(&self.sampler.sample());

        let ended = self
            .live
            .as_ref()
            .map_or(Some(Ended::BySystem), |live| live.shared.ended());
        if must_rebuild(ended, self.generation != self.signal.generation())? {
            self.rebuild()?;
            return Ok(None);
        }
        let Some(live) = self.live.as_ref() else {
            return Ok(None);
        };
        let Some(delivered) = live
            .shared
            .frames
            .recv_timeout(Duration::from_millis(timeout_ms.into()))
        else {
            return Ok(None);
        };
        let size = (delivered.width, delivered.height);
        if size != self.size {
            self.size = size;
            self.rects = whole_frame(size);
        }
        let frame = Frame {
            handle: delivered.buffer.handle(),
            width: size.0,
            height: size.1,
            captured_qpc: delivered.ticks,
        };
        // Replacing the held buffer is what gives the previous one back.
        self.held = Some(delivered.buffer);
        Ok(Some(frame))
    }

    fn rebuild(&mut self) -> anyhow::Result<()> {
        ::log::info!(
            "swoop: rebuilding the capture of {}",
            self.output.device_name
        );
        let deadline = Instant::now() + REBUILD_DEADLINE;
        loop {
            match self.start() {
                Ok(()) => return Ok(()),
                Err(e) if Instant::now() >= deadline => {
                    return Err(e.context(format!(
                        "the capture of {} did not come back",
                        self.output.device_name
                    )));
                }
                Err(e) => {
                    ::log::debug!("swoop: capture rebuild: {e:#}");
                    std::thread::sleep(REBUILD_RETRY);
                }
            }
        }
    }

    /// Stop whatever runs, then open a new stream at the display's current
    /// size. One attempt; [`Self::rebuild`] is the retry.
    fn start(&mut self) -> anyhow::Result<()> {
        self.stop();
        // ScreenCaptureKit asks for the grant when it has none, and nothing
        // here may raise a prompt nobody clicked for.
        if !CGPreflightScreenCaptureAccess() {
            bail!("screen recording is not granted to this process");
        }
        let output = displays::output(self.display);
        let size = point_size(crate::platform::macos::display_point_rect(self.display));
        if size.0 == 0 || size.1 == 0 {
            bail!("{} is not attached", output.device_name);
        }
        let display = shareable_display(self.display)?;
        let shared = Arc::new(Shared::new(self.hz));
        let sink = Sink::new(Arc::clone(&shared));
        let queue = DispatchQueue::new("app.owlette.swoop.capture", None);
        // SAFETY: every argument is a live object of the type the method
        // declares; the empty array excludes no window.
        let stream = unsafe {
            let filter = SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::new(),
            );
            let config = configuration(size, self.cursor_in_frame);
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                Some(ProtocolObject::from_ref(&*sink)),
            )
        };
        // SAFETY: the queue is serial, and the sink outlives the stream: both
        // live in `Live`, which stops the stream before either is dropped.
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*sink),
                SCStreamOutputType::Screen,
                Some(&*queue),
            )
        }
        .map_err(|e| sck_error(e.code(), "add the stream output"))?;
        // SAFETY: the handler has the signature the method declares.
        completion("start the capture", |handler| unsafe {
            stream.startCaptureWithCompletionHandler(Some(handler))
        })?;

        ::log::info!(
            "swoop: capturing {} at {}x{}",
            output.device_name,
            size.0,
            size.1
        );
        self.output = output;
        self.size = size;
        self.rects = whole_frame(size);
        self.live = Some(Live {
            stream,
            _sink: sink,
            shared,
            _queue: queue,
        });
        self.generation = self.signal.generation();
        self.idr_requested = true;
        Ok(())
    }

    /// Stop the stream and let go of every buffer it handed out.
    fn stop(&mut self) {
        self.held = None;
        let Some(live) = self.live.take() else {
            return;
        };
        // A stream that already stopped answers with an error; either way it
        // delivers nothing after the answer.
        // SAFETY: the handler has the signature the method declares.
        if let Err(e) = completion("stop the capture", |handler| unsafe {
            live.stream.stopCaptureWithCompletionHandler(Some(handler))
        }) {
            ::log::debug!("swoop: capture stop: {e:#}");
        }
        ::log::debug!(
            "swoop: {} stream ended, frame statuses: {}",
            self.output.device_name,
            live.shared.status_counts()
        );
    }
}

impl Drop for ScreenCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Source for ScreenCapture {
    fn next_frame(&mut self, timeout_ms: u32) -> anyhow::Result<Option<Frame>> {
        self.next_frame_with(timeout_ms, &mut |_| {})
    }

    /// The last delivered buffer's size, which before the first frame is the
    /// size the stream was opened at.
    fn size(&self) -> (u32, u32) {
        self.size
    }
}

/// One running stream and what it calls back into.
struct Live {
    stream: Retained<SCStream>,
    /// The stream's output and delegate, held for as long as the stream
    /// runs: Cocoa does not promise that a stream keeps its delegate alive.
    _sink: Retained<Sink>,
    shared: Arc<Shared>,
    _queue: DispatchRetained<DispatchQueue>,
}

// SAFETY: the stream is only started and stopped from the thread that owns
// this source, one call at a time, and ScreenCaptureKit takes both calls from
// any thread; everything else here is `Send` already.
unsafe impl Send for Live {}

/// A retained `CVPixelBuffer`.
struct PixelBuffer(CFRetained<CVPixelBuffer>);

// SAFETY: CoreVideo's retain count is atomic and nothing here writes to the
// pixels; the buffer moves from ScreenCaptureKit's queue to the capture
// thread, which is what CoreVideo buffers are made for.
unsafe impl Send for PixelBuffer {}

impl PixelBuffer {
    fn handle(&self) -> usize {
        CFRetained::as_ptr(&self.0).as_ptr() as usize
    }
}

/// A picture the output handler passed on.
struct Delivered {
    buffer: PixelBuffer,
    /// Its presentation time as `platform::clock` ticks, clamped to its
    /// delivery.
    ticks: i64,
    width: u32,
    height: u32,
}

/// How a stream stopped, as its delegate heard it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ended {
    /// Anything the system did: a display that went, a server that
    /// restarted. Rebuilt inside the source.
    BySystem,
    /// The person at the Mac, from the menu bar's capture indicator. The
    /// session ends.
    ByUser,
}

impl Ended {
    fn from_code(code: isize) -> Self {
        if code == SCStreamErrorCode::UserStopped.0 {
            Self::ByUser
        } else {
            Self::BySystem
        }
    }
}

/// Whether the capture thread rebuilds the stream before its next picture:
/// yes for a stream the system stopped or one the signal marked stale, and
/// [`StoppedAtHost`] for one the person at the Mac stopped, because a rebuild
/// would start it again over them.
fn must_rebuild(ended: Option<Ended>, stale: bool) -> anyhow::Result<bool> {
    match ended {
        Some(Ended::ByUser) => Err(StoppedAtHost.into()),
        Some(Ended::BySystem) => Ok(true),
        None => Ok(stale),
    }
}

/// What the output handler and the capture thread share for one stream.
struct Shared {
    frames: Newest<Delivered>,
    /// Set once, by the delegate: a stream stops at most once.
    ended: OnceLock<Ended>,
    statuses: [AtomicU64; STATUS_NAMES.len()],
    hz: i64,
}

impl Shared {
    fn new(hz: i64) -> Self {
        Self {
            frames: Newest::new(QUEUED_FRAMES),
            ended: OnceLock::new(),
            statuses: Default::default(),
            hz,
        }
    }

    /// How the stream stopped, or `None` while it runs.
    fn ended(&self) -> Option<Ended> {
        self.ended.get().copied()
    }

    /// The output handler. Runs on the stream's queue and must not panic.
    fn deliver(&self, sample: &CMSampleBuffer) {
        let status = frame_status(sample);
        let slot = status_slot(status);
        let seen = self.statuses[slot].fetch_add(1, Ordering::Relaxed);
        if status != Some(SCFrameStatus::Complete) {
            if seen == 0 {
                ::log::debug!("swoop: first {} frame on this stream", STATUS_NAMES[slot]);
            }
            return;
        }
        // SAFETY: the sample buffer is live for this call; the image buffer
        // comes back retained.
        let Some(buffer) = (unsafe { sample.image_buffer() }) else {
            return;
        };
        // SAFETY: a plain read of the sample's timing.
        let presented = unsafe { sample.presentation_time_stamp() };
        // The presentation time is the frame's display time, and it was
        // measured up to 10.7 ms ahead of its delivery (27 of 47 frames on the
        // rig). A stamp never runs ahead of the moment the picture is in hand,
        // or the viewer's latency breakdown would go negative.
        let now = clock::now_ticks();
        let delivered = Delivered {
            ticks: ticks_from(presented, self.hz).map_or(now, |ticks| ticks.min(now)),
            width: CVPixelBufferGetWidth(&buffer) as u32,
            height: CVPixelBufferGetHeight(&buffer) as u32,
            buffer: PixelBuffer(buffer),
        };
        // The displaced frame, if any, goes back to the pool here, outside
        // the queue's lock.
        drop(self.frames.push(delivered));
    }

    /// The delegate's `stream:didStopWithError:`, with the error's code.
    fn stopped(&self, code: isize) {
        let ended = Ended::from_code(code);
        match ended {
            Ended::ByUser => ::log::info!(
                "swoop: the person at the mac stopped the capture from the menu bar, so the session ends"
            ),
            Ended::BySystem => {
                ::log::warn!("swoop: the capture stream stopped (screencapturekit {code})");
            }
        }
        let _ = self.ended.set(ended);
    }

    fn status_counts(&self) -> String {
        STATUS_NAMES
            .iter()
            .zip(&self.statuses)
            .map(|(name, count)| format!("{name} {}", count.load(Ordering::Relaxed)))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and `Sink` has no
    // `Drop` of its own: its ivars drop with it.
    #[unsafe(super(NSObject))]
    #[ivars = Arc<Shared>]
    struct Sink;

    unsafe impl NSObjectProtocol for Sink {}

    unsafe impl SCStreamOutput for Sink {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(
            &self,
            _stream: &SCStream,
            sample: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            if kind == SCStreamOutputType::Screen {
                self.ivars().deliver(sample);
            }
        }
    }

    unsafe impl SCStreamDelegate for Sink {
        #[unsafe(method(stream:didStopWithError:))]
        fn stream_did_stop(&self, _stream: &SCStream, error: &NSError) {
            self.ivars().stopped(error.code());
        }
    }
);

impl Sink {
    fn new(shared: Arc<Shared>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(shared);
        // SAFETY: `init` is NSObject's designated initialiser.
        unsafe { msg_send![super(this), init] }
    }
}

/// A bounded queue where a push to a full queue drops the oldest entry.
struct Newest<T> {
    queue: Mutex<VecDeque<T>>,
    ready: Condvar,
    capacity: usize,
}

impl<T> Newest<T> {
    fn new(capacity: usize) -> Self {
        Self {
            queue: Mutex::new(VecDeque::with_capacity(capacity)),
            ready: Condvar::new(),
            capacity,
        }
    }

    /// Queue `item`, answering the entry it displaced so the caller drops it
    /// outside the lock.
    fn push(&self, item: T) -> Option<T> {
        let mut queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
        let displaced = if queue.len() >= self.capacity {
            queue.pop_front()
        } else {
            None
        };
        queue.push_back(item);
        drop(queue);
        self.ready.notify_one();
        displaced
    }

    /// The oldest queued entry, waiting up to `timeout` for one.
    fn recv_timeout(&self, timeout: Duration) -> Option<T> {
        let queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
        let (mut queue, _) = self
            .ready
            .wait_timeout_while(queue, timeout, |queue| queue.is_empty())
            .unwrap_or_else(PoisonError::into_inner);
        queue.pop_front()
    }
}

/// The capture configuration: [`point_size`], NV12 video range, BT.709.
fn configuration(size: (u32, u32), cursor_in_frame: bool) -> Retained<SCStreamConfiguration> {
    // SAFETY: plain setters on a fresh configuration; the two colour names
    // are the frameworks' own constants.
    unsafe {
        let config = SCStreamConfiguration::new();
        config.setWidth(size.0 as usize);
        config.setHeight(size.1 as usize);
        config.setPixelFormat(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
        config.setColorSpaceName(kCGColorSpaceITUR_709);
        config.setColorMatrix(kCVImageBufferYCbCrMatrix_ITU_R_709_2);
        config.setMinimumFrameInterval(CMTime::new(1, MAX_FPS));
        config.setQueueDepth(QUEUE_DEPTH);
        config.setCapturesAudio(false);
        config.setShowsCursor(cursor_in_frame);
        config
    }
}

/// ScreenCaptureKit's view of display `id`. Its completion handler answers on
/// a queue of the framework's, onto a channel, as `selfcheck`'s does.
fn shareable_display(id: u32) -> anyhow::Result<Retained<SCDisplay>> {
    /// An immutable snapshot, handed from the framework's queue to this thread.
    struct Content(Retained<SCShareableContent>);
    // SAFETY: the content is never mutated, and only read after the handoff.
    unsafe impl Send for Content {}

    let (tx, rx) = mpsc::sync_channel::<Result<Content, isize>>(1);
    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // SAFETY: each is null or an object the framework keeps alive for the
            // length of this call; the retain keeps the content past it.
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
    // SAFETY: plain reads of an immutable snapshot.
    unsafe { content.0.displays() }
        .iter()
        .find(|display| unsafe { display.displayID() } == id)
        .with_context(|| format!("{} is not a shareable display", displays::device_name(id)))
}

/// Make one ScreenCaptureKit call whose completion handler takes an optional
/// error, and wait for it. `what` finishes "screencapturekit could not …".
fn completion(
    what: &str,
    call: impl FnOnce(&block2::DynBlock<dyn Fn(*mut NSError)>),
) -> anyhow::Result<()> {
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

/// The frame's `SCFrameStatus`, from the first sample attachment dictionary.
fn frame_status(sample: &CMSampleBuffer) -> Option<SCFrameStatus> {
    // SAFETY: the sample buffer is live for this call.
    let attachments = unsafe { sample.sample_attachments_array(false) }?;
    if attachments.is_empty() {
        return None;
    }
    // SAFETY: a constant the framework exports.
    let key: &NSString = unsafe { SCStreamFrameInfoStatus };
    // SAFETY: index 0 is in bounds; each entry of a sample attachments array
    // is a dictionary, and its status value, when present, is a number. The
    // array is ours (retained) and nothing mutates it during these reads.
    unsafe {
        let dictionary = &*attachments.value_at_index(0).cast::<CFDictionary>();
        let value = dictionary.value((key as *const NSString).cast());
        let number = value.cast::<CFNumber>().as_ref()?;
        number.as_isize().map(SCFrameStatus)
    }
}

fn status_slot(status: Option<SCFrameStatus>) -> usize {
    status
        .and_then(|status| usize::try_from(status.0).ok())
        .filter(|&slot| slot < STATUS_NAMES.len() - 1)
        .unwrap_or(STATUS_NAMES.len() - 1)
}

/// A presentation time on the host clock as `platform::clock` ticks at `hz`,
/// or `None` for a time that is not valid.
fn ticks_from(time: CMTime, hz: i64) -> Option<i64> {
    if !time.flags.contains(CMTimeFlags::Valid) || time.timescale <= 0 {
        return None;
    }
    let ticks = i128::from(time.value) * i128::from(hz) / i128::from(time.timescale);
    i64::try_from(ticks).ok()
}

/// The size a stream is opened at: the display's size in points, each side
/// made even for 4:2:0. At gate M1 a full Retina picture (3420x2214) encoded in
/// 24 ms at p50 and 37 ms at p95, so a session that waits on each frame ran at
/// 25-40 fps and smeared on every window move; shrunk to its size in points
/// after capture it stopped smearing but still dropped frames. Captured at that
/// size, ScreenCaptureKit scales in the compositor and nothing here pays for
/// it. Positions and input still map through the pixel rect; only the picture
/// is smaller.
fn point_size(points: (f64, f64, f64, f64)) -> (u32, u32) {
    let even = |side: f64| (side.max(0.0) as u32) & !1;
    (even(points.2), even(points.3))
}

fn whole_frame(size: (u32, u32)) -> FrameRects {
    FrameRects {
        moves: Vec::new(),
        dirty: vec![Rect {
            left: 0,
            top: 0,
            right: size.0 as i32,
            bottom: size.1 as i32,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::ACQUIRE_TIMEOUT_MS;

    fn time(value: i64, timescale: i32, flags: CMTimeFlags) -> CMTime {
        CMTime {
            value,
            timescale,
            flags,
            epoch: 0,
        }
    }

    #[test]
    fn a_presentation_time_becomes_clock_ticks() {
        // Host time in nanoseconds, as CoreMedia's host clock stamps it.
        assert_eq!(
            ticks_from(
                time(123_456_789_000, 1_000_000_000, CMTimeFlags::Valid),
                1_000_000_000
            ),
            Some(123_456_789_000)
        );
        // Mach ticks at 24 MHz, the Apple silicon timebase: 2.4M is 100 ms.
        assert_eq!(
            ticks_from(
                time(2_400_000, 24_000_000, CMTimeFlags::Valid),
                1_000_000_000
            ),
            Some(100_000_000)
        );
        // A month of uptime in nanoseconds does not overflow on the way.
        let month = 30 * 86_400 * 1_000_000_000i64;
        assert_eq!(
            ticks_from(
                time(month, 1_000_000_000, CMTimeFlags::Valid),
                1_000_000_000
            ),
            Some(month)
        );
        assert_eq!(
            ticks_from(time(1, 60, CMTimeFlags::empty()), 1_000_000_000),
            None
        );
        assert_eq!(
            ticks_from(time(1, 0, CMTimeFlags::Valid), 1_000_000_000),
            None
        );
    }

    /// A panel at a negative origin is opened at its size in points, each
    /// side even, and its one dirty rect is the whole of that picture.
    #[test]
    fn a_stream_is_opened_at_the_size_in_points_and_reports_the_whole_frame() {
        let size = point_size((-1512.0, -120.0, 1512.0, 982.0));
        assert_eq!(size, (1512, 982));
        assert_eq!(point_size((0.0, 0.0, 1710.0, 1107.0)), (1710, 1106));
        let rects = whole_frame(size);
        assert!(rects.moves.is_empty());
        assert_eq!(
            rects.dirty,
            vec![Rect {
                left: 0,
                top: 0,
                right: 1512,
                bottom: 982
            }]
        );
    }

    #[test]
    fn an_unknown_frame_status_has_its_own_slot() {
        assert_eq!(
            STATUS_NAMES[status_slot(Some(SCFrameStatus::Complete))],
            "complete"
        );
        assert_eq!(STATUS_NAMES[status_slot(Some(SCFrameStatus::Idle))], "idle");
        assert_eq!(
            STATUS_NAMES[status_slot(Some(SCFrameStatus::Stopped))],
            "stopped"
        );
        assert_eq!(STATUS_NAMES[status_slot(Some(SCFrameStatus(6)))], "unknown");
        assert_eq!(
            STATUS_NAMES[status_slot(Some(SCFrameStatus(-1)))],
            "unknown"
        );
        assert_eq!(STATUS_NAMES[status_slot(None)], "unknown");
    }

    #[test]
    fn the_newest_frames_win_a_full_queue() {
        let queue = Newest::new(2);
        assert_eq!(queue.push(1), None);
        assert_eq!(queue.push(2), None);
        // Full: the oldest makes way, and is handed back to be dropped.
        assert_eq!(queue.push(3), Some(1));
        assert_eq!(queue.recv_timeout(Duration::ZERO), Some(2));
        assert_eq!(queue.recv_timeout(Duration::ZERO), Some(3));
        assert_eq!(queue.recv_timeout(Duration::ZERO), None);
    }

    /// Owner decision 7: -3817 is the delegate's word for the person at the
    /// Mac stopping the capture from the menu bar. That ends the session and
    /// is never rebuilt, even over a stale signal; every other stop is.
    #[test]
    fn a_stop_from_the_menu_bar_ends_the_session_and_any_other_is_rebuilt() {
        let running = Shared::new(1_000_000_000);
        assert_eq!(must_rebuild(running.ended(), false).ok(), Some(false));
        assert_eq!(must_rebuild(running.ended(), true).ok(), Some(true));

        let by_user = Shared::new(1_000_000_000);
        by_user.stopped(-3817);
        for stale in [false, true] {
            let error = must_rebuild(by_user.ended(), stale).expect_err("the session ends");
            assert!(error.is::<StoppedAtHost>(), "{error:#}");
        }

        for code in [
            SCStreamErrorCode::FailedApplicationConnectionInterrupted,
            SCStreamErrorCode::NoCaptureSource,
            SCStreamErrorCode::InternalError,
            SCStreamErrorCode::SystemStoppedStream,
        ] {
            let shared = Shared::new(1_000_000_000);
            shared.stopped(code.0);
            assert_eq!(
                must_rebuild(shared.ended(), false).ok(),
                Some(true),
                "{code:?} is rebuilt"
            );
        }

        // A stream stops once; a later word does not rewrite the first.
        by_user.stopped(SCStreamErrorCode::InternalError.0);
        assert_eq!(by_user.ended(), Some(Ended::ByUser));
    }

    #[test]
    fn an_empty_queue_waits_out_its_timeout() {
        let queue = Newest::<u8>::new(2);
        let started = Instant::now();
        assert_eq!(queue.recv_timeout(Duration::from_millis(20)), None);
        assert!(started.elapsed() >= Duration::from_millis(20));
    }

    #[test]
    fn a_push_wakes_a_waiting_reader() {
        let queue = Arc::new(Newest::new(2));
        let writer = Arc::clone(&queue);
        let pushed = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            writer.push(7u8)
        });
        let started = Instant::now();
        assert_eq!(queue.recv_timeout(Duration::from_secs(5)), Some(7));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(pushed.join().expect("the writer ran"), None);
    }

    /// A pointer that never moves: the capture test is about pictures.
    struct Still;

    impl PointerSampler for Still {
        fn sample(&mut self) -> PointerSample<'_> {
            PointerSample {
                position: None,
                ts_ticks: clock::now_ticks(),
                shape: None,
            }
        }
    }

    fn ms(ticks: i64) -> f64 {
        ticks as f64 / 1e6
    }

    /// The next picture within `limit`, and how many calls it took.
    fn next_picture(source: &mut ScreenCapture, limit: Duration) -> (Frame, usize) {
        let deadline = Instant::now() + limit;
        let mut calls = 0;
        while Instant::now() < deadline {
            calls += 1;
            let mut observed = 0;
            let frame = source
                .next_frame_with(ACQUIRE_TIMEOUT_MS, &mut |_| observed += 1)
                .expect("capture");
            assert_eq!(observed, 1, "the sampler runs once on every call");
            if let Some(frame) = frame {
                return (frame, calls);
            }
        }
        panic!(
            "no picture from {} within {limit:?}",
            source.output().device_name
        );
    }

    fn held_handle(source: &ScreenCapture) -> Option<usize> {
        source.held.as_ref().map(PixelBuffer::handle)
    }

    fn statuses(source: &ScreenCapture) -> [u64; STATUS_NAMES.len()] {
        let live = source.live.as_ref().expect("a live stream");
        live.shared
            .statuses
            .each_ref()
            .map(|count| count.load(Ordering::Relaxed))
    }

    /// Now minus the picture's stamp, in ticks: never negative, since a stamp
    /// is clamped to its delivery, and under 100 ms.
    fn gap(frame: &Frame) -> i64 {
        let gap = clock::now_ticks() - frame.captured_qpc;
        assert!(
            (0..100_000_000).contains(&gap),
            "the frame is stamped {:.1} ms before now",
            ms(gap)
        );
        gap
    }

    #[test]
    #[ignore = "needs the screen recording grant and a display; cargo test ... -- --ignored capture"]
    fn a_frame_from_every_display_is_held_and_survives_a_rebuild() {
        assert!(
            CGPreflightScreenCaptureAccess(),
            "this shell has no screen recording grant; the test would raise a prompt"
        );
        let outputs = displays::outputs().expect("the displays");
        assert!(
            !outputs.is_empty(),
            "no active display: an asleep one is not listed (caffeinate -u -t 2 wakes it)"
        );
        for info in &outputs {
            let signal = RebuildSignal::new();
            let opened = Instant::now();
            let mut source = ScreenCapture::open_with(info, signal.clone(), Box::new(Still), false)
                .unwrap_or_else(|e| panic!("open {}: {e:#}", info.device_name));
            let open_ms = opened.elapsed().as_secs_f64() * 1e3;
            assert!(source.take_idr_request(), "a fresh stream needs an IDR");

            let (frame, calls) = next_picture(&mut source, Duration::from_secs(5));
            let mut gaps = vec![gap(&frame)];
            assert_eq!((frame.width, frame.height), source.size());
            let id = crate::platform::macos::display_for_pixel_rect(&info.desktop_rect)
                .expect("an attached display");
            assert_eq!(
                (frame.width, frame.height),
                point_size(crate::platform::macos::display_point_rect(id)),
                "the picture is not the display's size in points"
            );
            println!(
                "{} {}x{} opened in {open_ms:.0} ms, first picture after {calls} calls, stamped {:.1} ms before now",
                info.device_name,
                frame.width,
                frame.height,
                ms(gaps[0])
            );

            // The floor's contract: the handle stays retained and readable
            // across empty polls. A busy desktop resets the count on each
            // newer picture.
            let mut handle = frame.handle;
            let (mut empty, mut newer) = (0, 0);
            let deadline = Instant::now() + Duration::from_secs(10);
            while empty < 3 && Instant::now() < deadline {
                match source
                    .next_frame_with(ACQUIRE_TIMEOUT_MS, &mut |_| {})
                    .expect("capture")
                {
                    Some(frame) => {
                        gaps.push(gap(&frame));
                        handle = frame.handle;
                        newer += 1;
                        empty = 0;
                    }
                    None => {
                        assert_eq!(
                            held_handle(&source),
                            Some(handle),
                            "the held buffer changed"
                        );
                        // SAFETY: the source holds a retain on this buffer,
                        // which is the claim under test.
                        let buffer = unsafe { &*(handle as *const CVPixelBuffer) };
                        assert_eq!(
                            (
                                CVPixelBufferGetWidth(buffer) as u32,
                                CVPixelBufferGetHeight(buffer) as u32
                            ),
                            source.size()
                        );
                        empty += 1;
                    }
                }
            }
            assert_eq!(empty, 3, "never three empty polls in a row in 10 s");
            println!(
                "{} held one handle across {empty} empty polls ({newer} newer pictures first)",
                info.device_name
            );

            // Which statuses the stream sends while the test does nothing,
            // over three more seconds. Static only if nothing else on the
            // machine draws.
            let before = statuses(&source);
            let quiet_until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < quiet_until {
                if let Some(frame) = source
                    .next_frame_with(ACQUIRE_TIMEOUT_MS, &mut |_| {})
                    .expect("capture")
                {
                    gaps.push(gap(&frame));
                }
            }
            let after = statuses(&source);
            let window = STATUS_NAMES
                .iter()
                .zip(after.iter().zip(before))
                .map(|(name, (after, before))| format!("{name} {}", after - before))
                .collect::<Vec<_>>()
                .join(", ");
            println!(
                "{} frame statuses in 3 s left alone: {window}",
                info.device_name
            );

            // A rebuild through the signal: answered inside the source.
            signal.bump();
            let rebuilt = Instant::now();
            let answer = source
                .next_frame_with(ACQUIRE_TIMEOUT_MS, &mut |_| {})
                .expect("rebuild");
            let rebuild_ms = rebuilt.elapsed().as_secs_f64() * 1e3;
            assert!(answer.is_none(), "a rebuild answers no picture");
            assert!(source.take_idr_request(), "a rebuilt stream needs an IDR");
            assert_eq!(
                held_handle(&source),
                None,
                "the rebuild kept the old buffer"
            );
            let (frame, _) = next_picture(&mut source, Duration::from_secs(5));
            gaps.push(gap(&frame));
            println!(
                "{} rebuilt in {rebuild_ms:.0} ms, next picture {}x{} stamped {:.1} ms before now",
                info.device_name,
                frame.width,
                frame.height,
                ms(*gaps.last().expect("a gap"))
            );

            gaps.sort_unstable();
            println!(
                "{} stamp to now over {} pictures: min {:.1} ms, p50 {:.1} ms, max {:.1} ms",
                info.device_name,
                gaps.len(),
                ms(gaps[0]),
                ms(gaps[gaps.len() / 2]),
                ms(gaps[gaps.len() - 1]),
            );
        }
    }
}
