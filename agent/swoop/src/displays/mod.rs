//! Display enumeration and selection: single, multi-monitor, spanned canvases
//! and headless detection. Task 6.4 fills it.
//!
//! swoop never changes display configuration without a per-machine opt-in
//! (plan.md D6) — signage screens are public.

use crate::session::Feature;

/// Registered and doing nothing until Task 6.4 fills it. The contract it
/// plugs into is `session::features`.
pub fn feature() -> Box<dyn Feature> {
    crate::session::features::stub("displays")
}
