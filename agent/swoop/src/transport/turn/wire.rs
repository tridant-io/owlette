//! STUN and TURN on the wire: RFC 8489's message framing with RFC 8656's
//! methods and attributes, and ChannelData.
//!
//! Only what [`super::alloc`] sends and reads back. Addresses are IPv4: the
//! allocation asks for an IPv4 relay from an IPv4 socket, so an IPv6 address
//! decodes to `None` rather than to something nobody can use. Reading never
//! panics; anything malformed is `None`.

use std::net::{SocketAddr, SocketAddrV4};
use std::ops::RangeInclusive;

use super::md5;
use crate::transport::stun::{ipv4, FAMILY_IPV4, HEADER_LEN, MAGIC_COOKIE, TRANSACTION_LEN};

pub type TransactionId = [u8; TRANSACTION_LEN];

pub const USERNAME: u16 = 0x0006;
pub const MESSAGE_INTEGRITY: u16 = 0x0008;
pub const ERROR_CODE: u16 = 0x0009;
pub const CHANNEL_NUMBER: u16 = 0x000c;
pub const LIFETIME: u16 = 0x000d;
pub const XOR_PEER_ADDRESS: u16 = 0x0012;
pub const DATA: u16 = 0x0013;
pub const REALM: u16 = 0x0014;
pub const NONCE: u16 = 0x0015;
pub const XOR_RELAYED_ADDRESS: u16 = 0x0016;
pub const REQUESTED_TRANSPORT: u16 = 0x0019;
pub const XOR_MAPPED_ADDRESS: u16 = 0x0020;
pub const FINGERPRINT: u16 = 0x8028;

/// REQUESTED-TRANSPORT's protocol number for UDP (RFC 8656 §18.7).
pub const TRANSPORT_UDP: u8 = 17;

/// The channel numbers a client may bind (RFC 8656 §12).
pub const CHANNELS: RangeInclusive<u16> = 0x4000..=0x4fff;

const ATTRIBUTE_HEADER_LEN: usize = 4;
const INTEGRITY_LEN: usize = 20;
const FINGERPRINT_LEN: usize = 4;
/// RFC 8489 §14.7: the CRC is xored with "STUN", so a payload that happens
/// to carry a CRC of its own is not mistaken for a fingerprint.
const FINGERPRINT_XOR: u32 = 0x5354_554e;
const CHANNEL_HEADER_LEN: usize = 4;

/// The methods this client uses (RFC 8489 §18.2, RFC 8656 §17).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Binding,
    Allocate,
    Refresh,
    Send,
    Data,
    CreatePermission,
    ChannelBind,
}

impl Method {
    const ALL: [Self; 7] = [
        Self::Binding,
        Self::Allocate,
        Self::Refresh,
        Self::Send,
        Self::Data,
        Self::CreatePermission,
        Self::ChannelBind,
    ];

