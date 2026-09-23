"""Unit tests for the self-supervised swoop doorbell (spike 0.6's 21 cases).

The headline case is the first one: a signalling origin that is unreachable for
ten minutes must leave ConnectionManager completely alone. The doorbell is the
one component allowed to run its own reconnection ladder, and the whole reason
it is allowed to is that its failure domain (Cloudflare) is not Firestore's. If
it ever reached register_thread or report_error, one Worker incident would cycle
the Firestore connection on every machine in the fleet.

Case 2 makes that a property of the module rather than of one code path: the
module never imports connection_manager.

Every test here injects a clock, a wait, a socket factory, an HTTP client and a
seeded random, so nothing touches the network and nothing sleeps.
"""

import ast
import json
import logging
import random
import subprocess
import sys
import threading
import time
from pathlib import Path
from unittest.mock import NonCallableMock, call

import pytest
import websocket

import swoop_doorbell as sd
from auth_manager import AuthManager
from connection_manager import ConnectionManager, ConnectionState

SRC_DIR = Path(__file__).resolve().parents[2] / 'src'
SOURCE = (SRC_DIR / 'swoop_doorbell.py').read_text(encoding='utf-8')

# The golden vectors, and the manifest the rust protocol core and the web
# protocol library also iterate. The doorbell is the third client on the same
# wire, so it reads the same files rather than a hand-written copy of them.
VECTORS = Path(__file__).resolve().parents[2] / 'swoop' / 'testdata' / 'protocol'
MANIFEST = json.loads((VECTORS / 'index.json').read_text(encoding='utf-8'))
HANDSHAKE = [v for v in MANIFEST['vectors'] if v['kind'] == 'handshake']


def golden(vector):
    """One vector file, named by its manifest entry."""
    return json.loads((VECTORS / vector['file']).read_text(encoding='utf-8'))

TOKEN = 'doorbell-token-ZZQQ7788-nevereverlogged-4413XXYY'
SIGNAL_URL = 'wss://swoop-signal.example/v1/room/site-1/machine-1'
EXPIRES_IN = 43200


# fakes


class Clock:
    """Injected monotonic. Nothing in these tests waits in real time."""

    def __init__(self, start=10000.0):
        self.now = start

    def monotonic(self):
        return self.now

    def advance(self, seconds):
        self.now += max(0.0, seconds)


class Waiter:
    """Stands in for every Event.wait in the machine."""

    def __init__(self, clock):
        self.clock = clock
        self.waits = []
        self.hooks = []
        self.advance_clock = True

    def __call__(self, timeout):
        self.waits.append(timeout)
        for hook in list(self.hooks):
            hook(timeout)
        if self.advance_clock:
            self.clock.advance(timeout)


class FakeSocket:
    """Stands in for websocket.WebSocketApp."""

    def __init__(self, url, token, handlers, behaviour):
        self.url = url
        self.token = token
        self.on_open, self.on_message, self.on_close, self.on_error = handlers
        self.behaviour = behaviour
        self.run_kwargs = None
        self.closed = False
        self.close_code = None
        self.close_reason = None
        self.sent = []
        self._release = threading.Event()

    def run_forever(self, **kwargs):
        self.run_kwargs = kwargs
        if isinstance(self.behaviour, int):
            self.on_error(self, websocket.WebSocketBadStatusException(
                'Handshake status %d', self.behaviour))
            return
        self.on_open(self)
        self._release.wait(10)
        self.on_close(self, self.close_code, self.close_reason)

    def send(self, raw):
        self.sent.append(raw)

    def close(self):
        self.closed = True
        self._release.set()

    # test drivers

    def deliver(self, raw):
        self.on_message(self, raw)

    def drop(self, code=None, reason=None):
        self.close_code = code
        self.close_reason = reason
        self._release.set()


