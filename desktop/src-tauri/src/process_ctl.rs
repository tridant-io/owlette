//! Graceful termination of a supervised process.
//!
//! Mirrors `shared_utils.graceful_terminate` (`agent/src/shared_utils.py`):
//! ask the process to close, wait, then terminate. Adds an identity check — the
//! frontend's PID comes from `app_states.json` and the service may have replaced
//! the process since, so confirm the PID still runs the expected executable
//! before touching it.
//!
//! "Ask" is what differs per platform. Windows posts `WM_CLOSE` to the visible
//! top-level windows, a request a GUI can answer by saving first. POSIX has no
//! such signal: SIGTERM is the ask and SIGKILL the escalation, on the same two
//! windows, and nothing here pretends a graceful close happened.

#[cfg(unix)]
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
#[cfg(windows)]
use windows::core::HRESULT;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WAIT_OBJECT_0, WPARAM};
#[cfg(windows)]
use windows::Win32::System::Threading::{
  OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
  PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
  EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
};

/// Grace period after the close request, matching `graceful_terminate(timeout=5)`.
pub const DEFAULT_GRACEFUL_TIMEOUT: Duration = Duration::from_secs(5);

/// Time allowed for the process to disappear after the forced kill, matching the
/// Python `proc.wait(timeout=3)`.
const TERMINATE_TIMEOUT: Duration = Duration::from_secs(3);

/// Exit code reported for a forced kill.
#[cfg(windows)]
const KILL_EXIT_CODE: u32 = 1;

/// Windows error raised by `OpenProcess` for a PID that no longer exists.
#[cfg(windows)]
const ERROR_INVALID_PARAMETER: u32 = 87;

