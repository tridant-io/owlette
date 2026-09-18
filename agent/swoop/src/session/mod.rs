//! The session loop: the `run` verb, end to end, for exactly one viewer.
//!
//! This is the assembly point. Every module below it is already written and
//! tested on its own; nothing here re-implements any of them, and where one of
//! them documents a call site (`Duplication::next_frame_with`,
//! `Governor::on_report`) this file is what that comment was written for.
//!
//! # Threads, and why there are four
//!
//! Desktop Duplication is vsync-locked and paces its own thread by blocking in
//! `AcquireNextFrame` (spike 0.8), str0m wants a thread that owns its socket,
//! `SendInput` reaches only the desktop its *calling thread* is attached to,
//! and a read on stdin blocks until the service writes. Those are four
//! different blocking disciplines, so they are four threads:
//!
//! - **session** (this thread) — the signaling socket, the peer connection, the
//!   governor, and every stdout event. The only writer of stdout.
//! - **capture** — duplication, the cursor observer, the downscaler and the
//!   encoder. Everything that touches a GPU texture stays here, because a
//!   `Frame` handle is only valid until the next acquire and `Duplication` is
//!   not `Send`. Encoded bytes leave over a bounded channel.
//! - **input** — its own `DesktopWatcher` and the `SendInput` injector, plus
//!   the per-viewer held-key set. Injection is off the capture thread so a key
//!   press is not queued behind an 8 ms acquire and an 8 ms encode.
//! - **stdin** — control lines. EOF means the service is gone (§6).
//!
//! # The four `release_all` triggers (input/mod.rs)
//!
//! Stuck keys are the top user-visible bug of every remote-desktop product, so
//! all four are wired: **viewer disconnect** and **idle timeout** send
//! [`ToInput::ReleaseAll`] from here, **desktop switch** is noticed by the
//! input thread's own watcher and released there, and **viewer switch** cannot
//! happen in a session that admits one viewer — the second joiner is turned
//! away rather than swapped in (Task 8.1 owns multi-viewer).
//!
//! # The clock
//!
//! §4's three stamps and `pong`'s `hostUs` are **microseconds since
//! `streamerEpoch`**, all four produced by [`HostClock`] from the same anchor.
//! The browser computes `clockOffsetUs = hostUs − viewerUs`
//! (`web/lib/swoop/feedback.ts`) and the governor undoes it with
//! `owd = tArrivalUs + clockOffsetUs − sendUs`, so the two have to share an
//! epoch or the governor inverts: it would cut on a healthy link and hold on a
//! congested one, with nothing failing.
//!
//! # Rotation
//!
//! Nothing in this pipeline rotates a frame — `gpu::scale` leaves the video
//! processor's rotation off and says so, and Task 6.4 owns applying it. The
//! browser therefore sees the **un-rotated texture**, so [`PointerSpace`] and
//! [`OutputGeometry`] are both built with the output's real rotation and the
//! rotation is applied in the coordinate transform instead of to the picture.
//! On a non-rotated monitor the two choices are identical, which is exactly why
//! it is written down here.
//!
//! # Hardware test (manual, `#[ignore]`d)
//!
//! The picture half — duplication, downscale, encoder — on this box's real
//! desktop, driven by the same capture thread the session spawns:
//!
//! ```text
//! cd agent/swoop
//! cargo test --lib session::host::tests::end_to_end_picture -- --ignored --nocapture
//! ```
//!
//! Expected on the dev box (RTX 2080 Ti, two monitors): `swoop capture:
//! (1920, 1080) -> (1920, 1080) hevc, 180 frames (1 irap, 3074722 bytes),
//! 227 cpos, 28 cshape` — three seconds at 60 fps, **exactly one** IRAP
//! (a second one means the startup rebuild came back), and a cursor stream
//! that answers the pointer moves the test injects.
//!
//! # The whole `run` verb (manual, needs a room)
//!
//! The other half cannot be a unit test: it needs a bundle minted by the api
//! for this machine and a reachable signaling room, and the bundle is never
//! written to disk. With one on stdin:
//!
//! ```text
//! cd agent/swoop
//! cargo build --release
//! echo '<the bundle, one line>' | target/release/owlette-swoop.exe run
//! ```
//!
//! Expected: a `ready` line at once, then `viewer_joined` when a browser opens
//! the swoop page for this machine, then `status` every two seconds. Ctrl-C, or
//! `{"type":"kill"}` on stdin, ends it with `exiting` and code 0.

pub mod features;
pub mod quality;
pub mod tiers;

use crate::encode::{Codec, CodecCaps};
use crate::gpu::scale::Limits;

/// A host feature that lives for the length of a session.
///
/// Task 5.1 widens `start` to take the session handle; until there is a session
/// to hand out, a stub takes nothing. Implementations must not block — every
/// one of them runs on the session thread.
pub trait Feature: Send {
    /// Stable name. It is what the `status` event reports and what the tests
    /// pin, so it is spelled the same as the module.
    fn name(&self) -> &'static str;

    fn start(&mut self) -> anyhow::Result<()>;

    fn stop(&mut self);
}

/// The wire spelling of a codec, which is **not** `Codec`'s serde spelling:
/// `web/lib/swoop/protocol.ts` and the `swoop-meta` header both say `hevc`,
/// and so do the golden pipe vectors.
pub fn codec_wire_name(codec: Codec) -> &'static str {
    match codec {
        Codec::H265 => "hevc",
        Codec::H264 => "h264",
    }
}

/// The codec for one viewer: the host's preference order, narrowed to what the
/// browser's offer actually carries.
///
/// A sniff of the offer rather than a capability message, because the offer is
/// the only statement of decoder support that arrives before the answer has to
/// name exactly one codec (`PeerConfig::codec`) — and an answer that named a
/// codec the browser did not offer would negotiate a payload type nothing can
/// decode.
pub fn pick_codec(offer_sdp: &str, available: &[Codec]) -> Option<Codec> {
    let offered = offer_sdp.to_ascii_lowercase();
    // `Codec`'s declaration order is plan.md D5's preference order.
    for codec in [Codec::H265, Codec::H264] {
        if !available.contains(&codec) {
            continue;
        }
        let token = match codec {
            Codec::H265 => "h265",
            Codec::H264 => "h264",
        };
        if offered.contains(token) {
            return Some(codec);
        }
    }
    None
}

/// This backend's ceiling for one codec. Both axes independently, because NVENC
/// allows 4096 for H.264 and 8192 for HEVC while AMF caps both at 4096.
pub fn limits_for(caps: &[CodecCaps], codec: Codec) -> Option<Limits> {
    caps.iter().find(|c| c.codec == codec).map(|c| Limits {
        max_width: c.max_width,
        max_height: c.max_height,
    })
}

#[cfg(windows)]
pub use host::run;

