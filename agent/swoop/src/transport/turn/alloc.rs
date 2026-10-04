//! One TURN allocation (RFC 8656 over UDP, long-term credentials), sans-IO
//! like [`crate::transport::stun`]: the caller feeds it the server's datagrams
//! and the time, and puts on the socket what it hands back.
//!
//! The first Allocate goes out without credentials and draws the server's 401
//! challenge; its REALM and NONCE make the long-term key, and every request
//! after that is signed with it. The allocation is refreshed at half the
//! lifetime the server grants, a permission is kept for each public peer IP
//! the caller names, and a channel bound to a peer carries that peer's
//! datagrams in four bytes of framing instead of a Send indication's
//! thirty-six.
//!
//! The username and password leave this struct only inside the requests:
//! [`Allocation`]'s `Debug` leaves them out, [`Step`]'s shows only how long a
//! request is, and nothing here logs.

use std::collections::VecDeque;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};

use super::wire::{
    self, Builder, Class, Message, Method, TransactionId, CHANNELS, CHANNEL_NUMBER, DATA, LIFETIME,
    NONCE, REALM, REQUESTED_TRANSPORT, TRANSPORT_UDP, USERNAME, XOR_MAPPED_ADDRESS,
    XOR_PEER_ADDRESS, XOR_RELAYED_ADDRESS,
};
use crate::transport::stun::{INITIAL_RTO, LAST_WAIT_RTOS, MAX_REQUESTS};

/// The lifetime every Allocate and Refresh asks for, in seconds, and what a
/// success that names none is taken to grant: RFC 8656's default.
const LIFETIME_SECS: u32 = 600;
/// Permissions last 300 s (RFC 8656 §9), renewed with a minute to spare.
const PERMISSION_REFRESH: Duration = Duration::from_secs(4 * 60);
/// Channel bindings last 600 s (RFC 8656 §12), renewed with a minute to spare.
const CHANNEL_REFRESH: Duration = Duration::from_secs(9 * 60);
/// New peer IPs per window, under Cloudflare's five a second (plan.md
/// decision 7).
const NEW_PERMITS_PER_WINDOW: usize = 4;
const PERMIT_WINDOW: Duration = Duration::from_secs(1);
/// The largest payload [`Allocation::wrap`] frames: a UDP datagram's 65,507
/// bytes less a Send indication's 36 of framing and 3 of padding.
const MAX_PAYLOAD: usize = 65_507 - 39;

/// Why the allocation, or one peer's permission or channel, was lost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The request went unanswered through every retransmit.
    Unanswered(Method),
    /// The server answered the request with this error code. A 401 to a
    /// signed request means the credentials are wrong.
    Refused { method: Method, code: u16 },
    /// An Allocate success with no IPv4 XOR-RELAYED-ADDRESS in it.
    NoRelayedAddress,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Asking: the first Allocate, or its signed retry.
    Allocating,
    /// `relayed` is the relayed candidate's address; `mapped`, when the
    /// server says, is where it saw the requests come from.
    Allocated {
        relayed: SocketAddr,
        mapped: Option<SocketAddr>,
    },
    /// Given back with [`Allocation::release`].
    Released,
    Failed(Failure),
}

/// What [`Allocation::poll`] wants done.
#[derive(Clone, PartialEq, Eq)]
pub enum Step {
    /// Put these bytes on the socket, to [`Allocation::server`].
    Send(Vec<u8>),
    /// The allocation is over. Said once.
    Failed(Failure),
    /// The permission or channel for `peer` is gone; the allocation stands.
    Dropped { peer: IpAddr, failure: Failure },
}

/// Only a request's length: its bytes carry the username.
impl fmt::Debug for Step {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Send(bytes) => write!(f, "Send(<{} bytes>)", bytes.len()),
            Self::Failed(failure) => f.debug_tuple("Failed").field(failure).finish(),
            Self::Dropped { peer, failure } => f
                .debug_struct("Dropped")
                .field("peer", peer)
                .field("failure", failure)
                .finish(),
        }
    }
}

/// What one datagram from the server meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event<'a> {
    /// The allocation succeeded. Said once.
    Allocated {
        relayed: SocketAddr,
        mapped: Option<SocketAddr>,
    },
    /// A datagram `peer` sent to the relayed address.
    Relayed { peer: SocketAddr, payload: &'a [u8] },
    /// TURN traffic with nothing in it for the caller: an answer that moved
    /// the allocation along, a late duplicate, or one that failed its checks.
    Consumed,
    /// The allocation is over. Said once.
    Failed(Failure),
    /// The permission or channel for `peer` is gone; the allocation stands.
    Dropped { peer: IpAddr, failure: Failure },
    /// Not TURN: a Binding answer, or not STUN at all.
    Foreign,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Purpose {
    Allocate,
    Refresh,
    Permission(Ipv4Addr),
    Channel { number: u16, peer: SocketAddrV4 },
}

impl Purpose {
    fn method(self) -> Method {
        match self {
            Self::Allocate => Method::Allocate,
            Self::Refresh => Method::Refresh,
            Self::Permission(_) => Method::CreatePermission,
            Self::Channel { .. } => Method::ChannelBind,
        }
    }
}

/// One request, its retransmits and its answer.
struct Transaction {
    id: TransactionId,
    purpose: Purpose,
    bytes: Vec<u8>,
    /// Whether `bytes` carries MESSAGE-INTEGRITY.
    signed: bool,
    /// Whether a 438 has already earned this request its one retry.
    retried_stale: bool,
    sent: u32,
    /// When the next send is due or, after the last, when the wait for its
    /// answer ends; `None` until the first send, which is due at once.
    due: Option<Instant>,
    rto: Duration,
    /// Lifetimes are counted from here, since the server's count began no
    /// earlier.
    first_sent: Option<Instant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Next {
    /// Never asked: waiting for the allocation and, for a permission, the
    /// rate limit.
    Queued,
    InFlight,
    /// Renewed at this instant.
    At(Instant),
}

struct Permission {
    ip: Ipv4Addr,
    installed: bool,
    next: Next,
}

struct Channel {
    number: u16,
    peer: SocketAddrV4,
    bound: bool,
    next: Next,
}

/// The server's challenge and the key it makes.
struct Challenge {
    realm: Vec<u8>,
    nonce: Vec<u8>,
    key: [u8; 16],
}

/// One relayed address on one TURN server, held from one socket.
pub struct Allocation {
    server: SocketAddr,
    username: String,
    password: String,
    challenge: Option<Challenge>,
    state: State,
    transactions: Vec<Transaction>,
    /// When the allocation is next refreshed; `None` while a refresh is in
    /// flight or before there is an allocation.
    refresh_at: Option<Instant>,
    permissions: Vec<Permission>,
    channels: Vec<Channel>,
    next_channel: u16,
    /// When the latest new permissions went out, at most a window's worth.
    recent_permits: VecDeque<Instant>,
    /// The latest time the caller gave: work due at once is due then.
    now: Instant,
}

/// Leaves out the credentials, and the realm and nonce with them.
impl fmt::Debug for Allocation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Allocation")
            .field("server", &self.server)
            .field("state", &self.state)
            .field("transactions", &self.transactions.len())
            .field("permissions", &self.permissions.len())
            .field("channels", &self.channels.len())
            .finish_non_exhaustive()
    }
}

