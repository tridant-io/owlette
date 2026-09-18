//! Desktop capture: DXGI Desktop Duplication, one duplication per output.
//!
//! Every number below is a measurement from spike 0.8 (Windows 11 23H2
//! 22631.6199, RTX 2080 Ti driver 591.86, two attached outputs), not a figure
//! from documentation. The one that shapes the whole module: Desktop
//! Duplication is vsync-locked, delivering 60.0-60.4 frames/s with a p50
//! interval of 16.65 ms whatever timeout it is given, so the pacing is a single
//! blocking `AcquireNextFrame` per output on its own thread and nothing else —
//! no frame timer of ours, and never a sleep between calls.
//!
//! Hardware tests are `#[ignore]`d. With the working directory `agent/swoop`:
//!
//! ```text
//! cargo test -- --ignored capture
//! ```
//!
//! Expected on a two-monitor dev box: `frame_from_every_attached_output`
//! captures a frame from each attached monitor and prints its texture size —
//! on the 0.8 box 1920x1080 for the landscape panel and 3840x2160 for the
//! rotate270 4K one, which is the texture size, not the 2160x3840 its mode
//! reports.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::gpu::Frame;

pub mod testpattern;

/// Blocking `AcquireNextFrame` timeout in milliseconds.
///
/// The compositor paces us, so the timeout only decides how much CPU the caller
/// burns: 0 ms spun 2.7M calls in 15 s (99.94% timeouts) for five duplicate
/// frames, 16 ms blocks a whole frame period and jitters (interval sd 2.65 ms).
/// 8 ms is the measured knee — 61.3% of calls return `WAIT_TIMEOUT` cheaply and
/// the interval distribution is the tightest of the blocking options (sd
/// 1.35 ms).
pub const ACQUIRE_TIMEOUT_MS: u32 = 8;

/// How long a freshly opened or rebuilt duplication waits for a frame carrying
/// a real desktop image before it emits whatever the next frame carries and
/// asks for an IDR.
///
/// The first frame after a rebuild carried `LastPresentTime == 0` in 4 of 6
/// measured ACCESS_LOST events (p50 22 ms) while the first frame with an actual
/// image came at p50 107 ms — so "a frame arrived" is not "the picture is
/// back". On a static desktop an image may not arrive for seconds (a genuinely
/// idle output produced 0.28 frames/s), and the session cannot hold a black
/// screen that long.
const RECOVERY_GRACE: Duration = Duration::from_millis(250);

/// `DuplicateOutput` returned E_ACCESSDENIED in 3 of 12 measured mode-change
/// events and succeeded on the next attempt 50 ms later.
const REDUPLICATE_RETRY: Duration = Duration::from_millis(50);

/// Bounded, so a duplication that never comes back is exit 12 rather than a
/// session that hangs. Measured detect → first picture was p50 210 ms, max
/// 330 ms, so this is ~30x the worst case.
const REDUPLICATE_DEADLINE: Duration = Duration::from_secs(10);

/// A source of desktop frames.
///
/// `next_frame` is allowed to return `Ok(None)`: Desktop Duplication reports a
/// timeout when nothing on screen changed, and a static desktop is the normal
/// case, not an error. The session keeps a floor frame rate on top of this
/// (plan.md D5 — hardware decoders stall without one).
///
/// A returned `Frame` borrows the source's surface: its `handle` is valid until
/// the next `next_frame` call on the same source.
pub trait Source: Send {
    fn next_frame(&mut self, timeout_ms: u32) -> anyhow::Result<Option<Frame>>;

    /// Width and height of the captured surface, which changes when the user
    /// changes resolution. A change is always a new IDR plus a decoder
    /// reconfigure on the browser side.
    fn size(&self) -> (u32, u32);
}

/// A rectangle in whatever space its owner documents.
///
/// Desktop Duplication hands out three spaces that are easy to confuse and were
/// measured to be different on the 0.8 box: the texture, output-local
/// un-rotated coordinates (dirty rects and pointer positions), and the virtual
/// desktop (`DesktopCoordinates`). They are not interchangeable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        (self.right - self.left).max(0)
    }

    pub fn height(&self) -> i32 {
        (self.bottom - self.top).max(0)
    }

    pub fn is_empty(&self) -> bool {
        self.width() == 0 || self.height() == 0
    }
}

/// Bounding box of every attached output's desktop rect.
///
/// Both axes can be negative — on the 0.8 box the origin is (-2160, -1138) —
/// so nothing downstream may assume the virtual desktop starts at zero.
pub fn virtual_bounds(outputs: &[OutputInfo]) -> Option<Rect> {
    outputs
        .iter()
        .map(|o| o.desktop_rect)
        .reduce(|a, b| Rect {
            left: a.left.min(b.left),
            top: a.top.min(b.top),
            right: a.right.max(b.right),
            bottom: a.bottom.max(b.bottom),
        })
}

/// Output rotation, un-applied, exactly as Desktop Duplication reports it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Rotation {
    #[default]
    Identity,
    Rotate90,
    Rotate180,
    Rotate270,
}

