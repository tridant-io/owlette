//! Primitive (4), the injection half, and primitive (5), `SendSAS`.
//!
//! Each arm runs on a **fresh thread**, joined before the next one starts,
//! because `SetThreadDesktop` cannot be undone for the thread that called it:
//! one arm sharing a thread with the next would measure the first arm's
//! attachment twice and call it two results.
//!
//! What each arm reports is deliberately *two* things per half, because the
//! failure this spike exists to pin down does not show up in the first one:
//!
//! - `sendInput*` is what `SendInput` returned, with the real last error. A
//!   desktop opened without `DESKTOP_JOURNALPLAYBACK` fails here, loudly:
//!   `0 of 1, last error 5`.
//! - `*Arrived` is whether the event reached the input stack at all, read back
//!   through `GetCursorPos` and `GetAsyncKeyState`. A pre-emptive attach fails
//!   *only* here: `SendInput` returns the full count, sets no error, and the
//!   key never arrives.
//!
//! Shift alone types nothing, so the keyboard half is safe whatever has focus,
//! and the release is injected before anything is reported: a panic between the
//! two would leave a real key held down on the machine.

use std::time::{Duration, Instant};

use windows::core::{s, w, BOOL};
use windows::Win32::Foundation::{GetLastError, SetLastError, POINT, WIN32_ERROR};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, SetThreadDesktop};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

use crate::json::{self, Val};
use crate::{desk, probe, rights};

/// Left shift's scancode. Sent as a scancode rather than a virtual key so the
/// path is the one the product uses, and read back on VK_SHIFT (0x10).
const SCAN_LSHIFT: u16 = 0x2A;
const VK_SHIFT: i32 = 0x10;

/// `SendInput` only queues; the raw input thread applies the event, so reading
/// the state back in the same instant is a race. 500 ms is 100x the observed
/// settle time and still bounded.
const SETTLE_TIMEOUT: Duration = Duration::from_millis(500);
const SETTLE_POLL: Duration = Duration::from_millis(5);

/// Run one arm on its own thread and return the json line it produced.
pub fn arm(access_name: &str) -> String {
    let access_name = access_name.to_string();
    std::thread::spawn(move || measure(&access_name))
        .join()
        .unwrap_or_else(|_| {
            json::obj(&[
                ("type", json::s("inject_result")),
                ("arm", json::s("panicked")),
            ])
        })
}

fn measure(access_name: &str) -> String {
    let access = rights::by_name(access_name);
    let before_desktop = probe::thread_desktop_name();

    let mut attached = false;
    let mut input_desktop = "unknown".to_string();
    if let Some((handle, name)) = desk::look(access.mask) {
        input_desktop = name;
        if access.attaches {
            attached = unsafe { SetThreadDesktop(handle) }.is_ok();
        }
        if !attached {
            let _ = unsafe { CloseDesktop(handle) };
        }
        // An attached handle is deliberately leaked: closing the desktop this
        // thread is on fails, and the thread is about to end anyway.
    }

    let mouse = mouse_half();
    let keyboard = keyboard_half();

    json::obj(&[
        ("type", json::s("inject_result")),
        ("arm", json::s(access.name)),
        ("attachRequested", Val::Bool(access.attaches)),
        ("attached", Val::Bool(attached)),
        ("desktopBefore", json::s(before_desktop)),
        ("inputDesktop", json::s(input_desktop)),
        ("desktopAfter", json::s(probe::thread_desktop_name())),
        ("sendInputMouse", Val::Num(mouse.sent as i64)),
        ("mouseLastError", Val::Num(mouse.last_error as i64)),
        ("mouseArrived", Val::Bool(mouse.arrived)),
        ("sendInputKeyDown", Val::Num(keyboard.sent as i64)),
        ("keyLastError", Val::Num(keyboard.last_error as i64)),
        ("keyDownArrived", Val::Bool(keyboard.down_arrived)),
        ("keyUpArrived", Val::Bool(keyboard.up_arrived)),
    ])
}

