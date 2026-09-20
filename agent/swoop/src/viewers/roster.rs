//! Who is in the session, what each one is allowed to do, and what the browser
//! is told about the others.
//!
//! # `ctl` comes from the verified jwt or it does not come at all
//!
//! §5 is explicit that the host enforces control from the token it verified
//! itself and never from anything the viewer says about itself — not the
//! room's `viewer-join`, which is the signaling server's word, and not a field
//! on an offer. That rule is enforced here by the **shape** of this type rather
//! than by a comment: there is no `set_ctl(bool)`. The only road to a `true` is
//! [`Roster::verify`], which takes a [`Claims`] the caller has already verified
//! against the bundle's keyset, and even then the bundle's own `ctl` is a floor
//! over the top (`"ctl": false` refuses control for the whole session whatever
//! a token claims). A later task that wants to flip control for a viewer has to
//! produce a verified claim set to do it.
//!
//! # The five public fields are contract
//!
//! `session/tiers.rs` builds its `TierViewer` from `viewer_id`, `ctl` and
//! `codec_class`; the session loop reads `lease_expires_at` beside
//! [`lease::LeaseLedger`](super::lease::LeaseLedger)'s own bookkeeping. Neither
//! file may be edited from here, so renaming one of those fields is a break in
//! two modules at once.
//!
//! # What the browser is told
//!
//! [`Presence`] is host → viewer and carries no token, no fingerprint and no
//! lease: a roster line is `{id, name, ctl}` and a cursor is a normalised
//! point. `roster` rides `swoop-control`, which is ordered and reliable, so a
//! departure can never be the frame that is dropped and leave a ghost in
//! everyone's list; `vpos` rides `swoop-cursor` beside the host's own `cpos`,
//! unreliable, because a stale pointer is corrected by the next one 16 ms later.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::bundle::Claims;
use crate::encode::Codec;

/// One viewer, as the host knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewerRecord {
    pub viewer_id: String,
    /// What the other viewers see in the roster.
    ///
    /// §8's claim set is `deny_unknown_fields` and the api mints `uid`, not a
    /// name, so there is no display name on the wire at all: this is the
    /// token's `uid` where it carries one and the viewer id otherwise. Turning
    /// a uid into a person is the browser's job — it is the half that can read
    /// firestore — and this is the stable key it would do that with.
    pub display_name: String,
    /// Control. From the verified jwt and the bundle's floor, never from the
    /// viewer; see the module comment for why there is no setter.
    pub ctl: bool,
    /// What this viewer's browser negotiated. `H264` until its answer names
    /// one: the baseline every browser decodes, so a viewer counted before its
    /// answer lands can never invent a tier the machine then has to pay for.
    pub codec_class: Codec,
    /// §10's lease, in the ledger's own time base. `None` until the first
    /// `lease` frame is verified.
    pub lease_expires_at: Option<i64>,
}

/// One roster line as the browser is told it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PresenceViewer {
    pub id: String,
    pub name: String,
    pub ctl: bool,
}

/// Host → viewer, §5. Two messages on two channels, one type because the
/// browser decodes them with one decoder.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Presence {
    /// `swoop-control`, whole on every change. Ordered and reliable, so a
    /// departure is never the frame that goes missing.
    Roster { viewers: Vec<PresenceViewer>, ts_us: i64 },
    /// `swoop-cursor`: where one controller's pointer is, normalised over the
    /// selected display exactly as §5's `m` sends it.
    Vpos { viewer: String, x: f64, y: f64, ts_us: i64 },
}

/// The session's viewers, keyed by id.
#[derive(Debug)]
pub struct Roster {
    /// The bundle's `ctl`: a floor on every viewer, not a grant to any of them.
    session_ctl: bool,
    viewers: BTreeMap<String, ViewerRecord>,
}

impl Roster {
    /// `session_ctl` is the bundle's own `ctl` field.
    pub fn new(session_ctl: bool) -> Self {
        Self {
            session_ctl,
            viewers: BTreeMap::new(),
        }
    }

    /// Admit a viewer, watch-only. `true` the first time; a repeat — the same
    /// browser re-offering after an ice restart — keeps the record it already
    /// has rather than silently demoting a controller to a watcher.
    pub fn join(&mut self, viewer_id: &str) -> bool {
        if self.viewers.contains_key(viewer_id) {
            return false;
        }
        self.viewers.insert(
            viewer_id.to_owned(),
            ViewerRecord {
                viewer_id: viewer_id.to_owned(),
                display_name: viewer_id.to_owned(),
                ctl: false,
                codec_class: Codec::H264,
                lease_expires_at: None,
            },
        );
        true
    }

