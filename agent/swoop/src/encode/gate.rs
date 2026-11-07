//! The encode-time gate: whether a slower, text-friendlier encoder setting may
//! stay on, decided by measuring it where it runs.
//!
//! Two settings sit behind it: NVENC's text preset, P4 (P3 above 2560x1440),
//! against the P1 it falls back to (swoop-clarity task 2.1), and the Media
//! Foundation hardware encoder's quality vs speed 50, against the MFT's own
//! default (swoop-clarity task 2.2). What either costs in encode time depends
//! on the GPU, and Intel and AMD MFTs are not measured at all, so every GPU
//! class answers for itself: the encoder opens with the setting on, feeds the
//! gate the time each of its encodes took, and drops the setting if the gate
//! says it is over budget (swoop-clarity C9, C10).
//!
//! # Steady frames only
//!
//! A sample counts only while frames are steady: the previous submit no more
//! than two frame intervals earlier, which is motion or a burst. On a still
//! desktop the only encodes are the floor's repeats every
//! [`FLOOR_INTERVAL`](crate::session::FLOOR_INTERVAL), at GPU clocks that have
//! idled down and read slow, and judging the setting by them would drop it
//! while someone reads still text. A submit that is not steady restarts the
//! [`WARMUP`], because the clocks have to ramp again, and keeps the samples
//! already taken. IRAPs never count and never break steadiness: a keyframe's
//! own encode is not the delta budget (NVENC's IDR costs 0.3–2.4 ms more,
//! spike 0.9 §2). For as long as too few steady samples come in, the gate
//! keeps measuring with the setting on; a still desktop costs nothing to
//! encode, so the trial costs nothing either.
//!
//! # The verdict
//!
//! Decided once, from the median of [`SAMPLES`] samples; a p50 equal to the
//! budget keeps. A GPU far over budget does not sit through all of them: once
//! [`EARLY`] samples are in, a median past 1.5x the budget or past one frame
//! interval, whichever is smaller, is [`GateVerdict::Exceeded`] at once, so it
//! pays for under a second of motion.
//!
//! # A share of the pass
//!
//! The capture pass encodes its tiers one after another, so
//! [`ENCODE_TIME_P50`] belongs to the whole pass: an H.264 tier and an HEVC
//! tier could each meet it and together miss the frame. Each gated encoder
//! judges its [`share`], which the capture loop tells it through
//! [`Encoder::share_encode_time`](super::Encoder::share_encode_time).
//!
//! A verdict lasts one streamer process, which is one session: once a setting
//! is dropped, the encoders that open later in that streamer start without it,
//! and the next session measures again.

use std::time::{Duration, Instant};

/// The encode-time budget, a p50 for one whole capture pass: the top of the
/// 8–12 ms p50 the NVENC module documents for its P1 encodes (spike 0.9's 4K60
/// HEVC figure). A setting that keeps within it costs no session more encode
/// time than the slowest path already shipping.
pub const ENCODE_TIME_P50: Duration = Duration::from_millis(12);

/// Steady frames discarded after every (re)start while the GPU's clocks ramp.
pub const WARMUP: u32 = 30;

/// Steady frames the verdict is decided from.
pub const SAMPLES: usize = 120;

/// Steady frames after which a median far over budget is decided at once.
pub const EARLY: usize = 20;

/// One gated encoder's share of the pass's encode-time budget, when the pass
/// encodes `tiers` tiers one after another.
pub fn share(tiers: usize) -> Duration {
    ENCODE_TIME_P50 / u32::try_from(tiers.max(1)).unwrap_or(u32::MAX)
}

/// What a gate has decided about the setting it measures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateVerdict {
    /// Too few steady samples yet; the setting stays on.
    Measuring,
    /// Within budget: the setting stays on.
    Keep { p50: Duration },
    /// Over budget: the encoder drops the setting.
    Exceeded { p50: Duration },
}

