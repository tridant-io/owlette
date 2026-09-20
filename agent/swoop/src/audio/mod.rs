//! System audio capture (WASAPI loopback) and the Opus path.
//!
//! # The shape, and why the pieces sit where they do
//!
//! - [`opus`] is portable: the wire parameters §3's `audio` m-line carries, the
//!   10 ms frame clock that keeps timestamps contiguous across a device gap,
//!   and the encoder seam.
//! - [`wasapi`] is the Win32 half: the render endpoint, and the loopback
//!   capture that reads whatever the machine is playing. Its head documents the
//!   two things about that capture that are not the obvious choice.
//! - This file is the [`Feature`]: what the session drives, what `status`
//!   reports, and what `mute` does.
//!
//! # Audio is its own RTP track, never the video one
//!
//! G1 chose arm B, so the picture is an RTP track rendered into a `<video>`.
//! Audio is a **second RTP track in the same peer connection** with its own
//! `msid`, which is what puts it in its own `MediaStream` in the browser. Sent
//! on the video track's stream instead, the browser would A/V-sync them and
//! hold the picture back to match the audio clock — the one thing arm B's
//! measured latency cannot afford. `transport/rtc.rs` carries it; the frozen
//! [`crate::session::features`] seam moves data-channel bytes and cannot carry
//! media, so the track is handed to the peer rather than queued in an
//! [`crate::session::Outbox`]: [`subscribe`] mints one per viewer for
//! `RtcPeer::set_audio_source`, and that call is the session's whole audio
//! wiring.
//!
//! # Hardware check (`#[ignore]`d)
//!
//! `the_whole_path_encodes_what_this_machine_is_playing` runs the feature for a
//! second and counts what reached a viewer's track. With the working directory
//! `agent/swoop`:
//!
//! ```text
//! cargo test --features audio-opus --lib -- --ignored audio::live --nocapture
//! ```
//!
//! It opens a real loopback capture, so — like `wasapi`'s — it **records
//! whatever the machine is playing** while it runs. Frames arrive either way:
//! a silent desktop produces comfort silence rather than nothing.
//!
//! # What this feature will not do
//!
//! Never creates a virtual audio device, and never changes the default render
//! endpoint. A machine with no render endpoint reports `no_endpoint` on every
//! `status` and the session runs on without audio — it is not a failure, and
//! the page says so rather than offering a toggle that does nothing.

pub mod opus;
#[cfg(windows)]
pub mod wasapi;

/// Registered by `session::features`. Without the `audio-opus` feature the
/// entry is still present and still named `audio` — the registry's list is
/// fixed — it simply reports nothing.
#[cfg(not(feature = "audio-opus"))]
pub fn feature() -> Box<dyn crate::session::Feature> {
    crate::session::features::stub("audio")
}

#[cfg(feature = "audio-opus")]
pub use live::{feature, subscribe, AudioPacket, AudioTrack};

#[cfg(feature = "audio-opus")]
mod live {
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use crossbeam_channel::{bounded, Receiver, Sender};
    // Everything that *produces* packets is Windows-only until Wave 9 brings
    // the other endpoints, so its imports and its constants are too. The hub
    // and the feature itself are portable.
    #[cfg(windows)]
    use crossbeam_channel::{RecvTimeoutError, TrySendError};

    use super::opus;
    use crate::ipc::AudioState;
    use crate::session::{Feature, FeatureStatus, SessionHandle};
    use crate::signal::messages::channel::{Channel, Control as ControlMessage};

    /// How often the endpoint is re-probed. A device enabled, unplugged or
    /// re-plugged mid-session shows up on the next `status` (which is itself on
    /// a two-second cadence), and the probe is a single COM call.
    #[cfg(windows)]
    const PROBE_INTERVAL: Duration = Duration::from_secs(2);

    /// Nothing reported yet — the probe has not run once.
    const UNKNOWN: u8 = 0;
    const OK: u8 = 1;
    const NO_ENDPOINT: u8 = 2;

    /// The most encoded frames that may wait for a peer: 500 ms at 10 ms
    /// frames. A viewer whose peer has stopped draining gets a refused send
    /// rather than a growing queue — half a second of audio already ahead of
    /// the picture is worse than a gap, and the frame clock keeps the
    /// timestamps contiguous across one either way.
    const TRACK_DEPTH: usize = 50;

    /// One encoded 10 ms frame on its way to a viewer's RTP track.
    pub type AudioPacket = opus::Packet;

