//! Clipboard, both directions, text and image.
//!
//! Its size cap is derived from the transport's buffering limit, not picked —
//! spike 0.2 §13.4. str0m's SCTP sender caps buffering at 128 KiB across
//! **every** channel at once (`transport::rtc`'s own queue sits at half of it),
//! and clipboard rides `swoop-control` beside the control traffic rather than
//! taking a sixth channel, so the budget is shared five ways and not six. One
//! chunk is therefore 16 KiB — ≈22 KiB once base64 inside JSON, which fits
//! `session::OUTBOX_BURST_BYTES` with a `swoop-meta` record's room beside it —
//! and a whole transfer is 256 KiB of text or 2 MiB of image. Nothing here
//! picked those numbers; they are what the buffer allows, and
//! `signal::messages::channel` is where they live.
//!
//! # What is carried, and what is not
//!
//! - `CF_UNICODETEXT`, the registered `"PNG"` format, and `CF_DIB`/`CF_DIBV5`
//!   converted to a PNG by [`formats::dib_to_png`].
//! - **`CF_HDROP` is refused**, and a clipboard holding one is left alone
//!   entirely rather than synced as the text of the paths: §5 carries no file
//!   lists and this protocol has no file transfer.
//! - Clipboard sync is refused outright while the input desktop is `Winlogon`
//!   (and on any desktop this process cannot name) — read here with
//!   `OpenInputDesktop` + `GetUserObjectInformationW` rather than taken from
//!   another feature, so the refusal holds whether or not anything else is
//!   watching for the switch.
//! - Host→viewer images go out as PNG; viewer→host images are put back under
//!   the registered `"PNG"` format only. Rebuilding a `CF_DIB` from a PNG needs
//!   a decompressor this crate does not carry, and the browsers and image
//!   editors this is for all read the registered format.
//!
//! # Gating and the audit trail
//!
//! Host→viewer is ungated — a watcher may copy off the machine. Viewer→host
//! requires `ctl`, taken from the verdict [`Feature::on_message`] is handed
//! (this host's own reading of the verified JWT), never from anything in the
//! message. A push from a viewer without it is dropped and reported once, the
//! way §5 asks. Transfers above 64 KiB are reported for the audit trail as a
//! `clipboard_audit` `host_event`; the content never is, and nothing in this
//! module ever logs clipboard content, not even truncated.
//!
//! Hardware tests are `#[ignore]`d — see [`listener`] for what they do to the
//! real clipboard. With the working directory `agent/swoop`:
//!
//! ```text
//! cargo test -- --ignored --nocapture clipboard
//! ```

pub mod formats;
pub mod listener;

use std::collections::VecDeque;
use std::time::Instant;

use crate::ipc::HostEventKind;
use crate::session::{Feature, FeatureRequest, Outbox, SessionHandle};
use crate::signal::messages::channel::{
    Channel, ClipDirection, ClipFormat, Clipboard, CLIPBOARD_CHUNK_MAX_BYTES,
};
use crate::signal::messages::Refusal;

use formats::{Payload, CLIPBOARD_AUDIT_BYTES};
use listener::Listener;

/// The audit reason for a transfer over [`CLIPBOARD_AUDIT_BYTES`], one per
/// direction. `^[a-z0-9_]{1,48}$`, which is all the route accepts.
const AUDIT_TO_HOST: &str = "clipboard_to_host";
const AUDIT_TO_VIEWER: &str = "clipboard_to_viewer";

/// The most audit rows waiting at once. A refused [`Outbox::request`] keeps its
/// place, and past this the machine is producing transfers faster than the
/// session can report them, where the oldest is the one to forget.
const MAX_PENDING_AUDITS: usize = 4;

/// Registered and driven by `session::features`.
pub fn feature() -> Box<dyn Feature> {
    Box::new(ClipboardFeature::default())
}

#[derive(Default)]
struct ClipboardFeature {
    listener: Option<Listener>,
    inbound: Assembly,
    outgoing: Outgoing,
    audits: VecDeque<(HostEventKind, &'static str)>,
    /// §5 reports a refusal once per viewer, not once per message.
    reported_denial: bool,
}

impl Feature for ClipboardFeature {
    fn name(&self) -> &'static str {
        "clipboard"
    }

