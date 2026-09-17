//! Implementations of [`crate::sink::VideoSink`], one per arm of plan.md D3.
//!
//! Stage 1 of spike 0.2 shipped `rtp_track` (arm B). Stage 2 adds
//! `data_channel` (arm A, encoded access units fragmented at the SCTP payload
//! size over an `RTCDataChannel`) and `script_transform` (arm C, arm B's sender
//! with a receive-side `RTCRtpScriptTransform` on the browser).
//!
//! **Arm C's host side is arm B's** — the prediction stage 1 wrote here held.
//! [`script_transform::ScriptTransformSink`] constructs an
//! [`rtp_track::RtpTrackSink`] and overrides exactly
//! [`crate::sink::VideoSink::arm`] and [`crate::sink::VideoSink::client_config`];
//! every other method forwards. Nothing in `capture.rs`, `nvenc.rs`,
//! `dxgi.rs` or `pipeline.rs` changed for either new arm. `httpd.rs` and
//! `main.rs` changed only in which implementation they construct, which is what
//! `pipeline.rs`'s module doc said adding an arm would cost.

pub mod data_channel;
pub mod rtp_track;
pub mod script_transform;

/// The cap on bytes buffered across **all** SCTP streams in the **released**
/// str0m 0.23.1, `str0m/src/sctp/mod.rs:30`. Private there, mirrored here so
/// arm A's diagnostics can report what its `maxBufferedAmountBytes` is being
/// measured against.
///
/// A run built with `--config .cargo/sctp-patched.toml` raises it (see
/// `sctp-patches/`), and this constant does **not** move with it — it is the
/// baseline, not a reading. A run whose `maxBufferedAmountBytes` exceeds this
/// value is a patched run, which is exactly how the two are told apart in the
/// results.
///
/// `review-1-latency.md` F1 is the reason it is worth reporting at all: Chrome's
/// own dcSCTP allows `max_send_buffer_size = 2_000_000` with a separate
/// per-stream limit, and this cap is shared with every other channel on the
/// association.
pub const MAX_BUFFERED_ACROSS_STREAMS_RELEASED: usize = 128 * 1024;

#[cfg(test)]
mod tests {
    /// If this ever fails, str0m's constant moved and every arm-A row that
    /// quoted the old one is stale. There is no public accessor to assert it
    /// against, which is exactly why the value is pinned here with its source.
    #[test]
    fn the_mirrored_cap_is_the_value_review_1_f1_measured_against() {
        assert_eq!(super::MAX_BUFFERED_ACROSS_STREAMS_RELEASED, 131_072);
    }
}
