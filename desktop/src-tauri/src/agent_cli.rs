//! Running the agent's python CLI and streaming its progress.
//!
//! Pairing with a site, leaving one, and filing a bug report all need the agent's
//! cloud client and encrypted token store. Neither is reimplemented here: token
//! crypto stays in `agent/src/secure_storage.py`, the Firestore REST client in
//! `agent/src/firestore_rest_client.py`. This module spawns the bundled
//! interpreter against `agent/src/configure_site.py`:
//!
//! ```text
//! %PROGRAMDATA%\Owlette\python\python.exe
//!   %PROGRAMDATA%\Owlette\agent\src\configure_site.py --json-progress
//! ```
//!
//! That script writes one JSON object per line to stdout. Every line is forwarded
//! as an [`EVENT_AGENT_CLI`] event tagged with its run, then exactly one `exit`
//! event carrying the exit code. Parsing is the frontend's job — the host is a pipe.
//!
//! The frontend names one of [`MODES`] and this module builds the argv, so
//! nothing the webview can say becomes an argument to the interpreter.
//!
//! Off Windows this app is the console user, and an interpreter it spawned
//! could neither use the token store nor control the daemon. There the modes
//! that need root are requests to the daemon instead ([`crate::seam`]): its
//! answer is the same JSON-line stream, forwarded as the same events, so the
//! frontend runs one flow on every platform.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::paths;
#[cfg(unix)]
use crate::seam::{self, Seam, Verb};

/// Emitted for every line the agent CLI writes, and once more when it exits.
pub const EVENT_AGENT_CLI: &str = "owlette://agent-cli";

/// The bundled interpreter, relative to the data root. `python.exe` rather than
/// `pythonw.exe`: we need its stdout, and `CREATE_NO_WINDOW` already keeps the
/// console off the operator's screen.
#[cfg(windows)]
const PYTHON_REL: &str = "python/python.exe";
/// The bundled interpreter under the install root off windows
/// (`shared_utils.get_python_exe_path`: `/opt/owlette/python/bin/python3`,
/// `…/Owlette/runtime/python/bin/python3`).
#[cfg(unix)]
const PYTHON_REL: &str = "python/bin/python3";

/// The agent script that hosts every headless mode.
const SCRIPT_REL: &str = "agent/src/configure_site.py";

/// Where a feedback payload is staged for `--report-issue`. The script deletes
/// it as soon as it has been read.
const REPORT_DIR_REL: &str = "tmp";

/// Windows creation flag: no console window for the child.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How often a running child is checked for having exited.
const REAP_INTERVAL: Duration = Duration::from_millis(150);

/// Longest line forwarded from the child. Anything approaching this is a runaway
/// traceback; truncating keeps one bad run from filling the webview.
const MAX_LINE_BYTES: usize = 64 * 1024;

/// Modes the frontend may run, and the argv each becomes. Adding a mode here is
/// the only way to add one to the frontend's reach.
const MODES: &[(&str, &str)] = &[
  // Pair with a site: emits `phrase`, then `status` while polling, then `authorized`.
  // May additionally carry `--server dev|prod` to name the cloud the pairing
  // runs against; without one the agent keeps the config's current environment.
  ("join", "--json-progress"),
  // Leave: disable cloud sync, drop cached config, stop service, delete the
  // machine document, start the service.
  ("leave", "--leave"),
  // File a feedback report. Requires a payload.
  ("report-issue", "--report-issue"),
  // Restart Windows, recorded as an owlette-initiated reboot.
  ("reboot-now", "--reboot-now"),
  // Clear this machine's cloud `rebootPending` flag.
  ("dismiss-reboot", "--dismiss-reboot"),
];

/// The mode that carries a JSON payload rather than running bare.
const MODE_REPORT_ISSUE: &str = "report-issue";

/// The mode that may name the cloud it pairs against.
const MODE_JOIN: &str = "join";

/// The clouds `join` may be pointed at. An argv token, so the frontend's string
/// is matched against this list rather than interpolated.
const SERVERS: &[&str] = &["dev", "prod"];

