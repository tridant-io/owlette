//! The session loop: the `run` verb, end to end, for exactly one viewer.
//!
//! This is the assembly point. Every module below it is already written and
//! tested on its own; nothing here re-implements any of them, and where one of
//! them documents a call site (`Duplication::next_frame_with`,
//! `Governor::on_report`) this file is what that comment was written for.
//!
//! # Threads, and why there are four
//!
//! Desktop Duplication is vsync-locked and paces its own thread by blocking in
//! `AcquireNextFrame` (spike 0.8), str0m wants a thread that owns its socket,
//! `SendInput` reaches only the desktop its *calling thread* is attached to,
//! and a read on stdin blocks until the service writes. Those are four
//! different blocking disciplines, so they are four threads:
//!
//! - **session** (this thread) — the signaling socket, the peer connection, the
//!   governor, and every stdout event. The only writer of stdout.
//! - **capture** — duplication, the cursor observer, the downscaler and the
//!   encoder. Everything that touches a GPU texture stays here, because a
//!   `Frame` handle is only valid until the next acquire and `Duplication` is
//!   not `Send`. Encoded bytes leave over a bounded channel. It opens the
//!   duplication per pass rather than once, because the session pauses it.
//! - **input** — its own `DesktopWatcher` and the `SendInput` injector, plus
//!   the per-viewer held-key set. Injection is off the capture thread so a key
//!   press is not queued behind an 8 ms acquire and an 8 ms encode.
//! - **stdin** — control lines. EOF means the service is gone (§6).
//!
//! # The four `release_all` triggers (input/mod.rs)
//!
//! Stuck keys are the top user-visible bug of every remote-desktop product, so
//! all four are wired: **viewer disconnect** and **idle timeout** send
//! [`ToInput::ReleaseAll`] from here, **desktop switch** is noticed by the
//! input thread's own watcher and released there, and **viewer switch** cannot
//! happen in a session that admits one viewer — the second joiner is turned
//! away rather than swapped in (Task 8.1 owns multi-viewer).
//!
//! # Loss recovery, and the floor
//!
//! One keyframe per burst of requests ([`IdrPolicy`]): the window starts at
//! PROTOCOL.md §4's 250 ms, doubles to the 500 ms top of that range while the
//! keyframes are not fixing it, and resets on a quiet stream. The sticky
//! "awaiting" flag is what makes a burst *one* keyframe rather than one each —
//! a receiver that lost a frame asks once per record until an irap arrives.
//! Reference invalidation stays out of v1.
//!
//! The floor is the opposite problem: a still desktop produces no frames at all
//! (`DXGI_ERROR_WAIT_TIMEOUT`, and a genuinely idle output measured 0.28
//! frames/s) and a hardware decoder handed nothing stalls, so [`FloorTimer`]
//! hands the last picture to the encoder again every [`FLOOR_INTERVAL`].
//!
//! # Capture and the linger
//!
//! §6 keeps the process alive for about a minute after the last viewer leaves,
//! so a browser that reconnects does not pay for a respawn. The indicator is
//! down the moment that viewer goes, though, so [`CaptureGate`] closes the
//! duplication at the **departure** and the next admission opens the next one:
//! capture stops when the last viewer leaves, not when the process exits.
//!
//! # The clock
//!
//! §4's three stamps and `pong`'s `hostUs` are **microseconds since
//! `streamerEpoch`**, all four produced by [`HostClock`] from the same anchor.
//! The browser computes `clockOffsetUs = hostUs − viewerUs`
//! (`web/lib/swoop/feedback.ts`) and the governor undoes it with
//! `owd = tArrivalUs + clockOffsetUs − sendUs`, so the two have to share an
//! epoch or the governor inverts: it would cut on a healthy link and hold on a
//! congested one, with nothing failing.
//!
//! # Rotation
//!
//! Nothing in this pipeline rotates a frame — `gpu::scale` leaves the video
//! processor's rotation off and says so, and Task 6.4 owns applying it. The
//! browser therefore sees the **un-rotated texture**, so [`PointerSpace`] and
//! [`OutputGeometry`] are both built with the output's real rotation and the
//! rotation is applied in the coordinate transform instead of to the picture.
//! On a non-rotated monitor the two choices are identical, which is exactly why
//! it is written down here.
//!
//! # Hardware test (manual, `#[ignore]`d)
//!
//! The picture half — duplication, downscale, encoder — on this box's real
//! desktop, driven by the same capture thread the session spawns:
//!
//! ```text
//! cd agent/swoop
//! cargo test --lib session::host::tests::end_to_end_picture -- --ignored --nocapture
//! ```
//!
//! Expected on the dev box (RTX 2080 Ti, two monitors): `swoop capture:
//! (1920, 1080) -> (1920, 1080) hevc, 180 frames (1 irap, 3074722 bytes),
//! 227 cpos, 28 cshape` — three seconds at 60 fps, **exactly one** IRAP
//! (a second one means the startup rebuild came back), and a cursor stream
//! that answers the pointer moves the test injects.
//!
//! The pause and the floor have their own hardware test, which wants a still
//! desktop — its invocation and its expected line are on
//! `pause_closes_the_duplication_and_the_floor_holds_a_still_desktop`.
//!
//! # The whole `run` verb (manual, needs a room)
//!
//! The other half cannot be a unit test: it needs a bundle minted by the api
//! for this machine and a reachable signaling room, and the bundle is never
//! written to disk. With one on stdin:
//!
//! ```text
//! cd agent/swoop
//! cargo build --release
//! echo '<the bundle, one line>' | target/release/owlette-swoop.exe run
//! ```
//!
//! Expected: a `ready` line at once, then `viewer_joined` when a browser opens
//! the swoop page for this machine, then `status` every two seconds. Ctrl-C, or
//! `{"type":"kill"}` on stdin, ends it with `exiting` and code 0.

pub mod features;
pub mod quality;
pub mod tiers;

use std::time::{Duration, Instant};

use crate::bundle::Indicator;
use crate::encode::{Codec, CodecCaps};
use crate::gpu::scale::Limits;
use crate::ipc::{AudioState, Desktop, DisplayState, HostEventKind};
use crate::signal::messages::channel::{Channel, DisplayInfo};

/// A host feature that lives for the length of a session.
///
/// Implementations must not block — every one of them runs on the session
/// thread, between two turns of the loop that drives the peer. Whatever has to
/// block runs on the feature's own thread and reaches this one over a channel
/// the feature owns.
///
/// [`features`] documents the whole contract, including how a module is
/// registered; this is only the shape.
pub trait Feature: Send {
    /// Stable name. It is what the tests pin, so it is spelled the same as the
    /// module and the same as its entry in [`features::FEATURE_NAMES`].
    fn name(&self) -> &'static str;

    fn start(&mut self, session: &SessionHandle) -> anyhow::Result<()>;

    fn stop(&mut self);

    /// One inbound data-channel payload, offered to every feature.
    ///
    /// `ctl` is this host's own verdict for the viewer that sent it, from the
    /// token the host verified itself — never the room's claim. A feature that
    /// acts on a gated message checks it; `swoop-control` also carries
    /// ungated traffic (`quality`, `mute`), so the session cannot gate the
    /// whole channel on a feature's behalf.
    ///
    /// A payload this feature does not own is not an error — every feature is
    /// offered every payload, and §5 shares `swoop-control` between control
    /// and the clipboard. `Err` means the message *was* this feature's and it
    /// could not be honoured; it is logged and nothing else.
    fn on_message(
        &mut self,
        _channel: Channel,
        _ctl: bool,
        _payload: &[u8],
    ) -> anyhow::Result<()> {
        Ok(())
    }

    /// The feature's turn to produce outbound records. Called once per turn of
    /// the session loop while a viewer's peer is connected; the session drains
    /// the outbox and writes it.
    ///
    /// The outbox also carries [`FeatureRequest`]s — asking a worker thread to
    /// do something, or asking the service for a ctrl+alt+del. A feature that
    /// decides in [`Feature::on_message`] holds the decision itself and queues
    /// it here, one turn (2 ms) later.
    fn poll(&mut self, _now: Instant, _out: &mut Outbox) {}

    /// The answer to this feature's own [`FeatureRequest::Sas`], off stdin.
    ///
    /// Routed, not broadcast: the session remembers which feature asked and
    /// tells only that one. `ok` is false when the service could not raise the
    /// secure attention sequence at all.
    fn on_sas_result(&mut self, _ok: bool) {}

    /// This feature's contribution to §6's `status` event, filled in place.
    ///
    /// Pulled rather than pushed, because `status` is a snapshot on the
    /// session's own two-second cadence and a feature that had to push would
    /// need a clock of its own. Leave a field alone when there is nothing to
    /// say about it.
    ///
    /// `&mut self` and called **whether or not a viewer is connected**, unlike
    /// [`Feature::poll`]: a watcher thread's news arrives on the feature's own
    /// channel, and a headless machine or a locked desktop is exactly what the
    /// service wants reported while nobody is watching.
    fn status(&mut self, _out: &mut FeatureStatus) {}

    /// This feature's display list for §5's `hello-host`.
    ///
    /// `signal/messages.rs` is frozen, so a display list cannot arrive as a new
    /// host→viewer message: it rides the field that already exists. The first
    /// feature to return a non-empty list wins, and an empty one leaves the
    /// session's own single-display fallback in place.
    fn hello_displays(&mut self) -> Vec<DisplayInfo> {
        Vec::new()
    }
}

/// What the features contribute to one `status` event (§6).
///
/// One struct rather than three trait methods: every field is somebody's and
/// nobody's twice, and a feature that fills a field it does not own is a bug
/// the merge cannot see. A field left `None` is absent from the wire.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FeatureStatus {
    /// `securedesk`: the input desktop by name.
    pub desktop: Option<Desktop>,
    /// `audio`: the render endpoint.
    pub audio: Option<AudioState>,
    /// `displays`: whether this machine has a usable output at all.
    pub displays: Option<DisplayState>,
}

/// What a feature may ask the session to do on its behalf.
///
/// A feature owns no IO and holds no channel: the capture and input threads are
/// reached only from the session thread, which is the one place that knows
/// whether they are still there. Queued through [`Outbox::request`], drained
/// once per turn, and every hand-off to a worker is a `try_send` — a capture
/// thread inside a ten-second re-duplication must never hold the session up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeatureRequest {
    /// Ctrl+alt+del: the streamer asks, the **service** calls `SendSAS`, and
    /// the answer comes back to this feature's [`Feature::on_sas_result`].
    Sas,
    /// Capture this output instead, and move the pointer space with it. §5's
    /// absolute mouse coordinates are normalised to the selected display, so
    /// the two move together or the pointer lands on the wrong monitor.
    ///
    /// `index` is the one §5's `display` message and `hello-host`'s
    /// `displays[]` use — the feature's own numbering, which it resolves to an
    /// output itself.
    SelectOutput {
        index: u32,
        output: crate::capture::OutputInfo,
    },
    /// One row for `POST /api/agent/swoop/events`, by way of the service.
    Audit {
        kind: HostEventKind,
        reason: Option<String>,
    },
}

/// One outbound record from a feature.
///
/// No binary flag: §5's channel traffic is JSON text, and the one binary
/// channel — `swoop-meta` — carries the session's own frame records, which a
/// feature has no business interleaving with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outbound {
    pub channel: Channel,
    pub payload: Vec<u8>,
}

/// The most a feature may have waiting for the session at once.
///
/// Half the transport's own 64 KiB queue, so a `swoop-meta` record always fits
/// beside a feature's backlog. It is also the largest single record a feature
/// can send, and §5's biggest is a 16 KiB clipboard chunk — about 22 KiB once
/// it is base64 inside JSON, comfortably under this.
pub const OUTBOX_BURST_BYTES: usize = 32 * 1024;

/// How fast that allowance comes back: ~4 Mbps, a fifth of the default video
/// target. A 2 MiB clipboard image therefore takes a few seconds and never
/// competes with the picture for the link.
pub const OUTBOX_REFILL_BYTES_PER_SEC: usize = 512 * 1024;

/// A feature's whole outbound path: a bounded, paced buffer that the session
/// thread drains and writes.
///
/// Bounded, because the transport keeps at most 64 KiB queued across all five
/// channels and evicts the **oldest** record when that fills — so a feature
/// queueing without limit would throw away the `swoop-meta` records the
/// picture depends on. Paced as well as bounded, because the bound alone is
/// not enough: the session turns every 2 ms, and a feature handed a fresh
/// allowance every turn would still push megabytes a second down a link sized
/// for video.
///
/// **On overflow nothing is dropped.** [`send`](Self::send) returns `false`
/// and the record is not queued; the feature still holds its own data and
/// offers it again on a later poll. That is what a chunked transfer wants — a
/// silently dropped middle chunk is a corrupt paste, where a refused one is
/// just a slower paste.
#[derive(Debug)]
pub struct Outbox {
    queued: Vec<Outbound>,
    requests: Vec<FeatureRequest>,
    allowance: usize,
    refilled_at: Instant,
    refused: u64,
}

/// The most requests one feature may have waiting after a single poll.
///
/// Small on purpose: a request is an edge — a desktop moved, a display was
/// picked, a ctrl+alt+del was asked for — and a feature with eight of them
/// pending has stopped producing edges and started producing a queue.
pub const MAX_PENDING_REQUESTS: usize = 8;

impl Outbox {
    pub fn new(now: Instant) -> Self {
        Self {
            queued: Vec::new(),
            requests: Vec::new(),
            allowance: OUTBOX_BURST_BYTES,
            refilled_at: now,
            refused: 0,
        }
    }

    /// Ask the session to do something on this feature's behalf. `false` means
    /// the queue was full and the request was **not** taken — the same contract
    /// as [`send`](Self::send): nothing is dropped behind the feature's back,
    /// and it may offer the request again on a later poll.
    pub fn request(&mut self, request: FeatureRequest) -> bool {
        if self.requests.len() >= MAX_PENDING_REQUESTS {
            self.refused += 1;
            return false;
        }
        self.requests.push(request);
        true
    }

    /// Queue one record. `false` means it did not fit in what is left of the
    /// allowance — try again on a later poll.
    pub fn send(&mut self, channel: Channel, payload: Vec<u8>) -> bool {
        if payload.len() > self.allowance {
            self.refused += 1;
            return false;
        }
        self.allowance -= payload.len();
        self.queued.push(Outbound { channel, payload });
        true
    }

    /// Records refused for want of allowance, cumulative.
    pub fn refused(&self) -> u64 {
        self.refused
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.refilled_at);
        let gained = OUTBOX_REFILL_BYTES_PER_SEC as u128 * elapsed.as_nanos() / 1_000_000_000;
        // A turn too short to earn a whole byte keeps its remainder rather than
        // rounding it away: at 500 Hz that rounding would be the whole rate.
        if gained == 0 {
            return;
        }
        self.refilled_at = now;
        // Clamped before it is added: a long gap earns more than the burst
        // anyway, and the unclamped sum is an overflow on a 32-bit `usize`.
        let gained = gained.min(OUTBOX_BURST_BYTES as u128) as usize;
        self.allowance = (self.allowance + gained).min(OUTBOX_BURST_BYTES);
    }

    fn take(&mut self) -> Vec<Outbound> {
        std::mem::take(&mut self.queued)
    }

    /// Drained after **each** feature's poll, not after all of them: the
    /// session has to know which feature asked, and a `Sas` whose answer went
    /// to the wrong feature is a handshake that never completes.
    fn take_requests(&mut self) -> Vec<FeatureRequest> {
        std::mem::take(&mut self.requests)
    }
}

/// What a feature is handed when the session starts it.
///
/// The session's facts, not its channels: a feature runs on the session thread
/// and starts before any viewer has joined, so there is no peer to write to and
/// nothing it could hold across a turn of the loop. Channel traffic reaches a
/// feature later, through [`Feature::on_message`] and [`Feature::poll`].
#[derive(Debug, Clone)]
pub struct SessionHandle {
    pub sid: String,
    pub indicator: Indicator,
    /// §5's session floor for control, not a grant — a viewer's own `ctl` comes
    /// from its jwt.
    pub ctl: bool,
    /// The captured texture's size. The encoded size is not known until a
    /// viewer's offer has named a codec.
    pub source: (u32, u32),
}

/// §4: idr requests are coalesced by the host, so a browser may ask as often as
/// it likes. This is the bottom of PROTOCOL.md §4's 250–500 ms range.
pub const IDR_COOLDOWN: Duration = Duration::from_millis(250);

/// The top of that range, and where the backoff stops. A receiver in a loss
/// storm asks for a keyframe on every gap and each one costs about twenty delta
/// frames: answering every request is how a link that dropped one packet ends
/// up sending nothing but iraps.
pub const IDR_COOLDOWN_MAX: Duration = Duration::from_millis(500);

/// Quiet for this long and the window is back at [`IDR_COOLDOWN`]: the stream
/// recovered, and the next loss is a new event rather than a continuation.
const IDR_BACKOFF_RESET: Duration = Duration::from_secs(5);

/// How long the sticky "awaiting idr" state holds before the request is
/// presumed lost. The encoder answers on the next frame it is handed, and the
/// floor guarantees one every [`FLOOR_INTERVAL`] — so anything past this is a
/// request that died with the encoder it was sent to.
const IDR_AWAIT_DEADLINE: Duration = Duration::from_secs(1);

/// The loss-recovery policy: one keyframe per burst of requests, and a widening
/// window when the keyframes are not fixing it. Reference invalidation stays
/// out of v1 — this is the whole of it.
#[derive(Debug)]
pub struct IdrPolicy {
    cooldown: Duration,
    asked_at: Option<Instant>,
    /// Asked for, not yet seen on the wire. Sticky, because a receiver that
    /// dropped a frame asks once per record until the keyframe arrives.
    awaiting: bool,
    /// Keyframes actually forced, after the coalescing above. Reported on
    /// `status`: a session spending its link on iraps and one recovering from a
    /// single loss look identical from the bitrate alone.
    forced: u64,
}

