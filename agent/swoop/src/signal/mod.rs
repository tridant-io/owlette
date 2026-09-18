//! Signaling client: the host half of the Worker + Durable Object room.
//!
//! - [`messages`] — the ten frames and their per-role send rights (Wave 2).
//! - [`dial`] — the upgrade request, the refusal vocabulary, the retry ladder.
//! - [`admission`] — who gets in, how fast, and what is written down.
//! - [`client`] — the frames in, the frames out, and every token verified here
//!   as well as at the worker.
//!
//! **There is no socket in this crate yet, and that is deliberate rather than
//! missing.** The pinned dependency set carries neither a websocket client nor
//! a tls stack, and `Cargo.toml` belongs to Task 10.1; adding either is a
//! decision, not an implementation detail. So the room is spoken to through
//! [`client::SignalTransport`], the same sans-IO shape str0m gives the peer
//! connection, and the task that adds the dependency implements that one trait
//! and nothing else.
//!
//! The live test that belongs with it, once there is a socket:
//!
//! ```text
//! cd infra/swoop-signal && npx wrangler dev          # ws://127.0.0.1:8787
//! cd agent/swoop && cargo test -- --ignored signal_room
//! ```
//!
//! expected: the dial is accepted with the `owlette.swoop.v1` subprotocol, the
//! room's first frame is a `hello` carrying `protocolVersion: 1` and
//! `role: "host"`, and `POST /v1/kill` closes the socket with 1000 inside 2 s.

pub mod admission;
pub mod client;
pub mod dial;
pub mod messages;

pub use admission::{Admission, Denial, DenialReason, Limits};
pub use client::{Effect, Incoming, SignalClient, SignalTransport};
pub use dial::{AuthSignal, DialError, Handshake, Reaction, RetryPolicy, SUBPROTOCOL};
