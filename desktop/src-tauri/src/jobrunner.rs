//! The GUI job seam the daemon uses off Windows (tri-platform task 4.3).
//!
//! A root daemon has no display, so a capture or a notification is a request
//! it drops into `ipc/jobs/<id>.json` (`agent/src/osadapter/posix.py`) for
//! this app, which runs where the user is, to carry out. The answer goes into
//! `ipc/results/<id>/result.json`, written whole and moved into place, with
//! whatever files the job produced beside it. The daemon owns the request file
//! and removes it once it has read the result; this runner never does.
//!
//! What is accepted: a regular file no larger than [`REQUEST_LIMIT`] that
//! nobody but its owner can write. `trusted` jobs (a shell, a launch) are
//! honoured only when the request is root's, which is the daemon and nobody
//! else in the group; there are none of those yet, so every trusted type is
//! answered `unsupported_job` — a typed refusal, never a panic and never
//! silence, because the daemon waits on the result for its budget and a
//! missing one costs it the whole wait.
//!
//! Polled at [`POLL`] rather than watched: the daemon's own poll on the result
//! is 100 ms and its handover allowance 5 s, so a request is seen within a
//! tenth of a second and nothing here needs a second file watcher.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

pub const JOBS_REL: &str = "ipc/jobs";
pub const RESULTS_REL: &str = "ipc/results";
/// A request past this is not a job: the daemon's own limit is the same.
pub const REQUEST_LIMIT: u64 = 64 * 1024;
/// The longest any job may run, whatever budget it names.
pub const JOB_CAP: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(100);
const RESULT_FILE: &str = "result.json";
const SCREENSHOT_FILE: &str = "screenshot.png";
/// The Windows capture writes the same name; `screenshot_capture.py` reads it.
const RESULT_DIR_MODE: u32 = 0o750;
const RESULT_FILE_MODE: u32 = 0o640;

/// One request as the daemon writes it. Unknown fields are the daemon's
/// business and are ignored; a missing `type` is a malformed job.
#[derive(Debug, Deserialize)]
pub struct Job {
  pub id: String,
  #[serde(rename = "type")]
  pub kind: String,
  #[serde(default)]
  pub monitor: usize,
  #[serde(default)]
  pub timeout_s: u64,
  #[serde(default)]
  pub title: String,
  #[serde(default)]
  pub body: String,
  #[serde(default)]
  pub trusted: bool,
}

/// What goes into `result.json`: the daemon reads `error` first, then
/// `files` and `monitors` for a capture.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct JobResult {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub message: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub monitors: Option<usize>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub files: Vec<String>,
}

impl JobResult {
  pub fn error(code: &str, message: impl Into<String>) -> Self {
    Self {
      error: Some(code.to_owned()),
      message: Some(message.into()),
      monitors: None,
      files: Vec::new(),
    }
  }

  pub fn done() -> Self {
    Self {
      error: None,
      message: None,
      monitors: None,
      files: Vec::new(),
    }
  }
}

/// Why a file in the jobs directory is not taken as a request.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
  NotRegular,
  TooLarge,
  WritableByOthers,
}

/// The acceptance rules, on metadata alone.
pub fn accept(meta: &fs::Metadata) -> Result<(), Refusal> {
  if !meta.is_file() {
    return Err(Refusal::NotRegular);
  }
  if meta.len() > REQUEST_LIMIT {
    return Err(Refusal::TooLarge);
  }
  if meta.permissions().mode() & 0o022 != 0 {
    return Err(Refusal::WritableByOthers);
  }
  Ok(())
}

