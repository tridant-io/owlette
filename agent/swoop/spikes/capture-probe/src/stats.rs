//! Pure measurement maths: interval histograms, percentile summaries, rectangle
//! union area and virtual-desktop bounds. No Win32 here, so every function in
//! this module is unit-tested without hardware.

/// Inclusive-lower / exclusive-upper bucket edges in milliseconds, chosen so a
/// 60 Hz (16.67 ms) and a 120 Hz (8.33 ms) cadence each land in a bucket of
/// their own instead of straddling one.
pub const INTERVAL_EDGES_MS: &[f64] = &[
    0.1, 0.5, 1.0, 2.0, 4.0, 6.0, 8.0, 9.0, 10.0, 12.0, 14.0, 16.0, 17.0, 18.0, 20.0, 25.0, 33.0,
    50.0, 100.0,
];

pub struct Histogram {
    edges: Vec<f64>,
    counts: Vec<u64>,
}

impl Histogram {
    pub fn new(edges: &[f64]) -> Self {
        Self {
            edges: edges.to_vec(),
            counts: vec![0; edges.len() + 1],
        }
    }

    pub fn add(&mut self, value: f64) {
        let mut idx = self.edges.len();
        for (i, edge) in self.edges.iter().enumerate() {
            if value < *edge {
                idx = i;
                break;
            }
        }
        self.counts[idx] += 1;
    }

    pub fn total(&self) -> u64 {
        self.counts.iter().sum()
    }

    /// `(label, count, percent)` for every non-empty bucket.
    pub fn rows(&self) -> Vec<(String, u64, f64)> {
        let total = self.total().max(1) as f64;
        let mut out = Vec::new();
        for (i, count) in self.counts.iter().enumerate() {
            if *count == 0 {
                continue;
            }
            let label = if i == 0 {
                format!("< {}", self.edges[0])
            } else if i == self.edges.len() {
                format!(">= {}", self.edges[i - 1])
            } else {
                format!("{} - {}", self.edges[i - 1], self.edges[i])
            };
            out.push((label, *count, *count as f64 * 100.0 / total));
        }
        out
    }
}

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
/// statistics rather than a panic, because several runs legitimately produce no
/// samples (a fully static desktop yields no inter-frame intervals at all).
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn area(&self) -> i64 {
        let w = (self.right - self.left).max(0) as i64;
        let h = (self.bottom - self.top).max(0) as i64;
        w * h
    }
}

/// Area covered by the union of `rects`, in pixels.
///
/// Dirty rects are documented as non-overlapping, but move-rect destinations
/// and dirty rects can overlap each other, and a plain sum of areas then
/// reports coverage above 100% of the output. Coordinate-compression sweep:
/// O(n^2) worst case, which is irrelevant for the tens-to-hundreds of rects a
/// frame carries.
pub fn union_area(rects: &[Rect]) -> i64 {
    let mut xs: Vec<i32> = Vec::with_capacity(rects.len() * 2);
    for r in rects {
        if r.right > r.left && r.bottom > r.top {
            xs.push(r.left);
            xs.push(r.right);
        }
    }
    xs.sort_unstable();
    xs.dedup();
    if xs.len() < 2 {
        return 0;
    }

    let mut total = 0i64;
    let mut spans: Vec<(i32, i32)> = Vec::new();
    for w in xs.windows(2) {
        let (x0, x1) = (w[0], w[1]);
        spans.clear();
        for r in rects {
            if r.left <= x0 && r.right >= x1 && r.bottom > r.top {
                spans.push((r.top, r.bottom));
            }
        }
        if spans.is_empty() {
            continue;
        }
        spans.sort_unstable();
        let mut merged = 0i64;
        let (mut cur_top, mut cur_bottom) = spans[0];
        for &(top, bottom) in &spans[1..] {
            if top > cur_bottom {
                merged += (cur_bottom - cur_top) as i64;
                cur_top = top;
                cur_bottom = bottom;
            } else if bottom > cur_bottom {
                cur_bottom = bottom;
            }
        }
        merged += (cur_bottom - cur_top) as i64;
        total += merged * (x1 - x0) as i64;
    }
    total
}

