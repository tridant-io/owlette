//! Per-viewer records and the fan-out of one encoded stream to all of them.
//!
//! Three modules, one for each thing a session with more than one viewer in it
//! has to get right:
//!
//! - [`roster`] — who is here, and what each one is allowed to do. `ctl` comes
//!   from the verified jwt and there is no other road to it.
//! - [`input`] — one desktop, several controllers: held keys per viewer,
//!   last-input-wins at the host, and everything a departing viewer was holding
//!   released before it goes.
//! - [`lease`] — §10's ledger: when each viewer's lease lapses.

pub mod input;
pub mod lease;
pub mod roster;

pub use input::{DenialReport, InputOutcome, SharedInput};
pub use roster::{Presence, PresenceViewer, Roster, ViewerRecord};
