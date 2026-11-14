//! Send pacing and the per-viewer byte ledger.
//!
//! # Why this module exists, and what it does not do
//!
//! str0m's own pacer is unusable as configured. Spike 0.2 §7 measured it
//! directly out of `StreamTx::queue_info()` on arm B, 20 Mbps encoder,
//! loopback: with BWE on and a desired bitrate of 3× the encoder target the
//! leaky bucket held **1015.6 ms p50 / 1437.3 p95 / 1521 max** of queue,
//! peaking at 1,633,528 bytes and 1,498 packets — **87% of the 1165.9 ms
//! end-to-end figure** — while GoogCC settled at **8.9 Mbps on a path with no
//! capacity limit at all** and delivered 46 of 60 fps. `packetsLost`,
//! `pliCount`, `nackCount` and `freezeCount` were **zero in both columns**, so
//! the failure presents purely as latency and **no loss-based health check
//! will ever catch it**. str0m installs the leaky bucket only when BWE is on
//! (`session.rs:167-171`); with BWE off it uses a null pacer and sends when
//! told to, which is the configuration every latency row in the bake-off was
//! measured in and the configuration [`crate::transport::rtc`] ships.
//!
//! So this is **not** a wrapper over `LeakyBucketPacer` and not a bandwidth
//! estimator. It is the honest half of the job that can be done without one:
//!
//! - an **admission gate** in front of the transport, a few frame intervals
//!   deep at [`HEADROOM`] times a ceiling somebody else chooses, so a runaway
//!   source cannot burst far past that ceiling while an encoder that is merely
//!   on its target never meets the gate;
//! - a **ledger** of the bytes this viewer actually put on the wire, fed from
//!   the datagrams the poll loop sends, so the governor has a measured egress
//!   rate rather than the encoder's target;
//! - **counters for every refusal**, because a frame this drops is a frame the
//!   viewer never sees and that must never be silent.
//!
//! What it has not got, stated plainly: no congestion control. It does not
//! probe, does not measure the path, and does not discover the ceiling — the
//! ceiling is handed to it and is only ever as right as whoever set it. It
//! also cannot smooth *within* a frame: under G1's arm B str0m owns
//! packetization, so the smallest unit this sees is a whole access unit, and
//! sub-frame spreading would mean either str0m's pacer (measured unusable) or
//! a queue of our own in front of the socket — which is the same 1015 ms
//! queue with our name on it. **Task 4.7's governor is where a real control
//! loop has to land**, and until it does the product's congestion response is
//! this gate plus whatever the viewer reports on `swoop-feedback`.
//!
//! Dropping before the transport is deliberate: a frame refused here costs one
//! frame, a frame queued somewhere costs every frame behind it.

use std::time::{Duration, Instant};

/// How many frame intervals the bucket holds: the burst a screen change or an
/// encoder overshoot may spend before pacing bites. Two is one frame of
/// queueing at worst, and it is what turned one refusal in a hundred into none
/// on a wired lan.
const BURST_INTERVALS: f64 = 2.0;

/// How far over the encoder's target the gate runs. The gate is a burst guard,
/// not the rate controller — the encoder is — and every frame it refuses is a
/// hole the viewer freezes on until the next keyframe. At the bare target it
/// refused the ordinary overshoot of a constant-bitrate encoder: Media
/// Foundation's deltas on TEC-B4A sat at 0.95-1.2x their per-frame budget and
/// one in every 13-15 was refused (48,710 in a day, 2026-10-13). A governor
/// cut also lands here before the encoder hears of it (up to four frames are
/// already encoded at the old rate), which a 20% cut needs 1.25x to absorb.
/// 1.5x covers both and still bounds a runaway encoder.
const HEADROOM: f64 = 1.5;

/// Never let the bucket be so small that a single MTU cannot pass, whatever
/// ceiling the governor sets — a gate that refuses everything is a stall, not
/// a rate limit.
const MIN_CAPACITY_BYTES: f64 = 1500.0;

/// How often [`SendPacer::record_sent`] recomputes the egress rate. One second
/// because that is the cadence the viewer's own `stats` feedback arrives on,
/// and comparing the two is the whole point of measuring it.
const RATE_WINDOW: Duration = Duration::from_secs(1);

/// What [`SendPacer::admit`] decided about one access unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// Hand it to the transport now.
    Send,
    /// Over budget, and not a recovery point. The caller counts it and tells
    /// the governor. It is never dropped silently.
    DropOverBudget,
}

