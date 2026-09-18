//! **Arm A** — encoded access units over an `RTCDataChannel`, on str0m.
//!
//! The browser reassembles the fragments, hands them to a WebCodecs
//! `VideoDecoder` and presents into a canvas it owns. Nothing about the video
//! is negotiated in SDP: the offer carries an `m=application` line and nothing
//! else, so there is no RTP, no jitter buffer, no NACK/RTX and no PLI. Every
//! one of those becomes this arm's own problem, which is the trade plan.md D3
//! is measuring.
//!
//! # Why the fragment is 1200 bytes and the frame is not one message
//!
//! `review-1-latency.md` F2 is explicit: fragment at the SCTP payload size,
//! "not one message per frame and not 16 KiB". str0m's SCTP runs a fixed
//! `INITIAL_MTU = 1228` (`sctp-proto/src/config.rs:11`) with no path-MTU
//! discovery, which leaves `1228 - (COMMON_HEADER_SIZE + DATA_CHUNK_HEADER_SIZE)`
//! = 1200 bytes of user payload in one DATA chunk
//! (`sctp-proto/src/config.rs:210`). A 1200-byte message is therefore exactly
//! one chunk: no SCTP-level fragmentation, and partial reliability abandons one
//! packet rather than a whole frame's worth of them.
//!
//! A 256 KiB message is legal on the wire — Chrome advertises
//! `max-message-size: 262144` and str0m's `LOCAL_MAX_MESSAGE_SIZE` is the same
//! (`str0m/src/sctp/mod.rs:33`) — and is the worst possible unit for both
//! partial reliability and the buffer cap below.
//!
//! # The buffer cap, and what this arm does about it
//!
//! `Channel::write()` (`str0m/src/channel.rs:58-62`) refuses a buffer larger
//! than `RtcSctp::available()`, which is `MAX_BUFFERED_ACROSS_STREAMS` (128 KiB,
//! `str0m/src/sctp/mod.rs:30`) minus what every stream already has buffered.
//! `Ok(false)` is **not** an error, so a naive sender drops the frame and never
//! finds out why. This arm therefore:
//!
//! - counts every `Ok(false)` as [`DataChannelSink::write_refusals`], which is
//!   the parent task's own pass criterion (review-1 F1: zero of them in a 60 s
//!   50 Mbps run);
//! - re-offers the refused fragment on the next poll rather than dropping it,
//!   so a refusal is a stall and not a silent hole in the stream;
//! - bounds the backlog in **whole frames** and drops the oldest frame when it
//!   overflows, which is moonlight-web's high-watermark behaviour and is the
//!   only drop unit a decoder can resynchronise from.
//!
//! # Reliability mode is the browser's, not this file's
//!
//! The browser is the offerer (plan.md D8) and opens the channel, so the
//! `{ordered, maxPacketLifeTime, maxRetransmits}` triple in review-1 F2's
//! matrix is a browser-side `createDataChannel` option. str0m reads it out of
//! the DCEP OPEN and applies it to the sctp-proto stream
//! (`str0m/src/sctp/mod.rs:243-256`), so the matrix costs this file nothing and
//! the run's JSON records which mode the page used.
//!
//! # What this arm does not do, on purpose
//!
//! No FEC, no TURN, no congestion control of its own. str0m's bandwidth
//! estimator is driven by transport-wide-cc on a media m-line, of which this
//! arm has none, so it emits no [`SinkEvent::BitrateEstimate`] and the encoder
//! runs at its configured target. That is a real gap in arm A and it is
//! reported rather than papered over.

use std::collections::VecDeque;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};

use crate::json::J;
use crate::nal::{self, Codec};
use crate::sink::{ice_ufrag, Arm, EncodedAu, Reoffer, Result, SinkEvent, SinkState, VideoSink};

/// Label of the channel the browser opens for the video. The browser also
/// chooses its reliability mode; this arm only writes to it.
pub const VIDEO_CHANNEL_LABEL: &str = "swoop-video";

/// One SCTP DATA chunk of user payload at str0m's fixed MTU — see the module
/// doc. This is the whole message, header included.
pub const FRAGMENT_BYTES: usize = 1200;

/// `kind`, `flags`, `fragIndex`, `fragCount`, `frameId`.
pub const COMMON_HEADER_BYTES: usize = 10;

