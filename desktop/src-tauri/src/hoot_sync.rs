//! Keeps the AI tools in step with this machine's hoot mcp grant.
//!
//! The service writes `ipc/fleet/state.json` from the server's answer; this polls it and adds hoot
//! to (or removes it from) every tool [`ai_tools`] finds for the signed-in user. The decisions are
//! pure functions so they are tested without the filesystem or Tauri; the thread and the commands
//! only feed them.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_cli;
use crate::ai_tools::{self, Env, Target, TOOLS};
use crate::paths;

pub const EVENT_TOOLS_SYNCED: &str = "hoot://tools-synced";

const STATE_REL: &str = "ipc/fleet/state.json";
const CHOICES_FILE: &str = "hoot_tools.json";
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

#[derive(Debug, PartialEq, Eq)]
enum Action {
  Add,
  Remove,
}

/// A tool that was found, and whether it already lists hoot.
struct Seen<'a> {
  id: &'a str,
  configured: bool,
}

/// What each found tool needs: hoot where it is granted and ticked and missing, nothing where it is
/// already right. A tool whose entry went stale in place is healed by removing and re-adding on
/// the next grant change, not here.
fn plan(granted: bool, off: &[String], seen: &[Seen]) -> Vec<(usize, Action)> {
  seen
    .iter()
    .enumerate()
    .filter_map(|(index, tool)| {
      let want = granted && !off.iter().any(|id| id == tool.id);
      match (want, tool.configured) {
        (true, false) => Some((index, Action::Add)),
        (false, true) => Some((index, Action::Remove)),
        _ => None,
      }
    })
    .collect()
}

/// The grant after the local hold, and the hold still standing. `None` grant means no state was
/// read and nothing is to change; a hold is an explicit off, so it answers even without a file.
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
  granted: bool,
  off: Vec<String>,
  at: Instant,
}

/// Whether the timer has reason to reconcile: nothing applied yet, the grant or the choices moved,
/// or it is time to heal.
fn due(applied: Option<&Applied>, granted: bool, off: &[String], now: Instant) -> bool {
  match applied {
    None => true,
    Some(done) => {
      done.granted != granted || done.off != off || now.duration_since(done.at) >= HEAL
    }
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
  error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Synced {
  granted: bool,
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

  fn effective_granted(&self) -> Option<bool> {
    let file = read_state(&self.root).map(|state| state.granted);
    let mut memory = self.memory();
    let (granted, hold) = resolve(file, memory.hold, Instant::now());
    memory.hold = hold;
    granted
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

  /// Treats the grant as off until the service says so, and removes hoot from the tools now.
  pub fn hold_off(&self, app: &AppHandle) {
    self.memory().hold = Some(Instant::now());
    self.reconcile(app, true);
  }

  fn reconcile(&self, app: &AppHandle, force: bool) {
    let _running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(command) = agent_cli::hoot_mcp_command() else { return };
    let (Some(python), Some(script)) = (command.first(), command.get(1)) else { return };
    let Some(granted) = self.effective_granted() else { return };
    let off = self.off();
    let now = Instant::now();
    if !force && !due(self.memory().applied.as_ref(), granted, &off, now) {
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

    let mut synced = Synced { granted, added: Vec::new(), removed: Vec::new(), failed: Vec::new() };
    for (index, action) in plan(granted, &off, &seen) {
      let target = &found[index].0;
      let label = target.tool.label;
      match action {
        Action::Add => match ai_tools::ensure(target, python, script) {
          Ok(()) => synced.added.push(label),
          Err(error) => synced.failed.push(Failed { label, error }),
        },
        Action::Remove => match ai_tools::remove(target) {
          Ok(()) => synced.removed.push(label),
          Err(error) => synced.failed.push(Failed { label, error }),
        },
      }
    }
    {
      let mut memory = self.memory();
      memory.applied = Some(Applied { granted, off, at: Instant::now() });
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
  let spawned = thread::Builder::new().name("hoot-sync".to_string()).spawn(move || loop {
    if let Some(sync) = handle.try_state::<HootSync>() {
      sync.reconcile(&handle, false);
    }
    thread::sleep(POLL);
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
  fn granted_and_ticked_adds_where_missing_and_leaves_what_is_there() {
    let tools = seen(&[("cursor", false), ("codex", true)]);
    assert_eq!(plan(true, &[], &tools), vec![(0, Action::Add)]);
  }

  #[test]
  fn not_granted_removes_ours_everywhere_it_is() {
    let tools = seen(&[("cursor", true), ("codex", false), ("gemini", true)]);
    assert_eq!(plan(false, &[], &tools), vec![(0, Action::Remove), (2, Action::Remove)]);
  }

  #[test]
  fn an_unticked_tool_is_removed_even_when_granted_and_never_added() {
    let tools = seen(&[("cursor", true), ("codex", false)]);
    assert_eq!(plan(true, &off(&["cursor", "codex"]), &tools), vec![(0, Action::Remove)]);
  }

  #[test]
  fn nothing_found_plans_nothing() {
    assert!(plan(true, &[], &[]).is_empty());
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
    let applied = Applied { granted: true, off: off(&["codex"]), at: now };
    let soon = now + Duration::from_secs(10);
    assert!(due(None, true, &[], soon));
    assert!(!due(Some(&applied), true, &off(&["codex"]), soon));
    assert!(due(Some(&applied), false, &off(&["codex"]), soon));
    assert!(due(Some(&applied), true, &[], soon));
    assert!(due(Some(&applied), true, &off(&["codex"]), now + HEAL));
  }

  #[test]
  fn a_persistent_failure_is_reported_once() {
    let failure = |label, error: &str| Failed { label, error: error.to_string() };
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