/// A job id is a uuid hex string, which is also the result directory's name:
/// nothing else may name a path.
pub fn valid_id(id: &str) -> bool {
  id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn parse(raw: &[u8]) -> Result<Job, String> {
  let job: Job = serde_json::from_slice(raw).map_err(|error| error.to_string())?;
  if !valid_id(&job.id) {
    return Err(format!("job id {:?} is not a uuid hex", job.id));
  }
  Ok(job)
}

/// Write the result whole into `<results>/<id>/result.json` and move it into
/// place, so the daemon never reads a half-written file.
pub fn write_result(results: &Path, id: &str, result: &JobResult) -> std::io::Result<PathBuf> {
  let dir = results.join(id);
  fs::DirBuilder::new()
    .recursive(true)
    .mode(RESULT_DIR_MODE)
    .create(&dir)?;
  let path = dir.join(RESULT_FILE);
  let temp = dir.join(format!("{RESULT_FILE}.{}.tmp", std::process::id()));
  let bytes = serde_json::to_vec(result).map_err(std::io::Error::other)?;
  {
    let mut file = fs::OpenOptions::new()
      .write(true)
      .create(true)
      .truncate(true)
      .mode(RESULT_FILE_MODE)
      .open(&temp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
  }
  fs::rename(&temp, &path)?;
  Ok(path)
}

/// Bound a job's budget: what it asked for, never past [`JOB_CAP`], and never zero.
pub fn budget(timeout_s: u64) -> Duration {
  Duration::from_secs(timeout_s.clamp(1, JOB_CAP.as_secs()))
}

/// Run `capture` for one monitor into the result directory.
///
/// macOS: `/usr/sbin/screencapture` on this app's own Screen Recording grant —
/// spike 0.2 measured 348 ms to a JPEG on a granted app and an immediate
/// refusal without the grant, which comes back here as `capture_failed` with
/// the tool's one line. Linux is X11 through the display server and is not
/// wired yet (owner Q5), so it is a typed `unsupported_job`.
fn capture(results: &Path, job: &Job, monitors: usize) -> JobResult {
  if !cfg!(target_os = "macos") {
    return JobResult::error("unsupported_job", "screen capture is not available on this platform yet");
  }
  let dir = results.join(&job.id);
  if let Err(error) = fs::DirBuilder::new().recursive(true).mode(RESULT_DIR_MODE).create(&dir) {
    return JobResult::error("capture_failed", format!("could not create the result directory: {error}"));
  }
  let target = dir.join(SCREENSHOT_FILE);
  // screencapture numbers displays from 1; the daemon numbers monitors from 0.
  let display = (job.monitor + 1).to_string();
  let child = Command::new("/usr/sbin/screencapture")
    .args(["-x", "-t", "png", "-D", &display])
    .arg(&target)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .spawn();
  let mut child = match child {
    Ok(child) => child,
    Err(error) => return JobResult::error("capture_failed", format!("could not run screencapture: {error}")),
  };
  let deadline = Instant::now() + budget(job.timeout_s);
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break Some(status),
      Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
      Ok(None) => {
        let _ = child.kill();
        let _ = child.wait();
        break None;
      }
      Err(error) => return JobResult::error("capture_failed", format!("could not wait for screencapture: {error}")),
    }
  };
  let Some(status) = status else {
    return JobResult::error("capture_failed", "screencapture did not finish within the job's budget");
  };
  let stderr = child
    .stderr
    .take()
    .and_then(|mut out| {
      let mut text = String::new();
      std::io::Read::read_to_string(&mut out, &mut text).ok().map(|_| text)
    })
    .unwrap_or_default();
  let bytes = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
  if !status.success() || bytes == 0 {
    return JobResult::error(
      "capture_failed",
      format!("screencapture exited {status}: {}", stderr.trim()),
    );
  }
  // The daemon opens it by descriptor and refuses anything but a regular
  // file it can read; group-readable is what the mode table gives the tree.
  let _ = fs::set_permissions(&target, fs::Permissions::from_mode(RESULT_FILE_MODE));
  JobResult {
    error: None,
    message: None,
    monitors: Some(monitors.max(1)),
    files: vec![SCREENSHOT_FILE.to_owned()],
  }
}

fn notify(app: &AppHandle, job: &Job) -> JobResult {
  match app.notification().builder().title(&job.title).body(&job.body).show() {
    Ok(()) => JobResult::done(),
    Err(error) => JobResult::error("notify_failed", error.to_string()),
  }
}

/// Carry out one request. `owner_is_root` is whether the daemon wrote it,
/// which is what `trusted` may rest on.
fn run(app: &AppHandle, results: &Path, job: &Job, owner_is_root: bool) -> JobResult {
  match job.kind.as_str() {
    "capture" => {
      let monitors = app.available_monitors().map(|m| m.len()).unwrap_or(1);
      capture(results, job, monitors)
    }
    "notify" => notify(app, job),
    "shell" | "launch" if !(job.trusted && owner_is_root) => {
      JobResult::error("untrusted_job", format!("a {} job must come trusted from the daemon", job.kind))
    }
    other => JobResult::error("unsupported_job", format!("no runner for a {other:?} job on this app")),
  }
}

/// One pass over the jobs directory: every new, acceptable request is run
/// and answered. `seen` keeps a request from running twice while the daemon
/// has not yet removed it.
fn sweep(app: &AppHandle, jobs: &Path, results: &Path, seen: &mut HashSet<String>) {
  let Ok(entries) = fs::read_dir(jobs) else { return };
  let mut present = HashSet::new();
  for entry in entries.flatten() {
    let path = entry.path();
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
    let Some(id) = name.strip_suffix(".json") else { continue };
    present.insert(id.to_owned());
    if seen.contains(id) {
      continue;
    }
    let Ok(meta) = fs::symlink_metadata(&path) else { continue };
    if let Err(refusal) = accept(&meta) {
      log::warn!("ignoring job file {name}: {refusal:?}");
      seen.insert(id.to_owned());
      continue;
    }
    let Ok(raw) = fs::read(&path) else { continue };
    seen.insert(id.to_owned());
    let started = Instant::now();
    let result = match parse(&raw) {
      Ok(job) if job.id == id => run(app, results, &job, meta.uid() == 0),
      Ok(job) => JobResult::error("malformed_job", format!("job id {} does not match its file {name}", job.id)),
      Err(error) => JobResult::error("malformed_job", error),
    };
    if !valid_id(id) {
      log::warn!("job file {name} has no usable id; nothing to answer");
      continue;
    }
    match write_result(results, id, &result) {
      Ok(_) => log::info!(
        "job {id} answered in {} ms{}",
        started.elapsed().as_millis(),
        result.error.as_deref().map(|e| format!(" ({e})")).unwrap_or_default()
      ),
      Err(error) => log::error!("could not write the result for job {id}: {error}"),
    }
  }
  // A request the daemon has removed is done with; forgetting it keeps the
  // set from growing for the life of the process.
  seen.retain(|id| present.contains(id));
}

