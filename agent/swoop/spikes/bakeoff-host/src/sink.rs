//! **The seam.** One abstraction, three arms behind it.
//!
//! plan.md D3 makes the video path a measured decision between three arms, and
//! requires that "both ends hide the path behind one seam (`transport::VideoSink`
//! on the host, `web/lib/swoop/video/receiver.ts` in the browser) so the second
//! path can be added later without touching capture, encode, decode or
//! presentation". This module is that seam on the host side, shaped so the
//! product file can be a copy of it. Its browser counterpart is
//! `bakeoff-web/public/receivers/receiver.js`.
//!
//! Stage 1 of spike 0.2 implements arm B only ([`sinks::rtp_track`]). Arms A and
//! C are added in stage 2 **behind this trait**, which is why the trait exists
//! now rather than being retrofitted around whatever arm B happened to need.
//!
//! # What each arm has to supply, and what the front half promises
//!
//! The front half (capture → encode) promises:
//!
//! - **Annex-B access units**, single slice per picture, parameter sets in band
//!   on every IRAP (spike 0.9 measurements 4 and 5). No AVCC, no length
//!   prefixes, no out-of-band `sprop-*` path — Chrome's H.265 receiver has no
//!   out-of-band parameter-set mechanism at all (research/06 §2.3).
//! - **One `push_au` per picture**, in encode order, with no reordering and no
//!   B-frames, so `frame_id` is monotonic and an arm may assume it.
//! - **Host QPC stamps** ([`HostStamps`]) for every picture.
//!
//! Each arm promises:
//!
//! - To answer one browser offer ([`VideoSink::accept_offer`]) and own every
//!   socket and timer behind [`VideoSink::poll`].
//! - To deliver each access unit **and its [`HostStamps`]** to the browser. How
//!   is the arm's business and is exactly what the bake-off is measuring: arm A
//!   carries the stamps in its own frame header over the data channel, arms B
//!   and C carry them on a side channel because an RTP track has nowhere to put
//!   them. The client-side receiver contract mirrors this split.
//! - To report back what the front half must react to — a keyframe request and
//!   a bandwidth estimate — as [`SinkEvent`]s rather than by calling into the
//!   encoder itself.
//! - To describe itself to the browser in [`VideoSink::client_config`], so the
//!   page picks its receiver from what the host says it is running, not from a
//!   hardcoded table that would have to be edited for every new arm.
//!
//! # What is deliberately *not* on the trait
//!
//! Nothing codec-specific and nothing NVENC-specific. An arm sees `Codec`,
//! `is_irap` and bytes. It never sees a D3D11 texture, an encoder session or a
//! duplication handle, which is what lets stage 2 add two arms without touching
//! `capture.rs`, `nvenc.rs` or `pipeline.rs`.

use std::time::{Duration, Instant};

use crate::json::J;
use crate::nal::Codec;

pub type Result<T> = std::result::Result<T, String>;

/// The three video paths of plan.md D3. The spelling here is the spelling in
/// every run's JSON, in the page's `?arm=` parameter and in the G1 memo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arm {
    /// Encoded access units over an `RTCDataChannel` → WebCodecs → canvas.
    /// **Stage 2.**
    DataChannel,
    /// RTP media track → `<video>`, playout-delay `min = 0`, `max ∈ (0, 500] ms`.
    /// The baseline every other arm must beat by ≥ 15 ms p50. **Stage 1.**
    RtpTrack,
    /// The same RTP sender as [`Arm::RtpTrack`], but a receive-side
    /// `RTCRtpScriptTransform` hands frames to WebCodecs + canvas. **Stage 2.**
    RtpScriptTransform,
}

impl Arm {
    pub fn name(self) -> &'static str {
        match self {
            Arm::DataChannel => "data-channel -> WebCodecs -> canvas",
            Arm::RtpTrack => "rtp track -> <video>",
            Arm::RtpScriptTransform => "rtp track -> RTCRtpScriptTransform -> WebCodecs -> canvas",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Arm::DataChannel => "a",
            Arm::RtpTrack => "b",
            Arm::RtpScriptTransform => "c",
        }
    }

    pub fn parse(s: &str) -> Option<Arm> {
        match s {
            "a" => Some(Arm::DataChannel),
            "b" => Some(Arm::RtpTrack),
            "c" => Some(Arm::RtpScriptTransform),
            _ => None,
        }
    }
}

/// The host clocks of one picture, all raw `QueryPerformanceCounter` ticks.
///
/// These travel to the browser unmodified and are converted there through the
/// session's single measured QPC ↔ `performance.now()` offset (spike 0.1 §2.5).
/// The host never converts them itself: a second conversion is a second place
/// for the epoch to be wrong.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostStamps {
    /// `DXGI_OUTDUPL_FRAME_INFO.LastPresentTime` — the QPC at which the
    /// desktop content of this frame was presented by the compositor. **This is
    /// the stimulus** every end-to-end figure is measured from. Frames with
    /// `LastPresentTime == 0` carry no new desktop content (spike 0.8 §8) and
    /// are never measured.
    pub desktop_present: i64,
    /// `AcquireNextFrame` returned.
    pub acquired: i64,
    /// `nvEncEncodePicture` called.
    pub encode_submit: i64,
    /// The encoder's completion event signalled and the bitstream was locked.
    pub encode_done: i64,
    /// Handed to the transport thread's queue by the capture thread.
    pub enqueued: i64,
    /// Taken off that queue by the transport thread, immediately before
    /// [`VideoSink::push_au`]. Fills the queue-wait term in, so the ≤ 1 ms
    /// poll granularity of the transport loop is a measured number and not an
    /// assumption.
    pub pushed: i64,
}

