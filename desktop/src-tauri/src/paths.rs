//! Layout of the owlette data and install trees.
//!
//! The data root mirrors `osadapter.data_root()`: `%ProgramData%\Owlette` on
//! Windows, `/Library/Application Support/Owlette` on macOS, `/var/lib/owlette`
//! on Linux, with `OWLETTE_DATA_ROOT` relocating the whole tree exactly as it
//! relocates the python one — so the app and the agent never disagree about
//! where the seam is, and tests can redirect both.
//!
//! The install root is the payload the installer lays down: the bundled
//! interpreter, `agent/src` and `agent/VERSION`. On Windows it is the default
//! data root (the app ships inside that tree); on POSIX it is the fixed prefix
//! `shared_utils._POSIX_PYTHON_PATHS` names. No override moves it on any of
//! them.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

/// The one override, spelled as `osadapter.DATA_ROOT_ENV` spells it.
const DATA_ROOT_ENV: &str = "OWLETTE_DATA_ROOT";

/// Directory created under `%ProgramData%`.
#[cfg(windows)]
const DATA_DIR_NAME: &str = "Owlette";

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

/// The agent's version file, relative to the **install** root:
/// `shared_utils.get_app_version()` reads the same file from `agent/src`'s
/// parent, which is inside the payload rather than the data tree.
pub const AGENT_VERSION_REL: &str = "agent/VERSION";

/// Separator the compare keys carry — the one this platform's own paths use.
#[cfg(windows)]
const KEY_SEPARATOR: char = '\\';
#[cfg(not(windows))]
const KEY_SEPARATOR: char = '/';

/// Absolute path of the owlette data root.
pub fn data_root() -> PathBuf {
  root_for(std::env::var_os(DATA_ROOT_ENV))
}

/// The data root for a given override value. Split out so the precedence is
/// testable without writing to this process's environment.
fn root_for(override_root: Option<OsString>) -> PathBuf {
  match override_root.filter(|value| !value.is_empty()) {
    Some(value) => absolute(PathBuf::from(value)),
    None => default_data_root(),
  }
}

/// `%ProgramData%\Owlette`. The variable is spelled as `agent/host`'s
/// `paths::data_dir` spells it; reading it rather than hardcoding the drive
/// keeps the app on exactly the tree the service uses.
#[cfg(windows)]
fn default_data_root() -> PathBuf {
  let program_data = std::env::var_os("ProgramData")
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "C:\\ProgramData".into());
  Path::new(&program_data).join(DATA_DIR_NAME)
}

