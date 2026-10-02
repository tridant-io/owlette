//! macOS: the seam's names over ScreenCaptureKit, VideoToolbox and
//! CoreGraphics, the host clock, the display helpers and `selfcheck`.
//!
//! Capture is [`ScreenCapture`] behind [`CaptureSource`], which adds what a
//! session needs of a Mac beyond the picture: the pointer, from a
//! [`CursorSampler`] (drawn into the picture instead when the system cursor
//! has no image for this process, decision 7), and a lit display. Scaling is
//! VideoToolbox's pixel transfer, injection is CoreGraphics' `CgInjector`,
//! and the desktop watcher never switches: the streamer runs inside the
//! console user's own session, which has one desktop. The process setup and
//! the watcher are the ones [`super::unsupported`] already has.
//!
//! **A session keeps the display lit** (owner decision 6). An asleep display
//! is listed by neither CoreGraphics nor ScreenCaptureKit, so a session on a
//! sleeping Mac would find nothing to capture. [`enumerate_outputs`] wakes the
//! display when it finds none, and every [`CaptureSource`] declares the user
//! active, which lights the display, and holds a `PreventUserIdleDisplaySleep`
//! assertion until it is dropped: from the session's start to the pause after
//! its last viewer, and again from the next viewer on. `probe` and `selfcheck`
//! take nothing.
//!
//! Decision 13: an `OutputInfo.desktop_rect` is in **pixels** — a display's
//! point origin times its scale, and its pixel size. On a mixed-scale layout
//! those origins are not one consistent global space, which only spanning
//! needs. The helpers below are the one spelling of the rule that capture,
//! input and the cursor share.

use std::net::{Ipv4Addr, UdpSocket};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2_core_foundation::CFString;
use objc2_core_graphics::{
    CGDisplayBounds, CGDisplayCopyDisplayMode, CGDisplayMode, CGError, CGGetActiveDisplayList,
    CGPreflightPostEventAccess, CGPreflightScreenCaptureAccess,
};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{SCShareableContent, SCStreamErrorCode};
use serde::Serialize;

pub use super::unsupported::{process, DesktopWatcher};
pub use crate::gpu::vt_transfer::{PixelTransfer as Downscaler, ScaleError};
pub use crate::input::CgInjector as InputInjector;

use crate::capture::sck::ScreenCapture;
use crate::capture::{FrameRects, OutputInfo, RebuildSignal, Rect, Source};
use crate::cursor::mac::CursorSampler;
use crate::cursor::{PointerSample, DEFAULT_DPI};
use crate::displays::mac as displays;
use crate::gpu::Frame;

// ------------------------------------------------------------------ capture ---

/// A capture of one display, with its pointer and a hold on the display.
pub struct CaptureSource {
    capture: ScreenCapture,
    /// Declared after the capture, so it is released after the stream stops.
    _awake: DisplayAwake,
}

impl CaptureSource {
    /// Light the display and hold it lit, then open the capture. The pointer
    /// is the viewer's overlay when the system cursor has an image for this
    /// process, and part of the picture when it has none (decision 7).
    pub fn open(output: &OutputInfo, signal: RebuildSignal) -> anyhow::Result<Self> {
        // A pause lets the display sleep, so the next viewer's capture can
        // find it gone from the list until the wake lands.
        let id = displays::display_id(output);
        let awake = wake(|ids| id.is_none_or(|id| ids.contains(&id)));
        let sampler = CursorSampler::new(output);
        let cursor_in_frame = !sampler.shapes_available();
        let capture = ScreenCapture::open_with(output, signal, Box::new(sampler), cursor_in_frame)?;
        Ok(Self {
            capture,
            _awake: awake,
        })
    }

    pub fn output(&self) -> &OutputInfo {
        self.capture.output()
    }

    pub fn last_rects(&self) -> &FrameRects {
        self.capture.last_rects()
    }

    pub fn take_idr_request(&mut self) -> bool {
        self.capture.take_idr_request()
    }

    pub fn request_rebuild(&self) {
        self.capture.request_rebuild();
    }

    pub fn next_frame_with(
        &mut self,
        timeout_ms: u32,
        observer: &mut dyn FnMut(&PointerSample),
    ) -> anyhow::Result<Option<Frame>> {
        self.capture.next_frame_with(timeout_ms, observer)
    }
}

impl Source for CaptureSource {
    fn next_frame(&mut self, timeout_ms: u32) -> anyhow::Result<Option<Frame>> {
        self.capture.next_frame(timeout_ms)
    }

    fn size(&self) -> (u32, u32) {
        self.capture.size()
    }
}

