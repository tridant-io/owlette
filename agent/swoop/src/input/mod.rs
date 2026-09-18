//! Input injection into the **interactive** desktop, through `SendInput`.
//!
//! Three coordinate spaces meet here and they are not interchangeable, which is
//! the whole reason this module has as much arithmetic as it does:
//!
//! 1. **viewer space** — what `PROTOCOL.md` §5's `m` message carries: `0..1`
//!    normalised over the selected display's captured texture. Normalised so a
//!    resolution or scale change mid-session does not move the cursor.
//! 2. **virtual-desktop pixels** — where the selected output actually sits.
//!    Both axes go negative: spike 0.8 measured this box's origin at
//!    (-2160, -1138) on every run, so nothing here may assume zero. The
//!    captured texture is also *un-rotated* while the desktop rect is rotated —
//!    a rotate270 output hands back a 3840x2160 texture for a 2160x3840 rect —
//!    so [`PointerSpace`] applies the rotation the texture never had.
//! 3. **`SendInput`'s absolute space** — its own `0..65535` normalisation of
//!    the virtual desktop, which is neither of the above. Getting this wrong
//!    still looks perfect on a single 1080p monitor and puts the cursor on the
//!    wrong screen on anything else, so [`absolute_from_desktop`] is pinned by
//!    unit tests against the measured two-monitor layout rather than by eye.
//!
//! Per-monitor-v2 DPI awareness is a precondition of all of it: a DPI-unaware
//! process reads `SM_CXVIRTUALSCREEN` scaled, and the 96/120 DPI mix on this
//! box means the injection coordinate would disagree with the capture
//! coordinate on exactly one of the two monitors. [`crate::capture`] already
//! declares it through a `Once`; this module calls the same function so an
//! injector built before capture starts still gets it.
//!
//! **Not here, deliberately:** crossing to the secure desktop (`Winlogon`,
//! the lock screen, a UAC consent window) and `SendSAS`. Spike 0.3 was never
//! run, so nothing about injection across that boundary is established, and
//! Task 6.1 owns it. [`crate::capture::DesktopWatcher`] is what an input thread
//! would use to follow a desktop switch; all this module promises is that a
//! switch releases everything the viewer was holding (see
//! [`ViewerInput::release_all`]).
//!
//! Hardware tests are `#[ignore]`d. **They move the real mouse pointer on this
//! machine and press a real key** — the cursor will jump while they run. With
//! the working directory `agent/swoop`:
//!
//! ```text
//! cargo test -- --ignored input
//! ```
//!
//! Run it from an ordinary shell. Under a sandboxed one the keyboard half is
//! swallowed with no error at all — `SendInput` still returns the full count
//! and the *mouse* half still works, so the test fails only on the key state —
//! which is the same shape as the UIPI block described on `send` below.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use std::time::Instant;

use serde::Deserialize;

use crate::capture::{OutputInfo, Rect, Rotation};
use crate::signal::messages::channel::{Input, WheelMode};

/// One wheel notch, as `mouseData` counts it.
const WHEEL_DELTA: f64 = 120.0;

/// Chrome on Windows reports `deltaY` 100 for one notch at `deltaMode: 0`
/// (the same event's legacy `wheelDelta` is 120), so this is the conversion
/// back, not a guess at pixel density.
const PIXELS_PER_NOTCH: f64 = 100.0;

/// The Windows default behind `SPI_GETWHEELSCROLLLINES`. Read from the host on
/// purpose rather than from the viewer: it is the host's apps that scroll.
const LINES_PER_NOTCH: f64 = 3.0;

/// `deltaMode: 2` is rare (Firefox, with a non-default preference) and no API
/// tells us how tall a page is in someone else's window. A convention, named
/// so it is obvious what to change if page scrolling ever feels wrong.
const LINES_PER_PAGE: f64 = 24.0;

/// Flood ceiling per viewer, in events per second, with [`EVENT_BURST`] of
/// slack. A 1000 Hz mouse plus key repeat sits near 1.1k/s *before* a frame's
/// moves are coalesced, so this never touches a real user; it exists so a
/// scripted viewer cannot spend the host's CPU inside `SendInput`.
const EVENT_RATE_PER_SEC: f64 = 1500.0;
const EVENT_BURST: f64 = 300.0;

/// What the browser sends, mapped to this platform's scancodes and button
/// numbering by [`keymap`]. The host still enforces `ctl` from the verified
/// viewer JWT before anything reaches an injector (Task 5.1).
///
/// The mapping is done **here**, not in the browser: `PROTOCOL.md` §5 makes
/// `testdata/keymap.json` the one oracle both ends read, and the viewer only
/// ever sends a `KeyboardEvent.code`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InputEvent {
    /// Absolute pointer position, normalised 0.0–1.0 over the captured surface,
    /// so a resolution change mid-session does not move the cursor.
    MouseMove { x: f32, y: f32 },
    /// Pointer-lock deltas, relayed raw. Not normalised and not clamped: these
    /// are the mouse's own counts, which is what a game or a CAD app wants.
    MouseMoveRelative { dx: i32, dy: i32 },
    MouseButton { button: u8, down: bool },
    /// Signed `WHEEL_DELTA` units — 120 is one notch, positive is away from the
    /// user (up) and to the right, which is the *opposite* sign to the
    /// browser's `deltaY`.
    MouseWheel { delta_x: i32, delta_y: i32 },
    /// Hardware scancode plus the extended-key flag, not a virtual key: a
    /// scancode survives a mismatched keyboard layout between client and host.
    Key { scancode: u16, extended: bool, down: bool },
    /// The one key that cannot be a scancode: `Pause` is an `e1`-prefixed
    /// sequence the `SendInput` scancode path cannot express, so keymap.json
    /// names `VK_PAUSE` for it instead.
    KeyVirtual { vk: u16, down: bool },
}

