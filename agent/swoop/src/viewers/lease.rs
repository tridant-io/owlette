//! §10's lease ledger: when each viewer's 5-minute lease lapses, and what the
//! session owes a viewer whose lease did.
//!
//! Two rules from §10 and review-2 M4 are the whole of this module:
//!
//! 1. **the expiry is derived from the bundle's time anchor plus monotonic
//!    elapsed, never the kiosk clock.** these are signage boxes whose wall
//!    clocks drift by minutes; a lease checked against `SystemTime::now()`
//!    either drops every viewer on a box that is fast or never drops one on a
//!    box that is slow.
//! 2. **a lapse is not a deadline.** the browser renews at ~60 % of the lease's
//!    life, so a renewal that is merely late — a tab that was backgrounded, a
//!    round trip that took a moment — must not cost the operator the session.
//!    the viewer is dropped at `expiry + 30 s` and not before.
//!
//! the ledger is the bookkeeping only. the session loop owns the acting on it:
//! on every [`lapsed`](LeaseLedger::lapsed) id it must
//! `input_tx.send(ToInput::ReleaseAll)` (trigger 1 of the four `release_all`
//! triggers — `SendInput` does not reset keyboard state, so a viewer dropped
//! mid-chord leaves those keys down forever), close that viewer's peer, call
//! `SignalClient::end_viewer(viewer, LeftReason::LeaseExpired)` and report the
//! drop to `/api/agent/swoop/events`. keeping that here would put the peer, the
//! input thread and the socket inside a type whose job is one integer per
//! viewer.

use std::collections::BTreeMap;
use std::time::Duration;

use crate::bundle::{Bundle, TimeAnchor};

/// §10's grace on a missed renewal. A lease is not a deadline; see the module
/// comment.
pub const LEASE_GRACE: Duration = Duration::from_secs(30);

/// The default when a bundle names no `leaseSeconds` of its own (§10).
pub const DEFAULT_LEASE_SECONDS: u64 = 300;

/// Per-viewer lease expiry, in the streamer's own time base.
#[derive(Debug)]
pub struct LeaseLedger {
    anchor: TimeAnchor,
    lease_seconds: u64,
    grace_seconds: i64,
    /// viewer id → unix seconds, on the anchor's clock.
    expiries: BTreeMap<String, i64>,
}

impl LeaseLedger {
    pub fn new(anchor: TimeAnchor, lease_seconds: u64) -> Self {
        Self {
            anchor,
            lease_seconds: lease_seconds.max(1),
            grace_seconds: LEASE_GRACE.as_secs() as i64,
            expiries: BTreeMap::new(),
        }
    }

    /// The ledger this bundle describes: its anchor and its `leaseSeconds`.
    pub fn from_bundle(bundle: &Bundle) -> Self {
        Self::new(bundle.time_anchor(), bundle.enablement.lease_seconds)
    }

    /// The streamer's idea of now, in unix seconds. Anchor plus monotonic
    /// elapsed, never the wall clock.
    pub fn now_unix(&self) -> i64 {
        self.anchor.now_unix()
    }

    /// A verified `lease` token starts or renews this viewer's lease, and
    /// returns the `expiresAt` §10 puts on the `lease-ok` answer.
    ///
    /// The expiry is the host's own arithmetic on purpose: the token beside it
    /// carries a 60-second `exp`, which is the life of the *token*, not of the
    /// lease, and answering with that would tell the browser to renew five
    /// times a minute.
    pub fn renew(&mut self, viewer: &str) -> i64 {
        let expires_at = self.now_unix().saturating_add(self.lease_seconds as i64);
        self.expiries.insert(viewer.to_owned(), expires_at);
        expires_at
    }

    /// Forget a viewer that has left by any other road — a `bye`, a kill, a
    /// dead peer. A stale entry would otherwise be reported as a lapse long
    /// after the viewer went.
    pub fn forget(&mut self, viewer: &str) {
        self.expiries.remove(viewer);
    }

    /// When this viewer's lease lapses, if it holds one.
    pub fn expires_at(&self, viewer: &str) -> Option<i64> {
        self.expiries.get(viewer).copied()
    }