    fn start(&mut self, _session: &SessionHandle) -> anyhow::Result<()> {
        self.listener = Some(listener::start()?);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut listener) = self.listener.take() {
            listener.stop();
        }
    }

    fn on_message(&mut self, channel: Channel, ctl: bool, payload: &[u8]) -> anyhow::Result<()> {
        if channel != Channel::SwoopControl {
            return Ok(());
        }
        // Every feature is offered every payload on a channel it may read, and
        // §5 shares this one with the control messages: a payload the clipboard
        // codec refuses is somebody else's, not a malformation.
        let Ok(clip) = serde_json::from_slice::<Clipboard>(payload) else {
            return Ok(());
        };
        let Clipboard::Clip {
            dir,
            seq,
            chunk,
            total_bytes,
            ..
        } = &clip;
        // Host→viewer is what this feature *sends*; one arriving is not ours.
        if *dir != ClipDirection::ToHost {
            return Ok(());
        }
        if !ctl {
            self.deny();
            return Ok(());
        }
        if self.inbound.is_refused(*seq) {
            // The rest of a transfer already refused: dropped without a second
            // report, because the refusal is the transfer's, not the chunk's.
            return Ok(());
        }
        // One row per transfer, on the chunk that declares its size — which is
        // also the chunk the size was checked on.
        let first = *chunk == 0;
        let audit_size = *total_bytes > CLIPBOARD_AUDIT_BYTES;
        match self.inbound.accept(&clip) {
            Ok(done) => {
                if first && audit_size {
                    self.audit(HostEventKind::ClipboardAudit, AUDIT_TO_HOST);
                }
                if let Some(payload) = done {
                    if let Some(listener) = self.listener.as_ref() {
                        listener.write(payload);
                    }
                }
                Ok(())
            }
            Err(refusal) => {
                self.audit(HostEventKind::ClipboardAudit, refusal.reason());
                Err(refusal.into())
            }
        }
    }

    fn poll(&mut self, _now: Instant, out: &mut Outbox) {
        self.collect_updates();
        // Requests first: a transfer's audit row should not wait behind the
        // transfer it describes.
        while let Some((kind, reason)) = self.audits.front().copied() {
            if !out.request(FeatureRequest::Audit {
                kind,
                reason: Some(reason.to_owned()),
            }) {
                break;
            }
            self.audits.pop_front();
        }
        while let Some(record) = self.outgoing.record() {
            if !out.send(Channel::SwoopControl, record) {
                // Over the allowance. The chunk keeps its place and is offered
                // again on a later poll: a dropped middle chunk is a corrupt
                // paste, where a refused one is only a slower one.
                break;
            }
            self.outgoing.sent();
        }
    }
}

impl ClipboardFeature {
    /// The machine's clipboard, if it has changed since the last turn.
    fn collect_updates(&mut self) {
        let Some(payload) = self.listener.as_ref().and_then(|l| l.take_update()) else {
            return;
        };
        self.queue_to_viewer(payload);
    }

    fn queue_to_viewer(&mut self, payload: Payload) {
        if payload.bytes.len() as u64 > CLIPBOARD_AUDIT_BYTES {
            self.audit(HostEventKind::ClipboardAudit, AUDIT_TO_VIEWER);
        }
        self.outgoing.queue(payload);
    }

    /// §5: a viewer without `ctl` that sends something gated is dropped and the
    /// attempt is reported — once, not once per message.
    fn deny(&mut self) {
        if self.reported_denial {
            return;
        }
        self.reported_denial = true;
        ::log::warn!("swoop: a viewer without ctl pushed a clipboard, dropped");
        self.audit(
            HostEventKind::InputNotPermitted,
            Refusal::NotPermitted.reason(),
        );
    }

    fn audit(&mut self, kind: HostEventKind, reason: &'static str) {
        if self.audits.len() >= MAX_PENDING_AUDITS {
            self.audits.pop_front();
        }
        self.audits.push_back((kind, reason));
    }
}

// --------------------------------------------------------------- inbound ---

/// A viewer→host transfer being reassembled.
#[derive(Debug)]
struct Transfer {
    seq: u64,
    fmt: ClipFormat,
    chunks: u32,
    next: u32,
    total_bytes: u64,
    bytes: Vec<u8>,
}

/// §5's receive half: one transfer at a time, sized before its first chunk is
/// buffered, and dropped whole the moment it stops making sense.
#[derive(Debug, Default)]
struct Assembly {
    current: Option<Transfer>,
    /// The transfer already refused, whose remaining chunks are dropped in
    /// silence rather than refused one by one.
    refused: Option<u64>,
}

impl Assembly {
    fn is_refused(&self, seq: u64) -> bool {
        self.refused == Some(seq)
    }

