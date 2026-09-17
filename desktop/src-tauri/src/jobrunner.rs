//! The POSIX half of the GUI job seam: the runner the resident app serves it with.
//!
//! Off Windows the daemon runs as root with no display of its own, so anything that has to happen
//! where the user can see it — a screen grab, a notification, a command in the session, the spawn
//! of a session binary — is dropped into `<data_root>/ipc/jobs/<id>.json` for this app to execute
//! (`agent/src/osadapter/posix.py`: `run_job` :207, `_write_job` :867, `_read_result` :892). The
//! result goes back into `ipc/results/<id>/result.json`, which the daemon polls and then removes
//! along with whatever the job produced.
//!
//! The queue is group-writable by design — it is how a root daemon reaches a console-user app — so
//! a request is executed only when it is a regular file the daemon itself wrote: owned by the
//! daemon's uid and writable by nobody else. The same rule, spelled out in the task, guards the
//! `stdin_path` a `launch` job hands its child. Everything else is refused with a typed error the
//! daemon surfaces as copy, because a job that hangs costs its caller the whole 120-second cap.
//!
//! `trusted` is the daemon's word that a request may name a program to run: `capture` and `notify`
//! never need it, and `shell` and `launch` are refused without it, the way
//! `session_exec.run_python` refuses unrestricted execution on Windows for a job that does not
//! carry it.

use std::collections::HashSet;
use std::fs::{self, DirBuilder, OpenOptions, Permissions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::paths;
use crate::watchers::{self, WatchHandle};

/// The three seam directories, spelled as `osadapter.posix` spells them.
const JOBS_REL: &str = "ipc/jobs";
const RESULTS_REL: &str = "ipc/results";
/// Where the daemon leaves a `launch` job's stdin payload — never inside the job queue itself.
const SWOOP_REL: &str = "ipc/swoop";

/// What the daemon polls for, and the name `screenshot_capture` expects a grab under.
const RESULT_FILE: &str = "result.json";
const SCREENSHOT_FILE: &str = "screenshot.png";

/// `osadapter.posix.JOB_TIMEOUT_SECONDS`: the seam's cap, and the ceiling on any budget a job
/// names for itself — the daemon stops waiting there, so working past it produces nothing.
const JOB_CAP: Duration = Duration::from_secs(120);

/// Only this app writes a result and only root reads one, so a result directory is tighter than
/// the 0770 queue it sits in. `result.json` and the files beside it are group-readable because
/// the tree's own convention is that the daemon's group can read what the app produces.
const RESULT_DIR_MODE: u32 = 0o750;
const RESULT_FILE_MODE: u32 = 0o640;
const TEMP_FILE_MODE: u32 = 0o600;

/// The uid a request — and a `launch` job's stdin payload — must be written by. The daemon is
/// root on both POSIX platforms; anything else in that group-writable directory is another
/// account's, and this app is the one process that runs as the person at the machine.
const DAEMON_UID: u32 = 0;

/// Ceilings on what a request may hand over: a job file is a small object, and the session bundle
/// swoop passes on stdin is measured in kilobytes.
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_STDIN_BYTES: u64 = 1024 * 1024;
/// What a `shell` job's output is truncated to, per stream.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// Safety net behind the watcher: a request that landed while the watch was being registered, or
/// one left waiting because the runner was at capacity, is picked up here rather than never.
const RESCAN: Duration = Duration::from_secs(2);

/// How often a running `shell` child is checked against its budget.
const CHILD_POLL: Duration = Duration::from_millis(20);

/// Jobs executed at once. The daemon rarely has more than one outstanding, and a bound keeps a
/// flood of requests from becoming a flood of threads; what does not fit waits for the next scan.
const MAX_JOBS_IN_FLIGHT: usize = 4;

/// Typed failures, the vocabulary the daemon renders rather than a stack trace.
const ERR_MALFORMED: &str = "malformed_job";
const ERR_UNSUPPORTED: &str = "unsupported_job";
const ERR_UNTRUSTED: &str = "untrusted_job";
const ERR_CAPTURE: &str = "capture_failed";
const ERR_CAPTURE_UNSUPPORTED: &str = "capture_unsupported";
const ERR_NOTIFY: &str = "notify_failed";
const ERR_SHELL: &str = "shell_failed";
const ERR_LAUNCH: &str = "launch_failed";
const ERR_STDIN: &str = "stdin_rejected";
const ERR_TIMEOUT: &str = "job_timeout";

/// Serial for scratch file names, so two results in flight never share one.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// A request as the daemon writes it. `id` is cross-checked against the file name rather than
/// trusted: the name is what the daemon polls a result under.
#[derive(Debug, Deserialize)]
struct Request {
  id: Option<String>,
  #[serde(default)]
  trusted: bool,
  timeout_s: Option<f64>,
  #[serde(flatten)]
  kind: Kind,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Kind {
  Capture {
    #[serde(default)]
    monitor: i32,
  },
  Notify {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
  },
  Shell {
    #[serde(default)]
    argv: Vec<String>,
    cwd: Option<String>,
  },
  Launch {
    #[serde(default)]
    argv: Vec<String>,
    cwd: Option<String>,
    stdin_path: Option<String>,
  },
  #[serde(other)]
  Unknown,
}

impl Kind {
  /// The wire name, for the `job` field the daemon logs a refusal under.
  fn name(&self) -> &'static str {
    match self {
      Kind::Capture { .. } => "capture",
      Kind::Notify { .. } => "notify",
      Kind::Shell { .. } => "shell",
      Kind::Launch { .. } => "launch",
      Kind::Unknown => "unknown",
    }
  }
}

/// What the daemon reads back. The shape is the Windows user-session executor's, so
/// `screenshot_capture.capture_in_user_session` parses a grab the same way on every platform:
/// `files` are names inside the result directory, and `error` present means failure.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobResult {
  #[serde(skip_serializing_if = "Option::is_none")]
  error: Option<&'static str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  message: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  job: Option<&'static str>,
  files: Vec<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  monitors: Option<i32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  stdout: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  stderr: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  exit_code: Option<i32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pid: Option<u32>,
  duration_ms: u64,
}

