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
//!
//! Accessibility (posting input, which swoop's control needs) is reported
//! beside it as `accessibility`, on the same tick, but **never asked here**:
//! the ask raises a system prompt, so it is made only from the permission
//! banner's button ([`request_accessibility`], swoop-macos task 2.3). Its
//! grant takes effect at once, but not for this process: gate M0 and task 4.9
//! measured `CGPreflightPostEventAccess` here keeping its launch-time answer
//! through a grant and a revocation, on this module's thread and on the main
//! thread alike, while every process this app started read the truth. So the
//! answer comes from a fresh one, the swoop sidecar's `selfcheck --grants`,
//! which macOS credits with this app's grants. A sidecar that does not answer
//! is `null`, unknown: a notice must never appear because a child timed out.

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const TCC_REL: &str = "ipc/tcc.json";
const REPORT_EVERY: Duration = Duration::from_secs(60);
const FILE_MODE: u32 = 0o644;
/// The swoop sidecar, beside this app's own executable.
const SIDECAR: &str = "owlette-swoop";
const GRANTS_ARGS: [&str; 2] = ["selfcheck", "--grants"];
/// Past this the sidecar's answer is unknown. It answers in milliseconds.
const GRANTS_TIMEOUT: Duration = Duration::from_secs(2);
const GRANTS_POLL: Duration = Duration::from_millis(20);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
  fn CGPreflightScreenCaptureAccess() -> bool;
  fn CGRequestScreenCaptureAccess() -> bool;
  fn CGRequestPostEventAccess() -> bool;
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

/// Whether this app may post input events (Accessibility), without asking, as
/// the sidecar reads it now; None when it could not say. Blocks for up to
/// [`GRANTS_TIMEOUT`], so never on the main thread.
pub fn accessibility_granted() -> Option<bool> {
  let exe = match std::env::current_exe() {
    Ok(exe) => exe,
    Err(error) => {
      log::warn!("accessibility: this app's own path is unknown: {error}");
      return None;
    }
  };
  let program = exe.parent().unwrap_or(Path::new("")).join(SIDECAR);
  accessibility_from(&program, GRANTS_TIMEOUT)
}

/// [`ask_sidecar`], with a failure logged and answered as unknown.
fn accessibility_from(program: &Path, timeout: Duration) -> Option<bool> {
  match ask_sidecar(program, timeout) {
    Ok(granted) => Some(granted),
    Err(error) => {
      log::warn!("accessibility: {} gave no answer: {error}", program.display());
      None
    }
  }
}

/// Run `program selfcheck --grants` and read `postEventPreflight`, the
/// answer the streamer's injector goes by, from its one line.
fn ask_sidecar(program: &Path, timeout: Duration) -> Result<bool, String> {
  let mut child = Command::new(program)
    .args(GRANTS_ARGS)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .current_dir("/")
    .spawn()
    .map_err(|error| format!("could not start it: {error}"))?;
  let deadline = Instant::now() + timeout;
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() < deadline => thread::sleep(GRANTS_POLL),
      waited => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(match waited {
          Err(error) => format!("could not wait for it: {error}"),
          _ => format!("no answer within {timeout:?}"),
        });
      }
    }
  };
  if !status.success() {
    return Err(format!("it exited with {status}"));
  }
  let mut line = String::new();
  child
    .stdout
    .take()
    .ok_or("its output was not captured")?
    .read_to_string(&mut line)
    .map_err(|error| format!("could not read its answer: {error}"))?;
  serde_json::from_str::<serde_json::Value>(line.trim())
    .ok()
    .and_then(|grants| grants.get("postEventPreflight")?.as_bool())
    .ok_or_else(|| "its answer carries no postEventPreflight".to_owned())
}

/// Ask for Accessibility: lists the app in System Settings and may raise the
/// system prompt, so only a click may call this. Returns this process's
/// answer, which is its launch-time one.
pub fn request_accessibility() -> bool {
  // SAFETY: as above; the call may show a system prompt, which the click asked for.
  unsafe { CGRequestPostEventAccess() }
}

