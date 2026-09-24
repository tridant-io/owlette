//! The ten signaling messages and their per-role send rights. Task 2.10 fills
//! them, against agent/swoop/PROTOCOL.md.
//!
//! The room is a dumb pipe: every authorisation decision was made by the api
//! before the token was minted, and the room only enforces who may send what to
//! whom. The host checks the same table again, because a message it receives
//! has been forwarded by something it does not trust.
//!
//! §5's data-channel messages live in [`channel`] below. They are a different
//! wire — the peer connection, not the signaling socket — but they are the
//! other half of the same contract and the same golden-vector manifest proves
//! both, so they share this file rather than being scattered across the feature
//! modules that will act on them.

use std::fmt;

use serde::{Deserialize, Serialize};

/// §2: a frame above this is refused `message_too_large`.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// Who put a frame on the wire. `server` is the room itself, which is why this
/// is wider than a jwt's `role`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Server,
    Viewer,
    Host,
    Doorbell,
}

/// Why a frame was refused. The room sends most of these as an `error` code;
/// `version_mismatch` travels as a `bye` reason instead (§1) and the last two
/// are §5's channel refusals, so the set is wider than §2's error table. Every
/// spelling is a reason code in `testdata/protocol/index.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    /// A client sent a server-only type: it cannot forge a ring or a kill.
    ForbiddenType,
    /// A known type, sent by a role that may not send it.
    WrongRole,
    UnknownType,
    BinaryUnsupported,
    MessageTooLarge,
    MalformedMessage,
    /// The url named a room the verified token does not.
    RoomMismatch,
    VersionMismatch,
    /// §5: a viewer without `ctl` sent something gated.
    NotPermitted,
    ClipboardTooLarge,
}

impl Refusal {
    pub fn reason(self) -> &'static str {
        match self {
            Refusal::ForbiddenType => "forbidden_type",
            Refusal::WrongRole => "wrong_role",
            Refusal::UnknownType => "unknown_type",
            Refusal::BinaryUnsupported => "binary_unsupported",
            Refusal::MessageTooLarge => "message_too_large",
            Refusal::MalformedMessage => "malformed_message",
            Refusal::RoomMismatch => "room_mismatch",
            Refusal::VersionMismatch => "version_mismatch",
            Refusal::NotPermitted => "not_permitted",
            Refusal::ClipboardTooLarge => "clipboard_too_large",
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason())
    }
}

impl std::error::Error for Refusal {}

/// Socket counts in the room, as `hello` reports them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Peers {
    pub doorbell: u32,
    pub host: u32,
    pub viewer: u32,
}

/// The ten types. `from`, `fromRole` and `serverTimeMs` are stamped by the room
/// on what it forwards, so they are absent on a frame as a client sends it and
/// present on the same frame as a peer receives it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Message {
    /// Server only, to the socket that just joined.
    Hello {
        protocol_version: u32,
        role: Role,
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sid: Option<String>,
        ctl: bool,
        peers: Peers,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_time_ms: Option<i64>,
    },
    /// Server only, to doorbell sockets. A sid and nothing else (§11).
    Ring {
        sid: String,
        sent_at_ms: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_time_ms: Option<i64>,
    },
    /// Server only, to host and doorbell.
    ViewerJoin {
        viewer: String,
        sid: String,
        ctl: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_time_ms: Option<i64>,
    },
    /// Server only, to the offending socket: a code and nothing else.
    Error {
        code: Refusal,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_time_ms: Option<i64>,
    },
    /// Server only, to every socket, then `close(1000)`. A null sid means
    /// "kill whatever is running".
    Kill {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sid: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_time_ms: Option<i64>,
    },
    /// Viewer only. The browser always offers.
    Offer {
        sdp: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_role: Option<Role>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_time_ms: Option<i64>,
    },
    /// Host only, to the named viewer. `mac` is §9's host fingerprint MAC; a
    /// browser that cannot recompute it aborts rather than warning.
    Answer {
        to: String,
        sdp: String,
        mac: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_role: Option<Role>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_time_ms: Option<i64>,
    },
    /// Host only, to the named viewer or to all of them.
    HostReady {
        sid: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_role: Option<Role>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_time_ms: Option<i64>,
    },
    /// Viewer or host.
    Candidate {
        candidate: String,
        sdp_mid: String,
        sdp_m_line_index: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_role: Option<Role>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_time_ms: Option<i64>,
    },
    /// Viewer or host.
    Bye {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_role: Option<Role>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_time_ms: Option<i64>,
    },
}