struct MouseResult {
    sent: u32,
    last_error: u32,
    arrived: bool,
}

/// Move the pointer a short way, check it landed, and put it back.
fn mouse_half() -> MouseResult {
    let mut origin = POINT::default();
    let read_origin = unsafe { GetCursorPos(&mut origin) }.is_ok();

    let bounds = virtual_screen();
    // 40 px right, clamped inside the virtual desktop, so the move is visible
    // to `GetCursorPos` without throwing the pointer across the screen.
    let target_x = (origin.x + 40).min(bounds.2 - 1).max(bounds.0);
    let target_y = origin.y.min(bounds.3 - 1).max(bounds.1);

    let (sent, last_error) = send(&[mouse_move(target_x, target_y, bounds)]);
    let arrived = read_origin
        && settle(|| {
            let mut now = POINT::default();
            unsafe { GetCursorPos(&mut now) }.is_ok() && (now.x - target_x).abs() <= 2
        });

    if read_origin {
        let _ = send(&[mouse_move(origin.x, origin.y, bounds)]);
    }
    MouseResult {
        sent,
        last_error,
        arrived,
    }
}

struct KeyResult {
    sent: u32,
    last_error: u32,
    down_arrived: bool,
    up_arrived: bool,
}

fn keyboard_half() -> KeyResult {
    let (sent, last_error) = send(&[key(false)]);
    let down_arrived = settle(|| unsafe { GetAsyncKeyState(VK_SHIFT) } < 0);
    // Unconditional, before anything is reported.
    let _ = send(&[key(true)]);
    let up_arrived = settle(|| unsafe { GetAsyncKeyState(VK_SHIFT) } >= 0);
    KeyResult {
        sent,
        last_error,
        down_arrived,
        up_arrived,
    }
}

/// `SendInput` with the last error read back the way Win32 requires: cleared
/// first, so a stale error from an unrelated call cannot be reported as this
/// one's.
fn send(events: &[INPUT]) -> (u32, u32) {
    unsafe { SetLastError(WIN32_ERROR(0)) };
    let sent = unsafe { SendInput(events, std::mem::size_of::<INPUT>() as i32) };
    (sent, unsafe { GetLastError() }.0)
}

fn settle(mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + SETTLE_TIMEOUT;
    while Instant::now() < deadline {
        // Sleep first: the state is never up to date in the same instant the
        // call returns.
        std::thread::sleep(SETTLE_POLL);
        if ready() {
            return true;
        }
    }
    false
}