impl Allocation {
    /// An allocation on `server` whose first Allocate is due at `now`.
    pub fn new(
        server: SocketAddr,
        username: impl Into<String>,
        password: impl Into<String>,
        now: Instant,
    ) -> Self {
        let mut allocation = Self {
            server,
            username: username.into(),
            password: password.into(),
            challenge: None,
            state: State::Allocating,
            transactions: Vec::new(),
            refresh_at: None,
            permissions: Vec::new(),
            channels: Vec::new(),
            next_channel: *CHANNELS.start(),
            recent_permits: VecDeque::with_capacity(NEW_PERMITS_PER_WINDOW),
            now,
        };
        allocation.start(Purpose::Allocate, false);
        allocation
    }

    pub fn server(&self) -> SocketAddr {
        self.server
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn relayed_addr(&self) -> Option<SocketAddr> {
        match self.state {
            State::Allocated { relayed, .. } => Some(relayed),
            _ => None,
        }
    }

    /// Keep a permission for `peer` for as long as the allocation lives,
    /// asked for once allocated and at most four new IPs a second. `false`,
    /// with nothing asked, for anything but a public IPv4 address — the relay
    /// cannot reach the rest and Cloudflare refuses them — or once the
    /// allocation is over.
    pub fn permit(&mut self, peer: IpAddr) -> bool {
        let Some(ip) = public_ipv4(peer) else {
            return false;
        };
        if !self.is_live() {
            return false;
        }
        if !self
            .permissions
            .iter()
            .any(|permission| permission.ip == ip)
        {
            self.permissions.push(Permission {
                ip,
                installed: false,
                next: Next::Queued,
            });
        }
        true
    }

    /// Bind a channel to `peer`, renewed while the allocation lives;
    /// [`wrap`](Self::wrap) uses it once the server confirms. The channel's
    /// number — the same one again for a peer already bound — or `None` for a
    /// peer that is not public IPv4, once the allocation is over, or with
    /// every number spent (numbers are never reused, so a refused binding
    /// cannot collide with one the server still holds).
    pub fn bind_channel(&mut self, peer: SocketAddr) -> Option<u16> {
        let SocketAddr::V4(peer) = peer else {
            return None;
        };
        public_ipv4(IpAddr::V4(*peer.ip()))?;
        if !self.is_live() {
            return None;
        }
        if let Some(channel) = self.channels.iter().find(|channel| channel.peer == peer) {
            return Some(channel.number);
        }
        let number = self.next_channel;
        if !CHANNELS.contains(&number) {
            return None;
        }
        self.next_channel += 1;
        self.channels.push(Channel {
            number,
            peer,
            bound: false,
            next: Next::Queued,
        });
        Some(number)
    }

    /// `payload` framed for `peer` through the relay, to send to the server:
    /// ChannelData on a bound channel, else a Send indication to a permitted
    /// IP. `None` when it is neither, since the server would drop it, when
    /// there is no allocation, and for a payload no datagram can carry.
    pub fn wrap(&self, peer: SocketAddr, payload: &[u8]) -> Option<Vec<u8>> {
        let SocketAddr::V4(peer) = peer else {
            return None;
        };
        if !self.is_allocated() || payload.len() > MAX_PAYLOAD {
            return None;
        }
        if let Some(channel) = self
            .channels
            .iter()
            .find(|channel| channel.bound && channel.peer == peer)
        {
            return Some(wire::channel_data(channel.number, payload));
        }
        self.permissions
            .iter()
            .any(|permission| permission.installed && permission.ip == *peer.ip())
            .then(|| {
                Builder::new(Method::Send, Class::Indication, &rand::random())
                    .address(XOR_PEER_ADDRESS, peer)
                    .attribute(DATA, payload)
                    .build()
            })
    }

    /// The Refresh with LIFETIME 0 that gives the allocation back, to send
    /// once: a teardown does not wait for the answer, and a lost one only
    /// leaves the server to expire the allocation itself. `None` without an
    /// allocation. Either way this one is over.
    pub fn release(&mut self) -> Option<Vec<u8>> {
        let release = self.is_allocated().then(|| {
            let request = Builder::new(Method::Refresh, Class::Request, &rand::random())
                .attribute(LIFETIME, &0u32.to_be_bytes());
            self.signed(request).0
        });
        if self.is_live() {
            self.end(State::Released);
        }
        release
    }

    /// When [`poll`](Self::poll) next has something to do; `None` once the
    /// allocation is over. A deadline at or before the last `now` means poll
    /// again at once.
    pub fn deadline(&self) -> Option<Instant> {
        if !self.is_live() {
            return None;
        }
        let allocated = self.is_allocated();
        let next = |next: Next, queued: Instant| match next {
            Next::Queued => allocated.then_some(queued),
            Next::InFlight => None,
            Next::At(at) => Some(at),
        };
        self.transactions
            .iter()
            .map(|transaction| transaction.due.unwrap_or(self.now))
            .chain(self.refresh_at)
            .chain(
                self.permissions
                    .iter()
                    .filter_map(|permission| next(permission.next, self.permit_slot())),
            )
            .chain(
                self.channels
                    .iter()
                    .filter_map(|channel| next(channel.next, self.now)),
            )
            .min()
    }

    /// The requests due at `now` — new ones, renewals and retransmits — and
    /// what gave up waiting for an answer.
    pub fn poll(&mut self, now: Instant) -> Vec<Step> {
        self.now = now;
        if self.is_allocated() {
            self.schedule(now);
        }
        let mut steps = Vec::new();
        let mut index = 0;
        while let Some(transaction) = self.transactions.get_mut(index) {
            if transaction.due.is_some_and(|due| now < due) {
                index += 1;
                continue;
            }
            if transaction.sent < MAX_REQUESTS {
                transaction.sent += 1;
                transaction.first_sent.get_or_insert(now);
                let wait = if transaction.sent == MAX_REQUESTS {
                    INITIAL_RTO * LAST_WAIT_RTOS
                } else {
                    transaction.rto
                };
                transaction.rto *= 2;
                transaction.due = Some(now + wait);
                steps.push(Step::Send(transaction.bytes.clone()));
                index += 1;
                continue;
            }
            let transaction = self.transactions.remove(index);
            let failure = Failure::Unanswered(transaction.purpose.method());
            match self.lose(transaction.purpose, failure) {
                Some(peer) => steps.push(Step::Dropped { peer, failure }),
                None => {
                    steps.push(Step::Failed(failure));
                    break;
                }
            }
        }
        steps
    }

    /// One datagram that came from [`server`](Self::server). Malformed input
    /// is [`Event::Foreign`], never a panic.
    pub fn on_datagram<'a>(&mut self, datagram: &'a [u8]) -> Event<'a> {
        if let Some((number, payload)) = wire::read_channel_data(datagram) {
            return match self
                .channels
                .iter()
                .find(|channel| channel.number == number)
            {
                Some(channel) => Event::Relayed {
                    peer: channel.peer.into(),
                    payload,
                },
                None => Event::Consumed,
            };
        }
        let Some(message) = Message::parse(datagram) else {
            return Event::Foreign;
        };
        match (message.method(), message.class()) {
            (Some(Method::Data), Class::Indication) => {
                let peer = message.address(XOR_PEER_ADDRESS);
                match (peer, message.attribute(DATA)) {
                    (Some(peer), Some(payload)) if self.is_allocated() => {
                        Event::Relayed { peer, payload }
                    }
                    _ => Event::Consumed,
                }
            }
            (Some(method), Class::Success | Class::Error) => self.on_response(method, &message),
            _ => Event::Foreign,
        }
    }

    fn is_live(&self) -> bool {
        matches!(self.state, State::Allocating | State::Allocated { .. })
    }

    fn is_allocated(&self) -> bool {
        matches!(self.state, State::Allocated { .. })
    }

    /// When the next new permission may go out.
    fn permit_slot(&self) -> Instant {
        match self.recent_permits.front() {
            Some(&oldest) if self.recent_permits.len() == NEW_PERMITS_PER_WINDOW => {
                oldest + PERMIT_WINDOW
            }
            _ => self.now,
        }
    }

    /// Starts what is due at `now`: the allocation's refresh, new permissions
    /// as the rate limit allows, renewals, and channel bindings.
    fn schedule(&mut self, now: Instant) {
        if self.refresh_at.is_some_and(|at| at <= now) {
            self.refresh_at = None;
            self.start(Purpose::Refresh, false);
        }
        for index in 0..self.permissions.len() {
            let (ip, next) = (self.permissions[index].ip, self.permissions[index].next);
            match next {
                Next::Queued if self.permit_slot() <= now => {
                    if self.recent_permits.len() == NEW_PERMITS_PER_WINDOW {
                        self.recent_permits.pop_front();
                    }
                    self.recent_permits.push_back(now);
                }
                Next::At(at) if at <= now => {}
                _ => continue,
            }
            self.permissions[index].next = Next::InFlight;
            self.start(Purpose::Permission(ip), false);
        }
        for index in 0..self.channels.len() {
            let channel = &mut self.channels[index];
            if matches!(channel.next, Next::Queued)
                || matches!(channel.next, Next::At(at) if at <= now)
            {
                channel.next = Next::InFlight;
                let purpose = Purpose::Channel {
                    number: channel.number,
                    peer: channel.peer,
                };
                self.start(purpose, false);
            }
        }
    }

    /// Queues a new transaction for `purpose`, sent on the next poll.
    fn start(&mut self, purpose: Purpose, retried_stale: bool) {
        let id = rand::random();
        let (bytes, signed) = self.request(purpose, &id);
        self.transactions.push(Transaction {
            id,
            purpose,
            bytes,
            signed,
            retried_stale,
            sent: 0,
            due: None,
            rto: INITIAL_RTO,
            first_sent: None,
        });
    }

    fn request(&self, purpose: Purpose, id: &TransactionId) -> (Vec<u8>, bool) {
        let request = Builder::new(purpose.method(), Class::Request, id);
        let request = match purpose {
            Purpose::Allocate => request
                .attribute(REQUESTED_TRANSPORT, &[TRANSPORT_UDP, 0, 0, 0])
                .attribute(LIFETIME, &LIFETIME_SECS.to_be_bytes()),
            Purpose::Refresh => request.attribute(LIFETIME, &LIFETIME_SECS.to_be_bytes()),
            Purpose::Permission(ip) => request.address(XOR_PEER_ADDRESS, SocketAddrV4::new(ip, 0)),
            Purpose::Channel { number, peer } => {
                let [high, low] = number.to_be_bytes();
                request
                    .attribute(CHANNEL_NUMBER, &[high, low, 0, 0])
                    .address(XOR_PEER_ADDRESS, peer)
            }
        };
        self.signed(request)
    }

    /// The request finished — signed with the long-term key once the server
    /// has challenged, then fingerprinted — and whether it was signed.
    fn signed(&self, request: Builder) -> (Vec<u8>, bool) {
        let request = match &self.challenge {
            Some(challenge) => request
                .attribute(USERNAME, self.username.as_bytes())
                .attribute(REALM, &challenge.realm)
                .attribute(NONCE, &challenge.nonce)
                .integrity(&challenge.key),
            None => request,
        };
        (request.fingerprint().build(), self.challenge.is_some())
    }

    fn on_response(&mut self, method: Method, message: &Message) -> Event<'static> {
        let Some(index) = self
            .transactions
            .iter()
            .position(|transaction| transaction.id == message.transaction())
        else {
            // a late answer to a retransmit, or the stun client's binding
            // from the same server
            return if method == Method::Binding {
                Event::Foreign
            } else {
                Event::Consumed
            };
        };
        if self.transactions[index].purpose.method() != method {
            return Event::Consumed;
        }
        // an answer whose integrity fails is not the server's: the request
        // keeps retransmitting until the real one comes. one with no
        // integrity at all is taken on its transaction id, as stun.rs takes
        // its answers, because a 401 or 438 never carries any
        if let Some(challenge) = &self.challenge {
            if message.integrity_matches(&challenge.key) == Some(false) {
                return Event::Consumed;
            }
        }
        let transaction = self.transactions.remove(index);
        match message.class() {
            Class::Success => self.on_success(&transaction, message),
            _ => self.on_error(&transaction, message),
        }
    }

    fn on_success(&mut self, transaction: &Transaction, message: &Message) -> Event<'static> {
        let since = transaction.first_sent.unwrap_or(self.now);
        match transaction.purpose {
            Purpose::Allocate => {
                let Some(relayed) = message.address(XOR_RELAYED_ADDRESS) else {
                    let failure = Failure::NoRelayedAddress;
                    self.end(State::Failed(failure));
                    return Event::Failed(failure);
                };
                let mapped = message.address(XOR_MAPPED_ADDRESS);
                self.state = State::Allocated { relayed, mapped };
                self.refresh_at = Some(since + granted(message) / 2);
                Event::Allocated { relayed, mapped }
            }
            Purpose::Refresh => {
                self.refresh_at = Some(since + granted(message) / 2);
                Event::Consumed
            }
            Purpose::Permission(ip) => {
                if let Some(permission) = self.permissions.iter_mut().find(|p| p.ip == ip) {
                    permission.installed = true;
                    permission.next = Next::At(since + PERMISSION_REFRESH);
                }
                Event::Consumed
            }
            Purpose::Channel { number, .. } => {
                if let Some(channel) = self.channels.iter_mut().find(|c| c.number == number) {
                    channel.bound = true;
                    channel.next = Next::At(since + CHANNEL_REFRESH);
                }
                Event::Consumed
            }
        }
    }

    /// A 401 to the unsigned first request is the challenge, and a 438 earns
    /// a signed request one retry with the new nonce; anything else loses
    /// what the request was for.
    fn on_error(&mut self, transaction: &Transaction, message: &Message) -> Event<'static> {
        let code = message.error_code().unwrap_or(0);
        let retry = match code {
            401 => !transaction.signed,
            438 => transaction.signed && !transaction.retried_stale,
            _ => false,
        };
        if retry {
            if let Some(challenge) = self.challenge_in(message) {
                self.challenge = Some(challenge);
                self.start(transaction.purpose, code == 438);
                return Event::Consumed;
            }
        }
        let failure = Failure::Refused {
            method: transaction.purpose.method(),
            code,
        };
        match self.lose(transaction.purpose, failure) {
            Some(peer) => Event::Dropped { peer, failure },
            None => Event::Failed(failure),
        }
    }

    /// The realm and nonce a 401 or 438 carries, and the key they make. A 438
    /// may leave the realm out, keeping the one already held.
    fn challenge_in(&self, message: &Message) -> Option<Challenge> {
        let nonce = message.attribute(NONCE)?;
        let realm = match message.attribute(REALM) {
            Some(realm) => realm,
            None => &self.challenge.as_ref()?.realm,
        };
        Some(Challenge {
            realm: realm.to_vec(),
            nonce: nonce.to_vec(),
            key: wire::long_term_key(self.username.as_bytes(), realm, self.password.as_bytes()),
        })
    }

    /// Takes down what a failed request was for: the allocation, and `None`,
    /// or one peer's permission or channel, and that peer.
    fn lose(&mut self, purpose: Purpose, failure: Failure) -> Option<IpAddr> {
        match purpose {
            Purpose::Allocate | Purpose::Refresh => {
                self.end(State::Failed(failure));
                None
            }
            Purpose::Permission(ip) => {
                self.permissions.retain(|permission| permission.ip != ip);
                Some(ip.into())
            }
            Purpose::Channel { number, peer } => {
                self.channels.retain(|channel| channel.number != number);
                Some((*peer.ip()).into())
            }
        }
    }

    fn end(&mut self, state: State) {
        self.state = state;
        self.transactions.clear();
        self.permissions.clear();
        self.channels.clear();
        self.refresh_at = None;
    }
}