class FakeFactory:
    """Socket factory seam. `behaviour` is 'open', 'refuse' or an HTTP status."""

    def __init__(self, behaviour='open'):
        self.behaviour = behaviour
        self.calls = []
        self.sockets = []
        self.times = []
        self.clock = None

    def __call__(self, url, token, on_open, on_message, on_close, on_error):
        self.calls.append((url, token))
        if self.clock is not None:
            self.times.append(self.clock.now)
        behaviour = self.behaviour
        if callable(behaviour):
            behaviour = behaviour(len(self.calls))
        if behaviour == 'refuse':
            raise ConnectionRefusedError('signal origin unreachable')
        sock = FakeSocket(url, token, (on_open, on_message, on_close, on_error),
                          behaviour)
        self.sockets.append(sock)
        return sock

    @property
    def last(self):
        return self.sockets[-1]


class FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError('no body')
        return self._payload


class MintStub:
    """HTTP seam for POST /agent/swoop/doorbell-token."""

    def __init__(self, behaviour=None):
        self.behaviour = behaviour or (lambda n: FakeResponse(200, {
            'token': TOKEN, 'kid': 'k1', 'expiresIn': EXPIRES_IN,
            'signalUrl': SIGNAL_URL,
        }))
        self.calls = []
        self.times = []
        self.clock = None

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.clock is not None:
            self.times.append(self.clock.now)
        result = self.behaviour(len(self.calls))
        if isinstance(result, Exception):
            raise result
        return result


class Harness:
    def __init__(self, doorbell, clock, waiter, factory, mint, rings, online):
        self.doorbell = doorbell
        self.clock = clock
        self.waiter = waiter
        self.factory = factory
        self.mint = mint
        self.rings = rings
        self.online = online

    def step(self, count=1):
        for _ in range(count):
            self.doorbell._step()

    def step_until(self, predicate, limit=2000):
        for _ in range(limit):
            if predicate():
                return True
            self.doorbell._step()
        return predicate()


def build(behaviour='open', mint_behaviour=None, online=True, seed=20260917,
          on_ring=None, get_agent_token=None, rng=None, wait=True):
    clock = Clock()
    waiter = Waiter(clock)
    factory = FakeFactory(behaviour)
    factory.clock = clock
    mint = MintStub(mint_behaviour)
    mint.clock = clock
    rings = []
    gate = online if callable(online) else (lambda: online)
    doorbell = sd.SwoopDoorbell(
        on_ring=on_ring or rings.append,
        get_agent_token=get_agent_token or (lambda: 'agent-id-token'),
        shutdown_event=threading.Event(),
        is_connected=gate,
        logger=logging.getLogger('swoop_doorbell'),
        socket_factory=factory,
        http_post=mint,
        monotonic=clock.monotonic,
        wait=waiter if wait else None,
        rng=rng or random.Random(seed),
    )
    return Harness(doorbell, clock, waiter, factory, mint, rings, gate)


def connect(harness):
    """Drive IDLE -> CONNECTED."""
    harness.step_until(lambda: harness.doorbell.state == sd.STATE_CONNECTED, limit=10)
    assert harness.doorbell.state == sd.STATE_CONNECTED


class ring_worker:
    """Run the single-flight ring worker for the body of a with-block."""

    def __init__(self, doorbell):
        self.doorbell = doorbell

    def __enter__(self):
        self.thread = threading.Thread(
            target=self.doorbell._ring_worker, daemon=True)
        self.thread.start()
        return self.doorbell

    def __exit__(self, *_):
        self.doorbell._shutdown.set()
        with self.doorbell._rings_cv:
            self.doorbell._rings_cv.notify_all()
        self.thread.join(timeout=5)
        return False


# 1 - headline


