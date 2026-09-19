//! Rate governor: viewer feedback in, a bitrate target and a quality rung out.
//!
//! # What this is, and what it is not
//!
//! It is the one-way-delay-rise rule moonlight-web ships: every frame carries
//! the host's send stamp, the viewer reports when the frame arrived, and the
//! difference is compared against the best of a 30-second rolling window. Both
//! clocks' offset is a constant inside that subtraction, so it cancels and no
//! clock sync is needed. A rise above [`GovernorConfig::rise_trigger`] cuts the
//! target 20%, holds it for 2 seconds, then climbs 5% per quiet report, never
//! above the configured setting.
//!
//! It is **not congestion control**, and saying otherwise would be the same
//! mistake the numbers below were gathered to prevent. It never probes, never
//! estimates capacity and never discovers a ceiling — it only ever descends
//! from the one it was given, on fixed constants, with no model of the path. It
//! cannot tell a congested uplink from a busy encoder or a browser tab the
//! compositor has throttled: all three present as a delay rise, and all three
//! get the same 20%.
//!
//! Task 6.5 added the frame-rate and resolution ladders under that rule. It did
//! not make any of the paragraph above less true, and the ladder in particular
//! is not a second controller — see the next section for what it actually
//! changes, which is less than its name suggests.
//!
//! # The ladder does not reduce the rate, and saying so matters
//!
//! The encoder is CBR with a one-frame VBV (plan.md D7). Hand a CBR encoder
//! half the frames and it spends the same budget on bigger ones; hand it a
//! quarter of the pixels and it spends the same budget on fewer, better ones.
//! **[`Governor::target_bps`] is the only output of this module that changes
//! how many bits go on the wire.** The rung is a *quality allocation*: once the
//! rate is pinned at the floor and the path is still degrading, spending that
//! floor on 15 fps at 720p is watchable where spending it on 60 fps at 4K is
//! not. That is the whole claim, and it is worth less than a capacity estimate.
//!
//! So the ladder is deliberately one sequence and not two counters
//! ([`Ceiling::rungs`]): frame rate first, then resolution, one index walked
//! down and back up. Two independent axes with two independent triggers is how
//! a ladder ends up trading fps for pixels and back at 2 Hz forever; a single
//! monotone index cannot. On top of that a rung moves only after
//! [`LADDER_DWELL`], and only ever one step per evaluation.
//!
//! # A rung change is a new encoder, and its first frame is an IDR
//!
//! There is no `reconfigure` control message and there is no `VideoDecoder`.
//! Gate G1 chose the RTP media track: the browser renders into a `<video>`,
//! which follows a resolution change by itself, `web/lib/swoop/video/decoder.ts`
//! is an empty stub for exactly that reason, and `signal::messages` is frozen
//! and `deny_unknown_fields` besides, so no such message could be added anyway.
//!
//! What survives from the arm-A design is the only part of it that was ever
//! about correctness: **never emit a chunk whose references the client cannot
//! have.** A width or height change is a *new encoder* and not a reconfigure
//! (`EncoderConfig`, spike 3.7), the capture loop's rebuild path forces an IRAP
//! out of the new one, and nothing from the old encoder may follow it. The
//! discipline is the IDR, not a handshake. [`LadderChange::needs_new_encoder`]
//! is how a caller tells the two cases apart.
//!
//! # Why the trigger is timing and never loss
//!
//! Spike 0.2 §7 measured str0m's own pacer holding **1015.6 ms p50 / 1437.3 p95
//! / 1521 max** of queue (peak 1,633,528 bytes, 1,498 packets) — 87% of the
//! 1165.9 ms end-to-end figure — while GoogCC settled at **8.9 Mbps on
//! loopback against a 20 Mbps encoder**, delivering 46 of 60 fps.
//! `packetsLost`, `pliCount`, `nackCount` and `freezeCount` were **zero in both
//! columns**. The failure presents purely as latency, so a loss-based health
//! check would have called that configuration healthy while the viewer watched
//! a second-old desktop. [`crate::transport::rtc::PeerConfig::enable_bwe`] is
//! therefore false, which also means `PeerEvent::BitrateEstimate` never fires:
//! plan.md D3's "the governor arbitrates over GoogCC on arm B" has no estimate
//! to arbitrate with, and this is the primary controller. Arbitrating over a
//! signal measured at 45% of the source rate on an unimpaired path is not worth
//! building against until the step-response experiments exist.
//!
//! # Where its three inputs come from
//!
//! 1. **Delay rise**, from `swoop-feedback` `fb` samples at 2 Hz. PROTOCOL §5's
//!    `fb` carries raw stamps and the wire type is `deny_unknown_fields`, so
//!    there is no field for a client-computed rise and none is invented: the
//!    viewer computes its own copy for the stats overlay, this recomputes the
//!    number it actuates on from the stamps plus [`Governor::on_frame_sent`].
//!    A decision that moves the host's encoder is made from the host's own
//!    arithmetic over raw samples, not from a scalar a viewer asserts.
//! 2. **Frame gaps**, from a rise in `stats.framesDropped` — frames the viewer
//!    never presented.
//! 3. **The host's own refusals**, from [`PacerStats::dropped_over_budget`]. A
//!    frame the admission gate refused is congestion the host caused itself,
//!    and it counts the same as the viewer reporting one missing.
//!
//! Two fields `stats` also carries are read by nothing here, on purpose.
//! `rttMs` is a real measurement (`feedback.ts` refuses to send one before a
//! `pong` has come back) but a rise in it and a rise in one-way delay are the
//! same event seen twice, and actuating on both would double every cut.
//! `decodeQueue` is **always zero** on this path: arm B has no WebCodecs queue
//! to report and `feedback.ts` sends a literal `0`. A trigger on it would look
//! like a viewer-side backpressure signal and would be a constant.
//!
//! # What it cannot detect, stated plainly
//!
//! - **A viewer that goes quiet.** Silence is not a signal here: no reports
//!   means no evaluation and the target sits where it is. A dead path and an
//!   idle desktop look identical.
//! - **Congestion that outlives the reference window.** A queue that builds and
//!   *stays* for more than 30 seconds becomes the new baseline and the rise
//!   goes to zero. That is inherited from the algorithm, not a defect in this
//!   implementation, and it is the reason a real estimator is still owed.
//! - **Anything below the trigger.** Standing bufferbloat of 20–40 ms is
//!   invisible by design; the trigger is set above the 30.7 ms p95 the
//!   bake-off measured end to end so ordinary scheduling noise is not a cut.
//! - **Loss.** NACK/RTX hides it and the measured counters were zero anyway.
//! - **Whether a rung it gave up helped.** The ladder has no feedback of its
//!   own: nothing measures the picture after a rung change, so a descent that
//!   made no difference is indistinguishable from one that saved the session.
//!   It walks back up on quiet reports either way.
//! - **A viewer whose own decoder is behind.** That is what `decodeQueue` would
//!   say, and on arm B it says nothing (above).
//!
//! # What remains before this is congestion control
//!
//! The step-response runs research/05 §7 asks for and spike 0.2 did not do
//! (50 → 5 → 50 Mbps: time to first cut, overshoot, recovery time), a capacity
//! estimate of some kind, and a decision about a viewer gone silent. The ladder
//! adds one more: a measurement that a rung change is worth its cost, since
//! today it is reasoned about rather than measured.
//!
//! # Applying the target, and the rung
//!
//! [`Governor::on_report`] returns a new bitrate target only when it moved. The
//! caller applies it to **both** [`RtcPeer::set_bitrate_ceiling`] and
//! [`Encoder::set_bitrate`] — the gate and the source have to agree or the gate
//! just drops the difference. A bitrate reconfigure is cheap (spike 0.9: the
//! VBV moves in the same call, no IDR), but a capture rebuild is a *new*
//! encoder (Task 3.7), so whoever rebuilds re-applies [`Governor::target_bps`]
//! to it.
//!
//! [`Governor::take_ladder`] is read straight after `on_report` and answers at
//! most one change per evaluation. The caller owes it two different things:
//!
//! - **Resolution moved** ([`LadderChange::needs_new_encoder`]): re-plan the
//!   encode size with `scale::plan(source, rung.resolution.narrow(limits))` and
//!   open a new encoder at it. Its first frame is an IRAP and no frame from the
//!   old one may follow it. Narrow by the **rung's** cap, not the ceiling's: the
//!   ceiling is the top rung, so narrowing by it makes a resolution move a
//!   re-plan that changes nothing. At the top rung the two are the same cap.
//! - **Frame rate moved**: feed the encoder at most [`QualityRung::fps`] frames
//!   a second. It is a capture-side decision, not an `EncoderConfig` one —
//!   `fps` there sizes rate control and drops nothing.
//!
//! **Both actuators are wired.** `session/mod.rs`'s `apply_ladder` drains
//! [`Governor::take_ladder`] after every report and after a `quality` message,
//! re-plans on a resolution move and sends `ToCapture::Fps` on a frame-rate one.
//! The frame-rate gate is deliberately skipped at `TARGET_FPS`: duplication is
//! vsync-locked at 16.67 ms and a 16.666 ms gate drops every other frame on
//! jitter.
//!
//! [`RtcPeer::set_bitrate_ceiling`]: crate::transport::rtc::RtcPeer::set_bitrate_ceiling
//! [`Encoder::set_bitrate`]: crate::encode::Encoder::set_bitrate

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::session::quality::{Ceiling, QualityRung};
use crate::signal::messages::channel::Feedback;
use crate::transport::pacer::PacerStats;

