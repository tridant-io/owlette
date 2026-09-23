//! The str0m peer connection: one per viewer, the browser offers and the host
//! answers (plan.md D8). Arm B of gate G1 — an RTP media track rendered into a
//! `<video>` element — lifted from the bake-off host's measured arm B
//! (`spikes/bakeoff-host/src/sinks/rtp_track.rs`) and reshaped around the
//! product's [`VideoSink`] seam, five data channels and [`SendPacer`].
//!
//! # The three settings that decide whether arm B is fast
//!
//! 1. **`playout-delay` with `min = 0` and `max ∈ (0, 500] ms` — never
//!    `max = 0`.** Chrome takes the low-latency render path for any
//!    `min == 0 && max ≤ 500`. With `max == 0` it *also* takes the
//!    `FrameDecodeTiming::MaxWaitingTime` branch where the wait is always
//!    ≤ −5 ms, so whenever two temporal units are decodable at once every one
//!    but the newest is dropped — which on a non-scalable H.26x stream breaks
//!    the reference chain and Chrome PLIs. The extension is absent from
//!    str0m's `ExtensionMap::standard()`, so it is set explicitly below;
//!    without it the jitter buffer is free to grow to 40,950 ms.
//! 2. **`transport-wide-cc`**, which is what carries per-packet feedback.
//! 3. **One codec in the answer**, so the negotiated payload type cannot drift
//!    from what the encoder is producing.
//!
//! # Audio is a second RTP track, and it is deliberately not on the video one
//!
//! Behind the `audio-opus` feature the peer also negotiates Opus and carries
//! [`crate::audio`]'s frames on the `audio` m-line §3 describes. Two things
//! about it are load-bearing:
//!
//! - **Its own `MediaStream`.** str0m gives media built from a remote offer
//!   `Msid::random()` when the offerer named none, and a browser's `recvonly`
//!   transceivers name none — so the two tracks arrive under different stream
//!   ids and the browser cannot A/V-sync them. Sharing the video stream would
//!   hold the picture back to the audio clock, which is the whole of arm B's
//!   measured latency.
//! - **It does not go through [`SendPacer`].** The pacer is the video budget:
//!   it exists to drop a delta frame rather than queue it. Opus at 128 kbps is
//!   0.6% of a 20 Mbps video target and a dropped packet is an audible gap, so
//!   audio is written straight to str0m.
//!
//! # BWE is off, and that is a disclosure rather than a default
//!
//! [`PeerConfig::enable_bwe`] defaults to false because str0m installs its
//! leaky-bucket pacer only when BWE is on, and spike 0.2 §7 measured that
//! pacer holding 1015.6 ms p50 of queue with zero loss, zero PLI, zero NACK
//! and zero freezes — it presents as latency and no loss-based check catches
//! it. Off, str0m uses a null pacer and sends when told to. The cost of off is
//! that there is **no bandwidth estimate at all**: [`PeerEvent::BitrateEstimate`]
//! never fires, and the only congestion signals the product has are
//! [`SendPacer`]'s ledger and the viewer's own `swoop-feedback`. See
//! [`crate::transport::pacer`], and Task 4.7 for where a real control loop has
//! to land.
//!
//! # What is not here yet, on purpose
//!
//! One socket bound to one explicit address, so `Receive::destination` is
//! exactly the candidate str0m advertised and no `IP_PKTINFO` is needed.
//! That means one host candidate: multi-interface gathering, server-reflexive
//! candidates and the relay path are Task 7.4/7.5's, through
//! [`add_local_candidate`](RtcPeer::add_local_candidate), which trickles
//! whatever it is given.
//!
//! # Loopback check (manual, `#[ignore]`d)
//!
//! ```text
//! cd agent/swoop
//! cargo test --lib transport::rtc::tests::loopback -- --ignored --nocapture
//! ```
//!
//! Two peers on 127.0.0.1, ICE + DTLS + SCTP, 60 s of 60 fps synthetic access
//! units at the configured bitrate plus one `swoop-meta` record per frame.
//! Expected: the two peers connect, `channel_write_refusals == 0` and
//! `dropped_over_budget == 0` for the whole run, and every record accounted
//! for in `channel_writes`. A non-zero refusal count at the configured
//! bitrate means the 128 KiB `MAX_BUFFERED_ACROSS_STREAMS` ceiling is being
//! reached by the metadata channel alone, which is a protocol-side problem
//! rather than a tuning one.
//!
//! # Answering a real browser (manual, `#[ignore]`d)
//!
//! ```text
//! cd agent/swoop
//! SWOOP_OFFER_SDP=offer.sdp SWOOP_ANSWER_SDP=answer.sdp \
//!   cargo test --lib transport::rtc::tests::answers_an_offer_from_a_file -- --ignored
//! ```
//!
//! Answers one offer captured from a browser, writes the SDP back out for the
//! same browser to apply, and then runs ICE, DTLS and SCTP against it until the
//! five channels of §3 are open. It is the only check that puts our answer in
//! front of a real SDP parser, and it is what [`restore_rejected_formats`] was
//! written against: str0m's own parser accepts an m-line Chrome throws the
//! whole description away for. Vanilla ICE, so the offer has to carry its
//! candidates inline and Chrome's mDNS obfuscation has to be off
//! (`--disable-features=WebRtcHideLocalIpsWithMdns`).

use std::collections::VecDeque;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::format::Codec as Str0mCodec;
use str0m::media::{MediaAdded, MediaKind, MediaTime, Mid, Pt};
use str0m::net::{Protocol, Receive};
use str0m::rtp::{Extension, ExtensionMap};
use str0m::{Candidate, CandidateKind, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};

use crate::encode::{Codec, EncodedFrame};
use crate::signal::messages::channel::Channel;
use crate::transport::ice_policy::{self, IceEvent};
use crate::transport::pacer::{Admission, PacerStats, SendPacer};
use crate::transport::VideoSink;

/// Chrome's low-latency render path needs `min = 0` and `max ≤ 500 ms`; the
/// wire granularity is 10 ms. 100 ms is the middle of the safe range.
pub const PLAYOUT_DELAY_MIN_MS: u64 = 0;
pub const PLAYOUT_DELAY_MAX_MS: u64 = 100;

/// Header-extension ids, exactly as the bake-off negotiated them against
/// Chrome 153. Id 2 displaces `AbsoluteSendTime` from
/// `ExtensionMap::standard()`: abs-send-time feeds the REMB estimator, which
/// this configuration does not run, and playout-delay is the single largest
/// latency lever on this arm.
const EXT_ID_PLAYOUT_DELAY: u8 = 2;
const EXT_ID_TWCC: u8 = 3;

/// The Opus payload type, which is also str0m's own default for it — so a
/// hand-built payload params entry and anything that falls back to the library
/// default name the same number.
#[cfg(feature = "audio-opus")]
const OPUS_PT: u8 = 111;

/// str0m caps SCTP buffering at 128 KiB across *every* channel on the
/// association (`sctp/mod.rs:30`), and spike 0.2 §13.4 measured that cap doing
/// useful work as an accidental latency bound — raising it to 2 MB dropped
/// carried throughput to 42.3 Mbps. Our queue sits in front of it and gets
/// half: enough to ride out a refusal, small enough that it cannot become the
/// standing queue the pacer exists to prevent.
const OUT_QUEUE_HIGH_WATERMARK: usize = 64 * 1024;

/// One datagram. str0m's target MTU is well under this.
const RECV_BUF_BYTES: usize = 2048;

/// How far above the encoder's target a bandwidth estimate would start, if one
/// were enabled. Only ever used with [`PeerConfig::enable_bwe`].
const BWE_HEADROOM: u64 = 3;

/// The poll loop never sleeps past this even when str0m has nothing to do, so
/// a caller that passes a generous budget still comes back to look for frames.
const MIN_POLL_WAIT: Duration = Duration::from_micros(200);

