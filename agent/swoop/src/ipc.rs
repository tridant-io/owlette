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
