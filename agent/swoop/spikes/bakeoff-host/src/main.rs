//! swoop spike 0.2 — video-path bake-off, host half.
//!
//! **Stage 1 scope: the shared front half plus arm B.** Arms A and C are stage
//! 2 and slot in behind [`sink::VideoSink`] without touching capture, encode or
//! this file's plumbing.
//!
//! ```text
//! cd agent/swoop/spikes/bakeoff-host   # never --manifest-path: it drops
//!                                      # .cargo/config.toml and +crt-static
//! cargo build --release
//! cargo run --release -- outputs
//! cargo run --release -- serve                                  # 127.0.0.1, H.264
//! cargo run --release -- serve --codec hevc
//! cargo run --release -- serve --bind 192.168.1.50 --http-bind 0.0.0.0   # LAN row
//! cargo run --release -- serve --vui-off                        # negative control
//! cargo run --release -- serve --bwe                            # with str0m's pacer
//! ```
//!
//! Then start the page server and point Chrome at it:
//!
//! ```text
//! cd agent/swoop/spikes/bakeoff-web
//! node server.mjs                      # http://127.0.0.1:17440/
//! ```
//!
//! ```text
//! chrome.exe --user-data-dir=<temp-dir> --no-first-run --no-default-browser-check ^
//!            --disable-extensions ^
//!            --disable-background-timer-throttling --disable-renderer-backgrounding ^
//!            --disable-backgrounding-occluded-windows ^
//!            --window-position=<on the OTHER monitor> --window-size=1400,1000 ^
//!            --new-window "http://127.0.0.1:17440/?arm=b&n=150&warmup=120&autorun=1"
//! ```
//!
//! Three of those are not optional on this box:
//!
//! - **`--disable-extensions`.** A fresh `--user-data-dir` is not a clean
//!   profile here: machine-wide external extensions install themselves into it,
//!   and one of them stopped the page's module graph from evaluating. The only
//!   symptom was a page that loaded and did nothing — the same failure spike 0.9
//!   hit, with the same absence of any error anywhere.
//! - **`--new-window`, not `--app`.** In app mode the window navigated itself to
//!   `/` immediately after the module graph loaded, losing the query string and
//!   aborting the run.
//! - **Put the browser on the monitor that is *not* being captured.** Otherwise
//!   Desktop Duplication captures the page showing the video, the encoder spends
//!   its bitrate on a delayed copy of itself, and a same-machine row measures a
//!   feedback loop. `_rv` excludes the client's compositor and panel (spike 0.1
//!   §2.1), so which monitor the browser is on does not affect the number.
//!
//! Two operational constraints, both bought by earlier spikes and neither
//! re-derived here:
//!
//! - **Run on monitor 0.** Spike 0.1 §4.2 measured `GetFrameStatistics`
//!   resolving 5 of 200 presents on the rotated secondary against 200 of 200 on
//!   the primary. `serve` refuses a non-primary output unless `--allow-secondary`
//!   is passed.
//! - **Same-machine rows rank arms; they are never a product latency**
//!   (spike 0.1 §2.2). The label travels in the run's own JSON, not just in the
//!   memo.
//!
//! Hardware-dependent tests across this crate are `#[ignore]`d. Manual
//! invocation:
//!
//! ```text
//! cd agent/swoop/spikes/bakeoff-host
//! cargo test -- --ignored --nocapture
//! ```

mod capture;
mod clock;
mod dxgi;
mod httpd;
mod json;
mod motion;
mod nal;
mod nvenc;
mod pipeline;
mod sink;
mod sinks;
mod stats;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};

use crate::capture::{CaptureConfig, CaptureReport, Control};
use crate::json::J;
use crate::nal::Codec;
use crate::sink::Arm;

/// How many encoded frames may wait for the transport thread. Four at 60 fps is
/// 66 ms: long enough to ride out a scheduling hiccup, short enough that a
/// wedged transport thread shows up as a counted drop rather than as latency
/// hidden in a queue.
const FRAME_QUEUE: usize = 4;

