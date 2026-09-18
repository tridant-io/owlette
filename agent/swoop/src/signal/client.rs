//! The host half of the room: the frames in, the frames out, and the decision
//! to let a viewer in.
//!
//! Sans-IO, like the rest of the crate's wire code: a frame arrives as a
//! string, effects come back, and the caller owns the socket through
//! [`SignalTransport`]. That is not only a testing convenience — the socket
//! itself cannot be written yet (see [`super::dial`]) — and it is the same
//! shape str0m gives the peer connection, so Task 4.1 drives both from one
//! loop.
//!
//! Two rules this file exists to hold:
//!
//! 1. **§2's send rights are decided from the `type` string, before the body is
//!    parsed.** A forged frame must not learn which fields the room wanted, and
//!    a schema-first decoder reports `malformed_message` where the contract
//!    says `wrong_role` — the golden vector `signal-viewer-sends-answer.json`
//!    is exactly that case, an `answer` from a viewer that is also missing its
//!    required `mac`.
//! 2. **The host verifies every viewer token itself.** The worker already did;
//!    the worker is a relay, and a message that reaches here was forwarded by
//!    something we do not trust. Verification is §11's order, against the
//!    bundle's keyset and the bundle's time anchor, in
//!    [`crate::bundle::Keyset::verify`] — there is one copy of it and this is
//!    not a second one.

use std::collections::BTreeMap;
use std::time::Instant;

use serde::Deserialize;

use crate::bundle::{
    canonical_fingerprint, derive_viewer_key, fingerprint_from_sdp, host_fp_mac, Bundle,
    BundleError, Claims, DerivedKey, JtiSet, Keyset, TimeAnchor, VerifyContext, AUDIENCE_HOST,
    SWOOP_PROTOCOL_VERSION,
};
use crate::ipc::{Exit, ExitReason, LeftReason};
use crate::signal::admission::{Admission, Denial, DenialReason, Limits};
use crate::signal::dial::{classify_close, AuthSignal, Reaction};
use crate::signal::messages::{
    channel::control_granted, check_hello_version, check_send_right_for_type, Message, Refusal,
    Role, MAX_MESSAGE_BYTES,
};

/// What the caller must do after a frame. Everything the client decides comes
/// back as one of these; the client itself touches no socket, no encoder and no
/// clock but the monotonic one.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Put this frame on the signaling socket.
    Send(Message),
    /// A viewer passed admission. Build its peer connection.
    Admitted { viewer: String, ctl: bool },
    /// That viewer's offer, with the fingerprint its token will be bound to.
    Offer { viewer: String, sdp: String, fingerprint: String },
    Candidate { viewer: String, candidate: String, sdp_mid: String, sdp_m_line_index: u32 },
    ViewerGone { viewer: String, reason: LeftReason },
    /// For `POST /api/agent/swoop/events`, and from there the site's audit log.
    Denied(Denial),
    /// The room refused *us*. `reaction` says whether a fresh bundle would fix
    /// it or whether to back off.
    RoomError { code: String, reaction: Reaction },
    /// We refused a frame the room forwarded. Logged and dropped: only the
    /// server may send an `error`, so the host never answers one.
    Refused(Refusal),
    Exit(Exit, ExitReason),
}

/// The socket, as this module needs it. Text frames out and a close; the read
/// side stays with the caller, which owns the blocking loop.
pub trait SignalTransport {
    fn send_text(&mut self, text: &str) -> anyhow::Result<()>;
    fn close(&mut self, code: u16, reason: &str);
}

/// One frame off the socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    Text(String),
    /// §2: the signaling socket is text only.
    Binary,
    Closed { code: u16, reason: String },
}

/// What the host knows about one viewer before its token arrives.
#[derive(Debug, Default)]
struct Viewer {
    /// The room's claim about this viewer's `ctl`, from the token it verified.
    /// Believed only as far as the session floor allows, and replaced by the
    /// host's own verdict once the host has verified the token itself.
    room_ctl: bool,
    /// The `a=fingerprint:` of this viewer's most recent offer, canonicalised.
    offer_fingerprint: Option<String>,
    /// The fingerprint of the established dtls session, once there is one.
    /// §10's lease renewal binds to this in preference to the offer.
    dtls_fingerprint: Option<String>,
    verified_ctl: Option<bool>,
}

impl Viewer {
    fn fingerprint(&self) -> Option<&str> {
        self.dtls_fingerprint.as_deref().or(self.offer_fingerprint.as_deref())
    }
}

/// The host's signaling client for one session.
pub struct SignalClient {
    site: String,
    machine: String,
    sid: String,
    /// The bundle's `ctl`: a floor on control for the whole session, never a
    /// grant. A viewer's own `ctl` comes from its jwt.
    session_ctl: bool,
    keyset: Keyset,
    anchor: TimeAnchor,
    session_key: DerivedKey,
    jti: JtiSet,
    admission: Admission,
    viewers: BTreeMap<String, Viewer>,
    /// Canonical, set by Task 3.8 once the local dtls certificate exists.
    host_fingerprint: Option<String>,
    /// The last `error` code the room sent, so a close can be read together
    /// with the frame that preceded it.
    last_error: Option<String>,
}

impl SignalClient {
    pub fn from_bundle(bundle: &Bundle) -> Result<Self, BundleError> {
        Ok(Self {
            site: bundle.site.clone(),
            machine: bundle.machine.clone(),
            sid: bundle.sid.clone(),
            session_ctl: bundle.ctl,
            keyset: Keyset::from_bundle(bundle)?,
            anchor: bundle.time_anchor(),
            session_key: bundle.session_key()?,
            jti: JtiSet::new(),
            admission: Admission::new(Limits::from_enablement(&bundle.enablement)),
            viewers: BTreeMap::new(),
            host_fingerprint: None,
            last_error: None,
        })
    }

