//! Quality presets: the ceiling one viewer asks for, and the rungs the
//! governor is allowed to descend through underneath it.
//!
//! # A preset is a ceiling, never a setting
//!
//! Every number here is an upper bound. The governor still adapts below it, so
//! a menu entry is a promise about what will *not* be exceeded and never a
//! promise about what will be delivered — which is why nothing in this module
//! reports a rate and why the stats line shows the ceiling and the achieved
//! rate as two separate numbers.
//!
//! # Only three fields cross the wire, and which axis rides in which one
//!
//! PROTOCOL.md §5's `quality` is `{ preset, maxBitrateKbps, maxFps }` and
//! [`crate::signal::messages`] is `deny_unknown_fields`, so there is no room
//! for a fourth axis and none is invented. The two numbers are authoritative
//! for their own axes; `preset` carries the **resolution cap**, the one axis
//! with no field of its own. The label a stats line shows is rendered from the
//! ceiling here rather than parsed back out of that string, so each axis has
//! exactly one source of truth.
//!
//! # Codec preference is deliberately not a field here
//!
//! Spike 2.12 measured Edge 153 exposing no `video/H265` to `RTCRtpReceiver`
//! on the same box where it decodes HEVC happily through WebCodecs. So the
//! preference has to be negotiated from *receiver* capabilities, which means it
//! rides the browser's **offer** — and the offer is exactly where
//! [`crate::session::pick_codec`] reads it. A codec field on this ceiling would
//! be a second, later, contradicting statement of the same choice.
//!
//! # The bottom rung is not the floor frame rate
//!
//! [`MIN_LADDER_FPS`] is the least *motion* this ladder will trade down to.
//! `session`'s `FloorTimer` is a different mechanism for a different problem: a
//! static desktop produces no frames at all and a hardware decoder handed
//! nothing stalls, so the last picture is re-sent at 2 Hz however low this
//! ladder has gone.

use crate::gpu::scale::Limits;

/// The bandwidth rungs the menu offers. A viewer may ask for a number between
/// them — these are what the ui puts in front of a person, not a whitelist.
pub const BITRATE_CAPS_BPS: [u32; 5] = [
    5_000_000,
    10_000_000,
    20_000_000,
    30_000_000,
    50_000_000,
];

/// `auto`: 20 Mbps is what the bake-off measured arm B at end to end.
pub const DEFAULT_BITRATE_BPS: u32 = 20_000_000;

/// The frame-rate rungs the menu offers, and `auto` is the first of them.
pub const FPS_CAPS: [u32; 2] = [60, 30];

/// Desktop Duplication is vsync-locked at the panel's rate and the encoder's
/// rate control is sized for 60.
pub const DEFAULT_FPS: u32 = 60;

/// The least motion the ladder will trade down to. Below this the picture is a
/// slideshow and there is nothing left to give up that a viewer would rather
/// have than a disconnect.
pub const MIN_LADDER_FPS: u32 = 15;

/// A cap on the encoded picture's height, aspect ratio preserved.
///
/// Height and not width, because that is the axis every one of these names
/// refers to and because an ultrawide capped on width would keep every one of
/// its pixel rows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ResolutionCap {
    /// No cap of our own — the encoder's own limits still apply.
    #[default]
    Native,
    P1440,
    P1080,
    P720,
}

impl ResolutionCap {
    /// Richest first. This is the order the governor descends in and the order
    /// the menu lists.
    pub const LADDER: [ResolutionCap; 4] = [
        ResolutionCap::Native,
        ResolutionCap::P1440,
        ResolutionCap::P1080,
        ResolutionCap::P720,
    ];

    pub fn max_height(self) -> Option<u32> {
        match self {
            ResolutionCap::Native => None,
            ResolutionCap::P1440 => Some(1440),
            ResolutionCap::P1080 => Some(1080),
            ResolutionCap::P720 => Some(720),
        }
    }

