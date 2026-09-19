//! The clipboard listener: one thread, one message-only window, and every
//! win32 call this feature makes.
//!
//! The thread exists because the clipboard is blocking IO — `OpenClipboard`
//! fails while another process holds it, `SetClipboardData` needs a window in
//! the calling thread, and `WM_CLIPBOARDUPDATE` only arrives at a thread with a
//! message loop. None of that may happen on the session thread, which turns
//! every 2 ms and drives the peer (`session::features`).
//!
//! The window is created on the **`Default`** desktop and stays there. A window
//! belongs for its whole life to the desktop its thread was on when it was
//! created, so this thread deliberately does *not* follow the input desktop the
//! way capture and input do: following it would take the clipboard listener to
//! `Winlogon`, which is the one place §5 refuses to sync at all.
//!
//! Hardware tests are `#[ignore]`d — they read and write **this machine's real
//! clipboard**, so whatever you had copied is gone afterwards. With the working
//! directory `agent/swoop`:
//!
//! ```text
//! cargo test -- --ignored --nocapture clipboard
//! ```
//!
//! Expected: the text written through the listener comes back out of the same
//! clipboard, the update it caused is suppressed as this process's own echo,
//! and a copy made by anything else does arrive.

use std::sync::{Arc, Mutex};

use crossbeam_channel::{bounded, Sender};

use super::formats::Payload;

/// The most payloads waiting to be applied to this machine's clipboard. Past
/// this the viewer is pasting faster than the machine can take it, which is
/// not a queue worth keeping.
const WRITE_QUEUE: usize = 4;

/// What the listener thread last read, and the whole of what the feature
/// collects.
///
/// A mailbox rather than a queue, because a clipboard **supersedes** the one
/// before it: the session polls a feature only while a viewer's peer is
/// connected, so a queue would hand a viewer that has just joined whatever was
/// copied several clipboards ago instead of what is on the machine now.
type Mailbox = Arc<Mutex<Option<Payload>>>;

/// Both halves of the echo guard, neither of which is sufficient alone.
///
/// The sequence number catches the ordinary case without reading the clipboard
/// at all. The content hash catches the case the number cannot: another process
/// writing between our `SetClipboardData` and the update that follows it moves
/// the counter on, and an update we have already sent the viewer must still not
/// go back to it.
#[derive(Debug, Default)]
pub struct Echo {
    seq: Option<u32>,
    digest: Option<[u8; 32]>,
}

impl Echo {
    /// Record what this process just put on the clipboard. `seq` is
    /// `GetClipboardSequenceNumber()` read **after** the clipboard was closed:
    /// `EmptyClipboard` and each `SetClipboardData` move the counter, and it is
    /// the number in force when the update fires that has to match.
    pub fn wrote(&mut self, seq: u32, payload: &Payload) {
        self.seq = Some(seq);
        self.digest = Some(payload.digest());
    }

    /// Before reading: is this update the one our own write caused?
    pub fn is_own_write(&self, seq: u32) -> bool {
        self.seq == Some(seq)
    }

    /// After reading: is this content the content we wrote?
    pub fn is_own_content(&self, payload: &Payload) -> bool {
        self.digest == Some(payload.digest())
    }
}

/// The clipboard listener as the feature sees it: the machine's clipboard comes
/// out, payloads to apply go in, and nothing blocks.
pub struct Listener {
    latest: Mailbox,
    #[cfg_attr(not(windows), allow(dead_code))]
    writes: Sender<Payload>,
    #[cfg(windows)]
    inner: win::Thread,
}

impl Listener {
    /// The machine's clipboard if it has changed since the last call, already
    /// filtered: file lists, echoes of our own writes and anything over §5's
    /// caps never get this far.
    pub fn take_update(&self) -> Option<Payload> {
        // A thread that panicked while holding this left a lock, not bad data:
        // the payload behind it is one `Option`, whole or absent.
        let mut latest = self.latest.lock().unwrap_or_else(|e| e.into_inner());
        latest.take()
    }

