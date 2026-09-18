//! Transport: encoded frames out to one viewer.
//!
//! G1 chose arm B — an RTP media track rendered into a `<video>` element, with
//! playout-delay `min=0, max ∈ (0, 500] ms`. The `VideoSink` seam stays anyway,
//! because it is what would make a second video path (arm A, encoded frames
//! over a data channel) cheap if it is ever revisited with a working SCTP RTO
//! and a pacer. `web/lib/swoop/video/receiver.ts` is the same seam in the
//! browser.

use crate::encode::EncodedFrame;

pub mod budget;
pub mod framing;
pub mod governor;
pub mod ice_policy;
pub mod pacer;
pub mod rtc;
#[cfg(feature = "turn")]
pub mod turn;

/// One viewer's video path.
pub trait VideoSink: Send {
    /// Hand over an encoded frame. Never blocks on the network: a sink that
    /// cannot keep up drops and says so through the governor, because stalling
    /// here would stall capture for every other viewer.
    fn send(&mut self, frame: &EncodedFrame) -> anyhow::Result<()>;

    /// True when this viewer needs an IRAP — it just joined, or it asked for
    /// one. Join and PLI keyframes are coalesced across viewers by the session,
    /// never requested straight from the encoder (plan.md D14).
    fn wants_irap(&self) -> bool;
}
