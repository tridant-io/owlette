//! ICE policy: peer-to-peer first, relay fallback, and relay to direct
//! promotion by ICE restart.
//!
//! The host answers (plan.md D8), so it is the ICE *controlled* agent: it never
//! nominates and it cannot move the session onto a better pair by itself. Every
//! lever it does have is here — what it gathers, what it accepts from the
//! viewer, and when it asks for a restart.
//!
//! # What this module decides
//!
//! 1. **Trickle everything, on one bundled transport with rtcp-mux.** Both are
//!    the browser's side of the negotiation (`web/lib/swoop/peer.ts` sets
//!    `bundlePolicy: "max-bundle"` and `rtcpMuxPolicy: "require"`); the host's
//!    side is that a candidate goes out the moment it exists rather than at
//!    end-of-gathering, which is what [`crate::transport::rtc::RtcPeer::add_local_candidate`]
//!    already does.
//! 2. **Never an ICE-TCP host candidate** ([`LOCAL_TRANSPORT`]). RFC 6544
//!    exists, but Chrome and Firefox gather no *direct* TCP candidates at all —
//!    their only TCP candidates are `tcptype active` toward a TURN-TCP server.
//!    A passive listener here is therefore unreachable from every browser we
//!    serve, and a candidate nobody can connect to is a pair every check has to
//!    walk through first.
//! 3. **Resolve the viewer's `.local` mDNS candidates.** Chrome and Firefox
//!    replace private IPv4 host candidates with random `*.local` names, and a
//!    peer that does not resolve them has no same-LAN direct path at all. On a
//!    NAT that does not hairpin, srflx↔srflx fails too, so a session between an
//!    operator and a signage player on the *same LAN* falls all the way to
//!    relay — the worst outcome on the most favourable network (research 04
//!    §2.6/§2.7).
//! 4. **One deliberate promotion attempt, and recovery restarts.** See below.
//!
//! # This module does not classify the path
//!
//! [`crate::transport::budget`] (Task 7.6) is what turns the selected candidate
//! pair into a `PathProfile` and a rate budget. The only thing asked here is the
//! yes/no in [`IceEvent::Connected`] — *is the pair we are on a relayed one* —
//! because that is the promotion timer's whole input. The two are deliberately
//! not merged: one answers "how fast may we send", this one answers "should we
//! renegotiate", and a module that did both would have to be called from both
//! places.
//!
//! # Promotion, and why it is capped at one
//!
//! RFC 8445 has no in-band way to move to a better pair once ICE has concluded
//! (§8.1.2 stops the checks; §2.4 says restart instead), and
//! `draft-thatcher-ice-renomination` expired in 2016 with no standing. So a
//! session that came up on relay because the direct pair gathered late stays on
//! relay forever unless somebody restarts ICE. One restart, [`PROMOTION_PROBE`]
//! after the pair was selected, is worth its renegotiation. A second one is
//! not: on a network that genuinely cannot do peer-to-peer every attempt costs
//! a renegotiation and lands back on relay, which is a reconnect every three
//! seconds for as long as the session lasts.
//!
//! # `disconnected` is acted on, `failed` is too late
//!
//! Consent freshness (RFC 7675) stops transmission on a 5-tuple 30 s after the
//! last valid response, and a lid close or a Wi-Fi roam produces exactly that
//! silence. Waiting for `failed` spends those 30 s with no picture, so a link
//! that is still down [`DISCONNECTED_GRACE`] after it went quiet is restarted.
//! [`RESTART_COOLDOWN`] is what keeps that from becoming a loop when the
//! network is flapping — `NotifyIpInterfaceChange` in particular fires once per
//! interface, so a VPN coming up is a burst and not an event.
//!
//! # Logging
//!
//! Nothing here logs. Every decision is returned to the caller, which is the
//! layer that knows the session id and owns the sink — and it keeps the rule
//! that a candidate's address never appears in a record beside a credential
//! trivially true of this file.

use std::net::IpAddr;
use std::time::{Duration, Instant};

/// How long a relayed pair may stand before the one promotion restart.
pub const PROMOTION_PROBE: Duration = Duration::from_secs(3);

