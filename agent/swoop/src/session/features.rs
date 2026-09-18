//! The feature registry: the list of host features, and how one is added.
//!
//! # The contract, settled
//!
//! **Each feature module exports `pub fn feature() -> Box<dyn Feature>` and
//! [`registry`] calls it.** A task that fills a module edits *its own module
//! and nothing else* — four of them land in parallel, and one shared file is
//! the collision this arrangement exists to avoid. [`FEATURE_NAMES`] is the
//! only place a feature is named; the tests below fail if a module's
//! [`Feature::name`] drifts from its entry, so the loop and the tests cannot
//! disagree about what is running.
//!
//! # The seam
//!
//! A feature owns no IO. The session thread drives it, the same way the loop
//! drives `VideoSink` and `SignalClient`:
//!
//! - [`Feature::start`] is handed a [`SessionHandle`] — facts only, because a
//!   feature starts before any viewer has joined and there is nothing to write
//!   to yet.
//! - Inbound data-channel traffic arrives at [`Feature::on_message`], with the
//!   channel it came in on and this host's own `ctl` verdict for the viewer
//!   that sent it. Clipboard rides `swoop-control` (§5 — there are five
//!   channels, not six), so a feature sees that channel's traffic whether or
//!   not the session recognised the payload itself.
//! - Outbound goes into the [`Outbox`] that [`Feature::poll`] is lent for
//!   exactly one call. The session drains it and writes it. It is bounded and
//!   rate-limited; read [`Outbox`] before you queue anything from it.
//! - The same outbox carries [`FeatureRequest`]s — the only way to reach a
//!   worker thread, the service or the audit route, all of which belong to the
//!   session. `Sas` is answered on [`Feature::on_sas_result`], routed back to
//!   whichever feature asked for it and to nothing else.
//! - [`Feature::status`] is *pulled* once per §6 `status` event, whether or not
//!   a viewer is connected, and each feature fills only its own field of
//!   [`FeatureStatus`].
//! - [`Feature::hello_displays`] is the one contribution to §5's `hello-host`.
//!   `signal/messages.rs` is frozen, so a display list cannot be a new message:
//!   it rides the field that already exists.
//! - [`Feature::stop`] runs in reverse registration order.
//!
//! Everything but `name`, `start` and `stop` defaults to nothing, so a feature
//! that needs none of it stays three methods long.
//!
//! The session thread is the **sole writer of stdout** and the only thing that
//! touches the peer. Anything that has to block — a clipboard listener, a
//! desktop watcher, an audio client — runs on its own thread and hands its
//! results back over a channel the feature itself owns; `poll` then moves them
//! into the outbox. A feature that writes stdout or the peer directly is a bug.
//!
//! # Why `cursor` is not in the list
//!
//! It never was a registry feature. The real cursor path is `CursorTracker` and
//! `PointerReader` on the **capture thread** — a `Frame`'s pointer metadata is
//! only readable there — and it reaches the viewer as `FromWorker::Cursor` on
//! `Channel::SwoopCursor`. A registry entry for it could only ever be a no-op,
//! and a name here with nothing behind it is something a later task trips over.

use super::{Feature, SessionHandle};

/// Every feature the host session offers, in start order. Stops run in reverse.
#[cfg(windows)]
pub const FEATURE_NAMES: [&str; 4] = ["clipboard", "audio", "displays", "securedesk"];

/// Window stations and desktops have no portable analogue, so `lib.rs` gates
/// `securedesk` to Windows and this list is three long everywhere else.
#[cfg(not(windows))]
pub const FEATURE_NAMES: [&str; 3] = ["clipboard", "audio", "displays"];

/// A named feature that does nothing.
struct Stub(&'static str);

impl Feature for Stub {
    fn name(&self) -> &'static str {
        self.0
    }

    fn start(&mut self, _session: &SessionHandle) -> anyhow::Result<()> {
        Ok(())
    }

    fn stop(&mut self) {}
}

/// What a module returns from `feature()` until it is written, so the four
/// stubs do not carry four copies of the same empty impl. Delete it when the
/// last one stops calling it.
pub fn stub(name: &'static str) -> Box<dyn Feature> {
    Box::new(Stub(name))
}

/// Build the feature set for one session.
pub fn registry() -> Vec<Box<dyn Feature>> {
    #[allow(unused_mut)]
    let mut features = vec![
        crate::clipboard::feature(),
        crate::audio::feature(),
        crate::displays::feature(),
    ];
    #[cfg(windows)]
    features.push(crate::securedesk::feature());
    features
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{FeatureRequest, FeatureStatus, Outbox};
    use crate::signal::messages::channel::Channel;
    use std::collections::HashSet;
    use std::time::Instant;

    fn handle() -> SessionHandle {
        SessionHandle {
            sid: "sid_test".to_owned(),
            indicator: crate::bundle::Indicator::Banner,
            ctl: true,
            source: (1920, 1080),
        }
    }

    #[test]
    fn registry_has_one_entry_per_named_feature() {
        let names: Vec<&str> = registry().iter().map(|f| f.name()).collect();
        assert_eq!(names, FEATURE_NAMES.to_vec());
    }

    #[test]
    fn feature_names_are_unique() {
        let unique: HashSet<&&str> = FEATURE_NAMES.iter().collect();
        assert_eq!(unique.len(), FEATURE_NAMES.len());
    }

    #[test]
    fn every_feature_starts_and_stops() {
        for mut feature in registry() {
            feature
                .start(&handle())
                .unwrap_or_else(|e| panic!("feature {} did not start: {e}", feature.name()));
            feature.stop();
        }
    }

    /// The session offers every feature every payload on a channel it may see,
    /// including ones meant for a different feature. Not recognising one is
    /// normal and is never an error.
    #[test]
    fn every_feature_ignores_a_message_it_does_not_own() {
        let mut out = Outbox::new(Instant::now());
        for mut feature in registry() {
            feature
                .start(&handle())
                .unwrap_or_else(|e| panic!("feature {} did not start: {e}", feature.name()));
            for channel in [Channel::SwoopControl, Channel::SwoopInput, Channel::SwoopFeedback] {
                feature
                    .on_message(channel, false, br#"{"t":"not-yours"}"#)
                    .unwrap_or_else(|e| panic!("feature {} errored on {channel:?}: {e}", feature.name()));
            }
            feature.poll(Instant::now(), &mut out);
            feature.stop();
        }
    }

    /// The defaulted half of the seam, which is what lets a feature that needs
    /// none of it stay three methods long: nothing said on `status`, nothing
    /// contributed to `hello-host`, and an answer to a question it never put
    /// is not an error.
    #[test]
    fn a_feature_that_defines_none_of_the_optional_methods_contributes_nothing() {
        let mut status = FeatureStatus::default();
        for mut feature in registry() {
            feature.on_sas_result(true);
            feature.status(&mut status);
            assert!(
                feature.hello_displays().is_empty(),
                "feature {} advertised a display list",
                feature.name()
            );
        }
        assert_eq!(status, FeatureStatus::default());
    }

    /// The request path is reachable from the same outbox a feature is lent,
    /// and it is drained per feature — the session has to know who asked.
    #[test]
    fn a_feature_asks_through_the_outbox_it_already_holds() {
        let mut out = Outbox::new(Instant::now());
        assert!(out.request(FeatureRequest::Sas));
        assert_eq!(out.take_requests(), vec![FeatureRequest::Sas]);
        assert!(out.take_requests().is_empty());
    }
}
