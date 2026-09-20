//! A single NVENC encode session configured exactly the way plan.md D5/D7 says
//! the streamer will configure it, driven through `moq-nvenc`'s raw `sys` types
//! and its dlopen'd function table.
//!
//! Everything here is one-frame-at-a-time on purpose: submit one picture, wait
//! on the async completion event, lock the bitstream. That is "async encode
//! with depth 1" — the shape the streamer needs, and the only shape in which
//! "encode latency" means submit-to-output rather than throughput.

use std::ffi::c_void;
use std::time::{Duration, Instant};

use moq_nvenc::safe::ENCODE_API;
use moq_nvenc::sys::nvEncodeAPI::{
    NVENCAPI_VERSION, NVENCSTATUS, NVENC_INFINITE_GOPLENGTH, NV_ENC_BUFFER_FORMAT,
    NV_ENC_BUFFER_USAGE, NV_ENC_CODEC_CONFIG,
    NV_ENC_CODEC_H264_GUID, NV_ENC_CODEC_HEVC_GUID, NV_ENC_CONFIG, NV_ENC_CONFIG_VER,
    NV_ENC_CREATE_BITSTREAM_BUFFER, NV_ENC_CREATE_BITSTREAM_BUFFER_VER, NV_ENC_DEVICE_TYPE,
    NV_ENC_EVENT_PARAMS, NV_ENC_EVENT_PARAMS_VER, NV_ENC_H264_ENTROPY_CODING_MODE,
    NV_ENC_H264_PROFILE_HIGH_GUID, NV_ENC_HEVC_PROFILE_MAIN_GUID, NV_ENC_INITIALIZE_PARAMS,
    NV_ENC_INITIALIZE_PARAMS_VER, NV_ENC_INPUT_RESOURCE_TYPE,
    NV_ENC_LOCK_BITSTREAM, NV_ENC_LOCK_BITSTREAM_VER, NV_ENC_MAP_INPUT_RESOURCE,
    NV_ENC_MAP_INPUT_RESOURCE_VER, NV_ENC_MULTI_PASS, NV_ENC_NUM_REF_FRAMES,
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
    NV_ENC_OUTPUT_PTR, NV_ENC_PARAMS_RC_MODE, NV_ENC_PIC_FLAGS, NV_ENC_PIC_PARAMS,
    NV_ENC_PIC_PARAMS_VER, NV_ENC_PIC_STRUCT, NV_ENC_PRESET_CONFIG,
    NV_ENC_PRESET_CONFIG_VER, NV_ENC_PRESET_P1_GUID, NV_ENC_RECONFIGURE_PARAMS,
    NV_ENC_RECONFIGURE_PARAMS_VER, NV_ENC_REGISTERED_PTR, NV_ENC_REGISTER_RESOURCE,
    NV_ENC_REGISTER_RESOURCE_VER, NV_ENC_TUNING_INFO,
};
use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use crate::clock::qpc;
use crate::nal::Codec;

/// The settings under test. Everything else is fixed by `Session::open` because
/// plan.md fixes it.
#[derive(Clone, Copy, Debug)]
pub struct EncoderConfig {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_bps: u32,
    /// Measurement 1's independent variable: emit the VUI bitstream-restriction
    /// block (which is how `max_num_reorder_frames = 0` reaches the decoder) or
    /// leave it out, which is the NVENC default.
    pub bitstream_restriction: bool,
}

/// One encoded picture plus the timings taken around it.
pub struct Encoded {
    pub data: Vec<u8>,
    /// Submit to output available: `nvEncEncodePicture` to the async completion
    /// event signalling.
    pub encode: Duration,
    /// Map, submit, wait, lock, copy, unlock, unmap — the whole host-side cost
    /// of one frame.
    pub total: Duration,
    /// `QueryPerformanceCounter` immediately before `nvEncEncodePicture`.
    pub submit_qpc: i64,
    /// `QueryPerformanceCounter` immediately after the bitstream was locked.
    ///
    /// These two travel to the browser in [`crate::sink::HostStamps`]; the
    /// `Duration`s above never leave the host, because the browser has no
    /// `Instant`.
    pub done_qpc: i64,
}

pub type Result<T> = std::result::Result<T, String>;

fn check(status: NVENCSTATUS, what: &str) -> Result<()> {
    if status == NVENCSTATUS::NV_ENC_SUCCESS {
        Ok(())
    } else {
        Err(format!("{what} failed: {status:?}"))
    }
}