/// A refusal with the code the daemon keys on and the sentence a person reads.
#[derive(Debug)]
pub(crate) struct JobFailure {
  code: &'static str,
  message: String,
}

impl JobFailure {
  pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }
}

/// What the runner needs from the session it is resident in, behind a trait so the seam's own
/// behaviour is exercised without a display or a notification service.
pub(crate) trait Session: Send + Sync + 'static {
  /// Show a message to whoever is at the machine.
  fn notify(&self, title: &str, body: &str) -> Result<(), JobFailure>;
  /// Grab `monitor` into `destination`; answers how many monitors the session has.
  fn capture(&self, monitor: i32, destination: &Path, budget: Duration) -> Result<i32, JobFailure>;
}

/// Keeps the runner alive; dropping it stops the watcher and joins the scan thread.
pub struct Handle {
  watch: Option<WatchHandle>,
  ping: Option<mpsc::Sender<()>>,
  worker: Option<thread::JoinHandle<()>>,
}

impl Drop for Handle {
  fn drop(&mut self) {
    // The watcher's sink holds one sender and this handle the other; the scan thread parks on
    // that channel, so both have to go before it can be joined.
    drop(self.watch.take());
    drop(self.ping.take());
    if let Some(worker) = self.worker.take() {
      let _ = worker.join();
    }
  }
}

/// Start serving the job seam under `root` from this app's session.
pub fn spawn(app: AppHandle, root: &Path) -> Result<Handle, String> {
  start(
    Arc::new(Seam::new(
      root.to_path_buf(),
      TauriSession { app },
      DAEMON_UID,
    )),
    RESCAN,
  )
}

pub(crate) fn start<S: Session>(seam: Arc<Seam<S>>, rescan: Duration) -> Result<Handle, String> {
  let (ping, pings) = mpsc::channel();
  let sink = ping.clone();
  let watch = watchers::spawn_directory(&seam.jobs_dir(), move || {
    let _ = sink.send(());
  })
  .map_err(|error| format!("could not watch the job queue: {error}"))?;

  let worker = thread::Builder::new()
    .name("owlette-jobrunner".into())
    .spawn(move || {
      let mut handled: HashSet<String> = HashSet::new();
      // Before the first wait: a request the daemon wrote while this app was starting is already
      // in the queue, and its caller is already counting.
      Seam::scan(&seam, &mut handled);
      // Until both senders are gone — the watcher's and the handle's — which is how the app
      // stops the runner.
      while let Ok(()) | Err(RecvTimeoutError::Timeout) = pings.recv_timeout(rescan) {
        seam.reap();
        Seam::scan(&seam, &mut handled);
      }
    })
    .map_err(|error| format!("could not start the job runner: {error}"))?;

  Ok(Handle {
    watch: Some(watch),
    ping: Some(ping),
    worker: Some(worker),
  })
}

/// The seam as this app sees it: where the queue is, who may fill it, and what runs a job.
pub(crate) struct Seam<S: Session> {
  root: PathBuf,
  session: S,
  /// The uid a request must carry. Production is the daemon's, `DAEMON_UID`.
  daemon_uid: u32,
  in_flight: AtomicUsize,
  /// Children of `launch` jobs, kept only so they are reaped rather than left as zombies; the
  /// daemon owns their lifetime and kills them by the pid the result carries.
  children: Mutex<Vec<Child>>,
}

impl<S: Session> Seam<S> {
  pub(crate) fn new(root: PathBuf, session: S, daemon_uid: u32) -> Self {
    Self {
      root,
      session,
      daemon_uid,
      in_flight: AtomicUsize::new(0),
      children: Mutex::new(Vec::new()),
    }
  }

  fn jobs_dir(&self) -> PathBuf {
    self.root.join(JOBS_REL)
  }

  fn results_dir(&self) -> PathBuf {
    self.root.join(RESULTS_REL)
  }

