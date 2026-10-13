//! Media Foundation: the encoder for a Windows machine without NVENC.
//!
//! Two rungs of the chain, each with the two root symbols every backend has
//! (`probe()` and `create()`), in its own module:
//!
//! * [`hw`] (`mf-hw`) — the GPU vendor's hardware encoder MFT, whichever
//!   vendor that is: Intel Quick Sync, AMD VCN, or NVIDIA's own MFT over NVENC.
//!   Asynchronous, fed D3D11 NV12 textures through a DXGI device manager.
//! * [`sw`] (`mf-sw`) — Microsoft's in-box H.264 encoder, on the CPU, for a VM
//!   or a box whose GPU has no encoder. Synchronous, fed NV12 read back from
//!   the GPU, capped at 720p30 and at a few worker threads so it cannot starve
//!   the machine's real workload.
//!
//! The owner chose Media Foundation for both on 2026-10-11 over the plan's
//! ranking (FFmpeg/oneVPL/AMF, openh264): it is in the box on every Windows
//! install, so neither rung ships a vendor DLL or adds a crate. The measured
//! numbers are in `dev/active/swoop/spikes/6.7-encoder-breadth.md`.
//!
//! # What both rungs share
//!
//! H.264 only. Both take the same BGRA D3D11 frame the NVENC path takes and
//! convert it to BT.709 limited-range NV12 on the GPU with the crate's one
//! video-processor path (`gpu::scale::Downscaler::open_nv12`) — or, for the
//! software rung on a device with no video processor, on the CPU — so
//! `accepts_bgra_texture` is false: the convert is a stage, just not one the
//! session has to run. Low-latency mode, CBR with a one-frame buffer, no
//! B-frames, a GOP long enough that the keyframes are the ones the session
//! forces ([`GOP_FRAMES`]), one slice per picture. An IDR that arrives
//! without its SPS and PPS is given the output type's sequence header, and
//! every SPS that does not already declare `max_num_reorder_frames = 0` is
//! rewritten to (`encode::h264_sps`), exactly as VideoToolbox's is: without it
//! Chrome holds a full picture buffer. Both encoders measured here already
//! declare it.
//!
//! H.264 only, on purpose: these are the fallback rungs, plan.md D5 makes
//! H.264 the codec every viewer can decode, and HEVC through Media Foundation
//! was not attempted.
//!
//! # mfplat.dll is loaded by absolute path
//!
//! The `windows` crate links its Media Foundation functions as static imports
//! of mfplat.dll, and the N and KN editions of Windows ship without it unless
//! the Media Feature Pack is installed — so one call through those bindings
//! would stop the streamer *starting* on such a box, NVENC and `probe`
//! included. The few free functions used here are resolved from
//! `%SystemRoot%\System32\mfplat.dll` at run time instead, the discipline
//! NVENC's library gets; everything else is a COM vtable.

use std::borrow::Cow;
use std::ffi::c_void;
use std::mem::ManuallyDrop;
use std::sync::OnceLock;

use thiserror::Error;
use windows::core::{Interface, BOOL, GUID, HRESULT};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::{
    eAVEncCommonRateControlMode_CBR, CODECAPI_AVEncCommonBufferSize,
    CODECAPI_AVEncCommonMeanBitRate, CODECAPI_AVEncCommonRateControlMode,
    CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVEncMPVGOPSize,
    CODECAPI_AVEncSliceControlMode, CODECAPI_AVEncSliceControlSize,
    CODECAPI_AVEncVideoForceKeyFrame, CODECAPI_AVLowLatencyMode, ICodecAPI, IMFActivate,
    IMFAttributes, IMFDXGIDeviceManager, IMFMediaBuffer, IMFMediaType, IMFSample, IMFTransform,
    MFMediaType_Video, MFNominalRange_16_235, MFVideoFormat_H264, MFVideoFormat_NV12,
    MFVideoInterlace_Progressive, MFVideoPrimaries_BT709, MFVideoTransFunc_709,
    MFVideoTransferMatrix_BT709, MFSTARTUP_LITE, MFT_CATEGORY_VIDEO_ENCODER,
    MFT_OUTPUT_DATA_BUFFER, MFT_REGISTER_TYPE_INFO, MF_E_TRANSFORM_STREAM_CHANGE,
    MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
    MF_MT_MPEG2_PROFILE, MF_MT_MPEG_SEQUENCE_HEADER, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX,
    MF_VERSION,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED,
};
use windows::Win32::System::Performance::QueryPerformanceCounter;
use windows::Win32::System::Variant::VARIANT;

use crate::encode::h264_sps;
use crate::encode::{Codec, EncoderConfig};
use crate::ipc::Exit;

pub mod hw;
pub mod sw;

/// `nal_unit_type` of an IDR slice.
const NAL_IDR: u8 = 5;

/// Media Foundation's clock: 100 ns units.
const HNS_PER_SECOND: i64 = 10_000_000;

