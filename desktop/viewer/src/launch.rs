//! at most one argument and no flags: a page on an allowed origin, or an
//! `owlette-swoop://` link to one. with none the app opens the picker on the
//! origin it was last given, else on the dashboard the agent on this machine
//! reports to, so a start menu launch on a dev operator's box lands on
//! dev.owlette.app.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Url};

use crate::{origin, windows};

const STATE_FILE: &str = "viewer.json";
const DEFAULT_ORIGIN: &str = "https://owlette.app";
const DEV_ORIGIN: &str = "https://dev.owlette.app";
const HOME_PATH: &str = "/swoop";

// the agent's data root, as desktop/src-tauri/src/paths.rs resolves it
const DATA_ROOT_ENV: &str = "OWLETTE_DATA_ROOT";
const AGENT_CONFIG: &str = "config/config.json";

#[derive(Debug, PartialEq, Eq)]
pub enum Launch {
  Open(Url),
  Home,
}

#[derive(Serialize, Deserialize)]
struct Remembered {
  origin: String,
}

// `args` is argv without the program
pub fn parse(args: &[String]) -> Result<Launch, String> {
  match args {
    [] => Ok(Launch::Home),
    [arg] => origin::allowed_origin(arg)
      .or_else(|| origin::from_deep_link(arg))
      .map(Launch::Open)
      .ok_or_else(|| "the launch argument is not an owlette page".to_string()),
    _ => Err(format!(
      "expected at most one launch argument, got {}",
      args.len()
    )),
  }
}

pub fn remember(dir: &Path, url: &Url) -> io::Result<()> {
  let state = Remembered {
    origin: url.origin().ascii_serialization(),
  };
  fs::create_dir_all(dir)?;
  fs::write(dir.join(STATE_FILE), serde_json::to_vec(&state)?)
}

// held to the same allowlist as an argument: anything running as the user can
// write the file
pub fn remembered_origin(dir: &Path, agent_config: &Path) -> Url {
  fs::read(dir.join(STATE_FILE))
    .ok()
    .and_then(|bytes| serde_json::from_slice::<Remembered>(&bytes).ok())
    .and_then(|state| origin::allowed_origin(&state.origin))
    .unwrap_or_else(|| agent_origin(agent_config))
}

pub fn agent_config_path() -> PathBuf {
  let root = match std::env::var_os(DATA_ROOT_ENV).filter(|root| !root.is_empty()) {
    Some(root) => PathBuf::from(root),
    None if cfg!(windows) => std::env::var_os("PROGRAMDATA")
      .filter(|root| !root.is_empty())
      .map_or_else(|| PathBuf::from("C:\\ProgramData"), PathBuf::from)
      .join("Owlette"),
    None if cfg!(target_os = "macos") => PathBuf::from("/Library/Application Support/Owlette"),
    None => PathBuf::from("/var/lib/owlette"),
  };
  root.join(AGENT_CONFIG)
}

// the desktop app's rule (viewer_launch.rs `host_for`): the agent's api_base
// when it is an allowed origin (a debug build also takes localhost), else its
// environment. prod when there is no agent, as on an operator's workstation
fn agent_origin(config: &Path) -> Url {
  let config = fs::read(config)
    .ok()
    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
  let api_base = config
    .as_ref()
    .and_then(|config| config.get("firebase")?.get("api_base")?.as_str())
    .and_then(origin::allowed_origin);
  let development = config
    .as_ref()
    .and_then(|config| config.get("environment")?.as_str())
    == Some("development");
  let origin = match api_base {
    Some(api_base) => api_base.origin().ascii_serialization(),
    None if development => DEV_ORIGIN.to_string(),
    None => DEFAULT_ORIGIN.to_string(),
  };
  Url::parse(&origin).expect("an origin is a url")
}

pub fn home_url(dir: &Path, agent_config: &Path) -> Url {
  let mut url = remembered_origin(dir, agent_config);
  url.set_path(HOME_PATH);
  url.set_query(None);
  url.set_fragment(None);
  url
}

