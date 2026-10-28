//! The secure desktop: which desktop is in front, and ctrl+alt+del.
//!
//! Following the input desktop is not here. A desktop attachment belongs to a
//! thread, so capture (`capture::DesktopWatcher`) and input (`input`'s
//! `InputDesktop`) each follow it on their own thread, and that is what makes a
//! UAC prompt, the lock screen and the logon screen visible and drivable. This
//! feature adds the two things a session needs on top:
//!
//! - §6's `status` names the input desktop. A UAC prompt, the lock screen and
//!   the logon screen are all `winlogon`.
//! - §5's `sas`. `SendSAS` called from this process — SYSTEM, but in the
//!   console session — returns and raises nothing (spike 0.3 §8.4); the
//!   function only honours a caller in session 0. So the streamer asks on
//!   stdout and the service calls it, and the answer comes back on stdin.

use std::time::{Duration, Instant};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
    DESKTOP_READOBJECTS, UOI_NAME,
};

use crate::clipboard::formats::{desktop_from_name, text_from_utf16};
use crate::ipc::Desktop;
use crate::session::{Feature, FeatureRequest, FeatureStatus, Outbox, SessionHandle};
use crate::signal::messages::channel::{Channel, Control};

/// How long an unanswered ctrl+alt+del holds back the next one. The service
/// answers in milliseconds; one that never does must not leave the menu item
/// dead for the rest of the session.
const SAS_ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a raised one holds back the next: the service's own floor, so a
/// quick repeat is dropped here rather than answered "refused" over the
/// security screen it already raised.
const SAS_REPEAT_FLOOR: Duration = Duration::from_secs(2);

pub fn feature() -> Box<dyn Feature> {
    Box::new(SecureDesk::default())
}

#[derive(Default)]
struct SecureDesk {
    started: bool,
    /// A controlling viewer asked, and the request has not reached the session.
    wanted: bool,
    /// When the last request was made, and whether the service raised it.
    asked: Option<(Instant, bool)>,
    /// The desktop the last `status` named, so a switch is logged once.
    reported: Option<Desktop>,
}

impl Feature for SecureDesk {
    fn name(&self) -> &'static str {
        "securedesk"
    }

    fn start(&mut self, _session: &SessionHandle) -> anyhow::Result<()> {
        self.started = true;
        Ok(())
    }

    fn stop(&mut self) {
        self.started = false;
    }

    fn on_message(&mut self, channel: Channel, ctl: bool, payload: &[u8]) -> anyhow::Result<()> {
        if channel != Channel::SwoopControl {
            return Ok(());
        }
        let Ok(Control::Sas) = serde_json::from_slice::<Control>(payload) else {
            return Ok(());
        };
        // The session denies and reports the ungated attempt itself.
        if ctl {
            self.wanted = true;
        }
        Ok(())
    }

    fn poll(&mut self, now: Instant, out: &mut Outbox) {
        if !self.wanted {
            return;
        }
        // A second click while the first is with the service, or just after
        // it raised the screen, is the same request, not another one.
        if let Some((at, raised)) = self.asked {
            let hold = if raised { SAS_REPEAT_FLOOR } else { SAS_ANSWER_TIMEOUT };
            if now.duration_since(at) < hold {
                self.wanted = false;
                return;
            }
        }
        if out.request(FeatureRequest::Sas) {
            self.wanted = false;
            self.asked = Some((now, false));
        }
    }

    fn on_sas_result(&mut self, ok: bool) {
        if ok {
            self.asked = self.asked.map(|(at, _)| (at, true));
        } else {
            self.asked = None;
            ::log::warn!("swoop: the service did not raise ctrl+alt+del");
        }
    }

    fn status(&mut self, out: &mut FeatureStatus) {
        // `None` until start, like every other field: a feature that has not
        // run has nothing to say.
        if !self.started {
            return;
        }
        let desktop = input_desktop();
        if self.reported != Some(desktop) {
            ::log::info!("swoop: the input desktop is {desktop:?}");
            self.reported = Some(desktop);
        }
        out.desktop = Some(desktop);
    }
}