/// `CODECAPI_AVEncMPVGOPSize`: as long as the in-box encoder honours, so the
/// only keyframes in practice are the ones the session forces. Zero is not
/// "infinite" there — it means its default, an IDR every 30 frames — and from
/// 65535 up its rate control collapses: deltas of 5.9 KB against a 41.7 KB
/// target, measured at 720p30 and 10 Mbps. 30000 holds the rate, and is an IDR
/// every 8 minutes at 60 fps. NVIDIA's MFT takes it the same way.
const GOP_FRAMES: u32 = 30_000;

/// Everything that stops a Media Foundation rung encoding. Every variant means
/// this machine cannot encode on this rung, so they all exit 13 — and the
/// selector walks down to the next rung first.
#[derive(Debug, Error)]
pub enum MfError {
    #[error("media foundation is not present on this machine: {0}")]
    Missing(String),
    #[error("no {0} h.264 encoder on this machine")]
    NoEncoder(&'static str),
    #[error("{0:?} is not encoded on media foundation; h.264 only")]
    UnsupportedCodec(Codec),
    #[error(
        "h.264 tops out at {max_width}x{max_height} on this encoder; asked for {width}x{height}"
    )]
    UnsupportedSize {
        width: u32,
        height: u32,
        max_width: u32,
        max_height: u32,
    },
    #[error("{call} failed: {source}")]
    Api {
        call: &'static str,
        #[source]
        source: windows::core::Error,
    },
    #[error("nv12 convert: {0}")]
    Convert(#[from] crate::gpu::scale::ScaleError),
    #[error("frame carries no texture handle")]
    NoTexture,
    #[error(
        "the frame's texture belongs to another d3d11 device — the capture source was rebuilt"
    )]
    DeviceChanged,
    #[error(
        "frame is {got_width}x{got_height}, the encoder was opened for {want_width}x{want_height}"
    )]
    SizeChanged {
        got_width: u32,
        got_height: u32,
        want_width: u32,
        want_height: u32,
    },
    #[error("the encoder stopped answering: {0}")]
    Stalled(String),
    #[error("could not start the event pump: {0}")]
    Thread(std::io::Error),
}

impl MfError {
    /// The process exit code this failure maps to.
    pub const fn exit(&self) -> Exit {
        Exit::NoEncoder
    }
}

fn api(call: &'static str) -> impl FnOnce(windows::core::Error) -> MfError {
    move |source| MfError::Api { call, source }
}

fn check(hr: HRESULT, call: &'static str) -> Result<(), MfError> {
    hr.ok().map_err(api(call))
}

// ------------------------------------------------------------ mfplat.dll ---

type CreateFn = unsafe extern "system" fn(*mut *mut c_void) -> HRESULT;
type Enum2Fn = unsafe extern "system" fn(
    GUID,
    u32,
    *const MFT_REGISTER_TYPE_INFO,
    *const MFT_REGISTER_TYPE_INFO,
    *mut c_void,
    *mut *mut *mut c_void,
    *mut u32,
) -> HRESULT;

/// The free functions this backend calls, resolved once from mfplat.dll.
struct Mfplat {
    // kept for the process lifetime: every pointer below lives in it
    _library: libloading::Library,
    create_attributes: unsafe extern "system" fn(*mut *mut c_void, u32) -> HRESULT,
    create_media_type: CreateFn,
    create_sample: CreateFn,
    create_memory_buffer: unsafe extern "system" fn(u32, *mut *mut c_void) -> HRESULT,
    create_dxgi_surface_buffer:
        unsafe extern "system" fn(*const GUID, *mut c_void, u32, BOOL, *mut *mut c_void) -> HRESULT,
    create_dxgi_device_manager: unsafe extern "system" fn(*mut u32, *mut *mut c_void) -> HRESULT,
    enum2: Enum2Fn,
}

/// mfplat.dll, started, or why not. `MFStartup` runs once per process and is
/// never undone: the streamer's encoders come and go with its viewers.
fn mfplat() -> Result<&'static Mfplat, MfError> {
    static MFPLAT: OnceLock<Result<Mfplat, String>> = OnceLock::new();
    MFPLAT
        .get_or_init(load)
        .as_ref()
        .map_err(|e| MfError::Missing(e.clone()))
}

