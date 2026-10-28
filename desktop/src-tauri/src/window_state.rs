//! Layout memory: window size, process-list width and appearance.
//!
//! Shell geometry, not user state, so it is device-local: a per-user JSON at
//! `%APPDATA%\app.owlette.desktop\layout.json`. Per-*user* rather than the
//! ProgramData root so two operators sharing a kiosk don't inherit each other's
//! window size — the same reason it isn't in `config.json`, which the service
//! owns and uploads.
//!
//! * Size and maximised, never position: a remembered position is how an app ends
//!   up opening on a monitor that has since been unplugged.
//! * Logical pixels, so the file survives a move to a differently-scaled display.
//! * A namespaced document (`{"window": {...}, "sidebar": {...}}`); every write
//!   preserves sections it does not own, so a later key needs no migration.
//! * The appearance is the window theme: the webview's `prefers-color-scheme`
//!   follows it and the frontend's theme class follows that, so it is set here,
//!   before the window shows, and nowhere in the webview.
//!
//! Nothing here is load-bearing: an unreadable file falls back to `tauri.conf.json`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalSize, Theme, WebviewWindow, Window};

/// File name inside the per-user app-data directory.
pub const LAYOUT_FILE: &str = "layout.json";

const KEY_WINDOW: &str = "window";
const KEY_SIDEBAR: &str = "sidebar";
const KEY_WIDTH: &str = "width";
const KEY_COLLAPSED: &str = "collapsed";
const KEY_DETAIL: &str = "detail";
const KEY_APPEARANCE: &str = "appearance";
const KEY_THEME: &str = "theme";

/// the operator's appearance: follow the os, or pin dark or light.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
  System,
  Dark,
  Light,
}

/// the appearance before anything is stored. an os that gives no answer lands on
/// dark (see [`current_theme`]).
pub const DEFAULT_THEME: ThemeChoice = ThemeChoice::System;

impl ThemeChoice {
  /// the window theme to pin, or `None` to follow the os.
  fn window_theme(self) -> Option<Theme> {
    match self {
      Self::System => None,
      Self::Dark => Some(Theme::Dark),
      Self::Light => Some(Theme::Light),
    }
  }
}

/// the native frame behind the webview, which shows before its first frame and in
/// the edge a resize uncovers: the srgb `--background` of `src/globals.css`. the dark
/// one is also `backgroundColor` in `tauri.conf.json`, the frame before setup runs.
const DARK_BACKGROUND: Color = Color(0x02, 0x0b, 0x16, 0xff);
const LIGHT_BACKGROUND: Color = Color(0xf4, 0xf7, 0xfb, 0xff);

/// The window minimums declared in `tauri.conf.json`. Applied here because the
/// window manager would correct anything smaller on first paint; a test asserts
/// these constants still match the config they mirror.
pub const MIN_WINDOW_WIDTH: f64 = 780.0;
pub const MIN_WINDOW_HEIGHT: f64 = 540.0;

/// Above this a stored dimension is corruption rather than a preference — the
/// titlebar would be out of reach. Such a file is discarded, not clamped.
const MAX_WINDOW_DIMENSION: f64 = 32_000.0;

/// Sidebar bounds. `src/lib/sidebarWidth.ts` applies the same numbers while
/// dragging, but this side is the authority — the frontend cannot bypass the clamp.
pub const MIN_SIDEBAR_WIDTH: f64 = 200.0;
pub const MAX_SIDEBAR_WIDTH: f64 = 400.0;
/// `w-72`: the width before the sidebar became resizable, and the no-file default.
pub const DEFAULT_SIDEBAR_WIDTH: f64 = 288.0;

/// The window half of the document, in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowLayout {
  pub width: f64,
  pub height: f64,
  /// Maximised when last put away. `width`/`height` stay the *un*-maximised size so
  /// restoring down lands where the operator left it.
  #[serde(default)]
  pub maximized: bool,
}

impl WindowLayout {
  pub fn new(width: f64, height: f64, maximized: bool) -> Self {
    Self {
      width,
      height,
      maximized,
    }
  }

  /// Clamp to the configured minimums, or reject the record outright when the
  /// numbers cannot describe a window at all.
  fn sanitised(self) -> Option<Self> {
    if !self.width.is_finite() || !self.height.is_finite() {
      return None;
    }
    if self.width <= 0.0 || self.height <= 0.0 {
      return None;
    }
    if self.width > MAX_WINDOW_DIMENSION || self.height > MAX_WINDOW_DIMENSION {
      return None;
    }
    Some(Self {
      width: self.width.max(MIN_WINDOW_WIDTH),
      height: self.height.max(MIN_WINDOW_HEIGHT),
      maximized: self.maximized,
    })
  }
}