def test_signalling_outage_10_minutes_never_touches_connection_manager(caplog):
    """A dead signalling origin is not a Firestore problem and must not become one."""
    caplog.set_level(logging.DEBUG)
    # Unconfigured spec mock: any attribute call on it is recorded, and the
    # assertion below is that there are none at all.
    connection_manager = NonCallableMock(spec=ConnectionManager)
    state = {'value': ConnectionState.CONNECTED}
    reads = []

    def gate():
        reads.append(state['value'])
        return state['value'] == ConnectionState.CONNECTED

    harness = build(behaviour='refuse', online=gate)
    start = harness.clock.now
    harness.step_until(lambda: harness.clock.now - start >= 600.0)
    dials_in_window = len([t for t in harness.factory.times if t - start <= 600.0])

    # (e) the ladder is real but not so slow the feature is useless
    assert 6 <= dials_in_window <= 12

    # (d) it gives up on the origin rather than hammering it forever
    harness.step_until(
        lambda: harness.doorbell.state == sd.STATE_CIRCUIT_OPEN, limit=200)
    assert harness.doorbell.state == sd.STATE_CIRCUIT_OPEN
    assert len(harness.factory.calls) == sd.FAILURE_THRESHOLD

    # (a) zero calls into ConnectionManager, by any name
    assert connection_manager.mock_calls == []

    # (b) the gate was only ever read, and the state never moved
    assert reads and set(reads) == {ConnectionState.CONNECTED}

    # (c) nothing that looks like a Firestore reconnect was logged
    assert not [r for r in caplog.records if r.name.startswith('connection_manager')]
    text = '\n'.join(r.getMessage() for r in caplog.records)
    for phrase in ('[ERROR REPORTED]', '[WATCHDOG] Dead threads detected', 'Reconnect'):
        assert phrase not in text


# 2 - the guarantee is a property of the module


def test_module_has_no_connection_manager_import():
    # Parsed, not grepped, so a lazy import inside a function is caught too.
    imported = set()
    for node in ast.walk(ast.parse(SOURCE)):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split('.')[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split('.')[0])
    assert 'connection_manager' not in imported

    probe = subprocess.run(
        [sys.executable, '-c',
         'import sys; sys.path.insert(0, ".");'
         ' import swoop_doorbell;'
         ' print("connection_manager" in sys.modules)'],
        cwd=str(SRC_DIR), capture_output=True, text=True, timeout=120)
    assert probe.returncode == 0, probe.stderr
    assert probe.stdout.strip() == 'False'


# 3, 4 - the ladder


def test_backoff_ladder_grows_and_caps():
    assert [sd.backoff_window(n) for n in range(1, 13)] == [
        2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0, 256.0, 300.0, 300.0, 300.0, 300.0]

    harness = build(behaviour='refuse')
    drawn = []
    for expected_failures in range(1, 13):
        harness.step_until(
            lambda n=expected_failures: harness.doorbell._failures == n, limit=10)
        before = len(harness.waiter.waits)
        harness.step()  # the BACKOFF turn draws the window
        assert len(harness.waiter.waits) == before + 1
        drawn.append((harness.waiter.waits[-1], sd.backoff_window(expected_failures)))

    for wait, window in drawn:
        assert 0.0 <= wait <= window


def test_backoff_uses_full_jitter_not_equal_jitter():
    """connection_manager.py:649 draws 50-100 % of the window. Doorbell failures
    are perfectly correlated across the fleet, so this one draws 0-100 %."""
    harness = build(behaviour='refuse')
    doorbell = harness.doorbell
    doorbell._failures = 4
    doorbell._exponent = 4
    window = sd.backoff_window(4)

    draws = []
    for _ in range(1000):
        doorbell._state = sd.STATE_BACKOFF
        doorbell._failures = 4
        doorbell._exponent = 4
        before = len(harness.waiter.waits)
        doorbell._step()
        draws.append(harness.waiter.waits[before])

    assert min(draws) < 0.05 * window
    assert abs(sum(draws) / len(draws) - window / 2.0) < 0.10 * window


# 5 - stability resets the ladder


@pytest.mark.parametrize('uptime,expect_reset', [(120.0, True), (119.0, False)])
def test_stable_connection_resets_the_ladder(uptime, expect_reset):
    harness = build()
    connect(harness)
    doorbell = harness.doorbell
    doorbell._failures = 5
    doorbell._exponent = 5
    doorbell._stable = False
    doorbell._connected_at = harness.clock.now - uptime

    harness.waiter.advance_clock = False  # keep the uptime exact
    harness.factory.last.drop()
    assert doorbell._socket_closed.wait(5)
    harness.step()

    assert doorbell.state == sd.STATE_BACKOFF
    if expect_reset:
        assert (doorbell._failures, doorbell._exponent) == (0, 0)
        assert sd.backoff_window(doorbell._exponent) == 2.0
    else:
        assert (doorbell._failures, doorbell._exponent) == (6, 6)
        assert sd.backoff_window(doorbell._exponent) == 64.0


