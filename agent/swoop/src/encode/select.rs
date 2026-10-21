//! Which backend a session encodes on, and what it falls to.
//!
//! The chain is NVENC → the hardware encoder MFT (`mf-hw`) → Microsoft's
//! in-box software encoder (`mf-sw`), per codec. Everything that *decides* is
//! a pure function over the [`BackendCaps`] a probe returned — [`chain_for`],
//! [`select`], [`budget`] — so the whole table is unit-testable on a machine
//! with no GPU at all. Only the probes and [`create`] touch hardware, and
//! they reach each backend through exactly two symbols, `probe()` and
//! `create()`, so this file compiles with every optional encoder feature off.
//!
//! A session probes the chain lazily ([`probe_chain`], [`probe_further`]): a
//! rung is probed only once every rung above it has failed or encodes nothing.
//! Probing `mf-hw` activates NVIDIA's own H.264 MFT, and after that every
//! `nvEncOpenEncodeSessionEx` in the process answers
//! `NV_ENC_ERR_INVALID_VERSION` — measured on an RTX 2080 Ti (610.88), and
//! what pinned an RTX 4070 Ti SUPER (576.80) to `mf-hw` on every session from
//! 4.1.9 to 4.1.11. [`probe_all`] is for the `probe` verb's own process only.
//!
//! Nothing here reads `BackendCaps::max_fps`. It is fps at the backend's
//! *largest* supported size by its own definition — 15 on this box's 2080 Ti,
//! at 8192x8192 — so selecting or tiering on it would refuse a 1080p60 session
//! a GPU does comfortably. Task 8.2 must not tier on it either until it is
//! redefined as fps at a streaming size.
//!
//! The chain is per system: the one above on Windows, VideoToolbox alone on
//! macOS, and nothing yet everywhere else.

use thiserror::Error;

use crate::encode::{BackendCaps, Codec, CodecCaps, Encoder, EncoderConfig};
use crate::ipc::Exit;

/// The fallback chain, highest tier first. A backend's position here *is* its
/// tier, and the names are the ones `BackendCaps::backend` reports and the
/// probe JSON prints.
///
/// Both rungs below NVENC are Media Foundation, in-box on every Windows install
/// (the owner's call, 2026-10-11). `mf-hw` drives whatever fixed-function
/// encoder the machine has — Intel, AMD, or NVIDIA's own MFT. `mf-sw` is last
/// because it is the only rung that costs the machine's own CPU, and it caps
/// itself at 720p30 for that reason — these are signage boxes running
/// TouchDesigner.
#[cfg(windows)]
pub const CHAIN: &[&str] = &["nvenc", "mf-hw", "mf-sw"];

/// macOS: one rung. VideoToolbox carries the hardware encoders and Apple's
/// software H.264 behind one session, and that software encoder is the no-GPU
/// floor there, so nothing sits below it (swoop-macos decision 6).
#[cfg(target_os = "macos")]
pub const CHAIN: &[&str] = &["videotoolbox"];

/// Everywhere else: no encoder, until that system's own plan.
#[cfg(not(any(windows, target_os = "macos")))]
pub const CHAIN: &[&str] = &[];

/// A backend's tier, or `None` for a name this build's chain does not know.
pub fn tier(backend: &str) -> Option<usize> {
    CHAIN.iter().position(|known| *known == backend)
}

/// One resolved choice: the backend a session opens and the codec it opens it
/// for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Selection {
    pub backend: &'static str,
    pub codec: Codec,
}

/// Nothing on this machine can encode what was asked for.
///
/// One variant on purpose: every way this ends means the same thing to the
/// process — no encoder — which is the same exit `nvenc::NvencError` maps to.
#[derive(Debug, Error)]
pub enum SelectError {
    #[error("no compiled encoder does {codec:?} at {width}x{height}")]
    NoBackend {
        codec: Codec,
        width: u32,
        height: u32,
    },
}

impl SelectError {
    pub const fn exit(&self) -> Exit {
        Exit::NoEncoder
    }
}

/// `caps` in chain order. A backend whose name is not in [`CHAIN`] sorts last
/// rather than being dropped: an unknown-but-working encoder is still better
/// than no session.
fn in_tier_order(caps: &[BackendCaps]) -> Vec<&BackendCaps> {
    let mut ordered: Vec<&BackendCaps> = caps.iter().collect();
    ordered.sort_by_key(|caps| tier(caps.backend).unwrap_or(CHAIN.len()));
    ordered
}

