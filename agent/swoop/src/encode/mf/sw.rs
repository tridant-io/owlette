//! `mf-sw`: Microsoft's in-box H.264 encoder MFT, on the CPU — the floor for
//! a VM or a box whose GPU has no encoder. Never x264 (GPL), and no software
//! HEVC.
//!
//! The frame is converted to NV12 on the GPU like every other rung's, copied
//! to a staging texture and read back, then encoded synchronously on the
//! calling thread: the encoder answers each input before `encode` returns. A
//! device with no video processor — WARP, which is what a virtual machine or
//! a box with no GPU renders on, the very case this rung is for — reads the
//! BGRA back instead and converts it on the CPU
//! (`gpu::scale::bgra_to_nv12_cpu`), the one CPU colour conversion in the
//! crate and only where no GPU path exists.
//!
//! These are signage boxes running TouchDesigner, so the floor is capped where
//! it cannot take the machine with it: at most [`MAX_WIDTH`]x[`MAX_HEIGHT`]
//! (`probe` reports it, so the session downscales to it), at most [`MAX_FPS`]
//! (frames that arrive sooner are passed over here, a forced keyframe carried
//! to the next one taken), and [`WORKER_THREADS`] encoder threads.
//!
//! # Hardware test
//!
//! ```text
//! cargo test --lib -- --ignored mf_sw --test-threads=1 --nocapture   # working directory agent/swoop
//! ```
//!
//! The encoder is the CPU's; the convert runs on the GPU, and on WARP in the
//! test that stands in for a virtual machine. Run with `--release` for numbers
//! a shipped streamer would see: a debug build converts on WARP several times
//! slower.
//!
//! Measured on the spike 6.7 box (i9-9900X, 10 cores; Windows 11 23H2),
//! release, three runs, 720p30 at 10 Mbps: `encode()` 10.30-11.88 ms p50 and
//! 12.15-16.48 ms p95 with the GPU convert and readback, a forced IDR
//! 13.52-16.54 ms; 60 s held 9.72-9.75 Mbps (-2.8 to -2.5 %), 1800 of 1800
//! frames, with the same p95 in the last 10 s as the first, so nothing queues.
//! On WARP, converting on the CPU: 12.01-13.29 / 14.87-18.05 ms. Not measured
//! on a 4-core VM. The rest, and the method, are
//! in `dev/active/swoop/spikes/6.7-encoder-breadth.md`.

use std::ffi::c_void;
use std::time::{Duration, Instant};