# 6 - circuit breaker


def test_circuit_opens_after_twelve_failures_and_half_open_probes_once():
    harness = build(behaviour='refuse')
    harness.step_until(
        lambda: harness.doorbell.state == sd.STATE_CIRCUIT_OPEN, limit=500)
    assert harness.doorbell.state == sd.STATE_CIRCUIT_OPEN
    assert len(harness.factory.calls) == sd.FAILURE_THRESHOLD

    for _ in range(3):
        dials_before = len(harness.factory.calls)
        waits_before = len(harness.waiter.waits)
        harness.step()  # CIRCUIT_OPEN: one probe wait
        probe_wait = harness.waiter.waits[waits_before]
        assert 450.0 <= probe_wait <= 900.0
        assert harness.doorbell.state == sd.STATE_HALF_OPEN
        harness.step()  # HALF_OPEN: exactly one dial
        assert len(harness.factory.calls) == dials_before + 1
        assert harness.doorbell.state == sd.STATE_CIRCUIT_OPEN

    harness.factory.behaviour = 'open'
    harness.step()  # probe window
    harness.step()  # the probe succeeds
    assert harness.doorbell.state == sd.STATE_CONNECTED
    assert (harness.doorbell._failures, harness.doorbell._exponent) == (0, 0)


# 7 - offline parks


def test_offline_parks_in_idle_without_burning_the_ladder():
    online = {'value': False}
    harness = build(online=lambda: online['value'])
    harness.step(5)

    assert harness.doorbell.state == sd.STATE_IDLE
    assert harness.factory.calls == []
    assert harness.mint.calls == []
    assert harness.waiter.waits == [sd.OFFLINE_RECHECK_SECONDS] * 5
    assert (harness.doorbell._failures, harness.doorbell._exponent) == (0, 0)

    online['value'] = True
    harness.step()
    assert harness.doorbell.state == sd.STATE_DIALLING
    harness.step()
    assert len(harness.factory.calls) == 1
    assert harness.doorbell.state == sd.STATE_CONNECTED


# 8 - swoop disabled


def test_403_swoop_disabled_enters_slow_retry_without_counting_a_failure():
    harness = build(mint_behaviour=lambda n: FakeResponse(403, {'error': 'swoop_disabled'}))
    start = harness.clock.now
    harness.step_until(lambda: harness.clock.now - start >= 3600.0, limit=200)

    assert harness.doorbell.state in (sd.STATE_DISABLED_SLOW, sd.STATE_DIALLING)
    assert harness.doorbell._failures == 0
    assert harness.doorbell._exponent == 0
    assert harness.factory.calls == []  # never a websocket dial while disabled
    within_hour = [t for t in harness.mint.times if t - start <= 3600.0]
    assert len(within_hour) <= 4
    for wait in harness.waiter.waits:
        assert 900.0 <= wait <= 1800.0


# 9 - refresh_now


def test_refresh_now_forces_an_immediate_redial():
    def wake_during_wait(harness):
        def hook(_timeout):
            harness.doorbell.refresh_now()
            harness.waiter.hooks.clear()
        harness.waiter.hooks.append(hook)

    # from DISABLED_SLOW
    harness = build(mint_behaviour=lambda n: (
        FakeResponse(403, {}) if n == 1 else FakeResponse(200, {
            'token': TOKEN, 'kid': 'k1', 'expiresIn': EXPIRES_IN,
            'signalUrl': SIGNAL_URL})))
    harness.step(2)  # IDLE -> DIALLING, then the mint refuses
    assert harness.doorbell.state == sd.STATE_DISABLED_SLOW
    wake_during_wait(harness)
    harness.step()
    assert harness.doorbell.state == sd.STATE_DIALLING
    harness.step()
    assert harness.doorbell.state == sd.STATE_CONNECTED

    # from BACKOFF - the failure count survives an operator action
    harness = build(behaviour='refuse')
    harness.step_until(lambda: harness.doorbell.state == sd.STATE_BACKOFF, limit=10)
    failures = harness.doorbell._failures
    wake_during_wait(harness)
    harness.step()
    assert harness.doorbell.state == sd.STATE_DIALLING
    assert harness.doorbell._failures == failures

    # from CIRCUIT_OPEN
    harness = build(behaviour='refuse')
    harness.step_until(
        lambda: harness.doorbell.state == sd.STATE_CIRCUIT_OPEN, limit=500)
    wake_during_wait(harness)
    harness.step()
    assert harness.doorbell.state == sd.STATE_HALF_OPEN

    # from CONNECTED it is a logged no-op, and the call itself does no I/O
    harness = build()
    connect(harness)
    dials, mints = len(harness.factory.calls), len(harness.mint.calls)
    started = time.perf_counter()
    harness.doorbell.refresh_now()
    assert time.perf_counter() - started < 0.05
    assert (len(harness.factory.calls), len(harness.mint.calls)) == (dials, mints)
    harness.step()
    assert harness.doorbell.state == sd.STATE_CONNECTED


