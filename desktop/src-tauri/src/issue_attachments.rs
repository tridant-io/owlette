//! Screenshots and a video staged for a submitted issue
//! (dev/active/issue-screenshots, dev/active/issue-video).
//!
//! The app copies each file the operator adds into
//! [`crate::paths::ISSUE_ATTACHMENTS_REL`] under a fresh random name, and the
//! report carries only those names: the agent reads the files from there,
//! re-checks them, and deletes them after the send. The type is decided by the
//! magic bytes, never by the extension the operator's file happened to have.

use std::fs::{self, File, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, ErrorKind, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Largest image accepted, in bytes.
pub const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Largest video accepted, in bytes.
pub const MAX_VIDEO_BYTES: u64 = 100 * 1024 * 1024;

/// Fresh names tried before giving up; a collision on 128 random bits means
/// something other than chance is creating files there.
const NAME_ATTEMPTS: usize = 3;

const REFUSED_TYPE: &str = "only png, jpeg or webp images";
const REFUSED_VIDEO_TYPE: &str = "only mp4, mov or webm videos";
const VIDEO_TOO_BIG: &str = "videos must be 100 MB or smaller";

/// Bytes read to decide a video's type; webm names its doctype within these.
const VIDEO_HEAD: u64 = 64;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoKind {
  Mp4,
  Mov,
  Webm,
}

impl VideoKind {
  fn ext(self) -> &'static str {
    match self {
      VideoKind::Mp4 => "mp4",
      VideoKind::Mov => "mov",
      VideoKind::Webm => "webm",
    }
  }
}

/// One staged video. `id` is the file name, extension included; `name` is
/// the picked file's own name, for display only.
#[derive(Debug, Serialize)]
pub struct StagedVideo {
  pub id: String,
  pub size: u64,
  pub kind: VideoKind,
  pub name: String,
}

/// Major brands of heif and avif stills, which share the `ftyp` box with video.
const IMAGE_BRANDS: [&[u8; 4]; 8] = [
  b"heic", b"heix", b"heim", b"heis", b"mif1", b"msf1", b"avif", b"avis",
];

/// The type of a video from its first bytes: an ISO-BMFF `ftyp` box (major
/// brand `qt  ` is mov, an image brand is refused, any other is mp4), or an
/// EBML header naming `webm`.
pub fn sniff_video(head: &[u8]) -> Option<VideoKind> {
  if head.len() >= 12 && &head[4..8] == b"ftyp" {
    let brand = &head[8..12];
    if IMAGE_BRANDS.iter().any(|image| image.as_slice() == brand) {
      None
    } else if brand == b"qt  " {
      Some(VideoKind::Mov)
    } else {
      Some(VideoKind::Mp4)
    }
  } else if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3])
    && head[..head.len().min(VIDEO_HEAD as usize)]
      .windows(4)
      .any(|window| window == b"webm")
  {
    Some(VideoKind::Webm)
  } else {
    None
  }
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

/// Whether `name` is a staged file name:
/// `^[0-9a-f]{32}\.(png|jpg|webp|mp4|mov|webm)$`.
pub fn is_staged_name(name: &str) -> bool {
  let Some((stem, ext)) = name.split_once('.') else {
    return false;
  };
  stem.len() == 32
    && stem
      .bytes()
      .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    && matches!(ext, "png" | "jpg" | "webp" | "mp4" | "mov" | "webm")
}

/// Stage a video the operator picked, read as the operator. It is copied
/// streaming, never held whole in memory.
pub fn stage_video(dir: &Path, source: &Path) -> Result<StagedVideo, String> {
  let cannot_read = |error: io::Error| format!("cannot read {}: {error}", source.display());
  let metadata = fs::metadata(source).map_err(cannot_read)?;
  // checked before opening: opening a fifo or a device would block or never end.
  if !metadata.is_file() {
    return Err(format!("{} is not a file", source.display()));
  }
  if metadata.len() > MAX_VIDEO_BYTES {
    return Err(VIDEO_TOO_BIG.to_string());
  }
  let mut file = File::open(source).map_err(cannot_read)?;
  let mut head = Vec::new();
  (&mut file)
    .take(VIDEO_HEAD)
    .read_to_end(&mut head)
    .map_err(cannot_read)?;
  let kind = sniff_video(&head).ok_or_else(|| REFUSED_VIDEO_TYPE.to_string())?;
  let name = source
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_default();
  ensure_dir(dir)?;
  let (id, staged) = create_staged(dir, kind.ext(), "video")?;
  let path = dir.join(&id);
  // the file can grow after the metadata check, so the cap holds while copying too.
  let size = fill(staged, &path, head.as_slice().chain(file), MAX_VIDEO_BYTES)?;
  Ok(StagedVideo {
    id,
    size,
    kind,
    name,
  })
}

