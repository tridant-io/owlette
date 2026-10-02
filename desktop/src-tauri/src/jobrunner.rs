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
//! else in the group. A `launch` starts this app's own swoop sidecar for the
//! daemon ([`launch`]); a `shell` has no runner and is answered
//! `unsupported_job` — a typed refusal, never a panic and never silence,
//! because the daemon waits on the result for its budget and a missing one
//! costs it the whole wait.
//!
//! Polled at [`POLL`] rather than watched: the daemon's own poll on the result
//! is 100 ms and its handover allowance 5 s, so a request is seen within a
//! tenth of a second and nothing here needs a second file watcher.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Write};
use std::os::fd::OwnedFd;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
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

/// The launch job's allow-lists (swoop-macos context.md, "the launch job
/// contract"): a program is a name looked up beside this app, never a path.
const LAUNCH_PROGRAMS: [&str; 1] = ["owlette-swoop"];
const LAUNCH_ARGS: [&str; 5] = ["run", "probe", "version", "selfcheck", "--force"];
const LAUNCH_ARGS_MAX: usize = 4;
const LAUNCH_ENV: &str = "OWLETTE_SWOOP_LOG";
const LAUNCH_ENV_VALUES: [&str; 2] = ["debug", "trace"];
/// The daemon's socket and the exit file live here; the child's stderr goes
/// under the logs one.
const SWOOP_IPC_REL: &str = "ipc/swoop";
const SWOOP_LOGS_REL: &str = "logs/swoop";
const EXIT_FILE_SUFFIX: &str = ".exit.json";

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
  /// A launch: a name from [`LAUNCH_PROGRAMS`], what it is given, and the
  /// three paths the contract names.
  #[serde(default)]
  pub program: String,
  #[serde(default)]
  pub args: Vec<String>,
  #[serde(default)]
  pub env: HashMap<String, String>,
  #[serde(default)]
  pub socket: PathBuf,
  #[serde(default)]
  pub stderr: PathBuf,
  #[serde(default)]
  pub exit_file: PathBuf,
}

/// What goes into `result.json`: the daemon reads `error` first, then
/// `files` and `monitors` for a capture, `pid` for a launch.
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
  #[serde(skip_serializing_if = "Option::is_none")]
  pub pid: Option<u32>,
}

impl JobResult {
  pub fn error(code: &str, message: impl Into<String>) -> Self {
    Self {
      error: Some(code.to_owned()),
      message: Some(message.into()),
      monitors: None,
      files: Vec::new(),
      pid: None,
    }
  }

