//! Lock-protected JSON reads and writes against the owlette data tree.
//!
//! Desktop side of the service↔GUI seam: exactly reimplements the Python contract for
//! `config.json` / `app_states.json` — the cross-process lock plus atomic temp-file-and-rename
//! (`agent/src/shared_utils.py`: `_CrossProcessLock` :153, `read_json_from_file` :2126,
//! `write_json_to_file` :2177) — so both processes stay interoperable in the field. The lock is
//! the `Global\OwletteJsonFileMutex` named mutex on Windows and `flock(2)` on
//! `<data_root>/tmp/json.lock` off it, which is the identity the python writer takes there.
//!
//! Two deliberate deviations, both fail-safer than Python:
//!
//! * Unparseable content is retried then errors, where Python returns `{}` — handing a UI an
//!   empty document that it writes back would erase the operator's configuration.
//! * Temp files are unique per process and call, not a fixed `<name>.tmp`, so two writers can
//!   never share a scratch file.

use std::fmt;
use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};

#[cfg(windows)]
use std::sync::OnceLock;
#[cfg(windows)]
use windows::core::{w, PCWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0};
#[cfg(windows)]
use windows::Win32::System::Threading::{
  CreateMutexW, OpenMutexW, ReleaseMutex, WaitForSingleObject, MUTEX_MODIFY_STATE,
  SYNCHRONIZATION_SYNCHRONIZE,
};

#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::io::AsRawFd;

/// Name of the cross-process mutex. Byte-identical to the Python constant —
/// a typo here silently disables all coordination.
#[cfg(windows)]
const MUTEX_NAME: PCWSTR = w!("Global\\OwletteJsonFileMutex");

/// Wait budget for the mutex, mirroring `_CrossProcessLock(timeout_ms=2000)`.
#[cfg(windows)]
const MUTEX_WAIT_MS: u32 = 2000;

/// The lock file under the data root: `shared_utils.JSON_LOCK_FILE`.
#[cfg(unix)]
const LOCK_FILE_REL: &str = "tmp/json.lock";

/// Mode the lock file is created at when the installer has not pre-created it,
/// matching `shared_utils._JSON_LOCK_MODE`: a 0640 lock file is one this app —
/// the console user, reaching the tree through the group — could not take.
#[cfg(unix)]
const LOCK_FILE_MODE: u32 = 0o660;

/// The mutex's budget, and the retry step `shared_utils` waits out:
/// `flock(2)` has no timeout of its own, so the wait is `LOCK_NB` plus a retry
/// rather than a blocking `LOCK_EX` that a writer which died holding the lock
/// would stall for good.
#[cfg(unix)]
const LOCK_WAIT: Duration = Duration::from_millis(2000);
#[cfg(unix)]
const LOCK_RETRY: Duration = Duration::from_millis(10);

/// Mode a scratch file is created at before it takes on the destination's own,
/// matching `shared_utils.open_new_file`.
#[cfg(unix)]
const TEMP_FILE_MODE: u32 = 0o600;

/// Mirrors Python `max_retries=3` / `initial_delay=0.1` exponential backoff (100/200 ms).
const MAX_ATTEMPTS: u32 = 3;
const INITIAL_BACKOFF: Duration = Duration::from_millis(100);

/// Python uses `json.dump(..., indent=4)`; matching it keeps on-disk bytes stable whichever
/// process writes last.
const INDENT: &[u8] = b"    ";

/// Serial for temp file names — concurrent writes in this process must not share a scratch file.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Process-wide mutex handle, held for process lifetime like Python's `_json_file_mutex`.
#[cfg(windows)]
static JSON_MUTEX: OnceLock<Option<SharedMutex>> = OnceLock::new();

#[cfg(windows)]
struct SharedMutex(HANDLE);

// SAFETY: a mutex HANDLE is a kernel handle, valid process-wide and usable from any thread. Lock
// *ownership* is per-thread, which is why `LockGuard` is !Send; the handle itself need not be.
#[cfg(windows)]
unsafe impl Send for SharedMutex {}
#[cfg(windows)]
unsafe impl Sync for SharedMutex {}

