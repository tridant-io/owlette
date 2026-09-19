//! The room's socket: the one place in this crate that opens a network
//! connection.
//!
//! [`super::client`], [`super::dial`] and [`super::admission`] stay sans-IO and
//! testable; this module is the whole of the seam they were written against. It
//! implements [`SignalTransport`] over a real `wss://` connection and adds the
//! read half the trait has no room for — the trait is what the client writes
//! *to*, and nothing in `signal/` could produce an [`Incoming`] until now.
//!
//! Sync tungstenite over rustls, no async runtime: the session loop drives
//! capture, str0m and this socket on one thread (plan.md D2), so [`RoomSocket`]
//! is non-blocking after the handshake and the loop's own tick paces it.
//!
//! **What this module exists to surface, and must never flatten:** §1's refusal
//! vocabulary. A refused upgrade carries an http status and an `x-swoop-error`
//! header; a mid-socket refusal carries an `error` frame and then close 4401.
//! [`super::dial::classify_handshake`] and [`super::dial::classify_close`] turn
//! those into `Remint` or `Backoff`, and they cannot do it from a transport
//! that collapses every failure into one error.
//!
//! No error here ever carries a message body, only a failure *class*: a
//! handshake error's text can quote the request line, and the request line
//! carries `Authorization: Bearer <host token>`.
//!
//! The live test, against a local worker:
//!
//! ```text
//! cd infra/swoop-signal
//! npx wrangler dev --port 8787 \
//!   --var SWOOP_JWT_KID:test-kid-1 \
//!   --var SWOOP_JWT_PUBLIC_KEY:<the test-kid-1 publicKey in testdata/protocol/keys.test-only.json>
//! cd agent/swoop && cargo test -- --ignored signal_room
//! ```

use std::fmt;
use std::io::ErrorKind;
use std::net::TcpStream;

use tungstenite::client::connect_with_config;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::frame::CloseFrame;
use tungstenite::protocol::{Message, WebSocket, WebSocketConfig};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{ClientRequestBuilder, Error as WsError};

use crate::signal::client::{Incoming, SignalTransport};
use crate::signal::dial::{classify_handshake, Handshake, Reaction, SUBPROTOCOL};
use crate::signal::messages::MAX_MESSAGE_BYTES;

/// The header the worker labels a refused upgrade with, because a websocket
/// client that fails a handshake usually sees the status and the headers but
/// not the body.
const SWOOP_ERROR: &str = "x-swoop-error";

/// rfc 6455: the close code for an end with no close frame. `classify_close`
/// reads it as a backoff, which is the right answer for a socket that died.
const CLOSE_ABNORMAL: u16 = 1006;
/// rfc 6455: a close frame that carried no status code.
const CLOSE_NO_STATUS: u16 = 1005;

/// Why the room could not be reached, or stopped being reachable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SocketError {
    /// The upgrade was refused. Both halves travel, because the status alone
    /// cannot tell a re-mint from a backoff: §1's three auth words are in the
    /// header.
    Refused { status: u16, code: Option<String> },
    /// 101, but without `owlette.swoop.v1` echoed back. rfc 6455 says a client
    /// fails the connection when the server names a subprotocol it did not
    /// offer, and tungstenite does not check.
    Subprotocol,
    /// The url, the name resolution, the tcp connect, the tls handshake or the
    /// socket itself. The failure's class and never its text.
    Io(&'static str),
}

impl SocketError {
    /// What to do about it — a fresh bundle, or the ladder.
    pub fn reaction(&self) -> Reaction {
        match self {
            SocketError::Refused { status, code } => classify_handshake(*status, code.as_deref()),
            _ => Reaction::Backoff,
        }
    }
}

impl fmt::Display for SocketError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SocketError::Refused { status, code } => {
                write!(f, "refused {status} {}", code.as_deref().unwrap_or("-"))
            }
            SocketError::Subprotocol => f.write_str("bad_subprotocol"),
            SocketError::Io(class) => write!(f, "unreachable {class}"),
        }
    }
}

impl std::error::Error for SocketError {}

/// The host's signaling socket for one session.
pub struct RoomSocket {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    /// Set once the end of the socket has been handed over, so the session loop
    /// is told about it exactly once and never spins on a dead socket.
    ended: bool,
}

