//! Control and inspection of the `OwletteService` Windows service.
//!
//! Two signals decide whether owlette is really supervising this machine, and
//! the UI needs both: the SCM state, and the age of `tmp/service_status.json`
//! (rewritten on a 30 s throttle, stale past 120 s). A running-but-wedged
//! service looks alive to the SCM but stops refreshing the file.
//!
//! Start/stop go through the SCM when this process has the rights, falling back
//! to an elevated `net start` / `net stop` otherwise. The agent grants
//! INTERACTIVE `SERVICE_START | SERVICE_STOP` on the service itself
//! (`agent/src/service_acl.py`), so on a current install the SCM path is the one
//! that runs and no prompt appears; the elevated fallback is what machines
//! installed before that grant, or trimmed by policy since, still use.

use std::ffi::OsStr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use windows::core::w;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
use windows_service::service::{ServiceAccess, ServiceExitCode, ServiceStartType, ServiceState};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

/// Service name, as registered by the installer (`shared_utils.SERVICE_NAME`).
pub const SERVICE_NAME: &str = "OwletteService";

/// Age past which `service_status.json` no longer describes reality.
pub const STATUS_STALE_AFTER: Duration = Duration::from_secs(120);

/// Windows error codes we branch on.
const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
const ERROR_SERVICE_ALREADY_RUNNING: i32 = 1056;
const ERROR_SERVICE_NOT_ACTIVE: i32 = 1062;
/// Returned when the service is mid-transition — `StartPending` is the one that
/// reaches us, from a stop racing a start.
const ERROR_SERVICE_CANNOT_ACCEPT_CTRL: i32 = 1061;

/// `ShellExecuteW` returns an HINSTANCE; > 32 means the process launched.
const SHELL_EXECUTE_SUCCESS_FLOOR: isize = 32;

/// [`ServiceCommandOutcome::method`] values. `scm` and `elevated` did something;
/// the other three are refusals that are not failures, and the UI reads them.
const METHOD_SCM: &str = "scm";
const METHOD_ELEVATED: &str = "elevated";
const METHOD_NOOP: &str = "noop";
const METHOD_QUITTING: &str = "quitting";
const METHOD_NEEDS_ELEVATION: &str = "needs_elevation";

/// Set once "exit" is chosen, for the rest of the process's short life.
///
/// The frontend has its own guard — `useServiceHealth`'s auto-start latch — but
/// that one sits behind an IPC boundary that any future caller could step
/// around. This is the choke point: after [`begin_quit`], [`start`] refuses, so
/// the service the operator just asked to stop cannot come back up underneath
/// them. That mattered visibly when starts prompted; it matters more now they
/// are silent.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Refuse every subsequent [`start`]. There is no matching `end_quit` — the
/// process is on its way out.
pub fn begin_quit() {
  QUITTING.store(true, Ordering::SeqCst);
}

fn is_quitting() -> bool {
  QUITTING.load(Ordering::SeqCst)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
  /// False when the service is not registered at all (agent not installed).
  pub installed: bool,
  /// True only for `Running`.
  pub running: bool,
  /// SCM state: `running`, `stopped`, `start_pending`, ...; `unknown` when the
  /// service is not installed.
  pub state: String,
  /// SCM start type. A `disabled` service cannot be started, elevated or not.
  pub start_type: String,
  /// For a stopped service, whether it exited cleanly. `None` when it is not
  /// stopped, so the caller cannot read it as an answer to a question it did
  /// not ask.
  ///
  /// This is what separates "the operator quit owlette" from "the agent died".
  /// Both leave the SCM reporting STOPPED, and the difference lives only in the
  /// exit code — which this used to read off `query_status()` and throw away.
  /// It matters because the registration installs three restart actions
  /// (`registration.rs`), so the fourth failure inside a day leaves a
  /// crash-looping agent stopped for good, and the footer must not paint that
  /// the same colour as a deliberate quit.
  pub stopped_cleanly: Option<bool>,
  pub status_file: StatusFileInfo,
}