/// Clamp a sidebar width into the range the divider offers.
pub fn clamp_sidebar_width(width: f64) -> f64 {
  if !width.is_finite() {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  width.clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH).round()
}

/// Read the whole document. Anything unreadable — missing, truncated, hand-edited
/// — is an empty document; layout memory must never be why a launch behaves oddly.
fn read_document(path: &Path) -> Map<String, Value> {
  let text = match fs::read_to_string(path) {
    Ok(text) => text,
    Err(error) if error.kind() == io::ErrorKind::NotFound => return Map::new(),
    Err(error) => {
      log::warn!("could not read {}: {error}", path.display());
      return Map::new();
    }
  };

  // Notepad and `Set-Content -Encoding utf8` leave a UTF-8 BOM, which serde_json
  // refuses outright. Stripping it turns "layout forgotten" into a correct read.
  match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
    Ok(Value::Object(map)) => map,
    Ok(_) => {
      log::warn!("{} is not a json object — ignoring it", path.display());
      Map::new()
    }
    Err(error) => {
      log::warn!("ignoring {}: {error}", path.display());
      Map::new()
    }
  }
}

/// Replace one section, preserving every key this build does not know about.
fn write_section(path: &Path, key: &str, section: Value) -> io::Result<()> {
  write_document(path, |document| {
    document.insert(key.to_string(), section);
  })
}

/// Set one key inside a section, leaving the rest alone: the sidebar's width and
/// collapsed flag are written by different gestures and must not clobber each other.
fn write_section_key(path: &Path, section: &str, key: &str, value: Value) -> io::Result<()> {
  write_document(path, |document| {
    match document.get_mut(section) {
      Some(Value::Object(existing)) => {
        existing.insert(key.to_string(), value);
      }
      // Absent, or something that is not an object because the file was edited
      // by hand: start the section over rather than trying to merge into it.
      _ => {
        let mut fresh = Map::new();
        fresh.insert(key.to_string(), value);
        document.insert(section.to_string(), Value::Object(fresh));
      }
    }
  })
}

/// Read the document, let `edit` change it, and write it back atomically.
fn write_document(path: &Path, edit: impl FnOnce(&mut Map<String, Value>)) -> io::Result<()> {
  let mut document = read_document(path);
  edit(&mut document);

  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }
  let text = serde_json::to_string_pretty(&Value::Object(document)).map_err(io::Error::other)?;

  // Scratch file plus rename: a reader that catches us mid-write gets the previous
  // document rather than half of this one.
  let temp = path.with_extension(format!("{}.tmp", std::process::id()));
  if let Err(error) = fs::write(&temp, text) {
    let _ = fs::remove_file(&temp);
    return Err(error);
  }
  if let Err(error) = fs::rename(&temp, path) {
    let _ = fs::remove_file(&temp);
    return Err(error);
  }
  Ok(())
}

/// The remembered window geometry, clamped; `None` when there is nothing usable
/// on disk and the `tauri.conf.json` defaults should stand.
pub fn load_window(path: &Path) -> Option<WindowLayout> {
  serde_json::from_value::<WindowLayout>(read_document(path).get(KEY_WINDOW)?.clone())
    .ok()?
    .sanitised()
}

/// The remembered sidebar width, clamped; `None` when there is none.
pub fn load_sidebar_width(path: &Path) -> Option<f64> {
  read_document(path)
    .get(KEY_SIDEBAR)?
    .get(KEY_WIDTH)?
    .as_f64()
    .filter(|width| width.is_finite())
    .map(clamp_sidebar_width)
}

/// Whether the sidebar was left collapsed to its icon rail. Absent means no.
pub fn load_sidebar_collapsed(path: &Path) -> bool {
  read_document(path)
    .get(KEY_SIDEBAR)
    .and_then(|sidebar| sidebar.get(KEY_COLLAPSED))
    .and_then(Value::as_bool)
    .unwrap_or(false)
}

pub fn save_window(path: &Path, layout: WindowLayout) -> io::Result<()> {
  let value = serde_json::to_value(layout).map_err(io::Error::other)?;
  write_section(path, KEY_WINDOW, value)
}

pub fn save_sidebar_width(path: &Path, width: f64) -> io::Result<()> {
  write_section_key(
    path,
    KEY_SIDEBAR,
    KEY_WIDTH,
    clamp_sidebar_width(width).into(),
  )
}

pub fn save_sidebar_collapsed(path: &Path, collapsed: bool) -> io::Result<()> {
  write_section_key(path, KEY_SIDEBAR, KEY_COLLAPSED, collapsed.into())
}

/// Open state of the detail pane's three disclosures. Reading preferences, so
/// they live beside the window and sidebar layout, not in fleet `config.json`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailSections {
  pub what_to_run: bool,
  pub when_to_run: bool,
  pub how_to_run: bool,
}

