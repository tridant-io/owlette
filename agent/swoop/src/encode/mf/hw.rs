//! `mf-hw`: the GPU vendor's hardware H.264 encoder, through Media Foundation.
//!
//! The encoder is the MFT `MFTEnum2` lists first for the capture device's own
//! adapter (`MFT_ENUM_ADAPTER_LUID`), so on a hybrid laptop it is the encoder
//! of the GPU that owns the captured texture. Hardware MFTs are asynchronous:
//! unlocked with `MF_TRANSFORM_ASYNC_UNLOCK`, they ask for input with
//! `METransformNeedInput` and announce output with `METransformHaveOutput` on
//! their event queue. A pump thread here waits on that queue; `encode` converts
//! the frame to NV12 into a small ring of textures and submits it as soon as
//! the encoder has asked, and the pump hands each finished frame to the
//! session's [`Sink`] — so the next capture overlaps this encode, as
//! VideoToolbox's does. Without a sink `encode` answers whatever has finished.
//!
//! The encoder reads the NV12 texture on its own threads, so the device is put
//! under D3D11 multithread protection when a session opens, and a ring slot is
//! reused only once the input that used it last has come out.
//!
//! # Hardware test
//!
//! ```text
//! cargo test --lib -- --ignored mf_hw --test-threads=1 --nocapture   # working directory agent/swoop
//! ```
//!
//! On a box with no hardware encoder MFT the tests fail at the first assert,
//! which is the honest answer — they are not skipped. Add `--release` for the
//! numbers a shipped streamer sees.
//!
//! Measured on the spike 6.7 box, through NVIDIA's own MFT (RTX 2080 Ti, driver
//! 591.86), release, three runs: 1080p60 at 20 Mbps, submit to sink 4.98-5.71
//! ms p50 and 5.38-11.64 ms p95, a forced IDR 5.10-7.45 ms; 4K60 at 40 Mbps
//! 12.06 / 29.31 ms; 60 s at 1080p60 held 18.92 Mbps (-5.4 %) with never more
//! than one input in flight and no rise in latency. Intel and AMD are not
//! measured. The rest, and the method, are in
//! `dev/active/swoop/spikes/6.7-encoder-breadth.md`.

use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Multithread};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::{
    eAVEncH264VProfile_High, ICodecAPI, IMF2DBuffer, IMFActivate, IMFMediaEventGenerator,
    IMFShutdown, IMFTransform, MEError, METransformHaveOutput, METransformNeedInput,
    MFVideoFormat_H264, MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS, MFT_ENUM_ADAPTER_LUID,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_MESSAGE_COMMAND_FLUSH,
    MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_START_OF_STREAM,
    MFT_MESSAGE_SET_D3D_MANAGER, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_SET_TYPE_TEST_ONLY,
    MF_EVENT_TYPE, MF_E_SHUTDOWN, MF_MT_AVG_BITRATE, MF_MT_MPEG2_PROFILE, MF_TRANSFORM_ASYNC,
    MF_TRANSFORM_ASYNC_UNLOCK,
};

use super::{
    api, assemble, configure, force_keyframe, mfplat, process_output, qpc_now, read_sample,
    retarget, sample_time, sequence_header, set_types, texture_of, video_type, Apartment, MfError,
    Mfplat,
};
use crate::encode::{BackendCaps, Codec, CodecCaps, EncodedFrame, Encoder, EncoderConfig, Sink};
use crate::gpu::scale::Downscaler;
use crate::gpu::Frame;

const BACKEND: &str = "mf-hw";

/// H.264's own ceiling. The MFT may take less, which `probe` reports.
const H264_MAX_DIMENSION: u32 = 4096;

/// What `probe` offers the encoder, largest first. The first output type it
/// accepts is the ceiling `probe` reports — AMD's stops at 4096 on both axes,
/// which is why both are asked.
const PROBE_SIZES: [(u32, u32); 5] = [
    (4096, 4096),
    (4096, 2304),
    (3840, 2160),
    (2560, 1440),
    (1920, 1080),
];

/// NV12 textures in flight. A slot is written only once the input that used
/// it last has come out, so this bounds how far the encoder may run behind.
const RING: usize = 4;

/// How long `encode` waits for the encoder to ask for input. Reached only if
/// the GPU has stopped answering, and then a failed session beats a hung
/// capture thread.
const WAIT: Duration = Duration::from_secs(2);

