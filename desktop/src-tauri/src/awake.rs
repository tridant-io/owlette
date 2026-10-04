//! Keeps this session's screens awake while the service asks (keep screens
//! awake, task 1.4).
//!
//! The service holds the system's part, sleep, which works with nobody logged
//! in; only the session can hold the rest, the idle lock and the screensaver.
//! Every five seconds this reads `keep_awake.wanted` from
//! `tmp/service_status.json`. A document without it is a service that never
//! asked, and a missing or stale one is a service that is not asking, so all
//! three are `false`; a read that caught a rename changes nothing.
//!
//! Per OS, all on this one long-lived thread:
//! * Windows: `SetThreadExecutionState`, whose state belongs to the thread that
//!   set it, so it is set and cleared here and nowhere else; and the session's
//!   screensaver, turned off when it was on and back on at release. Both calls
//!   leave the user's own settings alone: fWinIni 0 is the session's copy only.
//! * macOS: a `PreventUserIdleDisplaySleep` assertion, plus the user declared
//!   active every 30 s, which is what keeps the screensaver and the lock away.
//! * Linux: an idle inhibitor from gnome-session, or from the freedesktop
//!   screensaver where there is no gnome-session. Each lives as long as the
//!   session-bus connection that took it, so the connection is held with it.
//!
//! What is held is reported in `ipc/keep_awake.json` (`held`, `how`, `reason`,
//! and `at` in unix seconds) on every change and every minute, for the service
//! to mirror onto the machine.

use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::paths::{KEEP_AWAKE_REPORT_REL, SERVICE_STATUS_REL};
use crate::service_ctl;

const POLL_EVERY: Duration = Duration::from_secs(5);
const REPORT_EVERY: Duration = Duration::from_secs(60);
/// The user's own, writable by nobody else, as `tcc.rs` writes its report.
#[cfg(unix)]
const FILE_MODE: u32 = 0o644;
/// The reason while the service is not asking.
const NOT_WANTED: &str = "not_wanted";

/// The OS's half, behind a trait so the decisions are tested on every OS
/// without holding anything.
trait Hold {
  /// Take the hold: what holds it, or why it could not be taken. Called only
  /// while nothing is held.
  fn take(&mut self) -> Result<&'static str, String>;
  /// Called on every poll while held.
  fn renew(&mut self) {}
  /// Let go of everything `take` took. Called only while held.
  fn release(&mut self);
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum State {
  /// Held, by this mechanism.
  Held(&'static str),
  /// Not held, and why.
  Free(String),
}

/// The decisions, apart from the OS: the hold and what it is now.
struct Keeper<H: Hold> {
  hold: H,
  state: State,
}

impl<H: Hold> Keeper<H> {
  fn new(hold: H) -> Self {
    Self {
      hold,
      state: State::Free(NOT_WANTED.to_owned()),
    }
  }

  /// Bring the hold in line with `wanted`. True when the state changed, which
  /// is when a report is due. A refused hold is tried again on the next call.
  fn apply(&mut self, wanted: bool) -> bool {
    let next = match (&self.state, wanted) {
      (State::Held(_), true) => {
        self.hold.renew();
        return false;
      }
      (State::Held(_), false) => {
        self.hold.release();
        State::Free(NOT_WANTED.to_owned())
      }
      (State::Free(_), false) => State::Free(NOT_WANTED.to_owned()),
      (State::Free(_), true) => match self.hold.take() {
        Ok(how) => State::Held(how),
        Err(reason) => State::Free(reason),
      },
    };
    let changed = next != self.state;
    self.state = next;
    changed
  }
}

/// What the service asks for: `keep_awake.wanted`, and `false` when it does not
/// say.
fn wanted(status: &Value) -> bool {
  status
    .pointer("/keep_awake/wanted")
    .and_then(Value::as_bool)
    .unwrap_or(false)
}

/// One read of the status document, judged fresh against `now`; `None` when it
/// could not be read, which changes nothing.
fn read_wanted(root: &Path, now: SystemTime) -> Option<bool> {
  let path = root.join(SERVICE_STATUS_REL);
  if service_ctl::status_file_info(&path, now).stale {
    return Some(false);
  }
  let text = fs::read_to_string(&path).ok()?;
  serde_json::from_str::<Value>(&text)
    .ok()
    .map(|status| wanted(&status))
}

/// The report body, as the service parses it.
fn report(state: &State, at: u64) -> String {
  let (held, how, reason) = match state {
    State::Held(how) => (true, Some(*how), None),
    State::Free(reason) => (false, None, Some(reason.as_str())),
  };
  serde_json::json!({ "held": held, "how": how, "reason": reason, "at": at }).to_string()
}

/// Write the report whole and move it into place: the service may read it at
/// any moment and a half-written file is a report of nothing.
fn write_report(root: &Path, state: &State) -> std::io::Result<PathBuf> {
  let path = root.join(KEEP_AWAKE_REPORT_REL);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }
  let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
  let at = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(std::io::Error::other)?
    .as_secs();
  let written =
    write_new(&temp, report(state, at).as_bytes()).and_then(|()| fs::rename(&temp, &path));
  if written.is_err() {
    // Ours by its name; left behind it would refuse every later write.
    let _ = fs::remove_file(&temp);
  }
  written.map(|()| path)
}

fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  let mut options = fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  options.mode(FILE_MODE);
  options.open(path)?.write_all(bytes)
}

