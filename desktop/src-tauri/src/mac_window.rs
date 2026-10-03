//! The macOS 26 window shape.
//!
//! macOS 26 draws its large corner radius only on a window that carries a
//! toolbar. Measured on 2026-10-03 (macOS 26.6, three bare windows built on the
//! 26 SDK): a plain title bar and the transparent full-size one Tauri's overlay
//! style makes both kept the old ~10 pt radius; the window with an `NSToolbar`
//! had the new one, in both the unified and the compact style. Linking against
//! the 26 SDK alone changed nothing, which is why 4.1.0 shipped square-ish.
//!
//! The app draws its own header, so the toolbar is empty, compact (its bar is
//! the header's height) and without a separator: the shape, and nothing else.

use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSTitlebarSeparatorStyle, NSToolbar, NSWindow, NSWindowToolbarStyle};
use objc2_foundation::NSString;

/// Attach the empty toolbar to the main window. Called once, in setup, on the
/// main thread, where the window from the config already exists.
pub fn adopt_system_shape(window: &tauri::WebviewWindow) {
  let Some(mtm) = MainThreadMarker::new() else {
    log::warn!("not on the main thread; the window keeps the old corners");
    return;
  };
  let Ok(ptr) = window.ns_window() else {
    log::warn!("no NSWindow behind the main window; the window keeps the old corners");
    return;
  };
  // SAFETY: tauri hands back the live NSWindow of this webview window, and
  // setup runs on the main thread, the only one AppKit windows may be touched
  // from. The pointer is read, never freed.
  let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
  let identifier = NSString::from_str("app.owlette.desktop.shape");
  let toolbar = NSToolbar::initWithIdentifier(NSToolbar::alloc(mtm), &identifier);
  ns_window.setToolbar(Some(&toolbar));
  ns_window.setToolbarStyle(NSWindowToolbarStyle::UnifiedCompact);
  ns_window.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);
}
