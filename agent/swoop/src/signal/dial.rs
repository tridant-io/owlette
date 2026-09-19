//! Dialling the room: what to dial, how to read a refusal, and when to stop.
//!
//! §1: the agent dials `GET /v1/room/{site}/{machine}` with
//! `Authorization: Bearer <host token>` and the subprotocol
//! [`SUBPROTOCOL`]. A worker that does not recognise the subprotocol refuses
//! the upgrade, so it is offered on every dial.
//!
//! No socket lives here: [`super::socket`] owns the one in this crate. This
//! module decides *what* to dial, how to read a refusal, and when to give up
//! with exit 14 — all of it without opening anything.

use std::fmt;
use std::time::Duration;

use crate::bundle::Bundle;
use crate::ipc::Exit;

/// §1's subprotocol. Also every data channel's `protocol` field.
pub const SUBPROTOCOL: &str = "owlette.swoop.v1";

/// The worker's mid-socket auth close: 4000 + http 401.
pub const CLOSE_AUTH: u16 = 4401;
/// A flood limit was exceeded. Back off; a fresh token fixes nothing.
pub const CLOSE_FLOOD: u16 = 4008;

/// The auth-signal vocabulary, and it is exactly these three words. They appear
/// on all three surfaces the worker refuses on: the `x-swoop-error` header of a
/// refused handshake, the `code` of that refusal's body, and the `code` of the
/// `error` frame sent immediately before a [`CLOSE_AUTH`] close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthSignal {
    Auth,
    TokenExpired,
    UnknownKid,
}

impl AuthSignal {
    pub fn parse(code: &str) -> Option<Self> {
        match code {
            "auth" => Some(AuthSignal::Auth),
            "token_expired" => Some(AuthSignal::TokenExpired),
            "unknown_kid" => Some(AuthSignal::UnknownKid),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            AuthSignal::Auth => "auth",
            AuthSignal::TokenExpired => "token_expired",
            AuthSignal::UnknownKid => "unknown_kid",
        }
    }
}

impl fmt::Display for AuthSignal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

/// What to do about a refusal.
///
/// Only the three auth words buy a re-mint: a `kid` rotation must not cost every
/// machine in the fleet a full backoff ladder. Anything else — including a 403
/// `room_mismatch`, a 429 and every 5xx — backs off, because re-minting would
/// not change the answer and would hammer the api while the worker is down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reaction {
    /// Fetch a fresh bundle and redial at once.
    Remint(AuthSignal),
    /// Walk the ladder.
    Backoff,
}

/// Why a bundle's `signalUrl` could not be dialled. Carries no detail: §7 keeps
/// every part of the bundle out of an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialError {
    /// Not a `wss://` (or, for a local worker, `ws://`) url.
    BadSignalUrl,
    /// The url names a room that is not this bundle's site and machine. The
    /// worker would answer 403 `room_mismatch`; catching it here saves the trip
    /// and the misleading refusal.
    RoomMismatch,
}

impl DialError {
    pub fn reason(self) -> &'static str {
        match self {
            DialError::BadSignalUrl => "bad_signal_url",
            DialError::RoomMismatch => "room_mismatch",
        }
    }
}

impl fmt::Display for DialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason())
    }
}

impl std::error::Error for DialError {}

/// The upgrade request, checked against the bundle it came from.
///
/// Deliberately has no derived `Debug`: the host token is in it.
pub struct Handshake<'a> {
    pub url: &'a str,
    token: &'a str,
}

impl<'a> Handshake<'a> {
    pub fn new(bundle: &'a Bundle) -> Result<Self, DialError> {
        let (scheme, _authority, path) =
            split_ws_url(&bundle.signal_url).ok_or(DialError::BadSignalUrl)?;
        // ws:// is for a `wrangler dev` worker on localhost and nothing else;
        // every fielded bundle carries wss.
        if scheme != "wss" && scheme != "ws" {
            return Err(DialError::BadSignalUrl);
        }
        if path != room_path(&bundle.site, &bundle.machine) {
            return Err(DialError::RoomMismatch);
        }
        Ok(Self { url: &bundle.signal_url, token: bundle.host_token.expose() })
    }