/// (left, top, right, bottom) of the whole virtual desktop, in physical pixels.
fn virtual_screen() -> (i32, i32, i32, i32) {
    probe::set_dpi_awareness();
    unsafe {
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        (
            left,
            top,
            left + GetSystemMetrics(SM_CXVIRTUALSCREEN),
            top + GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

fn mouse_move(x: i32, y: i32, bounds: (i32, i32, i32, i32)) -> INPUT {
    let (dx, dy) = to_absolute(x, y, bounds);
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Desktop pixels to the 0..65535 space `MOUSEEVENTF_ABSOLUTE` takes.
///
/// The divisor is `span - 1`, not `span`: the endpoint has to be reachable, and
/// dividing by the span leaves the last column unaddressable.
fn to_absolute(x: i32, y: i32, bounds: (i32, i32, i32, i32)) -> (i32, i32) {
    let (left, top, right, bottom) = bounds;
    let width = (right - left).max(2) - 1;
    let height = (bottom - top).max(2) - 1;
    (
        ((x - left) as i64 * 65535 / width as i64) as i32,
        ((y - top) as i64 * 65535 / height as i64) as i32,
    )
}

fn key(up: bool) -> INPUT {
    let mut flags = KEYEVENTF_SCANCODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: SCAN_LSHIFT,
                dwFlags: KEYBD_EVENT_FLAGS(flags.0),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Primitive (5): raise the secure attention sequence.
///
/// `SendSAS` is loaded at runtime rather than linked. `sas.dll` is present on
/// every supported Windows, but a link-time import turns a missing dll into a
/// process that will not start at all, and the whole point of the spike is that
/// the failure is legible. `FALSE` asks for the services form, which is the one
/// a LocalSystem caller is entitled to and requires
/// `SoftwareSASGeneration = 3` — the harness sets that, records what was there
/// before, and puts it back.
///
/// It returns void: nothing here can tell you the sequence was raised. What
/// says so is the desktop switching to `Winlogon`, which the `desk` run sees,
/// and the human's eyes.
pub fn send_sas() -> String {
    let before = probe::thread_desktop_name();
    let Ok(module) = (unsafe { LoadLibraryW(w!("sas.dll")) }) else {
        return json::obj(&[
            ("type", json::s("sas_result")),
            ("ok", Val::Bool(false)),
            ("reason", json::s("sas_dll_not_loaded")),
        ]);
    };
    let Some(entry) = (unsafe { GetProcAddress(module, s!("SendSAS")) }) else {
        return json::obj(&[
            ("type", json::s("sas_result")),
            ("ok", Val::Bool(false)),
            ("reason", json::s("sendsas_not_exported")),
        ]);
    };
    let send_sas: unsafe extern "system" fn(BOOL) = unsafe { std::mem::transmute(entry) };
    let at = Instant::now();
    unsafe { send_sas(BOOL(0)) };
    json::obj(&[
        ("type", json::s("sas_result")),
        ("ok", Val::Bool(true)),
        ("reason", json::s("called")),
        ("callMs", Val::F64(at.elapsed().as_secs_f64() * 1000.0)),
        ("desktopBefore", json::s(before)),
        ("inputDesktopAfter", json::s(input_desktop_now())),
    ])
}

fn input_desktop_now() -> String {
    // A moment for Winlogon to take the input desktop, if it is going to.
    std::thread::sleep(Duration::from_millis(250));
    match desk::look(rights::CAPTURE) {
        Some((handle, name)) => {
            let _ = unsafe { CloseDesktop(handle) };
            name
        }
        None => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOUNDS: (i32, i32, i32, i32) = (0, 0, 1920, 1080);

    #[test]
    fn absolute_coordinates_reach_both_endpoints() {
        assert_eq!(to_absolute(0, 0, BOUNDS), (0, 0));
        assert_eq!(to_absolute(1919, 1079, BOUNDS), (65535, 65535));
    }

    #[test]
    fn absolute_coordinates_handle_a_virtual_desktop_with_a_negative_origin() {
        // The 0.8 box's rotated 4K panel sits at a negative origin.
        let bounds = (-2160, -1240, 1920, 1080);
        assert_eq!(to_absolute(-2160, -1240, bounds), (0, 0));
        assert_eq!(to_absolute(1919, 1079, bounds), (65535, 65535));
    }

    #[test]
    fn a_degenerate_screen_does_not_divide_by_zero() {
        assert_eq!(to_absolute(0, 0, (0, 0, 1, 1)), (0, 0));
    }

    #[test]
    fn the_key_event_is_a_scancode_and_the_release_carries_keyup() {
        let down = key(false);
        let up = key(true);
        unsafe {
            assert_eq!(down.Anonymous.ki.wScan, SCAN_LSHIFT);
            assert_eq!(down.Anonymous.ki.dwFlags, KEYEVENTF_SCANCODE);
            assert_eq!(up.Anonymous.ki.dwFlags.0, KEYEVENTF_SCANCODE.0 | KEYEVENTF_KEYUP.0);
        }
    }

    #[test]
    fn the_mouse_event_is_absolute_across_the_whole_virtual_desktop() {
        let event = mouse_move(960, 540, BOUNDS);
        unsafe {
            assert_eq!(
                event.Anonymous.mi.dwFlags,
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
            );
        }
    }

    #[test]
    #[ignore = "MOVES THE REAL MOUSE POINTER and presses a real key; cargo test -- --ignored"]
    fn the_unattached_arm_reaches_this_machine() {
        let line = arm("none");
        println!("{line}");
        assert!(line.contains(r#""arm":"none""#));
    }
}
