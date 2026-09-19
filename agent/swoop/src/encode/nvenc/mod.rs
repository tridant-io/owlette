//! NVENC, the first-class encoder backend. Task 3.7 fills it.
//!
//! Exposes `probe() -> BackendCaps` and `create(&EncoderConfig) ->
//! Result<Box<dyn Encoder>>` and nothing else. nvEncodeAPI64.dll is loaded by
//! absolute path at runtime, so a machine with no NVIDIA driver fails `probe()`
//! instead of failing to start.
//!
//! # The configuration
//!
//! Every setting below was validated on real hardware by spike 0.9 (RTX 2080
//! Ti, driver 591.86, NVENC header 12.1, Chrome 153) — see
//! `dev/active/swoop/spikes/0.9-nvenc-config.md`. The five that are easy to get
//! wrong:
//!
//! * `h264VUIParameters.bitstreamRestrictionFlag = 1` is **mandatory**. Without
//!   it a decoder must assume the largest DPB the SPS level permits, so it
//!   holds output for up to 16 frames — measured 67.2 ms p50 at level 4.2 and
//!   267.2 ms at level 5.1, both falling to ~0.5 ms with the flag on. The
//!   penalty is the level's DPB, not a constant, so it gets *worse* at 4K.
//!   `VideoDecoderConfig.optimizeForLatency` is not a substitute: identical
//!   within 0.5 ms in every arm.
//! * `max_dec_frame_buffering = 0` is not achievable and is not asserted: NVENC
//!   has no field for it and emits `maxNumRefFrames` (4). Only
//!   `max_num_reorder_frames = 0` removes the decoder's output delay.
//! * `multiPass = TWO_PASS_QUARTER_RESOLUTION` costs a consistent 1.7 ms p50
//!   and is kept anyway: single-pass CBR with a one-frame VBV undershoots the
//!   target by 30 % (13.9 of 20 Mbps), which the rate governor would read as
//!   headroom that is not there.
//! * `enableEncodeAsync = 1` is a threading property, not a latency one (async
//!   8.43/8.46/8.25 ms vs sync 8.33/8.29/8.33 ms, n=600 each). It is kept so
//!   the encode thread waits on a handle instead of blocking inside the API.
//! * `lowDelayKeyFrameScale = KEYFRAME_VBV_SCALE`, **not** the 1 the spike
//!   recommended, which is the one setting here that shipped wrong. The
//!   one-frame VBV is a *delta-frame* decision and it stays one frame; at scale
//!   1 it capped the IDR too, so at 20 Mbps a 1080p keyframe got the same 41 KB
//!   a P frame gets, came back crushed, and — a desktop being mostly still —
//!   nothing ever redrew the regions that carried it. Measured on the spike 0.9
//!   box at 1080p on screen-like content, scale 1 → 4: the session's first
//!   keyframe 40.9 KB → 312.3 KB (H.264) and 40.5 KB → 285.1 KB (HEVC), a
//!   recovery keyframe 41.1 KB → 234.7 KB and 40.0 KB → 205.4 KB. The deltas
//!   pay 1.6–3.3 % of their bits for it and the keyframe pays +1.1 ms (H.264) /
//!   +0.2 ms (HEVC) of its own encode; the delta p50 does not move, and neither
//!   does the VBV, so the steady-state latency D7 bought is untouched. Two
//!   limits worth knowing: keyframes closer together than about a second are
//!   back to one frame's budget (the rate controller will not spend 1.5 Mbps on
//!   keyframes alone), and below ~6 Mbps the scale buys progressively less
//!   until, at 800 kbps, it changes nothing at all.
//!
//! Budget **8–12 ms p50** for encode (8.3 ms at 1080p60, 12.1 ms at 4K60 HEVC,
//! ±2 ms with whatever else holds the GPU) — not the 1–3 ms in
//! `research/03-windows-host-stack.md` §2.2.
//!
//! # Session lifetime
//!
//! `create` opens no session: NVENC registers D3D11 textures against the device
//! that owns them, and the device only arrives with the first `gpu::Frame`. So
//! the session is opened on the first `encode` call, from that frame's own
//! device, and every later frame is checked against it — a capture rebuild
//! (`DXGI_ERROR_ACCESS_LOST`) produces a new device, which is a new encoder,
//! not a reconfigure. Registrations are cached by texture pointer for the
//! session's lifetime, which is sound only because the pinned device keeps
//! those textures alive.
//!
//! # Hardware test
//!
//! ```text
//! cargo test -- --ignored nvenc        # working directory agent/swoop
//! ```
//!
//! Expected: two tests run and pass. On the spike 0.9 dev box (RTX 2080 Ti,
//! driver 591.86) they print
//!
//! ```text
//! nvenc probe: BackendCaps { backend: "nvenc", codecs: [CodecCaps { codec: H265, max_width: 8192,
//!   max_height: 8192 }, CodecCaps { codec: H264, max_width: 4096, max_height: 4096 }],
//!   accepts_bgra_texture: true, max_fps: 15, concurrent_sessions: 8 }
//! nvenc gpu test: 120 frames, 1 irap, max 1 vcl nal per access unit, sps avc1.64002a
//!   bitstream_restriction_flag=true max_num_reorder_frames=Some(0) max_dec_frame_buffering=Some(4)
//!   keyframe 312314 B, mean delta 36399 B at 20 mbps
//! ```
//!
//! `max_dec_frame_buffering` is 4 on purpose (see above), and `max_fps` is 15
//! because it is the rate at that codec's *largest* size (4096×4096), not at a
//! streaming size. The one IRAP is the first picture: the bitrate moves at
//! frame 60 and costs no keyframe. The keyframe line is the guard on
//! `KEYFRAME_VBV_SCALE`: at the 1 that shipped it reads `keyframe 40903 B,
//! mean delta 38204 B` and the test fails, which is the whole defect in one
//! line. On a machine with no NVIDIA driver both tests fail at `probe_device`,
//! which is the honest result — they are not skipped.

use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr;
use std::sync::OnceLock;

use moq_nvenc::safe::ENCODE_API;
use moq_nvenc::sys::nvEncodeAPI::{
    GUID, NVENCAPI_VERSION, NVENCSTATUS, NVENC_INFINITE_GOPLENGTH, NV_ENC_BUFFER_FORMAT,
    NV_ENC_BUFFER_USAGE, NV_ENC_CAPS, NV_ENC_CAPS_PARAM, NV_ENC_CAPS_PARAM_VER,
    NV_ENC_CODEC_CONFIG, NV_ENC_CODEC_H264_GUID, NV_ENC_CODEC_HEVC_GUID, NV_ENC_CONFIG,
    NV_ENC_CONFIG_VER, NV_ENC_CREATE_BITSTREAM_BUFFER, NV_ENC_CREATE_BITSTREAM_BUFFER_VER,
    NV_ENC_DEVICE_TYPE, NV_ENC_EVENT_PARAMS, NV_ENC_EVENT_PARAMS_VER,
    NV_ENC_H264_ENTROPY_CODING_MODE, NV_ENC_H264_PROFILE_HIGH_GUID, NV_ENC_HEVC_PROFILE_MAIN_GUID,
    NV_ENC_INITIALIZE_PARAMS, NV_ENC_INITIALIZE_PARAMS_VER, NV_ENC_INPUT_RESOURCE_TYPE,
    NV_ENC_LOCK_BITSTREAM, NV_ENC_LOCK_BITSTREAM_VER, NV_ENC_MAP_INPUT_RESOURCE,
    NV_ENC_MAP_INPUT_RESOURCE_VER, NV_ENC_MULTI_PASS, NV_ENC_NUM_REF_FRAMES,
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
    NV_ENC_OUTPUT_PTR, NV_ENC_PARAMS_RC_MODE, NV_ENC_PIC_FLAGS, NV_ENC_PIC_PARAMS,
    NV_ENC_PIC_PARAMS_VER, NV_ENC_PIC_STRUCT, NV_ENC_PIC_TYPE, NV_ENC_PRESET_CONFIG,
    NV_ENC_PRESET_CONFIG_VER, NV_ENC_PRESET_P1_GUID, NV_ENC_RECONFIGURE_PARAMS,
    NV_ENC_RECONFIGURE_PARAMS_VER, NV_ENC_REGISTERED_PTR, NV_ENC_REGISTER_RESOURCE,
    NV_ENC_REGISTER_RESOURCE_VER, NV_ENC_TUNING_INFO,
};
use thiserror::Error;
use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE, WAIT_OBJECT_0};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11Texture2D, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
};
use windows::Win32::System::Performance::QueryPerformanceCounter;
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use crate::encode::{BackendCaps, Codec, CodecCaps, EncodedFrame, Encoder, EncoderConfig};
use crate::gpu::Frame;
use crate::ipc::Exit;

