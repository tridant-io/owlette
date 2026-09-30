//! macOS: the seam's names, the host clock, the display helpers and `selfcheck`.
//!
//! Capture, scaling, injection and the desktop watcher are still the stubs in
//! [`super::unsupported`] — Wave 4 writes the backends and Task 5.1 wires them
//! here — so `run` exits 12 with a line that names the OS. What is real already
//! needs no privacy grant: the clock, and the display geometry CoreGraphics
//! answers without Screen Recording.
//!
//! Decision 13: an `OutputInfo.desktop_rect` is in **pixels** — a display's
//! point origin times its scale, and its pixel size. On a mixed-scale layout
//! those origins are not one consistent global space, which only spanning
//! needs. The helpers below are the one spelling of the rule that capture,
//! input and the cursor share.

use std::net::{Ipv4Addr, UdpSocket};
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2_core_graphics::{
    CGDisplayBounds, CGDisplayCopyDisplayMode, CGDisplayMode, CGError, CGGetActiveDisplayList,
    CGPreflightPostEventAccess, CGPreflightScreenCaptureAccess,
};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{SCShareableContent, SCStreamErrorCode};
use serde::Serialize;

pub use super::unsupported::{
    enumerate_outputs, process, CaptureSource, DesktopWatcher, Downscaler, InputInjector,
    ScaleError,
};
use crate::capture::Rect;
use crate::cursor::DEFAULT_DPI;

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
        // SAFETY: no arguments; it reads the caller's own trust.
        ax_trusted: unsafe { AXIsProcessTrusted() } != 0,
        local_network_send: local_network_send(),
        pid: std::process::id(),
    }
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