/// One line of output, or the child's exit.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliEvent {
  /// Run this belongs to, as returned by [`start`].
  pub run: String,
  /// `stdout`, `stderr`, or `exit`.
  pub stream: String,
  /// The line, for `stdout` and `stderr`.
  pub line: Option<String>,
  /// Exit code, for `exit`. `None` when the process was terminated by a signal
  /// or could not be reaped.
  pub code: Option<i32>,
}

/// Children that are still running, keyed by run id.
#[derive(Default)]
pub struct Runs {
  next: AtomicU64,
  children: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
  /// Requests the daemon is still answering, keyed by run id.
  #[cfg(unix)]
  seam: Mutex<HashMap<String, SeamRun>>,
}

/// One run carried out by the daemon rather than a child of this app.
#[cfg(unix)]
struct SeamRun {
  verb: Verb,
  cancelled: bool,
}

/// The daemon's verb for a mode that needs root off Windows: every mode does.
#[cfg(unix)]
fn seam_verb(mode: &str) -> Option<Verb> {
  match mode {
    MODE_JOIN => Some(Verb::Pair),
    "leave" => Some(Verb::Leave),
    MODE_REPORT_ISSUE => Some(Verb::ReportIssue),
    "reboot-now" => Some(Verb::Reboot),
    "dismiss-reboot" => Some(Verb::DismissReboot),
    _ => None,
  }
}

/// Translate a mode name into the flag it runs.
fn flag_for(mode: &str) -> Result<&'static str, String> {
  MODES
    .iter()
    .find(|(name, _)| *name == mode)
    .map(|(_, flag)| *flag)
    .ok_or_else(|| format!("unknown agent mode: {mode}"))
}

/// Write a feedback payload into the owlette tree and return its path.
///
/// Per-run filename so two reports cannot collide, and the script deletes it
/// after reading — the operator's description is not left on disk.
fn stage_payload(root: &Path, run: &str, payload: &Value) -> Result<PathBuf, String> {
  let dir = root.join(REPORT_DIR_REL);
  std::fs::create_dir_all(&dir)
    .map_err(|error| format!("could not create {}: {error}", dir.display()))?;

  let path = dir.join(format!("owlette-feedback-{run}.json"));
  let body = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
  std::fs::write(&path, body)
    .map_err(|error| format!("could not write {}: {error}", path.display()))?;
  Ok(path)
}

/// Build the interpreter's argv for one run.
///
/// Pure, so what each mode runs — and which tokens it refuses — is asserted in
/// tests without spawning anything.
fn build_arguments(
  script: &Path,
  flag: &str,
  mode: &str,
  payload_path: Option<&Path>,
  server: Option<&str>,
) -> Result<Vec<String>, String> {
  let mut arguments: Vec<String> = vec![script.to_string_lossy().into_owned(), flag.to_string()];

  if let Some(payload_path) = payload_path {
    arguments.push(payload_path.to_string_lossy().into_owned());
  }

  if let Some(server) = vetted_server(mode, server)? {
    arguments.push("--server".to_string());
    arguments.push(server.to_string());
  }

  Ok(arguments)
}

/// The server a run may name: only `join` names one, and only from [`SERVERS`].
fn vetted_server<'a>(mode: &str, server: Option<&'a str>) -> Result<Option<&'a str>, String> {
  match (mode == MODE_JOIN, server) {
    (true, Some(server)) if !SERVERS.contains(&server) => Err(format!("unknown server: {server}")),
    (false, Some(_)) => Err(format!("the {mode} mode takes no server")),
    (_, server) => Ok(server),
  }
}