/// The separator compare keys carry — the one this platform's own paths use.
#[cfg(windows)]
const KEY_SEPARATOR: char = '\\';
#[cfg(unix)]
const KEY_SEPARATOR: char = '/';

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminateMethod {
  /// The PID was already gone.
  NotFound,
  /// The process exited on its own after `WM_CLOSE`.
  #[cfg(windows)]
  WmClose,
  /// The process shut itself down on SIGTERM.
  #[cfg(unix)]
  Signaled,
  /// The process had to be terminated.
  Terminated,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateOutcome {
  pub method: TerminateMethod,
  /// Time spent waiting for the process to exit.
  pub waited_ms: u64,
  /// Number of top-level windows that were sent `WM_CLOSE`. Always 0 off
  /// Windows, which has no such request to make.
  pub windows_closed: usize,
  /// Image path the identity check matched against, when the process existed.
  pub image_path: Option<String>,
}

/// Terminate `pid`, but only if it is still running `expected_exe` (a full
/// path, compared whole, or a bare file name). A mismatch is an error, not a
/// no-op: the UI's process table is stale and the operator must know.
#[cfg(windows)]
pub fn terminate_pid(
  pid: u32,
  expected_exe: &str,
  graceful_timeout: Duration,
) -> Result<TerminateOutcome, String> {
  if pid == 0 {
    return Err("pid 0 is not a terminable process".to_string());
  }
  if expected_exe.trim().is_empty() {
    return Err("an expected executable is required to terminate a process".to_string());
  }

  let handle = match open_process(pid) {
    Ok(handle) => handle,
    Err(error) if error.code() == HRESULT::from_win32(ERROR_INVALID_PARAMETER) => {
      return Ok(TerminateOutcome {
        method: TerminateMethod::NotFound,
        waited_ms: 0,
        windows_closed: 0,
        image_path: None,
      })
    }
    Err(error) => return Err(format!("could not open process {pid}: {error}")),
  };
  let handle = OwnedHandle(handle);

  let image_path = image_path(handle.0)
    .map_err(|error| format!("could not read the image path of process {pid}: {error}"))?;
  if !image_matches(&image_path, expected_exe) {
    return Err(format!(
      "pid {pid} is running {image_path}, not {expected_exe} — refusing to terminate it"
    ));
  }

  let started = Instant::now();
  let windows = top_level_windows(pid);
  for window in &windows {
    // SAFETY: `window` came straight from EnumWindows; posting to a window that
    // has since closed simply fails, which we ignore exactly as Python does.
    unsafe {
      let _ = PostMessageW(Some(*window), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
  }

  if !windows.is_empty() && wait_for_exit(handle.0, graceful_timeout) {
    return Ok(TerminateOutcome {
      method: TerminateMethod::WmClose,
      waited_ms: started.elapsed().as_millis() as u64,
      windows_closed: windows.len(),
      image_path: Some(image_path),
    });
  }

  // SAFETY: the handle was opened with PROCESS_TERMINATE.
  unsafe { TerminateProcess(handle.0, KILL_EXIT_CODE) }
    .map_err(|error| format!("could not terminate process {pid}: {error}"))?;

  if !wait_for_exit(handle.0, TERMINATE_TIMEOUT) {
    return Err(format!(
      "process {pid} did not exit within {}s of being terminated",
      TERMINATE_TIMEOUT.as_secs()
    ));
  }

  Ok(TerminateOutcome {
    method: TerminateMethod::Terminated,
    waited_ms: started.elapsed().as_millis() as u64,
    windows_closed: windows.len(),
    image_path: Some(image_path),
  })
}

/// Whether a running image is the one the operator configured. A bare name
/// matches the file name alone; anything with a separator must match the whole
/// path.
pub fn image_matches(actual: &str, expected: &str) -> bool {
  let actual_key = normalize(actual);
  let expected_key = normalize(expected);
  if expected_key.is_empty() {
    return false;
  }

  if expected_key.contains(KEY_SEPARATOR) {
    #[cfg(target_os = "macos")]
    {
      if is_bundle_executable(&actual_key, &expected_key) {
        return true;
      }
    }
    actual_key == expected_key
  } else {
    file_name(&actual_key) == expected_key
  }
}

/// Case- and separator-insensitive, because Windows paths are and config
/// entries are operator-typed.
#[cfg(windows)]
fn normalize(value: &str) -> String {
  value
    .trim()
    .trim_matches('"')
    .replace('/', "\\")
    .to_lowercase()
}

/// The path itself. POSIX file systems are case-sensitive and have one
/// separator: folding case here would let a stop aimed at `/opt/Player` land on
/// `/opt/player`, which is a different program.
#[cfg(unix)]
fn normalize(value: &str) -> String {
  value.trim().trim_matches('"').to_string()
}

fn file_name(normalized: &str) -> &str {
  normalized.rsplit(KEY_SEPARATOR).next().unwrap_or(normalized)
}

/// Handle wrapper so every early return closes the process handle.
#[cfg(windows)]
struct OwnedHandle(HANDLE);

#[cfg(windows)]
impl Drop for OwnedHandle {
  fn drop(&mut self) {
    // SAFETY: the handle came from OpenProcess and is closed exactly once.
    unsafe {
      let _ = CloseHandle(self.0);
    }
  }
}

#[cfg(windows)]
fn open_process(pid: u32) -> windows::core::Result<HANDLE> {
  // SAFETY: OpenProcess either returns a valid handle or an error.
  unsafe {
    OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
      false,
      pid,
    )
  }
}

#[cfg(windows)]
fn image_path(handle: HANDLE) -> windows::core::Result<String> {
  let mut buffer = vec![0u16; 32_768];
  let mut length = buffer.len() as u32;
  // SAFETY: `buffer` outlives the call and `length` describes its capacity;
  // the call writes at most `length` code units and updates it to the length
  // actually written.
  unsafe {
    QueryFullProcessImageNameW(
      handle,
      PROCESS_NAME_WIN32,
      windows::core::PWSTR(buffer.as_mut_ptr()),
      &mut length,
    )?;
  }
  buffer.truncate(length as usize);
  Ok(String::from_utf16_lossy(&buffer))
}

#[cfg(windows)]
fn wait_for_exit(handle: HANDLE, timeout: Duration) -> bool {
  // SAFETY: the handle was opened with PROCESS_SYNCHRONIZE.
  let result = unsafe { WaitForSingleObject(handle, timeout.as_millis() as u32) };
  result == WAIT_OBJECT_0
}

/// Visible top-level windows owned by `pid`, mirroring
/// `shared_utils.find_windows_by_pid`.
#[cfg(windows)]
fn top_level_windows(pid: u32) -> Vec<HWND> {
  struct Search {
    pid: u32,
    windows: Vec<HWND>,
  }

  unsafe extern "system" fn callback(window: HWND, param: LPARAM) -> windows::core::BOOL {
    // SAFETY: `param` is the &mut Search we passed to EnumWindows, alive for
    // the duration of the enumeration.
    let search = unsafe { &mut *(param.0 as *mut Search) };
    let mut owner = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut owner)) };
    if owner == search.pid && unsafe { IsWindowVisible(window) }.as_bool() {
      search.windows.push(window);
    }
    true.into()
  }

  let mut search = Search {
    pid,
    windows: Vec::new(),
  };
  // SAFETY: the callback matches the WNDENUMPROC signature and `search` is
  // borrowed for the whole call.
  unsafe {
    let _ = EnumWindows(Some(callback), LPARAM(&mut search as *mut Search as isize));
  }
  search.windows
}

