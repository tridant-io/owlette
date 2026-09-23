//! The six measurements spike 0.9 owes the memo.
//!
//! 1. the H.264 VUI fix: two otherwise identical Annex-B streams, with and
//!    without `bitstreamRestrictionFlag`, handed to the browser half,
//! 2. forced-IDR latency, request to IDR emitted,
//! 3. bitrate reconfigure with no reset and no IDR,
//! 4. single-slice output, confirmed by counting VCL NAL units,
//! 5. HEVC VPS/SPS/PPS in band on every IRAP,
//! 6. encode latency p50/p95 at 1080p60 and 4K60.
//!
//! Every loop is paced at the target frame rate, because an encoder run flat
//! out measures throughput, and what the streamer cares about is the latency of
//! one frame submitted into an otherwise idle encoder.

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};

use crate::d3d;
use crate::json::J;
use crate::nal::{self, Codec};
use crate::nvenc::{EncoderConfig, Encoded, MultiPass, Session};

/// Frames discarded at the start of every run: the GPU is still clocking up and
/// the first picture is an IDR, neither of which belongs in a steady-state p50.
const WARMUP: usize = 60;
/// Distinct pictures in the input pool. Enough for real motion without spending
/// a gigabyte of VRAM at 4K.
const POOL: usize = 16;

pub type Result<T> = std::result::Result<T, String>;

/// A session plus the registered textures it cycles through.
struct Rig {
    session: Session,
    _textures: Vec<ID3D11Texture2D>,
}

impl Rig {
    fn open(device: &ID3D11Device, cfg: EncoderConfig) -> Result<Self> {
        let mut session = Session::open(device, cfg)?;
        let mut textures = Vec::with_capacity(POOL);
        for phase in 0..POOL {
            let pixels = d3d::pattern_frame(cfg.width, cfg.height, phase as u32);
            let texture = d3d::create_bgra_texture(device, cfg.width, cfg.height, &pixels)
                .map_err(|e| format!("CreateTexture2D failed: {e}"))?;
            session.register_texture(&texture)?;
            textures.push(texture);
        }
        Ok(Self {
            session,
            _textures: textures,
        })
    }

    fn encode(&mut self, frame: usize, force_idr: bool) -> Result<Encoded> {
        self.session
            .encode(frame % POOL, force_idr, frame as u64 * 1000)
    }
}

/// Busy-wait to the frame deadline. `thread::sleep` alone drifts by whole
/// milliseconds on Windows, which at 16.67 ms frames is a large fraction of the
/// interval being simulated.
fn pace(start: Instant, frame: usize, fps: u32) {
    let deadline = start + Duration::from_nanos(frame as u64 * 1_000_000_000 / u64::from(fps));
    let now = Instant::now();
    if deadline <= now {
        return;
    }
    let remaining = deadline - now;
    if remaining > Duration::from_millis(2) {
        std::thread::sleep(remaining - Duration::from_millis(2));
    }
    while Instant::now() < deadline {
        std::hint::spin_loop();
    }
}

/// p50, p95, mean and n of a sample, in whatever unit the caller collected.
struct Stats {
    p50: f64,
    p95: f64,
    mean: f64,
    max: f64,
    n: usize,
}

fn stats(mut samples: Vec<f64>) -> Stats {
    samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN in a duration sample"));
    let n = samples.len();
    if n == 0 {
        return Stats {
            p50: f64::NAN,
            p95: f64::NAN,
            mean: f64::NAN,
            max: f64::NAN,
            n: 0,
        };
    }
    // Nearest-rank: the smallest sample at or above q of the way through.
    let at = |q: f64| samples[((q * n as f64).ceil().max(1.0) as usize - 1).min(n - 1)];
    Stats {
        p50: at(0.50),
        p95: at(0.95),
        mean: samples.iter().sum::<f64>() / n as f64,
        max: samples[n - 1],
        n,
    }
}

impl Stats {
    fn to_json(&self) -> J {
        J::Obj(vec![
            ("n", J::Uint(self.n as u64)),
            ("p50_ms", J::Num(self.p50)),
            ("p95_ms", J::Num(self.p95)),
            ("mean_ms", J::Num(self.mean)),
            ("max_ms", J::Num(self.max)),
        ])
    }
}

