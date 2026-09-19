//! The **shared front half**: DXGI Desktop Duplication → NVENC → one encoded
//! access unit per desktop present, on one thread, with QPC stamps taken at
//! every stage.
//!
//! This is the half all three arms of plan.md D3 sit behind. It knows nothing
//! about WebRTC, data channels or `<video>` elements: it produces
//! [`crate::sink::EncodedAu`]s and hands them to whatever [`crate::sink::VideoSink`]
//! the run selected.
//!
//! Three rules here come from completed spikes and are not re-derived:
//!
//! - **One blocking `AcquireNextFrame` at an 8 ms timeout, no frame timer of our
//!   own, never sleep between calls** (spike 0.8 §10). DDA is vsync-locked; 8 ms
//!   is the measured knee.
//! - **The D3D11 device is created on the output's own adapter** (spike 0.8 §2).
//!   Cross-adapter duplication fails `E_INVALIDARG` and that is not retryable.
//! - **`LastPresentTime == 0` means no new desktop content** (spike 0.8 §8), so
//!   such a frame is released without being encoded and never becomes a sample.
//!
//! Hardware-dependent tests in this module are `#[ignore]`d. Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/bakeoff-host
//! cargo test -- --ignored --nocapture
//! ```

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT,
    DXGI_OUTDUPL_FRAME_INFO,
};

use crate::clock::{qpc, qpf};
use crate::nal::{self, Codec};
use crate::nvenc::{EncoderConfig, Session};
use crate::sink::HostStamps;

/// `AcquireNextFrame` timeout. Spike 0.8 §4 measured this as the knee: 61.3 % of
/// calls return `WAIT_TIMEOUT` cheaply, call p50 7.98 ms, and the tightest
/// inter-frame distribution of any blocking option.
const ACQUIRE_TIMEOUT_MS: u32 = 8;

/// One encoded picture, owned, on its way from the capture thread to the
/// transport thread.
pub struct Frame {
    pub data: Vec<u8>,
    pub codec: Codec,
    pub frame_id: u64,
    pub rtp_time_90k: u64,
    pub is_irap: bool,
    pub stamps: HostStamps,
}

/// Cross-thread control surface. The transport thread writes, the capture
/// thread reads — all through atomics, because the capture thread must never
/// block on a lock the transport thread might hold while it is inside a socket
/// wait.
#[derive(Default)]
pub struct Control {
    pub running: AtomicBool,
    /// Set by a [`crate::sink::SinkEvent::KeyframeRequest`]; cleared by the
    /// capture thread when it has forced the IDR.
    pub force_idr: AtomicBool,
    /// Target bitrate in bits per second, or 0 for "leave it alone". Written
    /// from `SinkEvent::BitrateEstimate`.
    pub retarget_bps: AtomicU32,
    pub frames_encoded: AtomicU64,
    pub frames_dropped_no_present: AtomicU64,
    /// The transport thread did not keep up. Counted rather than absorbed: a
    /// blocking send here would corrupt the capture pacing being measured.
    pub frames_dropped_queue_full: AtomicU64,
    pub acquire_timeouts: AtomicU64,
    pub access_lost_events: AtomicU64,
}