    pub fn sid(&self) -> &str {
        &self.sid
    }

    pub fn viewer_count(&self) -> u32 {
        self.admission.live()
    }

    /// Task 3.8 hands over the local dtls certificate fingerprint as soon as it
    /// has one. Nothing can be answered before this: §9's mac is over it.
    pub fn set_host_fingerprint(&mut self, raw: &str) -> anyhow::Result<()> {
        self.host_fingerprint =
            Some(canonical_fingerprint(raw).ok_or_else(|| anyhow::anyhow!("not a fingerprint"))?);
        Ok(())
    }

    /// The fingerprint of an established dtls session, which §10 binds a lease
    /// renewal to in preference to the offer's.
    pub fn set_viewer_dtls_fingerprint(&mut self, viewer: &str, raw: &str) -> anyhow::Result<()> {
        let canonical =
            canonical_fingerprint(raw).ok_or_else(|| anyhow::anyhow!("not a fingerprint"))?;
        match self.viewers.get_mut(viewer) {
            Some(state) => {
                state.dtls_fingerprint = Some(canonical);
                Ok(())
            }
            None => Err(anyhow::anyhow!("no such viewer")),
        }
    }

    /// Drive one frame and write whatever it produced. Returns the effects the
    /// caller still has to act on — the `Send`s have already gone out.
    pub fn drive(
        &mut self,
        transport: &mut impl SignalTransport,
        incoming: &Incoming,
    ) -> anyhow::Result<Vec<Effect>> {
        let effects = match incoming {
            Incoming::Text(text) => self.handle(text),
            Incoming::Binary => vec![Effect::Refused(Refusal::BinaryUnsupported)],
            Incoming::Closed { code, reason } => {
                let reaction = classify_close(*code, self.last_error.as_deref());
                vec![Effect::RoomError { code: reason.clone(), reaction }]
            }
        };

        let mut remaining = Vec::with_capacity(effects.len());
        for effect in effects {
            match effect {
                Effect::Send(message) => transport.send_text(&serde_json::to_string(&message)?)?,
                Effect::Exit(code, reason) => {
                    transport.close(1000, reason_text(reason));
                    remaining.push(Effect::Exit(code, reason));
                }
                other => remaining.push(other),
            }
        }
        Ok(remaining)
    }

    /// One frame in, effects out.
    pub fn handle(&mut self, raw: &str) -> Vec<Effect> {
        self.handle_at(raw, Instant::now())
    }

    /// `now` is a parameter so the join limits are testable without sleeping.
    /// It is a monotonic instant: no part of a swoop session reads the wall
    /// clock (§11).
    pub fn handle_at(&mut self, raw: &str, now: Instant) -> Vec<Effect> {
        if raw.len() > MAX_MESSAGE_BYTES {
            return vec![Effect::Refused(Refusal::MessageTooLarge)];
        }
        let envelope: Envelope = match serde_json::from_str(raw) {
            Ok(envelope) => envelope,
            Err(_) => return vec![Effect::Refused(Refusal::MalformedMessage)],
        };

        // the type decides the send right, before anything reads the body.
        // absent `fromRole` means the room itself: it stamps the field on
        // everything a client sent and on nothing it originated.
        let sender = envelope.from_role.unwrap_or(Role::Server);
        if let Err(refusal) = check_send_right_for_type(sender, &envelope.type_name) {
            return vec![Effect::Refused(refusal)];
        }

        match envelope.type_name.as_str() {
            "hello" => self.on_hello(raw),
            "viewer-join" => self.on_viewer_join(raw, now),
            "offer" => self.on_offer(raw, envelope.from.as_deref()),
            "candidate" => self.on_candidate(raw, envelope.from.as_deref()),
            "bye" => self.on_bye(envelope.from.as_deref()),
            "kill" => self.on_kill(raw),
            "error" => self.on_error(envelope.code),
            // `ring` reaches doorbell sockets, and a host that is already
            // running has nothing to do about one. `answer` and `host-ready`
            // are our own frames and are never fanned back to us.
            _ => Vec::new(),
        }
    }

    fn on_hello(&mut self, raw: &str) -> Vec<Effect> {
        let message: Message = match serde_json::from_str(raw) {
            Ok(message) => message,
            Err(_) => return vec![Effect::Refused(Refusal::MalformedMessage)],
        };
        // §1: a mismatch is a bye, a close and a message to the user. never a
        // negotiation, never a downgrade, never "proceed anyway".
        if check_hello_version(&message, SWOOP_PROTOCOL_VERSION).is_err() {
            return vec![
                Effect::Send(bye(None, "version_mismatch")),
                Effect::Exit(Exit::VersionMismatch, ExitReason::Error),
            ];
        }
        let Message::Hello { role, sid, .. } = &message else {
            return vec![Effect::Refused(Refusal::MalformedMessage)];
        };
        // the room tells every socket what it admitted it as. anything but the
        // host here means we dialled with the wrong token, or the room is not
        // the room we think it is.
        if *role != Role::Host || sid.as_deref().is_some_and(|sid| sid != self.sid) {
            return vec![
                Effect::Refused(Refusal::RoomMismatch),
                Effect::Exit(Exit::Internal, ExitReason::Error),
            ];
        }
        Vec::new()
    }

