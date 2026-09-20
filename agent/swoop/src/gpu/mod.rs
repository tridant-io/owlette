//! GPU device and frame types. Task 4.5 fills the convert/scale path.

pub mod scale;

/// The graphics device capture and encode share.
///
/// One device per streamer: Desktop Duplication hands out textures owned by the
/// adapter it was opened on, and NVENC registers those same textures, so a
/// second device would mean a copy through system memory on every frame.
pub struct Device {
    /// Adapter LUID, the only field that is meaningful on every OS — it is how
    /// a capture source and an encoder agree they are on the same GPU.
    pub adapter_luid: i64,
}

/// One captured frame, still on the GPU.
///
/// Deliberately not a pixel buffer: the whole point of the pipeline is that
/// nothing reads the frame back to system memory. `handle` is the platform
/// texture (a `ID3D11Texture2D` on Windows).
pub struct Frame {
    pub handle: usize,
    pub width: u32,
    pub height: u32,
    /// QPC ticks at the moment the compositor presented the frame, carried the
    /// whole way to the browser so the stats overlay can break latency down by
    /// stage (plan.md D16).
    pub captured_qpc: i64,
}
