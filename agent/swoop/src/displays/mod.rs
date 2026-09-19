//! Display enumeration and selection: single, multi-monitor, spanned canvases
//! and headless detection.
//!
//! swoop never changes display configuration without a per-machine opt-in
//! (plan.md D6) — signage screens are public. v1 has no such opt-in, so there
//! is no call to `ChangeDisplaySettingsEx` or `SetDisplayConfig` anywhere under
//! this module and there must not be one: enumerating outputs and choosing
//! which one to *capture* is a different thing from rearranging someone's
//! screens, and only the first is built.
//!
//! # Where each piece lives
//!
//! - [`enumerate`] — the roster and the virtual-desktop → output →
//!   client-canvas transform.
//! - [`policy`] — the virtual canvas, the headless verdict, and the largest
//!   legal encode size for a canvas on a codec.
//! - here — the [`Feature`], which is the only part that talks to the session.
//!
//! # Why a rescan thread
//!
//! A feature must not block the session loop, which turns every 2 ms, and a
//! DXGI enumeration plus three GDI calls per output is not free. So the roster
//! is refreshed on the feature's own thread and collected in [`Feature::poll`]
//! and [`Feature::status`] — which is the arrangement `session::features`
//! documents for exactly this, and it is what makes a cable pulled while nobody
//! is watching still turn into a `headless` status.
//!
//! One synchronous enumeration happens in [`Feature::start`]: it runs before
//! any viewer has joined, `hello-host` needs a roster the moment the control
//! channel opens, and a few milliseconds there is not on anybody's frame path.
//!
//! # The owner's check — a real multi-monitor box
//!
//! Everything below is **unverified by this task**: it needs two panels, a
//! cable to pull and a browser. The enumeration half was run on the 0.8 box and
//! is reported in `Feature::start`'s log; the rest is not.
//!
//! ```text
//! cd agent/swoop
//! cargo test -- --ignored --nocapture displays
//! ```
//!
//! 1. The roster printed names both panels, with distinct `\?\DISPLAY#...`
//!    paths, the rects DXGI reports (negative coordinates are correct) and the
//!    texture size — transposed against the rect on a rotated panel.
//! 2. Start a session and open it in the browser. The toolbar's monitor button
//!    lists both displays at those texture sizes, with the primary marked, and
//!    the one being streamed selected. **Unverified.**
//! 3. Switch to the other display. The picture changes within a keyframe, and
//!    a click near each corner lands on that corner of the panel now shown —
//!    the pointer space moves with the capture or it lands on the old monitor.
//!    **Unverified.**
//! 4. Pull that panel's cable (or its dummy plug). The session survives; the
//!    capture thread's own `DXGI_ERROR_ACCESS_LOST` recovery takes it. Plug it
//!    back in and the picture returns. **Unverified.**
//! 5. Pull **every** cable. Within one `status` interval the service sees
//!    `displays: "headless"`, and the log carries `no attached output`. There
//!    is no viewer-side message for this — see below. **Unverified.**
//! 6. Throughout: `Settings > System > Display` is unchanged — same
//!    arrangement, same resolutions, same scaling. swoop calls nothing that
//!    could change them, and this is the check that says so.
//!
//! # What reaches the browser, and what does not
//!
//! `signal/messages.rs` is frozen and `DisplayInfo` is `{index, width, height,
//! primary}`. The device path, the monitor's name, dpi and refresh therefore
//! stay host-side: they are what selection is keyed on and what the log names,
//! not something a viewer is told. A rotated panel is advertised **transposed
//! against its desktop rect**, because the browser is handed the un-rotated
//! texture and that is what it will draw.

pub mod enumerate;
pub mod policy;

use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, RecvTimeoutError, Sender};

use crate::capture::OutputInfo;
use crate::encode::Codec;
use crate::gpu::scale::Plan;
use crate::ipc::DisplayState;
use crate::session::{Feature, FeatureRequest, FeatureStatus, Outbox, SessionHandle};
use crate::signal::messages::channel::{Channel, Control, DisplayInfo};

use enumerate::DisplayEntry;

/// How often the roster is re-read. Matched to the session's own `status`
/// cadence: a faster rescan would report nothing new, and a slower one would
/// leave a pulled cable unreported for longer than the event that carries it.
pub const RESCAN_INTERVAL: Duration = Duration::from_secs(2);