    fn on_viewer_join(&mut self, raw: &str, now: Instant) -> Vec<Effect> {
        let message: Message = match serde_json::from_str(raw) {
            Ok(message) => message,
            Err(_) => return vec![Effect::Refused(Refusal::MalformedMessage)],
        };
        let Message::ViewerJoin { viewer, sid, ctl, .. } = message else {
            return vec![Effect::Refused(Refusal::MalformedMessage)];
        };
        if sid != self.sid {
            return vec![Effect::Refused(Refusal::RoomMismatch)];
        }
        if let Err(denial) = self.admission.admit(&viewer, now) {
            let reason = denial.reason.reason();
            return vec![Effect::Send(bye(Some(&viewer), reason)), Effect::Denied(denial)];
        }
        // the room's `ctl` came from the token it verified, but the host
        // verifies that token itself before anything gated happens.
        let ctl = control_granted(self.session_ctl, ctl);
        self.viewers.insert(viewer.clone(), Viewer { room_ctl: ctl, ..Viewer::default() });
        vec![Effect::Admitted { viewer, ctl }]
    }

    fn on_offer(&mut self, raw: &str, from: Option<&str>) -> Vec<Effect> {
        let Some(viewer) = from.map(str::to_owned) else {
            return vec![Effect::Refused(Refusal::MalformedMessage)];
        };
        if !self.viewers.contains_key(&viewer) {
            return vec![Effect::Denied(Denial::new(viewer, DenialReason::UnknownViewer))];
        }
        let message: Message = match serde_json::from_str(raw) {
            Ok(message) => message,
            Err(_) => return vec![Effect::Refused(Refusal::MalformedMessage)],
        };
        let Message::Offer { sdp, .. } = message else {
            return vec![Effect::Refused(Refusal::MalformedMessage)];
        };
        // an offer with no fingerprint is refused rather than admitted unbound:
        // there would be nothing for §11's `fp` to be compared against.
        let Some(fingerprint) = fingerprint_from_sdp(&sdp) else {
            self.drop_viewer(&viewer);
            return vec![
                Effect::Send(bye(Some(&viewer), DenialReason::OfferFingerprintMissing.reason())),
                Effect::Denied(Denial::new(viewer, DenialReason::OfferFingerprintMissing)),
            ];
        };
        if let Some(state) = self.viewers.get_mut(&viewer) {
            state.offer_fingerprint = Some(fingerprint.clone());
        }
        vec![Effect::Offer { viewer, sdp, fingerprint }]
    }

    fn on_candidate(&mut self, raw: &str, from: Option<&str>) -> Vec<Effect> {
        let Some(viewer) = from.map(str::to_owned) else {
            return vec![Effect::Refused(Refusal::MalformedMessage)];
        };
        if !self.viewers.contains_key(&viewer) {
            return vec![Effect::Denied(Denial::new(viewer, DenialReason::UnknownViewer))];
        }
        let message: Message = match serde_json::from_str(raw) {
            Ok(message) => message,
            Err(_) => return vec![Effect::Refused(Refusal::MalformedMessage)],
        };
        let Message::Candidate { candidate, sdp_mid, sdp_m_line_index, .. } = message else {
            return vec![Effect::Refused(Refusal::MalformedMessage)];
        };
        vec![Effect::Candidate { viewer, candidate, sdp_mid, sdp_m_line_index }]
    }

    /// Read off the envelope rather than the strict decoder on purpose. The
    /// room synthesises a `bye` for a viewer whose socket vanished and stamps an
    /// extra `code` field on it (`infra/swoop-signal/src/room.ts`,
    /// `webSocketClose`), which `Message`'s `deny_unknown_fields` refuses — and
    /// a refused `bye` would leak the viewer's slot until the session ended.
    /// `from` is all the host needs; `reason` is advisory.
    fn on_bye(&mut self, from: Option<&str>) -> Vec<Effect> {
        let Some(viewer) = from else {
            // a bye the host did not send and no viewer owns.
            return vec![Effect::Refused(Refusal::MalformedMessage)];
        };
        if !self.drop_viewer(viewer) {
            return Vec::new();
        }
        vec![Effect::ViewerGone { viewer: viewer.to_owned(), reason: LeftReason::Bye }]
    }

    fn on_kill(&mut self, raw: &str) -> Vec<Effect> {
        let message: Message = match serde_json::from_str(raw) {
            Ok(message) => message,
            Err(_) => return vec![Effect::Refused(Refusal::MalformedMessage)],
        };
        let Message::Kill { sid, .. } = message else {
            return vec![Effect::Refused(Refusal::MalformedMessage)];
        };
        // a null sid means "kill whatever is running" (§11's sid-only
        // contract). a sid naming another session is not ours to act on.
        if sid.as_deref().is_some_and(|sid| sid != self.sid) {
            return Vec::new();
        }
        vec![Effect::Exit(Exit::Ok, ExitReason::Kill)]
    }

    fn on_error(&mut self, code: Option<serde_json::Value>) -> Vec<Effect> {
        // the room's `error` codes are a wider set than §2's table — `auth`,
        // `token_expired`, `unknown_kid` and `rate_limited` are all codes a
        // `Refusal` cannot spell — so the code travels as the string it is.
        let code = code
            .as_ref()
            .and_then(|code| code.as_str())
            .unwrap_or("malformed_message")
            .to_owned();
        self.last_error = Some(code.clone());
        let reaction = match AuthSignal::parse(&code) {
            Some(signal) => Reaction::Remint(signal),
            None => Reaction::Backoff,
        };
        vec![Effect::RoomError { code, reaction }]
    }

    fn drop_viewer(&mut self, viewer: &str) -> bool {
        if self.viewers.remove(viewer).is_some() {
            self.admission.release();
            return true;
        }
        false
    }

