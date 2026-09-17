//! Control and inspection of the owlette agent service, per platform.
//!
//! Two signals decide whether owlette is really supervising this machine, and
//! the UI needs both: what the platform's service manager says, and the age of
//! `tmp/service_status.json` (rewritten on a 30 s throttle, stale past 120 s).
//! A running-but-wedged service looks alive to the manager but stops refreshing
//! the file.
//!
//! * **Windows** — the SCM, falling back to an elevated `net start` / `net stop`
//!   when this process lacks the right.
//! * **Linux** — `systemctl` as the kiosk user. The D-Bus call it makes is
//!   checked against `org.freedesktop.systemd1.manage-units`, which the shipped
//!   polkit rule grants to group `owlette` for this one unit. Never `pkexec`:
//!   its own action is not in that rule, so it would prompt. Where the rule is
//!   missing the call does not fail so much as wait — see [`control_unanswered`]
//!   — which is why every control here is bounded.
//! * **macOS** — `launchctl print` for status, and nothing else: loading or
//!   unloading a LaunchDaemon needs root, and a kiosk has no admin session to
//!   ask (no `osascript … with administrator privileges` anywhere).
//!
//! Restarting is a privileged request into `configure_site.py`'s `ipc/requests`
//! seam on both POSIX platforms, never `tmp/restart.flag` — off Windows the
//! daemon ignores a flag it did not write itself.
//!
//! The tray monitor polls [`status`] once a second, so every arm here is one
//! service-manager call per tick and nothing heavier.

#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::thread;
#[cfg(unix)]
use std::time::Instant;
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

/// The unit the `.deb` installs, spelled as `osadapter.linux.SERVICE_UNIT`
/// spells it: the agent's service is named for the Windows SCM wherever it is
/// configured, and this is what that name resolves to here.
#[cfg(all(unix, not(target_os = "macos")))]
pub const SERVICE_UNIT: &str = "owlette-agent.service";

/// The LaunchDaemon label the `.pkg` installs (Task 5.1's
/// `/Library/LaunchDaemons/app.owlette.agent.plist`).
#[cfg(target_os = "macos")]
pub const SERVICE_LABEL: &str = "app.owlette.agent";

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
  /// How the request was made: `scm` (issued directly), `elevated`
  /// (UAC-prompted `net` command), `systemd` (`systemctl`, authorised by the
  /// polkit rule) or `noop` (already in the requested state).
  pub method: String,
  /// The service's state before the request. Poll [`status`] for the result:
  /// an elevated launch only means the shell accepted it, and a `systemd`
  /// control only that the job was queued.
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

/// How often a wait loop looks at a helper process again. Short enough that a
/// control feels immediate, cheap enough that the ceilings below are not a spin.
#[cfg(unix)]
const CHILD_POLL: Duration = Duration::from_millis(20);

/// What a read-only query is worth waiting for. The same ten seconds
/// `osadapter.linux` gives `systemctl is-active`.
#[cfg(unix)]
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);

/// What a start or a stop is worth waiting for. Both are asked with
/// `--no-block`, so an authorised control is a bus round trip and nothing more
/// — on the kiosk VM, 43 ms end to end. Seconds mean polkit is holding the
/// call open for an authentication this session cannot complete, and the
/// operator is owed an answer rather than a spinning menu.
#[cfg(all(unix, not(target_os = "macos")))]
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);

/// The nonce the daemon publishes for the seam, relative to the data root
/// (`configure_site.REQUEST_NONCE_PATH`).
#[cfg(unix)]
const REQUEST_NONCE_REL: &str = "ipc/request_nonce";

/// Where a request goes (`configure_site.REQUESTS_DIR`).
#[cfg(unix)]
const REQUESTS_REL: &str = "ipc/requests";

/// Mode a request is created with. The daemon refuses anything carrying a group
/// or world write bit: a request it can see being rewritten under it is not the
/// one it checked.
#[cfg(unix)]
const REQUEST_MODE: u32 = 0o600;