impl Rotation {
    /// From `DXGI_MODE_ROTATION`, which is 1-based. 0 is `UNSPECIFIED`, meaning
    /// the rotation could not be determined; identity is the only safe reading.
    pub fn from_dxgi(value: u32) -> Self {
        match value {
            2 => Rotation::Rotate90,
            3 => Rotation::Rotate180,
            4 => Rotation::Rotate270,
            _ => Rotation::Identity,
        }
    }

    /// True when the desktop rect is the texture transposed.
    pub fn transposes(self) -> bool {
        matches!(self, Rotation::Rotate90 | Rotation::Rotate270)
    }

    /// Swap width and height for a rotated output.
    ///
    /// `DXGI_OUTDUPL_DESC.ModeDesc` is in rotated desktop orientation while the
    /// texture is not: the 0.8 box's rotate270 output reports a 2160x3840 mode
    /// and hands back a 3840x2160 texture, so sizing an encoder from the mode
    /// produces a transposed surface. The swap is its own inverse, so this maps
    /// either direction.
    pub fn swap_axes(self, size: (u32, u32)) -> (u32, u32) {
        if self.transposes() {
            (size.1, size.0)
        } else {
            size
        }
    }
}

/// One attached output, as Desktop Duplication reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputInfo {
    /// `\\.\DISPLAY1`. The stable key across a rebuild: adapter and output
    /// indices are re-enumerated after a mode change and can move.
    pub device_name: String,
    /// Virtual-desktop coordinates, negative in either axis.
    pub desktop_rect: Rect,
    /// Un-applied. Applying it is the streamer's job (plan.md Task 6.4), not
    /// this module's.
    pub rotation: Rotation,
}

/// A region the compositor moved rather than repainted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoveRect {
    pub source: (i32, i32),
    pub dest: Rect,
}

/// Per-frame metadata, in output-local un-rotated coordinates.
///
/// Move rects are read because the API requires the order, not because they
/// pay: 0.8 measured zero of them in 5,981 frames across seven scenes,
/// including dragged windows, `ScrollWindowEx` blits and a browser scroll.
/// Nothing may be optimised on their presence. Dirty rects are the opposite —
/// 0.01% of an idle output against 92% of a scrolling browser — and the whole
/// metadata read costs 16 bytes at p50.
#[derive(Debug, Default, Clone)]
pub struct FrameRects {
    pub moves: Vec<MoveRect>,
    pub dirty: Vec<Rect>,
}

/// `DXGI_OUTDUPL_MOVE_RECT` is a `POINT` then a `RECT`: six i32, no padding.
const MOVE_RECT_WORDS: usize = 6;
/// `RECT`: four i32.
const DIRTY_RECT_WORDS: usize = 4;

/// Desktop Duplication writes both lists into the single
/// `TotalMetadataBufferSize` buffer: the move rects at the front, the dirty
/// rects immediately after however many bytes the move-rect read reported.
/// Handing the dirty-rect parser the front of the buffer parses move rects as
/// RECTs and yields plausible garbage rather than an error, which is why the
/// API makes the order a requirement.
fn split_metadata(words: &[i32], move_words: usize) -> (&[i32], &[i32]) {
    words.split_at(move_words.min(words.len()))
}

fn parse_move_rects(words: &[i32]) -> Vec<MoveRect> {
    let (rects, _) = words.as_chunks::<MOVE_RECT_WORDS>();
    rects
        .iter()
        .map(|w| MoveRect {
            source: (w[0], w[1]),
            dest: Rect {
                left: w[2],
                top: w[3],
                right: w[4],
                bottom: w[5],
            },
        })
        .collect()
}

fn parse_dirty_rects(words: &[i32]) -> Vec<Rect> {
    let (rects, _) = words.as_chunks::<DIRTY_RECT_WORDS>();
    rects
        .iter()
        .map(|w| Rect {
            left: w[0],
            top: w[1],
            right: w[2],
            bottom: w[3],
        })
        .collect()
}

/// HRESULTs `DuplicateOutput` returns transiently while the desktop is changing
/// under it. Retry these on a 50 ms cadence until the deadline.
///
/// E_INVALIDARG (0x80070057) is deliberately absent: it is what every
/// cross-adapter pair returned in 4 of 4 measured attempts, i.e. the device is
/// on the wrong adapter and needs a new device on the output's own adapter, not
/// another attempt. Retrying it burns the whole deadline and then fails anyway.
fn is_retryable_duplicate_error(hresult: u32) -> bool {
    matches!(
        hresult,
        // E_ACCESSDENIED — 3 of 12 measured mode-change events, transient.
        0x8007_0005
        // DXGI_ERROR_NOT_CURRENTLY_AVAILABLE
        | 0x887A_0022
        // DXGI_ERROR_SESSION_DISCONNECTED
        | 0x887A_0028
        // DXGI_ERROR_NOT_FOUND — the output is missing mid mode change.
        | 0x887A_0002
    )
}

/// Shared "every duplication in this process is stale" counter.
///
/// A mode change on one output killed the duplication on *both* outputs in 6 of
/// 6 measured events, and the output that was not touched reported it first, so
/// a loss anywhere rebuilds everywhere. A desktop switch does the same thing for
/// the same reason.
#[derive(Clone, Default)]
pub struct RebuildSignal(Arc<AtomicU64>);

impl RebuildSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bump(&self) {
        self.0.fetch_add(1, Ordering::Release);
    }

    pub fn generation(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }
}