    /// One `clip` frame. `Ok(None)` took a chunk, `Ok(Some)` completed the
    /// transfer, and `Err` refused the whole of it.
    fn accept(&mut self, clip: &Clipboard) -> Result<Option<Payload>, Refusal> {
        let Clipboard::Clip {
            fmt,
            seq,
            chunk,
            chunks,
            total_bytes,
            data,
            ..
        } = clip;
        if *chunk == 0 {
            // Sized before the first chunk is buffered: a receiver that waits
            // until reassembly to notice the size has already paid for it.
            clip.admit().inspect_err(|_| self.refuse(*seq))?;
            self.current = Some(Transfer {
                seq: *seq,
                fmt: *fmt,
                chunks: *chunks,
                next: 0,
                total_bytes: *total_bytes,
                bytes: Vec::with_capacity((*total_bytes).min(CLIPBOARD_CHUNK_MAX_BYTES) as usize),
            });
        }
        let Some(transfer) = self.current.as_mut() else {
            self.refuse(*seq);
            return Err(Refusal::MalformedMessage);
        };
        // Every field is re-checked on every chunk: the transfer is identified
        // by all of them, and a chunk that agrees with none of it is not a late
        // arrival, it is a different transfer overwriting this one.
        if transfer.seq != *seq
            || transfer.fmt != *fmt
            || transfer.chunks != *chunks
            || transfer.total_bytes != *total_bytes
            || transfer.next != *chunk
        {
            self.refuse(*seq);
            return Err(Refusal::MalformedMessage);
        }
        let Some(bytes) = formats::decode_chunk(data) else {
            self.refuse(*seq);
            return Err(Refusal::MalformedMessage);
        };
        if transfer.bytes.len() as u64 + bytes.len() as u64 > transfer.total_bytes {
            self.refuse(*seq);
            return Err(Refusal::ClipboardTooLarge);
        }
        transfer.bytes.extend_from_slice(&bytes);
        transfer.next += 1;
        if transfer.next < transfer.chunks {
            return Ok(None);
        }
        let transfer = self.current.take().expect("checked just above");
        if transfer.bytes.len() as u64 != transfer.total_bytes {
            self.refuse(*seq);
            return Err(Refusal::MalformedMessage);
        }
        Ok(Some(Payload {
            fmt: transfer.fmt,
            bytes: transfer.bytes,
        }))
    }

    fn refuse(&mut self, seq: u64) {
        self.current = None;
        self.refused = Some(seq);
    }
}

// -------------------------------------------------------------- outbound ---

/// §5's send half: whole payloads in, one chunk per outbox allowance out.
#[derive(Debug, Default)]
struct Outgoing {
    queue: VecDeque<Payload>,
    sending: Option<Sending>,
    seq: u64,
}

#[derive(Debug)]
struct Sending {
    payload: Payload,
    next: u32,
}

impl Outgoing {
    fn queue(&mut self, payload: Payload) {
        // A clipboard supersedes the one before it; a backlog of them is old
        // data. The transfer already in flight is not disturbed, because the
        // viewer is mid-reassembly of it.
        self.queue.clear();
        self.queue.push_back(payload);
    }

    /// The next record to offer the outbox, or `None` when there is nothing to
    /// send. **Nothing advances here**: the record is rebuilt unchanged until
    /// [`Outgoing::sent`] says the outbox took it, so a refusal costs one
    /// re-encode and never a chunk.
    fn record(&mut self) -> Option<Vec<u8>> {
        if self.sending.is_none() {
            let payload = self.queue.pop_front()?;
            self.seq += 1;
            self.sending = Some(Sending { payload, next: 0 });
        }
        let sending = self.sending.as_ref()?;
        let clip = Clipboard::Clip {
            dir: ClipDirection::ToViewer,
            fmt: sending.payload.fmt,
            seq: self.seq,
            chunk: sending.next,
            chunks: sending.payload.chunks(),
            total_bytes: sending.payload.bytes.len() as u64,
            data: sending.payload.chunk(sending.next),
        };
        serde_json::to_vec(&clip).ok()
    }

