//! The stdin/stdout line protocol with the agent service.
//!
//! stdin carries the bundle line and then control lines; stdout carries JSON
//! event lines; stderr goes to the log. There is no file seam between the
//! service and the streamer (plan.md D2). Task 2.10 fills the message types,
//! against agent/swoop/PROTOCOL.md.

use std::fmt;
use std::io::{self, Write};

use serde::{Deserialize, Serialize};

use crate::bundle::Indicator;

/// Process exit codes. These are the plan's names registry, and the agent
/// reports on them, so they are contract: add, never renumber.
pub mod exit {
    /// Normal exit — the last viewer left and the linger expired, or the
    /// service asked for a kill.
    pub const OK: u8 = 0;
    /// The bundle on stdin was missing, malformed, or carried a field this
    /// build does not accept (an `overrides` object without `testhooks`).
    pub const BUNDLE_INVALID: u8 = 10;
    /// The bundle's version does not match this binary's — a stale streamer
    /// after an upgrade that was delayed until reboot.
    pub const VERSION_MISMATCH: u8 = 11;
    pub const NO_CAPTURE_SOURCE: u8 = 12;
    pub const NO_ENCODER: u8 = 13;
    pub const SIGNALING_UNREACHABLE: u8 = 14;
    pub const INTERNAL: u8 = 20;
}

/// The same codes as one typed value, so a failure travels as a reason rather
/// than a loose integer. `exit` above stays the numbering; this is the vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Ok,
    BundleInvalid,
    VersionMismatch,
    NoCaptureSource,
    NoEncoder,
    SignalingUnreachable,
    Internal,
}

impl Exit {
    pub const fn code(self) -> u8 {
        match self {
            Exit::Ok => exit::OK,
            Exit::BundleInvalid => exit::BUNDLE_INVALID,
            Exit::VersionMismatch => exit::VERSION_MISMATCH,
            Exit::NoCaptureSource => exit::NO_CAPTURE_SOURCE,
            Exit::NoEncoder => exit::NO_ENCODER,
            Exit::SignalingUnreachable => exit::SIGNALING_UNREACHABLE,
            Exit::Internal => exit::INTERNAL,
        }
    }
}

impl From<Exit> for std::process::ExitCode {
    fn from(value: Exit) -> Self {
        std::process::ExitCode::from(value.code())
    }
}

/// Why a viewer's peer connection went away. The service reports it, so the
/// spellings are contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeftReason {
    Bye,
    Timeout,
    LeaseExpired,
    Kill,
}

/// Why the streamer is exiting, alongside the numeric code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    Idle,
    Kill,
    SignalLost,
    SessionCap,
    Error,
}

/// Whether media is flowing peer to peer or through a relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaPath {
    Direct,
    Relay,
}

/// Which desktop the capture and input threads are attached to.
///
/// [`Desktop::Unknown`] is an `OpenInputDesktop` that failed, and it is never
/// reported as a lock: the call fails for reasons that have nothing to do with
/// the secure desktop, and "locked" is a claim the machine cannot support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Desktop {
    Default,
    Winlogon,
    Screensaver,
    Unknown,
}

/// The render endpoint, as the audio feature finds it. `NoEndpoint` is a
/// machine with no render device at all — swoop never creates one and never
/// moves the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioState {
    Ok,
    NoEndpoint,
}

/// `Headless` is a machine with no attached output, or one whose duplication
/// yields nothing but black — the state the page answers with the dummy-plug
/// message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayState {
    Ok,
    Headless,
}

/// What the rate governor is doing, for §6's `status`.
///
/// `transport::governor::GovernorState` is the same four words and is the
/// truth; this is their wire spelling, in the one module that owns what goes on
/// stdout. The two are joined by `session`'s `governor_phase`, which is the only
/// place the mapping exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GovernorPhase {
    /// At the preset's ceiling with nothing to answer.
    Ceiling,
    /// Inside the hold after a cut.
    Holding,
    /// Below the ceiling and walking back up.
    Climbing,
    /// At the floor: the rate has nothing left to give.
    Pinned,
}

/// What a [`Event::HostEvent`] records.
///
/// This is verbatim the closed `type` vocabulary of
/// `POST /api/agent/swoop/events`: the service copies it straight into the
/// request body, so a name added here without being added there is a 400 for
/// the whole batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostEventKind {
    /// §11's verification order refused the viewer's token.
    JwtRejected,
    /// The offer carried no fingerprint, or not the one the token binds to.
    FpMismatch,
    /// A lease lapsed, or the token presented as one had already expired.
    LeaseExpired,
    /// §5: a viewer without `ctl` sent something gated.
    InputNotPermitted,
    /// An admission limit — viewer count or join rate — turned a join away.
    JoinRefused,
    /// §5: a clipboard transfer above 64 KiB, recorded for the audit trail.
    ClipboardAudit,
}

/// stdin, service → streamer. Line 1 is the bundle and never reaches here;
/// every line after it is one of these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Control {
    /// End the session and exit 0. `sid` names the session where the service
    /// has one; absent means "kill whatever is running" (§11's sid-only
    /// contract).
    Kill {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sid: Option<String>,
    },
    /// The answer to a `sas_request`. The service, not the streamer, calls
    /// `SendSAS`.
    SasResult { ok: bool },
}