/// Everything the governor reads out of one viewer's pacer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PacerStats {
    pub admitted: u64,
    pub admitted_bytes: u64,
    pub dropped_over_budget: u64,
    pub dropped_bytes: u64,
    /// IRAPs admitted while the bucket was empty. Counted separately because a
    /// stream that only stays up on the keyframe exemption is a stream whose
    /// ceiling is wrong, and that has to be visible rather than inferred.
    pub irap_exemptions: u64,
    /// Bytes this viewer actually put on the wire — rtp, rtx, rtcp, stun and
    /// dtls, not just access units. The encoder's target is a request; this is
    /// what happened.
    pub sent_bytes: u64,
}

/// One viewer's admission gate and byte ledger.
///
/// Driven from the one thread that owns the peer: [`SendPacer::admit`] before
/// each access unit, [`SendPacer::record_sent`] for each datagram the poll
/// loop writes to the socket.
#[derive(Debug)]
pub struct SendPacer {
    ceiling_bps: u64,
    interval: Duration,
    /// Bytes, never negative: the keyframe exemption empties the bucket and
    /// leaves no debt.
    tokens: f64,
    last_refill: Instant,
    window_start: Instant,
    window_bytes: u64,
    sent_bps: u64,
    stats: PacerStats,
}

impl SendPacer {
    /// `ceiling_bps` is the encoder's own target unless a governor has moved
    /// it; the gate runs at [`HEADROOM`] times it. `fps` sets the burst window:
    /// the bucket is [`BURST_INTERVALS`] frame intervals deep at that rate. One interval was the rule until 2026-09-23, and
    /// on a wired lan it refused one delta in a hundred — the encoder's normal
    /// overshoot on a screen change, not congestion — and every refusal was a
    /// smear until the next keyframe.
    pub fn new(now: Instant, ceiling_bps: u64, fps: u32) -> Self {
        let mut pacer = Self {
            ceiling_bps,
            interval: interval_at(fps),
            tokens: 0.0,
            last_refill: now,
            window_start: now,
            window_bytes: 0,
            sent_bps: 0,
            stats: PacerStats::default(),
        };
        // Start full: the first frame of a session is an IRAP that would
        // otherwise spend the exemption before the stream has sent anything.
        pacer.tokens = pacer.capacity();
        pacer
    }

    /// Bytes the bucket holds when full: [`BURST_INTERVALS`] frame intervals at
    /// the gate's rate.
    pub fn capacity(&self) -> f64 {
        (self.bytes_per_second() * self.interval.as_secs_f64() * BURST_INTERVALS)
            .max(MIN_CAPACITY_BYTES)
    }

    /// The gate's refill rate: [`HEADROOM`] over the ceiling.
    fn bytes_per_second(&self) -> f64 {
        self.ceiling_bps as f64 / 8.0 * HEADROOM
    }

    pub fn ceiling_bps(&self) -> u64 {
        self.ceiling_bps
    }

    /// Move the ceiling. The governor calls this several times a second.
    pub fn set_ceiling(&mut self, now: Instant, ceiling_bps: u64) {
        // Refill against the OLD rate first: a ceiling that goes up must not
        // retroactively mint the tokens the last interval did not earn.
        self.refill(now);
        self.ceiling_bps = ceiling_bps;
        let capacity = self.capacity();
        self.tokens = self.tokens.min(capacity);
    }

    /// The frame rate the source is actually encoded at. A 30 fps rung's frames
    /// are twice a 60 fps one's, so a bucket sized for 60 holds one of them
    /// and refuses the next ordinary overshoot.
    pub fn set_frame_rate(&mut self, now: Instant, fps: u32) {
        self.refill(now);
        self.interval = interval_at(fps);
        self.tokens = self.tokens.min(self.capacity());
    }

    /// Decide one access unit. `bytes` is the whole unit — under arm B str0m
    /// packetizes it, so this is the smallest thing there is to decide about.
    pub fn admit(&mut self, now: Instant, bytes: usize, is_irap: bool) -> Admission {
        self.refill(now);
        let cost = bytes as f64;
        if self.tokens >= cost {
            self.tokens -= cost;
            self.stats.admitted += 1;
            self.stats.admitted_bytes += bytes as u64;
            return Admission::Send;
        }
        if !is_irap {
            self.stats.dropped_over_budget += 1;
            self.stats.dropped_bytes += bytes as u64;
            return Admission::DropOverBudget;
        }
        // Keyframes are exempt: dropping one costs every frame after it until
        // the next IRAP, which is the opposite of what a rate limit is for.
        // And it leaves no debt: the deltas right behind a recovery point are
        // the recovery, and refusing them (the rule until 2026-09-23) asked
        // the viewer for another keyframe, whose deltas were refused in turn.
        // An IRAP is rare and requested, so the bytes it spends above the
        // bucket are the ceiling's to absorb, not the next frames'.
        self.tokens = (self.tokens - cost).max(0.0);
        self.stats.irap_exemptions += 1;
        self.stats.admitted += 1;
        self.stats.admitted_bytes += bytes as u64;
        Admission::Send
    }