/// Bounding box of every attached output, i.e. the virtual desktop. The origin
/// is negative whenever a monitor sits left of or above the primary, which is
/// the case this dev box actually exhibits and the transform Task 3.6 / 6.4
/// must carry.
pub fn virtual_desktop_bounds(outputs: &[Rect]) -> Option<Rect> {
    let mut it = outputs.iter();
    let first = *it.next()?;
    Some(it.fold(first, |acc, r| Rect {
        left: acc.left.min(r.left),
        top: acc.top.min(r.top),
        right: acc.right.max(r.right),
        bottom: acc.bottom.max(r.bottom),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn histogram_buckets_below_first_edge_and_above_last() {
        let mut h = Histogram::new(&[1.0, 2.0]);
        h.add(0.5);
        h.add(1.5);
        h.add(9.0);
        let rows = h.rows();
        assert_eq!(h.total(), 3);
        assert_eq!(rows[0].0, "< 1");
        assert_eq!(rows[1].0, "1 - 2");
        assert_eq!(rows[2].0, ">= 2");
        assert!(rows.iter().all(|row| row.1 == 1));
    }

    #[test]
    fn histogram_value_equal_to_edge_lands_in_the_upper_bucket() {
        let mut h = Histogram::new(&[16.0]);
        h.add(16.0);
        assert_eq!(h.rows()[0].0, ">= 16");
    }

    #[test]
    fn summarize_uses_nearest_rank() {
        let s = summarize(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]);
        assert_eq!(s.n, 10);
        assert_eq!(s.min, 1.0);
        assert_eq!(s.p50, 5.0);
        assert_eq!(s.p90, 9.0);
        assert_eq!(s.max, 10.0);
        assert!((s.mean - 5.5).abs() < 1e-9);
    }

    #[test]
    fn summarize_of_empty_sample_is_zeroed_not_a_panic() {
        assert_eq!(summarize(&[]).n, 0);
    }

    #[test]
    fn union_area_of_disjoint_rects_is_the_sum() {
        assert_eq!(union_area(&[r(0, 0, 10, 10), r(20, 20, 30, 30)]), 200);
    }

    #[test]
    fn union_area_counts_the_overlap_once() {
        // Two 10x10 squares overlapping in a 5x5 corner: 100 + 100 - 25.
        assert_eq!(union_area(&[r(0, 0, 10, 10), r(5, 5, 15, 15)]), 175);
    }

    #[test]
    fn union_area_of_nested_rects_is_the_outer_rect() {
        assert_eq!(union_area(&[r(0, 0, 100, 100), r(10, 10, 20, 20)]), 10_000);
    }

    #[test]
    fn union_area_ignores_empty_and_inverted_rects() {
        assert_eq!(union_area(&[r(5, 5, 5, 50), r(0, 0, 10, 10), r(9, 9, 1, 1)]), 100);
    }

    #[test]
    fn union_area_of_nothing_is_zero() {
        assert_eq!(union_area(&[]), 0);
    }

    #[test]
    fn virtual_desktop_origin_goes_negative_left_and_above_the_primary() {
        // This box's real layout: primary 1920x1080 at the origin plus a
        // portrait panel to its left and above it.
        let bounds = virtual_desktop_bounds(&[
            r(0, 0, 1920, 1080),
            r(-2160, -1138, -432, 1934),
        ])
        .unwrap();
        assert_eq!(bounds, r(-2160, -1138, 1920, 1934));
        assert!(bounds.left < 0 && bounds.top < 0);
    }

    #[test]
    fn virtual_desktop_bounds_of_no_outputs_is_none() {
        assert!(virtual_desktop_bounds(&[]).is_none());
    }

    #[test]
    fn rect_area_clamps_inverted_edges_to_zero() {
        assert_eq!(r(10, 10, 0, 0).area(), 0);
        assert_eq!(r(0, 0, 4, 5).area(), 20);
    }
}