/// How many of the viewer's relay candidates are remembered, for the one
/// question [`crate::transport::ice_policy`] asks about the selected pair. A
/// browser trickles a handful; the cap is because the list is the viewer's own
/// input and it is held for the life of the peer.
const MAX_TRACKED_RELAYS: usize = 32;

// --------------------------------------------------------------- config ---

/// Everything one viewer's peer needs to exist.
#[derive(Debug, Clone, Copy)]
pub struct PeerConfig {
    /// An explicit address, never `0.0.0.0` — see the module doc.
    pub bind_addr: SocketAddr,
    /// The codec chosen for this viewer (browser capability ∩ host encoders).
    /// Exactly one is enabled in the answer so the negotiated payload type
    /// cannot drift from what the encoder produces.
    pub codec: Codec,
    pub fps: u32,
    /// The pacer's starting ceiling — the encoder's own CBR target until a
    /// governor moves it.
    pub bitrate_bps: u32,
    /// `QueryPerformanceFrequency`. The caller owns the capture clock, so it
    /// supplies the tick rate rather than this module guessing at one; see
    /// [`qpc_hz`] on Windows.
    pub qpc_hz: i64,
    /// Leave false. Turning it on installs str0m's leaky-bucket pacer, which
    /// the bake-off measured at 1015.6 ms p50 of queue. It exists so the
    /// step-response experiments spike 0.2 §7 did not run can be run without
    /// editing this file.
    pub enable_bwe: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerState {
    Negotiating,
    Connected,
    Closed,
}

/// What the peer tells the session. Everything periodic is a counter in
/// [`PeerStats`] instead; these are edges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerEvent {
    /// ICE and DTLS are up; media flows from here.
    Connected,
    Disconnected,
    /// A local candidate to trickle to the viewer through the signaling
    /// client, as an SDP `candidate:` attribute value.
    LocalCandidate(String),
    /// An edge for [`crate::transport::ice_policy::IcePolicy::observe`]. The
    /// policy is the session's, not the peer's — it outlives a renegotiation
    /// and it is the thread with the clock — so the peer only reports.
    Ice(IceEvent),
    /// PLI or FIR. The session coalesces keyframes across viewers and asks the
    /// encoder once (plan.md D14) — this is never forwarded straight through.
    KeyframeRequest,
    /// str0m's GoogCC estimate. Only ever fires with
    /// [`PeerConfig::enable_bwe`] on, which it is not by default.
    BitrateEstimate(u64),
    ChannelOpen(Channel),
    ChannelClose(Channel),
    ChannelData {
        channel: Channel,
        binary: bool,
        data: Vec<u8>,
    },
    /// A channel whose label is not one of PROTOCOL §3's five. Never wired up,
    /// never written to, and the label is reported so the refusal is visible.
    ChannelRefused(String),
    /// The pacer refused a delta frame. With BWE off this and the viewer's own
    /// feedback are the *only* congestion signals the product has, so it is an
    /// event and not just a counter.
    FrameDropped {
        frame_id: u64,
        bytes: usize,
    },
    /// `Channel::write` returned `Ok(false)` — SCTP had no room inside the
    /// 128 KiB shared ceiling. The record stays queued and is retried.
    ChannelWriteRefused {
        channel: Channel,
        queued_bytes: usize,
    },
    /// The out-queue hit its watermark and the oldest record was dropped to
    /// make room. Never silent.
    ChannelQueueOverflow {
        channel: Channel,
    },
}

/// Put one datagram on the socket. A refusal is counted, logged sparingly and
/// survived: before nomination str0m tries every candidate pair, and a
/// destination this host has no route to (a viewer's vpn address, an address
/// family the socket does not carry) is one pair failing its check, which ICE
/// handles by never nominating it. Ending the peer for it — what `?` did here
/// until 2026-09-23 — took a live session down for a candidate that was never
/// going to carry it.
fn send_datagram(
    socket: &UdpSocket,
    stats: &mut PeerStats,
    contents: &[u8],
    destination: SocketAddr,
) -> bool {
    match socket.send_to(contents, destination) {
        Ok(_) => {
            stats.datagrams_sent += 1;
            true
        }
        Err(error) => {
            stats.datagrams_send_failed += 1;
            // the first few and then one in a hundred: enough to see a pair
            // that never worked, not a log line per retry
            if stats.datagrams_send_failed <= 3 || stats.datagrams_send_failed.is_multiple_of(100) {
                ::log::debug!(
                    "swoop: send_to {destination} refused ({error}); {} refused so far",
                    stats.datagrams_send_failed
                );
            }
            false
        }
    }
}

/// One peer's counters, which is what a governor reads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PeerStats {
    pub pacer: PacerStats,
    /// Datagrams this peer put on the socket.
    pub datagrams_sent: u64,
    /// Datagrams the socket refused: one unreachable candidate (a vpn address
    /// answering WSAENETUNREACH) is a fact about that pair, not the peer, and
    /// ICE drops the pair itself when nothing answers on it.
    pub datagrams_send_failed: u64,
    /// Access units handed to str0m's packetizer.
    pub frames_written: u64,
    pub channel_writes: u64,
    /// `Ok(false)` from `Channel::write`, cumulative.
    pub channel_write_refusals: u64,
    pub channel_queue_overflows: u64,
    pub channels_refused: u64,
    /// One for the initial offer, one more per accepted ICE restart.
    pub negotiations: u64,
    pub keyframe_requests: u64,
    /// Opus frames written to the audio track. Stays 0 without the
    /// `audio-opus` feature, and 0 with it on a machine that has no render
    /// endpoint — the two are told apart by `status`, not by this.
    pub audio_packets_written: u64,
}

// ------------------------------------------------------------ out queue ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WriteOutcome {
    Accepted,
    /// `Ok(false)`: no room inside the 128 KiB shared ceiling right now.
    NoRoom,
    /// The channel is not open (yet, or any more).
    NotOpen,
}

#[derive(Debug)]
struct Outbound {
    channel: Channel,
    binary: bool,
    data: Vec<u8>,
}

/// One FIFO for all five channels, because the buffering ceiling it feeds is
/// shared across all five: separate queues would only let one channel's
/// backlog hide another's. A single FIFO also preserves per-channel order for
/// free.
#[derive(Debug, Default)]
struct OutQueue {
    queued: VecDeque<Outbound>,
    bytes: usize,
    writes: u64,
    refusals: u64,
    overflows: u64,
}

impl OutQueue {
    fn push(&mut self, channel: Channel, binary: bool, data: Vec<u8>, events: &mut Vec<PeerEvent>) {
        while self.bytes + data.len() > OUT_QUEUE_HIGH_WATERMARK {
            let Some(dropped) = self.queued.pop_front() else {
                break;
            };
            self.bytes -= dropped.data.len();
            self.overflows += 1;
            events.push(PeerEvent::ChannelQueueOverflow {
                channel: dropped.channel,
            });
        }
        self.bytes += data.len();
        self.queued.push_back(Outbound {
            channel,
            binary,
            data,
        });
    }

    /// Write as much as the transport will take, stopping at the first refusal
    /// so ordering holds. `write` is the seam the unit tests substitute a fake
    /// channel through.
    fn drain(
        &mut self,
        events: &mut Vec<PeerEvent>,
        mut write: impl FnMut(Channel, bool, &[u8]) -> WriteOutcome,
    ) {
        while let Some(item) = self.queued.pop_front() {
            match write(item.channel, item.binary, &item.data) {
                WriteOutcome::Accepted => {
                    self.bytes -= item.data.len();
                    self.writes += 1;
                }
                WriteOutcome::NoRoom => {
                    self.refusals += 1;
                    events.push(PeerEvent::ChannelWriteRefused {
                        channel: item.channel,
                        queued_bytes: self.bytes,
                    });
                    self.queued.push_front(item);
                    return;
                }
                WriteOutcome::NotOpen => {
                    // Not an error and not a refusal: the browser opens the
                    // channels, so a record can be ready before its channel is.
                    self.queued.push_front(item);
                    return;
                }
            }
        }
    }
}