/// How long the daemon is given to answer. Its loop reads the seam every five
/// seconds and hands the drain to a worker, so this is that with room for a tick
/// that ran long.
#[cfg(unix)]
const ANSWER_TIMEOUT: Duration = Duration::from_secs(30);

/// How much longer an answer that has begun is watched. A restart is answered
/// `status` before it is attempted and `error` only if it fails, so this is the
/// window that failure would land in.
#[cfg(unix)]
const ANSWER_SETTLE: Duration = Duration::from_secs(2);

/// How often that answer is re-read.
#[cfg(unix)]
const ANSWER_POLL: Duration = Duration::from_millis(200);

/// What a helper process said, once it has said it.
#[cfg(unix)]
struct Finished {
  ok: bool,
  stdout: String,
  stderr: String,
}

/// How a helper process ended. The two are not the same answer: a refusal
/// arrives as output, and an authorization nobody can complete arrives as
/// silence.
#[cfg(unix)]
enum Ran {
  Finished(Finished),
  /// Still running when the caller's budget ran out; killed.
  TimedOut,
}

/// Run one short-lived helper and collect what it said, never blocking past
/// `timeout`.
///
/// The tray monitor calls in here once a second and the window's commands from a
/// worker, so a `systemctl` that never returns — a wedged bus, an unresponsive
/// launchd — must not take the thread with it. Killed rather than waited on:
/// the caller has already decided how long the answer is worth.
///
/// Output is read after the child is gone, which is safe for what is asked here
/// (three unit properties, one launchd record) and would not be for a helper
/// that can fill a pipe buffer.
#[cfg(unix)]
fn run(program: &str, arguments: &[&str], timeout: Duration) -> Result<Ran, String> {
  let mut child = Command::new(program)
    .args(arguments)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|error| format!("could not run {program}: {error}"))?;

  let deadline = Instant::now() + timeout;
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) => {}
      Err(error) => return Err(format!("could not wait for {program}: {error}")),
    }
    if Instant::now() >= deadline {
      let _ = child.kill();
      let _ = child.wait();
      return Ok(Ran::TimedOut);
    }
    thread::sleep(CHILD_POLL);
  }

  let output = child
    .wait_with_output()
    .map_err(|error| format!("could not read what {program} said: {error}"))?;
  Ok(Ran::Finished(Finished {
    ok: output.status.success(),
    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
  }))
}

/// The three unit properties a status is made of.
#[cfg(all(unix, not(target_os = "macos")))]
struct UnitState {
  load: String,
  active: String,
  unit_file: String,
}

/// Ask systemd about the unit — one bus round trip for all three properties.
///
/// `show` rather than `is-active`, which answers only one of the three and
/// cannot tell a stopped unit from one systemd has never heard of: an
/// uninstalled agent has to read as uninstalled, not as stopped.
#[cfg(all(unix, not(target_os = "macos")))]
fn show_unit() -> Result<UnitState, String> {
  let ran = run(
    "systemctl",
    &[
      "show",
      SERVICE_UNIT,
      "--property=LoadState",
      "--property=ActiveState",
      "--property=UnitFileState",
    ],
    QUERY_TIMEOUT,
  )?;
  let Ran::Finished(finished) = ran else {
    return Err(format!(
      "systemd did not answer about {SERVICE_UNIT} within {}s",
      QUERY_TIMEOUT.as_secs()
    ));
  };
  if !finished.ok {
    let detail = finished.stderr.trim();
    return Err(format!("could not ask systemd about {SERVICE_UNIT}: {detail}"));
  }

  let mut state = UnitState {
    load: String::new(),
    active: String::new(),
    unit_file: String::new(),
  };
  for line in finished.stdout.lines() {
    let Some((key, value)) = line.split_once('=') else {
      continue;
    };
    match key {
      "LoadState" => state.load = value.trim().to_string(),
      "ActiveState" => state.active = value.trim().to_string(),
      "UnitFileState" => state.unit_file = value.trim().to_string(),
      _ => {}
    }
  }
  Ok(state)
}

