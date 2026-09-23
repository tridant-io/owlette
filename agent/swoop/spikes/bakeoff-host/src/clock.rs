//! `QueryPerformanceCounter` access and the tick → millisecond conversion.
//!
//! Lifted from spike 0.1's `latency-target/src/clock.rs`, which is where the
//! four-timestamp exchange these ticks are reconciled through was calibrated
//! (±0.199 ms at n = 400, drift 1.31 ppm). The HTTP half of that exchange lives
//! in [`crate::httpd`] here, because this spike already runs a server.

use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

/// Raw `QueryPerformanceCounter` tick.
pub fn qpc() -> i64 {
    let mut t = 0i64;
    // QueryPerformanceCounter cannot fail on any Windows version this runs on
    // (documented since Windows XP); a failure would leave `t` at 0, which the
    // stage maths reports as an out-of-range delta rather than a plausible one.
    let _ = unsafe { QueryPerformanceCounter(&mut t) };
    t
}

/// `QueryPerformanceFrequency`, in ticks per second. 10,000,000 on this box.
pub fn qpf() -> i64 {
    let mut f = 0i64;
    let _ = unsafe { QueryPerformanceFrequency(&mut f) };
    f
}

/// Ticks to milliseconds. `freq` is always [`qpf`]; it is a parameter so the
/// conversion is testable without a Windows call.
pub fn ticks_to_ms(ticks: i64, freq: i64) -> f64 {
    if freq == 0 {
        return f64::NAN;
    }
    ticks as f64 * 1000.0 / freq as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qpf_is_a_positive_frequency() {
        assert!(qpf() > 0, "QueryPerformanceFrequency returned {}", qpf());
    }

    #[test]
    fn qpc_is_monotonic_across_two_reads() {
        let a = qpc();
        let b = qpc();
        assert!(b >= a, "QPC went backwards: {a} then {b}");
    }

    #[test]
    fn ticks_convert_at_ten_mhz() {
        assert_eq!(ticks_to_ms(10_000_000, 10_000_000), 1000.0);
        assert_eq!(ticks_to_ms(166_666, 10_000_000), 16.6666);
        assert!(ticks_to_ms(1, 0).is_nan());
    }
}
