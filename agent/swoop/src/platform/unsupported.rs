//! Every OS without a streamer yet: the seam's names, as honest stubs.
//!
//! `enumerate_outputs` answers an empty list, so `run` exits 12 before it dials
//! anything, with a log line that names the OS. Nothing here captures, scales
//! or injects. The capture source and the scaler are uninhabited: `open` is the
//! only way to one and it always refuses, so no method on either is reachable.
//! macOS takes its capture, scaler, injector and watcher from here until Task
//! 5.1 wires its own.

use std::convert::Infallible;
use std::env::consts::OS;

use crate::capture::{FrameRects, OutputInfo, Rect, RebuildSignal, Source};
use crate::cursor::{PointerSample, DEFAULT_DPI};
use crate::gpu::Frame;
use crate::input::{InputEvent, Injector, PointerSpace};
use crate::ipc::Exit;

pub fn enumerate_outputs() -> anyhow::Result<Vec<OutputInfo>> {
    ::log::error!("swoop: capture is not built for {OS} yet");
    Ok(Vec::new())
}

pub fn dpi_for_rect(_rect: &Rect) -> u32 {
    DEFAULT_DPI
}

pub struct CaptureSource(Infallible);

impl CaptureSource {
    pub fn open(_output: &OutputInfo, _signal: RebuildSignal) -> anyhow::Result<Self> {
        anyhow::bail!("capture is not built for {OS} yet")
    }

    pub fn output(&self) -> &OutputInfo {
        match self.0 {}
    }

    pub fn last_rects(&self) -> &FrameRects {
        match self.0 {}
    }

    pub fn take_idr_request(&mut self) -> bool {
        match self.0 {}
    }

    pub fn request_rebuild(&self) {
        match self.0 {}
    }

    pub fn next_frame_with(
        &mut self,
        _timeout_ms: u32,
        _observer: &mut dyn FnMut(&PointerSample),
    ) -> anyhow::Result<Option<Frame>> {
        match self.0 {}
    }
}

impl Source for CaptureSource {
    fn next_frame(&mut self, _timeout_ms: u32) -> anyhow::Result<Option<Frame>> {
        match self.0 {}
    }

    fn size(&self) -> (u32, u32) {
        match self.0 {}
    }
}

/// There is no input desktop to follow, so it never switches.
#[derive(Debug, Default)]
pub struct DesktopWatcher;

impl DesktopWatcher {
    pub fn new() -> Self {
        Self
    }

    pub fn follow(&mut self) -> bool {
        false
    }

    pub fn name(&self) -> &str {
        "default"
    }
}

#[derive(Debug)]
pub struct InputInjector;

impl InputInjector {
    pub fn new(_space: PointerSpace) -> Self {
        Self
    }

    pub fn set_space(&mut self, _space: PointerSpace) {}

    pub fn refresh_bounds(&mut self) {}
}

impl Injector for InputInjector {
    fn inject(&mut self, _event: &InputEvent) -> anyhow::Result<()> {
        anyhow::bail!("input injection is not built for {OS} yet")
    }
}

pub struct Downscaler(Infallible);

impl Downscaler {
    pub fn open(_frame: &Frame, _width: u32, _height: u32) -> Result<Self, ScaleError> {
        Err(ScaleError::Unsupported)
    }

    pub fn target(&self) -> (u32, u32) {
        match self.0 {}
    }

    pub fn scale(&mut self, _frame: &Frame) -> Result<Frame, ScaleError> {
        match self.0 {}
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ScaleError {
    #[error("downscaling is not built for {} yet", OS)]
    Unsupported,
}

impl ScaleError {
    /// The same answer as every other platform's: no scaled frame is no
    /// encodable frame.
    pub const fn exit(&self) -> Exit {
        Exit::NoEncoder
    }
}

pub mod clock {
    use std::sync::OnceLock;
    use std::time::Instant;

    /// Nanoseconds since the first read. Every consumer takes differences, so
    /// the origin is nobody's business.
    pub fn now_ticks() -> i64 {
        static ORIGIN: OnceLock<Instant> = OnceLock::new();
        let origin = *ORIGIN.get_or_init(Instant::now);
        i64::try_from(origin.elapsed().as_nanos()).unwrap_or(i64::MAX)
    }

    pub fn hz() -> anyhow::Result<i64> {
        Ok(1_000_000_000)
    }
}

pub mod process {
    use std::sync::OnceLock;

    /// The pid that started this process, taken at `prepare`.
    static PARENT: OnceLock<libc::pid_t> = OnceLock::new();

    fn parent() -> libc::pid_t {
        // SAFETY: getppid takes nothing and cannot fail.
        unsafe { libc::getppid() }
    }

    /// Remember who started us; nothing else to set up before `main` goes on.
    pub fn prepare() -> anyhow::Result<()> {
        PARENT.get_or_init(parent);
        Ok(())
    }

    /// Whether the process that started this one has gone. On macOS and Linux
    /// the streamer is the desktop app's child and holds the app's grants
    /// (Screen Recording, Accessibility) through it: once the app quits, the
    /// kernel hands the child to another parent and the keyboard stops at the
    /// machine while the picture goes on. The session ends on this instead.
    pub fn parent_gone() -> bool {
        *PARENT.get_or_init(parent) != parent()
    }

    #[cfg(test)]
    mod tests {
        use super::parent_gone;

        #[test]
        fn a_living_parent_is_not_gone() {
            assert!(!parent_gone());
            assert!(!parent_gone());
        }
    }
}