/// How often a stop looks to see whether the process has gone. The Windows arm
/// gets this from `WaitForSingleObject`; there is no handle to wait on here.
#[cfg(unix)]
const EXIT_POLL: Duration = Duration::from_millis(20);

/// Largest pid that can be signalled. Anything above it would wrap negative in
/// `kill(2)` and become a **process group**, and the pids reaching here come out
/// of `app_states.json` — a file the service writes and the operator can edit.
#[cfg(unix)]
const MAX_PID: u32 = i32::MAX as u32;

/// Why the image behind a pid could not be read.
#[cfg(unix)]
enum ImageError {
  /// No such process — it exited, or never ran.
  Gone,
  /// It is running, but not as this user.
  Refused(String),
}

/// Terminate `pid`, but only if it is still running `expected_exe` (a full path,
/// compared whole, or a bare file name). A mismatch is an error, not a no-op:
/// the UI's process table is stale and the operator must know.
///
/// SIGTERM first, on the same grace window the Windows arm gives `WM_CLOSE`,
/// then SIGKILL. There is no `WM_CLOSE` analogue — no POSIX signal asks a GUI to
/// put its documents away — so nothing here claims a graceful close: the outcome
/// is `signaled` when SIGTERM was enough, and `windows_closed` is always 0.
#[cfg(unix)]
pub fn terminate_pid(
  pid: u32,
  expected_exe: &str,
  graceful_timeout: Duration,
) -> Result<TerminateOutcome, String> {
  if pid == 0 {
    // Not merely useless here: `kill(0, …)` signals this process's whole group.
    return Err("pid 0 is not a terminable process".to_string());
  }
  if pid > MAX_PID {
    return Err(format!("pid {pid} is not a process id"));
  }
  if expected_exe.trim().is_empty() {
    return Err("an expected executable is required to terminate a process".to_string());
  }

  let image_path = match image_path(pid) {
    Ok(path) => path,
    Err(ImageError::Gone) => {
      return Ok(TerminateOutcome {
        method: TerminateMethod::NotFound,
        waited_ms: 0,
        windows_closed: 0,
        image_path: None,
      })
    }
    Err(ImageError::Refused(why)) => {
      return Err(format!("could not read the image path of process {pid}: {why}"))
    }
  };
  if !image_matches(&image_path, expected_exe) {
    return Err(format!(
      "pid {pid} is running {image_path}, not {expected_exe} — refusing to terminate it"
    ));
  }

  let started = Instant::now();
  match signal(pid, libc::SIGTERM) {
    Ok(()) => {}
    Err(ImageError::Gone) => {
      // It exited between the identity check and the signal: nothing here
      // stopped it, and reporting otherwise would mark a crash as intentional.
      return Ok(TerminateOutcome {
        method: TerminateMethod::NotFound,
        waited_ms: started.elapsed().as_millis() as u64,
        windows_closed: 0,
        image_path: Some(image_path),
      });
    }
    Err(ImageError::Refused(why)) => {
      return Err(format!("could not stop process {pid}: {why}"))
    }
  }

  if wait_for_exit(pid, graceful_timeout) {
    return Ok(TerminateOutcome {
      method: TerminateMethod::Signaled,
      waited_ms: started.elapsed().as_millis() as u64,
      windows_closed: 0,
      image_path: Some(image_path),
    });
  }

  // The grace window is where a pid can be recycled: the process we asked to
  // stop exits, the kernel hands its number to something else, and a SIGKILL
  // aimed at the first lands on the second. The Windows arm is held open by its
  // handle; here the identity check is simply made again, at the moment it
  // matters.
  if !still_the_same(pid, expected_exe) {
    return Ok(TerminateOutcome {
      method: TerminateMethod::Signaled,
      waited_ms: started.elapsed().as_millis() as u64,
      windows_closed: 0,
      image_path: Some(image_path),
    });
  }

  match signal(pid, libc::SIGKILL) {
    Ok(()) | Err(ImageError::Gone) => {}
    Err(ImageError::Refused(why)) => {
      return Err(format!("could not terminate process {pid}: {why}"))
    }
  }

  if !wait_for_exit(pid, TERMINATE_TIMEOUT) {
    return Err(format!(
      "process {pid} did not exit within {}s of being terminated",
      TERMINATE_TIMEOUT.as_secs()
    ));
  }

  Ok(TerminateOutcome {
    method: TerminateMethod::Terminated,
    waited_ms: started.elapsed().as_millis() as u64,
    windows_closed: 0,
    image_path: Some(image_path),
  })
}

