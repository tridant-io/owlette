//! Control and inspection of the `OwletteService` Windows service.
//!
//! Two signals decide whether owlette is really supervising this machine, and
//! the UI needs both: the SCM state, and the age of `tmp/service_status.json`
//! (rewritten on a 30 s throttle, stale past 120 s). A running-but-wedged
//! service looks alive to the SCM but stops refreshing the file.
//!
//! Start/stop go through the SCM when this process has the rights, falling back
//! to an elevated `net start` / `net stop` otherwise.

#[cfg(windows)]
use std::ffi::OsStr;
use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::Serialize;
#[cfg(windows)]
use windows::core::w;
#[cfg(windows)]
use windows::Win32::UI::Shell::ShellExecuteW;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
#[cfg(windows)]
use windows_service::service::{ServiceAccess, ServiceStartType, ServiceState};
#[cfg(windows)]
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

/// Service name, as registered by the installer (`shared_utils.SERVICE_NAME`).
#[cfg(windows)]
pub const SERVICE_NAME: &str = "OwletteService";
/// The systemd unit on linux; the launchd label on macos (tri-platform 5.1/5.2).
#[cfg(all(unix, not(target_os = "macos")))]
pub const SERVICE_NAME: &str = "owlette-agent";
#[cfg(target_os = "macos")]
pub const SERVICE_NAME: &str = "app.owlette.agent";
/// How long a `systemctl` control may take to answer. without the polkit rule
/// packaging ships, an in-seat call parks on polkit indefinitely, and on a box
/// whose admin group exists it would put an auth dialog on the kiosk screen —
/// so the call is bounded, and a timeout is reported as the rule missing.
#[cfg(unix)]
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);

/// Age past which `service_status.json` no longer describes reality.
pub const STATUS_STALE_AFTER: Duration = Duration::from_secs(120);

/// Windows error codes we branch on.
#[cfg(windows)]
const ERROR_ACCESS_DENIED: i32 = 5;
#[cfg(windows)]
const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
#[cfg(windows)]
const ERROR_SERVICE_ALREADY_RUNNING: i32 = 1056;
#[cfg(windows)]
const ERROR_SERVICE_NOT_ACTIVE: i32 = 1062;

