//! capture on macos: while a session page is fullscreen the dock stays hidden
//! and cmd+tab cannot switch apps, and keys_macos.rs hands cmd+q, w, h and m
//! to the machine.
//!
//! webkit's element fullscreen, which the session's fullscreen button asks
//! for, moves the webview into a window of its own and leaves tauri's window
//! offscreen (measured 2026-10-09, macos 26.6): tauri sees no fullscreen at
//! all. so capture follows appkit's notifications for every window in the
//! app, and the green button's fullscreen of a tauri window counts the same.
//!
//! the options must be in place before the window enters fullscreen: appkit
//! carries them into the fullscreen space then, but options set once it is
//! there read back as set and do not stop cmd+tab (measured the same day on a
//! bare appkit window). appkit types as in `desktop/src-tauri/src/mac_window.rs`.

use std::cell::RefCell;
use std::panic::AssertUnwindSafe;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{MainThreadMarker, Message};
use objc2_app_kit::{
  NSApplication, NSApplicationPresentationOptions, NSView, NSWindow,
  NSWindowDidExitFullScreenNotification, NSWindowWillCloseNotification,
  NSWindowWillEnterFullScreenNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSNotificationName};
use objc2_web_kit::WKWebView;
use tauri::Url;

use crate::{origin, windows};

// no dock, no cmd+tab, no hide, the menu bar only when moused to; appkit adds
// `FullScreen` itself on the way in. macos refuses some combinations with an
// exception, which `set_options` catches
const CAPTURE_OPTIONS: NSApplicationPresentationOptions =
  NSApplicationPresentationOptions::HideDock
    .union(NSApplicationPresentationOptions::AutoHideMenuBar)
    .union(NSApplicationPresentationOptions::DisableProcessSwitching)
    .union(NSApplicationPresentationOptions::DisableHideApplication);

struct Capture {
  // each session window in fullscreen, with the webview it shows
  sessions: Vec<(Retained<NSWindow>, Retained<WKWebView>)>,
  // the app's options before the first, put back after the last
  restore: NSApplicationPresentationOptions,
}

thread_local! {
  // appkit calls back on the main thread only, so the state lives there
  static CAPTURE: RefCell<Capture> = const {
    RefCell::new(Capture {
      sessions: Vec::new(),
      restore: NSApplicationPresentationOptions(0),
    })
  };
}

type OnWindow = fn(MainThreadMarker, &NSWindow);

pub fn setup(app: &mut tauri::App) {
  // a dock icon and a place in cmd+tab, like any app a person opens
  app.set_activation_policy(tauri::ActivationPolicy::Regular);
  // SAFETY: appkit's own notification names, valid for the process
  let (entering, exited, closing) = unsafe {
    (
      NSWindowWillEnterFullScreenNotification,
      NSWindowDidExitFullScreenNotification,
      NSWindowWillCloseNotification,
    )
  };
  observe(entering, capture);
  observe(exited, release);
  observe(closing, release);
  crate::keys_macos::monitor();
}

// the webview of the captured session in the key window, if any
pub fn captured_webview() -> Option<Retained<WKWebView>> {
  CAPTURE.with_borrow(|capture| {
    capture
      .sessions
      .iter()
      .find(|(window, _)| window.isKeyWindow())
      .map(|(_, webview)| webview.clone())
  })
}

// the picker or a sign-in page in fullscreen keeps the app's own shortcuts
fn capture(mtm: MainThreadMarker, window: &NSWindow) {
  let Some((webview, page)) = webview_in(window) else {
    return;
  };
  if !windows::is_session_page(&page) {
    return;
  }
  CAPTURE.with_borrow_mut(|capture| {
    if capture
      .sessions
      .iter()
      .any(|(held, _)| std::ptr::eq(&**held, window))
    {
      return;
    }
    if capture.sessions.is_empty() {
      let restore = NSApplication::sharedApplication(mtm).presentationOptions();
      if !set_options(mtm, CAPTURE_OPTIONS) {
        return;
      }
      capture.restore = restore;
    }
    capture.sessions.push((window.retain(), webview));
    log::info!(
      "capturing keys in fullscreen on {}",
      origin::redacted(&page)
    );
  });
}