impl IdrPolicy {
    pub fn new() -> Self {
        Self {
            cooldown: IDR_COOLDOWN,
            asked_at: None,
            awaiting: false,
            forced: 0,
        }
    }

    /// Answer one keyframe request. `true` means ask the encoder; `false` means
    /// the keyframe this request wants is already on its way.
    pub fn request(&mut self, now: Instant) -> bool {
        if let Some(asked) = self.asked_at {
            let since = now.saturating_duration_since(asked);
            if self.awaiting && since < IDR_AWAIT_DEADLINE {
                return false;
            }
            if since >= IDR_BACKOFF_RESET {
                self.cooldown = IDR_COOLDOWN;
            } else if since < self.cooldown {
                return false;
            } else {
                self.cooldown = (self.cooldown * 2).min(IDR_COOLDOWN_MAX);
            }
        }
        self.asked_at = Some(now);
        self.awaiting = true;
        self.forced += 1;
        true
    }

    /// An irap reached the wire, so the burst it answers is over.
    pub fn answered(&mut self) {
        self.awaiting = false;
    }

    /// Keyframes forced since the session started, cumulative.
    pub fn forced(&self) -> u64 {
        self.forced
    }
}

impl Default for IdrPolicy {
    fn default() -> Self {
        Self::new()
    }
}

/// The floor frame rate. A hardware decoder handed nothing at all stalls
/// (plan.md D5), and a static desktop produces nothing by design — Desktop
/// Duplication answers `DXGI_ERROR_WAIT_TIMEOUT` and the 0.8 box measured an
/// idle output at 0.28 frames/s. A repeat of a still picture is a few hundred
/// bytes, so 2 Hz costs nothing and is well inside every stall threshold.
pub const FLOOR_INTERVAL: Duration = Duration::from_millis(500);

/// When the last frame was handed to the encoder, and whether the floor is due.
#[derive(Debug)]
pub struct FloorTimer {
    last: Instant,
}

impl FloorTimer {
    pub fn new(now: Instant) -> Self {
        Self { last: now }
    }

    pub fn fed(&mut self, now: Instant) {
        self.last = now;
    }

    pub fn due(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.last) >= FLOOR_INTERVAL
    }
}

/// §5's control gate, host side: a viewer without `ctl` that sends something
/// gated is dropped and the attempt is reported — once per viewer, because the
/// attempt is as often a held key repeating at 30 Hz as a deliberate one.
#[derive(Debug, Default)]
pub struct Denials {
    reported: Option<String>,
    count: u64,
}

impl Denials {
    /// `true` the first time this viewer is refused, which is the attempt worth
    /// reporting.
    pub fn note(&mut self, viewer: &str) -> bool {
        self.count += 1;
        if self.reported.as_deref() == Some(viewer) {
            return false;
        }
        self.reported = Some(viewer.to_owned());
        true
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    /// A departure clears the report, so the next viewer's first attempt is its
    /// own event rather than a repeat of somebody else's.
    pub fn forget(&mut self) {
        self.reported = None;
    }
}

/// Capture runs only while somebody is watching.
///
/// §6 keeps the process alive for the linger after the last viewer leaves, but
/// a capture running behind a cleared indicator is exactly what the indicator
/// promises never happens — so the departure stops it, not the exit.
#[derive(Debug)]
pub struct CaptureGate {
    running: bool,
}

impl CaptureGate {
    /// The state the session starts in: the duplication is already open,
    /// because `ready` reports the size it found before the room is dialled.
    pub fn open() -> Self {
        Self { running: true }
    }

    /// `true` when the gate moved and the caller owes capture a command.
    pub fn set(&mut self, running: bool) -> bool {
        if self.running == running {
            return false;
        }
        self.running = running;
        true
    }
}

/// The wire spelling of a codec, which is **not** `Codec`'s serde spelling:
/// `web/lib/swoop/protocol.ts` and the `swoop-meta` header both say `hevc`,
/// and so do the golden pipe vectors.
pub fn codec_wire_name(codec: Codec) -> &'static str {
    match codec {
        Codec::H265 => "hevc",
        Codec::H264 => "h264",
    }
}

/// The codec for one viewer: the host's preference order, narrowed to what the
/// browser's offer actually carries.
///
/// A sniff of the offer rather than a capability message, because the offer is
/// the only statement of decoder support that arrives before the answer has to
/// name exactly one codec (`PeerConfig::codec`) — and an answer that named a
/// codec the browser did not offer would negotiate a payload type nothing can
/// decode.
pub fn pick_codec(offer_sdp: &str, available: &[Codec]) -> Option<Codec> {
    let offered = offer_sdp.to_ascii_lowercase();
    // `Codec`'s declaration order is plan.md D5's preference order.
    for codec in [Codec::H265, Codec::H264] {
        if !available.contains(&codec) {
            continue;
        }
        let token = match codec {
            Codec::H265 => "h265",
            Codec::H264 => "h264",
        };
        if offered.contains(token) {
            return Some(codec);
        }
    }
    None
}

/// This backend's ceiling for one codec. Both axes independently, because NVENC
/// allows 4096 for H.264 and 8192 for HEVC while AMF caps both at 4096.
pub fn limits_for(caps: &[CodecCaps], codec: Codec) -> Option<Limits> {
    caps.iter().find(|c| c.codec == codec).map(|c| Limits {
        max_width: c.max_width,
        max_height: c.max_height,
    })
}

#[cfg(windows)]
pub use host::run;

