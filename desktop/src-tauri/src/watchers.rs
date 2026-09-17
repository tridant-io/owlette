//! Directory watchers for the three seam files the service publishes, and for the job queue the
//! service fills off Windows.
//!
//! `config.json`, `tmp/app_states.json` and `tmp/service_status.json` are never written in place —
//! both sides scratch-write and rename over the target (`shared_utils.write_json_to_file`). A watch
//! on the file itself stops firing after the first replace, so we watch the parent directories and
//! filter by path. Replaces the legacy GUI's one-second poll loop.
//!
//! Deliberately free of Tauri types — it takes a sink closure, so the plumbing is unit-testable
//! without an app handle.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::paths::{self, APP_STATES_REL, CONFIG_REL, SERVICE_STATUS_REL};

/// Quiet period before reporting. One atomic replace fires several raw events (create, write,
/// rename); trailing-edge coalescing collapses them into one notification that sees a finished file.
const DEBOUNCE: Duration = Duration::from_millis(120);

/// Seam file a change refers to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OwletteFile {
  Config,
  AppStates,
  ServiceStatus,
}

impl OwletteFile {
  const ALL: [OwletteFile; 3] = [
    OwletteFile::Config,
    OwletteFile::AppStates,
    OwletteFile::ServiceStatus,
  ];

  /// Path of this file relative to the data root.
  pub fn relative_path(self) -> &'static str {
    match self {
      OwletteFile::Config => CONFIG_REL,
      OwletteFile::AppStates => APP_STATES_REL,
      OwletteFile::ServiceStatus => SERVICE_STATUS_REL,
    }
  }
}

/// Payload emitted to the frontend when a seam file changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
  pub file: OwletteFile,
  /// Absolute, so the frontend can hand it straight to the JSON commands.
  pub path: String,
  /// Unix milliseconds at which the change was reported.
  pub at: u64,
}

/// Keeps the watcher alive; dropping it stops watching and joins the debounce thread.
pub struct WatchHandle {
  watcher: Option<RecommendedWatcher>,
  worker: Option<thread::JoinHandle<()>>,
}

impl Drop for WatchHandle {
  fn drop(&mut self) {
    // Order is load-bearing: the debounce thread parks on the channel whose sender the watcher
    // holds, so the watcher must drop INSIDE this body. Field-order drop would join a thread that
    // was never told to stop, and deadlock.
    drop(self.watcher.take());
    if let Some(worker) = self.worker.take() {
      let _ = worker.join();
    }
  }
}

/// Start watching the owlette data root, reporting changes to `sink`. Missing directories are
/// created — the app can launch before the service ever has, and `ReadDirectoryChangesW` cannot
/// register against a directory that does not exist.
pub fn spawn<F>(root: &Path, sink: F) -> notify::Result<WatchHandle>
where
  F: Fn(FileChange) + Send + 'static,
{
  let targets: Vec<Target> = OwletteFile::ALL
    .iter()
    .map(|file| {
      let path = root.join(file.relative_path());
      Target {
        file: *file,
        key: paths::compare_key(&path),
        path,
      }
    })
    .collect();

  let mut directories: BTreeSet<PathBuf> = BTreeSet::new();
  for target in &targets {
    if let Some(parent) = target.path.parent() {
      directories.insert(parent.to_path_buf());
    }
  }

  let (tx, rx) = mpsc::channel();
  let mut watcher = notify::recommended_watcher(tx)?;
  for directory in &directories {
    if let Err(error) = std::fs::create_dir_all(directory) {
      log::warn!(
        "could not create {} for watching: {error}",
        directory.display()
      );
    }
    watcher.watch(directory, RecursiveMode::NonRecursive)?;
  }

  let worker = thread::Builder::new()
    .name("owlette-watchers".into())
    .spawn(move || {
      let mut pending: BTreeSet<OwletteFile> = BTreeSet::new();
      let mut deadline: Option<Instant> = None;

      loop {
        let received = match deadline {
          None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
          Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
        };

        match received {
          Ok(Ok(event)) => {
            for path in &event.paths {
              let key = paths::compare_key(path);
              if let Some(target) = targets.iter().find(|target| target.key == key) {
                pending.insert(target.file);
              }
            }
            if !pending.is_empty() {
              deadline = Some(Instant::now() + DEBOUNCE);
            }
          }
          Ok(Err(error)) => log::warn!("owlette file watcher error: {error}"),
          Err(RecvTimeoutError::Timeout) => {
            flush(&mut pending, &targets, &sink);
            deadline = None;
          }
          Err(RecvTimeoutError::Disconnected) => {
            flush(&mut pending, &targets, &sink);
            break;
          }
        }
      }
    })
    .map_err(notify::Error::io)?;

  Ok(WatchHandle {
    watcher: Some(watcher),
    worker: Some(worker),
  })
}

