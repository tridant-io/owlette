//! Lists hoot in the AI tools on this machine, and reads this machine's hoot mcp grant for the page.
//!
//! The service writes `ipc/fleet/state.json` from the server's answer. Once it has (the machine is
//! paired and the service has heard from the server), hoot is added to every tool [`ai_tools`]
//! finds for the signed-in user and the person has not unticked, allowed or not: a machine that
//! may not act gets hoot's reason and the admin link from the server itself, so an assistant can
//! say what to do. The decisions are pure functions so they are tested without the filesystem or
//! Tauri; the thread and the commands only feed them.
//!
//! Uninstalling owlette takes hoot out again. Only this user's own app may edit their tools (an
//! elevated uninstaller writing in a profile is open to a link swapped under it), so the
//! uninstaller writes `ipc/fleet/uninstalling` and each running app, seeing it, removes hoot from
//! every tool, ticked or not, and quits; the uninstaller waits for that.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_cli;
use crate::ai_tools::{self, Env, Target, TOOLS};
use crate::paths;

pub const EVENT_TOOLS_SYNCED: &str = "hoot://tools-synced";

const STATE_REL: &str = "ipc/fleet/state.json";
/// the uninstaller's marker (owlette_installer.iss, and the macOS steps in installation.mdx).
const UNINSTALL_MARKER_REL: &str = "ipc/fleet/uninstalling";
/// how long the marker is honoured, so an uninstall that died part way does not strip hoot and
/// quit the app at every relaunch from then on.
const UNINSTALL_FOR: Duration = Duration::from_secs(600);
const CHOICES_FILE: &str = "hoot_tools.json";
/// how often the timer looks for the marker; the uninstaller waits on it.
const WATCH: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_secs(10);
/// tools rewrite their own config; reconciling this often puts hoot back after they do.
const HEAL: Duration = Duration::from_secs(300);
/// how long a local off outlives the service's next answer before it is given up on.
const HOLD: Duration = Duration::from_secs(300);

/// What the service wrote; the same shape the page reads.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetState {
  pub granted: bool,
  #[serde(default)]
  pub max_tier: Option<i64>,
  #[serde(default)]
  pub whole_site: bool,
  #[serde(default)]
  pub machine_ids: Vec<String>,
  #[serde(default)]
  pub admin_url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Action {
  Add,
  Remove,
}

/// A tool that was found, and whether it already lists hoot.
struct Seen<'a> {
  id: &'a str,
  configured: bool,
}

/// What each found tool needs: hoot where it is ticked and missing, gone where it is unticked and
/// there, nothing where it is already right. A tool whose entry went stale in place is healed by
/// unticking and ticking it, not here.
fn plan(off: &[String], seen: &[Seen]) -> Vec<(usize, Action)> {
  seen
    .iter()
    .enumerate()
    .filter_map(|(index, tool)| {
      let want = !off.iter().any(|id| id == tool.id);
      match (want, tool.configured) {
        (true, false) => Some((index, Action::Add)),
        (false, true) => Some((index, Action::Remove)),
        _ => None,
      }
    })
    .collect()
}

/// The grant the page shows after the local hold, and the hold still standing. `None` grant means
/// no state was read; a hold is an explicit off, so it answers even without a file.
fn resolve(
  file: Option<bool>,
  hold: Option<Instant>,
  now: Instant,
) -> (Option<bool>, Option<Instant>) {
  match hold {
    Some(since) if file != Some(false) && now.duration_since(since) < HOLD => (Some(false), hold),
    _ => (file, None),
  }
}

struct Applied {
  off: Vec<String>,
  at: Instant,
}

/// Whether the timer has reason to reconcile: nothing applied yet, the choices moved, or it is
/// time to heal.
fn due(applied: Option<&Applied>, off: &[String], now: Instant) -> bool {
  match applied {
    None => true,
    Some(done) => done.off != off || now.duration_since(done.at) >= HEAL,
  }
}

