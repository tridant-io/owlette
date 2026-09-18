//! owlette-swoop.exe — spawned by the agent service, one per machine.
//!
//! Three verbs (plan.md's names registry): `run` takes the session bundle on
//! stdin, `probe` reports capture and encode capability as JSON, `version`
//! prints the build's version so the service can refuse a stale streamer.

use std::process::ExitCode;

use owlette_swoop::{ipc::exit, log as swoop_log, probe};

fn main() -> ExitCode {
    // First, before any dependency has a chance to load a DLL.
    #[cfg(windows)]
    if let Err(e) = owlette_swoop::platform::win::pin_dll_search_path() {
        eprintln!("owlette-swoop: could not pin the dll search path: {e}");
        return ExitCode::from(exit::INTERNAL);
    }

    match std::env::args().nth(1).as_deref() {
        Some("version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            ExitCode::from(exit::OK)
        }
        Some("probe") => match serde_json::to_string(&probe::report()) {
            Ok(json) => {
                println!("{json}");
                ExitCode::from(exit::OK)
            }
            Err(e) => {
                eprintln!("owlette-swoop: probe failed: {e}");
                ExitCode::from(exit::INTERNAL)
            }
        },
        Some("run") => run(),
        _ => {
            eprintln!("usage: owlette-swoop <run|probe|version>");
            ExitCode::from(exit::INTERNAL)
        }
    }
}

/// Tasks 4.1 and 5.1 fill this in. Logging is installed only here: `probe` and
/// `version` are read by the service on paths that must not create directories
/// or touch the log.
fn run() -> ExitCode {
    if let Err(e) = swoop_log::init(::log::LevelFilter::Info) {
        eprintln!("owlette-swoop: could not install the logger: {e}");
        return ExitCode::from(exit::INTERNAL);
    }
    ::log::error!("run is not implemented yet");
    ExitCode::from(exit::INTERNAL)
}