/// Spawn one agent CLI run and start streaming it. Returns the run id.
///
/// `server` names the cloud a `join` pairs against; every other mode refuses one.
pub fn start(
  app: &AppHandle,
  runs: &Runs,
  mode: &str,
  payload: Option<Value>,
  server: Option<&str>,
) -> Result<String, String> {
  let flag = flag_for(mode)?;

  #[cfg(unix)]
  if let Some(verb) = seam_verb(mode) {
    let server = vetted_server(mode, server)?;
    // the report goes in the request itself: a file staged in the owlette tree
    // would be the console user's, and the daemon's run is root's.
    let fields = match (verb, payload) {
      (Verb::ReportIssue, Some(payload)) => Some(payload),
      (Verb::ReportIssue, None) => return Err("a feedback report needs a payload".to_string()),
      (_, Some(_)) => return Err(format!("the {mode} mode takes no payload")),
      (_, None) => server.map(|server| serde_json::json!({ "server": server })),
    };
    return start_seam_run(app, runs, mode, verb, fields);
  }

  let root = paths::data_root();
  // the interpreter and the scripts are the agent's own files: the install
  // root, which is the data root on windows and its own place elsewhere.
  let install = paths::install_root();

  let python = install.join(PYTHON_REL);
  if !python.is_file() {
    return Err(format!(
      "the bundled python interpreter is missing ({}) — reinstall the owlette agent",
      python.display()
    ));
  }
  let script = install.join(SCRIPT_REL);
  if !script.is_file() {
    return Err(format!(
      "the agent scripts are missing ({}) — reinstall the owlette agent",
      script.display()
    ));
  }

  let run = format!("{mode}-{}", runs.next.fetch_add(1, Ordering::Relaxed));

  let staged = match (mode == MODE_REPORT_ISSUE, payload) {
    (true, Some(payload)) => Some(stage_payload(&root, &run, &payload)?),
    (true, None) => return Err("a feedback report needs a payload".to_string()),
    (false, Some(_)) => return Err(format!("the {mode} mode takes no payload")),
    (false, None) => None,
  };

  let arguments = build_arguments(&script, flag, mode, staged.as_deref(), server)?;

  let mut command = Command::new(&python);
  command
    .args(&arguments)
    .current_dir(install.join("agent").join("src"))
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  #[cfg(windows)]
  command.creation_flags(CREATE_NO_WINDOW);
  let mut child = command
    .spawn()
    .map_err(|error| format!("could not start the agent helper: {error}"))?;

  // Taken before the child is shared, so the reader threads own them outright
  // and never contend with `cancel` for the child's lock.
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();

  let child = Arc::new(Mutex::new(child));
  match runs.children.lock() {
    Ok(mut children) => {
      children.insert(run.clone(), Arc::clone(&child));
    }
    Err(_) => return Err("the agent run table is poisoned".to_string()),
  }

  if let Some(stdout) = stdout {
    spawn_reader(app.clone(), run.clone(), "stdout", stdout);
  }
  if let Some(stderr) = stderr {
    spawn_reader(app.clone(), run.clone(), "stderr", stderr);
  }
  spawn_reaper(app.clone(), run.clone(), child);

  Ok(run)
}

/// Ask the daemon for `verb` and forward its answer as this run's stdout,
/// then one `exit` — the events a spawned helper produces, so the frontend
/// cannot tell the two apart. A request the daemon never answered becomes the
/// run's `error` line.
#[cfg(unix)]
fn start_seam_run(
  app: &AppHandle,
  runs: &Runs,
  mode: &str,
  verb: Verb,
  fields: Option<Value>,
) -> Result<String, String> {
  let run = format!("{mode}-{}", runs.next.fetch_add(1, Ordering::Relaxed));
  runs
    .seam
    .lock()
    .map_err(|_| "the agent run table is poisoned".to_string())?
    .insert(run.clone(), SeamRun { verb, cancelled: false });

  let (app, id) = (app.clone(), run.clone());
  let spawned = thread::Builder::new()
    .name("owlette-seam".into())
    .spawn(move || {
      let line = |line: String| AgentCliEvent {
        run: id.clone(),
        stream: "stdout".to_string(),
        line: Some(line),
        code: None,
      };
      let answer = Seam::new(paths::data_root()).ask(verb, fields.as_ref(), &mut |text| {
        emit(&app, line(text.to_string()))
      });
      let code = match answer {
        Ok(terminal) => i32::from(seam::is_error(&terminal)),
        Err(message) => {
          log::warn!("the owlette service did not carry out {}: {message}", verb.name());
          emit(&app, line(serde_json::json!({ "event": "error", "value": message }).to_string()));
          1
        }
      };
      if let Some(app_runs) = app.try_state::<Runs>() {
        if let Ok(mut seam_runs) = app_runs.seam.lock() {
          seam_runs.remove(&id);
        }
      }
      emit(
        &app,
        AgentCliEvent {
          run: id,
          stream: "exit".to_string(),
          line: None,
          code: Some(code),
        },
      );
    });
  if let Err(error) = spawned {
    if let Ok(mut seam_runs) = runs.seam.lock() {
      seam_runs.remove(&run);
    }
    return Err(format!("could not ask the owlette service: {error}"));
  }
  Ok(run)
}

