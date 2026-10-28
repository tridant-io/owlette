//! The clipboard on macOS: one thread that watches the general pasteboard and
//! applies what the viewer pastes.
//!
//! macOS has no notification for a change to the pasteboard, so the thread
//! looks at `changeCount` every [`POLL`], a number and not the content, and
//! waits on the write queue in between, so a paste from the viewer is applied
//! the moment it arrives. None of it happens on the session thread, for the
//! same reason as on Windows (`super::listener`).
//!
//! # Reading is gated (decision 17)
//!
//! Pasteboard privacy can raise the system's paste alert when a process reads
//! the general pasteboard's content without a paste by the user, and nothing
//! may raise a dialog on a mac without a click at it. So the thread reads the
//! pasteboard's access behaviour once, when it starts, and reads content only
//! under always-allow, the one answer that reads without anyone being asked.
//! Under `default`, `ask` or `alwaysDeny` it never reads: one line says the
//! clipboard from this mac is off until owlette is allowed under "paste from
//! other apps", and host→viewer stays off for the session. The streamer is a
//! process per session, so the next session reads the setting again. The
//! setting is expected to be the owlette app's, whose child the streamer is,
//! as its Screen Recording grant is; the rig has measured it only for a
//! process started over ssh, which reads always-allow. A system older than
//! macOS 15.4 has neither the setting nor the alert, and reads.
//!
//! Writing needs no gate, and viewer→host works under every answer.
//!
//! # What is carried
//!
//! - text as `public.utf8-plain-text`;
//! - an image as `public.png` as it is, or a `public.tiff` converted to a png
//!   through `NSBitmapImageRep`, held to the pixel bound a Windows bitmap is;
//! - **a pasteboard holding file urls is left alone entirely**, as `CF_HDROP`
//!   is on Windows: Finder puts the file's name and icon beside the urls, and
//!   neither is what the user copied.
//!
//! Viewer→host images go on as the png and, beside it, a tiff made from it for
//! the applications that read only tiff, the way Windows puts `CF_DIBV5`
//! beside `"PNG"`. §5's caps and the listener's [`Echo`] apply as on Windows;
//! the echo is keyed by the change count a write produced, which is what
//! `clearContents` answers.
//!
//! Hardware tests are `#[ignore]`d. They **overwrite this mac's clipboard**, so
//! save it with `pbpaste` first and put it back with `pbcopy` after (text only:
//! an image on it is lost). With the working directory `agent/swoop`:
//!
//! ```text
//! pbpaste > ~/clipboard-before.txt
//! cargo test --no-default-features --features encode-videotoolbox,audio-opus -- --ignored --nocapture clipboard
//! pbcopy < ~/clipboard-before.txt
//! ```
//!
//! Expected: the access behaviour the test process got, printed; text and a
//! png written through the listener are on the pasteboard (the text read back
//! by `pbpaste`, the png as its types, and as its bytes when the behaviour
//! allows a read), and neither comes back as an update. When the behaviour
//! allows a read, a copy made by anything else arrives, a tiff arrives as a
//! png and file urls do not arrive; otherwise nothing arrives at all.

use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam_channel::{bounded, never, select, tick, Receiver, Sender};
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::NSObjectProtocol;
use objc2::sel;
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardAccessBehavior,
    NSPasteboardType, NSPasteboardTypeFileURL, NSPasteboardTypePNG, NSPasteboardTypeString,
    NSPasteboardTypeTIFF,
};
use objc2_foundation::{NSData, NSDictionary, NSString};

use super::formats::{Payload, DIB_MAX_PIXELS};
use super::listener::{Echo, Mailbox};
use crate::signal::messages::channel::{ClipFormat, CLIPBOARD_IMAGE_MAX_BYTES};

/// How often the change count is looked at. A copy reaches the viewer within
/// this plus the session's turn, and a number read four times a second costs
/// nothing.
const POLL: Duration = Duration::from_millis(250);

/// The thread handle and the channel that ends it.
pub struct Thread {
    thread: Option<JoinHandle<()>>,
    /// Dropped to stop the thread: a disconnected channel ends its wait at once.
    stop: Option<Sender<()>>,
}

impl Thread {
    pub fn spawn(latest: Mailbox, writes: Receiver<Payload>) -> anyhow::Result<Self> {
        let (stop, stopped) = bounded::<()>(0);
        let thread = std::thread::Builder::new()
            .name("swoop-clipboard".to_owned())
            .spawn(move || run(&latest, &writes, &stopped))?;
        Ok(Self {
            thread: Some(thread),
            stop: Some(stop),
        })
    }

