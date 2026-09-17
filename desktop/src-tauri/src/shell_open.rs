//! Handing a path or a URL to whatever this platform opens things with.
//!
//! One spawn, three names — `explorer.exe`, `open`, `xdg-open` — the ternary
//! `@owlette/cli` already uses (`cli/src/commands/auth.ts`). Off Windows the app
//! runs as the console user inside their session, so `open` and `xdg-open`
//! inherit the display and the file associations of the person at the machine.
//!
//! Two rules make this safe over IPC:
//!
//! * Paths resolve against the owlette data root via
//!   [`crate::paths::resolve_in_root`] and are rejected outside it — `config.json`
//!   yes, `C:\Windows\System32\cmd.exe` no.
//! * URLs must be `http`/`https`, or the opener runs any registered protocol
//!   handler — a launcher, not a link.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::thread;
#[cfg(unix)]
use std::time::{Duration, Instant};

use crate::paths;

/// Schemes a frontend link may use.
const ALLOWED_SCHEMES: [&str; 2] = ["https://", "http://"];

/// How long a POSIX opener is given to report that nothing handled the target.
#[cfg(unix)]
const HANDOFF_BUDGET: Duration = Duration::from_millis(500);

/// How often the opener is checked while that budget runs down.
#[cfg(unix)]
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// The platform's opener: file associations on Windows, LaunchServices on
/// macOS, the freedesktop handler on everything else.
///
/// Windows is named absolutely because a bare program name resolves out of the
/// calling binary's own directory before anything on `PATH`, and the installer
/// leaves the tree this app runs from writable by every standard user
/// (`owlette_installer.iss`, `users-modify` on `{commonappdata}\Owlette`) — a
/// bare `explorer.exe` would be a name anyone with a login could claim. POSIX
/// resolves through `PATH`, which nobody but this user can write.
#[cfg(windows)]
fn opener() -> PathBuf {
  let system_root = std::env::var_os("SystemRoot")
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "C:\\Windows".into());
  PathBuf::from(system_root).join("explorer.exe")
}