/// How the cross-process lock behaved for one operation; surfaced to the frontend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LockOutcome {
  /// The lock was held for the whole operation.
  Acquired,
  /// Windows only: the previous owner died without releasing. We own it and must release, as
  /// Python's `WAIT_ABANDONED` branch does. `flock(2)` has no equivalent — a dead holder's
  /// descriptor is closed by the kernel, which releases the lock outright.
  Abandoned,
  /// 2 s budget elapsed. Proceeds unlocked, matching Python: the write is still atomic, so the
  /// worst case is a lost update, never a torn file.
  Timeout,
  /// Could not be created or opened at all (Python sets `_json_file_mutex = False`, or logs the
  /// lock file it could not open, and proceeds the same way).
  Unavailable,
}

impl LockOutcome {
  /// True when the operation ran without the cross-process lock held.
  pub fn is_unprotected(self) -> bool {
    matches!(self, LockOutcome::Timeout | LockOutcome::Unavailable)
  }
}

/// Result of a successful [`write_json`].
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
  pub lock: LockOutcome,
  /// Time spent waiting on the mutex.
  pub waited_ms: u64,
  /// Attempts used, 1 on the happy path.
  pub attempts: u32,
  /// Bytes written to disk.
  pub bytes: u64,
}

#[derive(Debug)]
pub enum JsonIoError {
  Io {
    path: PathBuf,
    source: std::io::Error,
  },
  Parse {
    path: PathBuf,
    detail: String,
  },
  Encode(serde_json::Error),
}

impl fmt::Display for JsonIoError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      JsonIoError::Io { path, source } => write!(f, "{}: {source}", path.display()),
      JsonIoError::Parse { path, detail } => {
        write!(f, "{} contains invalid JSON: {detail}", path.display())
      }
      JsonIoError::Encode(source) => write!(f, "could not encode JSON: {source}"),
    }
  }
}

impl std::error::Error for JsonIoError {
  fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
    match self {
      JsonIoError::Io { source, .. } => Some(source),
      JsonIoError::Encode(source) => Some(source),
      JsonIoError::Parse { .. } => None,
    }
  }
}

/// Read a JSON document under the cross-process lock.
///
/// Missing or empty yields `{}`, matching `read_json_from_file` — the service creates
/// `app_states.json` lazily and the UI must render before it exists. Unreadable or unparseable
/// content is retried, then errors (see the module note).
pub fn read_json(path: &Path) -> Result<Value, JsonIoError> {
  let guard = acquire_lock();
  guard.warn_if_unprotected(path, "read");

  let mut backoff = INITIAL_BACKOFF;
  let mut last_error: Option<JsonIoError> = None;

  for attempt in 1..=MAX_ATTEMPTS {
    match fs::read_to_string(path) {
      Ok(text) => {
        if text.trim().is_empty() {
          return Ok(Value::Object(Map::new()));
        }
        match serde_json::from_str::<Value>(&text) {
          Ok(value) => return Ok(value),
          Err(err) => {
            // Most likely a read landing mid-rename; retry before giving up.
            last_error = Some(JsonIoError::Parse {
              path: path.to_path_buf(),
              detail: err.to_string(),
            });
          }
        }
      }
      Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Value::Object(Map::new())),
      Err(err) => {
        last_error = Some(JsonIoError::Io {
          path: path.to_path_buf(),
          source: err,
        });
      }
    }

    if attempt < MAX_ATTEMPTS {
      thread::sleep(backoff);
      backoff *= 2;
    }
  }

  Err(last_error.expect("a failed attempt always records an error"))
}