/// How far back the best-of-session reference looks. Long enough that a
/// transient queue cannot become the baseline, short enough that a path which
/// genuinely got better is not held to a minimum it will never see again.
pub const REFERENCE_WINDOW: Duration = Duration::from_secs(30);

/// No second cut inside this, so the encoder has time to comply and the queue
/// it built has time to drain. The first reports after a cut still carry the
/// delay the cut was answering.
pub const HOLD: Duration = Duration::from_secs(2);

/// Above the 30.7 ms p95 the bake-off measured end to end on loopback, so
/// ordinary scheduling noise is not read as congestion.
pub const RISE_TRIGGER: Duration = Duration::from_millis(50);

/// Multiplicative decrease, multiplicative increase. Asymmetric on purpose:
/// down fast because the queue is already built, up slowly because the only
/// way this finds a ceiling is by walking into it again.
const CUT_FACTOR: f64 = 0.80;
const CLIMB_FACTOR: f64 = 1.05;

/// A viewer's reported clock offset moving by more than this invalidates the
/// reference: the subtraction only cancels a *constant* bias, so a step in the
/// offset shifts every past sample and would otherwise fake a rise or hide one.
const OFFSET_STEP_US: i64 = 10_000;

/// Send stamps kept for the `fb` join — 10 seconds at 60 fps. Feedback older
/// than that is useless anyway.
const SEND_RING: usize = 600;