    /// The one road to `ctl`. Returns what the viewer now holds.
    ///
    /// The claims must name this same viewer: §11 binds a viewer token to a
    /// `viewer` and a fingerprint, and a token verified for one id must never
    /// grant control over another's record.
    pub fn verify(&mut self, viewer_id: &str, claims: &Claims) -> bool {
        if claims.viewer.as_deref() != Some(viewer_id) {
            return false;
        }
        let session_ctl = self.session_ctl;
        let Some(record) = self.viewers.get_mut(viewer_id) else {
            return false;
        };
        record.ctl = session_ctl && claims.has_control();
        if let Some(uid) = claims.uid.as_deref() {
            record.display_name = uid.to_owned();
        }
        record.ctl
    }

    /// What this viewer's answer negotiated, once it has one.
    pub fn set_codec(&mut self, viewer_id: &str, codec: Codec) {
        if let Some(record) = self.viewers.get_mut(viewer_id) {
            record.codec_class = codec;
        }
    }

    /// Mirror the lease ledger's expiry onto the record, so the roster is one
    /// read for the tier planner and the status line. The ledger stays the
    /// truth: this is a copy, written where the ledger is renewed.
    pub fn set_lease(&mut self, viewer_id: &str, expires_at: i64) {
        if let Some(record) = self.viewers.get_mut(viewer_id) {
            record.lease_expires_at = Some(expires_at);
        }
    }

    /// A viewer left, was kicked, or its lease lapsed. The caller owes the
    /// machine [`SharedInput::release`](super::input::SharedInput::release) for
    /// the same id — a departure with keys still down is the bug that whole
    /// module exists for.
    pub fn leave(&mut self, viewer_id: &str) -> Option<ViewerRecord> {
        self.viewers.remove(viewer_id)
    }

    pub fn get(&self, viewer_id: &str) -> Option<&ViewerRecord> {
        self.viewers.get(viewer_id)
    }

    /// §5's gate: the bundle's floor is already in `ctl`, and a viewer nobody
    /// admitted has no control by construction.
    pub fn control_granted(&self, viewer_id: &str) -> bool {
        self.viewers.get(viewer_id).is_some_and(|record| record.ctl)
    }

    /// Every viewer, id order — stable, so the same roster always produces the
    /// same message and the browser never re-renders on a reshuffle.
    pub fn iter(&self) -> impl Iterator<Item = &ViewerRecord> {
        self.viewers.values()
    }

    pub fn len(&self) -> usize {
        self.viewers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.viewers.is_empty()
    }

    /// §6's `status.controllers`.
    pub fn controllers(&self) -> u32 {
        self.viewers.values().filter(|record| record.ctl).count() as u32
    }