/// Running tally for measurement 4: every access unit produced anywhere in the
/// spike is checked, so the slice count carries the whole run's n.
#[derive(Default)]
struct SliceTally {
    access_units: usize,
    multi_slice: usize,
    max_vcl_nals: usize,
}

impl SliceTally {
    fn observe(&mut self, data: &[u8], codec: Codec) -> nal::AccessUnit {
        let au = nal::summarize_access_unit(data, codec);
        self.access_units += 1;
        if au.vcl_nals != 1 {
            self.multi_slice += 1;
        }
        self.max_vcl_nals = self.max_vcl_nals.max(au.vcl_nals);
        au
    }

    fn to_json(&self) -> J {
        J::Obj(vec![
            ("access_units", J::Uint(self.access_units as u64)),
            ("multi_slice_access_units", J::Uint(self.multi_slice as u64)),
            ("max_vcl_nals_in_one_au", J::Uint(self.max_vcl_nals as u64)),
        ])
    }
}

fn base_config(codec: Codec, width: u32, height: u32, bitrate_bps: u32) -> EncoderConfig {
    EncoderConfig {
        codec,
        width,
        height,
        fps: 60,
        bitrate_bps,
        bitstream_restriction: true,
        multi_pass: MultiPass::QuarterResolution,
        async_encode: true,
        h264_level: 0,
    }
}

/// Measurement 1 (host half): two otherwise identical H.264 streams that differ
/// only in `bitstreamRestrictionFlag`, plus the index the browser page needs to
/// submit them one access unit at a time.
fn emit_vui_streams(device: &ID3D11Device, out: &Path, tally: &mut SliceTally) -> Result<J> {
    const FRAMES: usize = 300;
    let streams = out.join("streams");
    fs::create_dir_all(&streams).map_err(|e| format!("create {}: {e}", streams.display()))?;

    let mut arms = Vec::new();
    let mut names = Vec::new();
    // The level is an arm because, without the fix, the decoder's output delay
    // is the DPB the level implies, not a constant: level 4.2 at 1080p allows 4
    // frames, level 5.1 allows 13. That is the difference between the 67 ms this
    // box measured and the ~208 ms the claim in plan.md D5 quotes.
    for (name, restriction, level) in [
        ("vui-off", false, 0u32),
        ("vui-on", true, 0),
        ("vui-off-level51", false, 51),
        ("vui-on-level51", true, 51),
    ] {
        let cfg = EncoderConfig {
            bitstream_restriction: restriction,
            h264_level: level,
            ..base_config(Codec::H264, 1920, 1080, 20_000_000)
        };
        let mut rig = Rig::open(device, cfg)?;

        let mut bytes: Vec<u8> = Vec::new();
        let mut index: Vec<J> = Vec::with_capacity(FRAMES);
        let mut sps_hex = String::new();
        let mut parsed = None;
        let start = Instant::now();
        for frame in 0..FRAMES {
            pace(start, frame, cfg.fps);
            let encoded = rig.encode(frame, false)?;
            let au = tally.observe(&encoded.data, Codec::H264);
            if parsed.is_none() {
                if let Some(unit) = nal::parse_annexb(&encoded.data, Codec::H264)
                    .into_iter()
                    .find(|n| n.ty == nal::H264_NAL_SPS)
                {
                    let payload = &encoded.data[unit.start..unit.end];
                    sps_hex = payload.iter().map(|b| format!("{b:02x}")).collect();
                    parsed = nal::parse_h264_sps(payload);
                }
            }
            index.push(J::Obj(vec![
                ("len", J::Uint(encoded.data.len() as u64)),
                ("key", J::Bool(au.irap)),
            ]));
            bytes.extend_from_slice(&encoded.data);
        }

        let sps = parsed.ok_or_else(|| format!("{name}: no parsable SPS in the stream"))?;
        let stream_path = streams.join(format!("{name}.h264"));
        fs::write(&stream_path, &bytes)
            .map_err(|e| format!("write {}: {e}", stream_path.display()))?;
        let index_doc = J::Obj(vec![
            ("codec", J::s(sps.codec_string())),
            ("width", J::Uint(u64::from(cfg.width))),
            ("height", J::Uint(u64::from(cfg.height))),
            ("fps", J::Uint(u64::from(cfg.fps))),
            ("frames", J::Arr(index)),
        ]);
        let index_path = streams.join(format!("{name}.json"));
        fs::write(&index_path, index_doc.render())
            .map_err(|e| format!("write {}: {e}", index_path.display()))?;

        names.push(J::s(name));
        arms.push((
            name,
            J::Obj(vec![
                ("stream", J::s(format!("streams/{name}.h264"))),
                ("level_idc", J::Uint(u64::from(sps.level_idc))),
                ("frames", J::Uint(FRAMES as u64)),
                ("bytes", J::Uint(bytes.len() as u64)),
                ("sps_hex", J::s(sps_hex)),
                ("codec_string", J::s(sps.codec_string())),
                ("vui_present", J::Bool(sps.vui_present)),
                (
                    "bitstream_restriction_flag",
                    J::Bool(sps.bitstream_restriction_flag),
                ),
                (
                    "max_num_reorder_frames",
                    match sps.max_num_reorder_frames {
                        Some(v) => J::Uint(u64::from(v)),
                        None => J::s("absent"),
                    },
                ),
                (
                    "max_dec_frame_buffering",
                    match sps.max_dec_frame_buffering {
                        Some(v) => J::Uint(u64::from(v)),
                        None => J::s("absent"),
                    },
                ),
            ]),
        ));
    }

    // The page reads this rather than hard-coding the arm names, so adding an
    // arm here is enough to make the browser measure it.
    let manifest = streams.join("manifest.json");
    fs::write(&manifest, J::Obj(vec![("streams", J::Arr(names))]).render())
        .map_err(|e| format!("write {}: {e}", manifest.display()))?;

    let mut fields: Vec<(&'static str, J)> = vec![(
        "note",
        J::s("decoder-side numbers come from the WebCodecs page; see webcodecs-results.json"),
    )];
    for (name, doc) in arms {
        fields.push((name, doc));
    }
    Ok(J::Obj(fields))
}