    /// Every viewer past `expiry + 30 s`, oldest lease first, so the session
    /// loop drops them in the order they lapsed.
    ///
    /// Reporting is not forgetting: the caller drops the viewer and calls
    /// [`forget`](Self::forget), because until the peer is actually closed the
    /// viewer is still there.
    pub fn lapsed(&self) -> Vec<String> {
        let now = self.now_unix();
        let mut out: Vec<(i64, &str)> = self
            .expiries
            .iter()
            .filter(|(_, expires_at)| now >= expires_at.saturating_add(self.grace_seconds))
            .map(|(viewer, expires_at)| (*expires_at, viewer.as_str()))
            .collect();
        out.sort_unstable();
        out.into_iter().map(|(_, viewer)| viewer.to_owned()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEASE_S: u64 = 300;

    /// An anchor read `elapsed` ago, so a lease can be aged without sleeping.
    fn ledger_aged(elapsed: Duration) -> LeaseLedger {
        LeaseLedger::new(TimeAnchor::with_elapsed(1_000_000, elapsed), LEASE_S)
    }

    #[test]
    fn a_renewal_expires_one_lease_from_now_not_when_the_token_does() {
        let mut ledger = ledger_aged(Duration::ZERO);
        let expires_at = ledger.renew("viewer-a");
        assert_eq!(expires_at, 1_000_000 + LEASE_S as i64);
        assert_eq!(ledger.expires_at("viewer-a"), Some(expires_at));
    }

    /// The point of the anchor: the expiry moves with monotonic elapsed time,
    /// so a box whose wall clock is wrong still measures five minutes.
    #[test]
    fn the_expiry_is_anchor_plus_monotonic_elapsed() {
        let mut ledger = ledger_aged(Duration::from_secs(90));
        assert_eq!(ledger.now_unix(), 1_000_090);
        assert_eq!(ledger.renew("viewer-a"), 1_000_090 + LEASE_S as i64);
    }

    #[test]
    fn a_live_lease_has_not_lapsed() {
        let mut ledger = ledger_aged(Duration::ZERO);
        ledger.renew("viewer-a");
        assert!(ledger.lapsed().is_empty());
    }

    /// §10's grace, both sides of it: a renewal that is merely late costs
    /// nothing, and one that never comes costs the viewer its session.
    #[test]
    fn a_lease_lapses_only_after_the_grace() {
        let mut ledger = ledger_aged(Duration::ZERO);
        ledger.renew("viewer-a");

        let inside = ledger_from(&ledger, Duration::from_secs(LEASE_S + 29));
        assert!(inside.lapsed().is_empty(), "29 s past expiry is inside the grace");

        let outside = ledger_from(&ledger, Duration::from_secs(LEASE_S + 30));
        assert_eq!(outside.lapsed(), vec!["viewer-a".to_string()]);
    }

    /// One expired lease never ends anyone else's session (§10).
    #[test]
    fn only_the_lapsed_viewer_is_reported() {
        let mut ledger = ledger_aged(Duration::from_secs(LEASE_S + 30));
        ledger.renew("fresh");
        // `stale` renewed a whole lease plus the grace ago.
        ledger.expiries.insert("stale".to_string(), 1_000_000);
        assert_eq!(ledger.lapsed(), vec!["stale".to_string()]);
    }

    #[test]
    fn a_viewer_that_left_is_never_reported_as_lapsed() {
        let mut ledger = ledger_aged(Duration::ZERO);
        ledger.renew("viewer-a");
        ledger.forget("viewer-a");
        let later = ledger_from(&ledger, Duration::from_secs(LEASE_S + 600));
        assert!(later.lapsed().is_empty());
        assert_eq!(later.expires_at("viewer-a"), None);
    }

    #[test]
    fn lapsed_viewers_come_back_in_the_order_they_lapsed() {
        let mut ledger = ledger_aged(Duration::from_secs(10_000));
        ledger.expiries.insert("second".to_string(), 1_000_200);
        ledger.expiries.insert("first".to_string(), 1_000_100);
        assert_eq!(ledger.lapsed(), vec!["first".to_string(), "second".to_string()]);
    }

    /// The whole of what a lapse owes the machine: the viewer is reported, and
    /// everything it was holding comes back up. A viewer dropped mid-chord with
    /// its keys still down is the bug `release_all` exists for.
    #[test]
    fn a_lapse_releases_every_key_and_button_the_viewer_held() {
        use crate::input::{InputEvent, ViewerInput};
        use crate::signal::messages::channel::Input;
        use std::time::Instant;

        let mut ledger = ledger_aged(Duration::ZERO);
        ledger.renew("viewer-a");

        let now = Instant::now();
        let mut held = ViewerInput::new(now);
        held.accept(
            &Input::K { code: "ShiftLeft".to_string(), down: true, seq: 1, ts_us: 0 },
            now,
        );
        held.accept(&Input::B { button: 0, down: true, seq: 2, ts_us: 0 }, now);
        assert!(held.holding());

        let lapsed = ledger_from(&ledger, Duration::from_secs(LEASE_S + 30));
        assert_eq!(lapsed.lapsed(), vec!["viewer-a".to_string()]);

        let released = held.release_all();
        assert!(!held.holding(), "nothing is left down");
        assert!(
            released
                .iter()
                .all(|event| matches!(event, InputEvent::MouseButton { down: false, .. }
                    | InputEvent::Key { down: false, .. }
                    | InputEvent::KeyVirtual { down: false, .. })),
            "{released:?}"
        );
        assert_eq!(released.len(), 2, "one up per thing held: {released:?}");
    }

    /// Re-read the same expiries through an anchor that is `elapsed` old.
    fn ledger_from(source: &LeaseLedger, elapsed: Duration) -> LeaseLedger {
        let mut ledger = ledger_aged(elapsed);
        ledger.expiries = source.expiries.clone();
        ledger
    }
}
