//! What hardware and which API version produced the numbers. A measurement
//! memo without these is not reproducible, and the NVENC API version is not the
//! same thing as the driver version: the driver reports its own maximum
//! supported API, and a client built against an older header runs unchanged
//! against a newer driver.

use std::process::Command;

use moq_nvenc::sys::nvEncodeAPI::{NVENCAPI_MAJOR_VERSION, NVENCAPI_MINOR_VERSION};
use windows::core::{s, w};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

fn nvidia_smi(query: &str) -> Option<String> {
    let output = Command::new("nvidia-smi")
        .args([&format!("--query-gpu={query}"), "--format=csv,noheader"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(text.lines().next()?.trim().to_string())
}

pub fn gpu_name() -> String {
    nvidia_smi("name").unwrap_or_else(|| "unknown (nvidia-smi unavailable)".into())
}

pub fn driver_version() -> String {
    nvidia_smi("driver_version").unwrap_or_else(|| "unknown (nvidia-smi unavailable)".into())
}

/// What else the GPU is doing, as `gpu 18 %, encoder 0 %, 1350 MHz`. The spike
/// runs on a live desktop, so the memo has to say so with a number.
pub fn gpu_load() -> String {
    nvidia_smi("utilization.gpu,utilization.encoder,clocks.current.graphics")
        .unwrap_or_else(|| "unknown (nvidia-smi unavailable)".into())
}

/// The header version this binary was compiled against and the maximum the
/// installed driver supports, as `header 12.1, driver max 13.0`.
pub fn nvenc_api_versions() -> String {
    let header = format!("header {NVENCAPI_MAJOR_VERSION}.{NVENCAPI_MINOR_VERSION}");
    match driver_max_supported_version() {
        Some(v) => format!("{header}, driver max {}.{}", v >> 4, v & 0x0f),
        None => format!("{header}, driver max unknown"),
    }
}

fn driver_max_supported_version() -> Option<u32> {
    type GetMaxVersion = unsafe extern "C" fn(*mut u32) -> i32;
    unsafe {
        let library = LoadLibraryW(w!("nvEncodeAPI64.dll")).ok()?;
        let symbol = GetProcAddress(library, s!("NvEncodeAPIGetMaxSupportedVersion"))?;
        let get_max: GetMaxVersion = std::mem::transmute(symbol);
        let mut version = 0u32;
        if get_max(&mut version) != 0 {
            return None;
        }
        Some(version)
    }
}