  /// Execute every request in the queue that has not been executed yet.
  ///
  /// `handled` is what keeps a job to one execution: the daemon removes its request only after
  /// reading the result, so the file is still there for the scans in between.
  fn scan(seam: &Arc<Self>, handled: &mut HashSet<String>) {
    let jobs = seam.jobs_dir();
    let entries = match fs::read_dir(&jobs) {
      Ok(entries) => entries,
      Err(error) if error.kind() == ErrorKind::NotFound => return,
      Err(error) => {
        log::warn!("could not read {}: {error}", jobs.display());
        return;
      }
    };

    let mut present: HashSet<String> = HashSet::new();
    let mut pending: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
      let path = entry.path();
      if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        continue;
      }
      let Some(id) = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_owned)
      else {
        continue;
      };
      if !handled.contains(&id) {
        pending.push((id.clone(), path));
      }
      present.insert(id);
    }
    // A request the daemon has taken away can be forgotten; anything still queued must not be.
    handled.retain(|id| present.contains(id));
    pending.sort();

    for (id, path) in pending {
      if seam.in_flight.load(Ordering::SeqCst) >= MAX_JOBS_IN_FLIGHT {
        break;
      }
      if Self::dispatch(seam, id.clone(), path) {
        handled.insert(id);
      }
    }
  }

  /// Run one request off the scan thread, so a job that takes its whole budget does not hold the
  /// queue against the next one.
  fn dispatch(seam: &Arc<Self>, id: String, path: PathBuf) -> bool {
    seam.in_flight.fetch_add(1, Ordering::SeqCst);
    let running = Arc::clone(seam);
    let job = id.clone();
    match thread::Builder::new()
      .name("owlette-job".into())
      .spawn(move || {
        running.run(&job, &path);
        running.in_flight.fetch_sub(1, Ordering::SeqCst);
      }) {
      Ok(_) => true,
      Err(error) => {
        seam.in_flight.fetch_sub(1, Ordering::SeqCst);
        log::error!("could not start a thread for job {id}: {error}");
        false
      }
    }
  }

  /// Validate, execute and answer one request. Every path through here writes a result: the
  /// daemon is waiting on one, and a silent runner costs it the full cap.
  fn run(&self, id: &str, request: &Path) {
    let started = Instant::now();
    let parsed = match self.read_request(id, request) {
      // Withdrawn while it sat in the queue: the caller gave up and took its request away, so
      // there is nobody to answer and nothing to leave in the seam.
      Ok(None) => {
        log::debug!("job {id} was withdrawn before it ran");
        return;
      }
      Ok(Some(parsed)) => Ok(parsed),
      Err(failure) => Err(failure),
    };

    let directory = self.results_dir().join(id);
    if let Err(error) = create_result_dir(&directory) {
      log::error!(
        "could not create the result directory {}: {error}",
        directory.display()
      );
      return;
    }

    let mut result = match parsed {
      Ok(parsed) => match self.execute(&parsed, &directory) {
        Ok(result) => result,
        Err(failure) => {
          log::warn!(
            "job {id} ({}) refused: {}",
            parsed.kind.name(),
            failure.message
          );
          let mut result = refusal(failure);
          result.job = Some(parsed.kind.name());
          result
        }
      },
      Err(failure) => {
        log::warn!("job {id} refused: {}", failure.message);
        refusal(failure)
      }
    };
    result.duration_ms = started.elapsed().as_millis() as u64;

    if let Err(error) = write_result(&directory, &result) {
      log::error!("could not answer job {id}: {error}");
    }
  }

  /// The request, the refusal it earns, or `None` when it is no longer there to run. Read off a
  /// descriptor on the entry itself: the queue is group-writable, so the file has to be a regular
  /// file the daemon wrote and never a link followed out of the seam or a fifo the read blocks on.
  fn read_request(&self, id: &str, path: &Path) -> Result<Option<Request>, JobFailure> {
    let file = match OpenOptions::new()
      .read(true)
      .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
      .open(path)
    {
      Ok(file) => file,
      Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
      Err(error) => {
        return Err(JobFailure::new(
          ERR_UNTRUSTED,
          format!("could not read the request: {error}"),
        ))
      }
    };
    let meta = file.metadata().map_err(|error| {
      JobFailure::new(
        ERR_UNTRUSTED,
        format!("could not stat the request: {error}"),
      )
    })?;
    if !meta.is_file() {
      return Err(JobFailure::new(
        ERR_UNTRUSTED,
        "the request is not a regular file",
      ));
    }
    if meta.uid() != self.daemon_uid {
      return Err(JobFailure::new(
        ERR_UNTRUSTED,
        format!(
          "the request was written by uid {} rather than the daemon",
          meta.uid()
        ),
      ));
    }
    if meta.mode() & 0o022 != 0 {
      return Err(JobFailure::new(
        ERR_UNTRUSTED,
        format!(
          "the request is writable beyond its owner ({:o})",
          meta.mode() & 0o777
        ),
      ));
    }

    let mut text = String::new();
    file
      .take(MAX_REQUEST_BYTES)
      .read_to_string(&mut text)
      .map_err(|error| JobFailure::new(ERR_MALFORMED, format!("unreadable request: {error}")))?;
    let request: Request = serde_json::from_str(&text)
      .map_err(|error| JobFailure::new(ERR_MALFORMED, format!("unreadable request: {error}")))?;
    if let Some(named) = request.id.as_deref() {
      if named != id {
        return Err(JobFailure::new(
          ERR_MALFORMED,
          format!("the request names job {named} but is queued as {id}"),
        ));
      }
    }
    Ok(Some(request))
  }

  fn execute(&self, request: &Request, directory: &Path) -> Result<JobResult, JobFailure> {
    let budget = budget(request.timeout_s);
    match &request.kind {
      Kind::Capture { monitor } => {
        let destination = directory.join(SCREENSHOT_FILE);
        let monitors = self.session.capture(*monitor, &destination, budget)?;
        Ok(JobResult {
          job: Some("capture"),
          files: vec![SCREENSHOT_FILE.to_string()],
          monitors: Some(monitors),
          ..JobResult::default()
        })
      }
      Kind::Notify { title, body } => {
        if title.trim().is_empty() && body.trim().is_empty() {
          return Err(JobFailure::new(
            ERR_MALFORMED,
            "a notification needs a title or a body",
          ));
        }
        self.session.notify(title, body)?;
        Ok(JobResult {
          job: Some("notify"),
          ..JobResult::default()
        })
      }
      Kind::Shell { argv, cwd } => {
        require_trusted(request, "shell")?;
        run_shell(argv, cwd.as_deref(), budget)
      }
      Kind::Launch {
        argv,
        cwd,
        stdin_path,
      } => {
        require_trusted(request, "launch")?;
        self.launch(argv, cwd.as_deref(), stdin_path.as_deref())
      }
      Kind::Unknown => Err(JobFailure::new(
        ERR_UNSUPPORTED,
        "this job type is not one the app runs",
      )),
    }
  }

  /// Spawn a session binary as a child of this app — which on macOS is what makes the app's
  /// bundle the responsible process for the child's TCC prompts (cross-plan decision C2) — and
  /// answer with its pid, which is the daemon's handle on it from then on.
  fn launch(
    &self,
    argv: &[String],
    cwd: Option<&str>,
    stdin_path: Option<&str>,
  ) -> Result<JobResult, JobFailure> {
    let program = argv
      .first()
      .filter(|program| !program.trim().is_empty())
      .ok_or_else(|| JobFailure::new(ERR_MALFORMED, "a launch job needs an executable"))?;
    let payload = match stdin_path {
      Some(named) => Some(self.read_stdin_payload(named)?),
      None => None,
    };

    let mut command = Command::new(program);
    command
      .args(&argv[1..])
      .stdin(if payload.is_some() {
        Stdio::piped()
      } else {
        Stdio::null()
      })
      // The app has no console of its own to inherit, and a long-lived session binary's output
      // belongs in its own log rather than in this process's.
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    if let Some(cwd) = cwd {
      command.current_dir(cwd);
    }

    let mut child = command.spawn().map_err(|error| {
      JobFailure::new(ERR_LAUNCH, format!("could not spawn {program}: {error}"))
    })?;
    let pid = child.id();

    if let Some((bytes, path)) = payload {
      match child.stdin.take() {
        Some(stdin) => {
          thread::Builder::new()
            .name("owlette-job-stdin".into())
            .spawn(move || feed_stdin(stdin, bytes, path))
            .map_err(|error| {
              JobFailure::new(
                ERR_LAUNCH,
                format!("could not feed {program}'s stdin: {error}"),
              )
            })?;
        }
        None => log::warn!("the launched child has no stdin to feed"),
      }
    }

    if let Ok(mut children) = self.children.lock() {
      children.push(child);
    }
    Ok(JobResult {
      job: Some("launch"),
      pid: Some(pid),
      ..JobResult::default()
    })
  }

  /// The bytes a `launch` job hands its child, and the file they came out of.
  ///
  /// Accepted only from `ipc/swoop/`, owned by the daemon and writable by nobody else: the
  /// payload is a session secret, and the directory it sits in is reachable by the whole group.
  fn read_stdin_payload(&self, named: &str) -> Result<(Vec<u8>, PathBuf), JobFailure> {
    let bundles = self.root.join(SWOOP_REL);
    let path =
      paths::resolve_in_root(&bundles, named).map_err(|error| JobFailure::new(ERR_STDIN, error))?;
    let file = OpenOptions::new()
      .read(true)
      .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
      .open(&path)
      .map_err(|error| {
        JobFailure::new(
          ERR_STDIN,
          format!("could not read {}: {error}", path.display()),
        )
      })?;
    let meta = file.metadata().map_err(|error| {
      JobFailure::new(ERR_STDIN, format!("could not stat the payload: {error}"))
    })?;
    if !meta.is_file() {
      return Err(JobFailure::new(
        ERR_STDIN,
        "the stdin payload is not a regular file",
      ));
    }
    if meta.uid() != self.daemon_uid {
      return Err(JobFailure::new(
        ERR_STDIN,
        format!(
          "the stdin payload was written by uid {} rather than the daemon",
          meta.uid()
        ),
      ));
    }
    if meta.mode() & 0o022 != 0 {
      return Err(JobFailure::new(
        ERR_STDIN,
        format!(
          "the stdin payload is writable beyond its owner ({:o})",
          meta.mode() & 0o777
        ),
      ));
    }
    if meta.len() > MAX_STDIN_BYTES {
      return Err(JobFailure::new(
        ERR_STDIN,
        format!("the stdin payload is {} bytes", meta.len()),
      ));
    }

    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file
      .take(MAX_STDIN_BYTES)
      .read_to_end(&mut bytes)
      .map_err(|error| {
        JobFailure::new(ERR_STDIN, format!("could not read the payload: {error}"))
      })?;
    Ok((bytes, path))
  }

  /// Clear out the `launch` children that have exited, so nothing is left as a zombie for the
  /// life of the app.
  fn reap(&self) {
    let Ok(mut children) = self.children.lock() else {
      return;
    };
    children.retain_mut(|child| matches!(child.try_wait(), Ok(None)));
  }
}