/// `rtp`, `auBytes`, `codec`, `irap`, then the six QPC stamps as `i64`.
pub const FRAME_HEADER_BYTES: usize = 10 + 6 * 8;

/// First byte of a message. A control record is JSON so the codec string can
/// grow a field without a new wire version; a fragment is binary because it is
/// sent 5 000 times a second.
const KIND_CONTROL: u8 = 0;
const KIND_FRAGMENT: u8 = 1;
/// Synthetic load, discarded by the browser. See [`DataChannelSink::load_bps`].
const KIND_PADDING: u8 = 2;

const FLAG_IRAP: u8 = 1 << 0;
const FLAG_FIRST: u8 = 1 << 1;
const FLAG_LAST: u8 = 1 << 2;

/// How many whole frames may wait for the channel. Eight at 60 fps is 133 ms —
/// past that a viewer is watching the past, and the honest response is to drop
/// the oldest frame and say so rather than to grow a queue that turns a
/// throughput problem into a latency one.
const MAX_PENDING_FRAMES: usize = 8;

/// What the browser asks for when it sees a `frameId` gap. Arm A has no PLI:
/// review-1 F2's own precedent (moonlight-web) detects the gap in the frontend
/// and requests an IDR, having tried and removed a reorder buffer.
const IDR_REQUEST: &[u8] = b"idr";

struct PendingFrame {
    fragments: VecDeque<Vec<u8>>,
    is_irap: bool,
}

pub struct DataChannelSink {
    rtc: Rtc,
    socket: UdpSocket,
    local_addr: SocketAddr,
    codec: Codec,
    /// Total bytes per second this arm offers the channel, video included, or 0
    /// for "whatever the encoder produces".
    ///
    /// review-1 F1's pass criterion is **zero `Ok(false)` in a 60 s 50 Mbps
    /// run**, and on this box the front half cannot produce 50 Mbps. Measured
    /// with `--bitrate` at 50 Mbps over a 58 s window: 63 008-byte access units,
    /// 30.7 Mbps. At 100 Mbps over 9.1 s: 63 030 bytes, 31.1 Mbps. With a
    /// full-frame noise stimulus on the captured monitor, which is as
    /// incompressible as a desktop gets, 9.9 s at 50 Mbps: 64 385 bytes,
    /// 31.9 Mbps. The ceiling is a rate-control floor inside `nvenc.rs`, which
    /// this stage does not touch.
    ///
    /// So the rate is made up to the target with padding messages the browser
    /// counts and discards. It is synthetic and is reported as its own number,
    /// never folded into video goodput — but it is the only way this spike can
    /// answer the question the criterion actually asks, which is what str0m's
    /// SCTP sender does at 50 Mbps, not what NVENC does.
    load_bps: u64,
    load_started: Option<Instant>,
    padding: Vec<u8>,
    padding_messages: u64,
    padding_bytes: u64,
    video_channel: Option<ChannelId>,
    pending: VecDeque<PendingFrame>,
    /// The `avc1.*` / `hvc1.*` string the browser configures its decoder with,
    /// derived from the first in-band SPS rather than from what the encoder was
    /// asked for. `None` until an IRAP has been seen.
    codec_string: Option<String>,
    control_sent: bool,
    state: SinkState,
    buf: Vec<u8>,

    frames_queued: u64,
    frames_dropped_backpressure: u64,
    frames_dropped_no_channel: u64,
    fragments_written: u64,
    bytes_written: u64,
    /// `Channel::write()` → `Ok(false)`. The parent task's pass criterion is
    /// that this is zero in a 60 s 50 Mbps run.
    write_refusals: u64,
    /// Polls in which at least one write was refused, so a single stall is not
    /// read as hundreds of independent failures.
    polls_with_refusal: u64,
    write_errors: u64,
    max_buffered_bytes: usize,
    idr_requests: u64,
    /// Where the HTTP thread leaves an ICE restart for this thread to answer.
    /// See [`crate::sink::Reoffer`]; the mechanism is arm B's, verbatim.
    reoffer: Reoffer,
    offer_ufrags: Vec<String>,
    answer_ufrags: Vec<String>,
    reoffers_failed: u64,
}

