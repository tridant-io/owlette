//! Screenshots staged for a submitted issue (dev/active/issue-screenshots).
//!
//! The app copies each image the operator adds into
//! [`crate::paths::ISSUE_ATTACHMENTS_REL`] under a fresh random name, and the
//! report carries only those names: the agent reads the files from there,
//! re-checks them, and deletes them after the send. The type is decided by the
//! magic bytes, never by the extension the operator's file happened to have.

use std::fs::{self, File, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Largest image accepted, in bytes.
pub const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Fresh names tried before giving up; a collision on 128 random bits means
/// something other than chance is creating files there.
const NAME_ATTEMPTS: usize = 3;

const REFUSED_TYPE: &str = "only png, jpeg or webp images";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
  Png,
  Jpeg,
  Webp,
}

impl Kind {
  fn ext(self) -> &'static str {
    match self {
      Kind::Png => "png",
      Kind::Jpeg => "jpg",
      Kind::Webp => "webp",
    }
  }

  fn mime(self) -> &'static str {
    match self {
      Kind::Png => "image/png",
      Kind::Jpeg => "image/jpeg",
      Kind::Webp => "image/webp",
    }
  }
}

/// One staged image. `id` is the file name, extension included.
#[derive(Debug, Serialize)]
pub struct Staged {
  pub id: String,
  pub size: u64,
  pub kind: Kind,
  pub preview: String,
}

pub fn sniff(bytes: &[u8]) -> Option<Kind> {
  if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
    Some(Kind::Png)
  } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
    Some(Kind::Jpeg)
  } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
    Some(Kind::Webp)
  } else {
    None
  }
}

/// Whether `name` is a staged file name: `^[0-9a-f]{32}\.(png|jpg|webp)$`.
pub fn is_staged_name(name: &str) -> bool {
  let Some((stem, ext)) = name.split_once('.') else {
    return false;
  };
  stem.len() == 32
    && stem
      .bytes()
      .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    && matches!(ext, "png" | "jpg" | "webp")
}

/// Stage a file the operator picked, read as the operator.
pub fn stage_file(dir: &Path, source: &Path) -> Result<Staged, String> {
  let metadata =
    fs::metadata(source).map_err(|error| format!("cannot read {}: {error}", source.display()))?;
  // checked before opening: opening a fifo or a device would block or never end.
  if !metadata.is_file() {
    return Err(format!("{} is not a file", source.display()));
  }
  if metadata.len() > MAX_BYTES {
    return Err(too_big());
  }
  let file =
    File::open(source).map_err(|error| format!("cannot read {}: {error}", source.display()))?;
  let mut bytes = Vec::new();
  file
    .take(MAX_BYTES + 1)
    .read_to_end(&mut bytes)
    .map_err(|error| format!("cannot read {}: {error}", source.display()))?;
  stage_bytes(dir, &bytes)
}

/// Stage image bytes (a paste, or a file already read).
pub fn stage_bytes(dir: &Path, bytes: &[u8]) -> Result<Staged, String> {
  if bytes.len() as u64 > MAX_BYTES {
    return Err(too_big());
  }
  let kind = sniff(bytes).ok_or_else(|| REFUSED_TYPE.to_string())?;
  ensure_dir(dir)?;
  for _ in 0..NAME_ATTEMPTS {
    let id = format!("{}.{}", random_hex(), kind.ext());
    match write_new(&dir.join(&id), bytes) {
      Ok(()) => {
        return Ok(Staged {
          id,
          size: bytes.len() as u64,
          kind,
          preview: format!("data:{};base64,{}", kind.mime(), base64(bytes)),
        })
      }
      Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
      Err(error) => {
        return Err(format!(
          "cannot save the screenshot in {}: {error}",
          dir.display()
        ))
      }
    }
  }
  Err(format!(
    "cannot find a free screenshot name in {}",
    dir.display()
  ))
}

/// Delete staged screenshots by id. Every id is checked before anything is
/// removed; one that is gone already is not an error. Returns how many were
/// removed.
pub fn discard(dir: &Path, ids: &[String]) -> Result<usize, String> {
  if let Some(bad) = ids.iter().find(|id| !is_staged_name(id)) {
    return Err(format!("not a staged screenshot: {bad}"));
  }
  let mut removed = 0;
  for id in ids {
    match fs::remove_file(dir.join(id)) {
      Ok(()) => removed += 1,
      Err(error) if error.kind() == ErrorKind::NotFound => {}
      Err(error) => return Err(format!("cannot remove {id}: {error}")),
    }
  }
  Ok(removed)
}