/// systemd's `ActiveState` in the vocabulary the window and the tray already
/// speak (`ServiceState` in `lib/ipc.ts`). `failed` is a stopped unit: nothing
/// is supervising the machine, which is what the footer has to say.
#[cfg(all(unix, not(target_os = "macos")))]
fn state_name(active: &str) -> &'static str {
  match active {
    "active" | "reloading" => "running",
    "activating" => "start_pending",
    "deactivating" => "stop_pending",
    "inactive" | "failed" => "stopped",
    _ => "unknown",
  }
}

/// `UnitFileState` in that same vocabulary. Only a masked unit cannot be started
/// at all, which is what Windows calls `disabled`; a unit that is merely not
/// enabled still starts on request.
#[cfg(all(unix, not(target_os = "macos")))]
fn start_type_name(unit_file: &str) -> &'static str {
  match unit_file {
    "enabled" | "enabled-runtime" => "auto_start",
    "masked" | "masked-runtime" => "disabled",
    "" => "unknown",
    _ => "on_demand",
  }
}

/// systemd's view of the unit plus status-file freshness.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn status(status_file: &Path) -> Result<ServiceStatus, String> {
  let status_file = status_file_info(status_file, SystemTime::now());
  let unit = show_unit()?;
  let installed = unit.load != "not-found";
  let state = if installed { state_name(&unit.active) } else { "unknown" };

  Ok(ServiceStatus {
    installed,
    running: state == "running",
    state: state.to_string(),
    start_type: if installed {
      start_type_name(&unit.unit_file)
    } else {
      "unknown"
    }
    .to_string(),
    status_file,
  })
}

/// `systemctl start|stop` as this session, on the unit the package installs.
///
/// Never `--user` and never `sudo`: the unit is the system's, and polkit is what
/// says whether the kiosk user may touch it. `--no-block` matches what the SCM
/// does on Windows — the job is accepted, and the caller polls [`status`] for
/// the result — and keeps a unit that takes its time starting from holding the
/// click.
#[cfg(all(unix, not(target_os = "macos")))]
fn unit_control(verb: &str, wants_active: bool) -> Result<ServiceCommandOutcome, String> {
  let unit = show_unit()?;
  if unit.load == "not-found" {
    return Err(format!("{SERVICE_UNIT} is not installed on this machine"));
  }

  let state_before = state_name(&unit.active);
  let settled = if wants_active {
    matches!(state_before, "running" | "start_pending")
  } else {
    matches!(state_before, "stopped" | "stop_pending")
  };
  if settled {
    return Ok(ServiceCommandOutcome {
      method: "noop".to_string(),
      state_before: state_before.to_string(),
    });
  }

  match run(
    "systemctl",
    &["--no-ask-password", "--no-block", verb, SERVICE_UNIT],
    CONTROL_TIMEOUT,
  )? {
    Ran::Finished(finished) if finished.ok => Ok(ServiceCommandOutcome {
      method: "systemd".to_string(),
      state_before: state_before.to_string(),
    }),
    Ran::Finished(finished) => Err(control_error(verb, &finished.stderr)),
    Ran::TimedOut => Err(control_unanswered(verb)),
  }
}

/// What to tell the operator when systemd refused out loud.
///
/// A polkit denial is the one worth naming: on a machine without the shipped
/// rule it is what every start and stop from the tray runs into, and the fix is
/// the rule rather than the button.
#[cfg(all(unix, not(target_os = "macos")))]
fn control_error(verb: &str, stderr: &str) -> String {
  let detail = stderr.trim();
  let lowered = detail.to_lowercase();
  if ["access denied", "authentication required", "not authorized"]
    .iter()
    .any(|refusal| lowered.contains(refusal))
  {
    return format!(
      "this session is not authorized to {verb} {SERVICE_UNIT} — \
       the owlette polkit rule is missing"
    );
  }
  if detail.is_empty() {
    return format!("systemctl could not {verb} {SERVICE_UNIT}");
  }
  format!("could not {verb} {SERVICE_UNIT}: {detail}")
}

