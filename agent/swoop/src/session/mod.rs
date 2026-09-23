//! The session loop: the `run` verb, end to end, for every viewer on the box.
//!
//! This is the assembly point. Every module below it is already written and
//! tested on its own; nothing here re-implements any of them, and where one of
//! them documents a call site (`Duplication::next_frame_with`,
//! `Governor::on_report`, `Roster::leave`) this file is what that comment was
//! written for.
//!
//! # One capture, N viewers, min(classes, budget) encoders
//!
//! plan.md D14, wired here and decided nowhere else in this file:
//!
//! - **admission** is [`tiers::admit`] against the machine's measured encoder
//!   budget ([`crate::encode::select::budget`]), so the viewer count can never
//!   exceed the encode sessions the box actually has.
//! - **who is here, and what they may do** is [`crate::viewers::roster::Roster`].
//!   `ctl` arrives through `Roster::verify` over a claim set this host verified
//!   itself and by no other road — there is deliberately no setter.
//! - **the encoders** are [`tiers::plan`]: one per tier, a tier per codec class,
//!   fed at the narrowest of its members' ladder rungs. Because admission caps
//!   viewers at the budget and there are two codec classes, the count is always
//!   the classes present and [`tiers::TierPlan::downgraded`] is always empty —
//!   which is the case D14 is about. See [`tier_encodes`].
//! - **keyframes** are [`tiers::TierKeyframes`]: a join and every PLI inside one
//!   cooldown cost the *tier* one IRAP, not one per viewer.
//! - **rate** is one [`crate::transport::governor::UplinkBudget`] over N
//!   per-viewer governors, controllers floored before watchers.
//!
//! What stays per viewer is everything a peer owns: its `RtcPeer`, its
//! `Governor`, its `IcePolicy` and its `FrameSequencer` — an RTP timestamp and a
//! frame-id run belong to one track, so one shared sequencer would put a
//! dangling reference on every other viewer's wire.
//!
//! # Threads, and why there are four
//!
//! Desktop Duplication is vsync-locked and paces its own thread by blocking in
//! `AcquireNextFrame` (spike 0.8), str0m wants a thread that owns its socket,
//! `SendInput` reaches only the desktop its *calling thread* is attached to,
//! and a read on stdin blocks until the service writes. Those are four
//! different blocking disciplines, so they are four threads:
//!
//! - **session** (this thread) — the signaling socket, every peer connection,
//!   the governors, the roster, the shared input and every stdout event. The
//!   only writer of stdout.
//! - **capture** — duplication, the cursor observer, the downscaler and the
//!   encoder. Everything that touches a GPU texture stays here, because a
//!   `Frame` handle is only valid until the next acquire and `Duplication` is
//!   not `Send`. Encoded bytes leave over a bounded channel. It opens the
//!   duplication per pass rather than once, because the session pauses it.
//! - **input** — its own `DesktopWatcher` and the `SendInput` injector.
//!   Injection is off the capture thread so a key press is not queued behind an
//!   8 ms acquire and an 8 ms encode. The held-key sets are **not** here: they
//!   are per viewer and the gate on them is the roster, so
//!   [`crate::viewers::SharedInput`] lives on the session thread and what
//!   reaches this one is already-resolved [`crate::input::InputEvent`]s.
//! - **stdin** — control lines. EOF means the service is gone (§6).
//!
//! # The four `release_all` triggers (input/mod.rs)
//!
//! Stuck keys are the top user-visible bug of every remote-desktop product, so
//! all four are wired, and every one of them goes through
//! [`SharedInput::release`](crate::viewers::SharedInput::release) for **one**
//! viewer — releasing the viewer that just left must not lift the shift the
//! other controller is still holding:
//!
//! - **viewer disconnect** (bye, kick, dead peer, lapsed lease) — `on_viewer_gone`.
//! - **control revoked** — a re-verified token that no longer carries `ctl`.
//! - **idle timeout / session end** — `teardown`, which releases every viewer.
//! - **desktop switch** — the input thread's watcher notices it and reports it;
//!   the session owns the held sets, so it answers with the ups.
//!
//! # Loss recovery, and the floor
//!
//! One keyframe per burst of requests ([`IdrPolicy`], one per tier behind
//! [`tiers::TierKeyframes`]): the window starts at
//! PROTOCOL.md §4's 250 ms, doubles to the 500 ms top of that range while the
//! keyframes are not fixing it, and resets on a quiet stream. The sticky
//! "awaiting" flag is what makes a burst *one* keyframe rather than one each —
//! a receiver that lost a frame asks once per record until an irap arrives.
//! Reference invalidation stays out of v1.
//!
//! The browser's pli is not the only trigger. A frame the send pacer refuses
//! ([`crate::transport::pacer`]) never reaches the decoder either, and the hole
//! it leaves in the reference chain is the same hole a lost packet leaves — so
//! a refusal asks for a keyframe through the same [`IdrPolicy`], which is what
//! keeps a storm of refusals to one keyframe per window.
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
//! the swoop page for this machine, then `status` every two seconds. Open a
//! **second** browser and there is a second `viewer_joined` and no
//! `viewer_left` — both pictures run, `status.viewers` reads 2, and `tiers`
//! appears only if the two browsers negotiated different codecs. Ctrl-C, or
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

/// §5's control gate for the `swoop-control` channel, host side: a viewer
/// without `ctl` that sends something gated is dropped and the attempt is
/// reported — once per viewer, because the attempt is as often a held key
/// repeating at 30 Hz as a deliberate one.
///
/// `swoop-input`'s refusals are [`crate::viewers::SharedInput`]'s, which
/// re-reports a viewer that keeps at it; this channel carries deliberate
/// messages rather than a key repeat, so one line per viewer is the whole of it.
#[derive(Debug, Default)]
pub struct Denials {
    /// Per viewer, not one slot: one viewer's report must never suppress
    /// another's, which is exactly what a single slot did.
    reported: std::collections::BTreeSet<String>,
    count: u64,
}

impl Denials {
    /// `true` the first time this viewer is refused, which is the attempt worth
    /// reporting.
    pub fn note(&mut self, viewer: &str) -> bool {
        self.count += 1;
        self.reported.insert(viewer.to_owned())
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    /// A departure clears that viewer's report, so a browser that reconnects
    /// with the same id gets its own first event rather than silence.
    pub fn forget(&mut self, viewer: &str) {
        self.reported.remove(viewer);
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

/// The one estimate of this machine's uplink, split across every viewer by
/// [`UplinkBudget`](crate::transport::governor::UplinkBudget).
///
/// Nothing measures an uplink yet — `governor.rs`'s own head says so and says
/// it never will — so this is the top of the quality menu: the most a single
/// viewer can ask for. One viewer is therefore never capped by the split, which
/// is exactly the behaviour before it existed, and N viewers divide a fixed pie
/// instead of each probing the whole of one bottleneck. A real estimate arriving
/// later changes this number and nothing else.
pub const HOST_UPLINK_ESTIMATE_BPS: u32 =
    quality::BITRATE_CAPS_BPS[quality::BITRATE_CAPS_BPS.len() - 1];

/// What the session does with one `viewer-join` the room admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Joining {
    /// Already on the roster. A browser that re-offers after an ICE restart is
    /// admitted again by the room and is **not** a second viewer.
    Known,
    Admit,
    /// No encode session left for it (D14). Audited, never silent.
    Refuse(tiers::BudgetRefusal),
}

/// The admission rule, whole. Pure so the one decision that used to be an
/// unconditional bye is testable without a room.
pub fn on_join(viewer: &str, present: &[String], encoder_budget: u32) -> Joining {
    if present.iter().any(|id| id == viewer) {
        return Joining::Known;
    }
    match tiers::admit(present.len() as u32, encoder_budget) {
        Ok(()) => Joining::Admit,
        Err(refusal) => Joining::Refuse(refusal),
    }
}

/// One tier's encoder, as the capture thread is asked for it.
///
/// `codec` is the tier key, so a frame that comes back naming a codec names the
/// tier that produced it and the viewers it is fanned out to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TierEncode {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub bitrate_bps: u32,
    pub fps: u32,
}

/// Where one viewer's rate governor currently stands. The live half of
/// [`tiers::TierViewer`]: that carries the *ceiling* a rate class is read from,
/// this carries the rung the ladder has actually descended to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewerRate {
    pub viewer_id: String,
    /// `Governor::target_bps`.
    pub target_bps: u32,
    /// `Governor::rung`.
    pub rung: quality::QualityRung,
}

