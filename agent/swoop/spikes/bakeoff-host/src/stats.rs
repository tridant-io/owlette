//! Nearest-rank percentiles, the same definition as spike 0.1's `summarize()`
//! on both the Rust and the JavaScript side. Lifted from `capture-probe`, kept
//! byte-identical in behaviour so a host-side row and a browser-side row in the
//! same run's JSON mean the same thing.

use crate::json::J;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Summary {
    pub n: usize,
    pub min: f64,
    pub p50: f64,
    pub p90: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
    pub mean: f64,
    pub stddev: f64,
}

/// Nearest-rank percentiles. An empty sample is reported as `n = 0` with zeroed
/// statistics rather than a panic: a run that produced no measurable frames is
/// a result, and it has to survive into the JSON so it can be seen.
pub fn summarize(samples: &[f64]) -> Summary {
    if samples.is_empty() {
        return Summary {
            n: 0,
            min: 0.0,
            p50: 0.0,
            p90: 0.0,
            p95: 0.0,
            p99: 0.0,
            max: 0.0,
            mean: 0.0,
            stddev: 0.0,
        };
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    let mean = sorted.iter().sum::<f64>() / n as f64;
    let variance = sorted.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64;
    Summary {
        n,
        min: sorted[0],
        p50: percentile(&sorted, 50.0),
        p90: percentile(&sorted, 90.0),
        p95: percentile(&sorted, 95.0),
        p99: percentile(&sorted, 99.0),
        max: sorted[n - 1],
        mean,
        stddev: variance.sqrt(),
    }
}

fn percentile(sorted: &[f64], pct: f64) -> f64 {
    let rank = (pct / 100.0 * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

impl Summary {
    pub fn to_json(self) -> J {
        J::Obj(vec![
            ("n", J::Uint(self.n as u64)),
            ("min", J::Num(self.min)),
            ("p50", J::Num(self.p50)),
            ("p90", J::Num(self.p90)),
            ("p95", J::Num(self.p95)),
            ("p99", J::Num(self.p99)),
            ("max", J::Num(self.max)),
            ("mean", J::Num(self.mean)),
            ("sd", J::Num(self.stddev)),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_sample_is_n_zero_not_a_panic() {
        assert_eq!(summarize(&[]).n, 0);
    }

    #[test]
    fn nearest_rank_matches_the_javascript_side() {
        // The probe's summarize() uses v[ceil(p/100 * n) - 1] on the sorted
        // array; 1..=10 is the case where an interpolating definition would
        // disagree (5.5 vs 5).
        let s = summarize(&[10.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]);
        assert_eq!(s.n, 10);
        assert_eq!(s.min, 1.0);
        assert_eq!(s.p50, 5.0);
        assert_eq!(s.p95, 10.0);
        assert_eq!(s.max, 10.0);
    }
}
