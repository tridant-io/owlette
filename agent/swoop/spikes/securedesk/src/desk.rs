//! Primitive (4), the capture half: follow the input desktop across
//! Default <-> Winlogon and rebuild the D3D11 device and the duplication after
//! `DXGI_ERROR_ACCESS_LOST`, timing every recovery.
//!
//! This runs on a **dedicated thread** because `SetThreadDesktop` refuses a
//! thread that owns a window, a timer or a hook, and because a desktop
//! association belongs to the thread that made it. The thread this module
//! spawns owns none of those: it opens a desktop, creates a device and blocks
//! in `AcquireNextFrame`.
//!
//! The clock that matters is **event -> first frame carrying a picture**, not
//! event -> duplication created. A rebuilt duplication hands back frames with
//! `LastPresentTime == 0` while the new desktop has not composed anything yet,
//! and a viewer looking at those is looking at nothing. Both are reported so
//! the memo can separate the API cost from the compositor's.
//!
//! `OpenInputDesktop` failing is not proof the machine is locked: it is equally
//! a switch in progress, or a thread without rights to the desktop that is now
//! current. Nothing is concluded from it and the next look tries again.

use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Foundation::{E_ACCESSDENIED, HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11Texture2D, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, IDXGIOutput1,
    IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT,
    DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, SetThreadDesktop,
    DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, HDESK, UOI_NAME,
};

use crate::json::{self, Val};
use crate::rights;

/// The product's blocking-acquire timeout, measured in spike 0.8 as the knee
/// between wasted CPU and added jitter.
const ACQUIRE_TIMEOUT_MS: u32 = 8;

/// How long to wait before retrying a duplication that could not be created.
/// A `DuplicateOutput` on a desktop this thread has no rights to fails
/// instantly, and without this the loop spins a core for the whole run.
const REBUILD_BACKOFF: Duration = Duration::from_millis(100);

/// One desktop-following capture run.
pub struct Run {
    access: DESKTOP_ACCESS_FLAGS,
    access_name: &'static str,
    output: usize,
    switches: u32,
    losses: u32,
    recoveries: u32,
    frames: u64,
    blank: u64,
}

/// Why the duplication has to be rebuilt.
#[derive(Clone, Copy, PartialEq)]
enum Pending {
    Switch,
    AccessLost,
}

impl Pending {
    fn name(self) -> &'static str {
        match self {
            Pending::Switch => "desktop_switch",
            Pending::AccessLost => "access_lost",
        }
    }
}

impl Run {
    pub fn new(access_name: &str, output: usize) -> Self {
        let access = rights::by_name(access_name);
        Self {
            access: access.mask,
            access_name: access.name,
            output,
            switches: 0,
            losses: 0,
            recoveries: 0,
            frames: 0,
            blank: 0,
        }
    }