impl RoomSocket {
    /// Dial the room the bundle names. Blocking, and the only blocking call
    /// here: the session loop is not running yet when this is made.
    pub fn dial(handshake: &Handshake<'_>) -> Result<Self, SocketError> {
        let uri = handshake.url.parse().map_err(|_| SocketError::Io("url"))?;
        let request = ClientRequestBuilder::new(uri)
            // the agent carries its token in a header, never as a second
            // subprotocol the way a browser must — which is what keeps it out
            // of every access log (§1).
            .with_header("Authorization", handshake.authorization())
            .with_sub_protocol(SUBPROTOCOL);
        // §2 caps a frame at 64 KiB and the room enforces it, so anything above
        // that is a broken or hostile relay rather than a frame to refuse
        // politely — and an uncapped reader would let it size this process's
        // buffers.
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        // zero redirects. the request carries the host token, and following a
        // 3xx would hand it to whatever host the `Location` header named.
        let (mut socket, response) =
            connect_with_config(request, Some(config), 0).map_err(refusal)?;

        let echoed = response
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok());
        if echoed != Some(SUBPROTOCOL) {
            return Err(SocketError::Subprotocol);
        }

        // the handshake is blocking; nothing after it is. a read that waited on
        // the room would stall capture and str0m with it.
        tcp_of(&mut socket)?.set_nonblocking(true).map_err(|_| SocketError::Io("io"))?;
        Ok(Self { socket, ended: false })
    }

    /// One look at the socket. `None` means nothing was pending — this never
    /// waits, and never sleeps; the session loop's tick is what paces it.
    ///
    /// Everything terminal arrives as one [`Incoming::Closed`], once: the
    /// room's own close frame with its code, or [`CLOSE_ABNORMAL`] for an end
    /// that had none. The `error` frame the worker sends before an auth close
    /// arrives ahead of it as ordinary text, which is how
    /// [`crate::signal::SignalClient`] reads the two together.
    pub fn poll(&mut self) -> Option<Incoming> {
        if self.ended {
            return None;
        }
        // a pong the library queued in answer to the room's ping — and any
        // frame a previous send could not push — only leaves on a flush.
        if let Err(error) = self.socket.flush() {
            if !would_block(&error) {
                return Some(self.end(&error));
            }
        }
        match self.socket.read() {
            Ok(Message::Text(text)) => Some(Incoming::Text(text.as_str().to_owned())),
            // §2: the signaling socket is text only.
            Ok(Message::Binary(_)) => Some(Incoming::Binary),
            Ok(Message::Close(frame)) => {
                self.ended = true;
                // best effort: the library queued the echo close, and the room
                // is entitled to see it before the tcp connection goes.
                let _ = self.socket.flush();
                Some(closed(frame.as_ref()))
            }
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => None,
            Err(error) if would_block(&error) => None,
            Err(error) => Some(self.end(&error)),
        }
    }

    /// False once the room is gone. The session loop stops reading on it.
    pub fn is_open(&self) -> bool {
        !self.ended
    }

    fn end(&mut self, error: &WsError) -> Incoming {
        self.ended = true;
        ::log::warn!("swoop: signaling socket ended ({})", class(error));
        Incoming::Closed { code: CLOSE_ABNORMAL, reason: String::new() }
    }
}

/// Hand-written, and it prints one bool: the derived one would render the tls
/// connection's state, and nothing that reads a `{:?}` needs that.
impl fmt::Debug for RoomSocket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RoomSocket").field("open", &self.is_open()).finish()
    }
}

impl SignalTransport for RoomSocket {
    fn send_text(&mut self, text: &str) -> anyhow::Result<()> {
        match self.socket.send(Message::text(text)) {
            Ok(()) => Ok(()),
            // the frame is in the write buffer and leaves on the next flush: a
            // non-blocking socket that could not take it this instant has not
            // lost it.
            Err(error) if would_block(&error) => Ok(()),
            Err(error) => {
                self.ended = true;
                Err(anyhow::anyhow!("signaling send failed: {}", class(&error)))
            }
        }
    }