/// Measurement 2: submit a picture carrying `NV_ENC_PIC_FLAG_FORCEIDR` and time
/// it to the completion event, confirming by NAL parse that an IRAP came out.
fn forced_idr(device: &ID3D11Device, codec: Codec, tally: &mut SliceTally) -> Result<J> {
    const FRAMES: usize = 660;
    const EVERY: usize = 30;
    let cfg = base_config(codec, 1920, 1080, 20_000_000);
    let mut rig = Rig::open(device, cfg)?;

    let mut samples = Vec::new();
    let mut steady = Vec::new();
    let mut requested = 0usize;
    let mut delivered = 0usize;
    let start = Instant::now();
    for frame in 0..FRAMES {
        pace(start, frame, cfg.fps);
        let force = frame >= WARMUP && frame % EVERY == 0;
        let encoded = rig.encode(frame, force)?;
        let au = tally.observe(&encoded.data, codec);
        let ms = encoded.encode.as_secs_f64() * 1e3;
        if force {
            requested += 1;
            if au.irap {
                delivered += 1;
                samples.push(ms);
            }
        } else if frame >= WARMUP {
            steady.push(ms);
        }
    }

    let idr = stats(samples);
    let p = stats(steady);
    Ok(J::Obj(vec![
        ("codec", J::s(format!("{codec:?}").to_lowercase())),
        ("requests", J::Uint(requested as u64)),
        ("idr_emitted_on_the_same_picture", J::Uint(delivered as u64)),
        ("request_to_idr", idr.to_json()),
        ("steady_state_p_frames_for_comparison", p.to_json()),
    ]))
}

