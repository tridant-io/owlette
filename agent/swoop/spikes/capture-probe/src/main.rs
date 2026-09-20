//! swoop spike 0.8 - DXGI Desktop Duplication capture probe.
//!
//! Measures Desktop Duplication on the dev box as the ordinary interactive
//! user: no elevation, no service, no injection, no encode, no transport. The
//! numbers it prints are the input to Task 3.6 (capture), 4.4 (cursor), 5.7
//! (capture edge cases) and 6.4 (displays).
//!
//! Every run writes to stdout only after the measurement window closes where it
//! matters, because the probe's own console output is itself desktop activity.
//!
//! Subcommands (`--output N` is the global output index printed by
//! `enumerate`):
//!
//! ```text
//! cd agent/swoop/spikes/capture-probe
//! cargo run --release -- enumerate
//! cargo run --release -- surface       --output 0
//! cargo run --release -- pacing        --output 0 --timeout 0 --seconds 15 --scene flood
//! cargo run --release -- rects         --output 0 --seconds 15 --scene scroll
//! cargo run --release -- pointer       --output 0 --seconds 20 --scene cursor
//! cargo run --release -- idle          --output 0 --seconds 60 --timeout 16
//! cargo run --release -- accesslost    --output 0 --repeats 3
//! ```
//!
//! Tests that need a GPU, a desktop or the live display configuration are
//! `#[ignore]`d. Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/capture-probe
//! cargo test                      # pure maths only
//! cargo test -- --ignored --nocapture   # the hardware-dependent ones
//! ```

mod display;
mod dxgi;
mod generator;
mod runs;
mod stats;

use std::time::Duration;

use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R10G10B10A2_UNORM,
    DXGI_FORMAT_R16G16B16A16_FLOAT,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

use generator::Scene;

/// `DuplicateOutput1` format preference lists, in the order Task 3.6 would try
/// them: the SDR path, the HDR10 path, and the scRGB path.
pub const FORMAT_SETS: &[(&str, &[DXGI_FORMAT])] = &[
    ("[BGRA8]", &[DXGI_FORMAT_B8G8R8A8_UNORM]),
    (
        "[BGRA8,RGB10A2,RGBA16F]",
        &[
            DXGI_FORMAT_B8G8R8A8_UNORM,
            DXGI_FORMAT_R10G10B10A2_UNORM,
            DXGI_FORMAT_R16G16B16A16_FLOAT,
        ],
    ),
    ("[RGB10A2]", &[DXGI_FORMAT_R10G10B10A2_UNORM]),
    ("[RGBA16F]", &[DXGI_FORMAT_R16G16B16A16_FLOAT]),
];

struct Args {
    command: String,
    output: usize,
    timeout: u32,
    seconds: f64,
    repeats: u32,
    scene: Option<Scene>,
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut args = Args {
        command: argv.first().cloned().unwrap_or_else(|| "enumerate".into()),
        output: 0,
        timeout: 16,
        seconds: 15.0,
        repeats: 3,
        scene: None,
    };
    let mut i = 1;
    while i + 1 < argv.len() {
        let value = &argv[i + 1];
        match argv[i].as_str() {
            "--output" => args.output = value.parse().unwrap_or(0),
            "--timeout" => args.timeout = value.parse().unwrap_or(16),
            "--seconds" => args.seconds = value.parse().unwrap_or(15.0),
            "--repeats" => args.repeats = value.parse().unwrap_or(3),
            "--scene" => {
                args.scene = match value.as_str() {
                    "flood" => Some(Scene::Flood),
                    "drag" => Some(Scene::Drag),
                    "scroll" => Some(Scene::Scroll),
                    "cursor" => Some(Scene::Cursor),
                    _ => None,
                }
            }
            _ => {}
        }
        i += 2;
    }
    args
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Per-monitor v2 before any DXGI call: without it DesktopCoordinates and
    // GetDpiForMonitor are virtualised, and DuplicateOutput1 is documented to
    // refuse a process that is not per-monitor DPI aware.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    let args = parse_args();
    println!(
        "capture-probe {} | qpc_frequency={} Hz | command={}",
        env!("CARGO_PKG_VERSION"),
        runs::qpc_frequency(),
        args.command
    );