/// Viewers the session admits on this rung. H.264 is one codec class, so every
/// viewer shares one encoder; this is the bundle's default viewer cap rather
/// than a session count, which nothing on Media Foundation reports.
const BUDGET: u32 = 4;

fn hardware() -> i32 {
    MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0
}

/// Unlock an asynchronous MFT. One that is not asynchronous is refused: every
/// hardware encoder MFT is, by Media Foundation's own rule, and this module
/// only drives that shape.
fn unlock(transform: &IMFTransform) -> Result<(), MfError> {
    // SAFETY: attribute reads and one write on the transform's own store.
    unsafe {
        let attributes = transform.GetAttributes().map_err(api("GetAttributes"))?;
        if attributes.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) == 0 {
            return Err(MfError::NoEncoder(BACKEND));
        }
        attributes
            .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
            .map_err(api("MF_TRANSFORM_ASYNC_UNLOCK"))
    }
}

// ------------------------------------------------------------------ probe ---

/// What this machine's first hardware H.264 MFT can do.
///
/// Enumerating is cheap; the one activation is not free, so only the first
/// encoder is opened, and only to ask it which output sizes it takes.
/// `max_fps` stays 0: it is a measured figure and measuring means encoding,
/// which `probe` never does. Nothing selects on it.
pub fn probe() -> BackendCaps {
    let mut caps = BackendCaps {
        backend: BACKEND,
        codecs: Vec::new(),
        accepts_bgra_texture: false,
        max_fps: 0,
        concurrent_sessions: 0,
    };
    let Ok(mf) = mfplat() else {
        return caps;
    };
    let _apartment = Apartment::enter();
    let Ok(found) = mf.encoders(hardware(), None) else {
        return caps;
    };
    if let Some(activate) = found.first() {
        if let Some((max_width, max_height)) = largest(mf, activate) {
            caps.codecs.push(CodecCaps {
                codec: Codec::H264,
                max_width,
                max_height,
            });
            caps.concurrent_sessions = BUDGET;
        }
    }
    caps
}

/// The largest of [`PROBE_SIZES`] the encoder takes an output type at.
///
/// Only as good as the encoder's own check: NVIDIA's MFT takes a test-only
/// 8192x8192 H.264 type it could not encode (measured), so on it this answers
/// H.264's own 4096. What it always proves is that the encoder activates and
/// unlocks. Whether AMD's and Intel's refuse what they cannot do is unmeasured.
fn largest(mf: &Mfplat, activate: &IMFActivate) -> Option<(u32, u32)> {
    // SAFETY: the activation is shut down below whatever the answer.
    let transform: IMFTransform = unsafe { activate.ActivateObject() }.ok()?;
    let answer = unlock(&transform).ok().and_then(|()| {
        PROBE_SIZES.into_iter().find(|&(width, height)| {
            let Ok(output) = video_type(mf, &MFVideoFormat_H264, width, height, 60) else {
                return false;
            };
            // SAFETY: attribute writes on a type owned here, then a test-only
            // set that changes nothing.
            unsafe {
                output.SetUINT32(&MF_MT_AVG_BITRATE, 20_000_000).is_ok()
                    && output
                        .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                        .is_ok()
                    && transform
                        .SetOutputType(0, &output, MFT_SET_TYPE_TEST_ONLY.0 as u32)
                        .is_ok()
            }
        })
    });
    // SAFETY: releases the encoder this function activated.
    let _ = unsafe { activate.ShutdownObject() };
    answer
}

// ----------------------------------------------------------------- encode ---

/// Open an `mf-hw` encoder for `cfg`.
///
/// The MFT itself opens on the first frame, on that frame's own device — the
/// DXGI device manager needs it, exactly as NVENC's session does. What is
/// checked here is what can be without one: the codec, the size, and that the
/// machine has a hardware encoder at all, so the selector walks on now rather
/// than at the first frame.
pub fn create(cfg: &EncoderConfig) -> anyhow::Result<Box<dyn Encoder>> {
    Ok(Box::new(HwEncoder::new(cfg)?))
}

impl HwEncoder {
    fn new(cfg: &EncoderConfig) -> Result<Self, MfError> {
        super::admit(cfg, H264_MAX_DIMENSION, H264_MAX_DIMENSION)?;
        let mf = mfplat()?;
        let apartment = Apartment::enter();
        if mf.encoders(hardware(), None)?.is_empty() {
            return Err(MfError::NoEncoder(BACKEND));
        }
        Ok(Self {
            cfg: cfg.clone(),
            shared: Arc::new(Shared::default()),
            session: None,
            frame_id: 0,
            _apartment: apartment,
        })
    }
}