/// A job that names a program to run is executed only when the daemon marked the request trusted.
fn require_trusted(request: &Request, kind: &str) -> Result<(), JobFailure> {
  if request.trusted {
    return Ok(());
  }
  Err(JobFailure::new(
    ERR_UNTRUSTED,
    format!("a {kind} job runs only when the daemon marks it trusted"),
  ))
}

/// The budget a job is held to: its own, capped at the seam's, and the cap when it names none or
/// names one that is not a positive number of seconds.
fn budget(timeout_s: Option<f64>) -> Duration {
  match timeout_s {
    Some(seconds) if seconds.is_finite() && seconds > 0.0 => Duration::try_from_secs_f64(seconds)
      .unwrap_or(JOB_CAP)
      .min(JOB_CAP),
    _ => JOB_CAP,
  }
}

/// Run a command in this session and answer with what it printed.
fn run_shell(
  argv: &[String],
  cwd: Option<&str>,
  budget: Duration,
) -> Result<JobResult, JobFailure> {
  let program = argv
    .first()
    .filter(|program| !program.trim().is_empty())
    .ok_or_else(|| JobFailure::new(ERR_MALFORMED, "a shell job needs a command"))?;

  let mut command = Command::new(program);
  command
    .args(&argv[1..])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  if let Some(cwd) = cwd {
    command.current_dir(cwd);
  }

  let mut child = command
    .spawn()
    .map_err(|error| JobFailure::new(ERR_SHELL, format!("could not run {program}: {error}")))?;
  // Both pipes are drained on their own threads: a child that fills one while this side waits on
  // the other would deadlock until its budget ran out.
  let stdout = child.stdout.take().map(drain);
  let stderr = child.stderr.take().map(drain);

  let deadline = Instant::now() + budget;
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break Some(status),
      Ok(None) => {}
      Err(error) => {
        return Err(JobFailure::new(
          ERR_SHELL,
          format!("could not wait for {program}: {error}"),
        ))
      }
    }
    if Instant::now() >= deadline {
      let _ = child.kill();
      let _ = child.wait();
      break None;
    }
    thread::sleep(CHILD_POLL);
  };

  let stdout = stdout.map(join_drain).unwrap_or_default();
  let stderr = stderr.map(join_drain).unwrap_or_default();
  let Some(status) = status else {
    return Err(JobFailure::new(
      ERR_TIMEOUT,
      format!(
        "{program} did not finish within {}s: {}",
        budget.as_secs_f32(),
        tail(&stderr)
      ),
    ));
  };

  Ok(JobResult {
    job: Some("shell"),
    stdout: Some(stdout),
    stderr: Some(stderr),
    exit_code: Some(status.code().unwrap_or(-1)),
    ..JobResult::default()
  })
}

