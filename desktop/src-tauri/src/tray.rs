//! System tray icon — native replacement for `agent/src/owlette_tray.py`.
//!
//! Status = the SCM's view of `OwletteService` + `tmp/service_status.json`, read
//! without the JSON mutex. A file older than 120 s means nothing is publishing;
//! the SCM outranks the file in both directions.
//!
//! Deliberate split: what the operator *reads* (tooltip, status rows) is always
//! live and must agree with the window footer's `serviceHealth.deriveFooterState`;
//! what the operator *sees* (icon flash, toasts) keeps the 60 s last-good
//! fallback and the debounces so it does not flap on a torn read. Mixing the two
//! is how the tooltip came to say "connected" while the footer, on the same
//! screen, said "service not running on TEC-A4D".
//!
//! Toasts fire only after 5 s degraded, once per episode, with a 10 s grace
//! after launch.
//!
//! Two deliberate departures from the python tray:
//! * "start on login" manages the `{userstartup}` shortcut
//!   ([`crate::startup_link`]) rather than the service start type — no UAC
//!   prompt, and it cannot leave the machine unsupervised.
//! * "restart service" leaves this app running; single-instance means the
//!   service's post-restart launch folds back into this process.
//!
//! Every menu action runs on its own thread: menu events arrive on the main
//! thread and both the tray and window setters marshal back to it, so inline
//! work would block the event loop for the length of an SCM call or UAC prompt.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::NotificationExt;

#[cfg(windows)]
use crate::paths::RESTART_FLAG_REL;
use crate::paths::{self, AGENT_VERSION_REL, GUI_PID_REL, SERVICE_STATUS_REL, TRAY_PID_REL};
use crate::pid_file;
use crate::service_ctl;
use crate::startup_link::{self, Autostart};

/// Identity of the tray icon, used to fetch it back from an app handle.
const TRAY_ID: &str = "owlette";

const ID_OPEN: &str = "open";
const ID_RESTART: &str = "restart";
const ID_START_ON_LOGIN: &str = "start_on_login";
const ID_EXIT: &str = "exit";

/// 64 px downsamples of `agent/icons/*.png`. Embedded rather than read from
/// `{app}\agent\icons` so the app still has an icon with no agent tree.
const ICON_NORMAL: &[u8] = include_bytes!("../icons/tray/normal.png");
const ICON_DISCONNECTED: &[u8] = include_bytes!("../icons/tray/disconnected.png");
const ICON_ERROR: &[u8] = include_bytes!("../icons/tray/error.png");

/// Monitor granularity; the cadences below are multiples of it, so one thread
/// drives both the status poll and the error flash.
const TICK: Duration = Duration::from_millis(200);
/// Status re-read cadence.
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Half-period of the error flash.
const FLASH_PERIOD: Duration = Duration::from_millis(800);
/// How long a degraded state must persist before it is worth a toast.
const NOTIFY_DELAY: Duration = Duration::from_secs(5);
/// Silence window after launch, so a service still starting is not an incident.
const NOTIFY_GRACE: Duration = Duration::from_secs(10);
/// How long a cached status document stays usable after a failed read.
const STATUS_CACHE_TTL: Duration = Duration::from_secs(60);
/// How often the icon and tooltip are re-asserted even when nothing changed.
/// Nothing tells us that the shell re-registered the icon behind our back, so
/// this is the ceiling on how long a stale registration can stay on screen.
const REASSERT_INTERVAL: Duration = Duration::from_secs(60);
/// Consecutive refused writes before the retry drops to [`POLL_INTERVAL`].
const REFUSAL_BACKOFF_AFTER: u32 = 10;
/// How long the build-time status read may take before the tray is built from a
/// placeholder instead.
const SEED_TIMEOUT: Duration = Duration::from_millis(500);
/// Pause between the elevated stop and quitting, so the operator sees a clean
/// transition rather than the icon vanishing first.
#[cfg(windows)]
const EXIT_SETTLE: Duration = Duration::from_secs(2);

/// Overall health, in the three buckets the icon can show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StatusCode {
  /// Service running and reaching the cloud.
  Normal,
  /// Service running, cloud unreachable.
  Warning,
  /// Service stopped, or a health probe failed.
  Error,
}

impl StatusCode {
  fn icon_bytes(self) -> &'static [u8] {
    match self {
      StatusCode::Normal => ICON_NORMAL,
      StatusCode::Warning => ICON_DISCONNECTED,
      StatusCode::Error => ICON_ERROR,
    }
  }
}

/// Everything the tray displays, as one comparable value: diffing it each second
/// is what keeps the menu from being rebuilt 60 times a minute.
#[derive(Clone, Debug, PartialEq, Eq)]
struct TrayView {
  code: StatusCode,
  /// `service: running` / `stopped` / `error`.
  service: String,
  /// `status: connected to TEC` / `disconnected from TEC` / `auth_error` / …
  status: String,
  /// Health-probe message, when there is one.
  health: Option<String>,
  /// Three-way: the init system owns autostart off Windows, and the menu says
  /// so rather than offering a switch that cannot move.
  start_on_login: Autostart,
}

/// Live menu, kept so the common case is a text update. Rebuilt only when the
/// health row appears or disappears — muda cannot hide an item in place.
struct TrayMenu {
  menu: Menu<Wry>,
  service: MenuItem<Wry>,
  status: MenuItem<Wry>,
  health: Option<MenuItem<Wry>>,
  start_on_login: CheckMenuItem<Wry>,
}

/// Managed state: the menu handles plus the monitor thread's flags.
pub struct TrayState {
  menu: Mutex<TrayMenu>,
  stop: Arc<AtomicBool>,
  repaint: Arc<AtomicBool>,
}

/// What one tick's painting did. `Idle` and `Wrote` must stay distinct: reading
/// "nothing needed writing" as "the write landed" made a flashing error state
/// declare the shell recovered on every other half-period, and log a recovery
/// plus a fresh warning 2.5 times a second for as long as the shell stayed down.
#[derive(Debug)]
enum PaintOutcome {
  /// Already on screen.
  Idle,
  /// At least one write landed, and none were refused.
  Wrote,
  /// At least one write was refused; a partial tick counts as refused, so the
  /// half that did not land is retried.
  Refused(String),
}

/// Which icon a tick shows: the error state alternates with the normal icon to
/// flash, the other two are solid.
fn frame_for(code: StatusCode, flash_dim: bool) -> StatusCode {
  if code == StatusCode::Error && flash_dim {
    StatusCode::Normal
  } else {
    code
  }
}

/// What the notification area is actually showing, as opposed to what the
/// monitor last computed, and how hard we are still trying to change it.
///
/// Windows refuses every icon and tooltip write while the icon is not
/// registered, and the service launches this app about a second into boot —
/// before explorer.exe exists. `tray-icon` tolerates the failed add and
/// re-registers on `TaskbarCreated` from its own cache, i.e. from the
/// build-time bitmap, without replaying the writes it refused in between. So a
/// write only counts once it has succeeded: recording the attempt is what
/// latched the icon dim for the rest of the session after a boot.
struct PaintState {
  painted_icon: Option<StatusCode>,
  painted_tooltip: Option<String>,
  last_reassert: Instant,
  /// Consecutive refusals, reset by any write that lands.
  refusals: u32,
  last_attempt: Option<Instant>,
}

impl PaintState {
  fn new(now: Instant) -> Self {
    Self {
      painted_icon: None,
      painted_tooltip: None,
      last_reassert: now,
      refusals: 0,
      last_attempt: None,
    }
  }

  /// One tick: paint the frame this state and flash phase call for, and log one
  /// line per refusal streak — the retry runs five times a second.
  fn tick<W: TrayWriter>(
    &mut self,
    writer: &mut W,
    code: StatusCode,
    flash_dim: bool,
    tooltip: Option<&str>,
    now: Instant,
  ) -> PaintOutcome {
    if !self.retry_due(now) {
      return PaintOutcome::Idle;
    }
    self.last_attempt = Some(now);

    let outcome = self.paint(writer, frame_for(code, flash_dim), tooltip);
    match &outcome {
      PaintOutcome::Refused(error) => {
        if self.refusals == 0 {
          log::warn!("the notification area refused a tray update: {error}");
        }
        self.refusals = self.refusals.saturating_add(1);
      }
      PaintOutcome::Wrote => {
        if self.refusals > 0 {
          log::info!("the notification area is taking tray updates again");
        }
        self.refusals = 0;
      }
      PaintOutcome::Idle => {}
    }
    outcome
  }