impl Default for DetailSections {
  /// First-run shape: the everyday sections open, the tune-once "how to run" folded.
  fn default() -> Self {
    Self {
      what_to_run: true,
      when_to_run: true,
      how_to_run: false,
    }
  }
}

/// The section keys the frontend may store; also the JSON keys in the file.
pub const DETAIL_SECTION_KEYS: [&str; 3] = ["whatToRun", "whenToRun", "howToRun"];

/// The remembered disclosure states; absent or unreadable keys keep their defaults.
pub fn load_detail_sections(path: &Path) -> DetailSections {
  let defaults = DetailSections::default();
  let document = read_document(path);
  let Some(detail) = document.get(KEY_DETAIL) else {
    return defaults;
  };
  let open =
    |key: &str, default: bool| detail.get(key).and_then(Value::as_bool).unwrap_or(default);
  DetailSections {
    what_to_run: open("whatToRun", defaults.what_to_run),
    when_to_run: open("whenToRun", defaults.when_to_run),
    how_to_run: open("howToRun", defaults.how_to_run),
  }
}

/// Store one disclosure's state, leaving its siblings and other sections alone.
pub fn save_detail_section(path: &Path, section: &str, open: bool) -> io::Result<()> {
  write_section_key(path, KEY_DETAIL, section, open.into())
}

pub fn load_theme(path: &Path) -> ThemeChoice {
  read_document(path)
    .get(KEY_APPEARANCE)
    .and_then(|appearance| appearance.get(KEY_THEME))
    .and_then(|theme| serde_json::from_value(theme.clone()).ok())
    .unwrap_or(DEFAULT_THEME)
}

pub fn save_theme(path: &Path, theme: ThemeChoice) -> io::Result<()> {
  let value = serde_json::to_value(theme).map_err(io::Error::other)?;
  write_section_key(path, KEY_APPEARANCE, KEY_THEME, value)
}

/// Managed state: where the file lives, plus the geometry the window events keep
/// current so a save never has to ask a window that may already be gone.
///
/// `path` is optional because Tauri's path resolver can fail; layout memory then
/// turns itself off rather than taking the app down.
pub struct LayoutState {
  path: Option<PathBuf>,
  window: Mutex<WindowLayout>,
  /// Serialises the document read-modify-write: the window saves from the main
  /// thread and the sidebar from a command worker, which could otherwise interleave.
  file: Mutex<()>,
}

impl LayoutState {
  pub fn new(path: Option<PathBuf>, window: WindowLayout) -> Self {
    Self {
      path,
      window: Mutex::new(window),
      file: Mutex::new(()),
    }
  }

  pub fn path(&self) -> Option<&Path> {
    self.path.as_deref()
  }

  /// Record a resize. `maximized` is always kept; the size only while *not*
  /// maximised, so what is stored stays the size the window restores down to.
  pub fn record(&self, width: f64, height: f64, maximized: bool) {
    let Ok(mut window) = self.window.lock() else {
      log::error!("layout state lock poisoned");
      return;
    };
    window.maximized = maximized;
    if maximized {
      return;
    }
    if width >= MIN_WINDOW_WIDTH && height >= MIN_WINDOW_HEIGHT {
      window.width = width;
      window.height = height;
    }
  }

  pub fn snapshot(&self) -> WindowLayout {
    match self.window.lock() {
      Ok(window) => *window,
      Err(error) => {
        log::error!("layout state lock poisoned: {error}");
        WindowLayout::new(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT, false)
      }
    }
  }

  /// Write the current window geometry out. Called when the window is put away
  /// and again on exit; failures are logged and dropped.
  pub fn persist(&self) {
    let Some(path) = self.path() else {
      return;
    };
    let layout = self.snapshot();
    let _guard = self.file.lock();
    if let Err(error) = save_window(path, layout) {
      log::warn!("could not save the window layout: {error}");
    } else {
      log::debug!(
        "saved window layout {}x{} maximized={}",
        layout.width,
        layout.height,
        layout.maximized
      );
    }
  }

  /// The sidebar width to open with.
  pub fn sidebar_width(&self) -> f64 {
    self
      .path()
      .and_then(load_sidebar_width)
      .unwrap_or(DEFAULT_SIDEBAR_WIDTH)
  }

  /// Store a sidebar width, returning the value actually kept.
  pub fn set_sidebar_width(&self, width: f64) -> Result<f64, String> {
    let clamped = clamp_sidebar_width(width);
    let Some(path) = self.path() else {
      return Ok(clamped);
    };
    let _guard = self.file.lock();
    save_sidebar_width(path, clamped)
      .map(|()| clamped)
      .map_err(|error| format!("could not save the sidebar width: {error}"))
  }

