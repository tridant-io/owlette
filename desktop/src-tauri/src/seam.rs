//! The app's half of the daemon's privileged-request seam (macOS and Linux).
//!
//! Off Windows this app runs as the console user: it can neither use the token
//! store nor control the daemon, so pairing, leaving the site, restarting the
//! service or the machine, dismissing a pending reboot and filing a bug report
//! are requests it drops into `ipc/requests/` for the daemon to carry out
//! (`agent/src/configure_site.py`, "The privileged-request seam"). No sudo and
//! no prompt: a request is the app's because the console user owns it, nobody
//! else can write it, and it quotes the one-shot nonce the daemon last issued.
//!
//! A request is `{"verb", "nonce"}`, plus `server` on a `pair` and `category`
//! and `description` on a `report_issue`, written 0600 as `<id>.json.tmp` and
//! renamed into place — the daemon reads a `.json` the moment it appears. The
//! answer is `<id>.result`, the JSON-line protocol the
//! agent's headless modes write to stdout, read as it grows until a terminal
//! event (`authorized`, `done` or `error`). Only then is it removed: a `pair`
//! keeps writing into it for the ten minutes it polls.

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

pub const REQUESTS_REL: &str = "ipc/requests";
pub const NONCE_REL: &str = "ipc/request_nonce";

/// No group or world bit: the daemon refuses a request anyone else could have
/// rewritten after the app wrote it.
const REQUEST_MODE: u32 = 0o600;
/// The daemon drains the seam on its 5 s tick, so an answer that has not
/// started by now is a daemon that is not running.
const ANSWER_DEADLINE: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(200);
/// The daemon's answers are root's; anything else under the answer's name was
/// planted in the group-writable directory and is not read.
const DAEMON_UID: u32 = 0;
const TERMINAL_EVENTS: [&str; 3] = ["authorized", "done", "error"];

/// What the app may ask the daemon for — `configure_site.REQUEST_VERBS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
  Pair,
  CancelPair,
  Restart,
  Reboot,
  Leave,
  DismissReboot,
  ReportIssue,
}

impl Verb {
  pub fn name(self) -> &'static str {
    match self {
      Verb::Pair => "pair",
      Verb::CancelPair => "cancel_pair",
      Verb::Restart => "restart",
      Verb::Reboot => "reboot",
      Verb::Leave => "leave",
      Verb::DismissReboot => "dismiss_reboot",
      Verb::ReportIssue => "report_issue",
    }
  }

  /// How long a started answer may take to reach its terminal event. A pairing
  /// polls for ten minutes; a leave waits out the daemon's cloud client (60 s)
  /// and one Firestore delete; a dismissal starts an interpreter and makes one
  /// write; a report starts one, collects the logs and posts them. The rest
  /// answer at once.
  pub fn budget(self) -> Duration {
    match self {
      Verb::Pair => Duration::from_secs(660),
      Verb::Leave | Verb::ReportIssue => Duration::from_secs(180),
      Verb::DismissReboot => Duration::from_secs(90),
      Verb::CancelPair | Verb::Restart | Verb::Reboot => Duration::from_secs(30),
    }
  }
}

/// Held from reading the nonce until the daemon has answered, which is after it
/// rotated the nonce: two requests of this app's quoting one nonce would see
/// the second refused.
static ASKING: Mutex<()> = Mutex::new(());
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

pub struct Seam {
  root: PathBuf,
  daemon_uid: u32,
  answer_deadline: Duration,
}

impl Seam {
  pub fn new(root: PathBuf) -> Self {
    Self {
      root,
      daemon_uid: DAEMON_UID,
      answer_deadline: ANSWER_DEADLINE,
    }
  }

  /// Ask the daemon for `verb`, with `fields` (an object) beside the verb and
  /// the nonce, and wait for its answer, handing every line to `on_line` as it
  /// lands. The terminal event on success — which may itself be the daemon's
  /// `error`; `Err` means no answer at all.
  pub fn ask(
    &self,
    verb: Verb,
    fields: Option<&Value>,
    on_line: &mut dyn FnMut(&str),
  ) -> Result<Value, String> {
    self.ask_within(verb, fields, verb.budget(), on_line)
  }