pub struct Session {
    encoder: *mut c_void,
    /// `None` in synchronous mode.
    event: Option<HANDLE>,
    bitstream: NV_ENC_OUTPUT_PTR,
    registered: Vec<NV_ENC_REGISTERED_PTR>,
    /// Boxed so `init.encodeConfig` stays valid for the session's whole life;
    /// `NvEncReconfigureEncoder` reads through that pointer again.
    config: Box<NV_ENC_CONFIG>,
    init: NV_ENC_INITIALIZE_PARAMS,
    cfg: EncoderConfig,
}

impl Session {
    /// Open and initialise a session on `device`, applying the whole plan.md
    /// D5/D7 configuration.
    pub fn open(device: &ID3D11Device, cfg: EncoderConfig) -> Result<Self> {
        let codec_guid = match cfg.codec {
            Codec::H264 => NV_ENC_CODEC_H264_GUID,
            Codec::Hevc => NV_ENC_CODEC_HEVC_GUID,
        };

        let mut encoder: *mut c_void = std::ptr::null_mut();
        let mut open = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
            version: NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
            deviceType: NV_ENC_DEVICE_TYPE::NV_ENC_DEVICE_TYPE_DIRECTX,
            device: device.as_raw(),
            apiVersion: NVENCAPI_VERSION,
            ..Default::default()
        };
        check(
            unsafe { (ENCODE_API.open_encode_session_ex)(&mut open, &mut encoder) },
            "nvEncOpenEncodeSessionEx",
        )?;