pub fn feature() -> Box<dyn Feature> {
    Box::<Displays>::default()
}

/// The rescan thread and the two ends the feature keeps.
struct Rescan {
    /// Dropped to stop the thread: the far end's `recv_timeout` returns
    /// `Disconnected` at once, so `stop` never waits out an interval. It has to
    /// be dropped *before* the join, or the join waits on a thread nothing has
    /// told to leave.
    stop: Sender<()>,
    rosters: Receiver<Vec<DisplayEntry>>,
    handle: JoinHandle<()>,
}

impl Rescan {
    fn spawn() -> Option<Self> {
        let (stop_tx, stop_rx) = bounded::<()>(0);
        let (roster_tx, rosters) = bounded::<Vec<DisplayEntry>>(2);
        let handle = std::thread::Builder::new()
            .name("swoop-displays".into())
            .spawn(move || rescan_loop(&roster_tx, &stop_rx))
            .map_err(|e| ::log::error!("swoop: could not start the display rescan: {e}"))
            .ok()?;
        Some(Self {
            stop: stop_tx,
            rosters,
            handle,
        })
    }
}

fn rescan_loop(rosters: &Sender<Vec<DisplayEntry>>, stop: &Receiver<()>) {
    while stop.recv_timeout(RESCAN_INTERVAL) == Err(RecvTimeoutError::Timeout) {
        match enumerate::enumerate() {
            // A refused send means the session thread is more than two
            // intervals behind; the roster it dropped is replaced in two
            // seconds and holding it would only make the queue older.
            Ok(roster) => {
                let _ = rosters.try_send(roster);
            }
            Err(e) => ::log::warn!("swoop: could not re-enumerate displays: {e}"),
        }
    }
}

#[derive(Default)]
pub struct Displays {
    roster: Vec<DisplayEntry>,
    /// `None` until the feature has started. A feature that has not run has
    /// nothing to say on `status`, which is the seam's own contract for the
    /// optional half and what `session::features` asserts.
    state: Option<DisplayState>,
    /// A viewer's `display` message, held until the next poll — the seam asks
    /// a feature to decide in `on_message` and queue in `poll`.
    pending: Option<u32>,
    /// The viewer's choice by **path**, not index: a virtual display driver
    /// appearing renumbers outputs, and an index that outlives its roster
    /// selects a different monitor.
    selected: Option<String>,
    /// What the session was last asked to capture, so a rescan that changes
    /// nothing does not re-request the same retarget every two seconds.
    last_sent: Option<(u32, OutputInfo)>,
    rescan: Option<Rescan>,
}

impl Displays {
    /// Take the newest roster the rescan thread has produced, if any.
    fn drain(&mut self) {
        let Some(rescan) = self.rescan.as_ref() else {
            return;
        };
        let mut newest = None;
        while let Ok(roster) = rescan.rosters.try_recv() {
            newest = Some(roster);
        }
        if let Some(roster) = newest {
            self.adopt(roster);
        }
    }

    fn adopt(&mut self, roster: Vec<DisplayEntry>) {
        let state = Some(policy::state(&roster));
        // The state moves even when the roster does not: a headless machine's
        // first roster IS the empty one this started with, and leaving `None`
        // there would report "not started yet" for the rest of the session.
        let changed = state != self.state || roster != self.roster;
        self.state = state;
        self.roster = roster;
        if changed {
            self.log();
        }
    }

    /// One block per roster change. Not per rescan: on a steady machine that
    /// would be a log line every two seconds saying the same thing.
    fn log(&self) {
        if self.roster.is_empty() {
            ::log::warn!("swoop: no attached output — this machine is headless");
            return;
        }
        for (index, display) in self.roster.iter().enumerate() {
            let rect = display.output.desktop_rect;
            let (width, height) = display.texture();
            ::log::info!(
                "swoop: display {index} \"{}\" {} texture {width}x{height} at ({},{}) {:?} {} dpi {} hz{}",
                display.name,
                display.path,
                rect.left,
                rect.top,
                display.output.rotation,
                display.dpi,
                display.refresh_hz,
                if display.primary { " primary" } else { "" },
            );
            // H.264 is the floor every browser has, so its ceiling is the one
            // worth warning about: a panel over it can only be streamed scaled.
            if policy::plan_for((width, height), Codec::H264) != Plan::AsIs {
                ::log::warn!(
                    "swoop: display {index} is {width}x{height}, over h.264's 4096 axis cap — it will be downscaled"
                );
            }
        }
        if let Some(canvas) = policy::virtual_canvas(&self.roster) {
            ::log::info!(
                "swoop: virtual desktop ({},{})-({},{}), {}x{}",
                canvas.left,
                canvas.top,
                canvas.right,
                canvas.bottom,
                canvas.width(),
                canvas.height(),
            );
        }
    }

