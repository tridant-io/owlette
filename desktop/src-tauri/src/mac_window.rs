//! The macOS 26 window shape.
//!
//! macOS 26 draws its large corner radius only on a window that carries a
//! toolbar. Measured on 2026-10-03 (macOS 26.6, three bare windows built on the
//! 26 SDK): a plain title bar and the transparent full-size one Tauri's overlay
//! style makes both kept the old ~10 pt radius; the window with an `NSToolbar`
//! had the new one, in both the unified and the compact style. Linking against
//! the 26 SDK alone changed nothing, which is why 4.1.0 shipped square-ish.
//!
//! The radius follows the toolbar style: 18.5 pt for the compact bar, 25.5 pt
//! for the unified one, which is what WhatsApp and the system's own apps show
//! on 26 (measured the same day). The app draws its own header, so the toolbar
//! is empty and without a separator, and the header is made the unified bar's
//! height (52 pt) so the whole title area stays the drag surface: the shape,
//! and nothing else.
//!
//! No `trafficLightPosition` goes with it. Tauri (tao) applies that by
//! resizing the title-bar container view on every draw, and with a toolbar
//! in that container the two fought over it: the second show of the window
//! after a hide crashed in `-[NSThemeFrame _toolbarViewFrame]` on a freed
//! view (2026-10-03). The unified bar puts the lights where the header wants
//! them anyway.

use std::sync::atomic::{AtomicBool, Ordering};

use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSTitlebarSeparatorStyle, NSToolbar, NSWindow, NSWindowToolbarStyle};
use objc2_foundation::NSString;

/// Set once the toolbar is on the window. The main window is built once and
/// only ever hidden, never closed, so once is the whole lifetime. The window's
/// own `toolbar` getter is deliberately not read back: on macOS 26 the second
/// show read it, dropped the reference, and that drop freed the window's
/// toolbar (`-[NSToolbar dealloc]` stopped inside it under lldb), and the
/// next `makeKeyAndOrderFront` crashed on the freed view (2026-10-03).
static ATTACHED: AtomicBool = AtomicBool::new(false);

/// Attach the empty toolbar to the main window. Called when the window is
/// shown, hopped onto the main thread by the caller; every call after the
/// first returns at once.
/// (Setup is too early: the window from the config is not built yet there,
/// which is how 4.1.0's first attempt attached nothing.)
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
  if ATTACHED.swap(true, Ordering::Relaxed) {
    return;
  }
  let identifier = NSString::from_str("app.owlette.desktop.shape");
  let toolbar = NSToolbar::initWithIdentifier(NSToolbar::alloc(mtm), &identifier);
  ns_window.setToolbar(Some(&toolbar));
  ns_window.setToolbarStyle(NSWindowToolbarStyle::Unified);
  ns_window.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);
}
