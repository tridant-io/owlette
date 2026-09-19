//! The transport thread: takes encoded access units off the capture thread and
//! drives whichever [`VideoSink`] the current peer negotiated.
//!
//! It is the only place the front half and an arm meet, and it is deliberately
//! the same seventeen lines for every arm — that is what "the seam is real"
//! means in practice. Adding arm A or arm C in stage 2 changes
//! [`crate::httpd::handle_offer`]'s choice of implementation and nothing here.
//!
//! One peer at a time. A second offer replaces the first, because the bake-off
//! measures one arm against one browser; multi-viewer fan-out is plan.md D14
//! and Wave 8, not this spike.

use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::capture::{CaptureReport, Control, Frame};
use crate::clock::qpc;
use crate::json::J;
use crate::sink::{EncodedAu, SinkEvent, SinkState, VideoSink};
use crate::stats::summarize;

/// How long the arm may spend inside one `poll` waiting for its own I/O.
///
/// This is the granularity at which the thread notices a freshly encoded frame,
/// so it is a latency term — and a measured one: `HostStamps::enqueued` and
/// `HostStamps::pushed` bracket exactly this wait, and the run's JSON reports
/// its distribution rather than assuming it is negligible.
const POLL_BUDGET: Duration = Duration::from_millis(1);

/// Rebuild the host half of the run report this often.
const REPORT_INTERVAL: Duration = Duration::from_millis(500);

/// How many `SinkEvent::Note`s to keep. Notes are negotiation facts, not a log.
const MAX_NOTES: usize = 64;

