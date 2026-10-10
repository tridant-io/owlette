//! owlette swoop has no frontend of its own: every window loads owlette.app
//! top-level, so the sign-in cookie, the step-up window and daily web deploys
//! all carry over (an iframe is refused by the site's frame-ancestors, and a
//! bundled copy would lose all three). no tray: closing the last window quits.

#[cfg(target_os = "macos")]
mod keys_macos;
mod launch;
#[cfg(target_os = "macos")]
mod mac;
mod origin;
#[cfg(windows)]
mod permissions_windows;
mod windows;

use std::collections::HashSet;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tauri::plugin::TauriPlugin;
#[cfg(debug_assertions)]
use tauri::utils::acl::capability::{Capability, CapabilityRemote};
use tauri::{AppHandle, Manager, Runtime, Window, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const LOG_FILE_NAME: &str = "owlette-swoop-viewer";

// the desktop app's rotation: the plugin's 40 kb default is minutes of log
const LOG_MAX_FILE_SIZE: u128 = 4 * 1024 * 1024;
const LOG_FILES_KEPT: usize = 3;

// in app mode a session page ends its session on this (keepalive DELETE), so
// closing its window frees the machine at once instead of at the server's
// timeout; any other page ignores it. every window gets it, since main may
// hold a session too
const CLOSE_EVENT_SCRIPT: &str = "window.dispatchEvent(new Event('owlette:close'))";
const CLOSE_GRACE: Duration = Duration::from_millis(300);

// macos starts the app for an owlette-swoop:// link with no argument and hands
// the link over as an apple event just after setup (gate g0), so a bare launch
// waits this long before opening the picker
const DEEP_LINK_GRACE: Duration = Duration::from_millis(500);

// owlette.app may minimize, maximize, close and drag this app's windows, nothing else
// (capabilities/owlette-pages.json). a capability file applies to every build,
// so the local web dev server gets the same grant at run time, in a debug build
// only, as `origin::allowed_origin` lets only a debug build load it
#[cfg(debug_assertions)]
const OWLETTE_PAGES_CAPABILITY: &str = include_str!("../capabilities/owlette-pages.json");
#[cfg(debug_assertions)]
const DEV_SERVER_PAGES: &str = "http://localhost:*/*";

// windows whose page has been told; their next close request passes
#[derive(Default)]
struct Ending(Mutex<HashSet<String>>);

pub fn run() {
  tauri::Builder::default()
    // first: plugins init in order, and a second launch must hand over and exit
    // before anything opens a window
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      forward(app, argv.into_iter().skip(1).collect());
    }))
    .plugin(logger())
    .plugin(tauri_plugin_deep_link::init())
    .manage(Ending::default())
    .manage(windows::Cascade::default())
    .setup(|app| {
      #[cfg(debug_assertions)]
      app.add_capability(dev_server_capability()?)?;
      // the dock, and os shortcuts that go to the machine in fullscreen
      #[cfg(target_os = "macos")]
      mac::setup(app);
      // debug builds register the scheme for themselves so a dev run can be
      // opened from the website; installers own it in release. on windows this
      // points hkcu at the current exe. macos reads it from the bundle only
      #[cfg(all(debug_assertions, not(target_os = "macos")))]
      match app.deep_link().register_all() {
        Ok(()) => log::info!("registered owlette-swoop:// for this debug build"),
        Err(error) => log::warn!("could not register owlette-swoop://: {error}"),
      }
      // macos delivers owlette-swoop:// links here; windows and linux start a
      // process with the link as its argument, which the two launch paths cover
      let handle = app.handle().clone();
      app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
          forward(&handle, vec![url.to_string()]);
        }
      });
      let args: Vec<String> = std::env::args().skip(1).collect();
      if cfg!(target_os = "macos") && args.is_empty() {
        // a link that arrived before the listener above existed
        match app.deep_link().get_current()? {
          Some(urls) => {
            for url in urls {
              forward(app.handle(), vec![url.to_string()]);
            }
          }
          None => open_home_unless_linked(app.handle()),
        }
      } else {
        launch::handle(app.handle(), &args)?;
      }
      Ok(())
    })
    .on_window_event(on_window_event)
    .run(tauri::generate_context!())
    .expect("error while running owlette swoop");
}

