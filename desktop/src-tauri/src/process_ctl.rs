//! Graceful termination of a supervised process.
//!
//! Mirrors `shared_utils.graceful_terminate` (`agent/src/shared_utils.py`):
//! `WM_CLOSE` the visible top-level windows, wait, then terminate. Adds an
//! identity check — the frontend's PID comes from `app_states.json` and the
//! service may have replaced the process since, so confirm the PID still runs
//! the expected executable before touching it and, where its row records one,
//! is still the very process the service recorded (`shared_utils.identity_matches`).

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
#[cfg(windows)]
use windows::core::{HRESULT, HSTRING};
#[cfg(windows)]
use windows::Win32::Foundation::{
  CloseHandle, FILETIME, HANDLE, HWND, LPARAM, WAIT_OBJECT_0, WPARAM,
};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::QueryDosDeviceW;
#[cfg(windows)]
use windows::Win32::System::Threading::{
  GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
  PROCESS_NAME_FORMAT, PROCESS_NAME_NATIVE, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
  PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
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

/// 1601-01-01 to 1970-01-01 in `FILETIME`'s 100 ns ticks.
#[cfg(windows)]
const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

/// what a refusal on the service's record says: the only refusal the desktop
/// walks past to an older row (`RECORD_MISMATCH` in `processControl.ts`).
#[cfg(windows)]
const RECORD_MISMATCH: &str = "is no longer the process the service recorded";

/// what the service recorded about the process it bound to a pid, at launch or
/// adoption (`read_process_identity` in `agent/src/shared_utils.py`), as that
/// pid's `app_states.json` row carries it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
// posix carries the record but does not check it: see its `terminate_pid`
#[cfg_attr(not(windows), allow(dead_code))]
pub struct RecordedIdentity {
  /// psutil's `create_time`, unix seconds.
  pub create_time: f64,
  /// psutil's `exe` as the service stores it; none or empty checks the
  /// creation time alone, as `identity_matches` does.
  pub exe: Option<String>,
}

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
// `_recorded` is not checked here: psutil's posix creation time (boot time plus
// clock ticks on linux, a sysctl timeval on macos) is not read the same way in
// this process, so the name check stands alone, as it did before.
#[cfg(unix)]
pub fn terminate_pid(
  pid: u32,
  expected_exe: &str,
  _recorded: Option<&RecordedIdentity>,
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

/// Terminate `pid`, but only if it is still running `expected_exe` and, when
/// `recorded` is given, is still that very process: a name alone cannot tell a
/// recycled pid from another instance of the same exe, or of `cmd.exe`.
#[cfg(windows)]
pub fn terminate_pid(
  pid: u32,
  expected_exe: &str,
  recorded: Option<&RecordedIdentity>,
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

  if let Some(recorded) = recorded {
    let (created, exe) = live_identity(handle.0)
      .map_err(|error| format!("could not read the identity of process {pid}: {error}"))?;
    if !record_matches(recorded, created, &exe) {
      return Err(format!(
        "pid {pid} {RECORD_MISMATCH} — refusing to terminate it"
      ));
    }
  }

  let image_path = image_path(handle.0, PROCESS_NAME_WIN32)
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
/// match the whole path. A macOS `.app` bundle is a directory, so it matches
/// the image running from its `Contents/MacOS`.
pub fn image_matches(actual: &str, expected: &str) -> bool {
  let actual_key = normalize(actual);
  let expected_key = normalize(expected);
  if expected_key.is_empty() {
    return false;
  }

  let whole = if expected_key.contains('\\') {
    actual_key == expected_key
  } else {
    file_name(&actual_key) == expected_key
  };
  whole || inside_bundle(&actual_key, &expected_key)
}

fn inside_bundle(actual_key: &str, expected_key: &str) -> bool {
  let bundle = expected_key.trim_end_matches('\\');
  if !bundle.ends_with(".app") {
    return false;
  }
  let binaries = format!("{bundle}\\contents\\macos\\");
  if bundle.contains('\\') {
    actual_key.starts_with(&binaries)
  } else {
    // a bare name is a whole path component, never the tail of a longer one
    actual_key.contains(&format!("\\{binaries}"))
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
fn image_path(handle: HANDLE, format: PROCESS_NAME_FORMAT) -> windows::core::Result<String> {
  let mut buffer = vec![0u16; 32_768];
  let mut length = buffer.len() as u32;
  // SAFETY: `buffer` outlives the call and `length` describes its capacity;
  // the call writes at most `length` code units and updates it to the length
  // actually written.
  unsafe {
    QueryFullProcessImageNameW(
      handle,
      format,
      windows::core::PWSTR(buffer.as_mut_ptr()),
      &mut length,
    )?;
  }
  buffer.truncate(length as usize);
  Ok(String::from_utf16_lossy(&buffer))
}

/// the creation time and image as psutil's `create_time()` and `exe()` report
/// them, which is what the service records.
#[cfg(windows)]
fn live_identity(handle: HANDLE) -> windows::core::Result<(f64, String)> {
  let mut created = FILETIME::default();
  let mut exited = FILETIME::default();
  let mut kernel = FILETIME::default();
  let mut user = FILETIME::default();
  // SAFETY: four live out-pointers, and the handle has
  // PROCESS_QUERY_LIMITED_INFORMATION.
  unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)? };
  let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
  // the native name is the one the process started with; the win32 one follows
  // a later rename of the file, which psutil's does not
  let native = image_path(handle, PROCESS_NAME_NATIVE)?;
  Ok((unix_seconds(ticks), dos_path(&native, drive_target)))
}

/// the device a drive letter names, as psutil's `QueryDosDevice` reads it.
#[cfg(windows)]
fn drive_target(letter: char) -> Option<String> {
  let mut buffer = [0u16; 512];
  // SAFETY: the buffer outlives the call, which is told its length.
  let written =
    unsafe { QueryDosDeviceW(&HSTRING::from(format!("{letter}:")), Some(&mut buffer)) } as usize;
  // a list of nul-terminated names, of which the first is the device
  let first = buffer[..written].split(|unit| *unit == 0).next()?;
  (!first.is_empty()).then(|| String::from_utf16_lossy(first))
}

/// `shared_utils.identity_matches` once the pid is known to be alive: the
/// recorded creation time compared exactly, as it does (a recycled pid starts
/// later, and a tolerance would let one through), then the recorded image.
#[cfg(windows)]
fn record_matches(recorded: &RecordedIdentity, created: f64, exe: &str) -> bool {
  if created != recorded.create_time {
    return false;
  }
  match recorded.exe.as_deref() {
    Some(path) if !path.is_empty() => normalize(path) == normalize(exe),
    _ => true,
  }
}

/// psutil's `_to_unix_time`: the ticks rounded to a double, then divided. Two
/// roundings, kept, so the result is the service's `create_time` to the bit.
#[cfg(windows)]
fn unix_seconds(filetime: u64) -> f64 {
  filetime.wrapping_sub(UNIX_EPOCH_TICKS) as f64 / 10_000_000.0
}

/// psutil's `convert_dos_path`: a native image path as a drive-letter or UNC
/// path, where the first letter naming the device wins.
#[cfg(windows)]
fn dos_path(native: &str, drive_target: impl Fn(char) -> Option<String>) -> String {
  if !native.starts_with('\\') || native.starts_with("\\\\") {
    return native.to_string();
  }
  for unc in ["\\Device\\Mup\\", "\\??\\UNC\\"] {
    if let Some(rest) = native.strip_prefix(unc) {
      return format!("\\\\{rest}");
    }
  }
  if let Some(rest) = native.strip_prefix("\\??\\") {
    return rest.to_string();
  }
  let end = native
    .match_indices('\\')
    .nth(2)
    .map_or(native.len(), |(at, _)| at);
  let (device, rest) = native.split_at(end);
  match ('A'..='Z').find(|letter| drive_target(*letter).as_deref() == Some(device)) {
    Some(letter) => format!("{letter}:{rest}"),
    None => rest.to_string(),
  }
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
  fn a_mac_app_bundle_matches_the_binary_it_runs() {
    let actual = "/Applications/Kiosk.app/Contents/MacOS/Kiosk";
    assert!(image_matches(actual, "/Applications/Kiosk.app"));
    assert!(image_matches(actual, "/applications/kiosk.app/"));
    assert!(image_matches(actual, "Kiosk.app"));
  }

  #[test]
  fn a_lookalike_bundle_or_another_file_in_it_does_not_match() {
    assert!(!image_matches(
      "/Applications/Kiosk.app.evil/Contents/MacOS/Kiosk",
      "/Applications/Kiosk.app"
    ));
    assert!(!image_matches(
      "/Applications/Kiosk.app.evil/Contents/MacOS/Kiosk",
      "Kiosk.app"
    ));
    assert!(!image_matches(
      "/Applications/Other.app/Contents/MacOS/Kiosk",
      "/Applications/Kiosk.app"
    ));
    assert!(!image_matches(
      "/Applications/Other.app/Contents/MacOS/Kiosk",
      "Kiosk.app"
    ));
    assert!(!image_matches(
      "/Applications/MyKiosk.app/Contents/MacOS/Kiosk",
      "Kiosk.app"
    ));
    assert!(!image_matches(
      "/Applications/Kiosk.app/Contents/Resources/kiosk",
      "/Applications/Kiosk.app"
    ));
    assert!(!image_matches(
      "/Applications/Kiosk.app/Contents/Resources/kiosk",
      "Kiosk.app"
    ));
  }

  #[test]
  fn rejects_pid_zero_and_a_blank_expectation() {
    assert!(terminate_pid(0, "player.exe", None, DEFAULT_GRACEFUL_TIMEOUT).is_err());
    assert!(terminate_pid(4, "  ", None, DEFAULT_GRACEFUL_TIMEOUT).is_err());
  }

  #[test]
  fn an_unused_pid_reports_not_found() {
    // Odd PIDs above the practical range: Windows allocates PIDs in multiples
    // of four, so this can never name a live process.
    let outcome = terminate_pid(0x7FFF_FFFD, "player.exe", None, DEFAULT_GRACEFUL_TIMEOUT)
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
      None,
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
      None,
      Duration::ZERO,
    )
    .expect_err("identity check should refuse");
    assert!(
      error.to_lowercase().contains(&image.to_lowercase()),
      "error should name the live image path, got: {error}"
    );
  }

  #[test]
  fn a_recorded_creation_time_crosses_the_ipc_unchanged() {
    // serde_json's default float reader lands about one create_time in twenty
    // on the next double, which the exact comparison reads as another process
    let recorded: RecordedIdentity =
      serde_json::from_str(r#"{"createTime": 1788367385.5616167, "exe": null}"#).expect("a record");
    assert_eq!(recorded.create_time, 1788367385.5616167);
  }

  #[cfg(windows)]
  #[test]
  fn a_recorded_process_is_the_one_with_that_exact_creation_time() {
    let recorded = RecordedIdentity {
      create_time: 1792849191.6492915,
      exe: Some("c:\\apps\\player.exe".to_string()),
    };
    assert!(record_matches(
      &recorded,
      1792849191.6492915,
      "C:/Apps/Player.exe"
    ));
    // a recycled pid running the same exe started later
    assert!(!record_matches(
      &recorded,
      1792849251.25,
      "C:\\apps\\player.exe"
    ));
    // no tolerance, as in identity_matches
    let next = f64::from_bits(recorded.create_time.to_bits() + 1);
    assert!(!record_matches(&recorded, next, "C:\\apps\\player.exe"));
  }

  #[cfg(windows)]
  #[test]
  fn a_recorded_image_must_be_the_live_one() {
    let recorded = RecordedIdentity {
      create_time: 1792849191.5,
      exe: Some("c:\\apps\\player.exe".to_string()),
    };
    assert!(!record_matches(
      &recorded,
      1792849191.5,
      "C:\\apps\\other\\player.exe"
    ));
    for exe in [None, Some(String::new())] {
      let recorded = RecordedIdentity {
        create_time: 1792849191.5,
        exe,
      };
      assert!(record_matches(&recorded, 1792849191.5, "C:\\anything.exe"));
    }
  }

  #[cfg(windows)]
  #[test]
  fn a_creation_time_is_psutils_to_the_bit() {
    // GetProcessTimes and psutil 7.2.2 read for one process on this machine;
    // a single rounding (exact ticks / 1e7) would give 1792849191.6492918
    assert_eq!(unix_seconds(134_373_227_916_492_917), 1792849191.6492915);
  }

  #[cfg(windows)]
  #[test]
  fn a_native_image_path_reads_as_psutil_reads_it() {
    let drives = |letter: char| match letter {
      'C' => Some("\\Device\\HarddiskVolume3".to_string()),
      'D' | 'E' => Some("\\Device\\HarddiskVolume30".to_string()),
      _ => None,
    };
    assert_eq!(
      dos_path("\\Device\\HarddiskVolume3\\apps\\player.exe", drives),
      "C:\\apps\\player.exe"
    );
    // the whole device name, never a prefix of it; the first letter wins
    assert_eq!(
      dos_path("\\Device\\HarddiskVolume30\\player.exe", drives),
      "D:\\player.exe"
    );
    assert_eq!(
      dos_path("\\Device\\Mup\\server\\share\\player.exe", drives),
      "\\\\server\\share\\player.exe"
    );
    assert_eq!(
      dos_path("\\??\\UNC\\server\\share\\player.exe", drives),
      "\\\\server\\share\\player.exe"
    );
    assert_eq!(
      dos_path("\\??\\C:\\apps\\player.exe", drives),
      "C:\\apps\\player.exe"
    );
    // no letter names the device: psutil keeps the rest
    assert_eq!(
      dos_path("\\Device\\HarddiskVolume9\\player.exe", drives),
      "\\player.exe"
    );
    assert_eq!(dos_path("Registry", drives), "Registry");
  }

  #[cfg(windows)]
  #[test]
  fn the_live_identity_is_read_the_way_psutil_reads_it() {
    // opening our own process terminates nothing
    let handle = OwnedHandle(open_process(std::process::id()).expect("our own process"));
    let (created, exe) = live_identity(handle.0).expect("our own identity");
    let current = std::env::current_exe().expect("current exe");
    assert_eq!(normalize(&exe), normalize(&current.to_string_lossy()));
    let now = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .expect("a clock after 1970")
      .as_secs_f64();
    assert!(
      created <= now && created > now - 3600.0,
      "created {created}, now {now}"
    );
  }

  #[cfg(windows)]
  #[test]
  fn a_pid_that_is_not_the_recorded_process_is_refused_before_anything_else() {
    // the record is checked first, so a host that skipped it would refuse on
    // the name instead, and this fails without touching our own process. the
    // text is spelled out: the desktop's walk keys on it (processControl.ts)
    let recorded = RecordedIdentity {
      create_time: 1.5,
      exe: None,
    };
    let error = terminate_pid(
      std::process::id(),
      "definitely-not-owlette.exe",
      Some(&recorded),
      Duration::ZERO,
    )
    .expect_err("identity check should refuse");
    assert!(
      error.contains("no longer the process the service recorded — refusing to terminate"),
      "unexpected: {error}"
    );
  }
}
