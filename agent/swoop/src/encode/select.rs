//! Which backend a session encodes on, and what it falls to.
//!
//! The chain is NVENC → the hardware backend spike 6.7 picks (Task 7.1) → the
//! software floor (Task 7.2), per codec. Everything that *decides* is a pure
//! function over the [`BackendCaps`] a probe returned — [`chain_for`],
//! [`select`], [`budget`] — so the whole table is unit-testable on a machine
//! with no GPU at all. Only [`probe_all`] and [`create`] touch hardware, and
//! they reach each backend through exactly two symbols, `probe()` and
//! `create()`, so this file compiles with every optional encoder feature off.
//!
//! Nothing here reads `BackendCaps::max_fps`. It is fps at the backend's
//! *largest* supported size by its own definition — 15 on this box's 2080 Ti,
//! at 8192x8192 — so selecting or tiering on it would refuse a 1080p60 session
//! a GPU does comfortably. Task 8.2 must not tier on it either until it is
//! redefined as fps at a streaming size.
//!
//! Spike 6.7 has not run, so every rung below NVENC is a stub behind a feature
//! that is off — which is the default build. `probe_all` then returns NVENC
//! alone, or nothing at all on a machine without it, and the table still
//! resolves.

use thiserror::Error;

use crate::encode::{BackendCaps, Codec, Encoder, EncoderConfig};
use crate::ipc::Exit;

/// The fallback chain, highest tier first. A backend's position here *is* its
/// tier, and the names are the ones `BackendCaps::backend` reports and the
/// probe JSON prints.
///
/// Media Foundation sits above the software floor rather than beside it: it is
/// in-box on every Windows install and drives whatever fixed-function encoder
/// the machine has, so it is still hardware on a box whose vendor SDK we did
/// not build. `openh264` is last because it is the only rung that costs the
/// machine's own CPU — these are signage boxes running TouchDesigner.
pub const CHAIN: [&str; 5] = ["nvenc", "qsv", "amf", "mf", "openh264"];

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

/// What every backend compiled into this build reports, in chain order.
///
/// The only hardware call in the selection path. Each `probe()` is expected to
/// answer on a machine its vendor never touched — that is how a non-NVIDIA box
/// gets an empty NVENC entry rather than a failure to start.
// both allows are the cfg gating: with no backend compiled in nothing pushes,
// and with one the pushes cannot collapse into a `vec![]` literal
#[allow(unused_mut, clippy::vec_init_then_push)]
pub fn probe_all() -> Vec<BackendCaps> {
    let mut caps: Vec<BackendCaps> = Vec::new();
    #[cfg(all(windows, feature = "encode-nvenc"))]
    caps.push(crate::encode::nvenc::probe());
    #[cfg(all(windows, any(feature = "encode-vpl", feature = "encode-ffmpeg")))]
    caps.push(crate::encode::qsv::probe());
    #[cfg(all(windows, any(feature = "encode-amf", feature = "encode-ffmpeg")))]
    caps.push(crate::encode::amf::probe());
    #[cfg(all(windows, feature = "encode-mf"))]
    caps.push(crate::encode::mf::probe());
    #[cfg(any(feature = "encode-openh264", feature = "encode-ffmpeg"))]
    caps.push(crate::encode::soft::probe());
    caps
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
    #[cfg(all(windows, any(feature = "encode-vpl", feature = "encode-ffmpeg")))]
    if backend == "qsv" {
        return Some(crate::encode::qsv::create(cfg));
    }
    #[cfg(all(windows, any(feature = "encode-amf", feature = "encode-ffmpeg")))]
    if backend == "amf" {
        return Some(crate::encode::amf::create(cfg));
    }
    #[cfg(all(windows, feature = "encode-mf"))]
    if backend == "mf" {
        return Some(crate::encode::mf::create(cfg));
    }
    #[cfg(any(feature = "encode-openh264", feature = "encode-ffmpeg"))]
    if backend == "openh264" {
        return Some(crate::encode::soft::create(cfg));
    }
    None
}