impl DataChannelSink {
    pub fn bind(
        bind_addr: SocketAddr,
        codec: Codec,
        load_bps: u64,
        reoffer: Reoffer,
    ) -> Result<Self> {
        let socket =
            UdpSocket::bind(bind_addr).map_err(|e| format!("bind {bind_addr} for UDP: {e}"))?;
        let local_addr = socket.local_addr().map_err(|e| format!("local_addr: {e}"))?;

        // No codecs and no bandwidth estimator: this arm negotiates no media
        // line at all, so both would only be dead configuration in the answer.
        let rtc = RtcConfig::new().clear_codecs().build(Instant::now());

        let mut padding = vec![0u8; FRAGMENT_BYTES];
        padding[0] = KIND_PADDING;

        Ok(Self {
            rtc,
            socket,
            local_addr,
            codec,
            load_bps,
            load_started: None,
            padding,
            padding_messages: 0,
            padding_bytes: 0,
            video_channel: None,
            pending: VecDeque::new(),
            codec_string: None,
            control_sent: false,
            state: SinkState::Negotiating,
            buf: vec![0u8; 2048],
            frames_queued: 0,
            frames_dropped_backpressure: 0,
            frames_dropped_no_channel: 0,
            fragments_written: 0,
            bytes_written: 0,
            write_refusals: 0,
            polls_with_refusal: 0,
            write_errors: 0,
            max_buffered_bytes: 0,
            idr_requests: 0,
            reoffer,
            offer_ufrags: Vec::new(),
            answer_ufrags: Vec::new(),
            reoffers_failed: 0,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Everything the browser needs before the first fragment: which codec, and
    /// the exact `VideoDecoder` codec string read out of the bitstream. Sent
    /// once, immediately ahead of the first IRAP's fragments.
    /// Answer one browser offer, first or subsequent, recording both ufrags.
    /// Arm B's [`crate::sinks::rtp_track::RtpTrackSink::negotiate`] with the
    /// same reasoning: the local candidate is added once, and str0m keeps it
    /// across a remote-initiated ICE restart.
    fn negotiate(&mut self, offer: &str, first: bool) -> Result<String> {
        let parsed = SdpOffer::from_sdp_string(offer).map_err(|e| format!("parse offer: {e}"))?;
        if first {
            let candidate = Candidate::host(self.local_addr, "udp")
                .map_err(|e| format!("host candidate for {}: {e}", self.local_addr))?;
            if self.rtc.add_local_candidate(candidate).is_none() {
                return Err(format!(
                    "str0m rejected the host candidate for {}",
                    self.local_addr
                ));
            }
        }
        let answer = self
            .rtc
            .sdp_api()
            .accept_offer(parsed)
            .map_err(|e| format!("accept_offer: {e}"))?
            .to_sdp_string();
        if let Some(u) = ice_ufrag(offer) {
            self.offer_ufrags.push(u);
        }
        if let Some(u) = ice_ufrag(&answer) {
            self.answer_ufrags.push(u);
        }
        Ok(answer)
    }

    /// Drain an ICE restart parked by the HTTP thread, on the thread that owns
    /// the `Rtc`.
    fn handle_reoffer(&mut self) {
        let request = {
            let mut slot = self.reoffer.lock().unwrap_or_else(|e| e.into_inner());
            slot.request.take()
        };
        let Some(offer) = request else { return };
        let result = self.negotiate(&offer, false);
        if result.is_err() {
            self.reoffers_failed += 1;
        }
        self.reoffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .answer = Some(result);
    }

    fn control_record(&self) -> String {
        format!(
            "{{\"type\":\"config\",\"codec\":\"{}\",\"codecString\":{},\"fragmentBytes\":{},\
             \"commonHeaderBytes\":{},\"frameHeaderBytes\":{}}}",
            codec_name(self.codec),
            J::s(self.codec_string.clone().unwrap_or_default()).render(),
            FRAGMENT_BYTES,
            COMMON_HEADER_BYTES,
            FRAME_HEADER_BYTES
        )
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
            Event::ChannelOpen(id, label) => {
                if label == VIDEO_CHANNEL_LABEL {
                    self.video_channel = Some(id);
                }
                out.push(SinkEvent::Note(format!("data channel open: {label}")));
            }
            Event::ChannelClose(id) => {
                if self.video_channel == Some(id) {
                    self.video_channel = None;
                }
            }
            Event::ChannelData(data) if data.data == IDR_REQUEST => {
                self.idr_requests += 1;
                out.push(SinkEvent::KeyframeRequest);
            }
            _ => {}
        }
    }

    /// Push fragments until the channel refuses one or the backlog is empty.
    ///
    /// A refused fragment stays at the front of its frame: the reassembler on
    /// the other end keys on `frameId` and tolerates reordering, but it cannot
    /// invent a fragment that was never sent.
    fn drain(&mut self, now: Instant) {
        let Some(id) = self.video_channel else { return };
        let mut refused = false;

        if !self.control_sent && self.codec_string.is_some() {
            let record = self.control_record();
            let mut message = Vec::with_capacity(1 + record.len());
            message.push(KIND_CONTROL);
            message.extend_from_slice(record.as_bytes());
            match self.write_control(id, &message) {
                WriteOutcome::Accepted => self.control_sent = true,
                WriteOutcome::Refused => {
                    self.polls_with_refusal += 1;
                    return;
                }
                WriteOutcome::Failed => return,
            }
        }

        loop {
            // A frame whose fragments have all been written is gone. Done here
            // rather than after the write so a refusal leaves the backlog in a
            // state the next poll can resume from unchanged.
            while self
                .pending
                .front()
                .is_some_and(|f| f.fragments.is_empty())
            {
                self.pending.pop_front();
            }
            // The fragment is borrowed from `self.pending` and the channel from
            // `self.rtc`; two disjoint fields, so nothing has to be copied to
            // get a write out.
            let Some(fragment) = self.pending.front().and_then(|f| f.fragments.front()) else {
                break;
            };
            let Some(mut channel) = self.rtc.channel(id) else {
                break;
            };
            let buffered = channel.buffered_amount();
            if buffered > self.max_buffered_bytes {
                self.max_buffered_bytes = buffered;
            }
            match channel.write(true, fragment) {
                Ok(true) => {
                    self.fragments_written += 1;
                    self.bytes_written += fragment.len() as u64;
                    if let Some(front) = self.pending.front_mut() {
                        front.fragments.pop_front();
                    }
                }
                // The 128 KiB cap in `str0m/src/sctp/mod.rs:30`, reached.
                // Counted, never swallowed — it is the parent task's own pass
                // criterion, and `Ok(false)` is not an error, so a sender that
                // does not count it never learns it happened.
                Ok(false) => {
                    self.write_refusals += 1;
                    refused = true;
                    break;
                }
                Err(_) => {
                    self.write_errors += 1;
                    break;
                }
            }
        }

        if !refused {
            refused = self.top_up_load(id, now);
        }

        if refused {
            self.polls_with_refusal += 1;
        }
    }

    /// Make the channel's byte rate up to [`Self::load_bps`] with padding.
    ///
    /// Runs only after every real fragment has been offered, so video is never
    /// delayed behind synthetic bytes. Returns whether a write was refused.
    fn top_up_load(&mut self, id: ChannelId, now: Instant) -> bool {
        if self.load_bps == 0 {
            return false;
        }
        let started = *self.load_started.get_or_insert(now);
        let elapsed = now.saturating_duration_since(started).as_secs_f64();
        let owed_total = (elapsed * self.load_bps as f64 / 8.0) as u64;
        let sent = self.bytes_written + self.padding_bytes;
        let mut owed = owed_total.saturating_sub(sent);
        while owed >= FRAGMENT_BYTES as u64 {
            let Some(mut channel) = self.rtc.channel(id) else {
                return false;
            };
            let buffered = channel.buffered_amount();
            if buffered > self.max_buffered_bytes {
                self.max_buffered_bytes = buffered;
            }
            match channel.write(true, &self.padding) {
                Ok(true) => {
                    self.padding_messages += 1;
                    self.padding_bytes += FRAGMENT_BYTES as u64;
                    owed -= FRAGMENT_BYTES as u64;
                }
                Ok(false) => {
                    self.write_refusals += 1;
                    return true;
                }
                Err(_) => {
                    self.write_errors += 1;
                    return false;
                }
            }
        }
        false
    }

    /// One control-record write. Separate from [`Self::drain`]'s loop because
    /// the record is built as an owned `Vec` and so cannot be borrowed from a
    /// field the way a queued fragment can.
    fn write_control(&mut self, id: ChannelId, message: &[u8]) -> WriteOutcome {
        let Some(mut channel) = self.rtc.channel(id) else {
            return WriteOutcome::Failed;
        };
        match channel.write(true, message) {
            Ok(true) => WriteOutcome::Accepted,
            Ok(false) => {
                self.write_refusals += 1;
                WriteOutcome::Refused
            }
            Err(_) => {
                self.write_errors += 1;
                WriteOutcome::Failed
            }
        }
    }
}

enum WriteOutcome {
    Accepted,
    Refused,
    Failed,
}

fn codec_name(codec: Codec) -> &'static str {
    match codec {
        Codec::H264 => "h264",
        Codec::Hevc => "hevc",
    }
}

/// Build the frame header + fragments for one access unit.
///
/// Split out of `push_au` so the wire format can be unit tested without a
/// socket, a peer or a GPU.
fn fragment(au: &EncodedAu<'_>) -> VecDeque<Vec<u8>> {
    let mut body = Vec::with_capacity(FRAME_HEADER_BYTES + au.data.len());
    body.extend_from_slice(&(au.rtp_time_90k as u32).to_le_bytes());
    body.extend_from_slice(&(au.data.len() as u32).to_le_bytes());
    body.push(match au.codec {
        Codec::H264 => 0,
        Codec::Hevc => 1,
    });
    body.push(u8::from(au.is_irap));
    for stamp in [
        au.stamps.desktop_present,
        au.stamps.acquired,
        au.stamps.encode_submit,
        au.stamps.encode_done,
        au.stamps.enqueued,
        au.stamps.pushed,
    ] {
        body.extend_from_slice(&stamp.to_le_bytes());
    }
    body.extend_from_slice(au.data);

    let payload_bytes = FRAGMENT_BYTES - COMMON_HEADER_BYTES;
    let count = body.len().div_ceil(payload_bytes);
    let mut out = VecDeque::with_capacity(count);
    for (index, chunk) in body.chunks(payload_bytes).enumerate() {
        let mut flags = 0u8;
        if au.is_irap {
            flags |= FLAG_IRAP;
        }
        if index == 0 {
            flags |= FLAG_FIRST;
        }
        if index + 1 == count {
            flags |= FLAG_LAST;
        }
        let mut message = Vec::with_capacity(COMMON_HEADER_BYTES + chunk.len());
        message.push(KIND_FRAGMENT);
        message.push(flags);
        message.extend_from_slice(&(index as u16).to_le_bytes());
        message.extend_from_slice(&(count as u16).to_le_bytes());
        message.extend_from_slice(&(au.frame_id as u32).to_le_bytes());
        message.extend_from_slice(chunk);
        out.push_back(message);
    }
    out
}

/// The `VideoDecoder` codec string for an access unit that carries parameter
/// sets, or `None` if it does not carry them or they do not parse.
///
/// H.264 goes through the SPS parser the front half already uses. H.265 is read
/// here rather than in `nal.rs` because a codec string is a WebCodecs concern
/// and WebCodecs is arm A's and arm C's business, not the front half's.
fn codec_string(data: &[u8], codec: Codec) -> Option<String> {
    match codec {
        Codec::H264 => nal::parse_annexb(data, codec)
            .into_iter()
            .find(|n| n.ty == nal::H264_NAL_SPS)
            .and_then(|n| nal::parse_h264_sps(&data[n.start..n.end]))
            .map(|sps| sps.codec_string()),
        Codec::Hevc => nal::parse_annexb(data, codec)
            .into_iter()
            .find(|n| n.ty == nal::HEVC_NAL_SPS)
            .and_then(|n| hevc_codec_string(&data[n.start..n.end])),
    }
}

/// `hvc1.{profile_space}{profile_idc}.{compat}.{tier}{level}.{constraints}`,
/// ISO/IEC 14496-15:2024 §E.3 as the W3C HEVC WebCodecs registration requires.
///
/// Only the first `profile_tier_level()` is read, which is all the string
/// needs: two bytes of NAL header, then `sps_video_parameter_set_id` (4 bits),
/// `sps_max_sub_layers_minus1` (3) and `sps_temporal_id_nesting_flag` (1) put
/// the PTL at a byte boundary.
fn hevc_codec_string(payload: &[u8]) -> Option<String> {
    let data = nal::rbsp(payload.get(2..)?);
    // The first byte holds the two fields above; the PTL starts at byte 1.
    let ptl = data.get(1..13)?;
    let profile_space = ptl[0] >> 6;
    let tier = (ptl[0] >> 5) & 1;
    let profile_idc = ptl[0] & 0x1f;
    let compat = u32::from_be_bytes([ptl[1], ptl[2], ptl[3], ptl[4]]);
    let level_idc = ptl[11];

    let mut out = String::from("hvc1.");
    if profile_space > 0 {
        out.push((b'A' + profile_space - 1) as char);
    }
    out.push_str(&format!("{profile_idc}."));
    // The compatibility flags go out bit-reversed, per the registration.
    out.push_str(&format!("{:X}.", compat.reverse_bits()));
    out.push(if tier == 1 { 'H' } else { 'L' });
    out.push_str(&format!("{level_idc}"));
    // Six constraint bytes, trailing zero bytes omitted.
    let constraints = &ptl[5..11];
    let significant = constraints.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
    for byte in &constraints[..significant] {
        out.push_str(&format!(".{byte:X}"));
    }
    Some(out)
}

impl VideoSink for DataChannelSink {
    fn arm(&self) -> Arm {
        Arm::DataChannel
    }