fn fits(caps: &BackendCaps, codec: Codec, width: u32, height: u32) -> bool {
    caps.codecs
        .iter()
        .any(|c| c.codec == codec && c.max_width >= width && c.max_height >= height)
}

/// Every backend that can do `codec` at this size, highest tier first. The
/// first entry is what a session opens; the rest are what it falls to.
pub fn chain_for(
    caps: &[BackendCaps],
    codec: Codec,
    width: u32,
    height: u32,
) -> Vec<&'static str> {
    in_tier_order(caps)
        .into_iter()
        .filter(|caps| fits(caps, codec, width, height))
        .map(|caps| caps.backend)
        .collect()
}

/// Every backend that can do `codec` at all — 0x0 fits every rung — for the
/// probe report, which describes the machine rather than one session.
pub fn backends_for(caps: &[BackendCaps], codec: Codec) -> Vec<&'static str> {
    chain_for(caps, codec, 0, 0)
}

/// The highest tier that satisfies the requested codec set at this size.
///
/// Tier first, codec second: `codecs` is the caller's preference order (D5
/// prefers H.265) but it only breaks ties *within* one backend, because a
/// session served by the top rung on its second-choice codec beats one served
/// by a lower rung on its first.
pub fn select(
    caps: &[BackendCaps],
    codecs: &[Codec],
    width: u32,
    height: u32,
) -> Option<Selection> {
    for backend in in_tier_order(caps) {
        for codec in codecs {
            if fits(backend, *codec, width, height) {
                return Some(Selection {
                    backend: backend.backend,
                    codec: *codec,
                });
            }
        }
    }
    None
}

/// How many encode sessions this machine can sustain at once — Task 8.2's tier
/// count is min(codec classes present, this).
///
/// The figure belongs to the top rung, the backend sessions actually open on,
/// and is never a sum across backends: two codecs served by two backends still
/// share one machine, and a budget that over-counts is a tier that fails to
/// open under load. Floored at 1 while any encoder exists — a backend that
/// reports no session count still does one.
pub fn budget(caps: &[BackendCaps]) -> u32 {
    in_tier_order(caps)
        .into_iter()
        .find(|caps| !caps.codecs.is_empty())
        .map_or(0, |caps| caps.concurrent_sessions.max(1))
}

/// Every rung's per-codec limits, in the order `caps` lists them — the
/// session plans its tiers from the first entry for each codec.
pub fn codec_caps(caps: &[BackendCaps]) -> Vec<CodecCaps> {
    caps.iter()
        .flat_map(|backend| backend.codecs.iter().cloned())
        .collect()
}

/// The table with `backend` out. A rung that probed fine and then could not
/// encode its first frame — the capture adapter has no encoder of its own, the
/// driver refused the session — stays out for the rest of the session, so the
/// next frame goes to the rung below it rather than to the same failure. It
/// stays in the table with nothing to offer, so [`probe_further`] never
/// probes it again.
pub fn without(caps: &[BackendCaps], backend: &str) -> Vec<BackendCaps> {
    caps.iter()
        .cloned()
        .map(|mut caps| {
            if caps.backend == backend {
                caps.codecs.clear();
            }
            caps
        })
        .collect()
}

/// What a session probes at its start: the chain from the top, down to the
/// first rung that encodes anything and no further.
pub fn probe_chain() -> Vec<BackendCaps> {
    let mut caps = Vec::new();
    probe_further(&mut caps);
    caps
}

/// Probe the next rungs `caps` has not probed yet, in chain order, down to the
/// first that encodes anything. False when the chain is spent.
pub fn probe_further(caps: &mut Vec<BackendCaps>) -> bool {
    probe_further_with(caps, CHAIN, probe_on)
}