    /// The outbox took the record [`Outgoing::record`] built.
    fn sent(&mut self) {
        let Some(sending) = self.sending.as_mut() else {
            return;
        };
        sending.next += 1;
        if sending.next >= sending.payload.chunks() {
            self.sending = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::OUTBOX_BURST_BYTES;
    use base64::prelude::{Engine as _, BASE64_STANDARD};

    fn clip(fmt: ClipFormat, seq: u64, chunk: u32, chunks: u32, total: u64, data: &[u8]) -> Clipboard {
        Clipboard::Clip {
            dir: ClipDirection::ToHost,
            fmt,
            seq,
            chunk,
            chunks,
            total_bytes: total,
            data: BASE64_STANDARD.encode(data),
        }
    }

    fn text_clip(seq: u64, text: &str) -> Clipboard {
        clip(ClipFormat::Text, seq, 0, 1, text.len() as u64, text.as_bytes())
    }

    fn handle() -> SessionHandle {
        SessionHandle {
            sid: "sid_test".to_owned(),
            indicator: crate::bundle::Indicator::Banner,
            ctl: true,
            source: (1920, 1080),
        }
    }

    /// The listener's whole lifecycle through the seam the session drives: it
    /// starts before any viewer has joined and it has to come back down.
    #[test]
    fn the_feature_starts_and_stops_with_its_listener() {
        let mut feature = ClipboardFeature::default();
        feature.start(&handle()).expect("a listener");
        feature.poll(Instant::now(), &mut Outbox::new(Instant::now()));
        feature.stop();
        assert!(feature.listener.is_none());
        // stopping twice is what the session does after a failed start.
        feature.stop();
    }

    #[test]
    fn a_single_chunk_transfer_arrives_whole() {
        let mut assembly = Assembly::default();
        let done = assembly.accept(&text_clip(1, "pasted")).expect("accepted");
        assert_eq!(done, Some(Payload::text("pasted")));
    }

    #[test]
    fn a_chunked_transfer_reassembles_in_order() {
        let mut assembly = Assembly::default();
        let body = vec![9u8; 40 * 1024];
        let chunk = CLIPBOARD_CHUNK_MAX_BYTES as usize;
        let chunks = body.len().div_ceil(chunk) as u32;
        let mut last = None;
        for index in 0..chunks {
            let start = index as usize * chunk;
            let end = (start + chunk).min(body.len());
            last = assembly
                .accept(&clip(
                    ClipFormat::Png,
                    7,
                    index,
                    chunks,
                    body.len() as u64,
                    &body[start..end],
                ))
                .expect("accepted");
        }
        assert_eq!(last, Some(Payload::png(body)));
    }

    #[test]
    fn a_transfer_over_the_cap_is_refused_before_its_first_chunk_is_buffered() {
        let mut assembly = Assembly::default();
        let over = clip(ClipFormat::Text, 3, 0, 64, 300 * 1024, b"x");
        assert_eq!(assembly.accept(&over), Err(Refusal::ClipboardTooLarge));
        assert!(assembly.current.is_none(), "nothing was buffered");
        assert!(assembly.is_refused(3), "the rest of it is dropped in silence");

        let mut assembly = Assembly::default();
        let over = clip(ClipFormat::Png, 4, 0, 256, 3 * 1024 * 1024, b"x");
        assert_eq!(assembly.accept(&over), Err(Refusal::ClipboardTooLarge));
    }

    #[test]
    fn a_transfer_that_outgrows_what_it_declared_is_refused() {
        let mut assembly = Assembly::default();
        let lying = clip(ClipFormat::Text, 5, 0, 1, 2, b"much longer than two");
        assert_eq!(assembly.accept(&lying), Err(Refusal::ClipboardTooLarge));
    }

    #[test]
    fn an_out_of_order_chunk_drops_the_whole_transfer() {
        let mut assembly = Assembly::default();
        let body = vec![1u8; 20 * 1024];
        let chunk = CLIPBOARD_CHUNK_MAX_BYTES as usize;
        assembly
            .accept(&clip(ClipFormat::Png, 9, 0, 2, body.len() as u64, &body[..chunk]))
            .expect("the first chunk");
        // chunk 0 again instead of chunk 1: a repeat is not a transfer.
        let repeat = clip(ClipFormat::Png, 9, 0, 2, body.len() as u64, &body[..chunk]);
        assert!(assembly.accept(&repeat).is_ok(), "chunk 0 restarts it");
        let wrong = clip(ClipFormat::Png, 9, 5, 2, body.len() as u64, &body[chunk..]);
        assert_eq!(assembly.accept(&wrong), Err(Refusal::MalformedMessage));
        assert!(assembly.current.is_none());
    }

    #[test]
    fn a_chunk_arriving_with_no_transfer_open_is_refused() {
        let mut assembly = Assembly::default();
        let orphan = clip(ClipFormat::Text, 11, 1, 2, 32, b"tail");
        assert_eq!(assembly.accept(&orphan), Err(Refusal::MalformedMessage));
    }

    #[test]
    fn a_push_without_ctl_is_dropped_and_reported_once() {
        let mut feature = ClipboardFeature::default();
        let payload = serde_json::to_vec(&text_clip(1, "pasted")).expect("a clip");
        for _ in 0..3 {
            feature
                .on_message(Channel::SwoopControl, false, &payload)
                .expect("a refusal is not an error");
        }
        assert_eq!(
            feature.audits.len(),
            1,
            "once per viewer, not once per message"
        );
        assert_eq!(feature.audits[0].0, HostEventKind::InputNotPermitted);
    }

    #[test]
    fn a_payload_on_another_channel_is_not_ours() {
        let mut feature = ClipboardFeature::default();
        let payload = serde_json::to_vec(&text_clip(1, "pasted")).expect("a clip");
        feature
            .on_message(Channel::SwoopInput, true, &payload)
            .expect("ignored");
        feature
            .on_message(Channel::SwoopControl, true, br#"{"t":"idr"}"#)
            .expect("somebody else's control message");
        assert!(feature.audits.is_empty());
    }

    #[test]
    fn a_host_to_viewer_clip_arriving_inbound_is_ignored() {
        let mut feature = ClipboardFeature::default();
        let ours = Clipboard::Clip {
            dir: ClipDirection::ToViewer,
            fmt: ClipFormat::Text,
            seq: 1,
            chunk: 0,
            chunks: 1,
            total_bytes: 1,
            data: BASE64_STANDARD.encode("x"),
        };
        let payload = serde_json::to_vec(&ours).expect("a clip");
        feature
            .on_message(Channel::SwoopControl, true, &payload)
            .expect("ignored");
        assert!(feature.inbound.current.is_none());
    }

    #[test]
    fn the_largest_legal_record_fits_the_outbox_burst() {
        let mut outgoing = Outgoing::default();
        outgoing.queue(Payload::png(vec![0xabu8; 2 * CLIPBOARD_CHUNK_MAX_BYTES as usize]));
        let record = outgoing.record().expect("a record");
        assert!(
            record.len() <= OUTBOX_BURST_BYTES,
            "a 16 KiB chunk is {} bytes on the wire",
            record.len()
        );
        assert!(Outbox::new(Instant::now()).send(Channel::SwoopControl, record));
    }

    #[test]
    fn a_refused_chunk_is_offered_again_unchanged() {
        let mut outgoing = Outgoing::default();
        outgoing.queue(Payload::png(vec![3u8; 40 * 1024]));
        let first = outgoing.record().expect("a record");
        // the outbox refused it: nothing advanced, so the same chunk comes back.
        assert_eq!(outgoing.record().expect("the same record"), first);
        outgoing.sent();
        assert_ne!(outgoing.record().expect("the next record"), first);
    }

    #[test]
    fn a_transfer_refused_mid_flight_still_arrives_whole_and_in_order() {
        let body: Vec<u8> = (0..40u32 * 1024).map(|i| (i % 251) as u8).collect();
        let mut outgoing = Outgoing::default();
        outgoing.queue(Payload::png(body.clone()));

        let mut assembly = Assembly::default();
        let mut done = None;
        let mut offered = 0;
        while let Some(record) = outgoing.record() {
            offered += 1;
            // every other offer is refused for want of allowance.
            if offered % 2 == 0 {
                continue;
            }
            outgoing.sent();
            let mut clip: Clipboard = serde_json::from_slice(&record).expect("our own record");
            // §5's receive half only ever sees to-host frames; the viewer's
            // reassembly is the same state machine, so flip the direction and
            // reuse it rather than writing a second one for the test.
            let Clipboard::Clip { dir, .. } = &mut clip;
            *dir = ClipDirection::ToHost;
            done = assembly.accept(&clip).expect("a chunk the viewer takes");
        }
        assert_eq!(done, Some(Payload::png(body)));
    }

    #[test]
    fn a_newer_clipboard_supersedes_one_still_queued_but_never_one_in_flight() {
        let mut outgoing = Outgoing::default();
        outgoing.queue(Payload::png(vec![1u8; 40 * 1024]));
        let first = outgoing.record().expect("a record");
        outgoing.sent();
        outgoing.queue(Payload::text("copied while the image was going out"));
        outgoing.queue(Payload::text("and again"));
        assert_eq!(outgoing.queue.len(), 1, "only the newest is kept");
        // the image keeps the channel until its last chunk.
        let second = outgoing.record().expect("the image's next chunk");
        assert_ne!(second, first);
        while outgoing.sending.is_some() {
            let _ = outgoing.record();
            outgoing.sent();
        }
        let text = outgoing.record().expect("the text's first chunk");
        let clip: Clipboard = serde_json::from_slice(&text).expect("our own record");
        let Clipboard::Clip { fmt, seq, .. } = clip;
        assert_eq!(fmt, ClipFormat::Text);
        assert_eq!(seq, 2, "a new transfer, a new sequence number");
    }

    #[test]
    fn a_transfer_above_the_audit_size_is_reported_once() {
        let mut feature = ClipboardFeature::default();
        feature.queue_to_viewer(Payload::png(vec![0u8; CLIPBOARD_AUDIT_BYTES as usize + 1]));
        assert_eq!(feature.audits.len(), 1);
        assert_eq!(feature.audits[0], (HostEventKind::ClipboardAudit, AUDIT_TO_VIEWER));

        let mut feature = ClipboardFeature::default();
        feature.queue_to_viewer(Payload::png(vec![0u8; CLIPBOARD_AUDIT_BYTES as usize]));
        assert!(feature.audits.is_empty(), "the cap is inclusive");
    }

    #[test]
    fn an_oversize_push_is_reported_for_the_audit_trail() {
        let mut feature = ClipboardFeature::default();
        let over = serde_json::to_vec(&clip(ClipFormat::Text, 3, 0, 64, 300 * 1024, b"x"))
            .expect("a clip");
        assert!(feature.on_message(Channel::SwoopControl, true, &over).is_err());
        assert_eq!(
            feature.audits[0],
            (HostEventKind::ClipboardAudit, Refusal::ClipboardTooLarge.reason())
        );
        // the rest of the refused transfer is dropped without another row.
        let tail = serde_json::to_vec(&clip(ClipFormat::Text, 3, 1, 64, 300 * 1024, b"x"))
            .expect("a clip");
        feature
            .on_message(Channel::SwoopControl, true, &tail)
            .expect("dropped in silence");
        assert_eq!(feature.audits.len(), 1);
    }

    #[test]
    fn a_push_above_the_audit_size_is_reported_once_for_the_whole_transfer() {
        let mut feature = ClipboardFeature::default();
        let body = vec![2u8; 80 * 1024];
        let chunk = CLIPBOARD_CHUNK_MAX_BYTES as usize;
        let chunks = body.len().div_ceil(chunk) as u32;
        for index in 0..chunks {
            let start = index as usize * chunk;
            let end = (start + chunk).min(body.len());
            let frame = serde_json::to_vec(&clip(
                ClipFormat::Png,
                12,
                index,
                chunks,
                body.len() as u64,
                &body[start..end],
            ))
            .expect("a clip");
            feature
                .on_message(Channel::SwoopControl, true, &frame)
                .expect("accepted");
        }
        assert_eq!(feature.audits.len(), 1, "one row for the transfer");
        assert_eq!(feature.audits[0], (HostEventKind::ClipboardAudit, AUDIT_TO_HOST));
    }

    #[test]
    fn audits_reach_the_session_through_the_outbox_it_lends() {
        let mut feature = ClipboardFeature::default();
        feature.queue_to_viewer(Payload::text("a paste worth recording"));
        feature.audit(HostEventKind::ClipboardAudit, AUDIT_TO_HOST);
        let mut out = Outbox::new(Instant::now());
        feature.poll(Instant::now(), &mut out);
        assert!(feature.audits.is_empty(), "the outbox took the row");
    }

    #[test]
    fn nothing_is_sent_past_the_allowance_and_nothing_is_lost() {
        let mut feature = ClipboardFeature::default();
        feature.queue_to_viewer(Payload::png(vec![4u8; 200 * 1024]));
        let mut out = Outbox::new(Instant::now());
        feature.poll(Instant::now(), &mut out);
        assert!(out.refused() > 0, "the burst is the bound");
        assert!(
            feature.outgoing.sending.is_some(),
            "the rest of the transfer is still ours to offer"
        );
        // a fresh allowance, as the session's refill gives it, moves it on.
        let before = feature.outgoing.sending.as_ref().map(|s| s.next);
        feature.poll(Instant::now(), &mut Outbox::new(Instant::now()));
        assert_ne!(feature.outgoing.sending.as_ref().map(|s| s.next), before);
    }
}
