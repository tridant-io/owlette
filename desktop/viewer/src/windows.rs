//! the main window holds the picker, any other page asked for and, unless it is
//! busy with one already, a session too. a session asked for in a new window,
//! or while main is busy, gets a swoop window of its own, found again by its
//! label.

#[cfg(not(windows))]
use std::process::{Command, Stdio};
use std::sync::{Mutex, PoisonError};

#[cfg(windows)]
use ::windows::core::{w, HSTRING, PCWSTR};
#[cfg(windows)]
use ::windows::Win32::UI::Shell::ShellExecuteW;
#[cfg(windows)]
use ::windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use tauri::webview::NewWindowResponse;
use tauri::{
  AppHandle, LogicalPosition, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::origin;

// capabilities/*.json name these labels
const MAIN_LABEL: &str = "main";
const SWOOP_LABEL_PREFIX: &str = "swoop-";

const SESSION_PATH_PREFIX: &str = "/swoop/";
// web/app/app-link signs the app in, then replaces itself with `next`
const APP_LINK_PATH: &str = "/app-link";
const APP_LINK_NEXT: &str = "next";

const TITLE: &str = "owlette swoop";
const MAIN_SIZE: (f64, f64) = (1060.0, 680.0);
const SWOOP_SIZE: (f64, f64) = (1280.0, 800.0);
const MIN_SIZE: (f64, f64) = (780.0, 540.0);

// each new swoop window steps right and down from the newest one still open,
// so two sessions never stack exactly; after the last step it starts over
const CASCADE_OFFSET: f64 = 32.0;
const CASCADE_STEPS: usize = 8;

// `ShellExecuteW` returns an HINSTANCE; anything above 32 means it launched
#[cfg(windows)]
const SHELL_EXECUTE_SUCCESS_FLOOR: isize = 32;

// sign-in leaves owlette.app for these; wave 2 measures which are really needed
const FIREBASE_AUTH_SUFFIX: &str = ".firebaseapp.com";
const GOOGLE_ACCOUNTS_HOST: &str = "accounts.google.com";

// how owlette.app knows it is inside the app (web/lib/swoop/viewerApp.ts): a
// user agent survives navigation and needs no ipc
const USER_AGENT_TOKEN: &str = concat!("owlette-swoop-viewer/", env!("CARGO_PKG_VERSION"));
// and ` (keys)` where the app hands os shortcuts to the page itself
// (keys_macos.rs)
#[cfg(target_os = "macos")]
const NATIVE_KEYS_TOKEN: &str = " (keys)";
#[cfg(not(target_os = "macos"))]
const NATIVE_KEYS_TOKEN: &str = "";

const WEB_SCHEMES: [&str; 2] = ["https://", "http://"];

// swoop windows in the order they opened, each with its cascade step
#[derive(Default)]
pub struct Cascade(Mutex<Vec<(String, usize)>>);

// where a page asked for by argv, a deep link or a second launch opens
#[derive(Debug, PartialEq, Eq)]
enum Route {
  BuildMain,
  NavigateMain,
  // main is on that very session already: raised, never reloaded
  RaiseMain,
  SessionWindow { label: String, page: String },
}

pub fn open(app: &AppHandle, url: Url) -> tauri::Result<()> {
  log::info!("opening {}", origin::redacted(&url));
  let main = app.get_webview_window(MAIN_LABEL);
  let main_page = main.as_ref().map(|window| window.url()).transpose()?;
  let route = route(&url, main_page.as_ref(), |label| {
    app.get_webview_window(label).is_some()
  });
  match (route, main) {
    (Route::SessionWindow { label, page }, _) => open_session(app, &label, &page, url),
    (Route::RaiseMain, Some(main)) => raise(&main),
    (Route::NavigateMain, Some(main)) => {
      log::info!("navigating main to {}", origin::redacted(&url));
      main.navigate(url)?;
      raise(&main)
    }
    // `route` names main only while it is open
    _ => build(app, MAIN_LABEL, url, MAIN_SIZE, None).map(drop),
  }
}

// a session takes the main window unless main is busy with another one, which
// must not be cut off silently: then it gets a swoop window, as it does when
// its own swoop window is already open. any other page goes to main as it is
fn route(requested: &Url, main_page: Option<&Url>, has_window: impl Fn(&str) -> bool) -> Route {
  let Some((label, page)) = session_of(requested) else {
    return match main_page {
      Some(_) => Route::NavigateMain,
      None => Route::BuildMain,
    };
  };
  if has_window(&label) {
    return Route::SessionWindow { label, page };
  }
  match main_page.map(session_of) {
    None => Route::BuildMain,
    Some(None) => Route::NavigateMain,
    Some(Some((busy, _))) if busy == label => Route::RaiseMain,
    Some(Some(_)) => Route::SessionWindow { label, page },
  }
}

// a second launch with no argument raises the main window as it is, so it
// never navigates away from a half-finished sign-in
pub fn open_home(app: &AppHandle, url: Url) -> tauri::Result<()> {
  log::info!("opening {} (home)", origin::redacted(&url));
  match app.get_webview_window(MAIN_LABEL) {
    Some(window) => raise(&window),
    None => build(app, MAIN_LABEL, url, MAIN_SIZE, None).map(drop),
  }
}

fn open_session(app: &AppHandle, label: &str, page: &str, url: Url) -> tauri::Result<()> {
  let Some(window) = app.get_webview_window(label) else {
    let (step, position) = next_in_cascade(app);
    build(app, label, url, SWOOP_SIZE, position)?;
    log::info!("new swoop window {label}");
    app
      .state::<Cascade>()
      .0
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
      .push((label.to_owned(), step));
    return Ok(());
  };
  // a swoop window that has wandered off its session goes back to it; one
  // still on it is only raised, so a live session is never reloaded
  if window.url()?.path() != page {
    window.navigate(url)?;
  }
  raise(&window)
}

// the step after the newest swoop window still open, and where it goes; `None`
// is centred, which is also the answer when that window's frame is unusable
fn next_in_cascade(app: &AppHandle) -> (usize, Option<LogicalPosition<f64>>) {
  let cascade = app.state::<Cascade>();
  let newest = {
    let mut opened = cascade.0.lock().unwrap_or_else(PoisonError::into_inner);
    opened.retain(|(label, _)| app.get_webview_window(label).is_some());
    opened.last().cloned()
  };
  let Some((label, step)) = newest else {
    return (0, None);
  };
  let step = (step + 1) % CASCADE_STEPS;
  if step == 0 {
    return (0, None);
  }
  match app
    .get_webview_window(&label)
    .and_then(|window| stepped_from(&window))
  {
    Some(position) => (step, Some(position)),
    None => (0, None),
  }
}

// a minimised window on windows sits at -32000, which is no place to step from
fn stepped_from(window: &WebviewWindow) -> Option<LogicalPosition<f64>> {
  if window.is_minimized().unwrap_or(true) {
    return None;
  }
  let scale = window.scale_factor().ok()?;
  let at = window.outer_position().ok()?.to_logical::<f64>(scale);
  Some(LogicalPosition::new(
    at.x + CASCADE_OFFSET,
    at.y + CASCADE_OFFSET,
  ))
}

// a session's window label and the session page it settles on. an app-link
// belongs to the session in its `next` (percent-decoded), and the strict
// grammar below refuses any `next` that is not a relative session path: an
// absolute url, `//host`, a scheme, a backslash or a second `?`
fn session_of(url: &Url) -> Option<(String, String)> {
  let page = if url.path() == APP_LINK_PATH {
    url
      .query_pairs()
      .find(|(key, _)| key == APP_LINK_NEXT)?
      .1
      .into_owned()
  } else {
    url.path().to_owned()
  };
  Some((label_for(&page)?, page))
}

// `swoop-<site>/<machine>`: `/` separates the two because both ids may contain
// `-`, and a machine id's `.` becomes `:` because tauri refuses a label with a dot
fn label_for(page: &str) -> Option<String> {
  let (site, machine) = page.strip_prefix(SESSION_PATH_PREFIX)?.split_once('/')?;
  let site_ok = !site.is_empty()
    && site
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
  let machine_ok = !machine.is_empty()
    && machine
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
  (site_ok && machine_ok)
    .then(|| format!("{SWOOP_LABEL_PREFIX}{site}/{}", machine.replace('.', ":")))
}

// a session page on an allowed origin, whichever window holds it: where a
// captured os shortcut goes to the machine (mac.rs)
#[cfg(target_os = "macos")]
pub fn is_session_page(url: &Url) -> bool {
  origin::allowed_origin(url.as_str()).is_some() && label_for(url.path()).is_some()
}

fn build(
  app: &AppHandle,
  label: &str,
  url: Url,
  (width, height): (f64, f64),
  position: Option<LogicalPosition<f64>>,
) -> tauri::Result<WebviewWindow> {
  let opener = app.clone();
  let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
    .title(TITLE)
    .inner_size(width, height)
    .min_inner_size(MIN_SIZE.0, MIN_SIZE.1);
  let builder = match position {
    Some(at) => builder.position(at.x, at.y),
    None => builder.center(),
  };
  // no native frame: the page's top bar is the title bar and draws its own
  // controls (web/components/swoop/SwoopWindowControls.tsx). macos keeps its
  // traffic lights, floating over the page, as the desktop app does
  #[cfg(not(target_os = "macos"))]
  let builder = builder.decorations(false);
  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);
  let builder = builder
    .user_agent(&user_agent())
    .on_navigation(navigation_allowed)
    .on_new_window(move |url, _features| {
      new_window_requested(&opener, url);
      NewWindowResponse::Deny
    });
  #[cfg(all(debug_assertions, windows))]
  let builder = builder.additional_browser_args(DEBUG_BROWSER_ARGS);
  let window = builder.build()?;
  // the clipboard without webview2's prompt (permissions_windows.rs)
  #[cfg(windows)]
  crate::permissions_windows::attach(&window);
  Ok(window)
}

