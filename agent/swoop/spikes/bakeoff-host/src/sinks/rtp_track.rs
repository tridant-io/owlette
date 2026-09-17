//! **Arm B** — RTP media track → `<video>`, on str0m.
//!
//! This is the baseline plan.md D3 measures the other two arms against: the
//! winner must beat it by ≥ 15 ms p50 on LAN, and ties go to the simpler path.
//! It is therefore the arm that most needs to be *right* rather than merely
//! working.
//!
//! # The three settings that decide whether it is fast
//!
//! 1. **`playout-delay` with `min = 0` and `max ∈ (0, 500] ms` — never
//!    `max = 0`.** Chrome takes the low-latency render path
//!    (`VCMTiming::UseLowLatencyRendering`, `RenderTime()` returns zero) for any
//!    `min == 0 && max ≤ 500 ms`. With `max == 0` it *also* takes a second
//!    branch in `FrameDecodeTiming::MaxWaitingTime` where the wait is always
//!    ≤ −5 ms, so whenever two temporal units are decodable at once every one
//!    but the newest is dropped by `DropNextDecodableTemporalUnit()`. On a
//!    non-scalable H.26x stream a dropped frame breaks the reference chain and
//!    Chrome PLIs. research/06 §1.1 has the source and the truth table;
//!    research/05 §5.1 recommended `max = 0` and is **superseded** by it.
//!    The extension is absent from str0m's `ExtensionMap::standard()`, so it is
//!    added explicitly below — without it the jitter buffer is free to grow to
//!    40 950 ms and the whole arm is meaningless.
//! 2. **`transport-wide-cc`**, because it is what drives str0m's GoogCC port,
//!    which is what retargets the encoder.
//! 3. **One codec in the answer.** The run picks H.264 or H.265 and the `Rtc`
//!    is built with `clear_codecs()` plus exactly that one enabled, so the
//!    negotiated payload type cannot drift between runs and the row's label is
//!    the truth.
//!
//! # The pacer, and why it is off by default here
//!
//! str0m only installs its leaky-bucket pacer when bandwidth estimation is
//! enabled; with BWE off it uses a null pacer and sends when told to
//! (`session.rs:167-171`). Both were measured on loopback at a 20 Mbps target,
//! and the BWE-on configuration could not carry the source rate:
//!
//! - **BWE on, no desired bitrate set** - pacing at ~7 Mbps, 41 ms to assemble
//!   each frame, Chrome presenting 24 of every 60 frames with **zero loss and
//!   zero PLIs**, the stream falling a second further behind every three
//!   seconds. `enable_bwe` seeds only the initial estimate; without
//!   `Bwe::set_desired_bitrate` the probe controller has nothing to aim at.
//! - **BWE on, desired bitrate set to 3x the encoder target** - 57 fps of 60,
//!   still short, so the queue grew ~60 ms per second and the end-to-end
//!   figure was ~1.2 s of pacer queue rather than anything about the video
//!   path.
//! - **BWE off (null pacer)** - the configuration every latency row here is
//!   measured in.
//!
//! This is a finding about str0m, not a workaround hiding one: a bake-off row
//! that is 95 % pacer queue measures the pacer. Congestion control is what the
//! impaired-network matrix is for, and it is measured separately.
//!
//! # What this arm does not do, on purpose
//!
//! No TURN, no FEC, no simulcast, no reference invalidation, no mDNS. Candidate
//! gathering is one host candidate on one bound address and the answer carries
//! it — no trickle. A spike that measures steady-state frame latency does not
//! need to shave the connect, and every one of those is listed in plan.md as
//! later work.

use std::collections::VecDeque;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use str0m::bwe::Bitrate;
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::format::Codec as Str0mCodec;
use str0m::media::{MediaTime, Mid, Pt};
use str0m::net::{Protocol, Receive};
use str0m::rtp::{Extension, ExtensionMap};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};