/// Stream `reader` into `file`, just created at `path`, refusing more than
/// `limit` bytes. On any failure the partial file is removed.
fn fill(mut file: File, path: &Path, reader: impl Read, limit: u64) -> Result<u64, String> {
  let result = io::copy(&mut reader.take(limit + 1), &mut file)
    .map_err(|error| format!("cannot copy the video: {error}"))
    .and_then(|copied| {
      if copied > limit {
        Err(VIDEO_TOO_BIG.to_string())
      } else {
        Ok(copied)
      }
    });
  if result.is_err() {
    drop(file);
    let _ = fs::remove_file(path);
  }
  result
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
  let (id, mut file) = create_staged(dir, kind.ext(), "screenshot")?;
  if let Err(error) = file.write_all(bytes) {
    drop(file);
    let _ = fs::remove_file(dir.join(&id));
    return Err(format!(
      "cannot save the screenshot in {}: {error}",
      dir.display()
    ));
  }
  Ok(Staged {
    id,
    size: bytes.len() as u64,
    kind,
    preview: format!("data:{};base64,{}", kind.mime(), base64(bytes)),
  })
}

/// A new, empty file in `dir` under a fresh random id ending in `ext`, and
/// that id. `what` names the attachment in the errors.
fn create_staged(dir: &Path, ext: &str, what: &str) -> Result<(String, File), String> {
  for _ in 0..NAME_ATTEMPTS {
    let id = format!("{}.{ext}", random_hex());
    match create_new(&dir.join(&id)) {
      Ok(file) => return Ok((id, file)),
      Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
      Err(error) => {
        return Err(format!(
          "cannot save the {what} in {}: {error}",
          dir.display()
        ))
      }
    }
  }
  Err(format!(
    "cannot find a free {what} name in {}",
    dir.display()
  ))
}

/// Delete staged screenshots or videos by id. Every id is checked before
/// anything is removed; one that is gone already is not an error. Returns how
/// many were removed.
pub fn discard(dir: &Path, ids: &[String]) -> Result<usize, String> {
  if let Some(bad) = ids.iter().find(|id| !is_staged_name(id)) {
    return Err(format!("not a staged attachment: {bad}"));
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
        "cannot create the attachments folder {}: permission denied (is this account in the owlette group?)",
        dir.display()
      )
    } else {
      format!(
        "cannot create the attachments folder {}: {error}",
        dir.display()
      )
    });
  }
  // a symlink in its place, in a group-writable tree, would carry the image elsewhere.
  match fs::symlink_metadata(dir) {
    Ok(metadata) if metadata.is_dir() => Ok(()),
    _ => Err(format!(
      "the attachments folder {} is not a plain folder",
      dir.display()
    )),
  }
}

