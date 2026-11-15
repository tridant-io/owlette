//! The AI tools hoot mcp can be added to, and how each one's user-level config is edited.
//!
//! Pure and Tauri-free: every function takes the directories it needs in an [`Env`], so tests
//! run against temp dirs and never the real home. Only an entry named `hoot` whose args point at
//! `fleet_mcp.py` is ours; a different `hoot` is reported and left alone, and a file that does not
//! parse is never rewritten.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// The server name every tool lists us under.
const SERVER: &str = "hoot";

/// What marks an entry as ours: its args point at this script.
const SCRIPT_NAME: &str = "fleet_mcp.py";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `claude mcp add` writes `~/.claude.json` and can wait on its lock; past this it is stuck.
const CLI_TIMEOUT: Duration = Duration::from_secs(20);

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
  Windows,
  Macos,
  Linux,
}

impl Platform {
  pub(crate) fn current() -> Self {
    if cfg!(windows) {
      Self::Windows
    } else if cfg!(target_os = "macos") {
      Self::Macos
    } else {
      Self::Linux
    }
  }
}

/// The directories the table is resolved against.
pub(crate) struct Env {
  pub platform: Platform,
  pub home: PathBuf,
  pub appdata: Option<PathBuf>,
  pub localappdata: Option<PathBuf>,
  pub codex_home: Option<PathBuf>,
  pub path_dirs: Vec<PathBuf>,
}