    fn code(self) -> u16 {
        match self {
            Self::Binding => 0x001,
            Self::Allocate => 0x003,
            Self::Refresh => 0x004,
            Self::Send => 0x006,
            Self::Data => 0x007,
            Self::CreatePermission => 0x008,
            Self::ChannelBind => 0x009,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Request,
    Indication,
    Success,
    Error,
}

/// RFC 8489 §5: the class's two bits are threaded between the method's
/// twelve.
fn message_type(method: Method, class: Class) -> u16 {
    let m = method.code();
    let c = match class {
        Class::Request => 0x000,
        Class::Indication => 0x010,
        Class::Success => 0x100,
        Class::Error => 0x110,
    };
    (m & 0x000f) | ((m & 0x0070) << 1) | ((m & 0x0f80) << 2) | c
}

fn split_type(kind: u16) -> (u16, Class) {
    let method = (kind & 0x000f) | ((kind & 0x00e0) >> 1) | ((kind & 0x3e00) >> 2);
    let class = match kind & 0x0110 {
        0x000 => Class::Request,
        0x010 => Class::Indication,
        0x100 => Class::Success,
        _ => Class::Error,
    };
    (method, class)
}

/// HMAC-SHA1 from str0m's crypto provider, the one its ICE agent already
/// uses for MESSAGE-INTEGRITY.
fn hmac_sha1(key: &[u8], payloads: &[&[u8]]) -> [u8; INTEGRITY_LEN] {
    str0m::crypto::from_feature_flags()
        .sha1_hmac_provider
        .sha1_hmac(key, payloads)
}

/// The long-term credential key, MD5(username ":" realm ":" password)
/// (RFC 8489 §9.2.2). The strings are used as given: SASLprep is not applied,
/// which leaves ASCII credentials, the only kind a TURN service mints,
/// unchanged.
pub fn long_term_key(username: &[u8], realm: &[u8], password: &[u8]) -> [u8; 16] {
    let mut input = Vec::with_capacity(username.len() + realm.len() + password.len() + 2);
    input.extend_from_slice(username);
    input.push(b':');
    input.extend_from_slice(realm);
    input.push(b':');
    input.extend_from_slice(password);
    md5::digest(&input)
}

/// CRC-32 as FINGERPRINT means it: IEEE 802.3, reflected, all ones in and out.
fn crc32(bytes: &[u8]) -> u32 {
    const TABLE: [u32; 256] = {
        let mut table = [0u32; 256];
        let mut i = 0;
        while i < 256 {
            let mut crc = i as u32;
            let mut bit = 0;
            while bit < 8 {
                crc = if crc & 1 == 1 {
                    0xedb8_8320 ^ (crc >> 1)
                } else {
                    crc >> 1
                };
                bit += 1;
            }
            table[i] = crc;
            i += 1;
        }
        table
    };
    !bytes.iter().fold(!0u32, |crc, &byte| {
        TABLE[usize::from(crc as u8 ^ byte)] ^ (crc >> 8)
    })
}

/// A message under construction. Each attribute is padded to four bytes as it
/// is added and the header's length kept current, so [`integrity`] and
/// [`fingerprint`] can be computed over exactly what precedes them.
///
/// Values must fit a STUN message (64 KiB); the callers' are a few bytes, or a
/// payload [`super::alloc`] has already bounded.
///
/// [`integrity`]: Self::integrity
/// [`fingerprint`]: Self::fingerprint
pub struct Builder {
    bytes: Vec<u8>,
}

impl Builder {
    pub fn new(method: Method, class: Class, transaction: &TransactionId) -> Self {
        let mut bytes = Vec::with_capacity(128);
        bytes.extend_from_slice(&message_type(method, class).to_be_bytes());
        bytes.extend_from_slice(&[0, 0]);
        bytes.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        bytes.extend_from_slice(transaction);
        Self { bytes }
    }

    pub fn attribute(mut self, kind: u16, value: &[u8]) -> Self {
        self.bytes.extend_from_slice(&kind.to_be_bytes());
        self.bytes
            .extend_from_slice(&(value.len() as u16).to_be_bytes());
        self.bytes.extend_from_slice(value);
        self.bytes.resize(self.bytes.len().next_multiple_of(4), 0);
        self.set_length(self.bytes.len());
        self
    }

    /// An XOR-…-ADDRESS attribute: the port under the cookie's top half and
    /// the address under all of it.
    pub fn address(self, kind: u16, address: SocketAddrV4) -> Self {
        let mut value = [0u8; 8];
        value[1] = FAMILY_IPV4;
        value[2..4].copy_from_slice(&(address.port() ^ (MAGIC_COOKIE >> 16) as u16).to_be_bytes());
        value[4..].copy_from_slice(&(u32::from(*address.ip()) ^ MAGIC_COOKIE).to_be_bytes());
        self.attribute(kind, &value)
    }

    /// MESSAGE-INTEGRITY: HMAC-SHA1 over the message so far, with the
    /// header's length already counting the integrity attribute itself
    /// (RFC 8489 §14.5).
    pub fn integrity(mut self, key: &[u8]) -> Self {
        self.set_length(self.bytes.len() + ATTRIBUTE_HEADER_LEN + INTEGRITY_LEN);
        let mac = hmac_sha1(key, &[&self.bytes]);
        self.attribute(MESSAGE_INTEGRITY, &mac)
    }

    /// FINGERPRINT, which must be last: the CRC over the message so far, the
    /// length again counting the attribute itself (RFC 8489 §14.7).
    pub fn fingerprint(mut self) -> Self {
        self.set_length(self.bytes.len() + ATTRIBUTE_HEADER_LEN + FINGERPRINT_LEN);
        let crc = crc32(&self.bytes) ^ FINGERPRINT_XOR;
        self.attribute(FINGERPRINT, &crc.to_be_bytes())
    }

    pub fn build(self) -> Vec<u8> {
        self.bytes
    }

    /// The header's length field for a message `total` bytes long.
    fn set_length(&mut self, total: usize) {
        let length = (total - HEADER_LEN) as u16;
        self.bytes[2..4].copy_from_slice(&length.to_be_bytes());
    }
}

/// A STUN message read off the wire.
///
/// [`parse`](Self::parse) checks the framing and a FINGERPRINT if there is
/// one. Attributes after MESSAGE-INTEGRITY are not covered by it and are not
/// read (RFC 8489 §14.5).
pub struct Message<'a> {
    bytes: &'a [u8],
    kind: u16,
    transaction: TransactionId,
    /// Where MESSAGE-INTEGRITY's header starts.
    integrity_at: Option<usize>,
}

impl<'a> Message<'a> {
    /// The message one whole datagram holds, or `None` for anything else:
    /// the wrong cookie, a length that disagrees with the datagram, an
    /// attribute running past the end, or a FINGERPRINT that is not last or
    /// does not match.
    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        let header = bytes.get(..HEADER_LEN)?;
        let kind = u16::from_be_bytes([header[0], header[1]]);
        let length = usize::from(u16::from_be_bytes([header[2], header[3]]));
        let cookie = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        // the top two bits are zero in every stun message, which is what
        // tells one from channeldata, rtp or dtls on the same port
        if kind & 0xc000 != 0
            || cookie != MAGIC_COOKIE
            || !length.is_multiple_of(4)
            || bytes.len() != HEADER_LEN + length
        {
            return None;
        }
        let transaction = header[8..].try_into().ok()?;
        let mut integrity_at = None;
        let mut at = HEADER_LEN;
        while at < bytes.len() {
            let head = bytes.get(at..at + ATTRIBUTE_HEADER_LEN)?;
            let attribute = u16::from_be_bytes([head[0], head[1]]);
            let len = usize::from(u16::from_be_bytes([head[2], head[3]]));
            let value = bytes.get(at + ATTRIBUTE_HEADER_LEN..at + ATTRIBUTE_HEADER_LEN + len)?;
            let next = at + ATTRIBUTE_HEADER_LEN + len.next_multiple_of(4);
            match attribute {
                MESSAGE_INTEGRITY if integrity_at.is_none() => {
                    if len != INTEGRITY_LEN {
                        return None;
                    }
                    integrity_at = Some(at);
                }
                FINGERPRINT => {
                    let expected = crc32(&bytes[..at]) ^ FINGERPRINT_XOR;
                    if next != bytes.len() || value != expected.to_be_bytes() {
                        return None;
                    }
                }
                _ => {}
            }
            // with the length a multiple of four, padding never runs past
            // the end once the value fits
            at = next;
        }
        Some(Self {
            bytes,
            kind,
            transaction,
            integrity_at,
        })
    }