// debug builds only, so the spike script can drive the real webview over cdp.
// these args replace wry's, so its defaults (no mini menu, no smartscreen,
// autoplay) are restated
#[cfg(all(debug_assertions, windows))]
const DEBUG_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --remote-debugging-port=9222";

fn raise(window: &WebviewWindow) -> tauri::Result<()> {
  window.unminimize()?;
  window.show()?;
  window.set_focus()
}

fn navigation_allowed(url: &Url) -> bool {
  if origin::allowed_origin(url.as_str()).is_some() {
    return true;
  }
  url.scheme() == "https"
    && url.port().is_none()
    && url
      .host_str()
      .is_some_and(|host| host == GOOGLE_ACCOUNTS_HOST || host.ends_with(FIREBASE_AUTH_SUFFIX))
}

// the webview opens no window of its own: one it made would skip the
// navigation guard and the user agent token. a session asked for this way is
// the explicit "open in a new window", so it always gets its swoop window
fn new_window_requested(app: &AppHandle, url: Url) {
  let session = session_of(&url).filter(|_| origin::allowed_origin(url.as_str()).is_some());
  let Some((label, page)) = session else {
    if let Err(error) = open_in_browser(url.as_str()) {
      log::warn!("{error}");
    }
    return;
  };
  let app = app.clone();
  // building a window inside a webview2 event handler deadlocks
  std::thread::spawn(move || {
    log::info!("opening {} (new window)", origin::redacted(&url));
    if let Err(error) = open_session(&app, &label, &page, url) {
      log::error!("could not open a swoop window: {error}");
    }
  });
}