fn load() -> Result<Mfplat, String> {
    let path = crate::platform::process::system32("mfplat.dll");
    // SAFETY: loading a system library runs its initialisers, which is what
    // every media foundation client does.
    let library = unsafe { libloading::Library::new(&path) }.map_err(|e| format!("{path}: {e}"))?;
    // SAFETY: each symbol is resolved with the signature mfapi.h declares for
    // it, and the library moves into the result with the pointers.
    unsafe {
        let startup: unsafe extern "system" fn(u32, u32) -> HRESULT = *library
            .get(b"MFStartup\0")
            .map_err(|e| format!("MFStartup: {e}"))?;
        startup(MF_VERSION, MFSTARTUP_LITE)
            .ok()
            .map_err(|e| format!("MFStartup: {e}"))?;
        macro_rules! symbol {
            ($name:literal) => {
                *library
                    .get($name)
                    .map_err(|e| format!("{}: {e}", String::from_utf8_lossy($name)))?
            };
        }
        Ok(Mfplat {
            create_attributes: symbol!(b"MFCreateAttributes\0"),
            create_media_type: symbol!(b"MFCreateMediaType\0"),
            create_sample: symbol!(b"MFCreateSample\0"),
            create_memory_buffer: symbol!(b"MFCreateMemoryBuffer\0"),
            create_dxgi_surface_buffer: symbol!(b"MFCreateDXGISurfaceBuffer\0"),
            create_dxgi_device_manager: symbol!(b"MFCreateDXGIDeviceManager\0"),
            enum2: symbol!(b"MFTEnum2\0"),
            _library: library,
        })
    }
}

/// COM on the calling thread for as long as this lives, as the clipboard's
/// `Com` and audio's `ComThread` are: the multithreaded apartment, because
/// nothing here pumps messages and an asynchronous MFT is free-threaded. A
/// thread already in another apartment keeps it, and there is nothing to undo.
/// Every COM object made under it must be released before it drops, on the
/// thread that entered it.
struct Apartment(bool);

impl Apartment {
    fn enter() -> Self {
        // SAFETY: plain initialisation, undone in Drop when it succeeded.
        Self(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the CoInitializeEx that succeeded in `enter`.
            unsafe { CoUninitialize() };
        }
    }
}

impl Mfplat {
    fn attributes(&self) -> Result<IMFAttributes, MfError> {
        let mut raw = std::ptr::null_mut();
        // SAFETY: one out pointer, owned by the returned interface.
        check(
            unsafe { (self.create_attributes)(&mut raw, 1) },
            "MFCreateAttributes",
        )?;
        // SAFETY: a fresh reference from a successful call.
        Ok(unsafe { IMFAttributes::from_raw(raw) })
    }

    fn media_type(&self) -> Result<IMFMediaType, MfError> {
        let mut raw = std::ptr::null_mut();
        // SAFETY: one out pointer, owned by the returned interface.
        check(
            unsafe { (self.create_media_type)(&mut raw) },
            "MFCreateMediaType",
        )?;
        // SAFETY: a fresh reference from a successful call.
        Ok(unsafe { IMFMediaType::from_raw(raw) })
    }

    fn sample(&self) -> Result<IMFSample, MfError> {
        let mut raw = std::ptr::null_mut();
        // SAFETY: as above.
        check(unsafe { (self.create_sample)(&mut raw) }, "MFCreateSample")?;
        Ok(unsafe { IMFSample::from_raw(raw) })
    }

    fn memory_buffer(&self, len: u32) -> Result<IMFMediaBuffer, MfError> {
        let mut raw = std::ptr::null_mut();
        // SAFETY: as above.
        check(
            unsafe { (self.create_memory_buffer)(len, &mut raw) },
            "MFCreateMemoryBuffer",
        )?;
        Ok(unsafe { IMFMediaBuffer::from_raw(raw) })
    }

    /// A buffer over `texture`, which takes its own reference to it.
    fn surface_buffer(&self, texture: &ID3D11Texture2D) -> Result<IMFMediaBuffer, MfError> {
        let mut raw = std::ptr::null_mut();
        // SAFETY: the texture is alive for the call.
        check(
            unsafe {
                (self.create_dxgi_surface_buffer)(
                    &ID3D11Texture2D::IID,
                    texture.as_raw(),
                    0,
                    false.into(),
                    &mut raw,
                )
            },
            "MFCreateDXGISurfaceBuffer",
        )?;
        Ok(unsafe { IMFMediaBuffer::from_raw(raw) })
    }

    fn device_manager(&self) -> Result<(IMFDXGIDeviceManager, u32), MfError> {
        let mut token = 0u32;
        let mut raw = std::ptr::null_mut();
        // SAFETY: two out parameters, both owned here.
        check(
            unsafe { (self.create_dxgi_device_manager)(&mut token, &mut raw) },
            "MFCreateDXGIDeviceManager",
        )?;
        Ok((unsafe { IMFDXGIDeviceManager::from_raw(raw) }, token))
    }

