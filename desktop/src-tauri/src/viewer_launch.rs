//! opening owlette swoop, the viewer app, from the tray and the window menu.
//!
//! the viewer is its own binary (`desktop/viewer`), installed beside this one
//! on windows and linux and as its own bundle on macos. it takes one argument,
//! an https url on an owlette host, so that is all this module ever hands it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use serde_json::Value;
use tauri::Url;

use crate::{json_io, paths, shell_open};

const PRODUCTION_HOST: &str = "owlette.app";
const DEV_HOST: &str = "dev.owlette.app";

const MAC_BUNDLE: &str = "/Applications/owlette swoop.app";

const NOT_INSTALLED: &str = "owlette swoop is not installed";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// whether the viewer app is on this machine, for greying out or hiding its entries
pub fn viewer_installed() -> bool {
  viewer_exe_path().is_some()
}

/// open the viewer on the swoop picker of the dashboard this machine reports to
pub fn open_picker() -> Result<(), String> {
  open_viewer(&format!("https://{}/swoop", dashboard_host()))
}

fn viewer_exe_path() -> Option<PathBuf> {
  let exe = std::env::current_exe().ok()?;
  let path = viewer_path(exe.parent()?, std::env::consts::OS);
  path.exists().then_some(path)
}

/// where the viewer lives for an app whose exe sits in `exe_dir`, on `os`
/// (`std::env::consts::OS`); taken as arguments so every platform is testable
fn viewer_path(exe_dir: &Path, os: &str) -> PathBuf {
  match os {
    "macos" => PathBuf::from(MAC_BUNDLE),
    "windows" => exe_dir.join("owlette-swoop-viewer.exe"),
    _ => exe_dir.join("owlette-swoop-viewer"),
  }
}

fn open_viewer(url: &str) -> Result<(), String> {
  open_with(viewer_exe_path().as_deref(), url)
}

/// the url is checked before the install, so a refused link never reaches a spawn
fn open_with(viewer: Option<&Path>, url: &str) -> Result<(), String> {
  let url = viewer_url(url)?;
  let viewer = viewer.ok_or_else(|| NOT_INSTALLED.to_string())?;
  spawn(viewer, url)
}

/// `url` when it is a web link on an owlette host; the viewer refuses any other
fn viewer_url(url: &str) -> Result<&str, String> {
  let url = shell_open::web_link(url)?;
  let parsed = Url::parse(url).map_err(|error| format!("refusing to open {url}: {error}"))?;
  match parsed.host_str() {
    Some(PRODUCTION_HOST | DEV_HOST) => Ok(url),
    _ => Err(format!("refusing to open a link off owlette: {url}")),
  }
}

fn spawn(viewer: &Path, url: &str) -> Result<(), String> {
  let mut command = if cfg!(target_os = "macos") {
    // `-n`: without it `open` only activates a running viewer and drops the
    // argument; a fresh launch hands it to the running one (single instance)
    let mut open = Command::new("open");
    open.arg("-n").arg("-a").arg(viewer).arg("--args").arg(url);
    open
  } else {
    let mut direct = Command::new(viewer);
    direct.arg(url);
    direct
  };
  command
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
  }
  let mut child = command
    .spawn()
    .map_err(|error| format!("could not start owlette swoop: {error}"))?;
  // waited on off-thread: this app outlives the viewer, and on unix an exited
  // child nobody waits on stays a zombie until it does
  if let Err(error) = thread::Builder::new()
    .name("owlette-swoop-viewer-wait".to_string())
    .spawn(move || child.wait())
  {
    log::debug!("owlette swoop started, but its exit will not be reaped: {error}");
  }
  Ok(())
}

/// the dashboard this machine reports to. nothing in rust read it before (the
/// window's `environment.ts` does), so this mirrors the agent's
/// `get_configured_api_base`: `firebase.api_base` when it names an owlette
/// host, else `environment`, else production. an unreadable config is production.
fn dashboard_host() -> &'static str {
  json_io::read_json(&paths::data_root().join(paths::CONFIG_REL))
    .map_or(PRODUCTION_HOST, |config| host_for(&config))
}

