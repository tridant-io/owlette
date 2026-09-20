//! The host-side instrument: a low-level mouse hook, a borderless fullscreen
//! window backed by a DXGI flip-model swapchain, and four `QueryPerformance-
//! Counter` timestamps per button-down.
//!
//! The swapchain is not decoration. `IDXGISwapChain::GetFrameStatistics` gives
//! `SyncQPCTime` - the QPC of the vertical blank at which a present was
//! displayed - which turns "the compositor wait" from a modelled term into a
//! measured one. What remains invisible to this process is scanout position and
//! panel response, and only those need a camera.
//!
//! Hardware-dependent tests in this module are `#[ignore]`d. Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/latency-target
//! cargo test -- --ignored --nocapture
//! ```

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use windows::core::{w, BOOL};
use windows::Win32::Foundation::{HMODULE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11RenderTargetView, ID3D11Texture2D,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory2, IDXGISwapChain1, DXGI_FRAME_STATISTICS, DXGI_MWA_NO_ALT_ENTER,
    DXGI_PRESENT, DXGI_SCALING_NONE, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_EFFECT_FLIP_DISCARD,
    DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT,
    VK_ESCAPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetCursorPos,
    MsgWaitForMultipleObjectsEx, PeekMessageW, PostMessageW, PostQuitMessage, RegisterClassW,
    SetCursorPos, SetForegroundWindow, SetWindowsHookExW, ShowWindow, TranslateMessage,
    UnhookWindowsHookEx, HC_ACTION, HHOOK, LLMHF_INJECTED, MONITORINFOF_PRIMARY, MSG,
    MSLLHOOKSTRUCT, MWMO_INPUTAVAILABLE, PM_REMOVE, QS_ALLINPUT, SW_SHOW, WH_MOUSE_LL, WM_APP,
    WM_DESTROY, WM_KEYDOWN, WM_LBUTTONDOWN, WM_QUIT, WNDCLASSW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};

use crate::clock::{qpc, qpf};
use crate::stats::{self, Sample};

/// Posted by the hook to the window; `wParam` is the ring slot sequence.
const WM_APP_FLIP: u32 = WM_APP + 1;
/// Posted by the deadline watchdog to end the run.
const WM_APP_STOP: u32 = WM_APP + 2;

/// Ring of hook timestamps. A `WH_MOUSE_LL` callback must not block - a stalled
/// hook is removed by the OS after `LowLevelHooksTimeout` - so it writes into
/// preallocated atomics and posts the slot index instead of taking any lock.
const RING: usize = 1024;
static RING_QPC: [AtomicI64; RING] = [const { AtomicI64::new(0) }; RING];
static RING_FLAGS: [AtomicU32; RING] = [const { AtomicU32::new(0) }; RING];
static RING_SEQ: AtomicU64 = AtomicU64::new(0);
/// The window the hook posts to, as an `isize` because `HWND` is not `Send`.
static HOOK_TARGET: AtomicIsize = AtomicIsize::new(0);
/// Set once the run is over so the autoclick thread stops injecting.
static RUN_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Injected clicks walk their period through `0..PHASE_DITHER_MS` extra
/// milliseconds so the series samples every phase of the display's refresh
/// period rather than one fixed phase. 17 ms is one whole 60 Hz period
/// (measured at 16.66 ms, spike 0.8 s4) rounded up.
const PHASE_DITHER_MS: u64 = 17;

pub struct MonitorInfo {
    pub index: usize,
    pub device: String,
    pub bounds: RECT,
    pub primary: bool,
}

impl MonitorInfo {
    pub fn width(&self) -> i32 {
        self.bounds.right - self.bounds.left
    }
    pub fn height(&self) -> i32 {
        self.bounds.bottom - self.bounds.top
    }
}

/// Call once, before any DXGI or monitor call. Spike 0.8 s3 measured a
/// DPI-unaware caller reading this box's 125% monitor 25% small.
pub fn set_dpi_awareness() {
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

pub fn monitors() -> Vec<MonitorInfo> {
    let mut out: Vec<MonitorInfo> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_enum),
            LPARAM(&mut out as *mut Vec<MonitorInfo> as isize),
        );
    }
    for (i, m) in out.iter_mut().enumerate() {
        m.index = i;
    }
    out
}

