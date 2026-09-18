//! Video encoders behind one trait (plan.md D7).
//!
//! Every backend module root exposes exactly `probe() -> BackendCaps` and
//! `create(&EncoderConfig) -> Result<Box<dyn Encoder>>`, `#[cfg(feature = ...)]`
//! gated, so Task 7.3 can select between them without knowing which are built
//! in. Tasks 3.7, 7.1, 7.2 and 7.3 all sign against the types below — they are
//! contract, not convenience.

use serde::{Deserialize, Serialize};

use crate::gpu::Frame;

#[cfg(all(windows, feature = "encode-nvenc"))]
pub mod nvenc;

// Spike 6.7 picks the crate behind the Intel, AMD and software backends —
// FFmpeg's LGPL `*_qsv`/`*_amf` (what Sunshine ships), native oneVPL/AMF, or
// openh264 — so each of these is gated on either feature until it does.
#[cfg(all(windows, any(feature = "encode-amf", feature = "encode-ffmpeg")))]
pub mod amf;
#[cfg(all(windows, feature = "encode-mf"))]
pub mod mf;
#[cfg(all(windows, any(feature = "encode-vpl", feature = "encode-ffmpeg")))]
pub mod qsv;
#[cfg(any(feature = "encode-openh264", feature = "encode-ffmpeg"))]
pub mod soft;

/// Video codecs, in the order plan.md D5 prefers them.
///
/// A codec is chosen per viewer from the browser's capability probe ∩ this
/// host's encoders, so one viewer on H.264 never downgrades a viewer on H.265.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    H265,
    H264,
}

/// What one encoder backend can actually do on this machine, measured rather
/// than assumed. This is what `probe` reports and what Task 7.3 selects on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendCaps {
    /// Backend name as the selection table and the probe JSON spell it —
    /// "nvenc", "qsv", "amf", "mf", "openh264".
    pub backend: &'static str,
    /// Per-codec limits. A codec absent from this list is not encodable here.
    pub codecs: Vec<CodecCaps>,
    /// Whether the backend takes a BGRA texture directly. False means a GPU
    /// convert pass (Task 4.5) sits in front of it and costs a frame stage.
    pub accepts_bgra_texture: bool,
    /// Frames per second the backend sustained at its largest supported size,
    /// measured on this machine — not a datasheet number.
    pub max_fps: u32,
    /// How many simultaneous encode sessions the driver allows. Consumer NVIDIA
    /// drivers cap this, and Task 8.2's encoder tiers are min(codec classes
    /// present, this).
    pub concurrent_sessions: u32,
}

/// Per-codec limits within one backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodecCaps {
    pub codec: Codec,
    pub max_width: u32,
    pub max_height: u32,
}

/// Everything a backend needs to open a session.
///
/// A change to `width`, `height` or `codec` is a new encoder, not a
/// reconfigure, because the browser has to reconfigure its decoder anyway and
/// the transition is always a fresh IDR (plan.md D5).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderConfig {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Constant bitrate target. The rate governor moves it; the encoder is
    /// always CBR with a one-frame VBV, never VBR.
    pub bitrate_bps: u32,
}

/// One encoded frame, ready to be framed and sent.
pub struct EncodedFrame {
    pub data: Vec<u8>,
    /// An IRAP (IDR) frame, which carries its parameter sets in band. A viewer
    /// joining mid-stream waits for one of these.
    pub is_irap: bool,
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    /// Monotonic frame counter, so a receiver can name the frame it lost.
    pub frame_id: u64,
    /// QPC ticks: capture presented, encode returned. Both travel to the
    /// browser (plan.md D16).
    pub captured_qpc: i64,
    pub encoded_qpc: i64,
}

/// A live encode session.
pub trait Encoder: Send {
    /// Submit a captured frame. Returning `Ok(None)` is normal — an encoder
    /// running asynchronously has not produced output for this input yet.
    fn encode(&mut self, frame: &Frame, force_irap: bool) -> anyhow::Result<Option<EncodedFrame>>;

    /// Move the CBR target. Called by the rate governor, several times a
    /// second, and must not restart the session.
    fn set_bitrate(&mut self, bitrate_bps: u32) -> anyhow::Result<()>;
}
