//! The WASAPI side of host audio: the render endpoint, and what swoop will not
//! do to it.
//!
//! swoop **never creates a virtual device and never moves the default render
//! endpoint.** A signage box's audio routing belongs to whoever set the box up,
//! and a remote session that changed it would still have changed it after the
//! session ended. So the only thing this module asks the audio stack is whether
//! a default render endpoint exists at all — that is the fact `status` carries
//! (`ipc::AudioState`), and it is pulled whether or not a viewer is connected,
//! because a box with no audio endpoint is exactly what wants reporting while
//! nobody is watching.
//!
//! # [`Loopback`], and the two things about it that are not the obvious choice
//!
//! **The engine converts, not this module.** `Initialize` asks for exactly what
//! Opus wants — 48 kHz stereo 16-bit PCM — with `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
//! | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY`, so a box whose endpoint mixes at
//! 44.1 kHz float or in 5.1 is resampled and folded by the audio engine.
//! Without those flags a shared-mode client must take the endpoint's mix format
//! verbatim, and the alternative is a resampler and a channel matrix in here
//! for something Windows already does.
//!
//! **It is polled, not event-driven.** A loopback client raises its event only
//! while a render session is actually playing, so an event-driven capture loop
//! goes to sleep on a quiet desktop — exactly when [`super::opus::Timeline`]
//! still has to produce frames. The clock is what drives this path, so the
//! capture is a drain on the same 10 ms tick and the endpoint's own buffer
//! (200 ms, [`BUFFER_100NS`]) absorbs a late one. That also makes
//! `AvSetMmThreadCharacteristics("Pro Audio")` unnecessary: a preempted thread
//! finds its samples still waiting rather than losing them.
//!
//! # Hardware checks (`#[ignore]`d)
//!
//! Both read the machine's real audio stack. With the working directory
//! `agent/swoop`:
//!
//! ```text
//! cargo test --features audio-opus -- --ignored audio::wasapi --nocapture
//! ```
//!
//! `reports_whether_this_machine_has_a_render_endpoint` expects `true` on a box
//! with working audio and `false` on one whose audio device is disabled in
//! Device Manager — the `no_endpoint` state the session reports rather than
//! stalling on.
//!
//! `captures_whatever_this_machine_is_playing` is what its name says: it opens
//! a loopback capture of the default render endpoint and prints how many
//! samples arrived and how loud they were. **It records the machine's own
//! output for a second** — whatever is playing on the box when you run it — so
//! run it on a machine you are happy to listen to. With nothing playing it
//! prints no samples at all, which is the case the frame clock exists for.

use std::ptr;

use anyhow::{Context, Result};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
    WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

use super::opus::{CHANNELS, SAMPLE_RATE_HZ};

/// How much audio the endpoint holds for us, in 100 ns units: 200 ms. The
/// capture is polled, so this is the margin a late tick has before samples are
/// overwritten — generous on purpose, because it costs a few hundred kilobytes
/// and buys the whole scheduling story above.
pub const BUFFER_100NS: i64 = 200 * 10_000;

/// Bytes per sample of what [`Loopback`] asks the engine for.
const BYTES_PER_SAMPLE: u32 = 2;

/// Is there a default render endpoint at all?
///
/// COM must already be initialized on the calling thread. A machine with no
/// sound card, or with its audio device disabled, answers `false`; so does a
/// machine whose audio service is not running, which is the same thing to a
/// viewer.
pub fn render_endpoint_present() -> bool {
    unsafe {
        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return false;
        };
        enumerator.GetDefaultAudioEndpoint(eRender, eConsole).is_ok()
    }
}

/// A running loopback capture of the default render endpoint: everything the
/// machine is playing, as interleaved 48 kHz stereo i16.
///
/// COM must already be initialized on the calling thread, and the whole thing
/// belongs to that thread — WASAPI is happy to be called from one thread only,
/// and the capture loop is that thread.
pub struct Loopback {
    client: IAudioClient,
    capture: IAudioCaptureClient,
}

