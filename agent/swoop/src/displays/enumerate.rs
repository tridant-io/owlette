//! The display roster: every attached output, enriched with the facts a
//! `DXGI_OUTPUT_DESC` does not carry, plus the virtual-desktop → output →
//! client-canvas transform.
//!
//! # The DXGI walk is not repeated here
//!
//! [`crate::capture::enumerate_outputs`] is the enumeration, and this module
//! calls it. It already skips software adapters and never *selects* an adapter,
//! which is the only thing that keeps the Parsec Virtual Display Adapter off
//! the list: spike 0.8 §2 measured it byte-identical to the real GPU in
//! description, vendor id, subsystem id and VRAM — only the LUID differs — and
//! it carries zero outputs, so an output-first walk drops it and an
//! adapter-first rule picks it. A second walk here would be a second place for
//! that rule to rot, and cross-adapter duplication fails `E_INVALIDARG`, which
//! is not retryable.
//!
//! What this module adds per output is the stable device path, the monitor's
//! name, effective DPI and refresh.
//!
//! # Three measured traps, all live on the 0.8 box
//!
//! - The virtual desktop's origin is **negative in both axes** — (-2160, -1138)
//!   — so nothing below may assume it starts at zero.
//! - A rotated output reports a **transposed** `ModeDesc` against its texture
//!   (2160x3840 mode, 3840x2160 texture). [`DisplayEntry::texture`] therefore
//!   derives the size from the desktop rect through
//!   [`Rotation::swap_axes`](crate::capture::Rotation::swap_axes), never from a
//!   mode.
//! - Per-monitor DPI differs (96 and 120 here) and a desktop rect is in
//!   **physical** pixels whatever the scaling is. So DPI never enters
//!   [`DisplayEntry::canvas_point`]; it is carried because the cursor path
//!   scales a bitmap by it ([`crate::cursor::fit_for_css`]).
//!
//! # Hardware test
//!
//! ```text
//! cargo test -- --ignored --nocapture displays    # working directory agent/swoop
//! ```
//!
//! Expected on a dev box: one line per attached output naming its path, name,
//! rect, texture size, dpi and refresh, and a virtual-canvas line.

use crate::capture::{OutputInfo, Rotation};

/// One attached output, as the picker and the capture retarget need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayEntry {
    /// What the capture thread is retargeted with. Owned by `capture`.
    pub output: OutputInfo,
    /// The monitor's device interface path — the stable key. `output
    /// .device_name` (`\\.\DISPLAY2`) is not: a virtual display driver
    /// appearing or a panel being re-attached renumbers those, and so an index
    /// into this roster only means anything until the next rescan.
    pub path: String,
    /// The monitor as Windows names it. Often `Generic PnP Monitor`, which is
    /// the EDID name the driver reports and not something this module can
    /// improve on.
    pub name: String,
    /// Effective dpi. 96 is 100%.
    pub dpi: u32,
    /// Current mode's refresh, whole Hz as `EnumDisplaySettings` reports it.
    /// 0 when it could not be read.
    pub refresh_hz: u32,
    /// The output whose desktop rect starts at the virtual desktop's origin.
    pub primary: bool,
}

impl DisplayEntry {
    /// The acquired texture's size: un-rotated, and what the browser is handed.
    ///
    /// Nothing in this pipeline rotates a frame — `gpu::scale` leaves the video
    /// processor's rotation off deliberately — so the viewer sees the texture
    /// and a rotated panel is described to it transposed against the desktop.
    pub fn texture(&self) -> (u32, u32) {
        let rect = self.output.desktop_rect;
        self.output
            .rotation
            .swap_axes((rect.width() as u32, rect.height() as u32))
    }

    /// Host pixels per css pixel on this output.
    pub fn scale(&self) -> f64 {
        if self.dpi == 0 {
            1.0
        } else {
            f64::from(self.dpi) / f64::from(crate::cursor::DEFAULT_DPI)
        }
    }

    /// A virtual-desktop point as normalised coordinates on this output's
    /// client canvas, or `None` when the point is on a different output.
    ///
    /// The whole of virtual-desktop → output → client canvas: subtract the
    /// output's origin (negative in both axes on this box), normalise over the
    /// **displayed** size, then un-apply the rotation to land in texture space,
    /// which is what the browser draws.
    ///
    /// The divisor is `size - 1`, the same convention
    /// [`crate::input::absolute_from_desktop`] and
    /// [`crate::cursor::OutputGeometry::normalise`] use — so this is the exact
    /// inverse of the mapping injection runs, and a marker drawn here lands
    /// where the click it represents went.
    ///
    /// DPI is not in it: a desktop rect is physical pixels on a 200% output as
    /// much as on a 100% one (spike 0.8 §3).
    pub fn canvas_point(&self, at: (i32, i32)) -> Option<(f64, f64)> {
        let rect = self.output.desktop_rect;
        if at.0 < rect.left || at.0 >= rect.right || at.1 < rect.top || at.1 >= rect.bottom {
            return None;
        }
        let axis = |value: i32, lo: i32, size: i32| {
            f64::from(value - lo) / f64::from((size - 1).max(1))
        };
        let u = axis(at.0, rect.left, rect.width());
        let v = axis(at.1, rect.top, rect.height());
        Some(into_texture(u, v, self.output.rotation))
    }
}