/// Poll, hold, report; for the life of the app. A failed write is tried again
/// on the next poll and logged once.
fn run(root: &Path, hold: impl Hold) {
  let mut keeper = Keeper::new(hold);
  let mut reported: Option<Instant> = None;
  let mut write_failing = false;
  loop {
    if let Some(wanted) = read_wanted(root, SystemTime::now()) {
      if keeper.apply(wanted) {
        match &keeper.state {
          State::Held(how) => log::info!("keep screens awake: held by {how}"),
          State::Free(reason) => log::info!("keep screens awake: not held ({reason})"),
        }
        reported = None;
      }
    }
    if reported.map_or(true, |at| at.elapsed() >= REPORT_EVERY) {
      match write_report(root, &keeper.state) {
        Ok(_) => {
          reported = Some(Instant::now());
          write_failing = false;
        }
        Err(error) => {
          if !write_failing {
            log::warn!("could not write the keep-awake report: {error}");
          }
          write_failing = true;
        }
      }
    }
    thread::sleep(POLL_EVERY);
  }
}

/// Start the holder. Everything it takes is let go when the process ends,
/// except the Windows screensaver flag, which lasts the session.
pub fn spawn(root: &Path) {
  let root = root.to_path_buf();
  let spawned = thread::Builder::new()
    .name("owlette-awake".into())
    .spawn(move || run(&root, os::Session::default()));
  if let Err(error) = spawned {
    log::error!("could not start the keep-awake holder: {error}");
  }
}

#[cfg(windows)]
mod os {
  use windows::core::BOOL;
  use windows::Win32::System::Power::{
    SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
  };
  use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPI_GETSCREENSAVEACTIVE, SPI_SETSCREENSAVEACTIVE,
    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
  };

  use super::Hold;

  /// fWinIni 0: the session's copy of the setting, never the user's profile.
  const SESSION_ONLY: SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS = SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0);

  #[derive(Default)]
  pub struct Session {
    /// The screensaver was on and `take` turned it off.
    screensaver_was_on: bool,
  }

  impl Hold for Session {
    fn take(&mut self) -> Result<&'static str, String> {
      // SAFETY: flags only. The state belongs to the calling thread, which is
      // the holder's own and lives as long as the app.
      let previous = unsafe {
        SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED)
      };
      if previous.0 == 0 {
        return Err("windows refused the execution state".to_owned());
      }
      // Off only when it was on, so release puts back exactly what was found.
      self.screensaver_was_on = screensaver_active() == Some(true);
      if self.screensaver_was_on {
        set_screensaver(false);
      }
      Ok("execution_state")
    }

    fn release(&mut self) {
      // SAFETY: as above; ES_CONTINUOUS alone clears what `take` set.
      unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
      if std::mem::take(&mut self.screensaver_was_on) {
        set_screensaver(true);
      }
    }
  }

  /// Whether the session's screensaver is on; `None` when Windows would not say.
  fn screensaver_active() -> Option<bool> {
    let mut active = BOOL::default();
    // SAFETY: SPI_GETSCREENSAVEACTIVE writes one BOOL through the pointer,
    // which outlives the call.
    let read = unsafe {
      SystemParametersInfoW(
        SPI_GETSCREENSAVEACTIVE,
        0,
        Some(std::ptr::addr_of_mut!(active).cast()),
        SESSION_ONLY,
      )
    };
    match read {
      Ok(()) => Some(active.as_bool()),
      Err(error) => {
        log::warn!("keep screens awake: could not read the screensaver setting: {error}");
        None
      }
    }
  }

  fn set_screensaver(active: bool) {
    // SAFETY: SPI_SETSCREENSAVEACTIVE reads uiParam only.
    let set = unsafe {
      SystemParametersInfoW(
        SPI_SETSCREENSAVEACTIVE,
        u32::from(active),
        None,
        SESSION_ONLY,
      )
    };
    if let Err(error) = set {
      log::warn!(
        "keep screens awake: could not turn the screensaver {}: {error}",
        if active { "on" } else { "off" }
      );
    }
  }
}