        // Start from the preset's own configuration: setting a preset +
        // tuning info auto-configures everything we do not name, which is the
        // SDK's intended usage (prog guide §3.3).
        let mut preset = NV_ENC_PRESET_CONFIG {
            version: NV_ENC_PRESET_CONFIG_VER,
            presetCfg: NV_ENC_CONFIG {
                version: NV_ENC_CONFIG_VER,
                ..Default::default()
            },
            ..Default::default()
        };
        check(
            unsafe {
                (ENCODE_API.get_encode_preset_config_ex)(
                    encoder,
                    codec_guid,
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
            Codec::Hevc => NV_ENC_HEVC_PROFILE_MAIN_GUID,
        };
        // Infinite GOP: the streamer decides when a keyframe happens, never a
        // timer. No B-frames: frameIntervalP = 1 means IPPP.
        config.gopLength = NVENC_INFINITE_GOPLENGTH;
        config.frameIntervalP = 1;

        apply_rate_control(&mut config, &cfg);
        apply_codec_config(&mut config, &cfg);

        let mut init = NV_ENC_INITIALIZE_PARAMS {
            version: NV_ENC_INITIALIZE_PARAMS_VER,
            encodeGUID: codec_guid,
            presetGUID: NV_ENC_PRESET_P1_GUID,
            encodeWidth: cfg.width,
            encodeHeight: cfg.height,
            darWidth: cfg.width,
            darHeight: cfg.height,
            frameRateNum: cfg.fps,
            frameRateDen: 1,
            // Async mode: wait on a Win32 event instead of blocking in lock.
            enableEncodeAsync: 1,
            // Let NVENC decide picture types; with frameIntervalP = 1 and an
            // infinite GOP that is always P except where we force an IDR.
            enablePTD: 1,
            maxEncodeWidth: cfg.width,
            maxEncodeHeight: cfg.height,
            tuningInfo: NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
            bufferFormat: NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_ARGB,
            ..Default::default()
        };
        init.encodeConfig = Box::as_mut(&mut config) as *mut NV_ENC_CONFIG;

        check(
            unsafe { (ENCODE_API.initialize_encoder)(encoder, &mut init) },
            "nvEncInitializeEncoder",
        )?;

        let event = {
            // SAFETY: a manual-reset=false, initial-state=false, unnamed event.
            let handle = unsafe { CreateEventW(None, false, false, None) }
                .map_err(|e| format!("CreateEventW failed: {e}"))?;
            let mut event_params = NV_ENC_EVENT_PARAMS {
                version: NV_ENC_EVENT_PARAMS_VER,
                completionEvent: handle.0,
                ..Default::default()
            };
            check(
                unsafe { (ENCODE_API.register_async_event)(encoder, &mut event_params) },
                "nvEncRegisterAsyncEvent",
            )?;
            Some(handle)
        };

        let mut create_bitstream = NV_ENC_CREATE_BITSTREAM_BUFFER {
            version: NV_ENC_CREATE_BITSTREAM_BUFFER_VER,
            ..Default::default()
        };
        check(
            unsafe { (ENCODE_API.create_bitstream_buffer)(encoder, &mut create_bitstream) },
            "nvEncCreateBitstreamBuffer",
        )?;

        Ok(Self {
            encoder,
            event,
            bitstream: create_bitstream.bitstreamBuffer,
            registered: Vec::new(),
            config,
            init,
            cfg,
        })
    }

    /// Register a BGRA texture as an input resource. Returns its index for
    /// `encode`. Registration is done once up front so the per-frame path is
    /// map / encode / unmap, as it will be in the streamer.
    pub fn register_texture(&mut self, texture: &ID3D11Texture2D) -> Result<usize> {
        let mut reg = NV_ENC_REGISTER_RESOURCE {
            version: NV_ENC_REGISTER_RESOURCE_VER,
            resourceType: NV_ENC_INPUT_RESOURCE_TYPE::NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX,
            width: self.cfg.width,
            height: self.cfg.height,
            pitch: 0,
            resourceToRegister: texture.as_raw(),
            bufferFormat: NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_ARGB,
            bufferUsage: NV_ENC_BUFFER_USAGE::NV_ENC_INPUT_IMAGE,
            ..Default::default()
        };
        check(
            unsafe { (ENCODE_API.register_resource)(self.encoder, &mut reg) },
            "nvEncRegisterResource",
        )?;
        self.registered.push(reg.registeredResource);
        Ok(self.registered.len() - 1)
    }

    /// Encode one registered texture. `force_idr` carries
    /// `NV_ENC_PIC_FLAG_FORCEIDR`, which is the request side of measurement 2.
    pub fn encode(&mut self, index: usize, force_idr: bool, timestamp: u64) -> Result<Encoded> {
        let registered = *self
            .registered
            .get(index)
            .ok_or_else(|| format!("input resource {index} is not registered"))?;

        let t_start = Instant::now();
        let mut map = NV_ENC_MAP_INPUT_RESOURCE {
            version: NV_ENC_MAP_INPUT_RESOURCE_VER,
            registeredResource: registered,
            ..Default::default()
        };
        check(
            unsafe { (ENCODE_API.map_input_resource)(self.encoder, &mut map) },
            "nvEncMapInputResource",
        )?;

        let mut pic = NV_ENC_PIC_PARAMS {
            version: NV_ENC_PIC_PARAMS_VER,
            inputWidth: self.cfg.width,
            inputHeight: self.cfg.height,
            inputPitch: self.cfg.width,
            encodePicFlags: if force_idr {
                NV_ENC_PIC_FLAGS::NV_ENC_PIC_FLAG_FORCEIDR as u32
            } else {
                0
            },
            inputTimeStamp: timestamp,
            inputBuffer: map.mappedResource,
            outputBitstream: self.bitstream,
            completionEvent: self.event.map_or(std::ptr::null_mut(), |e| e.0),
            bufferFmt: NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_ARGB,
            pictureStruct: NV_ENC_PIC_STRUCT::NV_ENC_PIC_STRUCT_FRAME,
            ..Default::default()
        };

        let t_submit = Instant::now();
        let submit_qpc = qpc();
        let status = unsafe { (ENCODE_API.encode_picture)(self.encoder, &mut pic) };
        let encode_result = check(status, "nvEncEncodePicture").and_then(|()| {
            // With enablePTD = 1, no B-frames and no lookahead, every submitted
            // picture produces output, so a wait is always correct here.
            // In synchronous mode there is no event: nvEncLockBitstream below
            // blocks instead, and the timer stops after it returns.
            if let Some(event) = self.event {
                let wait = unsafe { WaitForSingleObject(event, 20_000) };
                if wait != WAIT_OBJECT_0 {
                    return Err(format!("async completion event wait returned {wait:?}"));
                }
            }
            Ok(())
        });

        if let Err(e) = encode_result {
            let _ = unsafe { (ENCODE_API.unmap_input_resource)(self.encoder, map.mappedResource) };
            return Err(e);
        }

        let mut lock = NV_ENC_LOCK_BITSTREAM {
            version: NV_ENC_LOCK_BITSTREAM_VER,
            outputBitstream: self.bitstream,
            ..Default::default()
        };
        check(
            unsafe { (ENCODE_API.lock_bitstream)(self.encoder, &mut lock) },
            "nvEncLockBitstream",
        )?;
        let encode = t_submit.elapsed();
        let done_qpc = qpc();
        let data = unsafe {
            std::slice::from_raw_parts(
                lock.bitstreamBufferPtr.cast::<u8>(),
                lock.bitstreamSizeInBytes as usize,
            )
        }
        .to_vec();
        check(
            unsafe { (ENCODE_API.unlock_bitstream)(self.encoder, self.bitstream) },
            "nvEncUnlockBitstream",
        )?;
        check(
            unsafe { (ENCODE_API.unmap_input_resource)(self.encoder, map.mappedResource) },
            "nvEncUnmapInputResource",
        )?;

        Ok(Encoded {
            data,
            encode,
            total: t_start.elapsed(),
            submit_qpc,
            done_qpc,
        })
    }

    /// Change the target bitrate in place: `NvEncReconfigureEncoder` with
    /// `resetEncoder = 0` and `forceIDR = 0`, which is measurement 3's claim —
    /// a rate change that does not cost a keyframe. The one-frame VBV moves
    /// with the bitrate, or the new rate would be clamped by the old buffer.
    pub fn reconfigure_bitrate(&mut self, bitrate_bps: u32) -> Result<()> {
        self.cfg.bitrate_bps = bitrate_bps;
        apply_rate_control(&mut self.config, &self.cfg);

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
        check(
            unsafe { (ENCODE_API.reconfigure_encoder)(self.encoder, &mut params) },
            "nvEncReconfigureEncoder",
        )
    }

}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            for &resource in &self.registered {
                let _ = (ENCODE_API.unregister_resource)(self.encoder, resource);
            }
            let _ = (ENCODE_API.destroy_bitstream_buffer)(self.encoder, self.bitstream);
            if let Some(event) = self.event {
                let mut event_params = NV_ENC_EVENT_PARAMS {
                    version: NV_ENC_EVENT_PARAMS_VER,
                    completionEvent: event.0,
                    ..Default::default()
                };
                let _ = (ENCODE_API.unregister_async_event)(self.encoder, &mut event_params);
                let _ = CloseHandle(event);
            }
            let _ = (ENCODE_API.destroy_encoder)(self.encoder);
        }
    }
}