/// How long `disconnected` may stand before a restart. Consent freshness kills
/// media at 30 s, so this is early on purpose.
pub const DISCONNECTED_GRACE: Duration = Duration::from_secs(2);

/// The floor between two recovery restarts. An ICE restart is a renegotiation
/// and a fresh gathering; issuing them faster than they can complete is how a
/// flapping adapter turns into a restart loop.
pub const RESTART_COOLDOWN: Duration = Duration::from_secs(5);

/// The only transport the host gathers a local candidate on. See §2 of the
/// module doc — an ICE-TCP host candidate is unreachable from a browser.
pub const LOCAL_TRANSPORT: &str = "udp";

/// The mDNS suffix Chrome and Firefox obfuscate host candidates with.
const MDNS_SUFFIX: &str = ".local";

// ------------------------------------------------------------ candidates ---

/// A candidate's `typ`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateKind {
    Host,
    Srflx,
    Prflx,
    Relay,
}

impl CandidateKind {
    fn parse(token: &str) -> Option<Self> {
        match token {
            "host" => Some(Self::Host),
            "srflx" => Some(Self::Srflx),
            "prflx" => Some(Self::Prflx),
            "relay" => Some(Self::Relay),
            _ => None,
        }
    }

    /// Whether a pair built on this candidate goes through a TURN server.
    pub fn is_relayed(self) -> bool {
        self == Self::Relay
    }
}

/// The parts of an SDP `candidate:` attribute this module acts on.
///
/// Borrowed rather than owned: every caller has the line in hand and the only
/// thing built from it is the rewritten form in [`Admission::Resolved`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedCandidate<'a> {
    /// `udp`, `tcp`, `ssltcp`, lowercased by the sender or not.
    pub transport: &'a str,
    /// The connection address, which is an IP literal or an mDNS name.
    pub address: &'a str,
    pub port: u16,
    pub kind: CandidateKind,
}

impl<'a> ParsedCandidate<'a> {
    /// Is the connection address one of the browser's `*.local` names?
    pub fn is_mdns(&self) -> bool {
        // `.local.` with the root dot is legal and Chrome does not send it;
        // accept it anyway rather than dropping the candidate over a dot.
        let name = self.address.trim_end_matches('.');
        name.len() > MDNS_SUFFIX.len() && name.to_ascii_lowercase().ends_with(MDNS_SUFFIX)
    }

    fn is_udp(&self) -> bool {
        self.transport.eq_ignore_ascii_case(LOCAL_TRANSPORT)
    }
}

/// Parse an SDP candidate attribute value, with or without the `candidate:`
/// prefix.
///
/// `foundation component transport priority address port typ kind [...]` —
/// everything past `kind` (`raddr`, `rport`, `tcptype`, `generation`, …) is
/// somebody else's business and is left alone.
pub fn parse_candidate(sdp: &str) -> Option<ParsedCandidate<'_>> {
    let body = sdp.trim();
    let body = body.strip_prefix("candidate:").unwrap_or(body);
    let mut fields = body.split_ascii_whitespace();

    let _foundation = fields.next()?;
    let _component = fields.next()?;
    let transport = fields.next()?;
    let _priority = fields.next()?;
    let address = fields.next()?;
    let port = fields.next()?.parse().ok()?;
    if fields.next()? != "typ" {
        return None;
    }
    let kind = CandidateKind::parse(fields.next()?)?;

    Some(ParsedCandidate {
        transport,
        address,
        port,
        kind,
    })
}

/// Why a viewer's candidate was not handed to the ICE agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    /// Not a candidate attribute this parser understands.
    Malformed,
    /// A `tcptype active` candidate toward a TURN-TCP server. The host's
    /// transport is one UDP socket, so there is nothing to pair it with.
    Tcp,
    /// A `.local` name the resolver could not answer — mDNS does not cross
    /// subnets and plenty of switches suppress multicast.
    UnresolvedMdns,
}

/// What to do with one candidate the viewer trickled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// Hand it to the ICE agent as it arrived.
    Accept,
    /// Hand it to the ICE agent with the mDNS name replaced by the address it
    /// resolved to — str0m parses candidates into `SocketAddr` and has no
    /// resolver of its own.
    Resolved(String),
    Drop(DropReason),
}