impl Env {
  pub(crate) fn current() -> Option<Self> {
    let platform = Platform::current();
    let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    let home = var(if platform == Platform::Windows { "USERPROFILE" } else { "HOME" })?;
    Some(Self {
      platform,
      home,
      appdata: var("APPDATA"),
      localappdata: var("LOCALAPPDATA"),
      codex_home: var("CODEX_HOME"),
      path_dirs: std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default(),
    })
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
  /// Added and removed through the `claude` binary; it rewrites its own file constantly.
  Cli,
  Json { section: &'static str, typed: bool },
  Toml,
}

pub(crate) struct ToolDef {
  pub id: &'static str,
  pub label: &'static str,
  kind: Kind,
}

pub(crate) const TOOLS: &[ToolDef] = &[
  ToolDef { id: "claude-code", label: "claude code", kind: Kind::Cli },
  ToolDef { id: "claude-desktop", label: "claude desktop", kind: Kind::Json { section: "mcpServers", typed: false } },
  ToolDef { id: "cursor", label: "cursor", kind: Kind::Json { section: "mcpServers", typed: true } },
  ToolDef { id: "vscode", label: "vs code", kind: Kind::Json { section: "servers", typed: true } },
  ToolDef { id: "windsurf", label: "windsurf", kind: Kind::Json { section: "mcpServers", typed: false } },
  ToolDef { id: "gemini", label: "gemini cli", kind: Kind::Json { section: "mcpServers", typed: false } },
  ToolDef { id: "codex", label: "codex", kind: Kind::Toml },
];

/// A tool found on this machine.
pub(crate) struct Target {
  pub tool: &'static ToolDef,
  place: Place,
}

enum Place {
  /// Config files that exist in a directory that exists; one per location (Claude Desktop has two).
  Files(Vec<PathBuf>),
  Cli { binary: PathBuf, state: PathBuf },
}

/// Runs the resolved `claude` binary with an argv; a function so tests never spawn it.
pub(crate) type Runner<'a> = &'a dyn Fn(&Path, &[String]) -> Result<(), String>;

pub(crate) fn detect(tool: &'static ToolDef, env: &Env) -> Option<Target> {
  let place = match tool.kind {
    Kind::Cli => Place::Cli {
      binary: find_claude(env)?,
      state: env.home.join(".claude.json"),
    },
    _ => {
      let files: Vec<PathBuf> = config_files(tool, env)
        .into_iter()
        .filter(|f| f.parent().is_some_and(Path::is_dir))
        .collect();
      if files.is_empty() {
        return None;
      }
      Place::Files(files)
    }
  };
  Some(Target { tool, place })
}

/// Whether every location holds our entry.
pub(crate) fn status(target: &Target) -> bool {
  match (&target.place, target.tool.kind) {
    (Place::Cli { state, .. }, _) => read_json(state)
      .ok()
      .flatten()
      .and_then(|root| root.get("mcpServers")?.get(SERVER).map(is_ours))
      .unwrap_or(false),
    (Place::Files(files), Kind::Json { section, .. }) => files.iter().all(|f| {
      read_json(f)
        .ok()
        .flatten()
        .and_then(|root| root.get(section)?.get(SERVER).map(is_ours))
        .unwrap_or(false)
    }),
    (Place::Files(files), _) => files.iter().all(|f| {
      read_text(f).ok().is_some_and(|text| matches!(codex_find(&text), Some(true)))
    }),
  }
}

pub(crate) fn ensure(target: &Target, python: &str, script: &str) -> Result<(), String> {
  ensure_with(target, python, script, &spawn)
}

pub(crate) fn remove(target: &Target) -> Result<(), String> {
  remove_with(target, &spawn)
}

fn ensure_with(target: &Target, python: &str, script: &str, run: Runner) -> Result<(), String> {
  match (&target.place, target.tool.kind) {
    (Place::Cli { binary, state }, _) => {
      let existing = read_json(state)?
        .and_then(|root| root.get("mcpServers")?.get(SERVER).cloned());
      match existing {
        Some(entry) if !is_ours(&entry) => return Err(foreign(target)),
        Some(entry) if is_same(&entry, python, script) => return Ok(()),
        Some(_) => run(binary, &["mcp".into(), "remove".into(), "-s".into(), "user".into(), SERVER.into()])?,
        None => {}
      }
      run(
        binary,
        &["mcp", "add", "-s", "user", SERVER, "--", python, script].map(String::from),
      )
    }
    (Place::Files(files), Kind::Json { section, typed }) => {
      each(files, |f| json_ensure(f, section, typed, python, script, target))
    }
    (Place::Files(files), _) => each(files, |f| codex_ensure(f, python, script, target)),
  }
}

fn remove_with(target: &Target, run: Runner) -> Result<(), String> {
  match (&target.place, target.tool.kind) {
    (Place::Cli { binary, state }, _) => {
      let existing = read_json(state)?
        .and_then(|root| root.get("mcpServers")?.get(SERVER).cloned());
      match existing {
        None => Ok(()),
        Some(entry) if !is_ours(&entry) => Err(foreign(target)),
        Some(_) => run(binary, &["mcp", "remove", "-s", "user", SERVER].map(String::from)),
      }
    }
    (Place::Files(files), Kind::Json { section, .. }) => {
      each(files, |f| json_remove(f, section, target))
    }
    (Place::Files(files), _) => each(files, |f| codex_remove(f, target)),
  }
}

/// Every location is attempted so one bad file does not strand the other; the first error wins.
fn each(files: &[PathBuf], mut f: impl FnMut(&Path) -> Result<(), String>) -> Result<(), String> {
  let mut first = None;
  for file in files {
    if let Err(error) = f(file) {
      first.get_or_insert(error);
    }
  }
  first.map_or(Ok(()), Err)
}

fn foreign(target: &Target) -> String {
  format!("a different {SERVER} is configured in {}", target.tool.label)
}

fn is_ours(entry: &Value) -> bool {
  entry
    .get("args")
    .and_then(Value::as_array)
    .is_some_and(|args| args.iter().any(|a| a.as_str().is_some_and(|s| s.ends_with(SCRIPT_NAME))))
}

fn is_same(entry: &Value, python: &str, script: &str) -> bool {
  entry.get("command").and_then(Value::as_str) == Some(python)
    && entry.get("args") == Some(&json!([script]))
}

// ---- where each tool keeps its config ----

fn config_files(tool: &ToolDef, env: &Env) -> Vec<PathBuf> {
  let win = env.platform == Platform::Windows;
  let support = || env.home.join("Library").join("Application Support");
  // vs code and claude desktop share one layout: <config root>/<app>/...
  let root = |app: &str| -> Option<PathBuf> {
    match env.platform {
      Platform::Windows => env.appdata.as_ref().map(|a| a.join(app)),
      Platform::Macos => Some(support().join(app)),
      Platform::Linux => Some(env.home.join(".config").join(app)),
    }
  };
  match tool.id {
    "claude-desktop" => {
      let mut files: Vec<PathBuf> = root("Claude")
        .map(|d| d.join("claude_desktop_config.json"))
        .into_iter()
        .collect();
      if win {
        // the store build reads a virtualised copy of %APPDATA%
        if let Some(packages) = env.localappdata.as_ref().map(|l| l.join("Packages")) {
          let mut found: Vec<PathBuf> = fs::read_dir(packages)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("Claude_"))
            .map(|e| {
              e.path()
                .join("LocalCache")
                .join("Roaming")
                .join("Claude")
                .join("claude_desktop_config.json")
            })
            .collect();
          found.sort();
          files.extend(found);
        }
      }
      files
    }
    "vscode" => root("Code").map(|d| d.join("User").join("mcp.json")).into_iter().collect(),
    "cursor" => vec![env.home.join(".cursor").join("mcp.json")],
    "windsurf" => vec![env.home.join(".codeium").join("windsurf").join("mcp_config.json")],
    "gemini" => vec![env.home.join(".gemini").join("settings.json")],
    "codex" => {
      let dir = env.codex_home.clone().unwrap_or_else(|| env.home.join(".codex"));
      vec![dir.join("config.toml")]
    }
    _ => Vec::new(),
  }
}

/// The `claude` binary: PATH first, then the install dirs a GUI app does not inherit.
fn find_claude(env: &Env) -> Option<PathBuf> {
  let names: &[&str] = if env.platform == Platform::Windows {
    &["claude.exe", "claude.cmd"]
  } else {
    &["claude"]
  };
  let known: Vec<PathBuf> = match env.platform {
    Platform::Windows => {
      let mut known = vec![env.home.join(".local").join("bin").join("claude.exe")];
      known.extend(env.appdata.as_ref().map(|a| a.join("npm").join("claude.cmd")));
      known
    }
    _ => vec![
      env.home.join(".local").join("bin").join("claude"),
      PathBuf::from("/usr/local/bin/claude"),
      PathBuf::from("/opt/homebrew/bin/claude"),
      env.home.join(".npm-global").join("bin").join("claude"),
    ],
  };
  env
    .path_dirs
    .iter()
    .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
    .chain(known)
    .find(|p| p.is_file())
}

// ---- json tools ----

fn json_ensure(
  path: &Path,
  section: &str,
  typed: bool,
  python: &str,
  script: &str,
  target: &Target,
) -> Result<(), String> {
  let mut root = read_json(path)?.unwrap_or_else(|| Value::Object(Map::new()));
  let servers = root
    .as_object_mut()
    .ok_or_else(|| unreadable(path))?
    .entry(section)
    .or_insert_with(|| Value::Object(Map::new()))
    .as_object_mut()
    .ok_or_else(|| unreadable(path))?;
  if let Some(existing) = servers.get(SERVER) {
    if !is_ours(existing) {
      return Err(foreign(target));
    }
    if is_same(existing, python, script) && (!typed || existing.get("type").is_some()) {
      return Ok(());
    }
  }
  let mut entry = Map::new();
  if typed {
    entry.insert("type".into(), json!("stdio"));
  }
  entry.insert("command".into(), json!(python));
  entry.insert("args".into(), json!([script]));
  servers.insert(SERVER.into(), Value::Object(entry));
  write_json(path, &root)
}

fn json_remove(path: &Path, section: &str, target: &Target) -> Result<(), String> {
  let Some(mut root) = read_json(path)? else {
    return Ok(());
  };
  let Some(top) = root.as_object_mut() else {
    return Err(unreadable(path));
  };
  let Some(servers) = top.get_mut(section).and_then(Value::as_object_mut) else {
    return Ok(());
  };
  match servers.get(SERVER) {
    None => return Ok(()),
    Some(entry) if !is_ours(entry) => return Err(foreign(target)),
    Some(_) => {}
  }
  servers.shift_remove(SERVER);
  write_json(path, &root)
}

/// `None` for a missing file; an error for one that does not parse (comments included).
fn read_json(path: &Path) -> Result<Option<Value>, String> {
  match fs::read_to_string(path) {
    Ok(text) => serde_json::from_str(&text).map(Some).map_err(|_| unreadable(path)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(_) => Err(unreadable(path)),
  }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
  let mut text = serde_json::to_string_pretty(value).map_err(|_| unreadable(path))?;
  text.push('\n');
  write_atomic(path, &text)
}

fn unreadable(path: &Path) -> String {
  format!("could not read {}", path.display())
}

/// Temp file beside the target, then a rename, so a reader never sees half a config. A symlinked
/// config is written through to its target and an existing file keeps its permissions.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
  let fail = |_| format!("could not write {}", path.display());
  let real = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
  let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  let temp = real.with_file_name(format!(
    ".{name}.{}-{}.tmp",
    std::process::id(),
    TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
  ));
  let written = fs::File::create(&temp)
    .and_then(|mut f| f.write_all(text.as_bytes()).and_then(|()| f.sync_all()))
    .and_then(|()| match fs::metadata(&real) {
      Ok(meta) => fs::set_permissions(&temp, meta.permissions()),
      Err(_) => Ok(()),
    })
    .and_then(|()| fs::rename(&temp, &real));
  if written.is_err() {
    let _ = fs::remove_file(&temp);
  }
  written.map_err(fail)
}

// ---- codex ----

fn read_text(path: &Path) -> Result<String, String> {
  match fs::read_to_string(path) {
    Ok(text) => Ok(text),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
    Err(_) => Err(unreadable(path)),
  }
}

fn is_header(line: &str) -> bool {
  line.trim_start().starts_with('[')
}

/// Whether a header opens `[mcp_servers.hoot]` or one of its sub-tables.
fn is_hoot_header(line: &str) -> bool {
  let name = line.trim().trim_matches(|c| c == '[' || c == ']').trim();
  name == "mcp_servers.hoot" || name.starts_with("mcp_servers.hoot.")
}

/// `None` with no hoot table; otherwise whether the main table is ours.
fn codex_find(text: &str) -> Option<bool> {
  let mut found = false;
  let mut ours = false;
  let mut inside_main = false;
  for line in text.lines() {
    if is_header(line) {
      found |= is_hoot_header(line);
      inside_main = line.trim().trim_matches(|c| c == '[' || c == ']').trim() == "mcp_servers.hoot";
    } else if inside_main && line.contains(SCRIPT_NAME) {
      ours = true;
    }
  }
  found.then_some(ours)
}

/// The text without the hoot table and its sub-tables, blank lines included, so what preceded it
/// keeps its own spacing and nothing piles up.
fn codex_strip(text: &str) -> String {
  let mut out = String::new();
  let mut dropping = false;
  for line in text.split_inclusive('\n') {
    if is_header(line) {
      dropping = is_hoot_header(line);
    }
    if !dropping {
      out.push_str(line);
    }
  }
  out
}

fn codex_ensure(path: &Path, python: &str, script: &str, target: &Target) -> Result<(), String> {
  for value in [python, script] {
    if value.contains('\'') || value.contains('\n') {
      return Err(format!("could not write {}: the path has a quote in it", path.display()));
    }
  }
  let text = read_text(path)?;
  if codex_find(&text) == Some(false) {
    return Err(foreign(target));
  }
  let mut out = codex_strip(&text).trim_end().to_string();
  if !out.is_empty() {
    out.push_str("\n\n");
  }
  out.push_str(&format!("[mcp_servers.{SERVER}]\ncommand = '{python}'\nargs = ['{script}']\n"));
  if out == text {
    return Ok(());
  }
  write_atomic(path, &out)
}

fn codex_remove(path: &Path, target: &Target) -> Result<(), String> {
  let text = read_text(path)?;
  match codex_find(&text) {
    None => Ok(()),
    Some(false) => Err(foreign(target)),
    Some(true) => {
      let kept = codex_strip(&text);
      let kept = kept.trim_end();
      write_atomic(path, &if kept.is_empty() { String::new() } else { format!("{kept}\n") })
    }
  }
}

// ---- spawning ----

fn spawn(binary: &Path, args: &[String]) -> Result<(), String> {
  let is_shim = binary.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd"));
  let mut command = if is_shim {
    let mut c = Command::new("cmd");
    c.arg("/c").arg(binary);
    c
  } else {
    Command::new(binary)
  };
  command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
  #[cfg(windows)]
  command.creation_flags(CREATE_NO_WINDOW);
  let mut child = command.spawn().map_err(|e| format!("could not start claude: {e}"))?;
  let deadline = Instant::now() + CLI_TIMEOUT;
  loop {
    match child.try_wait() {
      Ok(Some(status)) if status.success() => return Ok(()),
      Ok(Some(status)) => return Err(format!("claude mcp failed ({status})")),
      Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
      Ok(None) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err("claude mcp timed out".to_string());
      }
      Err(e) => return Err(format!("could not wait for claude: {e}")),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::RefCell;

  const PY: &str = r"C:\Owlette\python\python.exe";
  const SCRIPT: &str = r"C:\Owlette\agent\src\fleet_mcp.py";

  fn tool(id: &str) -> &'static ToolDef {
    TOOLS.iter().find(|t| t.id == id).expect("tool in the table")
  }

  /// A fresh home with appdata and localappdata beside it.
  fn env(tag: &str, platform: Platform) -> Env {
    let root = std::env::temp_dir().join(format!(
      "owlette-ai-tools-{tag}-{}-{}",
      std::process::id(),
      TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let home = root.join("home");
    let appdata = root.join("appdata");
    let localappdata = root.join("local");
    for d in [&home, &appdata, &localappdata] {
      fs::create_dir_all(d).expect("make dir");
    }
    Env {
      platform,
      home,
      appdata: Some(appdata),
      localappdata: Some(localappdata),
      codex_home: None,
      path_dirs: Vec::new(),
    }
  }

  fn mkdir(path: &Path) {
    fs::create_dir_all(path).expect("make dir");
  }

  fn target(id: &str, env: &Env) -> Target {
    detect(tool(id), env).unwrap_or_else(|| panic!("{id} detected"))
  }

  fn no_run(_: &Path, _: &[String]) -> Result<(), String> {
    panic!("must not spawn");
  }

  #[test]
  fn json_tools_round_trip_and_keep_other_keys() {
    let cases = [
      ("cursor", ".cursor/mcp.json", "mcpServers", true),
      ("windsurf", ".codeium/windsurf/mcp_config.json", "mcpServers", false),
      ("gemini", ".gemini/settings.json", "mcpServers", false),
    ];
    for (id, rel, section, typed) in cases {
      let env = env(id, Platform::Windows);
      let file = env.home.join(rel);
      mkdir(file.parent().unwrap());
      fs::write(
        &file,
        format!(r#"{{"theme":"dark","{section}":{{"other":{{"command":"x"}}}},"last":1}}"#),
      )
      .unwrap();
      let t = target(id, &env);
      assert!(!status(&t));
      ensure(&t, PY, SCRIPT).unwrap();
      assert!(status(&t));
      let v: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
      assert_eq!(v["theme"], "dark");
      assert_eq!(v["last"], 1);
      assert_eq!(v[section]["other"]["command"], "x");
      assert_eq!(v[section]["hoot"]["command"], PY);
      assert_eq!(v[section]["hoot"]["args"], json!([SCRIPT]));
      assert_eq!(v[section]["hoot"].get("type").is_some(), typed);
      let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
      assert_eq!(keys, ["theme", section, "last"]);
      remove(&t).unwrap();
      assert!(!status(&t));
      let v: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
      assert!(v[section].get("hoot").is_none());
      assert_eq!(v[section]["other"]["command"], "x");
    }
  }

  #[test]
  fn vscode_uses_servers_with_a_stdio_type_on_every_platform() {
    for (platform, rel) in [
      (Platform::Windows, "appdata/Code/User/mcp.json"),
      (Platform::Macos, "home/Library/Application Support/Code/User/mcp.json"),
      (Platform::Linux, "home/.config/Code/User/mcp.json"),
    ] {
      let env = env("vscode", platform);
      let file = env.home.parent().unwrap().join(rel);
      mkdir(file.parent().unwrap());
      let t = target("vscode", &env);
      ensure(&t, PY, SCRIPT).unwrap();
      let v: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
      assert_eq!(v["servers"]["hoot"]["type"], "stdio");
      assert!(status(&t));
      remove(&t).unwrap();
      assert!(!status(&t));
    }
  }

  #[test]
  fn a_missing_file_is_created_but_a_missing_tool_dir_is_not_detected() {
    let env = env("missing", Platform::Windows);
    assert!(detect(tool("cursor"), &env).is_none());
    mkdir(&env.home.join(".cursor"));
    let t = target("cursor", &env);
    ensure(&t, PY, SCRIPT).unwrap();
    assert!(env.home.join(".cursor/mcp.json").is_file());
    assert!(status(&t));
  }

  #[test]
  fn unparseable_and_jsonc_files_are_left_byte_identical() {
    let env = env("bad", Platform::Windows);
    let dir = env.appdata.as_ref().unwrap().join("Code").join("User");
    mkdir(&dir);
    let file = dir.join("mcp.json");
    for body in ["{ not json", "{\n  // a comment\n  \"servers\": {}\n}", "[1, 2]"] {
      fs::write(&file, body).unwrap();
      let t = target("vscode", &env);
      let err = ensure(&t, PY, SCRIPT).unwrap_err();
      assert_eq!(err, format!("could not read {}", file.display()));
      assert!(remove(&t).is_err());
      assert!(!status(&t));
      assert_eq!(fs::read_to_string(&file).unwrap(), body);
    }
  }

  #[test]
  fn a_different_hoot_is_never_touched() {
    let env = env("foreign", Platform::Windows);
    mkdir(&env.home.join(".cursor"));
    let file = env.home.join(".cursor/mcp.json");
    let body = r#"{"mcpServers":{"hoot":{"command":"node","args":["theirs.js"]}}}"#;
    fs::write(&file, body).unwrap();
    let t = target("cursor", &env);
    assert_eq!(ensure(&t, PY, SCRIPT).unwrap_err(), "a different hoot is configured in cursor");
    assert_eq!(remove(&t).unwrap_err(), "a different hoot is configured in cursor");
    assert!(!status(&t));
    assert_eq!(fs::read_to_string(&file).unwrap(), body);
  }

  #[test]
  fn our_entry_with_a_stale_command_is_replaced() {
    let env = env("stale", Platform::Windows);
    mkdir(&env.home.join(".gemini"));
    let file = env.home.join(".gemini/settings.json");
    fs::write(
      &file,
      r#"{"mcpServers":{"hoot":{"command":"old","args":["D:\\old\\fleet_mcp.py"]}}}"#,
    )
    .unwrap();
    let t = target("gemini", &env);
    assert!(status(&t));
    ensure(&t, PY, SCRIPT).unwrap();
    let v: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(v["mcpServers"]["hoot"]["command"], PY);
    assert_eq!(v["mcpServers"]["hoot"]["args"], json!([SCRIPT]));
  }

  /// None when this box will not make a symlink (windows without developer mode).
  fn link(target: &Path, link: &Path) -> Option<()> {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(target, link);
    match made {
      Ok(()) => Some(()),
      Err(e) => {
        println!("skipping: cannot create a symlink here: {e}");
        None
      }
    }
  }

  #[test]
  fn a_symlinked_config_stays_a_link_and_its_target_gets_the_entry() {
    let env = env("symlink", Platform::Macos);
    mkdir(&env.home.join(".gemini"));
    let dotfiles = env.home.join("dotfiles");
    mkdir(&dotfiles);
    let real = dotfiles.join("settings.json");
    fs::write(&real, r#"{"theme":"dark"}"#).unwrap();
    let file = env.home.join(".gemini/settings.json");
    if link(&real, &file).is_none() {
      return;
    }
    ensure(&target("gemini", &env), PY, SCRIPT).unwrap();
    assert!(fs::symlink_metadata(&file).unwrap().file_type().is_symlink());
    let v: Value = serde_json::from_str(&fs::read_to_string(&real).unwrap()).unwrap();
    assert_eq!(v["theme"], "dark");
    assert_eq!(v["mcpServers"]["hoot"]["command"], PY);
  }

  #[cfg(unix)]
  #[test]
  fn a_private_config_stays_private() {
    use std::os::unix::fs::PermissionsExt;
    let env = env("mode", Platform::Macos);
    mkdir(&env.home.join(".gemini"));
    let file = env.home.join(".gemini/settings.json");
    fs::write(&file, "{}").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    ensure(&target("gemini", &env), PY, SCRIPT).unwrap();
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
  }

  #[test]
  fn claude_desktop_yields_every_existing_location() {
    let env = env("desktop", Platform::Windows);
    assert!(detect(tool("claude-desktop"), &env).is_none());
    let plain = env.appdata.as_ref().unwrap().join("Claude");
    let store = |pkg: &str| {
      env
        .localappdata
        .as_ref()
        .unwrap()
        .join("Packages")
        .join(pkg)
        .join("LocalCache/Roaming/Claude")
    };
    mkdir(&plain);
    mkdir(&store("Claude_pzs8sxrjxfjjc"));
    // a package of another app, and a Claude package with no config dir yet
    mkdir(&env.localappdata.as_ref().unwrap().join("Packages").join("Other_abc"));
    mkdir(&env.localappdata.as_ref().unwrap().join("Packages").join("Claude_empty"));
    let t = target("claude-desktop", &env);
    let Place::Files(files) = &t.place else { panic!("files") };
    assert_eq!(files.len(), 2);
    ensure(&t, PY, SCRIPT).unwrap();
    assert!(plain.join("claude_desktop_config.json").is_file());
    assert!(store("Claude_pzs8sxrjxfjjc").join("claude_desktop_config.json").is_file());
    assert!(status(&t));
    remove(&t).unwrap();
    assert!(!status(&t));
  }

  #[test]
  fn claude_desktop_paths_on_mac_and_linux() {
    let env = env("desktop-mac", Platform::Macos);
    mkdir(&env.home.join("Library/Application Support/Claude"));
    assert!(detect(tool("claude-desktop"), &env).is_some());
    let env = env_linux();
    assert!(detect(tool("claude-desktop"), &env).is_none());
    mkdir(&env.home.join(".config/Claude"));
    assert!(detect(tool("claude-desktop"), &env).is_some());
  }

  fn env_linux() -> Env {
    env("desktop-linux", Platform::Linux)
  }

  #[test]
  fn codex_table_is_replaced_with_its_sub_tables_and_neighbours_kept() {
    let mut env = env("codex", Platform::Windows);
    let dir = env.home.join(".codex");
    mkdir(&dir);
    let file = dir.join("config.toml");
    fs::write(
      &file,
      "# my settings\nmodel = \"x\"\n\n[mcp_servers.other]\ncommand = 'o'\n\n\
       [mcp_servers.hoot]\ncommand = 'old'\nargs = ['D:\\old\\fleet_mcp.py']\n\n\
       [mcp_servers.hoot.env]\nA = \"1\"\n\n[profiles.p]\nmodel = \"y\"\n",
    )
    .unwrap();
    let t = target("codex", &env);
    assert!(status(&t));
    ensure(&t, PY, SCRIPT).unwrap();
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("# my settings\nmodel = \"x\"\n\n[mcp_servers.other]\ncommand = 'o'\n"));
    assert!(text.contains("[profiles.p]\nmodel = \"y\"\n"));
    assert!(!text.contains("old"));
    assert!(!text.contains("hoot.env"));
    assert_eq!(text.matches("[mcp_servers.hoot]").count(), 1);
    assert!(text.ends_with(&format!(
      "[mcp_servers.hoot]\ncommand = '{PY}'\nargs = ['{SCRIPT}']\n"
    )));
    assert!(status(&t));
    // a second ensure changes nothing
    ensure(&t, PY, SCRIPT).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), text);
    remove(&t).unwrap();
    assert!(!status(&t));
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("[mcp_servers.other]") && text.contains("[profiles.p]"));
    assert!(!text.contains("hoot"));
    // CODEX_HOME wins over ~/.codex
    let elsewhere = env.home.join("codex-home");
    mkdir(&elsewhere);
    env.codex_home = Some(elsewhere.clone());
    ensure(&target("codex", &env), PY, SCRIPT).unwrap();
    assert!(elsewhere.join("config.toml").is_file());
  }

  #[test]
  fn codex_creates_a_missing_file_refuses_quotes_and_foreign_tables() {
    let env = env("codex2", Platform::Windows);
    let dir = env.home.join(".codex");
    mkdir(&dir);
    let t = target("codex", &env);
    ensure(&t, PY, SCRIPT).unwrap();
    assert_eq!(
      fs::read_to_string(dir.join("config.toml")).unwrap(),
      format!("[mcp_servers.hoot]\ncommand = '{PY}'\nargs = ['{SCRIPT}']\n")
    );
    assert!(ensure(&t, "it's", SCRIPT).is_err());

    let body = "[mcp_servers.hoot]\ncommand = 'theirs'\n";
    fs::write(dir.join("config.toml"), body).unwrap();
    assert_eq!(ensure(&t, PY, SCRIPT).unwrap_err(), "a different hoot is configured in codex");
    assert_eq!(remove(&t).unwrap_err(), "a different hoot is configured in codex");
    assert_eq!(fs::read_to_string(dir.join("config.toml")).unwrap(), body);
  }

  /// Records every argv instead of spawning.
  fn recorder(calls: &RefCell<Vec<Vec<String>>>) -> impl Fn(&Path, &[String]) -> Result<(), String> + '_ {
    |_, args| {
      calls.borrow_mut().push(args.to_vec());
      Ok(())
    }
  }

