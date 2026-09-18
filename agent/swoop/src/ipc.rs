//! The stdin/stdout line protocol with the agent service.
//!
//! stdin carries the bundle line and then control lines; stdout carries JSON
//! event lines; stderr goes to the log. There is no file seam between the
//! service and the streamer (plan.md D2). Task 2.10 fills the message types,
//! against agent/swoop/PROTOCOL.md.

/// Process exit codes. These are the plan's names registry, and the agent
/// reports on them, so they are contract: add, never renumber.
pub mod exit {
    /// Normal exit — the last viewer left and the linger expired, or the
    /// service asked for a kill.
    pub const OK: u8 = 0;
    /// The bundle on stdin was missing, malformed, or carried a field this
    /// build does not accept (an `overrides` object without `testhooks`).
    pub const BUNDLE_INVALID: u8 = 10;
    /// The bundle's version does not match this binary's — a stale streamer
    /// after an upgrade that was delayed until reboot.
    pub const VERSION_MISMATCH: u8 = 11;
    pub const NO_CAPTURE_SOURCE: u8 = 12;
    pub const NO_ENCODER: u8 = 13;
    pub const SIGNALING_UNREACHABLE: u8 = 14;
    pub const INTERNAL: u8 = 20;
}
