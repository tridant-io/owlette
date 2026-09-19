"""swoop doorbell: one idle WebSocket to the signalling room, self-supervised.

The doorbell is the **documented exception** to "never spawn reconnection logic
outside ConnectionManager" (plan.md owner ruling; design in spike 0.6). The
reason is blast radius, not taste: ConnectionManager's state IS the Firestore
connection's state, and its watchdog treats any dead supervised thread as a
Firestore failure. Registering this thread there would mean one Cloudflare
incident -- one origin, one moment, the whole fleet -- makes every machine
report a Firestore error it does not have and cycle a healthy Firestore link.

So this module never calls register_thread or report_error, and it never
imports connection_manager. The offline gate is an injected callable
(``is_connected``, wired to firebase_client.is_connected), a lock-guarded
property read with no side effects. test_swoop_doorbell.py asserts the absent
import at the source level, so the guarantee is a property of the module rather
than of one code path.

Nothing here logs, prints or stores token material -- not at debug, not a
prefix, not a suffix. Failures are reported as an exception class name or a
reason enum only: a handshake error's text can carry the request line, and the
request line can carry a token.

Every wait is Event.wait; there is no time.sleep in this module, so the exit
latency after the shutdown event is the socket close, never a pending window.
"""

import collections
import json
import logging
import random
import threading
import time

import requests
import websocket

import shared_utils


# States. Seven operational plus a terminal one (spike 0.6 section 2).
STATE_IDLE = 'idle'
STATE_DIALLING = 'dialling'
STATE_CONNECTED = 'connected'
STATE_BACKOFF = 'backoff'
STATE_CIRCUIT_OPEN = 'circuit_open'
STATE_HALF_OPEN = 'half_open'
STATE_DISABLED_SLOW = 'disabled_slow'
STATE_STOPPED = 'stopped'

# Backoff ladder: 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300, 300.
# Deliberately NOT ConnectionManager's 30 s -> 1 h (connection_manager.py:205-206),
# which is right for Firestore, where an attempt is expensive and the machine is
# down. A cold doorbell is a degradation, not an outage, and it is the cheapest
# thing in the system to fix, so the base is small. The 5 min cap bounds the
# fleet's re-warm time after a Cloudflare incident ends; an hour-long cap would
# leave every session start in that hour on the ~35 s polled fallback.
BACKOFF_BASE_SECONDS = 2.0
BACKOFF_FACTOR = 2.0
BACKOFF_MAX_SECONDS = 300.0
BACKOFF_EXPONENT_CEILING = 8  # 2 * 2^8 = 512 > 300, so step 9 is already capped

# Consecutive failures before the circuit opens. ~14 min expected / ~29 min worst
# with full jitter: long enough to ride out a Worker deploy or a regional event,
# short enough that a permanently firewalled kiosk stops dialling every five
# minutes within the half hour. ConnectionManager's 5 (:210) is tuned for a
# resource whose loss is an emergency; this one for a slower session start.
FAILURE_THRESHOLD = 12

# Circuit probe, jittered to uniform(450, 900). Half-width, not full: the
# circuit-open population is already decorrelated by the ladder that got it
# there, and a full-jitter draw could return 10 s, which is a fast retry wearing
# a probe's name.
CIRCUIT_PROBE_SECONDS = 900.0

# Uptime at which a connection counts as evidence of health. Two keepalive round
# trips plus margin: without it a socket that connects and drops every 3 s never
# advances the ladder, and a socket up for eight hours restarts at the cap.
STABLE_CONNECTION_SECONDS = 120.0

# 403 swoop_disabled retry, jittered to uniform(900, 1800). This is the steady
# state for most of the fleet (swoop is off by default), so it is one request per
# ~22 min per machine. Not shorter because nobody waits on it -- enabling swoop
# sends swoop_refresh, which collapses the wait through refresh_now().
DISABLED_RETRY_SECONDS = 1800.0

# IDLE's re-read cadence for the injected gate. ConnectionManager's own watchdog
# runs at 10 s (:217) and its backoff floor is 30 s (:205), so this can never
# out-poll the thing it observes.
OFFLINE_RECHECK_SECONDS = 30.0