    /// Put a payload on this machine's clipboard. Best effort and never
    /// blocking: the write happens on the listener thread, and a full queue is
    /// a viewer pasting faster than the machine applies it.
    #[cfg(windows)]
    pub fn write(&self, payload: Payload) {
        if self.writes.try_send(payload).is_err() {
            ::log::debug!("swoop: a clipboard write was dropped, the queue is full");
            return;
        }
        self.inner.wake_for_write();
    }

    #[cfg(not(windows))]
    pub fn write(&self, _payload: Payload) {}

    /// Stop the thread and wait for it. Idempotent.
    pub fn stop(&mut self) {
        #[cfg(windows)]
        self.inner.stop();
    }
}

/// Start the listener. The win32 work happens on the thread, so this returns as
/// soon as the thread is spawned and a failure to create the window is reported
/// from there — a feature whose listener could not start runs inert rather than
/// taking the session down with it.
#[cfg(windows)]
pub fn start() -> anyhow::Result<Listener> {
    let latest: Mailbox = Arc::new(Mutex::new(None));
    let (writes, write_rx) = bounded(WRITE_QUEUE);
    let inner = win::Thread::spawn(Arc::clone(&latest), write_rx)?;
    Ok(Listener {
        latest,
        writes,
        inner,
    })
}

#[cfg(not(windows))]
pub fn start() -> anyhow::Result<Listener> {
    let (writes, _) = bounded(WRITE_QUEUE);
    Ok(Listener {
        latest: Arc::new(Mutex::new(None)),
        writes,
    })
}

#[cfg(windows)]
mod win {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread::JoinHandle;
    use std::time::Duration;