unsafe extern "system" fn monitor_enum(
    monitor: HMONITOR,
    _hdc: HDC,
    _clip: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let out = &mut *(data.0 as *mut Vec<MonitorInfo>);
    let mut info = MONITORINFOEXW {
        monitorInfo: MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    if GetMonitorInfoW(monitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
        let len = info
            .szDevice
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(info.szDevice.len());
        out.push(MonitorInfo {
            index: 0,
            device: String::from_utf16_lossy(&info.szDevice[..len]),
            bounds: info.monitorInfo.rcMonitor,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
    }
    BOOL(1)
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && wparam.0 == WM_LBUTTONDOWN as usize {
        // First statement in the hook: everything after this is measured.
        let t = qpc();
        let injected = if lparam.0 == 0 {
            0
        } else {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            u32::from(info.flags & LLMHF_INJECTED != 0)
        };
        let seq = RING_SEQ.fetch_add(1, Ordering::Relaxed);
        let slot = seq as usize % RING;
        RING_QPC[slot].store(t, Ordering::Relaxed);
        // Release so the reader that acquires the flags sees the timestamp.
        RING_FLAGS[slot].store(injected, Ordering::Release);
        let hwnd = HOOK_TARGET.load(Ordering::Relaxed);
        if hwnd != 0 {
            let _ = PostMessageW(
                Some(HWND(hwnd as *mut c_void)),
                WM_APP_FLIP,
                WPARAM(seq as usize),
                LPARAM(0),
            );
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

pub struct RunConfig {
    pub monitor: usize,
    pub seconds: f64,
    pub autoclick_hz: f64,
    pub warmup: usize,
    pub csv_path: Option<String>,
}

pub struct RunResult {
    pub freq: i64,
    pub samples: Vec<Sample>,
    pub monitor: String,
    pub monitor_size: (i32, i32),
    pub unresolved_presents: usize,
    pub clicks_injected: u64,
}

/// The two high-contrast colours. Full black and full white: the camera pass
/// has to separate them at 240 fps through a phone's rolling shutter.
const COLOURS: [[f32; 4]; 2] = [[0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0]];

pub fn run(cfg: &RunConfig) -> windows::core::Result<RunResult> {
    let freq = qpf();
    let mons = monitors();
    let mon = mons
        .get(cfg.monitor)
        .or_else(|| mons.first())
        .ok_or_else(windows::core::Error::from_thread)?;
    let (x, y, w, h) = (
        mon.bounds.left,
        mon.bounds.top,
        mon.width().max(1),
        mon.height().max(1),
    );

    let hwnd = unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = w!("swoop_latency_target");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            lpszClassName: class,
            ..Default::default()
        };
        // A second run in the same process re-registers the class and fails
        // harmlessly; CreateWindowExW is the call that must succeed.
        RegisterClassW(&wc);
        CreateWindowExW(
            WS_EX_TOPMOST,
            class,
            w!("swoop latency target"),
            WS_POPUP | WS_VISIBLE,
            x,
            y,
            w,
            h,
            None,
            None,
            Some(instance.into()),
            None,
        )?
    };
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
    }

    let (device, context) = create_device()?;
    let (swapchain, rtv) = create_swapchain(&device, hwnd, w as u32, h as u32)?;

    HOOK_TARGET.store(hwnd.0 as isize, Ordering::Relaxed);
    RUN_ACTIVE.store(true, Ordering::Relaxed);
    let hook: HHOOK = unsafe {
        let instance = GetModuleHandleW(None)?;
        SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), Some(instance.into()), 0)?
    };

    // Park the pointer in the middle of the target monitor so injected clicks
    // land on this window and not on whatever is on the other display.
    let saved_cursor = {
        let mut p = POINT::default();
        let ok = unsafe { GetCursorPos(&mut p) }.is_ok();
        let _ = unsafe { SetCursorPos(x + w / 2, y + h / 2) };
        ok.then_some(p)
    };

    let clicks = std::sync::Arc::new(AtomicU64::new(0));
    if cfg.autoclick_hz > 0.0 {
        let period = Duration::from_secs_f64(1.0 / cfg.autoclick_hz);
        let counter = std::sync::Arc::clone(&clicks);
        std::thread::Builder::new()
            .name("autoclick".into())
            .spawn(move || {
                // Let the first present and the compositor settle before the
                // series starts; the warmup samples are dropped anyway.
                std::thread::sleep(Duration::from_millis(300));
                let mut n = 0u64;
                while RUN_ACTIVE.load(Ordering::Relaxed) {
                    inject_left_click();
                    counter.fetch_add(1, Ordering::Relaxed);
                    // Dither the period across one whole refresh period. A
                    // fixed 5 Hz cadence is exactly 12 refresh periods at
                    // 60 Hz, which would sample one vsync phase over and over
                    // and report a distribution narrower than the real one.
                    std::thread::sleep(period + Duration::from_millis(n % PHASE_DITHER_MS));
                    n += 1;
                }
            })
            .ok();
    }

    // Deadline watchdog, and behind it a failsafe: a wedged message pump must
    // never leave a topmost fullscreen window owning the screen.
    {
        let target = hwnd.0 as isize;
        let seconds = cfg.seconds;
        std::thread::Builder::new()
            .name("deadline".into())
            .spawn(move || {
                std::thread::sleep(Duration::from_secs_f64(seconds));
                let _ = unsafe {
                    PostMessageW(
                        Some(HWND(target as *mut c_void)),
                        WM_APP_STOP,
                        WPARAM(0),
                        LPARAM(0),
                    )
                };
                std::thread::sleep(Duration::from_secs(10));
                if RUN_ACTIVE.load(Ordering::Relaxed) {
                    eprintln!("latency-target: message pump wedged, force-exiting");
                    std::process::exit(2);
                }
            })
            .ok();
    }

    let mut state = FlipState {
        context,
        swapchain,
        rtv,
        colour: 0,
        samples: Vec::with_capacity(4096),
        warmup: cfg.warmup,
    };

    let started = Instant::now();
    let hard_deadline = Duration::from_secs_f64(cfg.seconds + 5.0);
    let mut stop = false;
    while !stop {
        let mut msg = MSG::default();
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            match msg.message {
                WM_APP_FLIP => {
                    handle_flip(&mut state, msg.wParam.0 as u64);
                    continue;
                }
                WM_APP_STOP | WM_QUIT => {
                    stop = true;
                    continue;
                }
                WM_KEYDOWN if msg.wParam.0 == VK_ESCAPE.0 as usize => {
                    stop = true;
                    continue;
                }
                _ => {}
            }
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        resolve_pending(&mut state);
        if started.elapsed() > hard_deadline {
            break;
        }
        // A message-wait state, so the low-level hook still runs on this thread
        // while we poll frame statistics every few milliseconds.
        unsafe {
            MsgWaitForMultipleObjectsEx(None, 4, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        }
    }

    RUN_ACTIVE.store(false, Ordering::Relaxed);
    let _ = unsafe { UnhookWindowsHookEx(hook) };
    HOOK_TARGET.store(0, Ordering::Relaxed);

    // The hook is gone, so a bounded spin here cannot distort a measurement.
    let spin_until = Instant::now() + Duration::from_millis(200);
    while Instant::now() < spin_until && state.samples.iter().any(|s| s.sync_qpc == 0) {
        resolve_pending(&mut state);
        std::thread::sleep(Duration::from_millis(2));
    }

    if let Some(p) = saved_cursor {
        let _ = unsafe { SetCursorPos(p.x, p.y) };
    }
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(hwnd);
    }

    let unresolved = state.samples.iter().filter(|s| s.sync_qpc == 0).count();
    Ok(RunResult {
        freq,
        samples: state.samples,
        monitor: mon.device.clone(),
        monitor_size: (w, h),
        unresolved_presents: unresolved,
        clicks_injected: clicks.load(Ordering::Relaxed),
    })
}

struct FlipState {
    context: ID3D11DeviceContext,
    swapchain: IDXGISwapChain1,
    rtv: ID3D11RenderTargetView,
    colour: usize,
    samples: Vec<Sample>,
    warmup: usize,
}

fn handle_flip(state: &mut FlipState, seq: u64) {
    let slot = seq as usize % RING;
    let injected = RING_FLAGS[slot].load(Ordering::Acquire) != 0;
    let hook_qpc = RING_QPC[slot].load(Ordering::Relaxed);
    let dispatch_qpc = qpc();

    state.colour ^= 1;
    let colour = COLOURS[state.colour];
    unsafe {
        state
            .context
            .OMSetRenderTargets(Some(&[Some(state.rtv.clone())]), None);
        state
            .context
            .ClearRenderTargetView(&state.rtv, &colour);
    }

    let present_call_qpc = qpc();
    let hr = unsafe { state.swapchain.Present(1, DXGI_PRESENT(0)) };
    let present_return_qpc = qpc();
    if hr.is_err() {
        eprintln!("latency-target: Present failed: {hr:?}");
        return;
    }

    let present_id = unsafe { state.swapchain.GetLastPresentCount() }.unwrap_or(0);

    let index = state.samples.len();
    state.samples.push(Sample {
        seq,
        injected,
        hook_qpc,
        dispatch_qpc,
        present_call_qpc,
        present_return_qpc,
        present_id,
        sync_qpc: 0,
        present_refresh_count: 0,
        colour: state.colour as u8,
        warmup: index < state.warmup,
    });
}

/// Attach `SyncQPCTime` to any sample whose present is the one frame statistics
/// is currently reporting.
///
/// `GetFrameStatistics` describes the most recently *displayed* present, so the
/// match has to be exact: a sample whose `PresentCount` has already been passed
/// can never be resolved and is counted as unresolved rather than given a
/// neighbouring frame's vblank.
fn resolve_pending(state: &mut FlipState) {
    if !state.samples.iter().any(|s| s.sync_qpc == 0) {
        return;
    }
    let mut fs = DXGI_FRAME_STATISTICS::default();
    if unsafe { state.swapchain.GetFrameStatistics(&mut fs) }.is_err() {
        // DXGI_ERROR_FRAME_STATISTICS_DISJOINT and friends are transient; the
        // next poll is 4 ms away.
        return;
    }
    if fs.SyncQPCTime == 0 {
        return;
    }
    for s in state.samples.iter_mut().filter(|s| s.sync_qpc == 0) {
        if s.present_id == fs.PresentCount {
            s.sync_qpc = fs.SyncQPCTime;
            s.present_refresh_count = fs.PresentRefreshCount;
        }
    }
}

fn inject_left_click() {
    let down = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: MOUSEEVENTF_LEFTDOWN,
                ..Default::default()
            },
        },
    };
    let up = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: MOUSEEVENTF_LEFTUP,
                ..Default::default()
            },
        },
    };
    unsafe {
        SendInput(&[down], std::mem::size_of::<INPUT>() as i32);
        SendInput(&[up], std::mem::size_of::<INPUT>() as i32);
    }
}