// ---------------------------------------------------------------- audio ---

/// The audio track's half of one peer: what the `audio` m-line negotiated, and
/// where its frames come from.
///
/// One struct rather than three fields so the feature gate is a single `#[cfg]`
/// on [`RtcPeer`] instead of one per field.
#[cfg(feature = "audio-opus")]
#[derive(Debug, Default)]
struct AudioLeg {
    mid: Option<Mid>,
    pt: Option<Pt>,
    track: Option<crate::audio::AudioTrack>,
}

// ----------------------------------------------------------------- peer ---

/// One viewer's peer connection.
///
/// Driven from exactly one thread: [`accept_offer`](Self::accept_offer), then
/// [`VideoSink::send`] and [`poll`](Self::poll) in a loop until
/// [`PeerState::Closed`].
pub struct RtcPeer {
    rtc: Rtc,
    socket: UdpSocket,
    local_addr: SocketAddr,
    codec: Codec,
    qpc_hz: i64,
    state: PeerState,
    mid: Option<Mid>,
    pt: Option<Pt>,
    #[cfg(feature = "audio-opus")]
    audio: AudioLeg,
    buf: Vec<u8>,
    pacer: SendPacer,
    out: OutQueue,
    channels: Vec<(ChannelId, Channel)>,
    /// The addresses of the viewer's `typ relay` candidates, which is all the
    /// pair classification below needs — the host's own candidates are host
    /// candidates until Task 7.4 allocates a relay.
    remote_relays: Vec<SocketAddr>,
    /// Where str0m last asked for a packet to go. See [`RtcPeer::on_send_addr`].
    sending_to: Option<SocketAddr>,
    /// Emitted on the next poll: candidates are gathered while answering, and
    /// the caller's event vector only exists inside `poll`.
    pending_events: VecDeque<PeerEvent>,
    keyframe_requested: bool,
    irap_sent: bool,
    /// The first frame's capture tick, so RTP time starts near zero.
    rtp_base_qpc: Option<i64>,
    last_rtp_90k: Option<u32>,
    stats: PeerStats,
}