/// Whether `pid` is still the process we were asked to stop.
#[cfg(unix)]
fn still_the_same(pid: u32, expected_exe: &str) -> bool {
  match image_path(pid) {
    Ok(image) => image_matches(&image, expected_exe),
    // Unreadable now is not a licence to escalate to SIGKILL.
    Err(_) => false,
  }
}

/// Send one signal, telling a process that has gone apart from one we may not
/// touch.
#[cfg(unix)]
fn signal(pid: u32, number: libc::c_int) -> Result<(), ImageError> {
  // SAFETY: `pid` is a positive process id inside `pid_t` (checked by the
  // caller), so this can only ever reach one process.
  if unsafe { libc::kill(pid as libc::pid_t, number) } == 0 {
    return Ok(());
  }
  let error = std::io::Error::last_os_error();
  if error.raw_os_error() == Some(libc::ESRCH) {
    return Err(ImageError::Gone);
  }
  Err(ImageError::Refused(error.to_string()))
}

/// Poll until the process is gone or `timeout` runs out.
///
/// Two ways of being gone, because a pid outlives its process: one nobody has
/// reaped yet still takes a signal without error, and only the loss of its image
/// says it has actually exited. The app's own children are the case that reaches
/// this — a managed process belongs to the daemon and vanishes outright.
#[cfg(unix)]
fn wait_for_exit(pid: u32, timeout: Duration) -> bool {
  let deadline = Instant::now() + timeout;
  loop {
    if matches!(signal(pid, 0), Err(ImageError::Gone))
      || matches!(image_path(pid), Err(ImageError::Gone))
    {
      return true;
    }
    if Instant::now() >= deadline {
      return false;
    }
    thread::sleep(EXIT_POLL);
  }
}