/// Write a JSON document atomically under the cross-process lock.
///
/// Serialised before the lock is taken, to keep the window the service waits on short. The temp
/// file lives in the destination directory so the rename stays on one volume, hence atomic.
pub fn write_json(path: &Path, value: &Value) -> Result<WriteOutcome, JsonIoError> {
  let text = to_pretty_json(value)?;

  let parent = path
    .parent()
    .filter(|parent| !parent.as_os_str().is_empty());
  match parent {
    Some(parent) if parent.is_dir() => {}
    Some(parent) => {
      return Err(JsonIoError::Io {
        path: parent.to_path_buf(),
        source: std::io::Error::new(ErrorKind::NotFound, "directory does not exist"),
      })
    }
    None => {
      return Err(JsonIoError::Io {
        path: path.to_path_buf(),
        source: std::io::Error::new(ErrorKind::InvalidInput, "path has no parent directory"),
      })
    }
  }

  let guard = acquire_lock();
  guard.warn_if_unprotected(path, "write");

  let mut backoff = INITIAL_BACKOFF;
  let mut last_error: Option<JsonIoError> = None;

  for attempt in 1..=MAX_ATTEMPTS {
    let temp = temp_path(path);
    match write_then_rename(&temp, path, text.as_bytes()) {
      Ok(()) => {
        return Ok(WriteOutcome {
          lock: guard.outcome,
          waited_ms: guard.waited.as_millis() as u64,
          attempts: attempt,
          bytes: text.len() as u64,
        })
      }
      Err(err) => {
        // A partial or unrenamed scratch file must not linger next to the real one, where the
        // service's directory watcher would see it.
        let _ = fs::remove_file(&temp);
        last_error = Some(err);
      }
    }

    if attempt < MAX_ATTEMPTS {
      thread::sleep(backoff);
      backoff *= 2;
    }
  }

  Err(last_error.expect("a failed attempt always records an error"))
}

/// Serialise in Python's `indent=4` shape so desktop and service writes produce identical bytes.
///
/// Including line endings: `write_json_to_file` opens the scratch file in text mode, which on
/// Windows lands every `\n` as `\r\n` and off it leaves the byte alone. serde_json emits bare
/// `\n`, so only the Windows arm translates. Safe there as a blanket replace — the encoder
/// escapes literal newlines inside strings as `\\n`.
fn to_pretty_json(value: &Value) -> Result<String, JsonIoError> {
  let mut buffer = Vec::new();
  let formatter = serde_json::ser::PrettyFormatter::with_indent(INDENT);
  let mut serializer = serde_json::Serializer::with_formatter(&mut buffer, formatter);
  value
    .serialize(&mut serializer)
    .map_err(JsonIoError::Encode)?;
  // serde_json only ever emits UTF-8.
  let text = String::from_utf8(buffer).expect("serde_json emits valid utf-8");
  #[cfg(windows)]
  let text = text.replace('\n', "\r\n");
  Ok(text)
}

fn temp_path(path: &Path) -> PathBuf {
  let file_name = path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| "owlette".to_string());
  let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
  path.with_file_name(format!("{file_name}.{}.{seq}.tmp", std::process::id()))
}

fn write_then_rename(temp: &Path, dest: &Path, bytes: &[u8]) -> Result<(), JsonIoError> {
  let io_err = |path: &Path, source: std::io::Error| JsonIoError::Io {
    path: path.to_path_buf(),
    source,
  };

  {
    let mut file = create_temp(temp).map_err(|err| io_err(temp, err))?;
    #[cfg(unix)]
    carry_file_identity(&file, dest);
    file.write_all(bytes).map_err(|err| io_err(temp, err))?;
    // Flush before rename: a kiosk losing power mid-write must not come back with an empty
    // present config.json.
    file.sync_all().map_err(|err| io_err(temp, err))?;
  }

  // On Windows: MoveFileEx(MOVEFILE_REPLACE_EXISTING), same atomic replace as Python's os.replace.
  fs::rename(temp, dest).map_err(|err| io_err(dest, err))
}

/// The scratch file to write. The name is this process's own, so on Windows the
/// directory's ACL is the whole boundary and a plain create is enough.
#[cfg(windows)]
fn create_temp(temp: &Path) -> std::io::Result<File> {
  File::create(temp)
}

/// The scratch file to write, created the way `shared_utils.open_new_file`
/// creates it: `config/` and `tmp/` are group-writable off Windows, so a name
/// this process is about to write is one another member of the group can occupy
/// first. A stale scratch file from a killed write is removed, `create_new`
/// refuses anything still under the name, and `O_NOFOLLOW` refuses a link
/// planted in the race — which `rename` would otherwise move over the
/// destination.
#[cfg(unix)]
fn create_temp(temp: &Path) -> std::io::Result<File> {
  match fs::remove_file(temp) {
    Ok(()) => {}
    Err(error) if error.kind() == ErrorKind::NotFound => {}
    Err(error) => return Err(error),
  }
  OpenOptions::new()
    .write(true)
    .create_new(true)
    .mode(TEMP_FILE_MODE)
    .custom_flags(libc::O_NOFOLLOW)
    .open(temp)
}