#[cfg(target_os = "macos")]
fn default_data_root() -> PathBuf {
  PathBuf::from("/Library/Application Support/Owlette")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_data_root() -> PathBuf {
  PathBuf::from("/var/lib/owlette")
}

/// Root of the installed payload. Windows ships the app inside the data tree,
/// so the two are one directory — the one the installer wrote, which is why
/// this reads the default and not the override: `OWLETTE_DATA_ROOT` relocates
/// the tree the app and the agent share, never the payload, exactly as
/// `shared_utils.get_app_version()` reads the version off `__file__` however
/// the data tree has been redirected.
#[cfg(windows)]
pub fn install_root() -> PathBuf {
  default_data_root()
}

#[cfg(target_os = "macos")]
pub fn install_root() -> PathBuf {
  PathBuf::from("/Library/Application Support/Owlette/runtime")
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn install_root() -> PathBuf {
  PathBuf::from("/opt/owlette")
}

/// `os.path.abspath` for an override: a relative value resolves against this
/// process's working directory and `.`/`..` collapse, so every path built on
/// the root afterwards is plain and absolute.
fn absolute(path: PathBuf) -> PathBuf {
  let rooted = if path.is_absolute() {
    path
  } else {
    match std::env::current_dir() {
      Ok(cwd) => cwd.join(path),
      Err(_) => path,
    }
  };
  normalize(&rooted)
}

fn normalize(path: &Path) -> PathBuf {
  let mut normalized = PathBuf::new();
  let mut rooted = false;
  for component in path.components() {
    match component {
      Component::CurDir => {}
      // At the root there is nothing above to step to, which is where
      // `abspath` drops the segment rather than keeping it.
      Component::ParentDir => {
        if !normalized.pop() && !rooted {
          normalized.push(component.as_os_str());
        }
      }
      other => {
        rooted |= matches!(other, Component::Prefix(_) | Component::RootDir);
        normalized.push(other.as_os_str());
      }
    }
  }
  normalized
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
  if candidate_key == root_key || candidate_key.starts_with(&format!("{root_key}{KEY_SEPARATOR}")) {
    Ok(normalized)
  } else {
    Err(format!(
      "path escapes the owlette data directory: {}",
      normalized.display()
    ))
  }
}

/// Windows path comparison key: separators unified, case folded, no trailing
/// separator. Used for containment checks and for matching watcher events
/// against the files we care about.
#[cfg(windows)]
pub fn compare_key(path: &Path) -> String {
  path
    .to_string_lossy()
    .replace('/', "\\")
    .trim_end_matches('\\')
    .to_lowercase()
}

/// POSIX comparison key: one separator, and no case folding — a Linux
/// filesystem is case-sensitive and a macOS one may be, so folding would widen
/// containment on a volume that does not. A root that trims away to nothing
/// keeps its separator, which makes `/` contain only itself rather than
/// everything.
#[cfg(not(windows))]
pub fn compare_key(path: &Path) -> String {
  let key = path.to_string_lossy();
  let trimmed = key.trim_end_matches(KEY_SEPARATOR);
  if trimmed.is_empty() {
    KEY_SEPARATOR.to_string()
  } else {
    trimmed.to_string()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[cfg(windows)]
  fn root() -> PathBuf {
    PathBuf::from("C:\\ProgramData\\Owlette")
  }

  #[cfg(target_os = "macos")]
  fn root() -> PathBuf {
    PathBuf::from("/Library/Application Support/Owlette")
  }

  #[cfg(all(unix, not(target_os = "macos")))]
  fn root() -> PathBuf {
    PathBuf::from("/var/lib/owlette")
  }

  /// A path the platform keeps well outside the owlette tree.
  #[cfg(windows)]
  const OUTSIDE_THE_ROOT: &str = "C:\\Windows\\System32\\drivers\\etc\\hosts";
  #[cfg(not(windows))]
  const OUTSIDE_THE_ROOT: &str = "/etc/hosts";

  /// `<root>Backup` — a sibling whose name has the root's as a prefix.
  fn sibling_of_root() -> PathBuf {
    let mut name = root()
      .file_name()
      .expect("the root is named")
      .to_os_string();
    name.push("Backup");
    root().with_file_name(name)
  }

  #[test]
  fn relative_paths_resolve_under_the_root() {
    let resolved = resolve_in_root(&root(), CONFIG_REL).expect("should resolve");
    assert_eq!(resolved, root().join("config").join("config.json"));
  }

  #[test]
  fn absolute_paths_inside_the_root_are_accepted() {
    let absolute = root().join("tmp").join("app_states.json");
    let resolved = resolve_in_root(&root(), &absolute.to_string_lossy()).expect("should resolve");
    assert_eq!(compare_key(&resolved), compare_key(&absolute));
  }

  #[test]
  #[cfg(windows)]
  fn case_and_separator_differences_do_not_break_containment() {
    let resolved = resolve_in_root(&root(), "c:/programdata/owlette/tmp/service_status.json")
      .expect("should resolve");
    assert_eq!(
      compare_key(&resolved),
      "c:\\programdata\\owlette\\tmp\\service_status.json"
    );
  }

  /// Negative control for the Windows arm above: off Windows the filesystem may
  /// be case-sensitive, so a differently-cased root is a different directory.
  #[test]
  #[cfg(not(windows))]
  fn case_differences_do_not_widen_the_root() {
    let shouted = root().to_string_lossy().to_uppercase();
    let error = resolve_in_root(&root(), &format!("{shouted}/tmp/service_status.json"))
      .expect_err("should reject");
    assert!(error.contains("escapes"), "unexpected error: {error}");
  }

  #[test]
  fn parent_segments_are_rejected() {
    let err = resolve_in_root(&root(), "config/../../secrets.json").expect_err("should reject");
    assert!(err.contains(".."), "unexpected error: {err}");
  }

  #[test]
  fn paths_outside_the_root_are_rejected() {
    let err = resolve_in_root(&root(), OUTSIDE_THE_ROOT).expect_err("should reject");
    assert!(err.contains("escapes"), "unexpected error: {err}");
  }

  #[test]
  fn a_sibling_directory_with_the_root_as_a_prefix_is_rejected() {
    let sibling = sibling_of_root().join("config.json");
    let err = resolve_in_root(&root(), &sibling.to_string_lossy()).expect_err("should reject");
    assert!(err.contains("escapes"), "unexpected error: {err}");
  }

  #[test]
  fn empty_paths_are_rejected() {
    assert!(resolve_in_root(&root(), "   ").is_err());
  }

  #[test]
  #[cfg(windows)]
  fn the_default_data_root_hangs_off_the_programdata_variable() {
    let program_data = std::env::var_os("ProgramData").expect("windows sets ProgramData");
    assert_eq!(
      default_data_root(),
      Path::new(&program_data).join(DATA_DIR_NAME)
    );
  }

  #[test]
  #[cfg(not(windows))]
  fn the_default_data_root_is_the_tree_the_agent_uses() {
    // Byte-for-byte `osadapter.posix.DATA_ROOT`.
    assert_eq!(default_data_root(), root());
  }

  #[test]
  fn an_override_names_the_data_root_outright() {
    let relocated = root().with_file_name("owlette-relocated");
    assert_eq!(
      root_for(Some(relocated.clone().into_os_string())),
      relocated
    );
  }

  #[test]
  fn no_override_leaves_the_default_root() {
    assert_eq!(root_for(None), default_data_root());
    assert_eq!(root_for(Some(OsString::new())), default_data_root());
  }

  #[test]
  fn an_override_is_normalised_the_way_abspath_normalises_it() {
    let noisy = root().join("child").join("..").join("sibling");
    assert_eq!(
      root_for(Some(noisy.into_os_string())),
      root().join("sibling")
    );
  }

  #[test]
  fn a_relative_override_resolves_against_the_working_directory() {
    let cwd = std::env::current_dir().expect("a working directory");
    assert_eq!(
      root_for(Some(OsString::from("owlette-relocated"))),
      cwd.join("owlette-relocated")
    );
  }

  /// Windows is the one platform where the two roots name the same directory,
  /// so it is the one where an override could quietly take the payload with it
  /// — it must not, or the tray reads the agent's version out of a relocated
  /// tree that holds no payload. Setting the variable is safe here because this
  /// test compiles only on Windows, where the environment is a Win32 call
  /// rather than glibc's `environ`, and nothing else in the suite reads the data
  /// root while it is set.
  #[test]
  #[cfg(windows)]
  fn an_override_moves_the_data_root_and_leaves_the_install_root() {
    let relocated = format!("C:\\owlette-relocated-{}", std::process::id());
    std::env::set_var(DATA_ROOT_ENV, &relocated);
    let moved = data_root();
    let payload = install_root();
    std::env::remove_var(DATA_ROOT_ENV);

    // The negative control is the first assertion: without it the second would
    // pass against an install root that simply never saw the override.
    assert_eq!(moved, PathBuf::from(&relocated));
    assert_eq!(payload, default_data_root());
  }

  /// The POSIX payloads install to a fixed prefix, so the data-root override
  /// never moves the interpreter or the VERSION file with the tree.
  #[test]
  #[cfg(target_os = "macos")]
  fn the_install_root_is_the_packaged_runtime() {
    assert_eq!(
      install_root(),
      PathBuf::from("/Library/Application Support/Owlette/runtime")
    );
  }

  #[test]
  #[cfg(all(unix, not(target_os = "macos")))]
  fn the_install_root_is_the_packaged_prefix() {
    assert_eq!(install_root(), PathBuf::from("/opt/owlette"));
  }
}