    match args.command.as_str() {
        "enumerate" => runs::run_enumerate()?,
        "surface" => runs::print_surface_facts(args.output)?,
        "pacing" => {
            let report = runs::run_pacing(args.output, args.timeout, args.seconds, args.scene)?;
            runs::print_pacing(&report);
        }
        "rects" => {
            let report = runs::run_rects(args.output, args.seconds, args.scene)?;
            runs::print_rects(&report);
        }
        "pointer" => {
            let report = runs::run_pointer(args.output, args.seconds, args.scene)?;
            runs::print_pointer(&report);
        }
        "idle" => {
            let report = runs::run_idle(args.output, args.seconds, args.timeout)?;
            runs::print_idle(&report);
        }
        "accesslost" => run_access_lost(args.output, args.repeats)?,
        other => {
            eprintln!("unknown command {other}; see the module doc comment");
            std::process::exit(2);
        }
    }
    Ok(())
}

/// Force ACCESS_LOST with a temporary mode change, measure recovery, restore
/// the mode, and measure the recovery from the restore as a second event.
fn run_access_lost(output_index: usize, repeats: u32) -> Result<(), Box<dyn std::error::Error>> {
    let (_, _, info) = dxgi::open_output(output_index)?;
    let device_name = info.device_name.clone();
    let original = display::current_mode(&device_name)
        .ok_or("EnumDisplaySettingsExW(ENUM_CURRENT_SETTINGS) failed")?;
    let smaller = display::pick_smaller_mode(&device_name, &original)
        .ok_or("no smaller mode at the same refresh rate and depth")?;
    println!(
        "\n-- accesslost output global={} {} : {}x{}@{} -> {}x{}@{} (CDS_FULLSCREEN, restored each round) --",
        output_index,
        device_name,
        original.dmPelsWidth,
        original.dmPelsHeight,
        original.dmDisplayFrequency,
        smaller.dmPelsWidth,
        smaller.dmPelsHeight,
        smaller.dmDisplayFrequency
    );

    let mut events = Vec::new();
    for round in 0..repeats {
        let name = device_name.clone();
        let event = runs::measure_access_lost(output_index, "mode change (shrink)", move || {
            let code = display::apply_mode(&name, &smaller);
            if !display::succeeded(code) {
                eprintln!("  shrink ChangeDisplaySettingsExW -> {}", display::disp_change_name(code));
            }
        })?;
        runs::print_lost(&event);
        events.push(event);

        std::thread::sleep(Duration::from_millis(800));

        let name = device_name.clone();
        let event = runs::measure_access_lost(output_index, "mode change (restore)", move || {
            let code = display::apply_mode(&name, &original);
            if !display::succeeded(code) {
                eprintln!("  restore ChangeDisplaySettingsExW -> {}", display::disp_change_name(code));
            }
        })?;
        runs::print_lost(&event);
        events.push(event);

        std::thread::sleep(Duration::from_millis(800));
        println!("  round {} of {} done", round + 1, repeats);
    }

    // Belt and braces: whatever happened above, put the mode back.
    let code = display::apply_mode(&device_name, &original);
    println!(
        "final restore -> {} ({}x{}@{})",
        display::disp_change_name(code),
        original.dmPelsWidth,
        original.dmPelsHeight,
        original.dmDisplayFrequency
    );

    let finite = |f: fn(&runs::LostEvent) -> f64| -> Vec<f64> {
        events.iter().map(f).filter(|v| v.is_finite()).collect()
    };
    let zero_present = events.iter().filter(|e| e.first_any_present_zero).count();
    println!("\naggregate over {} ACCESS_LOST events:", events.len());
    runs::print_summary("trigger -> detect (ms)", &stats::summarize(&finite(|e| e.detect_ms)));
    runs::print_summary(
        "detect -> duplication recreated (ms)",
        &stats::summarize(&finite(|e| e.recreate_ms)),
    );
    runs::print_summary(
        "recreated -> first AcquireNextFrame (ms)",
        &stats::summarize(&finite(|e| e.first_any_ms)),
    );
    runs::print_summary(
        "recreated -> first frame carrying a desktop image (ms)",
        &stats::summarize(&finite(|e| e.first_frame_ms)),
    );
    runs::print_summary("detect -> first desktop image (ms)", &stats::summarize(&finite(|e| e.total_ms)));
    println!(
        "first AcquireNextFrame after recreate had LastPresentTime==0 in {} of {} events",
        zero_present,
        events.len()
    );
    Ok(())
}
