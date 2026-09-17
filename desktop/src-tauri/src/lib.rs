mod agent_cli;
mod commands;
mod json_io;
mod paths;
mod pid_file;
mod process_ctl;
mod service_ctl;
mod shell_open;
mod startup_link;
mod tray;
mod watchers;
mod window_state;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use crate::paths::TRAY_PID_REL;

/// Emitted when one of the seam files the service owns is replaced.
pub const EVENT_FILE_CHANGED: &str = "owlette://file-changed";

/// Emitted when a second launch is folded into this instance, carrying its
/// argv (`--tray`, `--restart-prompt`, ...) and working directory.
pub const EVENT_SECOND_INSTANCE: &str = "owlette://second-instance";

/// Argument the service passes when it spawns us to supply the tray icon; the
/// window stays hidden until the operator asks for it.
pub const ARG_TRAY: &str = "--tray";

/// Log file base name. Named after the binary, not `productName` ("owlette"), so a support
/// bundle can't confuse it with the service's own logs.
const LOG_FILE_NAME: &str = "owlette-desktop";

/// Rotation size. The plugin's 40 KB default is a window of minutes on an unattended machine.
const LOG_MAX_FILE_SIZE: u128 = 4 * 1024 * 1024;

/// Rotated files kept, so a fault reported a week late still has its run on disk. 4 × 4 MB.
const LOG_FILES_KEPT: usize = 3;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecondInstance {
  argv: Vec<String>,
  cwd: String,
}

