//! Who gets in, how fast, and what is written down when someone does not.
//!
//! Three limits, all of them the host's own and none of them the room's: the
//! worker caps viewers per room too, but it is a relay we do not trust to have
//! done it. Every refusal produces a [`Denial`], which the session forwards to
//! `POST /api/agent/swoop/events` (Task 3.3's route) so it reaches the site's
//! `audit_log` — a denial nobody records is a denial nobody can investigate.
//!
//! A `Denial` carries a viewer id and a reason and never a token, a claim set,
//! a fingerprint or a key (§11).

use std::collections::VecDeque;
use std::fmt;
use std::time::{Duration, Instant};

use crate::bundle::{Enablement, TokenError};

/// The admission limits for one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// From the bundle's `enablement`.
    pub max_viewers: u32,
    /// The floor between two joins, whoever they are. A session is opened by a
    /// person clicking a button, so anything faster is a script.
    pub min_join_interval: Duration,
    /// At most `join_burst` joins in `join_window`, counted across the session.
    pub join_burst: u32,
    pub join_window: Duration,
}

impl Limits {
    /// The defaults beside the bundle's viewer cap. They are the host's own
    /// judgement rather than policy the api sends, so they live here: a user
    /// reconnecting after a flaky network needs several joins a minute, and
    /// nothing legitimate needs ten.
    pub fn from_enablement(enablement: &Enablement) -> Self {
        Self {
            max_viewers: enablement.max_viewers,
            min_join_interval: Duration::from_secs(2),
            join_burst: 10,
            join_window: Duration::from_secs(300),
        }
    }
}

/// Why a viewer was refused. This is the host's audit vocabulary, not §2's
/// error table: the room refuses frames, the host refuses people.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenialReason {
    /// The session is already serving `max_viewers`.
    TooManyViewers,
    /// Inside `min_join_interval` of the previous join.
    JoinTooSoon,
    /// `join_burst` joins already in `join_window`.
    JoinRateExceeded,
    /// A frame naming a viewer the host never admitted.
    UnknownViewer,
    /// An offer with no `a=fingerprint:` line — there is nothing to bind a
    /// token's `fp` to, so it is refused rather than admitted unbound.
    OfferFingerprintMissing,
    /// The token verified, but for a different viewer than the socket the room
    /// forwarded it from.
    ViewerMismatch,
    /// §11's verification order refused it. The reason is the token's own.
    Token(TokenError),
}

impl DenialReason {
    pub fn reason(self) -> &'static str {
        match self {
            DenialReason::TooManyViewers => "too_many_viewers",
            DenialReason::JoinTooSoon => "join_too_soon",
            DenialReason::JoinRateExceeded => "join_rate_exceeded",
            DenialReason::UnknownViewer => "unknown_viewer",
            DenialReason::OfferFingerprintMissing => "offer_fingerprint_missing",
            DenialReason::ViewerMismatch => "viewer_mismatch",
            DenialReason::Token(error) => error.reason(),
        }
    }
}

impl fmt::Display for DenialReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason())
    }
}

/// One refusal, as the audit trail records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Denial {
    pub viewer: String,
    pub reason: DenialReason,
}

impl Denial {
    pub fn new(viewer: impl Into<String>, reason: DenialReason) -> Self {
        Self { viewer: viewer.into(), reason }
    }
}

impl fmt::Display for Denial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.viewer, self.reason)
    }
}

/// The three limits, over the monotonic clock.
///
/// `Instant` throughout, and `now` is a parameter: the wall clock is never
/// consulted anywhere in a swoop session (§11), and a rate limiter that read it
/// would be the one place a drifted kiosk clock could still open the door.
#[derive(Debug)]
pub struct Admission {
    limits: Limits,
    live: u32,
    last_join: Option<Instant>,
    window: VecDeque<Instant>,
}