/// Injects input into the desktop this thread is attached to.
///
/// A desktop association belongs to a thread, so an injector is created on the
/// input thread and stays there.
pub trait Injector: Send {
    fn inject(&mut self, event: &InputEvent) -> anyhow::Result<()>;

    /// A frame's worth of events, coalesced, in as few syscalls as the backend
    /// can manage. Prefer this over `inject` in a loop: the Win32 backend turns
    /// the whole batch into one `SendInput` call.
    fn inject_all(&mut self, events: &[InputEvent]) -> anyhow::Result<()> {
        for event in coalesce(events) {
            self.inject(&event)?;
        }
        Ok(())
    }
}

/// Collapse a batch the way a mouse does: only the last position of a run of
/// moves can still be seen, and a run of pointer-lock deltas is their sum.
///
/// Runs only — a move on either side of a click keeps its order, because
/// press-at-a-position is the entire meaning of a click.
pub fn coalesce(events: &[InputEvent]) -> Vec<InputEvent> {
    let mut out: Vec<InputEvent> = Vec::with_capacity(events.len());
    for event in events {
        match (out.last_mut(), event) {
            (Some(InputEvent::MouseMove { x, y }), InputEvent::MouseMove { x: nx, y: ny }) => {
                *x = *nx;
                *y = *ny;
            }
            (
                Some(InputEvent::MouseMoveRelative { dx, dy }),
                InputEvent::MouseMoveRelative { dx: ndx, dy: ndy },
            ) => {
                *dx = dx.saturating_add(*ndx);
                *dy = dy.saturating_add(*ndy);
            }
            _ => out.push(*event),
        }
    }
    out
}

// ---------------------------------------------------------------- coordinates

/// The display a viewer's normalised coordinates belong to.
///
/// `rotation` is the rotation **as capture reports it, un-applied**: viewer
/// coordinates are in texture space, and the texture is the un-rotated
/// framebuffer. If a later convert/scale path rotates the frame before it is
/// encoded, then the viewer is already clicking in desktop-local space and this
/// must be built with [`Rotation::Identity`] instead — the session owns that
/// choice, which is why this is a parameter and not read from the output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PointerSpace {
    pub rect: Rect,
    pub rotation: Rotation,
}

impl PointerSpace {
    pub fn from_output(output: &OutputInfo) -> Self {
        Self {
            rect: output.desktop_rect,
            rotation: output.rotation,
        }
    }

    /// Viewer space → virtual-desktop pixels.
    pub fn to_desktop(&self, x: f32, y: f32) -> (i32, i32) {
        let (u, v) = un_rotate(
            f64::from(x).clamp(0.0, 1.0),
            f64::from(y).clamp(0.0, 1.0),
            self.rotation,
        );
        let width = self.rect.width().max(1);
        let height = self.rect.height().max(1);
        let px = self.rect.left + (u * f64::from(width - 1)).round() as i32;
        let py = self.rect.top + (v * f64::from(height - 1)).round() as i32;
        (
            px.clamp(self.rect.left, self.rect.right - 1),
            py.clamp(self.rect.top, self.rect.bottom - 1),
        )
    }
}

/// Apply an output's rotation to a normalised texture point, which is what
/// turns un-rotated texture space into the desktop-local space the user sees.
///
/// The displayed image is the texture rotated clockwise by `rotation`, so a
/// clockwise 90 sends `(u, v)` to `(1-v, u)` and the other two follow from
/// applying that again.
fn un_rotate(u: f64, v: f64, rotation: Rotation) -> (f64, f64) {
    match rotation {
        Rotation::Identity => (u, v),
        Rotation::Rotate90 => (1.0 - v, u),
        Rotation::Rotate180 => (1.0 - u, 1.0 - v),
        Rotation::Rotate270 => (v, 1.0 - u),
    }
}

/// Virtual-desktop pixels → `SendInput`'s absolute `0..65535`, for
/// `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`.
///
/// `bounds` is the whole virtual desktop — `SM_XVIRTUALSCREEN` and friends,
/// never the primary monitor. The divisor is `size - 1` so that the last pixel
/// is reachable as exactly 65535: with `size` the bottom-right pixel of the
/// desktop is unreachable, which is how an edge-of-screen click ends up one
/// pixel short and a corner hot-spot never fires.
pub fn absolute_from_desktop(point: (i32, i32), bounds: Rect) -> (i32, i32) {
    let scale = |value: i32, lo: i32, size: i32| -> i32 {
        if size <= 1 {
            return 0;
        }
        let span = f64::from(size - 1);
        ((f64::from(value - lo) * 65535.0 / span).round() as i32).clamp(0, 65535)
    };
    (
        scale(point.0, bounds.left, bounds.width()),
        scale(point.1, bounds.top, bounds.height()),
    )
}

// -------------------------------------------------------------------- keymap

/// `testdata/keymap.json`, compiled in. `PROTOCOL.md` §5 makes that file the
/// oracle for both the host and the web client, so it is read rather than
/// copied: a second table would be a second thing to keep right.
const KEYMAP_JSON: &str = include_str!("../../testdata/keymap.json");