  /// Whether the sidebar should open collapsed to its icon rail.
  pub fn sidebar_collapsed(&self) -> bool {
    self.path().map(load_sidebar_collapsed).unwrap_or(false)
  }

  /// Store whether the sidebar is collapsed, returning what was kept.
  pub fn set_sidebar_collapsed(&self, collapsed: bool) -> Result<bool, String> {
    let Some(path) = self.path() else {
      return Ok(collapsed);
    };
    let _guard = self.file.lock();
    save_sidebar_collapsed(path, collapsed)
      .map(|()| collapsed)
      .map_err(|error| format!("could not save the sidebar state: {error}"))
  }

  /// Which detail-pane sections should open expanded.
  pub fn detail_sections(&self) -> DetailSections {
    self.path().map(load_detail_sections).unwrap_or_default()
  }

  /// Store one section's open state, returning what was kept. The key is
  /// whitelisted here so the file cannot accumulate sections no build reads.
  pub fn set_detail_section(&self, section: &str, open: bool) -> Result<bool, String> {
    if !DETAIL_SECTION_KEYS.contains(&section) {
      return Err(format!("unknown detail section: {section}"));
    }
    let Some(path) = self.path() else {
      return Ok(open);
    };
    let _guard = self.file.lock();
    save_detail_section(path, section, open)
      .map(|()| open)
      .map_err(|error| format!("could not save the section state: {error}"))
  }

  pub fn theme(&self) -> ThemeChoice {
    self.path().map(load_theme).unwrap_or(DEFAULT_THEME)
  }

  pub fn set_theme(&self, theme: ThemeChoice) -> Result<ThemeChoice, String> {
    let Some(path) = self.path() else {
      return Ok(theme);
    };
    let _guard = self.file.lock();
    save_theme(path, theme)
      .map(|()| theme)
      .map_err(|error| format!("could not save the appearance: {error}"))
  }
}

/// the event that tells the page which theme to draw. the page can't read it from
/// its own `prefers-color-scheme`: tauri sets webview2's colour scheme when the
/// webview is created and when the os changes theme, never when the window is
/// pinned or freed, so the page would keep its launch theme.
pub const RESOLVED_EVENT: &str = "appearance-resolved";

/// pin the window theme, or hand it back to the os, then paint and tell the page.
pub fn apply_theme(window: &WebviewWindow, choice: ThemeChoice) {
  if let Err(error) = window.set_theme(choice.window_theme()) {
    log::warn!("could not set the window theme: {error}");
  }
  show_theme(window, current_theme(window));
}

/// paint the frame and tell the page for the theme the window now shows.
pub fn show_theme(window: &WebviewWindow, theme: Theme) {
  paint_frame(window, theme);
  if let Err(error) = window.emit(RESOLVED_EVENT, theme_name(theme)) {
    log::warn!("could not tell the page the appearance: {error}");
  }
}

/// the theme the page should draw now, as the word the page uses.
pub fn resolved_name(window: &WebviewWindow) -> &'static str {
  theme_name(current_theme(window))
}

fn theme_name(theme: Theme) -> &'static str {
  match theme {
    Theme::Light => "light",
    _ => "dark",
  }
}

/// under `system` only the window knows what the os said. no answer is dark, the
/// same fallback as `<html class="dark">`.
fn current_theme(window: &WebviewWindow) -> Theme {
  window.theme().unwrap_or(Theme::Dark)
}

fn paint_frame(window: &WebviewWindow, theme: Theme) {
  let color = match theme {
    Theme::Light => LIGHT_BACKGROUND,
    _ => DARK_BACKGROUND,
  };
  if let Err(error) = window.set_background_color(Some(color)) {
    log::warn!("could not paint the window background: {error}");
  }
}