// the desktop app's guard (`shell_open::open_url`): only http(s), or the
// opener runs whatever protocol handler is registered
fn open_in_browser(url: &str) -> Result<(), String> {
  let trimmed = url.trim();
  let lowered = trimmed.to_ascii_lowercase();
  if !WEB_SCHEMES.iter().any(|scheme| lowered.starts_with(scheme)) {
    return Err("refusing to open a non-web link".to_string());
  }
  // a control character could break out of the argument the opener parses
  if trimmed.chars().any(char::is_control) {
    return Err("refusing to open a link containing control characters".to_string());
  }
  launch_browser(trimmed)
}

// the desktop app's `shell_open::open_link`: explorer.exe opens file explorer,
// not the browser, for any url with a `?` (measured at gate g0)
#[cfg(windows)]
fn launch_browser(url: &str) -> Result<(), String> {
  let file = HSTRING::from(url);
  // SAFETY: `file` outlives the call, and the other pointers are either null or
  // static wide strings
  let result = unsafe {
    ShellExecuteW(
      None,
      w!("open"),
      PCWSTR(file.as_ptr()),
      PCWSTR::null(),
      PCWSTR::null(),
      SW_SHOWNORMAL,
    )
  };
  let code = result.0 as isize;
  if code > SHELL_EXECUTE_SUCCESS_FLOOR {
    Ok(())
  } else {
    Err(format!("windows could not open a link ({code})"))
  }
}