/// Freshness of `tmp/service_status.json` — only whether it can be trusted;
/// the document itself is read through the JSON commands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusFileInfo {
  pub exists: bool,
  /// Seconds since the file was last written, when it exists.
  pub age_secs: Option<u64>,
  /// True when the file is missing or older than [`STATUS_STALE_AFTER`].
  pub stale: bool,
}

/// Result of a start/stop request.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCommandOutcome {
  /// `scm` (issued directly), `elevated` (UAC-prompted `net` command), `noop`
  /// (already in the requested state, or mid-transition towards it), `quitting`
  /// (a start refused because the app is exiting) or `needs_elevation` (the SCM
  /// said no and the caller did not want a prompt raised).
  ///
  /// Only the last is worth telling the operator about, and it is not an error.
  pub method: String,
  /// SCM state before the request. Poll [`status`] for the result — an elevated
  /// launch only means the shell accepted it.
  pub state_before: String,
}

/// One place where an outcome is built, so `method` strings and `state_before`
/// naming cannot drift apart across the dozen return sites below.
fn outcome(method: &str, state: ServiceState) -> ServiceCommandOutcome {
  ServiceCommandOutcome {
    method: method.to_string(),
    state_before: state_name(state).to_string(),
  }
}

/// Whether [`start`] can answer without touching the SCM, and as what.
///
/// `StopPending` is in here for a specific bug: the tray's exit stops the
/// service, the window — hidden, not closed — sees "not running" and asks for a
/// start, and the operator gets a second UAC prompt on their way out. `start`
/// used to short-circuit on `Running | StartPending` only, while `stop`
/// short-circuited on `Stopped | StopPending`; that asymmetry was the hole.
pub(crate) fn start_short_circuit(state: ServiceState, quitting: bool) -> Option<&'static str> {
  if quitting {
    return Some(METHOD_QUITTING);
  }
  match state {
    ServiceState::Running | ServiceState::StartPending | ServiceState::StopPending => {
      Some(METHOD_NOOP)
    }
    _ => None,
  }
}

/// Whether [`stop`] can answer without touching the SCM. A quit must still be
/// able to stop the service, so this one has no `quitting` arm.
pub(crate) fn stop_short_circuit(state: ServiceState) -> Option<&'static str> {
  match state {
    ServiceState::Stopped | ServiceState::StopPending => Some(METHOD_NOOP),
    _ => None,
  }
}

/// True when the request actually reached the SCM. The refusals — `noop`,
/// `quitting`, `needs_elevation` — are all successful calls that changed
/// nothing, so callers must not report them as work done.
pub fn was_issued(outcome: &ServiceCommandOutcome) -> bool {
  outcome.method == METHOD_SCM || outcome.method == METHOD_ELEVATED
}

/// True when `service_status.json` is too old to describe the running service.
pub fn is_status_stale(age: Duration) -> bool {
  age > STATUS_STALE_AFTER
}

/// Freshness of the status file at `path`, evaluated against `now`.
pub fn status_file_info(path: &Path, now: SystemTime) -> StatusFileInfo {
  let modified = std::fs::metadata(path).and_then(|metadata| metadata.modified());
  match modified {
    Ok(modified) => {
      // A clock change can put mtime in the future — read that as fresh.
      let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
      StatusFileInfo {
        exists: true,
        age_secs: Some(age.as_secs()),
        stale: is_status_stale(age),
      }
    }
    Err(_) => StatusFileInfo {
      exists: false,
      age_secs: None,
      stale: true,
    },
  }
}