/// Restore the remembered appearance and geometry onto the main window and build the
/// managed state.
///
/// Called from `setup` — the only point every launch converges on *before* the window
/// is first shown (`--tray` leaves it hidden for the tray to open later; a second
/// instance is forwarded into a window this has already sized).
pub fn restore(app: &AppHandle) -> LayoutState {
  let path = match app.path().app_data_dir() {
    Ok(dir) => Some(dir.join(LAYOUT_FILE)),
    Err(error) => {
      log::warn!("no per-user app data directory ({error}) — layout memory is off");
      None
    }
  };

  let Some(window) = app.get_webview_window("main") else {
    log::warn!("no main window to restore a layout onto");
    return LayoutState::new(
      path,
      WindowLayout::new(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT, false),
    );
  };

  let theme = path.as_deref().map(load_theme).unwrap_or(DEFAULT_THEME);
  // the window opens unpinned, so `system` is already in place; on linux
  // `set_theme(None)` would also clear the dark preference tao seeded from the portal
  if theme == ThemeChoice::System {
    paint_frame(&window, current_theme(&window));
  } else {
    apply_theme(&window, theme);
  }

  // The baseline is read off the window rather than duplicated here, so the
  // `tauri.conf.json` size stays the single source of the first-run default.
  let configured = configured_size(&window);

  let Some(saved) = path.as_deref().and_then(load_window) else {
    return LayoutState::new(path, configured);
  };

  if let Err(error) = window.set_size(LogicalSize::new(saved.width, saved.height)) {
    log::warn!("could not restore the window size: {error}");
    return LayoutState::new(path, configured);
  }
  // Position is deliberately not remembered, and growing from the config's centred
  // origin would leave a restored window off-centre — or off-screen on a display
  // that has since shrunk. Re-centring is the whole restore.
  if let Err(error) = window.center() {
    log::warn!("could not centre the window: {error}");
  }
  if saved.maximized {
    if let Err(error) = window.maximize() {
      log::warn!("could not restore the maximised window: {error}");
    }
  }

  log::info!(
    "restored window layout {}x{} maximized={}",
    saved.width,
    saved.height,
    saved.maximized
  );
  LayoutState::new(path, saved)
}

/// The window's current logical size, i.e. what `tauri.conf.json` asked for.
fn configured_size(window: &tauri::WebviewWindow) -> WindowLayout {
  let scale = window.scale_factor().unwrap_or(1.0);
  match window.inner_size() {
    Ok(size) => {
      let logical: LogicalSize<f64> = size.to_logical(scale);
      WindowLayout::new(logical.width, logical.height, false)
    }
    Err(error) => {
      log::warn!("could not read the window size: {error}");
      WindowLayout::new(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT, false)
    }
  }
}

/// Fold a resize into the state, in logical pixels. A minimised window reports 0x0
/// and reports not-maximised even when it will restore maximised, so those events
/// are dropped before they can rewrite either half of the record.
pub fn record_resize(window: &Window, state: &LayoutState, size: PhysicalSize<u32>) {
  if window.is_minimized().unwrap_or(false) {
    return;
  }
  let scale = window.scale_factor().unwrap_or(1.0);
  let logical: LogicalSize<f64> = size.to_logical(scale);
  state.record(
    logical.width,
    logical.height,
    window.is_maximized().unwrap_or(false),
  );
}

#[cfg(test)]
mod tests {
  use super::*;

  struct Scratch(PathBuf);

  impl Scratch {
    fn new(label: &str) -> Self {
      let dir = std::env::temp_dir().join(format!(
        "owlette-desktop-layout-{}-{label}",
        std::process::id()
      ));
      let _ = fs::remove_dir_all(&dir);
      fs::create_dir_all(&dir).expect("scratch dir");
      Self(dir)
    }