    /// Nothing to do: the thread waits on the write queue itself.
    pub fn wake_for_write(&self) {}

    pub fn stop(&mut self) {
        let Some(thread) = self.thread.take() else {
            return;
        };
        self.stop = None;
        if let Err(e) = thread.join() {
            ::log::warn!("swoop: the clipboard listener thread panicked: {e:?}");
        }
    }
}

impl Drop for Thread {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(latest: &Mailbox, writes: &Receiver<Payload>, stopped: &Receiver<()>) {
    let pasteboard = NSPasteboard::generalPasteboard();
    let behaviour = access_behaviour(&pasteboard);
    let reads = may_read(behaviour);
    if reads {
        ::log::info!(
            "swoop: the pasteboard is read on a change, its access behaviour is {}",
            describe(behaviour)
        );
    } else {
        ::log::warn!(
            "swoop: the clipboard from this mac is off until owlette is allowed under \"paste from other apps\" in system settings (pasteboard access: {})",
            describe(behaviour)
        );
    }
    let mut echo = Echo::default();
    // Whatever is on the pasteboard already is the machine's and not this
    // session's: the viewer gets what is copied from now on, as on Windows.
    let mut seen = pasteboard.changeCount();
    // With reading off there is nothing to look at, and the thread waits for a
    // write or the stop alone.
    let ticks = if reads { tick(POLL) } else { never() };
    loop {
        select! {
            recv(stopped) -> _ => break,
            recv(writes) -> payload => match payload {
                Ok(payload) => autoreleasepool(|_| apply(&pasteboard, &payload, &mut echo)),
                Err(_) => break,
            },
            recv(ticks) -> _ => {
                let update = autoreleasepool(|_| read_update(&pasteboard, &mut seen, &echo));
                if let Some(payload) = update {
                    // Newest wins, and the lock is held for the swap alone.
                    let mut slot = latest.lock().unwrap_or_else(|e| e.into_inner());
                    *slot = Some(payload);
                }
            },
        }
    }
}

/// Whether the general pasteboard would be read: [`may_read`] of its access
/// behaviour, for the feature's status and the viewer's notice.
pub fn reads_general_pasteboard() -> bool {
    may_read(access_behaviour(&NSPasteboard::generalPasteboard()))
}

/// The general pasteboard's access behaviour as the desktop app's notice
/// names it (`selfcheck --grants`), or `None` on a system older than macOS
/// 15.4, where there is nothing to allow.
pub fn pasteboard_access() -> Option<&'static str> {
    access_behaviour(&NSPasteboard::generalPasteboard()).map(|behaviour| match behaviour {
        NSPasteboardAccessBehavior::AlwaysAllow => "allow",
        NSPasteboardAccessBehavior::Ask => "ask",
        NSPasteboardAccessBehavior::AlwaysDeny => "deny",
        NSPasteboardAccessBehavior::Default => "default",
        _ => "unknown",
    })
}

/// One deliberate read of the general pasteboard, for the desktop app's
/// button: macOS lists an app under Paste from Other Apps only once it has
/// read, so under *ask* this raises the paste alert at the person who
/// clicked, and the setting can be made *allow* from then on. What was read
/// is discarded. Answers the access behaviour afterwards.
pub fn read_once() -> Option<&'static str> {
    let pasteboard = NSPasteboard::generalPasteboard();
    let _ = pasteboard.stringForType(string_type());
    pasteboard_access()
}

/// The general pasteboard's access behaviour, or `None` on a system older than
/// macOS 15.4, which has neither the property nor the alert it describes.
fn access_behaviour(pasteboard: &NSPasteboard) -> Option<NSPasteboardAccessBehavior> {
    pasteboard
        .respondsToSelector(sel!(accessBehavior))
        .then(|| pasteboard.accessBehavior())
}

/// Decision 17's gate: only always-allow reads without anyone being asked.
/// `default` and `ask` would raise the paste alert, `alwaysDeny` would be
/// refused, and a value this build does not know is a refusal too.
fn may_read(behaviour: Option<NSPasteboardAccessBehavior>) -> bool {
    match behaviour {
        None => true,
        Some(behaviour) => behaviour == NSPasteboardAccessBehavior::AlwaysAllow,
    }
}