#[cfg(windows)]
mod host {
    use std::io::{self, BufRead};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError};
    use windows::Win32::System::Performance::QueryPerformanceCounter;

    use super::{
        codec_wire_name, limits_for, pick_codec, CaptureGate, Denials, Feature, FeatureRequest,
        FeatureStatus, FloorTimer, IdrPolicy, Outbox, SessionHandle,
    };
    use crate::bundle::{Bundle, Indicator, TimeAnchor, TokenError};
    use crate::capture::{
        self, DesktopWatcher, Duplication, OutputInfo, RebuildSignal, Source, ACQUIRE_TIMEOUT_MS,
    };
    use crate::cursor::{self, CursorTracker, OutputGeometry, PointerReader};
    use crate::encode::{
        select, BackendCaps, Codec, CodecCaps, EncodedFrame, Encoder, EncoderConfig,
    };
    use crate::gpu::scale::{self, Downscaler, Plan};
    use crate::gpu::Frame;
    use crate::input::{Injector, PointerSpace, SendInputInjector, ViewerInput};
    use crate::ipc::{
        self, Control, Event, Exit, ExitReason, GovernorPhase, HostEventKind, LeftReason, MediaPath,
    };
    use crate::signal::client::{Effect, SignalTransport};
    use crate::signal::messages::channel::{
        self, Channel, Control as ControlMessage, Feedback, Input as InputMessage,
    };
    use crate::signal::messages::Message;
    use crate::signal::{
        Denial, DenialReason, Handshake, Reaction, RetryPolicy, RoomSocket, SignalClient,
    };
    use crate::transport::framing::{flags, FrameCodec, FrameHeader, FrameSequencer, FrameStamps};
    use crate::transport::governor::{Governor, GovernorConfig, GovernorState};
    use crate::transport::ice_policy::{
        admit_remote, ifwatch::InterfaceWatcher, Admission, DropReason, IceAction, IceEvent,
        IcePolicy, SystemResolver,
    };
    use crate::transport::rtc::{qpc_hz, PeerConfig, PeerEvent, PeerState, RtcPeer};
    use crate::transport::VideoSink;
    use crate::viewers::lease::LeaseLedger;

    use super::quality::Ceiling;

    /// §6: the streamer lingers about a minute after the last viewer leaves,
    /// then exits 0. The same timer covers a session nobody ever joins.
    const LINGER: Duration = Duration::from_secs(60);

    /// One turn of the session loop. It is the peer's socket-read timeout, so
    /// it is also the worst case an encoded frame waits in the channel before
    /// it is sent — small enough not to matter next to an 8 ms acquire, large
    /// enough that an idle session is not a spin.
    const TICK: Duration = Duration::from_millis(2);

    /// How often the governor evaluates. The viewer reports `fb` at 2 Hz and
    /// `stats` at 1 Hz, so anything faster only re-reads the same window.
    const REPORT_INTERVAL: Duration = Duration::from_millis(500);

    /// How often the `status` event goes to the service.
    const STATUS_INTERVAL: Duration = Duration::from_secs(2);

    /// The starting CBR target, until the quality menu (Task 6.5) can move it.
    /// 20 Mbps is what the bake-off measured arm B at end to end.
    const DEFAULT_BITRATE_BPS: u32 = 20_000_000;

    /// Desktop Duplication is vsync-locked at the panel's rate; 60 is what the
    /// encoder's rate control is sized for.
    const TARGET_FPS: u32 = 60;

    /// Capture → session, and it is bounded because the whole point is that a
    /// session thread which fell behind drops a frame rather than stalling
    /// capture for it. Sized for the cursor messages, which outnumber frames:
    /// the session drains the channel every [`TICK`], so a frame that cannot
    /// get in means the session is already in trouble — and the next frame is
    /// then an IRAP, so the gap cannot dangle.
    const WORKER_QUEUE: usize = 64;

    /// How long to wait for the capture thread's first word. Its own
    /// re-duplication deadline is 10 s, so this only has to outlast that.
    const CAPTURE_OPEN_TIMEOUT: Duration = Duration::from_secs(15);

    // ------------------------------------------------------------- clock ---

    fn qpc_now() -> i64 {
        let mut ticks = 0i64;
        // SAFETY: writes one i64. QueryPerformanceCounter cannot fail on any
        // Windows this binary runs on, and a zero is a timestamp, not a crash.
        let _ = unsafe { QueryPerformanceCounter(&mut ticks) };
        ticks
    }

    /// QPC ticks → §4's microseconds since `streamerEpoch`.
    ///
    /// The base is read once from the bundle's time anchor, so it carries the
    /// api's clock and never the kiosk's. A second of error in it is a constant
    /// bias shared by every stamp and by `pong`, which is precisely what both
    /// consumers cancel out: the governor subtracts against a window minimum
    /// and the browser subtracts `hostUs − viewerUs`.
    #[derive(Debug, Clone, Copy)]
    struct HostClock {
        hz: i64,
        base_qpc: i64,
        base_us: i64,
    }

    impl HostClock {
        fn new(hz: i64, anchor: TimeAnchor, streamer_epoch: i64) -> Self {
            Self {
                hz: hz.max(1),
                base_qpc: qpc_now(),
                base_us: anchor
                    .now_unix()
                    .saturating_mul(1_000_000)
                    .saturating_sub(streamer_epoch)
                    .max(0),
            }
        }

        fn us(&self, qpc: i64) -> u64 {
            let delta = i128::from(qpc.saturating_sub(self.base_qpc));
            let us = i128::from(self.base_us) + delta * 1_000_000 / i128::from(self.hz);
            us.clamp(0, i128::from(u64::MAX)) as u64
        }

        fn now_us(&self) -> u64 {
            self.us(qpc_now())
        }
    }

    // ---------------------------------------------------------- messages ---

    /// Capture and input → session.
    enum FromWorker {
        /// The duplication is open. Carries the un-rotated texture size, which
        /// is what the encoder and the browser are sized from.
        Opened { width: u32, height: u32 },
        /// Capture or encode could not start at all.
        Failed(Exit),
        Frame(Box<EncodedFrame>),
        Cursor(channel::Cursor),
        /// The source's texture size changed under a rebuild; the session
        /// re-plans and re-sends [`ToCapture::Encode`].
        SourceSize { width: u32, height: u32 },
        /// Which backend the selection chain actually opened on. Sent when it
        /// changes, which on a machine with one compiled backend is once.
        Backend(&'static str),
        /// The rate limit on one viewer's input, cumulative.
        InputDropped(u64),
    }

    /// Session → capture.
    enum ToCapture {
        /// Open (or re-open) the encoder. A codec, a target size or a device
        /// change is a **new encoder**, never a reconfigure.
        Encode {
            codec: Codec,
            width: u32,
            height: u32,
        },
        Idr,
        Bitrate(u32),
        /// Feed the encoder at most this many frames a second — the ladder's
        /// frame-rate half. `EncoderConfig::fps` sizes rate control and drops
        /// nothing, so the drop has to happen where the frames are.
        Fps(u32),
        /// Re-send the pointer whole. A viewer that has just arrived has an
        /// empty shape cache, and the tracker only emits on a change.
        CursorSnapshot,
        /// Duplicate this output instead. The duplication, the encoder and the
        /// scaler are all pinned to the old one, so this ends the pass rather
        /// than being applied inside it.
        Output(OutputInfo),
        /// The last viewer left: close the duplication until one comes back.
        /// Not a stop — §6's linger keeps the process alive, and the next
        /// viewer arrives on the same threads.
        Pause,
        Resume,
        Stop,
    }

    /// Session → input.
    enum ToInput {
        Message(Box<InputMessage>),
        /// Normalise absolute coordinates against this display instead, after
        /// a capture retarget.
        Space(PointerSpace),
        ReleaseAll,
        Stop,
    }

    /// Service → session, off stdin.
    enum FromService {
        Control(Control),
        /// EOF: §6 says the service is gone and the streamer exits 0.
        Eof,
    }

    /// Session → the candidate resolver.
    ///
    /// **Every** remote candidate goes through it, not only the `.local` ones:
    /// `admit_remote` is the one place the admission rules live, and deciding
    /// here which ones need a resolver would be a second copy of them. The cost
    /// is one turn — 2 ms — on a candidate that did not need resolving.
    struct ToResolver {
        viewer: String,
        candidate: String,
    }

    /// The resolver's answer: the attribute to hand the ICE agent — rewritten
    /// when the name resolved — or why it is not being handed one.
    struct FromResolver {
        viewer: String,
        admitted: Result<String, DropReason>,
    }

    // ------------------------------------------------------------- entry ---

    /// The `run` verb. `stdin` is the reader line 1 was taken from — the same
    /// one, because a fresh reader would lose whatever it had already buffered.
    pub fn run(bundle: Bundle, stdin: impl BufRead + Send + 'static) -> Exit {
        let sid = bundle.sid.clone();
        let (exit, reason) = drive(bundle, stdin);
        ::log::info!("swoop: exiting {} ({reason:?})", exit.code());
        let _ = ipc::emit(
            &mut io::stdout(),
            &Event::Exiting {
                sid,
                code: exit.code(),
                reason,
            },
        );
        exit
    }

    fn drive(bundle: Bundle, stdin: impl BufRead + Send + 'static) -> (Exit, ExitReason) {
        let started = Instant::now();
        let hz = match qpc_hz() {
            Ok(hz) => hz,
            Err(e) => {
                ::log::error!("swoop: no performance counter: {e}");
                return (Exit::Internal, ExitReason::Error);
            }
        };
        let clock = HostClock::new(hz, bundle.time_anchor(), bundle.streamer_epoch);

        // The test-only hook, which only a `testhooks` build parses at all.
        #[cfg(feature = "testhooks")]
        if let Some(exit) = refuse_unbuilt_overrides(bundle.overrides.as_ref()) {
            return (exit, ExitReason::Error);
        }

        // Locally before the network: a box that cannot capture or encode
        // should say so with 12 or 13 rather than after a room round trip.
        let outputs = match capture::enumerate_outputs() {
            Ok(outputs) if !outputs.is_empty() => outputs,
            Ok(_) => {
                ::log::error!("swoop: no attached output to duplicate");
                return (Exit::NoCaptureSource, ExitReason::Error);
            }
            Err(e) => {
                ::log::error!("swoop: could not enumerate outputs: {e}");
                return (Exit::NoCaptureSource, ExitReason::Error);
            }
        };
        let displays = outputs.len() as u32;
        let output = primary(&outputs).clone();

        // Probed once, here, and then carried: NVENC's `probe` opens encode
        // sessions until the driver refuses in order to count them, and the
        // capture thread opens a new encoder on every resolution rung, every
        // retarget and every ACCESS_LOST recovery.
        let caps = select::probe_all();
        let codec_caps: Vec<CodecCaps> = caps
            .iter()
            .flat_map(|backend| backend.codecs.iter().cloned())
            .collect();
        let codecs: Vec<Codec> = codec_caps.iter().map(|c| c.codec).collect();
        if codecs.is_empty() {
            ::log::error!("swoop: no encoder backend on this machine");
            return (Exit::NoEncoder, ExitReason::Error);
        }

        let stop = Arc::new(AtomicBool::new(false));
        let (worker_tx, worker_rx) = bounded::<FromWorker>(WORKER_QUEUE);
        let (capture_tx, capture_rx) = bounded::<ToCapture>(8);
        let (input_tx, input_rx) = bounded::<ToInput>(256);
        let (service_tx, service_rx) = bounded::<FromService>(8);
        let (resolver_tx, resolver_work) = bounded::<ToResolver>(32);
        let (resolved_tx, resolved_rx) = bounded::<FromResolver>(32);

        let spawned = {
            let tx = worker_tx.clone();
            let stop = Arc::clone(&stop);
            let output = output.clone();
            thread::Builder::new()
                .name("swoop-capture".into())
                .spawn(move || capture_thread(output, caps, clock, tx, capture_rx, stop))
        };
        let capture_handle = match spawned {
            Ok(handle) => handle,
            Err(e) => {
                ::log::error!("swoop: could not start the capture thread: {e}");
                return (Exit::Internal, ExitReason::Error);
            }
        };

        // The texture size, which on a rotated output is not the mode's. This
        // is also the last thing that can produce exit 12 or 13, so `ready`
        // goes out once it has arrived and **before** the room is dialled: a
        // machine whose relay is down should still tell the service what it can
        // do, and the failure it then reports is 14 and nothing else.
        let source = match worker_rx.recv_timeout(CAPTURE_OPEN_TIMEOUT) {
            Ok(FromWorker::Opened { width, height }) => (width, height),
            Ok(FromWorker::Failed(exit)) => {
                stop.store(true, Ordering::Relaxed);
                let _ = capture_handle.join();
                return (exit, ExitReason::Error);
            }
            _ => {
                ::log::error!("swoop: capture did not open within {CAPTURE_OPEN_TIMEOUT:?}");
                stop.store(true, Ordering::Relaxed);
                return (Exit::NoCaptureSource, ExitReason::Error);
            }
        };

        // The browser sees the un-rotated texture — nothing in this pipeline
        // rotates a frame — so the pointer space carries the output's real
        // rotation and applies it in the transform instead.
        let _ = ipc::emit(
            &mut io::stdout(),
            &Event::Ready {
                sid: bundle.sid.clone(),
                pid: std::process::id(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
                protocol_version: crate::bundle::SWOOP_PROTOCOL_VERSION,
                codecs: codecs.iter().map(|c| codec_wire_name(*c).to_owned()).collect(),
                displays,
            },
        );

        let input_handle = {
            let tx = worker_tx;
            let stop = Arc::clone(&stop);
            let space = PointerSpace::from_output(&output);
            thread::Builder::new()
                .name("swoop-input".into())
                .spawn(move || input_thread(space, tx, input_rx, stop))
                .ok()
        };

        thread::Builder::new()
            .name("swoop-stdin".into())
            .spawn(move || stdin_thread(stdin, service_tx))
            .ok();

        // Detached like the stdin thread, and for the same reason: it ends when
        // its channel closes, and what it is blocked in is a resolver call the
        // process exit takes with it.
        thread::Builder::new()
            .name("swoop-resolver".into())
            .spawn(move || resolver_thread(resolver_work, resolved_tx))
            .ok();

        let outcome = connect_and_serve(
            &bundle,
            Wiring {
                clock,
                started,
                source,
                codecs,
                codec_caps,
                worker_rx,
                capture_tx: capture_tx.clone(),
                input_tx: input_tx.clone(),
                service_rx,
                resolver_tx,
                resolved_rx,
            },
        );

        let _ = capture_tx.send(ToCapture::Stop);
        let _ = input_tx.send(ToInput::Stop);
        stop.store(true, Ordering::Relaxed);
        let _ = capture_handle.join();
        if let Some(handle) = input_handle {
            let _ = handle.join();
        }
        outcome
    }

    /// The bundle's `overrides` names a test source and a test encoder, and
    /// both are still stubs — Task 8.7 fills `capture::testpattern` and Task 7.2
    /// fills `encode::soft`. Until they exist there is nothing to select, and
    /// quietly streaming the real desktop instead is how a ci run that proved
    /// nothing looks like one that passed. The names are fixed vocabulary, not
    /// bundle secrets, so they may be logged.
    #[cfg(feature = "testhooks")]
    fn refuse_unbuilt_overrides(overrides: Option<&crate::bundle::Overrides>) -> Option<Exit> {
        let overrides = overrides?;
        if let Some(source) = overrides.source.as_deref() {
            ::log::error!("swoop: override source {source:?} is not built yet (task 8.7)");
            return Some(Exit::NoCaptureSource);
        }
        if let Some(encoder) = overrides.encoder.as_deref() {
            ::log::error!("swoop: override encoder {encoder:?} is not built yet (task 7.2)");
            return Some(Exit::NoEncoder);
        }
        None
    }

    /// §6's `status.testOverride`, as one short string. The names are fixed
    /// vocabulary, not bundle secrets, so they may be reported.
    #[cfg(feature = "testhooks")]
    fn describe_override(bundle: &Bundle) -> Option<String> {
        let overrides = bundle.overrides.as_ref()?;
        let mut parts = Vec::new();
        if let Some(source) = overrides.source.as_deref() {
            parts.push(format!("source={source}"));
        }
        if let Some(encoder) = overrides.encoder.as_deref() {
            parts.push(format!("encoder={encoder}"));
        }
        (!parts.is_empty()).then(|| parts.join(" "))
    }

    /// A release build does not parse `overrides` at all — it exits 10 on a
    /// bundle carrying one — so there is never anything to name.
    #[cfg(not(feature = "testhooks"))]
    fn describe_override(_bundle: &Bundle) -> Option<String> {
        None
    }

    /// The streamer's refusal vocabulary, narrowed to the audit route's.
    ///
    /// `DenialReason` is the finer of the two and stays that way — it is the
    /// `reason` code on the event. This is the one place the two are joined,
    /// so a reason added over there cannot quietly become a 400 here.
    fn host_event_kind(reason: DenialReason) -> HostEventKind {
        match reason {
            DenialReason::TooManyViewers
            | DenialReason::JoinTooSoon
            | DenialReason::JoinRateExceeded => HostEventKind::JoinRefused,
            DenialReason::OfferFingerprintMissing => HostEventKind::FpMismatch,
            DenialReason::UnknownViewer | DenialReason::ViewerMismatch => {
                HostEventKind::JwtRejected
            }
            DenialReason::Token(TokenError::FpMissing | TokenError::FpMismatch) => {
                HostEventKind::FpMismatch
            }
            // §10: the connect token *is* the first lease, so an expired one is
            // a lease that lapsed and not a token that was forged.
            DenialReason::Token(TokenError::Expired) => HostEventKind::LeaseExpired,
            DenialReason::Token(_) => HostEventKind::JwtRejected,
        }
    }

    /// The governor's state word, in the spelling §6's `status` uses. The two
    /// vocabularies are joined here and nowhere else, so a state added over
    /// there cannot quietly go unreported.
    fn governor_phase(state: GovernorState) -> GovernorPhase {
        match state {
            GovernorState::Ceiling => GovernorPhase::Ceiling,
            GovernorState::Holding => GovernorPhase::Holding,
            GovernorState::Climbing => GovernorPhase::Climbing,
            GovernorState::Pinned => GovernorPhase::Pinned,
        }
    }

    /// Everything the session loop was handed rather than built.
    struct Wiring {
        clock: HostClock,
        started: Instant,
        source: (u32, u32),
        codecs: Vec<Codec>,
        codec_caps: Vec<CodecCaps>,
        worker_rx: Receiver<FromWorker>,
        capture_tx: Sender<ToCapture>,
        input_tx: Sender<ToInput>,
        service_rx: Receiver<FromService>,
        resolver_tx: Sender<ToResolver>,
        resolved_rx: Receiver<FromResolver>,
    }

    fn connect_and_serve(bundle: &Bundle, w: Wiring) -> (Exit, ExitReason) {
        let handshake = match Handshake::new(bundle) {
            Ok(handshake) => handshake,
            Err(e) => {
                // The bundle parsed; its `signalUrl` is simply not this room's.
                // There is nothing to dial, which is what 14 means.
                ::log::error!("swoop: cannot dial the room: {e}");
                return (Exit::SignalingUnreachable, ExitReason::Error);
            }
        };

        let policy = RetryPolicy::default();
        let mut attempt = 0u32;
        let socket = loop {
            if attempt > 0 {
                thread::sleep(policy.delay(attempt, rand::random::<f64>()));
            }
            match RoomSocket::dial(&handshake) {
                Ok(socket) => break socket,
                Err(e) => {
                    // The distinction is the point: only the three auth words
                    // buy a re-mint, and the streamer holds no credential to
                    // re-mint with — so it names the reason and exits, and the
                    // agent respawns it with a fresh bundle.
                    if let Reaction::Remint(signal) = e.reaction() {
                        ::log::error!("swoop: the room refused this bundle ({signal})");
                        return (policy.exit(), ExitReason::Error);
                    }
                    attempt += 1;
                    ::log::warn!("swoop: dial attempt {attempt} failed ({e})");
                    if policy.exhausted(attempt) {
                        return (policy.exit(), ExitReason::Error);
                    }
                }
            }
        };

        let client = match SignalClient::from_bundle(bundle) {
            Ok(client) => client,
            Err(e) => {
                ::log::error!("swoop: bundle refused by the signaling client: {}", e.reason());
                return (Exit::BundleInvalid, ExitReason::Error);
            }
        };

        let mut live = Live {
            sid: bundle.sid.clone(),
            indicator: bundle.indicator,
            streamer_epoch: bundle.streamer_epoch,
            session_cap: Duration::from_secs(bundle.enablement.session_cap_seconds),
            client,
            socket,
            out: io::stdout(),
            peer: None,
            viewer: None,
            clock: w.clock,
            started: w.started,
            source: w.source,
            encoded: w.source,
            codecs: w.codecs,
            codec_caps: w.codec_caps,
            governor: Governor::new(GovernorConfig::new(DEFAULT_BITRATE_BPS)),
            leases: LeaseLedger::from_bundle(bundle),
            sequencer: FrameSequencer::new(),
            capture_tx: w.capture_tx,
            input_tx: w.input_tx,
            worker_rx: w.worker_rx,
            service_rx: w.service_rx,
            resolver_tx: w.resolver_tx,
            resolved_rx: w.resolved_rx,
            ice: IcePolicy::new(),
            ifwatch: match InterfaceWatcher::start() {
                Ok(watcher) => Some(watcher),
                Err(rc) => {
                    ::log::warn!("swoop: no interface-change notifications (win32 {rc})");
                    None
                }
            },
            bind_addr: local_bind_addr(),
            idle_since: Some(w.started),
            idr: IdrPolicy::new(),
            capture: CaptureGate::open(),
            denials: Denials::default(),
            last_report: w.started,
            last_status: w.started,
            frames_at_status: 0,
            input_dropped: 0,
            encoder: None,
            last_size: None,
            display: 0,
            sas_pending: None,
            test_override: describe_override(bundle),
            features: Vec::new(),
            outbox: Outbox::new(w.started),
        };

        // The browser offers as soon as it is in the room, and the relay drops
        // an offer sent into a room with no host. `host-ready` is the nudge
        // that makes it re-send the one it has (`web/lib/swoop/peer.ts`).
        let ready = live.client.host_ready(None);
        live.send(&ready);

        let handle = SessionHandle {
            sid: bundle.sid.clone(),
            indicator: bundle.indicator,
            ctl: bundle.ctl,
            source: live.source,
        };
        // They live on `Live` because the loop hands them the channel traffic
        // and drains what they produce; a feature that fails to start stays
        // registered, so its name still appears and its `stop` still runs.
        let mut features = super::features::registry();
        for feature in features.iter_mut() {
            if let Err(e) = feature.start(&handle) {
                ::log::warn!("swoop: feature {} did not start: {e}", feature.name());
            }
        }
        live.features = features;
        let outcome = live.serve();
        for feature in live.features.iter_mut().rev() {
            feature.stop();
        }
        outcome
    }

    // -------------------------------------------------------------- live ---

    /// What the session thread owns.
    struct Live {
        sid: String,
        indicator: Indicator,
        /// §7's unix microseconds, echoed to the browser in `hello-host`. Not
        /// the same number as [`HostClock::base_us`], which is an offset from it.
        streamer_epoch: i64,
        session_cap: Duration,
        client: SignalClient,
        socket: RoomSocket,
        out: io::Stdout,
        peer: Option<RtcPeer>,
        viewer: Option<Viewer>,
        clock: HostClock,
        started: Instant,
        /// The captured texture's size.
        source: (u32, u32),
        /// What the encoder actually emits, after `gpu::scale::plan`.
        encoded: (u32, u32),
        codecs: Vec<Codec>,
        codec_caps: Vec<CodecCaps>,
        governor: Governor,
        /// §10's lease per viewer: when it lapses, in the bundle's own time
        /// base. `viewers/lease.rs` does the bookkeeping; `sweep_leases` is
        /// what this session owes a lease that did.
        leases: LeaseLedger,
        sequencer: FrameSequencer,
        capture_tx: Sender<ToCapture>,
        input_tx: Sender<ToInput>,
        worker_rx: Receiver<FromWorker>,
        service_rx: Receiver<FromService>,
        resolver_tx: Sender<ToResolver>,
        resolved_rx: Receiver<FromResolver>,
        /// §7.5's ICE decisions. Fed the peer's edges and polled once a turn;
        /// it owns no clock and no socket, so `now` is this thread's.
        ice: IcePolicy,
        /// `NotifyIpInterfaceChange`, as a flag this loop reads. A machine that
        /// would not let us register carries on without the trigger rather than
        /// failing the session.
        ifwatch: Option<InterfaceWatcher>,
        bind_addr: SocketAddr,
        idle_since: Option<Instant>,
        idr: IdrPolicy,
        capture: CaptureGate,
        denials: Denials,
        last_report: Instant,
        last_status: Instant,
        frames_at_status: u64,
        input_dropped: u64,
        /// The backend the capture thread's encoder is open on, as the
        /// selection chain named it. `None` until the first encoder opens —
        /// a session with no viewer has no encoder and nothing to report.
        encoder: Option<&'static str>,
        /// The last encoded size put on the wire, so a change sets
        /// `RESOLUTION_CHANGED` exactly once.
        last_size: Option<(u16, u16)>,
        /// Which output is being captured, in the numbering `hello-host`
        /// advertises. Zero until a feature picks another one.
        display: u32,
        /// The feature whose [`FeatureRequest::Sas`] is outstanding, by name.
        /// `sas_result` goes to it and to nothing else.
        sas_pending: Option<&'static str>,
        /// The bundle's test-only `overrides`, named on every `status`. Always
        /// `None` on a release build, and on a `testhooks` build until the
        /// override backends exist (Tasks 7.2 and 8.7) — `drive` refuses a
        /// bundle that names one until then, so the session never starts.
        test_override: Option<String>,
        features: Vec<Box<dyn Feature>>,
        /// What the features produced this turn, bounded and paced so a
        /// clipboard transfer cannot evict the picture's records.
        outbox: Outbox,
    }

    /// One viewer, as the session knows it.
    struct Viewer {
        id: String,
        /// The host's own verdict, from the token it verified itself. False
        /// until the `lease` frame arrives — the room's word is not enough.
        ctl: bool,
        codec: Codec,
        announced: bool,
        hello_sent: bool,
    }

    impl Live {
        fn emit(&mut self, event: &Event) {
            if let Err(e) = ipc::emit(&mut self.out, event) {
                // A half-written line desynchronises the service's reader, and
                // a broken pipe means the service is already gone.
                ::log::error!("swoop: stdout event failed: {e}");
            }
        }

        fn send(&mut self, message: &Message) {
            match serde_json::to_string(message) {
                Ok(text) => {
                    if let Err(e) = self.socket.send_text(&text) {
                        ::log::warn!("swoop: {} not sent: {e}", message.type_name());
                    }
                }
                Err(e) => ::log::error!("swoop: could not encode {}: {e}", message.type_name()),
            }
        }

        fn serve(&mut self) -> (Exit, ExitReason) {
            loop {
                if let Some(end) = self.pump_service() {
                    return end;
                }
                if let Some(end) = self.pump_socket() {
                    return end;
                }
                if let Some(end) = self.pump_workers() {
                    return end;
                }
                if let Some(end) = self.pump_peer() {
                    return end;
                }
                self.pump_candidates();
                self.pump_ice();
                self.pump_features();
                self.tick();
                if let Some(end) = self.deadlines() {
                    return end;
                }
            }
        }

        /// stdin. EOF is the service going away, which §6 makes a clean exit.
        fn pump_service(&mut self) -> Option<(Exit, ExitReason)> {
            loop {
                match self.service_rx.try_recv() {
                    Ok(FromService::Control(Control::Kill { sid })) => {
                        if sid.as_deref().is_some_and(|s| s != self.sid) {
                            continue;
                        }
                        return Some(self.teardown(Exit::Ok, ExitReason::Kill, LeftReason::Kill));
                    }
                    Ok(FromService::Control(Control::SasResult { ok })) => {
                        self.on_sas_result(ok);
                    }
                    Ok(FromService::Eof) | Err(TryRecvError::Disconnected) => {
                        ::log::info!("swoop: stdin closed, the service is gone");
                        return Some(self.teardown(Exit::Ok, ExitReason::Kill, LeftReason::Kill));
                    }
                    Err(TryRecvError::Empty) => return None,
                }
            }
        }

        fn pump_socket(&mut self) -> Option<(Exit, ExitReason)> {
            // Bounded so a talkative room cannot starve capture of a turn.
            for _ in 0..32 {
                let Some(incoming) = self.socket.poll() else {
                    break;
                };
                let effects = match self.client.drive(&mut self.socket, &incoming) {
                    Ok(effects) => effects,
                    Err(e) => {
                        ::log::error!("swoop: signaling failed: {e}");
                        return Some(self.teardown(
                            Exit::SignalingUnreachable,
                            ExitReason::SignalLost,
                            LeftReason::Timeout,
                        ));
                    }
                };
                if let Some(end) = self.apply(effects) {
                    return Some(end);
                }
            }
            if !self.socket.is_open() {
                ::log::error!("swoop: the signaling socket closed");
                return Some(self.teardown(
                    Exit::SignalingUnreachable,
                    ExitReason::SignalLost,
                    LeftReason::Timeout,
                ));
            }
            None
        }

        fn apply(&mut self, effects: Vec<Effect>) -> Option<(Exit, ExitReason)> {
            for effect in effects {
                match effect {
                    Effect::Admitted { viewer, ctl } => self.on_admitted(viewer, ctl),
                    Effect::Offer { viewer, sdp, .. } => self.on_offer(&viewer, &sdp),
                    Effect::Candidate {
                        viewer, candidate, ..
                    } => self.admit_candidate(viewer, candidate),
                    Effect::ViewerGone { viewer, reason } => self.on_viewer_gone(&viewer, reason),
                    Effect::Denied(denial) => self.on_denial(denial),
                    Effect::RoomError { code, reaction } => {
                        ::log::warn!("swoop: room error {code} ({reaction:?})");
                    }
                    Effect::Refused(refusal) => {
                        ::log::warn!("swoop: refused a forwarded frame: {refusal}");
                    }
                    Effect::Send(message) => self.send(&message),
                    Effect::Exit(exit, reason) => {
                        return Some(self.teardown(exit, reason, LeftReason::Kill))
                    }
                }
            }
            None
        }

        fn is_viewer(&self, viewer: &str) -> bool {
            self.viewer.as_ref().is_some_and(|v| v.id == viewer)
        }

        fn on_admitted(&mut self, viewer: String, ctl: bool) {
            if self.viewer.is_some() {
                // Task 4.1 serves one viewer; 8.1 is where a second one gets a
                // peer instead of a bye.
                ::log::warn!("swoop: a second viewer joined and was turned away");
                let effects = self.client.end_viewer(&viewer, LeftReason::Bye);
                let _ = self.apply(effects);
                return;
            }
            ::log::info!("swoop: viewer {viewer} admitted (room ctl {ctl})");
            self.idle_since = None;
            if self.capture.set(true) {
                let _ = self.capture_tx.try_send(ToCapture::Resume);
            }
            self.viewer = Some(Viewer {
                id: viewer.clone(),
                // Watch-only until this host has verified the token itself.
                ctl: false,
                codec: Codec::H264,
                announced: false,
                hello_sent: false,
            });
            let ready = self.client.host_ready(Some(&viewer));
            self.send(&ready);
        }

        fn on_offer(&mut self, viewer: &str, sdp: &str) {
            if !self.is_viewer(viewer) {
                return;
            }
            if self.peer.is_none() {
                let Some(codec) = pick_codec(sdp, &self.codecs) else {
                    ::log::error!("swoop: the offer carries no codec this host can encode");
                    let effects = self.client.end_viewer(viewer, LeftReason::Bye);
                    let _ = self.apply(effects);
                    return;
                };
                let Some(limits) = self.encode_limits(codec) else {
                    ::log::error!("swoop: no limits for {codec:?}");
                    return;
                };
                let encoded = match scale::plan(self.source, limits) {
                    Plan::AsIs => self.source,
                    Plan::Downscale { width, height } => (width, height),
                    // Two 4K panels side by side is 7680 wide, over H.264's
                    // 4096: without the downscale a Mosaic box cannot stream at
                    // all, and a canvas this refuses is degenerate.
                    Plan::Refuse => {
                        ::log::error!(
                            "swoop: {}x{} has no legal encode size",
                            self.source.0,
                            self.source.1
                        );
                        let effects = self.client.end_viewer(viewer, LeftReason::Bye);
                        let _ = self.apply(effects);
                        return;
                    }
                };
                self.encoded = encoded;
                let peer = match RtcPeer::bind(PeerConfig {
                    bind_addr: self.bind_addr,
                    codec,
                    fps: TARGET_FPS,
                    bitrate_bps: self.governor.target_bps(),
                    qpc_hz: self.clock.hz,
                    // Off, and it stays off: str0m installs its leaky-bucket
                    // pacer with it, which the bake-off measured holding
                    // 1015 ms p50 of queue with every loss counter at zero.
                    enable_bwe: false,
                }) {
                    Ok(peer) => peer,
                    Err(e) => {
                        ::log::error!("swoop: could not bind the peer: {e}");
                        return;
                    }
                };
                self.peer = Some(peer);
                // §3's audio is a second RTP track, so it cannot ride the
                // feature outbox: the track is subscribed here, once per peer,
                // and written by the peer itself. A machine with no endpoint
                // simply never puts a packet on it.
                #[cfg(feature = "audio-opus")]
                self.peer
                    .as_mut()
                    .expect("just bound")
                    .set_audio_source(crate::audio::subscribe());
                if let Some(v) = self.viewer.as_mut() {
                    v.codec = codec;
                }
                let fingerprint = self.peer.as_mut().expect("just bound").dtls_fingerprint();
                if let Err(e) = self.client.set_host_fingerprint(&fingerprint) {
                    ::log::error!("swoop: local dtls fingerprint unusable: {e}");
                    return;
                }
                let _ = self.capture_tx.send(ToCapture::Encode {
                    codec,
                    width: encoded.0,
                    height: encoded.1,
                });
                ::log::info!(
                    "swoop: {}x{} captured, {}x{} encoded as {}",
                    self.source.0,
                    self.source.1,
                    encoded.0,
                    encoded.1,
                    codec_wire_name(codec)
                );
            }

            // Every later offer is an ICE restart; str0m keeps its candidates.
            let answer = match self.peer.as_mut().expect("bound above").accept_offer(sdp) {
                Ok(answer) => answer,
                Err(e) => {
                    ::log::error!("swoop: could not answer the offer: {e}");
                    return;
                }
            };
            match self.client.answer(viewer, &answer) {
                Ok(message) => self.send(&message),
                Err(e) => ::log::error!("swoop: could not mac the answer: {e}"),
            }

            let announce = match self.viewer.as_mut() {
                Some(v) if !v.announced => {
                    v.announced = true;
                    Some((v.id.clone(), v.codec))
                }
                _ => None,
            };
            if let Some((id, codec)) = announce {
                // The room's claim, which is what the service is told; nothing
                // is *granted* on it until the host verifies the token itself.
                let ctl = self.client.room_control_claim(&id);
                let event = Event::ViewerJoined {
                    sid: self.sid.clone(),
                    viewer: id,
                    ctl,
                    codec: codec_wire_name(codec).to_owned(),
                };
                self.emit(&event);
            }
        }

        fn on_viewer_gone(&mut self, viewer: &str, reason: LeftReason) {
            if !self.is_viewer(viewer) {
                return;
            }
            // Trigger 1 and 2 of `release_all`: a viewer that dropped mid-chord
            // leaves those keys down on the machine forever otherwise.
            let _ = self.input_tx.send(ToInput::ReleaseAll);
            // At the departure, not at the exit: the linger below keeps the
            // process alive for another minute and the indicator is already
            // down. Never a blocking send — a capture thread inside a
            // re-duplication can take ten seconds to read its channel, and the
            // peer cannot wait that long for its next turn. A pause that does
            // not fit is a capture that keeps running until the exit, which is
            // what 4.1 did; a resume cannot miss, because a paused thread is
            // draining its channel every 100 ms and nothing else is queuing.
            if self.capture.set(false) {
                let _ = self.capture_tx.try_send(ToCapture::Pause);
            }
            if let Some(peer) = self.peer.as_mut() {
                peer.disconnect();
            }
            self.peer = None;
            self.viewer = None;
            self.last_size = None;
            // The pause above closed the encoder with the duplication, so §6's
            // quiet line stays the nine-field one it promises.
            self.encoder = None;
            // The policy's promotion attempt belongs to an ICE agent, and the
            // next viewer gets a new peer with a new one — holding the spent
            // attempt across would leave that session on relay for good.
            self.ice = IcePolicy::new();
            self.denials.forget();
            // A viewer that left by any other road than a lapse: a stale entry
            // would be swept as an expiry long after it went.
            self.leases.forget(viewer);
            self.idle_since = Some(Instant::now());
            let event = Event::ViewerLeft {
                sid: self.sid.clone(),
                viewer: viewer.to_owned(),
                reason,
            };
            self.emit(&event);
        }

        fn pump_workers(&mut self) -> Option<(Exit, ExitReason)> {
            loop {
                match self.worker_rx.try_recv() {
                    Ok(FromWorker::Frame(frame)) => self.on_frame(*frame),
                    Ok(FromWorker::Cursor(message)) => self.write_json(Channel::SwoopCursor, &message),
                    Ok(FromWorker::SourceSize { width, height }) => {
                        self.source = (width, height);
                        self.replan();
                    }
                    Ok(FromWorker::Backend(backend)) => self.encoder = Some(backend),
                    Ok(FromWorker::InputDropped(dropped)) => self.input_dropped = dropped,
                    Ok(FromWorker::Failed(exit)) => {
                        ::log::error!("swoop: capture stopped: exit {}", exit.code());
                        return Some(self.teardown(exit, ExitReason::Error, LeftReason::Timeout));
                    }
                    Ok(FromWorker::Opened { .. }) => {}
                    Err(TryRecvError::Empty) => return None,
                    Err(TryRecvError::Disconnected) => {
                        ::log::error!("swoop: the capture thread is gone");
                        return Some(self.teardown(
                            Exit::NoCaptureSource,
                            ExitReason::Error,
                            LeftReason::Timeout,
                        ));
                    }
                }
            }
        }

        /// This backend's limits for one codec, narrowed by the ladder's
        /// current resolution cap.
        ///
        /// The **rung** and not the ceiling: the rung is where the ladder
        /// stands, and at the top of the ladder the two name the same cap
        /// anyway. Narrowing by the ceiling would make a resolution rung a
        /// re-plan that changes nothing.
        fn encode_limits(&self, codec: Codec) -> Option<scale::Limits> {
            limits_for(&self.codec_caps, codec)
                .map(|limits| self.governor.rung().resolution.narrow(limits))
        }

        /// Re-plan the encode size against the current source, codec and rung —
        /// after a mode change moved the texture under the encoder, or after
        /// the ladder gave up a resolution rung.
        fn replan(&mut self) {
            let Some(codec) = self.viewer.as_ref().map(|v| v.codec) else {
                return;
            };
            let Some(limits) = self.encode_limits(codec) else {
                return;
            };
            let encoded = match scale::plan(self.source, limits) {
                Plan::AsIs => self.source,
                Plan::Downscale { width, height } => (width, height),
                Plan::Refuse => {
                    ::log::error!("swoop: the new source size has no legal encode size");
                    return;
                }
            };
            self.encoded = encoded;
            let _ = self.capture_tx.send(ToCapture::Encode {
                codec,
                width: encoded.0,
                height: encoded.1,
            });
        }

        fn on_frame(&mut self, frame: EncodedFrame) {
            /// What the peer did with the frame. Kept out of the peer's borrow
            /// so the governor, the sequencer and the clock can be reached
            /// afterwards.
            enum Outcome {
                Skipped,
                /// The peer has no recovery point yet and this frame is not one.
                NeedsIrap,
                /// Written, with the rtp timestamp that is the browser's join key.
                Sent(u32),
            }

            let size = (frame.width as u16, frame.height as u16);
            let changed = self.last_size.is_some_and(|last| last != size);
            // §4: send is "immediately before the frame was handed to the
            // transport", and the governor joins its feedback on this stamp.
            let send_us = self.clock.now_us();
            let stamps = FrameStamps {
                capture_us: self.clock.us(frame.captured_qpc),
                encode_us: self.clock.us(frame.encoded_qpc),
                send_us,
            };

            let outcome = match self.peer.as_mut() {
                None => Outcome::Skipped,
                Some(peer) if peer.state() != PeerState::Connected => Outcome::Skipped,
                // Never the first thing a decoder sees: a delta whose
                // references it never had is a black stream, not a lost frame.
                Some(peer) if peer.wants_irap() && !frame.is_irap => Outcome::NeedsIrap,
                Some(peer) => {
                    let before = peer.stats().frames_written;
                    match peer.send(&frame) {
                        Err(e) => {
                            ::log::warn!("swoop: frame {} not sent: {e}", frame.frame_id);
                            Outcome::Skipped
                        }
                        // The pacer refused it, or the track is not writable
                        // yet. No record either: the browser would otherwise
                        // join a frame that never arrived to a stale timestamp.
                        Ok(()) if peer.stats().frames_written == before => Outcome::Skipped,
                        Ok(()) => Outcome::Sent(peer.last_rtp_timestamp_90k().unwrap_or(0)),
                    }
                }
            };

            let rtp = match outcome {
                Outcome::Skipped => return,
                Outcome::NeedsIrap => return self.request_idr(),
                Outcome::Sent(rtp) => rtp,
            };

            self.last_size = Some(size);
            if frame.is_irap {
                // The keyframe a burst of requests was asking for is on the
                // wire; the next request is a new event.
                self.idr.answered();
            }
            let frame_id = frame.frame_id as u32;
            self.governor.on_frame_sent(frame_id, send_us);

            let mut header =
                FrameHeader::meta_record(frame_codec(frame.codec), frame_id, rtp, size, stamps);
            if frame.is_irap {
                header.flags |= flags::IRAP;
            }
            if changed {
                header.flags |= flags::RESOLUTION_CHANGED;
            }
            // Sets IRAP on any frame-id gap: a gap without it *is* the dangling
            // reference §4 forbids.
            self.sequencer.prepare(&mut header);
            let record = header.encode();
            if let Some(peer) = self.peer.as_mut() {
                peer.write_channel(Channel::SwoopMeta, true, record.to_vec());
            }
        }

        fn pump_peer(&mut self) -> Option<(Exit, ExitReason)> {
            let Some(peer) = self.peer.as_mut() else {
                // Nothing to drive, so the loop's own tick has to pace it.
                thread::sleep(TICK);
                return None;
            };
            let mut events = Vec::new();
            if let Err(e) = peer.poll(Instant::now(), TICK, &mut events) {
                ::log::error!("swoop: peer poll failed: {e}");
                let viewer = self.viewer.as_ref().map(|v| v.id.clone());
                if let Some(viewer) = viewer {
                    let effects = self.client.end_viewer(&viewer, LeftReason::Timeout);
                    let _ = self.apply(effects);
                }
                return None;
            }
            for event in events {
                self.on_peer_event(event);
            }
            None
        }

        /// One candidate the viewer trickled, handed to the resolver thread.
        ///
        /// Never admitted here: `admit_remote` resolves `.local` names through
        /// the machine's resolver, which **blocks** for as long as that resolver
        /// takes to give up, and this is the thread that turns the peer every
        /// 2 ms. A full queue means the resolver is still inside a lookup; the
        /// candidate is refused rather than queued behind it, which costs one
        /// pair and never a turn.
        fn admit_candidate(&mut self, viewer: String, candidate: String) {
            if !self.is_viewer(&viewer) {
                return;
            }
            if self
                .resolver_tx
                .try_send(ToResolver { viewer, candidate })
                .is_err()
            {
                ::log::warn!(
                    "swoop: the candidate resolver is busy, a remote candidate was dropped"
                );
            }
        }

        /// What the resolver answered, handed to the ICE agent.
        ///
        /// A candidate for a viewer that has since gone is dropped: it would be
        /// added to whatever peer is here now, which is a different session.
        fn pump_candidates(&mut self) {
            loop {
                let Ok(answer) = self.resolved_rx.try_recv() else {
                    return;
                };
                if !self.is_viewer(&answer.viewer) {
                    continue;
                }
                // The reason and never the attribute: a candidate's address has
                // no business in a log line.
                let candidate = match answer.admitted {
                    Ok(candidate) => candidate,
                    Err(reason) => {
                        ::log::debug!("swoop: remote candidate refused ({reason:?})");
                        continue;
                    }
                };
                if let Some(peer) = self.peer.as_mut() {
                    if let Err(e) = peer.add_remote_candidate(&candidate) {
                        ::log::warn!("swoop: bad remote candidate: {e}");
                    }
                }
            }
        }

        /// The ICE policy's turn: the interface watcher's flag, then its timers.
        ///
        /// The flag is taken every turn whether or not there is a peer — it
        /// means "something changed since it was last read", and one left
        /// standing between viewers would be read as a change under the next
        /// one. Acting on it needs a peer, because there is no other ICE here.
        fn pump_ice(&mut self) {
            let changed = self.ifwatch.as_ref().is_some_and(|w| w.take_changed());
            if self.peer.is_none() {
                return;
            }
            let now = Instant::now();
            if changed {
                if let Some(action) = self.ice.observe(now, IceEvent::InterfaceChanged) {
                    self.on_ice_action(action);
                }
            }
            if let Some(action) = self.ice.poll(now) {
                self.on_ice_action(action);
            }
        }

        /// The one thing the policy asks for.
        ///
        /// The host answers and never offers (plan.md D8), so it is the ICE
        /// *controlled* agent: it cannot renegotiate by itself. `host-ready` is
        /// the ask the protocol gives it, and str0m's own ICE restart happens in
        /// `accept_offer` when the browser's re-offer arrives carrying fresh
        /// credentials — which is the "every later offer is an ICE restart" path
        /// in `on_offer`.
        fn on_ice_action(&mut self, action: IceAction) {
            let IceAction::RestartIce(reason) = action;
            let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) else {
                return;
            };
            ::log::info!("swoop: asking viewer {viewer} for an ice restart ({reason:?})");
            let ready = self.client.host_ready(Some(&viewer));
            self.send(&ready);
        }

        /// Every feature's turn to produce, then the one write.
        ///
        /// Only while the peer is connected: a feature's outbound is for the
        /// viewer, and there is nothing to hold it in before one arrives.
        /// Whatever a feature must keep across that gap, it keeps itself.
        fn pump_features(&mut self) {
            let connected = self
                .peer
                .as_ref()
                .is_some_and(|peer| peer.state() == PeerState::Connected);
            if !connected {
                return;
            }
            let now = Instant::now();
            self.outbox.refill(now);
            // Drained per feature rather than once at the end: a request has to
            // carry who made it, and `sas_result` routed to the wrong feature
            // is a handshake that never completes.
            let mut asked: Vec<(&'static str, FeatureRequest)> = Vec::new();
            for feature in self.features.iter_mut() {
                feature.poll(now, &mut self.outbox);
                let name = feature.name();
                asked.extend(
                    self.outbox
                        .take_requests()
                        .into_iter()
                        .map(|request| (name, request)),
                );
            }
            let pending = self.outbox.take();
            if let Some(peer) = self.peer.as_mut() {
                for record in pending {
                    peer.write_channel(record.channel, false, record.payload);
                }
            }
            for (name, request) in asked {
                self.on_request(name, request);
            }
        }

        /// One [`FeatureRequest`], acted on by the only thread that holds the
        /// worker channels. Every hand-off is a `try_send`: a capture thread
        /// inside a ten-second re-duplication must never hold the loop up.
        fn on_request(&mut self, feature: &'static str, request: FeatureRequest) {
            match request {
                FeatureRequest::Sas => {
                    // §6's `sas_request` names a viewer, and there is no
                    // ctrl+alt+del without one to have asked for it.
                    let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) else {
                        return;
                    };
                    self.sas_pending = Some(feature);
                    let event = Event::SasRequest {
                        sid: self.sid.clone(),
                        viewer,
                    };
                    self.emit(&event);
                }
                FeatureRequest::SelectOutput { index, output } => {
                    let space = PointerSpace::from_output(&output);
                    if self.capture_tx.try_send(ToCapture::Output(output)).is_err() {
                        // Eight deep and drained every pass: a full channel is
                        // a wedged capture thread, not a busy one.
                        ::log::warn!(
                            "swoop: capture is not taking commands, display {index} not selected"
                        );
                        return;
                    }
                    let _ = self.input_tx.try_send(ToInput::Space(space));
                    self.display = index;
                    // The retarget ends the capture pass, and a new pass has no
                    // encoder until it is asked for one again.
                    self.replan();
                }
                FeatureRequest::Audit { kind, reason } => {
                    let viewer = self.viewer.as_ref().map(|v| v.id.clone());
                    self.host_event(kind, viewer, reason);
                }
            }
        }

        /// The service's answer to a `sas_request`, routed to the feature that
        /// asked and to nothing else.
        fn on_sas_result(&mut self, ok: bool) {
            let Some(name) = self.sas_pending.take() else {
                ::log::warn!("swoop: unexpected sas_result ok={ok}");
                return;
            };
            match self.features.iter_mut().find(|f| f.name() == name) {
                Some(feature) => feature.on_sas_result(ok),
                None => ::log::warn!("swoop: feature {name} is gone, sas_result dropped"),
            }
        }

        /// Offer one inbound payload to every feature.
        ///
        /// Every feature sees every payload on a channel it may read, because
        /// §5 shares `swoop-control` between the control messages and the
        /// clipboard — the session cannot tell whose a payload is without
        /// parsing it, and that parse belongs to the feature.
        fn offer_to_features(&mut self, channel: Channel, data: &[u8]) {
            let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) else {
                return;
            };
            // The host's own verdict from the token it verified, never the
            // room's claim — the same source `on_input` gates on.
            let ctl = self.client.control_granted(&viewer);
            for feature in self.features.iter_mut() {
                if let Err(e) = feature.on_message(channel, ctl, data) {
                    ::log::warn!(
                        "swoop: feature {} could not handle a {channel:?} message: {e}",
                        feature.name()
                    );
                }
            }
        }

        fn on_peer_event(&mut self, event: PeerEvent) {
            match event {
                PeerEvent::Connected => {
                    ::log::info!("swoop: peer connected");
                    self.bind_dtls_session();
                }
                PeerEvent::Disconnected => {
                    // No `bye` came, so the viewer did not leave — it stopped
                    // answering. That is a timeout, and the release matters.
                    let viewer = self.viewer.as_ref().map(|v| v.id.clone());
                    if let Some(viewer) = viewer {
                        let effects = self.client.end_viewer(&viewer, LeftReason::Timeout);
                        let _ = self.apply(effects);
                    }
                }
                PeerEvent::LocalCandidate(candidate) => {
                    let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) else {
                        return;
                    };
                    // One bundled m-line, so mid 0 is the only one there is.
                    let message = Message::Candidate {
                        candidate,
                        sdp_mid: "0".to_owned(),
                        sdp_m_line_index: 0,
                        to: Some(viewer),
                        from: None,
                        from_role: None,
                        server_time_ms: None,
                    };
                    self.send(&message);
                }
                PeerEvent::Ice(event) => {
                    if let Some(action) = self.ice.observe(Instant::now(), event) {
                        self.on_ice_action(action);
                    }
                }
                PeerEvent::KeyframeRequest => self.request_idr(),
                PeerEvent::ChannelOpen(Channel::SwoopControl) => self.send_hello_host(),
                PeerEvent::ChannelOpen(channel) => ::log::debug!("swoop: {channel:?} open"),
                PeerEvent::ChannelClose(channel) => ::log::debug!("swoop: {channel:?} closed"),
                PeerEvent::ChannelData {
                    channel,
                    binary,
                    data,
                } => self.on_channel_data(channel, binary, &data),
                PeerEvent::ChannelRefused(label) => {
                    ::log::warn!("swoop: refused a channel labelled {label}")
                }
                PeerEvent::FrameDropped { frame_id, bytes } => {
                    ::log::debug!("swoop: pacer refused frame {frame_id} ({bytes} bytes)")
                }
                PeerEvent::ChannelWriteRefused {
                    channel,
                    queued_bytes,
                } => ::log::debug!("swoop: {channel:?} write refused, {queued_bytes} queued"),
                PeerEvent::ChannelQueueOverflow { channel } => {
                    ::log::warn!("swoop: {channel:?} queue overflowed")
                }
                // Never fires: BWE is off. Named so it is not a silent arm.
                PeerEvent::BitrateEstimate(_) => {}
            }
        }

        /// §10: every token this viewer presents from here is checked against
        /// the fingerprint of the **established** dtls session rather than the
        /// offer's claim, which is the whole argument for carrying the token on
        /// `swoop-control` instead of putting a field on the offer.
        ///
        /// `Connected` fires before any channel opens, so the connect token —
        /// which §10 makes the first lease — is bound to it too.
        fn bind_dtls_session(&mut self) {
            let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) else {
                return;
            };
            let Some(fingerprint) = self
                .peer
                .as_mut()
                .and_then(RtcPeer::remote_dtls_fingerprint)
            else {
                // Nothing to bind to, so `Viewer::fingerprint` keeps preferring
                // the offer's — weaker, and never silently treated as absent.
                ::log::warn!("swoop: the peer connected with no remote certificate to bind to");
                return;
            };
            // The fingerprint itself is never logged.
            if let Err(e) = self.client.set_viewer_dtls_fingerprint(&viewer, &fingerprint) {
                ::log::warn!("swoop: viewer {viewer} not bound to its dtls session: {e}");
            }
        }

        fn on_channel_data(&mut self, ch: Channel, binary: bool, data: &[u8]) {
            match ch {
                Channel::SwoopControl if !binary => self.on_control(data),
                Channel::SwoopInput if !binary => self.on_input(data),
                Channel::SwoopFeedback if !binary => self.on_feedback(data),
                // Host → viewer channels, and §3's channels are text.
                _ => {
                    ::log::warn!("swoop: unexpected data on {ch:?} (binary {binary})");
                    return;
                }
            }
            self.offer_to_features(ch, data);
        }

        fn on_control(&mut self, data: &[u8]) {
            let Ok(message) = serde_json::from_slice::<ControlMessage>(data) else {
                // Not a malformation: §5 shares this channel with the
                // clipboard, so a payload the control codec refuses is the
                // expected shape of a clip frame. `offer_to_features` still
                // gets it.
                ::log::debug!("swoop: a swoop-control payload is not a control message");
                return;
            };
            let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) else {
                return;
            };
            let ctl = self.client.control_granted(&viewer);
            if message.requires_control() && !ctl {
                self.deny(&viewer, "gated_control");
                return;
            }
            match message {
                // §8's viewer token has no field on `offer`, so both ends put
                // the connect token on §10's `lease` frame: the first lease IS
                // the connect token, and there is one verification path.
                ControlMessage::Lease { token } => {
                    let verdict = self.client.verify_viewer_token(&viewer, &token);
                    match verdict {
                        Ok(_) => {
                            let granted = self.client.control_granted(&viewer);
                            if let Some(v) = self.viewer.as_mut() {
                                v.ctl = granted;
                            }
                            ::log::info!("swoop: viewer {viewer} verified, ctl {granted}");
                            // §10's 5-minute lease, not the token's 60-second
                            // `exp`: the browser renews at 60% of whatever it is
                            // answered with, and the token's life would make
                            // that a full membership re-check every 36 seconds.
                            let ok = ControlMessage::LeaseOk {
                                expires_at: self.leases.renew(&viewer),
                            };
                            self.write_json(Channel::SwoopControl, &ok);
                        }
                        Err(denial) => {
                            self.on_denial(denial);
                            self.leases.forget(&viewer);
                            let effects = self.client.end_viewer(&viewer, LeftReason::LeaseExpired);
                            // Never an exit: `end_viewer` produces a bye and a
                            // departure, nothing that ends the process.
                            let _ = self.apply(effects);
                        }
                    }
                }
                ControlMessage::Idr => self.request_idr(),
                // All three axes, not just the bitrate: `preset` carries the
                // resolution cap, which is the one axis §5 gives no field of
                // its own.
                ControlMessage::Quality {
                    preset,
                    max_bitrate_kbps,
                    max_fps,
                } => {
                    let ceiling = Ceiling::from_quality(&preset, max_bitrate_kbps, max_fps);
                    self.governor.set_ceiling(ceiling);
                    let target = self.governor.target_bps();
                    self.apply_bitrate(target);
                    // A new preset restarts the ladder at its own top, which is
                    // a rung move like any other.
                    self.apply_ladder();
                }
                // Task 6.1 owns the secure desktop and `SendSAS`; spike 0.3 was
                // never run, so nothing here crosses that boundary.
                ControlMessage::Sas => ::log::info!("swoop: sas requested (task 6.1)"),
                ControlMessage::Display { index } => {
                    ::log::info!("swoop: display {index} requested (task 6.4)")
                }
                ControlMessage::Mute { .. } => {}
                // Host → viewer types, which a viewer may not send.
                ControlMessage::HelloHost { .. }
                | ControlMessage::SasResult { .. }
                | ControlMessage::LeaseOk { .. }
                | ControlMessage::Ended { .. } => {
                    ::log::warn!("swoop: viewer sent a host-only control message")
                }
            }
        }

        fn on_input(&mut self, data: &[u8]) {
            let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) else {
                return;
            };
            // The host is the enforcement point, and `ctl` comes from the token
            // this host verified — never from anything the browser says, and
            // never from the room's claim at join.
            if !self.client.control_granted(&viewer) {
                self.deny(&viewer, "input");
                return;
            }
            let Ok(message) = serde_json::from_slice::<InputMessage>(data) else {
                ::log::warn!("swoop: malformed input message");
                return;
            };
            let _ = self.input_tx.try_send(ToInput::Message(Box::new(message)));
        }

        /// §5: a viewer without `ctl` that sends something gated is dropped and
        /// the attempt is reported.
        ///
        /// Once per viewer, not once per message: [`Denials`] is the rate
        /// limit, and a watcher holding a key down would otherwise write a row
        /// per poll. The count of everything it suppressed rides `status`.
        ///
        /// `what` is a reason code, never prose — the route refuses anything
        /// outside `^[a-z0-9_]{1,48}$` and refuses the whole batch with it.
        fn deny(&mut self, viewer: &str, what: &'static str) {
            if self.denials.note(viewer) {
                ::log::warn!("swoop: viewer {viewer} sent {what} without ctl, dropped");
                self.host_event(
                    HostEventKind::InputNotPermitted,
                    Some(viewer.to_owned()),
                    Some(what.to_owned()),
                );
            }
        }

        /// A refusal the streamer is the only witness to. The log keeps the
        /// detail; the event is what reaches the audit trail.
        fn on_denial(&mut self, denial: Denial) {
            ::log::warn!("swoop: viewer denied: {denial}");
            let reason = denial.reason.reason().to_owned();
            self.host_event(
                host_event_kind(denial.reason),
                Some(denial.viewer),
                Some(reason),
            );
        }

        /// One row for `POST /api/agent/swoop/events`, out through the service.
        fn host_event(
            &mut self,
            kind: HostEventKind,
            viewer: Option<String>,
            reason: Option<String>,
        ) {
            let event = Event::HostEvent {
                sid: self.sid.clone(),
                kind,
                viewer,
                reason,
            };
            self.emit(&event);
        }

        fn on_feedback(&mut self, data: &[u8]) {
            let Ok(message) = serde_json::from_slice::<Feedback>(data) else {
                ::log::warn!("swoop: malformed feedback message");
                return;
            };
            if let Feedback::Ping { id, t_us } = message {
                // `hostUs` must be in the same epoch as §4's `tSendUs`: the
                // browser's offset is `hostUs − viewerUs` and the governor
                // undoes it against the send stamp. The reply goes back on
                // `swoop-feedback`, which is where the viewer listens for it.
                self.write_json(
                    Channel::SwoopFeedback,
                    &Feedback::Pong {
                        id,
                        t_us,
                        host_us: self.clock.now_us() as i64,
                    },
                );
                return;
            }
            self.governor.on_feedback(Instant::now(), &message);
        }

        fn write_json<T: serde::Serialize>(&mut self, channel: Channel, message: &T) {
            let Some(peer) = self.peer.as_mut() else {
                return;
            };
            match serde_json::to_vec(message) {
                Ok(bytes) => peer.write_channel(channel, false, bytes),
                Err(e) => ::log::error!("swoop: could not encode a {channel:?} message: {e}"),
            }
        }

        fn send_hello_host(&mut self) {
            let Some(codec) = self.viewer.as_ref().map(|v| v.codec) else {
                return;
            };
            if self.viewer.as_ref().is_some_and(|v| v.hello_sent) {
                return;
            }
            if let Some(v) = self.viewer.as_mut() {
                v.hello_sent = true;
            }
            // The `displays` feature enumerates them properly; until it does,
            // the fallback advertises only the display being streamed rather
            // than putting a switcher in the browser for a switch this session
            // cannot honour. `ready` still tells the service the true count.
            let encoded = self.encoded;
            let displays = self
                .features
                .iter_mut()
                .map(|feature| feature.hello_displays())
                .find(|list| !list.is_empty())
                .unwrap_or_else(|| {
                    vec![channel::DisplayInfo {
                        index: 0,
                        width: encoded.0,
                        height: encoded.1,
                        primary: true,
                    }]
                });
            let hello = ControlMessage::HelloHost {
                codec: codec_wire_name(codec).to_owned(),
                width: self.encoded.0,
                height: self.encoded.1,
                displays,
                streamer_epoch: self.streamer_epoch,
                protocol_version: crate::bundle::SWOOP_PROTOCOL_VERSION,
            };
            self.write_json(Channel::SwoopControl, &hello);
            // This viewer's shape cache is empty and the tracker only emits on
            // a change, so the pointer has to be asked for whole.
            let _ = self.capture_tx.try_send(ToCapture::CursorSnapshot);
        }

        /// §4: a host coalesces idr requests behind a cooldown, so a browser
        /// may ask as often as it likes. [`IdrPolicy`] holds the whole of it.
        fn request_idr(&mut self) {
            if !self.idr.request(Instant::now()) {
                return;
            }
            let _ = self.capture_tx.try_send(ToCapture::Idr);
        }

        /// The gate and the source have to agree, or the gate just drops the
        /// difference.
        fn apply_bitrate(&mut self, bps: u32) {
            if let Some(peer) = self.peer.as_mut() {
                peer.set_bitrate_ceiling(bps);
            }
            let _ = self.capture_tx.try_send(ToCapture::Bitrate(bps));
        }

        /// The governor's other output, which is two different things to act
        /// on and is why `LadderChange::needs_new_encoder` exists.
        ///
        /// A resolution move is a **new encoder**: a rebuild yields a new
        /// device and the backend refuses a foreign texture (spike 3.7), so it
        /// goes through `replan`, whose `Encode` drops the old encoder and the
        /// scaler and forces the irap that §4 requires of a resolution change.
        /// A frame-rate move is a capture-side decision the running encoder
        /// never hears about.
        fn apply_ladder(&mut self) {
            let Some(change) = self.governor.take_ladder() else {
                return;
            };
            if change.needs_new_encoder() {
                self.replan();
            }
            if change.rung.fps != change.previous.fps {
                let _ = self.capture_tx.try_send(ToCapture::Fps(change.rung.fps));
            }
        }

        fn tick(&mut self) {
            let now = Instant::now();
            if now.duration_since(self.last_report) >= REPORT_INTERVAL {
                self.last_report = now;
                let pacer = self.peer.as_ref().map(|p| p.stats().pacer);
                if let Some(pacer) = pacer {
                    if let Some(bps) = self.governor.on_report(now, pacer) {
                        self.apply_bitrate(bps);
                    }
                    // Read straight after the evaluation that produced it: at
                    // most one move per report.
                    self.apply_ladder();
                }
            }
            if now.duration_since(self.last_status) >= STATUS_INTERVAL {
                self.status(now);
            }
        }

        fn status(&mut self, now: Instant) {
            let elapsed = now.duration_since(self.last_status);
            self.last_status = now;
            let (frames, bitrate_kbps) = match self.peer.as_ref() {
                Some(peer) => (peer.stats().frames_written, (peer.sent_bps() / 1000) as u32),
                None => (self.frames_at_status, 0),
            };
            let fps = frames
                .saturating_sub(self.frames_at_status)
                .checked_div(elapsed.as_secs().max(1))
                .unwrap_or(0) as u32;
            self.frames_at_status = frames;
            let viewers = self.client.viewer_count();
            let controllers = u32::from(self.viewer.as_ref().is_some_and(|v| v.ctl));
            // The outbox's refusals have no `status` field — nothing outside
            // this process can act on them — so they stay a log line.
            if self.outbox.refused() > 0 {
                ::log::info!(
                    "swoop: the feature outbox has refused {} records",
                    self.outbox.refused()
                );
            }
            let mut contributed = FeatureStatus::default();
            for feature in self.features.iter_mut() {
                feature.status(&mut contributed);
            }
            // The governor's own view, and only while somebody is watching:
            // with no peer there is no rate being governed, and §6 promises a
            // quiet session the nine-field line.
            let governed = self.peer.is_some();
            let stats = self.governor.stats();
            let event = Event::Status {
                sid: self.sid.clone(),
                viewers,
                controllers,
                indicator: self.indicator,
                bitrate_kbps,
                fps,
                // Relay allocation is Task 7.4/7.5; everything today is direct.
                path: MediaPath::Direct,
                display: self.display,
                uptime_s: now.duration_since(self.started).as_secs(),
                desktop: contributed.desktop,
                audio: contributed.audio,
                displays: contributed.displays,
                // Absent means zero, and a session that refused nothing is the
                // normal one — carrying a `0` on every line would say nothing
                // two thousand times a session.
                input_dropped: (self.input_dropped > 0).then_some(self.input_dropped),
                denials: (self.denials.count() > 0).then(|| self.denials.count()),
                test_override: self.test_override.clone(),
                encoder: self.encoder.map(str::to_owned),
                preset: governed.then(|| self.governor.ceiling().label()),
                target_kbps: governed.then(|| self.governor.target_bps() / 1000),
                rung_fps: governed.then_some(stats.rung.fps),
                rung_resolution: governed
                    .then(|| stats.rung.resolution.wire_name().to_owned()),
                // Absent is the preset's own rung, which is where a healthy
                // session sits — the same "absent means zero" as the counters.
                rung_index: (governed && stats.rung_index > 0).then_some(stats.rung_index),
                governor: governed.then(|| governor_phase(self.governor.state(now))),
                idrs: (self.idr.forced() > 0).then(|| self.idr.forced()),
            };
            self.emit(&event);
        }

        fn deadlines(&mut self) -> Option<(Exit, ExitReason)> {
            let now = Instant::now();
            if now.duration_since(self.started) >= self.session_cap {
                return Some(self.teardown(Exit::Ok, ExitReason::SessionCap, LeftReason::Timeout));
            }
            self.sweep_leases();
            if self
                .idle_since
                .is_some_and(|since| now.duration_since(since) >= LINGER)
            {
                return Some(self.teardown(Exit::Ok, ExitReason::Idle, LeftReason::Timeout));
            }
            None
        }

        /// §10: a lease that lapsed past its grace costs that viewer its
        /// session, and nobody else theirs.
        ///
        /// A `bye` would have taken this viewer through `on_viewer_gone`
        /// already; a lapse is the case where none came, so this is the only
        /// thing that drops it. `end_viewer`'s `ViewerGone` is what closes the
        /// peer and sends `ToInput::ReleaseAll` — a viewer dropped mid-chord
        /// leaves those keys down on the machine otherwise.
        fn sweep_leases(&mut self) {
            for viewer in self.leases.lapsed() {
                ::log::warn!("swoop: viewer {viewer} lease lapsed past the grace, dropping it");
                // Before the drop and not after it: `end_viewer` answers a
                // viewer the client has already released with no effects at
                // all, so an entry left here would be swept again on every turn
                // of the loop and written to the audit trail each time.
                self.leases.forget(&viewer);
                self.host_event(
                    HostEventKind::LeaseExpired,
                    Some(viewer.clone()),
                    Some("lease_expired".to_owned()),
                );
                let effects = self.client.end_viewer(&viewer, LeftReason::LeaseExpired);
                // Never an exit: `end_viewer` produces a bye and a departure.
                let _ = self.apply(effects);
            }
        }

        /// End the session: the viewer is told, everything it held is released,
        /// and the peer is closed before the process goes.
        fn teardown(
            &mut self,
            exit: Exit,
            reason: ExitReason,
            left: LeftReason,
        ) -> (Exit, ExitReason) {
            // Trigger 2 of `release_all`, for every ending that is not the
            // viewer's own bye.
            let _ = self.input_tx.send(ToInput::ReleaseAll);
            if let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) {
                let effects = self.client.end_viewer(&viewer, left);
                for effect in effects {
                    // The room's own `kill` already closed the socket inside
                    // `drive`, so there is nothing to say goodbye on — and the
                    // viewer heard that kill from the room directly. Every
                    // other ending still owes it a `bye`.
                    if let (Effect::Send(message), true) = (effect, self.socket.is_open()) {
                        self.send(&message);
                    }
                }
                let event = Event::ViewerLeft {
                    sid: self.sid.clone(),
                    viewer,
                    reason: left,
                };
                self.emit(&event);
                self.viewer = None;
            }
            if let Some(peer) = self.peer.as_mut() {
                peer.disconnect();
            }
            if self.socket.is_open() {
                self.socket.close(1000, "bye");
            }
            (exit, reason)
        }
    }

    // ------------------------------------------------------------ threads ---

    /// Capture, cursor, scale and encode. Everything that touches a GPU texture
    /// is on this thread, because a `Frame`'s handle is only valid until the
    /// next acquire and `Duplication` is not `Send`.
    ///
    /// The duplication is opened per pass rather than once for the process:
    /// §6's linger outlives the last viewer by a minute, and nothing may be
    /// captured behind an indicator that has already come down.
    fn capture_thread(
        output: OutputInfo,
        caps: Vec<BackendCaps>,
        clock: HostClock,
        tx: Sender<FromWorker>,
        rx: Receiver<ToCapture>,
        stop: Arc<AtomicBool>,
    ) {
        // Attached before the duplication is opened, and its first result is
        // dropped: `follow` reports "the desktop changed" on the initial
        // attach too, and acting on that would rebuild a duplication that was
        // only just created — a wasted re-duplication and a second IDR on the
        // startup path G2 is measured on.
        let mut watcher = DesktopWatcher::new();
        watcher.follow();

        let mut ctx = CaptureCtx {
            output,
            caps,
            clock,
            tx,
            rx,
            stop,
            watcher,
            bitrate: DEFAULT_BITRATE_BPS,
            fps: TARGET_FPS,
            reported: None,
            backend: None,
        };
        while !ctx.stop.load(Ordering::Relaxed) {
            match capture_pass(&mut ctx) {
                Pass::Paused => {
                    // The encoder went with the pass, so the next viewer's is a
                    // fresh selection and is reported again.
                    ctx.backend = None;
                    if !wait_for_resume(&mut ctx) {
                        return;
                    }
                }
                // `ctx.output` already names the new one; the next pass opens
                // it, and its size reaches the session as a `SourceSize`.
                Pass::Retarget => {}
                Pass::Done => return,
            }
        }
    }

    /// What the capture thread keeps across a pause.
    struct CaptureCtx {
        output: OutputInfo,
        /// What every compiled backend reported, probed once by `drive`. The
        /// selection table is a pure function over it, so a rebuild picks a
        /// backend without touching a driver again — NVENC's own probe counts
        /// sessions by opening them until it is refused.
        caps: Vec<BackendCaps>,
        clock: HostClock,
        tx: Sender<FromWorker>,
        rx: Receiver<ToCapture>,
        stop: Arc<AtomicBool>,
        /// Not `Send`: a desktop association belongs to the thread that made
        /// it, so it is created on this thread and never leaves it.
        watcher: DesktopWatcher,
        /// The governor's current target, re-applied to every encoder this
        /// thread opens — a new encoder takes the session's rate, never the
        /// config's.
        bitrate: u32,
        /// The ladder's frame-rate rung, likewise kept across a pause. At
        /// [`TARGET_FPS`] there is nothing to enforce.
        fps: u32,
        /// The source size the session has been told about. It hears `Opened`
        /// once; every later open reports a change or says nothing.
        reported: Option<(u32, u32)>,
        /// Which backend the last encoder opened on, so a rebuild that lands on
        /// the same one is not re-reported to the session.
        backend: Option<&'static str>,
    }

    enum Pass {
        /// The last viewer left: the duplication is closed and the thread waits
        /// for the next one.
        Paused,
        /// A feature picked another output: the duplication, the encoder and
        /// the scaler all belonged to the old one, so the pass ends and the
        /// next one opens the new one.
        Retarget,
        /// A stop, a dead channel, or a failure already reported to the session.
        Done,
    }

    /// Nothing is captured here — the duplication is closed and there is
    /// nothing to poll for until a viewer comes back.
    fn wait_for_resume(ctx: &mut CaptureCtx) -> bool {
        while !ctx.stop.load(Ordering::Relaxed) {
            match ctx.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(ToCapture::Resume) => return true,
                // The governor's last word on either axis, kept for the pass
                // the next viewer opens.
                Ok(ToCapture::Bitrate(bps)) => ctx.bitrate = bps,
                Ok(ToCapture::Fps(fps)) => ctx.fps = fps,
                // Nothing is open to retarget, so it is only the output the
                // resume will duplicate.
                Ok(ToCapture::Output(output)) => ctx.output = output,
                Ok(ToCapture::Stop) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    return false
                }
                // `Encode`, `Idr`, `CursorSnapshot`, a second `Pause`: there is
                // no duplication to answer them with, and the resume rebuilds
                // the encoder, the scaler and the cursor cache anyway.
                Ok(_) => {}
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            }
        }
        false
    }

    /// One open duplication, from the first acquire to a pause or an exit.
    fn capture_pass(ctx: &mut CaptureCtx) -> Pass {
        let signal = RebuildSignal::new();
        let mut source = match Duplication::open(&ctx.output, signal) {
            Ok(source) => source,
            Err(e) => {
                ::log::error!("swoop: could not duplicate {}: {e}", ctx.output.device_name);
                let _ = ctx.tx.try_send(FromWorker::Failed(Exit::NoCaptureSource));
                return Pass::Done;
            }
        };
        let mut size = source.size();
        let opened = match ctx.reported {
            None => ctx.tx.try_send(FromWorker::Opened {
                width: size.0,
                height: size.1,
            }),
            // A mode change while nothing was being captured. The session
            // re-plans on this and sends the `Encode` that opens the encoder.
            Some(last) if last != size => ctx.tx.try_send(FromWorker::SourceSize {
                width: size.0,
                height: size.1,
            }),
            Some(_) => Ok(()),
        };
        if opened.is_err() {
            return Pass::Done;
        }
        ctx.reported = Some(size);

        let mut reader = PointerReader::new();
        let mut tracker = CursorTracker::new();
        let mut geometry = OutputGeometry::for_output(source.output(), size);
        let mut encoder: Option<Box<dyn Encoder>> = None;
        let mut scaler: Option<Downscaler> = None;
        let mut want: Option<(Codec, u32, u32)> = None;
        let mut force_irap = false;
        // The last frame handed to the encoder, for the floor. The surface
        // behind it belongs to the duplication (or to the scaler), each of
        // which reuses one texture and overwrites it on the next frame — so the
        // handle stays readable exactly as long as neither is rebuilt, and
        // every path that rebuilds one clears this.
        let mut last_fed: Option<Frame> = None;
        let mut floor = FloorTimer::new(Instant::now());
        // When the encoder was last handed anything, for the frame-rate rung.
        let mut last_encode: Option<Instant> = None;

        while !ctx.stop.load(Ordering::Relaxed) {
            loop {
                match ctx.rx.try_recv() {
                    Ok(ToCapture::Encode {
                        codec,
                        width,
                        height,
                    }) => {
                        want = Some((codec, width, height));
                        encoder = None;
                        scaler = None;
                        last_fed = None;
                        force_irap = true;
                    }
                    Ok(ToCapture::Idr) => force_irap = true,
                    Ok(ToCapture::CursorSnapshot) => {
                        if let Some(shape) = tracker.current_shape() {
                            let _ = ctx.tx.try_send(FromWorker::Cursor(shape));
                        }
                    }
                    Ok(ToCapture::Bitrate(bps)) => {
                        ctx.bitrate = bps;
                        if let Some(encoder) = encoder.as_mut() {
                            if let Err(e) = encoder.set_bitrate(bps) {
                                ::log::warn!("swoop: could not move the bitrate: {e}");
                            }
                        }
                    }
                    // Nothing to reconfigure: the encoder is told nothing about
                    // this, because what changes is how often it is fed.
                    Ok(ToCapture::Fps(fps)) => ctx.fps = fps,
                    Ok(ToCapture::Output(output)) => {
                        ctx.output = output;
                        return Pass::Retarget;
                    }
                    Ok(ToCapture::Pause) => return Pass::Paused,
                    // Already running: the session sends one on every
                    // admission, and only the first of those is a resume.
                    Ok(ToCapture::Resume) => {}
                    Ok(ToCapture::Stop) | Err(TryRecvError::Disconnected) => return Pass::Done,
                    Err(TryRecvError::Empty) => break,
                }
            }

            if ctx.watcher.follow() {
                // A desktop switch does the same damage to a duplication as an
                // ACCESS_LOST, and the new device is a new encoder.
                source.request_rebuild();
            }

            let mut pointer = Vec::new();
            let acquired = {
                let geometry = &geometry;
                let tracker = &mut tracker;
                let reader = &mut reader;
                let pointer = &mut pointer;
                let clock = ctx.clock;
                source.next_frame_with(ACQUIRE_TIMEOUT_MS, &mut |dup, info| {
                    // Most cursor news arrives on frames that carry no picture
                    // at all, and the shape is only legal to read while the
                    // frame is held — which is why this is an observer.
                    //
                    // `LastMouseUpdateTime` is qpc ticks; §5's `tsUs` is the
                    // same epoch as every other stamp the viewer is sent.
                    let ts_us = clock.us(info.LastMouseUpdateTime) as i64;
                    if let Some(at) = cursor::pointer_position(info) {
                        if let Some(message) = tracker.on_position(at, geometry, ts_us) {
                            pointer.push(message);
                        }
                    }
                    match reader.shape(dup, info) {
                        Ok(Some((shape, bytes))) => {
                            match tracker.on_shape(&shape, bytes, geometry.dpi) {
                                Ok(Some(message)) => pointer.push(message),
                                Ok(None) => {}
                                Err(e) => ::log::warn!("swoop: cursor shape: {e}"),
                            }
                        }
                        Ok(None) => {}
                        Err(e) => ::log::warn!("swoop: cursor shape read: {e}"),
                    }
                })
            };
            for message in pointer {
                let _ = ctx.tx.try_send(FromWorker::Cursor(message));
            }

            let frame = match acquired {
                Ok(frame) => frame,
                Err(e) => {
                    ::log::error!("swoop: capture failed: {e}");
                    let _ = ctx.tx.try_send(FromWorker::Failed(Exit::NoCaptureSource));
                    return Pass::Done;
                }
            };
            // Taken after the acquire and not before it: `next_frame_with`
            // rebuilds inside itself on an ACCESS_LOST, and the texture
            // `last_fed` points at went with the duplication that owned it.
            // True once after every rebuild — the device is new, so the encoder
            // and the scaler pinned to the old one are gone with it.
            if source.take_idr_request() {
                encoder = None;
                scaler = None;
                last_fed = None;
                force_irap = true;
            }
            if source.size() != size {
                size = source.size();
                ctx.reported = Some(size);
                geometry = OutputGeometry::for_output(source.output(), size);
                let _ = ctx.tx.try_send(FromWorker::SourceSize {
                    width: size.0,
                    height: size.1,
                });
                // The session re-plans and sends a new `Encode`; until it does
                // there is no encoder to feed.
                want = None;
                encoder = None;
                scaler = None;
                last_fed = None;
            }

            let Some((codec, width, height)) = want else {
                continue;
            };
            let now = Instant::now();
            // The ladder's frame-rate rung, and the only place it can be
            // enforced: a CBR encoder handed every frame just spends the same
            // budget on all of them. Not applied at the top rung — duplication
            // is vsync-locked at the panel's rate, so a gate there would drop
            // every other frame on the jitter of a 16.67 ms interval.
            if ctx.fps < TARGET_FPS
                && last_encode
                    .is_some_and(|at| now.saturating_duration_since(at) < frame_interval(ctx.fps))
            {
                continue;
            }
            let feed = match frame {
                Some(frame) => {
                    if scaler.is_none() && (width, height) != (frame.width, frame.height) {
                        match Downscaler::open(&frame, width, height) {
                            Ok(opened) => scaler = Some(opened),
                            Err(e) => {
                                ::log::error!("swoop: could not open the downscaler: {e}");
                                let _ = ctx.tx.try_send(FromWorker::Failed(e.exit()));
                                return Pass::Done;
                            }
                        }
                    }
                    match scaler.as_mut().map(|scaler| scaler.scale(&frame)) {
                        Some(Ok(scaled)) => scaled,
                        Some(Err(e)) => {
                            // A new device under the scaler: rebuild both next turn.
                            ::log::warn!("swoop: downscale failed: {e}");
                            encoder = None;
                            scaler = None;
                            last_fed = None;
                            force_irap = true;
                            continue;
                        }
                        None => frame,
                    }
                }
                // The floor. Desktop Duplication answers `WAIT_TIMEOUT` on a
                // static desktop and a hardware decoder handed nothing stalls,
                // so the last picture goes out again — stamped now, because the
                // browser's stage breakdown measures this frame's trip and not
                // the age of its pixels.
                None => match last_fed.as_ref() {
                    Some(last) if floor.due(now) => Frame {
                        handle: last.handle,
                        width: last.width,
                        height: last.height,
                        captured_qpc: qpc_now(),
                    },
                    _ => continue,
                },
            };

            if encoder.is_none() {
                let cfg = EncoderConfig {
                    codec,
                    width,
                    height,
                    fps: TARGET_FPS,
                    // A rebuild is a new encoder, so the governor's current
                    // target is re-applied here rather than inherited.
                    bitrate_bps: ctx.bitrate,
                };
                // The chain, not NVENC: `select::create` walks down it, so a
                // backend that probed fine and then refused the session costs
                // one rung rather than the session.
                match select::create(&ctx.caps, &cfg) {
                    Ok((backend, created)) => {
                        encoder = Some(created);
                        if ctx.backend != Some(backend) {
                            ctx.backend = Some(backend);
                            ::log::info!("swoop: encoding on {backend}");
                            let _ = ctx.tx.try_send(FromWorker::Backend(backend));
                        }
                    }
                    Err(e) => {
                        ::log::error!("swoop: could not open the encoder: {e}");
                        let _ = ctx.tx.try_send(FromWorker::Failed(Exit::NoEncoder));
                        return Pass::Done;
                    }
                }
            }
            let Some(session) = encoder.as_mut() else {
                continue;
            };
            match session.encode(&feed, force_irap) {
                Ok(encoded) => {
                    // The floor is measured from the last frame the encoder was
                    // given, not from the last one it answered: an encoder that
                    // runs a frame behind is not a stalled desktop.
                    floor.fed(now);
                    last_encode = Some(now);
                    last_fed = Some(feed);
                    if let Some(encoded) = encoded {
                        force_irap = false;
                        // A full queue means the session thread fell behind. The
                        // frame is dropped rather than stalling capture, and the
                        // next one is an IRAP so the gap cannot dangle.
                        if ctx.tx.try_send(FromWorker::Frame(Box::new(encoded))).is_err() {
                            force_irap = true;
                        }
                    }
                }
                Err(e) => {
                    // DeviceChanged and SizeChanged both mean the surface moved
                    // under the session: drop it and open a new one.
                    ::log::warn!("swoop: encode failed: {e}");
                    encoder = None;
                    scaler = None;
                    last_fed = None;
                    force_irap = true;
                }
            }
        }
        Pass::Done
    }

    /// Input injection, on the one thread that follows the input desktop.
    fn input_thread(
        space: PointerSpace,
        tx: Sender<FromWorker>,
        rx: Receiver<ToInput>,
        stop: Arc<AtomicBool>,
    ) {
        let mut watcher = DesktopWatcher::new();
        // Same reason as the capture thread: the initial attach is not a
        // switch, and there is nothing held to release on it.
        watcher.follow();
        let mut injector = SendInputInjector::new(space);
        let mut viewer = ViewerInput::new(Instant::now());
        let mut reported = 0u64;

        while !stop.load(Ordering::Relaxed) {
            // Trigger 4 of `release_all`. `follow` switches and reports in one
            // call, so the ups land on the new desktop — they clear this host's
            // model of what is held, which is the half that sticks.
            if watcher.follow() {
                let events = viewer.release_all();
                if !events.is_empty() {
                    let _ = injector.inject_all(&events);
                }
                injector.refresh_bounds();
            }
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(ToInput::Message(message)) => {
                    let events = viewer.accept(&message, Instant::now());
                    if !events.is_empty() {
                        if let Err(e) = injector.inject_all(&events) {
                            ::log::warn!("swoop: input injection failed: {e}");
                        }
                    }
                    if viewer.dropped() != reported {
                        reported = viewer.dropped();
                        let _ = tx.try_send(FromWorker::InputDropped(reported));
                    }
                }
                Ok(ToInput::ReleaseAll) => {
                    let events = viewer.release_all();
                    if !events.is_empty() {
                        let _ = injector.inject_all(&events);
                    }
                }
                // A new display is a new coordinate space. Everything held is
                // released first: the ups belong on the desktop the keys went
                // down on, and the injector that knew about them is replaced.
                Ok(ToInput::Space(space)) => {
                    let events = viewer.release_all();
                    if !events.is_empty() {
                        let _ = injector.inject_all(&events);
                    }
                    injector = SendInputInjector::new(space);
                }
                Ok(ToInput::Stop) => return,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    /// The viewer's candidates, admitted off the session thread.
    ///
    /// This thread exists for one call: `SystemResolver::resolve` goes to the
    /// Windows DNS client for a `*.local` name and blocks until it answers or
    /// gives up. On the session thread that would be a stall in the loop that
    /// drives the peer; here it costs nothing but this thread.
    fn resolver_thread(rx: Receiver<ToResolver>, tx: Sender<FromResolver>) {
        let resolver = SystemResolver;
        while let Ok(work) = rx.recv() {
            let admitted = match admit_remote(&work.candidate, &resolver) {
                Admission::Accept => Ok(work.candidate),
                // str0m parses a candidate into a `SocketAddr`, so the name has
                // to be gone by the time it sees the attribute.
                Admission::Resolved(rewritten) => Ok(rewritten),
                Admission::Drop(reason) => Err(reason),
            };
            let answer = FromResolver {
                viewer: work.viewer,
                admitted,
            };
            if tx.send(answer).is_err() {
                return;
            }
        }
    }

    /// Control lines. Line 1 was the bundle and was read before this started.
    fn stdin_thread(mut stdin: impl BufRead, tx: Sender<FromService>) {
        let mut line = String::new();
        loop {
            line.clear();
            match stdin.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(FromService::Eof);
                    return;
                }
                Ok(_) => match ipc::parse_control(line.trim_end()) {
                    Ok(control) => {
                        if tx.send(FromService::Control(control)).is_err() {
                            return;
                        }
                    }
                    // Never the line itself: line 1 was the bundle and a parser
                    // error quotes what it choked on.
                    Err(e) => ::log::warn!("swoop: {e}"),
                },
                Err(e) => {
                    ::log::warn!("swoop: stdin read failed: {e}");
                    let _ = tx.send(FromService::Eof);
                    return;
                }
            }
        }
    }

    // ------------------------------------------------------------ helpers ---

    /// The primary output: the one whose desktop rect starts at the origin.
    /// Every other output's coordinates are relative to it and can be negative.
    fn primary(outputs: &[OutputInfo]) -> &OutputInfo {
        outputs
            .iter()
            .find(|o| o.desktop_rect.left == 0 && o.desktop_rect.top == 0)
            .unwrap_or(&outputs[0])
    }

    /// One host candidate, on the interface that would reach the internet. A
    /// udp `connect` sends nothing; it only picks the route. Task 7.4/7.5 adds
    /// server-reflexive and relayed candidates through `add_local_candidate`.
    fn local_bind_addr() -> SocketAddr {
        let found = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
            .and_then(|socket| {
                socket.connect((Ipv4Addr::new(1, 1, 1, 1), 53))?;
                socket.local_addr()
            })
            .ok();
        SocketAddr::new(
            found.map_or(IpAddr::V4(Ipv4Addr::LOCALHOST), |addr| addr.ip()),
            0,
        )
    }

    /// One frame interval at `fps`, for the capture loop's rate gate. A rung of
    /// zero is not a rung — `quality::MIN_LADDER_FPS` is the bottom — but the
    /// clamp is here rather than trusted, because the divisor is the one thing
    /// that cannot be wrong.
    fn frame_interval(fps: u32) -> Duration {
        Duration::from_micros(1_000_000 / u64::from(fps.max(1)))
    }

    fn frame_codec(codec: Codec) -> FrameCodec {
        match codec {
            Codec::H265 => FrameCodec::Hevc,
            Codec::H264 => FrameCodec::H264,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::input::InputEvent;

        /// The audit route's `type` field is closed and refuses the whole batch
        /// on an unrecognised one, so every refusal the streamer can produce
        /// has to land on a name that route knows.
        #[test]
        fn every_denial_reason_maps_onto_the_audit_routes_vocabulary() {
            assert_eq!(
                host_event_kind(DenialReason::TooManyViewers),
                HostEventKind::JoinRefused
            );
            assert_eq!(
                host_event_kind(DenialReason::JoinRateExceeded),
                HostEventKind::JoinRefused
            );
            assert_eq!(
                host_event_kind(DenialReason::OfferFingerprintMissing),
                HostEventKind::FpMismatch
            );
            assert_eq!(
                host_event_kind(DenialReason::Token(TokenError::FpMismatch)),
                HostEventKind::FpMismatch
            );
            assert_eq!(
                host_event_kind(DenialReason::Token(TokenError::Expired)),
                HostEventKind::LeaseExpired
            );
            assert_eq!(
                host_event_kind(DenialReason::Token(TokenError::BadSignature)),
                HostEventKind::JwtRejected
            );
            assert_eq!(
                host_event_kind(DenialReason::UnknownViewer),
                HostEventKind::JwtRejected
            );
        }

        /// The two vocabularies are joined in one place, so every state the
        /// governor can be in has a word on the wire rather than going
        /// unreported.
        #[test]
        fn every_governor_state_has_a_word_on_the_status_line() {
            assert_eq!(governor_phase(GovernorState::Ceiling), GovernorPhase::Ceiling);
            assert_eq!(governor_phase(GovernorState::Holding), GovernorPhase::Holding);
            assert_eq!(
                governor_phase(GovernorState::Climbing),
                GovernorPhase::Climbing
            );
            assert_eq!(governor_phase(GovernorState::Pinned), GovernorPhase::Pinned);
        }

        /// The frame-rate rung is enforced by feeding the encoder less often,
        /// and the gate is deliberately not applied at [`TARGET_FPS`]: at 60 the
        /// interval is under the 16.67 ms a vsync-locked duplication delivers
        /// at, so a gate there would drop every other frame on jitter alone.
        #[test]
        fn a_frame_rate_rung_is_one_interval_and_the_top_rung_is_never_gated() {
            use crate::session::quality::{FPS_CAPS, MIN_LADDER_FPS};

            assert_eq!(frame_interval(30), Duration::from_micros(33_333));
            assert_eq!(frame_interval(MIN_LADDER_FPS), Duration::from_micros(66_666));
            // Every rung below the top is at least a whole 60 fps frame apart,
            // so the gate actually drops something.
            for fps in FPS_CAPS.into_iter().chain([MIN_LADDER_FPS]) {
                if fps < TARGET_FPS {
                    assert!(frame_interval(fps) > frame_interval(TARGET_FPS));
                }
            }
            // A divisor that cannot be zero, whatever it is handed.
            assert_eq!(frame_interval(0), Duration::from_micros(1_000_000));
        }

        /// The route validates `reason` against `^[a-z0-9_]{1,48}$` and refuses
        /// the batch on a miss, so the finer vocabulary has to survive the trip.
        #[test]
        fn every_denial_reason_is_a_code_the_route_will_accept() {
            let reasons = [
                DenialReason::TooManyViewers,
                DenialReason::JoinTooSoon,
                DenialReason::JoinRateExceeded,
                DenialReason::UnknownViewer,
                DenialReason::OfferFingerprintMissing,
                DenialReason::ViewerMismatch,
                DenialReason::Token(TokenError::Malformed),
                DenialReason::Token(TokenError::JtiReplayed),
            ];
            for reason in reasons {
                let code = reason.reason();
                assert!((1..=48).contains(&code.len()), "{code} is the wrong length");
                assert!(
                    code.bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
                    "{code} is not a reason code"
                );
            }
        }

        /// The host half of the session on real hardware: duplication →
        /// downscale-if-needed → encoder, plus injection → the pointer the
        /// cursor tracker reports, driven by the same threads the session
        /// spawns with nothing stubbed.
        ///
        /// **It moves the real mouse pointer on this machine**, twice, because
        /// that is the only way to prove the cursor stream: the tracker emits
        /// on a change and a stationary desktop is silent by design (20.4% of
        /// frames carry no pointer news at all).
        ///
        /// The room half cannot be tested from here — it needs a bundle minted
        /// by the api for this machine, which is the `run` invocation in this
        /// module's head comment.
        #[test]
        #[ignore = "captures this box's real desktop, opens its encoder and moves the pointer"]
        fn end_to_end_picture() {
            let outputs = capture::enumerate_outputs().expect("dxgi enumerates");
            assert!(!outputs.is_empty(), "no attached output to duplicate");
            let output = primary(&outputs).clone();
            let space = output.clone();

            let backends = select::probe_all();
            let caps: Vec<CodecCaps> = backends
                .iter()
                .flat_map(|backend| backend.codecs.iter().cloned())
                .collect();
            assert!(!caps.is_empty(), "no encoder backend on this machine");
            let codec = caps[0].codec;
            let limits = limits_for(&caps, codec).expect("the codec it just reported");

            let clock = HostClock::new(
                qpc_hz().expect("a performance counter"),
                crate::bundle::TimeAnchor::new(0),
                0,
            );
            let stop = Arc::new(AtomicBool::new(false));
            let (tx, rx) = bounded::<FromWorker>(WORKER_QUEUE);
            let (capture_tx, capture_rx) = bounded::<ToCapture>(8);
            let handle = {
                let stop = Arc::clone(&stop);
                thread::spawn(move || capture_thread(output, backends, clock, tx, capture_rx, stop))
            };

            let source = match rx.recv_timeout(CAPTURE_OPEN_TIMEOUT) {
                Ok(FromWorker::Opened { width, height }) => (width, height),
                Ok(FromWorker::Failed(exit)) => {
                    stop.store(true, Ordering::Relaxed);
                    panic!("capture did not open: exit {}", exit.code());
                }
                _ => {
                    stop.store(true, Ordering::Relaxed);
                    panic!("capture said nothing within {CAPTURE_OPEN_TIMEOUT:?}");
                }
            };
            let encoded = match scale::plan(source, limits) {
                Plan::AsIs => source,
                Plan::Downscale { width, height } => (width, height),
                Plan::Refuse => panic!("{source:?} has no legal encode size"),
            };
            capture_tx
                .send(ToCapture::Encode {
                    codec,
                    width: encoded.0,
                    height: encoded.1,
                })
                .expect("the capture thread is running");

            // The pointer has to actually move, or the tracker has nothing to
            // report — and a move injected here is the same call the input
            // thread makes, so it proves that half at the same time. Paced on
            // the clock and not on frames: a busy desktop delivers 60 frames a
            // second and an idle one delivers none, and the pointer has to move
            // somewhere it was not already sitting either way.
            let mut injector = SendInputInjector::new(PointerSpace::from_output(&space));
            let spots = [(0.25f32, 0.25f32), (0.75, 0.65), (0.4, 0.8), (0.6, 0.2)];
            let mut spot = 0usize;
            let mut next_move = Instant::now();

            let deadline = Instant::now() + Duration::from_secs(3);
            let (mut frames, mut iraps, mut bytes) = (0u32, 0u32, 0usize);
            let (mut positions, mut shapes) = (0u32, 0u32);
            while Instant::now() < deadline {
                if Instant::now() >= next_move {
                    let (x, y) = spots[spot % spots.len()];
                    spot += 1;
                    injector
                        .inject(&InputEvent::MouseMove { x, y })
                        .expect("sendinput reaches this desktop");
                    next_move = Instant::now() + Duration::from_millis(200);
                }
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(FromWorker::Frame(frame)) => {
                        frames += 1;
                        bytes += frame.data.len();
                        iraps += u32::from(frame.is_irap);
                    }
                    Ok(FromWorker::Cursor(channel::Cursor::Cpos { .. })) => positions += 1,
                    Ok(FromWorker::Cursor(channel::Cursor::Cshape { .. })) => shapes += 1,
                    Ok(FromWorker::Failed(exit)) => panic!("capture failed: exit {}", exit.code()),
                    Ok(_) => {}
                    // A static desktop is silent, which is the normal case and
                    // not a reason to stop looking.
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
            }
            stop.store(true, Ordering::Relaxed);
            let _ = capture_tx.send(ToCapture::Stop);
            let _ = handle.join();

            println!(
                "swoop capture: {source:?} -> {encoded:?} {}, {frames} frames ({iraps} irap, \
                 {bytes} bytes), {positions} cpos, {shapes} cshape",
                codec_wire_name(codec)
            );
            assert!(frames > 0, "no encoded frame in five seconds");
            assert_eq!(iraps, 1, "a session opens with exactly one irap and no needless rebuild");
            assert!(positions > 0, "the injected pointer moves produced no cpos");
        }

        /// The two things Task 5.1 added to the capture thread, on the real
        /// duplication: a pause actually closes it, and a resume opens the next
        /// one — plus the floor, which is the only reason frames keep arriving
        /// while nothing on this desktop moves.
        ///
        /// **Do not touch the mouse or keyboard while it runs**: the floor half
        /// only proves anything on a still desktop. A busy one delivers 60 fps
        /// and the assertion passes for the wrong reason, which is why the
        /// count it wants is small.
        ///
        /// ```text
        /// cd agent/swoop
        /// cargo test --lib session::host::tests::pause_closes_the_duplication -- --ignored --nocapture
        /// ```
        ///
        /// Expected on the dev box: `swoop pause: N frames still, 0 while
        /// paused, M after the resume` with N ≥ 2 and M ≥ 1.
        #[test]
        #[ignore = "captures this box's real desktop and opens its encoder"]
        fn pause_closes_the_duplication_and_the_floor_holds_a_still_desktop() {
            let outputs = capture::enumerate_outputs().expect("dxgi enumerates");
            assert!(!outputs.is_empty(), "no attached output to duplicate");
            let output = primary(&outputs).clone();

            let backends = select::probe_all();
            let caps: Vec<CodecCaps> = backends
                .iter()
                .flat_map(|backend| backend.codecs.iter().cloned())
                .collect();
            assert!(!caps.is_empty(), "no encoder backend on this machine");
            let codec = caps[0].codec;
            let limits = limits_for(&caps, codec).expect("the codec it just reported");

            let clock = HostClock::new(
                qpc_hz().expect("a performance counter"),
                crate::bundle::TimeAnchor::new(0),
                0,
            );
            let stop = Arc::new(AtomicBool::new(false));
            let (tx, rx) = bounded::<FromWorker>(WORKER_QUEUE);
            let (capture_tx, capture_rx) = bounded::<ToCapture>(8);
            let handle = {
                let stop = Arc::clone(&stop);
                thread::spawn(move || capture_thread(output, backends, clock, tx, capture_rx, stop))
            };

            let source = match rx.recv_timeout(CAPTURE_OPEN_TIMEOUT) {
                Ok(FromWorker::Opened { width, height }) => (width, height),
                _ => {
                    stop.store(true, Ordering::Relaxed);
                    panic!("capture did not open within {CAPTURE_OPEN_TIMEOUT:?}");
                }
            };
            let encoded = match scale::plan(source, limits) {
                Plan::AsIs => source,
                Plan::Downscale { width, height } => (width, height),
                Plan::Refuse => panic!("{source:?} has no legal encode size"),
            };
            let open = ToCapture::Encode {
                codec,
                width: encoded.0,
                height: encoded.1,
            };

            /// Frames in a window, and nothing else — the cursor and the size
            /// messages are not what this test is about.
            fn frames(rx: &Receiver<FromWorker>, window: Duration) -> u32 {
                let deadline = Instant::now() + window;
                let mut seen = 0;
                while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                    match rx.recv_timeout(left) {
                        Ok(FromWorker::Frame(_)) => seen += 1,
                        Ok(FromWorker::Failed(exit)) => panic!("capture failed: {}", exit.code()),
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
                seen
            }

            capture_tx.send(open).expect("the capture thread is running");
            let still = frames(&rx, Duration::from_millis(1_500));

            capture_tx
                .send(ToCapture::Pause)
                .expect("the capture thread is running");
            // Whatever was already in flight when the pause was read is not a
            // capture that kept running.
            let _ = frames(&rx, Duration::from_millis(300));
            let paused = frames(&rx, Duration::from_secs(1));

            capture_tx
                .send(ToCapture::Resume)
                .expect("the capture thread is running");
            // A new duplication is a new device and a new encoder, which is why
            // the session re-sends this after every admission.
            capture_tx
                .send(ToCapture::Encode {
                    codec,
                    width: encoded.0,
                    height: encoded.1,
                })
                .expect("the capture thread is running");
            let resumed = frames(&rx, Duration::from_secs(5));

            stop.store(true, Ordering::Relaxed);
            let _ = capture_tx.send(ToCapture::Stop);
            let _ = handle.join();

            println!(
                "swoop pause: {still} frames still, {paused} while paused, {resumed} after the resume"
            );
            assert!(still >= 2, "the floor did not feed a still desktop");
            assert_eq!(paused, 0, "capture kept running behind a cleared indicator");
            assert!(resumed >= 1, "the resume did not re-open the duplication");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::bundle::{Bundle, BuildVersions};
    use crate::ipc::{emit, exit, Event};

    fn vectors() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/protocol")
    }

    /// The agent version the bundle vectors were authored against — swoop's own
    /// release, not whatever this working tree says. Read from the accept
    /// vector, exactly as `tests/protocol_vectors.rs` reads it, so the two
    /// cannot drift.
    fn build() -> BuildVersions<'static> {
        let valid = fs::read_to_string(vectors().join("bundle/bundle-valid.json"))
            .expect("the valid bundle vector is present");
        let parsed: serde_json::Value = serde_json::from_str(&valid).expect("it is json");
        let version = parsed["agentVersion"]
            .as_str()
            .expect("bundle-valid.json names an agentVersion")
            .to_owned();
        BuildVersions {
            protocol_version: crate::bundle::SWOOP_PROTOCOL_VERSION,
            agent_version: Box::leak(version.into_boxed_str()),
        }
    }

    /// The verdict only: `Bundle` has no `PartialEq` on purpose — §7 gives it
    /// no way to be printed or compared, and an exit code is what this maps to.
    fn verdict(line: &str) -> Result<(), u8> {
        Bundle::parse(line, build())
            .map(|_| ())
            .map_err(|e| e.exit().code())
    }

    fn parse(file: &str) -> Result<(), u8> {
        let line = fs::read_to_string(vectors().join(file)).expect("the vector is present");
        verdict(&line)
    }

    /// The exit codes §6 fixes, taken through the same mapping `main` uses —
    /// the numbers the agent reports on, so they are contract.
    #[test]
    fn a_bundle_is_accepted_or_maps_to_its_documented_exit_code() {
        assert!(parse("bundle/bundle-valid.json").is_ok());
        // No time anchor: there would be nothing to check `exp` against but the
        // kiosk's wall clock, so the streamer refuses to start.
        assert_eq!(parse("bundle/bundle-missing-anchor.json"), Err(exit::BUNDLE_INVALID));
        assert_eq!(parse("bundle/bundle-version-mismatch.json"), Err(exit::VERSION_MISMATCH));
        // A release build parses no `overrides` at all; under `testhooks` the
        // same vector is a valid bundle, which is the point of the feature.
        #[cfg(not(feature = "testhooks"))]
        assert_eq!(
            parse("bundle/bundle-overrides-no-testhooks.json"),
            Err(exit::BUNDLE_INVALID)
        );
        // Not a bundle at all.
        assert_eq!(verdict("{"), Err(exit::BUNDLE_INVALID));
        assert_eq!(verdict(""), Err(exit::BUNDLE_INVALID));
    }

    /// Every event this session emits, encoded the way the golden vectors spell
    /// it — field order included, because the service reads these as lines.
    #[test]
    fn the_stdout_events_are_written_exactly_as_the_golden_vectors_spell_them() {
        let path = vectors().join("pipe/pipe-stdout-events.ndjson");
        let file = fs::read_to_string(&path).expect("the pipe vector is present");
        let mut seen = 0;
        for line in file.lines().filter(|line| !line.trim().is_empty()) {
            let event: Event = serde_json::from_str(line).expect("a golden event parses");
            let mut out = Vec::new();
            emit(&mut out, &event).expect("writing to a vec never fails");
            assert_eq!(String::from_utf8(out).expect("utf-8"), format!("{line}\n"));
            seen += 1;
        }
        assert_eq!(seen, 6, "ready, viewer_joined, status, sas_request, viewer_left, exiting");
    }

    #[test]
    fn the_wire_spelling_of_hevc_is_not_the_serde_spelling() {
        // `web/lib/swoop/protocol.ts` and the golden pipe vectors both say
        // `hevc`; `Codec`'s own serde spelling is `h265`.
        assert_eq!(codec_wire_name(Codec::H265), "hevc");
        assert_eq!(codec_wire_name(Codec::H264), "h264");
        assert_eq!(
            serde_json::to_string(&Codec::H265).expect("it serializes"),
            "\"h265\""
        );
    }

    #[test]
    fn the_codec_is_the_hosts_preference_narrowed_by_the_offer() {
        let both = [Codec::H265, Codec::H264];
        let h264_only = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n";
        let with_h265 = "m=video 9 UDP/TLS/RTP/SAVPF 96 98\r\na=rtpmap:96 H264/90000\r\na=rtpmap:98 H265/90000\r\n";

        assert_eq!(pick_codec(with_h265, &both), Some(Codec::H265));
        // A browser that cannot decode hevc is not handed one.
        assert_eq!(pick_codec(h264_only, &both), Some(Codec::H264));
        // Nor is one this host cannot encode.
        assert_eq!(pick_codec(with_h265, &[Codec::H264]), Some(Codec::H264));
        assert_eq!(pick_codec("m=video 9 UDP/TLS/RTP/SAVPF 96\r\n", &both), None);
        assert_eq!(pick_codec(with_h265, &[]), None);
    }

    #[test]
    fn limits_are_per_codec_because_the_caps_are() {
        let caps = vec![
            CodecCaps {
                codec: Codec::H265,
                max_width: 8192,
                max_height: 8192,
            },
            CodecCaps {
                codec: Codec::H264,
                max_width: 4096,
                max_height: 4096,
            },
        ];
        assert_eq!(
            limits_for(&caps, Codec::H264),
            Some(Limits {
                max_width: 4096,
                max_height: 4096
            })
        );
        assert_eq!(
            limits_for(&caps, Codec::H265),
            Some(Limits {
                max_width: 8192,
                max_height: 8192
            })
        );
        assert_eq!(limits_for(&[], Codec::H264), None);
    }

    /// Two 4K panels side by side is 7680 wide, over H.264's 4096: without the
    /// downscale a Mosaic box cannot stream at all.
    #[test]
    fn an_over_cap_canvas_is_downscaled_rather_than_refused() {
        let caps = vec![CodecCaps {
            codec: Codec::H264,
            max_width: 4096,
            max_height: 4096,
        }];
        let limits = limits_for(&caps, Codec::H264).expect("h264 caps");
        let plan = crate::gpu::scale::plan((7680, 2160), limits);
        assert_eq!(
            plan,
            crate::gpu::scale::Plan::Downscale {
                width: 4096,
                height: 1152
            }
        );
        assert_eq!(plan.factor(7680), Some(4096.0 / 7680.0));
    }

    /// §4's coalescing, which is the whole of v1's loss recovery: a receiver
    /// that lost a frame asks once per record until the keyframe arrives, and
    /// answering each of them costs about twenty delta frames.
    #[test]
    fn a_burst_of_idr_requests_produces_one_keyframe() {
        let mut idr = IdrPolicy::new();
        let start = Instant::now();
        let asked: usize = (0..10)
            .filter(|i| idr.request(start + Duration::from_millis(*i * 10)))
            .count();
        assert_eq!(asked, 1, "ten requests inside the cooldown are one keyframe");

        // Still one: the sticky state holds past the cooldown until the irap
        // it was asking for is actually on the wire.
        assert!(!idr.request(start + IDR_COOLDOWN + Duration::from_millis(1)));
        idr.answered();
        assert!(idr.request(start + IDR_COOLDOWN + Duration::from_millis(2)));
    }

    /// Exponential, capped at the top of PROTOCOL.md §4's range, and reset by a
    /// quiet stream — a session that recovered should not carry the last loss
    /// storm's window for the rest of its life.
    #[test]
    fn the_idr_window_backs_off_and_a_quiet_stream_resets_it() {
        let mut idr = IdrPolicy::new();
        let mut at = Instant::now();
        assert!(idr.request(at));
        idr.answered();

        // 250 ms → 500 ms, and no further: the range is 250–500.
        at += IDR_COOLDOWN;
        assert!(idr.request(at));
        idr.answered();
        at += IDR_COOLDOWN;
        assert!(!idr.request(at), "the window is 500 ms now");
        at += IDR_COOLDOWN;
        assert!(idr.request(at));
        idr.answered();
        at += IDR_COOLDOWN_MAX;
        assert!(idr.request(at), "capped at 500 ms rather than climbing");
        idr.answered();

        // Quiet, then a new event: back at the bottom of the range.
        at += Duration::from_secs(6);
        assert!(idr.request(at));
        idr.answered();
        at += IDR_COOLDOWN;
        assert!(idr.request(at), "the backoff reset with the quiet stream");
    }

    /// `status.idrs` is the count of keyframes actually forced, not of requests
    /// arriving — a receiver in a loss storm asks on every record, and a count
    /// of the asking would say nothing about what the link paid for.
    #[test]
    fn the_idr_count_is_the_keyframes_forced_and_not_the_requests_made() {
        let mut idr = IdrPolicy::new();
        let start = Instant::now();
        assert_eq!(idr.forced(), 0, "a session that lost nothing forced nothing");
        for i in 0..10 {
            idr.request(start + Duration::from_millis(i * 10));
        }
        assert_eq!(idr.forced(), 1, "ten requests inside the cooldown are one keyframe");

        idr.answered();
        assert!(idr.request(start + IDR_COOLDOWN + Duration::from_millis(1)));
        assert_eq!(idr.forced(), 2);
    }

    /// The encoder the request was sent to can be rebuilt out from under it, so
    /// "awaiting" cannot be a state the session never leaves.
    #[test]
    fn an_unanswered_idr_request_does_not_stick_forever() {
        let mut idr = IdrPolicy::new();
        let start = Instant::now();
        assert!(idr.request(start));
        assert!(!idr.request(start + Duration::from_millis(900)));
        assert!(idr.request(start + Duration::from_millis(1_100)));
    }

    /// A hardware decoder handed nothing stalls, and Desktop Duplication
    /// answers `WAIT_TIMEOUT` for as long as the desktop is still — a real
    /// output measured 0.28 frames/s. The loop below is that case: every
    /// acquire times out, and the floor is the only thing that feeds the
    /// encoder.
    #[test]
    fn the_floor_feeds_the_encoder_on_a_timeout_only_capture_loop() {
        let start = Instant::now();
        let mut floor = FloorTimer::new(start);
        let mut fed = 0;
        // Two and a half seconds of 8 ms acquires, none of which carried a
        // frame.
        for tick in 1..=300u32 {
            let now = start + Duration::from_millis(u64::from(tick) * 8);
            if floor.due(now) {
                fed += 1;
                floor.fed(now);
            }
        }
        assert_eq!(fed, 4, "2.4 s at the 500 ms floor is four repeats");

        // A real frame resets it: the floor is a floor, not a second stream.
        let now = start + Duration::from_secs(3);
        floor.fed(now);
        assert!(!floor.due(now + Duration::from_millis(499)));
        assert!(floor.due(now + FLOOR_INTERVAL));
    }

    /// §5: the attempt is reported, not every message behind it — a held key
    /// repeats at 30 Hz, and a viewer that lost control mid-chord would
    /// otherwise write a log line for each repeat. The drop itself is
    /// `Live::on_input`, which cannot be unit tested without a live room.
    #[test]
    fn a_viewer_without_ctl_is_reported_once_and_counted_every_time() {
        let mut denials = Denials::default();
        assert!(denials.note("viewer_a"));
        for _ in 0..30 {
            assert!(!denials.note("viewer_a"));
        }
        assert_eq!(denials.count(), 31);

        // The next viewer's first attempt is its own event.
        denials.forget();
        assert!(denials.note("viewer_b"));
    }

    /// §6 keeps the process alive for the linger after the last viewer leaves,
    /// and the indicator is already down — so the departure stops capture and
    /// the exit finds nothing left to stop.
    #[test]
    fn capture_stops_at_the_last_departure_and_not_at_the_exit() {
        let mut gate = CaptureGate::open();
        // The duplication is open before the first viewer: `ready` reports the
        // size it found.
        assert!(!gate.set(true), "a joiner does not re-open what is open");
        assert!(gate.set(false), "the departure pauses capture");
        assert!(!gate.set(false), "the exit has nothing left to pause");
        assert!(gate.set(true), "the next viewer resumes it");
    }

    #[test]
    fn the_outbox_refuses_past_its_allowance_and_keeps_what_it_took() {
        let now = Instant::now();
        let mut out = Outbox::new(now);
        assert!(out.send(Channel::SwoopControl, vec![0u8; OUTBOX_BURST_BYTES]));
        assert!(
            !out.send(Channel::SwoopControl, vec![0u8; 1]),
            "the allowance is spent"
        );
        assert_eq!(out.refused(), 1);
        let taken = out.take();
        assert_eq!(taken.len(), 1, "nothing queued was dropped for the refusal");
        assert_eq!(taken[0].channel, Channel::SwoopControl);
        assert!(out.take().is_empty());
    }

    /// A record bigger than the burst could never be sent, so §5's largest —
    /// a 16 KiB clipboard chunk, about 22 KiB base64 in json — has to fit.
    #[test]
    fn a_clipboard_chunk_fits_the_burst() {
        let chunk = crate::signal::messages::channel::CLIPBOARD_CHUNK_MAX_BYTES as usize;
        // base64 is 4 bytes per 3, plus json envelope.
        assert!(chunk.div_ceil(3) * 4 + 512 < OUTBOX_BURST_BYTES);
    }

    #[test]
    fn the_outbox_refills_at_its_rate_and_stops_at_the_burst() {
        let start = Instant::now();
        let mut out = Outbox::new(start);
        assert!(out.send(Channel::SwoopControl, vec![0u8; OUTBOX_BURST_BYTES]));
        let _ = out.take();

        // A turn too short to earn a byte must not throw its remainder away:
        // a hundred of them still add up to the rate.
        for i in 1..=100u32 {
            out.refill(start + Duration::from_micros(i as u64));
        }
        assert!(
            out.send(Channel::SwoopControl, vec![0u8; 50]),
            "100 us at the refill rate is about 52 bytes"
        );

        out.refill(start + Duration::from_secs(10));
        assert!(out.send(Channel::SwoopControl, vec![0u8; OUTBOX_BURST_BYTES]));
        assert!(
            !out.send(Channel::SwoopControl, vec![0u8; 1]),
            "ten idle seconds still leave only one burst"
        );
    }

    /// A request is an edge. A feature with a queue of them has stopped
    /// producing edges, and the ceiling refuses rather than letting the session
    /// act on a backlog — the refused one is still the feature's to offer again.
    #[test]
    fn the_outbox_refuses_requests_past_its_ceiling() {
        let mut out = Outbox::new(Instant::now());
        for _ in 0..MAX_PENDING_REQUESTS {
            assert!(out.request(FeatureRequest::Sas));
        }
        assert!(!out.request(FeatureRequest::Sas), "the ceiling is the ceiling");
        assert_eq!(out.refused(), 1);

        let taken = out.take_requests();
        assert_eq!(taken.len(), MAX_PENDING_REQUESTS);
        assert!(out.take_requests().is_empty());
        assert!(out.request(FeatureRequest::Sas), "drained, so there is room");
    }

    /// The outbox's two queues are independent: a feature that filled its
    /// record allowance can still ask for a desktop switch, and a request
    /// cannot eat the allowance a clipboard chunk needs.
    #[test]
    fn records_and_requests_do_not_share_a_budget() {
        let mut out = Outbox::new(Instant::now());
        assert!(out.send(Channel::SwoopControl, vec![0u8; OUTBOX_BURST_BYTES]));
        assert!(out.request(FeatureRequest::Sas));
        assert_eq!(out.take().len(), 1);
        assert_eq!(out.take_requests().len(), 1);
    }
}