    /// The `Authorization` value, for the one call that opens the socket. Never
    /// for a logger, a url or an error.
    pub fn authorization(&self) -> String {
        format!("Bearer {}", self.token)
    }

    /// The single subprotocol the agent offers. A browser adds `jwt.<token>`
    /// beside it because it cannot set handshake headers; the agent never does,
    /// which is what keeps the host token out of every access log.
    pub fn subprotocols(&self) -> [&'static str; 1] {
        [SUBPROTOCOL]
    }
}

impl fmt::Debug for Handshake<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Handshake").field("url", &self.url).finish_non_exhaustive()
    }
}

/// `/v1/room/{site}/{machine}`. Both ids are `^[A-Za-z0-9_-]{1,64}$` by the time
/// a bundle parses, so there is nothing here to percent-encode.
pub fn room_path(site: &str, machine: &str) -> String {
    format!("/v1/room/{site}/{machine}")
}

/// `(scheme, authority, path)`. Hand-rolled because one url shape does not earn
/// a url crate, and the two ids inside it are already pattern-checked.
fn split_ws_url(url: &str) -> Option<(&str, &str, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() || rest.is_empty() {
        return None;
    }
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return None;
    }
    // a room url carries no query and no fragment; anything after one is not
    // part of the path we compare.
    let path = path.split(['?', '#']).next().unwrap_or(path);
    Some((scheme, authority, path))
}

/// A refused upgrade: the status and the `x-swoop-error` header, which exists
/// because a websocket client that fails the handshake often surfaces the status
/// and headers but not the body.
pub fn classify_handshake(status: u16, swoop_error: Option<&str>) -> Reaction {
    match (status, swoop_error.and_then(AuthSignal::parse)) {
        (401, Some(signal)) => Reaction::Remint(signal),
        _ => Reaction::Backoff,
    }
}

/// A closed socket: the close code, and the `code` of the `error` frame the room
/// sent immediately before it, where there was one.
pub fn classify_close(code: u16, last_error: Option<&str>) -> Reaction {
    match (code, last_error.and_then(AuthSignal::parse)) {
        (CLOSE_AUTH, Some(signal)) => Reaction::Remint(signal),
        // 4401 with no error frame is still the worker saying "your token": the
        // close code is the contract, the frame before it is the detail.
        (CLOSE_AUTH, None) => Reaction::Remint(AuthSignal::Auth),
        _ => Reaction::Backoff,
    }
}

/// Exponential backoff with full jitter, and a ceiling on attempts.
///
/// The streamer is not the doorbell: it is spawned for one session a user is
/// waiting on, so the ladder is short and ends in exit 14 rather than retrying
/// forever. The doorbell (`agent/src/swoop_doorbell.py`) is the component that
/// waits all day for a room to come back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Dials, not redials: 1 means a single attempt and no retry.
    pub attempts: u32,
    pub base: Duration,
    pub cap: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { attempts: 5, base: Duration::from_millis(250), cap: Duration::from_secs(4) }
    }
}

impl RetryPolicy {
    /// The delay before attempt `attempt` (0-based, so attempt 0 never waits).
    /// `jitter` is in `[0, 1)` and is a parameter rather than a call into `rand`
    /// so the ladder is testable; the caller draws it.
    pub fn delay(&self, attempt: u32, jitter: f64) -> Duration {
        if attempt == 0 {
            return Duration::ZERO;
        }
        let jitter = jitter.clamp(0.0, 1.0);
        let ceiling = self
            .base
            .saturating_mul(1u32 << (attempt - 1).min(16))
            .min(self.cap);
        ceiling.mul_f64(jitter)
    }

    /// True once `attempt` is past the last one this policy allows.
    pub fn exhausted(&self, attempt: u32) -> bool {
        attempt >= self.attempts
    }

