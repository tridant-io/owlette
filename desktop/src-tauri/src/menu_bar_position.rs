//! Where the menu bar item goes on a first run (macOS).
//!
//! macOS puts a new menu bar item at the far left of the others. On a notched
//! Mac with a full bar that is under the notch, and nothing says it is there:
//! on the rig (2026-10-02) the item sat at x=927..963 against a notch ending at
//! x=948. macOS honours a saved position when an item is created, kept in the
//! app's own defaults as points from the right edge, so on a first run the item
//! is given one at the right end: measured, `1` lands it just left of the
//! system's own items (x=1591 of 1710). A position already saved is the
//! person's own, made by a drag, and is never overwritten.

use std::process::{Command, Stdio};

/// tauri's tray item is the app's first and only one, which AppKit names so.
const KEY: &str = "NSStatusItem Preferred Position Item-0";
/// As far right as macOS lets a third-party item sit.
const RIGHT_END: &str = "1";
const DEFAULTS: &str = "/usr/bin/defaults";

/// Save the right-end position for `domain`, the bundle identifier, unless one
/// is saved already. Called before the tray is built: AppKit reads the
/// position when the item is created.
pub fn seed(domain: &str) {
  match saved(domain) {
    Ok(true) => {}
    Ok(false) => {
      let written = quiet(Command::new(DEFAULTS).args(["write", domain, KEY, "-float", RIGHT_END])).status();
      match written {
        Ok(status) if status.success() => log::info!("menu bar: saved a first position at the right end"),
        other => log::warn!("menu bar: could not save a first position: {other:?}"),
      }
    }
    Err(error) => log::warn!("menu bar: could not read the saved position: {error}"),
  }
}

/// Whether a position is saved: `defaults read` exits non-zero for a key or a
/// domain that does not exist.
fn saved(domain: &str) -> std::io::Result<bool> {
  quiet(Command::new(DEFAULTS).args(["read", domain, KEY]))
    .status()
    .map(|status| status.success())
}

fn quiet(command: &mut Command) -> &mut Command {
  command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn read(domain: &str) -> String {
    let output = Command::new(DEFAULTS).args(["read", domain, KEY]).output().expect("defaults runs");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
  }

  #[test]
  fn a_first_run_saves_the_right_end_and_a_saved_position_is_left_alone() {
    // one fixed scratch domain, so a run that dies leaves one file and not one a run
    let domain = "app.owlette.desktop.selftest".to_owned();
    let _ = Command::new(DEFAULTS).args(["delete", &domain]).output();
    assert!(!saved(&domain).expect("defaults runs"), "a scratch domain starts empty");

    seed(&domain);
    assert_eq!(read(&domain), RIGHT_END);

    // a position the person dragged the item to
    let moved = Command::new(DEFAULTS).args(["write", &domain, KEY, "-float", "250"]).status().expect("defaults runs");
    assert!(moved.success());
    seed(&domain);
    assert_eq!(read(&domain), "250");

    // the scratch domain alone; `defaults delete` empties it and leaves its
    // file, so the test takes that one file too
    let removed = Command::new(DEFAULTS).args(["delete", &domain]).status().expect("defaults runs");
    assert!(removed.success());
    if let Some(home) = std::env::var_os("HOME") {
      let file = std::path::Path::new(&home)
        .join("Library/Preferences")
        .join(format!("{domain}.plist"));
      let _ = std::fs::remove_file(file);
    }
  }
}