/// SCM state plus status-file freshness.
pub fn status(status_file: &Path) -> Result<ServiceStatus, String> {
  let status_file = status_file_info(status_file, SystemTime::now());

  let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
    .map_err(|error| format!("could not connect to the service manager: {error}"))?;

  let service = match manager.open_service(
    SERVICE_NAME,
    ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG,
  ) {
    Ok(service) => service,
    Err(error) if error_code(&error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => {
      return Ok(ServiceStatus {
        installed: false,
        running: false,
        state: "unknown".to_string(),
        start_type: "unknown".to_string(),
        stopped_cleanly: None,
        status_file,
      })
    }
    Err(error) => return Err(format!("could not open {SERVICE_NAME}: {error}")),
  };

  let query = service
    .query_status()
    .map_err(|error| format!("could not query {SERVICE_NAME}: {error}"))?;
  let state = query.current_state;

  // Only meaningful once stopped: while a service runs, `exit_code` is whatever
  // it last reported and says nothing about now.
  let stopped_cleanly = (state == ServiceState::Stopped)
    .then_some(matches!(query.exit_code, ServiceExitCode::Win32(0)));

  // Advisory only (it explains a stopped service), so don't fail status on it.
  let start_type = match service.query_config() {
    Ok(config) => start_type_name(config.start_type),
    Err(error) => {
      log::debug!("could not read {SERVICE_NAME} config: {error}");
      "unknown"
    }
  };

  Ok(ServiceStatus {
    installed: true,
    running: state == ServiceState::Running,
    state: state_name(state).to_string(),
    start_type: start_type.to_string(),
    stopped_cleanly,
    status_file,
  })
}

/// Start the service, elevating only if this process lacks the right — and only
/// if `allow_elevation` says a prompt is wanted at all.
///
/// Pass `false` for anything the operator did not ask for by hand: the service
/// spawns this app at logon, and a UAC dialog nobody requested is worse than a
/// footer that says the service needs one.
pub fn start(allow_elevation: bool) -> Result<ServiceCommandOutcome, String> {
  let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
    .map_err(|error| format!("could not connect to the service manager: {error}"))?;

  let inspector = manager
    .open_service(
      SERVICE_NAME,
      ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG,
    )
    .map_err(|error| open_error(&error))?;

  let state = inspector
    .query_status()
    .map_err(|error| format!("could not query {SERVICE_NAME}: {error}"))?
    .current_state;
  if let Some(method) = start_short_circuit(state, is_quitting()) {
    return Ok(outcome(method, state));
  }

  // `net start` fails with 1058 on a disabled service — elevating first would
  // spend a UAC prompt for nothing.
  if let Ok(config) = inspector.query_config() {
    if config.start_type == ServiceStartType::Disabled {
      return Err(format!(
        "{SERVICE_NAME} start type is disabled — enable it before starting the service"
      ));
    }
  }

  let elevate = || elevate_or_defer(allow_elevation, w!("/c net start OwletteService"), state);

  match manager.open_service(SERVICE_NAME, ServiceAccess::START) {
    Ok(service) => match service.start(&[] as &[&OsStr]) {
      Ok(()) => Ok(outcome(METHOD_SCM, state)),
      Err(error) if error_code(&error) == Some(ERROR_SERVICE_ALREADY_RUNNING) => {
        Ok(outcome(METHOD_NOOP, state))
      }
      Err(error) if error_code(&error) == Some(ERROR_ACCESS_DENIED) => elevate(),
      Err(error) => Err(format!("could not start {SERVICE_NAME}: {error}")),
    },
    Err(error) if error_code(&error) == Some(ERROR_ACCESS_DENIED) => elevate(),
    Err(error) => Err(open_error(&error)),
  }
}

/// Stop the service, elevating only if this process lacks the right — and only
/// if `allow_elevation` says a prompt is wanted at all.
pub fn stop(allow_elevation: bool) -> Result<ServiceCommandOutcome, String> {
  let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
    .map_err(|error| format!("could not connect to the service manager: {error}"))?;

  let inspector = manager
    .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
    .map_err(|error| open_error(&error))?;

  let state = inspector
    .query_status()
    .map_err(|error| format!("could not query {SERVICE_NAME}: {error}"))?
    .current_state;
  if let Some(method) = stop_short_circuit(state) {
    return Ok(outcome(method, state));
  }

  let elevate = || elevate_or_defer(allow_elevation, w!("/c net stop OwletteService"), state);

  match manager.open_service(SERVICE_NAME, ServiceAccess::STOP) {
    Ok(service) => match service.stop() {
      Ok(_) => Ok(outcome(METHOD_SCM, state)),
      Err(error) if error_code(&error) == Some(ERROR_SERVICE_NOT_ACTIVE) => {
        Ok(outcome(METHOD_NOOP, state))
      }
      Err(error) if error_code(&error) == Some(ERROR_ACCESS_DENIED) => elevate(),
      // A start that had not finished when we looked. Worth its own words: the
      // generic text would tell the operator the stop failed, which it will not
      // have if they simply try again.
      Err(error) if error_code(&error) == Some(ERROR_SERVICE_CANNOT_ACCEPT_CTRL) => Err(format!(
        "{SERVICE_NAME} is still starting and cannot be stopped yet — try again in a moment"
      )),
      Err(error) => Err(format!("could not stop {SERVICE_NAME}: {error}")),
    },
    Err(error) if error_code(&error) == Some(ERROR_ACCESS_DENIED) => elevate(),
    Err(error) => Err(open_error(&error)),
  }
}

/// Elevate, or report that elevation is the only thing missing.
///
/// `needs_elevation` is deliberately an `Ok`: nothing failed, the caller simply
/// declined to raise a prompt. The footer turns it into a hint rather than an
/// error.
fn elevate_or_defer(
  allow_elevation: bool,
  parameters: windows::core::PCWSTR,
  state: ServiceState,
) -> Result<ServiceCommandOutcome, String> {
  if !allow_elevation {
    return Ok(outcome(METHOD_NEEDS_ELEVATION, state));
  }
  elevated(parameters, state)
}

/// Elevated `net` command via the shell's `runas` verb (one UAC prompt).
/// Success means the process launched, not that the service changed state.
fn elevated(
  parameters: windows::core::PCWSTR,
  state: ServiceState,
) -> Result<ServiceCommandOutcome, String> {
  // SAFETY: every pointer argument is either null or a static wide string.
  let result = unsafe {
    ShellExecuteW(
      None,
      w!("runas"),
      w!("cmd.exe"),
      parameters,
      windows::core::PCWSTR::null(),
      SW_HIDE,
    )
  };

  if result.0 as isize > SHELL_EXECUTE_SUCCESS_FLOOR {
    Ok(outcome(METHOD_ELEVATED, state))
  } else {
    Err("elevation was declined or could not be started".to_string())
  }
}

fn open_error(error: &windows_service::Error) -> String {
  if error_code(error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) {
    format!("{SERVICE_NAME} is not installed")
  } else {
    format!("could not open {SERVICE_NAME}: {error}")
  }
}

fn error_code(error: &windows_service::Error) -> Option<i32> {
  match error {
    windows_service::Error::Winapi(io) => io.raw_os_error(),
    _ => None,
  }
}

fn state_name(state: ServiceState) -> &'static str {
  match state {
    ServiceState::Stopped => "stopped",
    ServiceState::StartPending => "start_pending",
    ServiceState::StopPending => "stop_pending",
    ServiceState::Running => "running",
    ServiceState::ContinuePending => "continue_pending",
    ServiceState::PausePending => "pause_pending",
    ServiceState::Paused => "paused",
  }
}

