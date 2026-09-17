//! Implementations of [`crate::sink::VideoSink`], one per arm of plan.md D3.
//!
//! Stage 1 of spike 0.2 ships `rtp_track` (arm B). Stage 2 adds `data_channel`
//! (arm A, encoded frames over an `RTCDataChannel` on a patched `sctp-proto`)
//! and `script_transform` (arm C, the same RTP sender as arm B with a
//! receive-side `RTCRtpScriptTransform` on the browser).
//!
//! **Arm C's host side is arm B's.** When it lands it is expected to construct
//! an [`rtp_track::RtpTrackSink`] and override only [`crate::sink::VideoSink::arm`]
//! and [`crate::sink::VideoSink::client_config`], because the difference between
//! B and C lives entirely in the browser. Nothing in `capture.rs`,
//! `pipeline.rs` or `httpd.rs` needs to change for either.

pub mod rtp_track;