/// Displayed-space uv → un-rotated texture uv.
///
/// The inverse of `input::un_rotate`, which is private and runs the other way:
/// the displayed image is the texture rotated clockwise, so undoing a clockwise
/// 90 is the 270 mapping and the other way round. The round trip against
/// `PointerSpace::to_desktop` is asserted below, which is what keeps these two
/// tables from drifting apart.
fn into_texture(u: f64, v: f64, rotation: Rotation) -> (f64, f64) {
    match rotation {
        Rotation::Identity => (u, v),
        Rotation::Rotate90 => (v, 1.0 - u),
        Rotation::Rotate180 => (1.0 - u, 1.0 - v),
        Rotation::Rotate270 => (1.0 - v, u),
    }
}

/// Every attached output, enriched. Ordered exactly as DXGI walks them, which
/// is what an index into the roster means.
#[cfg(windows)]
pub fn enumerate() -> anyhow::Result<Vec<DisplayEntry>> {
    let outputs = crate::capture::enumerate_outputs()?;
    Ok(outputs.into_iter().map(win32::enrich).collect())
}

/// Wave 9 brings the macOS and Linux siblings; until then a non-Windows build
/// enumerates nothing and the feature reports headless, which is true of it.
#[cfg(not(windows))]
pub fn enumerate() -> anyhow::Result<Vec<DisplayEntry>> {
    Ok(Vec::new())
}