use crate::json::J;
use crate::nal::Codec;
use crate::sink::{Arm, EncodedAu, Result, SinkEvent, SinkState, VideoSink};

/// Chrome's low-latency render path needs `min = 0` and `max ≤ 500 ms`; the
/// wire granularity is 10 ms. 100 ms is the middle of the safe range and is
/// what research/06's sender checklist recommends.
pub const PLAYOUT_DELAY_MIN_MS: u64 = 0;
pub const PLAYOUT_DELAY_MAX_MS: u64 = 100;

/// Label of the data channel the browser opens for the per-frame stamps. The
/// browser opens it (it is the offerer), this arm only writes to it.
pub const META_CHANNEL_LABEL: &str = "swoop-meta";

/// How far above the encoder's target the bandwidth estimate starts.
///
/// str0m paces egress to its own estimate, and GoogCC only *raises* an estimate
/// by probing. Started at the encoder's own target, the pacer is marginal from
/// the first frame: measured on loopback with both at 20 Mbps, the client ran
/// 17 s behind within 30 s and presented 24 of every 60 frames. The bake-off is
/// measuring the video path, not congestion control, so the pacer is given
/// headroom and the fact is recorded rather than hidden.
const BWE_HEADROOM: u64 = 3;

pub struct RtpTrackSink {
    rtc: Rtc,
    socket: UdpSocket,
    local_addr: SocketAddr,
    codec: Codec,
    bwe: bool,
    mid: Option<Mid>,
    pt: Option<Pt>,
    meta_channel: Option<ChannelId>,
    /// Records waiting for the data channel to exist or for SCTP to have room.
    /// Bounded, because a browser that never opens the channel must not grow
    /// the host's memory for the length of a run.
    pending_meta: VecDeque<String>,
    meta_written: u64,
    meta_dropped: u64,
    state: SinkState,
    buf: Vec<u8>,
}