    /// The H.264 encoders `flags` selects, best first, restricted to one
    /// adapter when `attributes` names one.
    fn encoders(
        &self,
        flags: i32,
        attributes: Option<&IMFAttributes>,
    ) -> Result<Vec<IMFActivate>, MfError> {
        let output = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: MFVideoFormat_H264,
        };
        let mut array: *mut *mut c_void = std::ptr::null_mut();
        let mut count = 0u32;
        // SAFETY: the type info and the attributes outlive the call; the array
        // and every element in it are taken over below.
        check(
            unsafe {
                (self.enum2)(
                    MFT_CATEGORY_VIDEO_ENCODER,
                    flags as u32,
                    std::ptr::null(),
                    &output,
                    attributes.map_or(std::ptr::null_mut(), Interface::as_raw),
                    &mut array,
                    &mut count,
                )
            },
            "MFTEnum2",
        )?;
        let mut found = Vec::with_capacity(count as usize);
        if !array.is_null() {
            for index in 0..count as usize {
                // SAFETY: `count` references, each now owned here.
                let raw = unsafe { *array.add(index) };
                if !raw.is_null() {
                    found.push(unsafe { IMFActivate::from_raw(raw) });
                }
            }
            // SAFETY: the array itself was CoTaskMemAlloc'd by MFTEnum2.
            unsafe { CoTaskMemFree(Some(array as *const c_void)) };
        }
        Ok(found)
    }
}

// ----------------------------------------------------------- media types ---

fn pack(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

fn video_type(
    mf: &Mfplat,
    subtype: &GUID,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<IMFMediaType, MfError> {
    let media = mf.media_type()?;
    // SAFETY: plain attribute writes on a type this function owns. The colour
    // is the GPU convert's, declared on both types so an encoder that writes a
    // vui colour description writes this one.
    unsafe {
        media
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(api("MF_MT_MAJOR_TYPE"))?;
        media
            .SetGUID(&MF_MT_SUBTYPE, subtype)
            .map_err(api("MF_MT_SUBTYPE"))?;
        media
            .SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))
            .map_err(api("MF_MT_FRAME_SIZE"))?;
        media
            .SetUINT64(&MF_MT_FRAME_RATE, pack(fps.max(1), 1))
            .map_err(api("MF_MT_FRAME_RATE"))?;
        media
            .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))
            .map_err(api("MF_MT_PIXEL_ASPECT_RATIO"))?;
        media
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(api("MF_MT_INTERLACE_MODE"))?;
        media
            .SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)
            .map_err(api("MF_MT_VIDEO_NOMINAL_RANGE"))?;
        media
            .SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)
            .map_err(api("MF_MT_YUV_MATRIX"))?;
        media
            .SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)
            .map_err(api("MF_MT_VIDEO_PRIMARIES"))?;
        media
            .SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)
            .map_err(api("MF_MT_TRANSFER_FUNCTION"))?;
    }
    Ok(media)
}

/// Both types on `transform`, output first: an encoder MFT derives the input
/// types it offers from its output type.
fn set_types(
    mf: &Mfplat,
    transform: &IMFTransform,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_bps: u32,
    profile: i32,
) -> Result<(), MfError> {
    let output = video_type(mf, &MFVideoFormat_H264, width, height, fps)?;
    // SAFETY: plain attribute writes, then the transform copies both types.
    unsafe {
        output
            .SetUINT32(&MF_MT_AVG_BITRATE, bitrate_bps)
            .map_err(api("MF_MT_AVG_BITRATE"))?;
        output
            .SetUINT32(&MF_MT_MPEG2_PROFILE, profile as u32)
            .map_err(api("MF_MT_MPEG2_PROFILE"))?;
        transform
            .SetOutputType(0, &output, 0)
            .map_err(api("SetOutputType"))?;
        let input = video_type(mf, &MFVideoFormat_NV12, width, height, fps)?;
        transform
            .SetInputType(0, &input, 0)
            .map_err(api("SetInputType"))
    }
}

/// The current output type's SPS and PPS, for an encoder that does not repeat
/// them in band. Empty when it has none.
fn sequence_header(transform: &IMFTransform) -> Vec<u8> {
    // SAFETY: reads into a buffer sized by the call before it.
    unsafe {
        let Ok(media) = transform.GetOutputCurrentType(0) else {
            return Vec::new();
        };
        let Ok(len) = media.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) else {
            return Vec::new();
        };
        let mut blob = vec![0u8; len as usize];
        if media
            .GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut blob, None)
            .is_err()
        {
            return Vec::new();
        }
        blob
    }
}

// ------------------------------------------------------------- codec api ---

/// One frame of buffer, floored at 1/60 s worth — NVENC's rule (plan.md D7),
/// for the same reason: below that an I-frame cannot fit its own budget and
/// the rate controller thrashes.
fn buffer_bits(bitrate_bps: u32, fps: u32) -> u32 {
    (bitrate_bps / fps.max(1)).max(bitrate_bps / 60)
}