fn create_device() -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
    let levels: [D3D_FEATURE_LEVEL; 2] = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    Ok((device.unwrap(), context.unwrap()))
}

fn create_swapchain(
    device: &ID3D11Device,
    hwnd: HWND,
    width: u32,
    height: u32,
) -> windows::core::Result<(IDXGISwapChain1, ID3D11RenderTargetView)> {
    let factory: IDXGIFactory2 = unsafe { CreateDXGIFactory1()? };
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: width,
        Height: height,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        // Flip model: the only swap effect for which GetFrameStatistics is
        // implemented on a windowed swapchain, which is the whole point.
        BufferCount: 2,
        Scaling: DXGI_SCALING_NONE,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
        AlphaMode: DXGI_ALPHA_MODE_IGNORE,
        ..Default::default()
    };
    let swapchain = unsafe { factory.CreateSwapChainForHwnd(device, hwnd, &desc, None, None)? };
    let _ = unsafe { factory.MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER) };

    let back: ID3D11Texture2D = unsafe { swapchain.GetBuffer(0)? };
    let mut rtv = None;
    unsafe { device.CreateRenderTargetView(&back, None, Some(&mut rtv))? };
    Ok((swapchain, rtv.unwrap()))
}

/// stdout summary for a completed run, plus the CSV write.
pub fn report(result: &RunResult, csv_path: Option<&str>) -> std::io::Result<String> {
    let freq = result.freq;
    let measured: Vec<&Sample> = result.samples.iter().filter(|s| !s.warmup).collect();

    let mut hook_to_dispatch = Vec::new();
    let mut dispatch_to_present = Vec::new();
    let mut present_call_to_return = Vec::new();
    let mut hook_to_present_return = Vec::new();
    let mut present_to_sync = Vec::new();
    let mut hook_to_sync = Vec::new();
    for s in &measured {
        let st = stats::stages(s, freq);
        hook_to_dispatch.push(st.hook_to_dispatch);
        dispatch_to_present.push(st.dispatch_to_present_call);
        present_call_to_return.push(st.present_call_to_return);
        hook_to_present_return.push(st.hook_to_present_return);
        if let Some(v) = st.present_call_to_sync {
            present_to_sync.push(v);
        }
        if let Some(v) = st.hook_to_sync {
            hook_to_sync.push(v);
        }
    }

    let mut out = String::new();
    out.push_str(&format!(
        "monitor={} size={}x{} qpf={} samples={} (warmup dropped={}) injected_clicks={} unresolved_presents={}\n",
        result.monitor,
        result.monitor_size.0,
        result.monitor_size.1,
        freq,
        measured.len(),
        result.samples.len() - measured.len(),
        result.clicks_injected,
        result.unresolved_presents,
    ));
    out.push_str(&stats::render_table(&[
        ("hook -> dispatch", stats::summarize(&hook_to_dispatch)),
        (
            "dispatch -> Present call",
            stats::summarize(&dispatch_to_present),
        ),
        (
            "Present call -> return",
            stats::summarize(&present_call_to_return),
        ),
        (
            "hook -> Present return",
            stats::summarize(&hook_to_present_return),
        ),
        (
            "Present call -> vblank",
            stats::summarize(&present_to_sync),
        ),
        ("hook -> vblank (displayed)", stats::summarize(&hook_to_sync)),
    ]));

    if let Some(path) = csv_path {
        let mut csv = String::from(stats::CSV_HEADER);
        csv.push('\n');
        for s in &result.samples {
            csv.push_str(&stats::csv_row(s));
            csv.push('\n');
        }
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(path, csv)?;
        out.push_str(&format!("csv={path}\n"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_are_the_two_extremes() {
        assert_eq!(COLOURS[0], [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(COLOURS[1], [1.0, 1.0, 1.0, 1.0]);
    }

    #[test]
    fn ring_is_a_power_of_two_so_the_modulo_is_uniform() {
        assert!(RING.is_power_of_two());
    }

    #[test]
    fn report_renders_without_a_csv_and_drops_warmup_samples() {
        let result = RunResult {
            freq: 10_000_000,
            monitor: r"\\.\DISPLAY1".to_string(),
            monitor_size: (1920, 1080),
            unresolved_presents: 0,
            clicks_injected: 3,
            samples: vec![
                Sample {
                    seq: 0,
                    warmup: true,
                    hook_qpc: 0,
                    dispatch_qpc: 1_000,
                    present_call_qpc: 2_000,
                    present_return_qpc: 3_000,
                    sync_qpc: 100_000,
                    ..Default::default()
                },
                Sample {
                    seq: 1,
                    warmup: false,
                    hook_qpc: 0,
                    dispatch_qpc: 1_000,
                    present_call_qpc: 2_000,
                    present_return_qpc: 3_000,
                    sync_qpc: 100_000,
                    ..Default::default()
                },
            ],
        };
        let text = report(&result, None).expect("render");
        assert!(text.contains("samples=1"), "{text}");
        assert!(text.contains("warmup dropped=1"), "{text}");
        assert!(text.contains("hook -> vblank (displayed)"), "{text}");
        assert!(!text.contains("csv="), "{text}");
    }

    /// Needs a desktop, a GPU and the live display configuration.
    #[test]
    #[ignore]
    fn monitors_enumerate_with_a_primary() {
        set_dpi_awareness();
        let mons = monitors();
        assert!(!mons.is_empty(), "no monitors enumerated");
        assert!(
            mons.iter().any(|m| m.primary),
            "no monitor reported MONITORINFOF_PRIMARY"
        );
        for m in &mons {
            assert!(m.width() > 0 && m.height() > 0, "{} is empty", m.device);
        }
    }

    /// Needs a GPU. Creates the same device and flip-model swapchain the run
    /// uses, on a small offscreen-styled window, and proves frame statistics
    /// resolve at all on this machine.
    #[test]
    #[ignore]
    fn flip_model_swapchain_reports_frame_statistics() {
        set_dpi_awareness();
        let hwnd = unsafe {
            let instance = GetModuleHandleW(None).unwrap();
            let class = w!("swoop_latency_target_test");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: instance.into(),
                lpszClassName: class,
                ..Default::default()
            };
            RegisterClassW(&wc);
            CreateWindowExW(
                WS_EX_TOPMOST,
                class,
                w!("swoop latency target test"),
                WS_POPUP | WS_VISIBLE,
                0,
                0,
                320,
                240,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .unwrap()
        };
        let (device, context) = create_device().expect("D3D11 device");
        let (swapchain, rtv) = create_swapchain(&device, hwnd, 320, 240).expect("swapchain");
        let mut resolved = false;
        for i in 0..30 {
            unsafe {
                context.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
                context.ClearRenderTargetView(&rtv, &COLOURS[i % 2]);
                swapchain.Present(1, DXGI_PRESENT(0)).ok().unwrap();
            }
            let mut fs = DXGI_FRAME_STATISTICS::default();
            if unsafe { swapchain.GetFrameStatistics(&mut fs) }.is_ok() && fs.SyncQPCTime != 0 {
                resolved = true;
                break;
            }
        }
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(hwnd);
        }
        assert!(
            resolved,
            "GetFrameStatistics never produced a SyncQPCTime in 30 presents"
        );
    }
}
