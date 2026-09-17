//! DXGI adapter / output enumeration and duplication plumbing.
//!
//! Hardware-dependent tests in this module are `#[ignore]`d. Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/capture-probe
//! cargo test -- --ignored --nocapture
//! ```

use std::fmt::Write as _;

use windows::core::Interface;
use windows::Win32::Foundation::{HMODULE, RECT};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R10G10B10A2_UNORM,
    DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_MODE_ROTATION, DXGI_MODE_ROTATION_IDENTITY,
    DXGI_MODE_ROTATION_ROTATE180, DXGI_MODE_ROTATION_ROTATE270, DXGI_MODE_ROTATION_ROTATE90,
    DXGI_MODE_ROTATION_UNSPECIFIED,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, IDXGIOutput1, IDXGIOutput5,
    IDXGIOutput6, IDXGIOutputDuplication, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_OUTPUT_DESC,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI, MDT_RAW_DPI};

use crate::stats::Rect;

pub type Result<T> = windows::core::Result<T>;

pub struct AdapterInfo {
    pub index: u32,
    pub description: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub subsys_id: u32,
    pub revision: u32,
    pub luid: i64,
    pub flags: u32,
    pub dedicated_video_memory_mb: usize,
    pub shared_system_memory_mb: usize,
    pub software: bool,
    pub outputs: Vec<OutputInfo>,
}

pub struct OutputInfo {
    /// Index across every output of every adapter, in enumeration order. This
    /// is what `--output N` selects.
    pub global_index: usize,
    pub adapter_index: u32,
    pub output_index: u32,
    pub device_name: String,
    pub desktop_coordinates: Rect,
    pub attached_to_desktop: bool,
    pub rotation: DXGI_MODE_ROTATION,
    pub effective_dpi: (u32, u32),
    pub raw_dpi: (u32, u32),
    pub bits_per_color: u32,
    pub color_space: i32,
}

pub fn vendor_name(vendor_id: u32) -> &'static str {
    match vendor_id {
        0x10DE => "NVIDIA",
        0x8086 => "Intel",
        0x1002 => "AMD",
        0x1414 => "Microsoft",
        _ => "unknown",
    }
}

pub fn rotation_name(rotation: DXGI_MODE_ROTATION) -> &'static str {
    match rotation {
        DXGI_MODE_ROTATION_IDENTITY => "identity",
        DXGI_MODE_ROTATION_ROTATE90 => "rotate90",
        DXGI_MODE_ROTATION_ROTATE180 => "rotate180",
        DXGI_MODE_ROTATION_ROTATE270 => "rotate270",
        DXGI_MODE_ROTATION_UNSPECIFIED => "unspecified",
        other => {
            let _ = other;
            "unrecognised"
        }
    }
}

pub fn format_name(format: DXGI_FORMAT) -> String {
    match format {
        DXGI_FORMAT_B8G8R8A8_UNORM => "B8G8R8A8_UNORM".to_string(),
        DXGI_FORMAT_R10G10B10A2_UNORM => "R10G10B10A2_UNORM".to_string(),
        DXGI_FORMAT_R16G16B16A16_FLOAT => "R16G16B16A16_FLOAT".to_string(),
        other => format!("DXGI_FORMAT({})", other.0),
    }
}

fn wide_to_string(chars: &[u16]) -> String {
    let len = chars.iter().position(|c| *c == 0).unwrap_or(chars.len());
    String::from_utf16_lossy(&chars[..len])
}

fn to_rect(r: RECT) -> Rect {
    Rect {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    }
}

pub fn factory() -> Result<IDXGIFactory1> {
    unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }
}

/// Every adapter and every output the DXGI factory reports, in enumeration
/// order, whether or not the output is attached to the desktop.
pub fn enumerate() -> Result<Vec<AdapterInfo>> {
    let factory = factory()?;
    let mut adapters = Vec::new();
    let mut global_index = 0usize;

    let mut a = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(a) } {
        let desc = unsafe { adapter.GetDesc1() }?;
        let mut outputs = Vec::new();
        let mut o = 0u32;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            outputs.push(describe_output(&output, a, o, global_index)?);
            global_index += 1;
            o += 1;
        }
        adapters.push(AdapterInfo {
            index: a,
            description: wide_to_string(&desc.Description),
            vendor_id: desc.VendorId,
            device_id: desc.DeviceId,
            subsys_id: desc.SubSysId,
            revision: desc.Revision,
            luid: ((desc.AdapterLuid.HighPart as i64) << 32) | desc.AdapterLuid.LowPart as i64,
            flags: desc.Flags,
            dedicated_video_memory_mb: desc.DedicatedVideoMemory / (1024 * 1024),
            shared_system_memory_mb: desc.SharedSystemMemory / (1024 * 1024),
            software: desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0,
            outputs,
        });
        a += 1;
    }
    Ok(adapters)
}