    /// What `quality.preset` spells this as. `web/lib/swoop/protocol.ts` sends
    /// the same tokens.
    pub fn wire_name(self) -> &'static str {
        match self {
            ResolutionCap::Native => "native",
            ResolutionCap::P1440 => "1440p",
            ResolutionCap::P1080 => "1080p",
            ResolutionCap::P720 => "720p",
        }
    }

    /// A token this host does not know is [`ResolutionCap::Native`]: an unknown
    /// preset must never be read as a *tighter* cap than the viewer asked for,
    /// because the viewer would then see a picture it cannot explain.
    pub fn parse(token: &str) -> Self {
        ResolutionCap::LADDER
            .into_iter()
            .find(|cap| cap.wire_name() == token)
            .unwrap_or(ResolutionCap::Native)
    }

    /// Narrow a backend's own limits by this cap, so one `scale::plan` call
    /// answers both. The cap can only ever tighten the encoder's limit.
    pub fn narrow(self, limits: Limits) -> Limits {
        match self.max_height() {
            None => limits,
            Some(height) => Limits {
                max_height: limits.max_height.min(height),
                ..limits
            },
        }
    }

    /// The next cap down, or `None` at the bottom.
    fn next_down(self) -> Option<ResolutionCap> {
        let at = ResolutionCap::LADDER.iter().position(|&cap| cap == self)?;
        ResolutionCap::LADDER.get(at + 1).copied()
    }
}

/// One viewer's ceiling, on every axis at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ceiling {
    pub bitrate_bps: u32,
    pub fps: u32,
    pub resolution: ResolutionCap,
}

impl Default for Ceiling {
    /// `auto`, the preset a session starts in.
    fn default() -> Self {
        Self {
            bitrate_bps: DEFAULT_BITRATE_BPS,
            fps: DEFAULT_FPS,
            resolution: ResolutionCap::Native,
        }
    }
}

impl Ceiling {
    /// Read one §5 `quality` message. A zero on either number means "unstated"
    /// and takes the default rather than a ceiling of nothing — a viewer can
    /// ask for less, but it cannot ask for a session that will not run.
    pub fn from_quality(preset: &str, max_bitrate_kbps: u32, max_fps: u32) -> Self {
        let bitrate_bps = match max_bitrate_kbps {
            0 => DEFAULT_BITRATE_BPS,
            kbps => kbps
                .saturating_mul(1_000)
                .clamp(BITRATE_CAPS_BPS[0], BITRATE_CAPS_BPS[BITRATE_CAPS_BPS.len() - 1]),
        };
        let fps = match max_fps {
            0 => DEFAULT_FPS,
            fps => fps.clamp(MIN_LADDER_FPS, DEFAULT_FPS),
        };
        Self {
            bitrate_bps,
            fps,
            resolution: ResolutionCap::parse(preset),
        }
    }

    /// The whole ceiling as one word for a stats line. Rendered, never parsed:
    /// the numeric fields are the truth and this is their spelling.
    pub fn label(&self) -> String {
        if *self == Ceiling::default() {
            return "auto".to_owned();
        }
        format!(
            "{}mbps/{}/{}fps",
            self.bitrate_bps / 1_000_000,
            self.resolution.wire_name(),
            self.fps
        )
    }

    /// Narrow a backend's limits by this ceiling's resolution cap.
    pub fn narrow(&self, limits: Limits) -> Limits {
        self.resolution.narrow(limits)
    }

    /// The ladder the governor descends, richest first, always starting at this
    /// ceiling itself.
    ///
    /// Frame rate is spent before resolution because that is the cheaper thing
    /// to give up and the easier one to give back, and the two are one sequence
    /// rather than two so recovery can only ever retrace the descent. A single
    /// index over a single ladder cannot oscillate between axes, which two
    /// independent counters very much can.
    pub fn rungs(&self) -> Vec<QualityRung> {
        let mut rungs = Vec::new();
        let mut fps_steps = vec![self.fps];
        for fps in FPS_CAPS.into_iter().chain([MIN_LADDER_FPS]) {
            if fps < *fps_steps.last().expect("seeded with the ceiling") {
                fps_steps.push(fps);
            }
        }
        for fps in &fps_steps {
            rungs.push(QualityRung {
                fps: *fps,
                resolution: self.resolution,
            });
        }

        let slowest = *fps_steps.last().expect("seeded with the ceiling");
        let mut resolution = self.resolution;
        while let Some(next) = resolution.next_down() {
            resolution = next;
            rungs.push(QualityRung {
                fps: slowest,
                resolution,
            });
        }
        rungs
    }
}