#[derive(Debug, Deserialize)]
struct KeymapFile {
    codes: BTreeMap<String, CodeEntry>,
    sequences: BTreeMap<String, SequenceEntry>,
}

#[derive(Debug, Deserialize)]
struct CodeEntry {
    /// `null` for the keys that have no set-1 code at all (`Fn`, the Sun-series
    /// editing keys) and for the two that are sequences.
    scancode: Option<u16>,
    #[serde(default)]
    extended: bool,
    #[serde(default)]
    sequence: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SequenceEntry {
    #[serde(default)]
    make: Vec<Step>,
    #[serde(default, rename = "break")]
    release: Vec<Step>,
    #[serde(default, rename = "virtualKey")]
    virtual_key: Option<u16>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct Step {
    scancode: u16,
    #[serde(default)]
    extended: bool,
}

/// `KeyboardEvent.code` → scancode, the host half of §5.
#[derive(Debug)]
pub struct Keymap {
    file: KeymapFile,
}

/// The one parsed copy.
pub fn keymap() -> &'static Keymap {
    static MAP: OnceLock<Keymap> = OnceLock::new();
    MAP.get_or_init(|| Keymap {
        // Compiled in and covered by a unit test, so a parse failure is a build
        // that never shipped, not a machine in the field.
        file: serde_json::from_str(KEYMAP_JSON).expect("keymap.json is compiled in"),
    })
}

impl Keymap {
    /// True when this code is injected as a whole press whichever edge arrives,
    /// rather than as a down and an up. Only `PrintScreen`: Chrome on Windows
    /// reports it on keyup only, and Windows 11 may swallow it for the snipping
    /// tool before any app sees it.
    pub fn is_full_press(&self, code: &str) -> bool {
        self.sequence(code)
            .is_some_and(|sequence| sequence.virtual_key.is_none())
    }

    /// The events one `k` message becomes. Empty for a code with no scancode —
    /// `Fn` never reaches an OS as a scancode and the Sun-series editing keys
    /// have no agreed set-1 code, so neither is guessed at.
    pub fn press(&self, code: &str, down: bool) -> Vec<InputEvent> {
        let Some(entry) = self.file.codes.get(code) else {
            return Vec::new();
        };
        if let Some(scancode) = entry.scancode {
            return vec![InputEvent::Key {
                scancode,
                extended: entry.extended,
                down,
            }];
        }
        let Some(sequence) = self.sequence(code) else {
            return Vec::new();
        };
        if let Some(vk) = sequence.virtual_key {
            return vec![InputEvent::KeyVirtual { vk, down }];
        }
        sequence
            .make
            .iter()
            .map(|step| step_event(step, true))
            .chain(sequence.release.iter().map(|step| step_event(step, false)))
            .collect()
    }

    fn sequence(&self, code: &str) -> Option<&SequenceEntry> {
        let name = self.file.codes.get(code)?.sequence.as_deref()?;
        self.file.sequences.get(name)
    }
}

fn step_event(step: &Step, down: bool) -> InputEvent {
    InputEvent::Key {
        scancode: step.scancode,
        extended: step.extended,
        down,
    }
}

// -------------------------------------------------------------- per-viewer

/// Whole units out of a fractional stream, keeping the remainder.
///
/// Without it a trackpad's 4-pixel wheel deltas and sub-pixel pointer-lock
/// movement each round to zero and the input is silently lost.
#[derive(Debug, Default, Clone, Copy)]
struct Accum {
    rest: f64,
}

impl Accum {
    fn take(&mut self, value: f64) -> i32 {
        if !value.is_finite() {
            return 0;
        }
        self.rest += value;
        // Round, not truncate: the remainder then stays in [-0.5, 0.5] and a
        // long run of equal deltas adds up to what was sent rather than
        // shedding a unit to floating-point residue.
        let whole = self.rest.round();
        self.rest -= whole;
        whole.clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
    }
}

/// A leaky bucket, per viewer.
#[derive(Debug)]
struct TokenBucket {
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    fn new(now: Instant) -> Self {
        Self {
            tokens: EVENT_BURST,
            last: now,
        }
    }

    fn take(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * EVENT_RATE_PER_SEC).min(EVENT_BURST);
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

/// Everything one viewer is holding down, plus its rate limit.
///
/// `SendInput` does not reset keyboard state, and nothing else will: a viewer
/// that drops its connection mid-chord leaves those keys down on the machine
/// forever. Stuck keys are the top user-visible bug of every remote-desktop
/// product, so the held set is the point of this type and
/// [`release_all`](Self::release_all) is called on **all four** of: disconnect,
/// idle timeout, a switch of which viewer holds control, and a desktop switch.
#[derive(Debug)]
pub struct ViewerInput {
    keys: BTreeSet<(u16, bool)>,
    virtual_keys: BTreeSet<u16>,
    buttons: BTreeSet<u8>,
    /// Codes whose down edge we have already turned into a whole press, so the
    /// up edge does not press them a second time.
    full_pressed: BTreeSet<String>,
    bucket: TokenBucket,
    wheel_x: Accum,
    wheel_y: Accum,
    move_x: Accum,
    move_y: Accum,
    dropped: u64,
}

impl ViewerInput {
    pub fn new(now: Instant) -> Self {
        Self {
            keys: BTreeSet::new(),
            virtual_keys: BTreeSet::new(),
            buttons: BTreeSet::new(),
            full_pressed: BTreeSet::new(),
            bucket: TokenBucket::new(now),
            wheel_x: Accum::default(),
            wheel_y: Accum::default(),
            move_x: Accum::default(),
            move_y: Accum::default(),
            dropped: 0,
        }
    }