#[cfg(windows)]
use windows::{
    core::{Error as WinError, Interface},
    Win32::{
        Foundation::{E_FAIL, HANDLE, HMODULE, RECT},
        Graphics::{
            Direct3D::{
                D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0,
                D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
            },
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
                D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
                D3D11_USAGE_DEFAULT,
            },
            Dxgi::{
                Common::{DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM},
                CreateDXGIFactory1, IDXGIAdapter1, IDXGIDevice1, IDXGIFactory1, IDXGIOutput,
                IDXGIOutput1, IDXGIOutput5, IDXGIOutputDuplication, IDXGIResource,
                DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_FOUND,
                DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_MOVE_RECT,
                DXGI_OUTPUT_DESC,
            },
        },
        System::{
            Performance::QueryPerformanceCounter,
            StationsAndDesktops::{
                CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, SetThreadDesktop,
                DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
                DESKTOP_WRITEOBJECTS, HDESK, UOI_NAME,
            },
        },
        UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
    },
};

// The metadata buffer is i32-wide so the two API calls write through a pointer
// with the alignment their structs need, and so the parsers above can be pure.
// Both structs are arrays of i32 with no padding; these assertions are what
// makes that reinterpretation sound.
#[cfg(windows)]
const _: () = {
    assert!(std::mem::size_of::<DXGI_OUTDUPL_MOVE_RECT>() == MOVE_RECT_WORDS * 4);
    assert!(std::mem::align_of::<DXGI_OUTDUPL_MOVE_RECT>() == 4);
    assert!(std::mem::size_of::<RECT>() == DIRTY_RECT_WORDS * 4);
    assert!(std::mem::align_of::<RECT>() == 4);
};

/// Per-monitor-v2, before the first DXGI call.
///
/// Without it every geometry number in this module is silently scaled: a
/// DPI-unaware caller reads the 0.8 box's 125% output as 1728x3072 where it is
/// 2160x3840, and `DuplicateOutput1` refuses a DPI-unaware process outright.
/// Idempotent, and it fails harmlessly if the process already declared its
/// awareness in a manifest.
#[cfg(windows)]
pub(crate) fn set_dpi_awareness() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    });
}

#[cfg(windows)]
fn wide_to_string(chars: &[u16]) -> String {
    let len = chars.iter().position(|c| *c == 0).unwrap_or(chars.len());
    String::from_utf16_lossy(&chars[..len])
}

/// Software adapters (WARP) duplicate nothing — E_INVALIDARG against every
/// output — so they are skipped wherever outputs are walked.
#[cfg(windows)]
fn is_software(adapter: &IDXGIAdapter1) -> windows::core::Result<bool> {
    let desc = unsafe { adapter.GetDesc1() }?;
    Ok(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0)
}

#[cfg(windows)]
fn output_info(desc: &DXGI_OUTPUT_DESC) -> OutputInfo {
    OutputInfo {
        device_name: wide_to_string(&desc.DeviceName),
        desktop_rect: Rect {
            left: desc.DesktopCoordinates.left,
            top: desc.DesktopCoordinates.top,
            right: desc.DesktopCoordinates.right,
            bottom: desc.DesktopCoordinates.bottom,
        },
        rotation: Rotation::from_dxgi(desc.Rotation.0 as u32),
    }
}

#[cfg(windows)]
fn qpc_now() -> i64 {
    let mut now = 0i64;
    unsafe {
        let _ = QueryPerformanceCounter(&mut now);
    }
    now
}

/// Every output attached to the desktop, on every adapter that can duplicate
/// one.
///
/// Adapters are never selected, only walked: the Parsec Virtual Display Adapter
/// on the 0.8 box is byte-identical to the real GPU in description, vendor id,
/// subsystem id and VRAM — only its LUID differs — so any adapter-first rule
/// picks the wrong one. Adapters with no outputs drop out of this walk on their
/// own.
#[cfg(windows)]
pub fn enumerate_outputs() -> anyhow::Result<Vec<OutputInfo>> {
    set_dpi_awareness();
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }?;
    let mut outputs = Vec::new();
    let mut a = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(a) } {
        a += 1;
        if is_software(&adapter)? {
            continue;
        }
        let mut o = 0u32;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            o += 1;
            let desc = unsafe { output.GetDesc() }?;
            if desc.AttachedToDesktop.as_bool() {
                outputs.push(output_info(&desc));
            }
        }
    }
    Ok(outputs)
}

#[cfg(windows)]
fn create_device(adapter: &IDXGIAdapter1) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
    let levels: [D3D_FEATURE_LEVEL; 4] = [
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    ];
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
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
            Some(&mut context),
        )?;
    }
    let (Some(device), Some(context)) = (device, context) else {
        return Err(WinError::new(E_FAIL, "D3D11CreateDevice returned no device"));
    };
    // One frame of latency: the encoder must never be handed a frame the
    // compositor has already replaced.
    let dxgi_device: IDXGIDevice1 = device.cast()?;
    unsafe { dxgi_device.SetMaximumFrameLatency(1) }?;
    Ok((device, context))
}