fn too_big() -> String {
  "images must be 8 MB or smaller".to_string()
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
  let mut builder = fs::DirBuilder::new();
  builder.recursive(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::DirBuilderExt;
    builder.mode(0o770);
  }
  if let Err(error) = builder.create(dir) {
    return Err(if error.kind() == ErrorKind::PermissionDenied {
      format!(
        "cannot create the screenshot folder {}: permission denied (is this account in the owlette group?)",
        dir.display()
      )
    } else {
      format!(
        "cannot create the screenshot folder {}: {error}",
        dir.display()
      )
    });
  }
  // a symlink in its place, in a group-writable tree, would carry the image elsewhere.
  match fs::symlink_metadata(dir) {
    Ok(metadata) if metadata.is_dir() => Ok(()),
    _ => Err(format!(
      "the screenshot folder {} is not a plain folder",
      dir.display()
    )),
  }
}

/// Write `bytes` to a file that must not exist yet. create_new never
/// overwrites and never follows a link at `path`.
fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  let mut options = OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(path)?;
  if let Err(error) = file.write_all(bytes) {
    drop(file);
    let _ = fs::remove_file(path);
    return Err(error);
  }
  Ok(())
}

/// 32 lowercase hex characters. std's hasher keys are drawn from the os rng,
/// so two keyed siphash outputs over a counter give unguessable names without
/// a new crate; uniqueness itself rests on create_new.
fn random_hex() -> String {
  static COUNTER: AtomicU64 = AtomicU64::new(0);
  let count = COUNTER.fetch_add(1, Ordering::Relaxed);
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|elapsed| elapsed.as_nanos())
    .unwrap_or(0);
  let state = std::collections::hash_map::RandomState::new();
  let half = |salt: u8| {
    let mut hasher = state.build_hasher();
    hasher.write_u8(salt);
    hasher.write_u64(count);
    hasher.write_u128(nanos);
    hasher.write_u32(std::process::id());
    hasher.finish()
  };
  format!("{:016x}{:016x}", half(0), half(1))
}