/// Carry the destination's mode and group onto its replacement, as
/// `shared_utils._carry_file_identity` does for the same files.
///
/// Applied to the descriptor rather than the name: the scratch file sits in a
/// group-writable directory, so a path-based chmod is one more thing that can
/// be redirected between the write and the replace. Without it every desktop
/// write would leave `config.json` at this process's umask and drop the group
/// access the data-root mode table grants — 0660 root:<group> — until the next
/// service start put it back.
#[cfg(unix)]
fn carry_file_identity(file: &File, dest: &Path) {
  let existing = fs::symlink_metadata(dest)
    .ok()
    .filter(|meta| meta.is_file());
  let (mode, gid) = match existing {
    // 0o777 and not 0o7777: a setuid or setgid bit on the destination is not
    // one to carry onto a file this process wrote.
    Some(meta) => (meta.mode() & 0o777, meta.gid()),
    // Nothing to carry: a file written for the first time takes the access its
    // directory grants, which is `_seed_file_identity`'s rule.
    None => match dest.parent().and_then(|parent| fs::metadata(parent).ok()) {
      // 0o020 rather than `libc::S_IWGRP`, whose type is not the same width on both platforms.
      Some(parent) if parent.mode() & 0o020 != 0 => (0o660, parent.gid()),
      _ => return,
    },
  };

  if let Err(error) = file.set_permissions(fs::Permissions::from_mode(mode)) {
    log::debug!(
      "could not carry {}'s mode onto its replacement: {error}",
      dest.display()
    );
    return;
  }
  let owned = match file.metadata() {
    Ok(meta) => meta.gid() == gid,
    Err(_) => false,
  };
  // SAFETY: a descriptor this process opened, and -1 for the uid leaves the
  // owner alone — the only change asked for is the group, which the console
  // user may make to a group it belongs to.
  if !owned && unsafe { libc::fchown(file.as_raw_fd(), u32::MAX, gid) } != 0 {
    log::debug!(
      "could not give {}'s replacement to group {gid}: {}",
      dest.display(),
      std::io::Error::last_os_error()
    );
  }
}

/// RAII holder for the cross-process lock.
///
/// !Send by construction: Windows mutex ownership is per-thread, so the waiting thread must be the
/// releasing thread. Every caller does acquire → operate → drop in one synchronous body, which
/// holds even though commands run on async worker threads.
struct LockGuard {
  /// `Some` only when we own the mutex and therefore owe a release.
  #[cfg(windows)]
  handle: Option<HANDLE>,
  /// `Some` only when the `flock` was taken and is therefore ours to release.
  #[cfg(unix)]
  file: Option<File>,
  outcome: LockOutcome,
  waited: Duration,
  _not_send: PhantomData<*const ()>,
}

impl LockGuard {
  fn warn_if_unprotected(&self, path: &Path, operation: &str) {
    if self.outcome.is_unprotected() {
      log::warn!(
        "owlette json {operation} on {} proceeding without the cross-process lock ({:?} after {} ms)",
        path.display(),
        self.outcome,
        self.waited.as_millis()
      );
    }
  }
}

#[cfg(windows)]
impl Drop for LockGuard {
  fn drop(&mut self) {
    if let Some(handle) = self.handle {
      // SAFETY: we own the mutex (wait returned owned or abandoned), released on the same thread.
      unsafe {
        let _ = ReleaseMutex(handle);
      }
    }
  }
}

/// Release the `flock` before the descriptor closes, as `_release_flock` does.
/// Closing would release it too; unlocking first keeps the two writers' code
/// reading the same way.
#[cfg(unix)]
impl Drop for LockGuard {
  fn drop(&mut self) {
    if let Some(file) = self.file.take() {
      // SAFETY: a descriptor this guard owns, and this process holds the lock on it.
      if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) } != 0 {
        log::debug!(
          "cross-process json lock release failed: {}",
          std::io::Error::last_os_error()
        );
      }
    }
  }
}