    /// Which output capture should be pointed at right now, or `None`.
    ///
    /// Split out from [`Displays::resolve`] and side-effect free but for
    /// forgetting a `display` message that names nothing: the outbox is
    /// bounded, so this has to give the same answer on the next poll after a
    /// refusal, and a decision that cannot be asked twice is one that gets
    /// dropped.
    fn wanted(&mut self) -> Option<(u32, OutputInfo)> {
        if let Some(index) = self.pending {
            let Some(display) = self.roster.get(index as usize) else {
                ::log::warn!(
                    "swoop: display {index} is not one of the {} attached",
                    self.roster.len()
                );
                self.pending = None;
                return None;
            };
            return Some((index, display.output.clone()));
        }

        // The chosen panel moved under us: it was renumbered, or it came back
        // on a different rect after being unplugged. Nothing is re-requested
        // for the display the session picked at startup — the capture thread's
        // own ACCESS_LOST recovery owns that one, and two things retargeting
        // the same capture would fight.
        let path = self.selected.as_deref()?;
        let index = self.roster.iter().position(|display| display.path == path)?;
        let output = self.roster[index].output.clone();
        let index = index as u32;
        if self.last_sent.as_ref() == Some(&(index, output.clone())) {
            return None;
        }
        Some((index, output))
    }

    /// Ask the session to retarget capture, if anything wants it to.
    ///
    /// A refused request is not dropped: [`Outbox::request`] returns `false`
    /// without taking it, [`Displays::wanted`] still says the same thing, and
    /// the next poll offers it again two milliseconds later.
    fn resolve(&mut self, out: &mut Outbox) {
        let Some((index, output)) = self.wanted() else {
            return;
        };
        if !out.request(FeatureRequest::SelectOutput {
            index,
            output: output.clone(),
        }) {
            return;
        }
        if self.pending == Some(index) {
            self.selected = Some(self.roster[index as usize].path.clone());
            self.pending = None;
            ::log::info!("swoop: capturing display {index} ({})", output.device_name);
        } else {
            ::log::info!("swoop: display {index} moved; re-selecting it");
        }
        self.last_sent = Some((index, output));
    }
}