/// Everything the capture thread learned that belongs in the run's JSON.
#[derive(Clone, Debug, Default)]
pub struct CaptureReport {
    pub output_name: String,
    pub output_primary: bool,
    pub adapter_description: String,
    pub width: u32,
    pub height: u32,
    pub codec: &'static str,
    /// Desktop-present-to-desktop-present intervals, milliseconds. The evidence
    /// that the front half really was running at the panel's refresh rate.
    pub present_intervals_ms: Vec<f64>,
    /// Encode submit → completion event, milliseconds.
    pub encode_ms: Vec<f64>,
    /// Acquire → encode submit, milliseconds (the copy into the encode texture).
    pub copy_ms: Vec<f64>,
    /// Map, submit, wait, lock, copy out, unlock, unmap — the whole host-side
    /// per-frame encoder cost, milliseconds. Spike 0.9 measurement 6 found it
    /// within 0.1 ms of `encode_ms`; this is the check that it still is.
    pub encoder_total_ms: Vec<f64>,
    pub au_bytes: Vec<f64>,
    /// Parsed straight out of the first SPS the encoder emitted — this is how
    /// the VUI fix is *confirmed* rather than assumed.
    pub first_sps_hex: String,
    pub sps_bitstream_restriction_flag: Option<bool>,
    pub sps_max_num_reorder_frames: Option<u32>,
    pub sps_max_dec_frame_buffering: Option<u32>,
    pub sps_codec_string: Option<String>,
    /// Access units whose VCL NAL count was not exactly 1. Spike 0.9
    /// measurement 4 requires this assertion to be made by parsing NALs, not by
    /// reading `NV_ENC_LOCK_BITSTREAM::numSlices`, which is unavailable when
    /// `enableEncodeAsync = 1`.
    pub multi_slice_access_units: u64,
    pub irap_access_units: u64,
    /// IRAPs missing any of VPS / SPS / PPS in band. Chrome drops those
    /// silently (research/06 §2.3), so it must be zero.
    pub irap_missing_parameter_sets: u64,
    pub error: Option<String>,
}

pub struct CaptureConfig {
    pub output_index: usize,
    pub codec: Codec,
    pub fps: u32,
    pub bitrate_bps: u32,
    /// The VUI fix under test. `true` is the shipping setting; `false` exists
    /// only so the SPS parser can be shown to distinguish the two.
    pub bitstream_restriction: bool,
}

/// Run the front half until `control.running` goes false.
///
/// Every failure lands in [`CaptureReport::error`] rather than panicking: this
/// is a thread whose death would otherwise be silent, and a run that produced
/// no frames because duplication failed must say so in the JSON.
///
/// `published` is a snapshot the HTTP thread renders on demand. It is written
/// about once a second with `try_lock`, never per frame and never blocking —
/// the capture loop must not wait on a lock an HTTP request might hold.
pub fn run(
    cfg: CaptureConfig,
    control: Arc<Control>,
    tx: SyncSender<Frame>,
    published: Arc<Mutex<CaptureReport>>,
) {
    let mut report = CaptureReport {
        codec: match cfg.codec {
            Codec::H264 => "h264",
            Codec::Hevc => "hevc",
        },
        ..Default::default()
    };
    if let Err(e) = run_inner(&cfg, &control, &tx, &mut report, &published) {
        eprintln!("capture: {e}");
        report.error = Some(e);
    }
    control.running.store(false, Ordering::Relaxed);
    if let Ok(mut slot) = published.lock() {
        *slot = report;
    }
}