/// Holds the file watchers for the life of the app; dropping this stops them.
struct Watchers(Mutex<Option<watchers::WatchHandle>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // First: plugins init in registration order, and this one must claim the instance lock.
    .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
      // Relaunch without `--tray` = operator asking for the window; with `--tray` = the
      // service topping up an existing tray, which must not pop a window.
      if argv.iter().any(|argument| argument == ARG_TRAY) {
        log::debug!("second instance asked for the tray only; staying hidden");
        // The service relaunches us only when it thinks the tray is missing, so
        // treat it as a report that what is on screen may be stale.
        tray::request_repaint(app);
      } else {
        tray::show_main_window(app);
      }
      if let Err(error) = app.emit(EVENT_SECOND_INSTANCE, SecondInstance { argv, cwd }) {
        log::warn!("could not forward the second instance argv: {error}");
      }
    }))
    // Native file and folder pickers for the process detail form.
    .plugin(tauri_plugin_dialog::init())
    // Degraded-state toasts from the tray monitor.
    .plugin(tauri_plugin_notification::init())
    // For upcoming filesystem browsing under the owlette tree; unused so far.
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![
      commands::owlette_data_root,
      commands::launch_args,
      commands::hostname,
      commands::startup_link_enabled,
      commands::set_startup_link,
      commands::read_owlette_json,
      commands::write_owlette_json,
      commands::service_status,
      commands::service_start,
      commands::service_stop,
      commands::terminate_pid,
      commands::agent_cli_start,
      commands::agent_cli_cancel,
      commands::open_owlette_path,
      commands::open_external_url,
      commands::log_event,
      commands::sidebar_width,
      commands::set_sidebar_width,
      commands::sidebar_collapsed,
      commands::set_sidebar_collapsed,
      commands::detail_sections,
      commands::set_detail_section,
    ])
    .setup(|app| {
      // Both profiles. A release build is `windows_subsystem = "windows"` with no console,
      // so without this a missing tray icon or a failed pairing dialog left nothing to read
      // on a machine that is usually in another building.
      //
      // `LogDir` is %LOCALAPPDATA%\<identifier>\logs — per-user, so writable by the
      // unelevated session this app runs in, unlike %PROGRAMDATA%\Owlette\logs.
      let mut logger = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .max_file_size(LOG_MAX_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepSome(LOG_FILES_KEPT))
        // Local time, not the plugin's UTC, so lines align with the service log directly.
        .timezone_strategy(TimezoneStrategy::UseLocal)
        // `Builder::new()` seeds stdout + an unnamed log-dir target; clear both so only the
        // named file and the explicit stdout decision remain.
        .clear_targets()
        .target(Target::new(TargetKind::LogDir {
          file_name: Some(LOG_FILE_NAME.to_owned()),
        }));
      // In `tauri dev` the console is the log anyone reads.
      if cfg!(debug_assertions) {
        logger = logger.target(Target::new(TargetKind::Stdout));
      }
      app.handle().plugin(logger.build())?;

      let root = paths::data_root();

      // Running agent-CLI children, so a pairing poll can be cancelled from its dialog and
      // none outlive the app.
      app.manage(agent_cli::Runs::default());

      // Publish our PID so the service stops spawning trays at us. Process-lifetime;
      // `tmp/gui.pid` exists only while the window is up.
      match pid_file::write(&root, TRAY_PID_REL) {
        Ok(path) => log::info!("wrote {}", path.display()),
        Err(error) => log::warn!("could not write the tray pid file: {error}"),
      }

      // Restore last-session geometry here: tray, plain launch and a forwarded second
      // instance all reach `show_main_window`, and this is the only point ahead of all three.
      app.manage(window_state::restore(app.handle()));

      // Configured hidden so a `--tray` launch never flashes a window; any other launch is
      // someone asking for the UI.
      if std::env::args().any(|argument| argument == ARG_TRAY) {
        log::info!("started with {ARG_TRAY} — staying in the notification area");
      } else {
        tray::show_main_window(app.handle());
      }

      // No tray icon means no way back to the window — unlike the watchers, this is fatal.
      tray::init(app.handle())?;

      // Seam-file watchers: a failure only costs external-change detection, so log it.
      let handle = app.handle().clone();
      let watchers = match watchers::spawn(&root, move |change| {
        if let Err(error) = handle.emit(EVENT_FILE_CHANGED, change) {
          log::warn!("could not emit a file-changed event: {error}");
        }
      }) {
        Ok(watchers) => Some(watchers),
        Err(error) => {
          log::error!("could not watch {}: {error}", root.display());
          None
        }
      };
      app.manage(Watchers(Mutex::new(watchers)));

      Ok(())
    })
    .on_window_event(|window, event| {
      if window.label() != "main" {
        return;
      }
      let layout = window.app_handle().try_state::<window_state::LayoutState>();

      match event {
        // Folded into layout state but never written here — an edge drag is a stream of these.
        WindowEvent::Resized(size) => {
          if let Some(layout) = layout {
            window_state::record_resize(window, &layout, *size);
          }
        }
        // Close hides rather than quits: the tray icon is the app's real lifetime, and
        // quitting would drop it for up to 30 s until the service relaunches. This is the
        // "put the window away" moment, so the layout is written here — the process may
        // then live for days.
        WindowEvent::CloseRequested { api, .. } => {
          api.prevent_close();
          if let Some(layout) = layout {
            layout.persist();
          }
          tray::hide_main_window(window.app_handle());
        }
        _ => {}
      }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| match event {
      // Tauri exits when the last window closes; we hide instead, so this only fires if
      // something else closed it — keep the tray alive. An explicit `app.exit(code)` wins.
      RunEvent::ExitRequested { code, api, .. } if code.is_none() => api.prevent_exit(),
      RunEvent::Exit => {
        // Tray "exit" quits without a close request, so save here too. Both paths write the
        // same tracked geometry — twice costs a file write, not a wrong one.
        if let Some(layout) = app.try_state::<window_state::LayoutState>() {
          layout.persist();
        }
        // Stop the tray monitor and watchers before teardown, then drop both pid markers so
        // the service stops treating the UI as open.
        tray::shutdown(app);
        if let Some(runs) = app.try_state::<agent_cli::Runs>() {
          agent_cli::cancel_all(&runs);
        }
        if let Some(watchers) = app.try_state::<Watchers>() {
          if let Ok(mut handle) = watchers.0.lock() {
            drop(handle.take());
          }
        }
        tray::clear_pid_markers();
      }
      _ => {}
    });
}