/// The seam the `.local` lookup goes through, so the admission rules above are
/// testable without a LAN.
pub trait MdnsResolver {
    /// `None` when the name does not resolve. Blocking; see [`SystemResolver`].
    fn resolve(&self, name: &str) -> Option<IpAddr>;
}

/// The machine's own resolver.
///
/// On Windows the DNS Client resolves `*.local` by mDNS, and `getaddrinfo`,
/// `GetAddrInfoExW` and `DnsQueryEx` all reach it — the `Ex` forms buy
/// cancellation and an explicit timeout, which cost a manifest entry this wave
/// does not have and buy nothing a worker thread does not already give. It
/// **blocks**, for as long as the resolver takes to give up, so it is called
/// off the session loop or not at all.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl MdnsResolver for SystemResolver {
    #[cfg(windows)]
    fn resolve(&self, name: &str) -> Option<IpAddr> {
        use std::net::ToSocketAddrs;

        // Port 0: the answer wanted is the address, and `to_socket_addrs`
        // needs a port to build one at all.
        (name, 0u16)
            .to_socket_addrs()
            .ok()?
            .map(|addr| addr.ip())
            .next()
    }

    #[cfg(not(windows))]
    fn resolve(&self, _name: &str) -> Option<IpAddr> {
        // Wave 9's platform seam. A non-Windows host answers no `.local` name,
        // which costs same-LAN direct paths and nothing else.
        None
    }
}

/// Whether the host may gather a local candidate on this transport.
pub fn gathers_local_transport(transport: &str) -> bool {
    transport.eq_ignore_ascii_case(LOCAL_TRANSPORT)
}

/// Decide what to do with a candidate the viewer trickled.
pub fn admit_remote<R: MdnsResolver + ?Sized>(sdp: &str, resolver: &R) -> Admission {
    let Some(parsed) = parse_candidate(sdp) else {
        return Admission::Drop(DropReason::Malformed);
    };
    if !parsed.is_udp() {
        return Admission::Drop(DropReason::Tcp);
    }
    if !parsed.is_mdns() {
        return Admission::Accept;
    }
    match resolver.resolve(parsed.address) {
        Some(addr) => Admission::Resolved(rewrite_address(sdp, parsed.address, addr)),
        None => Admission::Drop(DropReason::UnresolvedMdns),
    }
}

/// Replace the connection-address field, and only that one, leaving every other
/// field of the attribute byte-identical.
fn rewrite_address(sdp: &str, address: &str, resolved: IpAddr) -> String {
    let mut out = String::with_capacity(sdp.len() + 16);
    let mut replaced = false;
    for (i, field) in sdp.trim().split_ascii_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        // Field 4 is the connection address, counting the `candidate:`-prefixed
        // foundation as field 0. The equality check is belt and braces: an
        // mDNS name cannot appear anywhere else in the attribute.
        if i == 4 && !replaced && field == address {
            out.push_str(&resolved.to_string());
            replaced = true;
        } else {
            out.push_str(field);
        }
    }
    out
}

// --------------------------------------------------------- the decisions ---

/// What the transport tells the policy. Edges only: there is no periodic tick
/// to report, and [`IcePolicy::poll`] is what runs the timers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IceEvent {
    /// ICE selected a pair and media can flow. `relayed` comes from that pair's
    /// own candidate type — see the module doc on why the classification proper
    /// lives in [`crate::transport::budget`].
    Connected { relayed: bool },
    /// The selected pair changed under a live session.
    PairChanged { relayed: bool },
    /// Checks are failing but the pair has not been given up on yet.
    Disconnected,
    /// ICE gave up.
    Failed,
    /// A Windows interface came up, went down or changed address.
    InterfaceChanged,
}

/// Why the policy is asking for an ICE restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartReason {
    /// The one promotion attempt: still on relay [`PROMOTION_PROBE`] after the
    /// pair was selected.
    RelayPromotion,
    /// `disconnected` outlasted [`DISCONNECTED_GRACE`].
    LinkDown,
    /// ICE reported `failed`.
    Failed,
    /// The machine's interfaces changed under a live session.
    InterfaceChanged,
}