/// Every active display, in pixels. A Mac whose display sleeps lists none, so
/// when the list is empty the display is woken first and waited for. The hold
/// ends here: the capture takes its own a moment later.
pub fn enumerate_outputs() -> anyhow::Result<Vec<OutputInfo>> {
    if display_ids().is_empty() {
        drop(wake(|ids| !ids.is_empty()));
    }
    displays::outputs()
}

// ------------------------------------------------------------ display sleep ---

/// How long a woken display is waited for before capture goes on without it.
const WAKE_TIMEOUT: Duration = Duration::from_secs(5);
const WAKE_POLL: Duration = Duration::from_millis(50);

/// What `pmset -g assertions` shows beside the streamer's pid.
const ASSERTION_NAME: &str = "owlette swoop session";

/// `kIOPMAssertionTypePreventUserIdleDisplaySleep`.
const PREVENT_USER_IDLE_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";
/// `kIOPMAssertionLevelOn`.
const ASSERTION_LEVEL_ON: u32 = 255;
/// `kIOPMUserActiveLocal`: the kind of activity that lights the display.
const USER_ACTIVE_LOCAL: u32 = 0;
/// `kIOPMNullAssertionID`, and what a failed call leaves.
const NULL_ASSERTION: u32 = 0;

// IOKit's power assertions. No objc2 crate exports them (decision 15).
#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPMAssertionDeclareUserActivity(name: &CFString, user_type: u32, id: &mut u32) -> i32;
    fn IOPMAssertionCreateWithName(
        kind: &CFString,
        level: u32,
        name: &CFString,
        id: &mut u32,
    ) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}

/// The display's idle sleep, held off until this is dropped. Null when IOKit
/// refused, and capture goes on: a lit display captures without it.
struct DisplayAwake(u32);

impl Drop for DisplayAwake {
    fn drop(&mut self) {
        release(self.0);
    }
}

/// Declare the user active, which lights a sleeping display, and hold off its
/// idle sleep. When the display list did not satisfy `lit` before, poll it
/// until it does or [`WAKE_TIMEOUT`] passes; the caller reads the list again
/// either way. The declaration is let go once the wake is over, as
/// `caffeinate -u` lets go of its own: held for a session, it would tell the
/// system somebody is at the Mac for as long as anybody watches it.
fn wake(lit: impl Fn(&[u32]) -> bool) -> DisplayAwake {
    let asleep = !lit(&display_ids());
    let name = CFString::from_static_str(ASSERTION_NAME);
    let kind = CFString::from_static_str(PREVENT_USER_IDLE_DISPLAY_SLEEP);
    // SAFETY: the strings outlive both calls, and each writes one id.
    let activity = assertion("declare the user active", |id| unsafe {
        IOPMAssertionDeclareUserActivity(&name, USER_ACTIVE_LOCAL, id)
    });
    // SAFETY: as above.
    let awake = DisplayAwake(assertion("hold the display awake", |id| unsafe {
        IOPMAssertionCreateWithName(&kind, ASSERTION_LEVEL_ON, &name, id)
    }));
    if asleep {
        let started = Instant::now();
        while !lit(&display_ids()) && started.elapsed() < WAKE_TIMEOUT {
            std::thread::sleep(WAKE_POLL);
        }
        if lit(&display_ids()) {
            ::log::info!(
                "swoop: the display was asleep and woke in {} ms",
                started.elapsed().as_millis()
            );
        } else {
            ::log::warn!("swoop: the display was asleep and did not wake within {WAKE_TIMEOUT:?}");
        }
    }
    release(activity);
    awake
}

/// One IOKit assertion call: the id it wrote, or the null id and a log line
/// when it refused.
fn assertion(what: &str, call: impl FnOnce(&mut u32) -> i32) -> u32 {
    let mut id = NULL_ASSERTION;
    match call(&mut id) {
        0 => id,
        code => {
            ::log::warn!("swoop: could not {what} (iokit {code:#x})");
            NULL_ASSERTION
        }
    }
}

fn release(id: u32) {
    if id != NULL_ASSERTION {
        // SAFETY: an id an assertion call wrote and nothing has released.
        unsafe { IOPMAssertionRelease(id) };
    }
}

pub mod clock {
    /// Nanoseconds of `CLOCK_UPTIME_RAW`, the clock `mach_absolute_time` counts
    /// and ScreenCaptureKit stamps its frames on (decision 14).
    pub fn now_ticks() -> i64 {
        let mut now = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: writes one timespec. CLOCK_UPTIME_RAW exists on every macOS
        // this binary runs on, and a zero is a timestamp, not a crash.
        unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &mut now) };
        now.tv_sec.saturating_mul(1_000_000_000).saturating_add(now.tv_nsec)
    }

    pub fn hz() -> anyhow::Result<i64> {
        Ok(1_000_000_000)
    }
}