/// One step of [`Ceiling::rungs`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QualityRung {
    pub fps: u32,
    pub resolution: ResolutionCap,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unstated_quality_message_is_the_auto_preset() {
        let ceiling = Ceiling::from_quality("", 0, 0);
        assert_eq!(ceiling, Ceiling::default());
        assert_eq!(ceiling.label(), "auto");
    }

    #[test]
    fn a_preset_token_this_host_does_not_know_caps_nothing() {
        // The failure to avoid is the opposite one: reading an unknown token as
        // a tighter cap would shrink a picture for a reason the viewer has no
        // way to see.
        assert_eq!(ResolutionCap::parse("4320p"), ResolutionCap::Native);
        assert_eq!(ResolutionCap::parse("1080P"), ResolutionCap::Native);
        assert_eq!(ResolutionCap::parse("1080p"), ResolutionCap::P1080);
    }

    #[test]
    fn the_numbers_are_clamped_into_the_menus_range() {
        let ceiling = Ceiling::from_quality("720p", 500_000, 240);
        assert_eq!(ceiling.bitrate_bps, 50_000_000, "clamped at the top rung");
        assert_eq!(ceiling.fps, DEFAULT_FPS);
        assert_eq!(ceiling.resolution, ResolutionCap::P720);
        assert_eq!(ceiling.label(), "50mbps/720p/60fps");

        let low = Ceiling::from_quality("native", 1, 1);
        assert_eq!(low.bitrate_bps, BITRATE_CAPS_BPS[0]);
        assert_eq!(low.fps, MIN_LADDER_FPS);
    }

    #[test]
    fn a_cap_only_ever_tightens_the_backends_own_limit() {
        let nvenc_hevc = Limits {
            max_width: 8192,
            max_height: 8192,
        };
        assert_eq!(
            ResolutionCap::P1080.narrow(nvenc_hevc),
            Limits {
                max_width: 8192,
                max_height: 1080
            }
        );
        // An AMF-sized limit is already below the cap and stays where it is.
        let amf = Limits::square(4096);
        assert_eq!(ResolutionCap::Native.narrow(amf), amf);
        assert_eq!(ResolutionCap::P1440.narrow(Limits::square(720)).max_height, 720);
    }

    /// Aspect ratio is `scale::plan`'s to preserve, and this proves the two
    /// compose: the cap is expressed as a limit and nothing here does its own
    /// arithmetic on a picture.
    #[test]
    fn the_cap_reaches_the_encoder_through_scale_plan() {
        use crate::gpu::scale::{plan, Plan};
        let limits = ResolutionCap::P1080.narrow(Limits::square(4096));
        assert_eq!(
            plan((3840, 2160), limits),
            Plan::Downscale {
                width: 1920,
                height: 1080
            }
        );
        // An ultrawide keeps its shape: the height is what is capped.
        assert_eq!(
            plan((3440, 1440), ResolutionCap::P1080.narrow(Limits::square(4096))),
            Plan::Downscale {
                width: 2580,
                height: 1080
            }
        );
    }

    #[test]
    fn the_ladder_spends_frame_rate_before_it_spends_pixels() {
        let rungs = Ceiling::default().rungs();
        assert_eq!(
            rungs,
            vec![
                QualityRung {
                    fps: 60,
                    resolution: ResolutionCap::Native
                },
                QualityRung {
                    fps: 30,
                    resolution: ResolutionCap::Native
                },
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::Native
                },
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::P1440
                },
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::P1080
                },
                QualityRung {
                    fps: 15,
                    resolution: ResolutionCap::P720
                },
            ]
        );
    }

    #[test]
    fn a_preset_that_already_capped_an_axis_has_no_rungs_above_it() {
        let ceiling = Ceiling {
            bitrate_bps: 10_000_000,
            fps: 30,
            resolution: ResolutionCap::P1080,
        };
        let rungs = ceiling.rungs();
        assert_eq!(rungs[0], QualityRung {
            fps: 30,
            resolution: ResolutionCap::P1080
        });
        assert!(
            rungs.iter().all(|rung| rung.fps <= 30),
            "a 30 fps preset never produces a 60 fps rung"
        );
        assert!(
            !rungs
                .iter()
                .any(|rung| matches!(rung.resolution, ResolutionCap::Native | ResolutionCap::P1440)),
            "a 1080p preset never produces a rung above 1080p"
        );
        assert_eq!(rungs.last().expect("non-empty"), &QualityRung {
            fps: 15,
            resolution: ResolutionCap::P720
        });
    }

    #[test]
    fn the_bottom_preset_still_has_somewhere_to_go() {
        let ceiling = Ceiling {
            bitrate_bps: BITRATE_CAPS_BPS[0],
            fps: MIN_LADDER_FPS,
            resolution: ResolutionCap::P720,
        };
        assert_eq!(ceiling.rungs().len(), 1, "nothing left to trade");
    }
}
