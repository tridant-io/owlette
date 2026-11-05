//! Video encoders behind one trait (plan.md D7).
//!
//! Every backend module root — each rung's, so `mf::hw` and `mf::sw` both —
//! exposes exactly `probe() -> BackendCaps` and `create(&EncoderConfig) ->
//! Result<Box<dyn Encoder>>`, `#[cfg(feature = ...)]` gated, so Task 7.3 can
//! select between them without knowing which are built in. Tasks 3.7, 7.1,
//! 7.2 and 7.3 all sign against the types below — they are contract, not
//! convenience.

use serde::{Deserialize, Serialize};

use crate::gpu::Frame;

#[cfg(all(windows, feature = "encode-nvenc"))]
pub mod nvenc;

// The rungs below NVENC on Windows: the hardware MFT and the in-box software
// encoder, both through Media Foundation (`mf::hw`, `mf::sw`).
#[cfg(all(windows, feature = "encode-mf"))]
pub mod mf;
#[cfg(all(target_os = "macos", feature = "encode-videotoolbox"))]
pub mod videotoolbox;

// The H.264 SPS reader and its bitstream-restriction rewrite. Plain Rust with
// no platform in it, so its tests run on every system.
pub mod h264_sps;

// The chain over whichever of the above are built, and the only module that
// knows their order. Never gated: with no backend compiled in it still answers,
// with nothing.
pub mod select;

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
    /// "nvenc", "mf-hw", "mf-sw", "videotoolbox".
    pub backend: &'static str,
    /// Per-codec limits. A codec absent from this list is not encodable here.
    pub codecs: Vec<CodecCaps>,
    /// Whether the backend takes a BGRA texture directly. False means a GPU
    /// convert pass (Task 4.5) sits in front of it and costs a frame stage.
    pub accepts_bgra_texture: bool,
    /// Frames per second the backend sustained at its largest supported size,
    /// measured on this machine — not a datasheet number. 0 where nothing was
    /// measured: the Media Foundation rungs' probe never encodes. Nothing
    /// selects or tiers on it.
    pub max_fps: u32,
    /// How many simultaneous encode sessions the backend serves. NVENC counts
    /// the driver's own cap by opening sessions; Media Foundation has no such
    /// count, and its rungs report a fixed 4 that their modules document.
    /// Task 8.2's encoder tiers are min(codec classes present, this).
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

/// Where an asynchronous backend hands finished frames, from whatever thread
/// finishes them. Answers whether the frame was taken: one refused leaves a
/// hole, and the backend forces its next frame to an IRAP.
pub type Sink = Box<dyn Fn(EncodedFrame) -> bool + Send + Sync>;

/// A live encode session.
pub trait Encoder: Send {
    /// Submit a captured frame. Returning `Ok(None)` is normal — an encoder
    /// running asynchronously has not produced output for this input yet, or
    /// hands it to its [`Sink`] instead.
    fn encode(&mut self, frame: &Frame, force_irap: bool) -> anyhow::Result<Option<EncodedFrame>>;

    /// Deliver finished frames through `sink` as they complete instead of
    /// answering them from `encode`, so the next capture overlaps this
    /// encode. A backend that encodes asynchronously takes it (VideoToolbox);
    /// the rest answer from `encode`, which is what the default keeps.
    fn set_sink(&mut self, _sink: Sink) {}

    /// Move the CBR target. Called by the rate governor, several times a
    /// second, and must not restart the session.
    fn set_bitrate(&mut self, bitrate_bps: u32) -> anyhow::Result<()>;
}
