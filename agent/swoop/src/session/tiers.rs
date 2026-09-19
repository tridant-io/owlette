//! Encoder tiers: one capture, one encoder per tier, frames fanned out.
//!
//! # The tier count is measured, never assumed
//!
//! plan.md D14: **tiers = min(distinct codec classes present among viewers, the
//! measured encoder budget)**. Both halves are read, neither is a constant, and
//! in particular the count is never a hard-coded 2. The budget is
//! [`crate::encode::select::budget`]'s figure — the *top rung's*
//! `concurrent_sessions` and never a sum across backends, because two codecs
//! served by two backends still share one machine.
//!
//! `BackendCaps::max_fps` is deliberately not read here, for the same reason
//! `select.rs` does not read it: it is fps at the backend's largest supported
//! size, which measures 15 on this box's 2080 Ti at 8192x8192. Tiering on it
//! would refuse a 1080p60 session the GPU does comfortably. Redefining it is an
//! `encode/mod.rs` contract change and is not this module's.
//!
//! # Nobody is downgraded because another viewer's browser cannot decode HEVC
//!
//! That is the whole point of D14, and it is why the codec class is the tier
//! key. While the budget pays for one tier per class, an H.265 viewer and an
//! H.264 viewer each get their own encoder and neither hears about the other.
//!
//! When the budget cannot pay for every class, classes collapse — and they
//! collapse **onto the least-preferred class present**, not the most. A browser
//! that offered H.265 offered H.264 beside it (`session::pick_codec` reads the
//! offer, and the baseline is what makes an offer an offer); the reverse is not
//! true, so collapsing upward would hand a viewer a stream it cannot decode.
//! Every viewer moved that way is named in [`TierPlan::downgraded`], because a
//! downgrade nobody can see is the failure this module exists to prevent.
//!
//! # Rate class is the order inside a tier, not a second tier key
//!
//! D14 fixes the count at min(classes, budget), so a rate class cannot buy
//! itself an encoder: there is no spare to buy one with. What it does instead
//! is set what the tier's single encoder may spend — [`Tier::ceiling`] is the
//! *narrowest* ceiling among its members on every axis, because one stream is
//! fanned out to all of them and a viewer that asked for 5 Mbps must not be
//! sent 50. A richer viewer sharing a tier with a poorer one therefore shares
//! its rate. That is a cost of the budget and it is recorded on the tier rather
//! than hidden: the alternative, one encoder per (class, rate) pair, is a tier
//! count D14 does not allow and a second encode session nothing has measured.
//!
//! # One IDR per tier, not one per viewer
//!
//! [`TierKeyframes`] holds one [`IdrPolicy`] per tier, so a join and every PLI
//! landing inside the same 250–500 ms cooldown produce **one** keyframe for
//! that tier. Three viewers on one tier all reporting the same loss cost one
//! IRAP between them, and the fourth one joining costs nothing extra.
//!
//! # Reading the roster
//!
//! Only [`TierViewer`] crosses into this module, built by the session loop from
//! the roster's public fields (`viewer_id`, `ctl`, `codec_class`) plus that
//! viewer's own [`Ceiling`]. `viewers/**` is Task 8.1's and is not touched
//! here; a struct of the three fields this planner actually needs is also what
//! keeps the whole of it a pure function, testable with no roster, no peer and
//! no GPU.

use std::time::Instant;

use crate::encode::Codec;
use crate::ipc::HostEventKind;
use crate::session::quality::{Ceiling, ResolutionCap, BITRATE_CAPS_BPS};
use crate::session::IdrPolicy;

/// The codec classes a tier can be, richest first — plan.md D5's preference
/// order, which is also `Codec`'s own declaration order. The **last** entry
/// present among the viewers is the baseline a collapsed tier lands on.
const CODEC_PREFERENCE: [Codec; 2] = [Codec::H265, Codec::H264];

/// What the tier planner needs of one viewer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TierViewer {
    pub viewer_id: String,
    /// True for a controller. From the verified JWT, never from the viewer —
    /// the roster owns that rule (Task 8.1).
    pub ctl: bool,
    /// What this viewer's browser negotiated, from its own offer.
    pub codec_class: Codec,
    /// This viewer's own ceiling, which is where its rate class comes from.
    pub ceiling: Ceiling,
}

/// Which bandwidth rung a viewer's ceiling sits on: the position of the
/// richest [`BITRATE_CAPS_BPS`] entry it reaches.
///
/// A class rather than the raw number because the ordering inside a tier only
/// has to be stable and coarse — two viewers 200 kbps apart are the same
/// customer of the shared encoder, and sorting them by an exact rate would
/// reshuffle the tier on every `quality` message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RateClass(pub u8);