    use crossbeam_channel::Receiver;
    use windows::core::w;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData,
        GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW, RemoveClipboardFormatListener, SetClipboardData,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenDesktopW, OpenInputDesktop, SetThreadDesktop,
        DESKTOP_CONTROL_FLAGS, DESKTOP_CREATEWINDOW, DESKTOP_READOBJECTS, DESKTOP_WRITEOBJECTS,
        UOI_NAME,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        PostMessageW, RegisterClassW, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP,
        WM_CLIPBOARDUPDATE, WNDCLASSW,
    };

    use super::super::formats::{
        self, dib_to_png, text_from_utf16, text_to_utf16, Payload, CF_DIB, CF_DIBV5, CF_HDROP,
        CF_UNICODETEXT,
    };
    use super::{Echo, Mailbox};
    use crate::ipc::Desktop;
    use crate::signal::messages::channel::ClipFormat;

    /// There is a payload waiting on the write channel.
    const WM_APP_WRITE: u32 = WM_APP + 1;
    /// Leave the message loop.
    const WM_APP_QUIT: u32 = WM_APP + 2;

    /// Another process holds the clipboard for a few milliseconds at a time.
    const OPEN_ATTEMPTS: u32 = 5;
    const OPEN_RETRY: Duration = Duration::from_millis(10);

    /// The most this thread copies out of one clipboard handle.
    ///
    /// Above it the transfer cannot fit §5's caps anyway — the crate's png
    /// encoder writes stored deflate blocks, so a DIB is roughly its own size
    /// once encoded — and a clipboard holding a 4K screenshot is exactly where
    /// copying first and refusing second would cost the most.
    const MAX_READ_BYTES: usize = 8 * 1024 * 1024;

    /// The thread handle, its window, and the flag that ends it.
    pub struct Thread {
        thread: Option<JoinHandle<()>>,
        hwnd: Arc<AtomicUsize>,
        stopping: Arc<AtomicBool>,
    }

    impl Thread {
        pub fn spawn(latest: Mailbox, writes: Receiver<Payload>) -> anyhow::Result<Self> {
            let hwnd = Arc::new(AtomicUsize::new(0));
            let stopping = Arc::new(AtomicBool::new(false));
            let thread = {
                let hwnd = Arc::clone(&hwnd);
                let stopping = Arc::clone(&stopping);
                std::thread::Builder::new()
                    .name("swoop-clipboard".to_owned())
                    .spawn(move || run(&hwnd, &stopping, &latest, &writes))?
            };
            Ok(Self {
                thread: Some(thread),
                hwnd,
                stopping,
            })
        }

        pub fn wake_for_write(&self) {
            let hwnd = self.hwnd.load(Ordering::SeqCst);
            if hwnd == 0 {
                // The window is not up yet. The payload is not lost: the thread
                // drains the channel once as soon as it publishes the window,
                // and it publishes before it drains, so a payload queued before
                // that load is in the channel by then.
                return;
            }
            let _ = unsafe { PostMessageW(Some(HWND(hwnd as _)), WM_APP_WRITE, WPARAM(0), LPARAM(0)) };
        }

        pub fn stop(&mut self) {
            let Some(thread) = self.thread.take() else {
                return;
            };
            // Ordered against the thread's own store: if this load sees no
            // window, the thread has not published one yet and is guaranteed to
            // see the flag before it blocks in `GetMessageW`.
            self.stopping.store(true, Ordering::SeqCst);
            let hwnd = self.hwnd.load(Ordering::SeqCst);
            if hwnd != 0 {
                let _ =
                    unsafe { PostMessageW(Some(HWND(hwnd as _)), WM_APP_QUIT, WPARAM(0), LPARAM(0)) };
            }
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

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    fn run(
        hwnd_cell: &AtomicUsize,
        stopping: &AtomicBool,
        latest: &Mailbox,
        writes: &Receiver<Payload>,
    ) {
        attach_to_default_desktop();
        let hwnd = match create_window() {
            Ok(hwnd) => hwnd,
            Err(e) => {
                ::log::warn!("swoop: no clipboard listener window, clipboard is off: {e}");
                return;
            }
        };
        hwnd_cell.store(hwnd.0 as usize, Ordering::SeqCst);
        if stopping.load(Ordering::SeqCst) {
            let _ = unsafe { DestroyWindow(hwnd) };
            return;
        }
        if let Err(e) = unsafe { AddClipboardFormatListener(hwnd) } {
            ::log::warn!("swoop: clipboard updates are not being listened for: {e}");
        }

        // The registered format browsers and image editors put a real png
        // under. A zero return means the name could not be registered at all,
        // and the image half is simply unavailable.
        let png_format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
        let mut echo = Echo::default();
        // A write may already be waiting: `Listener::write` posts to a window
        // that did not exist yet as nothing at all, so the first drain is
        // unconditional. Whatever was already on the clipboard is the machine's
        // and not this session's — the viewer gets what is copied from now on.
        drain_writes(hwnd, png_format, writes, &mut echo);
        let mut msg = MSG::default();
        loop {
            // 0 is WM_QUIT and -1 is an error; both end the loop.
            if unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 <= 0 {
                break;
            }
            match msg.message {
                WM_CLIPBOARDUPDATE => {
                    if let Some(payload) = read_update(hwnd, png_format, &mut echo) {
                        // Newest wins, and the lock is held for the swap alone.
                        let mut slot = latest.lock().unwrap_or_else(|e| e.into_inner());
                        *slot = Some(payload);
                    }
                }
                WM_APP_WRITE => drain_writes(hwnd, png_format, writes, &mut echo),
                WM_APP_QUIT => break,
                _ => {
                    unsafe { DispatchMessageW(&msg) };
                }
            }
        }
        let _ = unsafe { RemoveClipboardFormatListener(hwnd) };
        let _ = unsafe { DestroyWindow(hwnd) };
        hwnd_cell.store(0, Ordering::SeqCst);
    }

    /// Every payload the feature has handed over, applied in order.
    fn drain_writes(hwnd: HWND, png_format: u32, writes: &Receiver<Payload>, echo: &mut Echo) {
        while let Ok(payload) = writes.try_recv() {
            apply(hwnd, png_format, &payload, echo);
        }
    }

    /// Bind this thread to `Default` before it creates its window. Failing is
    /// not fatal: the thread then keeps whichever desktop the process was
    /// started on, which for the streamer is `WinSta0\Default` anyway.
    fn attach_to_default_desktop() {
        let access = DESKTOP_CREATEWINDOW.0 | DESKTOP_READOBJECTS.0 | DESKTOP_WRITEOBJECTS.0;
        let opened = unsafe { OpenDesktopW(w!("Default"), DESKTOP_CONTROL_FLAGS(0), false, access) };
        match opened {
            // The handle is deliberately not closed: it stays valid for as long
            // as this thread is attached to it, and the thread owns it for life.
            Ok(desktop) => {
                if let Err(e) = unsafe { SetThreadDesktop(desktop) } {
                    ::log::debug!("swoop: clipboard thread stayed on the process desktop: {e}");
                    let _ = unsafe { CloseDesktop(desktop) };
                }
            }
            Err(e) => ::log::debug!("swoop: could not open the Default desktop: {e}"),
        }
    }

    fn create_window() -> windows::core::Result<HWND> {
        let instance = unsafe { GetModuleHandleW(None) }?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: instance.into(),
            lpszClassName: w!("OwletteSwoopClipboard"),
            ..Default::default()
        };
        // A zero return is almost always "already registered", which is exactly
        // right on a second session in the same process; `CreateWindowExW` is
        // the call that actually has to succeed. The class is never
        // unregistered for the same reason.
        unsafe { RegisterClassW(&class) };
        unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("OwletteSwoopClipboard"),
                w!("owlette-swoop clipboard"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance.into()),
                None,
            )
        }
    }

    /// The input desktop, read here rather than taken from another feature:
    /// clipboard sync is refused on `Winlogon` whether or not anything else in
    /// the process is watching for the switch.
    fn input_desktop() -> Desktop {
        let opened =
            unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) };
        let Ok(desktop) = opened else {
            // Equally what a thread without rights to the current desktop gets,
            // which is why `sync_allowed` treats `Unknown` as a refusal.
            return Desktop::Unknown;
        };
        let mut buffer = [0u16; 128];
        let mut needed = 0u32;
        let named = unsafe {
            GetUserObjectInformationW(
                HANDLE(desktop.0),
                UOI_NAME,
                Some(buffer.as_mut_ptr().cast()),
                std::mem::size_of_val(&buffer) as u32,
                Some(&mut needed),
            )
        };
        let _ = unsafe { CloseDesktop(desktop) };
        if named.is_err() {
            return Desktop::Unknown;
        }
        formats::desktop_from_name(&text_from_utf16(&buffer))
    }

    /// One `WM_CLIPBOARDUPDATE`, filtered: our own echo, a file list, an
    /// unreadable format or a payload over §5's cap all come back `None`.
    fn read_update(hwnd: HWND, png_format: u32, echo: &mut Echo) -> Option<Payload> {
        let desktop = input_desktop();
        if !formats::sync_allowed(desktop) {
            ::log::debug!("swoop: clipboard not read, the input desktop is {desktop:?}");
            return None;
        }
        let seq = unsafe { GetClipboardSequenceNumber() };
        if echo.is_own_write(seq) {
            return None;
        }
        let payload = with_clipboard(Some(hwnd), || read_payload(png_format))?;
        if echo.is_own_content(&payload) {
            return None;
        }
        if !payload.within_cap() {
            ::log::debug!(
                "swoop: a {:?} clipboard of {} bytes is over the cap, not sent",
                payload.fmt,
                payload.bytes.len()
            );
            return None;
        }
        Some(payload)
    }

    /// Inside an open clipboard: what §5 carries, in preference order.
    fn read_payload(png_format: u32) -> Option<Payload> {
        // A file list is refused whole — not partially synced as the text of
        // the paths.
        if unsafe { IsClipboardFormatAvailable(CF_HDROP) }.is_ok() {
            ::log::debug!("swoop: a file list is on the clipboard, nothing is synced");
            return None;
        }
        // The registered format first: it is already a compressed png, where a
        // DIB has to be encoded without a compressor.
        if png_format != 0 && unsafe { IsClipboardFormatAvailable(png_format) }.is_ok() {
            if let Some(bytes) = clipboard_bytes(png_format) {
                return Some(Payload::png(bytes));
            }
        }
        for dib in [CF_DIBV5, CF_DIB] {
            if unsafe { IsClipboardFormatAvailable(dib) }.is_ok() {
                if let Some(png) = clipboard_bytes(dib).and_then(|bytes| dib_to_png(&bytes)) {
                    return Some(Payload::png(png));
                }
            }
        }
        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }.is_ok() {
            let bytes = clipboard_bytes(CF_UNICODETEXT)?;
            let units: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes(*pair))
                .collect();
            let text = text_from_utf16(&units);
            if !text.is_empty() {
                return Some(Payload::text(&text));
            }
        }
        None
    }

    /// Put a payload on the clipboard and record the echo it will cause.
    fn apply(hwnd: HWND, png_format: u32, payload: &Payload, echo: &mut Echo) {
        let desktop = input_desktop();
        if !formats::sync_allowed(desktop) {
            ::log::debug!("swoop: clipboard not written, the input desktop is {desktop:?}");
            return;
        }
        let written = with_clipboard(Some(hwnd), || {
            if unsafe { EmptyClipboard() }.is_err() {
                return None;
            }
            match payload.fmt {
                ClipFormat::Text => {
                    let units = text_to_utf16(&String::from_utf8_lossy(&payload.bytes));
                    let bytes: Vec<u8> = units.iter().flat_map(|u| u.to_le_bytes()).collect();
                    set_format(CF_UNICODETEXT, &bytes)
                }
                // The registered "PNG" format only: turning a png back into a
                // DIB needs a decompressor this crate does not have, and the
                // browsers and image editors this is for all read it.
                ClipFormat::Png if png_format != 0 => set_format(png_format, &payload.bytes),
                ClipFormat::Png => None,
            }
        });
        if written.is_none() {
            ::log::debug!("swoop: a clipboard write did not take");
            return;
        }
        // Read after the clipboard is closed: `EmptyClipboard` and each
        // `SetClipboardData` move the counter, and it is the number in force
        // when the update fires that has to match.
        echo.wrote(unsafe { GetClipboardSequenceNumber() }, payload);
    }

    /// `OpenClipboard` … `CloseClipboard` around one read or write, with the
    /// retry another process's brief ownership needs. The owner window is what
    /// a write needs; a read does without one.
    fn with_clipboard<T>(hwnd: Option<HWND>, body: impl FnOnce() -> Option<T>) -> Option<T> {
        let mut opened = false;
        for attempt in 0..OPEN_ATTEMPTS {
            if unsafe { OpenClipboard(hwnd) }.is_ok() {
                opened = true;
                break;
            }
            if attempt + 1 < OPEN_ATTEMPTS {
                std::thread::sleep(OPEN_RETRY);
            }
        }
        if !opened {
            ::log::debug!("swoop: the clipboard is held by another process");
            return None;
        }
        let out = body();
        let _ = unsafe { CloseClipboard() };
        out
    }

    /// One format's bytes, copied out from under `GlobalLock`.
    fn clipboard_bytes(format: u32) -> Option<Vec<u8>> {
        let handle = unsafe { GetClipboardData(format) }.ok()?;
        let global = HGLOBAL(handle.0);
        let size = unsafe { GlobalSize(global) };
        if size == 0 || size > MAX_READ_BYTES {
            return None;
        }
        let pointer = unsafe { GlobalLock(global) };
        if pointer.is_null() {
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), size) }.to_vec();
        // Fails with ERROR_SUCCESS once the lock count reaches zero, which is
        // the ordinary outcome here.
        let _ = unsafe { GlobalUnlock(global) };
        Some(bytes)
    }

    /// Hand one format to the clipboard. On success the system owns the memory;
    /// on failure this frees it.
    fn set_format(format: u32, bytes: &[u8]) -> Option<()> {
        let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }.ok()?;
        let pointer = unsafe { GlobalLock(global) };
        if pointer.is_null() {
            let _ = unsafe { GlobalFree(Some(global)) };
            return None;
        }
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast::<u8>(), bytes.len()) };
        let _ = unsafe { GlobalUnlock(global) };
        match unsafe { SetClipboardData(format, Some(HANDLE(global.0))) } {
            Ok(_) => Some(()),
            Err(e) => {
                ::log::debug!("swoop: SetClipboardData refused format {format}: {e}");
                let _ = unsafe { GlobalFree(Some(global)) };
                None
            }
        }
    }

    #[cfg(test)]
    mod hardware {
        use super::*;

        /// Both directions against **this machine's real clipboard**: whatever
        /// was copied before it runs is gone afterwards.
        #[test]
        #[ignore = "uses this machine's real clipboard"]
        fn a_clipboard_round_trips_and_our_own_write_never_echoes() {
            let mut listener = super::super::start().expect("a listener");
            let png_format = unsafe { RegisterClipboardFormatW(w!("PNG")) };

            // viewer → host: what the feature applies is on the clipboard, and
            // the update it causes is recognised as our own and dropped.
            let pasted = "owlette swoop clipboard round trip";
            listener.write(Payload::text(pasted));
            std::thread::sleep(Duration::from_millis(500));
            let back = with_clipboard(None, || read_payload(png_format))
                .expect("something is on the clipboard");
            assert_eq!(back, Payload::text(pasted));
            assert!(
                listener.take_update().is_none(),
                "our own write came back as an update"
            );

            // host → viewer: a copy by anything else does reach the feature.
            let copied = "copied on the host, not by swoop";
            let units = text_to_utf16(copied);
            let bytes: Vec<u8> = units.iter().flat_map(|unit| unit.to_le_bytes()).collect();
            with_clipboard(None, || {
                unsafe { EmptyClipboard() }.ok()?;
                set_format(CF_UNICODETEXT, &bytes)
            })
            .expect("the test's own write");
            let mut update = None;
            for _ in 0..40 {
                update = listener.take_update();
                if update.is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            assert_eq!(
                update,
                Some(Payload::text(copied)),
                "a copy this process did not make never arrived"
            );

            listener.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(text: &str) -> Payload {
        Payload::text(text)
    }

    #[test]
    fn an_update_carrying_our_own_sequence_number_is_our_own_write() {
        let mut echo = Echo::default();
        assert!(!echo.is_own_write(7));
        echo.wrote(7, &payload("copied by the viewer"));
        assert!(echo.is_own_write(7));
        assert!(!echo.is_own_write(8));
    }

    #[test]
    fn a_number_that_moved_on_is_still_caught_by_the_content_hash() {
        let mut echo = Echo::default();
        let written = payload("copied by the viewer");
        echo.wrote(7, &written);
        // another process wrote in between, so the number no longer matches.
        assert!(!echo.is_own_write(9));
        assert!(echo.is_own_content(&written));
        assert!(!echo.is_own_content(&payload("something the user copied")));
    }

    #[test]
    fn a_listener_with_nothing_to_report_reports_nothing() {
        let mut listener = start().expect("a listener");
        // Nothing has been copied, so the mailbox is empty.
        assert!(listener.take_update().is_none());
        listener.stop();
        // Stopping twice is what the session does after a failed start.
        listener.stop();
    }
}