/// Never govern below this: a target small enough to be unwatchable is a
/// failure the viewer should see as a disconnect, not as a slideshow.
const MIN_FLOOR_BPS: u32 = 500_000;

/// The floor, when the caller does not name one: a rate cut this far has not
/// been rescued by cutting further.
const DEFAULT_FLOOR_FRACTION: u32 = 8;

/// No rung moves inside this, in either direction. Longer than [`HOLD`] on
/// purpose: the bitrate ladder gets several attempts at a degraded window
/// before the rung ladder is allowed to conclude the rate was never the
/// problem.
pub const LADDER_DWELL: Duration = Duration::from_secs(5);

/// Consecutive quiet evaluations before a rung is given back — 3 s at the 2 Hz
/// report cadence, against the single degraded report that spends one. That
/// asymmetry is the hysteresis, and it is why a flapping path settles at the
/// lower rung instead of between two.
const LADDER_RECOVER_QUIET: u32 = 6;

/// And the rate has to be back at this share of the ceiling first. Giving a
/// rung back while the bitrate is still climbing out of a cut is how one
/// congested window gets paid for twice.
const LADDER_RECOVER_SHARE: f64 = 0.9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GovernorConfig {
    /// The quality preset. The target never goes above `ceiling.bitrate_bps`,
    /// and the ladder starts at the preset's own frame rate and resolution.
    pub ceiling: Ceiling,
    /// The target never goes below it.
    pub floor_bps: u32,
    pub rise_trigger: Duration,
    pub reference_window: Duration,
    pub hold: Duration,
}

impl GovernorConfig {
    pub fn new(configured_bps: u32) -> Self {
        Self::for_ceiling(Ceiling {
            bitrate_bps: configured_bps,
            ..Ceiling::default()
        })
    }

    pub fn for_ceiling(ceiling: Ceiling) -> Self {
        Self {
            ceiling,
            floor_bps: (ceiling.bitrate_bps / DEFAULT_FLOOR_FRACTION)
                .max(MIN_FLOOR_BPS)
                .min(ceiling.bitrate_bps),
            rise_trigger: RISE_TRIGGER,
            reference_window: REFERENCE_WINDOW,
            hold: HOLD,
        }
    }
}

/// One word for the stats line: what the governor is doing right now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum GovernorState {
    /// At the preset's ceiling with nothing to answer.
    #[default]
    Ceiling,
    /// Inside the hold after a cut, where no report can move anything.
    Holding,
    /// Below the ceiling and walking back up.
    Climbing,
    /// At the floor. Every further degraded window is answered by the ladder,
    /// or — once that is spent too — by nothing at all.
    Pinned,
}

/// A rung the governor has just moved to, and the one it came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LadderChange {
    pub rung: QualityRung,
    pub previous: QualityRung,
}

impl LadderChange {
    /// A resolution move is a new encoder and a fresh IRAP out of it; a frame
    /// rate move is a capture-side decision the running encoder never hears
    /// about. The caller owes a different thing for each.
    pub fn needs_new_encoder(&self) -> bool {
        self.rung.resolution != self.previous.resolution
    }
}

/// Counters, because a rate that moved and nobody can say why is the failure
/// mode this whole module exists to avoid.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GovernorStats {
    /// Evaluations that answered a degraded window — counted whether or not the
    /// floor left any room, so a session pinned at the floor and still
    /// degrading is visible rather than looking settled.
    pub cuts: u64,
    /// Evaluations that actually raised the target. A quiet report at the
    /// ceiling is not a climb.
    pub climbs: u64,
    /// `fb` samples that joined a send stamp.
    pub delay_samples: u64,
    /// `fb` for a frame this governor never saw sent — too old for the ring, or
    /// a viewer reporting something that was never sent to it.
    pub unmatched_feedback: u64,
    pub frame_gaps: u64,
    /// Admission-gate refusals observed between reports.
    pub local_refusals: u64,
    pub reference_resets: u64,
    pub last_owd_us: i64,
    pub last_rise_us: i64,
    /// Rungs given up, and rungs given back. Both, because a session that spent
    /// its whole life walking one rung up and down is a tuning bug and looks
    /// identical to a settled one if only the current rung is reported.
    pub ladder_down: u64,
    pub ladder_up: u64,
    /// Where the ladder stands, and how far down the preset it is.
    pub rung: QualityRung,
    pub rung_index: u32,
}

/// The rolling minimum, as a monotonic deque: the front is the smallest sample
/// still inside the window, maintained in amortised O(1).
#[derive(Debug)]
struct MinWindow {
    window: Duration,
    samples: VecDeque<(Instant, i64)>,
}

impl MinWindow {
    fn new(window: Duration) -> Self {
        Self {
            window,
            samples: VecDeque::new(),
        }
    }

    fn push(&mut self, now: Instant, value: i64) {
        while self.samples.back().is_some_and(|&(_, v)| v >= value) {
            self.samples.pop_back();
        }
        self.samples.push_back((now, value));
        while self
            .samples
            .front()
            .is_some_and(|&(t, _)| now.saturating_duration_since(t) > self.window)
        {
            self.samples.pop_front();
        }
    }

    fn min(&self) -> Option<i64> {
        self.samples.front().map(|&(_, v)| v)
    }

    fn clear(&mut self) {
        self.samples.clear();
    }
}