struct Args {
    command: String,
    arm: Arm,
    output: Option<usize>,
    codec: Codec,
    fps: u32,
    bitrate_bps: u32,
    bind: String,
    http_bind: String,
    http_port: u16,
    motion: bool,
    allow_secondary: bool,
    bitstream_restriction: bool,
    /// Bandwidth estimation, and with it str0m's leaky-bucket pacer. Off by
    /// default: measured on this box the pacer, not the video path, dominated
    /// every figure (see `sinks::rtp_track`'s module doc).
    bwe: bool,
    /// Recorded verbatim in the run's JSON. `same-machine` rows carry the words
    /// *ranking only* into the file itself (spike 0.1 §2.2).
    placement: String,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            command: "serve".into(),
            arm: Arm::RtpTrack,
            output: None,
            codec: Codec::H264,
            fps: 60,
            bitrate_bps: 20_000_000,
            bind: "127.0.0.1".into(),
            http_bind: "127.0.0.1".into(),
            http_port: 17441,
            motion: true,
            allow_secondary: false,
            bitstream_restriction: true,
            bwe: false,
            placement: "same-machine".into(),
        }
    }
}

fn parse_args_from(raw: &[String]) -> Result<Args, String> {
    let mut args = Args::default();
    let mut i = 0;
    if let Some(first) = raw.first() {
        if !first.starts_with("--") {
            args.command = first.clone();
            i = 1;
        }
    }
    while i < raw.len() {
        let flag = raw[i].clone();
        // Flags that take no value first, so the value-consuming arm below can
        // advance by two unconditionally.
        match flag.as_str() {
            "--no-motion" => {
                args.motion = false;
                i += 1;
                continue;
            }
            "--allow-secondary" => {
                args.allow_secondary = true;
                i += 1;
                continue;
            }
            "--vui-off" => {
                args.bitstream_restriction = false;
                i += 1;
                continue;
            }
            "--bwe" => {
                args.bwe = true;
                i += 1;
                continue;
            }
            _ => {}
        }
        let value = raw
            .get(i + 1)
            .cloned()
            .ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--arm" => {
                args.arm = Arm::parse(&value)
                    .ok_or_else(|| format!("--arm a|b|c, not {value}"))?;
            }
            "--output" => args.output = Some(value.parse().map_err(|_| "--output N")?),
            "--codec" => {
                args.codec = match value.as_str() {
                    "h264" => Codec::H264,
                    "hevc" | "h265" => Codec::Hevc,
                    other => return Err(format!("--codec h264|hevc, not {other}")),
                }
            }
            "--fps" => args.fps = value.parse().map_err(|_| "--fps N")?,
            "--bitrate" => {
                args.bitrate_bps = value
                    .parse::<u32>()
                    .map_err(|_| "--bitrate BITS_PER_SECOND")?
            }
            "--bind" => args.bind = value,
            "--http-bind" => args.http_bind = value,
            "--http-port" => args.http_port = value.parse().map_err(|_| "--http-port N")?,
            "--placement" => args.placement = value,
            other => return Err(format!("unknown flag {other}")),
        }
        i += 2;
    }
    Ok(args)
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args_from(&raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("bakeoff-host: {e}");
            std::process::exit(64);
        }
    };
    // Before the first DXGI call, or spike 0.8 §3's 125 %-scaled monitor is
    // read 25 % small and every coordinate after it is wrong.
    unsafe {
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
            windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        );
    }
    let result = match args.command.as_str() {
        "outputs" => outputs(),
        "serve" => serve(args),
        other => Err(format!("unknown command {other}; try `outputs` or `serve`")),
    };
    if let Err(e) = result {
        eprintln!("bakeoff-host: {e}");
        std::process::exit(1);
    }
}