    /// The host's own verdict on a viewer token — the connect token and every
    /// §10 lease renewal, one code path, as §10 requires.
    ///
    /// `fp` is compared against the established dtls fingerprint where there is
    /// one and the offer's until then; both are the same certificate, and §10
    /// names the established one for a renewal.
    pub fn verify_viewer_token(&mut self, viewer: &str, token: &str) -> Result<Claims, Denial> {
        let Some(state) = self.viewers.get(viewer) else {
            return Err(Denial::new(viewer, DenialReason::UnknownViewer));
        };
        let Some(fingerprint) = state.fingerprint().map(str::to_owned) else {
            return Err(Denial::new(viewer, DenialReason::OfferFingerprintMissing));
        };
        let ctx = VerifyContext {
            audience: AUDIENCE_HOST,
            site: &self.site,
            machine: &self.machine,
            sid: Some(&self.sid),
            offer_fingerprint: Some(&fingerprint),
        };
        let claims = self
            .keyset
            .verify(token, &ctx, &self.anchor, &mut self.jti)
            .map_err(|error| {
                // §11: an unknown `kid` is the one refusal an operator has to be
                // able to see, because it is how a botched rotation presents.
                // The kid and nothing else — never the token, never a claim.
                if error == crate::bundle::TokenError::UnknownKid {
                    ::log::warn!("swoop: viewer token signed with unknown kid {}", kid_of(token));
                }
                Denial::new(viewer, DenialReason::Token(error))
            })?;
        // the token names a viewer; the room forwarded it from a socket. a
        // token for viewer A presented over viewer B's socket is refused even
        // though it verified, because everything downstream is keyed by id.
        if claims.viewer.as_deref() != Some(viewer) {
            return Err(Denial::new(viewer, DenialReason::ViewerMismatch));
        }
        let ctl = control_granted(self.session_ctl, claims.has_control());
        if let Some(state) = self.viewers.get_mut(viewer) {
            state.verified_ctl = Some(ctl);
        }
        Ok(claims)
    }

    /// Control for this viewer: the session floor and the host's own verdict on
    /// the token. Watch-only until the token has been verified here — the
    /// room's word is not enough for anything gated.
    pub fn control_granted(&self, viewer: &str) -> bool {
        self.viewers.get(viewer).and_then(|state| state.verified_ctl).unwrap_or(false)
    }

    /// What the room said about this viewer at join, before its token reached
    /// the host. Reported, never enforced on.
    pub fn room_control_claim(&self, viewer: &str) -> bool {
        self.viewers.get(viewer).is_some_and(|state| state.room_ctl)
    }

    /// §9's answer: the host's sdp plus a mac over its own dtls fingerprint,
    /// keyed by `k = HKDF(K_session, viewerId)`.
    ///
    /// The mac rides on `answer`, not on `host-ready` — §9 and `messages.rs`
    /// both put it there, and `host-ready` has no field for it. (Task 3.9's
    /// brief says `host-ready`; the contract is the one to implement.)
    pub fn answer(&self, viewer: &str, sdp: &str) -> anyhow::Result<Message> {
        let host_fingerprint = self
            .host_fingerprint
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("no host fingerprint yet"))?;
        // macing a fingerprint the answer does not actually carry would hand the
        // browser a mac it can verify over a certificate nobody is using.
        let in_sdp = fingerprint_from_sdp(sdp)
            .ok_or_else(|| anyhow::anyhow!("the answer carries no fingerprint"))?;
        if in_sdp != host_fingerprint {
            anyhow::bail!("the answer's fingerprint is not this host's");
        }
        let key = derive_viewer_key(&self.session_key, viewer);
        Ok(Message::Answer {
            to: viewer.to_owned(),
            sdp: sdp.to_owned(),
            mac: host_fp_mac(&key, &self.sid, viewer, host_fingerprint),
            from: None,
            from_role: None,
            server_time_ms: None,
        })
    }

    /// `host-ready`, to one viewer or, with `to` absent, to all of them.
    pub fn host_ready(&self, viewer: Option<&str>) -> Message {
        Message::HostReady {
            sid: self.sid.clone(),
            to: viewer.map(str::to_owned),
            from: None,
            from_role: None,
            server_time_ms: None,
        }
    }

    /// Drop a viewer the host is ending, e.g. §10's expired lease. Frees the
    /// admission slot and produces the `bye` that tells the browser why.
    pub fn end_viewer(&mut self, viewer: &str, reason: LeftReason) -> Vec<Effect> {
        if !self.drop_viewer(viewer) {
            return Vec::new();
        }
        vec![
            Effect::Send(bye(Some(viewer), left_reason_text(reason))),
            Effect::ViewerGone { viewer: viewer.to_owned(), reason },
        ]
    }
}

/// The pre-parse: `type` and the two fields the room stamps, with everything
/// else ignored. §2's send rights are decided from this and nothing more.
#[derive(Debug, Deserialize)]
struct Envelope {
    #[serde(rename = "type")]
    type_name: String,
    #[serde(default)]
    from: Option<String>,
    #[serde(default, rename = "fromRole")]
    from_role: Option<Role>,
    /// A string on an `error` frame, and a number on the `bye` the room
    /// synthesises for a vanished socket, where it is the websocket close code.
    /// One name, two types, so this cannot be typed tighter than `Value`
    /// without the pre-parse failing on half the frames the room sends.
    #[serde(default)]
    code: Option<serde_json::Value>,
}

