//! Host-side TURN client (plan.md D13): str0m has no TURN client, and
//! Cloudflare bills only server to client egress, so holding the allocation
//! here leaves the video direction unbilled.
//!
//! Sans-IO like [`super::stun`]: an [`Allocation`] is driven with the
//! caller's datagrams and `now` and hands back the bytes to send, so the whole
//! exchange — the 401 challenge, refreshes, permissions, channels and the
//! retransmit schedule — is tested against a scripted server without a socket
//! or a wait. `wire` is the STUN/TURN codec under it and `md5` the long-term
//! credential's hash. [`super::rtc`] holds one allocation per peer, on the
//! peer's own socket, and trickles the relayed address as a candidate.

use std::net::SocketAddr;

use crate::bundle::Secret;

mod alloc;
#[cfg(test)]
pub(crate) mod fake;
mod md5;
mod wire;

pub use alloc::{Allocation, Event, Failure, State, Step};
pub use wire::Method;

/// One TURN server a peer may allocate on, resolved, with the credentials the
/// bundle carried for it. The password is a [`Secret`], so `Debug` prints
/// `<redacted>` for it.
#[derive(Debug, Clone)]
pub struct TurnServer {
    pub addr: SocketAddr,
    pub username: String,
    pub password: Secret,
}

/// The host and port of a `turn:` URL over UDP (RFC 7065), for the caller to
/// resolve; the port defaults as a `stun:` URL's does.
///
/// `None` for `turns:` and for `?transport=tcp`, because the allocation goes
/// out over the peer's own UDP socket, and for a URL with no host, a port that
/// is not one, or an IPv6 literal, which a peer that binds IPv4 cannot reach.
pub fn server_host_port(url: &str) -> Option<(&str, u16)> {
    if !url.get(..5)?.eq_ignore_ascii_case("turn:") {
        return None;
    }
    let rest = &url[5..];
    let (rest, query) = rest
        .split_once('?')
        .map_or((rest, ""), |(before, query)| (before, query));
    let udp = query.split('&').all(|pair| {
        let transport = pair.get(..10).is_some_and(|k| k.eq_ignore_ascii_case("transport="));
        !transport || pair.eq_ignore_ascii_case("transport=udp")
    });
    udp.then(|| super::stun::host_port(rest)).flatten()
}

#[cfg(test)]
mod tests {
    use super::server_host_port;

    #[test]
    fn a_udp_turn_url_names_its_host_and_port() {
        assert_eq!(
            server_host_port("turn:turn.cloudflare.com:3478?transport=udp"),
            Some(("turn.cloudflare.com", 3478))
        );
        assert_eq!(
            server_host_port("TURN:turn.example.org"),
            Some(("turn.example.org", 3478))
        );
        assert_eq!(
            server_host_port("turn:turn.cloudflare.com:443?transport=udp"),
            Some(("turn.cloudflare.com", 443))
        );
    }

    #[test]
    fn anything_but_udp_turn_is_refused() {
        for url in [
            "turn:turn.cloudflare.com:3478?transport=tcp",
            "turns:turn.cloudflare.com:5349?transport=tcp",
            "turns:turn.cloudflare.com:443",
            "stun:stun.cloudflare.com:3478",
            "turn:",
            "turn:host:port",
            "turn:[2001:db8::1]:3478",
        ] {
            assert_eq!(server_host_port(url), None, "{url}");
        }
    }
}