  /// Write whatever is not already on screen, remembering only what the shell
  /// took.
  fn paint<W: TrayWriter>(
    &mut self,
    writer: &mut W,
    code: StatusCode,
    tooltip: Option<&str>,
  ) -> PaintOutcome {
    let mut wrote = false;
    let mut refusal = None;

    if self.needs_icon(code) {
      let result = writer.write_icon(code);
      self.record_icon(code, result.is_ok());
      match result {
        Ok(()) => wrote = true,
        Err(error) => refusal = refusal.or(Some(error)),
      }
    }

    if let Some(text) = tooltip {
      if self.needs_tooltip(text) {
        let result = writer.write_tooltip(text);
        self.record_tooltip(text, result.is_ok());
        match result {
          Ok(()) => wrote = true,
          Err(error) => refusal = refusal.or(Some(error)),
        }
      }
    }

    match (refusal, wrote) {
      (Some(error), _) => PaintOutcome::Refused(error),
      (None, true) => PaintOutcome::Wrote,
      (None, false) => PaintOutcome::Idle,
    }
  }

  /// A `NIM_MODIFY` can never land if the `NIM_ADD` never did — a kiosk that
  /// replaced explorer.exe never gets a notification area — so a streak that
  /// long stops costing a PNG decode and a main-thread round trip five times a
  /// second. The first refusals keep the tick cadence, so nothing is slower to
  /// recover from an ordinary boot.
  fn retry_due(&self, now: Instant) -> bool {
    if self.refusals < REFUSAL_BACKOFF_AFTER {
      return true;
    }
    self
      .last_attempt
      .map_or(true, |at| now.duration_since(at) >= POLL_INTERVAL)
  }

  fn needs_icon(&self, code: StatusCode) -> bool {
    self.painted_icon != Some(code)
  }

  fn needs_tooltip(&self, tooltip: &str) -> bool {
    self.painted_tooltip.as_deref() != Some(tooltip)
  }

  /// Only a write the shell took is remembered; a refusal leaves the last known
  /// value alone, so the next tick asks again.
  fn record_icon(&mut self, code: StatusCode, accepted: bool) {
    if accepted {
      self.painted_icon = Some(code);
    }
  }

  fn record_tooltip(&mut self, tooltip: &str, accepted: bool) {
    if accepted {
      self.painted_tooltip = Some(tooltip.to_string());
    }
  }

  /// Forget the screen, so the next tick paints both again.
  fn invalidate(&mut self) {
    self.painted_icon = None;
    self.painted_tooltip = None;
  }

  /// True once per [`REASSERT_INTERVAL`].
  fn reassert_due(&mut self, now: Instant) -> bool {
    if now.duration_since(self.last_reassert) < REASSERT_INTERVAL {
      return false;
    }
    self.last_reassert = now;
    true
  }
}

/// Build the tray icon and start the status monitor. Failure is fatal to the
/// caller: a tray app with no tray icon has no way back to its window.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
  let root = paths::data_root();
  let seed = seed_status(&root);
  let view = TrayView {
    code: seed.code,
    service: seed.service,
    status: seed.status,
    health: seed.health,
    start_on_login: startup_link::state(),
  };

  let menu = build_menu(app, &view)?;
  let tray = TrayIconBuilder::with_id(TRAY_ID)
    .icon(icon_for(view.code))
    .tooltip(tooltip(&view))
    .menu(&menu.menu)
    // Windows defaults to the menu on either button; left click must open the
    // window or there is no one-click way back to it.
    .show_menu_on_left_click(false)
    .build(app)?;

  tray.on_menu_event(|app, event| {
    let app = app.clone();
    let id = event.id().0.clone();
    // Handlers block on the SCM, on UAC and on the tray setters (which marshal
    // back to this, the main, thread).
    spawn_action("menu", move || handle_menu_event(&app, &id));
  });

  tray.on_tray_icon_event(|tray, event| {
    if let TrayIconEvent::Click {
      button: MouseButton::Left,
      button_state: MouseButtonState::Up,
      ..
    } = event
    {
      let app = tray.app_handle().clone();
      spawn_action("open", move || show_main_window(&app));
    }
  });

  let stop = Arc::new(AtomicBool::new(false));
  let repaint = Arc::new(AtomicBool::new(false));
  app.manage(TrayState {
    menu: Mutex::new(menu),
    stop: Arc::clone(&stop),
    repaint: Arc::clone(&repaint),
  });

  let handle = app.clone();
  thread::Builder::new()
    .name("owlette-tray".into())
    .spawn(move || monitor(handle, stop, repaint))?;

  Ok(())
}

/// Status to build the tray from: a real read where the machine answers in
/// time, because this is the icon `tray-icon` re-registers from if the
/// notification area is not up yet, and a hardcoded "checking..." could outlive
/// the check by a whole session.
///
/// Read on a thread of its own: the SCM call is unbounded, and on the setup
/// path a wedged SCM would keep the whole app — tray, watchers, event loop —
/// from ever coming up, where before it could only stall the monitor thread.
/// Nothing joins the thread, so a wedged call leaks one thread rather than
/// holding up the launch.
fn seed_status(root: &Path) -> Status {
  let (sender, receiver) = mpsc::channel();
  let path = root.to_path_buf();
  let spawned = thread::Builder::new()
    .name("owlette-tray-seed".into())
    .spawn(move || {
      let running = service_ctl::status(&path.join(SERVICE_STATUS_REL))
        .map(|status| status.running)
        .unwrap_or(false);
      let _ = sender.send(determine_status(&read_status_doc(&path), running));
    });

  if let Err(error) = spawned {
    log::warn!("could not spawn the tray seed read: {error}");
    return checking_status();
  }

  receiver.recv_timeout(SEED_TIMEOUT).unwrap_or_else(|_| {
    log::warn!(
      "the tray seed read did not answer in {} ms; building the tray from a placeholder",
      SEED_TIMEOUT.as_millis()
    );
    checking_status()
  })
}

/// The placeholder seed, for when the machine will not say. The monitor's first
/// tick replaces it a second later.
fn checking_status() -> Status {
  Status {
    code: StatusCode::Warning,
    service: "service: checking...".to_string(),
    status: "status: checking...".to_string(),
    health: None,
  }
}

/// Ask the monitor to repaint on its next tick. Belt and braces: the service
/// relaunches us with `--tray` only when `tmp/tray.pid` is absent, which a live
/// app always wrote, so this rarely fires in the field. Recovery rests on the
/// monitor's retry and re-assert, not on this.
pub fn request_repaint(app: &AppHandle) {
  if let Some(state) = app.try_state::<TrayState>() {
    state.repaint.store(true, Ordering::Relaxed);
  }
}

/// Stop the monitor thread. Called from `RunEvent::Exit`, before the app handle
/// it holds is torn down.
pub fn shutdown(app: &AppHandle) {
  if let Some(state) = app.try_state::<TrayState>() {
    state.stop.store(true, Ordering::Relaxed);
  }
}

/// Show and focus the main window, and publish `tmp/gui.pid` so the service
/// raises its metrics cadence while the operator is watching.
pub fn show_main_window(app: &AppHandle) {
  let Some(window) = app.get_webview_window("main") else {
    log::warn!("no main window to show");
    return;
  };
  let _ = window.unminimize();
  let _ = window.show();
  let _ = window.set_focus();

  match pid_file::write(&paths::data_root(), GUI_PID_REL) {
    Ok(path) => log::info!("wrote {}", path.display()),
    Err(error) => log::warn!("could not write the gui pid file: {error}"),
  }
}

/// Hide the main window back to the tray and drop `tmp/gui.pid`.
pub fn hide_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.hide();
  }
  pid_file::remove(&paths::data_root(), GUI_PID_REL);
}