fn host_for(config: &Value) -> &'static str {
  let api_host = config
    .get("firebase")
    .and_then(|firebase| firebase.get("api_base"))
    .and_then(Value::as_str)
    .and_then(|base| Url::parse(base).ok())
    .and_then(|base| base.host_str().map(str::to_owned));
  match api_host.as_deref() {
    Some(DEV_HOST) => DEV_HOST,
    Some(PRODUCTION_HOST) => PRODUCTION_HOST,
    _ if config.get("environment").and_then(Value::as_str) == Some("development") => DEV_HOST,
    _ => PRODUCTION_HOST,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn the_viewer_sits_beside_the_app_off_macos_and_in_applications_on_it() {
    let dir = Path::new("app-dir");
    assert_eq!(
      viewer_path(dir, "windows"),
      dir.join("owlette-swoop-viewer.exe")
    );
    assert_eq!(viewer_path(dir, "linux"), dir.join("owlette-swoop-viewer"));
    assert_eq!(
      viewer_path(dir, "macos"),
      PathBuf::from("/Applications/owlette swoop.app")
    );
  }

  #[test]
  fn only_web_links_on_owlette_reach_the_viewer() {
    for accepted in [
      "https://owlette.app/swoop",
      "https://dev.owlette.app/swoop",
      "  https://dev.owlette.app/swoop/site-1/machine.2  ",
      "HTTPS://DEV.OWLETTE.APP/swoop",
    ] {
      assert_eq!(viewer_url(accepted), Ok(accepted.trim()), "{accepted}");
    }
    for (refused, why) in [
      ("https://example.com/swoop", "off owlette"),
      ("https://owlette.app.example.com/swoop", "off owlette"),
      ("https://example.com/?next=owlette.app", "off owlette"),
      ("https://staging.owlette.app/swoop", "off owlette"),
      ("owlette-swoop://owlette.app/swoop", "non-web link"),
      ("file:///C:/Windows/System32/cmd.exe", "non-web link"),
      ("javascript:alert(1)", "non-web link"),
      ("", "non-web link"),
      ("https://owlette.app/swoop\r\n--flag", "control characters"),
    ] {
      let error = viewer_url(refused).expect_err(refused);
      assert!(error.contains(why), "{refused}: {error}");
    }
  }

  #[test]
  fn a_refused_link_is_reported_before_a_missing_install() {
    let error = open_with(None, "https://example.com/swoop").expect_err("should refuse");
    assert!(error.contains("off owlette"), "{error}");

    let error = open_with(Some(Path::new("viewer")), "ms-settings:").expect_err("should refuse");
    assert!(error.contains("non-web link"), "{error}");
  }

  #[test]
  fn a_missing_viewer_is_reported_as_not_installed() {
    assert_eq!(
      open_with(None, "https://owlette.app/swoop"),
      Err(NOT_INSTALLED.to_string())
    );
  }

  #[test]
  fn the_dashboard_follows_the_api_base_then_the_environment() {
    let dev = json!({ "firebase": { "api_base": "https://dev.owlette.app/api" } });
    assert_eq!(host_for(&dev), DEV_HOST);

    let prod = json!({ "environment": "development", "firebase": { "api_base": "https://owlette.app/api" } });
    assert_eq!(host_for(&prod), PRODUCTION_HOST);

    let unpaired_dev = json!({ "environment": "development", "firebase": {} });
    assert_eq!(host_for(&unpaired_dev), DEV_HOST);

    // the agent ignores a non-owlette api_base, and so does this
    let foreign = json!({ "environment": "development", "firebase": { "api_base": "https://example.com/api" } });
    assert_eq!(host_for(&foreign), DEV_HOST);

    let unparseable = json!({ "firebase": { "api_base": "not a url" } });
    assert_eq!(host_for(&unparseable), PRODUCTION_HOST);

    assert_eq!(host_for(&json!({})), PRODUCTION_HOST);
    assert_eq!(
      host_for(&json!({ "environment": "production" })),
      PRODUCTION_HOST
    );
  }
}
