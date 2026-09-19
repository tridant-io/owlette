//! Shared input: several viewers, one desktop, one pointer.
//!
//! # Modifier state is per viewer, the desktop is not
//!
//! Two controllers share one `SendInput` queue, so the *events* are one
//! interleaved stream and §5 resolves it the only way a desktop can:
//! last-input-wins, at the host, with no lock and no turn-taking. What is
//! **not** shared is what each viewer is holding down. One
//! [`ViewerInput`](crate::input::ViewerInput) per viewer is the whole point of
//! this module: releasing the viewer that just disconnected must not lift the
//! shift the other controller is still holding, and a single held-key set
//! cannot tell those two apart.
//!
//! `SendInput` does not reset keyboard state and nothing else will, so
//! [`SharedInput::release`] is owed to the machine on **every** road out —
//! leave, kick, lease lapse, and a `ctl` that was revoked. Wave 6 wired the
//! single-viewer form of that (`ToInput::ReleaseAll` from `on_viewer_gone`,
//! which releases the one held set the input thread owns); this is the same
//! trigger for a session with more than one viewer in it, and it delegates to
//! the same `ViewerInput::release_all` rather than growing a second idea of
//! what "held" means.
//!
//! # A refusal that nobody can see is not a control
//!
//! A view-only viewer that sends input is dropped and counted, and §5 reports
//! the attempt to `POST /api/agent/swoop/events` **once per viewer** — a held
//! key repeats at about 30 Hz and one line per event would be the flood rather
//! than the record of it. Once per viewer *forever* is the opposite failure:
//! a scripted viewer hammering the channel for an hour is one row, timestamped
//! when it started, and the operator has no way to tell it is still going. So a
//! viewer that keeps at it is reported again, at most every
//! [`DENIAL_REPORT_INTERVAL`], and only once the attempts since the last report
//! pass [`SUSTAINED_DENIALS`]. Those repeats are what an attack in progress
//! looks like in the audit trail.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::input::{InputEvent, ViewerInput};
use crate::ipc::HostEventKind;
use crate::signal::messages::channel::Input;
use crate::viewers::roster::{Presence, Roster};

/// The soonest a viewer that is still being refused is reported again.
pub const DENIAL_REPORT_INTERVAL: Duration = Duration::from_secs(30);

/// How many refusals since the last report count as sustained. Key repeat is
/// about 30 Hz, so this is a second of leaning on one key — under it, nobody is
/// reported twice for a stray keystroke after losing control mid-chord.
pub const SUSTAINED_DENIALS: u64 = 30;

/// One row for `POST /api/agent/swoop/events`, as §6's `host_event` carries it.
///
/// `reason` is the finer code beneath `kind`, and the route accepts nothing
/// outside `^[a-z0-9_]{1,48}$`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DenialReport {
    pub viewer: String,
    pub kind: HostEventKind,
    pub reason: &'static str,
}

/// §5's first refusal for a viewer.
const REASON_FIRST: &str = "input";
/// A viewer that is still sending gated input a reporting interval later.
const REASON_SUSTAINED: &str = "input_sustained";

/// What one input message produced.
#[derive(Debug, Default, PartialEq)]
pub struct InputOutcome {
    /// What to inject, already recorded in this viewer's own held set.
    pub events: Vec<InputEvent>,
    /// The audit row this attempt owes, if any.
    pub denial: Option<DenialReport>,
    /// This controller's pointer, to fan out to the other viewers.
    pub cursor: Option<Presence>,
}

/// Per-viewer refusal bookkeeping.
#[derive(Debug)]
struct DenialState {
    since_report: u64,
    reported_at: Instant,
}

/// Every viewer's input state, and the one stream that comes out of it.
#[derive(Debug, Default)]
pub struct SharedInput {
    held: BTreeMap<String, ViewerInput>,
    denials: BTreeMap<String, DenialState>,
    /// Refusals across every viewer, for §6's `status.denials`.
    denied: u64,
    /// Rate-limit drops from viewers that have since left, so the cumulative
    /// count in `status.inputDropped` never goes backwards on a departure.
    dropped_gone: u64,
    /// Who last actually moved the desktop. `last-input-wins` made readable:
    /// this is the winner.
    last: Option<String>,
}

impl SharedInput {
    pub fn new() -> Self {
        Self::default()
    }