  fn ask_within(
    &self,
    verb: Verb,
    fields: Option<&Value>,
    budget: Duration,
    on_line: &mut dyn FnMut(&str),
  ) -> Result<Value, String> {
    let requests = self.root.join(REQUESTS_REL);
    let id = request_id();
    let request = requests.join(format!("{id}.json"));
    let result = requests.join(format!("{id}.result"));

    let mut answer = {
      let _asking = ASKING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
      let nonce = self.nonce()?;
      // the verb and the nonce last, so no field can stand in for them.
      let mut body = match fields {
        Some(Value::Object(fields)) => Value::Object(fields.clone()),
        _ => json!({}),
      };
      body["verb"] = Value::from(verb.name());
      body["nonce"] = Value::from(nonce);
      write_request(&requests, &id, &body)?;
      match self.await_answer(&result) {
        Some(answer) => answer,
        None => {
          // unanswered, so nothing ever took it: a daemon started later must
          // not find a request nobody is waiting on any more.
          if let Err(error) = fs::remove_file(&request) {
            if error.kind() != ErrorKind::NotFound {
              log::warn!("could not withdraw {}: {error}", request.display());
            }
          }
          return Err(format!(
            "the owlette service did not answer within {}s — it may not be running",
            self.answer_deadline.as_secs()
          ));
        }
      }
    };

    let deadline = Instant::now() + budget;
    let mut pending = Vec::new();
    loop {
      if let Err(error) = answer.read_to_end(&mut pending) {
        return Err(format!("could not read the owlette service's answer: {error}"));
      }
      while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
        let line: Vec<u8> = pending.drain(..=end).collect();
        let line = String::from_utf8_lossy(&line);
        let line = line.trim();
        if line.is_empty() {
          continue;
        }
        on_line(line);
        if let Some(terminal) = terminal_event(line) {
          if let Err(error) = fs::remove_file(&result) {
            log::warn!("could not remove {}: {error}", result.display());
          }
          return Ok(terminal);
        }
      }
      if Instant::now() >= deadline {
        return Err(format!(
          "the owlette service did not finish the {} within {}s",
          verb.name(),
          budget.as_secs()
        ));
      }
      thread::sleep(POLL);
    }
  }

  /// The nonce the daemon last issued. Group-readable and root's to write.
  fn nonce(&self) -> Result<String, String> {
    let path = self.root.join(NONCE_REL);
    let nonce = fs::read_to_string(&path).map_err(|error| {
      format!(
        "could not read {} ({error}) — is the owlette service running, and is this user in its group?",
        path.display()
      )
    })?;
    let nonce = nonce.trim();
    if nonce.is_empty() {
      return Err("the owlette service has not issued a request nonce yet".to_string());
    }
    Ok(nonce.to_string())
  }

  /// The answer once the daemon has started it, opened at its start; None when
  /// it never did. Only a regular file the daemon owns counts — the directory is
  /// group-writable — and it is opened without following a link.
  fn await_answer(&self, result: &Path) -> Option<fs::File> {
    let deadline = Instant::now() + self.answer_deadline;
    loop {
      if let Ok(file) = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(result)
      {
        match file.metadata() {
          Ok(meta) if meta.is_file() && meta.uid() == self.daemon_uid => return Some(file),
          Ok(meta) => log::warn!(
            "ignoring {}: owned by uid {}, not the owlette service",
            result.display(),
            meta.uid()
          ),
          Err(error) => log::debug!("could not inspect {}: {error}", result.display()),
        }
      }
      if Instant::now() >= deadline {
        return None;
      }
      thread::sleep(POLL);
    }
  }
}

/// Unique for this app's lifetime and across restarts of it.
fn request_id() -> String {
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|elapsed| elapsed.as_nanos())
    .unwrap_or_default();
  format!(
    "{:x}-{:x}-{:x}",
    std::process::id(),
    nanos,
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
  )
}

