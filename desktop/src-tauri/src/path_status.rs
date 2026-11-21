//! whether a path the operator typed is on this machine.
//!
//! not `plugin-fs`: its `exists` and `stat` run on the main thread, where a dead
//! network share freezes the window for the ~50 s windows takes to give up, and
//! its `**` scope refuses dot folders such as `.venv` off windows. this reads
//! metadata only, off the main thread, and stops waiting after `PROBE_TIMEOUT`.

use std::io::ErrorKind;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathStatus {
    File,
    Folder,
    Missing,
    /// no answer in time, or one that does not say: not grounds for a warning.
    Unknown,
    /// symbolic links, which the agent refuses to launch from. what each points
    /// at matters too: off windows it only refuses a link to a file in `path / args`.
    FileLink,
    FolderLink,
    BrokenLink,
}

/// the path the agent checks: its `abspath` drops trailing separators, so
/// `C:\x.exe\` still launches, and `lstat` would follow a link through one.
fn without_trailing_separators(path: &str) -> &str {
    let bare = path.trim_end_matches(std::path::is_separator);
    if bare.is_empty() || bare.ends_with(':') {
        path
    } else {
        bare
    }
}

/// what the agent's `os.path.islink` says of the same path.
fn is_link(path: &str) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) && python_calls_it_a_link(path)
}

/// rust's `is_symlink` also counts a junction, and python does not: the agent
/// launches through one, so it must not warn.
#[cfg(windows)]
fn python_calls_it_a_link(path: &str) -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{FindClose, FindFirstFileW, WIN32_FIND_DATAW};
    const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;

    let mut found = WIN32_FIND_DATAW::default();
    // safety: `found` outlives the call, and the handle is closed right after it.
    let Ok(handle) = (unsafe { FindFirstFileW(&HSTRING::from(path), &mut found) }) else {
        return false;
    };
    // safety: the handle came from the successful call above and is not used again.
    let _ = unsafe { FindClose(handle) };
    found.dwReserved0 == IO_REPARSE_TAG_SYMLINK
}

#[cfg(not(windows))]
fn python_calls_it_a_link(_path: &str) -> bool {
    true
}

fn read_status(path: &str) -> PathStatus {
    let path = without_trailing_separators(path);
    let target = match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => PathStatus::Folder,
        Ok(_) => PathStatus::File,
        // a name no file can have, such as one with a quote in it on windows.
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory | ErrorKind::InvalidFilename) => {
            PathStatus::Missing
        }
        Err(_) => PathStatus::Unknown,
    };
    if !is_link(path) {
        return target;
    }
    match target {
        PathStatus::File => PathStatus::FileLink,
        PathStatus::Folder => PathStatus::FolderLink,
        _ => PathStatus::BrokenLink,
    }
}

/// `probe` on its own thread, which is left behind if it outlives `limit`:
/// a blocked metadata call cannot be cancelled.
fn within(limit: Duration, probe: impl FnOnce() -> PathStatus + Send + 'static) -> PathStatus {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(probe());
    });
    rx.recv_timeout(limit).unwrap_or(PathStatus::Unknown)
}