#[cfg(target_os = "macos")]
mod os {
  use std::time::{Duration, Instant};

  use objc2_foundation::NSString;

  use super::Hold;

  /// What `pmset -g assertions` shows beside this app's pid.
  const NAME: &str = "owlette keep screens awake";
  /// `kIOPMAssertionTypePreventUserIdleDisplaySleep`.
  const PREVENT_USER_IDLE_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";
  /// `kIOPMAssertionLevelOn`.
  const ASSERTION_LEVEL_ON: u32 = 255;
  /// `kIOPMUserActiveLocal`.
  const USER_ACTIVE_LOCAL: u32 = 0;
  /// `kIOPMNullAssertionID`.
  const NULL_ASSERTION: u32 = 0;
  const DECLARE_EVERY: Duration = Duration::from_secs(30);

  // IOKit's power assertions, which no crate in the lock exports. They take a
  // CFString, and NSString is toll-free bridged to it.
  #[link(name = "IOKit", kind = "framework")]
  extern "C" {
    fn IOPMAssertionCreateWithName(
      kind: &NSString,
      level: u32,
      name: &NSString,
      id: &mut u32,
    ) -> i32;
    fn IOPMAssertionDeclareUserActivity(name: &NSString, user_type: u32, id: &mut u32) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
  }

  #[derive(Default)]
  pub struct Session {
    display: u32,
    activity: u32,
    declared: Option<Instant>,
  }

  impl Session {
    fn declare(&mut self) {
      let name = NSString::from_str(NAME);
      // SAFETY: the name outlives the call, which writes one id; the last id
      // passed back renews that same assertion.
      let code =
        unsafe { IOPMAssertionDeclareUserActivity(&name, USER_ACTIVE_LOCAL, &mut self.activity) };
      if code != 0 {
        log::warn!("keep screens awake: could not declare the user active (iokit {code:#x})");
      }
      self.declared = Some(Instant::now());
    }
  }

  impl Hold for Session {
    fn take(&mut self) -> Result<&'static str, String> {
      let kind = NSString::from_str(PREVENT_USER_IDLE_DISPLAY_SLEEP);
      let name = NSString::from_str(NAME);
      let mut id = NULL_ASSERTION;
      // SAFETY: both strings outlive the call, which writes one id.
      match unsafe { IOPMAssertionCreateWithName(&kind, ASSERTION_LEVEL_ON, &name, &mut id) } {
        0 => self.display = id,
        code => return Err(format!("iokit refused the assertion ({code:#x})")),
      }
      self.declare();
      Ok("iopm_assertion")
    }

    fn renew(&mut self) {
      if self
        .declared
        .map_or(true, |at| at.elapsed() >= DECLARE_EVERY)
      {
        self.declare();
      }
    }

    fn release(&mut self) {
      for id in [
        std::mem::take(&mut self.display),
        std::mem::take(&mut self.activity),
      ] {
        if id != NULL_ASSERTION {
          // SAFETY: an id an assertion call wrote and nothing has released.
          unsafe { IOPMAssertionRelease(id) };
        }
      }
      self.declared = None;
    }
  }
}

#[cfg(target_os = "linux")]
mod os {
  use zbus::blocking::Connection;
  use zbus::zvariant::DynamicType;

  use super::Hold;

  const APP_ID: &str = "owlette";
  const REASON: &str = "keep screens awake";
  /// gnome-session's idle flag: the session is never marked idle, so it
  /// neither blanks nor locks.
  const INHIBIT_IDLE: u32 = 8;