/// stdout, streamer → service. One object per line, drained on a daemon thread
/// so nothing ever blocks the service's five-second loop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Event {
    Ready {
        sid: String,
        pid: u32,
        version: String,
        protocol_version: u32,
        codecs: Vec<String>,
        displays: u32,
    },
    ViewerJoined {
        sid: String,
        viewer: String,
        ctl: bool,
        codec: String,
    },
    ViewerLeft {
        sid: String,
        viewer: String,
        reason: LeftReason,
    },
    SasRequest {
        sid: String,
        viewer: String,
    },
    /// One row for `POST /api/agent/swoop/events`. The streamer is the only
    /// place most of these can be observed at all, and the service is the only
    /// thing holding a credential to report them with.
    HostEvent {
        sid: String,
        kind: HostEventKind,
        /// Absent when the refusal is not attributable to one viewer.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewer: Option<String>,
        /// The detail code behind `kind`, from the vocabulary the refusing
        /// module already owns (`DenialReason`, `TokenError`). Never prose and
        /// never a value: the route accepts `^[a-z0-9_]{1,48}$` and nothing else.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Every optional field below is absent when it has nothing to say, which
    /// is what keeps a `status` line from a session with no features running
    /// byte-identical to the golden vector. Absent is not "unknown" for the two
    /// counters — it is zero.
    Status {
        sid: String,
        viewers: u32,
        controllers: u32,
        indicator: Indicator,
        bitrate_kbps: u32,
        fps: u32,
        path: MediaPath,
        display: u32,
        uptime_s: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        desktop: Option<Desktop>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audio: Option<AudioState>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        displays: Option<DisplayState>,
        /// The input rate limiter's cumulative drop count.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_dropped: Option<u64>,
        /// The control gate's cumulative refusal count.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        denials: Option<u64>,
        /// The bundle's test-only `overrides`, named so an overridden session
        /// is visible in `logs/swoop` rather than passing for a real one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        test_override: Option<String>,
        /// Which encoder backend the selection chain opened on — `nvenc`,
        /// `qsv`, `amf`, `mf` or `openh264`. Absent until a viewer's offer has
        /// named a codec and the first encoder is open, because until then
        /// nothing has been selected.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encoder: Option<String>,
        /// The quality ceiling in force, as `Ceiling::label` renders it. The
        /// five below are the governor's, and they ride a `status` only while a
        /// viewer's peer is connected: with nobody watching there is no rate
        /// being governed and nothing to say about one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preset: Option<String>,
        /// What the governor is aiming at, against `bitrateKbps` — which is
        /// what actually went out. The pair is the whole point: a target the
        /// link never delivered is invisible from either number alone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_kbps: Option<u32>,
        /// The ladder's current frame-rate rung.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rung_fps: Option<u32>,
        /// Its resolution cap, in `quality.preset`'s own spelling.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rung_resolution: Option<String>,
        /// How far down the preset's ladder that rung is. Absent is zero — the
        /// preset's own rung, which is where a healthy session sits.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rung_index: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        governor: Option<GovernorPhase>,
        /// Keyframes the host forced since `ready`, after §4's coalescing.
        /// Absent means zero.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        idrs: Option<u64>,
    },
    Exiting {
        sid: String,
        code: u8,
        reason: ExitReason,
    },
}

/// A stdin line that is not a control line. Carries no detail: line 1 is the
/// bundle, and a parser error would quote whatever it choked on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlError;

impl fmt::Display for ControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("malformed_control_line")
    }
}

impl std::error::Error for ControlError {}

/// Parse one control line from stdin.
pub fn parse_control(line: &str) -> Result<Control, ControlError> {
    serde_json::from_str(line).map_err(|_| ControlError)
}