/// One viewer's rate governor. Driven from the thread that owns the peer.
#[derive(Debug)]
pub struct Governor {
    cfg: GovernorConfig,
    target_bps: u32,
    /// `(frame_id, send_us)`, oldest first. `send_us` is §4's stamp:
    /// microseconds since `streamerEpoch`.
    sent: VecDeque<(u32, u64)>,
    reference: MinWindow,
    last_offset_us: Option<i64>,
    last_frames_dropped: Option<u32>,
    last_dropped_over_budget: u64,
    /// Set by anything degrading between reports, cleared by each evaluation.
    degraded: bool,
    hold_until: Option<Instant>,
    /// The preset's ladder, richest first, rebuilt whenever the preset moves.
    rungs: Vec<QualityRung>,
    rung: usize,
    rung_moved_at: Option<Instant>,
    /// Consecutive evaluations with nothing to answer. Reset by a degraded one
    /// and by a rung move.
    quiet_reports: u32,
    /// A rung move the caller has not collected yet.
    pending: Option<LadderChange>,
    stats: GovernorStats,
}

impl Governor {
    pub fn new(cfg: GovernorConfig) -> Self {
        let cfg = GovernorConfig {
            floor_bps: cfg.floor_bps.min(cfg.ceiling.bitrate_bps),
            ..cfg
        };
        let rungs = cfg.ceiling.rungs();
        let stats = GovernorStats {
            rung: *rungs.first().expect("a ceiling always has its own rung"),
            ..GovernorStats::default()
        };
        Self {
            cfg,
            target_bps: cfg.ceiling.bitrate_bps,
            sent: VecDeque::with_capacity(SEND_RING),
            reference: MinWindow::new(cfg.reference_window),
            last_offset_us: None,
            last_frames_dropped: None,
            last_dropped_over_budget: 0,
            degraded: false,
            hold_until: None,
            rungs,
            rung: 0,
            rung_moved_at: None,
            quiet_reports: 0,
            pending: None,
            stats,
        }
    }

    pub fn target_bps(&self) -> u32 {
        self.target_bps
    }

    pub fn stats(&self) -> GovernorStats {
        self.stats
    }

    pub fn ceiling(&self) -> Ceiling {
        self.cfg.ceiling
    }

    /// The frame rate and resolution the ladder currently allows.
    pub fn rung(&self) -> QualityRung {
        *self.rungs.get(self.rung).expect("the index is only ever moved inside the ladder")
    }

    /// The rung move the last [`Governor::on_report`] produced, if any. Read it
    /// straight after that call; at most one move per evaluation.
    pub fn take_ladder(&mut self) -> Option<LadderChange> {
        self.pending.take()
    }

    /// One word for the stats line.
    pub fn state(&self, now: Instant) -> GovernorState {
        if self.hold_until.is_some_and(|until| now < until) {
            return GovernorState::Holding;
        }
        if self.target_bps >= self.cfg.ceiling.bitrate_bps {
            return GovernorState::Ceiling;
        }
        if self.target_bps <= self.cfg.floor_bps {
            return GovernorState::Pinned;
        }
        GovernorState::Climbing
    }

    /// The best one-way delay still inside the reference window, in µs. It
    /// carries whatever constant offset the two clocks have — only differences
    /// against it mean anything.
    pub fn reference_min_us(&self) -> Option<i64> {
        self.reference.min()
    }

    /// Move the bitrate ceiling alone, leaving the other two axes where the
    /// preset put them. A target already above the new ceiling comes down at
    /// once rather than waiting for a report.
    pub fn set_configured_bps(&mut self, configured_bps: u32) {
        self.set_ceiling(Ceiling {
            bitrate_bps: configured_bps,
            ..self.cfg.ceiling
        });
    }

    /// A viewer's §5 `quality` message, whole.
    ///
    /// A new preset is a new ladder and it is descended from the top: the old
    /// index counted rungs that no longer exist, and a person who has just
    /// stated what they want should get it before the governor starts taking it
    /// away again.
    pub fn set_ceiling(&mut self, ceiling: Ceiling) {
        if self.cfg.ceiling == ceiling {
            return;
        }
        let previous = self.rung();
        self.cfg.ceiling = ceiling;
        self.cfg.floor_bps = self.cfg.floor_bps.min(ceiling.bitrate_bps);
        self.target_bps = self.target_bps.clamp(self.cfg.floor_bps, ceiling.bitrate_bps);
        self.rungs = ceiling.rungs();
        self.rung = 0;
        self.rung_moved_at = None;
        self.quiet_reports = 0;
        let rung = self.rung();
        self.stats.rung = rung;
        self.stats.rung_index = 0;
        if rung != previous {
            self.pending = Some(LadderChange { rung, previous });
        }
    }

    /// Record a frame's send stamp so its feedback can be joined later. Called
    /// for every frame handed to the transport, not only sampled ones.
    pub fn on_frame_sent(&mut self, frame_id: u32, send_us: u64) {
        if self.sent.len() == SEND_RING {
            self.sent.pop_front();
        }
        self.sent.push_back((frame_id, send_us));
    }

    /// One `swoop-feedback` message from the viewer. `ping`/`pong` is the
    /// signaling layer's to answer; nothing here actuates on it, because the
    /// offset it produces already arrives inside every `fb`.
    pub fn on_feedback(&mut self, now: Instant, feedback: &Feedback) {
        match *feedback {
            Feedback::Fb {
                frame_id,
                t_arrival_us,
                clock_offset_us,
                ..
            } => self.on_delay_sample(now, frame_id, t_arrival_us, clock_offset_us),
            Feedback::Stats { frames_dropped, .. } => {
                let previous = self.last_frames_dropped.replace(frames_dropped);
                // Only a rise counts: the counter is cumulative, and a viewer
                // that reconnected starts a new one.
                if previous.is_some_and(|prev| frames_dropped > prev) {
                    self.stats.frame_gaps += 1;
                    self.degraded = true;
                }
            }
            Feedback::Ping { .. } | Feedback::Pong { .. } => {}
        }
    }