/// The low-latency configuration, set before the types: several encoders read
/// rate control only then. Each property an encoder refuses is named in the
/// log, as VideoToolbox's are, and none stops a session — the alternative on a
/// machine without NVENC is no session at all. `extra` is the rung's own.
fn configure(
    codec: &ICodecAPI,
    cfg: &EncoderConfig,
    fps: u32,
    backend: &str,
    extra: Vec<(GUID, VARIANT, &'static str)>,
) {
    let macroblocks = cfg.width.div_ceil(16) * cfg.height.div_ceil(16);
    let mut settings: Vec<(GUID, VARIANT, &'static str)> = vec![
        (
            CODECAPI_AVLowLatencyMode,
            VARIANT::from(true),
            "low latency",
        ),
        (
            CODECAPI_AVEncCommonRateControlMode,
            VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32),
            "cbr",
        ),
        (
            CODECAPI_AVEncCommonMeanBitRate,
            VARIANT::from(cfg.bitrate_bps),
            "bitrate",
        ),
        (
            CODECAPI_AVEncCommonBufferSize,
            VARIANT::from(buffer_bits(cfg.bitrate_bps, fps)),
            "one-frame buffer",
        ),
        (
            CODECAPI_AVEncMPVDefaultBPictureCount,
            VARIANT::from(0u32),
            "no b-frames",
        ),
        (
            CODECAPI_AVEncMPVGOPSize,
            VARIANT::from(GOP_FRAMES),
            "long gop",
        ),
        // one slice holding every macroblock: a lost slice is a hard decode
        // failure in current chrome
        (
            CODECAPI_AVEncSliceControlMode,
            VARIANT::from(0u32),
            "slice by macroblocks",
        ),
        (
            CODECAPI_AVEncSliceControlSize,
            VARIANT::from(macroblocks),
            "one slice",
        ),
    ];
    settings.extend(extra);
    let refused: Vec<&str> = settings
        .iter()
        // SAFETY: each value is alive for its call.
        .filter(|(key, value, _)| unsafe { codec.SetValue(key, value) }.is_err())
        .map(|(_, _, name)| *name)
        .collect();
    if refused.is_empty() {
        ::log::info!("swoop: {backend} took every low-latency setting");
    } else {
        ::log::info!("swoop: {backend} refused: {}", refused.join(", "));
    }
}

/// Move the CBR target without an IDR. The buffer follows the rate where the
/// encoder lets it; one that refuses keeps the buffer it opened with.
fn retarget(codec: &ICodecAPI, bitrate_bps: u32, fps: u32) -> Result<(), MfError> {
    // SAFETY: the values are alive for each call.
    unsafe {
        codec
            .SetValue(
                &CODECAPI_AVEncCommonMeanBitRate,
                &VARIANT::from(bitrate_bps),
            )
            .map_err(api("CODECAPI_AVEncCommonMeanBitRate"))?;
        let _ = codec.SetValue(
            &CODECAPI_AVEncCommonBufferSize,
            &VARIANT::from(buffer_bits(bitrate_bps, fps)),
        );
    }
    Ok(())
}

/// Ask for an IDR on the next input.
fn force_keyframe(codec: &ICodecAPI) -> Result<(), MfError> {
    // SAFETY: the value is alive for the call.
    unsafe { codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32)) }
        .map_err(api("CODECAPI_AVEncVideoForceKeyFrame"))
}

// ----------------------------------------------------------------- output ---

/// The bytes of one output sample, and its time.
fn read_sample(sample: &IMFSample) -> Result<(Vec<u8>, i64), MfError> {
    // SAFETY: the buffer is locked for exactly the copy and unlocked after it.
    unsafe {
        let time = sample.GetSampleTime().unwrap_or(0);
        let buffer = sample
            .ConvertToContiguousBuffer()
            .map_err(api("ConvertToContiguousBuffer"))?;
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut len = 0u32;
        buffer
            .Lock(&mut data, None, Some(&mut len))
            .map_err(api("IMFMediaBuffer::Lock"))?;
        let bytes = std::slice::from_raw_parts(data, len as usize).to_vec();
        let _ = buffer.Unlock();
        Ok((bytes, time))
    }
}

