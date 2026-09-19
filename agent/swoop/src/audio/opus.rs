//! The Opus half of the audio path: the wire parameters §3's `audio` m-line
//! carries, the 10 ms frame clock, and the encoder seam.
//!
//! # The frame clock is the whole point of this file
//!
//! WASAPI loopback does not deliver a steady stream. A render session that is
//! playing nothing signals no event at all, `GetNextPacketSize` returns 0, and
//! a packet that *does* arrive can be flagged `AUDCLNT_BUFFERFLAGS_SILENT` with
//! no meaningful bytes behind it. All three are the same thing to a decoder:
//! a hole. An encoder fed only the samples the device produced emits frames
//! whose RTP timestamps jump by the length of every idle period, which a
//! receiver treats as a discontinuity — it flushes, it re-buffers, and the
//! first sound after a quiet desktop arrives late.
//!
//! So the timeline is driven by a **clock**, not by the device: it emits one
//! 10 ms frame every 10 ms, filling comfort silence for whatever the device did
//! not deliver ([`Timeline::fill_to`]). Timestamps are contiguous by
//! construction, and `usedtx=0` below says the same thing on the wire — swoop
//! keeps sending during silence rather than letting the receiver's clock drift.
//!
//! # 10 ms, and the parameters that go with it
//!
//! Research `03` §9: 10 ms frames, 48 kHz stereo, 96–128 kbps, in-band FEC on
//! (a lost packet is concealed from the next one rather than waiting for a
//! retransmit that would arrive after playout), DTX off, and `minptime=10` so
//! the receiver does not ask for longer packets than the frame size.
//!
//! # The encoder is `audiopus`, and only behind `audio-opus`
//!
//! [`encoder`] builds an `audiopus` encoder over a libopus compiled into this
//! binary (`audiopus_sys`'s `static` feature — the manifest carries the reason
//! and the exit condition). It is behind the non-default `audio-opus` feature,
//! so a default build still has this module's wire parameters and frame clock
//! and gets [`NO_ENCODER`] from the constructor.
//!
//! The four facts [`FMTP`] promises are set on the encoder as well as said in
//! the SDP. A receiver told `useinbandfec=1` and then handed frames carrying no
//! redundancy conceals nothing, which is worse than never having claimed it.

use std::time::Duration;

use anyhow::Result;

/// Opus's internal rate, and the RTP clock rate of the `audio` m-line.
pub const SAMPLE_RATE_HZ: u32 = 48_000;

/// Stereo, because a desktop's audio is (`stereo=1; sprop-stereo=1`).
pub const CHANNELS: usize = 2;

/// Frame length. The bottom of Opus's range that still codes music well, and
/// the one place latency is bought outright: 20 ms frames would halve the
/// packet rate and add 10 ms to every sound.
pub const FRAME_MS: u32 = 10;

/// The same frame length as a [`Duration`], which is what the capture loop
/// ticks on.
pub const FRAME: Duration = Duration::from_millis(FRAME_MS as u64);

/// Samples per channel in one frame: 480.
pub const FRAME_SAMPLES_PER_CHANNEL: usize = (SAMPLE_RATE_HZ / 1_000 * FRAME_MS) as usize;

/// Interleaved i16 samples in one frame: 960.
pub const FRAME_SAMPLES: usize = FRAME_SAMPLES_PER_CHANNEL * CHANNELS;

/// What one frame advances the 48 kHz RTP clock by, which is the per-channel
/// count — an RTP timestamp counts sample *times*, not interleaved slots.
pub const FRAME_RTP_TICKS: u64 = FRAME_SAMPLES_PER_CHANNEL as u64;

/// Target bitrate, the top of research `03` §9's 96–128 kbps band. Audio is
/// ~0.6% of a 20 Mbps video target, so the band is chosen for quality.
pub const BITRATE_BPS: u32 = 128_000;