/// The header `kid` of a token whose key we do not hold, for the one log line
/// §11 asks for. A `kid` is an identifier, not key material; it is still length
/// bounded and rendered as a placeholder when the header is not readable, so a
/// forged token cannot write whatever it likes into the log.
fn kid_of(token: &str) -> String {
    #[derive(Deserialize)]
    struct Header {
        kid: Option<String>,
    }
    let Some(header) = token.split('.').next() else {
        return "<unreadable>".to_owned();
    };
    base64::prelude::Engine::decode(&base64::prelude::BASE64_URL_SAFE_NO_PAD, header)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Header>(&bytes).ok())
        .and_then(|header| header.kid)
        .map(|kid| kid.chars().filter(|c| c.is_ascii_graphic()).take(64).collect())
        .unwrap_or_else(|| "<unreadable>".to_owned())
}

fn bye(to: Option<&str>, reason: &str) -> Message {
    Message::Bye {
        reason: Some(reason.to_owned()),
        to: to.map(str::to_owned),
        from: None,
        from_role: None,
        server_time_ms: None,
    }
}

/// The `bye` reason a host-side drop travels with. Spelled the same as the
/// `viewer_left` event's, because the browser and the audit trail are reading
/// about the same departure.
fn left_reason_text(reason: LeftReason) -> &'static str {
    match reason {
        LeftReason::Bye => "bye",
        LeftReason::Timeout => "timeout",
        LeftReason::LeaseExpired => "lease_expired",
        LeftReason::Kill => "kill",
    }
}