impl RateClass {
    pub fn of(ceiling: &Ceiling) -> Self {
        let at = BITRATE_CAPS_BPS
            .iter()
            .rposition(|cap| ceiling.bitrate_bps >= *cap)
            .unwrap_or(0);
        RateClass(at as u8)
    }
}

/// One encoder instance and the viewers it serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tier {
    pub codec: Codec,
    /// Viewer ids, richest rate class first and ties broken by id so the same
    /// roster always produces the same tier.
    pub viewers: Vec<String>,
    /// What this tier's one encoder may spend: the narrowest ceiling among its
    /// members, on every axis. See the module head.
    pub ceiling: Ceiling,
}

/// The whole assignment, for one roster and one measured budget.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TierPlan {
    /// Codec-preference order, richest class first.
    pub tiers: Vec<Tier>,
    /// Viewers served by a codec class that is not their own, because the
    /// budget could not pay for theirs. Sorted, and empty in the case D14 is
    /// about.
    pub downgraded: Vec<String>,
}

impl TierPlan {
    pub fn tier_count(&self) -> usize {
        self.tiers.len()
    }

    /// Which tier serves this viewer, if any.
    pub fn tier_of(&self, viewer_id: &str) -> Option<&Tier> {
        self.tiers
            .iter()
            .find(|tier| tier.viewers.iter().any(|id| id == viewer_id))
    }
}

/// Assign every viewer to a tier. Pure, and the only place the tier rule lives.
///
/// `encoder_budget` is `probe`'s `encoder_budget`. A zero means the probe found
/// no encoder at all, and a session that got this far has one, so it is read as
/// one rather than as "no tiers" — the machine that cannot encode fails at
/// `select`, not here.
pub fn plan(viewers: &[TierViewer], encoder_budget: u32) -> TierPlan {
    if viewers.is_empty() {
        return TierPlan::default();
    }
    let present: Vec<Codec> = CODEC_PREFERENCE
        .into_iter()
        .filter(|class| viewers.iter().any(|v| v.codec_class == *class))
        .collect();
    let budget = encoder_budget.max(1) as usize;
    // D14, whole: min(distinct codec classes present, the measured budget).
    let count = present.len().min(budget);
    // Collapsing keeps the *last* classes in preference order, so the baseline
    // every offer carries is the one that survives. See the module head.
    let kept = &present[present.len() - count..];
    let baseline = *kept.last().expect("a non-empty roster has a class");

    let mut downgraded = Vec::new();
    let mut tiers: Vec<Tier> = kept
        .iter()
        .map(|codec| Tier {
            codec: *codec,
            viewers: Vec::new(),
            ceiling: Ceiling::default(),
        })
        .collect();

    let mut ordered: Vec<&TierViewer> = viewers.iter().collect();
    ordered.sort_by(|a, b| {
        RateClass::of(&b.ceiling)
            .cmp(&RateClass::of(&a.ceiling))
            .then_with(|| a.viewer_id.cmp(&b.viewer_id))
    });

    for viewer in ordered {
        let codec = if kept.contains(&viewer.codec_class) {
            viewer.codec_class
        } else {
            downgraded.push(viewer.viewer_id.clone());
            baseline
        };
        let tier = tiers
            .iter_mut()
            .find(|tier| tier.codec == codec)
            .expect("every kept class has a tier and the baseline is kept");
        tier.ceiling = if tier.viewers.is_empty() {
            viewer.ceiling
        } else {
            narrowest(tier.ceiling, viewer.ceiling)
        };
        tier.viewers.push(viewer.viewer_id.clone());
    }

    // A class can be kept and still end up empty only if it had no viewers,
    // which `present` already excluded — but an empty tier would hold an
    // encoder open for nobody, so it is dropped rather than trusted.
    tiers.retain(|tier| !tier.viewers.is_empty());
    downgraded.sort();
    TierPlan { tiers, downgraded }
}

/// The tightest of two ceilings on every axis. `Native` is no cap at all, so it
/// loses to any cap that names a height.
fn narrowest(a: Ceiling, b: Ceiling) -> Ceiling {
    let height = |cap: ResolutionCap| cap.max_height().unwrap_or(u32::MAX);
    Ceiling {
        bitrate_bps: a.bitrate_bps.min(b.bitrate_bps),
        fps: a.fps.min(b.fps),
        resolution: if height(a.resolution) <= height(b.resolution) {
            a.resolution
        } else {
            b.resolution
        },
    }
}