#[cfg(windows)]
fn acquire_lock() -> LockGuard {
  let started = Instant::now();

  let Some(handle) = json_mutex() else {
    return LockGuard {
      handle: None,
      outcome: LockOutcome::Unavailable,
      waited: started.elapsed(),
      _not_send: PhantomData,
    };
  };

  // SAFETY: `handle` is a live mutex handle owned by this process for its lifetime.
  let result = unsafe { WaitForSingleObject(handle, MUTEX_WAIT_MS) };
  let waited = started.elapsed();

  if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED {
    let outcome = if result == WAIT_ABANDONED {
      LockOutcome::Abandoned
    } else {
      LockOutcome::Acquired
    };
    LockGuard {
      handle: Some(handle),
      outcome,
      waited,
      _not_send: PhantomData,
    }
  } else {
    // WAIT_TIMEOUT or WAIT_FAILED: we do not own the mutex, so we must not release it.
    LockGuard {
      handle: None,
      outcome: LockOutcome::Timeout,
      waited,
      _not_send: PhantomData,
    }
  }
}

/// The lock the python writer takes for the same files: `flock(2)` on
/// `<data_root>/tmp/json.lock`, which the installer pre-creates and either
/// writer creates 0660 when it has not.
#[cfg(unix)]
fn acquire_lock() -> LockGuard {
  acquire_lock_at(&crate::paths::data_root().join(LOCK_FILE_REL), LOCK_WAIT)
}

/// `acquire_lock`'s work against a named lock file and budget, so the identity
/// can be exercised without the machine's own data root.
#[cfg(unix)]
fn acquire_lock_at(path: &Path, wait: Duration) -> LockGuard {
  let started = Instant::now();

  let file = match open_lock_file(path) {
    Ok(file) => file,
    Err(error) => {
      log::debug!(
        "cross-process json lock unavailable ({}: {error}) — proceeding unlocked",
        path.display()
      );
      return LockGuard {
        file: None,
        outcome: LockOutcome::Unavailable,
        waited: started.elapsed(),
        _not_send: PhantomData,
      };
    }
  };

  let deadline = started + wait;
  loop {
    // SAFETY: a descriptor this function owns; `LOCK_NB` cannot block.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
      return LockGuard {
        file: Some(file),
        outcome: LockOutcome::Acquired,
        waited: started.elapsed(),
        _not_send: PhantomData,
      };
    }
    if Instant::now() >= deadline {
      return LockGuard {
        file: None,
        outcome: LockOutcome::Timeout,
        waited: started.elapsed(),
        _not_send: PhantomData,
      };
    }
    thread::sleep(LOCK_RETRY);
  }
}

/// A descriptor on the lock file, creating it at `LOCK_FILE_MODE` when it is
/// not there yet — the mode is set explicitly rather than left to this
/// process's umask, which would otherwise decide whether the other writer can
/// take the lock at all. `tmp/` is group-writable by design, so an entry
/// already under the name is opened only when it is a file of its own:
/// `shared_utils._open_existing_lock_file` refuses the same link.
#[cfg(unix)]
fn open_lock_file(path: &Path) -> std::io::Result<File> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }
  match OpenOptions::new()
    .read(true)
    .write(true)
    .create_new(true)
    .mode(LOCK_FILE_MODE)
    .open(path)
  {
    Ok(file) => {
      file.set_permissions(fs::Permissions::from_mode(LOCK_FILE_MODE))?;
      return Ok(file);
    }
    Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
    Err(error) => return Err(error),
  }

  let file = OpenOptions::new()
    .read(true)
    .write(true)
    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
    .open(path)?;
  if !file.metadata()?.is_file() {
    return Err(std::io::Error::new(
      ErrorKind::InvalidInput,
      "the json lock is not a regular file",
    ));
  }
  Ok(file)
}

