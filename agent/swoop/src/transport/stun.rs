//! A STUN binding client (RFC 8489), sans-IO: just enough to learn the address
//! a NAT maps one peer's socket to, which is that peer's server-reflexive
//! candidate.
//!
//! str0m has a STUN codec and it cannot do this. `StunMessage::parse` refuses a
//! Binding success response that carries no MESSAGE-INTEGRITY — which is every
//! answer a public STUN server gives an unauthenticated request — and its ICE
//! agent drops a response to any transaction it did not start. So the request
//! is built here, the answer is read here, and [`crate::transport::rtc`] takes
//! the server's datagrams off the socket before str0m sees them.
//!
//! Nothing here touches a socket or a clock: [`Binding`] is driven with the
//! caller's `now` and hands back the bytes to send, so the retransmit schedule
//! is tested without waiting it out.

use std::net::{Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

/// RFC 8489 §5: what tells a STUN message from anything else on the port, and
/// the mask XOR-MAPPED-ADDRESS is written under.
const MAGIC_COOKIE: u32 = 0x2112_a442;
const HEADER_LEN: usize = 20;
const TRANSACTION_LEN: usize = 12;

const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const BINDING_ERROR: u16 = 0x0111;

const MAPPED_ADDRESS: u16 = 0x0001;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;
const FAMILY_IPV4: u8 = 0x01;

/// The port a `stun:` URL means when it names none (RFC 7064 §3.2).
const DEFAULT_PORT: u16 = 3478;

/// RFC 8489 §6.2.1's defaults: a retransmit after 500 ms, doubling, seven
/// requests in all and a wait of sixteen initial RTOs after the last — sent at
/// 0, 0.5, 1.5, 3.5, 7.5, 15.5 and 31.5 s, given up at 39.5 s. A late answer
/// still helps, because the candidate trickles whenever it arrives.
const INITIAL_RTO: Duration = Duration::from_millis(500);
const MAX_REQUESTS: u32 = 7;
const LAST_WAIT_RTOS: u32 = 16;

/// One Binding request: a bare header, no attributes.
pub type Request = [u8; HEADER_LEN];

/// The host and port of a `stun:` URL (RFC 7064), for the caller to resolve.
///
/// `None` for any other scheme — `stuns:` too, because the binding goes out
/// over the peer's own UDP socket — and for a URL with no host, a port that is
/// not one, or an IPv6 literal, which a peer that binds IPv4 cannot reach.
pub fn server_host_port(url: &str) -> Option<(&str, u16)> {
    if !url.get(..5)?.eq_ignore_ascii_case("stun:") {
        return None;
    }
    let rest = &url[5..];
    // a query is not part of a stun uri, but `?transport=udp` is a common slip
    let rest = rest.split_once('?').map_or(rest, |(before, _)| before);
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()?),
        None => (rest, DEFAULT_PORT),
    };
    (!host.is_empty() && !host.contains([':', '['])).then_some((host, port))
}

/// What [`Binding::poll`] wants done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Put this request on the socket, to [`Binding::server`].
    Send(Request),
    /// The last request went unanswered for its whole wait. Said once.
    GaveUp,
}

/// What one datagram from the server meant to the binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reply {
    /// The first answer: the address the server saw the request come from.
    Mapped(SocketAddr),
    /// An answer with no IPv4 mapping in it — an error response, or a success
    /// carrying only a family this socket does not have. The binding is over:
    /// asking again would get the same answer.
    Unusable,
    /// Another answer to a binding that already has one: a retransmit's.
    Repeat,
    /// Not an answer to this binding at all.
    Foreign,
}

/// One binding transaction with one server: the request, its retransmits and
/// the answer.
#[derive(Debug)]
pub struct Binding {
    server: SocketAddr,
    transaction: [u8; TRANSACTION_LEN],
    /// Requests sent so far.
    sent: u32,
    /// When the next request goes out or, after the last one, when the wait
    /// for its answer ends. `None` once the binding is over.
    due: Option<Instant>,
    /// The wait after the next request.
    rto: Duration,
    answered: bool,
}

impl Binding {
    /// A binding whose first request is due at `now`.
    pub fn new(server: SocketAddr, now: Instant) -> Self {
        Self::with_transaction(server, rand::random(), now)
    }

    fn with_transaction(
        server: SocketAddr,
        transaction: [u8; TRANSACTION_LEN],
        now: Instant,
    ) -> Self {
        Self {
            server,
            transaction,
            sent: 0,
            due: Some(now),
            rto: INITIAL_RTO,
            answered: false,
        }
    }

    pub fn server(&self) -> SocketAddr {
        self.server
    }

    /// When [`poll`](Self::poll) next has something to do; `None` once the
    /// binding is over.
    pub fn deadline(&self) -> Option<Instant> {
        self.due
    }

