//! What the live path is, and what it is allowed to cost.
//!
//! # This module profiles the path; it does not choose it
//!
//! [`PathProfile`] is derived from the **selected candidate pair** the
//! transport reports — the local candidate's type, and its relay protocol when
//! that type is `relay`. Those are the two fields `getStats()` and str0m spell
//! the same way, so the same classifier serves both ends. ICE policy, candidate
//! gathering and the one relay→direct promotion attempt are
//! [`crate::transport::ice_policy`]'s and are deliberately not read here: a
//! second opinion about what the path *should* be would drift from what it is.
//!
//! # Why a relayed session is capped at all
//!
//! Cloudflare Realtime TURN documents per-allocation limits — **>5–10 kpps** and
//! **>50–100 Mbps** "may be dropped", as packet loss rather than an error
//! (research/04 §1.6). A 4K60 desktop at 60–80 Mbps sits above the data-rate
//! limit and gets shaped, and shaping on this path presents as loss the governor
//! then answers with a cut it did not need to make. So a relayed session is
//! capped under the documented band and prefers **larger** packets: at ~1,200
//! byte payloads 25 Mbps is ~2.6 kpps, comfortably inside the packet-rate limit,
//! where the same rate in small packets would not be.
//!
//! # Why the TLS/TCP profile is a different shape and not just a smaller number
//!
//! When the client leg is TCP (3478) or TLS (443), every lost segment stalls all
//! subsequent RTP for a retransmission RTT — TCP will not deliver out of order,
//! so one loss becomes a multi-frame stall and a growing jitter buffer
//! (research/04 §3.2). Three things follow, and only the first is a number:
//! cap the rate hard (4–8 Mbps), drop to 30 fps so a stall costs fewer frames,
//! and **turn FEC off** — repair packets are pure waste on a transport that
//! already retransmits, and they spend the very capacity the stall needs to
//! recover.
//!
//! # `max_fragment_size` is measured, not assumed — and the measurement is owed
//!
//! **Spike 6.8 has not run.** The relay path MTU it and Task 7.4 are to measure
//! is the input to every fragment size below, which is why [`PathMtu`] has no
//! `Default`, no constant and no fallback: a caller must state a measured
//! number, so the day 6.8 lands there is exactly one place to put it and no
//! invented constant quietly outliving it. The per-profile allowances subtracted
//! from it are protocol headers (below), which are known and not measured.
//!
//! # Nothing applies this yet
//!
//! [`crate::transport::governor`] and [`crate::transport::pacer`] do not read
//! this module — neither mentions it, and the governor's ceiling comes straight
//! from the viewer's `quality` message through
//! [`Ceiling::from_quality`]. [`PathBudget::clamp`] is the seam that wiring
//! calls when it lands (Task 8.2 owns `governor.rs`): the **lower** of the two
//! wins on each axis, and it must be applied *after* `Ceiling::from_quality`,
//! never before — that constructor floors a viewer's request at
//! `BITRATE_CAPS_BPS[0]`, and re-running it over a degraded budget would floor
//! the degradation away.

use crate::ipc::MediaPath;
use crate::session::quality::{Ceiling, BITRATE_CAPS_BPS, FPS_CAPS};

/// The conservative end of research/04 §1.6's 25–30 Mbps band. Conservative
/// because the limit is documented as a range and enforced as silent loss.
const RELAY_UDP_BPS: u32 = 25_000_000;

/// Mid-band of research/04 §3.2's 4–8 Mbps. Mid rather than the 4 Mbps bottom
/// so the degraded cap stays above `BITRATE_CAPS_BPS[0]`, which keeps this
/// budget and the menu's own floor from ever naming different numbers.
const RELAY_TLS_BPS: u32 = 6_000_000;

/// IPv4 header + UDP header. The direct path carries SRTP inside that.
const UDP_OVERHEAD: u16 = 28;

/// The same, plus a 4-byte TURN ChannelData header — Task 7.4 channel-binds the
/// data path so packets do not carry a full Send indication. Both relay
/// profiles share this: the relay↔peer leg is **always UDP** whatever the
/// client leg is (research/04 §1.4), and that leg is what a too-large datagram
/// dies on. The TLS leg's own record framing rides a byte stream and does not
/// bound a datagram.
const RELAY_OVERHEAD: u16 = UDP_OVERHEAD + 4;

/// Every IPv4 host must accept a 576-byte datagram. A measurement below it is a
/// broken measurement rather than a very tight path, and computing a fragment
/// size from it would produce a gate nothing can pass — a stall, not a cap.
const IPV4_MIN_MTU: u16 = 576;

