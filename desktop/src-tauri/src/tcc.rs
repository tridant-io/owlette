//! What this app knows about its own Screen Recording grant, told to the
//! daemon (tri-platform task 4.4, macOS).
//!
//! TCC ties Screen Recording to the app bundle, and a capture made without the
//! grant on macOS 15+ is refused rather than blank. The daemon
//! (`agent/src/osadapter/darwin.py`) reads `ipc/tcc.json` — `screen_recording`
//! and `checked_at` in unix seconds — and refuses a capture outright on a fresh
//! `false`; a report older than five minutes is no report, so this rewrites
//! it every minute. The file must be the console user's own and writable by
//! nobody else, which is what the mode here gives it.
//!
//! The ask is made **once per launch** and never again: spike 0.2 measured
//! that every repeated attempt on an undecided app raises the prompt again,
//! and `screencapture` itself never asks — only this call lists the app under
//! Screen & System Audio Recording. The answer is read on every tick; a grant
//! only takes effect on the next launch, and the next tick after that reports it.

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const TCC_REL: &str = "ipc/tcc.json";
const REPORT_EVERY: Duration = Duration::from_secs(60);
const FILE_MODE: u32 = 0o644;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
  fn CGPreflightScreenCaptureAccess() -> bool;
  fn CGRequestScreenCaptureAccess() -> bool;
}

/// Whether the grant is held right now, without asking.
pub fn granted() -> bool {
  // SAFETY: a plain CoreGraphics query with no arguments and no state of ours.
  unsafe { CGPreflightScreenCaptureAccess() }
}

/// Ask once: lists the app in System Settings and raises the prompt when the
/// user has not decided yet. Returns the current answer, not the eventual one.
pub fn request() -> bool {
  // SAFETY: as above; the call may show a system prompt, which is the point.
  unsafe { CGRequestScreenCaptureAccess() }
}

/// The report body, as the daemon parses it.
pub fn report(granted: bool, checked_at: u64) -> String {
  format!(r#"{{"screen_recording":{granted},"checked_at":{checked_at}}}"#)
}

/// Write the report whole and move it into place: the daemon may read it at
/// any moment and a half-written file is a report of nothing.
pub fn write_report(root: &Path, granted: bool) -> std::io::Result<PathBuf> {
  let path = root.join(TCC_REL);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }
  let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
  let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(std::io::Error::other)?.as_secs();
  {
    let mut file = fs::OpenOptions::new()
      .write(true)
      .create(true)
      .truncate(true)
      .mode(FILE_MODE)
      .open(&temp)?;
    file.write_all(report(granted, now).as_bytes())?;
  }
  fs::rename(&temp, &path)?;
  Ok(path)
}

/// Ask once, then report every minute for the life of the app.
pub fn spawn(root: &Path) {
  let root = root.to_path_buf();
  let spawned = thread::Builder::new().name("owlette-tcc".into()).spawn(move || {
    let asked = request();
    log::info!("screen recording: asked once at launch, answer now {asked}");
    loop {
      match write_report(&root, granted()) {
        Ok(_) => {}
        Err(error) => log::warn!("could not write the screen recording report: {error}"),
      }
      thread::sleep(REPORT_EVERY);
    }
  });
  if let Err(error) = spawned {
    log::error!("could not start the screen recording reporter: {error}");
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::os::unix::fs::PermissionsExt;

  #[test]
  fn the_report_is_the_two_fields_the_daemon_reads() {
    assert_eq!(report(true, 1_790_000_000), r#"{"screen_recording":true,"checked_at":1790000000}"#);
  }

  #[test]
  fn the_report_file_is_the_users_own_and_not_writable_by_others() {
    let root = std::env::temp_dir().join(format!("owlette-tcc-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let path = write_report(&root, false).expect("report");
    assert_eq!(path, root.join(TCC_REL));
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.starts_with(r#"{"screen_recording":false,"checked_at":"#), "{text}");
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o022, 0);
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1, "no temp file left");
  }
}
