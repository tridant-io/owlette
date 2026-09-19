//! The host's own HTTP surface: the QPC clock exchange, the SDP answer, and
//! the host half of the run report.
//!
//! Deliberately `std`-only and deliberately tiny, for the reason spike 0.1 gave
//! for the same decision: the `/qpc` handler takes one timestamp as soon as the
//! request line has been read and another immediately before the response bytes
//! are written, so the browser can run a four-timestamp NTP exchange and bound
//! the offset error by the *measured* round trip minus the *measured* server
//! residence. Anything between the request and the response is unmeasured
//! latency in a latency harness.
//!
//! The page itself is served by `bakeoff-web/server.mjs`, not from here — same
//! split as spike 0.1, and for the same reason: the offset has to be measured
//! against the process that owns `QueryPerformanceCounter`.
//!
//! Routes:
//!
//! | route | purpose |
//! |---|---|
//! | `GET /health` | liveness plus the QPC frequency |
//! | `GET /qpc` | the four-timestamp clock exchange |
//! | `POST /offer` | body is the browser's SDP offer; answers with JSON |
//! | `POST /reoffer` | an **ICE restart**: a second offer on a live peer |
//! | `GET /hostreport` | the host half of the run's JSON |
//!
//! `/reoffer` is the one route that cannot answer on this thread. The sink
//! lives on `pipeline.rs`'s thread and is not `Sync`, so the offer is parked in
//! a [`Reoffer`] slot, the sink drains it inside its own `poll`, and this
//! thread waits for the answer to appear. That keeps `pipeline.rs` untouched,
//! which is the constraint the whole seam was built under.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};

use crate::clock::{qpc, qpf, ticks_to_ms};
use crate::json::J;
use crate::sink::{Arm, Reoffer, VideoSink};

/// Everything the HTTP thread needs from the rest of the process.
pub struct Signaling {
    /// Which of plan.md D3's arms to build for an offer. The page's `?arm=`
    /// must agree; the answer carries the arm back so the page can refuse a
    /// mismatch rather than measure a run neither side meant.
    pub arm: Arm,
    /// Address the arm's UDP socket binds to. One concrete address, never
    /// `0.0.0.0` — see [`crate::sinks::rtp_track::RtpTrackSink::bind`].
    pub udp_bind: SocketAddr,
    pub codec: crate::nal::Codec,
    /// The encoder's target, so the arm can give its pacer headroom over it.
    pub encoder_bps: u64,
    /// Whether the arm enables bandwidth estimation, and with it str0m's
    /// leaky-bucket pacer. Off for latency rows - see `rtp_track`'s module doc.
    pub bwe: bool,
    /// Arm A only: total bytes per second to offer the data channel, video
    /// included, or 0 for "whatever the encoder produces". See
    /// [`crate::sinks::data_channel::DataChannelSink::bind`].
    pub dc_load_bps: u64,
    pub sink_tx: SyncSender<Box<dyn VideoSink + Send>>,
    /// Shared with whichever sink is live: see the module doc and
    /// [`crate::sink::Reoffer`].
    pub reoffer: Reoffer,
    /// The host half of the run report, refreshed by the capture and pipeline
    /// threads. `GET /hostreport` renders whatever is in it at the time.
    pub report: Arc<Mutex<J>>,
}

/// How long `/reoffer` waits for the sink thread. Two seconds is plan.md D11's
/// kill-switch budget and is two thousand poll cycles: past it there is no live
/// peer to answer.
const REOFFER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Bind and serve until the process exits. Returns the bound port so `:0` can
/// be used.
pub fn spawn(bind: SocketAddr, signaling: Arc<Signaling>) -> std::io::Result<u16> {
    let listener = TcpListener::bind(bind)?;
    let port = listener.local_addr()?.port();
    std::thread::Builder::new()
        .name("http-accept".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let signaling = Arc::clone(&signaling);
                // One thread per connection. The clock exchange keeps its
                // connection alive across all 400 samples, so this is a handful
                // of threads for a whole run, not one per sample.
                let _ = std::thread::Builder::new()
                    .name("http-conn".into())
                    .spawn(move || serve_connection(stream, signaling));
            }
        })?;
    Ok(port)
}