/// The report body, as the daemon parses it. An unknown Accessibility answer
/// is `null`.
pub fn report(granted: bool, accessibility: Option<bool>, checked_at: u64) -> String {
  let accessibility = accessibility.map_or("null".to_owned(), |held| held.to_string());
  format!(r#"{{"screen_recording":{granted},"accessibility":{accessibility},"checked_at":{checked_at}}}"#)
}

/// Write the report whole and move it into place: the daemon may read it at
/// any moment and a half-written file is a report of nothing.
pub fn write_report(root: &Path, granted: bool, accessibility: Option<bool>) -> std::io::Result<PathBuf> {
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
    file.write_all(report(granted, accessibility, now).as_bytes())?;
  }
  fs::rename(&temp, &path)?;
  Ok(path)
}

/// Ask for Screen Recording once, then report both grants every minute for
/// the life of the app.
pub fn spawn(root: &Path) {
  let root = root.to_path_buf();
  let spawned = thread::Builder::new().name("owlette-tcc".into()).spawn(move || {
    let asked = request();
    log::info!("screen recording: asked once at launch, answer now {asked}");
    loop {
      match write_report(&root, granted(), accessibility_granted()) {
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
  use std::sync::atomic::{AtomicUsize, Ordering};

  #[test]
  fn the_report_is_the_fields_the_daemon_reads() {
    assert_eq!(
      report(true, Some(false), 1_790_000_000),
      r#"{"screen_recording":true,"accessibility":false,"checked_at":1790000000}"#
    );
    assert_eq!(
      report(true, None, 1_790_000_000),
      r#"{"screen_recording":true,"accessibility":null,"checked_at":1790000000}"#
    );
  }

  #[test]
  fn the_report_file_is_the_users_own_and_not_writable_by_others() {
    let root = std::env::temp_dir().join(format!("owlette-tcc-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let path = write_report(&root, false, Some(true)).expect("report");
    assert_eq!(path, root.join(TCC_REL));
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.starts_with(r#"{"screen_recording":false,"accessibility":true,"checked_at":"#), "{text}");
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o022, 0);
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1, "no temp file left");
  }

  /// A stand-in sidecar running `body` when it is asked exactly
  /// `selfcheck --grants`, and exiting 9 on anything else. In a fresh
  /// directory, never removed, because nothing here deletes a tree.
  fn sidecar(body: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
      "owlette-tcc-sidecar-{}-{}",
      std::process::id(),
      NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).expect("a scratch directory");
    let program = dir.join(SIDECAR);
    fs::write(&program, format!("#!/bin/sh\n[ \"$*\" = \"selfcheck --grants\" ] || exit 9\n{body}\n")).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    program
  }

  #[test]
  fn the_sidecars_post_event_answer_is_the_accessibility_answer() {
    let granted = sidecar(r#"echo '{"screenCapturePreflight":false,"postEventPreflight":true,"axTrusted":true}'"#);
    assert_eq!(accessibility_from(&granted, GRANTS_TIMEOUT), Some(true));
    let refused = sidecar(r#"echo '{"screenCapturePreflight":true,"postEventPreflight":false,"axTrusted":true}'"#);
    assert_eq!(accessibility_from(&refused, GRANTS_TIMEOUT), Some(false));
  }

  #[test]
  fn a_sidecar_that_does_not_answer_is_unknown_never_false() {
    let missing = std::env::temp_dir().join(format!("owlette-tcc-none-{}", std::process::id())).join(SIDECAR);
    assert_eq!(accessibility_from(&missing, GRANTS_TIMEOUT), None, "no sidecar");
    assert_eq!(accessibility_from(&sidecar("exit 3"), GRANTS_TIMEOUT), None, "a failed run");
    assert_eq!(accessibility_from(&sidecar("echo not json"), GRANTS_TIMEOUT), None, "not json");
    assert_eq!(
      accessibility_from(&sidecar(r#"echo '{"axTrusted":false}'"#), GRANTS_TIMEOUT),
      None,
      "no postEventPreflight"
    );
    assert_eq!(
      accessibility_from(&sidecar(r#"echo '{"postEventPreflight":"false"}'"#), GRANTS_TIMEOUT),
      None,
      "not a bool"
    );
  }

  #[test]
  fn a_sidecar_that_hangs_is_stopped_at_the_timeout() {
    let hangs = sidecar("exec sleep 30");
    let started = Instant::now();
    assert_eq!(accessibility_from(&hangs, Duration::from_millis(300)), None);
    let took = started.elapsed();
    assert!(took >= Duration::from_millis(300), "gave up early, after {took:?}");
    assert!(took < Duration::from_secs(5), "waited for the child, {took:?}");
  }
}
