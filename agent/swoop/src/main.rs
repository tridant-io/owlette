//! owlette-swoop.exe — spawned by the agent service, one per machine.
//!
//! Three verbs (plan.md's names registry): `run` takes the session bundle on
//! stdin, `probe` reports capture and encode capability as JSON, `version`
//! prints the build's version so the service can refuse a stale streamer. On
//! macOS a fourth, `selfcheck`, reports what the privacy system credits this
//! process with, as one JSON line.

use std::io::{self, BufRead, BufReader};
use std::process::ExitCode;

use owlette_swoop::bundle::{Bundle, BuildVersions};
use owlette_swoop::{ipc::exit, log as swoop_log, probe};
use zeroize::Zeroize;

#[cfg(target_os = "macos")]
const USAGE: &str = "usage: owlette-swoop <run|probe|version|selfcheck [--force|--grants]>";
#[cfg(not(target_os = "macos"))]
const USAGE: &str = "usage: owlette-swoop <run|probe|version>";

fn main() -> ExitCode {
    // First, before any dependency has a chance to load a DLL.
    if let Err(e) = owlette_swoop::platform::process::prepare() {
        eprintln!("owlette-swoop: {e:#}");
        return ExitCode::from(exit::INTERNAL);
    }

    match std::env::args().nth(1).as_deref() {
        Some("version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            ExitCode::from(exit::OK)
        }
        // The report prints whichever way it goes: a machine that cannot encode
        // is exactly the one somebody needs the adapter list from.
        Some("probe") => {
            let report = probe::report();
            match serde_json::to_string(&report) {
                Ok(json) => {
                    println!("{json}");
                    ExitCode::from(report.exit().code())
                }
                Err(e) => {
                    eprintln!("owlette-swoop: probe failed: {e}");
                    ExitCode::from(exit::INTERNAL)
                }
            }
        }
        Some("run") => run(),
        #[cfg(target_os = "macos")]
        Some("selfcheck") => selfcheck(),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(exit::INTERNAL)
        }
    }
}

/// The `selfcheck` verb: one JSON line, exit 0 whatever it says. No logger —
/// like `probe`, it is read by a caller that must not create directories.
/// `--force` also asks ScreenCaptureKit when the preflight says no, which may
/// raise the Screen Recording dialog; without it nothing here can. `--grants`
/// prints the three grant answers alone and touches neither ScreenCaptureKit
/// nor the network: the desktop app asks it on a timer, because its own
/// process keeps the Accessibility answer it had at launch. `--paste-once`
/// reads the pasteboard one time, which under *ask* raises macOS's paste
/// alert: only the desktop app's own button runs it, on a click.
#[cfg(target_os = "macos")]
fn selfcheck() -> ExitCode {
    use owlette_swoop::platform::macos;
    let line = match std::env::args().nth(2).as_deref() {
        Some("--grants") => serde_json::to_string(&macos::grants()),
        Some("--paste-once") => serde_json::to_string(&macos::paste_once()),
        flag => serde_json::to_string(&macos::selfcheck(flag == Some("--force"))),
    };
    match line {
        Ok(json) => {
            println!("{json}");
            ExitCode::from(exit::OK)
        }
        Err(e) => {
            eprintln!("owlette-swoop: selfcheck failed: {e}");
            ExitCode::from(exit::INTERNAL)
        }
    }
}

/// The `run` verb. Logging is installed only here: `probe` and `version` are
/// read by the service on paths that must not create directories or touch the
/// log.
/// `OWLETTE_SWOOP_LOG=debug` (or `trace`) from the service turns the per-frame
/// counters on for a diagnosis; anything else, or nothing, is info.
fn log_level_from_env() -> ::log::LevelFilter {
    match std::env::var("OWLETTE_SWOOP_LOG").ok().map(|v| v.to_ascii_lowercase()).as_deref() {
        Some("debug") => ::log::LevelFilter::Debug,
        Some("trace") => ::log::LevelFilter::Trace,
        _ => ::log::LevelFilter::Info,
    }
}

fn run() -> ExitCode {
    if let Err(e) = swoop_log::init(log_level_from_env()) {
        eprintln!("owlette-swoop: could not install the logger: {e}");
        return ExitCode::from(exit::INTERNAL);
    }
    crash::install();

    // One reader for the whole process: a second one over stdin would lose
    // whatever this one had already buffered past line 1.
    let mut stdin = BufReader::new(io::stdin());
    let mut line = String::new();
    let read = stdin.read_line(&mut line);
    // Nothing about the bundle reaches a log, an error or stdout — not the
    // value, not its length, not the field that was wrong (§7).
    let exit = match read {
        Ok(0) | Err(_) => {
            ::log::error!("owlette-swoop: no bundle on stdin");
            exit::BUNDLE_INVALID
        }
        Ok(_) => match Bundle::parse(line.trim_end(), BuildVersions::THIS_BUILD) {
            Ok(bundle) => {
                line.zeroize();
                session_exit(bundle, stdin)
            }
            Err(e) => {
                ::log::error!("owlette-swoop: bundle refused: {}", e.reason());
                e.exit().code()
            }
        },
    };
    line.zeroize();
    ExitCode::from(exit)
}

