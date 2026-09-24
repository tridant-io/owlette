//! Layout of the owlette data tree.
//!
//! Mirrors the agent's `osadapter`: the data root is `%PROGRAMDATA%\Owlette` on
//! Windows, `/Library/Application Support/Owlette` on macOS and
//! `/var/lib/owlette` on Linux, and `OWLETTE_DATA_ROOT` overrides all three —
//! the one override the agent honours too (tri-platform plan, decision 4).
//! Reading the variables rather than hardcoding the tree keeps the app on
//! exactly the tree the service uses and lets tests redirect it.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

/// Directory created under `%PROGRAMDATA%` on Windows.
const DATA_DIR_NAME: &str = "Owlette";
/// The one override every arm honours.
pub const DATA_ROOT_ENV: &str = "OWLETTE_DATA_ROOT";

/// Seam files, spelled as the TypeScript wrappers spell them. Forward slashes
/// are deliberate — they match the Python constants, and [`resolve_in_root`]
/// normalises separators anyway.
pub const CONFIG_REL: &str = "config/config.json";
pub const APP_STATES_REL: &str = "tmp/app_states.json";
pub const SERVICE_STATUS_REL: &str = "tmp/service_status.json";

/// Written while the main window is on screen; the service raises its metrics
/// cadence to 5 s when it sees a live pid here
/// (`firebase_client._metrics_loop`).
pub const GUI_PID_REL: &str = "tmp/gui.pid";

/// Written for the whole process lifetime, window or not.
/// `owlette_service._is_tray_alive` reads it to decide whether to spawn a tray
/// — the same singleton lock the python tray used.
pub const TRAY_PID_REL: &str = "tmp/tray.pid";

/// Touched to ask a running service to exit 42 so NSSM restarts it
/// (`owlette_service.main`, the restart-flag branch).
pub const RESTART_FLAG_REL: &str = "tmp/restart.flag";

/// The agent's version file, under the install root. On Windows the install
/// root and the data root are the same directory (`{app}` is
/// `%PROGRAMDATA%\Owlette`); on the other two they are not.
pub const AGENT_VERSION_REL: &str = "agent/VERSION";

/// Absolute path of the owlette data root.
pub fn data_root() -> PathBuf {
  data_root_from(std::env::var_os(DATA_ROOT_ENV).as_deref(), std::env::var_os("PROGRAMDATA").as_deref())
}

/// The data root for the given override and, on Windows, `%PROGRAMDATA%`.
/// Split from [`data_root`] so the rule is testable without touching the
/// process environment.
pub fn data_root_from(override_root: Option<&OsStr>, program_data: Option<&OsStr>) -> PathBuf {
  if let Some(root) = override_root.filter(|value| !value.is_empty()) {
    return PathBuf::from(root);
  }
  if cfg!(windows) {
    let program_data = program_data
      .filter(|value| !value.is_empty())
      .map(PathBuf::from)
      .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"));
    program_data.join(DATA_DIR_NAME)
  } else if cfg!(target_os = "macos") {
    PathBuf::from("/Library/Application Support/Owlette")
  } else {
    PathBuf::from("/var/lib/owlette")
  }
}

/// Absolute path of the owlette install root: where the agent's own files
/// live. `/opt/owlette` on Linux, the `runtime` directory under the data root
/// on macOS, and the data root itself on Windows.
pub fn install_root() -> PathBuf {
  install_root_from(&data_root())
}

pub fn install_root_from(data_root: &Path) -> PathBuf {
  if cfg!(windows) {
    data_root.to_path_buf()
  } else if cfg!(target_os = "macos") {
    data_root.join("runtime")
  } else {
    PathBuf::from("/opt/owlette")
  }
}

/// Resolve a caller-supplied path against the data root: relative paths are
/// joined, absolute ones accepted only inside it. `..` is rejected outright
/// rather than normalised, so no frontend string can reach a file outside the
/// owlette tree.
pub fn resolve_in_root(root: &Path, requested: &str) -> Result<PathBuf, String> {
  let trimmed = requested.trim();
  if trimmed.is_empty() {
    return Err("path is empty".to_string());
  }

  let requested_path = Path::new(trimmed);
  let joined = if requested_path.is_absolute() {
    requested_path.to_path_buf()
  } else {
    root.join(requested_path)
  };

  // `components()` drops `.` and keeps `..` — exactly the distinction we need.
  let mut normalized = PathBuf::new();
  for component in joined.components() {
    match component {
      Component::ParentDir => return Err(format!("path must not contain '..': {trimmed}")),
      Component::CurDir => {}
      other => normalized.push(other.as_os_str()),
    }
  }

  let root_key = compare_key(root);
  let candidate_key = compare_key(&normalized);
  if candidate_key == root_key || candidate_key.starts_with(&format!("{root_key}{}", std::path::MAIN_SEPARATOR)) {
    Ok(normalized)
  } else {
    Err(format!(
      "path escapes the owlette data directory: {}",
      normalized.display()
    ))
  }
}