/// CBR with a one-frame VBV, no lookahead, no adaptive quantisation, and
/// `zeroReorderDelay` so the encoder never holds output back.
fn apply_rate_control(config: &mut NV_ENC_CONFIG, cfg: &EncoderConfig) {
    let rc = &mut config.rcParams;
    rc.rateControlMode = NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CBR;
    rc.averageBitRate = cfg.bitrate_bps;
    rc.maxBitRate = cfg.bitrate_bps;
    // One frame of VBV, floored at 1/60 s worth: below that a single I-frame
    // cannot fit its own budget and the rate controller thrashes.
    let one_frame = cfg.bitrate_bps / cfg.fps.max(1);
    let floor = cfg.bitrate_bps / 60;
    rc.vbvBufferSize = one_frame.max(floor);
    rc.vbvInitialDelay = rc.vbvBufferSize;
    // Spike 0.9 measurement 6b: two-pass quarter resolution costs a consistent
    // 1.7 ms p50 and is the only configuration that reaches the requested
    // bitrate — single-pass CBR with a one-frame VBV undershoots by 30 %.
    rc.multiPass = NV_ENC_MULTI_PASS::NV_ENC_TWO_PASS_QUARTER_RESOLUTION;
    rc.lowDelayKeyFrameScale = 1;
    rc.lookaheadDepth = 0;
    rc.set_enableLookahead(0);
    rc.set_zeroReorderDelay(1);
    rc.set_enableAQ(0);
    rc.set_enableTemporalAQ(0);
    rc.set_enableNonRefP(0);
}

