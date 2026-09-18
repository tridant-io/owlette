//! Desktop capture. Task 3.6 fills the DXGI Desktop Duplication source.

use crate::gpu::Frame;

pub mod testpattern;

/// A source of desktop frames.
///
/// `next_frame` is allowed to return `Ok(None)`: Desktop Duplication reports a
/// timeout when nothing on screen changed, and a static desktop is the normal
/// case, not an error. The session keeps a floor frame rate on top of this
/// (plan.md D5 — hardware decoders stall without one).
pub trait Source: Send {
    fn next_frame(&mut self, timeout_ms: u32) -> anyhow::Result<Option<Frame>>;

    /// Width and height of the captured surface, which changes when the user
    /// changes resolution. A change is always a new IDR plus a decoder
    /// reconfigure on the browser side.
    fn size(&self) -> (u32, u32);
}