/// One `ProcessOutput`. `Ok(None)` when the encoder changed its output type —
/// taken here, so the caller asks again. `allocate` is the sample size for an
/// encoder that writes into the caller's sample, `None` for one that provides
/// its own.
fn process_output(
    mf: &Mfplat,
    transform: &IMFTransform,
    allocate: Option<u32>,
) -> Result<Option<IMFSample>, windows::core::Error> {
    let provided = match allocate {
        Some(len) => {
            let sample = mf.sample().map_err(into_win)?;
            let buffer = mf.memory_buffer(len).map_err(into_win)?;
            // SAFETY: the sample takes its own reference to the buffer.
            unsafe { sample.AddBuffer(&buffer) }?;
            Some(sample)
        }
        None => None,
    };
    let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
        dwStreamID: 0,
        pSample: ManuallyDrop::new(provided),
        dwStatus: 0,
        pEvents: ManuallyDrop::new(None),
    }];
    let mut status = 0u32;
    // SAFETY: one stream, one buffer struct, owned here.
    let result = unsafe { transform.ProcessOutput(0, &mut buffers, &mut status) };
    // SAFETY: both fields are taken exactly once whatever the call returned:
    // the struct does not release them itself.
    let sample = unsafe { ManuallyDrop::take(&mut buffers[0].pSample) };
    drop(unsafe { ManuallyDrop::take(&mut buffers[0].pEvents) });
    match result {
        Ok(()) => Ok(sample),
        Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
            // SAFETY: the offered type goes straight back to the transform.
            unsafe {
                let offered = transform.GetOutputAvailableType(0, 0)?;
                transform.SetOutputType(0, &offered, 0)?;
            }
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

fn into_win(e: MfError) -> windows::core::Error {
    match e {
        MfError::Api { source, .. } => source,
        other => windows::core::Error::new(windows::Win32::Foundation::E_FAIL, other.to_string()),
    }
}

/// The SPS as it goes on the wire: unchanged when it already declares no
/// reordering, rewritten when it does not, and as it came when it cannot be
/// read — a stream that decodes late beats no stream.
fn restricted(sps: &[u8]) -> Cow<'_, [u8]> {
    match h264_sps::parse(sps) {
        Some(parsed) if parsed.declares_no_reordering() => sps.into(),
        _ => h264_sps::with_restriction(sps).map_or(sps.into(), Into::into),
    }
}

/// One access unit as it goes on the wire, and whether it is an IDR: 4-byte
/// start codes, every SPS carrying the restriction, and an IDR without its own
/// parameter sets given the output type's.
fn assemble(data: &[u8], sequence_header: &[u8]) -> (Vec<u8>, bool) {
    let nals = h264_sps::nal_units(data);
    let is_irap = nals.iter().any(|(ty, _)| *ty == NAL_IDR);
    let has_sps = nals.iter().any(|(ty, _)| *ty == h264_sps::NAL_SPS);
    let mut out = Vec::with_capacity(data.len() + sequence_header.len() + 16);
    let mut push = |ty: u8, nal: &[u8]| {
        out.extend_from_slice(&[0, 0, 0, 1]);
        if ty == h264_sps::NAL_SPS {
            out.extend_from_slice(&restricted(nal));
        } else {
            out.extend_from_slice(nal);
        }
    };
    if is_irap && !has_sps {
        for (ty, range) in h264_sps::nal_units(sequence_header) {
            push(ty, &sequence_header[range]);
        }
    }
    for (ty, range) in nals {
        push(ty, &data[range]);
    }
    (out, is_irap)
}

fn qpc_now() -> i64 {
    let mut ticks = 0i64;
    // SAFETY: writes one i64; a zero is a timestamp, not a crash.
    let _ = unsafe { QueryPerformanceCounter(&mut ticks) };
    ticks
}

/// The sample time of frame `frame_id` at `fps`, in Media Foundation's units.
fn sample_time(frame_id: u64, fps: u32) -> i64 {
    frame_id as i64 * HNS_PER_SECOND / i64::from(fps.max(1))
}

/// The codec and size checks every `create` makes before touching anything.
fn admit(cfg: &EncoderConfig, max_width: u32, max_height: u32) -> Result<(), MfError> {
    if cfg.codec != Codec::H264 {
        return Err(MfError::UnsupportedCodec(cfg.codec));
    }
    if cfg.width > max_width || cfg.height > max_height || cfg.width == 0 || cfg.height == 0 {
        return Err(MfError::UnsupportedSize {
            width: cfg.width,
            height: cfg.height,
            max_width,
            max_height,
        });
    }
    Ok(())
}

/// The frame's texture, borrowed: the capture source holds the reference and
/// `Frame` does not transfer it. `raw` is a binding in the caller so the
/// reference outlives it.
fn texture_of(raw: &*mut c_void) -> Result<&ID3D11Texture2D, MfError> {
    // SAFETY: as above.
    unsafe { ID3D11Texture2D::from_raw_borrowed(raw) }.ok_or(MfError::NoTexture)
}

/// What the two rungs' hardware tests share: a device shaped like the
/// capture's, screen-like frames, and the reading of what came out.
#[cfg(test)]
mod testkit {
    use std::time::Duration;

    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_11_0,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
        D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
        D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

    use super::{h264_sps, NAL_IDR};
    use crate::encode::h264_sps::nal_units;

    /// A hardware device created the way capture creates its own: BGRA support
    /// and nothing else, so a session that needs more fails here first.
    pub fn device() -> ID3D11Device {
        device_of(D3D_DRIVER_TYPE_HARDWARE)
    }

    /// WARP: what a virtual machine or a box with no GPU renders on.
    pub fn warp() -> ID3D11Device {
        device_of(D3D_DRIVER_TYPE_WARP)
    }

