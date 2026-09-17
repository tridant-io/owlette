//! Tauri command surface.
//!
//! Thin adapters only: resolve args, delegate to a Tauri-free module, map errors
//! to strings. Keeping logic out of here is what makes the seam unit-testable
//! without an app handle.
//!
//! Every command is `#[tauri::command(async)]` with a synchronous body, so it
//! runs to completion on one worker thread — keeps the main thread free during a
//! mutex wait and satisfies Windows' acquire/release-on-the-same-thread rule.

use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::agent_cli::{self, Runs};
use crate::json_io::{self, WriteOutcome};
use crate::paths::{self, SERVICE_STATUS_REL};
use crate::process_ctl::{self, TerminateOutcome, DEFAULT_GRACEFUL_TIMEOUT};
use crate::service_ctl::{self, ServiceCommandOutcome, ServiceStatus};
use crate::shell_open;
use crate::window_state::{DetailSections, LayoutState};

/// Absolute path of the owlette data root, per OS (`crate::paths`). The frontend
/// otherwise uses relative paths; this is for spawning the bundled interpreter or
/// showing the operator where the tree lives.
#[tauri::command(async)]
pub fn owlette_data_root() -> String {
  paths::data_root().to_string_lossy().into_owned()
}

/// argv this process was launched with, including argv[0].
///
/// The service passes `--tray` (tray icon, no window) or `--restart-prompt` (a
/// process blew its relaunch budget). A *second* launch never reaches here — the
/// single-instance plugin forwards argv on `owlette://second-instance`, so a UI
/// reacting to these flags must handle both.
#[tauri::command(async)]
pub fn launch_args() -> Vec<String> {
  std::env::args().collect()
}

/// This machine's name, as the fleet knows it (`gethostname`).
#[tauri::command(async)]
pub fn hostname() -> String {
  crate::tray::hostname()
}

/// Whether the run-on-login startup shortcut exists.
#[tauri::command(async)]
pub fn startup_link_enabled() -> bool {
  crate::startup_link::is_enabled()
}

/// Create or remove the run-on-login shortcut; returns the resulting state.
#[tauri::command(async)]
pub fn set_startup_link(enabled: bool) -> Result<bool, String> {
  if enabled {
    crate::startup_link::enable()?;
  } else {
    crate::startup_link::disable()?;
  }
  Ok(crate::startup_link::is_enabled())
}

/// Read a JSON file from the owlette tree under the cross-process mutex.
///
/// `path` is relative to the data root (or absolute inside it). A missing file
/// reads as `{}`.
#[tauri::command(async)]
pub fn read_owlette_json(path: String) -> Result<Value, String> {
  let resolved = paths::resolve_in_root(&paths::data_root(), &path)?;
  json_io::read_json(&resolved).map_err(|error| error.to_string())
}

/// Write a JSON file into the owlette tree atomically, under the mutex.
#[tauri::command(async)]
pub fn write_owlette_json(path: String, json: Value) -> Result<WriteOutcome, String> {
  let resolved = paths::resolve_in_root(&paths::data_root(), &path)?;
  json_io::write_json(&resolved, &json).map_err(|error| error.to_string())
}

/// SCM state of `OwletteService` plus the freshness of `service_status.json`.
#[tauri::command(async)]
pub fn service_status() -> Result<ServiceStatus, String> {
  service_ctl::status(&paths::data_root().join(SERVICE_STATUS_REL))
}

/// Start `OwletteService`. `allow_elevation` gates the UAC fallback when this
/// process lacks the right — false for automatic callers, true for a click.
#[tauri::command(async)]
pub fn service_start(allow_elevation: bool) -> Result<ServiceCommandOutcome, String> {
  service_ctl::start(allow_elevation)
}

/// Stop `OwletteService`, elevating only when this process lacks the right.
#[tauri::command(async)]
pub fn service_stop() -> Result<ServiceCommandOutcome, String> {
  service_ctl::stop()
}

/// Close `pid` gracefully, then terminate it — but only if it is still running
/// `expected_exe`.
#[tauri::command(async)]
pub fn terminate_pid(
  pid: u32,
  expected_exe: String,
  graceful_timeout_ms: Option<u64>,
) -> Result<TerminateOutcome, String> {
  let timeout = graceful_timeout_ms
    .map(Duration::from_millis)
    .unwrap_or(DEFAULT_GRACEFUL_TIMEOUT);
  process_ctl::terminate_pid(pid, &expected_exe, timeout)
}

/// Run one of the agent's headless modes, streaming its output. `mode` is a name
/// from `agent_cli::MODES`, never a command line, and `server` names the cloud
/// the `join` mode pairs against. Returns the run id to match against
/// `owlette://agent-cli` events; `exit` means finished.
#[tauri::command(async)]
pub fn agent_cli_start(
  app: AppHandle,
  runs: State<'_, Runs>,
  mode: String,
  payload: Option<Value>,
  server: Option<String>,
) -> Result<String, String> {
  agent_cli::start(&app, &runs, &mode, payload, server.as_deref())
}