    /// The roster message for `swoop-control`, sent whole on every change.
    pub fn presence(&self, ts_us: i64) -> Presence {
        Presence::Roster {
            viewers: self
                .viewers
                .values()
                .map(|record| PresenceViewer {
                    id: record.viewer_id.clone(),
                    name: record.display_name.clone(),
                    ctl: record.ctl,
                })
                .collect(),
            ts_us,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::Role;

    fn claims(viewer: &str, ctl: bool) -> Claims {
        Claims {
            iss: "owlette-api".to_owned(),
            aud: "swoop-host".to_owned(),
            role: Role::Viewer,
            uid: Some("uid_operator".to_owned()),
            site: "site_1".to_owned(),
            machine: "machine_1".to_owned(),
            sid: Some("sid_1".to_owned()),
            viewer: Some(viewer.to_owned()),
            ctl: Some(ctl),
            fp: Some("aa:bb".to_owned()),
            iat: 1_000_000,
            exp: Some(1_000_060),
            jti: "jti_1".to_owned(),
        }
    }

    #[test]
    fn a_viewer_joins_watch_only_whatever_the_room_said() {
        let mut roster = Roster::new(true);
        assert!(roster.join("viewer-a"));
        assert!(!roster.control_granted("viewer-a"));
        // The room's `viewer-join` carries a `ctl` of its own and it reaches no
        // field here: only a verified token does.
        assert!(!roster.join("viewer-a"), "a re-offer is not a second viewer");
    }

    #[test]
    fn a_verified_token_is_the_only_thing_that_grants_control() {
        let mut roster = Roster::new(true);
        roster.join("viewer-a");
        assert!(roster.verify("viewer-a", &claims("viewer-a", true)));
        assert!(roster.control_granted("viewer-a"));
        assert_eq!(roster.controllers(), 1);
    }

    /// The bundle's `ctl` is a floor: a session that refuses control refuses it
    /// however good the viewer's token is.
    #[test]
    fn the_bundles_ctl_false_refuses_control_to_a_token_that_claims_it() {
        let mut roster = Roster::new(false);
        roster.join("viewer-a");
        assert!(!roster.verify("viewer-a", &claims("viewer-a", true)));
        assert!(!roster.control_granted("viewer-a"));
    }

    /// §11 binds a token to one viewer id, so one verified for another viewer
    /// grants nothing here.
    #[test]
    fn a_token_naming_another_viewer_grants_nothing() {
        let mut roster = Roster::new(true);
        roster.join("viewer-a");
        roster.join("viewer-b");
        assert!(!roster.verify("viewer-a", &claims("viewer-b", true)));
        assert!(!roster.control_granted("viewer-a"));
        assert!(!roster.control_granted("viewer-b"));
    }

    #[test]
    fn a_token_without_ctl_stays_a_watcher() {
        let mut roster = Roster::new(true);
        roster.join("viewer-a");
        assert!(!roster.verify("viewer-a", &claims("viewer-a", false)));
        assert!(!roster.control_granted("viewer-a"));
        assert_eq!(roster.controllers(), 0);
    }

    /// The fields `session/tiers.rs` and the lease ledger read, spelled out so
    /// a rename here fails here rather than in a module this task cannot edit.
    #[test]
    fn a_record_carries_the_fields_the_other_modules_read() {
        let mut roster = Roster::new(true);
        roster.join("viewer-a");
        roster.verify("viewer-a", &claims("viewer-a", true));
        roster.set_codec("viewer-a", Codec::H265);
        roster.set_lease("viewer-a", 1_000_300);
        assert_eq!(
            roster.get("viewer-a"),
            Some(&ViewerRecord {
                viewer_id: "viewer-a".to_owned(),
                display_name: "uid_operator".to_owned(),
                ctl: true,
                codec_class: Codec::H265,
                lease_expires_at: Some(1_000_300),
            })
        );
    }

    #[test]
    fn a_viewer_with_no_uid_is_named_by_its_id() {
        let mut roster = Roster::new(true);
        roster.join("viewer-a");
        let mut anonymous = claims("viewer-a", true);
        anonymous.uid = None;
        roster.verify("viewer-a", &anonymous);
        assert_eq!(
            roster.get("viewer-a").map(|r| r.display_name.as_str()),
            Some("viewer-a")
        );
    }

    #[test]
    fn a_departure_takes_the_record_with_it() {
        let mut roster = Roster::new(true);
        roster.join("viewer-a");
        roster.verify("viewer-a", &claims("viewer-a", true));
        assert!(roster.leave("viewer-a").is_some());
        assert!(roster.is_empty());
        assert!(!roster.control_granted("viewer-a"));
        assert!(roster.leave("viewer-a").is_none());
    }

    #[test]
    fn the_roster_message_carries_no_token_no_lease_and_no_fingerprint() {
        let mut roster = Roster::new(true);
        roster.join("viewer-a");
        roster.join("viewer-b");
        roster.verify("viewer-a", &claims("viewer-a", true));
        roster.set_lease("viewer-a", 1_000_300);
        let line = serde_json::to_string(&roster.presence(1_700_000)).expect("it serialises");
        assert_eq!(
            line,
            "{\"t\":\"roster\",\"viewers\":[\
             {\"id\":\"viewer-a\",\"name\":\"uid_operator\",\"ctl\":true},\
             {\"id\":\"viewer-b\",\"name\":\"viewer-b\",\"ctl\":false}],\
             \"tsUs\":1700000}"
        );
    }

    #[test]
    fn a_cursor_is_a_viewer_and_a_normalised_point() {
        let line = serde_json::to_string(&Presence::Vpos {
            viewer: "viewer-a".to_owned(),
            x: 0.5,
            y: 0.25,
            ts_us: 1_700_000,
        })
        .expect("it serialises");
        assert_eq!(
            line,
            "{\"t\":\"vpos\",\"viewer\":\"viewer-a\",\"x\":0.5,\"y\":0.25,\"tsUs\":1700000}"
        );
    }
}