/// `DuplicateOutput1` with an explicit format list, falling back to
/// `DuplicateOutput`.
///
/// The list buys nothing on an SDR desktop today — all eight measured
/// negotiations returned BGRA8 whatever was asked for, including the two lists
/// that did not contain it — but it is the documented path for an HDR one, and
/// the fallback covers a driver with no `IDXGIOutput5`.
#[cfg(windows)]
fn duplicate(
    output: &IDXGIOutput,
    device: &ID3D11Device,
) -> windows::core::Result<IDXGIOutputDuplication> {
    const FORMATS: [DXGI_FORMAT; 1] = [DXGI_FORMAT_B8G8R8A8_UNORM];
    if let Ok(output5) = output.cast::<IDXGIOutput5>() {
        if let Ok(dup) = unsafe { output5.DuplicateOutput1(device, 0, &FORMATS) } {
            return Ok(dup);
        }
    }
    let output1: IDXGIOutput1 = output.cast()?;
    unsafe { output1.DuplicateOutput(device) }
}

/// The D3D11 objects behind one live duplication. All of them are replaced
/// together on a rebuild, so they live in one struct.
#[cfg(windows)]
struct Live {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    dup: IDXGIOutputDuplication,
    /// Our own copy of the last acquired surface. The acquired texture goes
    /// back with `ReleaseFrame` immediately; holding it starves every other
    /// duplication in the session behind Desktop Duplication's global lock.
    copy: Option<ID3D11Texture2D>,
    copy_size: (u32, u32),
}

#[cfg(windows)]
impl Live {
    /// Copy the acquired surface into a texture we own and return its handle.
    fn copy_frame(
        &mut self,
        src: &ID3D11Texture2D,
        desc: &D3D11_TEXTURE2D_DESC,
    ) -> windows::core::Result<usize> {
        if self.copy.is_none() || self.copy_size != (desc.Width, desc.Height) {
            let mut wanted = *desc;
            wanted.MipLevels = 1;
            wanted.ArraySize = 1;
            wanted.Usage = D3D11_USAGE_DEFAULT;
            // The bind flags Desktop Duplication's own surface carries
            // (measured 0x28), so the convert pass and the encoder can both
            // take this texture. Its misc flags do not come along: they mark it
            // shared across devices and there is only ever this one device.
            wanted.BindFlags = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;
            wanted.CPUAccessFlags = 0;
            wanted.MiscFlags = 0;
            let mut texture: Option<ID3D11Texture2D> = None;
            unsafe { self.device.CreateTexture2D(&wanted, None, Some(&mut texture)) }?;
            self.copy = texture;
            self.copy_size = (desc.Width, desc.Height);
        }
        let Some(dst) = self.copy.as_ref() else {
            return Err(WinError::new(E_FAIL, "CreateTexture2D returned no texture"));
        };
        unsafe { self.context.CopyResource(dst, src) };
        Ok(dst.as_raw() as usize)
    }
}

/// Open a device and a duplication for the named output.
///
/// The factory is created fresh every time on purpose: after a mode change the
/// old one is stale, and the output's rect and mode can have changed under us.
#[cfg(windows)]
fn open_live(device_name: &str) -> windows::core::Result<(Live, OutputInfo, (u32, u32))> {
    set_dpi_awareness();
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }?;
    let mut a = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(a) } {
        a += 1;
        if is_software(&adapter)? {
            continue;
        }
        let mut o = 0u32;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            o += 1;
            let desc = unsafe { output.GetDesc() }?;
            if !desc.AttachedToDesktop.as_bool()
                || wide_to_string(&desc.DeviceName) != device_name
            {
                continue;
            }
            // The device goes on this output's own adapter. A device on any
            // other adapter fails `DuplicateOutput` with E_INVALIDARG, which is
            // not retryable, and no adapter property can tell the real GPU from
            // the virtual display adapter beside it.
            let (device, context) = create_device(&adapter)?;
            let dup = duplicate(&output, &device)?;
            let info = output_info(&desc);
            // `ModeDesc` is in rotated desktop orientation; the texture is not.
            // Un-rotating it here is what makes `size()` right before the first
            // frame lands.
            let mode = unsafe { dup.GetDesc() }.ModeDesc;
            let size = info.rotation.swap_axes((mode.Width, mode.Height));
            return Ok((
                Live {
                    device,
                    context,
                    dup,
                    copy: None,
                    copy_size: (0, 0),
                },
                info,
                size,
            ));
        }
    }
    Err(WinError::new(
        DXGI_ERROR_NOT_FOUND,
        format!("no attached output named {device_name}"),
    ))
}

/// Read both metadata lists out of the one `TotalMetadataBufferSize` buffer:
/// all move rects, then all dirty rects, in that order.
#[cfg(windows)]
fn read_rects(
    dup: &IDXGIOutputDuplication,
    needed: u32,
    buffer: &mut Vec<i32>,
    out: &mut FrameRects,
) {
    out.moves.clear();
    out.dirty.clear();
    if needed == 0 {
        return;
    }
    let words = needed.div_ceil(4) as usize;
    if buffer.len() < words {
        buffer.resize(words, 0);
    }

    let mut move_bytes = 0u32;
    if unsafe { dup.GetFrameMoveRects(needed, buffer.as_mut_ptr().cast(), &mut move_bytes) }.is_err()
    {
        move_bytes = 0;
    }
    let move_words = (move_bytes / 4) as usize;

    let mut dirty_bytes = 0u32;
    if unsafe {
        dup.GetFrameDirtyRects(
            needed.saturating_sub(move_bytes),
            buffer.as_mut_ptr().add(move_words).cast(),
            &mut dirty_bytes,
        )
    }
    .is_err()
    {
        dirty_bytes = 0;
    }

    let used = (move_words + (dirty_bytes / 4) as usize).min(buffer.len());
    let (moves, dirty) = split_metadata(&buffer[..used], move_words);
    out.moves = parse_move_rects(moves);
    out.dirty = parse_dirty_rects(dirty);
}