/// The codec's own ceiling, refused before any driver call so a bad size costs
/// nothing. The driver may report less, and `probe` reports what it says.
const H264_MAX_DIMENSION: u32 = 4096;
const HEVC_MAX_DIMENSION: u32 = 8192;

/// How many input textures one session keeps registered. Desktop Duplication
/// hands back a handful of pooled surfaces, so this is never reached in steady
/// state; it is a ceiling, not a working set.
const MAX_REGISTERED_TEXTURES: usize = 8;

/// The ceiling `probe` counts sessions up to. Consumer drivers currently cap at
/// 8 and there is no capability to ask, so the only honest answer is to open
/// them and count.
const MAX_PROBE_SESSIONS: u32 = 8;

/// Wait for one picture. Reached only if the GPU has stopped answering, in
/// which case a hung encode thread is worse than a failed session.
const ENCODE_WAIT_MS: u32 = 20_000;

/// How many frames' worth of bits an IDR may spend, against the one-frame VBV
/// every other picture is held to. `lowDelayKeyFrameScale` is NVENC's field for
/// exactly this case — the SDK defines it as the ratio of I-frame to P-frame
/// bits under a single-frame VBV and CBR — so the delta pacing D7 chose is
/// untouched and only the keyframe is let out of it.
///
/// 4 because it is the largest value that behaves on **both** codecs at every
/// keyframe spacing the session's idr policy can produce. Measured: 8 alternates
/// a full keyframe with a starved one once requests come a second apart, and
/// anything from 16 up is ignored by the driver, which silently encodes as if
/// this were 1 — the defect this constant exists to fix.
const KEYFRAME_VBV_SCALE: u8 = 4;

/// DXGI's `DXGI_ERROR_INVALID_CALL`, which is how a machine that already has an
/// encode session open reports it through the D3D11 device (plan.md Task 3.7).
const DXGI_SESSION_BUSY: i32 = 0x887A_0001_u32 as i32;

/// Everything that stops this backend encoding. Every variant means the same
/// thing to the process — this machine cannot encode — so they all exit 13.
#[derive(Debug, Error)]
pub enum NvencError {
    #[error("the nvidia encode library is not present on this machine: {0}")]
    DriverMissing(String),
    #[error("{codec:?} tops out at {max}x{max} here; asked for {width}x{height}")]
    UnsupportedSize {
        codec: Codec,
        width: u32,
        height: u32,
        max: u32,
    },
    #[error("another encode session holds the encoder (0x887A0001)")]
    SessionBusy,
    #[error("{call} failed: {status:?}")]
    Api {
        call: &'static str,
        status: NVENCSTATUS,
    },
    #[error("d3d11: {0}")]
    D3d(String),
    #[error("the frame's texture belongs to another d3d11 device — the capture source was rebuilt")]
    DeviceChanged,
    #[error("frame is {got_width}x{got_height}, the encoder was opened for {want_width}x{want_height}")]
    SizeChanged {
        got_width: u32,
        got_height: u32,
        want_width: u32,
        want_height: u32,
    },
    #[error("frame carries no texture handle")]
    NoTexture,
}

impl NvencError {
    /// The process exit code this failure maps to. No encoder is no encoder,
    /// whichever call reported it.
    pub const fn exit(&self) -> Exit {
        Exit::NoEncoder
    }
}

fn check(status: NVENCSTATUS, call: &'static str) -> Result<(), NvencError> {
    if status == NVENCSTATUS::NV_ENC_SUCCESS {
        Ok(())
    } else {
        Err(NvencError::Api { call, status })
    }
}

fn from_hresult(e: &windows::core::Error) -> NvencError {
    if e.code().0 == DXGI_SESSION_BUSY {
        NvencError::SessionBusy
    } else {
        NvencError::D3d(e.to_string())
    }
}

/// Load nvEncodeAPI64.dll from System32 by absolute path, once.
///
/// `moq-nvenc`'s `ENCODE_API` is a lazy static that **panics** when the library
/// is missing, so nothing may touch it before this has succeeded. Loading it
/// here also means the name the lazy static asks for later resolves to a module
/// that is already in the process, rather than to the DLL search path.
fn ensure_driver() -> Result<(), NvencError> {
    static LIBRARY: OnceLock<Result<libloading::Library, String>> = OnceLock::new();
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let path = format!("{system_root}\\System32\\nvEncodeAPI64.dll");
    // SAFETY: loading the nvidia driver library runs its initialisers, which is
    // what every nvenc client does. The handle is kept for the process lifetime.
    let loaded = LIBRARY.get_or_init(|| unsafe {
        libloading::Library::new(&path).map_err(|e| format!("{path}: {e}"))
    });
    match loaded {
        Ok(_) => Ok(()),
        Err(e) => Err(NvencError::DriverMissing(e.clone())),
    }
}

fn codec_guid(codec: Codec) -> GUID {
    match codec {
        Codec::H264 => NV_ENC_CODEC_H264_GUID,
        Codec::H265 => NV_ENC_CODEC_HEVC_GUID,
    }
}

const fn max_dimension(codec: Codec) -> u32 {
    match codec {
        Codec::H264 => H264_MAX_DIMENSION,
        Codec::H265 => HEVC_MAX_DIMENSION,
    }
}

fn qpc_now() -> i64 {
    let mut ticks = 0i64;
    // SAFETY: writes one i64. QueryPerformanceCounter cannot fail on any
    // Windows this binary runs on, and a zero is a timestamp, not a crash.
    let _ = unsafe { QueryPerformanceCounter(&mut ticks) };
    ticks
}

// ------------------------------------------------------------------ probe ---

/// Create a D3D11 device on `adapter`, or on the default adapter when it is
/// `None`.
fn create_device(adapter: Option<&IDXGIAdapter>) -> Result<ID3D11Device, NvencError> {
    let levels = [D3D_FEATURE_LEVEL_11_0];
    let mut device: Option<ID3D11Device> = None;
    let driver_type = if adapter.is_some() {
        // d3d11 refuses a driver type alongside an explicit adapter.
        windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN
    } else {
        D3D_DRIVER_TYPE_HARDWARE
    };
    // SAFETY: every out parameter is owned here and the feature-level slice
    // outlives the call.
    unsafe {
        D3D11CreateDevice(
            adapter,
            driver_type,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
    }
    .map_err(|e| from_hresult(&e))?;
    device.ok_or_else(|| NvencError::D3d("d3d11 returned no device".to_string()))
}

/// The first adapter on this machine that actually opens an NVENC session.
///
/// Not "an NVIDIA adapter exists": a virtual display adapter can report the
/// real GPU's vendor id, device id, subsystem and VRAM (spike 0.8 §12), so the
/// only test that distinguishes them is opening a session.
fn probe_device() -> Option<ID3D11Device> {
    ensure_driver().ok()?;
    // SAFETY: the factory is a plain COM object; every call below writes only
    // into locals.
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    for index in 0.. {
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else {
            break;
        };
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
            continue;
        };
        if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            continue;
        }
        let Ok(adapter) = adapter.cast::<IDXGIAdapter>() else {
            continue;
        };
        let Ok(device) = create_device(Some(&adapter)) else {
            continue;
        };
        if let Ok(session) = open_session(&device) {
            destroy_session(session);
            return Some(device);
        }
    }
    None
}

/// Open a bare encode session. Capabilities can be queried on one before
/// `nvEncInitializeEncoder`, which is why `probe` never initialises one.
fn open_session(device: &ID3D11Device) -> Result<*mut c_void, NvencError> {
    let mut encoder: *mut c_void = ptr::null_mut();
    let mut open = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
        version: NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
        deviceType: NV_ENC_DEVICE_TYPE::NV_ENC_DEVICE_TYPE_DIRECTX,
        device: device.as_raw(),
        apiVersion: NVENCAPI_VERSION,
        ..Default::default()
    };
    // SAFETY: both arguments are owned locals and the device outlives the call.
    check(
        unsafe { (ENCODE_API.open_encode_session_ex)(&mut open, &mut encoder) },
        "nvEncOpenEncodeSessionEx",
    )?;
    Ok(encoder)
}

fn destroy_session(encoder: *mut c_void) {
    // SAFETY: `encoder` came from nvEncOpenEncodeSessionEx and is destroyed once.
    let _ = unsafe { (ENCODE_API.destroy_encoder)(encoder) };
}