    /// One §5 input message from one viewer.
    ///
    /// The roster is the gate and the only one: a viewer without `ctl` — or one
    /// nobody admitted — never reaches an injector, whatever it sent.
    pub fn accept(
        &mut self,
        roster: &Roster,
        viewer: &str,
        message: &Input,
        now: Instant,
    ) -> InputOutcome {
        if !roster.control_granted(viewer) {
            return InputOutcome {
                denial: self.deny(viewer, now),
                ..InputOutcome::default()
            };
        }

        let events = self
            .held
            .entry(viewer.to_owned())
            .or_insert_with(|| ViewerInput::new(now))
            .accept(message, now);

        // Only what actually reached the desktop counts as winning: a message
        // the rate limit dropped moved nothing.
        if !events.is_empty() {
            self.last = Some(viewer.to_owned());
        }

        // Absolute moves only. A viewer in pointer lock sends `mr` deltas and
        // has no position of its own to publish — the host's own `cpos` is
        // where that pointer went.
        let cursor = match message {
            Input::M { x, y, ts_us, .. } => Some(Presence::Vpos {
                viewer: viewer.to_owned(),
                x: x.clamp(0.0, 1.0),
                y: y.clamp(0.0, 1.0),
                ts_us: *ts_us,
            }),
            _ => None,
        };

        InputOutcome {
            events,
            denial: None,
            cursor,
        }
    }

    /// Everything this viewer is holding, released, exactly one up event each.
    ///
    /// Every road out of a session ends here: a `bye`, a kick, a lapsed lease,
    /// a peer that died, and a `ctl` that was taken away. It is safe to call
    /// for a viewer that held nothing and for one that was never admitted.
    pub fn release(&mut self, viewer: &str) -> Vec<InputEvent> {
        if self.last.as_deref() == Some(viewer) {
            self.last = None;
        }
        self.denials.remove(viewer);
        match self.held.remove(viewer) {
            Some(mut held) => {
                self.dropped_gone += held.dropped();
                held.release_all()
            }
            None => Vec::new(),
        }
    }

    /// Every viewer's held keys, released: the session ending, and the desktop
    /// switch the input thread's own watcher notices.
    pub fn release_all(&mut self) -> Vec<InputEvent> {
        let viewers: Vec<String> = self.held.keys().cloned().collect();
        viewers
            .iter()
            .flat_map(|viewer| self.release(viewer))
            .collect()
    }

    /// Who last moved the desktop, while they are still here.
    pub fn last_controller(&self) -> Option<&str> {
        self.last.as_deref()
    }

    /// True while this viewer is holding anything at all.
    pub fn holding(&self, viewer: &str) -> bool {
        self.held.get(viewer).is_some_and(ViewerInput::holding)
    }

    /// §6's `status.inputDropped`: the rate limiter's cumulative count across
    /// every viewer this session has had.
    pub fn dropped(&self) -> u64 {
        self.dropped_gone
            + self
                .held
                .values()
                .map(ViewerInput::dropped)
                .sum::<u64>()
    }

    /// §6's `status.denials`: every refusal, including the ones suppressed
    /// behind a single `host_event`.
    pub fn denials(&self) -> u64 {
        self.denied
    }