/// Read one of a child's pipes to EOF, bounded, on a thread of its own.
fn drain<R: Read + Send + 'static>(mut stream: R) -> thread::JoinHandle<String> {
  thread::spawn(move || {
    let mut bytes = Vec::new();
    let _ = stream
      .by_ref()
      .take(MAX_OUTPUT_BYTES as u64)
      .read_to_end(&mut bytes);
    // Whatever is past the cap still has to leave the pipe, or the child blocks writing it.
    let _ = std::io::copy(&mut stream, &mut std::io::sink());
    String::from_utf8_lossy(&bytes).into_owned()
  })
}

fn join_drain(handle: thread::JoinHandle<String>) -> String {
  handle.join().unwrap_or_default()
}

/// The last line or so of a stream, for a refusal's message.
fn tail(text: &str) -> String {
  let trimmed = text.trim_end();
  match trimmed.char_indices().rev().nth(200) {
    Some((at, _)) => format!("…{}", &trimmed[at..]),
    None => trimmed.to_string(),
  }
}

/// Hand the payload to the child and take the file away.
///
/// The unlink follows the write rather than the spawn: the bytes are a session secret sitting in
/// a directory the whole group can read, and the child has them once this side's write returns.
fn feed_stdin(mut stdin: std::process::ChildStdin, bytes: Vec<u8>, path: PathBuf) {
  if let Err(error) = stdin.write_all(&bytes).and_then(|()| stdin.flush()) {
    log::warn!("the launched child did not take its stdin payload: {error}");
  }
  // Closing is what gives the child its EOF.
  drop(stdin);
  if let Err(error) = fs::remove_file(&path) {
    if error.kind() != ErrorKind::NotFound {
      log::warn!("could not remove {}: {error}", path.display());
    }
  }
}

/// The result directory for one job, created inside the queue's own tree.
fn create_result_dir(directory: &Path) -> std::io::Result<()> {
  if let Some(parent) = directory.parent() {
    DirBuilder::new()
      .recursive(true)
      .mode(RESULT_DIR_MODE)
      .create(parent)?;
  }
  match DirBuilder::new().mode(RESULT_DIR_MODE).create(directory) {
    Ok(()) => {}
    Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
    Err(error) => return Err(error),
  }
  // On the descriptor, and never through a link: the queue is group-writable, so an entry under
  // the name we are about to write into is not necessarily the directory we just made. The mode
  // is set explicitly because `mkdir`'s is masked by this process's umask.
  let opened = OpenOptions::new()
    .read(true)
    .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
    .open(directory)?;
  opened.set_permissions(Permissions::from_mode(RESULT_DIR_MODE))
}

/// Write the result the daemon polls for: whole, then moved into place, so a poll never reads a
/// half-written answer.
fn write_result(directory: &Path, result: &JobResult) -> std::io::Result<()> {
  let text = serde_json::to_vec(result)
    .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))?;
  let destination = directory.join(RESULT_FILE);
  let temp = scratch_path(&destination);
  match write_file(&temp, &text) {
    Ok(()) => fs::rename(&temp, &destination),
    Err(error) => {
      let _ = fs::remove_file(&temp);
      Err(error)
    }
  }
}

/// A file inside a result directory, at the mode the daemon reads it under.
fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  match fs::remove_file(path) {
    Ok(()) => {}
    Err(error) if error.kind() == ErrorKind::NotFound => {}
    Err(error) => return Err(error),
  }
  let mut file = OpenOptions::new()
    .write(true)
    .create_new(true)
    .mode(TEMP_FILE_MODE)
    .custom_flags(libc::O_NOFOLLOW)
    .open(path)?;
  file.write_all(bytes)?;
  file.sync_all()?;
  file.set_permissions(Permissions::from_mode(RESULT_FILE_MODE))
}

fn scratch_path(path: &Path) -> PathBuf {
  let name = path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| "result".to_string());
  let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
  path.with_file_name(format!("{name}.{}.{seq}.tmp", std::process::id()))
}

fn refusal(failure: JobFailure) -> JobResult {
  JobResult {
    error: Some(failure.code),
    message: Some(failure.message),
    ..JobResult::default()
  }
}

/// The session this app is resident in.
struct TauriSession {
  app: AppHandle,
}

impl Session for TauriSession {
  fn notify(&self, title: &str, body: &str) -> Result<(), JobFailure> {
    self
      .app
      .notification()
      .builder()
      .title(title)
      .body(body)
      .show()
      .map_err(|error| JobFailure::new(ERR_NOTIFY, format!("the session refused it: {error}")))
  }

  /// Grabs run on the main thread: both arms talk to the window system this app's GUI toolkit
  /// owns there, and neither is safe to call from a worker.
  fn capture(&self, monitor: i32, destination: &Path, budget: Duration) -> Result<i32, JobFailure> {
    let (tx, rx) = mpsc::channel();
    let app = self.app.clone();
    let destination = destination.to_path_buf();
    self
      .app
      .run_on_main_thread(move || {
        let monitors = app
          .available_monitors()
          .map(|monitors| monitors.len() as i32)
          .unwrap_or(1);
        let _ = tx.send(capture_screen(monitor, monitors, &destination).map(|()| monitors));
      })
      .map_err(|error| {
        JobFailure::new(
          ERR_CAPTURE,
          format!("the app's main thread refused the grab: {error}"),
        )
      })?;
    match rx.recv_timeout(budget) {
      Ok(result) => result,
      Err(_) => Err(JobFailure::new(
        ERR_CAPTURE,
        format!("the grab did not finish within {}s", budget.as_secs_f32()),
      )),
    }
  }
}