DIAL_TIMEOUT_SECONDS = 10.0  # whole dial: TCP + TLS + HTTP upgrade
MINT_TIMEOUT_SECONDS = 10.0

# Two protocol pings inside the ~100 s idle window intermediaries enforce, so one
# lost ping does not cost the socket. Incoming pings are auto-ponged by the
# Durable Object runtime without waking it, and are not billed.
PING_INTERVAL_SECONDS = 45.0
PING_TIMEOUT_SECONDS = 10.0  # must be < PING_INTERVAL for run_forever

# A ring is ~50 bytes; the largest legitimate inbound frame is an error with a
# reason string. The check is post-receive because websocket-client exposes no
# pre-allocation cap -- the Worker enforces its own 64 KiB limit upstream.
MAX_MESSAGE_BYTES = 4096

# More pending sids than a machine can plausibly have (the Worker already caps
# rings per machine per minute). Over the cap the OLDEST is dropped: the newest
# sid is the one a user is waiting on.
RING_QUEUE_MAX = 8

# One free, un-laddered re-mint-and-re-dial per minute on a 401. kid rotation
# runs with a two-key overlap, so a token minted just before a rotation can
# outlive the old key; one free retry turns that into a sub-second hiccup.
AUTH_RETRY_COOLDOWN_SECONDS = 60.0

STOP_JOIN_TIMEOUT_SECONDS = 5.0  # the design target is a 2 s exit

# Token refresh. The deadline is monotonic, never wall-clock: kiosks drift and
# NTP steps, and a stepped clock would either churn the socket or miss exp
# entirely. The 10 min floor is ~8 ladder steps of room for the mint to fail and
# recover (Railway rolls the container on every push); the jitter stops machines
# that booted together from minting together forever.
TOKEN_REFRESH_MARGIN_MIN_SECONDS = 600.0
TOKEN_REFRESH_MARGIN_MAX_SECONDS = 900.0
TOKEN_HARD_DEADLINE_SECONDS = 30.0  # close and back off rather than run past exp

# Close code / error codes that mean "this token is no longer acceptable", as
# distinct from a generic drop. Task 2.8 must close an expired or unknown-kid
# socket this way or a kid rotation costs every machine a full ladder.
AUTH_CLOSE_CODE = 4401
AUTH_ERROR_CODES = frozenset({'auth', 'token_expired', 'unknown_kid'})

# The protocol integer this build speaks (PROTOCOL.md section 1). One integer,
# no minor version, no negotiation: a bump is a fleet event that moves the
# agent, the worker and the web app together. This mirrors the streamer's
# agent/swoop/src/bundle.rs SWOOP_PROTOCOL_VERSION -- the agent side has no
# other home for it -- and test_swoop_doorbell.py pins both to the golden-vector
# manifest so the mirror cannot drift silently.
SWOOP_PROTOCOL_VERSION = 1

# Section 1's mismatch arm: a `bye` reason on the wire, and the sentence the
# operator reads. The room's protocol is ahead of ours, so the machine is the
# side that is behind.
VERSION_MISMATCH_REASON = 'version_mismatch'
VERSION_MISMATCH_MESSAGE = 'this machine needs an agent update'

# A ring carries a sid and nothing else (PROTOCOL.md section 11). The room
# stamps sentAtMs/serverTimeMs on what it forwards, so those two are accepted as
# transport metadata and ignored; any OTHER key is a shape we do not recognise
# and the frame is dropped.
RING_FIELDS = frozenset({'type', 'sid', 'sentAtMs', 'serverTimeMs'})

DOORBELL_TOKEN_PATH = '/agent/swoop/doorbell-token'

# Slice for the two-event wait below.
_WAIT_SLICE_SECONDS = 0.25

# Attempt outcomes.
_OK = 'ok'
_DISABLED = 'disabled'
_AUTH = 'auth'
_FAILED = 'failed'


def backoff_window(consecutive_failures):
    """Upper bound of the backoff draw after N consecutive failures (N >= 1)."""
    steps = min(max(consecutive_failures - 1, 0), BACKOFF_EXPONENT_CEILING)
    return min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * (BACKOFF_FACTOR ** steps))