/// The access behaviour for a log line.
fn describe(behaviour: Option<NSPasteboardAccessBehavior>) -> &'static str {
    match behaviour {
        None => "none, before macos 15.4",
        Some(NSPasteboardAccessBehavior::Default) => "default",
        Some(NSPasteboardAccessBehavior::Ask) => "ask",
        Some(NSPasteboardAccessBehavior::AlwaysAllow) => "always allow",
        Some(NSPasteboardAccessBehavior::AlwaysDeny) => "always deny",
        Some(_) => "unknown",
    }
}

/// The change count as the echo guard keeps it. [`Echo`] holds the u32 that
/// Windows' sequence number is, and the low 32 bits of the count are enough:
/// the guard asks only whether a count is the one our last write produced.
fn echo_key(count: isize) -> u32 {
    count as u32
}

/// Whether a change count is news: it moved since the last look, and it is not
/// the count our own write produced.
fn fresh(count: isize, seen: &mut isize, echo: &Echo) -> bool {
    if count == *seen {
        return false;
    }
    *seen = count;
    !echo.is_own_write(echo_key(count))
}

/// One tick, under the gate only: the pasteboard's content if it changed and
/// the change is not ours. A file list, our own content or a payload over §5's
/// cap comes back `None`.
fn read_update(pasteboard: &NSPasteboard, seen: &mut isize, echo: &Echo) -> Option<Payload> {
    if !fresh(pasteboard.changeCount(), seen, echo) {
        return None;
    }
    let payload = read_payload(pasteboard)?;
    if echo.is_own_content(&payload) {
        return None;
    }
    if !payload.within_cap() {
        ::log::debug!(
            "swoop: a {:?} clipboard is over the cap, not sent",
            payload.fmt
        );
        return None;
    }
    Some(payload)
}

/// What §5 carries, in the order Windows prefers it: an image first, then text.
fn read_payload(pasteboard: &NSPasteboard) -> Option<Payload> {
    let types = pasteboard.types()?;
    let has = |kind: &NSPasteboardType| types.containsObject(kind);
    if has(file_url_type()) {
        ::log::debug!("swoop: file urls are on the pasteboard, nothing is synced");
        return None;
    }
    // A png over the cap would go out as it is or not at all, so the tiff
    // beside it is tried instead, as Windows tries the bitmap.
    if has(png_type()) {
        if let Some(png) = pasteboard.dataForType(png_type()) {
            if png.len() as u64 <= CLIPBOARD_IMAGE_MAX_BYTES {
                return Some(Payload::png(png.to_vec()));
            }
        }
    }
    if has(tiff_type()) {
        if let Some(png) = pasteboard
            .dataForType(tiff_type())
            .and_then(|tiff| tiff_to_png(&tiff))
        {
            return Some(Payload::png(png));
        }
    }
    if !has(string_type()) {
        return None;
    }
    let text = pasteboard.stringForType(string_type())?.to_string();
    (!text.is_empty()).then(|| Payload::text(&text))
}

/// Put a payload on the pasteboard and record the echo it will cause.
fn apply(pasteboard: &NSPasteboard, payload: &Payload, echo: &mut Echo) {
    // The tiff is made before the pasteboard is cleared, so a paste in between
    // finds the old clipboard whole rather than a png without its tiff.
    let image = match payload.fmt {
        ClipFormat::Text => None,
        ClipFormat::Png => {
            let png = NSData::with_bytes(&payload.bytes);
            let tiff = image_rep(&png).and_then(|rep| rep.TIFFRepresentation());
            Some((png, tiff))
        }
    };
    // The count this write produced: setting data on the cleared pasteboard
    // does not move it again, and a later change by anyone else does.
    let produced = pasteboard.clearContents();
    let written = match image {
        None => {
            let text = NSString::from_str(&String::from_utf8_lossy(&payload.bytes));
            pasteboard.setString_forType(&text, string_type())
        }
        Some((png, tiff)) => {
            let png = pasteboard.setData_forType(Some(&png), png_type());
            let tiff =
                tiff.is_some_and(|tiff| pasteboard.setData_forType(Some(&tiff), tiff_type()));
            png || tiff
        }
    };
    if !written {
        ::log::debug!("swoop: a clipboard write did not take");
        return;
    }
    echo.wrote(echo_key(produced), payload);
}

