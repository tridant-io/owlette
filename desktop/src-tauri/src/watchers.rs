//! Directory watchers for the three seam files the service publishes.
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
  // off windows the kernel reports the real path: on macos the temp tree is a
  // symlink into /private, and a key built from the link never matches an
  // event. windows is left alone — canonicalising there yields the \?\ form,
  // which is not what ReadDirectoryChangesW reports.
  #[cfg(unix)]
  let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
  #[cfg(unix)]
  let root: &Path = canonical.as_path();

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
      // the same real path the watcher keys on (see `spawn`).
      #[cfg(unix)]
      let dir = fs::canonicalize(&dir).unwrap_or(dir);
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