def _default_socket_factory(url, token, on_open, on_message, on_close, on_error):
    """A WebSocketApp for the room. The token travels in a header, never in the
    URL -- a URL would reach Cloudflare's access logs."""
    return websocket.WebSocketApp(
        url,
        header=['Authorization: Bearer ' + token],
        on_open=on_open,
        on_message=on_message,
        on_close=on_close,
        on_error=on_error,
    )


class SwoopDoorbell:
    """Self-supervised doorbell socket.

    ``on_ring(sid)`` runs on a single-flight worker thread, never on the socket
    thread, so a slow ensure_streamer cannot stall the socket or its pings.
    """

    def __init__(self, on_ring, get_agent_token, shutdown_event,
                 is_connected=None, logger=None, socket_factory=None,
                 http_post=None, monotonic=None, wait=None, rng=None):
        self._on_ring = on_ring
        self._get_agent_token = get_agent_token
        self._shutdown = shutdown_event
        # Two different questions share a name: the INJECTED is_connected is the
        # machine's Firestore link (the gate on dialling), the METHOD below is
        # this socket. The gate never tears a warm socket down.
        self._is_online = is_connected if is_connected is not None else (lambda: True)
        self.logger = logger or logging.getLogger(__name__)

        # Seams: every one of these is real in production and faked in tests, so
        # no unit test touches the network or a real clock.
        self._socket_factory = socket_factory or _default_socket_factory
        self._http_post = http_post or requests.post
        self._monotonic = monotonic or time.monotonic
        self._wait_fn = wait or self._default_wait
        self._rng = rng or random.Random()

        self._state = STATE_IDLE
        self._failures = 0
        self._exponent = 0
        self._mint_failures = 0
        self._logged_once = set()

        self._token = None
        self._signal_url = None
        self._token_refresh_at = None
        self._token_hard_at = None
        self._mint_retry_at = None
        self._auth_retry_at = 0.0  # monotonic; the free-retry credit is spendable

        self._wake = threading.Event()
        self._thread = None
        self._ring_thread = None

        self._app = None
        self._socket_thread = None
        self._socket_open = threading.Event()
        self._socket_closed = threading.Event()
        self._dial_settled = threading.Event()
        self._close_reason = None
        self._connected_at = None
        self._stable = False
        self._rejects = 0
        self._dropped_rings = 0

        self._rings = collections.deque()
        self._rings_cv = threading.Condition()

    # public surface -- every one of these is a field read or an Event.set(),
    # because the callers are the 5 s service loop and a command handler.

    def start(self):
        """Start the supervision thread and the ring worker. Idempotent."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._ring_thread = threading.Thread(
            target=self._ring_worker, name='swoop-doorbell-ring', daemon=True)
        self._ring_thread.start()
        self._thread = threading.Thread(
            target=self._run, name='swoop-doorbell', daemon=True)
        self._thread.start()

    def stop(self):
        """Stop the doorbell. Idempotent and safe before start()."""
        self._shutdown.set()
        self._wake.set()
        with self._rings_cv:
            self._rings_cv.notify_all()
        self._close_socket('stop')
        current = threading.current_thread()
        for thread in (self._thread, self._ring_thread):
            if thread is not None and thread is not current and thread.is_alive():
                thread.join(timeout=STOP_JOIN_TIMEOUT_SECONDS)

    def is_connected(self):
        """True while the doorbell socket is up."""
        return self._state == STATE_CONNECTED

    def refresh_now(self):
        """Collapse whatever wait the machine is parked on.

        Exactly one Event.set() and no I/O: the caller is the swoop_refresh
        command handler on the fast lane and must not block.
        """
        self._wake.set()

    @property
    def state(self):
        """Current state, for SwoopManager.status() and the tray indicator."""
        return self._state

    # supervision loop

    def _run(self):
        while not self._shutdown.is_set() and self._state != STATE_STOPPED:
            self._step()
        self._close_socket('shutdown')
        self._join_socket()
        self._state = STATE_STOPPED

    def _step(self):
        """One turn of the state machine, under the top-level guard.

        Nothing outside this module restarts the thread, by design, so the
        thread body cannot be allowed to terminate short of the shutdown event:
        every state handler re-enters the machine as a dial failure.
        """
        handlers = {
            STATE_IDLE: self._state_idle,
            STATE_DIALLING: self._state_dialling,
            STATE_CONNECTED: self._state_connected,
            STATE_BACKOFF: self._state_backoff,
            STATE_CIRCUIT_OPEN: self._state_circuit_open,
            STATE_HALF_OPEN: self._state_half_open,
            STATE_DISABLED_SLOW: self._state_disabled_slow,
        }
        try:
            handlers[self._state]()
        except BaseException as error:
            self.logger.warning(
                f"[SWOOP-DOORBELL] {self._state} raised "
                f"{type(error).__name__}; counted as a dial failure")
            self._count_failure()
            self._state = STATE_BACKOFF

    # states

    def _state_idle(self):
        if not self._online():
            self._wait(OFFLINE_RECHECK_SECONDS)
            return
        # An offline->online edge is a genuinely new network situation (DHCP, a
        # VPN, a changed uplink) and is the likeliest thing to have fixed a long
        # doorbell outage on one machine, so the ladder starts over.
        self._failures = 0
        self._exponent = 0
        self._state = STATE_DIALLING

    def _state_dialling(self):
        outcome = self._attempt()
        if outcome == _OK:
            self._state = STATE_CONNECTED
        elif outcome == _DISABLED:
            self._state = STATE_DISABLED_SLOW
        elif outcome == _AUTH and self._spend_auth_credit():
            pass  # re-mint and dial again with no wait
        else:
            self._count_failure()
            self._state = STATE_BACKOFF

    def _state_connected(self):
        outcome = self._wait(self._next_deadline())
        if outcome == 'shutdown':
            return
        if self._socket_closed.is_set():
            self._on_socket_drop()
            return
        if outcome == 'wake':
            self.logger.info("[SWOOP-DOORBELL] refresh requested; socket already warm")
        now = self._monotonic()
        if not self._stable and now - self._connected_at >= STABLE_CONNECTION_SECONDS:
            self._stable = True
            self._failures = 0
            self._exponent = 0
        self._service_token(now)

    def _state_backoff(self):
        # Full jitter, deliberately not ConnectionManager's 50-100 %
        # (connection_manager.py:649-650). Firestore failures are uncorrelated
        # across machines, so half-width jitter is enough there. Doorbell
        # failures are perfectly correlated -- one origin, one Worker, one
        # moment -- so the re-dials must spread over the whole window or the
        # fleet arrives in the top half of it together.
        window = backoff_window(self._exponent)
        wait = self._rng.uniform(0.0, window)
        self.logger.info(
            f"[SWOOP-DOORBELL] backoff {wait:.1f}s of {window:.0f}s "
            f"(failures={self._failures})")
        outcome = self._wait(wait)
        if outcome == 'shutdown':
            return
        if outcome == 'wake':
            # An operator action is evidence the policy changed, not that the
            # origin recovered, so the failure count survives it.
            self._state = STATE_DIALLING
            return
        if not self._online():
            self._state = STATE_IDLE
            return
        if self._failures >= FAILURE_THRESHOLD:
            self.logger.warning(
                f"[SWOOP-DOORBELL] circuit open after {self._failures} failures")
            self._state = STATE_CIRCUIT_OPEN
            return
        self._state = STATE_DIALLING

    def _state_circuit_open(self):
        wait = self._rng.uniform(CIRCUIT_PROBE_SECONDS / 2.0, CIRCUIT_PROBE_SECONDS)
        outcome = self._wait(wait)
        if outcome == 'shutdown':
            return
        if outcome != 'wake' and not self._online():
            self._state = STATE_IDLE
            return
        self._state = STATE_HALF_OPEN

    def _state_half_open(self):
        outcome = self._attempt()
        if outcome == _OK:
            self._failures = 0
            self._exponent = 0
            self._state = STATE_CONNECTED
        elif outcome == _DISABLED:
            # The server answered, so the origin is up: the circuit closes.
            self._state = STATE_DISABLED_SLOW
        else:
            # Exactly one dial per probe window. A half-open state that retries
            # is just a slower ladder.
            self._state = STATE_CIRCUIT_OPEN

    def _state_disabled_slow(self):
        wait = self._rng.uniform(DISABLED_RETRY_SECONDS / 2.0, DISABLED_RETRY_SECONDS)
        outcome = self._wait(wait)
        if outcome == 'shutdown':
            return
        if not self._online():
            self._state = STATE_IDLE
            return
        # A 403 is a healthy server answering, so nothing here ever moved the
        # counters; reset anyway so a disabled period cannot strand a machine
        # one failure from the circuit.
        self._failures = 0
        self._exponent = 0
        self._state = STATE_DIALLING

    # dial + mint

    def _attempt(self):
        """Mint if needed, then dial exactly once."""
        if self._token is None or self._token_expired():
            outcome = self._mint()
            if outcome != _OK:
                return outcome
        return self._dial()

    def _mint(self):
        """POST the doorbell-token route. Returns _OK / _DISABLED / _FAILED."""
        try:
            agent_token = self._get_agent_token()
        except Exception as error:
            self.logger.warning(
                f"[SWOOP-DOORBELL] agent token unavailable ({type(error).__name__})")
            return _FAILED
        if not agent_token:
            return _FAILED

        url = shared_utils.get_api_base_url() + DOORBELL_TOKEN_PATH
        try:
            response = self._http_post(
                url,
                json={},  # site and machine come from the agent token's claims
                headers={'Authorization': f'Bearer {agent_token}'},
                timeout=MINT_TIMEOUT_SECONDS,
            )
        except Exception as error:
            self.logger.warning(f"[SWOOP-DOORBELL] mint failed ({type(error).__name__})")
            return _FAILED

        status = getattr(response, 'status_code', 0)
        if status == 403:
            self._forget_token()
            self._log_once('mint-403', "[SWOOP-DOORBELL] swoop disabled here; slow retry")
            return _DISABLED
        if 400 <= status < 500:
            # A 401 here means the AGENT's own Firebase token is bad, and
            # auth_manager.get_valid_token already owns that ladder. A second
            # ladder would double the pressure and tell nobody anything.
            self._forget_token()
            self._log_once(
                f'mint-{status}',
                f"[SWOOP-DOORBELL] mint refused (status={status}); slow retry")
            return _DISABLED
        if status != 200:
            self.logger.warning(f"[SWOOP-DOORBELL] mint failed (status={status})")
            return _FAILED

        try:
            payload = response.json()
        except Exception as error:
            self.logger.warning(
                f"[SWOOP-DOORBELL] mint response unreadable ({type(error).__name__})")
            return _FAILED
        return self._store_token(payload)

    def _store_token(self, payload):
        if not isinstance(payload, dict):
            return _FAILED
        token = payload.get('token')
        expires_in = payload.get('expiresIn')
        signal_url = payload.get('signalUrl')
        if not isinstance(token, str) or not token:
            self.logger.warning("[SWOOP-DOORBELL] mint response carried no token")
            return _FAILED
        if not isinstance(expires_in, (int, float)) or expires_in <= 0:
            self.logger.warning("[SWOOP-DOORBELL] mint response carried no expiresIn")
            return _FAILED
        if not isinstance(signal_url, str) or not signal_url.startswith('wss://'):
            self.logger.warning("[SWOOP-DOORBELL] mint response carried no signalUrl")
            return _FAILED

        now = self._monotonic()
        margin = self._rng.uniform(
            TOKEN_REFRESH_MARGIN_MIN_SECONDS, TOKEN_REFRESH_MARGIN_MAX_SECONDS)
        self._token = token
        self._signal_url = signal_url
        self._token_refresh_at = now + max(0.0, expires_in - margin)
        self._token_hard_at = now + max(0.0, expires_in - TOKEN_HARD_DEADLINE_SECONDS)
        self._mint_retry_at = None
        self._mint_failures = 0
        # kid and expiresIn are the only mint fields that may be logged.
        self.logger.info(
            f"[SWOOP-DOORBELL] token minted (kid={payload.get('kid')}, "
            f"expiresIn={int(expires_in)}s)")
        return _OK

    def _dial(self):
        """One dial. Returns _OK / _DISABLED / _AUTH / _FAILED."""
        self._socket_open.clear()
        self._socket_closed.clear()
        self._dial_settled.clear()
        self._close_reason = None
        try:
            app = self._socket_factory(
                self._signal_url, self._token, self._handle_open,
                self._handle_message, self._handle_close, self._handle_error)
        except Exception as error:
            self.logger.warning(f"[SWOOP-DOORBELL] dial failed ({type(error).__name__})")
            return _FAILED

        self._app = app
        self._socket_thread = threading.Thread(
            target=self._pump, args=(app,), name='swoop-doorbell-socket', daemon=True)
        self._socket_thread.start()

        if not self._dial_settled.wait(DIAL_TIMEOUT_SECONDS):
            self._close_socket('dial_timeout')
            self._join_socket()
            self.logger.warning("[SWOOP-DOORBELL] dial timed out")
            return _FAILED
        if self._socket_open.is_set():
            self._connected_at = self._monotonic()
            self._stable = False
            self._logged_once.clear()
            self.logger.info("[SWOOP-DOORBELL] connected")
            return _OK

        self._join_socket()
        reason = self._close_reason
        self.logger.warning(f"[SWOOP-DOORBELL] dial refused (reason={reason})")
        if reason == 'auth':
            self._forget_token()
            return _AUTH
        if reason == 'disabled':
            self._forget_token()
            return _DISABLED
        return _FAILED

    def _pump(self, app):
        """Run the socket. Returns only when it is finished, either way."""
        try:
            app.run_forever(
                ping_interval=PING_INTERVAL_SECONDS,
                ping_timeout=PING_TIMEOUT_SECONDS,
            )
        except BaseException as error:
            if self._close_reason is None:
                self._close_reason = 'drop'
            self.logger.warning(f"[SWOOP-DOORBELL] socket ended ({type(error).__name__})")
        finally:
            if self._close_reason is None:
                self._close_reason = 'drop'
            self._socket_closed.set()
            self._dial_settled.set()

    # socket callbacks -- these run on the socket thread

    def _handle_open(self, _app):
        self._socket_open.set()
        self._dial_settled.set()

    def _handle_message(self, app, raw):
        if self._close_reason == VERSION_MISMATCH_REASON:
            # our own `bye` earns `wrong_role` from the room (section 2 gives a
            # doorbell no send rights for one), and that answer must not land on
            # the reject counter that exists to reveal a misbehaving server.
            return
        if isinstance(raw, (bytes, bytearray)):
            self._reject('binary')
            return
        if len(raw) > MAX_MESSAGE_BYTES:
            # An over-cap frame is a protocol violation, not a bad ring.
            self._reject('too_large')
            self._close_reason = 'protocol'
            self._close_socket('message_too_large')
            return
        try:
            message = json.loads(raw)
        except ValueError:
            self._reject('not_json')
            return
        if not isinstance(message, dict):
            self._reject('not_object')
            return

        kind = message.get('type')
        if kind == 'hello':
            self._check_hello(app, message)
            return
        if kind == 'error':
            if message.get('code') in AUTH_ERROR_CODES:
                self._close_reason = 'auth'
                self._close_socket('auth')
            else:
                self._reject('server_error')
            return
        if kind != 'ring':
            self._reject('unknown_type')
            return
        if not RING_FIELDS.issuperset(message):
            self._reject('unexpected_field')
            return
        sid = message.get('sid')
        if not isinstance(sid, str) or not sid:
            self._reject('bad_sid')
            return
        self._enqueue_ring(sid)

    def _check_hello(self, app, message):
        """Section 1's version gate. `hello` is the room's first frame to every
        socket, so this runs once per connection and is not a rejection.

        A mismatch is a `bye`, a close and a sentence for the operator -- never
        a negotiation, never a downgrade, never "proceed anyway". Section 2
        gives a doorbell no send rights for a `bye`, but section 1 requires it
        of every client, so it is sent and the room's refusal is ignored.
        """
        version = message.get('protocolVersion')
        # the type before the value: `True == 1` in python, and a bool is not a
        # protocol version.
        if type(version) is int and version == SWOOP_PROTOCOL_VERSION:
            return
        # the room's integer is server-controlled text and this module logs
        # enums and class names only, so the log carries ours, not theirs.
        self.logger.warning(
            f"[SWOOP-DOORBELL] the signalling room does not speak protocol "
            f"{SWOOP_PROTOCOL_VERSION}; {VERSION_MISMATCH_MESSAGE}")
        self._close_reason = VERSION_MISMATCH_REASON
        try:
            app.send(json.dumps(
                {'type': 'bye', 'reason': VERSION_MISMATCH_REASON}))
        except Exception as error:
            # the close below is what the room acts on either way.
            self.logger.debug(
                f"[SWOOP-DOORBELL] bye not sent ({type(error).__name__})")
        self._close_socket(VERSION_MISMATCH_REASON)

    def _handle_close(self, _app, status_code, _reason):
        if status_code == AUTH_CLOSE_CODE:
            self._close_reason = 'auth'
        elif self._close_reason is None:
            self._close_reason = 'drop'

    def _handle_error(self, _app, error):
        # The class name and a status, never the text: a handshake refusal's
        # message can carry the request line.
        status = getattr(error, 'status_code', None)
        if status == 401:
            self._close_reason = 'auth'
        elif status == 403:
            self._close_reason = 'disabled'
        elif self._close_reason is None:
            self._close_reason = 'drop'
        self.logger.warning(
            f"[SWOOP-DOORBELL] socket error ({type(error).__name__}, status={status})")

    # rings

    def _enqueue_ring(self, sid):
        with self._rings_cv:
            if len(self._rings) >= RING_QUEUE_MAX:
                self._rings.popleft()
                self._dropped_rings += 1
                self.logger.warning(
                    f"[SWOOP-DOORBELL] ring queue full; dropped the oldest sid "
                    f"(total={self._dropped_rings})")
            self._rings.append(sid)
            self._rings_cv.notify()

    def _ring_worker(self):
        """Single-flight delivery, off the socket thread: ensure_streamer spawns
        a process and fetches a bundle, which must never stall the pings."""
        while not self._shutdown.is_set():
            sid = None
            with self._rings_cv:
                if not self._rings:
                    self._rings_cv.wait(_WAIT_SLICE_SECONDS)
                if self._rings:
                    sid = self._rings.popleft()
            if sid is None:
                continue
            try:
                self._on_ring(sid)
            except Exception as error:
                self.logger.warning(
                    f"[SWOOP-DOORBELL] on_ring raised {type(error).__name__}")

    def _reject(self, reason):
        self._rejects += 1
        self.logger.warning(
            f"[SWOOP-DOORBELL] rejected frame (reason={reason}, total={self._rejects})")

    # token lifecycle while connected

    def _service_token(self, now):
        if self._token_refresh_at is None or now < self._token_refresh_at:
            return
        if self._mint_retry_at is None or now >= self._mint_retry_at:
            # Mint first, close second: never tear down a working socket to go
            # looking for a token.
            outcome = self._mint()
            if outcome == _OK:
                self._close_socket('token_refresh')
                self._join_socket()
                self._state = STATE_DIALLING
                return
            if outcome == _DISABLED:
                self._close_socket('swoop_disabled')
                self._join_socket()
                self._state = STATE_DISABLED_SLOW
                return
            self._mint_failures += 1
            self._mint_retry_at = now + self._rng.uniform(
                0.0, backoff_window(self._mint_failures))
        if self._token_hard_at is not None and now >= self._token_hard_at:
            self.logger.warning(
                "[SWOOP-DOORBELL] no replacement token before expiry; closing")
            self._close_socket('token_expired')
            self._join_socket()
            self._count_failure()
            self._state = STATE_BACKOFF

    def _on_socket_drop(self):
        uptime = self._monotonic() - (self._connected_at or self._monotonic())
        reason = self._close_reason
        self._join_socket()
        if reason == 'auth':
            self._forget_token()
            if self._spend_auth_credit():
                self._state = STATE_DIALLING
                return
            self._count_failure()
        elif reason == 'disabled':
            self._forget_token()
            self._state = STATE_DISABLED_SLOW
            return
        elif reason == VERSION_MISMATCH_REASON:
            # neither a failure of the origin nor anything a ladder can fix, so
            # it takes the same slow retry a disabled site does: the socket is
            # only worth trying again once this machine is upgraded or the
            # worker is rolled back, and the token is still good.
            self._state = STATE_DISABLED_SLOW
            return
        elif reason == 'protocol' or uptime < STABLE_CONNECTION_SECONDS:
            self._count_failure()
        else:
            # A socket that stayed up long enough to answer two keepalives has
            # demonstrably passed the whole path; its loss starts the ladder over.
            self._failures = 0
            self._exponent = 0
        self._state = STATE_BACKOFF

    def _token_expired(self):
        return (self._token_hard_at is not None
                and self._monotonic() >= self._token_hard_at)

    def _forget_token(self):
        self._token = None
        self._token_refresh_at = None
        self._token_hard_at = None
        self._mint_retry_at = None

    def _spend_auth_credit(self):
        """One free re-mint-and-re-dial per AUTH_RETRY_COOLDOWN_SECONDS."""
        now = self._monotonic()
        if now < self._auth_retry_at:
            return False
        self._auth_retry_at = now + AUTH_RETRY_COOLDOWN_SECONDS
        self.logger.info("[SWOOP-DOORBELL] token rejected; re-minting once")
        return True

    # plumbing

    def _next_deadline(self):
        """Seconds until the next thing CONNECTED has to do."""
        now = self._monotonic()
        candidates = []
        if not self._stable and self._connected_at is not None:
            candidates.append(self._connected_at + STABLE_CONNECTION_SECONDS)
        if self._token_refresh_at is not None:
            candidates.append(max(self._token_refresh_at, self._mint_retry_at or 0.0))
        if self._token_hard_at is not None:
            candidates.append(self._token_hard_at)
        pending = [at - now for at in candidates if at > now]
        if not pending:
            return 0.0 if candidates else PING_INTERVAL_SECONDS
        return min(pending)

    def _count_failure(self):
        self._failures += 1
        self._exponent += 1

    def _online(self):
        try:
            return bool(self._is_online())
        except Exception as error:
            # A broken gate must not silence the doorbell for good.
            self.logger.debug(
                f"[SWOOP-DOORBELL] connection gate raised {type(error).__name__}")
            return True

    def _log_once(self, key, message):
        """Log once per episode; the set clears on the next successful dial."""
        if key in self._logged_once:
            return
        self._logged_once.add(key)
        self.logger.warning(message)

    def _wait(self, seconds):
        """Every wait in the machine. 'shutdown' | 'wake' | 'elapsed'."""
        self._wait_fn(seconds)
        if self._shutdown.is_set():
            return 'shutdown'
        if self._wake.is_set():
            self._wake.clear()
            return 'wake'
        return 'elapsed'

    def _default_wait(self, timeout):
        """Wait up to `timeout`, returning early on shutdown, a refresh or a
        socket close.

        Sliced, because the shutdown event belongs to the service
        (graceful_shutdown sets it) and cannot be waited on together with the
        internal events without another thread. A quarter-second slice puts the
        exit latency two orders below the 20 s stop grace.
        """
        deadline = self._monotonic() + max(0.0, timeout)
        while True:
            if (self._shutdown.is_set() or self._wake.is_set()
                    or self._socket_closed.is_set()):
                return
            remaining = deadline - self._monotonic()
            if remaining <= 0:
                return
            self._wake.wait(min(_WAIT_SLICE_SECONDS, remaining))

    def _close_socket(self, reason):
        """Close the socket if one is open.

        No `bye` frame: PROTOCOL.md section 2 admits `bye` from a viewer or a
        host only, and a doorbell sending one earns `wrong_role`. The close
        frame is what tells the room the peer is gone. Section 1's version
        mismatch is the one exception, and _check_hello sends that one itself.
        """
        app = self._app
        if app is None:
            return
        self.logger.info(f"[SWOOP-DOORBELL] closing socket (reason={reason})")
        try:
            app.close()
        except Exception as error:
            self.logger.debug(
                f"[SWOOP-DOORBELL] close raised {type(error).__name__}")

    def _join_socket(self):
        thread = self._socket_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=STOP_JOIN_TIMEOUT_SECONDS)
        self._socket_thread = None
        self._app = None