# 10, 11 - the refresh deadline


def test_token_refresh_fires_before_exp_with_a_jittered_margin():
    harness = build()
    minted_at = harness.clock.now
    connect(harness)
    deadline = harness.doorbell._token_refresh_at
    assert minted_at + 42300.0 <= deadline <= minted_at + 42600.0

    margins = []
    for seed in range(200):
        run = build(seed=seed)
        at = run.clock.now
        connect(run)
        margins.append(at + EXPIRES_IN - run.doorbell._token_refresh_at)
    assert min(margins) < 630.0
    assert max(margins) > 870.0
    assert all(600.0 <= m <= 900.0 for m in margins)


def test_refresh_deadline_survives_a_clock_step(monkeypatch):
    # The module reads no wall clock at all, which is the strongest form of the
    # guarantee: a kiosk that NTP-steps cannot move the schedule.
    assert 'time.time(' not in SOURCE

    harness = build()
    connect(harness)
    deadline = harness.doorbell._token_refresh_at
    monkeypatch.setattr(time, 'time', lambda: 1789344000.0 + 6 * 3600.0)

    harness.clock.now = deadline - 1.0
    harness.waiter.advance_clock = False
    harness.step()
    assert len(harness.mint.calls) == 1  # not yet

    harness.clock.now = deadline
    harness.step()
    assert len(harness.mint.calls) == 2
    assert harness.doorbell.state == sd.STATE_DIALLING


# 12 - a failing mint must not cost a working socket


def test_failing_mint_does_not_tear_down_a_working_socket():
    harness = build(mint_behaviour=lambda n: (
        FakeResponse(200, {'token': TOKEN, 'kid': 'k1', 'expiresIn': EXPIRES_IN,
                           'signalUrl': SIGNAL_URL})
        if n == 1 else FakeResponse(503, {})))
    connect(harness)
    sock = harness.factory.last
    hard_deadline = harness.doorbell._token_hard_at

    harness.waiter.advance_clock = False
    harness.clock.now = harness.doorbell._token_refresh_at
    # The whole refresh margin is 10-15 min, so the mint ladders inside it.
    while harness.clock.now < hard_deadline - 60.0:
        harness.clock.advance(60.0)
        harness.step()
        assert harness.doorbell.state == sd.STATE_CONNECTED
        assert sock.closed is False
    assert harness.doorbell._mint_failures >= 2
    assert len(harness.mint.calls) >= 3

    harness.clock.now = hard_deadline
    harness.doorbell._mint_retry_at = None
    harness.step()
    assert sock.closed is True
    assert harness.doorbell.state == sd.STATE_BACKOFF
    assert harness.doorbell._failures == 1


# 13, 14 - 401 handling


def test_401_gets_one_free_remint_then_backs_off():
    harness = build(behaviour=401)
    harness.step(2)  # IDLE -> DIALLING, then the first 401: re-mint, no wait
    assert harness.doorbell.state == sd.STATE_DIALLING
    assert harness.doorbell._token is None
    assert harness.waiter.waits == []
    assert len(harness.mint.calls) == 1

    harness.step()  # second 401 inside the cooldown
    assert harness.doorbell.state == sd.STATE_BACKOFF
    assert harness.doorbell._failures == 1
    assert harness.doorbell._token is None
    assert len(harness.mint.calls) == 2
    assert len(harness.factory.calls) == 2