/// Grab the X11 root window through the toolkit this app already links.
///
/// Spike 0.3 was never run and the kiosk image carries none of the screenshot binaries
/// (`gnome-screenshot`, `import`, `scrot` are all absent on stock Ubuntu 24.04; only `xwd` is
/// there, and it writes XWD rather than PNG), so the grab is taken in process: `gdk` and its
/// pixbuf are already in this crate's dependency tree through tauri's linux stack, which makes
/// this the one route that needs neither a package on the machine nor a new library in the build.
/// On a Wayland session the root-window grab answers nothing, which is the typed refusal the
/// v1 "x11 only" position expects — Task 4.4 turns it into the capability the dashboard renders.
#[cfg(target_os = "linux")]
pub(crate) fn capture_screen(
  monitor: i32,
  monitors: i32,
  destination: &Path,
) -> Result<(), JobFailure> {
  use gdk::prelude::*;

  let display = gdk::Display::default().ok_or_else(|| {
    JobFailure::new(
      ERR_CAPTURE_UNSUPPORTED,
      "this session has no display to grab",
    )
  })?;
  let root = display
    .default_screen()
    .root_window()
    .ok_or_else(|| JobFailure::new(ERR_CAPTURE_UNSUPPORTED, "this session has no root window"))?;

  // Monitor 0 — and anything outside the session's range — is every screen at once, the way
  // `mss` answers `monitors[0]` for the Windows arm of the same operation.
  let area = (monitor >= 1 && monitor <= monitors)
    .then(|| display.monitor(monitor - 1).map(|screen| screen.geometry()))
    .flatten();
  let (x, y, width, height) = match area {
    Some(area) => (area.x(), area.y(), area.width(), area.height()),
    None => (0, 0, root.width(), root.height()),
  };

  let grab = root.pixbuf(x, y, width, height).ok_or_else(|| {
    JobFailure::new(
      ERR_CAPTURE_UNSUPPORTED,
      "the session refused a root-window grab — capture is x11 only in v1",
    )
  })?;
  let png = grab
    .save_to_bufferv("png", &[])
    .map_err(|error| JobFailure::new(ERR_CAPTURE, format!("could not encode the grab: {error}")))?;
  write_file(destination, &png)
    .map_err(|error| JobFailure::new(ERR_CAPTURE, format!("could not write the grab: {error}")))
}

