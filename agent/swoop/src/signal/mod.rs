//! Signaling client: the host half of the Worker + Durable Object room.
//!
//! - [`messages`] — the ten frames and their per-role send rights (Wave 2).
//! - [`dial`] — the upgrade request, the refusal vocabulary, the retry ladder.
//! - [`admission`] — who gets in, how fast, and what is written down.
//! - [`client`] — the frames in, the frames out, and every token verified here
//!   as well as at the worker.
//! - [`socket`] — the only module here that touches a network.
//!
//! Everything but [`socket`] is sans-IO, the same shape str0m gives the peer
//! connection, so Task 4.1 drives both from one loop and every rule above is
//! testable without a room. The room is spoken to through
//! [`client::SignalTransport`], and [`socket::RoomSocket`] is the one
//! implementation of it.
//!
//! The live test, against a local worker (the full invocation, with the vars
//! `wrangler dev` needs, is in [`socket`]'s head comment):
//!
//! ```text
//! cd agent/swoop && cargo test -- --ignored signal_room
//! ```
//!
//! expected: the dial is accepted with the `owlette.swoop.v1` subprotocol and
//! the room's first frame is a `hello` carrying `protocolVersion: 1` and
//! `role: "host"`.

pub mod admission;
pub mod client;
pub mod dial;
pub mod messages;
pub mod socket;

pub use admission::{Admission, Denial, DenialReason, Limits};
pub use client::{Effect, Incoming, SignalClient, SignalTransport};
pub use dial::{AuthSignal, DialError, Handshake, Reaction, RetryPolicy, SUBPROTOCOL};
pub use socket::{RoomSocket, SocketError};
