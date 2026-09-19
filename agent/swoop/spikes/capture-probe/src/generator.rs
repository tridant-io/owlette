//! On-screen content generator.
//!
//! Every pacing and dirty-rect measurement needs the desktop to actually change
//! faster than the refresh rate, otherwise the histogram measures an idle box.
//! This is a plain GDI window on the output under test, driven in one of three
//! scenes on its own thread with its own message pump.
//!
//! It draws with GDI rather than a D3D swap chain on purpose: `ScrollWindowEx`
//! is the API that makes DWM emit a *move* rect rather than a dirty rect, and
//! there is no swap-chain equivalent.
//!
//! Hardware/desktop-dependent tests are `#[ignore]`d. Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/capture-probe
//! cargo test -- --ignored --nocapture
//! ```

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, InvalidateRect, UpdateWindow,
    HBRUSH, PAINTSTRUCT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, LoadCursorW,
    PeekMessageW, PostQuitMessage, RegisterClassW, ScrollWindowEx, SetCursor, SetCursorPos,
    SetWindowPos, ShowWindow, IDC_APPSTARTING, IDC_ARROW, IDC_HAND, IDC_IBEAM, IDC_SIZEALL,
    IDC_WAIT, MSG, PM_REMOVE, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE,
    SW_SCROLLCHILDREN, WM_DESTROY, WM_PAINT, WM_SETCURSOR, WNDCLASSW, WS_EX_NOACTIVATE,
    WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};

use crate::stats::Rect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scene {
    /// Repaint the whole window as fast as the desktop will take it.
    Flood,
    /// Move the window along a path, which is what a dragged window looks like
    /// to DWM.
    Drag,
    /// `ScrollWindowEx` the content, which is what a scrolling page looks like.
    Scroll,
    /// Cycle the window's cursor so the pointer-shape channel has something to
    /// report.
    Cursor,
}

const BAR_HEIGHT: i32 = 40;

static PHASE: AtomicU32 = AtomicU32::new(0);
static SCROLL_OFFSET: AtomicI32 = AtomicI32::new(0);
static CURSOR_KIND: AtomicUsize = AtomicUsize::new(0);
static PAINTS: AtomicU32 = AtomicU32::new(0);
static SCROLLS: AtomicU32 = AtomicU32::new(0);
static MOVES: AtomicU32 = AtomicU32::new(0);

/// Windows the generator drew during the last `run`, so a measurement can say
/// how much content it actually generated rather than assuming.
#[derive(Debug, Clone, Copy)]
pub struct GeneratorCounters {
    pub paints: u32,
    pub scrolls: u32,
    pub moves: u32,
}

pub struct Generator {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Generator {
    /// Start the generator inside `bounds` (virtual-desktop coordinates of the
    /// output under test). The window is 960x720, or the whole output if the
    /// output is smaller.
    pub fn start(scene: Scene, bounds: Rect) -> Self {
        PHASE.store(0, Ordering::Relaxed);
        SCROLL_OFFSET.store(0, Ordering::Relaxed);
        CURSOR_KIND.store(0, Ordering::Relaxed);
        PAINTS.store(0, Ordering::Relaxed);
        SCROLLS.store(0, Ordering::Relaxed);
        MOVES.store(0, Ordering::Relaxed);

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handle = std::thread::spawn(move || run_window(scene, bounds, thread_stop));
        // Give the window a moment to appear and take its first paint, so the
        // duplication loop is not measuring the creation transient.
        std::thread::sleep(Duration::from_millis(400));
        Self {
            stop,
            handle: Some(handle),
        }
    }

    pub fn counters() -> GeneratorCounters {
        GeneratorCounters {
            paints: PAINTS.load(Ordering::Relaxed),
            scrolls: SCROLLS.load(Ordering::Relaxed),
            moves: MOVES.load(Ordering::Relaxed),
        }
    }
}

impl Drop for Generator {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn run_window(scene: Scene, bounds: Rect, stop: Arc<AtomicBool>) {
    let width = 960.min(bounds.right - bounds.left);
    let height = 720.min(bounds.bottom - bounds.top);
    let x0 = bounds.left + ((bounds.right - bounds.left) - width) / 2;
    let y0 = bounds.top + ((bounds.bottom - bounds.top) - height) / 2;

