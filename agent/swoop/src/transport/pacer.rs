//! Send pacing. Task 3.8 fills it.
//!
//! str0m's own pacer is unusable as configured — with BWE on, spike 0.2
//! measured 1015.6 ms p50 of pacer queue with zero loss, zero PLIs and zero
//! NACKs, so it presents as latency and no loss-based health check catches it.
//! That measurement is the reason this module exists.
