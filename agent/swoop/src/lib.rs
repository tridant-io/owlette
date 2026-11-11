//! owlette-swoop — the swoop streamer. It captures one machine's screen and
//! audio, encodes them, serves them to every viewer in the session over WebRTC
//! and takes their input and clipboard back. The agent spawns it and talks to
//! it over stdin and stdout (PROTOCOL.md §6).
//!
//! Layout rule, applied from the start so the crate stays checkable on a macOS
//! or Linux host and so the platform seams are cheap: **traits and wire types
//! are portable, Win32 backends are `#[cfg(windows)]`**. A module that is
//! nothing but Win32 is gated here; a module that defines a trait keeps its
//! backend gated inside. The session loop reaches a backend only through
//! [`platform`]'s names, so it compiles on every OS.

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

// Win32 window stations and desktops have no portable analogue at all, so this
// module is Windows only rather than a trait with a Windows backend.
#[cfg(windows)]
pub mod securedesk;