    /// A path one directory *below* the scratch root, so the writes have to
    /// create their parent the way the real app-data directory needs.
    fn file(&self) -> PathBuf {
      self.0.join("app.owlette.desktop").join(LAYOUT_FILE)
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn the_minimums_still_match_tauri_conf() {
    // The clamp exists to agree with the window the config declares; a bump
    // there without one here would restore windows the shell then resizes.
    let config: Value =
      serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
    let window = &config["app"]["windows"][0];
    assert_eq!(window["minWidth"].as_f64(), Some(MIN_WINDOW_WIDTH));
    assert_eq!(window["minHeight"].as_f64(), Some(MIN_WINDOW_HEIGHT));
    assert_eq!(window["visible"].as_bool(), Some(false));
  }

  #[test]
  fn the_configs_leave_the_theme_to_setup_and_open_on_the_dark_frame() {
    // a theme pinned in either config would hold until setup applies the stored
    // one; `backgroundColor` is the frame until setup paints the right one
    for (name, text) in [
      ("tauri.conf.json", include_str!("../tauri.conf.json")),
      (
        "tauri.macos.conf.json",
        include_str!("../tauri.macos.conf.json"),
      ),
    ] {
      let config: Value = serde_json::from_str(text).expect(name);
      let window = &config["app"]["windows"][0];
      assert!(window.get("theme").is_none(), "{name} pins a theme");
      let frame: Color = window["backgroundColor"]
        .as_str()
        .expect(name)
        .parse()
        .expect(name);
      assert_eq!(frame, DARK_BACKGROUND, "{name}");
    }
  }

  #[test]
  fn the_frame_colours_match_the_palette_they_were_converted_from() {
    // the two hexes are these tokens in srgb; a palette change must re-derive them
    // or the window shows a stale colour before the webview's first frame
    let css = include_str!("../../src/globals.css");
    assert!(
      css.contains("--background: oklch(0.975 0.006 250);"),
      "light --background moved"
    );
    assert!(
      css.contains("--background: oklch(0.145 0.03 250);"),
      "dark --background moved"
    );
  }

  #[test]
  fn the_page_hears_light_or_dark_and_dark_for_anything_else() {
    assert_eq!(theme_name(Theme::Light), "light");
    assert_eq!(theme_name(Theme::Dark), "dark");
  }

  #[test]
  fn the_appearance_defaults_to_system_and_round_trips() {
    let scratch = Scratch::new("appearance");
    let path = scratch.file();
    assert_eq!(DEFAULT_THEME, ThemeChoice::System);
    assert_eq!(load_theme(&path), ThemeChoice::System);

    save_sidebar_width(&path, 320.0).expect("sidebar");
    for theme in [ThemeChoice::Light, ThemeChoice::Dark, ThemeChoice::System] {
      save_theme(&path, theme).expect("save");
      assert_eq!(load_theme(&path), theme);
    }
    // the lowercase word the frontend sends and a hand edit would write
    assert_eq!(
      read_document(&path)[KEY_APPEARANCE][KEY_THEME],
      Value::from("system")
    );
    assert_eq!(load_sidebar_width(&path), Some(320.0));
  }

  #[test]
  fn an_unreadable_appearance_follows_the_os() {
    let scratch = Scratch::new("appearance-junk");
    let path = scratch.file();
    fs::create_dir_all(path.parent().expect("parent")).expect("dir");

    for junk in [
      "",
      "{",
      r#"{"appearance":"dark"}"#,
      r#"{"appearance":{}}"#,
      r#"{"appearance":{"theme":"Dark"}}"#,
      r#"{"appearance":{"theme":"sepia"}}"#,
      r#"{"appearance":{"theme":1}}"#,
    ] {
      fs::write(&path, junk).expect("seed");
      assert_eq!(load_theme(&path), ThemeChoice::System, "from {junk}");
    }

    // a section that is not an object is started over, touching nothing else
    fs::write(&path, r#"{"appearance":"dark","sidebar":{"width":300}}"#).expect("seed");
    save_theme(&path, ThemeChoice::Light).expect("save");
    assert_eq!(load_theme(&path), ThemeChoice::Light);
    assert_eq!(load_sidebar_width(&path), Some(300.0));
  }

  #[test]
  fn a_missing_file_remembers_nothing() {
    let scratch = Scratch::new("missing");
    assert_eq!(load_window(&scratch.file()), None);
    assert_eq!(load_sidebar_width(&scratch.file()), None);
  }

  #[test]
  fn the_window_round_trips_through_the_file() {
    let scratch = Scratch::new("window");
    let path = scratch.file();

    save_window(&path, WindowLayout::new(1400.0, 900.0, true)).expect("save");
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1400.0, 900.0, true))
    );