    /// Follow the input desktop for `seconds`, emitting a json line per event.
    ///
    /// `emit` is called from this thread only.
    pub fn run(&mut self, seconds: u64, emit: &dyn Fn(String)) {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let mut held: Option<HDESK> = None;
        let mut seen = String::new();
        let mut live: Option<Live> = None;
        let mut pending: Option<(Pending, Instant)> = None;
        let mut retry_at = Instant::now();

        emit(json::obj(&[
            ("type", json::s("desk_start")),
            ("access", json::s(self.access_name)),
            ("output", Val::Num(self.output as i64)),
            ("seconds", Val::Num(seconds as i64)),
            ("desktop", json::s(crate::probe::thread_desktop_name())),
        ]));

        while Instant::now() < deadline {
            // 1. Has the input desktop moved? Attaching to a desktop this
            //    thread is already on is not free (see rights.rs), so the name
            //    decides, not the handle.
            if let Some((handle, name)) = look(self.access) {
                if name == seen {
                    let _ = unsafe { CloseDesktop(handle) };
                } else {
                    let at = Instant::now();
                    let attached = unsafe { SetThreadDesktop(handle) }.is_ok();
                    if attached {
                        if let Some(previous) = held.replace(handle) {
                            let _ = unsafe { CloseDesktop(previous) };
                        }
                        let from = std::mem::replace(&mut seen, name.clone());
                        // The old duplication belongs to the old desktop.
                        live = None;
                        if !from.is_empty() {
                            self.switches += 1;
                            // A lock produces two symptoms, an ACCESS_LOST and
                            // a name change, in either order. The clock starts
                            // at whichever arrived first and the reason names
                            // it, so `recoveredMs` measures the event and not
                            // the second thing it did.
                            pending.get_or_insert((Pending::Switch, at));
                        }
                        retry_at = Instant::now();
                        emit(json::obj(&[
                            ("type", json::s("desk_switch")),
                            ("from", json::s(if from.is_empty() { "-" } else { &from })),
                            ("to", json::s(&name)),
                            ("attachMs", Val::F64(ms_since(at))),
                        ]));
                    } else {
                        let _ = unsafe { CloseDesktop(handle) };
                    }
                }
            }

            // 2. Rebuild if there is nothing live. Not on every miss: a
            //    duplication that cannot be created on this desktop fails
            //    instantly and would otherwise spin a core.
            if live.is_none() {
                if Instant::now() < retry_at {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                let at = Instant::now();
                match Live::open(self.output) {
                    Ok(opened) => {
                        emit(json::obj(&[
                            ("type", json::s("desk_rebuilt")),
                            ("desktop", json::s(&seen)),
                            ("buildMs", Val::F64(ms_since(at))),
                            ("width", Val::Num(opened.width as i64)),
                            ("height", Val::Num(opened.height as i64)),
                        ]));
                        live = Some(opened);
                    }
                    Err(e) => {
                        retry_at = Instant::now() + REBUILD_BACKOFF;
                        emit(json::obj(&[
                            ("type", json::s("desk_error")),
                            ("stage", json::s("duplicate")),
                            ("desktop", json::s(&seen)),
                            ("hresult", json::s(hresult(&e))),
                            (
                                "accessDenied",
                                Val::Bool(e.code() == E_ACCESSDENIED),
                            ),
                        ]));
                        continue;
                    }
                }
            }

            // 3. One acquire.
            let Some(current) = live.as_mut() else {
                continue;
            };
            match current.next() {
                Step::Content { width, height } => {
                    self.frames += 1;
                    if let Some((reason, at)) = pending.take() {
                        self.recoveries += 1;
                        emit(json::obj(&[
                            ("type", json::s("desk_recovered")),
                            ("desktop", json::s(&seen)),
                            ("reason", json::s(reason.name())),
                            ("recoveredMs", Val::F64(ms_since(at))),
                            ("blankFrames", Val::Num(self.blank as i64)),
                            ("width", Val::Num(width as i64)),
                            ("height", Val::Num(height as i64)),
                        ]));
                        self.blank = 0;
                    }
                }
                Step::Blank => {
                    if pending.is_some() {
                        self.blank += 1;
                    }
                }
                Step::Nothing => {}
                Step::Lost => {
                    self.losses += 1;
                    live = None;
                    // Same rule as the switch arm: first symptom wins the
                    // clock, so a lock is timed once however it announced
                    // itself.
                    pending.get_or_insert((Pending::AccessLost, Instant::now()));
                    emit(json::obj(&[
                        ("type", json::s("desk_lost")),
                        ("desktop", json::s(&seen)),
                    ]));
                }
                Step::Failed(e) => {
                    live = None;
                    retry_at = Instant::now() + REBUILD_BACKOFF;
                    emit(json::obj(&[
                        ("type", json::s("desk_error")),
                        ("stage", json::s("acquire")),
                        ("desktop", json::s(&seen)),
                        ("hresult", json::s(hresult(&e))),
                    ]));
                }
            }
        }

        drop(live);
        if let Some(desktop) = held.take() {
            // Fails while this thread is still attached; the handle dies with
            // the thread either way.
            let _ = unsafe { CloseDesktop(desktop) };
        }
        emit(self.summary(&seen));
    }

    fn summary(&self, desktop: &str) -> String {
        json::obj(&[
            ("type", json::s("desk_done")),
            ("access", json::s(self.access_name)),
            ("desktop", json::s(desktop)),
            ("switches", Val::Num(self.switches as i64)),
            ("losses", Val::Num(self.losses as i64)),
            ("recoveries", Val::Num(self.recoveries as i64)),
            ("frames", Val::Num(self.frames as i64)),
        ])
    }
}

/// A live D3D11 device plus the duplication built on it. Both die together:
/// the device belongs to the desktop the duplication was created on.
struct Live {
    dup: IDXGIOutputDuplication,
    width: u32,
    height: u32,
    /// Held so the duplication outlives nothing it depends on.
    _device: ID3D11Device,
}

enum Step {
    Content { width: u32, height: u32 },
    Blank,
    Nothing,
    Lost,
    Failed(windows::core::Error),
}

impl Live {
    fn open(index: usize) -> windows::core::Result<Self> {
        let (adapter, output) = resolve_output(index)?;
        let device = create_device(&adapter)?;
        let output1: IDXGIOutput1 = output.cast()?;
        let dup = unsafe { output1.DuplicateOutput(&device) }?;
        let desc = unsafe { dup.GetDesc() };
        Ok(Self {
            dup,
            width: desc.ModeDesc.Width,
            height: desc.ModeDesc.Height,
            _device: device,
        })
    }

