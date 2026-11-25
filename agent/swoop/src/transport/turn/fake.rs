//! A TURN server for tests: one client, long-term credentials, a relayed
//! address of the test's choosing, and a relay that hands the test what the
//! client sent each peer instead of putting it on a network. Enough of RFC
//! 8656 for [`crate::transport::rtc`] to allocate, permit, bind a channel and
//! carry a whole session through it on loopback.

use std::collections::VecDeque;
use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};

use super::wire::{
    self, Builder, Class, Message, Method, CHANNEL_NUMBER, DATA, ERROR_CODE, LIFETIME, NONCE,
    REALM, USERNAME, XOR_MAPPED_ADDRESS, XOR_PEER_ADDRESS, XOR_RELAYED_ADDRESS,
};

const REALM_NAME: &str = "owlette.test";
const NONCE_VALUE: &[u8] = b"fake-nonce";

pub(crate) struct FakeTurn {
    socket: UdpSocket,
    key: [u8; 16],
    relayed: SocketAddrV4,
    /// The one client: whoever sent the first datagram.
    client: Option<SocketAddr>,
    allocated: bool,
    /// The client gave the allocation back with a zero-lifetime Refresh.
    pub released: bool,
    permissions: Vec<Ipv4Addr>,
    channels: Vec<(u16, SocketAddrV4)>,
    /// What the client relayed out, per peer, in order.
    pub to_peers: VecDeque<(SocketAddrV4, Vec<u8>)>,
    buf: Vec<u8>,
}

impl FakeTurn {
    pub(crate) fn new(username: &str, password: &str, relayed: SocketAddrV4) -> Self {
        let socket = UdpSocket::bind("127.0.0.1:0").expect("bind the fake turn server");
        socket.set_nonblocking(true).expect("nonblocking");
        Self {
            socket,
            key: wire::long_term_key(username.as_bytes(), REALM_NAME.as_bytes(), password.as_bytes()),
            relayed,
            client: None,
            allocated: false,
            released: false,
            permissions: Vec::new(),
            channels: Vec::new(),
            to_peers: VecDeque::new(),
            buf: vec![0u8; 4096],
        }
    }

    pub(crate) fn addr(&self) -> SocketAddr {
        self.socket.local_addr().expect("the server's address")
    }

    pub(crate) fn relayed(&self) -> SocketAddr {
        self.relayed.into()
    }

    pub(crate) fn permitted(&self, ip: Ipv4Addr) -> bool {
        self.permissions.contains(&ip)
    }

    pub(crate) fn channel_for(&self, peer: SocketAddrV4) -> Option<u16> {
        self.channels
            .iter()
            .find(|(_, bound)| *bound == peer)
            .map(|(number, _)| *number)
    }

    /// Handle everything waiting on the socket.
    pub(crate) fn pump(&mut self) {
        loop {
            let (n, from) = match self.socket.recv_from(&mut self.buf) {
                Ok(received) => received,
                Err(e) if e.kind() == ErrorKind::WouldBlock => return,
                // windows reports a port-unreachable from an earlier send here
                Err(_) => continue,
            };
            let client = *self.client.get_or_insert(from);
            if from != client {
                continue;
            }
            let datagram = std::mem::take(&mut self.buf);
            self.on_datagram(&datagram[..n], client);
            self.buf = datagram;
        }
    }

    /// A datagram from `peer` to the relayed address: on to the client as a
    /// Data indication, or ChannelData on a bound channel, if `peer` is
    /// permitted. Dropped otherwise, as a real server drops it.
    pub(crate) fn deliver_from_peer(&self, peer: SocketAddrV4, payload: &[u8]) {
        let Some(client) = self.client else {
            return;
        };
        if !self.allocated || !self.permissions.contains(peer.ip()) {
            return;
        }
        let framed = match self.channel_for(peer) {
            Some(number) => wire::channel_data(number, payload),
            None => Builder::new(Method::Data, Class::Indication, &rand::random())
                .address(XOR_PEER_ADDRESS, peer)
                .attribute(DATA, payload)
                .build(),
        };
        let _ = self.socket.send_to(&framed, client);
    }

    fn on_datagram(&mut self, datagram: &[u8], client: SocketAddr) {
        if let Some((number, payload)) = wire::read_channel_data(datagram) {
            if let Some((_, peer)) = self.channels.iter().find(|(n, _)| *n == number) {
                self.to_peers.push_back((*peer, payload.to_vec()));
            }
            return;
        }
        let Some(message) = Message::parse(datagram) else {
            return;
        };
        let Some(method) = message.method() else {
            return;
        };
        match (method, message.class()) {
            (Method::Send, Class::Indication) => {
                if let (Some(SocketAddr::V4(peer)), Some(payload)) =
                    (message.address(XOR_PEER_ADDRESS), message.attribute(DATA))
                {
                    if self.allocated && self.permissions.contains(peer.ip()) {
                        self.to_peers.push_back((peer, payload.to_vec()));
                    }
                }
            }
            (_, Class::Request) => {
                let reply = self.answer(method, &message, client);
                let _ = self.socket.send_to(&reply, client);
            }
            _ => {}
        }
    }

    fn answer(&mut self, method: Method, request: &Message, client: SocketAddr) -> Vec<u8> {
        let transaction = request.transaction();
        if request.attribute(USERNAME).is_none() {
            // the challenge every first request draws
            return Builder::new(method, Class::Error, &transaction)
                .attribute(ERROR_CODE, &[0, 0, 4, 1])
                .attribute(REALM, REALM_NAME.as_bytes())
                .attribute(NONCE, NONCE_VALUE)
                .fingerprint()
                .build();
        }
        if request.integrity_matches(&self.key) != Some(true) {
            return Builder::new(method, Class::Error, &transaction)
                .attribute(ERROR_CODE, &[0, 0, 4, 1])
                .fingerprint()
                .build();
        }
        let mut success = Builder::new(method, Class::Success, &transaction);
        match method {
            Method::Allocate => {
                self.allocated = true;
                let SocketAddr::V4(mapped) = client else {
                    panic!("the client is ipv4");
                };
                success = success
                    .address(XOR_RELAYED_ADDRESS, self.relayed)
                    .address(XOR_MAPPED_ADDRESS, mapped)
                    .attribute(LIFETIME, &600u32.to_be_bytes());
            }
            Method::Refresh => {
                let lifetime = request.lifetime().unwrap_or(600);
                if lifetime == 0 {
                    self.released = true;
                    self.allocated = false;
                }
                success = success.attribute(LIFETIME, &lifetime.to_be_bytes());
            }
            Method::CreatePermission => {
                if let Some(SocketAddr::V4(peer)) = request.address(XOR_PEER_ADDRESS) {
                    if !self.permissions.contains(peer.ip()) {
                        self.permissions.push(*peer.ip());
                    }
                }
            }
            Method::ChannelBind => {
                if let (Some(&[hi, lo, _, _]), Some(SocketAddr::V4(peer))) = (
                    request.attribute(CHANNEL_NUMBER),
                    request.address(XOR_PEER_ADDRESS),
                ) {
                    let number = u16::from_be_bytes([hi, lo]);
                    self.channels.retain(|(n, _)| *n != number);
                    self.channels.push((number, peer));
                    if !self.permissions.contains(peer.ip()) {
                        self.permissions.push(*peer.ip());
                    }
                }
            }
            Method::Binding | Method::Send | Method::Data => {
                return Builder::new(method, Class::Error, &transaction)
                    .attribute(ERROR_CODE, &[0, 0, 4, 0])
                    .fingerprint()
                    .build();
            }
        }
        success.integrity(&self.key).fingerprint().build()
    }
}