    /// The receiving end of one viewer's audio, handed to its `RtcPeer`.
    ///
    /// Bounded and lossy on purpose — see [`TRACK_DEPTH`]. Held by the peer,
    /// which is the only thing that knows when the viewer can take a packet.
    #[derive(Debug, Clone)]
    pub struct AudioTrack(Receiver<AudioPacket>);

    impl AudioTrack {
        /// The next packet, or `None` when there is nothing waiting or the
        /// feature has stopped. Never blocks.
        pub fn try_recv(&self) -> Option<AudioPacket> {
            self.0.try_recv().ok()
        }

        /// For a test or a fake source: the sending half of a track.
        pub fn channel() -> (Sender<AudioPacket>, Self) {
            let (tx, rx) = bounded(TRACK_DEPTH);
            (tx, Self(rx))
        }
    }

    /// Every viewer's track, as the capture thread sees them.
    ///
    /// A static, and deliberately: the `session::features` seam moves
    /// data-channel bytes and cannot carry media, so the track cannot come out
    /// of the [`Feature`]. One streamer process serves one session, so one hub
    /// — and the capture thread reaches it without the session thread having to
    /// be the one holding it.
    static VIEWERS: Mutex<Vec<Sender<AudioPacket>>> = Mutex::new(Vec::new());

    /// One viewer's audio, for `RtcPeer::set_audio_source`.
    ///
    /// Always hands back a track. A machine with no render endpoint, or one
    /// whose capture has not opened yet, simply never puts a packet on it —
    /// which is what the peer already does nothing about.
    pub fn subscribe() -> AudioTrack {
        let (tx, track) = AudioTrack::channel();
        viewers().push(tx);
        track
    }

    /// The hub. A panicking capture thread must not take audio out for the rest
    /// of the session, so a poisoned lock is taken as-is.
    fn viewers() -> std::sync::MutexGuard<'static, Vec<Sender<AudioPacket>>> {
        VIEWERS.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// One encoded frame to every viewer still listening.
    #[cfg(windows)]
    fn broadcast(rtp_48k: u64, payload: &[u8]) {
        viewers().retain(|tx| {
            match tx.try_send(AudioPacket {
                rtp_48k,
                payload: payload.to_vec(),
            }) {
                // The peer is gone: drop its track rather than encoding into a
                // channel nobody will ever read.
                Err(TrySendError::Disconnected(_)) => false,
                // Full is [`TRACK_DEPTH`]'s refusal. The frame is dropped, the
                // viewer stays, and the next timestamp is still contiguous.
                _ => true,
            }
        });
    }

    pub fn feature() -> Box<dyn Feature> {
        Box::new(Audio::default())
    }

    /// What the session thread and the capture thread share.
    #[derive(Debug)]
    struct Shared {
        /// UNKNOWN, not NO_ENDPOINT: the feature is built before the probe
        /// thread exists, and a machine that has not been asked must not be
        /// reported as one without audio.
        endpoint: AtomicU8,
        /// §5's `mute`, which a watcher may send. Read by the encode loop: it
        /// stops putting packets on the wire while the frame clock keeps
        /// running, so the timestamps on the other side of an unmute are still
        /// contiguous. The browser mutes its own element on the same click,
        /// which is what makes mute sound instant.
        muted: AtomicBool,
    }

    impl Default for Shared {
        fn default() -> Self {
            Self {
                endpoint: AtomicU8::new(UNKNOWN),
                muted: AtomicBool::new(false),
            }
        }
    }

    /// The `audio` feature.
    ///
    /// Everything that blocks runs on its own thread and reaches the session
    /// thread through [`Shared`], which is the rule `session::features` sets
    /// for every feature.
    #[derive(Default)]
    struct Audio {
        shared: Arc<Shared>,
        stop: Option<Sender<()>>,
        worker: Option<JoinHandle<()>>,
    }

    impl Feature for Audio {
        fn name(&self) -> &'static str {
            "audio"
        }

        fn start(&mut self, _session: &SessionHandle) -> anyhow::Result<()> {
            let (stop_tx, stop_rx) = bounded(1);
            let shared = Arc::clone(&self.shared);
            self.stop = Some(stop_tx);
            self.worker = Some(
                std::thread::Builder::new()
                    .name("swoop-audio".to_owned())
                    .spawn(move || capture(&shared, &stop_rx))?,
            );
            Ok(())
        }

        fn stop(&mut self) {
            // Dropping the sender is the signal as well, so a worker whose
            // send races a panic still wakes up.
            drop(self.stop.take());
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
            // The peers are being torn down with the session; a track left
            // here would outlive the capture that feeds it.
            viewers().clear();
        }