/// 96 times the scale of the display `rect` is, and 96 when it is none of them.
pub fn dpi_for_rect(rect: &Rect) -> u32 {
    display_for_pixel_rect(rect).map_or(DEFAULT_DPI, |id| {
        (f64::from(DEFAULT_DPI) * display_scale(id)).round() as u32
    })
}

// ---------------------------------------------------------------- displays ---

/// The active displays, by CoreGraphics id. Empty when the list cannot be read.
pub fn display_ids() -> Vec<u32> {
    let mut count = 0u32;
    // SAFETY: a null list asks for the count alone.
    if unsafe { CGGetActiveDisplayList(0, std::ptr::null_mut(), &mut count) } != CGError::Success {
        return Vec::new();
    }
    let mut ids = vec![0u32; count as usize];
    // SAFETY: `ids` holds `count` entries and the call writes at most that many.
    if unsafe { CGGetActiveDisplayList(count, ids.as_mut_ptr(), &mut count) } != CGError::Success {
        return Vec::new();
    }
    ids.truncate(count as usize);
    ids
}

/// The current mode's size as (points, pixels), each (width, height). `None`
/// when there is no mode or it reports a zero.
fn mode_sizes(id: u32) -> Option<((f64, f64), (f64, f64))> {
    let mode = CGDisplayCopyDisplayMode(id)?;
    let mode = Some(&*mode);
    let points = (CGDisplayMode::width(mode) as f64, CGDisplayMode::height(mode) as f64);
    let pixels = (CGDisplayMode::pixel_width(mode) as f64, CGDisplayMode::pixel_height(mode) as f64);
    (points.0 > 0.0 && points.1 > 0.0 && pixels.0 > 0.0 && pixels.1 > 0.0).then_some((points, pixels))
}

/// Pixels per point: the mode's pixel width over its point width. 1 when the
/// mode cannot be read.
pub fn display_scale(id: u32) -> f64 {
    mode_sizes(id).map_or(1.0, |(points, pixels)| pixels.0 / points.0)
}

/// `CGDisplayBounds`: x, y, width, height, in global points.
pub fn display_point_rect(id: u32) -> (f64, f64, f64, f64) {
    let bounds = CGDisplayBounds(id);
    (bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height)
}

/// The display's point origin times its scale, and its pixel size.
pub fn display_pixel_rect(id: u32) -> Rect {
    let (x, y, width, height) = display_point_rect(id);
    let (scale, (width, height)) = match mode_sizes(id) {
        Some((points, pixels)) => (pixels.0 / points.0, pixels),
        None => (1.0, (width, height)),
    };
    let left = (x * scale).round() as i32;
    let top = (y * scale).round() as i32;
    Rect {
        left,
        top,
        right: left + width.round() as i32,
        bottom: top + height.round() as i32,
    }
}

/// The display whose pixel rect this is: the way back from an `OutputInfo`.
pub fn display_for_pixel_rect(rect: &Rect) -> Option<u32> {
    display_ids().into_iter().find(|&id| display_pixel_rect(id) == *rect)
}

// --------------------------------------------------------------- selfcheck ---

/// How long `selfcheck` waits for ScreenCaptureKit's answer. It comes back in
/// well under a second when it comes at all; this only bounds a hang.
const SHAREABLE_TIMEOUT: Duration = Duration::from_secs(5);

// HIServices. No objc2 crate exports it (decision 15).
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    /// Reads this process's Accessibility trust. Never asks.
    fn AXIsProcessTrusted() -> u8;
}

/// The `selfcheck` verb's one line: what this process may do on this Mac, as
/// the privacy system credits it, read without raising a dialog on a Mac
/// nobody is sitting at.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheck {
    pub screen_capture_preflight: bool,
    /// `ok`, `denied`, `skipped` (the preflight said no and `--force` was not
    /// given), or `error:<code>` with ScreenCaptureKit's error code, or
    /// `error:timeout`.
    pub shareable_content: String,
    /// The displays ScreenCaptureKit listed; 0 unless `shareable_content` is `ok`.
    pub displays: usize,
    pub post_event_preflight: bool,
    pub ax_trusted: bool,
    /// `ok`, or `error:<errno>` from the send.
    pub local_network_send: String,
    pub pid: u32,
}