    /// The request due at `now`, or the give-up once the last one's wait has
    /// run out.
    pub fn poll(&mut self, now: Instant) -> Option<Step> {
        if now < self.due? {
            return None;
        }
        if self.sent == MAX_REQUESTS {
            self.due = None;
            return Some(Step::GaveUp);
        }
        self.sent += 1;
        let wait = if self.sent == MAX_REQUESTS {
            INITIAL_RTO * LAST_WAIT_RTOS
        } else {
            self.rto
        };
        self.rto *= 2;
        self.due = Some(now + wait);
        Some(Step::Send(request(&self.transaction)))
    }

    /// One datagram that came from [`server`](Self::server). Malformed input
    /// is [`Reply::Foreign`], never a panic.
    pub fn on_datagram(&mut self, datagram: &[u8]) -> Reply {
        let Some(answer) = read_answer(datagram) else {
            return Reply::Foreign;
        };
        if answer.transaction != self.transaction {
            return Reply::Foreign;
        }
        if self.answered {
            return Reply::Repeat;
        }
        self.answered = true;
        self.due = None;
        answer.mapped.map_or(Reply::Unusable, Reply::Mapped)
    }
}

fn request(transaction: &[u8; TRANSACTION_LEN]) -> Request {
    let mut out = [0u8; HEADER_LEN];
    out[..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    // bytes 2..4 are the attribute length, and there are none
    out[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    out[8..].copy_from_slice(transaction);
    out
}

struct Answer {
    transaction: [u8; TRANSACTION_LEN],
    /// Always `None` for an error response.
    mapped: Option<SocketAddr>,
}

/// A Binding response's transaction id and, for a success, its IPv4 mapping:
/// XOR-MAPPED-ADDRESS, or MAPPED-ADDRESS from a server that only sends that.
///
/// MESSAGE-INTEGRITY and FINGERPRINT are not checked. The request carried no
/// credential to check them against; the 96-bit transaction id, from a server
/// address the caller already matched, is what ties the answer to it.
fn read_answer(datagram: &[u8]) -> Option<Answer> {
    let header = datagram.get(..HEADER_LEN)?;
    let kind = u16::from_be_bytes([header[0], header[1]]);
    let length = usize::from(u16::from_be_bytes([header[2], header[3]]));
    let cookie = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
    if cookie != MAGIC_COOKIE || !length.is_multiple_of(4) {
        return None;
    }
    let transaction = header[8..].try_into().ok()?;
    let mut attributes = datagram.get(HEADER_LEN..HEADER_LEN + length)?;
    let mapped = match kind {
        BINDING_ERROR => None,
        BINDING_SUCCESS => {
            let (mut xor, mut plain) = (None, None);
            while let Some(head) = attributes.get(..4) {
                let attribute = u16::from_be_bytes([head[0], head[1]]);
                let len = usize::from(u16::from_be_bytes([head[2], head[3]]));
                let value = attributes.get(4..4 + len)?;
                match attribute {
                    XOR_MAPPED_ADDRESS => xor = xor.or_else(|| ipv4(value, MAGIC_COOKIE)),
                    MAPPED_ADDRESS => plain = plain.or_else(|| ipv4(value, 0)),
                    _ => {}
                }
                // values are padded out to a multiple of four
                attributes = attributes
                    .get(4 + len.next_multiple_of(4)..)
                    .unwrap_or_default();
            }
            xor.or(plain)
        }
        _ => return None,
    };
    Some(Answer {
        transaction,
        mapped,
    })
}

/// An IPv4 (XOR-)MAPPED-ADDRESS value: reserved, family, port, address, with
/// the port under the cookie's top half and the address under all of it.
fn ipv4(value: &[u8], mask: u32) -> Option<SocketAddr> {
    let &[_, FAMILY_IPV4, p0, p1, a0, a1, a2, a3] = value else {
        return None;
    };
    let port = u16::from_be_bytes([p0, p1]) ^ (mask >> 16) as u16;
    let ip = u32::from_be_bytes([a0, a1, a2, a3]) ^ mask;
    Some(SocketAddr::from((Ipv4Addr::from(ip), port)))
}

/// A Binding success answering `request`, carrying `mapped` — what a STUN
/// server would send, for the tests that stand one up.
#[cfg(test)]
pub(crate) fn success_for(request: &[u8], mapped: SocketAddr) -> Vec<u8> {
    let SocketAddr::V4(mapped) = mapped else {
        panic!("an ipv4 mapping, like the peers ask for");
    };
    let mut out = Vec::with_capacity(HEADER_LEN + 12);
    out.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
    out.extend_from_slice(&12u16.to_be_bytes());
    out.extend_from_slice(&request[4..HEADER_LEN]);
    out.extend_from_slice(&XOR_MAPPED_ADDRESS.to_be_bytes());
    out.extend_from_slice(&8u16.to_be_bytes());
    out.extend_from_slice(&[0, FAMILY_IPV4]);
    out.extend_from_slice(&(mapped.port() ^ (MAGIC_COOKIE >> 16) as u16).to_be_bytes());
    out.extend_from_slice(&(u32::from(*mapped.ip()) ^ MAGIC_COOKIE).to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRANSACTION: [u8; TRANSACTION_LEN] = [
        0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae,
    ];

    /// RFC 5769 §2.2, the sample IPv4 response: SOFTWARE (11 bytes, so one of
    /// padding), XOR-MAPPED-ADDRESS 192.0.2.1:32853, MESSAGE-INTEGRITY and
    /// FINGERPRINT. Both of the last two were checked against the RFC's
    /// password before the bytes were pasted here.
    const RFC_5769_IPV4_RESPONSE: [u8; 80] = [
        0x01, 0x01, 0x00, 0x3c, 0x21, 0x12, 0xa4, 0x42, 0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6,
        0x86, 0xfa, 0x87, 0xdf, 0xae, 0x80, 0x22, 0x00, 0x0b, 0x74, 0x65, 0x73, 0x74, 0x20, 0x76,
        0x65, 0x63, 0x74, 0x6f, 0x72, 0x20, 0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0xa1, 0x47, 0xe1,
        0x12, 0xa6, 0x43, 0x00, 0x08, 0x00, 0x14, 0x2b, 0x91, 0xf5, 0x99, 0xfd, 0x9e, 0x90, 0xc3,
        0x8c, 0x74, 0x89, 0xf9, 0x2a, 0xf9, 0xba, 0x53, 0xf0, 0x6b, 0xe7, 0xd7, 0x80, 0x28, 0x00,
        0x04, 0xc0, 0x7d, 0x4c, 0x96,
    ];

    fn server() -> SocketAddr {
        "203.0.113.5:3478".parse().expect("a literal address")
    }

    fn binding(now: Instant) -> Binding {
        Binding::with_transaction(server(), TRANSACTION, now)
    }

    fn sent(step: Option<Step>) -> Request {
        match step {
            Some(Step::Send(request)) => request,
            other => panic!("expected a request, got {other:?}"),
        }
    }

    #[test]
    fn the_request_is_a_bare_binding_header_with_the_cookie_and_its_transaction() {
        let t0 = Instant::now();
        let request = sent(binding(t0).poll(t0));
        assert_eq!(request.len(), 20);
        assert_eq!(&request[..2], &[0x00, 0x01], "binding request");
        assert_eq!(&request[2..4], &[0x00, 0x00], "no attributes");
        assert_eq!(&request[4..8], &[0x21, 0x12, 0xa4, 0x42], "magic cookie");
        assert_eq!(&request[8..], &TRANSACTION);

        // and two bindings never share a transaction
        let a = sent(Binding::new(server(), t0).poll(t0));
        let b = sent(Binding::new(server(), t0).poll(t0));
        assert_ne!(a[8..], b[8..]);
    }

    #[test]
    fn the_rfc_5769_ipv4_response_maps_to_192_0_2_1_port_32853() {
        let t0 = Instant::now();
        let mut binding = binding(t0);
        binding.poll(t0);
        assert_eq!(
            binding.on_datagram(&RFC_5769_IPV4_RESPONSE),
            Reply::Mapped("192.0.2.1:32853".parse().expect("a literal address"))
        );
        assert_eq!(
            binding.deadline(),
            None,
            "an answered binding sends no more"
        );
        assert_eq!(binding.poll(t0 + Duration::from_secs(60)), None);
        assert_eq!(
            binding.on_datagram(&RFC_5769_IPV4_RESPONSE),
            Reply::Repeat,
            "a retransmit's answer is not a second candidate"
        );
    }

    #[test]
    fn mapped_address_is_read_when_the_server_sends_no_xor_one() {
        let mapped = "198.51.100.7:4242".parse().expect("a literal address");
        let mut answer = success_for(&request(&TRANSACTION), mapped);
        // the same attribute un-xored, under the old type
        answer[20..22].copy_from_slice(&MAPPED_ADDRESS.to_be_bytes());
        answer[26..28].copy_from_slice(&4242u16.to_be_bytes());
        answer[28..32].copy_from_slice(&[198, 51, 100, 7]);
        assert_eq!(
            binding(Instant::now()).on_datagram(&answer),
            Reply::Mapped(mapped)
        );
    }

    #[test]
    fn an_answer_to_another_transaction_is_foreign_and_changes_nothing() {
        let t0 = Instant::now();
        let mut binding = binding(t0);
        binding.poll(t0);
        let mut other = RFC_5769_IPV4_RESPONSE;
        other[19] ^= 0x01;
        assert_eq!(binding.on_datagram(&other), Reply::Foreign);
        assert!(
            binding.deadline().is_some(),
            "still waiting for its own answer"
        );
        assert!(matches!(
            binding.on_datagram(&RFC_5769_IPV4_RESPONSE),
            Reply::Mapped(_)
        ));
    }

    #[test]
    fn an_error_response_ends_the_binding_without_an_address() {
        let t0 = Instant::now();
        let mut binding = binding(t0);
        binding.poll(t0);
        // 400 bad request, ERROR-CODE only
        let mut error = vec![0x01, 0x11, 0x00, 0x08, 0x21, 0x12, 0xa4, 0x42];
        error.extend_from_slice(&TRANSACTION);
        error.extend_from_slice(&[0x00, 0x09, 0x00, 0x04, 0x00, 0x00, 0x04, 0x00]);
        assert_eq!(binding.on_datagram(&error), Reply::Unusable);
        assert_eq!(binding.deadline(), None);
        assert_eq!(binding.poll(t0 + Duration::from_secs(60)), None);
    }

    #[test]
    fn malformed_datagrams_are_foreign_and_never_panic() {
        let mut binding = binding(Instant::now());
        // every truncation of a good answer, which is every length field and
        // attribute header pointing past the end
        for len in 0..RFC_5769_IPV4_RESPONSE.len() {
            assert_eq!(
                binding.on_datagram(&RFC_5769_IPV4_RESPONSE[..len]),
                Reply::Foreign,
                "truncated to {len}"
            );
        }
        let mut wrong_cookie = RFC_5769_IPV4_RESPONSE;
        wrong_cookie[4] = 0;
        assert_eq!(binding.on_datagram(&wrong_cookie), Reply::Foreign);
        let mut a_request = RFC_5769_IPV4_RESPONSE;
        a_request[1] = 0x01;
        a_request[0] = 0x00;
        assert_eq!(binding.on_datagram(&a_request), Reply::Foreign);
        let mut long_attribute = RFC_5769_IPV4_RESPONSE;
        long_attribute[22..24].copy_from_slice(&0xfffcu16.to_be_bytes());
        assert_eq!(binding.on_datagram(&long_attribute), Reply::Foreign);
        assert_eq!(binding.on_datagram(&[0xff; 64]), Reply::Foreign);
    }

    #[test]
    fn requests_follow_rfc_8489s_schedule_and_the_binding_gives_up_after_seven() {
        let t0 = Instant::now();
        let ms = |ms: u64| t0 + Duration::from_millis(ms);
        let mut binding = binding(t0);
        let mut sends = Vec::new();
        let mut gave_up = None;
        // a 2 ms poll, like the session's
        for at in (0..=45_000).step_by(2) {
            match binding.poll(ms(at)) {
                Some(Step::Send(request)) => {
                    assert_eq!(
                        &request[8..],
                        &TRANSACTION,
                        "a retransmit is the same transaction"
                    );
                    sends.push(at);
                }
                Some(Step::GaveUp) => {
                    assert_eq!(gave_up, None, "given up once");
                    gave_up = Some(at);
                }
                None => {}
            }
        }
        assert_eq!(sends, [0, 500, 1_500, 3_500, 7_500, 15_500, 31_500]);
        assert_eq!(gave_up, Some(39_500));
        assert_eq!(binding.deadline(), None);

        // an answer that arrives after all is still the server's answer
        assert!(matches!(
            binding.on_datagram(&RFC_5769_IPV4_RESPONSE),
            Reply::Mapped(_)
        ));
    }

    #[test]
    fn a_stun_url_names_its_host_and_port() {
        assert_eq!(
            server_host_port("stun:stun.cloudflare.com:3478"),
            Some(("stun.cloudflare.com", 3478))
        );
        assert_eq!(
            server_host_port("STUN:192.0.2.1:19302"),
            Some(("192.0.2.1", 19302))
        );
        assert_eq!(
            server_host_port("stun:stun.example.org"),
            Some(("stun.example.org", 3478))
        );
        assert_eq!(
            server_host_port("stun:stun.example.org:3478?transport=udp"),
            Some(("stun.example.org", 3478))
        );
        for refused in [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "stuns:stun.example.org:5349",
            "stun:",
            "stun:host:port",
            "stun:host:",
            "stun:[2001:db8::1]:3478",
            "stun:2001:db8::1",
            "stu",
            "",
        ] {
            assert_eq!(server_host_port(refused), None, "{refused}");
        }
    }
}