fn serve_connection(stream: TcpStream, signaling: Arc<Signaling>) {
    // Nagle would delay a small response by up to 40 ms, which is more than
    // the quantity being measured.
    let _ = stream.set_nodelay(true);
    let freq = qpf();
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);

    loop {
        let mut request_line = String::new();
        match reader.read_line(&mut request_line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        // Taken before the headers are drained: the request is fully identified
        // by its first line, and everything after it is server residence time
        // the exchange already accounts for.
        let t1 = qpc();

        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").to_string();
        let path = path.split('?').next().unwrap_or("").to_string();

        let mut content_length = 0usize;
        loop {
            let mut header = String::new();
            match reader.read_line(&mut header) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            if header == "\r\n" || header == "\n" {
                break;
            }
            let lower = header.to_ascii_lowercase();
            if let Some(v) = lower.strip_prefix("content-length:") {
                content_length = v.trim().parse().unwrap_or(0);
            }
        }

        let mut body = String::new();
        if content_length > 0 {
            // A malformed or hostile length must not be able to allocate the
            // machine's memory; an SDP offer is a few kilobytes.
            if content_length > 256 * 1024 {
                let _ = writer.write_all(status(413).as_bytes());
                return;
            }
            let mut buf = vec![0u8; content_length];
            if reader.read_exact(&mut buf).is_err() {
                return;
            }
            body = String::from_utf8_lossy(&buf).into_owned();
        }

        let response = match (method.as_str(), path.as_str()) {
            ("OPTIONS", _) => ok_json(String::new()),
            ("GET", "/health") | ("HEAD", "/health") => {
                ok_json(format!("{{\"ok\":true,\"freq\":{freq}}}"))
            }
            ("GET", "/qpc") => {
                let t2 = qpc();
                ok_json(format!(
                    "{{\"freq\":{freq},\"t1_ticks\":{t1},\"t2_ticks\":{t2},\"t1_ms\":{:.6},\"t2_ms\":{:.6}}}",
                    ticks_to_ms(t1, freq),
                    ticks_to_ms(t2, freq)
                ))
            }
            ("POST", "/reoffer") => match handle_reoffer(&signaling, &body) {
                Ok(json) => ok_json(json),
                Err(e) => {
                    eprintln!("re-offer rejected: {e}");
                    ok_json(format!("{{\"error\":{}}}", J::s(e).render()))
                }
            },
            ("POST", "/offer") => match handle_offer(&signaling, &body) {
                Ok(json) => ok_json(json),
                Err(e) => {
                    eprintln!("offer rejected: {e}");
                    ok_json(format!("{{\"error\":{}}}", J::s(e).render()))
                }
            },
            ("GET", "/hostreport") => {
                let rendered = match signaling.report.lock() {
                    Ok(r) => r.render(),
                    Err(poisoned) => poisoned.into_inner().render(),
                };
                ok_json(rendered)
            }
            _ => status(404),
        };
        if writer.write_all(response.as_bytes()).is_err() || writer.flush().is_err() {
            return;
        }
    }
}