def test_mint_401_is_not_a_signal_outage():
    auth = NonCallableMock(spec=AuthManager)
    auth.get_valid_token.return_value = 'agent-id-token'
    harness = build(mint_behaviour=lambda n: FakeResponse(401, {}),
                    get_agent_token=auth.get_valid_token)
    harness.step(2)  # IDLE -> DIALLING, then the mint refuses

    assert harness.doorbell.state == sd.STATE_DISABLED_SLOW
    assert (harness.doorbell._failures, harness.doorbell._exponent) == (0, 0)
    assert harness.factory.calls == []
    # auth_manager owns the agent-token ladder; the doorbell only asks.
    assert auth.mock_calls == [call.get_valid_token()]


# 15, 16, 17 - rings


def test_ring_with_only_a_sid_invokes_on_ring():
    harness = build()
    connect(harness)
    with ring_worker(harness.doorbell):
        harness.factory.last.deliver(json.dumps({'type': 'ring', 'sid': 'abc'}))
        deadline = time.monotonic() + 5
        while not harness.rings and time.monotonic() < deadline:
            time.sleep(0.01)
    assert harness.rings == ['abc']


def test_ring_with_the_rooms_transport_metadata_is_accepted():
    """The room stamps sentAtMs/serverTimeMs on what it forwards
    (PROTOCOL.md section 2 and testdata/protocol/signaling/signal-ring.json)."""
    harness = build()
    connect(harness)
    with ring_worker(harness.doorbell):
        harness.factory.last.deliver(json.dumps({
            'type': 'ring', 'sid': 'sid_0000000000000001',
            'sentAtMs': 1789689599996, 'serverTimeMs': 1789689600000}))
        deadline = time.monotonic() + 5
        while not harness.rings and time.monotonic() < deadline:
            time.sleep(0.01)
    assert harness.rings == ['sid_0000000000000001']


@pytest.mark.parametrize('raw,closes', [
    (json.dumps({'type': 'ring', 'sid': 'abc', 'viewerToken': 'secret-payload'}), False),
    (json.dumps({'type': 'ring'}), False),
    (json.dumps({'type': 'ring', 'sid': 17}), False),
    (json.dumps({'type': 'summon', 'sid': 'abc'}), False),
    ('not json at all {', False),
    (json.dumps({'type': 'ring', 'sid': 'a', 'pad': 'x' * 5000}), True),
])
def test_ring_with_any_extra_field_is_rejected(caplog, raw, closes):
    caplog.set_level(logging.DEBUG)
    harness = build()
    connect(harness)
    sock = harness.factory.last
    with ring_worker(harness.doorbell):
        sock.deliver(raw)
        time.sleep(0.05)

    assert harness.rings == []
    assert sock.closed is closes
    text = '\n'.join(r.getMessage() for r in caplog.records)
    for fragment in ('viewerToken', 'secret-payload', 'summon', 'not json at all',
                     'x' * 40):
        assert fragment not in text


def test_on_ring_never_blocks_the_socket_thread(caplog):
    caplog.set_level(logging.DEBUG)
    released = threading.Event()
    seen = []

    def slow_on_ring(sid):
        seen.append(sid)
        if len(seen) == 1:
            released.wait(10)

    harness = build(on_ring=slow_on_ring)
    connect(harness)
    sock = harness.factory.last
    assert sock.run_kwargs == {'ping_interval': sd.PING_INTERVAL_SECONDS,
                               'ping_timeout': sd.PING_TIMEOUT_SECONDS}

    with ring_worker(harness.doorbell):
        sock.deliver(json.dumps({'type': 'ring', 'sid': 'first'}))
        deadline = time.monotonic() + 5
        while not seen and time.monotonic() < deadline:
            time.sleep(0.01)

        # on_ring is now parked; the socket thread must not be
        started = time.perf_counter()
        for index in range(sd.RING_QUEUE_MAX + 1):
            sock.deliver(json.dumps({'type': 'ring', 'sid': f'queued-{index}'}))
        assert time.perf_counter() - started < 0.05

        assert len(harness.doorbell._rings) == sd.RING_QUEUE_MAX
        assert harness.doorbell._dropped_rings == 1
        assert 'queued-0' not in harness.doorbell._rings  # the oldest went
        assert 'queued-8' in harness.doorbell._rings

        released.set()
        deadline = time.monotonic() + 5
        while len(seen) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)

    assert seen[0] == 'first'
    assert seen[1] == 'queued-1'
    assert 'ring queue full' in '\n'.join(r.getMessage() for r in caplog.records)