/// Measurement 3: `NvEncReconfigureEncoder` with `resetEncoder = 0` and
/// `forceIDR = 0`, alternating the target bitrate, and a NAL-level check that
/// no IRAP appeared anywhere after the first picture.
fn reconfigure_without_idr(device: &ID3D11Device, tally: &mut SliceTally) -> Result<J> {
    const FRAMES: usize = 1260;
    const EVERY: usize = 60;
    const LOW: u32 = 5_000_000;
    const HIGH: u32 = 20_000_000;
    const SETTLE: usize = 20;

    let cfg = base_config(Codec::H264, 1920, 1080, HIGH);
    let mut rig = Rig::open(device, cfg)?;

    let mut changes = 0usize;
    let mut irap_after_first = 0usize;
    let mut low_bytes: Vec<f64> = Vec::new();
    let mut high_bytes: Vec<f64> = Vec::new();
    let mut current = HIGH;
    let mut frames_since_change = usize::MAX;

    let start = Instant::now();
    for frame in 0..FRAMES {
        pace(start, frame, cfg.fps);
        if frame >= WARMUP && frame % EVERY == 0 {
            current = if current == HIGH { LOW } else { HIGH };
            rig.session.reconfigure_bitrate(current)?;
            changes += 1;
            frames_since_change = 0;
        }
        let encoded = rig.encode(frame, false)?;
        let au = tally.observe(&encoded.data, Codec::H264);
        if frame > 0 && au.irap {
            irap_after_first += 1;
        }
        // Only sample once the rate controller has settled after a change.
        if frames_since_change != usize::MAX && frames_since_change >= SETTLE {
            let bytes = encoded.data.len() as f64;
            if current == LOW {
                low_bytes.push(bytes);
            } else {
                high_bytes.push(bytes);
            }
        }
        frames_since_change = frames_since_change.saturating_add(1);
    }

    let mean = |v: &[f64]| {
        if v.is_empty() {
            f64::NAN
        } else {
            v.iter().sum::<f64>() / v.len() as f64
        }
    };
    let mean_low = mean(&low_bytes);
    let mean_high = mean(&high_bytes);
    Ok(J::Obj(vec![
        ("reconfigures", J::Uint(changes as u64)),
        (
            "irap_access_units_after_the_first_picture",
            J::Uint(irap_after_first as u64),
        ),
        ("low_bitrate_bps", J::Uint(u64::from(LOW))),
        ("high_bitrate_bps", J::Uint(u64::from(HIGH))),
        (
            "mean_bytes_per_frame_at_low",
            J::Obj(vec![
                ("n", J::Uint(low_bytes.len() as u64)),
                ("bytes", J::Num(mean_low)),
                ("implied_bps", J::Num(mean_low * 8.0 * 60.0)),
            ]),
        ),
        (
            "mean_bytes_per_frame_at_high",
            J::Obj(vec![
                ("n", J::Uint(high_bytes.len() as u64)),
                ("bytes", J::Num(mean_high)),
                ("implied_bps", J::Num(mean_high * 8.0 * 60.0)),
            ]),
        ),
    ]))
}

/// Measurement 5: with `repeatSPSPPS = 1`, every HEVC IRAP must carry VPS, SPS
/// and PPS in band, and no non-IRAP picture should carry them.
fn hevc_parameter_sets(device: &ID3D11Device, tally: &mut SliceTally) -> Result<J> {
    const FRAMES: usize = 660;
    const EVERY: usize = 30;
    let cfg = base_config(Codec::Hevc, 1920, 1080, 20_000_000);
    let mut rig = Rig::open(device, cfg)?;

    let mut iraps = 0usize;
    let mut iraps_complete = 0usize;
    let mut non_irap_with_parameter_sets = 0usize;
    let start = Instant::now();
    for frame in 0..FRAMES {
        pace(start, frame, cfg.fps);
        let force = frame >= WARMUP && frame % EVERY == 0;
        let encoded = rig.encode(frame, force)?;
        let au = tally.observe(&encoded.data, Codec::Hevc);
        let complete = au.has_vps && au.has_sps && au.has_pps;
        if au.irap {
            iraps += 1;
            if complete {
                iraps_complete += 1;
            }
        } else if complete {
            non_irap_with_parameter_sets += 1;
        }
    }

    Ok(J::Obj(vec![
        ("irap_access_units", J::Uint(iraps as u64)),
        (
            "irap_access_units_with_vps_sps_pps_in_band",
            J::Uint(iraps_complete as u64),
        ),
        (
            "non_irap_access_units_carrying_parameter_sets",
            J::Uint(non_irap_with_parameter_sets as u64),
        ),
    ]))
}