fn reason_text(reason: ExitReason) -> &'static str {
    match reason {
        ExitReason::Idle => "idle",
        ExitReason::Kill => "kill",
        ExitReason::SignalLost => "signal_lost",
        ExitReason::SessionCap => "session_cap",
        ExitReason::Error => "error",
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use serde_json::{json, Value};

    use super::*;
    use crate::bundle::{BuildVersions, TokenError};

    // ------------------------------------------------------------ fixtures ---

    pub(crate) fn testdata() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/protocol")
    }

    fn read(relative: &str) -> Value {
        let path = testdata().join(relative);
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// The golden bundle, parsed against the version it was authored for rather
    /// than this working tree's — the same reasoning as `tests/protocol_vectors.rs`.
    pub(crate) fn golden_bundle() -> Bundle {
        let path = testdata().join("bundle/bundle-valid.json");
        let line = fs::read_to_string(&path).expect("the golden bundle is readable");
        let source: Value = serde_json::from_str(&line).expect("it is json");
        let build = BuildVersions {
            protocol_version: 1,
            agent_version: source["agentVersion"].as_str().expect("agentVersion"),
        };
        Bundle::parse(line.trim(), build).expect("the golden bundle parses")
    }

    fn client() -> SignalClient {
        SignalClient::from_bundle(&golden_bundle()).expect("the golden bundle builds a client")
    }

    /// A client with one viewer already through the door and its offer seen —
    /// the state every token test starts from.
    fn client_with_viewer() -> (SignalClient, String) {
        let mut client = client();
        let now = Instant::now();
        let join = read("signaling/signal-viewer-join.json");
        let effects = client.handle_at(&join["message"].to_string(), now);
        let viewer = match &effects[..] {
            [Effect::Admitted { viewer, .. }] => viewer.clone(),
            other => panic!("expected an admission, got {other:?}"),
        };
        let offer = read("signaling/signal-offer.json");
        let effects = client.handle_at(&offer["message"].to_string(), now);
        assert!(matches!(effects[..], [Effect::Offer { .. }]), "{effects:?}");
        (client, viewer)
    }

    fn token(vector: &str) -> String {
        read(&format!("jwt/{vector}.json"))["token"].as_str().expect("token").to_owned()
    }

    #[derive(Default)]
    struct FakeSocket {
        sent: Vec<String>,
        closed: Option<(u16, String)>,
    }

    impl SignalTransport for FakeSocket {
        fn send_text(&mut self, text: &str) -> anyhow::Result<()> {
            self.sent.push(text.to_owned());
            Ok(())
        }

        fn close(&mut self, code: u16, reason: &str) {
            self.closed = Some((code, reason.to_owned()));
        }
    }

    // --------------------------------------------------- the golden vectors ---

    /// §11 step 5. `fp` is mandatory on a viewer token and never degrades to
    /// "no binding required".
    #[test]
    fn a_viewer_token_with_no_fp_is_refused() {
        let (mut client, viewer) = client_with_viewer();
        assert_eq!(
            client.verify_viewer_token(&viewer, &token("jwt-viewer-no-fp")),
            Err(Denial::new(&viewer, DenialReason::Token(TokenError::FpMissing)))
        );
        assert!(!client.control_granted(&viewer));
    }

    /// §11 step 5, the live half: the comparison is against the offer this
    /// session actually received, so it cannot be a static vector.
    #[test]
    fn a_viewer_token_bound_to_another_browser_is_refused() {
        let (mut client, viewer) = client_with_viewer();
        // the host's own certificate in the viewer's place — exactly what a
        // relay swapping identities would leave behind.
        let answer = read("signaling/signal-answer.json");
        let someone_else = answer["message"]["sdp"].as_str().expect("sdp");
        client
            .set_viewer_dtls_fingerprint(&viewer, &fingerprint_from_sdp(someone_else).unwrap())
            .expect("the viewer is known");

        assert_eq!(
            client.verify_viewer_token(&viewer, &token("jwt-viewer-valid")),
            Err(Denial::new(&viewer, DenialReason::Token(TokenError::FpMismatch)))
        );
    }

    /// §11 step 4, against the bundle's anchor.
    #[test]
    fn an_expired_viewer_token_is_refused() {
        let (mut client, viewer) = client_with_viewer();
        assert_eq!(
            client.verify_viewer_token(&viewer, &token("jwt-viewer-expired")),
            Err(Denial::new(&viewer, DenialReason::Token(TokenError::Expired)))
        );
    }

    /// §11 step 1. An unknown `kid` is a refusal and a re-fetch, never a
    /// fallback to trying every key.
    #[test]
    fn a_viewer_token_signed_with_an_unknown_kid_is_refused() {
        let (mut client, viewer) = client_with_viewer();
        assert_eq!(
            client.verify_viewer_token(&viewer, &token("jwt-viewer-unknown-kid")),
            Err(Denial::new(&viewer, DenialReason::Token(TokenError::UnknownKid)))
        );
        // the log line §11 asks for names the kid and nothing else.
        let unknown = token("jwt-viewer-unknown-kid");
        assert_eq!(kid_of(&unknown), "test-kid-9");
        assert_eq!(kid_of("not-a-token"), "<unreadable>");
        assert!(!kid_of(&unknown).contains(unknown.split('.').nth(1).unwrap()));
        // the rotation overlap is the point of the two-key bundle: a token
        // signed with the *previous* kid still verifies.
        assert!(client.verify_viewer_token(&viewer, &token("jwt-viewer-rotated-kid")).is_ok());
    }

    /// §11 step 6: a token minted for another machine is refused whatever the
    /// room or the url said.
    #[test]
    fn a_viewer_token_for_another_machine_is_refused() {
        let (mut client, viewer) = client_with_viewer();
        assert_eq!(
            client.verify_viewer_token(&viewer, &token("jwt-viewer-wrong-machine")),
            Err(Denial::new(&viewer, DenialReason::Token(TokenError::MachineMismatch)))
        );
    }

    /// The whole admission path on the happy road: joined, offered, token
    /// verified, control granted from the host's own verdict.
    #[test]
    fn a_valid_viewer_token_admits_the_viewer_and_grants_control() {
        let (mut client, viewer) = client_with_viewer();
        assert!(!client.control_granted(&viewer), "control is watch-only until the host verifies");

        let claims = client
            .verify_viewer_token(&viewer, &token("jwt-viewer-valid"))
            .expect("the golden viewer token verifies");
        assert_eq!(claims.viewer.as_deref(), Some(viewer.as_str()));
        assert!(client.control_granted(&viewer));

        // §11: `jti` is single use for the lifetime of this process.
        assert_eq!(
            client.verify_viewer_token(&viewer, &token("jwt-viewer-valid")),
            Err(Denial::new(&viewer, DenialReason::Token(TokenError::JtiReplayed)))
        );
    }

    /// §11's `exp` rule, stated the way the kiosks make it matter: every verdict
    /// below is a function of the bundle's anchor plus monotonic elapsed, and of
    /// nothing else, so a machine clock six hours out in either direction cannot
    /// move one.
    #[test]
    fn a_kiosk_clock_six_hours_out_changes_no_verdict() {
        let bundle = golden_bundle();

        // the streamer's "now" is the bundle's `now`, whatever the box reads.
        // this dev box is not at unix 1789689600, and that is the point.
        assert!((TimeAnchor::new(bundle.now).now_unix() - bundle.now).abs() <= 1);

        // and no module here can reach the wall clock, because none of them
        // names it. the needle is assembled at runtime so this file does not
        // contain the string it is banning. a future edit fails here rather than
        // on a drifted signage box.
        let banned = format!("System{}::now", "Time");
        for file in ["mod.rs", "client.rs", "dial.rs", "admission.rs"] {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/signal").join(file);
            let source = fs::read_to_string(&path).expect("the module is readable");
            assert!(!source.contains(&banned), "{file} must not read the wall clock");
        }

        // the list the brief names, each against the bundle's own anchor. a
        // drifted clock cannot reach any of them.
        for (vector, refusal) in [
            ("jwt-viewer-valid", None),
            ("jwt-viewer-no-fp", Some(TokenError::FpMissing)),
            ("jwt-viewer-expired", Some(TokenError::Expired)),
            ("jwt-viewer-unknown-kid", Some(TokenError::UnknownKid)),
            ("jwt-viewer-wrong-machine", Some(TokenError::MachineMismatch)),
        ] {
            let (mut client, viewer) = client_with_viewer();
            let verdict = client.verify_viewer_token(&viewer, &token(vector));
            match refusal {
                None => assert!(verdict.is_ok(), "{vector}: {verdict:?}"),
                Some(expected) => assert_eq!(
                    verdict.unwrap_err().reason,
                    DenialReason::Token(expected),
                    "{vector}"
                ),
            }
        }

        // the positive control, and the only thing that does move an expiry
        // verdict: the anchor itself. without it the run above would prove
        // nothing about which clock was consulted.
        let six_hours = 6 * 3600;
        let (mut client, viewer) = client_with_viewer();
        client.anchor = TimeAnchor::with_elapsed(bundle.now - six_hours, Duration::from_secs(2));
        assert!(
            client.verify_viewer_token(&viewer, &token("jwt-viewer-expired")).is_ok(),
            "the same token verifies against an anchor that precedes its exp"
        );

        let (mut client, viewer) = client_with_viewer();
        client.anchor = TimeAnchor::with_elapsed(bundle.now + six_hours, Duration::from_secs(2));
        assert_eq!(
            client.verify_viewer_token(&viewer, &token("jwt-viewer-valid")).unwrap_err().reason,
            DenialReason::Token(TokenError::Expired)
        );
    }

    // ------------------------------------------------------ the wire itself ---

    /// §2, and the reason it is a pre-parse: the golden vector is an `answer`
    /// from a viewer that is *also* missing its required `mac`. A schema-first
    /// decoder would call it `malformed_message` and tell an attacker which
    /// fields the room wanted.
    #[test]
    fn a_send_right_is_decided_from_the_type_before_the_body_is_parsed() {
        let mut client = client();
        let vector = read("signaling/signal-viewer-sends-answer.json");
        let mut frame = vector["message"].clone();
        frame["fromRole"] = json!("viewer");
        assert!(frame.get("mac").is_none(), "the vector is the one missing its mac");
        assert_eq!(client.handle(&frame.to_string()), vec![Effect::Refused(Refusal::WrongRole)]);

        let vector = read("signaling/signal-viewer-sends-kill.json");
        let mut frame = vector["message"].clone();
        frame["fromRole"] = json!("viewer");
        assert_eq!(
            client.handle(&frame.to_string()),
            vec![Effect::Refused(Refusal::ForbiddenType)]
        );

        // and an unstamped frame is the room's own, which may send both.
        let kill = read("signaling/signal-kill.json");
        assert_eq!(
            client.handle(&kill["message"].to_string()),
            vec![Effect::Exit(Exit::Ok, ExitReason::Kill)]
        );
    }

    #[test]
    fn a_frame_the_host_cannot_read_is_refused_rather_than_answered() {
        let mut client = client();
        assert_eq!(client.handle("not json"), vec![Effect::Refused(Refusal::MalformedMessage)]);
        assert_eq!(
            client.handle(&"x".repeat(MAX_MESSAGE_BYTES + 1)),
            vec![Effect::Refused(Refusal::MessageTooLarge)]
        );
        let mut socket = FakeSocket::default();
        assert_eq!(
            client.drive(&mut socket, &Incoming::Binary).expect("no io"),
            vec![Effect::Refused(Refusal::BinaryUnsupported)]
        );
        // the host is not the room: it never answers an `error` of its own.
        assert!(socket.sent.is_empty());
    }

    /// §1: a version mismatch is a bye, a close and a stop.
    #[test]
    fn a_room_on_another_protocol_version_is_never_negotiated_with() {
        let mut mismatched = client();
        let mut socket = FakeSocket::default();
        let hello = read("handshake/handshake-hello-v2.json");
        let mut frame = hello["message"].clone();
        frame["role"] = json!("host");
        frame["sid"] = json!(mismatched.sid());

        let effects =
            mismatched.drive(&mut socket, &Incoming::Text(frame.to_string())).expect("no io");
        assert_eq!(effects, vec![Effect::Exit(Exit::VersionMismatch, ExitReason::Error)]);
        let sent: Value = serde_json::from_str(&socket.sent[0]).expect("the bye is json");
        assert_eq!(sent["type"], "bye");
        assert_eq!(sent["reason"], "version_mismatch");
        assert_eq!(socket.closed, Some((1000, "error".to_owned())));

        // the matching version is accepted in silence.
        let mut matching = client();
        let hello = read("handshake/handshake-hello-v1.json");
        let mut frame = hello["message"].clone();
        frame["role"] = json!("host");
        frame["sid"] = json!(matching.sid());
        assert_eq!(matching.handle(&frame.to_string()), Vec::new());
    }

    /// The room stamps an extra `code` on the `bye` it synthesises for a viewer
    /// that vanished. The host still has to free the slot.
    #[test]
    fn a_viewer_that_vanished_frees_its_slot() {
        let (mut client, viewer) = client_with_viewer();
        assert_eq!(client.viewer_count(), 1);
        let dropped = json!({
            "type": "bye",
            "from": viewer,
            "fromRole": "viewer",
            "reason": "dropped",
            "code": 1006,
            "serverTimeMs": 1789689600000i64,
        });
        assert_eq!(
            client.handle(&dropped.to_string()),
            vec![Effect::ViewerGone { viewer: viewer.clone(), reason: LeftReason::Bye }]
        );
        assert_eq!(client.viewer_count(), 0);
        // and a second bye for a viewer already gone is not a second departure.
        assert_eq!(client.handle(&dropped.to_string()), Vec::new());
    }

    #[test]
    fn an_offer_from_a_viewer_the_host_never_admitted_is_denied() {
        let mut client = client();
        let offer = read("signaling/signal-offer.json");
        assert_eq!(
            client.handle(&offer["message"].to_string()),
            vec![Effect::Denied(Denial::new("viewer_0000000001", DenialReason::UnknownViewer))]
        );
    }

    #[test]
    fn an_offer_with_no_fingerprint_is_refused_rather_than_admitted_unbound() {
        let (mut client, viewer) = client_with_viewer();
        let naked = json!({
            "type": "offer",
            "sdp": "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
            "from": viewer,
            "fromRole": "viewer",
        });
        let effects = client.handle(&naked.to_string());
        assert_eq!(
            effects[1],
            Effect::Denied(Denial::new(&viewer, DenialReason::OfferFingerprintMissing))
        );
        assert_eq!(client.viewer_count(), 0);
    }

    /// Every admission refusal is both a `bye` to the browser and a record for
    /// the audit trail — a denial nobody can see is a denial nobody can
    /// investigate.
    #[test]
    fn an_admission_refusal_is_reported_as_well_as_refused() {
        let mut client = client();
        let mut socket = FakeSocket::default();
        let join = read("signaling/signal-viewer-join.json");
        let frame = join["message"].to_string();
        let start = Instant::now();

        assert!(matches!(
            client.handle_at(&frame, start)[..],
            [Effect::Admitted { .. }]
        ));
        // a second join inside the interval floor.
        let effects = client.handle_at(&frame, start + Duration::from_millis(500));
        let mut remaining = Vec::new();
        for effect in effects {
            match effect {
                Effect::Send(message) => {
                    socket.send_text(&serde_json::to_string(&message).unwrap()).unwrap()
                }
                other => remaining.push(other),
            }
        }
        assert_eq!(
            remaining,
            vec![Effect::Denied(Denial::new("viewer_0000000001", DenialReason::JoinTooSoon))]
        );
        let sent: Value = serde_json::from_str(&socket.sent[0]).expect("the bye is json");
        assert_eq!(sent["type"], "bye");
        assert_eq!(sent["to"], "viewer_0000000001");
        assert_eq!(sent["reason"], "join_too_soon");
    }

    /// A join for a session this streamer is not serving is a room mismatch,
    /// not a viewer.
    #[test]
    fn a_join_for_another_session_is_refused() {
        let mut client = client();
        let join = read("signaling/signal-viewer-join.json");
        let mut frame = join["message"].clone();
        frame["sid"] = json!("sid_0000000000000002");
        assert_eq!(
            client.handle(&frame.to_string()),
            vec![Effect::Refused(Refusal::RoomMismatch)]
        );
    }

    // -------------------------------------------------------------- §9's mac ---

    /// The mac this host puts on an `answer`, against the byte-for-byte
    /// derivation in `crypto/hkdf-and-host-mac.json` — the same value
    /// `signaling/signal-answer.json` carries, so a drifted literal fails here
    /// rather than in a browser.
    #[test]
    fn the_answer_mac_matches_the_golden_derivation() {
        let (mut client, viewer) = client_with_viewer();
        let expected = read("crypto/hkdf-and-host-mac.json");
        let vector = read("signaling/signal-answer.json");
        let sdp = vector["message"]["sdp"].as_str().expect("sdp").to_owned();
        let host_fingerprint = fingerprint_from_sdp(&sdp).expect("the answer carries one");

        // no fingerprint, no answer: there would be nothing to mac.
        assert!(client.answer(&viewer, &sdp).is_err());

        client.set_host_fingerprint(&host_fingerprint).expect("it is a fingerprint");
        let Message::Answer { to, mac, .. } = client.answer(&viewer, &sdp).expect("it answers")
        else {
            panic!("answer() returns an answer");
        };
        assert_eq!(to, viewer);
        assert_eq!(mac, expected["hostMac"]["expected"].as_str().unwrap());
        assert_eq!(mac, vector["message"]["mac"].as_str().unwrap());

        // an answer whose sdp is not this host's certificate is refused: a mac
        // over a fingerprint nobody is using verifies and proves nothing.
        let other = read("signaling/signal-offer.json");
        assert!(client.answer(&viewer, other["message"]["sdp"].as_str().unwrap()).is_err());
    }

    #[test]
    fn host_ready_names_the_session_and_optionally_the_viewer() {
        let client = client();
        let Message::HostReady { sid, to, .. } = client.host_ready(Some("viewer_0000000001")) else {
            panic!("host_ready() returns a host-ready");
        };
        assert_eq!(sid, client.sid());
        assert_eq!(to.as_deref(), Some("viewer_0000000001"));
        assert!(matches!(client.host_ready(None), Message::HostReady { to: None, .. }));
    }

    /// The three auth words re-mint; everything else backs off. The room's own
    /// `rate_limited` is not one of them, and it is not a `Refusal` either.
    #[test]
    fn an_error_frame_carries_the_reaction_the_room_earned() {
        let mut client = client();
        let vector = read("signaling/signal-error.json");
        assert_eq!(
            client.handle(&vector["message"].to_string()),
            vec![Effect::RoomError {
                code: "malformed_message".to_owned(),
                reaction: Reaction::Backoff
            }]
        );

        let expired = json!({"type": "error", "code": "token_expired", "serverTimeMs": 1i64});
        assert_eq!(
            client.handle(&expired.to_string()),
            vec![Effect::RoomError {
                code: "token_expired".to_owned(),
                reaction: Reaction::Remint(crate::signal::dial::AuthSignal::TokenExpired)
            }]
        );
        // and the close that follows is read together with it.
        let mut socket = FakeSocket::default();
        let closed = Incoming::Closed { code: 4401, reason: "token_expired".to_owned() };
        assert_eq!(
            client.drive(&mut socket, &closed).expect("no io"),
            vec![Effect::RoomError {
                code: "token_expired".to_owned(),
                reaction: Reaction::Remint(crate::signal::dial::AuthSignal::TokenExpired)
            }]
        );

        let flooded = json!({"type": "error", "code": "rate_limited", "serverTimeMs": 1i64});
        assert_eq!(
            client.handle(&flooded.to_string()),
            vec![Effect::RoomError { code: "rate_limited".to_owned(), reaction: Reaction::Backoff }]
        );
    }

    /// §11 again, from the other end: nothing this module can produce carries a
    /// token, a key or a claim value.
    #[test]
    fn no_secret_reaches_an_effect_a_denial_or_a_log_line() {
        let (mut client, viewer) = client_with_viewer();
        let presented = token("jwt-viewer-no-fp");
        let denial = client.verify_viewer_token(&viewer, &presented).expect_err("it is a reject");
        let rendered = format!("{denial} {denial:?}");
        assert!(!rendered.contains(&presented), "the token itself, whole or in part");
        for segment in presented.split('.') {
            assert!(!rendered.contains(segment));
        }
        assert!(rendered.contains(&viewer), "the viewer id is what a denial is for");

        // and the key material the client holds renders as a placeholder.
        assert_eq!(format!("{:?}", client.session_key), "<redacted>");
        let bundle = golden_bundle();
        assert!(!format!("{bundle:?}").contains(bundle.host_token.expose()));
    }
}