/// `ShellExecuteW` returns an HINSTANCE; > 32 means the process launched.
#[cfg(windows)]
const SHELL_EXECUTE_SUCCESS_FLOOR: isize = 32;

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
  /// `scm` (issued directly), `elevated` (UAC-prompted `net` command) or
  /// `noop` (already in the requested state).
  pub method: String,
  /// SCM state before the request. Poll [`status`] for the result — an elevated
  /// launch only means the shell accepted it.
  pub state_before: String,
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
/// linux: one `systemctl show` for the three states, which needs no polkit
/// rule and answers for a unit that is not there at all. macos: `launchctl
/// print` on the system domain, read-only; a non-zero exit is "not
/// installed".
#[cfg(unix)]
pub fn status(status_file: &Path) -> Result<ServiceStatus, String> {
  let status_file = status_file_info(status_file, SystemTime::now());
  if cfg!(target_os = "macos") {
    let output = std::process::Command::new("launchctl")
      .args(["print", &format!("system/{SERVICE_NAME}")])
      .output()
      .map_err(|error| format!("could not run launchctl: {error}"))?;
    if !output.status.success() {
      return Ok(ServiceStatus {
        installed: false,
        running: false,
        state: "unknown".to_string(),
        start_type: "unknown".to_string(),
        status_file,
      });
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let running = text.lines().any(|line| line.trim().starts_with("state = running"));
    return Ok(ServiceStatus {
      installed: true,
      running,
      state: if running { "running" } else { "stopped" }.to_string(),
      start_type: "launchd".to_string(),
      status_file,
    });
  }
  let output = std::process::Command::new("systemctl")
    .args(["show", "-p", "LoadState", "-p", "ActiveState", "-p", "UnitFileState", SERVICE_NAME])
    .output()
    .map_err(|error| format!("could not run systemctl: {error}"))?;
  let text = String::from_utf8_lossy(&output.stdout);
  let value = |key: &str| {
    text
      .lines()
      .find_map(|line| line.strip_prefix(key).and_then(|rest| rest.strip_prefix('=')))
      .unwrap_or("")
      .trim()
      .to_string()
  };
  let load = value("LoadState");
  let active = value("ActiveState");
  let unit_file = value("UnitFileState");
  Ok(ServiceStatus {
    installed: load == "loaded",
    running: active == "active",
    state: if active.is_empty() { "unknown".to_string() } else { active },
    start_type: if unit_file.is_empty() { "unknown".to_string() } else { unit_file },
    status_file,
  })
}

/// linux: `systemctl start --no-block`, bounded — the polkit rule packaging
/// ships (5.2) is what lets the kiosk user do this without a prompt, and a
/// call that hangs past the bound is that rule missing. macos: the agent is a
/// system launchd job the app cannot start from a user session; the
/// installer's job, said as a refusal rather than a hang.
#[cfg(unix)]
pub fn start(_allow_elevation: bool) -> Result<ServiceCommandOutcome, String> {
  control("start", "active")
}

#[cfg(unix)]
pub fn stop() -> Result<ServiceCommandOutcome, String> {
  control("stop", "inactive")
}

#[cfg(unix)]
fn control(verb: &str, already: &str) -> Result<ServiceCommandOutcome, String> {
  if cfg!(target_os = "macos") {
    return Err(format!(
      "{verb}ing the agent on macos is launchd's job: run `sudo launchctl kickstart -k system/{SERVICE_NAME}`"
    ));
  }
  let before = status(Path::new("/nonexistent"))?.state;
  if before == already {
    return Ok(ServiceCommandOutcome {
      method: "noop".to_string(),
      state_before: before,
    });
  }
  let mut child = std::process::Command::new("systemctl")
    .args([verb, "--no-block", SERVICE_NAME])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped())
    .spawn()
    .map_err(|error| format!("could not run systemctl: {error}"))?;
  let deadline = std::time::Instant::now() + CONTROL_TIMEOUT;
  loop {
    match child.try_wait() {
      Ok(Some(status)) if status.success() => {
        return Ok(ServiceCommandOutcome {
          method: "systemd".to_string(),
          state_before: before,
        })
      }
      Ok(Some(status)) => {
        let mut detail = String::new();
        if let Some(mut stderr) = child.stderr.take() {
          use std::io::Read;
          let _ = stderr.read_to_string(&mut detail);
        }
        return Err(format!(
          "systemctl {verb} {SERVICE_NAME} failed ({status}): {}",
          detail.trim()
        ));
      }
      Ok(None) if std::time::Instant::now() >= deadline => {
        let _ = child.kill();
        return Err(format!(
          "systemctl {verb} {SERVICE_NAME} did not answer within {}s — is the owlette polkit rule installed?",
          CONTROL_TIMEOUT.as_secs()
        ));
      }
      Ok(None) => std::thread::sleep(Duration::from_millis(50)),
      Err(error) => return Err(format!("could not wait for systemctl: {error}")),
    }
  }
}

#[cfg(windows)]
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
        status_file,
      })
    }
    Err(error) => return Err(format!("could not open {SERVICE_NAME}: {error}")),
  };

  let state = service
    .query_status()
    .map_err(|error| format!("could not query {SERVICE_NAME}: {error}"))?
    .current_state;

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
    status_file,
  })
}

