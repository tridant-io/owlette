//! The feature registry.
//!
//! The list is the only place a feature is named, so the session loop and the
//! tests never drift apart.
//!
//! Wave 6 fills one module per name — and cannot swap its own stub in without
//! editing this file, which its tasks forbid: `clipboard`, `audio`, `displays`
//! and `securedesk` export no constructor for [`registry`] to call, and Task
//! 5.1 may not add one to a module it does not own. Whoever fills the first of
//! them settles it, one way or the other: each module exports
//! `pub fn feature() -> Box<dyn Feature>` and this file calls it, or Wave 6 is
//! allowed its one line here.

use super::{Feature, SessionHandle};

/// Every feature the host session offers, in start order. Stops run in reverse.
pub const FEATURE_NAMES: [&str; 5] = ["cursor", "clipboard", "audio", "displays", "securedesk"];

/// A named feature that does nothing, so the session loop can be written and
/// tested before any of them exist.
struct Stub(&'static str);

impl Feature for Stub {
    fn name(&self) -> &'static str {
        self.0
    }

    fn start(&mut self, _session: &SessionHandle) -> anyhow::Result<()> {
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
        let session = SessionHandle {
            sid: "sid_test".to_owned(),
            indicator: crate::bundle::Indicator::Banner,
            ctl: true,
            source: (1920, 1080),
        };
        for mut feature in registry() {
            feature
                .start(&session)
                .expect("a stub feature never fails to start");
            feature.stop();
        }
    }
}
