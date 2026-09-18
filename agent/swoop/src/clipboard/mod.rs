//! Clipboard, both directions, text and image. Task 6.2 fills it.
//!
//! Its size cap is derived from the transport's buffering limit, not picked —
//! spike 0.2 §13.4.

use crate::session::Feature;

/// Registered and doing nothing until Task 6.2 fills it. The contract it
/// plugs into is `session::features`.
pub fn feature() -> Box<dyn Feature> {
    crate::session::features::stub("clipboard")
}