    fn client_config(&self) -> J {
        J::Obj(vec![
            ("arm", J::s(Arm::DataChannel.as_str())),
            // The page's receiver registry keys off this: arm A owns its own
            // canvas, so unlike arm B it can read its pixels back per frame.
            ("present", J::s("canvas")),
            ("videoChannel", J::s(VIDEO_CHANNEL_LABEL)),
            ("fragmentBytes", J::Uint(FRAGMENT_BYTES as u64)),
            ("syntheticLoadBps", J::Uint(self.load_bps)),
            ("commonHeaderBytes", J::Uint(COMMON_HEADER_BYTES as u64)),
            ("frameHeaderBytes", J::Uint(FRAME_HEADER_BYTES as u64)),
            ("codec", J::s(codec_name(self.codec))),
            // Arm A has no media m-line, so no transport-wide-cc and no
            // bandwidth estimate. Said out loud in the run's own JSON.
            ("bwe", J::Bool(false)),
        ])
    }

    fn accept_offer(&mut self, offer: &str) -> Result<String> {
        self.negotiate(offer, true)
    }

    fn push_au(&mut self, au: &EncodedAu<'_>) -> Result<()> {
        if self.state != SinkState::Connected {
            return Ok(());
        }
        if self.video_channel.is_none() {
            self.frames_dropped_no_channel += 1;
            return Ok(());
        }
        if au.is_irap && self.codec_string.is_none() {
            self.codec_string = codec_string(au.data, au.codec);
        }
        if self.pending.len() >= MAX_PENDING_FRAMES {
            self.pending.pop_front();
            self.frames_dropped_backpressure += 1;
        }
        self.pending.push_back(PendingFrame {
            fragments: fragment(au),
            is_irap: au.is_irap,
        });
        self.frames_queued += 1;
        Ok(())
    }

