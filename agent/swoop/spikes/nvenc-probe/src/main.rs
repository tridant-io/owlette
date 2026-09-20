//! swoop spike 0.9 — NVENC configuration validation.
//!
//! Validates, on real hardware, the encoder settings plan.md D5/D7 assert and
//! Task 3.7 will ship. See `dev/active/swoop/spikes/0.9-nvenc-config.md` for
//! the memo these numbers feed.
//!
//! Usage (working directory must be this crate's directory — never
//! `--manifest-path`, which drops `.cargo/config.toml` and `+crt-static`):
//!
//! ```text
//! cargo run --release -- caps            # encoder capabilities, one line each
//! cargo run --release -- measure         # the six measurements -> out/results.json
//! cargo run --release -- serve           # serve out/ + the WebCodecs page on :8099
//! ```
//!
//! `measure` writes `out/streams/vui-{on,off}.h264` and their index files;
//! `serve` then hands those to Chrome, which posts `out/webcodecs-results.json`
//! back. Nothing here is ever copied into `C:\ProgramData\Owlette`.

mod d3d;
mod env;
mod json;
mod measure;
mod nal;
mod nvenc;
mod serve;

use std::path::PathBuf;
use std::process::ExitCode;

use moq_nvenc::sys::nvEncodeAPI::NV_ENC_CAPS;

use crate::nal::Codec;
use crate::nvenc::{EncoderConfig, MultiPass, Session};

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out")
}

fn print_caps() -> Result<(), String> {
    println!("gpu:       {}", env::gpu_name());
    println!("driver:    {}", env::driver_version());
    println!("nvenc api: {}", env::nvenc_api_versions());

    let device = d3d::create_device().map_err(|e| format!("D3D11CreateDevice failed: {e}"))?;
    for codec in [Codec::H264, Codec::Hevc] {
        let session = Session::open(
            &device,
            EncoderConfig {
                codec,
                width: 1920,
                height: 1080,
                fps: 60,
                bitrate_bps: 20_000_000,
                bitstream_restriction: true,
                multi_pass: MultiPass::QuarterResolution,
                async_encode: true,
                h264_level: 0,
            },
        )?;
        println!("\n{codec:?}:");
        for (name, cap) in [
            ("width max", NV_ENC_CAPS::NV_ENC_CAPS_WIDTH_MAX),
            ("height max", NV_ENC_CAPS::NV_ENC_CAPS_HEIGHT_MAX),
            (
                "async encode",
                NV_ENC_CAPS::NV_ENC_CAPS_ASYNC_ENCODE_SUPPORT,
            ),
            (
                "dynamic bitrate change",
                NV_ENC_CAPS::NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE,
            ),
            (
                "dynamic resolution change",
                NV_ENC_CAPS::NV_ENC_CAPS_SUPPORT_DYN_RES_CHANGE,
            ),
            (
                "custom vbv buffer size",
                NV_ENC_CAPS::NV_ENC_CAPS_SUPPORT_CUSTOM_VBV_BUF_SIZE,
            ),
            (
                "intra refresh",
                NV_ENC_CAPS::NV_ENC_CAPS_SUPPORT_INTRA_REFRESH,
            ),
            (
                "reference picture invalidation",
                NV_ENC_CAPS::NV_ENC_CAPS_SUPPORT_REF_PIC_INVALIDATION,
            ),
            ("max ltr frames", NV_ENC_CAPS::NV_ENC_CAPS_NUM_MAX_LTR_FRAMES),
            (
                "encoder engines",
                NV_ENC_CAPS::NV_ENC_CAPS_NUM_ENCODER_ENGINES,
            ),
            ("max b-frames", NV_ENC_CAPS::NV_ENC_CAPS_NUM_MAX_BFRAMES),
        ] {
            println!("  {name:<32} {}", session.caps(cap)?);
        }
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("caps") => print_caps(),
        Some("measure") => measure::run_all(&out_dir()),
        Some("serve") => {
            let port = args
                .get(1)
                .map(|p| p.parse::<u16>().map_err(|e| format!("bad port: {e}")))
                .transpose()?
                .unwrap_or(8099);
            serve::serve_until_report(&out_dir(), port).map(|_| ())
        }
        other => Err(format!(
            "unknown command {:?}; expected caps | measure | serve [port]",
            other.unwrap_or("")
        )),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