  fn claude_env(tag: &str) -> (Env, PathBuf) {
    let mut env = env(tag, Platform::Windows);
    let bin = env.home.join(".local").join("bin");
    mkdir(&bin);
    fs::write(bin.join("claude.exe"), "").unwrap();
    env.path_dirs = Vec::new();
    let state = env.home.join(".claude.json");
    (env, state)
  }

  #[test]
  fn claude_code_adds_removes_and_replaces_through_the_binary() {
    let (env, state) = claude_env("cc");
    let t = target("claude-code", &env);
    let calls = RefCell::new(Vec::new());
    assert!(!status(&t));

    ensure_with(&t, PY, SCRIPT, &recorder(&calls)).unwrap();
    assert_eq!(calls.borrow()[0], ["mcp", "add", "-s", "user", "hoot", "--", PY, SCRIPT]);

    fs::write(
      &state,
      format!(r#"{{"x":1,"mcpServers":{{"hoot":{{"command":"{}","args":["{}"]}}}}}}"#,
        PY.replace('\\', "\\\\"), SCRIPT.replace('\\', "\\\\")),
    )
    .unwrap();
    assert!(status(&t));
    // already the same: nothing to run
    ensure_with(&t, PY, SCRIPT, &no_run).unwrap();
    // ours but another command: remove then add
    calls.borrow_mut().clear();
    ensure_with(&t, "other.exe", SCRIPT, &recorder(&calls)).unwrap();
    assert_eq!(calls.borrow().len(), 2);
    assert_eq!(calls.borrow()[0], ["mcp", "remove", "-s", "user", "hoot"]);
    assert_eq!(calls.borrow()[1][5..], ["--", "other.exe", SCRIPT]);

    calls.borrow_mut().clear();
    remove_with(&t, &recorder(&calls)).unwrap();
    assert_eq!(calls.borrow()[0], ["mcp", "remove", "-s", "user", "hoot"]);
  }