fn monitor(app: AppHandle, stop: Arc<AtomicBool>, repaint: Arc<AtomicBool>) {
  let root = paths::data_root();
  let started = Instant::now();

  let mut current: Option<TrayView> = None;
  let mut cached_status: Option<(Value, Instant)> = None;
  let mut last_poll: Option<Instant> = None;
  let mut last_flash = Instant::now();
  let mut flash_dim = false;
  let mut degraded_since: Option<Instant> = None;
  let mut degraded_notified = false;
  let mut paint = PaintState::new(started);
  let mut wanted_tooltip: Option<String> = None;

  while !stop.load(Ordering::Relaxed) {
    let now = Instant::now();

    let asked = repaint.swap(false, Ordering::Relaxed);
    let reassert = paint.reassert_due(now);
    if asked || reassert {
      paint.invalidate();
    }

    if last_poll.map_or(true, |at| now.duration_since(at) >= POLL_INTERVAL) {
      last_poll = Some(now);

      // Every poll, not only when the document is missing: it is the one input
      // that cannot be out of date, and the text below may not contradict it.
      let scm_running = service_ctl::status(&root.join(SERVICE_STATUS_REL))
        .map(|status| status.running)
        .unwrap_or(false);

      let live = read_status_doc(&root);
      // Same rules, two documents: text must be live (it has to agree with the
      // window footer); the icon/toast signal keeps the smoothing so it does
      // not flap on a read that caught a rename.
      let text = determine_status(&live, scm_running);
      let signal = determine_status(&smoothed(&live, &mut cached_status), scm_running);

      let view = TrayView {
        code: signal.code,
        service: text.service,
        status: text.status,
        health: text.health,
        start_on_login: startup_link::state(),
      };

      if current.as_ref() != Some(&view) {
        let previous = current.replace(view.clone());
        if previous.map(|view| view.code) != Some(view.code) {
          // Reset the flash phase on every code change so a transition into
          // error shows the alert frame immediately.
          flash_dim = false;
          last_flash = now;
        }
        apply_menu(&app, &view);
        wanted_tooltip = Some(tooltip(&view));
      }

      // Only the Error tier toasts (narrowed 2026-08-14): a Warning is what
      // every routine restart looks like for a few seconds, and it produced
      // three queued toasts per restart. Recovery toasts close a real Error
      // episode only once the state is genuinely Normal, not merely Warning.
      match view.code {
        StatusCode::Normal => {
          if degraded_notified && now.duration_since(started) > NOTIFY_GRACE {
            notify(
              &app,
              "owlette — back online",
              "service running normally.".to_string(),
            );
          }
          degraded_since = None;
          degraded_notified = false;
        }
        StatusCode::Warning => {
          // Icon-only tier: Warning time never accrues toward an Error toast.
          degraded_since = None;
        }
        StatusCode::Error => {
          let since = *degraded_since.get_or_insert(now);
          if !degraded_notified
            && now.duration_since(since) >= NOTIFY_DELAY
            && now.duration_since(started) > NOTIFY_GRACE
          {
            degraded_notified = true;
            let (title, body) = degraded_notification(&view);
            notify(&app, title, body);
          }
        }
      }
    }

    // Flash only in the error state; the other two are solid.
    let in_error = current.as_ref().map(|view| view.code) == Some(StatusCode::Error);
    if in_error {
      if now.duration_since(last_flash) >= FLASH_PERIOD {
        last_flash = now;
        flash_dim = !flash_dim;
      }
    } else if flash_dim {
      flash_dim = false;
    }

    // One paint decision per tick, flash frames included, so a frame the shell
    // refuses is retried on the next tick instead of skipped to the next
    // half-period.
    if let Some(view) = &current {
      paint.tick(
        &mut ShellWriter(&app),
        view.code,
        flash_dim,
        wanted_tooltip.as_deref(),
        now,
      );
    }

    thread::sleep(TICK);
  }

  log::debug!("tray monitor stopped");
}

/// Push a view onto the tray menu: item text, or a rebuild when the health row
/// appears or disappears. The icon and tooltip go through [`PaintState::tick`] —
/// they are the two writes the shell can refuse.
fn apply_menu(app: &AppHandle, view: &TrayView) {
  let Some(tray) = app.tray_by_id(TRAY_ID) else {
    return;
  };
  let Some(state) = app.try_state::<TrayState>() else {
    return;
  };

  match state.menu.lock() {
    Ok(mut menu) => {
      if menu.health.is_some() != view.health.is_some() {
        match build_menu(app, view) {
          Ok(rebuilt) => {
            if let Err(error) = tray.set_menu(Some(rebuilt.menu.clone())) {
              log::warn!("could not swap the tray menu: {error}");
            }
            *menu = rebuilt;
          }
          Err(error) => log::warn!("could not rebuild the tray menu: {error}"),
        }
      } else {
        let _ = menu.service.set_text(&view.service);
        let _ = menu.status.set_text(&view.status);
        if let (Some(item), Some(text)) = (&menu.health, &view.health) {
          let _ = item.set_text(text);
        }
        let _ = menu
          .start_on_login
          .set_checked(start_on_login_checked(view.start_on_login));
      }
    }
    Err(error) => log::error!("tray menu lock poisoned: {error}"),
  };
}

/// The two writes the notification area can refuse, behind a trait so the tests
/// drive the real paint logic rather than a copy of it.
trait TrayWriter {
  fn write_icon(&mut self, code: StatusCode) -> Result<(), String>;
  fn write_tooltip(&mut self, text: &str) -> Result<(), String>;
}

/// The real thing: tauri's tray setters, which marshal to the main thread.
struct ShellWriter<'a>(&'a AppHandle);

impl TrayWriter for ShellWriter<'_> {
  fn write_icon(&mut self, code: StatusCode) -> Result<(), String> {
    set_icon(self.0, code)
  }

  fn write_tooltip(&mut self, text: &str) -> Result<(), String> {
    set_tooltip(self.0, text)
  }
}

fn set_icon(app: &AppHandle, code: StatusCode) -> Result<(), String> {
  let Some(tray) = app.tray_by_id(TRAY_ID) else {
    return Err("no tray icon to paint".to_string());
  };
  tray
    .set_icon(Some(icon_for(code)))
    .map_err(|error| format!("could not set the tray icon: {error}"))
}

fn set_tooltip(app: &AppHandle, text: &str) -> Result<(), String> {
  let Some(tray) = app.tray_by_id(TRAY_ID) else {
    return Err("no tray icon to paint".to_string());
  };
  tray
    .set_tooltip(Some(text))
    .map_err(|error| format!("could not set the tray tooltip: {error}"))
}

fn icon_for(code: StatusCode) -> Image<'static> {
  // Bytes are compiled in and decoded by this file's tests: a failure here is a
  // packaging bug, not a runtime condition.
  Image::from_bytes(code.icon_bytes()).expect("embedded tray icon should decode")
}


/// Outcome of one status evaluation.
struct Status {
  code: StatusCode,
  service: String,
  status: String,
  health: Option<String>,
}

/// What `tmp/service_status.json` had to say, and whether it is worth believing.
/// The three failure shapes must stay distinct: collapsing them into one `None`
/// is how a service that had stopped publishing read as "starting" forever.
#[derive(Clone, Debug, PartialEq)]
enum StatusDoc {
  /// Written within the freshness window.
  Fresh(Value),
  /// Exists but not rewritten for over 120 s; the service refreshes on a 30 s
  /// throttle, so nothing is publishing.
  Stale,
  /// No file at all — the service has not written one yet this run.
  Missing,
  /// Unparseable. Almost always a read that caught the service renaming over
  /// it, and gone by the next tick.
  Unreadable,
}

/// Read `tmp/service_status.json` outside the JSON mutex.
fn read_status_doc(root: &Path) -> StatusDoc {
  let path = root.join(SERVICE_STATUS_REL);
  let info = service_ctl::status_file_info(&path, SystemTime::now());
  if !info.exists {
    return StatusDoc::Missing;
  }
  if info.stale {
    return StatusDoc::Stale;
  }

  match fs::read_to_string(&path).ok().and_then(|text| {
    serde_json::from_str::<Value>(&text)
      .map_err(|error| log::debug!("torn read of {}: {error}", path.display()))
      .ok()
  }) {
    Some(value) => StatusDoc::Fresh(value),
    None => StatusDoc::Unreadable,
  }
}