struct HwEncoder {
    cfg: EncoderConfig,
    shared: Arc<Shared>,
    session: Option<Session>,
    frame_id: u64,
    /// Last, so it drops after the session it holds COM for.
    _apartment: Apartment,
}

// SAFETY: the transform, its codec api and the device are free-threaded COM
// objects (an asynchronous MFT is by contract), and the encoder is used from
// one thread at a time — the capture thread makes it, owns it and drops it,
// which is also what keeps its apartment balanced.
unsafe impl Send for HwEncoder {}

impl Encoder for HwEncoder {
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
        let raw = frame.handle as *mut c_void;
        let texture = texture_of(&raw)?;
        // SAFETY: the device that owns the borrowed texture.
        let device = unsafe { texture.GetDevice() }.map_err(api("GetDevice"))?;
        let session = match &mut self.session {
            Some(session) if session.device.as_raw() != device.as_raw() => {
                return Err(MfError::DeviceChanged.into())
            }
            Some(session) => session,
            None => {
                self.session
                    .insert(Session::open(device, &self.cfg, Arc::clone(&self.shared))?)
            }
        };
        session.submit(frame, force_irap, self.frame_id, &self.shared)?;
        self.frame_id += 1;

        let mut state = self.shared.lock();
        if state.sink.is_some() {
            return Ok(None);
        }
        // no sink: answer what has finished, waiting only until the encoder
        // has either produced something or asked for more
        let deadline = Instant::now() + WAIT;
        while state.ready.is_empty() && state.credits == 0 && state.failed.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            state = self.shared.wait(state, left);
        }
        Ok(state.ready.pop_front())
    }

    fn set_sink(&mut self, sink: Sink) {
        self.shared.lock().sink = Some(sink);
    }

    fn set_bitrate(&mut self, bitrate_bps: u32) -> anyhow::Result<()> {
        self.cfg.bitrate_bps = bitrate_bps;
        if let Some(session) = &self.session {
            retarget(&session.codec, bitrate_bps, self.cfg.fps)?;
        }
        Ok(())
    }
}

/// One submitted input, until its output names it.
struct Pending {
    time: i64,
    frame_id: u64,
    captured_qpc: i64,
}

#[derive(Default)]
struct State {
    /// `METransformNeedInput` events not yet answered with an input.
    credits: u32,
    /// Submitted inputs, oldest first. Outputs come back in this order — no
    /// B-frames — so an output older than the front cannot happen, and an
    /// input the encoder dropped is passed over by the next output.
    pending: VecDeque<Pending>,
    /// Finished frames, when no sink is set.
    ready: VecDeque<EncodedFrame>,
    sink: Option<Sink>,
    /// The sink refused a frame: the next input is forced to an IDR so the
    /// hole cannot dangle.
    refused: bool,
    failed: Option<String>,
    /// The pump thread has returned.
    pump_done: bool,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // a poisoned lock means the pump panicked holding it; the state is
        // still the best answer there is
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wait<'a>(&self, state: MutexGuard<'a, State>, timeout: Duration) -> MutexGuard<'a, State> {
        match self.changed.wait_timeout(state, timeout) {
            Ok((state, _)) => state,
            Err(e) => e.into_inner().0,
        }
    }

    /// Whether the pump returned within `timeout`.
    fn wait_for_pump(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock();
        while !state.pump_done {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            state = self.wait(state, left);
        }
        true
    }

    fn fail(&self, why: String) {
        ::log::warn!("swoop: {BACKEND}: {why}");
        self.lock().failed = Some(why);
        self.changed.notify_all();
    }
}

struct Session {
    device: ID3D11Device,
    activate: IMFActivate,
    transform: IMFTransform,
    codec: ICodecAPI,
    /// The NV12 converters, one per in-flight slot, opened as they are first
    /// used. Each owns its output texture.
    ring: Vec<Downscaler>,
    next: usize,
    fps: u32,
    shared: Arc<Shared>,
    pump: Option<JoinHandle<()>>,
}