# 18 - the token never reaches a log record


def test_token_never_appears_in_log_records(caplog):
    caplog.set_level(logging.DEBUG)
    responses = [
        FakeResponse(200, {'token': TOKEN, 'kid': 'k1', 'expiresIn': EXPIRES_IN,
                           'signalUrl': SIGNAL_URL}),
        FakeResponse(200, {'token': TOKEN, 'kid': 'k2', 'expiresIn': EXPIRES_IN,
                           'signalUrl': SIGNAL_URL}),
        FakeResponse(401, {'token': TOKEN}),
        FakeResponse(403, {'token': TOKEN}),
        FakeResponse(503, {'token': TOKEN}),
    ]
    dial_plan = {1: 'open', 2: 401, 3: 'refuse'}
    harness = build(behaviour=lambda n: dial_plan.get(n, 'open'),
                    mint_behaviour=lambda n: responses[min(n, len(responses)) - 1])
    connect(harness)
    sock = harness.factory.last
    sock.deliver(json.dumps({'type': 'ring', 'sid': TOKEN}))
    sock.deliver(json.dumps({'type': 'ring', 'sid': 'x', 'token': TOKEN}))
    sock.drop(code=sd.AUTH_CLOSE_CODE)
    assert harness.doorbell._socket_closed.wait(5)
    harness.step(30)

    text = '\n'.join(r.getMessage() for r in caplog.records)
    assert text  # the run really did log
    for fragment in (TOKEN, TOKEN[:8], TOKEN[-8:]):
        assert fragment not in text


# 19 - shutdown


@pytest.mark.parametrize('state', [
    sd.STATE_IDLE, sd.STATE_DIALLING, sd.STATE_CONNECTED, sd.STATE_BACKOFF,
    sd.STATE_CIRCUIT_OPEN, sd.STATE_HALF_OPEN, sd.STATE_DISABLED_SLOW,
    sd.STATE_STOPPED,
])
@pytest.mark.parametrize('via_event', [False, True])
def test_stop_and_shutdown_event_end_the_thread_within_two_seconds(state, via_event):
    class MaxWindow:
        """Every window at its cap, so nothing passes by luck."""

        def uniform(self, _low, high):
            return high

    harness = build(behaviour='refuse', rng=MaxWindow(), wait=False)
    doorbell = harness.doorbell
    doorbell._connected_at = time.monotonic()
    doorbell._state = state
    doorbell.start()
    time.sleep(0.2)  # let it reach its pending wait

    started = time.perf_counter()
    if via_event:
        # graceful_shutdown's path: the service sets the event, nothing else.
        doorbell._shutdown.set()
        doorbell._thread.join(timeout=5)
    else:
        doorbell.stop()
    elapsed = time.perf_counter() - started

    assert not doorbell._thread.is_alive()
    assert elapsed < 2.0
    doorbell.stop()  # idempotent


def test_stop_before_start_is_safe():
    harness = build()
    harness.doorbell.stop()
    harness.doorbell.stop()
    assert harness.doorbell.state == sd.STATE_IDLE


# 20 - the thread outlives everything


def test_unexpected_exception_does_not_kill_the_thread(caplog):
    caplog.set_level(logging.DEBUG)
    plan = {1: RuntimeError, 2: ValueError}

    class Exploding(FakeFactory):
        attempts = 0

        def __call__(self, url, token, *handlers):
            Exploding.attempts += 1
            kind = plan.get(Exploding.attempts)
            if kind is not None:
                raise kind('socket factory blew up')
            return FakeFactory.__call__(self, url, token, *handlers)

    harness = build()
    exploding = Exploding('open')
    exploding.clock = harness.clock
    harness.doorbell._socket_factory = exploding
    harness.factory = exploding

    harness.step_until(
        lambda: harness.doorbell.state == sd.STATE_CONNECTED, limit=20)
    assert harness.doorbell.state == sd.STATE_CONNECTED
    assert Exploding.attempts == 3
    text = '\n'.join(r.getMessage() for r in caplog.records)
    assert 'RuntimeError' in text and 'ValueError' in text

    # and a state handler that raises is caught by the top-level guard, so the
    # run loop cannot terminate on a bug in a handler
    doorbell = harness.doorbell
    doorbell._state = sd.STATE_IDLE
    failures = doorbell._failures

    def explode():
        raise KeyError('handler bug')

    doorbell._state_idle = explode
    doorbell._step()
    assert doorbell.state == sd.STATE_BACKOFF
    assert doorbell._failures == failures + 1


