//! A loopback-only HTTP/1.1 server, big enough to hand Chrome the probe page
//! and the two bitstreams and to catch the JSON it posts back. Written against
//! `std::net` rather than a web framework so the spike's dependency list stays
//! something the memo can print in full.
//!
//! It binds 127.0.0.1 only, serves nothing outside its own directory, and exits
//! as soon as the browser has reported, so it is never left listening.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

const INDEX: &str = include_str!("../web/index.html");
const PROBE_JS: &str = include_str!("../web/probe.js");
/// A browser that goes wrong could otherwise post until the disk fills.
const MAX_BODY: usize = 4 * 1024 * 1024;

pub type Result<T> = std::result::Result<T, String>;

/// Serve until the page posts its report, then return the path it was written
/// to. `dir` is the measurement output directory (`streams/` lives under it).
pub fn serve_until_report(dir: &Path, port: u16) -> Result<PathBuf> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("bind 127.0.0.1:{port}: {e}"))?;
    println!("open http://127.0.0.1:{port}/ in chrome and press the button");
    let (tx, rx) = mpsc::channel();
    let root = dir.to_path_buf();
    // One thread per connection. Chrome opens speculative sockets it never
    // writes to, and a single-threaded accept loop blocks forever on the first
    // of them.
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let dir = root.clone();
            let tx = tx.clone();
            std::thread::spawn(move || match handle(stream, &dir) {
                Ok(Some(path)) => {
                    let _ = tx.send(path);
                }
                Ok(None) => {}
                Err(e) => eprintln!("request failed: {e}"),
            });
        }
    });
    rx.recv()
        .map_err(|_| "listener closed before the browser reported".to_string())
}

fn handle(mut stream: TcpStream, dir: &Path) -> Result<Option<PathBuf>> {
    // A browser that opens a socket and never speaks must not pin a thread.
    stream
        .set_read_timeout(Some(Duration::from_secs(120)))
        .map_err(|e| format!("set read timeout: {e}"))?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| format!("clone: {e}"))?);
    let mut request_line = String::new();
    if reader
        .read_line(&mut request_line)
        .map_err(|e| format!("read request line: {e}"))?
        == 0
    {
        return Ok(None);
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader
            .read_line(&mut line)
            .map_err(|e| format!("read header: {e}"))?
            == 0
        {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line
            .split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim())
        {
            content_length = value.parse().unwrap_or(0);
        }
    }

    let path = target.split('?').next().unwrap_or("/");
    // Logged because the only other window into what the page did is the
    // browser's own console, which this spike cannot read.
    println!("{method} {target}");
    if method == "POST" && path == "/report" {
        if content_length > MAX_BODY {
            respond(&mut stream, 413, "text/plain", b"body too large")?;
            return Ok(None);
        }
        let mut body = vec![0u8; content_length];
        reader
            .read_exact(&mut body)
            .map_err(|e| format!("read body: {e}"))?;
        let out = dir.join("webcodecs-results.json");
        std::fs::write(&out, &body).map_err(|e| format!("write {}: {e}", out.display()))?;
        respond(&mut stream, 200, "application/json", br#"{"ok":true}"#)?;
        println!("wrote {}", out.display());
        return Ok(Some(out));
    }

    match path {
        "/" | "/index.html" => respond(&mut stream, 200, "text/html; charset=utf-8", INDEX.as_bytes())?,
        "/probe.js" => respond(
            &mut stream,
            200,
            "text/javascript; charset=utf-8",
            PROBE_JS.as_bytes(),
        )?,
        _ => match read_static(dir, path) {
            Some((mime, bytes)) => respond(&mut stream, 200, mime, &bytes)?,
            None => respond(&mut stream, 404, "text/plain", b"not found")?,
        },
    }
    Ok(None)
}

/// Read a file from under `dir`. Rejects anything that is not a plain relative
/// path of simple names — this server exists on a developer box, but it is
/// still a server.
fn read_static(dir: &Path, path: &str) -> Option<(&'static str, Vec<u8>)> {
    let relative = path.strip_prefix('/')?;
    if relative.is_empty() {
        return None;
    }
    let mut full = dir.to_path_buf();
    for segment in relative.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || !segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        {
            return None;
        }
        full.push(segment);
    }
    let mime = match full.extension().and_then(|e| e.to_str()) {
        Some("json") => "application/json",
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        _ => "application/octet-stream",
    };
    std::fs::read(&full).ok().map(|bytes| (mime, bytes))
}

fn respond(stream: &mut TcpStream, status: u16, mime: &str, body: &[u8]) -> Result<()> {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(body))
        .and_then(|()| stream.flush())
        .map_err(|e| format!("write response: {e}"))
}

#[cfg(test)]
mod tests {
    use super::read_static;
    use std::path::Path;

    #[test]
    fn traversal_and_odd_segments_are_refused() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert!(read_static(dir, "/../Cargo.toml").is_none());
        assert!(read_static(dir, "/streams/../../Cargo.toml").is_none());
        assert!(read_static(dir, "/").is_none());
        assert!(read_static(dir, "/web/index.html?x=1").is_none());
    }

    #[test]
    fn a_real_file_under_the_directory_is_served_with_a_mime_type() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let (mime, bytes) = read_static(dir, "/web/probe.js").expect("probe.js is readable");
        assert_eq!(mime, "text/javascript; charset=utf-8");
        assert!(!bytes.is_empty());
    }
}
