//! owlette-swoop — the swoop streamer.
//!
//! Scaffold only (Task 1.2): this crate holds the module tree, the traits every
//! later wave signs against, and nothing that streams. Each module's head
//! comment names the task that fills it.
//!
//! Layout rule, applied from the start so the crate stays checkable on a macOS
//! or Linux host and so Wave 9's platform seams are cheap: **traits and wire
//! types are portable, Win32 backends are `#[cfg(windows)]`**. A module that is
//! nothing but Win32 is gated here; a module that defines a trait keeps its
//! backend gated inside.

pub mod audio;
pub mod bundle;
pub mod capture;
pub mod clipboard;
pub mod cursor;
pub mod displays;
pub mod encode;
pub mod gpu;
pub mod input;
pub mod ipc;
// Shadows the `log` crate inside this crate: reach the facade as `::log::info!`
// from anywhere under src/, and keep this module for the sink itself.
pub mod log;
pub mod platform;
pub mod probe;
pub mod session;
pub mod signal;
pub mod transport;
pub mod viewers;

// Win32 window stations and desktops have no portable analogue at all — the
// macOS and Linux siblings land beside this in Wave 9, not inside it.
#[cfg(windows)]
pub mod securedesk;