#[cfg(not(windows))]
fn launch_browser(url: &str) -> Result<(), String> {
  let opener = if cfg!(target_os = "macos") {
    "open"
  } else {
    "xdg-open"
  };
  Command::new(opener)
    .arg(url)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map(drop)
    .map_err(|error| format!("{opener} could not open a link: {error}"))
}

// wry can only replace the user agent, so this rebuilds each engine's default
// and appends the token
fn user_agent() -> String {
  format!(
    "{} {USER_AGENT_TOKEN}{NATIVE_KEYS_TOKEN}",
    engine_user_agent()
  )
}

#[cfg(windows)]
fn engine_user_agent() -> String {
  // webview2 sends chromium's reduced form: the major version, then zeros
  match tauri::webview_version().ok().as_deref().and_then(|version| version.split('.').next()) {
    Some(major) => format!(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0"
    ),
    None => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36".to_owned(),
  }
}

#[cfg(target_os = "macos")]
fn engine_user_agent() -> String {
  // wkwebview's default, frozen by apple
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
    .to_owned()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn engine_user_agent() -> String {
  format!(
    "Mozilla/5.0 (X11; Linux {}) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15",
    std::env::consts::ARCH
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn url(value: &str) -> Url {
    Url::parse(value).expect("test url")
  }

  fn session_label(url: &Url) -> Option<String> {
    session_of(url).map(|(label, _)| label)
  }

  fn route_with(requested: &str, main_page: Option<&str>, open: &[&str]) -> Route {
    let main_page = main_page.map(url);
    route(&url(requested), main_page.as_ref(), |label| {
      open.contains(&label)
    })
  }

  fn session_window(label: &str, page: &str) -> Route {
    Route::SessionWindow {
      label: label.to_owned(),
      page: page.to_owned(),
    }
  }

  const SESSION: &str = "http://localhost:3001/swoop/test-site/test.machine";
  const PICKER: &str = "http://localhost:3001/swoop";

  #[test]
  fn with_no_main_window_a_session_builds_it() {
    assert_eq!(route_with(SESSION, None, &[]), Route::BuildMain);
  }

  #[test]
  fn a_main_window_off_any_session_takes_it() {
    for main_page in [
      PICKER,
      "http://localhost:3001/login?next=/swoop/test-site/test.machine",
      "https://owlette-dev.firebaseapp.com/__/auth/handler",
      "http://localhost:3001/swoop/test-site",
    ] {
      assert_eq!(
        route_with(SESSION, Some(main_page), &[]),
        Route::NavigateMain,
        "{main_page}"
      );
    }
    assert_eq!(
      route_with(
        "https://owlette.app/app-link?code=x&next=%2Fswoop%2Fa%2Fb",
        Some("https://owlette.app/swoop"),
        &[]
      ),
      Route::NavigateMain
    );
  }

  #[test]
  fn a_main_window_on_a_session_is_not_cut_off() {
    for main_page in [
      SESSION,
      "http://localhost:3001/app-link?code=x&next=%2Fswoop%2Ftest-site%2Ftest.machine",
    ] {
      assert_eq!(
        route_with(
          "http://localhost:3001/swoop/another-site/another.machine",
          Some(main_page),
          &[]
        ),
        session_window(
          "swoop-another-site/another:machine",
          "/swoop/another-site/another.machine"
        ),
        "{main_page}"
      );
      assert_eq!(
        route_with(SESSION, Some(main_page), &[]),
        Route::RaiseMain,
        "{main_page}"
      );
    }
  }

  #[test]
  fn a_session_whose_window_is_open_goes_back_to_it() {
    let open = ["swoop-test-site/test:machine"];
    for main_page in [None, Some(PICKER), Some(SESSION)] {
      assert_eq!(
        route_with(SESSION, main_page, &open),
        session_window(
          "swoop-test-site/test:machine",
          "/swoop/test-site/test.machine"
        ),
        "{main_page:?}"
      );
    }
  }

  #[test]
  fn any_other_page_goes_to_main_as_it_is() {
    for requested in [PICKER, "http://localhost:3001/login"] {
      assert_eq!(route_with(requested, None, &[]), Route::BuildMain);
      for main_page in [PICKER, SESSION] {
        assert_eq!(
          route_with(requested, Some(main_page), &[]),
          Route::NavigateMain,
          "{requested} over {main_page}"
        );
      }
    }
  }

  #[test]
  fn a_session_gets_a_window_of_its_own() {
    for (page, label) in [
      ("https://owlette.app/swoop/site-1/B4A", "swoop-site-1/B4A"),
      (
        "https://owlette.app/swoop/site_1/kiosk-01?x=1#y",
        "swoop-site_1/kiosk-01",
      ),
      (
        "https://dev.owlette.app/swoop/s/b4a.local",
        "swoop-s/b4a:local",
      ),
    ] {
      assert_eq!(session_label(&url(page)).as_deref(), Some(label), "{page}");
    }
  }

  #[test]
  fn ids_that_share_a_dash_do_not_share_a_window() {
    assert_ne!(
      session_label(&url("https://owlette.app/swoop/a-b/c")),
      session_label(&url("https://owlette.app/swoop/a/b-c"))
    );
  }

  #[test]
  fn every_label_is_one_tauri_accepts() {
    let label =
      session_label(&url("https://owlette.app/swoop/A-z_9/m.a-c_h.1")).expect("a session");
    assert!(label
      .chars()
      .all(|c| c.is_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')));
  }

  #[test]
  fn other_pages_go_to_the_main_window() {
    for page in [
      "https://owlette.app/",
      "https://owlette.app/swoop",
      "https://owlette.app/swoop/",
      "https://owlette.app/swoop/site-1",
      "https://owlette.app/swoop/site-1/",
      "https://owlette.app/swoop/site-1/B4A/extra",
      "https://owlette.app/swoop/site.1/B4A",
      "https://owlette.app/swoop/site%201/B4A",
      "https://owlette.app/swooper/site-1/B4A",
      "https://owlette.app/login",
    ] {
      assert_eq!(session_label(&url(page)), None, "{page}");
    }
  }

  #[test]
  fn an_app_link_opens_in_its_sessions_window() {
    for (page, label, settles_on) in [
      (
        "https://owlette.app/app-link?code=x&next=%2Fswoop%2Fa%2Fb.c",
        "swoop-a/b:c",
        "/swoop/a/b.c",
      ),
      (
        "https://dev.owlette.app/app-link?next=/swoop/site-1/B4A&code=x",
        "swoop-site-1/B4A",
        "/swoop/site-1/B4A",
      ),
    ] {
      assert_eq!(
        session_of(&url(page)),
        Some((label.to_owned(), settles_on.to_owned())),
        "{page}"
      );
    }
    assert_eq!(
      session_label(&url("https://owlette.app/swoop/a/b")).as_deref(),
      Some("swoop-a/b")
    );
  }

  #[test]
  fn an_app_link_without_a_session_goes_to_the_main_window() {
    for page in [
      "https://owlette.app/app-link?code=x",
      "https://owlette.app/app-link?code=x&next=",
      "https://owlette.app/app-link?code=x&next=https://evil.example/swoop/a/b",
      "https://owlette.app/app-link?code=x&next=https%3A%2F%2Fevil.example%2Fswoop%2Fa%2Fb",
      "https://owlette.app/app-link?code=x&next=//evil/swoop/a/b",
      "https://owlette.app/app-link?code=x&next=%2F%2Fevil%2Fswoop%2Fa%2Fb",
      "https://owlette.app/app-link?code=x&next=javascript:/swoop/a/b",
      "https://owlette.app/app-link?code=x&next=/swoop/a",
      "https://owlette.app/app-link?code=x&next=/swoop/a/b/c",
      "https://owlette.app/app-link?code=x&next=%2Fswoop%2Fa%5Cb%2Fc",
      "https://owlette.app/app-link?code=x&next=%2Fswoop%2Fa%2Fb%3Fx%3D1",
      "https://owlette.app/app-link?code=x&next=%2Fswoop%2Fa%2Fb%23x",
      "https://owlette.app/app-link?code=x&next=%252Fswoop%252Fa%252Fb",
      "https://owlette.app/app-link/?code=x&next=/swoop/a/b",
      "https://owlette.app/login?next=/swoop/a/b",
    ] {
      assert_eq!(session_label(&url(page)), None, "{page}");
    }
  }

  #[test]
  fn navigation_stays_on_owlette_and_sign_in() {
    for allowed in [
      "https://owlette.app/dashboard",
      "https://dev.owlette.app/login",
      "https://owlette-dev.firebaseapp.com/__/auth/handler",
      "https://accounts.google.com/o/oauth2/auth",
    ] {
      assert!(navigation_allowed(&url(allowed)), "{allowed}");
    }
    for refused in [
      "https://evil.com/",
      "http://accounts.google.com/",
      "https://firebaseapp.com/",
      "https://firebaseapp.com.evil.com/",
      "https://evil.com/?next=.firebaseapp.com",
      "https://x.firebaseapp.com:8443/",
      "owlette-swoop://owlette.app/swoop",
      "about:blank",
    ] {
      assert!(!navigation_allowed(&url(refused)), "{refused}");
    }
  }

  #[test]
  fn only_web_links_reach_the_browser() {
    for refused in [
      "file:///C:/Windows/System32/cmd.exe",
      "ms-settings:",
      "javascript:alert(1)",
      "about:blank",
      "",
      "   ",
    ] {
      let error = open_in_browser(refused).expect_err("should refuse");
      assert!(error.contains("non-web link"), "{refused}: {error}");
    }
    let error = open_in_browser("https://owlette.app/docs\r\nnotepad").expect_err("should refuse");
    assert!(error.contains("control characters"), "{error}");
  }

  #[test]
  fn the_user_agent_carries_the_app_token() {
    let agent = user_agent();
    assert!(agent.starts_with("Mozilla/5.0 ("), "{agent}");
    assert!(
      agent.ends_with(&format!(
        " owlette-swoop-viewer/{}{NATIVE_KEYS_TOKEN}",
        env!("CARGO_PKG_VERSION")
      )),
      "{agent}"
    );
    #[cfg(target_os = "macos")]
    assert!(agent.ends_with(" (keys)"), "{agent}");
  }
}
