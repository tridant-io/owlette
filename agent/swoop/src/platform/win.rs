//! Windows process setup.

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
pub fn pin_dll_search_path() -> windows::core::Result<()> {
    unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)?;
        SetDllDirectoryW(w!(""))?;
    }
    Ok(())
}