#[cfg(target_os = "macos")]
fn opener() -> PathBuf {
  PathBuf::from("open")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn opener() -> PathBuf {
  PathBuf::from("xdg-open")
}

/// Open a file or folder inside the owlette tree with its default handler.
///
/// `requested` is relative to the data root (`config/config.json`, `logs`).
pub fn open_in_tree(requested: &str) -> Result<(), String> {
  open_under(&paths::data_root(), requested)
}

/// The root is a parameter so the guard can be tested against a fixed tree
/// rather than against whatever this machine's data root holds — or whatever
/// `OWLETTE_DATA_ROOT` names while the suite runs.
fn open_under(root: &Path, requested: &str) -> Result<(), String> {
  let resolved = paths::resolve_in_root(root, requested)?;
  if !resolved.exists() {
    return Err(format!("{} does not exist", resolved.display()));
  }
  open(resolved.as_os_str())
}

/// Open an `http(s)` URL in the default browser.
pub fn open_url(url: &str) -> Result<(), String> {
  let trimmed = url.trim();
  let lowered = trimmed.to_ascii_lowercase();
  if !ALLOWED_SCHEMES
    .iter()
    .any(|scheme| lowered.starts_with(scheme))
  {
    return Err(format!("refusing to open a non-web link: {trimmed}"));
  }
  // A control character could break out of the argument the opener parses, and
  // no legitimate URL contains one.
  if trimmed.chars().any(char::is_control) {
    return Err("refusing to open a link containing control characters".to_string());
  }

  open(OsStr::new(trimmed))
}

/// Spawn the opener on the target and report what it made of it.
fn open(target: &OsStr) -> Result<(), String> {
  let child = Command::new(opener())
    .arg(target)
    .spawn()
    .map_err(|error| refused(target, &error.to_string()))?;
  settle(child, target)
}

/// `explorer.exe` exits 1 having opened the window, so its status says nothing
/// about the target — and a target nothing is registered for is the shell's own
/// report: it raises the "how do you want to open this file" picker instead of
/// failing back to us, which is why only the POSIX arm reports a refusal. The
/// child is reaped on a thread rather than waited on, which keeps a tray process
/// running for weeks from collecting zombies.
#[cfg(windows)]
fn settle(mut child: Child, _target: &OsStr) -> Result<(), String> {
  thread::spawn(move || {
    let _ = child.wait();
  });
  Ok(())
}

/// `open` and `xdg-open` hand the target to a handler and exit — non-zero when
/// no handler took it, which is the only signal behind the frontend's "could
/// not open" message and the pairing dialog's fall back to another device. A
/// verdict inside [`HANDOFF_BUDGET`] is that refusal; an opener a handler keeps
/// in the foreground instead outlives the budget and counts as opened, its
/// child reaped on a thread as above.
#[cfg(unix)]
fn settle(mut child: Child, target: &OsStr) -> Result<(), String> {
  let deadline = Instant::now() + HANDOFF_BUDGET;
  loop {
    match child.try_wait() {
      Ok(Some(status)) if status.success() => return Ok(()),
      Ok(Some(status)) => return Err(refused(target, &status.to_string())),
      Ok(None) if Instant::now() >= deadline => {
        thread::spawn(move || {
          let _ = child.wait();
        });
        return Ok(());
      }
      Ok(None) => thread::sleep(POLL_INTERVAL),
      Err(error) => return Err(refused(target, &error.to_string())),
    }
  }
}

fn refused(target: &OsStr, detail: &str) -> String {
  format!("could not open {} ({detail})", target.to_string_lossy())
}

#[cfg(test)]
mod tests {
  use super::*;

  /// An absolute path outside the data root, spelled for this platform.
  #[cfg(windows)]
  const OUTSIDE_THE_TREE: &str = "C:\\Windows\\System32\\cmd.exe";
  #[cfg(not(windows))]
  const OUTSIDE_THE_TREE: &str = "/bin/sh";

  #[cfg(windows)]
  const ESCAPING_RELATIVE_PATH: &str = "config/../../Windows/notepad.exe";
  #[cfg(not(windows))]
  const ESCAPING_RELATIVE_PATH: &str = "config/../../bin/sh";

  /// A tree of this platform's shape that nothing here writes to. Reading the
  /// live data root instead would make these answers depend on the machine, and
  /// would race the one test in the crate that sets `OWLETTE_DATA_ROOT`
  /// (`paths::tests::an_override_moves_the_data_root_and_leaves_the_install_root`).
  fn root() -> PathBuf {
    std::env::temp_dir().join("owlette-shell-open")
  }

  #[test]
  fn only_web_links_are_opened() {
    for refused in [
      "file:///C:/Windows/System32/cmd.exe",
      "ms-settings:",
      "javascript:alert(1)",
      "C:\\Windows\\System32\\cmd.exe",
      "",
      "   ",
    ] {
      let error = open_url(refused).expect_err("should refuse");
      assert!(error.contains("non-web link"), "{refused}: {error}");
    }
  }

  #[test]
  fn a_control_character_in_a_link_is_refused() {
    let error = open_url("https://owlette.app/docs\r\nnotepad").expect_err("should refuse");
    assert!(error.contains("control characters"), "{error}");
  }

  #[test]
  fn a_path_outside_the_tree_never_reaches_the_opener() {
    let error = open_under(&root(), OUTSIDE_THE_TREE).expect_err("should refuse");
    assert!(error.contains("escapes"), "{error}");

    let error = open_under(&root(), ESCAPING_RELATIVE_PATH).expect_err("should refuse");
    assert!(error.contains(".."), "{error}");
  }

  #[test]
  fn a_missing_target_is_reported_before_the_opener_is_asked() {
    let error = open_under(&root(), "config/definitely-not-here.json").expect_err("should refuse");
    assert!(error.contains("does not exist"), "{error}");
  }

  /// Nothing else pins which program this module spawns.
  #[test]
  #[cfg(windows)]
  fn the_opener_is_the_shell_named_absolutely() {
    let opener = opener();
    // Negative control for a bare `explorer.exe`: a relative name is resolved
    // out of this binary's own directory, which standard users can write.
    assert!(opener.is_absolute(), "{}", opener.display());
    assert_eq!(
      opener.file_name().and_then(OsStr::to_str),
      Some("explorer.exe")
    );
    assert!(opener.exists(), "{} should exist", opener.display());
  }

  #[test]
  #[cfg(target_os = "macos")]
  fn the_opener_is_launch_services() {
    assert_eq!(opener(), PathBuf::from("open"));
  }

  #[test]
  #[cfg(all(unix, not(target_os = "macos")))]
  fn the_opener_is_the_freedesktop_handler() {
    assert_eq!(opener(), PathBuf::from("xdg-open"));
  }

  #[test]
  #[cfg(unix)]
  fn an_opener_that_refuses_the_target_is_reported() {
    let child = Command::new("/bin/sh")
      .args(["-c", "exit 3"])
      .spawn()
      .expect("spawn");
    let error = settle(child, OsStr::new("/var/lib/owlette/logs")).expect_err("should report");
    assert!(
      error.contains("could not open /var/lib/owlette/logs"),
      "{error}"
    );
  }

  /// Negative control for the test above: only a fast refusal is a failure. An
  /// opener a handler keeps in the foreground has refused nothing, and waiting
  /// on it would hold the command open for as long as the handler runs.
  #[test]
  #[cfg(unix)]
  fn an_opener_that_succeeds_or_lingers_is_not_reported() {
    let handed_off = Command::new("/bin/sh")
      .args(["-c", "exit 0"])
      .spawn()
      .expect("spawn");
    assert!(settle(handed_off, OsStr::new("/var/lib/owlette/logs")).is_ok());

    let lingering = Command::new("/bin/sh")
      .args(["-c", "sleep 2"])
      .spawn()
      .expect("spawn");
    let started = Instant::now();
    assert!(settle(lingering, OsStr::new("/var/lib/owlette/logs")).is_ok());
    assert!(
      started.elapsed() < HANDOFF_BUDGET * 3,
      "{:?}",
      started.elapsed()
    );
  }

  /// The Windows counterpart of the two above: `explorer.exe` exits 1 having
  /// opened the window, so no status it returns can be read as a refusal.
  #[test]
  #[cfg(windows)]
  fn a_non_zero_exit_is_not_a_refusal_on_windows() {
    let shell =
      std::env::var_os("ComSpec").unwrap_or_else(|| "C:\\Windows\\System32\\cmd.exe".into());
    let child = Command::new(shell)
      .args(["/c", "exit 3"])
      .spawn()
      .expect("spawn");
    assert!(settle(child, OsStr::new("config\\config.json")).is_ok());
  }
}