/// Grab through `screencapture`, which is the transport plan decision 5 starts from and spike 0.2
/// — unrun, and unrunnable without a Mac — was to confirm or replace. Task 4.4 owns the answer
/// and the TCC surface around it; this is the arm it replaces if the spike rules the CLI out.
#[cfg(target_os = "macos")]
pub(crate) fn capture_screen(
  monitor: i32,
  monitors: i32,
  destination: &Path,
) -> Result<(), JobFailure> {
  let mut command = Command::new("/usr/sbin/screencapture");
  // No shutter sound, and PNG rather than the default so the daemon reads what
  // `screenshot_capture` expects. The cursor is left out, as `-C` is what asks for it.
  command.args(["-x", "-t", "png"]);
  if monitor >= 1 && monitor <= monitors {
    command.args(["-D", &monitor.to_string()]);
  }
  let output = command.arg(destination).output().map_err(|error| {
    JobFailure::new(ERR_CAPTURE, format!("could not run screencapture: {error}"))
  })?;
  if !output.status.success() {
    return Err(JobFailure::new(
      ERR_CAPTURE,
      format!(
        "screencapture refused the grab: {}",
        tail(&String::from_utf8_lossy(&output.stderr))
      ),
    ));
  }
  if !destination.is_file() {
    return Err(JobFailure::new(
      ERR_CAPTURE_UNSUPPORTED,
      "screencapture wrote nothing — screen recording is not granted",
    ));
  }
  // The child created the file at its own umask; the daemon reads it through the group.
  fs::set_permissions(destination, Permissions::from_mode(RESULT_FILE_MODE)).map_err(|error| {
    JobFailure::new(
      ERR_CAPTURE,
      format!("could not set the grab's mode: {error}"),
    )
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::{json, Value};

  /// A data root of its own per test, removed on drop.
  struct Scratch(PathBuf);

  impl Scratch {
    fn new(label: &str) -> Self {
      let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
      let root = std::env::temp_dir().join(format!(
        "owlette-jobrunner-{}-{label}-{seq}",
        std::process::id()
      ));
      let _ = fs::remove_dir_all(&root);
      for relative in [JOBS_REL, RESULTS_REL, SWOOP_REL] {
        fs::create_dir_all(root.join(relative)).expect("seam directories");
      }
      Self(root)
    }

    /// Queue a request the way the daemon queues one: 0640, owned by whoever runs the test,
    /// which is the uid the seam under test is told to expect.
    fn queue(&self, id: &str, request: &Value) -> PathBuf {
      let path = self.0.join(JOBS_REL).join(format!("{id}.json"));
      fs::write(&path, serde_json::to_vec(request).expect("encode")).expect("queue the request");
      fs::set_permissions(&path, Permissions::from_mode(0o640)).expect("request mode");
      path
    }

    fn result(&self, id: &str) -> Value {
      let path = self.0.join(RESULTS_REL).join(id).join(RESULT_FILE);
      let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("no result at {}: {error}", path.display()));
      serde_json::from_str(&text).expect("a result is json")
    }

    fn result_dir(&self, id: &str) -> PathBuf {
      self.0.join(RESULTS_REL).join(id)
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  /// Stands in for the session: records what was asked of it, and writes a grab the way a real
  /// one would.
  #[derive(Default)]
  struct FakeSession {
    captures: Mutex<Vec<i32>>,
    notifications: Mutex<Vec<(String, String)>>,
    monitors: i32,
    refuse: Option<&'static str>,
  }

  impl Session for FakeSession {
    fn notify(&self, title: &str, body: &str) -> Result<(), JobFailure> {
      if let Some(code) = self.refuse {
        return Err(JobFailure::new(code, "refused"));
      }
      self
        .notifications
        .lock()
        .expect("lock")
        .push((title.to_string(), body.to_string()));
      Ok(())
    }

    fn capture(
      &self,
      monitor: i32,
      destination: &Path,
      _budget: Duration,
    ) -> Result<i32, JobFailure> {
      if let Some(code) = self.refuse {
        return Err(JobFailure::new(code, "refused"));
      }
      self.captures.lock().expect("lock").push(monitor);
      write_file(destination, b"\x89PNG\r\n\x1a\n").expect("write the grab");
      Ok(self.monitors)
    }
  }

  fn seam(scratch: &Scratch, session: FakeSession) -> Arc<Seam<FakeSession>> {
    // The tests are not root, so the uid a request must carry is this account's — the same rule
    // production applies to uid 0.
    Arc::new(Seam::new(
      scratch.0.clone(),
      session,
      // SAFETY: geteuid cannot fail and touches no memory.
      unsafe { libc::geteuid() },
    ))
  }

  fn run_one(scratch: &Scratch, session: FakeSession, id: &str, request: &Value) -> Value {
    let path = scratch.queue(id, request);
    seam(scratch, session).run(id, &path);
    scratch.result(id)
  }

  fn mode_of(path: &Path) -> u32 {
    fs::metadata(path).expect("metadata").mode() & 0o777
  }

  #[test]
  fn a_capture_answers_with_the_grab_and_the_monitor_count() {
    let scratch = Scratch::new("capture");
    let session = FakeSession {
      monitors: 2,
      ..FakeSession::default()
    };

    let result = run_one(
      &scratch,
      session,
      "aaa",
      &json!({ "type": "capture", "monitor": 1, "timeout_s": 8 }),
    );

    assert_eq!(result["files"], json!([SCREENSHOT_FILE]));
    assert_eq!(result["monitors"], json!(2));
    assert!(result.get("error").is_none(), "unexpected: {result}");
    let grab = scratch.result_dir("aaa").join(SCREENSHOT_FILE);
    assert!(grab.is_file());
    assert_eq!(mode_of(&grab), RESULT_FILE_MODE);
    assert_eq!(
      mode_of(&scratch.result_dir("aaa").join(RESULT_FILE)),
      RESULT_FILE_MODE
    );
    assert_eq!(mode_of(&scratch.result_dir("aaa")), RESULT_DIR_MODE);
  }

  #[test]
  fn a_session_that_refuses_a_grab_answers_with_its_own_code() {
    let scratch = Scratch::new("refused");
    let session = FakeSession {
      refuse: Some(ERR_CAPTURE_UNSUPPORTED),
      ..FakeSession::default()
    };

    let result = run_one(&scratch, session, "bbb", &json!({ "type": "capture" }));

    assert_eq!(result["error"], json!(ERR_CAPTURE_UNSUPPORTED));
    assert_eq!(result["job"], json!("capture"));
  }

  #[test]
  fn a_notification_reaches_the_session() {
    let scratch = Scratch::new("notify");
    let session = FakeSession::default();
    let path = scratch.queue(
      "ccc",
      &json!({ "type": "notify", "title": "owlette", "body": "the agent is back" }),
    );
    let seam = seam(&scratch, session);

    seam.run("ccc", &path);

    assert!(scratch.result("ccc").get("error").is_none());
    assert_eq!(
      seam.session.notifications.lock().expect("lock").as_slice(),
      [("owlette".to_string(), "the agent is back".to_string())]
    );
  }

  #[test]
  fn a_notification_with_nothing_to_say_is_refused() {
    let scratch = Scratch::new("emptynotify");
    let result = run_one(
      &scratch,
      FakeSession::default(),
      "ddd",
      &json!({ "type": "notify", "title": "  " }),
    );

    assert_eq!(result["error"], json!(ERR_MALFORMED));
  }

  #[test]
  fn a_request_that_is_not_json_is_answered_rather_than_panicked_on() {
    let scratch = Scratch::new("malformed");
    let path = scratch.0.join(JOBS_REL).join("eee.json");
    fs::write(&path, "{\"type\": \"capture\"").expect("queue");
    fs::set_permissions(&path, Permissions::from_mode(0o640)).expect("mode");

    seam(&scratch, FakeSession::default()).run("eee", &path);

    assert_eq!(scratch.result("eee")["error"], json!(ERR_MALFORMED));
  }

  #[test]
  fn a_request_withdrawn_before_it_ran_is_not_answered() {
    let scratch = Scratch::new("withdrawn");
    let path = scratch.queue("www", &json!({ "type": "capture" }));
    fs::remove_file(&path).expect("withdraw the request");

    seam(&scratch, FakeSession::default()).run("www", &path);

    assert!(
      !scratch.result_dir("www").exists(),
      "a withdrawn request left a result nobody will read"
    );
  }

  #[test]
  fn a_request_naming_another_job_is_refused() {
    let scratch = Scratch::new("idmismatch");
    let result = run_one(
      &scratch,
      FakeSession::default(),
      "fff",
      &json!({ "type": "capture", "id": "ggg" }),
    );

    assert_eq!(result["error"], json!(ERR_MALFORMED));
  }

  #[test]
  fn a_job_type_the_app_does_not_run_is_refused() {
    let scratch = Scratch::new("unknown");
    let result = run_one(
      &scratch,
      FakeSession::default(),
      "hhh",
      &json!({ "type": "mine-bitcoin" }),
    );

    assert_eq!(result["error"], json!(ERR_UNSUPPORTED));
  }

  #[test]
  fn a_request_another_account_wrote_is_refused() {
    let scratch = Scratch::new("foreign");
    let path = scratch.queue("iii", &json!({ "type": "capture" }));
    // The daemon this seam expects is not the account that queued the request.
    let session = FakeSession::default();
    // SAFETY: geteuid cannot fail and touches no memory.
    let stranger = unsafe { libc::geteuid() } + 1;
    let seam = Arc::new(Seam::new(scratch.0.clone(), session, stranger));

    seam.run("iii", &path);

    assert_eq!(scratch.result("iii")["error"], json!(ERR_UNTRUSTED));
    assert!(
      seam.session.captures.lock().expect("lock").is_empty(),
      "a foreign request reached the session"
    );
  }

  #[test]
  fn a_request_the_group_could_rewrite_is_refused() {
    let scratch = Scratch::new("grouprw");
    let path = scratch.queue("jjj", &json!({ "type": "capture" }));
    fs::set_permissions(&path, Permissions::from_mode(0o660)).expect("group-writable");

    seam(&scratch, FakeSession::default()).run("jjj", &path);

    assert_eq!(scratch.result("jjj")["error"], json!(ERR_UNTRUSTED));
  }

  #[test]
  fn a_shell_job_answers_with_its_output_and_exit_code() {
    let scratch = Scratch::new("shell");
    let result = run_one(
      &scratch,
      FakeSession::default(),
      "kkk",
      &json!({
        "type": "shell",
        "trusted": true,
        "argv": ["/bin/sh", "-c", "printf owlette; printf trouble 1>&2; exit 3"],
      }),
    );

    assert_eq!(result["stdout"], json!("owlette"));
    assert_eq!(result["stderr"], json!("trouble"));
    assert_eq!(result["exitCode"], json!(3));
  }

  /// The negative control for the job above: the same command without the daemon's word for it.
  #[test]
  fn an_untrusted_shell_job_is_refused() {
    let scratch = Scratch::new("untrusted");
    let result = run_one(
      &scratch,
      FakeSession::default(),
      "lll",
      &json!({ "type": "shell", "argv": ["/bin/sh", "-c", "exit 0"] }),
    );

    assert_eq!(result["error"], json!(ERR_UNTRUSTED));
  }

  #[test]
  fn a_shell_job_that_outruns_its_budget_is_killed() {
    let scratch = Scratch::new("budget");
    let started = Instant::now();

    let result = run_one(
      &scratch,
      FakeSession::default(),
      "mmm",
      &json!({
        "type": "shell",
        "trusted": true,
        "timeout_s": 0.2,
        "argv": ["/bin/sleep", "30"],
      }),
    );

    assert_eq!(result["error"], json!(ERR_TIMEOUT));
    assert!(
      started.elapsed() < Duration::from_secs(10),
      "the job outlived its budget"
    );
  }

  #[test]
  fn a_launch_job_hands_its_payload_over_and_takes_the_file_away() {
    let scratch = Scratch::new("launch");
    let bundle = scratch.0.join(SWOOP_REL).join("session.json");
    let payload = "s".repeat(4096);
    fs::write(&bundle, &payload).expect("bundle");
    fs::set_permissions(&bundle, Permissions::from_mode(0o640)).expect("bundle mode");
    let received = scratch.0.join("received");

    let result = run_one(
      &scratch,
      FakeSession::default(),
      "nnn",
      &json!({
        "type": "launch",
        "trusted": true,
        "stdin_path": "session.json",
        "argv": ["/bin/sh", "-c", format!("cat > {}; sleep 30", received.display())],
      }),
    );

    let pid = result["pid"].as_u64().expect("a pid") as i32;
    let gone = wait_for(|| !bundle.exists());
    let delivered = wait_for(|| fs::read_to_string(&received).unwrap_or_default().len() == 4096);
    // SAFETY: signal 0 only tests for the process; it delivers nothing.
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    unsafe { libc::kill(pid, libc::SIGKILL) };

    assert!(delivered, "the child never received the payload");
    assert_eq!(fs::read_to_string(&received).expect("payload"), payload);
    assert!(gone, "the payload file outlived the read");
    assert!(alive, "the result named a pid that was not running");
  }

  #[test]
  fn a_launch_job_without_an_executable_is_refused() {
    let scratch = Scratch::new("noexe");
    let result = run_one(
      &scratch,
      FakeSession::default(),
      "ooo",
      &json!({ "type": "launch", "trusted": true, "argv": [] }),
    );

    assert_eq!(result["error"], json!(ERR_MALFORMED));
  }

  #[test]
  fn a_payload_outside_the_bundle_directory_is_refused() {
    let scratch = Scratch::new("escape");
    let elsewhere = scratch.0.join("tokens.enc");
    fs::write(&elsewhere, "secret").expect("seed");

    let result = run_one(
      &scratch,
      FakeSession::default(),
      "ppp",
      &json!({
        "type": "launch",
        "trusted": true,
        "stdin_path": elsewhere.to_string_lossy(),
        "argv": ["/bin/cat"],
      }),
    );

    assert_eq!(result["error"], json!(ERR_STDIN));
    assert!(elsewhere.exists(), "a refused payload was taken away");
  }

  #[test]
  fn a_payload_the_group_could_rewrite_is_refused() {
    let scratch = Scratch::new("payloadmode");
    let bundle = scratch.0.join(SWOOP_REL).join("session.json");
    fs::write(&bundle, "{}").expect("bundle");
    fs::set_permissions(&bundle, Permissions::from_mode(0o660)).expect("group-writable");

    let result = run_one(
      &scratch,
      FakeSession::default(),
      "qqq",
      &json!({
        "type": "launch",
        "trusted": true,
        "stdin_path": "session.json",
        "argv": ["/bin/cat"],
      }),
    );

    assert_eq!(result["error"], json!(ERR_STDIN));
  }

  #[test]
  fn the_seams_cap_is_the_ceiling_on_any_budget() {
    assert_eq!(budget(None), JOB_CAP);
    assert_eq!(budget(Some(7.0)), Duration::from_secs(7));
    assert_eq!(budget(Some(600.0)), JOB_CAP);
    assert_eq!(budget(Some(-1.0)), JOB_CAP);
    assert_eq!(budget(Some(f64::NAN)), JOB_CAP);
  }

  #[test]
  fn a_queued_request_is_answered_once() {
    let scratch = Scratch::new("queue");
    let seam = seam(&scratch, FakeSession::default());
    let runner = start(Arc::clone(&seam), Duration::from_millis(100)).expect("start the runner");

    scratch.queue("rrr", &json!({ "type": "capture" }));
    assert!(
      wait_for(|| scratch.result_dir("rrr").join(RESULT_FILE).is_file()),
      "the runner never answered the request"
    );
    // The daemon leaves its request in place until it has read the result, so every scan in
    // between sees it again.
    thread::sleep(Duration::from_millis(300));
    drop(runner);

    assert_eq!(
      seam.session.captures.lock().expect("lock").len(),
      1,
      "the request ran more than once"
    );
  }

  fn wait_for(mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
      if done() {
        return true;
      }
      thread::sleep(Duration::from_millis(10));
    }
    false
  }
}