        fn on_message(&mut self, channel: Channel, _ctl: bool, payload: &[u8]) -> anyhow::Result<()> {
            // Not gated on `ctl`: §5 lists `mute` among the messages a watcher
            // may send, and a viewer who cannot silence the machine they are
            // watching will reach for the system volume instead.
            if channel != Channel::SwoopControl {
                return Ok(());
            }
            // `swoop-control` also carries clipboard traffic and control
            // messages other features own; not ours is not an error.
            let Ok(ControlMessage::Mute { on }) = serde_json::from_slice::<ControlMessage>(payload)
            else {
                return Ok(());
            };
            self.shared.muted.store(on, Ordering::Relaxed);
            ::log::info!("swoop: host audio {}", if on { "muted" } else { "unmuted" });
            Ok(())
        }

        fn status(&mut self, out: &mut FeatureStatus) {
            // Left alone until the probe has actually run: `None` is absent
            // from the wire, and an unprobed machine must not be reported as
            // one with no endpoint.
            out.audio = match self.shared.endpoint.load(Ordering::Relaxed) {
                OK => Some(AudioState::Ok),
                NO_ENDPOINT => Some(AudioState::NoEndpoint),
                _ => return,
            };
        }
    }

    /// The worker: probe the render endpoint, capture what it is playing,
    /// encode on the frame clock, and hand the frames to every viewer — until
    /// told to stop.
    ///
    /// The tick is the frame length while a capture is running and
    /// [`PROBE_INTERVAL`] while there is nothing to read, so an idle machine
    /// wakes twice a second rather than a hundred times.
    #[cfg(windows)]
    fn capture(shared: &Shared, stop: &Receiver<()>) {
        let _com = match ComThread::enter() {
            Ok(com) => com,
            Err(e) => {
                ::log::error!("swoop: audio thread could not initialize com: {e}");
                return;
            }
        };

        let mut stream: Option<Stream> = None;
        // One log line per device, not one every probe: opening fails for the
        // whole life of a machine whose audio stack is unhappy.
        let mut reported = false;
        let mut next_probe = std::time::Instant::now();
        // When audio first started on this session. Each device opened after
        // that starts its timestamps where this clock has got to, so a viewer
        // whose machine changes endpoint mid-session sees the RTP clock jump
        // forward by the outage rather than backwards to zero.
        let mut clock: Option<std::time::Instant> = None;

        loop {
            let now = std::time::Instant::now();
            if now >= next_probe {
                next_probe = now + PROBE_INTERVAL;
                let found = probe();
                shared.endpoint.store(found, Ordering::Relaxed);
                if found != OK {
                    // The endpoint went away under a running capture, or was
                    // never there. Either way the next one is a fresh open.
                    stream = None;
                    reported = false;
                }
            }

            if stream.is_none() && shared.endpoint.load(Ordering::Relaxed) == OK {
                let elapsed = clock.get_or_insert_with(std::time::Instant::now).elapsed();
                match Stream::open(rtp_at(elapsed)) {
                    Ok(opened) => {
                        ::log::info!("swoop: host audio capture is running");
                        stream = Some(opened);
                        reported = false;
                    }
                    Err(e) => {
                        if !reported {
                            ::log::error!("swoop: host audio is not capturing: {e:#}");
                            reported = true;
                        }
                    }
                }
            }

            let tick = match stream.as_mut() {
                Some(running) => match running.pump(&shared.muted) {
                    Ok(()) => opus::FRAME,
                    Err(e) => {
                        // A device that went away mid-session: drop it and let
                        // the probe find whatever replaced it.
                        ::log::warn!("swoop: host audio capture stopped: {e:#}");
                        stream = None;
                        PROBE_INTERVAL
                    }
                },
                None => PROBE_INTERVAL,
            };

            match stop.recv_timeout(tick) {
                Err(RecvTimeoutError::Timeout) => continue,
                _ => return,
            }
        }
    }

    /// Wave 9 brings the macOS and Linux endpoints. Until then the thread only
    /// waits to be told to stop, and `status` says nothing about audio rather
    /// than claiming a machine has none.
    #[cfg(not(windows))]
    fn capture(_shared: &Shared, stop: &Receiver<()>) {
        let _ = stop.recv();
    }

    /// Where the 48 kHz clock stands after `elapsed`, rounded down to a whole
    /// frame so a new stream's first timestamp is still on the frame grid.
    #[cfg(windows)]
    fn rtp_at(elapsed: Duration) -> u64 {
        elapsed.as_millis() as u64 / u64::from(opus::FRAME_MS) * opus::FRAME_RTP_TICKS
    }

    #[cfg(windows)]
    fn probe() -> u8 {
        if super::wasapi::render_endpoint_present() {
            OK
        } else {
            NO_ENDPOINT
        }
    }

    /// One running capture: the device, the clock, and the encoder behind it.
    #[cfg(windows)]
    struct Stream {
        loopback: super::wasapi::Loopback,
        encoder: Box<dyn opus::Encoder>,
        timeline: opus::Timeline,
        /// The clock [`opus::Timeline::fill_to`] is measured against. It starts
        /// with the capture, so a device that opened late does not owe the
        /// timeline the silence before it existed.
        started: std::time::Instant,
        /// What the session's clock had already reached when this device
        /// opened; the timeline counts from zero and this is added on the way
        /// out.
        rtp_base: u64,
        pcm: Vec<i16>,
        frame: Vec<i16>,
        payload: Vec<u8>,
    }

    #[cfg(windows)]
    impl Stream {
        fn open(rtp_base: u64) -> anyhow::Result<Self> {
            Ok(Self {
                loopback: super::wasapi::Loopback::open()?,
                encoder: opus::encoder()?,
                timeline: opus::Timeline::new(),
                started: std::time::Instant::now(),
                rtp_base,
                pcm: Vec::new(),
                frame: vec![0i16; opus::FRAME_SAMPLES],
                payload: Vec::new(),
            })
        }

        /// One turn: drain the device, top the clock up, and encode whatever
        /// whole frames that makes.
        fn pump(&mut self, muted: &AtomicBool) -> anyhow::Result<()> {
            self.pcm.clear();
            self.loopback.drain(&mut self.pcm)?;
            self.timeline.push(&self.pcm);
            // After the push, never before: the samples the device just gave us
            // are what the clock is allowed to count.
            self.timeline.fill_to(self.started.elapsed());

            while let Some(rtp_48k) = self.timeline.next_frame(&mut self.frame) {
                // Muted: the clock advanced, and nothing goes on the wire. The
                // frame is not encoded either — a packet nobody will hear is
                // the one place there is nothing to keep warm.
                if muted.load(Ordering::Relaxed) {
                    continue;
                }
                self.encoder.encode(&self.frame, &mut self.payload)?;
                broadcast(self.rtp_base + rtp_48k, &self.payload);
            }
            Ok(())
        }
    }

    /// COM for the length of one thread, uninitialized on the way out.
    #[cfg(windows)]
    struct ComThread;

    #[cfg(windows)]
    impl ComThread {
        fn enter() -> windows::core::Result<Self> {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
            // MTA: this thread has no message pump, and the audio interfaces
            // are all free-threaded.
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok()?;
            Ok(Self)
        }
    }

    #[cfg(windows)]
    impl Drop for ComThread {
        fn drop(&mut self) {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::bundle::Indicator;

        fn handle() -> SessionHandle {
            SessionHandle {
                sid: "sid_test".to_owned(),
                indicator: Indicator::Banner,
                ctl: false,
                source: (1920, 1080),
            }
        }

        #[test]
        fn nothing_is_reported_before_the_probe_has_run() {
            let mut audio = Audio::default();
            assert_eq!(audio.shared.endpoint.load(Ordering::Relaxed), UNKNOWN);
            let mut status = FeatureStatus::default();
            audio.status(&mut status);
            assert_eq!(status.audio, None, "an unprobed machine claims nothing");
        }

        #[test]
        fn a_machine_with_no_render_endpoint_reports_it_rather_than_staying_silent() {
            let mut audio = Audio::default();
            audio.shared.endpoint.store(NO_ENDPOINT, Ordering::Relaxed);
            let mut status = FeatureStatus::default();
            audio.status(&mut status);
            assert_eq!(status.audio, Some(AudioState::NoEndpoint));

            audio.shared.endpoint.store(OK, Ordering::Relaxed);
            audio.status(&mut status);
            assert_eq!(status.audio, Some(AudioState::Ok));
        }

        /// A watcher may mute, so the verdict is not consulted — and a message
        /// that is not ours leaves the flag where it was.
        #[test]
        fn mute_is_honoured_without_control_and_nothing_else_moves_it() {
            let mut audio = Audio::default();
            audio
                .on_message(Channel::SwoopControl, false, br#"{"t":"mute","on":true}"#)
                .expect("mute is not an error");
            assert!(audio.shared.muted.load(Ordering::Relaxed));

            for payload in [
                br#"{"t":"idr"}"#.as_slice(),
                br#"{"t":"not-yours"}"#.as_slice(),
                b"not json at all".as_slice(),
            ] {
                audio
                    .on_message(Channel::SwoopControl, true, payload)
                    .expect("someone else's message is not an error");
                assert!(audio.shared.muted.load(Ordering::Relaxed), "{payload:?} moved mute");
            }

            // The same payload on another channel is not this feature's.
            audio
                .on_message(Channel::SwoopInput, true, br#"{"t":"mute","on":false}"#)
                .expect("not an error");
            assert!(audio.shared.muted.load(Ordering::Relaxed));

            audio
                .on_message(Channel::SwoopControl, false, br#"{"t":"mute","on":false}"#)
                .expect("unmute is not an error");
            assert!(!audio.shared.muted.load(Ordering::Relaxed));
        }

        /// The session starts every feature before a viewer exists and stops
        /// them in reverse; neither may block or fail on a machine with no
        /// audio at all.
        #[test]
        fn starts_and_stops_on_any_machine() {
            let mut audio = Audio::default();
            audio.start(&handle()).expect("start");
            audio.stop();
            assert!(audio.worker.is_none(), "the worker was joined");
        }

        #[test]
        fn the_track_refuses_rather_than_growing_a_queue() {
            let (tx, track) = AudioTrack::channel();
            for rtp in 0..TRACK_DEPTH as u64 {
                assert!(tx
                    .try_send(AudioPacket {
                        rtp_48k: rtp * opus::FRAME_RTP_TICKS,
                        payload: vec![0u8; 120],
                    })
                    .is_ok());
            }
            // Full: half a second of audio nobody took. The producer refuses
            // rather than blocking the capture thread.
            assert!(tx
                .try_send(AudioPacket {
                    rtp_48k: 0,
                    payload: Vec::new()
                })
                .is_err());
            assert_eq!(track.try_recv().map(|p| p.rtp_48k), Some(0));
        }

        /// A viewer that joins after the capture is running still gets a track,
        /// and one that leaves is dropped rather than encoded into forever.
        /// (Windows, with `broadcast`, until Wave 9 gives the other platforms a
        /// capture that feeds it.)
        #[cfg(windows)]
        #[test]
        fn a_departed_viewer_is_dropped_from_the_hub() {
            viewers().clear();
            let track = subscribe();
            broadcast(0, b"frame");
            assert_eq!(track.try_recv().map(|p| p.payload), Some(b"frame".to_vec()));

            drop(track);
            broadcast(opus::FRAME_RTP_TICKS, b"frame");
            assert!(viewers().is_empty(), "the peer is gone and so is its track");
        }

        /// A device that opens 30 s into a session picks the clock up where it
        /// stands, on the frame grid — never back at zero, which is the one
        /// direction an RTP timestamp may not go.
        #[cfg(windows)]
        #[test]
        fn a_replacement_device_starts_where_the_session_clock_got_to() {
            assert_eq!(rtp_at(Duration::ZERO), 0);
            assert_eq!(rtp_at(Duration::from_millis(5)), 0, "half a frame is no frame");
            assert_eq!(rtp_at(opus::FRAME), opus::FRAME_RTP_TICKS);
            assert_eq!(rtp_at(Duration::from_secs(30)), 3_000 * opus::FRAME_RTP_TICKS);
        }

        /// Hardware, and it records whatever this machine is playing — see the
        /// module doc for the invocation and what it listens to.
        #[test]
        #[ignore]
        fn the_whole_path_encodes_what_this_machine_is_playing() {
            use std::time::Instant;

            viewers().clear();
            let track = subscribe();
            let mut audio = Audio::default();
            audio.start(&handle()).expect("start");

            // Drained as it arrives: the track holds half a second, and this
            // runs for two.
            let deadline = Instant::now() + Duration::from_secs(2);
            let (mut packets, mut bytes, mut last) = (0u64, 0usize, None);
            while Instant::now() < deadline {
                while let Some(packet) = track.try_recv() {
                    if let Some(previous) = last {
                        assert_eq!(
                            packet.rtp_48k - previous,
                            opus::FRAME_RTP_TICKS,
                            "the capture moved the clock"
                        );
                    }
                    last = Some(packet.rtp_48k);
                    packets += 1;
                    bytes += packet.payload.len();
                }
                std::thread::sleep(opus::FRAME);
            }
            audio.stop();

            println!(
                "{packets} frames, {bytes} bytes, ~{} kbps",
                bytes * 8 / 1000 / 2
            );
            assert!(packets > 100, "{packets} frames in two seconds is not audio");
        }
    }
}