    /// How many messages the rate limit has dropped, for the `status` event.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// True while this viewer is holding anything at all.
    pub fn holding(&self) -> bool {
        !self.keys.is_empty() || !self.virtual_keys.is_empty() || !self.buttons.is_empty()
    }

    /// One §5 input message → the events to inject, recording what is now held.
    ///
    /// A release is **never** rate-limited: dropping an up edge is precisely
    /// how a key gets stuck, so the limit applies to presses, movement and the
    /// wheel only.
    pub fn accept(&mut self, message: &Input, now: Instant) -> Vec<InputEvent> {
        if !self.is_release(message) && !self.bucket.take(now) {
            self.dropped += 1;
            return Vec::new();
        }
        let events = match message {
            Input::M { x, y, .. } => vec![InputEvent::MouseMove {
                x: *x as f32,
                y: *y as f32,
            }],
            Input::Mr { dx, dy, .. } => {
                let (dx, dy) = (self.move_x.take(*dx), self.move_y.take(*dy));
                if dx == 0 && dy == 0 {
                    Vec::new()
                } else {
                    vec![InputEvent::MouseMoveRelative { dx, dy }]
                }
            }
            Input::B { button, down, .. } => vec![InputEvent::MouseButton {
                button: *button,
                down: *down,
            }],
            Input::W { dx, dy, mode, .. } => {
                let notch = per_notch(*mode);
                let x = self.wheel_x.take(dx / notch * WHEEL_DELTA);
                // Browsers count deltaY positive toward the bottom of the page;
                // WHEEL_DELTA counts positive away from the user. Only the
                // vertical axis flips — deltaX and MOUSEEVENTF_HWHEEL agree
                // that positive is right.
                let y = self.wheel_y.take(-dy / notch * WHEEL_DELTA);
                if x == 0 && y == 0 {
                    Vec::new()
                } else {
                    vec![InputEvent::MouseWheel {
                        delta_x: x,
                        delta_y: y,
                    }]
                }
            }
            Input::K { code, down, .. } => self.key(code, *down),
        };
        for event in &events {
            self.record(event);
        }
        events
    }

    /// Key-ups and button-ups for everything still held, exactly one each.
    pub fn release_all(&mut self) -> Vec<InputEvent> {
        let mut events = Vec::new();
        // Buttons first: a drag ends before the modifiers that qualified it.
        for button in std::mem::take(&mut self.buttons) {
            events.push(InputEvent::MouseButton {
                button,
                down: false,
            });
        }
        for (scancode, extended) in std::mem::take(&mut self.keys) {
            events.push(InputEvent::Key {
                scancode,
                extended,
                down: false,
            });
        }
        for vk in std::mem::take(&mut self.virtual_keys) {
            events.push(InputEvent::KeyVirtual { vk, down: false });
        }
        self.full_pressed.clear();
        events
    }

    fn key(&mut self, code: &str, down: bool) -> Vec<InputEvent> {
        let map = keymap();
        if map.is_full_press(code) {
            // Injected whole on whichever edge arrives first, then suppressed
            // on the other one so a browser that reports both does not press
            // the key twice.
            if down {
                self.full_pressed.insert(code.to_string());
            } else if self.full_pressed.remove(code) {
                return Vec::new();
            }
        }
        map.press(code, down)
    }

    fn is_release(&self, message: &Input) -> bool {
        match message {
            Input::K { down, .. } | Input::B { down, .. } => !down,
            _ => false,
        }
    }

    fn record(&mut self, event: &InputEvent) {
        match event {
            InputEvent::Key {
                scancode,
                extended,
                down,
            } => {
                if *down {
                    self.keys.insert((*scancode, *extended));
                } else {
                    self.keys.remove(&(*scancode, *extended));
                }
            }
            InputEvent::KeyVirtual { vk, down } => {
                if *down {
                    self.virtual_keys.insert(*vk);
                } else {
                    self.virtual_keys.remove(vk);
                }
            }
            InputEvent::MouseButton { button, down } => {
                if *down {
                    self.buttons.insert(*button);
                } else {
                    self.buttons.remove(button);
                }
            }
            InputEvent::MouseMove { .. }
            | InputEvent::MouseMoveRelative { .. }
            | InputEvent::MouseWheel { .. } => {}
        }
    }
}

fn per_notch(mode: WheelMode) -> f64 {
    match mode {
        WheelMode::Pixel => PIXELS_PER_NOTCH,
        WheelMode::Line => LINES_PER_NOTCH,
        WheelMode::Page => LINES_PER_PAGE / LINES_PER_NOTCH,
    }
}

// ------------------------------------------------------------------- win32

#[cfg(windows)]
mod win32 {
    use super::{absolute_from_desktop, coalesce, Injector, InputEvent, PointerSpace};
    use crate::capture::Rect;

    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE,
        MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
        MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
        MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, XBUTTON1, XBUTTON2,
    };