impl HostStamps {
    /// Render for the wire: compact, and ticks rather than milliseconds — see
    /// the type doc. Hand-written rather than run through [`J`] because this
    /// goes out 60 times a second and [`J::render`] pretty-prints.
    pub fn to_wire(self) -> String {
        format!(
            "\"desktopPresent\":{},\"acquired\":{},\"encodeSubmit\":{},\"encodeDone\":{},\"enqueued\":{},\"pushed\":{}",
            self.desktop_present,
            self.acquired,
            self.encode_submit,
            self.encode_done,
            self.enqueued,
            self.pushed
        )
    }
}

/// One encoded picture on its way to one browser.
pub struct EncodedAu<'a> {
    /// Annex-B, start codes included, one access unit.
    pub data: &'a [u8],
    /// Which codec the bytes are. Arm B could infer it from the negotiated
    /// payload type, but arm A has to tell WebCodecs, and a second source of
    /// truth for "what is in this buffer" is how a stream ends up configured
    /// as the wrong codec.
    pub codec: Codec,
    /// Monotonic from 0, no gaps, encode order == display order.
    pub frame_id: u64,
    /// The RTP timestamp this picture will carry, 90 kHz. The front half owns
    /// it because it is derived from the capture clock, and arms B and C need
    /// the browser to be able to match a `requestVideoFrameCallback`'s
    /// `rtpTimestamp` back to these stamps.
    pub rtp_time_90k: u64,
    pub is_irap: bool,
    pub stamps: HostStamps,
}

/// What an arm tells the front half.
#[derive(Clone, Debug, PartialEq)]
pub enum SinkEvent {
    /// ICE + DTLS are up and media will be delivered from here on.
    Connected,
    /// The peer is gone. The pipeline stops encoding for it.
    Disconnected,
    /// PLI/FIR (arm B/C) or the arm's own equivalent (arm A). The front half
    /// answers with a forced IDR; the cooldown policy is the front half's,
    /// not the arm's.
    KeyframeRequest,
    /// Bits per second the arm believes the path will carry.
    BitrateEstimate(u64),
    /// Anything the arm learned that belongs in the run's JSON — the negotiated
    /// payload type, the selected candidate pair, a codec mismatch. Free text,
    /// collected in order, never parsed.
    Note(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SinkState {
    Negotiating,
    Connected,
    Closed,
}

/// One browser peer, one video path.
///
/// An implementation is driven from exactly one thread: `accept_offer` once,
/// then `push_au` and `poll` in a loop until [`SinkState::Closed`]. It is
/// never `Sync` and never assumed to be.
pub trait VideoSink {
    /// Which of plan.md D3's three arms this is.
    fn arm(&self) -> Arm;

    /// What the page needs in order to receive this arm, as JSON. The page
    /// hands it to its receiver registry unmodified. Arm B publishes its
    /// playout-delay values and the label of its metadata channel here; arm A
    /// would publish its fragment size; arm C its transform's worker URL.
    fn client_config(&self) -> J;

    /// Answer one browser offer. Called once, before any other method.
    ///
    /// The browser always offers and the host always answers (plan.md D8), and
    /// the answer carries every local candidate — there is no trickle path in
    /// this spike, because a spike that measures steady-state frame latency
    /// does not need to shave the connect.
    fn accept_offer(&mut self, offer: &str) -> Result<String>;

    /// Hand over one access unit. Cheap and non-blocking: an arm that needs to
    /// pace bytes queues them and lets [`VideoSink::poll`] drain the queue.
    ///
    /// Dropping the unit is a legal response to a peer that is not connected
    /// yet; it must not be an error.
    fn push_au(&mut self, au: &EncodedAu<'_>) -> Result<()>;

    /// Drive the arm's own I/O and timers, for at most `budget`, appending
    /// whatever it learned to `events`.
    ///
    /// The caller gives a budget rather than letting the arm block to its own
    /// deadline, because the same thread also has to notice a new access unit.
    /// An arm returns early whenever it has nothing to wait for.
    fn poll(&mut self, now: Instant, budget: Duration, events: &mut Vec<SinkEvent>) -> Result<()>;

    fn state(&self) -> SinkState;

    /// Whatever only this arm can know, for the run's JSON. Arm B reports its
    /// metadata channel; arm A would report its fragment queue; arm C its
    /// transform's state. The front half never interprets it.
    fn diagnostics(&self) -> J;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arm_spellings_round_trip_and_match_plan_d3() {
        for (arm, s) in [
            (Arm::DataChannel, "a"),
            (Arm::RtpTrack, "b"),
            (Arm::RtpScriptTransform, "c"),
        ] {
            assert_eq!(arm.as_str(), s);
            assert_eq!(Arm::parse(s), Some(arm));
        }
        assert_eq!(Arm::parse("d"), None);
    }

    #[test]
    fn stamps_render_as_raw_ticks_not_milliseconds() {
        let stamps = HostStamps {
            desktop_present: 1_234_567_890_123,
            acquired: 1_234_567_890_456,
            ..Default::default()
        };
        let wire = stamps.to_wire();
        assert!(wire.contains("\"desktopPresent\":1234567890123"), "{wire}");
        assert!(wire.contains("\"acquired\":1234567890456"), "{wire}");
        assert!(wire.contains("\"pushed\":0"), "{wire}");
    }
}