fn outputs() -> Result<(), String> {
    let outputs = dxgi::enumerate_outputs().map_err(|e| format!("enumerate: {e}"))?;
    println!(
        "idx  ad  sw    adapter                                    device        bounds                      attached rotation  primary"
    );
    for o in &outputs {
        println!(
            "{:<4} {:<3} {:<5} {:<42} {:<13} {:>6},{:<6} {:>5}x{:<5} {:<8} {:<9} {}",
            o.global_index,
            o.adapter_index,
            o.adapter_software,
            truncate(&o.adapter_description, 42),
            o.device_name.trim_start_matches(r"\\.\"),
            o.bounds.0,
            o.bounds.1,
            o.width(),
            o.height(),
            o.attached_to_desktop,
            o.rotation,
            o.is_primary()
        );
    }
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n - 1).chain("…".chars()).collect()
    }
}

fn serve(args: Args) -> Result<(), String> {
    if args.arm != Arm::RtpTrack {
        return Err(format!(
            "arm {} ({}) is stage 2 of spike 0.2. Stage 1 ships the shared front half and arm b              only; both other arms slot in behind VideoSink without touching capture or encode.",
            args.arm.as_str(),
            args.arm.name()
        ));
    }
    let all = dxgi::enumerate_outputs().map_err(|e| format!("enumerate: {e}"))?;
    let index = match args.output {
        Some(i) => i,
        None => all
            .iter()
            .find(|o| o.attached_to_desktop && o.is_primary())
            .map(|o| o.global_index)
            .ok_or("no attached primary output; pass --output N")?,
    };
    let info = all
        .get(index)
        .ok_or_else(|| format!("no output with index {index}"))?;
    if !info.is_primary() && !args.allow_secondary {
        return Err(format!(
            "output {index} ({}) is not the primary. Spike 0.1 §4.2 measured frame statistics \
             resolving 5 of 200 presents on the rotated secondary of this box against 200 of 200 \
             on the primary, so every row in this spike runs on monitor 0. Pass --allow-secondary \
             if you really mean it.",
            info.device_name
        ));
    }
    println!(
        "output {index}: {} {}x{} on {}",
        info.device_name,
        info.width(),
        info.height(),
        info.adapter_description
    );

    let udp_bind: SocketAddr = format!("{}:0", args.bind)
        .parse()
        .map_err(|e| format!("--bind {}: {e}", args.bind))?;
    let http_bind: SocketAddr = format!("{}:{}", args.http_bind, args.http_port)
        .parse()
        .map_err(|e| format!("--http-bind {}: {e}", args.http_bind))?;

    let control = Arc::new(Control::default());
    control.running.store(true, Ordering::Relaxed);
    let capture_report = Arc::new(Mutex::new(CaptureReport::default()));
    let published = Arc::new(Mutex::new(J::Obj(vec![("state", J::s("starting"))])));
    let (frame_tx, frame_rx) = sync_channel(FRAME_QUEUE);
    let (sink_tx, sink_rx) = sync_channel(1);

    let motion_running = Arc::new(AtomicBool::new(args.motion));
    if args.motion {
        let bounds = info.bounds;
        let running = Arc::clone(&motion_running);
        std::thread::Builder::new()
            .name("motion".into())
            .spawn(move || {
                if let Err(e) = motion::run(bounds, running) {
                    eprintln!("motion window: {e}");
                }
            })
            .map_err(|e| format!("spawn motion thread: {e}"))?;
    }

    let capture_cfg = CaptureConfig {
        output_index: index,
        codec: args.codec,
        fps: args.fps,
        bitrate_bps: args.bitrate_bps,
        bitstream_restriction: args.bitstream_restriction,
    };
    {
        let control = Arc::clone(&control);
        let published = Arc::clone(&capture_report);
        std::thread::Builder::new()
            .name("capture".into())
            .spawn(move || capture::run(capture_cfg, control, frame_tx, published))
            .map_err(|e| format!("spawn capture thread: {e}"))?;
    }

    let signaling = Arc::new(httpd::Signaling {
        udp_bind,
        codec: args.codec,
        encoder_bps: args.bitrate_bps as u64,
        bwe: args.bwe,
        sink_tx,
        report: Arc::clone(&published),
    });
    let port = httpd::spawn(http_bind, signaling).map_err(|e| format!("bind {http_bind}: {e}"))?;
    println!("host signalling + clock: http://{}:{}/", args.http_bind, port);
    println!(
        "  arm {} ({}), codec {}, udp on {}, placement \"{}\"",
        args.arm.as_str(),
        args.arm.name(),
        codec_name(args.codec),
        args.bind,
        args.placement
    );
    if args.placement == "same-machine" {
        println!("  NOTE: same-machine rows rank arms. They are never a product latency (0.1 §2.2).");
    }

    let config = vec![
        ("spike", J::s("0.2 stage 1 — shared front half + arm B")),
        ("arm", J::s(args.arm.as_str())),
        ("armName", J::s(args.arm.name())),
        ("codec", J::s(codec_name(args.codec))),
        ("fps", J::Uint(args.fps as u64)),
        ("bitrateBps", J::Uint(args.bitrate_bps as u64)),
        ("bitstreamRestriction", J::Bool(args.bitstream_restriction)),
        ("bwe", J::Bool(args.bwe)),
        ("motionWindow", J::Bool(args.motion)),
        ("udpBind", J::s(args.bind.clone())),
        ("placement", J::s(args.placement.clone())),
        (
            "placementNote",
            J::s(if args.placement == "same-machine" {
                "ranking only — never an absolute product latency (spike 0.1 §2.2)"
            } else {
                "real LAN hop — assert the selected candidate pair from getStats"
            }),
        ),
        ("qpcFreq", J::Uint(clock::qpf() as u64)),
    ];

    pipeline::run(pipeline::Pipeline {
        frames: frame_rx,
        sinks: sink_rx,
        control: Arc::clone(&control),
        capture_report,
        published,
        config,
        encoder_target_bps: args.bitrate_bps,
    });
    motion_running.store(false, Ordering::Relaxed);
    Ok(())
}