/// The failures not already reported, and the failures now standing: a tool that stopped failing
/// drops out, so a later failure on it is news again.
fn fresh_failures(last: &mut Vec<Failed>, now: Vec<Failed>) -> Vec<Failed> {
  let fresh = now.iter().filter(|failure| !last.contains(failure)).cloned().collect();
  *last = now;
  fresh
}

fn read_state(root: &Path) -> Option<FleetState> {
  let bytes = fs::read(root.join(STATE_REL)).ok()?;
  serde_json::from_slice(&bytes).ok()
}

/// Whether owlette is being uninstalled: the uninstaller's marker, written within [`UNINSTALL_FOR`]
/// and, off Windows, by root. `ipc/fleet` is group-writable there, and another account in the group
/// must not quit this one's app; on Windows only SYSTEM and administrators can write it.
fn uninstalling(root: &Path) -> bool {
  fs::metadata(root.join(UNINSTALL_MARKER_REL)).is_ok_and(|meta| {
    written_by_root(&meta) && meta.modified().is_ok_and(|at| fresh(at, SystemTime::now()))
  })
}

fn fresh(written: SystemTime, now: SystemTime) -> bool {
  now.duration_since(written).is_ok_and(|age| age < UNINSTALL_FOR)
}

#[cfg(unix)]
fn written_by_root(meta: &fs::Metadata) -> bool {
  use std::os::unix::fs::MetadataExt;
  meta.uid() == 0
}

#[cfg(not(unix))]
fn written_by_root(_meta: &fs::Metadata) -> bool {
  true
}

#[derive(Serialize, Deserialize, Default)]
struct Choices {
  #[serde(default)]
  off: Vec<String>,
}

fn read_off(dir: &Path) -> Vec<String> {
  let mut off = fs::read(dir.join(CHOICES_FILE))
    .ok()
    .and_then(|bytes| serde_json::from_slice::<Choices>(&bytes).ok())
    .unwrap_or_default()
    .off;
  off.sort_unstable();
  off.dedup();
  off
}