/// What one `AcquireNextFrame` produced, before the caller decides what to do
/// about it.
#[cfg(windows)]
enum Step {
    Frame(Frame),
    Nothing,
    Lost,
}

/// Desktop Duplication over one output.
#[cfg(windows)]
pub struct Duplication {
    output: OutputInfo,
    size: (u32, u32),
    live: Option<Live>,
    signal: RebuildSignal,
    generation: u64,
    rects: FrameRects,
    metadata: Vec<i32>,
    /// Set while a rebuilt duplication has yet to produce a frame with a real
    /// desktop image.
    recovering: Option<Instant>,
    idr_requested: bool,
}

#[cfg(windows)]
impl Duplication {
    /// Duplicate one attached output. `signal` is shared by every duplication
    /// in the process so that a loss on any one of them rebuilds all of them.
    pub fn open(output: &OutputInfo, signal: RebuildSignal) -> anyhow::Result<Self> {
        let mut source = Self {
            output: output.clone(),
            size: (0, 0),
            live: None,
            generation: signal.generation(),
            signal,
            rects: FrameRects::default(),
            metadata: Vec::new(),
            recovering: None,
            idr_requested: false,
        };
        // The first duplication takes the same retry as a rebuild: a session can
        // be asked for while the desktop is still settling, and those failures
        // are the transient ones either way.
        source.rebuild()?;
        Ok(source)
    }

    /// Re-read on every rebuild: a mode change moves the desktop rect and can
    /// change the rotation.
    pub fn output(&self) -> &OutputInfo {
        &self.output
    }

    /// Metadata for the frame `next_frame` last returned.
    pub fn last_rects(&self) -> &FrameRects {
        &self.rects
    }

    /// True once after every rebuild: the next encoded frame must be an IDR,
    /// because the decoder's reference frames belong to a duplication that no
    /// longer exists.
    pub fn take_idr_request(&mut self) -> bool {
        std::mem::take(&mut self.idr_requested)
    }

    /// Mark every duplication in the process stale — a desktop switch does the
    /// same damage to them as an ACCESS_LOST.
    pub fn request_rebuild(&self) {
        self.signal.bump();
    }

    fn rebuild(&mut self) -> anyhow::Result<()> {
        // Drop the stale duplication, its device and its factory before
        // re-enumerating: the output's coordinates and mode can have changed,
        // and the old duplication still holds the output.
        self.live = None;
        let deadline = Instant::now() + REDUPLICATE_DEADLINE;
        loop {
            match open_live(&self.output.device_name) {
                Ok((live, output, size)) => {
                    self.output = output;
                    self.size = size;
                    self.live = Some(live);
                    self.generation = self.signal.generation();
                    self.recovering = Some(Instant::now());
                    self.idr_requested = true;
                    return Ok(());
                }
                Err(e) => {
                    if !is_retryable_duplicate_error(e.code().0 as u32)
                        || Instant::now() >= deadline
                    {
                        return Err(e.into());
                    }
                    std::thread::sleep(REDUPLICATE_RETRY);
                }
            }
        }
    }

    /// [`Source::next_frame`], plus a look at the pointer data every acquired
    /// frame carries.
    ///
    /// The cursor arrives on the same `AcquireNextFrame` as the desktop image,
    /// and most of it arrives on frames this module drops: a pointer-only frame
    /// has `LastPresentTime == 0` and no new picture at all. So `observer` runs
    /// for every frame Desktop Duplication hands back, emitted or not, and it
    /// runs before `ReleaseFrame` because `GetFramePointerShape` is only legal
    /// while the frame is held.
    ///
    /// The duplication is lent for the call rather than handed out: there is
    /// one per output per process, and the calls it is wanted for are invalid
    /// outside this window.
    ///
    /// The call site Wave 5's capture thread wants, with `cursor` owning both
    /// helpers and the tracker:
    ///
    /// ```text
    /// let mut reader = cursor::PointerReader::new();
    /// let frame = source.next_frame_with(ACQUIRE_TIMEOUT_MS, &mut |dup, info| {
    ///     // None when the frame carried no pointer news at all (20.4% of
    ///     // frames); the position on those is stale, not (0,0).
    ///     if let Some(at) = cursor::pointer_position(info) {
    ///         if let Some(msg) = tracker.on_position(at, &geometry, ts_us) {
    ///             send(msg);
    ///         }
    ///     }
    ///     match reader.shape(dup, info) {
    ///         Ok(Some((shape, bytes))) => match tracker.on_shape(&shape, bytes, geometry.dpi) {
    ///             Ok(Some(msg)) => send(msg),
    ///             Ok(None) => {}          // a shape the viewer already has
    ///             Err(e) => log_and_continue(e),
    ///         },
    ///         Ok(None) => {}              // no shape change on this frame
    ///         Err(e) => log_and_continue(e),
    ///     }
    /// })?;
    /// ```
    pub fn next_frame_with(
        &mut self,
        timeout_ms: u32,
        observer: &mut dyn FnMut(&IDXGIOutputDuplication, &DXGI_OUTDUPL_FRAME_INFO),
    ) -> anyhow::Result<Option<Frame>> {
        if self.live.is_none() || self.generation != self.signal.generation() {
            self.rebuild()?;
        }
        match self.step(timeout_ms, observer)? {
            Step::Frame(frame) => Ok(Some(frame)),
            Step::Nothing => Ok(None),
            Step::Lost => {
                self.signal.bump();
                self.rebuild()?;
                Ok(None)
            }
        }
    }