impl RtcPeer {
    /// Bind this peer's socket and build its `Rtc`. No I/O with the viewer
    /// happens until [`accept_offer`](Self::accept_offer).
    pub fn bind(cfg: PeerConfig) -> Result<Self> {
        let socket = UdpSocket::bind(cfg.bind_addr)
            .with_context(|| format!("bind {} for udp", cfg.bind_addr))?;
        socket
            .set_nonblocking(false)
            .context("the poll loop reads with a timeout, not non-blocking")?;
        let local_addr = socket.local_addr().context("local_addr")?;

        let mut exts = ExtensionMap::standard();
        exts.set(EXT_ID_PLAYOUT_DELAY, Extension::PlayoutDelay);
        exts.set(EXT_ID_TWCC, Extension::TransportSequenceNumber);

        let mut builder = RtcConfig::new()
            .clear_codecs()
            .enable_h264(cfg.codec == Codec::H264)
            .enable_h265(cfg.codec == Codec::H265)
            .set_extension_map(exts);
        // str0m's own `enable_opus` sets `minptime` and `useinbandfec` but
        // leaves stereo and DTX to the defaults — mono, and DTX the receiver's
        // choice. §3's fmtp names all four, so the payload type is configured
        // outright rather than enabled and then hoped about.
        #[cfg(feature = "audio-opus")]
        builder.codec_config().add_config(
            OPUS_PT.into(),
            None,
            Str0mCodec::Opus,
            str0m::media::Frequency::FORTY_EIGHT_KHZ,
            Some(crate::audio::opus::CHANNELS as u8),
            str0m::format::FormatParams {
                min_p_time: Some(crate::audio::opus::FRAME_MS as u8),
                stereo: Some(true),
                sprop_stereo: Some(true),
                use_inband_fec: Some(true),
                // Off: a desktop's silence is information, and a receiver whose
                // clock stops during it drifts. `audio::opus::Timeline` sends
                // comfort silence instead.
                use_dtx: Some(false),
                ..Default::default()
            },
        );
        // `enable_bwe` seeds only the *initial* estimate; without a desired
        // bitrate the probe controller has nothing to aim at and the estimate
        // never climbs. 3× the encoder target is the headroom the bake-off
        // measured — and what it measured was unusable.
        let desired = str0m::bwe::Bitrate::bps(u64::from(cfg.bitrate_bps) * BWE_HEADROOM);
        if cfg.enable_bwe {
            builder = builder.enable_bwe(Some(desired));
        }
        let mut rtc = builder.build(Instant::now());
        if cfg.enable_bwe {
            rtc.bwe().set_desired_bitrate(desired);
        }

        Ok(Self {
            rtc,
            socket,
            local_addr,
            codec: cfg.codec,
            qpc_hz: cfg.qpc_hz.max(1),
            state: PeerState::Negotiating,
            mid: None,
            pt: None,
            #[cfg(feature = "audio-opus")]
            audio: AudioLeg::default(),
            buf: vec![0u8; RECV_BUF_BYTES],
            pacer: SendPacer::new(Instant::now(), u64::from(cfg.bitrate_bps), cfg.fps),
            out: OutQueue::default(),
            channels: Vec::new(),
            remote_relays: Vec::new(),
            sending_to: None,
            pending_events: VecDeque::new(),
            keyframe_requested: false,
            irap_sent: false,
            rtp_base_qpc: None,
            last_rtp_90k: None,
            stats: PeerStats::default(),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn state(&self) -> PeerState {
        self.state
    }

    pub fn stats(&self) -> PeerStats {
        PeerStats {
            pacer: self.pacer.stats(),
            channel_writes: self.out.writes,
            channel_write_refusals: self.out.refusals,
            channel_queue_overflows: self.out.overflows,
            ..self.stats
        }
    }

    /// Measured egress for this viewer over the last closed second.
    pub fn sent_bps(&self) -> u64 {
        self.pacer.sent_bps()
    }

    /// Move the pacer's ceiling. Task 4.7's governor is the caller.
    pub fn set_bitrate_ceiling(&mut self, bitrate_bps: u32) {
        self.pacer
            .set_ceiling(Instant::now(), u64::from(bitrate_bps));
    }

    /// This peer's local DTLS certificate fingerprint, in the spelling SDP
    /// uses (`sha-256 AB:CD:…`).
    ///
    /// Task 3.9 MACs it with `k = HKDF(K_session, viewerId)` so the relay
    /// cannot MITM the session (plan.md D8). It is stable for the life of the
    /// peer, including across an ICE restart.
    pub fn dtls_fingerprint(&mut self) -> String {
        self.rtc.direct_api().local_dtls_fingerprint().to_string()
    }

    /// The peer's own fingerprint on the **established** DTLS session, computed
    /// from the certificate it presented as the handshake completed.
    ///
    /// PROTOCOL §10 binds a lease renewal to this rather than to the offer's
    /// `a=fingerprint:` line: the offer is a claim made before any handshake,
    /// this is the certificate that actually authenticated. `None` until
    /// `PeerEvent::Connected` — before that there is no session to bind to.
    /// `tests/dtls_fingerprint.rs` is the proof that str0m reports the peer's
    /// and not our own.
    pub fn remote_dtls_fingerprint(&mut self) -> Option<String> {
        self.rtc
            .direct_api()
            .remote_dtls_fingerprint()
            .map(|f| f.to_string())
    }

    /// The RTP timestamp of the last access unit written — the join key the
    /// `swoop-meta` record carries. `None` before the first frame.
    pub fn last_rtp_timestamp_90k(&self) -> Option<u32> {
        self.last_rtp_90k
    }

    /// Answer a browser offer. The first call negotiates; every later one is
    /// an ICE restart, which str0m accepts while keeping its local candidates
    /// (measured in spike 0.2 §8: media never stopped, a 0.2 ms gap).
    pub fn accept_offer(&mut self, offer: &str) -> Result<String> {
        let parsed = SdpOffer::from_sdp_string(offer).map_err(|e| anyhow!("parse offer: {e}"))?;
        if self.stats.negotiations == 0 {
            let candidate = Candidate::host(self.local_addr, ice_policy::LOCAL_TRANSPORT)
                .map_err(|e| anyhow!("host candidate for {}: {e}", self.local_addr))?;
            self.add_local_candidate(candidate)?;
        }
        let answer = self
            .rtc
            .sdp_api()
            .accept_offer(parsed)
            .map_err(|e| anyhow!("accept_offer: {e}"))?
            .to_sdp_string();
        self.stats.negotiations += 1;
        Ok(restore_rejected_formats(&answer, offer))
    }

    /// Add one local candidate and queue it for trickling. The host candidate
    /// is added while answering; Task 7.4 adds server-reflexive and relayed
    /// ones through here.
    pub fn add_local_candidate(&mut self, candidate: Candidate) -> Result<()> {
        // §2 of the ICE policy: a passive ICE-TCP candidate is unreachable from
        // every browser we serve, so one is never gathered — and a relay
        // candidate arrives over udp too.
        if !ice_policy::gathers_local_transport(&candidate.proto().to_string()) {
            return Err(anyhow!(
                "swoop gathers {} candidates only",
                ice_policy::LOCAL_TRANSPORT
            ));
        }
        let sdp = candidate.to_sdp_string();
        if self.rtc.add_local_candidate(candidate).is_none() {
            return Err(anyhow!("str0m rejected the local candidate {sdp}"));
        }
        self.pending_events
            .push_back(PeerEvent::LocalCandidate(sdp));
        Ok(())
    }

    /// A candidate trickled by the viewer, as the SDP attribute value.
    ///
    /// It has already been through
    /// [`crate::transport::ice_policy::admit_remote`] — an mDNS name arrives
    /// here resolved, because str0m parses a candidate into a `SocketAddr` and
    /// has no resolver of its own.
    pub fn add_remote_candidate(&mut self, candidate: &str) -> Result<()> {
        let parsed = Candidate::from_sdp_string(candidate)
            .map_err(|e| anyhow!("parse remote candidate: {e}"))?;
        if parsed.kind() == CandidateKind::Relayed
            && self.remote_relays.len() < MAX_TRACKED_RELAYS
            && !self.remote_relays.contains(&parsed.addr())
        {
            self.remote_relays.push(parsed.addr());
        }
        self.rtc.add_remote_candidate(parsed);
        Ok(())
    }

    /// Is the pair ICE is on a relayed one?
    ///
    /// str0m 0.23 reports no selected pair, so this is what can be known for
    /// certain instead: every packet it asks to be sent once the peer is up
    /// goes to the nominated remote candidate, so the destination *is* that
    /// candidate. An address that is not one of the viewer's relay candidates
    /// is a direct one — including a peer-reflexive address str0m learned and
    /// we were never told about, which is direct by definition.
    fn sending_over_relay(&self) -> bool {
        self.sending_to
            .is_some_and(|addr| self.remote_relays.contains(&addr))
    }

    /// One nominated-pair datagram's destination. A change of it under a live
    /// peer is the pair changing, which is exactly what the promotion timer
    /// wants — before the peer is up there is no selection to report.
    fn on_send_addr(&mut self, destination: SocketAddr, events: &mut Vec<PeerEvent>) {
        if self.state != PeerState::Connected || self.sending_to == Some(destination) {
            return;
        }
        self.sending_to = Some(destination);
        events.push(PeerEvent::Ice(IceEvent::PairChanged {
            relayed: self.sending_over_relay(),
        }));
    }

    /// Queue one record for a channel. Never blocks and never writes straight
    /// through: [`poll`](Self::poll) drains the queue so one refusal cannot
    /// stall the caller.
    pub fn write_channel(&mut self, channel: Channel, binary: bool, data: Vec<u8>) {
        let mut events = Vec::new();
        self.out.push(channel, binary, data, &mut events);
        self.pending_events.extend(events);
    }

    /// Drive I/O and timers for at most `budget`, appending what it learned to
    /// `events`.
    ///
    /// The budget rather than str0m's own deadline, because the caller also
    /// has to notice the next encoded frame: a socket read that blocked until
    /// the next timer would add that wait to every frame.
    pub fn poll(
        &mut self,
        now: Instant,
        budget: Duration,
        events: &mut Vec<PeerEvent>,
    ) -> Result<()> {
        events.extend(self.pending_events.drain(..));
        self.drain_out(events);
        // Before `poll_output`, so a frame queued this turn leaves on this
        // turn rather than waiting for the next one.
        #[cfg(feature = "audio-opus")]
        self.drain_audio(now);

        let deadline = loop {
            match self.rtc.poll_output().context("poll_output")? {
                Output::Timeout(t) => break t,
                Output::Transmit(t) => {
                    let len = t.contents.len();
                    let destination = t.destination;
                    // RFC 7983's demultiplexer: 0..=3 is STUN, which goes to
                    // every pair still being checked. Everything above it —
                    // DTLS, SRTP, SCTP — goes only to the pair ICE nominated,
                    // which is what makes its destination a pair report.
                    let nominated = t.contents.first().is_some_and(|first| *first > 3);
                    if !send_datagram(&self.socket, &mut self.stats, &t.contents, destination) {
                        continue;
                    }
                    self.pacer.record_sent(now, len);
                    if nominated {
                        self.on_send_addr(destination, events);
                    }
                }
                Output::Event(e) => self.handle_event(e, events),
            }
        };

        if self.state == PeerState::Closed {
            return Ok(());
        }

        let wait = deadline
            .saturating_duration_since(now)
            .min(budget)
            .max(MIN_POLL_WAIT);
        self.socket
            .set_read_timeout(Some(wait))
            .context("set_read_timeout")?;
        match self.socket.recv_from(&mut self.buf) {
            Ok((n, source)) => {
                let contents = self.buf[..n]
                    .try_into()
                    .map_err(|e| anyhow!("datagram from {source}: {e}"))?;
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
                    .context("handle_input receive")?;
            }
            // Anything else is a timeout, a would-block, or Windows reporting
            // an ICMP port-unreachable from a *previous* send on the next
            // receive — routine while ICE is still probing, never fatal.
            Err(_) => self
                .rtc
                .handle_input(Input::Timeout(Instant::now()))
                .context("handle_input timeout")?,
        }
        Ok(())
    }

    /// Start a graceful shutdown. `poll` keeps running until the peer reports
    /// [`PeerState::Closed`], so the DTLS close and RTCP BYE go out.
    pub fn disconnect(&mut self) {
        self.rtc.disconnect();
    }

    fn drain_out(&mut self, events: &mut Vec<PeerEvent>) {
        let Self {
            out, rtc, channels, ..
        } = self;
        out.drain(events, |channel, binary, data| {
            let Some(id) = channels
                .iter()
                .find(|(_, c)| *c == channel)
                .map(|(id, _)| *id)
            else {
                return WriteOutcome::NotOpen;
            };
            let Some(mut ch) = rtc.channel(id) else {
                return WriteOutcome::NotOpen;
            };
            match ch.write(binary, data) {
                Ok(true) => WriteOutcome::Accepted,
                Ok(false) => WriteOutcome::NoRoom,
                Err(_) => WriteOutcome::NotOpen,
            }
        });
    }

    fn handle_event(&mut self, event: Event, events: &mut Vec<PeerEvent>) {
        match event {
            Event::Connected => {
                self.state = PeerState::Connected;
                events.push(PeerEvent::Connected);
            }
            // ICE reached a pair. `Completed` restates it once gathering is
            // over, and either one re-arms the policy's promotion timer against
            // whatever pair is now carrying the packets.
            Event::IceConnectionStateChange(
                IceConnectionState::Connected | IceConnectionState::Completed,
            ) => events.push(PeerEvent::Ice(IceEvent::Connected {
                relayed: self.sending_over_relay(),
            })),
            // Terminal for this peer, both of them: the browser always
            // re-offers (plan.md D8), so a viewer that comes back gets a new
            // peer rather than this one recovering. An ICE *restart* arrives
            // while the peer is still live and goes through `accept_offer`.
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) | Event::Closed => {
                self.state = PeerState::Closed;
                events.push(PeerEvent::Disconnected);
            }
            Event::MediaAdded(m) => self.on_media_added(&m),
            Event::ChannelOpen(id, label) => match channel_from_label(&label) {
                Some(channel) => {
                    self.channels.push((id, channel));
                    events.push(PeerEvent::ChannelOpen(channel));
                }
                None => {
                    // PROTOCOL §3: the host refuses any label that is not one
                    // of the five, and never creates a channel itself.
                    self.stats.channels_refused += 1;
                    events.push(PeerEvent::ChannelRefused(label));
                }
            },
            Event::ChannelClose(id) => {
                if let Some(pos) = self.channels.iter().position(|(c, _)| *c == id) {
                    let (_, channel) = self.channels.remove(pos);
                    events.push(PeerEvent::ChannelClose(channel));
                }
            }
            Event::ChannelData(d) => {
                if let Some((_, channel)) = self.channels.iter().find(|(id, _)| *id == d.id) {
                    events.push(PeerEvent::ChannelData {
                        channel: *channel,
                        binary: d.binary,
                        data: d.data,
                    });
                }
            }
            Event::KeyframeRequest(_) => {
                self.keyframe_requested = true;
                self.stats.keyframe_requests += 1;
                events.push(PeerEvent::KeyframeRequest);
            }
            Event::EgressBitrateEstimate(kind) => {
                let bitrate = match kind {
                    str0m::bwe::BweKind::Twcc(b) => b,
                    str0m::bwe::BweKind::Remb(_, b) => b,
                    // BweKind is #[non_exhaustive].
                    _ => return,
                };
                events.push(PeerEvent::BitrateEstimate(bitrate.as_u64()));
            }
            _ => {}
        }
    }

    /// One negotiated m-line. §3 has two: the picture, and — behind
    /// `audio-opus` — the audio track, which keeps its own mid and payload
    /// type so neither can overwrite the other's.
    fn on_media_added(&mut self, m: &MediaAdded) {
        if m.kind == MediaKind::Audio {
            #[cfg(feature = "audio-opus")]
            {
                self.audio.mid = Some(m.mid);
                self.audio.pt = self.resolve_pt(m.mid, Str0mCodec::Opus);
                if self.audio.pt.is_none() {
                    ::log::error!("no opus payload type on the audio mid {}", m.mid);
                }
            }
            // Without the feature there is no Opus in the answer, so an audio
            // m-line the browser offered was rejected and carries nothing.
            return;
        }
        self.mid = Some(m.mid);
        let want = match self.codec {
            Codec::H264 => Str0mCodec::H264,
            Codec::H265 => Str0mCodec::H265,
        };
        self.pt = self.resolve_pt(m.mid, want);
        if self.pt.is_none() {
            ::log::error!(
                "no payload type on mid {} matched the negotiated codec {:?}",
                m.mid,
                self.codec
            );
        }
    }

    /// Resolve the payload type for one codec on a negotiated m-line.
    ///
    /// Matching is on the codec alone. `PayloadParams::resend()` is *not* an
    /// "is this an RTX parameter" test despite how it reads — str0m stores the
    /// repairing RTX payload type there, so it is `Some` for every real video
    /// codec that has RTX. An RTX entry identifies itself by its own
    /// `spec().codec`.
    fn resolve_pt(&mut self, mid: Mid, want: Str0mCodec) -> Option<Pt> {
        self.rtc
            .writer(mid)?
            .payload_params()
            .find(|p| p.spec().codec == want)
            .map(|p| p.pt())
    }

    /// Hand this peer the viewer's audio. Each viewer gets its own track, so
    /// one viewer draining slowly cannot take another's audio with it.
    #[cfg(feature = "audio-opus")]
    pub fn set_audio_source(&mut self, track: crate::audio::AudioTrack) {
        self.audio.track = Some(track);
    }

    /// Write whatever audio is waiting. Straight to str0m, never through the
    /// pacer — see the module doc.
    #[cfg(feature = "audio-opus")]
    fn drain_audio(&mut self, now: Instant) {
        if self.state != PeerState::Connected {
            return;
        }
        let (Some(mid), Some(pt), Some(track)) =
            (self.audio.mid, self.audio.pt, self.audio.track.clone())
        else {
            return;
        };
        while let Some(packet) = track.try_recv() {
            let Some(writer) = self.rtc.writer(mid) else {
                return;
            };
            // The capture clock's own timestamp, contiguous across every
            // device gap because `audio::opus::Timeline` filled the holes.
            let time = MediaTime::new(packet.rtp_48k, str0m::media::Frequency::FORTY_EIGHT_KHZ);
            if let Err(e) = writer.write(pt, now, time, packet.payload.as_slice()) {
                // One bad write is not a dead session: the next frame is 10 ms
                // away and the timeline does not depend on this one landing.
                ::log::warn!("swoop: audio frame at {} not written: {e}", packet.rtp_48k);
                return;
            }
            self.stats.audio_packets_written += 1;
        }
    }

    /// 90 kHz media time for one frame, from the capture clock the front half
    /// stamped it with — not from send time, which would fold this thread's
    /// scheduling into the receiver's jitter estimate.
    fn rtp_timestamp_90k(&mut self, captured_qpc: i64) -> u64 {
        let base = *self.rtp_base_qpc.get_or_insert(captured_qpc);
        let ticks = i128::from(captured_qpc.saturating_sub(base)).max(0);
        (ticks * 90_000 / i128::from(self.qpc_hz)) as u64
    }
}

impl VideoSink for RtcPeer {
    fn send(&mut self, frame: &EncodedFrame) -> Result<()> {
        if self.state != PeerState::Connected {
            return Ok(());
        }
        let (Some(mid), Some(pt)) = (self.mid, self.pt) else {
            return Ok(());
        };
        let now = Instant::now();
        if self.pacer.admit(now, frame.data.len(), frame.is_irap) == Admission::DropOverBudget {
            self.pending_events.push_back(PeerEvent::FrameDropped {
                frame_id: frame.frame_id,
                bytes: frame.data.len(),
            });
            return Ok(());
        }

        let rtp = self.rtp_timestamp_90k(frame.captured_qpc);
        let writer = self
            .rtc
            .writer(mid)
            .ok_or_else(|| anyhow!("no writer for mid {mid}"))?;
        writer
            .playout_delay(
                MediaTime::from_hundredths(PLAYOUT_DELAY_MIN_MS / 10),
                MediaTime::from_hundredths(PLAYOUT_DELAY_MAX_MS / 10),
            )
            .write(pt, now, MediaTime::from_90khz(rtp), frame.data.as_slice())
            .map_err(|e| anyhow!("write frame {}: {e}", frame.frame_id))?;

        self.last_rtp_90k = Some(rtp as u32);
        self.stats.frames_written += 1;
        if frame.is_irap {
            self.irap_sent = true;
            self.keyframe_requested = false;
        }
        Ok(())
    }

    fn wants_irap(&self) -> bool {
        !self.irap_sent || self.keyframe_requested
    }
}

/// What a rejected m-line carries when the offer itself named no format —
/// itself invalid SDP, so this only keeps the answer parseable rather than
/// passing the offerer's mistake back to it. Payload type 0 is static and
/// always defined.
const REJECTED_FORMAT_FALLBACK: &str = "0";

/// The format list of one `m=` line: everything after
/// `m=<media> <port> <proto>`.
fn media_formats(m_line: &str) -> &str {
    m_line.splitn(4, ' ').nth(3).unwrap_or("").trim()
}

/// Put the offer's format list back on any answer m-line that has none.
///
/// **This is a workaround for str0m 0.23.1, not a decision of ours.** RFC 4566's
/// `media-field` is `m=<media> <port> <proto> 1*(SP fmt)` — at least one format,
/// on a rejected `port 0` m-line exactly as on a live one. str0m's writer
/// (`impl fmt::Display for MediaLine`, `src/sdp/data.rs`) writes
/// `m=<typ> <port> <proto> ` and then one token per payload type that survived
/// negotiation; those come from
/// `Media::as_media_line` (`src/change/sdp.rs`), which intersects the local
/// codec config with the offer's payload types. When the intersection is empty
/// the loop writes nothing and the line ends at that trailing space. str0m
/// knows the rule — the `stopped` field on `Media` carries the comment "the SDP
/// grammar requires at least one fmt on a port=0 m-line" — but only honours it
/// for an explicitly stopped m-line, not for the "no codecs matched" one.
///
/// A default-feature build has no Opus, the browser offers `audio` recvonly
/// unconditionally, so **every** default build emitted
/// `m=audio 0 UDP/TLS/RTP/SAVPF ` and Chrome discarded the whole answer with
/// "Failed to parse SessionDescription … Invalid value: .".
///
/// RFC 3264 §6 makes the repair free: a rejected m-line's formats are ignored,
/// and the answer has the same m-lines in the same order as the offer, so the
/// offer's own list goes straight back on.
fn restore_rejected_formats(answer: &str, offer: &str) -> String {
    let mut offered = offer
        .lines()
        .filter(|l| l.starts_with("m="))
        .map(media_formats);
    let mut out = String::with_capacity(answer.len());
    for line in answer.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        if !body.starts_with("m=") {
            out.push_str(line);
            continue;
        }
        // Advanced for every m-line and not only the broken ones: it is the
        // offer's line at the same index that this one answers.
        let formats = offered.next().unwrap_or("");
        if !media_formats(body).is_empty() {
            out.push_str(line);
            continue;
        }
        out.push_str(body.trim_end());
        out.push(' ');
        out.push_str(if formats.is_empty() {
            REJECTED_FORMAT_FALLBACK
        } else {
            formats
        });
        out.push_str(&line[body.len()..]);
    }
    out
}

/// The five labels of PROTOCOL §3. Spelled here rather than derived from
/// serde so the transport does not have to serialize an enum to write a
/// header; the test below pins the two spellings together.
fn channel_label(channel: Channel) -> &'static str {
    match channel {
        Channel::SwoopInput => "swoop-input",
        Channel::SwoopCursor => "swoop-cursor",
        Channel::SwoopControl => "swoop-control",
        Channel::SwoopFeedback => "swoop-feedback",
        Channel::SwoopMeta => "swoop-meta",
    }
}