fn run_inner(
    cfg: &CaptureConfig,
    control: &Control,
    tx: &SyncSender<Frame>,
    report: &mut CaptureReport,
    published: &Mutex<CaptureReport>,
) -> Result<(), String> {
    let freq = qpf();
    let (adapter, output, info) =
        crate::dxgi::open_output(cfg.output_index).map_err(|e| format!("open_output: {e}"))?;
    if !info.attached_to_desktop {
        return Err(format!(
            "output {} is not attached to the desktop",
            info.global_index
        ));
    }
    if info.adapter_software {
        // Spike 0.8 §2: WARP has no outputs here and cannot duplicate anything.
        return Err(format!(
            "output {} is on software adapter {} ({}); there is no NVENC behind it",
            info.global_index, info.adapter_index, info.adapter_description
        ));
    }
    report.output_name = info.device_name.clone();
    report.output_primary = info.is_primary();
    report.adapter_description = info.adapter_description.clone();

    // Spike 0.8 §2: the device goes on the output's own adapter, never on
    // "adapter 0" and never on one chosen by description.
    let (device, context) =
        crate::dxgi::create_device(&adapter).map_err(|e| format!("create_device: {e}"))?;
    let dupl = crate::dxgi::duplicate(&output, &device)
        .map_err(|e| format!("DuplicateOutput: {} {e}", crate::dxgi::hresult(&e)))?;

    // Take the size from the acquired texture, not from DXGI_OUTDUPL_DESC:
    // spike 0.8 §3 measured a rotated output reporting ModeDesc 2160x3840 and
    // handing back a 3840x2160 texture. Here the first acquired frame settles
    // it, so the encoder is opened after the first frame rather than before.
    let (mut dupl, width, height, first) = first_frame(dupl, &output, &device)?;
    report.width = width;
    report.height = height;

    let encode_texture = create_encode_texture(&device, width, height)
        .map_err(|e| format!("create encode texture: {e}"))?;
    let mut encoder = Session::open(
        &device,
        EncoderConfig {
            codec: cfg.codec,
            width,
            height,
            fps: cfg.fps,
            bitrate_bps: cfg.bitrate_bps,
            bitstream_restriction: cfg.bitstream_restriction,
        },
    )?;
    let slot = encoder.register_texture(&encode_texture)?;

    let mut frame_id = 0u64;
    let mut first_present = 0i64;
    let mut last_present = 0i64;
    let mut pending: Option<(ID3D11Texture2D, i64, i64)> = first;

    while control.running.load(Ordering::Relaxed) {
        let acquired = match pending.take() {
            Some(v) => Some(v),
            None => match acquire(&mut dupl) {
                Ok(v) => v,
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    control.acquire_timeouts.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                    control.access_lost_events.fetch_add(1, Ordering::Relaxed);
                    dupl = recover(&output, &device)?;
                    control.force_idr.store(true, Ordering::Relaxed);
                    continue;
                }
                Err(e) => {
                    return Err(format!("AcquireNextFrame: {} {e}", crate::dxgi::hresult(&e)))
                }
            },
        };
        let Some((texture, present_qpc, acquired_qpc)) = acquired else {
            // A frame with LastPresentTime == 0 carries no new desktop content.
            control
                .frames_dropped_no_present
                .fetch_add(1, Ordering::Relaxed);
            continue;
        };

        unsafe { context.CopyResource(&encode_texture, &texture) };
        // Release before encoding: the duplication holds at most one frame and
        // the next AcquireNextFrame fails with DXGI_ERROR_INVALID_CALL until it
        // is released. The copy is already queued on this device's context, and
        // NVENC reads through the same device, so ordering is the driver's.
        drop(texture);
        let _ = unsafe { dupl.ReleaseFrame() };

        if let Some(bps) = take_retarget(control) {
            encoder.reconfigure_bitrate(bps)?;
        }
        let force_idr = frame_id == 0 || control.force_idr.swap(false, Ordering::Relaxed);
        let encoded = encoder.encode(slot, force_idr, frame_id)?;

        if first_present == 0 {
            first_present = present_qpc;
        }
        if last_present != 0 {
            report.present_intervals_ms.push(crate::clock::ticks_to_ms(
                present_qpc - last_present,
                freq,
            ));
        }
        last_present = present_qpc;

        let au = nal::summarize_access_unit(&encoded.data, cfg.codec);
        if au.vcl_nals != 1 {
            report.multi_slice_access_units += 1;
        }
        if au.irap {
            report.irap_access_units += 1;
            if !(au.has_vps && au.has_sps && au.has_pps) {
                report.irap_missing_parameter_sets += 1;
            }
        }
        if report.first_sps_hex.is_empty() {
            record_sps(report, &encoded.data, cfg.codec);
        }
        report.encode_ms.push(encoded.encode.as_secs_f64() * 1000.0);
        report
            .encoder_total_ms
            .push(encoded.total.as_secs_f64() * 1000.0);
        report.copy_ms.push(crate::clock::ticks_to_ms(
            encoded.submit_qpc - acquired_qpc,
            freq,
        ));
        report.au_bytes.push(encoded.data.len() as f64);

        let rtp_time_90k = ((present_qpc - first_present) as i128 * 90_000 / freq as i128) as u64;
        let frame = Frame {
            data: encoded.data,
            codec: cfg.codec,
            frame_id,
            rtp_time_90k,
            is_irap: au.irap,
            stamps: HostStamps {
                desktop_present: present_qpc,
                acquired: acquired_qpc,
                encode_submit: encoded.submit_qpc,
                encode_done: encoded.done_qpc,
                enqueued: qpc(),
                pushed: 0,
            },
        };
        frame_id += 1;
        control.frames_encoded.fetch_add(1, Ordering::Relaxed);
        if tx.try_send(frame).is_err() {
            control
                .frames_dropped_queue_full
                .fetch_add(1, Ordering::Relaxed);
        }

        if frame_id.is_multiple_of(60) {
            if let Ok(mut slot) = published.try_lock() {
                *slot = report.clone();
            }
        }
    }
    Ok(())
}