#[cfg(windows)]
mod win32 {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayDevicesW, EnumDisplaySettingsW, DEVMODEW, DISPLAY_DEVICEW,
        ENUM_CURRENT_SETTINGS,
    };
    // Lives under WindowsAndMessaging in the bindings, not beside the function
    // that takes it.
    use windows::Win32::UI::WindowsAndMessaging::EDD_GET_DEVICE_INTERFACE_NAME;

    use super::DisplayEntry;
    use crate::capture::OutputInfo;
    use crate::cursor::dpi_for_rect;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn from_wide(chars: &[u16]) -> String {
        let len = chars.iter().position(|c| *c == 0).unwrap_or(chars.len());
        String::from_utf16_lossy(&chars[..len])
    }

    /// The monitor child of an adapter: its device interface path and its name.
    ///
    /// Index 0 because an adapter in this walk drives exactly one monitor —
    /// `EnumOutputs` produced the adapter name, and a clone group would have
    /// presented as one output either way.
    fn monitor(device_name: &str) -> (String, String) {
        let name = wide(device_name);
        let mut device = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        let ok = unsafe {
            EnumDisplayDevicesW(
                PCWSTR(name.as_ptr()),
                0,
                &mut device,
                EDD_GET_DEVICE_INTERFACE_NAME,
            )
        };
        if !ok.as_bool() {
            // The adapter name is a worse key than the interface path, but it
            // is a key, and it is what every other module already uses.
            return (device_name.to_owned(), device_name.to_owned());
        }
        let path = from_wide(&device.DeviceID);
        let path = if path.is_empty() {
            device_name.to_owned()
        } else {
            path
        };
        (path, from_wide(&device.DeviceString))
    }

    /// The current mode's refresh in whole Hz, or 0.
    ///
    /// Read from the mode and not from `DXGI_OUTDUPL_DESC`, which is only
    /// available once a duplication is open — and this runs with none.
    fn refresh_hz(device_name: &str) -> u32 {
        let name = wide(device_name);
        let mut mode = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        let ok = unsafe {
            EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_CURRENT_SETTINGS, &mut mode)
        };
        if ok.as_bool() {
            mode.dmDisplayFrequency
        } else {
            0
        }
    }

    pub fn enrich(output: OutputInfo) -> DisplayEntry {
        let (path, name) = monitor(&output.device_name);
        let refresh_hz = refresh_hz(&output.device_name);
        let dpi = dpi_for_rect(&output.desktop_rect);
        // The primary monitor is the one whose top-left IS the virtual
        // desktop's origin — the same rule `session::primary` picks on, kept
        // identical so the roster's `primary` and the output the session opens
        // at startup are never two different monitors.
        let primary = output.desktop_rect.left == 0 && output.desktop_rect.top == 0;
        DisplayEntry {
            output,
            path,
            name,
            dpi,
            refresh_hz,
            primary,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::Rect;
    use crate::input::PointerSpace;

    fn entry(rect: Rect, rotation: Rotation, dpi: u32, refresh_hz: u32) -> DisplayEntry {
        DisplayEntry {
            output: OutputInfo {
                device_name: format!("\\\\.\\DISPLAY{dpi}"),
                desktop_rect: rect,
                rotation,
            },
            path: format!("\\\\?\\DISPLAY#TEST{dpi}"),
            name: "test panel".to_owned(),
            dpi,
            refresh_hz,
            primary: rect.left == 0 && rect.top == 0,
        }
    }

    /// Spike 0.8 §3's layout, with the 4K panel's dpi raised to 200% and its
    /// refresh to 120 so neither is the other's: origin negative in both axes,
    /// one rotated output, two dpis, two refresh rates.
    fn layout() -> (DisplayEntry, DisplayEntry) {
        let primary = entry(
            Rect { left: 0, top: 0, right: 1920, bottom: 1080 },
            Rotation::Identity,
            96,
            60,
        );
        let rotated = entry(
            Rect { left: -2160, top: -1138, right: 0, bottom: 2702 },
            Rotation::Rotate270,
            192,
            120,
        );
        (primary, rotated)
    }

    #[test]
    fn a_rotated_output_is_sized_from_the_texture_and_not_the_mode() {
        let (primary, rotated) = layout();
        assert_eq!(primary.texture(), (1920, 1080));
        // 2160x3840 on the desktop, 3840x2160 as the encoder and the browser
        // see it — the trap spike 0.8 measured.
        assert_eq!(rotated.output.desktop_rect.width(), 2160);
        assert_eq!(rotated.output.desktop_rect.height(), 3840);
        assert_eq!(rotated.texture(), (3840, 2160));
    }

    #[test]
    fn a_point_outside_an_output_is_not_on_its_canvas() {
        let (primary, rotated) = layout();
        assert_eq!(primary.canvas_point((-1, 0)), None);
        assert_eq!(primary.canvas_point((1920, 0)), None);
        assert!(rotated.canvas_point((-2160, -1138)).is_some());
        assert_eq!(rotated.canvas_point((0, 0)), None);
    }

    /// The transform's real contract: it is the inverse of the one injection
    /// runs. Anything else means the viewer's cursor is drawn somewhere its own
    /// click does not land, which is the bug this pins.
    #[test]
    fn the_canvas_transform_inverts_the_injection_transform() {
        let (primary, rotated) = layout();
        for display in [&primary, &rotated] {
            let space = PointerSpace::from_output(&display.output);
            for (u, v) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (0.25, 0.75)] {
                let desktop = space.to_desktop(u, v);
                let back = display
                    .canvas_point(desktop)
                    .unwrap_or_else(|| panic!("{desktop:?} fell outside {}", display.name));
                // One desktop pixel of slack: `to_desktop` rounds to a pixel,
                // and the round trip cannot be finer than the grid it lands on.
                let slack = 1.0 / f64::from(display.texture().0.min(display.texture().1) - 1);
                let (u, v) = (f64::from(u), f64::from(v));
                assert!(
                    (back.0 - u).abs() <= slack && (back.1 - v).abs() <= slack,
                    "{u},{v} came back as {back:?} on {}",
                    display.name
                );
            }
        }
    }

    /// A desktop rect is physical pixels whatever the scaling is, so two
    /// outputs that differ only in dpi and refresh must transform identically.
    /// A dpi that leaked into the geometry would be a 25% injection error on
    /// the 0.8 box's 125% panel.
    #[test]
    fn dpi_and_refresh_do_not_enter_the_transform() {
        let rect = Rect { left: -2160, top: -1138, right: 0, bottom: 2702 };
        let at_96 = entry(rect, Rotation::Rotate270, 96, 60);
        let at_192 = entry(rect, Rotation::Rotate270, 192, 120);
        assert_eq!(at_96.texture(), at_192.texture());
        for point in [(-2160, -1138), (-1, 2701), (-1080, 782)] {
            assert_eq!(at_96.canvas_point(point), at_192.canvas_point(point));
        }
        // dpi is carried, and it is what the cursor bitmap is scaled by.
        assert_eq!(at_96.scale(), 1.0);
        assert_eq!(at_192.scale(), 2.0);
    }

    #[test]
    #[ignore = "hardware: enumerates this machine's real outputs"]
    fn enumerate_this_machine() {
        let roster = enumerate().expect("enumeration failed");
        for (index, display) in roster.iter().enumerate() {
            let rect = display.output.desktop_rect;
            let (tw, th) = display.texture();
            println!(
                "display {index}: {} \"{}\" rect ({},{})-({},{}) texture {tw}x{th} {:?} {} dpi {} hz{}",
                display.path,
                display.name,
                rect.left,
                rect.top,
                rect.right,
                rect.bottom,
                display.output.rotation,
                display.dpi,
                display.refresh_hz,
                if display.primary { " primary" } else { "" },
            );
        }
        assert!(!roster.is_empty(), "no attached output");
    }
}