/// Times one encoder's encodes and decides whether its gated setting stays on.
pub struct EncodeTimeGate {
    budget: Duration,
    frame: Duration,
    last: Option<Instant>,
    warm: u32,
    /// Kept sorted, so the median is the middle; freed once decided.
    sorted: Vec<Duration>,
    taken: usize,
    verdict: GateVerdict,
}

impl EncodeTimeGate {
    /// A gate judging encodes against `budget`, for an encoder opened at
    /// `fps`.
    pub fn new(budget: Duration, fps: u32) -> Self {
        Self {
            budget,
            frame: Duration::from_secs(1) / fps.max(1),
            last: None,
            warm: 0,
            sorted: Vec::with_capacity(SAMPLES),
            taken: 0,
            verdict: GateVerdict::Measuring,
        }
    }

    /// One encode: when its frame was submitted, how long the encode took and
    /// whether it was an IRAP. Answers the verdict, which never changes again
    /// once it is not [`GateVerdict::Measuring`].
    pub fn observe(&mut self, submitted: Instant, took: Duration, is_irap: bool) -> GateVerdict {
        if self.verdict != GateVerdict::Measuring {
            return self.verdict;
        }
        let steady = self
            .last
            .is_some_and(|last| submitted.saturating_duration_since(last) <= self.frame * 2);
        self.last = Some(submitted);
        if !steady {
            self.warm = 0;
        } else if !is_irap {
            if self.warm < WARMUP {
                self.warm += 1;
            } else {
                let at = self.sorted.partition_point(|&sample| sample <= took);
                self.sorted.insert(at, took);
                self.taken += 1;
                self.judge();
            }
        }
        self.verdict
    }

    /// Move the budget, when the pass's tier count changes. While measuring,
    /// the decision uses the new budget; a kept setting whose p50 is over it
    /// turns exceeded; an exceeded one stays exceeded whatever the budget.
    pub fn set_budget(&mut self, budget: Duration) -> GateVerdict {
        self.budget = budget;
        match self.verdict {
            GateVerdict::Measuring => self.judge(),
            GateVerdict::Keep { p50 } if p50 > budget => {
                self.verdict = GateVerdict::Exceeded { p50 };
            }
            _ => {}
        }
        self.verdict
    }

    pub fn verdict(&self) -> GateVerdict {
        self.verdict
    }

    /// Steady samples taken so far, or the count a verdict was decided from.
    pub fn samples(&self) -> usize {
        self.taken
    }

    fn judge(&mut self) {
        let count = self.sorted.len();
        if count < EARLY {
            return;
        }
        let mid = count / 2;
        let p50 = if count.is_multiple_of(2) {
            (self.sorted[mid - 1] + self.sorted[mid]) / 2
        } else {
            self.sorted[mid]
        };
        let early = (self.budget * 3 / 2).min(self.frame);
        if p50 > early || (count >= SAMPLES && p50 > self.budget) {
            self.decide(GateVerdict::Exceeded { p50 });
        } else if count >= SAMPLES {
            self.decide(GateVerdict::Keep { p50 });
        }
    }

    fn decide(&mut self, verdict: GateVerdict) {
        self.verdict = verdict;
        self.sorted = Vec::new();
    }
}