/// The same refusal, arriving as silence.
///
/// Measured on the kiosk VM, without the rule: from an ssh session polkit
/// answers in ~20 ms with "Interactive authentication required", but from inside
/// the seat — which is where the app runs — the session's own agent
/// (gnome-shell) is registered, polkit hands it an authentication nobody is
/// there to complete, and the call never returns. `--no-ask-password` does not
/// prevent that and neither does `busctl --allow-interactive-authorization=no`;
/// only the bounded wait does, and killing the child cancels the request. Said
/// as a refusal rather than a timeout because, `--no-block` being a bus round
/// trip, that is what it is.
#[cfg(all(unix, not(target_os = "macos")))]
fn control_unanswered(verb: &str) -> String {
  format!(
    "nothing authorized this session to {verb} {SERVICE_UNIT} — \
     the owlette polkit rule is missing, or systemd did not answer"
  )
}

/// Start the unit. There is no elevation off Windows — the polkit rule either
/// authorises this session or it does not — so `allow_elevation` is ignored and
/// the signature stays the one the command surface shares.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn start(_allow_elevation: bool) -> Result<ServiceCommandOutcome, String> {
  unit_control("start", true)
}

/// Stop the unit. `KillMode=process` is what keeps the managed kiosk processes
/// alive through it, exactly as `owlette-host` does on Windows.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn stop() -> Result<ServiceCommandOutcome, String> {
  unit_control("stop", false)
}

/// What `launchctl print` says about the daemon, plus status-file freshness.
///
/// Read-only by design, and tolerant of not being allowed to read at all: where
/// the system domain is closed to a kiosk session the status file is the honest
/// fallback, because reporting "not running" for a question we could not ask
/// would paint every mac red while the daemon supervises the machine fine.
#[cfg(target_os = "macos")]
pub fn status(status_file: &Path) -> Result<ServiceStatus, String> {
  let status_file = status_file_info(status_file, SystemTime::now());
  let target = format!("system/{SERVICE_LABEL}");
  let finished = match run("launchctl", &["print", &target], QUERY_TIMEOUT)? {
    Ran::Finished(finished) => finished,
    // Unanswered is not an answer about the daemon; fall through to the file.
    Ran::TimedOut => Finished {
      ok: false,
      stdout: String::new(),
      stderr: format!("launchctl did not answer within {}s", QUERY_TIMEOUT.as_secs()),
    },
  };

  if finished.ok {
    let running = launchd_state(&finished.stdout).as_deref() == Some("running");
    return Ok(ServiceStatus {
      installed: true,
      running,
      state: if running { "running" } else { "stopped" }.to_string(),
      // launchd has no start-type vocabulary this maps onto; the plist's
      // RunAtLoad and KeepAlive are not what `print` answers with.
      start_type: "unknown".to_string(),
      status_file,
    });
  }

  if is_unknown_service(&finished.stderr) {
    return Ok(ServiceStatus {
      installed: false,
      running: false,
      state: "unknown".to_string(),
      start_type: "unknown".to_string(),
      status_file,
    });
  }

  log::debug!(
    "launchctl would not describe {SERVICE_LABEL} ({}); falling back to the status file",
    finished.stderr.trim()
  );
  Ok(ServiceStatus {
    installed: true,
    running: !status_file.stale,
    state: "unknown".to_string(),
    start_type: "unknown".to_string(),
    status_file,
  })
}

/// The `state = …` line out of a `launchctl print` record.
#[cfg(target_os = "macos")]
fn launchd_state(printed: &str) -> Option<String> {
  printed
    .lines()
    .find_map(|line| line.trim().strip_prefix("state = "))
    .map(|state| state.trim().to_string())
}

/// Whether launchctl refused because it has never heard of the service, rather
/// than because this session may not ask.
#[cfg(target_os = "macos")]
fn is_unknown_service(stderr: &str) -> bool {
  stderr.to_lowercase().contains("could not find service")
}