    // Restoring down and closing again overwrites the flag, not the size.
    save_window(&path, WindowLayout::new(1400.0, 900.0, false)).expect("save");
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1400.0, 900.0, false))
    );
  }

  #[test]
  fn the_document_is_namespaced_and_keeps_sections_it_does_not_own() {
    let scratch = Scratch::new("namespaced");
    let path = scratch.file();

    save_window(&path, WindowLayout::new(1200.0, 800.0, false)).expect("window");
    save_sidebar_width(&path, 320.0).expect("sidebar");

    // A key from a future build must survive a write from this one.
    let mut document = read_document(&path);
    document.insert("timeFormat".to_string(), Value::from("24h"));
    fs::write(
      &path,
      serde_json::to_string_pretty(&Value::Object(document)).expect("serialise"),
    )
    .expect("seed");

    save_window(&path, WindowLayout::new(1000.0, 700.0, false)).expect("rewrite");

    let document = read_document(&path);
    assert_eq!(document["timeFormat"], Value::from("24h"));
    assert_eq!(document[KEY_SIDEBAR][KEY_WIDTH].as_f64(), Some(320.0));
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1000.0, 700.0, false))
    );
    assert_eq!(load_sidebar_width(&path), Some(320.0));
  }

  #[test]
  fn the_detail_sections_round_trip_and_default_sensibly() {
    let scratch = Scratch::new("detail");
    let path = scratch.file();

    let defaults = load_detail_sections(&path);
    assert_eq!(defaults, DetailSections::default());
    assert!(defaults.what_to_run && defaults.when_to_run && !defaults.how_to_run);

    save_detail_section(&path, "howToRun", true).expect("save howToRun");
    save_detail_section(&path, "whatToRun", false).expect("save whatToRun");
    let stored = load_detail_sections(&path);
    assert!(!stored.what_to_run);
    assert!(stored.when_to_run);
    assert!(stored.how_to_run);
  }

  #[test]
  fn an_unknown_detail_section_is_refused() {
    let state = LayoutState::new(None, WindowLayout::new(800.0, 600.0, false));
    assert!(state.set_detail_section("advanced", true).is_err());
    // Pathless state still answers so the toggle works this session.
    assert_eq!(state.set_detail_section("howToRun", true), Ok(true));
  }

  #[test]
  fn a_corrupt_file_falls_back_silently() {
    let scratch = Scratch::new("corrupt");
    let path = scratch.file();
    fs::create_dir_all(path.parent().expect("parent")).expect("dir");

    for junk in [
      "",
      "{",
      "[]",
      r#"{"window":"1400x900"}"#,
      r#"{"window":{"width":"wide","height":900}}"#,
      r#"{"window":{"width":null,"height":null}}"#,
      r#"{"sidebar":{"width":"wide"}}"#,
    ] {
      fs::write(&path, junk).expect("seed");
      assert_eq!(load_window(&path), None, "window from {junk}");
      assert_eq!(load_sidebar_width(&path), None, "sidebar from {junk}");
    }

    // And a corrupt file is replaced, not appended to.
    fs::write(&path, "{").expect("seed");
    save_window(&path, WindowLayout::new(1060.0, 640.0, false)).expect("save");
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1060.0, 640.0, false))
    );
  }

  #[test]
  fn a_hand_edited_file_with_a_byte_order_mark_is_still_read() {
    let scratch = Scratch::new("bom");
    let path = scratch.file();
    fs::create_dir_all(path.parent().expect("parent")).expect("dir");

    // What `Set-Content -Encoding utf8` leaves behind on Windows PowerShell.
    fs::write(
      &path,
      "\u{feff}{\"window\":{\"width\":1200,\"height\":800},\"sidebar\":{\"width\":320}}",
    )
    .expect("seed");

    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1200.0, 800.0, false))
    );
    assert_eq!(load_sidebar_width(&path), Some(320.0));
  }

  #[test]
  fn a_window_smaller_than_the_minimum_is_clamped_up() {
    let scratch = Scratch::new("clamp-window");
    let path = scratch.file();

    save_window(&path, WindowLayout::new(320.0, 200.0, false)).expect("save");
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(
        MIN_WINDOW_WIDTH,
        MIN_WINDOW_HEIGHT,
        false
      ))
    );
  }

  #[test]
  fn an_impossible_window_is_discarded_rather_than_clamped() {
    let scratch = Scratch::new("absurd");
    let path = scratch.file();
    fs::create_dir_all(path.parent().expect("parent")).expect("dir");

    for junk in [
      r#"{"window":{"width":0,"height":0}}"#,
      r#"{"window":{"width":-1400,"height":900}}"#,
      r#"{"window":{"width":1.0e9,"height":900}}"#,
    ] {
      fs::write(&path, junk).expect("seed");
      assert_eq!(load_window(&path), None, "{junk}");
    }
  }

  #[test]
  fn the_sidebar_width_is_clamped_on_the_way_in_and_out() {
    let scratch = Scratch::new("clamp-sidebar");
    let path = scratch.file();

    save_window(&path, WindowLayout::new(1060.0, 640.0, false)).expect("window");

    save_sidebar_width(&path, 40.0).expect("save");
    assert_eq!(load_sidebar_width(&path), Some(MIN_SIDEBAR_WIDTH));

    save_sidebar_width(&path, 4000.0).expect("save");
    assert_eq!(load_sidebar_width(&path), Some(MAX_SIDEBAR_WIDTH));

    save_sidebar_width(&path, 301.4).expect("save");
    assert_eq!(load_sidebar_width(&path), Some(301.0));

    // A value written by hand outside the range is clamped as it is read, too.
    let mut document = read_document(&path);
    document.insert(
      KEY_SIDEBAR.to_string(),
      serde_json::json!({ KEY_WIDTH: 10_000 }),
    );
    fs::write(
      &path,
      serde_json::to_string_pretty(&Value::Object(document)).expect("serialise"),
    )
    .expect("seed");
    assert_eq!(load_sidebar_width(&path), Some(MAX_SIDEBAR_WIDTH));

    // …and none of that disturbed the window section.
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1060.0, 640.0, false))
    );
  }

  #[test]
  fn the_two_sidebar_settings_do_not_overwrite_each_other() {
    let scratch = Scratch::new("sidebar-pair");
    let path = scratch.file();

    // Width comes from a drag and the collapsed flag from the rail toggle, in
    // whatever order the operator produces them; either replacing the whole
    // section would forget the other.
    save_sidebar_width(&path, 340.0).expect("width");
    save_sidebar_collapsed(&path, true).expect("collapsed");
    assert_eq!(load_sidebar_width(&path), Some(340.0));
    assert!(load_sidebar_collapsed(&path));

    save_sidebar_width(&path, 260.0).expect("width again");
    assert!(
      load_sidebar_collapsed(&path),
      "collapsed survived a width write"
    );

    save_sidebar_collapsed(&path, false).expect("expanded");
    assert_eq!(
      load_sidebar_width(&path),
      Some(260.0),
      "the width survived a collapse write"
    );
    assert!(!load_sidebar_collapsed(&path));
  }

  #[test]
  fn a_sidebar_section_that_is_not_an_object_is_started_over() {
    let scratch = Scratch::new("sidebar-junk");
    let path = scratch.file();
    fs::create_dir_all(path.parent().expect("parent")).expect("dir");

    fs::write(
      &path,
      r#"{"sidebar":"wide","window":{"width":1200,"height":800}}"#,
    )
    .expect("seed");
    assert!(!load_sidebar_collapsed(&path));

    save_sidebar_collapsed(&path, true).expect("collapsed");
    assert!(load_sidebar_collapsed(&path));
    // …and the section it replaced was the only thing it touched.
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1200.0, 800.0, false))
    );
  }

  #[test]
  fn a_collapsed_flag_that_is_not_a_boolean_reads_as_expanded() {
    let scratch = Scratch::new("collapsed-junk");
    let path = scratch.file();
    fs::create_dir_all(path.parent().expect("parent")).expect("dir");

    for junk in [
      "",
      "{",
      r#"{"sidebar":{}}"#,
      r#"{"sidebar":{"collapsed":"yes"}}"#,
      r#"{"sidebar":{"collapsed":1}}"#,
    ] {
      fs::write(&path, junk).expect("seed");
      assert!(!load_sidebar_collapsed(&path), "from {junk}");
    }
  }

  #[test]
  fn a_write_leaves_no_scratch_file_behind() {
    let scratch = Scratch::new("temps");
    let path = scratch.file();
    save_window(&path, WindowLayout::new(1060.0, 640.0, false)).expect("save");

    let entries: Vec<String> = fs::read_dir(path.parent().expect("parent"))
      .expect("read dir")
      .filter_map(Result::ok)
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .collect();
    assert_eq!(entries, vec![LAYOUT_FILE.to_string()]);
  }

  #[test]
  fn a_maximised_resize_keeps_the_size_to_restore_down_to() {
    let state = LayoutState::new(None, WindowLayout::new(1060.0, 640.0, false));

    state.record(1200.0, 800.0, false);
    assert_eq!(state.snapshot(), WindowLayout::new(1200.0, 800.0, false));

    // Maximising resizes the window to the work area; that size must not become
    // the one the operator gets back when they restore down.
    state.record(2560.0, 1392.0, true);
    assert_eq!(state.snapshot(), WindowLayout::new(1200.0, 800.0, true));

    state.record(1200.0, 800.0, false);
    assert_eq!(state.snapshot(), WindowLayout::new(1200.0, 800.0, false));
  }

  #[test]
  fn a_minimise_sized_event_is_ignored() {
    let state = LayoutState::new(None, WindowLayout::new(1060.0, 640.0, false));
    // Windows reports 0x0 when a window is minimised.
    state.record(0.0, 0.0, false);
    assert_eq!(state.snapshot(), WindowLayout::new(1060.0, 640.0, false));
  }

  #[test]
  fn a_state_with_no_path_still_answers_the_frontend() {
    let state = LayoutState::new(None, WindowLayout::new(1060.0, 640.0, false));
    assert_eq!(state.sidebar_width(), DEFAULT_SIDEBAR_WIDTH);
    assert_eq!(state.set_sidebar_width(5000.0), Ok(MAX_SIDEBAR_WIDTH));
    assert!(!state.sidebar_collapsed());
    assert_eq!(state.set_sidebar_collapsed(true), Ok(true));
    assert_eq!(state.theme(), DEFAULT_THEME);
    assert_eq!(state.set_theme(ThemeChoice::Light), Ok(ThemeChoice::Light));
    state.persist();
  }

  #[test]
  fn the_managed_state_round_trips_both_sections() {
    let scratch = Scratch::new("managed");
    let path = scratch.file();

    let state = LayoutState::new(Some(path.clone()), WindowLayout::new(1060.0, 640.0, false));
    state.record(1440.0, 900.0, false);
    state.persist();
    assert_eq!(state.set_sidebar_width(360.0), Ok(360.0));

    assert_eq!(state.set_sidebar_collapsed(true), Ok(true));
    assert_eq!(state.set_theme(ThemeChoice::Dark), Ok(ThemeChoice::Dark));

    let reopened = LayoutState::new(Some(path.clone()), WindowLayout::new(1060.0, 640.0, false));
    assert_eq!(reopened.sidebar_width(), 360.0);
    assert!(reopened.sidebar_collapsed());
    assert_eq!(reopened.theme(), ThemeChoice::Dark);
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1440.0, 900.0, false))
    );
  }
}