/// What the live path is, as the selected candidate pair says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathProfile {
    /// Peer to peer: a host, server-reflexive or peer-reflexive pair.
    Direct,
    /// Relayed, client leg over UDP.
    RelayUdp,
    /// Relayed, client leg over TCP or TLS. Named for the 443 case because that
    /// is the one a locked-down network leaves open, but the degradation is
    /// TCP's head-of-line blocking and applies to plain TCP 3478 identically.
    RelayTls,
}

impl PathProfile {
    /// Classify from the selected pair's local candidate. Both arguments are
    /// spelled as `getStats()` spells them (`candidateType`, `relayProtocol`);
    /// `relay_protocol` is `None` on any pair that is not relayed.
    ///
    /// Unknown tokens read as the *looser* answer on purpose. A relayed session
    /// mistaken for direct shows up as Cloudflare shaping, which the governor
    /// sees and the counters record; a direct session mistaken for TLS-degraded
    /// is a permanently 6 Mbps session that looks like a bad network and
    /// reports nothing at all.
    pub fn classify(candidate_type: &str, relay_protocol: Option<&str>) -> Self {
        if candidate_type != "relay" {
            return PathProfile::Direct;
        }
        match relay_protocol {
            Some("tcp" | "tls" | "ssltcp") => PathProfile::RelayTls,
            _ => PathProfile::RelayUdp,
        }
    }

    /// The budget this path is allowed to spend, given the measured path MTU.
    pub fn budget(self, mtu: PathMtu) -> PathBudget {
        let (max_bitrate_bps, max_fps, fec, overhead) = match self {
            // The top menu rung, so a direct path's budget never tightens
            // anything a viewer is allowed to ask for.
            PathProfile::Direct => (
                BITRATE_CAPS_BPS[BITRATE_CAPS_BPS.len() - 1],
                FPS_CAPS[0],
                true,
                UDP_OVERHEAD,
            ),
            PathProfile::RelayUdp => (RELAY_UDP_BPS, FPS_CAPS[0], true, RELAY_OVERHEAD),
            PathProfile::RelayTls => (RELAY_TLS_BPS, FPS_CAPS[1], false, RELAY_OVERHEAD),
        };
        PathBudget {
            profile: self,
            max_bitrate_bps,
            max_fps,
            max_fragment_size: usize::from(mtu.bytes().max(IPV4_MIN_MTU) - overhead),
            fec,
        }
    }

    /// The `status` line's coarser answer, which has only the two states.
    pub fn media_path(self) -> MediaPath {
        match self {
            PathProfile::Direct => MediaPath::Direct,
            PathProfile::RelayUdp | PathProfile::RelayTls => MediaPath::Relay,
        }
    }

    /// Lowercase, and the same three strings `SwoopStatsOverlay.tsx` renders.
    pub fn label(self) -> &'static str {
        match self {
            PathProfile::Direct => "direct",
            PathProfile::RelayUdp => "relayed (udp)",
            PathProfile::RelayTls => "relayed (tls)",
        }
    }

    /// Why this path carries the cap it carries, for a stats line and a log.
    pub fn reason(self) -> &'static str {
        match self {
            PathProfile::Direct => "peer to peer — no relay cap",
            PathProfile::RelayUdp => "relay shapes above ~50 mbps and ~5 kpps",
            PathProfile::RelayTls => "tcp head-of-line blocking — fec off",
        }
    }
}

/// A **measured** path MTU in bytes.
///
/// There is no `Default` and no constant: spike 6.8 owes the relay path's
/// number and Task 7.4 owes the live confirmation, and a plausible guess here
/// is a number nobody would ever come back to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathMtu(u16);

impl PathMtu {
    /// Wrap a measured MTU. The name is the contract: pass what was measured on
    /// this path, not what a path like it usually has.
    pub const fn measured(bytes: u16) -> Self {
        PathMtu(bytes)
    }

    pub const fn bytes(self) -> u16 {
        self.0
    }
}

/// What one path may spend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathBudget {
    pub profile: PathProfile,
    pub max_bitrate_bps: u32,
    pub max_fps: u32,
    /// Payload bytes per packet, MTU less this path's header allowance.
    pub max_fragment_size: usize,
    /// False on the TCP/TLS leg only, where repair is duplicated work.
    pub fec: bool,
}