/// Watch one directory, reporting that it changed — never what changed, because the only caller
/// (the POSIX job runner) rescans it whole and executes each request once.
///
/// The same 120 ms window as the seam files, taken at the leading edge: a job's result is due
/// inside 300 ms of the request landing, and a trailing-edge wait would spend nearly half of that
/// before the work started. The first event reports at once and the rest of the burst — the
/// daemon's scratch write, its rename, and its removal of the request afterwards — collapses into
/// one more report at the end of the window.
#[cfg(unix)]
pub fn spawn_directory<F>(directory: &Path, sink: F) -> notify::Result<WatchHandle>
where
  F: Fn() + Send + 'static,
{
  if let Err(error) = std::fs::create_dir_all(directory) {
    log::warn!(
      "could not create {} for watching: {error}",
      directory.display()
    );
  }

  let (tx, rx) = mpsc::channel();
  let mut watcher = notify::recommended_watcher(tx)?;
  watcher.watch(directory, RecursiveMode::NonRecursive)?;

  let worker = thread::Builder::new()
    .name("owlette-jobs-watch".into())
    .spawn(move || {
      let mut window: Option<Instant> = None;
      let mut pending = false;

      loop {
        let received = match window {
          None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
          Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
        };

        match received {
          Ok(Ok(_)) => match window {
            None => {
              sink();
              window = Some(Instant::now() + DEBOUNCE);
            }
            Some(_) => pending = true,
          },
          Ok(Err(error)) => log::warn!("owlette job watcher error: {error}"),
          Err(RecvTimeoutError::Timeout) => {
            if pending {
              sink();
              pending = false;
              window = Some(Instant::now() + DEBOUNCE);
            } else {
              window = None;
            }
          }
          Err(RecvTimeoutError::Disconnected) => break,
        }
      }
    })
    .map_err(notify::Error::io)?;

  Ok(WatchHandle {
    watcher: Some(watcher),
    worker: Some(worker),
  })
}

/// One watched file: absolute path plus the key events are matched against.
struct Target {
  file: OwletteFile,
  path: PathBuf,
  key: String,
}