/// A join turned away because the machine has no encode session left for it.
///
/// Audited, not silent: [`BudgetRefusal::kind`] is the `/api/agent/swoop/events`
/// record the session loop reports, and [`BudgetRefusal::reason`] is the whole
/// arithmetic in one lowercase line, so an operator who sees a refusal can tell
/// it from a token failure without reading a log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetRefusal {
    pub budget: u32,
    pub viewers: u32,
    pub reason: String,
}

impl BudgetRefusal {
    /// §11's host event for an admission limit. Viewer count and join rate
    /// already report as this, and an encoder-budget refusal is the same
    /// statement: the session turned a join away on a limit of its own.
    pub fn kind(&self) -> HostEventKind {
        HostEventKind::JoinRefused
    }
}

/// Admit one joining viewer, or refuse it with the reason.
///
/// The cap is the encoder budget itself: a viewer the machine cannot open an
/// encode session for is a viewer it cannot serve, and admitting it would cost
/// every viewer already connected an encoder that fails to open under load.
pub fn admit(current_viewers: u32, encoder_budget: u32) -> Result<(), BudgetRefusal> {
    let budget = encoder_budget.max(1);
    if current_viewers < budget {
        return Ok(());
    }
    Err(BudgetRefusal {
        budget,
        viewers: current_viewers,
        reason: format!(
            "encoder budget exhausted: {current_viewers} of {budget} encode sessions in use"
        ),
    })
}

/// One [`IdrPolicy`] per tier, so a join and every PLI inside the cooldown cost
/// the tier one keyframe between them.
///
/// Keyed by codec class rather than by tier index: an index moves when a viewer
/// leaves and the plan is recomputed, and a cooldown that resets because
/// somebody else left is a cooldown that does not coalesce.
#[derive(Debug, Default)]
pub struct TierKeyframes {
    // Two classes at most, so a linear scan beats a map and `Codec` needs no
    // `Ord` it does not have.
    per_tier: Vec<(Codec, IdrPolicy)>,
}

impl TierKeyframes {
    pub fn new() -> Self {
        Self::default()
    }

    /// One keyframe request against a tier — a viewer joining it, or a PLI from
    /// any of its viewers. `true` means force one IRAP out of that tier's
    /// encoder; `false` means the keyframe this request wants is already on its
    /// way and the requester will be served by it.
    pub fn request(&mut self, codec: Codec, now: Instant) -> bool {
        self.policy(codec).request(now)
    }

    /// An IRAP reached the wire for this tier, so the burst it answers is over.
    pub fn answered(&mut self, codec: Codec) {
        self.policy(codec).answered();
    }

    /// Keyframes forced for one tier since the session started.
    pub fn forced(&self, codec: Codec) -> u64 {
        self.per_tier
            .iter()
            .find(|(class, _)| *class == codec)
            .map_or(0, |(_, policy)| policy.forced())
    }

    /// Keyframes forced across every tier — what a `status` line's `idrs`
    /// counts for a multi-tier session.
    pub fn total_forced(&self) -> u64 {
        self.per_tier.iter().map(|(_, policy)| policy.forced()).sum()
    }

    /// Drop the policies of tiers this plan no longer has, so a session that
    /// loses its last H.265 viewer does not carry its cooldown forever.
    pub fn retain(&mut self, plan: &TierPlan) {
        self.per_tier
            .retain(|(codec, _)| plan.tiers.iter().any(|tier| tier.codec == *codec));
    }