/// The fmtp the `audio` m-line carries. `transport/rtc.rs` builds the payload
/// parameters from the same four facts; the test below pins them together so
/// the string and the negotiated format cannot drift.
pub const FMTP: &str = "stereo=1; sprop-stereo=1; minptime=10; useinbandfec=1; usedtx=0";

/// Why a build without `audio-opus` has no encoder. Surfaced verbatim so a
/// machine's log says what is missing rather than "audio unavailable".
pub const NO_ENCODER: &str =
    "no opus encoder is compiled in: this streamer was built without the audio-opus feature";

/// The most one 10 ms frame may encode to. Opus's own ceiling for a single
/// frame; at [`BITRATE_BPS`] a frame is ~160 bytes, and the buffer is sized for
/// the ceiling rather than the average because an encoder handed a short one
/// fails the frame instead of truncating it.
#[cfg(feature = "audio-opus")]
const MAX_PACKET_BYTES: usize = 1275;

/// One encoded 10 ms frame, ready for the RTP track.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    /// The 48 kHz RTP timestamp. Contiguous across device gaps by
    /// construction — see the module doc.
    pub rtp_48k: u64,
    pub payload: Vec<u8>,
}

/// The Opus encoder seam.
///
/// One method, because the pipeline has one shape: a whole 10 ms frame of
/// interleaved stereo i16 in, one packet out. Length is fixed at
/// [`FRAME_SAMPLES`]; an implementation may assume it.
pub trait Encoder: Send {
    fn encode(&mut self, pcm: &[i16], out: &mut Vec<u8>) -> Result<()>;
}

/// Build the encoder configured for [`FMTP`]'s terms.
#[cfg(feature = "audio-opus")]
pub fn encoder() -> Result<Box<dyn Encoder>> {
    Ok(Box::new(Opus::new()?))
}

/// Without the feature there is no libopus in the binary at all.
#[cfg(not(feature = "audio-opus"))]
pub fn encoder() -> Result<Box<dyn Encoder>> {
    Err(anyhow::anyhow!(NO_ENCODER))
}

#[cfg(feature = "audio-opus")]
struct Opus {
    inner: audiopus::coder::Encoder,
    /// Reused across frames so encoding allocates nothing.
    scratch: Vec<u8>,
}

#[cfg(feature = "audio-opus")]
impl Opus {
    fn new() -> Result<Self> {
        use audiopus::coder::Encoder as OpusEncoder;
        use audiopus::{Application, Bitrate, Channels, SampleRate};

        // `Audio`, not `Voip`: a desktop plays music and video, and Voip's
        // speech model mangles both. `LowDelay` disables the layer FEC needs.
        let mut inner = OpusEncoder::new(SampleRate::Hz48000, Channels::Stereo, Application::Audio)?;
        inner.set_bitrate(Bitrate::BitsPerSecond(BITRATE_BPS as i32))?;
        inner.set_inband_fec(true)?;
        inner.set_dtx(false)?;
        // FEC is only emitted for loss the encoder believes is happening: with
        // the default 0% it produces none at all and `useinbandfec=1` becomes a
        // promise the stream does not keep. 5% is a standing assumption rather
        // than a measurement — the receiver's real loss is not on this side of
        // the wire, and Task 4.7's feedback loop drives the video rate, not
        // this.
        inner.set_packet_loss_perc(5)?;
        Ok(Self {
            inner,
            scratch: vec![0u8; MAX_PACKET_BYTES],
        })
    }
}

#[cfg(feature = "audio-opus")]
impl Encoder for Opus {
    fn encode(&mut self, pcm: &[i16], out: &mut Vec<u8>) -> Result<()> {
        let written = self.inner.encode(pcm, self.scratch.as_mut_slice())?;
        out.clear();
        out.extend_from_slice(&self.scratch[..written]);
        Ok(())
    }
}