fn base64(bytes: &[u8]) -> String {
  const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
  for chunk in bytes.chunks(3) {
    let byte = |index: usize| u32::from(chunk.get(index).copied().unwrap_or(0));
    let group = (byte(0) << 16) | (byte(1) << 8) | byte(2);
    for index in 0..4 {
      if index <= chunk.len() {
        out.push(char::from(
          ALPHABET[((group >> (18 - 6 * index)) & 63) as usize],
        ));
      } else {
        out.push('=');
      }
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  static SEQ: AtomicU64 = AtomicU64::new(0);

  const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
  const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F'];
  const WEBP: &[u8] = b"RIFF\x24\0\0\0WEBPVP8 ";

  /// A scratch root whose staging folder does not exist yet. Tests remove
  /// what they create by name; drop only removes the then-empty folders.
  struct Scratch(PathBuf);

  impl Scratch {
    fn new(label: &str) -> Self {
      let seq = SEQ.fetch_add(1, Ordering::Relaxed);
      let root = std::env::temp_dir().join(format!(
        "owlette-issue-shots-{}-{label}-{seq}",
        std::process::id()
      ));
      fs::create_dir_all(&root).expect("scratch root");
      Self(root)
    }

    fn staging(&self) -> PathBuf {
      self.0.join("ipc").join("issue-attachments")
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir(self.staging());
      let _ = fs::remove_dir(self.0.join("ipc"));
      let _ = fs::remove_dir(&self.0);
    }
  }

  fn staged_count(dir: &Path) -> usize {
    fs::read_dir(dir)
      .map(|entries| entries.count())
      .unwrap_or(0)
  }

  #[test]
  fn each_magic_type_is_staged_under_its_own_extension() {
    let scratch = Scratch::new("magic");
    let dir = scratch.staging();
    for (bytes, kind, ext, mime) in [
      (PNG, Kind::Png, "png", "image/png"),
      (JPEG, Kind::Jpeg, "jpg", "image/jpeg"),
      (WEBP, Kind::Webp, "webp", "image/webp"),
    ] {
      let staged = stage_bytes(&dir, bytes).expect("stage");
      assert_eq!(staged.kind, kind);
      assert_eq!(staged.size, bytes.len() as u64);
      assert!(staged.id.ends_with(&format!(".{ext}")), "{}", staged.id);
      assert!(is_staged_name(&staged.id), "{}", staged.id);
      assert_eq!(
        staged.preview,
        format!("data:{mime};base64,{}", base64(bytes))
      );
      assert_eq!(fs::read(dir.join(&staged.id)).expect("read back"), bytes);
      assert_eq!(discard(&dir, &[staged.id]).expect("discard"), 1);
    }
  }

  #[test]
  fn text_and_gif_are_refused_and_nothing_is_written() {
    let scratch = Scratch::new("refused");
    let dir = scratch.staging();
    for bytes in [
      &b"just some text"[..],
      b"GIF89a\x01\0\x01\0",
      b"",
      b"RIFF\0\0\0\0WAVEfmt ",
    ] {
      assert_eq!(stage_bytes(&dir, bytes).expect_err("refused"), REFUSED_TYPE);
    }
    assert_eq!(staged_count(&dir), 0);
  }

  #[test]
  fn over_eight_mb_is_refused_from_bytes_and_from_a_file() {
    let scratch = Scratch::new("size");
    let dir = scratch.staging();
    let mut bytes = PNG.to_vec();
    bytes.resize(MAX_BYTES as usize + 1, 0);
    assert!(stage_bytes(&dir, &bytes)
      .expect_err("too big")
      .contains("8 MB"));

    let source = scratch.0.join("big.png");
    fs::write(&source, &bytes).expect("source");
    let refused = stage_file(&dir, &source);
    fs::remove_file(&source).expect("remove source");
    assert!(refused.expect_err("too big").contains("8 MB"));
    assert_eq!(staged_count(&dir), 0);
  }

  #[test]
  fn a_picked_file_is_staged_by_its_bytes_not_its_name() {
    let scratch = Scratch::new("file");
    let dir = scratch.staging();
    let source = scratch.0.join("looks-like.gif");
    fs::write(&source, JPEG).expect("source");
    let staged = stage_file(&dir, &source);
    fs::remove_file(&source).expect("remove source");
    let staged = staged.expect("stage");
    assert_eq!(staged.kind, Kind::Jpeg);
    assert!(staged.id.ends_with(".jpg"));
    assert_eq!(discard(&dir, &[staged.id]).expect("discard"), 1);
  }

  #[test]
  fn ids_are_32_lowercase_hex_and_fresh_each_time() {
    let first = random_hex();
    let second = random_hex();
    assert_eq!(first.len(), 32);
    assert!(first
      .bytes()
      .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')));
    assert_ne!(first, second);
  }

  #[test]
  fn discard_refuses_bad_names_and_removes_nothing() {
    let scratch = Scratch::new("discard-bad");
    let dir = scratch.staging();
    let staged = stage_bytes(&dir, PNG).expect("stage");
    let hex = "0123456789abcdef0123456789abcdef";
    for bad in [
      "../x",
      "a.png",
      "x/../a.png",
      &format!("{}.png", hex.to_uppercase()),
      &format!("{hex}.gif"),
      &format!("{hex}.png.png"),
      &format!("../{hex}.png"),
    ] {
      let ids = vec![staged.id.clone(), bad.to_string()];
      assert!(
        discard(&dir, &ids)
          .expect_err("refused")
          .contains("not a staged screenshot"),
        "{bad}"
      );
    }
    assert!(dir.join(&staged.id).exists());
    assert_eq!(
      discard(&dir, std::slice::from_ref(&staged.id)).expect("discard"),
      1
    );
    assert!(!dir.join(&staged.id).exists());
    assert_eq!(discard(&dir, &[staged.id]).expect("already gone"), 0);
  }

  #[test]
  fn write_new_never_overwrites() {
    let scratch = Scratch::new("create-new");
    let path = scratch.0.join("taken.png");
    fs::write(&path, b"original").expect("seed");
    let error = write_new(&path, PNG).expect_err("exists");
    let kept = fs::read(&path).expect("read");
    fs::remove_file(&path).expect("remove");
    assert_eq!(error.kind(), ErrorKind::AlreadyExists);
    assert_eq!(kept, b"original");
  }

  #[cfg(unix)]
  #[test]
  fn staged_files_are_no_wider_than_0600() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("mode");
    let dir = scratch.staging();
    let staged = stage_bytes(&dir, PNG).expect("stage");
    let mode = fs::metadata(dir.join(&staged.id))
      .expect("stat")
      .permissions()
      .mode();
    discard(&dir, &[staged.id]).expect("discard");
    assert_eq!(mode & 0o177, 0, "{mode:o}");
  }

  #[test]
  fn base64_matches_the_rfc_vectors() {
    for (input, expected) in [
      ("", ""),
      ("f", "Zg=="),
      ("fo", "Zm8="),
      ("foo", "Zm9v"),
      ("foob", "Zm9vYg=="),
      ("foobar", "Zm9vYmFy"),
    ] {
      assert_eq!(base64(input.as_bytes()), expected);
    }
  }
}
