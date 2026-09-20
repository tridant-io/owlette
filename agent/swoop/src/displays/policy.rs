//! What a roster means: the virtual canvas, whether the machine has a usable
//! output at all, and the largest legal encode size for a given canvas.
//!
//! The planner itself is [`crate::gpu::scale::plan`] and is not reimplemented —
//! it is the executor for the same decision on the capture thread, and two
//! copies of an even-pixel aspect fit is exactly the drift that would put the
//! picker's promise and the encoder's behaviour out of step. What is here is
//! the *ceiling* to hand it before a viewer's offer has named a codec, at which
//! point [`crate::session::limits_for`] answers from the backend's own measured
//! caps and is authoritative.

use crate::capture::{virtual_bounds, OutputInfo, Rect};
use crate::encode::Codec;
use crate::gpu::scale::{plan, Limits, Plan};
use crate::ipc::DisplayState;

use super::enumerate::DisplayEntry;

/// The codec's own ceiling, before a backend narrows it.
///
/// NVENC allows 4096 on each axis for H.264 and 8192 for HEVC. AMF caps
/// **both** axes at 4096 whichever codec it runs, which is why this is two
/// numbers and not one — a canvas legal in width can still be refused on
/// height — and why a backend's measured caps override this the moment they
/// are known.
pub const fn ceiling(codec: Codec) -> Limits {
    match codec {
        Codec::H265 => Limits::square(8192),
        Codec::H264 => Limits::square(4096),
    }
}

/// What a `source`-sized canvas costs on `codec`'s ceiling.
///
/// The answer for one output is what the picker would promise; the answer for
/// [`virtual_canvas`] is what a spanned canvas would cost. Two 4K panels side
/// by side is 7680 wide, over H.264's cap on its own.
pub fn plan_for(source: (u32, u32), codec: Codec) -> Plan {
    plan(source, ceiling(codec))
}

/// The bounding box of every attached output. `None` when there are none.
///
/// Negative in both axes on a normal two-monitor box — spike 0.8 measured this
/// one at origin (-2160, -1138), extent 4080x3840.
pub fn virtual_canvas(roster: &[DisplayEntry]) -> Option<Rect> {
    // Collected rather than reduced here so the bounding box has exactly one
    // implementation, in `capture`, where the rect space is documented.
    let outputs: Vec<OutputInfo> = roster.iter().map(|entry| entry.output.clone()).collect();
    virtual_bounds(&outputs)
}

/// Whether this machine has a usable output at all.
///
/// `Headless` here means **no attached output**, which is what enumeration can
/// see. A machine whose duplication yields nothing but black is also headless
/// by §6's definition, and a feature cannot detect it: frames go capture →
/// session and never reach one. That half is unbuilt and deliberately not
/// worked around from here.
pub fn state(roster: &[DisplayEntry]) -> DisplayState {
    if roster.is_empty() {
        DisplayState::Headless
    } else {
        DisplayState::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::Rotation;

    fn panel(index: i32, width: i32, height: i32) -> DisplayEntry {
        let left = index * width;
        DisplayEntry {
            output: OutputInfo {
                device_name: format!("\\\\.\\DISPLAY{index}"),
                desktop_rect: Rect {
                    left,
                    top: 0,
                    right: left + width,
                    bottom: height,
                },
                rotation: Rotation::Identity,
            },
            path: format!("\\\\?\\DISPLAY#TEST{index}"),
            name: "test panel".to_owned(),
            dpi: 96,
            refresh_hz: 60,
            primary: index == 0,
        }
    }

    #[test]
    fn an_empty_roster_is_headless_and_has_no_canvas() {
        assert_eq!(state(&[]), DisplayState::Headless);
        assert_eq!(virtual_canvas(&[]), None);
        assert_eq!(state(&[panel(0, 1920, 1080)]), DisplayState::Ok);
    }

    /// Three 4K panels side by side: 11520x2160, over every ceiling there is.
    /// Both codecs must land on a legal, even, aspect-preserving size rather
    /// than refusing — refusing a canvas is for a degenerate one, not a wide
    /// one.
    #[test]
    fn a_three_by_4k_canvas_gets_a_legal_encode_size_on_each_codec() {
        let roster: Vec<DisplayEntry> = (0..3).map(|i| panel(i, 3840, 2160)).collect();
        let canvas = virtual_canvas(&roster).expect("three panels have a canvas");
        assert_eq!((canvas.width(), canvas.height()), (11520, 2160));
        let source = (canvas.width() as u32, canvas.height() as u32);

        for codec in [Codec::H264, Codec::H265] {
            let limits = ceiling(codec);
            let Plan::Downscale { width, height } = plan_for(source, codec) else {
                panic!("{codec:?} did not downscale an 11520x2160 canvas");
            };
            assert!(width <= limits.max_width && height <= limits.max_height);
            assert!(width % 2 == 0 && height % 2 == 0, "4:2:0 needs even axes");
            // Aspect held to within the even-pixel rounding.
            let want = f64::from(source.1) / f64::from(source.0);
            let got = f64::from(height) / f64::from(width);
            assert!((got - want).abs() < 0.01, "{codec:?} squashed the canvas");
        }

        assert_eq!(plan_for(source, Codec::H264), Plan::Downscale { width: 4096, height: 768 });
        assert_eq!(plan_for(source, Codec::H265), Plan::Downscale { width: 8192, height: 1536 });
    }

    /// The box this was written on: a 1080p panel and a rotated 4K one. Neither
    /// needs a downscale on its own, which is what makes the spanned canvas the
    /// only over-cap case here.
    #[test]
    fn a_single_output_under_the_cap_is_encoded_as_it_is() {
        assert_eq!(plan_for((1920, 1080), Codec::H264), Plan::AsIs);
        assert_eq!(plan_for((3840, 2160), Codec::H264), Plan::AsIs);
        // Two 4K panels side by side is over H.264's cap and under HEVC's.
        assert_eq!(plan_for((7680, 2160), Codec::H265), Plan::AsIs);
        assert_eq!(
            plan_for((7680, 2160), Codec::H264),
            Plan::Downscale { width: 4096, height: 1152 }
        );
    }
}