    fn device_of(driver: D3D_DRIVER_TYPE) -> ID3D11Device {
        let mut device = None;
        // SAFETY: every out parameter is owned here.
        unsafe {
            D3D11CreateDevice(
                None,
                driver,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        }
        .expect("a d3d11 device");
        device.expect("D3D11CreateDevice returned a device")
    }

    /// `count` BGRA frames of screen-like content that changes every frame: a
    /// noise field rate control has to spend on, a text-like panel, and a
    /// block that moves. Fixed seeds, so every run encodes the same pictures.
    pub fn frames(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        count: u32,
    ) -> Vec<ID3D11Texture2D> {
        let (w, h) = (width as usize, height as usize);
        (0..count)
            .map(|phase| {
                let mut px = vec![0u8; w * h * 4];
                let mut seed = 0x1234_5678u32.wrapping_add(phase.wrapping_mul(0x9e37_79b9));
                for y in 0..h {
                    for x in 0..w {
                        let i = (y * w + x) * 4;
                        let (b, g, r) = if x < w / 2 {
                            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                            let n = (seed >> 24) as u8;
                            (
                                n / 3 + (x * 200 / w) as u8,
                                n / 3 + (y * 160 / h) as u8,
                                n / 2,
                            )
                        } else if y % 19 < 2 && !(x / 7 + phase as usize).is_multiple_of(11) {
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
                let (bw, bh) = (w / 6, h / 6);
                let bx = (phase as usize * 37) % (w - bw);
                for y in h / 3..h / 3 + bh {
                    for x in bx..bx + bw {
                        let i = (y * w + x) * 4;
                        px[i..i + 3].copy_from_slice(&[0x10, 0x60, 0xc0]);
                    }
                }
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
                    pSysMem: px.as_ptr().cast(),
                    SysMemPitch: width * 4,
                    SysMemSlicePitch: 0,
                };
                let mut texture = None;
                // SAFETY: the description and the pixels outlive the call.
                unsafe { device.CreateTexture2D(&desc, Some(&init), Some(&mut texture)) }
                    .expect("a test frame");
                texture.expect("CreateTexture2D returned a texture")
            })
            .collect()
    }

    /// The `p`th percentile, in milliseconds.
    pub fn percentile(samples: &[Duration], p: f64) -> f64 {
        let mut sorted: Vec<f64> = samples.iter().map(|d| d.as_secs_f64() * 1e3).collect();
        sorted.sort_by(f64::total_cmp);
        let at = ((sorted.len() as f64 - 1.0) * p).round() as usize;
        sorted.get(at).copied().unwrap_or(f64::NAN)
    }

    /// What one access unit carries: its coded slices, and its SPS as sent.
    pub fn read_unit(data: &[u8]) -> (usize, Option<(Vec<u8>, h264_sps::Sps)>) {
        let nals = nal_units(data);
        let slices = nals
            .iter()
            .filter(|(ty, _)| (1..=NAL_IDR).contains(ty))
            .count();
        let sps = nals
            .iter()
            .find(|(ty, _)| *ty == h264_sps::NAL_SPS)
            .and_then(|(_, range)| {
                h264_sps::parse(&data[range.clone()]).map(|sps| (data[range.clone()].to_vec(), sps))
            });
        (slices, sps)
    }

    /// What an encoder advertises about long-term reference frames, for the
    /// record only — LTR is deferred: `CODECAPI_AVEncVideoSupportedControls`
    /// and the range `CODECAPI_AVEncVideoLTRBufferControl` takes.
    pub fn ltr(codec: &windows::Win32::Media::MediaFoundation::ICodecAPI) -> String {
        use windows::Win32::Media::MediaFoundation::{
            CODECAPI_AVEncVideoLTRBufferControl, CODECAPI_AVEncVideoSupportedControls,
        };
        use windows::Win32::System::Variant::VARIANT;
        let number = |value: &VARIANT| {
            u32::try_from(value)
                .map(|v| format!("0x{v:x}"))
                .or_else(|_| u64::try_from(value).map(|v| format!("0x{v:x}")))
                .unwrap_or_else(|_| format!("{:?}", value.vt()))
        };
        // SAFETY: queries into locals; nothing is set.
        unsafe {
            let controls = match codec.GetValue(&CODECAPI_AVEncVideoSupportedControls) {
                Ok(value) => number(&value),
                Err(e) => format!("not supported ({:?})", e.code()),
            };
            let (mut min, mut max, mut step) =
                (VARIANT::default(), VARIANT::default(), VARIANT::default());
            let buffer = match codec.GetParameterRange(
                &CODECAPI_AVEncVideoLTRBufferControl,
                &mut min,
                &mut max,
                &mut step,
            ) {
                Ok(()) => format!("{}..{}", number(&min), number(&max)),
                Err(e) => match codec.IsSupported(&CODECAPI_AVEncVideoLTRBufferControl) {
                    Ok(()) => format!("supported, no range ({:?})", e.code()),
                    Err(e) => format!("not supported ({:?})", e.code()),
                },
            };
            format!("supported controls {controls}; ltr buffer control {buffer}")
        }
    }

    /// Append access units to `MF_ANNEXB_DIR/<name>` when the variable is
    /// set: the bitstream the Chrome decode check reads.
    pub fn keep(name: &str, units: &[Vec<u8>]) {
        let Some(dir) = std::env::var_os("MF_ANNEXB_DIR") else {
            return;
        };
        let path = std::path::Path::new(&dir).join(name);
        std::fs::write(&path, units.concat()).expect("the annex-b file is written");
        println!("  wrote {} access units to {}", units.len(), path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde::Deserialize;

    use crate::encode::h264_sps::nal_units;

    fn base() -> EncoderConfig {
        EncoderConfig {
            codec: Codec::H264,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_bps: 20_000_000,
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        name: String,
        /// The SPS NAL unit, header byte included, as the encoder emitted it.
        sps: String,
        restriction_declared: bool,
    }

    /// SPS units Media Foundation's encoders emitted on the spike 6.7 box,
    /// printed by the ignored hardware tests, and one that needs the rewrite.
    fn vectors() -> Vec<Vector> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/encode/mf-h264-sps.json");
        let raw = std::fs::read_to_string(&path).expect("the mf golden vectors are readable");
        serde_json::from_str::<Vectors>(&raw)
            .expect("the mf golden vectors parse")
            .vectors
    }

    #[test]
    fn every_emitted_sps_goes_out_declaring_no_reordering() {
        let vectors = vectors();
        assert!(!vectors.is_empty());
        for vector in vectors {
            let sps = hex::decode(&vector.sps).expect("hex");
            let emitted = h264_sps::parse(&sps).expect("the emitted sps parses");
            assert_eq!(
                emitted.declares_no_reordering(),
                vector.restriction_declared,
                "{}: what the encoder itself declared",
                vector.name
            );

            let mut au = vec![0, 0, 0, 1];
            au.extend_from_slice(&sps);
            au.extend_from_slice(&[0, 0, 0, 1, 0x65, 0x88, 0x84]);
            let (wire, is_irap) = assemble(&au, &[]);
            assert!(is_irap, "{}", vector.name);
            let sent_bytes = nal_units(&wire)
                .into_iter()
                .find(|(ty, _)| *ty == h264_sps::NAL_SPS)
                .map(|(_, range)| wire[range].to_vec())
                .expect("the sps survives");
            if vector.restriction_declared {
                assert_eq!(sent_bytes, sps, "{}: sent as emitted", vector.name);
            }
            let sent = h264_sps::parse(&sent_bytes).expect("the wire sps parses");
            assert!(sent.declares_no_reordering(), "{}", vector.name);
            assert_eq!(sent.profile_idc, emitted.profile_idc, "{}", vector.name);
            assert_eq!(sent.level_idc, emitted.level_idc, "{}", vector.name);
            assert_eq!(
                sent.max_num_ref_frames, emitted.max_num_ref_frames,
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn an_idr_without_parameter_sets_is_given_the_sequence_header() {
        let header = [
            0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f, 0xe9, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
        ];
        let idr = [0, 0, 1, 0x65, 0x88, 0x84];
        let (wire, is_irap) = assemble(&idr, &header);
        assert!(is_irap);
        let types: Vec<u8> = nal_units(&wire).into_iter().map(|(ty, _)| ty).collect();
        assert_eq!(types, vec![7, 8, 5]);

        // a delta is never given one
        let delta = [0, 0, 1, 0x41, 0x9a, 0x02];
        let (wire, is_irap) = assemble(&delta, &header);
        assert!(!is_irap);
        let types: Vec<u8> = nal_units(&wire).into_iter().map(|(ty, _)| ty).collect();
        assert_eq!(types, vec![1]);
    }

    #[test]
    fn the_buffer_is_one_frame_floored_at_a_sixtieth() {
        assert_eq!(buffer_bits(20_000_000, 60), 20_000_000 / 60);
        assert_eq!(buffer_bits(20_000_000, 30), 20_000_000 / 30);
        assert_eq!(buffer_bits(20_000_000, 240), 20_000_000 / 60);
    }

    #[test]
    fn hevc_and_oversize_are_refused_before_anything_is_touched() {
        for (cfg, max) in [
            (
                EncoderConfig {
                    codec: Codec::H265,
                    ..base()
                },
                (4096, 4096),
            ),
            (
                EncoderConfig {
                    width: 4097,
                    ..base()
                },
                (4096, 4096),
            ),
            (base(), (1280, 720)),
        ] {
            let err = admit(&cfg, max.0, max.1).expect_err("refused");
            assert_eq!(err.exit().code(), 13, "{err}");
        }
        assert!(admit(&base(), 4096, 4096).is_ok());
    }

    #[test]
    fn sample_times_are_in_hundreds_of_nanoseconds() {
        assert_eq!(sample_time(0, 60), 0);
        assert_eq!(sample_time(60, 60), HNS_PER_SECOND);
        assert_eq!(sample_time(3, 30), 1_000_000);
    }
}
