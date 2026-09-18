//! The session loop. Tasks 4.1 and 5.1 fill it.
//!
//! Wave 6+ features plug in through `features::registry()` and the `Feature`
//! trait below, so adding clipboard, audio or displays never edits this file.

pub mod features;
pub mod quality;
pub mod tiers;

/// A host feature that lives for the length of a session.
///
/// Task 5.1 widens `start` to take the session handle; until there is a session
/// to hand out, a stub takes nothing. Implementations must not block — every
/// one of them runs on the session thread.
pub trait Feature: Send {
    /// Stable name. It is what the `status` event reports and what the tests
    /// pin, so it is spelled the same as the module.
    fn name(&self) -> &'static str;

    fn start(&mut self) -> anyhow::Result<()>;

    fn stop(&mut self);
}
