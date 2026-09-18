//! Rate governor: viewer feedback in, one bitrate target out. Task 6.5 extends
//! it with the fps and resolution ladders.
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
//!
//! # What remains before this is congestion control
//!
//! The step-response runs research/05 §7 asks for and spike 0.2 did not do
//! (50 → 5 → 50 Mbps: time to first cut, overshoot, recovery time), a capacity
//! estimate of some kind, and a decision about a viewer gone silent.
//!
//! # Applying the target
//!
//! [`Governor::on_report`] returns a new target only when it moved. The caller
//! applies it to **both** [`RtcPeer::set_bitrate_ceiling`] and
//! [`Encoder::set_bitrate`] — the gate and the source have to agree or the gate
//! just drops the difference. A reconfigure is cheap (spike 0.9: the VBV moves
//! in the same call, no IDR), but a capture rebuild is a *new* encoder (Task
//! 3.7), so whoever rebuilds re-applies [`Governor::target_bps`] to it.
//!
//! [`RtcPeer::set_bitrate_ceiling`]: crate::transport::rtc::RtcPeer::set_bitrate_ceiling
//! [`Encoder::set_bitrate`]: crate::encode::Encoder::set_bitrate

use std::collections::VecDeque;
use std::time::{Duration, Instant};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GovernorConfig {
    /// The quality preset's bitrate. The target never goes above it.
    pub configured_bps: u32,
    /// The target never goes below it.
    pub floor_bps: u32,
    pub rise_trigger: Duration,
    pub reference_window: Duration,
    pub hold: Duration,
}

impl GovernorConfig {
    pub fn new(configured_bps: u32) -> Self {
        Self {
            configured_bps,
            floor_bps: (configured_bps / DEFAULT_FLOOR_FRACTION)
                .max(MIN_FLOOR_BPS)
                .min(configured_bps),
            rise_trigger: RISE_TRIGGER,
            reference_window: REFERENCE_WINDOW,
            hold: HOLD,
        }
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
    stats: GovernorStats,
}

impl Governor {
    pub fn new(cfg: GovernorConfig) -> Self {
        let cfg = GovernorConfig {
            floor_bps: cfg.floor_bps.min(cfg.configured_bps),
            ..cfg
        };
        Self {
            cfg,
            target_bps: cfg.configured_bps,
            sent: VecDeque::with_capacity(SEND_RING),
            reference: MinWindow::new(cfg.reference_window),
            last_offset_us: None,
            last_frames_dropped: None,
            last_dropped_over_budget: 0,
            degraded: false,
            hold_until: None,
            stats: GovernorStats::default(),
        }
    }

    pub fn target_bps(&self) -> u32 {
        self.target_bps
    }

    pub fn stats(&self) -> GovernorStats {
        self.stats
    }

    /// The best one-way delay still inside the reference window, in µs. It
    /// carries whatever constant offset the two clocks have — only differences
    /// against it mean anything.
    pub fn reference_min_us(&self) -> Option<i64> {
        self.reference.min()
    }

    /// Move the configured ceiling — a viewer's §5 `quality` message, or Task
    /// 6.5's preset change. A target already above the new ceiling comes down
    /// at once rather than waiting for a report.
    pub fn set_configured_bps(&mut self, configured_bps: u32) {
        self.cfg.configured_bps = configured_bps;
        self.cfg.floor_bps = self.cfg.floor_bps.min(configured_bps);
        self.target_bps = self.target_bps.clamp(self.cfg.floor_bps, configured_bps);
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
        (self.target_bps != previous).then_some(self.target_bps)
    }

    fn scale(&self, factor: f64) -> u32 {
        let scaled = (f64::from(self.target_bps) * factor).round();
        let scaled = scaled.clamp(0.0, f64::from(u32::MAX)) as u32;
        scaled.clamp(self.cfg.floor_bps, self.cfg.configured_bps)
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
}