    fn step(
        &mut self,
        timeout_ms: u32,
        observer: &mut dyn FnMut(&IDXGIOutputDuplication, &DXGI_OUTDUPL_FRAME_INFO),
    ) -> anyhow::Result<Step> {
        let Self {
            size,
            live,
            rects,
            metadata,
            recovering,
            ..
        } = self;
        let Some(live) = live.as_mut() else {
            return Ok(Step::Lost);
        };

        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        if let Err(e) = unsafe { live.dup.AcquireNextFrame(timeout_ms, &mut info, &mut resource) } {
            return match e.code() {
                // Nothing on screen changed. The normal case on a static
                // desktop, not an error, and the caller loops without sleeping.
                code if code == DXGI_ERROR_WAIT_TIMEOUT => Ok(Step::Nothing),
                code if code == DXGI_ERROR_ACCESS_LOST => Ok(Step::Lost),
                _ => Err(e.into()),
            };
        }
        // Before anything else and before `ReleaseFrame`: the pointer news on a
        // frame with no desktop image is still pointer news, and the shape can
        // only be read while the frame is held.
        observer(&live.dup, &info);

        let Some(resource) = resource else {
            let _ = unsafe { live.dup.ReleaseFrame() };
            return Ok(Step::Nothing);
        };

        let texture: ID3D11Texture2D = resource.cast()?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };

        // A frame with no present time carries no new desktop image — it is how
        // a cursor-only update arrives, and it is what the first frames after a
        // rebuild look like. Normally it is dropped; during the recovery grace
        // it is emitted anyway, because a static desktop may not produce a real
        // image for seconds and the viewer is looking at a stale picture.
        let stale = info.LastPresentTime == 0;
        let emit = !stale || recovering.is_some_and(|since| since.elapsed() >= RECOVERY_GRACE);

        let copied = if emit {
            read_rects(&live.dup, info.TotalMetadataBufferSize, metadata, rects);
            Some(live.copy_frame(&texture, &desc))
        } else {
            None
        };
        // Back as early as possible: every duplication in the session is
        // serialised behind Desktop Duplication's lock while a frame is held.
        let _ = unsafe { live.dup.ReleaseFrame() };

        match copied {
            None => Ok(Step::Nothing),
            Some(handle) => {
                // After the `?`: a failed copy is not a recovery, and the size
                // it would have reported is the one we could not take.
                let handle = handle?;
                *size = (desc.Width, desc.Height);
                *recovering = None;
                Ok(Step::Frame(Frame {
                    handle,
                    width: desc.Width,
                    height: desc.Height,
                    captured_qpc: if stale { qpc_now() } else { info.LastPresentTime },
                }))
            }
        }
    }
}

#[cfg(windows)]
impl Source for Duplication {
    /// Picture only. A session that draws a cursor calls
    /// [`Duplication::next_frame_with`] instead — the pointer data is on the
    /// same acquire and cannot be read afterwards.
    fn next_frame(&mut self, timeout_ms: u32) -> anyhow::Result<Option<Frame>> {
        self.next_frame_with(timeout_ms, &mut |_, _| {})
    }

    /// The acquired texture's size, never the mode's: they differ on a rotated
    /// output.
    fn size(&self) -> (u32, u32) {
        self.size
    }
}

/// Follows the input desktop for one thread.
///
/// Deliberately not `Send`: a desktop association belongs to the thread that
/// made it, so the watcher is created on the capture thread and stays there.
#[cfg(windows)]
pub struct DesktopWatcher {
    desktop: Option<HDESK>,
    name: String,
}

#[cfg(windows)]
impl DesktopWatcher {
    pub fn new() -> Self {
        Self {
            desktop: None,
            name: String::new(),
        }
    }

    /// Attach this thread to the input desktop, returning true when it changed
    /// and the caller's duplications therefore have to be rebuilt.
    ///
    /// A failed `OpenInputDesktop` is not proof that the machine is locked: it
    /// is equally what a thread without the rights to the current desktop gets,
    /// and what a switch in progress returns. The previous desktop is kept and
    /// capture carries on.
    pub fn follow(&mut self) -> bool {
        let opened = unsafe {
            OpenInputDesktop(
                DESKTOP_CONTROL_FLAGS(0),
                false,
                DESKTOP_ACCESS_FLAGS(DESKTOP_READOBJECTS.0 | DESKTOP_WRITEOBJECTS.0),
            )
        };
        let Ok(desktop) = opened else {
            return false;
        };
        let name = desktop_name(desktop).unwrap_or_default();
        if self.desktop.is_some() && name == self.name {
            let _ = unsafe { CloseDesktop(desktop) };
            return false;
        }
        if unsafe { SetThreadDesktop(desktop) }.is_err() {
            let _ = unsafe { CloseDesktop(desktop) };
            return false;
        }
        if let Some(previous) = self.desktop.replace(desktop) {
            let _ = unsafe { CloseDesktop(previous) };
        }
        self.name = name;
        true
    }