/// The lifetime a success grants: its LIFETIME, or the default when it names
/// none or zero.
fn granted(message: &Message) -> Duration {
    let seconds = message
        .lifetime()
        .filter(|&seconds| seconds > 0)
        .unwrap_or(LIFETIME_SECS);
    Duration::from_secs(seconds.into())
}

/// `ip` when a relay can reach it: public IPv4. Private, loopback,
/// link-local, unspecified, multicast and reserved space is refused, and so
/// is 100.64.0.0/10 — carrier-grade NAT, and the addresses Tailscale hands
/// out, which turn up as host candidates and are reachable from no relay.
fn public_ipv4(ip: IpAddr) -> Option<Ipv4Addr> {
    let IpAddr::V4(ip) = ip else {
        return None;
    };
    let [first, second, ..] = ip.octets();
    let this_network = first == 0;
    let shared = first == 100 && second & 0xc0 == 64;
    let reserved = first >= 240;
    let unreachable = ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || this_network
        || shared
        || reserved;
    (!unreachable).then_some(ip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::turn::md5;
    use crate::transport::turn::wire::ERROR_CODE;

    const USER: &str = "1759500000:swoop-host-user";
    const PASS: &str = "c3dvb3AtdHVybi1wYXNzd29yZA==";
    const TEST_REALM: &str = "turn.example.org";
    const NONCE_1: &[u8] = b"nonce-one";
    const NONCE_2: &[u8] = b"nonce-two";

    fn v4(address: &str) -> SocketAddrV4 {
        address.parse().expect("a literal address")
    }

    fn server() -> SocketAddr {
        "203.0.113.9:3478".parse().expect("a literal address")
    }

    fn relayed() -> SocketAddrV4 {
        v4("203.0.113.9:50000")
    }

    fn mapped() -> SocketAddrV4 {
        v4("198.51.100.4:41000")
    }

    fn peer() -> SocketAddrV4 {
        v4("198.51.100.77:62000")
    }

    fn ip(address: SocketAddrV4) -> IpAddr {
        IpAddr::V4(*address.ip())
    }

    fn seconds(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    /// The key the long way round, not through the code under test.
    fn key() -> [u8; 16] {
        md5::digest(format!("{USER}:{TEST_REALM}:{PASS}").as_bytes())
    }

    fn sends(steps: Vec<Step>) -> Vec<Vec<u8>> {
        steps
            .into_iter()
            .map(|step| match step {
                Step::Send(bytes) => bytes,
                other => panic!("expected a request, got {other:?}"),
            })
            .collect()
    }

    fn one_send(steps: Vec<Step>) -> Vec<u8> {
        let mut sent = sends(steps);
        assert_eq!(sent.len(), 1, "one request");
        sent.remove(0)
    }

    /// A request read the way a TURN server reads it: the credentials there
    /// and the integrity recomputed under the long-term key.
    fn signed<'a>(bytes: &'a [u8], nonce: &[u8]) -> Message<'a> {
        let message = Message::parse(bytes).expect("well framed, with a good fingerprint");
        assert_eq!(message.class(), Class::Request);
        assert_eq!(message.attribute(USERNAME), Some(USER.as_bytes()));
        assert_eq!(message.attribute(REALM), Some(TEST_REALM.as_bytes()));
        assert_eq!(message.attribute(NONCE), Some(nonce));
        assert_eq!(
            message.integrity_matches(&key()),
            Some(true),
            "signed with the long-term key"
        );
        message
    }

    /// The server's success for `request`, signed as a real server signs it.
    fn success(request: &Message, attributes: impl FnOnce(Builder) -> Builder) -> Vec<u8> {
        let method = request.method().expect("a turn method");
        attributes(Builder::new(method, Class::Success, &request.transaction()))
            .integrity(&key())
            .fingerprint()
            .build()
    }

    /// The server's error for `request`, unsigned as a 401 or 438 is, with a
    /// challenge when given a nonce.
    fn error(request: &Message, code: u16, nonce: Option<&[u8]>) -> Vec<u8> {
        let method = request.method().expect("a turn method");
        let class_and_number = [(code / 100) as u8, (code % 100) as u8];
        let mut answer = Builder::new(method, Class::Error, &request.transaction()).attribute(
            ERROR_CODE,
            &[0, 0, class_and_number[0], class_and_number[1]],
        );
        if let Some(nonce) = nonce {
            answer = answer
                .attribute(REALM, TEST_REALM.as_bytes())
                .attribute(NONCE, nonce);
        }
        answer.fingerprint().build()
    }

    fn allocate_success(request: &Message) -> Vec<u8> {
        success(request, |answer| {
            answer
                .address(XOR_RELAYED_ADDRESS, relayed())
                .address(XOR_MAPPED_ADDRESS, mapped())
                .attribute(LIFETIME, &600u32.to_be_bytes())
        })
    }

    /// Answers the first Allocate with the challenge and returns the signed
    /// retry; one request per poll, so nothing else went out.
    fn challenge(allocation: &mut Allocation, now: Instant) -> Vec<u8> {
        let first = one_send(allocation.poll(now));
        let first = Message::parse(&first).expect("a well-framed allocate");
        let challenge = error(&first, 401, Some(NONCE_1));
        assert_eq!(allocation.on_datagram(&challenge), Event::Consumed);
        one_send(allocation.poll(now))
    }

    /// An allocation taken through the challenge to allocated, its signed
    /// Allocate first sent at `t0`.
    fn allocated(t0: Instant) -> Allocation {
        let mut allocation = Allocation::new(server(), USER, PASS, t0);
        let request = challenge(&mut allocation, t0);
        let answer = allocate_success(&signed(&request, NONCE_1));
        assert_eq!(
            allocation.on_datagram(&answer),
            Event::Allocated {
                relayed: relayed().into(),
                mapped: Some(mapped().into())
            }
        );
        allocation
    }

    /// Answers every request in `steps` with a success; what each asked for.
    fn grant(allocation: &mut Allocation, steps: Vec<Step>) -> Vec<(Method, Option<SocketAddr>)> {
        sends(steps)
            .iter()
            .map(|bytes| {
                let request = signed(bytes, NONCE_1);
                let asked = (
                    request.method().expect("a turn method"),
                    request.address(XOR_PEER_ADDRESS),
                );
                let answer = success(&request, |answer| answer);
                assert_eq!(allocation.on_datagram(&answer), Event::Consumed);
                asked
            })
            .collect()
    }

    #[test]
    fn the_first_allocate_is_unsigned_and_the_challenge_signs_the_retry() {
        let t0 = Instant::now();
        let mut allocation = Allocation::new(server(), USER, PASS, t0);
        assert_eq!(allocation.state(), State::Allocating);
        assert_eq!(allocation.server(), server());
        assert_eq!(allocation.deadline(), Some(t0));

        let first = one_send(allocation.poll(t0));
        let first = Message::parse(&first).expect("well framed, with a good fingerprint");
        assert_eq!(
            (first.method(), first.class()),
            (Some(Method::Allocate), Class::Request)
        );
        assert_eq!(
            first.attribute(REQUESTED_TRANSPORT),
            Some(&[17, 0, 0, 0][..])
        );
        assert_eq!(first.lifetime(), Some(600));
        assert_eq!(first.attribute(USERNAME), None);
        assert_eq!(first.integrity_matches(&key()), None, "no credentials yet");

        assert_eq!(
            allocation.on_datagram(&error(&first, 401, Some(NONCE_1))),
            Event::Consumed
        );
        assert_eq!(allocation.deadline(), Some(t0), "the retry is due at once");
        let second = one_send(allocation.poll(t0));
        let second = signed(&second, NONCE_1);
        assert_ne!(
            second.transaction(),
            first.transaction(),
            "a new transaction"
        );
        assert_eq!(second.method(), Some(Method::Allocate));
        assert_eq!(
            second.attribute(REQUESTED_TRANSPORT),
            Some(&[17, 0, 0, 0][..])
        );
        assert_eq!(second.lifetime(), Some(600));

        let answer = allocate_success(&second);
        let allocated = Event::Allocated {
            relayed: relayed().into(),
            mapped: Some(mapped().into()),
        };
        assert_eq!(allocation.on_datagram(&answer), allocated);
        assert_eq!(
            allocation.state(),
            State::Allocated {
                relayed: relayed().into(),
                mapped: Some(mapped().into())
            }
        );
        assert_eq!(allocation.relayed_addr(), Some(relayed().into()));
        assert_eq!(
            allocation.on_datagram(&answer),
            Event::Consumed,
            "a retransmit's answer is not a second allocation"
        );
    }

    #[test]
    fn the_allocation_is_refreshed_at_half_the_lifetime_granted() {
        let t0 = Instant::now();
        let mut allocation = allocated(t0);
        assert_eq!(allocation.deadline(), Some(t0 + seconds(300)));
        assert!(allocation.poll(t0 + seconds(299)).is_empty());

        let t1 = t0 + seconds(300);
        let refresh = one_send(allocation.poll(t1));
        let refresh = signed(&refresh, NONCE_1);
        assert_eq!(refresh.method(), Some(Method::Refresh));
        assert_eq!(refresh.lifetime(), Some(600));
        let shorter = success(&refresh, |answer| {
            answer.attribute(LIFETIME, &120u32.to_be_bytes())
        });
        assert_eq!(allocation.on_datagram(&shorter), Event::Consumed);
        assert_eq!(allocation.deadline(), Some(t1 + seconds(60)));

        // a success that names no lifetime grants the default
        let t2 = t1 + seconds(60);
        let refresh = one_send(allocation.poll(t2));
        let refresh = signed(&refresh, NONCE_1);
        assert_eq!(
            allocation.on_datagram(&success(&refresh, |answer| answer)),
            Event::Consumed
        );
        assert_eq!(allocation.deadline(), Some(t2 + seconds(300)));
    }

    #[test]
    fn a_stale_nonce_is_taken_and_the_request_resent_once() {
        let t0 = Instant::now();
        let mut allocation = allocated(t0);

        let t1 = t0 + seconds(300);
        let refresh = one_send(allocation.poll(t1));
        let refresh = signed(&refresh, NONCE_1);
        assert_eq!(
            allocation.on_datagram(&error(&refresh, 438, Some(NONCE_2))),
            Event::Consumed
        );
        let retry = one_send(allocation.poll(t1));
        let retry = signed(&retry, NONCE_2);
        assert_ne!(retry.transaction(), refresh.transaction());
        assert_eq!(
            allocation.on_datagram(&success(&retry, |answer| answer)),
            Event::Consumed
        );

        // the next refresh earns a retry of its own, and only one
        let t2 = t1 + seconds(300);
        let refresh = one_send(allocation.poll(t2));
        let refresh = signed(&refresh, NONCE_2);
        assert_eq!(
            allocation.on_datagram(&error(&refresh, 438, Some(NONCE_1))),
            Event::Consumed
        );
        let retry = one_send(allocation.poll(t2));
        let retry = signed(&retry, NONCE_1);
        let failure = Failure::Refused {
            method: Method::Refresh,
            code: 438,
        };
        assert_eq!(
            allocation.on_datagram(&error(&retry, 438, Some(NONCE_2))),
            Event::Failed(failure)
        );
        assert_eq!(allocation.state(), State::Failed(failure));
        assert_eq!(allocation.deadline(), None);
        assert!(allocation.poll(t2 + seconds(3600)).is_empty());
    }

    #[test]
    fn other_errors_end_the_allocation_with_the_code() {
        let t0 = Instant::now();
        let refused = |method, code| Event::Failed(Failure::Refused { method, code });

        // wrong credentials: a 401 to the signed retry
        let mut allocation = Allocation::new(server(), USER, PASS, t0);
        let request = challenge(&mut allocation, t0);
        let request = signed(&request, NONCE_1);
        assert_eq!(
            allocation.on_datagram(&error(&request, 401, Some(NONCE_2))),
            refused(Method::Allocate, 401)
        );
        assert_eq!(allocation.deadline(), None);

        // a 401 with no challenge in it
        let mut allocation = Allocation::new(server(), USER, PASS, t0);
        let first = one_send(allocation.poll(t0));
        let first = Message::parse(&first).expect("well framed");
        assert_eq!(
            allocation.on_datagram(&error(&first, 401, None)),
            refused(Method::Allocate, 401)
        );

        // allocation quota reached
        let mut allocation = Allocation::new(server(), USER, PASS, t0);
        let first = one_send(allocation.poll(t0));
        let first = Message::parse(&first).expect("well framed");
        assert_eq!(
            allocation.on_datagram(&error(&first, 486, None)),
            refused(Method::Allocate, 486)
        );
        assert_eq!(
            allocation.state(),
            State::Failed(Failure::Refused {
                method: Method::Allocate,
                code: 486
            })
        );

        // a refresh refused
        let mut allocation = allocated(t0);
        let refresh = one_send(allocation.poll(t0 + seconds(300)));
        let refresh = signed(&refresh, NONCE_1);
        assert_eq!(
            allocation.on_datagram(&error(&refresh, 403, None)),
            refused(Method::Refresh, 403)
        );
        assert_eq!(allocation.relayed_addr(), None);

        // a success with no relayed address, or only an ipv6 one
        for bad in [None, Some(vec![0, 0x02, 0x12, 0x34])] {
            let mut allocation = Allocation::new(server(), USER, PASS, t0);
            let request = challenge(&mut allocation, t0);
            let request = signed(&request, NONCE_1);
            let answer = success(&request, |answer| match &bad {
                Some(ipv6) => {
                    let mut value = ipv6.clone();
                    value.extend_from_slice(&[0xab; 16]);
                    answer.attribute(XOR_RELAYED_ADDRESS, &value)
                }
                None => answer.address(XOR_MAPPED_ADDRESS, mapped()),
            });
            assert_eq!(
                allocation.on_datagram(&answer),
                Event::Failed(Failure::NoRelayedAddress)
            );
            assert_eq!(allocation.deadline(), None);
        }
    }

    #[test]
    fn requests_follow_rfc_8489s_schedule_and_give_up_after_seven() {
        let t0 = Instant::now();
        let ms = |ms: u64| t0 + Duration::from_millis(ms);
        let mut allocation = Allocation::new(server(), USER, PASS, t0);
        let mut sent = Vec::new();
        let mut first = None;
        let mut gave_up = None;
        // a 2 ms poll, like the session's
        for at in (0..=45_000).step_by(2) {
            for step in allocation.poll(ms(at)) {
                match step {
                    Step::Send(bytes) => {
                        let first = first.get_or_insert_with(|| bytes.clone());
                        assert_eq!(&bytes, first, "a retransmit is the same request");
                        sent.push(at);
                    }
                    Step::Failed(failure) => {
                        assert_eq!(gave_up, None, "given up once");
                        gave_up = Some((at, failure));
                    }
                    other => panic!("unexpected {other:?}"),
                }
            }
            if at == 0 {
                assert_eq!(allocation.deadline(), Some(ms(500)));
            }
        }
        assert_eq!(sent, [0, 500, 1_500, 3_500, 7_500, 15_500, 31_500]);
        let failure = Failure::Unanswered(Method::Allocate);
        assert_eq!(gave_up, Some((39_500, failure)));
        assert_eq!(allocation.state(), State::Failed(failure));
        assert_eq!(allocation.deadline(), None);

        // an unanswered refresh ends an allocation the same way
        let mut allocation = allocated(t0);
        let refresh_at = 300_000;
        let mut steps = Vec::new();
        for at in (refresh_at..=refresh_at + 45_000).step_by(2) {
            steps.extend(
                allocation
                    .poll(ms(at))
                    .into_iter()
                    .filter(|step| !matches!(step, Step::Send(_)))
                    .map(|step| (at, step)),
            );
        }
        assert_eq!(
            steps,
            [(
                refresh_at + 39_500,
                Step::Failed(Failure::Unanswered(Method::Refresh))
            )]
        );
    }

    #[test]
    fn permissions_are_for_public_ipv4_only() {
        let t0 = Instant::now();
        let mut allocation = allocated(t0);
        for refused in [
            "10.0.0.5",
            "172.16.3.4",
            "192.168.1.10",
            "127.0.0.1",
            "169.254.10.10",
            "0.0.0.0",
            "0.1.2.3",
            "100.64.0.1",
            "100.127.255.254",
            "224.0.0.251",
            "240.0.0.1",
            "255.255.255.255",
            "::1",
            "2001:db8::1",
            "fe80::1",
        ] {
            let address: IpAddr = refused.parse().expect("a literal address");
            assert!(!allocation.permit(address), "{refused}");
            assert_eq!(
                allocation.bind_channel(SocketAddr::new(address, 5000)),
                None,
                "{refused}"
            );
        }
        assert!(
            allocation.poll(t0).is_empty(),
            "nothing asked for any of them"
        );
        for public in ["8.8.8.8", "100.63.255.255", "100.128.0.1", "198.51.100.77"] {
            assert!(
                allocation.permit(public.parse().expect("a literal address")),
                "{public}"
            );
        }
    }

    #[test]
    fn a_permission_waits_for_the_allocation_then_installs_and_renews() {
        let t0 = Instant::now();
        let mut allocation = Allocation::new(server(), USER, PASS, t0);
        assert!(allocation.permit(ip(peer())));
        // one request per poll while allocating: the allocate alone
        let request = challenge(&mut allocation, t0);
        let answer = allocate_success(&signed(&request, NONCE_1));
        assert!(matches!(
            allocation.on_datagram(&answer),
            Event::Allocated { .. }
        ));
        assert_eq!(allocation.deadline(), Some(t0), "now due at once");
        assert_eq!(allocation.wrap(peer().into(), b"x"), None);

        let t1 = t0 + Duration::from_millis(10);
        let request = one_send(allocation.poll(t1));
        let request = signed(&request, NONCE_1);
        assert_eq!(request.method(), Some(Method::CreatePermission));
        assert_eq!(
            request.address(XOR_PEER_ADDRESS),
            Some(SocketAddr::new(ip(peer()), 0))
        );
        assert_eq!(
            allocation.wrap(peer().into(), b"x"),
            None,
            "not until the server installs it"
        );
        let answer = success(&request, |answer| answer);
        assert_eq!(allocation.on_datagram(&answer), Event::Consumed);
        assert!(allocation.wrap(peer().into(), b"x").is_some());

        assert_eq!(allocation.deadline(), Some(t1 + seconds(240)));
        let renewal = one_send(allocation.poll(t1 + seconds(240)));
        let renewal = signed(&renewal, NONCE_1);
        assert_eq!(renewal.method(), Some(Method::CreatePermission));
        assert_eq!(
            renewal.address(XOR_PEER_ADDRESS),
            Some(SocketAddr::new(ip(peer()), 0))
        );
    }

    #[test]
    fn new_permissions_go_out_at_most_four_a_second_and_renewals_are_not_held_back() {
        let t0 = Instant::now();
        let mut allocation = allocated(t0);
        let ips: Vec<IpAddr> = (1..=10)
            .map(|last| IpAddr::V4(Ipv4Addr::new(198, 51, 100, last)))
            .collect();
        for &address in &ips {
            assert!(allocation.permit(address));
        }
        assert!(allocation.permit(ips[0]), "asking twice asks once");

        let mut round = |at: Instant| -> Vec<IpAddr> {
            let steps = allocation.poll(at);
            grant(&mut allocation, steps)
                .into_iter()
                .map(|(method, peer)| {
                    assert_eq!(method, Method::CreatePermission);
                    peer.expect("a peer").ip()
                })
                .collect()
        };
        assert_eq!(round(t0), ips[..4]);
        assert!(round(t0 + Duration::from_millis(999)).is_empty());
        assert_eq!(round(t0 + seconds(1)), ips[4..8]);
        assert_eq!(round(t0 + seconds(2)), ips[8..]);
        assert_eq!(
            allocation.deadline(),
            Some(t0 + seconds(240)),
            "then only renewals"
        );
        // renewing ten at once is not ten new ips
        let mut round = |at: Instant| {
            let steps = allocation.poll(at);
            grant(&mut allocation, steps).len()
        };
        assert_eq!(round(t0 + seconds(242)), 10);
    }

    #[test]
    fn channels_count_up_from_0x4000_and_carry_channeldata_once_bound() {
        let t0 = Instant::now();
        let mut allocation = allocated(t0);
        let other = v4("203.0.113.200:9000");
        assert!(allocation.permit(ip(peer())));
        assert_eq!(allocation.bind_channel(peer().into()), Some(0x4000));
        assert_eq!(
            allocation.bind_channel(peer().into()),
            Some(0x4000),
            "a peer keeps its channel"
        );
        assert_eq!(allocation.bind_channel(other.into()), Some(0x4001));

        let mut binds = Vec::new();
        for bytes in sends(allocation.poll(t0)) {
            let request = signed(&bytes, NONCE_1);
            match request.method() {
                Some(Method::CreatePermission) => {
                    let answer = success(&request, |answer| answer);
                    assert_eq!(allocation.on_datagram(&answer), Event::Consumed);
                }
                Some(Method::ChannelBind) => binds.push(bytes),
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(binds.len(), 2);
        let first = signed(&binds[0], NONCE_1);
        assert_eq!(
            first.attribute(CHANNEL_NUMBER),
            Some(&[0x40, 0x00, 0, 0][..])
        );
        assert_eq!(first.address(XOR_PEER_ADDRESS), Some(peer().into()));
        let second = signed(&binds[1], NONCE_1);
        assert_eq!(
            second.attribute(CHANNEL_NUMBER),
            Some(&[0x40, 0x01, 0, 0][..])
        );
        assert_eq!(second.address(XOR_PEER_ADDRESS), Some(other.into()));

        // a send indication until the binding is confirmed, channeldata after
        let unbound = allocation.wrap(peer().into(), b"ping").expect("permitted");
        assert_eq!(
            Message::parse(&unbound).and_then(|message| message.method()),
            Some(Method::Send)
        );
        assert_eq!(
            allocation.on_datagram(&success(&first, |answer| answer)),
            Event::Consumed
        );
        assert_eq!(
            allocation.wrap(peer().into(), b"ping"),
            Some(wire::channel_data(0x4000, b"ping"))
        );
        assert_eq!(
            allocation.on_datagram(&success(&second, |answer| answer)),
            Event::Consumed
        );

        // both renewed nine minutes on, among the permission's and the
        // allocation's own renewals
        let mut renewed = Vec::new();
        for at in [seconds(539), seconds(540)] {
            let steps = allocation.poll(t0 + at);
            for (method, peer) in grant(&mut allocation, steps) {
                if method == Method::ChannelBind {
                    renewed.push((at, peer));
                }
            }
        }
        assert_eq!(
            renewed,
            [
                (seconds(540), Some(peer().into())),
                (seconds(540), Some(other.into()))
            ]
        );

        // every number spent
        allocation.next_channel = 0x4fff;
        assert_eq!(
            allocation.bind_channel(v4("203.0.113.201:1").into()),
            Some(0x4fff)
        );
        assert_eq!(allocation.bind_channel(v4("203.0.113.202:1").into()), None);
    }

    #[test]
    fn relayed_datagrams_wrap_and_unwrap_both_ways() {
        let t0 = Instant::now();
        let mut allocation = allocated(t0);
        assert!(allocation.permit(ip(peer())));
        let steps = allocation.poll(t0);
        grant(&mut allocation, steps);

        // a send indication carries the peer and the payload, unsigned
        let framed = allocation.wrap(peer().into(), b"ping").expect("permitted");
        let message = Message::parse(&framed).expect("well framed");
        assert_eq!(
            (message.method(), message.class()),
            (Some(Method::Send), Class::Indication)
        );
        assert_eq!(message.address(XOR_PEER_ADDRESS), Some(peer().into()));
        assert_eq!(message.attribute(DATA), Some(&b"ping"[..]));
        assert_eq!(message.integrity_matches(&key()), None);

        // the server's data indication unwraps to the peer and payload
        let data = Builder::new(Method::Data, Class::Indication, &[9; 12])
            .address(XOR_PEER_ADDRESS, peer())
            .attribute(DATA, b"pong!")
            .build();
        assert_eq!(
            allocation.on_datagram(&data),
            Event::Relayed {
                peer: peer().into(),
                payload: &b"pong!"[..]
            }
        );
        let no_data = Builder::new(Method::Data, Class::Indication, &[9; 12])
            .address(XOR_PEER_ADDRESS, peer())
            .build();
        assert_eq!(allocation.on_datagram(&no_data), Event::Consumed);

        // channeldata, padded or not, once a channel is bound
        assert_eq!(allocation.bind_channel(peer().into()), Some(0x4000));
        let steps = allocation.poll(t0);
        grant(&mut allocation, steps);
        let framed = allocation.wrap(peer().into(), b"ping").expect("bound");
        assert_eq!(framed, [0x40, 0x00, 0x00, 0x04, b'p', b'i', b'n', b'g']);
        let mut inbound = wire::channel_data(0x4000, b"pong!");
        let relayed = Event::Relayed {
            peer: peer().into(),
            payload: &b"pong!"[..],
        };
        assert_eq!(allocation.on_datagram(&inbound), relayed);
        inbound.extend_from_slice(&[0, 0, 0]);
        assert_eq!(allocation.on_datagram(&inbound), relayed);
        assert_eq!(
            allocation.on_datagram(&wire::channel_data(0x4005, b"?")),
            Event::Consumed,
            "a channel never bound"
        );

        // nothing to a peer neither bound nor permitted, an ipv6 one, or too
        // much for a datagram
        assert_eq!(allocation.wrap(v4("203.0.113.50:1").into(), b"x"), None);
        assert_eq!(
            allocation.wrap("[2001:db8::1]:5000".parse().expect("a literal"), b"x"),
            None
        );
        let too_big = vec![0; MAX_PAYLOAD + 1];
        assert!(allocation.wrap(peer().into(), &too_big[1..]).is_some());
        assert_eq!(allocation.wrap(peer().into(), &too_big), None);
    }

    #[test]
    fn a_refused_or_unanswered_permission_or_channel_drops_only_that() {
        let t0 = Instant::now();
        let mut allocation = allocated(t0);
        let kept = v4("203.0.113.60:7000");
        assert!(allocation.permit(ip(peer())));
        assert!(allocation.permit(ip(kept)));
        assert_eq!(allocation.bind_channel(peer().into()), Some(0x4000));

        for bytes in sends(allocation.poll(t0)) {
            let request = signed(&bytes, NONCE_1);
            let asked = request.address(XOR_PEER_ADDRESS).expect("a peer");
            match request.method() {
                Some(Method::CreatePermission) if asked.ip() == ip(peer()) => {
                    assert_eq!(
                        allocation.on_datagram(&error(&request, 403, None)),
                        Event::Dropped {
                            peer: ip(peer()),
                            failure: Failure::Refused {
                                method: Method::CreatePermission,
                                code: 403
                            }
                        }
                    );
                }
                Some(Method::CreatePermission) => {
                    let answer = success(&request, |answer| answer);
                    assert_eq!(allocation.on_datagram(&answer), Event::Consumed);
                }
                // the channel binding goes unanswered
                _ => {}
            }
        }
        let mut dropped = Vec::new();
        for at in (2..=45_000).step_by(2) {
            let at = Duration::from_millis(at);
            dropped.extend(
                allocation
                    .poll(t0 + at)
                    .into_iter()
                    .filter(|step| !matches!(step, Step::Send(_)))
                    .map(|step| (at, step)),
            );
        }
        assert_eq!(
            dropped,
            [(
                Duration::from_millis(39_500),
                Step::Dropped {
                    peer: ip(peer()),
                    failure: Failure::Unanswered(Method::ChannelBind)
                }
            )]
        );
        assert!(matches!(allocation.state(), State::Allocated { .. }));
        assert_eq!(allocation.wrap(peer().into(), b"x"), None);
        assert!(allocation.wrap(kept.into(), b"x").is_some());
        // and asking again starts over
        assert!(allocation.permit(ip(peer())));
        assert_eq!(allocation.bind_channel(peer().into()), Some(0x4001));
    }

    #[test]
    fn release_gives_the_allocation_back_with_lifetime_zero() {
        let t0 = Instant::now();
        let mut allocation = allocated(t0);
        assert!(allocation.permit(ip(peer())));
        let steps = allocation.poll(t0);
        grant(&mut allocation, steps);

        let release = allocation.release().expect("allocated");
        let release = signed(&release, NONCE_1);
        assert_eq!(release.method(), Some(Method::Refresh));
        assert_eq!(release.lifetime(), Some(0));
        assert_eq!(allocation.state(), State::Released);
        assert_eq!(allocation.deadline(), None);
        assert!(allocation.poll(t0 + seconds(600)).is_empty());
        assert_eq!(allocation.wrap(peer().into(), b"x"), None);
        assert!(!allocation.permit(ip(peer())));
        assert_eq!(allocation.bind_channel(peer().into()), None);
        assert_eq!(allocation.release(), None, "given back once");

        // one still asking has nothing to give back, and stops asking
        let mut asking = Allocation::new(server(), USER, PASS, t0);
        assert_eq!(asking.release(), None);
        assert_eq!(asking.state(), State::Released);
        assert!(asking.poll(t0).is_empty());
    }

    #[test]
    fn answers_that_are_not_ours_or_do_not_check_out_change_nothing() {
        let t0 = Instant::now();
        let mut allocation = Allocation::new(server(), USER, PASS, t0);
        let request = challenge(&mut allocation, t0);
        let request = signed(&request, NONCE_1);

        let forged = Builder::new(Method::Allocate, Class::Success, &request.transaction())
            .address(XOR_RELAYED_ADDRESS, relayed())
            .integrity(b"not the key")
            .fingerprint()
            .build();
        assert_eq!(allocation.on_datagram(&forged), Event::Consumed);
        let unknown = Builder::new(Method::Allocate, Class::Success, &[0xee; 12])
            .address(XOR_RELAYED_ADDRESS, relayed())
            .integrity(&key())
            .build();
        assert_eq!(allocation.on_datagram(&unknown), Event::Consumed);
        let wrong_method = Builder::new(
            Method::CreatePermission,
            Class::Success,
            &request.transaction(),
        )
        .integrity(&key())
        .build();
        assert_eq!(allocation.on_datagram(&wrong_method), Event::Consumed);
        assert_eq!(allocation.state(), State::Allocating);
        assert_eq!(
            allocation.deadline(),
            Some(t0 + Duration::from_millis(500)),
            "still retransmitting"
        );

        // the stun client's binding answer, from the same server
        let binding = Builder::new(Method::Binding, Class::Request, &[5; 12]).build();
        let binding = crate::transport::stun::success_for(&binding, mapped().into());
        assert_eq!(allocation.on_datagram(&binding), Event::Foreign);

        let answer = allocate_success(&request);
        for len in 0..answer.len() {
            assert_eq!(
                allocation.on_datagram(&answer[..len]),
                Event::Foreign,
                "truncated to {len}"
            );
        }
        for junk in [&[0xff; 64][..], &[0x80; 40], &[0x40, 0x00, 0xff, 0xff], &[]] {
            assert_eq!(allocation.on_datagram(junk), Event::Foreign);
        }
        assert!(matches!(
            allocation.on_datagram(&answer),
            Event::Allocated { .. }
        ));
    }

    #[test]
    fn nothing_formatted_shows_the_credentials() {
        let t0 = Instant::now();
        let mut seen = Vec::new();
        let mut allocation = Allocation::new(server(), USER, PASS, t0);
        seen.push(format!("{allocation:?}"));
        let steps = allocation.poll(t0);
        seen.push(format!("{steps:?}"));
        let mut allocation = allocated(t0);
        assert!(allocation.permit(ip(peer())));
        assert_eq!(allocation.bind_channel(peer().into()), Some(0x4000));
        seen.push(format!("{allocation:?}"));
        let steps = allocation.poll(t0);
        seen.push(format!("{steps:?}"));
        allocation.release();
        seen.push(format!("{allocation:?}"));

        for text in &seen {
            assert!(!text.contains(USER), "{text}");
            assert!(!text.contains("swoop-host-user"), "{text}");
            assert!(!text.contains(PASS), "{text}");
            assert!(!text.contains(TEST_REALM), "{text}");
        }
        assert!(seen[0].starts_with("Allocation {"), "{}", seen[0]);
        assert_eq!(
            format!("{:?}", Step::Send(USER.as_bytes().to_vec())),
            format!("Send(<{} bytes>)", USER.len())
        );
    }
}
