//! webview2 asks before a page reads the clipboard ("wants to see text and
//! images copied to the clipboard"), a prompt a native app must not show. every
//! window answers that request itself: a clipboard read from an allowed origin
//! is granted, and anything else, another origin or another permission, keeps
//! webview2's default.

use ::windows::core::PWSTR;
use tauri::webview::PlatformWebview;
use tauri::{Url, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
  ICoreWebView2PermissionRequestedEventArgs, COREWEBVIEW2_PERMISSION_KIND,
  COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ, COREWEBVIEW2_PERMISSION_STATE,
  COREWEBVIEW2_PERMISSION_STATE_ALLOW,
};
use webview2_com::{take_pwstr, PermissionRequestedEventHandler};

use crate::origin;

// once per window, right after it is built
pub fn attach(window: &WebviewWindow) {
  let label = window.label().to_owned();
  let queued = window.with_webview(move |webview| {
    if let Err(error) = add_handler(&webview) {
      log::warn!("{label} will ask before reading the clipboard: {error}");
    }
  });
  if let Err(error) = queued {
    log::warn!("could not reach the webview of {}: {error}", window.label());
  }
}

fn add_handler(webview: &PlatformWebview) -> ::windows::core::Result<()> {
  let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| match args {
    Some(args) => on_permission_requested(&args),
    None => Ok(()),
  }));
  // the token only removes the handler, which lives as long as the webview
  let mut token = 0;
  // SAFETY: the controller belongs to the live webview, and `handler` and
  // `token` outlive the call
  unsafe {
    webview
      .controller()
      .CoreWebView2()?
      .add_PermissionRequested(&handler, &mut token)
  }
}

fn on_permission_requested(
  args: &ICoreWebView2PermissionRequestedEventArgs,
) -> ::windows::core::Result<()> {
  let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
  let mut uri = PWSTR::null();
  // SAFETY: webview2 hands over live args, and `take_pwstr` frees the uri
  // string it allocated
  let uri = unsafe {
    args.PermissionKind(&mut kind)?;
    args.Uri(&mut uri)?;
    take_pwstr(uri)
  };
  let Some(state) = decide(kind, &uri) else {
    if kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ {
      log::debug!("clipboard read on {} left to webview2", origin_of(&uri));
    }
    return Ok(());
  };
  log::debug!("clipboard read on {} allowed", origin_of(&uri));
  // SAFETY: as above
  unsafe { args.SetState(state) }
}

// the log gets the origin only, never a path or query
fn origin_of(uri: &str) -> String {
  Url::parse(uri).map_or_else(
    |_| "an unreadable origin".to_owned(),
    |url| url.origin().ascii_serialization(),
  )
}

fn decide(kind: COREWEBVIEW2_PERMISSION_KIND, uri: &str) -> Option<COREWEBVIEW2_PERMISSION_STATE> {
  (kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ && origin::allowed_origin(uri).is_some())
    .then_some(COREWEBVIEW2_PERMISSION_STATE_ALLOW)
}

#[cfg(test)]
mod tests {
  use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
  };

  use super::*;

  #[test]
  fn only_an_owlette_clipboard_read_is_allowed() {
    let read = COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ;
    let allow = Some(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
    let owlette = "https://owlette.app/swoop";
    for (kind, uri, decided) in [
      (read, "https://dev.owlette.app/swoop/site-1/B4A", allow),
      (read, owlette, allow),
      (read, "https://evil.example/swoop", None),
      (read, "https://owlette-dev.firebaseapp.com/__/auth", None),
      (read, "", None),
      (COREWEBVIEW2_PERMISSION_KIND_CAMERA, owlette, None),
      (COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, owlette, None),
      (COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION, owlette, None),
      (
        read,
        "http://localhost:3001/swoop",
        allow.filter(|_| cfg!(debug_assertions)),
      ),
    ] {
      assert_eq!(decide(kind, uri), decided, "{kind:?} on {uri:?}");
    }
  }
}
