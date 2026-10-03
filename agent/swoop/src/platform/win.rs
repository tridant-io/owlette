//! Windows: the seam's names over the Win32 backends, the QPC clock, and
//! process setup.

pub use crate::capture::{enumerate_outputs, DesktopWatcher, Duplication as CaptureSource};
pub use crate::cursor::dpi_for_rect;
pub use crate::gpu::scale::{Downscaler, ScaleError};
pub use crate::input::SendInputInjector as InputInjector;

/// QPC ticks: what Desktop Duplication stamps a frame and a pointer update
/// with, so every stamp the session makes is on the capture's own clock.
pub mod clock {
    use anyhow::Context;
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

    pub fn now_ticks() -> i64 {
        let mut ticks = 0i64;
        // SAFETY: writes one i64. QueryPerformanceCounter cannot fail on any
        // Windows this binary runs on, and a zero is a timestamp, not a crash.
        let _ = unsafe { QueryPerformanceCounter(&mut ticks) };
        ticks
    }

    /// `QueryPerformanceFrequency`, for [`crate::transport::rtc::PeerConfig::qpc_hz`].
    /// Fixed for the life of the system, so a caller reads it once.
    pub fn hz() -> anyhow::Result<i64> {
        let mut hz = 0i64;
        unsafe {
            QueryPerformanceFrequency(&mut hz).context("QueryPerformanceFrequency")?;
        }
        Ok(hz)
    }
}

pub mod process {
    use anyhow::Context;
    use windows::core::w;
    use windows::Win32::System::LibraryLoader::{
        SetDefaultDllDirectories, SetDllDirectoryW, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };

    /// Pin the DLL search path to System32, before anything else runs.
    ///
    /// This process is started by the service and loads vendor DLLs by absolute
    /// path at runtime, so it never needs the default search order — and the
    /// default search order includes the process's own directory and the current
    /// directory. Called first in `main`, before any dependency has a chance to
    /// load anything.
    ///
    /// Both calls matter: `SetDefaultDllDirectories` restricts the search list, and
    /// `SetDllDirectory("")` removes the current directory from it (the one thing
    /// the first call does not cover on every Windows version).
    pub fn prepare() -> anyhow::Result<()> {
        unsafe {
            SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)
                .and_then(|()| SetDllDirectoryW(w!("")))
        }
        .context("could not pin the dll search path")
    }

    /// Never on Windows: the service starts the streamer itself and ends the
    /// session with its own `kill` when it stops, so nothing is watched here.
    pub fn parent_gone() -> bool {
        false
    }
}
