//! Pure measurement maths and CSV shaping. No Win32 here, so every function in
//! this module is unit-tested without hardware.

/// Nearest-rank percentile summary of a sample series.
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
/// statistics rather than a panic: a run can legitimately produce no samples of
/// a stage (for example `sync_qpc` if frame statistics are unavailable), and a
/// zero row with `n = 0` is the honest way to say so.
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

/// Nearest-rank percentile of an already-sorted, non-empty slice.
fn percentile(sorted: &[f64], pct: f64) -> f64 {
    let n = sorted.len();
    let rank = (pct / 100.0 * n as f64).ceil() as usize;
    sorted[rank.clamp(1, n) - 1]
}

/// Convert a `QueryPerformanceCounter` tick delta to milliseconds.
pub fn ticks_to_ms(ticks: i64, freq: i64) -> f64 {
    if freq == 0 {
        return 0.0;
    }
    ticks as f64 * 1000.0 / freq as f64
}

/// One button-down and everything the host side can see about the flip it
/// caused. Every `*_qpc` field is a raw `QueryPerformanceCounter` tick.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Sample {
    pub seq: u64,
    /// True when the click came from `SendInput` (`--autoclick`) rather than a
    /// physical mouse, read from `LLMHF_INJECTED`.
    pub injected: bool,
    /// QPC read inside the `WH_MOUSE_LL` callback, before anything else.
    pub hook_qpc: i64,
    /// QPC when the posted message reached the window procedure.
    pub dispatch_qpc: i64,
    /// QPC immediately before `IDXGISwapChain::Present`.
    pub present_call_qpc: i64,
    /// QPC immediately after `Present` returned.
    pub present_return_qpc: i64,
    /// `GetLastPresentCount` for this present.
    pub present_id: u32,
    /// `DXGI_FRAME_STATISTICS::SyncQPCTime` for the vertical blank this present
    /// was displayed at; 0 when frame statistics never resolved it.
    pub sync_qpc: i64,
    /// `DXGI_FRAME_STATISTICS::PresentRefreshCount` for the same.
    pub present_refresh_count: u32,
    /// 0 or 1: which of the two high-contrast colours the window flipped to.
    pub colour: u8,
    /// Excluded from the summary: the first presents after swapchain creation
    /// pay one-off costs.
    pub warmup: bool,
}

pub const CSV_HEADER: &str = "seq,injected,warmup,colour,hook_qpc,dispatch_qpc,present_call_qpc,present_return_qpc,present_id,sync_qpc,present_refresh_count";

pub fn csv_row(s: &Sample) -> String {
    format!(
        "{},{},{},{},{},{},{},{},{},{},{}",
        s.seq,
        u8::from(s.injected),
        u8::from(s.warmup),
        s.colour,
        s.hook_qpc,
        s.dispatch_qpc,
        s.present_call_qpc,
        s.present_return_qpc,
        s.present_id,
        s.sync_qpc,
        s.present_refresh_count
    )
}

/// The four host-side stages, in milliseconds, for one sample. `sync_qpc == 0`
/// means frame statistics never resolved the present, so the two stages that
/// depend on it are `None` rather than a plausible-looking zero.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stages {
    pub hook_to_dispatch: f64,
    pub dispatch_to_present_call: f64,
    pub present_call_to_return: f64,
    pub hook_to_present_return: f64,
    pub present_call_to_sync: Option<f64>,
    pub hook_to_sync: Option<f64>,
}

pub fn stages(s: &Sample, freq: i64) -> Stages {
    let ms = |a: i64, b: i64| ticks_to_ms(b - a, freq);
    let synced = s.sync_qpc != 0;
    Stages {
        hook_to_dispatch: ms(s.hook_qpc, s.dispatch_qpc),
        dispatch_to_present_call: ms(s.dispatch_qpc, s.present_call_qpc),
        present_call_to_return: ms(s.present_call_qpc, s.present_return_qpc),
        hook_to_present_return: ms(s.hook_qpc, s.present_return_qpc),
        present_call_to_sync: synced.then(|| ms(s.present_call_qpc, s.sync_qpc)),
        hook_to_sync: synced.then(|| ms(s.hook_qpc, s.sync_qpc)),
    }
}