/// Path comparison key: separators unified, no trailing separator, and on
/// Windows — whose filesystems do not distinguish case — case folded. Used for
/// containment checks and for matching watcher events against the files we
/// care about.
pub fn compare_key(path: &Path) -> String {
  let text = path.to_string_lossy();
  if cfg!(windows) {
    text.replace('/', "\\").trim_end_matches('\\').to_lowercase()
  } else {
    text.trim_end_matches('/').to_string()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_override_wins_on_every_os_and_an_empty_one_is_ignored() {
    assert_eq!(data_root_from(Some(OsStr::new("/tmp/owlette-test")), None), PathBuf::from("/tmp/owlette-test"));
    let defaulted = data_root_from(Some(OsStr::new("")), Some(OsStr::new("D:\\PD")));
    assert_ne!(defaulted, PathBuf::from(""));
    if cfg!(windows) {
      assert_eq!(defaulted, PathBuf::from("D:\\PD").join(DATA_DIR_NAME));
    }
  }

  #[test]
  fn the_install_root_is_the_data_root_on_windows_and_its_own_place_elsewhere() {
    let data = PathBuf::from(if cfg!(windows) { "C:\\ProgramData\\Owlette" } else { "/var/lib/owlette" });
    let install = install_root_from(&data);
    if cfg!(windows) {
      assert_eq!(install, data);
    } else if cfg!(target_os = "macos") {
      assert_eq!(install, data.join("runtime"));
    } else {
      assert_eq!(install, PathBuf::from("/opt/owlette"));
    }
  }
}

#[cfg(all(test, windows))]
mod windows_tests {
  use super::*;

  fn root() -> PathBuf {
    PathBuf::from("C:\\ProgramData\\Owlette")
  }

  #[test]
  fn relative_paths_resolve_under_the_root() {
    let resolved = resolve_in_root(&root(), CONFIG_REL).expect("should resolve");
    assert_eq!(resolved, root().join("config").join("config.json"));
  }

  #[test]
  fn absolute_paths_inside_the_root_are_accepted() {
    let absolute = "C:\\ProgramData\\Owlette\\tmp\\app_states.json";
    let resolved = resolve_in_root(&root(), absolute).expect("should resolve");
    assert_eq!(compare_key(&resolved), absolute.to_lowercase());
  }

  #[test]
  fn case_and_separator_differences_do_not_break_containment() {
    let resolved = resolve_in_root(&root(), "c:/programdata/owlette/tmp/service_status.json")
      .expect("should resolve");
    assert_eq!(
      compare_key(&resolved),
      "c:\\programdata\\owlette\\tmp\\service_status.json"
    );
  }

  #[test]
  fn parent_segments_are_rejected() {
    let err = resolve_in_root(&root(), "config/../../secrets.json").expect_err("should reject");
    assert!(err.contains(".."), "unexpected error: {err}");
  }

  #[test]
  fn paths_outside_the_root_are_rejected() {
    let err = resolve_in_root(&root(), "C:\\Windows\\System32\\drivers\\etc\\hosts")
      .expect_err("should reject");
    assert!(err.contains("escapes"), "unexpected error: {err}");
  }

  #[test]
  fn a_sibling_directory_with_the_root_as_a_prefix_is_rejected() {
    let err = resolve_in_root(&root(), "C:\\ProgramData\\OwletteBackup\\config.json")
      .expect_err("should reject");
    assert!(err.contains("escapes"), "unexpected error: {err}");
  }

  #[test]
  fn empty_paths_are_rejected() {
    assert!(resolve_in_root(&root(), "   ").is_err());
  }

  #[test]
  fn data_root_follows_the_programdata_variable() {
    // Same fallback shared_utils.get_data_path() uses, unless overridden.
    let root = data_root_from(None, Some(OsStr::new("C:\\ProgramData")));
    assert_eq!(root, PathBuf::from("C:\\ProgramData").join(DATA_DIR_NAME));
    let root = data_root_from(None, None);
    assert_eq!(root, PathBuf::from("C:\\ProgramData").join(DATA_DIR_NAME));
  }
}

#[cfg(all(test, unix))]
mod unix_tests {
  use super::*;

  fn root() -> PathBuf {
    PathBuf::from("/var/lib/owlette")
  }

  #[test]
  fn relative_paths_resolve_under_the_root() {
    let resolved = resolve_in_root(&root(), CONFIG_REL).expect("should resolve");
    assert_eq!(resolved, root().join("config").join("config.json"));
  }

  #[test]
  fn paths_outside_the_root_and_prefix_siblings_are_rejected() {
    assert!(resolve_in_root(&root(), "/etc/passwd").expect_err("should reject").contains("escapes"));
    assert!(resolve_in_root(&root(), "/var/lib/owlette-backup/config.json").expect_err("should reject").contains("escapes"));
    assert!(resolve_in_root(&root(), "config/../../secrets.json").expect_err("should reject").contains(".."));
  }

  #[test]
  fn case_is_not_folded_off_windows() {
    assert_ne!(compare_key(Path::new("/var/lib/Owlette")), compare_key(Path::new("/var/lib/owlette")));
    assert_eq!(compare_key(Path::new("/var/lib/owlette/")), "/var/lib/owlette");
  }
}
