//! Graceful termination of a supervised process.
//!
//! Mirrors `shared_utils.graceful_terminate` (`agent/src/shared_utils.py`):
//! `WM_CLOSE` the visible top-level windows, wait, then terminate. Adds an
//! identity check — the frontend's PID comes from `app_states.json` and the
//! service may have replaced the process since, so confirm the PID still runs
//! the expected executable before touching it.

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

/// Grace period after `WM_CLOSE`, matching `graceful_terminate(timeout=5)`.
pub const DEFAULT_GRACEFUL_TIMEOUT: Duration = Duration::from_secs(5);

/// Time allowed for the process to disappear after `TerminateProcess`, matching
/// the Python `proc.wait(timeout=3)`.
const TERMINATE_TIMEOUT: Duration = Duration::from_secs(3);

/// Exit code reported for a forced kill.
#[cfg(windows)]
const KILL_EXIT_CODE: u32 = 1;
/// How often a signalled process is checked for having gone.
#[cfg(unix)]
const EXIT_POLL: Duration = Duration::from_millis(50);

/// Windows error raised by `OpenProcess` for a PID that no longer exists.
#[cfg(windows)]
const ERROR_INVALID_PARAMETER: u32 = 87;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminateMethod {
  /// The PID was already gone.
  NotFound,
  /// The process exited on its own after `WM_CLOSE`.
  #[cfg(windows)]
  WmClose,
  /// The process had to be terminated.
  Terminated,
  /// posix: the process left on SIGTERM, before SIGKILL was needed.
  #[cfg(unix)]
  Signaled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateOutcome {
  pub method: TerminateMethod,
  /// Time spent waiting for the process to exit.
  pub waited_ms: u64,
  /// Number of top-level windows that were sent `WM_CLOSE`.
  pub windows_closed: usize,
  /// Image path the identity check matched against, when the process existed.
  pub image_path: Option<String>,
}

/// Terminate `pid`, but only if it is still running `expected_exe` (a full
/// path, compared whole, or a bare file name). A mismatch is an error, not a
/// no-op: the UI's process table is stale and the operator must know.
#[cfg(unix)]
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
  let target = pid as libc::pid_t;
  if !alive(target) {
    return Ok(TerminateOutcome {
      method: TerminateMethod::NotFound,
      waited_ms: 0,
      windows_closed: 0,
      image_path: None,
    });
  }
  let image_path = image_of(pid)?;
  if !image_matches(&image_path, expected_exe) {
    return Err(format!(
      "pid {pid} is running {image_path}, not {expected_exe} — refusing to terminate it"
    ));
  }

  let started = Instant::now();
  // SIGTERM is the posix WM_CLOSE: the process gets its graceful window.
  signal(target, libc::SIGTERM)?;
  if wait_gone(target, graceful_timeout) {
    return Ok(TerminateOutcome {
      method: TerminateMethod::Signaled,
      waited_ms: started.elapsed().as_millis() as u64,
      windows_closed: 0,
      image_path: Some(image_path),
    });
  }
  signal(target, libc::SIGKILL)?;
  if !wait_gone(target, TERMINATE_TIMEOUT) {
    return Err(format!(
      "process {pid} did not exit within {}s of being killed",
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

/// kill(2) with signal 0 asks without sending: the process exists when the
/// answer is success or EPERM (it exists, it is somebody else's).
#[cfg(unix)]
fn alive(pid: libc::pid_t) -> bool {
  // SAFETY: kill with signal 0 sends nothing.
  let rc = unsafe { libc::kill(pid, 0) };
  rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn signal(pid: libc::pid_t, signal: libc::c_int) -> Result<(), String> {
  // SAFETY: a plain kill(2); the pid was checked to exist and to run the expected image.
  if unsafe { libc::kill(pid, signal) } == 0 {
    return Ok(());
  }
  let error = std::io::Error::last_os_error();
  if error.raw_os_error() == Some(libc::ESRCH) {
    return Ok(());
  }
  Err(format!("could not signal process {pid}: {error}"))
}

#[cfg(unix)]
fn wait_gone(pid: libc::pid_t, timeout: Duration) -> bool {
  let deadline = Instant::now() + timeout;
  while alive(pid) {
    if Instant::now() >= deadline {
      return false;
    }
    std::thread::sleep(EXIT_POLL);
  }
  true
}

/// The executable behind a pid: `/proc/<pid>/exe` on linux, `ps` where there
/// is no procfs.
#[cfg(all(unix, target_os = "linux"))]
fn image_of(pid: u32) -> Result<String, String> {
  std::fs::read_link(format!("/proc/{pid}/exe"))
    .map(|path| path.to_string_lossy().into_owned())
    .map_err(|error| format!("could not read the image path of process {pid}: {error}"))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn image_of(pid: u32) -> Result<String, String> {
  let output = std::process::Command::new("ps")
    .args(["-o", "comm=", "-p", &pid.to_string()])
    .output()
    .map_err(|error| format!("could not read the image path of process {pid}: {error}"))?;
  let image = String::from_utf8_lossy(&output.stdout).trim().to_string();
  if image.is_empty() {
    return Err(format!("could not read the image path of process {pid}"));
  }
  Ok(image)
}

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

/// Case- and separator-insensitive because config entries are operator-typed.
/// A bare name matches the file name alone; anything with a separator must
/// match the whole path.
pub fn image_matches(actual: &str, expected: &str) -> bool {
  let actual_key = normalize(actual);
  let expected_key = normalize(expected);
  if expected_key.is_empty() {
    return false;
  }

  if expected_key.contains('\\') {
    actual_key == expected_key
  } else {
    file_name(&actual_key) == expected_key
  }
}

fn normalize(value: &str) -> String {
  value
    .trim()
    .trim_matches('"')
    .replace('/', "\\")
    .to_lowercase()
}

fn file_name(normalized: &str) -> &str {
  normalized.rsplit('\\').next().unwrap_or(normalized)
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
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
  fn a_bare_name_matches_on_the_file_name() {
    let actual = "C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe";
    assert!(image_matches(actual, "TouchDesigner.exe"));
    assert!(image_matches(actual, "touchdesigner.exe"));
    assert!(!image_matches(actual, "notepad.exe"));
  }

  #[test]
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