    fn next(&mut self) -> Step {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        if let Err(e) = unsafe {
            self.dup
                .AcquireNextFrame(ACQUIRE_TIMEOUT_MS, &mut info, &mut resource)
        } {
            return match e.code() {
                code if code == DXGI_ERROR_WAIT_TIMEOUT => Step::Nothing,
                code if code == DXGI_ERROR_ACCESS_LOST => Step::Lost,
                _ => Step::Failed(e),
            };
        }
        let step = match resource.as_ref() {
            // A frame with no present time carries no new desktop image: it is
            // how a cursor-only update arrives and what the first frames after
            // a rebuild look like while the new desktop has composed nothing.
            Some(_) if info.LastPresentTime == 0 => Step::Blank,
            Some(resource) => match size_of_frame(resource) {
                Ok((width, height)) => Step::Content { width, height },
                Err(e) => Step::Failed(e),
            },
            None => Step::Nothing,
        };
        // Back as early as possible: every duplication in the session is
        // serialised behind Desktop Duplication's lock while a frame is held.
        let _ = unsafe { self.dup.ReleaseFrame() };
        step
    }
}

fn size_of_frame(resource: &IDXGIResource) -> windows::core::Result<(u32, u32)> {
    let texture: ID3D11Texture2D = resource.cast()?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    Ok((desc.Width, desc.Height))
}

/// The `index`th output across every adapter, with the adapter that owns it.
/// Duplication is same-adapter only, so the pair has to travel together.
fn resolve_output(index: usize) -> windows::core::Result<(IDXGIAdapter1, IDXGIOutput)> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }?;
    let mut seen = 0usize;
    let mut a = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(a) } {
        let mut o = 0u32;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            if seen == index {
                return Ok((adapter, output));
            }
            seen += 1;
            o += 1;
        }
        a += 1;
    }
    Err(windows::core::Error::new(
        windows::Win32::Foundation::E_INVALIDARG,
        format!("no output with index {index} (saw {seen})"),
    ))
}

fn create_device(adapter: &IDXGIAdapter1) -> windows::core::Result<ID3D11Device> {
    let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
    let mut device = None;
    unsafe {
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?;
    }
    device.ok_or_else(|| windows::core::Error::new(E_ACCESSDENIED, "no device"))
}

/// The input desktop and its name, at `access`. The caller owns the handle.
pub fn look(access: DESKTOP_ACCESS_FLAGS) -> Option<(HDESK, String)> {
    let handle = unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, access) }.ok()?;
    let mut buffer = [0u16; 128];
    let mut needed = 0u32;
    let named = unsafe {
        GetUserObjectInformationW(
            HANDLE(handle.0),
            UOI_NAME,
            Some(buffer.as_mut_ptr().cast()),
            std::mem::size_of_val(&buffer) as u32,
            Some(&mut needed),
        )
    };
    if named.is_err() {
        let _ = unsafe { CloseDesktop(handle) };
        return None;
    }
    let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    Some((handle, String::from_utf16_lossy(&buffer[..len])))
}

pub fn hresult(e: &windows::core::Error) -> String {
    format!("0x{:08X}", e.code().0 as u32)
}

fn ms_since(at: Instant) -> f64 {
    at.elapsed().as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_reasons_are_the_names_the_memo_reports() {
        assert_eq!(Pending::Switch.name(), "desktop_switch");
        assert_eq!(Pending::AccessLost.name(), "access_lost");
    }

    #[test]
    fn hresult_renders_the_dxgi_codes_the_memo_quotes() {
        let lost = windows::core::Error::new(DXGI_ERROR_ACCESS_LOST, "");
        assert_eq!(hresult(&lost), "0x887A0026");
        let denied = windows::core::Error::new(E_ACCESSDENIED, "");
        assert_eq!(hresult(&denied), "0x80070005");
    }

    #[test]
    fn a_run_starts_with_every_counter_at_zero() {
        let run = Run::new("capture", 0);
        assert_eq!(run.access_name, "capture");
        assert_eq!((run.switches, run.losses, run.recoveries, run.frames), (0, 0, 0, 0));
    }

    #[test]
    fn the_summary_carries_the_counters_and_the_desktop() {
        let run = Run::new("inject", 0);
        let line = run.summary("Winlogon");
        assert!(line.contains(r#""type":"desk_done""#), "{line}");
        assert!(line.contains(r#""desktop":"Winlogon""#), "{line}");
        assert!(line.contains(r#""access":"inject""#), "{line}");
    }
}
