//! The desktop access masks the two halves of primitive (4) ask for, in one
//! place because the whole point of the spike is comparing them.
//!
//! Measured on this box as an ordinary user before this spike existed, and the
//! reason `agent/swoop/src/input` does not share `agent/swoop/src/capture`'s
//! watcher: `READOBJECTS | WRITEOBJECTS` is enough to **duplicate** a desktop
//! and not enough to **inject** on one — attaching through that handle turns
//! every `SendInput` into `0 of 1, last error 5 (Access is denied.)`.
//! `DESKTOP_JOURNALPLAYBACK` is the missing right, however little `SendInput`
//! looks like a journal hook.
//!
//! Neither measurement was taken as SYSTEM. That is what this spike is for, and
//! it is why both masks are runnable arms rather than a constant.

use windows::Win32::System::StationsAndDesktops::{
    DESKTOP_ACCESS_FLAGS, DESKTOP_JOURNALPLAYBACK, DESKTOP_READOBJECTS, DESKTOP_WRITEOBJECTS,
};

pub struct Access {
    pub name: &'static str,
    pub mask: DESKTOP_ACCESS_FLAGS,
    /// Whether an arm with this access attaches the thread at all. `none` does
    /// not: it measures the desktop the process was spawned with.
    pub attaches: bool,
}

/// What `agent/swoop/src/capture` opens the input desktop with.
pub const CAPTURE: DESKTOP_ACCESS_FLAGS =
    DESKTOP_ACCESS_FLAGS(DESKTOP_READOBJECTS.0 | DESKTOP_WRITEOBJECTS.0);

/// What `agent/swoop/src/input` opens it with. The minimum measured to work,
/// deliberately not the wider mask the VNCs ask for: `OpenInputDesktop` is an
/// access check, so every extra right is another way to be refused on a desktop
/// whose DACL is not the default.
pub const INJECT: DESKTOP_ACCESS_FLAGS = DESKTOP_ACCESS_FLAGS(
    DESKTOP_READOBJECTS.0 | DESKTOP_WRITEOBJECTS.0 | DESKTOP_JOURNALPLAYBACK.0,
);

/// Resolve an arm name. An unknown name falls back to `inject` rather than
/// failing, because a typo that silently measured the weaker mask would look
/// exactly like the finding this spike is here to confirm.
pub fn by_name(name: &str) -> Access {
    match name {
        "capture" => Access {
            name: "capture",
            mask: CAPTURE,
            attaches: true,
        },
        "none" => Access {
            name: "none",
            mask: INJECT,
            attaches: false,
        },
        _ => Access {
            name: "inject",
            mask: INJECT,
            attaches: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_is_capture_plus_journal_playback() {
        assert_eq!(INJECT.0 & CAPTURE.0, CAPTURE.0);
        assert_eq!(INJECT.0 & !CAPTURE.0, DESKTOP_JOURNALPLAYBACK.0);
    }

    #[test]
    fn the_arm_names_resolve_to_the_masks_the_memo_reports() {
        assert_eq!(by_name("capture").mask.0, CAPTURE.0);
        assert!(by_name("capture").attaches);
        assert_eq!(by_name("inject").mask.0, INJECT.0);
        assert!(!by_name("none").attaches);
    }

    #[test]
    fn an_unknown_arm_falls_back_to_inject_not_to_capture() {
        let fallback = by_name("injct");
        assert_eq!(fallback.name, "inject");
        assert_eq!(fallback.mask.0, INJECT.0);
    }
}
