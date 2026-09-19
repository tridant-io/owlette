//! System audio capture (WASAPI loopback) and the Opus path.
//!
//! # The shape, and why the pieces sit where they do
//!
//! - [`opus`] is portable: the wire parameters §3's `audio` m-line carries, the
//!   10 ms frame clock that keeps timestamps contiguous across a device gap,
//!   and the encoder seam.
//! - [`wasapi`] is the Win32 half. It reports the render endpoint; the loopback
//!   client itself is blocked on two `windows` crate features the manifest does
//!   not carry — read that module's head before assuming it is unfinished.
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
//! [`crate::session::Outbox`].
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
pub use live::{feature, AudioPacket, AudioTrack};

#[cfg(feature = "audio-opus")]
mod live {
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::Arc;
    use std::thread::JoinHandle;
    use std::time::Duration;

    use crossbeam_channel::{bounded, Receiver, RecvTimeoutError, Sender};

    use super::opus;
    use crate::ipc::AudioState;
    use crate::session::{Feature, FeatureStatus, SessionHandle};
    use crate::signal::messages::channel::{Channel, Control as ControlMessage};

    /// How often the endpoint is re-probed. A device enabled, unplugged or
    /// re-plugged mid-session shows up on the next `status` (which is itself on
    /// a two-second cadence), and the probe is a single COM call.
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

    pub fn feature() -> Box<dyn Feature> {
        Box::new(Audio::default())
    }

    /// The `audio` feature.
    ///
    /// Everything that blocks runs on its own thread and reaches the session
    /// thread through the shared state below, which is the rule
    /// `session::features` sets for every feature.
    struct Audio {
        endpoint: Arc<AtomicU8>,
        /// §5's `mute`, which a watcher may send. Read by the encode loop the
        /// moment it exists: it stops putting packets on the wire while the
        /// frame clock keeps running, so the timestamps on the other side of
        /// an unmute are still contiguous. The browser mutes its own element
        /// on the same click, which is what makes mute sound instant.
        muted: Arc<AtomicBool>,
        stop: Option<Sender<()>>,
        worker: Option<JoinHandle<()>>,
    }

    impl Default for Audio {
        fn default() -> Self {
            Self {
                // UNKNOWN, not NO_ENDPOINT: the feature is built before the
                // probe thread exists, and a machine that has not been asked
                // must not be reported as one without audio.
                endpoint: Arc::new(AtomicU8::new(UNKNOWN)),
                muted: Arc::new(AtomicBool::new(false)),
                stop: None,
                worker: None,
            }
        }
    }

    impl Feature for Audio {
        fn name(&self) -> &'static str {
            "audio"
        }

        fn start(&mut self, _session: &SessionHandle) -> anyhow::Result<()> {
            let (stop_tx, stop_rx) = bounded(1);
            let endpoint = Arc::clone(&self.endpoint);
            self.stop = Some(stop_tx);
            self.worker = Some(
                std::thread::Builder::new()
                    .name("swoop-audio".to_owned())
                    .spawn(move || watch_endpoint(&endpoint, &stop_rx))?,
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
            self.muted.store(on, Ordering::Relaxed);
            ::log::info!("swoop: host audio {}", if on { "muted" } else { "unmuted" });
            Ok(())
        }

        fn status(&mut self, out: &mut FeatureStatus) {
            // Left alone until the probe has actually run: `None` is absent
            // from the wire, and an unprobed machine must not be reported as
            // one with no endpoint.
            out.audio = match self.endpoint.load(Ordering::Relaxed) {
                OK => Some(AudioState::Ok),
                NO_ENDPOINT => Some(AudioState::NoEndpoint),
                _ => return,
            };
        }
    }

    /// The worker: probe the render endpoint until told to stop.
    ///
    /// This is where the loopback capture loop belongs — open the client,
    /// drive [`opus::Timeline`] on a 10 ms clock, encode, and push into the
    /// track. `wasapi`'s head documents the two `windows` crate features that
    /// have to land before the client can be activated at all.
    fn watch_endpoint(endpoint: &AtomicU8, stop: &Receiver<()>) {
        #[cfg(windows)]
        let _com = match ComThread::enter() {
            Ok(com) => com,
            Err(e) => {
                ::log::error!("swoop: audio thread could not initialize com: {e}");
                return;
            }
        };
        loop {
            endpoint.store(probe(), Ordering::Relaxed);
            match stop.recv_timeout(PROBE_INTERVAL) {
                Err(RecvTimeoutError::Timeout) => continue,
                _ => return,
            }
        }
    }

    #[cfg(windows)]
    fn probe() -> u8 {
        if super::wasapi::render_endpoint_present() {
            OK
        } else {
            NO_ENDPOINT
        }
    }

    /// Wave 9 brings the macOS and Linux endpoints; until then a non-Windows
    /// host says nothing rather than claiming a machine has no audio.
    #[cfg(not(windows))]
    fn probe() -> u8 {
        UNKNOWN
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
            assert_eq!(audio.endpoint.load(Ordering::Relaxed), UNKNOWN);
            let mut status = FeatureStatus::default();
            audio.status(&mut status);
            assert_eq!(status.audio, None, "an unprobed machine claims nothing");
        }

        #[test]
        fn a_machine_with_no_render_endpoint_reports_it_rather_than_staying_silent() {
            let mut audio = Audio::default();
            audio.endpoint.store(NO_ENDPOINT, Ordering::Relaxed);
            let mut status = FeatureStatus::default();
            audio.status(&mut status);
            assert_eq!(status.audio, Some(AudioState::NoEndpoint));

            audio.endpoint.store(OK, Ordering::Relaxed);
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
            assert!(audio.muted.load(Ordering::Relaxed));

            for payload in [
                br#"{"t":"idr"}"#.as_slice(),
                br#"{"t":"not-yours"}"#.as_slice(),
                b"not json at all".as_slice(),
            ] {
                audio
                    .on_message(Channel::SwoopControl, true, payload)
                    .expect("someone else's message is not an error");
                assert!(audio.muted.load(Ordering::Relaxed), "{payload:?} moved mute");
            }

            // The same payload on another channel is not this feature's.
            audio
                .on_message(Channel::SwoopInput, true, br#"{"t":"mute","on":false}"#)
                .expect("not an error");
            assert!(audio.muted.load(Ordering::Relaxed));

            audio
                .on_message(Channel::SwoopControl, false, br#"{"t":"mute","on":false}"#)
                .expect("unmute is not an error");
            assert!(!audio.muted.load(Ordering::Relaxed));
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
    }
}