/// An image the pasteboard handed over or a viewer sent, as a bitmap rep. Its
/// size is read from the header, before a pixel is decoded, and one over the
/// bound a Windows bitmap is held to is refused.
fn image_rep(data: &NSData) -> Option<Retained<NSBitmapImageRep>> {
    let rep = NSBitmapImageRep::imageRepWithData(data)?;
    let wide = u64::try_from(rep.pixelsWide()).ok()?;
    let high = u64::try_from(rep.pixelsHigh()).ok()?;
    let pixels = wide * high;
    (pixels > 0 && pixels <= DIB_MAX_PIXELS).then_some(rep)
}

fn tiff_to_png(tiff: &NSData) -> Option<Vec<u8>> {
    let rep = image_rep(tiff)?;
    // SAFETY: an empty dictionary is a dictionary of the declared types.
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(png.to_vec())
}

// The pasteboard types are AppKit's extern statics, which only `unsafe` reads.

fn string_type() -> &'static NSPasteboardType {
    // SAFETY: an AppKit constant, initialised before any code of ours runs.
    unsafe { NSPasteboardTypeString }
}

fn png_type() -> &'static NSPasteboardType {
    // SAFETY: as above.
    unsafe { NSPasteboardTypePNG }
}

fn tiff_type() -> &'static NSPasteboardType {
    // SAFETY: as above.
    unsafe { NSPasteboardTypeTIFF }
}

fn file_url_type() -> &'static NSPasteboardType {
    // SAFETY: as above.
    unsafe { NSPasteboardTypeFileURL }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_always_allow_reads_the_pasteboard() {
        assert!(may_read(Some(NSPasteboardAccessBehavior::AlwaysAllow)));
    }

    #[test]
    fn default_and_ask_never_read_because_either_would_raise_the_alert() {
        assert!(!may_read(Some(NSPasteboardAccessBehavior::Default)));
        assert!(!may_read(Some(NSPasteboardAccessBehavior::Ask)));
    }

    #[test]
    fn always_deny_and_an_answer_this_build_does_not_know_never_read() {
        assert!(!may_read(Some(NSPasteboardAccessBehavior::AlwaysDeny)));
        assert!(!may_read(Some(NSPasteboardAccessBehavior(7))));
        assert_eq!(describe(Some(NSPasteboardAccessBehavior(7))), "unknown");
    }

    #[test]
    fn a_system_without_the_setting_has_no_alert_and_reads() {
        assert!(may_read(None));
    }

    #[test]
    fn the_count_our_own_write_produced_is_not_news() {
        let mut echo = Echo::default();
        let mut seen = 10;
        assert!(!fresh(10, &mut seen, &echo), "nothing moved");
        echo.wrote(echo_key(11), &Payload::text("pasted by the viewer"));
        assert!(!fresh(11, &mut seen, &echo), "our own write");
        assert!(!fresh(11, &mut seen, &echo), "and not a second time");
        assert!(fresh(12, &mut seen, &echo), "anyone else's change is news");
        assert!(!fresh(12, &mut seen, &echo), "once");
    }

    #[test]
    fn a_change_before_our_write_is_still_news() {
        let mut echo = Echo::default();
        let mut seen = 3;
        echo.wrote(echo_key(5), &Payload::text("pasted by the viewer"));
        assert!(fresh(4, &mut seen, &echo));
    }

    #[test]
    fn the_echo_key_is_the_count_modulo_two_to_the_32() {
        assert_eq!(echo_key(5), 5);
        assert_eq!(echo_key((1 << 32) + 5), 5);
    }
}

#[cfg(test)]
mod hardware {
    use std::process::Command;
    use std::time::Instant;

    use super::*;
    use crate::cursor::{encode_png, CursorImage};

    /// The pasteboard's text as `pbpaste` reads it: a process of its own, so
    /// the write is checked without this process reading content.
    fn pbpaste() -> String {
        let out = Command::new("pbpaste").output().expect("pbpaste runs");
        String::from_utf8(out.stdout).expect("utf-8 from pbpaste")
    }