    fn close(&mut self, code: u16, reason: &str) {
        let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
        let _ = self.socket.close(Some(frame));
        let _ = self.socket.flush();
        self.ended = true;
    }
}

/// The underlying tcp socket, whichever way the stream is wrapped.
fn tcp_of(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
) -> Result<&mut TcpStream, SocketError> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(tcp) => Ok(tcp),
        MaybeTlsStream::Rustls(tls) => Ok(&mut tls.sock),
        // `MaybeTlsStream` is non_exhaustive; no other variant is compiled in.
        _ => Err(SocketError::Io("stream")),
    }
}

fn refusal(error: WsError) -> SocketError {
    match error {
        WsError::Http(response) => SocketError::Refused {
            status: response.status().as_u16(),
            code: response
                .headers()
                .get(SWOOP_ERROR)
                .and_then(|value| value.to_str().ok())
                .map(bounded),
        },
        other => SocketError::Io(class(&other)),
    }
}

fn closed(frame: Option<&CloseFrame>) -> Incoming {
    match frame {
        None => Incoming::Closed { code: CLOSE_NO_STATUS, reason: String::new() },
        Some(frame) => Incoming::Closed {
            code: u16::from(frame.code),
            reason: bounded(frame.reason.as_str()),
        },
    }
}

/// A refusal word on its way to a log line or an audit event, from a server we
/// do not control. Length bounded and printable, the same treatment a `kid`
/// gets in `client.rs`, so a hostile relay cannot write whatever it likes into
/// the record. The three words `AuthSignal::parse` reads are unaffected.
fn bounded(raw: &str) -> String {
    raw.chars().filter(char::is_ascii_graphic).take(64).collect()
}

fn would_block(error: &WsError) -> bool {
    matches!(error, WsError::Io(io) if io.kind() == ErrorKind::WouldBlock)
}