    /// The whole virtual desktop, in physical pixels.
    ///
    /// DPI awareness is declared first or every number here comes back scaled
    /// by the primary monitor's factor — on a 96/120 box that is a silent 20%
    /// error on one monitor and none on the other.
    pub fn virtual_screen() -> Rect {
        crate::capture::set_dpi_awareness();
        unsafe {
            let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
            Rect {
                left,
                top,
                right: left + GetSystemMetrics(SM_CXVIRTUALSCREEN),
                bottom: top + GetSystemMetrics(SM_CYVIRTUALSCREEN),
            }
        }
    }

    /// `SendInput` on the desktop the calling thread is attached to.
    ///
    /// Create it on the input thread and leave it there. It injects into
    /// whatever desktop that thread is on and knows nothing about switching —
    /// the secure desktop is Task 6.1's, gated on a spike that was never run.
    #[derive(Debug)]
    pub struct SendInputInjector {
        space: PointerSpace,
        bounds: Rect,
    }

    impl SendInputInjector {
        pub fn new(space: PointerSpace) -> Self {
            Self {
                space,
                bounds: virtual_screen(),
            }
        }

        /// The viewer picked a different display.
        pub fn set_space(&mut self, space: PointerSpace) {
            self.space = space;
        }

        /// A mode change moves the virtual desktop under us; capture rebuilds
        /// its duplications on the same event and this re-reads the metrics.
        pub fn refresh_bounds(&mut self) {
            self.bounds = virtual_screen();
        }