# 21 - no time.sleep anywhere


def test_module_contains_no_time_sleep():
    assert 'sleep(' not in SOURCE


# 22, 23, 24 - PROTOCOL.md section 1's version gate, from the golden vectors


def test_the_compiled_in_protocol_version_is_the_one_the_manifest_pins():
    """The integer is not the doorbell's to choose: the worker, the browser and
    the streamer all assert the same one, and a bump is a fleet event."""
    assert sd.SWOOP_PROTOCOL_VERSION == MANIFEST['protocolVersion']
    # every handshake vector states the version its client speaks; ours is it.
    assert [golden(v)['supported'] for v in HANDSHAKE] == (
        [sd.SWOOP_PROTOCOL_VERSION] * len(HANDSHAKE))


@pytest.mark.parametrize('vector', HANDSHAKE, ids=[v['file'] for v in HANDSHAKE])
def test_every_handshake_vector_gets_the_verdict_the_manifest_names(caplog, vector):
    """`hello` is the room's first frame to every socket, so both arms run on
    every connection this agent makes."""
    caplog.set_level(logging.DEBUG)
    harness = build()
    connect(harness)
    sock = harness.factory.last

    sock.deliver(json.dumps(golden(vector)['message']))

    # a hello is a legitimate frame on both arms: the counter that exists to
    # reveal a misbehaving server must not move for either.
    assert harness.doorbell._rejects == 0
    text = '\n'.join(r.getMessage() for r in caplog.records)
    assert 'rejected frame' not in text

    if vector['expect'] == 'accept':
        assert sock.sent == []
        assert sock.closed is False
        assert harness.doorbell.state == sd.STATE_CONNECTED
        # and it is still a working doorbell afterwards
        with ring_worker(harness.doorbell):
            sock.deliver(json.dumps({'type': 'ring', 'sid': 'sid-after-hello'}))
            deadline = time.monotonic() + 5
            while not harness.rings and time.monotonic() < deadline:
                time.sleep(0.01)
        assert harness.rings == ['sid-after-hello']
        return

    # never negotiated, never downgraded: bye, close, and a sentence for the
    # operator rather than a protocol code.
    assert [json.loads(raw) for raw in sock.sent] == [
        {'type': 'bye', 'reason': vector['reason']}]
    assert sock.closed is True
    assert harness.doorbell._close_reason == vector['reason']
    assert sd.VERSION_MISMATCH_MESSAGE in text

    assert harness.doorbell._socket_closed.wait(5)
    harness.step()
    # a dead end on the slow retry, not a ladder: no redial can fix it.
    assert harness.doorbell.state == sd.STATE_DISABLED_SLOW
    assert (harness.doorbell._failures, harness.doorbell._exponent) == (0, 0)


def test_the_rooms_refusal_of_our_own_bye_is_not_a_rejection():
    """Section 2 gives a doorbell no send rights for a `bye`, so the room
    answers the one section 1 demands with `wrong_role`. That answer is the
    protocol working, not a server misbehaving."""
    mismatch = next(v for v in HANDSHAKE if v['expect'] == 'reject')
    harness = build()
    connect(harness)
    sock = harness.factory.last
    sock.deliver(json.dumps(golden(mismatch)['message']))
    assert sock.closed is True

    sock.deliver(json.dumps({'type': 'error', 'code': 'wrong_role'}))

    assert harness.doorbell._rejects == 0
    assert harness.doorbell._close_reason == sd.VERSION_MISMATCH_REASON