impl Message {
    /// The `type` string, for the send-rights table and for logging a refusal
    /// without logging the frame.
    pub fn type_name(&self) -> &'static str {
        match self {
            Message::Hello { .. } => "hello",
            Message::Ring { .. } => "ring",
            Message::ViewerJoin { .. } => "viewer-join",
            Message::Error { .. } => "error",
            Message::Kill { .. } => "kill",
            Message::Offer { .. } => "offer",
            Message::Answer { .. } => "answer",
            Message::HostReady { .. } => "host-ready",
            Message::Candidate { .. } => "candidate",
            Message::Bye { .. } => "bye",
        }
    }

    /// True for the five types only the room may originate.
    pub fn is_server_only(&self) -> bool {
        matches!(
            self,
            Message::Hello { .. }
                | Message::Ring { .. }
                | Message::ViewerJoin { .. }
                | Message::Error { .. }
                | Message::Kill { .. }
        )
    }
}

/// §2's send-rights table, decided from the `type` string alone.
///
/// The check runs before the body is parsed, because that is the order the
/// refusals are defined in: a viewer forging a `kill` is `forbidden_type` even
/// when the frame it forged is also malformed, and a room that parsed first
/// would report the wrong reason and tell an attacker which fields it wanted.
pub fn check_send_right_for_type(sender: Role, type_name: &str) -> Result<(), Refusal> {
    let allowed = match type_name {
        // server only: a client cannot forge a ring or a kill.
        "hello" | "ring" | "viewer-join" | "error" | "kill" => {
            return if sender == Role::Server {
                Ok(())
            } else {
                Err(Refusal::ForbiddenType)
            }
        }
        "offer" => sender == Role::Viewer,
        "answer" | "host-ready" => sender == Role::Host,
        "candidate" | "bye" => matches!(sender, Role::Viewer | Role::Host),
        _ => return Err(Refusal::UnknownType),
    };
    if allowed {
        Ok(())
    } else {
        Err(Refusal::WrongRole)
    }
}

/// The same table, for a frame that is already parsed.
pub fn check_send_right(sender: Role, message: &Message) -> Result<(), Refusal> {
    check_send_right_for_type(sender, message.type_name())
}

/// §1: one integer, asserted on the room's first frame. A mismatch is
/// `bye`/`version_mismatch`, a close and a message to the user — never a
/// negotiation, a downgrade or a "proceed anyway".
pub fn check_hello_version(message: &Message, supported: u32) -> Result<(), Refusal> {
    match message {
        Message::Hello { protocol_version, .. } if *protocol_version == supported => Ok(()),
        Message::Hello { .. } => Err(Refusal::VersionMismatch),
        _ => Err(Refusal::UnknownType),
    }
}

/// §5's data-channel messages: input, cursor, clipboard, control and feedback.
pub mod channel {
    use serde::{Deserialize, Serialize};

    use super::Refusal;

    /// Text caps at 256 KiB, an image at 2 MiB, one chunk at 16 KiB. Checked
    /// before the first chunk is buffered — a receiver that waits until
    /// reassembly to notice the size has already paid for it.
    pub const CLIPBOARD_TEXT_MAX_BYTES: u64 = 256 * 1024;
    pub const CLIPBOARD_IMAGE_MAX_BYTES: u64 = 2 * 1024 * 1024;
    pub const CLIPBOARD_CHUNK_MAX_BYTES: u64 = 16 * 1024;