    let hwnd = unsafe {
        let instance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();
        let class = w!("swoop_capture_probe_generator");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance,
            lpszClassName: class,
            ..Default::default()
        };
        // A second run in the same process re-registers the class and fails
        // harmlessly; CreateWindowExW is the call that must succeed.
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            class,
            w!("swoop capture probe"),
            WS_POPUP | WS_VISIBLE,
            x0,
            y0,
            width,
            height,
            None,
            None,
            Some(instance),
            None,
        );
        match hwnd {
            Ok(hwnd) => hwnd,
            Err(_) => return,
        }
    };

    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = UpdateWindow(hwnd);
    }

    let restore_cursor = if scene == Scene::Cursor {
        let mut pt = POINT::default();
        let saved = unsafe { GetCursorPos(&mut pt) }.is_ok().then_some(pt);
        // Park the pointer over the window so its class cursor is the one the
        // duplication reports.
        let _ = unsafe { SetCursorPos(x0 + width / 2, y0 + height / 2) };
        saved
    } else {
        None
    };

    let started = Instant::now();
    let client = RECT {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };

    while !stop.load(Ordering::Relaxed) {
        pump(hwnd);
        match scene {
            Scene::Flood => {
                PHASE.fetch_add(1, Ordering::Relaxed);
                unsafe {
                    let _ = InvalidateRect(Some(hwnd), None, false);
                    let _ = UpdateWindow(hwnd);
                }
            }
            Scene::Scroll => {
                SCROLL_OFFSET.fetch_add(7, Ordering::Relaxed);
                unsafe {
                    ScrollWindowEx(
                        hwnd,
                        0,
                        -7,
                        Some(&client),
                        Some(&client),
                        None,
                        None,
                        SW_SCROLLCHILDREN,
                    );
                    let _ = UpdateWindow(hwnd);
                }
                SCROLLS.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(8));
            }
            Scene::Drag => {
                // A triangle-wave path across the output, ~1 px per step.
                let t = started.elapsed().as_millis() as i32 / 4;
                let span = (bounds.right - bounds.left - width).max(1);
                let phase = t % (2 * span);
                let dx = if phase < span { phase } else { 2 * span - phase };
                unsafe {
                    let _ = SetWindowPos(
                        hwnd,
                        None,
                        bounds.left + dx,
                        y0,
                        0,
                        0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
                MOVES.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(8));
            }
            Scene::Cursor => {
                let kind = (started.elapsed().as_millis() / 700) as usize % CURSORS.len();
                CURSOR_KIND.store(kind, Ordering::Relaxed);
                // SetCursor directly as well as from WM_SETCURSOR: the pointer
                // is parked, so without a mouse move the window would never be
                // asked to set its cursor again.
                apply_cursor(kind);
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    if let Some(pt) = restore_cursor {
        let _ = unsafe { SetCursorPos(pt.x, pt.y) };
    }
    unsafe {
        let _ = DestroyWindow(hwnd);
        pump(HWND::default());
    }
}

fn pump(_hwnd: HWND) {
    let mut msg = MSG::default();
    unsafe {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = DispatchMessageW(&msg);
        }
    }
}

const CURSORS: [PCWSTR; 6] = [
    IDC_ARROW,
    IDC_IBEAM,
    IDC_WAIT,
    IDC_HAND,
    IDC_SIZEALL,
    IDC_APPSTARTING,
];

fn apply_cursor(kind: usize) {
    unsafe {
        if let Ok(cursor) = LoadCursorW(None, CURSORS[kind]) {
            SetCursor(Some(cursor));
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let phase = PHASE.load(Ordering::Relaxed) as i32;
            let offset = SCROLL_OFFSET.load(Ordering::Relaxed);
            let rc = ps.rcPaint;
            let first = (rc.top + offset).div_euclid(BAR_HEIGHT);
            let last = (rc.bottom + offset).div_euclid(BAR_HEIGHT);
            for bar in first..=last {
                let top = bar * BAR_HEIGHT - offset;
                let band = RECT {
                    left: rc.left,
                    top: top.max(rc.top),
                    right: rc.right,
                    bottom: (top + BAR_HEIGHT).min(rc.bottom),
                };
                if band.bottom <= band.top {
                    continue;
                }
                let n = (bar + phase).rem_euclid(6) as u32;
                let color = COLORREF(0x0000_2020 * (n + 1) + 0x0040_0000 * ((n % 3) + 1));
                let brush: HBRUSH = CreateSolidBrush(color);
                FillRect(hdc, &band, brush);
                let _ = DeleteObject(brush.into());
            }
            let _ = EndPaint(hwnd, &ps);
            PAINTS.fetch_add(1, Ordering::Relaxed);
            LRESULT(0)
        }
        WM_SETCURSOR => {
            apply_cursor(CURSOR_KIND.load(Ordering::Relaxed));
            LRESULT(1)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cursor_table_covers_a_monochrome_a_colour_and_an_animated_shape() {
        // IDC_ARROW is monochrome, IDC_HAND is a colour shape and
        // IDC_APPSTARTING/IDC_WAIT are animated - the three cases Task 4.4 has
        // to render.
        assert_eq!(CURSORS.len(), 6);
    }

    #[test]
    #[ignore = "opens a window on the desktop; cargo test -- --ignored"]
    fn the_generator_paints_while_it_is_alive() {
        let bounds = Rect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let generator = Generator::start(Scene::Flood, bounds);
        std::thread::sleep(Duration::from_millis(500));
        let counters = Generator::counters();
        drop(generator);
        assert!(counters.paints > 10, "only {} paints", counters.paints);
    }
}