/// The same document, with a torn read papered over by the last good one.
/// Only the icon and toasts may use the result — smoothing the tooltip is what
/// let it claim a connected service while the footer said it was not running.
fn smoothed(doc: &StatusDoc, cache: &mut Option<(Value, Instant)>) -> StatusDoc {
  match doc {
    StatusDoc::Fresh(value) => {
      *cache = Some((value.clone(), Instant::now()));
      doc.clone()
    }
    StatusDoc::Unreadable => match cache {
      Some((value, at)) if at.elapsed() < STATUS_CACHE_TTL => StatusDoc::Fresh(value.clone()),
      _ => {
        *cache = None;
        StatusDoc::Unreadable
      }
    },
    // Missing or stale is a verdict, not a failed read; holding the old
    // document would only delay it.
    _ => {
      *cache = None;
      doc.clone()
    }
  }
}

/// Map the SCM state and a status document onto the icon state and menu lines.
///
/// Precedence, in order — do not reorder:
/// 1. SCM says stopped wins over anything the document claims (a service killed
///    without writing its shutdown status kept the tray saying "connected" for
///    the whole two-minute freshness window). Matches `deriveFooterState`,
///    which checks `isServiceDown` first.
/// 2. A failed health probe outranks everything *except* a live cloud
///    connection: health fields are a snapshot, `firebase.connected` is the
///    live fact, and pre-connect-clears-health agents publish both at once.
/// 3. firebase switched off is an error — nothing is being monitored.
fn determine_status(doc: &StatusDoc, service_running: bool) -> Status {
  if !service_running {
    return Status {
      code: StatusCode::Error,
      service: "service: stopped".to_string(),
      status: "status: unknown".to_string(),
      health: None,
    };
  }

  let data = match doc {
    StatusDoc::Fresh(data) => data,
    // Running per the SCM but nothing published for two minutes: wedged, not
    // slow to start — same verdict the footer reports.
    StatusDoc::Stale => {
      return Status {
        code: StatusCode::Error,
        service: "service: running".to_string(),
        status: "status: not responding".to_string(),
        health: None,
      }
    }
    // No file yet this run — the service really is starting.
    StatusDoc::Missing | StatusDoc::Unreadable => {
      return Status {
        code: StatusCode::Warning,
        service: "service: running".to_string(),
        status: "status: starting".to_string(),
        health: None,
      }
    }
  };

  let firebase = data.get("firebase");
  let connected = firebase
    .and_then(|firebase| firebase.get("connected"))
    .and_then(Value::as_bool)
    .unwrap_or(false);

  let health = data.get("health");
  let health_status = health
    .and_then(|health| health.get("status"))
    .and_then(Value::as_str);
  if let Some(health_status) = health_status {
    // A live connection disproves the snapshot; only flash while it can be true.
    if !matches!(health_status, "ok" | "unknown") && !connected {
      let error_code = health
        .and_then(|health| health.get("error_code"))
        .and_then(Value::as_str)
        .unwrap_or(health_status);
      let message = health
        .and_then(|health| health.get("error_message"))
        .and_then(Value::as_str)
        .unwrap_or(error_code);
      return Status {
        code: StatusCode::Error,
        service: "service: error".to_string(),
        status: format!("status: {}", error_code.to_lowercase()),
        health: Some(format!("  {}", truncate(message, 60))),
      };
    }
  }

  let service_running = data
    .get("service")
    .and_then(|service| service.get("running"))
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let enabled = firebase
    .and_then(|firebase| firebase.get("enabled"))
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let site_id = firebase
    .and_then(|firebase| firebase.get("site_id"))
    .and_then(Value::as_str)
    .unwrap_or("");
  // Same document as site_id, so the two can never describe different sites —
  // unlike the window, which reconciles config.json as a second opinion.
  let site_name = firebase
    .and_then(|firebase| firebase.get("site_name"))
    .and_then(Value::as_str)
    .filter(|name| !name.is_empty())
    .unwrap_or(site_id);

  let paired = enabled && !site_id.is_empty();
  // "connected to TEC", not a bare "connected" — same sentence the window
  // footer builds, so comparing the two reads as one claim.
  let firebase_msg = if !paired {
    "disabled".to_string()
  } else if connected {
    format!("connected to {}", truncate(site_name, 40))
  } else {
    format!("disconnected from {}", truncate(site_name, 40))
  };

  let code = if !service_running || !paired {
    StatusCode::Error
  } else if connected {
    StatusCode::Normal
  } else {
    StatusCode::Warning
  };

  Status {
    code,
    service: if service_running {
      "service: running".to_string()
    } else {
      "service: stopped".to_string()
    },
    status: format!("status: {firebase_msg}"),
    health: None,
  }
}

/// Title and body for a degraded-state toast.
fn degraded_notification(view: &TrayView) -> (&'static str, String) {
  if view.code == StatusCode::Warning {
    return (
      "owlette — reconnecting",
      "cloud sync temporarily unavailable. local monitoring still active.".to_string(),
    );
  }

  match view.status.trim_start_matches("status: ") {
    "config_error" => (
      "owlette — config error",
      "config file missing or corrupted. please reinstall owlette.".to_string(),
    ),
    "auth_error" => (
      "owlette — not registered",
      "no authentication token found. please run the installer again.".to_string(),
    ),
    "network_error" => (
      "owlette — network unreachable",
      "network was not reachable at startup. check internet connection.".to_string(),
    ),
    "connection_failure" => (
      "owlette — connection failed",
      "persistent connection failures. check service logs.".to_string(),
    ),
    "fatal_error" => (
      "owlette — fatal error",
      "a fatal connection error occurred. check service logs.".to_string(),
    ),
    _ => (
      "owlette — service stopped",
      "the service is not running.\nclick 'restart service' to start it again."
        .to_string(),
    ),
  }
}

fn notify(app: &AppHandle, title: &str, body: String) {
  if let Err(error) = app.notification().builder().title(title).body(body).show() {
    log::warn!("could not show the tray notification: {error}");
  }
}


fn build_menu(app: &AppHandle, view: &TrayView) -> tauri::Result<TrayMenu> {
  let version = MenuItem::with_id(
    app,
    "version",
    format!("owlette v{}", agent_version(&paths::install_root())),
    false,
    None::<&str>,
  )?;
  let hostname = MenuItem::with_id(
    app,
    "hostname",
    format!("hostname: {}", hostname()),
    false,
    None::<&str>,
  )?;
  let service = MenuItem::with_id(app, "service", &view.service, false, None::<&str>)?;
  let status = MenuItem::with_id(app, "status", &view.status, false, None::<&str>)?;
  let health = match &view.health {
    Some(text) => Some(MenuItem::with_id(app, "health", text, false, None::<&str>)?),
    None => None,
  };

  let separator = PredefinedMenuItem::separator(app)?;
  let open = MenuItem::with_id(app, ID_OPEN, "open owlette", true, None::<&str>)?;
  let restart = MenuItem::with_id(app, ID_RESTART, "restart service", true, None::<&str>)?;
  let start_on_login = CheckMenuItem::with_id(
    app,
    ID_START_ON_LOGIN,
    start_on_login_label(view.start_on_login),
    start_on_login_clickable(view.start_on_login),
    start_on_login_checked(view.start_on_login),
    None::<&str>,
  )?;
  let exit = MenuItem::with_id(app, ID_EXIT, "exit", true, None::<&str>)?;

  let mut items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
    vec![&version, &hostname, &service, &status];
  if let Some(health) = &health {
    items.push(health);
  }
  items.extend([
    &separator as &dyn tauri::menu::IsMenuItem<Wry>,
    &open,
    &restart,
    &start_on_login,
    &exit,
  ]);

  let menu = Menu::with_items(app, &items)?;

  Ok(TrayMenu {
    menu,
    service,
    status,
    health,
    start_on_login,
  })
}

/// The autostart row's text. Where the init system owns it the row says so
/// rather than offering a switch that cannot move.
fn start_on_login_label(state: Autostart) -> &'static str {
  match state {
    Autostart::Managed => "start on login (managed by the system)",
    Autostart::Enabled | Autostart::Disabled => "start on login",
  }
}

/// Whether the row does anything when clicked. Only where this app owns the
/// setting.
fn start_on_login_clickable(state: Autostart) -> bool {
  state != Autostart::Managed
}

/// Whether the row shows a tick. A managed machine does start owlette at login,
/// but the box is not the thing that decides it, so it stays clear: a tick the
/// operator cannot clear reads as a setting they own.
fn start_on_login_checked(state: Autostart) -> bool {
  state == Autostart::Enabled
}