    /// The five data channels. The host refuses any other label and never
    /// creates a channel itself — the browser is the offerer.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum Channel {
        SwoopInput,
        SwoopCursor,
        SwoopControl,
        SwoopFeedback,
        SwoopMeta,
    }

    /// `swoop-input`, viewer → host, gated on `ctl`.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(
        tag = "t",
        rename_all = "lowercase",
        rename_all_fields = "camelCase",
        deny_unknown_fields
    )]
    pub enum Input {
        /// A `KeyboardEvent.code`, never a `key`: the numpad and the
        /// control/arrow pad share scancode low bytes and are told apart only
        /// by the extended flag.
        K { code: String, down: bool, seq: u64, ts_us: i64 },
        /// Absolute, normalised 0..1 of the selected display.
        M { x: f64, y: f64, seq: u64, ts_us: i64 },
        /// Relative, from pointer lock with `unadjustedMovement`.
        Mr { dx: f64, dy: f64, seq: u64, ts_us: i64 },
        B { button: u8, down: bool, seq: u64, ts_us: i64 },
        W { dx: f64, dy: f64, mode: WheelMode, seq: u64, ts_us: i64 },
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum WheelMode {
        Pixel,
        Line,
        Page,
    }

    /// `swoop-cursor`, host → viewer. Shapes are cached by `id`; a repeat is
    /// `{"t":"cshape","id":n}` alone.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(
        tag = "t",
        rename_all = "lowercase",
        rename_all_fields = "camelCase",
        deny_unknown_fields
    )]
    pub enum Cursor {
        Cpos { x: f64, y: f64, visible: bool, ts_us: i64 },
        Cshape {
            id: u32,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            hot_x: Option<u16>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            hot_y: Option<u16>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            w: Option<u16>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            h: Option<u16>,
            /// Machine pixels per png pixel, sent only when above 1: the host
            /// shrinks a shape past the css ceiling for the wire and the
            /// viewer draws it back at `w * scale`.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            scale: Option<u16>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            png: Option<String>,
        },
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum ClipDirection {
        ToHost,
        ToViewer,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum ClipFormat {
        Text,
        Png,
    }

    /// Clipboard shares `swoop-control` rather than taking a sixth channel:
    /// both are reliable, ordered and rare, and the transport caps buffering
    /// across all channels, so fewer channels is one pacing budget.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(
        tag = "t",
        rename_all = "lowercase",
        rename_all_fields = "camelCase",
        deny_unknown_fields
    )]
    pub enum Clipboard {
        Clip {
            dir: ClipDirection,
            fmt: ClipFormat,
            seq: u64,
            chunk: u32,
            chunks: u32,
            total_bytes: u64,
            data: String,
        },
    }

    impl Clipboard {
        /// Admit a transfer on its first chunk, or refuse the whole thing.
        /// File lists are never carried; there is no file transfer in this
        /// protocol.
        pub fn admit(&self) -> Result<(), Refusal> {
            let Clipboard::Clip { fmt, chunks, total_bytes, .. } = self;
            let cap = match fmt {
                ClipFormat::Text => CLIPBOARD_TEXT_MAX_BYTES,
                ClipFormat::Png => CLIPBOARD_IMAGE_MAX_BYTES,
            };
            if *total_bytes > cap || *chunks == 0 {
                return Err(Refusal::ClipboardTooLarge);
            }
            let chunk_ceiling = u64::from(*chunks).saturating_mul(CLIPBOARD_CHUNK_MAX_BYTES);
            if *total_bytes > chunk_ceiling {
                return Err(Refusal::ClipboardTooLarge);
            }
            Ok(())
        }
    }

    /// One display as `hello-host` advertises it.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub struct DisplayInfo {
        pub index: u32,
        pub width: u32,
        pub height: u32,
        pub primary: bool,
    }

    /// `swoop-control`, both directions.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(
        tag = "t",
        rename_all = "kebab-case",
        rename_all_fields = "camelCase",
        deny_unknown_fields
    )]
    pub enum Control {
        /// host → viewer, first thing on the channel.
        HelloHost {
            codec: String,
            width: u32,
            height: u32,
            displays: Vec<DisplayInfo>,
            streamer_epoch: i64,
            protocol_version: u32,
        },
        /// viewer → host, per viewer, allowed for watchers.
        Quality { preset: String, max_bitrate_kbps: u32, max_fps: u32 },
        /// viewer → host, shared state, requires `ctl`.
        Display { index: u32 },
        Idr,
        /// ctrl+alt+del. The service calls `SendSAS`, not the streamer.
        Sas,
        Mute { on: bool },
        /// §10's silent renewal, carried through the browser so there is no
        /// server→host push path and no second verification code path.
        Lease { token: String },
        SasResult { ok: bool },
        LeaseOk { expires_at: i64 },
        Ended { reason: String },
    }

    impl Control {
        /// Which viewer→host control messages need `ctl`. `quality` does not —
        /// a watcher may still ask for less bitrate.
        pub fn requires_control(&self) -> bool {
            matches!(self, Control::Display { .. } | Control::Sas)
        }
    }

    /// `swoop-feedback`, viewer → host. Drives the rate governor.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(
        tag = "t",
        rename_all = "lowercase",
        rename_all_fields = "camelCase",
        deny_unknown_fields
    )]
    pub enum Feedback {
        /// Sampled, not every frame.
        Fb {
            frame_id: u32,
            t_arrival_us: i64,
            t_decode_us: i64,
            t_present_us: i64,
            clock_offset_us: i64,
        },
        /// Once a second.
        Stats {
            decode_queue: u32,
            frames_dropped: u32,
            jitter_ms: f64,
            rtt_ms: f64,
            width_css: u32,
            height_css: u32,
        },
        /// The app-level round trip; its one-way half is the offset that makes
        /// §4's timestamps comparable across the two clocks.
        Ping { id: u64, t_us: i64 },
        Pong { id: u64, t_us: i64, host_us: i64 },
    }

    /// §5's control gate. `ctl` comes from the verified jwt, never from what
    /// the browser says about itself, and the bundle's `ctl` is a floor on top:
    /// `false` there refuses control for the whole session whatever a viewer
    /// token claims.
    pub fn control_granted(session_ctl: bool, viewer_ctl: bool) -> bool {
        session_ctl && viewer_ctl
    }

    /// Admit a gated message, or refuse it. A viewer without `ctl` that sends
    /// one is dropped and the attempt is reported for the audit trail.
    pub fn admit_gated(session_ctl: bool, viewer_ctl: bool) -> Result<(), Refusal> {
        if control_granted(session_ctl, viewer_ctl) {
            Ok(())
        } else {
            Err(Refusal::NotPermitted)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::channel::*;
    use super::*;

    #[test]
    fn a_client_cannot_forge_a_server_only_type() {
        let kill = Message::Kill { sid: None, server_time_ms: None };
        assert_eq!(check_send_right(Role::Viewer, &kill), Err(Refusal::ForbiddenType));
        assert_eq!(check_send_right(Role::Host, &kill), Err(Refusal::ForbiddenType));
        assert_eq!(check_send_right(Role::Server, &kill), Ok(()));
    }

    #[test]
    fn the_browser_offers_and_the_host_answers() {
        let offer = Message::Offer {
            sdp: "v=0\r\n".to_owned(),
            from: None,
            from_role: None,
            server_time_ms: None,
        };
        assert_eq!(check_send_right(Role::Viewer, &offer), Ok(()));
        assert_eq!(check_send_right(Role::Host, &offer), Err(Refusal::WrongRole));

        let answer = Message::Answer {
            to: "viewer_1".to_owned(),
            sdp: "v=0\r\n".to_owned(),
            mac: "AAAA".to_owned(),
            from: None,
            from_role: None,
            server_time_ms: None,
        };
        assert_eq!(check_send_right(Role::Host, &answer), Ok(()));
        assert_eq!(check_send_right(Role::Viewer, &answer), Err(Refusal::WrongRole));
    }

    #[test]
    fn an_unknown_field_on_a_signaling_message_is_refused() {
        let json = r#"{"type":"ring","sid":"sid_1","sentAtMs":1,"extra":true}"#;
        assert!(serde_json::from_str::<Message>(json).is_err());
    }

    #[test]
    fn a_version_mismatch_is_never_negotiated() {
        let hello = Message::Hello {
            protocol_version: 2,
            role: Role::Viewer,
            id: "viewer_1".to_owned(),
            sid: None,
            ctl: true,
            peers: Peers { doorbell: 1, host: 1, viewer: 0 },
            server_time_ms: None,
        };
        assert_eq!(check_hello_version(&hello, 1), Err(Refusal::VersionMismatch));
        assert_eq!(check_hello_version(&hello, 2), Ok(()));
    }

    #[test]
    fn a_clipboard_transfer_is_sized_before_its_first_chunk_is_buffered() {
        assert_eq!(
            clip(ClipFormat::Text, 200, 3 * 1024 * 1024).admit(),
            Err(Refusal::ClipboardTooLarge)
        );
        assert_eq!(
            clip(ClipFormat::Png, 200, 3 * 1024 * 1024).admit(),
            Err(Refusal::ClipboardTooLarge)
        );
        assert_eq!(clip(ClipFormat::Png, 128, 2 * 1024 * 1024).admit(), Ok(()));
        // 11 bytes of text in one chunk, the ordinary case.
        assert_eq!(clip(ClipFormat::Text, 1, 11).admit(), Ok(()));
        // a transfer that cannot fit in the chunks it declares is refused too.
        assert_eq!(
            clip(ClipFormat::Text, 1, 64 * 1024).admit(),
            Err(Refusal::ClipboardTooLarge)
        );
    }

    fn clip(fmt: ClipFormat, chunks: u32, total_bytes: u64) -> Clipboard {
        Clipboard::Clip {
            dir: ClipDirection::ToHost,
            fmt,
            seq: 1,
            chunk: 0,
            chunks,
            total_bytes,
            data: String::new(),
        }
    }

    #[test]
    fn the_session_floor_beats_a_viewers_own_claim() {
        assert_eq!(admit_gated(true, true), Ok(()));
        assert_eq!(admit_gated(false, true), Err(Refusal::NotPermitted));
        assert_eq!(admit_gated(true, false), Err(Refusal::NotPermitted));
    }
}