/// The executable behind a pid, read from `/proc`.
///
/// A binary replaced under a running process — every agent self-update — leaves
/// the kernel's link reading `… (deleted)`, which is the same program and must
/// still match what the operator configured.
#[cfg(all(unix, not(target_os = "macos")))]
fn image_path(pid: u32) -> Result<String, ImageError> {
  const DELETED: &str = " (deleted)";

  match std::fs::read_link(format!("/proc/{pid}/exe")) {
    Ok(path) => {
      let image = path.to_string_lossy().into_owned();
      Ok(match image.strip_suffix(DELETED) {
        Some(live) => live.to_string(),
        None => image,
      })
    }
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(ImageError::Gone),
    Err(error) => Err(ImageError::Refused(error.to_string())),
  }
}

/// The executable behind a pid, from the kernel's own record of it.
#[cfg(target_os = "macos")]
fn image_path(pid: u32) -> Result<String, ImageError> {
  /// `PROC_PIDPATHINFO_MAXSIZE`: four times `MAXPATHLEN`, which is what
  /// `proc_pidpath` documents as the buffer it needs.
  const PATH_MAX_SIZE: usize = 4 * 1024;

  let mut buffer = vec![0u8; PATH_MAX_SIZE];
  // SAFETY: the buffer outlives the call and its length is passed with it; the
  // call writes at most that many bytes and returns how many it wrote.
  let written = unsafe {
    libc::proc_pidpath(
      pid as libc::c_int,
      buffer.as_mut_ptr() as *mut libc::c_void,
      buffer.len() as u32,
    )
  };
  if written <= 0 {
    let error = std::io::Error::last_os_error();
    return match error.raw_os_error() {
      Some(libc::ESRCH) => Err(ImageError::Gone),
      _ => Err(ImageError::Refused(error.to_string())),
    };
  }
  buffer.truncate(written as usize);
  Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Whether `actual` is the executable inside the `.app` bundle at `expected`.
///
/// A managed macOS process is configured as its bundle (`/Applications/Foo.app`)
/// and runs as the binary inside it — `osadapter.darwin` resolves
/// `Contents/MacOS/<CFBundleExecutable>` before the spawn (decision 4) — so
/// comparing whole paths alone would refuse to stop every bundled app on the
/// machine.
#[cfg(target_os = "macos")]
fn is_bundle_executable(actual: &str, expected: &str) -> bool {
  expected.ends_with(".app") && actual.starts_with(&format!("{expected}/Contents/MacOS/"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  #[cfg(windows)]
  fn a_full_path_must_match_in_full() {
    let actual = "C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe";
    assert!(image_matches(actual, actual));
    assert!(image_matches(
      actual,
      "c:/program files/derivative/touchdesigner/bin/touchdesigner.exe"
    ));
    assert!(!image_matches(
      actual,
      "C:\\Program Files\\Derivative\\TouchDesigner.2023\\bin\\TouchDesigner.exe"
    ));
  }

  #[test]
  #[cfg(windows)]
  fn a_bare_name_matches_on_the_file_name() {
    let actual = "C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe";
    assert!(image_matches(actual, "TouchDesigner.exe"));
    assert!(image_matches(actual, "touchdesigner.exe"));
    assert!(!image_matches(actual, "notepad.exe"));
  }

  #[test]
  #[cfg(windows)]
  fn quoted_and_padded_values_are_tolerated() {
    let actual = "C:\\apps\\player\\player.exe";
    assert!(image_matches(
      actual,
      "  \"C:\\apps\\player\\player.exe\"  "
    ));
  }

  #[test]
  fn an_empty_expectation_never_matches() {
    assert!(!image_matches("C:\\apps\\player\\player.exe", "   "));
  }

  #[test]
  #[cfg(windows)]
  fn a_prefix_of_the_file_name_does_not_match() {
    // Guards against a substring check sneaking in: "player.exe" must not be
    // satisfied by "mediaplayer.exe".
    assert!(!image_matches("C:\\apps\\mediaplayer.exe", "player.exe"));
  }

  #[test]
  fn rejects_pid_zero_and_a_blank_expectation() {
    assert!(terminate_pid(0, "player.exe", DEFAULT_GRACEFUL_TIMEOUT).is_err());
    assert!(terminate_pid(4, "  ", DEFAULT_GRACEFUL_TIMEOUT).is_err());
  }

  #[test]
  #[cfg(windows)]
  fn an_unused_pid_reports_not_found() {
    // Odd PIDs above the practical range: Windows allocates PIDs in multiples
    // of four, so this can never name a live process.
    let outcome = terminate_pid(0x7FFF_FFFD, "player.exe", DEFAULT_GRACEFUL_TIMEOUT)
      .expect("a missing pid is not an error");
    assert_eq!(outcome.method, TerminateMethod::NotFound);
    assert!(outcome.image_path.is_none());
  }

  #[test]
  fn refuses_a_pid_whose_image_does_not_match() {
    // Our own process is guaranteed to exist and is not "definitely-not-owlette.exe".
    let error = terminate_pid(
      std::process::id(),
      "definitely-not-owlette.exe",
      DEFAULT_GRACEFUL_TIMEOUT,
    )
    .expect_err("identity check should refuse");
    assert!(
      error.contains("refusing to terminate"),
      "unexpected: {error}"
    );
  }

  #[test]
  fn the_identity_check_reads_the_live_image_path() {
    // The error must name what QueryFullProcessImageNameW reported, not what
    // the caller passed.
    let current = std::env::current_exe().expect("current exe");
    let image = current.to_string_lossy().into_owned();
    let error = terminate_pid(
      std::process::id(),
      "definitely-not-owlette.exe",
      Duration::ZERO,
    )
    .expect_err("identity check should refuse");
    assert!(
      error.to_lowercase().contains(&image.to_lowercase()),
      "error should name the live image path, got: {error}"
    );
  }
}

#[cfg(all(test, unix))]
mod posix_tests {
  use super::*;
  use std::process::Command;

  /// Run `body` against a live process of its own, and leave none behind.
  ///
  /// The pid is handed over only once the kernel reports it running its own
  /// image, which is what the identity check reads: between the fork and the
  /// exec it still names this test binary.
  fn with_process<R>(argv: &[&str], body: impl FnOnce(u32, &str) -> R) -> R {
    let (program, arguments) = argv.split_first().expect("a command");
    let mut child = Command::new(program)
      .args(arguments)
      .spawn()
      .expect("spawn a process to stop");
    let own = file_name(&std::env::current_exe().expect("test exe").to_string_lossy()).to_string();

    let deadline = Instant::now() + Duration::from_secs(5);
    let image = loop {
      match image_path(child.id()) {
        Ok(image) if file_name(&image) != own => break image,
        _ => {}
      }
      assert!(Instant::now() < deadline, "{program} never came up");
      thread::sleep(Duration::from_millis(10));
    };

    let outcome = body(child.id(), &image);
    let _ = signal(child.id(), libc::SIGKILL);
    let _ = child.wait();
    outcome
  }

  #[test]
  fn a_full_path_must_match_in_full() {
    let actual = "/opt/exhibit/bin/player";
    assert!(image_matches(actual, actual));
    assert!(image_matches(actual, "  \"/opt/exhibit/bin/player\"  "));
    assert!(!image_matches(actual, "/opt/exhibit/bin/player2"));
    assert!(!image_matches(actual, "/opt/exhibit2/bin/player"));
  }

  #[test]
  fn a_bare_name_matches_on_the_file_name() {
    let actual = "/opt/exhibit/bin/player";
    assert!(image_matches(actual, "player"));
    // Negative control for the Windows arm's lowercasing: POSIX file systems
    // are case-sensitive, and these are two different programs.
    assert!(!image_matches(actual, "Player"));
    assert!(!image_matches("/opt/exhibit/bin/Player", "player"));
    assert!(!image_matches(actual, "mediaplayer"));
  }

  #[test]
  fn a_prefix_of_the_file_name_does_not_match() {
    assert!(!image_matches("/opt/exhibit/mediaplayer", "player"));
    assert!(!image_matches("/opt/exhibit/player", "/opt/exhibit"));
  }

  #[test]
  fn a_pid_outside_the_signalable_range_is_refused() {
    // The negative control that matters: `kill(2)` reads a negative pid as a
    // process group, so a wrapped one would signal every process in it.
    let error = terminate_pid(MAX_PID + 1, "player", DEFAULT_GRACEFUL_TIMEOUT)
      .expect_err("an out-of-range pid is not a process");
    assert!(error.contains("not a process id"), "unexpected: {error}");
    assert!(terminate_pid(0, "player", DEFAULT_GRACEFUL_TIMEOUT).is_err());
  }

  #[test]
  fn an_unused_pid_reports_not_found() {
    // Above every `pid_max`, so it can never name a live process.
    let outcome = terminate_pid(MAX_PID, "player", DEFAULT_GRACEFUL_TIMEOUT)
      .expect("a missing pid is not an error");
    assert_eq!(outcome.method, TerminateMethod::NotFound);
    assert!(outcome.image_path.is_none());
  }

  #[test]
  fn sigterm_is_enough_for_a_process_that_takes_it() {
    with_process(&["sleep", "30"], |pid, image| {
      let outcome = terminate_pid(pid, file_name(image), Duration::from_secs(5))
        .expect("the process should stop");

      assert_eq!(outcome.method, TerminateMethod::Signaled);
      // There is no WM_CLOSE analogue, and claiming one would be a lie the UI
      // repeats back to the operator.
      assert_eq!(outcome.windows_closed, 0);
      assert_eq!(outcome.image_path.as_deref(), Some(image));
    });
  }

  #[test]
  fn a_process_that_ignores_sigterm_is_killed() {
    // A loop rather than one `sleep 30`: a shell given a single command execs
    // it and loses the trap with itself, which would stop on SIGTERM like
    // anything else and never reach the escalation this pins. The marker is
    // how the test knows the trap is installed — the pid exists from the exec,
    // which is a few milliseconds before the shell has read its script.
    let ready = std::env::temp_dir().join(format!(
      "owlette-trap-{}-{}",
      std::process::id(),
      Instant::now().elapsed().as_nanos()
    ));
    let _ = std::fs::remove_file(&ready);
    let script = format!(
      "trap '' TERM; : > {}; while :; do sleep 1; done",
      ready.display()
    );

    with_process(&["sh", "-c", script.as_str()], |pid, image| {
      let deadline = Instant::now() + Duration::from_secs(5);
      while !ready.exists() {
        assert!(Instant::now() < deadline, "the trap was never installed");
        thread::sleep(Duration::from_millis(10));
      }

      let outcome = terminate_pid(pid, file_name(image), Duration::from_millis(300))
        .expect("the process should be killed");

      assert_eq!(outcome.method, TerminateMethod::Terminated);
      assert!(outcome.waited_ms >= 300, "escalated early: {outcome:?}");
    });
    let _ = std::fs::remove_file(&ready);
  }

  #[test]
  fn a_live_pid_running_something_else_is_refused() {
    with_process(&["sleep", "30"], |pid, image| {
      let error = terminate_pid(pid, "definitely-not-owlette", DEFAULT_GRACEFUL_TIMEOUT)
        .expect_err("the identity check should refuse");

      assert!(error.contains("refusing to terminate"), "unexpected: {error}");
      assert!(error.contains(image), "unexpected: {error}");
      // And it is still running, which is the point of refusing.
      assert!(matches!(signal(pid, 0), Ok(())));
    });
  }
}
