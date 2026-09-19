//! DXGI output enumeration and duplication plumbing, trimmed from spike 0.8's
//! `capture-probe/src/dxgi.rs` to what the bake-off's front half uses.
//!
//! The one rule that is not obvious and is load-bearing (spike 0.8 §2): **never
//! choose a capture device by adapter.** Create the D3D11 device on the output's
//! *own* `IDXGIAdapter1`. Cross-adapter duplication fails `E_INVALIDARG`, which
//! is not retryable, and on this box the Parsec Virtual Display Adapter is
//! byte-identical to the real GPU by description, vendor id, subsystem id and
//! VRAM — so any adapter-first rule picks the wrong one.
//!
//! Hardware-dependent tests in this module are `#[ignore]`d. Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/bakeoff-host
//! cargo test -- --ignored --nocapture
//! ```

use std::fmt::Write as _;

use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_MODE_ROTATION, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_ROTATE180,
    DXGI_MODE_ROTATION_ROTATE270, DXGI_MODE_ROTATION_ROTATE90,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, IDXGIOutput1,
    IDXGIOutputDuplication, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_OUTPUT_DESC,
};

pub type Result<T> = windows::core::Result<T>;

#[derive(Clone, Debug)]
pub struct OutputInfo {
    /// Index across every output of every adapter, in enumeration order. This
    /// is what `--output N` selects.
    pub global_index: usize,
    pub adapter_index: u32,
    pub adapter_description: String,
    pub adapter_software: bool,
    pub device_name: String,
    /// Virtual-desktop rectangle, left/top/right/bottom.
    pub bounds: (i32, i32, i32, i32),
    pub attached_to_desktop: bool,
    pub rotation: &'static str,
}

impl OutputInfo {
    pub fn width(&self) -> i32 {
        self.bounds.2 - self.bounds.0
    }
    pub fn height(&self) -> i32 {
        self.bounds.3 - self.bounds.1
    }
    /// The primary output is the one whose virtual-desktop rectangle starts at
    /// the origin. Spike 0.1 §4.2 measured `GetFrameStatistics` resolving 5 of
    /// 200 presents on the rotated secondary against 200 of 200 here, so
    /// **every run in this spike is on the primary**.
    pub fn is_primary(&self) -> bool {
        self.bounds.0 == 0 && self.bounds.1 == 0
    }
}

fn rotation_name(rotation: DXGI_MODE_ROTATION) -> &'static str {
    match rotation {
        DXGI_MODE_ROTATION_IDENTITY => "identity",
        DXGI_MODE_ROTATION_ROTATE90 => "rotate90",
        DXGI_MODE_ROTATION_ROTATE180 => "rotate180",
        DXGI_MODE_ROTATION_ROTATE270 => "rotate270",
        _ => "unspecified",
    }
}

fn wide_to_string(chars: &[u16]) -> String {
    let len = chars.iter().position(|c| *c == 0).unwrap_or(chars.len());
    String::from_utf16_lossy(&chars[..len])
}

fn describe(
    output: &IDXGIOutput,
    adapter_index: u32,
    adapter_description: &str,
    adapter_software: bool,
    global_index: usize,
) -> Result<OutputInfo> {
    let desc: DXGI_OUTPUT_DESC = unsafe { output.GetDesc() }?;
    let r = desc.DesktopCoordinates;
    Ok(OutputInfo {
        global_index,
        adapter_index,
        adapter_description: adapter_description.to_string(),
        adapter_software,
        device_name: wide_to_string(&desc.DeviceName),
        bounds: (r.left, r.top, r.right, r.bottom),
        attached_to_desktop: desc.AttachedToDesktop.as_bool(),
        rotation: rotation_name(desc.Rotation),
    })
}

/// Every output of every adapter, in enumeration order.
pub fn enumerate_outputs() -> Result<Vec<OutputInfo>> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    let mut out = Vec::new();
    let mut a = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(a) } {
        let desc = unsafe { adapter.GetDesc1() }?;
        let description = wide_to_string(&desc.Description);
        let software = desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0;
        let mut o = 0u32;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            let index = out.len();
            out.push(describe(&output, a, &description, software, index)?);
            o += 1;
        }
        a += 1;
    }
    Ok(out)
}

/// Resolve a global output index to its own adapter, its `IDXGIOutput` and a
/// description. Returning the adapter is the point: the caller creates its
/// D3D11 device on *this* adapter and no other.
pub fn open_output(global_index: usize) -> Result<(IDXGIAdapter1, IDXGIOutput, OutputInfo)> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    let mut seen = 0usize;
    let mut a = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(a) } {
        let desc = unsafe { adapter.GetDesc1() }?;
        let description = wide_to_string(&desc.Description);
        let software = desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0;
        let mut o = 0u32;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            if seen == global_index {
                let info = describe(&output, a, &description, software, seen)?;
                return Ok((adapter, output, info));
            }
            seen += 1;
            o += 1;
        }
        a += 1;
    }
    Err(windows::core::Error::new(
        windows::Win32::Foundation::E_INVALIDARG,
        format!("no output with global index {global_index} (saw {seen})"),
    ))
}

/// A D3D11 device on the given adapter. `D3D_DRIVER_TYPE_UNKNOWN` is mandatory
/// when an adapter is passed.
pub fn create_device(adapter: &IDXGIAdapter1) -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    let levels: [D3D_FEATURE_LEVEL; 2] = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    unsafe {
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    Ok((device.unwrap(), context.unwrap()))
}

pub fn duplicate(output: &IDXGIOutput, device: &ID3D11Device) -> Result<IDXGIOutputDuplication> {
    let output1: IDXGIOutput1 = output.cast()?;
    unsafe { output1.DuplicateOutput(device) }
}

pub fn hresult(err: &windows::core::Error) -> String {
    let mut s = String::new();
    let _ = write!(s, "0x{:08X}", err.code().0 as u32);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_strings_stop_at_the_nul() {
        let mut buf = [0u16; 8];
        for (i, c) in "DISPLAY1".chars().take(4).enumerate() {
            buf[i] = c as u16;
        }
        assert_eq!(wide_to_string(&buf), "DISP");
    }

    #[test]
    fn primary_is_the_output_at_the_virtual_desktop_origin() {
        let mut info = OutputInfo {
            global_index: 0,
            adapter_index: 0,
            adapter_description: "test".into(),
            adapter_software: false,
            device_name: r"\\.\DISPLAY1".into(),
            bounds: (0, 0, 1920, 1080),
            attached_to_desktop: true,
            rotation: "identity",
        };
        assert!(info.is_primary());
        assert_eq!((info.width(), info.height()), (1920, 1080));
        info.bounds = (-2160, -1138, 0, 2702);
        assert!(!info.is_primary());
    }

    /// Needs a desktop and a GPU.
    #[test]
    #[ignore]
    fn enumerates_at_least_one_attached_output() {
        let outputs = enumerate_outputs().expect("enumerate");
        assert!(
            outputs.iter().any(|o| o.attached_to_desktop),
            "no attached output: {outputs:#?}"
        );
    }
}