    /// §6: a room that never answers is exit 14, not a panic and not a silent
    /// idle.
    pub fn exit(&self) -> Exit {
        Exit::SignalingUnreachable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle() -> Bundle {
        super::super::client::tests::golden_bundle()
    }

    #[test]
    fn the_handshake_is_built_from_the_bundle_and_never_prints_the_token() {
        let bundle = bundle();
        let handshake = Handshake::new(&bundle).expect("the golden bundle dials");
        assert_eq!(handshake.subprotocols(), [SUBPROTOCOL]);
        assert!(handshake.authorization().starts_with("Bearer "));

        let rendered = format!("{handshake:?}");
        assert!(!rendered.contains(bundle.host_token.expose()));
        assert!(rendered.contains("swoop-signal.example.invalid"));
    }

    #[test]
    fn a_signal_url_for_another_room_is_refused_before_it_is_dialled() {
        assert_eq!(
            split_ws_url("wss://host.invalid/v1/room/site_a/machine_a"),
            Some(("wss", "host.invalid", "/v1/room/site_a/machine_a"))
        );
        assert_eq!(split_ws_url("wss://host.invalid"), Some(("wss", "host.invalid", "/")));
        assert_eq!(split_ws_url("not a url"), None);
        assert_eq!(split_ws_url("wss://"), None);

        let mut bundle = bundle();
        bundle.signal_url = "wss://host.invalid/v1/room/site_other/machine_goldenvector".to_owned();
        assert_eq!(Handshake::new(&bundle).unwrap_err(), DialError::RoomMismatch);

        bundle.signal_url = "https://host.invalid/v1/room/site_goldenvector/machine_goldenvector".to_owned();
        assert_eq!(Handshake::new(&bundle).unwrap_err(), DialError::BadSignalUrl);
    }

    #[test]
    fn only_the_three_auth_words_buy_a_remint() {
        assert_eq!(
            classify_handshake(401, Some("unknown_kid")),
            Reaction::Remint(AuthSignal::UnknownKid)
        );
        assert_eq!(
            classify_handshake(401, Some("token_expired")),
            Reaction::Remint(AuthSignal::TokenExpired)
        );
        assert_eq!(classify_handshake(401, Some("auth")), Reaction::Remint(AuthSignal::Auth));
        // a 401 the worker did not label, and every other status, backs off.
        assert_eq!(classify_handshake(401, None), Reaction::Backoff);
        assert_eq!(classify_handshake(403, Some("room_mismatch")), Reaction::Backoff);
        assert_eq!(classify_handshake(500, Some("keyset_unavailable")), Reaction::Backoff);
        assert_eq!(classify_handshake(429, None), Reaction::Backoff);

        assert_eq!(
            classify_close(CLOSE_AUTH, Some("token_expired")),
            Reaction::Remint(AuthSignal::TokenExpired)
        );
        assert_eq!(classify_close(CLOSE_AUTH, None), Reaction::Remint(AuthSignal::Auth));
        assert_eq!(classify_close(CLOSE_FLOOD, Some("rate_limited")), Reaction::Backoff);
        assert_eq!(classify_close(1000, Some("kill")), Reaction::Backoff);
    }

    #[test]
    fn the_ladder_is_capped_and_ends_in_exit_14() {
        let policy = RetryPolicy::default();
        assert_eq!(policy.delay(0, 1.0), Duration::ZERO);
        assert_eq!(policy.delay(1, 1.0), Duration::from_millis(250));
        assert_eq!(policy.delay(2, 1.0), Duration::from_millis(500));
        assert_eq!(policy.delay(5, 1.0), policy.cap);
        assert_eq!(policy.delay(30, 1.0), policy.cap, "the shift never overflows");
        // full jitter: the ladder is a ceiling, not a schedule.
        assert_eq!(policy.delay(2, 0.0), Duration::ZERO);
        assert_eq!(policy.delay(2, 0.5), Duration::from_millis(250));

        assert!(!policy.exhausted(4));
        assert!(policy.exhausted(5));
        assert_eq!(policy.exit().code(), 14);
    }
}