use windows::core::{Interface, GUID};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Media::MediaFoundation::{
    eAVEncH264VProfile_Main, CODECAPI_AVEncCommonQualityVsSpeed, CODECAPI_AVEncNumWorkerThreads,
    ICodecAPI, IMFSample, IMFTransform, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MF_E_TRANSFORM_NEED_MORE_INPUT,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::VARIANT;

use super::{
    admit, api, assemble, configure, force_keyframe, mfplat, process_output, qpc_now, read_sample,
    retarget, sample_time, sequence_header, set_types, texture_of, Apartment, MfError, Mfplat,
};
use crate::encode::{BackendCaps, Codec, CodecCaps, EncodedFrame, Encoder, EncoderConfig};
use crate::gpu::scale::{bgra_to_nv12_cpu, Downscaler, Readback, ScaleError};
use crate::gpu::Frame;
use crate::session::RateGate;

const BACKEND: &str = "mf-sw";

/// The ceiling `create` holds to: 720p30, the task's default for a 4-core
/// VM. `probe` reports the size, which the session downscales to; the rate
/// is held here. See the module doc for what it measured.
pub const MAX_WIDTH: u32 = 1280;
pub const MAX_HEIGHT: u32 = 720;
pub const MAX_FPS: u32 = 30;

/// The encoder's own threads. Its default is one per core, which on a
/// signage box is every core TouchDesigner wanted.
const WORKER_THREADS: u32 = 2;

/// `CODECAPI_AVEncCommonQualityVsSpeed`, 0 (fastest) to 100 (best).
const QUALITY_VS_SPEED: u32 = 33;

/// Viewers the session admits on this rung. Every viewer shares the one
/// H.264 encoder, so this is the bundle's default viewer cap, not a count of
/// encoders this CPU could run.
const BUDGET: u32 = 4;

/// `CLSID_CMSH264EncoderMFT` from wmcodecdsp.h, which the `windows` crate
/// does not carry: Microsoft's H.264 encoder, mfh264enc.dll.
const CLSID_MSH264_ENCODER: GUID = GUID::from_u128(0x6ca50344_051a_4ded_9779_a43305165e35);

/// The encoder, on a thread already in an [`Apartment`].
fn instantiate() -> Result<(&'static Mfplat, IMFTransform), MfError> {
    let mf = mfplat()?;
    // SAFETY: an in-process COM object, owned by the returned interface.
    let transform = unsafe { CoCreateInstance(&CLSID_MSH264_ENCODER, None, CLSCTX_INPROC_SERVER) }
        .map_err(api("CoCreateInstance(CLSID_CMSH264EncoderMFT)"))?;
    Ok((mf, transform))
}

/// Whether the in-box encoder is on this machine, and the ceiling it is held
/// to. Instantiating it is a few milliseconds and encodes nothing.
pub fn probe() -> BackendCaps {
    let _apartment = Apartment::enter();
    let available = instantiate().is_ok();
    BackendCaps {
        backend: BACKEND,
        codecs: if available {
            vec![CodecCaps {
                codec: Codec::H264,
                max_width: MAX_WIDTH,
                max_height: MAX_HEIGHT,
            }]
        } else {
            Vec::new()
        },
        accepts_bgra_texture: false,
        // not measured: probe never encodes. The 30 fps cap is the encoder's
        // own (its RateGate), not something a selector reads.
        max_fps: 0,
        concurrent_sessions: if available { BUDGET } else { 0 },
    }
}

/// Open an `mf-sw` encoder for `cfg`. The encoder opens here; the GPU half
/// (the convert and the staging texture) on the first frame, from its device.
pub fn create(cfg: &EncoderConfig) -> anyhow::Result<Box<dyn Encoder>> {
    Ok(Box::new(SwEncoder::open(cfg)?))
}

impl SwEncoder {
    fn open(cfg: &EncoderConfig) -> Result<Self, MfError> {
        admit(cfg, MAX_WIDTH, MAX_HEIGHT)?;
        let apartment = Apartment::enter();
        let (mf, transform) = instantiate()?;
        let fps = cfg.fps.clamp(1, MAX_FPS);
        let codec: ICodecAPI = transform.cast().map_err(api("QueryInterface(ICodecAPI)"))?;
        configure(
            &codec,
            cfg,
            fps,
            BACKEND,
            vec![
                (
                    CODECAPI_AVEncNumWorkerThreads,
                    VARIANT::from(WORKER_THREADS),
                    "worker threads",
                ),
                (
                    CODECAPI_AVEncCommonQualityVsSpeed,
                    VARIANT::from(QUALITY_VS_SPEED),
                    "quality vs speed",
                ),
            ],
        );
        set_types(
            mf,
            &transform,
            cfg.width,
            cfg.height,
            fps,
            cfg.bitrate_bps,
            eAVEncH264VProfile_Main.0,
        )?;
        // SAFETY: plain calls on the configured transform.
        let info =
            unsafe { transform.GetOutputStreamInfo(0) }.map_err(api("GetOutputStreamInfo"))?;
        unsafe {
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(api("MFT_MESSAGE_NOTIFY_BEGIN_STREAMING"))?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(api("MFT_MESSAGE_NOTIFY_START_OF_STREAM"))?;
        }
        Ok(Self {
            header: sequence_header(&transform),
            out_len: info.cbSize.max(cfg.width * cfg.height * 3 / 2),
            cfg: cfg.clone(),
            fps,
            transform,
            codec,
            gpu: None,
            gate: RateGate::default(),
            carried_irap: false,
            frame_id: 0,
            _apartment: apartment,
        })
    }
}

struct SwEncoder {
    cfg: EncoderConfig,
    fps: u32,
    transform: IMFTransform,
    codec: ICodecAPI,
    header: Vec<u8>,
    out_len: u32,
    gpu: Option<Gpu>,
    gate: RateGate,
    /// A forced keyframe asked for on a frame the rate cap passed over.
    carried_irap: bool,
    frame_id: u64,
    /// Last, so it drops after the encoder it holds COM for.
    _apartment: Apartment,
}

// SAFETY: the MFT, its codec api and the device are used from exactly one
// thread at a time — the capture thread makes the encoder, owns it and drops
// it, which is also what keeps its apartment balanced.
unsafe impl Send for SwEncoder {}

impl Encoder for SwEncoder {
    fn encode(&mut self, frame: &Frame, force_irap: bool) -> anyhow::Result<Option<EncodedFrame>> {
        if (frame.width, frame.height) != (self.cfg.width, self.cfg.height) {
            return Err(MfError::SizeChanged {
                got_width: frame.width,
                got_height: frame.height,
                want_width: self.cfg.width,
                want_height: self.cfg.height,
            }
            .into());
        }
        self.carried_irap |= force_irap;
        let interval = Duration::from_micros(1_000_000 / u64::from(self.fps));
        if !self.gate.admit(Instant::now(), interval) {
            return Ok(None);
        }

        let raw = frame.handle as *mut c_void;
        let texture = texture_of(&raw)?;
        // SAFETY: the device that owns the borrowed texture.
        let device = unsafe { texture.GetDevice() }.map_err(api("GetDevice"))?;
        let gpu = match &mut self.gpu {
            Some(gpu) if gpu.device.as_raw() != device.as_raw() => {
                return Err(MfError::DeviceChanged.into())
            }
            Some(gpu) => gpu,
            None => self.gpu.insert(Gpu::open(frame, device)?),
        };
        let mf = mfplat()?;
        let sample = gpu.read_back(mf, frame)?;
        // SAFETY: plain writes on a sample owned here.
        unsafe {
            sample
                .SetSampleTime(sample_time(self.frame_id, self.fps))
                .map_err(api("SetSampleTime"))?;
            sample
                .SetSampleDuration(sample_time(1, self.fps))
                .map_err(api("SetSampleDuration"))?;
        }
        if std::mem::take(&mut self.carried_irap) {
            force_keyframe(&self.codec)?;
        }
        // SAFETY: the sample is alive for the call.
        unsafe { self.transform.ProcessInput(0, &sample, 0) }.map_err(api("ProcessInput"))?;

        // low-latency mode answers every input before asking for the next, so
        // this is one output; anything more would be the same picture's tail
        let mut data = Vec::new();
        loop {
            match process_output(mf, &self.transform, Some(self.out_len)) {
                Ok(Some(output)) => data.extend(read_sample(&output)?.0),
                Ok(None) => self.header = sequence_header(&self.transform),
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => break,
                Err(e) => {
                    return Err(MfError::Api {
                        call: "ProcessOutput",
                        source: e,
                    }
                    .into())
                }
            }
        }
        let frame_id = self.frame_id;
        self.frame_id += 1;
        if data.is_empty() {
            return Ok(None);
        }
        let (data, is_irap) = assemble(&data, &self.header);
        Ok(Some(EncodedFrame {
            data,
            is_irap,
            codec: Codec::H264,
            width: self.cfg.width,
            height: self.cfg.height,
            frame_id,
            captured_qpc: frame.captured_qpc,
            encoded_qpc: qpc_now(),
        }))
    }

    fn set_bitrate(&mut self, bitrate_bps: u32) -> anyhow::Result<()> {
        self.cfg.bitrate_bps = bitrate_bps;
        retarget(&self.codec, bitrate_bps, self.fps)?;
        Ok(())
    }
}

/// The GPU half: how a captured frame becomes a packed NV12 sample, pinned to
/// the device that owns the captured frames.
struct Gpu {
    device: ID3D11Device,
    convert: Convert,
    width: u32,
    height: u32,
}

enum Convert {
    /// The video processor converts, and the NV12 comes back through a
    /// staging copy.
    Video {
        convert: Downscaler,
        readback: Readback,
    },
    /// No video processor — WARP, on a virtual machine or a box with no GPU,
    /// the case this rung exists for: the BGRA comes back and is converted
    /// here.
    Cpu(Readback),
}

impl Gpu {
    fn open(frame: &Frame, device: ID3D11Device) -> Result<Self, MfError> {
        let (width, height) = (frame.width, frame.height);
        let convert = match Downscaler::open_nv12(frame, width, height) {
            Ok(convert) => Convert::Video {
                convert,
                readback: Readback::nv12(&device, width, height)?,
            },
            // only where no gpu path exists; any other failure is the rung's
            Err(ScaleError::NoVideoProcessor) => {
                ::log::info!(
                    "swoop: {BACKEND} converts on the cpu: this device has no video processor"
                );
                Convert::Cpu(Readback::bgra(&device, width, height)?)
            }
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            device,
            convert,
            width,
            height,
        })
    }

    /// The frame as one tightly packed NV12 sample: the luma plane, then the
    /// interleaved chroma plane at half height.
    fn read_back(&mut self, mf: &Mfplat, frame: &Frame) -> Result<IMFSample, MfError> {
        let (width, height) = (self.width as usize, self.height as usize);
        let len = width * height * 3 / 2;
        let buffer = mf.memory_buffer(len as u32)?;
        let mut dst: *mut u8 = std::ptr::null_mut();
        // SAFETY: the buffer was made `len` bytes long and stays locked until
        // the unlock below, whatever the fill returns.
        unsafe { buffer.Lock(&mut dst, None, None) }.map_err(api("IMFMediaBuffer::Lock"))?;
        let filled = self.fill(frame, unsafe { std::slice::from_raw_parts_mut(dst, len) });
        // SAFETY: the lock above.
        let _ = unsafe { buffer.Unlock() };
        filled?;
        let sample = mf.sample()?;
        // SAFETY: plain calls on objects owned here; the sample takes its own
        // reference to the buffer.
        unsafe {
            buffer
                .SetCurrentLength(len as u32)
                .map_err(api("SetCurrentLength"))?;
            sample.AddBuffer(&buffer).map_err(api("AddBuffer"))?;
        }
        Ok(sample)
    }

    fn fill(&mut self, frame: &Frame, dst: &mut [u8]) -> Result<(), MfError> {
        let width = self.width as usize;
        match &mut self.convert {
            Convert::Video { convert, readback } => {
                let nv12 = convert.scale(frame)?;
                let raw = nv12.handle as *mut c_void;
                // both planes, row by row, out of the pitched surface
                readback.read(texture_of(&raw)?, |pixels, pitch| {
                    for (row, out) in dst.chunks_mut(width).enumerate() {
                        out.copy_from_slice(&pixels[row * pitch..row * pitch + width]);
                    }
                })?;
            }
            Convert::Cpu(readback) => {
                let raw = frame.handle as *mut c_void;
                let size = (self.width, self.height);
                readback.read(texture_of(&raw)?, |pixels, pitch| {
                    bgra_to_nv12_cpu(pixels, pitch, size, dst)
                })?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

    use super::*;
    use crate::encode::h264_sps::nal_units;
    use crate::encode::mf::testkit::{device, frames, keep, ltr, percentile, read_unit, warp};

    fn cfg() -> EncoderConfig {
        EncoderConfig {
            codec: Codec::H264,
            width: MAX_WIDTH,
            height: MAX_HEIGHT,
            // what the session asks every encoder for; the rung holds to 30
            fps: 60,
            bitrate_bps: 10_000_000,
        }
    }

    /// What a paced run saw: each encoded frame with how long `encode` took.
    struct Run {
        units: Vec<(EncodedFrame, Duration)>,
        /// The frame id the forced input came out as.
        forced_id: Option<u64>,
    }

    /// Feed `count` frames at 60 Hz, as capture would, forcing an IDR on input
    /// `force` and moving the bitrate at input `retarget`.
    fn drive(
        encoder: &mut SwEncoder,
        textures: &[ID3D11Texture2D],
        count: u32,
        force: Option<u32>,
        retarget: Option<(u32, u32)>,
    ) -> Run {
        let interval = Duration::from_secs_f64(1.0 / 60.0);
        let mut units = Vec::new();
        let mut forced_id = None;
        let mut pending_force = false;
        let start = Instant::now();
        for i in 0..count {
            let due = start + interval * i;
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            if let Some((_, bitrate)) = retarget.filter(|(at, _)| *at == i) {
                encoder.set_bitrate(bitrate).expect("the rate moves");
            }
            let texture = &textures[i as usize % textures.len()];
            let frame = Frame {
                handle: texture.as_raw() as usize,
                width: encoder.cfg.width,
                height: encoder.cfg.height,
                captured_qpc: qpc_now(),
            };
            let forcing = force == Some(i);
            pending_force |= forcing;
            let began = Instant::now();
            let answered = encoder.encode(&frame, forcing).expect("the frame encodes");
            let took = began.elapsed();
            if let Some(encoded) = answered {
                if std::mem::take(&mut pending_force) {
                    forced_id = Some(encoded.frame_id);
                }
                units.push((encoded, took));
            }
        }
        Run { units, forced_id }
    }

    /// Needs the in-box encoder: any Windows but an N edition without the
    /// Media Feature Pack.
    #[test]
    #[ignore = "needs media foundation's h.264 encoder"]
    fn mf_sw_probe_answers_quickly_with_its_ceiling() {
        let started = Instant::now();
        let caps = probe();
        let took = started.elapsed();
        println!("mf-sw probe in {took:?}: {caps:?}");
        assert_eq!(caps.backend, "mf-sw");
        assert_eq!(caps.codecs.len(), 1, "h.264 and nothing else");
        assert_eq!(
            (
                caps.codecs[0].codec,
                caps.codecs[0].max_width,
                caps.codecs[0].max_height
            ),
            (Codec::H264, MAX_WIDTH, MAX_HEIGHT)
        );
        assert!(took < Duration::from_secs(1), "probe must stay fast");
    }

    /// Needs the in-box encoder. Prints, for the spike memo only.
    #[test]
    #[ignore = "needs media foundation's h.264 encoder"]
    fn mf_sw_ltr_advertisement() {
        let _apartment = Apartment::enter();
        let (_, transform) = instantiate().expect("the in-box encoder");
        let codec: ICodecAPI = transform.cast().expect("a codec api");
        println!("mf-sw ltr: {}", ltr(&codec));
    }

    /// Needs a d3d11 device and the in-box encoder: `cargo test --lib --
    /// --ignored mf_sw`. Set `MF_ANNEXB_DIR` to keep the bitstream for the
    /// Chrome decode check.
    #[test]
    #[ignore = "needs a d3d11 device and media foundation's h.264 encoder"]
    fn mf_sw_encodes_720p30_with_what_chrome_needs() {
        let device = device();
        let textures = frames(&device, MAX_WIDTH, MAX_HEIGHT, 8);
        let mut encoder = SwEncoder::open(&cfg()).expect("the encoder opens");
        let own_sps = nal_units(&encoder.header)
            .into_iter()
            .find(|(ty, _)| *ty == crate::encode::h264_sps::NAL_SPS)
            .map(|(_, range)| encoder.header[range].to_vec());
        println!(
            "  the encoder's own sps: {}",
            own_sps.as_deref().map(hex::encode).unwrap_or_default()
        );
        let run = drive(
            &mut encoder,
            &textures,
            600,
            Some(301),
            Some((450, 5_000_000)),
        );
        let forced_id = run.forced_id.expect("the forced frame came out");

        let iraps: Vec<u64> = run
            .units
            .iter()
            .filter(|(f, _)| f.is_irap)
            .map(|(f, _)| f.frame_id)
            .collect();
        let mut max_slices = 0;
        let mut wire_sps = None;
        for (frame, _) in &run.units {
            let (slices, sps) = read_unit(&frame.data);
            max_slices = max_slices.max(slices);
            if wire_sps.is_none() {
                wire_sps = sps;
            }
        }
        let (sps_bytes, sps) = wire_sps.expect("the first access unit carries an sps");
        let steady: Vec<Duration> = run
            .units
            .iter()
            .filter(|(f, _)| !f.is_irap)
            .map(|(_, took)| *took)
            .collect();
        let size = |id: u64| {
            run.units
                .iter()
                .find(|(f, _)| f.frame_id == id)
                .map_or(0, |(f, _)| f.data.len())
        };
        let forced = run
            .units
            .iter()
            .find(|(f, _)| f.frame_id == forced_id)
            .map(|(_, took)| *took)
            .expect("the forced frame");
        let deltas = run
            .units
            .iter()
            .filter(|(f, _)| !f.is_irap && f.frame_id < forced_id)
            .map(|(f, _)| f.data.len())
            .sum::<usize>()
            / (forced_id as usize - 1);
        println!(
            "mf-sw 720p30: {} of 600 inputs encoded; encode() p50 {:.2} ms p95 {:.2} ms; forced idr {:.2} ms; iraps at {iraps:?}; keyframe {} B, forced {} B, mean delta {deltas} B; max {max_slices} slice",
            run.units.len(),
            percentile(&steady, 0.5),
            percentile(&steady, 0.95),
            forced.as_secs_f64() * 1e3,
            size(0),
            size(forced_id),
        );
        println!(
            "  wire sps {} avc1.{:02x}{:02x}{:02x}: restriction={} reorder={:?} dec_buffering={:?} refs={}",
            hex::encode(&sps_bytes),
            sps.profile_idc,
            sps.constraint_flags,
            sps.level_idc,
            sps.bitstream_restriction_flag,
            sps.max_num_reorder_frames,
            sps.max_dec_frame_buffering,
            sps.max_num_ref_frames,
        );
        keep(
            "mf-sw-720p30.h264",
            &run.units
                .iter()
                .take(150)
                .map(|(f, _)| f.data.clone())
                .collect::<Vec<_>>(),
        );

        // 60 hz in, 30 out: the rung's own ceiling
        assert!(
            (295..=305).contains(&run.units.len()),
            "{} encoded",
            run.units.len()
        );
        assert_eq!(
            iraps,
            vec![0, forced_id],
            "the first frame and the forced one, and the rate move costs none"
        );
        assert_eq!(max_slices, 1, "every access unit is a single slice");
        assert!(sps.declares_no_reordering());
    }

    /// Needs a d3d11 device and the in-box encoder; a minute long.
    #[test]
    #[ignore = "needs a d3d11 device and media foundation's h.264 encoder"]
    fn mf_sw_holds_its_bitrate_for_a_minute() {
        let device = device();
        let textures = frames(&device, MAX_WIDTH, MAX_HEIGHT, 8);
        let mut encoder = SwEncoder::open(&cfg()).expect("the encoder opens");
        let run = drive(&mut encoder, &textures, 60 * 60, None, None);
        // seconds 5 to 60, as the hardware test measures it
        let held: Vec<&(EncodedFrame, Duration)> = run
            .units
            .iter()
            .filter(|(f, _)| f.frame_id >= 150)
            .collect();
        let bits: usize = held.iter().map(|(f, _)| f.data.len() * 8).sum();
        let rate = bits as f64 / (held.len() as f64 / f64::from(MAX_FPS));
        let ratio = rate / f64::from(cfg().bitrate_bps);
        let took: Vec<Duration> = held.iter().map(|(_, took)| *took).collect();
        let (first, last) = (&took[..300], &took[took.len() - 300..]);
        println!(
            "mf-sw 60 s at 720p30, 10 mbps: {} frames encoded, {:.2} mbps ({:+.1} %); encode() p50/p95 first 10 s {:.2}/{:.2} ms, last 10 s {:.2}/{:.2} ms",
            run.units.len(),
            rate / 1e6,
            (ratio - 1.0) * 100.0,
            percentile(first, 0.5),
            percentile(first, 0.95),
            percentile(last, 0.5),
            percentile(last, 0.95),
        );
        assert!(
            (1790..=1810).contains(&run.units.len()),
            "it kept up at 30 fps"
        );
        assert!((0.9..=1.1).contains(&ratio), "the rate held within 10 %");
        assert!(
            percentile(last, 0.95) < 1000.0 / f64::from(MAX_FPS),
            "no queue growth"
        );
    }

    /// Needs only the in-box encoder: WARP stands in for a virtual machine's
    /// display, which has no video processor, so the convert runs on the CPU.
    #[test]
    #[ignore = "needs media foundation's h.264 encoder"]
    fn mf_sw_encodes_on_warp_where_there_is_no_video_processor() {
        let device = warp();
        let textures = frames(&device, MAX_WIDTH, MAX_HEIGHT, 8);
        let mut encoder = SwEncoder::open(&cfg()).expect("the encoder opens");
        let run = drive(&mut encoder, &textures, 240, None, None);
        assert!(matches!(
            encoder.gpu.as_ref().map(|gpu| &gpu.convert),
            Some(Convert::Cpu(_))
        ));
        let took: Vec<Duration> = run.units.iter().skip(1).map(|(_, took)| *took).collect();
        let (_, sps) = read_unit(&run.units[0].0.data);
        println!(
            "mf-sw on warp, 720p30: {} of 240 inputs encoded; encode() p50 {:.2} ms p95 {:.2} ms",
            run.units.len(),
            percentile(&took, 0.5),
            percentile(&took, 0.95),
        );
        keep(
            "mf-sw-warp-720p30.h264",
            &run.units
                .iter()
                .map(|(f, _)| f.data.clone())
                .collect::<Vec<_>>(),
        );
        // the ceiling holds; whether the cpu keeps up with it is the printed
        // rate, which a debug build does not
        assert!(run.units.len() <= 125, "{} encoded", run.units.len());
        assert!(run.units[0].0.is_irap);
        assert!(sps.expect("an sps in band").1.declares_no_reordering());
    }
}