fn query_cap(encoder: *mut c_void, guid: GUID, cap: NV_ENC_CAPS) -> Option<i32> {
    let mut param = NV_ENC_CAPS_PARAM {
        version: NV_ENC_CAPS_PARAM_VER,
        capsToQuery: cap,
        ..Default::default()
    };
    let mut value = 0i32;
    // SAFETY: owned locals; the session outlives the call.
    let status =
        unsafe { (ENCODE_API.get_encode_caps)(encoder, guid, &mut param, &mut value) };
    (status == NVENCSTATUS::NV_ENC_SUCCESS).then_some(value)
}

/// What NVENC can do on this machine.
///
/// A codec missing from `codecs` is not encodable here — which is the honest
/// answer on a driver that reports no HEVC, and the reason nothing downstream
/// may assume HEVC is available.
pub fn probe() -> BackendCaps {
    let mut caps = BackendCaps {
        backend: "nvenc",
        codecs: Vec::new(),
        // argb d3d11 textures go in unchanged: nvenc converts on chip, so no
        // shader and no VideoProcessor sits in front of it.
        accepts_bgra_texture: true,
        max_fps: 0,
        concurrent_sessions: 0,
    };
    let Some(device) = probe_device() else {
        return caps;
    };

    for codec in [Codec::H265, Codec::H264] {
        let Ok(session) = open_session(&device) else {
            continue;
        };
        let guid = codec_guid(codec);
        let width = query_cap(session, guid, NV_ENC_CAPS::NV_ENC_CAPS_WIDTH_MAX);
        let height = query_cap(session, guid, NV_ENC_CAPS::NV_ENC_CAPS_HEIGHT_MAX);
        // Frames per second at the largest size this codec supports, from the
        // driver's own throughput figure for this part. It is not a wall-clock
        // benchmark on purpose: probe can run while a session is streaming, and
        // a benchmark would take an encoder away from it.
        let mbs_per_frame = query_cap(session, guid, NV_ENC_CAPS::NV_ENC_CAPS_MB_NUM_MAX);
        let mbs_per_sec = query_cap(session, guid, NV_ENC_CAPS::NV_ENC_CAPS_MB_PER_SEC_MAX);
        destroy_session(session);

        let (Some(max_width), Some(max_height)) = (width, height) else {
            continue;
        };
        if max_width <= 0 || max_height <= 0 {
            continue;
        }
        if let (Some(per_frame), Some(per_sec)) = (mbs_per_frame, mbs_per_sec) {
            if per_frame > 0 && per_sec > 0 {
                caps.max_fps = caps.max_fps.max((per_sec / per_frame).unsigned_abs());
            }
        }
        caps.codecs.push(CodecCaps {
            codec,
            max_width: max_width.unsigned_abs(),
            max_height: max_height.unsigned_abs(),
        });
    }

    if !caps.codecs.is_empty() {
        caps.concurrent_sessions = count_sessions(&device);
    }
    caps
}

/// How many sessions the driver hands out, by asking for them. There is no
/// capability that reports the consumer cap.
fn count_sessions(device: &ID3D11Device) -> u32 {
    let mut open = Vec::new();
    while (open.len() as u32) < MAX_PROBE_SESSIONS {
        match open_session(device) {
            Ok(session) => open.push(session),
            Err(_) => break,
        }
    }
    let count = open.len() as u32;
    for session in open {
        destroy_session(session);
    }
    count
}

// ----------------------------------------------------------------- encode ---

/// Open an NVENC encoder for `cfg`.
///
/// The NVENC session itself is opened on the first frame, from that frame's own
/// D3D11 device — see the module comment. What is checked here is what can be
/// checked without one: that the driver exists, and that the size is inside the
/// codec's ceiling.
pub fn create(cfg: &EncoderConfig) -> anyhow::Result<Box<dyn Encoder>> {
    // the size check is first and deliberately needs no driver: it is an
    // argument error, and on a machine with no nvidia gpu the driver load
    // would otherwise mask it. the selector treats either refusal the same
    // way -- walk down to the next backend.
    let max = max_dimension(cfg.codec);
    if cfg.width > max || cfg.height > max {
        return Err(NvencError::UnsupportedSize {
            codec: cfg.codec,
            width: cfg.width,
            height: cfg.height,
            max,
        }
        .into());
    }
    ensure_driver()?;
    Ok(Box::new(NvencEncoder {
        cfg: cfg.clone(),
        session: None,
        frame_id: 0,
    }))
}

struct NvencEncoder {
    /// Owned copy: `bitrate_bps` moves under the rate governor, and the VBV is
    /// recomputed from it on every reconfigure.
    cfg: EncoderConfig,
    session: Option<Session>,
    frame_id: u64,
}

// SAFETY: the session handle, its registrations and its D3D11 device are used
// from exactly one thread at a time — the streamer moves the encoder onto the
// encode thread and keeps it there. Nothing inside is shared, which is why this
// is Send and not Sync.
unsafe impl Send for NvencEncoder {}

impl Encoder for NvencEncoder {
    fn encode(&mut self, frame: &Frame, force_irap: bool) -> anyhow::Result<Option<EncodedFrame>> {
        if (frame.width, frame.height) != (self.cfg.width, self.cfg.height) {
            return Err(NvencError::SizeChanged {
                got_width: frame.width,
                got_height: frame.height,
                want_width: self.cfg.width,
                want_height: self.cfg.height,
            }
            .into());
        }
        let raw = frame.handle as *mut c_void;
        // SAFETY: borrowed, not owned — the capture source holds the reference
        // and `Frame` does not transfer it.
        let texture = unsafe { ID3D11Texture2D::from_raw_borrowed(&raw) }
            .ok_or(NvencError::NoTexture)?;
        let device = unsafe { texture.GetDevice() }.map_err(|e| from_hresult(&e))?;

        let session = match &mut self.session {
            Some(session) => {
                if session.device.as_raw() != device.as_raw() {
                    return Err(NvencError::DeviceChanged.into());
                }
                session
            }
            None => self.session.insert(Session::open(device, &self.cfg)?),
        };

        let encoded = session.encode(texture, raw as usize, force_irap)?;
        let frame_id = self.frame_id;
        self.frame_id += 1;
        // With enablePTD, no B-frames and no lookahead every submitted picture
        // produces output, so this is always Some — the Option is the trait's,
        // for backends that pipeline.
        Ok(Some(EncodedFrame {
            data: encoded.data,
            is_irap: encoded.is_irap,
            codec: self.cfg.codec,
            width: self.cfg.width,
            height: self.cfg.height,
            frame_id,
            captured_qpc: frame.captured_qpc,
            encoded_qpc: qpc_now(),
        }))
    }

    fn set_bitrate(&mut self, bitrate_bps: u32) -> anyhow::Result<()> {
        self.cfg.bitrate_bps = bitrate_bps;
        if let Some(session) = &mut self.session {
            session.reconfigure(&self.cfg)?;
        }
        Ok(())
    }
}

/// One encoded picture, before it is dressed as an `EncodedFrame`.
struct Encoded {
    data: Vec<u8>,
    is_irap: bool,
}

struct Session {
    encoder: *mut c_void,
    device: ID3D11Device,
    event: HANDLE,
    bitstream: NV_ENC_OUTPUT_PTR,
    /// Texture pointer -> registration. Sound because `device` pins the
    /// textures: an address cannot be reused while its texture is alive.
    registered: HashMap<usize, NV_ENC_REGISTERED_PTR>,
    /// Boxed so `init.encodeConfig` stays valid for the session's whole life:
    /// `NvEncReconfigureEncoder` reads through that same pointer again.
    config: Box<NV_ENC_CONFIG>,
    init: NV_ENC_INITIALIZE_PARAMS,
    width: u32,
    height: u32,
}

impl Session {
    fn open(device: ID3D11Device, cfg: &EncoderConfig) -> Result<Self, NvencError> {
        let guid = codec_guid(cfg.codec);
        let encoder = open_session(&device)?;
        // Anything after this point that fails must not leak the session.
        let session = Self::init(device, encoder, guid, cfg);
        if session.is_err() {
            destroy_session(encoder);
        }
        session
    }