/// What the caller is asked to do. One variant today, and an enum anyway
/// because the caller matches on it rather than on a bool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IceAction {
    /// Restart ICE with refreshed candidates. On this crate's side that is a
    /// fresh `accept_offer` once the browser re-offers, which is why the host
    /// asks for it rather than doing it.
    RestartIce(RestartReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Promotion {
    /// No relayed pair standing.
    Idle,
    /// A relayed pair has been selected since this instant.
    Armed(Instant),
    /// The one attempt is gone.
    Spent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Link {
    /// Before the first `Connected`, and after one.
    Up,
    /// Quiet since this instant.
    Down(Instant),
    /// A restart has been asked for; the next `Connected` clears it.
    Restarting,
}

/// The host's ICE state machine.
///
/// Sans-IO and driven by exactly one thread: [`observe`](Self::observe) for
/// every edge, [`poll`](Self::poll) once per turn for the timers. It owns no
/// socket, no clock and no thread — `now` is the caller's, so a test runs the
/// three-second promotion window without waiting three seconds.
#[derive(Debug)]
pub struct IcePolicy {
    promotion: Promotion,
    link: Link,
    last_restart: Option<Instant>,
    restarts: u32,
}

impl Default for IcePolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl IcePolicy {
    pub fn new() -> Self {
        Self {
            promotion: Promotion::Idle,
            link: Link::Up,
            last_restart: None,
            restarts: 0,
        }
    }

    /// Restarts this policy has asked for, over the life of the session.
    pub fn restarts(&self) -> u32 {
        self.restarts
    }

    /// True once the single promotion attempt has been used.
    pub fn promotion_spent(&self) -> bool {
        self.promotion == Promotion::Spent
    }

    /// Feed one edge. Returns the action it caused, if any.
    pub fn observe(&mut self, now: Instant, event: IceEvent) -> Option<IceAction> {
        match event {
            IceEvent::Connected { relayed } | IceEvent::PairChanged { relayed } => {
                self.link = Link::Up;
                self.arm_promotion(now, relayed);
                None
            }
            IceEvent::Disconnected => {
                // Already down, or already restarting: keep the first instant,
                // or the grace window restarts with every repeat of the event.
                if self.link == Link::Up {
                    self.link = Link::Down(now);
                }
                None
            }
            IceEvent::Failed => {
                // No grace: `failed` is ICE saying the checks are over.
                self.restart(now, RestartReason::Failed)
            }
            IceEvent::InterfaceChanged => self.restart(now, RestartReason::InterfaceChanged),
        }
    }

    /// Run the timers. Cheap enough for the session's own loop.
    pub fn poll(&mut self, now: Instant) -> Option<IceAction> {
        if let Link::Down(since) = self.link {
            if now.duration_since(since) >= DISCONNECTED_GRACE {
                if let Some(action) = self.restart(now, RestartReason::LinkDown) {
                    return Some(action);
                }
            }
        }
        if let Promotion::Armed(since) = self.promotion {
            if now.duration_since(since) >= PROMOTION_PROBE {
                // Spent whether or not the cooldown lets it out: the attempt
                // was owed to a pair that has since been restarted anyway, and
                // holding it armed is how one attempt becomes several.
                self.promotion = Promotion::Spent;
                return self.restart(now, RestartReason::RelayPromotion);
            }
        }
        None
    }

    fn arm_promotion(&mut self, now: Instant, relayed: bool) {
        self.promotion = match (self.promotion, relayed) {
            (Promotion::Spent, _) => Promotion::Spent,
            (Promotion::Armed(since), true) => Promotion::Armed(since),
            (_, true) => Promotion::Armed(now),
            // A direct pair needs no promotion, and disarming rather than
            // spending leaves the attempt for a later fall back to relay.
            (_, false) => Promotion::Idle,
        };
    }

    fn restart(&mut self, now: Instant, reason: RestartReason) -> Option<IceAction> {
        if let Some(last) = self.last_restart {
            if now.duration_since(last) < RESTART_COOLDOWN {
                return None;
            }
        }
        self.last_restart = Some(now);
        self.restarts += 1;
        if reason != RestartReason::RelayPromotion {
            self.link = Link::Restarting;
        }
        Some(IceAction::RestartIce(reason))
    }
}

// -------------------------------------------------------- interface watch ---

/// Windows interface-change notifications, as a flag the session loop reads.
///
/// `NotifyIpInterfaceChange` calls back on an OS thread pool thread, so the
/// callback does the least it can: set a flag. The session turns that into one
/// [`IceEvent::InterfaceChanged`], and [`RESTART_COOLDOWN`] is what makes a
/// burst — one callback per interface, which is what a VPN coming up looks like
/// — into a single restart.
#[cfg(windows)]
pub mod ifwatch {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// `MIB_NOTIFICATION_TYPE` is an `int`; the row pointer is optional and
    /// this callback does not read it.
    type ChangeCallback =
        unsafe extern "system" fn(context: *const c_void, row: *const c_void, kind: i32);

    // iphlpapi, declared here rather than through the `windows` crate: the
    // manifest names one feature list for the whole crate and this wave does
    // not edit it. Two entry points, both documented stable since Vista.
    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn NotifyIpInterfaceChange(
            family: u16,
            callback: ChangeCallback,
            context: *const c_void,
            initial_notification: u8,
            handle: *mut *mut c_void,
        ) -> u32;
        fn CancelMibChangeNotify2(handle: *mut c_void) -> u32;
    }

    /// `AF_UNSPEC` — IPv4 and IPv6 both, because either one changing can move
    /// which candidates are reachable.
    const AF_UNSPEC: u16 = 0;
    const NO_ERROR: u32 = 0;

    unsafe extern "system" fn on_change(context: *const c_void, _row: *const c_void, _kind: i32) {
        if context.is_null() {
            return;
        }
        // The registration holds an `Arc` to the same flag for as long as the
        // notification is live, and `CancelMibChangeNotify2` does not return
        // until no callback is running — so this pointer is valid here.
        unsafe { &*context.cast::<AtomicBool>() }.store(true, Ordering::Relaxed);
    }

    /// A live registration. Cancelled on drop.
    #[derive(Debug)]
    pub struct InterfaceWatcher {
        handle: *mut c_void,
        changed: Arc<AtomicBool>,
    }

    // The handle is only ever used by this struct, on whichever thread owns it;
    // the flag behind it is atomic. The raw pointer is what stops the compiler
    // seeing that for itself.
    unsafe impl Send for InterfaceWatcher {}

    impl InterfaceWatcher {
        /// Register for interface changes. `Err` is the Win32 error code, and a
        /// caller that cannot register carries on without the restart trigger
        /// rather than failing the session.
        pub fn start() -> Result<Self, u32> {
            let changed = Arc::new(AtomicBool::new(false));
            let context = Arc::as_ptr(&changed).cast::<c_void>();
            let mut handle: *mut c_void = std::ptr::null_mut();
            // No initial notification: the flag means "something changed since
            // we started", and an unconditional callback at registration would
            // make it mean "we started".
            let rc = unsafe {
                NotifyIpInterfaceChange(AF_UNSPEC, on_change, context, 0, &raw mut handle)
            };
            if rc != NO_ERROR {
                return Err(rc);
            }
            Ok(Self { handle, changed })
        }

        /// Take the flag: true once per burst of changes, then false again.
        pub fn take_changed(&self) -> bool {
            self.changed.swap(false, Ordering::Relaxed)
        }
    }

    impl Drop for InterfaceWatcher {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                // Returns only once every in-flight callback has finished, so
                // the `Arc` below it is safe to drop after this.
                unsafe { CancelMibChangeNotify2(self.handle) };
                self.handle = std::ptr::null_mut();
            }
        }
    }
}

