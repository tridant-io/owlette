//! macOS displays: the roster from CoreGraphics, in pixels.
//!
//! Every rect here is [`platform::macos::display_pixel_rect`]: the display's
//! point origin times its scale, and its pixel size (decision 13). So a
//! Retina panel's `desktop_rect` is its native pixel grid, the size capture
//! asks ScreenCaptureKit for and the size the browser is handed.
//!
//! A display's key is `display-<id>`, its CoreGraphics display id: the same
//! string is the `OutputInfo.device_name` capture opens and the
//! `DisplayEntry.path` selection follows. Nothing else is stable enough to be
//! one, and CoreGraphics reads the ids, bounds and modes without Screen
//! Recording, so none of this raises a prompt.
//!
//! `rotation` is always [`Rotation::Identity`]: macOS hands a rotated
//! display's picture out already rotated, and its bounds and mode are the
//! rotated ones. **Untested**: the rig has no rotated panel.
//!
//! Selection is one display at a time. A spanned canvas is deferred on macOS:
//! on a mixed-scale layout the pixel origins are not one global space.
//!
//! The roster's hardware test is the portable one in [`super::enumerate`]:
//!
//! ```text
//! CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --locked --no-default-features \
//!     --features encode-videotoolbox,audio-opus -- --ignored --nocapture displays
//! ```
//!
//! It reads CoreGraphics only and changes nothing on the machine. An asleep
//! display is not in the active list, so a Mac whose screen has gone to sleep
//! enumerates nothing (measured on the rig); `caffeinate -u -t 2` wakes it.

use objc2_core_graphics::{
    CGDisplayCopyDisplayMode, CGDisplayIsBuiltin, CGDisplayIsMain, CGDisplayMode,
};

use super::enumerate::DisplayEntry;
use crate::capture::{OutputInfo, Rotation};
use crate::platform::{self, macos};

const DEVICE_PREFIX: &str = "display-";

/// What a mode that reports no refresh is read as. Older built-in panels
/// answer 0 from `CGDisplayModeGetRefreshRate`, and they run at 60.
const UNREPORTED_REFRESH_HZ: u32 = 60;

/// `display-<id>`, the key capture and selection share.
pub fn device_name(id: u32) -> String {
    format!("{DEVICE_PREFIX}{id}")
}

/// The CoreGraphics display an output names, or `None` for a name this
/// module did not make.
pub fn display_id(output: &OutputInfo) -> Option<u32> {
    output.device_name.strip_prefix(DEVICE_PREFIX)?.parse().ok()
}

/// One display as capture opens it, read fresh: a mode change moves its rect.
pub fn output(id: u32) -> OutputInfo {
    OutputInfo {
        device_name: device_name(id),
        desktop_rect: macos::display_pixel_rect(id),
        rotation: Rotation::Identity,
    }
}

/// Every active display. Empty when CoreGraphics cannot list them or every
/// display is asleep, which the session reads as no capture source (exit 12).
pub fn outputs() -> anyhow::Result<Vec<OutputInfo>> {
    Ok(macos::display_ids().into_iter().map(output).collect())
}

/// Every active display, enriched for the picker and the log.
pub fn entries() -> anyhow::Result<Vec<DisplayEntry>> {
    Ok(macos::display_ids()
        .into_iter()
        .map(|id| {
            let output = output(id);
            // 96 times the display's scale, the one spelling the cursor path
            // also reads.
            let dpi = platform::dpi_for_rect(&output.desktop_rect);
            entry(output, name(id), dpi, refresh_rate(id), CGDisplayIsMain(id))
        })
        .collect())
}

/// CoreGraphics has no display name, and `NSScreen.localizedName` is for the
/// main thread only. Host-side only: the log says which panel it is.
fn name(id: u32) -> String {
    if CGDisplayIsBuiltin(id) {
        "built-in display".to_owned()
    } else {
        "external display".to_owned()
    }
}

fn refresh_rate(id: u32) -> f64 {
    CGDisplayCopyDisplayMode(id).map_or(0.0, |mode| CGDisplayMode::refresh_rate(Some(&mode)))
}

fn entry(
    output: OutputInfo,
    name: String,
    dpi: u32,
    refresh_rate: f64,
    main: bool,
) -> DisplayEntry {
    let refresh = refresh_rate.round();
    let refresh_hz = if refresh >= 1.0 {
        refresh as u32
    } else {
        UNREPORTED_REFRESH_HZ
    };
    DisplayEntry {
        path: output.device_name.clone(),
        output,
        name,
        dpi,
        refresh_hz,
        // The main display is the one at the global origin, so this and the
        // session's own pick (the rect at 0,0) are the same display.
        primary: main,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::Rect;

    /// A 2x panel of 1512x982 points placed left of and above the main one,
    /// at (-1512, -120) points: its pixel rect starts at (-3024, -240).
    fn retina_left_of_main() -> OutputInfo {
        OutputInfo {
            device_name: device_name(2),
            desktop_rect: Rect {
                left: -3024,
                top: -240,
                right: 0,
                bottom: 1724,
            },
            rotation: Rotation::Identity,
        }
    }

    #[test]
    fn a_device_name_round_trips_to_its_display_id() {
        let output = output_named(&device_name(69_733_248));
        assert_eq!(output.device_name, "display-69733248");
        assert_eq!(display_id(&output), Some(69_733_248));
        assert_eq!(display_id(&output_named(r"\\.\DISPLAY1")), None);
        assert_eq!(display_id(&output_named("display-")), None);
    }

    fn output_named(name: &str) -> OutputInfo {
        OutputInfo {
            device_name: name.to_owned(),
            ..retina_left_of_main()
        }
    }

    #[test]
    fn a_mode_without_a_refresh_is_read_as_60() {
        let hz = |rate| entry(retina_left_of_main(), String::new(), 192, rate, false).refresh_hz;
        assert_eq!(hz(0.0), 60);
        assert_eq!(hz(59.94), 60);
        assert_eq!(hz(120.0), 120);
    }

    #[test]
    fn an_entry_is_keyed_by_its_device_name_and_primary_is_the_main_display() {
        let main = entry(
            retina_left_of_main(),
            "built-in display".into(),
            192,
            60.0,
            true,
        );
        assert_eq!(main.path, "display-2");
        assert!(main.primary);
        assert!(!entry(retina_left_of_main(), String::new(), 192, 60.0, false).primary);
    }

    /// Decision 13 end to end on the roster: a 2x panel at a negative origin
    /// is its pixel grid, advertised at that size, and dpi 192 is scale 2.
    #[test]
    fn a_retina_display_left_of_the_main_one_is_its_pixel_grid() {
        let display = entry(retina_left_of_main(), String::new(), 192, 60.0, false);
        assert_eq!(display.texture(), (3024, 1964));
        assert_eq!(display.scale(), 2.0);
        assert_eq!(display.canvas_point((-3024, -240)), Some((0.0, 0.0)));
        assert_eq!(display.canvas_point((-1, 1723)), Some((1.0, 1.0)));
        assert_eq!(display.canvas_point((0, 0)), None);
    }
}
