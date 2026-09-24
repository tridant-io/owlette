//! Handing a path or a URL to the desktop's own opener.
//!
//! On Windows that is `ShellExecuteW` directly rather than a plugin: it is
//! the API under `os.startfile` / `webbrowser.open` (what the legacy GUI's
//! config/logs/docs items used) and is already how this crate elevates a
//! service command. On macOS it is `open`, on Linux `xdg-open` — the same
//! ternary the cli's `auth` command uses (tri-platform task 4.1).
//!
//! Two rules make this safe over IPC:
//!
//! * Paths resolve against the owlette data root via
//!   [`crate::paths::resolve_in_root`] and are rejected outside it — `config.json`
//!   yes, `C:\Windows\System32\cmd.exe` no.
//! * URLs must be `http`/`https`, or the shell runs any registered protocol
//!   handler — a launcher, not a link.

use std::path::Path;

#[cfg(windows)]
use windows::core::{w, HSTRING, PCWSTR};
#[cfg(windows)]
use windows::Win32::UI::Shell::ShellExecuteW;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::paths;

/// `ShellExecuteW` returns an HINSTANCE; anything above 32 means it launched.
#[cfg(windows)]
const SHELL_EXECUTE_SUCCESS_FLOOR: isize = 32;

/// `SE_ERR_NOASSOC` — no handler for this file type. Common on bare Windows
/// Server, where `.json` has none.
#[cfg(windows)]
const SE_ERR_NOASSOC: isize = 31;

/// Schemes a frontend link may use.
const ALLOWED_SCHEMES: [&str; 2] = ["https://", "http://"];

/// Open a file or folder inside the owlette tree with its default handler.
///
/// `requested` is relative to the data root (`config/config.json`, `logs`). An
/// unassociated file type falls back to Notepad rather than reporting a failure
/// the operator cannot act on.
pub fn open_in_tree(requested: &str) -> Result<(), String> {
  let resolved = paths::resolve_in_root(&paths::data_root(), requested)?;
  if !resolved.exists() {
    return Err(format!("{} does not exist", resolved.display()));
  }
  open_resolved(&resolved)
}

#[cfg(windows)]
fn open_resolved(path: &Path) -> Result<(), String> {
  match execute(w!("open"), &HSTRING::from(path.as_os_str()), PCWSTR::null()) {
    Ok(()) => Ok(()),
    Err(SE_ERR_NOASSOC) if path.is_file() => open_in_notepad(path),
    Err(code) => Err(format!(
      "windows could not open {} ({code})",
      path.display()
    )),
  }
}

#[cfg(not(windows))]
fn open_resolved(path: &Path) -> Result<(), String> {
  launch(path.as_os_str())
}

/// The desktop's opener, handed one argument: `open` on macOS, `xdg-open`
/// elsewhere. Spawned and not waited on, like the shell verb it replaces.
#[cfg(not(windows))]
fn launch(target: &std::ffi::OsStr) -> Result<(), String> {
  let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
  std::process::Command::new(opener)
    .arg(target)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .map(|_| ())
    .map_err(|e| format!("{opener} could not open {}: {e}", target.to_string_lossy()))
}

/// Last resort for a file type Windows has no handler for.
#[cfg(windows)]
fn open_in_notepad(path: &Path) -> Result<(), String> {
  let quoted = HSTRING::from(format!("\"{}\"", path.display()));
  execute(
    w!("open"),
    &HSTRING::from("notepad.exe"),
    PCWSTR(quoted.as_ptr()),
  )
  .map_err(|code| format!("windows could not open {} ({code})", path.display()))
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
  // A control character could break out of the argument the shell parses, and no
  // legitimate URL contains one.
  if trimmed.chars().any(char::is_control) {
    return Err("refusing to open a link containing control characters".to_string());
  }

  open_link(trimmed)
}

#[cfg(windows)]
fn open_link(url: &str) -> Result<(), String> {
  execute(w!("open"), &HSTRING::from(url), PCWSTR::null())
    .map_err(|code| format!("windows could not open {url} ({code})"))
}

#[cfg(not(windows))]
fn open_link(url: &str) -> Result<(), String> {
  launch(std::ffi::OsStr::new(url))
}

/// Run one `ShellExecuteW`, mapping its HINSTANCE onto a result.
#[cfg(windows)]
fn execute(verb: PCWSTR, file: &HSTRING, parameters: PCWSTR) -> Result<(), isize> {
  // SAFETY: `file` outlives the call, and the other pointers are either null or
  // static wide strings.
  let result = unsafe {
    ShellExecuteW(
      None,
      verb,
      PCWSTR(file.as_ptr()),
      parameters,
      PCWSTR::null(),
      SW_SHOWNORMAL,
    )
  };

  let code = result.0 as isize;
  if code > SHELL_EXECUTE_SUCCESS_FLOOR {
    Ok(())
  } else {
    Err(code)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

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
  fn a_path_outside_the_tree_never_reaches_the_shell() {
    let outside = if cfg!(windows) { "C:\\Windows\\System32\\cmd.exe" } else { "/etc/passwd" };
    let error = open_in_tree(outside).expect_err("should refuse");
    assert!(error.contains("escapes"), "{error}");

    let error = open_in_tree("config/../../Windows/notepad.exe").expect_err("should refuse");
    assert!(error.contains(".."), "{error}");
  }

  #[test]
  fn a_missing_target_is_reported_before_the_shell_is_asked() {
    let error = open_in_tree("config/definitely-not-here.json").expect_err("should refuse");
    assert!(error.contains("does not exist"), "{error}");
  }
}