fn probe_further_with(
    caps: &mut Vec<BackendCaps>,
    chain: &[&'static str],
    probe: impl Fn(&str) -> Option<BackendCaps>,
) -> bool {
    let mut added = false;
    for &rung in chain {
        if caps.iter().any(|c| c.backend == rung) {
            continue;
        }
        let Some(found) = probe(rung) else {
            continue;
        };
        let encodes = !found.codecs.is_empty();
        caps.push(found);
        added = true;
        if encodes {
            break;
        }
    }
    added
}

/// One rung's own probe, or `None` when this build does not carry it.
// the argument is unused when no backend is compiled in
#[allow(unused_variables)]
fn probe_on(backend: &str) -> Option<BackendCaps> {
    #[cfg(all(windows, feature = "encode-nvenc"))]
    if backend == "nvenc" {
        return Some(crate::encode::nvenc::probe());
    }
    #[cfg(all(windows, feature = "encode-mf"))]
    if backend == "mf-hw" {
        return Some(crate::encode::mf::hw::probe());
    }
    #[cfg(all(windows, feature = "encode-mf"))]
    if backend == "mf-sw" {
        return Some(crate::encode::mf::sw::probe());
    }
    #[cfg(all(target_os = "macos", feature = "encode-videotoolbox"))]
    if backend == "videotoolbox" {
        return Some(crate::encode::videotoolbox::probe());
    }
    None
}

/// What every backend compiled into this build reports, in chain order — for
/// the `probe` verb, a process that never encodes after it. A session uses
/// [`probe_chain`]: see the module head for what probing every rung breaks.
///
/// Each `probe()` is expected to
/// answer on a machine its vendor never touched — that is how a non-NVIDIA box
/// gets an empty NVENC entry rather than a failure to start.
pub fn probe_all() -> Vec<BackendCaps> {
    CHAIN.iter().filter_map(|rung| probe_on(rung)).collect()
}

/// `None` when this build does not carry `backend` — a probed table always
/// names backends that are compiled in, but an injected one (a test, a bundle
/// override) need not.
// the arguments are unused when no backend is compiled in
#[allow(unused_variables)]
fn create_on(backend: &str, cfg: &EncoderConfig) -> Option<anyhow::Result<Box<dyn Encoder>>> {
    #[cfg(all(windows, feature = "encode-nvenc"))]
    if backend == "nvenc" {
        return Some(crate::encode::nvenc::create(cfg));
    }
    #[cfg(all(windows, feature = "encode-mf"))]
    if backend == "mf-hw" {
        return Some(crate::encode::mf::hw::create(cfg));
    }
    #[cfg(all(windows, feature = "encode-mf"))]
    if backend == "mf-sw" {
        return Some(crate::encode::mf::sw::create(cfg));
    }
    #[cfg(all(target_os = "macos", feature = "encode-videotoolbox"))]
    if backend == "videotoolbox" {
        return Some(crate::encode::videotoolbox::create(cfg));
    }
    None
}

/// Open the best encoder for `cfg`, walking down the chain.
///
/// A backend that probed fine can still refuse a session — NVENC answers
/// `0x887A0001` when another process holds the encoder — so a refusal costs one
/// rung rather than the session: once every probed rung has refused, the rungs
/// below are probed into `caps` and tried in turn.
pub fn create(
    caps: &mut Vec<BackendCaps>,
    cfg: &EncoderConfig,
) -> anyhow::Result<(&'static str, Box<dyn Encoder>)> {
    create_with(caps, cfg, CHAIN, probe_on)
}

fn create_with(
    caps: &mut Vec<BackendCaps>,
    cfg: &EncoderConfig,
    chain: &[&'static str],
    probe: impl Fn(&str) -> Option<BackendCaps>,
) -> anyhow::Result<(&'static str, Box<dyn Encoder>)> {
    let mut last: Option<anyhow::Error> = None;
    let mut tried: Vec<&'static str> = Vec::new();
    loop {
        for backend in chain_for(caps, cfg.codec, cfg.width, cfg.height) {
            if tried.contains(&backend) {
                continue;
            }
            tried.push(backend);
            match create_on(backend, cfg) {
                Some(Ok(encoder)) => return Ok((backend, encoder)),
                Some(Err(e)) => {
                    ::log::warn!("swoop: encoder {backend} refused the session: {e:#}");
                    last = Some(e);
                }
                None => {}
            }
        }
        if !probe_further_with(caps, chain, &probe) {
            break;
        }
    }
    Err(last.unwrap_or_else(|| {
        SelectError::NoBackend {
            codec: cfg.codec,
            width: cfg.width,
            height: cfg.height,
        }
        .into()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::CodecCaps;

    fn caps(backend: &'static str, codecs: &[(Codec, u32, u32)], sessions: u32) -> BackendCaps {
        BackendCaps {
            backend,
            codecs: codecs
                .iter()
                .map(|(codec, max_width, max_height)| CodecCaps {
                    codec: *codec,
                    max_width: *max_width,
                    max_height: *max_height,
                })
                .collect(),
            accepts_bgra_texture: true,
            max_fps: 60,
            concurrent_sessions: sessions,
        }
    }

    /// An RTX-class part: HEVC to 8192, H.264 to the codec's own 4096.
    #[cfg(windows)]
    fn nvidia() -> Vec<BackendCaps> {
        vec![caps(
            "nvenc",
            &[(Codec::H265, 8192, 8192), (Codec::H264, 4096, 4096)],
            8,
        )]
    }

    /// An Intel iGPU: its Quick Sync MFT, H.264 only, and the software floor
    /// beside it, as `probe_all` would answer.
    #[cfg(windows)]
    fn intel() -> Vec<BackendCaps> {
        [vec![caps("mf-hw", &[(Codec::H264, 4096, 4096)], 4)], no_gpu()].concat()
    }

    /// A VM: the software floor at its 720p ceiling.
    #[cfg(windows)]
    fn no_gpu() -> Vec<BackendCaps> {
        vec![caps("mf-sw", &[(Codec::H264, 1280, 720)], 4)]
    }

    /// A Mac with Apple silicon, as the rig's probe answered: HEVC to 8192x8192
    /// and H.264 to 4096x4096 in hardware.
    #[cfg(target_os = "macos")]
    fn apple_silicon() -> Vec<BackendCaps> {
        vec![caps(
            "videotoolbox",
            &[(Codec::H265, 8192, 8192), (Codec::H264, 4096, 4096)],
            4,
        )]
    }

    #[cfg(any(windows, target_os = "macos"))]
    struct Case {
        name: &'static str,
        caps: Vec<BackendCaps>,
        codecs: Vec<Codec>,
        width: u32,
        height: u32,
        want: Option<(&'static str, Codec)>,
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn run(cases: Vec<Case>) {
        for case in cases {
            let got = select(&case.caps, &case.codecs, case.width, case.height)
                .map(|s| (s.backend, s.codec));
            assert_eq!(got, case.want, "{}", case.name);
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_table_picks_the_highest_rung_that_fits() {
        let cases = vec![
            Case {
                name: "nvidia only, hevc preferred",
                caps: nvidia(),
                codecs: vec![Codec::H265, Codec::H264],
                width: 1920,
                height: 1080,
                want: Some(("nvenc", Codec::H265)),
            },
            Case {
                name: "intel only: hevc preferred, the mft does h264",
                caps: intel(),
                codecs: vec![Codec::H265, Codec::H264],
                width: 1920,
                height: 1080,
                want: Some(("mf-hw", Codec::H264)),
            },
            Case {
                name: "intel only, inside the software ceiling, still the hardware",
                caps: intel(),
                codecs: vec![Codec::H264],
                width: 1280,
                height: 720,
                want: Some(("mf-hw", Codec::H264)),
            },
            Case {
                name: "no gpu, inside the software ceiling",
                caps: no_gpu(),
                codecs: vec![Codec::H265, Codec::H264],
                width: 1280,
                height: 720,
                want: Some(("mf-sw", Codec::H264)),
            },
            Case {
                name: "no gpu, 1080p is above the software ceiling",
                caps: no_gpu(),
                codecs: vec![Codec::H264],
                width: 1920,
                height: 1080,
                want: None,
            },
            Case {
                name: "hevc requested, only h264 available",
                caps: vec![caps("nvenc", &[(Codec::H264, 4096, 4096)], 8)],
                codecs: vec![Codec::H265, Codec::H264],
                width: 1920,
                height: 1080,
                want: Some(("nvenc", Codec::H264)),
            },
            Case {
                name: "hevc only requested, only h264 available",
                caps: vec![caps("nvenc", &[(Codec::H264, 4096, 4096)], 8)],
                codecs: vec![Codec::H265],
                width: 1920,
                height: 1080,
                want: None,
            },
            Case {
                name: "the top rung's second codec beats a lower rung's first",
                caps: vec![
                    caps("nvenc", &[(Codec::H264, 4096, 4096)], 8),
                    caps("mf-hw", &[(Codec::H265, 4096, 4096)], 4),
                ],
                codecs: vec![Codec::H265, Codec::H264],
                width: 1920,
                height: 1080,
                want: Some(("nvenc", Codec::H264)),
            },
            Case {
                name: "an ultrawide above the h264 ceiling falls to hevc, not to a lower rung",
                caps: [nvidia(), no_gpu()].concat(),
                codecs: vec![Codec::H264, Codec::H265],
                width: 5120,
                height: 2160,
                want: Some(("nvenc", Codec::H265)),
            },
            Case {
                name: "no backend at all",
                caps: Vec::new(),
                codecs: vec![Codec::H265, Codec::H264],
                width: 1920,
                height: 1080,
                want: None,
            },
        ];
        run(cases);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_table_is_videotoolbox_alone() {
        assert_eq!(CHAIN, ["videotoolbox"]);
        run(vec![
            Case {
                name: "hevc preferred",
                caps: apple_silicon(),
                codecs: vec![Codec::H265, Codec::H264],
                width: 1920,
                height: 1080,
                want: Some(("videotoolbox", Codec::H265)),
            },
            Case {
                name: "a viewer that decodes h264 only",
                caps: apple_silicon(),
                codecs: vec![Codec::H264],
                width: 2880,
                height: 1864,
                want: Some(("videotoolbox", Codec::H264)),
            },
            Case {
                name: "a 5k display above the h264 ceiling falls to hevc",
                caps: apple_silicon(),
                codecs: vec![Codec::H264, Codec::H265],
                width: 5120,
                height: 2880,
                want: Some(("videotoolbox", Codec::H265)),
            },
            Case {
                name: "a 5k display, h264 only",
                caps: apple_silicon(),
                codecs: vec![Codec::H264],
                width: 5120,
                height: 2880,
                want: None,
            },
            Case {
                name: "no hardware: apple's software h264 is the floor",
                caps: vec![caps("videotoolbox", &[(Codec::H264, 4096, 2304)], 4)],
                codecs: vec![Codec::H265, Codec::H264],
                width: 1920,
                height: 1080,
                want: Some(("videotoolbox", Codec::H264)),
            },
            Case {
                name: "no backend at all",
                caps: Vec::new(),
                codecs: vec![Codec::H265, Codec::H264],
                width: 1920,
                height: 1080,
                want: None,
            },
        ]);

        // a name this chain does not know still sorts below it
        let answered = [caps("vt", &[(Codec::H264, 4096, 4096)], 2), apple_silicon().remove(0)];
        assert_eq!(chain_for(&answered, Codec::H264, 1920, 1080), vec!["videotoolbox", "vt"]);
        assert_eq!(budget(&apple_silicon()), 4);
    }

    #[cfg(windows)]
    #[test]
    fn the_chain_is_tier_order_whatever_order_the_probes_answered_in() {
        let caps = vec![
            caps("mf-sw", &[(Codec::H264, 1280, 720)], 4),
            caps("mf-hw", &[(Codec::H264, 4096, 4096)], 4),
            caps("nvenc", &[(Codec::H264, 4096, 4096)], 8),
        ];
        assert_eq!(
            chain_for(&caps, Codec::H264, 1280, 720),
            vec!["nvenc", "mf-hw", "mf-sw"]
        );
        // the size filter removes rungs, it does not reorder them
        assert_eq!(
            chain_for(&caps, Codec::H264, 1920, 1080),
            vec!["nvenc", "mf-hw"]
        );
        assert!(chain_for(&caps, Codec::H265, 1920, 1080).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn an_unknown_backend_is_a_last_resort_rather_than_a_silent_drop() {
        let caps = vec![
            caps("vt", &[(Codec::H264, 4096, 4096)], 2),
            caps("nvenc", &[(Codec::H264, 4096, 4096)], 8),
        ];
        assert_eq!(tier("vt"), None);
        assert_eq!(chain_for(&caps, Codec::H264, 1920, 1080), vec!["nvenc", "vt"]);
    }

    #[cfg(windows)]
    #[test]
    fn a_rung_that_failed_its_first_frame_hands_the_session_to_the_next() {
        // an intel box whose display hangs off an adapter with no encoder:
        // the hardware mft probes fine and cannot open on the capture device
        let probed = intel();
        assert_eq!(
            select(&probed, &[Codec::H264], 1280, 720).map(|s| s.backend),
            Some("mf-hw")
        );
        let left = without(&probed, "mf-hw");
        assert_eq!(
            select(&left, &[Codec::H264], 1280, 720).map(|s| s.backend),
            Some("mf-sw")
        );
        // the limits the session re-plans from are the floor's now
        let limits = codec_caps(&left);
        assert_eq!(
            limits.iter().map(|c| (c.max_width, c.max_height)).collect::<Vec<_>>(),
            vec![(1280, 720)]
        );
        // and with the floor gone too there is nothing, which is exit 13
        assert!(codec_caps(&without(&left, "mf-sw")).is_empty());
    }

    /// A probe over a fixed machine that records every rung it is asked for.
    #[cfg(windows)]
    fn recording<'a>(
        machine: &'a [BackendCaps],
        asked: &'a std::cell::RefCell<Vec<String>>,
    ) -> impl Fn(&str) -> Option<BackendCaps> + Copy + 'a {
        move |rung| {
            asked.borrow_mut().push(rung.to_owned());
            machine.iter().find(|c| c.backend == rung).cloned()
        }
    }

    #[cfg(windows)]
    const WINDOWS_CHAIN: &[&str] = &["nvenc", "mf-hw", "mf-sw"];

    /// 4.1.9-4.1.11 probed every rung up front, and probing NVIDIA's MFT broke
    /// NVENC for the rest of the process: every NVIDIA host streamed on mf-hw.
    #[cfg(windows)]
    #[test]
    fn a_session_probes_no_rung_below_the_first_that_encodes() {
        let machine = [
            nvidia(),
            vec![
                caps("mf-hw", &[(Codec::H264, 4096, 4096)], 4),
                caps("mf-sw", &[(Codec::H264, 1280, 720)], 4),
            ],
        ]
        .concat();
        let asked = std::cell::RefCell::new(Vec::new());
        let probe = recording(&machine, &asked);

        let mut caps = Vec::new();
        assert!(probe_further_with(&mut caps, WINDOWS_CHAIN, probe));
        assert_eq!(*asked.borrow(), ["nvenc"], "a working nvenc is the only rung touched");

        // nvenc fails its first frame: out, and only now is the next rung probed
        caps = without(&caps, "nvenc");
        assert!(probe_further_with(&mut caps, WINDOWS_CHAIN, probe));
        assert_eq!(*asked.borrow(), ["nvenc", "mf-hw"]);
        assert_eq!(
            select(&caps, &[Codec::H265, Codec::H264], 1920, 1080).map(|s| s.backend),
            Some("mf-hw")
        );

        caps = without(&caps, "mf-hw");
        assert!(probe_further_with(&mut caps, WINDOWS_CHAIN, probe));
        assert_eq!(*asked.borrow(), ["nvenc", "mf-hw", "mf-sw"]);
        caps = without(&caps, "mf-sw");
        assert!(!probe_further_with(&mut caps, WINDOWS_CHAIN, probe), "the chain is spent");
        assert!(codec_caps(&caps).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn a_box_without_nvenc_probes_down_to_its_hardware_mft_and_stops() {
        let machine = vec![
            caps("nvenc", &[], 0),
            caps("mf-hw", &[(Codec::H264, 4096, 4096)], 4),
            caps("mf-sw", &[(Codec::H264, 1280, 720)], 4),
        ];
        let asked = std::cell::RefCell::new(Vec::new());
        let probe = recording(&machine, &asked);
        let mut caps = Vec::new();
        assert!(probe_further_with(&mut caps, WINDOWS_CHAIN, probe));
        assert_eq!(*asked.borrow(), ["nvenc", "mf-hw"]);
        assert_eq!(budget(&caps), 4, "the budget is the rung that encodes");
    }

    #[cfg(windows)]
    #[test]
    fn the_budget_is_the_top_rungs_and_never_a_sum() {
        assert_eq!(budget(&nvidia()), 8);
        assert_eq!(budget(&no_gpu()), 4);
        assert_eq!(budget(&[]), 0);
        // two backends, one machine
        assert_eq!(budget(&[nvidia(), no_gpu()].concat()), 8);
        // a backend that lists codecs but no session count still does one
        assert_eq!(budget(&[caps("mf-hw", &[(Codec::H264, 4096, 4096)], 0)]), 1);
        // an entry with no codecs is not a backend
        assert_eq!(budget(&[caps("nvenc", &[], 8), caps("mf-hw", &[(Codec::H264, 4096, 4096)], 2)]), 2);
    }

    /// The whole point of the injected table: no rung of this one is compiled
    /// into any build, so the test never touches a driver whatever the feature
    /// set. No backend is named "vt" (VideoToolbox's is "videotoolbox").
    #[test]
    fn a_backend_this_build_does_not_carry_is_exit_13() {
        let cfg = EncoderConfig {
            codec: Codec::H264,
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_bps: 8_000_000,
        };
        let mut table = vec![caps("vt", &[(Codec::H264, 4096, 4096)], 2)];
        let Err(err) = create_with(&mut table, &cfg, &[], |_| None) else {
            panic!("no build carries a vt backend");
        };
        let typed = err
            .downcast_ref::<SelectError>()
            .expect("a selection failure, not a backend failure");
        assert_eq!(typed.exit(), Exit::NoEncoder);
        assert_eq!(typed.exit().code(), 13);
    }
}
