//! The `probe` verb: what this machine can actually capture and encode.
//!
//! `probe` is run on demand — never on the agent's heartbeat path, which
//! computes the `capabilities.swoop` flag from the binary's presence alone
//! (`agent/src/swoop_capability.py`). One JSON object on stdout, exit 0, or
//! exit 13 when nothing on this machine encodes; the object is printed either
//! way, because "which adapters are here and what did they refuse" is the whole
//! reason somebody runs this on a box that cannot stream.
//!
//! The top-level key names are contract: the spike memos read them and Task
//! 8.2 takes its tier count from `encoder_budget`. Nothing here prints anything
//! that came from a bundle.
//!
//! Adapters are reported, never inferred from. Spike 0.8 measured the Parsec
//! virtual display adapter byte-identical to the real GPU by description,
//! vendor id, subsystem and VRAM — so `adapters` is context for a human, and
//! `encoders` (each backend's own `probe()`, which opens a session) is the
//! truth.

use serde::Serialize;

use crate::encode::{select, BackendCaps, Codec};
use crate::ipc::Exit;

/// Vendor ids worth naming. Everything else reports its raw id and
/// `vendor: "other"`.
const VENDOR_NVIDIA: u32 = 0x10DE;
const VENDOR_INTEL: u32 = 0x8086;
const VENDOR_AMD: u32 = 0x1002;

#[derive(Debug, Serialize)]
pub struct Report {
    /// Matches the binary's own version, so the agent can refuse a stale
    /// streamer without spawning it twice.
    pub version: &'static str,
    /// The heartbeat's spelling (`windows` / `macos` / `linux`), not Rust's.
    pub os_family: &'static str,
    /// The heartbeat's spelling (`x64` / `arm64`).
    pub arch: &'static str,
    /// Every DXGI adapter, in enumeration order.
    pub adapters: Vec<Adapter>,
    /// Whether anything can be captured at all — an output attached to the
    /// desktop on an adapter that can duplicate one.
    pub capture: bool,
    /// The attached outputs, by device name.
    pub sources: Vec<String>,
    /// What each compiled backend reports about itself, measured.
    pub encoders: Vec<BackendCaps>,
    /// Per-codec availability across all backends. A codec missing here cannot
    /// be encoded on this machine at any size.
    pub codecs: Vec<CodecReport>,
    /// The resolved chain per codec, highest tier first — the first name is
    /// what a session opens on, the rest are what it falls to.
    pub fallback_chain: Vec<ChainReport>,
    /// Concurrent encode sessions this machine sustains. Task 8.2's tier count
    /// is min(codec classes present, this).
    pub encoder_budget: u32,
}

#[derive(Debug, Serialize)]
pub struct Adapter {
    pub description: String,
    /// `nvidia` / `intel` / `amd` / `other`.
    pub vendor: &'static str,
    pub vendor_id: u32,
    /// Outputs attached to the desktop on this adapter. Zero is the shape a
    /// headless machine *and* a virtual display adapter both have.
    pub outputs: u32,
    /// WARP and friends duplicate nothing and encode nothing.
    pub software: bool,
}

#[derive(Debug, Serialize)]
pub struct CodecReport {
    pub codec: Codec,
    /// The largest this machine does for the codec, on whichever backend does
    /// it — not necessarily the backend at the top of the chain.
    pub max_width: u32,
    pub max_height: u32,
}

#[derive(Debug, Serialize)]
pub struct ChainReport {
    pub codec: Codec,
    pub backends: Vec<&'static str>,
}

impl Report {
    /// Exit 13 when no backend encodes anything. The report still prints.
    pub fn exit(&self) -> Exit {
        if self.codecs.is_empty() {
            Exit::NoEncoder
        } else {
            Exit::Ok
        }
    }
}

fn os_family() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "x64",
    }
}

const fn vendor_name(vendor_id: u32) -> &'static str {
    match vendor_id {
        VENDOR_NVIDIA => "nvidia",
        VENDOR_INTEL => "intel",
        VENDOR_AMD => "amd",
        _ => "other",
    }
}

#[cfg(windows)]
fn adapters() -> Vec<Adapter> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
    };

    // SAFETY: the factory is a plain COM object and every call below writes
    // only into locals.
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return Vec::new();
    };
    let mut adapters = Vec::new();
    for index in 0.. {
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else {
            break;
        };
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
            continue;
        };
        let mut outputs = 0u32;
        while (unsafe { adapter.EnumOutputs(outputs) }).is_ok() {
            outputs += 1;
        }
        let len = desc
            .Description
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(desc.Description.len());
        adapters.push(Adapter {
            description: String::from_utf16_lossy(&desc.Description[..len]),
            vendor: vendor_name(desc.VendorId),
            vendor_id: desc.VendorId,
            outputs,
            software: desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0,
        });
    }
    adapters
}

