//! `{userstartup}\Owlette.lnk` — storage for the tray's "start on login".
//!
//! The legacy tray toggled the *service* start type instead (`sc config
//! OwletteService start= …`), which costs a UAC prompt and conflates
//! "supervise this machine" with "show me a tray icon". Owning the installer's
//! shortcut (`owlette_installer.iss`, `[Icons]`) needs no elevation, and
//! turning it off leaves the service running.
//!
//! Enabling always REWRITES the shortcut: the installer's version points at
//! `pythonw.exe owlette_tray.py`, so an upgraded machine would otherwise keep
//! auto-starting the python tray instead of this exe with `--tray`.

use std::path::{Path, PathBuf};

#[cfg(windows)]
use windows::core::{Interface, HSTRING, PWSTR};
#[cfg(windows)]
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
#[cfg(windows)]
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
#[cfg(windows)]
use windows::Win32::System::Com::{
  CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
  CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
#[cfg(windows)]
use windows::Win32::UI::Shell::{
  FOLDERID_Startup, IShellLinkW, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT,
};

/// File name of the shortcut, byte-identical to the installer's `[Icons]`
/// entry (`Name: "{userstartup}\Owlette"`) so the two never coexist.
///
/// Load-bearing beyond the filesystem: Windows draws a toast's attribution line
/// from the NAME of the shortcut registering the sending app id, so any
/// shortcut carrying [`APP_USER_MODEL_ID`] must be called "Owlette".
#[cfg(windows)]
pub const LINK_NAME: &str = "Owlette.lnk";
/// The autostart entry off windows: an xdg desktop entry on linux, a per-user
/// launch agent on macos. both relaunch the app at login with `--tray`, which
/// is what the shortcut does on windows (tri-platform task 4.2).
#[cfg(all(unix, not(target_os = "macos")))]
pub const LINK_NAME: &str = "owlette-desktop.desktop";
#[cfg(target_os = "macos")]
pub const LINK_NAME: &str = "app.owlette.desktop.plist";

/// What [`LINK_NAME`] was called through 2.x and the first 3.0.0 builds.
///
/// Removed whenever this module writes or clears the shortcut so a machine that
/// upgrades without running the installer (every dev box) doesn't auto-start
/// twice, and so "off" really is off. The installer handles it via
/// `[InstallDelete]`; this covers the other path.
#[cfg(windows)]
const LEGACY_LINK_NAME: &str = "Owlette Tray.lnk";

/// Argument the shortcut passes, which starts the app hidden in the tray.
pub const TRAY_ARG: &str = "--tray";

/// Application identity stamped onto the shortcut. Keep equal to
/// `tauri.conf.json`'s `identifier`.
///
/// Windows won't display a toast from a non-packaged desktop app unless some
/// shortcut under the Start menu carries a matching `System.AppUserModel.ID`,
/// and the notification plugin sends under the bundle identifier. The Startup
/// folder is inside the Start menu tree, so writing it here registers the
/// identity without waiting for the installer.
#[cfg(windows)]
const APP_USER_MODEL_ID: &str = "app.owlette.desktop";

/// Where the entry lives off windows: `$XDG_CONFIG_HOME/autostart` (or
/// `~/.config/autostart`) on linux, `~/Library/LaunchAgents` on macos. the
/// user's own tree, never a system one — a kiosk user owns its login items.
#[cfg(unix)]
pub fn link_path() -> Result<PathBuf, String> {
  Ok(startup_dir()?.join(LINK_NAME))
}

#[cfg(unix)]
fn startup_dir() -> Result<PathBuf, String> {
  let home = std::env::var_os("HOME")
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
    .ok_or_else(|| "HOME is not set, so there is no login-items directory to use".to_string())?;
  if cfg!(target_os = "macos") {
    return Ok(home.join("Library").join("LaunchAgents"));
  }
  let config = std::env::var_os("XDG_CONFIG_HOME")
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
    .unwrap_or_else(|| home.join(".config"));
  Ok(config.join("autostart"))
}

#[cfg(unix)]
pub fn is_enabled() -> bool {
  match link_path() {
    Ok(path) => path.is_file(),
    Err(error) => {
      log::warn!("could not locate the login-items directory: {error}");
      false
    }
  }
}

#[cfg(unix)]
pub fn enable() -> Result<PathBuf, String> {
  let path = link_path()?;
  let exe = std::env::current_exe().map_err(|error| format!("could not locate this exe: {error}"))?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
  }
  std::fs::write(&path, login_item(&exe))
    .map_err(|error| format!("could not write {}: {error}", path.display()))?;
  Ok(path)
}

#[cfg(unix)]
pub fn disable() -> Result<(), String> {
  let path = link_path()?;
  match std::fs::remove_file(&path) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(format!("could not remove {}: {error}", path.display())),
  }
}