    fn init(
        device: ID3D11Device,
        encoder: *mut c_void,
        guid: GUID,
        cfg: &EncoderConfig,
    ) -> Result<Self, NvencError> {
        // Start from the preset's own configuration: a preset plus tuning info
        // auto-configures everything we do not name, which is the SDK's
        // intended usage (programming guide §3.3).
        let mut preset = NV_ENC_PRESET_CONFIG {
            version: NV_ENC_PRESET_CONFIG_VER,
            presetCfg: NV_ENC_CONFIG {
                version: NV_ENC_CONFIG_VER,
                ..Default::default()
            },
            ..Default::default()
        };
        // SAFETY: owned locals; the session outlives the call.
        check(
            unsafe {
                (ENCODE_API.get_encode_preset_config_ex)(
                    encoder,
                    guid,
                    NV_ENC_PRESET_P1_GUID,
                    NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
                    &mut preset,
                )
            },
            "nvEncGetEncodePresetConfigEx",
        )?;

        let mut config = Box::new(preset.presetCfg);
        config.version = NV_ENC_CONFIG_VER;
        config.profileGUID = match cfg.codec {
            Codec::H264 => NV_ENC_H264_PROFILE_HIGH_GUID,
            Codec::H265 => NV_ENC_HEVC_PROFILE_MAIN_GUID,
        };
        // Infinite gop: the session decides when a keyframe happens, never a
        // timer. frameIntervalP = 1 is IPPP — no B-frames.
        config.gopLength = NVENC_INFINITE_GOPLENGTH;
        config.frameIntervalP = 1;
        apply_rate_control(&mut config, cfg);
        apply_codec_config(&mut config, cfg);

        let mut init = NV_ENC_INITIALIZE_PARAMS {
            version: NV_ENC_INITIALIZE_PARAMS_VER,
            encodeGUID: guid,
            presetGUID: NV_ENC_PRESET_P1_GUID,
            encodeWidth: cfg.width,
            encodeHeight: cfg.height,
            darWidth: cfg.width,
            darHeight: cfg.height,
            frameRateNum: cfg.fps,
            frameRateDen: 1,
            enableEncodeAsync: 1,
            enablePTD: 1,
            maxEncodeWidth: cfg.width,
            maxEncodeHeight: cfg.height,
            tuningInfo: NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
            bufferFormat: NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_ARGB,
            ..Default::default()
        };
        init.encodeConfig = Box::as_mut(&mut config) as *mut NV_ENC_CONFIG;

        // SAFETY: `config` is boxed and kept in the returned Session, so the
        // pointer inside `init` stays valid for as long as the encoder does.
        check(
            unsafe { (ENCODE_API.initialize_encoder)(encoder, &mut init) },
            "nvEncInitializeEncoder",
        )?;

        // SAFETY: an unnamed auto-reset event, initially unsignalled.
        let event = unsafe { CreateEventW(None, false, false, None) }
            .map_err(|e| from_hresult(&e))?;
        let mut event_params = NV_ENC_EVENT_PARAMS {
            version: NV_ENC_EVENT_PARAMS_VER,
            completionEvent: event.0,
            ..Default::default()
        };
        // SAFETY: owned locals; the handle outlives the session (closed in Drop).
        if let Err(e) = check(
            unsafe { (ENCODE_API.register_async_event)(encoder, &mut event_params) },
            "nvEncRegisterAsyncEvent",
        ) {
            let _ = unsafe { CloseHandle(event) };
            return Err(e);
        }

        let mut create_bitstream = NV_ENC_CREATE_BITSTREAM_BUFFER {
            version: NV_ENC_CREATE_BITSTREAM_BUFFER_VER,
            ..Default::default()
        };
        // SAFETY: owned local.
        if let Err(e) = check(
            unsafe { (ENCODE_API.create_bitstream_buffer)(encoder, &mut create_bitstream) },
            "nvEncCreateBitstreamBuffer",
        ) {
            // Nothing owns the event yet — there is no Session to drop.
            // SAFETY: unregistering and closing the handle this call created.
            unsafe {
                let _ = (ENCODE_API.unregister_async_event)(encoder, &mut event_params);
                let _ = CloseHandle(event);
            }
            return Err(e);
        }

        Ok(Self {
            encoder,
            device,
            event,
            bitstream: create_bitstream.bitstreamBuffer,
            registered: HashMap::new(),
            config,
            init,
            width: cfg.width,
            height: cfg.height,
        })
    }

    /// The registration for `handle`, registering it on first sight.
    fn registration(
        &mut self,
        texture: &ID3D11Texture2D,
        handle: usize,
    ) -> Result<NV_ENC_REGISTERED_PTR, NvencError> {
        if let Some(registered) = self.registered.get(&handle) {
            return Ok(*registered);
        }
        if self.registered.len() >= MAX_REGISTERED_TEXTURES {
            // A capture source that cycles more surfaces than this would
            // otherwise grow the map forever. Nothing is mapped at this point.
            self.unregister_all();
        }
        let mut reg = NV_ENC_REGISTER_RESOURCE {
            version: NV_ENC_REGISTER_RESOURCE_VER,
            resourceType: NV_ENC_INPUT_RESOURCE_TYPE::NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX,
            width: self.width,
            height: self.height,
            pitch: 0,
            resourceToRegister: texture.as_raw(),
            bufferFormat: NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_ARGB,
            bufferUsage: NV_ENC_BUFFER_USAGE::NV_ENC_INPUT_IMAGE,
            ..Default::default()
        };
        // SAFETY: the texture is alive for the call and stays alive as long as
        // the device this session pinned.
        check(
            unsafe { (ENCODE_API.register_resource)(self.encoder, &mut reg) },
            "nvEncRegisterResource",
        )?;
        self.registered.insert(handle, reg.registeredResource);
        Ok(reg.registeredResource)
    }

    fn unregister_all(&mut self) {
        for (_, registered) in self.registered.drain() {
            // SAFETY: each pointer came from nvEncRegisterResource on this
            // session and is unregistered once.
            let _ = unsafe { (ENCODE_API.unregister_resource)(self.encoder, registered) };
        }
    }

    fn encode(
        &mut self,
        texture: &ID3D11Texture2D,
        handle: usize,
        force_irap: bool,
    ) -> Result<Encoded, NvencError> {
        let registered = self.registration(texture, handle)?;
        let mut map = NV_ENC_MAP_INPUT_RESOURCE {
            version: NV_ENC_MAP_INPUT_RESOURCE_VER,
            registeredResource: registered,
            ..Default::default()
        };
        // SAFETY: owned local; the registration belongs to this session.
        check(
            unsafe { (ENCODE_API.map_input_resource)(self.encoder, &mut map) },
            "nvEncMapInputResource",
        )?;
        let result = self.encode_mapped(&map, force_irap);
        // SAFETY: unmapping the resource this call mapped, exactly once,
        // whether or not the encode succeeded.
        let _ = unsafe { (ENCODE_API.unmap_input_resource)(self.encoder, map.mappedResource) };
        result
    }

    fn encode_mapped(
        &self,
        map: &NV_ENC_MAP_INPUT_RESOURCE,
        force_irap: bool,
    ) -> Result<Encoded, NvencError> {
        let mut pic = NV_ENC_PIC_PARAMS {
            version: NV_ENC_PIC_PARAMS_VER,
            inputWidth: self.width,
            inputHeight: self.height,
            inputPitch: self.width,
            encodePicFlags: if force_irap {
                NV_ENC_PIC_FLAGS::NV_ENC_PIC_FLAG_FORCEIDR as u32
            } else {
                0
            },
            inputBuffer: map.mappedResource,
            outputBitstream: self.bitstream,
            completionEvent: self.event.0,
            bufferFmt: NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_ARGB,
            pictureStruct: NV_ENC_PIC_STRUCT::NV_ENC_PIC_STRUCT_FRAME,
            ..Default::default()
        };
        // SAFETY: owned local; every pointer inside belongs to this session.
        check(
            unsafe { (ENCODE_API.encode_picture)(self.encoder, &mut pic) },
            "nvEncEncodePicture",
        )?;
        // SAFETY: the event is registered with this session and auto-resets.
        let wait = unsafe { WaitForSingleObject(self.event, ENCODE_WAIT_MS) };
        if wait != WAIT_OBJECT_0 {
            return Err(NvencError::D3d(format!(
                "the encode completion event returned {wait:?}"
            )));
        }

        let mut lock = NV_ENC_LOCK_BITSTREAM {
            version: NV_ENC_LOCK_BITSTREAM_VER,
            outputBitstream: self.bitstream,
            ..Default::default()
        };
        // SAFETY: owned local; the bitstream buffer belongs to this session.
        check(
            unsafe { (ENCODE_API.lock_bitstream)(self.encoder, &mut lock) },
            "nvEncLockBitstream",
        )?;
        // SAFETY: the driver just handed back this pointer and length, and they
        // stay valid until the unlock below.
        let data = unsafe {
            std::slice::from_raw_parts(
                lock.bitstreamBufferPtr.cast::<u8>(),
                lock.bitstreamSizeInBytes as usize,
            )
        }
        .to_vec();
        // `numSlices` is not readable here: reportSliceOffsets requires
        // enableEncodeAsync = 0 (spike 0.9 §4), so the slice assertion parses
        // NALs in the hardware test instead.
        let is_irap = lock.pictureType == NV_ENC_PIC_TYPE::NV_ENC_PIC_TYPE_IDR;
        // SAFETY: unlocking the buffer this call locked.
        check(
            unsafe { (ENCODE_API.unlock_bitstream)(self.encoder, self.bitstream) },
            "nvEncUnlockBitstream",
        )?;
        Ok(Encoded { data, is_irap })
    }