    /// The change count once it has moved past `from`.
    fn count_after(pasteboard: &NSPasteboard, from: isize) -> isize {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let count = pasteboard.changeCount();
            if count != from || Instant::now() > deadline {
                return count;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Whatever the listener reports within a few polls.
    fn update(listener: &super::super::listener::Listener) -> Option<Payload> {
        for _ in 0..8 {
            std::thread::sleep(POLL);
            if let Some(payload) = listener.take_update() {
                return Some(payload);
            }
        }
        None
    }

    fn two_by_three_png() -> Vec<u8> {
        encode_png(&CursorImage {
            width: 3,
            height: 2,
            hot_x: 0,
            hot_y: 0,
            scale: 1,
            rgba: vec![0x80; 3 * 2 * 4],
        })
    }

    #[test]
    #[ignore = "overwrites this mac's real clipboard"]
    fn a_clipboard_round_trips_through_the_mac_pasteboard() {
        let pasteboard = NSPasteboard::generalPasteboard();
        let behaviour = access_behaviour(&pasteboard);
        let reads = may_read(behaviour);
        println!(
            "pasteboard access behaviour: {} ({:?}), content reads: {}",
            describe(behaviour),
            behaviour.map(|b| b.0),
            if reads { "on" } else { "off" }
        );
        let mut listener = super::super::listener::start().expect("a listener");

        // viewer → host, text: on the pasteboard, and not back as an update.
        let pasted = "owlette swoop clipboard round trip";
        let before = pasteboard.changeCount();
        listener.write(Payload::text(pasted));
        let after = count_after(&pasteboard, before);
        assert_ne!(after, before, "the text write never reached the pasteboard");
        assert_eq!(pbpaste(), pasted, "pbpaste does not read the text back");
        println!("write text: change count {before} -> {after}, pbpaste reads it back");

        // viewer → host, an image: the png as sent and a tiff made from it.
        let png = two_by_three_png();
        let before = pasteboard.changeCount();
        listener.write(Payload::png(png.clone()));
        let after = count_after(&pasteboard, before);
        assert_ne!(after, before, "the png write never reached the pasteboard");
        let types = pasteboard.types().expect("the pasteboard's types");
        assert!(types.containsObject(png_type()), "no png on the pasteboard");
        assert!(types.containsObject(tiff_type()), "no tiff beside the png");
        if reads {
            let back = pasteboard.dataForType(png_type()).expect("the png");
            assert_eq!(back.to_vec(), png, "the png is not the png as sent");
            let tiff = pasteboard.dataForType(tiff_type()).expect("the tiff");
            let rep = image_rep(&tiff).expect("a tiff AppKit reads");
            assert_eq!((rep.pixelsWide(), rep.pixelsHigh()), (3, 2));
            println!("write png: change count {before} -> {after}, png and tiff read back");
        } else {
            println!("write png: change count {before} -> {after}, png and tiff types present");
        }
        assert_eq!(
            update(&listener),
            None,
            "our own write came back as an update"
        );

        // host → viewer: a copy made by anything but the listener. Setting data
        // on the cleared pasteboard leaves the count where clearing put it,
        // which is what keys the echo.
        let copied = "copied on the mac, not by swoop";
        let produced = pasteboard.clearContents();
        assert!(pasteboard.setString_forType(&NSString::from_str(copied), string_type()));
        assert_eq!(
            pasteboard.changeCount(),
            produced,
            "setting data moved the count"
        );
        let arrived = update(&listener);
        if !reads {
            assert_eq!(arrived, None, "the gate is off and the pasteboard was read");
            println!("read: off, a foreign copy was not read");
            listener.stop();
            return;
        }
        assert_eq!(
            arrived,
            Some(Payload::text(copied)),
            "a foreign copy never arrived"
        );

        // a tiff alone arrives as a png of the same size.
        let tiff = image_rep(&NSData::with_bytes(&png))
            .and_then(|rep| rep.TIFFRepresentation())
            .expect("a tiff made from the png");
        pasteboard.clearContents();
        assert!(pasteboard.setData_forType(Some(&tiff), tiff_type()));
        let arrived = update(&listener).expect("the tiff never arrived");
        assert_eq!(arrived.fmt, ClipFormat::Png);
        let rep = image_rep(&NSData::with_bytes(&arrived.bytes)).expect("a png AppKit reads");
        assert_eq!((rep.pixelsWide(), rep.pixelsHigh()), (3, 2));

        // file urls are left alone, with the text beside them.
        pasteboard.clearContents();
        assert!(pasteboard.setString_forType(&NSString::from_str("file:///tmp/"), file_url_type()));
        assert!(pasteboard.setString_forType(&NSString::from_str("tmp"), string_type()));
        assert_eq!(update(&listener), None, "a file list was synced");
        println!("read: on, text and a tiff arrived, file urls did not");

        listener.stop();
    }
}