pub struct JobRunner {
  stop: Arc<AtomicBool>,
}

impl Drop for JobRunner {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::Relaxed);
  }
}

/// Start the runner on its own thread; it ends with the app.
pub fn spawn(app: AppHandle, root: &Path) -> JobRunner {
  let jobs = root.join(JOBS_REL);
  let results = root.join(RESULTS_REL);
  let stop = Arc::new(AtomicBool::new(false));
  let flag = Arc::clone(&stop);
  let spawned = thread::Builder::new().name("owlette-jobs".into()).spawn(move || {
    let mut seen = HashSet::new();
    while !flag.load(Ordering::Relaxed) {
      sweep(&app, &jobs, &results, &mut seen);
      thread::sleep(POLL);
    }
  });
  if let Err(error) = spawned {
    log::error!("could not start the job runner: {error}");
  }
  JobRunner { stop }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("owlette-jobrunner-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch");
    dir
  }

  #[test]
  fn a_request_must_be_a_regular_file_nobody_else_can_write_and_small() {
    let dir = scratch("accept");
    let file = dir.join("a.json");
    fs::write(&file, b"{}").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    assert_eq!(accept(&fs::metadata(&file).unwrap()), Ok(()));
    fs::set_permissions(&file, fs::Permissions::from_mode(0o660)).unwrap();
    assert_eq!(accept(&fs::metadata(&file).unwrap()), Err(Refusal::WritableByOthers));
    assert_eq!(accept(&fs::metadata(&dir).unwrap()), Err(Refusal::NotRegular));
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    fs::write(&file, vec![b' '; REQUEST_LIMIT as usize + 1]).unwrap();
    assert_eq!(accept(&fs::metadata(&file).unwrap()), Err(Refusal::TooLarge));
  }

  #[test]
  fn a_job_needs_a_type_and_a_hex_id() {
    let id = "0123456789abcdef0123456789abcdef";
    let job = parse(format!(r#"{{"id":"{id}","type":"capture","monitor":1,"timeout_s":30,"extra":true}}"#).as_bytes())
      .expect("a job");
    assert_eq!((job.kind.as_str(), job.monitor, job.timeout_s, job.trusted), ("capture", 1, 30, false));
    assert!(parse(br#"{"id":"../etc","type":"capture"}"#).is_err(), "an id is never a path");
    assert!(parse(format!(r#"{{"id":"{id}"}}"#).as_bytes()).is_err(), "no type is malformed");
    assert!(parse(b"not json").is_err());
  }

  #[test]
  fn the_budget_is_bounded_above_and_below() {
    assert_eq!(budget(0), Duration::from_secs(1));
    assert_eq!(budget(30), Duration::from_secs(30));
    assert_eq!(budget(900), JOB_CAP);
  }

  #[test]
  fn a_result_is_written_whole_with_the_seam_modes() {
    let results = scratch("result");
    let id = "0123456789abcdef0123456789abcdef";
    let path = write_result(&results, id, &JobResult::error("unsupported_job", "no runner")).unwrap();
    assert_eq!(path, results.join(id).join(RESULT_FILE));
    let written: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(written["error"], "unsupported_job");
    assert_eq!(written["message"], "no runner");
    assert!(written.get("files").is_none(), "an empty file list is left out");
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, RESULT_FILE_MODE);
    assert_eq!(fs::metadata(results.join(id)).unwrap().permissions().mode() & 0o777, RESULT_DIR_MODE);
    assert!(fs::read_dir(results.join(id)).unwrap().count() == 1, "no temp file is left behind");
  }

  #[test]
  fn a_capture_answers_with_the_screenshot_name_and_the_monitor_count() {
    let done = JobResult {
      error: None,
      message: None,
      monitors: Some(2),
      files: vec![SCREENSHOT_FILE.to_owned()],
    };
    let json = serde_json::to_string(&done).unwrap();
    assert_eq!(json, r#"{"monitors":2,"files":["screenshot.png"]}"#);
  }
}
