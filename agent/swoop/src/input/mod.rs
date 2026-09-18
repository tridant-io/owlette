//! Input injection. Task 4.3 fills the Win32 backend.

/// What the browser sends, already mapped to this platform's key and button
/// numbering by the client keymap. The host still enforces `ctl` from the
/// verified viewer JWT before anything reaches an injector.
#[derive(Debug, Clone, Copy)]
pub enum InputEvent {
    /// Absolute pointer position, normalised 0.0–1.0 over the captured surface,
    /// so a resolution change mid-session does not move the cursor.
    MouseMove { x: f32, y: f32 },
    MouseButton { button: u8, down: bool },
    MouseWheel { delta_x: i32, delta_y: i32 },
    /// Hardware scancode plus the extended-key flag, not a virtual key: a
    /// scancode survives a mismatched keyboard layout between client and host.
    Key { scancode: u16, extended: bool, down: bool },
}

/// Injects input into the active desktop.
pub trait Injector: Send {
    fn inject(&mut self, event: &InputEvent) -> anyhow::Result<()>;
}