impl Loopback {
    /// Open and start the capture. Fails on a machine with no render endpoint,
    /// and on one whose audio service is not running.
    pub fn open() -> Result<Self> {
        let block_align = CHANNELS as u32 * BYTES_PER_SAMPLE;
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: CHANNELS as u16,
            nSamplesPerSec: SAMPLE_RATE_HZ,
            nAvgBytesPerSec: SAMPLE_RATE_HZ * block_align,
            nBlockAlign: block_align as u16,
            wBitsPerSample: (BYTES_PER_SAMPLE * 8) as u16,
            // No trailing WAVEFORMATEXTENSIBLE: 16-bit stereo PCM is the one
            // shape that needs none.
            cbSize: 0,
        };

        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .context("the audio endpoint enumerator")?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .context("no default render endpoint")?;
            // The null activation params are the whole reason this crate needs
            // the `Win32_System_Com_StructuredStorage` and `Win32_System_Variant`
            // features — see Cargo.toml.
            let client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .context("activate an audio client on the render endpoint")?;
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK
                        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    BUFFER_100NS,
                    // Shared mode: the periodicity is the engine's, not ours.
                    0,
                    &format,
                    None,
                )
                .context("initialize a loopback capture on the render endpoint")?;
            let capture: IAudioCaptureClient =
                client.GetService().context("the capture service")?;
            client.Start().context("start the loopback capture")?;
            Ok(Self { client, capture })
        }
    }

    /// Append everything the endpoint has buffered to `out`, and return how
    /// many interleaved samples that was.
    ///
    /// An error here is the device going away under us (a disabled endpoint, a
    /// stopped audio service, a default that moved); the caller drops the
    /// capture and re-probes rather than retrying it.
    pub fn drain(&self, out: &mut Vec<i16>) -> Result<usize> {
        let before = out.len();
        unsafe {
            loop {
                let waiting = self
                    .capture
                    .GetNextPacketSize()
                    .context("the next loopback packet")?;
                // Nothing playing raises no packet at all. That is not an
                // error and not a stall: `opus::Timeline` fills the hole.
                if waiting == 0 {
                    return Ok(out.len() - before);
                }
                let mut data: *mut u8 = ptr::null_mut();
                let mut frames: u32 = 0;
                let mut flags: u32 = 0;
                self.capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    .context("read the loopback buffer")?;

                let samples = frames as usize * CHANNELS;
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    // With SILENT set the buffer's contents are undefined, so
                    // the zeros are written here rather than read from it.
                    out.resize(out.len() + samples, 0);
                } else {
                    // SAFETY: the engine hands back `frames` frames of the
                    // format Initialize accepted — stereo i16, so 2 samples a
                    // frame — in a buffer it keeps valid until ReleaseBuffer,
                    // and it is aligned for the sample type it contains.
                    out.extend_from_slice(std::slice::from_raw_parts(data.cast::<i16>(), samples));
                }
                self.capture
                    .ReleaseBuffer(frames)
                    .context("release the loopback buffer")?;
            }
        }
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        // A stream left running holds the endpoint open for the life of the
        // process; the client itself is released by COM on the way out.
        unsafe { self.client.Stop() }.unwrap_or_else(|e| {
            ::log::warn!("swoop: the loopback capture did not stop cleanly: {e}");
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    fn com() {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .expect("com on the test thread");
    }

    /// Hardware. See the module doc for what each answer means.
    #[test]
    #[ignore]
    fn reports_whether_this_machine_has_a_render_endpoint() {
        com();
        println!("render endpoint present: {}", render_endpoint_present());
    }

    /// Hardware, and it **listens to whatever this machine is playing** for a
    /// second. See the module doc.
    #[test]
    #[ignore]
    fn captures_whatever_this_machine_is_playing() {
        use std::time::{Duration, Instant};

        com();
        let loopback = Loopback::open().expect("open a loopback capture");
        let mut pcm = Vec::new();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(1) {
            loopback.drain(&mut pcm).expect("drain");
            std::thread::sleep(Duration::from_millis(10));
        }
        let peak = pcm.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
        println!(
            "captured {} samples ({} ms of stereo), peak {peak}",
            pcm.len(),
            pcm.len() / CHANNELS * 1000 / SAMPLE_RATE_HZ as usize,
        );
        // Deliberately no assertion on the sample count: a render endpoint with
        // nothing playing delivers no packets at all, which is the case
        // `opus::Timeline` exists for and not a failure of this capture.
    }
}