    /// Count the refusal, and answer with the row it owes the audit trail — the
    /// first one from this viewer, then one per interval while it keeps going.
    fn deny(&mut self, viewer: &str, now: Instant) -> Option<DenialReport> {
        self.denied += 1;
        let report = |reason| {
            Some(DenialReport {
                viewer: viewer.to_owned(),
                kind: HostEventKind::InputNotPermitted,
                reason,
            })
        };
        match self.denials.get_mut(viewer) {
            None => {
                self.denials.insert(
                    viewer.to_owned(),
                    DenialState {
                        since_report: 0,
                        reported_at: now,
                    },
                );
                report(REASON_FIRST)
            }
            Some(state) => {
                state.since_report += 1;
                let sustained = state.since_report >= SUSTAINED_DENIALS
                    && now.saturating_duration_since(state.reported_at) >= DENIAL_REPORT_INTERVAL;
                if !sustained {
                    return None;
                }
                state.since_report = 0;
                state.reported_at = now;
                report(REASON_SUSTAINED)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::{Claims, Role};
    use crate::viewers::roster::Roster;

    fn claims(viewer: &str, ctl: bool) -> Claims {
        Claims {
            iss: "owlette-api".to_owned(),
            aud: "swoop-host".to_owned(),
            role: Role::Viewer,
            uid: None,
            site: "site_1".to_owned(),
            machine: "machine_1".to_owned(),
            sid: Some("sid_1".to_owned()),
            viewer: Some(viewer.to_owned()),
            ctl: Some(ctl),
            fp: None,
            iat: 1_000_000,
            exp: Some(1_000_060),
            jti: "jti_1".to_owned(),
        }
    }

    /// A controller, a watcher and a viewer that never presented a token.
    fn roster() -> Roster {
        let mut roster = Roster::new(true);
        roster.join("controller-a");
        roster.join("controller-b");
        roster.join("watcher");
        roster.verify("controller-a", &claims("controller-a", true));
        roster.verify("controller-b", &claims("controller-b", true));
        roster.verify("watcher", &claims("watcher", false));
        roster
    }

    fn key(code: &str, down: bool, seq: u64) -> Input {
        Input::K {
            code: code.to_owned(),
            down,
            seq,
            ts_us: 0,
        }
    }

    fn mouse(x: f64, y: f64, seq: u64) -> Input {
        Input::M {
            x,
            y,
            seq,
            ts_us: 1_700_000,
        }
    }

    #[test]
    fn a_view_only_viewer_injects_nothing_and_is_reported_once() {
        let roster = roster();
        let mut shared = SharedInput::new();
        let now = Instant::now();

        let first = shared.accept(&roster, "watcher", &key("KeyA", true, 1), now);
        assert!(first.events.is_empty(), "nothing reaches the desktop");
        assert_eq!(
            first.denial,
            Some(DenialReport {
                viewer: "watcher".to_owned(),
                kind: HostEventKind::InputNotPermitted,
                reason: "input",
            })
        );

        // A held key repeating: counted every time, reported none of them.
        for seq in 2..20 {
            let again = shared.accept(&roster, "watcher", &key("KeyA", true, seq), now);
            assert!(again.events.is_empty());
            assert_eq!(again.denial, None);
        }
        assert_eq!(shared.denials(), 19);
        assert!(!shared.holding("watcher"), "a refusal holds nothing down");
    }

    /// The row an attack in progress produces: the first attempt, then one per
    /// interval for as long as it keeps going.
    #[test]
    fn a_sustained_stream_of_refusals_is_reported_again() {
        let roster = roster();
        let mut shared = SharedInput::new();
        let start = Instant::now();

        assert!(shared
            .accept(&roster, "watcher", &key("KeyA", true, 1), start)
            .denial
            .is_some());

        // An interval later, but only a handful of attempts: not a stream.
        let later = start + DENIAL_REPORT_INTERVAL;
        for seq in 2..10 {
            assert_eq!(
                shared.accept(&roster, "watcher", &key("KeyA", true, seq), later).denial,
                None
            );
        }

        // Keep at it past the threshold and the next one is a second row.
        let mut reports = 0;
        for seq in 10..10 + SUSTAINED_DENIALS {
            if shared
                .accept(&roster, "watcher", &key("KeyA", true, seq), later)
                .denial
                .is_some_and(|denial| denial.reason == "input_sustained")
            {
                reports += 1;
            }
        }
        assert_eq!(reports, 1, "one row per interval, not one per message");
    }

    /// The refusals are counted whole even where only some are reported: that
    /// count is what `status.denials` carries.
    #[test]
    fn a_viewer_nobody_admitted_is_refused_like_a_watcher() {
        let roster = roster();
        let mut shared = SharedInput::new();
        let outcome = shared.accept(&roster, "stranger", &key("KeyA", true, 1), Instant::now());
        assert!(outcome.events.is_empty());
        assert_eq!(outcome.denial.map(|denial| denial.viewer), Some("stranger".to_owned()));
        assert_eq!(shared.denials(), 1);
    }

    /// The point of the module: one viewer's chord is its own.
    #[test]
    fn modifier_state_is_per_viewer() {
        let roster = roster();
        let mut shared = SharedInput::new();
        let now = Instant::now();

        shared.accept(&roster, "controller-a", &key("ShiftLeft", true, 1), now);
        shared.accept(&roster, "controller-b", &key("ControlLeft", true, 1), now);
        assert!(shared.holding("controller-a"));
        assert!(shared.holding("controller-b"));

        let released = shared.release("controller-a");
        assert_eq!(released.len(), 1, "only a's shift: {released:?}");
        assert!(!shared.holding("controller-a"));
        assert!(
            shared.holding("controller-b"),
            "b's control is still down — releasing a must not lift it"
        );
    }

    /// A disconnect mid-chord is the stuck-modifier bug. Every key and every
    /// button comes back up, exactly once each.
    #[test]
    fn a_departure_releases_every_key_and_button_that_viewer_held() {
        let roster = roster();
        let mut shared = SharedInput::new();
        let now = Instant::now();

        shared.accept(&roster, "controller-a", &key("ShiftLeft", true, 1), now);
        shared.accept(&roster, "controller-a", &key("KeyA", true, 2), now);
        shared.accept(
            &roster,
            "controller-a",
            &Input::B {
                button: 0,
                down: true,
                seq: 3,
                ts_us: 0,
            },
            now,
        );

        let released = shared.release("controller-a");
        assert_eq!(released.len(), 3, "one up per thing held: {released:?}");
        assert!(
            released.iter().all(|event| matches!(
                event,
                InputEvent::MouseButton { down: false, .. }
                    | InputEvent::Key { down: false, .. }
                    | InputEvent::KeyVirtual { down: false, .. }
            )),
            "{released:?}"
        );
        // Idempotent: a lapse arriving after the bye costs nothing.
        assert!(shared.release("controller-a").is_empty());
    }

    #[test]
    fn a_session_ending_releases_every_viewer() {
        let roster = roster();
        let mut shared = SharedInput::new();
        let now = Instant::now();
        shared.accept(&roster, "controller-a", &key("ShiftLeft", true, 1), now);
        shared.accept(&roster, "controller-b", &key("ControlLeft", true, 1), now);

        assert_eq!(shared.release_all().len(), 2);
        assert!(!shared.holding("controller-a"));
        assert!(!shared.holding("controller-b"));
        assert!(shared.last_controller().is_none());
    }

    /// §5 resolves two controllers the only way one desktop can.
    #[test]
    fn the_last_viewer_to_move_the_desktop_wins() {
        let roster = roster();
        let mut shared = SharedInput::new();
        let now = Instant::now();

        let a = shared.accept(&roster, "controller-a", &mouse(0.25, 0.25, 1), now);
        assert_eq!(shared.last_controller(), Some("controller-a"));
        let b = shared.accept(&roster, "controller-b", &mouse(0.75, 0.75, 1), now);
        assert_eq!(shared.last_controller(), Some("controller-b"));
        // Both moves were injected, in the order they arrived — the host
        // arbitrates nothing and drops nothing.
        assert_eq!(a.events, vec![InputEvent::MouseMove { x: 0.25, y: 0.25 }]);
        assert_eq!(b.events, vec![InputEvent::MouseMove { x: 0.75, y: 0.75 }]);

        // A watcher's attempt cannot take the desktop from whoever holds it.
        shared.accept(&roster, "watcher", &mouse(0.0, 0.0, 1), now);
        assert_eq!(shared.last_controller(), Some("controller-b"));
    }

    #[test]
    fn a_controllers_cursor_is_published_and_a_watchers_is_not() {
        let roster = roster();
        let mut shared = SharedInput::new();
        let now = Instant::now();

        assert_eq!(
            shared.accept(&roster, "controller-a", &mouse(0.5, 0.25, 1), now).cursor,
            Some(Presence::Vpos {
                viewer: "controller-a".to_owned(),
                x: 0.5,
                y: 0.25,
                ts_us: 1_700_000,
            })
        );
        assert_eq!(
            shared.accept(&roster, "watcher", &mouse(0.5, 0.25, 1), now).cursor,
            None
        );
        // A viewer in pointer lock has no position of its own to publish.
        assert_eq!(
            shared
                .accept(
                    &roster,
                    "controller-a",
                    &Input::Mr { dx: 4.0, dy: -2.0, seq: 2, ts_us: 0 },
                    now,
                )
                .cursor,
            None
        );
    }

    /// The wire is normalised 0..1 over the selected display, and a viewer can
    /// send whatever it likes.
    #[test]
    fn a_published_cursor_is_clamped_to_the_picture() {
        let roster = roster();
        let mut shared = SharedInput::new();
        let outcome = shared.accept(&roster, "controller-a", &mouse(-3.0, 9.0, 1), Instant::now());
        assert_eq!(
            outcome.cursor,
            Some(Presence::Vpos {
                viewer: "controller-a".to_owned(),
                x: 0.0,
                y: 1.0,
                ts_us: 1_700_000,
            })
        );
    }

    /// A departure must not make the cumulative counter go backwards — it is
    /// reported on every `status` and a fall reads as a restart.
    #[test]
    fn the_drop_count_survives_the_viewer_that_earned_it() {
        let roster = roster();
        let mut shared = SharedInput::new();
        let now = Instant::now();
        // Past the bucket's burst, with no time passing to refill it.
        for seq in 0..2_000 {
            shared.accept(&roster, "controller-a", &mouse(0.5, 0.5, seq), now);
        }
        let dropped = shared.dropped();
        assert!(dropped > 0, "the rate limit dropped nothing at all");
        shared.release("controller-a");
        assert_eq!(shared.dropped(), dropped);
    }
}