#[tauri::command]
pub async fn path_status(path: String) -> PathStatus {
    tauri::async_runtime::spawn_blocking(move || within(PROBE_TIMEOUT, move || read_status(&path)))
        .await
        .unwrap_or(PathStatus::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// one folder per test, kept between runs so they do not pile up in the temp dir.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("owlette-path-status-{name}"));
        std::fs::create_dir_all(&dir).expect("scratch folder");
        dir
    }

    /// a folder for a link to point at: inside the test's own, never that folder itself,
    /// so nothing that walks the tree can go round in a circle.
    fn link_target(dir: &std::path::Path) -> std::path::PathBuf {
        let target = dir.join("target");
        std::fs::create_dir_all(&target).expect("link target");
        target
    }

    /// clear a link or junction a last run left. neither call follows it, and neither
    /// removes a folder with anything in it.
    fn clear(at: &std::path::Path) {
        if std::fs::symlink_metadata(at).is_ok() {
            std::fs::remove_file(at).or_else(|_| std::fs::remove_dir(at)).expect("clear the last run's link");
        }
    }

    #[test]
    fn reads_a_folder_a_file_and_nothing() {
        let dir = scratch("kinds");
        let file = dir.join("main.toe");
        std::fs::write(&file, b"").expect("scratch file");

        assert_eq!(read_status(dir.to_str().unwrap()), PathStatus::Folder);
        assert_eq!(read_status(file.to_str().unwrap()), PathStatus::File);
        assert_eq!(read_status(dir.join("gone.toe").to_str().unwrap()), PathStatus::Missing);
        assert_eq!(read_status(dir.join("gone").join("deeper.toe").to_str().unwrap()), PathStatus::Missing);
    }

    #[test]
    fn a_path_under_a_file_is_missing() {
        let dir = scratch("under");
        let file = dir.join("main.toe");
        std::fs::write(&file, b"").expect("scratch file");

        assert_eq!(read_status(file.join("inner").to_str().unwrap()), PathStatus::Missing);
    }

    #[test]
    fn a_dot_folder_is_read_like_any_other() {
        let dir = scratch("dot").join(".venv");
        std::fs::create_dir_all(&dir).expect("dot folder");

        assert_eq!(read_status(dir.to_str().unwrap()), PathStatus::Folder);
    }

    #[test]
    fn a_name_the_os_cannot_hold_is_missing_not_unknown() {
        let dir = scratch("name");
        let quoted = format!("\"{}\" --fullscreen", dir.join("gone.toe").display());

        assert_eq!(read_status(&quoted), PathStatus::Missing);
    }

    /// false where the account may not make links; windows wants developer mode or admin.
    #[cfg(windows)]
    fn link(target: &std::path::Path, at: &std::path::Path, folder: bool) -> bool {
        clear(at);
        let made = if folder {
            std::os::windows::fs::symlink_dir(target, at)
        } else {
            std::os::windows::fs::symlink_file(target, at)
        };
        match made {
            Ok(()) => true,
            Err(e) if e.raw_os_error() == Some(1314) => false,
            Err(e) => panic!("could not make the link: {e}"),
        }
    }

    #[cfg(unix)]
    fn link(target: &std::path::Path, at: &std::path::Path, _folder: bool) -> bool {
        clear(at);
        std::os::unix::fs::symlink(target, at).expect("scratch link");
        true
    }

    #[test]
    fn reads_a_link_by_what_it_points_at() {
        let dir = scratch("links");
        let file = dir.join("main.toe");
        std::fs::write(&file, b"").expect("scratch file");
        let (to_file, to_folder, broken) = (dir.join("to-file"), dir.join("to-folder"), dir.join("broken"));

        if !link(&file, &to_file, false) {
            eprintln!("this account can't make symbolic links; skipping");
            return;
        }
        assert!(link(&link_target(&dir), &to_folder, true));
        assert!(link(&dir.join("gone"), &broken, false));

        assert_eq!(read_status(to_file.to_str().unwrap()), PathStatus::FileLink);
        assert_eq!(read_status(to_folder.to_str().unwrap()), PathStatus::FolderLink);
        assert_eq!(read_status(broken.to_str().unwrap()), PathStatus::BrokenLink);
    }

    #[test]
    fn a_link_with_a_trailing_separator_is_still_a_link() {
        let dir = scratch("trailing");
        let to_folder = dir.join("to-folder");

        if !link(&link_target(&dir), &to_folder, true) {
            eprintln!("this account can't make symbolic links; skipping");
            return;
        }
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(read_status(&format!("{}{sep}", to_folder.display())), PathStatus::FolderLink);
    }

    /// the agent's `abspath` drops it, so `C:\x.exe\` launches.
    #[test]
    fn a_file_with_a_trailing_separator_is_still_the_file() {
        let dir = scratch("trailing-file");
        let file = dir.join("main.exe");
        std::fs::write(&file, b"").expect("scratch file");
        let sep = std::path::MAIN_SEPARATOR;

        assert_eq!(read_status(&format!("{}{sep}", file.display())), PathStatus::File);
        assert_eq!(read_status(&format!("{}{sep}", dir.display())), PathStatus::Folder);
    }

    #[test]
    fn a_drive_or_root_with_its_separator_is_a_folder() {
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert_eq!(read_status(root), PathStatus::Folder);
    }

    /// the agent's `os.path.islink` is false for a junction, so it launches through one.
    #[cfg(windows)]
    #[test]
    fn a_junction_is_a_folder_not_a_link() {
        let dir = scratch("junction");
        let junction = dir.join("junction");
        clear(&junction);
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(link_target(&dir))
            .output()
            .expect("mklink");
        assert!(made.status.success(), "{made:?}");

        assert_eq!(read_status(junction.to_str().unwrap()), PathStatus::Folder);
    }

    #[test]
    fn a_probe_that_does_not_answer_in_time_is_unknown() {
        let started = std::time::Instant::now();
        let status = within(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_secs(5));
            PathStatus::File
        });

        assert_eq!(status, PathStatus::Unknown);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_probe_that_answers_in_time_is_taken() {
        assert_eq!(within(Duration::from_secs(5), || PathStatus::Missing), PathStatus::Missing);
    }
}