/// Measurement 6: steady-state submit-to-output latency at a given resolution
/// and codec, plus the whole host-side per-frame cost for context.
fn encode_latency(
    device: &ID3D11Device,
    cfg: EncoderConfig,
    frames: usize,
    tally: &mut SliceTally,
) -> Result<J> {
    let (codec, width, height) = (cfg.codec, cfg.width, cfg.height);
    let mut rig = Rig::open(device, cfg)?;

    let mut encode_ms = Vec::with_capacity(frames);
    let mut total_ms = Vec::with_capacity(frames);
    let mut bytes = 0u64;
    let start = Instant::now();
    for frame in 0..frames {
        pace(start, frame, cfg.fps);
        let encoded = rig.encode(frame, false)?;
        tally.observe(&encoded.data, codec);
        if frame >= WARMUP {
            encode_ms.push(encoded.encode.as_secs_f64() * 1e3);
            total_ms.push(encoded.total.as_secs_f64() * 1e3);
            bytes += encoded.data.len() as u64;
        }
    }

    let timed = frames - WARMUP;
    Ok(J::Obj(vec![
        ("codec", J::s(format!("{codec:?}").to_lowercase())),
        ("resolution", J::s(format!("{width}x{height}"))),
        ("fps", J::Uint(u64::from(cfg.fps))),
        ("target_bps", J::Uint(u64::from(cfg.bitrate_bps))),
        (
            "multi_pass",
            J::s(match cfg.multi_pass {
                MultiPass::Disabled => "disabled",
                MultiPass::QuarterResolution => "two-pass-quarter-resolution",
            }),
        ),
        ("async_encode", J::Bool(cfg.async_encode)),
        ("submit_to_output", stats(encode_ms).to_json()),
        ("host_per_frame_total", stats(total_ms).to_json()),
        (
            "achieved_bps",
            J::Num(bytes as f64 * 8.0 * f64::from(cfg.fps) / timed as f64),
        ),
    ]))
}