impl Session {
    fn open(
        device: ID3D11Device,
        cfg: &EncoderConfig,
        shared: Arc<Shared>,
    ) -> Result<Self, MfError> {
        let mf = mfplat()?;
        // the encoder calls into this device from its own threads
        // SAFETY: plain calls on a live device and its immediate context.
        unsafe {
            let context = device
                .GetImmediateContext()
                .map_err(api("GetImmediateContext"))?;
            let multithread: ID3D11Multithread = context
                .cast()
                .map_err(api("QueryInterface(ID3D11Multithread)"))?;
            let _ = multithread.SetMultithreadProtected(true);
        }

        let activate = for_adapter(mf, &device)?;
        // SAFETY: the activation lives in the session and is shut down in Drop.
        let transform: IMFTransform =
            unsafe { activate.ActivateObject() }.map_err(api("ActivateObject"))?;
        let session = match Self::start(mf, device, activate.clone(), transform, cfg, shared) {
            Ok(session) => session,
            Err(e) => {
                // no session owns the activation yet, so it is released here
                // SAFETY: the encoder this call activated, shut down once.
                let _ = unsafe { activate.ShutdownObject() };
                return Err(e);
            }
        };
        // SAFETY: plain messages on the configured transform. From here a
        // failure drops `session`, whose Drop stops the pump and releases the
        // activation.
        unsafe {
            session
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(api("MFT_MESSAGE_NOTIFY_BEGIN_STREAMING"))?;
            session
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(api("MFT_MESSAGE_NOTIFY_START_OF_STREAM"))?;
        }
        Ok(session)
    }

    fn start(
        mf: &Mfplat,
        device: ID3D11Device,
        activate: IMFActivate,
        transform: IMFTransform,
        cfg: &EncoderConfig,
        shared: Arc<Shared>,
    ) -> Result<Self, MfError> {
        unlock(&transform)?;
        let (manager, token) = mf.device_manager()?;
        // SAFETY: the manager and the device are alive for every call, and the
        // transform takes its own reference to the manager.
        unsafe {
            manager
                .ResetDevice(&device, token)
                .map_err(api("IMFDXGIDeviceManager::ResetDevice"))?;
            transform
                .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)
                .map_err(api("MFT_MESSAGE_SET_D3D_MANAGER"))?;
        }
        let codec: ICodecAPI = transform.cast().map_err(api("QueryInterface(ICodecAPI)"))?;
        configure(&codec, cfg, cfg.fps, BACKEND, Vec::new());
        set_types(
            mf,
            &transform,
            cfg.width,
            cfg.height,
            cfg.fps,
            cfg.bitrate_bps,
            eAVEncH264VProfile_High.0,
        )?;

        // SAFETY: plain queries on the configured transform.
        let info =
            unsafe { transform.GetOutputStreamInfo(0) }.map_err(api("GetOutputStreamInfo"))?;
        let allocate = (info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0)
            .then(|| info.cbSize.max(cfg.width * cfg.height * 3 / 2));
        let events: IMFMediaEventGenerator = transform
            .cast()
            .map_err(api("QueryInterface(IMFMediaEventGenerator)"))?;
        let pump = Pump {
            transform: transform.clone(),
            events,
            allocate,
            header: sequence_header(&transform),
            width: cfg.width,
            height: cfg.height,
        };
        let pumped = Arc::clone(&shared);
        let handle = std::thread::Builder::new()
            .name("swoop-mf-pump".into())
            .spawn(move || {
                // entered first so it drops last, after the pump's interfaces
                let _apartment = Apartment::enter();
                pump.run(&pumped);
                pumped.lock().pump_done = true;
                pumped.changed.notify_all();
            })
            .map_err(MfError::Thread)?;