  pub fn done() -> Self {
    Self {
      error: None,
      message: None,
      monitors: None,
      files: Vec::new(),
      pid: None,
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
    pid: None,
  }
}

fn notify(app: &AppHandle, job: &Job) -> JobResult {
  match app.notification().builder().title(&job.title).body(&job.body).show() {
    Ok(()) => JobResult::done(),
    Err(error) => JobResult::error("notify_failed", error.to_string()),
  }
}

fn untrusted(job: &Job) -> JobResult {
  JobResult::error("untrusted_job", format!("a {} job must come trusted from the daemon", job.kind))
}

/// A launch that passed every rule, with its paths as they resolved.
struct Checked {
  program: PathBuf,
  socket: PathBuf,
  stderr: PathBuf,
  exit_file: PathBuf,
}

/// Run a `launch` job: start this app's own swoop sidecar with its stdin and
/// stdout on the daemon's socket, so the child is this app's and macOS
/// credits it with this app's Screen Recording and Accessibility grants
/// (swoop-macos decision 3). An app holding those grants must never become a
/// general launcher, so every rule of the contract is checked before
/// anything runs: the program is a name looked up in `program_dir`, the
/// arguments and the environment are allow-lists, and each path must land,
/// links followed, directly in its one directory under `root`. Production
/// passes this app's own directory and uid 0 (the daemon's socket is root's);
/// the tests pass their own.
pub fn launch(job: &Job, owner_is_root: bool, root: &Path, program_dir: &Path, socket_uid: u32) -> JobResult {
  if !(job.trusted && owner_is_root) {
    return untrusted(job);
  }
  let checked = match check_launch(job, root, program_dir, socket_uid) {
    Ok(checked) => checked,
    Err(refusal) => return refusal,
  };
  match start(job, &checked) {
    Ok(pid) => JobResult {
      pid: Some(pid),
      ..JobResult::done()
    },
    Err(message) => JobResult::error("launch_failed", message),
  }
}

fn check_launch(job: &Job, root: &Path, program_dir: &Path, socket_uid: u32) -> Result<Checked, JobResult> {
  let refused = |message: String| JobResult::error("launch_refused", message);
  if !LAUNCH_PROGRAMS.contains(&job.program.as_str()) {
    return Err(refused(format!("{:?} is not a program this app launches", job.program)));
  }
  if job.args.len() > LAUNCH_ARGS_MAX {
    return Err(refused(format!("{} arguments, at most {LAUNCH_ARGS_MAX}", job.args.len())));
  }
  if let Some(arg) = job.args.iter().find(|arg| !LAUNCH_ARGS.contains(&arg.as_str())) {
    return Err(refused(format!("{arg:?} is not an argument this app passes")));
  }
  if let Some((key, value)) = job
    .env
    .iter()
    .find(|(key, value)| key.as_str() != LAUNCH_ENV || !LAUNCH_ENV_VALUES.contains(&value.as_str()))
  {
    return Err(refused(format!("{key}={value:?} is not a setting this app passes")));
  }
  let socket = resolve_in(&job.socket, &root.join(SWOOP_IPC_REL))
    .and_then(|socket| check_socket(socket, socket_uid))
    .map_err(|message| JobResult::error("socket_rejected", message))?;
  let stderr = resolve_in(&job.stderr, &root.join(SWOOP_LOGS_REL)).map_err(refused)?;
  // a fifo would hold the open, and with it this runner, until someone reads it
  if fs::symlink_metadata(&stderr).is_ok_and(|meta| !meta.is_file()) {
    return Err(refused(format!("{} is not a regular file", stderr.display())));
  }
  let exit_file = resolve_in(&job.exit_file, &root.join(SWOOP_IPC_REL)).map_err(refused)?;
  if !exit_file
    .file_name()
    .and_then(|name| name.to_str())
    .is_some_and(|name| name.ends_with(EXIT_FILE_SUFFIX))
  {
    return Err(refused(format!("{} is not an exit file", job.exit_file.display())));
  }
  let program = program_dir.join(&job.program);
  // a bare name would be looked up on PATH, which is exactly what this rules out
  if !program.is_absolute() {
    return Err(JobResult::error("launch_failed", "this app's own directory is unknown"));
  }
  Ok(Checked {
    program,
    socket,
    stderr,
    exit_file,
  })
}

/// `path` with every link followed, provided it lands directly in `dir`
/// (itself resolved). A file that does not exist yet resolves through its
/// directory; a link to nowhere is refused, since opening it would create its
/// target wherever that is.
fn resolve_in(path: &Path, dir: &Path) -> Result<PathBuf, String> {
  let expected = fs::canonicalize(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
  let resolved = match fs::canonicalize(path) {
    Ok(resolved) => resolved,
    Err(error) if error.kind() == ErrorKind::NotFound && fs::symlink_metadata(path).is_err() => {
      match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => fs::canonicalize(parent)
          .map_err(|error| format!("{}: {error}", path.display()))?
          .join(name),
        _ => return Err(format!("{path:?} names no file")),
      }
    }
    Err(error) => return Err(format!("{}: {error}", path.display())),
  };
  if resolved.parent() == Some(expected.as_path()) {
    Ok(resolved)
  } else {
    Err(format!("{} is not in {}", path.display(), dir.display()))
  }
}

/// The daemon's socket: a socket, `uid`'s, and not writable by everyone.
fn check_socket(socket: PathBuf, uid: u32) -> Result<PathBuf, String> {
  let meta = fs::symlink_metadata(&socket).map_err(|error| format!("{}: {error}", socket.display()))?;
  if !meta.file_type().is_socket() {
    return Err(format!("{} is not a socket", socket.display()));
  }
  if meta.uid() != uid {
    return Err(format!("{} belongs to uid {}, not {uid}", socket.display(), meta.uid()));
  }
  if meta.mode() & 0o002 != 0 {
    return Err(format!("{} is writable by everyone", socket.display()));
  }
  Ok(socket)
}

/// Spawn a checked launch and answer its pid; a thread keeps its exit.
fn start(job: &Job, checked: &Checked) -> Result<u32, String> {
  let stderr = fs::OpenOptions::new()
    .append(true)
    .create(true)
    .mode(RESULT_FILE_MODE)
    .custom_flags(libc::O_NOFOLLOW)
    .open(&checked.stderr)
    .map_err(|error| format!("could not open {}: {error}", checked.stderr.display()))?;
  let connection = UnixStream::connect(&checked.socket)
    .map_err(|error| format!("could not connect to {}: {error}", checked.socket.display()))?;
  let reading = connection
    .try_clone()
    .map_err(|error| format!("could not share the connection: {error}"))?;
  let mut command = Command::new(&checked.program);
  // the rest of the environment is this app's own, which carries
  // OWLETTE_DATA_ROOT when it is set; the job can only add the log level
  command
    .args(&job.args)
    .envs(&job.env)
    .stdin(Stdio::from(OwnedFd::from(reading)))
    .stdout(Stdio::from(OwnedFd::from(connection)))
    .stderr(Stdio::from(stderr))
    .current_dir("/")
    .process_group(0);
  let spawned = command.spawn();
  // the command holds both copies of the connection until it goes, and the
  // daemon reads end of file only once the child's are the last ones left
  drop(command);
  let mut child = spawned.map_err(|error| format!("could not start {}: {error}", checked.program.display()))?;
  let pid = child.id();
  log::info!("launched {} {:?} as pid {pid}", job.program, job.args);
  let exit_file = checked.exit_file.clone();
  let watch = thread::Builder::new().name("owlette-launch".into()).spawn(move || match child.wait() {
    Ok(status) => {
      let code = exit_code(status);
      log::info!("launched pid {pid} exited {code}");
      if let Err(error) = write_exit(&exit_file, pid, code) {
        log::error!("could not write the exit file for pid {pid}: {error}");
      }
    }
    Err(error) => log::error!("could not wait for launched pid {pid}: {error}"),
  });
  if let Err(error) = watch {
    log::error!("could not watch launched pid {pid} for its exit: {error}");
  }
  Ok(pid)
}

/// The exit status, or 128 plus the signal that ended the child.
fn exit_code(status: ExitStatus) -> i32 {
  status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

/// Write `{"pid": n, "code": c}` whole and move it into place over `path`:
/// the daemon falls back to it when the child left no `exiting` line.
fn write_exit(path: &Path, pid: u32, code: i32) -> std::io::Result<()> {
  let mut temp = path.as_os_str().to_owned();
  temp.push(format!(".{}.tmp", std::process::id()));
  let bytes = serde_json::to_vec(&serde_json::json!({ "pid": pid, "code": code })).map_err(std::io::Error::other)?;
  {
    let mut file = fs::OpenOptions::new()
      .write(true)
      .create(true)
      .truncate(true)
      .mode(RESULT_FILE_MODE)
      .custom_flags(libc::O_NOFOLLOW)
      .open(&temp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
  }
  fs::rename(&temp, path)
}

/// Carry out one request. `owner_is_root` is whether the daemon wrote it,
/// which is what `trusted` may rest on.
fn run(app: &AppHandle, root: &Path, results: &Path, job: &Job, owner_is_root: bool) -> JobResult {
  match job.kind.as_str() {
    "capture" => {
      let monitors = app.available_monitors().map(|m| m.len()).unwrap_or(1);
      capture(results, job, monitors)
    }
    "notify" => notify(app, job),
    "launch" => {
      let exe = std::env::current_exe().ok();
      let program_dir = exe.as_deref().and_then(Path::parent).unwrap_or(Path::new(""));
      launch(job, owner_is_root, root, program_dir, 0)
    }
    "shell" if !(job.trusted && owner_is_root) => untrusted(job),
    other => JobResult::error("unsupported_job", format!("no runner for a {other:?} job on this app")),
  }
}

/// One pass over the jobs directory: every new, acceptable request is run
/// and answered. `seen` keeps a request from running twice while the daemon
/// has not yet removed it.
fn sweep(app: &AppHandle, root: &Path, jobs: &Path, results: &Path, seen: &mut HashSet<String>) {
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
      Ok(job) if job.id == id => run(app, root, results, &job, meta.uid() == 0),
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
  let root = root.to_path_buf();
  let stop = Arc::new(AtomicBool::new(false));
  let flag = Arc::clone(&stop);
  let spawned = thread::Builder::new().name("owlette-jobs".into()).spawn(move || {
    let mut seen = HashSet::new();
    while !flag.load(Ordering::Relaxed) {
      sweep(&app, &root, &jobs, &results, &mut seen);
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
      pid: None,
    };
    let json = serde_json::to_string(&done).unwrap();
    assert_eq!(json, r#"{"monitors":2,"files":["screenshot.png"]}"#);
  }

  #[test]
  fn a_launch_answers_with_the_pid_alone() {
    let done = JobResult {
      pid: Some(4242),
      ..JobResult::done()
    };
    assert_eq!(serde_json::to_string(&done).unwrap(), r#"{"pid":4242}"#);
  }

  #[test]
  fn an_exit_code_is_the_status_or_128_plus_the_signal() {
    assert_eq!(exit_code(ExitStatus::from_raw(3 << 8)), 3);
    assert_eq!(exit_code(ExitStatus::from_raw(0)), 0);
    assert_eq!(exit_code(ExitStatus::from_raw(libc::SIGKILL)), 128 + libc::SIGKILL);
  }

  mod launching {
    use super::*;
    use serde_json::json;
    use std::io::Read;
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::AtomicUsize;
    use std::time::{SystemTime, UNIX_EPOCH};

    const ID: &str = "0123456789abcdef0123456789abcdef";
    /// The stand-in sidecar: echoes 4 KB, says on stderr what it was given
    /// and where it runs, and exits 3.
    const SCRIPT: &str = "#!/bin/sh\nhead -c 4096\necho \"$*|$OWLETTE_SWOOP_LOG|$(pwd)\" >&2\nexit 3\n";

    /// A fresh data root with the two swoop directories and a `bin` holding
    /// the stand-in sidecar. Under `/tmp` rather than the temp dir: a socket
    /// path is at most 104 bytes on macOS and `$TMPDIR` there is half that.
    /// Never removed, because nothing here deletes a tree.
    fn data_root(name: &str) -> PathBuf {
      static NEXT: AtomicUsize = AtomicUsize::new(0);
      let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos();
      let next = NEXT.fetch_add(1, Ordering::Relaxed);
      let root = PathBuf::from(format!("/tmp/owj-{name}-{}-{next}-{nanos}", std::process::id()));
      for dir in [SWOOP_IPC_REL, SWOOP_LOGS_REL, "bin"] {
        fs::create_dir_all(root.join(dir)).expect("a scratch root");
      }
      let script = root.join("bin").join("owlette-swoop");
      fs::write(&script, SCRIPT).unwrap();
      fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
      root
    }

    /// Listen where the daemon would, with the mode it gives the socket.
    fn listen(path: &Path) -> UnixListener {
      let listener = UnixListener::bind(path).expect("a socket");
      fs::set_permissions(path, fs::Permissions::from_mode(0o660)).unwrap();
      listener
    }

    /// The daemon's request against `root`, as context.md spells it.
    fn request(root: &Path) -> serde_json::Value {
      json!({
        "id": ID, "type": "launch", "trusted": true, "program": "owlette-swoop", "args": ["run"],
        "socket": root.join(SWOOP_IPC_REL).join("s.sock"),
        "stderr": root.join(SWOOP_LOGS_REL).join("owlette-swoop.err.log"),
        "exit_file": root.join(SWOOP_IPC_REL).join(format!("{ID}.exit.json")),
        "env": {"OWLETTE_SWOOP_LOG": "debug"}, "timeout_s": 10,
      })
    }

    fn uid(root: &Path) -> u32 {
      fs::metadata(root).unwrap().uid()
    }

    /// Launch `request` from `root` as the daemon's, with one field replaced.
    fn launch_with(root: &Path, key: &str, value: serde_json::Value) -> JobResult {
      let mut request = request(root);
      request[key] = value;
      let job = parse(&serde_json::to_vec(&request).unwrap()).expect("a job");
      launch(&job, true, root, &root.join("bin"), uid(root))
    }

    fn assert_refused(result: &JobResult, code: &str, case: &str) {
      assert_eq!(result.error.as_deref(), Some(code), "{case}: {result:?}");
      assert_eq!(result.pid, None, "{case}: nothing ran");
    }

    #[test]
    fn only_a_trusted_request_of_roots_is_launched() {
      let root = data_root("trust");
      let _socket = listen(&root.join(SWOOP_IPC_REL).join("s.sock"));
      assert_refused(&launch_with(&root, "trusted", json!(false)), "untrusted_job", "not trusted");
      let job = parse(&serde_json::to_vec(&request(&root)).unwrap()).unwrap();
      let result = launch(&job, false, &root, &root.join("bin"), uid(&root));
      assert_refused(&result, "untrusted_job", "trusted, but not root's");
    }

    #[test]
    fn the_program_arguments_and_environment_are_allow_lists() {
      let root = data_root("lists");
      let _socket = listen(&root.join(SWOOP_IPC_REL).join("s.sock"));
      let script = root.join("bin").join("owlette-swoop");
      for (key, value, case) in [
        ("program", json!("sh"), "another program"),
        ("program", json!("/bin/sh"), "a path"),
        ("program", json!(script), "a path to the sidecar itself"),
        ("program", json!("../bin/owlette-swoop"), "a relative path to the sidecar"),
        ("program", json!(""), "no program"),
        ("args", json!(["run", "run", "run", "run", "run"]), "five arguments"),
        ("args", json!(["run", "--log=/etc/x"]), "an argument off the list"),
        ("env", json!({"OWLETTE_SWOOP_LOG": "info"}), "a log level off the list"),
        ("env", json!({"OWLETTE_DATA_ROOT": "/tmp"}), "the data root from the job"),
        ("env", json!({"DYLD_INSERT_LIBRARIES": "/tmp/x.dylib"}), "any other variable"),
      ] {
        assert_refused(&launch_with(&root, key, value), "launch_refused", case);
      }
    }

    #[test]
    fn the_socket_must_be_the_daemons_socket_in_its_directory() {
      let root = data_root("socket");
      let away = data_root("socket-away");
      let ipc = root.join(SWOOP_IPC_REL);
      let _socket = listen(&ipc.join("s.sock"));
      let _open = listen(&ipc.join("w.sock"));
      fs::set_permissions(ipc.join("w.sock"), fs::Permissions::from_mode(0o666)).unwrap();
      fs::write(ipc.join("f.sock"), "").unwrap();
      let _elsewhere = listen(&away.join(SWOOP_IPC_REL).join("s.sock"));
      let _beside = listen(&root.join("ipc").join("s.sock"));
      for (value, case) in [
        (json!(ipc.join("f.sock")), "a regular file"),
        (json!(ipc.join("w.sock")), "writable by everyone"),
        (json!(ipc.join("none.sock")), "nothing there"),
        (json!(away.join(SWOOP_IPC_REL).join("s.sock")), "another tree's"),
        (json!(ipc.join("..").join("s.sock")), "one directory up"),
        (json!(""), "no socket"),
      ] {
        assert_refused(&launch_with(&root, "socket", value), "socket_rejected", case);
      }
      let job = parse(&serde_json::to_vec(&request(&root)).unwrap()).unwrap();
      let result = launch(&job, true, &root, &root.join("bin"), uid(&root).wrapping_add(1));
      assert_refused(&result, "socket_rejected", "another uid's");
    }

    #[test]
    fn the_stderr_and_exit_files_must_be_in_their_directories() {
      let root = data_root("files");
      let _socket = listen(&root.join(SWOOP_IPC_REL).join("s.sock"));
      let (ipc, logs) = (root.join(SWOOP_IPC_REL), root.join(SWOOP_LOGS_REL));
      for (key, value, case) in [
        ("stderr", json!(ipc.join("owlette-swoop.err.log")), "stderr in the ipc directory"),
        ("stderr", json!(root.join("owlette-swoop.err.log")), "stderr at the root"),
        ("stderr", json!(logs), "stderr as the directory itself"),
        ("stderr", json!(""), "no stderr"),
        ("exit_file", json!(ipc.join("x.json")), "an exit file by another name"),
        ("exit_file", json!(logs.join(format!("{ID}.exit.json"))), "an exit file in the logs"),
        ("exit_file", json!(""), "no exit file"),
      ] {
        assert_refused(&launch_with(&root, key, value), "launch_refused", case);
      }
      // a fifo would hold the open, and the runner with it, until someone read it
      let fifo = logs.join("fifo.log");
      assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
      assert_refused(&launch_with(&root, "stderr", json!(fifo)), "launch_refused", "a fifo");
    }

    #[test]
    fn a_path_that_leaves_the_tree_through_a_link_is_refused() {
      let root = data_root("link");
      let away = data_root("link-away");
      let (ipc, logs) = (root.join(SWOOP_IPC_REL), root.join(SWOOP_LOGS_REL));
      let (away_ipc, away_logs) = (away.join(SWOOP_IPC_REL), away.join(SWOOP_LOGS_REL));
      let _socket = listen(&ipc.join("s.sock"));
      let _there = listen(&away_ipc.join("s.sock"));
      fs::write(away_logs.join("e.log"), "").unwrap();
      symlink(away_ipc.join("s.sock"), ipc.join("l.sock")).unwrap();
      symlink(&away_ipc, ipc.join("sub")).unwrap();
      symlink(away_logs.join("e.log"), logs.join("l.log")).unwrap();
      symlink(away_logs.join("new.log"), logs.join("dangling.log")).unwrap();
      for (key, value, code, case) in [
        ("socket", json!(ipc.join("l.sock")), "socket_rejected", "a linked socket"),
        ("socket", json!(ipc.join("sub").join("s.sock")), "socket_rejected", "a socket under a linked directory"),
        ("stderr", json!(logs.join("l.log")), "launch_refused", "a linked stderr"),
        ("stderr", json!(logs.join("dangling.log")), "launch_refused", "a link to nowhere"),
        ("exit_file", json!(ipc.join("sub").join(format!("{ID}.exit.json"))), "launch_refused", "an exit file under a linked directory"),
      ] {
        assert_refused(&launch_with(&root, key, value), code, case);
      }
      assert!(!away_logs.join("new.log").exists(), "a link to nowhere never creates its target");
      assert_eq!(fs::read(away_logs.join("e.log")).unwrap(), b"", "nothing was written through the link");
    }

    #[test]
    fn a_failed_connect_or_spawn_is_launch_failed() {
      let root = data_root("fail");
      // a socket nobody listens on any more: the file stays, the connect fails
      drop(listen(&root.join(SWOOP_IPC_REL).join("s.sock")));
      assert_refused(&launch_with(&root, "args", json!(["run"])), "launch_failed", "no listener");

      let root = data_root("fail-spawn");
      let _socket = listen(&root.join(SWOOP_IPC_REL).join("s.sock"));
      let job = parse(&serde_json::to_vec(&request(&root)).unwrap()).unwrap();
      let empty = root.join("ipc");
      let result = launch(&job, true, &root, &empty, uid(&root));
      assert_refused(&result, "launch_failed", "no sidecar beside the app");
      let result = launch(&job, true, &root, Path::new(""), uid(&root));
      assert_refused(&result, "launch_failed", "no directory, so never a PATH lookup");
    }

    #[test]
    fn a_launch_runs_the_sidecar_on_the_socket_and_keeps_no_copy_of_it() {
      let root = data_root("echo");
      let ipc = root.join(SWOOP_IPC_REL);
      // twice: the second run appends to the log the first one created
      for run in ["a", "b"] {
        let listener = listen(&ipc.join(format!("{run}.sock")));
        let exit_file = ipc.join(format!("{run}{EXIT_FILE_SUFFIX}"));
        let mut request = request(&root);
        request["socket"] = json!(ipc.join(format!("{run}.sock")));
        request["exit_file"] = json!(exit_file);
        let job = parse(&serde_json::to_vec(&request).unwrap()).unwrap();
        let result = launch(&job, true, &root, &root.join("bin"), uid(&root));
        assert_eq!(result.error, None, "{result:?}");
        let pid = result.pid.expect("a pid");

        let (mut connection, _) = listener.accept().unwrap();
        // this side never shuts its write half, so end of file can only mean
        // every other copy is gone: the child's by its exit, and this app's
        // right after the spawn. a copy kept here would time the read out.
        connection.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let sent: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        connection.write_all(&sent).unwrap();
        let mut echoed = Vec::new();
        connection.read_to_end(&mut echoed).expect("end of file when the sidecar exits");
        assert_eq!(echoed, sent);

        let deadline = Instant::now() + Duration::from_secs(10);
        while !exit_file.exists() && Instant::now() < deadline {
          thread::sleep(Duration::from_millis(20));
        }
        let written: serde_json::Value = serde_json::from_slice(&fs::read(&exit_file).expect("the exit file")).unwrap();
        assert_eq!(written, json!({"pid": pid, "code": 3}));
        assert_eq!(fs::metadata(&exit_file).unwrap().permissions().mode() & 0o777, RESULT_FILE_MODE);
      }
      let mut left: Vec<_> = fs::read_dir(&ipc)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
      left.sort();
      assert_eq!(left, ["a.exit.json", "a.sock", "b.exit.json", "b.sock"], "no temp file is left behind");

      let stderr = root.join(SWOOP_LOGS_REL).join("owlette-swoop.err.log");
      assert_eq!(fs::read_to_string(&stderr).unwrap(), "run|debug|/\n".repeat(2), "appended, run from /");
      assert_eq!(fs::metadata(&stderr).unwrap().permissions().mode() & 0o777, RESULT_FILE_MODE);
    }
  }
}