fn release(mtm: MainThreadMarker, window: &NSWindow) {
  let restore = CAPTURE.with_borrow_mut(|capture| {
    let before = capture.sessions.len();
    capture
      .sessions
      .retain(|(held, _)| !std::ptr::eq(&**held, window));
    (capture.sessions.len() < before && capture.sessions.is_empty()).then_some(capture.restore)
  });
  if let Some(restore) = restore {
    set_options(mtm, restore);
    log::info!("released keys");
  }
}

fn observe(name: &NSNotificationName, on_window: OnWindow) {
  let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
    // window notifications are posted on the main thread; anything else is
    // not ours to touch
    let Some(mtm) = MainThreadMarker::new() else {
      return;
    };
    // SAFETY: the center hands the block a live notification for the call
    let notification = unsafe { notification.as_ref() };
    if let Some(window) = notification
      .object()
      .and_then(|object| object.downcast::<NSWindow>().ok())
    {
      on_window(mtm, &window);
    }
  });
  // SAFETY: no object filter and no queue, so the block runs on the posting
  // thread, which it checks before touching anything
  let observer = unsafe {
    NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
      Some(name),
      None,
      None,
      &block,
    )
  };
  // observes for the app's whole life
  std::mem::forget(observer);
}

// the webview a window shows and the page it is on; webkit's fullscreen
// window holds the webview it took somewhere below its content view
fn webview_in(window: &NSWindow) -> Option<(Retained<WKWebView>, Url)> {
  let content = window.contentView()?;
  let webview = find_webview(&content)?;
  // SAFETY: a plain property read on the main thread
  let page = unsafe { webview.URL() }?.absoluteString()?.to_string();
  Some((webview, Url::parse(&page).ok()?))
}

fn find_webview(view: &NSView) -> Option<Retained<WKWebView>> {
  if let Some(webview) = view.downcast_ref::<WKWebView>() {
    return Some(webview.retain());
  }
  view
    .subviews()
    .iter()
    .find_map(|child| find_webview(&child))
}

// false when macos refused the options, which leaves them as they were
fn set_options(mtm: MainThreadMarker, options: NSApplicationPresentationOptions) -> bool {
  let app = NSApplication::sharedApplication(mtm);
  match objc2::exception::catch(AssertUnwindSafe(|| app.setPresentationOptions(options))) {
    Ok(()) => true,
    Err(exception) => {
      log::warn!("macos refused presentation options {options:?}: {exception:?}");
      false
    }
  }
}

#[cfg(test)]
mod tests {
  use tauri::Url;

  use crate::windows::is_session_page;

  fn url(value: &str) -> Url {
    Url::parse(value).expect("test url")
  }

  #[test]
  fn a_session_page_is_captured_in_fullscreen() {
    for page in [
      "https://owlette.app/swoop/site-1/b4a.local",
      "https://dev.owlette.app/swoop/site-1/B4A?x=1#y",
    ] {
      assert!(is_session_page(&url(page)), "{page}");
    }
  }

  #[test]
  fn other_pages_keep_the_apps_shortcuts_in_fullscreen() {
    for page in [
      "https://owlette.app/swoop",
      "https://owlette.app/swoop/site-1",
      "https://owlette.app/swoop/site-1/B4A/extra",
      "https://owlette.app/login?next=/swoop/site-1/B4A",
      "https://owlette.app/app-link?code=x&next=%2Fswoop%2Fa%2Fb",
      "https://owlette-dev.firebaseapp.com/swoop/site-1/B4A",
      "https://evil.com/swoop/site-1/B4A",
    ] {
      assert!(!is_session_page(&url(page)), "{page}");
    }
  }
}