/// The input desktop by name, without attaching to it.
///
/// A failed `OpenInputDesktop` is [`Desktop::Unknown`], never a lock: it is
/// equally a switch in progress or a thread without rights to the desktop
/// that is now current.
pub(crate) fn input_desktop() -> Desktop {
    let opened = unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) };
    let Ok(desktop) = opened else {
        return Desktop::Unknown;
    };
    let mut buffer = [0u16; 128];
    let mut needed = 0u32;
    let named = unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(buffer.as_mut_ptr().cast()),
            std::mem::size_of_val(&buffer) as u32,
            Some(&mut needed),
        )
    };
    let _ = unsafe { CloseDesktop(desktop) };
    if named.is_err() {
        return Desktop::Unknown;
    }
    desktop_from_name(&text_from_utf16(&buffer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::Indicator;

    fn started() -> SecureDesk {
        let mut feature = SecureDesk::default();
        feature
            .start(&SessionHandle {
                sid: "sid_test".to_owned(),
                indicator: Indicator::Banner,
                ctl: true,
                source: (1920, 1080),
            })
            .expect("start");
        feature
    }

    fn sas(feature: &mut SecureDesk, ctl: bool) {
        feature
            .on_message(Channel::SwoopControl, ctl, br#"{"t":"sas"}"#)
            .expect("a sas is this feature's");
    }

    #[test]
    fn a_controller_asks_the_service_once() {
        let mut feature = started();
        let mut out = Outbox::new(Instant::now());
        sas(&mut feature, true);
        feature.poll(Instant::now(), &mut out);
        assert_eq!(out.take_requests(), vec![FeatureRequest::Sas]);
        feature.poll(Instant::now(), &mut out);
        assert!(out.take_requests().is_empty(), "one click is one request");
    }

    #[test]
    fn a_watcher_cannot_ask() {
        let mut feature = started();
        let mut out = Outbox::new(Instant::now());
        sas(&mut feature, false);
        feature.poll(Instant::now(), &mut out);
        assert!(out.take_requests().is_empty());
    }

    #[test]
    fn a_second_click_waits_for_the_answer_to_the_first() {
        let mut feature = started();
        let mut out = Outbox::new(Instant::now());
        let t0 = Instant::now();
        sas(&mut feature, true);
        feature.poll(t0, &mut out);
        assert_eq!(out.take_requests().len(), 1);

        sas(&mut feature, true);
        feature.poll(t0 + Duration::from_millis(300), &mut out);
        assert!(out.take_requests().is_empty(), "the first is still with the service");

        feature.on_sas_result(true);
        sas(&mut feature, true);
        feature.poll(t0 + Duration::from_millis(600), &mut out);
        assert!(out.take_requests().is_empty(), "the screen it raised is still up");

        sas(&mut feature, true);
        feature.poll(t0 + SAS_REPEAT_FLOOR, &mut out);
        assert_eq!(out.take_requests(), vec![FeatureRequest::Sas]);
    }

    #[test]
    fn a_refusal_can_be_retried_at_once() {
        let mut feature = started();
        let mut out = Outbox::new(Instant::now());
        let t0 = Instant::now();
        sas(&mut feature, true);
        feature.poll(t0, &mut out);
        assert_eq!(out.take_requests().len(), 1);

        feature.on_sas_result(false);
        sas(&mut feature, true);
        feature.poll(t0 + Duration::from_millis(100), &mut out);
        assert_eq!(out.take_requests(), vec![FeatureRequest::Sas]);
    }

    #[test]
    fn a_service_that_never_answers_does_not_disable_the_key() {
        let mut feature = started();
        let mut out = Outbox::new(Instant::now());
        let t0 = Instant::now();
        sas(&mut feature, true);
        feature.poll(t0, &mut out);
        assert_eq!(out.take_requests().len(), 1);

        sas(&mut feature, true);
        feature.poll(t0 + SAS_ANSWER_TIMEOUT, &mut out);
        assert_eq!(out.take_requests(), vec![FeatureRequest::Sas]);
    }

    #[test]
    fn other_control_messages_are_not_a_sas() {
        let mut feature = started();
        let mut out = Outbox::new(Instant::now());
        feature
            .on_message(Channel::SwoopControl, true, br#"{"t":"idr"}"#)
            .expect("not this feature's");
        feature
            .on_message(Channel::SwoopInput, true, br#"{"t":"sas"}"#)
            .expect("wrong channel");
        feature.poll(Instant::now(), &mut out);
        assert!(out.take_requests().is_empty());
    }

    #[test]
    fn status_names_the_desktop_once_started() {
        let mut status = FeatureStatus::default();
        SecureDesk::default().status(&mut status);
        assert_eq!(status.desktop, None, "nothing to say before start");

        started().status(&mut status);
        assert!(status.desktop.is_some());
    }
}