    /// Account one datagram actually written to the socket for this viewer.
    pub fn record_sent(&mut self, now: Instant, bytes: usize) {
        self.stats.sent_bytes += bytes as u64;
        self.window_bytes += bytes as u64;
        let elapsed = now.saturating_duration_since(self.window_start);
        if elapsed >= RATE_WINDOW {
            self.sent_bps = (self.window_bytes as f64 * 8.0 / elapsed.as_secs_f64()) as u64;
            self.window_start = now;
            self.window_bytes = 0;
        }
    }

    /// Measured egress over the last completed window, zero until one closes.
    pub fn sent_bps(&self) -> u64 {
        self.sent_bps
    }

    pub fn stats(&self) -> PacerStats {
        self.stats
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.last_refill);
        if elapsed.is_zero() {
            return;
        }
        self.last_refill = now;
        let earned = self.bytes_per_second() * elapsed.as_secs_f64();
        self.tokens = (self.tokens + earned).min(self.capacity());
    }
}

fn interval_at(fps: u32) -> Duration {
    Duration::from_secs_f64(1.0 / f64::from(fps.max(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 8 Mbps at 60 fps: 16.67 ms of interval and ~16,667 bytes of target per
    /// frame. The gate runs at 1.5x that, 25,000 bytes an interval, and holds
    /// two of those intervals.
    const CEILING: u64 = 8_000_000;
    const FPS: u32 = 60;
    const INTERVAL: Duration = Duration::from_nanos(16_666_667);
    const BUDGET: usize = 16_667;

    fn pacer(now: Instant) -> SendPacer {
        SendPacer::new(now, CEILING, FPS)
    }

    #[test]
    fn the_bucket_is_two_frame_intervals_deep_at_the_gate_rate() {
        let pacer = pacer(Instant::now());
        // 8 Mbps / 8 * 1.5 / 60 = 25,000 bytes per interval, twice over.
        assert!(
            (pacer.capacity() - 50_000.0).abs() < 1.0,
            "{}",
            pacer.capacity()
        );
    }

    #[test]
    fn three_frames_at_the_target_go_at_once_and_the_fourth_waits_for_the_interval() {
        // This is the pacing spread, at the granularity arm B leaves us: a
        // burst of an overshoot may go, more than the room may not until the
        // interval has earned it back.
        let t0 = Instant::now();
        let mut pacer = pacer(t0);
        let frame = 16_000;

        for _ in 0..3 {
            assert_eq!(pacer.admit(t0, frame, false), Admission::Send);
        }
        assert_eq!(
            pacer.admit(t0, frame, false),
            Admission::DropOverBudget,
            "four frames in the same instant is a burst past the room, not pacing"
        );
        // Half an interval is not enough for a whole frame either.
        assert_eq!(
            pacer.admit(t0 + INTERVAL / 2, frame, false),
            Admission::DropOverBudget
        );
        assert_eq!(pacer.admit(t0 + INTERVAL, frame, false), Admission::Send);
    }

    /// TEC-B4A, 2026-10-13: Media Foundation's constant-bitrate deltas ran at
    /// up to 1.2x their budget and the gate, at the bare target, refused one
    /// in every 13-15 — each one a hole the viewer smeared over.
    #[test]
    fn an_encoder_overshooting_its_target_by_a_fifth_is_never_refused() {
        let t0 = Instant::now();
        let mut pacer = pacer(t0);
        for i in 0..600u32 {
            assert_eq!(
                pacer.admit(t0 + INTERVAL * i, BUDGET * 6 / 5, false),
                Admission::Send,
                "frame {i}"
            );
        }
        assert_eq!(pacer.stats().dropped_over_budget, 0);
    }

    #[test]
    fn a_cut_lands_here_before_the_encoder_and_its_frames_in_flight_still_go() {
        let t0 = Instant::now();
        let mut pacer = pacer(t0);
        pacer.set_ceiling(t0, CEILING * 4 / 5);
        for i in 1..=60u32 {
            assert_eq!(
                pacer.admit(t0 + INTERVAL * i, BUDGET, false),
                Admission::Send,
                "frame {i} at the old rate"
            );
        }
    }

    #[test]
    fn a_keyframe_is_exempt_from_the_watermark_and_the_exemption_is_counted() {
        let t0 = Instant::now();
        let mut pacer = pacer(t0);
        for _ in 0..3 {
            assert_eq!(pacer.admit(t0, 16_000, false), Admission::Send);
        }
        assert_eq!(pacer.admit(t0, 16_000, false), Admission::DropOverBudget);

        assert_eq!(
            pacer.admit(t0, 16_000, true),
            Admission::Send,
            "an empty bucket must not cost a recovery point"
        );
        let stats = pacer.stats();
        assert_eq!(stats.irap_exemptions, 1);
        assert_eq!(stats.admitted, 4);
        assert_eq!(stats.dropped_over_budget, 1);
        assert_eq!(stats.dropped_bytes, 16_000);
    }

    #[test]
    fn a_keyframe_far_over_the_ceiling_leaves_no_debt_for_the_deltas_behind_it() {
        let t0 = Instant::now();
        let mut pacer = pacer(t0);
        // 2 MB at an 8 Mbps ceiling would be two seconds of debt; it is none.
        assert_eq!(pacer.admit(t0, 2_000_000, true), Admission::Send);
        assert_eq!(
            pacer.admit(t0, 16_000, false),
            Admission::DropOverBudget,
            "the bucket is empty in the same instant, as after any full frame"
        );
        assert_eq!(
            pacer.admit(t0 + INTERVAL, BUDGET * 6 / 5, false),
            Admission::Send,
            "one interval later the recovery point's own delta goes, overshoot and all"
        );
    }

    #[test]
    fn at_a_lower_frame_rate_the_bucket_holds_two_of_that_rate_s_frames() {
        let t0 = Instant::now();
        let mut pacer = pacer(t0);
        pacer.set_frame_rate(t0, 30);
        // a 30 fps frame at 8 mbps is twice a 60 fps one; two of them, a fifth
        // over, may burst exactly as two 60 fps ones may, once the larger
        // bucket has had two 30 fps intervals to fill
        let frame = BUDGET * 2 * 6 / 5;
        let t1 = t0 + INTERVAL * 4;
        assert_eq!(pacer.admit(t1, frame, false), Admission::Send);
        assert_eq!(pacer.admit(t1, frame, false), Admission::Send);
        assert_eq!(pacer.admit(t1, frame, false), Admission::DropOverBudget);
    }

    #[test]
    fn raising_the_ceiling_does_not_mint_the_tokens_the_old_rate_never_earned() {
        let t0 = Instant::now();
        let mut pacer = pacer(t0);
        for _ in 0..3 {
            assert_eq!(pacer.admit(t0, 16_000, false), Admission::Send);
        }

        pacer.set_ceiling(t0, CEILING * 4);
        assert_eq!(pacer.ceiling_bps(), CEILING * 4);
        assert_eq!(
            pacer.admit(t0, 16_000, false),
            Admission::DropOverBudget,
            "the bucket was empty when the ceiling moved and no time has passed"
        );
        // The new rate does apply from here on: a quarter interval now earns
        // what a whole one used to.
        assert_eq!(pacer.admit(t0 + INTERVAL, 60_000, false), Admission::Send);
    }

    #[test]
    fn lowering_the_ceiling_shrinks_a_full_bucket_to_the_new_capacity() {
        let t0 = Instant::now();
        let mut pacer = pacer(t0);
        pacer.set_ceiling(t0, CEILING / 8);
        assert_eq!(
            pacer.admit(t0, 16_000, false),
            Admission::DropOverBudget,
            "a full bucket at the old ceiling is not credit at the new one"
        );
    }

    #[test]
    fn the_ledger_counts_wire_bytes_and_reports_a_rate_once_a_window_closes() {
        let t0 = Instant::now();
        let mut pacer = pacer(t0);
        // Access units admitted and datagrams sent are different numbers on
        // purpose: rtp, rtx, rtcp, stun and dtls are all in the second one.
        pacer.admit(t0, 16_000, true);
        for _ in 0..10 {
            pacer.record_sent(t0, 1_200);
        }
        assert_eq!(pacer.stats().sent_bytes, 12_000);
        assert_eq!(pacer.sent_bps(), 0, "no window has closed yet");

        pacer.record_sent(t0 + RATE_WINDOW, 1_200);
        assert_eq!(pacer.stats().sent_bytes, 13_200);
        assert_eq!(pacer.sent_bps(), 13_200 * 8);
    }

    #[test]
    fn a_ceiling_of_zero_still_passes_one_mtu_rather_than_stalling_outright() {
        let t0 = Instant::now();
        let mut pacer = SendPacer::new(t0, 0, FPS);
        assert_eq!(pacer.capacity(), MIN_CAPACITY_BYTES);
        assert_eq!(pacer.admit(t0, 1_400, false), Admission::Send);
        assert_eq!(pacer.admit(t0, 1_400, false), Admission::DropOverBudget);
    }
}