/// The one line an encoder logs for its gate's verdict; `None` while the gate
/// is still measuring. It names the sample count and the rate, so a log says
/// what kind of frames a verdict came from.
pub fn verdict_line(
    backend: &str,
    setting: &str,
    size: (u32, u32),
    verdict: GateVerdict,
    samples: usize,
    fps: u32,
    budget: Duration,
) -> Option<String> {
    let (p50, against, outcome) = match verdict {
        GateVerdict::Measuring => return None,
        GateVerdict::Keep { p50 } => (p50, "within", format!("keeps {setting}")),
        GateVerdict::Exceeded { p50 } => (p50, "over", format!("drops {setting} from here")),
    };
    Some(format!(
        "swoop: {backend} {setting} encodes {}x{} at p50 {:.1} ms over {samples} steady frames \
         at {fps} fps, {against} its {:.1} ms share; {outcome}",
        size.0,
        size.1,
        p50.as_secs_f64() * 1e3,
        budget.as_secs_f64() * 1e3,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::FLOOR_INTERVAL;

    const FPS: u32 = 60;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn interval() -> Duration {
        Duration::from_secs(1) / FPS
    }

    /// A gate fed submits on a clock the test moves.
    struct Feed {
        gate: EncodeTimeGate,
        at: Instant,
    }

    impl Feed {
        fn new(budget: Duration) -> Self {
            Self {
                gate: EncodeTimeGate::new(budget, FPS),
                at: Instant::now(),
            }
        }

        /// A gate with its warm-up behind it: the session's first submit, which
        /// is never steady, then `WARMUP` steady frames slow enough to decide
        /// on their own if they counted.
        fn warmed(budget: Duration) -> Self {
            let mut feed = Self::new(budget);
            feed.frames(1 + WARMUP as usize, ms(100));
            assert_eq!(feed.gate.samples(), 0);
            feed
        }

        fn submit(&mut self, gap: Duration, took: Duration, is_irap: bool) -> GateVerdict {
            self.at += gap;
            self.gate.observe(self.at, took, is_irap)
        }

        /// `n` deltas one frame interval apart, each taking `took`.
        fn frames(&mut self, n: usize, took: Duration) -> GateVerdict {
            let mut verdict = self.gate.verdict();
            for _ in 0..n {
                verdict = self.submit(interval(), took, false);
            }
            verdict
        }
    }

    #[test]
    fn the_warm_up_is_discarded() {
        let mut feed = Feed::new(ENCODE_TIME_P50);
        assert_eq!(
            feed.frames(1 + WARMUP as usize, ms(100)),
            GateVerdict::Measuring
        );
        assert_eq!(feed.gate.samples(), 0);
        assert_eq!(feed.frames(1, ms(5)), GateVerdict::Measuring);
        assert_eq!(feed.gate.samples(), 1);
        assert_eq!(
            feed.frames(SAMPLES - 1, ms(5)),
            GateVerdict::Keep { p50: ms(5) }
        );
    }

    #[test]
    fn irap_frames_never_count_and_never_break_steadiness() {
        let mut feed = Feed::new(ENCODE_TIME_P50);
        feed.frames(1, ms(5));
        // An IRAP before every delta: if they counted toward the warm-up, the
        // slow deltas after it would be samples.
        for _ in 0..WARMUP {
            feed.submit(interval(), ms(100), true);
            feed.frames(1, ms(100));
        }
        assert_eq!(feed.gate.samples(), 0);
        for _ in 0..SAMPLES - 1 {
            assert_eq!(
                feed.submit(interval(), ms(100), true),
                GateVerdict::Measuring
            );
            feed.frames(1, ms(5));
        }
        assert_eq!(feed.gate.samples(), SAMPLES - 1);
        assert_eq!(
            feed.submit(interval(), ms(100), true),
            GateVerdict::Measuring
        );
        assert_eq!(feed.frames(1, ms(5)), GateVerdict::Keep { p50: ms(5) });
    }

    #[test]
    fn submits_at_the_floor_rate_never_count() {
        let mut feed = Feed::new(ENCODE_TIME_P50);
        for _ in 0..1000 {
            assert_eq!(
                feed.submit(FLOOR_INTERVAL, ms(40), false),
                GateVerdict::Measuring
            );
        }
        assert_eq!(feed.gate.samples(), 0);
    }

    #[test]
    fn two_frame_intervals_apart_is_still_steady() {
        let mut feed = Feed::warmed(ENCODE_TIME_P50);
        feed.submit(interval() * 2, ms(5), false);
        assert_eq!(feed.gate.samples(), 1);
        feed.submit(interval() * 2 + Duration::from_nanos(1), ms(5), false);
        feed.frames(1, ms(5));
        assert_eq!(feed.gate.samples(), 1);
    }

    #[test]
    fn a_gap_restarts_the_warm_up_and_keeps_the_samples() {
        let mut feed = Feed::warmed(ENCODE_TIME_P50);
        feed.frames(10, ms(5));
        assert_eq!(feed.gate.samples(), 10);
        feed.submit(Duration::from_secs(1), ms(5), false);
        feed.frames(WARMUP as usize, ms(100));
        assert_eq!(feed.gate.samples(), 10);
        assert_eq!(feed.frames(SAMPLES - 11, ms(5)), GateVerdict::Measuring);
        assert_eq!(feed.frames(1, ms(5)), GateVerdict::Keep { p50: ms(5) });
    }

    #[test]
    fn keeps_below_and_at_the_budget() {
        for took in [ms(11), ms(12)] {
            let mut feed = Feed::warmed(ms(12));
            assert_eq!(feed.frames(SAMPLES - 1, took), GateVerdict::Measuring);
            assert_eq!(feed.frames(1, took), GateVerdict::Keep { p50: took });
            // decided once: slow frames after it change nothing
            assert_eq!(
                feed.frames(SAMPLES, ms(100)),
                GateVerdict::Keep { p50: took }
            );
            assert_eq!(feed.gate.samples(), SAMPLES);
        }
    }

    #[test]
    fn exceeds_above_the_budget() {
        let mut feed = Feed::warmed(ms(12));
        let verdicts: Vec<_> = [ms(10), ms(16)]
            .into_iter()
            .cycle()
            .take(SAMPLES)
            .map(|took| feed.frames(1, took))
            .collect();
        assert!(verdicts[..SAMPLES - 1]
            .iter()
            .all(|v| *v == GateVerdict::Measuring));
        assert_eq!(verdicts[SAMPLES - 1], GateVerdict::Exceeded { p50: ms(13) });
        assert_eq!(
            feed.frames(SAMPLES, ms(1)),
            GateVerdict::Exceeded { p50: ms(13) }
        );
    }

    #[test]
    fn a_gpu_far_over_budget_is_decided_after_early_samples() {
        let mut feed = Feed::warmed(ms(12));
        assert_eq!(feed.frames(EARLY - 1, ms(24)), GateVerdict::Measuring);
        assert_eq!(
            feed.frames(1, ms(24)),
            GateVerdict::Exceeded { p50: ms(24) }
        );
        assert_eq!(feed.gate.samples(), EARLY);

        // under 1.5x the budget, but past the 60 fps frame interval
        let mut feed = Feed::warmed(ms(12));
        assert_eq!(
            feed.frames(EARLY, ms(17)),
            GateVerdict::Exceeded { p50: ms(17) }
        );
    }

    #[test]
    fn a_p50_a_little_over_waits_for_every_sample() {
        let took = ms(12) * 6 / 5;
        let mut feed = Feed::warmed(ms(12));
        assert_eq!(feed.frames(SAMPLES - 1, took), GateVerdict::Measuring);
        assert_eq!(feed.frames(1, took), GateVerdict::Exceeded { p50: took });
    }

    #[test]
    fn a_share_moved_while_measuring_decides() {
        let mut feed = Feed::warmed(share(1));
        feed.frames(SAMPLES / 2, ms(8));
        // 8 ms is past two tiers' 6 ms share, but not past its early line
        assert_eq!(feed.gate.set_budget(share(2)), GateVerdict::Measuring);
        assert_eq!(
            feed.frames(SAMPLES / 2, ms(8)),
            GateVerdict::Exceeded { p50: ms(8) }
        );

        let mut feed = Feed::warmed(share(1));
        feed.frames(EARLY, ms(10));
        assert_eq!(
            feed.gate.set_budget(share(2)),
            GateVerdict::Exceeded { p50: ms(10) }
        );
    }

    #[test]
    fn a_smaller_share_turns_a_kept_setting_exceeded() {
        let mut feed = Feed::warmed(share(1));
        assert_eq!(
            feed.frames(SAMPLES, ms(9)),
            GateVerdict::Keep { p50: ms(9) }
        );
        assert_eq!(
            feed.gate.set_budget(share(1)),
            GateVerdict::Keep { p50: ms(9) }
        );
        assert_eq!(
            feed.gate.set_budget(share(2)),
            GateVerdict::Exceeded { p50: ms(9) }
        );
        assert_eq!(feed.gate.verdict(), GateVerdict::Exceeded { p50: ms(9) });
        assert_eq!(
            feed.gate.set_budget(share(1)),
            GateVerdict::Exceeded { p50: ms(9) }
        );
    }

    #[test]
    fn a_larger_share_never_revives_an_exceeded_setting() {
        let mut feed = Feed::warmed(share(1));
        assert_eq!(
            feed.frames(SAMPLES, ms(13)),
            GateVerdict::Exceeded { p50: ms(13) }
        );
        assert_eq!(
            feed.gate.set_budget(ms(24)),
            GateVerdict::Exceeded { p50: ms(13) }
        );
        assert_eq!(
            feed.frames(SAMPLES, ms(1)),
            GateVerdict::Exceeded { p50: ms(13) }
        );
    }

    #[test]
    fn the_buffer_never_holds_more_than_samples() {
        let mut feed = Feed::warmed(ENCODE_TIME_P50);
        for _ in 0..1000 {
            feed.frames(1, ms(5));
            assert!(feed.gate.sorted.len() <= SAMPLES);
            assert!(feed.gate.samples() <= SAMPLES);
        }
        assert_eq!(feed.gate.samples(), SAMPLES);
        assert_eq!(feed.gate.sorted.capacity(), 0);
    }

    #[test]
    fn share_splits_the_budget_among_the_pass_tiers() {
        assert_eq!(share(0), ENCODE_TIME_P50);
        assert_eq!(share(1), ENCODE_TIME_P50);
        assert_eq!(share(2), ms(6));
    }

    #[test]
    fn verdict_line_says_what_was_decided_and_from_what() {
        let over = verdict_line(
            "nvenc",
            "p4",
            (2560, 1440),
            GateVerdict::Exceeded {
                p50: Duration::from_micros(13_400),
            },
            120,
            60,
            share(1),
        );
        assert_eq!(
            over.as_deref(),
            Some(
                "swoop: nvenc p4 encodes 2560x1440 at p50 13.4 ms over 120 steady frames at 60 fps, \
                 over its 12.0 ms share; drops p4 from here"
            )
        );
        let kept = verdict_line(
            "nvenc",
            "p3",
            (3840, 2160),
            GateVerdict::Keep {
                p50: Duration::from_micros(9_400),
            },
            120,
            60,
            share(1),
        );
        assert_eq!(
            kept.as_deref(),
            Some(
                "swoop: nvenc p3 encodes 3840x2160 at p50 9.4 ms over 120 steady frames at 60 fps, \
                 within its 12.0 ms share; keeps p3"
            )
        );
        let early = verdict_line(
            "mf-hw",
            "quality vs speed 50",
            (1920, 1080),
            GateVerdict::Exceeded { p50: ms(19) },
            EARLY,
            30,
            share(2),
        );
        assert_eq!(
            early.as_deref(),
            Some(
                "swoop: mf-hw quality vs speed 50 encodes 1920x1080 at p50 19.0 ms over 20 steady \
                 frames at 30 fps, over its 6.0 ms share; drops quality vs speed 50 from here"
            )
        );
        let measuring = verdict_line(
            "nvenc",
            "p4",
            (1920, 1080),
            GateVerdict::Measuring,
            7,
            60,
            share(1),
        );
        assert_eq!(measuring, None);
    }
}