fn tooltip(view: &TrayView) -> String {
  format!(
    "owlette v{}\nhostname: {}\n{}\n{}",
    agent_version(&paths::install_root()),
    hostname(),
    view.service,
    view.status
  )
}

/// Version of the agent this app sits alongside — that, not this crate's, is
/// what the fleet records. Falls back to the crate version on a standalone dev
/// run with no agent tree.
fn agent_version(root: &Path) -> String {
  fs::read_to_string(root.join(AGENT_VERSION_REL))
    .map(|text| text.trim().to_string())
    .ok()
    .filter(|version| !version.is_empty())
    .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

/// The name the fleet records this machine under — `socket.gethostname()` on
/// the python side, the same name each arm here asks the OS for.
pub(crate) fn hostname() -> String {
  named(os_hostname())
}

/// What the tray shows when the OS will not give a name: blank would read as a
/// machine with no identity rather than one we could not ask.
fn named(reported: Option<String>) -> String {
  reported
    .map(|name| name.trim().to_string())
    .filter(|name| !name.is_empty())
    .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(windows)]
fn os_hostname() -> Option<String> {
  use windows::core::PWSTR;
  use windows::Win32::System::SystemInformation::{
    ComputerNamePhysicalDnsHostname, GetComputerNameExW,
  };

  // The DNS host name winsock would answer with, not `%COMPUTERNAME%`'s
  // NetBIOS form: the agent registers the machine under the former.
  let mut buffer = [0u16; 256];
  let mut length = buffer.len() as u32;
  // SAFETY: the buffer outlives the call and `length` is its size in wide
  // characters, which is what the API reads and then overwrites with the
  // length it wrote.
  unsafe {
    GetComputerNameExW(
      ComputerNamePhysicalDnsHostname,
      Some(PWSTR(buffer.as_mut_ptr())),
      &mut length,
    )
    .ok()?;
  }
  Some(String::from_utf16_lossy(&buffer[..length as usize]))
}

#[cfg(unix)]
fn os_hostname() -> Option<String> {
  let mut buffer = [0 as libc::c_char; 256];
  // SAFETY: the pointer is this buffer's, and the length is one short of it so
  // a truncated name keeps the terminator POSIX does not promise to write.
  let result = unsafe { libc::gethostname(buffer.as_mut_ptr(), buffer.len() - 1) };
  if result != 0 {
    return None;
  }
  // SAFETY: the call above terminated the name inside the buffer, which is
  // still borrowed here.
  let name = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) };
  Some(name.to_string_lossy().into_owned())
}

fn truncate(text: &str, limit: usize) -> String {
  if text.chars().count() <= limit {
    return text.to_string();
  }
  let head: String = text.chars().take(limit.saturating_sub(3)).collect();
  format!("{head}...")
}


