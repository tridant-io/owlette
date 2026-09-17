//! The measurement runs: pacing, rect metadata, pointer, idle timeout rate and
//! ACCESS_LOST recovery.
//!
//! Every run here needs a GPU and an attached desktop, so the tests that drive
//! them are `#[ignore]`d. Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/capture-probe
//! cargo test -- --ignored --nocapture
//! ```

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D, D3D11_TEXTURE2D_DESC};
use windows::Win32::Graphics::Dxgi::{
    IDXGIOutput, IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST,
    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_MOVE_RECT,
    DXGI_OUTDUPL_POINTER_SHAPE_INFO,
};
use windows::Win32::System::Performance::QueryPerformanceFrequency;

use crate::dxgi::{self, format_name, rotation_name, OutputInfo};
use crate::generator::{Generator, GeneratorCounters, Scene};
use crate::stats::{summarize, Histogram, Rect, Summary, INTERVAL_EDGES_MS};

pub fn qpc_frequency() -> i64 {
    let mut freq = 0i64;
    unsafe {
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    if freq == 0 {
        10_000_000
    } else {
        freq
    }
}

/// Everything one `AcquireNextFrame` call produced, before any per-run
/// interpretation.
struct Acquired {
    info: DXGI_OUTDUPL_FRAME_INFO,
}

enum AcquireOutcome {
    Frame(Acquired),
    Timeout,
    AccessLost,
    Other(windows::core::Error),
}

fn acquire(dup: &IDXGIOutputDuplication, timeout_ms: u32) -> (AcquireOutcome, f64) {
    let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
    let mut resource: Option<IDXGIResource> = None;
    let started = Instant::now();
    let result = unsafe { dup.AcquireNextFrame(timeout_ms, &mut info, &mut resource) };
    let call_ms = started.elapsed().as_secs_f64() * 1000.0;
    match result {
        Ok(()) => (AcquireOutcome::Frame(Acquired { info }), call_ms),
        Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => (AcquireOutcome::Timeout, call_ms),
        Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => (AcquireOutcome::AccessLost, call_ms),
        Err(e) => (AcquireOutcome::Other(e), call_ms),
    }
}

/// An unexpected `AcquireNextFrame` failure ends a run; it must be visible in
/// the transcript, not swallowed, or a short run looks like a clean one.
fn report_unexpected(run: &str, err: &windows::core::Error) {
    eprintln!(
        "  {run}: AcquireNextFrame failed with {} {} - run ended early",
        dxgi::hresult(err),
        err.message()
    );
}

// ---------------------------------------------------------------- enumerate

pub fn run_enumerate() -> dxgi::Result<()> {
    let adapters = dxgi::enumerate()?;
    println!("== adapters and outputs ==");
    let mut attached_rects: Vec<Rect> = Vec::new();

    for adapter in &adapters {
        println!(
            "adapter[{}] {:<44} vendor=0x{:04X} ({}) device=0x{:04X} subsys=0x{:08X} rev={} luid=0x{:016X} flags=0x{:X} vram={} MiB shared={} MiB software={} outputs={}",
            adapter.index,
            adapter.description,
            adapter.vendor_id,
            dxgi::vendor_name(adapter.vendor_id),
            adapter.device_id,
            adapter.subsys_id,
            adapter.revision,
            adapter.luid,
            adapter.flags,
            adapter.dedicated_video_memory_mb,
            adapter.shared_system_memory_mb,
            adapter.software,
            adapter.outputs.len()
        );
        for o in &adapter.outputs {
            let r = o.desktop_coordinates;
            println!(
                "  output[{}] global={} {} rect=({},{})-({},{}) {}x{} attached={} rotation={} dpi_eff={}x{} dpi_raw={}x{} bits_per_color={} colorspace={}",
                o.output_index,
                o.global_index,
                o.device_name,
                r.left,
                r.top,
                r.right,
                r.bottom,
                r.right - r.left,
                r.bottom - r.top,
                o.attached_to_desktop,
                rotation_name(o.rotation),
                o.effective_dpi.0,
                o.effective_dpi.1,
                o.raw_dpi.0,
                o.raw_dpi.1,
                o.bits_per_color,
                o.color_space
            );
            if o.attached_to_desktop {
                attached_rects.push(r);
            }
        }
    }

    match crate::stats::virtual_desktop_bounds(&attached_rects) {
        Some(b) => println!(
            "\nvirtual desktop origin=({},{}) extent={}x{} negative_origin={}",
            b.left,
            b.top,
            b.right - b.left,
            b.bottom - b.top,
            b.left < 0 || b.top < 0
        ),
        None => println!("\nvirtual desktop: no attached outputs"),
    }

    println!("\n== duplication matrix (device adapter x output) ==");
    let factory = dxgi::factory()?;
    for dev_adapter in &adapters {
        let adapter = match unsafe { factory.EnumAdapters1(dev_adapter.index) } {
            Ok(a) => a,
            Err(e) => {
                println!("adapter[{}] EnumAdapters1 failed {}", dev_adapter.index, dxgi::hresult(&e));
                continue;
            }
        };
        let device = match dxgi::create_device(&adapter) {
            Ok((d, _)) => d,
            Err(e) => {
                println!(
                    "adapter[{}] {} -> no D3D11 device ({})",
                    dev_adapter.index,
                    dev_adapter.description,
                    dxgi::hresult(&e)
                );
                continue;
            }
        };
        for out_adapter in &adapters {
            for o in &out_adapter.outputs {
                let (_, output, _) = match dxgi::open_output(o.global_index) {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let d1 = dxgi::duplicate(&output, &device);
                let verdict = match &d1 {
                    Ok(dup) => {
                        let desc = unsafe { dup.GetDesc() };
                        format!(
                            "OK format={} {}x{} rotation={} sysmem={}",
                            format_name(desc.ModeDesc.Format),
                            desc.ModeDesc.Width,
                            desc.ModeDesc.Height,
                            rotation_name(desc.Rotation),
                            desc.DesktopImageInSystemMemory.as_bool()
                        )
                    }
                    Err(e) => format!("{} {}", dxgi::hresult(e), e.message()),
                };
                println!(
                    "  device on adapter[{}] -> output global={} (adapter[{}] {}) : {}",
                    dev_adapter.index, o.global_index, out_adapter.index, o.device_name, verdict
                );
                drop(d1);
            }
        }
    }

    println!("\n== DuplicateOutput1 format negotiation (per attached output, own adapter) ==");
    for adapter_info in &adapters {
        for o in &adapter_info.outputs {
            if !o.attached_to_desktop {
                continue;
            }
            let (adapter, output, _) = dxgi::open_output(o.global_index)?;
            let (device, _) = match dxgi::create_device(&adapter) {
                Ok(t) => t,
                Err(_) => continue,
            };
            for (label, formats) in crate::FORMAT_SETS {
                match dxgi::duplicate1(&output, &device, formats) {
                    Ok(dup) => {
                        let desc = unsafe { dup.GetDesc() };
                        println!(
                            "  output global={} {:<22} -> OK negotiated={} {}x{}",
                            o.global_index,
                            label,
                            format_name(desc.ModeDesc.Format),
                            desc.ModeDesc.Width,
                            desc.ModeDesc.Height
                        );
                    }
                    Err(e) => println!(
                        "  output global={} {:<22} -> {} {}",
                        o.global_index,
                        label,
                        dxgi::hresult(&e),
                        e.message()
                    ),
                }
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ pacing

pub struct PacingReport {
    pub timeout_ms: u32,
    pub scene: &'static str,
    pub seconds: f64,
    pub calls: u64,
    pub desktop_frames: u64,
    pub pointer_only_frames: u64,
    pub timeouts: u64,
    pub access_lost: u64,
    pub intervals: Histogram,
    pub interval_summary: Summary,
    pub present_delta_summary: Summary,
    pub call_summary: Summary,
    pub accumulated_frames: BTreeMap<u32, u64>,
    pub generator_paints: u32,
}

pub fn run_pacing(
    output_index: usize,
    timeout_ms: u32,
    seconds: f64,
    scene: Option<Scene>,
) -> dxgi::Result<PacingReport> {
    let (adapter, output, info) = dxgi::open_output(output_index)?;
    let (device, _ctx) = dxgi::create_device(&adapter)?;
    let dup = dxgi::duplicate(&output, &device)?;
    let generator = scene.map(|s| Generator::start(s, info.desktop_coordinates));

    let freq = qpc_frequency() as f64;
    let mut intervals = Histogram::new(INTERVAL_EDGES_MS);
    let mut interval_samples = Vec::new();
    let mut present_samples = Vec::new();
    let mut call_samples = Vec::new();
    let mut accumulated: BTreeMap<u32, u64> = BTreeMap::new();
    let (mut calls, mut frames, mut pointer_only, mut timeouts, mut lost) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut prev_frame: Option<Instant> = None;
    let mut prev_present = 0i64;

    let started = Instant::now();
    while started.elapsed().as_secs_f64() < seconds {
        calls += 1;
        let (outcome, call_ms) = acquire(&dup, timeout_ms);
        call_samples.push(call_ms);
        match outcome {
            AcquireOutcome::Frame(a) => {
                if a.info.LastPresentTime != 0 {
                    frames += 1;
                    let now = Instant::now();
                    if let Some(prev) = prev_frame {
                        let dt = (now - prev).as_secs_f64() * 1000.0;
                        intervals.add(dt);
                        interval_samples.push(dt);
                    }
                    prev_frame = Some(now);
                    if prev_present != 0 {
                        present_samples
                            .push((a.info.LastPresentTime - prev_present) as f64 * 1000.0 / freq);
                    }
                    prev_present = a.info.LastPresentTime;
                    *accumulated.entry(a.info.AccumulatedFrames).or_insert(0) += 1;
                } else {
                    pointer_only += 1;
                }
                let _ = unsafe { dup.ReleaseFrame() };
            }
            AcquireOutcome::Timeout => timeouts += 1,
            AcquireOutcome::AccessLost => {
                lost += 1;
                break;
            }
            AcquireOutcome::Other(e) => {
                report_unexpected("pacing", &e);
                break;
            }
        }
    }

    let paints = Generator::counters().paints;
    drop(generator);

    Ok(PacingReport {
        timeout_ms,
        scene: scene_name(scene),
        seconds: started.elapsed().as_secs_f64(),
        calls,
        desktop_frames: frames,
        pointer_only_frames: pointer_only,
        timeouts,
        access_lost: lost,
        intervals,
        interval_summary: summarize(&interval_samples),
        present_delta_summary: summarize(&present_samples),
        call_summary: summarize(&call_samples),
        accumulated_frames: accumulated,
        generator_paints: paints,
    })
}

fn scene_name(scene: Option<Scene>) -> &'static str {
    match scene {
        None => "static",
        Some(Scene::Flood) => "flood",
        Some(Scene::Drag) => "drag",
        Some(Scene::Scroll) => "scroll",
        Some(Scene::Cursor) => "cursor",
    }
}

pub fn print_pacing(report: &PacingReport) {
    println!(
        "\n-- pacing timeout={} ms scene={} duration={:.1} s output_area_frames --",
        report.timeout_ms, report.scene, report.seconds
    );
    println!(
        "calls={} desktop_frames={} ({:.1}/s) pointer_only={} wait_timeout={} ({:.1}%) access_lost={} generator_paints={}",
        report.calls,
        report.desktop_frames,
        report.desktop_frames as f64 / report.seconds.max(0.001),
        report.pointer_only_frames,
        report.timeouts,
        report.timeouts as f64 * 100.0 / report.calls.max(1) as f64,
        report.access_lost,
        report.generator_paints
    );
    print_summary("inter-frame interval (ms)", &report.interval_summary);
    print_summary("LastPresentTime delta (ms)", &report.present_delta_summary);
    print_summary("AcquireNextFrame call (ms)", &report.call_summary);
    println!("interval histogram (n={}):", report.interval_summary.n);
    println!("  {:<14} {:>8} {:>8}", "bucket ms", "count", "pct");
    for (label, count, pct) in report.intervals.rows() {
        println!("  {label:<14} {count:>8} {pct:>7.2}%");
    }
    let acc: Vec<String> = report
        .accumulated_frames
        .iter()
        .map(|(k, v)| format!("{k}:{v}"))
        .collect();
    println!("AccumulatedFrames histogram: {}", acc.join(" "));
}

pub fn print_summary(label: &str, s: &Summary) {
    println!(
        "{label}: n={} min={:.2} p50={:.2} p90={:.2} p95={:.2} p99={:.2} max={:.2} mean={:.2} sd={:.2}",
        s.n, s.min, s.p50, s.p90, s.p95, s.p99, s.max, s.mean, s.stddev
    );
}

// ------------------------------------------------------------------- rects

pub struct RectsReport {
    pub scene: &'static str,
    pub generator: GeneratorCounters,
    pub frames: u64,
    pub frames_with_metadata: u64,
    pub frames_coalesced: u64,
    pub move_rects: Summary,
    pub dirty_rects: Summary,
    pub move_coverage_pct: Summary,
    pub dirty_coverage_pct: Summary,
    pub combined_coverage_pct: Summary,
    pub metadata_bytes: Summary,
    pub output_area: i64,
    /// Bounding box of every dirty rect seen. Settles two questions at once:
    /// whether the coordinates are output-relative or virtual-desktop absolute
    /// (they would be negative for an output left of the primary), and whether
    /// they are in rotated desktop space or un-rotated texture space.
    pub dirty_bounds: Option<Rect>,
}

pub fn run_rects(output_index: usize, seconds: f64, scene: Option<Scene>) -> dxgi::Result<RectsReport> {
    let (adapter, output, info) = dxgi::open_output(output_index)?;
    let (device, _ctx) = dxgi::create_device(&adapter)?;
    let dup = dxgi::duplicate(&output, &device)?;
    let generator = scene.map(|s| Generator::start(s, info.desktop_coordinates));

    let area = info.desktop_coordinates.area();
    let mut buffer: Vec<u8> = vec![0; 256 * 1024];
    let (mut frames, mut with_metadata, mut coalesced) = (0u64, 0u64, 0u64);
    let mut move_counts = Vec::new();
    let mut dirty_counts = Vec::new();
    let mut move_cov = Vec::new();
    let mut dirty_cov = Vec::new();
    let mut both_cov = Vec::new();
    let mut meta_bytes = Vec::new();
    let mut dirty_bounds: Option<Rect> = None;

    let started = Instant::now();
    while started.elapsed().as_secs_f64() < seconds {
        let (outcome, _) = acquire(&dup, 16);
        match outcome {
            AcquireOutcome::Frame(a) => {
                if a.info.LastPresentTime != 0 {
                    frames += 1;
                    if a.info.RectsCoalesced.as_bool() {
                        coalesced += 1;
                    }
                    let needed = a.info.TotalMetadataBufferSize as usize;
                    meta_bytes.push(needed as f64);
                    if needed > 0 {
                        with_metadata += 1;
                        if buffer.len() < needed {
                            buffer.resize(needed, 0);
                        }
                        // All move rects, then all dirty rects, out of one
                        // buffer - the order the API documents and requires.
                        let mut move_bytes = 0u32;
                        let moves: Vec<Rect> = match unsafe {
                            dup.GetFrameMoveRects(
                                needed as u32,
                                buffer.as_mut_ptr() as *mut DXGI_OUTDUPL_MOVE_RECT,
                                &mut move_bytes,
                            )
                        } {
                            Ok(()) => {
                                let n = move_bytes as usize / std::mem::size_of::<DXGI_OUTDUPL_MOVE_RECT>();
                                let src = unsafe {
                                    std::slice::from_raw_parts(
                                        buffer.as_ptr() as *const DXGI_OUTDUPL_MOVE_RECT,
                                        n,
                                    )
                                };
                                src.iter()
                                    .map(|m| Rect {
                                        left: m.DestinationRect.left,
                                        top: m.DestinationRect.top,
                                        right: m.DestinationRect.right,
                                        bottom: m.DestinationRect.bottom,
                                    })
                                    .collect()
                            }
                            Err(_) => Vec::new(),
                        };

                        let mut dirty_bytes = 0u32;
                        let dirty: Vec<Rect> = match unsafe {
                            dup.GetFrameDirtyRects(
                                needed as u32 - move_bytes,
                                buffer.as_mut_ptr().add(move_bytes as usize)
                                    as *mut windows::Win32::Foundation::RECT,
                                &mut dirty_bytes,
                            )
                        } {
                            Ok(()) => {
                                let n = dirty_bytes as usize
                                    / std::mem::size_of::<windows::Win32::Foundation::RECT>();
                                let src = unsafe {
                                    std::slice::from_raw_parts(
                                        buffer.as_ptr().add(move_bytes as usize)
                                            as *const windows::Win32::Foundation::RECT,
                                        n,
                                    )
                                };
                                src.iter()
                                    .map(|r| Rect {
                                        left: r.left,
                                        top: r.top,
                                        right: r.right,
                                        bottom: r.bottom,
                                    })
                                    .collect()
                            }
                            Err(_) => Vec::new(),
                        };

                        for r in &dirty {
                            dirty_bounds = Some(match dirty_bounds {
                                None => *r,
                                Some(b) => Rect {
                                    left: b.left.min(r.left),
                                    top: b.top.min(r.top),
                                    right: b.right.max(r.right),
                                    bottom: b.bottom.max(r.bottom),
                                },
                            });
                        }
                        move_counts.push(moves.len() as f64);
                        dirty_counts.push(dirty.len() as f64);
                        let pct = |a: i64| a as f64 * 100.0 / area.max(1) as f64;
                        move_cov.push(pct(crate::stats::union_area(&moves)));
                        dirty_cov.push(pct(crate::stats::union_area(&dirty)));
                        let mut all = moves;
                        all.extend_from_slice(&dirty);
                        both_cov.push(pct(crate::stats::union_area(&all)));
                    } else {
                        move_counts.push(0.0);
                        dirty_counts.push(0.0);
                        move_cov.push(0.0);
                        dirty_cov.push(0.0);
                        both_cov.push(0.0);
                    }
                }
                let _ = unsafe { dup.ReleaseFrame() };
            }
            AcquireOutcome::Timeout => {}
            AcquireOutcome::AccessLost => break,
            AcquireOutcome::Other(e) => {
                report_unexpected("rects", &e);
                break;
            }
        }
    }
    let counters = Generator::counters();
    drop(generator);

    Ok(RectsReport {
        scene: scene_name(scene),
        generator: counters,
        frames,
        frames_with_metadata: with_metadata,
        frames_coalesced: coalesced,
        move_rects: summarize(&move_counts),
        dirty_rects: summarize(&dirty_counts),
        move_coverage_pct: summarize(&move_cov),
        dirty_coverage_pct: summarize(&dirty_cov),
        combined_coverage_pct: summarize(&both_cov),
        metadata_bytes: summarize(&meta_bytes),
        output_area: area,
        dirty_bounds,
    })
}

pub fn print_rects(report: &RectsReport) {
    println!("\n-- rects scene={} --", report.scene);
    println!(
        "frames={} with_metadata={} coalesced={} output_area={} px generator: paints={} scrolls={} moves={}",
        report.frames,
        report.frames_with_metadata,
        report.frames_coalesced,
        report.output_area,
        report.generator.paints,
        report.generator.scrolls,
        report.generator.moves
    );
    print_summary("move rects per frame", &report.move_rects);
    print_summary("dirty rects per frame", &report.dirty_rects);
    print_summary("move coverage %", &report.move_coverage_pct);
    print_summary("dirty coverage %", &report.dirty_coverage_pct);
    print_summary("move+dirty coverage %", &report.combined_coverage_pct);
    print_summary("TotalMetadataBufferSize bytes", &report.metadata_bytes);
    match report.dirty_bounds {
        Some(b) => println!(
            "dirty rect bounding box: ({},{})-({},{})",
            b.left, b.top, b.right, b.bottom
        ),
        None => println!("dirty rect bounding box: no dirty rects seen"),
    }
}

// ----------------------------------------------------------------- pointer

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ShapeKey {
    pub shape_type: u32,
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
}

pub fn shape_type_name(t: u32) -> &'static str {
    match t {
        1 => "MONOCHROME",
        2 => "COLOR",
        4 => "MASKED_COLOR",
        _ => "unknown",
    }
}

pub struct PointerReport {
    pub frames: u64,
    pub mouse_update_zero: u64,
    pub mouse_update_nonzero: u64,
    pub visible_true: u64,
    pub visible_false: u64,
    pub shape_updates: u64,
    pub shapes: BTreeMap<ShapeKey, u64>,
    pub position_samples: u64,
    pub position_min: (i32, i32),
    pub position_max: (i32, i32),
}

pub fn run_pointer(output_index: usize, seconds: f64, scene: Option<Scene>) -> dxgi::Result<PointerReport> {
    let (adapter, output, info) = dxgi::open_output(output_index)?;
    let (device, _ctx) = dxgi::create_device(&adapter)?;
    let dup = dxgi::duplicate(&output, &device)?;
    let generator = scene.map(|s| Generator::start(s, info.desktop_coordinates));

    let mut buffer: Vec<u8> = vec![0; 64 * 1024];
    let mut report = PointerReport {
        frames: 0,
        mouse_update_zero: 0,
        mouse_update_nonzero: 0,
        visible_true: 0,
        visible_false: 0,
        shape_updates: 0,
        shapes: BTreeMap::new(),
        position_samples: 0,
        position_min: (i32::MAX, i32::MAX),
        position_max: (i32::MIN, i32::MIN),
    };

    let started = Instant::now();
    while started.elapsed().as_secs_f64() < seconds {
        let (outcome, _) = acquire(&dup, 16);
        match outcome {
            AcquireOutcome::Frame(a) => {
                report.frames += 1;
                if a.info.LastMouseUpdateTime == 0 {
                    report.mouse_update_zero += 1;
                } else {
                    report.mouse_update_nonzero += 1;
                    if a.info.PointerPosition.Visible.as_bool() {
                        report.visible_true += 1;
                    } else {
                        report.visible_false += 1;
                    }
                    let p = a.info.PointerPosition.Position;
                    report.position_samples += 1;
                    report.position_min.0 = report.position_min.0.min(p.x);
                    report.position_min.1 = report.position_min.1.min(p.y);
                    report.position_max.0 = report.position_max.0.max(p.x);
                    report.position_max.1 = report.position_max.1.max(p.y);
                }
                if a.info.PointerShapeBufferSize > 0 {
                    let needed = a.info.PointerShapeBufferSize as usize;
                    if buffer.len() < needed {
                        buffer.resize(needed, 0);
                    }
                    let mut required = 0u32;
                    let mut shape = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
                    if unsafe {
                        dup.GetFramePointerShape(
                            needed as u32,
                            buffer.as_mut_ptr() as *mut core::ffi::c_void,
                            &mut required,
                            &mut shape,
                        )
                    }
                    .is_ok()
                    {
                        report.shape_updates += 1;
                        *report
                            .shapes
                            .entry(ShapeKey {
                                shape_type: shape.Type,
                                width: shape.Width,
                                height: shape.Height,
                                pitch: shape.Pitch,
                                hotspot_x: shape.HotSpot.x,
                                hotspot_y: shape.HotSpot.y,
                            })
                            .or_insert(0) += 1;
                    }
                }
                let _ = unsafe { dup.ReleaseFrame() };
            }
            AcquireOutcome::Timeout => {}
            AcquireOutcome::AccessLost => break,
            AcquireOutcome::Other(e) => {
                report_unexpected("pointer", &e);
                break;
            }
        }
    }
    drop(generator);
    Ok(report)
}

pub fn print_pointer(report: &PointerReport) {
    println!("\n-- pointer --");
    println!(
        "frames={} LastMouseUpdateTime==0: {} ({:.1}%)  !=0: {}  Visible=true: {}  Visible=false: {}",
        report.frames,
        report.mouse_update_zero,
        report.mouse_update_zero as f64 * 100.0 / report.frames.max(1) as f64,
        report.mouse_update_nonzero,
        report.visible_true,
        report.visible_false
    );
    if report.position_samples > 0 {
        println!(
            "PointerPosition samples={} x:[{}..{}] y:[{}..{}]",
            report.position_samples,
            report.position_min.0,
            report.position_max.0,
            report.position_min.1,
            report.position_max.1
        );
    }
    println!("shape updates={} distinct={}", report.shape_updates, report.shapes.len());
    println!(
        "  {:<14} {:>6} {:>7} {:>7} {:>12} {:>7}",
        "type", "w", "h", "pitch", "hotspot", "count"
    );
    for (k, count) in &report.shapes {
        println!(
            "  {:<14} {:>6} {:>7} {:>7} {:>12} {:>7}",
            shape_type_name(k.shape_type),
            k.width,
            k.height,
            k.pitch,
            format!("({},{})", k.hotspot_x, k.hotspot_y),
            count
        );
    }
}

// -------------------------------------------------------------------- idle

pub struct IdleReport {
    pub seconds: f64,
    pub timeout_ms: u32,
    pub calls: u64,
    pub timeouts: u64,
    pub desktop_frames: u64,
    pub pointer_only_frames: u64,
    pub gaps: Summary,
}

pub fn run_idle(output_index: usize, seconds: f64, timeout_ms: u32) -> dxgi::Result<IdleReport> {
    let (adapter, output, _info) = dxgi::open_output(output_index)?;
    let (device, _ctx) = dxgi::create_device(&adapter)?;
    let dup = dxgi::duplicate(&output, &device)?;

    let (mut calls, mut timeouts, mut frames, mut pointer_only) = (0u64, 0u64, 0u64, 0u64);
    let mut gaps = Vec::new();
    let mut prev = Instant::now();
    let started = Instant::now();
    while started.elapsed().as_secs_f64() < seconds {
        calls += 1;
        let (outcome, _) = acquire(&dup, timeout_ms);
        match outcome {
            AcquireOutcome::Frame(a) => {
                if a.info.LastPresentTime != 0 {
                    frames += 1;
                    let now = Instant::now();
                    gaps.push((now - prev).as_secs_f64() * 1000.0);
                    prev = now;
                } else {
                    pointer_only += 1;
                }
                let _ = unsafe { dup.ReleaseFrame() };
            }
            AcquireOutcome::Timeout => timeouts += 1,
            AcquireOutcome::AccessLost => break,
            AcquireOutcome::Other(e) => {
                report_unexpected("idle", &e);
                break;
            }
        }
    }
    Ok(IdleReport {
        seconds: started.elapsed().as_secs_f64(),
        timeout_ms,
        calls,
        timeouts,
        desktop_frames: frames,
        pointer_only_frames: pointer_only,
        gaps: summarize(&gaps),
    })
}

pub fn print_idle(report: &IdleReport) {
    println!("\n-- idle (no generator) --");
    println!(
        "duration={:.1} s timeout={} ms calls={} WAIT_TIMEOUT={} ({:.2}%) desktop_frames={} ({:.2}/s) pointer_only={}",
        report.seconds,
        report.timeout_ms,
        report.calls,
        report.timeouts,
        report.timeouts as f64 * 100.0 / report.calls.max(1) as f64,
        report.desktop_frames,
        report.desktop_frames as f64 / report.seconds.max(0.001),
        report.pointer_only_frames
    );
    print_summary("gap between desktop frames (ms)", &report.gaps);
}

// ------------------------------------------------------------ surface facts

pub fn print_surface_facts(output_index: usize) -> dxgi::Result<()> {
    let (adapter, output, info) = dxgi::open_output(output_index)?;
    let (device, _ctx) = dxgi::create_device(&adapter)?;
    let dup = dxgi::duplicate(&output, &device)?;
    let desc = unsafe { dup.GetDesc() };
    println!(
        "\n-- surface facts output global={} adapter={} output_index={} {} --",
        info.global_index, info.adapter_index, info.output_index, info.device_name
    );
    println!(
        "OUTDUPL_DESC: {}x{} format={} refresh={}/{} rotation={} DesktopImageInSystemMemory={}",
        desc.ModeDesc.Width,
        desc.ModeDesc.Height,
        format_name(desc.ModeDesc.Format),
        desc.ModeDesc.RefreshRate.Numerator,
        desc.ModeDesc.RefreshRate.Denominator,
        rotation_name(desc.Rotation),
        desc.DesktopImageInSystemMemory.as_bool()
    );
    println!(
        "OUTPUT_DESC rect=({},{})-({},{}) {}x{} rotation={} dpi_eff={}x{}",
        info.desktop_coordinates.left,
        info.desktop_coordinates.top,
        info.desktop_coordinates.right,
        info.desktop_coordinates.bottom,
        info.desktop_coordinates.right - info.desktop_coordinates.left,
        info.desktop_coordinates.bottom - info.desktop_coordinates.top,
        rotation_name(info.rotation),
        info.effective_dpi.0,
        info.effective_dpi.1
    );

    if let Some(texture_desc) = first_texture_desc(&dup, &device) {
        println!(
            "acquired texture: {}x{} format={} mip={} array={} usage={} bind=0x{:X} misc=0x{:X} sample={}x",
            texture_desc.Width,
            texture_desc.Height,
            format_name(texture_desc.Format),
            texture_desc.MipLevels,
            texture_desc.ArraySize,
            texture_desc.Usage.0,
            texture_desc.BindFlags,
            texture_desc.MiscFlags,
            texture_desc.SampleDesc.Count
        );
    } else {
        println!("acquired texture: no frame within 2000 ms (unmeasured)");
    }
    Ok(())
}

fn first_texture_desc(
    dup: &IDXGIOutputDuplication,
    _device: &ID3D11Device,
) -> Option<D3D11_TEXTURE2D_DESC> {
    let deadline = Instant::now() + Duration::from_millis(2000);
    while Instant::now() < deadline {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        if unsafe { dup.AcquireNextFrame(50, &mut info, &mut resource) }.is_ok() {
            let desc = resource
                .as_ref()
                .and_then(|r| r.cast::<ID3D11Texture2D>().ok())
                .map(|t| {
                    let mut d = D3D11_TEXTURE2D_DESC::default();
                    unsafe { t.GetDesc(&mut d) };
                    d
                });
            let _ = unsafe { dup.ReleaseFrame() };
            if desc.is_some() {
                return desc;
            }
        }
    }
    None
}

// -------------------------------------------------------------- accesslost

pub struct LostEvent {
    pub trigger: String,
    pub outputs_lost: Vec<usize>,
    pub detect_ms: f64,
    pub recreate_ms: f64,
    /// Recreated -> first successful `AcquireNextFrame` of any kind.
    pub first_any_ms: f64,
    /// Whether that first frame carried `LastPresentTime == 0`, i.e. no desktop
    /// image - the case that decides whether recovery can rely on a frame
    /// arriving or has to force its own full refresh.
    pub first_any_present_zero: bool,
    /// Recreated -> first frame that actually carried a desktop image.
    pub first_frame_ms: f64,
    pub total_ms: f64,
    pub retries: u32,
    pub retry_codes: Vec<String>,
}

/// Duplicate every attached output, fire `trigger`, and measure which
/// duplications die and how long the one on `output_index` takes to come back.
///
/// `trigger` runs on its own thread: `ChangeDisplaySettingsExW` blocks for the
/// whole mode change, so firing it inline would fold the mode change's own
/// duration into "trigger -> detect" and the number would measure the display
/// driver instead of the duplication.
pub fn measure_access_lost(
    output_index: usize,
    trigger_label: &str,
    trigger: impl FnOnce() + Send + 'static,
) -> dxgi::Result<LostEvent> {
    let outputs: Vec<OutputInfo> = dxgi::enumerate()?
        .into_iter()
        .flat_map(|a| a.outputs.into_iter())
        .filter(|o| o.attached_to_desktop)
        .collect();

    let mut dups: Vec<(usize, IDXGIOutputDuplication, ID3D11Device, IDXGIOutput)> = Vec::new();
    for o in &outputs {
        let (adapter, output, _) = dxgi::open_output(o.global_index)?;
        let (device, _ctx) = dxgi::create_device(&adapter)?;
        match dxgi::duplicate(&output, &device) {
            Ok(dup) => dups.push((o.global_index, dup, device, output)),
            Err(e) => println!(
                "  (output global={} could not be duplicated: {})",
                o.global_index,
                dxgi::hresult(&e)
            ),
        }
    }

    let fired = Instant::now();
    let trigger_thread = std::thread::spawn(trigger);

    let mut lost_outputs: Vec<usize> = Vec::new();
    let mut detect_at: Option<Instant> = None;
    let deadline = fired + Duration::from_secs(12);
    // Poll until the output under test loses access, then sweep the others
    // once more so the blast radius is measured rather than assumed.
    let mut sweep_until = deadline;
    while Instant::now() < deadline && Instant::now() < sweep_until {
        for (idx, dup, _, _) in &dups {
            if lost_outputs.contains(idx) {
                continue;
            }
            let (outcome, _) = acquire(dup, 4);
            match outcome {
                AcquireOutcome::Frame(_) => {
                    let _ = unsafe { dup.ReleaseFrame() };
                }
                AcquireOutcome::Timeout => {}
                AcquireOutcome::AccessLost | AcquireOutcome::Other(_) => {
                    if *idx == output_index && detect_at.is_none() {
                        detect_at = Some(Instant::now());
                        sweep_until = Instant::now() + Duration::from_millis(250);
                    }
                    lost_outputs.push(*idx);
                }
            }
        }
        if lost_outputs.len() == dups.len() {
            break;
        }
    }

    let Some(detect_at) = detect_at else {
        let _ = trigger_thread.join();
        return Ok(LostEvent {
            trigger: trigger_label.to_string(),
            outputs_lost: lost_outputs,
            detect_ms: f64::NAN,
            recreate_ms: f64::NAN,
            first_any_ms: f64::NAN,
            first_any_present_zero: false,
            first_frame_ms: f64::NAN,
            total_ms: f64::NAN,
            retries: 0,
            retry_codes: vec!["never lost access within 12 s".to_string()],
        });
    };
    let detect_ms = (detect_at - fired).as_secs_f64() * 1000.0;

    // Recovery, exactly as Task 3.6 would do it: drop the duplication, take a
    // fresh factory (a mode change makes the old one stale), re-open the
    // output, re-duplicate with backoff, then acquire until a real desktop
    // frame. The trigger thread is deliberately still running: a real streamer
    // retries *through* the mode change, so joining first would undercount the
    // retries.
    dups.retain(|(idx, _, _, _)| *idx != output_index);
    let mut retries = 0u32;
    let mut retry_codes: Vec<String> = Vec::new();
    let mut recreated: Option<(IDXGIOutputDuplication, Instant)> = None;
    let recreate_deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < recreate_deadline {
        let attempt = dxgi::open_output(output_index)
            .and_then(|(adapter, output, _)| {
                let (device, _ctx) = dxgi::create_device(&adapter)?;
                dxgi::duplicate(&output, &device)
            });
        match attempt {
            Ok(dup) => {
                recreated = Some((dup, Instant::now()));
                break;
            }
            Err(e) => {
                retries += 1;
                let code = dxgi::hresult(&e);
                if !retry_codes.contains(&code) {
                    retry_codes.push(code);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    let mut first_any_ms = f64::NAN;
    let mut first_any_present_zero = false;
    let (recreate_ms, first_frame_ms, total_ms) = match recreated {
        Some((dup, at)) => {
            let recreate_ms = (at - detect_at).as_secs_f64() * 1000.0;
            let frame_deadline = at + Duration::from_secs(10);
            let mut first: Option<Instant> = None;
            let mut seen_any = false;
            while Instant::now() < frame_deadline {
                let (outcome, _) = acquire(&dup, 32);
                match outcome {
                    AcquireOutcome::Frame(a) => {
                        let _ = unsafe { dup.ReleaseFrame() };
                        if !seen_any {
                            seen_any = true;
                            first_any_ms = (Instant::now() - at).as_secs_f64() * 1000.0;
                            first_any_present_zero = a.info.LastPresentTime == 0;
                        }
                        if a.info.LastPresentTime != 0 {
                            first = Some(Instant::now());
                            break;
                        }
                    }
                    AcquireOutcome::Timeout => {}
                    _ => break,
                }
            }
            match first {
                Some(f) => (
                    recreate_ms,
                    (f - at).as_secs_f64() * 1000.0,
                    (f - detect_at).as_secs_f64() * 1000.0,
                ),
                None => (recreate_ms, f64::NAN, f64::NAN),
            }
        }
        None => (f64::NAN, f64::NAN, f64::NAN),
    };
    let _ = trigger_thread.join();

    Ok(LostEvent {
        trigger: trigger_label.to_string(),
        outputs_lost: lost_outputs,
        detect_ms,
        recreate_ms,
        first_any_ms,
        first_any_present_zero,
        first_frame_ms,
        total_ms,
        retries,
        retry_codes,
    })
}

pub fn print_lost(event: &LostEvent) {
    println!(
        "trigger={:<28} outputs_lost={:?} detect={:.1} ms recreate={:.1} ms first_any={:.1} ms (LastPresentTime==0: {}) first_image={:.1} ms total={:.1} ms retries={} codes={:?}",
        event.trigger,
        event.outputs_lost,
        event.detect_ms,
        event.recreate_ms,
        event.first_any_ms,
        event.first_any_present_zero,
        event.first_frame_ms,
        event.total_ms,
        event.retries,
        event.retry_codes
    );
}