#[cfg(windows)]
fn json_mutex() -> Option<HANDLE> {
  JSON_MUTEX
    .get_or_init(|| {
      // SAFETY: both calls take a static wide string; no pointers are retained by the OS.
      unsafe {
        match CreateMutexW(None, false, MUTEX_NAME) {
          Ok(handle) => Some(SharedMutex(handle)),
          Err(create_error) => {
            // Expected when the service got there first: its descriptor
            // (`shared_utils._JSON_MUTEX_SDDL`) grants Authenticated Users only
            // SYNCHRONIZE | MUTEX_MODIFY_STATE while CreateMutexW asks for MUTEX_ALL_ACCESS.
            // Opening with just those two rights is the intended path; python has the same
            // fallback.
            match OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE | MUTEX_MODIFY_STATE, false, MUTEX_NAME) {
              Ok(handle) => Some(SharedMutex(handle)),
              Err(open_error) => {
                log::error!(
                  "could not obtain the owlette json mutex (create: {create_error}; open: {open_error}) \
                   — json access will proceed unlocked"
                );
                None
              }
            }
          }
        }
      }
    })
    .as_ref()
    .map(|mutex| mutex.0)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  /// Per-test scratch directory under the OS temp dir, removed on drop.
  struct Scratch(PathBuf);

  impl Scratch {
    fn new(label: &str) -> Self {
      let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
      let dir = std::env::temp_dir().join(format!(
        "owlette-desktop-test-{}-{label}-{seq}",
        std::process::id()
      ));
      fs::create_dir_all(&dir).expect("scratch dir");
      Self(dir)
    }

    fn path(&self, name: &str) -> PathBuf {
      self.0.join(name)
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn round_trips_a_document() {
    let scratch = Scratch::new("roundtrip");
    let path = scratch.path("config.json");
    let document =
      json!({ "processes": [{ "id": "a", "name": "td" }], "firebase": { "enabled": true } });

    let outcome = write_json(&path, &document).expect("write");
    assert_eq!(outcome.attempts, 1);
    assert!(outcome.bytes > 0);

    assert_eq!(read_json(&path).expect("read"), document);
  }

  #[test]
  fn writes_python_compatible_formatting_and_preserves_key_order() {
    let scratch = Scratch::new("format");
    let path = scratch.path("config.json");
    // Deliberately not alphabetical: serde_json's `preserve_order` is what stops a desktop write
    // reshuffling the operator's config (and the untouchable `firebase` block).
    let document: Value =
      serde_json::from_str(r#"{"zeta":1,"alpha":{"nested":true}}"#).expect("parse");

    write_json(&path, &document).expect("write");

    // Four-space indent, no trailing newline, and the line ending python's own text-mode
    // `json.dump` lands on this platform — byte-for-byte what the service writes.
    #[cfg(windows)]
    let eol = "\r\n";
    #[cfg(not(windows))]
    let eol = "\n";
    let text = fs::read_to_string(&path).expect("read back");
    assert_eq!(
      text,
      format!(
        "{{{eol}    \"zeta\": 1,{eol}    \"alpha\": {{{eol}        \"nested\": true{eol}    }}{eol}}}"
      )
    );
  }

  #[test]
  fn string_values_containing_escapes_are_not_disturbed_by_the_crlf_pass() {
    let scratch = Scratch::new("escapes");
    let path = scratch.path("config.json");
    // Pathological but legal, and exactly what a naive newline translation would corrupt.
    let document = json!({ "note": "line one\nline two", "path": "C:\\a\\b" });

    write_json(&path, &document).expect("write");

    let text = fs::read_to_string(&path).expect("read back");
    assert!(
      text.contains(r#""note": "line one\nline two""#),
      "escaped newline was rewritten: {text:?}"
    );
    assert_eq!(read_json(&path).expect("read"), document);
  }

  #[test]
  fn leaves_no_temp_files_behind() {
    let scratch = Scratch::new("temps");
    let path = scratch.path("app_states.json");

    write_json(
      &path,
      &json!({ "1234": { "id": "a", "status": "RUNNING" } }),
    )
    .expect("write");

    let entries: Vec<_> = fs::read_dir(&scratch.0)
      .expect("read dir")
      .filter_map(Result::ok)
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .collect();
    assert_eq!(entries, vec!["app_states.json".to_string()]);
  }

  #[test]
  fn a_missing_file_reads_as_an_empty_document() {
    let scratch = Scratch::new("missing");
    let value = read_json(&scratch.path("nope.json")).expect("read");
    assert_eq!(value, json!({}));
  }

  #[test]
  fn an_empty_file_reads_as_an_empty_document() {
    let scratch = Scratch::new("empty");
    let path = scratch.path("service_status.json");
    fs::write(&path, "   \n").expect("seed");
    assert_eq!(read_json(&path).expect("read"), json!({}));
  }

  #[test]
  fn a_torn_document_is_retried_and_then_reported() {
    let scratch = Scratch::new("torn");
    let path = scratch.path("config.json");
    fs::write(&path, "{\"processes\": [").expect("seed");

    let error = read_json(&path).expect_err("should fail rather than report an empty config");
    assert!(
      matches!(error, JsonIoError::Parse { .. }),
      "unexpected: {error}"
    );
  }

  #[test]
  fn writing_into_a_missing_directory_fails_fast() {
    let scratch = Scratch::new("nodir");
    let path = scratch.path("nested").join("config.json");
    let error = write_json(&path, &json!({})).expect_err("should fail");
    assert!(
      matches!(error, JsonIoError::Io { .. }),
      "unexpected: {error}"
    );
  }

  #[test]
  #[cfg(windows)]
  fn a_guard_only_holds_a_handle_when_it_owns_the_lock() {
    // Drop's invariant: never release a mutex we do not own. Whether we *can* own it is
    // machine-dependent — pre-SDDL-fix agents leave LocalSystem's default DACL, so a non-elevated
    // app legitimately lands on Unavailable.
    let guard = acquire_lock();
    assert_eq!(
      guard.handle.is_some(),
      !guard.outcome.is_unprotected(),
      "guard held a handle it does not own: {:?}",
      guard.outcome
    );
    println!(
      "cross-process mutex outcome on this machine: {:?} after {} ms",
      guard.outcome,
      guard.waited.as_millis()
    );
  }

  /// Contention check against the real Python holder — proves the wait/release half of the seam
  /// end to end. Ignored by default: needs the deployed interpreter and the live `Global\` mutex.
  /// The holder falls back to `OpenMutex` for the same reason this module does.
  ///
  /// `cargo test --lib -- --ignored --exact json_io::tests::mutex_contention_with_python_holder --nocapture`
  #[test]
  #[cfg(windows)]
  #[ignore = "needs the deployed agent interpreter and an elevated shell"]
  fn mutex_contention_with_python_holder() {
    use std::process::{Command, Stdio};

    let python = PathBuf::from("C:\\ProgramData\\Owlette\\python\\python.exe");
    assert!(
      python.is_file(),
      "missing interpreter: {}",
      python.display()
    );

    let scratch = Scratch::new("contention");
    let script = scratch.path("hold_lock.py");
    let ready = scratch.path("ready.flag");
    fs::write(
      &script,
      format!(
        "import time, win32event\n\
         NAME = 'Global\\\\OwletteJsonFileMutex'\n\
         SYNCHRONIZE, MUTEX_MODIFY_STATE = 0x00100000, 0x0001\n\
         try:\n    \
             handle = win32event.CreateMutex(None, False, NAME)\n\
         except Exception:\n    \
             handle = win32event.OpenMutex(SYNCHRONIZE | MUTEX_MODIFY_STATE, False, NAME)\n\
         result = win32event.WaitForSingleObject(handle, 2000)\n\
         assert result in (0, 128), 'holder could not take the mutex: %s' % result\n\
         open(r'{}', 'w').close()\n\
         time.sleep(1.0)\n\
         win32event.ReleaseMutex(handle)\n",
        ready.display()
      ),
    )
    .expect("write holder script");

    let mut holder = Command::new(&python)
      .arg(&script)
      .stdout(Stdio::null())
      .stderr(Stdio::piped())
      .spawn()
      .expect("spawn python holder");

    // Wait for the holder to own the mutex before contending.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut holder_ready = false;
    while Instant::now() < deadline {
      if ready.exists() {
        holder_ready = true;
        break;
      }
      thread::sleep(Duration::from_millis(20));
    }
    if !holder_ready {
      let _ = holder.kill();
      let output = holder.wait_with_output().expect("holder output");
      panic!(
        "python holder never acquired the mutex (elevated shell?): {}",
        String::from_utf8_lossy(&output.stderr)
      );
    }

    let path = scratch.path("config.json");
    let outcome = write_json(&path, &json!({ "contended": true })).expect("write");
    holder.wait().expect("holder exit");

    println!(
      "contended write: lock={:?} waited_ms={} attempts={}",
      outcome.lock, outcome.waited_ms, outcome.attempts
    );
    assert_eq!(
      outcome.lock,
      LockOutcome::Acquired,
      "expected to acquire after the python holder released"
    );
    assert!(
      outcome.waited_ms >= 500,
      "expected to block on the python holder, waited {} ms",
      outcome.waited_ms
    );
    assert_eq!(
      read_json(&path).expect("read"),
      json!({ "contended": true })
    );
  }

  /// `flock(2)` is per open file description, not per process, so a second
  /// descriptor on the same lock file contends exactly as the python writer's
  /// does — which is what makes this exercise the real identity rather than a
  /// stand-in.
  #[test]
  #[cfg(unix)]
  fn a_second_holder_waits_out_its_budget_and_then_proceeds_unlocked() {
    let scratch = Scratch::new("flock");
    let lock = scratch.path("json.lock");

    let held = acquire_lock_at(&lock, Duration::from_millis(50));
    assert_eq!(held.outcome, LockOutcome::Acquired);

    let contended = acquire_lock_at(&lock, Duration::from_millis(50));
    assert_eq!(contended.outcome, LockOutcome::Timeout);
    assert!(
      contended.file.is_none(),
      "a guard that timed out owes no release"
    );

    // The negative control: with the first holder gone the same call takes it,
    // so the timeout above was the lock and not a broken open.
    drop(held);
    let after = acquire_lock_at(&lock, Duration::from_millis(50));
    assert_eq!(after.outcome, LockOutcome::Acquired);
  }

  #[test]
  #[cfg(unix)]
  fn the_lock_file_is_created_group_writable() {
    let scratch = Scratch::new("lockmode");
    let lock = scratch.path("json.lock");

    drop(acquire_lock_at(&lock, Duration::from_millis(50)));

    let mode = fs::metadata(&lock).expect("lock file").mode() & 0o777;
    assert_eq!(
      mode, LOCK_FILE_MODE,
      "the other writer could not take a {mode:o} lock"
    );
  }

  #[test]
  #[cfg(unix)]
  fn a_lock_file_that_is_not_a_file_of_its_own_is_refused() {
    let scratch = Scratch::new("locklink");
    let lock = scratch.path("json.lock");
    std::os::unix::fs::symlink(scratch.path("elsewhere.lock"), &lock).expect("plant a link");

    let guard = acquire_lock_at(&lock, Duration::from_millis(50));

    assert_eq!(guard.outcome, LockOutcome::Unavailable);
    assert!(
      !scratch.path("elsewhere.lock").exists(),
      "the link was followed out of the seam"
    );
  }

  #[test]
  #[cfg(unix)]
  fn a_write_carries_the_destinations_mode_and_does_not_fall_back_to_the_umask() {
    let scratch = Scratch::new("carry");
    let path = scratch.path("config.json");
    fs::write(&path, "{}").expect("seed");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o660)).expect("seed mode");

    write_json(&path, &json!({ "processes": [] })).expect("write");

    assert_eq!(
      fs::metadata(&path).expect("config.json").mode() & 0o777,
      0o660,
      "the write dropped the group access the mode table grants"
    );
  }

  /// The negative control for the carry above: a file written for the first
  /// time has no mode to carry, so it takes the access its directory grants.
  #[test]
  #[cfg(unix)]
  fn a_first_write_into_a_group_writable_directory_opens_the_file_to_the_group() {
    let scratch = Scratch::new("seed");
    fs::set_permissions(&scratch.0, fs::Permissions::from_mode(0o770)).expect("group-writable");
    let path = scratch.path("config.json");

    write_json(&path, &json!({ "processes": [] })).expect("write");

    assert_eq!(
      fs::metadata(&path).expect("config.json").mode() & 0o777,
      0o660
    );
  }

  #[test]
  #[cfg(unix)]
  fn a_scratch_name_planted_as_a_link_is_never_written_through() {
    let scratch = Scratch::new("templink");
    let temp = scratch.path("config.json.planted.tmp");
    let elsewhere = scratch.path("elsewhere.json");
    std::os::unix::fs::symlink(&elsewhere, &temp).expect("plant a link");

    drop(create_temp(&temp).expect("create the scratch file"));

    assert!(
      !elsewhere.exists(),
      "the scratch write followed a planted link"
    );
    assert!(
      fs::symlink_metadata(&temp).expect("scratch file").is_file(),
      "the link was written through rather than replaced"
    );
  }
}