    /// `None` for a method this client never uses.
    pub fn method(&self) -> Option<Method> {
        let (code, _) = split_type(self.kind);
        Method::ALL.into_iter().find(|method| method.code() == code)
    }

    pub fn class(&self) -> Class {
        split_type(self.kind).1
    }

    pub fn transaction(&self) -> TransactionId {
        self.transaction
    }

    /// The first `kind` attribute's value before MESSAGE-INTEGRITY.
    pub fn attribute(&self, kind: u16) -> Option<&'a [u8]> {
        let end = self.integrity_at.unwrap_or(self.bytes.len());
        let mut at = HEADER_LEN;
        while at < end {
            let head = self.bytes.get(at..at + ATTRIBUTE_HEADER_LEN)?;
            let len = usize::from(u16::from_be_bytes([head[2], head[3]]));
            if u16::from_be_bytes([head[0], head[1]]) == kind {
                return self
                    .bytes
                    .get(at + ATTRIBUTE_HEADER_LEN..at + ATTRIBUTE_HEADER_LEN + len);
            }
            at += ATTRIBUTE_HEADER_LEN + len.next_multiple_of(4);
        }
        None
    }

    /// An XOR-…-ADDRESS attribute, IPv4 only.
    pub fn address(&self, kind: u16) -> Option<SocketAddr> {
        ipv4(self.attribute(kind)?, MAGIC_COOKIE)
    }

    /// ERROR-CODE as its three-digit number.
    pub fn error_code(&self) -> Option<u16> {
        let &[_, _, class, number, ..] = self.attribute(ERROR_CODE)? else {
            return None;
        };
        Some(u16::from(class & 0x07) * 100 + u16::from(number))
    }

    /// LIFETIME, in seconds.
    pub fn lifetime(&self) -> Option<u32> {
        let value: [u8; 4] = self.attribute(LIFETIME)?.try_into().ok()?;
        Some(u32::from_be_bytes(value))
    }

    /// Whether MESSAGE-INTEGRITY checks out under `key`; `None` when the
    /// message carries none.
    pub fn integrity_matches(&self, key: &[u8]) -> Option<bool> {
        let at = self.integrity_at?;
        let mut header: [u8; HEADER_LEN] = self.bytes[..HEADER_LEN].try_into().ok()?;
        let covered = (at + ATTRIBUTE_HEADER_LEN + INTEGRITY_LEN - HEADER_LEN) as u16;
        header[2..4].copy_from_slice(&covered.to_be_bytes());
        let mac = hmac_sha1(key, &[&header, &self.bytes[HEADER_LEN..at]]);
        let start = at + ATTRIBUTE_HEADER_LEN;
        Some(self.bytes.get(start..start + INTEGRITY_LEN)? == mac)
    }
}