  /// A session-bus inhibitor. Its service name is its interface name too.
  struct Inhibitor {
    how: &'static str,
    service: &'static str,
    path: &'static str,
    uninhibit: &'static str,
  }

  static GNOME: Inhibitor = Inhibitor {
    how: "gnome_session",
    service: "org.gnome.SessionManager",
    path: "/org/gnome/SessionManager",
    uninhibit: "Uninhibit",
  };
  static SCREENSAVER: Inhibitor = Inhibitor {
    how: "freedesktop_screensaver",
    service: "org.freedesktop.ScreenSaver",
    path: "/org/freedesktop/ScreenSaver",
    uninhibit: "UnInhibit",
  };

  #[derive(Default)]
  pub struct Session {
    /// The connection the inhibitor lives on, which inhibitor, and its cookie.
    held: Option<(Connection, &'static Inhibitor, u32)>,
  }

  impl Hold for Session {
    fn take(&mut self) -> Result<&'static str, String> {
      let bus = Connection::session().map_err(|error| format!("no session bus: {error}"))?;
      let (inhibitor, cookie) = match inhibit(&bus, &GNOME, &(APP_ID, 0u32, REASON, INHIBIT_IDLE)) {
        Ok(cookie) => (&GNOME, cookie),
        Err(gnome) => match inhibit(&bus, &SCREENSAVER, &(APP_ID, REASON)) {
          Ok(cookie) => (&SCREENSAVER, cookie),
          Err(screensaver) => {
            return Err(format!(
              "no idle inhibitor: gnome-session: {gnome}; screensaver: {screensaver}"
            ))
          }
        },
      };
      self.held = Some((bus, inhibitor, cookie));
      Ok(inhibitor.how)
    }

    fn release(&mut self) {
      if let Some((bus, inhibitor, cookie)) = self.held.take() {
        let released = bus.call_method(
          Some(inhibitor.service),
          inhibitor.path,
          Some(inhibitor.service),
          inhibitor.uninhibit,
          &cookie,
        );
        if let Err(error) = released {
          // Dropping the connection below lets go of it all the same.
          log::warn!(
            "keep screens awake: {}.{} failed: {error}",
            inhibitor.service,
            inhibitor.uninhibit
          );
        }
      }
    }
  }

  fn inhibit<B>(bus: &Connection, inhibitor: &Inhibitor, body: &B) -> zbus::Result<u32>
  where
    B: serde::Serialize + DynamicType,
  {
    let reply = bus.call_method(
      Some(inhibitor.service),
      inhibitor.path,
      Some(inhibitor.service),
      "Inhibit",
      body,
    )?;
    let cookie = reply.body().deserialize::<u32>()?;
    Ok(cookie)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicUsize, Ordering};

  /// Counts what the keeper asks of the OS, and refuses the hold when told to.
  #[derive(Default)]
  struct Fake {
    takes: usize,
    renews: usize,
    releases: usize,
    refuse: Option<&'static str>,
  }

  impl Hold for Fake {
    fn take(&mut self) -> Result<&'static str, String> {
      self.takes += 1;
      match self.refuse {
        Some(reason) => Err(reason.to_owned()),
        None => Ok("fake"),
      }
    }

    fn renew(&mut self) {
      self.renews += 1;
    }