        fn build(&self, event: &InputEvent) -> Vec<INPUT> {
            match event {
                InputEvent::MouseMove { x, y } => {
                    let (dx, dy) =
                        absolute_from_desktop(self.space.to_desktop(*x, *y), self.bounds);
                    vec![mouse(
                        dx,
                        dy,
                        0,
                        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    )]
                }
                InputEvent::MouseMoveRelative { dx, dy } => {
                    vec![mouse(*dx, *dy, 0, MOUSEEVENTF_MOVE)]
                }
                InputEvent::MouseButton { button, down } => {
                    let (flags, data) = match (button, down) {
                        (0, true) => (MOUSEEVENTF_LEFTDOWN, 0),
                        (0, false) => (MOUSEEVENTF_LEFTUP, 0),
                        (1, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
                        (1, false) => (MOUSEEVENTF_MIDDLEUP, 0),
                        (2, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
                        (2, false) => (MOUSEEVENTF_RIGHTUP, 0),
                        (3, true) => (MOUSEEVENTF_XDOWN, u32::from(XBUTTON1)),
                        (3, false) => (MOUSEEVENTF_XUP, u32::from(XBUTTON1)),
                        (4, true) => (MOUSEEVENTF_XDOWN, u32::from(XBUTTON2)),
                        (4, false) => (MOUSEEVENTF_XUP, u32::from(XBUTTON2)),
                        // §5 defines five buttons; anything else is a viewer
                        // sending something it made up.
                        _ => return Vec::new(),
                    };
                    vec![mouse(0, 0, data, flags)]
                }
                InputEvent::MouseWheel { delta_x, delta_y } => {
                    let mut inputs = Vec::new();
                    if *delta_y != 0 {
                        inputs.push(mouse(0, 0, *delta_y as u32, MOUSEEVENTF_WHEEL));
                    }
                    if *delta_x != 0 {
                        inputs.push(mouse(0, 0, *delta_x as u32, MOUSEEVENTF_HWHEEL));
                    }
                    inputs
                }
                InputEvent::Key {
                    scancode,
                    extended,
                    down,
                } => {
                    let mut flags = KEYEVENTF_SCANCODE;
                    if *extended {
                        flags |= KEYEVENTF_EXTENDEDKEY;
                    }
                    if !*down {
                        flags |= KEYEVENTF_KEYUP;
                    }
                    vec![key(VIRTUAL_KEY(0), *scancode, flags)]
                }
                InputEvent::KeyVirtual { vk, down } => {
                    let flags = if *down {
                        KEYBD_EVENT_FLAGS(0)
                    } else {
                        KEYEVENTF_KEYUP
                    };
                    vec![key(VIRTUAL_KEY(*vk), 0, flags)]
                }
            }
        }

        fn send(&self, inputs: &[INPUT]) -> anyhow::Result<()> {
            if inputs.is_empty() {
                return Ok(());
            }
            let size = std::mem::size_of::<INPUT>() as i32;
            let sent = unsafe { SendInput(inputs, size) } as usize;
            if sent != inputs.len() {
                // UIPI is the usual cause and it is invisible: a blocked
                // SendInput returns 0 having set no useful last error, so there
                // is nothing to report but the count.
                anyhow::bail!(
                    "SendInput injected {sent} of {} events (blocked, most likely by UIPI)",
                    inputs.len()
                );
            }
            Ok(())
        }
    }

    impl Injector for SendInputInjector {
        fn inject(&mut self, event: &InputEvent) -> anyhow::Result<()> {
            self.send(&self.build(event))
        }

        /// One syscall for the whole frame: `SendInput` guarantees the array is
        /// not interleaved with any other thread's input, which is also what
        /// keeps a chord from being split.
        fn inject_all(&mut self, events: &[InputEvent]) -> anyhow::Result<()> {
            let inputs: Vec<INPUT> = coalesce(events)
                .iter()
                .flat_map(|event| self.build(event))
                .collect();
            self.send(&inputs)
        }
    }

    fn mouse(dx: i32, dy: i32, data: u32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn key(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
}

#[cfg(windows)]
pub use win32::{virtual_screen, SendInputInjector};

#[cfg(test)]
mod tests {
    use super::*;

    /// The two outputs spike 0.8 measured: a 96 DPI landscape primary at the
    /// origin and a 120 DPI rotate270 4K panel left of and above it, which puts
    /// the virtual desktop's origin at (-2160, -1138).
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

    fn measured_bounds() -> Rect {
        crate::capture::virtual_bounds(&measured_outputs()).expect("two outputs")
    }

    fn wire_wheel(dx: f64, dy: f64, mode: WheelMode) -> Input {
        Input::W {
            dx,
            dy,
            mode,
            seq: 1,
            ts_us: 0,
        }
    }

    fn wire_key(code: &str, down: bool) -> Input {
        Input::K {
            code: code.to_string(),
            down,
            seq: 1,
            ts_us: 0,
        }
    }

    #[test]
    fn absolute_normalisation_spans_a_negative_origin() {
        let bounds = measured_bounds();
        // The desktop's own corners are the ends of the range. The bottom-right
        // pixel reaching exactly 65535 is what the size-1 divisor buys.
        assert_eq!(absolute_from_desktop((-2160, -1138), bounds), (0, 0));
        assert_eq!(absolute_from_desktop((1919, 2701), bounds), (65535, 65535));
        // The primary monitor's origin is nowhere near 0, which is the whole
        // failure mode: normalising against the primary puts this at (0, 0).
        assert_eq!(absolute_from_desktop((0, 0), bounds), (34704, 19427));
        assert_eq!(absolute_from_desktop((960, 540), bounds), (50127, 28645));
    }

    #[test]
    fn a_single_monitor_box_hides_the_bug() {
        // The same click, same pixel, on a box with only the primary attached.
        // It lands mid-screen either way there — which is why this case has to
        // be a unit test and cannot be found by using the product.
        let only_primary = Rect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        assert_eq!(absolute_from_desktop((960, 540), only_primary), (32785, 32798));
        assert_ne!(
            absolute_from_desktop((960, 540), only_primary),
            absolute_from_desktop((960, 540), measured_bounds())
        );
    }

    #[test]
    fn a_degenerate_desktop_never_divides_by_zero() {
        let single_pixel = Rect {
            left: 7,
            top: 9,
            right: 8,
            bottom: 10,
        };
        assert_eq!(absolute_from_desktop((7, 9), single_pixel), (0, 0));
    }

    #[test]
    fn viewer_space_crosses_the_rotation_and_the_origin() {
        let outputs = measured_outputs();
        let bounds = measured_bounds();

        let primary = PointerSpace::from_output(&outputs[0]);
        assert_eq!(primary.to_desktop(0.0, 0.0), (0, 0));
        assert_eq!(primary.to_desktop(1.0, 1.0), (1919, 1079));

        // The rotate270 panel: the texture is the un-rotated framebuffer, so
        // its top-left is displayed at the bottom-left of the desktop rect.
        let rotated = PointerSpace::from_output(&outputs[1]);
        assert_eq!(rotated.to_desktop(0.0, 0.0), (-2160, 2701));
        assert_eq!(rotated.to_desktop(1.0, 0.0), (-2160, -1138));
        assert_eq!(rotated.to_desktop(0.25, 0.5), (-1080, 1741));
        assert_eq!(
            absolute_from_desktop(rotated.to_desktop(0.25, 0.5), bounds),
            (17352, 49147)
        );

        // Out-of-range coordinates from a viewer clamp in texture space, so
        // they land on this display's own corner and never on the neighbouring
        // monitor.
        assert_eq!(rotated.to_desktop(-5.0, 9.0), (-1, 2701));
    }

    #[test]
    fn every_rotation_is_its_own_inverse_through_four_turns() {
        let point = (0.3_f64, 0.8_f64);
        let mut turned = point;
        for _ in 0..4 {
            turned = un_rotate(turned.0, turned.1, Rotation::Rotate90);
        }
        assert!((turned.0 - point.0).abs() < 1e-9 && (turned.1 - point.1).abs() < 1e-9);
    }

    #[test]
    fn extended_flags_match_the_keymap_file() {
        let map = keymap();
        // Every code in the file, against the file: the table below only pins
        // the ones that are easy to get wrong, this pins all 162.
        let raw: serde_json::Value = serde_json::from_str(KEYMAP_JSON).expect("parse");
        for (code, entry) in raw["codes"].as_object().expect("codes") {
            let events = map.press(code, true);
            match entry["scancode"].as_u64() {
                Some(scancode) => {
                    assert_eq!(
                        events,
                        vec![InputEvent::Key {
                            scancode: scancode as u16,
                            extended: entry["extended"].as_bool().unwrap_or(false),
                            down: true,
                        }],
                        "{code}"
                    );
                }
                None => assert!(
                    entry["sequence"].is_string() || events.is_empty(),
                    "{code} has no scancode and no sequence but produced {events:?}"
                ),
            }
        }

        // The extended set the task names, and the low-byte twins it is told
        // apart from. Numpad1 and End share scancode 79.
        for code in [
            "ControlRight",
            "AltRight",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Insert",
            "Delete",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "NumpadEnter",
            "NumpadDivide",
        ] {
            assert_eq!(
                map.press(code, true)
                    .iter()
                    .map(|e| matches!(e, InputEvent::Key { extended: true, .. }))
                    .collect::<Vec<_>>(),
                vec![true],
                "{code} must be extended"
            );
        }
        assert_eq!(
            map.press("End", true),
            vec![InputEvent::Key {
                scancode: 79,
                extended: true,
                down: true
            }]
        );
        assert_eq!(
            map.press("Numpad1", true),
            vec![InputEvent::Key {
                scancode: 79,
                extended: false,
                down: true
            }]
        );
        assert_eq!(
            map.press("ControlLeft", true),
            vec![InputEvent::Key {
                scancode: 29,
                extended: false,
                down: true
            }]
        );
        assert_eq!(
            map.press("Enter", true),
            vec![InputEvent::Key {
                scancode: 28,
                extended: false,
                down: true
            }]
        );
        assert!(map.press("Fn", true).is_empty());
        assert!(map.press("NotAKey", true).is_empty());
    }

    #[test]
    fn printscreen_is_a_whole_press_and_pause_is_a_virtual_key() {
        let map = keymap();
        assert!(map.is_full_press("PrintScreen"));
        assert!(!map.is_full_press("Pause"));
        // Both halves, both extended, on whichever edge arrives.
        assert_eq!(
            map.press("PrintScreen", false),
            vec![
                InputEvent::Key { scancode: 42, extended: true, down: true },
                InputEvent::Key { scancode: 55, extended: true, down: true },
                InputEvent::Key { scancode: 55, extended: true, down: false },
                InputEvent::Key { scancode: 42, extended: true, down: false },
            ]
        );
        // e1-prefixed, so VK_PAUSE is the only way through SendInput.
        assert_eq!(
            map.press("Pause", true),
            vec![InputEvent::KeyVirtual { vk: 19, down: true }]
        );
    }

    #[test]
    fn a_browser_reporting_both_printscreen_edges_presses_it_once() {
        let mut viewer = ViewerInput::new(Instant::now());
        let now = Instant::now();
        assert_eq!(viewer.accept(&wire_key("PrintScreen", true), now).len(), 4);
        assert!(viewer.accept(&wire_key("PrintScreen", false), now).is_empty());
        // Chrome reports the key on keyup only: that edge alone still presses.
        assert_eq!(viewer.accept(&wire_key("PrintScreen", false), now).len(), 4);
        assert!(!viewer.holding());
    }

    #[test]
    fn wheel_flips_the_vertical_axis_only() {
        let mut viewer = ViewerInput::new(Instant::now());
        let now = Instant::now();
        // deltaY negative is a scroll up in the browser; WHEEL_DELTA positive
        // is away from the user, also up.
        assert_eq!(
            viewer.accept(&wire_wheel(0.0, -100.0, WheelMode::Pixel), now),
            vec![InputEvent::MouseWheel {
                delta_x: 0,
                delta_y: 120
            }]
        );
        assert_eq!(
            viewer.accept(&wire_wheel(0.0, 100.0, WheelMode::Pixel), now),
            vec![InputEvent::MouseWheel {
                delta_x: 0,
                delta_y: -120
            }]
        );
        // deltaX positive is a scroll right, and so is a positive HWHEEL.
        assert_eq!(
            viewer.accept(&wire_wheel(100.0, 0.0, WheelMode::Pixel), now),
            vec![InputEvent::MouseWheel {
                delta_x: 120,
                delta_y: 0
            }]
        );
        // One line up is a third of a notch, in the same direction.
        assert_eq!(
            viewer.accept(&wire_wheel(0.0, -3.0, WheelMode::Line), now),
            vec![InputEvent::MouseWheel {
                delta_x: 0,
                delta_y: 120
            }]
        );
    }

    #[test]
    fn a_trackpads_sub_notch_scrolling_is_not_rounded_away() {
        let mut viewer = ViewerInput::new(Instant::now());
        let now = Instant::now();
        // Ten 4-pixel deltas: each rounds to zero on its own, together they are
        // most of half a notch.
        let mut total = 0;
        for _ in 0..10 {
            for event in viewer.accept(&wire_wheel(0.0, -4.0, WheelMode::Pixel), now) {
                if let InputEvent::MouseWheel { delta_y, .. } = event {
                    total += delta_y;
                }
            }
        }
        assert_eq!(total, 48);
    }

    #[test]
    fn a_disconnect_emits_exactly_one_key_up_per_held_key() {
        let mut viewer = ViewerInput::new(Instant::now());
        let now = Instant::now();
        for code in ["ControlLeft", "ShiftRight", "KeyA", "ArrowUp", "Pause"] {
            viewer.accept(&wire_key(code, true), now);
        }
        viewer.accept(
            &Input::B {
                button: 0,
                down: true,
                seq: 1,
                ts_us: 0,
            },
            now,
        );
        // Pressed and released before the drop: it must not be released twice.
        viewer.accept(&wire_key("KeyB", true), now);
        viewer.accept(&wire_key("KeyB", false), now);
        assert!(viewer.holding());

        let released = viewer.release_all();
        assert_eq!(released.len(), 6);
        assert!(released.iter().all(|event| matches!(
            event,
            InputEvent::Key { down: false, .. }
                | InputEvent::KeyVirtual { down: false, .. }
                | InputEvent::MouseButton { down: false, .. }
        )));
        assert!(released.contains(&InputEvent::Key {
            scancode: 29,
            extended: false,
            down: false
        }));
        assert!(released.contains(&InputEvent::KeyVirtual {
            vk: 19,
            down: false
        }));
        assert!(released.contains(&InputEvent::MouseButton {
            button: 0,
            down: false
        }));
        assert!(!released.contains(&InputEvent::Key {
            scancode: 48,
            extended: false,
            down: false
        }));

        // Idempotent: the session calls this on disconnect, timeout, viewer
        // switch and desktop switch, and two of those can land together.
        assert!(!viewer.holding());
        assert!(viewer.release_all().is_empty());
    }

    #[test]
    fn the_rate_limit_never_drops_a_release() {
        let now = Instant::now();
        let mut viewer = ViewerInput::new(now);
        viewer.accept(&wire_key("KeyA", true), now);
        // Spend the bucket without letting the clock advance.
        for _ in 0..(EVENT_BURST as usize + 50) {
            viewer.accept(
                &Input::M {
                    x: 0.5,
                    y: 0.5,
                    seq: 1,
                    ts_us: 0,
                },
                now,
            );
        }
        assert!(viewer.dropped() > 0);
        // A dropped key-up is a stuck key, so releases bypass the bucket.
        assert_eq!(
            viewer.accept(&wire_key("KeyA", false), now),
            vec![InputEvent::Key {
                scancode: 30,
                extended: false,
                down: false
            }]
        );
        assert!(!viewer.holding());
    }

    #[test]
    fn a_frames_moves_coalesce_but_clicks_keep_their_position() {
        let batch = vec![
            InputEvent::MouseMove { x: 0.1, y: 0.1 },
            InputEvent::MouseMove { x: 0.2, y: 0.2 },
            InputEvent::MouseMove { x: 0.3, y: 0.3 },
            InputEvent::MouseButton {
                button: 0,
                down: true,
            },
            InputEvent::MouseMove { x: 0.9, y: 0.9 },
        ];
        assert_eq!(
            coalesce(&batch),
            vec![
                InputEvent::MouseMove { x: 0.3, y: 0.3 },
                InputEvent::MouseButton {
                    button: 0,
                    down: true
                },
                InputEvent::MouseMove { x: 0.9, y: 0.9 },
            ]
        );
        // Pointer-lock deltas add up instead.
        assert_eq!(
            coalesce(&[
                InputEvent::MouseMoveRelative { dx: -4, dy: 7 },
                InputEvent::MouseMoveRelative { dx: 1, dy: -2 },
            ]),
            vec![InputEvent::MouseMoveRelative { dx: -3, dy: 5 }]
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "MOVES THE REAL MOUSE POINTER and presses a real key on this box; cargo test -- --ignored input"]
    fn injection_moves_this_machines_pointer() {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        /// `SendInput` only queues: the raw input thread applies the event, so
        /// reading the state back in the same instant is a race.
        fn settles(vk: i32, down: bool) -> bool {
            for _ in 0..100 {
                // Sleep first: the state is never up to date in the same
                // instant the call returns.
                std::thread::sleep(std::time::Duration::from_millis(5));
                if (unsafe { GetAsyncKeyState(vk) } < 0) == down {
                    return true;
                }
            }
            false
        }

        let outputs = crate::capture::enumerate_outputs().expect("enumerate");
        let primary = outputs.first().expect("an attached output").clone();
        let space = PointerSpace::from_output(&primary);
        let bounds = virtual_screen();
        println!(
            "virtual screen {bounds:?}, injecting into {}",
            primary.device_name
        );

        let mut before = POINT::default();
        unsafe { GetCursorPos(&mut before) }.expect("read cursor");

        let mut injector = SendInputInjector::new(space);
        let target = space.to_desktop(0.5, 0.5);
        injector
            .inject_all(&[InputEvent::MouseMove { x: 0.5, y: 0.5 }])
            .expect("inject move");
        let mut landed = POINT::default();
        unsafe { GetCursorPos(&mut landed) }.expect("read cursor");

        // Shift alone types nothing, so this is safe whatever has focus, and it
        // proves the release path on real hardware rather than in a fake. The
        // release is injected before anything is asserted: a panic between the
        // two would leave a real key held down on the machine.
        let mut viewer = ViewerInput::new(Instant::now());
        let press = viewer.accept(&wire_key("ShiftLeft", true), Instant::now());
        injector.inject_all(&press).expect("inject shift");
        let went_down = settles(0x10, true);
        let release = viewer.release_all();
        injector.inject_all(&release).expect("release shift");
        let came_up = settles(0x10, false);

        // And the pointer goes back where the user left it, through a space
        // that is the whole virtual desktop so the original point is
        // expressible whichever monitor it was on.
        println!("restoring the pointer to ({}, {})", before.x, before.y);
        let mut whole = SendInputInjector::new(PointerSpace {
            rect: bounds,
            rotation: Rotation::Identity,
        });
        whole
            .inject(&InputEvent::MouseMove {
                x: (before.x - bounds.left) as f32 / (bounds.width() - 1) as f32,
                y: (before.y - bounds.top) as f32 / (bounds.height() - 1) as f32,
            })
            .expect("restore pointer");

        println!("asked for {target:?}, landed at ({}, {})", landed.x, landed.y);
        // The 0..65535 grid is coarser than a 4K desktop, so a pixel or two is
        // the quantisation, not a transform error. Anything more is landing on
        // the wrong monitor.
        assert!(
            (landed.x - target.0).abs() <= 3 && (landed.y - target.1).abs() <= 3,
            "landed at ({}, {}), wanted {target:?}",
            landed.x,
            landed.y
        );
        assert!(went_down, "shift did not go down");
        assert!(came_up, "shift stayed down");
    }

}
