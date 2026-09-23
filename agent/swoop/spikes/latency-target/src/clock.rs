//! `QueryPerformanceCounter` access and the loopback HTTP endpoint the browser
//! probe uses to relate QPC to `performance.now()`.
//!
//! The endpoint is deliberately std-only and deliberately tiny. It takes two
//! timestamps per request - one as soon as the request line has been read, one
//! immediately before the response bytes are written - so the browser can run a
//! four-timestamp NTP exchange and bound the offset error by the *measured*
//! round trip minus the *measured* server residence time, instead of assuming a
//! symmetric path with an unknown server cost inside it.
//!
//! Hardware-dependent tests in this module are `#[ignore]`d. Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/latency-target
//! cargo test -- --ignored --nocapture
//! ```

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

/// Raw `QueryPerformanceCounter` tick.
pub fn qpc() -> i64 {
    let mut t = 0i64;
    // QueryPerformanceCounter cannot fail on any Windows version this runs on
    // (documented since Windows XP); a failure would leave `t` at 0, which the
    // stage maths reports as an out-of-range delta rather than a plausible one.
    let _ = unsafe { QueryPerformanceCounter(&mut t) };
    t
}

/// `QueryPerformanceFrequency`, in ticks per second. 10,000,000 on this box.
pub fn qpf() -> i64 {
    let mut f = 0i64;
    let _ = unsafe { QueryPerformanceFrequency(&mut f) };
    f
}

/// Requests served since the endpoint started, for the run summary.
#[derive(Default)]
pub struct ClockStats {
    pub qpc_requests: AtomicU64,
}

/// Bind the clock endpoint and serve it until the process exits.
///
/// Returns the bound port so `--port 0` can be used. Serving happens on
/// detached threads: the harness is a measurement tool with a bounded run time
/// and the process exit is the shutdown.
pub fn spawn(port: u16, stats: Arc<ClockStats>) -> std::io::Result<u16> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))?;
    let bound = listener.local_addr()?.port();
    std::thread::Builder::new()
        .name("clock-accept".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let stats = Arc::clone(&stats);
                // One thread per connection. `fetch` keeps a connection alive
                // across the exchange, so this is a handful of threads for a
                // whole run, not one per sample.
                let _ = std::thread::Builder::new()
                    .name("clock-conn".into())
                    .spawn(move || serve_connection(stream, stats));
            }
        })?;
    Ok(bound)
}

fn serve_connection(stream: TcpStream, stats: Arc<ClockStats>) {
    // Nagle would coalesce the response with nothing and delay it by up to
    // 40 ms, which is more than the quantity being measured.
    let _ = stream.set_nodelay(true);
    let freq = qpf();
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;

    loop {
        let mut request_line = String::new();
        match reader.read_line(&mut request_line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        // Take the receive timestamp before the headers are drained: the
        // request is fully identified by its first line and everything after it
        // is server residence time the exchange already accounts for.
        let t1 = qpc();

        let mut path = String::new();
        let mut method = String::new();
        let mut parts = request_line.split_whitespace();
        if let Some(m) = parts.next() {
            method.push_str(m);
        }
        if let Some(p) = parts.next() {
            path.push_str(p);
        }

        // Drain headers. The endpoint has no request body.
        loop {
            let mut header = String::new();
            match reader.read_line(&mut header) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            if header == "\r\n" || header == "\n" {
                break;
            }
        }

        let path_only = path.split('?').next().unwrap_or("").to_string();
        let body = match (method.as_str(), path_only.as_str()) {
            ("OPTIONS", _) => String::new(),
            ("GET", "/qpc") | ("HEAD", "/qpc") => {
                stats.qpc_requests.fetch_add(1, Ordering::Relaxed);
                let t2 = qpc();
                format!(
                    "{{\"freq\":{freq},\"t1_ticks\":{t1},\"t2_ticks\":{t2},\"t1_ms\":{:.6},\"t2_ms\":{:.6}}}",
                    crate::stats::ticks_to_ms(t1, freq),
                    crate::stats::ticks_to_ms(t2, freq)
                )
            }
            ("GET", "/health") => format!("{{\"ok\":true,\"freq\":{freq}}}"),
            _ => {
                let _ = writer.write_all(not_found().as_bytes());
                let _ = writer.flush();
                continue;
            }
        };

        let response = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Cache-Control: no-store\r\n\
             Connection: keep-alive\r\n\
             \r\n{}",
            body.len(),
            body
        );
        if writer.write_all(response.as_bytes()).is_err() || writer.flush().is_err() {
            return;
        }
    }
}

fn not_found() -> String {
    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: keep-alive\r\n\r\n".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn qpf_is_a_positive_frequency() {
        assert!(qpf() > 0, "QueryPerformanceFrequency returned {}", qpf());
    }

    #[test]
    fn qpc_is_monotonic_across_two_reads() {
        let a = qpc();
        let b = qpc();
        assert!(b >= a, "QPC went backwards: {a} then {b}");
    }

    /// Exercises the real socket path, so it is `#[ignore]`d with the rest of
    /// the environment-dependent tests: a sandbox that refuses a loopback bind
    /// would fail it for a reason that has nothing to do with the harness.
    #[test]
    #[ignore]
    fn qpc_endpoint_answers_with_two_bracketing_timestamps() {
        let stats = Arc::new(ClockStats::default());
        let port = spawn(0, Arc::clone(&stats)).expect("bind loopback");
        let mut stream =
            TcpStream::connect(("127.0.0.1", port)).expect("connect to the clock endpoint");
        stream
            .write_all(b"GET /qpc HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        // The server holds the connection open for keep-alive, so read only
        // what the declared Content-Length guarantees is already there.
        let mut buf = [0u8; 4096];
        let read = stream.read(&mut buf).unwrap();
        response.push_str(&String::from_utf8_lossy(&buf[..read]));

        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("Access-Control-Allow-Origin: *"), "{response}");
        let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
        let t1 = json_number(body, "t1_ticks");
        let t2 = json_number(body, "t2_ticks");
        assert!(t2 >= t1, "t2 {t2} must not precede t1 {t1}");
        assert_eq!(stats.qpc_requests.load(Ordering::Relaxed), 1);
    }

    fn json_number(body: &str, key: &str) -> f64 {
        let needle = format!("\"{key}\":");
        let start = body.find(&needle).expect("key present") + needle.len();
        let rest = &body[start..];
        let end = rest
            .find(|c: char| c != '-' && c != '.' && !c.is_ascii_digit())
            .unwrap_or(rest.len());
        rest[..end].parse().expect("numeric value")
    }
}