/// The non-Windows seam: compiles, reports nothing, and Wave 9 fills it.
#[cfg(not(windows))]
pub mod ifwatch {
    #[derive(Debug, Default)]
    pub struct InterfaceWatcher;

    impl InterfaceWatcher {
        pub fn start() -> Result<Self, u32> {
            Ok(Self)
        }

        pub fn take_changed(&self) -> bool {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::Ipv4Addr;

    /// A resolver with a fixed table, so `.local` handling is testable off a
    /// LAN and without multicast.
    struct FakeResolver(HashMap<String, IpAddr>);

    impl FakeResolver {
        fn with(name: &str, addr: [u8; 4]) -> Self {
            let mut table = HashMap::new();
            table.insert(name.to_string(), IpAddr::V4(Ipv4Addr::from(addr)));
            Self(table)
        }

        fn empty() -> Self {
            Self(HashMap::new())
        }
    }

    impl MdnsResolver for FakeResolver {
        fn resolve(&self, name: &str) -> Option<IpAddr> {
            self.0.get(name).copied()
        }
    }

    const MDNS_NAME: &str = "5d2e0a1b-3c4d-4e5f-8a9b-0c1d2e3f4a5b.local";

    fn mdns_line() -> String {
        format!("candidate:1 1 udp 2122260223 {MDNS_NAME} 51234 typ host generation 0")
    }

    // ---------------------------------------------------------- parsing ---

    #[test]
    fn parses_with_and_without_the_prefix() {
        let with = parse_candidate("candidate:1 1 udp 2122260223 192.168.1.9 51234 typ host")
            .expect("prefixed");
        let without =
            parse_candidate("1 1 udp 2122260223 192.168.1.9 51234 typ host").expect("bare");
        assert_eq!(with, without);
        assert_eq!(with.address, "192.168.1.9");
        assert_eq!(with.port, 51234);
        assert_eq!(with.kind, CandidateKind::Host);
        assert!(!with.is_mdns());
    }

    #[test]
    fn reads_every_candidate_type() {
        for (token, kind) in [
            ("host", CandidateKind::Host),
            ("srflx", CandidateKind::Srflx),
            ("prflx", CandidateKind::Prflx),
            ("relay", CandidateKind::Relay),
        ] {
            let line = format!("candidate:1 1 udp 1 1.2.3.4 1 typ {token}");
            let parsed = parse_candidate(&line).expect("parses");
            assert_eq!(parsed.kind, kind);
            assert_eq!(parsed.kind.is_relayed(), kind == CandidateKind::Relay);
        }
    }

    #[test]
    fn a_truncated_or_mistyped_attribute_is_malformed() {
        for line in [
            "candidate:1 1 udp 2122260223 192.168.1.9",
            "candidate:1 1 udp 2122260223 192.168.1.9 51234 host",
            "candidate:1 1 udp 2122260223 192.168.1.9 notaport typ host",
            "candidate:1 1 udp 2122260223 192.168.1.9 51234 typ moon",
            "",
        ] {
            assert_eq!(
                admit_remote(line, &FakeResolver::empty()),
                Admission::Drop(DropReason::Malformed),
                "{line}"
            );
        }
    }

    #[test]
    fn recognises_an_mdns_name_and_not_a_literal() {
        let line = mdns_line();
        assert!(parse_candidate(&line).expect("parses").is_mdns());
        // A trailing root dot is legal spelling of the same name.
        assert!(parse_candidate("candidate:1 1 udp 1 host.local. 1 typ host")
            .expect("parses")
            .is_mdns());
        assert!(!parse_candidate("candidate:1 1 udp 1 10.0.0.4 1 typ host")
            .expect("parses")
            .is_mdns());
        // `.local` alone is a suffix and not a name.
        assert!(!parse_candidate("candidate:1 1 udp 1 .local 1 typ host")
            .expect("parses")
            .is_mdns());
    }

    // -------------------------------------------------------- admission ---

    #[test]
    fn an_mdns_candidate_is_forwarded_with_its_resolved_address() {
        let resolver = FakeResolver::with(MDNS_NAME, [192, 168, 1, 41]);
        let Admission::Resolved(line) = admit_remote(&mdns_line(), &resolver) else {
            panic!("expected the name to resolve");
        };
        assert_eq!(
            line,
            "candidate:1 1 udp 2122260223 192.168.1.41 51234 typ host generation 0"
        );
        // And the rewritten line is still a candidate the parser accepts.
        let parsed = parse_candidate(&line).expect("parses");
        assert_eq!(parsed.address, "192.168.1.41");
        assert!(!parsed.is_mdns());
    }

    #[test]
    fn an_unresolvable_mdns_candidate_is_dropped_rather_than_forwarded() {
        // Multicast suppressed on the switch, or a different subnet: str0m
        // cannot parse the name into a SocketAddr, so forwarding it is an
        // error rather than a pair that fails a check.
        assert_eq!(
            admit_remote(&mdns_line(), &FakeResolver::empty()),
            Admission::Drop(DropReason::UnresolvedMdns)
        );
    }

    #[test]
    fn a_literal_candidate_passes_through_untouched() {
        assert_eq!(
            admit_remote(
                "candidate:2 1 UDP 1686052607 203.0.113.7 51234 typ srflx raddr 10.0.0.4 rport 51234",
                &FakeResolver::empty()
            ),
            Admission::Accept
        );
    }

    #[test]
    fn tcp_candidates_are_refused_in_both_directions() {
        // The browser's only TCP candidates are `tcptype active` toward
        // TURN-TCP; there is nothing here for them to pair with.
        assert_eq!(
            admit_remote(
                "candidate:3 1 tcp 1518214911 203.0.113.7 9 typ host tcptype active",
                &FakeResolver::empty()
            ),
            Admission::Drop(DropReason::Tcp)
        );
        assert!(gathers_local_transport("udp"));
        assert!(gathers_local_transport("UDP"));
        assert!(!gathers_local_transport("tcp"));
        assert!(!gathers_local_transport("ssltcp"));
    }

    // -------------------------------------------------------- promotion ---

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn a_relayed_pair_earns_exactly_one_restart() {
        let base = Instant::now();
        let mut policy = IcePolicy::new();

        assert_eq!(
            policy.observe(base, IceEvent::Connected { relayed: true }),
            None
        );
        // Nothing before the window is up.
        assert_eq!(policy.poll(at(base, 2_999)), None);
        assert_eq!(
            policy.poll(at(base, 3_000)),
            Some(IceAction::RestartIce(RestartReason::RelayPromotion))
        );
        assert!(policy.promotion_spent());

        // Still relayed after the restart: no second attempt, ever.
        assert_eq!(
            policy.observe(at(base, 4_000), IceEvent::Connected { relayed: true }),
            None
        );
        for ms in [7_000, 10_000, 60_000] {
            assert_eq!(policy.poll(at(base, ms)), None, "at {ms} ms");
        }
        assert_eq!(policy.restarts(), 1);
    }

    #[test]
    fn a_direct_pair_is_left_alone() {
        let base = Instant::now();
        let mut policy = IcePolicy::new();

        policy.observe(base, IceEvent::Connected { relayed: false });
        assert_eq!(policy.poll(at(base, 30_000)), None);
        assert_eq!(policy.restarts(), 0);
        assert!(!policy.promotion_spent());
    }

    #[test]
    fn a_pair_that_goes_direct_inside_the_window_never_promotes() {
        let base = Instant::now();
        let mut policy = IcePolicy::new();

        policy.observe(base, IceEvent::Connected { relayed: true });
        policy.observe(at(base, 1_500), IceEvent::PairChanged { relayed: false });
        assert_eq!(policy.poll(at(base, 3_000)), None);

        // And the unspent attempt is still there if it falls back to relay.
        policy.observe(at(base, 4_000), IceEvent::PairChanged { relayed: true });
        assert_eq!(policy.poll(at(base, 6_999)), None);
        assert_eq!(
            policy.poll(at(base, 7_000)),
            Some(IceAction::RestartIce(RestartReason::RelayPromotion))
        );
    }

    #[test]
    fn a_repeated_relay_observation_does_not_reset_the_window() {
        let base = Instant::now();
        let mut policy = IcePolicy::new();

        policy.observe(base, IceEvent::Connected { relayed: true });
        policy.observe(at(base, 1_000), IceEvent::PairChanged { relayed: true });
        policy.observe(at(base, 2_000), IceEvent::PairChanged { relayed: true });
        assert_eq!(
            policy.poll(at(base, 3_000)),
            Some(IceAction::RestartIce(RestartReason::RelayPromotion))
        );
    }

    // --------------------------------------------------------- recovery ---

    #[test]
    fn disconnected_restarts_after_the_grace_window_and_not_before() {
        let base = Instant::now();
        let mut policy = IcePolicy::new();
        policy.observe(base, IceEvent::Connected { relayed: false });

        policy.observe(at(base, 1_000), IceEvent::Disconnected);
        assert_eq!(policy.poll(at(base, 2_500)), None);
        assert_eq!(
            policy.poll(at(base, 3_000)),
            Some(IceAction::RestartIce(RestartReason::LinkDown))
        );
        // One restart for the episode: the timer does not re-arm itself.
        assert_eq!(policy.poll(at(base, 20_000)), None);
        assert_eq!(policy.restarts(), 1);
    }

    #[test]
    fn a_repeated_disconnected_keeps_the_first_instant() {
        let base = Instant::now();
        let mut policy = IcePolicy::new();
        policy.observe(base, IceEvent::Connected { relayed: false });

        for ms in [1_000, 1_500, 2_500] {
            assert_eq!(policy.observe(at(base, ms), IceEvent::Disconnected), None);
        }
        // 2 s after the *first* one, not after the last.
        assert_eq!(
            policy.poll(at(base, 3_000)),
            Some(IceAction::RestartIce(RestartReason::LinkDown))
        );
    }

    #[test]
    fn a_link_that_comes_back_inside_the_grace_window_is_not_restarted() {
        let base = Instant::now();
        let mut policy = IcePolicy::new();
        policy.observe(base, IceEvent::Connected { relayed: false });

        policy.observe(at(base, 1_000), IceEvent::Disconnected);
        policy.observe(at(base, 2_000), IceEvent::Connected { relayed: false });
        assert_eq!(policy.poll(at(base, 10_000)), None);
        assert_eq!(policy.restarts(), 0);
    }

    #[test]
    fn failed_restarts_at_once() {
        let base = Instant::now();
        let mut policy = IcePolicy::new();

        assert_eq!(
            policy.observe(base, IceEvent::Failed),
            Some(IceAction::RestartIce(RestartReason::Failed))
        );
    }

    #[test]
    fn an_interface_burst_is_one_restart() {
        let base = Instant::now();
        let mut policy = IcePolicy::new();
        policy.observe(base, IceEvent::Connected { relayed: false });

        assert_eq!(
            policy.observe(at(base, 1_000), IceEvent::InterfaceChanged),
            Some(IceAction::RestartIce(RestartReason::InterfaceChanged))
        );
        // A VPN coming up is one callback per interface.
        for ms in [1_010, 1_050, 2_000, 5_500] {
            assert_eq!(
                policy.observe(at(base, ms), IceEvent::InterfaceChanged),
                None,
                "at {ms} ms"
            );
        }
        // Past the cooldown it is a real event again.
        assert_eq!(
            policy.observe(at(base, 6_500), IceEvent::InterfaceChanged),
            Some(IceAction::RestartIce(RestartReason::InterfaceChanged))
        );
        assert_eq!(policy.restarts(), 2);
    }

    #[test]
    fn the_cooldown_does_not_hand_the_promotion_attempt_back() {
        let base = Instant::now();
        let mut policy = IcePolicy::new();
        policy.observe(base, IceEvent::Connected { relayed: true });
        // A failure inside the promotion window takes the restart.
        policy.observe(at(base, 500), IceEvent::Failed);

        // The promotion falls due inside the cooldown, so it is refused — and
        // it is spent rather than held, or one attempt becomes two.
        assert_eq!(policy.poll(at(base, 3_000)), None);
        assert!(policy.promotion_spent());
        assert_eq!(policy.restarts(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn the_interface_watcher_registers_and_cancels() {
        // The FFI itself: a real interface change cannot be forced from a unit
        // test, but a bad signature or a missing import library fails here.
        let watcher = ifwatch::InterfaceWatcher::start().expect("NotifyIpInterfaceChange");
        assert!(!watcher.take_changed());
        drop(watcher);
    }
}