fn channel_from_label(label: &str) -> Option<Channel> {
    [
        Channel::SwoopInput,
        Channel::SwoopCursor,
        Channel::SwoopControl,
        Channel::SwoopFeedback,
        Channel::SwoopMeta,
    ]
    .into_iter()
    .find(|c| channel_label(*c) == label)
}

/// `QueryPerformanceFrequency`, for [`PeerConfig::qpc_hz`]. Fixed for the life
/// of the system, so a caller reads it once.
#[cfg(windows)]
pub fn qpc_hz() -> Result<i64> {
    let mut hz = 0i64;
    unsafe {
        windows::Win32::System::Performance::QueryPerformanceFrequency(&mut hz)
            .context("QueryPerformanceFrequency")?;
    }
    Ok(hz)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_refused_send_is_counted_and_survived() {
        let socket = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind");
        let mut stats = super::PeerStats::default();
        // an address family the socket does not carry: refused synchronously
        let unreachable: std::net::SocketAddr = "[::1]:9".parse().expect("addr");
        assert!(!super::send_datagram(&socket, &mut stats, b"", unreachable));
        assert_eq!(stats.datagrams_send_failed, 1);
        assert_eq!(stats.datagrams_sent, 0);
        // and a reachable one still counts as sent
        let reachable = socket.local_addr().expect("local");
        assert!(super::send_datagram(&socket, &mut stats, b"", reachable));
        assert_eq!(stats.datagrams_sent, 1);
    }

    use super::*;

    fn events() -> Vec<PeerEvent> {
        Vec::new()
    }

    #[test]
    fn the_five_labels_are_spelled_the_way_the_wire_spells_them() {
        // The enum's serde spelling is the protocol's; this keeps the
        // transport's hand-written table from drifting away from it.
        for channel in [
            Channel::SwoopInput,
            Channel::SwoopCursor,
            Channel::SwoopControl,
            Channel::SwoopFeedback,
            Channel::SwoopMeta,
        ] {
            let serde = serde_json::to_string(&channel).expect("it serializes");
            assert_eq!(serde, format!("\"{}\"", channel_label(channel)));
            assert_eq!(channel_from_label(channel_label(channel)), Some(channel));
        }
        assert_eq!(channel_from_label("swoop-clipboard"), None);
        assert_eq!(channel_from_label("swoop-video"), None);
    }

    #[test]
    fn playout_delay_is_never_max_zero_and_lands_on_the_wire_granularity() {
        // max = 0 takes Chrome's fast-forward branch, which drops every
        // decodable temporal unit but the newest and breaks a non-scalable
        // H.26x reference chain. The wire carries two 12-bit fields of 10 ms.
        assert_eq!(PLAYOUT_DELAY_MIN_MS, 0);
        const { assert!(PLAYOUT_DELAY_MAX_MS > 0 && PLAYOUT_DELAY_MAX_MS <= 500) };
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
            "str0m's standard map gained playout-delay; the explicit set() in bind() may be redundant"
        );
        let mut exts = ExtensionMap::standard();
        exts.set(EXT_ID_PLAYOUT_DELAY, Extension::PlayoutDelay);
        exts.set(EXT_ID_TWCC, Extension::TransportSequenceNumber);
        assert_eq!(
            exts.id_of(Extension::PlayoutDelay),
            Some(EXT_ID_PLAYOUT_DELAY)
        );
        assert_eq!(
            exts.id_of(Extension::TransportSequenceNumber),
            Some(EXT_ID_TWCC)
        );
    }

    /// The fmtp §3 promises and the payload params `bind` builds are two
    /// spellings of one decision, and a receiver believes the second.
    #[cfg(feature = "audio-opus")]
    #[test]
    fn the_opus_payload_params_say_what_the_fmtp_says() {
        use crate::audio::opus;

        let mut config = RtcConfig::new().clear_codecs();
        config.codec_config().add_config(
            OPUS_PT.into(),
            None,
            Str0mCodec::Opus,
            str0m::media::Frequency::FORTY_EIGHT_KHZ,
            Some(opus::CHANNELS as u8),
            str0m::format::FormatParams {
                min_p_time: Some(opus::FRAME_MS as u8),
                stereo: Some(true),
                sprop_stereo: Some(true),
                use_inband_fec: Some(true),
                use_dtx: Some(false),
                ..Default::default()
            },
        );
        let params = config.codec_config().params();
        assert_eq!(params.len(), 1, "one audio payload type, and nothing else");
        let spec = params[0].spec();
        assert_eq!(spec.codec, Str0mCodec::Opus);
        assert_eq!(spec.clock_rate.get(), opus::SAMPLE_RATE_HZ);
        assert_eq!(spec.channels, Some(opus::CHANNELS as u8));

        // str0m formats fmtp from these fields; comparing the rendered form is
        // what catches a field going missing rather than going wrong.
        let rendered = spec.format.to_string();
        for pair in opus::FMTP.split("; ") {
            assert!(rendered.contains(pair), "fmtp is missing {pair}: {rendered}");
        }
    }

    /// The regression that cost a live session: a default build answered the
    /// browser's `audio` m-line with `m=audio 0 UDP/TLS/RTP/SAVPF ` and nothing
    /// after it, and Chrome threw the whole answer away.
    ///
    /// The offer is built with str0m rather than pasted from a browser because
    /// what makes the m-line rejectable is the *host* having no Opus, not
    /// anything Chrome spells unusually — and a synthetic offer is one the
    /// assertions can name payload types from.
    #[test]
    fn the_answer_never_carries_an_m_line_with_no_format() {
        use str0m::media::{Direction, MediaKind};

        let mut host = RtcPeer::bind(PeerConfig {
            bind_addr: "127.0.0.1:0".parse().expect("a literal address"),
            codec: Codec::H264,
            fps: 60,
            bitrate_bps: 20_000_000,
            qpc_hz: 10_000_000,
            enable_bwe: false,
        })
        .expect("bind host");

        // The viewer's shape from `web/lib/swoop/peer.ts` `start()`: both
        // tracks recvonly, audio offered unconditionally.
        let mut viewer = RtcConfig::new()
            .clear_codecs()
            .enable_h264(true)
            .enable_opus(true)
            .build(Instant::now());
        let mut api = viewer.sdp_api();
        api.add_media(MediaKind::Video, Direction::RecvOnly, None, None, None);
        api.add_media(MediaKind::Audio, Direction::RecvOnly, None, None, None);
        api.add_channel("swoop-meta".to_string());
        let (offer, _pending) = api.apply().expect("the offer has changes");
        let offer = offer.to_sdp_string();

        let answer = host.accept_offer(&offer).expect("the host answers");

        for line in answer.lines().filter(|l| l.starts_with("m=")) {
            assert!(
                !media_formats(line).is_empty(),
                "rfc 4566 media-field is 1*(SP fmt), rejected or not: {line:?}"
            );
        }

        let audio = answer
            .lines()
            .find(|l| l.starts_with("m=audio"))
            .expect("the answer mirrors the offer's m-lines");
        #[cfg(not(feature = "audio-opus"))]
        {
            let offered = offer
                .lines()
                .find(|l| l.starts_with("m=audio"))
                .map(media_formats)
                .expect("the offer has an audio m-line");
            assert!(
                audio.starts_with("m=audio 0 "),
                "no opus to answer with, so the m-line is rejected: {audio:?}"
            );
            assert_eq!(
                media_formats(audio),
                offered,
                "rfc 3264: the offer's format list comes back on the rejected line"
            );
        }
        #[cfg(feature = "audio-opus")]
        assert!(
            audio.starts_with("m=audio 9 "),
            "with opus the m-line is live and untouched: {audio:?}"
        );
    }

    #[test]
    fn only_a_formatless_m_line_is_repaired_and_the_lines_stay_in_step() {
        // The first line is the literal str0m 0.23.1 writes — trailing space,
        // no payload type. When an upgrade stops writing it this repair goes
        // quiet on its own; it never starts rewriting a well-formed line.
        let offer = "v=0\r\n\
                     m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\n\
                     a=mid:0\r\n\
                     m=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\n\
                     m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
        let answer = "v=0\r\n\
                      m=video 9 UDP/TLS/RTP/SAVPF 96\r\n\
                      a=mid:0\r\n\
                      m=audio 0 UDP/TLS/RTP/SAVPF \r\n\
                      m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
        assert_eq!(
            restore_rejected_formats(answer, offer),
            "v=0\r\n\
             m=video 9 UDP/TLS/RTP/SAVPF 96\r\n\
             a=mid:0\r\n\
             m=audio 0 UDP/TLS/RTP/SAVPF 111 63\r\n\
             m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
        );

        // Nothing to repair is the same bytes back, crlf and all.
        let good = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
        assert_eq!(restore_rejected_formats(good, offer), good);

        // An offer that named no format either is itself invalid sdp; the
        // answer still leaves here parseable.
        assert_eq!(
            restore_rejected_formats(
                "m=audio 0 UDP/TLS/RTP/SAVPF \r\n",
                "m=audio 9 UDP/TLS/RTP/SAVPF \r\n"
            ),
            format!("m=audio 0 UDP/TLS/RTP/SAVPF {REJECTED_FORMAT_FALLBACK}\r\n")
        );
    }

    #[test]
    fn a_refused_write_is_counted_retried_and_never_lost() {
        let mut queue = OutQueue::default();
        let mut ev = events();
        queue.push(Channel::SwoopMeta, true, vec![0u8; 48], &mut ev);
        queue.push(Channel::SwoopMeta, true, vec![1u8; 48], &mut ev);
        assert!(ev.is_empty());

        // A fake channel with no room, which is exactly `Ok(false)` from
        // str0m inside the 128 KiB ceiling shared by all five channels.
        queue.drain(&mut ev, |_, _, _| WriteOutcome::NoRoom);
        assert_eq!(
            queue.refusals, 1,
            "one refusal per drain, not one per record"
        );
        assert_eq!(queue.writes, 0);
        assert_eq!(queue.queued.len(), 2, "nothing is dropped on a refusal");
        assert!(matches!(
            ev.as_slice(),
            [PeerEvent::ChannelWriteRefused {
                channel: Channel::SwoopMeta,
                queued_bytes: 96
            }]
        ));

        // Room again: both records go, in the order they were queued.
        let mut written = Vec::new();
        queue.drain(&mut ev, |_, _, data| {
            written.push(data[0]);
            WriteOutcome::Accepted
        });
        assert_eq!(written, vec![0, 1]);
        assert_eq!(queue.writes, 2);
        assert_eq!(queue.bytes, 0);
        assert!(queue.queued.is_empty());
    }

    #[test]
    fn a_record_for_a_channel_the_browser_has_not_opened_waits_rather_than_counting() {
        let mut queue = OutQueue::default();
        let mut ev = events();
        queue.push(Channel::SwoopCursor, false, vec![2u8; 16], &mut ev);
        queue.drain(&mut ev, |_, _, _| WriteOutcome::NotOpen);
        assert_eq!(
            queue.refusals, 0,
            "a closed channel is not a full transport"
        );
        assert_eq!(queue.queued.len(), 1);
        assert!(ev.is_empty());
    }

    #[test]
    fn the_watermark_drops_the_oldest_record_and_says_so() {
        let mut queue = OutQueue::default();
        let mut ev = events();
        // Fill to the watermark with records nothing is draining.
        for _ in 0..8 {
            queue.push(Channel::SwoopControl, false, vec![0u8; 8 * 1024], &mut ev);
        }
        assert_eq!(queue.bytes, OUT_QUEUE_HIGH_WATERMARK);
        assert_eq!(queue.overflows, 0);
        assert!(ev.is_empty());

        queue.push(Channel::SwoopMeta, true, vec![9u8; 48], &mut ev);
        assert_eq!(queue.overflows, 1);
        assert!(queue.bytes <= OUT_QUEUE_HIGH_WATERMARK);
        assert!(matches!(
            ev.as_slice(),
            [PeerEvent::ChannelQueueOverflow {
                channel: Channel::SwoopControl
            }]
        ));
        // The newest record survived — it is the one the viewer still needs.
        assert_eq!(
            queue.queued.back().map(|i| i.channel),
            Some(Channel::SwoopMeta)
        );
    }

    /// Answer one offer captured from a real browser and then connect to it,
    /// for the round-trip the module doc describes. Both paths come from the
    /// environment so the harness driving the browser owns the files.
    #[test]
    #[ignore]
    fn answers_an_offer_from_a_file() {
        let offer_path = std::env::var("SWOOP_OFFER_SDP").expect("SWOOP_OFFER_SDP");
        let answer_path = std::env::var("SWOOP_ANSWER_SDP").expect("SWOOP_ANSWER_SDP");
        let offer = std::fs::read_to_string(&offer_path).expect("read the offer");
        // The address the product binds (`session::local_bind_addr`): the
        // interface that would reach the internet. A loopback socket cannot
        // answer a browser candidate gathered on a real one.
        let route = UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| {
                s.connect("1.1.1.1:53")?;
                s.local_addr()
            })
            .expect("a route to the internet");
        let mut peer = RtcPeer::bind(PeerConfig {
            bind_addr: SocketAddr::new(route.ip(), 0),
            codec: Codec::H264,
            fps: 60,
            bitrate_bps: 20_000_000,
            qpc_hz: 10_000_000,
            enable_bwe: false,
        })
        .expect("bind");
        let answer = peer.accept_offer(&offer).expect("the host answers");
        std::fs::write(&answer_path, &answer).expect("write the answer");

        // The browser applies it, ICE and DTLS run, and the five channels of §3
        // open — which is the whole of "a session connected", and what a
        // discarded answer stopped at `connecting`.
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut ev = events();
        let mut opened = Vec::new();
        while Instant::now() < deadline && opened.len() < 5 {
            peer.poll(Instant::now(), Duration::from_millis(5), &mut ev)
                .expect("poll");
            for event in ev.drain(..) {
                if let PeerEvent::ChannelOpen(channel) = event {
                    opened.push(channel);
                }
            }
        }
        assert_eq!(
            peer.state(),
            PeerState::Connected,
            "the browser never completed ice + dtls"
        );
        assert_eq!(opened.len(), 5, "channels opened: {opened:?}");
    }

    /// Binds a udp socket on loopback.
    #[test]
    #[ignore]
    fn binds_and_reports_a_concrete_local_address() {
        let mut peer = RtcPeer::bind(PeerConfig {
            bind_addr: "127.0.0.1:0".parse().expect("a literal address"),
            codec: Codec::H264,
            fps: 60,
            bitrate_bps: 20_000_000,
            qpc_hz: 10_000_000,
            enable_bwe: false,
        })
        .expect("bind");
        assert!(peer.local_addr().port() > 0);
        assert_eq!(peer.state(), PeerState::Negotiating);
        assert!(peer.wants_irap(), "a peer that has sent nothing needs one");
        // Task 3.9 MACs this; it exists before a viewer does.
        let fingerprint = peer.dtls_fingerprint();
        assert!(fingerprint.starts_with("sha-256 "), "{fingerprint}");
    }

    /// Two peers on loopback, ICE + DTLS + SCTP + one media track. See the
    /// module doc for the command and the expected result.
    #[test]
    #[ignore]
    fn loopback_two_peers_connect_and_carry_a_track() {
        use str0m::media::{Direction, MediaKind};

        let mut host = RtcPeer::bind(PeerConfig {
            bind_addr: "127.0.0.1:0".parse().expect("a literal address"),
            codec: Codec::H264,
            fps: 60,
            bitrate_bps: 20_000_000,
            qpc_hz: 10_000_000,
            enable_bwe: false,
        })
        .expect("bind host");

        let viewer_socket = UdpSocket::bind("127.0.0.1:0").expect("bind viewer");
        viewer_socket
            .set_read_timeout(Some(Duration::from_millis(1)))
            .expect("read timeout");
        let viewer_addr = viewer_socket.local_addr().expect("viewer addr");

        let mut exts = ExtensionMap::standard();
        exts.set(EXT_ID_PLAYOUT_DELAY, Extension::PlayoutDelay);
        exts.set(EXT_ID_TWCC, Extension::TransportSequenceNumber);
        let mut viewer = RtcConfig::new()
            .clear_codecs()
            .enable_h264(true)
            .set_extension_map(exts)
            .build(Instant::now());
        viewer.add_local_candidate(
            Candidate::host(viewer_addr, "udp").expect("viewer host candidate"),
        );

        let mut api = viewer.sdp_api();
        api.add_media(MediaKind::Video, Direction::RecvOnly, None, None, None);
        api.add_channel("swoop-meta".to_string());
        let (offer, pending) = api.apply().expect("the offer has changes");

        let answer = host
            .accept_offer(&offer.to_sdp_string())
            .expect("the host answers");
        viewer
            .sdp_api()
            .accept_answer(
                pending,
                str0m::change::SdpAnswer::from_sdp_string(&answer).expect("parse answer"),
            )
            .expect("the viewer applies the answer");

        // 60 s of 60 fps at the configured 20 Mbps: 41,666 bytes an interval.
        const FRAME_INTERVAL: Duration = Duration::from_nanos(16_666_667);
        const FRAMES: u64 = 60 * 60;
        const FRAME_BYTES: usize = 41_000;

        let mut buf = vec![0u8; RECV_BUF_BYTES];
        let mut ev = events();
        let deadline = Instant::now() + Duration::from_secs(90);
        let mut frame_id = 0u64;
        let mut connected = false;
        let mut next_frame_at = Instant::now();

        while Instant::now() < deadline {
            let now = Instant::now();
            host.poll(now, Duration::from_millis(1), &mut ev)
                .expect("host poll");

            // The viewer half, hand-driven: it is a bare `Rtc`, not an RtcPeer.
            loop {
                match viewer.poll_output().expect("viewer poll_output") {
                    Output::Timeout(_) => break,
                    Output::Transmit(t) => {
                        viewer_socket
                            .send_to(&t.contents, t.destination)
                            .expect("viewer send");
                    }
                    Output::Event(Event::Connected) => connected = true,
                    Output::Event(_) => {}
                }
            }
            if let Ok((n, source)) = viewer_socket.recv_from(&mut buf) {
                let contents = buf[..n].try_into().expect("a datagram");
                viewer
                    .handle_input(Input::Receive(
                        Instant::now(),
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: viewer_addr,
                            contents,
                        },
                    ))
                    .expect("viewer handle_input");
            } else {
                viewer
                    .handle_input(Input::Timeout(Instant::now()))
                    .expect("viewer timeout");
            }

            // Paced at the capture rate, because a source that hands the
            // transport frames as fast as the loop spins is measuring the loop.
            if host.state() == PeerState::Connected && connected && Instant::now() >= next_frame_at
            {
                // One frame plus its meta record, the shape the product sends.
                let frame = EncodedFrame {
                    data: vec![0u8; FRAME_BYTES],
                    is_irap: frame_id == 0,
                    codec: Codec::H264,
                    width: 1920,
                    height: 1080,
                    frame_id,
                    captured_qpc: (frame_id as i64) * 166_667,
                    encoded_qpc: (frame_id as i64) * 166_667,
                };
                host.send(&frame).expect("write the frame");
                host.write_channel(Channel::SwoopMeta, true, vec![0u8; 48]);
                frame_id += 1;
                next_frame_at = Instant::now() + FRAME_INTERVAL;
                if frame_id >= FRAMES {
                    break;
                }
            }
        }

        let stats = host.stats();
        assert!(connected, "the two peers never completed ICE + DTLS");
        assert_eq!(frame_id, FRAMES, "the run did not reach 60 s of frames");
        assert_eq!(
            stats.channel_write_refusals, 0,
            "sctp refused a meta record inside the 128 KiB shared ceiling"
        );
        assert_eq!(
            stats.pacer.dropped_over_budget, 0,
            "the pacer refused a frame at its own configured ceiling"
        );
        assert!(stats.datagrams_sent > 0);
        assert!(host.last_rtp_timestamp_90k().is_some());
    }
}