    /// Evaluate one report window and return the new target, or `None` when it
    /// did not move. `pacer` is the peer's current counters — the delta in
    /// [`PacerStats::dropped_over_budget`] is the host's own congestion signal.
    pub fn on_report(&mut self, now: Instant, pacer: PacerStats) -> Option<u32> {
        if pacer.dropped_over_budget > self.last_dropped_over_budget {
            self.stats.local_refusals += pacer.dropped_over_budget - self.last_dropped_over_budget;
            self.degraded = true;
        }
        self.last_dropped_over_budget = pacer.dropped_over_budget;

        let degraded = std::mem::take(&mut self.degraded);
        // Counted on every report, the held ones included: the quiet run the
        // ladder recovers on is a statement about the path, and the path does
        // not stop being quiet because the encoder is still complying.
        self.quiet_reports = if degraded {
            0
        } else {
            self.quiet_reports.saturating_add(1)
        };
        // The hold covers the climb as well as the cut: the reports right after
        // a cut still carry the delay it was answering, and climbing back
        // through it would make the cut a no-op.
        if self.hold_until.is_some_and(|until| now < until) {
            return None;
        }
        self.hold_until = None;

        let previous = self.target_bps;
        if degraded {
            self.target_bps = self.scale(CUT_FACTOR);
            self.hold_until = Some(now + self.cfg.hold);
            self.stats.cuts += 1;
        } else {
            self.target_bps = self.scale(CLIMB_FACTOR);
            if self.target_bps > previous {
                self.stats.climbs += 1;
            }
        }
        self.evaluate_ladder(now, degraded);
        (self.target_bps != previous).then_some(self.target_bps)
    }

    /// At most one rung, in one direction, and never inside [`LADDER_DWELL`].
    ///
    /// Down only once the bitrate is pinned at the floor: until then the rate
    /// itself is still the answer, and giving up frames or pixels while there
    /// are bits left to give up costs picture for nothing.
    fn evaluate_ladder(&mut self, now: Instant, degraded: bool) {
        if self
            .rung_moved_at
            .is_some_and(|at| now.saturating_duration_since(at) < LADDER_DWELL)
        {
            return;
        }
        let pinned = self.target_bps <= self.cfg.floor_bps;
        let recovered = f64::from(self.target_bps)
            >= f64::from(self.cfg.ceiling.bitrate_bps) * LADDER_RECOVER_SHARE;
        let down = if degraded && pinned && self.rung + 1 < self.rungs.len() {
            true
        } else if !degraded
            && self.rung > 0
            && recovered
            && self.quiet_reports >= LADDER_RECOVER_QUIET
        {
            false
        } else {
            return;
        };

        let previous = self.rung();
        if down {
            self.rung += 1;
            self.stats.ladder_down += 1;
        } else {
            self.rung -= 1;
            self.stats.ladder_up += 1;
        }
        self.rung_moved_at = Some(now);
        self.quiet_reports = 0;
        let rung = self.rung();
        self.stats.rung = rung;
        self.stats.rung_index = self.rung as u32;
        self.pending = Some(LadderChange { rung, previous });
    }

    fn scale(&self, factor: f64) -> u32 {
        let scaled = (f64::from(self.target_bps) * factor).round();
        let scaled = scaled.clamp(0.0, f64::from(u32::MAX)) as u32;
        scaled.clamp(self.cfg.floor_bps, self.cfg.ceiling.bitrate_bps)
    }

    fn on_delay_sample(
        &mut self,
        now: Instant,
        frame_id: u32,
        t_arrival_us: i64,
        clock_offset_us: i64,
    ) {
        let Some(send_us) = self.send_stamp(frame_id) else {
            self.stats.unmatched_feedback += 1;
            return;
        };
        if self
            .last_offset_us
            .is_some_and(|prev| (clock_offset_us - prev).abs() > OFFSET_STEP_US)
        {
            self.reference.clear();
            self.stats.reference_resets += 1;
        }
        self.last_offset_us = Some(clock_offset_us);

        // The viewer's arrival stamp is on its own clock; the offset it reports
        // puts it on the host's. An error in that offset is a constant and
        // cancels against the window minimum, which is why a *step* in it is
        // the only thing that matters above.
        let owd_us = t_arrival_us.saturating_add(clock_offset_us) - send_us as i64;
        self.reference.push(now, owd_us);
        let rise_us = owd_us - self.reference.min().unwrap_or(owd_us);
        self.stats.delay_samples += 1;
        self.stats.last_owd_us = owd_us;
        self.stats.last_rise_us = rise_us;
        if rise_us >= self.cfg.rise_trigger.as_micros() as i64 {
            self.degraded = true;
        }
    }