/// Run every measurement and write `results.json` plus the two bitstreams.
pub fn run_all(out: &Path) -> Result<()> {
    fs::create_dir_all(out).map_err(|e| format!("create {}: {e}", out.display()))?;
    let device = d3d::create_device().map_err(|e| format!("D3D11CreateDevice failed: {e}"))?;
    let mut tally = SliceTally::default();
    // This is a live desktop with a compositor and other GPU clients on it, not
    // a bench rig. Record what else the GPU was doing, so a later run on a
    // quiet machine can be compared against this one honestly.
    let load_before = crate::env::gpu_load();

    println!("[1/6] emitting the two H.264 VUI streams (1080p60, 300 frames each)");
    let vui = emit_vui_streams(&device, out, &mut tally)?;

    println!("[2/6] forced-IDR latency (h264, then hevc)");
    let idr_h264 = forced_idr(&device, Codec::H264, &mut tally)?;
    let idr_hevc = forced_idr(&device, Codec::Hevc, &mut tally)?;

    println!("[3/6] bitrate reconfigure with no reset and no IDR");
    let reconfigure = reconfigure_without_idr(&device, &mut tally)?;

    println!("[5/6] hevc parameter sets on every IRAP");
    let parameter_sets = hevc_parameter_sets(&device, &mut tally)?;

    println!("[6/6] encode latency at 1080p60 and 4K60");
    let mut latency = Vec::new();
    for (codec, width, height, bps) in [
        (Codec::H264, 1920u32, 1080u32, 20_000_000u32),
        (Codec::Hevc, 1920, 1080, 20_000_000),
        (Codec::H264, 3840, 2160, 50_000_000),
        (Codec::Hevc, 3840, 2160, 50_000_000),
    ] {
        latency.push(encode_latency(
            &device,
            base_config(codec, width, height, bps),
            660,
            &mut tally,
        )?);
    }
    // Two settings plan.md asserts without a source: quarter-resolution
    // two-pass, and async encode with depth 1. Each is an A/B run three times
    // alternately at full n, because the first pass at n=300 swung by 5 ms
    // between reps of the same setting — a single pair would have "found"
    // whichever effect the machine happened to be in the mood for.
    println!("[6b] async vs sync, 3 alternating reps at 1080p60 h264");
    let mut async_vs_sync = Vec::new();
    for rep in 0..3u32 {
        for async_encode in [true, false] {
            let run = encode_latency(
                &device,
                EncoderConfig {
                    async_encode,
                    ..base_config(Codec::H264, 1920, 1080, 20_000_000)
                },
                660,
                &mut tally,
            )?;
            async_vs_sync.push(J::Obj(vec![
                ("rep", J::Uint(u64::from(rep))),
                ("run", run),
            ]));
        }
    }

    println!("[6c] two-pass vs single-pass, 3 alternating reps at 1080p60 h264");
    let mut multi_pass = Vec::new();
    for rep in 0..3u32 {
        for pass in [MultiPass::QuarterResolution, MultiPass::Disabled] {
            let run = encode_latency(
                &device,
                EncoderConfig {
                    multi_pass: pass,
                    ..base_config(Codec::H264, 1920, 1080, 20_000_000)
                },
                660,
                &mut tally,
            )?;
            multi_pass.push(J::Obj(vec![
                ("rep", J::Uint(u64::from(rep))),
                ("run", run),
            ]));
        }
    }

    println!("[4/6] single-slice tally over every access unit produced above");
    let report = J::Obj(vec![
        ("spike", J::s("0.9 nvenc configuration validation")),
        ("gpu", J::s(crate::env::gpu_name())),
        ("driver", J::s(crate::env::driver_version())),
        ("nvenc_api", J::s(crate::env::nvenc_api_versions())),
        ("gpu_load_before_run", J::s(load_before)),
        ("gpu_load_after_run", J::s(crate::env::gpu_load())),
        ("warmup_frames_discarded", J::Uint(WARMUP as u64)),
        ("m1_h264_vui_fix", vui),
        (
            "m2_forced_idr",
            J::Arr(vec![idr_h264, idr_hevc]),
        ),
        ("m3_bitrate_reconfigure", reconfigure),
        ("m4_single_slice", tally.to_json()),
        ("m5_hevc_parameter_sets", parameter_sets),
        ("m6_encode_latency", J::Arr(latency)),
        ("m6b_async_vs_sync", J::Arr(async_vs_sync)),
        ("m6c_multi_pass", J::Arr(multi_pass)),
    ]);

    let path = out.join("results.json");
    fs::write(&path, report.render()).map_err(|e| format!("write {}: {e}", path.display()))?;
    println!("wrote {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{pace, stats};
    use std::time::Instant;

    #[test]
    fn percentiles_come_from_the_sorted_sample() {
        let s = stats((1..=100).map(f64::from).collect());
        assert_eq!(s.n, 100);
        assert_eq!(s.p50, 50.0);
        assert_eq!(s.p95, 95.0);
        assert_eq!(s.max, 100.0);
        assert!((s.mean - 50.5).abs() < 1e-9);
    }

    #[test]
    fn an_empty_sample_is_not_a_zero() {
        let s = stats(vec![]);
        assert_eq!(s.n, 0);
        assert!(s.p50.is_nan() && s.p95.is_nan());
    }

    #[test]
    fn pacing_waits_for_the_deadline_and_never_goes_backwards() {
        let start = Instant::now();
        pace(start, 3, 1000); // 3 ms in
        assert!(start.elapsed().as_micros() >= 3000);
        // A deadline already in the past returns immediately.
        let before = Instant::now();
        pace(start, 0, 1000);
        assert!(before.elapsed().as_millis() < 5);
    }
}