fn write_off(dir: &Path, off: &[String]) -> Result<(), String> {
  fs::create_dir_all(dir).map_err(|error| format!("could not create {}: {error}", dir.display()))?;
  let body = serde_json::to_vec(&Choices { off: off.to_vec() }).map_err(|error| error.to_string())?;
  let path = dir.join(CHOICES_FILE);
  let temp = dir.join(format!("{CHOICES_FILE}.tmp"));
  fs::write(&temp, body).map_err(|error| format!("could not write {}: {error}", temp.display()))?;
  fs::rename(&temp, &path).map_err(|error| format!("could not write {}: {error}", path.display()))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HootTool {
  pub id: &'static str,
  pub label: &'static str,
  pub found: bool,
  pub on: bool,
  pub configured: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct Failed {
  label: &'static str,
  action: Action,
  error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Synced {
  added: Vec<&'static str>,
  removed: Vec<&'static str>,
  failed: Vec<Failed>,
}

#[derive(Default)]
struct Memory {
  hold: Option<Instant>,
  applied: Option<Applied>,
  /// the failures last emitted, so a persistent one toasts once, not at every heal.
  failed: Vec<Failed>,
}

pub struct HootSync {
  root: PathBuf,
  dir: Option<PathBuf>,
  memory: Mutex<Memory>,
  /// one reconcile at a time: a command's and the timer's must not run `ensure` / `remove` together.
  running: Mutex<()>,
}

impl HootSync {
  fn new(root: PathBuf, dir: Option<PathBuf>) -> Self {
    Self { root, dir, memory: Mutex::new(Memory::default()), running: Mutex::new(()) }
  }

  fn memory(&self) -> std::sync::MutexGuard<'_, Memory> {
    self.memory.lock().unwrap_or_else(PoisonError::into_inner)
  }

  fn off(&self) -> Vec<String> {
    self.dir.as_deref().map(read_off).unwrap_or_default()
  }

  /// The state file with `granted` as this machine acts on it, after the local hold.
  pub fn state(&self) -> Option<FleetState> {
    let mut state = read_state(&self.root)?;
    let mut memory = self.memory();
    let (granted, hold) = resolve(Some(state.granted), memory.hold, Instant::now());
    memory.hold = hold;
    state.granted = granted.unwrap_or(state.granted);
    Some(state)
  }

  /// The tools on this machine, ticked or not, for the settings page.
  pub fn tools(&self) -> Vec<HootTool> {
    let env = Env::current();
    let off = self.off();
    TOOLS
      .iter()
      .map(|tool| {
        let target = env.as_ref().and_then(|env| ai_tools::detect(tool, env));
        HootTool {
          id: tool.id,
          label: tool.label,
          found: target.is_some(),
          on: !off.iter().any(|id| id == tool.id),
          configured: target.as_ref().is_some_and(ai_tools::status),
        }
      })
      .collect()
  }

  pub fn set_tool(&self, app: &AppHandle, id: &str, on: bool) -> Result<(), String> {
    if !TOOLS.iter().any(|tool| tool.id == id) {
      return Err(format!("unknown ai tool: {id}"));
    }
    let dir = self.dir.as_deref().ok_or("could not find this user's app data folder")?;
    let mut off = read_off(dir);
    off.retain(|known| known != id);
    if !on {
      off.push(id.to_string());
      off.sort_unstable();
    }
    write_off(dir, &off)?;
    self.reconcile(app, true);
    Ok(())
  }

  /// Shows the grant as off until the service says so. hoot stays in the tools, where it now says
  /// it is off.
  pub fn hold_off(&self) {
    self.memory().hold = Some(Instant::now());
  }

  /// Takes hoot out of every tool it is in, ticked or not, and quits: owlette is being uninstalled.
  fn uninstall(&self, app: &AppHandle) {
    {
      let _running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
      if let Some(env) = Env::current() {
        for target in TOOLS.iter().filter_map(|tool| ai_tools::detect(tool, &env)) {
          if let Err(error) = ai_tools::remove(&target) {
            log::warn!("could not remove hoot from {}: {error}", target.tool.label);
          }
        }
      }
    }
    log::info!("owlette is being uninstalled: took hoot out of the ai tools it could, quitting");
    app.exit(0);
  }

  fn reconcile(&self, app: &AppHandle, force: bool) {
    let _running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
    // a tick from the page must not put hoot back while the timer is taking it out
    if uninstalling(&self.root) {
      return;
    }
    let Some(command) = agent_cli::hoot_mcp_command() else { return };
    let (Some(python), Some(script)) = (command.first(), command.get(1)) else { return };
    // no state file: the service has not heard from the server for this machine (not paired yet)
    if read_state(&self.root).is_none() {
      return;
    }
    let off = self.off();
    let now = Instant::now();
    if !force && !due(self.memory().applied.as_ref(), &off, now) {
      return;
    }
    let Some(env) = Env::current() else { return };

    let found: Vec<(Target, bool)> = TOOLS
      .iter()
      .filter_map(|tool| ai_tools::detect(tool, &env))
      .map(|target| {
        let configured = ai_tools::status(&target);
        (target, configured)
      })
      .collect();
    let seen: Vec<Seen> =
      found.iter().map(|(target, configured)| Seen { id: target.tool.id, configured: *configured }).collect();

    let mut synced = Synced { added: Vec::new(), removed: Vec::new(), failed: Vec::new() };
    for (index, action) in plan(&off, &seen) {
      let target = &found[index].0;
      let label = target.tool.label;
      let done = match action {
        Action::Add => ai_tools::ensure(target, python, script),
        Action::Remove => ai_tools::remove(target),
      };
      match (done, action) {
        (Ok(()), Action::Add) => synced.added.push(label),
        (Ok(()), Action::Remove) => synced.removed.push(label),
        (Err(error), _) => synced.failed.push(Failed { label, action, error }),
      }
    }
    {
      let mut memory = self.memory();
      memory.applied = Some(Applied { off, at: Instant::now() });
      synced.failed = fresh_failures(&mut memory.failed, synced.failed);
    }

    if !(synced.added.is_empty() && synced.removed.is_empty() && synced.failed.is_empty()) {
      if let Err(error) = app.emit(EVENT_TOOLS_SYNCED, &synced) {
        log::warn!("could not emit a tools-synced event: {error}");
      }
    }
  }
}

/// Manages the sync state and starts the timer. Called once from `setup`.
pub fn spawn(app: &AppHandle) {
  let dir = match app.path().app_data_dir() {
    Ok(dir) => Some(dir),
    Err(error) => {
      log::warn!("no app data folder for the hoot tool choices: {error}");
      None
    }
  };
  app.manage(HootSync::new(paths::data_root(), dir));

  let handle = app.clone();
  let spawned = thread::Builder::new().name("hoot-sync".to_string()).spawn(move || {
    let mut reconciled: Option<Instant> = None;
    loop {
      if let Some(sync) = handle.try_state::<HootSync>() {
        // first, so an app the service relaunches during an uninstall never adds hoot back
        if uninstalling(&sync.root) {
          sync.uninstall(&handle);
          return;
        }
        if reconciled.map_or(true, |at| at.elapsed() >= POLL) {
          sync.reconcile(&handle, false);
          reconciled = Some(Instant::now());
        }
      }
      thread::sleep(WATCH);
    }
  });
  if let Err(error) = spawned {
    log::warn!("could not start the hoot tool sync: {error}");
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn off(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| id.to_string()).collect()
  }

  fn seen<'a>(tools: &[(&'a str, bool)]) -> Vec<Seen<'a>> {
    tools.iter().map(|(id, configured)| Seen { id, configured: *configured }).collect()
  }

  fn temp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("owlette-hoot-sync-{tag}-{}", std::process::id()));
    fs::create_dir_all(&dir).expect("make the temp dir");
    dir
  }

  #[test]
  fn a_ticked_tool_gets_hoot_where_missing_and_keeps_what_is_there() {
    let tools = seen(&[("cursor", false), ("codex", true)]);
    assert_eq!(plan(&[], &tools), vec![(0, Action::Add)]);
  }

  #[test]
  fn an_unticked_tool_loses_hoot_where_it_is_and_never_gets_it() {
    let tools = seen(&[("cursor", true), ("codex", false), ("gemini", true)]);
    assert_eq!(plan(&off(&["cursor", "codex"]), &tools), vec![(0, Action::Remove)]);
  }

  #[test]
  fn nothing_found_plans_nothing() {
    assert!(plan(&[], &[]).is_empty());
  }

  #[test]
  fn a_failure_names_what_it_was_doing() {
    let failure = Failed { label: "vs code", action: Action::Remove, error: "locked".to_string() };
    assert_eq!(
      serde_json::to_value(&failure).expect("serialize"),
      serde_json::json!({ "label": "vs code", "action": "remove", "error": "locked" })
    );
  }

  #[test]
  fn no_state_means_no_decision() {
    let now = Instant::now();
    assert_eq!(resolve(None, None, now), (None, None));
  }

  #[test]
  fn the_file_decides_without_a_hold() {
    let now = Instant::now();
    assert_eq!(resolve(Some(true), None, now), (Some(true), None));
    assert_eq!(resolve(Some(false), None, now), (Some(false), None));
  }

  #[test]
  fn a_hold_keeps_the_grant_off_while_the_file_still_says_granted() {
    let now = Instant::now();
    let (granted, hold) = resolve(Some(true), Some(now), now + Duration::from_secs(60));
    assert_eq!(granted, Some(false));
    assert_eq!(hold, Some(now));
    // and with no file at all: a hold is an explicit off.
    assert_eq!(resolve(None, Some(now), now).0, Some(false));
  }

  #[test]
  fn a_hold_ends_when_the_file_says_false() {
    let now = Instant::now();
    assert_eq!(resolve(Some(false), Some(now), now + Duration::from_secs(5)), (Some(false), None));
  }

  #[test]
  fn a_hold_expires_and_the_file_wins_again() {
    let now = Instant::now();
    let later = now + HOLD;
    assert_eq!(resolve(Some(true), Some(now), later), (Some(true), None));
    assert_eq!(resolve(None, Some(now), later), (None, None));
  }

  #[test]
  fn the_timer_reconciles_on_a_change_or_to_heal_and_otherwise_not() {
    let now = Instant::now();
    let applied = Applied { off: off(&["codex"]), at: now };
    let soon = now + Duration::from_secs(10);
    assert!(due(None, &[], soon));
    assert!(!due(Some(&applied), &off(&["codex"]), soon));
    assert!(due(Some(&applied), &[], soon));
    assert!(due(Some(&applied), &off(&["codex"]), now + HEAL));
  }

  #[test]
  fn a_persistent_failure_is_reported_once() {
    let failure = |label, error: &str| Failed { label, action: Action::Add, error: error.to_string() };
    let mut last = Vec::new();
    let first = fresh_failures(&mut last, vec![failure("vs code", "a")]);
    assert_eq!(first, vec![failure("vs code", "a")]);
    assert!(fresh_failures(&mut last, vec![failure("vs code", "a")]).is_empty());
    // a different error on the same tool is news
    assert_eq!(fresh_failures(&mut last, vec![failure("vs code", "b")]).len(), 1);
    // it succeeds, then fails again: reported again
    assert!(fresh_failures(&mut last, Vec::new()).is_empty());
    assert_eq!(fresh_failures(&mut last, vec![failure("vs code", "b")]).len(), 1);
  }

  #[test]
  fn the_choices_file_round_trips_sorted_and_deduplicated() {
    let dir = temp("choices");
    assert!(read_off(&dir).is_empty());
    write_off(&dir, &off(&["vscode", "codex", "codex"])).expect("write");
    assert_eq!(read_off(&dir), off(&["codex", "vscode"]));
    write_off(&dir, &[]).expect("write empty");
    assert!(read_off(&dir).is_empty());
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn an_unreadable_choices_file_defaults_to_every_tool_on() {
    let dir = temp("choices-bad");
    fs::write(dir.join(CHOICES_FILE), "not json").expect("write");
    assert!(read_off(&dir).is_empty());
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn the_uninstall_marker_counts_only_while_it_is_fresh() {
    let now = SystemTime::now();
    assert!(fresh(now - Duration::from_secs(5), now));
    assert!(!fresh(now - UNINSTALL_FOR - Duration::from_secs(1), now));
    // a clock set back since it was written: not fresh, so it cannot hold the app down for good
    assert!(!fresh(now + Duration::from_secs(60), now));
  }

  #[test]
  fn the_uninstall_marker_counts_once_written_and_off_windows_only_from_root() {
    let root = temp("uninstalling");
    assert!(!uninstalling(&root));
    let dir = root.join("ipc").join("fleet");
    fs::create_dir_all(&dir).expect("make the dir");
    let marker = dir.join("uninstalling");
    fs::write(&marker, "").expect("write");
    let meta = fs::metadata(&marker).expect("stat");
    // this test writes it as whoever runs it: root, or a member of the group
    assert_eq!(uninstalling(&root), written_by_root(&meta));
    #[cfg(windows)]
    assert!(uninstalling(&root));
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn the_state_file_parses_and_a_missing_or_broken_one_is_no_state() {
    let root = temp("state");
    assert_eq!(read_state(&root), None);
    let dir = root.join("ipc").join("fleet");
    fs::create_dir_all(&dir).expect("make the dir");
    fs::write(dir.join("state.json"), "{ nope").expect("write");
    assert_eq!(read_state(&root), None);
    fs::write(
      dir.join("state.json"),
      r#"{"granted":true,"maxTier":2,"wholeSite":false,"machineIds":["a"],"adminUrl":"https://x/y"}"#,
    )
    .expect("write");
    assert_eq!(
      read_state(&root),
      Some(FleetState {
        granted: true,
        max_tier: Some(2),
        whole_site: false,
        machine_ids: vec!["a".to_string()],
        admin_url: Some("https://x/y".to_string()),
      })
    );
    fs::write(dir.join("state.json"), r#"{"granted":false,"maxTier":null,"adminUrl":null}"#).expect("write");
    assert_eq!(read_state(&root).map(|state| state.granted), Some(false));
    let _ = fs::remove_dir_all(&root);
  }
}
