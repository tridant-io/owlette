//! The feature registry.
//!
//! Wave 6 fills one module per name here and swaps its stub in. The list is the
//! only place a feature is named, so the session loop, the `status` event and
//! the tests never drift apart.

use super::Feature;

/// Every feature the host session offers, in start order. Stops run in reverse.
pub const FEATURE_NAMES: [&str; 5] = ["cursor", "clipboard", "audio", "displays", "securedesk"];

/// A named feature that does nothing, so the session loop can be written and
/// tested before any of them exist.
struct Stub(&'static str);

impl Feature for Stub {
    fn name(&self) -> &'static str {
        self.0
    }

    fn start(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    fn stop(&mut self) {}
}

/// Build the feature set for one session.
pub fn registry() -> Vec<Box<dyn Feature>> {
    FEATURE_NAMES
        .iter()
        .map(|name| Box::new(Stub(name)) as Box<dyn Feature>)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn registry_has_one_entry_per_named_feature() {
        let names: Vec<&str> = registry().iter().map(|f| f.name()).collect();
        assert_eq!(names, FEATURE_NAMES.to_vec());
    }

    #[test]
    fn feature_names_are_unique() {
        let unique: HashSet<&&str> = FEATURE_NAMES.iter().collect();
        assert_eq!(unique.len(), FEATURE_NAMES.len());
    }

    #[test]
    fn stubs_start_and_stop_without_error() {
        for mut feature in registry() {
            feature.start().expect("a stub feature never fails to start");
            feature.stop();
        }
    }
}