fn take_retarget(control: &Control) -> Option<u32> {
    let bps = control.retarget_bps.swap(0, Ordering::Relaxed);
    (bps > 0).then_some(bps)
}

type Acquired = Option<(ID3D11Texture2D, i64, i64)>;

/// One `AcquireNextFrame`. `Ok(None)` means the frame carried no new desktop
/// content and has already been released.
fn acquire(dupl: &mut IDXGIOutputDuplication) -> windows::core::Result<Acquired> {
    let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
    let mut resource: Option<IDXGIResource> = None;
    unsafe { dupl.AcquireNextFrame(ACQUIRE_TIMEOUT_MS, &mut info, &mut resource) }?;
    let acquired_qpc = qpc();
    let present = info.LastPresentTime;
    if present == 0 {
        drop(resource);
        let _ = unsafe { dupl.ReleaseFrame() };
        return Ok(None);
    }
    let texture: ID3D11Texture2D = resource
        .ok_or_else(windows::core::Error::from_thread)?
        .cast()?;
    Ok(Some((texture, present, acquired_qpc)))
}

/// Block until the first frame that carries desktop content, so the encoder can
/// be opened at the texture's real dimensions. Returns the duplication it ended
/// up with, which is not the one it was given if the desktop switched.
fn first_frame(
    dupl: IDXGIOutputDuplication,
    output: &windows::Win32::Graphics::Dxgi::IDXGIOutput,
    device: &ID3D11Device,
) -> Result<(IDXGIOutputDuplication, u32, u32, Acquired), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut current = dupl;
    loop {
        if std::time::Instant::now() > deadline {
            return Err("no desktop frame within 10 s — is anything changing on screen?".into());
        }
        match acquire(&mut current) {
            Ok(Some((texture, present, acquired))) => {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                unsafe { texture.GetDesc(&mut desc) };
                return Ok((
                    current,
                    desc.Width,
                    desc.Height,
                    Some((texture, present, acquired)),
                ));
            }
            Ok(None) => continue,
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
            Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                current = recover(output, device)?;
            }
            Err(e) => return Err(format!("AcquireNextFrame: {} {e}", crate::dxgi::hresult(&e))),
        }
    }
}

/// Spike 0.8 §10's recovery sequence, minus the re-enumeration step: this spike
/// runs one output on a machine whose display configuration does not change
/// during a run, so the duplication is recreated on the same device. A product
/// implementation (Task 3.6) must also drop the factory and re-enumerate,
/// because `DesktopCoordinates` and the mode can have changed.
fn recover(
    output: &windows::Win32::Graphics::Dxgi::IDXGIOutput,
    device: &ID3D11Device,
) -> Result<IDXGIOutputDuplication, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        std::thread::sleep(Duration::from_millis(50));
        match crate::dxgi::duplicate(output, device) {
            Ok(d) => return Ok(d),
            Err(e) if e.code() == windows::Win32::Foundation::E_INVALIDARG => {
                // Spike 0.8 §10 step 3: E_INVALIDARG means the device is on the
                // wrong adapter. Retrying cannot fix it.
                return Err(format!("DuplicateOutput: E_INVALIDARG (wrong adapter) {e}"));
            }
            Err(e) if std::time::Instant::now() > deadline => {
                return Err(format!(
                    "DuplicateOutput did not recover within 5 s: {} {e}",
                    crate::dxgi::hresult(&e)
                ))
            }
            Err(_) => continue,
        }
    }
}