/// Stop a run started by [`agent_cli_start`]. `false` if it had already exited.
#[tauri::command(async)]
pub fn agent_cli_cancel(runs: State<'_, Runs>, run: String) -> Result<bool, String> {
  agent_cli::cancel(&runs, &run)
}

/// Longest frontend log line kept — past this it is a runaway stack trace, and
/// truncating keeps one bad run from filling the operator's log file.
const MAX_LOG_MESSAGE_BYTES: usize = 4096;

/// Record a line from the frontend in the app's log file.
///
/// A release build has no console and no devtools, so a multi-step flow that
/// failed on a remote machine leaves no evidence unless it logs here (proved by
/// leave-site teardown: it stopped the service, the app died mid-sequence, and
/// nothing had been written).
///
/// An unrecognised `level` is recorded at info — mislabelled beats dropped.
#[tauri::command(async)]
pub fn log_event(level: String, message: String) {
  let message = truncate_on_boundary(&message, MAX_LOG_MESSAGE_BYTES);
  match level.as_str() {
    "error" => log::error!("[ui] {message}"),
    "warn" => log::warn!("[ui] {message}"),
    "debug" => log::debug!("[ui] {message}"),
    _ => log::info!("[ui] {message}"),
  }
}

/// Cut `text` to at most `limit` bytes without splitting a character.
fn truncate_on_boundary(text: &str, limit: usize) -> &str {
  if text.len() <= limit {
    return text;
  }
  let mut end = limit;
  while end > 0 && !text.is_char_boundary(end) {
    end -= 1;
  }
  &text[..end]
}

/// Open a file or folder inside the owlette tree with its default handler.
#[tauri::command(async)]
pub fn open_owlette_path(path: String) -> Result<(), String> {
  shell_open::open_in_tree(&path)
}

/// Open an `http(s)` link in the default browser.
#[tauri::command(async)]
pub fn open_external_url(url: String) -> Result<(), String> {
  shell_open::open_url(&url)
}

/// Width the process-list sidebar should open at, in logical pixels. Shares the
/// per-user layout file with the window size so both are remembered together.
#[tauri::command(async)]
pub fn sidebar_width(layout: State<'_, LayoutState>) -> f64 {
  layout.sidebar_width()
}

/// Store the sidebar width, returning the value actually kept. The host clamps
/// too — an out-of-range width reaching here would be remembered forever.
#[tauri::command(async)]
pub fn set_sidebar_width(layout: State<'_, LayoutState>, width: f64) -> Result<f64, String> {
  layout.set_sidebar_width(width)
}

/// Whether the process list should open collapsed to its icon rail.
#[tauri::command(async)]
pub fn sidebar_collapsed(layout: State<'_, LayoutState>) -> bool {
  layout.sidebar_collapsed()
}

/// Remember whether the process list is collapsed. Stored beside the width, not
/// instead of it, so expanding restores the operator's dragged width.
#[tauri::command(async)]
pub fn set_sidebar_collapsed(
  layout: State<'_, LayoutState>,
  collapsed: bool,
) -> Result<bool, String> {
  layout.set_sidebar_collapsed(collapsed)
}

/// Which detail-pane sections open expanded. Shares the per-user layout file.
#[tauri::command(async)]
pub fn detail_sections(layout: State<'_, LayoutState>) -> DetailSections {
  layout.detail_sections()
}

/// Remember one detail-pane section's open state, returning what was kept. The
/// section key is whitelisted on the other side of this call.
#[tauri::command(async)]
pub fn set_detail_section(
  layout: State<'_, LayoutState>,
  section: String,
  open: bool,
) -> Result<bool, String> {
  layout.set_detail_section(&section, open)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_short_message_is_kept_whole() {
    assert_eq!(
      truncate_on_boundary("stopping the service", 4096),
      "stopping the service"
    );
    assert_eq!(truncate_on_boundary("", 4096), "");
  }

  #[test]
  fn a_long_message_is_cut_to_the_limit() {
    let long = "x".repeat(MAX_LOG_MESSAGE_BYTES * 2);
    assert_eq!(
      truncate_on_boundary(&long, MAX_LOG_MESSAGE_BYTES).len(),
      MAX_LOG_MESSAGE_BYTES
    );
  }

  #[test]
  fn a_cut_never_lands_inside_a_character() {
    // A python traceback arrives in whatever the console codepage produced, so
    // a multi-byte character straddling the limit is not hypothetical.
    let text = "é".repeat(64);
    for limit in 0..text.len() {
      let cut = truncate_on_boundary(&text, limit);
      assert!(cut.len() <= limit);
      assert!(text.starts_with(cut));
    }
  }
}