impl Admission {
    pub fn new(limits: Limits) -> Self {
        Self { limits, live: 0, last_join: None, window: VecDeque::new() }
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    pub fn live(&self) -> u32 {
        self.live
    }

    /// Admit a viewer, or refuse it. The counters move only on an admission, so
    /// a refused join cannot itself consume the burst window — otherwise one
    /// rejected script would lock out the person waiting behind it.
    pub fn admit(&mut self, viewer: &str, now: Instant) -> Result<(), Denial> {
        while let Some(&oldest) = self.window.front() {
            if now.duration_since(oldest) >= self.limits.join_window {
                self.window.pop_front();
            } else {
                break;
            }
        }

        if self.live >= self.limits.max_viewers {
            return Err(Denial::new(viewer, DenialReason::TooManyViewers));
        }
        if let Some(last) = self.last_join {
            if now.duration_since(last) < self.limits.min_join_interval {
                return Err(Denial::new(viewer, DenialReason::JoinTooSoon));
            }
        }
        if self.window.len() as u32 >= self.limits.join_burst {
            return Err(Denial::new(viewer, DenialReason::JoinRateExceeded));
        }

        self.live += 1;
        self.last_join = Some(now);
        self.window.push_back(now);
        Ok(())
    }

    /// A viewer left. The burst window deliberately does not forget it: leaving
    /// and rejoining is exactly the pattern the window exists to bound.
    pub fn release(&mut self) {
        self.live = self.live.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits {
            max_viewers: 2,
            min_join_interval: Duration::from_secs(2),
            join_burst: 3,
            join_window: Duration::from_secs(60),
        }
    }

    #[test]
    fn a_full_session_refuses_the_next_viewer() {
        let start = Instant::now();
        let mut admission = Admission::new(limits());
        assert_eq!(admission.admit("viewer_1", start), Ok(()));
        assert_eq!(admission.admit("viewer_2", start + Duration::from_secs(3)), Ok(()));
        assert_eq!(
            admission.admit("viewer_3", start + Duration::from_secs(6)),
            Err(Denial::new("viewer_3", DenialReason::TooManyViewers))
        );
        assert_eq!(admission.live(), 2);

        // and the slot comes back when someone leaves.
        admission.release();
        assert_eq!(admission.admit("viewer_3", start + Duration::from_secs(9)), Ok(()));
    }

    #[test]
    fn two_joins_in_the_same_second_are_refused() {
        let start = Instant::now();
        let mut admission = Admission::new(limits());
        assert_eq!(admission.admit("viewer_1", start), Ok(()));
        assert_eq!(
            admission.admit("viewer_2", start + Duration::from_millis(1999)),
            Err(Denial::new("viewer_2", DenialReason::JoinTooSoon))
        );
        // the refusal did not consume the interval, so the next honest join at
        // the boundary still gets in.
        assert_eq!(admission.admit("viewer_2", start + Duration::from_secs(2)), Ok(()));
    }

    #[test]
    fn a_join_flood_is_refused_until_the_window_rolls_off() {
        let start = Instant::now();
        let mut admission = Admission::new(limits());
        for n in 0..3 {
            let at = start + Duration::from_secs(n * 3);
            assert_eq!(admission.admit("viewer_1", at), Ok(()));
            admission.release();
        }
        assert_eq!(
            admission.admit("viewer_1", start + Duration::from_secs(12)),
            Err(Denial::new("viewer_1", DenialReason::JoinRateExceeded))
        );
        // one window later the oldest join has aged out.
        assert_eq!(admission.admit("viewer_1", start + Duration::from_secs(61)), Ok(()));
    }

    #[test]
    fn every_denial_reason_has_its_own_spelling() {
        let reasons = [
            DenialReason::TooManyViewers,
            DenialReason::JoinTooSoon,
            DenialReason::JoinRateExceeded,
            DenialReason::UnknownViewer,
            DenialReason::OfferFingerprintMissing,
            DenialReason::ViewerMismatch,
            DenialReason::Token(TokenError::FpMissing),
        ];
        let mut seen = std::collections::HashSet::new();
        for reason in reasons {
            assert!(seen.insert(reason.reason()), "{reason} is spelled twice");
        }
        assert_eq!(DenialReason::Token(TokenError::FpMissing).reason(), "fp_missing");
    }
}