        Ok(Self {
            device,
            activate,
            transform,
            codec,
            ring: Vec::with_capacity(RING),
            next: 0,
            fps: cfg.fps,
            shared,
            pump: Some(handle),
        })
    }

    /// Convert `frame` into the next ring slot and hand it to the encoder once
    /// it has asked for input.
    fn submit(
        &mut self,
        frame: &Frame,
        force_irap: bool,
        frame_id: u64,
        shared: &Shared,
    ) -> Result<(), MfError> {
        let mf = mfplat()?;
        let slot = self.next;
        self.next = (self.next + 1) % RING;

        let mut state = shared.lock();
        // the slot's last input must have come out before it is overwritten,
        // which at most RING - 1 inputs in flight guarantees
        let deadline = Instant::now() + WAIT;
        while state.failed.is_none() && (state.credits == 0 || state.pending.len() >= RING) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(MfError::Stalled(format!(
                    "no request for input in {WAIT:?} ({} in flight)",
                    state.pending.len()
                )));
            }
            state = shared.wait(state, left);
        }
        if let Some(why) = &state.failed {
            return Err(MfError::Stalled(why.clone()));
        }
        let force = force_irap || std::mem::take(&mut state.refused);
        drop(state);

        if self.ring.len() <= slot {
            self.ring
                .push(Downscaler::open_nv12(frame, frame.width, frame.height)?);
        }
        let nv12 = self.ring[slot].scale(frame)?;
        let raw = nv12.handle as *mut c_void;
        let buffer = mf.surface_buffer(texture_of(&raw)?)?;
        let sample = mf.sample()?;
        let time = sample_time(frame_id, self.fps);
        // SAFETY: plain calls on objects owned here; the sample takes its own
        // reference to the buffer and the transform to the sample.
        unsafe {
            let length = buffer
                .cast::<IMF2DBuffer>()
                .and_then(|planar| planar.GetContiguousLength())
                .map_err(api("IMF2DBuffer::GetContiguousLength"))?;
            buffer
                .SetCurrentLength(length)
                .map_err(api("SetCurrentLength"))?;
            sample.AddBuffer(&buffer).map_err(api("AddBuffer"))?;
            sample.SetSampleTime(time).map_err(api("SetSampleTime"))?;
            sample
                .SetSampleDuration(sample_time(1, self.fps))
                .map_err(api("SetSampleDuration"))?;
        }
        if force {
            force_keyframe(&self.codec)?;
        }

        let mut state = shared.lock();
        state.credits -= 1;
        state.pending.push_back(Pending {
            time,
            frame_id,
            captured_qpc: frame.captured_qpc,
        });
        drop(state);
        // SAFETY: the sample is alive for the call and the encoder asked for it.
        let submitted = unsafe { self.transform.ProcessInput(0, &sample, 0) };
        if let Err(e) = submitted {
            shared.lock().pending.retain(|p| p.frame_id != frame_id);
            return Err(MfError::Api {
                call: "ProcessInput",
                source: e,
            });
        }
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // SAFETY: the transform belongs to this session. Shutting it down ends
        // its event queue, which is what wakes the pump out of GetEvent.
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            if let Ok(shutdown) = self.transform.cast::<IMFShutdown>() {
                let _ = shutdown.Shutdown();
            }
        }
        if let Some(pump) = self.pump.take() {
            // bounded, as every wait here is: a pump the encoder never wakes is
            // left to end with the process rather than hang the capture thread
            if self.shared.wait_for_pump(WAIT) {
                let _ = pump.join();
            } else {
                ::log::warn!(
                    "swoop: {BACKEND}: the event pump did not stop in {WAIT:?}; left running"
                );
            }
        }
        // SAFETY: the activation this session owns, released once.
        let _ = unsafe { self.activate.ShutdownObject() };
    }
}

/// The hardware encoder for `device`'s adapter, best first.
fn for_adapter(mf: &Mfplat, device: &ID3D11Device) -> Result<IMFActivate, MfError> {
    // SAFETY: plain queries on a live device.
    let luid = unsafe {
        let dxgi: IDXGIDevice = device.cast().map_err(api("QueryInterface(IDXGIDevice)"))?;
        let adapter = dxgi.GetAdapter().map_err(api("IDXGIDevice::GetAdapter"))?;
        adapter
            .GetDesc()
            .map_err(api("IDXGIAdapter::GetDesc"))?
            .AdapterLuid
    };
    let attributes = mf.attributes()?;
    let packed = (u64::from(luid.HighPart as u32) << 32) | u64::from(luid.LowPart);
    // SAFETY: one attribute write on a store owned here.
    unsafe { attributes.SetUINT64(&MFT_ENUM_ADAPTER_LUID, packed) }
        .map_err(api("MFT_ENUM_ADAPTER_LUID"))?;
    mf.encoders(hardware(), Some(&attributes))?
        .into_iter()
        .next()
        .ok_or(MfError::NoEncoder(BACKEND))
}

/// The pump thread's half: the event queue and what it takes to turn an
/// output into an [`EncodedFrame`].
struct Pump {
    transform: IMFTransform,
    events: IMFMediaEventGenerator,
    allocate: Option<u32>,
    header: Vec<u8>,
    width: u32,
    height: u32,
}

// SAFETY: moved to the pump thread once and used only there. The transform it
// shares with the session is an asynchronous MFT, free-threaded by contract.
unsafe impl Send for Pump {}