/// Refused: loading a LaunchDaemon is root's work and a kiosk session has no
/// administrator to ask. The daemon starts with the machine, and a restart goes
/// through [`restart`].
#[cfg(target_os = "macos")]
pub fn start(_allow_elevation: bool) -> Result<ServiceCommandOutcome, String> {
  Err(format!(
    "{SERVICE_LABEL} is managed by launchd — it starts with this machine, \
     and only an administrator can start it by hand"
  ))
}

/// Refused, for the reason [`start`] is. Quitting the app leaves the daemon
/// supervising the machine, which is the point of a kiosk.
#[cfg(target_os = "macos")]
pub fn stop() -> Result<ServiceCommandOutcome, String> {
  Err(format!(
    "{SERVICE_LABEL} is managed by launchd — only an administrator can stop it"
  ))
}

/// Ask the daemon to restart the agent service.
///
/// Off Windows this is a privileged request, not a file in `tmp/`: the app runs
/// as the console user, `tmp/restart.flag` is honoured only when root wrote it
/// (`owlette_service._restart_requested`), and the seam is what carries the
/// nonce, the rate limit and the audit row that make the ask accountable. On
/// Linux the polkit rule would allow `systemctl restart` as well; the seam is
/// used on both so that one path — and one audit trail — covers a restart
/// asked for from the app.
#[cfg(unix)]
pub fn restart(root: &Path) -> Result<(), String> {
  submit_request(root, "restart", ANSWER_TIMEOUT)
}

/// Leave one verb in the seam and wait for the daemon's answer.
///
/// The contract is `configure_site.py`'s: staged as `<id>.json.tmp` and renamed
/// into place, so the daemon never reads one half-written; carrying the nonce it
/// last published, which is one-shot; created 0600, so the group-writable
/// directory cannot be used to rewrite what the daemon checked. The answer lands
/// beside it in `<id>.result`, in the same JSON lines the headless modes print.
///
/// A request nothing answered is taken back rather than left: the daemon takes
/// requests oldest first, and one still sitting there when it next starts would
/// restart the agent minutes after the operator gave up on the click.
#[cfg(unix)]
fn submit_request(root: &Path, verb: &str, timeout: Duration) -> Result<(), String> {
  let directory = root.join(REQUESTS_REL);
  let nonce = read_nonce(root)?;
  let id = request_id();
  let staged = directory.join(format!("{id}.json.tmp"));
  let request = directory.join(format!("{id}.json"));
  let reply = directory.join(format!("{id}.result"));

  write_request(&staged, verb, &nonce)?;
  if let Err(error) = fs::rename(&staged, &request) {
    let _ = fs::remove_file(&staged);
    return Err(format!(
      "could not leave a {verb} request for the owlette daemon: {error}"
    ));
  }

  let answer = await_answer(&reply, timeout);
  let _ = fs::remove_file(&reply);
  match answer {
    Some(result) => result,
    None => {
      let _ = fs::remove_file(&request);
      Err(format!(
        "the owlette daemon did not answer the {verb} request — it may be \
         stopped, or nobody is signed in at this machine's screen"
      ))
    }
  }
}

/// The nonce a request has to quote, as the daemon last published it.
#[cfg(unix)]
fn read_nonce(root: &Path) -> Result<String, String> {
  let path = root.join(REQUEST_NONCE_REL);
  let nonce = fs::read_to_string(&path).map_err(|error| {
    format!(
      "the owlette daemon has not opened its request seam ({}): {error}",
      path.display()
    )
  })?;
  let nonce = nonce.trim();
  if nonce.is_empty() {
    return Err("the owlette daemon has not published a request nonce yet".to_string());
  }
  Ok(nonce.to_string())
}

/// A name no other request can collide with: this process, and the moment it
/// asked. The daemon takes requests oldest first by name, so the timestamp also
/// keeps one session's asks in the order it made them.
#[cfg(unix)]
fn request_id() -> String {
  let at = SystemTime::now()
    .duration_since(SystemTime::UNIX_EPOCH)
    .unwrap_or(Duration::ZERO);
  format!("desktop-{}-{}", std::process::id(), at.as_nanos())
}