    fn policy(&mut self, codec: Codec) -> &mut IdrPolicy {
        if let Some(at) = self.per_tier.iter().position(|(class, _)| *class == codec) {
            return &mut self.per_tier[at].1;
        }
        self.per_tier.push((codec, IdrPolicy::new()));
        &mut self.per_tier.last_mut().expect("just pushed").1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{IDR_COOLDOWN, IDR_COOLDOWN_MAX};
    use std::time::Duration;

    fn viewer(id: &str, ctl: bool, codec_class: Codec, bitrate_bps: u32) -> TierViewer {
        TierViewer {
            viewer_id: id.to_owned(),
            ctl,
            codec_class,
            ceiling: Ceiling {
                bitrate_bps,
                ..Ceiling::default()
            },
        }
    }

    const RICH: u32 = 20_000_000;

    /// D14's case, and the reason the whole module exists: the H.264 viewer
    /// gets its own encoder and the two H.265 viewers keep HEVC.
    #[test]
    fn three_viewers_across_two_codec_classes_on_a_three_budget_machine_downgrade_nobody() {
        let roster = [
            viewer("a", true, Codec::H265, RICH),
            viewer("b", false, Codec::H264, RICH),
            viewer("c", false, Codec::H265, RICH),
        ];
        let plan = plan(&roster, 3);
        assert_eq!(plan.tier_count(), 2, "min(2 classes, 3 sessions)");
        assert!(plan.downgraded.is_empty(), "nobody loses a codec class");
        assert_eq!(plan.tiers[0].codec, Codec::H265);
        assert_eq!(plan.tiers[0].viewers, vec!["a", "c"]);
        assert_eq!(plan.tiers[1].codec, Codec::H264);
        assert_eq!(plan.tiers[1].viewers, vec!["b"]);
        // and nobody loses rate either: every tier runs at its members' own
        // ceiling, which is what "downgraded" would otherwise be hiding.
        for tier in &plan.tiers {
            assert_eq!(tier.ceiling.bitrate_bps, RICH);
            assert_eq!(tier.ceiling.fps, Ceiling::default().fps);
        }
    }

    /// The tier count is arithmetic over two measured numbers, and 2 is only
    /// ever one of its answers.
    #[test]
    fn the_tier_count_is_the_minimum_of_the_two_and_never_a_constant() {
        let both = [
            viewer("a", true, Codec::H265, RICH),
            viewer("b", false, Codec::H264, RICH),
        ];
        assert_eq!(plan(&both, 1).tier_count(), 1, "the budget binds");
        assert_eq!(plan(&both, 2).tier_count(), 2);
        assert_eq!(plan(&both, 8).tier_count(), 2, "the classes bind");

        let one_class = [
            viewer("a", true, Codec::H265, RICH),
            viewer("b", false, Codec::H265, RICH),
            viewer("c", false, Codec::H265, RICH),
        ];
        assert_eq!(plan(&one_class, 8).tier_count(), 1, "one class, one encoder");
        assert_eq!(plan(&[], 8).tier_count(), 0, "nobody watching, no encoder");
    }

    #[test]
    fn a_one_budget_machine_degrades_deterministically_onto_the_baseline_class() {
        let roster = [
            viewer("a", true, Codec::H265, RICH),
            viewer("b", false, Codec::H264, 5_000_000),
            viewer("c", false, Codec::H265, RICH),
        ];
        let first = plan(&roster, 1);
        assert_eq!(first.tier_count(), 1);
        assert_eq!(
            first.tiers[0].codec,
            Codec::H264,
            "collapse lands on the class every offer carries, never on hevc"
        );
        assert_eq!(first.downgraded, vec!["a".to_owned(), "c".to_owned()]);
        // One encoder for all three, so its ceiling is the narrowest of them.
        assert_eq!(first.tiers[0].ceiling.bitrate_bps, 5_000_000);
        assert_eq!(first.tiers[0].viewers, vec!["a", "c", "b"], "rate class first");

        // Deterministic means the roster's own order cannot change the answer.
        let shuffled = [roster[2].clone(), roster[0].clone(), roster[1].clone()];
        assert_eq!(plan(&shuffled, 1), first);
    }

    #[test]
    fn a_single_class_roster_is_never_collapsed_onto_a_class_it_did_not_offer() {
        let hevc_only = [
            viewer("a", true, Codec::H265, RICH),
            viewer("b", false, Codec::H265, RICH),
        ];
        let plan = plan(&hevc_only, 1);
        assert_eq!(plan.tiers[0].codec, Codec::H265);
        assert!(plan.downgraded.is_empty());
    }

    #[test]
    fn a_tiers_ceiling_is_the_narrowest_of_its_members_on_every_axis() {
        let mut modest = viewer("b", false, Codec::H265, 10_000_000);
        modest.ceiling.fps = 30;
        modest.ceiling.resolution = ResolutionCap::P720;
        let roster = [viewer("a", true, Codec::H265, RICH), modest];
        let plan = plan(&roster, 4);
        assert_eq!(
            plan.tiers[0].ceiling,
            Ceiling {
                bitrate_bps: 10_000_000,
                fps: 30,
                resolution: ResolutionCap::P720,
            }
        );
        // Native is no cap, so it never wins the narrowing.
        assert_eq!(plan.tier_of("a").expect("a is placed").codec, Codec::H265);
    }

    #[test]
    fn the_rate_class_is_the_menus_own_rungs() {
        let at = |bps| {
            RateClass::of(&Ceiling {
                bitrate_bps: bps,
                ..Ceiling::default()
            })
        };
        assert_eq!(at(BITRATE_CAPS_BPS[0]), RateClass(0));
        assert_eq!(at(BITRATE_CAPS_BPS[4]), RateClass(4));
        assert!(at(21_000_000) > at(11_000_000), "a rung apart is a class apart");
        assert_eq!(at(21_000_000), at(29_000_000), "inside one rung is one class");
        // Below the menu's floor cannot happen through `from_quality`, and is
        // the bottom class rather than a panic if it ever does.
        assert_eq!(at(1), RateClass(0));
    }

    // ------------------------------------------------ keyframe coalescing ---

    #[test]
    fn a_viewer_joining_a_three_viewer_session_costs_at_most_one_idr() {
        let roster = [
            viewer("a", true, Codec::H265, RICH),
            viewer("b", false, Codec::H265, RICH),
            viewer("c", false, Codec::H265, RICH),
        ];
        let plan = plan(&roster, 4);
        let tier = plan.tiers[0].codec;
        let mut keyframes = TierKeyframes::new();
        let start = Instant::now();

        // The three sitting viewers all report the same loss, then a fourth
        // joins — every one of them inside the 250 ms cooldown.
        let forced: usize = [0u64, 40, 80, 120]
            .into_iter()
            .filter(|ms| keyframes.request(tier, start + Duration::from_millis(*ms)))
            .count();
        assert_eq!(forced, 1, "one idr for the tier, not one per viewer");
        assert_eq!(keyframes.forced(tier), 1);
        assert_eq!(keyframes.total_forced(), 1);
    }

    #[test]
    fn each_tier_coalesces_on_its_own_cooldown() {
        let mut keyframes = TierKeyframes::new();
        let at = Instant::now();
        assert!(keyframes.request(Codec::H265, at));
        assert!(
            keyframes.request(Codec::H264, at),
            "a second tier is a second encoder and owes its own irap"
        );
        assert!(!keyframes.request(Codec::H265, at + Duration::from_millis(10)));
        assert_eq!(keyframes.total_forced(), 2);
        assert_eq!(keyframes.forced(Codec::H265), 1);
    }

    #[test]
    fn a_tier_that_no_longer_exists_does_not_keep_its_cooldown() {
        let mut keyframes = TierKeyframes::new();
        let at = Instant::now();
        assert!(keyframes.request(Codec::H265, at));
        assert!(keyframes.request(Codec::H264, at));

        let roster = [viewer("a", true, Codec::H264, RICH)];
        keyframes.retain(&plan(&roster, 4));
        assert_eq!(keyframes.forced(Codec::H265), 0, "the tier went, so did its policy");
        assert_eq!(keyframes.forced(Codec::H264), 1);
    }

    /// The coalescing is [`IdrPolicy`]'s, unchanged — this only proves the
    /// per-tier wrapper did not lose the backoff behind it.
    #[test]
    fn the_per_tier_window_still_backs_off_to_the_top_of_the_range() {
        let mut keyframes = TierKeyframes::new();
        let mut at = Instant::now();
        assert!(keyframes.request(Codec::H264, at));
        keyframes.answered(Codec::H264);
        at += IDR_COOLDOWN;
        assert!(keyframes.request(Codec::H264, at));
        keyframes.answered(Codec::H264);
        at += IDR_COOLDOWN;
        assert!(!keyframes.request(Codec::H264, at), "the window is 500 ms now");
        at += IDR_COOLDOWN_MAX;
        assert!(keyframes.request(Codec::H264, at));
    }

    // ----------------------------------------------------- the admission ---

    #[test]
    fn a_join_past_the_encoder_budget_is_refused_with_an_audited_reason() {
        assert_eq!(admit(0, 3), Ok(()));
        assert_eq!(admit(2, 3), Ok(()));
        let refusal = admit(3, 3).expect_err("the fourth has no encode session");
        assert_eq!(refusal.budget, 3);
        assert_eq!(refusal.viewers, 3);
        assert_eq!(refusal.kind(), HostEventKind::JoinRefused);
        assert_eq!(
            refusal.reason,
            "encoder budget exhausted: 3 of 3 encode sessions in use"
        );
        // A probe that measured nothing still serves one viewer: a machine with
        // no encoder at all fails at `select`, not at the admission gate.
        assert_eq!(admit(0, 0), Ok(()));
        assert!(admit(1, 0).is_err());
    }
}
