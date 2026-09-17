//! **Arm C** — arm B's sender, with a receive-side `RTCRtpScriptTransform`.
//!
//! Stage 1 predicted that arm C's host side would *be* arm B's, overriding only
//! [`VideoSink::arm`] and [`VideoSink::client_config`], "because the difference
//! between B and C lives entirely in the browser". This file is that prediction
//! written out: an [`RtpTrackSink`] behind a newtype, every other trait method
//! forwarded verbatim. Nothing in `capture.rs`, `nvenc.rs` or `pipeline.rs`
//! changes for it, and neither does arm B's own module.
//!
//! The one thing arm C adds to the wire is a name: the page has to know which
//! worker to load, and it learns it from [`VideoSink::client_config`] like every
//! other client-side fact, rather than from a table in the page that would have
//! to be edited for every new arm.
//!
//! # What arm C is for
//!
//! `research/02-browser-client.md` §4.6 calls the receive-side transform "the
//! single highest-value one-day spike in the whole browser workstream" and says
//! plainly that it could not be established whether the transform runs **before
//! or after** libwebrtc's frame buffer. `research/01-parsec-and-peers.md` §1(e)
//! asserts it runs after depacketization but still through `VCMTiming`. Those
//! two cannot both be actionable, and the difference is the whole value of the
//! arm: if the transform is ahead of the frame buffer, arm C gets RTP's
//! NACK/RTX, TWCC and pacing *without* the jitter buffer; if it is behind,
//! arm C is arm B plus a decode hop and should lose.
//!
//! This spike measures it rather than citing it. Same sender, same
//! `playout-delay`, same stamps on the same side channel: the only difference
//! from arm B is where the browser takes the frames from.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use crate::json::J;
use crate::nal::Codec;
use crate::sink::{Arm, EncodedAu, Result, SinkEvent, SinkState, VideoSink};
use crate::sinks::rtp_track::{
    RtpTrackSink, META_CHANNEL_LABEL, PLAYOUT_DELAY_MAX_MS, PLAYOUT_DELAY_MIN_MS,
};

/// Published to the page so it loads the transform's worker from the host's own
/// description of the arm. Served by `bakeoff-web/server.mjs`, not from here.
pub const TRANSFORM_WORKER_URL: &str = "/receivers/transform-worker.js";

pub struct ScriptTransformSink {
    inner: RtpTrackSink,
    // Held rather than read back out of `inner`: arm B's fields are private and
    // arm C is not a reason to widen them. Both are copies of what `bind` was
    // given, so they cannot drift from what `inner` was built with.
    codec: Codec,
    bwe: bool,
}

impl ScriptTransformSink {
    pub fn bind(
        bind_addr: SocketAddr,
        codec: Codec,
        encoder_bps: u64,
        bwe: bool,
    ) -> Result<Self> {
        Ok(Self {
            inner: RtpTrackSink::bind(bind_addr, codec, encoder_bps, bwe)?,
            codec,
            bwe,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.inner.local_addr()
    }
}

impl VideoSink for ScriptTransformSink {
    fn arm(&self) -> Arm {
        Arm::RtpScriptTransform
    }

    fn client_config(&self) -> J {
        J::Obj(vec![
            ("arm", J::s(Arm::RtpScriptTransform.as_str())),
            // Unlike arm B, arm C owns the surface it presents into and can
            // therefore read its pixels back per frame.
            ("present", J::s("canvas")),
            ("transformWorker", J::s(TRANSFORM_WORKER_URL)),
            ("metaChannel", J::s(META_CHANNEL_LABEL)),
            (
                "playoutDelayMs",
                J::Obj(vec![
                    ("min", J::Uint(PLAYOUT_DELAY_MIN_MS)),
                    ("max", J::Uint(PLAYOUT_DELAY_MAX_MS)),
                ]),
            ),
            (
                "codec",
                J::s(match self.codec {
                    Codec::H264 => "h264",
                    Codec::Hevc => "hevc",
                }),
            ),
            ("bwe", J::Bool(self.bwe)),
        ])
    }

    fn accept_offer(&mut self, offer: &str) -> Result<String> {
        self.inner.accept_offer(offer)
    }

    fn push_au(&mut self, au: &EncodedAu<'_>) -> Result<()> {
        self.inner.push_au(au)
    }

    fn poll(&mut self, now: Instant, budget: Duration, events: &mut Vec<SinkEvent>) -> Result<()> {
        self.inner.poll(now, budget, events)
    }

    fn state(&self) -> SinkState {
        self.inner.state()
    }

    fn diagnostics(&self) -> J {
        self.inner.diagnostics()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Binds a loopback UDP socket.
    #[test]
    #[ignore]
    fn it_is_arm_b_with_two_methods_overridden() {
        let addr = "127.0.0.1:0".parse().unwrap();
        let b = RtpTrackSink::bind(addr, Codec::H264, 20_000_000, false).expect("arm b");
        let c = ScriptTransformSink::bind(addr, Codec::H264, 20_000_000, false).expect("arm c");

        assert_eq!(c.arm(), Arm::RtpScriptTransform);
        assert_eq!(b.arm(), Arm::RtpTrack);
        // Same state machine, same diagnostics, same sender. Only the two
        // methods stage 1 predicted differ.
        assert_eq!(c.state(), b.state());
        assert_eq!(c.diagnostics().render(), b.diagnostics().render());

        let config = c.client_config().render();
        assert!(config.contains("\"arm\": \"c\""), "{config}");
        assert!(config.contains("\"present\": \"canvas\""), "{config}");
        assert!(config.contains(TRANSFORM_WORKER_URL), "{config}");
        // The sender's own settings are arm B's, unchanged.
        assert!(config.contains("\"max\": 100"), "{config}");
        assert!(config.contains(META_CHANNEL_LABEL), "{config}");
    }
}