    /// The input desktop this thread is attached to (`Default`, `Winlogon`,
    /// `Screen-saver`), empty until the first successful `follow`.
    pub fn name(&self) -> &str {
        &self.name
    }
}

#[cfg(windows)]
impl Default for DesktopWatcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
impl Drop for DesktopWatcher {
    fn drop(&mut self) {
        if let Some(desktop) = self.desktop.take() {
            // Fails while this thread is still attached; there is nothing to do
            // about it and the handle dies with the thread either way.
            let _ = unsafe { CloseDesktop(desktop) };
        }
    }
}

#[cfg(windows)]
fn desktop_name(desktop: HDESK) -> Option<String> {
    let mut buffer = [0u16; 128];
    let mut needed = 0u32;
    unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(buffer.as_mut_ptr().cast()),
            std::mem::size_of_val(&buffer) as u32,
            Some(&mut needed),
        )
    }
    .ok()?;
    Some(wide_to_string(&buffer))
}

/// The capture thread body: follow the input desktop, then block in
/// `AcquireNextFrame`.
///
/// There is no timer and no sleep — the compositor paces this loop, and the
/// session's floor frame rate is a separate periodic IDR, not an attempt to
/// pull frames faster. Both callbacks run on this thread; the frame's handle is
/// valid only for the length of `on_frame`, and `on_pointer` sees every
/// acquired frame, including the ones that carry no picture (see
/// [`Duplication::next_frame_with`]).
#[cfg(windows)]
pub fn capture_loop(
    source: &mut Duplication,
    watcher: &mut DesktopWatcher,
    stop: &std::sync::atomic::AtomicBool,
    mut on_frame: impl FnMut(&Frame),
    mut on_pointer: impl FnMut(&IDXGIOutputDuplication, &DXGI_OUTDUPL_FRAME_INFO),
) -> anyhow::Result<()> {
    while !stop.load(Ordering::Relaxed) {
        if watcher.follow() {
            source.request_rebuild();
        }
        if let Some(frame) = source.next_frame_with(ACQUIRE_TIMEOUT_MS, &mut on_pointer)? {
            on_frame(&frame);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two outputs spike 0.8 measured, including the rotated 4K one whose
    /// desktop rect is negative in both axes.
    fn measured_outputs() -> Vec<OutputInfo> {
        vec![
            OutputInfo {
                device_name: r"\\.\DISPLAY1".to_string(),
                desktop_rect: Rect {
                    left: 0,
                    top: 0,
                    right: 1920,
                    bottom: 1080,
                },
                rotation: Rotation::Identity,
            },
            OutputInfo {
                device_name: r"\\.\DISPLAY2".to_string(),
                desktop_rect: Rect {
                    left: -2160,
                    top: -1138,
                    right: 0,
                    bottom: 2702,
                },
                rotation: Rotation::Rotate270,
            },
        ]
    }

    #[test]
    fn virtual_bounds_span_a_negative_origin() {
        let bounds = virtual_bounds(&measured_outputs()).expect("two attached outputs");
        assert_eq!(
            bounds,
            Rect {
                left: -2160,
                top: -1138,
                right: 1920,
                bottom: 2702
            }
        );
        assert_eq!((bounds.width(), bounds.height()), (4080, 3840));
    }

    #[test]
    fn virtual_bounds_of_no_outputs_is_none() {
        assert!(virtual_bounds(&[]).is_none());
    }

    #[test]
    fn rotation_maps_every_dxgi_value() {
        // UNSPECIFIED and anything unrecognised read as identity.
        assert_eq!(Rotation::from_dxgi(0), Rotation::Identity);
        assert_eq!(Rotation::from_dxgi(1), Rotation::Identity);
        assert_eq!(Rotation::from_dxgi(2), Rotation::Rotate90);
        assert_eq!(Rotation::from_dxgi(3), Rotation::Rotate180);
        assert_eq!(Rotation::from_dxgi(4), Rotation::Rotate270);
        assert_eq!(Rotation::from_dxgi(99), Rotation::Identity);
        assert!(Rotation::Rotate90.transposes());
        assert!(Rotation::Rotate270.transposes());
        assert!(!Rotation::Identity.transposes());
        assert!(!Rotation::Rotate180.transposes());
    }

    #[test]
    fn a_rotated_mode_is_the_transpose_of_its_texture() {
        // 0.8 §3: the rotate270 output reports a 2160x3840 mode and hands back
        // a 3840x2160 texture. The swap is its own inverse.
        assert_eq!(Rotation::Rotate270.swap_axes((2160, 3840)), (3840, 2160));
        assert_eq!(Rotation::Rotate270.swap_axes((3840, 2160)), (2160, 3840));
        assert_eq!(Rotation::Identity.swap_axes((1920, 1080)), (1920, 1080));
        assert_eq!(Rotation::Rotate180.swap_axes((1920, 1080)), (1920, 1080));
    }

    #[test]
    fn move_rects_are_read_before_dirty_rects_out_of_one_buffer() {
        // One move rect (source point then destination rect) followed by two
        // dirty rects, laid out as Desktop Duplication writes them.
        let buffer: Vec<i32> = vec![10, 20, 0, 0, 100, 50, 1, 2, 3, 4, 5, 6, 7, 8];
        let (moves, dirty) = split_metadata(&buffer, MOVE_RECT_WORDS);

        assert_eq!(
            parse_move_rects(moves),
            vec![MoveRect {
                source: (10, 20),
                dest: Rect {
                    left: 0,
                    top: 0,
                    right: 100,
                    bottom: 50
                },
            }]
        );
        assert_eq!(
            parse_dirty_rects(dirty),
            vec![
                Rect {
                    left: 1,
                    top: 2,
                    right: 3,
                    bottom: 4
                },
                Rect {
                    left: 5,
                    top: 6,
                    right: 7,
                    bottom: 8
                },
            ]
        );

        // Reading the dirty rects from the front of the same buffer parses the
        // move rect as RECTs: plausible rectangles, silently wrong, never an
        // error. That is the whole reason the order is a contract.
        assert_ne!(parse_dirty_rects(&buffer)[0], parse_dirty_rects(dirty)[0]);
    }

    #[test]
    fn a_truncated_trailing_rect_is_ignored() {
        // The split is driven by byte counts the API reports, so a parser that
        // ran off the end would read another frame's metadata.
        assert!(parse_move_rects(&[1, 2, 3]).is_empty());
        assert_eq!(parse_dirty_rects(&[1, 2, 3, 4, 5]).len(), 1);
        let (moves, dirty) = split_metadata(&[1, 2, 3, 4], 99);
        assert_eq!(moves.len(), 4);
        assert!(dirty.is_empty());
    }

    #[test]
    fn a_wrong_adapter_is_never_retried() {
        // E_INVALIDARG is the cross-adapter answer, measured in 4 of 4 pairs:
        // retrying it burns the deadline and fails anyway.
        assert!(!is_retryable_duplicate_error(0x8007_0057));
        assert!(is_retryable_duplicate_error(0x8007_0005));
        assert!(is_retryable_duplicate_error(0x887A_0022));
        assert!(is_retryable_duplicate_error(0x887A_0028));
        assert!(is_retryable_duplicate_error(0x887A_0002));
    }

    #[test]
    fn a_rebuild_signal_makes_every_source_stale() {
        let signal = RebuildSignal::new();
        let mine = signal.generation();
        let other = signal.clone();
        other.bump();
        assert_ne!(mine, signal.generation());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs a GPU and an attached display; cargo test -- --ignored capture"]
    fn enumeration_finds_the_attached_outputs() {
        let outputs = enumerate_outputs().expect("enumerate");
        assert!(!outputs.is_empty(), "no attached outputs");
        for output in &outputs {
            assert!(!output.desktop_rect.is_empty());
            println!(
                "{} {:?} rotation={:?}",
                output.device_name, output.desktop_rect, output.rotation
            );
        }
        println!("virtual desktop {:?}", virtual_bounds(&outputs));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs a GPU and an attached display; cargo test -- --ignored capture"]
    fn frame_from_every_attached_output() {
        let outputs = enumerate_outputs().expect("enumerate");
        assert!(!outputs.is_empty(), "no attached outputs");
        let signal = RebuildSignal::new();
        for info in &outputs {
            let mut source = Duplication::open(info, signal.clone())
                .unwrap_or_else(|e| panic!("duplicate {}: {e:#}", info.device_name));
            assert!(source.take_idr_request(), "a fresh duplication needs an IDR");
            // Generous: a genuinely idle output produced 0.28 frames/s with a
            // p50 gap of 4,983 ms.
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut captured = None;
            // The pointer observer must see every acquired frame, which is what
            // makes the cursor reachable at all: its data cannot be read after
            // `ReleaseFrame`.
            let (mut observed, mut pointer_news) = (0usize, 0usize);
            while Instant::now() < deadline {
                let frame = source
                    .next_frame_with(ACQUIRE_TIMEOUT_MS, &mut |_dup, info| {
                        observed += 1;
                        if info.LastMouseUpdateTime != 0 {
                            pointer_news += 1;
                        }
                    })
                    .expect("acquire");
                if let Some(frame) = frame {
                    captured = Some((frame.width, frame.height));
                    break;
                }
            }
            let Some((width, height)) = captured else {
                panic!("no frame from {} within 10 s", info.device_name);
            };
            // The texture, never the transposed mode.
            assert_eq!(source.size(), (width, height));
            assert_eq!(
                info.rotation.swap_axes((width, height)),
                (
                    info.desktop_rect.width() as u32,
                    info.desktop_rect.height() as u32
                ),
                "un-rotated texture does not match the desktop rect"
            );
            assert!(observed >= 1, "the pointer observer never ran");
            println!(
                "{} texture {width}x{height} rotation={:?} dirty_rects={} observed={observed} pointer_news={pointer_news}",
                info.device_name,
                info.rotation,
                source.last_rects().dirty.len()
            );
        }
    }
}