fn flush<F>(pending: &mut BTreeSet<OwletteFile>, targets: &[Target], sink: &F)
where
  F: Fn(FileChange),
{
  let at = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|since| since.as_millis() as u64)
    .unwrap_or_default();

  for file in std::mem::take(pending) {
    let Some(target) = targets.iter().find(|target| target.file == file) else {
      continue;
    };
    sink(FileChange {
      file,
      path: target.path.to_string_lossy().into_owned(),
      at,
    });
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::sync::mpsc::channel;

  struct Scratch(PathBuf);

  impl Scratch {
    fn new(label: &str) -> Self {
      let dir = std::env::temp_dir().join(format!(
        "owlette-desktop-watch-{}-{label}",
        std::process::id()
      ));
      let _ = fs::remove_dir_all(&dir);
      fs::create_dir_all(&dir).expect("scratch dir");
      Self(dir)
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  /// Replace the way both sides of the seam do: scratch file next to the target, then rename.
  fn atomic_replace(path: &Path, contents: &str) {
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, contents).expect("write temp");
    fs::rename(&temp, path).expect("rename over target");
  }

  #[test]
  fn reports_an_atomic_replace_of_each_seam_file() {
    let scratch = Scratch::new("replace");
    let (tx, rx) = channel();
    let handle = spawn(&scratch.0, move |change| {
      let _ = tx.send(change);
    })
    .expect("spawn watcher");

    for file in OwletteFile::ALL {
      let path = scratch.0.join(file.relative_path());
      atomic_replace(&path, "{}");

      let change = rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_else(|_| panic!("no event for {file:?}"));
      assert_eq!(change.file, file);
      assert_eq!(
        paths::compare_key(Path::new(&change.path)),
        paths::compare_key(&path)
      );
      assert!(change.at > 0);
    }

    drop(handle);
  }

  #[test]
  fn ignores_scratch_files_and_unrelated_names() {
    let scratch = Scratch::new("ignore");
    let (tx, rx) = channel();
    let handle = spawn(&scratch.0, move |change| {
      let _ = tx.send(change);
    })
    .expect("spawn watcher");

    // A leftover Python-style scratch file plus an unrelated sibling.
    fs::write(scratch.0.join("config").join("config.json.tmp"), "{}").expect("write");
    fs::write(scratch.0.join("tmp").join("cortex.pid"), "1234").expect("write");

    assert!(
      rx.recv_timeout(Duration::from_millis(800)).is_err(),
      "watcher reported a file outside the seam"
    );

    // ...and the real file still reports, proving the watcher is alive.
    atomic_replace(&scratch.0.join(OwletteFile::Config.relative_path()), "{}");
    let change = rx.recv_timeout(Duration::from_secs(5)).expect("event");
    assert_eq!(change.file, OwletteFile::Config);

    drop(handle);
  }

  /// The job queue's watch answers at once: a result is due inside 300 ms of the request
  /// landing, and a trailing-edge wait would spend nearly half of that before the runner looked.
  #[test]
  #[cfg(unix)]
  fn reports_a_queued_job_without_waiting_out_the_window() {
    let scratch = Scratch::new("jobs");
    let jobs = scratch.0.join("ipc").join("jobs");
    let (tx, rx) = channel();
    let handle = spawn_directory(&jobs, move || {
      let _ = tx.send(Instant::now());
    })
    .expect("spawn watcher");

    let queued = Instant::now();
    atomic_replace(&jobs.join("a1b2.json"), "{}");

    let reported = rx.recv_timeout(Duration::from_secs(5)).expect("event");
    assert!(
      reported.duration_since(queued) < DEBOUNCE,
      "the queue was reported {:?} after the request landed",
      reported.duration_since(queued)
    );

    drop(handle);
  }

  #[test]
  #[cfg(unix)]
  fn collapses_a_burst_of_queued_jobs_into_one_further_report() {
    let scratch = Scratch::new("jobsburst");
    let jobs = scratch.0.join("ipc").join("jobs");
    let (tx, rx) = channel();
    let handle = spawn_directory(&jobs, move || {
      let _ = tx.send(Instant::now());
    })
    .expect("spawn watcher");

    atomic_replace(&jobs.join("first.json"), "{}");
    rx.recv_timeout(Duration::from_secs(5))
      .expect("first report");
    for index in 0..3 {
      atomic_replace(&jobs.join(format!("burst{index}.json")), "{}");
    }

    rx.recv_timeout(Duration::from_secs(5))
      .expect("the burst reports once more");
    assert!(
      rx.recv_timeout(DEBOUNCE * 4).is_err(),
      "expected the burst to collapse into a single further report"
    );

    drop(handle);
  }

  #[test]
  fn coalesces_a_burst_into_one_report() {
    let scratch = Scratch::new("burst");
    let (tx, rx) = channel();
    let handle = spawn(&scratch.0, move |change| {
      let _ = tx.send(change);
    })
    .expect("spawn watcher");

    let path = scratch.0.join(OwletteFile::AppStates.relative_path());
    for index in 0..3 {
      atomic_replace(&path, &format!("{{\"n\": {index}}}"));
    }

    let change = rx.recv_timeout(Duration::from_secs(5)).expect("event");
    assert_eq!(change.file, OwletteFile::AppStates);
    assert!(
      rx.recv_timeout(Duration::from_millis(600)).is_err(),
      "expected the burst to coalesce into a single report"
    );

    drop(handle);
  }
}