impl Feature for Displays {
    fn name(&self) -> &'static str {
        "displays"
    }

    fn start(&mut self, _session: &SessionHandle) -> anyhow::Result<()> {
        // An enumeration failure is never fatal here. The session already
        // refuses to start at all on a box with no output (exit 12), so
        // whatever this sees afterwards is a change to report, not a reason to
        // take a live session down.
        match enumerate::enumerate() {
            Ok(roster) => self.adopt(roster),
            Err(e) => {
                ::log::error!("swoop: could not enumerate displays: {e}");
                self.state = Some(DisplayState::Headless);
            }
        }
        self.rescan = Rescan::spawn();
        Ok(())
    }

    fn stop(&mut self) {
        let Some(Rescan { stop, rosters, handle }) = self.rescan.take() else {
            return;
        };
        // In this order: the thread leaves its `recv_timeout` the moment the
        // sender goes, so the join is immediate rather than up to an interval.
        drop(stop);
        drop(rosters);
        let _ = handle.join();
    }

    fn on_message(&mut self, channel: Channel, ctl: bool, payload: &[u8]) -> anyhow::Result<()> {
        if channel != Channel::SwoopControl {
            return Ok(());
        }
        // §5 shares this channel with the clipboard, so a payload the control
        // codec refuses is somebody else's and is not an error.
        let Ok(Control::Display { index }) = serde_json::from_slice::<Control>(payload) else {
            return Ok(());
        };
        // The session denies and reports the ungated attempt itself; this is
        // the same verdict from the same source, because this is what would
        // act on it.
        if !ctl {
            return Ok(());
        }
        self.pending = Some(index);
        Ok(())
    }

    fn poll(&mut self, _now: Instant, out: &mut Outbox) {
        self.drain();
        self.resolve(out);
    }

    fn status(&mut self, out: &mut FeatureStatus) {
        // Pulled whether or not a viewer is connected, which is the whole point
        // for this field: a machine that lost its last output should say so
        // while nobody is watching.
        self.drain();
        // `None` until start: a feature that has not run has nothing to say,
        // which is not the same claim as a machine with no display.
        out.displays = self.state;
    }

    fn hello_displays(&mut self) -> Vec<DisplayInfo> {
        // Empty leaves the session's single-display fallback in place, which is
        // the right answer for a headless machine: a switcher over a list of
        // nothing is worse than no switcher.
        self.roster
            .iter()
            .enumerate()
            .map(|(index, display)| {
                let (width, height) = display.texture();
                DisplayInfo {
                    index: index as u32,
                    width,
                    height,
                    primary: display.primary,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::Indicator;
    use crate::capture::{Rect, Rotation};

    fn handle() -> SessionHandle {
        SessionHandle {
            sid: "sid_test".to_owned(),
            indicator: Indicator::Banner,
            ctl: true,
            source: (1920, 1080),
        }
    }

    fn display(name: &str, rect: Rect, rotation: Rotation) -> DisplayEntry {
        DisplayEntry {
            output: OutputInfo {
                device_name: format!("\\\\.\\{name}"),
                desktop_rect: rect,
                rotation,
            },
            path: format!("\\\\?\\DISPLAY#{name}"),
            name: name.to_owned(),
            dpi: 96,
            refresh_hz: 60,
            primary: rect.left == 0 && rect.top == 0,
        }
    }

    /// Spike 0.8 §3's layout: the primary at the origin and a rotate270 4K
    /// panel to its left, so the virtual desktop is negative in both axes.
    fn measured_roster() -> Vec<DisplayEntry> {
        vec![
            display(
                "DISPLAY1",
                Rect { left: 0, top: 0, right: 1920, bottom: 1080 },
                Rotation::Identity,
            ),
            display(
                "DISPLAY2",
                Rect { left: -2160, top: -1138, right: 0, bottom: 2702 },
                Rotation::Rotate270,
            ),
        ]
    }

    fn loaded() -> Displays {
        let mut feature = Displays::default();
        feature.adopt(measured_roster());
        feature
    }

    /// `on_message` decides and `poll` queues, one turn apart — the seam's
    /// shape, so a test that skips the poll is testing something else.
    fn ask_for(feature: &mut Displays, index: u32, ctl: bool) {
        let payload = format!(r#"{{"t":"display","index":{index}}}"#);
        feature
            .on_message(Channel::SwoopControl, ctl, payload.as_bytes())
            .expect("a display message is this feature's");
    }

    /// One poll with an empty outbox, which always has room.
    fn poll(feature: &mut Displays) {
        feature.poll(Instant::now(), &mut Outbox::new(Instant::now()));
    }

    #[test]
    fn a_rotated_output_is_advertised_transposed_against_its_desktop_rect() {
        let displays = loaded().hello_displays();
        assert_eq!(
            displays,
            vec![
                DisplayInfo { index: 0, width: 1920, height: 1080, primary: true },
                // 2160x3840 on the desktop; the browser is handed the texture.
                DisplayInfo { index: 1, width: 3840, height: 2160, primary: false },
            ]
        );
    }

    #[test]
    fn a_headless_machine_advertises_nothing_and_says_so() {
        let mut feature = Displays::default();
        feature.adopt(Vec::new());
        assert!(feature.hello_displays().is_empty());
        let mut status = FeatureStatus::default();
        feature.status(&mut status);
        assert_eq!(status.displays, Some(DisplayState::Headless));
    }

    #[test]
    fn a_machine_with_outputs_reports_ok() {
        let mut status = FeatureStatus::default();
        loaded().status(&mut status);
        assert_eq!(status.displays, Some(DisplayState::Ok));
    }

    #[test]
    fn a_viewer_with_control_retargets_capture_to_the_output_it_named() {
        let mut feature = loaded();
        ask_for(&mut feature, 1, true);
        assert_eq!(
            feature.wanted(),
            Some((1, measured_roster()[1].output.clone()))
        );
        poll(&mut feature);
        assert_eq!(feature.selected.as_deref(), Some(measured_roster()[1].path.as_str()));
        assert_eq!(feature.wanted(), None, "a satisfied request is not re-sent");
    }

    #[test]
    fn a_viewer_without_control_selects_nothing() {
        let mut feature = loaded();
        ask_for(&mut feature, 1, false);
        assert_eq!(feature.wanted(), None);
    }

    #[test]
    fn a_display_that_is_not_attached_is_refused_rather_than_guessed_at() {
        let mut feature = loaded();
        ask_for(&mut feature, 7, true);
        assert_eq!(feature.wanted(), None);
        // And it is forgotten, not retried against every later roster.
        assert_eq!(feature.pending, None);
    }

    /// The bounded outbox refuses rather than drops, so the decision has to
    /// survive in the feature and be offered again.
    #[test]
    fn a_refused_request_is_offered_again_on_the_next_poll() {
        let mut feature = loaded();
        let mut full = Outbox::new(Instant::now());
        for _ in 0..crate::session::MAX_PENDING_REQUESTS {
            assert!(full.request(FeatureRequest::Sas));
        }
        ask_for(&mut feature, 1, true);
        feature.poll(Instant::now(), &mut full);
        assert_eq!(full.refused(), 1, "the outbox refused ours");
        assert_eq!(
            feature.wanted(),
            Some((1, measured_roster()[1].output.clone())),
            "a refused request is still wanted"
        );

        poll(&mut feature);
        assert_eq!(feature.wanted(), None);
    }

    /// The reason selection is keyed on the device path: a virtual display
    /// driver appearing renumbers the roster, and the viewer's monitor has to
    /// follow its panel rather than its old index.
    #[test]
    fn the_selection_follows_its_panel_when_the_roster_is_renumbered() {
        let mut feature = loaded();
        ask_for(&mut feature, 1, true);
        poll(&mut feature);

        let mut renumbered = measured_roster();
        renumbered.insert(
            1,
            display(
                "DISPLAY3",
                Rect { left: 1920, top: 0, right: 3840, bottom: 1080 },
                Rotation::Identity,
            ),
        );
        feature.adopt(renumbered.clone());
        assert_eq!(feature.wanted(), Some((2, renumbered[2].output.clone())));
        poll(&mut feature);
        assert_eq!(feature.wanted(), None);
    }

    /// A rescan that changes nothing must not re-request the same retarget
    /// every two seconds — each one tears duplication down and forces an IDR.
    #[test]
    fn an_unchanged_roster_does_not_retarget_anything() {
        let mut feature = loaded();
        ask_for(&mut feature, 1, true);
        poll(&mut feature);
        feature.adopt(measured_roster());
        assert_eq!(feature.wanted(), None);
    }

    /// A panel that is gone is not fallen back from: the capture thread's own
    /// ACCESS_LOST recovery owns a lost output, and a retarget racing it would
    /// move the viewer to a monitor nobody asked for.
    #[test]
    fn a_selection_that_is_unplugged_waits_for_it_to_come_back() {
        let mut feature = loaded();
        ask_for(&mut feature, 1, true);
        poll(&mut feature);

        feature.adopt(vec![measured_roster()[0].clone()]);
        assert_eq!(feature.wanted(), None);
        assert_eq!(feature.state, Some(DisplayState::Ok), "one output is not headless");

        feature.adopt(measured_roster());
        assert_eq!(feature.wanted(), None, "nothing moved, so nothing to redo");
    }

    /// The seam's own rule, asserted here too because this is the feature that
    /// would break it: `session::features` starts nothing before it pulls
    /// `status`, and a feature that answered anyway would report a machine it
    /// has never looked at.
    #[test]
    fn a_feature_that_has_not_started_says_nothing() {
        let mut status = FeatureStatus::default();
        Displays::default().status(&mut status);
        assert_eq!(status, FeatureStatus::default());
    }

    #[test]
    fn it_starts_and_stops_without_a_viewer() {
        let mut feature = Displays::default();
        feature.start(&handle()).expect("the feature starts");
        let mut status = FeatureStatus::default();
        feature.status(&mut status);
        assert!(status.displays.is_some());
        feature.stop();
    }
}