/// Write one request, at the mode the daemon insists on.
#[cfg(unix)]
fn write_request(path: &Path, verb: &str, nonce: &str) -> Result<(), String> {
  let body = serde_json::json!({ "verb": verb, "nonce": nonce }).to_string();
  let mut file = fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .mode(REQUEST_MODE)
    .open(path)
    .map_err(|error| format!("could not write {}: {error}", path.display()))?;
  file
    .write_all(body.as_bytes())
    .map_err(|error| format!("could not write {}: {error}", path.display()))
}

/// Watch one answer until the daemon has said something terminal.
///
/// `Some(Ok(()))` once it has accepted the verb, `Some(Err(_))` when it refused
/// — the message is the daemon's own, which is what names a rate limit or a
/// spent nonce — and `None` when nothing was ever written. An accepted restart
/// is answered `status` first and `error` only if it then fails, so an answer
/// that has begun is watched a little longer rather than taken as success the
/// moment the first line lands.
#[cfg(unix)]
fn await_answer(path: &Path, timeout: Duration) -> Option<Result<(), String>> {
  let started = Instant::now();
  let mut accepted_at: Option<Instant> = None;

  loop {
    if let Ok(text) = fs::read_to_string(path) {
      for (event, detail) in answer_events(&text) {
        if event == "error" {
          return Some(Err(detail));
        }
        accepted_at.get_or_insert_with(Instant::now);
      }
    }

    let now = Instant::now();
    match accepted_at {
      Some(at) if now.duration_since(at) >= ANSWER_SETTLE => return Some(Ok(())),
      None if now.duration_since(started) >= timeout => return None,
      _ => {}
    }
    thread::sleep(ANSWER_POLL);
  }
}