/// `p50 / p95` table row for stdout, so a run can be read without opening the
/// CSV. Width-aligned to the header in `render_table`.
pub fn render_table(rows: &[(&str, Summary)]) -> String {
    let mut out = String::from(
        "stage                             n      min      p50      p90      p95      p99      max     mean       sd\n",
    );
    for (label, s) in rows {
        out.push_str(&format!(
            "{label:<28} {n:>5} {min:>8.2} {p50:>8.2} {p90:>8.2} {p95:>8.2} {p99:>8.2} {max:>8.2} {mean:>8.2} {sd:>8.2}\n",
            label = label,
            n = s.n,
            min = s.min,
            p50 = s.p50,
            p90 = s.p90,
            p95 = s.p95,
            p99 = s.p99,
            max = s.max,
            mean = s.mean,
            sd = s.stddev,
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_empty_is_zero_not_a_panic() {
        let s = summarize(&[]);
        assert_eq!(s.n, 0);
        assert_eq!(s.p50, 0.0);
        assert_eq!(s.max, 0.0);
    }

    #[test]
    fn summarize_single_sample() {
        let s = summarize(&[7.5]);
        assert_eq!(s.n, 1);
        assert_eq!(s.min, 7.5);
        assert_eq!(s.p50, 7.5);
        assert_eq!(s.p95, 7.5);
        assert_eq!(s.max, 7.5);
        assert_eq!(s.mean, 7.5);
        assert_eq!(s.stddev, 0.0);
    }

    #[test]
    fn nearest_rank_percentiles_on_one_to_hundred() {
        let samples: Vec<f64> = (1..=100).map(|v| v as f64).collect();
        let s = summarize(&samples);
        assert_eq!(s.n, 100);
        assert_eq!(s.min, 1.0);
        assert_eq!(s.p50, 50.0);
        assert_eq!(s.p90, 90.0);
        assert_eq!(s.p95, 95.0);
        assert_eq!(s.p99, 99.0);
        assert_eq!(s.max, 100.0);
        assert_eq!(s.mean, 50.5);
    }

    #[test]
    fn summarize_sorts_unordered_input() {
        let s = summarize(&[9.0, 1.0, 5.0, 3.0, 7.0]);
        assert_eq!(s.min, 1.0);
        assert_eq!(s.p50, 5.0);
        assert_eq!(s.max, 9.0);
    }

    #[test]
    fn stddev_of_a_known_series() {
        // Population sd of [2,4,4,4,5,5,7,9] is exactly 2.
        let s = summarize(&[2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0]);
        assert_eq!(s.mean, 5.0);
        assert!((s.stddev - 2.0).abs() < 1e-12);
    }

    #[test]
    fn ticks_convert_at_the_measured_qpf() {
        // QueryPerformanceFrequency on this box is 10 MHz (spike 0.8 s1).
        assert_eq!(ticks_to_ms(10_000_000, 10_000_000), 1000.0);
        assert!((ticks_to_ms(166_600, 10_000_000) - 16.66).abs() < 1e-9);
        assert_eq!(ticks_to_ms(-10_000, 10_000_000), -1.0);
    }

    #[test]
    fn ticks_to_ms_refuses_to_divide_by_a_zero_frequency() {
        assert_eq!(ticks_to_ms(1234, 0), 0.0);
    }

    #[test]
    fn csv_row_matches_the_header_column_count() {
        let s = Sample {
            seq: 3,
            injected: true,
            warmup: false,
            colour: 1,
            hook_qpc: 100,
            dispatch_qpc: 200,
            present_call_qpc: 300,
            present_return_qpc: 400,
            present_id: 12,
            sync_qpc: 500,
            present_refresh_count: 7,
        };
        let row = csv_row(&s);
        assert_eq!(
            row.split(',').count(),
            CSV_HEADER.split(',').count(),
            "row {row} does not match header {CSV_HEADER}"
        );
        assert_eq!(row, "3,1,0,1,100,200,300,400,12,500,7");
    }

    #[test]
    fn stages_are_deltas_in_milliseconds() {
        let s = Sample {
            hook_qpc: 0,
            dispatch_qpc: 1_000,
            present_call_qpc: 3_000,
            present_return_qpc: 8_000,
            sync_qpc: 100_000,
            ..Default::default()
        };
        let st = stages(&s, 10_000_000);
        assert!((st.hook_to_dispatch - 0.1).abs() < 1e-9);
        assert!((st.dispatch_to_present_call - 0.2).abs() < 1e-9);
        assert!((st.present_call_to_return - 0.5).abs() < 1e-9);
        assert!((st.hook_to_present_return - 0.8).abs() < 1e-9);
        assert!((st.present_call_to_sync.unwrap() - 9.7).abs() < 1e-9);
        assert!((st.hook_to_sync.unwrap() - 10.0).abs() < 1e-9);
    }

    #[test]
    fn an_unresolved_present_reports_none_not_zero() {
        let s = Sample {
            hook_qpc: 0,
            dispatch_qpc: 1_000,
            present_call_qpc: 3_000,
            present_return_qpc: 8_000,
            sync_qpc: 0,
            ..Default::default()
        };
        let st = stages(&s, 10_000_000);
        assert_eq!(st.present_call_to_sync, None);
        assert_eq!(st.hook_to_sync, None);
        assert!((st.hook_to_present_return - 0.8).abs() < 1e-9);
    }

    #[test]
    fn render_table_emits_one_line_per_row_plus_a_header() {
        let table = render_table(&[
            ("hook -> dispatch", summarize(&[1.0, 2.0, 3.0])),
            ("dispatch -> present", summarize(&[4.0])),
        ]);
        assert_eq!(table.lines().count(), 3);
        assert!(table.starts_with("stage"));
        assert!(table.contains("hook -> dispatch"));
    }
}