/// Open a file that must not exist yet, 0600 on unix. create_new never
/// overwrites and never follows a link at `path`.
fn create_new(path: &Path) -> std::io::Result<File> {
  let mut options = OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  options.open(path)
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
          .contains("not a staged attachment"),
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
  fn create_new_never_overwrites() {
    let scratch = Scratch::new("create-new");
    let path = scratch.0.join("taken.png");
    fs::write(&path, b"original").expect("seed");
    let error = create_new(&path).expect_err("exists");
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

  const MP4: &[u8] = b"\0\0\0\x18ftypisom\0\0\x02\0isomiso2mp41";
  const MOV: &[u8] = b"\0\0\0\x14ftypqt  \0\0\x02\0qt  ";
  const WEBM: &[u8] = b"\x1A\x45\xDF\xA3\x9F\x42\x86\x81\x01\x42\x82\x84webm\x42\x87\x81\x04";

  /// Stage `bytes` as a picked video file named `name`, removing the source.
  fn stage_video_bytes(scratch: &Scratch, name: &str, bytes: &[u8]) -> Result<StagedVideo, String> {
    let source = scratch.0.join(name);
    fs::write(&source, bytes).expect("source");
    let staged = stage_video(&scratch.staging(), &source);
    fs::remove_file(&source).expect("remove source");
    staged
  }

  #[test]
  fn each_video_magic_is_staged_under_its_own_extension() {
    let scratch = Scratch::new("video-magic");
    let dir = scratch.staging();
    for (bytes, kind, ext) in [
      (MP4, VideoKind::Mp4, "mp4"),
      (MOV, VideoKind::Mov, "mov"),
      (WEBM, VideoKind::Webm, "webm"),
    ] {
      let mut body = bytes.to_vec();
      body.extend(std::iter::repeat_n(7u8, 200_000));
      let staged = stage_video_bytes(&scratch, "clip.bin", &body).expect("stage");
      assert_eq!(staged.kind, kind);
      assert_eq!(staged.size, body.len() as u64);
      assert_eq!(staged.name, "clip.bin");
      assert!(staged.id.ends_with(&format!(".{ext}")), "{}", staged.id);
      assert!(is_staged_name(&staged.id), "{}", staged.id);
      assert_eq!(fs::read(dir.join(&staged.id)).expect("read back"), body);
      assert_eq!(discard(&dir, &[staged.id]).expect("discard"), 1);
    }
  }

  #[test]
  fn mov_and_mp4_are_told_apart_by_major_brand() {
    let brand = |brand: &[u8; 4]| {
      let mut head = b"\0\0\0\x14ftyp".to_vec();
      head.extend_from_slice(brand);
      head.extend_from_slice(b"\0\0\0\0");
      sniff_video(&head)
    };
    assert_eq!(brand(b"qt  "), Some(VideoKind::Mov));
    for other in [
      b"isom", b"mp41", b"mp42", b"avc1", b"iso5", b"M4V ", b"dash",
    ] {
      assert_eq!(brand(other), Some(VideoKind::Mp4), "{other:?}");
    }
    for still in IMAGE_BRANDS {
      assert_eq!(brand(still), None, "{still:?}");
    }
  }

  #[test]
  fn other_types_are_refused_as_video_and_nothing_is_written() {
    let scratch = Scratch::new("video-refused");
    let dir = scratch.staging();
    let matroska = b"\x1A\x45\xDF\xA3\x9F\x42\x86\x81\x01\x42\x82\x88matroska\x42\x87\x81\x04";
    // "webm" past the first 64 bytes does not count.
    let mut late_webm = b"\x1A\x45\xDF\xA3".to_vec();
    late_webm.resize(64, 0);
    late_webm.extend_from_slice(b"webm");
    for bytes in [
      &matroska[..],
      &late_webm,
      PNG,
      b"GIF89a\x01\0\x01\0",
      b"\0\0\0\x18ftyp",
      b"",
    ] {
      assert_eq!(
        stage_video_bytes(&scratch, "clip.mp4", bytes).expect_err("refused"),
        REFUSED_VIDEO_TYPE
      );
    }
    assert_eq!(staged_count(&dir), 0);
  }

  #[test]
  fn a_video_over_100_mb_is_refused_before_reading() {
    let scratch = Scratch::new("video-size");
    let dir = scratch.staging();
    let source = scratch.0.join("big.mp4");
    let file = File::create(&source).expect("source");
    file.set_len(MAX_VIDEO_BYTES + 1).expect("grow");
    drop(file);
    let refused = stage_video(&dir, &source);
    fs::remove_file(&source).expect("remove source");
    assert_eq!(refused.expect_err("too big"), VIDEO_TOO_BIG);
    assert_eq!(staged_count(&dir), 0);
  }

  #[test]
  fn a_folder_is_not_a_video() {
    let scratch = Scratch::new("video-dir");
    let source = scratch.0.join("folder.mp4");
    fs::create_dir(&source).expect("folder");
    let refused = stage_video(&scratch.staging(), &source);
    fs::remove_dir(&source).expect("remove folder");
    assert!(refused.expect_err("refused").contains("is not a file"));
  }

  #[test]
  fn a_partial_video_is_removed_when_the_copy_fails_or_runs_over() {
    struct Failing(usize);
    impl Read for Failing {
      fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.0 == 0 {
          return Err(io::Error::other("unplugged"));
        }
        let count = self.0.min(buf.len());
        buf[..count].fill(1);
        self.0 -= count;
        Ok(count)
      }
    }

    let scratch = Scratch::new("video-partial");
    let failed = scratch.0.join("failed.mp4");
    let error = fill(
      create_new(&failed).expect("create"),
      &failed,
      Failing(4096),
      1 << 20,
    )
    .expect_err("read error");
    assert!(error.contains("unplugged"), "{error}");
    assert!(!failed.exists());

    let over = scratch.0.join("over.mp4");
    let error = fill(
      create_new(&over).expect("create"),
      &over,
      &[0u8; 11][..],
      10,
    )
    .expect_err("over the limit");
    assert_eq!(error, VIDEO_TOO_BIG);
    assert!(!over.exists());

    let exact = scratch.0.join("exact.mp4");
    let size = fill(
      create_new(&exact).expect("create"),
      &exact,
      &[0u8; 10][..],
      10,
    )
    .expect("fits");
    fs::remove_file(&exact).expect("remove");
    assert_eq!(size, 10);
  }

  #[test]
  fn discard_takes_video_ids_and_refuses_other_extensions() {
    let scratch = Scratch::new("video-discard");
    let dir = scratch.staging();
    let staged = stage_video_bytes(&scratch, "clip.webm", WEBM).expect("stage");
    let hex = "0123456789abcdef0123456789abcdef";
    for bad in [
      format!("{hex}.mkv"),
      format!("{hex}.MP4"),
      format!("{hex}.mp4.mp4"),
      format!("../{hex}.mov"),
    ] {
      let ids = vec![staged.id.clone(), bad.clone()];
      assert!(discard(&dir, &ids).is_err(), "{bad}");
    }
    assert!(dir.join(&staged.id).exists());
    assert_eq!(discard(&dir, &[staged.id]).expect("discard"), 1);
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