/// One encoder per tier, sized and paced for the **narrowest** of its members on
/// every axis — the rule [`tiers::Tier::ceiling`] states, read off each member's
/// live ladder rung because the rung is what actuates and never sits above the
/// ceiling that tier was planned from.
///
/// A tier whose members have all gone, or whose codec this backend has no limits
/// for, yields no encoder rather than one nobody watches.
pub fn tier_encodes(
    plan: &tiers::TierPlan,
    rates: &[ViewerRate],
    caps: &[CodecCaps],
    source: (u32, u32),
) -> Vec<TierEncode> {
    plan.tiers
        .iter()
        .filter_map(|tier| {
            let members = || {
                tier.viewers
                    .iter()
                    .filter_map(|id| rates.iter().find(|rate| rate.viewer_id == *id))
            };
            let bitrate_bps = members().map(|rate| rate.target_bps).min()?;
            let fps = members().map(|rate| rate.rung.fps).min()?;
            // `Native` is no cap at all, so it loses to any rung that names a
            // height — the same ordering `tiers::narrowest` uses.
            let resolution = members()
                .map(|rate| rate.rung.resolution)
                .min_by_key(|cap| cap.max_height().unwrap_or(u32::MAX))?;
            let limits = resolution.narrow(limits_for(caps, tier.codec)?);
            let (width, height) = match crate::gpu::scale::plan(source, limits) {
                crate::gpu::scale::Plan::AsIs => source,
                crate::gpu::scale::Plan::Downscale { width, height } => (width, height),
                // Degenerate canvas. `on_offer` refuses the viewer on this
                // before a peer exists; there is nothing left to encode here.
                crate::gpu::scale::Plan::Refuse => return None,
            };
            Some(TierEncode {
                codec: tier.codec,
                width,
                height,
                bitrate_bps,
                fps,
            })
        })
        .collect()
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
        codec_wire_name, limits_for, pick_codec, tier_encodes, tiers, CaptureGate, Denials,
        Feature, FeatureRequest, FeatureStatus, FloorTimer, Joining, Outbox, SessionHandle,
        TierEncode, ViewerRate, HOST_UPLINK_ESTIMATE_BPS,
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
    use crate::input::{InputEvent, Injector, PointerSpace, SendInputInjector};
    use crate::ipc::{
        self, Control, Event, Exit, ExitReason, GovernorPhase, HostEventKind, LeftReason, MediaPath,
    };
    use crate::bundle::Secret;
    use crate::signal::client::{Effect, SignalTransport};
    use crate::signal::messages::channel::{
        self, Channel, Control as ControlMessage, Feedback, Input as InputMessage,
    };
    use crate::signal::messages::Message;
    use crate::signal::{
        Denial, DenialReason, Handshake, Reaction, RetryPolicy, RoomSocket, SignalClient,
    };
    use crate::transport::framing::{flags, FrameCodec, FrameHeader, FrameSequencer, FrameStamps};
    use crate::transport::governor::{
        Governor, GovernorConfig, GovernorState, UplinkBudget, UplinkClaim,
    };
    use crate::transport::ice_policy::{
        admit_remote, ifwatch::InterfaceWatcher, Admission, DropReason, IceAction, IceEvent,
        IcePolicy, SystemResolver,
    };
    use crate::transport::rtc::{qpc_hz, PeerConfig, PeerEvent, PeerState, RtcPeer};
    use crate::transport::VideoSink;
    use crate::viewers::lease::LeaseLedger;
    use crate::viewers::roster::Roster;
    use crate::viewers::SharedInput;

    use super::quality::Ceiling;
    use super::tiers::{TierKeyframes, TierPlan, TierViewer};

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
        /// Trigger 4 of `release_all`: the input thread's watcher followed the
        /// desktop. The held sets are the session's, so the ups are too.
        DesktopSwitched,
    }

    /// Session → capture.
    enum ToCapture {
        /// The whole tier set: one encoder per entry, keyed by codec class.
        ///
        /// A tier whose codec is already running and whose size is unchanged
        /// keeps its encoder; a **size** change drops it, because a new size is
        /// a new encoder whose first frame is an IRAP and nothing from the old
        /// one may follow it. Bitrate and frame rate move in place. A codec not
        /// named here has lost its last viewer and its encoder closes.
        Tiers(Vec<TierEncode>),
        /// Force one keyframe out of one tier's encoder.
        Idr(Codec),
        /// Re-send the pointer whole. A viewer that has just arrived has an
        /// empty shape cache, and the tracker only emits on a change.
        CursorSnapshot,
        /// Duplicate this output instead. The duplication, the encoders and the
        /// scalers are all pinned to the old one, so this ends the pass rather
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
    ///
    /// Already-resolved events, never a viewer's message: the held sets are per
    /// viewer and the gate on them is the roster, both of which live on the
    /// session thread ([`SharedInput`]). This thread injects and nothing else.
    enum ToInput {
        Inject(Vec<InputEvent>),
        /// Normalise absolute coordinates against this display instead, after
        /// a capture retarget.
        Space(PointerSpace),
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
        // D14's admission cap and tier count, measured here because `caps` is
        // about to be handed to the capture thread.
        let encoder_budget = select::budget(&caps);
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
                encoder_budget,
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
        encoder_budget: u32,
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
            signal_url: bundle.signal_url.clone(),
            site: bundle.site.clone(),
            machine: bundle.machine.clone(),
            out: io::stdout(),
            viewers: Vec::new(),
            roster: Roster::new(bundle.ctl),
            input: SharedInput::new(),
            plan: TierPlan::default(),
            keyframes: TierKeyframes::new(),
            uplink: UplinkBudget::new(HOST_UPLINK_ESTIMATE_BPS),
            encoder_budget: w.encoder_budget,
            tiers: Vec::new(),
            tiers_sent: Vec::new(),
            clock: w.clock,
            started: w.started,
            source: w.source,
            codecs: w.codecs,
            codec_caps: w.codec_caps,
            leases: LeaseLedger::from_bundle(bundle),
            capture_tx: w.capture_tx,
            input_tx: w.input_tx,
            worker_rx: w.worker_rx,
            service_rx: w.service_rx,
            resolver_tx: w.resolver_tx,
            resolved_rx: w.resolved_rx,
            ifwatch: match InterfaceWatcher::start() {
                Ok(watcher) => Some(watcher),
                Err(rc) => {
                    ::log::warn!("swoop: no interface-change notifications (win32 {rc})");
                    None
                }
            },
            bind_addr: local_bind_addr(),
            idle_since: Some(w.started),
            capture: CaptureGate::open(),
            denials: Denials::default(),
            last_report: w.started,
            last_status: w.started,
            encoder: None,
            display: 0,
            sas_pending: None,
            control_viewer: None,
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
        ::log::info!(
            "swoop: up to {} viewer(s), one encoder per codec class",
            live.encoder_budget.max(1)
        );
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
        /// For a re-dial with a fresh token (`Control::Token`): the room does
        /// not move, only the credential does.
        signal_url: String,
        site: String,
        machine: String,
        out: io::Stdout,
        /// Every viewer's peer and its own rate control, in join order.
        viewers: Vec<Viewer>,
        /// Who is here and what each one may do. The only road to `ctl`.
        roster: Roster,
        /// Per-viewer held keys, last-input-wins, and §5's refusal reporting.
        input: SharedInput,
        /// The current assignment of viewers to encoders (D14). Recomputed by
        /// [`Live::retier`] on every change to the roster or the ladders.
        plan: TierPlan,
        /// One [`IdrPolicy`](super::IdrPolicy) per tier: a join and every PLI
        /// inside the cooldown cost that tier one IRAP between them.
        keyframes: TierKeyframes,
        /// One estimate of this machine's uplink, split across the viewers.
        uplink: UplinkBudget,
        /// `probe`'s measured concurrent encode sessions: the admission cap and
        /// the ceiling on the tier count.
        encoder_budget: u32,
        /// The current plan's encoders, and where `hello-host` reads a viewer's
        /// encoded size from.
        tiers: Vec<TierEncode>,
        /// What capture was actually told, which is not always the same thing:
        /// the message is a `try_send` and a busy capture thread refuses it. A
        /// report that moves nothing sends nothing; a refused one is offered
        /// again on the next.
        tiers_sent: Vec<TierEncode>,
        clock: HostClock,
        started: Instant,
        /// The captured texture's size.
        source: (u32, u32),
        codecs: Vec<Codec>,
        codec_caps: Vec<CodecCaps>,
        /// §10's lease per viewer: when it lapses, in the bundle's own time
        /// base. `viewers/lease.rs` does the bookkeeping; `sweep_leases` is
        /// what this session owes a lease that did.
        leases: LeaseLedger,
        capture_tx: Sender<ToCapture>,
        input_tx: Sender<ToInput>,
        worker_rx: Receiver<FromWorker>,
        service_rx: Receiver<FromService>,
        resolver_tx: Sender<ToResolver>,
        resolved_rx: Receiver<FromResolver>,
        /// `NotifyIpInterfaceChange`, as a flag this loop reads. A machine that
        /// would not let us register carries on without the trigger rather than
        /// failing the session.
        ifwatch: Option<InterfaceWatcher>,
        bind_addr: SocketAddr,
        idle_since: Option<Instant>,
        capture: CaptureGate,
        denials: Denials,
        last_report: Instant,
        last_status: Instant,
        /// The backend the capture thread's encoders are open on, as the
        /// selection chain named it. `None` until the first encoder opens —
        /// a session with no viewer has no encoder and nothing to report.
        encoder: Option<&'static str>,
        /// Which output is being captured, in the numbering `hello-host`
        /// advertises. Zero until a feature picks another one.
        display: u32,
        /// The feature whose [`FeatureRequest::Sas`] is outstanding, by name.
        /// `sas_result` goes to it and to nothing else.
        sas_pending: Option<&'static str>,
        /// Whose `swoop-control` payload the features were last offered.
        /// [`Feature::on_message`] carries the `ctl` verdict but not the id, so
        /// this is how a [`FeatureRequest`] raised from inside one — a
        /// `sas_request`, a clipboard audit row — names the viewer behind it.
        control_viewer: Option<String>,
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

    /// One viewer's peer and everything that belongs to that one track.
    ///
    /// `ctl` is deliberately **not** here: it is the roster's, from a token this
    /// host verified, and a second copy is a second thing to get wrong.
    struct Viewer {
        id: String,
        /// The codec its answer negotiated, which is also the tier it is served
        /// from. Fixed at `bind`: the host answers and never offers, so a
        /// viewer's payload type cannot be renegotiated afterwards.
        codec: Codec,
        announced: bool,
        hello_sent: bool,
        peer: Option<RtcPeer>,
        /// Per viewer, because N viewers on one machine are N independent
        /// controllers. `UplinkBudget` is what stops them each probing the whole
        /// of one bottleneck.
        governor: Governor,
        /// §7.5's ICE decisions, per peer: a promotion attempt belongs to one
        /// ICE agent and a new peer gets a new one.
        ice: IcePolicy,
        /// Per track. One shared sequencer would mark another viewer's delta as
        /// a recovery point the moment this one's pacer refused a frame.
        sequencer: FrameSequencer,
        /// The last encoded size this viewer was sent, so a change sets
        /// `RESOLUTION_CHANGED` exactly once on its wire.
        last_size: Option<(u16, u16)>,
        /// `peer.stats().frames_written` at the last `status`.
        frames_at_status: u64,
    }

    impl Viewer {
        fn new(id: String) -> Self {
            Self {
                id,
                // The baseline every browser decodes, until its answer names
                // one: a viewer counted before that can never invent a tier.
                codec: Codec::H264,
                announced: false,
                hello_sent: false,
                peer: None,
                governor: Governor::new(GovernorConfig::new(DEFAULT_BITRATE_BPS)),
                ice: IcePolicy::new(),
                sequencer: FrameSequencer::new(),
                last_size: None,
                frames_at_status: 0,
            }
        }

        fn connected(&self) -> bool {
            self.peer
                .as_ref()
                .is_some_and(|peer| peer.state() == PeerState::Connected)
        }
    }

    impl Live {
        fn viewer(&self, id: &str) -> Option<&Viewer> {
            self.viewers.iter().find(|v| v.id == id)
        }

        fn viewer_mut(&mut self, id: &str) -> Option<&mut Viewer> {
            self.viewers.iter_mut().find(|v| v.id == id)
        }

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
                if let Some(end) = self.pump_peers() {
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

        /// How long after a re-dial the room's replayed joins are expected.
        const REPLAY_WINDOW: Duration = Duration::from_secs(5);

        /// A fresh host token from the service: dial the room again with it and
        /// swap the socket. The old one closes on drop, and the room announces
        /// nothing for a host that goes, so every viewer keeps its peer and its
        /// picture; the room replays their joins, which the client already
        /// knows. A failed dial keeps the old socket — it works until its token
        /// expires, and the service retries the mint before then.
        fn redial(&mut self, host_token: &Secret) {
            let handshake = match Handshake::with_token(
                &self.signal_url,
                &self.site,
                &self.machine,
                host_token.expose(),
            ) {
                Ok(handshake) => handshake,
                Err(e) => {
                    ::log::warn!("swoop: token refresh refused, room unchanged ({e})");
                    return;
                }
            };
            match RoomSocket::dial(&handshake) {
                Ok(socket) => {
                    self.socket = socket;
                    self.client.expect_replay(Instant::now() + Self::REPLAY_WINDOW);
                    ::log::info!("swoop: room re-dialed with a fresh host token");
                }
                Err(e) => {
                    ::log::warn!("swoop: re-dial with the fresh token failed ({e}); keeping the old socket");
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
                    Ok(FromService::Control(Control::Token { host_token })) => {
                        self.redial(&host_token);
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
            self.viewers.iter().any(|v| v.id == viewer)
        }

        fn on_admitted(&mut self, viewer: String, ctl: bool) {
            let present: Vec<String> = self.viewers.iter().map(|v| v.id.clone()).collect();
            match super::on_join(&viewer, &present, self.encoder_budget) {
                // A re-offer after an ice restart is admitted again by the room
                // and is not a second viewer.
                Joining::Known => return,
                Joining::Refuse(refusal) => {
                    ::log::warn!("swoop: viewer {viewer} refused, {refusal}");
                    self.host_event(
                        refusal.kind(),
                        Some(viewer.clone()),
                        Some(refusal.reason().to_owned()),
                    );
                    let effects = self.client.end_viewer(&viewer, LeftReason::Bye);
                    let _ = self.apply(effects);
                    return;
                }
                Joining::Admit => {}
            }
            ::log::info!("swoop: viewer {viewer} admitted (room ctl {ctl})");
            self.idle_since = None;
            if self.capture.set(true) {
                let _ = self.capture_tx.try_send(ToCapture::Resume);
            }
            // Watch-only: the room's `ctl` reaches no field here, and there is
            // no setter for one — only `Roster::verify` over a verified token.
            self.roster.join(&viewer);
            self.viewers.push(Viewer::new(viewer.clone()));
            let ready = self.client.host_ready(Some(&viewer));
            self.send(&ready);
            self.publish_roster();
        }

        /// §5's `roster`, whole on every change rather than as a delta — a
        /// viewer that joined late has no earlier state to apply one to.
        /// `swoop-control` is ordered and reliable, so a departure can never be
        /// the frame that goes missing and leaves a ghost in everyone's list.
        fn publish_roster(&mut self) {
            let presence = self.roster.presence(self.clock.now_us() as i64);
            self.broadcast(None, Channel::SwoopControl, &presence);
        }

        /// One host → viewer record to every connected viewer, optionally
        /// skipping one — §5's `vpos` is never sent back to the controller it
        /// came from, which has its own cursor.
        ///
        /// Connected only: a record queued against a peer that is still
        /// negotiating sits in that peer's out-queue behind nothing, and the
        /// state it carries is re-sent whole when that viewer's channel opens.
        fn broadcast<T: serde::Serialize>(
            &mut self,
            skip: Option<&str>,
            channel: Channel,
            message: &T,
        ) {
            for at in 0..self.viewers.len() {
                if !self.viewers[at].connected() || skip == Some(self.viewers[at].id.as_str()) {
                    continue;
                }
                self.write_json_to(at, channel, message);
            }
        }

        fn on_offer(&mut self, viewer: &str, sdp: &str) {
            let Some(at) = self.viewers.iter().position(|v| v.id == viewer) else {
                return;
            };
            if self.viewers[at].peer.is_none() && !self.bind_peer(at, sdp) {
                return;
            }

            // Every later offer is an ICE restart; str0m keeps its candidates.
            let answer = match self.viewers[at]
                .peer
                .as_mut()
                .expect("bound above")
                .accept_offer(sdp)
            {
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

            let announce = {
                let v = &mut self.viewers[at];
                (!v.announced).then(|| {
                    v.announced = true;
                    (v.id.clone(), v.codec)
                })
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

        /// This viewer's first offer: pick its codec, bind its peer, and put the
        /// tier it lands on in front of the capture thread. `false` means the
        /// viewer was refused and is already on its way out.
        fn bind_peer(&mut self, at: usize, sdp: &str) -> bool {
            let viewer = self.viewers[at].id.clone();
            let Some(codec) = pick_codec(sdp, &self.codecs) else {
                ::log::error!("swoop: the offer carries no codec this host can encode");
                let effects = self.client.end_viewer(&viewer, LeftReason::Bye);
                let _ = self.apply(effects);
                return false;
            };
            // The widest this codec allows, before any ladder rung narrows it:
            // a refusal here is a canvas with no legal encode size at all. Two
            // 4K panels side by side is 7680 wide, over H.264's 4096, and
            // without the downscale a Mosaic box cannot stream at all.
            let Some(limits) = limits_for(&self.codec_caps, codec) else {
                ::log::error!("swoop: no limits for {codec:?}");
                return false;
            };
            if scale::plan(self.source, limits) == Plan::Refuse {
                ::log::error!(
                    "swoop: {}x{} has no legal encode size",
                    self.source.0,
                    self.source.1
                );
                let effects = self.client.end_viewer(&viewer, LeftReason::Bye);
                let _ = self.apply(effects);
                return false;
            }
            let peer = match RtcPeer::bind(PeerConfig {
                bind_addr: self.bind_addr,
                codec,
                fps: TARGET_FPS,
                bitrate_bps: self.viewers[at].governor.target_bps(),
                qpc_hz: self.clock.hz,
                // Off, and it stays off: str0m installs its leaky-bucket
                // pacer with it, which the bake-off measured holding
                // 1015 ms p50 of queue with every loss counter at zero.
                enable_bwe: false,
            }) {
                Ok(peer) => peer,
                Err(e) => {
                    ::log::error!("swoop: could not bind the peer: {e}");
                    return false;
                }
            };
            self.viewers[at].peer = Some(peer);
            self.viewers[at].codec = codec;
            // §3's audio is a second RTP track, so it cannot ride the feature
            // outbox: the track is subscribed here, once per peer, and written
            // by the peer itself. A machine with no endpoint simply never puts
            // a packet on it.
            #[cfg(feature = "audio-opus")]
            self.viewers[at]
                .peer
                .as_mut()
                .expect("just bound")
                .set_audio_source(crate::audio::subscribe());
            let fingerprint = self.viewers[at]
                .peer
                .as_mut()
                .expect("just bound")
                .dtls_fingerprint();
            if let Err(e) = self.client.set_host_fingerprint(&fingerprint) {
                ::log::error!("swoop: local dtls fingerprint unusable: {e}");
                return false;
            }
            self.roster.set_codec(&viewer, codec);
            self.retier();
            ::log::info!(
                "swoop: {}x{} captured, viewer {viewer} on the {} tier",
                self.source.0,
                self.source.1,
                codec_wire_name(codec)
            );
            true
        }

        fn on_viewer_gone(&mut self, viewer: &str, reason: LeftReason) {
            let Some(at) = self.viewers.iter().position(|v| v.id == viewer) else {
                return;
            };
            // This viewer's held keys and nobody else's: releasing the one that
            // dropped mid-chord must not lift the shift another controller is
            // still holding. `SendInput` resets no keyboard state, so a
            // departure that skips this leaves those keys down forever.
            self.release_input(viewer);
            let mut gone = self.viewers.remove(at);
            // The peer, the governor, the ICE policy and the frame sequencer all
            // belong to that one track and go with it — a promotion attempt held
            // across would leave the next session on relay for good.
            if let Some(peer) = gone.peer.as_mut() {
                peer.disconnect();
            }
            self.roster.leave(viewer);
            self.denials.forget(viewer);
            // A feature's next request must not be attributed to the viewer that
            // just left.
            if self.control_viewer.as_deref() == Some(viewer) {
                self.control_viewer = None;
            }
            // A viewer that left by any other road than a lapse: a stale entry
            // would be swept as an expiry long after it went.
            self.leases.forget(viewer);
            if self.viewers.is_empty() {
                // At the last departure, not at the exit: the linger keeps the
                // process alive for another minute and the indicator is already
                // down. Never a blocking send — a capture thread inside a
                // re-duplication can take ten seconds to read its channel, and
                // the peers cannot wait that long for their next turn.
                if self.capture.set(false) {
                    let _ = self.capture_tx.try_send(ToCapture::Pause);
                }
                // The pause closed the encoders with the duplication, so §6's
                // quiet line stays the nine-field one it promises.
                self.encoder = None;
                self.idle_since = Some(Instant::now());
            }
            self.retier();
            self.publish_roster();
            let event = Event::ViewerLeft {
                sid: self.sid.clone(),
                viewer: viewer.to_owned(),
                reason,
            };
            self.emit(&event);
        }

        /// Everything one viewer is holding, released and injected. The single
        /// road out for a leave, a kick, a lapsed lease and a revoked `ctl`.
        fn release_input(&mut self, viewer: &str) {
            let events = self.input.release(viewer);
            self.inject_release(events);
        }

        /// A release is the one thing on the input channel that may not be
        /// dropped: `SendInput` resets no keyboard state, so an up that does not
        /// fit is a key held down on the machine forever. The channel is 256
        /// deep and drained every 20 ms by a thread that cannot block the way
        /// capture can, so this waits where `on_input` refuses.
        fn inject_release(&mut self, events: Vec<InputEvent>) {
            if events.is_empty() {
                return;
            }
            let _ = self.input_tx.send(ToInput::Inject(events));
        }

        fn pump_workers(&mut self) -> Option<(Exit, ExitReason)> {
            loop {
                match self.worker_rx.try_recv() {
                    Ok(FromWorker::Frame(frame)) => self.on_frame(*frame),
                    // The machine's own pointer, which is one thing however
                    // many people are watching (§5).
                    Ok(FromWorker::Cursor(message)) => {
                        self.broadcast(None, Channel::SwoopCursor, &message)
                    }
                    Ok(FromWorker::SourceSize { width, height }) => {
                        self.source = (width, height);
                        // Capture dropped its encoders with the old texture, so
                        // this is a resend and not a diff — a new source that
                        // happens to plan to the same encode size would
                        // otherwise leave that pass with no encoder at all.
                        self.tiers_sent.clear();
                        self.retier();
                    }
                    Ok(FromWorker::Backend(backend)) => self.encoder = Some(backend),
                    // Trigger 4 of `release_all`. The watcher is on the input
                    // thread because a desktop association belongs to the thread
                    // that made it; the held sets are here, so the ups are too.
                    Ok(FromWorker::DesktopSwitched) => {
                        let events = self.input.release_all();
                        self.inject_release(events);
                    }
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

        /// Re-plan the tiers and tell capture, if anything actually moved.
        ///
        /// The one place the assignment, the keyframe policies and the
        /// capture-side encoders change together — a roster change, a ladder
        /// move, a `quality` message and a mode change all land here. Cheap
        /// enough to call on any of them: it is arithmetic over at most
        /// `encoder_budget` viewers and it sends nothing when nothing moved.
        ///
        /// [`tiers::TierPlan::downgraded`] is always empty by construction:
        /// admission caps the viewer count at the encoder budget and there are
        /// two codec classes, so `min(classes, budget)` is always `classes` and
        /// no class is ever collapsed. That is D14's promise — nobody is
        /// downgraded because another viewer's browser cannot decode HEVC — and
        /// it holds without this file choosing anything.
        fn retier(&mut self) {
            // Only viewers that have a peer: one admitted but still to offer has
            // negotiated nothing, and planning it would open an encoder for the
            // baseline codec it may not end up on.
            let served = || self.viewers.iter().filter(|v| v.peer.is_some());
            let planned: Vec<TierViewer> = served()
                .map(|v| TierViewer {
                    viewer_id: v.id.clone(),
                    ctl: self.roster.control_granted(&v.id),
                    codec_class: v.codec,
                    ceiling: v.governor.ceiling(),
                })
                .collect();
            let rates: Vec<ViewerRate> = served()
                .map(|v| ViewerRate {
                    viewer_id: v.id.clone(),
                    target_bps: v.governor.target_bps(),
                    rung: v.governor.rung(),
                })
                .collect();
            self.plan = tiers::plan(&planned, self.encoder_budget);
            // A tier that no longer exists must not carry its cooldown, or the
            // next viewer of that class waits out somebody else's window.
            self.keyframes.retain(&self.plan);
            self.tiers = tier_encodes(&self.plan, &rates, &self.codec_caps, self.source);
            if self.tiers == self.tiers_sent {
                return;
            }
            // Never a blocking send — a capture thread inside a ten-second
            // re-duplication cannot be waited on by the thread that turns every
            // peer. `tiers_sent` is therefore what capture was *told*, kept apart
            // from what was planned: a refused message leaves it stale and the
            // next report (500 ms) offers the difference again.
            if self
                .capture_tx
                .try_send(ToCapture::Tiers(self.tiers.clone()))
                .is_err()
            {
                ::log::debug!("swoop: capture is busy, the tier set will be offered again");
                return;
            }
            self.tiers_sent = self.tiers.clone();
        }

        /// What one tier's encoder emits, for §5's `hello-host`. The source size
        /// until the first plan lands, which is the largest it can ever be.
        fn tier_size(&self, codec: Codec) -> (u32, u32) {
            self.tiers
                .iter()
                .find(|tier| tier.codec == codec)
                .map_or(self.source, |tier| (tier.width, tier.height))
        }

        /// One encoded frame, fanned out to every viewer on the tier that
        /// produced it.
        ///
        /// The codec **is** the tier key (`tiers::TierKeyframes` is keyed the
        /// same way), so a frame names its own audience. Everything downstream
        /// of the send is per viewer — the rtp timestamp, the frame sequencer
        /// and the resolution-change flag all belong to one track.
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

            let Some(tier) = self.plan.tiers.iter().find(|tier| tier.codec == frame.codec) else {
                // The tier lost its last viewer between the encode and here.
                return;
            };
            let members: Vec<usize> = tier
                .viewers
                .iter()
                .filter_map(|id| self.viewers.iter().position(|v| v.id == *id))
                .collect();

            let size = (frame.width as u16, frame.height as u16);
            // §4: send is "immediately before the frame was handed to the
            // transport", and the governor joins its feedback on this stamp.
            let send_us = self.clock.now_us();
            let stamps = FrameStamps {
                capture_us: self.clock.us(frame.captured_qpc),
                encode_us: self.clock.us(frame.encoded_qpc),
                send_us,
            };
            let frame_id = frame.frame_id as u32;

            let mut answered = false;
            let mut needs_irap = false;
            for at in members {
                let v = &mut self.viewers[at];
                let changed = v.last_size.is_some_and(|last| last != size);
                let outcome = match v.peer.as_mut() {
                    None => Outcome::Skipped,
                    Some(peer) if peer.state() != PeerState::Connected => Outcome::Skipped,
                    // Never the first thing a decoder sees: a delta whose
                    // references it never had is a black stream, not a lost
                    // frame. One IRAP answers every viewer waiting on one.
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
                            // join a frame that never arrived to a stale stamp.
                            Ok(()) if peer.stats().frames_written == before => Outcome::Skipped,
                            Ok(()) => Outcome::Sent(peer.last_rtp_timestamp_90k().unwrap_or(0)),
                        }
                    }
                };
                let rtp = match outcome {
                    Outcome::Skipped => continue,
                    Outcome::NeedsIrap => {
                        needs_irap = true;
                        continue;
                    }
                    Outcome::Sent(rtp) => rtp,
                };

                v.last_size = Some(size);
                answered |= frame.is_irap;
                v.governor.on_frame_sent(frame_id, send_us);

                let mut header =
                    FrameHeader::meta_record(frame_codec(frame.codec), frame_id, rtp, size, stamps);
                if frame.is_irap {
                    header.flags |= flags::IRAP;
                }
                if changed {
                    header.flags |= flags::RESOLUTION_CHANGED;
                }
                // Sets IRAP on any frame-id gap: a gap without it *is* the
                // dangling reference §4 forbids.
                v.sequencer.prepare(&mut header);
                let record = header.encode();
                if let Some(peer) = v.peer.as_mut() {
                    peer.write_channel(Channel::SwoopMeta, true, record.to_vec());
                }
            }

            if answered {
                // The keyframe a burst of requests was asking for is on this
                // tier's wire; the next request is a new event.
                self.keyframes.answered(frame.codec);
            }
            // Coalesced: three viewers all waiting for their first recovery
            // point cost the tier one IRAP between them, not three.
            if needs_irap {
                self.request_idr(frame.codec);
            }
        }

        /// Every peer's turn. The loop's [`TICK`] is **shared** between them, not
        /// spent on each: a peer's poll blocks in a socket read for its budget,
        /// so N of them at a full tick each would make the turn N × 2 ms and put
        /// that wait in front of every encoded frame. `RtcPeer` floors its own
        /// wait, so a share too small to divide costs nothing.
        fn pump_peers(&mut self) -> Option<(Exit, ExitReason)> {
            let live = self.viewers.iter().filter(|v| v.peer.is_some()).count();
            if live == 0 {
                // Nothing to drive, so the loop's own tick has to pace it.
                thread::sleep(TICK);
                return None;
            }
            let budget = TICK / live as u32;
            let mut collected: Vec<(String, PeerEvent)> = Vec::new();
            let mut failed: Vec<String> = Vec::new();
            for v in self.viewers.iter_mut() {
                let Some(peer) = v.peer.as_mut() else {
                    continue;
                };
                let mut events = Vec::new();
                if let Err(e) = peer.poll(Instant::now(), budget, &mut events) {
                    ::log::error!("swoop: viewer {} peer poll failed: {e}", v.id);
                    failed.push(v.id.clone());
                    continue;
                }
                collected.extend(events.into_iter().map(|event| (v.id.clone(), event)));
            }
            // Ended before the events are dispatched, so nothing is delivered to
            // a viewer that is already on its way out.
            for viewer in failed {
                let effects = self.client.end_viewer(&viewer, LeftReason::Timeout);
                let _ = self.apply(effects);
            }
            for (viewer, event) in collected {
                self.on_peer_event(&viewer, event);
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
                if let Some(peer) = self.viewer_mut(&answer.viewer).and_then(|v| v.peer.as_mut()) {
                    if let Err(e) = peer.add_remote_candidate(&candidate) {
                        ::log::warn!("swoop: bad remote candidate: {e}");
                    }
                }
            }
        }

        /// Every ICE policy's turn: the interface watcher's flag, then the
        /// timers. One policy per viewer, because one policy per *ICE agent* is
        /// what it is — but the machine's interfaces changed once, so the flag
        /// is read once and offered to all of them.
        ///
        /// The flag is taken every turn whether or not there is a peer — it
        /// means "something changed since it was last read", and one left
        /// standing between viewers would be read as a change under the next
        /// one.
        fn pump_ice(&mut self) {
            let changed = self.ifwatch.as_ref().is_some_and(|w| w.take_changed());
            let now = Instant::now();
            let mut actions: Vec<(String, IceAction)> = Vec::new();
            for v in self.viewers.iter_mut() {
                if v.peer.is_none() {
                    continue;
                }
                if changed {
                    if let Some(action) = v.ice.observe(now, IceEvent::InterfaceChanged) {
                        actions.push((v.id.clone(), action));
                    }
                }
                if let Some(action) = v.ice.poll(now) {
                    actions.push((v.id.clone(), action));
                }
            }
            for (viewer, action) in actions {
                self.on_ice_action(&viewer, action);
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
        fn on_ice_action(&mut self, viewer: &str, action: IceAction) {
            let IceAction::RestartIce(reason) = action;
            ::log::info!("swoop: asking viewer {viewer} for an ice restart ({reason:?})");
            let ready = self.client.host_ready(Some(viewer));
            self.send(&ready);
        }

        /// Every feature's turn to produce, then the one write.
        ///
        /// Only while at least one peer is connected: a feature's outbound is
        /// for the viewers, and there is nothing to hold it in before one
        /// arrives. Whatever a feature must keep across that gap, it keeps
        /// itself. What it produces is host → viewer, so it goes to all of them.
        fn pump_features(&mut self) {
            if !self.viewers.iter().any(Viewer::connected) {
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
            // Host → viewer, so it goes to every connected one. A feature that
            // wanted to answer a single viewer would need an id on the trait,
            // which §5's shared `swoop-control` does not give it.
            for record in self.outbox.take() {
                for at in 0..self.viewers.len() {
                    if !self.viewers[at].connected() {
                        continue;
                    }
                    if let Some(peer) = self.viewers[at].peer.as_mut() {
                        peer.write_channel(record.channel, false, record.payload.clone());
                    }
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
                    // ctrl+alt+del without one to have asked for it. The trait
                    // carries the `ctl` verdict but not the id, so the viewer is
                    // whichever one's control payload the features last saw.
                    let Some(viewer) = self.control_viewer.clone() else {
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
                    // The ups belong on the coordinate space the keys went down
                    // on, so everything held is released before the space moves.
                    let held = self.input.release_all();
                    self.inject_release(held);
                    let _ = self.input_tx.try_send(ToInput::Space(space));
                    self.display = index;
                    // The retarget ends the capture pass, and a new pass has no
                    // encoders until it is asked for them again. `retier` sends
                    // the same set, so it is forced rather than diffed.
                    self.tiers_sent.clear();
                    self.retier();
                }
                FeatureRequest::Audit { kind, reason } => {
                    let viewer = self.control_viewer.clone();
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
        fn offer_to_features(&mut self, viewer: &str, channel: Channel, data: &[u8]) {
            // The host's own verdict from the token it verified, never the
            // room's claim — the roster is the one place it lives.
            let ctl = self.roster.control_granted(viewer);
            if channel == Channel::SwoopControl {
                self.control_viewer = Some(viewer.to_owned());
            }
            for feature in self.features.iter_mut() {
                if let Err(e) = feature.on_message(channel, ctl, data) {
                    ::log::warn!(
                        "swoop: feature {} could not handle a {channel:?} message: {e}",
                        feature.name()
                    );
                }
            }
        }

        fn on_peer_event(&mut self, viewer: &str, event: PeerEvent) {
            let Some(codec) = self.viewer(viewer).map(|v| v.codec) else {
                // It left between the poll and the dispatch.
                return;
            };
            match event {
                PeerEvent::Connected => {
                    ::log::info!("swoop: viewer {viewer} peer connected");
                    self.bind_dtls_session(viewer);
                    // A viewer joining a tier somebody else is already watching
                    // has no recovery point, and the running encoder is emitting
                    // deltas. Through the tier's own policy, so a second joiner
                    // inside the cooldown is served by the first's IRAP. A tier
                    // this viewer opened needs nothing: its encoder's first
                    // frame is an IRAP by construction, and asking would put a
                    // keyframe on `status.idrs` that nothing paid for.
                    let shared = self
                        .plan
                        .tier_of(viewer)
                        .is_some_and(|tier| tier.viewers.len() > 1);
                    if shared {
                        self.request_idr(codec);
                    }
                }
                PeerEvent::Disconnected => {
                    // No `bye` came, so the viewer did not leave — it stopped
                    // answering. That is a timeout, and the release matters.
                    let effects = self.client.end_viewer(viewer, LeftReason::Timeout);
                    let _ = self.apply(effects);
                }
                PeerEvent::LocalCandidate(candidate) => {
                    // One bundled m-line, so mid 0 is the only one there is.
                    let message = Message::Candidate {
                        candidate,
                        sdp_mid: "0".to_owned(),
                        sdp_m_line_index: 0,
                        to: Some(viewer.to_owned()),
                        from: None,
                        from_role: None,
                        server_time_ms: None,
                    };
                    self.send(&message);
                }
                PeerEvent::Ice(event) => {
                    let action = self
                        .viewer_mut(viewer)
                        .and_then(|v| v.ice.observe(Instant::now(), event));
                    if let Some(action) = action {
                        self.on_ice_action(viewer, action);
                    }
                }
                PeerEvent::KeyframeRequest => self.request_idr(codec),
                PeerEvent::ChannelOpen(Channel::SwoopControl) => self.send_hello_host(viewer),
                PeerEvent::ChannelOpen(channel) => ::log::debug!("swoop: {channel:?} open"),
                PeerEvent::ChannelClose(channel) => ::log::debug!("swoop: {channel:?} closed"),
                PeerEvent::ChannelData {
                    channel,
                    binary,
                    data,
                } => self.on_channel_data(viewer, channel, binary, &data),
                PeerEvent::ChannelRefused(label) => {
                    ::log::warn!("swoop: refused a channel labelled {label}")
                }
                PeerEvent::FrameDropped { frame_id, bytes } => {
                    // A delta the pacer refused is a hole in the reference
                    // chain, not one missing picture: every frame after it
                    // decodes against something the viewer never had, and
                    // nothing else in the loop notices. Same coalescing as a
                    // browser's pli, so a drop storm costs one keyframe per
                    // window rather than one per drop.
                    ::log::debug!("swoop: pacer refused frame {frame_id} ({bytes} bytes)");
                    self.request_idr(codec);
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
        fn bind_dtls_session(&mut self, viewer: &str) {
            let Some(fingerprint) = self
                .viewer_mut(viewer)
                .and_then(|v| v.peer.as_mut())
                .and_then(RtcPeer::remote_dtls_fingerprint)
            else {
                // Nothing to bind to, so `Viewer::fingerprint` keeps preferring
                // the offer's — weaker, and never silently treated as absent.
                ::log::warn!("swoop: the peer connected with no remote certificate to bind to");
                return;
            };
            // The fingerprint itself is never logged.
            if let Err(e) = self.client.set_viewer_dtls_fingerprint(viewer, &fingerprint) {
                ::log::warn!("swoop: viewer {viewer} not bound to its dtls session: {e}");
            }
        }

        fn on_channel_data(&mut self, viewer: &str, ch: Channel, binary: bool, data: &[u8]) {
            match ch {
                Channel::SwoopControl if !binary => self.on_control(viewer, data),
                Channel::SwoopInput if !binary => self.on_input(viewer, data),
                Channel::SwoopFeedback if !binary => self.on_feedback(viewer, data),
                // Host → viewer channels, and §3's channels are text.
                _ => {
                    ::log::warn!("swoop: unexpected data on {ch:?} (binary {binary})");
                    return;
                }
            }
            self.offer_to_features(viewer, ch, data);
        }

        fn on_control(&mut self, viewer: &str, data: &[u8]) {
            let Ok(message) = serde_json::from_slice::<ControlMessage>(data) else {
                // Not a malformation: §5 shares this channel with the
                // clipboard, so a payload the control codec refuses is the
                // expected shape of a clip frame. `offer_to_features` still
                // gets it.
                ::log::debug!("swoop: a swoop-control payload is not a control message");
                return;
            };
            if !self.is_viewer(viewer) {
                return;
            }
            // The roster's verdict, from the token this host verified itself.
            if message.requires_control() && !self.roster.control_granted(viewer) {
                self.deny(viewer, "gated_control");
                return;
            }
            match message {
                // §8's viewer token has no field on `offer`, so both ends put
                // the connect token on §10's `lease` frame: the first lease IS
                // the connect token, and there is one verification path.
                ControlMessage::Lease { token } => {
                    let verdict = self.client.verify_viewer_token(viewer, &token);
                    match verdict {
                        Ok(claims) => {
                            let before = self.roster.control_granted(viewer);
                            // The one road to `ctl`: a claim set this host
                            // verified, against a roster that ands the bundle's
                            // own floor over it. There is no setter.
                            let granted = self.roster.verify(viewer, &claims);
                            if before && !granted {
                                // Control taken away mid-chord is a departure as
                                // far as the desktop is concerned.
                                self.release_input(viewer);
                            }
                            ::log::info!("swoop: viewer {viewer} verified, ctl {granted}");
                            // §10's 5-minute lease, not the token's 60-second
                            // `exp`: the browser renews at 60% of whatever it is
                            // answered with, and the token's life would make
                            // that a full membership re-check every 36 seconds.
                            let expires_at = self.leases.renew(viewer);
                            self.roster.set_lease(viewer, expires_at);
                            let ok = ControlMessage::LeaseOk { expires_at };
                            self.write_json(viewer, Channel::SwoopControl, &ok);
                            // `ctl` is on every roster line, so a grant or a
                            // revocation is a change everyone has to see.
                            self.publish_roster();
                            if before != granted {
                                // A controller is floored before a watcher, so
                                // the split moves with the verdict.
                                self.retier();
                            }
                        }
                        Err(denial) => {
                            self.on_denial(denial);
                            self.leases.forget(viewer);
                            let effects = self.client.end_viewer(viewer, LeftReason::LeaseExpired);
                            // Never an exit: `end_viewer` produces a bye and a
                            // departure, nothing that ends the process.
                            let _ = self.apply(effects);
                        }
                    }
                }
                ControlMessage::Idr => {
                    if let Some(codec) = self.viewer(viewer).map(|v| v.codec) {
                        self.request_idr(codec);
                    }
                }
                // All three axes, not just the bitrate: `preset` carries the
                // resolution cap, which is the one axis §5 gives no field of
                // its own. Per viewer — §5 allows a watcher its own quality —
                // so it moves that viewer's ladder and nobody else's.
                ControlMessage::Quality {
                    preset,
                    max_bitrate_kbps,
                    max_fps,
                } => {
                    let ceiling = Ceiling::from_quality(&preset, max_bitrate_kbps, max_fps);
                    let Some(v) = self.viewer_mut(viewer) else {
                        return;
                    };
                    v.governor.set_ceiling(ceiling);
                    let target = v.governor.target_bps();
                    self.apply_bitrate(viewer, target);
                    // A new preset restarts the ladder at its own top, which is
                    // a rung move like any other, and its tier is sized for the
                    // narrowest of its members.
                    self.apply_ladder(viewer);
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

        /// One §5 input message from one viewer.
        ///
        /// The gate, the per-viewer held set, last-input-wins and the refusal
        /// reporting are all [`SharedInput`]'s; this routes what came out of it.
        fn on_input(&mut self, viewer: &str, data: &[u8]) {
            if !self.is_viewer(viewer) {
                return;
            }
            let Ok(message) = serde_json::from_slice::<InputMessage>(data) else {
                ::log::warn!("swoop: malformed input message");
                return;
            };
            // The roster is the enforcement point, and its `ctl` comes from the
            // token this host verified — never from anything the browser says,
            // and never from the room's claim at join.
            let outcome = self
                .input
                .accept(&self.roster, viewer, &message, Instant::now());
            if !outcome.events.is_empty() {
                let _ = self.input_tx.try_send(ToInput::Inject(outcome.events));
            }
            if let Some(denial) = outcome.denial {
                ::log::warn!("swoop: viewer {viewer} sent input without ctl, dropped");
                self.host_event(
                    denial.kind,
                    Some(denial.viewer),
                    Some(denial.reason.to_owned()),
                );
            }
            // §5: where each *other* controller is pointing, so a session with
            // more than one of them can draw them. Never back to the viewer it
            // came from — that one has its own cursor.
            if let Some(cursor) = outcome.cursor {
                self.broadcast(Some(viewer), Channel::SwoopCursor, &cursor);
            }
        }

        /// §5: a viewer without `ctl` that sends something gated on
        /// `swoop-control` is dropped and the attempt is reported.
        ///
        /// Once per viewer, not once per message: [`Denials`] is the rate
        /// limit. The count of everything it suppressed rides `status`.
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

        fn on_feedback(&mut self, viewer: &str, data: &[u8]) {
            let Ok(message) = serde_json::from_slice::<Feedback>(data) else {
                ::log::warn!("swoop: malformed feedback message");
                return;
            };
            if let Feedback::Ping { id, t_us } = message {
                // `hostUs` must be in the same epoch as §4's `tSendUs`: the
                // browser's offset is `hostUs − viewerUs` and the governor
                // undoes it against the send stamp. The reply goes back on
                // `swoop-feedback`, which is where the viewer listens for it.
                let pong = Feedback::Pong {
                    id,
                    t_us,
                    host_us: self.clock.now_us() as i64,
                };
                self.write_json(viewer, Channel::SwoopFeedback, &pong);
                return;
            }
            // Each viewer's own path, measured by its own governor.
            if let Some(v) = self.viewer_mut(viewer) {
                v.governor.on_feedback(Instant::now(), &message);
            }
        }

        fn write_json<T: serde::Serialize>(&mut self, viewer: &str, channel: Channel, message: &T) {
            let Some(at) = self.viewers.iter().position(|v| v.id == viewer) else {
                return;
            };
            self.write_json_to(at, channel, message);
        }

        fn write_json_to<T: serde::Serialize>(&mut self, at: usize, channel: Channel, message: &T) {
            let Some(peer) = self.viewers[at].peer.as_mut() else {
                return;
            };
            match serde_json::to_vec(message) {
                Ok(bytes) => peer.write_channel(channel, false, bytes),
                Err(e) => ::log::error!("swoop: could not encode a {channel:?} message: {e}"),
            }
        }

        fn send_hello_host(&mut self, viewer: &str) {
            let Some(at) = self.viewers.iter().position(|v| v.id == viewer) else {
                return;
            };
            if self.viewers[at].hello_sent {
                return;
            }
            self.viewers[at].hello_sent = true;
            let codec = self.viewers[at].codec;
            // This viewer's own tier, not the session's: two tiers can be two
            // sizes, and the browser sizes its canvas from this.
            let encoded = self.tier_size(codec);
            // The `displays` feature enumerates them properly; until it does,
            // the fallback advertises only the display being streamed rather
            // than putting a switcher in the browser for a switch this session
            // cannot honour. `ready` still tells the service the true count.
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
                width: encoded.0,
                height: encoded.1,
                displays,
                streamer_epoch: self.streamer_epoch,
                protocol_version: crate::bundle::SWOOP_PROTOCOL_VERSION,
            };
            self.write_json_to(at, Channel::SwoopControl, &hello);
            // Who else is here, to the browser that has just opened its channel.
            let presence = self.roster.presence(self.clock.now_us() as i64);
            self.write_json_to(at, Channel::SwoopControl, &presence);
            // This viewer's shape cache is empty and the tracker only emits on
            // a change, so the pointer has to be asked for whole.
            let _ = self.capture_tx.try_send(ToCapture::CursorSnapshot);
        }

        /// §4: a host coalesces idr requests behind a cooldown, so a browser may
        /// ask as often as it likes. One [`IdrPolicy`] per **tier**
        /// ([`TierKeyframes`]), so three viewers of one class reporting the same
        /// loss cost one IRAP between them.
        fn request_idr(&mut self, codec: Codec) {
            if !self.keyframes.request(codec, Instant::now()) {
                return;
            }
            let _ = self.capture_tx.try_send(ToCapture::Idr(codec));
        }

        /// The gate and the source have to agree, or the gate just drops the
        /// difference. The peer's pacer is this viewer's; the encoder is the
        /// tier's, so it takes the narrowest of its members and `retier` is what
        /// works that out.
        fn apply_bitrate(&mut self, viewer: &str, bps: u32) {
            if let Some(peer) = self.viewer_mut(viewer).and_then(|v| v.peer.as_mut()) {
                peer.set_bitrate_ceiling(bps);
            }
            self.retier();
        }

        /// The governor's other output, which is two different things to act
        /// on and is why `LadderChange::needs_new_encoder` exists.
        ///
        /// A resolution move is a **new encoder**: a rebuild yields a new
        /// device and the backend refuses a foreign texture (spike 3.7), so it
        /// goes through `retier`, whose `Tiers` drops the old encoder and the
        /// scaler and forces the irap that §4 requires of a resolution change.
        /// A frame-rate move is a capture-side decision the running encoder
        /// never hears about. Both are the same call here, because a tier is
        /// sized and paced for the narrowest of its members either way.
        fn apply_ladder(&mut self, viewer: &str) {
            let moved = self
                .viewer_mut(viewer)
                .and_then(|v| v.governor.take_ladder())
                .is_some();
            if moved {
                self.retier();
            }
        }

        fn tick(&mut self) {
            let now = Instant::now();
            if now.duration_since(self.last_report) >= REPORT_INTERVAL {
                self.last_report = now;
                self.report(now);
            }
            if now.duration_since(self.last_status) >= STATUS_INTERVAL {
                self.status(now);
            }
        }

        /// One governor evaluation per viewer, then the one split of the host
        /// uplink over all of them.
        ///
        /// The split comes **after** the evaluations, so it is applied over the
        /// ceilings those evaluations left in force; and it is one `retier` at
        /// the end rather than one per viewer, because a tier is sized for the
        /// narrowest of its members and N recomputations would send N identical
        /// messages to capture.
        fn report(&mut self, now: Instant) {
            for at in 0..self.viewers.len() {
                let Some(pacer) = self.viewers[at].peer.as_ref().map(|p| p.stats().pacer) else {
                    continue;
                };
                if let Some(bps) = self.viewers[at].governor.on_report(now, pacer) {
                    if let Some(peer) = self.viewers[at].peer.as_mut() {
                        peer.set_bitrate_ceiling(bps);
                    }
                }
                // Drained straight after the evaluation that produced it — at
                // most one move per report — and acted on by the `retier` below,
                // which reads the rung the move left behind. A change left
                // pending would be read as this viewer's *next* move.
                let _ = self.viewers[at].governor.take_ladder();
            }
            self.allocate_uplink();
            // Unconditional, because it is also the retry for a tier set the
            // capture thread was too busy to take. It sends nothing when nothing
            // moved.
            self.retier();
        }

        /// One estimate of the machine's uplink, split across every viewer:
        /// a floor each while there is one to give, then the remainder
        /// proportional-fair with **controllers before watchers**.
        ///
        /// Without it N viewers are N independent congestion controllers each
        /// treating one DSL line as its own, which is how bufferbloat gets built
        /// by the very thing meant to avoid it. `ctl` is the roster's, so a
        /// watcher can never buy itself a controller's floor.
        fn allocate_uplink(&mut self) {
            if self.viewers.is_empty() {
                return;
            }
            let claims: Vec<UplinkClaim> = self
                .viewers
                .iter()
                .map(|v| UplinkClaim {
                    viewer_id: v.id.clone(),
                    ctl: self.roster.control_granted(&v.id),
                    // The ceiling in force and never the current target: a
                    // target already cut is a viewer asking for its own cut back.
                    demand_bps: v.governor.ceiling().bitrate_bps,
                })
                .collect();
            for share in self.uplink.allocate(&claims) {
                if share.starved {
                    ::log::warn!(
                        "swoop: viewer {} has no uplink share left to give it",
                        share.viewer_id
                    );
                }
                if let Some(v) = self.viewer_mut(&share.viewer_id) {
                    v.governor.set_uplink_share(share.bps);
                }
            }
        }

        fn status(&mut self, now: Instant) {
            let elapsed = now.duration_since(self.last_status);
            self.last_status = now;
            // Machine-wide: what every peer put on the link, against what every
            // governor is aiming at. §6's pair, summed — a target the link never
            // delivered is invisible from either number alone, and with one
            // viewer both are exactly what they were before the fan-out.
            let mut bitrate_kbps = 0u32;
            let mut target_kbps = 0u32;
            // The *stream's* rate and not the sum of N copies of it: the busiest
            // viewer is the one whose picture is whole.
            let mut fps = 0u32;
            for v in self.viewers.iter_mut() {
                let Some(peer) = v.peer.as_ref() else {
                    continue;
                };
                bitrate_kbps = bitrate_kbps.saturating_add((peer.sent_bps() / 1000) as u32);
                target_kbps = target_kbps.saturating_add(v.governor.target_bps() / 1000);
                let frames = peer.stats().frames_written;
                let seen = frames
                    .saturating_sub(v.frames_at_status)
                    .checked_div(elapsed.as_secs().max(1))
                    .unwrap_or(0) as u32;
                v.frames_at_status = frames;
                fps = fps.max(seen);
            }
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
            // quiet session the nine-field line. N governors report as the
            // **most degraded** of them, which is the one an operator called
            // about; the two rate numbers above stay machine-wide sums.
            let worst = self
                .viewers
                .iter()
                .filter(|v| v.peer.is_some())
                .min_by_key(|v| v.governor.target_bps());
            let governed = worst.map(|v| (v.governor.ceiling(), v.governor.stats(), v.governor.state(now)));
            let denials = self.denials.count() + self.input.denials();
            let dropped = self.input.dropped();
            let idrs = self.keyframes.total_forced();
            let event = Event::Status {
                sid: self.sid.clone(),
                viewers: self.roster.len() as u32,
                controllers: self.roster.controllers(),
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
                input_dropped: (dropped > 0).then_some(dropped),
                denials: (denials > 0).then_some(denials),
                test_override: self.test_override.clone(),
                encoder: self.encoder.map(str::to_owned),
                // Absent means one, which is every session on a machine whose
                // viewers all negotiated the same codec.
                tiers: (self.plan.tier_count() > 1).then(|| self.plan.tier_count() as u32),
                preset: governed.map(|(ceiling, _, _)| ceiling.label()),
                target_kbps: governed.map(|_| target_kbps),
                rung_fps: governed.map(|(_, stats, _)| stats.rung.fps),
                rung_resolution: governed
                    .map(|(_, stats, _)| stats.rung.resolution.wire_name().to_owned()),
                // Absent is the preset's own rung, which is where a healthy
                // session sits — the same "absent means zero" as the counters.
                rung_index: governed
                    .map(|(_, stats, _)| stats.rung_index)
                    .filter(|index| *index > 0),
                governor: governed.map(|(_, _, state)| governor_phase(state)),
                idrs: (idrs > 0).then_some(idrs),
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
        /// peer and releases **that viewer's** held keys — a viewer dropped
        /// mid-chord leaves them down on the machine otherwise, and releasing
        /// everyone's would lift the other controller's chord with it.
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
            // The session is ending, so every viewer's held keys come up — the
            // one place a blanket release is the right one.
            let events = self.input.release_all();
            self.inject_release(events);
            let mut gone: Vec<Viewer> = std::mem::take(&mut self.viewers);
            for v in gone.iter_mut() {
                if let Some(peer) = v.peer.as_mut() {
                    peer.disconnect();
                }
            }
            for viewer in gone.into_iter().map(|v| v.id) {
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
            wanted: Vec::new(),
            reported: None,
            backend: None,
        };
        while !ctx.stop.load(Ordering::Relaxed) {
            match capture_pass(&mut ctx) {
                Pass::Paused => {
                    // The encoders went with the pass, so the next viewer's is a
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
        /// The tier set the session last asked for, kept across a pause and a
        /// retarget: the rate and the rung it carries are the governors' current
        /// word, and a new pass opens its encoders at that and never at the
        /// config's default.
        wanted: Vec<TierEncode>,
        /// The source size the session has been told about. It hears `Opened`
        /// once; every later open reports a change or says nothing.
        reported: Option<(u32, u32)>,
        /// Which backend the last encoder opened on, so a rebuild that lands on
        /// the same one is not re-reported to the session.
        backend: Option<&'static str>,
    }

    /// One tier's live encoder on the capture thread.
    struct TierPass {
        want: TierEncode,
        encoder: Option<Box<dyn Encoder>>,
        /// This tier's own downscaler: two tiers can be two sizes, and a scaler
        /// belongs to the size it was opened for.
        scaler: Option<Downscaler>,
        force_irap: bool,
        /// When this tier's encoder was last handed anything, for its rung's
        /// frame-rate gate, and for the floor.
        floor: FloorTimer,
        last_encode: Option<Instant>,
    }

    impl TierPass {
        fn new(want: TierEncode, now: Instant) -> Self {
            Self {
                want,
                encoder: None,
                scaler: None,
                // A new tier's first frame is a recovery point or its viewers
                // see nothing at all.
                force_irap: true,
                floor: FloorTimer::new(now),
                last_encode: None,
            }
        }

        /// A size change is a **new encoder**: the backend refuses a foreign
        /// texture and §4 requires an IRAP with nothing from the old one after
        /// it. Rate and frame rate move in place.
        fn retarget(&mut self, want: TierEncode) {
            if (self.want.width, self.want.height) != (want.width, want.height) {
                self.encoder = None;
                self.scaler = None;
                self.force_irap = true;
            } else if self.want.bitrate_bps != want.bitrate_bps {
                if let Some(encoder) = self.encoder.as_mut() {
                    if let Err(e) = encoder.set_bitrate(want.bitrate_bps) {
                        ::log::warn!("swoop: could not move the bitrate: {e}");
                    }
                }
            }
            self.want = want;
        }

        /// Drop the encoder and the scaler: the device under them is gone, or
        /// the session has to be told a new size before there is anything to
        /// encode at all.
        fn rebuild(&mut self) {
            self.encoder = None;
            self.scaler = None;
            self.force_irap = true;
        }
    }

    /// Apply a new tier set to the running encoders, keeping every one whose
    /// codec and size are unchanged. A tier the set does not name has lost its
    /// last viewer and its encoder closes here.
    fn apply_tiers(tiers: &mut Vec<TierPass>, wanted: &[TierEncode], now: Instant) {
        let mut next: Vec<TierPass> = Vec::with_capacity(wanted.len());
        for want in wanted {
            match tiers.iter().position(|tier| tier.want.codec == want.codec) {
                Some(at) => {
                    let mut tier = tiers.remove(at);
                    tier.retarget(*want);
                    next.push(tier);
                }
                None => next.push(TierPass::new(*want, now)),
            }
        }
        *tiers = next;
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
                // The session's last word on the tier set, kept for the pass
                // the next viewer opens.
                Ok(ToCapture::Tiers(wanted)) => ctx.wanted = wanted,
                // Nothing is open to retarget, so it is only the output the
                // resume will duplicate.
                Ok(ToCapture::Output(output)) => ctx.output = output,
                Ok(ToCapture::Stop) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    return false
                }
                // `Idr`, `CursorSnapshot`, a second `Pause`: there is no
                // duplication to answer them with, and the resume rebuilds every
                // encoder, every scaler and the cursor cache anyway.
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
            // re-tiers on this and sends the `Tiers` that opens the encoders.
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
        // One encoder per tier, opened from whatever the session last asked for
        // — a pass that starts after a pause inherits the governors' current
        // word rather than the config's defaults.
        let mut tiers: Vec<TierPass> = Vec::new();
        apply_tiers(&mut tiers, &ctx.wanted, Instant::now());
        // The last **captured** picture, for the floor. The surface behind it
        // belongs to the duplication, which reuses one texture and overwrites it
        // on the next frame that carries a picture — so the handle stays
        // readable exactly as long as the duplication is not rebuilt, and every
        // path that rebuilds it clears this. Pre-scale, because two tiers can be
        // two sizes and the repeat goes through each one's own scaler.
        let mut last_source: Option<Frame> = None;

        while !ctx.stop.load(Ordering::Relaxed) {
            loop {
                match ctx.rx.try_recv() {
                    Ok(ToCapture::Tiers(wanted)) => {
                        ctx.wanted = wanted;
                        apply_tiers(&mut tiers, &ctx.wanted, Instant::now());
                    }
                    Ok(ToCapture::Idr(codec)) => {
                        if let Some(tier) = tiers.iter_mut().find(|t| t.want.codec == codec) {
                            tier.force_irap = true;
                        }
                    }
                    Ok(ToCapture::CursorSnapshot) => {
                        if let Some(shape) = tracker.current_shape() {
                            let _ = ctx.tx.try_send(FromWorker::Cursor(shape));
                        }
                    }
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
            // `last_source` points at went with the duplication that owned it.
            // True once after every rebuild — the device is new, so every
            // encoder and scaler pinned to the old one is gone with it.
            if source.take_idr_request() {
                for tier in tiers.iter_mut() {
                    tier.rebuild();
                }
                last_source = None;
            }
            if source.size() != size {
                size = source.size();
                ctx.reported = Some(size);
                geometry = OutputGeometry::for_output(source.output(), size);
                let _ = ctx.tx.try_send(FromWorker::SourceSize {
                    width: size.0,
                    height: size.1,
                });
                // The session re-tiers on this and sends a new `Tiers`; until it
                // does there is nothing sized for this source to feed.
                tiers.clear();
                ctx.wanted.clear();
                last_source = None;
            }

            let now = Instant::now();
            let fresh = frame.is_some();
            if let Some(frame) = frame {
                last_source = Some(frame);
            }
            let Some(last) = last_source.as_ref() else {
                continue;
            };
            // The floor. Desktop Duplication answers `WAIT_TIMEOUT` on a static
            // desktop and a hardware decoder handed nothing stalls, so the last
            // picture goes out again — stamped now, because the browser's stage
            // breakdown measures this frame's trip and not the age of its
            // pixels. Per tier, because each one's decoder is its own.
            let captured = Frame {
                handle: last.handle,
                width: last.width,
                height: last.height,
                captured_qpc: if fresh { last.captured_qpc } else { qpc_now() },
            };

            let mut rebuilt = false;
            for tier in tiers.iter_mut() {
                if fresh {
                    // The ladder's frame-rate rung, and the only place it can be
                    // enforced: a CBR encoder handed every frame just spends the
                    // same budget on all of them. Not applied at the top rung —
                    // duplication is vsync-locked at the panel's rate, so a gate
                    // there would drop every other frame on the jitter of a
                    // 16.67 ms interval.
                    if tier.want.fps < TARGET_FPS
                        && tier.last_encode.is_some_and(|at| {
                            now.saturating_duration_since(at) < frame_interval(tier.want.fps)
                        })
                    {
                        continue;
                    }
                } else if !tier.floor.due(now) {
                    continue;
                }

                let (width, height) = (tier.want.width, tier.want.height);
                if tier.scaler.is_none() && (width, height) != (captured.width, captured.height) {
                    match Downscaler::open(&captured, width, height) {
                        Ok(opened) => tier.scaler = Some(opened),
                        Err(e) => {
                            ::log::error!("swoop: could not open the downscaler: {e}");
                            let _ = ctx.tx.try_send(FromWorker::Failed(e.exit()));
                            return Pass::Done;
                        }
                    }
                }
                let feed = match tier.scaler.as_mut().map(|scaler| scaler.scale(&captured)) {
                    Some(Ok(scaled)) => scaled,
                    Some(Err(e)) => {
                        // A new device under the scaler: rebuild both next turn.
                        ::log::warn!("swoop: downscale failed: {e}");
                        tier.rebuild();
                        rebuilt = true;
                        continue;
                    }
                    None => Frame {
                        handle: captured.handle,
                        width: captured.width,
                        height: captured.height,
                        captured_qpc: captured.captured_qpc,
                    },
                };

                if tier.encoder.is_none() {
                    let cfg = EncoderConfig {
                        codec: tier.want.codec,
                        width,
                        height,
                        fps: TARGET_FPS,
                        // A rebuild is a new encoder, so the governor's current
                        // target is re-applied here rather than inherited.
                        bitrate_bps: tier.want.bitrate_bps,
                    };
                    // The chain, not NVENC: `select::create` walks down it, so a
                    // backend that probed fine and then refused the session
                    // costs one rung rather than the session.
                    match select::create(&ctx.caps, &cfg) {
                        Ok((backend, created)) => {
                            tier.encoder = Some(created);
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
                let Some(session) = tier.encoder.as_mut() else {
                    continue;
                };
                match session.encode(&feed, tier.force_irap) {
                    Ok(encoded) => {
                        // The floor is measured from the last frame the encoder
                        // was given, not from the last one it answered: an
                        // encoder that runs a frame behind is not a stalled
                        // desktop.
                        tier.floor.fed(now);
                        tier.last_encode = Some(now);
                        if let Some(encoded) = encoded {
                            tier.force_irap = false;
                            // A full queue means the session thread fell behind.
                            // The frame is dropped rather than stalling capture,
                            // and the next one is an IRAP so the gap cannot
                            // dangle.
                            if ctx.tx.try_send(FromWorker::Frame(Box::new(encoded))).is_err() {
                                tier.force_irap = true;
                            }
                        }
                    }
                    Err(e) => {
                        // DeviceChanged and SizeChanged both mean the surface
                        // moved under the session: drop it and open a new one.
                        ::log::warn!("swoop: encode failed: {e}");
                        tier.rebuild();
                        rebuilt = true;
                    }
                }
            }
            // A scaler or an encoder that failed did so against this texture, so
            // it is not one to hand out again on the floor.
            if rebuilt {
                last_source = None;
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

        while !stop.load(Ordering::Relaxed) {
            // Trigger 4 of `release_all`. `follow` switches and reports in one
            // call, so this thread is already on the new desktop when the ups
            // the session answers with arrive — and it is the session that
            // answers, because the held sets are per viewer and live there.
            if watcher.follow() {
                let _ = tx.try_send(FromWorker::DesktopSwitched);
                injector.refresh_bounds();
            }
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(ToInput::Inject(events)) => {
                    if let Err(e) = injector.inject_all(&events) {
                        ::log::warn!("swoop: input injection failed: {e}");
                    }
                }
                // A new display is a new coordinate space, and a mode change may
                // have moved the virtual desktop with it. The session releases
                // everything held before it sends this — the ups belong on the
                // desktop the keys went down on.
                Ok(ToInput::Space(space)) => {
                    injector.set_space(space);
                    injector.refresh_bounds();
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

        /// One tier at the session's own defaults, for the hardware tests that
        /// drive the capture thread without a roster behind them.
        fn one_tier(codec: Codec, encoded: (u32, u32)) -> TierEncode {
            TierEncode {
                codec,
                width: encoded.0,
                height: encoded.1,
                bitrate_bps: DEFAULT_BITRATE_BPS,
                fps: TARGET_FPS,
            }
        }

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
                .send(ToCapture::Tiers(vec![one_tier(codec, encoded)]))
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

            capture_tx
                .send(ToCapture::Tiers(vec![one_tier(codec, encoded)]))
                .expect("the capture thread is running");
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
            // A new duplication is a new device and a new encoder; the pass
            // re-opens them from the tier set it kept across the pause, so this
            // is only here to prove the resume does not need telling again.
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

    /// The pacer's own refusals go through the same policy, and it refuses at
    /// the frame rate — so this is the case that decides whether a congested
    /// link recovers or spends itself on keyframes. The keyframe is exempt from
    /// the pacer, so each one does reach the wire and clears the sticky wait.
    #[test]
    fn a_storm_of_dropped_frames_costs_one_keyframe_per_window() {
        let mut idr = IdrPolicy::new();
        let start = Instant::now();
        let forced_at: Vec<u32> = (0..60u32)
            .filter(|i| {
                let asked = idr.request(start + Duration::from_micros(u64::from(*i) * 16_667));
                if asked {
                    idr.answered();
                }
                asked
            })
            .collect();
        // One second of 60 fps with every frame refused: the first drop, then
        // the 250 ms window, then the 500 ms one it backs off to.
        assert_eq!(forced_at, vec![0, 15, 45]);
        assert_eq!(idr.forced(), 3);
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
    /// `Live::on_control`, which cannot be unit tested without a live room.
    #[test]
    fn a_viewer_without_ctl_is_reported_once_and_counted_every_time() {
        let mut denials = Denials::default();
        assert!(denials.note("viewer_a"));
        for _ in 0..30 {
            assert!(!denials.note("viewer_a"));
        }
        assert_eq!(denials.count(), 31);

        // Per viewer, not one slot: a second watcher's first attempt is its own
        // event and does not suppress or get suppressed by the first's.
        assert!(denials.note("viewer_b"));
        assert!(!denials.note("viewer_a"));

        // A departure clears only the viewer that left.
        denials.forget("viewer_a");
        assert!(denials.note("viewer_a"));
        assert!(!denials.note("viewer_b"));
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

    // ------------------------------------------------------- the fan-out ---

    mod multi_viewer {
        use std::time::Duration;

        use super::super::tiers::{self, TierKeyframes, TierViewer};
        use super::*;
        use crate::bundle::{Claims, Role};
        use crate::session::quality::{Ceiling, QualityRung, ResolutionCap};
        use crate::signal::messages::channel::Input;
        use crate::transport::governor::{UplinkBudget, UplinkClaim};
        use crate::viewers::roster::Roster;
        use crate::viewers::SharedInput;

        /// Every machine this has run on so far: eight concurrent encode
        /// sessions, two codec classes.
        const BUDGET: u32 = 8;

        fn claims(viewer: &str, ctl: bool) -> Claims {
            Claims {
                iss: "owlette-api".to_owned(),
                aud: "swoop-host".to_owned(),
                role: Role::Viewer,
                uid: None,
                site: "site_1".to_owned(),
                machine: "machine_1".to_owned(),
                sid: Some("sid_1".to_owned()),
                viewer: Some(viewer.to_owned()),
                ctl: Some(ctl),
                fp: None,
                iat: 1_000_000,
                exp: Some(1_000_060),
                jti: "jti_1".to_owned(),
            }
        }

        fn key(code: &str, down: bool, seq: u64) -> Input {
            Input::K {
                code: code.to_owned(),
                down,
                seq,
                ts_us: 0,
            }
        }

        fn nvenc() -> Vec<CodecCaps> {
            vec![
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
            ]
        }

        fn planned(id: &str, ctl: bool, codec_class: Codec) -> TierViewer {
            TierViewer {
                viewer_id: id.to_owned(),
                ctl,
                codec_class,
                ceiling: Ceiling::default(),
            }
        }

        fn rate(id: &str, target_bps: u32, rung: QualityRung) -> ViewerRate {
            ViewerRate {
                viewer_id: id.to_owned(),
                target_bps,
                rung,
            }
        }

        fn top() -> QualityRung {
            QualityRung {
                fps: 60,
                resolution: ResolutionCap::Native,
            }
        }

        /// The line this whole task exists to delete: `on_admitted` used to bye
        /// the second joiner unconditionally.
        #[test]
        fn the_second_and_third_joiner_are_admitted_and_a_re_offer_is_not_a_new_viewer() {
            let alone: Vec<String> = vec!["a".to_owned()];
            assert_eq!(on_join("b", &alone, BUDGET), Joining::Admit);

            let two = vec!["a".to_owned(), "b".to_owned()];
            assert_eq!(on_join("c", &two, BUDGET), Joining::Admit);
            // The room re-admits a browser that re-offers after an ice restart.
            assert_eq!(on_join("b", &two, BUDGET), Joining::Known);
        }

        /// D14's cap is the machine's measured encode sessions, and the refusal
        /// is a row in the audit trail rather than a log line.
        #[test]
        fn a_join_past_the_encoder_budget_is_refused_with_an_audited_reason() {
            let full: Vec<String> = (0..BUDGET).map(|i| format!("v{i}")).collect();
            let Joining::Refuse(refusal) = on_join("one-too-many", &full, BUDGET) else {
                panic!("the budget+1 joiner has no encode session");
            };
            assert_eq!(refusal.kind(), HostEventKind::JoinRefused);
            assert_eq!(refusal.budget, BUDGET);
            assert_eq!(refusal.viewers, BUDGET);
            // `tiers` owns both spellings now; that the code is one the route
            // accepts is asserted there, against the route's own pattern.
            assert_eq!(refusal.reason(), "encoder_budget");
        }

        /// D14's case, through the session's own seam: the plan, then the
        /// encoders it actually asks the capture thread for.
        #[test]
        fn two_codec_classes_on_a_three_budget_machine_are_two_encoders_and_nobody_is_downgraded() {
            let roster = [
                planned("a", true, Codec::H265),
                planned("b", false, Codec::H264),
                planned("c", false, Codec::H265),
            ];
            let plan = tiers::plan(&roster, 3);
            assert!(plan.downgraded.is_empty(), "nobody loses a codec class");

            let rates = [
                rate("a", 20_000_000, top()),
                rate("b", 20_000_000, top()),
                rate("c", 20_000_000, top()),
            ];
            let encodes = tier_encodes(&plan, &rates, &nvenc(), (1920, 1080));
            assert_eq!(encodes.len(), 2, "one encoder per tier, three viewers");
            assert_eq!(encodes[0].codec, Codec::H265);
            assert_eq!(encodes[1].codec, Codec::H264);
            for tier in &encodes {
                assert_eq!((tier.width, tier.height), (1920, 1080));
                assert_eq!(tier.fps, 60);
                assert_eq!(tier.bitrate_bps, 20_000_000);
            }
        }

        /// The tier count is arithmetic over two measured numbers. Six viewers
        /// of one class is **one** encoder, not six.
        #[test]
        fn n_viewers_across_one_class_are_one_encoder() {
            let roster: Vec<TierViewer> = (0..6)
                .map(|i| planned(&format!("v{i}"), i == 0, Codec::H265))
                .collect();
            let rates: Vec<ViewerRate> = (0..6)
                .map(|i| rate(&format!("v{i}"), 20_000_000, top()))
                .collect();
            let plan = tiers::plan(&roster, BUDGET);
            assert_eq!(tier_encodes(&plan, &rates, &nvenc(), (1920, 1080)).len(), 1);
        }

        /// `TierPlan::downgraded` is unreachable from this session, and the
        /// admission cap is why: viewers ≤ budget and there are two codec
        /// classes, so `min(classes, budget)` is always `classes`. That is D14's
        /// promise — nobody is downgraded because another viewer's browser
        /// cannot decode HEVC — and it holds without this file choosing anything.
        #[test]
        fn the_admission_cap_makes_a_codec_downgrade_unreachable() {
            for budget in 1..=BUDGET {
                let mut present: Vec<String> = Vec::new();
                let mut roster: Vec<TierViewer> = Vec::new();
                for i in 0..BUDGET + 2 {
                    let id = format!("v{i}");
                    if on_join(&id, &present, budget) != Joining::Admit {
                        continue;
                    }
                    present.push(id.clone());
                    // Alternating classes, which is the worst case for the
                    // collapse: as many distinct classes as the roster allows.
                    let class = if i % 2 == 0 { Codec::H265 } else { Codec::H264 };
                    roster.push(planned(&id, i == 0, class));
                }
                assert_eq!(present.len(), budget as usize, "budget {budget}");
                let plan = tiers::plan(&roster, budget);
                assert!(
                    plan.downgraded.is_empty(),
                    "budget {budget} collapsed a class: {:?}",
                    plan.downgraded
                );
            }
        }

        /// One stream is fanned out to every member, so the tier's encoder runs
        /// at the narrowest of them — a viewer that asked for 720p30 must not
        /// cost the other one its picture, and must not be sent 50 Mbps of it.
        #[test]
        fn a_tiers_encoder_is_sized_and_paced_for_its_narrowest_member() {
            let roster = [planned("rich", true, Codec::H264), planned("thin", false, Codec::H264)];
            let plan = tiers::plan(&roster, BUDGET);
            let rates = [
                rate("rich", 20_000_000, top()),
                rate(
                    "thin",
                    5_000_000,
                    QualityRung {
                        fps: 30,
                        resolution: ResolutionCap::P720,
                    },
                ),
            ];
            let encodes = tier_encodes(&plan, &rates, &nvenc(), (1920, 1080));
            assert_eq!(encodes.len(), 1);
            assert_eq!(encodes[0].bitrate_bps, 5_000_000);
            assert_eq!(encodes[0].fps, 30);
            assert_eq!((encodes[0].width, encodes[0].height), (1280, 720));
        }

        /// A tier whose last viewer left keeps no encoder open for nobody.
        #[test]
        fn a_tier_with_no_members_left_asks_for_no_encoder() {
            let roster = [planned("a", true, Codec::H265)];
            let plan = tiers::plan(&roster, BUDGET);
            assert!(tier_encodes(&plan, &[], &nvenc(), (1920, 1080)).is_empty());
            assert!(tier_encodes(&tiers::TierPlan::default(), &[], &nvenc(), (1920, 1080)).is_empty());
        }

        /// The two requests the session makes on a join — the peer connecting,
        /// and the first frame finding a peer with no recovery point — plus
        /// every sitting viewer's PLI, all inside one cooldown. One IRAP.
        #[test]
        fn a_join_during_the_idr_cooldown_costs_its_tier_one_keyframe() {
            let mut keyframes = TierKeyframes::new();
            let start = Instant::now();

            // Three viewers already on the hevc tier report the same loss.
            let mut forced = 0;
            for ms in [0u64, 8, 16] {
                forced += u32::from(keyframes.request(Codec::H265, start + Duration::from_millis(ms)));
            }
            // A fourth joins: `PeerEvent::Connected`, then its first frame.
            forced += u32::from(keyframes.request(Codec::H265, start + Duration::from_millis(40)));
            forced += u32::from(keyframes.request(Codec::H265, start + Duration::from_millis(56)));
            assert_eq!(forced, 1, "one idr for the tier, not one per viewer");
            assert_eq!(keyframes.total_forced(), 1);

            // A second tier is a second encoder and owes its own irap.
            assert!(keyframes.request(Codec::H264, start + Duration::from_millis(56)));
            assert_eq!(keyframes.total_forced(), 2);
        }

        /// The stuck-modifier bug, in the shape multi-viewer makes possible:
        /// the blanket `ReleaseAll` this session used to send would have lifted
        /// the other controller's chord with it.
        #[test]
        fn a_departing_viewer_releases_only_the_keys_it_was_holding() {
            let mut roster = Roster::new(true);
            for id in ["driver", "helper"] {
                roster.join(id);
                roster.verify(id, &claims(id, true));
            }
            let mut input = SharedInput::new();
            let now = Instant::now();
            input.accept(&roster, "driver", &key("ShiftLeft", true, 1), now);
            input.accept(&roster, "driver", &key("KeyA", true, 2), now);
            input.accept(&roster, "helper", &key("ControlLeft", true, 1), now);

            // `on_viewer_gone` for one viewer: its own held set and no other.
            let released = input.release("driver");
            assert_eq!(released.len(), 2, "shift and a, both up: {released:?}");
            assert!(!input.holding("driver"));
            assert!(
                input.holding("helper"),
                "the other controller's control is still down"
            );
            roster.leave("driver");
            assert_eq!(roster.len(), 1);

            // And the session ending releases what is left.
            assert_eq!(input.release_all().len(), 1);
            assert!(!input.holding("helper"));
        }

        /// One estimate, split controllers-first. A roomful of watchers cannot
        /// spend the machine's uplink before the person driving it is served —
        /// and `ctl` is the roster's, so a watcher cannot claim otherwise.
        #[test]
        fn a_watcher_never_starves_a_controller() {
            let mut roster = Roster::new(true);
            for id in ["driver", "w1", "w2", "w3", "w4", "w5"] {
                roster.join(id);
            }
            roster.verify("driver", &claims("driver", true));
            // A watcher's own token says it may not drive, whatever it sends.
            roster.verify("w1", &claims("w1", false));

            let claims_out: Vec<UplinkClaim> = roster
                .iter()
                .map(|record| UplinkClaim {
                    viewer_id: record.viewer_id.clone(),
                    ctl: roster.control_granted(&record.viewer_id),
                    demand_bps: Ceiling::default().bitrate_bps,
                })
                .collect();
            assert_eq!(claims_out.iter().filter(|c| c.ctl).count(), 1);

            // A line that cannot pay everyone: two floors' worth for six.
            let thin = UplinkBudget::new(2 * crate::transport::governor::UPLINK_VIEWER_FLOOR_BPS);
            let shares = thin.allocate(&claims_out);
            let driver = shares
                .iter()
                .find(|s| s.viewer_id == "driver")
                .expect("the controller is in the split");
            assert!(!driver.starved, "a controller is floored before any watcher");
            assert!(driver.bps >= crate::transport::governor::UPLINK_VIEWER_FLOOR_BPS);
            assert!(
                shares.iter().filter(|s| s.starved).count() >= 4,
                "the watchers the estimate cannot pay say so rather than pretending"
            );
            let handed: u64 = shares.iter().map(|s| u64::from(s.bps)).sum();
            assert!(handed <= u64::from(2 * crate::transport::governor::UPLINK_VIEWER_FLOOR_BPS));
        }

        /// The estimate is unmeasured, so it is sized at the top of the quality
        /// menu: one viewer must see exactly the session it saw before the split
        /// existed, whatever preset it asks for.
        #[test]
        fn one_viewer_is_never_capped_by_the_shared_uplink() {
            let alone = [UplinkClaim {
                viewer_id: "a".to_owned(),
                ctl: true,
                demand_bps: quality::BITRATE_CAPS_BPS[quality::BITRATE_CAPS_BPS.len() - 1],
            }];
            let shares = UplinkBudget::new(HOST_UPLINK_ESTIMATE_BPS).allocate(&alone);
            assert_eq!(shares[0].bps, alone[0].demand_bps);
            assert!(!shares[0].starved);
        }
    }
}