    /// Move the CBR target without a reset and without a keyframe. The VBV
    /// moves in the same call: a one-frame buffer sized for the old rate clamps
    /// the new one (spike 0.9 §3).
    fn reconfigure(&mut self, cfg: &EncoderConfig) -> Result<(), NvencError> {
        apply_rate_control(&mut self.config, cfg);
        let mut reinit = self.init;
        reinit.version = NV_ENC_INITIALIZE_PARAMS_VER;
        reinit.encodeConfig = Box::as_mut(&mut self.config) as *mut NV_ENC_CONFIG;
        let mut params = NV_ENC_RECONFIGURE_PARAMS {
            version: NV_ENC_RECONFIGURE_PARAMS_VER,
            reInitEncodeParams: reinit,
            ..Default::default()
        };
        params.set_resetEncoder(0);
        params.set_forceIDR(0);
        // SAFETY: owned local pointing at this session's boxed config.
        check(
            unsafe { (ENCODE_API.reconfigure_encoder)(self.encoder, &mut params) },
            "nvEncReconfigureEncoder",
        )
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.unregister_all();
        // SAFETY: every handle below belongs to this session and is released
        // once, in the order the SDK requires.
        unsafe {
            let _ = (ENCODE_API.destroy_bitstream_buffer)(self.encoder, self.bitstream);
            let mut event_params = NV_ENC_EVENT_PARAMS {
                version: NV_ENC_EVENT_PARAMS_VER,
                completionEvent: self.event.0,
                ..Default::default()
            };
            let _ = (ENCODE_API.unregister_async_event)(self.encoder, &mut event_params);
            let _ = CloseHandle(self.event);
            let _ = (ENCODE_API.destroy_encoder)(self.encoder);
        }
    }
}

/// CBR with a one-frame VBV for deltas and [`KEYFRAME_VBV_SCALE`] frames for an
/// IDR, no lookahead, no adaptive quantisation, and `zeroReorderDelay` so the
/// encoder never holds output back.
fn apply_rate_control(config: &mut NV_ENC_CONFIG, cfg: &EncoderConfig) {
    let rc = &mut config.rcParams;
    rc.rateControlMode = NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CBR;
    rc.averageBitRate = cfg.bitrate_bps;
    rc.maxBitRate = cfg.bitrate_bps;
    // One frame of VBV, floored at 1/60 s worth: below that a single I-frame
    // cannot fit its own budget and the rate controller thrashes.
    let one_frame = cfg.bitrate_bps / cfg.fps.max(1);
    rc.vbvBufferSize = one_frame.max(cfg.bitrate_bps / 60);
    rc.vbvInitialDelay = rc.vbvBufferSize;
    // 1.7 ms p50, and the only setting that hits the requested bitrate:
    // single-pass undershoots by 30 % (spike 0.9 §6b).
    rc.multiPass = NV_ENC_MULTI_PASS::NV_ENC_TWO_PASS_QUARTER_RESOLUTION;
    // The line above paces deltas; this one is what stops it starving the
    // keyframe they all reference. See the module doc.
    rc.lowDelayKeyFrameScale = KEYFRAME_VBV_SCALE;
    rc.lookaheadDepth = 0;
    rc.set_enableLookahead(0);
    rc.set_zeroReorderDelay(1);
    rc.set_enableAQ(0);
    rc.set_enableTemporalAQ(0);
    rc.set_enableNonRefP(0);
}