fn start_type_name(start_type: ServiceStartType) -> &'static str {
  match start_type {
    ServiceStartType::AutoStart => "auto_start",
    ServiceStartType::OnDemand => "on_demand",
    ServiceStartType::Disabled => "disabled",
    ServiceStartType::SystemStart => "system_start",
    ServiceStartType::BootStart => "boot_start",
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  #[test]
  fn staleness_matches_the_tray_rule() {
    // owlette_tray uses `file_age > 120`, so 120 s exactly is still fresh.
    assert!(!is_status_stale(Duration::from_secs(0)));
    assert!(!is_status_stale(Duration::from_secs(30))); // one throttle window
    assert!(!is_status_stale(Duration::from_secs(119)));
    assert!(!is_status_stale(Duration::from_secs(120)));
    assert!(is_status_stale(Duration::from_millis(120_001)));
    assert!(is_status_stale(Duration::from_secs(121)));
  }

  #[test]
  fn a_missing_status_file_reads_as_stale() {
    let path = std::env::temp_dir().join(format!("owlette-missing-{}.json", std::process::id()));
    let _ = fs::remove_file(&path);
    let info = status_file_info(&path, SystemTime::now());
    assert_eq!(
      info,
      StatusFileInfo {
        exists: false,
        age_secs: None,
        stale: true
      }
    );
  }

  #[test]
  fn a_fresh_status_file_reads_as_fresh() {
    let path = std::env::temp_dir().join(format!("owlette-fresh-{}.json", std::process::id()));
    fs::write(&path, "{}").expect("seed");
    let info = status_file_info(&path, SystemTime::now());
    assert!(info.exists);
    assert!(!info.stale, "just-written file reported stale: {info:?}");
    assert_eq!(info.age_secs, Some(0));
    let _ = fs::remove_file(&path);
  }

  /// The regression this whole change exists for: quitting stopped the service,
  /// the still-live webview saw "not running" and asked for a start, and the
  /// operator got a second UAC prompt on their way out.
  #[test]
  fn a_start_during_a_stop_is_refused() {
    assert_eq!(
      start_short_circuit(ServiceState::StopPending, false),
      Some(METHOD_NOOP)
    );
  }

  #[test]
  fn a_start_while_quitting_is_refused_whatever_the_state() {
    for state in [
      ServiceState::Stopped,
      ServiceState::StopPending,
      ServiceState::Running,
      ServiceState::Paused,
    ] {
      assert_eq!(
        start_short_circuit(state, true),
        Some(METHOD_QUITTING),
        "expected a quitting refusal for {}",
        state_name(state)
      );
    }
  }

  #[test]
  fn a_stopped_service_still_starts() {
    assert_eq!(start_short_circuit(ServiceState::Stopped, false), None);
    assert_eq!(start_short_circuit(ServiceState::Paused, false), None);
  }

  #[test]
  fn a_start_that_is_already_under_way_is_not_reissued() {
    assert_eq!(
      start_short_circuit(ServiceState::Running, false),
      Some(METHOD_NOOP)
    );
    assert_eq!(
      start_short_circuit(ServiceState::StartPending, false),
      Some(METHOD_NOOP)
    );
  }

  /// `stop` has no `quitting` arm — the quit is what calls it.
  #[test]
  fn stopping_is_never_refused_for_quitting() {
    assert_eq!(stop_short_circuit(ServiceState::Running), None);
    assert_eq!(stop_short_circuit(ServiceState::Stopped), Some(METHOD_NOOP));
    assert_eq!(
      stop_short_circuit(ServiceState::StopPending),
      Some(METHOD_NOOP)
    );
  }

  /// A `StartPending` stop reaches the SCM rather than short-circuiting, so the
  /// 1061 arm in [`stop`] is the thing that gets to explain itself.
  #[test]
  fn stopping_a_starting_service_reaches_the_scm() {
    assert_eq!(stop_short_circuit(ServiceState::StartPending), None);
  }

  #[test]
  fn an_old_status_file_reads_as_stale() {
    let path = std::env::temp_dir().join(format!("owlette-old-{}.json", std::process::id()));
    fs::write(&path, "{}").expect("seed");
    // Advance "now" rather than back-date the file, which needs SetFileTime.
    let later = SystemTime::now() + Duration::from_secs(300);
    let info = status_file_info(&path, later);
    assert!(info.stale, "expected stale: {info:?}");
    assert!(info.age_secs.unwrap_or_default() >= 300);
    let _ = fs::remove_file(&path);
  }
}