#[cfg(windows)]
mod host {
    use std::io::{self, BufRead};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError};
    use windows::Win32::System::Performance::QueryPerformanceCounter;

    use super::{codec_wire_name, limits_for, pick_codec};
    use crate::bundle::{Bundle, Indicator, TimeAnchor};
    use crate::capture::{
        self, DesktopWatcher, Duplication, OutputInfo, RebuildSignal, Source, ACQUIRE_TIMEOUT_MS,
    };
    use crate::cursor::{self, CursorTracker, OutputGeometry, PointerReader};
    use crate::encode::{BackendCaps, Codec, CodecCaps, EncodedFrame, Encoder, EncoderConfig};
    use crate::gpu::scale::{self, Downscaler, Plan};
    use crate::input::{Injector, PointerSpace, SendInputInjector, ViewerInput};
    use crate::ipc::{self, Control, Event, Exit, ExitReason, LeftReason, MediaPath};
    use crate::signal::client::{Effect, SignalTransport};
    use crate::signal::messages::channel::{
        self, Channel, Control as ControlMessage, Feedback, Input as InputMessage,
    };
    use crate::signal::messages::Message;
    use crate::signal::{Handshake, Reaction, RetryPolicy, RoomSocket, SignalClient};
    use crate::transport::framing::{flags, FrameCodec, FrameHeader, FrameSequencer, FrameStamps};
    use crate::transport::governor::{Governor, GovernorConfig};
    use crate::transport::rtc::{qpc_hz, PeerConfig, PeerEvent, PeerState, RtcPeer};
    use crate::transport::VideoSink;

    /// §6: the streamer lingers about a minute after the last viewer leaves,
    /// then exits 0. The same timer covers a session nobody ever joins.
    const LINGER: Duration = Duration::from_secs(60);

    /// One turn of the session loop. It is the peer's socket-read timeout, so
    /// it is also the worst case an encoded frame waits in the channel before
    /// it is sent — small enough not to matter next to an 8 ms acquire, large
    /// enough that an idle session is not a spin.
    const TICK: Duration = Duration::from_millis(2);

    /// How often the governor evaluates. The viewer reports `fb` at 2 Hz and
    /// `stats` at 1 Hz, so anything faster only re-reads the same window.
    const REPORT_INTERVAL: Duration = Duration::from_millis(500);

    /// How often the `status` event goes to the service.
    const STATUS_INTERVAL: Duration = Duration::from_secs(2);

    /// §4: idr requests are coalesced by the host with a 250–500 ms cooldown, so
    /// a browser may ask as often as it likes.
    const IDR_COOLDOWN: Duration = Duration::from_millis(250);

    /// The starting CBR target, until the quality menu (Task 6.5) can move it.
    /// 20 Mbps is what the bake-off measured arm B at end to end.
    const DEFAULT_BITRATE_BPS: u32 = 20_000_000;

    /// Desktop Duplication is vsync-locked at the panel's rate; 60 is what the
    /// encoder's rate control is sized for.
    const TARGET_FPS: u32 = 60;

    /// Capture → session, and it is bounded because the whole point is that a
    /// session thread which fell behind drops a frame rather than stalling
    /// capture for it. Sized for the cursor messages, which outnumber frames:
    /// the session drains the channel every [`TICK`], so a frame that cannot
    /// get in means the session is already in trouble — and the next frame is
    /// then an IRAP, so the gap cannot dangle.
    const WORKER_QUEUE: usize = 64;

    /// How long to wait for the capture thread's first word. Its own
    /// re-duplication deadline is 10 s, so this only has to outlast that.
    const CAPTURE_OPEN_TIMEOUT: Duration = Duration::from_secs(15);

    // ------------------------------------------------------------- clock ---

    fn qpc_now() -> i64 {
        let mut ticks = 0i64;
        // SAFETY: writes one i64. QueryPerformanceCounter cannot fail on any
        // Windows this binary runs on, and a zero is a timestamp, not a crash.
        let _ = unsafe { QueryPerformanceCounter(&mut ticks) };
        ticks
    }

    /// QPC ticks → §4's microseconds since `streamerEpoch`.
    ///
    /// The base is read once from the bundle's time anchor, so it carries the
    /// api's clock and never the kiosk's. A second of error in it is a constant
    /// bias shared by every stamp and by `pong`, which is precisely what both
    /// consumers cancel out: the governor subtracts against a window minimum
    /// and the browser subtracts `hostUs − viewerUs`.
    #[derive(Debug, Clone, Copy)]
    struct HostClock {
        hz: i64,
        base_qpc: i64,
        base_us: i64,
    }

    impl HostClock {
        fn new(hz: i64, anchor: TimeAnchor, streamer_epoch: i64) -> Self {
            Self {
                hz: hz.max(1),
                base_qpc: qpc_now(),
                base_us: anchor
                    .now_unix()
                    .saturating_mul(1_000_000)
                    .saturating_sub(streamer_epoch)
                    .max(0),
            }
        }

        fn us(&self, qpc: i64) -> u64 {
            let delta = i128::from(qpc.saturating_sub(self.base_qpc));
            let us = i128::from(self.base_us) + delta * 1_000_000 / i128::from(self.hz);
            us.clamp(0, i128::from(u64::MAX)) as u64
        }

        fn now_us(&self) -> u64 {
            self.us(qpc_now())
        }
    }

    // ---------------------------------------------------------- messages ---

    /// Capture and input → session.
    enum FromWorker {
        /// The duplication is open. Carries the un-rotated texture size, which
        /// is what the encoder and the browser are sized from.
        Opened { width: u32, height: u32 },
        /// Capture or encode could not start at all.
        Failed(Exit),
        Frame(Box<EncodedFrame>),
        Cursor(channel::Cursor),
        /// The source's texture size changed under a rebuild; the session
        /// re-plans and re-sends [`ToCapture::Encode`].
        SourceSize { width: u32, height: u32 },
        /// The rate limit on one viewer's input, cumulative.
        InputDropped(u64),
    }

    /// Session → capture.
    enum ToCapture {
        /// Open (or re-open) the encoder. A codec, a target size or a device
        /// change is a **new encoder**, never a reconfigure.
        Encode {
            codec: Codec,
            width: u32,
            height: u32,
        },
        Idr,
        Bitrate(u32),
        /// Re-send the pointer whole. A viewer that has just arrived has an
        /// empty shape cache, and the tracker only emits on a change.
        CursorSnapshot,
        Stop,
    }

    /// Session → input.
    enum ToInput {
        Message(Box<InputMessage>),
        ReleaseAll,
        Stop,
    }

    /// Service → session, off stdin.
    enum FromService {
        Control(Control),
        /// EOF: §6 says the service is gone and the streamer exits 0.
        Eof,
    }

    // ------------------------------------------------------------- entry ---

    /// The `run` verb. `stdin` is the reader line 1 was taken from — the same
    /// one, because a fresh reader would lose whatever it had already buffered.
    pub fn run(bundle: Bundle, stdin: impl BufRead + Send + 'static) -> Exit {
        let sid = bundle.sid.clone();
        let (exit, reason) = drive(bundle, stdin);
        ::log::info!("swoop: exiting {} ({reason:?})", exit.code());
        let _ = ipc::emit(
            &mut io::stdout(),
            &Event::Exiting {
                sid,
                code: exit.code(),
                reason,
            },
        );
        exit
    }

    fn drive(bundle: Bundle, stdin: impl BufRead + Send + 'static) -> (Exit, ExitReason) {
        let started = Instant::now();
        let hz = match qpc_hz() {
            Ok(hz) => hz,
            Err(e) => {
                ::log::error!("swoop: no performance counter: {e}");
                return (Exit::Internal, ExitReason::Error);
            }
        };
        let clock = HostClock::new(hz, bundle.time_anchor(), bundle.streamer_epoch);

        // Locally before the network: a box that cannot capture or encode
        // should say so with 12 or 13 rather than after a room round trip.
        let outputs = match capture::enumerate_outputs() {
            Ok(outputs) if !outputs.is_empty() => outputs,
            Ok(_) => {
                ::log::error!("swoop: no attached output to duplicate");
                return (Exit::NoCaptureSource, ExitReason::Error);
            }
            Err(e) => {
                ::log::error!("swoop: could not enumerate outputs: {e}");
                return (Exit::NoCaptureSource, ExitReason::Error);
            }
        };
        let displays = outputs.len() as u32;
        let output = primary(&outputs).clone();

        let caps = encoder_caps();
        let codec_caps: Vec<CodecCaps> = caps.into_iter().flat_map(|backend| backend.codecs).collect();
        let codecs: Vec<Codec> = codec_caps.iter().map(|c| c.codec).collect();
        if codecs.is_empty() {
            ::log::error!("swoop: no encoder backend on this machine");
            return (Exit::NoEncoder, ExitReason::Error);
        }

        let stop = Arc::new(AtomicBool::new(false));
        let (worker_tx, worker_rx) = bounded::<FromWorker>(WORKER_QUEUE);
        let (capture_tx, capture_rx) = bounded::<ToCapture>(8);
        let (input_tx, input_rx) = bounded::<ToInput>(256);
        let (service_tx, service_rx) = bounded::<FromService>(8);

        let spawned = {
            let tx = worker_tx.clone();
            let stop = Arc::clone(&stop);
            let output = output.clone();
            thread::Builder::new()
                .name("swoop-capture".into())
                .spawn(move || capture_thread(output, clock, tx, capture_rx, stop))
        };
        let capture_handle = match spawned {
            Ok(handle) => handle,
            Err(e) => {
                ::log::error!("swoop: could not start the capture thread: {e}");
                return (Exit::Internal, ExitReason::Error);
            }
        };

        // The texture size, which on a rotated output is not the mode's. This
        // is also the last thing that can produce exit 12 or 13, so `ready`
        // goes out once it has arrived and **before** the room is dialled: a
        // machine whose relay is down should still tell the service what it can
        // do, and the failure it then reports is 14 and nothing else.
        let source = match worker_rx.recv_timeout(CAPTURE_OPEN_TIMEOUT) {
            Ok(FromWorker::Opened { width, height }) => (width, height),
            Ok(FromWorker::Failed(exit)) => {
                stop.store(true, Ordering::Relaxed);
                let _ = capture_handle.join();
                return (exit, ExitReason::Error);
            }
            _ => {
                ::log::error!("swoop: capture did not open within {CAPTURE_OPEN_TIMEOUT:?}");
                stop.store(true, Ordering::Relaxed);
                return (Exit::NoCaptureSource, ExitReason::Error);
            }
        };

        // The browser sees the un-rotated texture — nothing in this pipeline
        // rotates a frame — so the pointer space carries the output's real
        // rotation and applies it in the transform instead.
        let _ = ipc::emit(
            &mut io::stdout(),
            &Event::Ready {
                sid: bundle.sid.clone(),
                pid: std::process::id(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
                protocol_version: crate::bundle::SWOOP_PROTOCOL_VERSION,
                codecs: codecs.iter().map(|c| codec_wire_name(*c).to_owned()).collect(),
                displays,
            },
        );

        let input_handle = {
            let tx = worker_tx;
            let stop = Arc::clone(&stop);
            let space = PointerSpace::from_output(&output);
            thread::Builder::new()
                .name("swoop-input".into())
                .spawn(move || input_thread(space, tx, input_rx, stop))
                .ok()
        };

        thread::Builder::new()
            .name("swoop-stdin".into())
            .spawn(move || stdin_thread(stdin, service_tx))
            .ok();

        let outcome = connect_and_serve(
            &bundle,
            Wiring {
                clock,
                started,
                source,
                codecs,
                codec_caps,
                worker_rx,
                capture_tx: capture_tx.clone(),
                input_tx: input_tx.clone(),
                service_rx,
            },
        );

        let _ = capture_tx.send(ToCapture::Stop);
        let _ = input_tx.send(ToInput::Stop);
        stop.store(true, Ordering::Relaxed);
        let _ = capture_handle.join();
        if let Some(handle) = input_handle {
            let _ = handle.join();
        }
        outcome
    }

    /// Everything the session loop was handed rather than built.
    struct Wiring {
        clock: HostClock,
        started: Instant,
        source: (u32, u32),
        codecs: Vec<Codec>,
        codec_caps: Vec<CodecCaps>,
        worker_rx: Receiver<FromWorker>,
        capture_tx: Sender<ToCapture>,
        input_tx: Sender<ToInput>,
        service_rx: Receiver<FromService>,
    }

    fn connect_and_serve(bundle: &Bundle, w: Wiring) -> (Exit, ExitReason) {
        let handshake = match Handshake::new(bundle) {
            Ok(handshake) => handshake,
            Err(e) => {
                // The bundle parsed; its `signalUrl` is simply not this room's.
                // There is nothing to dial, which is what 14 means.
                ::log::error!("swoop: cannot dial the room: {e}");
                return (Exit::SignalingUnreachable, ExitReason::Error);
            }
        };

        let policy = RetryPolicy::default();
        let mut attempt = 0u32;
        let socket = loop {
            if attempt > 0 {
                thread::sleep(policy.delay(attempt, rand::random::<f64>()));
            }
            match RoomSocket::dial(&handshake) {
                Ok(socket) => break socket,
                Err(e) => {
                    // The distinction is the point: only the three auth words
                    // buy a re-mint, and the streamer holds no credential to
                    // re-mint with — so it names the reason and exits, and the
                    // agent respawns it with a fresh bundle.
                    if let Reaction::Remint(signal) = e.reaction() {
                        ::log::error!("swoop: the room refused this bundle ({signal})");
                        return (policy.exit(), ExitReason::Error);
                    }
                    attempt += 1;
                    ::log::warn!("swoop: dial attempt {attempt} failed ({e})");
                    if policy.exhausted(attempt) {
                        return (policy.exit(), ExitReason::Error);
                    }
                }
            }
        };

        let client = match SignalClient::from_bundle(bundle) {
            Ok(client) => client,
            Err(e) => {
                ::log::error!("swoop: bundle refused by the signaling client: {}", e.reason());
                return (Exit::BundleInvalid, ExitReason::Error);
            }
        };

        let mut live = Live {
            sid: bundle.sid.clone(),
            indicator: bundle.indicator,
            streamer_epoch: bundle.streamer_epoch,
            session_cap: Duration::from_secs(bundle.enablement.session_cap_seconds),
            client,
            socket,
            out: io::stdout(),
            peer: None,
            viewer: None,
            clock: w.clock,
            started: w.started,
            source: w.source,
            encoded: w.source,
            codecs: w.codecs,
            codec_caps: w.codec_caps,
            governor: Governor::new(GovernorConfig::new(DEFAULT_BITRATE_BPS)),
            sequencer: FrameSequencer::new(),
            capture_tx: w.capture_tx,
            input_tx: w.input_tx,
            worker_rx: w.worker_rx,
            service_rx: w.service_rx,
            bind_addr: local_bind_addr(),
            idle_since: Some(w.started),
            last_idr: None,
            last_report: w.started,
            last_status: w.started,
            frames_at_status: 0,
            input_dropped: 0,
            last_size: None,
        };

        // The browser offers as soon as it is in the room, and the relay drops
        // an offer sent into a room with no host. `host-ready` is the nudge
        // that makes it re-send the one it has (`web/lib/swoop/peer.ts`).
        let ready = live.client.host_ready(None);
        live.send(&ready);

        let mut registry = super::features::registry();
        for feature in registry.iter_mut() {
            if let Err(e) = feature.start() {
                ::log::warn!("swoop: feature {} did not start: {e}", feature.name());
            }
        }
        let outcome = live.serve();
        for feature in registry.iter_mut().rev() {
            feature.stop();
        }
        outcome
    }

    // -------------------------------------------------------------- live ---

    /// What the session thread owns.
    struct Live {
        sid: String,
        indicator: Indicator,
        /// §7's unix microseconds, echoed to the browser in `hello-host`. Not
        /// the same number as [`HostClock::base_us`], which is an offset from it.
        streamer_epoch: i64,
        session_cap: Duration,
        client: SignalClient,
        socket: RoomSocket,
        out: io::Stdout,
        peer: Option<RtcPeer>,
        viewer: Option<Viewer>,
        clock: HostClock,
        started: Instant,
        /// The captured texture's size.
        source: (u32, u32),
        /// What the encoder actually emits, after `gpu::scale::plan`.
        encoded: (u32, u32),
        codecs: Vec<Codec>,
        codec_caps: Vec<CodecCaps>,
        governor: Governor,
        sequencer: FrameSequencer,
        capture_tx: Sender<ToCapture>,
        input_tx: Sender<ToInput>,
        worker_rx: Receiver<FromWorker>,
        service_rx: Receiver<FromService>,
        bind_addr: SocketAddr,
        idle_since: Option<Instant>,
        last_idr: Option<Instant>,
        last_report: Instant,
        last_status: Instant,
        frames_at_status: u64,
        input_dropped: u64,
        /// The last encoded size put on the wire, so a change sets
        /// `RESOLUTION_CHANGED` exactly once.
        last_size: Option<(u16, u16)>,
    }

    /// One viewer, as the session knows it.
    struct Viewer {
        id: String,
        /// The host's own verdict, from the token it verified itself. False
        /// until the `lease` frame arrives — the room's word is not enough.
        ctl: bool,
        codec: Codec,
        announced: bool,
        hello_sent: bool,
    }

    impl Live {
        fn emit(&mut self, event: &Event) {
            if let Err(e) = ipc::emit(&mut self.out, event) {
                // A half-written line desynchronises the service's reader, and
                // a broken pipe means the service is already gone.
                ::log::error!("swoop: stdout event failed: {e}");
            }
        }

        fn send(&mut self, message: &Message) {
            match serde_json::to_string(message) {
                Ok(text) => {
                    if let Err(e) = self.socket.send_text(&text) {
                        ::log::warn!("swoop: {} not sent: {e}", message.type_name());
                    }
                }
                Err(e) => ::log::error!("swoop: could not encode {}: {e}", message.type_name()),
            }
        }

        fn serve(&mut self) -> (Exit, ExitReason) {
            loop {
                if let Some(end) = self.pump_service() {
                    return end;
                }
                if let Some(end) = self.pump_socket() {
                    return end;
                }
                if let Some(end) = self.pump_workers() {
                    return end;
                }
                if let Some(end) = self.pump_peer() {
                    return end;
                }
                self.tick();
                if let Some(end) = self.deadlines() {
                    return end;
                }
            }
        }

        /// stdin. EOF is the service going away, which §6 makes a clean exit.
        fn pump_service(&mut self) -> Option<(Exit, ExitReason)> {
            loop {
                match self.service_rx.try_recv() {
                    Ok(FromService::Control(Control::Kill { sid })) => {
                        if sid.as_deref().is_some_and(|s| s != self.sid) {
                            continue;
                        }
                        return Some(self.teardown(Exit::Ok, ExitReason::Kill, LeftReason::Kill));
                    }
                    // Task 6.1 owns ctrl+alt+del; nothing here asks for one, so
                    // an answer to a question we did not put is only a log line.
                    Ok(FromService::Control(Control::SasResult { ok })) => {
                        ::log::warn!("swoop: unexpected sas_result ok={ok}");
                    }
                    Ok(FromService::Eof) | Err(TryRecvError::Disconnected) => {
                        ::log::info!("swoop: stdin closed, the service is gone");
                        return Some(self.teardown(Exit::Ok, ExitReason::Kill, LeftReason::Kill));
                    }
                    Err(TryRecvError::Empty) => return None,
                }
            }
        }

        fn pump_socket(&mut self) -> Option<(Exit, ExitReason)> {
            // Bounded so a talkative room cannot starve capture of a turn.
            for _ in 0..32 {
                let Some(incoming) = self.socket.poll() else {
                    break;
                };
                let effects = match self.client.drive(&mut self.socket, &incoming) {
                    Ok(effects) => effects,
                    Err(e) => {
                        ::log::error!("swoop: signaling failed: {e}");
                        return Some(self.teardown(
                            Exit::SignalingUnreachable,
                            ExitReason::SignalLost,
                            LeftReason::Timeout,
                        ));
                    }
                };
                if let Some(end) = self.apply(effects) {
                    return Some(end);
                }
            }
            if !self.socket.is_open() {
                ::log::error!("swoop: the signaling socket closed");
                return Some(self.teardown(
                    Exit::SignalingUnreachable,
                    ExitReason::SignalLost,
                    LeftReason::Timeout,
                ));
            }
            None
        }

        fn apply(&mut self, effects: Vec<Effect>) -> Option<(Exit, ExitReason)> {
            for effect in effects {
                match effect {
                    Effect::Admitted { viewer, ctl } => self.on_admitted(viewer, ctl),
                    Effect::Offer { viewer, sdp, .. } => self.on_offer(&viewer, &sdp),
                    Effect::Candidate {
                        viewer, candidate, ..
                    } => {
                        if self.is_viewer(&viewer) {
                            if let Some(peer) = self.peer.as_mut() {
                                if let Err(e) = peer.add_remote_candidate(&candidate) {
                                    ::log::warn!("swoop: bad remote candidate: {e}");
                                }
                            }
                        }
                    }
                    Effect::ViewerGone { viewer, reason } => self.on_viewer_gone(&viewer, reason),
                    Effect::Denied(denial) => {
                        // Task 5.6 forwards these to the events route; until
                        // then the log is the audit trail.
                        ::log::warn!("swoop: viewer denied: {denial}");
                    }
                    Effect::RoomError { code, reaction } => {
                        ::log::warn!("swoop: room error {code} ({reaction:?})");
                    }
                    Effect::Refused(refusal) => {
                        ::log::warn!("swoop: refused a forwarded frame: {refusal}");
                    }
                    Effect::Send(message) => self.send(&message),
                    Effect::Exit(exit, reason) => {
                        return Some(self.teardown(exit, reason, LeftReason::Kill))
                    }
                }
            }
            None
        }

        fn is_viewer(&self, viewer: &str) -> bool {
            self.viewer.as_ref().is_some_and(|v| v.id == viewer)
        }

        fn on_admitted(&mut self, viewer: String, ctl: bool) {
            if self.viewer.is_some() {
                // Task 4.1 serves one viewer; 8.1 is where a second one gets a
                // peer instead of a bye.
                ::log::warn!("swoop: a second viewer joined and was turned away");
                let effects = self.client.end_viewer(&viewer, LeftReason::Bye);
                let _ = self.apply(effects);
                return;
            }
            ::log::info!("swoop: viewer {viewer} admitted (room ctl {ctl})");
            self.idle_since = None;
            self.viewer = Some(Viewer {
                id: viewer.clone(),
                // Watch-only until this host has verified the token itself.
                ctl: false,
                codec: Codec::H264,
                announced: false,
                hello_sent: false,
            });
            let ready = self.client.host_ready(Some(&viewer));
            self.send(&ready);
        }

        fn on_offer(&mut self, viewer: &str, sdp: &str) {
            if !self.is_viewer(viewer) {
                return;
            }
            if self.peer.is_none() {
                let Some(codec) = pick_codec(sdp, &self.codecs) else {
                    ::log::error!("swoop: the offer carries no codec this host can encode");
                    let effects = self.client.end_viewer(viewer, LeftReason::Bye);
                    let _ = self.apply(effects);
                    return;
                };
                let Some(limits) = limits_for(&self.codec_caps, codec) else {
                    ::log::error!("swoop: no limits for {codec:?}");
                    return;
                };
                let encoded = match scale::plan(self.source, limits) {
                    Plan::AsIs => self.source,
                    Plan::Downscale { width, height } => (width, height),
                    // Two 4K panels side by side is 7680 wide, over H.264's
                    // 4096: without the downscale a Mosaic box cannot stream at
                    // all, and a canvas this refuses is degenerate.
                    Plan::Refuse => {
                        ::log::error!(
                            "swoop: {}x{} has no legal encode size",
                            self.source.0,
                            self.source.1
                        );
                        let effects = self.client.end_viewer(viewer, LeftReason::Bye);
                        let _ = self.apply(effects);
                        return;
                    }
                };
                self.encoded = encoded;
                let peer = match RtcPeer::bind(PeerConfig {
                    bind_addr: self.bind_addr,
                    codec,
                    fps: TARGET_FPS,
                    bitrate_bps: self.governor.target_bps(),
                    qpc_hz: self.clock.hz,
                    // Off, and it stays off: str0m installs its leaky-bucket
                    // pacer with it, which the bake-off measured holding
                    // 1015 ms p50 of queue with every loss counter at zero.
                    enable_bwe: false,
                }) {
                    Ok(peer) => peer,
                    Err(e) => {
                        ::log::error!("swoop: could not bind the peer: {e}");
                        return;
                    }
                };
                self.peer = Some(peer);
                if let Some(v) = self.viewer.as_mut() {
                    v.codec = codec;
                }
                let fingerprint = self.peer.as_mut().expect("just bound").dtls_fingerprint();
                if let Err(e) = self.client.set_host_fingerprint(&fingerprint) {
                    ::log::error!("swoop: local dtls fingerprint unusable: {e}");
                    return;
                }
                let _ = self.capture_tx.send(ToCapture::Encode {
                    codec,
                    width: encoded.0,
                    height: encoded.1,
                });
                ::log::info!(
                    "swoop: {}x{} captured, {}x{} encoded as {}",
                    self.source.0,
                    self.source.1,
                    encoded.0,
                    encoded.1,
                    codec_wire_name(codec)
                );
            }

            // Every later offer is an ICE restart; str0m keeps its candidates.
            let answer = match self.peer.as_mut().expect("bound above").accept_offer(sdp) {
                Ok(answer) => answer,
                Err(e) => {
                    ::log::error!("swoop: could not answer the offer: {e}");
                    return;
                }
            };
            match self.client.answer(viewer, &answer) {
                Ok(message) => self.send(&message),
                Err(e) => ::log::error!("swoop: could not mac the answer: {e}"),
            }

            let announce = match self.viewer.as_mut() {
                Some(v) if !v.announced => {
                    v.announced = true;
                    Some((v.id.clone(), v.codec))
                }
                _ => None,
            };
            if let Some((id, codec)) = announce {
                // The room's claim, which is what the service is told; nothing
                // is *granted* on it until the host verifies the token itself.
                let ctl = self.client.room_control_claim(&id);
                let event = Event::ViewerJoined {
                    sid: self.sid.clone(),
                    viewer: id,
                    ctl,
                    codec: codec_wire_name(codec).to_owned(),
                };
                self.emit(&event);
            }
        }

        fn on_viewer_gone(&mut self, viewer: &str, reason: LeftReason) {
            if !self.is_viewer(viewer) {
                return;
            }
            // Trigger 1 and 2 of `release_all`: a viewer that dropped mid-chord
            // leaves those keys down on the machine forever otherwise.
            let _ = self.input_tx.send(ToInput::ReleaseAll);
            if let Some(peer) = self.peer.as_mut() {
                peer.disconnect();
            }
            self.peer = None;
            self.viewer = None;
            self.last_size = None;
            self.idle_since = Some(Instant::now());
            let event = Event::ViewerLeft {
                sid: self.sid.clone(),
                viewer: viewer.to_owned(),
                reason,
            };
            self.emit(&event);
        }

        fn pump_workers(&mut self) -> Option<(Exit, ExitReason)> {
            loop {
                match self.worker_rx.try_recv() {
                    Ok(FromWorker::Frame(frame)) => self.on_frame(*frame),
                    Ok(FromWorker::Cursor(message)) => self.write_json(Channel::SwoopCursor, &message),
                    Ok(FromWorker::SourceSize { width, height }) => {
                        self.source = (width, height);
                        self.replan();
                    }
                    Ok(FromWorker::InputDropped(dropped)) => self.input_dropped = dropped,
                    Ok(FromWorker::Failed(exit)) => {
                        ::log::error!("swoop: capture stopped: exit {}", exit.code());
                        return Some(self.teardown(exit, ExitReason::Error, LeftReason::Timeout));
                    }
                    Ok(FromWorker::Opened { .. }) => {}
                    Err(TryRecvError::Empty) => return None,
                    Err(TryRecvError::Disconnected) => {
                        ::log::error!("swoop: the capture thread is gone");
                        return Some(self.teardown(
                            Exit::NoCaptureSource,
                            ExitReason::Error,
                            LeftReason::Timeout,
                        ));
                    }
                }
            }
        }

        /// Re-plan the encode size against the current source and codec, after
        /// a mode change moved the texture under the encoder.
        fn replan(&mut self) {
            let Some(codec) = self.viewer.as_ref().map(|v| v.codec) else {
                return;
            };
            let Some(limits) = limits_for(&self.codec_caps, codec) else {
                return;
            };
            let encoded = match scale::plan(self.source, limits) {
                Plan::AsIs => self.source,
                Plan::Downscale { width, height } => (width, height),
                Plan::Refuse => {
                    ::log::error!("swoop: the new source size has no legal encode size");
                    return;
                }
            };
            self.encoded = encoded;
            let _ = self.capture_tx.send(ToCapture::Encode {
                codec,
                width: encoded.0,
                height: encoded.1,
            });
        }

        fn on_frame(&mut self, frame: EncodedFrame) {
            /// What the peer did with the frame. Kept out of the peer's borrow
            /// so the governor, the sequencer and the clock can be reached
            /// afterwards.
            enum Outcome {
                Skipped,
                /// The peer has no recovery point yet and this frame is not one.
                NeedsIrap,
                /// Written, with the rtp timestamp that is the browser's join key.
                Sent(u32),
            }

            let size = (frame.width as u16, frame.height as u16);
            let changed = self.last_size.is_some_and(|last| last != size);
            // §4: send is "immediately before the frame was handed to the
            // transport", and the governor joins its feedback on this stamp.
            let send_us = self.clock.now_us();
            let stamps = FrameStamps {
                capture_us: self.clock.us(frame.captured_qpc),
                encode_us: self.clock.us(frame.encoded_qpc),
                send_us,
            };

            let outcome = match self.peer.as_mut() {
                None => Outcome::Skipped,
                Some(peer) if peer.state() != PeerState::Connected => Outcome::Skipped,
                // Never the first thing a decoder sees: a delta whose
                // references it never had is a black stream, not a lost frame.
                Some(peer) if peer.wants_irap() && !frame.is_irap => Outcome::NeedsIrap,
                Some(peer) => {
                    let before = peer.stats().frames_written;
                    match peer.send(&frame) {
                        Err(e) => {
                            ::log::warn!("swoop: frame {} not sent: {e}", frame.frame_id);
                            Outcome::Skipped
                        }
                        // The pacer refused it, or the track is not writable
                        // yet. No record either: the browser would otherwise
                        // join a frame that never arrived to a stale timestamp.
                        Ok(()) if peer.stats().frames_written == before => Outcome::Skipped,
                        Ok(()) => Outcome::Sent(peer.last_rtp_timestamp_90k().unwrap_or(0)),
                    }
                }
            };

            let rtp = match outcome {
                Outcome::Skipped => return,
                Outcome::NeedsIrap => return self.request_idr(),
                Outcome::Sent(rtp) => rtp,
            };

            self.last_size = Some(size);
            let frame_id = frame.frame_id as u32;
            self.governor.on_frame_sent(frame_id, send_us);

            let mut header =
                FrameHeader::meta_record(frame_codec(frame.codec), frame_id, rtp, size, stamps);
            if frame.is_irap {
                header.flags |= flags::IRAP;
            }
            if changed {
                header.flags |= flags::RESOLUTION_CHANGED;
            }
            // Sets IRAP on any frame-id gap: a gap without it *is* the dangling
            // reference §4 forbids.
            self.sequencer.prepare(&mut header);
            let record = header.encode();
            if let Some(peer) = self.peer.as_mut() {
                peer.write_channel(Channel::SwoopMeta, true, record.to_vec());
            }
        }

        fn pump_peer(&mut self) -> Option<(Exit, ExitReason)> {
            let Some(peer) = self.peer.as_mut() else {
                // Nothing to drive, so the loop's own tick has to pace it.
                thread::sleep(TICK);
                return None;
            };
            let mut events = Vec::new();
            if let Err(e) = peer.poll(Instant::now(), TICK, &mut events) {
                ::log::error!("swoop: peer poll failed: {e}");
                let viewer = self.viewer.as_ref().map(|v| v.id.clone());
                if let Some(viewer) = viewer {
                    let effects = self.client.end_viewer(&viewer, LeftReason::Timeout);
                    let _ = self.apply(effects);
                }
                return None;
            }
            for event in events {
                self.on_peer_event(event);
            }
            None
        }

        fn on_peer_event(&mut self, event: PeerEvent) {
            match event {
                PeerEvent::Connected => ::log::info!("swoop: peer connected"),
                PeerEvent::Disconnected => {
                    // No `bye` came, so the viewer did not leave — it stopped
                    // answering. That is a timeout, and the release matters.
                    let viewer = self.viewer.as_ref().map(|v| v.id.clone());
                    if let Some(viewer) = viewer {
                        let effects = self.client.end_viewer(&viewer, LeftReason::Timeout);
                        let _ = self.apply(effects);
                    }
                }
                PeerEvent::LocalCandidate(candidate) => {
                    let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) else {
                        return;
                    };
                    // One bundled m-line, so mid 0 is the only one there is.
                    let message = Message::Candidate {
                        candidate,
                        sdp_mid: "0".to_owned(),
                        sdp_m_line_index: 0,
                        to: Some(viewer),
                        from: None,
                        from_role: None,
                        server_time_ms: None,
                    };
                    self.send(&message);
                }
                PeerEvent::KeyframeRequest => self.request_idr(),
                PeerEvent::ChannelOpen(Channel::SwoopControl) => self.send_hello_host(),
                PeerEvent::ChannelOpen(channel) => ::log::debug!("swoop: {channel:?} open"),
                PeerEvent::ChannelClose(channel) => ::log::debug!("swoop: {channel:?} closed"),
                PeerEvent::ChannelData {
                    channel,
                    binary,
                    data,
                } => self.on_channel_data(channel, binary, &data),
                PeerEvent::ChannelRefused(label) => {
                    ::log::warn!("swoop: refused a channel labelled {label}")
                }
                PeerEvent::FrameDropped { frame_id, bytes } => {
                    ::log::debug!("swoop: pacer refused frame {frame_id} ({bytes} bytes)")
                }
                PeerEvent::ChannelWriteRefused {
                    channel,
                    queued_bytes,
                } => ::log::debug!("swoop: {channel:?} write refused, {queued_bytes} queued"),
                PeerEvent::ChannelQueueOverflow { channel } => {
                    ::log::warn!("swoop: {channel:?} queue overflowed")
                }
                // Never fires: BWE is off. Named so it is not a silent arm.
                PeerEvent::BitrateEstimate(_) => {}
            }
        }

        fn on_channel_data(&mut self, ch: Channel, binary: bool, data: &[u8]) {
            match ch {
                Channel::SwoopControl if !binary => self.on_control(data),
                Channel::SwoopInput if !binary => self.on_input(data),
                Channel::SwoopFeedback if !binary => self.on_feedback(data),
                // Host → viewer channels, and §3's channels are text.
                _ => ::log::warn!("swoop: unexpected data on {ch:?} (binary {binary})"),
            }
        }

        fn on_control(&mut self, data: &[u8]) {
            let Ok(message) = serde_json::from_slice::<ControlMessage>(data) else {
                ::log::warn!("swoop: malformed control message");
                return;
            };
            let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) else {
                return;
            };
            let ctl = self.client.control_granted(&viewer);
            if message.requires_control() && !ctl {
                // §5: a viewer without `ctl` that sends something gated is
                // dropped and the attempt is reported.
                ::log::warn!("swoop: viewer {viewer} sent a gated control message without ctl");
                return;
            }
            match message {
                // §8's viewer token has no field on `offer`, so both ends put
                // the connect token on §10's `lease` frame: the first lease IS
                // the connect token, and there is one verification path.
                ControlMessage::Lease { token } => {
                    let verdict = self.client.verify_viewer_token(&viewer, &token);
                    match verdict {
                        Ok(claims) => {
                            let granted = self.client.control_granted(&viewer);
                            if let Some(v) = self.viewer.as_mut() {
                                v.ctl = granted;
                            }
                            ::log::info!("swoop: viewer {viewer} verified, ctl {granted}");
                            let ok = ControlMessage::LeaseOk {
                                expires_at: claims.exp.unwrap_or(0),
                            };
                            self.write_json(Channel::SwoopControl, &ok);
                        }
                        Err(denial) => {
                            ::log::warn!("swoop: viewer token refused: {denial}");
                            let effects = self.client.end_viewer(&viewer, LeftReason::LeaseExpired);
                            // Never an exit: `end_viewer` produces a bye and a
                            // departure, nothing that ends the process.
                            let _ = self.apply(effects);
                        }
                    }
                }
                ControlMessage::Idr => self.request_idr(),
                ControlMessage::Quality {
                    max_bitrate_kbps, ..
                } => {
                    let bps = max_bitrate_kbps.saturating_mul(1000).max(1);
                    self.governor.set_configured_bps(bps);
                    let target = self.governor.target_bps();
                    self.apply_bitrate(target);
                }
                // Task 6.1 owns the secure desktop and `SendSAS`; spike 0.3 was
                // never run, so nothing here crosses that boundary.
                ControlMessage::Sas => ::log::info!("swoop: sas requested (task 6.1)"),
                ControlMessage::Display { index } => {
                    ::log::info!("swoop: display {index} requested (task 6.4)")
                }
                ControlMessage::Mute { .. } => {}
                // Host → viewer types, which a viewer may not send.
                ControlMessage::HelloHost { .. }
                | ControlMessage::SasResult { .. }
                | ControlMessage::LeaseOk { .. }
                | ControlMessage::Ended { .. } => {
                    ::log::warn!("swoop: viewer sent a host-only control message")
                }
            }
        }

        fn on_input(&mut self, data: &[u8]) {
            let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) else {
                return;
            };
            // The host is the enforcement point, and `ctl` comes from the token
            // this host verified — never from anything the browser says.
            if !self.client.control_granted(&viewer) {
                ::log::warn!("swoop: input from a viewer without ctl, dropped");
                return;
            }
            let Ok(message) = serde_json::from_slice::<InputMessage>(data) else {
                ::log::warn!("swoop: malformed input message");
                return;
            };
            let _ = self.input_tx.try_send(ToInput::Message(Box::new(message)));
        }

        fn on_feedback(&mut self, data: &[u8]) {
            let Ok(message) = serde_json::from_slice::<Feedback>(data) else {
                ::log::warn!("swoop: malformed feedback message");
                return;
            };
            if let Feedback::Ping { id, t_us } = message {
                // `hostUs` must be in the same epoch as §4's `tSendUs`: the
                // browser's offset is `hostUs − viewerUs` and the governor
                // undoes it against the send stamp. The reply goes back on
                // `swoop-feedback`, which is where the viewer listens for it.
                self.write_json(
                    Channel::SwoopFeedback,
                    &Feedback::Pong {
                        id,
                        t_us,
                        host_us: self.clock.now_us() as i64,
                    },
                );
                return;
            }
            self.governor.on_feedback(Instant::now(), &message);
        }

        fn write_json<T: serde::Serialize>(&mut self, channel: Channel, message: &T) {
            let Some(peer) = self.peer.as_mut() else {
                return;
            };
            match serde_json::to_vec(message) {
                Ok(bytes) => peer.write_channel(channel, false, bytes),
                Err(e) => ::log::error!("swoop: could not encode a {channel:?} message: {e}"),
            }
        }

        fn send_hello_host(&mut self) {
            let Some(codec) = self.viewer.as_ref().map(|v| v.codec) else {
                return;
            };
            if self.viewer.as_ref().is_some_and(|v| v.hello_sent) {
                return;
            }
            if let Some(v) = self.viewer.as_mut() {
                v.hello_sent = true;
            }
            // Only the display being streamed. Advertising the others would put
            // a switcher in the browser for something this session cannot
            // honour — Task 6.4 enumerates them properly and makes the switch
            // real. `ready` still tells the service the true count.
            let displays = vec![channel::DisplayInfo {
                index: 0,
                width: self.encoded.0,
                height: self.encoded.1,
                primary: true,
            }];
            let hello = ControlMessage::HelloHost {
                codec: codec_wire_name(codec).to_owned(),
                width: self.encoded.0,
                height: self.encoded.1,
                displays,
                streamer_epoch: self.streamer_epoch,
                protocol_version: crate::bundle::SWOOP_PROTOCOL_VERSION,
            };
            self.write_json(Channel::SwoopControl, &hello);
            // This viewer's shape cache is empty and the tracker only emits on
            // a change, so the pointer has to be asked for whole.
            let _ = self.capture_tx.try_send(ToCapture::CursorSnapshot);
        }

        /// §4: a host coalesces idr requests behind a cooldown, so a browser
        /// may ask as often as it likes.
        fn request_idr(&mut self) {
            let now = Instant::now();
            if self
                .last_idr
                .is_some_and(|last| now.duration_since(last) < IDR_COOLDOWN)
            {
                return;
            }
            self.last_idr = Some(now);
            let _ = self.capture_tx.try_send(ToCapture::Idr);
        }

        /// The gate and the source have to agree, or the gate just drops the
        /// difference.
        fn apply_bitrate(&mut self, bps: u32) {
            if let Some(peer) = self.peer.as_mut() {
                peer.set_bitrate_ceiling(bps);
            }
            let _ = self.capture_tx.try_send(ToCapture::Bitrate(bps));
        }

        fn tick(&mut self) {
            let now = Instant::now();
            if now.duration_since(self.last_report) >= REPORT_INTERVAL {
                self.last_report = now;
                let pacer = self.peer.as_ref().map(|p| p.stats().pacer);
                if let Some(pacer) = pacer {
                    if let Some(bps) = self.governor.on_report(now, pacer) {
                        self.apply_bitrate(bps);
                    }
                }
            }
            if now.duration_since(self.last_status) >= STATUS_INTERVAL {
                self.status(now);
            }
        }

        fn status(&mut self, now: Instant) {
            let elapsed = now.duration_since(self.last_status);
            self.last_status = now;
            let (frames, bitrate_kbps) = match self.peer.as_ref() {
                Some(peer) => (peer.stats().frames_written, (peer.sent_bps() / 1000) as u32),
                None => (self.frames_at_status, 0),
            };
            let fps = frames
                .saturating_sub(self.frames_at_status)
                .checked_div(elapsed.as_secs().max(1))
                .unwrap_or(0) as u32;
            self.frames_at_status = frames;
            let viewers = self.client.viewer_count();
            let controllers = u32::from(self.viewer.as_ref().is_some_and(|v| v.ctl));
            // `status` has no field for the input rate limit's drop count, so
            // it rides the log line instead of being lost.
            if self.input_dropped > 0 {
                ::log::info!(
                    "swoop: input rate limit has dropped {} messages",
                    self.input_dropped
                );
            }
            let event = Event::Status {
                sid: self.sid.clone(),
                viewers,
                controllers,
                indicator: self.indicator,
                bitrate_kbps,
                fps,
                // Relay allocation is Task 7.4/7.5; everything today is direct.
                path: MediaPath::Direct,
                display: 0,
                uptime_s: now.duration_since(self.started).as_secs(),
            };
            self.emit(&event);
        }

        fn deadlines(&mut self) -> Option<(Exit, ExitReason)> {
            let now = Instant::now();
            if now.duration_since(self.started) >= self.session_cap {
                return Some(self.teardown(Exit::Ok, ExitReason::SessionCap, LeftReason::Timeout));
            }
            if self
                .idle_since
                .is_some_and(|since| now.duration_since(since) >= LINGER)
            {
                return Some(self.teardown(Exit::Ok, ExitReason::Idle, LeftReason::Timeout));
            }
            None
        }

        /// End the session: the viewer is told, everything it held is released,
        /// and the peer is closed before the process goes.
        fn teardown(
            &mut self,
            exit: Exit,
            reason: ExitReason,
            left: LeftReason,
        ) -> (Exit, ExitReason) {
            // Trigger 2 of `release_all`, for every ending that is not the
            // viewer's own bye.
            let _ = self.input_tx.send(ToInput::ReleaseAll);
            if let Some(viewer) = self.viewer.as_ref().map(|v| v.id.clone()) {
                let effects = self.client.end_viewer(&viewer, left);
                for effect in effects {
                    // The room's own `kill` already closed the socket inside
                    // `drive`, so there is nothing to say goodbye on — and the
                    // viewer heard that kill from the room directly. Every
                    // other ending still owes it a `bye`.
                    if let (Effect::Send(message), true) = (effect, self.socket.is_open()) {
                        self.send(&message);
                    }
                }
                let event = Event::ViewerLeft {
                    sid: self.sid.clone(),
                    viewer,
                    reason: left,
                };
                self.emit(&event);
                self.viewer = None;
            }
            if let Some(peer) = self.peer.as_mut() {
                peer.disconnect();
            }
            if self.socket.is_open() {
                self.socket.close(1000, "bye");
            }
            (exit, reason)
        }
    }

    // ------------------------------------------------------------ threads ---

    /// Capture, cursor, scale and encode. Everything that touches a GPU texture
    /// is on this thread, because a `Frame`'s handle is only valid until the
    /// next acquire and `Duplication` is not `Send`.
    fn capture_thread(
        output: OutputInfo,
        clock: HostClock,
        tx: Sender<FromWorker>,
        rx: Receiver<ToCapture>,
        stop: Arc<AtomicBool>,
    ) {
        // Attached before the duplication is opened, and its first result is
        // dropped: `follow` reports "the desktop changed" on the initial
        // attach too, and acting on that would rebuild a duplication that was
        // only just created — a wasted re-duplication and a second IDR on the
        // startup path G2 is measured on.
        let mut watcher = DesktopWatcher::new();
        watcher.follow();

        let signal = RebuildSignal::new();
        let mut source = match Duplication::open(&output, signal) {
            Ok(source) => source,
            Err(e) => {
                ::log::error!("swoop: could not duplicate {}: {e}", output.device_name);
                let _ = tx.try_send(FromWorker::Failed(Exit::NoCaptureSource));
                return;
            }
        };
        let mut size = source.size();
        if tx
            .try_send(FromWorker::Opened {
                width: size.0,
                height: size.1,
            })
            .is_err()
        {
            return;
        }

        let mut reader = PointerReader::new();
        let mut tracker = CursorTracker::new();
        let mut geometry = OutputGeometry::for_output(source.output(), size);
        let mut encoder: Option<Box<dyn Encoder>> = None;
        let mut scaler: Option<Downscaler> = None;
        let mut want: Option<(Codec, u32, u32)> = None;
        let mut bitrate = DEFAULT_BITRATE_BPS;
        let mut force_irap = false;

        while !stop.load(Ordering::Relaxed) {
            loop {
                match rx.try_recv() {
                    Ok(ToCapture::Encode {
                        codec,
                        width,
                        height,
                    }) => {
                        want = Some((codec, width, height));
                        encoder = None;
                        scaler = None;
                        force_irap = true;
                    }
                    Ok(ToCapture::Idr) => force_irap = true,
                    Ok(ToCapture::CursorSnapshot) => {
                        if let Some(shape) = tracker.current_shape() {
                            let _ = tx.try_send(FromWorker::Cursor(shape));
                        }
                    }
                    Ok(ToCapture::Bitrate(bps)) => {
                        bitrate = bps;
                        if let Some(encoder) = encoder.as_mut() {
                            if let Err(e) = encoder.set_bitrate(bps) {
                                ::log::warn!("swoop: could not move the bitrate: {e}");
                            }
                        }
                    }
                    Ok(ToCapture::Stop) | Err(TryRecvError::Disconnected) => return,
                    Err(TryRecvError::Empty) => break,
                }
            }

            if watcher.follow() {
                // A desktop switch does the same damage to a duplication as an
                // ACCESS_LOST, and the new device is a new encoder.
                source.request_rebuild();
            }
            // True once after every rebuild. The device is new, so the encoder
            // and the scaler that were pinned to the old one are gone with it.
            if source.take_idr_request() {
                encoder = None;
                scaler = None;
                force_irap = true;
            }

            let mut pointer = Vec::new();
            let acquired = {
                let geometry = &geometry;
                let tracker = &mut tracker;
                let reader = &mut reader;
                let pointer = &mut pointer;
                source.next_frame_with(ACQUIRE_TIMEOUT_MS, &mut |dup, info| {
                    // Most cursor news arrives on frames that carry no picture
                    // at all, and the shape is only legal to read while the
                    // frame is held — which is why this is an observer.
                    //
                    // `LastMouseUpdateTime` is qpc ticks; §5's `tsUs` is the
                    // same epoch as every other stamp the viewer is sent.
                    let ts_us = clock.us(info.LastMouseUpdateTime) as i64;
                    if let Some(at) = cursor::pointer_position(info) {
                        if let Some(message) = tracker.on_position(at, geometry, ts_us) {
                            pointer.push(message);
                        }
                    }
                    match reader.shape(dup, info) {
                        Ok(Some((shape, bytes))) => {
                            match tracker.on_shape(&shape, bytes, geometry.dpi) {
                                Ok(Some(message)) => pointer.push(message),
                                Ok(None) => {}
                                Err(e) => ::log::warn!("swoop: cursor shape: {e}"),
                            }
                        }
                        Ok(None) => {}
                        Err(e) => ::log::warn!("swoop: cursor shape read: {e}"),
                    }
                })
            };
            for message in pointer {
                let _ = tx.try_send(FromWorker::Cursor(message));
            }

            let frame = match acquired {
                Ok(frame) => frame,
                Err(e) => {
                    ::log::error!("swoop: capture failed: {e}");
                    let _ = tx.try_send(FromWorker::Failed(Exit::NoCaptureSource));
                    return;
                }
            };
            if source.size() != size {
                size = source.size();
                geometry = OutputGeometry::for_output(source.output(), size);
                let _ = tx.try_send(FromWorker::SourceSize {
                    width: size.0,
                    height: size.1,
                });
                // The session re-plans and sends a new `Encode`; until it does
                // there is no encoder to feed.
                want = None;
                encoder = None;
                scaler = None;
            }
            let Some(frame) = frame else {
                continue;
            };
            let Some((codec, width, height)) = want else {
                continue;
            };

            if scaler.is_none() && (width, height) != (frame.width, frame.height) {
                match Downscaler::open(&frame, width, height) {
                    Ok(opened) => scaler = Some(opened),
                    Err(e) => {
                        ::log::error!("swoop: could not open the downscaler: {e}");
                        let _ = tx.try_send(FromWorker::Failed(e.exit()));
                        return;
                    }
                }
            }
            let scaled = scaler.as_mut().map(|scaler| scaler.scale(&frame));
            let scaled = match scaled {
                Some(Ok(scaled)) => Some(scaled),
                Some(Err(e)) => {
                    // A new device under the scaler: rebuild both next turn.
                    ::log::warn!("swoop: downscale failed: {e}");
                    encoder = None;
                    scaler = None;
                    force_irap = true;
                    continue;
                }
                None => None,
            };
            let frame = scaled.as_ref().unwrap_or(&frame);

            if encoder.is_none() {
                match create_encoder(&EncoderConfig {
                    codec,
                    width,
                    height,
                    fps: TARGET_FPS,
                    // A rebuild is a new encoder, so the governor's current
                    // target is re-applied here rather than inherited.
                    bitrate_bps: bitrate,
                }) {
                    Ok(created) => encoder = Some(created),
                    Err(e) => {
                        ::log::error!("swoop: could not open the encoder: {e}");
                        let _ = tx.try_send(FromWorker::Failed(Exit::NoEncoder));
                        return;
                    }
                }
            }
            let Some(session) = encoder.as_mut() else {
                continue;
            };
            match session.encode(frame, force_irap) {
                Ok(Some(encoded)) => {
                    force_irap = false;
                    // A full queue means the session thread fell behind. The
                    // frame is dropped rather than stalling capture, and the
                    // next one is an IRAP so the gap cannot dangle.
                    if tx.try_send(FromWorker::Frame(Box::new(encoded))).is_err() {
                        force_irap = true;
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    // DeviceChanged and SizeChanged both mean the surface moved
                    // under the session: drop it and open a new one.
                    ::log::warn!("swoop: encode failed: {e}");
                    encoder = None;
                    scaler = None;
                    force_irap = true;
                }
            }
        }
    }

    /// Input injection, on the one thread that follows the input desktop.
    fn input_thread(
        space: PointerSpace,
        tx: Sender<FromWorker>,
        rx: Receiver<ToInput>,
        stop: Arc<AtomicBool>,
    ) {
        let mut watcher = DesktopWatcher::new();
        // Same reason as the capture thread: the initial attach is not a
        // switch, and there is nothing held to release on it.
        watcher.follow();
        let mut injector = SendInputInjector::new(space);
        let mut viewer = ViewerInput::new(Instant::now());
        let mut reported = 0u64;

        while !stop.load(Ordering::Relaxed) {
            // Trigger 4 of `release_all`. `follow` switches and reports in one
            // call, so the ups land on the new desktop — they clear this host's
            // model of what is held, which is the half that sticks.
            if watcher.follow() {
                let events = viewer.release_all();
                if !events.is_empty() {
                    let _ = injector.inject_all(&events);
                }
                injector.refresh_bounds();
            }
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(ToInput::Message(message)) => {
                    let events = viewer.accept(&message, Instant::now());
                    if !events.is_empty() {
                        if let Err(e) = injector.inject_all(&events) {
                            ::log::warn!("swoop: input injection failed: {e}");
                        }
                    }
                    if viewer.dropped() != reported {
                        reported = viewer.dropped();
                        let _ = tx.try_send(FromWorker::InputDropped(reported));
                    }
                }
                Ok(ToInput::ReleaseAll) => {
                    let events = viewer.release_all();
                    if !events.is_empty() {
                        let _ = injector.inject_all(&events);
                    }
                }
                Ok(ToInput::Stop) => return,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    /// Control lines. Line 1 was the bundle and was read before this started.
    fn stdin_thread(mut stdin: impl BufRead, tx: Sender<FromService>) {
        let mut line = String::new();
        loop {
            line.clear();
            match stdin.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(FromService::Eof);
                    return;
                }
                Ok(_) => match ipc::parse_control(line.trim_end()) {
                    Ok(control) => {
                        if tx.send(FromService::Control(control)).is_err() {
                            return;
                        }
                    }
                    // Never the line itself: line 1 was the bundle and a parser
                    // error quotes what it choked on.
                    Err(e) => ::log::warn!("swoop: {e}"),
                },
                Err(e) => {
                    ::log::warn!("swoop: stdin read failed: {e}");
                    let _ = tx.send(FromService::Eof);
                    return;
                }
            }
        }
    }

    // ------------------------------------------------------------ helpers ---

    /// The primary output: the one whose desktop rect starts at the origin.
    /// Every other output's coordinates are relative to it and can be negative.
    fn primary(outputs: &[OutputInfo]) -> &OutputInfo {
        outputs
            .iter()
            .find(|o| o.desktop_rect.left == 0 && o.desktop_rect.top == 0)
            .unwrap_or(&outputs[0])
    }

    /// One host candidate, on the interface that would reach the internet. A
    /// udp `connect` sends nothing; it only picks the route. Task 7.4/7.5 adds
    /// server-reflexive and relayed candidates through `add_local_candidate`.
    fn local_bind_addr() -> SocketAddr {
        let found = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
            .and_then(|socket| {
                socket.connect((Ipv4Addr::new(1, 1, 1, 1), 53))?;
                socket.local_addr()
            })
            .ok();
        SocketAddr::new(
            found.map_or(IpAddr::V4(Ipv4Addr::LOCALHOST), |addr| addr.ip()),
            0,
        )
    }

    fn frame_codec(codec: Codec) -> FrameCodec {
        match codec {
            Codec::H265 => FrameCodec::Hevc,
            Codec::H264 => FrameCodec::H264,
        }
    }

    #[cfg(feature = "encode-nvenc")]
    fn encoder_caps() -> Vec<BackendCaps> {
        vec![crate::encode::nvenc::probe()]
    }

    #[cfg(not(feature = "encode-nvenc"))]
    fn encoder_caps() -> Vec<BackendCaps> {
        // Task 7.3 selects across backends; without one compiled in there is
        // nothing to select and the session exits 13.
        Vec::new()
    }

    #[cfg(feature = "encode-nvenc")]
    fn create_encoder(cfg: &EncoderConfig) -> anyhow::Result<Box<dyn Encoder>> {
        crate::encode::nvenc::create(cfg)
    }

    #[cfg(not(feature = "encode-nvenc"))]
    fn create_encoder(_cfg: &EncoderConfig) -> anyhow::Result<Box<dyn Encoder>> {
        anyhow::bail!("no encoder backend is compiled in")
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::input::InputEvent;

        /// The host half of the session on real hardware: duplication →
        /// downscale-if-needed → encoder, plus injection → the pointer the
        /// cursor tracker reports, driven by the same threads the session
        /// spawns with nothing stubbed.
        ///
        /// **It moves the real mouse pointer on this machine**, twice, because
        /// that is the only way to prove the cursor stream: the tracker emits
        /// on a change and a stationary desktop is silent by design (20.4% of
        /// frames carry no pointer news at all).
        ///
        /// The room half cannot be tested from here — it needs a bundle minted
        /// by the api for this machine, which is the `run` invocation in this
        /// module's head comment.
        #[test]
        #[ignore = "captures this box's real desktop, opens its encoder and moves the pointer"]
        fn end_to_end_picture() {
            let outputs = capture::enumerate_outputs().expect("dxgi enumerates");
            assert!(!outputs.is_empty(), "no attached output to duplicate");
            let output = primary(&outputs).clone();
            let space = output.clone();

            let caps: Vec<CodecCaps> = encoder_caps()
                .into_iter()
                .flat_map(|backend| backend.codecs)
                .collect();
            assert!(!caps.is_empty(), "no encoder backend on this machine");
            let codec = caps[0].codec;
            let limits = limits_for(&caps, codec).expect("the codec it just reported");

            let clock = HostClock::new(
                qpc_hz().expect("a performance counter"),
                crate::bundle::TimeAnchor::new(0),
                0,
            );
            let stop = Arc::new(AtomicBool::new(false));
            let (tx, rx) = bounded::<FromWorker>(WORKER_QUEUE);
            let (capture_tx, capture_rx) = bounded::<ToCapture>(8);
            let handle = {
                let stop = Arc::clone(&stop);
                thread::spawn(move || capture_thread(output, clock, tx, capture_rx, stop))
            };

            let source = match rx.recv_timeout(CAPTURE_OPEN_TIMEOUT) {
                Ok(FromWorker::Opened { width, height }) => (width, height),
                Ok(FromWorker::Failed(exit)) => {
                    stop.store(true, Ordering::Relaxed);
                    panic!("capture did not open: exit {}", exit.code());
                }
                _ => {
                    stop.store(true, Ordering::Relaxed);
                    panic!("capture said nothing within {CAPTURE_OPEN_TIMEOUT:?}");
                }
            };
            let encoded = match scale::plan(source, limits) {
                Plan::AsIs => source,
                Plan::Downscale { width, height } => (width, height),
                Plan::Refuse => panic!("{source:?} has no legal encode size"),
            };
            capture_tx
                .send(ToCapture::Encode {
                    codec,
                    width: encoded.0,
                    height: encoded.1,
                })
                .expect("the capture thread is running");

            // The pointer has to actually move, or the tracker has nothing to
            // report — and a move injected here is the same call the input
            // thread makes, so it proves that half at the same time. Paced on
            // the clock and not on frames: a busy desktop delivers 60 frames a
            // second and an idle one delivers none, and the pointer has to move
            // somewhere it was not already sitting either way.
            let mut injector = SendInputInjector::new(PointerSpace::from_output(&space));
            let spots = [(0.25f32, 0.25f32), (0.75, 0.65), (0.4, 0.8), (0.6, 0.2)];
            let mut spot = 0usize;
            let mut next_move = Instant::now();

            let deadline = Instant::now() + Duration::from_secs(3);
            let (mut frames, mut iraps, mut bytes) = (0u32, 0u32, 0usize);
            let (mut positions, mut shapes) = (0u32, 0u32);
            while Instant::now() < deadline {
                if Instant::now() >= next_move {
                    let (x, y) = spots[spot % spots.len()];
                    spot += 1;
                    injector
                        .inject(&InputEvent::MouseMove { x, y })
                        .expect("sendinput reaches this desktop");
                    next_move = Instant::now() + Duration::from_millis(200);
                }
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(FromWorker::Frame(frame)) => {
                        frames += 1;
                        bytes += frame.data.len();
                        iraps += u32::from(frame.is_irap);
                    }
                    Ok(FromWorker::Cursor(channel::Cursor::Cpos { .. })) => positions += 1,
                    Ok(FromWorker::Cursor(channel::Cursor::Cshape { .. })) => shapes += 1,
                    Ok(FromWorker::Failed(exit)) => panic!("capture failed: exit {}", exit.code()),
                    Ok(_) => {}
                    // A static desktop is silent, which is the normal case and
                    // not a reason to stop looking.
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
            }
            stop.store(true, Ordering::Relaxed);
            let _ = capture_tx.send(ToCapture::Stop);
            let _ = handle.join();

            println!(
                "swoop capture: {source:?} -> {encoded:?} {}, {frames} frames ({iraps} irap, \
                 {bytes} bytes), {positions} cpos, {shapes} cshape",
                codec_wire_name(codec)
            );
            assert!(frames > 0, "no encoded frame in five seconds");
            assert_eq!(iraps, 1, "a session opens with exactly one irap and no needless rebuild");
            assert!(positions > 0, "the injected pointer moves produced no cpos");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::bundle::{Bundle, BuildVersions};
    use crate::ipc::{emit, exit, Event};

    fn vectors() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/protocol")
    }

    /// The agent version the bundle vectors were authored against — swoop's own
    /// release, not whatever this working tree says. Read from the accept
    /// vector, exactly as `tests/protocol_vectors.rs` reads it, so the two
    /// cannot drift.
    fn build() -> BuildVersions<'static> {
        let valid = fs::read_to_string(vectors().join("bundle/bundle-valid.json"))
            .expect("the valid bundle vector is present");
        let parsed: serde_json::Value = serde_json::from_str(&valid).expect("it is json");
        let version = parsed["agentVersion"]
            .as_str()
            .expect("bundle-valid.json names an agentVersion")
            .to_owned();
        BuildVersions {
            protocol_version: crate::bundle::SWOOP_PROTOCOL_VERSION,
            agent_version: Box::leak(version.into_boxed_str()),
        }
    }

    /// The verdict only: `Bundle` has no `PartialEq` on purpose — §7 gives it
    /// no way to be printed or compared, and an exit code is what this maps to.
    fn verdict(line: &str) -> Result<(), u8> {
        Bundle::parse(line, build())
            .map(|_| ())
            .map_err(|e| e.exit().code())
    }

    fn parse(file: &str) -> Result<(), u8> {
        let line = fs::read_to_string(vectors().join(file)).expect("the vector is present");
        verdict(&line)
    }

    /// The exit codes §6 fixes, taken through the same mapping `main` uses —
    /// the numbers the agent reports on, so they are contract.
    #[test]
    fn a_bundle_is_accepted_or_maps_to_its_documented_exit_code() {
        assert!(parse("bundle/bundle-valid.json").is_ok());
        // No time anchor: there would be nothing to check `exp` against but the
        // kiosk's wall clock, so the streamer refuses to start.
        assert_eq!(parse("bundle/bundle-missing-anchor.json"), Err(exit::BUNDLE_INVALID));
        assert_eq!(parse("bundle/bundle-version-mismatch.json"), Err(exit::VERSION_MISMATCH));
        // A release build parses no `overrides` at all; under `testhooks` the
        // same vector is a valid bundle, which is the point of the feature.
        #[cfg(not(feature = "testhooks"))]
        assert_eq!(
            parse("bundle/bundle-overrides-no-testhooks.json"),
            Err(exit::BUNDLE_INVALID)
        );
        // Not a bundle at all.
        assert_eq!(verdict("{"), Err(exit::BUNDLE_INVALID));
        assert_eq!(verdict(""), Err(exit::BUNDLE_INVALID));
    }

    /// Every event this session emits, encoded the way the golden vectors spell
    /// it — field order included, because the service reads these as lines.
    #[test]
    fn the_stdout_events_are_written_exactly_as_the_golden_vectors_spell_them() {
        let path = vectors().join("pipe/pipe-stdout-events.ndjson");
        let file = fs::read_to_string(&path).expect("the pipe vector is present");
        let mut seen = 0;
        for line in file.lines().filter(|line| !line.trim().is_empty()) {
            let event: Event = serde_json::from_str(line).expect("a golden event parses");
            let mut out = Vec::new();
            emit(&mut out, &event).expect("writing to a vec never fails");
            assert_eq!(String::from_utf8(out).expect("utf-8"), format!("{line}\n"));
            seen += 1;
        }
        assert_eq!(seen, 6, "ready, viewer_joined, status, sas_request, viewer_left, exiting");
    }

    #[test]
    fn the_wire_spelling_of_hevc_is_not_the_serde_spelling() {
        // `web/lib/swoop/protocol.ts` and the golden pipe vectors both say
        // `hevc`; `Codec`'s own serde spelling is `h265`.
        assert_eq!(codec_wire_name(Codec::H265), "hevc");
        assert_eq!(codec_wire_name(Codec::H264), "h264");
        assert_eq!(
            serde_json::to_string(&Codec::H265).expect("it serializes"),
            "\"h265\""
        );
    }

    #[test]
    fn the_codec_is_the_hosts_preference_narrowed_by_the_offer() {
        let both = [Codec::H265, Codec::H264];
        let h264_only = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n";
        let with_h265 = "m=video 9 UDP/TLS/RTP/SAVPF 96 98\r\na=rtpmap:96 H264/90000\r\na=rtpmap:98 H265/90000\r\n";

        assert_eq!(pick_codec(with_h265, &both), Some(Codec::H265));
        // A browser that cannot decode hevc is not handed one.
        assert_eq!(pick_codec(h264_only, &both), Some(Codec::H264));
        // Nor is one this host cannot encode.
        assert_eq!(pick_codec(with_h265, &[Codec::H264]), Some(Codec::H264));
        assert_eq!(pick_codec("m=video 9 UDP/TLS/RTP/SAVPF 96\r\n", &both), None);
        assert_eq!(pick_codec(with_h265, &[]), None);
    }

    #[test]
    fn limits_are_per_codec_because_the_caps_are() {
        let caps = vec![
            CodecCaps {
                codec: Codec::H265,
                max_width: 8192,
                max_height: 8192,
            },
            CodecCaps {
                codec: Codec::H264,
                max_width: 4096,
                max_height: 4096,
            },
        ];
        assert_eq!(
            limits_for(&caps, Codec::H264),
            Some(Limits {
                max_width: 4096,
                max_height: 4096
            })
        );
        assert_eq!(
            limits_for(&caps, Codec::H265),
            Some(Limits {
                max_width: 8192,
                max_height: 8192
            })
        );
        assert_eq!(limits_for(&[], Codec::H264), None);
    }

    /// Two 4K panels side by side is 7680 wide, over H.264's 4096: without the
    /// downscale a Mosaic box cannot stream at all.
    #[test]
    fn an_over_cap_canvas_is_downscaled_rather_than_refused() {
        let caps = vec![CodecCaps {
            codec: Codec::H264,
            max_width: 4096,
            max_height: 4096,
        }];
        let limits = limits_for(&caps, Codec::H264).expect("h264 caps");
        let plan = crate::gpu::scale::plan((7680, 2160), limits);
        assert_eq!(
            plan,
            crate::gpu::scale::Plan::Downscale {
                width: 4096,
                height: 1152
            }
        );
        assert_eq!(plan.factor(7680), Some(4096.0 / 7680.0));
    }
}