    fn poll(&mut self, now: Instant, budget: Duration, events: &mut Vec<SinkEvent>) -> Result<()> {
        self.drain(now);
        self.handle_reoffer();

        let deadline = loop {
            match self
                .rtc
                .poll_output()
                .map_err(|e| format!("poll_output: {e}"))?
            {
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

        // The caller's budget, never str0m's own deadline: the same thread has
        // to notice the next access unit. Identical to arm B, deliberately —
        // the two arms must not differ in how promptly they are serviced.
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
            // A Windows UDP socket reports a previous send's ICMP
            // port-unreachable on the *next* receive; it is routine while ICE
            // is still probing and is not fatal.
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
            ("videoChannelOpen", J::Bool(self.video_channel.is_some())),
            ("framesQueued", J::Uint(self.frames_queued)),
            (
                "framesDroppedBackpressure",
                J::Uint(self.frames_dropped_backpressure),
            ),
            (
                "framesDroppedNoChannel",
                J::Uint(self.frames_dropped_no_channel),
            ),
            ("framesPending", J::Uint(self.pending.len() as u64)),
            (
                "irapPending",
                J::Uint(self.pending.iter().filter(|f| f.is_irap).count() as u64),
            ),
            ("fragmentsWritten", J::Uint(self.fragments_written)),
            ("bytesWritten", J::Uint(self.bytes_written)),
            ("syntheticLoadBps", J::Uint(self.load_bps)),
            ("paddingMessagesWritten", J::Uint(self.padding_messages)),
            ("paddingBytesWritten", J::Uint(self.padding_bytes)),
            (
                "iceOfferUfrags",
                J::Arr(self.offer_ufrags.iter().map(|u| J::s(u.as_str())).collect()),
            ),
            (
                "iceAnswerUfrags",
                J::Arr(self.answer_ufrags.iter().map(|u| J::s(u.as_str())).collect()),
            ),
            (
                "iceRestartsAccepted",
                J::Uint(self.answer_ufrags.len().saturating_sub(1) as u64),
            ),
            ("iceRestartsFailed", J::Uint(self.reoffers_failed)),
            // review-1 F1's criterion. Zero in a 60 s 50 Mbps run is the pass.
            ("writeRefusalsOkFalse", J::Uint(self.write_refusals)),
            ("pollsWithRefusal", J::Uint(self.polls_with_refusal)),
            ("writeErrors", J::Uint(self.write_errors)),
            (
                "maxBufferedAmountBytes",
                J::Uint(self.max_buffered_bytes as u64),
            ),
            (
                "str0mMaxBufferedAcrossStreamsReleased",
                J::Uint(crate::sinks::MAX_BUFFERED_ACROSS_STREAMS_RELEASED as u64),
            ),
            ("idrRequestsFromBrowser", J::Uint(self.idr_requests)),
            (
                "codecString",
                match &self.codec_string {
                    Some(s) => J::s(s.clone()),
                    None => J::s("not yet seen"),
                },
            ),
            ("controlRecordSent", J::Bool(self.control_sent)),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sink::HostStamps;

    fn au<'a>(data: &'a [u8], frame_id: u64, is_irap: bool) -> EncodedAu<'a> {
        EncodedAu {
            data,
            codec: Codec::H264,
            frame_id,
            rtp_time_90k: 90_000 + frame_id * 1500,
            is_irap,
            stamps: HostStamps {
                desktop_present: 111,
                acquired: 222,
                encode_submit: 333,
                encode_done: 444,
                enqueued: 555,
                pushed: 666,
            },
        }
    }

    /// The reassembler on the other end concatenates payloads and parses the
    /// frame header out of the front, so the header size is a contract between
    /// two files and is pinned here.
    #[test]
    fn the_frame_header_is_the_size_both_ends_agree_on() {
        assert_eq!(FRAME_HEADER_BYTES, 58);
        assert_eq!(COMMON_HEADER_BYTES, 10);
    }

    #[test]
    fn no_fragment_exceeds_one_sctp_data_chunk() {
        // review-1 F2: fragment at the SCTP payload size. A message over 1200
        // bytes is fragmented by SCTP itself, which is the unit partial
        // reliability then abandons.
        let data = vec![7u8; 100_000];
        let fragments = fragment(&au(&data, 42, false));
        assert!(fragments.iter().all(|f| f.len() <= FRAGMENT_BYTES));
        assert_eq!(fragments.iter().filter(|f| f.len() == FRAGMENT_BYTES).count(), fragments.len() - 1);
    }

    #[test]
    fn fragments_reassemble_to_the_header_plus_the_access_unit() {
        let data: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let fragments = fragment(&au(&data, 9, true));
        let count = fragments.len() as u16;
        let mut body = Vec::new();
        for (index, message) in fragments.iter().enumerate() {
            assert_eq!(message[0], KIND_FRAGMENT);
            assert_eq!(message[1] & FLAG_IRAP, FLAG_IRAP);
            assert_eq!(
                message[1] & FLAG_FIRST != 0,
                index == 0,
                "only the first fragment is flagged first"
            );
            assert_eq!(
                message[1] & FLAG_LAST != 0,
                index + 1 == fragments.len(),
                "only the last fragment is flagged last"
            );
            assert_eq!(u16::from_le_bytes([message[2], message[3]]), index as u16);
            assert_eq!(u16::from_le_bytes([message[4], message[5]]), count);
            assert_eq!(
                u32::from_le_bytes([message[6], message[7], message[8], message[9]]),
                9
            );
            body.extend_from_slice(&message[COMMON_HEADER_BYTES..]);
        }
        assert_eq!(body.len(), FRAME_HEADER_BYTES + data.len());
        assert_eq!(
            u32::from_le_bytes([body[0], body[1], body[2], body[3]]),
            90_000 + 9 * 1500
        );
        assert_eq!(
            u32::from_le_bytes([body[4], body[5], body[6], body[7]]) as usize,
            data.len()
        );
        assert_eq!(body[8], 0, "codec 0 is h264");
        assert_eq!(body[9], 1, "irap");
        assert_eq!(i64::from_le_bytes(body[10..18].try_into().unwrap()), 111);
        assert_eq!(i64::from_le_bytes(body[50..58].try_into().unwrap()), 666);
        assert_eq!(&body[FRAME_HEADER_BYTES..], &data[..]);
    }

    #[test]
    fn a_one_byte_access_unit_is_still_one_flagged_fragment() {
        let fragments = fragment(&au(&[0x65], 0, false));
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0][1] & (FLAG_FIRST | FLAG_LAST), FLAG_FIRST | FLAG_LAST);
    }