/// Stage the request beside its final name and move it into place, so the
/// daemon never reads half of one.
fn write_request(requests: &Path, id: &str, body: &Value) -> Result<(), String> {
  let staged = requests.join(format!("{id}.json.tmp"));
  let placed = requests.join(format!("{id}.json"));
  let written = fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .mode(REQUEST_MODE)
    .custom_flags(libc::O_NOFOLLOW)
    .open(&staged)
    .and_then(|mut file| file.write_all(body.to_string().as_bytes()))
    .and_then(|()| fs::rename(&staged, &placed));
  written.map_err(|error| {
    let _ = fs::remove_file(&staged);
    format!("could not ask the owlette service ({}): {error}", requests.display())
  })
}

/// The event, when `line` is one that ends the answer.
fn terminal_event(line: &str) -> Option<Value> {
  let event: Value = serde_json::from_str(line).ok()?;
  let name = event.get("event")?.as_str()?;
  TERMINAL_EVENTS.contains(&name).then_some(event)
}

/// Whether a terminal event is the daemon refusing or failing.
pub fn is_error(terminal: &Value) -> bool {
  terminal.get("event").and_then(Value::as_str) == Some("error")
}

/// The message of an `error` event, or a fallback.
pub fn error_message(terminal: &Value) -> String {
  terminal
    .get("value")
    .and_then(Value::as_str)
    .unwrap_or("the owlette service refused the request")
    .to_string()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::os::unix::fs::PermissionsExt;

  /// A data root of this test's own, created fresh. Never removed recursively:
  /// each test takes the files it made with it, and the emptied tree goes with
  /// plain `remove_dir`.
  struct Root(PathBuf);

  impl Root {
    fn new(name: &str) -> Self {
      let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
      let root = std::env::temp_dir().join(format!("owlette-seam-{name}-{}-{nanos}", std::process::id()));
      fs::create_dir_all(root.join(REQUESTS_REL)).expect("scratch");
      fs::write(root.join(NONCE_REL), "n-1\n").expect("nonce");
      Self(root)
    }

    /// This test's account, standing in for root: the fake daemon writes as it.
    fn uid(&self) -> u32 {
      fs::metadata(&self.0).unwrap().uid()
    }

    fn seam(&self) -> Seam {
      Seam {
        root: self.0.clone(),
        daemon_uid: self.uid(),
        answer_deadline: Duration::from_secs(5),
      }
    }

    fn requests(&self) -> PathBuf {
      self.0.join(REQUESTS_REL)
    }

    fn entries(&self) -> Vec<String> {
      let mut names: Vec<String> = fs::read_dir(self.requests())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
      names.sort();
      names
    }
  }

  impl Drop for Root {
    fn drop(&mut self) {
      for name in self.entries() {
        let _ = fs::remove_file(self.requests().join(name));
      }
      let _ = fs::remove_file(self.0.join(NONCE_REL));
      let _ = fs::remove_dir(self.requests());
      let _ = fs::remove_dir(self.0.join("ipc"));
      let _ = fs::remove_dir(&self.0);
    }
  }

  /// What the daemon saw of one request.
  struct Seen {
    body: Value,
    mode: u32,
    uid: u32,
  }

  /// One protocol line per event, newline-terminated as the daemon writes it.
  fn lines(events: &[&str]) -> Vec<String> {
    events.iter().map(|event| format!("{event}\n")).collect()
  }

  /// The daemon's side, played by a thread: it takes the first `.json` that
  /// appears (never a `.json.tmp`), records what it read, removes it, rotates
  /// the nonce, and appends `chunks` to the answer verbatim, `gap` apart.
  fn fake_daemon(root: &Root, chunks: Vec<String>, gap: Duration) -> thread::JoinHandle<Seen> {
    let requests = root.requests();
    let nonce = root.0.join(NONCE_REL);
    thread::spawn(move || {
      let deadline = Instant::now() + Duration::from_secs(5);
      let name = loop {
        let found = fs::read_dir(&requests)
          .unwrap()
          .filter_map(|entry| entry.ok())
          .map(|entry| entry.file_name().to_string_lossy().into_owned())
          .find(|name| name.ends_with(".json"));
        if let Some(name) = found {
          break name;
        }
        assert!(Instant::now() < deadline, "no request arrived");
        thread::sleep(Duration::from_millis(20));
      };
      let path = requests.join(&name);
      let meta = fs::metadata(&path).unwrap();
      let seen = Seen {
        body: serde_json::from_slice(&fs::read(&path).unwrap()).unwrap(),
        mode: meta.permissions().mode() & 0o777,
        uid: meta.uid(),
      };
      fs::remove_file(&path).unwrap();
      fs::write(&nonce, "n-2\n").unwrap();
      let answer = requests.join(name.replace(".json", ".result"));
      let mut file = fs::OpenOptions::new().create(true).append(true).open(answer).unwrap();
      for chunk in chunks {
        thread::sleep(gap);
        file.write_all(chunk.as_bytes()).unwrap();
      }
      seen
    })
  }

  fn event_names(lines: &[String]) -> Vec<String> {
    lines
      .iter()
      .map(|line| serde_json::from_str::<Value>(line).unwrap()["event"].as_str().unwrap().to_string())
      .collect()
  }

  #[test]
  fn a_request_is_the_console_users_own_0600_and_quotes_the_nonce() {
    let root = Root::new("request");
    let daemon = fake_daemon(&root, lines(&[r#"{"event": "done", "value": {"restarting": true}}"#]), Duration::ZERO);

    let terminal = root.seam().ask(Verb::Restart, None, &mut |_| {}).expect("answered");

    let seen = daemon.join().unwrap();
    assert_eq!(seen.body, json!({ "verb": "restart", "nonce": "n-1" }));
    assert_eq!(seen.mode, 0o600);
    assert_eq!(seen.uid, root.uid());
    assert_eq!(terminal["event"], "done");
  }

  #[test]
  fn a_pair_names_its_server_and_streams_the_phrase_before_the_authorization() {
    let root = Root::new("pair");
    let daemon = fake_daemon(
      &root,
      lines(&[
        r#"{"event": "status", "value": "requesting a pairing phrase"}"#,
        r#"{"event": "phrase", "value": {"pairPhrase": "silver-compass-drift"}}"#,
        r#"{"event": "status", "value": "waiting for authorization"}"#,
        r#"{"event": "authorized", "value": {"siteId": "site-abc", "serviceRestarted": false}}"#,
      ]),
      Duration::from_millis(250),
    );
    let mut seen_lines = Vec::new();

    let terminal = root
      .seam()
      .ask(Verb::Pair, Some(&json!({ "server": "dev" })), &mut |line| {
        seen_lines.push(line.to_string())
      })
      .expect("answered");

    assert_eq!(daemon.join().unwrap().body, json!({ "verb": "pair", "nonce": "n-1", "server": "dev" }));
    assert_eq!(event_names(&seen_lines), ["status", "phrase", "status", "authorized"]);
    assert_eq!(terminal["value"]["siteId"], "site-abc");
  }

  #[test]
  fn a_report_carries_its_fields_but_never_in_place_of_the_verb_or_the_nonce() {
    let root = Root::new("report");
    let daemon = fake_daemon(&root, lines(&[r#"{"event": "done", "value": {"category": "bug"}}"#]), Duration::ZERO);
    let report = json!({ "category": "bug", "description": "it broke", "verb": "reboot", "nonce": "planted" });

    let terminal = root.seam().ask(Verb::ReportIssue, Some(&report), &mut |_| {}).expect("answered");

    assert_eq!(
      daemon.join().unwrap().body,
      json!({ "verb": "report_issue", "nonce": "n-1", "category": "bug", "description": "it broke" })
    );
    assert_eq!(terminal["event"], "done");
  }

  #[test]
  fn the_answer_is_removed_after_its_terminal_event_and_nothing_is_left_behind() {
    let root = Root::new("cleanup");
    let daemon = fake_daemon(
      &root,
      lines(&[
        r#"{"event": "status", "value": "deregistering this machine"}"#,
        r#"{"event": "error", "value": "could not deregister this machine: 403"}"#,
      ]),
      Duration::ZERO,
    );

    let terminal = root.seam().ask(Verb::Leave, None, &mut |_| {}).expect("answered");

    daemon.join().unwrap();
    assert!(is_error(&terminal));
    assert_eq!(error_message(&terminal), "could not deregister this machine: 403");
    assert!(root.entries().is_empty(), "left behind: {:?}", root.entries());
  }

  #[test]
  fn a_line_that_lands_in_two_appends_is_read_as_one() {
    let root = Root::new("partial");
    let chunks = vec![
      r#"{"event": "done", "#.to_string(),
      "\"value\": {\"rebooting\": true}}\n".to_string(),
    ];
    let daemon = fake_daemon(&root, chunks, Duration::from_millis(300));
    let mut seen_lines = Vec::new();

    let terminal = root
      .seam()
      .ask(Verb::Reboot, None, &mut |line| seen_lines.push(line.to_string()))
      .expect("answered");

    daemon.join().unwrap();
    assert_eq!(seen_lines.len(), 1);
    assert_eq!(terminal["value"]["rebooting"], true);
  }

  #[test]
  fn a_daemon_that_never_answers_is_said_plainly_and_the_request_is_withdrawn() {
    let root = Root::new("silent");
    let mut seam = root.seam();
    seam.answer_deadline = Duration::from_millis(400);

    let error = seam.ask(Verb::Restart, None, &mut |_| {}).expect_err("no daemon");

    assert!(error.contains("did not answer"), "{error}");
    assert!(root.entries().is_empty(), "left behind: {:?}", root.entries());
  }

  #[test]
  fn an_answer_the_daemon_does_not_own_is_never_read() {
    let root = Root::new("planted");
    let mut seam = root.seam();
    seam.daemon_uid = root.uid() + 1;
    seam.answer_deadline = Duration::from_millis(600);
    let daemon = fake_daemon(&root, lines(&[r#"{"event": "authorized", "value": {}}"#]), Duration::ZERO);
    let mut read = false;

    let outcome = seam.ask(Verb::Pair, None, &mut |_| read = true);

    daemon.join().unwrap();
    assert!(outcome.is_err());
    assert!(!read, "read an answer somebody else wrote");
  }

  #[test]
  fn an_answer_still_running_past_its_budget_is_left_for_the_daemon() {
    let root = Root::new("budget");
    let daemon = fake_daemon(
      &root,
      lines(&[r#"{"event": "status", "value": "waiting for authorization"}"#]),
      Duration::ZERO,
    );

    let error = root
      .seam()
      .ask_within(Verb::Pair, None, Duration::from_millis(500), &mut |_| {})
      .expect_err("never finished");

    daemon.join().unwrap();
    assert!(error.contains("did not finish the pair"), "{error}");
    // the pairing is still writing into it; removing it would take the
    // authorization with it.
    assert_eq!(root.entries().len(), 1);
    assert!(root.entries()[0].ends_with(".result"));
  }

  #[test]
  fn no_nonce_is_a_daemon_that_has_not_started_rather_than_a_hang() {
    let root = Root::new("nonce");
    fs::write(root.0.join(NONCE_REL), "").unwrap();

    let error = root.seam().ask(Verb::Leave, None, &mut |_| {}).expect_err("no nonce");

    assert!(error.contains("nonce"), "{error}");
    assert!(root.entries().is_empty());
  }

  #[test]
  fn every_verb_is_spelled_as_the_daemon_spells_it() {
    let names: Vec<&str> = [
      Verb::Pair,
      Verb::CancelPair,
      Verb::Restart,
      Verb::Reboot,
      Verb::Leave,
      Verb::DismissReboot,
    ]
    .iter()
    .map(|verb| verb.name())
    .collect();
    assert_eq!(names, ["pair", "cancel_pair", "restart", "reboot", "leave", "dismiss_reboot"]);
  }
}