impl Pump {
    fn run(mut self, shared: &Shared) {
        loop {
            // SAFETY: a blocking wait on the transform's own queue, ended by
            // the session's Shutdown.
            let event = match unsafe {
                self.events
                    .GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(0))
            } {
                Ok(event) => event,
                Err(e) => {
                    if e.code() != MF_E_SHUTDOWN {
                        shared.fail(format!("the event queue failed: {e}"));
                    }
                    return;
                }
            };
            // SAFETY: plain reads of the event.
            let kind = MF_EVENT_TYPE(unsafe { event.GetType() }.unwrap_or(0) as i32);
            if kind == METransformNeedInput {
                shared.lock().credits += 1;
                shared.changed.notify_all();
            } else if kind == METransformHaveOutput {
                if let Err(e) = self.output(shared) {
                    shared.fail(format!("an output failed: {e}"));
                }
            } else if kind == MEError {
                let status = unsafe { event.GetStatus() }.unwrap_or_default();
                shared.fail(format!("the encoder reported {status:?}"));
            }
        }
    }

    fn output(&mut self, shared: &Shared) -> Result<(), MfError> {
        let mf = mfplat()?;
        let Some(sample) =
            process_output(mf, &self.transform, self.allocate).map_err(api("ProcessOutput"))?
        else {
            // the output type changed, and its parameter sets with it
            self.header = sequence_header(&self.transform);
            return Ok(());
        };
        let (data, time) = read_sample(&sample)?;
        let (data, is_irap) = assemble(&data, &self.header);
        let encoded_qpc = qpc_now();

        let mut state = shared.lock();
        while state.pending.front().is_some_and(|p| p.time < time) {
            state.pending.pop_front();
        }
        let Some(input) = state.pending.pop_front() else {
            return Ok(());
        };
        let frame = EncodedFrame {
            data,
            is_irap,
            codec: Codec::H264,
            width: self.width,
            height: self.height,
            frame_id: input.frame_id,
            captured_qpc: input.captured_qpc,
            encoded_qpc,
        };
        match &state.sink {
            Some(sink) => {
                if !sink(frame) {
                    state.refused = true;
                }
            }
            None => state.ready.push_back(frame),
        }
        drop(state);
        shared.changed.notify_all();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::mpsc;

    use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

    use super::*;
    use crate::encode::h264_sps::nal_units;
    use crate::encode::mf::testkit::{device, frames, keep, ltr, percentile, read_unit};

    fn cfg() -> EncoderConfig {
        EncoderConfig {
            codec: Codec::H264,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_bps: 20_000_000,
        }
    }

    /// What a paced run through the sink saw.
    struct Run {
        /// Submit to sink, per frame, in frame order.
        latency: Vec<(u64, Duration)>,
        units: Vec<(u64, EncodedFrame)>,
        max_in_flight: usize,
    }

    /// Feed `count` frames at `cfg.fps`, as capture would, forcing an IDR at
    /// each of `force` and moving the bitrate at `retarget`.
    fn drive(
        encoder: &mut HwEncoder,
        textures: &[ID3D11Texture2D],
        count: u64,
        force: &[u64],
        retarget: Option<(u64, u32)>,
    ) -> Run {
        let (tx, rx) = mpsc::channel::<(EncodedFrame, Instant)>();
        let tx = Mutex::new(tx);
        encoder.set_sink(Box::new(move |frame| {
            tx.lock().unwrap().send((frame, Instant::now())).is_ok()
        }));
        let interval = Duration::from_secs_f64(1.0 / f64::from(encoder.cfg.fps));
        let mut submitted = HashMap::new();
        let mut max_in_flight = 0;
        let start = Instant::now();
        for i in 0..count {
            let due = start + interval * i as u32;
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            if retarget.is_some_and(|(at, _)| at == i) {
                encoder
                    .set_bitrate(retarget.unwrap().1)
                    .expect("the rate moves");
            }
            let texture = &textures[i as usize % textures.len()];
            let frame = Frame {
                handle: texture.as_raw() as usize,
                width: encoder.cfg.width,
                height: encoder.cfg.height,
                captured_qpc: qpc_now(),
            };
            submitted.insert(i, Instant::now());
            let answered = encoder
                .encode(&frame, force.contains(&i))
                .expect("the frame is taken");
            assert!(
                answered.is_none(),
                "with a sink nothing is answered from encode"
            );
            max_in_flight = max_in_flight.max(encoder.shared.lock().pending.len());
        }
        let mut units = Vec::new();
        let mut latency = Vec::new();
        while let Ok((frame, at)) = rx.recv_timeout(Duration::from_secs(2)) {
            latency.push((frame.frame_id, at - submitted[&frame.frame_id]));
            units.push((frame.frame_id, frame));
            if units.len() as u64 == count {
                break;
            }
        }
        Run {
            latency,
            units,
            max_in_flight,
        }
    }

    /// Needs a hardware encoder MFT. Prints how long it took and what it found.
    #[test]
    #[ignore = "needs a gpu with a hardware h.264 encoder mft"]
    fn mf_hw_probe_answers_quickly_with_h264_and_a_ceiling() {
        let started = Instant::now();
        let caps = probe();
        let took = started.elapsed();
        println!("mf-hw probe in {took:?}: {caps:?}");
        assert_eq!(caps.backend, "mf-hw");
        assert!(!caps.accepts_bgra_texture);
        assert_eq!(caps.codecs.len(), 1, "h.264 and nothing else");
        assert_eq!(caps.codecs[0].codec, Codec::H264);
        assert!(caps.codecs[0].max_width >= 1920 && caps.codecs[0].max_height >= 1080);
        assert!(took < Duration::from_secs(2), "probe must stay fast");
    }

    /// Needs a hardware encoder MFT: `cargo test --lib -- --ignored mf_hw`.
    /// Set `MF_ANNEXB_DIR` to keep the bitstream for the Chrome decode check.
    #[test]
    #[ignore = "needs a gpu with a hardware h.264 encoder mft"]
    fn mf_hw_encodes_1080p60_with_what_chrome_needs() {
        let device = device();
        let textures = frames(&device, 1920, 1080, 8);
        let mut encoder = HwEncoder::new(&cfg()).expect("the encoder opens");
        let run = drive(
            &mut encoder,
            &textures,
            600,
            &[300],
            Some((450, 10_000_000)),
        );
        assert_eq!(run.units.len(), 600, "every frame came out");

        let header = sequence_header(&encoder.session.as_ref().expect("a session").transform);
        let own_sps = nal_units(&header)
            .into_iter()
            .find(|(ty, _)| *ty == crate::encode::h264_sps::NAL_SPS)
            .map(|(_, range)| header[range].to_vec());
        println!(
            "  the encoder's own sps: {}",
            own_sps.as_deref().map(hex::encode).unwrap_or_default()
        );

        let iraps: Vec<u64> = run
            .units
            .iter()
            .filter(|(_, f)| f.is_irap)
            .map(|(id, _)| *id)
            .collect();
        let mut max_slices = 0;
        let mut wire_sps = None;
        for (_, frame) in &run.units {
            let (slices, sps) = read_unit(&frame.data);
            max_slices = max_slices.max(slices);
            if wire_sps.is_none() {
                wire_sps = sps;
            }
        }
        let (sps_bytes, sps) = wire_sps.expect("the first access unit carries an sps");
        let steady: Vec<Duration> = run
            .latency
            .iter()
            .filter(|(id, _)| *id > 0 && *id != 300)
            .map(|(_, d)| *d)
            .collect();
        let forced = run
            .latency
            .iter()
            .find(|(id, _)| *id == 300)
            .map(|(_, d)| *d)
            .expect("the forced frame");
        let size = |id: u64| {
            run.units
                .iter()
                .find(|(i, _)| *i == id)
                .map_or(0, |(_, f)| f.data.len())
        };
        let deltas = run
            .units
            .iter()
            .filter(|(id, f)| !f.is_irap && *id < 300)
            .map(|(_, f)| f.data.len())
            .sum::<usize>()
            / 299;
        println!(
            "mf-hw 1080p60: submit-to-sink p50 {:.2} ms p95 {:.2} ms; forced idr {:.2} ms; iraps at {iraps:?}; keyframe {} B, forced {} B, mean delta {deltas} B; max {max_slices} slice; max {} in flight",
            percentile(&steady, 0.5),
            percentile(&steady, 0.95),
            forced.as_secs_f64() * 1e3,
            size(0),
            size(300),
            run.max_in_flight,
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
            "mf-hw-1080p60.h264",
            &run.units
                .iter()
                .take(300)
                .map(|(_, f)| f.data.clone())
                .collect::<Vec<_>>(),
        );

        assert_eq!(
            iraps,
            vec![0, 300],
            "the first frame and the forced one, and the rate move costs none"
        );
        assert_eq!(max_slices, 1, "every access unit is a single slice");
        assert!(sps.declares_no_reordering());
        assert!(run.max_in_flight <= RING);
    }

    /// Needs a hardware encoder MFT that does 4K. The chain only hands
    /// `mf-hw` a 4K desktop when NVENC is absent, which here it never is.
    #[test]
    #[ignore = "needs a gpu with a hardware h.264 encoder mft"]
    fn mf_hw_encodes_4k60() {
        let device = device();
        let textures = frames(&device, 3840, 2160, 8);
        let cfg = EncoderConfig {
            width: 3840,
            height: 2160,
            bitrate_bps: 40_000_000,
            ..cfg()
        };
        let mut encoder = HwEncoder::new(&cfg).expect("the encoder opens");
        let run = drive(&mut encoder, &textures, 300, &[150], None);
        assert_eq!(run.units.len(), 300, "every frame came out");
        let steady: Vec<Duration> = run
            .latency
            .iter()
            .filter(|(id, _)| *id > 0 && *id != 150)
            .map(|(_, d)| *d)
            .collect();
        let forced = run
            .latency
            .iter()
            .find(|(id, _)| *id == 150)
            .map(|(_, d)| *d);
        println!(
            "mf-hw 4k60 at 40 mbps: submit-to-sink p50 {:.2} ms p95 {:.2} ms; forced idr {:.2} ms; max {} in flight",
            percentile(&steady, 0.5),
            percentile(&steady, 0.95),
            forced.map_or(f64::NAN, |d| d.as_secs_f64() * 1e3),
            run.max_in_flight,
        );
        assert!(run.max_in_flight <= RING);
    }

    /// Needs a hardware encoder MFT. Prints, for the spike memo only.
    #[test]
    #[ignore = "needs a gpu with a hardware h.264 encoder mft"]
    fn mf_hw_ltr_advertisement() {
        let mf = mfplat().expect("media foundation");
        let _apartment = Apartment::enter();
        let found = mf.encoders(hardware(), None).expect("an enumeration");
        let activate = found.first().expect("a hardware h.264 mft");
        // SAFETY: activated, queried and shut down here.
        let transform: IMFTransform = unsafe { activate.ActivateObject() }.expect("activates");
        unlock(&transform).expect("unlocks");
        let codec: ICodecAPI = transform.cast().expect("a codec api");
        println!("mf-hw ltr: {}", ltr(&codec));
        drop((codec, transform));
        let _ = unsafe { activate.ShutdownObject() };
    }

    /// Needs a hardware encoder MFT; a minute long.
    #[test]
    #[ignore = "needs a gpu with a hardware h.264 encoder mft"]
    fn mf_hw_holds_its_bitrate_for_a_minute() {
        let device = device();
        let textures = frames(&device, 1920, 1080, 8);
        let mut encoder = HwEncoder::new(&cfg()).expect("the encoder opens");
        let count = 60 * 60;
        let run = drive(&mut encoder, &textures, count, &[], None);
        assert_eq!(run.units.len() as u64, count, "every frame came out");
        // seconds 5 to 60: the first keyframe and the rate controller settling
        // are not what is being held
        let bits: usize = run
            .units
            .iter()
            .filter(|(id, _)| *id >= 300)
            .map(|(_, f)| f.data.len() * 8)
            .sum();
        let seconds = (count - 300) as f64 / 60.0;
        let rate = bits as f64 / seconds;
        let ratio = rate / f64::from(cfg().bitrate_bps);
        let window = |from: u64, to: u64| -> Vec<Duration> {
            run.latency
                .iter()
                .filter(|(id, _)| (from..to).contains(id))
                .map(|(_, d)| *d)
                .collect()
        };
        let (first, last) = (window(60, 660), window(count - 600, count));
        println!(
            "mf-hw 60 s at 1080p60, 20 mbps: {:.2} mbps ({:+.1} %); latency p50/p95 first 10 s {:.2}/{:.2} ms, last 10 s {:.2}/{:.2} ms; max {} in flight",
            rate / 1e6,
            (ratio - 1.0) * 100.0,
            percentile(&first, 0.5),
            percentile(&first, 0.95),
            percentile(&last, 0.5),
            percentile(&last, 0.95),
            run.max_in_flight,
        );
        assert!((0.9..=1.1).contains(&ratio), "the rate held within 10 %");
        assert!(run.max_in_flight <= RING, "no queue growth");
        assert!(
            percentile(&last, 0.95) < percentile(&first, 0.95) + 5.0,
            "no queue growth"
        );
    }
}