    fn send_stamp(&self, frame_id: u32) -> Option<u64> {
        self.sent
            .iter()
            .rev()
            .find(|&&(id, _)| id == frame_id)
            .map(|&(_, send_us)| send_us)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIGURED: u32 = 20_000_000;
    const REPORT: Duration = Duration::from_millis(500);
    /// One frame interval at 60 fps, in the µs the stamps are in.
    const FRAME_US: u64 = 16_667;

    struct Fixture {
        governor: Governor,
        now: Instant,
        pacer: PacerStats,
        next_frame: u32,
        send_us: u64,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                governor: Governor::new(GovernorConfig::new(CONFIGURED)),
                now: Instant::now(),
                pacer: PacerStats::default(),
                next_frame: 0,
                send_us: 1_000_000,
            }
        }

        /// Send a frame and report its arrival `owd_us` later, on a viewer
        /// clock that is deliberately nowhere near the host's.
        fn frame(&mut self, owd_us: i64) {
            let frame_id = self.next_frame;
            self.next_frame += 1;
            self.send_us += FRAME_US;
            self.governor.on_frame_sent(frame_id, self.send_us);
            const SKEW_US: i64 = 7_000_000;
            self.governor.on_feedback(
                self.now,
                &Feedback::Fb {
                    frame_id,
                    t_arrival_us: self.send_us as i64 + owd_us - SKEW_US,
                    t_decode_us: 0,
                    t_present_us: 0,
                    clock_offset_us: SKEW_US,
                },
            );
        }

        /// One report window: a few frames at `owd_us`, then the evaluation.
        fn report(&mut self, owd_us: i64) -> Option<u32> {
            for _ in 0..3 {
                self.frame(owd_us);
            }
            self.now += REPORT;
            self.governor.on_report(self.now, self.pacer)
        }

        /// One degraded window, then the whole hold, so the next one is free to
        /// act. The good frame keeps the reference window's minimum where it
        /// is — without it the raised delay ages into the baseline and reads as
        /// health long before the target reaches the floor.
        fn degraded_window(&mut self) -> Option<LadderChange> {
            self.frame(GOOD);
            self.report(RISEN);
            self.now += HOLD;
            self.governor.take_ladder()
        }