/// The entry's text: a desktop entry or a launchd property list, both
/// launching this exe with `--tray`.
#[cfg(unix)]
fn login_item(exe: &Path) -> String {
  let exe = exe.display();
  if cfg!(target_os = "macos") {
    format!(
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
       <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
       <plist version=\"1.0\">\n<dict>\n\
       \t<key>Label</key>\n\t<string>app.owlette.desktop</string>\n\
       \t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>{exe}</string>\n\t\t<string>{TRAY_ARG}</string>\n\t</array>\n\
       \t<key>RunAtLoad</key>\n\t<true/>\n\
       </dict>\n</plist>\n"
    )
  } else {
    format!(
      "[Desktop Entry]\nType=Application\nName=owlette\nExec=\"{exe}\" {TRAY_ARG}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    )
  }
}

/// Absolute path of the shortcut in the current user's Startup folder.
#[cfg(windows)]
pub fn link_path() -> Result<PathBuf, String> {
  Ok(startup_dir()?.join(LINK_NAME))
}

/// Absolute path of the pre-rename shortcut, for cleanup only.
#[cfg(windows)]
fn legacy_link_path() -> Result<PathBuf, String> {
  Ok(startup_dir()?.join(LEGACY_LINK_NAME))
}

/// True when owlette is set to start with this user's session.
///
/// Presence is the whole test. An installer-left shortcut still points at the
/// python tray, but something owlette DOES launch at login, so "on" is correct
/// and [`enable`] then replaces it. The pre-rename name counts for the same
/// reason: reporting "off" while it sits there is a lie the toggle can't fix.
#[cfg(windows)]
pub fn is_enabled() -> bool {
  match (link_path(), legacy_link_path()) {
    (Ok(path), Ok(legacy)) => path.is_file() || legacy.is_file(),
    (Ok(path), Err(_)) => path.is_file(),
    (Err(error), _) => {
      log::warn!("could not locate the startup folder: {error}");
      false
    }
  }
}

/// Create (or replace) the startup shortcut, pointing at this executable.
#[cfg(windows)]
pub fn enable() -> Result<PathBuf, String> {
  let path = link_path()?;
  write_link(&path)?;
  // Only after the new one is on disk: a failed write must not leave the machine
  // with no startup entry at all.
  remove_legacy_link();
  Ok(path)
}

/// Write the shortcut to an explicit path. Split out from [`enable`] so it can
/// be exercised against a scratch file instead of the live Startup folder.
#[cfg(windows)]
fn write_link(path: &Path) -> Result<(), String> {
  let exe =
    std::env::current_exe().map_err(|error| format!("could not locate this exe: {error}"))?;
  let working_dir = exe
    .parent()
    .map(|parent| parent.to_path_buf())
    .unwrap_or_else(|| exe.clone());

  let _com = ComGuard::new()?;

  // SAFETY: every call below is a plain COM call on an interface we own for the
  // duration of this function; no pointer outlives it.
  unsafe {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
      .map_err(|error| format!("could not create a shell link: {error}"))?;

    link
      .SetPath(&HSTRING::from(exe.as_os_str()))
      .map_err(|error| format!("could not set the shortcut target: {error}"))?;
    link
      .SetArguments(&HSTRING::from(TRAY_ARG))
      .map_err(|error| format!("could not set the shortcut arguments: {error}"))?;
    link
      .SetWorkingDirectory(&HSTRING::from(working_dir.as_os_str()))
      .map_err(|error| format!("could not set the shortcut working directory: {error}"))?;
    link
      .SetDescription(&HSTRING::from("owlette"))
      .map_err(|error| format!("could not set the shortcut description: {error}"))?;

    let properties: IPropertyStore = link
      .cast()
      .map_err(|error| format!("could not open the shortcut property store: {error}"))?;
    properties
      .SetValue(&PKEY_AppUserModel_ID, &PROPVARIANT::from(APP_USER_MODEL_ID))
      .map_err(|error| format!("could not set the shortcut app id: {error}"))?;
    properties
      .Commit()
      .map_err(|error| format!("could not commit the shortcut properties: {error}"))?;

    let persist: IPersistFile = link
      .cast()
      .map_err(|error| format!("could not persist the shortcut: {error}"))?;
    persist
      .Save(&HSTRING::from(path.as_os_str()), true)
      .map_err(|error| format!("could not write {}: {error}", path.display()))?;
  }

  Ok(())
}

/// Remove the startup shortcut; missing is already the target state. The
/// pre-rename name goes too, or "off" would leave it launching owlette at login.
#[cfg(windows)]
pub fn disable() -> Result<(), String> {
  let path = link_path()?;
  let removed = match std::fs::remove_file(&path) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(format!("could not remove {}: {error}", path.display())),
  };
  remove_legacy_link();
  removed
}

