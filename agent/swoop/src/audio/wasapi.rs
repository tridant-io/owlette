//! The WASAPI side of host audio: the render endpoint, and what swoop will not
//! do to it.
//!
//! swoop **never creates a virtual device and never moves the default render
//! endpoint.** A signage box's audio routing belongs to whoever set the box up,
//! and a remote session that changed it would still have changed it after the
//! session ended. So the only thing this module asks the audio stack is whether
//! a default render endpoint exists at all — that is the fact `status` carries
//! (`ipc::AudioState`), and it is pulled whether or not a viewer is connected,
//! because a box with no audio endpoint is exactly what wants reporting while
//! nobody is watching.
//!
//! # The loopback client is not here, and it is blocked on the manifest
//!
//! Capture itself — `IAudioClient::Initialize` with
//! `AUDCLNT_SHAREMODE_SHARED | AUDCLNT_STREAMFLAGS_LOOPBACK |
//! AUDCLNT_STREAMFLAGS_EVENTCALLBACK`, `SetEventHandle`, an
//! `AvSetMmThreadCharacteristics("Pro Audio")` thread — needs an `IAudioClient`,
//! and there is no way to activate one under this crate's pinned feature set:
//!
//! - `IMMDevice::Activate<T>` is generated behind
//!   `Win32_System_Com_StructuredStorage` **and** `Win32_System_Variant`, for
//!   the `PROPVARIANT` activation-params pointer it is always handed as null.
//!   Without both features the vtable slot is a private `usize` and the method
//!   does not exist.
//! - `ActivateAudioInterfaceAsync` is behind the same pair, for the same
//!   parameter.
//!
//! `Cargo.toml` names `Win32_Media_Audio` as being "for the WASAPI loopback
//! capture", so this is a gap in that list rather than a decision — but the
//! manifest is the owner's, and hand-rolling the COM vtable to get around two
//! missing feature flags is not a trade this module makes. Adding those two
//! features to the existing `windows` dependency is all that is required; the
//! frame clock the capture feeds ([`super::opus::Timeline`]) is written and
//! tested, and so is the RTP track it feeds in turn.
//!
//! # Hardware check (`#[ignore]`d)
//!
//! Reads the machine's real endpoint list. With the working directory
//! `agent/swoop`:
//!
//! ```text
//! cargo test --features audio-opus -- --ignored audio::wasapi --nocapture
//! ```
//!
//! Expected: `true` on this box, and `false` on a machine whose audio device is
//! disabled in Device Manager — which is the `no_endpoint` state the session
//! reports rather than stalling on. Note that once the loopback client above
//! lands, its own hardware test **listens to whatever the machine is playing**;
//! this one does not.

use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

/// Is there a default render endpoint at all?
///
/// COM must already be initialized on the calling thread. A machine with no
/// sound card, or with its audio device disabled, answers `false`; so does a
/// machine whose audio service is not running, which is the same thing to a
/// viewer.
pub fn render_endpoint_present() -> bool {
    unsafe {
        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return false;
        };
        enumerator.GetDefaultAudioEndpoint(eRender, eConsole).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hardware. See the module doc for what each answer means.
    #[test]
    #[ignore]
    fn reports_whether_this_machine_has_a_render_endpoint() {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .expect("com on the test thread");
        println!("render endpoint present: {}", render_endpoint_present());
    }
}