/// Per-codec settings: single slice, parameter sets repeated with every IRAP,
/// a 4-frame DPB with one reference, no intra refresh, and — for H.264 — the
/// VUI bitstream-restriction flag under test.
fn apply_codec_config(config: &mut NV_ENC_CONFIG, cfg: &EncoderConfig) {
    let codec: &mut NV_ENC_CODEC_CONFIG = &mut config.encodeCodecConfig;
    match cfg.codec {
        Codec::H264 => {
            // SAFETY: the union is being written through the arm that matches
            // the codec GUID this session was opened with.
            let h264 = unsafe { &mut codec.h264Config };
            // Level 0 = "NVENC picks". Spike 0.9 measurement 1: the level
            // sets the size of the no-VUI-fix penalty (4 frames at 4.2, 16 at
            // 5.1), which is why the fix matters more at 4K, not less.
            h264.level = 0;
            h264.idrPeriod = NVENC_INFINITE_GOPLENGTH;
            h264.maxNumRefFrames = 4;
            h264.numRefL0 = NV_ENC_NUM_REF_FRAMES::NV_ENC_NUM_REF_FRAMES_1;
            h264.entropyCodingMode =
                NV_ENC_H264_ENTROPY_CODING_MODE::NV_ENC_H264_ENTROPY_CODING_MODE_CABAC;
            // sliceMode 3 + sliceModeData 1 = "one slice per picture", the
            // setting review-1 F4 requires so a lost packet cannot produce a
            // damaged multi-slice picture that Chromium now hard-fails.
            h264.sliceMode = 3;
            h264.sliceModeData = 1;
            h264.set_repeatSPSPPS(1);
            h264.set_enableIntraRefresh(0);
            h264.set_outputBufferingPeriodSEI(0);
            h264.set_outputPictureTimingSEI(0);
            h264.set_outputAUD(0);
            h264.set_enableLTR(0);
            h264.set_enableFillerDataInsertion(0);
            let vui = &mut h264.h264VUIParameters;
            vui.bitstreamRestrictionFlag = u32::from(cfg.bitstream_restriction);
        }
        Codec::Hevc => {
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
            let vui = &mut hevc.hevcVUIParameters;
            vui.bitstreamRestrictionFlag = u32::from(cfg.bitstream_restriction);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> EncoderConfig {
        EncoderConfig {
            codec: Codec::H264,
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_bps: 20_000_000,
            bitstream_restriction: true,
        }
    }

    fn blank_config() -> NV_ENC_CONFIG {
        NV_ENC_CONFIG {
            version: NV_ENC_CONFIG_VER,
            ..Default::default()
        }
    }

    #[test]
    fn one_frame_vbv_tracks_the_bitrate() {
        let mut config = blank_config();
        apply_rate_control(&mut config, &base());
        assert_eq!(config.rcParams.vbvBufferSize, 20_000_000 / 60);
        assert_eq!(
            config.rcParams.vbvInitialDelay,
            config.rcParams.vbvBufferSize
        );
        assert_eq!(config.rcParams.averageBitRate, config.rcParams.maxBitRate);
    }

    #[test]
    fn vbv_never_falls_below_one_sixtieth_of_a_second() {
        let mut config = blank_config();
        let cfg = EncoderConfig { fps: 240, ..base() };
        apply_rate_control(&mut config, &cfg);
        assert_eq!(config.rcParams.vbvBufferSize, 20_000_000 / 60);
    }

    #[test]
    fn rate_control_is_cbr_with_no_lookahead() {
        let mut config = blank_config();
        apply_rate_control(&mut config, &base());
        assert_eq!(
            config.rcParams.rateControlMode,
            NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CBR
        );
        assert_eq!(config.rcParams.lookaheadDepth, 0);
        assert_eq!(config.rcParams.enableLookahead(), 0);
        assert_eq!(config.rcParams.zeroReorderDelay(), 1);
    }

    #[test]
    fn h264_is_single_slice_with_repeated_parameter_sets() {
        let mut config = blank_config();
        apply_codec_config(&mut config, &base());
        let h264 = unsafe { &config.encodeCodecConfig.h264Config };
        assert_eq!((h264.sliceMode, h264.sliceModeData), (3, 1));
        assert_eq!(h264.repeatSPSPPS(), 1);
        assert_eq!(h264.enableIntraRefresh(), 0);
        assert_eq!(h264.idrPeriod, NVENC_INFINITE_GOPLENGTH);
    }

    #[test]
    fn the_vui_flag_is_the_only_thing_measurement_one_varies() {
        let mut on = blank_config();
        apply_codec_config(&mut on, &base());
        let mut off = blank_config();
        apply_codec_config(
            &mut off,
            &EncoderConfig {
                bitstream_restriction: false,
                ..base()
            },
        );
        let (a, b) = unsafe {
            (
                on.encodeCodecConfig.h264Config.h264VUIParameters,
                off.encodeCodecConfig.h264Config.h264VUIParameters,
            )
        };
        assert_eq!(a.bitstreamRestrictionFlag, 1);
        assert_eq!(b.bitstreamRestrictionFlag, 0);
    }

    #[test]
    fn hevc_is_single_slice_with_repeated_parameter_sets() {
        let mut config = blank_config();
        apply_codec_config(
            &mut config,
            &EncoderConfig {
                codec: Codec::Hevc,
                ..base()
            },
        );
        let hevc = unsafe { &config.encodeCodecConfig.hevcConfig };
        assert_eq!((hevc.sliceMode, hevc.sliceModeData), (3, 1));
        assert_eq!(hevc.repeatSPSPPS(), 1);
        assert_eq!(hevc.enableIntraRefresh(), 0);
    }
}
