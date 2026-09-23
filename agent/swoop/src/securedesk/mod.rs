//! The secure desktop: following the input desktop, and the Ctrl+Alt+Del
//! handshake with the service. Task 6.1 fills it.

use crate::session::Feature;

/// Registered and doing nothing until Task 6.1 fills it. The contract it
/// plugs into is `session::features`.
pub fn feature() -> Box<dyn Feature> {
    crate::session::features::stub("securedesk")
}