/// A seam run is the daemon's, not a child of this app to kill. A pairing is
/// ended by asking for that too — the daemon then answers the pairing's own run
/// with the error that ends it — and a leave or a reboot, once asked for, is
/// not taken back. None when `run` is no seam run.
#[cfg(unix)]
fn cancel_seam_run(runs: &Runs, run: &str) -> Result<Option<bool>, String> {
  let mut seam_runs = runs
    .seam
    .lock()
    .map_err(|_| "the agent run table is poisoned".to_string())?;
  let Some(entry) = seam_runs.get_mut(run) else {
    return Ok(None);
  };
  if entry.verb != Verb::Pair || entry.cancelled {
    return Ok(Some(false));
  }
  entry.cancelled = true;
  drop(seam_runs);

  // answered on the daemon's next tick; nothing here waits for it.
  thread::Builder::new()
    .name("owlette-seam-cancel".into())
    .spawn(|| {
      match Seam::new(paths::data_root()).ask(Verb::CancelPair, None, &mut |_| {}) {
        Ok(terminal) if !seam::is_error(&terminal) => log::info!("pairing cancelled"),
        Ok(terminal) => log::warn!("could not cancel the pairing: {}", seam::error_message(&terminal)),
        Err(error) => log::warn!("could not cancel the pairing: {error}"),
      }
    })
    .map_err(|error| format!("could not cancel the pairing: {error}"))?;
  Ok(Some(true))
}

/// Kill a running child. `false` when the run had already finished.
///
/// Cancelling a pairing run just abandons the device code; it expires
/// server-side ten minutes later, so there is nothing to tell the server.
pub fn cancel(runs: &Runs, run: &str) -> Result<bool, String> {
  #[cfg(unix)]
  if let Some(cancelled) = cancel_seam_run(runs, run)? {
    return Ok(cancelled);
  }

  let child = runs
    .children
    .lock()
    .map_err(|_| "the agent run table is poisoned".to_string())?
    .remove(run);

  let Some(child) = child else {
    return Ok(false);
  };

  let mut child = child
    .lock()
    .map_err(|_| "the agent child lock is poisoned".to_string())?;
  match child.kill() {
    Ok(()) => Ok(true),
    // Already gone between the lookup and the kill.
    Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => Ok(false),
    Err(error) => Err(format!("could not stop the agent helper: {error}")),
  }
}

/// Kill everything still running. Called when the app exits, so a ten-minute
/// pairing poll does not outlive the window that started it. A seam run is the
/// daemon's and is left to it: a pairing still polling ends when its phrase
/// expires.
pub fn cancel_all(runs: &Runs) {
  let Ok(mut children) = runs.children.lock() else {
    return;
  };
  for (run, child) in children.drain() {
    if let Ok(mut child) = child.lock() {
      if let Err(error) = child.kill() {
        log::debug!("could not stop agent run {run}: {error}");
      }
    }
  }
}