        /// Cut until the rate has nowhere left to go.
        fn drive_to_the_floor(&mut self) -> Vec<LadderChange> {
            self.report(GOOD);
            let mut changes = Vec::new();
            while self.governor.target_bps() > self.governor.cfg.floor_bps {
                if let Some(change) = self.degraded_window() {
                    changes.push(change);
                }
            }
            changes
        }
    }

    const GOOD: i64 = 5_000;
    const RISEN: i64 = 5_000 + 60_000;

    #[test]
    fn a_delay_rise_cuts_the_target_by_twenty_percent() {
        let mut f = Fixture::new();
        assert_eq!(f.report(GOOD), None, "at the ceiling there is nowhere to go");
        assert_eq!(f.report(RISEN), Some(16_000_000));
        assert_eq!(f.governor.stats().cuts, 1);
    }

    #[test]
    fn no_further_cut_inside_the_two_second_hold() {
        let mut f = Fixture::new();
        f.report(GOOD);
        assert_eq!(f.report(RISEN), Some(16_000_000));
        // Three more reports inside the 2 s hold, every one of them degraded.
        assert_eq!(f.report(RISEN), None);
        assert_eq!(f.report(RISEN), None);
        assert_eq!(f.report(RISEN), None);
        assert_eq!(f.governor.target_bps(), 16_000_000);
        assert_eq!(f.governor.stats().cuts, 1);
        // The fourth lands 2 s after the cut and is free to act again.
        assert_eq!(f.report(RISEN), Some(12_800_000));
    }

    #[test]
    fn a_quiet_report_climbs_five_percent_and_the_hold_covers_the_climb_too() {
        let mut f = Fixture::new();
        f.report(GOOD);
        assert_eq!(f.report(RISEN), Some(16_000_000));
        assert_eq!(f.report(GOOD), None, "quiet, but inside the hold");
        assert_eq!(f.report(GOOD), None);
        assert_eq!(f.report(GOOD), None);
        assert_eq!(f.report(GOOD), Some(16_800_000));
        assert_eq!(f.report(GOOD), Some(17_640_000));
        assert_eq!(f.governor.stats().climbs, 2);
    }

    #[test]
    fn the_climb_stops_dead_at_the_configured_ceiling() {
        let mut f = Fixture::new();
        f.report(RISEN);
        f.now += HOLD;
        for _ in 0..40 {
            f.report(GOOD);
        }
        assert_eq!(f.governor.target_bps(), CONFIGURED);
        assert_eq!(f.report(GOOD), None, "a target that cannot move is not news");
    }

    #[test]
    fn repeated_cuts_stop_at_the_floor() {
        let mut f = Fixture::new();
        let floor = GovernorConfig::new(CONFIGURED).floor_bps;
        f.report(GOOD);
        for _ in 0..15 {
            // One good frame per window, or the raised delay would age into the
            // baseline before the target reached the floor.
            f.frame(GOOD);
            f.report(RISEN);
            f.now += HOLD;
        }
        assert_eq!(f.governor.target_bps(), floor);
        assert_eq!(floor, CONFIGURED / 8);
    }

    #[test]
    fn a_frame_gap_cuts_with_no_delay_rise_at_all() {
        let mut f = Fixture::new();
        f.report(GOOD);
        let stats = |frames_dropped| Feedback::Stats {
            decode_queue: 0,
            frames_dropped,
            jitter_ms: 0.0,
            rtt_ms: 7.0,
            width_css: 1920,
            height_css: 1080,
        };
        f.governor.on_feedback(f.now, &stats(0));
        assert_eq!(f.report(GOOD), None, "a first cumulative count is not a gap");
        f.governor.on_feedback(f.now, &stats(4));
        assert_eq!(f.report(GOOD), Some(16_000_000));
        assert_eq!(f.governor.stats().frame_gaps, 1);
    }

    #[test]
    fn the_hosts_own_admission_refusal_counts_as_congestion() {
        let mut f = Fixture::new();
        f.report(GOOD);
        f.pacer.dropped_over_budget += 2;
        assert_eq!(f.report(GOOD), Some(16_000_000));
        assert_eq!(f.governor.stats().local_refusals, 2);
        // The counter is cumulative: the same value next window is not a new
        // refusal, or the governor would cut forever off one drop.
        f.now += HOLD;
        assert_eq!(f.report(GOOD), Some(16_800_000));
    }

    #[test]
    fn an_offset_step_resets_the_reference_rather_than_faking_a_rise() {
        let mut f = Fixture::new();
        f.report(GOOD);
        // The viewer re-estimates its clock offset and it moves 200 ms. Every
        // past sample is now on a different footing.
        f.governor.on_frame_sent(900, f.send_us);
        f.governor.on_feedback(
            f.now,
            &Feedback::Fb {
                frame_id: 900,
                t_arrival_us: f.send_us as i64 + GOOD - 7_200_000,
                t_decode_us: 0,
                t_present_us: 0,
                clock_offset_us: 7_200_000,
            },
        );
        assert_eq!(f.governor.stats().reference_resets, 1);
        assert_eq!(f.governor.stats().last_rise_us, 0);
        f.now += REPORT;
        assert_eq!(
            f.governor.on_report(f.now, f.pacer),
            None,
            "a clock step is not congestion"
        );
    }

    #[test]
    fn feedback_for_a_frame_that_was_never_sent_is_counted_not_guessed_at() {
        let mut f = Fixture::new();
        f.governor.on_feedback(
            f.now,
            &Feedback::Fb {
                frame_id: 4_242,
                t_arrival_us: 1,
                t_decode_us: 0,
                t_present_us: 0,
                clock_offset_us: 0,
            },
        );
        assert_eq!(f.governor.stats().unmatched_feedback, 1);
        assert_eq!(f.governor.stats().delay_samples, 0);
        assert_eq!(f.governor.reference_min_us(), None);
    }

    #[test]
    fn a_delay_that_outlives_the_window_becomes_the_new_baseline() {
        // Not a bug to fix here — it is the algorithm's known blind spot, and
        // the test pins it so nobody reads the absence of a cut as health.
        let mut f = Fixture::new();
        f.report(GOOD);
        assert_eq!(f.report(RISEN), Some(16_000_000));
        f.now += REFERENCE_WINDOW + HOLD;
        assert_eq!(
            f.report(RISEN),
            Some(16_800_000),
            "the raised delay is all the window holds, so it reads as quiet"
        );
    }

    #[test]
    fn the_ceiling_can_move_under_the_target_and_takes_it_with_it() {
        let mut f = Fixture::new();
        f.governor.set_configured_bps(6_000_000);
        assert_eq!(f.governor.target_bps(), 6_000_000);
        f.now += HOLD;
        for _ in 0..10 {
            f.report(GOOD);
        }
        assert_eq!(f.governor.target_bps(), 6_000_000);
    }

    #[test]
    fn the_rolling_minimum_forgets_samples_older_than_the_window() {
        let mut window = MinWindow::new(Duration::from_secs(30));
        let t0 = Instant::now();
        window.push(t0, 5_000);
        window.push(t0 + Duration::from_secs(1), 9_000);
        assert_eq!(window.min(), Some(5_000));
        window.push(t0 + Duration::from_secs(31), 9_500);
        assert_eq!(window.min(), Some(9_000));
    }

    // ------------------------------------------------------- the ladder ---

    use crate::session::quality::ResolutionCap;

    const TOP: QualityRung = QualityRung {
        fps: 60,
        resolution: ResolutionCap::Native,
    };

    #[test]
    fn the_ladder_does_not_move_until_the_rate_has_run_out() {
        let mut f = Fixture::new();
        let changes = f.drive_to_the_floor();
        // Ten cuts to reach the floor, every one of them a degraded window, and
        // exactly one rung given up: the one on the window where 20% off the
        // target stopped being an answer.
        assert!(f.governor.stats().cuts >= 10);
        assert_eq!(changes.len(), 1, "frames are spent only after bits are");
        assert_eq!(changes[0].previous, TOP);
        assert_eq!(
            changes[0].rung,
            QualityRung {
                fps: 30,
                resolution: ResolutionCap::Native
            }
        );
        assert!(!changes[0].needs_new_encoder());
    }

    /// The scripted trace: sixty seconds of a path that will not recover, then
    /// the ladder has nothing left to give and says so by staying still.
    #[test]
    fn a_path_that_never_recovers_walks_the_ladder_down_once_and_stops() {
        let mut f = Fixture::new();
        let mut changes = f.drive_to_the_floor();
        for _ in 0..40 {
            if let Some(change) = f.degraded_window() {
                changes.push(change);
            }
        }
        let rungs: Vec<QualityRung> = changes.iter().map(|change| change.rung).collect();
        assert_eq!(
            rungs,
            vec![
                QualityRung {
                    fps: 30,
                    resolution: ResolutionCap::Native
                },
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::Native
                },
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::P1440
                },
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::P1080
                },
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::P720
                },
            ],
            "frame rate first, then pixels, one rung at a time"
        );
        assert_eq!(f.governor.stats().ladder_down, 5);
        assert_eq!(f.governor.stats().ladder_up, 0);
        assert_eq!(f.governor.stats().rung_index, 5);
    }

    /// Which changes are a new encoder, which are not. This is the whole of
    /// what survived arm A's "reconfigure then IDR": a resolution move is a new
    /// encoder whose first frame is an IRAP, and a frame-rate move is not a
    /// move the running encoder ever hears about.
    #[test]
    fn a_resolution_rung_is_a_new_encoder_and_a_frame_rate_rung_is_not() {
        let mut f = Fixture::new();
        let mut changes = f.drive_to_the_floor();
        for _ in 0..40 {
            if let Some(change) = f.degraded_window() {
                changes.push(change);
            }
        }
        let rebuilds: Vec<bool> = changes
            .iter()
            .map(LadderChange::needs_new_encoder)
            .collect();
        assert_eq!(rebuilds, vec![false, false, true, true, true]);
    }

    #[test]
    fn no_rung_moves_twice_inside_the_dwell() {
        let mut f = Fixture::new();
        f.drive_to_the_floor();
        let at = f.now;
        // Two more degraded windows land 2.5 s apart, inside the 5 s dwell.
        assert_eq!(f.degraded_window(), None);
        assert!(f.now.duration_since(at) < LADDER_DWELL);
        assert!(f.degraded_window().is_some(), "and the next one is free");
    }

    /// The other half: a path that recovers gets its rungs back in the order it
    /// lost them, and never faster than the dwell — which is what makes the
    /// ladder a ladder rather than a thing that flaps.
    #[test]
    fn a_recovered_path_gives_the_rungs_back_in_the_order_it_took_them() {
        let mut f = Fixture::new();
        f.drive_to_the_floor();
        for _ in 0..40 {
            f.degraded_window();
        }
        let down = f.governor.stats().ladder_down;
        assert_eq!(down, 5);

        let mut back = Vec::new();
        for _ in 0..400 {
            f.report(GOOD);
            if let Some(change) = f.governor.take_ladder() {
                back.push(change);
            }
        }
        let rungs: Vec<QualityRung> = back.iter().map(|change| change.rung).collect();
        assert_eq!(
            rungs,
            vec![
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::P1080
                },
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::P1440
                },
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::Native
                },
                QualityRung {
                    fps: 30,
                    resolution: ResolutionCap::Native
                },
                TOP,
            ],
            "exactly the descent, retraced"
        );
        assert_eq!(f.governor.stats().ladder_up, down);
        assert_eq!(f.governor.rung(), TOP);
        assert_eq!(f.governor.target_bps(), CONFIGURED);
    }

    /// No rung is given back while the rate is still climbing out of the cut
    /// that cost it. A quiet report at the floor is not a recovered path.
    #[test]
    fn a_rung_is_not_given_back_on_a_quiet_report_alone() {
        let mut f = Fixture::new();
        f.drive_to_the_floor();
        assert_eq!(f.governor.stats().ladder_down, 1);
        // Well past the dwell, and far more than the six quiet reports the
        // hysteresis asks for — but the target is still down at the floor.
        for _ in 0..30 {
            f.report(GOOD);
            assert_eq!(f.governor.take_ladder(), None);
        }
        assert!(f.governor.target_bps() < CONFIGURED);
        assert_eq!(f.governor.stats().ladder_up, 0);
    }

    #[test]
    fn a_new_preset_restarts_the_ladder_at_its_own_top() {
        let mut f = Fixture::new();
        f.drive_to_the_floor();
        assert_eq!(f.governor.rung().fps, 30);

        let ceiling = Ceiling {
            bitrate_bps: 10_000_000,
            fps: 30,
            resolution: ResolutionCap::P1080,
        };
        f.governor.set_ceiling(ceiling);
        let change = f.governor.take_ladder().expect("the rung moved");
        assert_eq!(
            change.rung,
            QualityRung {
                fps: 30,
                resolution: ResolutionCap::P1080
            }
        );
        assert!(change.needs_new_encoder(), "1080p is a new encode size");
        assert_eq!(f.governor.ceiling(), ceiling);
        assert_eq!(f.governor.stats().rung_index, 0);
    }

    #[test]
    fn a_preset_with_nothing_left_to_trade_simply_stays_where_it_is() {
        let mut f = Fixture::new();
        f.governor.set_ceiling(Ceiling {
            bitrate_bps: 5_000_000,
            fps: 15,
            resolution: ResolutionCap::P720,
        });
        f.governor.take_ladder();
        f.drive_to_the_floor();
        for _ in 0..20 {
            assert_eq!(f.degraded_window(), None);
        }
        assert_eq!(f.governor.stats().ladder_down, 0);
        assert!(f.governor.stats().cuts > 0, "the rate still answered");
    }

    #[test]
    fn the_state_word_says_which_of_the_four_things_it_is_doing() {
        let mut f = Fixture::new();
        // The first window is the reference: a delay is only raised against
        // something, so the rise the cut answers needs a quiet window first.
        f.report(GOOD);
        assert_eq!(f.governor.state(f.now), GovernorState::Ceiling);
        f.report(RISEN);
        assert_eq!(f.governor.state(f.now), GovernorState::Holding);
        f.now += HOLD;
        assert_eq!(f.governor.state(f.now), GovernorState::Climbing);
        f.drive_to_the_floor();
        f.now += HOLD;
        assert_eq!(f.governor.state(f.now), GovernorState::Pinned);
    }
}