    fn release(&mut self) {
      self.releases += 1;
    }
  }

  /// A fresh root of its own, never removed: nothing here deletes a tree.
  fn scratch() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    let dir = std::env::temp_dir().join(format!(
      "owlette-awake-{}-{nanos}-{}",
      std::process::id(),
      NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).expect("a scratch directory");
    dir
  }

  fn status(root: &Path, text: &str) {
    let path = root.join(SERVICE_STATUS_REL);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
  }

  #[test]
  fn only_a_true_wanted_asks() {
    assert!(wanted(
      &serde_json::json!({ "keep_awake": { "wanted": true } })
    ));
    assert!(!wanted(
      &serde_json::json!({ "keep_awake": { "wanted": false } })
    ));
    assert!(
      !wanted(&serde_json::json!({ "running": true })),
      "an old service never asked"
    );
    assert!(!wanted(&serde_json::json!({ "keep_awake": {} })));
    assert!(
      !wanted(&serde_json::json!({ "keep_awake": { "wanted": "true" } })),
      "not a bool"
    );
    assert!(!wanted(&serde_json::json!({ "keep_awake": true })));
  }

  #[test]
  fn a_missing_or_stale_status_is_not_asking_and_a_torn_one_says_nothing() {
    let root = scratch();
    let now = SystemTime::now();
    assert_eq!(read_wanted(&root, now), Some(false), "missing");
    status(&root, r#"{"keep_awake":{"wanted":true}}"#);
    assert_eq!(read_wanted(&root, now), Some(true));
    let later = now + service_ctl::STATUS_STALE_AFTER + Duration::from_secs(60);
    assert_eq!(read_wanted(&root, later), Some(false), "stale");
    status(&root, r#"{"keep_awake":{"wan"#);
    assert_eq!(read_wanted(&root, now), None, "torn");
    status(&root, r#"{"running":true}"#);
    assert_eq!(read_wanted(&root, now), Some(false), "an old service");
  }

  #[test]
  fn hold_release_hold() {
    let mut keeper = Keeper::new(Fake::default());
    assert!(!keeper.apply(false), "nothing asked, nothing to change");
    assert_eq!(keeper.hold.takes, 0);

    assert!(keeper.apply(true));
    assert_eq!(keeper.state, State::Held("fake"));
    assert!(!keeper.apply(true), "held once, not twice");
    assert_eq!((keeper.hold.takes, keeper.hold.renews), (1, 1));

    assert!(keeper.apply(false));
    assert_eq!(keeper.state, State::Free(NOT_WANTED.to_owned()));
    assert!(!keeper.apply(false));
    assert_eq!(keeper.hold.releases, 1);

    assert!(keeper.apply(true));
    assert_eq!(keeper.state, State::Held("fake"));
    assert_eq!((keeper.hold.takes, keeper.hold.releases), (2, 1));
  }

  #[test]
  fn a_refused_hold_is_tried_again_and_never_released() {
    let mut keeper = Keeper::new(Fake {
      refuse: Some("refused"),
      ..Fake::default()
    });
    assert!(keeper.apply(true));
    assert_eq!(keeper.state, State::Free("refused".to_owned()));
    assert!(!keeper.apply(true), "the same refusal is no change");
    assert_eq!(keeper.hold.takes, 2);

    assert!(keeper.apply(false));
    assert_eq!(keeper.state, State::Free(NOT_WANTED.to_owned()));
    assert_eq!(
      (keeper.hold.renews, keeper.hold.releases),
      (0, 0),
      "nothing was held"
    );
  }

  #[test]
  fn the_report_is_the_fields_the_service_reads() {
    assert_eq!(
      report(&State::Held("execution_state"), 1_790_000_000),
      r#"{"held":true,"how":"execution_state","reason":null,"at":1790000000}"#
    );
    assert_eq!(
      report(&State::Free(NOT_WANTED.to_owned()), 1_790_000_000),
      r#"{"held":false,"how":null,"reason":"not_wanted","at":1790000000}"#
    );
  }

  #[test]
  fn the_report_is_written_whole_in_place_and_replaced() {
    let root = scratch();
    write_report(&root, &State::Free(NOT_WANTED.to_owned())).expect("first report");
    let path = write_report(&root, &State::Held("fake")).expect("second report");
    assert_eq!(path, root.join(KEEP_AWAKE_REPORT_REL));
    let written: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(written["held"], true);
    assert_eq!(written["how"], "fake");
    assert!(
      written["at"].as_u64().is_some_and(|at| at > 1_700_000_000),
      "{written}"
    );
    assert_eq!(
      fs::read_dir(path.parent().unwrap()).unwrap().count(),
      1,
      "no temp file left"
    );
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o022, 0);
    }
  }

  #[test]
  fn a_leftover_temp_file_costs_one_write_not_every_write() {
    let root = scratch();
    let path = root.join(KEEP_AWAKE_REPORT_REL);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
      path.with_extension(format!("json.{}.tmp", std::process::id())),
      "",
    )
    .unwrap();
    assert!(
      write_report(&root, &State::Held("fake")).is_err(),
      "create-new refuses the leftover"
    );
    assert_eq!(
      write_report(&root, &State::Held("fake")).expect("the next write"),
      path
    );
    assert_eq!(
      fs::read_dir(path.parent().unwrap()).unwrap().count(),
      1,
      "no temp file left"
    );
  }
}