/// Start the service. When this process lacks the right, `allow_elevation`
/// decides between one UAC prompt and a plain error: only a deliberate click
/// may put a consent dialog on screen. An automatic caller (the launch-time
/// auto-start) passes `false` — during a self-update, every machine's tray app
/// sees the service stop and would otherwise raise an unattended
/// "Windows Command Processor" prompt over whatever is running.
#[cfg(windows)]
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
  if state == ServiceState::Running || state == ServiceState::StartPending {
    return Ok(ServiceCommandOutcome {
      method: "noop".to_string(),
      state_before: state_name(state).to_string(),
    });
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

  match manager.open_service(SERVICE_NAME, ServiceAccess::START) {
    Ok(service) => match service.start(&[] as &[&OsStr]) {
      Ok(()) => Ok(ServiceCommandOutcome {
        method: "scm".to_string(),
        state_before: state_name(state).to_string(),
      }),
      Err(error) if error_code(&error) == Some(ERROR_SERVICE_ALREADY_RUNNING) => {
        Ok(ServiceCommandOutcome {
          method: "noop".to_string(),
          state_before: state_name(state).to_string(),
        })
      }
      Err(error) if error_code(&error) == Some(ERROR_ACCESS_DENIED) => {
        start_denied(allow_elevation, state)
      }
      Err(error) => Err(format!("could not start {SERVICE_NAME}: {error}")),
    },
    Err(error) if error_code(&error) == Some(ERROR_ACCESS_DENIED) => {
      start_denied(allow_elevation, state)
    }
    Err(error) => Err(open_error(&error)),
  }
}

/// The unelevated start was refused: elevate when the caller may, error when
/// it may not.
#[cfg(windows)]
fn start_denied(
  allow_elevation: bool,
  state: ServiceState,
) -> Result<ServiceCommandOutcome, String> {
  if allow_elevation {
    elevated(w!("/c net start OwletteService"), state_name(state))
  } else {
    Err(format!(
      "starting {SERVICE_NAME} needs administrator rights — use the start button to authorize it"
    ))
  }
}

/// Stop the service, elevating only if this process lacks the right.
#[cfg(windows)]
pub fn stop() -> Result<ServiceCommandOutcome, String> {
  let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
    .map_err(|error| format!("could not connect to the service manager: {error}"))?;

  let inspector = manager
    .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
    .map_err(|error| open_error(&error))?;

  let state = inspector
    .query_status()
    .map_err(|error| format!("could not query {SERVICE_NAME}: {error}"))?
    .current_state;
  if state == ServiceState::Stopped || state == ServiceState::StopPending {
    return Ok(ServiceCommandOutcome {
      method: "noop".to_string(),
      state_before: state_name(state).to_string(),
    });
  }

  match manager.open_service(SERVICE_NAME, ServiceAccess::STOP) {
    Ok(service) => match service.stop() {
      Ok(_) => Ok(ServiceCommandOutcome {
        method: "scm".to_string(),
        state_before: state_name(state).to_string(),
      }),
      Err(error) if error_code(&error) == Some(ERROR_SERVICE_NOT_ACTIVE) => {
        Ok(ServiceCommandOutcome {
          method: "noop".to_string(),
          state_before: state_name(state).to_string(),
        })
      }
      Err(error) if error_code(&error) == Some(ERROR_ACCESS_DENIED) => {
        elevated(w!("/c net stop OwletteService"), state_name(state))
      }
      Err(error) => Err(format!("could not stop {SERVICE_NAME}: {error}")),
    },
    Err(error) if error_code(&error) == Some(ERROR_ACCESS_DENIED) => {
      elevated(w!("/c net stop OwletteService"), state_name(state))
    }
    Err(error) => Err(open_error(&error)),
  }
}

/// Elevated `net` command via the shell's `runas` verb (one UAC prompt).
/// Success means the process launched, not that the service changed state.
#[cfg(windows)]
fn elevated(
  parameters: windows::core::PCWSTR,
  state_before: &str,
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
    Ok(ServiceCommandOutcome {
      method: "elevated".to_string(),
      state_before: state_before.to_string(),
    })
  } else {
    Err("elevation was declined or could not be started".to_string())
  }
}

#[cfg(windows)]
fn open_error(error: &windows_service::Error) -> String {
  if error_code(error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) {
    format!("{SERVICE_NAME} is not installed")
  } else {
    format!("could not open {SERVICE_NAME}: {error}")
  }
}

#[cfg(windows)]
fn error_code(error: &windows_service::Error) -> Option<i32> {
  match error {
    windows_service::Error::Winapi(io) => io.raw_os_error(),
    _ => None,
  }
}

#[cfg(windows)]
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

#[cfg(windows)]
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