/// Write one event and flush it. A half-written line desynchronises the
/// service's reader, which has no way to resynchronise short of killing us.
pub fn emit(out: &mut impl Write, event: &Event) -> io::Result<()> {
    let line = serde_json::to_string(event).map_err(io::Error::other)?;
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_match_the_protocol_table() {
        assert_eq!(Exit::Ok.code(), 0);
        assert_eq!(Exit::BundleInvalid.code(), 10);
        assert_eq!(Exit::VersionMismatch.code(), 11);
        assert_eq!(Exit::NoCaptureSource.code(), 12);
        assert_eq!(Exit::NoEncoder.code(), 13);
        assert_eq!(Exit::SignalingUnreachable.code(), 14);
        assert_eq!(Exit::Internal.code(), 20);
    }

    #[test]
    fn a_kill_without_a_sid_means_whatever_is_running() {
        let control = parse_control(r#"{"type":"kill"}"#).expect("a bare kill is a control line");
        assert_eq!(control, Control::Kill { sid: None });
        assert_eq!(
            serde_json::to_string(&control).expect("it serialises"),
            r#"{"type":"kill"}"#
        );
    }

    #[test]
    fn an_unknown_control_field_is_refused() {
        assert!(parse_control(r#"{"type":"kill","extra":1}"#).is_err());
        assert!(parse_control(r#"{"type":"reboot"}"#).is_err());
    }

    /// The golden vector's `status` line carries none of the optional fields,
    /// and a build that started serialising them would change every existing
    /// vector without any test naming the change.
    #[test]
    fn a_status_with_nothing_optional_to_say_carries_no_optional_fields() {
        let line = serde_json::to_string(&Event::Status {
            sid: "sid_1".to_owned(),
            viewers: 1,
            controllers: 1,
            indicator: Indicator::Banner,
            bitrate_kbps: 18_000,
            fps: 60,
            path: MediaPath::Direct,
            display: 0,
            uptime_s: 42,
            desktop: None,
            audio: None,
            displays: None,
            input_dropped: None,
            denials: None,
            test_override: None,
            encoder: None,
            preset: None,
            target_kbps: None,
            rung_fps: None,
            rung_resolution: None,
            rung_index: None,
            governor: None,
            idrs: None,
        })
        .expect("it serialises");
        assert_eq!(
            line,
            "{\"type\":\"status\",\"sid\":\"sid_1\",\"viewers\":1,\"controllers\":1,\
             \"indicator\":\"banner\",\"bitrateKbps\":18000,\"fps\":60,\"path\":\"direct\",\
             \"display\":0,\"uptimeS\":42}"
        );
    }

    #[test]
    fn the_optional_status_fields_are_camel_case_on_the_wire() {
        let line = serde_json::to_string(&Event::Status {
            sid: "sid_1".to_owned(),
            viewers: 0,
            controllers: 0,
            indicator: Indicator::Banner,
            bitrate_kbps: 0,
            fps: 0,
            path: MediaPath::Direct,
            display: 1,
            uptime_s: 1,
            desktop: Some(Desktop::Winlogon),
            audio: Some(AudioState::NoEndpoint),
            displays: Some(DisplayState::Headless),
            input_dropped: Some(7),
            denials: Some(3),
            test_override: Some("source=testpattern".to_owned()),
            encoder: Some("nvenc".to_owned()),
            preset: Some("auto".to_owned()),
            target_kbps: Some(16_000),
            rung_fps: Some(30),
            rung_resolution: Some("1080p".to_owned()),
            rung_index: Some(2),
            governor: Some(GovernorPhase::Pinned),
            idrs: Some(4),
        })
        .expect("it serialises");
        assert!(line.contains("\"desktop\":\"winlogon\""), "{line}");
        assert!(line.contains("\"audio\":\"no_endpoint\""), "{line}");
        assert!(line.contains("\"displays\":\"headless\""), "{line}");
        assert!(line.contains("\"inputDropped\":7"), "{line}");
        assert!(line.contains("\"denials\":3"), "{line}");
        assert!(line.contains("\"testOverride\":\"source=testpattern\""), "{line}");
        assert!(line.contains("\"encoder\":\"nvenc\""), "{line}");
        assert!(line.contains("\"preset\":\"auto\""), "{line}");
        assert!(line.contains("\"targetKbps\":16000"), "{line}");
        assert!(line.contains("\"rungFps\":30"), "{line}");
        assert!(line.contains("\"rungResolution\":\"1080p\""), "{line}");
        assert!(line.contains("\"rungIndex\":2"), "{line}");
        assert!(line.contains("\"governor\":\"pinned\""), "{line}");
        assert!(line.contains("\"idrs\":4"), "{line}");
    }

    #[test]
    fn a_host_event_carries_the_routes_own_vocabulary() {
        let mut out = Vec::new();
        emit(
            &mut out,
            &Event::HostEvent {
                sid: "sid_1".to_owned(),
                kind: HostEventKind::InputNotPermitted,
                viewer: Some("viewer_1".to_owned()),
                reason: Some("input".to_owned()),
            },
        )
        .expect("writing to a vec never fails");
        assert_eq!(
            String::from_utf8(out).expect("utf-8"),
            "{\"type\":\"host_event\",\"sid\":\"sid_1\",\"kind\":\"input_not_permitted\",\
             \"viewer\":\"viewer_1\",\"reason\":\"input\"}\n"
        );
    }

    #[test]
    fn a_host_event_nobody_can_attribute_omits_the_viewer_and_the_reason() {
        let line = serde_json::to_string(&Event::HostEvent {
            sid: "sid_1".to_owned(),
            kind: HostEventKind::JoinRefused,
            viewer: None,
            reason: None,
        })
        .expect("it serialises");
        assert_eq!(
            line,
            "{\"type\":\"host_event\",\"sid\":\"sid_1\",\"kind\":\"join_refused\"}"
        );
    }

    #[test]
    fn an_event_is_one_line_terminated_by_a_newline() {
        let mut out = Vec::new();
        emit(
            &mut out,
            &Event::SasRequest { sid: "sid_1".to_owned(), viewer: "viewer_1".to_owned() },
        )
        .expect("writing to a vec never fails");
        assert_eq!(
            String::from_utf8(out).expect("utf-8"),
            "{\"type\":\"sas_request\",\"sid\":\"sid_1\",\"viewer\":\"viewer_1\"}\n"
        );
    }
}