/// Run every check, in the order the gate reads them.
///
/// `SCShareableContent` is the one call here that can raise the Screen
/// Recording dialog, so it is made only when the preflight already said yes or
/// `force` asks for it: an unattended Mac never sees a prompt from this verb.
/// The rest only read.
pub fn selfcheck(force: bool) -> SelfCheck {
    let screen_capture_preflight = CGPreflightScreenCaptureAccess();
    let (shareable_content, displays) = if screen_capture_preflight || force {
        shareable_content()
    } else {
        ("skipped".to_owned(), 0)
    };
    SelfCheck {
        screen_capture_preflight,
        shareable_content,
        displays,
        post_event_preflight: CGPreflightPostEventAccess(),
        ax_trusted: ax_trusted(),
        local_network_send: local_network_send(),
        pid: std::process::id(),
    }
}

/// `selfcheck --grants`: the three grant answers, the pasteboard access, and
/// nothing else.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grants {
    pub screen_capture_preflight: bool,
    pub post_event_preflight: bool,
    pub ax_trusted: bool,
    /// `allow`, `ask`, `deny`, `default` or `unknown`; `null` before macOS
    /// 15.4, where there is no setting.
    pub pasteboard_access: Option<&'static str>,
}

/// The grants alone, for a caller that asks often: four reads that never
/// ask, and neither ScreenCaptureKit nor a packet (swoop-macos task 4.9). A
/// fresh process reads its grants as they are now, which the desktop app's
/// own long-lived process does not.
pub fn grants() -> Grants {
    Grants {
        screen_capture_preflight: CGPreflightScreenCaptureAccess(),
        post_event_preflight: CGPreflightPostEventAccess(),
        ax_trusted: ax_trusted(),
        pasteboard_access: crate::clipboard::mac::pasteboard_access(),
    }
}

/// `selfcheck --paste-once`: one pasteboard read for the desktop app's button
/// (`clipboard::mac::read_once`), and the access behaviour after it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteOnce {
    pub pasteboard_access: Option<&'static str>,
}

pub fn paste_once() -> PasteOnce {
    PasteOnce {
        pasteboard_access: crate::clipboard::mac::read_once(),
    }
}

fn ax_trusted() -> bool {
    // SAFETY: no arguments; it reads the caller's own trust.
    let trusted = unsafe { AXIsProcessTrusted() };
    trusted != 0
}

/// ScreenCaptureKit's display count, or why there is none.
fn shareable_content() -> (String, usize) {
    let (tx, rx) = mpsc::sync_channel::<Result<usize, isize>>(1);
    let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        // SAFETY: each is null or an object the framework keeps alive for the
        // length of this call.
        let answer = match unsafe { (content.as_ref(), error.as_ref()) } {
            (Some(content), _) => Ok(unsafe { content.displays() }.count()),
            (None, Some(error)) => Err(error.code()),
            (None, None) => Err(0),
        };
        let _ = tx.try_send(answer);
    });
    // SAFETY: the block has the signature the method declares, and owns
    // everything it touches.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    match rx.recv_timeout(SHAREABLE_TIMEOUT) {
        Ok(Ok(displays)) => ("ok".to_owned(), displays),
        Ok(Err(code)) if code == SCStreamErrorCode::UserDeclined.0 => ("denied".to_owned(), 0),
        Ok(Err(code)) => (format!("error:{code}"), 0),
        Err(_) => ("error:timeout".to_owned(), 0),
    }
}

/// One byte to the mDNS group, the kind of send macOS 15's Local Network
/// privacy gates: whether this process's LAN traffic leaves the box at all.
fn local_network_send() -> String {
    let sent = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| socket.send_to(&[0], (Ipv4Addr::new(224, 0, 0, 251), 5353)));
    match sent {
        Ok(_) => "ok".to_owned(),
        Err(e) => format!("error:{}", e.raw_os_error().unwrap_or(0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The desktop app reads this line every few seconds: exactly these keys.
    #[test]
    fn the_grants_line_is_the_four_answers_alone() {
        let grants = Grants {
            screen_capture_preflight: true,
            post_event_preflight: false,
            ax_trusted: true,
            pasteboard_access: Some("ask"),
        };
        assert_eq!(
            serde_json::to_string(&grants).unwrap(),
            r#"{"screenCapturePreflight":true,"postEventPreflight":false,"axTrusted":true,"pasteboardAccess":"ask"}"#
        );
        let older = Grants {
            pasteboard_access: None,
            ..grants
        };
        assert!(serde_json::to_string(&older).unwrap().ends_with(r#""pasteboardAccess":null}"#));
    }
}