fn logger<R: Runtime>() -> TauriPlugin<R> {
  let mut builder = tauri_plugin_log::Builder::new()
    .level(log::LevelFilter::Info)
    .max_file_size(LOG_MAX_FILE_SIZE)
    .rotation_strategy(RotationStrategy::KeepSome(LOG_FILES_KEPT))
    .timezone_strategy(TimezoneStrategy::UseLocal)
    .clear_targets()
    .target(Target::new(TargetKind::LogDir {
      file_name: Some(LOG_FILE_NAME.to_owned()),
    }));
  if cfg!(debug_assertions) {
    builder = builder.target(Target::new(TargetKind::Stdout));
  }
  builder.build()
}

// owlette-pages.json with the dev server as its only remote, so the two grants
// can never drift apart
#[cfg(debug_assertions)]
fn dev_server_capability() -> serde_json::Result<String> {
  let mut capability: Capability = serde_json::from_str(OWLETTE_PAGES_CAPABILITY)?;
  capability.identifier = "owlette-pages-dev-server".to_owned();
  capability.remote = Some(CapabilityRemote {
    urls: vec![DEV_SERVER_PAGES.to_owned()],
  });
  serde_json::to_string(&capability)
}

// off the calling thread: building a window inside an event handler deadlocks
// on windows
fn forward(app: &AppHandle, args: Vec<String>) {
  let app = app.clone();
  std::thread::spawn(move || {
    if let Err(error) = launch::handle(&app, &args) {
      log::error!("could not open a window: {error}");
    }
  });
}

// a cold start from a link to a session would otherwise open the picker beside
// the session
fn open_home_unless_linked(app: &AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(DEEP_LINK_GRACE);
    if matches!(app.deep_link().get_current(), Ok(Some(_))) {
      return;
    }
    if let Err(error) = launch::handle(&app, &[]) {
      log::error!("could not open a window: {error}");
    }
  });
}

fn on_window_event(window: &Window, event: &WindowEvent) {
  let ending = window.state::<Ending>();
  match event {
    WindowEvent::CloseRequested { api, .. } => {
      let first = ending
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(window.label().to_owned());
      if !first {
        return;
      }
      api.prevent_close();
      log::info!(
        "closing {}: its page ends the session first",
        window.label()
      );
      if let Some(webview) = window.get_webview_window(window.label()) {
        if let Err(error) = webview.eval(CLOSE_EVENT_SCRIPT) {
          log::warn!("could not tell {} it is closing: {error}", window.label());
        }
      }
      let window = window.clone();
      std::thread::spawn(move || {
        std::thread::sleep(CLOSE_GRACE);
        // a second click on close may already have taken the window
        if let Err(error) = window.close() {
          log::debug!("{} was already closed: {error}", window.label());
        }
      });
    }
    // a session reopened later under the same label gets the handshake again
    WindowEvent::Destroyed => {
      ending
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(window.label());
    }
    _ => {}
  }
}

#[cfg(test)]
mod tests {
  use tauri::utils::acl::capability::Capability;

  const OWLETTE_PAGES: &str = include_str!("../capabilities/owlette-pages.json");

  // the title bar's calls and nothing more: no fs, no shell, no dialog
  const TITLE_BAR_PERMISSIONS: [&str; 8] = [
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "core:window:allow-is-maximized",
    "core:event:allow-listen",
    "core:event:allow-unlisten",
  ];

  fn permissions(capability: &Capability) -> Vec<&str> {
    capability
      .permissions
      .iter()
      .map(|entry| entry.identifier().get())
      .collect()
  }

  #[test]
  fn owlette_pages_get_only_the_window_commands() {
    let capability: Capability = serde_json::from_str(OWLETTE_PAGES).expect("a capability");
    assert_eq!(permissions(&capability), TITLE_BAR_PERMISSIONS);
    assert_eq!(capability.windows, ["main", "swoop-*"]);
    assert!(!capability.local, "the placeholder page needs no title bar");
    assert_eq!(
      capability.remote.expect("remote urls").urls,
      ["https://owlette.app/*", "https://dev.owlette.app/*"]
    );
  }

  #[cfg(debug_assertions)]
  #[test]
  fn a_debug_build_grants_the_dev_server_the_same() {
    use tauri::utils::acl::capability::CapabilityFile;

    let json = super::dev_server_capability().expect("serialises");
    // parsed as `add_capability` parses it, which panics on one it cannot read
    let CapabilityFile::Capability(capability) = json.parse().expect("parses") else {
      panic!("one capability, not a list: {json}");
    };
    assert_eq!(capability.identifier, "owlette-pages-dev-server");
    assert_eq!(permissions(&capability), TITLE_BAR_PERMISSIONS);
    assert_eq!(capability.windows, ["main", "swoop-*"]);
    assert!(!capability.local);
    assert_eq!(
      capability.remote.expect("remote urls").urls,
      ["http://localhost:*/*"]
    );
  }
}