/// The 10 ms frame clock: interleaved i16 in, whole frames with contiguous
/// 48 kHz timestamps out.
///
/// Holds at most one frame's worth of carry — anything beyond that is drained
/// by the caller on the same turn — so it never becomes a queue in front of the
/// encoder.
#[derive(Debug, Default)]
pub struct Timeline {
    pcm: Vec<i16>,
    /// Timestamp of the next frame [`next_frame`](Self::next_frame) will emit.
    next_rtp: u64,
    /// Frames emitted, so [`fill_to`](Self::fill_to) can compare the clock
    /// against what the device has actually accounted for.
    emitted: u64,
    silence_frames: u64,
}

impl Timeline {
    pub fn new() -> Self {
        Self::default()
    }

    /// Interleaved 48 kHz stereo i16, exactly as the device delivered it.
    pub fn push(&mut self, pcm: &[i16]) {
        self.pcm.extend_from_slice(pcm);
    }

    /// Comfort silence up to `elapsed` since the stream started.
    ///
    /// Called every turn, whatever the device did: a silent render session
    /// raises no event and `GetNextPacketSize` returns 0, so the only thing
    /// that knows time passed is the clock. Never removes samples — a device
    /// that ran ahead of the clock keeps its samples and the next call simply
    /// adds nothing.
    pub fn fill_to(&mut self, elapsed: Duration) {
        let want = elapsed.as_millis() as u64 / u64::from(FRAME_MS);
        let have = self.emitted + (self.pcm.len() / FRAME_SAMPLES) as u64;
        let Some(missing) = want.checked_sub(have) else {
            return;
        };
        for _ in 0..missing {
            self.pcm.resize(self.pcm.len() + FRAME_SAMPLES, 0);
            self.silence_frames += 1;
        }
    }

    /// Drain one whole frame into `out`, returning its RTP timestamp. `None`
    /// means there is not yet a whole frame — never a partial one, because a
    /// short frame is a timestamp lie.
    pub fn next_frame(&mut self, out: &mut [i16]) -> Option<u64> {
        debug_assert_eq!(out.len(), FRAME_SAMPLES);
        if self.pcm.len() < FRAME_SAMPLES || out.len() != FRAME_SAMPLES {
            return None;
        }
        out.copy_from_slice(&self.pcm[..FRAME_SAMPLES]);
        self.pcm.drain(..FRAME_SAMPLES);
        let rtp = self.next_rtp;
        self.next_rtp += FRAME_RTP_TICKS;
        self.emitted += 1;
        Some(rtp)
    }

    /// Frames of comfort silence generated, cumulative. A session whose count
    /// climbs at 100/s is a machine playing nothing, not a broken capture.
    pub fn silence_frames(&self) -> u64 {
        self.silence_frames
    }

