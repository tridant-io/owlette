//! Temporary display-mode changes, used only to force `DXGI_ERROR_ACCESS_LOST`.
//!
//! `CDS_FULLSCREEN` keeps the change out of the registry, and every caller
//! restores the saved `DEVMODEW` explicitly. Nothing here belongs in the
//! product: plan D6 forbids swoop changing display configuration.
//!
//! Hardware-dependent tests are `#[ignore]`d. Manual invocation:
//!
//! ```text
//! cd agent/swoop/spikes/capture-probe
//! cargo test -- --ignored --nocapture
//! ```

use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    ChangeDisplaySettingsExW, EnumDisplaySettingsExW, CDS_FULLSCREEN, DEVMODEW, DISP_CHANGE,
    DISP_CHANGE_SUCCESSFUL, DM_BITSPERPEL, DM_DISPLAYFREQUENCY, DM_PELSHEIGHT, DM_PELSWIDTH,
    ENUM_CURRENT_SETTINGS, ENUM_DISPLAY_SETTINGS_FLAGS, ENUM_DISPLAY_SETTINGS_MODE,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn current_mode(device_name: &str) -> Option<DEVMODEW> {
    let name = wide(device_name);
    let mut mode = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    let ok = unsafe {
        EnumDisplaySettingsExW(
            PCWSTR(name.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut mode,
            ENUM_DISPLAY_SETTINGS_FLAGS(0),
        )
    };
    ok.as_bool().then_some(mode)
}

/// The largest mode strictly smaller than `current` at the same refresh rate and
/// colour depth. Resolution is what reliably raises ACCESS_LOST; a refresh-only
/// change does not always.
pub fn pick_smaller_mode(device_name: &str, current: &DEVMODEW) -> Option<DEVMODEW> {
    let name = wide(device_name);
    let mut best: Option<DEVMODEW> = None;
    let mut i = 0u32;
    loop {
        let mut mode = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        let ok = unsafe {
            EnumDisplaySettingsExW(
                PCWSTR(name.as_ptr()),
                ENUM_DISPLAY_SETTINGS_MODE(i),
                &mut mode,
                ENUM_DISPLAY_SETTINGS_FLAGS(0),
            )
        };
        if !ok.as_bool() {
            break;
        }
        i += 1;
        let usable = mode.dmBitsPerPel == current.dmBitsPerPel
            && mode.dmDisplayFrequency == current.dmDisplayFrequency
            && mode.dmPelsWidth < current.dmPelsWidth
            && mode.dmPelsHeight < current.dmPelsHeight
            && mode.dmPelsWidth >= 1024;
        if usable
            && best
                .map(|b| mode.dmPelsWidth > b.dmPelsWidth)
                .unwrap_or(true)
        {
            best = Some(mode);
        }
    }
    best
}

pub fn apply_mode(device_name: &str, mode: &DEVMODEW) -> DISP_CHANGE {
    let name = wide(device_name);
    let mut m = *mode;
    m.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
    m.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_BITSPERPEL | DM_DISPLAYFREQUENCY;
    unsafe {
        ChangeDisplaySettingsExW(
            PCWSTR(name.as_ptr()),
            Some(&m),
            None,
            CDS_FULLSCREEN,
            None,
        )
    }
}

pub fn disp_change_name(code: DISP_CHANGE) -> &'static str {
    match code.0 {
        0 => "SUCCESSFUL",
        1 => "RESTART",
        -1 => "FAILED",
        -2 => "BADMODE",
        -3 => "NOTUPDATED",
        -4 => "BADFLAGS",
        -5 => "BADPARAM",
        -6 => "BADDUALVIEW",
        _ => "unknown",
    }
}

pub fn succeeded(code: DISP_CHANGE) -> bool {
    code == DISP_CHANGE_SUCCESSFUL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_is_nul_terminated() {
        let w = wide("AB");
        assert_eq!(w, vec![65u16, 66u16, 0u16]);
    }

    #[test]
    fn disp_change_codes_are_named() {
        assert_eq!(disp_change_name(DISP_CHANGE_SUCCESSFUL), "SUCCESSFUL");
        assert_eq!(disp_change_name(DISP_CHANGE(-2)), "BADMODE");
        assert!(succeeded(DISP_CHANGE_SUCCESSFUL));
        assert!(!succeeded(DISP_CHANGE(-1)));
    }

    #[test]
    #[ignore = "reads the live display configuration; cargo test -- --ignored"]
    fn the_primary_display_reports_a_current_mode_and_a_smaller_one() {
        let current = current_mode("\\\\.\\DISPLAY1").expect("current mode");
        assert!(current.dmPelsWidth >= 640);
        let smaller = pick_smaller_mode("\\\\.\\DISPLAY1", &current);
        if let Some(s) = smaller {
            assert!(s.dmPelsWidth < current.dmPelsWidth);
        }
    }
}
