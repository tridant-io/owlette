//! swoop spike 0.1 - latency harness, host half.
//!
//! Two jobs, and no pipeline:
//!
//! 1. **`flip`** - a `WH_MOUSE_LL` hook and a borderless fullscreen window on a
//!    DXGI flip-model swapchain. Every left-button-down is timestamped inside
//!    the hook, the window flips between black and white, and four QPC ticks
//!    plus the vertical blank the present was displayed at
//!    (`DXGI_FRAME_STATISTICS::SyncQPCTime`) go to a CSV. This is the
//!    host-local input-to-flip half of the measurement contract, and the thing
//!    a slow-motion camera films to close the photon half.
//! 2. **`clock`** - a loopback HTTP endpoint at `/qpc` that the browser probe
//!    in `../latency-probe-web` uses to relate `QueryPerformanceCounter` to
//!    `performance.now()` with a four-timestamp NTP exchange. The endpoint runs
//!    during `flip` too, so one process serves a camera run and a clock run.
//!
//! Runs as the ordinary interactive user. No elevation, no service, no UAC.
//! The only system state it touches is the cursor position, which it saves and
//! restores, and injected left clicks when `--autoclick` is on.
//!
//! ```text
//! cd agent/swoop/spikes/latency-target
//! cargo build --release
//!
//! # list the monitors, so --monitor N can be chosen deliberately
//! cargo run --release -- monitors
//!
//! # machine-driven series: 150 injected clicks at 5 Hz on monitor 0
//! cargo run --release -- flip --monitor 0 --seconds 32 --autoclick 5 --csv runs/flip.csv
//!
//! # camera pass: no injection, the human clicks a real mouse in frame
//! cargo run --release -- flip --monitor 0 --seconds 240 --autoclick 0 --csv runs/photon.csv
//!
//! # clock endpoint only, while the browser probe runs its offset exchange
//! cargo run --release -- clock --seconds 120
//! ```
//!
//! Esc ends a `flip` run early. A watchdog force-exits the process 10 s past
//! the deadline so a wedged pump can never leave a topmost fullscreen window
//! owning the screen.
//!
//! Tests that need a desktop, a GPU or a loopback socket are `#[ignore]`d.
//! Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/latency-target
//! cargo test                             # pure maths only
//! cargo test -- --ignored --nocapture    # the environment-dependent ones
//! ```

mod clock;
mod flip;
mod stats;

use std::sync::Arc;

const DEFAULT_PORT: u16 = 17431;

struct Args {
    command: String,
    monitor: usize,
    seconds: f64,
    autoclick: f64,
    warmup: usize,
    port: u16,
    csv: Option<String>,
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut args = Args {
        command: argv.first().cloned().unwrap_or_else(|| "monitors".into()),
        monitor: 0,
        seconds: 30.0,
        autoclick: 0.0,
        warmup: 10,
        port: DEFAULT_PORT,
        csv: None,
    };
    let mut i = 1;
    while i < argv.len() {
        let flag = argv[i].as_str();
        let value = argv.get(i + 1).cloned().unwrap_or_default();
        match flag {
            "--monitor" => args.monitor = value.parse().unwrap_or(0),
            "--seconds" => args.seconds = value.parse().unwrap_or(30.0),
            "--autoclick" => args.autoclick = value.parse().unwrap_or(0.0),
            "--warmup" => args.warmup = value.parse().unwrap_or(10),
            "--port" => args.port = value.parse().unwrap_or(DEFAULT_PORT),
            "--csv" => args.csv = Some(value),
            other => {
                eprintln!("latency-target: unknown flag {other}");
                std::process::exit(64);
            }
        }
        i += 2;
    }
    args
}

fn main() {
    let args = parse_args();
    flip::set_dpi_awareness();

    match args.command.as_str() {
        "monitors" => {
            for m in flip::monitors() {
                println!(
                    "monitor {} device={} bounds=({},{})-({},{}) size={}x{}{}",
                    m.index,
                    m.device,
                    m.bounds.left,
                    m.bounds.top,
                    m.bounds.right,
                    m.bounds.bottom,
                    m.width(),
                    m.height(),
                    if m.primary { " primary" } else { "" }
                );
            }
        }
        "clock" => {
            let stats = Arc::new(clock::ClockStats::default());
            match clock::spawn(args.port, Arc::clone(&stats)) {
                Ok(port) => {
                    println!("clock endpoint: http://127.0.0.1:{port}/qpc  qpf={}", clock::qpf());
                    println!("serving for {:.0} s", args.seconds);
                    std::thread::sleep(std::time::Duration::from_secs_f64(args.seconds));
                    println!(
                        "served {} /qpc requests",
                        stats
                            .qpc_requests
                            .load(std::sync::atomic::Ordering::Relaxed)
                    );
                }
                Err(e) => {
                    eprintln!("latency-target: could not bind port {}: {e}", args.port);
                    std::process::exit(1);
                }
            }
        }
        "flip" => {
            let clock_stats = Arc::new(clock::ClockStats::default());
            match clock::spawn(args.port, Arc::clone(&clock_stats)) {
                Ok(port) => println!("clock endpoint: http://127.0.0.1:{port}/qpc"),
                Err(e) => eprintln!("latency-target: clock endpoint unavailable ({e})"),
            }
            let cfg = flip::RunConfig {
                monitor: args.monitor,
                seconds: args.seconds,
                autoclick_hz: args.autoclick,
                warmup: args.warmup,
                csv_path: args.csv.clone(),
            };
            match flip::run(&cfg) {
                Ok(result) => match flip::report(&result, cfg.csv_path.as_deref()) {
                    Ok(text) => print!("{text}"),
                    Err(e) => {
                        eprintln!("latency-target: could not write the CSV: {e}");
                        std::process::exit(1);
                    }
                },
                Err(e) => {
                    eprintln!("latency-target: run failed: {e}");
                    std::process::exit(1);
                }
            }
        }
        other => {
            eprintln!("latency-target: unknown command {other}");
            eprintln!("usage: latency-target <monitors|flip|clock> [flags]");
            std::process::exit(64);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_default_port_is_the_one_the_probe_page_expects() {
        // ../latency-probe-web/public/probe.js has this baked in as its default
        // clock origin; changing one without the other silently breaks the
        // offset exchange.
        assert_eq!(super::DEFAULT_PORT, 17431);
    }
}