    #[test]
    fn the_h264_codec_string_comes_from_the_bitstream() {
        // The level-4.2 SPS spike 0.9 measurement 1 emitted with the VUI fix
        // on, byte for byte — the same fixture `capture.rs` pins its own SPS
        // reader against, so arm A's decoder configuration and the host's
        // report cannot disagree about what the encoder produced.
        let mut data = vec![0, 0, 0, 1];
        data.extend_from_slice(&[
            0x67, 0x64, 0x00, 0x2a, 0xac, 0x2b, 0x28, 0x0f, 0x00, 0x44, 0xfc, 0xb8, 0x08, 0x80,
            0x00, 0x01, 0xf4, 0x00, 0x00, 0xea, 0x60, 0x47, 0x8e, 0x15, 0x2c,
        ]);
        data.extend_from_slice(&[0, 0, 0, 1, 0x65, 0x88]);
        assert_eq!(
            codec_string(&data, Codec::H264).as_deref(),
            Some("avc1.64002a")
        );
    }

    #[test]
    fn an_access_unit_with_no_parameter_sets_yields_no_codec_string() {
        let data = vec![0, 0, 0, 1, 0x41, 0x9a, 0x00];
        assert_eq!(codec_string(&data, Codec::H264), None);
    }

    #[test]
    fn the_hevc_codec_string_is_the_main_profile_form_webcodecs_expects() {
        // NAL header for SPS (type 33), then sps_video_parameter_set_id +
        // max_sub_layers_minus1 + nesting = one byte, then profile_tier_level:
        // profile_space 0, tier 0, profile_idc 1; compatibility 0x60000000;
        // constraints B0 00 00 00 00 00; level_idc 93 (level 3.1).
        let mut payload = vec![0x42, 0x01, 0x01];
        payload.push(0x01); // profile_space 0, tier 0, profile_idc 1
        payload.extend_from_slice(&0x6000_0000u32.to_be_bytes());
        payload.extend_from_slice(&[0xB0, 0x00, 0x00, 0x00, 0x00, 0x00]);
        payload.push(93);
        let mut data = vec![0, 0, 0, 1];
        // The raw payload contains 00 00 00 runs, which a real encoder would
        // have escaped; escape them so the RBSP round trip is exercised.
        let mut escaped = Vec::new();
        let mut zeros = 0;
        for &b in &payload {
            if zeros >= 2 && b <= 3 {
                escaped.push(3);
                zeros = 0;
            }
            if b == 0 {
                zeros += 1;
            } else {
                zeros = 0;
            }
            escaped.push(b);
        }
        data.extend_from_slice(&escaped);
        assert_eq!(
            codec_string(&data, Codec::Hevc).as_deref(),
            Some("hvc1.1.6.L93.B0")
        );
    }

    #[test]
    fn the_backlog_is_bounded_in_whole_frames() {
        // 133 ms at 60 fps. A deeper queue turns a throughput problem into a
        // latency one and hides it from every figure in the run.
        assert_eq!(MAX_PENDING_FRAMES, 8);
    }

    /// Binds a loopback UDP socket.
    #[test]
    #[ignore]
    fn binds_and_describes_itself_as_arm_a() {
        let sink = DataChannelSink::bind(
            "127.0.0.1:0".parse().unwrap(),
            Codec::H264,
            0,
            crate::sink::Reoffer::default(),
        )
        .expect("bind");
        assert!(sink.local_addr().port() > 0);
        assert_eq!(sink.arm(), Arm::DataChannel);
        assert_eq!(sink.state(), SinkState::Negotiating);
        let cfg = sink.client_config().render();
        assert!(cfg.contains("\"arm\": \"a\""), "{cfg}");
        assert!(cfg.contains("\"present\": \"canvas\""), "{cfg}");
        assert!(cfg.contains("\"fragmentBytes\": 1200"), "{cfg}");
    }
}