#[cfg(not(windows))]
fn adapters() -> Vec<Adapter> {
    Vec::new()
}

/// The attached outputs by device name.
///
/// Capture availability is this walk, not an opened duplication: `probe` can
/// run while a session is streaming, and taking a duplication away from it to
/// answer a question would be worse than the answer is good.
#[cfg(windows)]
fn sources() -> Vec<String> {
    crate::capture::enumerate_outputs()
        .unwrap_or_default()
        .into_iter()
        .map(|output| output.device_name)
        .collect()
}

#[cfg(not(windows))]
fn sources() -> Vec<String> {
    Vec::new()
}

pub fn report() -> Report {
    let encoders = select::probe_all();
    let sources = sources();

    let mut codecs = Vec::new();
    let mut fallback_chain = Vec::new();
    for codec in [Codec::H265, Codec::H264] {
        let backends = select::backends_for(&encoders, codec);
        if backends.is_empty() {
            continue;
        }
        let limits = encoders
            .iter()
            .flat_map(|caps| caps.codecs.iter())
            .filter(|caps| caps.codec == codec);
        codecs.push(CodecReport {
            codec,
            max_width: limits.clone().map(|caps| caps.max_width).max().unwrap_or(0),
            max_height: limits.map(|caps| caps.max_height).max().unwrap_or(0),
        });
        fallback_chain.push(ChainReport { codec, backends });
    }

    Report {
        version: env!("CARGO_PKG_VERSION"),
        os_family: os_family(),
        arch: arch(),
        adapters: adapters(),
        capture: !sources.is_empty(),
        sources,
        encoder_budget: select::budget(&encoders),
        encoders,
        codecs,
        fallback_chain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The names the memos and Task 8.2 read. Adding one is a contract change;
    /// renaming one breaks a reader that cannot be recompiled with us.
    const KEYS: [&str; 10] = [
        "version",
        "os_family",
        "arch",
        "adapters",
        "capture",
        "sources",
        "encoders",
        "codecs",
        "fallback_chain",
        "encoder_budget",
    ];

    #[test]
    fn report_serialises_to_json_with_the_heartbeat_spellings() {
        let json = serde_json::to_value(report()).expect("the report serialises");
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
        assert!(["windows", "macos", "linux"].contains(&json["os_family"].as_str().unwrap()));
        assert!(["x64", "arm64"].contains(&json["arch"].as_str().unwrap()));
    }

    #[test]
    fn the_top_level_keys_are_the_contract() {
        let json = serde_json::to_value(report()).expect("the report serialises");
        let object = json.as_object().expect("one json object");
        let mut got: Vec<&str> = object.keys().map(String::as_str).collect();
        let mut want = KEYS.to_vec();
        got.sort_unstable();
        want.sort_unstable();
        assert_eq!(got, want);
    }

    /// Every field named, so adding one to `Report` fails here until this test
    /// and `KEYS` are updated with it.
    fn empty_report() -> Report {
        Report {
            version: env!("CARGO_PKG_VERSION"),
            os_family: "windows",
            arch: "x64",
            adapters: Vec::new(),
            capture: false,
            sources: Vec::new(),
            encoders: Vec::new(),
            codecs: Vec::new(),
            fallback_chain: Vec::new(),
            encoder_budget: 0,
        }
    }

    #[test]
    fn a_machine_with_no_encoder_exits_13() {
        let report = empty_report();
        assert_eq!(report.exit(), Exit::NoEncoder);
        assert_eq!(report.exit().code(), 13);
    }

    #[test]
    fn one_encodable_codec_is_exit_0() {
        let report = Report {
            codecs: vec![CodecReport {
                codec: Codec::H264,
                max_width: 4096,
                max_height: 4096,
            }],
            encoder_budget: 1,
            ..empty_report()
        };
        assert_eq!(report.exit().code(), 0);
    }

    /// The real path, not a fabricated report: with no encoder feature compiled
    /// in there is nothing to select, and `probe` must say so with 13 rather
    /// than printing an empty success.
    #[cfg(not(any(
        feature = "encode-nvenc",
        feature = "encode-vpl",
        feature = "encode-amf",
        feature = "encode-mf",
        feature = "encode-openh264",
        feature = "encode-ffmpeg"
    )))]
    #[test]
    fn a_build_with_no_backend_exits_13() {
        let report = report();
        assert!(report.encoders.is_empty());
        assert_eq!(report.encoder_budget, 0);
        assert_eq!(report.exit().code(), 13);
    }
}