/// The failure's class, and never its text — see this module's head comment.
fn class(error: &WsError) -> &'static str {
    match error {
        WsError::ConnectionClosed | WsError::AlreadyClosed => "closed",
        WsError::Io(_) => "io",
        WsError::Tls(_) => "tls",
        WsError::Capacity(_) => "capacity",
        WsError::Protocol(_) => "protocol",
        WsError::WriteBufferFull(_) => "write_buffer_full",
        WsError::Utf8(_) => "utf8",
        WsError::AttackAttempt => "attack_attempt",
        // the one a kiosk actually hits: nothing answered on any of the
        // addresses the room's name resolved to.
        WsError::Url(tungstenite::error::UrlError::UnableToConnect(_)) => "connect",
        WsError::Url(_) => "url",
        WsError::Http(_) => "http",
        WsError::HttpFormat(_) => "http_format",
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use crate::bundle::Bundle;
    use crate::signal::client::tests::golden_bundle;
    use crate::signal::dial::AuthSignal;

    use super::*;

    /// A room that refuses. One connection, one canned response, then hang up —
    /// which is every surface §1's handshake refusal has, since the worker
    /// refuses the upgrade in http and never opens a socket to refuse it in.
    fn refusing_room(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let port = listener.local_addr().expect("bound").port();
        thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            // read the request first: answering and hanging up on an unread
            // socket is a reset on windows, not a response.
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|end| end == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => return,
                    Ok(read) => request.extend_from_slice(&chunk[..read]),
                }
            }
            let _ = stream.write_all(response.as_bytes());
        });
        port
    }

    fn bundle_at(port: u16) -> Bundle {
        let mut bundle = golden_bundle();
        bundle.signal_url =
            format!("ws://127.0.0.1:{port}/v1/room/{}/{}", bundle.site, bundle.machine);
        bundle
    }

    /// The whole point of the module: a refused upgrade reaches the retry
    /// ladder as a status *and* the word the worker labelled it with, so §1's
    /// re-mint is still distinguishable from a backoff.
    #[test]
    fn a_refused_upgrade_surfaces_its_status_and_its_swoop_error() {
        let port = refusing_room(
            "HTTP/1.1 401 Unauthorized\r\nx-swoop-error: token_expired\r\ncontent-length: 0\r\n\r\n",
        );
        let bundle = bundle_at(port);
        let handshake = Handshake::new(&bundle).expect("the url is this room's");
        let error = RoomSocket::dial(&handshake).expect_err("the room refused");

        assert_eq!(
            error,
            SocketError::Refused { status: 401, code: Some("token_expired".to_owned()) }
        );
        assert_eq!(error.reaction(), Reaction::Remint(AuthSignal::TokenExpired));

        // §11, from the other end: the token was in the request this failed on.
        let rendered = format!("{error} {error:?}");
        let token = bundle.host_token.expose();
        assert!(!rendered.contains(token));
        for segment in token.split('.') {
            assert!(!rendered.contains(segment));
        }
    }

    /// Everything that is not one of the three words walks the ladder —
    /// including the worker's own `400 bad_subprotocol`, which no fresh bundle
    /// would fix.
    #[test]
    fn every_other_refusal_backs_off_rather_than_re_minting() {
        let port = refusing_room(
            "HTTP/1.1 400 Bad Request\r\nx-swoop-error: bad_subprotocol\r\ncontent-length: 0\r\n\r\n",
        );
        let bundle = bundle_at(port);
        let error = RoomSocket::dial(&Handshake::new(&bundle).expect("dialable"))
            .expect_err("the room refused");
        assert_eq!(
            error,
            SocketError::Refused { status: 400, code: Some("bad_subprotocol".to_owned()) }
        );
        assert_eq!(error.reaction(), Reaction::Backoff);

        // a 401 the worker did not label is not a re-mint either.
        let port = refusing_room("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
        let bundle = bundle_at(port);
        let error = RoomSocket::dial(&Handshake::new(&bundle).expect("dialable"))
            .expect_err("the room refused");
        assert_eq!(error, SocketError::Refused { status: 401, code: None });
        assert_eq!(error.reaction(), Reaction::Backoff);
    }

    /// A room that is not there at all: exit 14's road, not a re-mint and not a
    /// panic.
    #[test]
    fn a_room_that_answers_nothing_is_unreachable_and_backs_off() {
        // bound, read, then dropped without a response.
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let port = listener.local_addr().expect("bound").port();
        drop(listener);

        let bundle = bundle_at(port);
        let error = RoomSocket::dial(&Handshake::new(&bundle).expect("dialable"))
            .expect_err("nothing is listening");
        assert_eq!(error, SocketError::Io("connect"));
        assert_eq!(error.reaction(), Reaction::Backoff);
    }

    /// The refusal word comes from a server we do not control and ends up in a
    /// log line, so it is bounded before it gets there.
    #[test]
    fn a_refusal_word_is_bounded_before_it_reaches_a_log_line() {
        let long = "x".repeat(200);
        assert_eq!(bounded(&long).len(), 64);
        assert_eq!(bounded("token_expired"), "token_expired");
        assert_eq!(bounded("rate limited\tnow"), "ratelimitednow");
    }

    // ------------------------------------------------------------- the room ---

    /// The golden bundle, pointed at the local worker and carrying a host token
    /// minted here rather than taken from the vectors: the worker checks `exp`
    /// against its own wall clock and every golden token is anchored to a fixed
    /// `now`. It is signed with the published fake key in
    /// `testdata/protocol/keys.test-only.json`, which is the pair the
    /// `wrangler dev` command in this module's head comment hands the worker.
    ///
    /// The wall clock, in a test and nowhere else: §11 binds the *streamer's*
    /// verdicts to the bundle's anchor, and what is being stood in for here is
    /// the api that mints.
    fn live_bundle(ttl_s: u64) -> Bundle {
        use std::time::{SystemTime, UNIX_EPOCH};

        use base64::prelude::{Engine, BASE64_URL_SAFE_NO_PAD};
        use ed25519_dalek::{Signer, SigningKey};

        let mut bundle = golden_bundle();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("after 1970").as_secs();
        let header = serde_json::json!({"alg": "EdDSA", "typ": "JWT", "kid": "test-kid-1"});
        let claims = serde_json::json!({
            "iss": "owlette-api",
            "aud": "swoop-signal",
            "role": "host",
            "site": bundle.site,
            "machine": bundle.machine,
            "sid": bundle.sid,
            "iat": now,
            "exp": now + ttl_s,
            "jti": format!("jti_{now}_{ttl_s}"),
        });
        let signed = format!(
            "{}.{}",
            BASE64_URL_SAFE_NO_PAD.encode(header.to_string()),
            BASE64_URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let seed: [u8; 32] = *b"swoop-golden-vector-test-key-001";
        let signature = SigningKey::from_bytes(&seed).sign(signed.as_bytes());
        let token = format!("{signed}.{}", BASE64_URL_SAFE_NO_PAD.encode(signature.to_bytes()));

        bundle.host_token =
            serde_json::from_value(serde_json::Value::String(token)).expect("a secret is a string");
        bundle.signal_url =
            format!("ws://127.0.0.1:8787/v1/room/{}/{}", bundle.site, bundle.machine);
        bundle
    }

    /// Read until something arrives or the room has had long enough. Nothing in
    /// here waits on the socket, so this is the tick a session loop would have.
    fn next(socket: &mut RoomSocket, within: std::time::Duration) -> Incoming {
        let deadline = std::time::Instant::now() + within;
        loop {
            assert!(std::time::Instant::now() < deadline, "the room sent nothing");
            if let Some(incoming) = socket.poll() {
                return incoming;
            }
            thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// The dial itself, against `wrangler dev` — the invocation is in this
    /// module's head comment. Ignored: it needs a worker on :8787.
    #[test]
    #[ignore = "needs a local swoop-signal worker on :8787"]
    fn signal_room_accepts_the_dial_and_says_hello() {
        // §1: the dial is accepted only with the `owlette.swoop.v1`
        // subprotocol, which `dial` also refuses to proceed without.
        let bundle = live_bundle(300);
        let handshake = Handshake::new(&bundle).expect("the url is this room's");
        let mut socket = RoomSocket::dial(&handshake).expect("the worker accepts the dial");

        // §1: the room's first frame to every socket is a `hello` carrying the
        // protocol version and the role it admitted us as.
        let Incoming::Text(hello) = next(&mut socket, std::time::Duration::from_secs(5)) else {
            panic!("the room's first frame is a hello");
        };
        let hello: serde_json::Value = serde_json::from_str(&hello).expect("the hello is json");
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["protocolVersion"], 1);
        assert_eq!(hello["role"], "host");

        socket.close(1000, "bye");
        assert!(!socket.is_open());
    }

    /// The other half of §1's auth signal, and the reason this module may not
    /// flatten a failure: a token that expires *while the socket is open* is an
    /// `error` frame and then close 4401, and the two are read together. Drives
    /// the real client over the real socket, because the ordering is the whole
    /// claim.
    #[test]
    #[ignore = "needs a local swoop-signal worker on :8787"]
    fn signal_room_expiry_arrives_as_an_error_frame_and_then_a_4401() {
        use crate::signal::client::Effect;
        use crate::signal::SignalClient;

        // the worker checks `exp` lazily, only on a socket that sends, so this
        // token opens the socket and is stale by the time it is used.
        let bundle = live_bundle(1);
        let handshake = Handshake::new(&bundle).expect("the url is this room's");
        let mut socket = RoomSocket::dial(&handshake).expect("the worker accepts the dial");
        let mut client = SignalClient::from_bundle(&bundle).expect("the bundle builds a client");

        let hello = next(&mut socket, std::time::Duration::from_secs(5));
        assert!(client.drive(&mut socket, &hello).expect("no io").is_empty(), "the hello is ours");

        thread::sleep(std::time::Duration::from_millis(1500));
        socket.send_text("{\"type\":\"bye\"}").expect("the socket is still open");

        let error = next(&mut socket, std::time::Duration::from_secs(5));
        assert_eq!(
            client.drive(&mut socket, &error).expect("no io"),
            vec![Effect::RoomError {
                code: "token_expired".to_owned(),
                reaction: Reaction::Remint(AuthSignal::TokenExpired),
            }]
        );

        // and the close that follows it, which on its own would only say 4401.
        let Incoming::Closed { code, .. } = next(&mut socket, std::time::Duration::from_secs(5))
        else {
            panic!("the error frame is followed by a close");
        };
        assert_eq!(code, 4401);
        assert!(!socket.is_open(), "a closed room is not polled again");
    }
}