// a refused argument still opens the picker: someone launched the app
pub fn handle(app: &AppHandle, args: &[String]) -> tauri::Result<()> {
  let dir = app.path().app_data_dir()?;
  let launch = parse(args).unwrap_or_else(|reason| {
    log::warn!("{reason}; opening the picker");
    Launch::Home
  });
  match launch {
    Launch::Open(url) => {
      if let Err(error) = remember(&dir, &url) {
        log::warn!(
          "could not remember {}: {error}",
          url.origin().ascii_serialization()
        );
      }
      windows::open(app, url)
    }
    Launch::Home => windows::open_home(app, home_url(&dir, &agent_config_path())),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const CONFIG_FILE: &str = "agent-config.json";

  // removed file by file on drop, never recursively
  struct Scratch(PathBuf);

  impl Scratch {
    fn new(name: &str) -> Self {
      let dir = std::env::temp_dir().join(format!(
        "owlette-swoop-viewer-{}-{name}",
        std::process::id()
      ));
      let _ = fs::remove_file(dir.join(STATE_FILE));
      let _ = fs::remove_file(dir.join(CONFIG_FILE));
      Self(dir)
    }

    fn write(&self, body: &str) {
      fs::create_dir_all(&self.0).expect("create scratch dir");
      fs::write(self.0.join(STATE_FILE), body).expect("write state");
    }

    // the agent's config; absent until written, as on a box with no agent
    fn config(&self) -> PathBuf {
      self.0.join(CONFIG_FILE)
    }

    fn write_config(&self, body: &str) {
      fs::create_dir_all(&self.0).expect("create scratch dir");
      fs::write(self.config(), body).expect("write config");
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_file(self.0.join(STATE_FILE));
      let _ = fs::remove_file(self.config());
      let _ = fs::remove_dir(&self.0);
    }
  }

  fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
  }

  fn url(value: &str) -> Url {
    Url::parse(value).expect("test url")
  }

  #[test]
  fn no_argument_is_the_picker() {
    assert_eq!(parse(&[]), Ok(Launch::Home));
  }

  #[test]
  fn one_owlette_page_is_opened() {
    assert_eq!(
      parse(&args(&["https://dev.owlette.app/swoop"])),
      Ok(Launch::Open(url("https://dev.owlette.app/swoop")))
    );
    assert_eq!(
      parse(&args(&["https://owlette.app/swoop/site-1/B4A"])),
      Ok(Launch::Open(url("https://owlette.app/swoop/site-1/B4A")))
    );
  }

  #[test]
  fn a_deep_link_is_opened_as_https() {
    assert_eq!(
      parse(&args(&["owlette-swoop://dev.owlette.app/swoop/site-1/B4A"])),
      Ok(Launch::Open(url(
        "https://dev.owlette.app/swoop/site-1/B4A"
      )))
    );
  }

  #[test]
  fn anything_else_is_refused() {
    for refused in [
      args(&["https://evil.com/swoop"]),
      args(&["--tray"]),
      args(&[""]),
      args(&["owlette-swoop://evil.com/swoop"]),
      args(&["https://owlette.app/swoop", "https://dev.owlette.app/swoop"]),
      args(&["--url", "https://owlette.app/swoop"]),
    ] {
      assert!(parse(&refused).is_err(), "{refused:?} should be refused");
    }
  }

  #[test]
  fn with_nothing_remembered_and_no_agent_home_is_prod() {
    let scratch = Scratch::new("nothing-remembered");
    assert_eq!(
      remembered_origin(&scratch.0, &scratch.config()),
      url("https://owlette.app")
    );
    assert_eq!(
      home_url(&scratch.0, &scratch.config()),
      url("https://owlette.app/swoop")
    );
  }

  // a dock launch on a dev-paired mac opened prod, which had no swoop sign-in
  // yet (bryant place, 2026-10-12)
  #[test]
  fn with_nothing_remembered_home_follows_the_agent() {
    let scratch = Scratch::new("agent-config");
    for (config, expected) in [
      (
        r#"{"firebase":{"api_base":"https://dev.owlette.app/api"}}"#,
        "https://dev.owlette.app/swoop",
      ),
      (
        r#"{"environment":"development","firebase":{"api_base":"https://owlette.app/api"}}"#,
        "https://owlette.app/swoop",
      ),
      (
        r#"{"environment":"development","firebase":{}}"#,
        "https://dev.owlette.app/swoop",
      ),
      (
        r#"{"environment":"development","firebase":{"api_base":"https://evil.com/api"}}"#,
        "https://dev.owlette.app/swoop",
      ),
      (
        r#"{"firebase":{"api_base":"https://evil.com/api"}}"#,
        "https://owlette.app/swoop",
      ),
      ("not json", "https://owlette.app/swoop"),
    ] {
      scratch.write_config(config);
      assert_eq!(
        home_url(&scratch.0, &scratch.config()),
        url(expected),
        "{config}"
      );
    }
  }

  #[test]
  fn a_remembered_origin_wins_over_the_agent() {
    let scratch = Scratch::new("remembered-over-agent");
    scratch.write(r#"{"origin":"https://owlette.app"}"#);
    scratch.write_config(r#"{"firebase":{"api_base":"https://dev.owlette.app/api"}}"#);
    assert_eq!(
      home_url(&scratch.0, &scratch.config()),
      url("https://owlette.app/swoop")
    );
  }

  #[test]
  fn a_given_origin_is_remembered_without_its_path() {
    let scratch = Scratch::new("remembered");
    remember(
      &scratch.0,
      &url("https://dev.owlette.app/swoop/site-1/B4A?x=1#y"),
    )
    .expect("remember");
    let body = fs::read_to_string(scratch.0.join(STATE_FILE)).expect("state written");
    assert_eq!(body, r#"{"origin":"https://dev.owlette.app"}"#);
    assert_eq!(
      home_url(&scratch.0, &scratch.config()),
      url("https://dev.owlette.app/swoop")
    );
  }

  #[test]
  fn a_tampered_or_broken_file_falls_back_to_prod() {
    let scratch = Scratch::new("tampered");
    for body in [
      r#"{"origin":"https://evil.com"}"#,
      r#"{"origin":"owlette-swoop://dev.owlette.app"}"#,
      r#"{"origin":42}"#,
      "not json",
      "",
    ] {
      scratch.write(body);
      assert_eq!(
        home_url(&scratch.0, &scratch.config()),
        url("https://owlette.app/swoop"),
        "{body}"
      );
    }
  }

  #[test]
  fn a_remembered_dev_server_counts_only_in_a_debug_build() {
    let scratch = Scratch::new("localhost");
    scratch.write(r#"{"origin":"http://localhost:3000"}"#);
    let expected = if cfg!(debug_assertions) {
      "http://localhost:3000/swoop"
    } else {
      "https://owlette.app/swoop"
    };
    assert_eq!(home_url(&scratch.0, &scratch.config()), url(expected));
  }
}