/// Per-codec settings: single slice, parameter sets in band with every IRAP, a
/// 4-frame DPB with one reference, no intra refresh, no LTR, and the H.264 VUI
/// fix.
fn apply_codec_config(config: &mut NV_ENC_CONFIG, cfg: &EncoderConfig) {
    let codec: &mut NV_ENC_CODEC_CONFIG = &mut config.encodeCodecConfig;
    match cfg.codec {
        Codec::H264 => {
            // SAFETY: the union is written through the arm matching the codec
            // GUID this session was opened with.
            let h264 = unsafe { &mut codec.h264Config };
            h264.idrPeriod = NVENC_INFINITE_GOPLENGTH;
            h264.maxNumRefFrames = 4;
            h264.numRefL0 = NV_ENC_NUM_REF_FRAMES::NV_ENC_NUM_REF_FRAMES_1;
            h264.entropyCodingMode =
                NV_ENC_H264_ENTROPY_CODING_MODE::NV_ENC_H264_ENTROPY_CODING_MODE_CABAC;
            // One slice per picture: a lost slice is a hard decode failure in
            // current Chrome, so a damaged multi-slice picture is worse than a
            // dropped frame.
            h264.sliceMode = 3;
            h264.sliceModeData = 1;
            h264.set_repeatSPSPPS(1);
            // Intra refresh stays off: it makes every frame multi-slice.
            h264.set_enableIntraRefresh(0);
            h264.set_outputBufferingPeriodSEI(0);
            h264.set_outputPictureTimingSEI(0);
            h264.set_outputAUD(0);
            h264.set_enableLTR(0);
            h264.set_enableFillerDataInsertion(0);
            // Mandatory. Without it the decoder holds up to 16 frames of output
            // — the level's whole DPB. max_dec_frame_buffering is not settable
            // and comes back as maxNumRefFrames; max_num_reorder_frames is the
            // one that matters and this is what sets it to 0.
            h264.h264VUIParameters.bitstreamRestrictionFlag = 1;
        }
        Codec::H265 => {
            // SAFETY: as above.
            let hevc = unsafe { &mut codec.hevcConfig };
            hevc.idrPeriod = NVENC_INFINITE_GOPLENGTH;
            hevc.maxNumRefFramesInDPB = 4;
            hevc.numRefL0 = NV_ENC_NUM_REF_FRAMES::NV_ENC_NUM_REF_FRAMES_1;
            hevc.sliceMode = 3;
            hevc.sliceModeData = 1;
            hevc.set_repeatSPSPPS(1);
            hevc.set_enableIntraRefresh(0);
            hevc.set_outputBufferingPeriodSEI(0);
            hevc.set_outputPictureTimingSEI(0);
            hevc.set_outputAUD(0);
            hevc.set_enableLTR(0);
            hevc.set_enableFillerDataInsertion(0);
            hevc.hevcVUIParameters.bitstreamRestrictionFlag = 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde::Deserialize;

    // Enough Annex-B parsing to assert what the encoder emitted rather than
    // what it was configured to emit. It lives in the tests because nothing in
    // the shipping path walks the bitstream — the picture type comes out of
    // NV_ENC_LOCK_BITSTREAM — and because the slice count cannot be read there
    // at all: `numSlices` needs reportSliceOffsets, which needs
    // enableEncodeAsync = 0 (spike 0.9 §4).

    const H264_NAL_IDR: u8 = 5;
    const H264_NAL_SPS: u8 = 7;

    /// One NAL unit inside an Annex-B buffer. `start`/`end` bracket the payload
    /// including the NAL header byte(s) and excluding the start code.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Nal {
        ty: u8,
        start: usize,
        end: usize,
    }

    /// Split an Annex-B buffer into NAL units, accepting 3- and 4-byte start codes.
    fn parse_annexb(data: &[u8], codec: Codec) -> Vec<Nal> {
        let mut starts = Vec::new();
        let mut i = 0usize;
        while i + 2 < data.len() {
            if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
                starts.push(i + 3);
                i += 3;
            } else {
                i += 1;
            }
        }
        let header_len = match codec {
            Codec::H264 => 1,
            Codec::H265 => 2,
        };
        let mut out = Vec::with_capacity(starts.len());
        for (n, &start) in starts.iter().enumerate() {
            // The unit runs to the byte before the next start code, minus the zero
            // bytes that belong to it (a 4-byte code is a 3-byte code with a
            // leading zero).
            let mut end = starts.get(n + 1).map_or(data.len(), |&next| next - 3);
            while end > start && data[end - 1] == 0 {
                end -= 1;
            }
            if end < start + header_len {
                continue;
            }
            let ty = match codec {
                Codec::H264 => data[start] & 0x1f,
                Codec::H265 => (data[start] >> 1) & 0x3f,
            };
            out.push(Nal { ty, start, end });
        }
        out
    }

    /// Is this a coded slice? Only VCL units count towards the slice check.
    fn is_vcl(codec: Codec, ty: u8) -> bool {
        match codec {
            Codec::H264 => (1..=5).contains(&ty),
            Codec::H265 => ty <= 31,
        }
    }

    /// Strip emulation-prevention bytes (`00 00 03` -> `00 00`).
    fn rbsp(payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(payload.len());
        let mut zeros = 0usize;
        for &b in payload {
            if zeros >= 2 && b == 3 {
                zeros = 0;
                continue;
            }
            if b == 0 {
                zeros += 1;
            } else {
                zeros = 0;
            }
            out.push(b);
        }
        out
    }

    struct BitReader<'a> {
        data: &'a [u8],
        bit: usize,
    }

    impl<'a> BitReader<'a> {
        fn new(data: &'a [u8]) -> Self {
            Self { data, bit: 0 }
        }

        fn u1(&mut self) -> Option<u32> {
            let byte = *self.data.get(self.bit / 8)?;
            let shift = 7 - (self.bit % 8);
            self.bit += 1;
            Some(u32::from((byte >> shift) & 1))
        }

        fn u(&mut self, n: u32) -> Option<u32> {
            let mut v = 0u32;
            for _ in 0..n {
                v = (v << 1) | self.u1()?;
            }
            Some(v)
        }

        /// Unsigned Exp-Golomb, bounded so a corrupt stream terminates.
        fn ue(&mut self) -> Option<u32> {
            let mut leading = 0u32;
            while self.u1()? == 0 {
                leading += 1;
                if leading > 32 {
                    return None;
                }
            }
            if leading == 0 {
                return Some(0);
            }
            Some((1u32 << leading) - 1 + self.u(leading)?)
        }

        fn se(&mut self) -> Option<i32> {
            let k = self.ue()?;
            let magnitude = i64::from(k).div_euclid(2) + i64::from(k % 2);
            Some(if k % 2 == 1 {
                magnitude as i32
            } else {
                -(magnitude as i32)
            })
        }
    }

    /// The part of an H.264 SPS this backend reads back.
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    struct H264Sps {
        profile_idc: u8,
        /// The `constraint_set*_flags` byte, needed verbatim for the `avc1.PPCCLL`
        /// codec string the browser configures its decoder with.
        constraint_flags: u8,
        level_idc: u8,
        vui_present: bool,
        bitstream_restriction_flag: bool,
        max_num_reorder_frames: Option<u32>,
        max_dec_frame_buffering: Option<u32>,
    }

    impl H264Sps {
        /// The RFC 6381 codec string for this SPS, e.g. `avc1.64002a`. It has to
        /// come from the bitstream, not from what the encoder was asked for.
        fn codec_string(&self) -> String {
            format!(
                "avc1.{:02x}{:02x}{:02x}",
                self.profile_idc, self.constraint_flags, self.level_idc
            )
        }
    }

    fn skip_scaling_list(r: &mut BitReader, size: usize) -> Option<()> {
        let mut last_scale = 8i32;
        let mut next_scale = 8i32;
        for _ in 0..size {
            if next_scale != 0 {
                let delta = r.se()?;
                next_scale = (last_scale + delta + 256).rem_euclid(256);
            }
            if next_scale != 0 {
                last_scale = next_scale;
            }
        }
        Some(())
    }

    fn skip_hrd_parameters(r: &mut BitReader) -> Option<()> {
        let cpb_cnt_minus1 = r.ue()?;
        r.u(4)?; // bit_rate_scale
        r.u(4)?; // cpb_size_scale
        for _ in 0..=cpb_cnt_minus1 {
            r.ue()?; // bit_rate_value_minus1
            r.ue()?; // cpb_size_value_minus1
            r.u1()?; // cbr_flag
        }
        r.u(5)?; // initial_cpb_removal_delay_length_minus1
        r.u(5)?; // cpb_removal_delay_length_minus1
        r.u(5)?; // dpb_output_delay_length_minus1
        r.u(5)?; // time_offset_length
        Some(())
    }

    /// Parse an H.264 SPS NAL payload (header byte included) far enough to read the
    /// VUI bitstream-restriction block. `None` on a malformed unit.
    fn parse_h264_sps(payload: &[u8]) -> Option<H264Sps> {
        if payload.is_empty() || payload[0] & 0x1f != H264_NAL_SPS {
            return None;
        }
        let data = rbsp(&payload[1..]);
        let mut r = BitReader::new(&data);
        let mut sps = H264Sps {
            profile_idc: r.u(8)? as u8,
            ..Default::default()
        };
        sps.constraint_flags = r.u(8)? as u8;
        sps.level_idc = r.u(8)? as u8;
        r.ue()?; // seq_parameter_set_id

        const HIGH_PROFILES: [u8; 13] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
        if HIGH_PROFILES.contains(&sps.profile_idc) {
            let chroma_format_idc = r.ue()?;
            if chroma_format_idc == 3 {
                r.u1()?; // separate_colour_plane_flag
            }
            r.ue()?; // bit_depth_luma_minus8
            r.ue()?; // bit_depth_chroma_minus8
            r.u1()?; // qpprime_y_zero_transform_bypass_flag
            if r.u1()? == 1 {
                let lists = if chroma_format_idc != 3 { 8 } else { 12 };
                for i in 0..lists {
                    if r.u1()? == 1 {
                        skip_scaling_list(&mut r, if i < 6 { 16 } else { 64 })?;
                    }
                }
            }
        }

        r.ue()?; // log2_max_frame_num_minus4
        let poc_type = r.ue()?;
        if poc_type == 0 {
            r.ue()?; // log2_max_pic_order_cnt_lsb_minus4
        } else if poc_type == 1 {
            r.u1()?; // delta_pic_order_always_zero_flag
            r.se()?; // offset_for_non_ref_pic
            r.se()?; // offset_for_top_to_bottom_field
            let cycle = r.ue()?;
            for _ in 0..cycle {
                r.se()?; // offset_for_ref_frame[i]
            }
        }
        r.ue()?; // max_num_ref_frames
        r.u1()?; // gaps_in_frame_num_value_allowed_flag
        r.ue()?; // pic_width_in_mbs_minus1
        r.ue()?; // pic_height_in_map_units_minus1
        if r.u1()? == 0 {
            r.u1()?; // mb_adaptive_frame_field_flag
        }
        r.u1()?; // direct_8x8_inference_flag
        if r.u1()? == 1 {
            r.ue()?; // frame_crop_left_offset
            r.ue()?; // frame_crop_right_offset
            r.ue()?; // frame_crop_top_offset
            r.ue()?; // frame_crop_bottom_offset
        }

        sps.vui_present = r.u1()? == 1;
        if !sps.vui_present {
            return Some(sps);
        }

        if r.u1()? == 1 {
            // aspect_ratio_info_present_flag
            if r.u(8)? == 255 {
                r.u(16)?; // sar_width
                r.u(16)?; // sar_height
            }
        }
        if r.u1()? == 1 {
            r.u1()?; // overscan_appropriate_flag
        }
        if r.u1()? == 1 {
            // video_signal_type_present_flag
            r.u(3)?; // video_format
            r.u1()?; // video_full_range_flag
            if r.u1()? == 1 {
                r.u(8)?; // colour_primaries
                r.u(8)?; // transfer_characteristics
                r.u(8)?; // matrix_coefficients
            }
        }
        if r.u1()? == 1 {
            // chroma_loc_info_present_flag
            r.ue()?;
            r.ue()?;
        }
        if r.u1()? == 1 {
            // timing_info_present_flag
            r.u(32)?; // num_units_in_tick
            r.u(32)?; // time_scale
            r.u1()?; // fixed_frame_rate_flag
        }
        let nal_hrd = r.u1()? == 1;
        if nal_hrd {
            skip_hrd_parameters(&mut r)?;
        }
        let vcl_hrd = r.u1()? == 1;
        if vcl_hrd {
            skip_hrd_parameters(&mut r)?;
        }
        if nal_hrd || vcl_hrd {
            r.u1()?; // low_delay_hrd_flag
        }
        r.u1()?; // pic_struct_present_flag

        sps.bitstream_restriction_flag = r.u1()? == 1;
        if sps.bitstream_restriction_flag {
            r.u1()?; // motion_vectors_over_pic_boundaries_flag
            r.ue()?; // max_bytes_per_pic_denom
            r.ue()?; // max_bits_per_mb_denom
            r.ue()?; // log2_max_mv_length_horizontal
            r.ue()?; // log2_max_mv_length_vertical
            sps.max_num_reorder_frames = Some(r.ue()?);
            sps.max_dec_frame_buffering = Some(r.ue()?);
        }
        Some(sps)
    }

    fn base() -> EncoderConfig {
        EncoderConfig {
            codec: Codec::H264,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_bps: 20_000_000,
        }
    }

    fn blank_config() -> NV_ENC_CONFIG {
        NV_ENC_CONFIG {
            version: NV_ENC_CONFIG_VER,
            ..Default::default()
        }
    }

    #[test]
    fn one_frame_of_vbv_paces_the_deltas_and_the_keyframe_is_let_out_of_it() {
        let mut config = blank_config();
        apply_rate_control(&mut config, &base());
        // The delta budget, which is D7's decision and does not move: one
        // frame, 41.7 KB at the default 20 Mbps.
        assert_eq!(config.rcParams.vbvBufferSize, 20_000_000 / 60);
        assert_eq!(
            config.rcParams.vbvInitialDelay,
            config.rcParams.vbvBufferSize
        );
        // And the one picture that is not held to it. At 1 — what shipped — a
        // keyframe got a P frame's bits and a still desktop kept the crushed
        // result for as long as nothing redrew it.
        assert_eq!(config.rcParams.lowDelayKeyFrameScale, 4);
        assert_eq!(config.rcParams.averageBitRate, config.rcParams.maxBitRate);
    }

    #[test]
    fn vbv_never_falls_below_one_sixtieth_of_a_second() {
        let mut config = blank_config();
        apply_rate_control(&mut config, &EncoderConfig { fps: 240, ..base() });
        assert_eq!(config.rcParams.vbvBufferSize, 20_000_000 / 60);
    }

    #[test]
    fn a_bitrate_change_moves_the_vbv_with_it() {
        let mut config = blank_config();
        apply_rate_control(&mut config, &base());
        apply_rate_control(
            &mut config,
            &EncoderConfig {
                bitrate_bps: 5_000_000,
                ..base()
            },
        );
        assert_eq!(config.rcParams.averageBitRate, 5_000_000);
        assert_eq!(config.rcParams.vbvBufferSize, 5_000_000 / 60);
        assert_eq!(
            config.rcParams.vbvInitialDelay,
            config.rcParams.vbvBufferSize
        );
    }

    #[test]
    fn rate_control_is_cbr_two_pass_with_no_lookahead_and_no_reorder_delay() {
        let mut config = blank_config();
        apply_rate_control(&mut config, &base());
        assert_eq!(
            config.rcParams.rateControlMode,
            NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CBR
        );
        assert_eq!(
            config.rcParams.multiPass,
            NV_ENC_MULTI_PASS::NV_ENC_TWO_PASS_QUARTER_RESOLUTION
        );
        assert_eq!(config.rcParams.lookaheadDepth, 0);
        assert_eq!(config.rcParams.enableLookahead(), 0);
        assert_eq!(config.rcParams.zeroReorderDelay(), 1);
    }

    #[test]
    fn h264_is_single_slice_with_repeated_parameter_sets_and_the_vui_fix() {
        let mut config = blank_config();
        apply_codec_config(&mut config, &base());
        // SAFETY: written and read through the H.264 arm of the union.
        let h264 = unsafe { &config.encodeCodecConfig.h264Config };
        assert_eq!((h264.sliceMode, h264.sliceModeData), (3, 1));
        assert_eq!(h264.repeatSPSPPS(), 1);
        assert_eq!(h264.enableIntraRefresh(), 0);
        assert_eq!(h264.enableLTR(), 0);
        assert_eq!(h264.idrPeriod, NVENC_INFINITE_GOPLENGTH);
        assert_eq!(h264.maxNumRefFrames, 4);
        assert_eq!(h264.h264VUIParameters.bitstreamRestrictionFlag, 1);
    }

    #[test]
    fn hevc_is_single_slice_with_repeated_parameter_sets() {
        let mut config = blank_config();
        apply_codec_config(
            &mut config,
            &EncoderConfig {
                codec: Codec::H265,
                ..base()
            },
        );
        // SAFETY: written and read through the HEVC arm of the union.
        let hevc = unsafe { &config.encodeCodecConfig.hevcConfig };
        assert_eq!((hevc.sliceMode, hevc.sliceModeData), (3, 1));
        assert_eq!(hevc.repeatSPSPPS(), 1);
        assert_eq!(hevc.enableIntraRefresh(), 0);
        assert_eq!(hevc.maxNumRefFramesInDPB, 4);
    }

    #[test]
    fn a_size_above_the_codec_cap_is_refused_before_the_driver_is_touched() {
        for (codec, width) in [(Codec::H264, 4097), (Codec::H265, 8193)] {
            let Err(err) = create(&EncoderConfig {
                codec,
                width,
                height: 2160,
                ..base()
            }) else {
                panic!("a size above the cap must be refused");
            };
            let typed = err
                .downcast_ref::<NvencError>()
                .expect("the refusal is typed");
            assert!(
                matches!(typed, NvencError::UnsupportedSize { .. }),
                "expected UnsupportedSize, got {typed:?}"
            );
            assert_eq!(typed.exit().code(), 13);
        }
    }

    #[test]
    fn every_encoder_failure_exits_thirteen() {
        for error in [
            NvencError::DriverMissing("no driver".to_string()),
            NvencError::SessionBusy,
            NvencError::DeviceChanged,
            NvencError::NoTexture,
        ] {
            assert_eq!(error.exit().code(), 13, "{error}");
        }
    }

    // ------------------------------------------------------- sps parsing ---

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SpsVectors {
        vectors: Vec<SpsVector>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SpsVector {
        name: String,
        sps: String,
        expect: SpsExpect,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SpsExpect {
        profile_idc: u8,
        level_idc: u8,
        codec_string: String,
        vui_present: bool,
        bitstream_restriction_flag: bool,
        max_num_reorder_frames: Option<u32>,
        max_dec_frame_buffering: Option<u32>,
    }

    fn sps_vectors() -> Vec<SpsVector> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/encode/nvenc-h264-sps.json");
        let raw = std::fs::read_to_string(&path).expect("the sps golden vectors are readable");
        serde_json::from_str::<SpsVectors>(&raw)
            .expect("the sps golden vectors parse")
            .vectors
    }

    #[test]
    fn golden_sps_vectors_parse_as_nvenc_emitted_them() {
        let vectors = sps_vectors();
        assert_eq!(vectors.len(), 4, "every vector in the file is run");
        for vector in vectors {
            let bytes = hex::decode(&vector.sps).expect("the vector is hex");
            let sps = parse_h264_sps(&bytes)
                .unwrap_or_else(|| panic!("{} parses", vector.name));
            let expect = &vector.expect;
            assert_eq!(sps.profile_idc, expect.profile_idc, "{}", vector.name);
            assert_eq!(sps.level_idc, expect.level_idc, "{}", vector.name);
            assert_eq!(sps.codec_string(), expect.codec_string, "{}", vector.name);
            assert_eq!(sps.vui_present, expect.vui_present, "{}", vector.name);
            assert_eq!(
                sps.bitstream_restriction_flag, expect.bitstream_restriction_flag,
                "{}",
                vector.name
            );
            assert_eq!(
                sps.max_num_reorder_frames, expect.max_num_reorder_frames,
                "{}",
                vector.name
            );
            assert_eq!(
                sps.max_dec_frame_buffering, expect.max_dec_frame_buffering,
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn the_shipping_configuration_declares_zero_reordering_at_every_level() {
        for vector in sps_vectors().iter().filter(|v| v.name.ends_with("vui-on")) {
            let bytes = hex::decode(&vector.sps).expect("the vector is hex");
            let sps = parse_h264_sps(&bytes).expect("parses");
            assert!(sps.bitstream_restriction_flag, "{}", vector.name);
            assert_eq!(sps.max_num_reorder_frames, Some(0), "{}", vector.name);
            // Not 0, and not asserted to be: nvenc has no field for it and
            // emits maxNumRefFrames instead (spike 0.9 amendment 1).
            assert_eq!(sps.max_dec_frame_buffering, Some(4), "{}", vector.name);
        }
    }

    #[test]
    fn annexb_splitting_handles_three_and_four_byte_start_codes() {
        let data = [0, 0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x65, 0xAA, 0xBB];
        let nals = parse_annexb(&data, Codec::H264);
        assert_eq!(nals.len(), 2);
        assert_eq!(nals[0].ty, H264_NAL_SPS);
        assert_eq!(&data[nals[0].start..nals[0].end], &[0x67, 0x42]);
        assert_eq!(nals[1].ty, H264_NAL_IDR);
        assert!(is_vcl(Codec::H264, nals[1].ty));
    }

    #[test]
    fn hevc_nal_type_comes_from_the_two_byte_header() {
        // 0x40 0x01 -> type 32 (VPS); 0x26 0x01 -> type 19 (IDR_W_RADL).
        let data = [0, 0, 0, 1, 0x40, 0x01, 0xAA, 0, 0, 0, 1, 0x26, 0x01, 0xBB];
        let nals = parse_annexb(&data, Codec::H265);
        assert_eq!(nals.len(), 2);
        assert_eq!(nals[0].ty, 32);
        assert!(!is_vcl(Codec::H265, nals[0].ty));
        assert!(is_vcl(Codec::H265, nals[1].ty));
    }

    #[test]
    fn rbsp_drops_only_the_emulation_prevention_byte() {
        assert_eq!(rbsp(&[0x00, 0x00, 0x03, 0x01]), vec![0x00, 0x00, 0x01]);
        // A lone 0x03 not preceded by two zeros is real payload.
        assert_eq!(rbsp(&[0x01, 0x03, 0x00, 0x03]), vec![0x01, 0x03, 0x00, 0x03]);
    }

    #[test]
    fn exp_golomb_matches_the_spec_table() {
        // ue codes 1 / 010 / 011 / 00100 / 00101 packed MSB-first.
        let data = [0b1010_0110, 0b0100_0010, 0b1000_0000];
        let mut r = BitReader::new(&data);
        assert_eq!((r.ue(), r.ue(), r.ue(), r.ue(), r.ue()), (Some(0), Some(1), Some(2), Some(3), Some(4)));
        let mut r = BitReader::new(&data);
        assert_eq!((r.se(), r.se(), r.se()), (Some(0), Some(1), Some(-1)));
    }

    #[test]
    fn a_truncated_or_wrong_nal_is_none_not_a_panic() {
        assert_eq!(parse_h264_sps(&[0x67, 0x42]), None);
        assert_eq!(parse_h264_sps(&[]), None);
        assert_eq!(parse_h264_sps(&[0x65, 0x42, 0x00, 0x1f]), None);
    }

    // ---------------------------------------------------- hardware tests ---

    /// Fill a BGRA frame with screen-like content: a noisy wallpaper half an
    /// intra picture cannot cheat on, rows of text-sized detail, and a block
    /// that moves with `phase` so the encoder is never handed a still picture.
    /// The detail is load-bearing — a keyframe's budget cannot be measured on a
    /// flat grey, which is what this pattern used to be.
    fn pattern(width: u32, height: u32, phase: u32) -> Vec<u8> {
        let (w, h) = (width as usize, height as usize);
        let mut px = vec![0u8; w * h * 4];
        // A fixed lcg rather than `rand`: every run has to encode the same
        // picture or the byte counts below mean nothing.
        let mut seed = 0x1234_5678u32;
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                let (b, g, r) = if x < w * 55 / 100 {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    let n = (seed >> 24) as u8;
                    (
                        n / 3 + (x * 200 / w) as u8,
                        n / 3 + (y * 160 / h) as u8,
                        n / 2,
                    )
                } else if y % 19 < 2 && (x / 7) % 11 != 0 {
                    (0x20, 0x20, 0x20)
                } else {
                    (0xf0, 0xf0, 0xf0)
                };
                px[i] = b;
                px[i + 1] = g;
                px[i + 2] = r;
                px[i + 3] = 0xff;
            }
        }
        let bw = w / 6;
        let bh = h / 6;
        let bx = (phase as usize * 137) % w.saturating_sub(bw).max(1);
        for y in (h / 3)..(h / 3 + bh).min(h) {
            for x in bx..(bx + bw).min(w) {
                let i = (y * w + x) * 4;
                px[i] = 0x10;
                px[i + 1] = 0x60;
                px[i + 2] = 0xc0;
            }
        }
        px
    }

    fn test_texture(device: &ID3D11Device, width: u32, height: u32, phase: u32) -> ID3D11Texture2D {
        use windows::Win32::Graphics::Direct3D11::{
            D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_SUBRESOURCE_DATA,
            D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
        };
        use windows::Win32::Graphics::Dxgi::Common::{
            DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
        };

        let pixels = pattern(width, height, phase);
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
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: width * 4,
            SysMemSlicePitch: 0,
        };
        let mut texture = None;
        // SAFETY: the description and the initial data outlive the call.
        unsafe { device.CreateTexture2D(&desc, Some(&init), Some(&mut texture)) }
            .expect("the test texture is created");
        texture.expect("d3d11 returned a texture")
    }

    /// Needs an NVIDIA GPU: `cargo test -- --ignored nvenc`. The expected
    /// output is in the module doc comment.
    #[test]
    #[ignore = "needs an nvidia gpu"]
    fn nvenc_encodes_and_the_stream_says_what_spike_09_measured() {
        let device = probe_device().expect("this machine has an nvenc-capable adapter");
        let cfg = base();
        let textures: Vec<ID3D11Texture2D> = (0..4)
            .map(|phase| test_texture(&device, cfg.width, cfg.height, phase))
            .collect();
        let mut encoder = create(&cfg).expect("the encoder opens");

        let mut irap_count = 0usize;
        let mut max_vcl = 0usize;
        let mut sps = None;
        // The keyframe budget, which is only readable before the rate moves at
        // frame 60: the first picture against the deltas that follow it.
        let mut keyframe_bytes = 0usize;
        let mut delta_bytes = 0usize;
        for i in 0..120u32 {
            // Halfway through, move the bitrate: a reconfigure must not cost a
            // keyframe (spike 0.9 §3).
            if i == 60 {
                encoder.set_bitrate(10_000_000).expect("the rate moves");
            }
            let texture = &textures[(i % 4) as usize];
            let frame = Frame {
                handle: texture.as_raw() as usize,
                width: cfg.width,
                height: cfg.height,
                captured_qpc: qpc_now(),
            };
            let encoded = encoder
                .encode(&frame, false)
                .expect("the frame encodes")
                .expect("every submitted picture produces output");
            assert_eq!(encoded.frame_id, u64::from(i));
            if encoded.is_irap {
                irap_count += 1;
            }
            if i == 0 {
                keyframe_bytes = encoded.data.len();
            } else if i < 60 {
                delta_bytes += encoded.data.len();
            }
            let nals = parse_annexb(&encoded.data, cfg.codec);
            max_vcl = max_vcl.max(nals.iter().filter(|n| is_vcl(cfg.codec, n.ty)).count());
            if sps.is_none() {
                sps = nals
                    .iter()
                    .find(|n| n.ty == H264_NAL_SPS)
                    .and_then(|n| parse_h264_sps(&encoded.data[n.start..n.end]));
            }
        }

        let sps = sps.expect("the first access unit carries an sps in band");
        println!(
            "nvenc gpu test: 120 frames, {irap_count} irap, max {max_vcl} vcl nal per access unit, sps {}",
            sps.codec_string()
        );
        println!(
            "  bitstream_restriction_flag={} max_num_reorder_frames={:?} max_dec_frame_buffering={:?}",
            sps.bitstream_restriction_flag, sps.max_num_reorder_frames, sps.max_dec_frame_buffering
        );
        let delta_mean = delta_bytes / 59;
        println!("  keyframe {keyframe_bytes} B, mean delta {delta_mean} B at 20 mbps");
        assert_eq!(irap_count, 1, "only the first picture is an idr");
        assert_eq!(max_vcl, 1, "every access unit is a single slice");
        // The defect KEYFRAME_VBV_SCALE fixes: with the scale at 1 the keyframe
        // is held to the deltas' one-frame VBV and comes back the same size as
        // one, which on a still desktop is a picture that never gets better.
        assert!(
            keyframe_bytes > delta_mean * 4,
            "the keyframe is capped at a delta's budget: {keyframe_bytes} B vs {delta_mean} B"
        );
        assert!(sps.bitstream_restriction_flag);
        assert_eq!(sps.max_num_reorder_frames, Some(0));
        assert_eq!(sps.max_dec_frame_buffering, Some(4));
    }

    /// Needs an NVIDIA GPU: `cargo test -- --ignored nvenc`.
    #[test]
    #[ignore = "needs an nvidia gpu"]
    fn nvenc_probe_reports_codecs_and_a_session_budget() {
        let caps = probe();
        println!("nvenc probe: {caps:?}");
        assert_eq!(caps.backend, "nvenc");
        assert!(caps.accepts_bgra_texture);
        assert!(!caps.codecs.is_empty(), "an nvidia box encodes something");
        assert!(caps.concurrent_sessions >= 1);
        for codec in &caps.codecs {
            assert!(codec.max_width >= 4096 && codec.max_height >= 4096);
        }
    }
}