/// The arm's own diagnostics, refreshed with the report. `J` has no `Clone`, so
/// the rendered string is what travels.
pub struct Pipeline {
    pub frames: Receiver<Frame>,
    pub sinks: Receiver<Box<dyn VideoSink + Send>>,
    pub control: Arc<Control>,
    pub capture_report: Arc<Mutex<CaptureReport>>,
    pub published: Arc<Mutex<J>>,
    /// Static description of the run, merged into every published report.
    pub config: Vec<(&'static str, J)>,
    /// What the run asked the encoder for. A bandwidth estimate may drive the
    /// encoder *below* this and never above it.
    pub encoder_target_bps: u32,
}

/// What the transport half itself learned.
#[derive(Default)]
struct Tally {
    notes: Vec<String>,
    /// `enqueued` → `pushed`, milliseconds: how long a frame waited for this
    /// thread to come round.
    queue_wait_ms: Vec<f64>,
    frames_pushed: u64,
    keyframe_requests: u64,
    peers_connected: u64,
    last_bitrate_estimate_bps: u64,
    arm: &'static str,
    sink_state: &'static str,
    sink_diagnostics: String,
}

pub fn run(p: Pipeline) {
    let freq = crate::clock::qpf();
    let mut sink: Option<Box<dyn VideoSink + Send>> = None;
    let mut tally = Tally {
        sink_state: "none",
        arm: "none",
        ..Default::default()
    };
    let mut events: Vec<SinkEvent> = Vec::new();
    let mut next_report = Instant::now();

    while p.control.running.load(Ordering::Relaxed) {
        if let Ok(new_sink) = p.sinks.try_recv() {
            tally.arm = new_sink.arm().as_str();
            // A new peer always starts on an IDR. Chrome cannot decode anything
            // before one, and will PLI every 200 ms until it gets one
            // (research/06 §2.4).
            p.control.force_idr.store(true, Ordering::Relaxed);
            sink = Some(new_sink);
        }

        match sink.as_mut() {
            None => {
                // Keep the queue empty so the capture thread never blocks and
                // never counts a drop it did not really suffer.
                while p.frames.try_recv().is_ok() {}
                std::thread::sleep(POLL_BUDGET);
            }
            Some(s) => {
                loop {
                    match p.frames.try_recv() {
                        Ok(mut frame) => {
                            frame.stamps.pushed = qpc();
                            tally.queue_wait_ms.push(crate::clock::ticks_to_ms(
                                frame.stamps.pushed - frame.stamps.enqueued,
                                freq,
                            ));
                            let au = EncodedAu {
                                data: &frame.data,
                                codec: frame.codec,
                                frame_id: frame.frame_id,
                                rtp_time_90k: frame.rtp_time_90k,
                                is_irap: frame.is_irap,
                                stamps: frame.stamps,
                            };
                            if let Err(e) = s.push_au(&au) {
                                push_note(&mut tally, format!("push_au: {e}"));
                            } else {
                                tally.frames_pushed += 1;
                            }
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => return,
                    }
                }

                events.clear();
                if let Err(e) = s.poll(Instant::now(), POLL_BUDGET, &mut events) {
                    push_note(&mut tally, format!("poll: {e}"));
                }
                for event in events.drain(..) {
                    apply_event(event, &p.control, &mut tally, p.encoder_target_bps);
                }
                tally.sink_diagnostics = s.diagnostics().render();
                tally.sink_state = match s.state() {
                    SinkState::Negotiating => "negotiating",
                    SinkState::Connected => "connected",
                    SinkState::Closed => "closed",
                };
                if s.state() == SinkState::Closed {
                    push_note(&mut tally, "peer closed".into());
                    sink = None;
                    tally.sink_state = "closed";
                }
            }
        }

        if Instant::now() >= next_report {
            publish(&p, &tally);
            next_report = Instant::now() + REPORT_INTERVAL;
        }
    }
    publish(&p, &tally);
}

fn apply_event(event: SinkEvent, control: &Control, tally: &mut Tally, target_bps: u32) {
    match event {
        SinkEvent::Connected => {
            tally.peers_connected += 1;
            control.force_idr.store(true, Ordering::Relaxed);
            push_note(tally, "peer connected".into());
        }
        SinkEvent::Disconnected => push_note(tally, "peer disconnected".into()),
        SinkEvent::KeyframeRequest => {
            tally.keyframe_requests += 1;
            control.force_idr.store(true, Ordering::Relaxed);
        }
        SinkEvent::BitrateEstimate(bps) => {
            tally.last_bitrate_estimate_bps = bps;
            // The encoder is retargeted from the arm's own estimate, which on
            // arm B is str0m's GoogCC port fed by transport-wide-cc.
            //
            // The upper clamp is the run's own target, not a constant. The arm
            // starts its estimate above the encoder's target so the pacer is
            // never the limiter (see BWE_HEADROOM), and without this clamp that
            // headroom fed straight back into NVENC: measured at a 20 Mbps
            // target, the encoder was retargeted to 40 Mbps and emitted 61 kB
            // access units — 29 Mbps of real output for a row labelled 20.
            let clamped = (bps.min(target_bps as u64) as u32).max(1_000_000);
            control.retarget_bps.store(clamped, Ordering::Relaxed);
        }
        SinkEvent::Note(n) => push_note(tally, n),
    }
}

fn push_note(tally: &mut Tally, note: String) {
    if tally.notes.len() < MAX_NOTES {
        eprintln!("sink: {note}");
        tally.notes.push(note);
    }
}

fn publish(p: &Pipeline, tally: &Tally) {
    let capture = match p.capture_report.lock() {
        Ok(c) => c.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    let mut obj: Vec<(&'static str, J)> = Vec::new();
    for (k, v) in &p.config {
        obj.push((k, clone_json(v)));
    }
    // Not "arm": the run config already carries the arm the host was started
    // as, and two keys of the same name in one object is a file whose meaning
    // depends on the parser.
    obj.push(("connectedArm", J::s(tally.arm)));
    obj.push(("sinkState", J::s(tally.sink_state)));
    obj.push(("capture", capture_json(&capture)));
    obj.push((
        "transport",
        J::Obj(vec![
            ("framesPushed", J::Uint(tally.frames_pushed)),
            ("peersConnected", J::Uint(tally.peers_connected)),
            ("keyframeRequests", J::Uint(tally.keyframe_requests)),
            (
                "lastBitrateEstimateBps",
                J::Uint(tally.last_bitrate_estimate_bps),
            ),
            ("queueWaitMs", summarize(&tally.queue_wait_ms).to_json()),
            (
                "notes",
                J::Arr(tally.notes.iter().map(J::s).collect::<Vec<_>>()),
            ),
            ("sinkDiagnostics", J::s(tally.sink_diagnostics.clone())),
        ]),
    ));
    obj.push((
        "counters",
        J::Obj(vec![
            (
                "framesEncoded",
                J::Uint(p.control.frames_encoded.load(Ordering::Relaxed)),
            ),
            (
                "framesWithoutNewContent",
                J::Uint(p.control.frames_dropped_no_present.load(Ordering::Relaxed)),
            ),
            (
                "framesDroppedQueueFull",
                J::Uint(p.control.frames_dropped_queue_full.load(Ordering::Relaxed)),
            ),
            (
                "acquireTimeouts",
                J::Uint(p.control.acquire_timeouts.load(Ordering::Relaxed)),
            ),
            (
                "accessLostEvents",
                J::Uint(p.control.access_lost_events.load(Ordering::Relaxed)),
            ),
        ]),
    ));

    if let Ok(mut slot) = p.published.lock() {
        *slot = J::Obj(obj);
    }
}

fn capture_json(c: &CaptureReport) -> J {
    J::Obj(vec![
        ("output", J::s(c.output_name.clone())),
        ("outputIsPrimary", J::Bool(c.output_primary)),
        ("adapter", J::s(c.adapter_description.clone())),
        ("width", J::Uint(c.width as u64)),
        ("height", J::Uint(c.height as u64)),
        ("codec", J::s(c.codec)),
        (
            "desktopPresentIntervalMs",
            summarize(&c.present_intervals_ms).to_json(),
        ),
        ("encodeMs", summarize(&c.encode_ms).to_json()),
        ("encoderTotalMs", summarize(&c.encoder_total_ms).to_json()),
        ("acquireToSubmitMs", summarize(&c.copy_ms).to_json()),
        ("accessUnitBytes", summarize(&c.au_bytes).to_json()),
        ("firstSpsHex", J::s(c.first_sps_hex.clone())),
        (
            "spsBitstreamRestrictionFlag",
            match c.sps_bitstream_restriction_flag {
                Some(v) => J::Bool(v),
                None => J::s("not parsed"),
            },
        ),
        (
            "spsMaxNumReorderFrames",
            match c.sps_max_num_reorder_frames {
                Some(v) => J::Uint(v as u64),
                None => J::s("absent"),
            },
        ),
        (
            "spsMaxDecFrameBuffering",
            match c.sps_max_dec_frame_buffering {
                Some(v) => J::Uint(v as u64),
                None => J::s("absent"),
            },
        ),
        (
            "spsCodecString",
            match &c.sps_codec_string {
                Some(v) => J::s(v.clone()),
                None => J::s("n/a"),
            },
        ),
        (
            "multiSliceAccessUnits",
            J::Uint(c.multi_slice_access_units),
        ),
        ("irapAccessUnits", J::Uint(c.irap_access_units)),
        (
            "irapMissingParameterSets",
            J::Uint(c.irap_missing_parameter_sets),
        ),
        (
            "error",
            match &c.error {
                Some(e) => J::s(e.clone()),
                None => J::Bool(false),
            },
        ),
    ])
}

/// [`J`] is a write-only tree with no `Clone`, and the run config is rebuilt
/// into every published report. Rendering and re-embedding it as a string would
/// double-encode it, so it is rebuilt structurally instead.
fn clone_json(v: &J) -> J {
    match v {
        J::Bool(b) => J::Bool(*b),
        J::Num(n) => J::Num(*n),
        J::Uint(u) => J::Uint(*u),
        J::Str(s) => J::Str(s.clone()),
        J::Arr(items) => J::Arr(items.iter().map(clone_json).collect()),
        J::Obj(fields) => J::Obj(fields.iter().map(|(k, v)| (*k, clone_json(v))).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_poll_budget_is_the_measured_queue_wait_not_an_assumption() {
        // If this changes, the queueWaitMs row in every run's JSON changes with
        // it — which is the point: the term is measured, not asserted away.
        assert_eq!(POLL_BUDGET, Duration::from_millis(1));
    }

    #[test]
    fn a_bitrate_estimate_is_clamped_before_it_reaches_nvenc() {
        let control = Control::default();
        let mut tally = Tally::default();
        apply_event(SinkEvent::BitrateEstimate(10), &control, &mut tally, 20_000_000);
        assert_eq!(control.retarget_bps.load(Ordering::Relaxed), 1_000_000);
        // An estimate above the run's target must never raise the encoder: the
        // arm deliberately starts its estimate above the target.
        apply_event(SinkEvent::BitrateEstimate(u64::MAX), &control, &mut tally, 20_000_000);
        assert_eq!(control.retarget_bps.load(Ordering::Relaxed), 20_000_000);
    }

    #[test]
    fn a_connected_peer_always_forces_an_idr() {
        let control = Control::default();
        let mut tally = Tally::default();
        assert!(!control.force_idr.load(Ordering::Relaxed));
        apply_event(SinkEvent::Connected, &control, &mut tally, 20_000_000);
        assert!(control.force_idr.load(Ordering::Relaxed));
        assert_eq!(tally.peers_connected, 1);
    }

    #[test]
    fn notes_are_bounded() {
        let mut tally = Tally::default();
        for i in 0..MAX_NOTES * 2 {
            push_note(&mut tally, format!("note {i}"));
        }
        assert_eq!(tally.notes.len(), MAX_NOTES);
    }

    #[test]
    fn cloning_json_preserves_structure() {
        let v = J::Obj(vec![
            ("a", J::Uint(1)),
            ("b", J::Arr(vec![J::Bool(true), J::s("x")])),
        ]);
        assert_eq!(clone_json(&v).render(), v.render());
    }
}