/// Forward one pipe, line by line, until it closes.
fn spawn_reader<R>(app: AppHandle, run: String, stream: &'static str, source: R)
where
  R: Read + Send + 'static,
{
  let name = format!("owlette-agent-{stream}");
  if let Err(error) = thread::Builder::new().name(name).spawn(move || {
    let reader = BufReader::new(source);
    for line in reader.lines() {
      match line {
        Ok(mut line) => {
          if line.is_empty() {
            continue;
          }
          if line.len() > MAX_LINE_BYTES {
            // `truncate` panics on a non-boundary index, so cut on one.
            let mut end = MAX_LINE_BYTES;
            while end > 0 && !line.is_char_boundary(end) {
              end -= 1;
            }
            line.truncate(end);
          }
          emit(
            &app,
            AgentCliEvent {
              run: run.clone(),
              stream: stream.to_string(),
              line: Some(line),
              code: None,
            },
          );
        }
        // Non-UTF-8 output is a python traceback in the console codepage, not
        // protocol; drop the line rather than abandoning the stream.
        Err(error) => log::debug!("unreadable {stream} line from agent run {run}: {error}"),
      }
    }
  }) {
    log::error!("could not read the agent helper's {stream}: {error}");
  }
}

/// Wait for the child, emit its exit, and drop it from the run table.
fn spawn_reaper(app: AppHandle, run: String, child: Arc<Mutex<Child>>) {
  if let Err(error) = thread::Builder::new()
    .name("owlette-agent-reap".into())
    .spawn(move || {
      let code = loop {
        // The lock is released between polls so `cancel` can take it. Holding it
        // across a blocking `wait()` would make cancelling impossible.
        let polled = match child.lock() {
          Ok(mut child) => child.try_wait(),
          Err(_) => break None,
        };
        match polled {
          Ok(Some(status)) => break status.code(),
          Ok(None) => thread::sleep(REAP_INTERVAL),
          Err(error) => {
            log::warn!("could not reap agent run {run}: {error}");
            break None;
          }
        }
      };

      if let Some(app_runs) = app.try_state::<Runs>() {
        if let Ok(mut children) = app_runs.children.lock() {
          children.remove(&run);
        }
      }

      emit(
        &app,
        AgentCliEvent {
          run,
          stream: "exit".to_string(),
          line: None,
          code,
        },
      );
    })
  {
    log::error!("could not watch the agent helper: {error}");
  }
}

fn emit(app: &AppHandle, event: AgentCliEvent) {
  if let Err(error) = app.emit(EVENT_AGENT_CLI, event) {
    log::warn!("could not forward an agent helper event: {error}");
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn every_mode_maps_to_exactly_one_flag() {
    for (mode, flag) in MODES {
      assert_eq!(flag_for(mode).expect("known mode"), *flag);
      assert!(flag.starts_with("--"), "{mode} maps to {flag}");
    }
  }

  #[test]
  fn the_mode_names_are_unique() {
    let mut names: Vec<&str> = MODES.iter().map(|(name, _)| *name).collect();
    names.sort_unstable();
    let count = names.len();
    names.dedup();
    assert_eq!(names.len(), count, "duplicate mode name");
  }

  #[test]
  fn an_unknown_mode_is_refused_rather_than_run() {
    // The frontend cannot reach the interpreter with anything not in MODES —
    // this is what keeps a webview string from becoming an argv entry.
    for attempt in ["", "--leave", "join; rm -rf", "JOIN", "exec"] {
      assert!(flag_for(attempt).is_err(), "{attempt} should be refused");
    }
  }

  #[test]
  fn report_issue_is_the_only_mode_that_carries_a_payload() {
    assert!(flag_for(MODE_REPORT_ISSUE).is_ok());
    assert_eq!(flag_for(MODE_REPORT_ISSUE).unwrap(), "--report-issue");
  }

  /// Stand-in for the installed script; `build_arguments` never touches disk.
  fn script() -> &'static Path {
    Path::new(r"C:\ProgramData\Owlette\agent\src\configure_site.py")
  }

  #[test]
  fn join_carries_a_dev_server_through_to_the_argv() {
    let arguments =
      build_arguments(script(), "--json-progress", MODE_JOIN, None, Some("dev")).expect("dev");
    assert_eq!(
      arguments,
      vec![
        script().to_string_lossy().into_owned(),
        "--json-progress".to_string(),
        "--server".to_string(),
        "dev".to_string(),
      ]
    );
  }

  #[test]
  fn join_carries_a_prod_server_through_to_the_argv() {
    let arguments =
      build_arguments(script(), "--json-progress", MODE_JOIN, None, Some("prod")).expect("prod");
    assert_eq!(
      arguments,
      vec![
        script().to_string_lossy().into_owned(),
        "--json-progress".to_string(),
        "--server".to_string(),
        "prod".to_string(),
      ]
    );
  }

  #[test]
  fn join_without_a_server_runs_the_argv_it_always_did() {
    // The tray's "join site" path: no server named, so the agent re-pairs
    // against whatever environment the config already carries.
    let flag = flag_for(MODE_JOIN).expect("join is a mode");
    let arguments = build_arguments(script(), flag, MODE_JOIN, None, None).expect("bare join");
    assert_eq!(
      arguments,
      vec![
        script().to_string_lossy().into_owned(),
        "--json-progress".to_string(),
      ]
    );
  }

  #[test]
  fn an_unvetted_server_never_becomes_an_argv_entry() {
    for attempt in ["staging", "", "dev prod", "--leave", "DEV", "dev;whoami"] {
      let refused = build_arguments(script(), "--json-progress", MODE_JOIN, None, Some(attempt));
      assert_eq!(
        refused,
        Err(format!("unknown server: {attempt}")),
        "{attempt} should be refused"
      );
    }
  }

  #[test]
  fn every_mode_but_join_refuses_a_server() {
    for (mode, flag) in MODES {
      if *mode == MODE_JOIN {
        continue;
      }
      let payload = (*mode == MODE_REPORT_ISSUE).then(|| Path::new(r"C:\staged.json"));
      let refused = build_arguments(script(), flag, mode, payload, Some("dev"));
      assert_eq!(
        refused,
        Err(format!("the {mode} mode takes no server")),
        "{mode} should refuse a server"
      );
    }
  }

  #[cfg(unix)]
  #[test]
  fn off_windows_every_mode_that_needs_root_is_asked_of_the_daemon() {
    let routed: Vec<(&str, Option<Verb>)> = MODES.iter().map(|(mode, _)| (*mode, seam_verb(mode))).collect();
    assert_eq!(
      routed,
      [
        ("join", Some(Verb::Pair)),
        ("leave", Some(Verb::Leave)),
        ("report-issue", Some(Verb::ReportIssue)),
        ("reboot-now", Some(Verb::Reboot)),
        ("dismiss-reboot", Some(Verb::DismissReboot)),
      ]
    );
  }

  #[cfg(unix)]
  #[test]
  fn only_a_pairing_still_running_is_cancelled_through_the_daemon() {
    let runs = Runs::default();
    {
      let mut seam_runs = runs.seam.lock().unwrap();
      seam_runs.insert("leave-0".to_string(), SeamRun { verb: Verb::Leave, cancelled: false });
      seam_runs.insert("join-1".to_string(), SeamRun { verb: Verb::Pair, cancelled: true });
    }

    // a leave asked for is not taken back, and a pairing is cancelled once.
    assert_eq!(cancel_seam_run(&runs, "leave-0"), Ok(Some(false)));
    assert_eq!(cancel_seam_run(&runs, "join-1"), Ok(Some(false)));
    // anything else is a child of this app's, cancelled the way it always was.
    assert_eq!(cancel_seam_run(&runs, "report-issue-2"), Ok(None));
    assert_eq!(cancel(&runs, "report-issue-2"), Ok(false));
  }

  #[test]
  fn a_staged_payload_lands_in_the_tree_and_round_trips() {
    let root = std::env::temp_dir().join(format!("owlette-agent-cli-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);

    let payload = serde_json::json!({ "category": "bug", "description": "it stopped" });
    let path = stage_payload(&root, "report-issue-7", &payload).expect("stage");

    assert!(path.starts_with(root.join(REPORT_DIR_REL)));
    let written: Value =
      serde_json::from_slice(&std::fs::read(&path).expect("read back")).expect("parse");
    assert_eq!(written, payload);

    let _ = std::fs::remove_dir_all(&root);
  }
}
