//! System audio capture (WASAPI loopback) and the Opus path. Task 6.3 fills it.

use crate::session::Feature;

/// Registered and doing nothing until Task 6.3 fills it. The contract it
/// plugs into is `session::features`.
pub fn feature() -> Box<dyn Feature> {
    crate::session::features::stub("audio")
}