/// The `{"event": …, "value": …}` lines an answer is made of. A last line the
/// daemon is still writing does not parse, and is ignored until it does.
#[cfg(unix)]
fn answer_events(text: &str) -> Vec<(String, String)> {
  text
    .lines()
    .filter_map(|line| {
      let parsed: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
      let event = parsed.get("event")?.as_str()?.to_string();
      let detail = parsed
        .get("value")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
      Some((event, detail))
    })
    .collect()
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

#[cfg(all(test, unix))]
mod posix_tests {
  use super::*;
  use std::os::unix::fs::PermissionsExt;
  use std::path::PathBuf;
  use std::sync::atomic::{AtomicUsize, Ordering};

  /// A data root with an open seam, unique per test so they can run together.
  fn seam_root() -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
      "owlette-seam-{}-{}",
      std::process::id(),
      COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(REQUESTS_REL)).expect("requests directory");
    root
  }

  fn publish_nonce(root: &Path, nonce: &str) {
    fs::write(root.join(REQUEST_NONCE_REL), format!("{nonce}\n")).expect("nonce");
  }

  fn pending_request(root: &Path) -> Option<PathBuf> {
    fs::read_dir(root.join(REQUESTS_REL))
      .expect("requests directory")
      .filter_map(|entry| entry.ok())
      .map(|entry| entry.path())
      .find(|path| path.extension().and_then(|suffix| suffix.to_str()) == Some("json"))
  }

  /// The daemon's half of the seam: take the request, answer it in the line
  /// protocol, and hand back what it was asked for.
  fn answer_once(root: &Path, events: &[(&str, &str)]) -> std::thread::JoinHandle<serde_json::Value> {
    let directory = root.join(REQUESTS_REL);
    let lines: String = events
      .iter()
      .map(|(event, value)| format!("{}\n", serde_json::json!({"event": event, "value": value})))
      .collect();
    std::thread::spawn(move || {
      let deadline = Instant::now() + Duration::from_secs(10);
      loop {
        let found = fs::read_dir(&directory)
          .expect("requests directory")
          .filter_map(|entry| entry.ok())
          .map(|entry| entry.path())
          .find(|path| path.extension().and_then(|suffix| suffix.to_str()) == Some("json"));
        if let Some(path) = found {
          let body: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("request")).expect("request json");
          let mode = fs::metadata(&path).expect("request").permissions().mode();
          fs::remove_file(&path).expect("accept");
          let reply = path.with_extension("result");
          fs::write(&reply, &lines).expect("answer");
          return serde_json::json!({ "request": body, "mode": mode & 0o777 });
        }
        assert!(Instant::now() < deadline, "no request arrived");
        std::thread::sleep(Duration::from_millis(10));
      }
    })
  }

  #[test]
  fn a_request_quotes_the_nonce_and_is_not_group_writable() {
    let root = seam_root();
    publish_nonce(&root, "cafebabe");
    let daemon = answer_once(&root, &[("status", "restarting the service")]);

    submit_request(&root, "restart", Duration::from_secs(10)).expect("the daemon accepted it");

    let seen = daemon.join().expect("daemon thread");
    assert_eq!(seen["request"]["verb"], "restart");
    assert_eq!(seen["request"]["nonce"], "cafebabe");
    let mode = seen["mode"].as_u64().expect("mode") as u32;
    assert_eq!(mode, REQUEST_MODE, "request mode {mode:04o}");
    // The check the daemon itself runs (`configure_site._accept_request`).
    assert_eq!(mode & 0o022, 0, "a group- or world-writable request is refused");
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn nothing_is_left_in_the_seam_once_it_is_answered() {
    let root = seam_root();
    publish_nonce(&root, "cafebabe");
    let daemon = answer_once(&root, &[("status", "restarting the service")]);

    submit_request(&root, "restart", Duration::from_secs(10)).expect("the daemon accepted it");
    daemon.join().expect("daemon thread");

    let left: Vec<_> = fs::read_dir(root.join(REQUESTS_REL))
      .expect("requests directory")
      .filter_map(|entry| entry.ok())
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .collect();
    assert!(left.is_empty(), "the seam still holds {left:?}");
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn a_refusal_comes_back_in_the_daemons_own_words() {
    let root = seam_root();
    publish_nonce(&root, "cafebabe");
    let daemon = answer_once(
      &root,
      &[("error", "owlette ran a restart less than five minutes ago")],
    );

    let error =
      submit_request(&root, "restart", Duration::from_secs(10)).expect_err("a refusal is an error");
    daemon.join().expect("daemon thread");

    assert_eq!(error, "owlette ran a restart less than five minutes ago");
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn an_unanswered_request_is_taken_back() {
    let root = seam_root();
    publish_nonce(&root, "cafebabe");

    let error = submit_request(&root, "restart", Duration::from_millis(300))
      .expect_err("nothing answered it");

    assert!(error.contains("did not answer"), "unexpected: {error}");
    // The negative control for leaving it: a request still sitting there would
    // restart the agent whenever the daemon next drained the seam.
    assert!(
      pending_request(&root).is_none(),
      "the unanswered request was left in the seam"
    );
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn a_seam_with_no_nonce_is_refused_before_anything_is_written() {
    let root = seam_root();

    let error = submit_request(&root, "restart", Duration::from_millis(300))
      .expect_err("there is no nonce to quote");

    assert!(error.contains("request seam"), "unexpected: {error}");
    assert!(
      pending_request(&root).is_none(),
      "a request was written without a nonce"
    );
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn an_empty_nonce_is_no_nonce() {
    let root = seam_root();
    publish_nonce(&root, "   ");

    let error = submit_request(&root, "restart", Duration::from_millis(300))
      .expect_err("an empty nonce cannot be quoted");

    assert!(error.contains("nonce"), "unexpected: {error}");
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn a_half_written_answer_line_is_ignored_until_it_lands() {
    let torn = "{\"event\": \"status\", \"value\": \"restarting the service\"}\n{\"event\": \"er";
    assert_eq!(
      answer_events(torn),
      vec![(
        "status".to_string(),
        "restarting the service".to_string()
      )]
    );
    assert!(answer_events("").is_empty());
    assert!(answer_events("not json at all\n").is_empty());
  }

  #[test]
  fn an_answer_without_a_value_still_parses() {
    assert_eq!(
      answer_events("{\"event\": \"authorized\", \"value\": null}\n"),
      vec![("authorized".to_string(), String::new())]
    );
  }
}

#[cfg(all(test, unix, not(target_os = "macos")))]
mod linux_tests {
  use super::*;

  #[test]
  fn systemd_states_map_onto_the_vocabulary_the_ui_speaks() {
    assert_eq!(state_name("active"), "running");
    assert_eq!(state_name("reloading"), "running");
    assert_eq!(state_name("activating"), "start_pending");
    assert_eq!(state_name("deactivating"), "stop_pending");
    assert_eq!(state_name("inactive"), "stopped");
    // A failed unit is not supervising the machine, whatever else it is.
    assert_eq!(state_name("failed"), "stopped");
    assert_eq!(state_name(""), "unknown");
  }

  #[test]
  fn only_a_masked_unit_reads_as_disabled() {
    assert_eq!(start_type_name("enabled"), "auto_start");
    assert_eq!(start_type_name("enabled-runtime"), "auto_start");
    assert_eq!(start_type_name("masked"), "disabled");
    assert_eq!(start_type_name("masked-runtime"), "disabled");
    // Negative control: not enabled is not the same as cannot be started, and
    // calling it `disabled` would tell the operator to give up.
    assert_eq!(start_type_name("disabled"), "on_demand");
    assert_eq!(start_type_name("static"), "on_demand");
    assert_eq!(start_type_name(""), "unknown");
  }

  #[test]
  fn a_polkit_refusal_names_the_rule_rather_than_the_button() {
    let denied = control_error(
      "start",
      "Failed to start owlette-agent.service: Access denied\n",
    );
    assert!(denied.contains("polkit rule"), "unexpected: {denied}");

    let interactive = control_error(
      "stop",
      "Failed to stop owlette-agent.service: Interactive authentication required.\n",
    );
    assert!(interactive.contains("polkit rule"), "unexpected: {interactive}");
  }

  #[test]
  fn a_control_that_is_never_answered_is_reported_as_a_refusal() {
    // The shape polkit takes inside a seat: no stderr at all, just silence.
    let quiet = control_unanswered("start");
    assert!(quiet.contains("polkit rule"), "unexpected: {quiet}");
    assert!(quiet.contains("start"), "unexpected: {quiet}");
  }

  #[test]
  fn an_ordinary_systemd_failure_is_passed_through() {
    // Negative control for the one above: not every refusal is polkit's, and
    // rewriting them all as "install the rule" would send the operator after
    // the wrong thing.
    let missing = control_error("start", "Failed to start owlette-agent.service: Unit not found.");
    assert!(!missing.contains("polkit rule"), "unexpected: {missing}");
    assert!(missing.contains("Unit not found."), "unexpected: {missing}");

    let silent = control_error("stop", "   ");
    assert!(silent.contains("could not stop"), "unexpected: {silent}");
  }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
  use super::*;

  #[test]
  fn the_state_line_is_read_out_of_a_launchctl_record() {
    let printed = "system/app.owlette.agent = {\n\tactive count = 1\n\tstate = running\n}\n";
    assert_eq!(launchd_state(printed).as_deref(), Some("running"));
    assert_eq!(launchd_state("system/x = {\n\tstate = waiting\n}").as_deref(), Some("waiting"));
    assert_eq!(launchd_state("nothing of the sort"), None);
  }

  #[test]
  fn a_refusal_is_told_apart_from_an_unknown_service() {
    assert!(is_unknown_service(
      "Could not find service \"app.owlette.agent\" in domain for system"
    ));
    // Negative control: a permission refusal must not read as "not installed",
    // or every mac whose kiosk session cannot read the system domain would
    // report the agent uninstalled.
    assert!(!is_unknown_service("Could not print domain: 1: Operation not permitted"));
  }
}
