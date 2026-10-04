//! Host-side TURN client (plan.md D13), behind the `turn` cargo feature: str0m
//! has no TURN client, and Cloudflare bills only server to client egress, so
//! holding the allocation here leaves the video direction unbilled.
//!
//! Sans-IO like [`super::stun`]: an [`Allocation`] is driven with the
//! caller's datagrams and `now` and hands back the bytes to send, so the whole
//! exchange — the 401 challenge, refreshes, permissions, channels and the
//! retransmit schedule — is tested against a scripted server without a socket
//! or a wait. `wire` is the STUN/TURN codec under it and `md5` the long-term
//! credential's hash.

mod alloc;
mod md5;
mod wire;

pub use alloc::{Allocation, Event, Failure, State, Step};
pub use wire::Method;