/// A ChannelData message (RFC 8656 §12.4), unpadded: over UDP the padding is
/// optional and would only cost bytes.
pub fn channel_data(channel: u16, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(CHANNEL_HEADER_LEN + payload.len());
    out.extend_from_slice(&channel.to_be_bytes());
    out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// A ChannelData message's channel and payload, padded or not. `None` for a
/// channel outside [`CHANNELS`] or a length the datagram does not hold.
pub fn read_channel_data(datagram: &[u8]) -> Option<(u16, &[u8])> {
    let &[c0, c1, l0, l1, ..] = datagram else {
        return None;
    };
    let channel = u16::from_be_bytes([c0, c1]);
    let len = usize::from(u16::from_be_bytes([l0, l1]));
    if !CHANNELS.contains(&channel) || datagram.len() > CHANNEL_HEADER_LEN + len.next_multiple_of(4)
    {
        return None;
    }
    let payload = datagram.get(CHANNEL_HEADER_LEN..CHANNEL_HEADER_LEN + len)?;
    Some((channel, payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 5769 §2.1, the sample request: SOFTWARE, PRIORITY, ICE-CONTROLLED,
    /// USERNAME "evtj:h6vY" (padded with spaces, which the integrity covers),
    /// MESSAGE-INTEGRITY under the short-term password, FINGERPRINT.
    const RFC_5769_REQUEST: [u8; 108] = [
        0x00, 0x01, 0x00, 0x58, 0x21, 0x12, 0xa4, 0x42, 0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6,
        0x86, 0xfa, 0x87, 0xdf, 0xae, 0x80, 0x22, 0x00, 0x10, 0x53, 0x54, 0x55, 0x4e, 0x20, 0x74,
        0x65, 0x73, 0x74, 0x20, 0x63, 0x6c, 0x69, 0x65, 0x6e, 0x74, 0x00, 0x24, 0x00, 0x04, 0x6e,
        0x00, 0x01, 0xff, 0x80, 0x29, 0x00, 0x08, 0x93, 0x2f, 0xf9, 0xb1, 0x51, 0x26, 0x3b, 0x36,
        0x00, 0x06, 0x00, 0x09, 0x65, 0x76, 0x74, 0x6a, 0x3a, 0x68, 0x36, 0x76, 0x59, 0x20, 0x20,
        0x20, 0x00, 0x08, 0x00, 0x14, 0x9a, 0xea, 0xa7, 0x0c, 0xbf, 0xd8, 0xcb, 0x56, 0x78, 0x1e,
        0xf2, 0xb5, 0xb2, 0xd3, 0xf2, 0x49, 0xc1, 0xb5, 0x71, 0xa2, 0x80, 0x28, 0x00, 0x04, 0xe5,
        0x7a, 0x3b, 0xcf,
    ];
    const RFC_5769_PASSWORD: &[u8] = b"VOkJxbRl1RmTxUk/WvJxBt";

    /// RFC 5769 §2.4, the sample request with long-term authentication:
    /// USERNAME, NONCE, REALM, MESSAGE-INTEGRITY, no FINGERPRINT.
    const RFC_5769_LONG_TERM_REQUEST: [u8; 116] = [
        0x00, 0x01, 0x00, 0x60, 0x21, 0x12, 0xa4, 0x42, 0x78, 0xad, 0x34, 0x33, 0xc6, 0xad, 0x72,
        0xc0, 0x29, 0xda, 0x41, 0x2e, 0x00, 0x06, 0x00, 0x12, 0xe3, 0x83, 0x9e, 0xe3, 0x83, 0x88,
        0xe3, 0x83, 0xaa, 0xe3, 0x83, 0x83, 0xe3, 0x82, 0xaf, 0xe3, 0x82, 0xb9, 0x00, 0x00, 0x00,
        0x15, 0x00, 0x1c, 0x66, 0x2f, 0x2f, 0x34, 0x39, 0x39, 0x6b, 0x39, 0x35, 0x34, 0x64, 0x36,
        0x4f, 0x4c, 0x33, 0x34, 0x6f, 0x4c, 0x39, 0x46, 0x53, 0x54, 0x76, 0x79, 0x36, 0x34, 0x73,
        0x41, 0x00, 0x14, 0x00, 0x0b, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x6f, 0x72,
        0x67, 0x00, 0x00, 0x08, 0x00, 0x14, 0xf6, 0x70, 0x24, 0x65, 0x6d, 0xd6, 0x4a, 0x3e, 0x02,
        0xb8, 0xe0, 0x71, 0x2e, 0x85, 0xc9, 0xa2, 0x8c, 0xa8, 0x96, 0x66,
    ];
    /// "マトリックス", already through SASLprep as the RFC gives it.
    const RFC_5769_USERNAME: &str = "\u{30de}\u{30c8}\u{30ea}\u{30c3}\u{30af}\u{30b9}";
    const RFC_5769_NONCE: &[u8] = b"f//499k954d6OL34oL9FSTvy64sA";
    /// The RFC's password after SASLprep strips its soft hyphen and folds the
    /// feminine ordinal to "a".
    const RFC_5769_LONG_TERM_PASSWORD: &[u8] = b"TheMatrIX";

    fn transaction_of(message: &[u8]) -> TransactionId {
        message[8..HEADER_LEN].try_into().expect("a 20-byte header")
    }

    #[test]
    fn crc32_is_the_ieee_one() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn the_rfc_5769_short_term_request_checks_out() {
        let message = Message::parse(&RFC_5769_REQUEST).expect("framing and fingerprint check out");
        assert_eq!(message.method(), Some(Method::Binding));
        assert_eq!(message.class(), Class::Request);
        assert_eq!(message.transaction(), transaction_of(&RFC_5769_REQUEST));
        assert_eq!(message.attribute(USERNAME), Some(&b"evtj:h6vY"[..]));
        assert_eq!(message.integrity_matches(RFC_5769_PASSWORD), Some(true));
        assert_eq!(
            message.integrity_matches(b"VOkJxbRl1RmTxUk/WvJxBu"),
            Some(false)
        );

        // the fingerprint, recomputed here rather than trusted to parse
        let (body, tail) = RFC_5769_REQUEST.split_at(RFC_5769_REQUEST.len() - 8);
        assert_eq!(tail[..4], [0x80, 0x28, 0x00, 0x04]);
        assert_eq!(tail[4..], (crc32(body) ^ FINGERPRINT_XOR).to_be_bytes());
        let mut wrong = RFC_5769_REQUEST;
        wrong[107] ^= 1;
        assert!(
            Message::parse(&wrong).is_none(),
            "a bad fingerprint is not stun"
        );
        let mut tampered = RFC_5769_REQUEST;
        tampered[44] ^= 1;
        let fingerprint = crc32(&tampered[..100]) ^ FINGERPRINT_XOR;
        tampered[104..].copy_from_slice(&fingerprint.to_be_bytes());
        let tampered = Message::parse(&tampered).expect("the fingerprint was redone");
        assert_eq!(
            tampered.integrity_matches(RFC_5769_PASSWORD),
            Some(false),
            "a changed priority fails the integrity"
        );
    }

    #[test]
    fn the_rfc_5769_long_term_request_is_built_byte_for_byte() {
        let key = long_term_key(
            RFC_5769_USERNAME.as_bytes(),
            b"example.org",
            RFC_5769_LONG_TERM_PASSWORD,
        );
        let built = Builder::new(
            Method::Binding,
            Class::Request,
            &transaction_of(&RFC_5769_LONG_TERM_REQUEST),
        )
        .attribute(USERNAME, RFC_5769_USERNAME.as_bytes())
        .attribute(NONCE, RFC_5769_NONCE)
        .attribute(REALM, b"example.org")
        .integrity(&key)
        .build();
        assert_eq!(built, RFC_5769_LONG_TERM_REQUEST);

        let message = Message::parse(&RFC_5769_LONG_TERM_REQUEST).expect("a well-framed request");
        assert_eq!(message.integrity_matches(&key), Some(true));
        assert_eq!(message.attribute(REALM), Some(&b"example.org"[..]));
        assert_eq!(message.attribute(NONCE), Some(RFC_5769_NONCE));
        let wrong = long_term_key(RFC_5769_USERNAME.as_bytes(), b"example.org", b"TheMatrix");
        assert_eq!(message.integrity_matches(&wrong), Some(false));
    }

    #[test]
    fn message_types_thread_the_class_between_the_method_bits() {
        let transaction = [7; TRANSACTION_LEN];
        for (method, class, kind) in [
            (Method::Allocate, Class::Request, 0x0003),
            (Method::Allocate, Class::Success, 0x0103),
            (Method::Allocate, Class::Error, 0x0113),
            (Method::Refresh, Class::Request, 0x0004),
            (Method::Send, Class::Indication, 0x0016),
            (Method::Data, Class::Indication, 0x0017),
            (Method::CreatePermission, Class::Success, 0x0108),
            (Method::ChannelBind, Class::Error, 0x0119),
            (Method::Binding, Class::Success, 0x0101),
        ] {
            let bytes = Builder::new(method, class, &transaction).build();
            assert_eq!(bytes[..2], u16::to_be_bytes(kind), "{method:?} {class:?}");
            let message = Message::parse(&bytes).expect("a bare header");
            assert_eq!((message.method(), message.class()), (Some(method), class));
        }
        // a method this client never uses reads as none
        let mut other = Builder::new(Method::Binding, Class::Request, &transaction).build();
        other[1] = 0x0a;
        assert_eq!(Message::parse(&other).expect("framed").method(), None);
    }

    #[test]
    fn attributes_round_trip_padded_with_integrity_and_fingerprint() {
        let peer: SocketAddrV4 = "203.0.113.7:61000".parse().expect("a literal address");
        let bytes = Builder::new(Method::Allocate, Class::Success, &[1; TRANSACTION_LEN])
            .address(XOR_RELAYED_ADDRESS, peer)
            .attribute(LIFETIME, &600u32.to_be_bytes())
            .attribute(ERROR_CODE, &[0, 0, 4, 38, b'x'])
            .attribute(REALM, b"r")
            .integrity(b"key")
            .fingerprint()
            .build();
        assert!(bytes.len().is_multiple_of(4));
        let message = Message::parse(&bytes).expect("what the builder makes parses");
        assert_eq!(message.address(XOR_RELAYED_ADDRESS), Some(peer.into()));
        assert_eq!(message.lifetime(), Some(600));
        assert_eq!(message.error_code(), Some(438));
        assert_eq!(message.attribute(REALM), Some(&b"r"[..]));
        assert_eq!(message.attribute(NONCE), None);
        assert_eq!(message.integrity_matches(b"key"), Some(true));
        assert_eq!(message.integrity_matches(b"kez"), Some(false));
        let unsigned = Builder::new(Method::Refresh, Class::Request, &[1; TRANSACTION_LEN]).build();
        assert_eq!(
            Message::parse(&unsigned)
                .expect("framed")
                .integrity_matches(b"key"),
            None
        );
    }

    #[test]
    fn attributes_after_message_integrity_are_not_read() {
        let mut bytes = Builder::new(Method::Allocate, Class::Success, &[2; TRANSACTION_LEN])
            .integrity(b"key")
            .build();
        // smuggled in after the integrity, which does not cover it
        bytes.extend_from_slice(&XOR_RELAYED_ADDRESS.to_be_bytes());
        bytes.extend_from_slice(&8u16.to_be_bytes());
        bytes.extend_from_slice(&[0, FAMILY_IPV4, 1, 2, 3, 4, 5, 6]);
        let length = (bytes.len() - HEADER_LEN) as u16;
        bytes[2..4].copy_from_slice(&length.to_be_bytes());
        let message = Message::parse(&bytes).expect("framed");
        assert_eq!(message.address(XOR_RELAYED_ADDRESS), None);
    }

    #[test]
    fn an_ipv6_address_is_refused_cleanly() {
        let mut value = vec![0, 0x02, 0x12, 0x34];
        value.extend_from_slice(&[0xab; 16]);
        let bytes = Builder::new(Method::Allocate, Class::Success, &[3; TRANSACTION_LEN])
            .attribute(XOR_RELAYED_ADDRESS, &value)
            .build();
        let message = Message::parse(&bytes).expect("framed");
        assert_eq!(message.address(XOR_RELAYED_ADDRESS), None);
    }

    #[test]
    fn channel_data_round_trips_padded_or_not() {
        let framed = channel_data(0x4001, b"hello");
        assert_eq!(
            framed,
            [0x40, 0x01, 0x00, 0x05, b'h', b'e', b'l', b'l', b'o']
        );
        assert_eq!(read_channel_data(&framed), Some((0x4001, &b"hello"[..])));
        let mut padded = framed.clone();
        padded.extend_from_slice(&[0, 0, 0]);
        assert_eq!(read_channel_data(&padded), Some((0x4001, &b"hello"[..])));
        assert_eq!(
            read_channel_data(&channel_data(0x4fff, b"")),
            Some((0x4fff, &b""[..]))
        );

        let mut overlong = padded.clone();
        overlong.extend_from_slice(&[0; 4]);
        assert_eq!(read_channel_data(&overlong), None, "more than padding");
        assert_eq!(read_channel_data(&framed[..8]), None, "short of its length");
        assert_eq!(
            read_channel_data(&channel_data(0x5000, b"x")),
            None,
            "reserved"
        );
        assert_eq!(read_channel_data(&channel_data(0x3fff, b"x")), None);
        assert_eq!(read_channel_data(&[0x40, 0x00, 0x00]), None);
    }

    #[test]
    fn malformed_messages_are_none_and_never_panic() {
        for message in [&RFC_5769_REQUEST[..], &RFC_5769_LONG_TERM_REQUEST[..]] {
            for len in 0..message.len() {
                assert!(
                    Message::parse(&message[..len]).is_none(),
                    "truncated to {len}"
                );
            }
        }
        let mut long_attribute = RFC_5769_LONG_TERM_REQUEST;
        long_attribute[22..24].copy_from_slice(&0xfffcu16.to_be_bytes());
        assert!(Message::parse(&long_attribute).is_none());
        let mut short_integrity = RFC_5769_LONG_TERM_REQUEST;
        short_integrity[95] = 0x10;
        assert!(Message::parse(&short_integrity).is_none());
        let mut wrong_cookie = RFC_5769_LONG_TERM_REQUEST;
        wrong_cookie[4] ^= 1;
        assert!(Message::parse(&wrong_cookie).is_none());
        let mut top_bits = RFC_5769_LONG_TERM_REQUEST;
        top_bits[0] = 0x40;
        assert!(Message::parse(&top_bits).is_none());
        let mut fingerprint_not_last = RFC_5769_REQUEST.to_vec();
        fingerprint_not_last.extend_from_slice(&[0x80, 0x22, 0x00, 0x00]);
        fingerprint_not_last[3] += 4;
        assert!(Message::parse(&fingerprint_not_last).is_none());
        assert!(Message::parse(&[0; 64]).is_none());
        assert!(Message::parse(&[0xff; 64]).is_none());

        // error codes and lifetimes too short to be either
        let bytes = Builder::new(Method::Allocate, Class::Error, &[4; TRANSACTION_LEN])
            .attribute(ERROR_CODE, &[0, 0, 4])
            .attribute(LIFETIME, &[0, 0, 2])
            .build();
        let message = Message::parse(&bytes).expect("framed");
        assert_eq!(message.error_code(), None);
        assert_eq!(message.lifetime(), None);
    }
}
