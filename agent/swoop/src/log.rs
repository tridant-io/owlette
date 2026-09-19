//! The one log sink: a size-capped rotating file under `logs/swoop`.
//!
//! The streamer rotates its own directory because the agent's
//! `cleanup_old_logs` is deliberately non-recursive and never walks into
//! subdirectories — nothing else will ever delete these files.
//!
//! Cap: `MAX_BYTES` per file, `KEEP` files, so the directory cannot exceed
//! 12 MiB whatever happens. A streamer that is looping on an error writes fast,
//! and the machines this runs on are signage boxes with small system drives.
//!
//! Nothing that touches the bundle, a token, a key or a viewer JWT is ever
//! passed to this module, at any level, including debug.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 4 * 1024 * 1024;
const KEEP: usize = 3;
const BASENAME: &str = "swoop.log";

/// `%PROGRAMDATA%\Owlette\logs\swoop`, the directory `shared_utils.SWOOP_LOG_DIR`
/// names on the agent side. Off Windows there is no ProgramData and no service
/// yet, so a temp directory keeps the crate runnable for Wave 9's port.
///
/// Public because the crash dump lands beside the log and there must not be a
/// second spelling of where that is.
pub fn dir() -> PathBuf {
    log_dir()
}

fn log_dir() -> PathBuf {
    match std::env::var_os("PROGRAMDATA") {
        Some(root) => PathBuf::from(root).join("Owlette").join("logs").join("swoop"),
        None => std::env::temp_dir().join("owlette").join("logs").join("swoop"),
    }
}

struct Rotating {
    dir: PathBuf,
    /// Always `MAX_BYTES` in the product; a field so the rotation test does not
    /// have to write 12 MiB to prove it.
    max_bytes: u64,
    file: Option<File>,
    written: u64,
}

impl Rotating {
    fn new(dir: PathBuf, max_bytes: u64) -> Self {
        Self { dir, max_bytes, file: None, written: 0 }
    }

    fn numbered(&self, n: usize) -> PathBuf {
        self.dir.join(format!("{BASENAME}.{n}"))
    }

    fn open(&mut self) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(BASENAME);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        self.written = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }

    /// Drop the oldest, shift the rest up, start a new current file. The handle
    /// is closed first: Windows refuses to rename a file this process holds
    /// open. A failed rename is swallowed — losing a log line is never worth
    /// taking the session down.
    fn rotate(&mut self) {
        self.file = None;
        let _ = fs::remove_file(self.numbered(KEEP - 1));
        for n in (1..KEEP - 1).rev() {
            let _ = fs::rename(self.numbered(n), self.numbered(n + 1));
        }
        let _ = fs::rename(self.dir.join(BASENAME), self.numbered(1));
        self.written = 0;
    }

    fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        if self.file.is_some() && self.written >= self.max_bytes {
            self.rotate();
        }
        if self.file.is_none() {
            self.open()?;
        }
        let Some(file) = self.file.as_mut() else {
            return Ok(());
        };
        let bytes = line.as_bytes();
        file.write_all(bytes)?;
        file.write_all(b"\n")?;
        self.written += bytes.len() as u64 + 1;
        Ok(())
    }
}

struct FileLogger {
    inner: Mutex<Rotating>,
}

impl ::log::Log for FileLogger {
    fn enabled(&self, _metadata: &::log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &::log::Record) {
        // Epoch milliseconds rather than a formatted date: these are drifting
        // kiosk clocks and a date crate would buy nothing the reader cannot get
        // from the number.
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let line = format!(
            "{} {:<5} {} {}",
            millis,
            record.level(),
            record.target(),
            record.args()
        );
        if let Ok(mut rotating) = self.inner.lock() {
            let _ = rotating.write_line(&line);
        }
    }

    fn flush(&self) {
        if let Ok(mut rotating) = self.inner.lock() {
            if let Some(file) = rotating.file.as_mut() {
                let _ = file.flush();
            }
        }
    }
}

/// Install the rotating writer as the process logger. Called once, from `main`.
pub fn init(level: ::log::LevelFilter) -> Result<(), ::log::SetLoggerError> {
    let logger = FileLogger { inner: Mutex::new(Rotating::new(log_dir(), MAX_BYTES)) };
    ::log::set_boxed_logger(Box::new(logger))?;
    ::log::set_max_level(level);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_at_the_cap_and_never_keeps_more_than_keep_files() {
        let dir = std::env::temp_dir().join(format!("owlette-swoop-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut rotating = Rotating::new(dir.clone(), 256);

        let line = "x".repeat(200);
        for _ in 0..40 {
            rotating.write_line(&line).expect("write to the temp log directory");
        }

        assert!(dir.join(BASENAME).exists());
        assert!(dir.join(format!("{BASENAME}.{}", KEEP - 1)).exists());
        assert!(!dir.join(format!("{BASENAME}.{KEEP}")).exists());

        let count = fs::read_dir(&dir).expect("read the temp log directory").count();
        assert_eq!(count, KEEP, "the directory never grows past KEEP files");

        let _ = fs::remove_dir_all(&dir);
    }
}
