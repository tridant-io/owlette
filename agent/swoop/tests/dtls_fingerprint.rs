//! PROTOCOL.md §10 binds a lease renewal to the fingerprint of the **already
//! established** dtls session, not to the `a=fingerprint:` line of the offer.
//! That is the stronger of the two — the offer is a claim the browser makes
//! before any handshake, the established session is the certificate that
//! actually authenticated — and it is why the viewer token rides the
//! `swoop-control` lease rather than the offer.
//!
//! Task 4.1 left `SignalClient::set_viewer_dtls_fingerprint` uncalled because
//! nothing exposed the negotiated remote fingerprint, and flagged that §10
//! would have to be amended if str0m could not reach it. It can: str0m 0.23.1
//! computes the fingerprint from the peer's DER certificate as the handshake
//! completes (`src/lib.rs`, `DtlsOutput::PeerCert`) and publishes it as
//! `DirectApi::remote_dtls_fingerprint`. This test is the proof, so nobody has
//! to take the crate's word for it again — and so an upgrade that drops the
//! accessor, or starts reporting the offer's value instead, fails here rather
//! than silently weakening every renewal.
//!
//! Two bare `Rtc`s over loopback: no `RtcPeer`, because what is under test is
//! str0m's own surface.

use std::net::UdpSocket;
use std::time::{Duration, Instant};

use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc, RtcConfig};

/// A handshake on loopback is milliseconds; this only bounds a failure.
const DEADLINE: Duration = Duration::from_secs(20);

struct Side {
    rtc: Rtc,
    socket: UdpSocket,
    addr: std::net::SocketAddr,
    connected: bool,
}

impl Side {
    fn bind() -> Self {
        let socket = UdpSocket::bind("127.0.0.1:0").expect("bind loopback");
        socket
            .set_read_timeout(Some(Duration::from_millis(1)))
            .expect("read timeout");
        let addr = socket.local_addr().expect("local addr");
        let mut rtc = RtcConfig::new().build(Instant::now());
        rtc.add_local_candidate(Candidate::host(addr, "udp").expect("host candidate"));
        Self { rtc, socket, addr, connected: false }
    }

    /// Drain whatever str0m wants to send, then feed it one datagram or a tick.
    fn pump(&mut self, buf: &mut [u8]) {
        loop {
            match self.rtc.poll_output().expect("poll_output") {
                Output::Timeout(_) => break,
                Output::Transmit(t) => {
                    self.socket
                        .send_to(&t.contents, t.destination)
                        .expect("send");
                }
                Output::Event(Event::Connected) => self.connected = true,
                Output::Event(_) => {}
            }
        }
        let now = Instant::now();
        match self.socket.recv_from(buf) {
            Ok((n, source)) => {
                let contents = buf[..n].try_into().expect("a datagram");
                self.rtc
                    .handle_input(Input::Receive(
                        now,
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: self.addr,
                            contents,
                        },
                    ))
                    .expect("handle_input");
            }
            Err(_) => {
                self.rtc.handle_input(Input::Timeout(now)).expect("timeout");
            }
        }
    }
}

#[test]
fn str0m_reports_the_established_sessions_remote_fingerprint() {
    let mut offerer = Side::bind();
    let mut answerer = Side::bind();

    let mut api = offerer.rtc.sdp_api();
    api.add_channel("probe".to_string());
    let (offer, pending) = api.apply().expect("the offer has changes");
    let answer = answerer
        .rtc
        .sdp_api()
        .accept_offer(offer)
        .expect("the answerer answers");
    offerer
        .rtc
        .sdp_api()
        .accept_answer(pending, answer)
        .expect("the offerer applies the answer");

    // Before the handshake there is no established session to bind to, only the
    // sdp's claim — exactly the weaker binding §10 refuses for a renewal.
    assert!(
        offerer.rtc.direct_api().remote_dtls_fingerprint().is_none(),
        "a fingerprint before the peer certificate would not be the session's"
    );

    let mut buf = vec![0u8; 2048];
    let deadline = Instant::now() + DEADLINE;
    while Instant::now() < deadline && !(offerer.connected && answerer.connected) {
        offerer.pump(&mut buf);
        answerer.pump(&mut buf);
    }
    assert!(
        offerer.connected && answerer.connected,
        "the two peers never completed ice + dtls"
    );

    // Each side's established session carries the OTHER side's certificate, and
    // that is what `set_viewer_dtls_fingerprint` is to be handed.
    let seen_by_offerer = offerer
        .rtc
        .direct_api()
        .remote_dtls_fingerprint()
        .expect("the offerer saw its peer's certificate")
        .to_string();
    let seen_by_answerer = answerer
        .rtc
        .direct_api()
        .remote_dtls_fingerprint()
        .expect("the answerer saw its peer's certificate")
        .to_string();

    assert_eq!(
        seen_by_offerer,
        answerer.rtc.direct_api().local_dtls_fingerprint().to_string()
    );
    assert_eq!(
        seen_by_answerer,
        offerer.rtc.direct_api().local_dtls_fingerprint().to_string()
    );
    assert_ne!(seen_by_offerer, seen_by_answerer);
    assert!(seen_by_offerer.starts_with("sha-256 "), "{seen_by_offerer}");
}