/// Open the best encoder for `cfg`, walking down the chain.
///
/// A backend that probed fine can still refuse a session — NVENC answers
/// `0x887A0001` when another process holds the encoder — so a refusal costs one
/// rung rather than the session.
pub fn create(
    caps: &[BackendCaps],
    cfg: &EncoderConfig,
) -> anyhow::Result<(&'static str, Box<dyn Encoder>)> {
    let mut last: Option<anyhow::Error> = None;
    for backend in chain_for(caps, cfg.codec, cfg.width, cfg.height) {
        match create_on(backend, cfg) {
            Some(Ok(encoder)) => return Ok((backend, encoder)),
            Some(Err(e)) => {
                ::log::warn!("swoop: encoder {backend} refused the session: {e:#}");
                last = Some(e);
            }
            None => {}
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
    fn nvidia() -> Vec<BackendCaps> {
        vec![caps(
            "nvenc",
            &[(Codec::H265, 8192, 8192), (Codec::H264, 4096, 4096)],
            8,
        )]
    }

    fn intel() -> Vec<BackendCaps> {
        vec![caps(
            "qsv",
            &[(Codec::H265, 4096, 4096), (Codec::H264, 4096, 4096)],
            4,
        )]
    }

    /// A VM: the software floor at its measured 720p ceiling, one session.
    fn no_gpu() -> Vec<BackendCaps> {
        vec![caps("openh264", &[(Codec::H264, 1280, 720)], 1)]
    }

    struct Case {
        name: &'static str,
        caps: Vec<BackendCaps>,
        codecs: Vec<Codec>,
        width: u32,
        height: u32,
        want: Option<(&'static str, Codec)>,
    }

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
                name: "intel only",
                caps: intel(),
                codecs: vec![Codec::H265, Codec::H264],
                width: 1920,
                height: 1080,
                want: Some(("qsv", Codec::H265)),
            },
            Case {
                name: "no gpu, inside the software ceiling",
                caps: no_gpu(),
                codecs: vec![Codec::H265, Codec::H264],
                width: 1280,
                height: 720,
                want: Some(("openh264", Codec::H264)),
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
                    caps("qsv", &[(Codec::H265, 4096, 4096)], 4),
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

        for case in cases {
            let got = select(&case.caps, &case.codecs, case.width, case.height)
                .map(|s| (s.backend, s.codec));
            assert_eq!(got, case.want, "{}", case.name);
        }
    }

    #[test]
    fn the_chain_is_tier_order_whatever_order_the_probes_answered_in() {
        let caps = vec![
            caps("openh264", &[(Codec::H264, 1920, 1080)], 1),
            caps("mf", &[(Codec::H264, 4096, 4096)], 2),
            caps("nvenc", &[(Codec::H264, 4096, 4096)], 8),
        ];
        assert_eq!(
            chain_for(&caps, Codec::H264, 1920, 1080),
            vec!["nvenc", "mf", "openh264"]
        );
        // the size filter removes rungs, it does not reorder them
        assert_eq!(
            chain_for(&caps, Codec::H264, 3840, 2160),
            vec!["nvenc", "mf"]
        );
        assert!(chain_for(&caps, Codec::H265, 1920, 1080).is_empty());
    }

    #[test]
    fn an_unknown_backend_is_a_last_resort_rather_than_a_silent_drop() {
        let caps = vec![
            caps("vt", &[(Codec::H264, 4096, 4096)], 2),
            caps("nvenc", &[(Codec::H264, 4096, 4096)], 8),
        ];
        assert_eq!(tier("vt"), None);
        assert_eq!(chain_for(&caps, Codec::H264, 1920, 1080), vec!["nvenc", "vt"]);
    }

    #[test]
    fn the_budget_is_the_top_rungs_and_never_a_sum() {
        assert_eq!(budget(&nvidia()), 8);
        assert_eq!(budget(&no_gpu()), 1);
        assert_eq!(budget(&[]), 0);
        // two backends, one machine
        assert_eq!(budget(&[nvidia(), no_gpu()].concat()), 8);
        // a backend that lists codecs but no session count still does one
        assert_eq!(budget(&[caps("mf", &[(Codec::H264, 4096, 4096)], 0)]), 1);
        // an entry with no codecs is not a backend
        assert_eq!(budget(&[caps("nvenc", &[], 8), caps("mf", &[(Codec::H264, 4096, 4096)], 2)]), 2);
    }

    /// The whole point of the injected table: no rung of this one is compiled
    /// into any build, so the test never touches a driver whatever the feature
    /// set — "vt" is Wave 9's VideoToolbox name and does not exist yet.
    #[test]
    fn a_backend_this_build_does_not_carry_is_exit_13() {
        let cfg = EncoderConfig {
            codec: Codec::H264,
            width: 1280,
            height: 720,
            fps: 30,
            bitrate_bps: 8_000_000,
        };
        let table = vec![caps("vt", &[(Codec::H264, 4096, 4096)], 2)];
        let Err(err) = create(&table, &cfg) else {
            panic!("no build carries a vt backend");
        };
        let typed = err
            .downcast_ref::<SelectError>()
            .expect("a selection failure, not a backend failure");
        assert_eq!(typed.exit(), Exit::NoEncoder);
        assert_eq!(typed.exit().code(), 13);
    }
}