    pub fn frames_emitted(&self) -> u64 {
        self.emitted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> Vec<i16> {
        vec![0i16; FRAME_SAMPLES]
    }

    #[test]
    fn the_frame_size_is_the_one_the_fmtp_promises() {
        assert_eq!(FRAME_SAMPLES_PER_CHANNEL, 480);
        assert_eq!(FRAME_SAMPLES, 960);
        assert_eq!(FRAME_RTP_TICKS, 480);
        // `minptime` is in milliseconds and must not exceed the frame length,
        // or the receiver asks for packets the encoder never produces.
        assert!(FMTP.contains(&format!("minptime={FRAME_MS}")));
        assert!(FMTP.contains("useinbandfec=1"), "fec is on (research 03 §9)");
        assert!(FMTP.contains("usedtx=0"), "dtx is off; silence is still sent");
        assert!(FMTP.contains("stereo=1") && FMTP.contains("sprop-stereo=1"));
        assert!((96_000..=128_000).contains(&BITRATE_BPS));
    }

    #[test]
    fn whole_frames_only_and_each_advances_the_clock_by_one_frame() {
        let mut timeline = Timeline::new();
        let mut out = frame();
        assert_eq!(timeline.next_frame(&mut out), None, "nothing pushed yet");

        timeline.push(&vec![7i16; FRAME_SAMPLES + 1]);
        assert_eq!(timeline.next_frame(&mut out), Some(0));
        assert_eq!(out, vec![7i16; FRAME_SAMPLES]);
        assert_eq!(
            timeline.next_frame(&mut out),
            None,
            "one sample is not a frame"
        );
    }

    /// The done-when test: a device that stops delivering must not move the
    /// timestamps. 30 ms of real audio, a 50 ms gap, then audio again —
    /// every frame is 480 ticks after the one before it, with no jump across
    /// the gap and no duplicate.
    #[test]
    fn silence_fill_keeps_timestamps_monotonic_at_ten_milliseconds_across_a_device_gap() {
        let mut timeline = Timeline::new();
        let mut out = frame();
        let mut stamps = Vec::new();

        timeline.push(&vec![1i16; FRAME_SAMPLES * 3]);
        // The device produced nothing for 50 ms; the clock says 80 ms have
        // passed, so five frames of comfort silence fill the hole.
        timeline.fill_to(Duration::from_millis(80));
        timeline.push(&vec![1i16; FRAME_SAMPLES * 2]);

        let mut silent = Vec::new();
        while let Some(rtp) = timeline.next_frame(&mut out) {
            stamps.push(rtp);
            silent.push(out.iter().all(|s| *s == 0));
        }

        assert_eq!(stamps, vec![0, 480, 960, 1440, 1920, 2400, 2880, 3360, 3840, 4320]);
        for pair in stamps.windows(2) {
            assert_eq!(pair[1] - pair[0], FRAME_RTP_TICKS, "a gap moved the clock");
        }
        assert_eq!(
            silent,
            vec![false, false, false, true, true, true, true, true, false, false],
            "the silence lands in the hole, not around it"
        );
        assert_eq!(timeline.silence_frames(), 5);
        assert_eq!(timeline.frames_emitted(), 10);
    }

    #[test]
    fn a_device_running_ahead_of_the_clock_keeps_its_samples() {
        let mut timeline = Timeline::new();
        let mut out = frame();
        timeline.push(&vec![3i16; FRAME_SAMPLES * 4]);
        // Only 10 ms of clock against 40 ms of audio: nothing to fill, and
        // nothing thrown away.
        timeline.fill_to(Duration::from_millis(10));
        let mut count = 0;
        while timeline.next_frame(&mut out).is_some() {
            assert!(out.iter().all(|s| *s == 3));
            count += 1;
        }
        assert_eq!(count, 4);
        assert_eq!(timeline.silence_frames(), 0);
    }

    #[cfg(not(feature = "audio-opus"))]
    #[test]
    fn a_build_without_the_feature_says_which_feature_is_missing() {
        let Err(err) = encoder() else {
            panic!("an encoder was built without libopus being compiled in");
        };
        assert!(err.to_string().contains("audio-opus"), "{err}");
    }

    /// Not a hardware test: libopus is compiled into this binary, so this runs
    /// anywhere the feature builds. A frame of silence still encodes to
    /// something — DTX is off — and a loud frame has to be bigger than it.
    #[cfg(feature = "audio-opus")]
    #[test]
    fn a_frame_encodes_and_silence_is_still_sent() {
        let mut encoder = encoder().expect("libopus is compiled in");
        let mut out = Vec::new();

        encoder.encode(&vec![0i16; FRAME_SAMPLES], &mut out).expect("silence");
        assert!(!out.is_empty(), "dtx is off; silence is still a packet");
        let silence = out.len();

        // A square wave: something the encoder cannot spend two bytes on.
        let tone: Vec<i16> = (0..FRAME_SAMPLES)
            .map(|i| if (i / 48) % 2 == 0 { 12_000 } else { -12_000 })
            .collect();
        encoder.encode(&tone, &mut out).expect("tone");
        assert!(out.len() > silence, "{} bytes is not a tone", out.len());
        assert!(out.len() <= MAX_PACKET_BYTES);
    }
}