fn describe_output(
    output: &IDXGIOutput,
    adapter_index: u32,
    output_index: u32,
    global_index: usize,
) -> Result<OutputInfo> {
    let desc: DXGI_OUTPUT_DESC = unsafe { output.GetDesc() }?;
    let mut eff = (0u32, 0u32);
    let mut raw = (0u32, 0u32);
    unsafe {
        let _ = GetDpiForMonitor(desc.Monitor, MDT_EFFECTIVE_DPI, &mut eff.0, &mut eff.1);
        let _ = GetDpiForMonitor(desc.Monitor, MDT_RAW_DPI, &mut raw.0, &mut raw.1);
    }
    let (bits_per_color, color_space) = match output.cast::<IDXGIOutput6>() {
        Ok(output6) => match unsafe { output6.GetDesc1() } {
            Ok(d) => (d.BitsPerColor, d.ColorSpace.0),
            Err(_) => (0, -1),
        },
        Err(_) => (0, -1),
    };
    Ok(OutputInfo {
        global_index,
        adapter_index,
        output_index,
        device_name: wide_to_string(&desc.DeviceName),
        desktop_coordinates: to_rect(desc.DesktopCoordinates),
        attached_to_desktop: desc.AttachedToDesktop.as_bool(),
        rotation: desc.Rotation,
        effective_dpi: eff,
        raw_dpi: raw,
        bits_per_color,
        color_space,
    })
}

pub fn create_device(adapter: &IDXGIAdapter1) -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    let levels: [D3D_FEATURE_LEVEL; 4] = [
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    ];
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

/// Resolve `--output N` to its adapter, its `IDXGIOutput` and a description.
pub fn open_output(global_index: usize) -> Result<(IDXGIAdapter1, IDXGIOutput, OutputInfo)> {
    let factory = factory()?;
    let mut seen = 0usize;
    let mut a = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(a) } {
        let mut o = 0u32;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            if seen == global_index {
                let info = describe_output(&output, a, o, seen)?;
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

/// `IDXGIOutput1::DuplicateOutput`.
pub fn duplicate(output: &IDXGIOutput, device: &ID3D11Device) -> Result<IDXGIOutputDuplication> {
    let output1: IDXGIOutput1 = output.cast()?;
    unsafe { output1.DuplicateOutput(device) }
}

/// `IDXGIOutput5::DuplicateOutput1` with an explicit format preference list.
pub fn duplicate1(
    output: &IDXGIOutput,
    device: &ID3D11Device,
    formats: &[DXGI_FORMAT],
) -> Result<IDXGIOutputDuplication> {
    let output5: IDXGIOutput5 = output.cast()?;
    unsafe { output5.DuplicateOutput1(device, 0, formats) }
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
    fn wide_to_string_stops_at_the_nul() {
        let mut buf = [0u16; 8];
        for (i, c) in "ok".encode_utf16().enumerate() {
            buf[i] = c;
        }
        assert_eq!(wide_to_string(&buf), "ok");
    }

    #[test]
    fn vendor_ids_map_to_the_names_task_7_3_uses() {
        assert_eq!(vendor_name(0x10DE), "NVIDIA");
        assert_eq!(vendor_name(0x8086), "Intel");
        assert_eq!(vendor_name(0x1002), "AMD");
        assert_eq!(vendor_name(0xDEAD), "unknown");
    }

    #[test]
    fn format_name_falls_back_to_the_numeric_form() {
        assert_eq!(format_name(DXGI_FORMAT_B8G8R8A8_UNORM), "B8G8R8A8_UNORM");
        assert_eq!(format_name(DXGI_FORMAT(9999)), "DXGI_FORMAT(9999)");
    }

    #[test]
    #[ignore = "needs a GPU and an attached display; cargo test -- --ignored"]
    fn enumeration_finds_at_least_one_attached_output() {
        let adapters = enumerate().expect("enumerate");
        let attached = adapters
            .iter()
            .flat_map(|a| a.outputs.iter())
            .filter(|o| o.attached_to_desktop)
            .count();
        assert!(attached >= 1, "no attached outputs");
    }

    #[test]
    #[ignore = "needs a GPU and an attached display; cargo test -- --ignored"]
    fn the_first_attached_output_duplicates_on_its_own_adapter() {
        let adapters = enumerate().expect("enumerate");
        let (ai, oi) = adapters
            .iter()
            .flat_map(|a| a.outputs.iter().map(move |o| (a.index, o)))
            .find(|(_, o)| o.attached_to_desktop)
            .map(|(ai, o)| (ai, o.global_index))
            .expect("an attached output");
        let (_, output, info) = open_output(oi).expect("open_output");
        assert_eq!(info.adapter_index, ai);
        let factory = factory().expect("factory");
        let adapter = unsafe { factory.EnumAdapters1(ai) }.expect("adapter");
        let (device, _ctx) = create_device(&adapter).expect("device");
        duplicate(&output, &device).expect("DuplicateOutput on the owning adapter");
    }
}