/// Build the arm the host was started as, answer the offer, and hand the sink
/// to the transport thread.
///
/// The three branches are the only place in the process that names a concrete
/// arm. `pipeline.rs` drives whatever comes out of here through
/// [`VideoSink`] alone, which is what "the seam is real" was supposed to mean
/// and, measured across stage 2, is what it cost: two new arms, three branches
/// here, and no change to capture or encode.
fn handle_offer(signaling: &Signaling, offer: &str) -> Result<String, String> {
    if offer.trim().is_empty() {
        return Err("empty offer body".into());
    }
    let (answer, client, udp, sink): (String, String, SocketAddr, Box<dyn VideoSink + Send>) =
        match signaling.arm {
            Arm::DataChannel => {
                let mut sink = crate::sinks::data_channel::DataChannelSink::bind(
                    signaling.udp_bind,
                    signaling.codec,
                    signaling.dc_load_bps,
                    Arc::clone(&signaling.reoffer),
                )?;
                let answer = sink.accept_offer(offer)?;
                let client = sink.client_config().render();
                let udp = sink.local_addr();
                (answer, client, udp, Box::new(sink))
            }
            Arm::RtpTrack => {
                let mut sink = crate::sinks::rtp_track::RtpTrackSink::bind(
                    signaling.udp_bind,
                    signaling.codec,
                    signaling.encoder_bps,
                    signaling.bwe,
                    Arc::clone(&signaling.reoffer),
                )?;
                let answer = sink.accept_offer(offer)?;
                let client = sink.client_config().render();
                let udp = sink.local_addr();
                (answer, client, udp, Box::new(sink))
            }
            Arm::RtpScriptTransform => {
                let mut sink = crate::sinks::script_transform::ScriptTransformSink::bind(
                    signaling.udp_bind,
                    signaling.codec,
                    signaling.encoder_bps,
                    signaling.bwe,
                    Arc::clone(&signaling.reoffer),
                )?;
                let answer = sink.accept_offer(offer)?;
                let client = sink.client_config().render();
                let udp = sink.local_addr();
                (answer, client, udp, Box::new(sink))
            }
        };
    signaling
        .sink_tx
        .try_send(sink)
        .map_err(|e| format!("pipeline is not accepting peers: {e}"))?;
    Ok(format!(
        "{{\"answer\":{},\"client\":{client},\"hostUdp\":{},\"qpcFreq\":{}}}",
        J::s(answer).render(),
        J::s(udp.to_string()).render(),
        qpf()
    ))
}

/// Hand an ICE restart to the live sink and wait for its answer.
///
/// The wait is bounded: `pipeline.rs` polls the sink on a 1 ms budget, so an
/// answer that has not appeared in [`REOFFER_TIMEOUT`] means there is no live
/// sink, not a slow one. A timeout clears the request so a stale offer cannot
/// be answered minutes later by the next peer.
fn handle_reoffer(signaling: &Signaling, offer: &str) -> Result<String, String> {
    if offer.trim().is_empty() {
        return Err("empty re-offer body".into());
    }
    {
        let mut slot = signaling
            .reoffer
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if slot.request.is_some() {
            return Err("a re-offer is already in flight".into());
        }
        slot.answer = None;
        slot.request = Some(offer.to_string());
    }
    let deadline = std::time::Instant::now() + REOFFER_TIMEOUT;
    loop {
        {
            let mut slot = signaling
                .reoffer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(answer) = slot.answer.take() {
                let answer = answer?;
                return Ok(format!("{{\"answer\":{}}}", J::s(answer).render()));
            }
            if std::time::Instant::now() >= deadline {
                slot.request = None;
                return Err("no live peer answered the re-offer".into());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

fn ok_json(body: String) -> String {
    format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: content-type\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Cache-Control: no-store\r\n\
         Connection: keep-alive\r\n\
         \r\n{body}",
        body.len()
    )
}

fn status(code: u16) -> String {
    format!(
        "HTTP/1.1 {code} \r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: keep-alive\r\n\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cors_is_open_because_the_page_is_served_by_the_other_server() {
        let r = ok_json("{}".into());
        assert!(r.contains("Access-Control-Allow-Origin: *"), "{r}");
        assert!(r.contains("Content-Length: 2"), "{r}");
    }

    #[test]
    fn a_404_carries_no_body() {
        assert!(status(404).contains("Content-Length: 0"));
    }
}