fn create_encode_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> windows::core::Result<ID3D11Texture2D> {
    // Same description Desktop Duplication hands back and the one NVENC
    // requires of a registered DirectX input resource.
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture))? };
    Ok(texture.expect("CreateTexture2D succeeded without producing a texture"))
}

/// Pull the first SPS out of the bitstream and read its VUI back. This is the
/// spike's evidence for the D5 VUI fix: the flag is confirmed in the emitted
/// stream, never inferred from what the encoder was asked for.
fn record_sps(report: &mut CaptureReport, data: &[u8], codec: Codec) {
    let Some(sps) = nal::parse_annexb(data, codec)
        .into_iter()
        .find(|n| n.ty == sps_type(codec))
    else {
        return;
    };
    let payload = &data[sps.start..sps.end];
    report.first_sps_hex = payload.iter().map(|b| format!("{b:02x}")).collect();
    if codec == Codec::H264 {
        if let Some(parsed) = nal::parse_h264_sps(payload) {
            report.sps_bitstream_restriction_flag = Some(parsed.bitstream_restriction_flag);
            report.sps_max_num_reorder_frames = parsed.max_num_reorder_frames;
            report.sps_max_dec_frame_buffering = parsed.max_dec_frame_buffering;
            report.sps_codec_string = Some(parsed.codec_string());
        }
    }
}

fn sps_type(codec: Codec) -> u8 {
    match codec {
        Codec::H264 => nal::H264_NAL_SPS,
        Codec::Hevc => nal::HEVC_NAL_SPS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_acquire_timeout_is_spike_0_8s_measured_knee() {
        assert_eq!(ACQUIRE_TIMEOUT_MS, 8);
    }

    #[test]
    fn sps_type_differs_between_the_two_codecs() {
        assert_eq!(sps_type(Codec::H264), 7);
        assert_eq!(sps_type(Codec::Hevc), 33);
    }

    #[test]
    fn a_retarget_is_taken_once_and_then_cleared() {
        let control = Control::default();
        assert_eq!(take_retarget(&control), None);
        control.retarget_bps.store(5_000_000, Ordering::Relaxed);
        assert_eq!(take_retarget(&control), Some(5_000_000));
        assert_eq!(take_retarget(&control), None);
    }

    #[test]
    fn the_sps_reader_distinguishes_the_vui_fix_from_its_absence() {
        // The two streams spike 0.9 measurement 1 emitted at level 4.2, byte
        // for byte, so a regression in the parser shows up here rather than as
        // a plausible-looking number in a run's JSON.
        let with = hex("00000001" .to_owned() + "6764002aac2b280f0044fcb808800001f40000ea60478e152c");
        let without = hex("00000001".to_owned() + "6764002aac2b280f0044fcb808800001f40000ea6042");
        let mut on = CaptureReport::default();
        record_sps(&mut on, &with, Codec::H264);
        let mut off = CaptureReport::default();
        record_sps(&mut off, &without, Codec::H264);
        assert_eq!(on.sps_bitstream_restriction_flag, Some(true));
        assert_eq!(on.sps_max_num_reorder_frames, Some(0));
        // Spike 0.9 amendment 1: max_dec_frame_buffering tracks maxNumRefFrames
        // and cannot be asked for as 0. max_num_reorder_frames is the field
        // that removes the decoder's output delay.
        assert_eq!(on.sps_max_dec_frame_buffering, Some(4));
        assert_eq!(on.sps_codec_string.as_deref(), Some("avc1.64002a"));
        assert_eq!(off.sps_bitstream_restriction_flag, Some(false));
        assert_eq!(off.sps_max_num_reorder_frames, None);
    }

    fn hex(s: String) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }
}