fn spawn_action<F>(label: &'static str, action: F)
where
  F: FnOnce() + Send + 'static,
{
  if let Err(error) = thread::Builder::new()
    .name(format!("owlette-tray-{label}"))
    .spawn(action)
  {
    log::error!("could not run the {label} tray action: {error}");
  }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
  match id {
    ID_OPEN => show_main_window(app),
    ID_RESTART => restart_service(app),
    ID_START_ON_LOGIN => toggle_start_on_login(app),
    ID_EXIT => exit_owlette(app),
    // Header rows are disabled and never fire; anything else is an item added
    // without a handler.
    other => log::debug!("unhandled tray menu id: {other}"),
  }
}

/// Restart the service without a UAC prompt: a running agent is asked to exit
/// 42 via `tmp/restart.flag`, which owlette-host turns into a relaunch. A
/// stopped service has no loop to read the flag, so it is started directly —
/// the one path here that can raise an elevation prompt.
#[cfg(windows)]
fn restart_service(app: &AppHandle) {
  let root = paths::data_root();
  let running = service_ctl::status(&root.join(SERVICE_STATUS_REL))
    .map(|status| status.running)
    .unwrap_or(false);

  if !running {
    log::info!("service is stopped — starting it instead of writing the restart flag");
    // A tray-menu click is deliberate, so the UAC fallback is allowed.
    match service_ctl::start(true) {
      Ok(outcome) => {
        log::info!("service start issued ({})", outcome.method);
        notify(
          app,
          "owlette — starting",
          "starting service — will return momentarily".to_string(),
        );
      }
      Err(error) => {
        log::error!("could not start the service: {error}");
        notify(app, "restart failed", error);
      }
    }
    return;
  }

  let flag = root.join(RESTART_FLAG_REL);
  let written = flag
    .parent()
    .map(fs::create_dir_all)
    .unwrap_or(Ok(()))
    .and_then(|()| fs::write(&flag, "restart_requested"));

  match written {
    Ok(()) => {
      log::info!("restart flag written — owlette-host will relaunch the agent");
      notify(
        app,
        "owlette — restarting",
        "restarting service — will return momentarily".to_string(),
      );
    }
    Err(error) => {
      log::error!("could not write {}: {error}", flag.display());
      notify(app, "restart failed", error.to_string());
    }
  }
}

/// Restart the service, with no elevation prompt anywhere.
///
/// Same shape as the Windows arm — a stopped service is started rather than
/// asked to restart itself — but the ask is different. `tmp/restart.flag` is
/// honoured off Windows only when root wrote it
/// (`owlette_service._restart_requested`), because `tmp/` is group-writable
/// there, so the request goes into the `ipc/` seam and the daemon restarts its
/// own unit under the seam's nonce, rate limit and audit row.
#[cfg(unix)]
fn restart_service(app: &AppHandle) {
  let root = paths::data_root();
  let running = service_ctl::status(&root.join(SERVICE_STATUS_REL))
    .map(|status| status.running)
    .unwrap_or(false);

  if !running {
    log::info!("service is stopped — starting it instead of asking for a restart");
    // The flag the Windows arm passes for its UAC fallback; there is no
    // elevation off Windows, and polkit has already decided.
    match service_ctl::start(true) {
      Ok(outcome) => {
        log::info!("service start issued ({})", outcome.method);
        notify(
          app,
          "owlette — starting",
          "starting service — will return momentarily".to_string(),
        );
      }
      Err(error) => {
        log::error!("could not start the service: {error}");
        notify(app, "restart failed", error);
      }
    }
    return;
  }

  match service_ctl::restart(&root) {
    Ok(()) => {
      log::info!("the owlette daemon took the restart request");
      notify(
        app,
        "owlette — restarting",
        "restarting service — will return momentarily".to_string(),
      );
    }
    Err(error) => {
      log::error!("could not restart the service: {error}");
      notify(app, "restart failed", error);
    }
  }
}

fn toggle_start_on_login(app: &AppHandle) {
  let result = match startup_link::state() {
    Autostart::Enabled => startup_link::disable(),
    Autostart::Disabled => {
      startup_link::enable().map(|path| log::info!("wrote {}", path.display()))
    }
    // The row is built disabled where the system owns autostart, so this is
    // reachable only if a menu ever fires one anyway.
    Autostart::Managed => Ok(()),
  };

  if let Err(error) = result {
    log::error!("could not change the start-on-login shortcut: {error}");
    notify(app, "owlette — start on login", error);
  }

  // muda toggles the tick itself on click; resync against disk or a failed
  // write leaves the menu lying.
  if let Some(state) = app.try_state::<TrayState>() {
    if let Ok(menu) = state.menu.lock() {
      let _ = menu
        .start_on_login
        .set_checked(start_on_login_checked(startup_link::state()));
    }
  }
}

/// Quit owlette: stop supervising the machine, then quit the app. owlette-host
/// relaunches the agent on any unexpected exit, so the only real stop is a
/// controlled SCM stop, which needs rights this process usually lacks. We quit
/// either way — if the operator declines the prompt, the service relaunches the
/// tray.
#[cfg(windows)]
fn exit_owlette(app: &AppHandle) {
  hide_main_window(app);

  match service_ctl::stop() {
    Ok(outcome) => log::info!("service stop issued ({})", outcome.method),
    Err(error) => log::error!("could not stop the service on exit: {error}"),
  }

  thread::sleep(EXIT_SETTLE);
  app.exit(0);
}

/// Quit the app, and only the app.
///
/// Off Windows the init system starts the desktop app and the daemon never does
/// (decision 2), so nothing relaunches this process behind the operator's back
/// and there is no reason to stop the agent to make "exit" stick. Stopping the
/// machine's supervision because somebody closed a tray icon is the opposite of
/// what a kiosk needs.
#[cfg(unix)]
fn exit_owlette(app: &AppHandle) {
  hide_main_window(app);
  app.exit(0);
}


/// Drop both pid markers. Called on `RunEvent::Exit`.
pub fn clear_pid_markers() {
  let root = paths::data_root();
  pid_file::remove(&root, GUI_PID_REL);
  pid_file::remove(&root, TRAY_PID_REL);
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  /// SCM says up — the precondition for the document being consulted at all.
  const RUNNING: bool = true;
  const STOPPED: bool = false;

  fn fresh(value: Value) -> StatusDoc {
    StatusDoc::Fresh(value)
  }

  /// Stand-in for the notification area, which refuses writes until the icon is
  /// registered — the whole boot window, on a machine where the service starts
  /// this app before explorer.exe.
  struct FakeShell {
    refusals: usize,
    /// Refuse tooltips whatever `refusals` says: a tick where one write lands
    /// and the other does not is what makes the outcome's precedence matter.
    tooltips_refused: bool,
    icons: Vec<StatusCode>,
    tooltips: Vec<String>,
    icon_on_screen: Option<StatusCode>,
    tooltip_on_screen: Option<String>,
  }

  impl FakeShell {
    fn new(refusals: usize) -> Self {
      Self {
        refusals,
        tooltips_refused: false,
        icons: Vec::new(),
        tooltips: Vec::new(),
        icon_on_screen: None,
        tooltip_on_screen: None,
      }
    }

    /// The `TaskbarCreated` moment.
    fn accept(&mut self) {
      self.refusals = 0;
      self.tooltips_refused = false;
    }

    /// explorer.exe dying under a running tray.
    fn refuse_everything(&mut self) {
      self.refusals = usize::MAX;
    }

    fn refuses(&mut self) -> bool {
      if self.refusals == 0 {
        return false;
      }
      self.refusals -= 1;
      true
    }
  }

  impl TrayWriter for FakeShell {
    fn write_icon(&mut self, code: StatusCode) -> Result<(), String> {
      self.icons.push(code);
      if self.refuses() {
        return Err("the notification area is not registered".to_string());
      }
      self.icon_on_screen = Some(code);
      Ok(())
    }

    fn write_tooltip(&mut self, text: &str) -> Result<(), String> {
      self.tooltips.push(text.to_string());
      if self.tooltips_refused || self.refuses() {
        return Err("the notification area is not registered".to_string());
      }
      self.tooltip_on_screen = Some(text.to_string());
      Ok(())
    }
  }

  /// One monitor tick, through the real paint path: a solid frame, no tooltip.
  fn tick(paint: &mut PaintState, shell: &mut FakeShell, code: StatusCode) -> PaintOutcome {
    paint.tick(shell, code, false, None, Instant::now())
  }

  #[test]
  fn only_the_error_state_flashes() {
    assert_eq!(frame_for(StatusCode::Error, false), StatusCode::Error);
    assert_eq!(frame_for(StatusCode::Error, true), StatusCode::Normal);
    assert_eq!(frame_for(StatusCode::Normal, true), StatusCode::Normal);
    assert_eq!(
      frame_for(StatusCode::Warning, true),
      StatusCode::Warning,
      "a dim phase must never turn a disconnected tray green"
    );
  }

  #[test]
  fn a_refused_icon_is_retried_until_the_shell_takes_it() {
    let mut paint = PaintState::new(Instant::now());
    let mut shell = FakeShell::new(5);

    for _ in 0..8 {
      tick(&mut paint, &mut shell, StatusCode::Normal);
    }

    assert_eq!(shell.icon_on_screen, Some(StatusCode::Normal));
    assert_eq!(
      shell.icons.len(),
      6,
      "five refusals then the write that landed — and nothing after it"
    );
  }

  #[test]
  fn a_status_that_settles_while_the_shell_is_gone_still_reaches_the_screen() {
    // The field incident: at boot the service starts this app about a second
    // in, before explorer.exe, so every write is refused. The agent connects
    // ~13 s later and the code never changes again. Painting only on a code
    // change left the build-time dim icon on screen for the whole session.
    let mut paint = PaintState::new(Instant::now());
    let mut shell = FakeShell::new(usize::MAX);

    for code in [StatusCode::Warning, StatusCode::Error, StatusCode::Normal] {
      tick(&mut paint, &mut shell, code);
    }
    assert_eq!(
      shell.icon_on_screen, None,
      "nothing lands while the shell refuses"
    );

    shell.accept();
    tick(&mut paint, &mut shell, StatusCode::Normal);

    assert_eq!(
      shell.icon_on_screen,
      Some(StatusCode::Normal),
      "the next tick must repaint without a status change to prompt it"
    );
  }

  #[test]
  fn a_tick_with_nothing_to_write_is_not_a_recovery() {
    // Steady error under a dead shell: the flash half already on screen needs
    // no write, and reading that as "the shell is back" logged a recovery and a
    // fresh warning every 800 ms for as long as the machine stayed that way.
    let mut paint = PaintState::new(Instant::now());
    let mut shell = FakeShell::new(0);

    assert!(matches!(
      tick(&mut paint, &mut shell, StatusCode::Error),
      PaintOutcome::Wrote
    ));

    shell.refuse_everything();
    let dim = paint.tick(&mut shell, StatusCode::Error, true, None, Instant::now());
    assert!(matches!(dim, PaintOutcome::Refused(_)));

    let alert = paint.tick(&mut shell, StatusCode::Error, false, None, Instant::now());
    assert!(
      matches!(alert, PaintOutcome::Idle),
      "a frame already on screen is not a write that landed"
    );
  }

  #[test]
  fn a_tick_that_only_half_landed_is_still_a_refusal() {
    // Reading the icon's success as recovery would reset the streak and leave
    // the tooltip stale.
    let mut paint = PaintState::new(Instant::now());
    let mut shell = FakeShell::new(0);
    shell.tooltips_refused = true;

    let outcome = paint.tick(
      &mut shell,
      StatusCode::Normal,
      false,
      Some("owlette"),
      Instant::now(),
    );

    assert!(matches!(outcome, PaintOutcome::Refused(_)));
    assert_eq!(
      shell.icon_on_screen,
      Some(StatusCode::Normal),
      "the write that landed is kept"
    );
    assert_eq!(shell.tooltip_on_screen, None);

    paint.tick(
      &mut shell,
      StatusCode::Normal,
      false,
      Some("owlette"),
      Instant::now(),
    );
    assert_eq!(shell.icons.len(), 1, "only the refused half is retried");
    assert_eq!(shell.tooltips.len(), 2);
  }

  #[test]
  fn the_error_flash_paints_through_the_same_bookkeeping() {
    let mut paint = PaintState::new(Instant::now());
    let mut shell = FakeShell::new(1);
    let frame = |paint: &mut PaintState, shell: &mut FakeShell, dim: bool| {
      paint.tick(shell, StatusCode::Error, dim, None, Instant::now());
    };

    // A refused alert frame is retried on the next tick, not skipped to the
    // next half-period.
    frame(&mut paint, &mut shell, false);
    frame(&mut paint, &mut shell, false);
    assert_eq!(shell.icon_on_screen, Some(StatusCode::Error));

    frame(&mut paint, &mut shell, true);
    frame(&mut paint, &mut shell, true);
    frame(&mut paint, &mut shell, false);

    assert_eq!(
      shell.icons,
      vec![
        StatusCode::Error,
        StatusCode::Error,
        StatusCode::Normal,
        StatusCode::Error
      ],
      "one write per frame, and none for a frame already on screen"
    );
  }

  #[test]
  fn a_stale_registration_is_repainted_within_a_minute() {
    // An explorer restart re-registers the icon from tray-icon's cache without
    // telling us, so the only cure is to re-assert on a timer.
    let start = Instant::now();
    let mut paint = PaintState::new(start);
    let mut shell = FakeShell::new(0);

    tick(&mut paint, &mut shell, StatusCode::Normal);
    assert_eq!(shell.icons.len(), 1);

    assert!(!paint.reassert_due(start + REASSERT_INTERVAL - Duration::from_secs(1)));
    assert!(matches!(
      tick(&mut paint, &mut shell, StatusCode::Normal),
      PaintOutcome::Idle
    ));
    assert_eq!(
      shell.icons.len(),
      1,
      "a painted icon is not rewritten every tick"
    );

    assert!(paint.reassert_due(start + REASSERT_INTERVAL));
    paint.invalidate();
    tick(&mut paint, &mut shell, StatusCode::Normal);
    assert_eq!(shell.icons.len(), 2, "one forced write a minute");
    assert!(!paint.reassert_due(start + REASSERT_INTERVAL + Duration::from_secs(1)));
  }

  #[test]
  fn a_hopeless_retry_backs_off_to_the_poll_cadence() {
    // A kiosk that replaced explorer.exe never gets a notification area, and
    // full-speed retries there are a PNG decode and a main-thread round trip
    // five times a second for the life of the process.
    let start = Instant::now();
    let mut paint = PaintState::new(start);
    let mut shell = FakeShell::new(usize::MAX);
    let mut now = start;

    for _ in 0..REFUSAL_BACKOFF_AFTER {
      now += TICK;
      assert!(matches!(
        paint.tick(&mut shell, StatusCode::Normal, false, None, now),
        PaintOutcome::Refused(_)
      ));
    }
    let full_speed = REFUSAL_BACKOFF_AFTER as usize;
    assert_eq!(
      shell.icons.len(),
      full_speed,
      "the first refusals keep the tick cadence"
    );

    now += TICK;
    paint.tick(&mut shell, StatusCode::Normal, false, None, now);
    assert_eq!(shell.icons.len(), full_speed, "then the retry slows down");

    now += POLL_INTERVAL;
    paint.tick(&mut shell, StatusCode::Normal, false, None, now);
    assert_eq!(shell.icons.len(), full_speed + 1, "once a second, not five");

    // A write that lands resets the streak, so the next outage is caught at
    // full speed again.
    shell.accept();
    now += POLL_INTERVAL;
    assert!(matches!(
      paint.tick(&mut shell, StatusCode::Normal, false, None, now),
      PaintOutcome::Wrote
    ));

    shell.refuse_everything();
    paint.invalidate();
    now += TICK;
    paint.tick(&mut shell, StatusCode::Normal, false, None, now);
    assert_eq!(shell.icons.len(), full_speed + 3);
  }

  #[test]
  fn a_refused_tooltip_is_not_remembered_as_painted() {
    let mut paint = PaintState::new(Instant::now());
    let mut shell = FakeShell::new(2);
    let starting = "owlette v3.0.1\nstatus: starting";

    let refused = paint.tick(
      &mut shell,
      StatusCode::Warning,
      false,
      Some(starting),
      Instant::now(),
    );
    assert!(matches!(refused, PaintOutcome::Refused(_)));
    assert_eq!(shell.tooltip_on_screen, None);

    shell.accept();
    paint.tick(
      &mut shell,
      StatusCode::Warning,
      false,
      Some(starting),
      Instant::now(),
    );
    assert_eq!(shell.tooltip_on_screen.as_deref(), Some(starting));
    assert_eq!(
      shell.tooltips.len(),
      2,
      "the refused tooltip was asked again"
    );

    let idle = paint.tick(
      &mut shell,
      StatusCode::Warning,
      false,
      Some(starting),
      Instant::now(),
    );
    assert!(matches!(idle, PaintOutcome::Idle));
    assert_eq!(shell.tooltips.len(), 2);
  }

  #[test]
  fn the_placeholder_seed_says_it_is_still_looking() {
    // What a machine whose SCM did not answer in time builds its tray from.
    let seed = checking_status();
    assert_eq!(seed.code, StatusCode::Warning);
    assert_eq!(seed.service, "service: checking...");
    assert_eq!(seed.status, "status: checking...");
    assert!(seed.health.is_none());
  }

  #[test]
  fn every_embedded_icon_decodes() {
    for code in [StatusCode::Normal, StatusCode::Warning, StatusCode::Error] {
      let image = Image::from_bytes(code.icon_bytes()).expect("icon should decode");
      assert_eq!((image.width(), image.height()), (64, 64));
    }
  }

  #[test]
  fn a_missing_status_document_falls_back_to_the_scm() {
    let stopped = determine_status(&StatusDoc::Missing, STOPPED);
    assert_eq!(stopped.code, StatusCode::Error);
    assert_eq!(stopped.service, "service: stopped");

    let starting = determine_status(&StatusDoc::Missing, RUNNING);
    assert_eq!(starting.code, StatusCode::Warning);
    assert_eq!(starting.status, "status: starting");
  }

  #[test]
  fn a_stopped_service_is_reported_stopped_however_healthy_the_document_looks() {
    // 2026-08-13: agent killed without writing shutdown status left a healthy
    // document for the whole freshness window; tooltip and footer disagreed.
    let healthy = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "ok" }
    });

    let status = determine_status(&fresh(healthy), STOPPED);

    assert_eq!(status.service, "service: stopped");
    assert_eq!(status.status, "status: unknown");
    assert_eq!(status.code, StatusCode::Error);
    assert!(status.health.is_none());
  }

  #[test]
  fn a_stopped_service_outranks_even_a_failed_health_probe() {
    // deriveFooterState checks isServiceDown before health; both surfaces must
    // answer the same way.
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "error", "error_code": "auth_error", "error_message": "no token" }
    });

    let status = determine_status(&fresh(data), STOPPED);

    assert_eq!(status.service, "service: stopped");
    assert!(
      status.health.is_none(),
      "no health row for a service that is not running"
    );
  }

  #[test]
  fn the_text_is_live_even_while_the_icon_is_still_smoothed() {
    // The policy split as a test: the cache may steady the icon across a torn
    // read, never the tooltip of a service the SCM says is stopped.
    let mut cache = None;
    let healthy = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "ok" }
    });

    let primed = smoothed(&fresh(healthy), &mut cache);
    assert_eq!(
      determine_status(&primed, RUNNING).status,
      "status: connected to hq"
    );
    assert!(
      cache.is_some(),
      "a good read should be remembered for the icon"
    );

    // Service stopped, next read torn: the icon path keeps its cached document
    // but both halves must still say stopped.
    let live = StatusDoc::Unreadable;
    let icon_doc = smoothed(&live, &mut cache);
    assert!(
      matches!(icon_doc, StatusDoc::Fresh(_)),
      "the icon keeps its smoothing"
    );

    let text = determine_status(&live, STOPPED);
    assert_eq!(text.service, "service: stopped");
    assert_eq!(text.status, "status: unknown");
  }

  #[test]
  fn a_live_connection_outranks_a_stale_health_error() {
    // TEC-B4A 2026-08-17: boot probe recorded network_error before DHCP
    // finished; the agent connected 8 s later and the icon flashed red for the
    // rest of uptime. Connected is the live fact; health is a memory.
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": {
        "status": "network_error",
        "error_code": "network_error",
        "error_message": "Network not reachable at startup"
      }
    });

    let status = determine_status(&fresh(data), RUNNING);

    assert_eq!(status.code, StatusCode::Normal);
    assert_eq!(status.status, "status: connected to hq");
    assert!(status.health.is_none());
  }

  #[test]
  fn a_health_error_still_flashes_while_disconnected() {
    // Not connected + failed probe is exactly what the error flash exists for.
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": false, "site_id": "hq" },
      "health": {
        "status": "auth_error",
        "error_code": "auth_error",
        "error_message": "no token"
      }
    });

    let status = determine_status(&fresh(data), RUNNING);

    assert_eq!(status.code, StatusCode::Error);
    assert_eq!(status.status, "status: auth_error");
    assert!(status.health.is_some());
  }

  #[test]
  fn a_service_that_stopped_publishing_is_not_reported_as_starting() {
    // "starting" is only for no file yet; a stale file means wedged.
    let stale = determine_status(&StatusDoc::Stale, RUNNING);
    assert_eq!(stale.code, StatusCode::Error);
    assert_eq!(stale.service, "service: running");
    assert_eq!(stale.status, "status: not responding");
  }

  #[test]
  fn a_stale_document_is_never_smoothed_over() {
    // Staleness is a verdict, not a failed read.
    let mut cache = None;
    let healthy = json!({ "service": { "running": true } });
    smoothed(&fresh(healthy), &mut cache);
    assert!(cache.is_some());

    assert_eq!(smoothed(&StatusDoc::Stale, &mut cache), StatusDoc::Stale);
    assert!(cache.is_none(), "the cache must be dropped, not consulted");
  }

  #[test]
  fn a_connected_service_is_normal() {
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "ok" }
    });
    let status = determine_status(&fresh(data), RUNNING);
    assert_eq!(status.code, StatusCode::Normal);
    assert_eq!(status.service, "service: running");
    // No name published: fall back to the id, never to nothing.
    assert_eq!(status.status, "status: connected to hq");
    assert!(status.health.is_none());
  }

  #[test]
  fn the_site_is_named_the_way_the_operator_names_it() {
    // Same sentence the window footer builds: "TEC-A4D is connected to TEC".
    let data = json!({
      "service": { "running": true },
      "firebase": {
        "enabled": true, "connected": true,
        "site_id": "default_site", "site_name": "TEC"
      },
      "health": { "status": "ok" }
    });
    let status = determine_status(&fresh(data), RUNNING);
    assert_eq!(status.status, "status: connected to TEC");
  }

  #[test]
  fn an_empty_site_name_falls_back_to_the_id() {
    // What an agent that could not read its site document publishes.
    let data = json!({
      "service": { "running": true },
      "firebase": {
        "enabled": true, "connected": true,
        "site_id": "default_site", "site_name": ""
      },
      "health": { "status": "ok" }
    });
    let status = determine_status(&fresh(data), RUNNING);
    assert_eq!(status.status, "status: connected to default_site");
  }

  #[test]
  fn an_absurd_site_name_cannot_run_away_with_the_row() {
    let data = json!({
      "service": { "running": true },
      "firebase": {
        "enabled": true, "connected": true,
        "site_id": "hq", "site_name": "x".repeat(200)
      },
      "health": { "status": "ok" }
    });
    let status = determine_status(&fresh(data), RUNNING);
    let name = status
      .status
      .strip_prefix("status: connected to ")
      .expect("connected row");
    assert_eq!(name.chars().count(), 40, "37 plus the ellipsis");
    assert!(name.ends_with("..."));
  }

  #[test]
  fn a_disconnected_cloud_is_a_warning_not_an_error() {
    let data = json!({
      "service": { "running": true },
      "firebase": {
        "enabled": true, "connected": false,
        "site_id": "default_site", "site_name": "TEC"
      }
    });
    let status = determine_status(&fresh(data), RUNNING);
    assert_eq!(status.code, StatusCode::Warning);
    // "from", matching the footer's disconnected sentence.
    assert_eq!(status.status, "status: disconnected from TEC");
  }

  #[test]
  fn the_autostart_row_hands_back_to_the_system_where_it_belongs() {
    assert_eq!(
      start_on_login_label(Autostart::Managed),
      "start on login (managed by the system)"
    );
    // Unchecked AND disabled: the row explains itself instead of offering a
    // switch that cannot move.
    assert!(!start_on_login_clickable(Autostart::Managed));
    assert!(!start_on_login_checked(Autostart::Managed));

    // Negative control: where the app owns the shortcut the row is an ordinary
    // checkbox.
    for state in [Autostart::Enabled, Autostart::Disabled] {
      assert_eq!(start_on_login_label(state), "start on login");
      assert!(start_on_login_clickable(state));
    }
    assert!(start_on_login_checked(Autostart::Enabled));
    assert!(!start_on_login_checked(Autostart::Disabled));
  }

  #[test]
  fn a_reconnecting_toast_survives_the_site_being_named() {
    // Toast text is chosen from the status row; appending must not break it.
    let view = TrayView {
      code: StatusCode::Warning,
      service: "service: running".to_string(),
      status: "status: disconnected from TEC".to_string(),
      health: None,
      start_on_login: Autostart::Disabled,
    };
    let (title, _) = degraded_notification(&view);
    assert_eq!(title, "owlette — reconnecting");
  }

  #[test]
  fn an_unpaired_machine_is_an_error_because_nothing_is_monitored() {
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "" }
    });
    let status = determine_status(&fresh(data), RUNNING);
    assert_eq!(status.code, StatusCode::Error);
    assert_eq!(status.status, "status: disabled");
  }

  #[test]
  fn a_failed_health_probe_shapes_the_error_rows() {
    // Precedence is covered elsewhere; this pins the row shape.
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": false, "site_id": "hq" },
      "health": { "status": "error", "error_code": "auth_error", "error_message": "no token" }
    });
    let status = determine_status(&fresh(data), RUNNING);
    assert_eq!(status.code, StatusCode::Error);
    assert_eq!(status.service, "service: error");
    assert_eq!(status.status, "status: auth_error");
    assert_eq!(status.health.as_deref(), Some("  no token"));
  }

  #[test]
  fn a_long_health_message_is_truncated_for_the_menu() {
    let message = "x".repeat(200);
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": false, "site_id": "hq" },
      "health": { "status": "error", "error_code": "config_error", "error_message": message }
    });
    let status = determine_status(&fresh(data), RUNNING);
    let row = status.health.expect("health row");
    assert_eq!(row.chars().count(), 62, "two leading spaces plus 60");
    assert!(row.ends_with("..."));
  }

  #[test]
  fn health_error_codes_map_to_their_own_toast() {
    let view = |status: &str, code: StatusCode| TrayView {
      code,
      service: "service: error".to_string(),
      status: status.to_string(),
      health: None,
      start_on_login: Autostart::Disabled,
    };

    let (title, _) = degraded_notification(&view("status: auth_error", StatusCode::Error));
    assert_eq!(title, "owlette — not registered");

    let (title, _) = degraded_notification(&view("status: unknown", StatusCode::Error));
    assert_eq!(title, "owlette — service stopped");

    let (title, _) = degraded_notification(&view("status: disconnected", StatusCode::Warning));
    assert_eq!(title, "owlette — reconnecting");
  }

  #[test]
  fn the_three_ways_a_status_read_can_fail_stay_distinguishable() {
    // Collapsing these into one "absent" made a service that stopped publishing
    // indistinguishable from one that had not started yet.
    let dir = std::env::temp_dir().join(format!("owlette-tray-status-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("tmp")).expect("scratch");

    assert_eq!(read_status_doc(&dir), StatusDoc::Missing);

    fs::write(
      dir.join(SERVICE_STATUS_REL),
      r#"{"service":{"running":true}}"#,
    )
    .expect("seed");
    assert!(matches!(read_status_doc(&dir), StatusDoc::Fresh(_)));

    fs::write(dir.join(SERVICE_STATUS_REL), "{\"service\":").expect("tear");
    assert_eq!(read_status_doc(&dir), StatusDoc::Unreadable);

    // A torn read still rides on the cached document for the icon.
    let mut cache = None;
    smoothed(
      &fresh(json!({ "service": { "running": true } })),
      &mut cache,
    );
    assert!(matches!(
      smoothed(&read_status_doc(&dir), &mut cache),
      StatusDoc::Fresh(_)
    ));

    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn the_agent_version_falls_back_to_the_crate_version() {
    let dir = std::env::temp_dir().join(format!("owlette-tray-version-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch");
    assert_eq!(agent_version(&dir), env!("CARGO_PKG_VERSION"));

    fs::create_dir_all(dir.join("agent")).expect("agent dir");
    fs::write(dir.join(AGENT_VERSION_REL), "2.12.21\n").expect("seed");
    assert_eq!(agent_version(&dir), "2.12.21");

    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn the_os_answers_with_a_hostname_on_this_platform() {
    let name = hostname();
    assert_ne!(name, "unknown", "the platform hostname call failed");
    // A name carrying the terminator or the padding of the buffer it was read
    // into is a name the dashboard would never match against the agent's.
    assert!(!name.chars().any(char::is_control), "{name:?}");
    assert!(!name.chars().any(char::is_whitespace), "{name:?}");
  }

  /// Negative control for the test above: "unknown" is reachable, from the one
  /// path that should reach it, so a failing platform call cannot pass as a
  /// hostname.
  #[test]
  fn a_name_the_os_will_not_give_reads_as_unknown() {
    assert_eq!(named(None), "unknown");
    assert_eq!(named(Some("  \n".to_string())), "unknown");
    assert_eq!(named(Some("  kiosk-01\n".to_string())), "kiosk-01");
  }
}