  #[test]
  fn claude_code_leaves_a_foreign_or_unreadable_state_alone() {
    let (env, state) = claude_env("cc2");
    let t = target("claude-code", &env);
    fs::write(&state, r#"{"mcpServers":{"hoot":{"command":"node","args":["a.js"]}}}"#).unwrap();
    assert_eq!(
      ensure_with(&t, PY, SCRIPT, &no_run).unwrap_err(),
      "a different hoot is configured in claude code"
    );
    assert!(remove_with(&t, &no_run).is_err());
    fs::write(&state, "{ broken").unwrap();
    assert_eq!(
      ensure_with(&t, PY, SCRIPT, &no_run).unwrap_err(),
      format!("could not read {}", state.display())
    );
    // nothing configured: remove is a no-op without a spawn
    fs::remove_file(&state).unwrap();
    remove_with(&t, &no_run).unwrap();
  }

  #[test]
  fn claude_binary_resolution_order() {
    let mut env = env("bin", Platform::Windows);
    assert!(detect(tool("claude-code"), &env).is_none());

    let npm = env.appdata.as_ref().unwrap().join("npm");
    mkdir(&npm);
    fs::write(npm.join("claude.cmd"), "").unwrap();
    let Place::Cli { binary, .. } = &target("claude-code", &env).place else { panic!("cli") };
    assert_eq!(binary, &npm.join("claude.cmd"));

    let local = env.home.join(".local").join("bin");
    mkdir(&local);
    fs::write(local.join("claude.exe"), "").unwrap();
    let Place::Cli { binary, .. } = &target("claude-code", &env).place else { panic!("cli") };
    assert_eq!(binary, &local.join("claude.exe"));

    let on_path = env.home.join("onpath");
    mkdir(&on_path);
    fs::write(on_path.join("claude.cmd"), "").unwrap();
    fs::write(on_path.join("claude.exe"), "").unwrap();
    env.path_dirs = vec![on_path.clone()];
    let Place::Cli { binary, .. } = &target("claude-code", &env).place else { panic!("cli") };
    assert_eq!(binary, &on_path.join("claude.exe"));

    let mut mac = self::env("bin-mac", Platform::Macos);
    let dir = mac.home.join(".npm-global").join("bin");
    mkdir(&dir);
    fs::write(dir.join("claude"), "").unwrap();
    let Place::Cli { binary, .. } = &target("claude-code", &mac).place else { panic!("cli") };
    assert_eq!(binary, &dir.join("claude"));
    let local = mac.home.join(".local").join("bin");
    mkdir(&local);
    fs::write(local.join("claude"), "").unwrap();
    let Place::Cli { binary, .. } = &target("claude-code", &mac).place else { panic!("cli") };
    assert_eq!(binary, &local.join("claude"));
    mac.path_dirs = Vec::new();
  }
}