impl RtpTrackSink {
    /// Bind to `bind_addr` and prepare an `Rtc` for `codec`.
    ///
    /// `bind_addr` is an explicit address rather than `0.0.0.0` on purpose: one
    /// socket bound to one address means `Input::Receive`'s `destination` is
    /// exactly the candidate str0m advertised, with no `IP_PKTINFO` and no
    /// guessing which local interface a datagram arrived on.
    pub fn bind(
        bind_addr: SocketAddr,
        codec: Codec,
        encoder_bps: u64,
        bwe: bool,
    ) -> Result<Self> {
        let socket =
            UdpSocket::bind(bind_addr).map_err(|e| format!("bind {bind_addr} for UDP: {e}"))?;
        let local_addr = socket
            .local_addr()
            .map_err(|e| format!("local_addr: {e}"))?;

        let mut exts = ExtensionMap::standard();
        // Not in `standard()`, and the single highest-value latency lever on
        // this arm — see the module doc.
        exts.set(2, Extension::PlayoutDelay);
        exts.set(3, Extension::TransportSequenceNumber);

        let desired = Bitrate::bps(encoder_bps * BWE_HEADROOM);
        let mut rtc = RtcConfig::new()
            .clear_codecs()
            .enable_h264(codec == Codec::H264)
            .enable_h265(codec == Codec::Hevc)
            .set_extension_map(exts)
            .enable_bwe(bwe.then_some(desired))
            .build(Instant::now());
        // `enable_bwe` only seeds the *initial* estimate. Without a desired
        // bitrate the probe controller has nothing to aim at, the estimate
        // never climbs, and the pacer's rate is whatever GoogCC last settled
        // on. Measured on loopback with a 20 Mbps encoder and no desired
        // bitrate: the pacer ran at ~7 Mbps, every frame took 41 ms to
        // assemble, Chrome presented 24 of every 60 frames with zero loss and
        // zero PLIs, and the stream fell a second further behind every three
        // seconds.
        if bwe {
            rtc.bwe().set_desired_bitrate(desired);
        }

        Ok(Self {
            rtc,
            socket,
            local_addr,
            codec,
            bwe,
            mid: None,
            pt: None,
            meta_channel: None,
            pending_meta: VecDeque::new(),
            meta_written: 0,
            meta_dropped: 0,
            state: SinkState::Negotiating,
            buf: vec![0u8; 2048],
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Resolve the payload type for the run's codec on the negotiated m-line.
    ///
    /// Matching is on the codec alone. `PayloadParams::resend()` is *not* an
    /// "is this an RTX parameter" test despite how it reads — str0m stores the
    /// repairing RTX payload type there, so `resend().is_some()` is true for
    /// every real video codec that has RTX, and filtering on it finds nothing.
    /// An RTX entry identifies itself by `spec().codec == Codec::Rtx`.
    fn resolve_pt(&mut self, mid: Mid) -> (Option<Pt>, String) {
        let want = match self.codec {
            Codec::H264 => Str0mCodec::H264,
            Codec::Hevc => Str0mCodec::H265,
        };
        let Some(writer) = self.rtc.writer(mid) else {
            return (None, "no writer".into());
        };
        let offered: Vec<String> = writer
            .payload_params()
            .map(|p| format!("{}:{:?}", p.pt(), p.spec().codec))
            .collect();
        let pt = writer
            .payload_params()
            .find(|p| p.spec().codec == want)
            .map(|p| p.pt());
        // Bound to locals before the block ends: `payload_params()` borrows
        // `writer`, and the iterator's drop would otherwise outlive it.
        (pt, offered.join(" "))
    }

    fn drain_meta(&mut self) {
        let Some(id) = self.meta_channel else { return };
        while let Some(record) = self.pending_meta.front() {
            let Some(mut channel) = self.rtc.channel(id) else {
                return;
            };
            match channel.write(false, record.as_bytes()) {
                // `false` means SCTP has no room right now; try again next poll.
                Ok(false) | Err(_) => return,
                Ok(true) => {
                    self.pending_meta.pop_front();
                    self.meta_written += 1;
                }
            }
        }
    }

    fn handle_event(&mut self, event: Event, out: &mut Vec<SinkEvent>) {
        match event {
            Event::Connected => {
                self.state = SinkState::Connected;
                out.push(SinkEvent::Connected);
            }
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                self.state = SinkState::Closed;
                out.push(SinkEvent::Disconnected);
            }
            Event::Closed => {
                self.state = SinkState::Closed;
                out.push(SinkEvent::Disconnected);
            }
            Event::MediaAdded(m) => {
                self.mid = Some(m.mid);
                let (pt, offered) = self.resolve_pt(m.mid);
                self.pt = pt;
                out.push(SinkEvent::Note(match pt {
                    Some(pt) => {
                        format!("media {} negotiated, pt {pt} (available: {offered})", m.mid)
                    }
                    None => format!(
                        "media {} negotiated but no payload type matched {:?} (available: {offered})",
                        m.mid, self.codec
                    ),
                }));
            }
            Event::ChannelOpen(id, label) => {
                if label == META_CHANNEL_LABEL {
                    self.meta_channel = Some(id);
                }
                out.push(SinkEvent::Note(format!("data channel open: {label}")));
            }
            Event::ChannelClose(id) => {
                if self.meta_channel == Some(id) {
                    self.meta_channel = None;
                }
            }
            Event::KeyframeRequest(_) => out.push(SinkEvent::KeyframeRequest),
            Event::EgressBitrateEstimate(kind) => {
                let bitrate = match kind {
                    str0m::bwe::BweKind::Twcc(b) => b,
                    str0m::bwe::BweKind::Remb(_, b) => b,
                    // BweKind is #[non_exhaustive]: a future estimator variant
                    // is not a reason to stop retargeting the encoder.
                    _ => return,
                };
                out.push(SinkEvent::BitrateEstimate(bitrate.as_u64()));
            }
            _ => {}
        }
    }
}

impl VideoSink for RtpTrackSink {
    fn arm(&self) -> Arm {
        Arm::RtpTrack
    }

    fn client_config(&self) -> J {
        J::Obj(vec![
            ("arm", J::s(Arm::RtpTrack.as_str())),
            // What the page's receiver registry keys off: this arm presents a
            // `<video>` element fed by an ordinary RTP track.
            ("present", J::s("video")),
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
        let offer = SdpOffer::from_sdp_string(offer).map_err(|e| format!("parse offer: {e}"))?;
        let candidate = Candidate::host(self.local_addr, "udp")
            .map_err(|e| format!("host candidate for {}: {e}", self.local_addr))?;
        if self.rtc.add_local_candidate(candidate).is_none() {
            return Err(format!(
                "str0m rejected the host candidate for {}",
                self.local_addr
            ));
        }
        let answer = self
            .rtc
            .sdp_api()
            .accept_offer(offer)
            .map_err(|e| format!("accept_offer: {e}"))?;
        Ok(answer.to_sdp_string())
    }

    fn push_au(&mut self, au: &EncodedAu<'_>) -> Result<()> {
        if self.state != SinkState::Connected {
            return Ok(());
        }
        let (Some(mid), Some(pt)) = (self.mid, self.pt) else {
            return Ok(());
        };
        let writer = self
            .rtc
            .writer(mid)
            .ok_or_else(|| format!("no writer for mid {mid}"))?;
        writer
            .playout_delay(
                MediaTime::from_hundredths(PLAYOUT_DELAY_MIN_MS / 10),
                MediaTime::from_hundredths(PLAYOUT_DELAY_MAX_MS / 10),
            )
            .write(
                pt,
                Instant::now(),
                MediaTime::from_90khz(au.rtp_time_90k),
                au.data,
            )
            .map_err(|e| format!("write frame {}: {e}", au.frame_id))?;

        // The stamps the browser reconciles against. An RTP track has nowhere
        // to carry them, which is exactly why the seam makes delivering them
        // the arm's problem: arm A will put this record in its own frame header
        // instead. Matched on the client by `rtpTimestamp`, which is the wire
        // value — the low 32 bits of the 90 kHz media time.
        let record = format!(
            "{{\"frameId\":{},\"rtp\":{},\"irap\":{},\"bytes\":{},\"codec\":\"{}\",{}}}",
            au.frame_id,
            au.rtp_time_90k as u32,
            au.is_irap,
            au.data.len(),
            match au.codec {
                Codec::H264 => "h264",
                Codec::Hevc => "hevc",
            },
            au.stamps.to_wire()
        );
        // Bounded: a browser that never opens the channel must not grow the
        // host's memory for the length of a run. Two seconds at 60 fps.
        if self.pending_meta.len() >= 120 {
            self.pending_meta.pop_front();
            self.meta_dropped += 1;
        }
        self.pending_meta.push_back(record);
        Ok(())
    }

    fn poll(&mut self, now: Instant, budget: Duration, events: &mut Vec<SinkEvent>) -> Result<()> {
        self.drain_meta();

        let deadline = loop {
            match self.rtc.poll_output().map_err(|e| format!("poll_output: {e}"))? {
                Output::Timeout(t) => break t,
                Output::Transmit(t) => {
                    self.socket
                        .send_to(&t.contents, t.destination)
                        .map_err(|e| format!("send_to {}: {e}", t.destination))?;
                }
                Output::Event(e) => self.handle_event(e, events),
            }
        };

        if self.state == SinkState::Closed {
            return Ok(());
        }

        // The caller's budget, never the arm's own deadline: the same thread
        // has to notice the next access unit, and a socket read that blocked
        // until str0m's next timer would add that wait to every frame.
        let wait = deadline
            .saturating_duration_since(now)
            .min(budget)
            .max(Duration::from_micros(200));
        self.socket
            .set_read_timeout(Some(wait))
            .map_err(|e| format!("set_read_timeout: {e}"))?;
        match self.socket.recv_from(&mut self.buf) {
            Ok((n, source)) => {
                let contents = (&self.buf[..n])
                    .try_into()
                    .map_err(|e| format!("datagram from {source}: {e}"))?;
                self.rtc
                    .handle_input(Input::Receive(
                        Instant::now(),
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: self.local_addr,
                            contents,
                        },
                    ))
                    .map_err(|e| format!("handle_input: {e}"))?;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                self.rtc
                    .handle_input(Input::Timeout(Instant::now()))
                    .map_err(|e| format!("handle_input timeout: {e}"))?;
            }
            // A Windows UDP socket reports ICMP port-unreachable from a
            // previous send as an error on the *next* receive. It is not fatal
            // and it happens routinely while ICE is still probing.
            Err(_) => {
                self.rtc
                    .handle_input(Input::Timeout(Instant::now()))
                    .map_err(|e| format!("handle_input timeout: {e}"))?;
            }
        }
        Ok(())
    }

    fn state(&self) -> SinkState {
        self.state
    }

    fn diagnostics(&self) -> J {
        J::Obj(vec![
            ("metaWritten", J::Uint(self.meta_written)),
            ("metaDroppedQueueFull", J::Uint(self.meta_dropped)),
            ("metaPending", J::Uint(self.pending_meta.len() as u64)),
            ("metaChannelOpen", J::Bool(self.meta_channel.is_some())),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playout_delay_is_never_max_zero() {
        // research/06 §1.1: max = 0 takes the fast-forward branch and drops
        // every decodable temporal unit but the newest, which breaks a
        // non-scalable H.26x reference chain and triggers a PLI storm.
        assert_eq!(PLAYOUT_DELAY_MIN_MS, 0);
        assert!(PLAYOUT_DELAY_MAX_MS > 0);
        assert!(PLAYOUT_DELAY_MAX_MS <= 500);
    }

    #[test]
    fn playout_delay_lands_on_the_ten_millisecond_wire_granularity() {
        // The extension carries two 12-bit fields of 10 ms units, so a value
        // that is not a multiple of 10 is silently truncated on the wire.
        assert_eq!(PLAYOUT_DELAY_MIN_MS % 10, 0);
        assert_eq!(PLAYOUT_DELAY_MAX_MS % 10, 0);
        assert_eq!(
            MediaTime::from_hundredths(PLAYOUT_DELAY_MAX_MS / 10).as_seconds(),
            0.1
        );
    }

    #[test]
    fn the_extension_map_carries_playout_delay_which_standard_does_not() {
        let standard = ExtensionMap::standard();
        assert!(
            standard.id_of(Extension::PlayoutDelay).is_none(),
            "str0m's standard map gained playout-delay; the explicit set() in bind() may now be redundant"
        );
        let mut exts = ExtensionMap::standard();
        exts.set(2, Extension::PlayoutDelay);
        assert_eq!(exts.id_of(Extension::PlayoutDelay), Some(2));
    }

    /// Binds a loopback UDP socket.
    #[test]
    #[ignore]
    fn binds_and_reports_a_concrete_local_address() {
        let sink =
            RtpTrackSink::bind("127.0.0.1:0".parse().unwrap(), Codec::H264, 20_000_000, false)
                .expect("bind");
        assert!(sink.local_addr().port() > 0);
        assert_eq!(sink.state(), SinkState::Negotiating);
        assert_eq!(sink.arm(), Arm::RtpTrack);
        let cfg = sink.client_config().render();
        assert!(cfg.contains("\"arm\": \"b\""), "{cfg}");
        assert!(cfg.contains("\"max\": 100"), "{cfg}");
    }
}