/// Best effort: a stuck legacy shortcut is worth a log line, never a failed
/// toggle — [`is_enabled`] and the installer act on the current name.
#[cfg(windows)]
fn remove_legacy_link() {
  let Ok(path) = legacy_link_path() else {
    return;
  };
  match std::fs::remove_file(&path) {
    Ok(()) => log::info!("removed the legacy startup shortcut {}", path.display()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => log::warn!("could not remove {}: {error}", path.display()),
  }
}

/// The current user's Startup folder, resolved through the shell rather than
/// composed from `%APPDATA%` so a redirected profile still works.
#[cfg(windows)]
fn startup_dir() -> Result<PathBuf, String> {
  // SAFETY: `SHGetKnownFolderPath` allocates the string with the COM allocator
  // and we free it with `CoTaskMemFree` on both paths below.
  unsafe {
    let raw: PWSTR = SHGetKnownFolderPath(&FOLDERID_Startup, KF_FLAG_DEFAULT, None)
      .map_err(|error| format!("SHGetKnownFolderPath failed: {error}"))?;
    let value = raw.to_string();
    CoTaskMemFree(Some(raw.0 as *const _));
    value
      .map(PathBuf::from)
      .map_err(|error| format!("startup folder path is not valid utf-16: {error}"))
  }
}

/// Initialises COM for the calling thread, uninitialises on drop. The tray runs
/// each menu action on its own short-lived thread, so this owns the apartment
/// rather than assuming the caller set one up.
#[cfg(windows)]
struct ComGuard;

#[cfg(windows)]
impl ComGuard {
  fn new() -> Result<Self, String> {
    // SAFETY: a plain COM initialisation for this thread; paired with the
    // `CoUninitialize` in `Drop`.
    let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if result.is_err() {
      return Err(format!("could not initialise COM: {result:?}"));
    }
    Ok(Self)
  }
}

#[cfg(windows)]
impl Drop for ComGuard {
  fn drop(&mut self) {
    // SAFETY: balances the `CoInitializeEx` in `new`, on the same thread.
    unsafe { CoUninitialize() };
  }
}

#[cfg(all(test, unix))]
mod unix_tests {
  use super::*;

  #[test]
  fn the_entry_lives_in_the_user_login_items_and_launches_the_tray() {
    let path = link_path().expect("a home directory");
    assert!(path.ends_with(LINK_NAME), "{}", path.display());
    let text = login_item(Path::new("/opt/owlette/app/owlette-desktop"));
    assert!(text.contains("/opt/owlette/app/owlette-desktop"), "{text}");
    assert!(text.contains(TRAY_ARG), "{text}");
  }
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;

  #[test]
  fn the_link_lives_in_the_startup_folder_under_the_installer_name() {
    let path = link_path().expect("startup folder");
    assert_eq!(
      path.file_name().and_then(|name| name.to_str()),
      Some(LINK_NAME)
    );
    assert!(
      path
        .to_string_lossy()
        .to_lowercase()
        .ends_with("\\startup\\owlette.lnk"),
      "unexpected startup path: {}",
      path.display()
    );
  }

  /// Toast attribution is the shortcut's NAME, so any other name attributes
  /// owlette's notifications elsewhere. Pins the one this module owns.
  #[test]
  fn the_shortcut_is_named_for_the_product_not_the_tray() {
    assert_eq!(LINK_NAME, "Owlette.lnk");
    assert_ne!(LINK_NAME, LEGACY_LINK_NAME);
    assert_eq!(LEGACY_LINK_NAME, "Owlette Tray.lnk");
  }

  #[test]
  fn is_enabled_matches_the_file_on_disk() {
    let path = link_path().expect("startup folder");
    let legacy = legacy_link_path().expect("startup folder");
    assert_eq!(is_enabled(), path.is_file() || legacy.is_file());
  }

  /// The shortcut's `System.AppUserModel.ID` is what lets Windows show the
  /// tray's toasts at all — a regression here is silent.
  #[test]
  fn the_shortcut_carries_the_tray_argument_and_the_app_id() {
    let path = std::env::temp_dir().join(format!("owlette-link-{}.lnk", std::process::id()));
    let _ = std::fs::remove_file(&path);
    write_link(&path).expect("write shortcut");
    assert!(path.is_file(), "shortcut was not written");

    let _com = ComGuard::new().expect("com");
    // SAFETY: the shortcut is loaded, read and dropped inside this block.
    unsafe {
      let link: IShellLinkW =
        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).expect("shell link");
      link
        .cast::<IPersistFile>()
        .expect("persist")
        .Load(
          &HSTRING::from(path.as_os_str()),
          windows::Win32::System::Com::STGM_READ,
        )
        .expect("load shortcut");

      let mut arguments = [0u16; 256];
      link.GetArguments(&mut arguments).expect("arguments");
      let arguments = String::from_utf16_lossy(&arguments);
      assert_eq!(arguments.trim_end_matches('\0'), TRAY_ARG);

      let app_id = link
        .cast::<IPropertyStore>()
        .expect("property store")
        .GetValue(&PKEY_AppUserModel_ID)
        .expect("app id");
      assert_eq!(app_id.to_string(), APP_USER_MODEL_ID);
    }

    let _ = std::fs::remove_file(&path);
  }
}