fn codec_name(codec: Codec) -> &'static str {
    match codec {
        Codec::H264 => "h264",
        Codec::Hevc => "hevc",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_one_refuses_the_two_arms_it_did_not_build() {
        for arm in ["a", "c"] {
            let raw = vec!["serve".to_string(), "--arm".to_string(), arm.to_string()];
            let parsed = parse_args_from(&raw).expect("parse");
            let err = serve(parsed).expect_err("stage 1 must refuse it");
            assert!(err.contains("stage 2"), "{err}");
        }
    }

    #[test]
    fn the_default_run_is_h264_on_loopback_with_the_vui_fix_on() {
        let a = Args::default();
        assert_eq!(a.arm, Arm::RtpTrack);
        assert_eq!(a.codec, Codec::H264);
        assert_eq!(a.bind, "127.0.0.1");
        assert!(a.bitstream_restriction);
        assert!(!a.bwe);
        assert!(a.motion);
        assert_eq!(a.placement, "same-machine");
    }

    #[test]
    fn flags_without_values_do_not_swallow_the_next_flag() {
        let raw: Vec<String> = ["serve", "--vui-off", "--codec", "hevc", "--no-motion"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let a = parse_args_from(&raw).expect("parse");
        assert_eq!(a.command, "serve");
        assert!(!a.bitstream_restriction);
        assert_eq!(a.codec, Codec::Hevc);
        assert!(!a.motion);
    }

    #[test]
    fn a_value_flag_with_no_value_is_an_error_not_a_panic() {
        let raw = vec!["serve".to_string(), "--codec".to_string()];
        assert!(parse_args_from(&raw).is_err());
    }

    #[test]
    fn truncate_never_widens_a_string() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("0123456789", 5).chars().count(), 5);
    }

    #[test]
    fn the_frame_queue_is_small_enough_to_surface_a_stall() {
        // Four frames at 60 fps is 66 ms. A deeper queue would hide a wedged
        // transport thread as latency instead of reporting it as a drop.
        assert_eq!(FRAME_QUEUE, 4);
    }
}