impl PathBudget {
    /// Narrow a viewer's ceiling by this budget: the lower number wins on each
    /// axis, and the resolution cap is untouched because a budget has no
    /// opinion about pixels. Apply it *after* [`Ceiling::from_quality`], not
    /// before — see the module head.
    pub fn clamp(&self, ceiling: Ceiling) -> Ceiling {
        Ceiling {
            bitrate_bps: ceiling.bitrate_bps.min(self.max_bitrate_bps),
            fps: ceiling.fps.min(self.max_fps),
            resolution: ceiling.resolution,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::quality::ResolutionCap;

    /// Two MTUs so nothing can quietly become a constant: the ethernet-ish case
    /// and a tunnelled one. **Neither is the measured relay MTU — 6.8 owes it.**
    const MTUS: [u16; 2] = [1500, 1280];

    #[test]
    fn each_profile_and_mtu_maps_to_its_budget() {
        // profile, mtu, bitrate, fps, fragment, fec
        let table: [(PathProfile, u16, u32, u32, usize, bool); 6] = [
            (PathProfile::Direct, 1500, 50_000_000, 60, 1472, true),
            (PathProfile::Direct, 1280, 50_000_000, 60, 1252, true),
            (PathProfile::RelayUdp, 1500, 25_000_000, 60, 1468, true),
            (PathProfile::RelayUdp, 1280, 25_000_000, 60, 1248, true),
            (PathProfile::RelayTls, 1500, 6_000_000, 30, 1468, false),
            (PathProfile::RelayTls, 1280, 6_000_000, 30, 1248, false),
        ];
        for (profile, mtu, bitrate, fps, fragment, fec) in table {
            let budget = profile.budget(PathMtu::measured(mtu));
            assert_eq!(
                budget,
                PathBudget {
                    profile,
                    max_bitrate_bps: bitrate,
                    max_fps: fps,
                    max_fragment_size: fragment,
                    fec,
                },
                "{profile:?} at mtu {mtu}"
            );
        }
    }

    #[test]
    fn the_relay_cap_sits_inside_the_documented_band() {
        for mtu in MTUS {
            let relay = PathProfile::RelayUdp.budget(PathMtu::measured(mtu));
            assert!((25_000_000..=30_000_000).contains(&relay.max_bitrate_bps));
            let tls = PathProfile::RelayTls.budget(PathMtu::measured(mtu));
            assert!((4_000_000..=8_000_000).contains(&tls.max_bitrate_bps));
            // and the degraded cap stays inside the menu's own range, so the
            // two floors can never name different numbers.
            assert!(tls.max_bitrate_bps >= BITRATE_CAPS_BPS[0]);
        }
    }

    #[test]
    fn a_relayed_fragment_is_smaller_than_a_direct_one_at_the_same_mtu() {
        for mtu in MTUS {
            let direct = PathProfile::Direct.budget(PathMtu::measured(mtu));
            let relay = PathProfile::RelayUdp.budget(PathMtu::measured(mtu));
            // the channeldata header is the whole difference.
            assert_eq!(direct.max_fragment_size - relay.max_fragment_size, 4);
        }
    }

    #[test]
    fn an_impossible_mtu_measurement_does_not_produce_an_unsendable_fragment() {
        let budget = PathProfile::RelayUdp.budget(PathMtu::measured(20));
        assert_eq!(budget.max_fragment_size, usize::from(576 - RELAY_OVERHEAD));
    }

    #[test]
    fn classification_reads_the_selected_pairs_two_fields() {
        let table: [(&str, Option<&str>, PathProfile); 8] = [
            ("host", None, PathProfile::Direct),
            ("srflx", None, PathProfile::Direct),
            ("prflx", None, PathProfile::Direct),
            ("relay", Some("udp"), PathProfile::RelayUdp),
            ("relay", Some("tcp"), PathProfile::RelayTls),
            ("relay", Some("tls"), PathProfile::RelayTls),
            // a relay whose protocol the stats did not say is not degraded on a
            // guess, and an unknown candidate type is not capped on one.
            ("relay", None, PathProfile::RelayUdp),
            ("something-new", Some("tls"), PathProfile::Direct),
        ];
        for (candidate_type, relay_protocol, want) in table {
            assert_eq!(
                PathProfile::classify(candidate_type, relay_protocol),
                want,
                "{candidate_type}/{relay_protocol:?}"
            );
        }
    }

    #[test]
    fn a_relayed_path_is_one_media_path_in_status() {
        assert_eq!(PathProfile::Direct.media_path(), MediaPath::Direct);
        assert_eq!(PathProfile::RelayUdp.media_path(), MediaPath::Relay);
        assert_eq!(PathProfile::RelayTls.media_path(), MediaPath::Relay);
    }

    #[test]
    fn the_budget_only_ever_tightens_a_viewers_ceiling() {
        let mtu = PathMtu::measured(1280);
        let asked = Ceiling::from_quality("1080p", 50_000, 60);
        let degraded = PathProfile::RelayTls.budget(mtu).clamp(asked);
        assert_eq!(degraded.bitrate_bps, 6_000_000);
        assert_eq!(degraded.fps, 30);
        // the budget has no opinion about pixels.
        assert_eq!(degraded.resolution, ResolutionCap::P1080);

        // and a viewer already asking for less than the budget keeps its own
        // number: this narrows, it never raises.
        let modest = Ceiling::from_quality("720p", 5_000, 30);
        let direct = PathProfile::Direct.budget(mtu).clamp(modest);
        assert_eq!(direct, modest);
    }
}
