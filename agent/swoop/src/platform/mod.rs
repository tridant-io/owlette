//! Platform seams: one set of names, one backend set behind them per OS.
//!
//! The session loop names nothing platform-specific but these. Each module
//! below exports every one of them, chosen here by `cfg` rather than behind a
//! trait object, so the frame path keeps static dispatch and the Windows types
//! keep their code. A name one module lacks is a compile error on that OS,
//! which is what keeps the three in step.

#[cfg(windows)]
pub mod win;
#[cfg(windows)]
use win as imp;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
use macos as imp;

// linux gets its own plan; until then it compiles, and says so at run time.
// macos borrows its stubs for whatever wave 4 has not built yet.
#[cfg(not(windows))]
pub mod unsupported;
#[cfg(not(any(windows, target_os = "macos")))]
use unsupported as imp;

pub use imp::{
    clock, dpi_for_rect, enumerate_outputs, process, CaptureSource, DesktopWatcher, Downscaler,
    InputInjector, ScaleError,
};