fn session_exit(bundle: Bundle, stdin: impl BufRead + Send + 'static) -> u8 {
    owlette_swoop::session::run(bundle, stdin).code()
}

/// The panic path.
///
/// This process will crash on somebody's iGPU, inside a vendor DLL, on a
/// machine nobody can attach a debugger to, and nothing else collects
/// diagnostics for it — the service sees an exit code and the log file holds
/// whatever was written before the unwind.
mod crash {
    use std::panic;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// At most this many dumps in the directory. The cap is enforced by *not
    /// writing* rather than by deleting: nothing in this process removes a file
    /// it did not create in this run.
    #[cfg(windows)]
    const KEEP_DUMPS: usize = 3;

    /// One per process. A panic inside the dump path would otherwise recurse.
    static WRITTEN: AtomicBool = AtomicBool::new(false);

    pub fn install() {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            // The message before the dump: a dump that could not be written
            // must not cost the one line that says what happened. Panic
            // payloads here are our own `expect`/`unwrap` strings, never a
            // bundle field — nothing that holds one can panic with it.
            ::log::error!("owlette-swoop: panic: {info}");
            if !WRITTEN.swap(true, Ordering::SeqCst) {
                match minidump() {
                    Some(path) => ::log::error!("owlette-swoop: minidump at {}", path.display()),
                    None => ::log::error!("owlette-swoop: no minidump was written"),
                }
            }
            previous(info);
        }));
    }

    #[cfg(windows)]
    fn minidump() -> Option<PathBuf> {
        minidump_into(crate::swoop_log::dir())
    }

    /// The directory is a parameter so the test below can prove the dbghelp
    /// call actually works without leaving a dump in the log directory — where
    /// it would then count against [`KEEP_DUMPS`] and crowd out a real one.
    #[cfg(windows)]
    fn minidump_into(dir: PathBuf) -> Option<PathBuf> {
        use std::ffi::c_void;
        use std::fs::{self, File};
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId};

        /// `MINIDUMP_TYPE`: `MiniDumpWithThreadInfo | MiniDumpWithIndirectlyReferencedMemory`.
        /// Small enough for a signage box's system drive, and enough to see
        /// which thread was in which vendor call.
        const DUMP_TYPE: u32 = 0x1000 | 0x0040;

        type WriteDump = unsafe extern "system" fn(
            *mut c_void,
            u32,
            *mut c_void,
            u32,
            *const c_void,
            *const c_void,
            *const c_void,
        ) -> i32;

        fs::create_dir_all(&dir).ok()?;
        let existing = fs::read_dir(&dir)
            .ok()?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "dmp"))
            .count();
        if existing >= KEEP_DUMPS {
            return None;
        }

        // System32 by absolute path, the same discipline every vendor DLL in
        // this crate is loaded with.
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        // SAFETY: loading dbghelp runs its initialisers, which is what every
        // crash reporter does. The handle lives until this function returns,
        // and the call below happens while it is still loaded.
        let library = unsafe { libloading::Library::new(format!("{system_root}\\System32\\dbghelp.dll")) }.ok()?;
        // SAFETY: the signature is `MiniDumpWriteDump`'s, with handles as raw
        // pointers and the three optional structures as null.
        let write: libloading::Symbol<WriteDump> = unsafe { library.get(b"MiniDumpWriteDump\0") }.ok()?;

        let path = dir.join(format!("swoop-crash-{}.dmp", std::process::id()));
        let file = File::create(&path).ok()?;
        // SAFETY: `file` outlives the call, and the three null parameters are
        // documented as optional.
        let ok = unsafe {
            write(
                GetCurrentProcess().0,
                GetCurrentProcessId(),
                file.as_raw_handle(),
                DUMP_TYPE,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        (ok != 0).then_some(path)
    }

    #[cfg(not(windows))]
    fn minidump() -> Option<PathBuf> {
        None
    }

    #[cfg(all(test, windows))]
    mod tests {
        use super::*;

        /// dbghelp is loaded by name at runtime and the symbol is resolved by
        /// string, so nothing about this path fails at compile time — a wrong
        /// export name or a dll that will not load is a silent `None` on the
        /// one day it matters. This is the only thing that catches that.
        #[test]
        fn a_minidump_is_actually_written() {
            let dir = std::env::temp_dir().join(format!("swoop-dump-test-{}", std::process::id()));
            let path = minidump_into(dir.clone()).expect("dbghelp wrote a minidump");
            let bytes = std::fs::metadata(&path).expect("the dump exists").len();
            // 'MDMP' — a truncated or empty file would still be a file.
            let head = std::fs::read(&path).expect("the dump is readable");
            assert_eq!(&head[..4], b"MDMP", "not a minidump header");
            assert!(bytes > 4096, "a {bytes}-byte dump is not a dump");
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir(&dir);
        }
    }
}
